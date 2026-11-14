import { pyAscii, pyFormat, pyRepr, pyStr } from './conversions';
import { truncateStr } from './formatSpec';
import { toIndex } from './numbers';
import { callValue, getItem, lookupSpecial } from './objects';
import { currentRuntime } from './runtimeContext';
import { repeatText } from './stringBuilder';
import { iterStr, strLength } from './strings';
import {
  exceptionClassNamed,
  floatClass,
  intClass,
  None,
  pyError,
  typeError,
  typeName,
  unbox,
  valueError,
} from './types';
import { PyComplex, PyError, PyInstance, PyTuple, type PyValue } from './values';

const MAX_SSIZE = (1n << 63n) - 1n;
const MAX_INT = (1n << 31n) - 1n;

/** The `%` operator on a string. */
export function formatPercent(template: string, argument: PyValue): string {
  const isMapping =
    !(argument instanceof PyTuple) &&
    typeof unbox(argument) !== 'string' &&
    lookupSpecial(argument, '__getitem__') !== undefined;
  return renderPercent(new TemplateReader(iterStr(template), argument, isMapping), 'string');
}

/** Formats a template with its reader, raising CPython's error for arguments the template leaves unused. */
export function renderPercent(reader: TemplateReader, kind: 'string' | 'bytes'): string {
  const runtime = currentRuntime();
  let result = '';
  while (!reader.done) {
    const char = reader.read();
    result += char === '%' ? reader.convert() : char;
    runtime.ensureStringFits(result.length);
  }
  if (reader.hasUnusedArguments && reader.mapping === undefined) {
    throw typeError(`not all arguments converted during ${kind} formatting`);
  }
  runtime.buildString(result.length);
  return result;
}

/** Reads a `%` template, taking the arguments its conversion specifiers consume. */
export class TemplateReader {
  private index = 0;
  private nextArgument = 0;
  private readonly args: readonly PyValue[];
  /** The mapping that `%(key)` specifiers look their values up in, when the argument is one. */
  readonly mapping: PyValue | undefined;

  constructor(
    private readonly chars: readonly string[],
    argument: PyValue,
    isMapping: boolean
  ) {
    this.args = argument instanceof PyTuple && !(argument instanceof PyInstance) ? [...argument.items] : [argument];
    this.mapping = isMapping ? argument : undefined;
  }

  get done(): boolean {
    return this.index >= this.chars.length;
  }

  get hasUnusedArguments(): boolean {
    return this.nextArgument < this.args.length;
  }

  read(): string {
    return this.chars[this.index++];
  }

  /** Converts the specifier following a `%`, following the grammar of printf-style conversion specifiers. */
  convert(): string {
    if (this.done) throw valueError('incomplete format');
    // Only `%%` escapes a percent sign; after a key, flag, width, precision, or length, `%` is a conversion.
    if (this.peek() === '%') {
      this.index++;
      return '%';
    }
    let value = this.peek() === '(' ? this.mappingValue() : undefined;
    let flags = '';
    while ('-+ #0'.includes(this.peek() ?? 'x')) flags += this.read();
    let width = this.readCount('width', MAX_SSIZE, 'ssize_t');
    // A negative `*` width left-aligns by its magnitude, and a negative `*` precision means zero.
    if (width < 0n) {
      flags += '-';
      width = -width;
    }
    let precision: number | undefined;
    if (this.peek() === '.') {
      this.index++;
      const count = this.readCount('precision', MAX_INT, 'int');
      precision = count < 0n ? 0 : Number(count);
    }
    // CPython skips one length modifier; a second is read as the conversion character.
    if ('hlL'.includes(this.peek() ?? 'x')) this.index++;
    const type = this.peek();
    this.index++;
    if (type === undefined) throw valueError('incomplete format');
    value ??= this.take();
    return this.convertSpecifier(type, value, flags, width === 0n ? '' : String(width), precision, this.index - 1);
  }

  /** Converts the value of one specifier, as bytes formatting does differently for some types. */
  protected convertSpecifier(
    type: string,
    value: PyValue,
    flags: string,
    width: string,
    precision: number | undefined,
    position: number
  ): string {
    const converted = 'eEfFgG'.includes(type) ? this.floatValue(value) : value;
    return convertOne(type, converted, flags, width, precision, position);
  }

  protected floatValue(value: PyValue): number {
    return percentFloat(value, 'must be real number');
  }

  /** The key of a `%(key)` specifier, which bytes formatting looks up as bytes. */
  protected mappingKey(key: string): PyValue {
    return key;
  }

  private peek(): string | undefined {
    return this.chars[this.index];
  }

  private take(): PyValue {
    if (this.nextArgument >= this.args.length) throw typeError('not enough arguments for format string');
    return this.args[this.nextArgument++];
  }

  /** Reads a parenthesized mapping key, returning the value the mapping has for it. */
  private mappingValue(): PyValue {
    if (this.mapping === undefined) throw typeError('format requires a mapping');
    let depth = 1;
    let key = '';
    this.index++;
    while (!this.done && depth > 0) {
      const c = this.read();
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (depth > 0) key += c;
    }
    if (depth > 0) throw valueError('incomplete format key');
    return getItem(this.mapping, this.mappingKey(key));
  }

  /** Reads a width or a precision: digits, or `*` taking it from the arguments as the C type CPython stores it in. */
  private readCount(name: string, max: bigint, cType: string): bigint {
    if (this.peek() === '*') {
      this.index++;
      const count = intArgument(this.take(), '* wants int');
      if (count > max || count < -max - 1n)
        throw pyError('OverflowError', `Python int too large to convert to C ${cType}`);
      return count;
    }
    let digits = '';
    while (/\d/.test(this.peek() ?? '')) digits += this.read();
    const count = BigInt(digits || '0');
    if (count > max) throw valueError(`${name} too big`);
    return count;
  }
}

function intArgument(value: PyValue, message: string): bigint {
  if (typeof value !== 'bigint' && typeof value !== 'boolean') throw typeError(message);
  return BigInt(value);
}

/** The flags, width, and precision of a conversion specifier. */
interface Conversion {
  align: '<' | '>';
  zero: boolean;
  sign: string;
  alternate: string;
  width: string;
  precision: number | undefined;
}

function convertOne(
  type: string,
  value: PyValue,
  flags: string,
  width: string,
  precision: number | undefined,
  position: number
): string {
  const left = flags.includes('-');
  const conversion: Conversion = {
    align: left ? '<' : '>',
    zero: flags.includes('0') && !left,
    sign: flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '',
    alternate: flags.includes('#') ? '#' : '',
    width,
    precision,
  };
  if ('sra'.includes(type)) return pyFormat(textOf(type, value, precision), `${conversion.align}${width}`);
  if (type === 'c') return pyFormat(charOf(value), `${conversion.align}${width}`);
  if ('diuxXo'.includes(type)) return formatInteger(type, toInteger(type, value), conversion);
  if ('eEfFgG'.includes(type)) {
    const { zero, align, sign, alternate } = conversion;
    const precisionText = `.${precision ?? 6}`;
    return pyFormat(value, `${zero ? '0=' : align}${sign}${alternate}${width}${precisionText}${type}`);
  }
  throw valueError(
    `unsupported format character '${type}' (0x${(type.codePointAt(0) as number).toString(16)}) at index ${position}`
  );
}

function textOf(type: string, value: PyValue, precision: number | undefined): string {
  const text = type === 's' ? pyStr(value) : type === 'r' ? pyRepr(value) : pyAscii(value);
  return precision === undefined ? text : truncateStr(text, precision);
}

function charOf(argument: PyValue): string {
  const unboxed = unbox(argument);
  if (typeof unboxed === 'string') {
    currentRuntime().scan(unboxed.length);
    const length = strLength(unboxed);
    if (length !== 1) throw typeError(`%c requires an int or a unicode character, not a string of length ${length}`);
    return unboxed;
  }
  if (
    typeof unboxed === 'bigint' ||
    typeof unboxed === 'boolean' ||
    lookupSpecial(argument, '__index__') !== undefined
  ) {
    const code = toIndex(argument);
    if (code > MAX_SSIZE || code < -MAX_SSIZE - 1n) {
      throw pyError('OverflowError', 'Python int too large to convert to C long');
    }
    if (code < 0n || code > 0x10_ff_ffn) throw pyError('OverflowError', '%c arg not in range(0x110000)');
    return String.fromCodePoint(Number(code));
  }
  throw typeError(`%c requires an int or a unicode character, not ${typeName(argument)}`);
}

/** Lays an integer out as CPython's `_PyUnicode_FormatLong` and `unicode_format_arg_output` do. */
function formatInteger(type: string, integer: bigint, conversion: Conversion): string {
  const { sign, alternate, precision = 0 } = conversion;
  const formatType = 'diu'.includes(type) ? 'd' : type;
  const magnitude = pyFormat(integer < 0n ? -integer : integer, formatType);
  currentRuntime().buildString(precision);
  const prefix = alternate && formatType !== 'd' ? `0${formatType}` : '';
  return padNumber(`${integer < 0n ? '-' : sign}${prefix}`, magnitude.padStart(precision, '0'), conversion);
}

/** Pads a number to the width: with zeros between its sign and prefix and its digits, or with spaces outside. */
function padNumber(signAndPrefix: string, digits: string, { align, zero, width }: Conversion): string {
  const padding = Math.max(0, Number(width) - signAndPrefix.length - digits.length);
  if (align === '<') return signAndPrefix + digits + repeatText(' ', padding);
  return zero ? signAndPrefix + repeatText('0', padding) + digits : repeatText(' ', padding) + signAndPrefix + digits;
}

/** The integer a `%d`-like conversion formats, as mainformatlong of CPython's unicodeobject.c converts it. */
function toInteger(type: string, value: PyValue): bigint {
  const unboxed = unbox(value);
  if (typeof unboxed === 'bigint') return unboxed;
  if (typeof unboxed === 'boolean') return unboxed ? 1n : 0n;
  const isDecimal = 'diu'.includes(type);
  const wrongType = (): Error =>
    typeError(`%${type} format: ${isDecimal ? 'a real number' : 'an integer'} is required, not ${typeName(value)}`);
  if (!isNumber(value)) throw wrongType();
  try {
    return isDecimal ? (unbox(callValue(intClass, [value])) as bigint) : toIndex(value);
  } catch (error) {
    if (error instanceof PyError && error.exception.cls.isSubclassOf(exceptionClassNamed('TypeError')))
      throw wrongType();
    throw error;
  }
}

/** The float a `%f`-like conversion formats, as PyFloat_AsDouble converts it. */
export function percentFloat(value: PyValue, message: string): number {
  const unboxed = unbox(value);
  if (typeof unboxed === 'string' || !isNumber(value) || unboxed instanceof PyComplex) {
    throw typeError(`${message}, not ${typeName(value)}`);
  }
  return unbox(callValue(floatClass, [value])) as number;
}

/** CPython's PyNumber_Check: a value with an int, index, or float conversion, or a complex number. */
function isNumber(value: PyValue): boolean {
  const unboxed = unbox(value);
  if (typeof unboxed === 'number' || typeof unboxed === 'bigint' || typeof unboxed === 'boolean') return true;
  if (typeof unboxed === 'string' || value === None) return false;
  if (unboxed instanceof PyComplex) return true;
  return ['__index__', '__int__', '__float__'].some((name) => lookupSpecial(value, name) !== undefined);
}
