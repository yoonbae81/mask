/**
 * 최소 라우팅 — 정식 경로 3개(/mask/mask, /mask/restore, /mask/terms).
 * 루트 별칭(/, /mask, /mask/)은 replaceState로 /mask/mask 정규화.
 * 전환은 pushState + popstate 대응(새로고침 없음).
 */
export type Route = "mask" | "restore" | "terms";

export const ROUTES: Record<Route, string> = {
  mask: "/mask/mask",
  restore: "/mask/restore",
  terms: "/mask/terms",
};

export const TITLES: Record<Route, string> = {
  mask: "Mask",
  restore: "Mask — Restore",
  terms: "Mask — Terms",
};

export const route = $state<{ current: Route }>({ current: "mask" });

function parseRoute(pathname: string): Route {
  if (pathname === "/mask/restore") return "restore";
  if (pathname === "/mask/terms") return "terms";
  return "mask";
}

function applyRoute(next: Route): void {
  route.current = next;
  document.title = TITLES[next];
}

export function navigate(next: Route): void {
  applyRoute(next);
  history.pushState(null, "", ROUTES[next]);
}

export function initRouter(): void {
  const path = location.pathname;
  const known = path === "/mask/mask" || path === "/mask/restore" || path === "/mask/terms";
  if (!known) {
    history.replaceState(null, "", "/mask/mask");
  }
  applyRoute(parseRoute(location.pathname));
  window.addEventListener("popstate", () => {
    applyRoute(parseRoute(location.pathname));
  });
}
