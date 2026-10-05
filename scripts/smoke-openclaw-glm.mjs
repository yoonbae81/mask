#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";

const openclawDir = process.env.OPENCLAW_CONFIG_DIR ?? join(homedir(), ".openclaw");
const config = JSON5.parse(await readFile(join(openclawDir, "openclaw.providers.json5"), "utf8"));
const providers = config.providers ?? {};
const maskedGlmModels = Object.entries(providers).flatMap(([providerName, provider]) =>
  (provider.models ?? [])
    .filter((model) => /^glm-/i.test(model.id) && /\(mask(?:ed)?\)/i.test(model.name))
    .map((model) => ({ providerName, provider, model }))
);

if (maskedGlmModels.length === 0) {
  throw new Error("No masked GLM models found in OpenClaw provider configuration");
}

async function readEnv(name, path) {
  try {
    const contents = await readFile(path, "utf8");
    const line = contents.split(/\r?\n/).find((entry) =>
      new RegExp(`^(?:export\\s+)?${name}=`).test(entry.trim())
    );
    if (!line) return undefined;
    return line.trim().replace(/^(?:export\s+)?[^=]+=/, "").trim().replace(/^(['"])(.*)\1$/, "$2");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

let failed = false;
for (const { providerName, provider, model } of maskedGlmModels) {
  const label = `${providerName}/${model.id}`;
  try {
    const baseUrl = new URL(provider.baseUrl);
    if (
      baseUrl.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(baseUrl.hostname) ||
      !(baseUrl.pathname.includes("/mask/") || baseUrl.port === "8787")
    ) {
      throw new Error("baseUrl does not point to the local Mask service");
    }

    const keyName = provider.apiKey?.id;
    if (!keyName) throw new Error("OpenClaw API key environment variable is not configured");
    const key =
      process.env[keyName] ??
      (await readEnv(keyName, join(openclawDir, ".env"))) ??
      (await readEnv(keyName, "/opt/mask/.env"));
    if (!key) throw new Error(`${keyName} is unavailable`);

    const url = new URL(baseUrl.toString().replace(/\/$/, "") + "/chat/completions");
    const started = performance.now();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: "Reply with exactly OK." }],
        max_tokens: 256,
        stream: false,
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    const choice = result.choices?.[0];
    if (result.model !== model.id || !choice?.message?.content?.trim()) {
      throw new Error("response model or assistant content is missing");
    }
    console.log(`PASS ${label}: HTTP ${response.status}, ${Math.round(performance.now() - started)} ms`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${label}: ${error.message}`);
  }
}
if (failed) process.exitCode = 1;
