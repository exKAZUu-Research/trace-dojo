import { type DictEntry, DictStore } from './dictStore';
import { pyHash } from './hashing';
import { UnsupportedFeatureError } from './unsupported';
import type { PyValue } from './values';

/**
 * The entries of an object's attributes seen as a dict, so that the `__dict__` a program reads stays the object's own
 * attributes: what it stores through the dict, the object has, and the other way round.
 */
export class AttributeStore extends DictStore {
  constructor(private readonly attributes: Map<string, PyValue>) {
    super();
  }

  override get size(): number {
    return this.attributes.size;
  }

  override lookup(key: PyValue): DictEntry | undefined {
    if (typeof key !== 'string') return undefined;
    const value = this.attributes.get(key);
    return value === undefined ? undefined : entryOf(key, value);
  }

  override set(key: PyValue, value: PyValue): void {
    if (typeof key !== 'string') {
      pyHash(key);
      throw new UnsupportedFeatureError('属性の辞書（__dict__）への文字列以外のキーの追加');
    }
    if (!this.attributes.has(key)) this.version++;
    this.attributes.set(key, value);
  }

  override delete(key: PyValue): DictEntry | undefined {
    const entry = this.lookup(key);
    if (entry) this.remove(entry);
    return entry;
  }

  override remove(entry: DictEntry): void {
    this.attributes.delete(entry.key as string);
    this.version++;
  }

  override clear(): void {
    this.attributes.clear();
    this.version++;
  }

  override *liveEntries(): Generator<DictEntry> {
    for (const [key, value] of this.attributes) yield entryOf(key, value);
  }

  override ordered(): DictEntry[] {
    return [...this.liveEntries()];
  }

  override last(): DictEntry | undefined {
    return this.ordered().at(-1);
  }

  override first(): DictEntry | undefined {
    return this.ordered()[0];
  }

  override moveToEnd(): void {
    throw new Error('An attribute dict is never an OrderedDict');
  }
}

function entryOf(key: string, value: PyValue): DictEntry {
  return { key, value, hash: pyHash(key), alive: true };
}
