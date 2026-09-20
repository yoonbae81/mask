<script lang="ts">
  import { Check, Copy } from "lucide-svelte";

  /** lucide 아이콘 컴포넌트 타입(size/class/aria-* 등 SVG 속성 수용). */
  export type IconComponent = typeof Copy;

  let {
    label,
    icon: Icon = null,
    disabled = false,
    tone = "default",
    action,
  }: {
    label: string;
    icon?: IconComponent | null;
    disabled?: boolean;
    tone?: "default" | "primary" | "ghost";
    action: () => Promise<boolean> | boolean | void;
  } = $props();

  const DONE_MS = 1200;

  let busy = $state(false);
  let done = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    return () => clearTimeout(timer);
  });

  async function run(): Promise<void> {
    if (disabled || busy) return;
    busy = true;
    try {
      const ok = await action();
      if (ok !== false) {
        done = true;
        clearTimeout(timer);
        timer = setTimeout(() => (done = false), DONE_MS);
      }
    } finally {
      busy = false;
    }
  }
</script>

<button
  class="btn {tone === 'primary' ? 'btn-primary' : tone === 'ghost' ? 'btn-ghost' : ''}"
  onclick={() => void run()}
  disabled={disabled || busy}
  aria-live="polite"
>
  {#if done}
    <Check size={15} aria-hidden="true" />
    <span>Done</span>
  {:else}
    {#if Icon}
      <Icon size={15} aria-hidden="true" />
    {/if}
    <span>{label}</span>
  {/if}
</button>
