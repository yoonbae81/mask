import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { getUpstreamAgentStats } from "../../providers/http.ts";
import { enforceRateLimit } from "../../providers/proxy-handler.ts";
import { safeCompareToken } from "./activity.ts";

const statusRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/status", async (request, reply) => {
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

    const termSet = fastify.termSet;
    const providers = fastify.providers;
    const settings = fastify.settings;

    return {
      status: "ok",
      version: "0.1.0",
      guard: settings.MASK_GUARD,
      // SEC-53: Hide absolute internal host paths from status endpoint
      termsFile: path.basename(settings.resolvedTermsFile),
      providersFile: path.basename(settings.resolvedProvidersFile),
      protectedTermsCount: termSet.totalTermsCount,
      commentedOutCount: termSet.totalCommentedOutCount,
      strictCount: termSet.totalStrictCount,
      patternsCount: termSet.activePatterns().length,
      activeProvider: providers.active,
      fallbackProviders: providers.fallback,
      agentPool: getUpstreamAgentStats(),
    };
  });
};

export default statusRoute;
