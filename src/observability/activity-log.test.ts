import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ActivityLog, setActivitySink, type ActivityEvent } from "./activity-log.ts";

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    requestId: "req-1",
    provider: "anthropic",
    dialect: "anthropic",
    masked: { COMPANY: 2 },
    guardTripped: false,
    ...overrides,
  };
}

describe("activity-log sink", () => {
  afterEach(() => {
    setActivitySink(null);
  });

  it("delivers recorded events to the sink", () => {
    const log = new ActivityLog(4);
    const seen: ActivityEvent[] = [];
    setActivitySink((e) => seen.push(e));

    log.record(event());

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].provider, "anthropic");
    assert.strictEqual(seen[0].masked.COMPANY, 2);
  });

  it("still buffers when no sink is set", () => {
    const log = new ActivityLog(4);

    log.record(event());

    assert.strictEqual(log.getEvents().length, 1);
  });

  it("delivers the sanitized event (requestId truncated, SEC-23 parity)", () => {
    const log = new ActivityLog(4);
    const seen: ActivityEvent[] = [];
    setActivitySink((e) => seen.push(e));

    log.record(event({ requestId: "x".repeat(100) }));

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].requestId.length, 64);
  });
});
