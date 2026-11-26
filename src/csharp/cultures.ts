import type { Runtime } from './runtime';
import { CsObject, type Value } from './values';

/** The standard date and time format letters whose patterns depend on the culture. */
export type CultureDatePattern = 'd' | 'D' | 'f' | 'F' | 'g' | 'G' | 'm' | 'M' | 't' | 'T' | 'y' | 'Y';

/**
 * What formatting, parsing, and comparing need of one of the two cultures this grader has: ja-JP, the reference
 * machine's culture (with ICU's data), and the invariant culture. Both share the decimal point `.`, the group
 * separator `,`, the negative sign `-`, and `NaN`.
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
  positiveInfinity: string;
  negativeInfinity: string;
  /** What follows a percentage: `%`, or ` %` in the invariant culture's pattern `n %`. */
  percentSuffix: string;
  /** Whether a negative amount of money is written `(¤n)`, the invariant culture's pattern, instead of `-¤n`. */
  parenthesizesNegativeCurrency: boolean;
  datePatterns: Record<CultureDatePattern, string>;
  dayNames: readonly string[];
  abbreviatedDayNames: readonly string[];
  monthNames: readonly string[];
  abbreviatedMonthNames: readonly string[];
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
  positiveInfinity: '∞',
  negativeInfinity: '-∞',
  percentSuffix: '%',
  parenthesizesNegativeCurrency: false,
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
  dayNames: ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'],
  abbreviatedDayNames: ['日', '月', '火', '水', '木', '金', '土'],
  monthNames: JAPANESE_MONTHS,
  abbreviatedMonthNames: JAPANESE_MONTHS,
  amDesignator: '午前',
  pmDesignator: '午後',
  era: '西暦',
};

const ENGLISH_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ENGLISH_MONTHS = 'January February March April May June July August September October November December'.split(
  ' '
);

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
  positiveInfinity: 'Infinity',
  negativeInfinity: '-Infinity',
  percentSuffix: ' %',
  parenthesizesNegativeCurrency: true,
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
  dayNames: ENGLISH_DAYS,
  abbreviatedDayNames: ENGLISH_DAYS.map((day) => day.slice(0, 3)),
  monthNames: ENGLISH_MONTHS,
  abbreviatedMonthNames: ENGLISH_MONTHS.map((month) => month.slice(0, 3)),
  amDesignator: 'AM',
  pmDesignator: 'PM',
  era: 'A.D.',
};

/** The culture of a `CultureInfo` name, compared ignoring case as .NET does, or undefined for any other culture. */
export function cultureNamed(name: string): Culture | undefined {
  if (name === '') return INVARIANT;
  return name.toLowerCase() === 'ja-jp' ? JA_JP : undefined;
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
