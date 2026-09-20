import { TransformStream } from "node:stream/web";
import {
  finishReasonToStopReason,
  stopReasonToFinishReason,
  type TranslateOptions,
} from "../providers/translate.ts";

const sharedEncoder = new TextEncoder();

interface SseEvent {
  event?: string;
  data: string;
}

function formatSseEvent(event: SseEvent): string {
  const lines: string[] = [];
  if (event.event) lines.push(`event: ${event.event}`);
  lines.push(`data: ${event.data}`);
  return lines.join("\n") + "\n\n";
}

function splitSseEvents(text: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let rest = text;
  for (;;) {
    const iLf = rest.indexOf("\n\n");
    const iCrLf = rest.indexOf("\r\n\r\n");
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
    events.push(rest.slice(0, idx));
    rest = rest.slice(idx + sepLen);
  }
  return { events, rest };
}

function parseDataPayload(rawEvent: string): { payload: string; isData: boolean } {
  const lines = rawEvent.split("\n");
  const payloads: string[] = [];
  for (const line of lines) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.startsWith("data:")) {
      payloads.push(trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5));
    }
  }
  return { payload: payloads.join("\n"), isData: payloads.length > 0 };
}

function safeParse(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ── openai chunks → anthropic events ─────────────────────────────────────────

export class OpenAIToAnthropicSseTranslator extends TransformStream<Uint8Array, Uint8Array> {
  constructor(opts: TranslateOptions = {}) {
    let pending = "";
    const decoder = new TextDecoder("utf-8");
    let messageStarted = false;
    let messageClosed = false;
    let nextBlockIndex = 0;
    let textBlockIndex = -1;
    const toolBlocks = new Map<number, number>();
    let messageId = "";
    let clientModel = opts.clientModel;
    let pendingStop: string | null = null;
    let pendingUsage: { input_tokens: number; output_tokens: number } | null = null;

    const emit = (
      controller: TransformStreamDefaultController<Uint8Array>,
      event: SseEvent
    ): void => {
      controller.enqueue(sharedEncoder.encode(formatSseEvent(event)));
    };

    const startMessage = (controller: TransformStreamDefaultController<Uint8Array>): void => {
      if (messageStarted) return;
      messageStarted = true;
      emit(controller, {
        event: "message_start",
        data: JSON.stringify({
          type: "message_start",
          message: {
            id: messageId || "msg_translated",
            type: "message",
            role: "assistant",
            model: clientModel ?? "unknown",
            content: [],
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      });
    };

    const closeBlock = (
      controller: TransformStreamDefaultController<Uint8Array>,
      index: number
    ): void => {
      emit(controller, {
        event: "content_block_stop",
        data: JSON.stringify({ type: "content_block_stop", index }),
      });
    };

    const closeAllBlocks = (
      controller: TransformStreamDefaultController<Uint8Array>
    ): void => {
      if (textBlockIndex !== -1) {
        closeBlock(controller, textBlockIndex);
        textBlockIndex = -1;
      }
      for (const blockIndex of [...toolBlocks.values()]) {
        closeBlock(controller, blockIndex);
      }
      toolBlocks.clear();
    };

    const finishMessage = (
      controller: TransformStreamDefaultController<Uint8Array>
    ): void => {
      if (messageClosed) return;
      startMessage(controller);
      closeAllBlocks(controller);
      emit(controller, {
        event: "message_delta",
        data: JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: pendingStop ?? "end_turn", stop_sequence: null },
          usage: pendingUsage ?? { output_tokens: 0 },
        }),
      });
      emit(controller, {
        event: "message_stop",
        data: JSON.stringify({ type: "message_stop" }),
      });
      messageClosed = true;
    };

    const handleChunk = (
      controller: TransformStreamDefaultController<Uint8Array>,
      chunk: Record<string, unknown>
    ): void => {
      if (messageClosed) return;
      const id = typeof chunk.id === "string" ? chunk.id : "";
      if (id && !messageId) messageId = id;
      if (!clientModel && typeof chunk.model === "string") clientModel = chunk.model;

      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      if (choices.length === 0) {
        // 최종 usage 청크 (choices: []) — message_delta 용 usage 로 접는다
        const usage = chunk.usage;
        if (usage && typeof usage === "object") {
          const u = usage as Record<string, unknown>;
          pendingUsage = {
            input_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
            output_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
          };
        }
        return;
      }

      startMessage(controller);
      const choice = choices[0];
      if (!choice || typeof choice !== "object") return;
      const choiceRec = choice as Record<string, unknown>;
      const deltaRec =
        choiceRec.delta && typeof choiceRec.delta === "object"
          ? (choiceRec.delta as Record<string, unknown>)
          : {};

      const content = deltaRec.content;
      if (typeof content === "string" && content !== "") {
        if (textBlockIndex === -1) {
          closeAllBlocks(controller);
          textBlockIndex = nextBlockIndex++;
          emit(controller, {
            event: "content_block_start",
            data: JSON.stringify({
              type: "content_block_start",
              index: textBlockIndex,
              content_block: { type: "text", text: "" },
            }),
          });
        }
        emit(controller, {
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            index: textBlockIndex,
            delta: { type: "text_delta", text: content },
          }),
        });
      }

      const toolCalls = Array.isArray(deltaRec.tool_calls) ? deltaRec.tool_calls : [];
      for (const rawCall of toolCalls) {
        if (!rawCall || typeof rawCall !== "object") continue;
        const call = rawCall as Record<string, unknown>;
        const openaiIndex = typeof call.index === "number" ? call.index : 0;
        const fn =
          call.function && typeof call.function === "object"
            ? (call.function as Record<string, unknown>)
            : {};
        const callId = typeof call.id === "string" ? call.id : undefined;
        const name = typeof fn.name === "string" ? fn.name : undefined;

        if (callId && name && !toolBlocks.has(openaiIndex)) {
          if (textBlockIndex !== -1) {
            closeBlock(controller, textBlockIndex);
            textBlockIndex = -1;
          }
          const blockIndex = nextBlockIndex++;
          toolBlocks.set(openaiIndex, blockIndex);
          emit(controller, {
            event: "content_block_start",
            data: JSON.stringify({
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "tool_use", id: callId, name, input: {} },
            }),
          });
        }
        const args = typeof fn.arguments === "string" ? fn.arguments : undefined;
        const mapped = toolBlocks.get(openaiIndex);
        if (args !== undefined && args !== "" && mapped !== undefined) {
          emit(controller, {
            event: "content_block_delta",
            data: JSON.stringify({
              type: "content_block_delta",
              index: mapped,
              delta: { type: "input_json_delta", partial_json: args },
            }),
          });
        }
      }

      const finishReason = choiceRec.finish_reason;
      if (typeof finishReason === "string" && finishReason !== "") {
        pendingStop = finishReasonToStopReason(finishReason);
      }
    };

    super({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const { events, rest } = splitSseEvents(pending);
        pending = rest;
        for (const rawEvent of events) {
          const { payload, isData } = parseDataPayload(rawEvent);
          if (!isData) continue;
          const trimmed = payload.trim();
          if (trimmed === "") continue;
          if (trimmed === "[DONE]") {
            finishMessage(controller);
            continue;
          }
          const parsed = safeParse(trimmed);
          if (parsed) handleChunk(controller, parsed);
        }
      },
      flush(controller) {
        pending += decoder.decode();
        const { events } = splitSseEvents(pending);
        for (const rawEvent of events) {
          const { payload, isData } = parseDataPayload(rawEvent);
          if (!isData) continue;
          const trimmed = payload.trim();
          if (trimmed === "" || trimmed === "[DONE]") continue;
          const parsed = safeParse(trimmed);
          if (parsed) handleChunk(controller, parsed);
        }
        finishMessage(controller);
      },
    });
  }
}

// ── anthropic events → openai chunks ─────────────────────────────────────────

export class AnthropicToOpenAISseTranslator extends TransformStream<Uint8Array, Uint8Array> {
  constructor(opts: TranslateOptions = {}) {
    let pending = "";
    const decoder = new TextDecoder("utf-8");
    let firstChunkSent = false;
    let messageDone = false;
    let messageId = "";
    let clientModel = opts.clientModel;
    const toolBlockToCallIndex = new Map<number, number>();
    let nextToolCallIndex = 0;
    let stopReason: string | null = null;
    let usage: { input_tokens: number; output_tokens: number } | null = null;
    const created = Math.floor(Date.now() / 1000);

    const enqueueChunk = (
      controller: TransformStreamDefaultController<Uint8Array>,
      delta: Record<string, unknown>,
      finishReason: string | null = null
    ): void => {
      const chunk: Record<string, unknown> = {
        id: messageId || "chatcmpl_translated",
        object: "chat.completion.chunk",
        created,
        model: clientModel ?? "unknown",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
      controller.enqueue(sharedEncoder.encode(formatSseEvent({ data: JSON.stringify(chunk) })));
    };

    const ensureFirstChunk = (
      controller: TransformStreamDefaultController<Uint8Array>
    ): void => {
      if (firstChunkSent) return;
      firstChunkSent = true;
      enqueueChunk(controller, { role: "assistant", content: "" });
    };

    const finalize = (controller: TransformStreamDefaultController<Uint8Array>): void => {
      if (messageDone) return;
      ensureFirstChunk(controller);
      enqueueChunk(controller, {}, stopReasonToFinishReason(stopReason ?? "end_turn"));
      const inputTokens = usage?.input_tokens ?? 0;
      const outputTokens = usage?.output_tokens ?? 0;
      controller.enqueue(
        sharedEncoder.encode(
          formatSseEvent({
            data: JSON.stringify({
              id: messageId || "chatcmpl_translated",
              object: "chat.completion.chunk",
              created,
              model: clientModel ?? "unknown",
              choices: [],
              usage: {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
              },
            }),
          })
        )
      );
      controller.enqueue(sharedEncoder.encode(formatSseEvent({ data: "[DONE]" })));
      messageDone = true;
    };

    const handleEvent = (
      controller: TransformStreamDefaultController<Uint8Array>,
      data: Record<string, unknown>
    ): void => {
      if (messageDone) return;
      const type = typeof data.type === "string" ? data.type : "";
      const message =
        data.message && typeof data.message === "object"
          ? (data.message as Record<string, unknown>)
          : null;

      if (type === "message_start" && message) {
        const id = typeof message.id === "string" ? message.id : "";
        if (id && !messageId) messageId = id;
        if (!clientModel && typeof message.model === "string") clientModel = message.model;
        ensureFirstChunk(controller);
        return;
      }

      if (type === "content_block_start") {
        const block =
          data.content_block && typeof data.content_block === "object"
            ? (data.content_block as Record<string, unknown>)
            : {};
        const blockIndex = typeof data.index === "number" ? data.index : 0;
        if (block.type === "tool_use") {
          const callIndex = nextToolCallIndex++;
          toolBlockToCallIndex.set(blockIndex, callIndex);
          ensureFirstChunk(controller);
          enqueueChunk(controller, {
            tool_calls: [
              {
                index: callIndex,
                id: typeof block.id === "string" ? block.id : "",
                type: "function",
                function: {
                  name: typeof block.name === "string" ? block.name : "",
                  arguments: "",
                },
              },
            ],
          });
        }
        return;
      }

      if (type === "content_block_delta") {
        const delta =
          data.delta && typeof data.delta === "object"
            ? (data.delta as Record<string, unknown>)
            : {};
        const blockIndex = typeof data.index === "number" ? data.index : 0;
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
          ensureFirstChunk(controller);
          enqueueChunk(controller, { content: delta.text });
        } else if (
          delta.type === "input_json_delta" &&
          typeof delta.partial_json === "string" &&
          delta.partial_json !== ""
        ) {
          const callIndex = toolBlockToCallIndex.get(blockIndex) ?? 0;
          enqueueChunk(controller, {
            tool_calls: [{ index: callIndex, function: { arguments: delta.partial_json } }],
          });
        }
        return;
      }

      if (type === "message_delta") {
        const delta =
          data.delta && typeof data.delta === "object"
            ? (data.delta as Record<string, unknown>)
            : {};
        if (typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
        const usageRaw =
          data.usage && typeof data.usage === "object"
            ? (data.usage as Record<string, unknown>)
            : null;
        if (usageRaw) {
          usage = {
            input_tokens: typeof usageRaw.input_tokens === "number" ? usageRaw.input_tokens : 0,
            output_tokens:
              typeof usageRaw.output_tokens === "number" ? usageRaw.output_tokens : 0,
          };
        }
        return;
      }

      if (type === "message_stop") {
        finalize(controller);
      }
      // ping 은 폐기한다
    };

    super({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const { events, rest } = splitSseEvents(pending);
        pending = rest;
        for (const rawEvent of events) {
          const { payload, isData } = parseDataPayload(rawEvent);
          if (!isData) continue;
          const trimmed = payload.trim();
          if (trimmed === "" || trimmed === "[DONE]") continue;
          const parsed = safeParse(trimmed);
          if (!parsed || parsed.type === "error") {
            // fail-open: 해석 불가/error 이벤트는 원문 그대로 전달한다
            controller.enqueue(sharedEncoder.encode(formatSseEvent({ data: trimmed })));
            continue;
          }
          handleEvent(controller, parsed);
        }
      },
      flush(controller) {
        pending += decoder.decode();
        const { events } = splitSseEvents(pending);
        for (const rawEvent of events) {
          const { payload, isData } = parseDataPayload(rawEvent);
          if (!isData) continue;
          const trimmed = payload.trim();
          if (trimmed === "" || trimmed === "[DONE]") continue;
          const parsed = safeParse(trimmed);
          if (parsed && parsed.type !== "error") handleEvent(controller, parsed);
        }
        finalize(controller);
      },
    });
  }
}
