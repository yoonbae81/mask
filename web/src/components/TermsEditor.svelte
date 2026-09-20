<script lang="ts">
  import { Check, Download, Save, Trash2 } from "lucide-svelte";
  import ActionButton from "./ActionButton.svelte";
  import { validateTermsYaml } from "../lib/engine.ts";
  import { termsStore } from "../lib/terms-store.svelte.ts";
  import { clearAllLocalData } from "../lib/storage.ts";
  import { downloadText, termsFilename } from "../lib/download.ts";
  import { createDropZone } from "../lib/dnd.svelte.ts";

  let { compact = false, showClearAll = false }: { compact?: boolean; showClearAll?: boolean } = $props();

  let name = $state(termsStore.current?.name ?? "my-terms.yaml");
  let text = $state(termsStore.current?.text ?? "");
  let showValidation = $state(false);

  const validation = $derived(validateTermsYaml(text));

  let dropError = $state<string | null>(null);

  const drop = createDropZone({
    extensions: ["yaml", "yml"],
    onText: (t, filename) => {
      dropError = null;
      void importText(t, filename);
    },
    onError: (msg) => {
      dropError = msg;
    },
  });

  async function importText(t: string, rawFilename: string): Promise<void> {
    const filename = rawFilename.replace(/[^\w.\-\s가-힣]/g, "").trim() || "my-terms.yaml";
    const v = validateTermsYaml(t);
    name = filename;
    text = t;
    showValidation = true;
    if (!v.ok) return; // 오류를 보여주고 저장은 하지 않는다
    if (!confirm(`Replace current content with '${filename}'?`)) return;
    try {
      await termsStore.save(filename, t);
    } catch (e) {
      dropError = e instanceof Error ? e.message : String(e);
    }
  }

  async function save(): Promise<void> {
    showValidation = true;
    if (!validation.ok) return;
    try {
      await termsStore.save(name.trim() || "my-terms.yaml", text);
    } catch (e) {
      dropError = e instanceof Error ? e.message : String(e);
    }
  }

  function exportFile(): boolean {
    downloadText(termsFilename(), text, "text/yaml");
    return true;
  }

  async function handleClearAll(): Promise<void> {
    if (
      !confirm(
        "Clear all local storage (drafts, mapping, dictionary)? This cannot be undone."
      )
    ) {
      return;
    }
    await clearAllLocalData();
    await termsStore.resetToExample();
    window.location.reload();
  }
</script>

<div class="flex flex-col gap-3">
  {#if dropError}
    <p class="banner banner-danger">{dropError}</p>
  {/if}
  {#if showValidation}
    {#if validation.ok}
      <p class="banner banner-ok">Valid — {validation.totalTerms} active terms.</p>
    {:else}
      <p class="banner banner-danger whitespace-pre-wrap">Invalid: {validation.error}</p>
    {/if}
  {/if}

  <textarea
    class="field drop-zone"
    rows={compact ? 12 : 20}
    bind:value={text}
    spellcheck="false"
    placeholder="INTERNAL:&#10;  - term"
    data-drop={drop.state.active ? (drop.state.ok ? "ok" : "reject") : "off"}
    ondragenter={drop.ondragenter}
    ondragover={drop.ondragover}
    ondragleave={drop.ondragleave}
    ondrop={drop.ondrop}
  ></textarea>

  <div class="flex flex-wrap items-center justify-between gap-2">
    {#if showClearAll}
      <button
        class="btn btn-ghost !px-2 text-xs text-danger hover:bg-danger/10 flex items-center gap-1"
        title="Clear all stored local data"
        onclick={() => void handleClearAll()}
      >
        <Trash2 size={13} aria-hidden="true" />
        Clear All Data
      </button>
    {/if}
    <div class="flex flex-wrap justify-end gap-2">
      <button class="btn" onclick={() => (showValidation = true)}>Validate</button>
      <ActionButton label="Download" icon={Download} action={exportFile} />
      <button class="btn btn-primary" onclick={() => void save()}>
        <Save size={15} aria-hidden="true" />
        Save
      </button>
      {#if compact && validation.ok}
        <span class="inline-flex items-center gap-1 text-xs text-ok">
          <Check size={13} aria-hidden="true" />
          {validation.totalTerms} active
        </span>
      {/if}
    </div>
  </div>
</div>
