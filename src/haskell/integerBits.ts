import type { Runtime } from './runtime';
import { HaskellException } from './values';

type BitChange = 'set' | 'clear';

export function makeIntegerBit(index: bigint, runtime: Runtime): bigint {
  validateBitIndex(index);
  return allocateBit(index, runtime);
}

export function changeIntegerBit(value: bigint, index: bigint, change: BitChange, runtime: Runtime): bigint {
  validateBitIndex(index);
  if (testIntegerBit(value, index, runtime) === (change === 'set')) return value;
  const mask = allocateBit(index, runtime);
  chargeInteger(value, runtime);
  switch (change) {
    case 'set': {
      return value | mask;
    }
    case 'clear': {
      return value & ~mask;
    }
  }
}

export function complementIntegerBit(value: () => bigint, index: bigint, runtime: Runtime): bigint {
  const mask = makeIntegerBit(index, runtime);
  const forced = value();
  chargeInteger(forced, runtime);
  return forced ^ mask;
}

export function testIntegerBit(value: bigint, index: bigint, runtime: Runtime): boolean {
  const shifted = value >> BigInt.asUintN(64, index);
  chargeInteger(shifted, runtime);
  return (shifted & 1n) !== 0n;
}

function validateBitIndex(index: bigint): void {
  if (index < 0n) throw new HaskellException('heap overflow');
}

function allocateBit(index: bigint, runtime: Runtime): bigint {
  runtime.spend(Math.ceil((Number(index) + 1) / 64));
  return 1n << index;
}

function chargeInteger(value: bigint, runtime: Runtime): void {
  runtime.spend(Math.ceil((value < 0n ? -value : value).toString(16).length / 16));
}
