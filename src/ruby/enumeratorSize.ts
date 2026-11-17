import { compareValues, toIndexExact, tryImplicitConversion } from './conversions';
import { argumentError } from './errors';
import { callMethod, type Gen } from './interp';
import { floorDiv } from './libNumeric';
import { isRubyFloat, NIL, type RObject, type Value } from './objects';

export function* customReceiverSize(recv: RObject): Gen<Value> {
  return (yield* tryImplicitConversion(recv, 'size')) ?? NIL;
}

export function* windowSize(base: Value, method: 'each_slice' | 'each_cons', requested: Value): Gen<Value> {
  const slice = method === 'each_slice';
  const count = (yield* toIndexExact(requested)).integer;
  if (count <= 0n) throw argumentError(slice ? 'invalid slice size' : 'invalid size');
  if (typeof base === 'bigint') {
    if (!slice) return base >= count ? base - count + 1n : 0n;
    const numerator = base + count - 1n;
    return floorDiv(numerator, count);
  }
  if (slice && isRubyFloat(base) && Math.abs(Number(base)) === Infinity) return base;
  const adjusted = yield* callMethod(base, '+', [slice ? count - 1n : 1n - count]);
  if (slice) return yield* callMethod(adjusted, 'div', [count]);
  return (yield* compareValues(adjusted, 0n)) < 0 ? 0n : adjusted;
}

export function* cycleSize(getSize: () => Gen<Value>, requested?: Value): Gen<Value> {
  const count = requested === undefined || requested === NIL ? undefined : (yield* toIndexExact(requested)).integer;
  const base = yield* getSize();
  if (base === NIL || base === 0n) return base;
  if (count === undefined) return Number.POSITIVE_INFINITY;
  if (count <= 0n) return 0n;
  return typeof base === 'bigint' ? base * count : yield* callMethod(base, '*', [count]);
}
