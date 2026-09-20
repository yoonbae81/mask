import fs from "node:fs";
import { buildApp } from "./app.ts";
import { redactSecrets } from "./logging.ts";
import { parseSettings } from "./settings.ts";

function printBanner(app: any) {
  const { settings, termSet, providers } = app;
  let termStat;
  try {
    termStat = fs.statSync(settings.resolvedTermsFile);
  } catch {}

  console.log("Mask 0.1.0\n");
  console.log(`  TERMS      : ${settings.resolvedTermsFile}${termStat ? ` (mtime ${termStat.mtime.toISOString().slice(0, 16).replace("T", " ")})` : ""}`);
  console.log(`  PROVIDERS  : ${settings.resolvedProvidersFile}`);
  // SEC-76: Banner settings snapshot is secret-masked via redactSecrets
  console.log(`  Settings   : ${JSON.stringify(redactSecrets(settings))}\n`);
  console.log("  Recognizers");

  for (const [name, cat] of termSet.categories.entries()) {
    const strictCount = cat.terms.filter((t: any) => t.boundary === "strict").length;
    const strictInfo = strictCount > 0 ? ` (${strictCount} strict-boundary)` : "";
    const commentInfo = cat.commentedOutCount > 0 ? ` (${cat.commentedOutCount} commented out)` : "";
    console.log(`    ${name.padEnd(11)}:  ${cat.terms.length} terms${strictInfo || commentInfo}`);
  }
  console.log(`  Total protected terms: ${termSet.totalTermsCount}\n`);

  console.log(`  Providers  (active: ${providers.active})`);
  for (const [name, cfg] of providers.providers.entries()) {
    const isAct = name === providers.active;
    const marker = isAct ? "▶" : " ";
    let authInfo = cfg.auth;
    if (cfg.auth === "api_key") {
      const hasKey = !!process.env[cfg.api_key_env];
      authInfo = `api_key ${hasKey ? "configured" : "unconfigured"}`;
    }
    console.log(`  ${marker} ${name.padEnd(12)}  ${authInfo}`);
    for (const [dialect, url] of Object.entries(cfg.endpoints)) {
      console.log(`                    ${dialect.padEnd(10)} ${url}`);
    }
  }
  const fallbackStr = providers.fallback.length > 0 ? providers.fallback.join(", ") : "(none)";
  console.log(`  fallback: ${fallbackStr}\n`);

  if (settings.MASK_ALLOW_REMOTE) {
    console.log(`  [SECURITY WARNING] Remote listening enabled on host ${settings.MASK_HOST}!`);
  }
  if (settings.MASK_ALLOW_UNSAFE_LOGGING) {
    console.log("  [SECURITY WARNING] UNSAFE LOGGING ENABLED! Sensitive payloads may be recorded.");
  }
  if (settings.MASK_GUARD === "off") {
    console.log("  [SECURITY WARNING] MASK_GUARD is OFF! Fail-closed protection is disabled.");
  }

  console.log(`  Listening on http://${settings.MASK_HOST}:${settings.MASK_PORT}\n`);
}

async function main() {
  try {
    const settings = parseSettings(process.env);
    const app = await buildApp(settings);

    await app.listen({
      host: settings.MASK_HOST,
      port: settings.MASK_PORT,
    });

    printBanner(app);
  } catch (err: any) {
    console.error("\nFailed to start Mask:", err.message || err);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""))) {
  main();
}

export { main };
