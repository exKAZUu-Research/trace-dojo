/** Zig's Wyhash (`std.hash.Wyhash`) and `std.hash.autoHash`, which decide a hash map's iteration order. */
import { activeUnionIndex, physicalBytes } from '../bufferMemory';
import { bitSizeOf, hasResolvedLayout, sizeOf } from '../layout';
import type { Type } from '../types';
import { encodeIdentifierText } from '../utf8';
import {
  ErrorValue,
  type FnValue,
  NULL,
  Pointer,
  type Slice,
  Some,
  type Value,
  type ZArray,
  type ZStruct,
  type ZUnion,
} from '../values';

interface HashProofState {
  active: Set<Type>;
  completed: Map<Type, boolean>;
}

const physicalHashLayouts = new WeakMap<Type, boolean>();
const emptyHashes = new WeakMap<Type, boolean>();

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

function read(byteAt: (index: number) => number, offset: number, count: number): bigint {
  let value = 0n;
  for (let index = count - 1; index >= 0; index--) value = (value << 8n) | BigInt(byteAt(offset + index));
  return value;
}

/** `Wyhash.hash(seed, input)`. */
// code-gauge-allow functionNcss -- Keeps the reference Wyhash block order with its metered input reader.
// code-gauge-allow functionCognitiveComplexity -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
export function wyhash(
  seed: bigint,
  length: number,
  byteAt: (index: number) => number,
  spend: (cost?: number) => void
): bigint {
  spend();
  const readByte = (index: number): number => {
    spend();
    return byteAt(index);
  };
  const state = [seed ^ mix(seed ^ SECRET[0], SECRET[1]), 0n, 0n];
  state[1] = state[0];
  state[2] = state[0];
  let a: bigint;
  let b: bigint;
  if (length <= 16) {
    if (length >= 4) {
      const end = length - 4;
      const quarter = (length >> 3) << 2;
      a = (read(readByte, 0, 4) << 32n) | read(readByte, quarter, 4);
      b = (read(readByte, end, 4) << 32n) | read(readByte, end - quarter, 4);
    } else if (length > 0) {
      a = (BigInt(readByte(0)) << 16n) | (BigInt(readByte(length >> 1)) << 8n) | BigInt(readByte(length - 1));
      b = 0n;
    } else {
      a = 0n;
      b = 0n;
    }
  } else {
    let i = 0;
    if (length >= 48) {
      while (i + 48 < length) {
        for (let lane = 0; lane < 3; lane++) {
          const x = read(readByte, i + 8 * (2 * lane), 8);
          const y = read(readByte, i + 8 * (2 * lane + 1), 8);
          state[lane] = mix(x ^ SECRET[lane + 1], y ^ state[lane]);
        }
        i += 48;
      }
      state[0] ^= state[1] ^ state[2];
    }
    while (i + 16 < length) {
      state[0] = mix(read(readByte, i, 8) ^ SECRET[1], read(readByte, i + 8, 8) ^ state[0]);
      i += 16;
    }
    a = read(readByte, length - 16, 8);
    b = read(readByte, length - 8, 8);
  }
  a ^= SECRET[1];
  b ^= state[0];
  [a, b] = mum(a, b);
  return mix(a ^ SECRET[0] ^ BigInt(length), b ^ SECRET[1]);
}

export function autoHashBytes(
  value: Value,
  type: Type,
  identityOf: (value: object) => bigint,
  spend: (cost?: number) => void
): number[] {
  const bytes: number[] = [];
  appendHashBytes(bytes, value, type, identityOf, spend);
  return bytes;
}

// code-gauge-allow functionNcss -- Serializes each key representation while charging work before materialization.
// code-gauge-allow functionCognitiveComplexity -- Serializes each key representation while charging work before materialization.
function appendHashBytes(
  bytes: number[],
  value: Value,
  type: Type,
  identityOf: (value: object) => bigint,
  spend: (cost?: number) => void
): void {
  spend();
  if (
    (type.kind === 'array' || type.kind === 'struct' || type.kind === 'union') &&
    hasPhysicalHashLayout(type, spend)
  ) {
    const encoded = physicalBytes(value, type, (reference) => hashAddress(reference as Value, identityOf), spend);
    for (const byte of encoded) bytes.push(byte);
    return;
  }
  switch (type.kind) {
    case 'int': {
      const unique = type.bits % 8 === 0 && sizeOf(type) * 8 === type.bits;
      appendInteger(
        bytes,
        BigInt.asUintN(Math.max(type.bits, 1), value as bigint),
        unique ? sizeOf(type) : Math.ceil(type.bits / 8),
        spend
      );
      return;
    }
    case 'bool': {
      appendInteger(bytes, value ? 1n : 0n, 1, spend);
      return;
    }
    case 'enum': {
      const bits = type.tagType?.bits ?? 0;
      appendInteger(bytes, BigInt.asUintN(Math.max(bits, 1), value as bigint), Math.ceil(bits / 8), spend);
      return;
    }
    case 'array': {
      if (emptyHash(type.child, spend)) return;
      const array = value as ZArray;
      for (let index = 0; index < array.length; index++)
        appendHashBytes(bytes, array.get(index), type.child, identityOf, spend);
      return;
    }
    case 'struct': {
      for (const [index, field] of (type.fields ?? []).entries())
        appendHashBytes(bytes, (value as ZStruct).slots[index], field.type, identityOf, spend);
      return;
    }
    case 'union': {
      const union = value as ZUnion;
      const index = activeUnionIndex(union);
      const tag = type.tagType!;
      appendHashBytes(bytes, tag.fields![index].value, tag, identityOf, spend);
      appendHashBytes(bytes, union.slots[0], type.fields![index].type, identityOf, spend);
      return;
    }
    case 'pointer':
    case 'fn': {
      if (type.kind === 'pointer' && type.size === 'slice') {
        const slice = value as Slice;
        appendInteger(bytes, hashAddress(new Pointer(slice.target, slice.start), identityOf), 8, spend);
        appendInteger(bytes, slice.lengthValue, 8, spend);
        return;
      }
      appendInteger(bytes, hashAddress(value, identityOf), 8, spend);
      return;
    }
    case 'error_set': {
      const name = (value as ErrorValue).name;
      spend(name.length * 3);
      for (const byte of encodeIdentifierText(name)) bytes.push(byte);
      return;
    }
    case 'error_union': {
      appendHashBytes(bytes, value, value instanceof ErrorValue ? type.errorSet : type.payload, identityOf, spend);
      return;
    }
    case 'optional': {
      if (value !== NULL)
        appendHashBytes(bytes, value instanceof Some ? value.value : value, type.child, identityOf, spend);
      return;
    }
  }
}

function emptyHash(type: Type, spend: (cost?: number) => void, state?: HashProofState): boolean {
  return queryHashType(type, spend, emptyHashes, emptyHashResult, state);
}

function emptyHashResult(type: Type, spend: (cost?: number) => void, state: HashProofState): boolean {
  switch (type.kind) {
    case 'void': {
      return true;
    }
    case 'int': {
      return type.bits === 0;
    }
    case 'enum': {
      return (type.tagType?.bits ?? 0) === 0;
    }
    case 'array': {
      return type.length === 0n || emptyHash(type.child, spend, state);
    }
    case 'struct': {
      return (type.fields ?? []).every((field) => emptyHash(field.type, spend, state));
    }
    default: {
      return false;
    }
  }
}

function hashAddress(value: Value, identityOf: (value: object) => bigint): bigint {
  if (value instanceof Pointer) {
    const location = value.storageLocation();
    return (identityOf(location.storage) << 32n) + BigInt(location.index * 8);
  }
  return identityOf((value as FnValue).fn) << 32n;
}

export function hasPhysicalHashLayout(type: Type, spend: (cost?: number) => void, state?: HashProofState): boolean {
  return queryHashType(type, spend, physicalHashLayouts, physicalHashLayout, state);
}

function physicalHashLayout(type: Type, spend: (cost?: number) => void, state: HashProofState): boolean {
  switch (type.kind) {
    case 'int': {
      return sizeOf(type) * 8 === type.bits;
    }
    case 'enum': {
      return type.tagType !== undefined && hasPhysicalHashLayout(type.tagType, spend, state);
    }
    case 'pointer': {
      return type.size !== 'slice';
    }
    case 'optional': {
      return type.child.kind === 'pointer' && type.child.size !== 'slice';
    }
    case 'array': {
      return hasPhysicalHashLayout(type.child, spend, state);
    }
    case 'struct': {
      spend(type.fields?.length ?? 0);
      const fields = (type.fields ?? []).filter((field) => field.comptimeValue === undefined);
      if (type.layout === 'packed') return sizeOf(type) * 8 === bitSizeOf(type);
      return (
        fields.every((field) => hasPhysicalHashLayout(field.type, spend, state)) &&
        sizeOf(type) === fields.reduce((sum, field) => sum + sizeOf(field.type), 0)
      );
    }
    case 'union': {
      return (type.fields ?? []).every(
        (field) => sizeOf(field.type) === sizeOf(type) && hasPhysicalHashLayout(field.type, spend, state)
      );
    }
    // Compiler error IDs are unavailable, so error-containing keys retain field hashing.
    default: {
      return false;
    }
  }
}

function queryHashType(
  type: Type,
  spend: (cost?: number) => void,
  cache: WeakMap<Type, boolean>,
  compute: (type: Type, spend: (cost?: number) => void, state: HashProofState) => boolean,
  state?: HashProofState
): boolean {
  state ??= { active: new Set(), completed: new Map() };
  spend();
  const cached = cache.get(type) ?? state.completed.get(type);
  if (cached !== undefined) return cached;
  if (state.active.has(type)) return false;
  state.active.add(type);
  try {
    const result = compute(type, spend, state);
    state.completed.set(type, result);
    if (hasResolvedLayout(type)) cache.set(type, result);
    return result;
  } finally {
    state.active.delete(type);
  }
}

function appendInteger(bytes: number[], value: bigint, count: number, spend: (cost?: number) => void): void {
  spend(count);
  let remaining = value;
  for (let index = 0; index < count; index++) {
    bytes.push(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
}
