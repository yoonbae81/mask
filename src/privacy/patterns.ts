import type { Matcher, Span } from "./matcher.ts";

export interface PatternRule {
  entity: string;
  regex: RegExp;
}

export const PRESET_PATTERNS: PatternRule[] = [];

export class PatternMatcher implements Matcher {
  private compiledRules: { entity: string; re: RegExp }[];

  constructor(rules: PatternRule[]) {
    this.compiledRules = rules.map((rule) => {
      const flags = rule.regex.flags.includes("g") ? rule.regex.flags : `${rule.regex.flags}g`;
      return {
        entity: rule.entity,
        re: new RegExp(rule.regex.source, flags),
      };
    });
  }

  find(text: string): Span[] {
    if (!text || this.compiledRules.length === 0) return [];
    const spans: Span[] = [];

    for (const { entity, re } of this.compiledRules) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        spans.push({
          start: m.index,
          end: m.index + m[0].length,
          entity,
          surface: m[0],
        });
        if (m[0].length === 0) re.lastIndex++;
      }
    }

    spans.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return (b.end - b.start) - (a.end - a.start);
    });

    const result: Span[] = [];
    let lastEnd = -1;
    for (const span of spans) {
      if (span.start >= lastEnd) {
        result.push(span);
        lastEnd = span.end;
      }
    }

    return result;
  }
}
