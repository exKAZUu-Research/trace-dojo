export function exactParts(value: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7_ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  return biased === 0
    ? { mantissa: fraction, exponent: -1074 }
    : { mantissa: fraction | (1n << 52n), exponent: biased - 1075 };
}

export function roundBinary(numerator: bigint, denominator: bigint, exponent: number, isFloat = false): number {
  if (numerator === 0n) return 0;
  const bits = isFloat ? 24 : 53;
  const minimumExponent = isFloat ? -126 : -1022;
  const maximumExponent = isFloat ? 127 : 1023;
  // Find the binary exponent e of the quotient q, so that 2^e <= q < 2^(e+1).
  let e = numerator.toString(2).length - denominator.toString(2).length;
  if ((e >= 0 ? numerator : numerator << BigInt(-e)) < (e >= 0 ? denominator << BigInt(e) : denominator)) e--;
  const total = e + exponent;
  if (total > maximumExponent) return Number.POSITIVE_INFINITY;
  const precision = Math.min(bits, bits + total - minimumExponent);
  if (total < minimumExponent - bits) return 0;
  const shift = precision - 1 - e;
  const scaledNumerator = shift >= 0 ? numerator << BigInt(shift) : numerator;
  const scaledDenominator = shift >= 0 ? denominator : denominator << BigInt(-shift);
  let quotient = scaledNumerator / scaledDenominator;
  const remainder = scaledNumerator % scaledDenominator;
  const twice = remainder * 2n;
  if (twice > scaledDenominator || (twice === scaledDenominator && (quotient & 1n) === 1n)) quotient++;
  const result = Number(quotient) * 2 ** (exponent - shift);
  return isFloat ? Math.fround(result) : result;
}
