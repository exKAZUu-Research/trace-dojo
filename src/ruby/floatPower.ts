/** The largest exponent computed exactly; larger ones overflow or underflow for every base not close to 1. */
const MAX_EXACT_EXPONENT = 1100;

/**
 * `base ** exponent` for a whole-number exponent, rounded to the nearest Float as the C library's `pow` that Ruby calls
 * rounds it (`10.0 ** 23` is `1.0e+23`). JavaScript engines round some of these powers differently on each platform,
 * so the power is computed exactly with integers and rounded once. Returns undefined for the other exponents.
 */
export function exactFloatPower(base: number, exponent: number): number | undefined {
  if (!Number.isFinite(base) || base === 0 || !Number.isInteger(exponent) || Math.abs(exponent) > MAX_EXACT_EXPONENT) {
    return undefined;
  }
  const { mantissa, scale } = decompose(Math.abs(base));
  const count = BigInt(Math.abs(exponent));
  const power = mantissa ** count;
  // |base| ** exponent is power * 2 ** (scale * exponent) for a positive exponent and its reciprocal for a negative one.
  const magnitude =
    exponent >= 0 ? roundScaled(power, scale * exponent) : roundReciprocal(power, -scale * Math.abs(exponent));
  return base < 0 && exponent % 2 !== 0 ? -magnitude : magnitude;
}

/** A positive finite Float as an odd integer mantissa times a power of two. */
function decompose(value: number): { mantissa: bigint; scale: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7_ffn);
  let mantissa = bits & ((1n << 52n) - 1n);
  let scale = -1074;
  if (biased > 0) {
    mantissa |= 1n << 52n;
    scale = biased - 1075;
  }
  while ((mantissa & 1n) === 0n) {
    mantissa >>= 1n;
    scale++;
  }
  return { mantissa, scale };
}

/** The bits of a positive integer, shortened to 64 with a sticky last bit, so that one more rounding is exact. */
function shorten(value: bigint): { bits: bigint; dropped: number } {
  const length = value.toString(2).length;
  if (length <= 64) return { bits: value, dropped: 0 };
  const dropped = length - 64;
  const kept = value >> BigInt(dropped);
  const sticky = kept << BigInt(dropped) === value ? 0n : 1n;
  return { bits: (kept << 1n) | sticky, dropped: dropped - 1 };
}

/** `integer * 2 ** shift`, rounded to the nearest Float. */
function roundScaled(integer: bigint, shift: number): number {
  const { bits, dropped } = shorten(integer);
  return timesPowerOfTwo(Number(bits), shift + dropped);
}

/** `2 ** shift / integer`, rounded to the nearest Float. */
function roundReciprocal(integer: bigint, shift: number): number {
  const precision = integer.toString(2).length + 66;
  const numerator = 1n << BigInt(precision);
  const quotient = numerator / integer;
  const sticky = quotient * integer === numerator ? 0n : 1n;
  return timesPowerOfTwo(Number((quotient << 1n) | sticky), shift - precision - 1);
}

/** Multiplies by a power of two in steps that keep the intermediate values normal, so only the last step can round. */
function timesPowerOfTwo(value: number, shift: number): number {
  let result = value;
  let remaining = shift;
  while (remaining > 900) {
    result *= 2 ** 900;
    remaining -= 900;
  }
  while (remaining < -900) {
    result *= 2 ** -900;
    remaining += 900;
  }
  return result * 2 ** remaining;
}
