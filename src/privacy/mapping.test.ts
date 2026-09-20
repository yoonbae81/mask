import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TokenMap } from "./mapping.ts";

describe("TokenMap", () => {
  it("assigns sequential numbers per entity category without preferredSuffix", () => {
    const map = new TokenMap();
    const t1 = map.getOrCreateToken("INTERNAL", "알파테크");
    const t2 = map.getOrCreateToken("INTERNAL", "알파");
    const t3 = map.getOrCreateToken("PROJECT", "Project 오로라");

    assert.strictEqual(t1, "<INTERNAL_1A>");
    assert.strictEqual(t2, "<INTERNAL_2A>");
    assert.strictEqual(t3, "<PROJECT_1A>");

    // Same term returns existing token
    assert.strictEqual(map.getOrCreateToken("INTERNAL", "알파테크"), "<INTERNAL_1A>");
    assert.strictEqual(map.getOriginal("<INTERNAL_1A>"), "알파테크");
    assert.strictEqual(map.getOriginal("<PROJECT_1A>"), "Project 오로라");
    assert.strictEqual(map.getOriginal("<NON_EXISTENT>"), undefined);
  });

  it("assigns preferredSuffix when provided", () => {
    const map = new TokenMap();
    const t1 = map.getOrCreateToken("COMPANY", "한국전력공사", "1A");
    const t2 = map.getOrCreateToken("COMPANY", "한전", "1B");
    const t3 = map.getOrCreateToken("COMPANY", "한국전력", "1C");

    assert.strictEqual(t1, "<COMPANY_1A>");
    assert.strictEqual(t2, "<COMPANY_1B>");
    assert.strictEqual(t3, "<COMPANY_1C>");
  });

  it("custom token format", () => {
    const map = new TokenMap({ tokenFormat: "[{type}#{n}]" });
    const t1 = map.getOrCreateToken("INTERNAL", "알파테크");
    assert.strictEqual(t1, "[INTERNAL#1A]");
    assert.strictEqual(map.getOriginal("[INTERNAL#1A]"), "알파테크");
  });

  it("renders suffix sequence 1A..27A without preferredSuffix", () => {
    const map = new TokenMap();
    const tokens = Array.from({ length: 27 }, (_, i) =>
      map.getOrCreateToken("INTERNAL", `term-${i}`)
    );
    assert.strictEqual(tokens[0], "<INTERNAL_1A>");
    assert.strictEqual(tokens[1], "<INTERNAL_2A>");
    assert.strictEqual(tokens[26], "<INTERNAL_27A>");
  });

  it("serializes numeric counters and resumes suffix sequence after reload", () => {
    const map = new TokenMap();
    for (let i = 0; i < 5; i++) map.getOrCreateToken("INTERNAL", `term-${i}`);
    const serialized = map.toSerialized();

    const reloaded = TokenMap.fromSerialized(serialized);
    assert.strictEqual(
      reloaded.getOrCreateToken("INTERNAL", "term-5"),
      "<INTERNAL_6A>"
    );
  });
});
