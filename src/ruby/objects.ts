import type { TurtleState } from '../interpreter/turtleWorld';
import type { BlockDef, MethodDef } from './ast';
import { hierarchyEntries, type HierarchyEntry, initializeHierarchy } from './classHierarchy';
import { internId } from './internedIds';
import type { NativeSignature } from './nativeSignatures';
import { rt } from './runtime';

/**
 * A Ruby value. Integers are bigints and floats are numbers, so that the two stay distinct and integers have no size
 * limit; `true` and `false` are booleans; everything else is an object.
 */
export type Value = bigint | number | boolean | RNil | RSymbol | RBasic;

export class RNil {
  readonly kind = 'nil';
}
export const NIL = new RNil();

/** Symbols are interned, so that two symbols with the same name are the same object. */
export class RSymbol {
  readonly id = (nextObjectId += 8);
  nameString?: RString;
  private constructor(
    readonly name: string,
    readonly binary: boolean,
    readonly usAscii: boolean,
    readonly bytes?: Uint8Array
  ) {}

  get key(): string {
    if (!this.binary && !this.usAscii) return this.name;
    const prefix = this.usAscii ? 0xdd_00 : 0xdc_00;
    return Array.from(this.bytes ?? new TextEncoder().encode(this.name), (byte) =>
      String.fromCodePoint(byte < 128 ? byte : prefix + byte)
    ).join('');
  }

  static fromKey(key: string): RSymbol {
    const name = decodeSymbolKey(key);
    return RSymbol.of(name.name, name.binary, name.usAscii, name.bytes);
  }

  static of(name: string, binary = false, usAscii = false, sourceBytes?: Uint8Array): RSymbol {
    const symbols = rt().symbols;
    const bytes = sourceBytes ?? new TextEncoder().encode(name);
    const high = bytes.some((byte) => byte >= 0x80);
    const encodedBinary = binary && high;
    const encodedAscii = usAscii && high && !binary;
    const key =
      encodedBinary || encodedAscii
        ? `${encodedBinary ? 'binary' : 'ascii'}:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
        : `text:${name}`;
    let symbol = symbols.get(key);
    if (!symbol) {
      symbol = new RSymbol(name, encodedBinary, encodedAscii, high ? Uint8Array.from(bytes) : undefined);
      symbols.set(key, symbol);
    }
    return symbol;
  }
}

export function decodeSymbolKey(key: string): { name: string; binary: boolean; usAscii: boolean; bytes?: Uint8Array } {
  if (!/[\uDC80-\uDCFF\uDD80-\uDDFF]/u.test(key)) return { name: key, binary: false, usAscii: false };
  const usAscii = /[\uDD80-\uDDFF]/u.test(key);
  const bytes = Uint8Array.from(key, (char) => char.codePointAt(0)! & 255);
  const name = Array.from(bytes, (byte) => String.fromCodePoint(usAscii && byte >= 128 ? 0xdc_00 + byte : byte)).join(
    ''
  );
  return { name, binary: !usAscii, usAscii, bytes };
}

let nextObjectId = 8;

/** An object with an identity, a class, and instance variables. */
export abstract class RBasic {
  frozen = false;
  readonly id = (nextObjectId += 8);
  ivars?: Map<string, Value>;
  internal?: Map<string, Value>;
  /** The singleton class, created when the program defines a method on this object alone. */
  singleton?: RClass;
  singletonExposed = false;

  constructor(public cls: RClass) {}
}

export class RFloat extends RBasic {
  frozen = true;

  constructor(
    cls: RClass,
    readonly value: number
  ) {
    super(cls);
  }

  valueOf(): number {
    return this.value;
  }
}

const floatBits = new DataView(new ArrayBuffer(8));

export function boxFloat(value: number): number | RFloat {
  floatBits.setFloat64(0, value);
  const bits = floatBits.getBigUint64(0);
  const selector = Number((bits >> 60n) & 7n);
  if (bits === 0n || (bits !== 0x30_00_00_00_00_00_00_00n && (selector === 3 || selector === 4))) return value;
  return new RFloat(rt().c.Float, value);
}

export function isRubyFloat(value: Value): value is number | RFloat {
  return typeof value === 'number' || value instanceof RFloat;
}

export function isRubyNumber(value: Value): value is bigint | number | RFloat {
  return typeof value === 'bigint' || isRubyFloat(value);
}

export class RObject extends RBasic {
  turtle?: TurtleState;
  exception?: ExceptionState;
  /** The native state of an instance of a library class, such as a Random's generator. */
  data?: unknown;
}

export interface ExceptionState {
  message: Value;
  cause: Value;
  /** The rows of the calls in progress when the exception was raised, innermost first. */
  backtrace?: string[];
}

export class RString extends RBasic {
  /** Whether the string holds bytes rather than text (ASCII-8BIT), as `Integer#chr` makes for 128 to 255. */
  binary = false;
  usAscii = false;
  rawBytes?: Uint8Array;

  constructor(
    cls: RClass,
    public s: string
  ) {
    super(cls);
  }
}

export class RArray extends RBasic {
  version = 0;
  constructor(
    cls: RClass,
    public items: Value[]
  ) {
    super(cls);
    rt().chargeSlots(items.length);
  }
}

export interface HashEntry {
  key: Value;
  value: Value;
}

class TrackedHashMap extends Map<string, HashEntry> {
  version = 0;

  override set(key: string, value: HashEntry): this {
    super.set(key, value);
    this.version++;
    rt().containerVersion++;
    return this;
  }

  override delete(key: string): boolean {
    const removed = super.delete(key);
    if (removed) this.version++;
    if (removed) rt().containerVersion++;
    return removed;
  }

  override clear(): void {
    super.clear();
    this.version++;
    rt().containerVersion++;
  }
}

export class RHash extends RBasic {
  /** The entries by key in insertion order, keyed by {@link hashKeyOf} of their keys. */
  map = new TrackedHashMap();
  buckets = new Map<string, string[]>();
  bucketVersion = -1;
  defaultValue: Value = NIL;
  defaultProc?: RProc;
  /** How many iterations over the hash are in progress, during which adding a key is an error. */
  iterating = 0;
  /** Whether keys compare by identity, after `compare_by_identity`. */
  byIdentity = false;
  iterationError?: string;
}

export class RRange extends RBasic {
  constructor(
    cls: RClass,
    readonly begin: Value,
    readonly end: Value,
    readonly exclusive: boolean
  ) {
    super(cls);
    this.frozen = true;
  }
}

/** A block, proc, or lambda: the code of a block with the variables and `self` it closes over. */
export class RProc extends RBasic {
  isLambda = false;
  captured?: Value[];
  reflectedMethod?: RMethod;
  nativeRequired = 0;
  /** The call that received this block as its block literal, which a `break` in it leaves. */
  breakTag?: object;

  constructor(
    cls: RClass,
    readonly body: ProcBody,
    readonly self: Value,
    /** The frame the block was written in, whose method a `return` in the block leaves. */
    readonly outer: ProcOuter | undefined
  ) {
    super(cls);
  }
}

/** What a proc made from a block closes over, kept opaque here to avoid a cycle with the runtime. */
export interface ProcOuter {
  readonly scopeOwner: unknown;
}

export type ProcBody =
  | { kind: 'block'; def: BlockDef }
  | { kind: 'native'; arity: number; lambda: boolean; takesKeywords: boolean; call: NativeProc };

export type NativeProc = (
  args: Value[],
  block: RProc | undefined,
  used: boolean,
  keywords?: RHash
) => Value | Generator<unknown, Value, unknown>;

export type Visibility = 'public' | 'private' | 'protected';

export type NativeResult = Value | Generator<unknown, Value, unknown>;

/**
 * A method written in TypeScript: `self`, the positional arguments, the block, and the keyword arguments when the
 * method takes keywords (otherwise they arrive as a trailing Hash, as Ruby passes them to methods without keywords).
 */
export type NativeFn = ((
  // oxlint-disable-next-line typescript/no-explicit-any -- Each native method narrows self to its class's representation.
  self: any,
  args: Value[],
  block: RProc | undefined,
  keywords: RHash | undefined,
  used: boolean
) => NativeResult) & { nativeIdentity?: object };

export type MethodBody =
  | { kind: 'user'; def: MethodDef; cref: RClass[] }
  | { kind: 'native'; fn: NativeFn; min: number; max: number; takesKeywords: boolean }
  | { kind: 'reader'; ivar: string }
  | { kind: 'writer'; ivar: string }
  | { kind: 'proc'; proc: RProc }
  | { kind: 'visibility' }
  | { kind: 'undefined' };

export interface RMethod {
  name: string;
  row?: number;
  reflectionOwner?: RClass;
  nativeIdentityOwner?: RClass;
  nativeSignature?: NativeSignature;
  missing?: boolean;
  superName?: string;
  owner: RClass;
  visibility: Visibility;
  body: MethodBody;
  lookupOccurrence?: HierarchyEntry;
}

class MethodTable extends Map<string, RMethod> {
  override set(name: string, method: RMethod): this {
    internId(name);
    if (method.body.kind === 'reader' || method.body.kind === 'writer') internId(method.body.ivar);
    return super.set(name, method);
  }
}

export class RClass extends RBasic {
  readonly methods = new MethodTable();
  readonly constants = new Map<string, Value>();
  readonly constantRows = new Map<string, number>();
  readonly classVariables = new Map<string, Value>();
  /** The modules this module includes directly, the last included first. */
  readonly includes: RClass[] = [];
  readonly prepends: RClass[] = [];
  sharedSingletonOrigin?: RClass;
  /** The object a singleton class belongs to. */
  attached?: Value;
  /** The module whose constant first named this one, for names such as `Outer::Inner`. */
  lexicalParent?: RClass;
  nameString?: { text: string; value: RString };
  private hierarchyCache?: {
    version: number;
    list: RClass[];
    entries: HierarchyEntry[];
    positions: Map<HierarchyEntry, number>;
  };
  private methodCache?: { version: number; map: Map<string, RMethod | undefined> };
  /** Whether the program defined this class rather than the library, which decides what the trace shows. */
  isUserDefined = false;
  /** The kind of object `new` makes, which a subclass of a library class inherits. */
  instanceKind: 'object' | 'string' | 'array' | 'hash' | 'exception' | 'record' | 'none' = 'object';

  constructor(
    cls: RClass,
    public baseName: string | undefined,
    public superclass: RClass | undefined,
    readonly isModule: boolean,
    readonly isSingleton = false
  ) {
    super(cls);
    if (superclass) this.instanceKind = superclass.instanceKind;
    initializeHierarchy(this);
  }

  get name(): string | undefined {
    if (this.baseName === undefined) return undefined;
    const parent = this.lexicalParent;
    if (!parent || parent.isObjectClass) return this.baseName;
    const parentName = parent.name;
    return parentName ? `${parentName}::${this.baseName}` : undefined;
  }

  get isObjectClass(): boolean {
    return this.baseName === 'Object' && !this.lexicalParent && !this.isModule;
  }

  /** The classes and modules that method lookup visits, in order, as Ruby's `ancestors` lists them. */
  ancestors(): RClass[] {
    return this.hierarchy().list;
  }

  findMethod(name: string): RMethod | undefined {
    if (this.methodCache?.version !== hierarchyVersion.value) {
      this.methodCache = { version: hierarchyVersion.value, map: new Map() };
    }
    const cache = this.methodCache.map;
    if (cache.has(name)) return cache.get(name);
    const found = lookupMethod(name, this.hierarchy().entries);
    cache.set(name, found);
    return found;
  }

  findMethodFromOrigin(name: string): RMethod | undefined {
    return lookupMethod(name, hierarchyEntries(this, true));
  }

  findSuperMethod(name: string, owner: RClass, occurrence?: HierarchyEntry): RMethod | undefined {
    const { entries, positions } = this.hierarchy();
    let index = occurrence ? (positions.get(occurrence.origin ?? occurrence) ?? -1) : -1;
    if (index === -1) index = entries.findIndex((entry) => entry.value === owner && entry.table === owner.methods);
    for (let position = index + 1; position < entries.length; position++) {
      const entry = entries[position];
      const method = entry.table.get(name);
      if (method && method.body.kind !== 'visibility')
        return method.body.kind === 'undefined' ? undefined : locatedMethod(method, entry);
    }
    return undefined;
  }

  isSubclassOf(other: RClass): boolean {
    return this.ancestors().includes(other);
  }

  private hierarchy(): NonNullable<RClass['hierarchyCache']> {
    if (this.hierarchyCache?.version === hierarchyVersion.value) return this.hierarchyCache;
    const entries = [...hierarchyEntries(this)];
    const list: RClass[] = [];
    const positions = new Map<HierarchyEntry, number>();
    for (const [index, entry] of entries.entries()) {
      positions.set(entry, index);
      if (!entry.origin) list.push(entry.value);
    }
    this.hierarchyCache = { version: hierarchyVersion.value, entries, list, positions };
    return this.hierarchyCache;
  }
}

function lookupMethod(name: string, entries: Iterable<HierarchyEntry>): RMethod | undefined {
  let found: RMethod | undefined;
  let visibility: Visibility | undefined;
  for (const occurrence of entries) {
    const method = occurrence.table.get(name);
    if (method) {
      if (method.body.kind === 'visibility') visibility ??= method.visibility;
      else {
        found = method.body.kind === 'undefined' ? undefined : locatedMethod(method, occurrence, visibility);
        break;
      }
    }
  }
  return found;
}

function locatedMethod(method: RMethod, occurrence: HierarchyEntry, visibility = method.visibility): RMethod {
  return {
    ...method,
    lookupOccurrence: method.owner === occurrence.value ? occurrence : (method.lookupOccurrence ?? occurrence),
    visibility,
  };
}

/** Changes whenever a method, a module inclusion, or a class changes, which empties the lookup caches. */
export const hierarchyVersion = { value: 0 };

export function invalidateMethodCaches(): void {
  hierarchyVersion.value++;
}

export function isObject(value: Value): value is RBasic {
  return value instanceof RBasic;
}
