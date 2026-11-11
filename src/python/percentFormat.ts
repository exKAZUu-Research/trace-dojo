import { pyAscii, pyFormat, pyRepr, pyStr } from './conversions';
import { floatToInt } from './numbers';
import { callValue, getAttribute, getItem, lookupSpecial } from './objects';
import { intEnumValue } from './operators';
import { currentRuntime } from './runtimeContext';
import { iterStr } from './strings';
import { pyError, typeError, typeName, unbox, valueError } from './types';
import { PyInstance, PyObject, PyTuple, type PyValue } from './values';

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
  let result = '';
  while (!reader.done) {
    const char = reader.read();
    result += char === '%' ? reader.convert() : char;
  }
  if (reader.hasUnusedArguments && reader.mapping === undefined) {
    throw typeError(`not all arguments converted during ${kind} formatting`);
  }
  currentRuntime().buildString(result.length);
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
    let value = this.peek() === '(' ? this.mappingValue() : undefined;
    let flags = '';
    while ('-+ #0'.includes(this.peek() ?? 'x')) flags += this.read();
    const width = this.readCount();
    let precision: number | undefined;
    if (this.peek() === '.') {
      this.index++;
      const digits = this.readCount();
      precision = digits ? Number(digits) : 0;
    }
    while ('hlL'.includes(this.peek() ?? 'x')) this.index++;
    const type = this.peek();
    this.index++;
    if (type === undefined) throw valueError('incomplete format');
    if (type === '%') return '%';
    value ??= this.take();
    return this.convertSpecifier(type, value, flags, width, precision, this.index - 1);
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
    return convertOne(type, value, flags, width, precision, position);
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

  /** Reads a width or a precision: digits, or `*` taking it from the arguments. */
  private readCount(): string {
    if (this.peek() === '*') {
      this.index++;
      return String(intArgument(this.take(), '* wants int'));
    }
    let digits = '';
    while (/\d/.test(this.peek() ?? '')) digits += this.read();
    return digits;
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
    return pyFormat(toFloat(value), `${zero ? '0=' : align}${sign}${alternate}${width}${precisionText}${type}`);
  }
  throw valueError(
    `unsupported format character '${type}' (0x${(type.codePointAt(0) as number).toString(16)}) at index ${position}`
  );
}

function textOf(type: string, value: PyValue, precision: number | undefined): string {
  const text = type === 's' ? pyStr(value) : type === 'r' ? pyRepr(value) : pyAscii(value);
  return precision === undefined ? text : iterStr(text).slice(0, precision).join('');
}

function charOf(argument: PyValue): string {
  const unboxed = intEnumValue(unbox(argument));
  const value = intOf(unboxed, '__index__') ?? unboxed;
  if (typeof value === 'string') {
    const length = iterStr(value).length;
    if (length !== 1) throw typeError(`%c requires an int or a unicode character, not a string of length ${length}`);
    return value;
  }
  if (typeof value === 'bigint' || typeof value === 'boolean') {
    const code = BigInt(value);
    if (code < 0n || code > 0x10_ff_ffn) throw pyError('OverflowError', '%c arg not in range(0x110000)');
    return String.fromCodePoint(Number(code));
  }
  throw typeError(`%c requires an int or a unicode character, not ${typeName(value)}`);
}

function formatInteger(type: string, integer: bigint, conversion: Conversion): string {
  const { align, zero, sign, alternate, width, precision } = conversion;
  const formatType = 'diu'.includes(type) ? 'd' : type;
  if (precision === undefined) {
    return pyFormat(integer, `${zero ? '0=' : align}${sign}${alternate}${width}${formatType}`);
  }
  const digits = (integer < 0n ? -integer : integer).toString(formatType === 'd' ? 10 : formatType === 'o' ? 8 : 16);
  const padded = digits.padStart(precision, '0');
  const shown = type === 'X' ? padded.toUpperCase() : padded;
  const prefix = alternate ? `0${formatType === 'X' ? 'X' : formatType}` : '';
  const body = `${integer < 0n ? '-' : sign}${prefix}${shown}`;
  return pyFormat(body, `${zero ? '0' : ''}${align}${width}`);
}

function toInteger(type: string, argument: PyValue): bigint {
  const value = intEnumValue(unbox(argument));
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  const decimal = 'diu'.includes(type);
  if (typeof value === 'number' && decimal) return floatToInt(value);
  // CPython's %d takes int(value), through __int__ or __index__, and %x and %o take only __index__.
  const integer = decimal ? (intOf(value, '__int__') ?? intOf(value, '__index__')) : intOf(value, '__index__');
  if (integer !== undefined) return integer;
  throw typeError(`%${type} format: ${decimal ? 'a real number' : 'an integer'} is required, not ${typeName(value)}`);
}

/** The int a special method such as `__index__` gives, or undefined when it is missing or gives no int. */
function intOf(value: PyValue, name: '__int__' | '__index__'): bigint | undefined {
  if (!(value instanceof PyObject) || lookupSpecial(value, name) === undefined) return undefined;
  const result = callValue(getAttribute(value, name), []);
  if (typeof result === 'bigint') return result;
  if (typeof result === 'boolean') return result ? 1n : 0n;
  return undefined;
}

function toFloat(argument: PyValue): number {
  const value = unbox(argument);
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw typeError(`must be real number, not ${typeName(value)}`);
}
