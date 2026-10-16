/**
 * 치환 일시정지(bypass) 윈도우 — 인메모리 단일 상태.
 *
 * `/_mask/bypass` API로 활성화하면 유효시간 동안 프록시가 민감어 치환과
 * 송신 가드(assertNoLeak)를 모두 건너뛴다. 설계 상수:
 *
 * - 우회는 의도적 유출 통로이므로 활성화 시각·만료 시각을 활동 로그로 남긴다.
 * - 만료는 타이머 없이 요청 시점 lazy 체크 — 시간이 지나면 그 요청부터 자동 재개.
 * - 상태는 메모리에만 존재 → 서버 재시작 시 반드시 치환 on으로 원복(안전 기본값).
 * - 지속시간은 MAX_BYPASS_MINUTES로 상한 캡 — 잊고 켜두는 사고를 줄인다.
 */

export const MAX_BYPASS_MINUTES = 1440;

let bypassUntilEpochMs = 0;

/** bypass 활성화. minutes는 1..MAX_BYPASS_MINUTES 정수 (호출부에서 검증). returns epoch ms of expiry. */
export function setBypass(minutes: number, now: number = Date.now()): number {
  bypassUntilEpochMs = now + minutes * 60_000;
  return bypassUntilEpochMs;
}

/** bypass 즉시 해제 — 원래대로 치환 재개. */
export function clearBypass(): void {
  bypassUntilEpochMs = 0;
}

export function getBypassUntil(): number {
  return bypassUntilEpochMs;
}

/** 요청 시점 lazy 만료 체크. 만료된 상태를 만나면 즉시 원복한다. */
export function isBypassActive(now: number = Date.now()): boolean {
  if (bypassUntilEpochMs === 0) return false;
  if (now >= bypassUntilEpochMs) {
    bypassUntilEpochMs = 0;
    return false;
  }
  return true;
}

export function resetBypassForTest(): void {
  bypassUntilEpochMs = 0;
}
