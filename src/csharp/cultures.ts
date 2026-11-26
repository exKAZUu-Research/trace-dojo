import { CompileError } from '../interpreter/diagnostics';
import { JAPANESE, ROOT } from './culture';
import { intlCulture } from './intlCultures';
import type { Runtime } from './runtime';
import { CsObject, type Value } from './values';

/** The standard date and time format letters whose patterns depend on the culture. */
export type CultureDatePattern = 'd' | 'D' | 'f' | 'F' | 'g' | 'G' | 'm' | 'M' | 't' | 'T' | 'y' | 'Y';

/** The symbols that numbers are written with, as a culture's `NumberFormatInfo` has them. */
export interface NumberSymbols {
  decimalSeparator: string;
  groupSeparator: string;
  /** The sizes of the digit groups from the decimal point leftward, the last repeating, such as `[3, 2]` for hi-IN. */
  groupSizes: readonly number[];
  negativeSign: string;
  positiveSign: string;
  nan: string;
  positiveInfinity: string;
  negativeInfinity: string;
  percentSymbol: string;
  perMilleSymbol: string;
}

/**
 * The patterns of signed numbers, as indexes into .NET's lists (`NumberFormatInfo.NumberNegativePattern` and the
 * like): see `NUMBER_NEGATIVE_PATTERNS` and its siblings in `format.ts`.
 */
export interface NumberPatterns {
  numberNegative: number;
  currencyPositive: number;
  currencyNegative: number;
  percentPositive: number;
  percentNegative: number;
}

/**
 * What formatting, parsing, and comparing need of a culture: ja-JP, the reference machine's culture (with ICU's
 * data), and the invariant culture are written out here, and any other culture is built from the host's `Intl` data
 * (see `intlCultures.ts`).
 */
export interface Culture {
  /** `CultureInfo.Name`, which is empty for the invariant culture. */
  name: string;
  displayName: string;
  englishName: string;
  nativeName: string;
  twoLetterIsoLanguageName: string;
  /** Whether strings compare by the invariant culture's collation, without ja-JP's tailoring. */
  isInvariant: boolean;
  numberDecimalDigits: number;
  percentDecimalDigits: number;
  currencyDecimalDigits: number;
  currencySymbol: string;
  symbols: NumberSymbols;
  patterns: NumberPatterns;
  /**
   * The calendar of a culture whose dates are not Gregorian, such as ar-SA's `islamic-umalqura`, whose dates this
   * grader cannot write or read.
   */
  otherCalendar?: string;
  datePatterns: Record<CultureDatePattern, string>;
  /** What the custom date format's `/` and `:` write. */
  dateSeparator: string;
  timeSeparator: string;
  dayNames: readonly string[];
  abbreviatedDayNames: readonly string[];
  monthNames: readonly string[];
  abbreviatedMonthNames: readonly string[];
  /** The months' names as a day's number goes with them, which some languages (ru-RU) inflect. */
  monthGenitiveNames: readonly string[];
  abbreviatedMonthGenitiveNames: readonly string[];
  amDesignator: string;
  pmDesignator: string;
  era: string;
}

const JAPANESE_MONTHS = Array.from({ length: 12 }, (_month, index) => `${index + 1}月`);

export const JA_JP: Culture = {
  name: 'ja-JP',
  displayName: '日本語（日本）',
  englishName: 'Japanese (Japan)',
  nativeName: '日本語（日本）',
  twoLetterIsoLanguageName: 'ja',
  isInvariant: false,
  numberDecimalDigits: 3,
  percentDecimalDigits: 3,
  currencyDecimalDigits: 0,
  currencySymbol: '¥',
  symbols: {
    decimalSeparator: '.',
    groupSeparator: ',',
    groupSizes: [3],
    negativeSign: '-',
    positiveSign: '+',
    nan: 'NaN',
    positiveInfinity: '∞',
    negativeInfinity: '-∞',
    percentSymbol: '%',
    perMilleSymbol: '‰',
  },
  patterns: { numberNegative: 1, currencyPositive: 0, currencyNegative: 1, percentPositive: 1, percentNegative: 1 },
  datePatterns: {
    d: 'yyyy/MM/dd',
    D: 'yyyy年M月d日 dddd',
    f: 'yyyy年M月d日 dddd H:mm',
    F: 'yyyy年M月d日 dddd H:mm:ss',
    g: 'yyyy/MM/dd H:mm',
    G: 'yyyy/MM/dd H:mm:ss',
    m: 'M月d日',
    M: 'M月d日',
    t: 'H:mm',
    T: 'H:mm:ss',
    y: 'yyyy年M月',
    Y: 'yyyy年M月',
  },
  dateSeparator: '/',
  timeSeparator: ':',
  dayNames: ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'],
  abbreviatedDayNames: ['日', '月', '火', '水', '木', '金', '土'],
  monthNames: JAPANESE_MONTHS,
  abbreviatedMonthNames: JAPANESE_MONTHS,
  monthGenitiveNames: JAPANESE_MONTHS,
  abbreviatedMonthGenitiveNames: JAPANESE_MONTHS,
  amDesignator: '午前',
  pmDesignator: '午後',
  era: '西暦',
};

const ENGLISH_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ENGLISH_MONTHS = 'January February March April May June July August September October November December'.split(
  ' '
);
const ENGLISH_ABBREVIATED_MONTHS = ENGLISH_MONTHS.map((month) => month.slice(0, 3));

const INVARIANT_NAME = 'Invariant Language (Invariant Country)';

export const INVARIANT: Culture = {
  name: '',
  displayName: INVARIANT_NAME,
  englishName: INVARIANT_NAME,
  nativeName: INVARIANT_NAME,
  twoLetterIsoLanguageName: 'iv',
  isInvariant: true,
  numberDecimalDigits: 2,
  percentDecimalDigits: 2,
  currencyDecimalDigits: 2,
  currencySymbol: '¤',
  symbols: {
    decimalSeparator: '.',
    groupSeparator: ',',
    groupSizes: [3],
    negativeSign: '-',
    positiveSign: '+',
    nan: 'NaN',
    positiveInfinity: 'Infinity',
    negativeInfinity: '-Infinity',
    percentSymbol: '%',
    perMilleSymbol: '‰',
  },
  patterns: { numberNegative: 1, currencyPositive: 0, currencyNegative: 0, percentPositive: 0, percentNegative: 0 },
  datePatterns: {
    d: 'MM/dd/yyyy',
    D: 'dddd, dd MMMM yyyy',
    f: 'dddd, dd MMMM yyyy HH:mm',
    F: 'dddd, dd MMMM yyyy HH:mm:ss',
    g: 'MM/dd/yyyy HH:mm',
    G: 'MM/dd/yyyy HH:mm:ss',
    m: 'MMMM dd',
    M: 'MMMM dd',
    t: 'HH:mm',
    T: 'HH:mm:ss',
    y: 'yyyy MMMM',
    Y: 'yyyy MMMM',
  },
  dateSeparator: '/',
  timeSeparator: ':',
  dayNames: ENGLISH_DAYS,
  abbreviatedDayNames: ENGLISH_DAYS.map((day) => day.slice(0, 3)),
  monthNames: ENGLISH_MONTHS,
  abbreviatedMonthNames: ENGLISH_ABBREVIATED_MONTHS,
  monthGenitiveNames: ENGLISH_MONTHS,
  abbreviatedMonthGenitiveNames: ENGLISH_ABBREVIATED_MONTHS,
  amDesignator: 'AM',
  pmDesignator: 'PM',
  era: 'A.D.',
};

/**
 * The culture of a `CultureInfo` name, compared ignoring case as .NET does: ja-JP, the invariant culture, or one that
 * the host's `Intl` has. It is `'invalid'` for a name that .NET rejects as no culture identifier, and undefined for
 * one this grader cannot build.
 */
export function cultureNamed(name: string): Culture | 'invalid' | undefined {
  if (name === '') return INVARIANT;
  if (name.toLowerCase() === 'ja-jp') return JA_JP;
  return intlCulture(name);
}

/**
 * Rejects the dates of a culture whose calendar is not Gregorian, which this grader has no calendar for, as an
 * unavailable feature at a row, or at the program's start when the caller does not know the row.
 */
export function requireGregorian(culture: Culture, row = 0): void {
  if (culture.otherCalendar === undefined) return;
  throw new CompileError([
    { row, message: `カルチャ ${culture.name} の日付（${culture.otherCalendar} 暦）は、この採点環境では使えません。` },
  ]);
}

/** The cultures a run formats and compares by: `CultureInfo.CurrentCulture` and `CurrentUICulture`. */
export interface CultureSettings {
  current: Culture;
  currentUi: Culture;
  /** Whether `InvariantGlobalization` is on, so that only the invariant culture exists and strings compare ordinally. */
  isGlobalizationInvariant: boolean;
  /** The `CultureInfo` objects that .NET keeps and returns each time, made when the program first asks for them. */
  objects: {
    current?: CsObject;
    currentUi?: CsObject;
    invariant?: CsObject;
    /** Those of `GetCultureInfo`, by culture name. */
    cached: Map<string, CsObject>;
  };
}

const settingsByRuntime = new WeakMap<Runtime, CultureSettings>();

/** A run's culture settings, which start from ja-JP, or from the invariant culture in globalization-invariant mode. */
export function cultureSettingsOf(runtime: Runtime): CultureSettings {
  let settings = settingsByRuntime.get(runtime);
  if (!settings) {
    const isGlobalizationInvariant = runtime.evaluator.program.invariantGlobalization;
    const culture = isGlobalizationInvariant ? INVARIANT : JA_JP;
    settings = { current: culture, currentUi: culture, isGlobalizationInvariant, objects: { cached: new Map() } };
    settingsByRuntime.set(runtime, settings);
  }
  return settings;
}

/** The culture that formatting without a provider uses: `CultureInfo.CurrentCulture`. */
export function currentCulture(runtime: Runtime): Culture {
  return cultureSettingsOf(runtime).current;
}

/** The `Intl` locale whose collation a culture's string comparisons use. */
export function collationLocale(culture: Culture): string {
  if (culture.isInvariant) return ROOT;
  return culture.twoLetterIsoLanguageName === 'ja' ? JAPANESE : culture.name;
}

/** The state of a `CultureInfo` object. */
export class CultureInfoState {
  constructor(
    readonly culture: Culture,
    readonly isReadOnly: boolean
  ) {}
}

export function isCultureInfo(value: Value): value is CsObject & { native: CultureInfoState } {
  return value instanceof CsObject && value.native instanceof CultureInfoState;
}

/**
 * The culture that an `IFormatProvider` argument formats with: a `CultureInfo`'s own, or the current culture for null
 * and for a provider of the program's, whose `GetFormat` can return no format object this grader has.
 */
export function providerCulture(runtime: Runtime, provider: Value): Culture {
  return isCultureInfo(provider) ? provider.native.culture : currentCulture(runtime);
}
