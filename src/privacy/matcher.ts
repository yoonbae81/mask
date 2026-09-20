import { indexToLetter } from "./mapping.ts";

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

export interface Span {
  start: number;
  end: number;
  entity: string;
  surface: string;
  canonical?: string;
  tokenSuffix?: string;
}

export interface Matcher {
  find(text: string): Span[];
}

export interface TermEntryForMatcher {
  term: string;
  entity: string;
  boundary?: "strict";
  canonical?: string;
  tokenSuffix?: string;
}

export class DenyListMatcher implements Matcher {
  private re: RegExp | null;
  private entityOf = new Map<string, [entity: string, term: string, canonical: string, boundary?: "strict", tokenSuffix?: string]>();
  private minTermLength = Infinity;
  private hasNonAsciiTerms = false;

  constructor(terms: TermEntryForMatcher[], caseInsensitiveAscii = true) {
    // SEC-22: Filter out empty or whitespace-only terms to prevent regex anomalies
    // SEC-71: Filter out excessively long terms (>1024 chars) to guard against ReDoS
    const MAX_TERM_LENGTH = 1024;
    const validTerms = terms.filter(
      (item) => item.term && item.term.trim().length > 0 && item.term.length <= MAX_TERM_LENGTH
    );

    // PERF-52: Check if dictionary contains non-ASCII/non-alphanumeric terms
    this.hasNonAsciiTerms = validTerms.some((item) => !/^[A-Za-z0-9\s_-]+$/.test(item.term));

    // PERF-41: Cache minimum term length for fast bypass on shorter inputs
    for (const item of validTerms) {
      if (item.term.length < this.minTermLength) {
        this.minTermLength = item.term.length;
      }
    }

    // Pre-assign tokenSuffix in original input order if not provided
    const entityGroupCounters = new Map<string, number>();
    const entityCanonicalGroups = new Map<string, Map<string, number>>();
    const entityCanonicalAliasCount = new Map<string, Map<string, number>>();

    const termsWithSuffix = validTerms.map((item) => {
      if (item.tokenSuffix) {
        return item;
      }
      const entity = item.entity;
      const canonical = item.canonical ?? item.term;
      if (!entityCanonicalGroups.has(entity)) {
        entityCanonicalGroups.set(entity, new Map());
        entityCanonicalAliasCount.set(entity, new Map());
        entityGroupCounters.set(entity, 0);
      }
      const groupMap = entityCanonicalGroups.get(entity)!;
      const aliasMap = entityCanonicalAliasCount.get(entity)!;

      let groupNum: number;
      if (groupMap.has(canonical)) {
        groupNum = groupMap.get(canonical)!;
      } else {
        groupNum = (entityGroupCounters.get(entity) ?? 0) + 1;
        entityGroupCounters.set(entity, groupNum);
        groupMap.set(canonical, groupNum);
      }

      const aliasIdx = aliasMap.get(canonical) ?? 0;
      aliasMap.set(canonical, aliasIdx + 1);

      return {
        ...item,
        tokenSuffix: `${groupNum}${indexToLetter(aliasIdx)}`,
      };
    });

    // 최장일치: 긴 용어 먼저
    const sorted = [...termsWithSuffix].sort((a, b) => b.term.length - a.term.length);

    const pats: string[] = [];
    sorted.forEach((item, i) => {
      const name = `t${i}`;
      this.entityOf.set(name, [item.entity, item.term, item.canonical ?? item.term, item.boundary, item.tokenSuffix]);
      const body = item.term.split(/\s+/).map((p) => escapeRe(p)).join("\\s+");
      const [left, right] = DenyListMatcher.guards(item.term, item.boundary);
      pats.push(`(?<${name}>${left}${body}${right})`);
    });

    this.re = pats.length
      ? new RegExp(pats.join("|"), caseInsensitiveAscii ? "gi" : "g")
      : null;
  }

  private static guards(term: string, boundary?: "strict"): [string, string] {
    const first = term[0];
    const last = term[term.length - 1];

    let left = "";
    if (isAsciiW(first)) {
      left = `(?<![A-Za-z0-9])`;
    } else if (boundary === "strict" && isHangulOrCjk(first)) {
      left = `(?<![\\uac00-\\ud7a3\\u1100-\\u11ff\\u3130-\\u318f\\u4e00-\\u9fff\\u3400-\\u4dbf])`;
    }

    let right = "";
    if (isAsciiW(last)) {
      right = `(?![A-Za-z0-9])`;
    }

    return [left, right];
  }

  find(text: string): Span[] {
    // PERF-41: Instant O(1) bypass if text is shorter than minimum term length
    if (!this.re || !text || text.length < this.minTermLength) return [];
    // PERF-52: Skip regex execution if all terms are ASCII alphanumeric and text contains no alphanumeric characters
    if (!this.hasNonAsciiTerms && !/[A-Za-z0-9]/.test(text)) return [];
    const rawMatches: Span[] = [];
    this.re.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = this.re.exec(text))) {
      const groups = m.groups ?? {};
      const groupName = Object.keys(groups).find((k) => groups[k] !== undefined);
      if (!groupName) {
        if (m[0].length === 0) this.re.lastIndex++;
        continue;
      }
      const [entity, , canonical, , tokenSuffix] = this.entityOf.get(groupName)!;
      rawMatches.push({
        start: m.index,
        end: m.index + m[0].length,
        entity,
        surface: m[0],
        canonical,
        tokenSuffix,
      });
      if (m[0].length === 0) {
        this.re.lastIndex++;
      }
    }

    // 겹침 해소: 시작 위치 오름차순 -> 길이 내림차순 정렬 후 non-overlapping 선택
    rawMatches.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return (b.end - b.start) - (a.end - a.start);
    });

    const result: Span[] = [];
    let lastEnd = -1;
    for (const span of rawMatches) {
      if (span.start >= lastEnd) {
        result.push(span);
        lastEnd = span.end;
      }
    }

    return result;
  }
}

export class CompositeMatcher implements Matcher {
  private matchers: Matcher[];

  constructor(matchers: Matcher[]) {
    this.matchers = matchers;
  }

  find(text: string): Span[] {
    // PERF-47: Instant fast-path for empty or single matcher to avoid flatMap and re-sorting
    if (this.matchers.length === 0) return [];
    if (this.matchers.length === 1) return this.matchers[0].find(text);

    const all = this.matchers.flatMap((m) => m.find(text));
    all.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return (b.end - b.start) - (a.end - a.start);
    });

    const result: Span[] = [];
    let lastEnd = -1;
    for (const span of all) {
      if (span.start >= lastEnd) {
        result.push(span);
        lastEnd = span.end;
      }
    }
    return result;
  }
}

