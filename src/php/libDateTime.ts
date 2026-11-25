// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { createObject } from './classes';
import { dayFromIsoWeek } from './dateCalendar';
import { formatMoment } from './dateFormat';
import { parseFromFormat } from './dateFromFormat';
import {
  addWall,
  compareMoments,
  diffMoments,
  type IntervalFields,
  localTime,
  modifyMoment,
  type Moment,
  resolveParsed,
  updateMoment,
} from './dateMoment';
import { emptyRelative, parseZoneName, type Relative } from './dateParse';
import {
  defaultZone,
  getLastErrors,
  momentFromString,
  nowIn,
  parseFailure,
  parseOrReject,
  setLastErrors,
  timestampSeconds,
} from './dateSupport';
import { type Zone, zoneInfo, zoneName } from './dateZone';
import { throwError, warn } from './errors';
import { internalIterator } from './libIterators';
import { defineClass, defineConstant, type NativeMethod } from './native';
import { toFloat, toInt } from './operators';
import { rt } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import { type Key, PhpArray, type PhpClass, PhpObject, Ref, type Value } from './values';

// States ---------------------------------------------------------------------------------------------------------------

/** The internal state of a DateTime or DateTimeImmutable object. */
class DateState {
  constructor(public moment?: Moment) {}

  clone(): DateState {
    return new DateState(this.moment && { ...this.moment });
  }

  properties(): PhpArray {
    const array = new PhpArray();
    for (const [key, value] of this.debugEntries()) array.set(key, value);
    return array;
  }

  debugEntries(): [Key, Value][] {
    if (!this.moment) return [];
    return [['date', formatMoment(this.moment, 'Y-m-d H:i:s.u')], ...zoneEntries(this.moment.zone)];
  }
}

function zoneEntries(zone: Zone): [Key, Value][] {
  return [
    ['timezone_type', BigInt(zone.type)],
    ['timezone', zoneName(zone)],
  ];
}

class ZoneState {
  constructor(public zone?: Zone) {}

  clone(): ZoneState {
    return new ZoneState(this.zone);
  }

  properties(): PhpArray {
    const array = new PhpArray();
    for (const [key, value] of this.debugEntries()) array.set(key, value);
    return array;
  }

  debugEntries(): [Key, Value][] {
    return this.zone ? zoneEntries(this.zone) : [];
  }
}

/** What DateInterval keeps beside its properties: the relative time a date string gave. */
class IntervalState {
  constructor(public relative?: Relative) {}

  clone(): IntervalState {
    return new IntervalState(this.relative && { ...this.relative });
  }
}

/** A copy of a DateInterval, which a DatePeriod keeps as PHP does instead of the object. */
interface IntervalCopy {
  props: [string, Value][];
  state: IntervalState;
}

interface PeriodState {
  start: Moment;
  startClass: PhpClass;
  current: Moment | undefined;
  end: Moment | undefined;
  interval: IntervalCopy;
  recurrences: number;
  includeStart: boolean;
  includeEnd: boolean;
}

const DATE_CLASSES = new Set(['datetime', 'datetimeimmutable', 'datetimezone', 'dateinterval', 'dateperiod']);

function notInitialized(cls: PhpClass): never {
  let base: PhpClass | undefined = cls;
  while (base && !DATE_CLASSES.has(base.name.toLowerCase())) base = base.parent;
  const inheriting = base && base !== cls ? ` (inheriting ${base.name})` : '';
  throwError(
    'DateObjectError',
    `Object of type ${cls.name}${inheriting} has not been correctly initialized by calling parent::__construct() in its constructor`
  );
}

export function momentOf(object: PhpObject): Moment {
  const moment = (object.internal as DateState | undefined)?.moment;
  if (!moment) notInitialized(object.cls);
  return moment;
}

function setMoment(object: PhpObject, moment: Moment): void {
  (object.internal as DateState).moment = moment;
}

export function zoneOf(object: PhpObject): Zone {
  const zone = (object.internal as ZoneState | undefined)?.zone;
  if (!zone) notInitialized(object.cls);
  return zone;
}

export function newDateObject(cls: PhpClass, moment: Moment): PhpObject {
  const object = createObject(cls);
  (object.internal as DateState).moment = moment;
  return object;
}

export function newZoneObject(zone: Zone): PhpObject {
  const object = createObject(classNamed('DateTimeZone'));
  (object.internal as ZoneState).zone = zone;
  return object;
}

function classNamed(name: string): PhpClass {
  return rt().classes.get(name.toLowerCase()) as PhpClass;
}

// Time zones -----------------------------------------------------------------------------------------------------------

/** The zone DateTimeZone's constructor makes of a name, or the message PHP reports for a bad one. */
export function zoneFromName(name: string): Zone | string {
  if (name.includes('\0')) return 'Timezone must not contain null bytes';
  const result = parseZoneName(name);
  if (result.kind === 'unknownAbbreviation') throw new UnsupportedFeatureError(`タイムゾーンの略称（${name}）`);
  if (result.kind === 'notFound' || result.rest !== '') return `Unknown or bad timezone (${name})`;
  const zone = result.zone;
  if (zone.type === 1 && Math.abs(zone.offset) >= 100 * 3600) return `Timezone offset is out of range (${name})`;
  return zone;
}

// Intervals ------------------------------------------------------------------------------------------------------------

const INTERVAL_PATTERN = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const COMBINED_PATTERN = /^P(\d{4})-(0\d|1[0-2])-(0\d|[12]\d|3[01])T([01]\d|2[0-4]):([0-5]\d):([0-5]\d)$/;

/** Parses an ISO 8601 duration as timelib_strtointerval does, or returns undefined when it is malformed. */
function parseDuration(spec: string): IntervalFields | undefined {
  const combined = COMBINED_PATTERN.exec(spec);
  if (combined) {
    const [y, m, d, h, i, s] = combined.slice(1).map(Number);
    return { y, m, d, h, i, s, us: 0, invert: false };
  }
  const match = INTERVAL_PATTERN.exec(spec);
  if (!match || spec === 'P' || spec.endsWith('T')) return undefined;
  const [y, m, w, d, h, i, s] = match.slice(1).map((part) => Number(part ?? 0));
  return { y, m, d: w * 7 + d, h, i, s, us: 0, invert: false };
}

function setIntervalProps(object: PhpObject, fields: IntervalFields, days: number | false): void {
  const props = object.props;
  for (const key of ['y', 'm', 'd', 'h', 'i', 's'] as const) props.set(key, BigInt(fields[key]));
  props.set('f', fields.us / 1_000_000);
  props.set('invert', fields.invert ? 1n : 0n);
  props.set('days', days === false ? false : BigInt(days));
  props.set('from_string', false);
}

function newInterval(fields: IntervalFields, days: number): PhpObject {
  const object = createObject(classNamed('DateInterval'));
  setIntervalProps(object, fields, days);
  return object;
}

function prop(object: PhpObject, key: string): Value {
  const slot = object.props.get(key);
  return slot instanceof Ref ? slot.v : ((slot as Value | undefined) ?? null);
}

function intervalFields(object: PhpObject | IntervalCopy): IntervalFields {
  const read = (key: string): Value =>
    object instanceof PhpObject ? prop(object, key) : (object.props.find(([name]) => name === key)?.[1] ?? null);
  const int = (key: string): number => Number(toInt(read(key)));
  return {
    y: int('y'),
    m: int('m'),
    d: int('d'),
    h: int('h'),
    i: int('i'),
    s: int('s'),
    us: Math.round(toFloat(read('f')) * 1_000_000),
    invert: int('invert') !== 0,
  };
}

function intervalState(object: PhpObject): IntervalState {
  return object.internal as IntervalState;
}

/** Adds or subtracts an interval as php_date_add and php_date_sub do. */
function applyInterval(moment: Moment, interval: PhpObject, sign: 1 | -1, method: string): Moment {
  const state = intervalState(interval);
  if (state.relative) {
    const relative = { ...state.relative };
    if (sign < 0) {
      if (relative.haveWeekday || relative.special) {
        warn(`${method}(): Only non-special relative time specifications are supported for subtraction`);
        return moment;
      }
      for (const key of ['y', 'm', 'd', 'h', 'i', 's', 'us'] as const) relative[key] = -relative[key];
    }
    return updateMoment(localTime(moment), relative, true, moment.zone);
  }
  return addWall(moment, intervalFields(interval), sign);
}

const pad2 = (value: number): string => `${value < 0 ? '-' : ''}${String(Math.abs(value)).padStart(2, '0')}`;

function formatInterval(object: PhpObject, format: string): string {
  const fields = intervalFields(object);
  const days = prop(object, 'days');
  const specifiers: Record<string, () => string> = {
    Y: () => pad2(fields.y),
    y: () => String(fields.y),
    M: () => pad2(fields.m),
    m: () => String(fields.m),
    D: () => pad2(fields.d),
    d: () => String(fields.d),
    H: () => pad2(fields.h),
    h: () => String(fields.h),
    I: () => pad2(fields.i),
    i: () => String(fields.i),
    S: () => pad2(fields.s),
    s: () => String(fields.s),
    F: () => String(fields.us).padStart(6, '0'),
    f: () => String(fields.us),
    a: () => (typeof days === 'bigint' ? String(days) : '(unknown)'),
    R: () => (fields.invert ? '-' : '+'),
    r: () => (fields.invert ? '-' : ''),
    '%': () => '%',
  };
  let text = '';
  for (let index = 0; index < format.length; index++) {
    if (format[index] !== '%') {
      text += format[index];
      continue;
    }
    index++;
    if (index >= format.length) break;
    const specifier = specifiers[format[index]];
    text += specifier ? specifier() : `%${format[index]}`;
  }
  return text;
}

// DateTime and DateTimeImmutable ---------------------------------------------------------------------------------------

const unsupportedSerialization = (signature: string, isStatic = false): NativeMethod => ({
  signature,
  isStatic,
  impl: () => {
    throw new UnsupportedFeatureError('直列化');
  },
});

function serializationMethods(): NativeMethod[] {
  return [
    unsupportedSerialization('__serialize(): array'),
    unsupportedSerialization('__unserialize(array $data): void'),
    unsupportedSerialization('__wakeup(): void'),
    unsupportedSerialization('__set_state(array $array): static', true),
  ];
}

/** Initializes a DateTime from a string as php_date_initialize does, or reports why it cannot. */
export function initializeDate(object: PhpObject, text: string, zoneObject: Value): string | undefined {
  const zone = zoneObject instanceof PhpObject ? zoneOf(zoneObject) : defaultZone();
  const result = momentFromString(text, zone);
  if ('sse' in result) {
    setMoment(object, result);
    return undefined;
  }
  return parseFailure(text, result);
}

/** Parses with a format as createFromFormat does, returning undefined when the string does not match. */
export function momentFromFormat(format: string, text: string, zoneObject: Value): Moment | undefined {
  const parsed = parseFromFormat(format, text);
  setLastErrors(parsed);
  if (parsed.errors.length > 0) return undefined;
  const zone = zoneObject instanceof PhpObject ? zoneOf(zoneObject) : defaultZone();
  return resolveParsed(parsed, nowIn(zone), true);
}

/** Applies a modify() string, returning the failure message when it does not parse. */
export function modifyDate(moment: Moment, text: string): Moment | string {
  const parsed = parseOrReject(text);
  setLastErrors(parsed);
  if (parsed.errors.length > 0) return parseFailure(text, parsed);
  return modifyMoment(moment, parsed);
}

export function diffObjects(a: PhpObject, b: PhpObject, absolute: boolean): PhpObject {
  const result = diffMoments(momentOf(a), momentOf(b));
  if (absolute) result.invert = false;
  return newInterval(result, result.days);
}

type Mutation = (moment: Moment, args: Value[], method: string) => Moment;

const n = (value: Value): number => Number(value as bigint);

const MUTATIONS: [string, Mutation][] = [
  ['add(DateInterval $interval)', (moment, args, method) => applyInterval(moment, args[0] as PhpObject, 1, method)],
  ['sub(DateInterval $interval)', (moment, args, method) => applyInterval(moment, args[0] as PhpObject, -1, method)],
  ['setTimezone(DateTimeZone $timezone)', (moment, args) => ({ ...moment, zone: zoneOf(args[0] as PhpObject) })],
  [
    'setTime(int $hour, int $minute, int $second = 0, int $microsecond = 0)',
    (moment, args) => {
      const t = localTime(moment);
      return updateMoment(
        { ...t, h: n(args[0]), i: n(args[1]), s: n(args[2] ?? 0n), us: n(args[3] ?? 0n) },
        emptyRelative(),
        false,
        moment.zone
      );
    },
  ],
  [
    'setDate(int $year, int $month, int $day)',
    (moment, args) =>
      updateMoment(
        { ...localTime(moment), y: n(args[0]), m: n(args[1]), d: n(args[2]) },
        emptyRelative(),
        false,
        moment.zone
      ),
  ],
  [
    'setISODate(int $year, int $week, int $dayOfWeek = 1)',
    (moment, args) => {
      const y = n(args[0]);
      const relative = { ...emptyRelative(), d: dayFromIsoWeek(y, n(args[1]), n(args[2] ?? 1n)) };
      return updateMoment({ ...localTime(moment), y, m: 1, d: 1 }, relative, true, moment.zone);
    },
  ],
  ['setTimestamp(int $timestamp)', (moment, args) => ({ sse: timestampSeconds(args[0]), us: 0, zone: moment.zone })],
  [
    'setMicrosecond(int $microsecond)',
    (moment, args, method) => {
      const us = n(args[0]);
      if (us < 0 || us > 999_999)
        throwError(
          'DateRangeError',
          `${method}(): Argument #1 ($microsecond) must be between 0 and 999999, ${us} given`
        );
      return { ...moment, us };
    },
  ],
];

function dateMethods(className: 'DateTime' | 'DateTimeImmutable'): NativeMethod[] {
  const immutable = className === 'DateTimeImmutable';
  const mutate = (thisObj: PhpObject, moment: Moment): PhpObject => {
    if (!immutable) {
      setMoment(thisObj, moment);
      return thisObj;
    }
    return newDateObject(thisObj.cls, moment);
  };
  return [
    {
      signature: '__construct(string $datetime = "now", ?DateTimeZone $timezone = null)',
      impl: ({ thisObj, args }) => {
        const failure = initializeDate(thisObj, (args[0] as string | undefined) ?? 'now', args[1] ?? null);
        if (failure) throwError('DateMalformedStringException', failure);
        return null;
      },
    },
    ...serializationMethods(),
    {
      signature: `createFromFormat(string $format, string $datetime, ?DateTimeZone $timezone = null): ${className}|false`,
      isStatic: true,
      impl: ({ args, calledClass }) => {
        const moment = momentFromFormat(args[0] as string, args[1] as string, args[2] ?? null);
        return moment ? newDateObject(calledClass as PhpClass, moment) : false;
      },
    },
    {
      signature: `createFromInterface(DateTimeInterface $object): static`,
      isStatic: true,
      impl: ({ args, calledClass }) => newDateObject(calledClass as PhpClass, { ...momentOf(args[0] as PhpObject) }),
    },
    {
      signature: immutable
        ? 'createFromMutable(DateTime $object): static'
        : 'createFromImmutable(DateTimeImmutable $object): static',
      isStatic: true,
      impl: ({ args, calledClass }) => newDateObject(calledClass as PhpClass, { ...momentOf(args[0] as PhpObject) }),
    },
    { signature: 'getLastErrors(): array|false', isStatic: true, impl: () => getLastErrors() },
    {
      signature: 'format(string $format): string',
      impl: ({ thisObj, args }) => formatMoment(momentOf(thisObj), args[0] as string),
    },
    {
      signature: `modify(string $modifier): ${className}`,
      impl: ({ thisObj, args }) => {
        const result = modifyDate(momentOf(thisObj), args[0] as string);
        if (typeof result === 'string') throwError('DateMalformedStringException', `${className}::modify(): ${result}`);
        return mutate(thisObj, result);
      },
    },
    ...MUTATIONS.map(([signature, change]): NativeMethod => ({
      signature: `${signature}: ${className}`,
      impl: ({ thisObj, args }) => {
        const method = `${className}::${signature.slice(0, signature.indexOf('('))}`;
        return mutate(thisObj, change(momentOf(thisObj), args, method));
      },
    })),
    {
      signature: 'getTimezone(): DateTimeZone|false',
      impl: ({ thisObj }) => newZoneObject(momentOf(thisObj).zone),
    },
    {
      signature: 'getOffset(): int',
      impl: ({ thisObj }) => {
        const moment = momentOf(thisObj);
        return BigInt(zoneInfo(moment.zone, moment.sse).offset);
      },
    },
    { signature: 'getTimestamp(): int', impl: ({ thisObj }) => BigInt(momentOf(thisObj).sse) },
    { signature: 'getMicrosecond(): int', impl: ({ thisObj }) => BigInt(momentOf(thisObj).us) },
    {
      signature: 'diff(DateTimeInterface $targetObject, bool $absolute = false): DateInterval',
      impl: ({ thisObj, args }) => diffObjects(thisObj, args[0] as PhpObject, args[1] === true),
    },
  ];
}

function compareDates(a: PhpObject, b: PhpObject): number {
  return compareMoments(momentOf(a), momentOf(b));
}

const DATE_FORMATS: Record<string, string> = {
  ATOM: String.raw`Y-m-d\TH:i:sP`,
  COOKIE: 'l, d-M-Y H:i:s T',
  ISO8601: String.raw`Y-m-d\TH:i:sO`,
  ISO8601_EXPANDED: String.raw`X-m-d\TH:i:sP`,
  RFC822: 'D, d M y H:i:s O',
  RFC850: 'l, d-M-y H:i:s T',
  RFC1036: 'D, d M y H:i:s O',
  RFC1123: 'D, d M Y H:i:s O',
  RFC7231: String.raw`D, d M Y H:i:s \G\M\T`,
  RFC2822: 'D, d M Y H:i:s O',
  RFC3339: String.raw`Y-m-d\TH:i:sP`,
  RFC3339_EXTENDED: String.raw`Y-m-d\TH:i:s.vP`,
  RSS: 'D, d M Y H:i:s O',
  W3C: String.raw`Y-m-d\TH:i:sP`,
};
for (const [name, format] of Object.entries(DATE_FORMATS))
  defineConstant(
    `DATE_${name}`,
    format,
    name === 'RFC7231'
      ? 'Constant DATE_RFC7231 is deprecated since 8.5, as this format ignores the associated timezone and always uses GMT'
      : undefined
  );

defineClass({ name: 'DateError', parent: 'Error' });
defineClass({ name: 'DateObjectError', parent: 'DateError' });
defineClass({ name: 'DateRangeError', parent: 'DateError' });
defineClass({ name: 'DateException', parent: 'Exception' });
for (const name of [
  'DateInvalidTimeZoneException',
  'DateInvalidOperationException',
  'DateMalformedStringException',
  'DateMalformedIntervalStringException',
  'DateMalformedPeriodStringException',
])
  defineClass({ name, parent: 'DateException' });

defineClass({
  name: 'DateTimeInterface',
  kind: 'interface',
  consts: DATE_FORMATS,
  methods: [
    'format(string $format): string',
    'getTimezone(): DateTimeZone|false',
    'getOffset(): int',
    'getTimestamp(): int',
    'getMicrosecond(): int',
    'diff(DateTimeInterface $targetObject, bool $absolute = false): DateInterval',
    '__wakeup(): void',
    '__serialize(): array',
    '__unserialize(array $data): void',
  ].map((signature) => ({ signature, impl: () => null, isAbstract: true })),
});
for (const name of ['DateTime', 'DateTimeImmutable'] as const)
  defineClass({
    name,
    interfaces: ['DateTimeInterface'],
    methods: dateMethods(name),
    createInternal: () => new DateState(),
    compare: compareDates,
  });

// DateTimeZone ---------------------------------------------------------------------------------------------------------

const ZONE_GROUPS: Record<string, bigint> = {
  AFRICA: 1n,
  AMERICA: 2n,
  ANTARCTICA: 4n,
  ARCTIC: 8n,
  ASIA: 16n,
  ATLANTIC: 32n,
  AUSTRALIA: 64n,
  EUROPE: 128n,
  INDIAN: 256n,
  PACIFIC: 512n,
  UTC: 1024n,
  ALL: 2047n,
  ALL_WITH_BC: 4095n,
  PER_COUNTRY: 4096n,
};

const unsupportedZoneMethod = (signature: string, isStatic = false): NativeMethod => ({
  signature,
  isStatic,
  impl: () => {
    throw new UnsupportedFeatureError(`DateTimeZone::${signature.slice(0, signature.indexOf('('))}`);
  },
});

defineClass({
  name: 'DateTimeZone',
  consts: ZONE_GROUPS,
  methods: [
    {
      signature: '__construct(string $timezone)',
      impl: ({ thisObj, args }) => {
        const zone = zoneFromName(args[0] as string);
        if (typeof zone === 'string')
          throwError('DateInvalidTimeZoneException', `DateTimeZone::__construct(): ${zone}`);
        (thisObj.internal as ZoneState).zone = zone;
        return null;
      },
    },
    { signature: 'getName(): string', impl: ({ thisObj }) => zoneName(zoneOf(thisObj)) },
    {
      signature: 'getOffset(DateTimeInterface $datetime): int',
      impl: ({ thisObj, args }) => BigInt(zoneInfo(zoneOf(thisObj), momentOf(args[0] as PhpObject).sse).offset),
    },
    unsupportedZoneMethod(
      'getTransitions(int $timestampBegin = PHP_INT_MIN, int $timestampEnd = PHP_INT_MAX): array|false'
    ),
    unsupportedZoneMethod('getLocation(): array|false'),
    unsupportedZoneMethod('listAbbreviations(): array', true),
    unsupportedZoneMethod(
      'listIdentifiers(int $timezoneGroup = DateTimeZone::ALL, ?string $countryCode = null): array',
      true
    ),
    ...serializationMethods(),
  ],
  createInternal: () => new ZoneState(),
});

/** The interval DateInterval::createFromDateString makes, or the message for a string that does not parse. */
export function intervalFromDateString(text: string): PhpObject | string {
  const parsed = parseOrReject(text);
  if (parsed.errors.length > 0) {
    const [first] = parsed.errors;
    return `Unknown or bad format (${text}) at position ${first.position} (${first.character}): ${first.message}`;
  }
  const object = createObject(classNamed('DateInterval'));
  object.props.set('from_string', true);
  object.props.set('date_string', text);
  (object.internal as IntervalState).relative = parsed.relative;
  return object;
}

// DateInterval ---------------------------------------------------------------------------------------------------------

defineClass({
  name: 'DateInterval',
  methods: [
    {
      signature: '__construct(string $duration)',
      impl: ({ thisObj, args }) => {
        const fields = parseDuration(args[0] as string);
        if (!fields) throwError('DateMalformedIntervalStringException', `Unknown or bad format (${args[0] as string})`);
        setIntervalProps(thisObj, fields, false);
        return null;
      },
    },
    {
      signature: 'createFromDateString(string $datetime): DateInterval',
      isStatic: true,
      impl: ({ args }) => {
        const result = intervalFromDateString(args[0] as string);
        if (typeof result === 'string') throwError('DateMalformedIntervalStringException', result);
        return result;
      },
    },
    {
      signature: 'format(string $format): string',
      impl: ({ thisObj, args }) => {
        if (intervalState(thisObj).relative)
          throw new UnsupportedFeatureError('日付の文字列から作った DateInterval の format');
        return formatInterval(thisObj, args[0] as string);
      },
    },
    ...serializationMethods(),
  ],
  createInternal: () => new IntervalState(),
});

// DatePeriod -----------------------------------------------------------------------------------------------------------

const EXCLUDE_START_DATE = 1n;
const INCLUDE_END_DATE = 2n;

function periodOf(object: PhpObject): PeriodState {
  const state = object.internal as { period?: PeriodState } | undefined;
  if (!state?.period) notInitialized(object.cls);
  return state.period;
}

function advance(moment: Moment, interval: IntervalCopy): Moment {
  const relative = interval.state.relative ?? { ...emptyRelative(), ...intervalFields(interval) };
  return updateMoment(localTime(moment), relative, true, moment.zone);
}

function copyInterval(object: PhpObject): IntervalCopy {
  return {
    props: [...object.props].map(([key, slot]) => [key, slot instanceof Ref ? slot.v : (slot as Value)]),
    state: intervalState(object).clone(),
  };
}

function intervalFromCopy(copy: IntervalCopy): PhpObject {
  const interval = createObject(classNamed('DateInterval'));
  for (const [key, value] of copy.props) interval.props.set(key, value);
  interval.internal = copy.state.clone();
  return interval;
}

/** The dates a period yields, in order, made as the iteration reaches them. */
function periodDates(period: PeriodState): Moment[] {
  const dates: Moment[] = [];
  let current = period.start;
  if (!period.includeStart) current = advance(current, period.interval);
  for (;;) {
    if (period.end) {
      const order = compareMoments(current, period.end);
      if (order > 0 || (order === 0 && !period.includeEnd)) break;
    } else if (dates.length >= period.recurrences) break;
    dates.push(current);
    current = advance(current, period.interval);
  }
  return dates;
}

/** An InternalIterator over a period's dates, which makes each DateTime object when the iteration reaches it. */
function periodIterator(owner: PhpObject, exposed: boolean): PhpObject {
  const period = periodOf(owner);
  const dates = periodDates(period);
  return internalIterator(
    owner,
    {
      count: () => dates.length,
      at: (position) => {
        if (position >= dates.length) return;
        period.current = advance(dates[position], period.interval);
        return newDateObject(period.startClass, { ...dates[position] });
      },
    },
    exposed
  );
}

class PeriodHolder {
  constructor(public period?: PeriodState) {}

  /** The iterator foreach uses, which PHP makes without an InternalIterator wrapper. */
  fixedIterator(owner: PhpObject): PhpObject {
    return periodIterator(owner, false);
  }

  clone(): PeriodHolder {
    return new PeriodHolder(this.period && { ...this.period });
  }

  debugEntries(): [Key, Value][] {
    const period = this.period;
    if (!period) return [];
    const dateObject = (moment: Moment | undefined): Value =>
      moment ? newDateObject(period.startClass, { ...moment }) : null;
    return [
      ['start', dateObject(period.start)],
      ['current', dateObject(period.current)],
      ['end', dateObject(period.end)],
      ['interval', intervalFromCopy(period.interval)],
      ['recurrences', BigInt(period.recurrences)],
      ['include_start_date', period.includeStart],
      ['include_end_date', period.includeEnd],
    ];
  }

  properties(): PhpArray {
    const array = new PhpArray();
    for (const [key, value] of this.debugEntries()) array.set(key, value);
    return array;
  }
}

defineClass({
  name: 'DatePeriod',
  interfaces: ['IteratorAggregate'],
  consts: { EXCLUDE_START_DATE, INCLUDE_END_DATE },
  methods: [
    {
      signature: '__construct(mixed $start, mixed $interval = null, mixed $end = null, mixed $options = null)',
      impl: ({ thisObj, args }) => {
        const [start, interval, end, options] = args;
        if (typeof start === 'string') throw new UnsupportedFeatureError('ISO 8601 の文字列で作る DatePeriod');
        if (!(start instanceof PhpObject) || !(interval instanceof PhpObject))
          throwError(
            'TypeError',
            'DatePeriod::__construct() accepts (DateTimeInterface, DateInterval, int [, int]), or (DateTimeInterface, DateInterval, DateTime [, int]), or (string [, int]) as arguments'
          );
        const flags = typeof options === 'bigint' ? options : 0n;
        const endMoment = end instanceof PhpObject ? { ...momentOf(end) } : undefined;
        const recurrences = typeof end === 'bigint' ? Number(end) : 0;
        if (!endMoment && recurrences < 1)
          throwError(
            'DateMalformedPeriodStringException',
            `DatePeriod::__construct(): Recurrence count must be greater than 0`
          );
        const includeStart = (flags & EXCLUDE_START_DATE) === 0n;
        (thisObj.internal as PeriodHolder).period = {
          start: { ...momentOf(start) },
          startClass: start.cls,
          current: undefined,
          end: endMoment,
          interval: copyInterval(interval),
          recurrences: endMoment ? 1 : recurrences + (includeStart ? 1 : 0),
          includeStart,
          includeEnd: (flags & INCLUDE_END_DATE) !== 0n,
        };
        return null;
      },
    },
    {
      signature: 'getIterator(): Iterator',
      impl: ({ thisObj }) => periodIterator(thisObj, true),
    },
    {
      signature: 'getStartDate(): DateTimeInterface',
      impl: ({ thisObj }) => newDateObject(periodOf(thisObj).startClass, { ...periodOf(thisObj).start }),
    },
    {
      signature: 'getEndDate(): ?DateTimeInterface',
      impl: ({ thisObj }) => {
        const period = periodOf(thisObj);
        return period.end ? newDateObject(period.startClass, { ...period.end }) : null;
      },
    },
    {
      signature: 'getDateInterval(): DateInterval',
      impl: ({ thisObj }) => intervalFromCopy(periodOf(thisObj).interval),
    },
    {
      signature: 'getRecurrences(): ?int',
      impl: ({ thisObj }) => {
        const period = periodOf(thisObj);
        const count = period.recurrences - (period.includeStart ? 1 : 0);
        return period.end || count === 0 ? null : BigInt(count);
      },
    },
    ...serializationMethods(),
  ],
  createInternal: () => new PeriodHolder(),
});

export { applyInterval, formatInterval };
