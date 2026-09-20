<script lang="ts">
  import {
    ArrowRight,
    ClipboardCopy,
    Copy,
    Download,
    Eye,
    EyeOff,
    RotateCcw,
    ShieldCheck,
    Table2,
    Wand2,
    X,
  } from "lucide-svelte";
  import ActionButton from "../components/ActionButton.svelte";
  import TermsEditor from "../components/TermsEditor.svelte";
  import { maskPreview, type MaskResult } from "../lib/engine.ts";
  import { termsStore } from "../lib/terms-store.svelte.ts";
  import { mappingStore } from "../lib/mapping-store.svelte.ts";
  import { DRAFT_MASK_KEY, readLocal, writeLocal } from "../lib/storage.ts";
  import { maskedTermLabel, mappingTokens, splitByTokens } from "../lib/preview.ts";
  import { copyText } from "../lib/clipboard.ts";
  import { downloadText, mappingFilename, maskedFilename } from "../lib/download.ts";
  import { createDropZone } from "../lib/dnd.svelte.ts";
  import { navigate } from "../lib/router.svelte.ts";
  import exampleMd from "../../public/example.md?raw";

  const MAPPING_WARNING = "The mapping contains original text. Share only through safe channels.";

  let inputText = $state(readLocal(DRAFT_MASK_KEY) ?? exampleMd);
  let result = $state<MaskResult | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let reveal = $state(false);
  let blockCopyOnLeak = $state(true);
  let sheetOpen = $state(false);
  let mappingOpen = $state(false);
  let resultEl = $state<HTMLDivElement | null>(null);
  let copied = $state(false);
  let downloaded = $state(false);

  function selectResultOnly(): void {
    if (!resultEl) return;
    resultEl.focus({ preventScroll: true });
    window.getSelection()?.selectAllChildren(resultEl);
  }

  function onWindowKeydown(e: KeyboardEvent): void {
    if (
      (e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === "a" &&
      resultEl &&
      document.activeElement === resultEl
    ) {
      e.preventDefault();
      selectResultOnly();
    }
  }

  const drop = createDropZone({
    extensions: ["md", "txt"],
    onText: (text) => {
      inputText = text;
      error = null;
    },
    onError: (msg) => {
      error = msg;
    },
  });

  const segments = $derived(
    result ? splitByTokens(result.masked, mappingTokens(result.mapping)) : []
  );
  const leakCount = $derived(
    result ? Object.values(result.categories).reduce((a, b) => a + b, 0) : 0
  );
  const copyBlocked = $derived(result !== null && result.leak && blockCopyOnLeak);
  const completed = $derived(copied || downloaded);

  // 초안 자동저장(용량 초과 등 실패는 무시)
  $effect(() => {
    const timer = setTimeout(() => writeLocal(DRAFT_MASK_KEY, inputText), 400);
    return () => clearTimeout(timer);
  });

  async function runMask(): Promise<void> {
    const terms = termsStore.current;
    if (!terms) {
      error = "No dictionary — prepare one from Mapping first.";
      sheetOpen = true;
      return;
    }
    busy = true;
    error = null;
    copied = false;
    downloaded = false;
    try {
      const r = await maskPreview(inputText, terms.text);
      result = r;
      await mappingStore.save(r.mapping);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function copyMasked(): Promise<boolean> {
    if (!result) return false;
    const ok = await copyText(result.masked);
    if (ok) copied = true;
    return ok;
  }

  function downloadMasked(): boolean {
    if (!result) return false;
    downloadText(maskedFilename(), result.masked, "text/markdown");
    downloaded = true;
    return true;
  }

  async function copyMapping(): Promise<boolean> {
    if (!result) return false;
    if (!confirm(`Copy to clipboard?\n${MAPPING_WARNING}`)) return false;
    return copyText(JSON.stringify(result.mapping, null, 2));
  }

  function downloadMapping(): boolean {
    if (!result) return false;
    if (!confirm(`Download as a file?\n${MAPPING_WARNING}`)) return false;
    downloadText(mappingFilename(), JSON.stringify(result.mapping, null, 2), "application/json");
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
  {#if result?.leak}
    <div
      class="flex shrink-0 items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/50 dark:text-amber-300"
    >
      <span class="font-medium text-warn">{leakCount} terms remain</span>
      <label class="flex items-center gap-1.5 cursor-pointer text-soft">
        <input
          type="checkbox"
          class="accent-[var(--mask-accent)] rounded"
          bind:checked={blockCopyOnLeak}
        />
        <span>Block copy on residue</span>
      </label>
    </div>
  {/if}

  <!-- 좌우 영역을 구분하는 가운데 선만 하나 두고 좌우 textarea는 별도의 테두리 없이 꽉차게 표시 -->
  <div
    class="grid h-full min-h-0 flex-1 grid-cols-1 divide-y divide-neutral-200 dark:divide-neutral-800 lg:grid-cols-2 lg:divide-y-0 lg:divide-x"
  >
    <!-- 좌측 원문 편집기 -->
    <div class="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
      <textarea
        bind:value={inputText}
        spellcheck="false"
        autocomplete="off"
        placeholder="Paste source text, or drop a .md / .txt file."
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
      <div class="absolute right-3 bottom-3 flex gap-2">
        {#if result}
          <button class="btn shadow-lg" onclick={() => (mappingOpen = true)}>
            <Table2 size={15} aria-hidden="true" />
            Result
          </button>
        {/if}
        <button
          class="btn shadow-lg {result ? "" : "btn-primary"}"
          disabled={busy || inputText.trim().length === 0}
          onclick={() => void runMask()}
        >
          <Wand2 size={15} aria-hidden="true" />
          {busy ? "Masking…" : "Mask"}
        </button>
      </div>
    </div>

    <!-- 우측 마스킹 결과 영역 -->
    <div class="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div
        bind:this={resultEl}
        tabindex="-1"
        role="log"
        aria-label="Masked result"
        class="h-full w-full overflow-y-auto border-0 bg-transparent px-4 pb-20 pt-4 font-mono text-sm leading-relaxed whitespace-pre-wrap text-ink outline-none select-text focus:outline-none"
      >
        {#if result}
          {#each segments as seg, i (i)}
            {#if seg.token}<mark class="chip">{seg.text}</mark>{:else}{seg.text}{/if}
          {/each}
        {:else}
          <span class="text-faint select-none">Run mask to see the result here.</span>
        {/if}
      </div>

      <!-- 우측 오버레이 버튼 -->
      {#if result}
        <div class="absolute right-3 bottom-3 flex gap-2">
          <button
            class="btn shadow-lg {completed ? "" : "btn-primary"}"
            disabled={!result}
            onclick={() => downloadMasked()}
          >
            <Download size={15} aria-hidden="true" />
            {downloaded ? "Downloaded" : "Download"}
          </button>
          <button
            class="btn shadow-lg {completed ? "" : "btn-primary"}"
            disabled={copyBlocked}
            onclick={() => void copyMasked()}
          >
            <Copy size={15} aria-hidden="true" />
            {copyBlocked ? "Blocked" : copied ? "Copied" : "Copy"}
          </button>
          {#if completed}
            <button class="btn btn-primary shadow-lg" onclick={() => navigate("restore")}>
              Next
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<!-- Dictionary sheet -->
{#if sheetOpen}
  <div class="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Edit dictionary">
    <div class="sheet-panel">
      <div class="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 class="text-sm font-bold text-ink">Edit Dictionary</h2>
        <div class="flex items-center gap-1">
          <button
            class="btn btn-ghost !px-1.5"
            title="Reset"
            aria-label="Reset"
            onclick={() => void termsStore.resetToExample()}
          >
            <RotateCcw size={13} aria-hidden="true" />
          </button>
          <button class="btn btn-ghost" onclick={() => (sheetOpen = false)} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div class="overflow-y-auto px-4 py-4">
        {#key termsStore.current?.mtime ?? 0}
          <TermsEditor compact />
        {/key}
      </div>
    </div>
  </div>
{/if}

{#if mappingOpen && result}
  <div class="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Mapping result">
    <div class="sheet-panel !max-w-3xl">
      <div class="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 class="text-sm font-bold text-ink">Mapping</h2>
        <button class="btn btn-ghost" onclick={() => (mappingOpen = false)} aria-label="Close">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div class="overflow-y-auto px-4 py-4">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <ActionButton
            label="Copy mapping"
            icon={ClipboardCopy}
            action={copyMapping}
          />
          <ActionButton
            label="Download mapping"
            icon={Download}
            action={downloadMapping}
          />
          <button class="btn btn-ghost" onclick={() => (reveal = !reveal)}>
            {#if reveal}
              <EyeOff size={15} aria-hidden="true" />
              Hide originals
            {:else}
              <Eye size={15} aria-hidden="true" />
              Show originals
            {/if}
          </button>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead>
              <tr class="border-b border-line text-xs text-faint">
                <th class="py-2 pr-4 font-semibold">Token</th>
                <th class="py-2 pr-4 font-semibold">Category</th>
                <th class="py-2 font-semibold">Original {#if !reveal}<span class="font-normal">(hidden by default)</span>{/if}</th>
              </tr>
            </thead>
            <tbody>
              {#each result.mapping.entries as entry (entry.token)}
                <tr class="border-b border-line/60 last:border-0">
                  <td class="py-1.5 pr-4"><mark class="chip">{entry.token}</mark></td>
                  <td class="py-1.5 pr-4 text-soft">{entry.entity}</td>
                  <td class="py-1.5 font-mono text-soft">
                    {#if reveal}{entry.term}{:else}{maskedTermLabel(entry.entity, entry.term)}{/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="mt-3 flex items-center gap-1.5 text-xs text-faint">
          <ShieldCheck size={13} aria-hidden="true" />
          {MAPPING_WARNING}
        </p>
      </div>
    </div>
  </div>
{/if}
