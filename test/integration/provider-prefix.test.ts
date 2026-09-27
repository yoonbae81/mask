import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { buildApp } from "../../src/app.ts";
import { parseSettings } from "../../src/settings.ts";

// Provider 경로 프리픽스(/:provider/v1/...) 통합 테스트
//  - 프리픽스로 upstream provider 를 선택한다 (active 무관)
//  - 모델명은 치환되지 않고 그대로 전달된다
//  - 알 수 없는 provider 프리픽스는 404 (upstream 호출 없음)
//  - 프리픽스 없는 표준 경로는 기존대로 active provider 를 따른다
describe("Provider-prefixed routes", () => {
  let originalDispatcher: any;
  let mockAgent: MockAgent;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const tmpProviders = "config/providers.prefix.test.yaml";

  before(async () => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    // auth: api_key provider — 테스트용 주입 키 (프로덕션에선 mask .env 가 갖는다)
    process.env.ZAI_API_KEY = "test-key-zai";

    fs.writeFileSync(
      tmpProviders,
      `
active: anthropic
fallback: []
providers:
  anthropic:
    type: api
    auth: passthrough
    forward_headers: [authorization, x-api-key]
    endpoints:
      anthropic: https://api.anthropic.test
  zai:
    type: api
    auth: api_key
    api_key_env: ZAI_API_KEY
    paths:
      openai: /chat/completions
    endpoints:
      openai: https://api.zai.test
`
    );

    const settings = parseSettings(
      {
        MASK_TERMS_FILE: "config/terms.example.yaml",
        MASK_PROVIDERS_FILE: tmpProviders,
      },
      { checkFilesExist: true }
    );
    app = await buildApp(settings);
  });

  after(async () => {
    await app.close();
    setGlobalDispatcher(originalDispatcher);
    fs.unlinkSync(tmpProviders);
  });

  it("routes /zai/v1/chat/completions to the zai provider with the model name unchanged", async () => {
    let seenModel: unknown;
    let seenBody = "";
    let seenAuth: unknown;
    const pool = mockAgent.get("https://api.zai.test");
    pool.intercept({ path: "/chat/completions", method: "POST" }).reply(
      200,
      (opts: any) => {
        seenBody = String(opts.body);
        seenModel = JSON.parse(seenBody).model;
        seenAuth = opts.headers?.authorization;
        return {
          id: "chatcmpl-1",
          object: "chat.completion",
          model: "glm-5.3-flash",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "정리: <INTERNAL_1A>" },
            },
          ],
        };
      },
      { headers: { "content-type": "application/json" } }
    );

    const res = await app.inject({
      method: "POST",
      url: "/zai/v1/chat/completions",
      headers: { authorization: "Bearer sk-client-key" },
      payload: {
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "알파테크 검토 부탁한다" }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    // 모델명은 클라이언트가 보낸 그대로
    assert.strictEqual(seenModel, "glm-5.3-flash");
    // 민감 용어는 토큰으로 치환되어 출발
    assert.ok(!seenBody.includes("알파테크"));
    assert.ok(seenBody.includes("<INTERNAL_1A>"));
    // auth: api_key provider — 클라이언트 키는 제거되고 마스크의 키가 주입된다
    assert.equal(seenAuth, "Bearer test-key-zai");
    // 응답의 토큰은 원문으로 복원
    assert.strictEqual(
      res.json().choices[0].message.content,
      "정리: 알파테크"
    );
  });

  it("routes /anthropic/v1/messages to the anthropic provider with passthrough auth", async () => {
    let seenAuth: unknown;
    const pool = mockAgent.get("https://api.anthropic.test");
    pool.intercept({ path: "/v1/messages", method: "POST" }).reply(
      200,
      (opts: any) => {
        seenAuth = opts.headers?.["x-api-key"];
        return {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "확인: <INTERNAL_1A>" }],
        };
      },
      { headers: { "content-type": "application/json" } }
    );

    const res = await app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: { "x-api-key": "sk-ant-client" },
      payload: {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "알파테크 안내" }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    // passthrough — 클라이언트 자격증명이 그대로 전달된다
    assert.equal(seenAuth, "sk-ant-client");
    assert.strictEqual(res.json().content[0].text, "확인: 알파테크");
  });

  it("returns 404 for an unknown provider prefix without calling any upstream", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/nonexistent/v1/chat/completions",
      payload: {
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "테스트" }],
      },
    });

    assert.strictEqual(res.statusCode, 404);
    assert.match(res.json().message, /Unknown provider/);
  });

  it("keeps canonical /v1/chat/completions on the active provider, translating openai to anthropic", async () => {
    let seenBody = "";
    const pool = mockAgent.get("https://api.anthropic.test");
    pool.intercept({ path: "/v1/messages", method: "POST" }).reply(
      200,
      (opts: any) => {
        seenBody = String(opts.body);
        return {
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "번역 응답: <INTERNAL_1A>" }],
        };
      },
      { headers: { "content-type": "application/json" } }
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "알파테크 검토" }],
      },
    });

    // 프리픽스가 없으면 active(anthropic)가 openai 요청을 자동 번역해 받는다 — 기존 동작 유지
    // (응답도 openai 형식으로 되돌아온다)
    assert.strictEqual(res.statusCode, 200);
    assert.ok(seenBody.includes('"messages"'));
    assert.strictEqual(
      res.json().choices[0].message.content,
      "번역 응답: 알파테크"
    );
  });
});
