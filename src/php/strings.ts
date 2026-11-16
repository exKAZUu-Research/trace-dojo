// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
/** The next string in PHP's alphanumeric increment (`"a"` → `"b"`, `"Az"` → `"Ba"`, `"zz"` → `"aaa"`). */
// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
export function incrementString(text: string): string {
  const chars = [...text];
  let index = chars.length - 1;
  for (;;) {
    const char = chars[index];
    if (char === 'z') chars[index] = 'a';
    else if (char === 'Z') chars[index] = 'A';
    else if (char === '9') chars[index] = '0';
    else if (/[a-yA-Y0-8]/.test(char)) {
      chars[index] = String.fromCharCode(char.charCodeAt(0) + 1);
      return chars.join('');
    } else return chars.join('');
    if (index === 0) {
      const first = chars[0];
      const prefix = first === 'a' ? 'a' : first === 'A' ? 'A' : '1';
      return prefix + chars.join('');
    }
    index--;
  }
}

/** The exact decimal digits of a finite double's magnitude, and the position of the decimal point among them. */
export function exactDecimal(value: number): { digits: string; point: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7_ffn);
  let mantissa = bits & 0xf_ff_ff_ff_ff_ff_ffn;
  let exponent: number;
  if (exponentBits === 0) exponent = -1074;
  else {
    mantissa |= 1n << 52n;
    exponent = exponentBits - 1075;
  }
  if (mantissa === 0n) return { digits: '0', point: 1 };
  if (exponent >= 0) {
    const digits = (mantissa << BigInt(exponent)).toString();
    return { digits, point: digits.length };
  }
  const scale = -exponent;
  const digits = (mantissa * 5n ** BigInt(scale)).toString();
  return { digits, point: digits.length - scale };
}

/**
 * Rounds a decimal digit string to `keep` digits, half to even as zend_dtoa does on the exact value, returning the
 * rounded digits and whether rounding carried into a new leading digit.
 */
// code-gauge-allow duplicateLines 15 -- Rounds exact digits as the formatters of the other languages do, each kept beside its own language.
function roundDigits(digits: string, keep: number): { digits: string; carried: boolean } {
  if (keep < 0) return { digits: '', carried: false };
  if (keep >= digits.length) return { digits: digits + '0'.repeat(keep - digits.length), carried: false };
  const kept = digits.slice(0, keep);
  const rest = digits.slice(keep);
  const first = rest.charCodeAt(0) - 48;
  let roundUp = first > 5;
  if (first === 5) {
    const tail = rest.slice(1);
    if (/[1-9]/.test(tail)) roundUp = true;
    else {
      const last = keep === 0 ? 0 : kept.charCodeAt(keep - 1) - 48;
      roundUp = last % 2 === 1;
    }
  }
  if (!roundUp) return { digits: kept, carried: false };
  if (keep === 0) return { digits: '1', carried: true };
  const incremented = (BigInt(kept) + 1n).toString().padStart(keep, '0');
  if (incremented.length > keep) return { digits: incremented, carried: true };
  return { digits: incremented, carried: false };
}

/** Formats `|value|` with `precision` decimals, rounding the exact value half to even, as printf's `%f` does. */
export function fixedDigits(value: number, precision: number): string {
  const { digits, point } = exactDecimal(value);
  // Pads so that the integer part has at least one digit.
  const padded = point <= 0 ? '0'.repeat(1 - point) + digits : digits;
  const integerDigits = point <= 0 ? 1 : point;
  const { digits: rounded } = roundDigits(padded, integerDigits + precision);
  const integerLength = rounded.length - precision;
  const integer = rounded.slice(0, integerLength).replace(/^0+(?=\d)/, '') || '0';
  const fraction = rounded.slice(integerLength);
  return precision > 0 ? `${integer}.${fraction}` : integer;
}

/** The first `count` significant digits of `|value|` rounded half to even, and its decimal exponent. */
export function significantDigits(value: number, count: number): { digits: string; exponent: number } {
  if (value === 0) return { digits: '0'.repeat(count), exponent: 0 };
  const { digits, point } = exactDecimal(value);
  const start = digits.search(/[1-9]/);
  const significant = digits.slice(start);
  const exponent = point - start - 1;
  const { digits: rounded, carried } = roundDigits(significant, count);
  if (carried) return { digits: rounded.slice(0, count), exponent: exponent + 1 };
  return { digits: rounded, exponent };
}

/** Formats a float as printf's `%e` does: `1.234568e+4`, with at least one exponent digit. */
export function exponentialText(value: number, precision: number, upper: boolean): string {
  const { digits, exponent } = significantDigits(value, precision + 1);
  const mantissa = precision > 0 ? `${digits[0]}.${digits.slice(1)}` : digits[0];
  return `${mantissa}${upper ? 'E' : 'e'}${exponent < 0 ? '-' : '+'}${Math.abs(exponent)}`;
}

/** Formats a float as printf's `%g` does, through `php_gcvt`. */
export function generalText(value: number, precision: number, upper: boolean): string {
  const count = precision === 0 ? 1 : precision;
  if (value === 0) return '0';
  const { digits: raw, exponent } = significantDigits(value, count);
  const digits = raw.replace(/0+$/, '') || '0';
  const decpt = exponent + 1;
  if (decpt < -3 || decpt > count) {
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : `${digits}.0`;
    return `${mantissa}${upper ? 'E' : 'e'}${exponent < 0 ? '-' : '+'}${Math.abs(exponent)}`;
  }
  if (decpt <= 0) return `0.${'0'.repeat(-decpt)}${digits}`;
  if (digits.length <= decpt) return digits + '0'.repeat(decpt - digits.length);
  return `${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

const POWERS_OF_TEN = Array.from({ length: 23 }, (_, index) => Number(`1e${index}`));

function intPow10(power: number): number {
  if (power < 0 || power > 22) return Math.pow(10, power);
  return POWERS_OF_TEN[power];
}

export type RoundMode =
  | 'halfUp'
  | 'halfDown'
  | 'halfEven'
  | 'halfOdd'
  | 'awayFromZero'
  | 'towardsZero'
  | 'ceiling'
  | 'floor';

/** Rounds a float to `places` decimals as PHP 8.4's `round` does. */
export function phpRound(value: number, places: number, mode: RoundMode = 'halfUp'): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const clamped = Math.max(places, -2_147_483_647);
  const exponent = intPow10(Math.abs(clamped));
  const scaled = clamped > 0 ? value * exponent : value / exponent;
  let integral = value >= 0 ? Math.floor(scaled) : Math.ceil(scaled);
  if ((clamped > 0 ? integral / exponent : integral * exponent) === value) return value;
  integral = roundHelper(integral, value, exponent, clamped, mode);
  let result: number;
  if (Math.abs(clamped) < 23) result = clamped > 0 ? integral / exponent : integral * exponent;
  else {
    result = Number(`${integral.toFixed(6)}e${-clamped}`);
    if (!Number.isFinite(result)) return value;
  }
  return result;
}

// code-gauge-allow functionCognitiveComplexity 28 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
// code-gauge-allow functionNcss 31 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function roundHelper(integral: number, value: number, exponent: number, places: number, mode: RoundMode): number {
  const valueAbs = Math.abs(value);
  const edge = (): number =>
    places > 0
      ? Math.abs((integral + Math.sign(integral || value) * 0.5) / exponent)
      : Math.abs((integral + Math.sign(integral || value) * 0.5) * exponent);
  const away = (): number => integral + Math.sign(integral || value);
  switch (mode) {
    case 'halfUp': {
      return valueAbs >= edge() ? away() : integral;
    }
    case 'halfDown': {
      return valueAbs > edge() ? away() : integral;
    }
    case 'halfEven': {
      const edgeValue = edge();
      if (valueAbs > edgeValue) return away();
      if (valueAbs === edgeValue) return Math.abs(integral % 2) === 1 ? away() : integral;
      return integral;
    }
    case 'halfOdd': {
      const edgeValue = edge();
      if (valueAbs > edgeValue) return away();
      if (valueAbs === edgeValue) return Math.abs(integral % 2) === 0 ? away() : integral;
      return integral;
    }
    case 'awayFromZero': {
      return away();
    }
    case 'towardsZero': {
      return integral;
    }
    case 'ceiling': {
      return value > 0 ? away() : integral;
    }
    case 'floor': {
      return value < 0 ? away() : integral;
    }
  }
}
