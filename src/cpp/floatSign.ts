// JavaScript engines can canonicalize NaNs even when reading a DataView.
export class NegativeNaN {
  [Symbol.toPrimitive](): number {
    return Number.NaN;
  }
}

export const NEGATIVE_NAN = new NegativeNaN();
export type FloatingValue = number | NegativeNaN;

export function floatSignBit(value: unknown): boolean {
  if (value === NEGATIVE_NAN) return true;
  return (typeof value === 'number' || typeof value === 'bigint') && (value < 0 || Object.is(value, -0));
}

export function negateFloat(value: FloatingValue): FloatingValue {
  if (value === NEGATIVE_NAN) return Number.NaN;
  return Number.isNaN(value) ? NEGATIVE_NAN : -Number(value);
}

export function copyFloatSign(value: unknown, sign: unknown): FloatingValue {
  const number = Math.abs(Number(value));
  return floatSignBit(sign) ? negateFloat(number) : number;
}
