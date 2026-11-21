import type { TurtleState } from '../interpreter/turtleWorld';
import type { ClassInfo } from './classes';
import type { Runtime } from './runtime';
import type { DartType, FunctionType } from './types';

/**
 * A Dart value: `undefined` is `null`, a bigint is an `int` (always within 64 bits), a number is a `double`, a
 * string is a `String`, a boolean is a `bool`, and everything else is an object.
 */
export type Value = undefined | boolean | bigint | number | string | DartObject;

/** The arguments of a call, already evaluated. */
export interface Arguments {
  positional: Value[];
  named: ReadonlyMap<string, Value> | undefined;
  /** The route of a call whose arguments need runtime checks. */
  invocation?: 'dynamic' | 'apply';
}

export const NO_ARGUMENTS: Arguments = { positional: [], named: undefined };

/**
 * Runs a function or method: `receiver` is `this` (undefined for functions), `typeArgs` the function's own type
 * arguments, and `callRow` the row of the call in the program, which traces show.
 */
export type Callable = (
  runtime: Runtime,
  receiver: Value,
  args: Arguments,
  typeArgs: readonly DartType[],
  callRow: number | undefined
) => Value;

/** A variable, which closures share by reference. */
export class Cell {
  constructor(public v: Value) {}
}

let nextIdentity = 1;

export class DartObject {
  readonly identity = nextIdentity++;
  /** A turtle's state, for instances of `Turtle`. */
  turtle: TurtleState | undefined;
  /** The state natives keep for instances of library classes such as `StringBuffer` or `Random`. */
  native: NativeState | undefined;

  constructor(
    public cls: ClassInfo,
    /** The class's type arguments, which Dart keeps at runtime. */
    public typeArgs: readonly DartType[],
    readonly fields: Value[]
  ) {}
}

/** State that natives keep, which garbage collection walks through `values`. */
export interface NativeState {
  values(): Iterable<Value>;
  roots?(): Iterable<Value>;
  [key: string]: unknown;
}

export class DartList extends DartObject {
  constructor(
    cls: ClassInfo,
    elementType: DartType,
    public elements: Value[],
    public readonly growable: boolean,
    public readonly unmodifiable = false
  ) {
    super(cls, [elementType], []);
  }

  get length(): number {
    return this.elements.length;
  }

  entries(): IterableIterator<[number, Value]> {
    return this.elements.entries();
  }
}

export class DartPackedList extends DartObject {
  constructor(
    cls: ClassInfo,
    readonly contents: string | Uint8Array
  ) {
    super(cls, [], []);
  }

  get length(): number {
    return this.contents.length;
  }

  at(index: number): bigint {
    const { contents } = this;
    // oxlint-disable-next-line unicorn/prefer-code-point -- A code-unit list exposes both halves of a surrogate pair.
    return BigInt(typeof contents === 'string' ? contents.charCodeAt(index) : contents[index]);
  }

  *entries(): IterableIterator<[number, bigint]> {
    for (let index = 0; index < this.length; index++) yield [index, this.at(index)];
  }
}

export class DartRecord extends DartObject {
  constructor(
    cls: ClassInfo,
    readonly positional: Value[],
    /** Sorted by name, as the record's shape is. */
    readonly named: [string, Value][],
    readonly shape: bigint
  ) {
    super(cls, [], []);
  }

  field(name: string): [string, Value] | undefined {
    const index = recordPositionalIndex(name);
    if (index !== undefined && index < this.positional.length) return [name, this.positional[index]];
    return this.named.find(([field]) => field === name);
  }
}

export function recordPositionalIndex(name: string): number | undefined {
  const position = /^\$([1-9]\d*)$/.exec(name);
  return position ? Number(position[1]) - 1 : undefined;
}

export class DartClosure extends DartObject {
  dynamicTypeArgumentDefaults?: readonly DartType[];

  // code-gauge-allow functionParameterCount 7 -- The parameters are the parts a caller already holds; grouping them would only rename them.
  constructor(
    cls: ClassInfo,
    readonly type: FunctionType,
    readonly call: Callable,
    /** The bound receiver of a method tear-off, or undefined. */
    readonly receiver: Value,
    /** The variables the closure captured, which garbage collection follows. */
    readonly captured: readonly Cell[],
    /** What `toString` describes: the function's name and, for a tear-off, where it comes from. */
    readonly description: ClosureDescription,
    /** Equal tear-offs (`a.m == a.m`) compare by this key. */
    readonly tearOffKey: object | undefined
  ) {
    super(cls, [], []);
  }
}

export interface ClosureDescription {
  name: string | undefined;
  /** The name errors about the closure's calls give it, as `main.<anonymous closure>`. */
  qualifiedName?: string;
  /** `Function 'main': static.` and similar, which `toString` appends. */
  origin: string | undefined;
}

export class DartTypeValue extends DartObject {
  constructor(
    cls: ClassInfo,
    readonly type: DartType
  ) {
    super(cls, [], []);
  }
}

/** The marker of a `late` variable or field that has not been assigned yet. */
export const UNINITIALIZED = Symbol('uninitialized') as unknown as Value;

/** The marker of a local declared without an initializer, which reads as null but traces leave out until assigned. */
export const UNASSIGNED = Symbol('unassigned') as unknown as Value;

/** A `late` local's initializer, which runs the first time the local is read. */
export class LateInitializer {
  constructor(
    readonly closure: DartClosure,
    readonly isFinal: boolean
  ) {}
}
