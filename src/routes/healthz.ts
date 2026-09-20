import type { FastifyPluginAsync } from "fastify";

const HEALTH_PAYLOAD = JSON.stringify({ status: "ok" });

const healthz: FastifyPluginAsync = async (fastify) => {
  fastify.get("/healthz", async (_request, reply) => {
    // SEC-70: Security headers on health probe: anti-indexing and content type nosniff
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate");
    reply.header("Pragma", "no-cache");
    reply.header("X-Robots-Tag", "noindex, nofollow");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.type("application/json");
    return reply.send(HEALTH_PAYLOAD);
  });
};

export default healthz;
