import { ConfigurationError } from "../errors.ts";

export interface TokenMapOptions {
  tokenFormat?: string; // Default: "<{type}_{n}>"
}

export interface SerializedMappingEntry {
  token: string;
  entity: string;
  term: string;
}

export interface SerializedMapping {
  version: 1;
  tokenFormat: string;
  entries: SerializedMappingEntry[];
  counters: Record<string, number>;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function indexToLetter(idx: number): string {
  let s = "";
  let n = idx;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

/**
 * 엔티티별 순번 group(1부터 시작)과 별칭 인덱스(0=A, 1=B, …)를 접미사로 렌더링한다.
 * 예: group=1, alias=0 → "1A", group=2, alias=0 → "2A", group=1, alias=1 → "1B"
 */
export function renderCounterSuffix(group: number, aliasIndex = 0): string {
  return `${group}${indexToLetter(aliasIndex)}`;
}

export class TokenMap {
  private format: string;
  private formatPrefix: string;
  private formatMiddle: string;
  private formatSuffix: string;
  private hasStandardTemplate: boolean;
  private counters = new Map<string, number>();
  private termToToken = new Map<string, string>();
  private tokenToTerm = new Map<string, string>();
  private tokenToEntity = new Map<string, string>();
  private dict: Record<string, string> = Object.create(null);
  private escapedTokens = new Set<string>();
  private cachedRegex: RegExp | null = null;
  private cachedVersion = 0;
  private currentVersion = 0;
  private lastQueriedToken: string | null = null;
  private lastQueriedTerm: string | undefined = undefined;

  constructor(options: TokenMapOptions = {}) {
    this.format = options.tokenFormat ?? "<{type}_{n}>";
    const typeIdx = this.format.indexOf("{type}");
    const nIdx = this.format.indexOf("{n}");
    if (typeIdx !== -1 && nIdx !== -1 && typeIdx < nIdx) {
      this.formatPrefix = this.format.slice(0, typeIdx);
      this.formatMiddle = this.format.slice(typeIdx + 6, nIdx);
      this.formatSuffix = this.format.slice(nIdx + 3);
      this.hasStandardTemplate = true;
    } else {
      this.formatPrefix = "";
      this.formatMiddle = "";
      this.formatSuffix = "";
      this.hasStandardTemplate = false;
    }
  }

  getDetokenizeRegex(): RegExp | null {
    if (this.tokenToTerm.size === 0) return null;
    if (this.cachedRegex && this.cachedVersion === this.currentVersion) {
      return this.cachedRegex;
    }
    const sortedTokens = Array.from(this.tokenToTerm.keys()).sort(
      (a, b) => b.length - a.length
    );
    this.cachedRegex = new RegExp(
      sortedTokens.map((t) => escapeRe(t)).join("|"),
      "g"
    );
    this.cachedVersion = this.currentVersion;
    return this.cachedRegex;
  }

  getOrCreateToken(entity: string, term: string, preferredSuffix?: string): string {
    // Normalization key for terms (e.g. lowercase for ASCII or trimmed)
    const key = `${entity}:${term.toLowerCase()}`;
    const existing = this.termToToken.get(key);
    if (existing) {
      return existing;
    }

    let suffix: string;
    let targetToken: string;

    if (preferredSuffix) {
      suffix = preferredSuffix;
      targetToken = this.hasStandardTemplate
        ? `${this.formatPrefix}${entity}${this.formatMiddle}${suffix}${this.formatSuffix}`
        : this.format.replace("{type}", entity).replace("{n}", suffix);

      const m = preferredSuffix.match(/^(\d+)/);
      if (m) {
        const groupNum = parseInt(m[1], 10);
        const curMax = this.counters.get(entity) ?? 0;
        if (groupNum > curMax) {
          this.counters.set(entity, groupNum);
        }
      }
    } else {
      const nextNum = (this.counters.get(entity) ?? 0) + 1;
      this.counters.set(entity, nextNum);
      suffix = renderCounterSuffix(nextNum);
      targetToken = this.hasStandardTemplate
        ? `${this.formatPrefix}${entity}${this.formatMiddle}${suffix}${this.formatSuffix}`
        : this.format.replace("{type}", entity).replace("{n}", suffix);
    }

    let token = targetToken;
    if (this.tokenToTerm.has(token) && this.tokenToTerm.get(token) !== term) {
      let nextNum = (this.counters.get(entity) ?? 0) + 1;
      while (true) {
        this.counters.set(entity, nextNum);
        const altSuffix = renderCounterSuffix(nextNum);
        token = this.hasStandardTemplate
          ? `${this.formatPrefix}${entity}${this.formatMiddle}${altSuffix}${this.formatSuffix}`
          : this.format.replace("{type}", entity).replace("{n}", altSuffix);
        if (!this.tokenToTerm.has(token)) break;
        nextNum++;
      }
    }

    this.termToToken.set(key, token);
    this.tokenToTerm.set(token, term);
    this.tokenToEntity.set(token, entity);
    this.dict[token] = term;
    this.currentVersion++;
    return token;
  }

  getOriginal(token: string): string | undefined {
    // PERF-51: MRU lookup cache for consecutive duplicate token requests
    if (this.lastQueriedToken === token) {
      return this.lastQueriedTerm;
    }
    const val = this.dict[token];
    this.lastQueriedToken = token;
    this.lastQueriedTerm = val;
    return val;
  }

  hasToken(token: string): boolean {
    return this.dict[token] !== undefined;
  }

  addEscapedToken(token: string) {
    this.escapedTokens.add(token);
  }

  hasEscapedToken(token: string): boolean {
    return this.escapedTokens.has(token);
  }

  entries(): [string, string][] {
    return Array.from(this.tokenToTerm.entries());
  }

  get size(): number {
    return this.tokenToTerm.size;
  }

  get tokenFormat(): string {
    return this.format;
  }

  toSerialized(): SerializedMapping {
    const entries: SerializedMappingEntry[] = [];
    for (const [token, term] of this.tokenToTerm.entries()) {
      entries.push({ token, entity: this.tokenToEntity.get(token) ?? "", term });
    }
    entries.sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
    return {
      version: 1,
      tokenFormat: this.format,
      entries,
      counters: Object.fromEntries(this.counters),
    };
  }

  static fromSerialized(data: SerializedMapping): TokenMap {
    if (!data || data.version !== 1 || !Array.isArray(data.entries)) {
      throw new ConfigurationError("Invalid mapping data: unsupported version or shape");
    }
    if (typeof data.tokenFormat !== "string" || !data.counters || typeof data.counters !== "object") {
      throw new ConfigurationError("Invalid mapping data: missing tokenFormat or counters");
    }
    const MAX_SERIALIZED_ENTRIES = 10_000;
    const MAX_ENTRY_LENGTH = 1_024;
    const MAX_ENTITY_LENGTH = 64;

    if (data.entries.length > MAX_SERIALIZED_ENTRIES) {
      throw new ConfigurationError(
        `Invalid mapping data: entries count (${data.entries.length}) exceeds maximum limit of ${MAX_SERIALIZED_ENTRIES}`
      );
    }

    // SEC-59: Validate tokenFormat syntax and length bounds to prevent ReDoS / injection
    if (
      data.tokenFormat.length > 30 ||
      !data.tokenFormat.includes("{type}") ||
      !data.tokenFormat.includes("{n}") ||
      !/^[<\[(][A-Za-z0-9_{}]+[>\])]$/.test(data.tokenFormat)
    ) {
      throw new ConfigurationError("Invalid mapping data: invalid or unsafe tokenFormat");
    }

    const map = new TokenMap({ tokenFormat: data.tokenFormat });
    for (const entry of data.entries) {
      if (
        !entry ||
        typeof entry.token !== "string" ||
        typeof entry.entity !== "string" ||
        typeof entry.term !== "string" ||
        entry.token.length === 0 ||
        entry.token.length > MAX_ENTRY_LENGTH ||
        entry.entity.length === 0 ||
        entry.entity.length > MAX_ENTITY_LENGTH ||
        entry.term.length === 0 ||
        entry.term.length > MAX_ENTRY_LENGTH
      ) {
        throw new ConfigurationError("Invalid mapping data: malformed or oversized entry");
      }
      const key = `${entry.entity}:${entry.term.toLowerCase()}`;
      map.termToToken.set(key, entry.token);
      map.tokenToTerm.set(entry.token, entry.term);
      map.tokenToEntity.set(entry.token, entry.entity);
      map.dict[entry.token] = entry.term;
    }
    for (const [entity, count] of Object.entries(data.counters)) {
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        throw new ConfigurationError("Invalid mapping data: malformed counters");
      }
      map.counters.set(entity, count);
    }
    map.currentVersion++;
    return map;
  }

  get maxTokenLength(): number {
    let max = 0;
    for (const token of this.tokenToTerm.keys()) {
      if (token.length > max) max = token.length;
    }
    // Also consider hypothetical token length if empty
    return max > 0 ? max : 20;
  }

  getEscapedTokens(): string[] {
    return Array.from(this.escapedTokens);
  }

  hasAnyTokenInText(text: string): boolean {
    if (this.tokenToTerm.size === 0 || !text) {
      return false;
    }
    // Fast path: if text has no opening bracket, no token can be present
    if (!text.includes("<")) {
      return false;
    }
    const regex = this.getDetokenizeRegex();
    if (!regex) return false;
    regex.lastIndex = 0;
    return regex.test(text);
  }

  getCategoriesCount(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }
}

