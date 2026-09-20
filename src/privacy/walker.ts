import { MaskError } from "../errors.ts";
import type { DialectRules, FieldRule } from "./rules/anthropic.ts";

export interface WalkOptions {
  maxDepth?: number;
  maxNodes?: number;
  maxKeyLength?: number;
  maxObjectKeys?: number;
}

export function walkJson(
  node: unknown,
  rules: DialectRules,
  transformText: (text: string, path: (string | number)[]) => string,
  options: WalkOptions = {},
  path: (string | number)[] = [],
  depth = 0,
  counter = { count: 0 },
  visited: WeakSet<object> = new WeakSet()
): unknown {
  const maxDepth = options.maxDepth ?? 32;
  const maxNodes = options.maxNodes ?? 100_000;

  if (depth > maxDepth) {
    throw new MaskError(`JSON traversal depth limit (${maxDepth}) exceeded`);
  }

  counter.count++;
  if (counter.count > maxNodes) {
    throw new MaskError(`JSON traversal node count limit (${maxNodes}) exceeded`);
  }

  if (node === null || node === undefined) {
    return node;
  }

  if (typeof node === "string") {
    const rule: FieldRule = rules.ruleFor(path, node);
    if (rule === "skip") {
      return node;
    }
    if (rule === "json-string") {
      try {
        const parsed = JSON.parse(node);
        const transformedParsed = walkJson(
          parsed,
          rules,
          transformText,
          options,
          path,
          depth + 1,
          counter,
          visited
        );
        return JSON.stringify(transformedParsed);
      } catch {
        // If not valid JSON, treat as standard text
        return transformText(node, path);
      }
    }
    return transformText(node, path);
  }

  if (Array.isArray(node)) {
    // SEC-52: Circular reference protection
    if (visited.has(node)) {
      throw new MaskError("JSON traversal circular reference detected");
    }
    visited.add(node);

    // PERF-45: Instant return for empty array to avoid allocation
    if (node.length === 0) return node;
    return node.map((item, index) => {
      path.push(index);
      const res = walkJson(item, rules, transformText, options, path, depth + 1, counter, visited);
      path.pop();
      return res;
    });
  }

  if (typeof node === "object") {
    // SEC-52: Circular reference protection
    if (visited.has(node)) {
      throw new MaskError("JSON traversal circular reference detected");
    }
    visited.add(node);

    const obj = node as Record<string, unknown>;
    // PERF-45: Instant return for empty object without allocating key arrays
    let hasKeys = false;
    for (const _ in obj) {
      hasKeys = true;
      break;
    }
    if (!hasKeys) return node;

    const result: Record<string, unknown> = {};
    const maxKeyLength = options.maxKeyLength ?? 1024;
    const maxObjectKeys = options.maxObjectKeys ?? 10_000;
    const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
    let keyCount = 0;

    for (const key in obj) {
      if (Object.hasOwn(obj, key)) {
        // SEC-58: Block prototype pollution keys
        if (FORBIDDEN_KEYS.has(key)) {
          throw new MaskError(
            `JSON traversal rejected prohibited prototype property key: '${key}'`
          );
        }
        keyCount++;
        if (keyCount > maxObjectKeys) {
          throw new MaskError(
            `JSON traversal object key count limit (${maxObjectKeys}) exceeded`
          );
        }
        if (key.length > maxKeyLength) {
          throw new MaskError(
            `JSON traversal object key length limit (${maxKeyLength}) exceeded`
          );
        }
        path.push(key);
        result[key] = walkJson(
          obj[key],
          rules,
          transformText,
          options,
          path,
          depth + 1,
          counter,
          visited
        );
        path.pop();
      }
    }
    return result;
  }

  return node;
}
