import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { applyTheme, normalizeMode } from "./lib/theme.ts";
import { readLocal, THEME_KEY } from "./lib/storage.ts";

// 마운트 전 테마 적용(플래시 방지). 인라인 스크립트 제거로 CSP 무결성 확보.
try {
  applyTheme(normalizeMode(readLocal(THEME_KEY)));
} catch {
  // 무시
}

const target = document.getElementById("app");
if (!target) throw new Error("mask-web: #app container missing");

const app = mount(App, { target });

export default app;
