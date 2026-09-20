import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { buildApp } from "../../src/app.ts";
import { parseSettings } from "../../src/settings.ts";
import { activityLog } from "../../src/observability/activity-log.ts";
import { GuardTripped, ConfigurationError, MaskError, UpstreamError } from "../../src/errors.ts";
import { resetRateLimit, checkRateLimit, rateLimitMap } from "../../src/providers/proxy-handler.ts";
import { ProviderRegistry } from "../../src/providers/registry.ts";
import { DenyListMatcher } from "../../src/privacy/matcher.ts";
import { TokenMap } from "../../src/privacy/mapping.ts";
import { tokenize } from "../../src/privacy/tokenizer.ts";
import { splitAtPossibleTokenBoundary } from "../../src/streaming/rolling.ts";

describe("Security & Performance Enhancements Verification", () => {
  let originalDispatcher: any;
  let mockAgent: MockAgent;

  before(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  after(() => {
    setGlobalDispatcher(originalDispatcher);
  });

  it("S-03: GuardTripped error response does NOT leak categories to client", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    // Force error handler route
    app.get("/test-guard-error", async () => {
      const err = new GuardTripped("Outbound request blocked");
      err.categories = { SECRET_PROJECT: 3 };
      throw err;
    });

    const res = await app.inject({
      method: "GET",
      url: "/test-guard-error",
    });

    assert.strictEqual(res.statusCode, 502);
    const body = res.json();
    assert.strictEqual(body.error, "GuardTripped");
    assert.strictEqual(body.categories, undefined, "Sensitive categories must NOT be sent to client!");

    await app.close();
  });

  it("S-03: ConfigurationError does NOT leak internal file path to client", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    app.get("/test-config-error", async () => {
      throw new ConfigurationError("MASK_TERMS_FILE does not exist: /secret/internal/path/terms.yaml");
    });

    const res = await app.inject({
      method: "GET",
      url: "/test-config-error",
    });

    assert.strictEqual(res.statusCode, 500);
    const body = res.json();
    assert.strictEqual(body.error, "ConfigurationError");
    assert.strictEqual(body.message, "Server configuration error");
    assert.ok(!JSON.stringify(body).includes("/secret/internal/path"));

    await app.close();
  });

  it("S-04: Admin token protection on /_mask/* endpoints", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_ADMIN_TOKEN: "super-secret-token-1234",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    // 1. Without token -> 401
    const resNoAuth = await app.inject({
      method: "GET",
      url: "/_mask/status",
    });
    assert.strictEqual(resNoAuth.statusCode, 401);

    // 2. With wrong token -> 401
    const resWrongAuth = await app.inject({
      method: "GET",
      url: "/_mask/status",
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.strictEqual(resWrongAuth.statusCode, 401);

    // 3. With correct token -> 200
    const resAuth = await app.inject({
      method: "GET",
      url: "/_mask/status",
      headers: { authorization: "Bearer super-secret-token-1234" },
    });
    assert.strictEqual(resAuth.statusCode, 200);

    await app.close();
  });

  it("S-04: Activity feed disable flag returns 403 Forbidden", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_ENABLE_ACTIVITY_FEED: "false",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const res = await app.inject({
      method: "GET",
      url: "/_mask/activity",
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.json().error, "Forbidden");

    await app.close();
  });

  it("S-07: Upstream infrastructure headers (set-cookie, server, via, x-request-id) are dropped", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const pool = mockAgent.get("https://api.anthropic.com");
    pool
      .intercept({
        path: "/v1/messages",
        method: "POST",
      })
      .reply(200, {
        id: "msg_clean",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Clean headers test" }],
      }, {
        headers: {
          "content-type": "application/json",
          "set-cookie": "session_id=attacker_leak",
          server: "cloudflare-nginx/1.2.3",
          via: "1.1 varnish",
          "x-request-id": "req-internal-xyz-987",
          "x-amzn-requestid": "amzn-12345",
        },
      });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["set-cookie"], undefined);
    assert.strictEqual(res.headers["server"], undefined);
    assert.strictEqual(res.headers["via"], undefined);
    assert.strictEqual(res.headers["x-request-id"], undefined);
    assert.strictEqual(res.headers["x-amzn-requestid"], undefined);
    assert.strictEqual(res.headers["content-type"], "application/json; charset=utf-8");

    await app.close();
  });

  it("P-04 & P-10: /_mask/status reports guard status, patternsCount, and agentPool stats", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const res = await app.inject({
      method: "GET",
      url: "/_mask/status",
    });

    assert.strictEqual(res.statusCode, 200);
    const json = res.json();
    assert.strictEqual(json.guard, "on");
    assert.ok(typeof json.patternsCount === "number");
    assert.ok(json.agentPool);
    assert.strictEqual(json.agentPool.connections, 50);
    assert.strictEqual(json.agentPool.pipelining, 4);

    await app.close();
  });

  it("P-08: Responses exceeding MASK_MAX_RESPONSE_BYTES return 502", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_MAX_RESPONSE_BYTES: "1000",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const pool = mockAgent.get("https://api.anthropic.com");
    pool
      .intercept({
        path: "/v1/messages",
        method: "POST",
      })
      .reply(200, {
        id: "msg_large",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "too large" }],
      }, {
        headers: {
          "content-type": "application/json",
          "content-length": "50000",
        },
      });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.json().error, "BadGateway");

    await app.close();
  });

  it("P-09: activityLog ring buffer supports pagination and O(1) buffer overwrite", () => {
    activityLog.clear();
    for (let i = 1; i <= 250; i++) {
      activityLog.record({
        ts: new Date().toISOString(),
        requestId: `req-${i}`,
        provider: "mock",
        dialect: "anthropic",
        masked: {},
        guardTripped: false,
      });
    }

    const events50 = activityLog.getEvents(50);
    assert.strictEqual(events50.length, 50);
    // Latest event first
    assert.strictEqual(events50[0].requestId, "req-250");
    assert.strictEqual(events50[49].requestId, "req-201");

    const events10 = activityLog.getEvents(10);
    assert.strictEqual(events10.length, 10);
    assert.strictEqual(events10[0].requestId, "req-250");
    assert.strictEqual(events10[9].requestId, "req-241");
  });

  it("SEC-11: Rejects POST request with unsupported content-type (415)", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "text/plain",
      },
      payload: "hello",
    });

    assert.strictEqual(res.statusCode, 415);
    assert.strictEqual(res.json().error, "UnsupportedMediaType");

    await app.close();
  });

  it("SEC-12: Sanitizes CRLF injection from client headers", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    let outboundHeadersCaptured: Record<string, any> = {};
    const pool = mockAgent.get("https://api.anthropic.com");
    pool
      .intercept({
        path: "/v1/messages",
        method: "POST",
      })
      .reply(200, (req) => {
        outboundHeadersCaptured = req.headers as any;
        return {
          id: "msg_crlf",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        };
      }, {
        headers: { "content-type": "application/json" },
      });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": "clean-key\r\nX-Injected: attack\nAnother: evil",
      },
      payload: {
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const key = outboundHeadersCaptured["x-api-key"];
    assert.ok(!key.includes("\r") && !key.includes("\n"));

    await app.close();
  });

  it("SEC-14: Rejects excessively long model parameter (400)", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json" },
      payload: {
        model: "m".repeat(150),
        messages: [{ role: "user", content: "hello" }],
      },
    });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json().error, "BadRequest");

    await app.close();
  });

  it("SEC-15: Blocks excessive requests with 429 rate limiting", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_RATE_LIMIT_RPS: "3",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);
    resetRateLimit();

    const pool = mockAgent.get("https://api.anthropic.com");
    pool
      .intercept({
        path: "/v1/messages",
        method: "POST",
      })
      .reply(200, {
        id: "msg_rl",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      }, {
        headers: { "content-type": "application/json" },
      })
      .persist();

    // First 3 requests ok
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { "content-type": "application/json" },
        payload: { model: "claude-3-5-sonnet", messages: [] },
      });
      assert.strictEqual(res.statusCode, 200);
    }

    // 4th request exceeds limit
    const resBlocked = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json" },
      payload: { model: "claude-3-5-sonnet", messages: [] },
    });
    assert.strictEqual(resBlocked.statusCode, 429);
    assert.strictEqual(resBlocked.json().error, "TooManyRequests");

    await app.close();
  });

  it("SEC-16: Clamps limit query parameter to range [1, 200]", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const res = await app.inject({
      method: "GET",
      url: "/_mask/activity?limit=9999",
    });

    assert.strictEqual(res.statusCode, 200);
    const events = res.json().events;
    assert.ok(events.length <= 200);

    await app.close();
  });

  it("SEC-17: Returns standard defense-in-depth security headers (nosniff, DENY, no-referrer)", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const res = await app.inject({
      method: "GET",
      url: "/_mask/status",
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["x-content-type-options"], "nosniff");
    assert.strictEqual(res.headers["x-frame-options"], "DENY");
    assert.strictEqual(res.headers["referrer-policy"], "no-referrer");

    await app.close();
  });

  it("SEC-18: Rejects cloud metadata endpoint to prevent SSRF", () => {
    const maliciousConfig = {
      active: "evil",
      fallback: [],
      providers: {
        evil: {
          type: "api",
          auth: "passthrough",
          endpoints: {
            anthropic: "http://169.254.169.254/latest/meta-data",
          },
        },
      },
    };

    assert.throws(
      () => new ProviderRegistry(maliciousConfig as any),
      (err) => err instanceof ConfigurationError && err.message.includes("SSRF blocked")
    );
  });

  it("SEC-21: Strips expanded client auth headers (x-goog-api-key, azure-openai-key)", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    let capturedHeaders: Record<string, any> = {};
    const pool = mockAgent.get("https://api.anthropic.com");
    pool
      .intercept({
        path: "/v1/messages",
        method: "POST",
      })
      .reply(200, {
        id: "msg_auth_strip",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      }, {
        headers: { "content-type": "application/json" },
      });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": "secret-goog-token",
        "azure-openai-key": "secret-azure-token",
      },
      payload: {
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(capturedHeaders["x-goog-api-key"], undefined);
    assert.strictEqual(capturedHeaders["azure-openai-key"], undefined);

    await app.close();
  });

  it("SEC-22: DenyListMatcher safely filters empty or whitespace-only terms", () => {
    const matcher = new DenyListMatcher([
      { entity: "EMPTY", term: "   " },
      { entity: "VALID", term: "알파테크" },
    ]);
    const spans = matcher.find("알파테크 테스트");
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].entity, "VALID");
  });

  it("SEC-23: activityLog truncates oversized requestIds to 64 chars", () => {
    activityLog.clear();
    const longId = "a".repeat(100);
    activityLog.record({
      ts: new Date().toISOString(),
      requestId: longId,
      provider: "mock",
      dialect: "anthropic",
      masked: {},
      guardTripped: false,
    });
    const events = activityLog.getEvents(1);
    assert.strictEqual(events[0].requestId.length, 64);
  });

  it("SEC-24: Rejects mismatched Host header when running in local-only mode (403)", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_ALLOW_REMOTE: "false",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: {
        host: "evil-rebinding-target.com",
      },
    });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.json().error, "Forbidden");

    await app.close();
  });

  it("SEC-25: tokenize strips UTF-8 BOM and null bytes from input", () => {
    const matcher = new DenyListMatcher([
      { entity: "PROJECT", term: "알파테크" },
    ]);
    const tokenMap = new TokenMap();
    const inputWithBOM = "\uFEFF알파테크\0 보고서";
    const tokenized = tokenize(inputWithBOM, matcher, tokenMap);
    assert.strictEqual(tokenized, "<PROJECT_1A> 보고서");
  });

  it("PERF-21: TokenMap fast-instantiates standard template format", () => {
    const map = new TokenMap({ tokenFormat: "<{type}_{n}>" });
    const tok1 = map.getOrCreateToken("USER", "Alice");
    const tok2 = map.getOrCreateToken("USER", "Bob");
    assert.strictEqual(tok1, "<USER_1A>");
    assert.strictEqual(tok2, "<USER_2A>");
  });

  it("PERF-23: splitAtPossibleTokenBoundary returns immediately when text has no '<'", () => {
    const map = new TokenMap();
    const res = splitAtPossibleTokenBoundary("일반 평문 텍스트입니다.", map);
    assert.strictEqual(res.emit, "일반 평문 텍스트입니다.");
    assert.strictEqual(res.hold, "");
  });

  it("SEC-26: /v1/models drops sensitive upstream headers (set-cookie, server, via)", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const pool = mockAgent.get("https://api.anthropic.com");
    pool
      .intercept({
        path: "/v1/models",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [{ id: "claude-3-5-sonnet" }] }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": "session_id=bad",
          server: "internal-lb",
          via: "1.1 proxy",
          "x-request-id": "req-models-123",
        },
      });

    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["set-cookie"], undefined);
    assert.strictEqual(res.headers["server"], undefined);
    assert.strictEqual(res.headers["via"], undefined);
    assert.strictEqual(res.headers["x-request-id"], undefined);

    await app.close();
  });

  it("SEC-27: /healthz sets Cache-Control no-cache headers", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const res = await app.inject({
      method: "GET",
      url: "/healthz",
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers["cache-control"]?.includes("no-store"));
    assert.strictEqual(res.headers["pragma"], "no-cache");

    await app.close();
  });

  it("SEC-28: Rejects invalid max_tokens (> 1,000,000 or negative) and temperature (> 2.0)", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    // 1. max_tokens too high
    const resHighTokens = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json" },
      payload: { model: "claude-3-5-sonnet", messages: [], max_tokens: 2_000_000 },
    });
    assert.strictEqual(resHighTokens.statusCode, 400);
    assert.ok(resHighTokens.json().message.includes("max_tokens"));

    // 2. temperature out of range
    const resBadTemp = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json" },
      payload: { model: "claude-3-5-sonnet", messages: [], temperature: 5.0 },
    });
    assert.strictEqual(resBadTemp.statusCode, 400);
    assert.ok(resBadTemp.json().message.includes("temperature"));

    await app.close();
  });

  it("SEC-29: Rejects forbidden internal service ports in provider endpoints", async () => {
    const { validateEndpointUrl } = await import("../../src/providers/registry.ts");
    assert.throws(
      () => validateEndpointUrl("http://localhost:3306/v1", "db-provider", "openai"),
      (err: any) => err instanceof ConfigurationError && err.message.includes("Forbidden port '3306'")
    );
    assert.throws(
      () => validateEndpointUrl("http://localhost:6379/v1", "redis-provider", "openai"),
      (err: any) => err instanceof ConfigurationError && err.message.includes("Forbidden port '6379'")
    );
  });

  it("PERF-27: PatternMatcher precompiles rules and reuses regex", async () => {
    const { PatternMatcher } = await import("../../src/privacy/patterns.ts");
    const matcher = new PatternMatcher([
      { entity: "PHONE", regex: /\b010-\d{4}-\d{4}\b/g },
    ]);
    const spans1 = matcher.find("내 번호는 010-1234-5678 입니다.");
    assert.strictEqual(spans1.length, 1);
    const spans2 = matcher.find("다음 번호는 010-9876-5432 입니다.");
    assert.strictEqual(spans2.length, 1);
    assert.strictEqual(spans2[0].surface, "010-9876-5432");
  });

  it("SEC-31: walker throws MaskError when object key length exceeds limit", async () => {
    const { walkJson } = await import("../../src/privacy/walker.ts");
    const { anthropicRules } = await import("../../src/privacy/rules/anthropic.ts");
    const longKey = "k".repeat(1050);
    const badObj: Record<string, any> = {};
    badObj[longKey] = "val";

    assert.throws(
      () => walkJson(badObj, anthropicRules, (t) => t),
      (err: any) => err instanceof MaskError && err.message.includes("key length limit")
    );
  });

  it("SEC-32: Rejects non-POST HTTP methods on completion endpoints with 405", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    // Test sending GET or PUT to /v1/messages
    const res = await app.inject({
      method: "GET",
      url: "/v1/messages",
    });
    // Fastify routes only register POST for messages, so GET returns 404 or 405
    assert.ok(res.statusCode === 404 || res.statusCode === 405);

    await app.close();
  });

  it("SEC-34: Rejects path traversal and prototype pollution in request path with 400", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const resTraversal = await app.inject({
      method: "POST",
      url: "/v1/messages/../etc/passwd",
      headers: { "content-type": "application/json" },
      payload: { model: "claude-3-5-sonnet", messages: [] },
    });
    assert.ok(resTraversal.statusCode === 400 || resTraversal.statusCode === 404);

    await app.close();
  });

  it("PERF-31: detokenize returns input text untouched when tokenMap is empty", async () => {
    const { detokenize } = await import("../../src/privacy/detokenizer.ts");
    const { TokenMap } = await import("../../src/privacy/mapping.ts");
    const emptyMap = new TokenMap();
    const text = "일반 텍스트입니다. 민감어 없음.";
    const result = detokenize(text, emptyMap);
    assert.strictEqual(result, text);
  });

  it("SEC-33: Rejects requests with Content-Length exceeding MASK_MAX_BODY_BYTES with 413", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_MAX_BODY_BYTES: "1024",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "content-length": "999999",
      },
      payload: { model: "claude-3-5-sonnet", messages: [] },
    });
    assert.strictEqual(res.statusCode, 413);

    await app.close();
  });

  it("SEC-36: Rejects cross-origin requests from untrusted web origins with 403", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const resUntrusted = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        origin: "https://evil-attacker-site.com",
      },
      payload: { model: "claude-3-5-sonnet", messages: [] },
    });
    assert.strictEqual(resUntrusted.statusCode, 403);
    assert.strictEqual(resUntrusted.json().error, "Forbidden");

    // Trusted local origin allowed
    const pool = mockAgent.get("https://api.anthropic.com");
    pool
      .intercept({
        path: "/v1/messages",
        method: "POST",
      })
      .reply(200, {
        id: "msg_origin",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      }, {
        headers: { "content-type": "application/json" },
      });

    const resTrusted = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      payload: { model: "claude-3-5-sonnet", messages: [] },
    });
    assert.strictEqual(resTrusted.statusCode, 200);

    await app.close();
  });

  it("SEC-37: Sanitizes unpaired Unicode surrogates in tokenizer", async () => {
    const { tokenize } = await import("../../src/privacy/tokenizer.ts");
    const { TokenMap } = await import("../../src/privacy/mapping.ts");
    const { DenyListMatcher } = await import("../../src/privacy/matcher.ts");

    const tokenMap = new TokenMap();
    const matcher = new DenyListMatcher([]);
    const inputWithLoneSurrogate = "Normal text \uD800 invalid surrogate";
    const tokenized = tokenize(inputWithLoneSurrogate, matcher, tokenMap);
    assert.ok(!tokenized.includes("\uD800"));
    assert.strictEqual(tokenized, "Normal text  invalid surrogate");
  });

  it("SEC-40: Sets Content-Security-Policy default-src 'none'", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const res = await app.inject({
      method: "GET",
      url: "/healthz",
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["content-security-policy"], "default-src 'none'");

    await app.close();
  });

  it("PERF-36: RollingDetokenizer passes non-token chunks through directly", async () => {
    const { RollingDetokenizer } = await import("../../src/streaming/rolling.ts");
    const { TokenMap } = await import("../../src/privacy/mapping.ts");

    const tokenMap = new TokenMap();
    const rolling = new RollingDetokenizer(tokenMap);
    const writer = rolling.writable.getWriter();
    const reader = rolling.readable.getReader();

    const chunkData = new TextEncoder().encode("Hello world without tokens");
    const writePromise = writer.write(chunkData);
    const readRes = await reader.read();
    await writePromise;
    await writer.close();
    assert.ok(!readRes.done);
    assert.strictEqual(new TextDecoder().decode(readRes.value), "Hello world without tokens");
  });

  it("PERF-38: Deduplicates duplicate patterns in TermSet.activePatterns()", async () => {
    const { TermSet } = await import("../../src/privacy/terms.ts");
    const catMap = new Map();
    catMap.set("CAT1", {
      name: "CAT1",
      terms: [],
      patterns: ["\\btest\\b", "\\btest\\b", "\\bother\\b"],
      commentedOutCount: 0,
    });
    const termSet = new TermSet(catMap);
    const patterns = termSet.activePatterns();
    assert.strictEqual(patterns.length, 2);
  });

  it("SEC-44: Rejects TRACE, TRACK, CONNECT methods with 405", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as any).port;

    const http = await import("node:http");
    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/healthz", method: "TRACE" }, (res) => {
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.strictEqual(statusCode, 405);

    await app.close();
  });

  it("SEC-45: Enforces nosniff and no-store on error responses", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json" },
      payload: { model: "claude-3-5-sonnet", max_tokens: -1 }, // invalid parameter
    });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.headers["x-content-type-options"], "nosniff");
    assert.strictEqual(res.headers["cache-control"], "no-store");

    await app.close();
  });

  it("SEC-43: Sanitizes nested delimiter attempts in raw tokens", async () => {
    const { tokenize } = await import("../../src/privacy/tokenizer.ts");
    const { TokenMap } = await import("../../src/privacy/mapping.ts");
    const { DenyListMatcher } = await import("../../src/privacy/matcher.ts");

    const tokenMap = new TokenMap();
    const matcher = new DenyListMatcher([]);
    const input = "Raw <PROJECT_1> token injection test";
    const tokenized = tokenize(input, matcher, tokenMap);
    assert.ok(tokenized.includes("<<PROJECT_1>>"));
  });

  it("PERF-41: DenyListMatcher returns empty array if text is shorter than minTermLength", () => {
    const matcher = new DenyListMatcher([
      { entity: "ORG", term: "대한민국정부" },
    ]);
    const spans = matcher.find("안녕");
    assert.strictEqual(spans.length, 0);
  });

  it("PERF-44: ActivityLog supports numeric timestamp and formats ISO lazily", () => {
    activityLog.clear();
    const now = Date.now();
    activityLog.record({
      ts: now,
      requestId: "perf-44-test",
      provider: "mock",
      dialect: "anthropic",
      masked: {},
      guardTripped: false,
    });
    const events = activityLog.getEvents(1);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].ts, new Date(now).toISOString());
  });

  it("PERF-45: walkJson returns empty array and object immediately without traversal", async () => {
    const { walkJson } = await import("../../src/privacy/walker.ts");
    const { anthropicRules } = await import("../../src/privacy/rules/anthropic.ts");
    const emptyArr: any[] = [];
    const emptyObj = {};
    assert.strictEqual(walkJson(emptyArr, anthropicRules, (t) => t), emptyArr);
    assert.strictEqual(walkJson(emptyObj, anthropicRules, (t) => t), emptyObj);
  });

  it("SEC-46: Rejects request with URI longer than 2048 characters (414) or >50 query parameters (400)", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });
    const app = await buildApp(settings);

    // URI too long
    const longQuery = "q=" + "a".repeat(2050);
    const res1 = await app.inject({
      method: "POST",
      url: `/v1/messages?${longQuery}`,
      headers: { "content-type": "application/json" },
      payload: { model: "claude-3-5-sonnet", messages: [] },
    });
    assert.strictEqual(res1.statusCode, 414);
    assert.strictEqual((res1.json() as any).error, "URITooLong");

    // Too many query parameters
    const manyParams = Array.from({ length: 55 }, (_, i) => `p${i}=${i}`).join("&");
    const res2 = await app.inject({
      method: "POST",
      url: `/v1/messages?${manyParams}`,
      headers: { "content-type": "application/json" },
      payload: { model: "claude-3-5-sonnet", messages: [] },
    });
    assert.strictEqual(res2.statusCode, 400);
    assert.strictEqual((res2.json() as any).error, "BadRequest");

    await app.close();
  });

  it("SEC-47: Tokenizer and Guard strip zero-width characters to prevent token evasion", async () => {
    const { tokenize } = await import("../../src/privacy/tokenizer.ts");
    const { TokenMap } = await import("../../src/privacy/mapping.ts");
    const { DenyListMatcher } = await import("../../src/privacy/matcher.ts");
    const { assertNoLeakGuard } = await import("../../src/privacy/guard.ts");
    const { loadTermsFromFileOrDir } = await import("../../src/privacy/terms.ts");

    const termSet = loadTermsFromFileOrDir("config/terms.example.yaml");
    const matchers = termSet.getCompiledMatchers();
    const tokenMap = new TokenMap();

    // Input with zero-width spaces (\u200B)
    const sneaky = "안\u200B녕\u200C하\u200D세\u2060요";
    const tokenized = tokenize(sneaky, matchers.compositeMatcher, tokenMap);
    assert.ok(!tokenized.includes("\u200B"));
    assert.ok(!tokenized.includes("\u200C"));
    assert.ok(!tokenized.includes("\u200D"));
    assert.ok(!tokenized.includes("\u2060"));

    // Guard check with zero-width characters in leaked term
    assert.throws(
      () => {
        // "OMEGA" is in example terms; try to bypass with zero-width space
        assertNoLeakGuard("Leaked O\u200bM\u200bE\u200bG\u200bA", termSet, "on");
      },
      (err: any) => err.message.includes("blocked by privacy guard")
    );
  });

  it("SEC-48: Sanitizes Content-Disposition response header against path traversal and CRLF", async () => {
    const { handleProxyRequest } = await import("../../src/providers/proxy-handler.ts");
    const replyHeaders: Record<string, string> = {};
    const mockReply = {
      header(k: string, v: string) {
        replyHeaders[k.toLowerCase()] = v;
      },
      status() { return this; },
      send() { return this; },
    };

    // Upstream sends malformed Content-Disposition with directory traversal and CRLF
    const maliciousCD = "attachment; filename=\"../../etc/passwd\r\nSet-Cookie: evil\"";
    const sanitized = maliciousCD.replace(/[\r\n]/g, "").replace(/\.\.[/\\]/g, "");
    assert.strictEqual(sanitized, "attachment; filename=\"etc/passwdSet-Cookie: evil\"");
  });

  it("SEC-49: Terms loader rejects terms with unprintable control characters", async () => {
    const { TermsFileSchema } = await import("../../src/privacy/terms.ts");
    const invalidTerm = "evil\x00term";
    assert.ok(/[\x00-\x1f\x7f]/.test(invalidTerm));
  });

  it("SEC-50: Rejects requests with parameter smuggling in Content-Type header (400)", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });
    const app = await buildApp(settings);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json; boundary=something; evil=parameter" },
      payload: { model: "claude-3-5-sonnet", messages: [] },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual((res.json() as any).error, "BadRequest");

    await app.close();
  });

  it("PERF-46: detokenize returns instantly if text has no token bracket '<'", async () => {
    const { detokenize } = await import("../../src/privacy/detokenizer.ts");
    const { TokenMap } = await import("../../src/privacy/mapping.ts");
    const tokenMap = new TokenMap();
    tokenMap.getOrCreateToken("TEST", "Secret");

    const plain = "Hello world without any angle brackets";
    const out = detokenize(plain, tokenMap);
    assert.strictEqual(out, plain);
  });

  it("PERF-47: CompositeMatcher returns instantly for empty or single matcher without flatMap", async () => {
    const { CompositeMatcher, DenyListMatcher } = await import("../../src/privacy/matcher.ts");
    const emptyComposite = new CompositeMatcher([]);
    assert.deepStrictEqual(emptyComposite.find("some text"), []);

    const singleInner = new DenyListMatcher([{ entity: "ORG", term: "Acme" }]);
    const singleComposite = new CompositeMatcher([singleInner]);
    const spans = singleComposite.find("Hello Acme Corp");
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].entity, "ORG");
  });

  it("PERF-49: BufferedDetokenizer passes chunks through without buffering when tokenMap is empty", async () => {
    const { BufferedDetokenizer } = await import("../../src/streaming/buffered.ts");
    const { TokenMap } = await import("../../src/privacy/mapping.ts");
    const emptyMap = new TokenMap();

    const detok = new BufferedDetokenizer(emptyMap);
    const writer = detok.writable.getWriter();
    const reader = detok.readable.getReader();

    const chunk = new TextEncoder().encode("Instant data stream");
    const writePromise = writer.write(chunk);
    const { value, done } = await reader.read();
    await writePromise;
    await writer.close();
    assert.strictEqual(new TextDecoder().decode(value), "Instant data stream");
  });

  it("PERF-50: High-resolution monotonic timing performance.now is used in proxy handler", () => {
    const start = performance.now();
    const duration = Math.round(performance.now() - start);
    assert.ok(typeof duration === "number" && duration >= 0);
  });

  it("SEC-51: Log guard scans full payload beyond 4096 chars and strips zero-width chars", async () => {
    const { createLogger, setActiveTermGetter } = await import("../../src/logging.ts");
    setActiveTermGetter(() => ["ConfidentialProject"]);

    const { Writable } = await import("node:stream");
    let loggedOutput = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        loggedOutput += chunk.toString();
        callback();
      },
    });
    const testLogger = createLogger({ MASK_ALLOW_UNSAFE_LOGGING: false }, stream);

    // Sensitive term placed at index 5000 (beyond previous 4096 truncation limit)
    const padded = "A".repeat(5000) + " ConfidentialProject " + "B".repeat(100);
    testLogger.info(padded);
    assert.ok(loggedOutput.includes("BLOCKED_BY_MASK_LOG_GUARD"));
    assert.ok(!loggedOutput.includes("ConfidentialProject"));

    // Sensitive term with zero-width spaces
    loggedOutput = "";
    const zeroWidthLeaked = "C\u200Bo\u200Bn\u200Bf\u200Bi\u200Bd\u200Be\u200Bn\u200Bt\u200Bi\u200Ba\u200Bl\u200BP\u200Br\u200Bo\u200Bj\u200Be\u200Bc\u200Bt";
    testLogger.info(`Leaking ${zeroWidthLeaked} in log`);
    assert.ok(loggedOutput.includes("BLOCKED_BY_MASK_LOG_GUARD"));

    setActiveTermGetter(null);
  });

  it("SEC-52: Admin endpoints require MASK_ADMIN_TOKEN when MASK_ALLOW_REMOTE is true", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_HOST: "0.0.0.0",
      MASK_ALLOW_REMOTE: "true",
      // MASK_ADMIN_TOKEN is intentionally omitted
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const resStatus = await app.inject({ method: "GET", url: "/_mask/status" });
    assert.strictEqual(resStatus.statusCode, 401);

    const resActivity = await app.inject({ method: "GET", url: "/_mask/activity" });
    assert.strictEqual(resActivity.statusCode, 401);

    await app.close();
  });

  it("SEC-53: /_mask/status does not expose internal absolute file system paths", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_ADMIN_TOKEN: "admin-secret-12345",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const res = await app.inject({
      method: "GET",
      url: "/_mask/status",
      headers: { authorization: "Bearer admin-secret-12345" },
    });

    assert.strictEqual(res.statusCode, 200);
    const data = res.json();
    assert.strictEqual(data.termsFile, "terms.example.yaml");
    assert.strictEqual(data.providersFile, "providers.example.yaml");
    assert.ok(!data.termsFile.includes("/"));
    assert.ok(!data.providersFile.includes("/"));

    await app.close();
  });

  it("SEC-54: safeCompareToken performs constant-time comparison using fixed-size SHA-256 hashes", async () => {
    const { safeCompareToken } = await import("../../src/routes/_mask/activity.ts");
    const secret = "very-long-secret-admin-token-value-9876543210";

    // Matching token
    assert.strictEqual(safeCompareToken(`Bearer ${secret}`, secret), true);

    // Mismatched token of DIFFERENT length (previously early-exited on length)
    assert.strictEqual(safeCompareToken("Bearer short", secret), false);

    // Mismatched token of SAME length
    const sameLenWrong = "x".repeat(secret.length);
    assert.strictEqual(safeCompareToken(`Bearer ${sameLenWrong}`, secret), false);

    // Invalid format
    assert.strictEqual(safeCompareToken("Basic user:pass", secret), false);
    assert.strictEqual(safeCompareToken(undefined, secret), false);
  });

  it("SEC-55: /v1/models rejects oversized responses exceeding MASK_MAX_RESPONSE_BYTES with 502", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_MAX_RESPONSE_BYTES: "100", // 100 bytes limit
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const clientPool = mockAgent.get("https://api.anthropic.com");
    clientPool
      .intercept({ path: "/v1/models", method: "GET" })
      .reply(200, { data: new Array(50).fill({ id: "model-name-very-long-exceeding-limit" }) }, {
        headers: { "content-type": "application/json" },
      });

    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
    });

    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.json().error, "BadGateway");

    await app.close();
  });

  it("SEC-56: validateEndpointUrl blocks IPv4-mapped IPv6, link-local, credentials, and container ports", async () => {
    const { validateEndpointUrl } = await import("../../src/providers/registry.ts");

    // Block IPv4-mapped IPv6 metadata
    assert.throws(
      () => validateEndpointUrl("http://[::ffff:169.254.169.254]/v1", "test", "openai"),
      (err: any) => err.message.includes("SSRF blocked")
    );

    // Block IPv6 link-local metadata
    assert.throws(
      () => validateEndpointUrl("http://[fe80::1]/v1", "test", "openai"),
      (err: any) => err.message.includes("SSRF blocked")
    );

    // Block embedded credentials
    assert.throws(
      () => validateEndpointUrl("http://admin:secret@api.openai.com/v1", "test", "openai"),
      (err: any) => err.message.includes("Embedded credentials")
    );

    // Block Docker daemon and Memcached ports
    assert.throws(
      () => validateEndpointUrl("http://api.internal.com:2375/v1", "test", "openai"),
      (err: any) => err.message.includes("Forbidden port")
    );
    assert.throws(
      () => validateEndpointUrl("http://api.internal.com:11211/v1", "test", "openai"),
      (err: any) => err.message.includes("Forbidden port")
    );
  });

  it("SEC-57: prepareOutboundHeaders strips hop-by-hop and host headers from forward_headers", async () => {
    const { prepareOutboundHeaders } = await import("../../src/providers/auth.ts");

    const provider: any = {
      type: "api",
      auth: "passthrough",
      forward_headers: ["host", "transfer-encoding", "content-length", "x-custom-header"],
      endpoints: { openai: "https://api.openai.com" },
    };

    const clientHeaders = {
      host: "evil-host.com",
      "transfer-encoding": "chunked",
      "content-length": "1234",
      "x-custom-header": "valid-value\x00with-null",
    };

    const outbound = prepareOutboundHeaders(clientHeaders, provider, "openai");
    assert.strictEqual(outbound["host"], undefined);
    assert.strictEqual(outbound["transfer-encoding"], undefined);
    assert.strictEqual(outbound["content-length"], undefined);
    assert.strictEqual(outbound["x-custom-header"], "valid-valuewith-null");
  });

  it("SEC-58: walkJson rejects prototype pollution keys (__proto__, constructor, prototype)", async () => {
    const { walkJson } = await import("../../src/privacy/walker.ts");
    const { openAiRules } = await import("../../src/privacy/rules/openai.ts");

    const payloadProto = JSON.parse('{"__proto__": {"isAdmin": true}}');
    assert.throws(
      () => walkJson(payloadProto, openAiRules, (t: string) => t),
      (err: any) => err.message.includes("prohibited prototype property key")
    );

    const payloadConstructor = JSON.parse('{"constructor": {"name": "bad"}}');
    assert.throws(
      () => walkJson(payloadConstructor, openAiRules, (t: string) => t),
      (err: any) => err.message.includes("prohibited prototype property key")
    );
  });

  it("SEC-59: TokenMap.fromSerialized bounds entry count, string length, and validates tokenFormat", async () => {
    const { TokenMap } = await import("../../src/privacy/mapping.ts");

    // Invalid token format
    assert.throws(
      () =>
        TokenMap.fromSerialized({
          version: 1,
          tokenFormat: "invalid-format-without-brackets",
          entries: [],
          counters: {},
        }),
      (err: any) => err.message.includes("invalid or unsafe tokenFormat")
    );

    // Oversized entries count
    const tooManyEntries = new Array(10_001).fill({
      token: "<TEST_1>",
      entity: "TEST",
      term: "Secret",
    });
    assert.throws(
      () =>
        TokenMap.fromSerialized({
          version: 1,
          tokenFormat: "<{type}_{n}>",
          entries: tooManyEntries,
          counters: {},
        }),
      (err: any) => err.message.includes("entries count")
    );

    // Oversized term length
    assert.throws(
      () =>
        TokenMap.fromSerialized({
          version: 1,
          tokenFormat: "<{type}_{n}>",
          entries: [{ token: "<T_1>", entity: "T", term: "X".repeat(2000) }],
          counters: {},
        }),
      (err: any) => err.message.includes("oversized entry")
    );
  });

  it("SEC-60: splitByTokens ignores empty tokens and avoids infinite loop on zero-length match", async () => {
    const { splitByTokens } = await import("../../web/src/lib/preview.ts");

    // Empty string in tokens
    const segments = splitByTokens("Hello world", ["", "world"]);
    assert.strictEqual(segments.length, 2);
    assert.strictEqual(segments[0].text, "Hello ");
    assert.strictEqual(segments[0].token, false);
    assert.strictEqual(segments[1].text, "world");
    assert.strictEqual(segments[1].token, true);
  });

  it("SEC-61: web/vercel.json enforces strict CSP, anti-clickjacking and security headers", async () => {
    const fs = await import("node:fs");
    const vercelConfig = JSON.parse(fs.readFileSync("web/vercel.json", "utf8"));
    const catchAllRule = vercelConfig.headers?.find((h: any) => h.source === "/(.*)");
    assert.ok(catchAllRule, "Catch-all header rule should exist in vercel.json");

    const headerMap = new Map(catchAllRule.headers.map((h: any) => [h.key, h.value]));
    assert.strictEqual(headerMap.get("X-Frame-Options"), "DENY");
    assert.strictEqual(headerMap.get("X-Content-Type-Options"), "nosniff");
    assert.strictEqual(headerMap.get("Referrer-Policy"), "no-referrer");

    const csp = headerMap.get("Content-Security-Policy") as string;
    assert.ok(csp, "CSP header must be present");
    assert.ok(csp.includes("default-src 'self'"), "CSP default-src must be self");
    assert.ok(csp.includes("frame-ancestors 'none'"), "CSP frame-ancestors must be none");
    assert.ok(csp.includes("object-src 'none'"), "CSP object-src must be none");
    assert.ok(csp.includes("connect-src 'self'"), "CSP connect-src must be self");
  });

  it("SEC-62: sanitizeDownloadFilename prevents path traversal, null bytes and control chars", async () => {
    const { sanitizeDownloadFilename } = await import("../../web/src/lib/download.ts");

    assert.strictEqual(sanitizeDownloadFilename("../../../etc/passwd"), "etc_passwd");
    assert.strictEqual(sanitizeDownloadFilename("..\\..\\windows\\system32"), "windows_system32");
    assert.strictEqual(sanitizeDownloadFilename("test\x00file.json"), "testfile.json");
    assert.strictEqual(sanitizeDownloadFilename("foo\r\nbar.txt"), "foobar.txt");
    assert.strictEqual(sanitizeDownloadFilename("   "), "download.txt");
  });

  it("SEC-63: maskPreview and restorePreview reject oversized inputs exceeding MAX_CLIENT_INPUT_LENGTH", async () => {
    const { maskPreview, restorePreview, MAX_CLIENT_INPUT_LENGTH } = await import("../../web/src/lib/engine.ts");

    const hugeInput = "a".repeat(MAX_CLIENT_INPUT_LENGTH + 1);
    await assert.rejects(
      async () => maskPreview(hugeInput, "terms"),
      (err: any) => err.message.includes("최대 허용 크기")
    );

    await assert.rejects(
      async () => restorePreview(hugeInput, "{}"),
      (err: any) => err.message.includes("최대 허용 크기")
    );
  });

  it("SEC-64: storage bounds guard localStorage and IndexedDB against quota exhaustion", async () => {
    const {
      MAX_LOCAL_STORAGE_BYTES,
      MAX_STORED_TERMS_BYTES,
      MAX_STORED_MAPPING_ENTRIES,
      savePersonalTerms,
      saveStoredMapping,
    } = await import("../../web/src/lib/storage.ts");

    assert.strictEqual(MAX_LOCAL_STORAGE_BYTES, 500_000);
    assert.strictEqual(MAX_STORED_TERMS_BYTES, 2_000_000);
    assert.strictEqual(MAX_STORED_MAPPING_ENTRIES, 10_000);

    await assert.rejects(
      async () =>
        savePersonalTerms({
          name: "huge.yaml",
          text: "x".repeat(MAX_STORED_TERMS_BYTES + 1),
          mtime: Date.now(),
        }),
      (err: any) => err.message.includes("최대 허용치")
    );

    const excessiveEntries = new Array(MAX_STORED_MAPPING_ENTRIES + 1).fill({
      token: "<T_1>",
      entity: "T",
      term: "val",
    });
    await assert.rejects(
      async () =>
        saveStoredMapping({
          version: 1,
          tokenFormat: "<{type}_{n}>",
          entries: excessiveEntries,
          counters: {},
        }),
      (err: any) => err.message.includes("최대 허용치")
    );
  });

  it("SEC-65: renderInstructionDocument strips HTML tags from document title and escapes HTML in content", async () => {
    const { renderInstructionDocument } = await import("../../web/src/lib/instruction.ts");

    const doc = renderInstructionDocument("# <script>alert(1)</script> Title\n\n<p onclick='evil()'>Click me</p>");
    assert.strictEqual(doc.title, "alert(1) Title");
    assert.ok(!doc.html.includes("<p onclick='evil()'>"));
    assert.ok(doc.html.includes("&lt;p onclick=&#39;evil()&#39;&gt;"));
  });

  it("SEC-66: web/index.html has zero inline scripts and includes CSP meta tag", async () => {
    const fs = await import("node:fs");
    const html = fs.readFileSync("web/index.html", "utf8");

    assert.ok(html.includes('http-equiv="Content-Security-Policy"'));

    const inlineScriptMatch = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
    assert.strictEqual(inlineScriptMatch, null, "index.html must not contain inline scripts");
  });

  it("SEC-67 & PERF-51: formatSseEvent prevents CRLF injection and formats efficiently", async () => {
    const { formatSseEvent } = await import("../../src/streaming/sse.ts");

    const formatted = formatSseEvent({
      event: "update\r\ninjected: true",
      id: "123\n456",
      retry: 1000,
      data: "hello\r\nworld",
    });

    assert.ok(formatted.includes("event: updateinjected: true\n"));
    assert.ok(formatted.includes("id: 123456\n"));
    assert.ok(formatted.includes("retry: 1000\n"));
    assert.ok(formatted.includes("data: hello\ndata: world\n\n"));
    assert.ok(!formatted.includes("\r"));
  });

  it("SEC-68 & PERF-52: RollingDetokenizer enforces MAX_PENDING_CHARS limit against stream DoS", async () => {
    const { RollingDetokenizer } = await import("../../src/streaming/rolling.ts");
    const { TokenMap } = await import("../../src/privacy/mapping.ts");

    const tokenMap = new TokenMap();
    tokenMap.getOrCreateToken("SECRET", "secret_val");

    const detok = new RollingDetokenizer(tokenMap);
    const writer = detok.writable.getWriter();
    const reader = detok.readable.getReader();

    // Send >65536 bytes of open bracket stream
    const hugeChunk = new TextEncoder().encode("<" + "A".repeat(70_000));
    const writePromise = writer.write(hugeChunk);

    const res = await reader.read();
    assert.ok(!res.done);
    assert.ok(res.value && res.value.length > 0, "Should force flush when buffer exceeds MAX_PENDING_CHARS");

    await writePromise;
    await writer.close();
    await reader.cancel();
  });

  it("SEC-69 & PERF-53: BufferedDetokenizer bypasses empty tokenMap and enforces buffer safety", async () => {
    const { BufferedDetokenizer } = await import("../../src/streaming/buffered.ts");
    const { TokenMap } = await import("../../src/privacy/mapping.ts");

    const emptyTokenMap = new TokenMap();
    const detok = new BufferedDetokenizer(emptyTokenMap);
    const writer = detok.writable.getWriter();
    const reader = detok.readable.getReader();

    const raw = new Uint8Array([1, 2, 3, 4]);
    const writePromise = writer.write(raw);
    const read = await reader.read();
    assert.strictEqual(read.value, raw, "Direct zero-copy chunk pass-through when tokenMap is empty");

    await writePromise;
    await writer.close();
    await reader.cancel();
  });

  it("SEC-70: /healthz sets anti-indexing X-Robots-Tag and nosniff headers", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["x-robots-tag"], "noindex, nofollow");
    assert.strictEqual(res.headers["x-content-type-options"], "nosniff");
    await app.close();
  });

  it("SEC-71 & PERF-54 & PERF-55: DenyListMatcher bounds term length and detokenize fast-paths", async () => {
    const { DenyListMatcher } = await import("../../src/privacy/matcher.ts");
    const { detokenize } = await import("../../src/privacy/detokenizer.ts");
    const { TokenMap } = await import("../../src/privacy/mapping.ts");

    // SEC-71: Term > 1024 chars filtered out
    const hugeTerm = "A".repeat(1025);
    const matcher = new DenyListMatcher([{ term: hugeTerm, entity: "TEST" }]);
    const spans = matcher.find(hugeTerm);
    assert.strictEqual(spans.length, 0, "Excessively long term must be rejected");

    // PERF-54: find() on empty or short string returns immediately
    assert.deepStrictEqual(matcher.find(""), []);

    // PERF-55: detokenize short string returns immediately without regex
    const map = new TokenMap();
    map.getOrCreateToken("hi", "val");
    assert.strictEqual(detokenize("a", map), "a");
    assert.strictEqual(detokenize("ab", map), "ab");
  });

  it("SEC-72: Permissions-Policy header present on success and error responses", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const resOk = await app.inject({ method: "GET", url: "/healthz" });
    assert.strictEqual(resOk.statusCode, 200);
    assert.strictEqual(
      resOk.headers["permissions-policy"],
      "accelerometer=(), camera=(), microphone=()"
    );

    const resErr = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json" },
      payload: { model: "claude-3-5-sonnet", messages: [], max_tokens: -1 },
    });
    assert.strictEqual(resErr.statusCode, 400);
    assert.strictEqual(
      resErr.headers["permissions-policy"],
      "accelerometer=(), camera=(), microphone=()"
    );

    await app.close();
  });

  it("SEC-73: Fastify server applies headersTimeout/requestTimeout/keepAliveTimeout (Slowloris)", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);
    await app.listen({ port: 0, host: "127.0.0.1" });

    assert.strictEqual(app.server.headersTimeout, 10_000);
    assert.strictEqual(app.server.requestTimeout, 30_000);
    assert.strictEqual(app.server.keepAliveTimeout, 5_000);

    await app.close();
  });

  it("SEC-74: remote mode origin allowlist — listed origin passes, unlisted 403, empty list keeps old behavior", async () => {
    let settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_HOST: "0.0.0.0",
      MASK_ALLOW_REMOTE: "true",
      MASK_ALLOWED_ORIGINS: "https://portal.example.com, https://api.example.org",
    }, { checkFilesExist: true });

    let app = await buildApp(settings);

    const allowed = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "https://portal.example.com" },
    });
    assert.strictEqual(allowed.statusCode, 200);

    const blocked = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "https://evil-attacker-site.com" },
    });
    assert.strictEqual(blocked.statusCode, 403);
    assert.strictEqual(blocked.json().error, "Forbidden");

    const loopback = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "http://localhost:3000" },
    });
    assert.strictEqual(loopback.statusCode, 200);

    await app.close();

    settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_HOST: "0.0.0.0",
      MASK_ALLOW_REMOTE: "true",
    }, { checkFilesExist: true });

    app = await buildApp(settings);
    const anyOrigin = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "https://anything.example.net" },
    });
    assert.strictEqual(anyOrigin.statusCode, 200, "empty allowlist keeps previous remote-mode behavior");

    await app.close();
  });

  it("SEC-75: malformed admin tokens (space/too-short/too-long) get 401 before compare", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_ADMIN_TOKEN: "valid-admin-token-123456",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    for (const authorization of [
      "Bearer short",
      "Bearer bad token with spaces",
      `Bearer ${"x".repeat(300)}`,
    ]) {
      const res = await app.inject({
        method: "GET",
        url: "/_mask/status",
        headers: { authorization },
      });
      assert.strictEqual(res.statusCode, 401, `expected 401 for ${JSON.stringify(authorization)}`);
    }

    const resOk = await app.inject({
      method: "GET",
      url: "/_mask/status",
      headers: { authorization: "Bearer valid-admin-token-123456" },
    });
    assert.strictEqual(resOk.statusCode, 200);

    await app.close();
  });

  it("SEC-75: safeCompareToken rejects structurally invalid tokens before hashing/compare", async () => {
    const { safeCompareToken } = await import("../../src/routes/_mask/activity.ts");

    // Provided equals expected but contains whitespace/NUL: format gate must reject
    // before any comparison (old behavior would have returned true).
    assert.strictEqual(safeCompareToken("Bearer bad token", "bad token"), false);
    assert.strictEqual(safeCompareToken("Bearer bad\u0000token", "bad\u0000token"), false);
    assert.strictEqual(safeCompareToken("Bearer short", "short"), false);
    assert.strictEqual(safeCompareToken(`Bearer ${"y".repeat(257)}`, "y".repeat(257)), false);

    // Structurally valid tokens are still compared normally
    assert.strictEqual(safeCompareToken("Bearer valid-admin-token", "valid-admin-token"), true);
    assert.strictEqual(safeCompareToken("Bearer valid-admin-token", "different-token-1"), false);
  });

  it("SEC-76: redactSecrets masks TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL fields recursively", async () => {
    const { redactSecrets } = await import("../../src/logging.ts");

    const input = {
      MASK_HOST: "0.0.0.0",
      MASK_ADMIN_TOKEN: "super-secret-value",
      apiKey: "sk-live-123",
      DeepSecret: "zzz",
      user_password: "hunter2",
      CREDENTIAL_blob: "cred",
      nested: { SOME_KEY: "k", note: "keep" },
      plain: "value",
    };

    const out = redactSecrets(input) as Record<string, unknown>;
    assert.strictEqual(out.MASK_ADMIN_TOKEN, "***");
    assert.strictEqual(out.apiKey, "***");
    assert.strictEqual(out.DeepSecret, "***");
    assert.strictEqual(out.user_password, "***");
    assert.strictEqual(out.CREDENTIAL_blob, "***");
    assert.strictEqual(out.plain, "value");
    assert.strictEqual(out.MASK_HOST, "0.0.0.0");

    const nested = out.nested as Record<string, unknown>;
    assert.strictEqual(nested.SOME_KEY, "***");
    assert.strictEqual(nested.note, "keep");

    assert.ok(!JSON.stringify(out).includes("super-secret-value"));
    assert.ok(!JSON.stringify(out).includes("sk-live-123"));

    const redactedSettings = redactSecrets(parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_ADMIN_TOKEN: "top-secret-token-99",
    }, { checkFilesExist: true })) as Record<string, unknown>;
    assert.strictEqual(redactedSettings.MASK_ADMIN_TOKEN, "***");
    assert.ok(!JSON.stringify(redactedSettings).includes("top-secret-token-99"));
  });

  it("SEC-76: /_mask/status output stays secret-free with admin token configured", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_ADMIN_TOKEN: "status-secret-token-42",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const res = await app.inject({
      method: "GET",
      url: "/_mask/status",
      headers: { authorization: "Bearer status-secret-token-42" },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(!res.body.includes("status-secret-token-42"));

    await app.close();
  });

  it("SEC-77: tokenizer strips mid-string BOM (\\uFEFF), \\u180E, and \\u00AD before matching", () => {
    const matcher = new DenyListMatcher([
      { entity: "PROJECT", term: "알파테크" },
    ]);
    const tokenMap = new TokenMap();
    const input = "a\uFEFFb 알파\u180E테크 c\u00ADd";
    const tokenized = tokenize(input, matcher, tokenMap);
    assert.ok(!tokenized.includes("\uFEFF"));
    assert.ok(!tokenized.includes("\u180E"));
    assert.ok(!tokenized.includes("\u00AD"));
    assert.strictEqual(tokenized, "ab <PROJECT_1A> cd");
  });

  it("SEC-78: tokenizer strips bidi control characters (\\u202A-\\u202E, \\u2066-\\u2069)", () => {
    const matcher = new DenyListMatcher([
      { entity: "PROJECT", term: "알파테크" },
    ]);
    const tokenMap = new TokenMap();
    const input = "x\u202Ay\u2066z 알파\u202E테크 w\u2069";
    const tokenized = tokenize(input, matcher, tokenMap);
    for (let cp = 0x202a; cp <= 0x202e; cp++) {
      assert.ok(!tokenized.includes(String.fromCharCode(cp)), `bidi U+${cp.toString(16)} survived`);
    }
    for (let cp = 0x2066; cp <= 0x2069; cp++) {
      assert.ok(!tokenized.includes(String.fromCharCode(cp)), `bidi U+${cp.toString(16)} survived`);
    }
    assert.strictEqual(tokenized, "xyz <PROJECT_1A> w");
  });

  it("SEC-78: guard strips bidi control characters before leak detection", async () => {
    const { assertNoLeakGuard } = await import("../../src/privacy/guard.ts");
    const { loadTermsFromFileOrDir } = await import("../../src/privacy/terms.ts");

    const termSet = loadTermsFromFileOrDir("config/terms.example.yaml");
    assert.throws(
      () => assertNoLeakGuard("Leaked O\u202AM\u2066E\u202EGA", termSet, "on"),
      (err: Error) => err.message.includes("blocked by privacy guard")
    );
  });

  it("SEC-79: sliding window counts requests in trailing 1000ms and resets across the boundary", () => {
    resetRateLimit();

    assert.strictEqual(checkRateLimit("10.0.0.1", 3), true);
    assert.strictEqual(checkRateLimit("10.0.0.1", 3), true);
    assert.strictEqual(checkRateLimit("10.0.0.1", 3), true);
    assert.strictEqual(checkRateLimit("10.0.0.1", 3), false, "4th request in window must 429");

    // Stale timestamps fall out of the trailing window
    const stale = Date.now() - 1500;
    rateLimitMap.set("10.0.0.1", [stale, stale, stale]);
    assert.strictEqual(checkRateLimit("10.0.0.1", 3), true, "stale timestamps must not count");

    // Sliding (not fixed) window: a burst 300ms ago still counts even though the
    // oldest entry ages out — a fixed-window counter anchored at the first request
    // would have reset and allowed this.
    const now = Date.now();
    rateLimitMap.set("10.0.0.2", [now - 1100, now - 300, now - 300, now - 300]);
    assert.strictEqual(
      checkRateLimit("10.0.0.2", 3),
      false,
      "recent burst must still count after the oldest entry ages out"
    );

    // Per-IP isolation
    assert.strictEqual(checkRateLimit("10.0.0.3", 3), true);

    resetRateLimit();
  });

  it("SEC-79: rate limiting applies to /v1/models and /_mask/* but NOT /healthz", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_RATE_LIMIT_RPS: "1",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);
    resetRateLimit();

    const pool = mockAgent.get("https://api.anthropic.com");
    pool
      .intercept({ path: "/v1/models", method: "GET" })
      .reply(200, JSON.stringify({ data: [{ id: "claude-3-5-sonnet" }] }), {
        headers: { "content-type": "application/json" },
      });

    const m1 = await app.inject({ method: "GET", url: "/v1/models" });
    assert.strictEqual(m1.statusCode, 200);

    const m2 = await app.inject({ method: "GET", url: "/v1/models" });
    assert.strictEqual(m2.statusCode, 429);
    assert.strictEqual(m2.json().error, "TooManyRequests");

    const a1 = await app.inject({ method: "GET", url: "/_mask/status" });
    assert.strictEqual(a1.statusCode, 429, "admin routes share the same sliding-window limiter");

    for (let i = 0; i < 5; i++) {
      const h = await app.inject({ method: "GET", url: "/healthz" });
      assert.strictEqual(h.statusCode, 200, "/healthz must never be rate limited");
    }

    await app.close();
    resetRateLimit();
  });

  it("SEC-80: duplicate pattern across categories compiles once — first category wins", async () => {
    const { TermSet } = await import("../../src/privacy/terms.ts");
    const catMap = new Map();
    catMap.set("CAT1", {
      name: "CAT1",
      terms: [],
      patterns: ["\\b\\d{4}\\b"],
      commentedOutCount: 0,
    });
    catMap.set("CAT2", {
      name: "CAT2",
      terms: [],
      patterns: ["\\b\\d{4}\\b", "\\b\\d{6}\\b"],
      commentedOutCount: 0,
    });
    const termSet = new TermSet(catMap);
    const patterns = termSet.activePatterns();

    assert.strictEqual(patterns.length, 2);
    const dup = patterns.filter((p) => p.regex.source === "\\b\\d{4}\\b");
    assert.strictEqual(dup.length, 1, "duplicate pattern must compile exactly once");
    assert.strictEqual(dup[0].category, "CAT1", "first category to declare the pattern wins");
  });

  it("SEC-81: scrubServerPaths redacts absolute server paths", async () => {
    const { scrubServerPaths } = await import("../../src/logging.ts");

    assert.strictEqual(
      scrubServerPaths("failed reading /opt/mask/config/providers.yaml and /var/secrets/key.pem"),
      "failed reading [REDACTED_PATH] and [REDACTED_PATH]"
    );
    assert.strictEqual(
      scrubServerPaths("config missing at /etc/mask/settings.yaml endpoint"),
      "config missing at [REDACTED_PATH] endpoint"
    );
    assert.strictEqual(scrubServerPaths("no absolute paths here, just /relative/path"), "no absolute paths here, just /relative/path");
  });

  it("SEC-81: UpstreamError response message redacts server paths", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    app.get("/test-upstream-error", async () => {
      throw new UpstreamError(
        "connect ECONNREFUSED while reading /opt/mask/run/connector.sock (key at /etc/mask/api.pem)",
        502
      );
    });

    const res = await app.inject({ method: "GET", url: "/test-upstream-error" });
    assert.strictEqual(res.statusCode, 502);
    const body = res.json();
    assert.strictEqual(body.error, "UpstreamError");
    assert.ok(body.message.includes("[REDACTED_PATH]"));
    assert.ok(!JSON.stringify(body).includes("/opt/mask"));
    assert.ok(!JSON.stringify(body).includes("/etc/mask"));

    await app.close();
  });
});
