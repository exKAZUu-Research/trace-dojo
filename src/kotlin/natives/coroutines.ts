import type { Frame, Suspension } from '../runtime';
import { KObject, NULL, type Value } from '../values';
import { defineNative, defineSuspendNative, libraryClass, throwError } from './registry';

/**
 * A sequence builder's coroutine: the generator of its block, which runs only while a consumer asks for the next
 * element, and the frames it had pushed when it last suspended, which leave the runtime's stack until it resumes.
 */
interface BuilderState {
  block: KObject;
  coroutine: Suspension | undefined;
  frames: Frame[];
  next: { value: Value } | undefined;
  isDone: boolean;
}

function stateOf(receiver: Value): BuilderState {
  return (receiver as KObject).native as unknown as BuilderState;
}

defineNative('kotlin.sequences.iterator(SequenceScope<T>.() -> Unit)', (_frame, _receiver, [block]) => {
  const iterator = new KObject(libraryClass('kotlin.sequences.SequenceBuilderIterator'));
  const state: BuilderState = {
    block: block as KObject,
    coroutine: undefined,
    frames: [],
    next: undefined,
    isDone: false,
  };
  iterator.native = state as unknown as Record<string, unknown>;
  return iterator;
});

/** Resumes the builder's block until it yields an element or ends, as `hasNext` does. */
function advance(frame: Frame, receiver: Value): boolean {
  const state = stateOf(receiver);
  if (state.next) return true;
  if (state.isDone) return false;
  const { runtime } = frame;
  const base = runtime.frames.length;
  runtime.frames.push(...state.frames);
  try {
    if (!state.coroutine) {
      const run = state.block.suspendFunction;
      if (!run) throw new Error('A sequence builder without its block');
      state.coroutine = run(frame as never, [receiver]);
    }
    const step = state.coroutine.next();
    if (step.done) state.isDone = true;
    else state.next = { value: step.value };
  } catch (error) {
    state.isDone = true;
    throw error;
  } finally {
    state.frames = runtime.frames.splice(base);
  }
  return !state.isDone;
}

defineNative('kotlin.sequences.SequenceBuilderIterator.hasNext()', (frame, receiver) => advance(frame, receiver));
defineNative('kotlin.sequences.SequenceBuilderIterator.next()', (frame, receiver) => {
  if (!advance(frame, receiver)) return throwError(frame, 'java.util.NoSuchElementException');
  const state = stateOf(receiver);
  const { value } = state.next as { value: Value };
  state.next = undefined;
  return value;
});
defineSuspendNative('kotlin.sequences.SequenceBuilderIterator.yield(T)', function* (_caller, _receiver, [value]) {
  yield value;
  return NULL;
});
