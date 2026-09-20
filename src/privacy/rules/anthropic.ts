export type FieldRule = "tokenize" | "skip" | "json-string";

export interface DialectRules {
  ruleFor(path: (string | number)[], node: unknown, parent?: unknown): FieldRule;
}

const SKIP_KEYS = new Set([
  "model",
  "id",
  "type",
  "role",
  "stop_reason",
  "stop_sequence",
  "max_tokens",
  "temperature",
  "top_p",
  "top_k",
  "stream",
]);

export class AnthropicRules implements DialectRules {
  ruleFor(path: (string | number)[], node: unknown, parent?: unknown): FieldRule {
    if (path.length === 0) return "tokenize";

    const last = path[path.length - 1];
    if (typeof last === "number") {
      return "tokenize";
    }

    const lastKey = last;

    // Fields ending in _id (e.g. message_id) are skipped
    if (lastKey.endsWith("_id")) {
      return "skip";
    }

    if (SKIP_KEYS.has(lastKey)) {
      return "skip";
    }

    if (typeof node === "number" || typeof node === "boolean") {
      return "skip";
    }

    // Skip binary / base64 image or document data
    // e.g. path ends with ["source", "data"] when parent type is image/document
    if (lastKey === "data" && path.length >= 2 && path[path.length - 2] === "source") {
      return "skip";
    }

    // Default: tokenize (fail-closed, P1)
    return "tokenize";
  }
}

export const anthropicRules = new AnthropicRules();
