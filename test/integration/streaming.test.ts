import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import { TokenMap } from "../../src/privacy/mapping.ts";
import { RollingDetokenizer } from "../../src/streaming/rolling.ts";
import { BufferedDetokenizer } from "../../src/streaming/buffered.ts";

describe("Streaming Detokenizers", () => {
  it("RollingDetokenizer correctly restores token split across SSE chunk boundaries", async () => {
    const tokenMap = new TokenMap();
    tokenMap.getOrCreateToken("PROJECT", "Project 오로라"); // <PROJECT_1A>
    tokenMap.getOrCreateToken("INTERNAL", "알파테크"); // <INTERNAL_1A>

    // Simulate chunks splitting tokens across boundary:
    // chunk 1: 'data: {"delta": "사내 <INTER'
    // chunk 2: 'NAL_1A> 보고 및 <PROJ'
    // chunk 3: 'ECT_1A> 완료"}\n\n'
    const chunks = [
      'data: {"delta": "사내 <INTER',
      'NAL_1A> 보고 및 <PROJ',
      'ECT_1A> 완료"}\n\n',
    ];

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) {
          controller.enqueue(encoder.encode(c));
        }
        controller.close();
      },
    });

    const transformed = stream.pipeThrough(new RollingDetokenizer(tokenMap));
    const reader = transformed.getReader();

    let output = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
    }

    assert.strictEqual(
      output,
      'data: {"delta": "사내 알파테크 보고 및 Project 오로라 완료"}\n\n'
    );
  });

  it("RollingDetokenizer restores 1-byte-at-a-time streaming without data loss", async () => {
    const tokenMap = new TokenMap();
    tokenMap.getOrCreateToken("INTERNAL", "알파"); // <INTERNAL_1A>

    const text = '이것은 <INTERNAL_1A> 관련 1바이트 스트리밍 테스트입니다.';
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < text.length; i++) {
          controller.enqueue(encoder.encode(text[i]));
        }
        controller.close();
      },
    });

    const transformed = stream.pipeThrough(new RollingDetokenizer(tokenMap));
    const reader = transformed.getReader();

    let output = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
    }

    assert.strictEqual(
      output,
      '이것은 알파 관련 1바이트 스트리밍 테스트입니다.'
    );
  });

  it("BufferedDetokenizer restores tokens when buffering entire stream", async () => {
    const tokenMap = new TokenMap();
    tokenMap.getOrCreateToken("INTERNAL", "알파");

    const chunks = ["chunk1: <INTERNAL", "_1A> 완료"];
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) {
          controller.enqueue(encoder.encode(c));
        }
        controller.close();
      },
    });

    const transformed = stream.pipeThrough(new BufferedDetokenizer(tokenMap));
    const reader = transformed.getReader();

    let output = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
    }

    assert.strictEqual(output, "chunk1: 알파 완료");
  });
});
