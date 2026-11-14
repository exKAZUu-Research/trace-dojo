import type { Entity } from '../entities';
import { currentRuntime, definePackage, genericFunction, genericNamedType, typeParam } from '../native';
import { type Frame, runToEnd, type Suspending } from '../runtime';
import { nilPointerPanic } from '../runtimeErrors';
import { BASIC, EMPTY_INTERFACE, funcType, type NamedType, type Type } from '../types';
import { GoFunc, type Value } from '../values';
import { zeroValueOf } from '../zero';

/** `iter.Seq[V]`: `func(yield func(V) bool)`. */
const SEQ = genericNamedType('iter', 'Seq', [typeParam('V', EMPTY_INTERFACE)], ([value]) =>
  funcType([funcType([value], [BASIC.bool])], [])
);

/** `iter.Seq2[K, V]`: `func(yield func(K, V) bool)`. */
const SEQ2 = genericNamedType(
  'iter',
  'Seq2',
  [typeParam('K', EMPTY_INTERFACE), typeParam('V', EMPTY_INTERFACE)],
  ([key, value]) => funcType([funcType([key, value], [BASIC.bool])], [])
);

export const seqOf = (value: Type): NamedType => SEQ.instance([value]);
export const seq2Of = (key: Type, value: Type): NamedType => SEQ2.instance([key, value]);

/** What the iterator running under Pull yields when it hands over values. */
interface Pulled {
  reason: 'pull';
  values: Value[];
}

/**
 * `iter.Pull`: runs the iterator as a coroutine with frames of its own, which `next` resumes until the iterator's
 * yield hands over the next values; `stop` makes yield return false and lets the iterator finish.
 */
// code-gauge-allow functionCognitiveComplexity 20 -- The protocol of Pull, which resumes and stops a coroutine.
function pull(sequence: Value, zeros: (() => Value)[]): Value[] {
  if (!(sequence instanceof GoFunc)) nilPointerPanic();
  const runtime = currentRuntime();
  const frames: Frame[] = [];
  let coroutine: Suspending<unknown> | undefined;
  let done = false;
  const finished = (): Value[] => [...zeros.map((zero) => zero()), false];
  const yieldFunction = new GoFunc(
    () => {
      throw new Error('iter.Pull resumes its iterator as a coroutine');
    },
    [],
    function* (args): Suspending<Value> {
      const pulled: Pulled = { reason: 'pull', values: args };
      return (yield pulled) as Value;
    }
  );
  const step = (send: unknown): IteratorResult<unknown, unknown> => {
    const outer = runtime.frames;
    runtime.frames = frames;
    try {
      return (coroutine as Suspending<unknown>).next(send);
    } catch (error) {
      done = true;
      throw error;
    } finally {
      runtime.frames = outer;
    }
  };
  const resumeNext = function* (): Suspending<Value[]> {
    if (done) return finished();
    let send: unknown = coroutine ? true : undefined;
    coroutine ??= sequence.resume
      ? sequence.resume([yieldFunction])
      : (function* () {
          return sequence.call([yieldFunction]);
        })();
    for (;;) {
      const result = step(send);
      if (result.done) {
        done = true;
        return finished();
      }
      const value = result.value as Pulled | { reason: string };
      if ('values' in value) return [...value.values, true];
      // The iterator blocked its goroutine, which waits here as a whole.
      send = yield value;
    }
  };
  const stop = function* (): Suspending<undefined> {
    if (done || !coroutine) {
      done = true;
      return undefined;
    }
    let send: unknown = false;
    for (;;) {
      const result = step(send);
      if (result.done) break;
      const value = result.value as Pulled | { reason: string };
      send = 'values' in value ? false : yield value;
    }
    done = true;
    return undefined;
  };
  return [
    new GoFunc(
      () => runToEnd(resumeNext()),
      [sequence, frames],
      () => resumeNext()
    ),
    new GoFunc(
      () => runToEnd(stop()),
      [sequence, frames],
      () => stop()
    ),
  ];
}

const V = typeParam('V', EMPTY_INTERFACE);
const K2 = typeParam('K', EMPTY_INTERFACE);
const V2 = typeParam('V', EMPTY_INTERFACE);

const members: Record<string, Entity> = {
  Seq: SEQ.entity,
  Seq2: SEQ2.entity,
  Pull: genericFunction(
    'Pull',
    [V],
    funcType([seqOf(V)], [funcType([], [V, BASIC.bool]), funcType([], [])]),
    ([value]) =>
      ([sequence]) =>
        pull(sequence, [zeroValueOf(value)])
  ),
  Pull2: genericFunction(
    'Pull2',
    [K2, V2],
    funcType([seq2Of(K2, V2)], [funcType([], [K2, V2, BASIC.bool]), funcType([], [])]),
    ([key, value]) =>
      ([sequence]) =>
        pull(sequence, [zeroValueOf(key), zeroValueOf(value)])
  ),
};

export const ITER_PACKAGE = definePackage('iter', members);

export function iteratorOf(iterate: () => Iterable<Value[]>, captured: Value[] = []): GoFunc {
  const resume = function* ([callback]: Value[]): Suspending<Value> {
    if (!(callback instanceof GoFunc)) nilPointerPanic();
    for (const values of iterate()) {
      currentRuntime().spend();
      const next = callback.resume ? yield* callback.resume(values) : callback.call(values);
      if (next !== true) break;
    }
    return undefined;
  };
  return new GoFunc((args) => runToEnd(resume(args)), captured, resume);
}
