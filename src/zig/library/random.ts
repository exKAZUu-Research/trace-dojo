// code-gauge-allow-file duplicateLines 18 -- Library types repeat the same shape of method on purpose, each over its own state.
import { PANIC, panic } from '../arith';
/** `std.Random` with `DefaultPrng` (Xoshiro256), transcribed so that seeded sequences match Zig's. */
import type { Span } from '../ast';
import type { Frame } from '../runtime';
import { copyForStorage, known, runtime, type SemaApi, type TExpr } from '../semaBase';
import {
  arrayOf,
  BOOL,
  fitsInt,
  type IntType,
  intType,
  maxInt,
  sliceOf,
  type StructType,
  TYPE,
  type Type,
  typeName,
  U8,
  U64,
  USIZE,
  VOID,
  wrapInt,
} from '../types';
import { NativeHandle, type Pointer, type Slice, type Value, ZArray, ZStruct } from '../values';
import { storeSliceValue } from './common';
import { addMembers, compileArgs, expectArgs, fnMember, type Member, nativeStruct } from './native';

interface RandomSource {
  next: () => bigint;
}

const MASK = (1n << 64n) - 1n;

function rotl(value: bigint, amount: bigint): bigint {
  return ((value << amount) | (value >> (64n - amount))) & MASK;
}

function splitMix(state: { s: bigint }): bigint {
  state.s = (state.s + 0x9e_37_79_b9_7f_4a_7c_15n) & MASK;
  let z = state.s;
  z = ((z ^ (z >> 30n)) * 0xbf_58_47_6d_1c_e4_e5_b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94_d0_49_bb_13_31_11_ebn) & MASK;
  return z ^ (z >> 31n);
}

/** `Xoshiro256.next` on the state array `s`. */
function next(state: ZArray): bigint {
  const s = state.values() as bigint[];
  const result = (rotl((s[0] + s[3]) & MASK, 23n) + s[0]) & MASK;
  const t = (s[1] << 17n) & MASK;
  s[2] ^= s[0];
  s[3] ^= s[1];
  s[1] ^= s[2];
  s[0] ^= s[3];
  s[2] ^= t;
  s[3] = rotl(s[3], 45n);
  for (const [index, value] of s.entries()) state.set(index, value);
  return result;
}

/** `Xoshiro256.fill`: little-endian bytes of `next()`, a fresh one for a partial last word. */
function fill(state: RandomSource, count: number): number[] {
  const bytes: number[] = [];
  while (bytes.length < count) {
    let n = state.next();
    const take = Math.min(8, count - bytes.length);
    for (let index = 0; index < take; index++) {
      bytes.push(Number(n & 0xffn));
      n >>= 8n;
    }
  }
  return bytes;
}

/** `Random.int(T)`. */
function randomInt(state: RandomSource, type: IntType): bigint {
  const bytes = Math.ceil(type.bits / 8);
  const raw = fill(state, bytes);
  let value = 0n;
  for (let index = raw.length - 1; index >= 0; index--) value = (value << 8n) | BigInt(raw[index]);
  return wrapInt(BigInt.asUintN(type.bits, value), type);
}

/** `Random.uintLessThan(T, less_than)`, Lemire's method as Zig adapts it. */
function uintLessThan(state: RandomSource, type: IntType, lessThan: bigint): bigint {
  if (lessThan <= 0n) panic(PANIC.unreachable);
  const bits = BigInt(type.bits);
  const mask = (1n << bits) - 1n;
  let x = randomInt(state, type);
  let m = x * lessThan;
  let low = m & mask;
  if (low < lessThan) {
    let t = -lessThan & mask;
    if (t >= lessThan) {
      t -= lessThan;
      if (t >= lessThan) t %= lessThan;
    }
    while (low < t) {
      x = randomInt(state, type);
      m = x * lessThan;
      low = m & mask;
    }
  }
  return m >> bits;
}

/** `uintLessThanBiased`: `limitRangeBiased`, the high half of the product, without rejecting any value. */
function uintLessThanBiased(state: RandomSource, type: IntType, lessThan: bigint): bigint {
  if (lessThan <= 0n) panic(PANIC.unreachable);
  return (randomInt(state, type) * lessThan) >> BigInt(type.bits);
}

function uintAtMost(state: RandomSource, type: IntType, atMost: bigint, biased = false): bigint {
  if (atMost === maxInt(type)) return randomInt(state, type);
  return (biased ? uintLessThanBiased : uintLessThan)(state, type, atMost + 1n);
}

/** `intRangeLessThan` and `intRangeAtMost` and their biased variants, which work in the unsigned type of the same width. */
function intRange(
  state: RandomSource,
  type: IntType,
  atLeast: bigint,
  upper: bigint,
  inclusive: boolean,
  biased = false
): bigint {
  if (inclusive ? atLeast > upper : atLeast >= upper) panic(PANIC.unreachable);
  const unsigned = intType(false, type.bits);
  const lo = BigInt.asUintN(type.bits, atLeast);
  const hi = BigInt.asUintN(type.bits, upper);
  const span = BigInt.asUintN(type.bits, hi - lo);
  const offset = inclusive
    ? uintAtMost(state, unsigned, span, biased)
    : (biased ? uintLessThanBiased : uintLessThan)(state, unsigned, span);
  return wrapInt(lo + offset, type);
}

/** `weightedIndex` with integer proportions: a point below their sum, found in the running totals. */
function weightedIntIndex(state: RandomSource, type: IntType, proportions: bigint[]): bigint {
  const sum = proportions.reduce((total, value) => total + value, 0n);
  if (!fitsInt(sum, type)) panic(PANIC.overflow);
  const point = type.signed ? intRange(state, type, 0n, sum, false) : uintLessThan(state, type, sum);
  let accumulator = 0n;
  for (const [index, proportion] of proportions.entries()) {
    accumulator += proportion;
    if (point < accumulator) return BigInt(index);
  }
  return panic(PANIC.unreachable);
}

/** `weightedIndex` with float proportions: `@min(r.float(T) * sum, sum - floatEps(T))`, as Zig computes in `T`. */
function weightedFloatIndex(state: RandomSource, bits: 32 | 64, proportions: number[]): bigint {
  const round = (value: number): number => (bits === 32 ? Math.fround(value) : value);
  let sum = 0;
  for (const proportion of proportions) sum = round(sum + proportion);
  const epsilon = bits === 32 ? 2 ** -23 : 2 ** -52;
  const point = Math.min(round(randomFloat(state, bits) * sum), round(sum - epsilon));
  if (!(point < sum)) panic(PANIC.unreachable);
  let accumulator = 0;
  for (const [index, proportion] of proportions.entries()) {
    accumulator = round(accumulator + proportion);
    if (point < accumulator) return BigInt(index);
  }
  return panic(PANIC.unreachable);
}

function clz64(value: bigint): number {
  return value === 0n ? 64 : 64 - value.toString(2).length;
}

/** `Random.float(T)` for f32 and f64. */
function randomFloat(state: RandomSource, bits: 32 | 64): number {
  if (bits === 32) {
    const rand = randomInt(state, U64);
    let leading = clz64(rand);
    if (leading >= 41) {
      leading = 41 + clz64(randomInt(state, U64));
      if (leading === 41 + 64)
        leading += clz64(BigInt.asUintN(32, randomInt(state, intType(false, 32))) | 0x7_ffn) - 32;
    }
    const mantissa = Number(rand & 0x7f_ff_ffn);
    const word = ((126 - leading) << 23) | mantissa;
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, word >>> 0);
    return view.getFloat32(0);
  }
  const rand = randomInt(state, U64);
  let leading = clz64(rand);
  if (leading >= 12) {
    leading = 12;
    for (;;) {
      const additional = clz64(randomInt(state, U64));
      leading += additional;
      if (additional !== 64) break;
      if (leading >= 1022) {
        leading = 1022;
        break;
      }
    }
  }
  const mantissa = rand & 0xf_ff_ff_ff_ff_ff_ffn;
  const word = (BigInt(1022 - leading) << 52n) | mantissa;
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, word);
  return view.getFloat64(0);
}

// Types -----------------------------------------------------------------------------------------------------------------

const STATE_TYPE = arrayOf(4, U64);

/** `std.Random.Xoshiro256`, whose field `s` holds its state as in Zig. */
const XOSHIRO: StructType = nativeStruct('Random.Xoshiro256', {}, [{ name: 's', type: STATE_TYPE, hasDefault: false }]);

/** `std.Random`, the interface whose methods draw from the generator it points to. */
const RANDOM: StructType = nativeStruct('Random', {}, [], { kind: 'random', args: [], storageSlots: 1, byteSize: 16 });

function xoshiroState(sema: SemaApi, receiver: TExpr | undefined, span: Span): (frame: Frame) => ZArray {
  if (!receiver) return sema.error(span, 'std.Random.DefaultPrng の値に対して呼び出してください。');
  let pointer = receiver;
  if (receiver.type === XOSHIRO) pointer = sema.addressOf(receiver);
  if (pointer.type.kind !== 'pointer' || pointer.type.child !== XOSHIRO) {
    return sema.error(span, 'std.Random.DefaultPrng の値に対して呼び出してください。');
  }
  if (pointer.type.isConst) sema.error(span, '乱数の生成器は var で宣言してください。');
  const evaluate = pointer.eval;
  return (frame) => ((evaluate(frame) as Pointer).load() as ZStruct).slots[0] as ZArray;
}

function randomState(sema: SemaApi, receiver: TExpr | undefined, span: Span): (frame: Frame) => RandomSource {
  if (!receiver) return sema.error(span, 'std.Random の値に対して呼び出してください。');
  const evaluate = receiver.eval;
  const pointer = receiver.type.kind === 'pointer';
  if (receiver.type !== RANDOM && !(pointer && (receiver.type as { child: Type }).child === RANDOM)) {
    return sema.error(span, 'std.Random の値に対して呼び出してください。');
  }
  return (frame) => {
    const value = evaluate(frame);
    const random = (pointer ? (value as Pointer).load() : value) as ZStruct;
    const generator = (random.slots[0] as NativeHandle).state.generator as Pointer;
    return randomSource(frame, (generator.load() as ZStruct).slots[0] as ZArray);
  };
}

function randomSource(frame: Frame, state: ZArray): RandomSource {
  return {
    next: () => {
      frame.runtime.spend();
      return next(state);
    },
  };
}

addMembers(XOSHIRO, {
  init: fnMember('Xoshiro256.init', (sema, call) => {
    const [seed] = compileArgs(sema, expectArgs(sema, call, 1, 'init'), [U64]);
    const evaluate = seed.eval;
    return runtime(
      XOSHIRO,
      (frame) => {
        const state = { s: evaluate(frame) as bigint };
        return new ZStruct([new ZArray([splitMix(state), splitMix(state), splitMix(state), splitMix(state)])]);
      },
      call.span
    );
  }),
  next: fnMember('Xoshiro256.next', (sema, call) => {
    expectArgs(sema, call, 0, 'next');
    const state = xoshiroState(sema, call.receiver, call.span);
    return runtime(U64, (frame) => randomSource(frame, state(frame)).next(), call.span);
  }),
  random: fnMember('Xoshiro256.random', (sema, call) => {
    expectArgs(sema, call, 0, 'random');
    const receiver = call.receiver;
    if (!receiver) return sema.error(call.span, 'std.Random.DefaultPrng の値に対して呼び出してください。');
    let pointer = receiver;
    if (receiver.type === XOSHIRO) pointer = sema.addressOf(receiver);
    if (pointer.type.kind !== 'pointer' || pointer.type.child !== XOSHIRO || pointer.type.isConst) {
      return sema.error(call.span, '乱数の生成器は var で宣言してください。');
    }
    const evaluate = pointer.eval;
    return runtime(
      RANDOM,
      (frame) => new ZStruct([new NativeHandle('random', { generator: evaluate(frame) })]),
      call.span
    );
  }),
});

/** A method of `std.Random` whose first argument is an integer type. */
function intMethod(
  name: string,
  count: number,
  compute: (state: RandomSource, type: IntType, args: bigint[]) => bigint
): () => Member {
  return fnMember(`Random.${name}`, (sema, call) => {
    const [typeArg, ...rest] = expectArgs(sema, call, count, name);
    const type = sema.compileType(typeArg);
    if (type.kind !== 'int')
      return sema.error(typeArg, `${name} には整数の型を渡してください（${typeName(type)} です）。`);
    if (name.startsWith('uint') && type.signed)
      return sema.error(typeArg, `${name} には符号なし整数の型を渡してください。`);
    const args = compileArgs(
      sema,
      rest,
      rest.map(() => type)
    );
    const state = randomState(sema, call.receiver, call.span);
    const evaluators = args.map((arg) => arg.eval);
    return runtime(
      type,
      (frame) => {
        frame.runtime.spend();
        return compute(
          state(frame),
          type,
          evaluators.map((evaluate) => evaluate(frame) as bigint)
        );
      },
      call.span
    );
  });
}

addMembers(RANDOM, {
  int: intMethod('int', 1, (state, type) => randomInt(state, type)),
  uintLessThan: intMethod('uintLessThan', 2, (state, type, [lessThan]) => uintLessThan(state, type, lessThan)),
  uintAtMost: intMethod('uintAtMost', 2, (state, type, [atMost]) => uintAtMost(state, type, atMost)),
  intRangeLessThan: intMethod('intRangeLessThan', 3, (state, type, [low, high]) =>
    intRange(state, type, low, high, false)
  ),
  intRangeAtMost: intMethod('intRangeAtMost', 3, (state, type, [low, high]) => intRange(state, type, low, high, true)),
  uintLessThanBiased: intMethod('uintLessThanBiased', 2, (state, type, [lessThan]) =>
    uintLessThanBiased(state, type, lessThan)
  ),
  uintAtMostBiased: intMethod('uintAtMostBiased', 2, (state, type, [atMost]) => uintAtMost(state, type, atMost, true)),
  intRangeLessThanBiased: intMethod('intRangeLessThanBiased', 3, (state, type, [low, high]) =>
    intRange(state, type, low, high, false, true)
  ),
  intRangeAtMostBiased: intMethod('intRangeAtMostBiased', 3, (state, type, [low, high]) =>
    intRange(state, type, low, high, true, true)
  ),
  bytes: fnMember('Random.bytes', (sema, call) => {
    const [buffer] = compileArgs(sema, expectArgs(sema, call, 1, 'bytes'), [sliceOf(U8, false)]);
    const state = randomState(sema, call.receiver, call.span);
    const evaluate = buffer.eval;
    return runtime(
      VOID,
      (frame) => {
        const generator = state(frame);
        const slice = evaluate(frame) as Slice;
        frame.runtime.spend(1 + Math.floor(slice.length / 8));
        for (const [index, byte] of fill(generator, slice.length).entries()) slice.set(index, BigInt(byte));
        return;
      },
      call.span
    );
  }),
  boolean: fnMember('Random.boolean', (sema, call) => {
    expectArgs(sema, call, 0, 'boolean');
    const state = randomState(sema, call.receiver, call.span);
    return runtime(BOOL, (frame) => randomInt(state(frame), intType(false, 1)) !== 0n, call.span);
  }),
  float: fnMember('Random.float', (sema, call) => {
    const [typeArg] = expectArgs(sema, call, 1, 'float');
    const type = sema.compileType(typeArg);
    if (type.kind !== 'float' || (type.bits !== 32 && type.bits !== 64)) {
      return sema.error(typeArg, 'float には f32 か f64 を渡してください。');
    }
    const bits = type.bits;
    const state = randomState(sema, call.receiver, call.span);
    return runtime(type, (frame) => randomFloat(state(frame), bits), call.span);
  }),
  weightedIndex: fnMember('Random.weightedIndex', (sema, call) => {
    const [typeArg, proportionsArg] = expectArgs(sema, call, 2, 'weightedIndex');
    const type = sema.compileType(typeArg);
    if (type.kind !== 'int' && (type.kind !== 'float' || (type.bits !== 32 && type.bits !== 64))) {
      return sema.error(typeArg, `weightedIndex には整数か f32・f64 の型を渡してください（${typeName(type)} です）。`);
    }
    const [proportions] = compileArgs(sema, [proportionsArg], [sliceOf(type, true)]);
    const state = randomState(sema, call.receiver, call.span);
    const evaluate = proportions.eval;
    return runtime(
      USIZE,
      (frame) => {
        const generator = state(frame);
        const values = (evaluate(frame) as Slice).values();
        frame.runtime.spend(1 + values.length);
        return type.kind === 'int'
          ? weightedIntIndex(generator, type, values as bigint[])
          : weightedFloatIndex(generator, type.bits as 32 | 64, values as number[]);
      },
      call.span
    );
  }),
  shuffle: fnMember('Random.shuffle', (sema, call) => {
    const [typeArg, bufferArg] = expectArgs(sema, call, 2, 'shuffle');
    const type = sema.compileType(typeArg);
    const [buffer] = compileArgs(sema, [bufferArg], [sliceOf(type, false)]);
    const state = randomState(sema, call.receiver, call.span);
    const evaluate = buffer.eval;
    return runtime(
      VOID,
      (frame) => {
        const generator = state(frame);
        const slice = evaluate(frame) as Slice;
        const usize = intType(false, 64, 'usize');
        for (let index = 0; index + 1 < slice.length; index++) {
          frame.runtime.spend();
          const other = Number(intRange(generator, usize, BigInt(index), BigInt(slice.length), false));
          const value = copyForStorage(slice.get(index));
          const swapped = copyForStorage(slice.get(other));
          storeSliceValue(slice, index, swapped);
          storeSliceValue(slice, other, value);
        }
        return;
      },
      call.span
    );
  }),
  enumValue: fnMember('Random.enumValue', (sema, call) => {
    const [typeArg] = expectArgs(sema, call, 1, 'enumValue');
    const type = sema.compileType(typeArg);
    if (type.kind !== 'enum') return sema.error(typeArg, 'enumValue には enum の型を渡してください。');
    const fields = sema.enumFields(type);
    const state = randomState(sema, call.receiver, call.span);
    const usize = intType(false, 64, 'usize');
    return runtime(
      type,
      (frame) => {
        const generator = state(frame);
        if (fields.length === 1) return fields[0].value;
        return fields[Number(uintLessThan(generator, usize, BigInt(fields.length)))].value;
      },
      call.span
    );
  }),
});

export function randomNamespace(): StructType {
  return RANDOM_NAMESPACE;
}

const RANDOM_NAMESPACE: StructType = RANDOM;

addMembers(RANDOM, {
  DefaultPrng: () => ({ type: TYPE, value: XOSHIRO }),
  Xoshiro256: () => ({ type: TYPE, value: XOSHIRO }),
});

export { known, type Value };
