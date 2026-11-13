import { currentRuntime } from './native';

/** A finite non-negative number as significant decimal digits and the position of the decimal point. */
interface Decimal {
  /** Digits without leading or trailing zeros, or '' for zero. */
  digits: string;
  /** The value is 0.digits × 10^point. */
  point: number;
}

/** `strconv.FormatFloat(value, format, precision, bitSize)`, which `fmt` also uses. */
export function formatFloat(value: number, format: string, precision: number, bitSize: 32 | 64): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  // 'e', 'f', and 'x' write `precision` digits, whereas 'g' writes no more digits than the value has.
  if (precision > 0 && format !== 'g' && format !== 'G' && format !== 'b') {
    const runtime = currentRuntime();
    runtime.checkStringLength(precision);
    runtime.spend(1 + Math.floor(precision / 16));
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
    for (let precision = 1; precision <= 9; precision++) {
      const text = value.toPrecision(precision);
      if (Math.fround(Number(text)) === value) return parseDecimal(Number(text).toExponential(precision - 1));
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

function hexFloat(value: number, precision: number, bitSize: 32 | 64, upper: boolean): string {
  let mantissa: bigint;
  let exponent: number;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, bitSize === 32 ? Math.fround(value) : value);
  const bits = view.getBigUint64(0);
  const biased = Number(bits >> 52n) & 0x7_ff;
  mantissa = bits & ((1n << 52n) - 1n);
  if (value === 0) {
    mantissa = 0n;
    exponent = 0;
  } else if (biased === 0) {
    exponent = -1022;
    while (mantissa < 1n << 52n) {
      mantissa <<= 1n;
      exponent--;
    }
    mantissa &= (1n << 52n) - 1n;
  } else {
    exponent = biased - 1023;
  }
  // 52 fraction bits are 13 hex digits; round to the precision, halves to even.
  let fraction = mantissa;
  let digits = 13;
  if (precision >= 0 && precision < 13) {
    const drop = BigInt((13 - precision) * 4);
    const remainder = fraction & ((1n << drop) - 1n);
    const half = 1n << (drop - 1n);
    fraction >>= drop;
    if (remainder > half || (remainder === half && (fraction & 1n) === 1n)) fraction++;
    digits = precision;
    if (fraction >> BigInt(digits * 4) !== 0n) {
      fraction &= (1n << BigInt(digits * 4)) - 1n;
      exponent++;
    }
  }
  let hex = digits > 0 ? fraction.toString(16).padStart(digits, '0') : '';
  if (precision < 0) hex = hex.replace(/0+$/, '');
  else if (precision > 13) hex = hex.padEnd(precision, '0');
  const lead = value === 0 ? '0' : '1';
  const text = `0x${lead}${hex === '' ? '' : `.${hex}`}p${exponent >= 0 ? '+' : '-'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  return upper ? text.toUpperCase() : text;
}
