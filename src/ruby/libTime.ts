import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import {
  compareValues,
  inspectValue,
  supportsImplicitConversion,
  toFloat,
  toInt,
  toStr,
  tryImplicitConversion,
} from './conversions';
import { def, sdef } from './define';
import { argumentError, floatDomainError, frozenError, rangeError, rubyError, typeError } from './errors';
import { bigintRatio } from './floatMath';
import { callMethod, type Gen } from './interp';
import { floatToRational, isRational } from './libRational';
import { isRubyFloat, NIL, type RClass, type RHash, RObject, RString, type Value } from './objects';
import { rt, UnsupportedFeatureError } from './runtime';
import { arr, isA, realClassOf, str, stringBytes, stringFromBytes } from './values';

/** The local time zone, which the grader fixes to Japan's (no daylight saving time). */
const LOCAL_OFFSET = 9 * 3600;
const LOCAL_ZONE = 'JST';

/** A Time: nanoseconds since the epoch, the offset it shows its fields in, and how it names its zone. */
class TimeData {
  constructor(
    readonly nanoseconds: bigint,
    readonly offset: number,
    readonly zone: 'local' | 'utc' | 'fixed',
    readonly exactOffset?: Value,
    readonly remainderNumerator = 0n,
    readonly remainderDenominator = 1n
  ) {}

  hashKey(): string {
    return `t${this.nanoseconds}:${this.remainderNumerator}/${this.remainderDenominator}`;
  }

  /** The fields as UTC fields of the shifted instant, which shows the local fields. */
  fields(): Date {
    const offset = offsetFraction(this.exactOffset, this.offset);
    const numerator =
      this.exactNumerator() * offset.denominator + offset.numerator * this.remainderDenominator * 1_000_000_000n;
    const milliseconds = floorDivide(numerator, this.remainderDenominator * offset.denominator * 1_000_000n);
    if (milliseconds < -8_640_000_000_000_000n || milliseconds > 8_640_000_000_000_000n)
      throw new UnsupportedFeatureError('JavaScript の日付範囲外の Time');
    return new Date(Number(milliseconds));
  }

  exactNumerator(): bigint {
    return this.nanoseconds * this.remainderDenominator + this.remainderNumerator;
  }
}

function floorDivide(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
}

// code-gauge-allow functionParameterCount 7 -- A Time carries its class, instant, zone and exact fractional remainder.
function makeTime(
  cls: RClass,
  nanoseconds: bigint,
  offset = LOCAL_OFFSET,
  zone: TimeData['zone'] = 'local',
  exactOffset?: Value,
  remainderNumerator = 0n,
  remainderDenominator = 1n
): RObject {
  const time = new RObject(cls);
  time.data = new TimeData(nanoseconds, offset, zone, exactOffset, remainderNumerator, remainderDenominator);
  return time;
}

function makeExactTime(
  cls: RClass,
  numerator: bigint,
  denominator: bigint,
  offset = LOCAL_OFFSET,
  zone: TimeData['zone'] = 'local',
  exactOffset?: Value
): RObject {
  const nanoseconds = floorDivide(numerator, denominator);
  let remainder = numerator - nanoseconds * denominator;
  if (remainder === 0n) return makeTime(cls, nanoseconds, offset, zone, exactOffset);
  let a = remainder;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  remainder /= a;
  return makeTime(cls, nanoseconds, offset, zone, exactOffset, remainder, denominator / a);
}

function offsetFraction(value: Value | undefined, offset: number): { numerator: bigint; denominator: bigint } {
  if (typeof value === 'bigint') return { numerator: value, denominator: 1n };
  if (value !== undefined && isRational(value)) return value.data as { numerator: bigint; denominator: bigint };
  if (typeof value === 'number') return floatToRational(value).data as { numerator: bigint; denominator: bigint };
  return { numerator: BigInt(offset), denominator: 1n };
}

function dataOf(time: RObject): TimeData {
  if (!(time.data instanceof TimeData)) throw typeError('uninitialized Time');
  return time.data as TimeData;
}

/** The virtual clock: the host's time plus what `sleep` has slept, since sleeping does not wait here. */
function nowNanoseconds(): bigint {
  const runtime = rt() as unknown as { slept?: number };
  return BigInt(Math.round((Date.now() + (runtime.slept ?? 0) * 1000) * 1e6));
}

function* fieldArgs(args: Value[]): Gen<{ fields: number[]; seconds: number }> {
  const fields: number[] = [];
  for (const [index, arg] of args.slice(0, 5).entries()) fields.push(yield* fieldValue(arg, index));
  while (fields.length < 5) fields.push(fields.length < 3 ? 1 : 0);
  const seconds = args.length > 5 ? yield* secondsValue(args[5]) : 0;
  if (!Number.isFinite(seconds))
    throw floatDomainError(Number.isNaN(seconds) ? 'NaN' : seconds > 0 ? 'Infinity' : '-Infinity');
  for (const [index, width] of [16, 32, 32, 64].entries())
    if (fields[index + 1] < 0 || fields[index + 1] >= width) throw argumentError('argument out of range');
  if (seconds < 0 || seconds >= 64) throw argumentError('argument out of range');
  if (fields[1] < 1 || fields[1] > 12) throw argumentError('mon out of range');
  if (fields[2] < 1 || fields[2] > 31) throw argumentError('mday out of range');
  if (fields[3] > 24) throw argumentError('hour out of range');
  if (fields[4] > 59 || (fields[3] === 24 && fields[4] > 0)) throw argumentError('min out of range');
  if (seconds >= 61 || (fields[3] === 24 && seconds >= 1)) throw argumentError('sec out of range');
  return { fields, seconds };
}

function* fieldValue(arg: Value, index: number): Gen<number> {
  if (arg === NIL) return index === 0 ? Number(yield* toInt(arg)) : index < 3 ? 1 : 0;
  if (!(arg instanceof RString)) return Number(yield* toInt(arg));
  const month =
    index === 1 && arg.s.length === 3
      ? MONTHS.findIndex((name) => name.slice(0, 3).toLowerCase() === arg.s.toLowerCase())
      : -1;
  if (month >= 0) return month + 1;
  if (/^[ \t\n\r\v\f]*[+-]?\d(?:_?\d)*[ \t\n\r\v\f]*$/.test(arg.s))
    return Number(BigInt(arg.s.replaceAll(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, '').replaceAll('_', '')));
  const inspected = yield* inspectValue(arg);
  const bytes = stringBytes(inspected);
  const binary = inspected.binary || inspected.usAscii || bytes.every((byte) => byte < 0x80);
  const escapeBytes = binary && bytes.some((byte) => byte >= 0x80);
  const shown = binary
    ? Array.from(bytes, (byte) => (escapeBytes ? escapedCalendarByte(byte) : String.fromCodePoint(byte))).join('')
    : inspected.s;
  const message = `${index === 0 ? "can't parse: " : 'invalid value for Integer(): '}${shown}`;
  throw rubyError(
    rt().c.ArgumentError,
    binary ? stringFromBytes(new TextEncoder().encode(message), true) : str(message)
  );
}

function escapedCalendarByte(byte: number): string {
  if (byte === 0) return String.raw`\0`;
  if (byte === 7) return String.raw`\a`;
  if (byte === 8) return String.raw`\b`;
  if (byte === 9) return String.raw`\t`;
  if (byte === 10) return String.raw`\n`;
  if (byte === 11) return String.raw`\v`;
  if (byte === 12) return String.raw`\f`;
  if (byte === 13) return String.raw`\r`;
  if (byte === 27) return String.raw`\e`;
  if (byte === 127) return String.raw`\c?`;
  if (byte < 32 || byte >= 127) return `\\x${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  return String.fromCodePoint(byte);
}

function* secondsValue(arg: Value): Gen<number> {
  if (arg === NIL) return 0;
  if (arg instanceof RString) return yield* fieldValue(arg, 5);
  return yield* toFloat(arg);
}

function* exactNumber(value: Value): Gen<number | bigint | RObject> {
  if (value instanceof RString) throw typeError("can't convert String into an exact number");
  if (isRubyFloat(value)) return Number(value);
  const rational = yield* exactRational(value);
  if (isA(value, rt().c.Numeric)) return rational ?? (yield* toFloat(value));
  if (!(yield* supportsImplicitConversion(value, 'to_int')))
    throw typeError(`can't convert ${realClassOf(value).name} into an exact number`);
  if (rational !== undefined) return rational;
  const integer = yield* callMethod(value, 'to_int', [], undefined, undefined, { fcall: true });
  if (typeof integer !== 'bigint')
    throw typeError(
      `can't convert ${realClassOf(value).name} to Integer (${realClassOf(value).name}#to_int gives ${realClassOf(integer).name})`
    );
  return integer;
}

function* exactRational(value: Value): Gen<bigint | RObject | undefined> {
  const rational = yield* tryImplicitConversion(value, 'to_r');
  if (rational !== undefined && typeof rational !== 'bigint' && !isRational(rational))
    throw typeError(`can't convert ${realClassOf(value).name} into an exact number`);
  return rational;
}

function* parseOffset(value: Value): Gen<number> {
  if (value === NIL) return LOCAL_OFFSET;
  if (typeof value === 'bigint' || isRubyFloat(value) || isRational(value)) {
    if (typeof value === 'bigint' || isRational(value)) {
      const integral = yield* toInt(value);
      if (integral <= -86_400n || integral >= 86_400n) throw argumentError('utc_offset out of range');
    }
    const offset = yield* toFloat(value);
    if (!Number.isFinite(offset))
      throw floatDomainError(Number.isNaN(offset) ? 'NaN' : offset > 0 ? 'Infinity' : '-Infinity');
    if (isRubyFloat(value) && Math.abs(offset) >= 86_400) throw argumentError('utc_offset out of range');
    return offset;
  }
  const text = yield* toStr(value);
  if (text === 'UTC' || text === 'Z') return 0;
  if (/^[A-IK-Y]$/.test(text)) {
    const letter = text.codePointAt(0) as number;
    return (letter <= 73 ? letter - 64 : letter <= 77 ? letter - 65 : -(letter - 77)) * 3600;
  }
  const match = /^([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text) ?? /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(text);
  if (!match || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59)
    throw argumentError(`"+HH:MM", "-HH:MM", "UTC" or "A".."I","K".."Z" expected for utc_offset: ${text}`);
  const offset =
    (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0));
  if (Math.abs(offset) >= 86_400) throw argumentError('utc_offset out of range');
  return offset;
}

function exactOffset(value: Value): Value | undefined {
  if (isRational(value)) return value;
  if (isRubyFloat(value) && !Number.isInteger(Number(value))) return floatToRational(Number(value));
  return undefined;
}

function zoneFromOffset(value: Value): TimeData['zone'] {
  return value instanceof RString &&
    (value.s === 'UTC' || value.s === 'Z' || /^(?:-0000(?:00)?|-00:00(?::00)?)$/.test(value.s))
    ? 'utc'
    : 'fixed';
}

function calendarArgs(args: Value[]): Value[] {
  if (args.length === 9) throw argumentError('wrong number of arguments (given 9, expected 1..8)');
  return args.length === 10 ? [args[5], args[4], args[3], args[2], args[1], args[0]] : args.slice(0, 6);
}

function* buildTime(
  cls: RClass,
  args: Value[],
  offset: number,
  zone: TimeData['zone'],
  microseconds?: Value,
  exact?: Value
): Gen<RObject> {
  const { fields, seconds } = yield* fieldArgs(args);
  const [year, month, day, hour, minute] = fields;
  const whole = Math.floor(seconds);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, whole);
  if (Number.isNaN(date.getTime())) throw new UnsupportedFeatureError('JavaScript の日付範囲外の Time');
  const localNanoseconds = BigInt(date.getTime()) * 1_000_000n;
  const secondPart = args[5];
  const exactSeconds = offsetFraction(
    secondPart !== undefined &&
      (typeof secondPart === 'bigint' || typeof secondPart === 'number' || isRational(secondPart))
      ? secondPart
      : seconds,
    0
  );
  const fraction = exactSeconds.numerator - BigInt(whole) * exactSeconds.denominator;
  const hasMicroseconds = microseconds !== undefined && microseconds !== NIL;
  const microsecondsValue = !hasMicroseconds
    ? 0n
    : microseconds instanceof RString
      ? yield* fieldValue(microseconds, 5)
      : typeof microseconds === 'bigint' || isRubyFloat(microseconds) || isRational(microseconds)
        ? isRubyFloat(microseconds)
          ? Number(microseconds)
          : microseconds
        : yield* toInt(microseconds);
  const micros = offsetFraction(microsecondsValue, 0);
  if (micros.numerator < 0n || micros.numerator >= 1_000_000n * micros.denominator)
    throw argumentError('subsecx out of range');
  const localNumerator =
    (localNanoseconds * exactSeconds.denominator + (hasMicroseconds ? 0n : fraction) * 1_000_000_000n) *
      micros.denominator +
    micros.numerator * 1000n * exactSeconds.denominator;
  const localDenominator = exactSeconds.denominator * micros.denominator;
  const fractionOffset = offsetFraction(exact, offset);
  return makeExactTime(
    cls,
    localNumerator * fractionOffset.denominator - fractionOffset.numerator * 1_000_000_000n * localDenominator,
    localDenominator * fractionOffset.denominator,
    offset,
    zone,
    exact
  );
}

sdef(
  'Time',
  'now',
  0,
  (self: RClass, _args, _block, keywords) => {
    if (keywords) throw new UnsupportedFeatureError('Time.now の in: 指定');
    return makeTime(self, nowNanoseconds());
  },
  { keywords: true }
);
sdef(
  'Time',
  'new',
  [0, -1],
  function* (self: RClass, args, block, keywords) {
    const value = new RObject(self);
    yield* callMethod(value, 'initialize', args, keywords, block, { fcall: true, used: false });
    return value;
  },
  { keywords: true }
);
def(
  'Time',
  'initialize',
  [0, 7],
  function* (self: RObject, args, _block, keywords) {
    if (self.data) throw typeError('already initialized Time');
    const value = yield* initializeTime(realClassOf(self), args, keywords);
    self.data = value.data;
    return self;
  },
  { visibility: 'private', keywords: true }
);

function* initializeTime(cls: RClass, args: Value[], keywords: RHash | undefined): Gen<RObject> {
  if (keywords) throw new UnsupportedFeatureError('Time.new の in: 指定');
  if (args.length === 0) return makeTime(cls, nowNanoseconds());
  if (args.length === 1 && args[0] instanceof RString && /^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/.test(args[0].s))
    throw new UnsupportedFeatureError('Time.new の文字列形式');
  if (args.length === 7 && args[6] !== NIL)
    return yield* buildTime(
      cls,
      args.slice(0, 6),
      yield* parseOffset(args[6]),
      zoneFromOffset(args[6]),
      undefined,
      exactOffset(args[6])
    );
  return yield* buildTime(cls, args, LOCAL_OFFSET, 'local');
}

sdef('Time', ['local', 'mktime'], [1, 10], function* (self: RClass, args) {
  return yield* buildTime(self, calendarArgs(args), LOCAL_OFFSET, 'local', args.length === 7 ? args[6] : undefined);
});
sdef('Time', ['utc', 'gm'], [1, 10], function* (self: RClass, args) {
  return yield* buildTime(self, calendarArgs(args), 0, 'utc', args.length === 7 ? args[6] : undefined);
});
sdef(
  'Time',
  'at',
  [1, 3],
  function* (self: RClass, args, _block, keywords) {
    if (keywords || args.length > 2) throw new UnsupportedFeatureError('Time.at の unit/in: 指定');
    const [seconds, microseconds] = args;
    if (seconds instanceof RObject && seconds.data instanceof TimeData) {
      if (microseconds !== undefined) throw typeError("can't convert Time into an exact number");
      return makeTime(
        self,
        seconds.data.nanoseconds,
        seconds.data.offset,
        seconds.data.zone,
        seconds.data.exactOffset,
        seconds.data.remainderNumerator,
        seconds.data.remainderDenominator
      );
    }
    const first = offsetFraction(
      typeof seconds === 'bigint' || typeof seconds === 'number' || isRational(seconds)
        ? seconds
        : yield* exactNumber(seconds),
      0
    );
    const second =
      microseconds === undefined
        ? { numerator: 0n, denominator: 1n }
        : offsetFraction(
            typeof microseconds === 'bigint' || typeof microseconds === 'number' || isRational(microseconds)
              ? microseconds
              : yield* exactNumber(microseconds),
            0
          );
    return makeExactTime(
      self,
      first.numerator * second.denominator * 1_000_000_000n + second.numerator * first.denominator * 1000n,
      first.denominator * second.denominator
    );
  },
  { keywords: true }
);

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function yearDay(date: Date): number {
  const first = new Date(0);
  first.setUTCFullYear(date.getUTCFullYear(), 0, 1);
  first.setUTCHours(0, 0, 0, 0);
  return Math.floor((date.getTime() - first.getTime()) / 86_400_000) + 1;
}

function isoWeek(date: Date): { year: number; week: number } {
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const year = thursday.getUTCFullYear();
  const first = new Date(0);
  first.setUTCFullYear(year, 0, 4);
  first.setUTCHours(0, 0, 0, 0);
  first.setUTCDate(4 + 3 - ((first.getUTCDay() + 6) % 7));
  return { year, week: Math.floor((thursday.getTime() - first.getTime()) / 604_800_000) + 1 };
}

function offsetText(offset: number, colon: boolean, includeSeconds = false): string {
  const magnitude = Math.round(Math.abs(offset));
  const sign = magnitude === 0 || offset >= 0 ? '+' : '-';
  const hours = String(Math.floor(magnitude / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((magnitude % 3600) / 60)).padStart(2, '0');
  const seconds = magnitude % 60;
  return `${sign}${hours}${colon ? ':' : ''}${minutes}${includeSeconds && seconds ? `${colon ? ':' : ''}${String(seconds).padStart(2, '0')}` : ''}`;
}

function zoneName(data: TimeData): Value {
  if (data.zone === 'utc') return str('UTC');
  if (data.zone === 'local') return str(LOCAL_ZONE);
  return NIL;
}

/** A number padded as `strftime` pads it: `-` leaves it unpadded and `_` pads it with spaces. */
function pad(value: number, width: number, flag: string): string {
  if (flag === '-') return String(value);
  return String(value).padStart(width, flag === '_' ? ' ' : '0');
}

function strftime(data: TimeData, format: string): string {
  if (format.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
  if (/%[-_0^#]*\d*:{0,3}$/.test(format.replaceAll('%%', ''))) throw argumentError(`invalid format: ${format}`);
  const date = data.fields();
  let outputLength = format.length;
  const result = format.replaceAll(
    /%([-_0^#]*)(\d*)(:{0,3})([a-zA-Z%+])/g,
    (whole, flags: string, widthText: string, colons: string, directive: string) => {
      const finish = (value: string): string => {
        outputLength += value.length - whole.length;
        if (outputLength > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
        return value;
      };
      const width = widthText ? Number(widthText) : undefined;
      if (width !== undefined && width > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
      const flag = /([-_0])[^-_0]*$/.exec(flags)?.[1] ?? '';
      const rendered =
        calendarDirective(data, date, directive, flag) ?? clockDirective(data, date, directive, flag, colons, whole);
      if (rendered === undefined) return finish(whole);
      if (directive === 'Z' && colons) return finish(whole);
      if (directive === 'Z' && zoneName(data) === NIL) return finish('');
      if (colons && directive !== 'z') throw new UnsupportedFeatureError(`Time#strftime(${whole})`);
      if ((directive === 'N' || directive === 'L') && width !== undefined) {
        chargePrecision(width);
        return finish(fractionDigits(data, width));
      }
      let result = caseText(rendered, directive, flags);
      if (directive === 'z') return finish(padOffset(result, width, flag));
      if (width !== undefined && (flag !== '-' || 'TXRDxFcrv'.includes(directive))) {
        const pad = flag === '_' || (flag !== '0' && defaultSpacePad(directive)) ? ' ' : '0';
        result =
          pad === '0' && result.startsWith('-') && ['Y', 'C', 'G', 's'].includes(directive)
            ? `-${result.slice(1).padStart(width - 1, '0')}`
            : result.padStart(width, pad);
      }
      return finish(result);
    }
  );
  if (result.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
  return result;
}

function chargePrecision(digits: number): void {
  if (!Number.isSafeInteger(digits) || digits * digits > LIMITS.maxOperations * 64)
    throw new ExecutionLimitError('operations');
  rt().spend(Math.ceil((digits * digits) / 64));
}

function fractionDigits(data: TimeData, width: number): string {
  const denominator = data.remainderDenominator * 1_000_000_000n;
  const numerator = data.exactNumerator();
  const remainder = ((numerator % denominator) + denominator) % denominator;
  return ((remainder * 10n ** BigInt(width)) / denominator).toString().padStart(width, '0');
}

function caseText(rendered: string, directive: string, flags: string): string {
  const text = flags.includes('^') ? rendered.toUpperCase() : rendered;
  if (!flags.includes('#')) return text;
  if ('aAbBhP'.includes(directive)) return text.toUpperCase();
  if ('pZ'.includes(directive)) return text.toLowerCase();
  return text;
}

function defaultSpacePad(directive: string): boolean {
  return 'eklaAbBh pPZcvrn tTXRDxF'.includes(directive);
}

function padOffset(value: string, width: number | undefined, flag: string): string {
  if (flag === '-') return width === undefined ? value : `${value[0]}${value.slice(1).padStart(width - 1, '0')}`;
  const target = width ?? value.length;
  if (flag === '_') {
    const body = value.slice(1).replace(/^0/, '');
    const compact = `${value[0]}${body}`;
    return compact.padStart(width ?? value.length, ' ');
  }
  return `${value[0]}${value.slice(1).padStart(target - 1, '0')}`;
}

function formatYear(year: number, flag: string): string {
  if (flag === '-') return String(year);
  if (flag === '_') return String(year).padStart(year < 0 ? 5 : 4, ' ');
  return year < 0 ? `-${String(-year).padStart(4, '0')}` : String(year).padStart(4, '0');
}

function calendarDirective(data: TimeData, date: Date, directive: string, flag: string): string | undefined {
  switch (directive) {
    case 'Y': {
      return formatYear(date.getUTCFullYear(), flag);
    }
    case 'C': {
      return pad(Math.floor(date.getUTCFullYear() / 100), 2, flag);
    }
    case 'y': {
      return pad(((date.getUTCFullYear() % 100) + 100) % 100, 2, flag);
    }
    case 'm': {
      return pad(date.getUTCMonth() + 1, 2, flag);
    }
    case 'd': {
      return pad(date.getUTCDate(), 2, flag);
    }
    case 'e': {
      return pad(date.getUTCDate(), 2, flag || '_');
    }
    case 'j': {
      return pad(yearDay(date), 3, flag);
    }
    case 'A': {
      return DAYS[date.getUTCDay()];
    }
    case 'a': {
      return DAYS[date.getUTCDay()].slice(0, 3);
    }
    case 'B': {
      return MONTHS[date.getUTCMonth()];
    }
    case 'b':
    case 'h': {
      return MONTHS[date.getUTCMonth()].slice(0, 3);
    }
    case 'u': {
      return String(date.getUTCDay() || 7);
    }
    case 'w': {
      return String(date.getUTCDay());
    }
    case 'U':
    case 'W': {
      const first = new Date(0);
      first.setUTCFullYear(date.getUTCFullYear(), 0, 1);
      const start = directive === 'U' ? first.getUTCDay() : (first.getUTCDay() + 6) % 7;
      return pad(Math.floor((yearDay(date) - 1 + start) / 7) + (start === 0 ? 1 : 0), 2, flag);
    }
    case 'V': {
      return pad(isoWeek(date).week, 2, flag);
    }
    case 'G': {
      return formatYear(isoWeek(date).year, flag);
    }
    case 'g': {
      return pad(((isoWeek(date).year % 100) + 100) % 100, 2, flag);
    }
    case 'F': {
      return strftime(data, '%Y-%m-%d');
    }
    case 'D':
    case 'x': {
      return strftime(data, '%m/%d/%y');
    }
    case 'v': {
      const year = date.getUTCFullYear();
      const shownYear = year < 0 ? `-${String(-year).padStart(3, '0')}` : String(year).padStart(4, '0');
      return `${strftime(data, '%e-%^b')}-${shownYear}`;
    }
    default: {
      return undefined;
    }
  }
}

function clockDirective(
  data: TimeData,
  date: Date,
  directive: string,
  flag: string,
  colons: string,
  whole: string
): string | undefined {
  const hour = date.getUTCHours();
  switch (directive) {
    case 'H': {
      return pad(hour, 2, flag);
    }
    case 'k': {
      return pad(hour, 2, flag || '_');
    }
    case 'I': {
      return pad(hour % 12 || 12, 2, flag);
    }
    case 'l': {
      return pad(hour % 12 || 12, 2, flag || '_');
    }
    case 'M': {
      return pad(date.getUTCMinutes(), 2, flag);
    }
    case 'S': {
      return pad(date.getUTCSeconds(), 2, flag);
    }
    case 'L': {
      return String(Number((floorDivide(data.nanoseconds, 1_000_000n) % 1000n) + 1000n) % 1000).padStart(3, '0');
    }
    case 'N': {
      return String(Number(((data.nanoseconds % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n)).padStart(9, '0');
    }
    case 'p': {
      return hour < 12 ? 'AM' : 'PM';
    }
    case 'P': {
      return hour < 12 ? 'am' : 'pm';
    }
    case 'z': {
      const offset = offsetText(data.offset, colons.length > 0);
      const value = data.zone === 'utc' && flag === '-' ? `-${offset.slice(1)}` : offset;
      const magnitude = Math.round(Math.abs(data.offset));
      if (colons.length === 2) return `${value}:${String(magnitude % 60).padStart(2, '0')}`;
      if (colons.length === 3)
        return magnitude % 60 !== 0
          ? `${value}:${String(magnitude % 60).padStart(2, '0')}`
          : magnitude % 3600 !== 0
            ? value
            : value.slice(0, 3);
      return value;
    }
    case 'Z': {
      const zone = zoneName(data);
      return zone === NIL ? '' : (zone as RString).s;
    }
    case 's': {
      return String(floorDivide(data.nanoseconds, 1_000_000_000n));
    }
    case 'T':
    case 'X': {
      return strftime(data, '%H:%M:%S');
    }
    case 'R': {
      return strftime(data, '%H:%M');
    }
    case 'c': {
      return strftime(data, '%a %b %e %H:%M:%S %Y');
    }
    case 'r': {
      return strftime(data, '%I:%M:%S %p');
    }
    case 'n': {
      return '\n';
    }
    case 't': {
      return '\t';
    }
    case '+': {
      return whole;
    }
    case '%': {
      return '%';
    }
    default: {
      return undefined;
    }
  }
}

function timeText(data: TimeData, withFraction: boolean): string {
  let text = strftime(data, '%Y-%m-%d %H:%M:%S');
  if (withFraction) {
    const denominator = data.remainderDenominator * 1_000_000_000n;
    const numerator = ((data.exactNumerator() % denominator) + denominator) % denominator;
    if (numerator !== 0n) {
      let a = numerator;
      let b = denominator;
      while (b !== 0n) [a, b] = [b, a % b];
      const reducedNumerator = numerator / a;
      const reducedDenominator = denominator / a;
      text +=
        1_000_000_000n % reducedDenominator === 0n
          ? `.${String((reducedNumerator * 1_000_000_000n) / reducedDenominator)
              .padStart(9, '0')
              .replace(/0+$/, '')}`
          : ` ${reducedNumerator}/${reducedDenominator}`;
    }
  }
  return `${text} ${data.zone === 'utc' ? 'UTC' : offsetText(data.offset, false, withFraction)}`;
}

export function timeDisplayOf(value: RObject): string | undefined {
  return value.data instanceof TimeData ? timeText(value.data, true) : undefined;
}

def('Time', 'to_s', 0, (self: RObject) => str(timeText(dataOf(self), false)));
def('Time', 'inspect', 0, (self: RObject) => str(timeText(dataOf(self), true)));
def('Time', 'strftime', 1, function* (self: RObject, [format]) {
  return str(strftime(dataOf(self), yield* toStr(format)));
});
for (const [name, read] of [
  ['year', (date: Date) => date.getUTCFullYear()],
  ['month', (date: Date) => date.getUTCMonth() + 1],
  ['mon', (date: Date) => date.getUTCMonth() + 1],
  ['day', (date: Date) => date.getUTCDate()],
  ['mday', (date: Date) => date.getUTCDate()],
  ['hour', (date: Date) => date.getUTCHours()],
  ['min', (date: Date) => date.getUTCMinutes()],
  ['sec', (date: Date) => date.getUTCSeconds()],
  ['wday', (date: Date) => date.getUTCDay()],
  ['yday', yearDay],
] as const) {
  def('Time', name, 0, (self: RObject) => BigInt(read(dataOf(self).fields())));
}
for (const [index, day] of DAYS.entries()) {
  def('Time', `${day.toLowerCase()}?`, 0, (self: RObject) => dataOf(self).fields().getUTCDay() === index);
}
def(
  'Time',
  'usec',
  0,
  (self: RObject) => (((dataOf(self).nanoseconds % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n) / 1000n
);
def(
  'Time',
  'nsec',
  0,
  (self: RObject) => ((dataOf(self).nanoseconds % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n
);
def('Time', 'zone', 0, (self: RObject) => zoneName(dataOf(self)));
def('Time', ['utc_offset', 'gmt_offset', 'gmtoff'], 0, (self: RObject) => {
  const data = dataOf(self);
  return data.exactOffset ?? (Number.isInteger(data.offset) ? BigInt(data.offset) : floatToRational(data.offset));
});
def('Time', ['utc?', 'gmt?'], 0, (self: RObject) => dataOf(self).zone === 'utc');
def('Time', 'to_i', 0, (self: RObject) => floorDivide(dataOf(self).nanoseconds, 1_000_000_000n));
def('Time', 'to_f', 0, (self: RObject) => {
  const data = dataOf(self);
  return bigintRatio(data.exactNumerator(), data.remainderDenominator * 1_000_000_000n);
});
def('Time', ['getutc', 'getgm'], 0, (self: RObject) => {
  const data = dataOf(self);
  return makeTime(
    realClassOf(self),
    data.nanoseconds,
    0,
    'utc',
    undefined,
    data.remainderNumerator,
    data.remainderDenominator
  );
});
def('Time', ['utc', 'gmtime'], 0, (self: RObject) => changeZone(self, 0, 'utc'));
def('Time', 'getlocal', [0, 1], function* (self: RObject, args) {
  const data = dataOf(self);
  return args.length > 0 && args[0] !== NIL
    ? makeTime(
        realClassOf(self),
        data.nanoseconds,
        yield* parseOffset(args[0]),
        zoneFromOffset(args[0]),
        exactOffset(args[0]),
        data.remainderNumerator,
        data.remainderDenominator
      )
    : makeTime(
        realClassOf(self),
        data.nanoseconds,
        LOCAL_OFFSET,
        'local',
        undefined,
        data.remainderNumerator,
        data.remainderDenominator
      );
});
def('Time', 'localtime', [0, 1], function* (self: RObject, args) {
  if (args.length === 0 || args[0] === NIL) return changeZone(self, LOCAL_OFFSET, 'local');
  const offset = yield* parseOffset(args[0]);
  const zone = zoneFromOffset(args[0]);
  const exact = exactOffset(args[0]);
  if (self.frozen && !(dataOf(self).zone === 'utc' && zone === 'utc' && offset === 0 && exact === undefined))
    throw frozenError(self, timeText(dataOf(self), true));
  return changeZone(self, offset, zone, exact);
});

function changeZone(self: RObject, offset: number, zone: TimeData['zone'], exact?: Value): RObject {
  const data = dataOf(self);
  if (data.offset === offset && data.zone === zone && data.exactOffset === exact) return self;
  if (self.frozen) throw frozenError(self, timeText(data, true));
  self.data = new TimeData(data.nanoseconds, offset, zone, exact, data.remainderNumerator, data.remainderDenominator);
  return self;
}
def('Time', 'to_a', 0, (self: RObject) => {
  const data = dataOf(self);
  const date = data.fields();
  return arr([
    BigInt(date.getUTCSeconds()),
    BigInt(date.getUTCMinutes()),
    BigInt(date.getUTCHours()),
    BigInt(date.getUTCDate()),
    BigInt(date.getUTCMonth() + 1),
    BigInt(date.getUTCFullYear()),
    BigInt(date.getUTCDay()),
    BigInt(yearDay(date)),
    false,
    zoneName(data),
  ]);
});
def('Time', 'round', [0, 1], function* (self: RObject, args) {
  const precision = args.length > 0 ? yield* toInt(args[0]) : 0n;
  if (precision < 0n) throw argumentError('negative ndigits given');
  const digits = Number(precision);
  const data = dataOf(self);
  if (digits > 9) {
    chargePrecision(digits);
    const scale = 10n ** BigInt(digits - 9);
    const rounded = floorDivide(
      2n * data.exactNumerator() * scale + data.remainderDenominator,
      2n * data.remainderDenominator
    );
    return makeExactTime(rt().c.Time, rounded, scale, data.offset, data.zone, data.exactOffset);
  }
  const unit = 10n ** BigInt(9 - digits);
  const rounded =
    floorDivide(2n * data.exactNumerator() + unit * data.remainderDenominator, 2n * unit * data.remainderDenominator) *
    unit;
  return makeTime(rt().c.Time, rounded, data.offset, data.zone, data.exactOffset);
});
def('Time', '+', 1, function* (self: RObject, [seconds]) {
  if (seconds instanceof RObject && seconds.data instanceof TimeData) throw typeError('time + time?');
  const data = dataOf(self);
  const delta = offsetFraction(
    typeof seconds === 'bigint' || typeof seconds === 'number' || isRational(seconds)
      ? seconds
      : yield* exactNumber(seconds),
    0
  );
  return makeExactTime(
    rt().c.Time,
    data.exactNumerator() * delta.denominator + delta.numerator * data.remainderDenominator * 1_000_000_000n,
    data.remainderDenominator * delta.denominator,
    data.offset,
    data.zone,
    data.exactOffset
  );
});
def('Time', '-', 1, function* (self: RObject, [other]) {
  const data = dataOf(self);
  if (other instanceof RObject && other.data instanceof TimeData) {
    return bigintRatio(
      data.exactNumerator() * other.data.remainderDenominator - other.data.exactNumerator() * data.remainderDenominator,
      data.remainderDenominator * other.data.remainderDenominator * 1_000_000_000n
    );
  }
  const delta = offsetFraction(
    typeof other === 'bigint' || typeof other === 'number' || isRational(other) ? other : yield* exactNumber(other),
    0
  );
  return makeExactTime(
    rt().c.Time,
    data.exactNumerator() * delta.denominator - delta.numerator * data.remainderDenominator * 1_000_000_000n,
    data.remainderDenominator * delta.denominator,
    data.offset,
    data.zone,
    data.exactOffset
  );
});
def('Time', '<=>', 1, (self: RObject, [other]) => {
  if (!(other instanceof RObject && other.data instanceof TimeData)) return NIL;
  const left = dataOf(self);
  const right = other.data;
  const a = left.exactNumerator() * right.remainderDenominator;
  const b = right.exactNumerator() * left.remainderDenominator;
  return a < b ? -1n : a > b ? 1n : 0n;
});
def(
  'Time',
  ['==', 'eql?'],
  1,
  (self: RObject, [other]) =>
    other instanceof RObject &&
    other.data instanceof TimeData &&
    other.data.exactNumerator() * dataOf(self).remainderDenominator ===
      dataOf(self).exactNumerator() * other.data.remainderDenominator
);
def('Time', 'hash', 0, (self: RObject) => {
  const data = dataOf(self);
  return (data.exactNumerator() ^ data.remainderDenominator) % 1_000_000_007n;
});

def(
  'Kernel',
  'sleep',
  [0, 1],
  function* (_self, args) {
    if (args.length === 0 || args[0] === NIL) throw new ExecutionLimitError('time');
    const runtime = rt() as unknown as { slept?: number };
    const seconds = yield* toFloat(args[0]);
    if (seconds < 0) throw argumentError('time interval must not be negative');
    if (!Number.isFinite(seconds)) throw rangeError(`${Number.isNaN(seconds) ? 'NaN' : 'Inf'} out of Time range`);
    const slept = (runtime.slept ?? 0) + seconds;
    const clock = Date.now() + slept * 1000;
    if (!Number.isFinite(clock) || Math.abs(clock) > 8_640_000_000_000_000)
      throw new UnsupportedFeatureError('JavaScript の日付範囲外の sleep');
    runtime.slept = slept;
    return BigInt(Math.round(seconds));
  },
  { visibility: 'private' }
);

export { compareValues };
