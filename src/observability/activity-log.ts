export interface ActivityEvent {
  ts: string | number;
  requestId: string;
  provider: string;
  dialect: string;
  masked: Record<string, number>;
  bypassed?: Record<string, number>;
  guardTripped: boolean;
  translated?: boolean;
  upstreamStatus?: number;
  durationMs?: number;
}

// 관찰성 싱크: record() 되는 마스킹 이벤트를 구조화 로그로도 내보낸다 (journalctl 대응).
// 이벤트에는 민감 원문이 아닌 카테고리별 건수만 담긴다.
export type ActivitySink = (event: ActivityEvent) => void;

let sink: ActivitySink | null = null;

export function setActivitySink(fn: ActivitySink | null): void {
  sink = fn;
}

export class ActivityLog {
  private readonly maxSize: number;
  private readonly buffer: (ActivityEvent | null)[];
  private head = 0;
  private count = 0;

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
    this.buffer = new Array(maxSize).fill(null);
  }

  record(event: ActivityEvent) {
    // SEC-23: Truncate requestId to max 64 characters to avoid unbounded memory usage from spoofed client IDs
    const sanitizedEvent: ActivityEvent =
      event.requestId.length > 64
        ? { ...event, requestId: event.requestId.slice(0, 64) }
        : event;

    this.buffer[this.head] = sanitizedEvent;
    this.head = (this.head + 1) % this.maxSize;
    if (this.count < this.maxSize) {
      this.count++;
    }

    if (sink) sink(sanitizedEvent);
  }

  getEvents(limit = 50): (ActivityEvent & { ts: string })[] {
    const n = Math.min(this.count, limit);
    // PERF-53: Fast-path return empty array when count is 0
    if (n === 0) return [];
    // PERF-30 & PERF-44: Pre-allocated array with lazy ISO timestamp formatting
    const events: (ActivityEvent & { ts: string })[] = new Array(n);
    let idx = (this.head - 1 + this.maxSize) % this.maxSize;
    for (let i = 0; i < n; i++) {
      const item = this.buffer[idx]!;
      events[i] = {
        ...item,
        ts: typeof item.ts === "number" ? new Date(item.ts).toISOString() : item.ts,
      };
      idx = (idx - 1 + this.maxSize) % this.maxSize;
    }
    return events;
  }

  clear() {
    this.buffer.fill(null);
    this.head = 0;
    this.count = 0;
  }
}

export const activityLog = new ActivityLog(200);
