import { TransformStream } from "node:stream/web";
import type { TokenMap } from "../privacy/mapping.ts";
import { detokenize } from "../privacy/detokenizer.ts";

// SEC-69: Hard buffer limit (16MB) to guarantee against OOM attacks on buffered streaming
const MAX_HARD_BUFFER_BYTES = 16_777_216;

export class BufferedDetokenizer extends TransformStream<Uint8Array, Uint8Array> {
  constructor(tokenMap: TokenMap, maxBufferBytes = 8_388_608) {
    let buffer = "";
    let bufferBytes = 0;
    const decoder = new TextDecoder("utf-8");
    const encoder = new TextEncoder();
    const effectiveMaxBytes = Math.min(maxBufferBytes, MAX_HARD_BUFFER_BYTES);

    super({
      transform(chunk, controller) {
        // PERF-49 & PERF-53: Zero-copy instant chunk pass-through if tokenMap is empty
        if (tokenMap.size === 0) {
          controller.enqueue(chunk);
          return;
        }

        const text = decoder.decode(chunk, { stream: true });
        buffer += text;
        bufferBytes += chunk.byteLength;

        // Auto fall-back to progressive detokenization if buffer exceeds maxBufferBytes (P-05 / SEC-69)
        if (bufferBytes > effectiveMaxBytes && buffer.length > tokenMap.maxTokenLength * 2) {
          const splitPoint = buffer.length - tokenMap.maxTokenLength;
          const toEmit = buffer.slice(0, splitPoint);
          buffer = buffer.slice(splitPoint);
          bufferBytes = buffer.length;
          controller.enqueue(encoder.encode(detokenize(toEmit, tokenMap)));
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.length > 0) {
          // PERF-24: Fast-path: if buffer has no '<' or tokenMap is empty, skip detokenize
          if (tokenMap.size === 0 || !buffer.includes("<")) {
            controller.enqueue(encoder.encode(buffer));
          } else {
            const restored = detokenize(buffer, tokenMap);
            controller.enqueue(encoder.encode(restored));
          }
          buffer = "";
        }
      },
    });
  }
}
