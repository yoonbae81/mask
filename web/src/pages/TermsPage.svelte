<script lang="ts">
  import { RotateCcw } from "lucide-svelte";
  import TermsEditor from "../components/TermsEditor.svelte";
  import { termsStore } from "../lib/terms-store.svelte.ts";

  // 팝업(App.svelte)처럼 헤더에 Reset이 이미 있는 컨텍스트에서는 숨긴다
  let { showReset = true, compact = false }: { showReset?: boolean; compact?: boolean } = $props();
</script>

<section class="flex flex-col gap-3">
  {#if showReset}
    <div class="flex items-center justify-end">
      <button
        class="btn btn-ghost !px-1.5"
        title="Reset"
        aria-label="Reset"
        onclick={() => void termsStore.resetToExample()}
      >
        <RotateCcw size={13} aria-hidden="true" />
      </button>
    </div>
  {/if}
  <div class={compact ? "p-2 sm:p-3" : "card-pad"}>
    {#if termsStore.ready}
      {#key termsStore.current?.mtime ?? 0}
        <TermsEditor showClearAll />
      {/key}
    {:else}
      <p class="text-sm text-faint">Loading…</p>
    {/if}
  </div>
</section>
