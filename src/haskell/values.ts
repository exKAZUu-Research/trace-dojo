import type { TurtleState } from '../interpreter/turtleWorld';
import type { Core, FunctionInfo, IODoCore, LamCore } from './core';
import type { DisplayTypeScope, TypeHint, TypeHintRef } from './displayTypeHints';
import type { ConInfo, InstanceInfo } from './entities';
import type { RunNext, TailCall } from './machine';
import type { Primitive } from './primitives';

/**
 * A value in weak head normal form: an integer (`Int` and `Integer` as bigints), a floating-point number, a
 * character (one code point), a constructor application, a function, an `IO` action, a class dictionary, or a turtle.
 */
export type Value = bigint | number | string | ConValue | FunValue | IOAction | Dict | TurtleValue;

export type Slot = Value | Thunk | TypedSlot;

export class TypedSlot {
  constructor(
    readonly slot: Slot,
    readonly type: TypeHint
  ) {}
}

export function untypedSlot(slot: Slot): Value | Thunk {
  while (slot instanceof TypedSlot) slot = slot.slot;
  return slot;
}

export class Env {
  displayScope: DisplayTypeScope | undefined;
  readonly slots: (Slot | undefined)[];

  constructor(
    size: number,
    readonly parent: Env | undefined,
    /** Set for the frame of a named function's call, which a trace shows as a frame. */
    readonly info?: FunctionInfo
  ) {
    this.slots = Array.from<Slot | undefined>({ length: size });
    this.displayScope = parent?.displayScope;
  }

  at(depth: number): Env {
    return depth === 0 ? this : (this.parent as Env).at(depth - 1);
  }

  /** The frame of the named function's call that this environment belongs to, if any. */
  invocation(): Env | undefined {
    return this.info ? this : this.parent?.invocation();
  }
}

export class ConValue {
  constructor(
    readonly con: ConInfo,
    readonly fields: Slot[]
  ) {}
}

export class Closure {
  constructor(
    readonly lam: LamCore,
    readonly env: Env | undefined,
    readonly atomicScope?: FunctionInfo
  ) {}

  get arity(): number {
    return this.lam.arity;
  }
}

export class PrimFn {
  constructor(
    readonly prim: Primitive,
    readonly info?: FunctionInfo,
    readonly atomicScope?: FunctionInfo
  ) {}

  get arity(): number {
    return this.prim.arity;
  }
}

/** A function applied to fewer arguments than it takes. */
export class Partial {
  constructor(
    readonly fn: Closure | PrimFn,
    readonly args: Slot[]
  ) {}

  get arity(): number {
    return this.fn.arity - this.args.length;
  }
}

export type FunValue = Closure | PrimFn | Partial;

export type ThunkState = 'pending' | 'evaluating' | 'done';

export class Thunk {
  displayType: TypeHintRef | undefined;
  state: ThunkState = 'pending';
  value: Value | undefined;
  /** Another thunk whose value this one takes, set when the evaluator drops this thunk's update frame. */
  target: Thunk | undefined;

  constructor(
    public code: Core | undefined,
    public env: Env | undefined,
    /** Computes the value natively, for thunks the evaluator builds itself (such as a string's rest). */
    public native?: () => Slot | TailCall
  ) {
    this.displayType = code?.displayType ? { tag: 'hint', value: code.displayType } : undefined;
  }

  /** Stores the computed value, dropping what computed it. */
  update(value: Value): void {
    this.state = 'done';
    this.value = value;
    this.code = undefined;
    this.env = undefined;
    this.native = undefined;
    this.target = undefined;
  }

  /** Makes this thunk take another thunk's value instead of computing its own. */
  redirect(target: Thunk): void {
    this.state = 'pending';
    this.code = undefined;
    this.env = undefined;
    this.native = undefined;
    this.target = target;
  }

  static of(value: Value): Thunk {
    const thunk = new Thunk(undefined, undefined);
    thunk.state = 'done';
    thunk.value = value;
    return thunk;
  }
}

/** An `IO` action, which only running it performs. */
export type IOAction = IOReturn | IOBind | IOThen | IOPrim | IODo | IOCall;

export class IOReturn {
  constructor(readonly value: Slot) {}
}

export class IOBind {
  constructor(
    readonly action: Slot,
    readonly next: Slot
  ) {}
}

export class IOThen {
  constructor(
    readonly action: Slot,
    readonly next: Slot
  ) {}
}

/** A primitive action, which performs its effect and returns its result, or another action to run in its place. */
export class IOPrim {
  constructor(
    readonly name: string,
    readonly run: () => Slot | RunNext,
    /** The slots the action uses, which keep the turtles they reach alive. */
    readonly refs: Slot[] = []
  ) {}
}

export interface PreparedBlock {
  env: Env;
  actions: Map<number, Slot>;
  end: number;
}

/** A `do` block in `IO`, which runs its statements one by one, recording a step after each when tracing. */
export class IODo {
  prepared: PreparedBlock | undefined;

  constructor(
    readonly code: IODoCore,
    readonly env: Env
  ) {}
}

export class IOCall {
  constructor(
    readonly action: Slot,
    readonly invocation: Env
  ) {}
}

export class Dict {
  constructor(
    readonly instance: InstanceInfo,
    readonly methods: Slot[],
    readonly supers: Slot[],
    /** The dictionaries of the instance's context, which its methods and superclasses take. */
    readonly args: Slot[]
  ) {}
}

export class TurtleValue {
  constructor(readonly turtle: TurtleState) {}
}

export function isIOAction(value: Slot): value is IOAction {
  return (
    value instanceof IOReturn ||
    value instanceof IOBind ||
    value instanceof IOThen ||
    value instanceof IOPrim ||
    value instanceof IODo ||
    value instanceof IOCall
  );
}

export function isFunction(value: Value): value is FunValue {
  return value instanceof Closure || value instanceof PrimFn || value instanceof Partial;
}

/** An exception a program raises, carrying the Haskell value that describes it. */
export class HaskellException extends Error {
  constructor(
    /** The message `displayException` gives, which an uncaught exception reports. */
    readonly display: string,
    /** The kind of exception, for `Control.Exception`-style matching. */
    readonly kind: 'ErrorCall' | 'ArithException' | 'PatternMatchFail' | 'IOException' | 'Other'
  ) {
    super(display);
    this.name = 'HaskellException';
  }
}
