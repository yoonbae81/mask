import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { buildApp } from "../../src/app.ts";
import { parseSettings } from "../../src/settings.ts";

describe("Security: no-leak tests", () => {
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

  it("outbound request body to Anthropic contains NO active sensitive terms", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    let capturedOutboundBody = "";
    let capturedHeaders: Record<string, any> = {};

    const pool = mockAgent.get("https://api.anthropic.com");
    pool
      .intercept({
        path: "/v1/messages",
        method: "POST",
      })
      .reply(200, (req) => {
        capturedOutboundBody = req.body as string;
        capturedHeaders = req.headers as any;
        return {
          id: "msg_123",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "답변: <INTERNAL_1A> 및 <PROJECT_1A> 확인했습니다." }],
        };
      }, {
        headers: { "content-type": "application/json" },
      });

    const payload = JSON.parse(
      fs.readFileSync("test/fixtures/anthropic-messages.json", "utf-8")
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "user-anthropic-key",
        "anthropic-version": "2023-06-01",
      },
      payload,
    });

    assert.strictEqual(res.statusCode, 200);

    // Assert: none of the active terms exist in the intercepted outbound body!
    const activeTerms = app.termSet.activeTerms();
    assert.ok(activeTerms.length > 0);

    for (const term of activeTerms) {
      assert.ok(
        !capturedOutboundBody.includes(term),
        `LEAK DETECTED: Sensitive term '${term}' was found in outbound request body!`
      );
    }

    // Assert: tokens were used
    assert.ok(capturedOutboundBody.includes("<INTERNAL_1A>"));
    assert.ok(capturedOutboundBody.includes("<PROJECT_1A>"));
    assert.ok(capturedOutboundBody.includes("<CUSTOMER_1A>"));

    // Assert: response is fully detokenized back to original terms for client
    const clientJson = res.json();
    assert.strictEqual(
      clientJson.content[0].text,
      "답변: 알파테크 및 Project 오로라 확인했습니다."
    );

    // Assert: passthrough forward_headers preserved
    assert.strictEqual(capturedHeaders["x-api-key"], "user-anthropic-key");

    await app.close();
  });

  it("tool_use input and tool_result content contain NO leaked terms", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    let capturedBody = "";
    const pool = mockAgent.get("https://api.anthropic.com");
    pool
      .intercept({
        path: "/v1/messages",
        method: "POST",
      })
      .reply(200, (req) => {
        capturedBody = req.body as string;
        return {
          id: "msg_456",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "확인 완료" }],
        };
      }, {
        headers: { "content-type": "application/json" },
      });

    const payload = JSON.parse(
      fs.readFileSync("test/fixtures/anthropic-tool-use.json", "utf-8")
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "user-key",
      },
      payload,
    });

    assert.strictEqual(res.statusCode, 200);

    for (const term of app.termSet.activeTerms()) {
      assert.ok(!capturedBody.includes(term), `LEAK IN TOOL USE: '${term}' found!`);
    }

    await app.close();
  });

  it("OpenAI tool_calls arguments JSON string contains NO leaked terms", async () => {
    // Test with remote active (openai dialect)
    const tmpProviders = "config/providers.remote.test.yaml";
    fs.writeFileSync(
      tmpProviders,
      `
active: remote
fallback: []
providers:
  remote:
    type: api
    auth: api_key
    api_key_env: TEST_REMOTE_KEY
    endpoints:
      openai: https://api.remote-llm.test/v4
`
    );

    process.env.TEST_REMOTE_KEY = "mock-remote-key-1234";

    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: tmpProviders,
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    let capturedBody = "";
    let capturedHeaders: Record<string, any> = {};

    const pool = mockAgent.get("https://api.remote-llm.test");
    pool
      .intercept({
        path: "/v4/v1/chat/completions",
        method: "POST",
      })
      .reply(200, (req) => {
        capturedBody = req.body as string;
        capturedHeaders = req.headers as any;
        return {
          id: "chatcmpl-123",
          choices: [
            {
              message: {
                role: "assistant",
                content: "<INTERNAL_1A> 관련 내용입니다.",
              },
            },
          ],
        };
      }, {
        headers: { "content-type": "application/json" },
      });

    const payload = JSON.parse(
      fs.readFileSync("test/fixtures/openai-chat.json", "utf-8")
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer stolen-client-token",
        "x-api-key": "stolen-api-key",
      },
      payload,
    });

    assert.strictEqual(res.statusCode, 200);

    for (const term of app.termSet.activeTerms()) {
      assert.ok(!capturedBody.includes(term), `LEAK IN OPENAI CHAT: '${term}' found!`);
    }

    // Assert: client token was REMOVED and remote key was injected
    assert.strictEqual(capturedHeaders["x-api-key"], undefined);
    assert.strictEqual(capturedHeaders["authorization"], "Bearer mock-remote-key-1234");

    // Assert: detokenized in client response
    assert.strictEqual(
      res.json().choices[0].message.content,
      "알파테크 관련 내용입니다."
    );

    await app.close();
    fs.unlinkSync(tmpProviders);
    delete process.env.TEST_REMOTE_KEY;
  });

  it("SSE streaming response restores token fragmented across deltas", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const sseBody = [
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"답변: <INT"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ERNAL_1A> 및 <PROJ"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ECT_1A> 확인했습니다."}}',
      "data: [DONE]",
    ]
      .map((l) => l + "\n\n")
      .join("");

    const pool = mockAgent.get("https://api.anthropic.com");
    pool
      .intercept({
        path: "/v1/messages",
        method: "POST",
      })
      .reply(200, sseBody, {
        headers: { "content-type": "text/event-stream" },
      });

    const payload = JSON.parse(
      fs.readFileSync("test/fixtures/anthropic-messages.json", "utf-8")
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json" },
      payload,
    });

    assert.strictEqual(res.statusCode, 200);

    const dataPayloads = res.body
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6));
    assert.ok(dataPayloads.includes("[DONE]"));

    const mergedText = dataPayloads
      .filter((p) => p !== "[DONE]")
      .map((p) => {
        const parsed = JSON.parse(p) as {
          delta: { text: string };
        };
        return parsed.delta.text;
      })
      .join("");

    assert.strictEqual(mergedText, "답변: 알파테크 및 Project 오로라 확인했습니다.");
    assert.ok(!mergedText.includes("_1A>"));
    assert.ok(!mergedText.includes("<INTERNAL"));
    assert.ok(!mergedText.includes("<PROJECT"));

    await app.close();
  });

  it("commented-out terms are NOT masked and pass through as original", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    let capturedBody = "";
    const pool = mockAgent.get("https://api.anthropic.com");
    pool
      .intercept({
        path: "/v1/messages",
        method: "POST",
      })
      .reply(200, (req) => {
        capturedBody = req.body as string;
        return {
          id: "msg_999",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "OK" }],
        };
      }, {
        headers: { "content-type": "application/json" },
      });

    // '프로젝트 타이탄' is commented out in terms.example.yaml
    const payload = {
      model: "claude-3-5-sonnet",
      messages: [
        {
          role: "user",
          content: "프로젝트 타이탄 진행상황 알려줘",
        },
      ],
    };

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload,
    });

    assert.strictEqual(res.statusCode, 200);
    // Should be kept unmasked in outbound request!
    assert.ok(capturedBody.includes("프로젝트 타이탄"));

    await app.close();
  });

  it("activity feed contains NO raw terms", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    const res = await app.inject({
      method: "GET",
      url: "/_mask/activity",
    });

    assert.strictEqual(res.statusCode, 200);
    const feedString = JSON.stringify(res.json());

    for (const term of app.termSet.activeTerms()) {
      assert.ok(
        !feedString.includes(term),
        `Raw term '${term}' found in activity feed!`
      );
    }

    await app.close();
  });

  it("outbound masked payload contains NO zero-width (\\uFEFF/\\u180E/\\u00AD) or bidi (\\u202A-\\u202E/\\u2066-\\u2069) characters", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    let capturedOutboundBody = "";
    const pool = mockAgent.get("https://api.anthropic.com");
    pool
      .intercept({
        path: "/v1/messages",
        method: "POST",
      })
      .reply(200, (req) => {
        capturedOutboundBody = req.body as string;
        return {
          id: "msg_unicode",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "확인: <INTERNAL_1A> <CUSTOMER_1A>" }],
        };
      }, {
        headers: { "content-type": "application/json" },
      });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-3-5-sonnet",
        messages: [
          {
            role: "user",
            content: "보고서 \uFEFF알파\u180E테크\u00AD 검토 \u202AOMEGA\u2066와\u2069 협의 \u202E완료",
          },
        ],
      },
    });

    assert.strictEqual(res.statusCode, 200);

    for (const ch of ["\uFEFF", "\u180E", "\u00AD"]) {
      assert.ok(!capturedOutboundBody.includes(ch), `zero-width char U+${ch.charCodeAt(0).toString(16)} survived into outbound payload`);
    }
    for (let cp = 0x202a; cp <= 0x202e; cp++) {
      assert.ok(!capturedOutboundBody.includes(String.fromCharCode(cp)), `bidi char U+${cp.toString(16)} survived into outbound payload`);
    }
    for (let cp = 0x2066; cp <= 0x2069; cp++) {
      assert.ok(!capturedOutboundBody.includes(String.fromCharCode(cp)), `bidi char U+${cp.toString(16)} survived into outbound payload`);
    }

    assert.ok(capturedOutboundBody.includes("<INTERNAL_1A>"));
    assert.ok(capturedOutboundBody.includes("<CUSTOMER_1A>"));
    assert.strictEqual(res.json().content[0].text, "확인: 알파테크 OMEGA");

    await app.close();
  });
});
