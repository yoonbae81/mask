import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigurationError } from "./errors.ts";

const booleanSchema = (defaultValue: boolean) =>
  z.preprocess((val) => {
    if (val === undefined || val === "") return defaultValue;
    if (typeof val === "string") {
      const lower = val.toLowerCase().trim();
      if (lower === "true" || lower === "1") return true;
      if (lower === "false" || lower === "0") return false;
    }
    return Boolean(val);
  }, z.boolean().default(defaultValue));

export function isLoopback(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  return (
    trimmed === "127.0.0.1" ||
    trimmed === "localhost" ||
    trimmed === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)
  );
}

export const EnvSchema = z.object({
  MASK_TERMS_FILE: z.string().min(1, "MASK_TERMS_FILE is required"),
  MASK_PROVIDERS_FILE: z.string().min(1, "MASK_PROVIDERS_FILE is required"),
  MASK_HOST: z.string().default("127.0.0.1"),
  MASK_PORT: z.coerce.number().int().positive().default(8787),
  MASK_ALLOW_REMOTE: booleanSchema(false),
  // SEC-74: Comma-separated exact origins allowed in remote mode (empty = no restriction)
  MASK_ALLOWED_ORIGINS: z.string().default(""),
  MASK_ADMIN_TOKEN: z.string().optional(),
  MASK_ENABLE_ACTIVITY_FEED: booleanSchema(true),
  MASK_STREAMING_MODE: z.enum(["rolling", "buffer"]).default("rolling"),
  MASK_FAIL_CLOSED: booleanSchema(true),
  MASK_GUARD: z.enum(["on", "off"]).default("on"),
  MASK_TERM_ESCAPE: booleanSchema(false),
  MASK_TOKEN_FORMAT: z
    .string()
    .default("<{type}_{n}>")
    .refine(
      (fmt) =>
        fmt.includes("{type}") &&
        fmt.includes("{n}") &&
        fmt.length <= 30 &&
        /^[<\[(][A-Za-z0-9_{}]+[>\])]$/.test(fmt),
      {
        message:
          "MASK_TOKEN_FORMAT must include {type} and {n}, be wrapped in brackets, and not exceed 30 chars",
      }
    ),
  MASK_RATE_LIMIT_RPS: z.coerce.number().positive().default(60),
  MASK_UPSTREAM_TIMEOUT: z.coerce.number().positive().default(600),
  MASK_MAX_BODY_BYTES: z.coerce.number().positive().default(8_388_608),
  MASK_MAX_RESPONSE_BYTES: z.coerce.number().positive().default(33_554_432),
  MASK_LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  MASK_LOG_PAYLOADS: booleanSchema(false),
  MASK_ALLOW_UNSAFE_LOGGING: booleanSchema(false),
  MASK_DEBUG_HEADERS: booleanSchema(false),
});

export type Settings = z.infer<typeof EnvSchema> & {
  resolvedTermsFile: string;
  resolvedProvidersFile: string;
};

export function parseSettings(
  env: Record<string, string | undefined> = process.env,
  options: { checkFilesExist?: boolean; cwd?: string } = {}
): Settings {
  const { checkFilesExist = true, cwd = process.cwd() } = options;

  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const errorMessages = result.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    throw new ConfigurationError(`Environment configuration error: ${errorMessages}`);
  }

  const raw = result.data;

  // S-05: Non-loopback binding guard
  if (!isLoopback(raw.MASK_HOST) && !raw.MASK_ALLOW_REMOTE) {
    throw new ConfigurationError(
      `MASK_HOST cannot be set to a non-loopback address ('${raw.MASK_HOST}') without MASK_ALLOW_REMOTE=true`
    );
  }

  // S-01: MASK_GUARD=off with MASK_FAIL_CLOSED=true guard
  if (raw.MASK_GUARD === "off" && raw.MASK_FAIL_CLOSED === true) {
    throw new ConfigurationError(
      "MASK_GUARD cannot be 'off' while MASK_FAIL_CLOSED is true (fail-closed violated)"
    );
  }

  // S-02: Disallow unsafe logging on non-loopback host
  if (!isLoopback(raw.MASK_HOST) && raw.MASK_ALLOW_UNSAFE_LOGGING === true) {
    throw new ConfigurationError(
      "MASK_ALLOW_UNSAFE_LOGGING is strictly forbidden on non-loopback host"
    );
  }

  const resolvedTermsFile = path.resolve(cwd, raw.MASK_TERMS_FILE);
  const resolvedProvidersFile = path.resolve(cwd, raw.MASK_PROVIDERS_FILE);

  if (checkFilesExist) {
    if (!fs.existsSync(resolvedTermsFile)) {
      throw new ConfigurationError(
        `MASK_TERMS_FILE does not exist: ${resolvedTermsFile}`
      );
    }
    if (!fs.existsSync(resolvedProvidersFile)) {
      throw new ConfigurationError(
        `MASK_PROVIDERS_FILE does not exist: ${resolvedProvidersFile}`
      );
    }
  }

  return {
    ...raw,
    resolvedTermsFile,
    resolvedProvidersFile,
  };
}
