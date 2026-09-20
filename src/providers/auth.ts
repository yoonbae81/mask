import { UpstreamError } from "../errors.ts";
import type { ProviderConfig } from "./schema.ts";

export type Dialect = "anthropic" | "openai";

function sanitizeHeader(val: string): string {
  return val
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

// SEC-57: Block hop-by-hop and request smuggling headers from being forwarded
const FORBIDDEN_FORWARD_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "content-length",
  "content-encoding",
]);

const DEFAULT_ALLOWED_PASSTHROUGH_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "anthropic-version",
  "anthropic-beta",
  "openai-organization",
  "openai-beta",
]);

export function prepareOutboundHeaders(
  clientHeaders: Record<string, string | string[] | undefined>,
  provider: ProviderConfig,
  dialect: Dialect,
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const outbound: Record<string, string> = {};

  // Lowercase client headers map with CRLF sanitization (SEC-12)
  const normalizedClient: Record<string, string> = {};
  for (const [key, value] of Object.entries(clientHeaders)) {
    if (value !== undefined) {
      const raw = Array.isArray(value) ? value.join(", ") : value;
      normalizedClient[key.toLowerCase()] = sanitizeHeader(raw);
    }
  }

  if (provider.auth === "passthrough") {
    // PERF-26: Use module-level Set for default passthrough headers
    const allowed = provider.forward_headers
      ? new Set(provider.forward_headers.map((h) => h.toLowerCase()))
      : DEFAULT_ALLOWED_PASSTHROUGH_HEADERS;

    for (const [k, v] of Object.entries(normalizedClient)) {
      if (allowed.has(k) && !FORBIDDEN_FORWARD_HEADERS.has(k)) {
        outbound[k] = v;
      }
    }
  } else if (provider.auth === "api_key") {
    // Explicitly REMOVE any client auth headers! (SEC-21: expanded auth header blocklist)
    const STRIPPED_AUTH_HEADERS = new Set([
      "authorization",
      "x-api-key",
      "api-key",
      "x-goog-api-key",
      "azure-openai-key",
      "x-ms-api-key",
    ]);

    const keyEnvName = provider.api_key_env;
    const apiKey = keyEnvName ? env[keyEnvName] : undefined;
    if (!apiKey) {
      throw new UpstreamError(
        "Upstream authentication credentials not configured for provider"
      );
    }

    // Forward non-auth headers if specified
    if (provider.forward_headers) {
      for (const h of provider.forward_headers) {
        const lower = h.toLowerCase();
        if (
          !STRIPPED_AUTH_HEADERS.has(lower) &&
          !FORBIDDEN_FORWARD_HEADERS.has(lower) &&
          normalizedClient[lower]
        ) {
          outbound[lower] = normalizedClient[lower];
        }
      }
    }

    // Preserve client anthropic-version or anthropic-beta if present
    if (normalizedClient["anthropic-version"]) {
      outbound["anthropic-version"] = normalizedClient["anthropic-version"];
    }
    if (normalizedClient["anthropic-beta"]) {
      outbound["anthropic-beta"] = normalizedClient["anthropic-beta"];
    }

    // Inject appropriate key
    if (dialect === "anthropic") {
      outbound["x-api-key"] = apiKey;
    } else {
      outbound["authorization"] = `Bearer ${apiKey}`;
    }
  }

  outbound["content-type"] = "application/json";
  return outbound;
}
