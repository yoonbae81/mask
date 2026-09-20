import { TransformStream } from "node:stream/web";
import type { TokenMap } from "../privacy/mapping.ts";
import { detokenize } from "../privacy/detokenizer.ts";
import { splitAtPossibleTokenBoundary } from "./rolling.ts";

// SEC-68/69 계열: 홀드가 풀리지 않는 스트림에서 이벤트가 무한 적체되는 것을 방지
const MAX_HELD_EVENTS = 1024;

const sharedEncoder = new TextEncoder();

type JsonPath = (string | number)[];

interface QueuedEvent {
  lines: string[];
  dataIdx: number[];
  json: unknown;
  appends: Map<string, { path: JsonPath; text: string }>;
  rawPayload: string | null;
  rawAppend: string;
  passthrough: string | null;
}

function isPlainObject(node: unknown): node is Record<string, unknown> {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

function appendStringAt(node: unknown, path: JsonPath, text: string): void {
  let cur: unknown = node;
  for (let i = 0; i < path.length - 1; i++) {
    cur = (cur as Record<string | number, unknown>)[path[i]];
  }
  const key = path[path.length - 1];
  const parent = cur as Record<string | number, unknown>;
  parent[key] = (parent[key] as string) + text;
}

export class SseDetokenizer extends TransformStream<Uint8Array, Uint8Array> {
  constructor(tokenMap: TokenMap) {
    let pending = "";
    const decoder = new TextDecoder("utf-8");
    const holds = new Map<string, { text: string; path: JsonPath }>();
    let rawHold = "";
    const queue: QueuedEvent[] = [];

    const holdsActive = () => holds.size > 0 || rawHold !== "";

    const renderEvent = (lines: string[], dataIdx: number[], payload: string): string => {
      const out: string[] = [];
      let dataSeen = 0;
      for (let i = 0; i < lines.length; i++) {
        if (dataIdx.includes(i)) {
          if (dataSeen === 0) out.push(`data: ${payload}`);
          dataSeen++;
        } else {
          out.push(lines[i]);
        }
      }
      return out.join("\n") + "\n\n";
    };

    const drainUnresolved = (enqueue: (c: Uint8Array) => void): void => {
      for (const item of queue) {
        if (item.passthrough !== null) {
          enqueue(sharedEncoder.encode(item.passthrough));
          continue;
        }
        let payload: string;
        if (item.json !== null) {
          for (const { path, text } of item.appends.values()) {
            appendStringAt(item.json, path, text);
          }
          payload = JSON.stringify(item.json);
        } else {
          payload = (item.rawPayload ?? "") + item.rawAppend;
        }
        enqueue(sharedEncoder.encode(renderEvent(item.lines, item.dataIdx, payload)));
      }
      queue.length = 0;
      holds.clear();
      rawHold = "";
    };

    const emitOrQueue = (
      enqueue: (c: Uint8Array) => void,
      item: QueuedEvent
    ): void => {
      if (holdsActive()) {
        queue.push(item);
        if (queue.length > MAX_HELD_EVENTS) drainUnresolved(enqueue);
        return;
      }
      if (queue.length > 0) {
        for (const q of queue) {
          if (q.passthrough !== null) {
            enqueue(sharedEncoder.encode(q.passthrough));
          } else if (q.json !== null) {
            enqueue(sharedEncoder.encode(renderEvent(q.lines, q.dataIdx, JSON.stringify(q.json))));
          } else {
            enqueue(sharedEncoder.encode(renderEvent(q.lines, q.dataIdx, q.rawPayload ?? "")));
          }
        }
        queue.length = 0;
      }
      enqueue(
        sharedEncoder.encode(
          item.passthrough ??
            renderEvent(
              item.lines,
              item.dataIdx,
              item.json !== null ? JSON.stringify(item.json) : (item.rawPayload ?? "")
            )
        )
      );
    };

    const processEvent = (rawEvent: string, enqueue: (c: Uint8Array) => void): void => {
      const lines = rawEvent.split("\n");
      const dataIdx: number[] = [];
      const payloads: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
        if (line.startsWith("data:")) {
          dataIdx.push(i);
          payloads.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
        }
      }

      if (dataIdx.length === 0) {
        emitOrQueue(enqueue, {
          lines,
          dataIdx,
          json: null,
          appends: new Map(),
          rawPayload: null,
          rawAppend: "",
          passthrough: rawEvent + "\n\n",
        });
        return;
      }

      const joined = payloads.join("\n");

      if (joined.trim() === "[DONE]") {
        drainUnresolved(enqueue);
        emitOrQueue(enqueue, {
          lines,
          dataIdx,
          json: null,
          appends: new Map(),
          rawPayload: null,
          rawAppend: "",
          passthrough: rawEvent + "\n\n",
        });
        return;
      }

      if (joined.trim() === "") {
        emitOrQueue(enqueue, {
          lines,
          dataIdx,
          json: null,
          appends: new Map(),
          rawPayload: null,
          rawAppend: "",
          passthrough: rawEvent + "\n\n",
        });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(joined);
      } catch {
        parsed = undefined;
      }

      if (isPlainObject(parsed) || Array.isArray(parsed)) {
        const appends = new Map<string, { path: JsonPath; text: string }>();
        let changed = false;
        const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

        const walk = (node: unknown, path: JsonPath): unknown => {
          if (typeof node === "string") {
            const key = path.join(".");
            const prev = holds.get(key)?.text ?? "";
            const full = prev + node;
            const { emit, hold } = splitAtPossibleTokenBoundary(full, tokenMap);
            if (hold) {
              holds.set(key, { text: hold, path });
              appends.set(key, { path, text: prev ? node : hold });
              changed = true;
              return detokenize(emit, tokenMap);
            }
            holds.delete(key);
            if (prev) changed = true;
            const restored = detokenize(emit, tokenMap);
            if (restored !== node) changed = true;
            return restored;
          }
          if (Array.isArray(node)) {
            return node.map((v, i) => walk(v, [...path, i]));
          }
          if (isPlainObject(node)) {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(node)) {
              if (FORBIDDEN_KEYS.has(k)) {
                throw new Error(`forbidden key in SSE payload: ${k}`);
              }
              out[k] = walk(v, [...path, k]);
            }
            return out;
          }
          return node;
        };

        try {
          const out = walk(parsed, []);
          emitOrQueue(enqueue, {
            lines,
            dataIdx,
            json: out,
            appends,
            rawPayload: null,
            rawAppend: "",
            passthrough: changed ? null : rawEvent + "\n\n",
          });
        } catch {
          // fail-open: 개별 이벤트 처리 실패 시 홀드를 원문으로 반환하고 스트림을 유지한다
          drainUnresolved(enqueue);
          holds.clear();
          rawHold = "";
          enqueue(sharedEncoder.encode(rawEvent + "\n\n"));
        }
        return;
      }

      // 비JSON data payload: 기존 RollingDetokenizer의 raw 텍스트 처리 계열
      const full = rawHold + joined;
      const { emit, hold } = splitAtPossibleTokenBoundary(full, tokenMap);
      const payload = detokenize(emit, tokenMap);
      const rawAppend = rawHold ? joined : hold;
      if (hold) {
        rawHold = hold;
      } else {
        rawHold = "";
      }
      emitOrQueue(enqueue, {
        lines,
        dataIdx,
        json: null,
        appends: new Map(),
        rawPayload: payload,
        rawAppend: hold ? rawAppend : "",
        passthrough: null,
      });
    };

    super({
      transform(chunk, controller) {
        if (tokenMap.size === 0) {
          controller.enqueue(chunk);
          return;
        }
        pending += decoder.decode(chunk, { stream: true });
        const enqueue = (c: Uint8Array) => controller.enqueue(c);
        for (;;) {
          const iLf = pending.indexOf("\n\n");
          const iCrLf = pending.indexOf("\r\n\r\n");
          let idx = -1;
          let sepLen = 0;
          if (iLf !== -1 && (iCrLf === -1 || iLf <= iCrLf)) {
            idx = iLf;
            sepLen = 2;
          } else if (iCrLf !== -1) {
            idx = iCrLf;
            sepLen = 4;
          }
          if (idx === -1) break;
          const event = pending.slice(0, idx);
          pending = pending.slice(idx + sepLen);
          processEvent(event, enqueue);
        }
      },
      flush(controller) {
        pending += decoder.decode();
        const enqueue = (c: Uint8Array) => controller.enqueue(c);
        if (pending !== "") {
          processEvent(pending, enqueue);
          pending = "";
        }
        drainUnresolved(enqueue);
      },
    });
  }
}
