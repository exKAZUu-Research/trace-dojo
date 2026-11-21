import { isPlace, NaNValue, type Value } from './values';

export function floatNumber(value: Value): number {
  const stored = floatStorage(value);
  return stored instanceof NaNValue ? Number.NaN : (stored as number);
}

export function floatFromBits(bits: bigint, width: 32 | 64): number | NaNValue {
  const view = new DataView(new ArrayBuffer(width / 8));
  let number: number;
  if (width === 32) {
    view.setUint32(0, Number(bits));
    number = view.getFloat32(0);
  } else {
    view.setBigUint64(0, bits);
    number = view.getFloat64(0);
  }
  return Number.isNaN(number) ? new NaNValue(bits, width) : number;
}

export function floatBits(value: Value, width: 32 | 64): bigint {
  const stored = floatStorage(value);
  if (stored instanceof NaNValue && stored.width === width) return stored.bits;
  const number = floatNumber(stored);
  const view = new DataView(new ArrayBuffer(width / 8));
  if (width === 32) {
    view.setFloat32(0, number);
    return BigInt(view.getUint32(0));
  }
  view.setFloat64(0, number);
  return view.getBigUint64(0);
}

export function signedFloat(value: Value, width: 32 | 64, negative: boolean): number | NaNValue {
  const sign = 1n << BigInt(width - 1);
  const bits = floatBits(value, width);
  return floatFromBits(negative ? bits | sign : bits & ~sign, width);
}

export function negateFloat(value: Value): number | NaNValue {
  const stored = floatStorage(value);
  if (!(stored instanceof NaNValue)) return -(stored as number);
  return new NaNValue(stored.bits ^ (1n << BigInt(stored.width - 1)), stored.width);
}

function floatStorage(value: Value): Value {
  let stored = value;
  while (isPlace(stored)) stored = stored.get();
  return stored;
}
