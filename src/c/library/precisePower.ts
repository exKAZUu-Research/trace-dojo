import { Decimal } from 'decimal.js';

import { exactParts, roundBinary } from './binaryFloat';

const HighPrecision = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_EVEN });

export function precisePower(x: number, y: number, isFloat = false): number {
  const result = decimalOf(x).pow(decimalOf(y));
  if (!result.isFinite() || result.isZero()) return result.toNumber();
  const negative = result.isNegative();
  if (result.e > 310) return negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  if (result.e < -325) return negative ? -0 : 0;
  const [numerator, denominator] = result.abs().toFraction();
  const value = roundBinary(BigInt(numerator.toFixed(0)), BigInt(denominator.toFixed(0)), 0, isFloat);
  return negative ? -value : value;
}

function decimalOf(value: number): Decimal {
  if (value === 0 || !Number.isFinite(value)) return new HighPrecision(value);
  const parts = exactParts(Math.abs(value));
  const coefficient =
    parts.exponent >= 0 ? parts.mantissa << BigInt(parts.exponent) : parts.mantissa * 5n ** BigInt(-parts.exponent);
  return new HighPrecision(`${value < 0 ? '-' : ''}${coefficient}e${Math.min(0, parts.exponent)}`);
}
