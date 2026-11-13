import { currentRuntime } from './native';

/** A finite non-negative number as significant decimal digits and the position of the decimal point. */
interface Decimal {
  /** Digits without leading or trailing zeros, or '' for zero. */
  digits: string;
  /** The value is 0.digits × 10^point. */
  point: number;
}

/**
 * Checks, before building it, that a formatted float of `digits` digits stays within the string limit, allowing for
 * its sign, point, and exponent or hexadecimal prefix, and charges the work of building it.
 */
export function chargeFormatting(digits: number): void {
  const runtime = currentRuntime();
  runtime.checkStringLength(digits + FORMAT_OVERHEAD);
  runtime.spend(1 + Math.floor(digits / 16));
}

/** The most characters a float takes beyond its digits: sign, point, and `e+308` or `0x1.` and `p+1023`. */
const FORMAT_OVERHEAD = 12;

/** The digits of a finite value's integer part, plus one for a carry when it is rounded. */
function integerDigits(magnitude: number): number {
  return magnitude < 1 ? 1 : Math.floor(Math.log10(magnitude)) + 2;
}

/** `strconv.FormatFloat(value, format, precision, bitSize)`, which `fmt` also uses. */
export function formatFloat(value: number, format: string, precision: number, bitSize: 32 | 64): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  // 'e', 'f', and 'x' write `precision` digits, whereas 'g' writes no more digits than the value has.
  if (precision > 0 && format !== 'g' && format !== 'G' && format !== 'b') {
    chargeFormatting(precision + (format === 'f' ? integerDigits(Math.abs(value)) : 0));
  }
  const negative = value < 0 || Object.is(value, -0);
  const magnitude = Math.abs(value);
  if (format === 'b') return (negative ? '-' : '') + binaryExponent(magnitude, bitSize);
  if (format === 'x' || format === 'X')
    return (negative ? '-' : '') + hexFloat(magnitude, precision, bitSize, format === 'X');
  const shortest = precision < 0;
  let digits: Decimal;
  let prec = precision;
  if (shortest) {
    digits = shortestDecimal(magnitude, bitSize);
    switch (format) {
      case 'e':
      case 'E': {
        prec = Math.max(digits.digits.length - 1, 0);
        break;
      }
      case 'f': {
        prec = Math.max(digits.digits.length - digits.point, 0);
        break;
      }
      case 'g':
      case 'G': {
        prec = digits.digits.length;
        break;
      }
    }
  } else {
    const exact = exactDecimal(magnitude);
    switch (format) {
      case 'e':
      case 'E': {
        digits = roundDecimal(exact, prec + 1);
        break;
      }
      case 'f': {
        digits = roundDecimal(exact, exact.point + prec);
        break;
      }
      default: {
        if (prec === 0) prec = 1;
        digits = roundDecimal(exact, prec);
      }
    }
  }
  return (negative ? '-' : '') + formatDigits(digits, format, prec, shortest);
}

function formatDigits(digits: Decimal, format: string, precision: number, shortest: boolean): string {
  switch (format) {
    case 'e':
    case 'E': {
      return exponentForm(digits, precision, format);
    }
    case 'f': {
      return fixedForm(digits, precision);
    }
    default: {
      let exponentPrecision = precision;
      const count = digits.digits.length;
      if (exponentPrecision > count && count >= digits.point) exponentPrecision = count;
      if (shortest) exponentPrecision = 6;
      const exponent = digits.point - 1;
      if (exponent < -4 || exponent >= exponentPrecision) {
        const prec = precision > count ? count : precision;
        return exponentForm(digits, Math.max(prec - 1, 0), format === 'G' ? 'E' : 'e');
      }
      const prec = precision > digits.point ? count : precision;
      return fixedForm(digits, Math.max(prec - digits.point, 0));
    }
  }
}

function exponentForm({ digits, point }: Decimal, precision: number, marker: string): string {
  const all = digits === '' ? '0' : digits;
  let text = all[0];
  if (precision > 0) text += `.${all.slice(1, precision + 1).padEnd(precision, '0')}`;
  const exponent = digits === '' ? 0 : point - 1;
  const magnitude = Math.abs(exponent);
  return `${text}${marker}${exponent < 0 ? '-' : '+'}${magnitude < 10 ? `0${magnitude}` : magnitude}`;
}

function fixedForm({ digits, point }: Decimal, precision: number): string {
  const integer = point > 0 ? digits.slice(0, point).padEnd(point, '0') : '0';
  if (precision <= 0) return integer;
  let fraction = '';
  for (let index = 0; index < precision; index++) {
    const position = point + index;
    fraction += position >= 0 && position < digits.length ? digits[position] : '0';
  }
  return `${integer}.${fraction}`;
}

/** The shortest digits that read back as the same float of the given size. */
function shortestDecimal(value: number, bitSize: 32 | 64): Decimal {
  if (value === 0) return { digits: '', point: 0 };
  if (bitSize === 32) {
    // Rounding the exact value halves to even, as Go's Ryū does on a tie that toPrecision would round up.
    const exact = exactDecimal(value);
    for (let precision = 1; precision <= 9; precision++) {
      const candidate = roundDecimal(exact, precision);
      if (Math.fround(Number(`0.${candidate.digits}e${candidate.point}`)) === value) return candidate;
    }
  }
  return parseDecimal(value.toExponential());
}

function parseDecimal(exponential: string): Decimal {
  const [mantissa, exponent] = exponential.split('e');
  const digits = mantissa.replace('.', '').replace(/0+$/, '');
  return { digits, point: Number(exponent) + 1 };
}

/** The exact decimal expansion of a finite non-negative double. */
function exactDecimal(value: number): Decimal {
  if (value === 0) return { digits: '', point: 0 };
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = Number(bits >> 52n);
  let mantissa = bits & ((1n << 52n) - 1n);
  let exponent = biased - 1075;
  if (biased === 0) exponent = -1074;
  else mantissa |= 1n << 52n;
  let text: string;
  let point: number;
  if (exponent >= 0) {
    text = (mantissa << BigInt(exponent)).toString();
    point = text.length;
  } else {
    text = (mantissa * 5n ** BigInt(-exponent)).toString();
    point = text.length + exponent;
  }
  const trimmed = text.replace(/0+$/, '');
  const leading = trimmed.length - trimmed.replace(/^0+/, '').length;
  return { digits: trimmed.slice(leading), point: point - leading };
}

/** Rounds to `count` significant digits, halves to even, dropping trailing zeros. */
function roundDecimal({ digits, point }: Decimal, count: number): Decimal {
  if (digits === '' || count >= digits.length) return { digits, point };
  if (count < 0) return { digits: '', point: 0 };
  const kept = digits.slice(0, count);
  const rest = digits.slice(count);
  const exactHalf = rest[0] === '5' && /^0*$/.test(rest.slice(1));
  const lastKept = count > 0 ? Number(kept.at(-1)) : 0;
  const roundsUp = rest[0] > '5' || (rest[0] === '5' && !exactHalf) || (exactHalf && lastKept % 2 === 1);
  if (!roundsUp) {
    const trimmed = kept.replace(/0+$/, '');
    return trimmed === '' ? { digits: '', point: 0 } : { digits: trimmed, point };
  }
  if (kept === '') return { digits: '1', point: point + 1 };
  const incremented = (BigInt(kept) + 1n).toString();
  const carried = incremented.length > kept.length;
  return { digits: incremented.replace(/0+$/, ''), point: carried ? point + 1 : point };
}

function binaryExponent(value: number, bitSize: 32 | 64): string {
  const view = new DataView(new ArrayBuffer(8));
  if (bitSize === 32) {
    view.setFloat32(0, value);
    const bits = view.getUint32(0);
    const biased = (bits >>> 23) & 0xff;
    let mantissa = bits & 0x7f_ff_ff;
    if (biased !== 0) mantissa |= 0x80_00_00;
    const exponent = (biased === 0 ? 1 : biased) - 127 - 23;
    return `${mantissa}p${exponent >= 0 ? '+' : ''}${exponent}`;
  }
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = Number(bits >> 52n) & 0x7_ff;
  let mantissa = bits & ((1n << 52n) - 1n);
  if (biased !== 0) mantissa |= 1n << 52n;
  const exponent = (biased === 0 ? 1 : biased) - 1023 - 52;
  return `${mantissa}p${exponent >= 0 ? '+' : ''}${exponent}`;
}

/** `strconv.fmtX`: the %x form of a non-negative float, with the leading 1 at bit 60 while it rounds. */
function hexFloat(value: number, precision: number, bitSize: 32 | 64, upper: boolean): string {
  const mantissaBits = bitSize === 32 ? 23 : 52;
  const view = new DataView(new ArrayBuffer(8));
  let bits: bigint;
  let biased: number;
  if (bitSize === 32) {
    view.setFloat32(0, value);
    bits = BigInt(view.getUint32(0));
    biased = Number(bits >> 23n) & 0xff;
  } else {
    view.setFloat64(0, value);
    bits = view.getBigUint64(0);
    biased = Number(bits >> 52n) & 0x7_ff;
  }
  let mant = bits & ((1n << BigInt(mantissaBits)) - 1n);
  let exp = biased;
  if (exp === 0) exp++;
  else mant |= 1n << BigInt(mantissaBits);
  exp -= bitSize === 32 ? 127 : 1023;
  if (mant === 0n) exp = 0;
  mant <<= BigInt(60 - mantissaBits);
  while (mant !== 0n && (mant & (1n << 60n)) === 0n) {
    mant <<= 1n;
    exp--;
  }
  if (precision >= 0 && precision < 15) {
    const shift = BigInt(precision * 4);
    const extra = BigInt.asUintN(64, mant << shift) & ((1n << 60n) - 1n);
    mant >>= 60n - shift;
    if ((extra | (mant & 1n)) > 1n << 59n) mant++;
    mant <<= 60n - shift;
    if ((mant & (1n << 61n)) !== 0n) {
      mant >>= 1n;
      exp++;
    }
  }
  const lead = String((mant >> 60n) & 1n);
  mant = BigInt.asUintN(64, mant << 4n);
  let fraction = '';
  const nextDigit = (): string => {
    const digit = ((mant >> 60n) & 15n).toString(16);
    mant = BigInt.asUintN(64, mant << 4n);
    return digit;
  };
  if (precision < 0) {
    while (mant !== 0n) fraction += nextDigit();
  } else {
    for (let index = 0; index < precision; index++) fraction += nextDigit();
  }
  const magnitude = Math.abs(exp);
  const text = `0x${lead}${fraction === '' ? '' : `.${fraction}`}p${exp < 0 ? '-' : '+'}${String(magnitude).padStart(2, '0')}`;
  return upper ? text.toUpperCase() : text;
}
