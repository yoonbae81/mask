import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DenyListMatcher, type TermEntryForMatcher } from "./matcher.ts";
import { PatternMatcher } from "./patterns.ts";

describe("DenyListMatcher", () => {
  const terms: TermEntryForMatcher[] = [
    { entity: "INTERNAL", term: "알파테크" },
    { entity: "INTERNAL", term: "알파" },
    { entity: "INTERNAL", term: "ALPHATECH" },
    { entity: "INTERNAL", term: "베타네트웍스" },
    { entity: "PROJECT", term: "Project 오로라" },
    { entity: "PROJECT", term: "프로젝트 타이탄" },
    { entity: "CUSTOMER", term: "OMEGA" },
    { entity: "CUSTOMER", term: "CORP" },
  ];

  const matcher = new DenyListMatcher(terms);

  it("matches standard sentence with multiple terms and particles", () => {
    const text = "알파테크는 Project 오로라를 OMEGA와 협의했다.";
    const matches = matcher.find(text).map((s) => s.surface);
    assert.deepStrictEqual(matches, ["알파테크", "Project 오로라", "OMEGA"]);
  });

  it("matches Korean particles: 가, 의, 에서", () => {
    assert.deepStrictEqual(
      matcher.find("알파테크가").map((s) => s.surface),
      ["알파테크"]
    );
    assert.deepStrictEqual(
      matcher.find("알파테크의 자회사").map((s) => s.surface),
      ["알파테크"]
    );
    assert.deepStrictEqual(
      matcher.find("알파에서 보낸 공문").map((s) => s.surface),
      ["알파"]
    );
  });

  it("prefers longest match: 알파테크연구소 소장", () => {
    const matches = matcher.find("알파테크연구소 소장").map((s) => s.surface);
    assert.deepStrictEqual(matches, ["알파테크"]);
  });

  it("finds multiple entities in one text", () => {
    const matches = matcher.find("베타네트웍스와 알파").map((s) => s.surface);
    assert.deepStrictEqual(matches, ["베타네트웍스", "알파"]);
  });

  it("respects ASCII boundaries: CORPORATION, CORPTECH, OMEGAX are ignored", () => {
    assert.deepStrictEqual(matcher.find("CORPORATION 검토"), []);
    assert.deepStrictEqual(matcher.find("CORPTECH 3"), []);
    assert.deepStrictEqual(matcher.find("OMEGAX 라는 회사"), []);
  });

  it("matches ASCII with Korean boundary: CORP와 협의", () => {
    const matches = matcher.find("CORP와 협의").map((s) => s.surface);
    assert.deepStrictEqual(matches, ["CORP"]);
  });

  it("matches case-insensitive ASCII: alphatech", () => {
    const matches = matcher.find("alphatech 소문자").map((s) => s.surface);
    assert.deepStrictEqual(matches, ["alphatech"]);
  });

  it("matches normalized spaces: Project  오로라", () => {
    const matches = matcher.find("Project  오로라 (공백 2)").map((s) => s.surface);
    assert.deepStrictEqual(matches, ["Project  오로라"]);
  });

  it("over-matches without boundary (P7): 주식회사알파테크, 글로벌알파와 계약", () => {
    assert.deepStrictEqual(
      matcher.find("주식회사알파테크").map((s) => s.surface),
      ["알파테크"]
    );
    assert.deepStrictEqual(
      matcher.find("글로벌알파와 계약").map((s) => s.surface),
      ["알파"]
    );
  });

  it("respects boundary: strict when explicitly configured", () => {
    const strictTerms: TermEntryForMatcher[] = [
      { entity: "INTERNAL", term: "알파테크" },
      { entity: "INTERNAL", term: "알파", boundary: "strict" },
    ];
    const strictMatcher = new DenyListMatcher(strictTerms);

    // 글로벌알파 has '벌' preceding '알파', so with boundary: strict it should not match
    assert.deepStrictEqual(
      strictMatcher.find("글로벌알파와 계약").map((s) => s.surface),
      []
    );
    // But '알파에서' still matches because left is start of string
    assert.deepStrictEqual(
      strictMatcher.find("알파에서 보낸 공문").map((s) => s.surface),
      ["알파"]
    );
  });
});

describe("PatternMatcher", () => {
  // 프리셋은 baa3665에서 제거되고 terms.yaml 의 PIN: patterns 로 이관되었다.
  // 테스트는 YAML 에서 로드되는 것과 동일한 규칙을 직접 주입해 탐지 동작을 검증한다.
  const matcher = new PatternMatcher([
    { entity: "RRN", regex: /\b\d{6}[-\s]?[1-4]\d{6}\b/g },
    { entity: "PHONE", regex: /\b01[016-9][-\s]?\d{3,4}[-\s]?\d{4}\b/g },
    { entity: "PHONE", regex: /\b0(?:2|[3-6][1-5])[-\s]?\d{3,4}[-\s]?\d{4}\b/g },
    { entity: "BIZNO", regex: /\b\d{3}-\d{2}-\d{5}\b/g },
    { entity: "EMAIL", regex: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  ]);

  it("detects RRN", () => {
    const text = "주민번호는 900101-1234567 입니다.";
    const matches = matcher.find(text);
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].entity, "RRN");
    assert.strictEqual(matches[0].surface, "900101-1234567");
  });

  it("detects phone numbers", () => {
    const text = "연락처: 010-1234-5678 또는 02-123-4567";
    const matches = matcher.find(text);
    assert.strictEqual(matches.length, 2);
    assert.strictEqual(matches[0].entity, "PHONE");
    assert.strictEqual(matches[0].surface, "010-1234-5678");
    assert.strictEqual(matches[1].entity, "PHONE");
    assert.strictEqual(matches[1].surface, "02-123-4567");
  });

  it("detects BIZNO and EMAIL", () => {
    const text = "사업자등록번호 123-45-67890 및 이메일 user@example.com";
    const matches = matcher.find(text);
    assert.strictEqual(matches.length, 2);
    assert.strictEqual(matches[0].entity, "BIZNO");
    assert.strictEqual(matches[0].surface, "123-45-67890");
    assert.strictEqual(matches[1].entity, "EMAIL");
    assert.strictEqual(matches[1].surface, "user@example.com");
  });
});
