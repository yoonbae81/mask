import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TermSet } from "./terms.ts";
import { assertNoLeakGuard } from "./guard.ts";
import { GuardTripped } from "../errors.ts";

describe("assertNoLeakGuard", () => {
  const termSet = new TermSet(
    new Map([
      [
        "INTERNAL",
        {
          name: "INTERNAL",
          terms: [{ term: "알파테크" }, { term: "베타", boundary: "strict" }],
          patterns: [],
          commentedOutCount: 0,
        },
      ],
      [
        "RRN",
        {
          name: "RRN",
          terms: [],
          patterns: ["\\b\\d{6}[-\\s]?[1-4]\\d{6}\\b"],
          commentedOutCount: 0,
        },
      ],
    ])
  );

  it("passes when payload contains no sensitive terms or patterns", () => {
    const payload = JSON.stringify({
      messages: [{ role: "user", content: "<INTERNAL_1A> 및 일반 내용" }],
    });

    assert.doesNotThrow(() => assertNoLeakGuard(payload, termSet, "on"));
  });

  it("throws GuardTripped (502) when literal term is leaked in serialized body", () => {
    const payload = JSON.stringify({
      messages: [{ role: "user", content: "알파테크 관련 보고서" }],
    });

    assert.throws(
      () => assertNoLeakGuard(payload, termSet, "on"),
      (err) => {
        if (!(err instanceof GuardTripped)) return false;
        assert.strictEqual(err.statusCode, 502);
        assert.strictEqual(err.categories["INTERNAL"], 1);
        // Essential: raw term MUST NOT be in message
        assert.ok(!err.message.includes("알파테크"));
        return true;
      }
    );
  });

  it("throws GuardTripped when pattern (RRN) is leaked in serialized body", () => {
    const payload = JSON.stringify({
      messages: [{ role: "user", content: "식별번호: 990101-1234567" }],
    });

    assert.throws(
      () => assertNoLeakGuard(payload, termSet, "on"),
      (err) => {
        if (!(err instanceof GuardTripped)) return false;
        assert.strictEqual(err.statusCode, 502);
        assert.strictEqual(err.categories["RRN"], 1);
        return true;
      }
    );
  });

  it("does not trip when guard is switched off", () => {
    const payload = JSON.stringify({
      messages: [{ role: "user", content: "알파테크" }],
    });

    assert.doesNotThrow(() => assertNoLeakGuard(payload, termSet, "off"));
  });

  it("does not false-positive on strict boundary terms with Hangul prefix", () => {
    // '글로벌베타' contains '베타', but '베타' is marked boundary: strict
    const payload = JSON.stringify({
      messages: [{ role: "user", content: "글로벌베타와 계약" }],
    });

    assert.doesNotThrow(() => assertNoLeakGuard(payload, termSet, "on"));
  });
});
