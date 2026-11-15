import { toIndexExact } from './conversions';
import { argumentError, typeError } from './errors';
import { callMethod, type Gen, respondsTo } from './interp';
import { isRubyFloat, NIL, type RObject, RString, type Value } from './objects';
import { rt, RubyError } from './runtime';
import { classOf, sym, truthy } from './values';

export function* customReceiverSize(recv: RObject): Gen<Value> {
  const responder = respondsTo(recv, 'respond_to?', true);
  const declared = respondsTo(recv, 'size', true);
  const missing = classOf(recv).findMethod('method_missing');
  const available = responder
    ? truthy(yield* callMethod(recv, 'respond_to?', [sym('size'), true], undefined, undefined, { fcall: true }))
    : declared || (missing !== undefined && missing.body.kind !== 'native');
  if (!available) return NIL;
  try {
    return yield* callMethod(recv, 'size', [], undefined, undefined, { fcall: true });
  } catch (error) {
    if (
      !responder &&
      !declared &&
      error instanceof RubyError &&
      error.exception.cls === rt().c.NoMethodError &&
      error.exception.ivars?.get('@__name') === sym('size') &&
      error.exception.ivars.get('@__receiver') === recv
    )
      return NIL;
    throw error;
  }
}

export function* windowSize(base: Value, method: 'each_slice' | 'each_cons', requested: Value): Gen<Value> {
  const slice = method === 'each_slice';
  const count = (yield* toIndexExact(requested)).integer;
  if (count <= 0n) throw argumentError(slice ? 'invalid slice size' : 'invalid size');
  if (typeof base === 'bigint') return slice ? (base + count - 1n) / count : base >= count ? base - count + 1n : 0n;
  if (isRubyFloat(base) && Number(base) === Infinity) return base;
  if (base instanceof RString) throw typeError('no implicit conversion of Integer into String');
  if (slice) return yield* callMethod(yield* callMethod(base, '/', [count]), 'ceil', []);
  const size = yield* callMethod(yield* callMethod(base, '-', [count]), '+', [1n]);
  return truthy(yield* callMethod(size, '<', [0n])) ? 0n : size;
}

export function* cycleSize(base: Value, requested?: Value): Gen<Value> {
  if (base === NIL) return NIL;
  if (base === 0n) return 0n;
  const count = requested === undefined || requested === NIL ? undefined : (yield* toIndexExact(requested)).integer;
  if (count !== undefined && count <= 0n) return 0n;
  if (count === undefined) return base === 0n ? 0n : Number.POSITIVE_INFINITY;
  return typeof base === 'bigint' ? base * count : yield* callMethod(base, '*', [count]);
}
