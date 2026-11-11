import { AttributeStore } from './attributeStore';
import { dictClass } from './types';
import { PyDict, type PyValue } from './values';

/** The dicts that `globals()` and a class body's `locals()` return, one per namespace, so that each stays the same. */
const dictsOfNamespaces = new WeakMap<Map<string, PyValue>, PyDict>();
const namespacesOfDicts = new WeakMap<PyDict, Map<string, PyValue>>();

/** A dict whose entries are a frame's variables, so that changing either changes the other. */
export function namespaceDict(namespace: Map<string, PyValue>): PyDict {
  if (namespace instanceof DictNamespace) return namespace.dict;
  let dict = dictsOfNamespaces.get(namespace);
  if (!dict) {
    dict = new PyDict(dictClass, new AttributeStore(namespace));
    dictsOfNamespaces.set(namespace, dict);
    namespacesOfDicts.set(dict, namespace);
  }
  return dict;
}

/** The variables of a frame that `exec` or `eval` runs in a dict, which the dict and the frame share. */
export function namespaceOf(dict: PyDict): Map<string, PyValue> {
  return namespacesOfDicts.get(dict) ?? new DictNamespace(dict);
}

/** The variables of a frame kept in a dict the program passed to `exec` or `eval`. */
class DictNamespace extends Map<string, PyValue> {
  constructor(readonly dict: PyDict) {
    super();
  }

  override get size(): number {
    return this.dict.store.size;
  }

  override get(key: string): PyValue | undefined {
    return this.dict.store.get(key);
  }

  override has(key: string): boolean {
    return this.dict.store.has(key);
  }

  override set(key: string, value: PyValue): this {
    this.dict.store.set(key, value);
    return this;
  }

  override delete(key: string): boolean {
    return this.dict.store.delete(key) !== undefined;
  }

  override clear(): void {
    this.dict.store.clear();
  }

  override *entries(): MapIterator<[string, PyValue]> {
    for (const entry of this.dict.store.liveEntries()) {
      if (typeof entry.key === 'string') yield [entry.key, entry.value];
    }
  }

  override *keys(): MapIterator<string> {
    for (const [key] of this.entries()) yield key;
  }

  override *values(): MapIterator<PyValue> {
    for (const [, value] of this.entries()) yield value;
  }

  override [Symbol.iterator](): MapIterator<[string, PyValue]> {
    return this.entries();
  }

  override forEach(callback: (value: PyValue, key: string, map: Map<string, PyValue>) => void): void {
    for (const [key, value] of this.entries()) callback(value, key, this);
  }
}
