import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadProvidersFromFile } from "./registry.ts";
import { prepareOutboundHeaders } from "./auth.ts";
import { UpstreamError } from "../errors.ts";

describe("ProviderRegistry", () => {
  it("loads config/providers.example.yaml successfully", () => {
    const registry = loadProvidersFromFile("config/providers.example.yaml");
    assert.strictEqual(registry.active, "anthropic");
    assert.ok(registry.getProvider("anthropic"));
    assert.ok(registry.getProvider("openai"));
    assert.ok(registry.getProvider("custom_llm"));
  });

  it("resolves endpoint for dialect", () => {
    const registry = loadProvidersFromFile("config/providers.example.yaml");
    const res = registry.resolveProvider("anthropic");

    assert.strictEqual(res.providerName, "anthropic");
    assert.strictEqual(res.endpoint, "https://api.anthropic.com");
  });

  it("throws UpstreamError (502) when active provider lacks dialect endpoint", () => {
    const registry = loadProvidersFromFile("config/providers.example.yaml");
    // active provider is anthropic, which does not have openai endpoint in example.yaml
    assert.throws(
      () => registry.resolveProvider("openai"),
      (err) => err instanceof UpstreamError && err.statusCode === 502
    );
  });
});

describe("prepareOutboundHeaders", () => {
  it("passthrough forwards allowed client headers", () => {
    const registry = loadProvidersFromFile("config/providers.example.yaml");
    const anthropicConfig = registry.getProvider("anthropic")!;

    const headers = prepareOutboundHeaders(
      {
        "x-api-key": "client-anthropic-key",
        "anthropic-version": "2023-06-01",
        "user-agent": "client-cli/1.0",
      },
      anthropicConfig,
      "anthropic"
    );

    assert.strictEqual(headers["x-api-key"], "client-anthropic-key");
    assert.strictEqual(headers["anthropic-version"], "2023-06-01");
    // user-agent is not in forward_headers, so omitted
    assert.strictEqual(headers["user-agent"], undefined);
    assert.strictEqual(headers["content-type"], "application/json");
  });

  it("api_key STRIPS client auth headers and injects environment key", () => {
    const registry = loadProvidersFromFile("config/providers.example.yaml");
    const customConfig = registry.getProvider("custom_llm")!;

    const env = {
      CUSTOM_LLM_KEY: "secret-custom-token",
    };

    const clientHeaders = {
      authorization: "Bearer stolen-client-anthropic-token",
      "x-api-key": "secret-user-key-must-not-leak",
      "anthropic-version": "2023-06-01",
    };

    const headers = prepareOutboundHeaders(clientHeaders, customConfig, "openai", env);

    // Incoming user token MUST NOT be leaked to third-party provider
    assert.strictEqual(headers["x-api-key"], undefined);
    assert.strictEqual(headers["authorization"], "Bearer secret-custom-token");
    assert.strictEqual(headers["content-type"], "application/json");
  });
});
