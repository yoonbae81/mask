export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

// SEC-67: Strip carriage returns and newlines from event and id to prevent SSE header injection
function sanitizeSseField(val?: string): string | undefined {
  if (!val) return undefined;
  return val.replace(/[\r\n]/g, "");
}

export function formatSseEvent(event: SseEvent): string {
  // PERF-51: Use array join for fast single allocation instead of iterative string concatenation
  const lines: string[] = [];

  const sanitizedEvent = sanitizeSseField(event.event);
  if (sanitizedEvent) {
    lines.push(`event: ${sanitizedEvent}`);
  }

  const sanitizedId = sanitizeSseField(event.id);
  if (sanitizedId) {
    lines.push(`id: ${sanitizedId}`);
  }

  if (event.retry !== undefined && Number.isFinite(event.retry)) {
    lines.push(`retry: ${Math.max(0, Math.floor(event.retry))}`);
  }

  // SEC-67: Strip \r to prevent carriage-return injection in data lines
  const cleanData = event.data ? event.data.replace(/\r/g, "") : "";
  for (const line of cleanData.split("\n")) {
    lines.push(`data: ${line}`);
  }

  return lines.join("\n") + "\n\n";
}
