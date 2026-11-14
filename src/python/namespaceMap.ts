import type { DictStore } from './dictStore';
import { releaseNamespaceKey, withoutCharge } from './runtimeContext';
import type { PyValue } from './values';

interface NamedKeyAccess {
  lookup: (maps: readonly Map<string, PyValue>[], key: PyValue) => PyValue | undefined;
  set: (map: Map<string, PyValue>, key: PyValue, value: PyValue) => void;
  delete: (map: Map<string, PyValue>, key: PyValue) => boolean;
}

export function registerNamedKeyAccess(access: NamedKeyAccess): void {
  (namedKeyAccess as typeof namedKeyAccess & { access: NamedKeyAccess }).access = access;
}

function namedKeyAccess(): NamedKeyAccess {
  return (namedKeyAccess as typeof namedKeyAccess & { access: NamedKeyAccess }).access;
}

export function lookupNamedKey(maps: readonly Map<string, PyValue>[], key: PyValue): PyValue | undefined {
  return namedKeyAccess().lookup(maps, key);
}

export class NamespaceMap<Value extends PyValue = PyValue> extends Map<string, Value> {
  dictionary?: DictStore;
  keyText?: (value: PyValue) => string | undefined;
  changed?: () => void;

  override get size(): number {
    return this.dictionary?.size ?? super.size;
  }

  override get(name: string): Value | undefined {
    if (typeof name !== 'string') return lookupNamedKey([this], name) as Value | undefined;
    return this.dictionary ? (this.dictionary.get(name) as Value | undefined) : super.get(name);
  }

  override has(name: string): boolean {
    if (typeof name !== 'string') return this.get(name) !== undefined;
    return this.dictionary ? this.dictionary.has(name) : super.has(name);
  }

  override set(name: string, value: Value): this {
    if (typeof name !== 'string') {
      namedKeyAccess().set(this, name, value);
      return this;
    }
    if (!this.dictionary) return super.set(name, value);
    const version = this.dictionary.version;
    withoutCharge(() => this.dictionary?.set(name, value));
    if (this.dictionary.version !== version) this.changed?.();
    return this;
  }

  override delete(name: string): boolean {
    if (typeof name !== 'string') return namedKeyAccess().delete(this, name);
    if (!this.dictionary) return super.delete(name);
    const removed = this.dictionary.delete(name);
    if (!removed) return false;
    this.changed?.();
    releaseNamespaceKey(removed.key, removed.value);
    return true;
  }

  override clear(): void {
    super.clear();
    this.dictionary?.clear();
    this.changed?.();
  }

  override *entries(): MapIterator<[string, Value]> {
    if (!this.dictionary) {
      yield* super.entries();
      return;
    }
    for (const entry of this.dictionary.liveEntries()) {
      const name = this.keyText?.(entry.key);
      if (name !== undefined) yield [name, entry.value as Value];
    }
  }

  override *keys(): MapIterator<string> {
    for (const [name] of this.entries()) yield name;
  }

  override *values(): MapIterator<Value> {
    if (!this.dictionary) {
      yield* super.values();
      return;
    }
    for (const entry of this.dictionary.liveEntries()) yield entry.value as Value;
  }

  override [Symbol.iterator](): MapIterator<[string, Value]> {
    return this.entries();
  }

  override forEach(callback: (value: Value, key: string, map: Map<string, Value>) => void): void {
    for (const [name, value] of this.entries()) callback(value, name, this);
  }

  *rawEntries(): Generator<[PyValue, Value]> {
    if (!this.dictionary) {
      yield* super.entries();
      return;
    }
    for (const entry of this.dictionary.liveEntries()) yield [entry.key, entry.value as Value];
  }
}

export function namespaceReferences(map: Map<string, PyValue>): Iterable<PyValue> {
  return map instanceof NamespaceMap && map.dictionary ? dictionaryReferences(map.dictionary) : map.values();
}

function* dictionaryReferences(store: DictStore): Generator<PyValue> {
  for (const entry of store.liveEntries()) {
    yield entry.key;
    yield entry.value;
  }
}
