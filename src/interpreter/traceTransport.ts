import { SuperJSON, type SuperJSONValue } from 'superjson';
import { z } from 'zod';

type TraceNameRecord = Record<string, SuperJSONValue>;
class EncodedTraceRecord extends Map<string, SuperJSONValue> {
  [key: string]: SuperJSONValue;
}
const protectedNames = ['constructor', '__proto__', 'prototype'];
const recordEntries = z.array(z.tuple([z.string(), z.unknown()]));
const codec = new SuperJSON({ dedupe: true });
export const serialize = codec.serialize.bind(codec);
export const stringify = codec.stringify.bind(codec);

codec.registerCustom<TraceNameRecord, [string, SuperJSONValue][]>(
  {
    isApplicable: requiresTraceKeyEncoding,
    serialize: encodeTraceNameRecord,
    deserialize: (value) => new EncodedTraceRecord(recordEntries.parse(value)),
  },
  'trace-name-record'
);

export default { serialize, deserialize };

export function requiresTraceKeyEncoding(value: unknown): value is TraceNameRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === null || prototype === Object.prototype) && protectedNames.some((key) => Object.hasOwn(value, key))
  );
}

export function encodeTraceNameRecord(value: TraceNameRecord): [string, SuperJSONValue][] {
  return Object.entries(value);
}

export function parse(value: string): unknown {
  return restoreRecords(codec.parse(value));
}

function deserialize(value: Parameters<typeof codec.deserialize>[0]): unknown {
  return restoreRecords(codec.deserialize(value));
}

function restoreRecords(value: unknown): unknown {
  const restored = new WeakMap<object, object>();
  const pending: [object, object][] = [];
  const resolve = (node: unknown): unknown => {
    if (typeof node !== 'object' || node === null) return node;
    let target = restored.get(node);
    if (target === undefined) {
      const replacement: object = node instanceof EncodedTraceRecord ? Object.create(null) : node;
      restored.set(node, replacement);
      pending.push([node, replacement]);
      target = replacement;
    }
    return target;
  };
  const result = resolve(value);
  for (let pair = pending.pop(); pair; pair = pending.pop()) {
    const [node, target] = pair;
    restoreChildren(node, target, resolve);
  }
  return result;
}

function restoreChildren(node: object, target: object, resolve: (value: unknown) => unknown): void {
  if (node instanceof EncodedTraceRecord) {
    for (const [key, child] of node)
      Object.defineProperty(target, key, {
        value: resolve(child),
        enumerable: true,
        writable: true,
        configurable: true,
      });
  } else if (node instanceof Map) {
    const entries = [...node];
    node.clear();
    for (const [key, child] of entries) node.set(resolve(key), resolve(child));
  } else if (node instanceof Set) {
    const entries = [...node];
    node.clear();
    for (const child of entries) node.add(resolve(child));
  } else if (
    Array.isArray(node) ||
    Object.getPrototypeOf(node) === Object.prototype ||
    Object.getPrototypeOf(node) === null
  ) {
    for (const [key, child] of Object.entries(node))
      Object.defineProperty(target, key, {
        value: resolve(child),
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
}
