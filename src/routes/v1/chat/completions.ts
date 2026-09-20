import type { FastifyPluginAsync } from "fastify";
import { handleProxyRequest } from "../../../providers/proxy-handler.ts";
import { openAiRules } from "../../../privacy/rules/openai.ts";

const completionsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post("/completions", async (request, reply) => {
    return handleProxyRequest(fastify, request, reply, {
      dialect: "openai",
      path: "/v1/chat/completions",
      rules: openAiRules,
    });
  });
};

export default completionsRoute;
