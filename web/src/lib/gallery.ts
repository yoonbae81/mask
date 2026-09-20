/**
 * 공개 예제 사전 갤러리 — web/public 바로 아래의 *.yaml만(하위 폴더 없음).
 * 읽기전용이며 내용은 번들에 인라인되므로 네트워크 요청이 없다.
 * 개인 사전은 여기에 절대 포함되지 않는다(IndexedDB 전용).
 */
const files = import.meta.glob("../../public/*.yaml", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export interface GalleryEntry {
  name: string;
  text: string;
}

export const galleryEntries: GalleryEntry[] = Object.entries(files)
  .map(([p, text]) => ({ name: p.slice(p.lastIndexOf("/") + 1), text }))
  .sort((a, b) => a.name.localeCompare(b.name));
