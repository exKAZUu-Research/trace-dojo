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
