import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/app.ts";
import { parseSettings } from "../../src/settings.ts";

describe("healthz route", () => {
  it("GET /healthz returns 200 ok", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), { status: "ok" });
    await app.close();
  });
});
