import { javaHash } from './builtinCollections';
import { stringify } from './builtins';
import { type Frame, throwBuiltin } from './runtime';
import { floatToShortestDouble, JavaObject, type Value } from './values';

const SPECIFIER = /%(\d+\$)?([-#+ 0,(]*)(\d+)?(\.\d+)?([a-zA-Z%])/g;

/** Formats as `String.format` does for the conversions learners use: d, s, f, e, g, x, o, c, b, h, n, and %. */
export function formatText(frame: Frame, pattern: string, args: Value[]): string {
  let nextArg = 0;
  frame.runtime.scanString(pattern.length);
  const result = pattern.replaceAll(
    SPECIFIER,
    (
      specifier,
      index: string | undefined,
      flags: string,
      width: string | undefined,
      precision: string | undefined,
      conversion: string
    ) => {
      if (conversion === 'n') return '\n';
      if (conversion === '%') return pad('%', flags, width);
      const position = index ? Number(index.slice(0, -1)) - 1 : nextArg++;
      if (position >= args.length)
        throwBuiltin(frame, 'MissingFormatArgumentException', `Format specifier '${specifier}'`);
      const formatted = formatArgument(
        frame,
        args[position],
        flags,
        precision ? Number(precision.slice(1)) : undefined,
        conversion
      );
      return pad(formatted, flags, width);
    }
  );
  // A lone % that starts no specifier is an error in Java.
  if (pattern.replaceAll(SPECIFIER, '').includes('%')) {
    throwBuiltin(frame, 'UnknownFormatConversionException', "Conversion = '%'");
  }
  return result;
}

function pad(text: string, flags: string, width: string | undefined): string {
  if (!width) return text;
  const size = Number(width);
  if (flags.includes('-')) return text.padEnd(size);
  if (flags.includes('0') && /^[+-]?\d/.test(text)) {
    const sign = /^[+-]/.test(text) ? text[0] : '';
    return sign + text.slice(sign.length).padStart(size - sign.length, '0');
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

function formatArgument(
  frame: Frame,
  arg: Value,
  flags: string,
  precision: number | undefined,
  conversion: string
): string {
  const lower = conversion.toLowerCase();
  if (flags.includes('#') && REJECTS_ALTERNATE_FORM.has(lower)) {
    throwBuiltin(frame, 'FormatFlagsConversionMismatchException', `Conversion = ${lower}, Flags = #`);
  }
  const formatted = formatLower(frame, arg, flags, precision, lower, conversion);
  return conversion === lower ? formatted : formatted.toUpperCase();
}

// code-gauge-allow functionCognitiveComplexity 19 -- One branch per conversion of Java's Formatter, before the numeric ones.
function formatLower(
  frame: Frame,
  arg: Value,
  flags: string,
  precision: number | undefined,
  lower: string,
  conversion: string
): string {
  if (lower === 's') {
    const text = arg === undefined ? 'null' : stringify(frame, arg, { kind: 'null' });
    return precision === undefined ? text : text.slice(0, precision);
  }
  if (lower === 'b')
    return String(arg instanceof JavaObject && typeof arg.boxed === 'boolean' ? arg.boxed : arg !== undefined);
  if (lower === 'h') return arg === undefined ? 'null' : (javaHash(frame, arg) >>> 0).toString(16);
  const accepted = ACCEPTED_KINDS[lower] as readonly string[] | undefined;
  if (!accepted) return throwBuiltin(frame, 'UnknownFormatConversionException', `Conversion = '${conversion}'`);
  if (arg === undefined) return 'null';
  const kind = arg instanceof JavaObject ? arg.cls.unboxedType?.kind : undefined;
  if (!kind || !accepted.includes(kind)) {
    const typeName =
      arg instanceof JavaObject
        ? (frame.runtime.builtins.qualifiedNames.get(arg.cls) ?? arg.cls.name)
        : 'java.lang.String';
    return throwBuiltin(frame, 'IllegalFormatConversionException', `${conversion} != ${typeName}`);
  }
  return formatNumber((arg as JavaObject).boxed as number | bigint, kind, flags, precision, lower);
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
      const value = kind === 'float' ? floatToShortestDouble(boxed as number) : (boxed as number);
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
// code-gauge-allow functionCognitiveComplexity 18 -- Java's Formatter rounds half up from the shortest digits, which takes these cases.
// code-gauge-allow functionNcss 32 -- Java's Formatter rounds half up from the shortest digits, which takes these cases.
function formatDecimal(value: number, precision: number, conversion: string, flags: string): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return withSign('Infinity', value < 0, flags);
  const isNegative = value < 0 || Object.is(value, -0);
  const [mantissa, exponentText] = Math.abs(value).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const exponent = Number(exponentText);
  if (conversion === 'e') {
    const { digits: rounded, carried } = roundDigits(digits, precision + 1);
    const finalExponent = exponent + carried;
    // A carry into a new leading digit leaves one digit more than the precision keeps.
    const fraction = rounded.slice(1, precision + 1).padEnd(precision, '0');
    const body = `${rounded[0]}${precision > 0 ? `.${fraction}` : ''}e${finalExponent < 0 ? '-' : '+'}${String(Math.abs(finalExponent)).padStart(2, '0')}`;
    return withSign(body, isNegative, flags);
  }
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
  return withSign(precision > 0 ? `${integerText}.${fractionPart}` : integerText, isNegative, flags);
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
