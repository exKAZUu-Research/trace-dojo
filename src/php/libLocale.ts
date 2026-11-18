// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { byteAt } from './bytes';
import { valueName } from './conversions';
import { throwError, warn } from './errors';
import { defineConstant, defineFunction } from './native';
import { toStr } from './operators';
import { rt } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import { PhpArray, PhpObject, type Value } from './values';

const s = (value: Value): string => value as string;
const n = (value: Value): number => Number(value as bigint);

// Locales ------------------------------------------------------------------------------------------------------------

// The values of the reference PHP's macOS C library, which other platforms number differently.
const LOCALE_CATEGORIES = ['LC_ALL', 'LC_COLLATE', 'LC_CTYPE', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME', 'LC_MESSAGES'];
for (const [value, name] of LOCALE_CATEGORIES.entries()) defineConstant(name, BigInt(value));
defineConstant('CHAR_MAX', 127n);
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
const LANGINFO_ITEMS: readonly (readonly [string, string])[] = [
  ['CODESET', ''],
  ['D_T_FMT', '%a %b %e %H:%M:%S %Y'],
  ['D_FMT', '%m/%d/%y'],
  ['T_FMT', '%H:%M:%S'],
  ['T_FMT_AMPM', '%I:%M:%S %p'],
  ['AM_STR', 'AM'],
  ['PM_STR', 'PM'],
  ...['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
    (day, index) => [`DAY_${index + 1}`, day] as const
  ),
  ...['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => [`ABDAY_${index + 1}`, day] as const),
  ...MONTHS.map((month, index) => [`MON_${index + 1}`, month] as const),
  ...MONTHS.map((month, index) => [`ABMON_${index + 1}`, month.slice(0, 3)] as const),
  ['ERA', ''],
  ['ERA_D_FMT', ''],
  ['ERA_D_T_FMT', ''],
  ['ERA_T_FMT', ''],
  ['ALT_DIGITS', ''],
  ['RADIXCHAR', '.'],
  ['THOUSEP', ''],
  ['YESEXPR', '^[yY]'],
  ['NOEXPR', '^[nN]'],
  ['YESSTR', 'yes'],
  ['NOSTR', 'no'],
  ['CRNCYSTR', ''],
];
for (const [value, [name]] of LANGINFO_ITEMS.entries()) defineConstant(name, BigInt(value));

/** The locale of each category from LC_COLLATE (index 0) to LC_MESSAGES, for each run; PHP starts LC_CTYPE as C.UTF-8. */
const locales = new WeakMap<object, string[]>();

function currentLocales(): string[] {
  const current = locales.get(rt()) ?? ['C', 'C.UTF-8', 'C', 'C', 'C', 'C'];
  locales.set(rt(), current);
  return current;
}

/** Whether the C library reads bytes as UTF-8 and classifies 0x80–0xFF as the characters of Latin-1. */
export function isUtf8Ctype(): boolean {
  return currentLocales()[1] === 'C.UTF-8';
}

defineFunction('setlocale(int $category, $locales, ...$rest): string|false', ({ args }) => {
  const category = n(args[0]);
  for (const [index, value] of args.slice(1).entries()) {
    if (value instanceof PhpObject && !value.cls.findMethod('__tostring')) {
      const parameter = index === 0 ? ' ($locales)' : '';
      throwError(
        'TypeError',
        `setlocale(): Argument #${index + 2}${parameter} must be of type array|string|null, ${valueName(value)} given`
      );
    }
  }
  for (const value of args.slice(1)) {
    const names: Iterable<Value> = value instanceof PhpArray ? value.values() : [value];
    for (const name of names) {
      const result = trySetLocale(category, toStr(name));
      if (result !== undefined) return result;
    }
  }
  return false;
});

/** The languages and territories of the locales the reference PHP's macOS provides, which this grader does not emulate. */
const MACOS_LOCALES = new Set(
  'af_ZA am_ET ar_AE ar_EG ar_JO ar_MA ar_QA ar_SA be_BY bg_BG ca_AD ca_ES ca_FR ca_IT cs_CZ da_DK de_AT de_CH de_DE el_GR en_AU en_CA en_GB en_HK en_IE en_IN en_NZ en_PH en_SG en_US en_ZA es_AR es_CR es_ES es_MX et_EE eu_ES fa_AF fa_IR fi_FI fr_BE fr_CA fr_CH fr_FR ga_IE he_IL hi_IN hr_HR hu_HU hy_AM is_IS it_CH it_IT ja_JP kk_KZ ko_KR lt_LT lv_LV mn_MN nb_NO nl_BE nl_NL nn_NO no_NO pl_PL pt_BR pt_PT ro_RO ru_RU se_FI se_NO sk_SK sl_SI sr_RS sr_YU sv_FI sv_SE tr_TR uk_UA zh_CN zh_HK zh_TW'.split(
    ' '
  )
);

function trySetLocale(category: number, name: string): string | undefined {
  if (name.length >= 255 && name !== '0') {
    warn('setlocale(): Specified locale name is too long');
    return undefined;
  }
  if (category < 0 || category > 6) return undefined;
  const current = currentLocales();
  if (name === '0') return category === 0 ? localeOfAll(current) : current[category - 1];
  const locale = name === '' ? 'C.UTF-8' : name;
  // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- macOS names its UTF-8 LC_CTYPE locale `UTF-8`.
  if (MACOS_LOCALES.has(locale.split('.')[0]) || (locale === 'UTF-8' && category === 2)) {
    throw new UnsupportedFeatureError('C 以外のロケール（setlocale）');
  }
  if (!['C', 'POSIX', 'C.UTF-8'].includes(locale)) return undefined;
  if (category === 0) current.fill(locale);
  else current[category - 1] = locale;
  return category === 0 ? localeOfAll(current) : locale;
}

function localeOfAll(current: string[]): string {
  return current.every((locale) => locale === current[0]) ? current[0] : current.join('/');
}

defineFunction('localeconv(): array', () => {
  const array = new PhpArray();
  for (const key of ['decimal_point', 'thousands_sep', 'int_curr_symbol', 'currency_symbol', 'mon_decimal_point']) {
    array.set(key, key === 'decimal_point' ? '.' : '');
  }
  for (const key of ['mon_thousands_sep', 'positive_sign', 'negative_sign']) array.set(key, '');
  for (const key of ['int_frac', 'frac', 'p_cs_precedes', 'p_sep_by_space', 'n_cs_precedes', 'n_sep_by_space']) {
    array.set(key.endsWith('frac') ? `${key}_digits` : key, 127n);
  }
  array.set('p_sign_posn', 127n);
  array.set('n_sign_posn', 127n);
  array.set('grouping', new PhpArray());
  array.set('mon_grouping', new PhpArray());
  return array;
});
defineFunction('nl_langinfo(int $item): string|false', ({ args }) => {
  const item = n(args[0]);
  const entry = LANGINFO_ITEMS[item] as (typeof LANGINFO_ITEMS)[number] | undefined;
  if (!entry) {
    warn(`nl_langinfo(): Item '${args[0] as bigint}' is not valid`);
    return false;
  }
  // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- The C library names the codeset `UTF-8`.
  if (entry[0] === 'CODESET') return isUtf8Ctype() ? 'UTF-8' : 'US-ASCII';
  return entry[1];
});

// The C library's strcoll, which compares as strcmp in the C locale: up to the first NUL byte, by byte difference.
defineFunction('strcoll(string $string1, string $string2): int', ({ args }) => {
  const a = s(args[0]);
  const b = s(args[1]);
  for (let index = 0; ; index++) {
    const x = byteAt(a, index);
    const y = byteAt(b, index);
    if (x !== y || x === 0) return BigInt(x - y);
  }
});

/** Uppercases a byte as the C library's toupper does in the current LC_CTYPE locale. */
export function ctypeUpper(char: string): string {
  const code = char.charCodeAt(0);
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 32);
  if (isUtf8Ctype() && code >= 0xe0 && code <= 0xfe && code !== 0xf7) return String.fromCharCode(code - 32);
  return char;
}

/** Whether a byte is a letter as the C library's isalpha says, which in the C.UTF-8 locale includes Latin-1's letters. */
export function isCtypeAlpha(code: number): boolean {
  if (code < 0x80) return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  return (
    isUtf8Ctype() &&
    (code === 0xaa || code === 0xb5 || code === 0xba || (code >= 0xc0 && code !== 0xd7 && code !== 0xf7))
  );
}

/** Whether a byte is a control character as the C library's iscntrl says, which in C.UTF-8 includes Latin-1's. */
export function isCtypeControl(code: number): boolean {
  return code < 0x20 || code === 0x7f || (isUtf8Ctype() && ((code >= 0x80 && code <= 0x9f) || code === 0xad));
}

/** Whether a byte is a space as the C library's isspace classifies it in the current LC_CTYPE locale. */
export function isCtypeSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13) || (code === 0xa0 && isUtf8Ctype());
}
