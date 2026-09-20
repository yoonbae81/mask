#!/usr/bin/env node
/**
 * 최종 번들 금지 문자열 스캔.
 * 대상: web/dist 산출물 전체(정적 yaml/md 복사본 포함).
 * 통과 기준: 아래 패턴이 하나라도 발견되면 실패(1)한다.
 *  - 자격증명/endpoint 계열: api_key, base_url
 *  - 서버 설정 경로: config/terms.yaml
 *  - provider 이름
 *  - 외부 URL(http/https) — 단 SVG 네임스페이스(w3.org)는 예외
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const distDir = fileURLToPath(new URL("../dist", import.meta.url));

const PROVIDER_NAMES = [
  "anthropic",
  "openai",
  "claude",
  "gemini",
  "openrouter",
  "mistral",
  "deepseek",
  "groq",
  "custom_llm",
];

const patterns = [
  { name: "api_key", re: /api[_-]?key/i },
  { name: "baseUrl", re: /base[_-]?url/i },
  { name: "config/terms.yaml", re: /config\/terms\.ya?ml/i },
  ...PROVIDER_NAMES.map((p) => ({ name: `provider:${p}`, re: new RegExp(p, "i") })),
];

const URL_RE = /https?:\/\/[^\s"'`)<>\]]+/g;
const URL_ALLOW = /^https?:\/\/(www\.)?w3\.org\//; // SVG/MathML 네임스페이스 식별자(요청 아님)

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function findUrls(text) {
  const bad = [];
  for (const m of text.matchAll(URL_RE)) {
    if (!URL_ALLOW.test(m[0])) bad.push(m[0]);
  }
  return bad;
}

const TEXT_EXT = new Set([".js", ".mjs", ".css", ".html", ".json", ".yaml", ".yml", ".md", ".svg", ".map"]);

if (!statSync(distDir, { throwIfNoEntry: false })) {
  console.error(`[mask-web] scan: 빌드 산출물이 없습니다 — 먼저 'npm run build'를 실행하세요.`);
  process.exit(2);
}

let failures = 0;
for (const file of walk(distDir)) {
  // 바이너리(이미지 등)는 텍스트 스캔 대상이 아니다.
  if (!TEXT_EXT.has(path.extname(file))) continue;
  const rel = path.relative(distDir, file);
  const text = readFileSync(file, "utf8");
  for (const { name, re } of patterns) {
    const m = text.match(re);
    if (m) {
      failures += 1;
      console.error(`[mask-web] scan FAIL ${rel}: ${name} → ${JSON.stringify(m[0])}`);
    }
  }
  for (const url of findUrls(text)) {
    failures += 1;
    console.error(`[mask-web] scan FAIL ${rel}: external url → ${JSON.stringify(url)}`);
  }
}

if (failures > 0) {
  console.error(`[mask-web] scan: 금지 문자열 ${failures}건 발견 — 실패.`);
  process.exit(1);
}
console.log("[mask-web] scan: 통과 — 금지 문자열 없음.");
