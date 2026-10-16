import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { buildApp } from "../../src/app.ts";
import { parseSettings } from "../../src/settings.ts";
import {
  MAX_BYPASS_MINUTES,
  resetBypassForTest,
} from "../../src/observability/bypass.ts";

describe("masking bypass window", () => {
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

  beforeEach(() => {
    resetBypassForTest();
  });

  const setupApp = async (extraEnv: Record<string, string> = {}) => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      ...extraEnv,
    }, { checkFilesExist: true });
    return await buildApp(settings);
  };

  it("POST /_mask/bypass enables the window; GET /_mask/status reports it", async () => {
    const app = await setupApp({ MASK_ADMIN_TOKEN: "test-admin-token-1" });
    const auth = { authorization: "Bearer test-admin-token-1" };

    const res = await app.inject({
      method: "POST",
      url: "/_mask/bypass",
      headers: auth,
      payload: { minutes: 60 },
    });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    assert.strictEqual(body.maskingBypassed, true);
    assert.ok(body.bypassUntil);
    assert.ok(body.remainingSeconds > 0 && body.remainingSeconds <= 3600);

    const status = await app.inject({ method: "GET", url: "/_mask/status", headers: auth });
    assert.strictEqual(status.statusCode, 200);
    assert.strictEqual(status.json().maskingBypassed, true);

    await app.close();
  });

  it("DELETE /_mask/bypass clears the window immediately", async () => {
    const app = await setupApp({ MASK_ADMIN_TOKEN: "test-admin-token-1" });
    const auth = { authorization: "Bearer test-admin-token-1" };

    await app.inject({
      method: "POST",
      url: "/_mask/bypass",
      headers: auth,
      payload: { minutes: 60 },
    });
    const res = await app.inject({ method: "DELETE", url: "/_mask/bypass", headers: auth });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), {
      maskingBypassed: false,
      bypassUntil: null,
      remainingSeconds: 0,
    });

    const status = await app.inject({ method: "GET", url: "/_mask/status", headers: auth });
    assert.strictEqual(status.json().maskingBypassed, false);

    await app.close();
  });

  it("rejects invalid minutes (0, non-integer, over cap) with 400", async () => {
    const app = await setupApp({ MASK_ADMIN_TOKEN: "test-admin-token-1" });
    const auth = { authorization: "Bearer test-admin-token-1" };

    for (const minutes of [0, -5, 1.5, MAX_BYPASS_MINUTES + 1]) {
      const res = await app.inject({
        method: "POST",
        url: "/_mask/bypass",
        headers: auth,
        payload: { minutes },
      });
      assert.strictEqual(res.statusCode, 400, `minutes=${minutes}`);
    }

    await app.close();
  });

  it("requires the admin token when MASK_ADMIN_TOKEN is set", async () => {
    const app = await setupApp({ MASK_ADMIN_TOKEN: "test-admin-token-1" });

    const noAuth = await app.inject({
      method: "POST",
      url: "/_mask/bypass",
      payload: { minutes: 10 },
    });
    assert.strictEqual(noAuth.statusCode, 401);

    const badAuth = await app.inject({
      method: "POST",
      url: "/_mask/bypass",
      headers: { authorization: "Bearer wrong-token-12345" },
      payload: { minutes: 10 },
    });
    assert.strictEqual(badAuth.statusCode, 401);

    await app.close();
  });

  it("forwards plaintext unmasked while bypass is active, masks again after expiry", async () => {
    const app = await setupApp({});
    const setupMock = (capture: { body: string }) => {
      mockAgent
        .get("https://api.anthropic.com")
        .intercept({ path: "/v1/messages", method: "POST" })
        .reply(200, (req) => {
          capture.body = req.body as string;
          return {
            id: "m1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
          };
        }, { headers: { "content-type": "application/json" } });
    };

    const send = () =>
      app.inject({
        method: "POST",
        url: "/v1/messages",
        payload: {
          model: "claude-3-5-sonnet",
          max_tokens: 64,
          messages: [{ role: "user", content: "알파테크 매출 보고서를 요약해줘" }],
        },
      });

    // 1) 기본(치환 on): 민감어는 토큰으로 치환되어 전송된다
    const whileMasking = { body: "" };
    setupMock(whileMasking);
    assert.strictEqual((await send()).statusCode, 200);
    assert.ok(!whileMasking.body.includes("알파테크"), "기본 상태에서는 원문 노출 없음");
    assert.ok(whileMasking.body.includes("<INTERNAL_"));

    // 2) bypass 활성: guard가 원래 평문을 502로 막지만, 우회 중에는 그대로 전송된다
    const res = await app.inject({
      method: "POST",
      url: "/_mask/bypass",
      payload: { minutes: 10 },
    });
    assert.strictEqual(res.statusCode, 200);

    const whileBypassed = { body: "" };
    setupMock(whileBypassed);
    assert.strictEqual((await send()).statusCode, 200);
    assert.ok(
      whileBypassed.body.includes("알파테크 매출 보고서를 요약해줘"),
      "우회 중에는 원문이 그대로 업스트림 전송"
    );

    // 3) 즉시 해제: 다시 치환된다
    await app.inject({ method: "DELETE", url: "/_mask/bypass" });
    const afterClear = { body: "" };
    setupMock(afterClear);
    assert.strictEqual((await send()).statusCode, 200);
    assert.ok(!afterClear.body.includes("알파테크"), "해제 후 원문 노출 없음");

    await app.close();
  });
});
