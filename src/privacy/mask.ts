import { ConfigurationError } from "../errors.ts";
import { assertNoLeakGuard, scanPayloadForLeaks } from "./guard.ts";
import { detokenize } from "./detokenizer.ts";
import { TokenMap, type SerializedMapping } from "./mapping.ts";
import type { Matcher } from "./matcher.ts";
import { parseTermsYaml, type TermSet } from "./terms.ts";
import { tokenize } from "./tokenizer.ts";

export interface MaskSessionOptions {
  tokenFormat?: string;
  guard?: "on" | "off";
  // \ + 등록 용어 1회성 우회 허용 (MASK_TERM_ESCAPE)
  termEscape?: boolean;
}

export interface MaskResult {
  masked: string;
  mapping: SerializedMapping;
  leak: boolean;
  categories: Record<string, number>;
  counts: Record<string, number>;
}

export interface RestoreResult {
  text: string;
  restored: number;
}

export class MaskSession {
  readonly tokenMap: TokenMap;
  private readonly matcher: Matcher;
  private readonly terms: TermSet;
  private readonly guard: "on" | "off";
  private readonly termEscape: boolean;
  private readonly bypassedSurfaces = new Set<string>();
  private readonly bypassedCounts = new Map<string, number>();

  constructor(terms: TermSet | string, options: MaskSessionOptions = {}) {
    this.terms = typeof terms === "string" ? parseTermsYaml(terms) : terms;
    this.matcher = this.terms.getCompiledMatchers(options.tokenFormat).compositeMatcher;
    this.tokenMap =
      options.tokenFormat === undefined
        ? new TokenMap()
        : new TokenMap({ tokenFormat: options.tokenFormat });
    this.guard = options.guard ?? "on";
    this.termEscape = options.termEscape ?? false;
  }

  mask(text: string): string {
    return tokenize(text, this.matcher, this.tokenMap, {
      escapeBypass: this.termEscape,
      bypassedSurfaces: this.bypassedSurfaces,
      bypassedCounts: this.bypassedCounts,
    });
  }

  restore(text: string): string {
    return detokenize(text, this.tokenMap);
  }

  // 우회된 occurrence 는 의도된 유출이므로 가드 스캔 전에 본문에서 걷어낸다
  private stripBypassed(text: string): string {
    if (this.bypassedSurfaces.size === 0) return text;
    let out = text;
    for (const surface of this.bypassedSurfaces) {
      out = out.split(surface).join("");
    }
    return out;
  }

  scan(text: string): Record<string, number> {
    return scanPayloadForLeaks(this.stripBypassed(text), this.terms);
  }

  assertNoLeak(text: string): void {
    assertNoLeakGuard(this.stripBypassed(text), this.terms, this.guard);
  }

  getMapping(): SerializedMapping {
    return this.tokenMap.toSerialized();
  }

  getCounts(): Record<string, number> {
    return this.tokenMap.getCategoriesCount();
  }

  getBypassedCounts(): Record<string, number> {
    return Object.fromEntries(this.bypassedCounts);
  }
}

export function maskText(
  input: string,
  termsYaml: string,
  options: MaskSessionOptions = {}
): MaskResult {
  const session = new MaskSession(termsYaml, options);
  const masked = session.mask(input);
  const categories = session.scan(masked);
  return {
    masked,
    mapping: session.getMapping(),
    leak: Object.keys(categories).length > 0,
    categories,
    counts: session.getCounts(),
  };
}

function parseMappingData(mapping: SerializedMapping | string): SerializedMapping {
  if (typeof mapping !== "string") {
    return mapping;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(mapping);
  } catch {
    throw new ConfigurationError("Invalid mapping data: not valid JSON");
  }
  return parsed as SerializedMapping;
}

export function restoreText(
  masked: string,
  mapping: SerializedMapping | string
): RestoreResult {
  const tokenMap = TokenMap.fromSerialized(parseMappingData(mapping));
  let restored = 0;
  const pattern = tokenMap.getDetokenizeRegex();
  if (pattern) {
    pattern.lastIndex = 0;
    const matches = masked.match(pattern);
    restored = matches ? matches.length : 0;
  }
  return { text: detokenize(masked, tokenMap), restored };
}
