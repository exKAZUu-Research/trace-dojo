// code-gauge-allow-file fileNcss -- The format module keeps one stage of the C# interpreter together.
// oxlint-disable unicorn/prefer-code-point -- C# characters are UTF-16 code units, which code points would merge.
import { CsDecimal } from './decimal';
import { PendingException } from './numeric';

/** The number formatting of the ja-JP culture, which the reference runtime uses (with ICU's data). */
export const CULTURE = {
  decimalSeparator: '.',
  groupSeparator: ',',
  negativeSign: '-',
  numberDecimalDigits: 3,
  percentDecimalDigits: 3,
  currencyDecimalDigits: 0,
  currencySymbol: '¥',
  nan: 'NaN',
  positiveInfinity: '∞',
  negativeInfinity: '-∞',
};

/** The digits of a number: `0.d1d2… × 10^exponent`, with no leading zeros, or empty for zero. */
interface Digits {
  digits: string;
  exponent: number;
  isNegative: boolean;
}

const invalidFormat = (): PendingException =>
  new PendingException('System.FormatException', 'Format specifier was invalid.');

// ---- Digits ----

// code-gauge-allow duplicateLines -- Each interpreter keeps its own copy of the digit extraction so its languages stay independent.
/** The exact decimal digits of a double. */
function exactDigits(value: number): Digits {
  const isNegative = value < 0 || Object.is(value, -0);
  const magnitude = Math.abs(value);
  if (magnitude === 0) return { digits: '', exponent: 0, isNegative };
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, magnitude);
  const bits = view.getBigUint64(0);
  const biasedExponent = Number((bits >> 52n) & 0x7_ffn);
  let mantissa = bits & 0xf_ff_ff_ff_ff_ff_ffn;
  let exponent2: number;
  if (biasedExponent === 0) {
    exponent2 = -1074;
  } else {
    mantissa |= 1n << 52n;
    exponent2 = biasedExponent - 1075;
  }
  let text: string;
  let pointShift: number;
  if (exponent2 >= 0) {
    text = (mantissa << BigInt(exponent2)).toString();
    pointShift = 0;
  } else {
    text = (mantissa * 5n ** BigInt(-exponent2)).toString();
    pointShift = -exponent2;
  }
  return normalize(text, text.length - pointShift, isNegative);
}

function normalize(text: string, exponent: number, isNegative: boolean): Digits {
  const leading = /^0*/.exec(text)?.[0].length ?? 0;
  const trimmed = text.slice(leading).replace(/0+$/, '');
  return { digits: trimmed, exponent: exponent - leading, isNegative };
}

/** The shortest digits that read back as the same double, or float when `isFloat`. */
export function shortestDigits(value: number, isFloat: boolean): Digits {
  const isNegative = value < 0 || Object.is(value, -0);
  const magnitude = Math.abs(value);
  if (magnitude === 0) return { digits: '', exponent: 0, isNegative };
  let text: string;
  if (isFloat) {
    text = magnitude.toPrecision(9);
    for (let precision = 1; precision <= 9; precision++) {
      const candidate = magnitude.toPrecision(precision);
      if (Math.fround(Number(candidate)) === magnitude) {
        text = candidate;
        break;
      }
    }
    text = Number(text).toExponential();
  } else {
    text = magnitude.toExponential();
  }
  const [mantissa, exponentText] = text.split('e');
  const digits = mantissa.replace('.', '').replace(/0+$/, '');
  return { digits, exponent: Number(exponentText) + 1, isNegative };
}

function decimalDigits(value: CsDecimal): Digits {
  const text = value.coefficient.toString();
  return normalize(text, text.length - value.scale, value.isNegative);
}

function integerDigits(value: bigint): Digits {
  const isNegative = value < 0n;
  const text = (isNegative ? -value : value).toString();
  return normalize(text, text.length, isNegative);
}

/**
 * Rounds digits to `count` significant digits, by `mode`: ties to even on an exact value, or half away from zero as
 * .NET rounds a digit string. A count of zero or less rounds to nothing or to one unit at that position.
 */
function roundDigits(number: Digits, count: number, mode: 'even' | 'away'): Digits {
  const { digits } = number;
  if (digits.length <= count) return number;
  if (count < 0) return { digits: '', exponent: number.exponent, isNegative: number.isNegative };
  const kept = digits.slice(0, count);
  const next = digits.charCodeAt(count) - 48;
  const rest = digits.slice(count + 1);
  const isOddKept = kept.length > 0 && (kept.charCodeAt(kept.length - 1) - 48) % 2 === 1;
  const roundsUp = mode === 'away' ? next >= 5 : next > 5 || (next === 5 && (/[1-9]/.test(rest) || isOddKept));
  if (!roundsUp) return normalize(kept, number.exponent, number.isNegative);
  if (kept.length === 0) return { digits: '1', exponent: number.exponent + 1, isNegative: number.isNegative };
  const incremented = (BigInt(kept) + 1n).toString();
  if (incremented.length > kept.length) return normalize(incremented, number.exponent + 1, number.isNegative);
  return normalize(incremented, number.exponent, number.isNegative);
}

/** Digits rounded to `decimals` places after the point. */
function roundToDecimals(number: Digits, decimals: number, mode: 'even' | 'away'): Digits {
  return roundDigits(number, number.exponent + decimals, mode);
}

// ---- Rendering ----

/** The integer and fraction parts of digits, with `decimals` fraction digits. */
function fixedParts(number: Digits, decimals: number): { integer: string; fraction: string } {
  const { digits, exponent } = number;
  let integer: string;
  let fraction: string;
  if (exponent <= 0) {
    integer = '0';
    fraction = '0'.repeat(-exponent) + digits;
  } else if (exponent >= digits.length) {
    integer = digits + '0'.repeat(exponent - digits.length);
    fraction = '';
  } else {
    integer = digits.slice(0, exponent);
    fraction = digits.slice(exponent);
  }
  if (integer === '') integer = '0';
  fraction = fraction.padEnd(decimals, '0').slice(0, decimals);
  return { integer, fraction };
}

function group(integer: string): string {
  return integer.replaceAll(/\B(?=(\d{3})+(?!\d))/g, CULTURE.groupSeparator);
}

function withSign(text: string, number: Digits): string {
  return number.isNegative && number.digits !== '' ? `${CULTURE.negativeSign}${text}` : text;
}

function scientific(
  number: Digits,
  mantissaDigits: number | undefined,
  letter: 'E' | 'e',
  minimumExponentDigits: number,
  trimZeros: boolean
): string {
  const digits = number.digits === '' ? '0' : number.digits;
  const exponent = number.digits === '' ? 0 : number.exponent - 1;
  let mantissa = digits.slice(0, 1);
  let rest = digits.slice(1);
  if (mantissaDigits !== undefined && !trimZeros) rest = rest.padEnd(mantissaDigits, '0').slice(0, mantissaDigits);
  if (trimZeros) rest = rest.replace(/0+$/, '');
  if (rest !== '') mantissa += `${CULTURE.decimalSeparator}${rest}`;
  const sign = exponent < 0 ? '-' : '+';
  return `${mantissa}${letter}${sign}${String(Math.abs(exponent)).padStart(minimumExponentDigits, '0')}`;
}

/** The text that `ToString()` gives a double or float: the shortest round-trip digits, in scientific notation when large or small. */
export function formatFloat(value: number, isFloat: boolean): string {
  if (Number.isNaN(value)) return CULTURE.nan;
  if (value === Number.POSITIVE_INFINITY) return CULTURE.positiveInfinity;
  if (value === Number.NEGATIVE_INFINITY) return CULTURE.negativeInfinity;
  const number = shortestDigits(value, isFloat);
  return generalText(number, isFloat ? 9 : 17, 'E');
}

/** The general format: fixed notation unless the exponent reaches the precision or falls to -5. */
function generalText(number: Digits, precision: number, letter: 'E' | 'e'): string {
  if (number.digits === '') return number.isNegative ? `${CULTURE.negativeSign}0` : '0';
  const exponent = number.exponent - 1;
  if (exponent >= precision || exponent < -4) {
    return withSign(scientific(number, undefined, letter, 2, true), number);
  }
  const { integer, fraction } = fixedParts(number, Math.max(0, number.digits.length - number.exponent));
  const text = fraction === '' ? integer : `${integer}${CULTURE.decimalSeparator}${fraction}`;
  return withSign(text, number);
}

export type NumericKind = 'integer' | 'double' | 'float' | 'decimal';

/** Formats a number with a .NET numeric format string, standard or custom. */
export function formatNumber(
  value: number | bigint | CsDecimal,
  kind: NumericKind,
  format: string | undefined,
  /** The width of an integral type, which `X` shows a negative number in. */
  bits = 32
): string {
  if ((kind === 'double' || kind === 'float') && typeof value === 'number' && !Number.isFinite(value)) {
    return Number.isNaN(value) ? CULTURE.nan : value > 0 ? CULTURE.positiveInfinity : CULTURE.negativeInfinity;
  }
  if (format === undefined || format === '') return defaultText(value, kind);
  const standard = /^([A-Za-z])(\d{0,9})$/.exec(format);
  if (standard)
    return formatStandard(value, kind, standard[1], standard[2] === '' ? undefined : Number(standard[2]), bits);
  return formatCustom(value, kind, format);
}

function defaultText(value: number | bigint | CsDecimal, kind: NumericKind): string {
  if (value instanceof CsDecimal) return value.toString();
  if (kind === 'double' || kind === 'float') return formatFloat(value as number, kind === 'float');
  return String(value);
}

function digitsOf(value: number | bigint | CsDecimal, kind: NumericKind): Digits {
  if (value instanceof CsDecimal) return decimalDigits(value);
  if (typeof value === 'bigint') return integerDigits(value);
  if (kind === 'integer') return integerDigits(BigInt(value));
  if (kind === 'float') return exactDigits(value);
  return exactDigits(value);
}

// code-gauge-allow functionNcss -- One case per standard format specifier.
function formatStandard(
  value: number | bigint | CsDecimal,
  kind: NumericKind,
  specifier: string,
  precision: number | undefined,
  bits: number
): string {
  const upper = specifier.toUpperCase();
  const mode = kind === 'decimal' || kind === 'integer' ? 'away' : 'even';
  switch (upper) {
    case 'D': {
      if (kind !== 'integer') throw invalidFormat();
      const number = digitsOf(value, kind);
      const { integer } = fixedParts(number, 0);
      return withSign(integer.padStart(precision ?? 0, '0'), number);
    }
    case 'X': {
      if (kind !== 'integer') throw invalidFormat();
      return hexText(value as number | bigint, specifier === 'x', precision ?? 0, bits);
    }
    case 'F':
    case 'N': {
      return fixedText(value, kind, upper === 'N', precision ?? CULTURE.numberDecimalDigits, mode);
    }
    case 'P': {
      return percentText(value, kind, precision ?? CULTURE.percentDecimalDigits, mode);
    }
    case 'C': {
      const decimals = precision ?? CULTURE.currencyDecimalDigits;
      const number = roundToDecimals(digitsOf(value, kind), decimals, mode);
      const { integer, fraction } = fixedParts(number, decimals);
      return withSignKeepingZero(
        `${CULTURE.currencySymbol}${group(integer)}${fractionSuffix(decimals, fraction)}`,
        number,
        kind
      );
    }
    case 'E': {
      const decimals = precision ?? 6;
      const number = roundDigits(digitsOf(value, kind), decimals + 1, mode);
      return withSignKeepingZero(scientific(number, decimals, specifier === 'e' ? 'e' : 'E', 3, false), number, kind);
    }
    case 'G': {
      return generalStandardText(value, kind, precision, specifier === 'g' ? 'e' : 'E', mode);
    }
    case 'R': {
      // A decimal is always exact, so its round-trip text is its general one.
      if (kind === 'decimal') return defaultText(value, kind);
      return roundTripText(value, kind);
    }
    default: {
      throw invalidFormat();
    }
  }
}

function fixedText(
  value: number | bigint | CsDecimal,
  kind: NumericKind,
  isGrouped: boolean,
  decimals: number,
  mode: 'even' | 'away'
): string {
  const number = roundToDecimals(digitsOf(value, kind), decimals, mode);
  const { integer, fraction } = fixedParts(number, decimals);
  const text = `${isGrouped ? group(integer) : integer}${fractionSuffix(decimals, fraction)}`;
  return number.digits === '' && !number.isNegative ? text : withSignKeepingZero(text, number, kind);
}

function percentText(
  value: number | bigint | CsDecimal,
  kind: NumericKind,
  decimals: number,
  mode: 'even' | 'away'
): string {
  const base = digitsOf(value, kind);
  const scaled = base.digits === '' ? base : { ...base, exponent: base.exponent + 2 };
  const number = roundToDecimals(scaled, decimals, mode);
  const { integer, fraction } = fixedParts(number, decimals);
  return withSignKeepingZero(`${group(integer)}${fractionSuffix(decimals, fraction)}%`, number, kind);
}

function generalStandardText(
  value: number | bigint | CsDecimal,
  kind: NumericKind,
  precision: number | undefined,
  letter: 'E' | 'e',
  mode: 'even' | 'away'
): string {
  // `G0` of a decimal drops its trailing zeros, which `G` keeps, by taking all 29 of its digits as the precision.
  if (precision === 0 && kind === 'decimal') precision = 29;
  if (precision === undefined || precision === 0) return roundTripText(value, kind);
  return generalText(roundDigits(digitsOf(value, kind), precision, mode), precision, letter);
}

function fractionSuffix(decimals: number, fraction: string): string {
  return decimals > 0 ? `${CULTURE.decimalSeparator}${fraction}` : '';
}

function roundTripText(value: number | bigint | CsDecimal, kind: NumericKind): string {
  if (kind === 'double' || kind === 'float') return formatFloat(value as number, kind === 'float');
  return defaultText(value, kind);
}

/** Fixed-point formats keep the sign of a negative value that rounds to zero, as .NET Core 3.0 and later do. */
function withSignKeepingZero(text: string, number: Digits, kind: NumericKind): string {
  if (number.isNegative && (number.digits !== '' || kind === 'double' || kind === 'float'))
    return `${CULTURE.negativeSign}${text}`;
  return text;
}

function hexText(value: number | bigint, lower: boolean, minimum: number, bits: number): string {
  let integer = BigInt(value);
  if (integer < 0n) integer = BigInt.asUintN(bits, integer);
  const text = integer.toString(16).padStart(minimum, '0');
  return lower ? text : text.toUpperCase();
}

// ---- Custom formats ----

interface Section {
  pattern: string;
}

function formatCustom(value: number | bigint | CsDecimal, kind: NumericKind, format: string): string {
  const sections = splitSections(format);
  const initial = customDigits(value, kind);
  let section = sectionFor(sections, initial);
  let scan = scanPattern(section.pattern);
  let { number, exponent } = roundCustom(initial, scan);
  // A value that rounds to zero in its section takes the zero section, when the format has one.
  if (number.digits === '' && initial.digits !== '' && sections.length > 2) {
    section = sections[2];
    scan = scanPattern(section.pattern);
    ({ number, exponent } = roundCustom({ ...initial, digits: '' }, scan));
  }
  const pattern = section.pattern;
  const { integer: integerPart, fraction: fractionPart } = fixedParts(number, scan.fractionDigits);
  const isZero = number.digits === '';
  const integerDigitsText = customIntegerText(integerPart, number, scan);
  // A section of the negative pattern supplies its own sign; the first section prints the sign of a negative value.
  const needsSign =
    (number.isNegative && sections.length === 1) ||
    (number.isNegative && section === sections[0] && sections.length > 1 && !isZero);
  const result = renderCustom(pattern, scan, integerDigitsText, fractionPart, exponent);
  // A pattern that prints no digit, such as `#` for a value that rounds to zero, prints no sign either.
  if (needsSign && (!isZero || ((kind === 'double' || kind === 'float') && /\d/.test(result))))
    return `${CULTURE.negativeSign}${result}`;
  return result;
}

/** The integer digits a custom pattern prints before padding: none for a zero below one, but one in scientific notation, even for `#E+0`. */
function customIntegerText(integerPart: string, number: Digits, scan: PatternScan): string {
  if (number.digits === '') return scan.scientific ? '0' : '';
  return integerPart === '0' && number.exponent <= 0 ? '' : integerPart;
}

function customDigits(value: number | bigint | CsDecimal, kind: NumericKind): Digits {
  if (kind === 'double') return roundDigits(exactDigits(value as number), 15, 'even');
  if (kind === 'float') return roundDigits(exactDigits(value as number), 7, 'even');
  return digitsOf(value, kind);
}

/** The section of a format for a value: positive, negative, then zero. */
function sectionFor(sections: Section[], number: Digits): Section {
  if (sections.length === 1) return sections[0];
  // A negative zero, which only a double has, takes the negative section unless the format has a zero section.
  const chosen =
    number.digits === '' && (sections.length > 2 || !number.isNegative)
      ? (sections[2] ?? sections[0])
      : number.isNegative
        ? sections[1]
        : sections[0];
  // An empty section stands for the first one, as in `0.0;;` for zero.
  return chosen.pattern === '' ? sections[0] : chosen;
}

/** Scales and rounds a value as a pattern's placeholders, percent signs, scaling commas, and exponent ask. */
function roundCustom(initial: Digits, scan: PatternScan): { number: Digits; exponent: number } {
  let number = initial;
  if (scan.percent) number = { ...number, exponent: number.exponent + 2 * scan.percent };
  if (scan.permille) number = { ...number, exponent: number.exponent + 3 * scan.permille };
  if (scan.scaleDown) number = { ...number, exponent: number.exponent - 3 * scan.scaleDown };
  if (!scan.scientific) return { number: roundToDecimals(number, scan.fractionDigits, 'away'), exponent: 0 };
  number = roundDigits(number, scan.integerDigits + scan.fractionDigits, 'away');
  if (number.digits === '') return { number, exponent: 0 };
  return {
    number: { ...number, exponent: scan.integerDigits },
    exponent: number.exponent - scan.integerDigits,
  };
}

function splitSections(format: string): Section[] {
  const sections: Section[] = [];
  let current = '';
  let quote: string | undefined;
  for (let index = 0; index < format.length; index++) {
    const char = format[index];
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === '\\') {
      current += char + (format[index + 1] ?? '');
      index++;
    } else if (char === ';') {
      sections.push({ pattern: current });
      current = '';
    } else {
      current += char;
    }
  }
  sections.push({ pattern: current });
  return sections.slice(0, 3);
}

interface PatternScan {
  integerDigits: number;
  /** The number of `0` placeholders before the point, which decide the minimum number of integer digits. */
  integerZeros: number;
  fractionDigits: number;
  fractionZeros: number;
  hasGrouping: boolean;
  percent: number;
  permille: number;
  scaleDown: number;
  scientific: { letter: string; sign: boolean; digits: number } | undefined;
}

function scanPattern(pattern: string): PatternScan {
  const scan: PatternScan = {
    integerDigits: 0,
    integerZeros: 0,
    fractionDigits: 0,
    fractionZeros: 0,
    hasGrouping: false,
    percent: 0,
    permille: 0,
    scaleDown: 0,
    scientific: undefined,
  };
  const state: ScanState = { inFraction: false, firstZero: -1, lastDigitBeforePoint: -1 };
  for (let index = 0; index < pattern.length; index++) {
    const literalEnd = literalEndOf(pattern, index);
    if (literalEnd !== undefined) index = literalEnd;
    else if (!scan.scientific) index = scanCharacter(pattern, index, scan, state);
  }
  scan.integerZeros = state.firstZero < 0 ? 0 : scan.integerDigits - state.firstZero + 1;
  return scan;
}

interface ScanState {
  inFraction: boolean;
  firstZero: number;
  lastDigitBeforePoint: number;
}

/** The index of the last character of a quoted string or an escaped character that starts at an index. */
function literalEndOf(pattern: string, index: number): number | undefined {
  const char = pattern[index];
  if (char === '\\') return index + 1;
  if (char !== "'" && char !== '"') return undefined;
  const end = pattern.indexOf(char, index + 1);
  return end === -1 ? pattern.length : end;
}

/** Records one character of a custom pattern, returning the index of the last character it consumed. */
function scanCharacter(pattern: string, index: number, scan: PatternScan, state: ScanState): number {
  const char = pattern[index];
  if (char === '0' || char === '#') {
    scanDigit(char, index, scan, state);
  } else if (char === '.') {
    state.inFraction = true;
  } else if (char === ',') {
    if (!state.inFraction) scanComma(pattern, index, scan, state);
  } else if (char === '%') {
    scan.percent++;
  } else if (char === '‰') {
    scan.permille++;
  } else if (char === 'E' || char === 'e') {
    const match = /^[+-]?(0+)/.exec(pattern.slice(index + 1));
    if (!match) return index;
    scan.scientific = { letter: char, sign: pattern[index + 1] === '+', digits: match[1].length };
    return index + match[0].length;
  }
  return index;
}

function scanDigit(char: string, index: number, scan: PatternScan, state: ScanState): void {
  if (state.inFraction) {
    scan.fractionDigits++;
    if (char === '0') scan.fractionZeros = scan.fractionDigits;
    return;
  }
  scan.integerDigits++;
  if (char === '0' && state.firstZero < 0) state.firstZero = scan.integerDigits;
  state.lastDigitBeforePoint = index;
}

function scanComma(pattern: string, index: number, scan: PatternScan, state: ScanState): void {
  // A comma after the integer part's last digit placeholder scales the number by a thousand; others group digits.
  const integerRest = /^[^.;]*/.exec(pattern.slice(index + 1))?.[0] ?? '';
  if (!/[0#]/.test(integerRest)) scan.scaleDown++;
  else if (state.lastDigitBeforePoint >= 0) scan.hasGrouping = true;
}

function renderCustom(
  pattern: string,
  scan: PatternScan,
  integerText: string,
  fractionText: string,
  exponent: number
): string {
  const integer = integerText.padStart(scan.integerZeros, '0');
  // Trailing `#` placeholders drop zeros that no `0` placeholder requires.
  let fraction = fractionText;
  while (fraction.length > scan.fractionZeros && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  const state: RenderState = {
    integer,
    hasGrouping: scan.hasGrouping,
    fraction,
    result: '',
    inFraction: false,
    integerSlots: scan.integerDigits,
    integerIndex: 0,
    fractionIndex: 0,
    pointWritten: false,
  };
  for (let index = 0; index < pattern.length; index++) index = renderCharacter(pattern, index, scan, exponent, state);
  return state.result;
}

interface RenderState {
  integer: string;
  hasGrouping: boolean;
  fraction: string;
  result: string;
  inFraction: boolean;
  /** The integer placeholders not yet rendered. */
  integerSlots: number;
  /** The index in `integer` of the next digit to write. */
  integerIndex: number;
  fractionIndex: number;
  pointWritten: boolean;
}

/** Renders one character of a custom pattern, returning the index of the last character it consumed. */
function renderCharacter(
  pattern: string,
  index: number,
  scan: PatternScan,
  exponent: number,
  state: RenderState
): number {
  const char = pattern[index];
  if (char === "'" || char === '"') {
    const end = literalEndOf(pattern, index) as number;
    state.result += pattern.slice(index + 1, end);
    return end;
  }
  if (char === '\\') {
    state.result += pattern[index + 1] ?? '';
    return index + 1;
  }
  if (char === '0' || char === '#') {
    renderDigit(state);
  } else if (char === '.') {
    if (!state.inFraction) {
      writeIntegerDigits(state, state.integer.length);
      state.inFraction = true;
    }
  } else if ((char === 'E' || char === 'e') && scan.scientific) {
    return renderExponent(pattern, index, scan.scientific.sign, exponent, state);
  } else if (char !== ',') {
    state.result += char;
  }
  return index;
}

function renderExponent(
  pattern: string,
  index: number,
  showsPlus: boolean,
  exponent: number,
  state: RenderState
): number {
  const char = pattern[index];
  const match = /^[+-]?(0+)/.exec(pattern.slice(index + 1));
  if (!match) {
    state.result += char;
    return index;
  }
  const sign = exponent < 0 ? '-' : showsPlus ? '+' : '';
  state.result += `${char}${sign}${String(Math.abs(exponent)).padStart(match[1].length, '0')}`;
  return index + match[0].length;
}

function renderDigit(state: RenderState): void {
  if (!state.inFraction) {
    // The integer's digits fill the placeholders from the right, and the first placeholder takes any extra digits,
    // so literals between placeholders, as in `(###) ###-####`, fall between the digits.
    const remaining = state.integerSlots--;
    writeIntegerDigits(state, Math.max(state.integerIndex, state.integer.length - (remaining - 1)));
    return;
  }
  if (state.fractionIndex >= state.fraction.length) return;
  if (!state.pointWritten) {
    state.result += CULTURE.decimalSeparator;
    state.pointWritten = true;
  }
  state.result += state.fraction[state.fractionIndex++];
}

function writeIntegerDigits(state: RenderState, end: number): void {
  const { integer } = state;
  for (; state.integerIndex < end; state.integerIndex++) {
    state.result += integer[state.integerIndex];
    const position = integer.length - 1 - state.integerIndex;
    if (state.hasGrouping && position > 0 && position % 3 === 0) state.result += CULTURE.groupSeparator;
  }
}

// ---- Composite formats ----

export interface FormatItem {
  index: number;
  alignment: number | undefined;
  format: string | undefined;
}

/** Parses a composite format string such as `"{0,5:F2} {1}"` into its literal text and items, as `string.Format` does. */
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
export function parseCompositeFormat(format: string): (string | FormatItem)[] {
  const parts: (string | FormatItem)[] = [];
  let text = '';
  let index = 0;
  while (index < format.length) {
    const char = format[index];
    const isDoubled = format[index + 1] === char;
    // .NET reads past a lone `}` before it reports it, so it points after it, or at the end.
    if (char === '}' && !isDoubled) {
      if (index + 1 >= format.length) throw fail(index + 1, 'Format item ends prematurely.');
      throw fail(index + 1, 'Unexpected closing brace without a corresponding opening brace.');
    }
    if (char !== '{' || isDoubled) {
      text += char;
      index += char === '{' || char === '}' ? 2 : 1;
      continue;
    }
    const { item, end } = parseFormatItem(format, index + 1);
    if (text !== '') parts.push(text);
    text = '';
    parts.push(item);
    index = end;
  }
  if (text !== '') parts.push(text);
  return parts;
}

/** Parses a format item after its opening brace, returning the index after its closing brace. */
function parseFormatItem(format: string, start: number): { item: FormatItem; end: number } {
  const digits = leadingMatch(/^\d*/, format, start);
  let index = start + digits.length;
  if (digits === '') throw digitExpected(format, index);
  index = skipSpaces(format, index);
  let alignment: number | undefined;
  if (format[index] === ',') {
    index = skipSpaces(format, index + 1);
    const alignmentText = leadingMatch(/^-?\d*/, format, index);
    index += alignmentText.length;
    if (alignmentText === '' || alignmentText === '-') throw digitExpected(format, index);
    alignment = Number(alignmentText);
    index = skipSpaces(format, index);
  }
  let itemFormat: string | undefined;
  if (format[index] === ':') {
    const formatStart = index + 1;
    for (index = formatStart; index < format.length && format[index] !== '}'; index++) {
      if (format[index] === '{') throw fail(index, 'Format item ends prematurely.');
    }
    itemFormat = format.slice(formatStart, index);
  }
  if (index >= format.length) throw fail(index, 'Format item ends prematurely.');
  if (format[index] !== '}') throw fail(index, 'Expected an ASCII digit.');
  return { item: { index: Number(digits), alignment, format: itemFormat }, end: index + 1 };
}

function leadingMatch(pattern: RegExp, format: string, index: number): string {
  return (pattern.exec(format.slice(index)) as RegExpExecArray)[0];
}

function skipSpaces(format: string, index: number): number {
  let next = index;
  while (format[next] === ' ') next++;
  return next;
}

function digitExpected(format: string, index: number): PendingException {
  return fail(index, index >= format.length ? 'Format item ends prematurely.' : 'Expected an ASCII digit.');
}

function fail(offset: number, reason: string): PendingException {
  return new PendingException(
    'System.FormatException',
    `Input string was not in a correct format. Failure to parse near offset ${offset}. ${reason}`
  );
}

export const FORMAT_INDEX_ERROR = (): PendingException =>
  new PendingException(
    'System.FormatException',
    'Index (zero based) must be greater than or equal to zero and less than the size of the argument list.'
  );
