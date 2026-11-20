import { defineNatives, type NativeCall } from '../natives';
import { type CsArray, CsObject, type Value } from '../values';
import { fail, failNull, failOutOfRange, libraryType, newArray, typeArgument } from './support';

const INT_MAX = 2_147_483_647;

/** A source of `Random`'s samples: integers in [0, int.MaxValue). */
interface RandomSource {
  sample(): number;
}

/**
 * The generator of a seeded `Random`, transcribed from .NET's `Net5CompatSeedImpl` (Knuth's subtractive method) so that
 * a seed gives the same numbers as .NET.
 */
class SeededSource implements RandomSource {
  private readonly seeds = Array.from({ length: 56 }, () => 0);
  private next = 0;
  private nextP = 21;

  constructor(seed: number) {
    const subtraction = seed === -2_147_483_648 ? INT_MAX : Math.abs(seed);
    let mj = 161_803_398 - subtraction;
    this.seeds[55] = mj;
    let mk = 1;
    let ii = 0;
    for (let i = 1; i < 55; i++) {
      ii += 21;
      if (ii >= 55) ii -= 55;
      this.seeds[ii] = mk;
      mk = mj - mk;
      if (mk < 0) mk += INT_MAX;
      mj = this.seeds[ii];
    }
    for (let k = 1; k < 5; k++) {
      for (let i = 1; i < 56; i++) {
        let n = i + 30;
        if (n >= 55) n -= 55;
        this.seeds[i] -= this.seeds[1 + n];
        if (this.seeds[i] < 0) this.seeds[i] += INT_MAX;
      }
    }
  }

  sample(): number {
    let next = this.next + 1;
    if (next >= 56) next = 1;
    let nextP = this.nextP + 1;
    if (nextP >= 56) nextP = 1;
    let result = this.seeds[next] - this.seeds[nextP];
    if (result === INT_MAX) result--;
    if (result < 0) result += INT_MAX;
    this.seeds[next] = result;
    this.next = next;
    this.nextP = nextP;
    return result;
  }
}

/** The generator of an unseeded `Random`, whose numbers .NET does not fix either. */
class UnseededSource implements RandomSource {
  sample(): number {
    return Math.floor(Math.random() * INT_MAX);
  }
}

function sourceOf(value: Value): RandomSource {
  if (value === undefined)
    fail('System.NullReferenceException', 'Object reference not set to an instance of an object.');
  return (value as CsObject).native as RandomSource;
}

const toDouble = (source: RandomSource): number => source.sample() * (1 / INT_MAX);

function nextBelow(source: RandomSource, maxValue: number): number {
  return Math.trunc(toDouble(source) * maxValue);
}

function nextBetween(source: RandomSource, minValue: number, maxValue: number): number {
  const range = maxValue - minValue;
  if (range <= INT_MAX) return Math.trunc(toDouble(source) * range) + minValue;
  // .NET draws a wider sample for ranges beyond int.MaxValue.
  let result = source.sample();
  if (source.sample() % 2 === 0) result = -result;
  const wide = (result + (INT_MAX - 1)) / (2 * INT_MAX - 1);
  return Number(BigInt(Math.trunc(wide * range)) + BigInt(minValue));
}

function nextUInt64(source: RandomSource): bigint {
  return (
    BigInt(nextBelow(source, 1 << 22)) |
    (BigInt(nextBelow(source, 1 << 22)) << 22n) |
    (BigInt(nextBelow(source, 1 << 20)) << 44n)
  );
}

function nextInt64Between(source: RandomSource, minValue: bigint, maxValue: bigint): bigint {
  const range = maxValue - minValue;
  if (range <= 1n) return minValue;
  const bits = BigInt((range - 1n).toString(2).length);
  for (;;) {
    const result = nextUInt64(source) >> (64n - bits);
    if (result < range) return result + minValue;
  }
}

function checkMax(call: NativeCall, maxValue: number | bigint): void {
  if (maxValue < 0)
    failOutOfRange(call, 'maxValue', `maxValue ('${maxValue}') must be a non-negative value.`, String(maxValue));
}

function checkRange(call: NativeCall, minValue: number | bigint, maxValue: number | bigint): void {
  if (minValue > maxValue) failOutOfRange(call, 'minValue', "'minValue' cannot be greater than maxValue.");
}

function nextBytes(source: RandomSource, buffer: Value[]): void {
  for (let index = 0; index < buffer.length; index++) buffer[index] = source.sample() & 0xff;
}

/** Each run's `Random.Shared`, which lasts as long as the run. */
const shared = new WeakMap<object, CsObject>();

defineNatives({
  'System.Random..ctor()': (_call, receiver) => {
    (receiver as CsObject).native = new UnseededSource();
    return;
  },
  'System.Random..ctor(int)': (_call, receiver, [seed]) => {
    (receiver as CsObject).native = new SeededSource(seed as number);
    return;
  },
  'System.Random.get_Shared': (call) => {
    let random = shared.get(call.frame.runtime);
    if (!random) {
      random = new CsObject(libraryType(call, 'System.Random'), []);
      random.native = new UnseededSource();
      shared.set(call.frame.runtime, random);
    }
    return random;
  },
  'System.Random.Next()': (_call, receiver) => sourceOf(receiver).sample(),
  'System.Random.Next(int)': (call, receiver, [maxValue]) => {
    checkMax(call, maxValue as number);
    return nextBelow(sourceOf(receiver), maxValue as number);
  },
  'System.Random.Next(int, int)': (call, receiver, [minValue, maxValue]) => {
    checkRange(call, minValue as number, maxValue as number);
    return nextBetween(sourceOf(receiver), minValue as number, maxValue as number);
  },
  'System.Random.NextInt64()': (_call, receiver) => {
    for (;;) {
      const result = nextUInt64(sourceOf(receiver)) >> 1n;
      if (result !== 0x7f_ff_ff_ff_ff_ff_ff_ffn) return result;
    }
  },
  'System.Random.NextInt64(long)': (call, receiver, [maxValue]) => {
    checkMax(call, maxValue as bigint);
    return nextInt64Between(sourceOf(receiver), 0n, maxValue as bigint);
  },
  'System.Random.NextInt64(long, long)': (call, receiver, [minValue, maxValue]) => {
    checkRange(call, minValue as bigint, maxValue as bigint);
    return nextInt64Between(sourceOf(receiver), minValue as bigint, maxValue as bigint);
  },
  'System.Random.NextDouble': (_call, receiver) => toDouble(sourceOf(receiver)),
  'System.Random.NextSingle': (_call, receiver) => Math.fround(toDouble(sourceOf(receiver))),
  'System.Random.NextBytes': (_call, receiver, [buffer]) => {
    if (buffer === undefined) failNull('buffer');
    nextBytes(sourceOf(receiver), (buffer as CsArray).values);
    return;
  },
  'System.Random.Shuffle': (_call, receiver, [values]) => {
    if (values === undefined) failNull('values');
    const items = (values as CsArray).values;
    const source = sourceOf(receiver);
    for (let index = 0; index < items.length - 1; index++) {
      const other = nextBetween(source, index, items.length);
      if (other !== index) [items[index], items[other]] = [items[other], items[index]];
    }
    return;
  },
  'System.Random.GetItems': (call, receiver, [choices, length]) => {
    if (choices === undefined) failNull('choices');
    if ((length as number) < 0)
      failOutOfRange(call, 'length', `length ('${length}') must be a non-negative value.`, String(length));
    const options = (choices as CsArray).values;
    if (options.length === 0) fail('System.ArgumentException', 'Span may not be empty.', 'choices');
    const source = sourceOf(receiver);
    const result = Array.from<Value>({ length: length as number });
    for (let index = 0; index < result.length; index++) result[index] = options[nextBelow(source, options.length)];
    return newArray(call, typeArgument(call), result);
  },
});
