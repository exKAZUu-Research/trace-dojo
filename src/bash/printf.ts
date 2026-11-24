import { formatFloatField } from '../interpreter/floatFormat';
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { charactersOf } from './characters';
import { ansicQuote, ansicShouldQuote, backslashQuote, singleQuote } from './quoting';
import { UnsupportedFeatureError } from './unsupported';

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

const SIMPLE_ESCAPES: Record<string, number> = { a: 7, b: 8, e: 27, E: 27, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 };
const BACKSLASH: EscapeResult = { out: [92], length: 0, stop: false };

/** The escapes of `printf`'s format and of `%b`, as Bash's `tescape`; `forB` reads `\c` and `\0nnn` as `%b` does. */
// code-gauge-allow functionCognitiveComplexity -- One case per escape of printf's format and %b, as Bash's tescape.
function escape(bytes: number[], start: number, forB: boolean, host: PrintfHost): EscapeResult {
  const c = String.fromCodePoint(bytes[start]);
  if (c in SIMPLE_ESCAPES) return { out: [SIMPLE_ESCAPES[c]], length: 1, stop: false };
  if (/[0-7]/.test(c)) return octalEscape(bytes, start, forB);
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

/** `\nnn`, or `\0nnn` in `%b`, whose leading zero does not count among its three digits. */
function octalEscape(bytes: number[], start: number, forB: boolean): EscapeResult {
  let value = bytes[start] - 48;
  let index = start + 1;
  let remaining = 2 + (value === 0 && forB ? 1 : 0);
  while (remaining-- > 0 && index < bytes.length && bytes[index] >= 48 && bytes[index] <= 55) {
    value = value * 8 + bytes[index] - 48;
    index++;
  }
  return { out: [value & 0xff], length: index - start, stop: false };
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
  let value = 0;
  let index = start + 1;
  while (index < bytes.length && index <= start + maxDigits && isHex(bytes[index])) {
    value = value * 16 + hexValue(bytes[index++]);
  }
  if (index === start + 1) {
    host.error(missing);
    return BACKSLASH;
  }
  return { out: encode(value), length: index - start, stop: false };
}

const isHex = (byte: number): boolean => /[0-9A-Fa-f]/.test(String.fromCodePoint(byte));
const hexValue = (byte: number): number => Number.parseInt(String.fromCodePoint(byte), 16);

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

  private push(bytes: number[]): void {
    for (const byte of bytes) this.out.push(byte);
    if (this.out.length > LIMITS.maxStringLength) throw new ExecutionLimitError('output');
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
    while (i < fmt.length && LENGTH_MODIFIERS.includes(String.fromCodePoint(fmt[i]))) i++;
    if (i >= fmt.length) this.fail(`\`${decodeBytes(fmt.slice(start))}': missing format character`);
    const conversion = String.fromCodePoint(fmt[i]);
    checkFieldSize(width, NUMERIC_CONVERSIONS.includes(conversion) ? precision : undefined);
    this.format({ flags, width, precision, conversion });
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
      this.push(encodeText(formatInteger(this.integer(conversion === 'd' || conversion === 'i'), spec)));
    } else if ('eEfFgGaA'.includes(conversion)) {
      const arg = this.takeArgument();
      const value = arg === undefined ? 0 : parseFloatArgument(arg, this.host, this.conversionError);
      this.push(encodeText(formatFloat(value, spec)));
    } else if (conversion === 'c') {
      const arg = this.takeArgument();
      this.push(pad(arg === undefined || arg === '' ? [0] : [encodeText(arg)[0]], spec));
    } else if (conversion === 's' && !spec.flags.includes('#')) {
      this.push(pad(truncate(encodeText(this.takeArgument() ?? ''), precision), spec));
    } else if (conversion === 's' || conversion === 'b') {
      // `%#s` is `%b`, as in Bash.
      const { out, stop } = expandB(this.takeArgument() ?? '', this.host);
      this.push(pad(truncate(out, precision), spec));
      if (stop) throw new StopOutput();
    } else if (conversion === 'q' || conversion === 'Q') this.quote(spec);
    else if (conversion === 'n') throw new UnsupportedFeatureError('printf の %n');
    else if (conversion === '(') throw new UnsupportedFeatureError('printf の時刻の書式（%(...)T）');
    else this.fail(`\`${conversion}': invalid format character`);
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
    this.push(pad(spec.conversion === 'Q' ? bytes : truncate(bytes, spec.precision), spec));
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

function truncate(bytes: number[], precision: number | undefined): number[] {
  return precision === undefined || precision >= bytes.length ? bytes : bytes.slice(0, precision);
}

/** Pads a string or character conversion to its width in bytes, as C's `printf` does. */
function pad(bytes: number[], spec: Specification): number[] {
  const width = spec.width ?? 0;
  if (bytes.length >= width) return bytes;
  const padding = Array.from({ length: width - bytes.length }, () => 32);
  return spec.flags.includes('-') ? [...bytes, ...padding] : [...padding, ...bytes];
}

/**
 * Reads an integer argument as `strtoimax` with base 0 does, or the code of the character after a leading quote,
 * reporting an argument that is not wholly a number but using the part that is.
 */
// code-gauge-allow functionCognitiveComplexity -- strtoimax's syntax with Bash's character-code arguments and its two kinds of conversion error.
// code-gauge-allow functionNcss -- strtoimax's syntax with Bash's character-code arguments and its two kinds of conversion error.
function parseInteger(arg: string, signed: boolean, host: PrintfHost, conversionError: () => void): bigint {
  if (arg === '') return 0n;
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

/** Reads a floating-point argument as macOS's `strtold` (a `double` on arm64) does. */
// code-gauge-allow functionCognitiveComplexity -- strtod's syntax (infinities, NaN, hexadecimal, decimal) with Bash's conversion errors.
// code-gauge-allow functionNcss -- strtod's syntax (infinities, NaN, hexadecimal, decimal) with Bash's conversion errors.
function parseFloatArgument(arg: string, host: PrintfHost, conversionError: () => void): number {
  if (arg === '') return 0;
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

/** Groups the digits of an integer by thousands with commas, as the `'` flag does in `en_US.UTF-8`. */
function groupThousands(digits: string): string {
  return digits.replaceAll(/\B(?=(\d{3})+$)/g, ',');
}

// code-gauge-allow functionCognitiveComplexity -- C's rules for the integer conversions: sign, precision, grouping, and alternate prefixes.
function formatInteger(value: bigint, spec: Specification): string {
  const { flags, precision, conversion } = spec;
  const negative = (conversion === 'd' || conversion === 'i') && value < 0n;
  const magnitude = negative ? -value : value;
  const base = conversion === 'o' ? 8 : conversion === 'x' || conversion === 'X' ? 16 : 10;
  let digits = magnitude.toString(base);
  if (conversion === 'X') digits = digits.toUpperCase();
  if (precision === 0 && magnitude === 0n) digits = '';
  if (precision !== undefined) digits = digits.padStart(precision, '0');
  if (flags.includes("'") && base === 10) digits = groupThousands(digits);
  let prefix = '';
  if (negative) prefix = '-';
  else if ((conversion === 'd' || conversion === 'i') && flags.includes('+')) prefix = '+';
  else if ((conversion === 'd' || conversion === 'i') && flags.includes(' ')) prefix = ' ';
  if (flags.includes('#')) {
    if (conversion === 'o' && !digits.startsWith('0')) digits = `0${digits}`;
    else if ((conversion === 'x' || conversion === 'X') && magnitude !== 0n) prefix += conversion === 'x' ? '0x' : '0X';
  }
  return padNumber(prefix, digits, spec, precision === undefined);
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
function formatFloat(value: number, spec: Specification): string {
  const groups = spec.flags.includes("'") && 'fFgG'.includes(spec.conversion);
  let text = formatFloatField({ ...spec, width: groups ? undefined : spec.width }, value);
  if (groups && /^[-+ ]?\d/.test(text) && !/e/i.test(text)) {
    text = text.replace(/\d+/, (digits) => groupThousands(digits));
  }
  const width = spec.width ?? 0;
  if (text.length >= width) return text;
  return spec.flags.includes('-') ? text.padEnd(width, ' ') : text.padStart(width, ' ');
}
