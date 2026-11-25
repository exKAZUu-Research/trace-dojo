import { formatFloatField, padPrintfBytes } from '../interpreter/floatFormat';
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { rejectUnsupportedPrintfConversion } from './capabilities';
import { charactersOf } from './characters';
import {
  ansicQuote,
  ansicShouldQuote,
  backslashQuote,
  readRadixDigits,
  SIMPLE_ESCAPE_BYTES,
  singleQuote,
} from './quoting';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Decodes bytes as UTF-8, replacing invalid sequences as a terminal reading Bash's output shows them. */
export function decodeBytes(bytes: number[] | Uint8Array): string {
  return decoder.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

export function encodeText(text: string): number[] {
  return [...encoder.encode(text)];
}

/** What a run of `printf` reports: errors go to the shell, which prefixes them like any builtin's. */
export interface PrintfHost {
  error(message: string): void;
  spend(cost?: number): void;
}

const FLAGS = "#'-+ 0";
const LENGTH_MODIFIERS = 'hjlLtz';

interface EscapeResult {
  out: number[];
  /** The bytes the escape takes after its backslash; 0 leaves the backslash as text and reads what follows it. */
  length: number;
  stop: boolean;
}

const BACKSLASH: EscapeResult = { out: [92], length: 0, stop: false };

/** Decodes a backslash escape in `printf`'s format string or `%b` argument (`forB` enables `\c` and `\0nnn`). */
// code-gauge-allow functionCognitiveComplexity -- Dispatches simple escapes, octal escapes, hex/Unicode escapes, quote escapes, and %b's \c.
function escape(bytes: number[], start: number, forB: boolean, host: PrintfHost): EscapeResult {
  const c = String.fromCodePoint(bytes[start]);
  if (Object.hasOwn(SIMPLE_ESCAPE_BYTES, c)) return { out: [SIMPLE_ESCAPE_BYTES[c]], length: 1, stop: false };
  if (/[0-7]/.test(c)) {
    const { value, count } = readRadixDigits(bytes, start, bytes[start] === 48 && forB ? 4 : 3, 8);
    return { out: [value & 0xff], length: count, stop: false };
  }
  if (c === 'x')
    return hexEscape(bytes, start, 2, host, String.raw`missing hex digit for \x`, (value) => [value & 0xff]);
  if (c === 'u' || c === 'U') {
    return hexEscape(bytes, start, c === 'u' ? 4 : 8, host, `missing unicode digit for \\${c}`, (value) =>
      value <= 0x7f ? [value] : value <= 0x10_ff_ff ? encodeText(String.fromCodePoint(value)) : []
    );
  }
  if (c === "'" || c === '"' || c === '?') return forB ? BACKSLASH : { out: [bytes[start]], length: 1, stop: false };
  if (c === 'c' && forB) return { out: [], length: 1, stop: true };
  return BACKSLASH;
}

/** `\xHH`, `\uHHHH`, and `\UHHHHHHHH`, which report an error and stay text without a digit. */
function hexEscape(
  bytes: number[],
  start: number,
  maxDigits: number,
  host: PrintfHost,
  missing: string,
  encode: (value: number) => number[]
): EscapeResult {
  const { value, count } = readRadixDigits(bytes, start + 1, maxDigits, 16);
  if (count === 0) {
    host.error(missing);
    return BACKSLASH;
  }
  return { out: encode(value), length: 1 + count, stop: false };
}

/** `%b`'s expansion of an argument's escapes, telling whether a `\c` ended all output. */
function expandB(text: string, host: PrintfHost): { out: number[]; stop: boolean } {
  const bytes = encodeText(text);
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 92 || i + 1 >= bytes.length) {
      out.push(bytes[i]);
      continue;
    }
    const result = escape(bytes, i + 1, true, host);
    if (result.stop) return { out, stop: true };
    out.push(...result.out);
    i += result.length;
  }
  return { out, stop: false };
}

interface Specification {
  flags: string;
  width: number | undefined;
  precision: number | undefined;
  conversion: string;
  wide?: boolean;
}

/**
 * Formats `printf`'s output as bytes, reusing the format while arguments remain, as Bash's `printf` builtin does.
 * Returns the output and whether every conversion succeeded.
 */
export function formatPrintf(format: string, args: string[], host: PrintfHost): { output: number[]; ok: boolean } {
  return new Printf(encodeText(format), args, host).run();
}

/** Ends the output early: at `\c` in `%b`, or at a specification `printf` cannot read. */
class StopOutput {}

class Printf {
  private readonly out: number[] = [];
  private ok = true;
  private next = 0;

  constructor(
    private readonly fmt: number[],
    private readonly args: string[],
    private readonly host: PrintfHost
  ) {}

  run(): { output: number[]; ok: boolean } {
    try {
      do {
        const consumedBefore = this.next;
        this.formatOnce();
        if (this.next === consumedBefore) break;
      } while (this.next < this.args.length);
    } catch (error) {
      if (!(error instanceof StopOutput)) throw error;
    }
    return { output: this.out, ok: this.ok };
  }

  private push(bytes: ArrayLike<number>): void {
    if (bytes.length > 0) this.host.spend(Math.ceil(bytes.length / 256));
    if (this.out.length + bytes.length > LIMITS.maxStringLength) throw new ExecutionLimitError('output');
    for (let i = 0; i < bytes.length; i++) this.out.push(bytes[i]);
  }

  private takeArgument(): string | undefined {
    return this.next < this.args.length ? this.args[this.next++] : undefined;
  }

  private conversionError = (): void => {
    this.ok = false;
  };

  private fail(message: string): never {
    this.host.error(message);
    this.ok = false;
    throw new StopOutput();
  }

  private formatOnce(): void {
    const { fmt } = this;
    for (let i = 0; i < fmt.length; i++) {
      this.host.spend();
      if (fmt[i] === 92 && i + 1 < fmt.length) {
        const result = escape(fmt, i + 1, false, this.host);
        this.push(result.out);
        i += result.length;
      } else if (fmt[i] !== 37) this.out.push(fmt[i]);
      else if (fmt[i + 1] === 37) {
        this.out.push(37);
        i++;
      } else i = this.convert(i);
    }
  }

  /** Reads the specification starting at the `%` at `start` and formats its argument, returning where it ends. */
  private convert(start: number): number {
    const { fmt } = this;
    let i = start + 1;
    let flags = '';
    while (i < fmt.length && FLAGS.includes(String.fromCodePoint(fmt[i]))) flags += String.fromCodePoint(fmt[i++]);
    let width: number | undefined;
    if (fmt[i] === 42) {
      i++;
      width = this.starArgument();
      if (width < 0) {
        flags += '-';
        width = -width;
      }
    } else ({ value: width, end: i } = this.digits(i));
    let precision: number | undefined;
    if (fmt[i] === 46) ({ precision, end: i } = this.precision(i + 1));
    let wide = false;
    while (i < fmt.length && LENGTH_MODIFIERS.includes(String.fromCodePoint(fmt[i]))) {
      if (fmt[i] === 108) wide = true;
      i++;
    }
    if (i >= fmt.length) this.fail(`\`${decodeBytes(fmt.slice(start))}': missing format character`);
    const conversion = String.fromCodePoint(fmt[i]);
    checkFieldSize(width, NUMERIC_CONVERSIONS.includes(conversion) ? precision : undefined);
    this.format({ flags, width, precision, conversion, wide });
    return i;
  }

  private digits(start: number): { value: number | undefined; end: number } {
    let digits = '';
    let i = start;
    while (i < this.fmt.length && this.fmt[i] >= 48 && this.fmt[i] <= 57) digits += String.fromCodePoint(this.fmt[i++]);
    return { value: digits ? Number(digits) : undefined, end: i };
  }

  /** The precision after a `.`, where a negative one, as C says, counts as none. */
  private precision(start: number): { precision: number | undefined; end: number } {
    if (this.fmt[start] === 42) {
      const value = this.starArgument();
      return { precision: value < 0 ? undefined : value, end: start + 1 };
    }
    const negative = this.fmt[start] === 45;
    const { value, end } = this.digits(negative ? start + 1 : start);
    return { precision: negative ? undefined : (value ?? 0), end };
  }

  private starArgument(): number {
    const arg = this.takeArgument();
    if (arg === undefined) return 0;
    const value = parseInteger(arg, true, this.host, this.conversionError);
    return value < -2_147_483_648n || value > 2_147_483_647n ? 0 : Number(value);
  }

  private integer(signed: boolean): bigint {
    const arg = this.takeArgument();
    return arg === undefined ? 0n : parseInteger(arg, signed, this.host, this.conversionError);
  }

  // code-gauge-allow functionCognitiveComplexity -- One case per conversion character of Bash's printf.
  // code-gauge-allow functionNcss -- One case per conversion character of Bash's printf.
  private format(spec: Specification): void {
    const { conversion, precision } = spec;
    if ('diouxX'.includes(conversion)) {
      this.push(encodeText(formatInteger(this.integer(conversion === 'd' || conversion === 'i'), spec, this.host)));
    } else if ('eEfFgGaA'.includes(conversion)) {
      const arg = this.takeArgument();
      const value = arg === undefined ? 0 : parseFloatArgument(arg, this.host, this.conversionError);
      this.push(encodeText(formatFloat(value, spec, this.host)));
    } else if (conversion === 'C' || (conversion === 'c' && spec.wide)) {
      this.formatWideChar(spec);
    } else if (conversion === 'S' || (conversion === 's' && spec.wide)) {
      this.formatWideString(spec);
    } else if (conversion === 'c') {
      const arg = this.takeArgument();
      this.push(padPrintfBytes(arg === undefined || arg === '' ? [0] : [encodeText(arg)[0]], spec));
    } else if (conversion === 's' && !spec.flags.includes('#')) {
      this.push(padPrintfBytes(truncate(encodeText(this.takeArgument() ?? ''), precision), spec));
    } else if (conversion === 's' || conversion === 'b') {
      // `%#s` is `%b`, as in Bash.
      const { out, stop } = expandB(this.takeArgument() ?? '', this.host);
      this.push(padPrintfBytes(truncate(out, precision), spec, false));
      if (stop) throw new StopOutput();
    } else if (conversion === 'q' || conversion === 'Q') this.quote(spec);
    else if (conversion === 'n' || conversion === '(') rejectUnsupportedPrintfConversion(conversion);
    else this.fail(`\`${conversion}': invalid format character`);
  }

  private formatWideChar(spec: Specification): void {
    const arg = this.takeArgument();
    if (arg === undefined || arg === '') {
      this.push(padPrintfBytes([0], spec, false));
      return;
    }
    const [ch] = charactersOf(arg);
    this.push(padWideCharacters([ch], spec));
  }

  private formatWideString(spec: Specification): void {
    const chars = charactersOf(this.takeArgument() ?? '');
    this.push(padWideCharacters(spec.precision === undefined ? chars : chars.slice(0, spec.precision), spec));
  }

  /** `%q` and `%Q`, the latter applying the precision to the argument before quoting it. */
  private quote(spec: Specification): void {
    let arg = this.takeArgument() ?? '';
    if (spec.conversion === 'Q' && spec.precision !== undefined) {
      arg = decodeBytes(truncate(encodeText(arg), spec.precision));
    }
    let quoted: string;
    if (arg === '') quoted = "''";
    else if (ansicShouldQuote(arg)) quoted = ansicQuote(arg);
    else if (spec.flags.includes('#')) quoted = singleQuote(arg);
    else quoted = backslashQuote(arg, true, true);
    const bytes = encodeText(quoted);
    this.push(padPrintfBytes(spec.conversion === 'Q' ? bytes : truncate(bytes, spec.precision), spec, false));
  }
}

/** The conversions whose precision adds digits, unlike that of `%s`, which only cuts its argument. */
const NUMERIC_CONVERSIONS = 'diouxXfFeEgGaA';

/** Stops a field wider than any string a program may hold before building it, as `%999999999d` would be. */
function checkFieldSize(width: number | undefined, precision: number | undefined): void {
  if ((width ?? 0) > LIMITS.maxStringLength || (precision ?? 0) > LIMITS.maxStringLength) {
    throw new ExecutionLimitError('storage');
  }
}

function padWideCharacters(chars: string[], spec: Specification): number[] {
  const pad = ' '.repeat(Math.max(0, (spec.width ?? 0) - chars.length));
  const body = chars.join('');
  return encodeText(spec.flags.includes('-') ? body + pad : pad + body);
}

function truncate(bytes: number[], precision: number | undefined): number[] {
  return precision === undefined || precision >= bytes.length ? bytes : bytes.slice(0, precision);
}

/**
 * Reads an integer argument as `strtoimax` with base 0 does, or the code of the character after a leading quote,
 * reporting an argument that is not wholly a number but using the part that is.
 */
// code-gauge-allow functionCognitiveComplexity -- strtoimax's syntax with Bash's character-code arguments and its two kinds of conversion error.
// code-gauge-allow functionNcss -- strtoimax's syntax with Bash's character-code arguments and its two kinds of conversion error.
function parseInteger(arg: string, signed: boolean, host: PrintfHost, conversionError: () => void): bigint {
  if (arg.startsWith("'") || arg.startsWith('"')) {
    const [, c] = charactersOf(arg);
    return c === undefined ? 0n : BigInt(c.codePointAt(0) as number);
  }
  const match = /^[ \t\n\v\f\r]*([-+]?)(0[xX][0-9A-Fa-f]+|0[0-7]*|[1-9][0-9]*)/.exec(arg);
  if (!match) {
    invalidNumber(arg, host);
    conversionError();
    return 0n;
  }
  const [whole, sign, digits] = match;
  let magnitude: bigint;
  if (/^0[xX]/.test(digits)) magnitude = BigInt(digits);
  else if (digits.startsWith('0') && digits.length > 1) magnitude = BigInt(`0o${digits.slice(1)}`);
  else magnitude = BigInt(digits);
  let value = sign === '-' ? -magnitude : magnitude;
  let overflow = false;
  if (signed) {
    if (value > 2n ** 63n - 1n) {
      value = 2n ** 63n - 1n;
      overflow = true;
    } else if (value < -(2n ** 63n)) {
      value = -(2n ** 63n);
      overflow = true;
    }
  } else if (magnitude > 2n ** 64n - 1n) {
    value = 2n ** 64n - 1n;
    overflow = true;
  } else value = BigInt.asUintN(64, value);
  if (whole.length !== arg.length) {
    invalidNumber(arg, host);
    conversionError();
  } else if (overflow) {
    host.error(`${arg}: Result too large`);
    conversionError();
  }
  return value;
}

function invalidNumber(arg: string, host: PrintfHost): void {
  let message = 'invalid number';
  if (/^0[0-9]/.test(arg)) message = 'invalid octal number';
  else if (arg.startsWith('0x')) message = 'invalid hex number';
  host.error(`${arg}: ${message}`);
}

/** Reads a floating-point argument as IEEE-754 `double` `strtod` does, reporting Bash's conversion errors. */
// code-gauge-allow functionCognitiveComplexity -- strtod's syntax (infinities, NaN, hexadecimal, decimal) with Bash's conversion errors.
// code-gauge-allow functionNcss -- strtod's syntax (infinities, NaN, hexadecimal, decimal) with Bash's conversion errors.
function parseFloatArgument(arg: string, host: PrintfHost, conversionError: () => void): number {
  if (arg.startsWith("'") || arg.startsWith('"')) {
    const [, c] = charactersOf(arg);
    return c === undefined ? 0 : (c.codePointAt(0) as number);
  }
  const trimmed = arg.replace(/^[ \t\n\v\f\r]+/, '');
  const special = /^([-+]?)(inf(inity)?|nan(\([0-9A-Za-z_]*\))?)/i.exec(trimmed);
  let value: number;
  let length: number;
  if (special) {
    const isNan = special[2].toLowerCase().startsWith('nan');
    value = isNan ? Number.NaN : Number.POSITIVE_INFINITY;
    if (special[1] === '-') value = -value;
    length = special[0].length;
  } else {
    const hex = /^[-+]?0[xX](?:[0-9A-Fa-f]+\.?[0-9A-Fa-f]*|\.[0-9A-Fa-f]+)(?:[pP][-+]?\d+)?/.exec(trimmed);
    const decimal = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(trimmed);
    if (hex) {
      value = parseHexFloat(hex[0]);
      length = hex[0].length;
    } else if (decimal) {
      value = Number(decimal[0]);
      length = decimal[0].length;
    } else {
      invalidNumber(arg, host);
      conversionError();
      return 0;
    }
  }
  if (length !== trimmed.length) {
    invalidNumber(arg, host);
    conversionError();
  } else if (!Number.isFinite(value) && !special) {
    host.error(`${arg}: Result too large`);
    conversionError();
  }
  return value;
}

function parseHexFloat(text: string): number {
  const match = /^([-+]?)0[xX]([0-9A-Fa-f]*)\.?([0-9A-Fa-f]*)(?:[pP]([-+]?\d+))?$/.exec(text) as RegExpExecArray;
  const [, sign, integerDigits, fractionDigits, exponentText] = match;
  const mantissa = BigInt(`0x${integerDigits || '0'}${fractionDigits}`);
  const exponent = Number(exponentText ?? 0) - 4 * fractionDigits.length;
  const value = Number(mantissa) * 2 ** exponent;
  return sign === '-' ? -value : value;
}

function formatInteger(value: bigint, spec: Specification, host: PrintfHost): string {
  const { flags, precision, conversion } = spec;
  const signed = conversion === 'd' || conversion === 'i';
  const negative = signed && value < 0n;
  const magnitude = negative ? -value : value;
  const base = integerBase(conversion);
  let digits = magnitude.toString(base);
  if (conversion === 'X') digits = digits.toUpperCase();
  if (precision === 0 && magnitude === 0n) digits = '';
  if (flags.includes("'") && base === 10) digits = groupThousands(digits, host);
  if (precision !== undefined) {
    if (precision > digits.length) host.spend(Math.ceil(precision / 256));
    digits = digits.padStart(precision, '0');
  }
  if (flags.includes('#') && conversion === 'o' && !digits.startsWith('0')) digits = `0${digits}`;
  return padNumber(integerPrefix(negative, signed, magnitude, spec), digits, spec, precision === undefined);
}

function integerBase(conversion: string): number {
  if (conversion === 'o') return 8;
  return conversion === 'x' || conversion === 'X' ? 16 : 10;
}

function integerPrefix(negative: boolean, signed: boolean, magnitude: bigint, spec: Specification): string {
  const { flags, conversion } = spec;
  let prefix = negative ? '-' : signed && flags.includes('+') ? '+' : signed && flags.includes(' ') ? ' ' : '';
  if (flags.includes('#') && (conversion === 'x' || conversion === 'X') && magnitude !== 0n) {
    prefix += conversion === 'x' ? '0x' : '0X';
  }
  return prefix;
}

function padNumber(prefix: string, digits: string, spec: Specification, zeroAllowed: boolean): string {
  const width = spec.width ?? 0;
  const length = prefix.length + digits.length;
  if (length >= width) return prefix + digits;
  if (spec.flags.includes('-')) return (prefix + digits).padEnd(width, ' ');
  if (spec.flags.includes('0') && zeroAllowed) return prefix + digits.padStart(width - prefix.length, '0');
  return (prefix + digits).padStart(width, ' ');
}

/** A floating-point conversion, which the `'` flag groups by thousands as `en_US.UTF-8` does. */
function formatFloat(value: number, spec: Specification, host: PrintfHost): string {
  const groups = spec.flags.includes("'") && 'fFgG'.includes(spec.conversion);
  let text = formatFloatField({ ...spec, width: groups ? undefined : spec.width }, value);
  if (groups && /^[-+ ]?\d/.test(text) && !/e/i.test(text)) {
    text = text.replace(/\d+/, (digits) => groupThousands(digits, host));
  }
  const width = spec.width ?? 0;
  if (text.length >= width) return text;
  if (spec.flags.includes('-')) return text.padEnd(width, ' ');
  if (spec.flags.includes('0') && /^[-+ ]?\d/.test(text)) {
    const sign = /^[-+ ]/.exec(text)?.[0] ?? '';
    return sign + text.slice(sign.length).padStart(width - sign.length, '0');
  }
  return text.padStart(width, ' ');
}

/** Groups the digits of an integer by thousands with commas in linear time, as the `'` flag does in `en_US.UTF-8`. */
function groupThousands(digits: string, host: PrintfHost): string {
  if (digits.length <= 3) return digits;
  host.spend(Math.ceil(digits.length / 256));
  const head = digits.length % 3;
  const groups: string[] = [];
  if (head > 0) groups.push(digits.slice(0, head));
  for (let i = head; i < digits.length; i += 3) groups.push(digits.slice(i, i + 3));
  return groups.join(',');
}
