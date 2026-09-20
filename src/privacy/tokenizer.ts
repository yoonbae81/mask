import type { Matcher } from "./matcher.ts";
import type { TokenMap } from "./mapping.ts";

export interface TokenizeOptions {
  // \ + 등록 용어 조건의 1회성 마스킹 우회 허용 여부 (MASK_TERM_ESCAPE)
  escapeBypass?: boolean;
  bypassedSurfaces?: Set<string>;
  bypassedCounts?: Map<string, number>;
}

const ESCAPED_OR_TOKEN_PATTERN = /(<<[A-Z][A-Z0-9_]*_[0-9]+[A-Z]*>>)|<([A-Z][A-Z0-9_]*_[0-9]+[A-Z]*)>/g;

export function tokenize(
  text: string,
  matcher: Matcher,
  tokenMap: TokenMap,
  options: TokenizeOptions = {}
): string {
  if (!text) return "";
  // SEC-25, SEC-37, SEC-47, SEC-77 & SEC-78: Sanitize BOM (anywhere), Mongolian vowel
  // separator, soft hyphen, zero-width/bidi controls, null bytes, and unpaired surrogates
  const sanitized = text
    .replace(/\uFEFF/g, "")
    .replace(/\u180E/g, "")
    .replace(/\u00AD/g, "")
    .replace(/\0/g, "")
    .replace(/[\u200B-\u200D\u2060]/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

  // PERF-18: Fast-path for whitespace-only strings
  if (sanitized.trim().length === 0) return sanitized;

  // SEC-19 & SEC-43: Escape unmapped raw tokens to avoid collision, strictly sanitizing nested delimiters
  let processed = sanitized.replace(ESCAPED_OR_TOKEN_PATTERN, (match, alreadyEscaped, rawToken) => {
    if (alreadyEscaped) {
      return alreadyEscaped;
    }
    // SEC-43: Ensure delimiter safety in token string
    const safeRawToken = String(rawToken).replace(/[<>]/g, "");
    const tokenStr = `<${safeRawToken}>`;
    if (!tokenMap.hasToken(tokenStr)) {
      tokenMap.addEscapedToken(tokenStr);
      return `<${tokenStr}>`; // e.g. <<PROJECT_1>>
    }
    return tokenStr;
  });

  // 2. 매처 실행
  const spans = matcher.find(processed);
  if (spans.length === 0) {
    return processed;
  }

  // 3. 치환 (토큰은 텍스트 순방향으로 생성, 인덱스 보존을 위해 역순 치환)
  const tokens: (string | undefined)[] = new Array(spans.length);
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (
      options.escapeBypass === true &&
      span.start > 0 &&
      processed[span.start - 1] === "\\"
    ) {
      continue;
    }
    tokens[i] = tokenMap.getOrCreateToken(span.entity, span.surface, span.tokenSuffix);
  }
  let result = processed;
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    if (tokens[i] === undefined) {
      // \ + 등록 용어: 이 occurrence 는 마스킹하지 않고 백슬래시만 제거한다.
      // 매칭되지 않은 단어 앞의 \ 는 원문 그대로 남는다.
      result = result.slice(0, span.start - 1) + span.surface + result.slice(span.end);
      options.bypassedSurfaces?.add(span.surface);
      const count = options.bypassedCounts?.get(span.entity) ?? 0;
      options.bypassedCounts?.set(span.entity, count + 1);
      continue;
    }
    result =
      result.slice(0, span.start) + tokens[i] + result.slice(span.end);
  }

  return result;
}
