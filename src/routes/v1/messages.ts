import type { FastifyPluginAsync } from "fastify";
import { handleProxyRequest } from "../../providers/proxy-handler.ts";
import { anthropicRules } from "../../privacy/rules/anthropic.ts";

const messagesRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post("/messages", async (request, reply) => {
    return handleProxyRequest(fastify, request, reply, {
      dialect: "anthropic",
      path: "/v1/messages",
      rules: anthropicRules,
    });
  });
};

export default messagesRoute;
