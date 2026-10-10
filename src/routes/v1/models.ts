import type { FastifyPluginAsync } from "fastify";
import { prepareOutboundHeaders } from "../../providers/auth.ts";
import { sendUpstream } from "../../providers/http.ts";
import { enforceRateLimit } from "../../providers/proxy-handler.ts";

const DROP_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "content-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "server",
  "via",
  "x-powered-by",
  "x-request-id",
]);

// Preferred catalog dialect per provider config (first configured endpoint wins)
function pickDialect(config: {
  endpoints: Record<string, string>;
}): "responses" | "openai" | "anthropic" | null {
  if (config.endpoints["responses"]) return "responses";
  if (config.endpoints["openai"]) return "openai";
  if (config.endpoints["anthropic"]) return "anthropic";
  return null;
}

const DEFAULT_MODELS_PATH: Record<string, string> = {
  responses: "/models",
  openai: "/v1/models",
  anthropic: "/v1/models",
};

const modelsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/models", async (request, reply) => {
    // SEC-79: Sliding-window rate limiting applies to /v1/models
    if (!enforceRateLimit(fastify, request, reply)) return reply;

    // Provider selection mirrors the proxy routes: x-mask-provider prefix
    // (set by app.rewriteUrl from /:provider/v1/...), else the active provider.
    const raw = request.headers["x-mask-provider"];
    let providerName: string | null = null;
    if (typeof raw === "string" && raw.length > 0) {
      if (!fastify.providers.providers.has(raw)) {
        return reply.status(404).send({
          statusCode: 404,
          error: "NotFound",
          message: `Unknown provider '${raw}' in route prefix`,
        });
      }
      providerName = raw;
    } else {
      providerName = fastify.providers.active;
    }
    const config = fastify.providers.getProvider(providerName);
    if (!config) {
      return reply.status(404).send({
        statusCode: 404,
        error: "NotFound",
        message: `Provider '${providerName}' is not configured`,
      });
    }

    const dialect = pickDialect(config);
    if (!dialect) {
      return reply.status(404).send({
        statusCode: 404,
        error: "NotFound",
        message: `Provider '${providerName}' has no configured endpoint`,
      });
    }

    const envSubset: Record<string, string | undefined> = {};
    if (config.auth === "api_key" && config.api_key_env) {
      envSubset[config.api_key_env] = process.env[config.api_key_env];
    }

    const headers = prepareOutboundHeaders(request.headers, config, dialect, envSubset);

    // Preserve the query string (e.g. codex client_version) and apply dialect path overrides
    const rawUrl = request.raw.url || request.url || "";
    const qIdx = rawUrl.indexOf("?");
    const qs = qIdx >= 0 ? rawUrl.slice(qIdx) : "";
    // models path: only an explicit paths["models"] override applies - the inference
    // paths override (e.g. responses -> /responses) must not leak into the catalog route
    const upstreamPath = config.paths?.["models"] ?? DEFAULT_MODELS_PATH[dialect];
    const upstreamUrl = `${config.endpoints[dialect]}${upstreamPath}${qs}`;

    const res = await sendUpstream(upstreamUrl, {
      method: "GET",
      headers,
    });

    // SEC-55: Enforce MASK_MAX_RESPONSE_BYTES limit on /v1/models to prevent OOM DoS
    const maxBytes = fastify.settings.MASK_MAX_RESPONSE_BYTES;
    const text = await res.readText(maxBytes + 1);
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      return reply.status(502).send({
        statusCode: 502,
        error: "BadGateway",
        message: `Upstream models response exceeded maximum limit of ${maxBytes} bytes`,
      });
    }
    reply.status(res.statusCode);

    // SEC-26: Drop sensitive infrastructure / session headers
    for (const [k, v] of Object.entries(res.headers)) {
      const lower = k.toLowerCase();
      if (
        v !== undefined &&
        !DROP_HEADERS.has(lower) &&
        !lower.startsWith("x-amzn-") &&
        !lower.endsWith("-request-id")
      ) {
        reply.header(k, v);
      }
    }
    return reply.send(text);
  });
};

export default modelsRoute;
