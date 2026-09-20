/** 토큰 칩 렌더링·복원 하이라이트용 순수 분할 유틸. */
import type { SerializedMapping } from "../../../src/privacy/mapping.ts";

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mappingTokens(mapping: SerializedMapping | null | undefined): string[] {
  if (!mapping || !Array.isArray(mapping.entries)) return [];
  return mapping.entries.map((e) => e.token);
}

export interface Segment {
  text: string;
  token: boolean;
}

export function splitByTokens(text: string, tokens: string[]): Segment[] {
  if (!text || tokens.length === 0) return [{ text, token: false }];
  // SEC-60: Filter out empty or whitespace-only tokens to avoid infinite zero-length matches
  const validTokens = [...new Set(tokens)].filter((t) => t.length > 0);
  if (validTokens.length === 0) return [{ text, token: false }];
  const sorted = validTokens.sort((a, b) => b.length - a.length);
  const re = new RegExp(sorted.map(escapeRegExp).join("|"), "g");
  const segments: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index), token: false });
    segments.push({ text: m[0], token: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) {
      re.lastIndex++;
    }
  }
  if (last < text.length) segments.push({ text: text.slice(last), token: false });
  return segments;
}

export interface RestoreSegment {
  text: string;
  restored: boolean;
}

/** 마스킹된 입력을 토큰 단위로 나눠 원문 치환 + 하이라이트용 세그먼트를 만든다. */
export function restoredSegments(masked: string, mapping: SerializedMapping): RestoreSegment[] {
  const dict = new Map<string, string>();
  for (const entry of mapping.entries ?? []) dict.set(entry.token, entry.term);
  return splitByTokens(masked, [...dict.keys()]).map((seg) =>
    seg.token && dict.has(seg.text)
      ? { text: dict.get(seg.text) ?? seg.text, restored: true }
      : { text: seg.text, restored: false }
  );
}

/** 원문 비공개 표시: "INTERNAL · 5글자" */
export function maskedTermLabel(entity: string, term: string): string {
  return `${entity} · ${term.length} chars`;
}
