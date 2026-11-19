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
  return generalText(number, isFloat ? 9 : 17, 'E', true);
}

/** The general format: fixed notation unless the exponent reaches the precision or falls below -5. */
function generalText(number: Digits, precision: number, letter: 'E' | 'e', isRoundTrip: boolean): string {
  if (number.digits === '') return number.isNegative ? `${CULTURE.negativeSign}0` : '0';
  const exponent = number.exponent - 1;
  if (exponent >= precision || exponent < -5) {
    void isRoundTrip;
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
  format: string | undefined
): string {
  if ((kind === 'double' || kind === 'float') && typeof value === 'number' && !Number.isFinite(value)) {
    return Number.isNaN(value) ? CULTURE.nan : value > 0 ? CULTURE.positiveInfinity : CULTURE.negativeInfinity;
  }
  if (format === undefined || format === '') return defaultText(value, kind);
  const standard = /^([A-Za-z])(\d{0,9})$/.exec(format);
  if (standard) return formatStandard(value, kind, standard[1], standard[2] === '' ? undefined : Number(standard[2]));
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

// code-gauge-allow functionNcss 80 -- One case per standard format specifier.
function formatStandard(
  value: number | bigint | CsDecimal,
  kind: NumericKind,
  specifier: string,
  precision: number | undefined
): string {
  const upper = specifier.toUpperCase();
  const mode = kind === 'decimal' || kind === 'integer' ? 'away' : 'even';
  const isInteger = kind === 'integer';
  switch (upper) {
    case 'D': {
      if (!isInteger) throw invalidFormat();
      const number = digitsOf(value, kind);
      const { integer } = fixedParts(number, 0);
      return withSign(integer.padStart(precision ?? 0, '0'), number);
    }
    case 'X': {
      if (!isInteger) throw invalidFormat();
      return hexText(value as number | bigint, specifier === 'x', precision ?? 0);
    }
    case 'F':
    case 'N': {
      const decimals = precision ?? CULTURE.numberDecimalDigits;
      const number = roundToDecimals(digitsOf(value, kind), decimals, mode);
      const { integer, fraction } = fixedParts(number, decimals);
      const integerText = upper === 'N' ? group(integer) : integer;
      const text = decimals > 0 ? `${integerText}${CULTURE.decimalSeparator}${fraction}` : integerText;
      return number.digits === '' && !number.isNegative ? text : withSignKeepingZero(text, number, kind);
    }
    case 'P': {
      const decimals = precision ?? CULTURE.percentDecimalDigits;
      const base = digitsOf(value, kind);
      const scaled = { ...base, exponent: base.exponent + 2 };
      const number = roundToDecimals(scaled, decimals, mode);
      const { integer, fraction } = fixedParts(number, decimals);
      const text = `${group(integer)}${decimals > 0 ? `${CULTURE.decimalSeparator}${fraction}` : ''}%`;
      return withSignKeepingZero(text, number, kind);
    }
    case 'C': {
      const decimals = precision ?? CULTURE.currencyDecimalDigits;
      const number = roundToDecimals(digitsOf(value, kind), decimals, mode);
      const { integer, fraction } = fixedParts(number, decimals);
      const text = `${CULTURE.currencySymbol}${group(integer)}${decimals > 0 ? `${CULTURE.decimalSeparator}${fraction}` : ''}`;
      return withSign(text, number);
    }
    case 'E': {
      const decimals = precision ?? 6;
      const number = roundDigits(digitsOf(value, kind), decimals + 1, mode);
      return withSign(scientific(number, decimals, specifier === 'e' ? 'e' : 'E', 3, false), number);
    }
    case 'G': {
      if (precision === undefined || precision === 0) {
        if (kind === 'double' || kind === 'float') return formatFloat(value as number, kind === 'float');
        return defaultText(value, kind);
      }
      const number = roundDigits(digitsOf(value, kind), precision, mode);
      return generalText(number, precision, specifier === 'g' ? 'e' : 'E', false);
    }
    case 'R': {
      if (kind === 'double' || kind === 'float') return formatFloat(value as number, kind === 'float');
      if (kind === 'integer') return String(value);
      throw invalidFormat();
    }
    default: {
      throw invalidFormat();
    }
  }
}

/** Fixed-point formats keep the sign of a negative value that rounds to zero, as .NET Core 3.0 and later do. */
function withSignKeepingZero(text: string, number: Digits, kind: NumericKind): string {
  if (number.isNegative && (number.digits !== '' || kind === 'double' || kind === 'float'))
    return `${CULTURE.negativeSign}${text}`;
  return text;
}

function hexText(value: number | bigint, lower: boolean, minimum: number): string {
  let integer = BigInt(value);
  if (integer < 0n) integer = BigInt.asUintN(typeof value === 'bigint' ? 64 : 32, integer);
  const text = integer.toString(16).padStart(minimum, '0');
  return lower ? text : text.toUpperCase();
}

// ---- Custom formats ----

interface Section {
  pattern: string;
}

// code-gauge-allow functionNcss 90 -- .NET's custom numeric format, transcribed from its scanning of the format.
function formatCustom(value: number | bigint | CsDecimal, kind: NumericKind, format: string): string {
  const sections = splitSections(format);
  let number: Digits =
    kind === 'double'
      ? roundDigits(exactDigits(value as number), 15, 'even')
      : kind === 'float'
        ? roundDigits(exactDigits(value as number), 7, 'even')
        : digitsOf(value, kind);
  let section = sections[0];
  if (sections.length > 1) {
    if (number.isNegative && number.digits !== '') section = sections[1];
    if (number.digits === '' && sections.length > 2) section = sections[2];
  }
  const pattern = section.pattern;
  const scan = scanPattern(pattern);
  if (scan.percent) number = { ...number, exponent: number.exponent + 2 * scan.percent };
  if (scan.scaleDown) number = { ...number, exponent: number.exponent - 3 * scan.scaleDown };
  let exponentValue = 0;
  if (scan.scientific) {
    const significant = scan.integerDigits + scan.fractionDigits;
    number = roundDigits(number, significant, 'away');
    if (number.digits !== '') {
      exponentValue = number.exponent - scan.integerDigits;
      number = { ...number, exponent: scan.integerDigits };
    }
  } else {
    number = roundToDecimals(number, scan.fractionDigits, 'away');
  }
  const { integer: integerPart, fraction: fractionPart } = fixedParts(number, scan.fractionDigits);
  const integerDigitsText = integerPart === '0' && number.exponent <= 0 ? '' : integerPart;
  const isZero = number.digits === '';
  // A section of the negative pattern supplies its own sign; the first section prints the sign of a negative value.
  const needsSign =
    (number.isNegative && sections.length === 1) ||
    (number.isNegative && section === sections[0] && sections.length > 1 && !(number.digits === ''));
  const result = renderCustom(pattern, scan, integerDigitsText, fractionPart, exponentValue);
  if (needsSign && (!isZero || kind === 'double' || kind === 'float')) return `${CULTURE.negativeSign}${result}`;
  return result;
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
    scaleDown: 0,
    scientific: undefined,
  };
  let inFraction = false;
  let firstZero = -1;
  let lastDigitBeforePoint = -1;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "'" || char === '"') {
      const end = pattern.indexOf(char, index + 1);
      index = end === -1 ? pattern.length : end;
      continue;
    }
    if (char === '\\') {
      index++;
      continue;
    }
    if (scan.scientific) continue;
    if (char === '0' || char === '#') {
      if (inFraction) {
        scan.fractionDigits++;
        if (char === '0') scan.fractionZeros = scan.fractionDigits;
      } else {
        scan.integerDigits++;
        if (char === '0' && firstZero < 0) firstZero = scan.integerDigits;
        lastDigitBeforePoint = index;
      }
    } else if (char === '.' && !inFraction) {
      inFraction = true;
    } else if (char === ',') {
      if (!inFraction) {
        const next = pattern[index + 1];
        if (next === undefined || next === '.' || next === ';') scan.scaleDown++;
        else if (lastDigitBeforePoint >= 0) scan.hasGrouping = true;
      }
    } else if (char === '%') {
      scan.percent++;
    } else if ((char === 'E' || char === 'e') && /^[+-]?0/.test(pattern.slice(index + 1))) {
      const sign = pattern[index + 1] === '+';
      const match = /^[+-]?(0+)/.exec(pattern.slice(index + 1)) as RegExpExecArray;
      scan.scientific = { letter: char, sign, digits: match[1].length };
      index += match[0].length;
    }
  }
  scan.integerZeros = firstZero < 0 ? 0 : scan.integerDigits - firstZero + 1;
  return scan;
}

// code-gauge-allow functionNcss 60 -- Rendering each placeholder of a custom format.
function renderCustom(
  pattern: string,
  scan: PatternScan,
  integerText: string,
  fractionText: string,
  exponent: number
): string {
  let integer = integerText.padStart(scan.integerZeros, '0');
  if (scan.hasGrouping) integer = group(integer);
  // Trailing `#` placeholders drop zeros that no `0` placeholder requires.
  let fraction = fractionText;
  while (fraction.length > scan.fractionZeros && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  let result = '';
  let inFraction = false;
  let integerWritten = false;
  let fractionIndex = 0;
  let pointWritten = false;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "'" || char === '"') {
      const end = pattern.indexOf(char, index + 1);
      result += pattern.slice(index + 1, end === -1 ? pattern.length : end);
      index = end === -1 ? pattern.length : end;
      continue;
    }
    if (char === '\\') {
      result += pattern[index + 1] ?? '';
      index++;
      continue;
    }
    if (char === '0' || char === '#') {
      if (!inFraction) {
        if (!integerWritten) {
          result += integer;
          integerWritten = true;
        }
      } else if (fractionIndex < fraction.length) {
        if (!pointWritten) {
          result += CULTURE.decimalSeparator;
          pointWritten = true;
        }
        result += fraction[fractionIndex++];
      }
      continue;
    }
    if (char === '.') {
      if (!inFraction) {
        if (!integerWritten) {
          result += integer;
          integerWritten = true;
        }
        inFraction = true;
      }
      continue;
    }
    if (char === ',') continue;
    if (char === '%') {
      result += '%';
      continue;
    }
    if ((char === 'E' || char === 'e') && scan.scientific && /^[+-]?0/.test(pattern.slice(index + 1))) {
      const match = /^[+-]?(0+)/.exec(pattern.slice(index + 1)) as RegExpExecArray;
      const sign = exponent < 0 ? '-' : scan.scientific.sign ? '+' : '';
      result += `${char}${sign}${String(Math.abs(exponent)).padStart(match[1].length, '0')}`;
      index += match[0].length;
      continue;
    }
    result += char;
  }
  return result;
}

// ---- Composite formats ----

export interface FormatItem {
  index: number;
  alignment: number | undefined;
  format: string | undefined;
}

/** Parses a composite format string such as `"{0,5:F2} {1}"` into its literal text and items, as `string.Format` does. */
export function parseCompositeFormat(format: string): (string | FormatItem)[] {
  const parts: (string | FormatItem)[] = [];
  let text = '';
  let index = 0;
  while (index < format.length) {
    const char = format[index];
    if (char === '}') {
      if (format[index + 1] === '}') {
        text += '}';
        index += 2;
        continue;
      }
      throw fail(index, 'Unexpected closing brace without a corresponding opening brace.');
    }
    if (char !== '{') {
      text += char;
      index++;
      continue;
    }
    if (format[index + 1] === '{') {
      text += '{';
      index += 2;
      continue;
    }
    index++;
    let digits = '';
    while (index < format.length && /\d/.test(format[index])) digits += format[index++];
    if (digits === '')
      throw fail(index, index >= format.length ? 'Format item ends prematurely.' : 'Expected an ASCII digit.');
    while (format[index] === ' ') index++;
    let alignment: number | undefined;
    if (format[index] === ',') {
      index++;
      while (format[index] === ' ') index++;
      let alignmentText = '';
      if (format[index] === '-') alignmentText += format[index++];
      while (index < format.length && /\d/.test(format[index])) alignmentText += format[index++];
      if (alignmentText === '' || alignmentText === '-')
        throw fail(index, index >= format.length ? 'Format item ends prematurely.' : 'Expected an ASCII digit.');
      alignment = Number(alignmentText);
      while (format[index] === ' ') index++;
    }
    let itemFormat: string | undefined;
    if (format[index] === ':') {
      index++;
      let formatText = '';
      while (index < format.length && format[index] !== '}') {
        if (format[index] === '{') throw fail(index, 'Unexpected opening brace inside a format item.');
        formatText += format[index++];
      }
      itemFormat = formatText;
    }
    if (index >= format.length) throw fail(index, 'Format item ends prematurely.');
    if (format[index] !== '}') throw fail(index, 'Expected an ASCII digit.');
    index++;
    if (text !== '') parts.push(text);
    text = '';
    parts.push({ index: Number(digits), alignment, format: itemFormat });
  }
  if (text !== '') parts.push(text);
  return parts;
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
