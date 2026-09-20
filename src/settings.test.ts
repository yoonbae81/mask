import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseSettings } from "./settings.ts";
import { ConfigurationError } from "./errors.ts";

describe("settings", () => {
  it("fails if required env vars are missing", () => {
    assert.throws(
      () => parseSettings({}, { checkFilesExist: false }),
      (err) => err instanceof ConfigurationError && err.message.includes("MASK_TERMS_FILE")
    );
  });

  it("parses valid env with defaults and converts relative paths", () => {
    const env = {
      MASK_TERMS_FILE: "config/terms.yaml",
      MASK_PROVIDERS_FILE: "config/providers.yaml",
      MASK_PORT: "9000",
      MASK_FAIL_CLOSED: "false",
      MASK_LOG_PAYLOADS: "true",
    };

    const s = parseSettings(env, { checkFilesExist: false, cwd: "/custom/root" });
    assert.strictEqual(s.MASK_PORT, 9000);
    assert.strictEqual(s.MASK_FAIL_CLOSED, false);
    assert.strictEqual(s.MASK_LOG_PAYLOADS, true);
    assert.strictEqual(s.MASK_HOST, "127.0.0.1");
    assert.strictEqual(s.MASK_STREAMING_MODE, "rolling");
    assert.strictEqual(s.resolvedTermsFile, path.resolve("/custom/root", "config/terms.yaml"));
    assert.strictEqual(s.resolvedProvidersFile, path.resolve("/custom/root", "config/providers.yaml"));
  });

  it("fails if files do not exist when checkFilesExist is true", () => {
    const env = {
      MASK_TERMS_FILE: "/non/existent/terms.yaml",
      MASK_PROVIDERS_FILE: "/non/existent/providers.yaml",
    };

    assert.throws(
      () => parseSettings(env, { checkFilesExist: true }),
      (err) => err instanceof ConfigurationError && err.message.includes("does not exist")
    );
  });

  it("fails if MASK_HOST is non-loopback without MASK_ALLOW_REMOTE=true (S-05)", () => {
    const env = {
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_HOST: "0.0.0.0",
    };

    assert.throws(
      () => parseSettings(env, { checkFilesExist: false }),
      (err) =>
        err instanceof ConfigurationError &&
        err.message.includes("MASK_ALLOW_REMOTE=true")
    );
  });

  it("allows non-loopback MASK_HOST if MASK_ALLOW_REMOTE=true (S-05)", () => {
    const env = {
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_HOST: "0.0.0.0",
      MASK_ALLOW_REMOTE: "true",
    };

    const s = parseSettings(env, { checkFilesExist: false });
    assert.strictEqual(s.MASK_HOST, "0.0.0.0");
    assert.strictEqual(s.MASK_ALLOW_REMOTE, true);
  });

  it("fails if MASK_GUARD=off when MASK_FAIL_CLOSED=true (S-01)", () => {
    const env = {
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_GUARD: "off",
      MASK_FAIL_CLOSED: "true",
    };

    assert.throws(
      () => parseSettings(env, { checkFilesExist: false }),
      (err) =>
        err instanceof ConfigurationError &&
        err.message.includes("fail-closed violated")
    );
  });

  it("fails if MASK_ALLOW_UNSAFE_LOGGING=true on non-loopback host (S-02)", () => {
    const env = {
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_HOST: "192.168.1.100",
      MASK_ALLOW_REMOTE: "true",
      MASK_ALLOW_UNSAFE_LOGGING: "true",
    };

    assert.throws(
      () => parseSettings(env, { checkFilesExist: false }),
      (err) =>
        err instanceof ConfigurationError &&
        err.message.includes("strictly forbidden on non-loopback host")
    );
  });

  it("parses MASK_ALLOWED_ORIGINS as comma-separated string with empty default (SEC-74)", () => {
    const env = {
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
      MASK_ALLOWED_ORIGINS: "https://a.example.com, https://b.example.com",
    };

    const s = parseSettings(env, { checkFilesExist: false });
    assert.strictEqual(s.MASK_ALLOWED_ORIGINS, "https://a.example.com, https://b.example.com");

    const d = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: false });
    assert.strictEqual(d.MASK_ALLOWED_ORIGINS, "");
  });
});
