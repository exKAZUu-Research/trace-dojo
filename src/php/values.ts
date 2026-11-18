// code-gauge-allow-file fileNcss 995 -- Keeps one PHP runtime concern and its shared helpers in one module.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { TurtleState } from '../interpreter/turtleWorld';
import { ArrayTable } from './arrayTable';
import type { ClassDecl, Expr, FunctionDecl, PropertyDeclAst } from './ast';
import { lower } from './bytes';

/**
 * A PHP value. Strings are byte strings: each UTF-16 code unit holds one byte (0–255), so that lengths and offsets
 * count bytes as PHP's do. Integers are bigints within the 64-bit range and floats are numbers.
 */
export type Value = null | boolean | bigint | number | string | PhpArray | PhpObject;

export type Key = bigint | string;

/** A variable or element slot that references share (`$a = &$b`). */
export class Ref {
  /** The number of storage and call-argument holders of this slot. */
  private holders = 1;
  get rc(): number {
    return this.holders;
  }
  set rc(count: number) {
    this.setHolders(count, true);
  }

  releaseWithoutGc(): void {
    this.setHolders(this.holders - 1, false);
  }

  private setHolders(count: number, buffer: boolean): void {
    const previous = this.holders;
    const wasLive = previous > 0;
    this.holders = count;
    if (wasLive && count <= 0) {
      if (this.value !== null && typeof this.value === 'object') owners.get(this.value)?.delete(this);
      invalidateOwner(this);
    } else if (!wasLive && count > 0) trackOwner(this.value, this);
    if (wasLive && count < previous && (buffer || count <= 0)) referenceDropObserver(this.value);
  }
  isRef = false;
  /** The typed property this reference was taken from, whose type every write through the reference must keep. */
  typedBy?: { decl: PropDecl; object?: PhpObject }[];

  private value: Value;
  constructor(value: Value = null) {
    this.value = value;
    trackOwner(value, this);
  }
  static temporary(value: Value): Ref {
    const ref = new Ref(value);
    ref.holders = 0;
    if (value !== null && typeof value === 'object') owners.get(value)?.delete(ref);
    invalidateOwner(ref);
    return ref;
  }

  addTypeOwner(decl: PropDecl, object?: PhpObject): void {
    this.typedBy ??= [];
    if (!this.typedBy.some((owner) => owner.decl === decl && owner.object === object))
      this.typedBy.push({ decl, object });
  }

  typeOwners(): NonNullable<Ref['typedBy']> {
    this.typedBy = this.typedBy?.filter(({ decl, object }) =>
      object ? object.props.get(decl.key) === this : decl.cls.findStatic(decl.name)?.ref === this
    );
    return this.typedBy ?? [];
  }

  get v(): Value {
    return this.value;
  }
  set v(value: Value) {
    const old = this.value;
    this.value = this.typedBy ? referenceTypeCheck(this, value) : value;
    trackOwner(this.value, this);
    dropped(old);
  }

  /** Writes a value, converting or rejecting it for the type of the property the reference was taken from. */
  assign(value: Value): void {
    this.v = value;
  }
}

let referenceDropObserver: (value: Value) => void = () => {};

export function setReferenceDropObserver(observe: typeof referenceDropObserver): void {
  referenceDropObserver = observe;
}

/** Frees what letting go of a value frees, which the interpreter provides, as PHP's reference counting does. */
let dropHandler: (values: unknown[]) => void = () => {};

export function setDropHandler(handler: (values: unknown[]) => void): void {
  dropHandler = handler;
}

let allocationHandler: (count: number, size: number) => void = () => {};

export function setAllocationHandler(handler: (count: number, size: number) => void): void {
  allocationHandler = handler;
}

/** Reports a value that a holder let go of, if it may hold objects. */
export function dropped(value: unknown): void {
  if (value !== null && typeof value === 'object') dropHandler([value]);
}

/** Converts a value written through a reference to a typed property, which the interpreter provides. */
let referenceTypeCheck: (ref: Ref, value: Value) => Value = (_ref, value) => value;

export function setReferenceTypeCheck(check: (ref: Ref, value: Value) => Value): void {
  referenceTypeCheck = check;
}

/** The marker of a typed property that has no value yet. */
export const UNINIT = Symbol('uninitialized');
export type Slot = Value | Ref | typeof UNINIT;

export const INT_MAX = 9_223_372_036_854_775_807n;
export const INT_MIN = -9_223_372_036_854_775_808n;

/** An ordered map, which arrays share until one of their holders writes to it (copy on write). */
export class PhpArray {
  mutationVersion = 0;
  private order: ArrayOrder | undefined;
  private orderPacked?: boolean;
  private readonly parents = new Set<WeakRef<PhpArray>>();
  private readonly knownParents = new WeakSet<PhpArray>();
  map: ArrayTable;
  /** One more than the largest integer key so far, or INT_MIN before any, as PHP's nNextFreeElement. */
  nextFree = INT_MIN;
  /** Whether more than one holder may see this array, so that a write must copy it first. */
  shared = false;
  persistentHolder = false;
  uncollectable = false;
  /** Whether an element may hold an object, an array, or a reference, which garbage collection must visit. */
  composite = false;
  /** The internal pointer of `current()`, `next()`, and `reset()`, as the key it points at. */
  pointer: Key | undefined | null = null;

  constructor(
    map?: Map<Key, Value | Ref>,
    private capacityHint = map?.size ?? 8
  ) {
    this.map = this.table(map);
    for (const [key, slot] of this.map) this.trackSlot(key, slot);
    // An array costs a slot of its own besides its elements, as a program of many small arrays holds their tables too.
    allocationHandler(this.map.size + 1, this.map.size);
  }

  static list(values: Value[]): PhpArray {
    return PhpArray.copySlots(values);
  }

  static copySlots(values: Iterable<Value | Ref>): PhpArray {
    const array = new PhpArray(undefined, Array.isArray(values) ? values.length : 8);
    for (const value of values) array.append(copyValueSlot(value));
    return array;
  }

  cursor(): ArrayCursor {
    return this.ordered().cursor();
  }

  prepareSort(): void {
    this.ordered().unpack();
  }

  get size(): number {
    return this.map.size;
  }

  get(key: Key): Value | undefined {
    const slot = this.map.get(key);
    return slot instanceof Ref ? slot.v : slot;
  }

  has(key: Key): boolean {
    return this.map.has(key);
  }

  set(key: Key, value: Value): void {
    const slot = this.map.get(key);
    if (slot instanceof Ref) {
      slot.assign(value);
    } else {
      this.insert(key, value);
      if (typeof key === 'bigint' && key >= this.nextFree) this.nextFree = key === INT_MAX ? INT_MAX : key + 1n;
    }
    if (value !== null && typeof value === 'object') this.composite = true;
    if (!(slot instanceof Ref)) dropped(slot);
  }

  setSlot(key: Key, slot: Value | Ref): void {
    const old = this.map.get(key);
    if (old instanceof Ref && old !== slot) old.rc--;
    this.insert(key, slot);
    if (typeof key === 'bigint' && key >= this.nextFree) this.nextFree = key === INT_MAX ? INT_MAX : key + 1n;
    if (slot !== null && typeof slot === 'object') this.composite = true;
    dropped(old);
  }

  /** The key that `$array[] = ...` uses: the next integer after the largest one, or 0 when there is none. */
  get appendKey(): bigint {
    return this.nextFree === INT_MIN ? 0n : this.nextFree;
  }

  append(value: Value | Ref): boolean {
    const key = this.appendKey;
    if (this.map.has(key)) return false;
    this.insert(key, value);
    this.nextFree = key === INT_MAX ? INT_MAX : key + 1n;
    if (value !== null && typeof value === 'object') this.composite = true;
    return true;
  }

  /**
   * Sets a slot. PHP's pointer is a position in the table, so a pointer past the end points at an element added
   * there.
   */
  private insert(key: Key, slot: Value | Ref): void {
    if (!this.map.has(key)) {
      allocationHandler(1, this.map.size + 1);
      if (this.pointer === undefined) this.pointer = key;
    }
    this.invalidate();
    this.trackSlot(key, slot);
    this.map.set(key, slot);
    this.order?.insert(key);
  }

  replaceTable(entries: Iterable<readonly [Key, Value | Ref]>, nextFree: bigint, packed = false): void {
    const previousSize = this.map.size;
    this.capacityHint = Math.max(this.capacityHint, previousSize);
    this.map = this.table(entries);
    allocationHandler(Math.max(0, this.size - previousSize), this.size);
    this.order?.replace(this.map.keys(), packed);
    this.orderPacked = packed;
    this.composite = false;
    for (const [key, slot] of this.map) {
      this.trackSlot(key, slot);
      if (slot !== null && typeof slot === 'object') this.composite = true;
    }
    this.nextFree = nextFree > INT_MAX ? INT_MAX : nextFree;
    this.invalidate();
  }

  private table(entries?: Iterable<readonly [Key, Value | Ref]>): ArrayTable {
    return new ArrayTable(entries, () => {
      for (const [key, slot] of this.map) this.trackSlot(key, slot);
    });
  }

  spliceList(start: number, count: number, replacement: (Value | Ref)[]): PhpArray | undefined {
    const removed = this.map.spliceList(start, count, replacement);
    if (!removed) return;
    const result = PhpArray.copySlots(removed);
    allocationHandler(Math.max(0, replacement.length - count), this.size);
    for (const slot of removed) if (slot instanceof Ref) slot.rc--;
    for (let index = 0; index < replacement.length; index++) this.trackSlot(BigInt(start + index), replacement[index]);
    if (replacement.some((slot) => slot !== null && typeof slot === 'object')) this.composite = true;
    this.order?.replace(this.map.keys(), true);
    this.orderPacked = true;
    this.nextFree = BigInt(this.size);
    this.pointer = null;
    this.invalidate();
    for (const slot of removed) dropped(slot);
    return result;
  }

  shiftStringKey(): { value: Value } | undefined {
    if (this.map.hasIntegerKeys() || this.size === 0) return;
    const key = this.map.keys().next().value as string;
    const slot = this.map.get(key) as Value | Ref;
    this.map.delete(key);
    this.order?.replace(this.map.keys(), false);
    this.orderPacked = false;
    this.nextFree = 0n;
    this.pointer = null;
    this.invalidate();
    if (slot instanceof Ref) slot.rc--;
    dropped(slot);
    const value = deref(slot);
    if (value instanceof PhpArray) value.shared = true;
    return { value };
  }

  shiftList(): { value: Value } | undefined {
    const result = this.map.shiftList();
    if (!result) return;
    const { slot } = result;
    if (slot instanceof Ref) slot.rc--;
    this.order?.shiftList();
    this.nextFree = BigInt(this.size);
    this.pointer = null;
    this.invalidate();
    dropped(slot);
    const value = deref(slot);
    if (value instanceof PhpArray) value.shared = true;
    return { value };
  }

  prependList(values: Value[]): boolean {
    if (!this.map.prependList(values)) return false;
    allocationHandler(values.length, this.size);
    for (let index = 0; index < values.length; index++) this.trackSlot(BigInt(index), values[index]);
    if (values.some((value) => value !== null && typeof value === 'object')) this.composite = true;
    this.order?.prependList(values.length);
    this.nextFree = BigInt(this.size);
    this.pointer = null;
    this.invalidate();
    return true;
  }

  private trackSlot(key: Key, slot: Value | Ref): void {
    if (slot instanceof PhpArray) slot.shared = true;
    trackOwner(slot, this, key);
  }

  retire(): (Value | Ref)[] {
    const slots = [...this.map.values()];
    this.map.clear();
    this.composite = false;
    this.mutationVersion++;
    invalidateOwner(this);
    for (const slot of slots) if (slot instanceof Ref) slot.rc--;
    return slots;
  }

  trackCachedParent(parent: PhpArray): void {
    if (this.knownParents.has(parent)) return;
    this.knownParents.add(parent);
    this.parents.add(new WeakRef(parent));
  }

  private invalidate(visited = new Set<PhpArray>()): void {
    this.uncollectable = false;
    invalidateOwner(this);
    if (visited.has(this)) return;
    visited.add(this);
    this.mutationVersion++;
    for (const parent of this.parents) {
      const array = parent.deref();
      if (array) array.invalidate(visited);
      else this.parents.delete(parent);
    }
  }

  delete(key: Key): void {
    if (!this.map.has(key)) return;
    const order = this.ordered();
    const old = this.map.get(key);
    if (old instanceof Ref) old.rc--;
    // PHP moves a pointer at the deleted element on to the next one.
    if (this.pointer === key) this.pointer = this.keyAfter(key);
    this.invalidate();
    this.map.delete(key);
    order.delete(key);
    dropped(old);
  }

  keys(): Key[] {
    return [...this.map.keys()];
  }

  values(): Value[] {
    const values: Value[] = [];
    for (const slot of this.map.values()) values.push(slot instanceof Ref ? slot.v : slot);
    return values;
  }

  *entries(): Generator<[Key, Value]> {
    for (const [key, slot] of this.map) yield [key, slot instanceof Ref ? slot.v : slot];
  }

  firstValue(): Value | undefined {
    const slot = this.map.values().next().value;
    return slot instanceof Ref ? slot.v : slot;
  }

  lastValue(): Value | undefined {
    const key = this.lastKey();
    return key === undefined ? undefined : this.get(key);
  }

  lastKey(): Key | undefined {
    return this.ordered().last?.key;
  }

  keyAfter(key: Key): Key | undefined {
    return this.ordered().get(key)?.next?.key;
  }

  keyBefore(key: Key): Key | undefined {
    return this.ordered().get(key)?.previous?.key;
  }

  private ordered(): ArrayOrder {
    if (!this.order) {
      this.order = new ArrayOrder(this.map.keys(), this.capacityHint);
      if (this.orderPacked === false) this.order.unpack();
    }
    return this.order;
  }

  /** The key the internal pointer is at, starting at the first element. */
  currentKey(): Key | undefined {
    if (this.pointer === null) return this.map.keys().next().value;
    return this.pointer;
  }

  /**
   * Copies the array for a holder that writes to it. Nested arrays become shared, and references held only by this
   * array become plain values, as PHP's copy does.
   */
  copy(): PhpArray {
    const map = new Map<Key, Value | Ref>();
    for (const [key, slot] of this.map) {
      if (slot instanceof Ref) {
        if (slot.rc <= 1) {
          const value = slot.v;
          if (value instanceof PhpArray) value.shared = true;
          map.set(key, value);
        } else {
          slot.rc++;
          map.set(key, slot);
        }
      } else {
        if (slot instanceof PhpArray) slot.shared = true;
        map.set(key, slot);
      }
    }
    const copy = new PhpArray(map, this.capacityHint);
    copy.order = this.order?.copy();
    copy.nextFree = this.nextFree;
    copy.composite = this.composite;
    copy.pointer = this.pointer;
    return copy;
  }

  isList(): boolean {
    let expected = 0n;
    for (const key of this.map.keys()) {
      if (key !== expected) return false;
      expected++;
    }
    return true;
  }
}

export type Visibility = 'public' | 'protected' | 'private';

/** A parameter of a function, which user and native functions describe alike. */
export interface Param {
  name: string;
  type?: TypeDecl;
  byRef: boolean;
  /** Whether a by-reference parameter of a builtin also accepts a value that is no variable. */
  preferRef?: boolean;
  variadic: boolean;
  optional: boolean;
  /** Whether a null default makes the type nullable implicitly, as `int $x = null` does. */
  implicitNullable?: boolean;
  nativeDefault?: string;
}

export type TypeDecl =
  | { k: 'named'; name: string; nullable?: boolean }
  | { k: 'union'; types: TypeDecl[] }
  | { k: 'inter'; types: TypeDecl[] };

export interface NativeContext {
  args: Value[];
  /** The references passed for by-reference parameters, by position. */
  refs: (Ref | undefined)[];
  thisObj?: PhpObject;
  /** The class a static native method was called on. */
  calledClass?: PhpClass;
  /** Named arguments that a variadic parameter collected. */
  named?: Map<string, Value>;
  /** The row of the call when code called the function directly, for a function whose call PHP compiles away. */
  row?: number;
}

export interface NativeFunction {
  kind: 'native';
  name: string;
  params: Param[];
  returnType?: TypeDecl;
  impl: (ctx: NativeContext) => Value;
  /** Whether the function reads its caller's variables (compact, extract, func_get_args). */
  needsCaller?: boolean;
  /**
   * Whether PHP compiles eligible direct calls into an instruction of their own (strlen, count, call_user_func),
   * so that stack traces show no frame for it and what it calls shows the caller's line.
   */
  inlined?: boolean;
  acceptsNamed?: boolean;
}

export interface UserFunction {
  kind: 'user';
  name: string;
  decl: FunctionDecl;
  params: Param[];
  statics: Map<string, Ref>;
}

export type Callable = NativeFunction | UserFunction;

export interface Method {
  name: string;
  lname: string;
  cls: PhpClass;
  fn: Callable;
  isStatic: boolean;
  isAbstract: boolean;
  isFinal: boolean;
  visibility: Visibility;
  /** The class whose code declared the method, which differs from `cls` for a method a trait supplies. */
  scope: PhpClass;
}

export interface PropDecl {
  declarationScope?: PhpClass;
  declarationAst?: PropertyDeclAst;
  name: string;
  /** The key of the property in an object's table: the name, or a mangled name for a private one. */
  key: string;
  cls: PhpClass;
  visibility: Visibility;
  setVisibility?: Visibility;
  isStatic: boolean;
  isReadonly: boolean;
  isFinal: boolean;
  type?: TypeDecl;
  /** The initial value's expression, or undefined for none (null if untyped, uninitialized if typed). */
  hasDefault: boolean;
  defaultValue?: () => Value;
  hooks?: { get?: Callable; set?: Callable; setParam?: string; abstractGet?: boolean; abstractSet?: boolean };
  /** Whether a hooked property has storage of its own. */
  isVirtual?: boolean;
}

export interface ClassConst {
  initializer?: Expr;
  name: string;
  cls: PhpClass;
  visibility: Visibility;
  isFinal: boolean;
  value?: Value;
  evaluate?: () => Value;
  evaluating?: boolean;
  type?: TypeDecl;
}

export type ClassKind = 'class' | 'interface' | 'trait' | 'enum';

export class PhpClass {
  parent?: PhpClass;
  /** Every interface the class implements, directly or through its parent and interfaces. */
  interfaces: PhpClass[] = [];
  /** The interfaces the declaration names, in order. */
  ownInterfaces: PhpClass[] = [];
  isAbstract = false;
  isFinal = false;
  isCloneable = true;
  isReadonly = false;
  consts = new Map<string, ClassConst>();
  staticProps = new Map<string, { ref: Ref; decl: PropDecl }>();
  /** The instance property declarations, in the order an object's table holds them. */
  props: PropDecl[] = [];
  /** The declaration that code outside the class sees for each property name. */
  propByName = new Map<string, PropDecl>();
  /** Private property declarations by name, for code of this class. */
  privateProps = new Map<string, PropDecl>();
  methods = new Map<string, Method>();
  decl?: ClassDecl;

  /** The name `get_class` and `::class` give, which differs from the name messages show for an anonymous class. */
  get fullName(): string {
    return this.decl?.fullName ?? this.name;
  }
  isUser = false;
  isAnonymous = false;
  /** Native construction of the internal state a builtin class keeps. */
  createInternal?: (object: PhpObject) => unknown;
  /** Whether the class's static properties have their initial values. */
  staticsInitialized = false;
  traits: PhpClass[] = [];
  declaredRow = 0;

  constructor(
    public name: string,
    public kind: ClassKind = 'class'
  ) {}

  get lname(): string {
    return lower(this.name);
  }

  findMethod(lname: string): Method | undefined {
    for (const cls of lineage(this)) {
      const method = cls.methods.get(lname);
      if (method) return method;
    }
    // Interfaces declare abstract methods that an abstract class may not implement itself.
    for (const iface of this.interfaces) {
      const method = iface.methods.get(lname);
      if (method) return method;
    }
    return undefined;
  }

  findConst(name: string): ClassConst | undefined {
    for (const cls of lineage(this)) {
      const constant = cls.consts.get(name);
      if (constant) return constant;
    }
    for (const iface of this.interfaces) {
      const constant = iface.consts.get(name);
      if (constant) return constant;
    }
    return undefined;
  }

  findStatic(name: string): { ref: Ref; decl: PropDecl } | undefined {
    for (const cls of lineage(this)) {
      const prop = cls.staticProps.get(name);
      if (prop) return prop;
    }
    return undefined;
  }

  isSubclassOf(other: PhpClass): boolean {
    if (this === other) return true;
    for (let cls: PhpClass | undefined = this.parent; cls; cls = cls.parent) if (cls === other) return true;
    return this.interfaces.includes(other);
  }
}

class ArrayEntry {
  rawKey!: Key;
  private rawIndex!: number;
  previous?: ArrayEntry;
  next?: ArrayEntry;

  constructor(
    private readonly order: ArrayOrder,
    key: Key,
    index: number
  ) {
    this.key = key;
    this.index = index;
  }

  get key(): Key {
    return typeof this.rawKey === 'bigint' ? this.rawKey - this.order.keyOffset : this.rawKey;
  }
  set key(key: Key) {
    this.rawKey = typeof key === 'bigint' ? key + this.order.keyOffset : key;
  }
  get index(): number {
    return this.rawIndex - this.order.indexOffset;
  }
  set index(index: number) {
    this.rawIndex = index + this.order.indexOffset;
  }
}

class ArrayOrder {
  private readonly entries = new Map<Key, ArrayEntry>();
  first: ArrayEntry | undefined;
  last: ArrayEntry | undefined;
  keyOffset = 0n;
  indexOffset = 0;
  private listLayout = false;
  private nextIndex = 0;
  private capacity = 8;
  private packed: boolean | undefined;
  private readonly cursors = new Set<WeakRef<ArrayCursor>>();

  constructor(keys: Iterable<Key>, capacityHint = 8) {
    while (this.capacity < capacityHint) this.capacity *= 2;
    for (const key of keys) this.insert(key);
  }

  get(key: Key): ArrayEntry | undefined {
    return this.entries.get(typeof key === 'bigint' ? key + this.keyOffset : key);
  }

  cursor(): ArrayCursor {
    const cursor = new ArrayCursor(this);
    this.cursors.add(new WeakRef(cursor));
    return cursor;
  }

  copy(): ArrayOrder {
    const copy = new ArrayOrder([], this.capacity);
    for (const entry of this.orderedEntries()) copy.appendEntry(entry.key, entry.index);
    copy.nextIndex = this.nextIndex;
    copy.packed = this.packed;
    copy.listLayout = this.listLayout;
    if (copy.entries.size === 0) {
      copy.capacity = 8;
      copy.packed = undefined;
      copy.listLayout = false;
    } else if (!copy.packed) copy.compact();
    return copy;
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  insert(key: Key): void {
    if (this.get(key)) return;
    const numeric = typeof key === 'bigint' && key >= 0n && key < BigInt(Number.MAX_SAFE_INTEGER);
    const position = numeric ? Number(key) : -1;
    this.packed ??= numeric && position < this.capacity;
    if (this.packed) {
      if (!numeric || position < this.nextIndex) this.toMixed();
      else if (position >= this.capacity) {
        if (position < this.capacity * 2 && this.entries.size > this.capacity / 2) this.capacity *= 2;
        else this.toMixed();
      }
    }
    if (!this.packed && this.nextIndex >= this.capacity) {
      if (this.nextIndex > this.entries.size + (this.entries.size >> 5)) this.compact();
      else this.capacity *= 2;
    }
    if (key !== BigInt(this.entries.size)) this.listLayout = false;
    const index = this.packed ? position : this.nextIndex;
    this.nextIndex = index + 1;
    const entry = this.appendEntry(key, index);
    for (const cursor of this.liveCursors()) cursor.entry ??= entry;
  }

  unpack(): void {
    if (this.packed) this.replace(this.keys(), false);
  }

  private toMixed(): void {
    if (this.nextIndex >= this.capacity) this.capacity *= 2;
    this.packed = false;
    this.compact();
  }

  private compact(): void {
    let index = 0;
    for (const entry of this.orderedEntries()) entry.index = index++;
    this.nextIndex = index;
    for (const cursor of this.liveCursors()) cursor.refreshPosition();
  }

  private appendEntry(key: Key, index: number): ArrayEntry {
    const entry = new ArrayEntry(this, key, index);
    entry.previous = this.last;
    if (this.last) this.last.next = entry;
    else this.first = entry;
    this.last = entry;
    this.entries.set(entry.rawKey, entry);
    return entry;
  }

  shiftList(): void {
    this.normalizeList();
    if (this.first) this.delete(this.first.key);
    this.keyOffset++;
    this.indexOffset++;
    this.nextIndex = this.entries.size;
    this.listLayout = true;
  }

  prependList(count: number): void {
    this.normalizeList();
    this.keyOffset -= BigInt(count);
    this.indexOffset -= count;
    for (let index = count - 1; index >= 0; index--) {
      const entry = new ArrayEntry(this, BigInt(index), index);
      entry.next = this.first;
      if (this.first) this.first.previous = entry;
      else this.last = entry;
      this.first = entry;
      this.entries.set(entry.rawKey, entry);
    }
    this.nextIndex = this.entries.size;
    this.capacity = 8;
    while (this.capacity < this.nextIndex) this.capacity *= 2;
    this.packed = true;
  }

  private normalizeList(): void {
    if (this.listLayout) return;
    const previous = [...this.orderedEntries()];
    this.entries.clear();
    this.keyOffset = 0n;
    this.indexOffset = 0;
    for (const [index, entry] of previous.entries()) {
      entry.key = BigInt(index);
      entry.index = index;
      this.entries.set(entry.rawKey, entry);
    }
    this.nextIndex = previous.length;
    for (const cursor of this.liveCursors()) cursor.refreshPosition();
    this.listLayout = true;
  }

  delete(key: Key): void {
    const entry = this.get(key);
    if (!entry) return;
    if (entry !== this.last) this.listLayout = false;
    for (const cursor of this.liveCursors()) cursor.deleteEntry(entry);
    if (entry.previous) entry.previous.next = entry.next;
    else this.first = entry.next;
    if (entry.next) entry.next.previous = entry.previous;
    else {
      this.last = entry.previous;
      this.nextIndex = (this.last?.index ?? -1) + 1;
    }
    this.entries.delete(entry.rawKey);
  }

  replace(keys: Iterable<Key>, packed: boolean): void {
    const orderedKeys = [...keys];
    const cursors = [...this.liveCursors()].map((cursor) => ({ cursor, index: cursor.index }));
    this.entries.clear();
    this.first = undefined;
    this.last = undefined;
    this.keyOffset = 0n;
    this.indexOffset = 0;
    for (const key of orderedKeys) this.appendEntry(key, this.entries.size);
    this.nextIndex = this.entries.size;
    while (this.capacity < this.nextIndex) this.capacity *= 2;
    this.listLayout = orderedKeys.every((key, index) => key === BigInt(index));
    this.packed = packed && this.listLayout;
    const entries = [...this.orderedEntries()];
    for (const { cursor, index } of cursors) cursor.entry = index === undefined ? undefined : entries[index];
  }

  private *keys(): Generator<Key> {
    for (const entry of this.orderedEntries()) yield entry.key;
  }

  private *orderedEntries(): Generator<ArrayEntry> {
    for (let entry = this.first; entry; entry = entry.next) yield entry;
  }

  private *liveCursors(): Generator<ArrayCursor> {
    for (const reference of this.cursors) {
      const cursor = reference.deref();
      if (cursor) yield cursor;
      else this.cursors.delete(reference);
    }
  }
}

export class ArrayCursor {
  private current: ArrayEntry | undefined;
  private rawPosition: number | undefined;
  get entry(): ArrayEntry | undefined {
    return this.current;
  }
  set entry(value: ArrayEntry | undefined) {
    this.current = value;
    this.refreshPosition();
  }
  refreshPosition(): void {
    this.rawPosition = this.current ? this.current.index + this.order.indexOffset : undefined;
  }
  deleteEntry(entry: ArrayEntry): void {
    if (this.current === entry) this.current = entry.next;
  }
  constructor(private readonly order: ArrayOrder) {
    this.rewind();
  }
  get key(): Key | undefined {
    return this.current?.key;
  }
  get index(): number | undefined {
    return this.rawPosition === undefined ? undefined : Math.max(0, this.rawPosition - this.order.indexOffset);
  }
  rewind(): void {
    this.entry = this.order.first;
  }
  next(): void {
    this.entry = this.entry?.next;
  }
}

/** A class and its ancestors, the class first. */
function* lineage(start: PhpClass): Generator<PhpClass> {
  for (let cls: PhpClass | undefined = start; cls; cls = cls.parent) yield cls;
}

export class PhpObject {
  get isResource(): boolean {
    return this.cls.name === '(stream)';
  }

  props = new PropertyMap(this);
  unsetProperties?: Set<string>;
  private internalValue?: unknown;
  get internal(): unknown {
    return this.internalValue;
  }
  set internal(value: unknown) {
    this.nativeValues?.detach();
    clearNativeOwnership(this);
    this.internalValue = value;
    this.nativeValues?.attach(this);
    internalHandler(this);
    nativeOwnershipChanged(this);
  }
  get nativeValues(): NativeValueIndex | undefined {
    const index = (this.internalValue as { nativeValues?: unknown } | undefined)?.nativeValues;
    return index instanceof NativeValueIndex ? index : undefined;
  }
  turtle?: TurtleState;
  /** Whether the destructor ran or must not run. */
  destructed = false;
  /** Properties a `__get` or `__set` call is running for, which a nested access reads and writes directly. */
  guards?: Set<string>;
  /** The readonly properties that have been initialized and may not change. */
  readonlyInit?: Set<string>;
  /** Whether `clone` is copying this object, which lets its readonly properties be reinitialized. */
  cloning?: boolean;

  constructor(
    public cls: PhpClass,
    public id: number
  ) {}
}

/** The internal state of a closure object. */
export interface ClosureData {
  fn: Callable;
  /** The variables `use` captured, by name. */
  bound: Map<string, Ref>;
  thisObj?: PhpObject;
  scope?: PhpClass;
  calledClass?: PhpClass;
  isStatic: boolean;
  /** The method a first-class callable or `Closure::fromCallable` names, for its trace name. */
  method?: Method;
}

export function isClosure(value: Value): boolean {
  return value instanceof PhpObject && value.cls.name === 'Closure';
}

export function deref(slot: Value | Ref): Value {
  return slot instanceof Ref ? slot.v : slot;
}

const nativeOwners = new WeakMap<object, Set<PhpObject>>();

export class NativeValueIndex {
  private readonly counts = new Map<PhpArray | PhpObject, number>();
  private owner: PhpObject | undefined;

  count(value: PhpArray | PhpObject): number {
    return this.counts.get(value) ?? 0;
  }

  attach(owner: PhpObject): void {
    this.detach();
    this.owner = owner;
    for (const value of this.counts.keys()) this.link(value, false);
    nativeOwnershipChanged(owner);
  }

  detach(): void {
    if (this.owner) for (const value of this.counts.keys()) nativeOwners.get(value)?.delete(this.owner);
    this.owner = undefined;
  }

  add(value: Value): void {
    if (!(value instanceof PhpArray || value instanceof PhpObject)) return;
    if (value instanceof PhpArray) value.shared = true;
    this.counts.set(value, (this.counts.get(value) ?? 0) + 1);
    this.link(value);
  }

  delete(value: Value): void {
    if (!(value instanceof PhpArray || value instanceof PhpObject)) return;
    const count = this.counts.get(value) ?? 0;
    if (count > 1) this.counts.set(value, count - 1);
    else {
      this.counts.delete(value);
      if (this.owner) nativeOwners.get(value)?.delete(this.owner);
    }
    if (this.owner) nativeOwnershipChanged(this.owner);
  }

  reset(values: Iterable<Value>): void {
    const owner = this.owner;
    this.detach();
    this.counts.clear();
    for (const value of values) this.add(value);
    if (owner) this.attach(owner);
  }

  private link(value: object, notify = true): void {
    if (!this.owner) return;
    let holders = nativeOwners.get(value);
    if (!holders) {
      holders = new Set();
      nativeOwners.set(value, holders);
    }
    holders.add(this.owner);
    if (notify) nativeOwnershipChanged(this.owner);
  }
}

type Owner = Ref | PhpArray | PhpObject;
export type OwnershipChange =
  | { kind: 'edge'; value: object; owner: Owner; key?: Key }
  | { kind: 'native'; owner: PhpObject };
const ownershipObservers = new Set<(change: OwnershipChange) => void>();

export function observeOwnership(observer: (change: OwnershipChange) => void): () => void {
  ownershipObservers.add(observer);
  return () => {
    ownershipObservers.delete(observer);
  };
}

const genericNativeArrays = new WeakMap<PhpObject, Map<PhpArray, number>>();

export function clearNativeOwnership(owner: PhpObject): void {
  for (const value of genericNativeArrays.get(owner)?.keys() ?? []) nativeOwners.get(value)?.delete(owner);
  genericNativeArrays.delete(owner);
}

export function nativeOwnershipChanged(owner: PhpObject): void {
  refreshNativeArrays(owner);
  invalidateOwner(owner);
  for (const observer of ownershipObservers) observer({ kind: 'native', owner });
}

function refreshNativeArrays(owner: PhpObject): void {
  clearNativeOwnership(owner);
  if (owner.nativeValues || isClosure(owner)) return;
  const internal = owner.internal as { held?: () => unknown[] } | undefined;
  if (!internal?.held) return;
  const counts = new Map<PhpArray, number>();
  for (const value of internal.held()) {
    if (!(value instanceof PhpArray)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
    let holders = nativeOwners.get(value);
    if (!holders) nativeOwners.set(value, (holders = new Set()));
    holders.add(owner);
  }
  genericNativeArrays.set(owner, counts);
}

export function ownershipEdgeExists(change: Extract<OwnershipChange, { kind: 'edge' }>): boolean {
  const { value, owner, key } = change;
  if (owner instanceof Ref) return owner.rc > 0 && owner.v === value;
  return owner instanceof PhpArray ? owner.map.hasValue(value, key as Key) : owner.props.get(key as string) === value;
}
const owners = new WeakMap<object, Map<Owner, Set<Key | undefined>>>();
let internalHandler: (object: PhpObject) => void = () => {};

export function setInternalHandler(handler: typeof internalHandler): void {
  internalHandler = handler;
}

function trackOwner(value: unknown, parent: Owner, key?: Key): void {
  rewireOwnership(parent, key, value);
  if (!(value instanceof Ref || value instanceof PhpArray || value instanceof PhpObject)) return;
  let parents = owners.get(value);
  if (!parents) {
    parents = new Map();
    owners.set(value, parents);
  }
  let keys = parents.get(parent);
  if (!keys) {
    keys = new Set();
    parents.set(parent, keys);
  }
  keys.add(key);
  for (const observer of ownershipObservers) observer({ kind: 'edge', value, owner: parent, key });
}

export function arrayHolderCount(value: PhpArray): number {
  let count = value.persistentHolder ? 1 : 0;
  for (const parent of nativeOwners.get(value) ?? []) {
    count += parent.nativeValues?.count(value) ?? genericNativeArrays.get(parent)?.get(value) ?? 0;
    if (count > 1) return count;
  }
  const parents = owners.get(value);
  for (const [parent, keys] of parents ?? []) {
    const held = directHolderCount(parent, value, keys);
    if (!held) parents?.delete(parent);
    count += held;
    if (count > 1) return count;
  }
  return count;
}

export function* valueOwners(value: object): Generator<Owner> {
  yield* nativeOwners.get(value) ?? [];
  const parents = owners.get(value);
  for (const [parent, keys] of parents ?? []) {
    if (directHolderCount(parent, value, keys)) yield parent;
    else parents?.delete(parent);
  }
}

function directHolderCount(parent: Owner, value: object, keys: Set<Key | undefined>): number {
  if (parent instanceof Ref) return parent.rc > 0 && parent.v === value ? 1 : 0;
  const packed = parent instanceof PhpArray ? parent.map.packedValueCount(value) : undefined;
  if (packed !== undefined) return packed;
  let count = 0;
  for (const key of keys) {
    const actual = parent instanceof PhpArray ? parent.map.get(key as Key) : parent.props.get(key as string);
    if (actual === value) {
      if (++count > 1) return count;
    } else keys.delete(key);
  }
  return count;
}

class PropertyMap extends Map<string, Slot> {
  constructor(private readonly owner: PhpObject) {
    super();
  }
  override set(key: string, value: Slot): this {
    const old = this.get(key);
    super.set(key, value);
    if (value !== UNINIT) this.owner.unsetProperties?.delete(key);
    trackOwner(value, this.owner, key);
    dropped(old);
    return this;
  }
  override clear(): void {
    invalidateOwner(this.owner);
    this.owner.unsetProperties?.clear();
    super.clear();
  }
  override delete(key: string): boolean {
    const old = this.get(key);
    invalidateOwner(this.owner);
    const removed = super.delete(key);
    if (removed) dropped(old);
    return removed;
  }
}

const reachProofs = new WeakMap<object, object>();
const proofChildren = new WeakMap<object, Set<object>>();
const proofParents = new WeakMap<object, object>();
let ownershipWorkHandler: (cost: number) => void = () => {};

export function setOwnershipWorkHandler(handler: typeof ownershipWorkHandler): void {
  ownershipWorkHandler = handler;
}

function rewireOwnership(owner: Owner, key: Key | undefined, value: unknown): void {
  const root = reachProofs.get(owner);
  if (root && value !== owner && (value instanceof Ref || value instanceof PhpArray || value instanceof PhpObject))
    rememberOwnership([owner, value], root);
  const children = proofChildren.get(owner);
  for (const child of children ?? []) {
    if (child === value || retainsChild(owner, key, child)) continue;
    invalidateOwner(child);
  }
}

function retainsChild(owner: Owner, replacedKey: Key | undefined, child: object): boolean {
  if (owner instanceof Ref) return false;
  if (owner instanceof PhpObject && nativeOwners.get(child)?.has(owner)) return true;
  for (const key of owners.get(child)?.get(owner) ?? []) {
    if (key === replacedKey) continue;
    const actual = owner instanceof PhpArray ? owner.map.get(key as Key) : owner.props.get(key as string);
    if (actual === child) return true;
  }
  return false;
}

function invalidateOwner(owner: object): void {
  const pending = [owner];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop() as object;
    if (visited.has(value)) continue;
    visited.add(value);
    reachProofs.delete(value);
    const parent = proofParents.get(value);
    if (parent) proofChildren.get(parent)?.delete(value);
    proofParents.delete(value);
    const children = proofChildren.get(value);
    if (children) {
      for (const child of children) if (proofParents.get(child) === value) pending.push(child);
      proofChildren.delete(value);
    }
  }
}

export function ownershipProof(value: object, isRoot: (value: object) => boolean): object | undefined {
  const root = reachProofs.get(value);
  return root !== undefined && isRoot(root) ? root : undefined;
}

// code-gauge-allow functionCognitiveComplexity 19 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function rememberOwnership(path: object[], root: object): void {
  for (let index = 0; index < path.length; index++) {
    const value = path[index];
    reachProofs.set(value, root);
    if (value === root) {
      const parent = proofParents.get(value);
      if (parent) proofChildren.get(parent)?.delete(value);
      proofParents.delete(value);
    }
    const child = path[index + 1];
    if (child && child !== value) {
      if (proofChildren.get(child)?.size && wouldProofCycle(value, child)) return;
      const previous = proofParents.get(child);
      if (previous) proofChildren.get(previous)?.delete(child);
      proofParents.set(child, value);
      let children = proofChildren.get(value);
      if (!children) {
        children = new Set();
        proofChildren.set(value, children);
      }
      children.add(child);
    }
  }
}

function wouldProofCycle(owner: object, child: object): boolean {
  let work = 0;
  for (let parent: object | undefined = owner; parent; parent = proofParents.get(parent)) {
    if ((++work & 63) === 0) ownershipWorkHandler(8);
    if (parent === child) {
      ownershipWorkHandler(Math.ceil((work & 63) / 8));
      return true;
    }
  }
  ownershipWorkHandler(Math.ceil((work & 63) / 8));
  return false;
}

export function copyValueSlot(slot: Value | Ref): Value | Ref {
  if (slot instanceof Ref && slot.isRef && slot.rc > 1) {
    slot.rc++;
    return slot;
  }
  const value = slot instanceof Ref ? slot.v : slot;
  if (value instanceof PhpArray) value.shared = true;
  return value;
}

export function visibilityRank(visibility: Visibility): number {
  return visibility === 'public' ? 2 : visibility === 'protected' ? 1 : 0;
}
