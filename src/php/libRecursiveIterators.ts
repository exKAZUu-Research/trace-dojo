// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { callMethod, consumeInvokedResult } from './callables';
import { toBool } from './conversions';
import { throwError } from './errors';
import { InnerIterator, innerIteratorOf } from './libIterators';
import { defineClass, type NativeMethod } from './native';
import { PhpThrow, rt } from './runtime';
import { nativeOwnershipChanged, type PhpClass, PhpObject, type Value } from './values';

const LEAVES_ONLY = 0;
const SELF_FIRST = 1;
const CHILD_FIRST = 2;
const CATCH_GET_CHILD = 16;

/** Where the iteration of one level stands (RecursiveIteratorState). */
const enum Step {
  Next,
  Test,
  Self,
  Child,
  Start,
}

interface Level {
  object: PhpObject;
  iterator: InnerIterator;
  step: Step;
}

/** The state of a RecursiveIteratorIterator (spl_recursive_it_object). */
class RecursiveState {
  levels: Level[] = [];
  mode = LEAVES_ONLY;
  flags = 0;
  maxDepth = -1;
  inIteration = false;

  constructor(private readonly className: string) {}

  clone(): never {
    throwError('Error', `Trying to clone an uncloneable object of class ${this.className}`);
  }

  /** What the iterator holds, in the order PHP releases it (spl_RecursiveIteratorIterator_free_iterators). */
  held(): Value[] {
    return this.levels.toReversed().flatMap((level) => [level.iterator.handle, level.object]);
  }

  get top(): Level {
    this.checkConstructed();
    return this.levels.at(-1) as Level;
  }

  checkConstructed(): void {
    if (this.levels.length === 0)
      throwError('Error', 'The object is in an invalid state as the parent constructor was not called');
  }

  get depth(): number {
    return this.levels.length - 1;
  }
}

const stateOf = (object: PhpObject): RecursiveState => object.internal as RecursiveState;

/** Calls a hook method that a subclass overrides; PHP skips the hooks RecursiveIteratorIterator itself declares. */
function hook(object: PhpObject, name: string): Value | undefined {
  const method = object.cls.findMethod(name.toLowerCase());
  if (!method || method.cls.name === 'RecursiveIteratorIterator') return undefined;
  return callMethod(object, name, []);
}

/** Runs a step whose exception CATCH_GET_CHILD tells the iteration to swallow; returns whether it threw. */
function catching(state: RecursiveState, step: () => void): boolean {
  try {
    step();
    return false;
  } catch (error) {
    if (!isCaught(state, error)) throw error;
    return true;
  }
}

function isCaught(state: RecursiveState, error: unknown): boolean {
  return error instanceof PhpThrow && (state.flags & CATCH_GET_CHILD) !== 0;
}

/** Transcribes spl_recursive_it_valid_ex, which reports the end of the iteration to endIteration. */
function validAt(object: PhpObject, state: RecursiveState): boolean {
  if (state.levels.length === 0) return false;
  for (let level = state.depth; level >= 0; level--) if (state.levels[level].iterator.valid()) return true;
  if (state.inIteration) hook(object, 'endIteration');
  state.inIteration = false;
  return false;
}

/** Transcribes spl_recursive_it_rewind_ex. */
function rewind(object: PhpObject, state: RecursiveState): void {
  state.checkConstructed();
  while (state.levels.length > 1) {
    releaseLevel(object, state, true);
    callMethod(object, 'endChildren', []);
  }
  const root = state.levels[0];
  root.step = Step.Start;
  root.iterator.rewind();
  if (!state.inIteration) hook(object, 'beginIteration');
  state.inIteration = true;
  moveForward(object, state);
}

/** Transcribes spl_recursive_it_move_forward_ex, which walks to the next element the mode reports. */
function moveForward(object: PhpObject, state: RecursiveState): void {
  for (;;) {
    const outcome = advanceLevel(object, state, state.top);
    if (outcome === 'reported') return;
    if (outcome === 'exhausted') {
      if (state.levels.length === 1) return;
      const exhausted = state.top;
      catching(state, () => hook(object, 'endChildren'));
      if (state.levels.at(-1) === exhausted) releaseLevel(object, state, false);
    }
  }
}

function releaseLevel(object: PhpObject, state: RecursiveState, rewinding: boolean): void {
  const level = state.levels.pop() as Level;
  nativeOwnershipChanged(object);
  const runtime = rt();
  const values = [level.iterator.handle, level.object];
  runtime.release(rewinding ? values : values.toReversed(), true);
  runtime.flushReleases(true);
}

/** Takes one step of the deepest level: reports an element, moves on, or finds the level exhausted. */
function advanceLevel(object: PhpObject, state: RecursiveState, level: Level): 'reported' | 'moved' | 'exhausted' {
  switch (level.step) {
    case Step.Next:
    case Step.Start: {
      if (level.step === Step.Next) catching(state, () => level.iterator.next());
      if (!level.iterator.valid()) return 'exhausted';
      level.step = Step.Test;
      return testElement(object, state, level) ? 'reported' : 'moved';
    }
    case Step.Test: {
      return testElement(object, state, level) ? 'reported' : 'moved';
    }
    case Step.Self: {
      if (state.mode === SELF_FIRST || state.mode === CHILD_FIRST) hook(object, 'nextElement');
      level.step = state.mode === SELF_FIRST ? Step.Child : Step.Next;
      return 'reported';
    }
    case Step.Child: {
      descend(object, state, level);
      return 'moved';
    }
  }
}

/** Decides whether the element of `level` is reported now, or its children first; returns whether it is reported. */
function testElement(object: PhpObject, state: RecursiveState, level: Level): boolean {
  let hasChildren = false;
  try {
    hasChildren = toBool(overridableCall(object, 'callHasChildren', level.object, 'hasChildren'));
  } catch (error) {
    if (!isCaught(state, error)) {
      level.step = Step.Next;
      throw error;
    }
  }
  if (hasChildren) {
    if (state.maxDepth === -1 || state.maxDepth > state.depth) {
      level.step = state.mode === SELF_FIRST ? Step.Self : Step.Child;
      return false;
    }
    if (state.mode === LEAVES_ONLY) {
      level.step = Step.Next;
      return false;
    }
  }
  level.step = Step.Next;
  catching(state, () => hook(object, 'nextElement'));
  return true;
}

/** Calls `name` of the iterator when a subclass overrides it, and otherwise `fallback` of the sub-iterator directly. */
function overridableCall(object: PhpObject, name: string, sub: PhpObject, fallback: string): Value {
  const result = hook(object, name);
  return result === undefined ? callMethod(sub, fallback, []) : result;
}

function descend(object: PhpObject, state: RecursiveState, level: Level): void {
  let failed = false;
  const child = consumeInvokedResult(
    () => {
      try {
        return overridableCall(object, 'callGetChildren', level.object, 'getChildren');
      } catch (error) {
        if (!isCaught(state, error)) throw error;
        failed = true;
        return null;
      }
    },
    (result) => (failed ? undefined : appendChild(object, state, result))
  );
  if (!child) {
    level.step = Step.Next;
    return;
  }
  level.step = state.mode === CHILD_FIRST ? Step.Self : Step.Next;
  child.iterator.rewind();
  catching(state, () => hook(object, 'beginChildren'));
}

function appendChild(object: PhpObject, state: RecursiveState, child: Value): Level {
  const runtime = rt();
  if (!(child instanceof PhpObject) || !child.cls.isSubclassOf(runtime.classes.get('recursiveiterator') as PhpClass))
    throwError(
      'UnexpectedValueException',
      'Objects returned by RecursiveIterator::getChildren() must implement RecursiveIterator'
    );
  const temporaryMark = runtime.frame.temporaries.length;
  const iterator = new InnerIterator(child);
  const level = { object: child, iterator, step: Step.Start };
  state.levels.push(level);
  nativeOwnershipChanged(object);
  runtime.discardNativeResult(iterator.handle, Infinity, temporaryMark);
  return level;
}

const recursiveMethods: NativeMethod[] = [
  {
    signature: '__construct(Traversable $iterator, int $mode = RecursiveIteratorIterator::LEAVES_ONLY, int $flags = 0)',
    impl: ({ thisObj, args }) => {
      let iterator = args[0] as PhpObject;
      const classes = rt().classes;
      if (iterator.cls.isSubclassOf(classes.get('iteratoraggregate') as PhpClass)) {
        const result = callMethod(iterator, 'getIterator', []);
        if (!(result instanceof PhpObject) || !result.cls.isSubclassOf(classes.get('traversable') as PhpClass))
          throwError(
            'LogicException',
            `${iterator.cls.name}::getIterator() must return an object that implements Traversable`
          );
        iterator = result;
      }
      if (!iterator.cls.isSubclassOf(classes.get('recursiveiterator') as PhpClass))
        throwError(
          'InvalidArgumentException',
          'An instance of RecursiveIterator or IteratorAggregate creating it is required'
        );
      const state = stateOf(thisObj);
      state.levels = [{ object: iterator, iterator: innerIteratorOf(iterator), step: Step.Start }];
      state.mode = Number(args[1] ?? 0n);
      state.flags = Number(((args[2] as bigint | undefined) ?? 0n) & BigInt(CATCH_GET_CHILD));
      state.maxDepth = -1;
      state.inIteration = false;
      return null;
    },
  },
  { signature: 'rewind(): void', impl: ({ thisObj }) => (rewind(thisObj, stateOf(thisObj)), null) },
  { signature: 'valid(): bool', impl: ({ thisObj }) => validAt(thisObj, stateOf(thisObj)) },
  { signature: 'key(): mixed', impl: ({ thisObj }) => stateOf(thisObj).top.iterator.key() },
  { signature: 'current(): mixed', impl: ({ thisObj }) => stateOf(thisObj).top.iterator.current() },
  { signature: 'next(): void', impl: ({ thisObj }) => (moveForward(thisObj, stateOf(thisObj)), null) },
  { signature: 'getDepth(): int', impl: ({ thisObj }) => BigInt(Math.max(stateOf(thisObj).depth, 0)) },
  {
    signature: 'getSubIterator(?int $level = null): ?RecursiveIterator',
    impl: ({ thisObj, args }) => {
      const state = stateOf(thisObj);
      const level = args[0] === undefined || args[0] === null ? state.depth : Number(args[0]);
      if (level < 0 || level > state.depth) return null;
      state.checkConstructed();
      return state.levels[level].object;
    },
  },
  { signature: 'getInnerIterator(): RecursiveIterator', impl: ({ thisObj }) => stateOf(thisObj).top.object },
  { signature: 'beginIteration(): void', impl: () => null },
  { signature: 'endIteration(): void', impl: () => null },
  {
    signature: 'callHasChildren(): bool',
    impl: ({ thisObj }) => {
      const state = stateOf(thisObj);
      if (state.levels.length === 0) return false;
      return callMethod(state.top.object, 'hasChildren', []);
    },
  },
  {
    signature: 'callGetChildren(): ?RecursiveIterator',
    impl: ({ thisObj }) => callMethod(stateOf(thisObj).top.object, 'getChildren', []),
  },
  { signature: 'beginChildren(): void', impl: () => null },
  { signature: 'endChildren(): void', impl: () => null },
  { signature: 'nextElement(): void', impl: () => null },
  {
    signature: 'setMaxDepth(int $maxDepth = -1): void',
    impl: ({ thisObj, args }) => {
      const maxDepth = Number(args[0] ?? -1n);
      if (maxDepth < -1)
        throwError(
          'ValueError',
          'RecursiveIteratorIterator::setMaxDepth(): Argument #1 ($maxDepth) must be greater than or equal to -1'
        );
      stateOf(thisObj).maxDepth = Math.min(maxDepth, 2_147_483_647);
      return null;
    },
  },
  {
    signature: 'getMaxDepth(): int|false',
    impl: ({ thisObj }) => {
      const maxDepth = stateOf(thisObj).maxDepth;
      return maxDepth === -1 ? false : BigInt(maxDepth);
    },
  },
];

defineClass({
  name: 'RecursiveIteratorIterator',
  interfaces: ['OuterIterator', 'Traversable', 'Iterator'],
  consts: {
    LEAVES_ONLY: BigInt(LEAVES_ONLY),
    SELF_FIRST: BigInt(SELF_FIRST),
    CHILD_FIRST: BigInt(CHILD_FIRST),
    CATCH_GET_CHILD: BigInt(CATCH_GET_CHILD),
  },
  methods: recursiveMethods,
  createInternal: (object) => new RecursiveState(object.cls.name),
});
