import { Agent, request, type Dispatcher } from "undici";
import type { Settings } from "../settings.ts";

const agentCache = new Map<number, Agent>();

const AGENT_POOL_CONFIG = {
  connections: 50,
  pipelining: 4,
  connectTimeout: 10_000,
  headersTimeout: 30_000,
};

export function getUpstreamAgent(settings?: Settings): Agent {
  const timeoutMs = (settings?.MASK_UPSTREAM_TIMEOUT ?? 600) * 1000;
  let agent = agentCache.get(timeoutMs);
  if (!agent) {
    agent = new Agent({
      connections: AGENT_POOL_CONFIG.connections,
      pipelining: AGENT_POOL_CONFIG.pipelining,
      headersTimeout: Math.min(AGENT_POOL_CONFIG.headersTimeout, timeoutMs),
      bodyTimeout: timeoutMs,
      connect: {
        timeout: AGENT_POOL_CONFIG.connectTimeout,
      },
    });
    agentCache.set(timeoutMs, agent);
  }
  return agent;
}

export function getUpstreamAgentStats() {
  return {
    cachedAgentsCount: agentCache.size,
    ...AGENT_POOL_CONFIG,
  };
}

export interface UpstreamResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  readText: (maxBytes?: number) => Promise<string>;
}

const utf8Decoder = new TextDecoder();

export async function sendUpstream(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    dispatcher?: Dispatcher;
  }
): Promise<UpstreamResponse> {
  const res = await request(url, {
    method: options.method ?? "POST",
    headers: options.headers,
    body: options.body,
    dispatcher: options.dispatcher,
  });

  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: res.body,
    readText: async (maxBytes?: number) => {
      if (!maxBytes) {
        return await res.body.text();
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      // PERF-42: Reuse module-level TextDecoder instead of instantiating per-read
      const decoder = utf8Decoder;
      let text = "";

      for await (const chunk of res.body) {
        const u8 = chunk as Uint8Array;
        if (totalBytes + u8.byteLength <= maxBytes) {
          chunks.push(u8);
          totalBytes += u8.byteLength;
          text += decoder.decode(u8, { stream: true });
        } else {
          const remaining = maxBytes - totalBytes;
          if (remaining > 0) {
            const slice = u8.subarray(0, remaining);
            chunks.push(slice);
            totalBytes += slice.byteLength;
            text += decoder.decode(slice, { stream: false });
          }
          break;
        }
      }
      return text;
    },
  };
}
