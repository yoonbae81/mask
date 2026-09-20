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

const modelsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/models", async (request, reply) => {
    // SEC-79: Sliding-window rate limiting applies to /v1/models
    if (!enforceRateLimit(fastify, request, reply)) return reply;

    // Try openai dialect endpoint first, then anthropic
    let target;
    try {
      target = fastify.providers.resolveProvider("openai");
    } catch {
      target = fastify.providers.resolveProvider("anthropic");
    }

    // SEC-26: Isolate environment variable access
    const envSubset: Record<string, string | undefined> = {};
    if (target.config.auth === "api_key" && target.config.api_key_env) {
      envSubset[target.config.api_key_env] = process.env[target.config.api_key_env];
    }

    const headers = prepareOutboundHeaders(
      request.headers,
      target.config,
      target.config.endpoints["openai"] ? "openai" : "anthropic",
      envSubset
    );

    const upstreamUrl = `${target.endpoint}/v1/models`;
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
