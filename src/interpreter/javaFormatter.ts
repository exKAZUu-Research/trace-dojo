/** What the formatter needs to know about a language's values, and how it raises the formatter's exceptions. */
export interface FormatValues<V> {
  isNull(value: V): boolean;
  stringify(value: V): string;
  hash(value: V): number;
  /** The value `%b` prints: the boolean itself, or whether the value is non-null. */
  booleanOf(value: V): boolean;
  /** The primitive a boxed number or character holds, by its Java kind (`int`, `double`, `char`, ...). */
  numberOf(value: V): { kind: string; value: number | bigint } | undefined;
  /** The Java class name an `IllegalFormatConversionException` names. */
  typeName(value: V): string;
  /** Throws the `java.util` exception with the simple name. */
  fail(name: string, message: string): never;
  /** Charges for scanning a pattern of the length. */
  scan(length: number): void;
}

interface Specifier {
  start: number;
  end: number;
  source: string;
  index: string | undefined;
  flags: string;
  width: string | undefined;
  precision: string | undefined;
  conversion: string;
}

/** Formats as `String.format` does for the conversions learners use. */
// code-gauge-allow functionCognitiveComplexity 18 -- argument position and conversion rules share one left-to-right traversal.
export function formatJava<V>(pattern: string, args: V[], values: FormatValues<V>): string {
  const { specifiers, malformed } = scanPattern(values, pattern);
  const result: string[] = [];
  let end = 0;
  let nextArg = 0;
  let previous: number | undefined;
  for (const specifier of specifiers) {
    result.push(pattern.slice(end, specifier.start));
    end = specifier.end;
    const { index, flags, width, precision, conversion, source } = specifier;
    if (conversion === 'n' || conversion === '%') {
      result.push(conversion === 'n' ? '\n' : pad('%', flags, width));
      continue;
    }
    const position = index === '<' ? previous : index ? Number(index) - 1 : nextArg++;
    if (position === undefined || position >= args.length) {
      return values.fail('MissingFormatArgumentException', `Format specifier '${source}'`);
    }
    previous = position;
    const formatted = formatArgument(
      values,
      args[position] as V,
      flags,
      precision ? Number(precision) : undefined,
      conversion
    );
    result.push(pad(formatted, flags, width));
  }
  if (malformed) values.fail('UnknownFormatConversionException', "Conversion = '%'");
  result.push(pattern.slice(end));
  return result.join('');
}

function scanPattern<V>(values: FormatValues<V>, pattern: string): { specifiers: Specifier[]; malformed: boolean } {
  values.scan(pattern.length);
  const specifiers: Specifier[] = [];
  let malformed = false;
  for (let start = pattern.indexOf('%'); start >= 0; start = pattern.indexOf('%', start + 1)) {
    const specifier = readSpecifier(pattern, start);
    if (!specifier) {
      malformed = true;
      continue;
    }
    checkSpecifier(values, specifier);
    specifiers.push(specifier);
    start = specifier.end - 1;
  }
  return { specifiers, malformed };
}

function readSpecifier(pattern: string, start: number): Specifier | undefined {
  let cursor = start + 1;
  const afterIndex = skipDigits(pattern, cursor);
  let index: string | undefined;
  if (pattern[cursor] === '<') {
    index = '<';
    cursor++;
  } else if (afterIndex > cursor && pattern[afterIndex] === '$') {
    index = pattern.slice(cursor, afterIndex);
    cursor = afterIndex + 1;
  }
  const flagStart = cursor;
  while (cursor < pattern.length && '-#+ 0,('.includes(pattern[cursor])) cursor++;
  const flags = pattern.slice(flagStart, cursor);
  const afterWidth = skipDigits(pattern, cursor);
  const width = pattern.slice(cursor, afterWidth) || undefined;
  cursor = afterWidth;
  let precision: string | undefined;
  if (pattern[cursor] === '.') {
    const precisionStart = cursor + 1;
    cursor = skipDigits(pattern, precisionStart);
    if (cursor === precisionStart) return undefined;
    precision = pattern.slice(precisionStart, cursor);
  }
  const conversion = pattern[cursor] ?? '';
  if (!/^[a-zA-Z%]$/.test(conversion)) return undefined;
  const end = cursor + 1;
  return { start, end, source: pattern.slice(start, end), index, flags, width, precision, conversion };
}

function skipDigits(pattern: string, start: number): number {
  let end = start;
  while (pattern[end] >= '0' && pattern[end] <= '9') end++;
  return end;
}

function checkSpecifier<V>(values: FormatValues<V>, { source, flags, width, precision, conversion }: Specifier): void {
  const lower = conversion.toLowerCase();
  if (lower === 'n') return;
  // A width or precision makes text of its length, which is charged before anything is built.
  values.scan(Number(width ?? 0) + Number(precision ?? 0));
  if (precision && 'dxoc'.includes(lower)) {
    values.fail('IllegalFormatPrecisionException', precision);
  }
  const isNumeric = 'dxoefg'.includes(lower);
  if (!width && (flags.includes('-') || (isNumeric && flags.includes('0')))) {
    values.fail('MissingFormatWidthException', source);
  }
  const bad = BAD_FLAGS[lower]?.find((flag) => flags.includes(flag));
  if (bad) values.fail('FormatFlagsConversionMismatchException', `Conversion = ${lower}, Flags = ${bad}`);
}

const GENERAL_BAD_FLAGS = ['+', ' ', '0', ',', '('];
// The first prohibited flag in this order is the one named by the JVM exception.
const BAD_FLAGS: Record<string, string[]> = {
  s: GENERAL_BAD_FLAGS,
  b: GENERAL_BAD_FLAGS,
  h: GENERAL_BAD_FLAGS,
  c: GENERAL_BAD_FLAGS,
  o: [','],
  x: [','],
  e: [','],
  g: ['#'],
};

/** The flags that octal and hexadecimal reject for the argument types this formatter takes, which are not BigInteger. */
const SIGN_FLAGS = ['(', ' ', '+'];

function pad(text: string, flags: string, width: string | undefined): string {
  if (!width) return text;
  const size = Number(width);
  if (flags.includes('-')) return text.padEnd(size);
  // Zeros go between the sign, parenthesis, or radix prefix and the digits, before a closing parenthesis.
  const parts = /^([+ (-]?(?:0[xX])?)([\da-fA-F.,eE+-]+)(\)?)$/.exec(text);
  if (flags.includes('0') && parts) {
    const [, prefix = '', digits = '', suffix = ''] = parts;
    return prefix + digits.padStart(size - prefix.length - suffix.length, '0') + suffix;
  }
  return text.padStart(size);
}

/** The kinds of boxed values that each numeric or character conversion accepts. */
const ACCEPTED_KINDS: Record<string, readonly string[]> = {
  c: ['char', 'int', 'byte', 'short'],
  d: ['int', 'long', 'short', 'byte'],
  x: ['int', 'long', 'short', 'byte'],
  o: ['int', 'long', 'short', 'byte'],
  f: ['double', 'float'],
  e: ['double', 'float'],
  g: ['double', 'float'],
};

/** The conversions that reject the `#` flag, which only the radix and decimal conversions take. */
const REJECTS_ALTERNATE_FORM = new Set(['s', 'b', 'h', 'c', 'd']);

const INTEGER_BITS: Record<string, number> = { byte: 8, short: 16, int: 32, long: 64 };

function formatArgument<V>(
  values: FormatValues<V>,
  arg: V,
  flags: string,
  precision: number | undefined,
  conversion: string
): string {
  const lower = conversion.toLowerCase();
  if (flags.includes('#') && REJECTS_ALTERNATE_FORM.has(lower)) {
    values.fail('FormatFlagsConversionMismatchException', `Conversion = ${lower}, Flags = #`);
  }
  const formatted = formatLower(values, arg, flags, precision, lower, conversion);
  return conversion === lower ? formatted : formatted.toUpperCase();
}

function formatLower<V>(
  values: FormatValues<V>,
  arg: V,
  flags: string,
  precision: number | undefined,
  lower: string,
  conversion: string
): string {
  // The general conversions keep only as many characters as the precision says.
  const general = (text: string): string => (precision === undefined ? text : text.slice(0, precision));
  if (lower === 's') return general(values.isNull(arg) ? 'null' : values.stringify(arg));
  if (lower === 'b') return general(String(values.booleanOf(arg)));
  if (lower === 'h') return general(values.isNull(arg) ? 'null' : (values.hash(arg) >>> 0).toString(16));
  const accepted = ACCEPTED_KINDS[lower] as readonly string[] | undefined;
  if (!accepted) return values.fail('UnknownFormatConversionException', `Conversion = '${conversion}'`);
  if (values.isNull(arg)) return 'null';
  const number = values.numberOf(arg);
  if (!number || !accepted.includes(number.kind)) {
    return values.fail('IllegalFormatConversionException', `${conversion} != ${values.typeName(arg)}`);
  }
  const { kind, value: boxed } = number;
  if (lower === 'c') checkCodePoint(values, boxed as number);
  checkSignFlags(values, flags, lower);
  return formatNumber(boxed, kind, flags, precision, lower);
}

/** Rejects the flags of a sign for octal and hexadecimal, which only a BigInteger takes. */
function checkSignFlags<V>(values: FormatValues<V>, flags: string, conversion: string): void {
  if (conversion !== 'o' && conversion !== 'x') return;
  const sign = SIGN_FLAGS.find((flag) => flags.includes(flag));
  if (sign) values.fail('FormatFlagsConversionMismatchException', `Conversion = ${conversion}, Flags = ${sign}`);
}

/** Rejects a `%c` argument that is no Unicode code point, as `IllegalFormatCodePointException`. */
function checkCodePoint<V>(values: FormatValues<V>, point: number): void {
  if (point >= 0 && point <= 0x10_ff_ff) return;
  values.fail('IllegalFormatCodePointException', `Code point = 0x${(point >>> 0).toString(16)}`);
}

/** Formats a boxed number or character that a numeric or character conversion accepted. */
function formatNumber(
  boxed: number | bigint,
  kind: string,
  flags: string,
  precision: number | undefined,
  lower: string
): string {
  switch (lower) {
    case 'c': {
      return String.fromCodePoint(boxed as number);
    }
    case 'd': {
      return formatInteger(BigInt(boxed), flags);
    }
    case 'x':
    case 'o': {
      const digits = BigInt.asUintN(INTEGER_BITS[kind], BigInt(boxed)).toString(lower === 'x' ? 16 : 8);
      return flags.includes('#') ? `${lower === 'x' ? '0x' : '0'}${digits}` : digits;
    }
    default: {
      // A float formats as the double it widens to, as Formatter's print(float) does.
      const value = boxed as number;
      return lower === 'g'
        ? formatGeneral(value, precision ?? 6, flags)
        : formatDecimal(value, precision ?? 6, lower, flags);
    }
  }
}

function withSign(digits: string, isNegative: boolean, flags: string): string {
  if (isNegative) return flags.includes('(') ? `(${digits})` : `-${digits}`;
  if (flags.includes('+')) return `+${digits}`;
  if (flags.includes(' ')) return ` ${digits}`;
  return digits;
}

function group(digits: string): string {
  return digits.replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatInteger(value: bigint, flags: string): string {
  const magnitude = (value < 0n ? -value : value).toString();
  return withSign(flags.includes(',') ? group(magnitude) : magnitude, value < 0n, flags);
}

/**
 * Formats a double with `%f` or `%e`, rounding half up from the shortest decimal digits that `Double.toString` gives,
 * as Java's Formatter does.
 */
function formatDecimal(value: number, precision: number, conversion: string, flags: string): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return withSign('Infinity', value < 0, flags);
  const isNegative = value < 0 || Object.is(value, -0);
  const [mantissa, exponentText] = javaDigits(Math.abs(value)).split('e');
  const digits = mantissa.replace('.', '');
  const exponent = Number(exponentText);
  if (conversion === 'e') return withSign(scientificDigits(digits, exponent, precision, flags), isNegative, flags);
  // Digits before the point number exponent + 1, which may be zero or negative for small values.
  const integerDigits = exponent + 1;
  const kept = integerDigits + precision;
  let integerPart: string;
  let fractionPart: string;
  if (kept < 0) {
    integerPart = '0';
    fractionPart = '0'.repeat(precision);
  } else {
    const padded = integerDigits <= 0 ? '0'.repeat(1 - integerDigits) + digits : digits;
    const shift = integerDigits <= 0 ? 1 : integerDigits;
    const { digits: rounded, carried } = roundDigits(padded, shift + precision);
    const all = rounded.padEnd(shift + precision, '0');
    const totalInteger = shift + carried;
    integerPart = all.slice(0, totalInteger).replace(/^0+(?=\d)/, '') || '0';
    fractionPart = all.slice(totalInteger, totalInteger + precision);
  }
  const integerText = flags.includes(',') ? group(integerPart) : integerPart;
  // The sign is the value's, even when it rounds to zero, as `-0.00` shows.
  const hasPoint = precision > 0 || flags.includes('#');
  return withSign(hasPoint ? `${integerText}.${fractionPart}` : integerText, isNegative, flags);
}

/**
 * The digits Java's Formatter starts from: the shortest that read back as the value, but at least two, the closest
 * two-digit decimal, as Java's FloatingDecimal gives `4.9E-324` for Double.MIN_VALUE where the shortest is `5e-324`.
 */
function javaDigits(magnitude: number): string {
  const shortest = magnitude.toExponential();
  return shortest.includes('.') ? shortest : magnitude.toExponential(1);
}

/** The digits of `%e`, rounded half up to `precision`, with the point that `#` keeps even with no digits after it. */
function scientificDigits(digits: string, exponent: number, precision: number, flags: string): string {
  const { digits: rounded, carried } = roundDigits(digits, precision + 1);
  const finalExponent = exponent + carried;
  // A carry into a new leading digit leaves one digit more than the precision keeps.
  const fraction = rounded.slice(1, precision + 1).padEnd(precision, '0');
  const point = precision > 0 || flags.includes('#') ? `.${fraction}` : '';
  return `${rounded[0]}${point}e${finalExponent < 0 ? '-' : '+'}${String(Math.abs(finalExponent)).padStart(2, '0')}`;
}

/**
 * Formats a double with `%g`: rounded to `precision` significant digits, in fixed notation when the rounded value is
 * from 10^-4 up to 10^precision, and in `%e` notation otherwise, as Java's Formatter does.
 */
function formatGeneral(value: number, precision: number, flags: string): string {
  const significant = Math.max(precision, 1);
  if (!Number.isFinite(value) || value === 0) return formatDecimal(value, significant - 1, 'f', flags);
  const scientific = formatDecimal(value, significant - 1, 'e', '');
  const exponent = Number(scientific.slice(scientific.indexOf('e') + 1));
  return exponent >= -4 && exponent < significant
    ? formatDecimal(value, significant - 1 - exponent, 'f', flags)
    : formatDecimal(value, significant - 1, 'e', flags);
}

/** Rounds a digit string half up to `count` digits, telling whether rounding added a leading digit. */
function roundDigits(digits: string, count: number): { digits: string; carried: number } {
  if (digits.length <= count) return { digits, carried: 0 };
  const kept = digits.slice(0, count).split('').map(Number);
  if (Number(digits[count]) >= 5) {
    let index = kept.length - 1;
    while (index >= 0 && kept[index] === 9) kept[index--] = 0;
    if (index < 0) return { digits: `1${kept.join('')}`, carried: 1 };
    kept[index]++;
  }
  return { digits: kept.join(''), carried: 0 };
}
