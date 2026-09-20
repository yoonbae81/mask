import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { buildApp } from "../../src/app.ts";
import { parseSettings } from "../../src/settings.ts";

describe("Fallback chain integration", () => {
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

  it("falls back to secondary provider on HTTP 429 and adds X-Mask-Provider-Used header", async () => {
    const tmpProviders = "config/providers.fallback.test.yaml";
    fs.writeFileSync(
      tmpProviders,
      `
active: primary
fallback: [backup]
providers:
  primary:
    type: api
    auth: passthrough
    endpoints:
      anthropic: https://api.primary.com
  backup:
    type: api
    auth: passthrough
    endpoints:
      anthropic: https://api.backup.com
`
    );

    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: tmpProviders,
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    // Primary returns 429 Rate Limit
    const primaryPool = mockAgent.get("https://api.primary.com");
    primaryPool
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(429, { error: "Rate limit exceeded" }, {
        headers: { "content-type": "application/json" },
      });

    // Backup returns 200 OK
    const backupPool = mockAgent.get("https://api.backup.com");
    backupPool
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(200, {
        id: "backup_msg",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "성공: <INTERNAL_1A>" }],
      }, {
        headers: { "content-type": "application/json" },
      });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "알파테크 안내" }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    // Header indicates backup provider was used
    assert.strictEqual(res.headers["x-mask-provider-used"], "backup");

    // Output is detokenized
    assert.strictEqual(res.json().content[0].text, "성공: 알파테크");

    await app.close();
    fs.unlinkSync(tmpProviders);
  });

  it("falls back to secondary provider when non-streaming 400 error body contains quota error", async () => {
    const tmpProviders = "config/providers.fallback-body.test.yaml";
    fs.writeFileSync(
      tmpProviders,
      `
active: primary
fallback: [backup]
providers:
  primary:
    type: api
    auth: passthrough
    endpoints:
      anthropic: https://api.primary.com
  backup:
    type: api
    auth: passthrough
    endpoints:
      anthropic: https://api.backup.com
`
    );

    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: tmpProviders,
    }, { checkFilesExist: true });

    const app = await buildApp(settings);

    // Primary returns 400 Bad Request with "insufficient_quota" in body
    const primaryPool = mockAgent.get("https://api.primary.com");
    primaryPool
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(400, { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota" } }, {
        headers: { "content-type": "application/json" },
      });

    // Backup returns 200 OK
    const backupPool = mockAgent.get("https://api.backup.com");
    backupPool
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(200, {
        id: "backup_msg_2",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "백업 응답: <INTERNAL_1A>" }],
      }, {
        headers: { "content-type": "application/json" },
      });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "알파테크 조회" }],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["x-mask-provider-used"], "backup");
    assert.strictEqual(res.json().content[0].text, "백업 응답: 알파테크");

    await app.close();
    fs.unlinkSync(tmpProviders);
  });
});
