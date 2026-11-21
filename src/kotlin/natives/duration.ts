import type { Frame } from '../runtime';
import { defineNative, throwError } from './registry';

const MILLIS_IN_NANOS = 1_000_000n;
const LONG_MAX = (1n << 63n) - 1n;
const LONG_MIN = -(1n << 63n);
const MAX_MILLIS = LONG_MAX >> 1n;
const MAX_NANOS = (MAX_MILLIS / MILLIS_IN_NANOS) * MILLIS_IN_NANOS - 1n;
const POSITIVE_INFINITY = (MAX_MILLIS << 1n) | 1n;
const NEGATIVE_INFINITY = (-MAX_MILLIS << 1n) | 1n;

function defineDurations(): void {
  const scope = 'kotlin.time';
  defineNative(`${scope}.durationFromLong(Long, Long)`, (_frame, _receiver, [value, unit]) =>
    fromNanos((value as bigint) * (unit as bigint))
  );
  defineNative(`${scope}.durationFromDouble(Double, Long)`, (frame, _receiver, [value, unit]) =>
    fromDouble(frame, value as number, unit as bigint)
  );
  defineNative(`${scope}.durationPlus(Long, Long)`, (frame, _receiver, [left, right]) =>
    addDuration(frame, left as bigint, right as bigint)
  );
  defineNative(`${scope}.durationTimes(Long, Int)`, (frame, _receiver, [raw, scale]) =>
    multiplyDuration(frame, raw as bigint, BigInt(scale as number))
  );
  defineNative(`${scope}.durationDiv(Long, Int)`, (frame, _receiver, [raw, scale]) =>
    divideDuration(frame, raw as bigint, BigInt(scale as number))
  );
  defineNative(`${scope}.durationRatio(Long, Long)`, (_frame, _receiver, [left, right]) => {
    const a = left as bigint;
    const b = right as bigint;
    const unit = storageUnit(a | b);
    return toDouble(a, unit) / toDouble(b, unit);
  });
  defineNative(`${scope}.durationCompare(Long, Long)`, (_frame, _receiver, [left, right]) => {
    const a = nanosOf(left as bigint);
    const b = nanosOf(right as bigint);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  defineNative(`${scope}.durationToDouble(Long, Long)`, (_frame, _receiver, [raw, unit]) =>
    toDouble(raw as bigint, unit as bigint)
  );
  defineNative(`${scope}.durationToLong(Long, Long)`, (_frame, _receiver, [raw, unit]) =>
    toLong(raw as bigint, unit as bigint)
  );
  defineNative(`${scope}.durationSubsecondNanos(Long)`, (_frame, _receiver, [raw]) =>
    Number(nanosOf(raw as bigint) % 1_000_000_000n)
  );
}

function fromDouble(frame: Frame, value: number, unit: bigint): bigint {
  if (Number.isNaN(value)) throwError(frame, 'java.lang.IllegalArgumentException', 'Duration value cannot be NaN.');
  if (!Number.isFinite(value)) return infinity(value > 0);
  const nanos = Math.round(scaleUnits(value, unit, 1n));
  if (Number.isFinite(nanos)) {
    const integer = BigInt(nanos);
    if (within(integer, MAX_NANOS)) return integer << 1n;
  }
  const millis = Math.round(scaleUnits(value, unit, MILLIS_IN_NANOS));
  if (!Number.isFinite(millis)) return infinity(value > 0);
  return fromNanos(BigInt(millis) * MILLIS_IN_NANOS);
}

function addDuration(frame: Frame, left: bigint, right: bigint): bigint {
  if (isInfinite(left)) {
    if (isInfinite(right) && left !== right)
      throwError(
        frame,
        'java.lang.IllegalArgumentException',
        'Summing infinite durations of different signs yields an undefined result.'
      );
    return left;
  }
  if (isInfinite(right)) return right;
  const a = storageUnit(left);
  const b = storageUnit(right);
  if (a === b) return fromNanos(nanosOf(left) + nanosOf(right));
  const nanos = a === 1n ? left >> 1n : right >> 1n;
  const millis = a === 1n ? right >> 1n : left >> 1n;
  const totalMillis = millis + nanos / MILLIS_IN_NANOS;
  const normalized = totalMillis * MILLIS_IN_NANOS;
  return fromNanos(within(normalized, MAX_NANOS) ? normalized + (nanos % MILLIS_IN_NANOS) : normalized);
}

function multiplyDuration(frame: Frame, raw: bigint, scale: bigint): bigint {
  if (isInfinite(raw)) {
    if (scale === 0n)
      throwError(
        frame,
        'java.lang.IllegalArgumentException',
        'Multiplying infinite duration by zero yields an undefined result.'
      );
    return infinity(raw > 0n === scale > 0n);
  }
  return fromNanos(nanosOf(raw) * scale);
}

function divideDuration(frame: Frame, raw: bigint, scale: bigint): bigint {
  if (scale === 0n) {
    if (raw === 0n)
      throwError(
        frame,
        'java.lang.IllegalArgumentException',
        'Dividing zero duration by zero yields an undefined result.'
      );
    return infinity(raw > 0n);
  }
  if (isInfinite(raw)) return infinity(raw > 0n === scale > 0n);
  return fromNanos(nanosOf(raw) / scale);
}

function toDouble(raw: bigint, unit: bigint): number {
  if (isInfinite(raw)) return raw > 0n ? Infinity : -Infinity;
  return scaleUnits(Number(raw >> 1n), storageUnit(raw), unit);
}

function toLong(raw: bigint, unit: bigint): bigint {
  if (isInfinite(raw)) return raw > 0n ? LONG_MAX : LONG_MIN;
  const amount = nanosOf(raw) / unit;
  return amount > LONG_MAX ? LONG_MAX : amount < LONG_MIN ? LONG_MIN : amount;
}

function scaleUnits(amount: number, from: bigint, to: bigint): number {
  return from > to ? amount * Number(from / to) : amount / Number(to / from);
}

function fromNanos(nanos: bigint): bigint {
  if (within(nanos, MAX_NANOS)) return nanos << 1n;
  const millis = nanos / MILLIS_IN_NANOS;
  if (!within(millis, MAX_MILLIS)) return infinity(millis > 0n);
  return (millis << 1n) | 1n;
}

function nanosOf(raw: bigint): bigint {
  return (raw >> 1n) * storageUnit(raw);
}

function storageUnit(raw: bigint): bigint {
  return (raw & 1n) === 0n ? 1n : MILLIS_IN_NANOS;
}

function isInfinite(raw: bigint): boolean {
  return raw === POSITIVE_INFINITY || raw === NEGATIVE_INFINITY;
}

function infinity(isPositive: boolean): bigint {
  return isPositive ? POSITIVE_INFINITY : NEGATIVE_INFINITY;
}

function within(value: bigint, maximum: bigint): boolean {
  return value >= -maximum && value <= maximum;
}

defineDurations();
