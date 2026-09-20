import type { FastifyPluginAsync } from "fastify";
import { handleProxyRequest } from "../../providers/proxy-handler.ts";
import { openAiRules } from "../../privacy/rules/openai.ts";

const responsesRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post("/responses", async (request, reply) => {
    return handleProxyRequest(fastify, request, reply, {
      dialect: "openai",
      path: "/v1/responses",
      rules: openAiRules,
    });
  });
};

export default responsesRoute;
