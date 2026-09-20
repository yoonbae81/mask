/**
 * 브라우저 저장 계층 — 서버 저장 없음(§ WEB 저장 설계).
 *  - localStorage: 초안(mask/restore), 테마, 가이드 스누즈
 *  - IndexedDB(idb-keyval): 개인 사전, 매핑(원문 포함)
 * localStorage 쓰기 실패(용량·시크릿 모드)는 무시한다.
 */
import { get, set, del } from "idb-keyval";
import type { SerializedMapping } from "./engine.ts";

export const DRAFT_MASK_KEY = "mask:draft:mask";
export const DRAFT_RESTORE_KEY = "mask:draft:restore";
export const THEME_KEY = "mask:theme";
export const GUIDE_KEY = "mask:guide";
export const TERMS_KEY = "mask:terms";
export const MAPPING_KEY = "mask:mapping";

export const GUIDE_SNOOZE_MS = 24 * 60 * 60 * 1000;

export interface PersonalTerms {
  name: string;
  text: string;
  mtime: number;
}

export interface StoredMapping {
  id: string;
  createdAt: number;
  mapping: SerializedMapping;
}

export const MAX_LOCAL_STORAGE_BYTES = 500_000;
export const MAX_STORED_TERMS_BYTES = 2_000_000;
export const MAX_STORED_MAPPING_ENTRIES = 10_000;

export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string): void {
  if (value.length > MAX_LOCAL_STORAGE_BYTES) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // 용량 초과 등 — 초안 저장은 저장되지 않아도 무시
  }
}

export function removeLocal(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 무시
  }
}

export function guideSnoozed(): boolean {
  const raw = readLocal(GUIDE_KEY);
  if (!raw) return false;
  const ts = Number(raw);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < GUIDE_SNOOZE_MS;
}

export function snoozeGuide(): void {
  writeLocal(GUIDE_KEY, String(Date.now()));
}

export async function loadPersonalTerms(): Promise<PersonalTerms | null> {
  try {
    return (await get<PersonalTerms>(TERMS_KEY)) ?? null;
  } catch {
    return null;
  }
}

export async function savePersonalTerms(terms: PersonalTerms): Promise<void> {
  if (terms.text.length > MAX_STORED_TERMS_BYTES) {
    throw new Error("개인 사전 크기가 최대 허용치(2MB)를 초과했습니다.");
  }
  await set(TERMS_KEY, terms);
}

export async function loadStoredMapping(): Promise<StoredMapping | null> {
  try {
    return (await get<StoredMapping>(MAPPING_KEY)) ?? null;
  } catch {
    return null;
  }
}

export async function saveStoredMapping(mapping: SerializedMapping): Promise<StoredMapping> {
  if (mapping.entries && mapping.entries.length > MAX_STORED_MAPPING_ENTRIES) {
    throw new Error("매핑 항목 수가 최대 허용치(10,000개)를 초과했습니다.");
  }
  const stored: StoredMapping = {
    id: `map-${Date.now().toString(36)}`,
    createdAt: Date.now(),
    mapping,
  };
  await set(MAPPING_KEY, stored);
  return stored;
}

/** 사용자의 모든 로컬 데이터(초안, 개인 사전, 세션 매핑)를 영구 삭제한다 (개인정보 보호 조치). */
export async function clearAllLocalData(): Promise<void> {
  removeLocal(DRAFT_MASK_KEY);
  removeLocal(DRAFT_RESTORE_KEY);
  removeLocal(GUIDE_KEY);
  try {
    await del(TERMS_KEY);
    await del(MAPPING_KEY);
  } catch {
    // 무시
  }
}
