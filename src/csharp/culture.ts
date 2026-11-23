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
  /** Charges the run's budget for work proportional to the lengths compared, which a long text makes slow. */
  spend?: (cost: number) => void;
}

/** Charges a comparison of texts of a total length, one operation for each 64 characters. */
function charge(options: CultureComparison, length: number): void {
  options.spend?.(1 + Math.floor(length / CHARACTERS_PER_OPERATION));
}

const CHARACTERS_PER_OPERATION = 64;

/**
 * A charge for a search's many comparisons, which adds up their lengths, each with a little more for the comparison
 * itself, and charges an operation for each 64 characters.
 */
function meterOf(options: CultureComparison): (length: number) => void {
  let characters = 0;
  return (length) => {
    characters += length + 16;
    if (characters < CHARACTERS_PER_OPERATION) return;
    options.spend?.(Math.floor(characters / CHARACTERS_PER_OPERATION));
    characters %= CHARACTERS_PER_OPERATION;
  };
}

// The root collation, which .NET's invariant culture uses: `en` has no tailoring, and `und` takes the host's locale in Node.
const LOCALES = { current: 'ja-JP', invariant: 'en' } as const;

const collators = new Map<string, Intl.Collator>();

type Sensitivity = 'variant' | 'accent' | 'base' | 'caseBits';

/**
 * A collator of a strength; `caseBits` also tells apart the case bits that ICU keeps in each collation element, which
 * ICU's comparison of strings ignores at the tertiary strength and .NET's search compares, as the halfwidth Hangul
 * have other bits than the letters they equal.
 */
function collator(isInvariant: boolean | undefined, sensitivity: Sensitivity): Intl.Collator {
  const locale = isInvariant ? LOCALES.invariant : LOCALES.current;
  const key = `${locale}/${sensitivity}`;
  let found = collators.get(key);
  if (!found) {
    found =
      sensitivity === 'caseBits'
        ? new Intl.Collator(locale, { sensitivity: 'variant', caseFirst: 'upper', usage: 'sort' })
        : new Intl.Collator(locale, { sensitivity, usage: 'sort' });
    collators.set(key, found);
  }
  return found;
}

/** `string.Compare` with a culture, which gives -1, 0, or 1. */
export function compareCulture(a: string, b: string, options: CultureComparison = {}): number {
  charge(options, a.length + b.length);
  const { compare, comparable } = comparisonOf(options);
  return Math.sign(compare(comparable(a), comparable(b)));
}

interface Comparison {
  compare: (a: string, b: string) => number;
  /** The text the collator compares for a string, which carries the rules .NET adds to the culture's own. */
  comparable: (text: string) => string;
}

/** The comparison of strings, or, with `isElementwise`, of collation elements, as .NET's search and affixes compare. */
function comparisonOf(options: CultureComparison, isElementwise = false): Comparison {
  if (!options.ignoreCase) {
    return { compare: collator(options.isInvariant, isElementwise ? 'caseBits' : 'variant').compare, comparable: same };
  }
  const keys = tailoringOf(options.isInvariant);
  return {
    compare: collator(options.isInvariant, 'accent').compare,
    comparable: (text) => (hasTailored(text) ? withTailoring(text, keys, options.isInvariant) : text),
  };
}

const same = (text: string): string => text;

/**
 * .NET compares ignoring case with ICU's secondary strength and rules it adds to the culture's, which keep kana types
 * and widths apart (`pal_collation.c` in .NET's System.Globalization.Native): each `&X<Y` puts Y on a primary weight
 * of its own right after X's, before what earlier rules put there, and each `&X=Y` makes Y equal to X.
 */
function* ignoreCaseRules(): Generator<Rule> {
  for (const hiragana of HIRAGANA_WITHOUT_VOICED_SOUND_MARK) yield rule(hiragana, '<', hiragana + HIRAGANA_TO_KATAKANA);
  for (const [index, lower] of HALF_FULL_LOWER.entries()) yield rule(lower, '<', HALF_FULL_HIGHER[index]);
  // Fullwidth capital letters share the small ones' weight again, which the rules above put apart.
  for (let capital = 0xff_21; capital <= 0xff_3a; capital++) yield rule(capital + 0x20, '=', capital);
}

interface Rule {
  reset: string;
  relation: '<' | '=';
  character: string;
}

function rule(reset: number, relation: Rule['relation'], character: number): Rule {
  return { reset: String.fromCharCode(reset), relation, character: String.fromCharCode(character) };
}

const HIRAGANA_TO_KATAKANA = 0x60;

// The tables of .NET's `g_HiraganaWithoutVoicedSoundMarkChars`, `g_HalfFullLowerChars`, and `g_HalfFullHigherChars`.
const HIRAGANA_WITHOUT_VOICED_SOUND_MARK = codes(
  [0x30_41, 0x30_4b],
  0x30_4d,
  0x30_4f,
  0x30_51,
  0x30_53,
  0x30_55,
  0x30_57,
  0x30_59,
  0x30_5b,
  0x30_5d,
  0x30_5f,
  0x30_61,
  0x30_63,
  0x30_64,
  0x30_66,
  0x30_68,
  [0x30_6a, 0x30_6f],
  0x30_72,
  0x30_75,
  0x30_78,
  0x30_7b,
  [0x30_7e, 0x30_93],
  0x30_95,
  0x30_96,
  0x30_9d
);
const HALF_FULL_LOWER = codes(
  [0x21, 0x5b],
  [0x5d, 0x7e],
  0xa2,
  0xa3,
  0xac,
  0xaf,
  0xa6,
  0xa5,
  0x20_a9,
  0x30_02,
  0x30_0c,
  0x30_0d,
  0x30_01,
  0x30_fb,
  0x30_f2,
  0x30_a1,
  0x30_a3,
  0x30_a5,
  0x30_a7,
  0x30_a9,
  0x30_e3,
  0x30_e5,
  0x30_e7,
  0x30_c3,
  0x30_a2,
  0x30_a4,
  0x30_a6,
  0x30_a8,
  0x30_aa,
  0x30_ab,
  0x30_ad,
  0x30_af,
  0x30_b1,
  0x30_b3,
  0x30_b5,
  0x30_b7,
  0x30_b9,
  0x30_bb,
  0x30_bd,
  0x30_bf,
  0x30_c1,
  0x30_c4,
  0x30_c6,
  0x30_c8,
  0x30_ca,
  0x30_cb,
  0x30_cc,
  0x30_cd,
  0x30_ce,
  0x30_cf,
  0x30_d2,
  0x30_d5,
  0x30_d8,
  0x30_db,
  0x30_de,
  0x30_df,
  0x30_e0,
  0x30_e1,
  0x30_e2,
  0x30_e4,
  0x30_e6,
  0x30_e8,
  0x30_e9,
  0x30_ea,
  0x30_eb,
  0x30_ec,
  0x30_ed,
  0x30_ef,
  0x30_f3,
  0x31_64,
  [0x31_31, 0x31_63]
);
const HALF_FULL_HIGHER = codes(
  [0xff_01, 0xff_3b],
  [0xff_3d, 0xff_5e],
  [0xff_e0, 0xff_e6],
  [0xff_61, 0xff_6f],
  [0xff_71, 0xff_9d],
  [0xff_a0, 0xff_be],
  [0xff_c2, 0xff_c7],
  [0xff_ca, 0xff_cf],
  [0xff_d2, 0xff_d7],
  [0xff_da, 0xff_dc]
);

/** Character codes, of which a pair stands for the codes from the first to the last. */
function codes(...parts: (number | [number, number])[]): number[] {
  return parts.flatMap((part) => (typeof part === 'number' ? [part] : range(part[0], part[1])));
}

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/** The characters that the rules place, which the comparison replaces with texts that sort where the rules put them. */
const TAILORED = new Set([...ignoreCaseRules()].map((tailored) => tailored.character));

/** Whether a text has a placed character, of its own or in a precomposed one such as ガ. */
function hasTailored(text: string): boolean {
  for (const char of text.normalize('NFD')) if (TAILORED.has(char)) return true;
  return false;
}

const tailorings = new Map<boolean, Map<string, string>>();

/**
 * The text that each placed character sorts as: a character of the weight the rules start from, followed by as many
 * U+FFFF, which outweighs every character, as the places that the rules put between them.
 */
function tailoringOf(isInvariant: boolean | undefined): Map<string, string> {
  const key = isInvariant === true;
  let found = tailorings.get(key);
  if (!found) {
    found = buildTailoring(collator(isInvariant, 'base'));
    tailorings.set(key, found);
  }
  return found;
}

/** Applies the rules in order to the primary weights, as ICU builds a tailoring: each weight a list of characters. */
function buildTailoring(base: Intl.Collator): Map<string, string> {
  const rules = [...ignoreCaseRules()];
  const placed = new Set(rules.map((tailored) => tailored.character));
  const resets = rules.map((tailored) => tailored.reset).filter((reset) => !placed.has(reset));
  const weightsOf = untailoredWeights(resets, base);
  for (const { reset, relation, character } of rules) {
    const own = weightsOf.get(character);
    if (own) {
      const index = own.findIndex((weight) => weight.includes(character));
      own[index] = own[index].filter((other) => other !== character);
      if (own[index].length === 0) own.splice(index, 1);
    }
    const target = weightsOf.get(reset) as string[][];
    const index = target.findIndex((weight) => weight.includes(reset));
    if (relation === '<') target.splice(index + 1, 0, [character]);
    else target[index].push(character);
    weightsOf.set(character, target);
  }
  return new Map(
    [...placed].map((character) => {
      const target = weightsOf.get(character) as string[][];
      const index = target.findIndex((weight) => weight.includes(character));
      // `ヽ` starts from `ゝ`, which would weigh after a kana before it as `ヽ` does not: a NUL keeps it apart.
      const start = CONTEXTUAL.has(target[0][0]) ? `\0${target[0][0]}` : target[0][0];
      return [character, start + '\uFFFF'.repeat(index)];
    })
  );
}

/**
 * The primary weights from each one that the rules start from, before the rules put others after it: a list for each
 * weight, holding the characters that have it.
 */
function untailoredWeights(resets: string[], base: Intl.Collator): Map<string, string[][]> {
  const weightsOf = new Map<string, string[][]>();
  let previous: string | undefined;
  let weights: string[][] = [];
  for (const reset of [...new Set(resets)].toSorted(base.compare)) {
    if (previous === undefined || base.compare(previous, reset) !== 0) weights = [[]];
    weights[0].push(reset);
    weightsOf.set(reset, weights);
    previous = reset;
  }
  return weightsOf;
}

/** A text with its placed characters replaced, after decomposing it as ICU's canonical closure does. */
function withTailoring(text: string, keys: Map<string, string>, isInvariant: boolean | undefined): string {
  let result = '';
  // The character before with its combining marks, which weighs a following `ー` or iteration mark in ja-JP.
  let cluster = '';
  for (const char of text.normalize('NFD')) {
    const isMark = /\p{M}/u.test(char);
    const replaced =
      keys.has(cluster.slice(0, 1)) && !isMark ? contextualWeight(cluster, char, isInvariant) : undefined;
    result += replaced ?? keys.get(char) ?? char;
    cluster = isMark ? cluster + char : char;
  }
  return result;
}

/** The characters whose weights ja-JP's rules give after the kana before them: the long vowel and iteration marks. */
const CONTEXTUAL = new Set(['ー', 'ゝ', 'ゞ', 'ヽ', 'ヾ']);

const contextualWeights = new Map<string, string | undefined>();

/**
 * A hiragana that weighs as a character does after a placed one, which the replaced text no longer has before it:
 * ja-JP's rules weigh the `ー` of `カー` as the vowel `あ`, whatever weight .NET's rules give `カ`.
 */
function contextualWeight(cluster: string, char: string, isInvariant: boolean | undefined): string | undefined {
  if (!CONTEXTUAL.has(char)) return undefined;
  const key = `${isInvariant === true}:${cluster}${char}`;
  if (contextualWeights.has(key)) return contextualWeights.get(key);
  const variant = collator(isInvariant, 'variant');
  const accent = collator(isInvariant, 'accent');
  const weight =
    variant.compare(cluster + char, `${cluster}\0${char}`) === 0
      ? undefined
      : HIRAGANA.find((hiragana) => accent.compare(cluster + char, cluster + hiragana) === 0);
  // A character with many combining marks before is rare, and keeping each would let a program grow the cache.
  if (cluster.length <= 2) contextualWeights.set(key, weight);
  return weight;
}

const HIRAGANA = range(0x30_41, 0x30_96).map((code) => String.fromCharCode(code));

/** Whether two strings are equal under a culture's comparison. */
export function equalsCulture(a: string, b: string, options: CultureComparison = {}): boolean {
  return a === b || compareCulture(a, b, options) === 0;
}

/**
 * A key that strings equal under a culture's comparison share, for their hash codes. ja-JP weighs `ー` as the vowel of
 * the kana before it and an iteration mark as that kana, so the key leaves out the vowels and `ー`, and repeats the
 * kana for an iteration mark; strings that differ but share a key only share a hash code.
 */
export function cultureHashKey(text: string): string {
  let key = '';
  let previous = '';
  for (const char of text.normalize('NFKD')) {
    if (/[\p{M}\p{Cf}\p{Cc}]/u.test(char)) continue;
    const folded = ITERATION_MARKS.has(char) ? previous : hiraganaOf(char);
    previous = folded;
    if (!/[ぁ-おー]/u.test(folded)) key += folded;
  }
  return key.toLowerCase();
}

const ITERATION_MARKS = new Set(['ゝ', 'ヽ']);

function hiraganaOf(char: string): string {
  const code = char.charCodeAt(0);
  return code >= 0x30_a1 && code <= 0x30_f6 ? String.fromCharCode(code - HIRAGANA_TO_KATAKANA) : char;
}

/** Characters whose matches under a culture are the ordinal ones: printable ASCII, which ICU never folds together. */
const PLAIN = /^[ -~]*$/u;

/**
 * The first index from `start` where a substring ending by `end` equals the value under a culture, or -1: ICU's
 * search, which .NET's `IndexOf` calls on the part searched, matches only between the grapheme clusters there.
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
  const source = text.slice(start, end);
  // A value without weights matches where the search starts, as an empty one does.
  if (isIgnorable(value, options)) return start;
  const boundaries = searchBoundaries(source);
  const meter = meterOf(options);
  for (let index = 0; index <= source.length; index++) {
    if (boundaries[index] && matchesAt(source, value, index, boundaries, options, meter)) return start + index;
  }
  return -1;
}

/** The last index from `start` where a substring ending by `end` equals the value, as `LastIndexOf` searches. */
export function cultureLastIndexOf(
  text: string,
  value: string,
  start: number,
  end: number,
  options: CultureComparison = {}
): number {
  if (!options.ignoreCase && PLAIN.test(text) && PLAIN.test(value)) {
    // A window shorter than the value holds no match; JavaScript would clamp the negative position to 0 instead.
    if (end - value.length < start) return value === '' ? end : -1;
    const found = text.lastIndexOf(value, end - value.length);
    return found >= start ? found : -1;
  }
  const source = text.slice(start, end);
  if (isIgnorable(value, options)) return end;
  const boundaries = searchBoundaries(source);
  const meter = meterOf(options);
  for (let index = source.length; index >= 0; index--) {
    if (boundaries[index] && matchesAt(source, value, index, boundaries, options, meter)) return start + index;
  }
  return -1;
}

/**
 * Whether a text starts with a value, as .NET compares their collation elements from the start: the text's next
 * element after the value's must not be a combining one, which would belong to the last character matched.
 */
export function cultureStartsWith(text: string, value: string, options: CultureComparison = {}): boolean {
  if (!options.ignoreCase && PLAIN.test(text) && PLAIN.test(value)) return text.startsWith(value);
  const source = affixSource(text, options);
  const { compare, comparable } = comparisonOf(options, true);
  const target = comparable(affixSource(value, options));
  const meter = meterOf(options);
  const stops: number[] = [];
  for (let stop = 0; stop <= source.length; stop++) {
    if (!isInsideAffixElement(source, stop) && !startsWithCombining(source, stop, options.isInvariant))
      stops.push(stop);
  }
  const prefixAt = (index: number): string => {
    meter(stops[index] + target.length);
    return comparable(source.slice(0, stops[index]));
  };
  const base = collator(options.isInvariant, 'base');
  for (let index = firstNotBelow(stops.length, prefixAt, target, base); index < stops.length; index++) {
    const prefix = prefixAt(index);
    if (base.compare(prefix, target) !== 0) return false;
    if (compare(prefix, target) === 0) return true;
  }
  return false;
}

/**
 * The first of growing prefixes that does not sort below the value at the primary strength: a prefix sorts below
 * while its primary weights begin the value's, and its order stays once they differ, so equal prefixes start there.
 */
function firstNotBelow(
  count: number,
  prefixAt: (index: number) => string,
  target: string,
  base: Intl.Collator
): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (base.compare(prefixAt(middle), target) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Whether a text ends with a value, as .NET compares their collation elements from the end. */
export function cultureEndsWith(text: string, value: string, options: CultureComparison = {}): boolean {
  if (!options.ignoreCase && PLAIN.test(text) && PLAIN.test(value)) return text.endsWith(value);
  const source = affixSource(text, options);
  const pattern = affixSource(value, options);
  const { compare, comparable } = comparisonOf(options, true);
  const target = comparable(pattern);
  const meter = meterOf(options);
  for (const start of suffixStarts(source, pattern, options)) {
    // The text's characters weigh after the character before them, and the value's on their own, as in `matchesAt`.
    const context = contextBefore(source, start, options.isInvariant);
    meter(source.length - start + pattern.length);
    const suffix = comparable(context + source.slice(start));
    if (compare(suffix, context === '' ? target : comparable(`${context}\0${pattern}`)) === 0) return true;
  }
  return false;
}

/**
 * The positions from the end where a suffix equal to the value can start: an equal suffix has as many collation
 * elements as the value, of which a character has at most 18 and a contraction takes at most a few characters, so a
 * longer suffix with weights cannot be equal.
 */
function* suffixStarts(source: string, pattern: string, options: CultureComparison): Generator<number> {
  const longest = MAX_CHARACTERS_PER_ELEMENT * MAX_ELEMENTS_PER_CHARACTER * ([...pattern].length + 1);
  let weighted = 0;
  for (let start = source.length; start >= 0 && weighted <= longest; start--) {
    if (start < source.length && !isIgnorable(source[start], options)) weighted++;
    if (!isInsideAffixElement(source, start)) yield start;
  }
}

/** The character before a position with its combining marks, unless a combining mark starts the text. */
function contextBefore(source: string, start: number, isInvariant: boolean | undefined): string {
  let base = Math.max(0, start - 1);
  while (base > 0 && /\p{M}/u.test(source[base])) base--;
  return startsWithCombining(source, base, isInvariant) ? '' : source.slice(base, start);
}

/**
 * The text that `StartsWith` and `EndsWith` compare elements of, with each character's elements at a position of their
 * own: decomposed, and ignoring case, with a character whose elements are those of its compatibility decomposition
 * into more characters, as `ǆ` has those of `dž`, replaced by a text with the same elements.
 */
function affixSource(text: string, options: CultureComparison): string {
  const source = text.normalize('NFD');
  if (!options.ignoreCase) return source;
  let result = '';
  for (const char of source) result += expansionOf(char, options.isInvariant) ?? char;
  return result;
}

const expansions = new Map<string, string | undefined>();

/**
 * The text with the elements of a character's compatibility decomposition, which ICU's root collation gives it and
 * the culture's rules leave as they are: a kana keeps its weight before .NET's rules, which a hiragana has, without
 * the weight that ja-JP gives `ー` after a kana; ja-JP reorders the kanji, so a kanji there keeps a weight that no
 * other character has. A character that ja-JP weighs otherwise, as `ゟ`, keeps the part of its decomposition that
 * begins its weights, and a weight of its own for the rest. A decomposition whose characters ICU weighs together, as
 * `l·` of `ŀ`, stays one element.
 */
function expansionOf(char: string, isInvariant: boolean | undefined): string | undefined {
  const key = `${isInvariant === true}:${char}`;
  if (expansions.has(key)) return expansions.get(key);
  const decomposed = char.normalize('NFKD');
  const parts = [...decomposed.normalize('NFC')];
  const isExpansion =
    parts.length > 1 &&
    !TAILORED.has(char) &&
    collator(true, 'accent').compare(char, decomposed) === 0 &&
    parts.every((part, index) => index === 0 || !isContraction(parts[index - 1], part));
  const expansion = isExpansion ? cultureExpansion(char, parts, isInvariant).normalize('NFD') : undefined;
  expansions.set(key, expansion);
  return expansion;
}

function cultureExpansion(char: string, parts: string[], isInvariant: boolean | undefined): string {
  if (isInvariant) return parts.map((part) => hiraganaOf(part)).join('');
  const rootParts = parts.map((part) => (CONTEXTUAL.has(part) ? `\0${part}` : part));
  const hasKanji = parts.some((part) => /\p{Script=Han}/u.test(part));
  if (hasKanji || collator(false, 'accent').compare(char, rootParts.join('')) === 0) {
    return rootParts.map((part) => (/\p{Script=Han}/u.test(part) ? weightOfItsOwn(part) : hiraganaOf(part))).join('');
  }
  let length = parts.length - 1;
  while (length > 0 && !isPrimaryPrefix(rootParts.slice(0, length).join(''), char, false)) length--;
  return (
    rootParts
      .slice(0, length)
      .map((part) => hiraganaOf(part))
      .join('') + weightOfItsOwn(char)
  );
}

/** Whether ICU's root collation weighs two characters together, which a NUL between them keeps apart. */
function isContraction(first: string, second: string): boolean {
  return collator(true, 'variant').compare(first + second, `${first}\0${second}`) !== 0;
}

const ownWeights = new Map<string, string>();

/**
 * A character with a weight that no other character has, for a part of an expansion whose weight is none of the
 * culture's: a private-use character, one for each part.
 */
function weightOfItsOwn(part: string): string {
  let found = ownWeights.get(part);
  if (!found) {
    found = String.fromCharCode(0xe0_00 + ownWeights.size);
    ownWeights.set(part, found);
  }
  return found;
}

/**
 * Whether a substring from an index, ending between grapheme clusters, equals the value: the shortest first, while
 * the substring's primary weights begin the value's, since a longer one only adds weights. ICU's search starts a
 * match at a character with weights, and weighs the text's characters after the ones before them, as ja-JP does `ー`
 * after a kana, but the value's on their own: a NUL, which has no weights, keeps the value's first character apart.
 */
function matchesAt(
  source: string,
  value: string,
  index: number,
  boundaries: boolean[],
  options: CultureComparison,
  meter: (length: number) => void
): boolean {
  const { compare, comparable } = comparisonOf(options, true);
  if (index < source.length && isIgnorable(String.fromCodePoint(source.codePointAt(index) as number), options))
    return false;
  // The grapheme cluster before the index, which ends where the substring starts.
  let previous = Math.max(0, index - 1);
  while (previous > 0 && !boundaries[previous]) previous--;
  // A combining mark that starts the part searched has no character before it to weigh what follows.
  const context = startsWithCombining(source, previous, options.isInvariant) ? '' : source.slice(previous, index);
  const target = comparable(context === '' ? value : `${context}\0${value}`);
  for (let stop = index; stop <= source.length; stop++) {
    if (!boundaries[stop]) continue;
    meter(stop - index + target.length);
    const segment = comparable(context + source.slice(index, stop));
    if (compare(segment, target) === 0) return true;
    if (!isPrimaryPrefix(segment, target, options.isInvariant)) return false;
  }
  return false;
}

const MAX_ELEMENTS_PER_CHARACTER = 18;
const MAX_CHARACTERS_PER_ELEMENT = 4;

/** Whether a text has no weights under a comparison, as control and format characters have none. */
function isIgnorable(text: string, options: CultureComparison): boolean {
  const { compare, comparable } = comparisonOf(options);
  return compare(comparable(text), '') === 0;
}

/**
 * Whether a text's primary weights begin another's: it sorts no later than the other, and no earlier once followed
 * by U+FFFF, which outweighs every character in ICU's collations.
 */
function isPrimaryPrefix(text: string, other: string, isInvariant: boolean | undefined): boolean {
  const base = collator(isInvariant, 'base');
  return base.compare(text, other) <= 0 && base.compare(`${text}\uFFFF`, other) >= 0;
}

/**
 * The positions between the grapheme clusters of a text, where ICU's search lets a match start and end: .NET gives it
 * a break iterator whose rules also break between CR and LF.
 */
function searchBoundaries(text: string): boolean[] {
  const boundaries = Array.from({ length: text.length + 1 }, () => false);
  boundaries[text.length] = true;
  for (const { index, segment } of graphemes.segment(text)) {
    boundaries[index] = true;
    if (segment === '\r\n') boundaries[index + 1] = true;
  }
  return boundaries;
}

const graphemes = new Intl.Segmenter('ja-JP', { granularity: 'grapheme' });

/** Whether a position is inside a character, or between two that ICU's root collation weighs together. */
function isInsideAffixElement(text: string, index: number): boolean {
  if (isInsideSurrogatePair(text, index)) return true;
  if (index <= 0 || index >= text.length) return false;
  const before = String.fromCodePoint(
    text.codePointAt(index - (isInsideSurrogatePair(text, index - 1) ? 2 : 1)) as number
  );
  return isContraction(before, String.fromCodePoint(text.codePointAt(index) as number));
}

function isInsideSurrogatePair(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return index > 0 && index < text.length && code >= 0xdc_00 && code <= 0xdf_ff;
}

/** Whether the character at a position has a combining collation element: no primary weight but a secondary one. */
function startsWithCombining(text: string, index: number, isInvariant: boolean | undefined): boolean {
  if (index >= text.length) return false;
  const char = String.fromCodePoint(text.codePointAt(index) as number);
  return (
    collator(isInvariant, 'base').compare(char, '') === 0 && collator(isInvariant, 'accent').compare(char, '') !== 0
  );
}
