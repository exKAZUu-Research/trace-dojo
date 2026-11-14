import { compareValues, toFloat, toInt, toStr } from './conversions';
import { def, sdef } from './define';
import { argumentError, frozenError, typeError } from './errors';
import { bigintRatio } from './floatMath';
import type { Gen } from './interp';
import { floatToRational, isRational } from './libRational';
import { NIL, RObject, RString, type Value } from './objects';
import { rt, UnsupportedFeatureError } from './runtime';
import { arr, str } from './values';

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
    return new Date(Number(floorDivide(numerator, this.remainderDenominator * offset.denominator * 1_000_000n)));
  }

  exactNumerator(): bigint {
    return this.nanoseconds * this.remainderDenominator + this.remainderNumerator;
  }
}

function floorDivide(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
}

function makeTime(
  nanoseconds: bigint,
  offset = LOCAL_OFFSET,
  zone: TimeData['zone'] = 'local',
  exactOffset?: Value,
  remainderNumerator = 0n,
  remainderDenominator = 1n
): RObject {
  const time = new RObject(rt().c.Time);
  time.data = new TimeData(nanoseconds, offset, zone, exactOffset, remainderNumerator, remainderDenominator);
  return time;
}

function makeExactTime(
  numerator: bigint,
  denominator: bigint,
  offset = LOCAL_OFFSET,
  zone: TimeData['zone'] = 'local',
  exactOffset?: Value
): RObject {
  const nanoseconds = floorDivide(numerator, denominator);
  let remainder = numerator - nanoseconds * denominator;
  if (remainder === 0n) return makeTime(nanoseconds, offset, zone, exactOffset);
  let a = remainder;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  remainder /= a;
  return makeTime(nanoseconds, offset, zone, exactOffset, remainder, denominator / a);
}

function offsetFraction(value: Value | undefined, offset: number): { numerator: bigint; denominator: bigint } {
  if (typeof value === 'bigint') return { numerator: value, denominator: 1n };
  if (value !== undefined && isRational(value)) return value.data as { numerator: bigint; denominator: bigint };
  if (typeof value === 'number') return floatToRational(value).data as { numerator: bigint; denominator: bigint };
  return { numerator: BigInt(offset), denominator: 1n };
}

function dataOf(time: RObject): TimeData {
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
  if (fields[1] < 1 || fields[1] > 12) throw argumentError('mon out of range');
  if (fields[2] < 1 || fields[2] > 31) throw argumentError('mday out of range');
  if (fields[3] < 0 || fields[3] > 24) throw argumentError('hour out of range');
  if (fields[4] < 0 || fields[4] > 59) throw argumentError('min out of range');
  if (seconds < 0 || seconds >= 61) throw argumentError('sec out of range');
  return { fields, seconds };
}

function* fieldValue(arg: Value, index: number): Gen<number> {
  if (arg === NIL) return index < 3 ? 1 : 0;
  if (!(arg instanceof RString)) return Number(yield* toInt(arg));
  const month = index === 1 ? MONTHS.findIndex((name) => name.toLowerCase().startsWith(arg.s.toLowerCase())) : -1;
  if (month >= 0 && arg.s.length >= 3) return month + 1;
  if (/^\s*[+-]?\d+\s*$/.test(arg.s)) return Number(BigInt(arg.s.trim()));
  throw argumentError(
    index === 0 ? `can't parse: ${JSON.stringify(arg.s)}` : `invalid value for Integer(): ${JSON.stringify(arg.s)}`
  );
}

function* secondsValue(arg: Value): Gen<number> {
  if (arg === NIL) return 0;
  if (arg instanceof RString && /^\s*[+-]?\d+(?:\.\d+)?\s*$/.test(arg.s)) return Number(arg.s);
  return yield* toFloat(arg);
}

function* parseOffset(value: Value): Gen<number> {
  if (value === NIL) return LOCAL_OFFSET;
  if (typeof value === 'bigint' || typeof value === 'number' || isRational(value)) {
    const offset = yield* toFloat(value);
    if (Math.abs(offset) >= 86_400) throw argumentError('utc_offset out of range');
    return offset;
  }
  const text = yield* toStr(value);
  if (text === 'UTC' || text === 'Z') return 0;
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(text);
  if (!match || Number(match[3]) > 59)
    throw argumentError(`"+HH:MM", "-HH:MM", "UTC" or "A".."I","K".."Z" expected for utc_offset: ${text}`);
  const offset = (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 3600 + Number(match[3]) * 60);
  if (Math.abs(offset) >= 86_400) throw argumentError('utc_offset out of range');
  return offset;
}

function exactOffset(value: Value): Value | undefined {
  if (isRational(value)) return value;
  if (typeof value === 'number' && !Number.isInteger(value)) return floatToRational(value);
  return undefined;
}

function* buildTime(args: Value[], offset: number, zone: TimeData['zone'], microseconds?: Value, exact?: Value): Gen {
  const { fields, seconds } = yield* fieldArgs(args);
  const [year, month, day, hour, minute] = fields;
  const whole = Math.floor(seconds);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, whole);
  const localNanoseconds = BigInt(date.getTime()) * 1_000_000n;
  const fraction = BigInt(Math.round((seconds - whole) * 1e9));
  const micros =
    microseconds === undefined
      ? 0n
      : typeof microseconds === 'bigint'
        ? microseconds * 1000n
        : BigInt(Math.floor((yield* toFloat(microseconds)) * 1000));
  const fractionOffset = offsetFraction(exact, offset);
  return makeExactTime(
    (localNanoseconds + fraction + micros) * fractionOffset.denominator - fractionOffset.numerator * 1_000_000_000n,
    fractionOffset.denominator,
    offset,
    zone,
    exact
  );
}

sdef('Time', 'now', 0, () => makeTime(nowNanoseconds()));
sdef('Time', 'new', [0, 7], function* (_self, args) {
  if (args.length === 0) return makeTime(nowNanoseconds());
  if (args.length === 1 && args[0] instanceof RString && /^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/.test(args[0].s))
    throw new UnsupportedFeatureError('Time.new の文字列形式');
  if (args.length === 7 && args[6] !== NIL)
    return yield* buildTime(args.slice(0, 6), yield* parseOffset(args[6]), 'fixed', undefined, exactOffset(args[6]));
  return yield* buildTime(args, LOCAL_OFFSET, 'local');
});
sdef('Time', ['local', 'mktime'], [1, 7], (_self, args) => buildTime(args.slice(0, 6), LOCAL_OFFSET, 'local', args[6]));
sdef('Time', ['utc', 'gm'], [1, 7], (_self, args) => buildTime(args.slice(0, 6), 0, 'utc', args[6]));
sdef('Time', 'at', [1, 2], function* (_self, args) {
  const [seconds, microseconds] = args;
  if (seconds instanceof RObject && seconds.data instanceof TimeData) {
    if (microseconds !== undefined) throw typeError("can't convert Time into an exact number");
    return makeTime(
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
      : yield* toFloat(seconds),
    0
  );
  const second =
    microseconds === undefined
      ? { numerator: 0n, denominator: 1n }
      : offsetFraction(
          typeof microseconds === 'bigint' || typeof microseconds === 'number' || isRational(microseconds)
            ? microseconds
            : yield* toFloat(microseconds),
          0
        );
  return makeExactTime(
    first.numerator * second.denominator * 1_000_000_000n + second.numerator * first.denominator * 1000n,
    first.denominator * second.denominator
  );
});

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

function offsetText(offset: number, colon: boolean): string {
  const sign = offset < 0 ? '-' : '+';
  const magnitude = Math.round(Math.abs(offset));
  const hours = String(Math.floor(magnitude / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((magnitude % 3600) / 60)).padStart(2, '0');
  return `${sign}${hours}${colon ? ':' : ''}${minutes}`;
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
  const date = data.fields();
  return format.replaceAll(
    /%([-_0^#]*)(\d*)(:{0,3})([a-zA-Z%+])/g,
    (whole, flags: string, widthText: string, colons: string, directive: string) => {
      if (colons && directive !== 'z') throw new UnsupportedFeatureError(`Time#strftime(${whole})`);
      const flag = /([-_0])[^-_0]*$/.exec(flags)?.[1] ?? '';
      const rendered =
        calendarDirective(data, date, directive, flag) ?? clockDirective(data, date, directive, flag, colons, whole);
      if (rendered === undefined) throw new UnsupportedFeatureError(`Time#strftime(${whole})`);
      const width = widthText ? Number(widthText) : undefined;
      if ((directive === 'N' || directive === 'L') && width !== undefined) {
        const digits = clockDirective(data, date, 'N', flag, '', whole) as string;
        return width <= 9 ? digits.slice(0, width) : digits.padEnd(width, '0');
      }
      let result = caseText(rendered, directive, flags);
      if (directive === 'z') return padOffset(result, width, flag);
      if (width !== undefined && flag !== '-')
        result = result.padStart(width, flag === '_' || (flag !== '0' && defaultSpacePad(directive)) ? ' ' : '0');
      return result;
    }
  );
}

function caseText(rendered: string, directive: string, flags: string): string {
  const text = flags.includes('^') ? rendered.toUpperCase() : rendered;
  if (!flags.includes('#')) return text;
  if ('aAbBhP'.includes(directive)) return text.toUpperCase();
  if ('pZ'.includes(directive)) return text.toLowerCase();
  return text;
}

function defaultSpacePad(directive: string): boolean {
  return 'eklaAbBh pPZcvrn t'.includes(directive);
}

function padOffset(value: string, width: number | undefined, flag: string): string {
  if (flag === '-') return value;
  const target = width ?? value.length;
  if (flag === '_') {
    const body = value.slice(1).replace(/^0+/, '') || '0';
    const compact = `${value[0]}${body}`;
    return compact.padStart(width ?? value.length, ' ');
  }
  return `${value[0]}${value.slice(1).padStart(target - 1, '0')}`;
}

function calendarDirective(data: TimeData, date: Date, directive: string, flag: string): string | undefined {
  switch (directive) {
    case 'Y': {
      return String(date.getUTCFullYear());
    }
    case 'C': {
      return pad(Math.floor(date.getUTCFullYear() / 100), 2, flag);
    }
    case 'y': {
      return pad(date.getUTCFullYear() % 100, 2, flag);
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
      return String(isoWeek(date).year);
    }
    case 'g': {
      return pad(isoWeek(date).year % 100, 2, flag);
    }
    case 'F': {
      return strftime(data, '%Y-%m-%d');
    }
    case 'D':
    case 'x': {
      return strftime(data, '%m/%d/%y');
    }
    case 'v': {
      return strftime(data, '%e-%^b-%Y');
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
      const value = offsetText(data.offset, colons.length > 0);
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
  const fraction = ((data.nanoseconds % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n;
  if (withFraction && fraction !== 0n) text += `.${String(fraction).padStart(9, '0').replace(/0+$/, '')}`;
  return `${text} ${data.zone === 'utc' ? 'UTC' : offsetText(data.offset, false)}`;
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
  return makeTime(data.nanoseconds, 0, 'utc', undefined, data.remainderNumerator, data.remainderDenominator);
});
def('Time', ['utc', 'gmtime'], 0, (self: RObject) => changeZone(self, 0, 'utc'));
def('Time', 'getlocal', [0, 1], function* (self: RObject, args) {
  const data = dataOf(self);
  return args.length > 0 && args[0] !== NIL
    ? makeTime(
        data.nanoseconds,
        yield* parseOffset(args[0]),
        'fixed',
        exactOffset(args[0]),
        data.remainderNumerator,
        data.remainderDenominator
      )
    : makeTime(data.nanoseconds, LOCAL_OFFSET, 'local', undefined, data.remainderNumerator, data.remainderDenominator);
});
def('Time', 'localtime', [0, 1], function* (self: RObject, args) {
  if (args.length === 0 || args[0] === NIL) return changeZone(self, LOCAL_OFFSET, 'local');
  const offset = yield* parseOffset(args[0]);
  if (self.frozen) throw frozenError(self, timeText(dataOf(self), true));
  return changeZone(self, offset, 'fixed', exactOffset(args[0]));
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
  const digits = args.length > 0 ? Number(yield* toInt(args[0])) : 0;
  if (digits > 9) {
    const data = dataOf(self);
    return makeTime(
      data.nanoseconds,
      data.offset,
      data.zone,
      data.exactOffset,
      data.remainderNumerator,
      data.remainderDenominator
    );
  }
  const unit = 10n ** BigInt(9 - digits);
  const data = dataOf(self);
  const rounded =
    floorDivide(2n * data.exactNumerator() + unit * data.remainderDenominator, 2n * unit * data.remainderDenominator) *
    unit;
  return makeTime(rounded, data.offset, data.zone, data.exactOffset);
});
def('Time', '+', 1, function* (self: RObject, [seconds]) {
  if (seconds instanceof RObject && seconds.data instanceof TimeData) throw typeError('time + time?');
  const data = dataOf(self);
  const delta = offsetFraction(
    typeof seconds === 'bigint' || typeof seconds === 'number' || isRational(seconds)
      ? seconds
      : yield* toFloat(seconds),
    0
  );
  return makeExactTime(
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
    typeof other === 'bigint' || typeof other === 'number' || isRational(other) ? other : yield* toFloat(other),
    0
  );
  return makeExactTime(
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
    const runtime = rt() as unknown as { slept?: number };
    const seconds = args.length > 0 ? yield* toFloat(args[0]) : 0;
    if (seconds < 0) throw argumentError('time interval must not be negative');
    runtime.slept = (runtime.slept ?? 0) + seconds;
    return BigInt(Math.round(seconds));
  },
  { visibility: 'private' }
);

export { compareValues };
