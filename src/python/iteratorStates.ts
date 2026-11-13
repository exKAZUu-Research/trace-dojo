// The positions of CPython's builtin iterators, which `__reduce__` gives for pickle and copy, and `__setstate__` moves.
import { currentRuntime } from './runtimeContext';
import { newTuple, typeError, unbox } from './types';
import type { DONE, PyValue } from './values';

type NextFunction = () => PyValue | typeof DONE;

/** How a native iterator reduces, and, for one CPython's `__setstate__` moves, how a state moves it. */
export interface IteratorState {
  reduce: () => PyValue;
  setState?: (index: bigint) => void;
}

const states = new WeakMap<NextFunction, IteratorState>();

/** Records how an iterator's next function reduces and moves. */
export function withState(next: NextFunction, state: IteratorState): NextFunction {
  states.set(next, state);
  return next;
}

export function stateOf(next: NextFunction): IteratorState | undefined {
  return states.get(next);
}

/** `(callable, args)` or `(callable, args, state)`, with the builtin of `name` as the callable. */
export function reduction(name: 'iter' | 'reversed', args: PyValue[], state?: PyValue): PyValue {
  const callable = currentRuntime().builtins.get(name) as PyValue;
  return state === undefined ? newTuple([callable, newTuple(args)]) : newTuple([callable, newTuple(args), state]);
}

/** The index a `__setstate__` argument gives, which must be an int. */
export function stateIndex(value: PyValue): bigint {
  const primitive = unbox(value);
  if (typeof primitive === 'bigint') return primitive;
  if (typeof primitive === 'boolean') return primitive ? 1n : 0n;
  throw typeError('an integer is required');
}

/** An index within `[low, high]`, as CPython's `__setstate__` methods clamp the index they are given. */
export function clamp(index: bigint, low: number, high: number): number {
  return index < BigInt(low) ? low : index > BigInt(high) ? high : Number(index);
}
