import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { activityLog } from "../../observability/activity-log.ts";
import { enforceRateLimit } from "../../providers/proxy-handler.ts";

// SEC-75: Admin tokens must consist of printable safe ASCII within bounded length
const ADMIN_TOKEN_FORMAT = /^[A-Za-z0-9._~-]{8,256}$/;

export function safeCompareToken(header: string | undefined, expectedToken: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = header.slice(7);
  // SEC-75: Reject structurally invalid tokens before hashing/compare (no info leak either way)
  if (!ADMIN_TOKEN_FORMAT.test(provided)) return false;
  // SEC-54: Hash comparison with SHA-256 to eliminate timing oracle on token length
  const hashProvided = crypto.createHash("sha256").update(provided).digest();
  const hashExpected = crypto.createHash("sha256").update(expectedToken).digest();
  return crypto.timingSafeEqual(hashProvided, hashExpected);
}

const activityRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/activity", async (request, reply) => {
    // SEC-79: Sliding-window rate limiting applies to admin routes as well
    if (!enforceRateLimit(fastify, request, reply)) return reply;

    // SEC-20 & SEC-52: Enforce admin token check (mandatory when MASK_ALLOW_REMOTE is true)
    if (fastify.settings.MASK_ADMIN_TOKEN || fastify.settings.MASK_ALLOW_REMOTE) {
      if (!fastify.settings.MASK_ADMIN_TOKEN || !safeCompareToken(request.headers.authorization, fastify.settings.MASK_ADMIN_TOKEN)) {
        return reply.status(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Invalid or missing admin token",
        });
      }
    }

    // S-04: Activity feed disabled check
    if (fastify.settings.MASK_ENABLE_ACTIVITY_FEED === false) {
      return reply.status(403).send({
        statusCode: 403,
        error: "Forbidden",
        message: "Activity feed is disabled",
      });
    }

    // SEC-16: Clamp limit between 1 and 200
    const query = request.query as Record<string, unknown> | undefined;
    const rawLimit = typeof query?.limit === "string" ? parseInt(query.limit, 10) : 50;
    const limit = Math.max(1, Math.min(200, isNaN(rawLimit) ? 50 : rawLimit));

    return {
      events: activityLog.getEvents(limit),
      window: "최근 200건, 메모리만(재시작 시 소실)",
    };
  });
};

export default activityRoute;
