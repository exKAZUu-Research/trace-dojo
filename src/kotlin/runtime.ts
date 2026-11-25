import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { TurtleWorld } from '../interpreter/turtleWorld';
import { libraryClass } from './natives/registry';
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
  /**
   * For the local functions and classes the code calls or creates from a lambda or another function, the index in the
   * frame's captures of what their declaration made, keyed by the variable that holds it where they are declared.
   */
  localEnvs?: Map<unknown, number>;
}

/** What running the declaration of a local function or class makes: what its code captures, and the frame running it. */
export interface LocalEnv {
  captured: unknown[];
  declaring: Frame;
}

/**
 * What the declaration of a local function or class made, as the frame calling it sees it: what the caller's code
 * captured, as a lambda that outlives the declaring block does, or the slot of the declaring frame the caller runs in.
 */
export function localEnvOf(caller: Frame, key: unknown, declaringInfo: FunctionInfo, slot: number): LocalEnv {
  const index = caller.info.localEnvs?.get(key);
  if (index !== undefined) return caller.captured[index] as LocalEnv;
  for (let frame: Frame | undefined = caller; frame; frame = frame.enclosing) {
    if (frame.info === declaringInfo) return frame.locals[slot] as unknown as LocalEnv;
  }
  throw new Error('A local function or class was used outside the code that declares it');
}

export type Invoker = (caller: Frame, receiver: Value, args: Value[], callRow: number | undefined) => Value;

/** A coroutine's step: a generator that yields the values a sequence produces and returns the call's result. */
export type Suspension = Generator<Value, Value, undefined>;

export type SuspendInvoker = (caller: Frame, receiver: Value, args: Value[], callRow: number | undefined) => Suspension;

/**
 * A call of a suspend function or suspend function value whose arguments are evaluated, which the coroutine running
 * the caller performs, as only it can suspend.
 */
export class SuspendCall {
  constructor(readonly run: (caller: Frame) => Suspension) {}
}

const JVM_MAX_STRING_LENGTH = 2 ** 31 - 5;

export class Frame implements TracedFrame {
  readonly locals: Slot[];
  /** Values in use that no variable holds, such as evaluated arguments while the next one is evaluated. */
  readonly temporaries: Value[] = [];
  /** For a lambda's call, the frame that created the lambda, whose variables its steps also show. */
  enclosing: Frame | undefined;

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
  create(frame: Frame, qualifiedName: string, message: string | undefined, cause?: KObject): KObject;
}

export class Runtime implements TracedRuntime<Frame> {
  readonly world = new TurtleWorld();
  readonly steps = new StepTracker();
  readonly budget = new ExecutionBudget();
  readonly io: ProgramIO;
  readonly frames: Frame[] = [];
  /** The backing fields of top-level properties. */
  globals: Value[] = [];
  /** Object, companion, and library singleton instances, created when first used. */
  readonly objects = new Map<ClassSymbol, KObject>();
  /** The constants and shared entries list of each enum class, created with its first use. */
  readonly enumEntries = new Map<ClassSymbol, { values: KObject[]; entries?: KObject }>();
  /** Values that native code holds while it calls back into the program, such as a list being sorted. */
  readonly nativeRoots: (Value | readonly Value[])[] = [];
  /** Called when a frame returns or throws, with the frame still holding its locals. */
  onExit: ((frame: Frame) => void) | undefined;
  private allocated = 0;
  private readonly classInitialization = new Map<ClassSymbol, 'started' | 'done' | { failure: string }>();

  initializeClass(frame: Frame, cls: ClassSymbol, initialize: () => void): void {
    const previous = this.classInitialization.get(cls);
    if (previous === 'started' || previous === 'done') return;
    if (previous !== undefined) {
      const cause = this.exceptions.create(frame, 'java.lang.ExceptionInInitializerError', previous.failure);
      throw new KotlinThrow(
        this.exceptions.create(
          frame,
          'java.lang.NoClassDefFoundError',
          `Could not initialize class ${cls.qualifiedName}`,
          cause
        )
      );
    }
    this.classInitialization.set(cls, 'started');
    try {
      initialize();
      this.classInitialization.set(cls, 'done');
    } catch (error) {
      this.objects.delete(cls);
      if (cls.companion) this.objects.delete(cls.companion);
      this.enumEntries.delete(cls);
      if (!(error instanceof KotlinThrow)) {
        this.classInitialization.delete(cls);
        throw error;
      }
      const { value } = error;
      const message = value.native?.message;
      const description =
        typeof message === 'string' ? `${value.cls.qualifiedName}: ${message}` : value.cls.qualifiedName;
      this.classInitialization.set(cls, { failure: `Exception ${description} [in thread "main"]` });
      if (value.cls.isSubclassOf(libraryClass('kotlin.Error'))) throw error;
      throw new KotlinThrow(this.exceptions.create(frame, 'java.lang.ExceptionInInitializerError', undefined, value));
    }
  }

  constructor(
    readonly exceptions: ExceptionFactory,
    input?: ProgramInput
  ) {
    this.io = new ProgramIO(this.budget, input, 'jvm-utf8');
  }

  withNativeRoots<T>(roots: (Value | readonly Value[])[], evaluate: () => T): T {
    const previous = this.nativeRoots.length;
    this.nativeRoots.push(...roots);
    try {
      return evaluate();
    } finally {
      this.nativeRoots.length = previous;
    }
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  /** Counts slots that a program allocates, stopping it as the JVM stops when memory runs out. */
  allocate(frame: Frame, count: number): void {
    if (count > LIMITS.maxSlots - this.allocated) {
      throw new KotlinThrow(this.exceptions.create(frame, 'java.lang.OutOfMemoryError', 'Java heap space'));
    }
    this.allocated += count;
  }

  /** Charges for a string the program builds, which may not grow beyond the limit. */
  allocateString(frame: Frame, length: number, work = length): void {
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
    this.spend(1 + Math.floor(work / 64));
  }

  /** Rejects a string that a library function or a generated member built beyond the limit, after building it. */
  checkBuiltString<T extends Value>(frame: Frame, value: T): T {
    if (typeof value === 'string') this.checkStringLength(frame, value.length);
    return value;
  }

  /** Rejects a string length beyond the limit without charging for it, as a string grows before it is charged. */
  checkStringLength(frame: Frame, length: number): void {
    if (length > LIMITS.maxStringLength) this.allocateString(frame, length);
  }

  throwError(frame: Frame, qualifiedName: string, message?: string): never {
    throw new KotlinThrow(this.exceptions.create(frame, qualifiedName, message));
  }

  /** Runs a suspend function's body in a new frame as `call` does, suspending where the body's generator yields. */
  // code-gauge-allow functionParameterCount -- the same parts as `call`'s.
  // code-gauge-allow duplicateLines -- the copies compile the same Kotlin construct in different contexts, whose differences sit between the shared lines.
  *callSuspend(
    info: FunctionInfo,
    caller: Frame,
    captured: readonly unknown[],
    thisValue: Value,
    args: readonly Value[],
    callRow: number | undefined,
    body: (frame: Frame) => Suspension,
    enclosing?: Frame
  ): Suspension {
    this.spend();
    const frame = new Frame(this, info, captured, thisValue, info.isLibrary ? undefined : callRow);
    frame.enclosing = enclosing;
    if (this.frames.length >= LIMITS.maxCallDepth) this.throwError(caller, 'java.lang.StackOverflowError');
    for (const [index, arg] of args.entries()) frame.locals[index] = arg;
    this.frames.push(frame);
    try {
      return yield* body(frame);
    } catch (error) {
      if (error instanceof ReturnSignal && error.frame === frame) return error.value;
      throw error;
    } finally {
      this.onExit?.(frame);
      this.frames.splice(this.frames.lastIndexOf(frame), 1);
      if (info.isAtomic) this.steps.completeAtomicCall();
    }
  }

  /** Runs a function's body in a new frame, returning what it returns. */
  // code-gauge-allow functionParameterCount -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  // code-gauge-allow duplicateLines -- the copies compile the same Kotlin construct in different contexts, whose differences sit between the shared lines.
  call(
    info: FunctionInfo,
    caller: Frame | undefined,
    captured: readonly unknown[],
    thisValue: Value,
    args: readonly Value[],
    callRow: number | undefined,
    body: (frame: Frame) => Value,
    enclosing?: Frame
  ): Value {
    this.spend();
    const frame = new Frame(this, info, captured, thisValue, info.isLibrary ? undefined : callRow);
    frame.enclosing = enclosing;
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
  collectGarbage(): void {
    const reached = new Set<unknown>();
    const turtles = new Set<unknown>();
    const stack: unknown[] = [
      ...this.globals,
      ...this.objects.values(),
      ...this.enumEntries.values(),
      ...this.nativeRoots,
      ...this.frames,
    ];
    while (stack.length > 0) {
      const item = stack.pop();
      if (typeof item !== 'object' || item === null || reached.has(item)) continue;
      reached.add(item);
      if (item instanceof Frame) {
        enqueueObjects(stack, item.locals);
        enqueueObjects(stack, item.temporaries);
        enqueueObjects(stack, item.captured);
        stack.push(item.thisValue);
      } else if (item instanceof KObject) {
        if (item.turtle) turtles.add(item.turtle);
        enqueueObjectReferences(stack, item);
      } else if (item instanceof Cell) {
        stack.push(item.value);
      } else if (Array.isArray(item)) {
        enqueueObjects(stack, item);
      } else if (!(item instanceof Boxed)) {
        // Native state such as an iterator's source.
        enqueueObjects(stack, Object.values(item));
      }
    }
    this.world.retain((turtle) => turtles.has(turtle));
  }
}

function enqueueObjectReferences(stack: unknown[], object: KObject): void {
  enqueueObjects(stack, object.fields);
  if (object.env) enqueueObjects(stack, object.env);
  if (object.localFrames) enqueueObjects(stack, object.localFrames.values());
  if (object.items) enqueueObjects(stack, object.items);
  if (object.store) for (const entry of object.store.entries) stack.push(entry.key, entry.value);
  if (object.native) enqueueObjects(stack, Object.values(object.native));
}

function enqueueObjects(stack: unknown[], values: Iterable<unknown>): void {
  for (const value of values) if (typeof value === 'object' && value !== null) stack.push(value);
}

/** The value of a property's backing field in an instance. */
export function fieldOf(instance: Value, property: PropertySymbol): Value {
  return (instance as KObject).fields[property.slot as number];
}
