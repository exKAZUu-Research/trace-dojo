// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { TurtleState } from '../interpreter/turtleWorld';
import type { ClassDecl, FunctionDecl } from './ast';

/**
 * A PHP value. Strings are byte strings: each UTF-16 code unit holds one byte (0–255), so that lengths and offsets
 * count bytes as PHP's do. Integers are bigints within the 64-bit range and floats are numbers.
 */
export type Value = null | boolean | bigint | number | string | PhpArray | PhpObject;

export type Key = bigint | string;

/** A variable or element slot that references share (`$a = &$b`). */
export class Ref {
  /** How many variables, elements, and properties hold this slot, once it is a reference. */
  rc = 1;
  isRef = false;

  constructor(public v: Value = null) {}
}

/** The marker of a typed property that has no value yet. */
export const UNINIT = Symbol('uninitialized');
export type Slot = Value | Ref | typeof UNINIT;

export const INT_MAX = 9_223_372_036_854_775_807n;
export const INT_MIN = -9_223_372_036_854_775_808n;

/** An ordered map, which arrays share until one of their holders writes to it (copy on write). */
export class PhpArray {
  map: Map<Key, Value | Ref>;
  /** One more than the largest integer key so far, or INT_MIN before any, as PHP's nNextFreeElement. */
  nextFree = INT_MIN;
  /** Whether more than one holder may see this array, so that a write must copy it first. */
  shared = false;
  /** Whether an element may hold an object, an array, or a reference, which garbage collection must visit. */
  composite = false;
  /** The internal pointer of `current()`, `next()`, and `reset()`, as the key it points at. */
  pointer: Key | undefined | null = null;

  constructor(map?: Map<Key, Value | Ref>) {
    this.map = map ?? new Map();
  }

  static list(values: Value[]): PhpArray {
    const array = new PhpArray();
    for (const value of values) array.append(value);
    return array;
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
      slot.v = value;
    } else {
      this.map.set(key, value);
      if (typeof key === 'bigint' && key >= this.nextFree) this.nextFree = key + 1n;
    }
    if (value !== null && typeof value === 'object') this.composite = true;
  }

  setSlot(key: Key, slot: Value | Ref): void {
    const old = this.map.get(key);
    if (old instanceof Ref && old !== slot) old.rc--;
    this.map.set(key, slot);
    if (typeof key === 'bigint' && key >= this.nextFree) this.nextFree = key + 1n;
    if (slot !== null && typeof slot === 'object') this.composite = true;
  }

  /** The key that `$array[] = ...` uses: the next integer after the largest one, or 0 when there is none. */
  get appendKey(): bigint {
    return this.nextFree === INT_MIN ? 0n : this.nextFree;
  }

  /** Appends a value, returning false when the next key would pass the largest integer. */
  append(value: Value | Ref): boolean {
    if (this.nextFree > INT_MAX) return false;
    const key = this.appendKey;
    this.map.set(key, value);
    this.nextFree = key + 1n;
    if (value !== null && typeof value === 'object') this.composite = true;
    return true;
  }

  delete(key: Key): void {
    const old = this.map.get(key);
    if (old instanceof Ref) old.rc--;
    this.map.delete(key);
    if (this.pointer === key) this.pointer = this.keyAfter(key);
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

  /** The key after `key` in order, for the internal pointer. */
  keyAfter(key: Key): Key | undefined {
    let found = false;
    for (const candidate of this.map.keys()) {
      if (found) return candidate;
      if (candidate === key) found = true;
    }
    return undefined;
  }

  keyBefore(key: Key): Key | undefined {
    let previous: Key | undefined;
    for (const candidate of this.map.keys()) {
      if (candidate === key) return previous;
      previous = candidate;
    }
    return undefined;
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
    const copy = new PhpArray(map);
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
}

export interface NativeFunction {
  kind: 'native';
  name: string;
  params: Param[];
  returnType?: TypeDecl;
  impl: (ctx: NativeContext) => Value;
  /** Whether the function reads its caller's variables (compact, extract, func_get_args). */
  needsCaller?: boolean;
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
  name: string;
  /** The key of the property in an object's table: the name, or a mangled name for a private one. */
  key: string;
  cls: PhpClass;
  visibility: Visibility;
  setVisibility?: Visibility;
  isStatic: boolean;
  isReadonly: boolean;
  type?: TypeDecl;
  /** The initial value's expression, or undefined for none (null if untyped, uninitialized if typed). */
  hasDefault: boolean;
  defaultValue?: () => Value;
  hooks?: { get?: Callable; set?: Callable; setParam?: string };
  /** Whether a hooked property has storage of its own. */
  isVirtual?: boolean;
}

export interface ClassConst {
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
    return this.name.toLowerCase();
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

/** A class and its ancestors, the class first. */
function* lineage(start: PhpClass): Generator<PhpClass> {
  for (let cls: PhpClass | undefined = start; cls; cls = cls.parent) yield cls;
}

export class PhpObject {
  props = new Map<string, Slot>();
  internal?: unknown;
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
