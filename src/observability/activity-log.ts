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
