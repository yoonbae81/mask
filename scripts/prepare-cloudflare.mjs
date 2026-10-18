// Cloudflare Static Assets용 `_redirects`/`_headers`를 vercel.json에서 생성해
// web/dist(assets 루트)에 쓴다. md2hwpx의 동명 스크립트와 동일한 패턴.
//
// - 웹 라우트 3개(/mask/mask·restore·terms)는 200 rewrite로 index.html을 서빙(SPA).
//   미지정 경로는 앱 라우터(router.svelte.ts)가 replaceState로 /mask/mask 정규화하므로
//   서버는 3개만 알면 된다.
// - `/`, `/mask`, `/mask/`는 Vercel redirects와 같은 302.
// - assets는 immutable 캐시, 나머지는 must-revalidate로 배포 즉시 반영.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const destination = process.argv[2] ?? "web/dist";
const vercel = JSON.parse(
  await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
);

// 순서 매칭: 200 rewrite를 302 splat보다 먼저 둔다.
const redirects = [
  "/mask/mask /mask/index.html 200",
  "/mask/restore /mask/index.html 200",
  "/mask/terms /mask/index.html 200",
  ...["/", "/mask", "/mask/"].map((path) => `${path} /mask/mask 302`),
].join("\n") + "\n";

const security = vercel.headers.find((h) => h.source === "/(.*)").headers;
const headers =
  "/*\n" +
  security.map(({ key, value }) => `  ${key}: ${value}`).join("\n") +
  "\n  Cache-Control: public, max-age=0, must-revalidate\n\n" +
  "/mask/assets/*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable\n";

await mkdir(destination, { recursive: true });
await writeFile(join(destination, "_redirects"), redirects);
await writeFile(join(destination, "_headers"), headers);
console.log(`wrote _redirects/_headers to ${destination}`);
