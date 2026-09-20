import type { DialectRules, FieldRule } from "./anthropic.ts";

const SKIP_KEYS = new Set([
  "model",
  "role",
  "finish_reason",
  "id",
  "object",
  "created",
  "temperature",
  "max_tokens",
  "max_completion_tokens",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "stream",
  "n",
  "seed",
]);

export class OpenAIRules implements DialectRules {
  ruleFor(path: (string | number)[], node: unknown, parent?: unknown): FieldRule {
    if (path.length === 0) return "tokenize";

    const last = path[path.length - 1];
    if (typeof last === "number") {
      return "tokenize";
    }

    const lastKey = last;

    if (lastKey.endsWith("_id")) {
      return "skip";
    }

    if (SKIP_KEYS.has(lastKey)) {
      return "skip";
    }

    if (typeof node === "number" || typeof node === "boolean") {
      return "skip";
    }

    // OpenAI tool_calls[].function.arguments is a JSON-encoded string
    if (lastKey === "arguments") {
      return "json-string";
    }

    return "tokenize";
  }
}

export const openAiRules = new OpenAIRules();
