// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { callStack } from './calls';
import { floatFitsInt, formatFloatRepr, numericPrefix } from './conversions';
import { fatal, notice, throwError, warn } from './errors';
import { toFloat, toInt, withStringConversionErrors } from './operators';
import { rt } from './runtime';
import { exponentialText, fixedDigits, generalText } from './strings';
import { deref, PhpArray, type Ref, type Value } from './values';

const MAX_FLOAT_PRECISION = 53;
const INT_LIMIT = 2_147_483_647;
const NEXT_ARG = -1;
const FLOAT_SPECIFIERS = new Set('eEfFgGhH');
const RADIXES: Record<string, number | undefined> = { o: 8, x: 16, X: 16, b: 2 };

interface Parser {
  format: string;
  index: number;
  args: readonly (Value | Ref)[];
  currentArg: number;
  maxMissingArg: number;
}

interface Spec {
  argIndex: number;
  alignLeft: boolean;
  padding: string;
  alwaysSign: boolean;
  width: number;
  precision: number;
  /** Whether the format gave a precision, even an empty one, which the float conversions use instead of 6. */
  hasPrecision: boolean;
  /** Whether the format gave precision digits, which cut strings and integer conversions. */
  cutsText: boolean;
}

/**
 * Formats like PHP's `php_formatted_print`, whose `%e` writes the shortest exponent and whose `%f` rounds half to even.
 * A conversion whose argument is missing is skipped, and the error naming the largest missing argument is thrown at the
 * end, after the errors of the later conversions.
 */
export function formatPrintf(
  format: string,
  args: readonly Value[] | PhpArray,
  write?: (text: string) => void
): string {
  let result = '';
  const fromArray = args instanceof PhpArray;
  const slots = fromArray ? [...args.map.values()] : args;
  withStringConversionErrors((stringArg) => {
    result = formatValues(format, slots, fromArray, stringArg);
    write?.(result);
  });
  return result;
}

function formatValues(
  format: string,
  args: readonly (Value | Ref)[],
  fromArray: boolean,
  stringArg: (value: Value) => string
): string {
  const name = callStack.at(-1)?.name ?? 'sprintf';
  const parser: Parser = { format, index: 0, args, currentArg: 0, maxMissingArg: -1 };
  let result = '';
  while (parser.index < format.length) {
    const percent = format.indexOf('%', parser.index);
    if (percent === -1) {
      result += format.slice(parser.index);
      break;
    }
    result += format.slice(parser.index, percent);
    parser.index = percent + 1;
    if (format[parser.index] === '%') {
      result += '%';
      parser.index++;
      continue;
    }
    const spec = parseSpec(parser);
    if (!spec) continue;
    result += convert(spec, format[parser.index], deref(args[spec.argIndex]), result.length, name, stringArg);
    parser.index++;
  }
  if (parser.maxMissingArg >= 0) {
    if (fromArray)
      throwError(
        'ValueError',
        `The arguments array must contain ${parser.maxMissingArg + 1} items, ${args.length} given`
      );
    const extra = name === 'fprintf' ? 2 : 1;
    throwError(
      'ArgumentCountError',
      `${parser.maxMissingArg + extra + 1} arguments are required, ${args.length + extra} given`
    );
  }
  return result;
}

/** Reads a conversion up to its specifier, or returns undefined when an argument it needs is missing. */
function parseSpec(parser: Parser): Spec | undefined {
  const spec: Spec = {
    argIndex: NEXT_ARG,
    alignLeft: false,
    padding: ' ',
    alwaysSign: false,
    width: 0,
    precision: 0,
    hasPrecision: false,
    cutsText: false,
  };
  if (!/[A-Za-z]/.test(parser.format[parser.index] ?? '')) {
    spec.argIndex = readArgIndex(parser);
    readModifiers(parser, spec);
    if (!readWidth(parser, spec) || !readPrecision(parser, spec)) return undefined;
  }
  if (parser.format[parser.index] === 'l') parser.index++;
  if (spec.argIndex === NEXT_ARG) spec.argIndex = parser.currentArg++;
  if (!hasArg(parser, spec.argIndex)) return undefined;
  if (spec.cutsText && spec.precision === -1 && !/[gGhH]/.test(parser.format[parser.index] ?? ''))
    throwError('ValueError', 'Precision -1 is only supported for %g, %G, %h and %H');
  return spec;
}

/** Reads an `n$` argument number, or returns NEXT_ARG when there is none. */
function readArgIndex(parser: Parser): number {
  let lookahead = parser.index;
  while (/\d/.test(parser.format[lookahead] ?? '')) lookahead++;
  if (parser.format[lookahead] !== '$') return NEXT_ARG;
  const number = readNumber(parser);
  if (number <= 0)
    throwError('ValueError', `Argument number specifier must be greater than zero and less than ${INT_LIMIT}`);
  parser.index++;
  return number - 1;
}

/** Reads a decimal number as `php_sprintf_getnumber` does, returning -1 for one out of the int range. */
function readNumber(parser: Parser): number {
  let digits = '';
  while (/\d/.test(parser.format[parser.index] ?? '')) digits += parser.format[parser.index++];
  const value = Number(digits);
  return value >= INT_LIMIT ? -1 : value;
}

function readModifiers(parser: Parser, spec: Spec): void {
  for (; ; parser.index++) {
    const modifier = parser.format[parser.index];
    if (modifier === ' ' || modifier === '0') spec.padding = modifier;
    else if (modifier === '-') spec.alignLeft = true;
    else if (modifier === '+') spec.alwaysSign = true;
    else if (modifier === "'") {
      if (parser.index + 1 >= parser.format.length) throwError('ValueError', 'Missing padding character');
      spec.padding = parser.format[++parser.index];
    } else return;
  }
}

function readWidth(parser: Parser, spec: Spec): boolean {
  if (parser.format[parser.index] === '*') {
    parser.index++;
    const width = readStarArg(parser, 'Width', 0);
    if (width === undefined) return false;
    spec.width = width;
  } else if (/\d/.test(parser.format[parser.index] ?? '')) {
    spec.width = readNumber(parser);
    if (spec.width < 0) throwError('ValueError', `Width must be between 0 and ${INT_LIMIT}`);
  }
  return true;
}

function readPrecision(parser: Parser, spec: Spec): boolean {
  if (parser.format[parser.index] !== '.') return true;
  parser.index++;
  spec.hasPrecision = true;
  if (parser.format[parser.index] === '*') {
    parser.index++;
    const precision = readStarArg(parser, 'Precision', -1);
    if (precision === undefined) return false;
    spec.precision = precision;
    spec.cutsText = true;
  } else if (/\d/.test(parser.format[parser.index] ?? '')) {
    spec.precision = readNumber(parser);
    if (spec.precision < 0) throwError('ValueError', `Precision must be between 0 and ${INT_LIMIT}`);
    spec.cutsText = true;
  }
  return true;
}

/** Reads the argument a `*` width or precision takes, or returns undefined when it is missing. */
function readStarArg(parser: Parser, what: 'Width' | 'Precision', min: number): number | undefined {
  let argIndex = readArgIndex(parser);
  if (argIndex === NEXT_ARG) argIndex = parser.currentArg++;
  if (!hasArg(parser, argIndex)) return undefined;
  const value = deref(parser.args[argIndex]);
  if (typeof value !== 'bigint') throwError('ValueError', `${what} must be an integer`);
  if (value < BigInt(min) || value > BigInt(INT_LIMIT))
    throwError('ValueError', `${what} must be between ${min} and ${INT_LIMIT}`);
  return Number(value);
}

function hasArg(parser: Parser, argIndex: number): boolean {
  if (argIndex < parser.args.length) return true;
  parser.maxMissingArg = Math.max(parser.maxMissingArg, argIndex);
  return false;
}

function convert(
  spec: Spec,
  specifier: string | undefined,
  arg: Value,
  position: number,
  name: string,
  stringArg: (value: Value) => string
): string {
  switch (specifier) {
    case 's': {
      return fitField(stringArg(arg), spec, position, { maxLength: spec.cutsText ? spec.precision : undefined });
    }
    case 'd': {
      const value = intArg(arg);
      const text = value < 0n ? `${value}` : spec.alwaysSign ? `+${value}` : `${value}`;
      return fitField(text, integerSpec(spec), position, { negative: value < 0n, alwaysSign: spec.alwaysSign });
    }
    case 'u': {
      return fitField(BigInt.asUintN(64, intArg(arg)).toString(), integerSpec(spec), position);
    }
    case 'c': {
      return String.fromCharCode(Number(BigInt.asUintN(8, intArg(arg))));
    }
    case '%': {
      return '%';
    }
    case undefined: {
      return throwError('ValueError', 'Missing format specifier at end of string');
    }
  }
  if (FLOAT_SPECIFIERS.has(specifier)) return formatFloatSpec(toFloat(arg), specifier, spec, position, name);
  const radix = RADIXES[specifier];
  if (radix === undefined) throwError('ValueError', `Unknown format specifier "${specifier}"`);
  const text = BigInt.asUintN(64, intArg(arg)).toString(radix);
  // PHP cuts these to no digits at all when the format gives precision digits.
  return fitField(specifier === 'X' ? text.toUpperCase() : text, spec, position, {
    maxLength: spec.cutsText ? 0 : undefined,
  });
}

/** The spec an integer conversion pads with, which never pads zeros on the right. */
function integerSpec(spec: Spec): Spec {
  return spec.alignLeft && spec.padding === '0' ? { ...spec, padding: ' ' } : spec;
}

/** Converts an argument to an int as `zval_get_long` does, which warns about a float out of the int range. */
function intArg(value: Value): bigint {
  if (typeof value === 'number') {
    if (floatFitsInt(value)) return BigInt(Math.trunc(value));
    warn(`The float ${formatFloatRepr(value)} is not representable as an int, cast occurred`);
    return Number.isFinite(value) ? BigInt.asIntN(64, BigInt(Math.trunc(value))) : 0n;
  }
  if (typeof value === 'string') {
    const number = numericPrefix(value)?.value;
    if (typeof number === 'number' && !floatFitsInt(number))
      return number > 0 ? 9_223_372_036_854_775_807n : -9_223_372_036_854_775_808n;
  }
  return toInt(value);
}

interface FieldOptions {
  /** The bytes of the text to keep at most. */
  maxLength?: number;
  negative?: boolean;
  alwaysSign?: boolean;
}

/**
 * Pads a converted value as `php_sprintf_appendstring` does. With zero padding, a sign replaces the first byte of the
 * text and the padding follows it, whatever that byte is.
 */
function fitField(text: string, spec: Spec, position: number, options: FieldOptions = {}): string {
  const { maxLength, negative = false, alwaysSign = false } = options;
  let length = Math.min(maxLength ?? text.length, text.length);
  const count = Math.max(spec.width - length, 0);
  const fieldWidth = Math.max(spec.width, length);
  if (fieldWidth > INT_LIMIT - position - 1) fatal(`Field width ${fieldWidth} is too long`);
  rt().ensureStringFits(position + fieldWidth);
  if (spec.alignLeft) return text.slice(0, length) + spec.padding.repeat(count);
  let body = text;
  let sign = '';
  if ((negative || alwaysSign) && spec.padding === '0') {
    sign = negative ? '-' : '+';
    body = body.slice(1);
    length--;
  }
  return sign + spec.padding.repeat(count) + body.slice(0, Math.max(length, 0));
}

/** Formats a float as `php_sprintf_appenddouble` does, which ignores the width of INF and NaN. */
function formatFloatSpec(value: number, specifier: string, spec: Spec, position: number, name: string): string {
  const precision = floatPrecision(spec, name);
  const { alwaysSign } = spec;
  if (!Number.isFinite(value)) {
    const text = Number.isNaN(value) ? 'NaN' : value < 0 ? '-INF' : 'INF';
    return fitField(text, { ...spec, width: text.length }, position, { negative: value < 0, alwaysSign });
  }
  const general = /[gGhH]/.test(specifier);
  const negative = value < 0 || (general && Object.is(value, -0));
  const body = floatDigits(Math.abs(value), specifier, precision);
  const text = negative ? `-${body}` : alwaysSign ? `+${body}` : body;
  return fitField(text, spec, position, { negative, alwaysSign });
}

function floatPrecision(spec: Spec, name: string): number {
  if (!spec.hasPrecision) return 6;
  if (spec.precision <= MAX_FLOAT_PRECISION) return spec.precision;
  notice(
    `${name}(): Requested precision of ${spec.precision} digits was truncated to PHP maximum of ${MAX_FLOAT_PRECISION} digits`
  );
  return MAX_FLOAT_PRECISION;
}

function floatDigits(value: number, specifier: string, precision: number): string {
  if (specifier === 'e' || specifier === 'E') return exponentialText(value, precision, specifier === 'E');
  if (specifier === 'f' || specifier === 'F') return fixedDigits(value, precision);
  return generalBody(value, precision, specifier === 'G' || specifier === 'H');
}

/** Formats `%g` digits, where precision -1 asks `zend_gcvt` for the shortest digits that read back. */
function generalBody(value: number, precision: number, upper: boolean): string {
  if (precision === -1) return formatFloatRepr(value, upper ? 'E' : 'e');
  return generalText(value, precision === 0 ? 1 : precision, upper);
}
