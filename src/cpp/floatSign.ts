const DOUBLE_PAYLOAD_BITS = 52n;
const FLOAT_PAYLOAD_BITS = 23n;
const PAYLOAD_SHIFT = DOUBLE_PAYLOAD_BITS - FLOAT_PAYLOAD_BITS;
const QUIET_BIT = 1n << (DOUBLE_PAYLOAD_BITS - 1n);

// JavaScript engines can canonicalize NaNs even when reading a DataView.
export class FloatNaN {
  constructor(
    readonly negative: boolean,
    private readonly payload = QUIET_BIT
  ) {}

  static fromBits(bits: bigint, single: boolean): FloatNaN {
    const width = single ? FLOAT_PAYLOAD_BITS : DOUBLE_PAYLOAD_BITS;
    const payload = bits & ((1n << width) - 1n);
    return new FloatNaN(bits >> (single ? 31n : 63n) !== 0n, payload << (single ? PAYLOAD_SHIFT : 0n));
  }

  [Symbol.toPrimitive](): number {
    return Number.NaN;
  }

  bits(single: boolean): bigint {
    const sign = this.negative ? 1n : 0n;
    return single
      ? (sign << 31n) | 0x7f_80_00_00n | (this.payload >> PAYLOAD_SHIFT)
      : (sign << 63n) | 0x7f_f0_00_00_00_00_00_00n | this.payload;
  }

  withSign(negative: boolean): FloatNaN {
    return this.negative === negative ? this : new FloatNaN(negative, this.payload);
  }

  get isSignaling(): boolean {
    return (this.payload & QUIET_BIT) === 0n;
  }

  quiet(): FloatNaN {
    return this.isSignaling ? new FloatNaN(this.negative, this.payload | QUIET_BIT) : this;
  }

  convertWidth(single: boolean): FloatNaN {
    const payload = single ? (this.payload >> PAYLOAD_SHIFT) << PAYLOAD_SHIFT : this.payload;
    return new FloatNaN(this.negative, payload | QUIET_BIT);
  }
}

export const NEGATIVE_NAN = new FloatNaN(true);
export type FloatingValue = number | FloatNaN;

export function floatSignBit(value: unknown): boolean {
  if (value instanceof FloatNaN) return value.negative;
  return (typeof value === 'number' || typeof value === 'bigint') && (value < 0 || Object.is(value, -0));
}

export function negateFloat(value: FloatingValue): FloatingValue {
  if (value instanceof FloatNaN) return value.withSign(!value.negative);
  return Number.isNaN(value) ? NEGATIVE_NAN : -Number(value);
}

export function copyFloatSign(value: unknown, sign: unknown): FloatingValue {
  const isNegative = floatSignBit(sign);
  if (value instanceof FloatNaN) return value.withSign(isNegative);
  const number = Math.abs(Number(value));
  return isNegative ? negateFloat(number) : number;
}

export function arithmeticNaN(...values: unknown[]): FloatingValue | undefined {
  let first: FloatingValue | undefined;
  for (const value of values) {
    if (value instanceof FloatNaN) {
      if (value.isSignaling) return value.quiet();
      first ??= value;
    } else if (typeof value === 'number' && Number.isNaN(value)) first ??= value;
  }
  return first;
}

export function fusedNaN(a: unknown, b: unknown, addend: unknown): FloatingValue | undefined {
  if (addend instanceof FloatNaN && addend.isSignaling) return addend.quiet();
  const left = Number(a);
  const right = Number(b);
  if ((left === 0 && Math.abs(right) === Infinity) || (right === 0 && Math.abs(left) === Infinity)) return Number.NaN;
  return arithmeticNaN(addend, a, b);
}
