import { type AnyFloat, asBigFloat, BigFloat, type FloatBits, floatOf, FORMATS } from './floats';

// code-gauge-allow functionCognitiveComplexity 20 -- Encodes normal, subnormal, infinite, and NaN values across the supported binary formats.
export function encodeFloat(value: AnyFloat, bits: FloatBits): bigint {
  const float = asBigFloat(value);
  const precision = FORMATS[bits].precision;
  const fractionBits = precision - 1;
  const exponentBits = bits === 16 ? 5 : bits === 32 ? 8 : bits === 64 ? 11 : 15;
  const bias = (1 << (exponentBits - 1)) - 1;
  const explicit = bits === 80;
  const mantissaBits = fractionBits + (explicit ? 1 : 0);
  let exponent = 0;
  let mantissa = 0n;
  if (float.kind !== 'finite') {
    exponent = (1 << exponentBits) - 1;
    mantissa =
      (explicit ? 1n << BigInt(fractionBits) : 0n) | (float.kind === 'nan' ? 1n << BigInt(fractionBits - 1) : 0n);
  } else if (float.mantissa !== 0n) {
    const highest = float.mantissa.toString(2).length - 1 + float.exponent;
    exponent = Math.max(0, highest + bias);
    const unitExponent = (exponent === 0 ? 1 - bias : highest) - fractionBits;
    const shift = float.exponent - unitExponent;
    mantissa = shift >= 0 ? float.mantissa << BigInt(shift) : float.mantissa >> BigInt(-shift);
    if (!explicit && exponent !== 0) mantissa -= 1n << BigInt(fractionBits);
  }
  return (BigInt(float.sign) << BigInt(bits - 1)) | (BigInt(exponent) << BigInt(mantissaBits)) | mantissa;
}

export function decodeFloat(value: bigint, bits: FloatBits): AnyFloat {
  const fractionBits = FORMATS[bits].precision - 1;
  const exponentBits = bits === 16 ? 5 : bits === 32 ? 8 : bits === 64 ? 11 : 15;
  const bias = (1 << (exponentBits - 1)) - 1;
  const mantissaBits = fractionBits + (bits === 80 ? 1 : 0);
  const exponent = Number((value >> BigInt(mantissaBits)) & BigInt((1 << exponentBits) - 1));
  const sign = value >> BigInt(bits - 1) !== 0n;
  let mantissa = value & ((1n << BigInt(mantissaBits)) - 1n);
  if (exponent === (1 << exponentBits) - 1) {
    const fraction = mantissa & ((1n << BigInt(fractionBits)) - 1n);
    return floatOf(new BigFloat(sign, fraction === 0n ? 'inf' : 'nan', 0n, 0), bits);
  }
  if (exponent !== 0 && bits !== 80) mantissa |= 1n << BigInt(fractionBits);
  return floatOf(
    new BigFloat(sign, 'finite', mantissa, (exponent === 0 ? 1 - bias : exponent - bias) - fractionBits),
    bits
  );
}
