import { dateFromEpochDays, epochDays, isValidDate, isValidTime, secondsToFields } from './dateCalendar';
import { DAY_NAMES, MONTH_NAMES } from './dateFormat';
import { emptyRelative, type ParsedTime, parseZoneName } from './dateParse';
import { UnsupportedFeatureError } from './unsupported';

const SEPARATORS = ';:/.,-()';

const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/** The state of timelib_parse_from_format while it walks the format and the string together. */
class FormatScanner {
  readonly t: ParsedTime = {
    haveTime: 0,
    haveDate: false,
    haveZone: 0,
    haveRelative: false,
    relative: emptyRelative(),
    errors: [],
    warnings: [],
  };
  ptr = 0;
  fptr = 0;
  /** Where the current format character's input starts, which its errors report. */
  begin = 0;
  allowExtra = false;

  constructor(
    readonly format: string,
    readonly text: string
  ) {}

  at(index = this.ptr): string {
    return this.text[index] ?? '\0';
  }

  error(message: string, position = this.begin): void {
    this.t.errors.push({ position, character: this.at(position), message });
  }

  warning(message: string, position = this.ptr): void {
    this.t.warnings.push({ position, character: this.at(position), message });
  }

  /** Reports TIMELIB_CHECK_NUMBER's error when the input does not start with a digit, and goes on as timelib does. */
  checkNumber(signed = false): void {
    const c = this.at();
    if (!isDigit(c) && !(signed && (c === '+' || c === '-'))) this.error('Unexpected data found.');
  }

  number(maxLength: number): { value: number | undefined; length: number } {
    while (!isDigit(this.at())) {
      if (this.ptr >= this.text.length) return { value: undefined, length: 0 };
      this.ptr++;
    }
    const start = this.ptr;
    while (isDigit(this.at()) && this.ptr - start < maxLength) this.ptr++;
    return { value: Number(this.text.slice(start, this.ptr)), length: this.ptr - start };
  }

  word(): string {
    const start = this.ptr;
    while (/[A-Za-z]/.test(this.at())) this.ptr++;
    return this.text.slice(start, this.ptr).toLowerCase();
  }

  resetFields(onlyUnset: boolean): void {
    const defaults = { y: 1970, m: 1, d: 1, h: 0, i: 0, s: 0, us: 0 } as const;
    for (const key of ['y', 'm', 'd', 'h', 'i', 's', 'us'] as const)
      if (!onlyUnset || this.t[key] === undefined) this.t[key] = defaults[key];
    if (!onlyUnset) {
      this.t.zone = undefined;
      this.t.haveZone = 0;
    }
  }

  /** Transcribes timelib_meridian_with_check: the hour adjustment of am or pm, or undefined when there is none. */
  // code-gauge-allow functionCognitiveComplexity -- Transcribes timelib_meridian_with_check in its order of checks.
  meridian(): number | undefined {
    while (this.ptr < this.text.length && !'AaPp'.includes(this.at())) this.ptr++;
    if (this.ptr >= this.text.length) return undefined;
    const hour = this.t.h ?? 0;
    const isAm = this.at() === 'a' || this.at() === 'A';
    const adjust = isAm ? (hour === 12 ? -12 : 0) : hour === 12 ? 0 : 12;
    this.ptr++;
    const isM = (): boolean => this.at() === 'm' || this.at() === 'M';
    if (this.at() === '.') {
      this.ptr++;
      if (!isM()) return undefined;
      this.ptr++;
      if (this.at() !== '.') return undefined;
      this.ptr++;
    } else if (isM()) this.ptr++;
    else return undefined;
    return adjust;
  }
}

type Handler = (s: FormatScanner, specifier: string) => void;

/** Reads a number of up to `maxLength` digits into a field, reporting `missing` when there is none. */
const numberField =
  (field: 'd' | 'm' | 'h', maxLength: number, missing: string): Handler =>
  (s) => {
    s.checkNumber();
    const { value } = s.number(maxLength);
    if (value === undefined) return s.error(missing);
    s.t[field] = value;
    if (field === 'h') s.t.haveTime = 1;
    else s.t.haveDate = true;
  };

const textualDay: Handler = (s) => {
  const start = s.ptr;
  while (s.ptr < s.text.length && !' ,\t;:/.-()'.includes(s.at())) s.ptr++;
  const name = s.text.slice(start, s.ptr).toLowerCase();
  const index = DAY_NAMES.findIndex((day) => {
    const lower = day.toLowerCase();
    return name === lower || name === `${lower}s` || name === lower.slice(0, 3);
  });
  if (index === -1) return s.error('A textual day could not be found');
  s.t.haveRelative = true;
  s.t.relative.haveWeekday = true;
  s.t.relative.weekday = index;
  s.t.relative.weekdayBehavior = 1;
};

const textualMonth: Handler = (s) => {
  const name = s.word();
  const index = MONTH_NAMES.findIndex(
    (month) => name === month.toLowerCase() || name === month.slice(0, 3).toLowerCase()
  );
  const month = index === -1 ? (name === 'sept' ? 9 : 0) : index + 1;
  if (month === 0) return s.error('A textual month could not be found');
  s.t.haveDate = true;
  s.t.m = month;
};

const twoDigitField =
  (field: 'i' | 's', missing: string): Handler =>
  (s) => {
    s.checkNumber();
    const { value, length } = s.number(2);
    if (value === undefined || length !== 2) return s.error(missing);
    s.t.haveTime = 1;
    s.t[field] = value;
  };

const fraction =
  (digits: number, missing: string): Handler =>
  (s) => {
    s.checkNumber();
    const start = s.ptr;
    const { value } = s.number(digits);
    if (value === undefined || s.ptr - start < 1) return s.error(missing);
    s.t.us = value * 10 ** (digits - (s.ptr - start)) * (digits === 3 ? 1000 : 1);
  };

const hour12: Handler = (s) => {
  s.checkNumber();
  const { value } = s.number(2);
  if (value === undefined) return s.error('A two digit hour could not be found');
  s.t.h = value;
  if (value > 12) return s.error('Hour cannot be higher than 12');
  s.t.haveTime = 1;
};

const zone: Handler = (s) => {
  const result = parseZoneName(s.text.slice(s.ptr));
  s.ptr = s.text.length - result.rest.length;
  if (result.kind === 'unknownAbbreviation')
    throw new UnsupportedFeatureError(`タイムゾーンの略称を含む日付と時刻の文字列（${s.text}）`);
  if (result.kind === 'notFound') return s.error('The timezone could not be found in the database');
  if (result.outOfRange) s.warning('The parsed timezone offset was invalid', s.begin);
  s.t.zone = result.zone;
  s.t.haveZone = 1;
};

const HANDLERS: Record<string, Handler> = {
  D: textualDay,
  l: textualDay,
  d: numberField('d', 2, 'A two digit day could not be found'),
  j: numberField('d', 2, 'A two digit day could not be found'),
  S: (s) => {
    if (!/^[ \t]/.test(s.at()) && /^(?:nd|rd|st|th)/i.test(s.text.slice(s.ptr))) s.ptr += 2;
  },
  z: (s) => {
    s.checkNumber();
    if (s.t.y === undefined) s.error("A 'day of year' can only come after a year has been found");
    const { value } = s.number(3);
    if (value === undefined) return s.error('A three digit day-of-year could not be found');
    if (s.t.y === undefined) return;
    s.t.haveDate = true;
    Object.assign(s.t, dateFromEpochDays(epochDays(s.t.y, 1, 1) + value));
  },
  m: numberField('m', 2, 'A two digit month could not be found'),
  n: numberField('m', 2, 'A two digit month could not be found'),
  M: textualMonth,
  F: textualMonth,
  y: (s) => {
    s.checkNumber();
    const { value } = s.number(2);
    if (value === undefined) return s.error('A two digit year could not be found');
    s.t.haveDate = true;
    s.t.y = value < 100 ? value + (value < 70 ? 2000 : 1900) : value;
  },
  Y: (s) => {
    s.checkNumber();
    const { value } = s.number(4);
    if (value === undefined) return s.error('A four digit year could not be found');
    s.t.y = value;
    s.t.haveDate = true;
  },
  g: hour12,
  h: hour12,
  G: numberField('h', 2, 'A two digit hour could not be found'),
  H: numberField('h', 2, 'A two digit hour could not be found'),
  a: meridian,
  A: meridian,
  i: twoDigitField('i', 'A two digit minute could not be found'),
  s: twoDigitField('s', 'A two digit second could not be found'),
  u: fraction(6, 'A six digit microsecond could not be found'),
  v: fraction(3, 'A three digit millisecond could not be found'),
  ' ': (s) => {
    while (s.at() === ' ' || s.at() === '\t') s.ptr++;
  },
  U: (s) => {
    s.checkNumber(true);
    let sign = 1;
    while (s.at() === '+' || s.at() === '-') {
      if (s.at() === '-') sign = -sign;
      s.ptr++;
    }
    const start = s.ptr;
    while (isDigit(s.at())) s.ptr++;
    s.t.haveZone = 1;
    s.t.zone = { type: 1, offset: 0 };
    Object.assign(s.t, secondsToFields(sign * Number(s.text.slice(start, s.ptr))));
  },
  '#': (s) => {
    if (s.ptr < s.text.length && SEPARATORS.includes(s.at())) s.ptr++;
    else s.error('The separation symbol ([;:/.,-]) could not be found');
  },
  '!': (s) => s.resetFields(false),
  '|': (s) => s.resetFields(true),
  '?': (s) => {
    s.ptr++;
  },
  '\\': (s) => {
    if (s.fptr + 1 >= s.format.length) return s.error('Escaped character expected');
    s.fptr++;
    if (s.at() === s.format[s.fptr]) s.ptr++;
    else s.error('The escaped character could not be found');
  },
  '*': (s) => {
    s.ptr++;
    while (s.ptr < s.text.length && !' \t.,:;/-0123456789'.includes(s.at())) s.ptr++;
  },
  '+': (s) => {
    s.allowExtra = true;
  },
  e: zone,
  P: zone,
  p: zone,
  T: zone,
  O: zone,
  x: expandedYear,
  X: expandedYear,
};

function meridian(s: FormatScanner): void {
  if (s.t.h === undefined) s.error('Meridian can only come after an hour has been found');
  const adjust = s.meridian();
  if (adjust === undefined) return s.error('A meridian could not be found');
  s.t.haveTime = 1;
  if (s.t.h !== undefined) s.t.h += adjust;
}

function expandedYear(_s: FormatScanner, specifier: string): never {
  throw new UnsupportedFeatureError(`createFromFormat の書式文字 ${specifier}`);
}

function literal(s: FormatScanner, specifier: string): void {
  if (SEPARATORS.includes(specifier)) {
    if (s.at() === specifier) s.ptr++;
    else s.error('The separation symbol could not be found');
    return;
  }
  if (s.at() !== specifier) s.error('The format separator does not match');
  s.ptr++;
}

/** Transcribes timelib_parse_from_format, the parser behind DateTime::createFromFormat. */
export function parseFromFormat(format: string, text: string): ParsedTime {
  const s = new FormatScanner(format, text);
  for (; s.fptr < format.length && s.ptr < text.length; s.fptr++) {
    s.begin = s.ptr;
    const specifier = format[s.fptr];
    (HANDLERS[specifier] ?? literal)(s, specifier);
  }
  if (s.ptr < text.length) {
    if (s.allowExtra) s.warning('Trailing data');
    else s.error('Trailing data', s.ptr);
  }
  for (; s.fptr < format.length; s.fptr++) {
    const specifier = format[s.fptr];
    if (specifier === '!' || specifier === '|') s.resetFields(specifier === '|');
    else if (specifier !== '+') {
      s.error('Not enough data available to satisfy format', s.ptr);
      break;
    }
  }
  return finish(s.t, s);
}

function finish(t: ParsedTime, s: FormatScanner): ParsedTime {
  if ([t.h, t.i, t.s, t.us].some((value) => value !== undefined)) {
    t.h ??= 0;
    t.i ??= 0;
    t.s ??= 0;
    t.us ??= 0;
  }
  if (t.h !== undefined && t.i !== undefined && t.s !== undefined && !isValidTime(t.h, t.i, t.s))
    s.warning('The parsed time was invalid');
  if (t.y !== undefined && t.m !== undefined && t.d !== undefined && !isValidDate(t.y, t.m, t.d))
    s.warning('The parsed date was invalid');
  return t;
}
