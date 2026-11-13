const DOUBLE_FORMAT = { bits: 53, minimum: -1022, maximum: 1023 };
const FLOAT_FORMAT = { bits: 24, minimum: -126, maximum: 127 };

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

// code-gauge-allow duplicateLines 15 -- Quotient and square-root rounding share range guards but use different scaling and midpoint comparisons.
export function roundBinary(numerator: bigint, denominator: bigint, exponent: number, isFloat = false): number {
  if (numerator === 0n) return 0;
  const { bits, minimum: minimumExponent, maximum: maximumExponent } = isFloat ? FLOAT_FORMAT : DOUBLE_FORMAT;
  const e = ratioExponent(numerator, denominator);
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

// code-gauge-allow duplicateLines 15 -- Quotient and square-root rounding share range guards but use different scaling and midpoint comparisons.
export function roundSquareRoot(numerator: bigint, denominator: bigint, exponent: number, isFloat = false): number {
  const { bits, minimum, maximum } = isFloat ? FLOAT_FORMAT : DOUBLE_FORMAT;
  const e = ratioExponent(numerator, denominator);
  const total = Math.floor((e + exponent) / 2);
  if (total > maximum) return Number.POSITIVE_INFINITY;
  if (total < minimum - bits) return 0;
  const unit = Math.max(total - bits + 1, minimum - bits + 1);
  const shift = exponent - 2 * unit;
  const top = shift >= 0 ? numerator << BigInt(shift) : numerator;
  const bottom = shift >= 0 ? denominator : denominator << BigInt(-shift);
  let root = integerSquareRoot(top / bottom);
  const midpoint = 2n * root + 1n;
  const difference = 4n * top - bottom * midpoint * midpoint;
  if (difference > 0n || (difference === 0n && (root & 1n) === 1n)) root++;
  const result = Number(root) * 2 ** unit;
  return isFloat ? Math.fround(result) : result;
}

function integerSquareRoot(value: bigint): bigint {
  if (value === 0n) return 0n;
  let root = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  for (;;) {
    const next = (root + value / root) / 2n;
    if (next >= root) return root;
    root = next;
  }
}

function ratioExponent(numerator: bigint, denominator: bigint): number {
  let exponent = numerator.toString(2).length - denominator.toString(2).length;
  if (
    (exponent >= 0 ? numerator : numerator << BigInt(-exponent)) <
    (exponent >= 0 ? denominator << BigInt(exponent) : denominator)
  )
    exponent--;
  return exponent;
}
