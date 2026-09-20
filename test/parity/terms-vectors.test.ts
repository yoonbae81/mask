import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { maskText, restoreText } from "../../src/privacy/mask.ts";

interface VectorCase {
  name: string;
  input: string;
  expectedMasked: string;
  expectedRestored?: string;
}

interface Vectors {
  termsYaml: string;
  cases: VectorCase[];
}

const vectors: Vectors = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "terms-vectors.json"), "utf-8")
);

describe("parity vectors (server TS)", () => {
  for (const vec of vectors.cases) {
    it(vec.name, () => {
      const result = maskText(vec.input, vectors.termsYaml);
      assert.equal(result.leak, false, `guard residue in case ${vec.name}`);
      assert.equal(result.masked, vec.expectedMasked);
      const restored = restoreText(result.masked, JSON.stringify(result.mapping));
      assert.equal(restored.text, vec.expectedRestored ?? vec.input);
    });
  }
});
