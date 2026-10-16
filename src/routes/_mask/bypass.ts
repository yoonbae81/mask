import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  MAX_BYPASS_MINUTES,
  clearBypass,
  getBypassUntil,
  isBypassActive,
  setBypass,
} from "../../observability/bypass.ts";
import { enforceRateLimit } from "../../providers/proxy-handler.ts";
import { safeCompareToken } from "./activity.ts";

function bypassPayload(now = Date.now()) {
  const until = getBypassUntil();
  const active = isBypassActive(now);
  return {
    maskingBypassed: active,
    bypassUntil: active ? new Date(until).toISOString() : null,
    remainingSeconds: active ? Math.ceil((until - now) / 1000) : 0,
  };
}

// SEC-20 & SEC-52: Enforce admin token check (mandatory when MASK_ALLOW_REMOTE is true)
function requireAdmin(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply
): boolean {
  if (fastify.settings.MASK_ADMIN_TOKEN || fastify.settings.MASK_ALLOW_REMOTE) {
    if (
      !fastify.settings.MASK_ADMIN_TOKEN ||
      !safeCompareToken(request.headers.authorization, fastify.settings.MASK_ADMIN_TOKEN)
    ) {
      reply.status(401).send({
        statusCode: 401,
        error: "Unauthorized",
        message: "Invalid or missing admin token",
      });
      return false;
    }
  }
  return true;
}

const bypassRoute: FastifyPluginAsync = async (fastify) => {
  // 치환 일시정지 활성화 — { minutes } 동안 치환+가드를 건너뛴다.
  fastify.post("/bypass", async (request, reply) => {
    // SEC-79: Sliding-window rate limiting applies to admin routes as well
    if (!enforceRateLimit(fastify, request, reply)) return reply;
    if (!requireAdmin(fastify, request, reply)) return reply;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const minutes = body.minutes;
    if (
      typeof minutes !== "number" ||
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > MAX_BYPASS_MINUTES
    ) {
      return reply.status(400).send({
        statusCode: 400,
        error: "BadRequest",
        message: `minutes must be an integer between 1 and ${MAX_BYPASS_MINUTES}`,
      });
    }

    const until = setBypass(minutes);

    // 우회는 의도적 유출 통로 — 활성화 사실을 구조화 로그로 남긴다 (원문 기록 없음).
    request.log.info(
      { minutes, bypassUntil: new Date(until).toISOString() },
      "masking_bypass_enabled"
    );

    return bypassPayload();
  });

  // 치환 일시정지 해제 — 즉시 원복.
  fastify.delete("/bypass", async (request, reply) => {
    if (!enforceRateLimit(fastify, request, reply)) return reply;
    if (!requireAdmin(fastify, request, reply)) return reply;

    const wasActive = isBypassActive();
    clearBypass();
    if (wasActive) request.log.info({}, "masking_bypass_cleared");

    return { maskingBypassed: false, bypassUntil: null, remainingSeconds: 0 };
  });

  // 현재 bypass 상태 조회.
  fastify.get("/bypass", async (request, reply) => {
    if (!enforceRateLimit(fastify, request, reply)) return reply;
    if (!requireAdmin(fastify, request, reply)) return reply;
    return bypassPayload();
  });
};

export default bypassRoute;
