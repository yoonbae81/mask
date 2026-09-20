/** 파일 다운로드 + 저장 파일명 규칙(YYYYMMDD-HHmm). */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function timestampSlug(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}`;
}

export function sanitizeDownloadFilename(filename: string, fallback = "download.txt"): string {
  const clean = filename
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\.\.+/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/^_+/, "")
    .trim();
  return clean || fallback;
}

export function downloadText(filename: string, text: string, mime = "text/plain"): void {
  const safeFilename = sanitizeDownloadFilename(filename);
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const maskedFilename = (): string => `mask-${timestampSlug()}.masked.md`;
export const restoredFilename = (): string => `mask-${timestampSlug()}.restored.md`;
export const mappingFilename = (): string => `mask-mapping-${timestampSlug()}.json`;
export const termsFilename = (): string => `terms-${timestampSlug()}.yaml`;
