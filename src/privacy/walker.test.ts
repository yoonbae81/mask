import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { walkJson } from "./walker.ts";
import { anthropicRules } from "./rules/anthropic.ts";
import { openAiRules } from "./rules/openai.ts";
import { DenyListMatcher } from "./matcher.ts";
import { TokenMap } from "./mapping.ts";
import { tokenize } from "./tokenizer.ts";
import { detokenize } from "./detokenizer.ts";
import { MaskError } from "../errors.ts";

describe("walker with Anthropic rules", () => {
  const matcher = new DenyListMatcher([
    { entity: "INTERNAL", term: "알파테크" },
    { entity: "PROJECT", term: "Project 오로라" },
  ]);

  it("tokenizes system, text content, tool_use input, and tool_result content", () => {
    const tokenMap = new TokenMap();
    const payload = {
      model: "claude-3-5-sonnet",
      max_tokens: 1024,
      system: "알파테크 안내 지침",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Project 오로라 관련 문서 요약해줘." },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "BASE64_알파테크_DATA" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_01",
              name: "search_docs",
              input: { query: "알파테크 현황", filter: { tag: "Project 오로라" } },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: "검색 결과: 알파테크 2026년 실적 보고",
            },
          ],
        },
      ],
    };

    const tokenized = walkJson(
      payload,
      anthropicRules,
      (text) => tokenize(text, matcher, tokenMap)
    ) as any;

    // Check invariants
    assert.strictEqual(tokenized.model, "claude-3-5-sonnet"); // skipped
    assert.strictEqual(tokenized.max_tokens, 1024); // skipped
    assert.strictEqual(tokenized.system, "<INTERNAL_1A> 안내 지침");
    assert.strictEqual(tokenized.messages[0].content[0].text, "<PROJECT_1A> 관련 문서 요약해줘.");
    // Base64 data was skipped!
    assert.strictEqual(
      tokenized.messages[0].content[1].source.data,
      "BASE64_알파테크_DATA"
    );
    // tool_use input deeply tokenized
    assert.strictEqual(tokenized.messages[1].content[0].input.query, "<INTERNAL_1A> 현황");
    assert.strictEqual(tokenized.messages[1].content[0].input.filter.tag, "<PROJECT_1A>");
    // tool_result content tokenized
    assert.strictEqual(
      tokenized.messages[2].content[0].content,
      "검색 결과: <INTERNAL_1A> 2026년 실적 보고"
    );

    // Detokenization round-trip
    const restored = walkJson(
      tokenized,
      anthropicRules,
      (text) => detokenize(text, tokenMap)
    );
    assert.deepStrictEqual(restored, payload);
  });

  it("defaults unknown fields to tokenize (P1 fail-closed)", () => {
    const tokenMap = new TokenMap();
    const payload = {
      new_future_api_field: "알파테크 신규 필드",
    };

    const tokenized = walkJson(
      payload,
      anthropicRules,
      (text) => tokenize(text, matcher, tokenMap)
    ) as any;

    assert.strictEqual(tokenized.new_future_api_field, "<INTERNAL_1A> 신규 필드");
  });

  it("throws MaskError when depth exceeds limit", () => {
    const deepObj: any = { a: {} };
    let cur = deepObj.a;
    for (let i = 0; i < 70; i++) {
      cur.next = {};
      cur = cur.next;
    }

    assert.throws(
      () => walkJson(deepObj, anthropicRules, (t) => t),
      (err) => err instanceof MaskError && err.message.includes("depth limit")
    );
  });
});

describe("walker with OpenAI rules", () => {
  const matcher = new DenyListMatcher([
    { entity: "INTERNAL", term: "알파테크" },
    { entity: "PROJECT", term: "Project 오로라" },
  ]);

  it("tokenizes tool_calls arguments JSON string recursively", () => {
    const tokenMap = new TokenMap();
    const payload = {
      model: "gpt-4o",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "lookup",
                arguments: JSON.stringify({
                  query: "알파테크",
                  project: "Project 오로라",
                }),
              },
            },
          ],
        },
      ],
    };

    const tokenized = walkJson(
      payload,
      openAiRules,
      (text) => tokenize(text, matcher, tokenMap)
    ) as any;

    const rawArgs = tokenized.messages[0].tool_calls[0].function.arguments;
    const parsedArgs = JSON.parse(rawArgs);

    assert.strictEqual(parsedArgs.query, "<INTERNAL_1A>");
    assert.strictEqual(parsedArgs.project, "<PROJECT_1A>");

    // Detokenization round-trip
    const restored = walkJson(
      tokenized,
      openAiRules,
      (text) => detokenize(text, tokenMap)
    ) as any;

    assert.deepStrictEqual(restored, payload);
  });
});
