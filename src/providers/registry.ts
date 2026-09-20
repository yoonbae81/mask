import fs from "node:fs";
import YAML from "yaml";
import { ConfigurationError, UpstreamError } from "../errors.ts";
import { type Dialect } from "./auth.ts";
import {
  type ProviderConfig,
  type ProvidersFile,
  ProvidersFileSchema,
} from "./schema.ts";

export function validateEndpointUrl(endpoint: string, providerName: string, dialect: string) {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ConfigurationError(
      `Invalid URL '${endpoint}' for provider '${providerName}' dialect '${dialect}'`
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationError(
      `Forbidden protocol '${parsed.protocol}' in endpoint for provider '${providerName}'`
    );
  }

  // SEC-56: Reject embedded user credentials in endpoint URLs
  if (parsed.username || parsed.password) {
    throw new ConfigurationError(
      `Embedded credentials in endpoint for provider '${providerName}' are forbidden`
    );
  }

  const rawHost = parsed.hostname.toLowerCase();
  const host = rawHost.replace(/^\[|\]$/g, "");
  const BLOCKED_HOSTS = new Set([
    "169.254.169.254",
    "metadata.google.internal",
    "metadata.azure.com",
    "instance-data",
    "::1",
    "0.0.0.0",
  ]);

  if (
    BLOCKED_HOSTS.has(host) ||
    host.startsWith("169.254.") ||
    host.startsWith("fe80:") ||
    host.startsWith("fd00:") ||
    host.startsWith("::ffff:169.254.") ||
    host === "::ffff:a9fe:a9fe"
  ) {
    throw new ConfigurationError(
      `SSRF blocked: Cloud metadata endpoint '${rawHost}' is forbidden in provider '${providerName}'`
    );
  }

  // SEC-29 & SEC-56: Block dangerous internal service, container, and database ports
  const FORBIDDEN_PORTS = new Set([
    "22", "23", "25", "2375", "2376", "3306", "5432", "6379", "9000", "10250", "10255", "11211", "27017"
  ]);
  if (parsed.port && FORBIDDEN_PORTS.has(parsed.port)) {
    throw new ConfigurationError(
      `Forbidden port '${parsed.port}' in endpoint for provider '${providerName}'`
    );
  }
}

export class ProviderRegistry {
  readonly active: string;
  readonly fallback: string[];
  readonly providers: Map<string, ProviderConfig>;

  constructor(fileData: ProvidersFile) {
    this.active = fileData.active;
    this.fallback = fileData.fallback;
    this.providers = new Map(Object.entries(fileData.providers));

    // SEC-18: Validate all configured endpoints for SSRF safety
    for (const [pName, pConfig] of this.providers.entries()) {
      for (const [dialect, url] of Object.entries(pConfig.endpoints)) {
        validateEndpointUrl(url, pName, dialect);
      }
    }
  }

  getProvider(name: string): ProviderConfig | undefined {
    return this.providers.get(name);
  }

  resolveProvider(
    dialect: Dialect,
    targetProviderName?: string
  ): { providerName: string; config: ProviderConfig; endpoint: string } {
    const providerName = targetProviderName ?? this.active;
    const config = this.getProvider(providerName);

    if (!config) {
      throw new UpstreamError(`Provider '${providerName}' is not defined`);
    }

    const endpoint = config.endpoints[dialect];
    if (!endpoint) {
      throw new UpstreamError(
        `Provider '${providerName}' does not support dialect '${dialect}' (no endpoint configured)`
      );
    }

    return {
      providerName,
      config,
      endpoint: endpoint.replace(/\/+$/, ""),
    };
  }

  getFallbackCandidates(dialect: Dialect): Array<{
    providerName: string;
    config: ProviderConfig;
    endpoint: string;
  }> {
    const list: Array<{ providerName: string; config: ProviderConfig; endpoint: string }> = [];

    for (const name of this.fallback) {
      const config = this.getProvider(name);
      if (config && config.endpoints[dialect]) {
        list.push({
          providerName: name,
          config,
          endpoint: config.endpoints[dialect].replace(/\/+$/, ""),
        });
      }
    }

    return list;
  }

  // 크로스 다이얼렉트 폴백: inbound dialect 엔드포인트가 없으면 반대 dialect 로 번역 전송한다
  resolveCandidate(
    inbound: Dialect,
    name: string
  ): { providerName: string; config: ProviderConfig; endpoint: string; upstreamDialect: Dialect } | undefined {
    const config = this.getProvider(name);
    if (!config) return undefined;

    const other: Dialect = inbound === "anthropic" ? "openai" : "anthropic";
    const upstreamDialect = config.endpoints[inbound] ? inbound : config.endpoints[other] ? other : undefined;
    if (!upstreamDialect) return undefined;

    return {
      providerName: name,
      config,
      endpoint: config.endpoints[upstreamDialect].replace(/\/+$/, ""),
      upstreamDialect,
    };
  }
}

export function loadProvidersFromFile(filePath: string): ProviderRegistry {
  if (!fs.existsSync(filePath)) {
    throw new ConfigurationError(`Providers file does not exist: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (e: any) {
    throw new ConfigurationError(`YAML parse error in ${filePath}: ${e.message}`);
  }

  const result = ProvidersFileSchema.safeParse(parsed);
  if (!result.success) {
    const msgs = result.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    throw new ConfigurationError(`Providers validation error in ${filePath}: ${msgs}`);
  }

  return new ProviderRegistry(result.data);
}
