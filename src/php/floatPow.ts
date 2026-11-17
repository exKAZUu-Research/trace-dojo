/**
 * `x ** y` for floats as C's pow, which PHP calls. JavaScriptCore multiplies repeatedly for integer exponents up to
 * 1000, which loses precision, so this computes those powers exactly and rounds once.
 */
export function cPow(x: number, y: number): number {
  if (x === 1 || (Math.abs(x) === 1 && (y === Infinity || y === -Infinity))) return 1;
  if (!Number.isInteger(y) || Math.abs(y) < 2 || Math.abs(y) > 1000 || x === 0 || !Number.isFinite(x)) {
    return x ** y;
  }
  const [mantissa, exponent] = decompose(Math.abs(x));
  const power = mantissa ** BigInt(Math.abs(y));
  const magnitude = y > 0 ? scaledToFloat(power, exponent * y) : reciprocal(power, exponent * -y);
  return x < 0 && y % 2 !== 0 ? -magnitude : magnitude;
}

/** Splits a positive finite float into an integer mantissa and a power of two. */
function decompose(value: number): [bigint, number] {
  let exponent = 0;
  while (!Number.isInteger(value)) {
    value *= 2;
    exponent--;
  }
  return [BigInt(value), exponent];
}

/** `1 / (mantissa * 2 ** exponent)`, rounded once. */
function reciprocal(mantissa: bigint, exponent: number): number {
  const shift = mantissa.toString(2).length + 64;
  const quotient = (1n << BigInt(shift)) / mantissa;
  const sticky = quotient * mantissa === 1n << BigInt(shift) ? 0n : 1n;
  return scaledToFloat((quotient << 1n) | sticky, -shift - exponent - 1);
}

/** `mantissa * 2 ** exponent` rounded to the nearest float, ties to even, including subnormal results. */
function scaledToFloat(mantissa: bigint, exponent: number): number {
  const bits = mantissa.toString(2).length;
  const top = bits - 1 + exponent;
  if (top > 1023) return Infinity;
  const precision = Math.min(53, top + 1075);
  if (precision < 0) return 0;
  const shift = bits - precision;
  if (shift <= 0) return Number(mantissa) * 2 ** exponent;
  let kept = mantissa >> BigInt(shift);
  const dropped = mantissa - (kept << BigInt(shift));
  const half = 1n << BigInt(shift - 1);
  if (dropped > half || (dropped === half && (kept & 1n) === 1n)) kept++;
  return Number(kept) * 2 ** (exponent + shift);
}
