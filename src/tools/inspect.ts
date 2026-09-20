import fs from "node:fs";
import { parseSettings } from "../settings.ts";
import { loadTermsFromFileOrDir } from "../privacy/terms.ts";
import { DenyListMatcher, type TermEntryForMatcher } from "../privacy/matcher.ts";
import { PatternMatcher, PRESET_PATTERNS, type PatternRule } from "../privacy/patterns.ts";
import { TokenMap } from "../privacy/mapping.ts";
import { tokenize } from "../privacy/tokenizer.ts";
import { detokenize } from "../privacy/detokenizer.ts";
import { walkJson } from "../privacy/walker.ts";
import { anthropicRules } from "../privacy/rules/anthropic.ts";
import { openAiRules } from "../privacy/rules/openai.ts";
import { scanPayloadForLeaks } from "../privacy/guard.ts";
import type { TermSet } from "../privacy/terms.ts";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeAliases(raw: string, termSet: TermSet): string {
  const pairs: { surface: string; canonical: string }[] = [];
  for (const catInfo of termSet.categories.values()) {
    for (const item of catInfo.terms) {
      const canonical = item.canonical ?? item.term;
      if (item.term !== canonical) {
        pairs.push({ surface: item.term, canonical });
      }
    }
  }
  pairs.sort((a, b) => b.surface.length - a.surface.length);
  let out = raw;
  for (const { surface, canonical } of pairs) {
    const asciiFirst = /^[A-Za-z0-9]/.test(surface);
    out = out.replace(new RegExp(escapeRe(surface), asciiFirst ? "gi" : "g"), canonical);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  let text: string | null = null;
  let filePath: string | null = null;
  let payloadPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--text" && args[i + 1]) {
      text = args[++i];
    } else if (args[i] === "--file" && args[i + 1]) {
      filePath = args[++i];
    } else if (args[i] === "--payload" && args[i + 1]) {
      payloadPath = args[++i];
    }
  }

  if (!text && !filePath && !payloadPath) {
    console.log("사용법: npm run inspect -- [--text '...'] | [--file path] | [--payload path]");
    process.exit(1);
  }

  const settings = parseSettings(process.env, { checkFilesExist: false });
  const termsFile = settings.resolvedTermsFile;
  const termSet = loadTermsFromFileOrDir(termsFile);

  const termItems: TermEntryForMatcher[] = [];
  for (const [catName, catInfo] of termSet.categories.entries()) {
    for (const item of catInfo.terms) {
      termItems.push({
        entity: catName,
        term: item.term,
        canonical: item.canonical,
        boundary: item.boundary,
      });
    }
  }

  const denyList = new DenyListMatcher(termItems);
  const customPatterns: PatternRule[] = termSet.activePatterns().map((p) => ({
    entity: p.category,
    regex: p.regex,
  }));
  const patternMatcher = new PatternMatcher([...PRESET_PATTERNS, ...customPatterns]);

  class CombinedMatcher {
    find(str: string) {
      const all = [...denyList.find(str), ...patternMatcher.find(str)];
      all.sort((a, b) => a.start - b.start);
      return all;
    }
  }
  const matcher = new CombinedMatcher();
  const tokenMap = new TokenMap();

  if (text || filePath) {
    const raw = text ?? fs.readFileSync(filePath!, "utf-8");
    const spans = matcher.find(raw);

    console.log("\n분류".padEnd(12) + "매칭 텍스트".padEnd(20) + "위치".padEnd(10) + "보존 여부");
    for (const span of spans) {
      const token = tokenMap.getOrCreateToken(span.entity, span.surface, span.tokenSuffix);
      console.log(
        `${span.entity.padEnd(10)}  ${span.surface.padEnd(18)}  ${`${span.start}-${span.end}`.padEnd(8)}  마스킹됨 → ${token}`
      );
    }

    const tokenized = tokenize(raw, matcher, tokenMap);
    const leaks = scanPayloadForLeaks(tokenized, termSet);
    const leakKeys = Object.keys(leaks);
    const restored = detokenize(tokenized, tokenMap);
    const isLossless = restored === raw;
    const isAliasNormalized = !isLossless && normalizeAliases(raw, termSet) === restored;

    console.log("─".repeat(50));
    console.log(`가드 재스캔: ${leakKeys.length === 0 ? "통과 (잔존 용어 없음)" : `차단됨 (${JSON.stringify(leaks)})`}`);
    console.log(
      `왕복 검증:   ${isLossless ? "통과 (복원 결과가 원문과 일치)" : isAliasNormalized ? "통과 (별칭 정규화 복원 — 같은 줄 콤마 표기는 첫 표기로 복원)" : "실패 (원문과 불일치)"}\n`
    );
    return;
  }

  if (payloadPath) {
    const raw = fs.readFileSync(payloadPath, "utf-8");
    const parsed = JSON.parse(raw);
    const rules = parsed.messages ? anthropicRules : openAiRules;

    const tokenized = walkJson(parsed, rules, (t) => tokenize(t, matcher, tokenMap));
    const serialized = JSON.stringify(tokenized);
    const leaks = scanPayloadForLeaks(serialized, termSet);
    const leakKeys = Object.keys(leaks);
    const restored = walkJson(tokenized, rules, (t) => detokenize(t, tokenMap));
    const isLossless = JSON.stringify(restored) === JSON.stringify(parsed);

    console.log("─".repeat(50));
    console.log(`가드 재스캔: ${leakKeys.length === 0 ? "통과 (잔존 용어 없음)" : `차단됨 (${JSON.stringify(leaks)})`}`);
    console.log(`왕복 검증:   ${isLossless ? "통과 (복원 결과가 원문과 일치)" : "실패 (원문과 불일치)"}\n`);
  }
}

main().catch((err) => {
  console.error("Inspect error:", err);
  process.exit(1);
});
