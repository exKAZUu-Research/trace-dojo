/** Zig's Wyhash (`std.hash.Wyhash`) and `std.hash.autoHash`, which decide a hash map's iteration order. */
import { sizeOf } from '../layout';
import type { Type } from '../types';
import { NULL, Some, type Value, type ZArray, type ZStruct, type ZUnion } from '../values';

const MASK = (1n << 64n) - 1n;
const SECRET = [
  0xa0_76_1d_64_78_bd_64_2fn,
  0xe7_03_7e_d1_a0_b4_28_dbn,
  0x8e_bc_6a_f0_9c_88_c6_e3n,
  0x58_99_65_cc_75_37_4c_c3n,
];

function mum(a: bigint, b: bigint): [bigint, bigint] {
  const product = a * b;
  return [product & MASK, (product >> 64n) & MASK];
}

function mix(a: bigint, b: bigint): bigint {
  const [low, high] = mum(a, b);
  return low ^ high;
}

function read(bytes: readonly number[], offset: number, count: number): bigint {
  let value = 0n;
  for (let index = count - 1; index >= 0; index--) value = (value << 8n) | BigInt(bytes[offset + index]);
  return value;
}

/** `Wyhash.hash(seed, input)`. */
// code-gauge-allow functionNcss 40 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
// code-gauge-allow functionCognitiveComplexity 17 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
export function wyhash(seed: bigint, input: readonly number[]): bigint {
  const state = [seed ^ mix(seed ^ SECRET[0], SECRET[1]), 0n, 0n];
  state[1] = state[0];
  state[2] = state[0];
  let a: bigint;
  let b: bigint;
  if (input.length <= 16) {
    if (input.length >= 4) {
      const end = input.length - 4;
      const quarter = (input.length >> 3) << 2;
      a = (read(input, 0, 4) << 32n) | read(input, quarter, 4);
      b = (read(input, end, 4) << 32n) | read(input, end - quarter, 4);
    } else if (input.length > 0) {
      a = (BigInt(input[0]) << 16n) | (BigInt(input[input.length >> 1]) << 8n) | BigInt(input.at(-1) as number);
      b = 0n;
    } else {
      a = 0n;
      b = 0n;
    }
  } else {
    let i = 0;
    if (input.length >= 48) {
      while (i + 48 < input.length) {
        for (let lane = 0; lane < 3; lane++) {
          const x = read(input, i + 8 * (2 * lane), 8);
          const y = read(input, i + 8 * (2 * lane + 1), 8);
          state[lane] = mix(x ^ SECRET[lane + 1], y ^ state[lane]);
        }
        i += 48;
      }
      state[0] ^= state[1] ^ state[2];
    }
    const rest = input.slice(i);
    let j = 0;
    while (j + 16 < rest.length) {
      state[0] = mix(read(rest, j, 8) ^ SECRET[1], read(rest, j + 8, 8) ^ state[0]);
      j += 16;
    }
    a = read(input, input.length - 16, 8);
    b = read(input, input.length - 8, 8);
  }
  a ^= SECRET[1];
  b ^= state[0];
  [a, b] = mum(a, b);
  return mix(a ^ SECRET[0] ^ BigInt(input.length), b ^ SECRET[1]);
}

function littleEndian(value: bigint, bytes: number): number[] {
  const result: number[] = [];
  let remaining = value;
  for (let index = 0; index < bytes; index++) {
    result.push(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
  return result;
}

/** The bytes that `autoHash` feeds the hasher for a key, which `Wyhash.hash` then hashes in one call. */
export function autoHashBytes(value: Value, type: Type): number[] {
  switch (type.kind) {
    case 'int': {
      const unsigned = BigInt.asUintN(Math.max(type.bits, 1), value as bigint);
      const unique = type.bits % 8 === 0 && sizeOf(type) * 8 === type.bits;
      return littleEndian(unsigned, unique ? sizeOf(type) : Math.ceil(type.bits / 8));
    }
    case 'bool': {
      return [value ? 1 : 0];
    }
    case 'enum': {
      const bits = type.tagType?.bits ?? 0;
      return littleEndian(BigInt.asUintN(Math.max(bits, 1), value as bigint), Math.max(Math.ceil(bits / 8), 0));
    }
    case 'array': {
      return (value as ZArray).values().flatMap((element) => autoHashBytes(element, type.child));
    }
    case 'struct': {
      return (type.fields ?? []).flatMap((field, index) => autoHashBytes((value as ZStruct).slots[index], field.type));
    }
    case 'union': {
      const union = value as ZUnion;
      const field = type.fields![union.tag];
      const tag = type.tagType!;
      const tagValue = tag.fields!.find((entry) => entry.name === field.name)!.value;
      return [...autoHashBytes(tagValue, tag), ...autoHashBytes(union.slots[0], field.type)];
    }
    case 'optional': {
      if (value === NULL) return [];
      return autoHashBytes(value instanceof Some ? value.value : value, type.child);
    }
    default: {
      return [];
    }
  }
}
