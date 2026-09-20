import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/app.ts";
import { parseSettings } from "../../src/settings.ts";

describe("Real socket smoke test", () => {
  it("does not crash when receiving a real HTTP request over a net.Socket", async () => {
    const settings = parseSettings({
      MASK_TERMS_FILE: "config/terms.example.yaml",
      MASK_PROVIDERS_FILE: "config/providers.example.yaml",
    }, { checkFilesExist: true });

    const app = await buildApp(settings);
    await app.listen({ port: 0, host: "127.0.0.1" });

    const addr = app.server.address();
    const port = (addr as any).port;

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.deepStrictEqual(data, { status: "ok" });

    await app.close();
  });
});
