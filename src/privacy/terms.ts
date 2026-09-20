import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ConfigurationError } from "../errors.ts";
import { DenyListMatcher, CompositeMatcher, type TermEntryForMatcher } from "./matcher.ts";
import { PatternMatcher, PRESET_PATTERNS, type PatternRule } from "./patterns.ts";
import { indexToLetter } from "./mapping.ts";

export const TermEntrySchema = z.union([
  z.string().min(1),
  z.object({
    term: z.string().min(1),
    boundary: z.literal("strict").optional(),
    allow_short: z.boolean().optional(),
  }),
]);

export const CategoryDefSchema = z.union([
  z.array(TermEntrySchema),
  z.object({
    terms: z.array(TermEntrySchema).optional(),
    patterns: z.array(z.string().min(1)).optional(),
  }),
]);

export const TermsFileSchema = z.record(
  z.string().regex(/^[A-Z][A-Z0-9_]*$/, "분류명은 대문자로 시작하는 [A-Z0-9_] 여야 함"),
  CategoryDefSchema
);

export interface TermItem {
  term: string;
  canonical?: string;
  boundary?: "strict";
  allow_short?: boolean;
  tokenSuffix?: string;
}

export interface CategoryInfo {
  name: string;
  terms: TermItem[];
  patterns: string[];
  commentedOutCount: number;
  maxGroupIndex?: number;
}

export class TermSet {
  readonly categories: Map<string, CategoryInfo>;
  private cachedMatchers: {
    tokenFormat: string;
    denyListMatcher: DenyListMatcher;
    patternMatcher: PatternMatcher;
    compositeMatcher: CompositeMatcher;
  } | null = null;

  constructor(categories: Map<string, CategoryInfo>) {
    this.categories = categories;
  }

  getCompiledMatchers(tokenFormat?: string) {
    const fmt = tokenFormat ?? "<{type}_{n}>";
    if (this.cachedMatchers && this.cachedMatchers.tokenFormat === fmt) {
      return this.cachedMatchers;
    }

    const termItems: TermEntryForMatcher[] = [];
    for (const [catName, catInfo] of this.categories.entries()) {
      for (const item of catInfo.terms) {
        termItems.push({
          entity: catName,
          term: item.term,
          canonical: item.canonical,
          boundary: item.boundary,
          tokenSuffix: item.tokenSuffix,
        });
      }
    }

    const denyListMatcher = new DenyListMatcher(termItems);

    const customPatternRules: PatternRule[] = [];
    for (const pat of this.activePatterns()) {
      customPatternRules.push({ entity: pat.category, regex: pat.regex });
    }
    const patternMatcher = new PatternMatcher([...PRESET_PATTERNS, ...customPatternRules]);
    const compositeMatcher = new CompositeMatcher([denyListMatcher, patternMatcher]);

    this.cachedMatchers = {
      tokenFormat: fmt,
      denyListMatcher,
      patternMatcher,
      compositeMatcher,
    };

    return this.cachedMatchers;
  }

  private cachedActivePatterns: { category: string; regex: RegExp }[] | null = null;

  activeTerms(): string[] {
    const list: string[] = [];
    for (const cat of this.categories.values()) {
      for (const t of cat.terms) {
        list.push(t.term);
      }
    }
    return list;
  }

  activePatterns(): { category: string; regex: RegExp }[] {
    if (this.cachedActivePatterns) {
      return this.cachedActivePatterns;
    }
    const list: { category: string; regex: RegExp }[] = [];
    const seenPatterns = new Set<string>();

    for (const cat of this.categories.values()) {
      for (const pat of cat.patterns) {
        // SEC-80: Deduplicate by pattern string alone across categories — first declaration wins
        if (seenPatterns.has(pat)) {
          console.warn(
            `[mask] duplicate pattern '${pat}' in category '${cat.name}' skipped (already owned by an earlier category)`
          );
          continue;
        }
        seenPatterns.add(pat);

        try {
          list.push({ category: cat.name, regex: new RegExp(pat, "g") });
        } catch (e: any) {
          throw new ConfigurationError(
            `Invalid regex pattern '${pat}' in category '${cat.name}': ${e.message}`
          );
        }
      }
    }
    this.cachedActivePatterns = list;
    return list;
  }

  get totalTermsCount(): number {
    let count = 0;
    for (const cat of this.categories.values()) {
      count += cat.terms.length;
    }
    return count;
  }

  get totalCommentedOutCount(): number {
    let count = 0;
    for (const cat of this.categories.values()) {
      count += cat.commentedOutCount;
    }
    return count;
  }

  get totalStrictCount(): number {
    let count = 0;
    for (const cat of this.categories.values()) {
      for (const t of cat.terms) {
        if (t.boundary === "strict") count++;
      }
    }
    return count;
  }
}

function countCommentedOutTerms(yamlContent: string, activeCategories: Set<string>): Record<string, number> {
  const lines = yamlContent.split("\n");
  let currentActiveCategory: string | null = null;
  const counts: Record<string, number> = {};

  for (const line of lines) {
    // Check if line starts at column 0 (top-level)
    if (/^\S/.test(line)) {
      const catMatch = line.match(/^([A-Z][A-Z0-9_]*)\s*:/);
      if (catMatch && activeCategories.has(catMatch[1])) {
        currentActiveCategory = catMatch[1];
        if (!counts[currentActiveCategory]) counts[currentActiveCategory] = 0;
      } else {
        currentActiveCategory = null;
      }
      continue;
    }

    // Indented commented-out list item within an active category
    if (currentActiveCategory && /^\s+#\s*-\s+\S+/.test(line)) {
      counts[currentActiveCategory] = (counts[currentActiveCategory] || 0) + 1;
    }
  }

  return counts;
}

interface TermsMergeState {
  categoryMap: Map<string, CategoryInfo>;
  termToCategory: Map<string, string>;
}

function freshMergeState(): TermsMergeState {
  return { categoryMap: new Map(), termToCategory: new Map() };
}

/** 단일 YAML 텍스트를 파싱·검증해 누적 상태에 병합한다. fs를 쓰지 않는 순수 함수. */
function mergeTermsContent(
  content: string,
  sourceLabel: string,
  state: TermsMergeState
): void {
  const { categoryMap, termToCategory } = state;

  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (e: any) {
    throw new ConfigurationError(`YAML parse error in ${sourceLabel}: ${e.message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    return;
  }

  const valResult = TermsFileSchema.safeParse(parsed);
  if (!valResult.success) {
    const msgs = valResult.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    throw new ConfigurationError(`Validation error in ${sourceLabel}: ${msgs}`);
  }

  const data = valResult.data;
  const activeCategories = new Set(Object.keys(data));
  const commentedOutCounts = countCommentedOutTerms(content, activeCategories);

  for (const [catName, def] of Object.entries(data)) {
    if (!categoryMap.has(catName)) {
      categoryMap.set(catName, {
        name: catName,
        terms: [],
        patterns: [],
        commentedOutCount: 0,
      });
    }

    const catInfo = categoryMap.get(catName)!;
    catInfo.commentedOutCount += commentedOutCounts[catName] || 0;

    let rawTerms: (string | { term: string; boundary?: "strict"; allow_short?: boolean })[] = [];
    let rawPatterns: string[] = [];

    if (Array.isArray(def)) {
      rawTerms = def;
    } else {
      if (def.terms) rawTerms = def.terms;
      if (def.patterns) rawPatterns = def.patterns;
    }

    for (const p of rawPatterns) {
      if (!catInfo.patterns.includes(p)) {
        // S-09: ReDoS validation
        if (p.length > 200) {
          throw new ConfigurationError(
            `Pattern in category '${catName}' exceeds maximum length of 200: '${p}'`
          );
        }
        const nestedQuantifier = /\([^)]*[\*\+][^)]*\)[\*\+]|\([^)]*\{[0-9]+,?[0-9]*\}[^)]*\)[\*\+]|\([^)]*[\*\+][^)]*\)\{[0-9]+,?[0-9]*\}|[\*\+]{2,}/;
        if (nestedQuantifier.test(p)) {
          throw new ConfigurationError(
            `Potential catastrophic backtracking (ReDoS) detected in pattern '${p}' of category '${catName}'`
          );
        }
        catInfo.patterns.push(p);
      }
    }

    let groupIndex = catInfo.maxGroupIndex ?? 0;
    for (const item of rawTerms) {
      const rawStr = typeof item === "string" ? item : item.term;
      const boundary = typeof item === "object" ? item.boundary : undefined;
      const allowShort = typeof item === "object" ? item.allow_short : undefined;

      const surfaces = rawStr
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      if (surfaces.length === 0) {
        throw new ConfigurationError(
          `Empty or whitespace-only term found in category '${catName}' in ${sourceLabel}`
        );
      }

      const canonical = surfaces[0];

      // If this canonical was already registered in the category, reuse its group index; otherwise increment
      const existingWithCanonical = catInfo.terms.find((t) => t.canonical === canonical);
      let thisGroupIndex: number;
      if (existingWithCanonical && existingWithCanonical.tokenSuffix) {
        const m = existingWithCanonical.tokenSuffix.match(/^(\d+)/);
        thisGroupIndex = m ? parseInt(m[1], 10) : ++groupIndex;
      } else {
        thisGroupIndex = ++groupIndex;
      }
      catInfo.maxGroupIndex = Math.max(catInfo.maxGroupIndex ?? 0, thisGroupIndex);

      for (let aliasIdx = 0; aliasIdx < surfaces.length; aliasIdx++) {
        const termStr = surfaces[aliasIdx];
        const tokenSuffix = `${thisGroupIndex}${indexToLetter(aliasIdx)}`;

        // SEC-49: Reject terms containing unprintable control characters to prevent parser corruption
        if (/[\x00-\x1f\x7f]/.test(termStr)) {
          throw new ConfigurationError(
            `Term '${termStr}' in category '${catName}' contains forbidden control characters`
          );
        }

        if (termStr.length === 1 && !allowShort) {
          throw new ConfigurationError(
            `1-character term '${termStr}' in category '${catName}' requires allow_short: true`
          );
        }

        const existingCategory = termToCategory.get(termStr);
        if (existingCategory && existingCategory !== catName) {
          throw new ConfigurationError(
            `Duplicate term '${termStr}' found in different categories: '${existingCategory}' and '${catName}'`
          );
        }
        termToCategory.set(termStr, catName);

        const prev = catInfo.terms.find((t) => t.term === termStr);
        if (prev) {
          if ((prev.canonical ?? prev.term) !== canonical) {
            throw new ConfigurationError(
              `Duplicate term '${termStr}' in different alias groups of category '${catName}'`
            );
          }
          continue;
        }
        catInfo.terms.push({ term: termStr, canonical, boundary, allow_short: allowShort, tokenSuffix });
      }
    }
  }
}

function assertPatternBudget(categoryMap: Map<string, CategoryInfo>): void {
  let totalPatterns = 0;
  for (const cat of categoryMap.values()) {
    totalPatterns += cat.patterns.length;
  }
  if (totalPatterns > 50) {
    throw new ConfigurationError(
      `Total custom patterns count (${totalPatterns}) exceeds maximum limit of 50`
    );
  }
}

/**
 * YAML 텍스트를 파싱·검증해 TermSet을 만든다. fs를 쓰지 않으므로
 * 게이트웨이·웹·오프라인 검사 도구가 같은 함수로 사전을 읽는다.
 */
export function parseTermsYaml(content: string, sourceLabel = "<terms>"): TermSet {
  const state = freshMergeState();
  mergeTermsContent(content, sourceLabel, state);
  assertPatternBudget(state.categoryMap);
  return new TermSet(state.categoryMap);
}

/** fs로 파일·디렉터리를 읽어 텍스트를 만든 뒤 파서에 넘기는 얇은 래퍼. */
export function loadTermsFromFileOrDir(targetPath: string): TermSet {
  if (!fs.existsSync(targetPath)) {
    throw new ConfigurationError(`Terms file or directory does not exist: ${targetPath}`);
  }

  const stat = fs.statSync(targetPath);
  const files: string[] = [];

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(targetPath);
    for (const entry of entries) {
      if (entry.endsWith(".yaml") || entry.endsWith(".yml")) {
        files.push(path.join(targetPath, entry));
      }
    }
    if (files.length === 0) {
      throw new ConfigurationError(`No .yaml files found in terms directory: ${targetPath}`);
    }
  } else {
    files.push(targetPath);
  }

  const state = freshMergeState();

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    mergeTermsContent(content, file, state);
  }

  assertPatternBudget(state.categoryMap);

  return new TermSet(state.categoryMap);
}
