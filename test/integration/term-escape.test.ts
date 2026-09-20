import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { buildApp } from "../../src/app.ts";
import { parseSettings } from "../../src/settings.ts";

describe("Term escape bypass integration", () => {
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

  const setupApp = async (extraEnv: Record<string, string>) => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      ...extraEnv,
    }, { checkFilesExist: true });
    return await buildApp(settings);
  };

  it("sends the escaped term raw when MASK_TERM_ESCAPE=true", async () => {
    const app = await setupApp({ MASK_TERM_ESCAPE: "true" });

    let capturedBody = "";
    mockAgent
      .get("https://api.anthropic.com")
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(200, (req) => {
        capturedBody = req.body as string;
        return {
          id: "m1",
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
        max_tokens: 64,
        messages: [{ role: "user", content: "\\알파테크 관련 뉴스를 찾아줘" }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(
      capturedBody.includes("알파테크 관련 뉴스를 찾아줘"),
      "우회된 용어는 원문 그대로 업스트림 전송"
    );
    assert.ok(!capturedBody.includes("<INTERNAL_1A>"));
    assert.ok(!capturedBody.includes("\\알파테크"), "백슬래시는 제거된다");

    await app.close();
  });

  it("masks the term normally when MASK_TERM_ESCAPE is off (default)", async () => {
    const app = await setupApp({});

    let capturedBody = "";
    mockAgent
      .get("https://api.anthropic.com")
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
        max_tokens: 64,
        messages: [{ role: "user", content: "\\알파테크 관련 뉴스를 찾아줘" }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(capturedBody.includes("<INTERNAL_1A>"), "기본값에서는 정상 마스킹");
    assert.ok(capturedBody.includes("\\<INTERNAL_1A>"), "백슬래시는 원문에 유지");
    assert.ok(!capturedBody.includes("알파테크"));

    await app.close();
  });
});
