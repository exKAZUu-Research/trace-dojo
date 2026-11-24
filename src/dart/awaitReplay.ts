import type { Span } from './ast';
import { DartThrow, type Frame } from './runtime';
import type { FunctionContext } from './scope';
import { Cell, IteratedMemo, type Value } from './values';

/**
 * What the body of an `async` or `async*` function yields to the code driving it: the value an `await` waits for,
 * resumed with the value it completes with or thrown into with its error.
 */
export class AwaitRequest {
  constructor(readonly value: Value) {}
}

/**
 * What resumes an `async*` body at its `yield` once its stream's listener has cancelled: the `yield` then returns, so
 * that the body runs its `finally` blocks and ends.
 */
export const LISTENER_CANCELLED = Symbol('listener cancelled');

/** What an `async*` body's `yield*` yields: the stream whose events the function's stream forwards. */
export class YieldEachRequest {
  constructor(readonly stream: Value) {}
}

/**
 * Thrown by an `await` whose value is not known yet, which unwinds the statement being evaluated to the generator
 * that runs it. Everything the statement evaluated before the `await` is remembered in slots, so evaluating the
 * statement again once the value arrives continues where it stopped.
 */
export class AwaitSuspension {
  constructor(
    readonly slot: number,
    readonly value: Value,
    /** The iteration of the collection `for` elements the `await` is in, whose value its slot keeps apart. */
    readonly key: string | undefined
  ) {}
}

/** The remembered outcome of an `await` whose future completed with an error, which evaluating it again throws. */
export class AwaitedError extends Cell {
  constructor(readonly error: DartThrow) {
    super(error.value);
  }
}

/** A statement, or a condition of a loop, whose expressions contain an `await`, as its compilation tracks it. */
export interface AwaitRoot {
  fn: FunctionContext;
  /** The source ranges of the expressions the root evaluates, outside which its slots remember nothing. */
  ranges: Span[];
  /** Where each `await` of the root starts, outside nested functions. */
  awaitStarts: number[];
  /** The slots that remember values while the root is evaluated, which each fresh evaluation clears. */
  slots: number[];
  /** How many memoized expressions are being compiled, inside which nothing more is memoized. */
  memoDepth: number;
  /** The slot of each `await` and memoized expression, so that compiling one twice reuses it. */
  slotOf: Map<object, number>;
  /** How many collection `for` elements enclose the expression being compiled. */
  loopDepth: number;
  /** The slots of expressions inside collection `for` elements, which remember a value for each iteration. */
  iterated: Set<number>;
}

export function newAwaitRoot(fn: FunctionContext, ranges: Span[], awaitStarts: number[]): AwaitRoot {
  return { fn, ranges, awaitStarts, slots: [], memoDepth: 0, slotOf: new Map(), loopDepth: 0, iterated: new Set() };
}

/** The key of the current iteration of the collection `for` elements being evaluated, if any. */
export function iterationKey(frame: Frame): string | undefined {
  return frame.iterationPath.length > 0 ? frame.iterationPath.join('.') : undefined;
}

/** What a slot remembers, for the current iteration when the slot is inside collection `for` elements. */
export function readMemo(frame: Frame, slot: number, iterated: boolean): Cell | undefined {
  const cell = frame.locals[slot];
  if (!iterated) return cell;
  return cell instanceof IteratedMemo ? cell.cells.get(iterationKey(frame) ?? '') : undefined;
}

export function writeMemo(frame: Frame, slot: number, key: string | undefined, value: Cell): void {
  if (key === undefined) {
    frame.locals[slot] = value;
    return;
  }
  let memo = frame.locals[slot];
  if (!(memo instanceof IteratedMemo)) {
    memo = new IteratedMemo();
    frame.locals[slot] = memo;
  }
  (memo as IteratedMemo).cells.set(key, value);
}

/** Whether a statement or expression contains `await`, `await for`, or `yield` outside nested functions. */
export function containsSuspension(node: unknown): boolean {
  return suspensionStarts(node, true).length > 0;
}

export function containsAwait(node: unknown): boolean {
  return suspensionStarts(node, false).length > 0;
}

const awaitCache = new WeakMap<object, number[]>();
const suspensionCache = new WeakMap<object, number[]>();

/** Where the `await` expressions of a node start, or with `withYields` also its `yield` and `await for` statements. */
export function suspensionStarts(node: unknown, withYields: boolean): number[] {
  if (typeof node !== 'object' || node === null) return [];
  const cache = withYields ? suspensionCache : awaitCache;
  const cached = cache.get(node);
  if (cached) return cached;
  const starts: number[] = [];
  collectStarts(node, withYields, starts);
  cache.set(node, starts);
  return starts;
}

function collectStarts(node: unknown, withYields: boolean, starts: number[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectStarts(item, withYields, starts);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const record = node as Partial<Span> & { kind?: string; isAwait?: boolean; body?: unknown };
  if (suspends(record, withYields)) starts.push(record.start ?? 0);
  // A nested function suspends only itself.
  if ((record.kind === 'function' && record.body !== undefined) || record.kind === 'localFunction') return;
  for (const value of Object.values(record)) if (typeof value === 'object') collectStarts(value, withYields, starts);
}

function suspends(node: { kind?: string; isAwait?: boolean }, withYields: boolean): boolean {
  if (node.kind === 'await' || (node.kind === 'forInElement' && node.isAwait === true)) return true;
  return withYields && (node.kind === 'yield' || (node.kind === 'forIn' && node.isAwait === true));
}

/**
 * Evaluates `run` until no `await` in it suspends, yielding each awaited value and remembering what it completes
 * with in the `await`'s slot before evaluating again.
 */
export function* evaluateResuming<T>(
  frame: Frame,
  slots: readonly number[],
  run: () => T
): Generator<AwaitRequest, T, Value> {
  for (const slot of slots) frame.locals[slot] = undefined;
  try {
    for (;;) {
      try {
        return run();
      } catch (error) {
        if (!(error instanceof AwaitSuspension)) throw error;
        writeMemo(frame, error.slot, error.key, yield* awaitOutcome(error.value));
      }
    }
  } finally {
    for (const slot of slots) frame.locals[slot] = undefined;
  }
}

function* awaitOutcome(value: Value): Generator<AwaitRequest, Cell, Value> {
  try {
    return new Cell(yield new AwaitRequest(value));
  } catch (error) {
    if (error instanceof DartThrow) return new AwaitedError(error);
    throw error;
  }
}

/** Evaluates `run` in a generator, resuming it after each `await` when the code it runs awaits. */
export function* evaluateParts<T>(
  frame: Frame,
  slots: readonly number[] | undefined,
  run: () => T
): Generator<AwaitRequest, T, Value> {
  return slots ? yield* evaluateResuming(frame, slots, run) : run();
}

/** Whether a root evaluates an expression, which lies in one of its ranges. */
export function rootCovers(root: AwaitRoot, span: Span): boolean {
  return root.ranges.some((range) => range.start <= span.start && span.end <= range.end);
}
