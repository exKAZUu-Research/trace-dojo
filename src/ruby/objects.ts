import type { TurtleState } from '../interpreter/turtleWorld';
import type { BlockDef, MethodDef } from './ast';

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
  private static readonly table = new Map<string, RSymbol>();

  private constructor(readonly name: string) {}

  static of(name: string): RSymbol {
    let symbol = RSymbol.table.get(name);
    if (!symbol) {
      symbol = new RSymbol(name);
      RSymbol.table.set(name, symbol);
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
  constructor(
    cls: RClass,
    public s: string
  ) {
    super(cls);
  }
}

export class RArray extends RBasic {
  constructor(
    cls: RClass,
    public items: Value[]
  ) {
    super(cls);
  }
}

export interface HashEntry {
  key: Value;
  value: Value;
}

export class RHash extends RBasic {
  /** The entries by key in insertion order, keyed by {@link hashKeyOf} of their keys. */
  map = new Map<string, HashEntry>();
  defaultValue: Value = NIL;
  defaultProc?: RProc;
  /** How many iterations over the hash are in progress, during which adding a key is an error. */
  iterating = 0;
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

export type NativeProc = (args: Value[], block: RProc | undefined) => Value | Generator<unknown, Value, unknown>;

export type Visibility = 'public' | 'private' | 'protected';

export type NativeResult = Value | Generator<unknown, Value, unknown>;

/**
 * A method written in TypeScript: `self`, the positional arguments, the block, and the keyword arguments when the
 * method takes keywords (otherwise they arrive as a trailing Hash, as Ruby passes them to methods without keywords).
 */
export type NativeFn = (
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
  | { kind: 'undefined' };

export interface RMethod {
  name: string;
  owner: RClass;
  visibility: Visibility;
  body: MethodBody;
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
    const superAncestors = this.superclass ? this.superclass.ancestors() : [];
    const inSuper = new Set(superAncestors);
    const addModule = (module: RClass): void => {
      for (const prepended of module.prepends) addModule(prepended);
      if (!seen.has(module) && !inSuper.has(module)) {
        seen.add(module);
        list.push(module);
      }
      for (const included of module.includes) addModule(included);
    };
    addModule(this);
    list.push(...superAncestors);
    this.ancestorCache = { version: hierarchyVersion.value, list };
    return list;
  }

  findMethod(name: string): RMethod | undefined {
    if (this.methodCache?.version !== hierarchyVersion.value) {
      this.methodCache = { version: hierarchyVersion.value, map: new Map() };
    }
    const cache = this.methodCache.map;
    if (cache.has(name)) return cache.get(name);
    let found: RMethod | undefined;
    for (const module of this.ancestors()) {
      const method = module.methods.get(name);
      if (method) {
        found = method.body.kind === 'undefined' ? undefined : method;
        break;
      }
    }
    cache.set(name, found);
    return found;
  }

  /** The method after `owner`'s in this class's ancestors, which `super` calls. */
  findSuperMethod(name: string, owner: RClass): RMethod | undefined {
    const ancestors = this.ancestors();
    const index = ancestors.indexOf(owner);
    for (const module of ancestors.slice(index + 1)) {
      const method = module.methods.get(name);
      if (method) return method.body.kind === 'undefined' ? undefined : method;
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
