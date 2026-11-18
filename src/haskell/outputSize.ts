import { LIMITS } from '../interpreter/limits';
import { serialize } from '../interpreter/traceTransport';
import { MAX_DISPLAY_NODES } from './runtime';
import { chargeTypeWork } from './typeWorkBudget';

export interface OutputCost {
  characters: number;
  nodes: number;
  work: number;
}

interface OutputSize extends OutputCost {
  paths: number;
}

interface JsonEntry {
  value: unknown;
  path: number;
  depth: number;
}

export const OUTPUT_CAPACITY: OutputCost = {
  characters: LIMITS.maxSlots * 32,
  nodes: MAX_DISPLAY_NODES,
  work: LIMITS.maxSlots,
};
export const EMPTY_COST: OutputCost = { characters: 0, nodes: 0, work: 0 };

export class OutputSizes {
  private readonly objects = new WeakMap<object, OutputSize>();
  private readonly scalars = new Map<unknown, OutputSize>();
  private readonly strings = new Map<string, number>();
  private readonly negativeZero = Symbol();

  cost(
    value: unknown,
    path: string,
    repeated = false,
    measure: (read: () => OutputSize) => OutputSize = (read) => read()
  ): OutputCost {
    const size = repeated ? { characters: 12, nodes: 0, work: 0, paths: 1 } : this.size(value, measure);
    return {
      characters: size.characters + size.paths * (this.stringSize(path) + 2),
      nodes: size.nodes,
      work: size.work + size.paths * path.split('.').length,
    };
  }

  key(name: string): number {
    return this.stringSize(name) + 2;
  }

  private size(value: unknown, measure: (read: () => OutputSize) => OutputSize): OutputSize {
    const object = typeof value === 'object' && value !== null;
    const key = Object.is(value, -0) ? this.negativeZero : value;
    const cached = object ? this.objects.get(value) : this.scalars.get(key);
    if (cached) return cached;
    const size = measure(() => this.measure(value));
    if (object) this.objects.set(value, size);
    else if (size.characters <= 1024) this.scalars.set(key, size);
    return size;
  }

  private measure(value: unknown): OutputSize {
    const encoded = serialize(value);
    const size = this.jsonSize(encoded.json, true);
    if (encoded.meta) {
      const metadata = this.jsonSize(encoded.meta, false);
      size.characters += metadata.characters + 16;
      size.nodes += metadata.nodes;
      size.work += metadata.work;
      size.paths += metadata.paths;
    }
    return size;
  }

  private jsonSize(root: unknown, identities: boolean): OutputSize {
    const size: OutputSize = { ...EMPTY_COST, paths: 0 };
    const pending: JsonEntry[] = [{ value: root, path: 0, depth: 0 }];
    while (pending.length > 0) {
      chargeTypeWork();
      this.addJsonEntry(size, pending.pop()!, identities, pending);
      if (
        size.characters > OUTPUT_CAPACITY.characters ||
        size.nodes > OUTPUT_CAPACITY.nodes ||
        size.work > OUTPUT_CAPACITY.work
      )
        return { ...OUTPUT_CAPACITY, characters: OUTPUT_CAPACITY.characters + 1, paths: size.paths };
    }
    return size;
  }

  private addJsonEntry(size: OutputSize, entry: JsonEntry, identities: boolean, pending: JsonEntry[]): void {
    const { value, path, depth } = entry;
    if (typeof value !== 'object' || value === null) {
      size.characters += typeof value === 'string' ? this.stringSize(value) : (JSON.stringify(value)?.length ?? 4);
      if (!identities || value === null) this.addPath(size, path, depth);
      return;
    }
    size.nodes++;
    size.characters += 2;
    if (identities) this.addPath(size, path, depth);
    for (const [key, child] of Object.entries(value)) {
      size.characters += 1 + (Array.isArray(value) ? 0 : this.stringSize(key) + 1);
      pending.push({ value: child, path: path + this.stringSize(key) * 3 + 1, depth: depth + 1 });
    }
  }

  private addPath(size: OutputSize, path: number, depth: number): void {
    size.paths++;
    size.characters += path + 8;
    size.work += depth;
  }

  private stringSize(value: string): number {
    let size = this.strings.get(value);
    if (size === undefined) {
      size = JSON.stringify(value).length;
      if (size <= 1024) this.strings.set(value, size);
    }
    return size;
  }
}
