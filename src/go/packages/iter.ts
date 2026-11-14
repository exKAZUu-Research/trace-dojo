import type { Entity } from '../entities';
import { currentRuntime, definePackage, genericFunction, genericNamedType, nativeFunc, typeParam } from '../native';
import { type Blocked, type Frame, runToEnd, type Suspending } from '../runtime';
import { nilPointerPanic } from '../runtimeErrors';
import { BASIC, EMPTY_INTERFACE, funcType, type NamedType, type Type } from '../types';
import { GoFunc, type Value } from '../values';
import { zeroValue } from './reflection';
import { resumeFunction, stringPanic } from './support';

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
function pull(sequence: Value, zeros: (() => Value)[]): Value[] {
  return new PullSequence(sequence, zeros).functions();
}

class PullSequence {
  private readonly runtime = currentRuntime();
  private readonly frames: Frame[] = [];
  private readonly nativeRoots: (readonly unknown[])[] = [];
  private coroutine: Suspending<unknown> | undefined;
  private done = false;
  private nextActive = false;
  private yieldNext = false;
  private readonly yieldFunction: GoFunc;
  private readonly roots: unknown[] = [];

  constructor(
    private sequence: Value,
    private readonly zeros: (() => Value)[]
  ) {
    this.roots.push(sequence, this.frames, this.nativeRoots);
    this.yieldFunction = nativeFunc(
      () => {
        throw new Error('iter.Pull resumes its iterator as a coroutine');
      },
      [this.roots],
      (args) => this.yieldValues(args)
    );
  }

  functions(): Value[] {
    const roots = [this.roots];
    return [
      nativeFunc(
        () => runToEnd(this.next()),
        roots,
        () => this.next()
      ),
      nativeFunc(
        () => runToEnd(this.stop()),
        roots,
        () => this.stop()
      ),
    ];
  }

  private *yieldValues(args: Value[]): Suspending<Value> {
    if (this.done) return false;
    if (!this.yieldNext) stringPanic(`${this.name}: yield called again before next`);
    this.yieldNext = false;
    const pulled: Pulled = { reason: 'pull', values: args };
    return (yield pulled) as Value;
  }

  private *next(): Suspending<Value[]> {
    if (this.nextActive) stringPanic(`${this.name}: next called again before yield`);
    if (this.done) return this.finished();
    this.nextActive = true;
    this.yieldNext = true;
    try {
      const sequence = this.sequence;
      if (!(sequence instanceof GoFunc)) {
        this.finish();
        nilPointerPanic();
      }
      let send: unknown = this.coroutine ? true : undefined;
      this.coroutine ??= resumeFunction(sequence, [this.yieldFunction]);
      for (;;) {
        const result = this.step(send);
        if (result.done) {
          this.finish();
          return this.finished();
        }
        const value = result.value as Pulled | { reason: string };
        if ('values' in value) return [...value.values, true];
        send = yield value;
      }
    } finally {
      this.nextActive = false;
    }
  }

  private *stop(): Suspending<undefined> {
    if (this.done) return undefined;
    this.done = true;
    if (!this.coroutine) {
      this.finish();
      return undefined;
    }
    let send: unknown = false;
    for (;;) {
      const result = this.step(send);
      if (result.done) {
        this.finish();
        return undefined;
      }
      send = yield result.value as { reason: string };
    }
  }

  private step(send: unknown): IteratorResult<unknown, unknown> {
    const outer = this.runtime.frames;
    const outerRoots = this.runtime.nativeRoots;
    this.runtime.frames = this.frames;
    this.runtime.nativeRoots = this.nativeRoots;
    try {
      return (this.coroutine as Suspending<unknown>).next(send);
    } catch (error) {
      this.finish();
      throw error;
    } finally {
      this.runtime.frames = outer;
      this.runtime.nativeRoots = outerRoots;
    }
  }

  private finish(): void {
    this.done = true;
    this.coroutine = undefined;
    this.sequence = undefined;
    this.roots.length = 0;
  }

  private finished(): Value[] {
    return [...this.zeros.map((zero) => zero()), false];
  }
  private get name(): string {
    return this.zeros.length === 2 ? 'iter.Pull2' : 'iter.Pull';
  }
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
        pull(sequence, [() => zeroValue(value)])
  ),
  Pull2: genericFunction(
    'Pull2',
    [K2, V2],
    funcType([seq2Of(K2, V2)], [funcType([], [K2, V2, BASIC.bool]), funcType([], [])]),
    ([key, value]) =>
      ([sequence]) =>
        pull(sequence, [() => zeroValue(key), () => zeroValue(value)])
  ),
};

export const ITER_PACKAGE = definePackage('iter', members);

export function iteratorOf(iterate: () => Iterable<Value[] | Blocked>, captured: Value[] = []): GoFunc {
  const resume = function* ([callback]: Value[]): Suspending<Value> {
    if (!(callback instanceof GoFunc)) nilPointerPanic();
    const iterator = iterate()[Symbol.iterator]();
    let send: unknown;
    try {
      for (;;) {
        const result = iterator.next(send);
        if (result.done) break;
        if (Array.isArray(result.value)) {
          currentRuntime().spend();
          if ((yield* resumeFunction(callback, result.value)) !== true) break;
          send = undefined;
        } else send = yield result.value;
      }
    } finally {
      iterator.return?.();
    }
    return undefined;
  };
  return nativeFunc((args) => runToEnd(resume(args)), captured, resume);
}
