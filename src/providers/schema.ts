import { z } from "zod";

export const ProviderConfigSchema = z
  .object({
    type: z.literal("api"),
    auth: z.enum(["passthrough", "api_key"]),
    api_key_env: z.string().optional(),
    forward_headers: z.array(z.string().toLowerCase()).optional(),
    endpoints: z.record(z.string(), z.string().url()),
    // dialect 별 업스트림 경로 오버라이드 (예: 코딩 플랜 계열 엔드포인트는 /chat/completions)
    paths: z.record(z.string(), z.string().regex(/^\//, "must start with '/'")).optional(),
    // 크로스 다이얼렉트 폴백 시 클라이언트 모델명 → 업스트림 모델명 매핑 (일치 시에만 적용)
    model_map: z.record(z.string(), z.string()).optional(),
  })
  .refine((p) => p.auth !== "api_key" || !!p.api_key_env, {
    message: "auth: api_key 인 provider 는 api_key_env 가 필요합니다",
  });

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ProvidersFileSchema = z
  .object({
    active: z.string(),
    fallback: z.array(z.string()).default([]),
    providers: z.record(z.string(), ProviderConfigSchema),
  })
  .refine((f) => f.active in f.providers, {
    message: "active 가 providers 목록에 없습니다",
  })
  .refine(
    (f) => f.fallback.every((fb) => fb in f.providers),
    {
      message: "fallback 에 명시된 provider 가 providers 목록에 없습니다",
    }
  );

export type ProvidersFile = z.infer<typeof ProvidersFileSchema>;
