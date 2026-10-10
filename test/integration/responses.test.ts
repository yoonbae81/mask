import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { buildApp } from "../../src/app.ts";
import { parseSettings } from "../../src/settings.ts";

// Responses dialect native passthrough integration tests
//  - POST /v1/responses forwards to the provider responses endpoint with the
//    model name unchanged, request-side masking applied, OAuth auth forwarded
//  - response tokens are restored to the original terms
//  - GET /v1/models preserves the client_version query for the catalog
//  - unknown provider prefixes fail closed with 404 (no upstream call)
describe("Responses dialect passthrough", () => {
  let originalDispatcher: any;
  let mockAgent: MockAgent;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const tmpProviders = "config/providers.responses.test.yaml";

  before(async () => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    fs.writeFileSync(
      tmpProviders,
      `
active: openai-codex
fallback: []
providers:
  openai-codex:
    type: api
    auth: passthrough
    forward_headers: [authorization, chatgpt-account-id]
    paths:
      responses: /responses
    endpoints:
      responses: https://chatgpt.backend.test
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

  it("POST non-stream: masks terms, keeps the model name, forwards OAuth auth, restores response tokens", async () => {
    let seenBody = "";
    let seenAuth: unknown;
    const pool = mockAgent.get("https://chatgpt.backend.test");
    pool.intercept({ path: "/responses", method: "POST" }).reply(
      200,
      (opts: any) => {
        seenBody = String(opts.body);
        seenAuth = opts.headers?.authorization;
        return {
          id: "resp_1",
          object: "response",
          status: "completed",
          model: "gpt-6.1-sol",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "confirmed: <INTERNAL_3A>" }],
            },
          ],
        };
      },
      { headers: { "content-type": "application/json" } }
    );

    const res = await app.inject({
      method: "POST",
      url: "/openai-codex/v1/responses",
      headers: { authorization: "Bearer oauth-token" },
      payload: {
        model: "gpt-6.1-sol",
        instructions: "terse",
        input: [
          { role: "user", content: [{ type: "input_text", text: "ALPHATECH review please" }] },
        ],
        stream: false,
      },
    });

    assert.strictEqual(res.statusCode, 200);
    // model name is forwarded unchanged - mask never looks at it
    assert.ok(seenBody.includes("gpt-6.1-sol"));
    // sensitive terms are replaced with tokens before leaving
    assert.ok(!seenBody.includes("ALPHATECH"));
    assert.ok(seenBody.includes("INTERNAL_3A"));
    // passthrough - the client OAuth credential is forwarded as-is
    assert.equal(seenAuth, "Bearer oauth-token");
    // response tokens are restored to the original terms
    const out = res.json();
    const text = out.output[0].content[0].text;
    assert.strictEqual(text, "confirmed: ALPHATECH");
  });

  it("POST stream: restores tokens in Responses SSE events", async () => {
    const pool = mockAgent.get("https://chatgpt.backend.test");
    const sse = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"confirmed: <INTERNAL_3A>"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      "",
    ].join("\n");
    pool
      .intercept({ path: "/responses", method: "POST" })
      .reply(200, sse, { headers: { "content-type": "text/event-stream" } });

    const res = await app.inject({
      method: "POST",
      url: "/openai-codex/v1/responses",
      headers: { authorization: "Bearer oauth-token" },
      payload: {
        model: "gpt-6.1-sol",
        input: [{ role: "user", content: [{ type: "input_text", text: "ALPHATECH" }] }],
        stream: true,
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes("ALPHATECH"));
    assert.ok(!res.body.includes("INTERNAL_3A"));
  });

  it("GET models: forwards the client_version query to the provider catalog", async () => {
    let seenPath = "";
    const pool = mockAgent.get("https://chatgpt.backend.test");
    pool
      .intercept({ path: /^\/models/, method: "GET" })
      .reply(
        200,
        (opts: any) => {
          seenPath = String(opts.path ?? "");
          return { object: "list", models: [{ slug: "gpt-6.1-sol" }, { slug: "gpt-5.5" }] };
        },
        { headers: { "content-type": "application/json" } }
      );

    const res = await app.inject({
      method: "GET",
      url: "/openai-codex/v1/models?client_version=99.0.0",
      headers: { authorization: "Bearer oauth-token" },
    });

    assert.strictEqual(res.statusCode, 200);
    // client_version query is preserved
    assert.ok(seenPath.includes("client_version=99.0.0"));
    const slugs = (res.json().models ?? []).map((m: any) => m.slug);
    assert.deepEqual(slugs.sort(), ["gpt-5.5", "gpt-6.1-sol"]);
  });

  it("unknown provider prefix: 404 without upstream call", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/nope/v1/responses",
      headers: { authorization: "Bearer x" },
      payload: { model: "gpt-6.1-sol", input: [] },
    });
    assert.strictEqual(res.statusCode, 404);
  });
});
