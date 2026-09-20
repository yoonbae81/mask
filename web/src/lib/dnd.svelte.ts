/**
 * 드롭존 공용 로직 — 전 페이지 동일한 피드백 상태머신과 타이밍을 쓴다.
 * 상태: data-drop="off|ok|reject" (active=false → off).
 * 확장자 허용 목록 밖 파일은 reject 피드백 후 무시한다.
 */
export interface DropState {
  active: boolean;
  ok: boolean;
}

export interface DropZoneOptions {
  extensions: string[];
  maxSizeBytes?: number;
  onText: (text: string, filename: string) => void;
  onError?: (error: string) => void;
}

export const DEFAULT_MAX_DROP_BYTES = 5 * 1024 * 1024; // 5MB

export interface DropZone {
  state: DropState;
  ondragenter: (e: DragEvent) => void;
  ondragover: (e: DragEvent) => void;
  ondragleave: (e: DragEvent) => void;
  ondrop: (e: DragEvent) => void;
}

export function createDropZone(opts: DropZoneOptions): DropZone {
  const state = $state<DropState>({ active: false, ok: false });
  const maxBytes = opts.maxSizeBytes ?? DEFAULT_MAX_DROP_BYTES;
  let depth = 0;

  function firstFile(dt: DataTransfer | null): File | null {
    if (!dt || dt.files.length === 0) return null;
    return dt.files[0] as File;
  }

  function accepted(file: File | null): boolean {
    if (!file) return false;
    if (file.size > maxBytes) return false;
    const dot = file.name.lastIndexOf(".");
    const ext = dot === -1 ? "" : file.name.slice(dot + 1).toLowerCase();
    return opts.extensions.includes(ext);
  }

  function mark(e: DragEvent): void {
    const ok = accepted(firstFile(e.dataTransfer));
    state.active = true;
    state.ok = ok;
  }

  return {
    state,
    ondragenter(e) {
      e.preventDefault();
      depth += 1;
      mark(e);
    },
    ondragover(e) {
      e.preventDefault();
      mark(e);
    },
    ondragleave(e) {
      e.preventDefault();
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        state.active = false;
      }
    },
    ondrop(e) {
      e.preventDefault();
      depth = 0;
      state.active = false;
      const file = firstFile(e.dataTransfer);
      if (!file) return;
      if (file.size > maxBytes) {
        opts.onError?.(
          `File '${file.name}' (${Math.round(file.size / 1024)} KB) exceeds maximum limit (${Math.round(maxBytes / 1024)} KB)`
        );
        return;
      }
      if (!accepted(file)) {
        opts.onError?.(`Unsupported file type for '${file.name}'. Allowed: .${opts.extensions.join(", .")}`);
        return;
      }
      void file.text().then((text) => opts.onText(text, file.name));
    },
  };
}
