import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * dev·preview 서버에서도 배포(redirects)와 같은 루트 정규화(/, /mask, /mask/ →
 * /mask/mask)를 적용한다. 실제 전환 로직은 앱 내부(pushState)가 담당한다.
 */
function devRootNormalize(): Plugin {
  const normalize = (req: { url?: string }) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/mask" || url === "/mask/" || url.startsWith("/?")) {
      req.url = `/mask/mask${url.startsWith("/?") ? url.slice(1) : ""}`;
    }
  };
  return {
    name: "mask-dev-root-normalize",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        normalize(req);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        normalize(req);
        next();
      });
    },
  };
}

/**
 * 번들 무결성: 프레임워크가 심는 진단용 외부 URL(에러 도움말 링크·CSS 배너) 상수를
 * 제거한다. scripts/scan-bundle.mjs 는 번들 내 외부 URL을 0건으로 강제한다.
 */
function stripDiagnosticUrls(): Plugin {
  const replace = (code: string): string =>
    code.replaceAll("https://svelte.dev/e/", "").replaceAll("https://tailwindcss.com", "");
  return {
    name: "mask-strip-diagnostic-urls",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === "chunk" && /\.(js|css)$/.test(file.fileName)) {
          file.code = replace(file.code);
        } else if (file.type === "asset" && file.fileName.endsWith(".css")) {
          if (typeof file.source === "string") file.source = replace(file.source);
        }
      }
    },
  };
}

export default defineConfig({
  base: "/mask/",
  build: {
    outDir: "dist/mask",
    emptyOutDir: true,
  },
  plugins: [tailwindcss(), svelte(), devRootNormalize(), stripDiagnosticUrls()],
  server: {
    port: 8393,
    strictPort: true,
    fs: {
      // 엔진 소스(../src/privacy)를 직접 import하므로 상위 경로 허용
      allow: [repoRoot],
    },
  },
  resolve: {
    alias: {
      // 엔진의 terms.ts가 최상단에서 import하는 node 내장 모듈을 브라우저 스텁으로 치환.
      // 웹은 절대 호출하지 않는 경로(파일 로딩)이므로 스텁은 호출 시에만 예외를 던진다.
      "node:fs": fileURLToPath(new URL("./src/lib/stub-node-fs.ts", import.meta.url)),
      "node:path": fileURLToPath(new URL("./src/lib/stub-node-path.ts", import.meta.url)),
    },
  },
});
