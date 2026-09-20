import type { TokenMap } from "./mapping.ts";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ESCAPED_TOKEN_PATTERN = /<<([A-Z][A-Z0-9_]*_[0-9]+[A-Z]*)>>/g;

export function detokenize(text: string, tokenMap: TokenMap): string {
  if (!text) return "";
  // PERF-55: Instant bypass if string is too short to contain tokens (< 3 characters)
  if (text.length < 3) {
    return text;
  }
  // PERF-46: Instant O(1) bypass if text contains no token bracket '<'
  if (!text.includes("<")) {
    return text;
  }
  if (tokenMap.size === 0 && !text.includes("<<")) {
    return text;
  }

  let result = text;
  const entries = tokenMap.entries();

  // 1. 단일 패스로 토큰 복원 (중첩 치환 방지, P-05 캐시 정규식 재사용)
  const pattern = tokenMap.getDetokenizeRegex();
  if (pattern) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => {
      return tokenMap.getOriginal(match) ?? match;
    });
  }

  // 2. 이스케이프되었던 <<TYPE_N>> 패턴을 원래의 <TYPE_N> 으로 복원
  result = result.replace(ESCAPED_TOKEN_PATTERN, "<$1>");

  return result;
}
