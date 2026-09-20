import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadTermsFromFileOrDir } from "./terms.ts";
import { ConfigurationError } from "../errors.ts";

describe("loadTermsFromFileOrDir", () => {
  it("loads config/terms.example.yaml correctly", () => {
    const termSet = loadTermsFromFileOrDir("config/terms.example.yaml");
    const terms = termSet.activeTerms();

    assert.ok(terms.includes("알파테크"));
    assert.ok(terms.includes("Project 오로라"));
    assert.ok(terms.includes("OMEGA"));
    // 프로젝트 타이탄 is commented out in example.yaml
    assert.ok(!terms.includes("프로젝트 타이탄"));
    assert.strictEqual(termSet.totalCommentedOutCount, 1);
  });

  it("fails on duplicate term across different categories", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mask-terms-test-"));
    const yamlPath = path.join(tmpDir, "terms.yaml");
    fs.writeFileSync(
      yamlPath,
      `
INTERNAL:
  - 중복용어
PROJECT:
  - 중복용어
`
    );

    assert.throws(
      () => loadTermsFromFileOrDir(yamlPath),
      (err) => err instanceof ConfigurationError && err.message.includes("Duplicate term")
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("splits comma-separated aliases on one line into a shared canonical group", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mask-terms-test-"));
    const yamlPath = path.join(tmpDir, "terms.yaml");
    fs.writeFileSync(
      yamlPath,
      `
PROJECT:
  - 네뷸라발전사업, 네뷸라 발전사업
`
    );

    const termSet = loadTermsFromFileOrDir(yamlPath);
    const terms = termSet.activeTerms();

    assert.ok(terms.includes("네뷸라발전사업"));
    assert.ok(terms.includes("네뷸라 발전사업"));

    const cat = termSet.categories.get("PROJECT")!;
    assert.strictEqual(cat.terms[0].canonical, "네뷸라발전사업");
    assert.strictEqual(cat.terms[1].canonical, "네뷸라발전사업");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fails on 1-character term without allow_short: true", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mask-terms-test-"));
    const yamlPath = path.join(tmpDir, "terms.yaml");
    fs.writeFileSync(
      yamlPath,
      `
INTERNAL:
  - A
`
    );

    assert.throws(
      () => loadTermsFromFileOrDir(yamlPath),
      (err) => err instanceof ConfigurationError && err.message.includes("allow_short")
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fails on ReDoS pattern with nested quantifiers (S-09)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mask-terms-test-"));
    const yamlPath = path.join(tmpDir, "terms.yaml");
    fs.writeFileSync(
      yamlPath,
      `
SECRET:
  patterns:
    - "(a+)+$"
`
    );

    assert.throws(
      () => loadTermsFromFileOrDir(yamlPath),
      (err) =>
        err instanceof ConfigurationError &&
        err.message.includes("catastrophic backtracking")
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fails on pattern exceeding 200 chars (S-09)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mask-terms-test-"));
    const yamlPath = path.join(tmpDir, "terms.yaml");
    const longPattern = "a".repeat(205);
    fs.writeFileSync(
      yamlPath,
      `
SECRET:
  patterns:
    - "${longPattern}"
`
    );

    assert.throws(
      () => loadTermsFromFileOrDir(yamlPath),
      (err) =>
        err instanceof ConfigurationError &&
        err.message.includes("exceeds maximum length of 200")
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
