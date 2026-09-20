/**
 * 개인 사전 공용 상태 — Mask 페이지의 사전 시트와 사전 페이지가 같은
 * IndexedDB 저장소(mask:terms)를 바라본다. 저장 시 mtime이 갱신되므로
 * {#key mtime}으로 편집기를 리마운트하면 외부 변경이 자동 반영된다.
 */
import { loadPersonalTerms, savePersonalTerms, type PersonalTerms } from "./storage.ts";
import { galleryEntries } from "./gallery.ts";

class TermsStore {
  current = $state<PersonalTerms | null>(null);
  ready = $state(false);
  private initStarted = false;

  async init(): Promise<void> {
    if (this.initStarted) return;
    this.initStarted = true;
    const loaded = await loadPersonalTerms();
    if (loaded) {
      this.current = loaded;
    } else if (galleryEntries.length > 0) {
      // 첫 방문: 공개 예제로 시동해 바로 마스킹을 체험할 수 있게 한다.
      const first = galleryEntries[0]!;
      await this.save(first.name, first.text);
    }
    this.ready = true;
  }

  async save(name: string, text: string): Promise<void> {
    const terms: PersonalTerms = { name, text, mtime: Date.now() };
    await savePersonalTerms(terms);
    this.current = terms;
  }

  async resetToExample(): Promise<void> {
    const first = galleryEntries[0];
    if (!first) return;
    if (!confirm("Reset to the public example? Current content will be replaced.")) return;
    await this.save(first.name, first.text);
  }
}

export const termsStore = new TermsStore();
