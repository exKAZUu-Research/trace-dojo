import type { Span } from './ast';
import type { Eval } from './compilerBase';
import type { Frame } from './runtime';
import type { FunctionContext } from './scope';
import { Cell, type Value } from './values';

/**
 * What the body of an `async` or `async*` function yields to the code driving it: the value an `await` waits for,
 * resumed with the value it completes with or thrown into with its error.
 */
export class AwaitRequest {
  constructor(
    readonly value: Value,
    /** Whether the value, even a future, is the awaited value itself, as the VM's `_awaitNotFuture` takes it. */
    readonly isNotFuture = false
  ) {}
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

/** An evaluation that may wait at `await`s, yielding what each waits for and resumed with what it completes with. */
export type GenEval = (frame: Frame) => Generator<AwaitRequest, Value, Value>;

/**
 * A part of a statement that awaits, evaluated before the code that follows it in the statement into a hidden slot,
 * which that code reads: a part that contains an `await` waits there, and a part before an `await` runs before it.
 */
export interface Step {
  slot: number;
  run: Eval | undefined;
  gen: GenEval | undefined;
}

/**
 * Parts that run only when their guard holds, the one form every part evaluated on a condition takes: a branch of
 * `?:`, the right operand of `&&`, `||`, `??` and `??=`, and what follows a null-aware selector. The guard reads
 * values earlier parts evaluated, so it evaluates nothing itself; a guarded part's slot is read only when it ran.
 */
export interface GuardedParts {
  guard: (frame: Frame) => boolean;
  parts: Part[];
}

/** An ordered part of a statement that awaits. */
export type Part = Step | GuardedParts;

/**
 * The parts being lifted: those of an expression that awaits, or of a statement, a loop's header, or a branch that
 * does, whose `await`s start at `awaitStarts`.
 */
export interface Staging {
  readonly steps: Part[];
  readonly awaitStarts: readonly number[];
}

/** A statement, or a condition of a loop, whose expressions contain an `await`, as its compilation tracks it. */
export interface AwaitRoot {
  fn: FunctionContext;
  /** The source ranges of the expressions the root evaluates, outside which no `await` can wait. */
  ranges: Span[];
  staging: Staging;
  /** The hidden slots of all the root's steps, which each evaluation of the root clears when it ends. */
  slots: number[];
}

export function newAwaitRoot(fn: FunctionContext, ranges: Span[], awaitStarts: number[]): AwaitRoot {
  return { fn, ranges, staging: newStaging(awaitStarts), slots: [] };
}

export function newStaging(awaitStarts: readonly number[]): Staging {
  return { steps: [], awaitStarts };
}

export function* runSteps(frame: Frame, steps: readonly Part[]): Generator<AwaitRequest, void, Value> {
  for (const step of steps) {
    if ('guard' in step) {
      if (step.guard(frame)) yield* runSteps(frame, step.parts);
      continue;
    }
    const value = step.gen ? yield* step.gen(frame) : (step.run as Eval)(frame);
    frame.locals[step.slot] = new Cell(value);
  }
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

/** Runs to its end a generator that has nothing to wait for, as code without `await` compiled as one does. */
export function runWithoutWaiting<T>(generator: Generator<AwaitRequest, T, Value>): T {
  const result = generator.next();
  if (!result.done) throw new Error('Code without await does not wait.');
  return result.value;
}

/** Evaluates a statement's steps, then `run`, which reads what they computed. */
export function* evaluateParts<T>(
  frame: Frame,
  root: AwaitRoot | undefined,
  run: () => T
): Generator<AwaitRequest, T, Value> {
  if (!root) return run();
  // A part may leave values in flight when an await in a later one throws, such as a `??=`'s prepared target.
  const mark = frame.temporaries.length;
  try {
    yield* runSteps(frame, root.staging.steps);
    return run();
  } finally {
    for (const slot of root.slots) frame.locals[slot] = undefined;
    frame.temporaries.length = mark;
  }
}

/** Evaluates a statement's steps, then `run`'s generator, which reads what they computed and may wait too. */
export function* evaluatePartsThen<T>(
  frame: Frame,
  root: AwaitRoot | undefined,
  run: () => Generator<AwaitRequest, T, Value>
): Generator<AwaitRequest, T, Value> {
  if (!root) return yield* run();
  const mark = frame.temporaries.length;
  try {
    yield* runSteps(frame, root.staging.steps);
    return yield* run();
  } finally {
    for (const slot of root.slots) frame.locals[slot] = undefined;
    frame.temporaries.length = mark;
  }
}

/** Whether a root evaluates an expression, which lies in one of its ranges. */
export function rootCovers(root: AwaitRoot, span: Span): boolean {
  return root.ranges.some((range) => range.start <= span.start && span.end <= range.end);
}
