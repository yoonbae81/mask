// Mask 기본 매처 프로토타입 (TypeScript / Node 네이티브 실행) — §4.2 경계 규칙 검증본
const HANGUL = "\\uac00-\\ud7a3\\u1100-\\u11ff\\u3130-\\u318f"; // 음절 + 자모
const CJK    = "\\u4e00-\\u9fff\\u3400-\\u4dbf";                 // 한자
const ASCII_W = "A-Za-z0-9";

function isClass(ch: string | undefined, cls: string): boolean {
  return !!ch && new RegExp(`[${cls}]`).test(ch);
}

interface Span {
  start: number;
  end: number;
  entity: string;
  surface: string;
}

interface TermsByEntity {
  [entity: string]: string[];
}

class Matcher {
  private re: RegExp | null;
  private entityOf = new Map<string, [entity: string, term: string]>();

  constructor(terms: TermsByEntity, caseInsensitiveAscii = true) {
    const flat = Object.entries(terms)
      .flatMap(([entity, ts]) => ts.map((t) => [t, entity] as const))
      .sort((a, b) => b[0].length - a[0].length); // 최장일치: 긴 용어 먼저

    const pats: string[] = [];
    flat.forEach(([term, entity], i) => {
      const name = `t${i}`;
      this.entityOf.set(name, [entity, term]);
      const body = term.split(/\s+/).map((p) => escapeRe(p)).join("\\s+");
      const [left, right] = Matcher.guards(term);
      pats.push(`(?<${name}>${left}${body}${right})`);
    });

    this.re = pats.length
      ? new RegExp(pats.join("|"), caseInsensitiveAscii ? "gi" : "g")
      : null;
  }

  private static guards(term: string): [string, string] {
    const first = term[0];
    const last = term[term.length - 1];
    const left = isClass(first, ASCII_W)
      ? `(?<![${ASCII_W}])`
      : isClass(first, HANGUL + CJK)
      ? `(?<![${HANGUL}${CJK}])`
      : "";
    const right = isClass(last, ASCII_W) ? `(?![${ASCII_W}])` : "";
    return [left, right];
  }

  find(text: string): Span[] {
    if (!this.re) return [];
    const out: Span[] = [];
    this.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = this.re.exec(text))) {
      const groups = m.groups ?? {};
      const name = Object.keys(groups).find((k) => groups[k] !== undefined)!;
      const [entity] = this.entityOf.get(name)!;
      out.push({ start: m.index, end: m.index + m[0].length, entity, surface: m[0] });
      if (m[0].length === 0) this.re.lastIndex++; // 무한루프 방지
    }
    return out;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TERMS: TermsByEntity = {
  INTERNAL: ["알파테크", "알파", "ALPHATECH", "베타네트웍스"],
  PROJECT: ["Project 오로라", "프로젝트 타이탄"],
  CUSTOMER: ["OMEGA", "CORP"],
};

const CASES: [string, string[]][] = [
  ["알파테크는 Project 오로라를 OMEGA와 협의했다.", ["알파테크", "Project 오로라", "OMEGA"]],
  ["알파테크가", ["알파테크"]],
  ["알파테크의 자회사", ["알파테크"]],
  ["알파에서 보낸 공문", ["알파"]],
  ["알파테크연구소 소장", ["알파테크"]],
  ["글로벌알파와 계약", []],
  ["CORPORATION 검토", []],
  ["CORPTECH 3", []],
  ["CORP와 협의", ["CORP"]],
  ["OMEGAX 라는 회사", []],
  ["alphatech 소문자", ["alphatech"]],
  ["Project  오로라 (공백 2)", ["Project  오로라"]],
  ["베타네트웍스와 알파", ["베타네트웍스", "알파"]],
];

const m = new Matcher(TERMS);
let ok = true;
for (const [text, expect] of CASES) {
  const got = m.find(text).map((s) => s.surface);
  const good = JSON.stringify(got) === JSON.stringify(expect);
  ok &&= good;
  console.log(`  ${good ? "✓" : "✗"} ${text.padEnd(32)} → ${JSON.stringify(got)}`);
  if (!good) console.log(`      기대: ${JSON.stringify(expect)}`);
}
console.log(ok ? "\nALL PASS" : "\nFAILED");
