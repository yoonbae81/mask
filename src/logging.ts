import pino from "pino";
import type { Settings } from "./settings.ts";
import { isLoopback } from "./settings.ts";

export type TermInspector = () => string[];

let activeTermGetter: TermInspector | null = null;
let cachedTermsKey = "";
let cachedLogRegex: RegExp | null = null;

export function setActiveTermGetter(getter: TermInspector | null) {
  activeTermGetter = getter;
  cachedTermsKey = "";
  cachedLogRegex = null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ASCII_W = "A-Za-z0-9";

function isClass(ch: string | undefined, cls: string): boolean {
  return !!ch && new RegExp(`[${cls}]`).test(ch);
}

function getLogGuardRegex(terms: string[]): RegExp | null {
  const key = terms.join("\x00");
  if (cachedLogRegex && cachedTermsKey === key) {
    return cachedLogRegex;
  }

  if (terms.length === 0) {
    cachedLogRegex = null;
    cachedTermsKey = key;
    return null;
  }

  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const pats: string[] = [];

  for (const term of sorted) {
    if (!term) continue;
    const first = term[0];
    const last = term[term.length - 1];

    let left = "";
    if (isClass(first, ASCII_W)) {
      left = `(?<![${ASCII_W}])`;
    }
    let right = "";
    if (isClass(last, ASCII_W)) {
      right = `(?![${ASCII_W}])`;
    }

    const body = term.split(/\s+/).map((p) => escapeRe(p)).join("\\s+");
    pats.push(`${left}${body}${right}`);
  }

  cachedTermsKey = key;
  cachedLogRegex = pats.length > 0 ? new RegExp(pats.join("|"), "gi") : null;
  return cachedLogRegex;
}

function safeStringify(arg: unknown): string | null {
  try {
    const seen = new WeakSet();
    const str = JSON.stringify(arg, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
    return str;
  } catch {
    return null;
  }
}

// SEC-76: Keys whose values are masked before settings-like objects reach any log
const SECRET_KEY_PATTERN = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i;

export function redactSecrets(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      redacted[key] = "***";
    } else if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      redacted[key] = redactSecrets(val);
    } else {
      redacted[key] = val;
    }
  }
  return redacted;
}

// SEC-81: Absolute server paths must never reach client-facing error messages
const SERVER_PATH_PATTERN = /\/(?:opt|home|root|etc|var|usr|tmp)\/[^\s"'`]+/g;

export function scrubServerPaths(text: string): string {
  return text.replace(SERVER_PATH_PATTERN, "[REDACTED_PATH]");
}

export function createLogger(
  settings?: Partial<Settings>,
  destination?: pino.DestinationStream
) {
  const isHostLoopback = settings?.MASK_HOST ? isLoopback(settings.MASK_HOST) : true;
  // S-02: Force allowUnsafe to false on non-loopback host
  const allowUnsafe = isHostLoopback && settings?.MASK_ALLOW_UNSAFE_LOGGING === true;
  const level = settings?.MASK_LOG_LEVEL ?? "info";

  return pino(
    {
      level,
    hooks: {
      logMethod(inputArgs, method) {
        if (!allowUnsafe && activeTermGetter) {
          const terms = activeTermGetter();
          if (terms.length > 0) {
            const re = getLogGuardRegex(terms);
            if (re) {
              let hasUnserializable = false;
              let hasLeak = false;

              for (const arg of inputArgs) {
                let str: string | null;
                if (typeof arg === "string") {
                  str = arg;
                } else {
                  str = safeStringify(arg);
                }

                if (str === null) {
                  hasUnserializable = true;
                  break;
                }

                // SEC-51 & SEC-78: Strip zero-width and bidi control characters, then check
                // the entire string without truncation
                const cleanStr = str.replace(
                  /[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g,
                  ""
                );
                re.lastIndex = 0;
                if (re.test(cleanStr)) {
                  hasLeak = true;
                  break;
                }
              }

              if (hasUnserializable) {
                method.call(this, "[BLOCKED_BY_MASK_LOG_GUARD: unserializable log payload]");
                return;
              }

              if (hasLeak) {
                method.call(this, "[BLOCKED_BY_MASK_LOG_GUARD: sensitive term detected in log record]");
                return;
              }
            }
          }
        }
        method.apply(this, inputArgs as [any, ...any[]]);
      },
    },
  }, destination);
}

export const logger = createLogger();
