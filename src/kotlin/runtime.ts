import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { TurtleWorld } from '../interpreter/turtleWorld';
import type { ClassSymbol, PropertySymbol } from './symbols';
import type { KType } from './types';
import { Boxed, Cell, KObject, type Value } from './values';

/** Stands for an argument that a call leaves out, whose parameter's default value the callee computes. */
export const MISSING = Symbol('missing') as unknown as Value;

/** Marks a local whose scope has not begun or has ended. */
export const UNASSIGNED: unique symbol = Symbol('unassigned');
export type Slot = Value | Cell | typeof UNASSIGNED;

/** A local variable as the trace shows it. */
export interface LocalInfo {
  name: string;
  slot: number;
  type: KType;
}

/** What the runtime and the trace need to know about a compiled function or lambda. */
export interface FunctionInfo {
  name: string;
  locals: LocalInfo[];
  /** The variables of enclosing functions that a lambda reads, by their index in its frame's captures. */
  captures: LocalInfo[];
  slotCount: number;
  isAtomic: boolean;
  /** Whether the function belongs to the standard library, whose variables no trace shows. */
  isLibrary: boolean;
  /** Whether the frame is a lambda's, which also shows the variables of the functions around it. */
  isLambda: boolean;
  /** Whether `this` is an instance of a class of the program, whose properties the trace shows as `this.x`. */
  showsThis: boolean;
}

export type Invoker = (caller: Frame, receiver: Value, args: Value[], callRow: number | undefined) => Value;

const JVM_MAX_STRING_LENGTH = 2 ** 31 - 5;

export class Frame implements TracedFrame {
  readonly locals: Slot[];
  /** Values in use that no variable holds, such as evaluated arguments while the next one is evaluated. */
  readonly temporaries: Value[] = [];

  constructor(
    readonly runtime: Runtime,
    readonly info: FunctionInfo,
    /**
     * What a lambda captured when it was created: the values of the variables of enclosing functions it reads (the
     * cells of those it may assign), their receivers, and the frames its `return` leaves.
     */
    readonly captured: readonly unknown[],
    readonly thisValue: Value,
    readonly callRow: number | undefined
  ) {
    this.locals = Array.from({ length: info.slotCount }, () => UNASSIGNED);
  }
}

/** A Kotlin exception in flight. */
export class KotlinThrow extends Error {
  constructor(readonly value: KObject) {
    super('Kotlin exception');
  }
}

/** `return` from the function whose frame is `frame`, which may come from a lambda inside it. */
export class ReturnSignal {
  constructor(
    readonly frame: Frame,
    readonly value: Value
  ) {}
}

/** `break` and `continue` of the loop with the identity `loop`, thrown so that they work inside expressions. */
export class LoopSignal {
  constructor(
    readonly loop: object,
    readonly isBreak: boolean
  ) {}
}

/** `exitProcess`, which ends the program without an error. */
export class ProgramExit {
  constructor(readonly status: number) {}
}

/** What the runtime needs from the standard library to raise its exceptions. */
export interface ExceptionFactory {
  create(frame: Frame, qualifiedName: string, message: string | undefined): KObject;
}

export class Runtime implements TracedRuntime<Frame> {
  readonly world = new TurtleWorld();
  readonly steps = new StepTracker();
  readonly budget = new ExecutionBudget();
  readonly io: ProgramIO;
  readonly frames: Frame[] = [];
  /** The backing fields of top-level properties. */
  globals: Value[] = [];
  /** The instances of objects and companion objects, created when first used. */
  readonly objects = new Map<ClassSymbol, KObject>();
  /** The constants of each enum class, created with its first use. */
  readonly enumEntries = new Map<ClassSymbol, KObject[]>();
  /** Values that native code holds while it calls back into the program, such as a list being sorted. */
  readonly nativeRoots: Value[] = [];
  /** Called when a frame returns or throws, with the frame still holding its locals. */
  onExit: ((frame: Frame) => void) | undefined;
  private allocated = 0;

  constructor(
    readonly exceptions: ExceptionFactory,
    input?: ProgramInput
  ) {
    this.io = new ProgramIO(this.budget, input);
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  /** Counts slots that a program allocates, stopping it as the JVM stops when memory runs out. */
  allocate(frame: Frame, count: number): void {
    this.allocated += count;
    if (this.allocated > LIMITS.maxSlots || count > LIMITS.maxSlots) {
      throw new KotlinThrow(this.exceptions.create(frame, 'java.lang.OutOfMemoryError', 'Java heap space'));
    }
  }

  /** Charges for a string the program builds, which may not grow beyond the limit. */
  allocateString(frame: Frame, length: number): void {
    // The JVM refuses so long an array of a string's characters before it looks for memory, measured with kotlinc's
    // `"a".repeat(Int.MAX_VALUE - 3)`, `StringBuilder(Int.MAX_VALUE)`, and `padStart(Int.MAX_VALUE)`.
    if (length > JVM_MAX_STRING_LENGTH) {
      throw new KotlinThrow(
        this.exceptions.create(frame, 'java.lang.OutOfMemoryError', 'Requested array size exceeds VM limit')
      );
    }
    if (length > LIMITS.maxStringLength) {
      throw new KotlinThrow(this.exceptions.create(frame, 'java.lang.OutOfMemoryError', 'Java heap space'));
    }
    this.spend(1 + Math.floor(length / 64));
  }

  throwError(frame: Frame, qualifiedName: string, message?: string): never {
    throw new KotlinThrow(this.exceptions.create(frame, qualifiedName, message));
  }

  /** Runs a function's body in a new frame, returning what it returns. */
  // code-gauge-allow functionParameterCount 7 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  call(
    info: FunctionInfo,
    caller: Frame | undefined,
    captured: readonly unknown[],
    thisValue: Value,
    args: readonly Value[],
    callRow: number | undefined,
    body: (frame: Frame) => Value
  ): Value {
    this.spend();
    const frame = new Frame(this, info, captured, thisValue, callRow);
    if (this.frames.length >= LIMITS.maxCallDepth) {
      this.throwError(caller ?? frame, 'java.lang.StackOverflowError');
    }
    for (const [index, arg] of args.entries()) frame.locals[index] = arg;
    this.frames.push(frame);
    try {
      return body(frame);
    } catch (error) {
      if (error instanceof ReturnSignal && error.frame === frame) return error.value;
      throw error;
    } finally {
      this.onExit?.(frame);
      this.frames.pop();
      if (info.isAtomic) this.steps.completeAtomicCall();
    }
  }

  /** Removes the turtles that the program can no longer reach. */
  // code-gauge-allow functionNcss 35 -- one pass over the reachable values, which splitting would make walk them twice.
  // code-gauge-allow functionCognitiveComplexity 27 -- one pass over the reachable values, which splitting would make walk them twice.
  collectGarbage(): void {
    const reached = new Set<unknown>();
    const turtles = new Set<unknown>();
    const stack: unknown[] = [
      ...this.globals,
      ...this.objects.values(),
      ...this.enumEntries.values(),
      ...this.nativeRoots,
    ];
    for (const frame of this.frames) stack.push(frame);
    while (stack.length > 0) {
      const item = stack.pop();
      if (typeof item !== 'object' || item === null || reached.has(item)) continue;
      reached.add(item);
      if (item instanceof Frame) {
        stack.push(...item.locals, ...item.temporaries, item.thisValue, ...item.captured);
      } else if (item instanceof KObject) {
        if (item.turtle) turtles.add(item.turtle);
        stack.push(...item.fields, ...(item.env ?? []));
        if (item.items) stack.push(...item.items);
        if (item.store) for (const entry of item.store.entries) stack.push(entry.key, entry.value);
        if (item.native) stack.push(...Object.values(item.native));
      } else if (item instanceof Cell) {
        stack.push(item.value);
      } else if (Array.isArray(item)) {
        stack.push(...(item as unknown[]));
      } else if (!(item instanceof Boxed)) {
        // Native state such as an iterator's source.
        stack.push(...Object.values(item));
      }
    }
    this.world.retain((turtle) => turtles.has(turtle));
  }
}

/** The value of a property's backing field in an instance. */
export function fieldOf(instance: Value, property: PropertySymbol): Value {
  return (instance as KObject).fields[property.slot as number];
}
