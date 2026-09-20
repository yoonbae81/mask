import { GuardTripped } from "../errors.ts";
import type { TermSet } from "./terms.ts";

const RE_ASCII_W = /^[A-Za-z0-9]$/;
const RE_HANGUL_CJK = /^[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f\u4e00-\u9fff\u3400-\u4dbf]$/;

function isAsciiW(ch: string | undefined): boolean {
  return !!ch && RE_ASCII_W.test(ch);
}

function isHangulOrCjk(ch: string | undefined): boolean {
  return !!ch && RE_HANGUL_CJK.test(ch);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CompiledGuardRule {
  category: string;
  regex: RegExp;
}

const guardRulesCache = new WeakMap<TermSet, CompiledGuardRule[]>();

export function getCompiledGuardRules(termSet: TermSet): CompiledGuardRule[] {
  const cached = guardRulesCache.get(termSet);
  if (cached) {
    return cached;
  }

  // PERF-39: Early return empty array if termSet has no terms and no patterns
  if (termSet.totalTermsCount === 0 && termSet.activePatterns().length === 0) {
    const emptyRules: CompiledGuardRule[] = [];
    guardRulesCache.set(termSet, emptyRules);
    return emptyRules;
  }

  const rules: CompiledGuardRule[] = [];

  // 1. Literal terms scan
  for (const [catName, catInfo] of termSet.categories.entries()) {
    for (const termItem of catInfo.terms) {
      const term = termItem.term;
      if (!term) continue;

      const first = term[0];
      const last = term[term.length - 1];

      let left = "";
      if (isAsciiW(first)) {
        left = `(?<![A-Za-z0-9])`;
      } else if (termItem.boundary === "strict" && isHangulOrCjk(first)) {
        left = `(?<![\\uac00-\\ud7a3\\u1100-\\u11ff\\u3130-\\u318f\\u4e00-\\u9fff\\u3400-\\u4dbf])`;
      }

      let right = "";
      if (isAsciiW(last)) {
        right = `(?![A-Za-z0-9])`;
      }

      const body = term.split(/\s+/).map((p) => escapeRe(p)).join("\\s+");
      const re = new RegExp(`${left}${body}${right}`, isAsciiW(first) ? "i" : "");
      rules.push({ category: catName, regex: re });
    }
  }

  // 2. Pattern (regex) scan
  for (const pat of termSet.activePatterns()) {
    const re = new RegExp(pat.regex.source, pat.regex.flags.replace("g", ""));
    rules.push({ category: pat.category, regex: re });
  }

  guardRulesCache.set(termSet, rules);
  return rules;
}

export function scanPayloadForLeaks(
  serializedBody: string,
  termSet: TermSet,
  options: { earlyExit?: boolean } = {}
): Record<string, number> {
  const trippedCategories: Record<string, number> = {};
  const rules = getCompiledGuardRules(termSet);

  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(serializedBody)) {
      trippedCategories[rule.category] = (trippedCategories[rule.category] || 0) + 1;
      if (options.earlyExit) {
        return trippedCategories;
      }
    }
  }

  return trippedCategories;
}

export function assertNoLeakGuard(
  serializedBody: string,
  termSet: TermSet,
  guardEnabled: "on" | "off" = "on"
) {
  if (guardEnabled === "off") {
    return;
  }

  // SEC-47 & SEC-78: Strip zero-width and bidi control characters before leak detection
  const cleanBody = serializedBody.replace(
    /[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g,
    ""
  );

  // P-02: Early exit on first detected leak
  const tripped = scanPayloadForLeaks(cleanBody, termSet, { earlyExit: true });
  const trippedCount = Object.keys(tripped).length;

  if (trippedCount > 0) {
    const error = new GuardTripped(
      "Outbound request blocked by privacy guard: sensitive terms detected"
    );
    error.categories = tripped;
    throw error;
  }
}
