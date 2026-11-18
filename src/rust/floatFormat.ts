/** The shortest decimal digits that read back as `value` (an f64, or an f32 when `f32`), with the decimal exponent. */
export function shortestDigits(value: number, f32: boolean): { digits: string; exponent: number } {
  // `exponent` places the decimal point: value = 0.d1d2... × 10^exponent.
  if (value === 0) return { digits: '0', exponent: 1 };
  const abs = Math.abs(value);
  let text: string;
  if (f32) {
    text = abs.toExponential(8);
    for (let precision = 1; precision <= 9; precision++) {
      const candidate = abs.toExponential(precision - 1);
      if (Math.fround(Number(candidate)) === abs) {
        text = candidate;
        break;
      }
    }
  } else {
    text = abs.toExponential();
  }
  const [mantissa, exp] = text.split('e');
  const digits = mantissa.replace('.', '').replace(/0+$/, '') || '0';
  const exponent = Number(exp) + 1;
  // When the value lies exactly between two shortest candidates, JavaScript takes the even one and Rust the larger.
  if (!f32 && isMidpoint(abs, BigInt(digits) * 2n + 1n, exponent - digits.length)) {
    const larger = String(BigInt(digits) + 1n);
    return { digits: larger.replace(/0+$/, ''), exponent: exponent + larger.length - digits.length };
  }
  return { digits, exponent };
}

/** Whether `value` equals `twiceDigits / 2 × 10^power` exactly. */
function isMidpoint(value: number, twiceDigits: bigint, power: number): boolean {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7_ffn);
  const fraction = bits & 0xf_ff_ff_ff_ff_ff_ffn;
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  // Compares twice each: 2 × value = mantissa × 2^binary, and 2 × midpoint = twiceDigits × 10^power.
  const binary = (biased === 0 ? 1 : biased) - 1075 + 1;
  let left = mantissa;
  let right = twiceDigits;
  if (binary >= 0) left <<= BigInt(binary);
  else right <<= BigInt(-binary);
  if (power >= 0) right *= 10n ** BigInt(power);
  else left *= 10n ** BigInt(-power);
  return left === right;
}

/** Places digits around the decimal point without an exponent: `digits` × 10^(exponent - digits.length). */
function plain(digits: string, exponent: number, minFraction: number): string {
  let intPart: string;
  let fraction: string;
  if (exponent <= 0) {
    intPart = '0';
    fraction = '0'.repeat(-exponent) + digits;
  } else if (exponent >= digits.length) {
    intPart = digits + '0'.repeat(exponent - digits.length);
    fraction = '';
  } else {
    intPart = digits.slice(0, exponent);
    fraction = digits.slice(exponent);
  }
  if (fraction.length < minFraction) fraction += '0'.repeat(minFraction - fraction.length);
  return fraction ? `${intPart}.${fraction}` : intPart;
}

/** `{}` of a float: the shortest digits that read back, never in exponent form. */
export function displayFloat(value: number, f32: boolean): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  const { digits, exponent } = shortestDigits(value, f32);
  return sign + plain(digits, exponent, 0);
}

/** `{:?}` of a float: like `{}` with at least one fractional digit, and in exponent form when very large or small. */
export function debugFloat(value: number, f32: boolean): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e16)) return sign + expFloat(abs, f32, undefined, 'e');
  const { digits, exponent } = shortestDigits(value, f32);
  return sign + plain(digits, exponent, 1);
}

/** `{:e}` of a float, with the shortest digits or a precision. */
export function expFloat(value: number, f32: boolean, precision: number | undefined, letter: 'e' | 'E'): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  const abs = Math.abs(value);
  if (precision === undefined) {
    const { digits, exponent } = shortestDigits(abs, f32);
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${mantissa}${letter}${abs === 0 ? 0 : exponent - 1}`;
  }
  const { digits, exponent } = exactDigitsSignificant(abs, precision + 1);
  const mantissa = precision > 0 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${sign}${mantissa}${letter}${abs === 0 ? 0 : exponent - 1}`;
}

/** `{:.N}` of a float: the exact binary value rounded half to even at N fractional digits. */
export function fixedFloat(value: number, precision: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  const { numerator, denominator } = exactFraction(Math.abs(value));
  const scale = 10n ** BigInt(precision);
  const scaled = numerator * scale;
  let quotient = scaled / denominator;
  const remainder = scaled % denominator;
  const twice = remainder * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient++;
  const text = quotient.toString().padStart(precision + 1, '0');
  if (precision === 0) return sign + text;
  return `${sign}${text.slice(0, -precision)}.${text.slice(-precision)}`;
}

/** A float's exact value as a fraction of bigints. */
// code-gauge-allow duplicateLines 16 -- Each language decodes a float's bits for its own exact formatting.
function exactFraction(value: number): { numerator: bigint; denominator: bigint } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7_ffn);
  let mantissa = bits & ((1n << 52n) - 1n);
  let exponent: number;
  if (exponentBits === 0) {
    exponent = -1074;
  } else {
    mantissa |= 1n << 52n;
    exponent = exponentBits - 1075;
  }
  if (exponent >= 0) return { numerator: mantissa << BigInt(exponent), denominator: 1n };
  return { numerator: mantissa, denominator: 1n << BigInt(-exponent) };
}

function pow(n: number): bigint {
  return 10n ** BigInt(Math.abs(n));
}

/** The first `count` significant digits of a float's exact value, rounded half to even. */
// code-gauge-allow functionCognitiveComplexity 18 -- Computes exact decimal digits of floats, as std::fmt does.
function exactDigitsSignificant(value: number, count: number): { digits: string; exponent: number } {
  if (value === 0) return { digits: '0'.repeat(count), exponent: 1 };
  const { numerator, denominator } = exactFraction(value);
  // Find the decimal exponent: 10^(e-1) <= value < 10^e.
  let exponent = Math.floor(Math.log10(value)) + 1;
  const compareToPower = (e: number): number => {
    // Sign of value - 10^e.
    const left = e >= 0 ? numerator : numerator * pow(e);
    const right = e >= 0 ? denominator * pow(e) : denominator;
    return left === right ? 0 : left > right ? 1 : -1;
  };
  while (compareToPower(exponent) >= 0) exponent++;
  while (compareToPower(exponent - 1) < 0) exponent--;
  const shift = count - exponent;
  let scaledNumerator = numerator;
  let scaledDenominator = denominator;
  if (shift >= 0) scaledNumerator *= pow(shift);
  else scaledDenominator *= pow(shift);
  let quotient = scaledNumerator / scaledDenominator;
  const remainder = scaledNumerator % scaledDenominator;
  const twice = remainder * 2n;
  if (twice > scaledDenominator || (twice === scaledDenominator && quotient % 2n === 1n)) quotient++;
  let digits = quotient.toString();
  if (digits.length > count) {
    digits = digits.slice(0, count);
    exponent++;
  }
  return { digits, exponent };
}
