import { Readable } from "node:stream";
import { isIP } from "node:net";
import type { FastifyRequest, FastifyReply, FastifyInstance } from "fastify";
import { walkJson } from "../privacy/walker.ts";
import { MaskSession } from "../privacy/mask.ts";
import { type Dialect, prepareOutboundHeaders } from "./auth.ts";
import { sendUpstream } from "./http.ts";
import { UpstreamError } from "../errors.ts";
import { activityLog } from "../observability/activity-log.ts";
import { RollingDetokenizer } from "../streaming/rolling.ts";
import { BufferedDetokenizer } from "../streaming/buffered.ts";
import { SseDetokenizer } from "../streaming/sse-detokenizer.ts";
import { OpenAIToAnthropicSseTranslator, AnthropicToOpenAISseTranslator } from "../streaming/sse-translate.ts";
import { translateRequestBody, translateResponseBody } from "./translate.ts";
import type { DialectRules } from "../privacy/rules/anthropic.ts";

// dialect 경로가 경로 오버라이드로 재정의되지 않았을 때 사용하는 기본 업스트림 경로
const DEFAULT_UPSTREAM_PATH: Record<Dialect, string> = {
  anthropic: "/v1/messages",
  openai: "/v1/chat/completions",
};

// SEC-79: Sliding-window rate limiter — per-IP timestamps of admitted requests
export const rateLimitMap = new Map<string, number[]>();

export function resetRateLimit(): void {
  rateLimitMap.clear();
}

const RATE_WINDOW_MS = 1000;

export function checkRateLimit(ip: string, maxRps: number): boolean {
  const now = Date.now();
  // PERF-34 & SEC-39: Lazy prune of stale entries when map exceeds 1000 items
  if (rateLimitMap.size > 1000) {
    for (const [k, stamps] of rateLimitMap.entries()) {
      const last = stamps.length > 0 ? stamps[stamps.length - 1] : 0;
      if (now - last >= RATE_WINDOW_MS) {
        rateLimitMap.delete(k);
      }
    }
    // SEC-39: Enforce strict upper bound on tracker entries to prevent unbounded memory growth
    if (rateLimitMap.size > 5000) {
      const keysToDelete = Array.from(rateLimitMap.keys()).slice(0, 2500);
      for (const k of keysToDelete) {
        rateLimitMap.delete(k);
      }
    }
  }
  let stamps = rateLimitMap.get(ip);
  if (!stamps) {
    stamps = [];
    rateLimitMap.set(ip, stamps);
  }
  while (stamps.length > 0 && now - stamps[0] >= RATE_WINDOW_MS) {
    stamps.shift();
  }
  if (stamps.length >= maxRps) {
    return false;
  }
  stamps.push(now);
  return true;
}

// SEC-15, SEC-42 & SEC-51: Client IP extraction with strict socket IP validation and sanitization
export function extractClientIp(request: FastifyRequest): string {
  let clientIp = request.ip;
  if (typeof clientIp === "string" && clientIp.includes(",")) {
    const first = clientIp.split(",")[0].trim();
    if (isIP(first) !== 0) {
      clientIp = first;
    }
  }
  if (!clientIp || isIP(clientIp) === 0) {
    clientIp =
      request.socket?.remoteAddress && isIP(request.socket.remoteAddress) !== 0
        ? request.socket.remoteAddress
        : "127.0.0.1";
  }
  return clientIp;
}

// SEC-79: Shared sliding-window enforcement for proxy, models, and admin routes (not /healthz)
export function enforceRateLimit(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply
): boolean {
  const clientIp = extractClientIp(request);
  if (!checkRateLimit(clientIp, fastify.settings.MASK_RATE_LIMIT_RPS)) {
    reply.status(429).send({
      statusCode: 429,
      error: "TooManyRequests",
      message: "Rate limit exceeded. Please slow down requests.",
    });
    return false;
  }
  return true;
}

// PERF-43: Frozen Set of headers to drop from upstream response
const DROP_RESPONSE_HEADERS = Object.freeze(
  new Set([
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
  ])
);

export async function handleProxyRequest(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  options: {
    dialect: Dialect;
    path: string;
    rules: DialectRules;
  }
) {
  const startTime = performance.now();
  const { dialect, path, rules } = options;

  // SEC-46: Request URI length limit (<= 2048) and query param count limit (<= 50) against URI flood DoS
  const rawUrl = request.raw.url || request.url;
  if (rawUrl && rawUrl.length > 2048) {
    return reply.status(414).send({
      statusCode: 414,
      error: "URITooLong",
      message: "Request URI exceeds maximum allowed length of 2048 characters",
    });
  }
  const queryKeys = Object.keys((request.query as object) || {});
  if (queryKeys.length > 50) {
    return reply.status(400).send({
      statusCode: 400,
      error: "BadRequest",
      message: "Exceeded maximum allowed query parameters count (50)",
    });
  }

  // SEC-32: Method whitelist on proxy completion endpoints
  if (request.method !== "POST") {
    reply.header("allow", "POST");
    return reply.status(405).send({
      statusCode: 405,
      error: "MethodNotAllowed",
      message: `HTTP method ${request.method} not allowed on this endpoint`,
    });
  }

  // SEC-34: Protection against path traversal and prototype pollution sequences
  if (
    path.includes("..") ||
    path.includes("\\") ||
    path.includes("__proto__") ||
    path.includes("constructor")
  ) {
    return reply.status(400).send({
      statusCode: 400,
      error: "BadRequest",
      message: "Invalid characters or sequences in request path",
    });
  }

  // SEC-53: Reject HTTP request smuggling attempt with both Transfer-Encoding and Content-Length (RFC 9112 Section 6.1)
  if (
    request.headers["transfer-encoding"] !== undefined &&
    request.headers["content-length"] !== undefined
  ) {
    return reply.status(400).send({
      statusCode: 400,
      error: "BadRequest",
      message: "Requests cannot contain both Transfer-Encoding and Content-Length headers",
    });
  }

  // SEC-15, SEC-42, SEC-51 & SEC-79: Sliding-window rate limiting enforcement
  if (!enforceRateLimit(fastify, request, reply)) {
    return reply;
  }

  // SEC-11, SEC-50 & SEC-54: Validate Content-Type for POST requests, parameter smuggling, and charset validation
  if (request.method === "POST") {
    const rawContentType = String(request.headers["content-type"] ?? "").toLowerCase();
    if (!rawContentType.includes("application/json")) {
      return reply.status(415).send({
        statusCode: 415,
        error: "UnsupportedMediaType",
        message: "Content-Type must be application/json",
      });
    }

    // SEC-50: Reject suspicious multipart or extra parameter smuggling in JSON content-type
    const parts = rawContentType.split(";").map((s) => s.trim());
    if (parts[0] !== "application/json" || parts.length > 2) {
      return reply.status(400).send({
        statusCode: 400,
        error: "BadRequest",
        message: "Malformed or suspicious Content-Type header parameters",
      });
    }

    // SEC-54: Validate charset if specified in Content-Type (reject UTF-7, UTF-16, etc. to prevent encoding evasion)
    if (parts.length === 2) {
      const charsetPart = parts[1];
      if (charsetPart.startsWith("charset=")) {
        const charset = charsetPart.slice(8).replace(/["']/g, "").toLowerCase();
        if (charset !== "utf-8" && charset !== "us-ascii" && charset !== "ascii" && charset !== "iso-8859-1") {
          return reply.status(415).send({
            statusCode: 415,
            error: "UnsupportedMediaType",
            message: `Unsupported charset '${charset}' in Content-Type header`,
          });
        }
      }
    }

    // SEC-33: Content-Length check against maximum allowed body size
    const contentLength = request.headers["content-length"];
    if (contentLength !== undefined) {
      const parsedLen = Number.parseInt(String(contentLength), 10);
      if (Number.isNaN(parsedLen) || parsedLen < 0 || parsedLen > fastify.settings.MASK_MAX_BODY_BYTES) {
        return reply.status(413).send({
          statusCode: 413,
          error: "PayloadTooLarge",
          message: `Content-Length exceeds maximum allowed size (${fastify.settings.MASK_MAX_BODY_BYTES} bytes)`,
        });
      }
    }
  }

  const rawBody = request.body ?? {};

  // SEC-14: Model parameter validation
  if ((rawBody as any)?.model) {
    const modelVal = (rawBody as any).model;
    if (typeof modelVal === "string" && (modelVal.length > 128 || /[\x00-\x1f]/.test(modelVal))) {
      return reply.status(400).send({
        statusCode: 400,
        error: "BadRequest",
        message: "Invalid or excessively long model parameter",
      });
    }
  }

  // SEC-28: Validate hyperparameters (max_tokens, temperature)
  if ((rawBody as any)?.max_tokens !== undefined) {
    const maxTok = (rawBody as any).max_tokens;
    if (typeof maxTok !== "number" || !Number.isInteger(maxTok) || maxTok <= 0 || maxTok > 1_000_000) {
      return reply.status(400).send({
        statusCode: 400,
        error: "BadRequest",
        message: "Invalid max_tokens parameter: must be a positive integer <= 1,000,000",
      });
    }
  }

  if ((rawBody as any)?.temperature !== undefined) {
    const temp = (rawBody as any).temperature;
    if (typeof temp !== "number" || isNaN(temp) || temp < 0 || temp > 2.0) {
      return reply.status(400).send({
        statusCode: 400,
        error: "BadRequest",
        message: "Invalid temperature parameter: must be between 0.0 and 2.0",
      });
    }
  }

  // 1-2. Per-request mask session (matchers cached in TermSet, TokenMap per request)
  const session = new MaskSession(fastify.termSet, {
    tokenFormat: fastify.settings.MASK_TOKEN_FORMAT,
    guard: fastify.settings.MASK_GUARD,
    termEscape: fastify.settings.MASK_TERM_ESCAPE,
  });
  const tokenMap = session.tokenMap;
  const tokenizedBody = walkJson(rawBody, rules, (text) => session.mask(text));

  // 3. Serialize and Guard check
  const serialized = JSON.stringify(tokenizedBody);

  try {
    session.assertNoLeak(serialized);
  } catch (err) {
    activityLog.record({
      ts: new Date().toISOString(),
      requestId: String(request.id),
      provider: fastify.providers.active,
      dialect,
      masked: tokenMap.getCategoriesCount(),
      bypassed: session.getBypassedCounts(),
      guardTripped: true,
      durationMs: Math.round(performance.now() - startTime),
    });
    throw err;
  }

  // 4. Resolve provider and candidate fallback chain (폴백은 다른 dialect 허용 — 자동 번역)
  const primary = fastify.providers.resolveCandidate(dialect, fastify.providers.active);
  if (!primary) {
    throw new UpstreamError(
      `Provider '${fastify.providers.active}' cannot serve dialect '${dialect}' (no compatible endpoint configured)`
    );
  }
  const fallbacks = fastify.providers.fallback
    .filter((name) => name !== primary.providerName)
    .flatMap((name) => {
      const cand = fastify.providers.resolveCandidate(dialect, name);
      return cand ? [cand] : [];
    });
  const candidateChain = [primary, ...fallbacks];

  let lastResponse: any = null;
  let lastError: any = null;
  let usedCandidate = primary;
  let cachedResponseText: string | null = null;

  for (let i = 0; i < candidateChain.length; i++) {
    const candidate = candidateChain[i];
    usedCandidate = candidate;
    cachedResponseText = null;

    // 크로스 다이얼렉트: 후보가 inbound dialect 를 지원하지 않으면 번역해서 전송한다
    const upstreamDialect = candidate.upstreamDialect;
    const translated = upstreamDialect !== dialect;
    const clientModel =
      typeof (rawBody as any)?.model === "string" ? (rawBody as any).model : undefined;
    let outboundBody = serialized;
    if (translated) {
      const translatedBody = translateRequestBody(tokenizedBody, dialect, upstreamDialect, {
        modelMap: candidate.config.model_map,
      });
      outboundBody = JSON.stringify(translatedBody);
      try {
        // 번역 과정에서 마스킹 토큰이 유실되지 않았는지 재검증한다 (fail-closed)
        session.assertNoLeak(outboundBody);
      } catch (err) {
        activityLog.record({
          ts: new Date().toISOString(),
          requestId: String(request.id),
          provider: candidate.providerName,
          dialect,
          masked: tokenMap.getCategoriesCount(),
      bypassed: session.getBypassedCounts(),
          guardTripped: true,
          translated: true,
          durationMs: Math.round(performance.now() - startTime),
        });
        throw err;
      }
    }

    // S-06: Pass only needed environment variable instead of full process.env
    const envSubset: Record<string, string | undefined> = {};
    if (candidate.config.auth === "api_key" && candidate.config.api_key_env) {
      envSubset[candidate.config.api_key_env] = process.env[candidate.config.api_key_env];
    }

    const outboundHeaders = prepareOutboundHeaders(
      request.headers,
      candidate.config,
      upstreamDialect,
      envSubset
    );
    if (translated && upstreamDialect === "anthropic" && !outboundHeaders["anthropic-version"]) {
      outboundHeaders["anthropic-version"] = "2023-06-01";
    }

    const upstreamUrl = `${candidate.endpoint}${candidate.config.paths?.[upstreamDialect] ?? (upstreamDialect === dialect ? path : DEFAULT_UPSTREAM_PATH[upstreamDialect])}`;

    // SEC-55: Strictly restrict provider URL protocol and reject embedded userinfo
    try {
      const parsedUpstream = new URL(upstreamUrl);
      if (parsedUpstream.protocol !== "http:" && parsedUpstream.protocol !== "https:") {
        return reply.status(502).send({
          statusCode: 502,
          error: "BadGateway",
          message: `Invalid upstream protocol: ${parsedUpstream.protocol}. Only HTTP and HTTPS are permitted.`,
        });
      }
      if (parsedUpstream.username || parsedUpstream.password) {
        return reply.status(502).send({
          statusCode: 502,
          error: "BadGateway",
          message: "Upstream endpoint must not contain userinfo credentials",
        });
      }
    } catch (e: any) {
      return reply.status(502).send({
        statusCode: 502,
        error: "BadGateway",
        message: `Invalid upstream endpoint: ${e?.message ?? "URL validation failed"}`,
      });
    }

    try {
      lastResponse = await sendUpstream(upstreamUrl, {
        method: request.method,
        headers: outboundHeaders,
        body: outboundBody,
      });

      const isStatusRetryable = [429, 402, 529].includes(lastResponse.statusCode);
      const hasRetryAfter = !!lastResponse.headers["retry-after"];
      const isClientStream =
        (rawBody as any)?.stream === true ||
        String(lastResponse.headers["content-type"]).includes("text/event-stream");

      if (i < candidateChain.length - 1) {
        if (isStatusRetryable || hasRetryAfter) {
          request.log.warn(
            `Upstream provider '${candidate.providerName}' returned ${lastResponse.statusCode}. Falling back...`
          );
          continue;
        }

        // P-07: For non-streaming requests with 4xx errors, inspect body for quota error with 4KB peek limit
        if (!isClientStream && lastResponse.statusCode >= 400 && lastResponse.statusCode < 500) {
          const bodyText = await lastResponse.readText(4096);
          if (/quota|insufficient/i.test(bodyText)) {
            request.log.warn(
              `Upstream provider '${candidate.providerName}' returned ${lastResponse.statusCode} with quota error in body. Falling back...`
            );
            continue;
          }
          cachedResponseText = bodyText;
        }
      }
      break;
    } catch (err) {
      lastError = err;
      if (i < candidateChain.length - 1) {
        request.log.warn(
          `Upstream provider '${candidate.providerName}' failed: ${err}. Falling back...`
        );
        continue;
      }
      throw err;
    }
  }

  if (!lastResponse && lastError) {
    throw lastError;
  }

  // S-07: Only emit X-Mask-Provider-Used if debug headers enabled or fallback provider was used
  if (fastify.settings.MASK_DEBUG_HEADERS || usedCandidate.providerName !== primary.providerName) {
    reply.header("X-Mask-Provider-Used", usedCandidate.providerName);
  }
  if (fastify.settings.MASK_DEBUG_HEADERS && usedCandidate.upstreamDialect !== dialect) {
    reply.header("X-Mask-Translated", usedCandidate.upstreamDialect);
  }

  // P-08: Check response size against MASK_MAX_RESPONSE_BYTES
  const contentLength = parseInt(String(lastResponse.headers["content-length"] ?? "0"), 10);
  if (
    !isNaN(contentLength) &&
    contentLength > 0 &&
    contentLength > fastify.settings.MASK_MAX_RESPONSE_BYTES
  ) {
    return reply.status(502).send({
      statusCode: 502,
      error: "BadGateway",
      message: "Upstream response exceeded maximum allowed bytes limit",
    });
  }

  const upstreamIsSse = String(lastResponse.headers["content-type"]).includes("text/event-stream");
  const isStream = (rawBody as any)?.stream === true || upstreamIsSse;
  const usedTranslated = usedCandidate.upstreamDialect !== dialect;
  const clientModel =
    typeof (rawBody as any)?.model === "string" ? (rawBody as any).model : undefined;

  // 5. Response handling
  if (isStream) {
    reply.status(lastResponse.statusCode);
    reply.header("content-type", "text/event-stream");
    reply.header("cache-control", "no-cache");
    reply.header("connection", "keep-alive");

    let webStream: unknown;
    if (usedTranslated && upstreamIsSse) {
      // 응답을 클라이언트 dialect 로 번역한 뒤 토큰을 복원한다
      const translator =
        usedCandidate.upstreamDialect === "openai"
          ? new OpenAIToAnthropicSseTranslator({ clientModel })
          : new AnthropicToOpenAISseTranslator({ clientModel });
      webStream = Readable.toWeb(lastResponse.body as any)
        .pipeThrough(translator as any)
        .pipeThrough(new SseDetokenizer(tokenMap) as any);
    } else {
      // SSE 업스트림은 JSON 프레이밍 때문에 토큰이 delta 경계로 갈라지므로
      // 이벤트 단위 재조립이 필요하다. 비SSE 스트림은 기존 변환기를 유지한다.
      const transform = upstreamIsSse
        ? new SseDetokenizer(tokenMap)
        : fastify.settings.MASK_STREAMING_MODE === "buffer"
          ? new BufferedDetokenizer(tokenMap)
          : new RollingDetokenizer(tokenMap);
      webStream = Readable.toWeb(lastResponse.body as any).pipeThrough(transform as any);
    }

    activityLog.record({
      ts: new Date().toISOString(),
      requestId: String(request.id),
      provider: usedCandidate.providerName,
      dialect,
      masked: tokenMap.getCategoriesCount(),
      bypassed: session.getBypassedCounts(),
      guardTripped: false,
      translated: usedTranslated,
      upstreamStatus: lastResponse.statusCode,
      durationMs: Math.round(performance.now() - startTime),
    });

    return reply.send(webStream);
  }

  // Non-streaming response
  const rawResponseText = cachedResponseText ?? (await lastResponse.readText());
  reply.status(lastResponse.statusCode);
  // S-07, PERF-35 & SEC-48: Filter response headers using module-level Set and sanitize Content-Disposition
  for (const [k, v] of Object.entries(lastResponse.headers)) {
    const lower = k.toLowerCase();
    if (
      v !== undefined &&
      !DROP_RESPONSE_HEADERS.has(lower) &&
      !lower.startsWith("x-amzn-") &&
      !lower.endsWith("-request-id")
    ) {
      if (lower === "content-disposition") {
        // SEC-48: Sanitize content-disposition to prevent header injection or directory traversal
        const sanitizedCd = String(v).replace(/[\r\n]/g, "").replace(/\.\.[/\\]/g, "");
        reply.header(k, sanitizedCd);
      } else {
        reply.header(k, v);
      }
    }
  }

  activityLog.record({
    ts: new Date().toISOString(),
    requestId: String(request.id),
    provider: usedCandidate.providerName,
    dialect,
    masked: tokenMap.getCategoriesCount(),
      bypassed: session.getBypassedCounts(),
    guardTripped: false,
    translated: usedTranslated,
    upstreamStatus: lastResponse.statusCode,
    durationMs: Math.round(performance.now() - startTime),
  });

  const contentType = String(lastResponse.headers["content-type"] ?? "");
  if (contentType.includes("application/json")) {
    // 번역 경로의 업스트림 오류 본문은 벤더별 형식이 상이하므로 번역 없이 토큰만 복원한다
    if (usedTranslated && lastResponse.statusCode >= 400) {
      return reply.send(session.restore(rawResponseText));
    }
    try {
      const parsed = JSON.parse(rawResponseText);
      let restoredSource: unknown = parsed;
      let sourceText = rawResponseText;
      if (usedTranslated) {
        // 번역을 먼저 수행한다 — 토큰 부재 fast-path 라도 형식 변환은 필요하다
        const translatedResp = translateResponseBody(
          parsed,
          usedCandidate.upstreamDialect,
          dialect,
          { clientModel }
        );
        sourceText = JSON.stringify(translatedResp);
        restoredSource = translatedResp;
      }
      // PERF-13: Fast-path: if response text contains no tokens, return directly without JSON parsing and walking
      if (!tokenMap.hasAnyTokenInText(sourceText)) {
        return reply.send(sourceText);
      }
      return reply.send(walkJson(restoredSource, rules, (text) => session.restore(text)));
    } catch {
      return reply.send(session.restore(rawResponseText));
    }
  }

  return reply.send(session.restore(rawResponseText));
}
