<script lang="ts">
  import { ArrowLeftRight, Moon, Sparkles, Sun, SunMoon, Table2 } from "lucide-svelte";
  import { navigate, ROUTES, route } from "../lib/router.svelte.ts";
  import type { ThemeMode } from "../lib/theme.ts";

  let {
    onTerms,
    onGuide,
    onTheme,
    themeMode,
  }: {
    onTerms: () => void;
    onGuide: () => void;
    onTheme: () => void;
    themeMode: ThemeMode;
  } = $props();

  const isRestore = $derived(route.current === "restore");

  function handleClick(e: MouseEvent, target: "mask" | "restore"): void {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(target);
  }
</script>

<header
  class="flex shrink-0 items-center justify-between gap-2 border-b border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900 sm:px-4"
>
  <!-- 워드마크: Mask ⇄ Restore (활성 페이지가 항상 왼쪽) -->
  <div class="flex min-w-0 items-center gap-1.5 text-base tracking-tight select-none">
    {#if isRestore}
      <span class="font-extrabold text-[#1a365d] dark:text-[#90cdf4]">Restore</span>
      <a
        href={ROUTES.mask}
        onclick={(e) => handleClick(e, "mask")}
        aria-label="Mask로 전환"
        class="inline-flex items-center text-neutral-400 transition-colors hover:text-neutral-700 dark:text-neutral-600 dark:hover:text-neutral-300"
      >
        <ArrowLeftRight class="size-3.5" />
      </a>
      <a
        href={ROUTES.mask}
        onclick={(e) => handleClick(e, "mask")}
        class="font-medium text-neutral-400 transition-colors hover:text-neutral-900 hover:underline dark:text-neutral-500 dark:hover:text-neutral-100"
      >
        Mask
      </a>
    {:else}
      <span class="font-extrabold text-[#1a365d] dark:text-[#90cdf4]">Mask</span>
      <a
        href={ROUTES.restore}
        onclick={(e) => handleClick(e, "restore")}
        aria-label="Restore로 전환"
        class="inline-flex items-center text-neutral-400 transition-colors hover:text-neutral-700 dark:text-neutral-600 dark:hover:text-neutral-300"
      >
        <ArrowLeftRight class="size-3.5" />
      </a>
      <a
        href={ROUTES.restore}
        onclick={(e) => handleClick(e, "restore")}
        class="font-medium text-neutral-400 transition-colors hover:text-neutral-900 hover:underline dark:text-neutral-500 dark:hover:text-neutral-100"
      >
        Restore
      </a>
    {/if}
  </div>

  <!-- 우측 액션 메뉴 -->
  <div class="flex shrink-0 items-center gap-2">
    <button
      type="button"
      onclick={onTerms}
      class="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-neutral-600 hover:bg-neutral-100 active:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:active:bg-neutral-700"
    >
      <Table2 class="size-4" />
      <span>Terms</span>
    </button>
    <button
      type="button"
      onclick={onGuide}
      class="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-neutral-600 hover:bg-neutral-100 active:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:active:bg-neutral-700"
    >
      <Sparkles class="size-4" />
      <span>지침</span>
    </button>
    <button
      type="button"
      onclick={onTheme}
      aria-label="테마 전환 (자동/밝게/어둡게)"
      class="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-neutral-600 hover:bg-neutral-100 active:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:active:bg-neutral-700"
    >
      {#if themeMode === "light"}
        <Sun class="size-4" />
      {:else if themeMode === "dark"}
        <Moon class="size-4" />
      {:else}
        <SunMoon class="size-4" />
      {/if}
      <span>테마</span>
    </button>
  </div>
</header>
