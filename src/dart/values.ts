import type { TurtleState } from '../interpreter/turtleWorld';
import type { ClassInfo } from './classes';
import type { Runtime } from './runtime';
import type { DartType, FunctionType, InterfaceType } from './types';

/**
 * A Dart value: `undefined` is `null`, a bigint is an `int` (always within 64 bits), a number is a `double`, a
 * string is a `String`, a boolean is a `bool`, and everything else is an object.
 */
export type Value = undefined | boolean | bigint | number | string | DartObject;

/** The arguments of a call, already evaluated. */
export interface Arguments {
  positional: Value[];
  named: ReadonlyMap<string, Value> | undefined;
  /** Set when the call site did not check the arguments statically, so that the callee checks them. */
  isDynamic?: boolean;
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
  [key: string]: unknown;
}

export class DartList extends DartObject {
  /** Bumped by every change of length, which iterators check to detect concurrent modification. */
  modifications = 0;
  /** The type the VM's own list class for this list shows, as `CodeUnits` for `'ab'.codeUnits`. */
  vmType: InterfaceType | undefined;

  constructor(
    cls: ClassInfo,
    elementType: DartType,
    public elements: Value[],
    public readonly growable: boolean,
    public readonly unmodifiable = false
  ) {
    super(cls, [elementType], []);
  }
}

export class DartRecord extends DartObject {
  constructor(
    cls: ClassInfo,
    readonly positional: Value[],
    /** Sorted by name, as the record's shape is. */
    readonly named: [string, Value][]
  ) {
    super(cls, [], []);
  }

  field(name: string): [string, Value] | undefined {
    const position = /^\$([1-9]\d*)$/.exec(name);
    if (!position) return this.named.find(([field]) => field === name);
    const index = Number(position[1]) - 1;
    return index < this.positional.length ? [name, this.positional[index]] : undefined;
  }
}

export class DartClosure extends DartObject {
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
    readonly tearOffKey: unknown
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
  constructor(readonly run: () => Value) {}
}
