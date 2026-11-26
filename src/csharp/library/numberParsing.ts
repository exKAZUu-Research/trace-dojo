import { type Culture, providerCulture } from '../cultures';
import { CsDecimal } from '../decimal';
import { NUMBER_SYMBOLS } from '../format';
import type { NativeCall, NativeMethod } from '../natives';
import type { Value } from '../values';
import { fail, failNull, refOf } from './support';

/** `System.Globalization.NumberStyles`' flags and the composites that `Parse` takes by default. */
export const NumberStyles = {
  AllowLeadingWhite: 1,
  AllowTrailingWhite: 2,
  AllowLeadingSign: 4,
  AllowTrailingSign: 8,
  AllowParentheses: 16,
  AllowDecimalPoint: 32,
  AllowThousands: 64,
  AllowExponent: 128,
  AllowCurrencySymbol: 256,
  AllowHexSpecifier: 512,
  AllowBinarySpecifier: 1024,
  Integer: 7,
  Number: 111,
  /** `Float | AllowThousands`, which `double.Parse` and `float.Parse` take by default. */
  FloatWithThousands: 231,
} as const;

/** The decimal type in .NET's OverflowException message. */
export const DECIMAL_NAME = 'a Decimal';

const ALL_STYLES = 2047;
const WHITE_STYLES = NumberStyles.AllowLeadingWhite | NumberStyles.AllowTrailingWhite;
const RADIX_STYLES = NumberStyles.AllowHexSpecifier | NumberStyles.AllowBinarySpecifier;

/** The digits of a number as written, without group separators: `±integer.fraction × 10^exponent`. */
interface ScannedNumber {
  isNegative: boolean;
  integer: string;
  fraction: string;
  exponent: number;
}

/** The result of parsing that is not a number: text the style does not allow, or a number the type cannot hold. */
export type ParseFailure = 'format' | 'overflow';

/** How a numeric type's `Parse` and `TryParse` read a string. */
export interface NumberParser<T extends Value> {
  parse: (text: string, styles: number, culture: Culture) => T | ParseFailure;
  /** The style without a `NumberStyles` argument. */
  defaultStyles: number;
  checkStyles: (styles: number) => void;
  /** The type in .NET's OverflowException message, as `an Int32`. */
  overflowName: string;
  /** What `TryParse` stores when it fails. */
  zero: T;
}

/**
 * The natives of a numeric type's `Parse` and `TryParse` overloads, which take a string and optionally a
 * `NumberStyles`, an `IFormatProvider`, or both, recognized by their parameter names.
 */
export function parseNatives<T extends Value>(prefix: string, parser: NumberParser<T>): Record<string, NativeMethod> {
  return {
    [`${prefix}.Parse`]: (call, _receiver, args) => {
      const { text, styles, culture } = parseArguments(call, args as Value[], parser);
      if (text === undefined) failNull('s');
      const parsed = parser.parse(text, styles, culture);
      if (parsed === 'format')
        fail('System.FormatException', `The input string '${text}' was not in a correct format.`);
      if (parsed === 'overflow')
        fail('System.OverflowException', `Value was either too large or too small for ${parser.overflowName}.`);
      return parsed;
    },
    [`${prefix}.TryParse`]: (call, _receiver, args) => {
      const { text, styles, culture } = parseArguments(call, args as Value[], parser);
      const parsed = text === undefined ? 'format' : parser.parse(text, styles, culture);
      const succeeded = parsed !== 'format' && parsed !== 'overflow';
      refOf(args.at(-1) as Value).set(succeeded ? parsed : parser.zero);
      return succeeded;
    },
  };
}

function parseArguments<T extends Value>(
  call: NativeCall,
  args: Value[],
  parser: NumberParser<T>
): { text: string | undefined; styles: number; culture: Culture } {
  const argument = (name: string): Value =>
    args[call.method.parameters.findIndex((parameter) => parameter.name === name)];
  const hasStyles = call.method.parameters.some((parameter) => parameter.name === 'style');
  const styles = hasStyles ? (argument('style') as number) : parser.defaultStyles;
  if (hasStyles) parser.checkStyles(styles);
  return {
    text: argument('s') as string | undefined,
    styles,
    culture: providerCulture(call.frame.runtime, argument('provider')),
  };
}

/** Checks an integral type's `NumberStyles` argument as .NET does, throwing its ArgumentException. */
export function checkIntegerStyles(styles: number): void {
  checkDefinedStyles(styles);
  if ((styles & RADIX_STYLES) !== 0 && (styles & ~(WHITE_STYLES | RADIX_STYLES)) !== 0)
    fail(
      'System.ArgumentException',
      'With the AllowHexSpecifier or AllowBinarySpecifier bit set in the enum bit field, the only other valid bits that can be combined into the enum value must be AllowLeadingWhite and AllowTrailingWhite.',
      'style'
    );
}

/** Checks a floating-point or decimal type's `NumberStyles` argument as .NET does, throwing its ArgumentException. */
export function checkFloatStyles(styles: number): void {
  checkDefinedStyles(styles);
  if ((styles & RADIX_STYLES) !== 0)
    fail(
      'System.ArgumentException',
      'The number styles AllowHexSpecifier and AllowBinarySpecifier are not supported on floating point data types.',
      'style'
    );
}

function checkDefinedStyles(styles: number): void {
  if ((styles & ~ALL_STYLES) !== 0)
    fail('System.ArgumentException', 'An undefined NumberStyles value is being used.', 'style');
}

/** Parses an integer of a range in a number style, with the bits of a hexadecimal or binary number in its width. */
export function parseIntegerText(
  text: string,
  styles: number,
  culture: Culture,
  [min, max]: readonly [bigint, bigint]
): bigint | ParseFailure {
  if ((styles & RADIX_STYLES) !== 0) return parseRadixText(text, styles, [min, max]);
  const scanned = scanNumber(text, styles, culture);
  if (!scanned) return 'format';
  const written = `${scanned.integer}${scanned.fraction}`;
  const digits = written.replace(/^0+/, '');
  const point = scanned.integer.length + scanned.exponent - (written.length - digits.length);
  return integerOfDigits(digits, point, scanned.isNegative, [min, max]);
}

/** The integer `0.digits × 10^point` with a sign, which must be whole and in range. */
function integerOfDigits(
  digits: string,
  point: number,
  isNegative: boolean,
  [min, max]: readonly [bigint, bigint]
): bigint | ParseFailure {
  if (digits === '') return 0n;
  // .NET reports a fraction that is not zero as an overflow, as it does a number past the type's range.
  if (/[1-9]/.test(digits.slice(Math.max(point, 0))) || point > 40) return 'overflow';
  const magnitude = BigInt(digits.slice(0, Math.max(point, 0)).padEnd(Math.max(point, 0), '0') || '0');
  const value = isNegative ? -magnitude : magnitude;
  return value < min || value > max ? 'overflow' : value;
}

function parseRadixText(text: string, styles: number, [min, max]: readonly [bigint, bigint]): bigint | ParseFailure {
  const isHex = (styles & NumberStyles.AllowHexSpecifier) !== 0;
  const digits = radixDigits(text, styles);
  if (!(isHex ? /^[\dA-Fa-f]+$/ : /^[01]+$/).test(digits)) return 'format';
  const bits = BigInt(`0${isHex ? 'x' : 'b'}${digits}`);
  const width = (max - min + 1n).toString(2).length - 1;
  if (bits >= 1n << BigInt(width)) return 'overflow';
  return min < 0n ? BigInt.asIntN(width, bits) : bits;
}

/**
 * Parses an integer of any size in a number style, as BigInteger does: a fraction must be zero, and a hexadecimal or
 * binary number is two's complement, negative when its first digit has the top bit set.
 */
export function parseBigIntegerText(text: string, styles: number, culture: Culture): bigint | undefined {
  if ((styles & RADIX_STYLES) !== 0) return parseTwosComplementText(text, styles);
  const scanned = scanNumber(text, styles, culture);
  if (!scanned) return undefined;
  const written = `${scanned.integer}${scanned.fraction}`;
  const point = scanned.integer.length + scanned.exponent;
  if (/[1-9]/.test(written.slice(Math.max(point, 0)))) return undefined;
  const whole = point <= 0 ? '0' : written.slice(0, point).padEnd(point, '0');
  const magnitude = BigInt(whole);
  return scanned.isNegative ? -magnitude : magnitude;
}

function parseTwosComplementText(text: string, styles: number): bigint | undefined {
  const isHex = (styles & NumberStyles.AllowHexSpecifier) !== 0;
  const digits = radixDigits(text, styles);
  if (!(isHex ? /^[\dA-Fa-f]+$/ : /^[01]+$/).test(digits)) return undefined;
  const bits = BigInt(`0${isHex ? 'x' : 'b'}${digits}`);
  const width = BigInt(digits.length * (isHex ? 4 : 1));
  return bits >> (width - 1n) === 1n ? bits - (1n << width) : bits;
}

/** The digits of a hexadecimal or binary number, without the white space that its style allows around them. */
function radixDigits(text: string, styles: number): string {
  let start = 0;
  let end = text.replace(/\0+$/, '').length;
  if ((styles & NumberStyles.AllowLeadingWhite) !== 0) while (start < end && isWhite(text[start])) start++;
  if ((styles & NumberStyles.AllowTrailingWhite) !== 0) while (end > start && isWhite(text[end - 1])) end--;
  return text.slice(start, end);
}

/** Parses a double in a number style, with the culture's symbols for infinity and NaN. */
export function parseFloatText(text: string, styles: number, culture: Culture): number | undefined {
  const scanned = scanNumber(text, styles, culture);
  if (scanned) {
    const { isNegative, integer, fraction, exponent } = scanned;
    return Number(`${isNegative ? '-' : ''}${integer || '0'}.${fraction || '0'}e${exponent}`);
  }
  return parseSymbol(trimNumberText(text).toLowerCase(), culture);
}

/** The value of the culture's infinity and NaN symbols, which .NET compares ignoring case, with a sign or not. */
function parseSymbol(text: string, culture: Culture): number | undefined {
  const positive = culture.positiveInfinity.toLowerCase();
  const nan = NUMBER_SYMBOLS.nan.toLowerCase();
  if (text === positive || text === `+${positive}`) return Number.POSITIVE_INFINITY;
  if (text === culture.negativeInfinity.toLowerCase()) return Number.NEGATIVE_INFINITY;
  if (text === nan || text === `+${nan}` || text === `-${nan}`) return Number.NaN;
  return undefined;
}

/** Parses a decimal in a number style, which keeps the digits written after the point. */
export function parseDecimalText(text: string, styles: number, culture: Culture): CsDecimal | ParseFailure {
  const scanned = scanNumber(text, styles, culture);
  if (!scanned) return 'format';
  const { isNegative, integer, fraction, exponent } = scanned;
  const parsed = CsDecimal.parse(`${isNegative ? '-' : ''}${integer}.${fraction}e${exponent}`);
  return parsed ?? 'overflow';
}

/**
 * Reads a number as .NET's `Number.TryParseNumber` does under a style: leading white space, sign, parenthesis, and
 * currency symbol; digits with a decimal point and group separators; an exponent; then the trailing ones. Anything left
 * over but NUL characters fails.
 */
function scanNumber(text: string, styles: number, culture: Culture): ScannedNumber | undefined {
  return new NumberScanner(text, styles, culture).scan();
}

/** The state of one `scanNumber`, which reads the parts of the number in order. */
class NumberScanner {
  private index = 0;
  /** The currency symbol, until it has been read once. */
  private currency: string | undefined;
  private hasSign = false;
  private hasCurrency = false;
  private inParentheses = false;
  private isNegative = false;

  constructor(
    private readonly text: string,
    private readonly styles: number,
    culture: Culture
  ) {
    this.currency = this.allows(NumberStyles.AllowCurrencySymbol) ? culture.currencySymbol : undefined;
  }

  scan(): ScannedNumber | undefined {
    this.scanLeading();
    const digits = this.scanDigits();
    if (!digits) return undefined;
    const exponent = this.scanExponent();
    this.scanTrailing();
    if (this.inParentheses || !/^\0*$/.test(this.text.slice(this.index))) return undefined;
    return { isNegative: this.isNegative, ...digits, exponent };
  }

  private allows(flag: number): boolean {
    return (this.styles & flag) !== 0;
  }

  private scanLeading(): void {
    for (; this.index < this.text.length; this.index++) {
      const char = this.text[this.index];
      // White space may not follow a sign, unless a currency symbol does: `-¤ 5` is a number but `- 5` is not.
      const mayBeWhite = !this.hasSign || this.hasCurrency;
      if (isWhite(char) && this.allows(NumberStyles.AllowLeadingWhite) && mayBeWhite) continue;
      if (this.readSign(char, NumberStyles.AllowLeadingSign)) continue;
      if (char === '(' && this.allows(NumberStyles.AllowParentheses) && !this.hasSign) {
        this.hasSign = true;
        this.inParentheses = true;
        this.isNegative = true;
      } else if (this.readCurrency()) {
        this.hasCurrency = true;
      } else break;
    }
  }

  private scanDigits(): { integer: string; fraction: string } | undefined {
    let integer = '';
    let fraction = '';
    let hasPoint = false;
    const allowsPoint = this.allows(NumberStyles.AllowDecimalPoint);
    const allowsGroups = this.allows(NumberStyles.AllowThousands);
    for (; this.index < this.text.length; this.index++) {
      const char = this.text[this.index];
      const isDigit = char >= '0' && char <= '9';
      if (isDigit && hasPoint) fraction += char;
      else if (isDigit) integer += char;
      else if (char === NUMBER_SYMBOLS.decimalSeparator && allowsPoint && !hasPoint) hasPoint = true;
      // A group separator may follow any digit before the decimal point, in groups of any size.
      else if (char !== NUMBER_SYMBOLS.groupSeparator || !allowsGroups || integer === '' || hasPoint) break;
    }
    return integer === '' && fraction === '' ? undefined : { integer, fraction };
  }

  private scanExponent(): number {
    if (!this.allows(NumberStyles.AllowExponent)) return 0;
    const match = /^[eE]([+-]?)(\d+)/.exec(this.text.slice(this.index));
    if (!match) return 0;
    this.index += match[0].length;
    // .NET stops counting an exponent past 1000, which already puts any number past every type's range.
    const magnitude = match[2].replace(/^0+/, '').length > 4 ? 9999 : Math.min(Number(match[2]), 9999);
    return match[1] === '-' ? -magnitude : magnitude;
  }

  private scanTrailing(): void {
    for (; this.index < this.text.length; this.index++) {
      const char = this.text[this.index];
      if (isWhite(char) && this.allows(NumberStyles.AllowTrailingWhite)) continue;
      if (this.readSign(char, NumberStyles.AllowTrailingSign)) continue;
      if (char === ')' && this.inParentheses) this.inParentheses = false;
      else if (!this.readCurrency()) break;
    }
  }

  /** Reads a sign at the index, which the style must allow there and which may come only once. */
  private readSign(char: string, flag: number): boolean {
    if (!this.allows(flag) || this.hasSign || (char !== '+' && char !== '-')) return false;
    this.hasSign = true;
    this.isNegative = char === '-';
    return true;
  }

  /** Reads the currency symbol at the index, leaving the index at its last character. */
  private readCurrency(): boolean {
    if (this.currency === undefined || !this.text.startsWith(this.currency, this.index)) return false;
    this.index += this.currency.length - 1;
    this.currency = undefined;
    return true;
  }
}

function isWhite(char: string): boolean {
  return char === ' ' || (char >= '\t' && char <= '\r');
}

/** A number's text without the white space that .NET's number parsing skips, with trailing NUL characters too. */
export function trimNumberText(text: string): string {
  // Scanning from both ends keeps a long run of spaces linear, which an unanchored regex retries at every position.
  let start = 0;
  let end = text.length;
  while (start < end && isWhite(text[start])) start++;
  while (end > start && (isWhite(text[end - 1]) || text[end - 1] === '\0')) end--;
  return text.slice(start, end);
}
