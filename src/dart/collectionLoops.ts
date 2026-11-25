import type { Frame } from './runtime';
import { type Cell, type DartObject, HoldingCell, type Value } from './values';

/** Adds an element, or a map entry, to the collection literal being built. */
export type AddElement = ((key: Value, value?: Value) => void) & {
  target?: DartObject;
  /** Applies an addition that writes `target` directly, through an add that records the additions it sees. */
  addAll?: (addition: Addition) => void;
};

/** An addition to the collection being built, which a collection `for` element's progress may apply again. */
export interface Addition {
  apply: (add: AddElement) => void;
  /** The values the addition adds, which garbage collection reaches while the statement waits. */
  values: readonly Value[];
}

export function applyAddition(add: AddElement, addition: Addition): void {
  if (add.addAll) add.addAll(addition);
  else addition.apply(add);
}

/** How a collection `for` element starts, tests, binds, and advances its iterations. */
export interface ElementLoop {
  /** Runs the loop's initializer, giving the iterator a for-in element reads. */
  start: (frame: Frame) => Value;
  /** The value the next iteration binds, or undefined when the loop ends. */
  next: (frame: Frame, iterator: Value) => { value: Value } | undefined;
  bind: ((frame: Frame, value: Value) => void) | undefined;
  body: (frame: Frame, add: AddElement) => void;
  /** Runs after each iteration's body, as a counted loop's updates. */
  afterIteration: (frame: Frame) => void;
  /** The slots of the loop's variables, whose cells the loop's progress restores. */
  variables: readonly number[];
}

export interface ProgressMemo {
  read: (frame: Frame) => LoopProgress | undefined;
  write: (frame: Frame, progress: LoopProgress) => void;
}

/** Runs a collection `for` element in a statement that no `await` suspends while the element runs. */
export function runLoop(loop: ElementLoop): (frame: Frame, add: AddElement) => void {
  return (frame, add) => {
    const iterator = loop.start(frame);
    frame.temporaries.push(iterator);
    try {
      for (let current = loop.next(frame, iterator); current; current = loop.next(frame, iterator)) {
        loop.bind?.(frame, current.value);
        loop.body(frame, add);
        loop.afterIteration(frame);
      }
    } finally {
      frame.temporaries.pop();
    }
  };
}

/** How far a collection `for` element in a statement that awaits has run. */
export class LoopProgress extends HoldingCell {
  /** The value the iteration in progress bound, once its condition or `moveNext` has passed. */
  current: { value: Value } | undefined;
  /** Whether the iteration in progress has run its body, so that only what follows the body remains. */
  bodyDone = false;
  iterations = 0;
  done = false;
  /** The loop variables' cells after the last completed iteration. */
  variables: (Cell | undefined)[] = [];
  readonly additions: Addition[] = [];

  constructor(readonly iterator: Value) {
    super();
  }

  saveVariables(frame: Frame, slots: readonly number[]): void {
    this.variables = slots.map((slot) => frame.locals[slot]);
  }

  *held(): Iterable<Value> {
    yield this.iterator;
    yield this.current?.value;
    for (const cell of this.variables) yield cell?.v;
    for (const addition of this.additions) yield* addition.values;
  }
}

/**
 * Runs a collection `for` element in a statement whose `await`s, inside or after the element, evaluate the statement
 * again. The element's progress keeps its iterator, its loop variables, and what its completed iterations added, so
 * that evaluating the statement again applies those additions and continues with the iteration that suspended,
 * instead of running the completed iterations, their updates, and their iterator's code a second time.
 */
export function runResumableLoop(loop: ElementLoop, memo: ProgressMemo): (frame: Frame, add: AddElement) => void {
  return (frame, add) => {
    const progress = progressOf(frame, add, loop, memo);
    if (progress.done) return;
    const { iterationPath } = frame;
    const depth = iterationPath.push(0) - 1;
    try {
      // The iteration number keys what the iteration's expressions remember before its `await`s.
      do iterationPath[depth] = progress.iterations;
      while (runIteration(frame, add, loop, progress));
    } finally {
      iterationPath.length = depth;
    }
  };
}

/** The loop's progress, started now, or resumed by applying the completed iterations' additions again. */
function progressOf(frame: Frame, add: AddElement, loop: ElementLoop, memo: ProgressMemo): LoopProgress {
  const remembered = memo.read(frame);
  if (remembered) {
    for (const addition of remembered.additions) applyAddition(add, addition);
    for (const [index, cell] of remembered.variables.entries()) frame.locals[loop.variables[index]] = cell;
    return remembered;
  }
  const progress = new LoopProgress(loop.start(frame));
  progress.saveVariables(frame, loop.variables);
  memo.write(frame, progress);
  return progress;
}

/** Runs what remains of the current iteration, telling whether the loop goes on. */
function runIteration(frame: Frame, add: AddElement, loop: ElementLoop, progress: LoopProgress): boolean {
  if (!progress.bodyDone) {
    progress.current ??= loop.next(frame, progress.iterator);
    if (!progress.current) {
      progress.done = true;
      return false;
    }
    loop.bind?.(frame, progress.current.value);
    const additions: Addition[] = [];
    loop.body(frame, recordingAdd(add, additions));
    for (const addition of additions) progress.additions.push(addition);
    progress.bodyDone = true;
  }
  loop.afterIteration(frame);
  progress.saveVariables(frame, loop.variables);
  progress.current = undefined;
  progress.bodyDone = false;
  progress.iterations++;
  return true;
}

/** An add that also records each addition in `additions`, so that they can be applied again later. */
function recordingAdd(add: AddElement, additions: Addition[]): AddElement {
  const addAll = (addition: Addition): void => {
    additions.push(addition);
    applyAddition(add, addition);
  };
  return Object.assign(
    (key: Value, value?: Value) => addAll({ apply: (target) => target(key, value), values: [key, value] }),
    { target: add.target, addAll }
  );
}
