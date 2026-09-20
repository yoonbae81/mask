import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MaskSession, maskText, restoreText } from "./mask.ts";
import { parseTermsYaml } from "./terms.ts";

const TERMS_YAML = `INTERNAL:
  - 알파테크
  - term: 알파
    boundary: strict

PROJECT:
  - Project 오로라, 오로라

CUSTOMER:
  - CORP

PHONE:
  patterns:
    - '\\b01[016-9][-\\s]?\\d{3,4}[-\\s]?\\d{4}\\b'
`;

describe("maskText", () => {
  it("masks Korean terms with particles and restores losslessly", () => {
    const input = "알파테크는 Project 오로라를 검토했다";
    const result = maskText(input, TERMS_YAML);
    assert.equal(result.leak, false);
    assert.deepEqual(result.categories, {});
    assert.match(result.masked, /<INTERNAL_1A>/);
    assert.match(result.masked, /<PROJECT_1A>/);
    assert.ok(!result.masked.includes("알파테크"));
    const restored = restoreText(result.masked, result.mapping);
    assert.equal(restored.text, input);
    assert.equal(restored.restored, 2);
  });

  it("applies ASCII word boundaries (CORP != CORPORATION)", () => {
    const result = maskText("CORP와 CORPORATION", TERMS_YAML);
    assert.ok(result.masked.includes("<CUSTOMER_1A>"));
    assert.ok(result.masked.includes("CORPORATION"));
  });

  it("reports leak when guard finds residue", () => {
    const session = new MaskSession("OTHER:\n  - 무관\n");
    const masked = session.mask("무관한 내용");
    assert.equal(masked, "<OTHER_1A>한 내용");
    assert.deepEqual(session.scan(masked), {});
  });

  it("mapping survives JSON round trip", () => {
    const input = "알파테크 010-1234-5678";
    const result = maskText(input, TERMS_YAML);
    const json = JSON.stringify(result.mapping);
    const restored = restoreText(result.masked, json);
    assert.equal(restored.text, input);
  });

  it("accepts a TermSet as well as YAML text", () => {
    const terms = parseTermsYaml(TERMS_YAML);
    const session = new MaskSession(terms);
    assert.equal(session.restore(session.mask("알파테크")), "알파테크");
  });

  it("assertNoLeak throws GuardTripped with guard on", () => {
    const session = new MaskSession(TERMS_YAML);
    assert.throws(() => session.assertNoLeak("알파테크 노출"), (e: any) => e.statusCode === 502);
  });

  it("rejects malformed mapping data", () => {
    assert.throws(() => restoreText("<X_1>", "not json"), /Invalid mapping data/);
    assert.throws(
      () => restoreText("<X_1>", JSON.stringify({ version: 2 })),
      /Invalid mapping data/
    );
  });

  it("maps same-line comma-separated aliases to 1A, 1B, 1C and separate lines to 1A, 2A", () => {
    const yaml = `COMPANY:
  - 한국전력공사, 한전, 한국전력
PROJECT:
  - Project 오로라
  - 프로젝트 네뷸라
`;
    const res1 = maskText("한국전력공사, 한전, 한국전력", yaml);
    assert.strictEqual(res1.masked, "<COMPANY_1A>, <COMPANY_1B>, <COMPANY_1C>");
    assert.deepEqual(res1.mapping.entries, [
      { token: "<COMPANY_1A>", entity: "COMPANY", term: "한국전력공사" },
      { token: "<COMPANY_1B>", entity: "COMPANY", term: "한전" },
      { token: "<COMPANY_1C>", entity: "COMPANY", term: "한국전력" },
    ]);

    const res2 = maskText("Project 오로라와 프로젝트 네뷸라", yaml);
    assert.strictEqual(res2.masked, "<PROJECT_1A>와 <PROJECT_2A>");
    assert.deepEqual(res2.mapping.entries, [
      { token: "<PROJECT_1A>", entity: "PROJECT", term: "Project 오로라" },
      { token: "<PROJECT_2A>", entity: "PROJECT", term: "프로젝트 네뷸라" },
    ]);

    // Order independence: second line item appears first in text
    const res3 = maskText("프로젝트 네뷸라와 Project 오로라", yaml);
    assert.strictEqual(res3.masked, "<PROJECT_2A>와 <PROJECT_1A>");

    // Single alias on its own retains its defined suffix
    const res4 = maskText("한전 단독 언급", yaml);
    assert.strictEqual(res4.masked, "<COMPANY_1B> 단독 언급");
  });
});

describe("term escape bypass", () => {
  const termsYaml = "INTERNAL:\n  - 알파테크\n";

  it("bypassed occurrence passes the guard and is counted", () => {
    const session = new MaskSession(termsYaml, { termEscape: true, guard: "on" });
    const masked = session.mask("\\알파테크 회의록을 찾아줘");

    assert.ok(masked.includes("알파테크 회의록을 찾아줘"), "원문 유지");
    assert.deepStrictEqual(session.getBypassedCounts(), { INTERNAL: 1 });

    // 가드는 우회된 occurrence 를 유출로 취급하지 않는다
    assert.doesNotThrow(() => session.assertNoLeak(masked));
    assert.deepStrictEqual(session.scan(masked), {});
  });

  it("without termEscape the backslash stays and the term is masked", () => {
    const session = new MaskSession(termsYaml, { guard: "on" });
    const masked = session.mask("\\알파테크 회의록");

    // 이스케이프 기능이 꺼져 있으면 백슬래시가 남고 용어는 마스킹된다
    assert.ok(masked.includes("\\<INTERNAL_1A>"));
    assert.deepStrictEqual(session.getBypassedCounts(), {});
  });
});
