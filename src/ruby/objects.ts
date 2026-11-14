import type { TurtleState } from '../interpreter/turtleWorld';
import type { BlockDef, MethodDef } from './ast';
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
  private constructor(readonly name: string) {}

  static of(name: string): RSymbol {
    const symbols = rt().symbols;
    let symbol = symbols.get(name);
    if (!symbol) {
      symbol = new RSymbol(name);
      symbols.set(name, symbol);
    }
    return symbol;
  }
}

let nextObjectId = 8;

/** An object with an identity, a class, and instance variables. */
export abstract class RBasic {
  frozen = false;
  readonly id = (nextObjectId += 8);
  ivars?: Map<string, Value>;
  /** The singleton class, created when the program defines a method on this object alone. */
  singleton?: RClass;

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
  | { kind: 'native'; arity: number; lambda: boolean; call: NativeProc };

export type NativeProc = (
  args: Value[],
  block: RProc | undefined,
  used: boolean
) => Value | Generator<unknown, Value, unknown>;

export type Visibility = 'public' | 'private' | 'protected';

export type NativeResult = Value | Generator<unknown, Value, unknown>;

/**
 * A method written in TypeScript: `self`, the positional arguments, the block, and the keyword arguments when the
 * method takes keywords (otherwise they arrive as a trailing Hash, as Ruby passes them to methods without keywords).
 */
export type NativeFn = (
  // oxlint-disable-next-line typescript/no-explicit-any -- Each native method narrows self to its class's representation.
  self: any,
  args: Value[],
  block: RProc | undefined,
  keywords: RHash | undefined
) => NativeResult;

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
  owner: RClass;
  visibility: Visibility;
  body: MethodBody;
  lookupIndex?: number;
}

/** A class or module. */
export class RClass extends RBasic {
  readonly methods = new Map<string, RMethod>();
  readonly constants = new Map<string, Value>();
  readonly classVariables = new Map<string, Value>();
  /** The modules this module includes directly, the last included first. */
  readonly includes: RClass[] = [];
  readonly prepends: RClass[] = [];
  /** The object a singleton class belongs to. */
  attached?: Value;
  /** The module whose constant first named this one, for names such as `Outer::Inner`. */
  lexicalParent?: RClass;
  nameString?: { text: string; value: RString };
  private ancestorCache?: { version: number; list: RClass[] };
  private methodCache?: { version: number; map: Map<string, RMethod | undefined> };
  /** Whether the program defined this class rather than the library, which decides what the trace shows. */
  isUserDefined = false;
  /** The kind of object `new` makes, which a subclass of a library class inherits. */
  instanceKind: 'object' | 'string' | 'array' | 'hash' | 'exception' | 'none' = 'object';

  constructor(
    cls: RClass,
    public baseName: string | undefined,
    public superclass: RClass | undefined,
    readonly isModule: boolean,
    readonly isSingleton = false
  ) {
    super(cls);
    if (superclass) this.instanceKind = superclass.instanceKind;
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
    if (this.ancestorCache?.version === hierarchyVersion.value) return this.ancestorCache.list;
    const list: RClass[] = [];
    const seen = new Set<RClass>();
    const seenPrepended = new Set<RClass>();
    const active = new Set<RClass>();
    const superAncestors = this.superclass ? this.superclass.ancestors() : [];
    const inSuper = new Set(superAncestors);
    const mergedPrepends = (modules: RClass[], inherited = new Set<RClass>()): RClass[] => {
      const chains = modules.map((module) => prependChain(module, new Set(inherited)));
      const prerequisites = new Map<RClass, Set<RClass>>();
      const ranks = new Map<RClass, number>();
      const addEdge = (before: RClass, after: RClass): void => {
        if (before !== after) prerequisites.get(after)?.add(before);
      };
      for (const chain of chains) {
        for (const [index, item] of chain.entries()) {
          if (!prerequisites.has(item)) {
            prerequisites.set(item, new Set());
            ranks.set(item, ranks.size);
          }
          if (index > 0) addEdge(chain[index - 1], item);
        }
      }
      const directRoots = modules.filter((module, position) =>
        chains.every((chain, index) => index === position || chain.indexOf(module) <= chain.indexOf(modules[index]))
      );
      for (let index = 1; index < directRoots.length; index++) addEdge(directRoots[index - 1], directRoots[index]);
      const result: RClass[] = [];
      const emitted = new Set<RClass>();
      while (emitted.size < prerequisites.size) {
        const ready = [...prerequisites].filter(
          ([item, before]) => !emitted.has(item) && [...before].every((prior) => emitted.has(prior))
        );
        const unblocked = ready.filter(([item]) =>
          chains.every((chain, index) => {
            const root = modules[index];
            return emitted.has(root) || chain.indexOf(item) <= chain.indexOf(root) || !chain.includes(item);
          })
        );
        const candidates =
          unblocked.length > 0
            ? unblocked
            : ready.length > 0
              ? ready
              : [...prerequisites].filter(([item]) => !emitted.has(item));
        const choice = candidates.toSorted(
          ([left], [right]) => (ranks.get(left) ?? 0) - (ranks.get(right) ?? 0)
        )[0]?.[0];
        if (!choice) throw new Error('Missing prepend ancestor');
        emitted.add(choice);
        result.push(choice);
      }
      return result;
    };
    const prependChain = (module: RClass, visited: Set<RClass>): RClass[] => {
      if (visited.has(module)) return [];
      visited.add(module);
      const prepended = mergedPrepends(module.prepends, visited);
      for (const item of prepended) visited.add(item);
      return [...prepended, module, ...module.includes.flatMap((item) => prependChain(item, visited))];
    };
    const addModule = (module: RClass, placement: 'prepend' | 'body' = 'body'): void => {
      const visited = placement === 'prepend' ? seenPrepended : seen;
      if (visited.has(module) || active.has(module) || (placement !== 'prepend' && inSuper.has(module))) return;
      visited.add(module);
      active.add(module);
      rt().spend();
      for (const prepended of mergedPrepends(module.prepends))
        if (!seenPrepended.has(prepended) && !active.has(prepended)) {
          seenPrepended.add(prepended);
          rt().spend();
          list.push(prepended);
        }
      list.push(module);
      for (const included of module.includes) addModule(included, placement);
      active.delete(module);
    };
    addModule(this);
    for (const ancestor of superAncestors) list.push(ancestor);
    this.ancestorCache = { version: hierarchyVersion.value, list };
    return list;
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- Method lookup resolves visibility markers against the current ancestor body.
  findMethod(name: string): RMethod | undefined {
    if (this.methodCache?.version !== hierarchyVersion.value) {
      this.methodCache = { version: hierarchyVersion.value, map: new Map() };
    }
    const cache = this.methodCache.map;
    if (cache.has(name)) return cache.get(name);
    let found: RMethod | undefined;
    let visibility: Visibility | undefined;
    for (const [index, module] of this.ancestors().entries()) {
      const method = module.methods.get(name);
      if (method) {
        if (method.body.kind === 'visibility') visibility ??= method.visibility;
        else {
          found =
            method.body.kind === 'undefined'
              ? undefined
              : { ...method, lookupIndex: index, visibility: visibility ?? method.visibility };
          break;
        }
      }
    }
    cache.set(name, found);
    return found;
  }

  /** The method after `owner`'s in this class's ancestors, which `super` calls. */
  findSuperMethod(name: string, owner: RClass, lookupIndex?: number): RMethod | undefined {
    const ancestors = this.ancestors();
    const index =
      lookupIndex !== undefined && ancestors[lookupIndex] === owner ? lookupIndex : ancestors.indexOf(owner);
    for (let position = index + 1; position < ancestors.length; position++) {
      const module = ancestors[position];
      const method = module.methods.get(name);
      if (method && method.body.kind !== 'visibility')
        return method.body.kind === 'undefined' ? undefined : { ...method, lookupIndex: position };
    }
    return undefined;
  }

  isSubclassOf(other: RClass): boolean {
    return this.ancestors().includes(other);
  }
}

/** Changes whenever a method, a module inclusion, or a class changes, which empties the lookup caches. */
export const hierarchyVersion = { value: 0 };

export function invalidateMethodCaches(): void {
  hierarchyVersion.value++;
}

export function isObject(value: Value): value is RBasic {
  return value instanceof RBasic;
}
