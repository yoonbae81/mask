/**
 * 매핑 공용 상태 — 세 페이지가 동시 마운트되므로 Mask의 저장을 Restore가
 * 반응적으로 이어받아야 한다. 원본을 포함하므로 저장소는 IndexedDB뿐이다.
 */
import { loadStoredMapping, saveStoredMapping, type StoredMapping } from "./storage.ts";
import type { SerializedMapping } from "./engine.ts";

class MappingStore {
  stored = $state<StoredMapping | null>(null);
  private initStarted = false;

  async init(): Promise<void> {
    if (this.initStarted) return;
    this.initStarted = true;
    this.stored = await loadStoredMapping();
  }

  async save(mapping: SerializedMapping): Promise<StoredMapping> {
    const stored = await saveStoredMapping(mapping);
    this.stored = stored;
    return stored;
  }
}

export const mappingStore = new MappingStore();
