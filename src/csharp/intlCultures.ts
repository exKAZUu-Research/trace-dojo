import type { Culture, CultureDatePattern, NumberPatterns, NumberSymbols } from './cultures';
import {
  CURRENCY_NEGATIVE_PATTERNS,
  CURRENCY_POSITIVE_PATTERNS,
  NUMBER_NEGATIVE_PATTERNS,
  PERCENT_NEGATIVE_PATTERNS,
  PERCENT_POSITIVE_PATTERNS,
} from './format';

/**
 * The cultures other than ja-JP and the invariant one, built from the host's `Intl` data, which comes from ICU and
 * CLDR as .NET's does: the number symbols and patterns from `Intl.NumberFormat`'s parts, the date patterns from
 * `Intl.DateTimeFormat`'s parts of a sample date, and the names from `Intl.DisplayNames`. `Intl` cannot say which
 * currency a region uses, so {@link CURRENCIES} does.
 */

/**
 * The currency of each region a culture may name, which `Intl` has no API for: ISO 4217 codes by ISO 3166 region.
 * A culture of a region missing here is not available.
 */
const CURRENCIES = new Map(
  (
    'US:USD GB:GBP JP:JPY CN:CNY TW:TWD HK:HKD MO:MOP KR:KRW IN:INR PK:PKR BD:BDT LK:LKR NP:NPR ID:IDR MY:MYR ' +
    'SG:SGD TH:THB VN:VND PH:PHP KH:KHR MN:MNT KZ:KZT AU:AUD NZ:NZD CA:CAD MX:MXN BR:BRL AR:ARS CL:CLP CO:COP ' +
    'PE:PEN UY:UYU PY:PYG BO:BOB EC:USD CR:CRC PA:PAB GT:GTQ DO:DOP PR:USD AT:EUR BE:EUR CY:EUR DE:EUR EE:EUR ' +
    'ES:EUR FI:EUR FR:EUR GR:EUR HR:EUR IE:EUR IT:EUR LT:EUR LU:EUR LV:EUR MT:EUR NL:EUR PT:EUR SI:EUR SK:EUR ' +
    'MC:EUR CH:CHF LI:CHF NO:NOK SE:SEK DK:DKK IS:ISK PL:PLN CZ:CZK HU:HUF RO:RON RS:RSD UA:UAH RU:RUB GE:GEL ' +
    'TR:TRY IL:ILS JO:JOD IR:IRR SA:SAR AE:AED QA:QAR KW:KWD EG:EGP MA:MAD DZ:DZD TN:TND KE:KES NG:NGN ZA:ZAR'
  )
    .split(' ')
    .map((entry) => entry.split(':') as [string, string])
);

/** The currency of a culture without a region, whose symbol is `¤`. */
const NO_CURRENCY = 'XXX';

/** A date whose day, month, hour, minute, and second each take one digit, so that patterns tell `d` from `dd`. */
const SAMPLE = Date.UTC(2024, 2, 5, 9, 7, 9);
const DAY = 86_400_000;
/** 2024-03-03, a Sunday, which .NET's day names start from. */
const SUNDAY = Date.UTC(2024, 2, 3, 12);

const cultures = new Map<string, Culture | 'invalid' | undefined>();

/** The culture of a name, which .NET reads ignoring case, built once per name. */
export function intlCulture(name: string): Culture | 'invalid' | undefined {
  const key = name.toLowerCase();
  if (!cultures.has(key)) cultures.set(key, buildCulture(name));
  return cultures.get(key);
}

/** The names .NET accepts: letters, digits, and single hyphens or underscores between them, of two or more characters. */
function isCultureIdentifier(name: string): boolean {
  return name.length > 1 && /^[A-Za-z\d]+(?:[-_][A-Za-z\d]+)*$/.test(name);
}

/**
 * The culture of a language, a script, and a region that `Intl` knows, or undefined for a name with other parts
 * (variants, extensions) or that `Intl` would read as another culture's, whose data .NET's ICU makes up.
 */
function buildCulture(name: string): Culture | 'invalid' | undefined {
  if (!isCultureIdentifier(name)) return 'invalid';
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-[A-Za-z]{2})?$/.test(name)) return undefined;
  let locale: Intl.Locale;
  try {
    locale = new Intl.Locale(name);
  } catch {
    return undefined;
  }
  const canonical = locale.toString();
  const isKnown =
    Intl.NumberFormat.supportedLocalesOf([canonical], { localeMatcher: 'lookup' }).length > 0 &&
    Intl.DateTimeFormat.supportedLocalesOf([canonical], { localeMatcher: 'lookup' }).length > 0;
  const region = locale.region;
  const currency = region === undefined ? NO_CURRENCY : CURRENCIES.get(region);
  if (!isKnown || currency === undefined || !knowsRegion(region)) return undefined;
  return { ...cultureNames(canonical, locale), ...numberData(canonical, currency), ...dateData(canonical) };
}

function knowsRegion(region: string | undefined): boolean {
  return (
    region === undefined || new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }).of(region) !== undefined
  );
}

// ---- Names ----

type CultureNames = Pick<
  Culture,
  'name' | 'displayName' | 'englishName' | 'nativeName' | 'twoLetterIsoLanguageName' | 'isInvariant'
>;

function cultureNames(name: string, locale: Intl.Locale): CultureNames {
  return {
    name,
    // .NET names a culture in the user interface's language, ja-JP's.
    displayName: displayName(name, locale, 'ja'),
    englishName: displayName(name, locale, 'en'),
    nativeName: displayName(name, locale, name),
    twoLetterIsoLanguageName: locale.language,
    isInvariant: false,
  };
}

/**
 * A culture's name in a language, as ICU's `uloc_getDisplayName` gives it: the language and the region's full name,
 * where `Intl.DisplayNames` may put a region's short name (`English (US)`).
 */
function displayName(name: string, locale: Intl.Locale, inLanguage: string): string {
  const text = new Intl.DisplayNames([inLanguage], { type: 'language', languageDisplay: 'standard' }).of(name) ?? name;
  if (locale.region === undefined) return text;
  const regionLong = new Intl.DisplayNames([inLanguage], { type: 'region' }).of(locale.region);
  const regionShort = new Intl.DisplayNames([inLanguage], { type: 'region', style: 'short' }).of(locale.region);
  if (regionLong === undefined || regionShort === undefined || text.includes(regionLong)) return text;
  // The region's name comes last, after the language's, which may contain it (한국어 has 한국).
  const at = text.lastIndexOf(regionShort);
  return at === -1 ? text : text.slice(0, at) + regionLong + text.slice(at + regionShort.length);
}

// ---- Numbers ----

type NumberData = Pick<
  Culture,
  'numberDecimalDigits' | 'percentDecimalDigits' | 'currencyDecimalDigits' | 'currencySymbol' | 'symbols' | 'patterns'
>;

/** The bidirectional marks that ICU writes around signs and symbols: ALM, LRM, and RLM. */
const BIDI_MARKS = /^[\u061C\u200E\u200F]+$/;

/** A part's value with the bidirectional marks that `Intl` writes as literals next to it, as ICU's symbol has them. */
function partWithMarks(parts: Intl.NumberFormatPart[], type: string, side: 'before' | 'after'): string | undefined {
  const index = parts.findIndex((part) => part.type === type);
  if (index === -1) return undefined;
  const neighbor = parts[side === 'before' ? index - 1 : index + 1];
  const marks = neighbor?.type === 'literal' && BIDI_MARKS.test(neighbor.value) ? neighbor.value : '';
  return side === 'before' ? marks + parts[index].value : parts[index].value + marks;
}

function numberData(locale: string, currency: string): NumberData {
  const decimal = new Intl.NumberFormat(locale);
  const grouped = decimal.formatToParts(-1_234_567_890.5);
  const percent = new Intl.NumberFormat(locale, { style: 'percent' });
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency });
  const moneyParts = money.formatToParts(1_234_567.5);
  const negativeSign = partWithMarks(grouped, 'minusSign', 'before') ?? '-';
  const symbols: NumberSymbols = {
    decimalSeparator: grouped.find((part) => part.type === 'decimal')?.value ?? '.',
    groupSeparator: grouped.find((part) => part.type === 'group')?.value ?? ',',
    groupSizes: groupSizesOf(grouped),
    negativeSign,
    positiveSign:
      partWithMarks(new Intl.NumberFormat(locale, { signDisplay: 'always' }).formatToParts(1), 'plusSign', 'before') ??
      '+',
    nan: decimal.format(Number.NaN),
    positiveInfinity: decimal.format(Number.POSITIVE_INFINITY),
    negativeInfinity: `${negativeSign}${decimal.format(Number.POSITIVE_INFINITY)}`,
    percentSymbol: partWithMarks(percent.formatToParts(0.5), 'percentSign', 'after') ?? '%',
    // `Intl` writes no per mille sign.
    perMilleSymbol: '‰',
  };
  const digits = decimal.resolvedOptions().maximumFractionDigits ?? 3;
  return {
    numberDecimalDigits: digits,
    // .NET's ICU data give percentages the decimal digits of numbers.
    percentDecimalDigits: digits,
    currencyDecimalDigits: money.resolvedOptions().maximumFractionDigits ?? 2,
    currencySymbol: partWithMarks(moneyParts, 'currency', 'after') ?? '¤',
    symbols,
    patterns: numberPatterns(decimal, percent, money),
  };
}

/** The group sizes of a long number's integer, from the decimal point leftward: `[3]`, or `[3, 2]` for hi-IN. */
function groupSizesOf(parts: Intl.NumberFormatPart[]): number[] {
  const groups = parts.filter((part) => part.type === 'integer').map((part) => part.value.length);
  if (groups.length < 3) return [3];
  const primary = groups.at(-1) as number;
  const secondary = groups.at(-2) as number;
  return primary === secondary ? [primary] : [primary, secondary];
}

/**
 * The indexes of .NET's patterns that a culture's formats match, as .NET reads ICU's patterns: the digits as `n`, the
 * currency symbol as `$`, white space as one space, and the signs and percent sign as themselves.
 */
function numberPatterns(
  decimal: Intl.NumberFormat,
  percent: Intl.NumberFormat,
  money: Intl.NumberFormat
): NumberPatterns {
  return {
    numberNegative: patternIndex(NUMBER_NEGATIVE_PATTERNS, decimal.formatToParts(-1), 1),
    currencyPositive: patternIndex(CURRENCY_POSITIVE_PATTERNS, money.formatToParts(1), 0),
    currencyNegative: patternIndex(CURRENCY_NEGATIVE_PATTERNS, money.formatToParts(-1), 0),
    percentPositive: patternIndex(PERCENT_POSITIVE_PATTERNS, percent.formatToParts(1), 0),
    percentNegative: patternIndex(PERCENT_NEGATIVE_PATTERNS, percent.formatToParts(-1), 0),
  };
}

/** The index of the pattern that a sample's parts match, or the fallback that .NET takes for none. */
function patternIndex(patterns: readonly string[], parts: Intl.NumberFormatPart[], fallback: number): number {
  const found = patterns.indexOf(patternOf(parts));
  return found === -1 ? fallback : found;
}

function patternOf(parts: Intl.NumberFormatPart[]): string {
  let pattern = '';
  for (const { type, value } of parts) {
    let symbol: string;
    if (type === 'integer' || type === 'group' || type === 'decimal' || type === 'fraction') symbol = 'n';
    else if (type === 'minusSign') symbol = '-';
    else if (type === 'currency') symbol = '$';
    else if (type === 'percentSign') symbol = '%';
    else symbol = value.replaceAll(/[^\s()]/g, '').replaceAll(/\s+/g, ' ');
    if (!(symbol === 'n' && pattern.endsWith('n'))) pattern += symbol;
  }
  return pattern;
}

// ---- Dates ----

type DateData = Pick<
  Culture,
  | 'otherCalendar'
  | 'datePatterns'
  | 'dateSeparator'
  | 'timeSeparator'
  | 'dayNames'
  | 'abbreviatedDayNames'
  | 'monthNames'
  | 'abbreviatedMonthNames'
  | 'monthGenitiveNames'
  | 'abbreviatedMonthGenitiveNames'
  | 'amDesignator'
  | 'pmDesignator'
  | 'era'
>;

/** The names of a date's weekday, month, and day period, which tell what a pattern's parts are. */
interface DateNames {
  dayNames: readonly string[];
  abbreviatedDayNames: readonly string[];
  longMonths: ReadonlySet<string>;
  shortMonths: ReadonlySet<string>;
}

function dateData(locale: string): DateData {
  const format = (options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat =>
    new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC', numberingSystem: 'latn', calendar: 'gregory' });
  const calendar = new Intl.DateTimeFormat(locale).resolvedOptions().calendar;
  const days = (weekday: 'long' | 'short'): string[] =>
    Array.from({ length: 7 }, (_day, index) => format({ weekday }).format(SUNDAY + index * DAY));
  const months = (month: 'long' | 'short', withDay: boolean): string[] =>
    Array.from({ length: 12 }, (_month, index) => {
      const parts = format(withDay ? { month, day: 'numeric' } : { month }).formatToParts(Date.UTC(2024, index, 15));
      return parts.find((part) => part.type === 'month')?.value ?? '';
    });
  const monthNames = months('long', false);
  const abbreviatedMonthNames = months('short', false);
  // A language that writes a month as its number beside a day (zh's `11月5日`) has no form of the name for it.
  const withDay = (month: 'long' | 'short', names: string[]): string[] => {
    const forms = months(month, true);
    return forms.some((form) => /^\d+$/.test(form)) ? names : forms;
  };
  const monthGenitiveNames = withDay('long', monthNames);
  const abbreviatedMonthGenitiveNames = withDay('short', abbreviatedMonthNames);
  const names: DateNames = {
    dayNames: days('long'),
    abbreviatedDayNames: days('short'),
    longMonths: new Set([...monthNames, ...monthGenitiveNames]),
    shortMonths: new Set([...abbreviatedMonthNames, ...abbreviatedMonthGenitiveNames]),
  };
  const pattern = (options: Intl.DateTimeFormatOptions): string => {
    const formatter = format(options);
    return datePatternOf(formatter.formatToParts(SAMPLE), names, formatter.resolvedOptions().hourCycle);
  };
  // .NET writes a short date's year with four digits, as ICU's two-digit `yy` would not round-trip.
  const shortDate = pattern({ dateStyle: 'short' }).replace(/(?<!y)yy(?!y)/, 'yyyy');
  const longDate = pattern({ dateStyle: 'full' });
  const shortTime = pattern({ timeStyle: 'short' });
  const longTime = pattern({ timeStyle: 'medium' });
  const monthDay = pattern({ month: 'long', day: 'numeric' });
  const yearMonth = pattern({ year: 'numeric', month: 'long' });
  const datePatterns: Record<CultureDatePattern, string> = {
    d: shortDate,
    D: longDate,
    f: `${longDate} ${shortTime}`,
    F: `${longDate} ${longTime}`,
    g: `${shortDate} ${shortTime}`,
    G: `${shortDate} ${longTime}`,
    m: monthDay,
    M: monthDay,
    t: shortTime,
    T: longTime,
    y: yearMonth,
    Y: yearMonth,
  };
  const dayPeriod = (hour: number): string =>
    format({ hour: 'numeric', hour12: true })
      .formatToParts(Date.UTC(2024, 2, 5, hour))
      .find((part) => part.type === 'dayPeriod')?.value ?? '';
  return {
    otherCalendar: calendar === 'gregory' ? undefined : calendar,
    datePatterns,
    dateSeparator: separatorOf(shortDate, 'dMy'),
    timeSeparator: separatorOf(longTime, 'Hhms'),
    dayNames: names.dayNames,
    abbreviatedDayNames: names.abbreviatedDayNames,
    monthNames,
    abbreviatedMonthNames,
    monthGenitiveNames,
    abbreviatedMonthGenitiveNames,
    amDesignator: dayPeriod(9),
    pmDesignator: dayPeriod(21),
    era:
      format({ era: 'short', year: 'numeric' })
        .formatToParts(SAMPLE)
        .find((part) => part.type === 'era')?.value ?? '',
  };
}

/** The .NET custom format of a sample date's parts, such as `M/d/yyyy` from `3/5/2024`. */
function datePatternOf(parts: Intl.DateTimeFormatPart[], names: DateNames, hourCycle: string | undefined): string {
  return parts.map((part) => partPattern(part, names, hourCycle)).join('');
}

/** The specifiers that a part stands for whatever its value is. */
const FIXED_PATTERNS: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {
  minute: 'mm',
  second: 'ss',
  dayPeriod: 'tt',
  era: 'g',
};

function partPattern(
  { type, value }: Intl.DateTimeFormatPart,
  names: DateNames,
  hourCycle: string | undefined
): string {
  const fixed = FIXED_PATTERNS[type];
  if (fixed !== undefined) return fixed;
  switch (type) {
    case 'year': {
      return value.length >= 4 ? 'yyyy' : 'y'.repeat(value.length);
    }
    case 'month': {
      return monthPattern(value, names);
    }
    case 'day': {
      return 'd'.repeat(value.length);
    }
    case 'weekday': {
      return names.dayNames.includes(value) ? 'dddd' : 'ddd';
    }
    case 'hour': {
      return (hourCycle === 'h11' || hourCycle === 'h12' ? 'h' : 'H').repeat(value.length);
    }
    default: {
      return escapedLiteral(value);
    }
  }
}

/** A month's number as `M` or `MM`, and its name as `MMMM`, or `MMM` when only the abbreviated names have it. */
function monthPattern(value: string, names: DateNames): string {
  if (/^\d+$/.test(value)) return 'M'.repeat(value.length);
  return names.longMonths.has(value) || !names.shortMonths.has(value) ? 'MMMM' : 'MMM';
}

/** A literal of a pattern, with the characters that a .NET custom format would read escaped. */
function escapedLiteral(text: string): string {
  return text.replaceAll(/[A-Za-z'"\\%]/g, (char) => `\\${char}`);
}

/**
 * The separator after a pattern's first field among some letters and before the next, as .NET takes a culture's date
 * and time separators from its short date and long time patterns.
 */
function separatorOf(pattern: string, letters: string): string {
  const isField = (char: string): boolean => letters.includes(char);
  let index = 0;
  while (index < pattern.length && !isField(pattern[index])) index++;
  if (index === pattern.length) return '';
  const field = pattern[index];
  while (pattern[index] === field) index++;
  const start = index;
  while (index < pattern.length && !isField(pattern[index])) index++;
  if (index >= pattern.length) return '';
  return pattern.slice(start, index).replaceAll(/\\(.)/g, '$1');
}
