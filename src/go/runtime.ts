// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt reads as raw bytes.
import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { TurtleWorld } from '../interpreter/turtleWorld';
import type { Type } from './types';
import {
  Cell,
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
export type Completion = { kind: 'break' } | { kind: 'continue' } | { kind: 'return' } | { kind: 'fallthrough' };

export const BREAK: Completion = { kind: 'break' };
export const CONTINUE: Completion = { kind: 'continue' };
export const RETURN: Completion = { kind: 'return' };
export const FALLTHROUGH: Completion = { kind: 'fallthrough' };

export type Eval = (frame: Frame) => Value;
/** Evaluates a list of values, such as the arguments of a call or the results of one with several. */
export type ListEval = (frame: Frame) => Value[];
export type Exec = (frame: Frame) => Completion | undefined;

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
  canInline?: boolean;
}

/** Marks a local whose scope has not begun or has ended. */
export const UNASSIGNED: unique symbol = Symbol('unassigned');

interface DeferredCall {
  run: () => void;
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
    readonly resultStaysOnStack = false
  ) {
    this.locals = Array.from({ length: info.slotCount }, () => UNASSIGNED);
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
  readonly frames: Frame[] = [];
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
  call(
    info: FunctionInfo,
    cells: readonly Cell[],
    args: Value[],
    callRow: number | undefined,
    deferredFor?: Frame,
    /** Receives the frame when the call ends, for reading the entry point's final variables. */
    onExit?: (frame: Frame) => void,
    resultStaysOnStack = false
  ): Value | Value[] {
    this.spend();
    if (this.frames.length >= LIMITS.maxCallDepth) {
      throw new GoFatal('runtime: goroutine stack exceeds 1000000000-byte limit\nfatal error: stack overflow');
    }
    const frame = new Frame(this, info, cells, callRow, deferredFor, Boolean(info.canInline && resultStaysOnStack));
    for (const [index, { slot, boxed }] of info.params.entries())
      frame.locals[slot] = boxed ? new Cell(args[index]) : args[index];
    this.frames.push(frame);
    try {
      this.runBody(frame);
    } finally {
      onExit?.(frame);
      this.frames.pop();
    }
    if (info.isAtomic) this.steps.completeAtomicCall();
    return resultsOf(frame);
  }

  private runBody(frame: Frame): void {
    let panic: GoPanic | undefined;
    try {
      frame.info.body(frame);
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
        deferred.run();
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

  defer(frame: Frame, run: () => void, values: unknown[]): void {
    (frame.defers ??= []).push({ run, values });
  }

  /** Removes the turtles that no variable, temporary value, or pending deferred call reaches. */
  collectGarbage(): void {
    const reached = new Set<unknown>();
    const stack: unknown[] = [];
    for (const cell of this.globals) stack.push(cell);
    for (const frame of this.frames) {
      for (const local of frame.locals) stack.push(local);
      for (const cell of frame.cells) stack.push(cell);
      for (const temporary of frame.temporaries) stack.push(temporary);
      for (const deferred of frame.defers ?? []) {
        for (const value of deferred.values) stack.push(value);
      }
      if (frame.panicking) stack.push(frame.panicking.value);
    }
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

function rawBytes(bytes: string): Uint8Array {
  const array = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index++) array[index] = bytes.charCodeAt(index) & 0xff;
  return array;
}

function pushChildren(item: object, stack: unknown[], turtles: Set<unknown>): void {
  if (item instanceof Cell) stack.push(item.v);
  else if (item instanceof Pointer) stack.push(item.base);
  else if (Array.isArray(item)) {
    for (const entry of item as unknown[]) stack.push(entry);
  } else if (item instanceof GoStruct) {
    stack.push(item.fields);
    const native = item.native;
    if (native?.turtle) turtles.add(native.turtle);
    else if (native) {
      for (const value of Object.values(native)) stack.push(value);
    }
  } else if (item instanceof GoArray) stack.push(item.elements);
  else if (item instanceof Slice) stack.push(item.array);
  else if (item instanceof GoMap) {
    for (const entry of item.entries.values()) stack.push(entry.key, entry.value);
  } else if (item instanceof GoFunc) {
    for (const captured of item.captured) stack.push(captured);
  } else if (item instanceof Iface) stack.push(item.value);
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
