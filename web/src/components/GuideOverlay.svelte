<script lang="ts">
  import { X } from "lucide-svelte";
  import instructionMd from "../../public/instruction.md?raw";
  import { renderInstructionDocument } from "../lib/instruction.ts";

  let { open, onClose }: { open: boolean; onClose: () => void } = $props();

  const instruction = $derived(renderInstructionDocument(instructionMd));
</script>

<svelte:window
  onkeydown={(e) => {
    if (open && e.key === "Escape") onClose();
  }}
/>

{#if open}
  <div class="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Guide">
    <div class="sheet-panel">
      <div class="flex items-center justify-between border-b border-line px-5 py-3 sm:px-6">
        <h2 class="text-base font-extrabold tracking-tight text-ink">{instruction.title || "Guide"}</h2>
        <button class="btn btn-ghost" onclick={() => onClose()} aria-label="Close">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div class="overflow-y-auto px-5 pt-4 pb-8 sm:px-6 sm:pb-10">
        <div class="guide-body">{@html instruction.html}</div>
      </div>
    </div>
  </div>
{/if}
