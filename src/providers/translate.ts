import type { Dialect } from "./auth.ts";

export interface TranslateOptions {
  // providers.yaml model_map: 클라이언트 모델명 → 업스트림 모델명 (일치 시에만 적용)
  modelMap?: Record<string, string>;
  // 응답의 model 필드는 클라이언트가 요청한 원래 모델명으로 되돌려준다
  clientModel?: string;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

function safeJsonParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function applyModelMap(
  model: unknown,
  modelMap: Record<string, string> | undefined
): string | undefined {
  const m = asString(model);
  if (m === undefined) return undefined;
  return modelMap && m in modelMap ? modelMap[m] : m;
}

// ── stop_reason ↔ finish_reason 매핑 (SSE 번역기와 공유) ─────────────────────

export function finishReasonToStopReason(fr: unknown): string {
  switch (fr) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

export function stopReasonToFinishReason(sr: unknown): string {
  switch (sr) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

// ── 요청: anthropic → openai ──────────────────────────────────────────────────

export function translateAnthropicRequestToOpenAI(
  body: unknown,
  opts: TranslateOptions = {}
): Record<string, unknown> {
  const src = asRecord(body) ?? {};
  const out: Record<string, unknown> = {};

  const model = applyModelMap(src.model, opts.modelMap);
  if (model !== undefined) out.model = model;

  const messages: Record<string, unknown>[] = [];

  // system: 문자열 또는 [{type:"text",text}] 블록 → 선두 system 메시지
  const systemTexts: string[] = [];
  if (typeof src.system === "string") {
    systemTexts.push(src.system);
  } else {
    const sys = asArray(src.system);
    for (const block of sys) {
      const b = asRecord(block);
      const text = b ? asString(b.text) : undefined;
      if (text !== undefined) systemTexts.push(text);
    }
  }
  if (systemTexts.length > 0) {
    messages.push({ role: "system", content: systemTexts.join("\n") });
  }

  for (const rawMsg of asArray(src.messages)) {
    const msg = asRecord(rawMsg);
    if (!msg) continue;
    const role = asString(msg.role) ?? "user";
    const toolCalls: Record<string, unknown>[] = [];
    const textParts: string[] = [];
    const imageParts: Record<string, unknown>[] = [];
    const toolResults: Record<string, unknown>[] = [];

    if (typeof msg.content === "string") {
      textParts.push(msg.content);
    } else {
      for (const rawBlock of asArray(msg.content)) {
        const block = asRecord(rawBlock);
        if (!block) continue;
        const type = asString(block.type);
        if (type === "text" && asString(block.text) !== undefined) {
          textParts.push(asString(block.text)!);
        } else if (type === "image") {
          const source = asRecord(block.source);
          if (!source) continue;
          const url = asString(source.url);
          if (url !== undefined) {
            imageParts.push({ type: "image_url", image_url: { url } });
            continue;
          }
          const data = asString(source.data);
          const mediaType = asString(source.media_type);
          if (data !== undefined && mediaType !== undefined) {
            imageParts.push({
              type: "image_url",
              image_url: { url: `data:${mediaType};base64,${data}` },
            });
          }
        } else if (type === "tool_use" && role === "assistant") {
          const id = asString(block.id);
          const name = asString(block.name);
          if (!id || !name) continue;
          toolCalls.push({
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(block.input ?? {}) },
          });
        } else if (type === "tool_result" && role === "user") {
          const toolUseId = asString(block.tool_use_id);
          if (!toolUseId) continue;
          let content: string;
          if (typeof block.content === "string") {
            content = block.content;
          } else {
            content = JSON.stringify(block.content ?? "");
          }
          toolResults.push({ role: "tool", tool_call_id: toolUseId, content });
        } else {
          // 알 수 없는 블록은 텍스트로 보존한다 (무손실 우선)
          textParts.push(JSON.stringify(block));
        }
      }
    }

    if (role === "assistant") {
      const assistant: Record<string, unknown> = { role: "assistant" };
      if (toolCalls.length > 0) {
        assistant.tool_calls = toolCalls;
        assistant.content = textParts.length > 0 ? textParts.join("\n") : null;
      } else {
        assistant.content = textParts.join("\n");
      }
      messages.push(assistant);
      continue;
    }

    // user: 이미지가 있으면 parts 배열, 아니면 문자열
    if (imageParts.length > 0) {
      const parts: unknown[] = [];
      if (textParts.length > 0) parts.push({ type: "text", text: textParts.join("\n") });
      parts.push(...imageParts);
      messages.push({ role: "user", content: parts });
    } else if (textParts.length > 0) {
      messages.push({ role: "user", content: textParts.join("\n") });
    }
    messages.push(...toolResults);
  }

  out.messages = messages;

  const maxTokens = src.max_tokens;
  if (typeof maxTokens === "number") out.max_tokens = maxTokens;
  if (typeof src.temperature === "number") out.temperature = src.temperature;
  if (typeof src.top_p === "number") out.top_p = src.top_p;

  if (Array.isArray(src.stop_sequences)) {
    out.stop = src.stop_sequences;
  } else if (typeof src.stop_sequences === "string") {
    out.stop = [src.stop_sequences];
  }

  if (src.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }

  const tools = asArray(src.tools);
  if (tools.length > 0) {
    out.tools = tools.flatMap((rawTool) => {
      const tool = asRecord(rawTool);
      if (!tool) return [];
      const name = asString(tool.name);
      if (!name) return [];
      return [
        {
          type: "function",
          function: {
            name,
            ...(asString(tool.description) !== undefined
              ? { description: asString(tool.description) }
              : {}),
            parameters: asRecord(tool.input_schema) ?? { type: "object", properties: {} },
          },
        },
      ];
    });
  }

  const choice = asRecord(src.tool_choice);
  if (choice) {
    const type = asString(choice.type);
    if (type === "auto") out.tool_choice = "auto";
    else if (type === "none") out.tool_choice = "none";
    else if (type === "any") out.tool_choice = "required";
    else if (type === "tool" && asString(choice.name)) {
      out.tool_choice = { type: "function", function: { name: asString(choice.name) } };
    }
  }

  return out;
}

// ── 요청: openai → anthropic ──────────────────────────────────────────────────

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicImageBlock {
  type: "image";
  source: Record<string, unknown>;
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

function parseDataImageUrl(url: string): AnthropicImageBlock | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (!m) return null;
  return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
}

export function translateOpenAIRequestToAnthropic(
  body: unknown,
  opts: TranslateOptions = {}
): Record<string, unknown> {
  const src = asRecord(body) ?? {};
  const out: Record<string, unknown> = {};

  const model = applyModelMap(src.model, opts.modelMap);
  if (model !== undefined) out.model = model;

  const systemTexts: string[] = [];
  const anthropicMessages: Record<string, unknown>[] = [];
  let pendingToolResults: AnthropicToolResultBlock[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return;
    anthropicMessages.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const rawMsg of asArray(src.messages)) {
    const msg = asRecord(rawMsg);
    if (!msg) continue;
    const role = asString(msg.role) ?? "user";

    if (role === "system") {
      const content = msg.content;
      if (typeof content === "string") {
        systemTexts.push(content);
      } else {
        for (const part of asArray(content)) {
          const p = asRecord(part);
          const text = p ? asString(p.text) : undefined;
          if (text !== undefined) systemTexts.push(text);
        }
      }
      continue;
    }

    if (role === "tool") {
      const toolCallId = asString(msg.tool_call_id);
      if (!toolCallId) continue;
      const content = asString(msg.content) ?? JSON.stringify(msg.content ?? "");
      pendingToolResults.push({ type: "tool_result", tool_use_id: toolCallId, content });
      continue;
    }

    flushToolResults();

    if (role === "assistant") {
      const textParts: string[] = [];
      const toolUseBlocks: AnthropicToolUseBlock[] = [];
      if (typeof msg.content === "string" && msg.content !== "") {
        textParts.push(msg.content);
      } else {
        for (const rawPart of asArray(msg.content)) {
          const part = asRecord(rawPart);
          const text = part ? asString(part.text) : undefined;
          if (text !== undefined) textParts.push(text);
        }
      }
      for (const rawCall of asArray(msg.tool_calls)) {
        const call = asRecord(rawCall);
        const fn = call ? asRecord(call.function) : null;
        const id = call ? asString(call.id) : undefined;
        const name = fn ? asString(fn.name) : undefined;
        if (!id || !name) continue;
        const argsRaw = asString(fn?.arguments) ?? "{}";
        const parsed = safeJsonParse(argsRaw);
        toolUseBlocks.push({
          type: "tool_use",
          id,
          name,
          input: parsed.ok ? parsed.value : { _raw: argsRaw },
        });
      }
      const content: (AnthropicTextBlock | AnthropicToolUseBlock)[] = [];
      if (textParts.length > 0) content.push({ type: "text", text: textParts.join("\n") });
      content.push(...toolUseBlocks);
      anthropicMessages.push({ role: "assistant", content });
      continue;
    }

    // user
    if (typeof msg.content === "string") {
      anthropicMessages.push({ role: "user", content: msg.content });
      continue;
    }
    const blocks: (AnthropicTextBlock | AnthropicImageBlock)[] = [];
    for (const rawPart of asArray(msg.content)) {
      const part = asRecord(rawPart);
      if (!part) continue;
      if (asString(part.type) === "text" && asString(part.text) !== undefined) {
        blocks.push({ type: "text", text: asString(part.text)! });
        continue;
      }
      const imageUrl = asRecord(part.image_url);
      const url = imageUrl ? asString(imageUrl.url) : undefined;
      if (url) {
        const imageBlock = parseDataImageUrl(url);
        if (imageBlock) {
          blocks.push(imageBlock);
        } else if (/^https?:\/\//.test(url)) {
          blocks.push({ type: "image", source: { type: "url", url } });
        }
      }
    }
    if (blocks.length > 0) anthropicMessages.push({ role: "user", content: blocks });
  }

  flushToolResults();
  out.messages = anthropicMessages;
  if (systemTexts.length > 0) out.system = systemTexts.join("\n");

  const maxTokens =
    typeof src.max_tokens === "number"
      ? src.max_tokens
      : typeof src.max_completion_tokens === "number"
        ? src.max_completion_tokens
        : 8192;
  out.max_tokens = maxTokens;

  if (typeof src.temperature === "number") out.temperature = src.temperature;
  if (typeof src.top_p === "number") out.top_p = src.top_p;

  if (typeof src.stop === "string") {
    out.stop_sequences = [src.stop];
  } else if (Array.isArray(src.stop)) {
    out.stop_sequences = src.stop;
  }

  if (src.stream === true) out.stream = true;

  const tools = asArray(src.tools);
  if (tools.length > 0) {
    out.tools = tools.flatMap((rawTool) => {
      const tool = asRecord(rawTool);
      const fn = tool ? asRecord(tool.function) : null;
      const name = fn ? asString(fn.name) : undefined;
      if (!name) return [];
      return [
        {
          name,
          ...(asString(fn?.description) !== undefined
            ? { description: asString(fn?.description) }
            : {}),
          input_schema: asRecord(fn?.parameters) ?? { type: "object", properties: {} },
        },
      ];
    });
  }

  const toolChoice = src.tool_choice;
  if (toolChoice === "auto") out.tool_choice = { type: "auto" };
  else if (toolChoice === "none") out.tool_choice = { type: "none" };
  else if (toolChoice === "required") out.tool_choice = { type: "any" };
  else {
    const tc = asRecord(toolChoice);
    const fn = tc ? asRecord(tc.function) : null;
    const name = fn ? asString(fn.name) : undefined;
    if (name) out.tool_choice = { type: "tool", name };
  }

  return out;
}

// ── 응답: openai → anthropic ──────────────────────────────────────────────────

export function translateOpenAIResponseToAnthropic(
  response: unknown,
  opts: TranslateOptions = {}
): Record<string, unknown> {
  const src = asRecord(response) ?? {};
  const choice = asArray(src.choices)[0];
  const message = asRecord(asRecord(choice)?.message) ?? {};
  const content: (AnthropicTextBlock | AnthropicToolUseBlock)[] = [];

  if (typeof message.content === "string" && message.content !== "") {
    content.push({ type: "text", text: message.content });
  } else {
    const textParts: string[] = [];
    for (const rawPart of asArray(message.content)) {
      const part = asRecord(rawPart);
      const text = part ? asString(part.text) : undefined;
      if (text !== undefined) textParts.push(text);
    }
    if (textParts.length > 0) content.push({ type: "text", text: textParts.join("\n") });
  }

  for (const rawCall of asArray(message.tool_calls)) {
    const call = asRecord(rawCall);
    const fn = call ? asRecord(call.function) : null;
    const id = call ? asString(call.id) : undefined;
    const name = fn ? asString(fn.name) : undefined;
    if (!id || !name) continue;
    const argsRaw = asString(fn?.arguments) ?? "{}";
    const parsed = safeJsonParse(argsRaw);
    content.push({
      type: "tool_use",
      id,
      name,
      input: parsed.ok ? parsed.value : { _raw: argsRaw },
    });
  }

  const usage = asRecord(src.usage) ?? {};
  return {
    id: asString(src.id) ?? "msg_translated",
    type: "message",
    role: "assistant",
    model: opts.clientModel ?? asString(src.model) ?? "unknown",
    content,
    stop_reason: finishReasonToStopReason(asRecord(choice)?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    },
  };
}

// ── 응답: anthropic → openai ──────────────────────────────────────────────────

export function translateAnthropicResponseToOpenAI(
  response: unknown,
  opts: TranslateOptions = {}
): Record<string, unknown> {
  const src = asRecord(response) ?? {};
  const textParts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];

  for (const rawBlock of asArray(src.content)) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    if (asString(block.type) === "text" && asString(block.text) !== undefined) {
      textParts.push(asString(block.text)!);
    } else if (asString(block.type) === "tool_use") {
      const id = asString(block.id);
      const name = asString(block.name);
      if (!id || !name) continue;
      toolCalls.push({
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }

  const usage = asRecord(src.usage) ?? {};
  const promptTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const completionTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;

  const message: Record<string, unknown> = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("\n") : null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: asString(src.id) ?? "chatcmpl_translated",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: opts.clientModel ?? asString(src.model) ?? "unknown",
    choices: [
      {
        index: 0,
        message,
        finish_reason: stopReasonToFinishReason(asString(src.stop_reason)),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export function translateRequestBody(
  body: unknown,
  from: Dialect,
  to: Dialect,
  opts: TranslateOptions = {}
): Record<string, unknown> {
  if (from === "anthropic" && to === "openai") {
    return translateAnthropicRequestToOpenAI(body, opts);
  }
  if (from === "openai" && to === "anthropic") {
    return translateOpenAIRequestToAnthropic(body, opts);
  }
  throw new Error(`unsupported translation direction: ${from} -> ${to}`);
}

export function translateResponseBody(
  body: unknown,
  from: Dialect,
  to: Dialect,
  opts: TranslateOptions = {}
): Record<string, unknown> {
  if (from === "openai" && to === "anthropic") {
    return translateOpenAIResponseToAnthropic(body, opts);
  }
  if (from === "anthropic" && to === "openai") {
    return translateAnthropicResponseToOpenAI(body, opts);
  }
  throw new Error(`unsupported translation direction: ${from} -> ${to}`);
}
