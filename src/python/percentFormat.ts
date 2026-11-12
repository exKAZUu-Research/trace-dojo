import { pyAscii, pyFormat, pyRepr, pyStr } from './conversions';
import { floatToInt } from './numbers';
import { getAttribute, getItem, lookupSpecial } from './objects';
import { currentRuntime } from './runtimeContext';
import { iterStr } from './strings';
import { pyError, typeError, typeName, valueError } from './types';
import { PyInstance, PyTuple, type PyValue } from './values';

/** The `%` operator on a string. */
export function formatPercent(template: string, argument: PyValue): string {
  const args = argument instanceof PyTuple && !(argument instanceof PyInstance) ? [...argument.items] : [argument];
  const isTupleArgument = argument instanceof PyTuple;
  const mapping =
    !isTupleArgument && typeof argument !== 'string' && lookupSpecial(argument, '__getitem__') !== undefined
      ? argument
      : undefined;
  const reader = new TemplateReader(iterStr(template), args, mapping);
  let result = '';
  while (!reader.done) {
    const char = reader.read();
    result += char === '%' ? reader.convert() : char;
  }
  if (reader.hasUnusedArguments && mapping === undefined) {
    throw typeError('not all arguments converted during string formatting');
  }
  currentRuntime().buildString(result.length);
  return result;
}

/** Reads a `%` template, taking the arguments its conversion specifiers consume. */
class TemplateReader {
  private index = 0;
  private nextArgument = 0;

  constructor(
    private readonly chars: readonly string[],
    private readonly args: readonly PyValue[],
    private readonly mapping: PyValue | undefined
  ) {}

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
    const width = this.readCount('width', (1n << 63n) - 1n);
    let precision: number | undefined;
    if (this.peek() === '.') {
      this.index++;
      const digits = this.readCount('precision', (1n << 31n) - 1n);
      precision = digits ? Number(digits) : 0;
    }
    while ('hlL'.includes(this.peek() ?? 'x')) this.index++;
    const type = this.peek();
    this.index++;
    if (type === undefined) throw valueError('incomplete format');
    if (type === '%') return '%';
    value ??= this.take();
    return convertOne(type, value, flags, width, precision, this.index - 1);
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
    return getItem(this.mapping, key);
  }

  /** Reads a width or a precision: digits, or `*` taking it from the arguments. */
  private readCount(name: string, max: bigint): string {
    if (this.peek() === '*') {
      this.index++;
      return String(intArgument(this.take(), '* wants int'));
    }
    let digits = '';
    while (/\d/.test(this.peek() ?? '')) digits += this.read();
    if (digits.length > 9 && BigInt(digits) > max) throw valueError(`${name} too big`);
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

function charOf(value: PyValue): string {
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
  currentRuntime().buildString(precision);
  const padded = digits.padStart(precision, '0');
  const shown = type === 'X' ? padded.toUpperCase() : padded;
  const prefix = alternate ? `0${formatType === 'X' ? 'X' : formatType}` : '';
  const body = `${integer < 0n ? '-' : sign}${prefix}${shown}`;
  return pyFormat(body, `${zero ? '0' : ''}${align}${width}`);
}

function toInteger(type: string, value: PyValue): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number' && 'diu'.includes(type)) return floatToInt(value);
  if ('diu'.includes(type)) {
    if (value instanceof PyInstance && lookupSpecial(value, '__int__') !== undefined) {
      return toInteger(type, getAttribute(value, '__int__'));
    }
    throw typeError(`%${type} format: a real number is required, not ${typeName(value)}`);
  }
  throw typeError(`%${type} format: an integer is required, not ${typeName(value)}`);
}

function toFloat(value: PyValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw typeError(`must be real number, not ${typeName(value)}`);
}
