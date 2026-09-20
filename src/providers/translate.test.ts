import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  translateAnthropicRequestToOpenAI,
  translateOpenAIRequestToAnthropic,
  translateOpenAIResponseToAnthropic,
  translateAnthropicResponseToOpenAI,
  finishReasonToStopReason,
  stopReasonToFinishReason,
} from "./translate.ts";

describe("translateAnthropicRequestToOpenAI", () => {
  it("maps system, messages, params, tools, tool_choice", () => {
    const out = translateAnthropicRequestToOpenAI({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      temperature: 0.3,
      top_p: 0.9,
      system: "너는 비서다",
      stop_sequences: ["끝"],
      stream: true,
      tool_choice: { type: "auto" },
      tools: [
        {
          name: "get_weather",
          description: "날씨 조회",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
      messages: [{ role: "user", content: "서울 날씨 어때" }],
    }, { modelMap: { "claude-sonnet-4-5": "remote-model" } });

    assert.strictEqual(out.model, "remote-model");
    assert.strictEqual(out.max_tokens, 1024);
    assert.strictEqual(out.temperature, 0.3);
    assert.deepStrictEqual(out.stop, ["끝"]);
    assert.strictEqual(out.stream, true);
    assert.deepStrictEqual(out.stream_options, { include_usage: true });
    assert.deepStrictEqual(out.tool_choice, "auto");

    const messages = out.messages as Record<string, unknown>[];
    assert.strictEqual(messages[0].role, "system");
    assert.strictEqual(messages[0].content, "너는 비서다");
    assert.deepStrictEqual(messages[1], { role: "user", content: "서울 날씨 어때" });

    const tools = out.tools as Record<string, unknown>[];
    assert.deepStrictEqual(tools, [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "날씨 조회",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ]);
  });

  it("maps assistant tool_use to tool_calls with null content, and tool_result to role:tool", () => {
    const out = translateAnthropicRequestToOpenAI({
      model: "m",
      max_tokens: 100,
      messages: [
        { role: "user", content: "날씨 검색해줘" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "검색한다" },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "서울" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "맑음 25도" }],
        },
      ],
    });

    const messages = out.messages as Record<string, unknown>[];
    assert.strictEqual(messages.length, 3);

    const assistant = messages[1];
    assert.strictEqual(assistant.role, "assistant");
    assert.strictEqual(assistant.content, "검색한다");
    assert.deepStrictEqual(assistant.tool_calls, [
      {
        id: "toolu_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"서울"}' },
      },
    ]);

    assert.deepStrictEqual(messages[2], {
      role: "tool",
      tool_call_id: "toolu_1",
      content: "맑음 25도",
    });
  });

  it("converts base64 image blocks to data-url parts", () => {
    const out = translateAnthropicRequestToOpenAI({
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "이미지 봐줘" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          ],
        },
      ],
    });

    const messages = out.messages as Record<string, unknown>[];
    const content = messages[0].content as Record<string, unknown>[];
    assert.strictEqual(content[0].type, "text");
    assert.deepStrictEqual(content[1], {
      type: "image_url",
      image_url: { url: "data:image/png;base64,aGVsbG8=" },
    });
  });

  it("drops anthropic-only fields and preserves unknown blocks as text", () => {
    const out = translateAnthropicRequestToOpenAI({
      model: "m",
      max_tokens: 10,
      top_k: 5,
      metadata: { user_id: "u" },
      messages: [
        { role: "user", content: [{ type: "server_tool_use", weird: true }] },
      ],
    });
    assert.strictEqual(out.top_k, undefined);
    assert.strictEqual(out.metadata, undefined);
    const messages = out.messages as Record<string, unknown>[];
    assert.ok(String((messages[0].content as string)).includes("server_tool_use"));
  });
});

describe("translateOpenAIRequestToAnthropic", () => {
  it("maps system messages, tools, tool_choice, defaults max_tokens to 8192", () => {
    const out = translateOpenAIRequestToAnthropic({
      model: "remote-model",
      messages: [
        { role: "system", content: "첫 줄" },
        { role: "system", content: "둘째 줄" },
        { role: "user", content: "안녕" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "날씨 조회",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: "required",
      stop: "끝",
    });

    assert.strictEqual(out.system, "첫 줄\n둘째 줄");
    assert.strictEqual(out.max_tokens, 8192);
    assert.deepStrictEqual(out.stop_sequences, ["끝"]);
    assert.deepStrictEqual(out.tool_choice, { type: "any" });
    assert.deepStrictEqual(out.tools, [
      {
        name: "get_weather",
        description: "날씨 조회",
        input_schema: { type: "object", properties: {} },
      },
    ]);
    assert.deepStrictEqual(out.messages, [{ role: "user", content: "안녕" }]);
  });

  it("merges consecutive tool messages into one user message and parses tool_call arguments", () => {
    const out = translateOpenAIRequestToAnthropic({
      model: "m",
      messages: [
        { role: "user", content: "두 도시 날씨 검색" },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "wx", arguments: '{"city":"서울"}' } },
            { id: "call_b", type: "function", function: { name: "wx", arguments: '{"city":"부산"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_a", content: "맑음" },
        { role: "tool", tool_call_id: "call_b", content: "비" },
      ],
    });

    const messages = out.messages as Record<string, unknown>[];
    assert.strictEqual(messages.length, 3);

    const assistant = messages[1];
    const content = assistant.content as Record<string, unknown>[];
    assert.deepStrictEqual(content, [
      { type: "tool_use", id: "call_a", name: "wx", input: { city: "서울" } },
      { type: "tool_use", id: "call_b", name: "wx", input: { city: "부산" } },
    ]);

    const toolUser = messages[2];
    assert.strictEqual(toolUser.role, "user");
    assert.deepStrictEqual(toolUser.content, [
      { type: "tool_result", tool_use_id: "call_a", content: "맑음" },
      { type: "tool_result", tool_use_id: "call_b", content: "비" },
    ]);
  });

  it("converts data-url images to base64 sources and keeps max_completion_tokens", () => {
    const out = translateOpenAIRequestToAnthropic({
      model: "m",
      max_completion_tokens: 777,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "봐줘" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,YWJj" } },
          ],
        },
      ],
    });
    assert.strictEqual(out.max_tokens, 777);
    const messages = out.messages as Record<string, unknown>[];
    assert.deepStrictEqual(messages[0].content, [
      { type: "text", text: "봐줘" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "YWJj" } },
    ]);
  });
});

describe("response translation", () => {
  it("openai response → anthropic message with tool_use and mapped stop_reason", () => {
    const out = translateOpenAIResponseToAnthropic({
      id: "chatcmpl-1",
      model: "remote-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "결과다",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "wx", arguments: '{"city":"서울"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    }, { clientModel: "claude-sonnet-4-5" });

    assert.strictEqual(out.id, "chatcmpl-1");
    assert.strictEqual(out.type, "message");
    assert.strictEqual(out.role, "assistant");
    assert.strictEqual(out.model, "claude-sonnet-4-5");
    assert.strictEqual(out.stop_reason, "tool_use");
    assert.deepStrictEqual(out.usage, { input_tokens: 12, output_tokens: 34 });

    const content = out.content as Record<string, unknown>[];
    assert.deepStrictEqual(content[0], { type: "text", text: "결과다" });
    assert.deepStrictEqual(content[1], {
      type: "tool_use",
      id: "call_1",
      name: "wx",
      input: { city: "서울" },
    });
  });

  it("anthropic response → openai completion with usage totals", () => {
    const before = Math.floor(Date.now() / 1000);
    const out = translateAnthropicResponseToOpenAI({
      id: "msg_1",
      model: "remote-model",
      content: [
        { type: "text", text: "첫 줄" },
        { type: "text", text: "둘째 줄" },
      ],
      stop_reason: "max_tokens",
      usage: { input_tokens: 5, output_tokens: 7 },
    }, { clientModel: "claude-sonnet-4-5" });
    const after = Math.floor(Date.now() / 1000);

    assert.strictEqual(out.id, "msg_1");
    assert.strictEqual(out.object, "chat.completion");
    const created = out.created as number;
    assert.ok(created >= before && created <= after);
    assert.strictEqual(out.model, "claude-sonnet-4-5");

    const choices = out.choices as Record<string, unknown>[];
    assert.strictEqual(choices.length, 1);
    assert.deepStrictEqual(choices[0].message, { role: "assistant", content: "첫 줄\n둘째 줄" });
    assert.strictEqual(choices[0].finish_reason, "length");

    assert.deepStrictEqual(out.usage, {
      prompt_tokens: 5,
      completion_tokens: 7,
      total_tokens: 12,
    });
  });

  it("maps stop/finish reason matrix consistently", () => {
    assert.strictEqual(finishReasonToStopReason("stop"), "end_turn");
    assert.strictEqual(finishReasonToStopReason("length"), "max_tokens");
    assert.strictEqual(finishReasonToStopReason("tool_calls"), "tool_use");
    assert.strictEqual(finishReasonToStopReason("content_filter"), "refusal");
    assert.strictEqual(finishReasonToStopReason("mystery"), "end_turn");

    assert.strictEqual(stopReasonToFinishReason("end_turn"), "stop");
    assert.strictEqual(stopReasonToFinishReason("max_tokens"), "length");
    assert.strictEqual(stopReasonToFinishReason("tool_use"), "tool_calls");
    assert.strictEqual(stopReasonToFinishReason("refusal"), "content_filter");
    assert.strictEqual(stopReasonToFinishReason("stop_sequence"), "stop");
    assert.strictEqual(stopReasonToFinishReason("mystery"), "stop");
  });
});
