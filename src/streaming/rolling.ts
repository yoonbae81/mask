import { TransformStream } from "node:stream/web";
import type { TokenMap } from "../privacy/mapping.ts";
import { detokenize } from "../privacy/detokenizer.ts";

const PARTIAL_TOKEN_REGEX = /<(?:[A-Z][A-Z0-9_]*(?:_\d*)?)?$/;

export function splitAtPossibleTokenBoundary(
  pending: string,
  tokenMap: TokenMap
): { emit: string; hold: string } {
  // PERF-23: Fast-path: if pending contains no '<', it cannot be a partial token boundary
  if (!pending.includes("<")) {
    return { emit: pending, hold: "" };
  }

  const match = PARTIAL_TOKEN_REGEX.exec(pending);
  if (!match) {
    return { emit: pending, hold: "" };
  }

  const matchIndex = match.index;
  const matchLen = pending.length - matchIndex;

  if (matchLen <= tokenMap.maxTokenLength) {
    // PERF-37: Avoid unnecessary string allocation if matchIndex is 0
    return {
      emit: matchIndex === 0 ? "" : pending.slice(0, matchIndex),
      hold: pending.slice(matchIndex),
    };
  }

  return { emit: pending, hold: "" };
}

const sharedEncoder = new TextEncoder();

// SEC-68: Maximum pending characters before forcing a flush to prevent memory exhaustion DoS
const MAX_PENDING_CHARS = 65_536;

export class RollingDetokenizer extends TransformStream<Uint8Array, Uint8Array> {
  constructor(tokenMap: TokenMap) {
    let pending = "";
    const decoder = new TextDecoder("utf-8");

    super({
      transform(chunk, controller) {
        const decoded = decoder.decode(chunk, { stream: true });
        // PERF-36: If pending is empty and decoded chunk has no '<' and tokenMap is empty, passthrough chunk directly
        if (pending === "" && !decoded.includes("<") && tokenMap.size === 0) {
          controller.enqueue(chunk);
          return;
        }

        pending += decoded;

        // SEC-68: Guard against unbounded pending growth (e.g. streaming endless unclosed '<' tokens)
        if (pending.length > MAX_PENDING_CHARS) {
          const safeCut = pending.length - (tokenMap.maxTokenLength || 64);
          const flushChunk = pending.slice(0, safeCut);
          controller.enqueue(sharedEncoder.encode(detokenize(flushChunk, tokenMap)));
          pending = pending.slice(safeCut);
        }

        const { emit, hold } = splitAtPossibleTokenBoundary(pending, tokenMap);
        if (emit.length > 0) {
          controller.enqueue(sharedEncoder.encode(detokenize(emit, tokenMap)));
        }
        pending = hold;
      },
      flush(controller) {
        if (pending.length > 0) {
          controller.enqueue(sharedEncoder.encode(detokenize(pending, tokenMap)));
          pending = "";
        }
      },
    });
  }
}
