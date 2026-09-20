import path from "node:path";
import { fileURLToPath } from "node:url";
import AutoLoad from "@fastify/autoload";
import Fastify, { type FastifyInstance } from "fastify";
import { createLogger, scrubServerPaths } from "./logging.ts";
import { type Settings, parseSettings } from "./settings.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function buildApp(customSettings?: Settings) {
  const settings = customSettings ?? parseSettings(process.env);
  const logger = createLogger(settings);

  const app = Fastify({
    bodyLimit: settings.MASK_MAX_BODY_BYTES,
    loggerInstance: logger,
    // SEC-41 & SEC-73: Slowloris mitigation via explicit header/request timeouts.
    // SEC-73: fastify 5.12.5 only honors headersTimeout via Node createServer options (`http`).
    http: { headersTimeout: 10_000 },
    requestTimeout: 30_000,
    keepAliveTimeout: 5_000,
  });

  // Autoload plugins
  await app.register(AutoLoad, {
    dir: path.join(__dirname, "plugins"),
    options: { settings },
    ignorePattern: /.*\.test\.[jt]s$/,
  });

  // Autoload routes
  await app.register(AutoLoad, {
    dir: path.join(__dirname, "routes"),
    ignorePattern: /.*\.test\.[jt]s$/,
  });

  // SEC-44: Reject unsafe HTTP methods (TRACE, TRACK, CONNECT) to prevent XST and tunnel attacks
  app.addHook("onRequest", async (request, reply) => {
    const method = request.method.toUpperCase();
    if (method === "TRACE" || method === "TRACK" || method === "CONNECT") {
      reply.header("allow", "GET, POST, OPTIONS, HEAD");
      return reply.status(405).send({
        statusCode: 405,
        error: "MethodNotAllowed",
        message: `HTTP method ${request.method} is prohibited`,
      });
    }
  });

  // SEC-17, SEC-40, SEC-72 & PERF-48: Pre-frozen standard defense-in-depth security headers
  const STATIC_SECURITY_HEADERS = Object.freeze([
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "DENY"],
    ["referrer-policy", "no-referrer"],
    ["content-security-policy", "default-src 'none'"],
    // SEC-72: Disable powerful browser APIs via Permissions-Policy
    ["permissions-policy", "accelerometer=(), camera=(), microphone=()"],
  ] as const);

  app.addHook("onSend", async (_request, reply) => {
    for (const [k, v] of STATIC_SECURITY_HEADERS) {
      reply.header(k, v);
    }
    if (reply.statusCode >= 400) {
      reply.header("cache-control", "no-store");
    }
  });

  // SEC-36 & SEC-74: Origin validation against untrusted web origins on local proxy,
  // and optional exact-match origin allowlist when running in remote mode
  const allowedOrigins = settings.MASK_ALLOWED_ORIGINS
    .split(",")
    .map((o) => o.trim().toLowerCase())
    .filter((o) => o.length > 0);

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin) {
      const lower = origin.toLowerCase();
      const isLoopbackOrigin =
        lower.startsWith("http://127.0.0.1") ||
        lower.startsWith("http://localhost") ||
        lower.startsWith("http://[::1]");
      const rejected =
        !isLoopbackOrigin &&
        (!settings.MASK_ALLOW_REMOTE ||
          (allowedOrigins.length > 0 && !allowedOrigins.includes(lower)));
      if (rejected) {
        return reply.status(403).send({
          statusCode: 403,
          error: "Forbidden",
          message: "Cross-origin request from untrusted origin blocked",
        });
      }
    }
  });

  // SEC-24: Host header validation against DNS rebinding when running in local-only mode
  app.addHook("onRequest", async (request, reply) => {
    if (!settings.MASK_ALLOW_REMOTE) {
      const rawHost = request.headers.host;
      if (rawHost) {
        const hostName = rawHost.split(":")[0].toLowerCase();
        if (
          hostName !== "127.0.0.1" &&
          hostName !== "localhost" &&
          hostName !== "::1" &&
          !hostName.startsWith("127.")
        ) {
          return reply.status(403).send({
            statusCode: 403,
            error: "Forbidden",
            message: "Host header mismatch on local-only server",
          });
        }
      }
    }
  });

  app.setErrorHandler((error: any, request, reply) => {
    // SEC-45: Enforce strict defense-in-depth headers on all error responses
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", "no-store");

    const statusCode = error?.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error(error);
    } else {
      request.log.warn(error);
    }

    // S-03: Generalize error response to prevent information leakage (e.g. guard categories oracle, config paths)
    if (error?.name === "GuardTripped") {
      request.log.warn({ categories: error.categories }, "Outbound request blocked by privacy guard");
      return reply.status(502).send({
        statusCode: 502,
        error: "GuardTripped",
        message: "Outbound request blocked by privacy guard",
      });
    }

    if (error?.name === "ConfigurationError") {
      return reply.status(500).send({
        statusCode: 500,
        error: "ConfigurationError",
        message: "Server configuration error",
      });
    }

    if (error?.name === "UpstreamError") {
      return reply.status(statusCode).send({
        statusCode,
        error: "UpstreamError",
        // SEC-81: Scrub absolute server paths from client-facing upstream error messages
        message: scrubServerPaths(error?.message ?? "Upstream provider error"),
      });
    }

    const responseBody: Record<string, unknown> = {
      statusCode,
      error: error?.name ?? "InternalServerError",
      // SEC-81: Client-facing 4xx messages are path-scrubbed; 500s stay generic (S-03)
      message:
        statusCode >= 500
          ? "An internal error occurred"
          : scrubServerPaths(error?.message ?? "An error occurred"),
    };
    reply.status(statusCode).send(responseBody);
  });

  return app;
}
