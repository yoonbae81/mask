/**
 * mask-web 엔진 진입점 — UI가 마스킹/복원에 접근하는 유일한 API.
 *
 * 서버(src/privacy)와 동일한 TS 구현을 직접 실행한다 — 게이트웨이·웹 단일 출처.
 * 과거에는 WASM 백엔드 승격 경로가 있었으나, 동일 엔진의 이중 사본 유지 비용
 * (QuickJS 기반 4.4MB 모듈 + parity 파이프라인) 대비 이점이 없어 제거했다.
 * TS 경로가 유일한 경로다.
 */
import {
  maskText,
  restoreText,
  type MaskResult,
  type RestoreResult,
} from "../../../src/privacy/mask.ts";
import type { SerializedMapping } from "../../../src/privacy/mapping.ts";
import { parseTermsYaml } from "../../../src/privacy/terms.ts";

export type { MaskResult, RestoreResult, SerializedMapping };

export const MAX_CLIENT_INPUT_LENGTH = 2_000_000;

/** 원문 + 사전 YAML → 마스킹 결과 + 매핑. UI 마스킹 경로의 전부다. */
export async function maskPreview(input: string, termsYaml: string): Promise<MaskResult> {
  if (input.length > MAX_CLIENT_INPUT_LENGTH) {
    throw new Error(`입력 텍스트가 최대 허용 크기(${MAX_CLIENT_INPUT_LENGTH.toLocaleString()}자)를 초과했습니다.`);
  }
  if (termsYaml.length > MAX_CLIENT_INPUT_LENGTH) {
    throw new Error(`사전 텍스트가 최대 허용 크기(${MAX_CLIENT_INPUT_LENGTH.toLocaleString()}자)를 초과했습니다.`);
  }
  return maskText(input, termsYaml);
}

/** LLM 응답(토큰 포함) + 매핑 JSON → 복원 결과. UI 복원 경로의 전부다. */
export async function restorePreview(masked: string, mappingJson: string): Promise<RestoreResult> {
  if (masked.length > MAX_CLIENT_INPUT_LENGTH) {
    throw new Error(`복원 대상 텍스트가 최대 허용 크기(${MAX_CLIENT_INPUT_LENGTH.toLocaleString()}자)를 초과했습니다.`);
  }
  if (mappingJson.length > MAX_CLIENT_INPUT_LENGTH * 2) {
    throw new Error("매핑 데이터가 최대 허용 크기를 초과했습니다.");
  }
  return restoreText(masked, mappingJson);
}

export interface TermsCategorySummary {
  name: string;
  terms: number;
  patterns: number;
  commentedOut: number;
}

export interface TermsValidation {
  ok: boolean;
  error?: string;
  categories: TermsCategorySummary[];
  totalTerms: number;
  totalCommentedOut: number;
}

/** 사전 텍스트 검증(줄 오류는 parseTermsYaml/비정형 파서 메시지에 포함). 순수 클라이언트. */
export function validateTermsYaml(text: string): TermsValidation {
  try {
    const set = parseTermsYaml(text, "dictionary");
    const categories: TermsCategorySummary[] = [];
    let totalTerms = 0;
    let totalCommentedOut = 0;
    for (const cat of set.categories.values()) {
      categories.push({
        name: cat.name,
        terms: cat.terms.length,
        patterns: cat.patterns.length,
        commentedOut: cat.commentedOutCount,
      });
      totalTerms += cat.terms.length;
      totalCommentedOut += cat.commentedOutCount;
    }
    return { ok: true, categories, totalTerms, totalCommentedOut };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      categories: [],
      totalTerms: 0,
      totalCommentedOut: 0,
    };
  }
}
