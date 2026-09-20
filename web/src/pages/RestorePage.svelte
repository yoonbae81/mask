<script lang="ts">
  import { Copy, Download, UnfoldVertical, X } from "lucide-svelte";
  import { restorePreview, type RestoreResult } from "../lib/engine.ts";
  import { mappingStore } from "../lib/mapping-store.svelte.ts";
  import { DRAFT_RESTORE_KEY, readLocal, writeLocal } from "../lib/storage.ts";
  import { restoredSegments } from "../lib/preview.ts";
  import { copyText } from "../lib/clipboard.ts";
  import { downloadText, restoredFilename } from "../lib/download.ts";
  import { createDropZone } from "../lib/dnd.svelte.ts";

  let responseText = $state(readLocal(DRAFT_RESTORE_KEY) ?? "");
  let result = $state<RestoreResult | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let resultEl = $state<HTMLDivElement | null>(null);
  let copied = $state(false);
  let downloaded = $state(false);

  function onWindowKeydown(e: KeyboardEvent): void {
    if (
      (e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === "a" &&
      resultEl &&
      document.activeElement === resultEl
    ) {
      e.preventDefault();
      resultEl.focus({ preventScroll: true });
      window.getSelection()?.selectAllChildren(resultEl);
    }
  }

  const drop = createDropZone({
    extensions: ["md", "txt"],
    onText: (text) => {
      responseText = text;
      error = null;
    },
    onError: (msg) => {
      error = msg;
    },
  });

  const stored = $derived(mappingStore.stored);

  const activeMapping = $derived(stored?.mapping ?? null);
  const segments = $derived(
    result && activeMapping ? restoredSegments(responseText, activeMapping) : []
  );
  const completed = $derived(copied || downloaded);

  $effect(() => {
    const timer = setTimeout(() => writeLocal(DRAFT_RESTORE_KEY, responseText), 400);
    return () => clearTimeout(timer);
  });

  async function runRestore(): Promise<void> {
    if (!activeMapping) {
      error = "No mapping — run mask first on the mask page.";
      return;
    }
    busy = true;
    error = null;
    copied = false;
    downloaded = false;
    try {
      result = await restorePreview(responseText, JSON.stringify(activeMapping));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function copyRestored(): Promise<boolean> {
    if (!result) return false;
    const ok = await copyText(result.text);
    if (ok) copied = true;
    return ok;
  }

  function downloadRestored(): boolean {
    if (!result) return false;
    downloadText(restoredFilename(), result.text, "text/markdown");
    downloaded = true;
    return true;
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
  {#if error}
    <div
      class="flex shrink-0 items-center justify-between border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-600 dark:border-red-900/50 dark:bg-red-950/50 dark:text-red-400"
    >
      <span>{error}</span>
      <button
        type="button"
        onclick={() => (error = null)}
        aria-label="Close error"
        class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-red-100 dark:hover:bg-red-900/50"
      >
        <X class="size-3" />
      </button>
    </div>
  {/if}
  {#if !activeMapping}
    <div
      class="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/50 dark:text-amber-300"
    >
      No mapping — run mask first
    </div>
  {/if}

  <!-- 좌우 영역을 구분하는 가운데 선만 하나 두고 좌우 textarea는 별도의 테두리 없이 꽉차게 표시 -->
  <div
    class="grid h-full min-h-0 flex-1 grid-cols-1 divide-y divide-neutral-200 dark:divide-neutral-800 lg:grid-cols-2 lg:divide-y-0 lg:divide-x"
  >
    <!-- 좌측 LLM 답변 입력 에디터 -->
    <div class="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
      <textarea
        bind:value={responseText}
        spellcheck="false"
        autocomplete="off"
        placeholder="Paste the LLM response (with tokens), or drop a .md / .txt file."
        data-drop={drop.state.active ? (drop.state.ok ? "ok" : "reject") : "off"}
        ondragenter={drop.ondragenter}
        ondragover={drop.ondragover}
        ondragleave={drop.ondragleave}
        ondrop={drop.ondrop}
        class="h-full w-full resize-none overflow-y-auto border-0 bg-transparent px-4 pb-20 pt-4 font-mono text-sm leading-relaxed outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-600 {drop.state.active
          ? (drop.state.ok
            ? 'bg-emerald-50 dark:bg-emerald-950/40'
            : 'bg-red-50 dark:bg-red-950/40')
          : ''}"
      ></textarea>

      <!-- 좌측 오버레이 버튼 -->
      <button
        class="btn shadow-lg absolute right-3 bottom-3 {result ? "" : "btn-primary"}"
        disabled={busy || responseText.trim().length === 0}
        onclick={() => void runRestore()}
      >
        <UnfoldVertical size={15} aria-hidden="true" />
        {busy ? "Restoring…" : "Restore"}
      </button>
    </div>

    <!-- 우측 복원 결과 영역 -->
    <div class="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div
        bind:this={resultEl}
        tabindex="-1"
        role="log"
        aria-label="Restored result"
        class="h-full w-full overflow-y-auto border-0 bg-transparent px-4 pb-20 pt-4 font-mono text-sm leading-relaxed whitespace-pre-wrap text-ink outline-none select-text focus:outline-none"
      >
        {#if result}
          {#each segments as seg, i (i)}
            {#if seg.restored}<mark class="restore-mark">{seg.text}</mark>{:else}{seg.text}{/if}
          {/each}
        {:else}
          <span class="text-faint select-none">Run restore to see the result here.</span>
        {/if}
      </div>

      <!-- 우측 오버레이 버튼 -->
      {#if result}
        <div class="absolute right-3 bottom-3 flex gap-2">
          <button
            class="btn shadow-lg {completed ? "" : "btn-primary"}"
            disabled={!result}
            onclick={() => downloadRestored()}
          >
            <Download size={15} aria-hidden="true" />
            {downloaded ? "Downloaded" : "Download"}
          </button>
          <button
            class="btn shadow-lg {completed ? "" : "btn-primary"}"
            disabled={!result}
            onclick={() => void copyRestored()}
          >
            <Copy size={15} aria-hidden="true" />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>
