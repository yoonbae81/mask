import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { DenyListMatcher } from "./matcher.ts";
import { TokenMap } from "./mapping.ts";
import { tokenize } from "./tokenizer.ts";
import { detokenize } from "./detokenizer.ts";

describe("tokenizer & detokenizer roundtrip", () => {
  const matcher = new DenyListMatcher([
    { entity: "INTERNAL", term: "알파테크" },
    { entity: "INTERNAL", term: "알파" },
    { entity: "PROJECT", term: "Project 오로라" },
    { entity: "CUSTOMER", term: "OMEGA" },
  ]);

  it("replaces sensitive terms with tokens and detokenizes back to original", () => {
    const tokenMap = new TokenMap();
    const original = "알파테크는 Project 오로라를 OMEGA와 협의했다.";
    const tokenized = tokenize(original, matcher, tokenMap);

    assert.strictEqual(
      tokenized,
      "<INTERNAL_1A>는 <PROJECT_1A>를 <CUSTOMER_1A>와 협의했다."
    );

    const restored = detokenize(tokenized, tokenMap);
    assert.strictEqual(restored, original);
  });

  it("over-match roundtrip is completely lossless (P7)", () => {
    const tokenMap = new TokenMap();
    const original = "글로벌알파와 계약을 체결했다.";
    const tokenized = tokenize(original, matcher, tokenMap);

    assert.strictEqual(tokenized, "글로벌<INTERNAL_2A>와 계약을 체결했다.");

    const restored = detokenize(tokenized, tokenMap);
    assert.strictEqual(restored, original);
  });

  it("handles token collision when input contains existing token format", () => {
    const tokenMap = new TokenMap();
    const original = "이 프로젝트는 <PROJECT_1> 라고 불리며 알파테크가 담당한다.";
    const tokenized = tokenize(original, matcher, tokenMap);

    assert.ok(tokenized.includes("<<PROJECT_1>>"));
    assert.ok(tokenized.includes("<INTERNAL_1A>"));

    const restored = detokenize(tokenized, tokenMap);
    assert.strictEqual(restored, original);
  });

  it("leaves unmapped hallucinated tokens intact without error", () => {
    const tokenMap = new TokenMap();
    const original = "알파테크 보고서";
    const tokenized = tokenize(original, matcher, tokenMap);

    // Simulated LLM response containing a hallucinated token <PROJECT_99>
    const llmOutput = `${tokenized} 관련 <PROJECT_99> 내용`;
    const restored = detokenize(llmOutput, tokenMap);

    assert.strictEqual(restored, "알파테크 보고서 관련 <PROJECT_99> 내용");
  });

  it("alias surfaces get distinct tokens and restore to exact surface", () => {
    const aliasMatcher = new DenyListMatcher([
      { entity: "PROJECT", term: "네뷸라발전사업", canonical: "네뷸라발전사업" },
      { entity: "PROJECT", term: "네뷸라 발전사업", canonical: "네뷸라발전사업" },
    ]);
    const tokenMap = new TokenMap();
    const original = "네뷸라발전사업과 네뷸라 발전사업 비교";
    const tokenized = tokenize(original, aliasMatcher, tokenMap);

    assert.strictEqual(tokenized, "<PROJECT_1A>과 <PROJECT_1B> 비교");

    const restored = detokenize(tokenized, tokenMap);
    assert.strictEqual(restored, original);
  });

  it("property-based test: random text + terms preserves roundtrip fidelity", () => {
    const terms = ["알파테크", "알파", "Project 오로라", "OMEGA"];

    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 0, maxLength: 20 }), { minLength: 1, maxLength: 5 }),
        fc.array(fc.constantFrom(...terms), { minLength: 1, maxLength: 4 }),
        (texts, selectedTerms) => {
          const map = new TokenMap();
          // Interleave texts and selected terms
          const combined = texts.flatMap((t, i) => [t, selectedTerms[i] ?? ""]).join("");
          const tokenized = tokenize(combined, matcher, map);
          const restored = detokenize(tokenized, map);
          assert.strictEqual(restored, combined);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe("\\ term escape bypass", () => {
  const matcher = new DenyListMatcher([
    { entity: "PROJECT", term: "네뷸라발전" },
    { entity: "INTERNAL", term: "알파테크" },
  ]);

  it("keeps the term raw and consumes the backslash when escapeBypass is on", () => {
    const tokenMap = new TokenMap();
    const surfaces = new Set<string>();
    const counts = new Map<string, number>();

    const out = tokenize(
      "\\네뷸라발전 사업을 검토했다. 알파테크도 참여했다.",
      matcher,
      tokenMap,
      { escapeBypass: true, bypassedSurfaces: surfaces, bypassedCounts: counts }
    );

    assert.ok(out.includes("네뷸라발전 사업을 검토했다"), "우회된 용어는 원문 유지");
    assert.ok(!out.includes("\\네뷸라발전"), "백슬래시는 제거된다");
    assert.ok(out.includes("<INTERNAL_1A>"), "일반 occurrence 는 마스킹된다");
    assert.deepStrictEqual([...surfaces], ["네뷸라발전"]);
    assert.deepStrictEqual(Object.fromEntries(counts), { PROJECT: 1 });
  });

  it("keeps the backslash literally when the next word is not a registered term", () => {
    const tokenMap = new TokenMap();
    const out = tokenize(
      "\\일반단어는 그대로 둔다",
      matcher,
      tokenMap,
      { escapeBypass: true }
    );
    assert.strictEqual(out, "\\일반단어는 그대로 둔다");
  });

  it("masks normally and keeps the backslash when escapeBypass is off", () => {
    const tokenMap = new TokenMap();
    const out = tokenize("\\네뷸라발전 검토", matcher, tokenMap);
    assert.ok(out.includes("\\<PROJECT_1A>"));
  });
});
