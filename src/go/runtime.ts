// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt reads as raw bytes.
import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { TurtleWorld } from '../interpreter/turtleWorld';
import type { Hoist, Part } from './compilerBase';
import type { Type } from './types';
import {
  Cell,
  Channel,
  copyValue,
  GoArray,
  GoFunc,
  GoMap,
  GoStruct,
  Iface,
  Pointer,
  Slice,
  type Value,
  writeInPlace,
} from './values';

/** What a statement does next, when it does not simply complete. */
export type Completion =
  | { kind: 'break'; label?: string }
  | { kind: 'continue'; label?: string }
  | { kind: 'return' }
  | { kind: 'fallthrough' }
  | { kind: 'goto'; label: string };

/** Whether a completion breaks out of the statement with the label, or the innermost one when it has none. */
export function breaks(completion: Completion | void, label: string | undefined): boolean {
  return completion?.kind === 'break' && (completion.label === undefined || completion.label === label);
}

/** Whether a completion continues the loop with the label, or the innermost one when it has none. */
export function continues(completion: Completion | void, label: string | undefined): boolean {
  return completion?.kind === 'continue' && (completion.label === undefined || completion.label === label);
}

export const BREAK: Completion = { kind: 'break' };
export const CONTINUE: Completion = { kind: 'continue' };
export const RETURN: Completion = { kind: 'return' };
export const FALLTHROUGH: Completion = { kind: 'fallthrough' };

export type Eval = (frame: Frame) => Value;
/** Evaluates a list of values, such as the arguments of a call or the results of one with several. */
export type ListEval = (frame: Frame) => Value[];
/**
 * Runs statements as a generator, which yields when its goroutine blocks (on a channel, a lock, or a sleep) and is
 * resumed when the scheduler runs the goroutine again.
 */
// oxlint-disable-next-line typescript/no-invalid-void-type -- A generator that ends with a bare return returns void.
export type Execution = Generator<Blocked, Completion | void, unknown>;
export type Exec = (frame: Frame) => Execution;
/** A computation that may block, such as a call of a function of the program. */
export type Suspending<T> = Generator<Blocked, T, unknown>;

/** What a blocked goroutine waits for, as Go names it in a goroutine's status (`chan receive`, `sleep`, ...). */
export interface Blocked {
  reason: string;
}

/** A local variable as the trace shows it. */
export interface LocalInfo {
  name: string;
  slot: number;
  type: Type;
  /** Whether the variable is a method's receiver, whose fields show as `t.x` like Java's `this.x`. */
  isReceiver?: boolean;
}

/** What the runtime needs to know about a compiled function. */
export interface FunctionInfo {
  name: string;
  slotCount: number;
  locals: LocalInfo[];
  /** The variables of enclosing functions that a closure captured, which the trace shows after its own. */
  captures: { name: string; type: Type }[];
  isAtomic: boolean;
  body: Exec;
  /** The slots of the results, which `return` fills and the caller reads after deferred calls run. */
  resultSlots: number[];
  /** The receiver and parameters, which live in cells when closures or pointers share them. */
  params: { slot: number; boxed: boolean }[];
}

/**
 * The stack buffers of a function's call, and those of the calls inlined into it, by call site; `resultStaysLocal`
 * tells whether the result of an inlined call stays in the caller, which lets what the callee returns live on its stack,
 * and `constants` what of an inlined call Go's compiler knows as constants from the caller.
 */
export interface StackBuffers {
  used: WeakSet<object>;
  inlined: WeakMap<object, StackBuffers>;
  resultStaysLocal: boolean;
  constants: InlinedConstants;
}

/**
 * What Go's compiler knows as constants in a call it inlines: the parameters, by index, from the arguments, and the
 * variables the callee captures, from their definitions reaching the call.
 */
export interface InlinedConstants {
  params: readonly boolean[];
  captures: ReadonlySet<object>;
}

const NO_CONSTANTS: InlinedConstants = { params: [], captures: new Set() };

function newStackBuffers(resultStaysLocal = false, constants = NO_CONSTANTS): StackBuffers {
  return { used: new WeakSet(), inlined: new WeakMap(), resultStaysLocal, constants };
}

/** Marks a local whose scope has not begun or has ended. */
export const UNASSIGNED: unique symbol = Symbol('unassigned');

interface DeferredCall {
  run: () => void;
  resume?: () => Suspending<unknown>;
  /** The function and arguments, which garbage collection must follow until the call runs. */
  values: unknown[];
}

export class Frame implements TracedFrame {
  readonly locals: (Value | Cell | typeof UNASSIGNED)[];
  /** Values that are in use but held by no variable, such as a range loop's slice. */
  readonly temporaries: unknown[] = [];
  defers: DeferredCall[] | undefined;
  /** The panic this frame's deferred calls run for, which `recover` in one of them stops. */
  panicking: GoPanic | undefined;

  constructor(
    readonly runtime: Runtime,
    readonly info: FunctionInfo,
    readonly cells: readonly Cell[],
    readonly callRow: number | undefined,
    /** The frame whose deferred call this frame runs, where `recover` may stop the panic. */
    readonly deferredFor: Frame | undefined,
    /**
     * The stack buffers appends have taken, by the append that took each; a call that Go's compiler inlines shares the
     * caller's, as its body becomes part of the caller.
     */
    private stackBuffers?: StackBuffers
  ) {
    this.locals = Array.from({ length: info.slotCount }, () => UNASSIGNED);
  }

  usedStackBuffer(append: object): boolean {
    return this.stackBuffers?.used.has(append) ?? false;
  }

  useStackBuffer(append: object): void {
    (this.stackBuffers ??= newStackBuffers()).used.add(append);
  }

  /** Whether the values this call returns stay in a caller that Go's compiler inlines it into. */
  get resultStaysLocal(): boolean {
    return this.stackBuffers?.resultStaysLocal ?? false;
  }

  /** Whether Go's compiler knows the parameter at `index` as a constant, from the argument of the call it inlined. */
  constantParam(index: number): boolean {
    return this.stackBuffers?.constants.params[index] ?? false;
  }

  /** Whether Go's compiler knows a variable the function captures as a constant, in the call it inlined. */
  constantCapture(variable: object): boolean {
    return this.stackBuffers?.constants.captures.has(variable) ?? false;
  }

  /** The stack buffers of a call at `site` that Go's compiler inlines into this function. */
  inlinedStackBuffers(
    site: object,
    resultStaysLocal: boolean,
    constants: (frame: Frame) => InlinedConstants
  ): StackBuffers {
    const { inlined } = (this.stackBuffers ??= newStackBuffers());
    let buffers = inlined.get(site);
    if (!buffers) {
      buffers = newStackBuffers(resultStaysLocal, constants(this));
      inlined.set(site, buffers);
    }
    return buffers;
  }
}

/** A panic that unwinds the stack until a deferred call recovers it. */
export class GoPanic extends Error {
  /** The panic this one replaced, because a deferred call panicked while this one's frames unwound. */
  previous: GoPanic | undefined;
  recovered = false;
  /** Whether the panic was recovered and then raised again with the same value, which Go prints once. */
  repanicked = false;

  constructor(readonly value: Value) {
    super('Go panic');
  }
}

/** An error that no `recover` can stop, such as running out of stack. */
export class GoFatal extends Error {
  constructor(readonly description: string) {
    super(description);
  }
}

/** Ends the program at once, as `os.Exit` does, without running deferred calls. */
export class ProgramExit extends Error {
  constructor(readonly code: number) {
    super(`exit status ${code}`);
  }
}

export class Runtime implements TracedRuntime<Frame> {
  readonly world = new TurtleWorld();
  readonly budget = new ExecutionBudget();
  /** The standard streams and the files of the run. */
  readonly io: ProgramIO;
  readonly steps = new StepTracker();
  /** The frames of the running goroutine. */
  frames: Frame[] = [];
  /** Runs the goroutines when the program uses them. */
  scheduler: { roots(): unknown[]; now: bigint } | undefined;
  /** The package-level variables, which pointers may refer to. */
  globals: Cell[] = [];
  private allocated = 0;
  private readonly stdoutDecoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  private readonly stderrDecoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
  }

  writeStdout(bytes: string): void {
    if (bytes.length === 0) return;
    const text = this.stdoutDecoder.decode(rawBytes(bytes), { stream: true });
    if (text.length > 0) this.io.stdout.write(text);
  }

  writeStderr(bytes: string): void {
    if (bytes.length === 0) return;
    const text = this.stderrDecoder.decode(rawBytes(bytes), { stream: true });
    if (text.length > 0) this.io.stderr.write(text);
  }

  flushOutput(): void {
    const out = this.stdoutDecoder.decode();
    if (out.length > 0) this.io.stdout.write(out);
    const err = this.stderrDecoder.decode();
    if (err.length > 0) this.io.stderr.write(err);
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  /** Counts slots that a program allocates, stopping it as Go stops when memory runs out. */
  allocate(count: number): void {
    this.allocated += count;
    if (this.allocated > LIMITS.maxSlots || count > LIMITS.maxSlots)
      throw new GoFatal('fatal error: runtime: out of memory');
  }

  checkStringLength(length: number): void {
    if (length > LIMITS.maxStringLength) throw new GoFatal('fatal error: runtime: out of memory');
  }

  /**
   * Calls a compiled function: binds the arguments, runs the body and then the deferred calls, and returns the
   * results, as one value, an array for several, or undefined for none.
   */
  // code-gauge-allow functionParameterCount 7 -- Preserves the complete frame, defer and retained-value protocol at the runtime boundary.
  call(
    info: FunctionInfo,
    cells: readonly Cell[],
    args: Value[],
    callRow: number | undefined,
    deferredFor?: Frame,
    /** Receives the frame when the call ends, for reading the entry point's final variables. */
    onExit?: (frame: Frame) => void,
    stackBuffers?: StackBuffers
  ): Value | Value[] {
    return runToEnd(this.resume(info, cells, args, callRow, deferredFor, onExit, stackBuffers));
  }

  /** Calls a compiled function as {@link call} does, yielding when its goroutine blocks. */
  // code-gauge-allow functionParameterCount 7 -- Preserves the complete frame, defer and retained-value protocol at the runtime boundary.
  *resume(
    info: FunctionInfo,
    cells: readonly Cell[],
    args: Value[],
    callRow: number | undefined,
    deferredFor?: Frame,
    onExit?: (frame: Frame) => void,
    stackBuffers?: StackBuffers
  ): Suspending<Value | Value[]> {
    this.spend();
    if (this.frames.length >= LIMITS.maxCallDepth) {
      throw new GoFatal('runtime: goroutine stack exceeds 1000000000-byte limit\nfatal error: stack overflow');
    }
    const frame = new Frame(this, info, cells, callRow, deferredFor, stackBuffers);
    for (const [index, { slot, boxed }] of info.params.entries())
      frame.locals[slot] = boxed ? new Cell(args[index]) : args[index];
    const frames = this.frames;
    frames.push(frame);
    try {
      yield* this.runBody(frame);
    } finally {
      onExit?.(frame);
      frames.pop();
    }
    if (info.isAtomic) this.steps.completeAtomicCall();
    return resultsOf(frame);
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Preserves the complete frame, defer and retained-value protocol at the runtime boundary.
  private *runBody(frame: Frame): Suspending<void> {
    let panic: GoPanic | undefined;
    try {
      yield* frame.info.body(frame);
    } catch (error) {
      if (!(error instanceof GoPanic)) throw error;
      panic = error;
    }
    if (!frame.defers) {
      if (panic) throw panic;
      return;
    }
    frame.panicking = panic;
    while (frame.defers.length > 0) {
      const deferred = frame.defers.pop() as DeferredCall;
      try {
        if (deferred.resume) yield* deferred.resume();
        else deferred.run();
      } catch (error) {
        if (!(error instanceof GoPanic)) throw error;
        // A panic in a deferred call replaces the one in progress, which Go reports as recovered or not.
        error.previous = frame.panicking;
        frame.panicking = error;
      }
    }
    if (frame.panicking && !frame.panicking.recovered) throw frame.panicking;
    frame.panicking = undefined;
  }

  /** `recover()`: stops the panic of the frame whose deferred call is running, when called directly from that call. */
  recover(frame: Frame): Value {
    const target = frame.deferredFor;
    const panic = target?.panicking;
    if (!target || !panic || panic.recovered) return undefined;
    panic.recovered = true;
    return panic.value;
  }

  defer(frame: Frame, run: () => void, values: unknown[], resume?: () => Suspending<unknown>): void {
    (frame.defers ??= []).push({ run, values, resume });
  }

  /** Removes the turtles that no variable, temporary value, or pending deferred call reaches. */
  collectGarbage(): void {
    const reached = new Set<unknown>();
    const stack: unknown[] = [];
    for (const cell of this.globals) stack.push(cell);
    if (this.scheduler) stack.push(...this.scheduler.roots());
    else pushFrameRoots(this.frames, stack);
    const turtles = new Set<unknown>();
    while (stack.length > 0) {
      const item = stack.pop();
      if (item === undefined || item === null || typeof item !== 'object' || reached.has(item)) continue;
      reached.add(item);
      pushChildren(item, stack, turtles);
    }
    this.world.retain((turtle) => turtles.has(turtle));
  }
}

/** Pushes what the frames of a goroutine keep alive, for garbage collection. */
export function pushFrameRoots(frames: readonly Frame[], stack: unknown[]): void {
  for (const frame of frames) {
    stack.push(...frame.locals, ...frame.cells, ...frame.temporaries);
    for (const deferred of frame.defers ?? []) stack.push(...deferred.values);
    if (frame.panicking) stack.push(frame.panicking.value);
  }
}

/**
 * Runs a computation that may block to its end, where the caller cannot wait, such as a callback that a library
 * function calls. Blocking there is a limit of this interpreter, which it reports instead of behaving differently.
 */
export function runToEnd<T>(computation: Suspending<T>): T {
  const next = computation.next();
  if (next.done) return next.value;
  computation.return(undefined as T);
  throw new GoFatal(
    'ライブラリの関数から呼ばれた関数の中で、チャネルやロックを待つことは、この採点環境では使えません。'
  );
}

function rawBytes(bytes: string): Uint8Array {
  const array = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index++) array[index] = bytes.charCodeAt(index) & 0xff;
  return array;
}

// code-gauge-allow functionCognitiveComplexity 26 -- Preserves the complete frame, defer and retained-value protocol at the runtime boundary.
// code-gauge-allow functionNcss 46 -- Preserves the complete frame, defer and retained-value protocol at the runtime boundary.
function pushChildren(item: object, stack: unknown[], turtles: Set<unknown>): void {
  if (item instanceof Frame) pushFrameRoots([item], stack);
  else if (item instanceof Cell) stack.push(item.v);
  else if (item instanceof Pointer) stack.push(item.base);
  else if (Array.isArray(item)) {
    for (const entry of item as unknown[]) stack.push(entry);
  } else if (item instanceof GoStruct) {
    stack.push(item.fields);
    const native = item.native;
    if (native?.turtle) turtles.add(native.turtle);
    else if (native) {
      if (native.roots) stack.push(...native.roots());
      for (const value of Object.values(native)) stack.push(value);
    }
  } else if (item instanceof GoArray) stack.push(item.elements);
  else if (item instanceof Slice) stack.push(item.array);
  else if (item instanceof GoMap) for (const entry of item.entries.values()) stack.push(entry.key, entry.value);
  else if (item instanceof GoFunc) stack.push(...item.captured);
  else if (item instanceof Iface) stack.push(item.value);
  else if (item instanceof Channel) {
    stack.push(...item.buffer);
    for (const sender of item.senders) stack.push((sender as { value: unknown }).value);
  }
}

function resultsOf(frame: Frame): Value | Value[] {
  const { resultSlots } = frame.info;
  if (resultSlots.length === 0) return undefined;
  const read = (slot: number): Value => {
    const value = frame.locals[slot];
    return value instanceof Cell ? value.v : (value as Value);
  };
  if (resultSlots.length === 1) return read(resultSlots[0]);
  return resultSlots.map(read);
}

/**
 * Evaluates a list of expressions in order, keeping the values computed so far reachable for garbage collection while
 * the later ones run, as they would be on Go's stack.
 */
export function evaluateAll(frame: Frame, evals: readonly Eval[]): Value[] {
  if (evals.length < 2) return evals.map((evaluate) => evaluate(frame));
  const values: Value[] = [];
  frame.temporaries.push(values);
  try {
    for (const evaluate of evals) values.push(evaluate(frame));
  } finally {
    frame.temporaries.pop();
  }
  return values;
}

export function withTemporary<T>(frame: Frame, value: unknown, run: () => T): T {
  frame.temporaries.push(value);
  try {
    return run();
  } finally {
    frame.temporaries.pop();
  }
}

/** Reads a local, which is a cell when a closure or a pointer may share it. */
export function readLocal(frame: Frame, slot: number): Value {
  const value = frame.locals[slot];
  return value instanceof Cell ? value.v : (value as Value);
}

export function writeLocal(frame: Frame, slot: number, value: Value): void {
  const current = frame.locals[slot];
  if (current instanceof Cell) current.v = writeInPlace(current.v, value);
  else if (current === UNASSIGNED) frame.locals[slot] = copyValue(value);
  else frame.locals[slot] = writeInPlace(current, value);
}

/** Runs the computations that may block of a statement, keeping their results in their hidden slots. */
export function* runHoists(frame: Frame, hoists: readonly Hoist[]): Suspending<void> {
  for (const hoist of hoists) frame.locals[hoist.slot] = (yield* hoist.run(frame)) as Value;
}

/** Lets go of the results of the computations that may block once their statement used them. */
export function clearHoists(frame: Frame, hoists: readonly Hoist[]): void {
  for (const hoist of hoists) frame.locals[hoist.slot] = undefined;
}

/** Evaluates an expression after the computations that may block in it. */
export function* evaluatePart(frame: Frame, part: Part): Suspending<Value> {
  const hoists = part.hoists as Hoist[];
  yield* runHoists(frame, hoists);
  try {
    return part.value(frame);
  } finally {
    clearHoists(frame, hoists);
  }
}
