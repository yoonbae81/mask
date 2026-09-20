import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReadableStream, TransformStream } from "node:stream/web";
import { SseDetokenizer } from "./sse-detokenizer.ts";
import { OpenAIToAnthropicSseTranslator, AnthropicToOpenAISseTranslator } from "./sse-translate.ts";
import { TokenMap } from "../privacy/mapping.ts";

function sse(data: string): string {
  return `data: ${data}\n\n`;
}

async function run(
  translator: TransformStream<Uint8Array, Uint8Array>,
  chunks: string[]
): Promise<string> {
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return await readAll(readable.pipeThrough(translator));
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
  }
  return output;
}

function dataLines(output: string): Record<string, unknown>[] {
  return output
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((l) => l !== "[DONE]")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function choiceChunks(output: string): Record<string, unknown>[] {
  return dataLines(output).filter((c) => Array.isArray(c.choices) && c.choices.length > 0);
}

function chunkDelta(chunk: Record<string, unknown>): Record<string, unknown> {
  const choice = (chunk.choices as Record<string, unknown>[])[0];
  return choice.delta as Record<string, unknown>;
}

function eventTypes(output: string): string[] {
  return output
    .split("\n")
    .filter((l) => l.startsWith("event:"))
    .map((l) => l.slice(6).trim());
}

function eventsOf(output: string): Record<string, unknown>[] {
  return output
    .split("\n\n")
    .filter((b) => b.trim() !== "")
    .map((b) => {
      const dataLine = b.split("\n").find((l) => l.startsWith("data:"));
      return dataLine ? (JSON.parse(dataLine.slice(5)) as Record<string, unknown>) : {};
    });
}

describe("OpenAIToAnthropicSseTranslator", () => {
  it("translates text chunk stream into a complete anthropic event sequence", async () => {
    const output = await run(new OpenAIToAnthropicSseTranslator({ clientModel: "claude-x" }), [
      sse('{"id":"cc1","model":"remote-model","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}'),
      sse('{"id":"cc1","choices":[{"index":0,"delta":{"content":"안녕"}}]}'),
      sse('{"id":"cc1","choices":[{"index":0,"delta":{"content":"하세요"}}]}'),
      sse('{"id":"cc1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'),
      sse('{"id":"cc1","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}'),
      sse("[DONE]"),
    ]);

    const types = eventTypes(output);
    assert.deepStrictEqual(types, [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const events = eventsOf(output);

    const start = events.find((e) => e.type === "message_start") as Record<string, unknown>;
    const startMessage = start.message as Record<string, unknown>;
    assert.strictEqual(startMessage.role, "assistant");
    assert.strictEqual(startMessage.model, "claude-x");

    const deltas = events.filter((e) => e.type === "content_block_delta");
    assert.strictEqual(deltas.length, 2);
    assert.strictEqual(deltas[0].index, 0);

    const messageDelta = events.find((e) => e.type === "message_delta") as Record<string, unknown>;
    assert.deepStrictEqual(messageDelta.delta, { stop_reason: "end_turn", stop_sequence: null });
    assert.deepStrictEqual(messageDelta.usage, { input_tokens: 3, output_tokens: 2 });

    assert.ok(!output.includes("[DONE]"), "[DONE] 은 소비되어야 한다");
  });

  it("translates streamed tool_calls into tool_use blocks with input_json_delta", async () => {
    const output = await run(new OpenAIToAnthropicSseTranslator(), [
      sse('{"id":"cc2","choices":[{"index":0,"delta":{"role":"assistant"}}]}'),
      sse('{"id":"cc2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"wx","arguments":""}}]}}]}'),
      sse('{"id":"cc2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}'),
      sse('{"id":"cc2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"서울\\"}"}}]}}]}'),
      sse('{"id":"cc2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}'),
      sse("[DONE]"),
    ]);

    const values = eventsOf(output);

    const blockStart = values.find((e) => e.type === "content_block_start") as Record<string, unknown>;
    const block = blockStart.content_block as Record<string, unknown>;
    assert.strictEqual(block.type, "tool_use");
    assert.strictEqual(block.id, "call_1");
    assert.strictEqual(block.name, "wx");

    const deltas = values.filter((e) => e.type === "content_block_delta");
    const partial = deltas
      .map((d) => (d.delta as Record<string, unknown>).partial_json)
      .join("");
    assert.strictEqual(partial, '{"city":"서울"}');

    const messageDelta = values.find((e) => e.type === "message_delta") as Record<string, unknown>;
    assert.strictEqual((messageDelta.delta as Record<string, unknown>).stop_reason, "tool_use");
  });

  it("synthesizes closure events at flush when [DONE] is absent", async () => {
    const output = await run(new OpenAIToAnthropicSseTranslator(), [
      sse('{"id":"cc3","choices":[{"index":0,"delta":{"content":"잘"},"finish_reason":null}]}'),
      sse('{"id":"cc3","choices":[{"index":0,"delta":{"content":"가"},"finish_reason":"stop"}]}'),
    ]);
    const types = eventTypes(output);
    assert.ok(types.includes("message_delta"));
    assert.ok(types.includes("message_stop"));
  });
});

describe("AnthropicToOpenAISseTranslator", () => {
  it("translates anthropic event stream into openai chunks ending with [DONE]", async () => {
    const output = await run(new AnthropicToOpenAISseTranslator({ clientModel: "claude-x" }), [
      sse('{"type":"message_start","message":{"id":"msg_9","role":"assistant","model":"remote-model","content":[]}}'),
      sse('{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'),
      sse('{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"반갑"}}'),
      sse('{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"습니다"}}'),
      sse('{"type":"content_block_stop","index":0}'),
      sse('{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":4,"output_tokens":3}}'),
      sse('{"type":"message_stop"}'),
    ]);

    assert.ok(output.endsWith("data: [DONE]\n\n"));
    const chunks = choiceChunks(output);
    assert.strictEqual(chunkDelta(chunks[0]).role, "assistant");

    const merged = chunks
      .map((c) => chunkDelta(c))
      .filter((d) => typeof d.content === "string")
      .map((d) => d.content as string)
      .join("");
    assert.strictEqual(merged, "반갑습니다");

    const final = dataLines(output)[dataLines(output).length - 1];
    assert.deepStrictEqual(final.usage, {
      prompt_tokens: 4,
      completion_tokens: 3,
      total_tokens: 7,
    });
    const lastChoice = (chunks[chunks.length - 1].choices as Record<string, unknown>[])[0];
    assert.strictEqual(lastChoice.finish_reason, "stop");
  });

  it("drops ping events and translates input_json_delta to tool_calls arguments", async () => {
    const output = await run(new AnthropicToOpenAISseTranslator(), [
      sse('{"type":"message_start","message":{"id":"m","role":"assistant","content":[]}}'),
      sse('{"type":"ping"}'),
      sse('{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"wx","input":{}}}'),
      sse('{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}'),
      sse('{"type":"message_stop"}'),
    ]);

    assert.ok(!output.includes('"type":"ping"'));
    const toolChunks = choiceChunks(output).filter(
      (c) => chunkDelta(c).tool_calls !== undefined
    );
    assert.strictEqual(toolChunks.length, 2);
    const args = toolChunks
      .map((c) => {
        const calls = chunkDelta(c).tool_calls as Record<string, unknown>[];
        return (calls[0].function as Record<string, unknown>).arguments;
      })
      .join("");
    assert.strictEqual(args, '{"a":1}');
  });
});

describe("translate + SseDetokenizer chain", () => {
  it("restores fragmented masking tokens through the translation chain", async () => {
    const tokenMap = new TokenMap();
    const term = tokenMap.getOrCreateToken("COMPANY", "한국전력공사");

    const chunk = (content: unknown): string =>
      sse(
        JSON.stringify({
          id: "c",
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        })
      );

    const openaiChunks = [
      sse('{"id":"c","choices":[{"index":0,"delta":{"role":"assistant"}}]}'),
      chunk("보고: "),
      chunk(term.slice(0, 5)),
      chunk(term.slice(5) + " 완료"),
      sse('{"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'),
      sse("[DONE]"),
    ];

    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of openaiChunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    const output = await readAll(
      readable.pipeThrough(new OpenAIToAnthropicSseTranslator()).pipeThrough(new SseDetokenizer(tokenMap))
    );

    const deltas = output
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter((l) => l !== "[DONE]")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const deltaEvent = deltas.find((e) => e.type === "content_block_delta") as Record<string, unknown>;
    assert.ok(deltaEvent, "content_block_delta 가 있어야 한다");
    const allText = deltas
      .filter((e) => e.type === "content_block_delta")
      .map((e) => ((e.delta as Record<string, unknown>).text as string))
      .join("");
    assert.strictEqual(allText, "보고: 한국전력공사 완료");
    assert.ok(!JSON.stringify(deltas).includes("<COMPANY"));
  });
});
