import { type DictEntry, DictStore } from './dictStore';
import { keyHash, pyHash } from './hashing';
import { releaseNamespaceKey, withoutCharge } from './runtimeContext';
import { stringValue } from './types';
import { NamespaceMap, type PyValue } from './values';

/** The entries of each object's attributes whose keys are not strings, with the attribute each was stored after. */
interface Extras {
  store: DictStore;
  after: Map<DictEntry, string | undefined>;
}

const extrasOf = new WeakMap<Map<string, PyValue>, Extras>();

/**
 * The entries of an object's attributes seen as a dict, so that the `__dict__` a program reads stays the object's own
 * attributes: what it stores through the dict, the object has, and the other way round. A key that is not a string,
 * which no attribute can have, is kept beside them and listed after the attribute stored last before it.
 */
export class AttributeStore extends DictStore {
  constructor(private readonly attributes: Map<string, PyValue>) {
    super();
  }

  private get extras(): Extras | undefined {
    return extrasOf.get(this.attributes);
  }

  override get size(): number {
    if (this.dictionary) return this.dictionary.size;
    return this.attributes.size + (this.extras?.store.size ?? 0);
  }

  private get dictionary(): DictStore | undefined {
    return this.attributes instanceof NamespaceMap ? this.attributes.dictionary : undefined;
  }

  override lookup(key: PyValue, knownHash?: bigint): DictEntry | undefined {
    if (typeof key !== 'string' && this.attributes instanceof NamespaceMap) this.promote(this.attributes);
    if (this.dictionary) return this.dictionary.lookup(key, knownHash);
    if (typeof key !== 'string') {
      const hash = knownHash ?? keyHash(key, 'dict key');
      return this.extras?.store.lookup(key, hash);
    }
    const value = this.attributes.get(key);
    return value === undefined ? undefined : entryOf(key, value);
  }

  override set(key: PyValue, value: PyValue, knownHash?: bigint): void {
    if (this.attributes instanceof NamespaceMap && typeof key !== 'string') this.promote(this.attributes);
    if (this.dictionary) {
      const version = this.dictionary.version;
      this.dictionary.set(key, value, knownHash);
      if (this.dictionary.version !== version) this.version++;
      return;
    }
    if (typeof key !== 'string') {
      this.setExtra(key, value);
      return;
    }
    if (!this.attributes.has(key)) this.version++;
    this.attributes.set(key, value);
  }

  private promote(attributes: NamespaceMap): void {
    if (attributes.dictionary) return;
    const dictionary = new DictStore();
    withoutCharge(() => {
      for (const entry of this.liveEntries()) dictionary.set(entry.key, entry.value, entry.hash);
    });
    Map.prototype.clear.call(attributes);
    attributes.dictionary = dictionary;
    attributes.keyText = stringValue;
    attributes.changed = () => {
      this.version++;
    };
    extrasOf.delete(attributes);
  }

  private setExtra(key: PyValue, value: PyValue): void {
    let extras = this.extras;
    if (!extras) {
      extras = { store: new DictStore(), after: new Map() };
      extrasOf.set(this.attributes, extras);
    }
    const known = extras.store.lookup(key);
    if (known) {
      known.value = value;
      return;
    }
    extras.store.set(key, value);
    extras.after.set(extras.store.lookup(key) as DictEntry, [...this.attributes.keys()].at(-1));
    this.version++;
  }

  override delete(key: PyValue): DictEntry | undefined {
    const entry = this.lookup(key);
    if (entry) this.remove(entry);
    return entry;
  }

  override remove(entry: DictEntry): void {
    if (this.dictionary) {
      this.dictionary.remove(entry);
      this.version++;
      releaseNamespaceKey(entry.key, entry.value);
      return;
    }
    if (typeof entry.key === 'string') this.attributes.delete(entry.key);
    else this.extras?.store.remove(entry);
    this.version++;
  }

  override clear(): void {
    this.attributes.clear();
    extrasOf.delete(this.attributes);
    this.version++;
  }

  override *liveEntries(): Generator<DictEntry> {
    if (this.dictionary) {
      yield* this.dictionary.liveEntries();
      return;
    }
    const extras = this.extras;
    if (!extras) {
      for (const [key, value] of this.attributes) yield entryOf(key, value);
      return;
    }
    const pending = [...extras.store.liveEntries()];
    const following = (key: string | undefined): DictEntry[] =>
      pending.filter((entry) => extras.after.get(entry) === key);
    yield* following(undefined);
    for (const [key, value] of this.attributes) {
      yield entryOf(key, value);
      yield* following(key);
    }
    // The entries whose attribute was deleted since come last.
    yield* pending.filter((entry) => {
      const after = extras.after.get(entry);
      return after !== undefined && !this.attributes.has(after);
    });
  }

  override ordered(): DictEntry[] {
    return [...this.liveEntries()];
  }

  override *reversedLiveEntries(): Generator<DictEntry> {
    yield* this.ordered().toReversed();
  }

  override previous(entry: DictEntry | undefined): DictEntry | undefined {
    const entries = this.ordered();
    if (entry === undefined) return entries.at(-1);
    const index = entries.findIndex((each) => each.key === entry.key && typeof each.key === typeof entry.key);
    return index > 0 ? entries[index - 1] : undefined;
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
