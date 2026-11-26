import type { Frame, Suspension } from '../runtime';
import { KObject, UNIT, type Value } from '../values';
import { defineNative, defineSuspendNative, libraryClass, throwError } from './registry';

/**
 * Where a sequence builder's iterator is, as kotlin.sequences.SequenceBuilderIterator's states say: waiting to resume
 * its block, holding an element its block yielded, done when the block ended, and failed while the block runs or after
 * it threw, when asking for more throws, as the block cannot resume.
 */
type BuilderPhase = { kind: 'notReady' } | { kind: 'ready'; value: Value } | { kind: 'done' } | { kind: 'failed' };

/**
 * A sequence builder's coroutine: the generator of its block, which runs only while a consumer asks for the next
 * element, the frames it had pushed when it last suspended, which leave the runtime's stack until it resumes, and its
 * phase, which only `advance` and `next` change.
 */
interface BuilderState {
  block: KObject;
  coroutine: Suspension | undefined;
  frames: Frame[];
  phase: BuilderPhase;
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
    phase: { kind: 'notReady' },
  };
  iterator.native = state as unknown as Record<string, unknown>;
  return iterator;
});

/** Resumes the builder's block until it yields an element or ends, as `hasNext` does. */
function advance(frame: Frame, receiver: Value): boolean {
  const state = stateOf(receiver);
  switch (state.phase.kind) {
    case 'ready': {
      return true;
    }
    case 'done': {
      return false;
    }
    case 'failed': {
      return throwError(frame, 'java.lang.IllegalStateException', 'Iterator has failed.');
    }
    case 'notReady': {
      break;
    }
  }
  const { runtime } = frame;
  const base = runtime.frames.length;
  runtime.frames.push(...state.frames);
  // Failed until the block suspends or ends, so that resuming it from inside fails and a throw leaves it failed.
  state.phase = { kind: 'failed' };
  try {
    if (!state.coroutine) {
      const run = state.block.suspendFunction;
      if (!run) throw new Error('A sequence builder without its block');
      state.coroutine = run(frame as never, [receiver]);
    }
    const step = state.coroutine.next();
    state.phase = step.done ? { kind: 'done' } : { kind: 'ready', value: step.value };
  } finally {
    state.frames = runtime.frames.splice(base);
  }
  return state.phase.kind === 'ready';
}

defineNative('kotlin.sequences.SequenceBuilderIterator.hasNext()', (frame, receiver) => advance(frame, receiver));
defineNative('kotlin.sequences.SequenceBuilderIterator.next()', (frame, receiver) => {
  if (!advance(frame, receiver)) return throwError(frame, 'java.util.NoSuchElementException');
  const state = stateOf(receiver);
  const { value } = state.phase as { kind: 'ready'; value: Value };
  state.phase = { kind: 'notReady' };
  return value;
});
defineSuspendNative('kotlin.sequences.SequenceBuilderIterator.yield(T)', function* (_caller, _receiver, [value]) {
  yield value;
  return UNIT;
});
