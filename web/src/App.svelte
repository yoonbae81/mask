<script lang="ts">
  import { onMount } from "svelte";
  import { RotateCcw, X } from "lucide-svelte";
  import SwapHeader from "./components/SwapHeader.svelte";
  import GuideOverlay from "./components/GuideOverlay.svelte";
  import MaskPage from "./pages/MaskPage.svelte";
  import RestorePage from "./pages/RestorePage.svelte";
  import TermsPage from "./pages/TermsPage.svelte";
  import { initRouter, route } from "./lib/router.svelte.ts";
  import {
    applyTheme,
    cycleMode,
    normalizeMode,
    systemThemeListener,
    type ThemeMode,
  } from "./lib/theme.ts";
  import { guideSnoozed, readLocal, snoozeGuide, THEME_KEY, writeLocal } from "./lib/storage.ts";
  import { termsStore } from "./lib/terms-store.svelte.ts";
  import { mappingStore } from "./lib/mapping-store.svelte.ts";

  let themeMode = $state<ThemeMode>(normalizeMode(readLocal(THEME_KEY)));
  let guideOpen = $state(false);
  let termsOpen = $state(false);

  function closeGuide(): void {
    snoozeGuide();
    guideOpen = false;
  }

  $effect(() => {
    applyTheme(themeMode);
    writeLocal(THEME_KEY, themeMode);
  });

  onMount(() => {
    initRouter();
    void termsStore.init();
    void mappingStore.init();
    guideOpen = !guideSnoozed();

    // auto 모드에서 시스템 테마 변경을 즉시 반영
    const detachTheme = systemThemeListener(() => {
      if (themeMode === "auto") applyTheme("auto");
    });

    // 모바일 키보드·URL바 대응 visualViewport 높이 보정
    const vv = window.visualViewport;
    const setVh = () => {
      const h = vv?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--vvh", `${h}px`);
    };
    setVh();
    vv?.addEventListener("resize", setVh);
    window.addEventListener("resize", setVh);

    return () => {
      detachTheme();
      vv?.removeEventListener("resize", setVh);
      window.removeEventListener("resize", setVh);
    };
  });
</script>

<!-- Prevent the browser from opening dropped files -->
<svelte:window
  ondragover={(e) => e.preventDefault()}
  ondrop={(e) => e.preventDefault()}
/>

<div class="app-shell bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
  <SwapHeader
    onTerms={() => (termsOpen = true)}
    onGuide={() => (guideOpen = true)}
    onTheme={() => (themeMode = cycleMode(themeMode))}
    {themeMode}
  />

  <main class="relative min-h-0 flex-1 overflow-hidden">
    <div class={route.current === "mask" ? "h-full w-full" : "hidden"}>
      <MaskPage />
    </div>
    <div class={route.current === "restore" ? "h-full w-full" : "hidden"}>
      <RestorePage />
    </div>
    <div class={route.current === "terms" ? "h-full w-full overflow-y-auto p-4 sm:p-6" : "hidden"}>
      <TermsPage />
    </div>
  </main>
</div>

<GuideOverlay open={guideOpen} onClose={closeGuide} />

{#if termsOpen}
  <div class="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Terms">
      <div class="sheet-panel !max-w-4xl">
        <div class="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 class="text-base font-extrabold tracking-tight text-ink">Terms</h2>
        <div class="flex items-center gap-1">
          <button
            class="btn btn-ghost !px-1.5"
            title="Reset"
            aria-label="Reset"
            onclick={() => void termsStore.resetToExample()}
          >
            <RotateCcw size={13} aria-hidden="true" />
          </button>
          <button class="btn btn-ghost" onclick={() => (termsOpen = false)} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div class="overflow-y-auto px-2 py-2">
        <TermsPage compact showReset={false} />
      </div>
    </div>
  </div>
{/if}
