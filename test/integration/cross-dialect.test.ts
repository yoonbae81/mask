import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { buildApp } from "../../src/app.ts";
import { parseSettings } from "../../src/settings.ts";

const sse = (data: string): string => `data: ${data}\n\n`;

describe("Cross-dialect fallback integration", () => {
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

  it("anthropic inbound falls back to openai provider with translation", async () => {
    const tmpProviders = "config/providers.xd1.test.yaml";
    fs.writeFileSync(
      tmpProviders,
      `
active: claude
fallback: [remote]
providers:
  claude:
    type: api
    auth: passthrough
    endpoints:
      anthropic: https://api.claude-xd.com
  remote:
    type: api
    auth: passthrough
    endpoints:
      openai: https://api.remote-xd.com
`
    );

    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: tmpProviders,
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    mockAgent
      .get("https://api.claude-xd.com")
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(429, { error: "rate limited" }, { headers: { "content-type": "application/json" } });

    let capturedOpenaiBody = "";
    mockAgent
      .get("https://api.remote-xd.com")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, () => {
        return {
          id: "z1",
          model: "remote-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "답변: <INTERNAL_1A> 확인" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        };
      }, { headers: { "content-type": "application/json" } });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-3-5-sonnet",
        max_tokens: 256,
        system: "너는 비서다",
        messages: [{ role: "user", content: "알파테크 문서를 요약해줘" }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["x-mask-provider-used"], "remote");

    // 클라이언트는 anthropic 형식 그대로 받는다 (토큰 복원됨)
    const clientBody = res.json();
    assert.strictEqual(clientBody.type, "message");
    assert.strictEqual(clientBody.role, "assistant");
    assert.strictEqual(clientBody.stop_reason, "end_turn");
    assert.strictEqual(clientBody.content[0].text, "답변: 알파테크 확인");
    assert.strictEqual(clientBody.model, "claude-3-5-sonnet");
    assert.deepStrictEqual(clientBody.usage, { input_tokens: 3, output_tokens: 4 });

    await app.close();
    fs.unlinkSync(tmpProviders);
  });

  it("openai inbound falls back to anthropic provider with translation and version header", async () => {
    const tmpProviders = "config/providers.xd2.test.yaml";
    fs.writeFileSync(
      tmpProviders,
      `
active: gpt
fallback: [claude]
providers:
  gpt:
    type: api
    auth: passthrough
    endpoints:
      openai: https://api.gpt-xd.com
  claude:
    type: api
    auth: passthrough
    endpoints:
      anthropic: https://api.claude-xd2.com
`
    );

    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: tmpProviders,
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    mockAgent
      .get("https://api.gpt-xd.com")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(429, { error: "quota" }, { headers: { "content-type": "application/json" } });

    let capturedAnthropicBody = "";
    let capturedHeaders: Record<string, unknown> = {};
    mockAgent
      .get("https://api.claude-xd2.com")
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(200, (req) => {
        capturedAnthropicBody = req.body as string;
        capturedHeaders = req.headers as Record<string, unknown>;
        return {
          id: "m1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "응답: <INTERNAL_1A>" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      }, { headers: { "content-type": "application/json" } });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "remote-model",
        messages: [{ role: "user", content: "알파테크 검토" }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["x-mask-provider-used"], "claude");

    // 업스트림(anthropic)으로 번역된 본문 검증
    const upstream = JSON.parse(capturedAnthropicBody);
    assert.strictEqual(upstream.max_tokens, 8192);
    assert.strictEqual(upstream.model, "remote-model");
    assert.ok(upstream.system === undefined);
    assert.deepStrictEqual(upstream.messages, [
      { role: "user", content: "<INTERNAL_1A> 검토" },
    ]);
    assert.strictEqual(capturedHeaders["anthropic-version"], "2023-06-01");

    // 클라이언트는 openai 형식 그대로 받는다
    const clientBody = res.json();
    assert.strictEqual(clientBody.object, "chat.completion");
    assert.strictEqual(clientBody.choices[0].message.content, "응답: 알파테크");
    assert.strictEqual(clientBody.choices[0].finish_reason, "stop");
    assert.strictEqual(clientBody.model, "remote-model");

    await app.close();
    fs.unlinkSync(tmpProviders);
  });

  it("applies model_map on translated requests and echoes client model in response", async () => {
    const tmpProviders = "config/providers.xd3.test.yaml";
    fs.writeFileSync(
      tmpProviders,
      `
active: remote
fallback: []
providers:
  remote:
    type: api
    auth: passthrough
    model_map: {"claude-3-5-sonnet": "remote-model"}
    endpoints:
      openai: https://api.remote-xd.com
`
    );

    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: tmpProviders,
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    let capturedBody = "";
    mockAgent
      .get("https://api.remote-xd.com")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, (req) => {
        capturedBody = req.body as string;
        return {
          id: "r1",
          model: "remote-model",
          choices: [{ index: 0, message: { role: "assistant", content: "완료" }, finish_reason: "stop" }],
        };
      }, { headers: { "content-type": "application/json" } });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-3-5-sonnet",
        max_tokens: 64,
        messages: [{ role: "user", content: "안녕" }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const upstream = JSON.parse(capturedBody);
    assert.strictEqual(upstream.model, "remote-model");
    assert.strictEqual(res.json().model, "claude-3-5-sonnet");

    await app.close();
    fs.unlinkSync(tmpProviders);
  });

  it("translates openai SSE fallback into anthropic event stream with restored tokens", async () => {
    const tmpProviders = "config/providers.xd4.test.yaml";
    fs.writeFileSync(
      tmpProviders,
      `
active: claude
fallback: [remote]
providers:
  claude:
    type: api
    auth: passthrough
    endpoints:
      anthropic: https://api.claude-xd4.com
  remote:
    type: api
    auth: passthrough
    endpoints:
      openai: https://api.remote-xd4.com
`
    );

    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: tmpProviders,
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    mockAgent
      .get("https://api.claude-xd4.com")
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(429, { error: "rate limited" }, { headers: { "content-type": "application/json" } });

    const openaiSseBody =
      sse('{"id":"c1","model":"remote-model","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}') +
      sse('{"id":"c1","choices":[{"index":0,"delta":{"content":"답변: <INTERNAL"}}]}') +
      sse('{"id":"c1","choices":[{"index":0,"delta":{"content":"_1A> 확인"}}]}') +
      sse('{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}') +
      sse('{"id":"c1","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":5}}') +
      sse("[DONE]");

    mockAgent
      .get("https://api.remote-xd4.com")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, openaiSseBody, { headers: { "content-type": "text/event-stream" } });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-3-5-sonnet",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "알파테크 확인해줘" }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.body;
    assert.ok(body.includes("message_start"));
    assert.ok(body.includes("content_block_delta"));
    assert.ok(body.includes("message_stop"));
    assert.ok(!body.includes("[DONE]"));
    assert.ok(!body.includes("INTERNAL_1A"));

    const text = body
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter((l) => l !== "[DONE]")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === "content_block_delta")
      .map((e) => ((e.delta as Record<string, unknown>).text as string))
      .join("");
    assert.strictEqual(text, "답변: 알파테크 확인");

    await app.close();
    fs.unlinkSync(tmpProviders);
  });

  it("translates anthropic SSE fallback into openai chunk stream", async () => {
    const tmpProviders = "config/providers.xd5.test.yaml";
    fs.writeFileSync(
      tmpProviders,
      `
active: gpt
fallback: [claude]
providers:
  gpt:
    type: api
    auth: passthrough
    endpoints:
      openai: https://api.gpt-xd5.com
  claude:
    type: api
    auth: passthrough
    endpoints:
      anthropic: https://api.claude-xd5.com
`
    );

    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: tmpProviders,
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    mockAgent
      .get("https://api.gpt-xd5.com")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(429, { error: "quota" }, { headers: { "content-type": "application/json" } });

    const anthropicSseBody =
      sse('{"type":"message_start","message":{"id":"m9","role":"assistant","model":"claude-x","content":[]}}') +
      sse('{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}') +
      sse('{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"응답: <INTERNAL_1A>"}}') +
      sse('{"type":"content_block_stop","index":0}') +
      sse('{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1,"output_tokens":2}}') +
      sse('{"type":"message_stop"}');

    mockAgent
      .get("https://api.claude-xd5.com")
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(200, anthropicSseBody, { headers: { "content-type": "text/event-stream" } });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "remote-model",
        stream: true,
        messages: [{ role: "user", content: "알파테크 요약" }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.body;
    assert.ok(body.endsWith("data: [DONE]\n\n"));
    assert.ok(!body.includes("INTERNAL_1A"));

    const merged = body
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter((l) => l !== "[DONE]")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((c) => Array.isArray(c.choices) && c.choices.length > 0)
      .map((c) => (c.choices as Record<string, unknown>[])[0].delta)
      .filter((d) => typeof (d as Record<string, unknown>).content === "string")
      .map((d) => (d as Record<string, unknown>).content as string)
      .join("");
    assert.strictEqual(merged, "응답: 알파테크");

    await app.close();
    fs.unlinkSync(tmpProviders);
  });

  it("keeps same-dialect fallback outbound body untranslated", async () => {
    const tmpProviders = "config/providers.xd6.test.yaml";
    fs.writeFileSync(
      tmpProviders,
      `
active: claude
fallback: [claude2]
providers:
  claude:
    type: api
    auth: passthrough
    endpoints:
      anthropic: https://api.c1-xd.com
  claude2:
    type: api
    auth: passthrough
    endpoints:
      anthropic: https://api.c2-xd.com
`
    );

    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: tmpProviders,
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    mockAgent
      .get("https://api.c1-xd.com")
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(429, { error: "rate limited" }, { headers: { "content-type": "application/json" } });

    let capturedBody = "";
    mockAgent
      .get("https://api.c2-xd.com")
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(200, (req) => {
        capturedBody = req.body as string;
        return {
          id: "m2",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        };
      }, { headers: { "content-type": "application/json" } });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-3-5-sonnet",
        max_tokens: 32,
        system: "시스템 지침",
        messages: [{ role: "user", content: "알파테크" }],
      },
    });

    assert.strictEqual(res.statusCode, 200);

    // 동일 dialect 폴백은 번역 없이 마스킹된 원본 구조 그대로 간다
    assert.deepStrictEqual(JSON.parse(capturedBody), {
      model: "claude-3-5-sonnet",
      max_tokens: 32,
      system: "시스템 지침",
      messages: [{ role: "user", content: "<INTERNAL_1A>" }],
    });

    await app.close();
    fs.unlinkSync(tmpProviders);
  });
});
