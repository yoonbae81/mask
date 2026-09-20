import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { type Settings, parseSettings } from "../settings.ts";

declare module "fastify" {
  interface FastifyInstance {
    settings: Settings;
  }
}

export interface SettingsPluginOptions {
  settings?: Settings;
}

const settingsPlugin: FastifyPluginAsync<SettingsPluginOptions> = async (
  fastify,
  opts
) => {
  if (fastify.hasDecorator("settings")) {
    return;
  }
  const settings = opts.settings ?? parseSettings(process.env);
  fastify.decorate("settings", settings);
};

export default fp(settingsPlugin, {
  name: "settings",
});
