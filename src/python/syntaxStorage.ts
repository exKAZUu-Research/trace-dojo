import type { Runtime } from './runtime';

export class SyntaxStorage {
  private readonly sizes = new WeakMap<object, number>();

  constructor(private readonly runtime: Runtime) {}

  account<T>(value: T, complete = false): T {
    const pending: unknown[] = [value];
    const visited = new Set<object>();
    while (pending.length > 0) {
      const item = pending.pop();
      if (typeof item !== 'object' || item === null || visited.has(item)) continue;
      visited.add(item);
      const previous = this.sizes.get(item);
      const { size, children } = syntaxFields(item);
      this.runtime.allocate(Math.max(0, size - (previous ?? 0)));
      this.sizes.set(item, Math.max(size, previous ?? 0));
      if (previous !== undefined && !complete) continue;
      for (const entry of children) pending.push(entry);
    }
    return value;
  }
}

function syntaxFields(item: object): { size: number; children: Iterable<unknown> } {
  if (ArrayBuffer.isView(item)) return { size: Math.ceil(item.byteLength / 8), children: [] };
  if (Array.isArray(item)) return { size: item.length, children: item };
  if (item instanceof Set) return { size: item.size, children: item };
  if (item instanceof Map) return { size: item.size * 2, children: mappingFields(item) };
  const children: unknown[] = Object.values(item);
  return { size: children.length, children };
}

function* mappingFields(item: Map<unknown, unknown>): Iterable<unknown> {
  for (const [key, value] of item) {
    yield key;
    yield value;
  }
}
