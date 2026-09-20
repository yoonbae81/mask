/** 테마 순환(auto → light → dark) + 시스템 설정 추적. */
export type ThemeMode = "auto" | "light" | "dark";

const ORDER: ThemeMode[] = ["auto", "light", "dark"];

export function normalizeMode(value: string | null): ThemeMode {
  return value === "light" || value === "dark" ? value : "auto";
}

export function cycleMode(mode: ThemeMode): ThemeMode {
  return ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
}

export function resolvedTheme(mode: ThemeMode): "light" | "dark" {
  if (mode !== "auto") return mode;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyTheme(mode: ThemeMode): void {
  const resolved = resolvedTheme(mode);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.style.colorScheme = resolved;
}

export function systemThemeListener(onChange: () => void): () => void {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const listener = () => onChange();
  mq.addEventListener("change", listener);
  return () => mq.removeEventListener("change", listener);
}

export const MODE_LABEL: Record<ThemeMode, string> = {
  auto: "Auto",
  light: "Light",
  dark: "Dark",
};
