import type { Entity } from '../entities';
import { definePackage, fn, nativeFunction } from '../native';
import { divideByZeroPanic, runtimeErrorPanic } from '../runtimeErrors';
import { BASIC, type Type } from '../types';
import { INT } from './support';

const SIZES: [string, Type, number][] = [
  ['', BASIC.uint, 64],
  ['8', BASIC.uint8, 8],
  ['16', BASIC.uint16, 16],
  ['32', BASIC.uint32, 32],
  ['64', BASIC.uint64, 64],
];

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

function popCount(value: bigint): number {
  let count = 0;
  for (const char of value.toString(2)) if (char === '1') count++;
  return count;
}

function reverse(value: bigint, bits: number): bigint {
  return BigInt(`0b${value.toString(2).padStart(bits, '0').split('').toReversed().join('')}`);
}

function trailingZeros(value: bigint, bits: number): number {
  if (value === 0n) return bits;
  let count = 0;
  while (((value >> BigInt(count)) & 1n) === 0n) count++;
  return count;
}

const members: Record<string, Entity> = {
  UintSize: {
    kind: 'const',
    name: 'UintSize',
    type: BASIC.untypedInt,
    value: { kind: 'int', value: 64n },
    span: { row: 0, column: 0 },
    used: true,
  },
};
for (const [suffix, type, bits] of SIZES) {
  const mask = (1n << BigInt(bits)) - 1n;
  members[`OnesCount${suffix}`] = nativeFunction(`OnesCount${suffix}`, fn([type], [INT]), ([x]) =>
    BigInt(popCount(x as bigint))
  );
  members[`LeadingZeros${suffix}`] = nativeFunction(`LeadingZeros${suffix}`, fn([type], [INT]), ([x]) =>
    BigInt(bits - bitLength(x as bigint))
  );
  members[`TrailingZeros${suffix}`] = nativeFunction(`TrailingZeros${suffix}`, fn([type], [INT]), ([x]) =>
    BigInt(trailingZeros(x as bigint, bits))
  );
  members[`Len${suffix}`] = nativeFunction(`Len${suffix}`, fn([type], [INT]), ([x]) => BigInt(bitLength(x as bigint)));
  members[`Reverse${suffix}`] = nativeFunction(`Reverse${suffix}`, fn([type], [type]), ([x]) =>
    reverse(x as bigint, bits)
  );
  members[`RotateLeft${suffix}`] = nativeFunction(`RotateLeft${suffix}`, fn([type, INT], [type]), ([x, k]) => {
    const shift = ((Number(k as bigint) % bits) + bits) % bits;
    const value = x as bigint;
    return ((value << BigInt(shift)) | (value >> BigInt(bits - shift))) & mask;
  });
  if (suffix !== '8') {
    members[`ReverseBytes${suffix}`] = nativeFunction(`ReverseBytes${suffix}`, fn([type], [type]), ([x]) => {
      const hex = (x as bigint).toString(16).padStart(bits / 4, '0');
      return BigInt(`0x${hex.match(/../g)?.toReversed().join('') ?? '0'}`);
    });
  }
}
for (const [suffix, type, bits] of SIZES.filter(([size]) => size === '' || size === '32' || size === '64')) {
  const mask = (1n << BigInt(bits)) - 1n;
  members[`Add${suffix}`] = nativeFunction(`Add${suffix}`, fn([type, type, type], [type, type]), ([x, y, carry]) => {
    const sum = (x as bigint) + (y as bigint) + (carry as bigint);
    return [sum & mask, sum >> BigInt(bits)];
  });
  members[`Sub${suffix}`] = nativeFunction(`Sub${suffix}`, fn([type, type, type], [type, type]), ([x, y, borrow]) => {
    const difference = (x as bigint) - (y as bigint) - (borrow as bigint);
    return [difference & mask, difference < 0n ? 1n : 0n];
  });
  members[`Mul${suffix}`] = nativeFunction(`Mul${suffix}`, fn([type, type], [type, type]), ([x, y]) => {
    const product = (x as bigint) * (y as bigint);
    return [product >> BigInt(bits), product & mask];
  });
  members[`Div${suffix}`] = nativeFunction(`Div${suffix}`, fn([type, type, type], [type, type]), ([hi, lo, y]) => {
    const divisor = y as bigint;
    if (divisor === 0n) divideByZeroPanic();
    if (divisor <= (hi as bigint)) runtimeErrorPanic('integer overflow');
    const dividend = ((hi as bigint) << BigInt(bits)) | (lo as bigint);
    return [dividend / divisor, dividend % divisor];
  });
  // Rem reduces hi first, so unlike Div it does not overflow.
  members[`Rem${suffix}`] = nativeFunction(`Rem${suffix}`, fn([type, type, type], [type]), ([hi, lo, y]) => {
    const divisor = y as bigint;
    if (divisor === 0n) divideByZeroPanic();
    return (((hi as bigint) << BigInt(bits)) | (lo as bigint)) % divisor;
  });
}

export const BITS_PACKAGE = definePackage('math/bits', members);
