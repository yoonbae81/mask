import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import { SseDetokenizer } from "./sse-detokenizer.ts";
import { TokenMap } from "../privacy/mapping.ts";

function sse(lines: string[]): string {
  return lines.join("\n") + "\n\n";
}

function deltaEvent(content: string): string {
  return sse([`data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}`]);
}

async function run(
  tokenMap: TokenMap,
  chunks: (string | Uint8Array)[]
): Promise<string> {
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
  const transformed = readable.pipeThrough(new SseDetokenizer(tokenMap));
  const reader = transformed.getReader();
  const decoder = new TextDecoder();
  let output = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
  }
  return output;
}

function parseDataLines(output: string): string[] {
  return output
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
}

describe("SseDetokenizer", () => {
  it("restores a token fragmented across events inside delta.content", async () => {
    const tokenMap = new TokenMap();
    const term = tokenMap.getOrCreateToken("COMPANY", "한국전력공사");
    const events = term.match(/.{1,4}/g)!.map((piece) => deltaEvent(piece));

    const output = await run(tokenMap, events);

    const dataLines = parseDataLines(output);
    assert.strictEqual(dataLines.length, events.length);
    let merged = "";
    for (const line of dataLines) {
      const parsed = JSON.parse(line) as { choices: { delta: { content: string } }[] };
      merged += parsed.choices[0].delta.content;
    }
    assert.ok(!merged.includes("<COMPANY"));
    assert.ok(merged.includes("한국전력공사"));
  });

  it("handles chunk splits mid-event and mid-UTF-8 multibyte", async () => {
    const tokenMap = new TokenMap();
    const term = tokenMap.getOrCreateToken("PROJECT", "Project 오로라");
    const body = deltaEvent("보고: " + term + " 완료");
    const bytes = new TextEncoder().encode(body);
    const small: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 3) small.push(bytes.slice(i, i + 3));

    const output = await run(tokenMap, small);
    assert.ok(output.includes("보고: Project 오로라 완료"));
    assert.ok(!output.includes("<PROJECT"));
  });

  it("preserves event:/id: lines and passes [DONE] through, draining holds", async () => {
    const tokenMap = new TokenMap();
    const term = tokenMap.getOrCreateToken("COMPANY", "한국전력공사");
    const input = [
      sse(["event: delta", "id: 1", `data: {"c":"${term.slice(0, 5)}"}`]),
      sse(["event: delta", "id: 2", `data: {"c":"${term.slice(5)}_ok"}`]),
      sse(["data: [DONE]"]),
    ].join("");

    const output = await run(tokenMap, [input]);

    assert.ok(output.includes("event: delta"));
    assert.ok(output.includes("id: 1"));
    assert.ok(output.includes("id: 2"));
    assert.ok(output.includes("data: [DONE]"));
    const merged = parseDataLines(output)
      .filter((l) => l !== "[DONE]")
      .map((l) => (JSON.parse(l) as { c: string }).c)
      .join("");
    assert.strictEqual(merged, "한국전력공사_ok");
  });

  it("applies raw rolling restore to non-JSON data payloads", async () => {
    const tokenMap = new TokenMap();
    const term = tokenMap.getOrCreateToken("PIN", "010-1234-5678");
    const input =
      sse([`data: 메모: ${term.slice(0, 6)}`]) + sse([`data: ${term.slice(6)} 끝`]);

    const output = await run(tokenMap, [input]);
    const merged = parseDataLines(output).join(" ");
    assert.ok(!output.includes("<PIN"));
    assert.strictEqual(merged.replace(/\s+/g, " ").trim(), "메모: 010-1234-5678 끝");
  });

  it("passes bytes through verbatim when tokenMap is empty", async () => {
    const tokenMap = new TokenMap();
    const input = deltaEvent("<COMPANY_1A> 원문 유지");
    const output = await run(tokenMap, [input]);
    assert.strictEqual(output, input);
  });

  it("holds interleaved string paths independently", async () => {
    const tokenMap = new TokenMap();
    const company = tokenMap.getOrCreateToken("COMPANY", "한국전력공사");
    const project = tokenMap.getOrCreateToken("PROJECT", "Project 오로라");
    const input = [
      sse([`data: {"reasoning":"${company.slice(0, 5)}","content":"${project.slice(0, 3)}"}`]),
      sse([`data: {"reasoning":"${company.slice(5)}","content":"${project.slice(3)}"}`]),
    ].join("");

    const output = await run(tokenMap, [input]);
    const merged = parseDataLines(output)
      .map((l) => JSON.parse(l) as { reasoning: string; content: string })
      .reduce(
        (acc, cur) => ({ reasoning: acc.reasoning + cur.reasoning, content: acc.content + cur.content }),
        { reasoning: "", content: "" }
      );
    assert.strictEqual(merged.reasoning, "한국전력공사");
    assert.strictEqual(merged.content, "Project 오로라");
  });

  it("fail-open passes events with adversarial __proto__ keys untouched", async () => {
    const tokenMap = new TokenMap();
    tokenMap.getOrCreateToken("COMPANY", "한국전력공사");
    const input = sse(['data: {"__proto__":{"content":"<COMPANY_1A>"}}']);

    const output = await run(tokenMap, [input]);
    assert.ok(output.includes("__proto__"));
    assert.ok(output.includes("<COMPANY_1A>"));
  });

  it("re-emits unresolved hold fragment at flush without data loss", async () => {
    const tokenMap = new TokenMap();
    tokenMap.getOrCreateToken("COMPANY", "한국전력공사");
    const input = deltaEvent("답변: <COMP");

    const output = await run(tokenMap, [input]);
    assert.ok(output.includes("답변: <COMP"));
  });

  it("resolves hold with non-token continuation, preserving original text", async () => {
    const tokenMap = new TokenMap();
    tokenMap.getOrCreateToken("COMPANY", "한국전력공사");
    const input = deltaEvent("<COMP") + deltaEvent("안녕");

    const output = await run(tokenMap, [input]);
    const merged = parseDataLines(output)
      .map((l) => (JSON.parse(l) as { choices: { delta: { content: string } }[] }).choices[0].delta.content)
      .join("");
    assert.strictEqual(merged, "<COMP안녕");
  });

  it("restores tool_calls function.arguments fragments", async () => {
    const tokenMap = new TokenMap();
    const term = tokenMap.getOrCreateToken("INTERNAL", "알파테크");
    const argEvent = (arg: string) =>
      sse([
        "data: " +
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ function: { arguments: arg } }] } }],
          }),
      ]);
    const input = argEvent(`{"q":"${term.slice(0, 4)}`) + argEvent(`${term.slice(4)}"}`);

    const output = await run(tokenMap, [input]);
    const merged = parseDataLines(output)
      .map((l) => {
        const parsed = JSON.parse(l) as {
          choices: { delta: { tool_calls?: { function: { arguments: string } }[] } }[];
        };
        return parsed.choices[0].delta.tool_calls?.[0]?.function.arguments ?? "";
      })
      .join("");
    const args = JSON.parse(merged) as { q: string };
    assert.strictEqual(args.q, "알파테크");
  });
});
