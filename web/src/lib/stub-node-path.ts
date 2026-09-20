/** node:fs와 같은 이유로 쓰는 브라우저 스텁 (web/src/lib/stub-node-fs.ts 참조). */
function unavailable(member: string): never {
  throw new Error(`mask-web: node:path.${member} is not available in the browser bundle`);
}

export default {
  join: (): string => unavailable("join"),
};
