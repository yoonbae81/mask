#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { buildApp } from "../src/app.ts";
import { parseSettings } from "../src/settings.ts";

const openclawDir = process.env.OPENCLAW_CONFIG_DIR ?? join(homedir(), ".openclaw");
const config = JSON5.parse(await readFile(join(openclawDir, "openclaw.providers.json5"), "utf8"));
const models = Object.entries(config.providers ?? {}).flatMap(([providerName, provider]) =>
  (provider.models ?? [])
    .filter((model) => /^glm-/i.test(model.id) && /\(mask(?:ed)?\)/i.test(model.name))
    .map((model) => ({ providerName, modelId: model.id }))
);
assert.ok(models.length > 0, "No masked GLM models found in OpenClaw provider configuration");

const settings = parseSettings();
const originalDispatcher = getGlobalDispatcher();
const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);
let app;

try {
  app = await buildApp(settings);
  const categoryTerms = [...app.termSet.categories].map(([category, info]) => ({
    category,
    term: info.terms.map((item) => item.term).find((value) =>
      value.length >= 3 && value.length <= 60 && /^[A-Za-z가-힣][A-Za-z가-힣0-9 ]+$/.test(value)
    ),
  }));
  assert.ok(categoryTerms.length > 0, "No active production terms found");
  assert.ok(categoryTerms.every(({ term }) => term), "A category has no suitable active term");
  categoryTerms.push({ category: "PII_EMAIL_PATTERN", term: "mask-deploy-check@example.invalid" });

  for (const { providerName, modelId } of models) {
    const maskProviderName = providerName.replace(/-mask$/, "");
    const provider = app.providers.getProvider(maskProviderName);
    assert.ok(provider?.endpoints.openai, `No OpenAI upstream configured for ${maskProviderName}`);
    const endpoint = new URL(provider.endpoints.openai);
    const upstreamPath = endpoint.pathname.replace(/\/$/, "") +
      (provider.paths?.openai ?? "/v1/chat/completions");
    const pool = mockAgent.get(endpoint.origin);

    for (const { category, term } of categoryTerms) {
      let outbound;
      pool.intercept({ path: upstreamPath, method: "POST" }).reply(
        200,
        (options) => {
          outbound = JSON.parse(String(options.body));
          return {
            id: "mask-smoke",
            object: "chat.completion",
            model: modelId,
            choices: [{
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: outbound.messages[0].content },
            }],
          };
        },
        { headers: { "content-type": "application/json" } }
      );

      const result = await app.inject({
        method: "POST",
        url: `/${maskProviderName}/v1/chat/completions`,
        payload: {
          model: modelId,
          messages: [{ role: "user", content: term }],
          max_tokens: 16,
          stream: false,
        },
      });
      const label = `${modelId}/${category}`;
      assert.equal(result.statusCode, 200, `${label}: proxy returned HTTP ${result.statusCode}`);
      assert.equal(outbound?.model, modelId, `${label}: model was changed`);
      assert.ok(!JSON.stringify(outbound).includes(term), `${label}: raw term reached upstream`);
      assert.notEqual(outbound.messages[0].content, term, `${label}: term was not replaced`);
      assert.equal(result.json().choices[0].message.content, term, `${label}: response was not restored`);
    }
    console.log(`PASS ${providerName}/${modelId}: ${categoryTerms.length} masking cases passed`);
  }
} finally {
  if (app) await app.close();
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
}
