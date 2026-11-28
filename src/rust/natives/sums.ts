import { floatNumber } from '../floatBits';
import { normalize } from '../infer';
import { wrap } from '../ops';
import { shallow, type Type } from '../types';
import { DONE, DurationValue, type IterValue, MAX_DURATION, type Value } from '../values';
import { foldingView, nextOf, sumOfOutcomes } from './iterators';
import { deref, libraryPanic, type NativeContext, unsupportedAtRun } from './support';

/** `Iterator::sum` or `product` of numbers, `Duration`s, or `Result`s and `Option`s of them. */
export function sumOrProduct(ctx: NativeContext, iter: IterValue, type: Type, op: '+' | '*'): Value {
  const t = normalize(shallow(type));
  if (t.kind === 'adt' && (t.def.builtin === 'Result' || t.def.builtin === 'Option')) {
    return sumOfOutcomes(ctx, iter, t, op);
  }
  const step = stepOf(ctx, t, op);
  let total: Value =
    t.kind === 'adt'
      ? new DurationValue(0n)
      : op === '+'
        ? t.kind === 'float'
          ? -0
          : 0n
        : t.kind === 'float'
          ? 1
          : 1n;
  const source = foldingView(iter);
  for (;;) {
    ctx.runtime.spend();
    const item = nextOf(source);
    if (item === DONE) return total;
    total = step(total, item);
  }
}

/** One step of a sum or product of a type: a `Duration`'s, a float's, or an integer's. */
function stepOf(ctx: NativeContext, t: Type, op: '+' | '*'): (total: Value, item: Value) => Value {
  if (t.kind === 'adt') return (total, item) => durationStep(ctx, total, item);
  if (t.kind === 'float') return (total, item) => floatStep(t.name, op, floatNumber(total), floatNumber(item));
  return (total, item) => intStep(ctx, t, op, total as bigint, deref(item) as bigint);
}

/** One step of a sum of `Duration`s; one past the longest `Duration`, where std panics inside its `Sum` impl, is unsupported. */
function durationStep(ctx: NativeContext, total: Value, item: Value): DurationValue {
  const sum = (total as DurationValue).nanos + (deref(item) as DurationValue).nanos;
  if (sum > MAX_DURATION) unsupportedAtRun(ctx, 'Duration の範囲を超える計算');
  return new DurationValue(sum);
}

function floatStep(name: 'f32' | 'f64', op: '+' | '*', total: number, value: number): number {
  const result = op === '+' ? total + value : total * value;
  return name === 'f32' ? Math.fround(result) : result;
}

/** One step of an integer sum or product, which panics inside the library's `Sum` and `Product` impls on overflow. */
function intStep(ctx: NativeContext, type: Type, op: '+' | '*', total: bigint, value: bigint): bigint {
  const result = op === '+' ? total + value : total * value;
  if (result !== wrap((type as { name: 'i32' }).name, result)) {
    libraryPanic(
      ctx,
      `attempt to ${op === '+' ? 'add' : 'multiply'} with overflow`,
      'core/src/iter/traits/accum.rs:206:1'
    );
  }
  return result;
}
