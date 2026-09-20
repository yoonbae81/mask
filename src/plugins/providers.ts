import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { ProviderRegistry, loadProvidersFromFile } from "../providers/registry.ts";

declare module "fastify" {
  interface FastifyInstance {
    providers: ProviderRegistry;
  }
}

export interface ProvidersPluginOptions {
  providers?: ProviderRegistry;
}

const providersPlugin: FastifyPluginAsync<ProvidersPluginOptions> = async (
  fastify,
  opts
) => {
  if (fastify.hasDecorator("providers")) {
    return;
  }
  const providers =
    opts.providers ??
    loadProvidersFromFile(fastify.settings.resolvedProvidersFile);

  fastify.decorate("providers", providers);
};

export default fp(providersPlugin, {
  name: "providers",
  dependencies: ["settings"],
});
