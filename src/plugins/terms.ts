import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { TermSet, loadTermsFromFileOrDir } from "../privacy/terms.ts";
import { setActiveTermGetter } from "../logging.ts";

declare module "fastify" {
  interface FastifyInstance {
    termSet: TermSet;
  }
}

export interface TermsPluginOptions {
  termSet?: TermSet;
}

const termsPlugin: FastifyPluginAsync<TermsPluginOptions> = async (
  fastify,
  opts
) => {
  if (fastify.hasDecorator("termSet")) {
    return;
  }
  const termSet =
    opts.termSet ??
    loadTermsFromFileOrDir(fastify.settings.resolvedTermsFile);

  fastify.decorate("termSet", termSet);
  setActiveTermGetter(() => termSet.activeTerms());
};

export default fp(termsPlugin, {
  name: "terms",
  dependencies: ["settings"],
});
