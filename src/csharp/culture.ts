// oxlint-disable unicorn/prefer-code-point -- C# characters are UTF-16 code units, which code points would merge.
/**
 * The string comparison and search of .NET's cultures, which .NET runs on ICU: the ja-JP culture's collation for the
 * current culture and the root collation for the invariant one. The server's ICU, through `Intl.Collator`, gives the
 * same order on every server.
 */

/** Which collation a comparison uses, and whether it ignores case. */
export interface CultureComparison {
  isInvariant?: boolean;
  ignoreCase?: boolean;
}

const LOCALES = { current: 'ja-JP', invariant: 'und' } as const;

const collators = new Map<string, Intl.Collator>();

function collator(isInvariant: boolean | undefined, sensitivity: 'variant' | 'accent' | 'base'): Intl.Collator {
  const locale = isInvariant ? LOCALES.invariant : LOCALES.current;
  const key = `${locale}/${sensitivity}`;
  let found = collators.get(key);
  if (!found) {
    found = new Intl.Collator(locale, { sensitivity, usage: 'sort' });
    collators.set(key, found);
  }
  return found;
}

/** `string.Compare` with a culture, which gives -1, 0, or 1. */
export function compareCulture(a: string, b: string, options: CultureComparison = {}): number {
  const order = options.ignoreCase
    ? compareIgnoringCase(a, b, options.isInvariant)
    : collator(options.isInvariant, 'variant').compare(a, b);
  return Math.sign(order);
}

/** Characters whose width or kana type .NET's case-insensitive comparison tells apart. */
const WIDE_OR_KANA = /[　぀-ヿ！-￯]/u;

/**
 * A comparison ignoring case, which .NET makes with ICU's secondary strength and rules that keep width and kana type
 * apart as primary differences: each full-width form sorts right after its half-width one, and each katakana right
 * after its hiragana, with the half-width katakana after the full-width.
 */
function compareIgnoringCase(a: string, b: string, isInvariant: boolean | undefined): number {
  const accent = collator(isInvariant, 'accent');
  if (!WIDE_OR_KANA.test(a) && !WIDE_OR_KANA.test(b)) return accent.compare(a, b);
  const base = collator(isInvariant, 'base');
  const unitsA = kanaWidthUnits(a);
  const unitsB = kanaWidthUnits(b);
  const length = Math.min(unitsA.length, unitsB.length);
  for (let index = 0; index < length; index++) {
    const [x, y] = [unitsA[index], unitsB[index]];
    const primary = base.compare(x.base, y.base);
    if (primary !== 0) return primary;
    if (x.rank !== y.rank) return x.rank < y.rank ? -1 : 1;
  }
  const textA = unitsA.map((unit) => unit.base).join('');
  const textB = unitsB.map((unit) => unit.base).join('');
  return accent.compare(textA, textB);
}

interface KanaWidthUnit {
  /** The character with its width and kana type undone: a half-width letter or a hiragana. */
  base: string;
  /** The order of the width and kana type among the forms of the base. */
  rank: number;
}

const KATAKANA_TO_HIRAGANA = 0x60;

// code-gauge-allow functionCognitiveComplexity 17 -- Each branch handles one kind of character that .NET's rules tell apart.
function kanaWidthUnits(text: string): KanaWidthUnit[] {
  const units: KanaWidthUnit[] = [];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xff_65 && code <= 0xff_9f) {
      // A half-width katakana takes a following half-width sound mark into one full-width katakana.
      const next = text.charCodeAt(index + 1);
      const hasMark = next === 0xff_9e || next === 0xff_9f;
      const wide = text.slice(index, index + (hasMark ? 2 : 1)).normalize('NFKC');
      if (hasMark) index++;
      const katakana = wide.charCodeAt(0);
      units.push({ base: hiraganaOf(wide), rank: katakanaRank(katakana) + 0.5 });
    } else if (code >= 0xff_01 && code <= 0xff_5e) {
      units.push({ base: String.fromCharCode(code - 0xfe_e0), rank: 1 });
    } else if (code === 0x30_00) {
      units.push({ base: ' ', rank: 1 });
    } else if (code >= 0x30_a1 && code <= 0x30_f6) {
      units.push({ base: hiraganaOf(text[index]), rank: katakanaRank(code) });
    } else {
      units.push({ base: text[index], rank: 0 });
    }
  }
  return units;
}

function hiraganaOf(katakana: string): string {
  const code = katakana.charCodeAt(0);
  return code >= 0x30_a1 && code <= 0x30_f6
    ? String.fromCharCode(code - KATAKANA_TO_HIRAGANA) + katakana.slice(1)
    : katakana;
}

/**
 * The rank of a katakana after its hiragana: .NET adds the rules in code order, each right after its hiragana, so of
 * the katakana that share a hiragana's primary weight, as `ァ` and `ア` do, the later one sorts first.
 */
function katakanaRank(code: number): number {
  return 1 + (0x30_f6 - code) / 0x1_00;
}

/** Whether two strings are equal under a culture's comparison. */
export function equalsCulture(a: string, b: string, options: CultureComparison = {}): boolean {
  return a === b || compareCulture(a, b, options) === 0;
}

/** A key that strings equal under a culture's comparison share, for their hash codes. */
export function cultureHashKey(text: string): string {
  const folded = [...text.normalize('NFKD')]
    .filter((char) => !/[\p{M}\p{Cf}\p{Cc}]/u.test(char))
    .map((char) => hiraganaOf(char))
    .join('');
  // Strings equal under a comparison fold alike; ones that fold alike but differ only share a hash code.
  return folded.toLowerCase();
}

/** Characters whose matches under a culture are the ordinal ones: printable ASCII, which ICU never folds together. */
const PLAIN = /^[ -~]*$/u;

/** Whether a position of a string starts a character, not a combining mark that belongs to the one before. */
function isBoundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return true;
  return !/\p{M}/u.test(text[index]) && !(text.charCodeAt(index) >= 0xdc_00 && text.charCodeAt(index) <= 0xdf_ff);
}

/**
 * The first index from `start`, in the `count` characters from there, where a substring equals the value under a
 * culture, as `IndexOf(string)` searches, or -1.
 */
export function cultureIndexOf(
  text: string,
  value: string,
  start: number,
  end: number,
  options: CultureComparison = {}
): number {
  if (!options.ignoreCase && PLAIN.test(text) && PLAIN.test(value)) {
    const found = text.indexOf(value, start);
    return found !== -1 && found + value.length <= end ? found : -1;
  }
  for (let index = start; index <= end; index++) {
    if (!isBoundary(text, index)) continue;
    if (matchLength(text, value, index, end, options) !== undefined) return index;
  }
  return -1;
}

/** The last index before `end` from where a substring ending by `end` equals the value, as `LastIndexOf` searches. */
export function cultureLastIndexOf(
  text: string,
  value: string,
  start: number,
  end: number,
  options: CultureComparison = {}
): number {
  if (!options.ignoreCase && PLAIN.test(text) && PLAIN.test(value)) {
    const found = text.lastIndexOf(value, end - value.length);
    return found >= start ? found : -1;
  }
  for (let index = end; index >= start; index--) {
    if (!isBoundary(text, index)) continue;
    if (matchLength(text, value, index, end, options) !== undefined) return index;
  }
  return -1;
}

export function cultureStartsWith(text: string, value: string, options: CultureComparison = {}): boolean {
  if (!options.ignoreCase && PLAIN.test(text) && PLAIN.test(value)) return text.startsWith(value);
  return matchLength(text, value, 0, text.length, options) !== undefined;
}

export function cultureEndsWith(text: string, value: string, options: CultureComparison = {}): boolean {
  if (!options.ignoreCase && PLAIN.test(text) && PLAIN.test(value)) return text.endsWith(value);
  for (let index = text.length; index >= 0; index--) {
    if (isBoundary(text, index) && equalsCulture(text.slice(index), value, options)) return true;
  }
  return false;
}

/**
 * The length of the substring from an index, ending on a character boundary by `end`, that equals the value under a
 * culture, trying the shortest first, or undefined.
 */
function matchLength(
  text: string,
  value: string,
  index: number,
  end: number,
  options: CultureComparison
): number | undefined {
  // Ignorable characters and combining marks let a match be longer than the value, but not by much.
  const longest = Math.min(end, index + value.length * 2 + 8);
  for (let stop = index; stop <= longest; stop++) {
    if (!isBoundary(text, stop)) continue;
    if (equalsCulture(text.slice(index, stop), value, options)) return stop - index;
  }
  return undefined;
}
