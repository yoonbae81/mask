/**
 * 번들 시점의 엔진 소스(src/privacy/terms.ts)가 최상단에서 `node:fs`를 import한다.
 * 웹은 절대 호출하지 않는다(loadTermsFromFileOrDir 전용). 브라우저 번들에서는
 * 빌더 alias가 이 스텁으로 치환한다 — 호출 시에만 예외가 발생한다.
 */
function unavailable(member: string): never {
  throw new Error(`mask-web: node:fs.${member} is not available in the browser bundle`);
}

export default {
  existsSync: (): boolean => unavailable("existsSync"),
  statSync: (): never => unavailable("statSync"),
  readdirSync: (): never => unavailable("readdirSync"),
  readFileSync: (): string => unavailable("readFileSync"),
};
