import type { FastifyPluginAsync } from "fastify";
import { handleProxyRequest } from "../../providers/proxy-handler.ts";
import { openAiRules } from "../../privacy/rules/openai.ts";

// Native Responses API passthrough: forwarded as-is to the selected provider
// (e.g. openai-codex -> chatgpt.com/backend-api/codex) with client auth headers.
const responsesRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post("/responses", async (request, reply) => {
    return handleProxyRequest(fastify, request, reply, {
      dialect: "responses",
      rawSse: true,
      path: "/responses",
      rules: openAiRules,
    });
  });
};

export default responsesRoute;
