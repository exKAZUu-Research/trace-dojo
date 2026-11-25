import type { HashStore } from './hashStore';
import type { Frame } from './runtime';
import { type Cell, type DartList, type DartObject, HoldingCell, type Value } from './values';

/** Adds an element, or a map entry, to the collection literal being built. */
export type AddElement = ((key: Value, value?: Value) => void) & {
  target?: DartObject;
  /** Applies an addition that writes `target` directly, as one addition of the collection being built. */
  addAll?: (addition: Addition) => void;
  /** Passes over additions that a resumed collection `for` element's completed iterations made before. */
  skip?: (count: number) => void;
};

/** An addition to the collection being built, run with the collection's add. */
export type Addition = (add: AddElement) => void;

export function applyAddition(add: AddElement, addition: Addition): void {
  if (add.addAll) add.addAll(addition);
  else addition(add);
}

/** Where a statement that awaits keeps the progress of a collection literal or `for` element across evaluations. */
export interface ProgressMemo<T> {
  read: (frame: Frame) => T | undefined;
  write: (frame: Frame, progress: T) => void;
}

/** The collection a literal in a statement that awaits is building, and how many additions it has made. */
export class BuildProgress extends HoldingCell {
  applied = 0;
  /** How many additions the current evaluation of the literal has reached. */
  reached = 0;

  constructor(readonly collection: DartObject) {
    super();
  }

  *held(): Iterable<Value> {
    yield this.collection;
  }
}

/**
 * Builds a collection literal. In a statement whose `await`s evaluate it again, the collection stays with the
 * literal's progress, and evaluating the literal again passes over the additions it already made, so that each
 * element is added, and its storage counted, once.
 */
export function build(
  frame: Frame,
  memo: ProgressMemo<BuildProgress> | undefined,
  create: () => DartObject,
  addTo: (collection: DartObject) => AddElement,
  run: (frame: Frame, add: AddElement) => void
): DartObject {
  if (!memo) {
    const collection = create();
    // The elements built so far stay reachable while later ones are evaluated.
    frame.temporaries.push(collection);
    try {
      run(frame, addTo(collection));
    } finally {
      frame.temporaries.pop();
    }
    return collection;
  }
  let progress = memo.read(frame);
  if (!progress) {
    progress = new BuildProgress(create());
    memo.write(frame, progress);
  }
  progress.reached = 0;
  run(frame, resumingAdd(addTo(progress.collection), progress));
  return progress.collection;
}

export function addToList(list: DartObject): AddElement {
  return (value) => {
    (list as DartList).elements.push(value);
  };
}

/** The add of a set or map, whose store keeps a set's elements as keys without values. */
export function addToHashed(collection: DartObject): AddElement {
  const store = collection.native as HashStore;
  return Object.assign((key: Value, value?: Value) => store.set(key, value), { target: collection });
}

function resumingAdd(add: AddElement, progress: BuildProgress): AddElement {
  const addAll = (addition: Addition): void => {
    if (progress.reached++ < progress.applied) return;
    progress.applied++;
    addition(add);
  };
  return Object.assign((key: Value, value?: Value) => addAll((target) => target(key, value)), {
    target: add.target,
    addAll,
    skip: (count: number) => {
      progress.reached += count;
    },
  });
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
  /** How many additions the completed iterations made. */
  added = 0;

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
  }
}

/**
 * Runs a collection `for` element in a statement whose `await`s, inside or after the element, evaluate the statement
 * again. The element's progress keeps its iterator, its loop variables, and how many additions its completed
 * iterations made, which the literal being built already holds, so that evaluating the statement again continues with
 * the iteration that suspended, instead of running the completed iterations, their updates, and their iterator's code
 * a second time.
 */
export function runResumableLoop(
  loop: ElementLoop,
  memo: ProgressMemo<LoopProgress>
): (frame: Frame, add: AddElement) => void {
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

/** The loop's progress, started now, or resumed by passing over the completed iterations' additions. */
function progressOf(frame: Frame, add: AddElement, loop: ElementLoop, memo: ProgressMemo<LoopProgress>): LoopProgress {
  const remembered = memo.read(frame);
  if (remembered) {
    if (!add.skip) throw new Error('A collection for element resumes only inside a collection literal that resumes.');
    add.skip(remembered.added);
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
    const counted = { additions: 0 };
    loop.body(frame, countingAdd(add, counted));
    progress.added += counted.additions;
    progress.bodyDone = true;
  }
  loop.afterIteration(frame);
  progress.saveVariables(frame, loop.variables);
  progress.current = undefined;
  progress.bodyDone = false;
  progress.iterations++;
  return true;
}

function countingAdd(add: AddElement, counted: { additions: number }): AddElement {
  const addAll = (addition: Addition): void => {
    counted.additions++;
    applyAddition(add, addition);
  };
  return Object.assign((key: Value, value?: Value) => addAll((target) => target(key, value)), {
    target: add.target,
    addAll,
    skip: (count: number) => {
      counted.additions += count;
      add.skip?.(count);
    },
  });
}
