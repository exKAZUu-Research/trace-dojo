import { decodeObject } from './codecs';
import { formatString, pyFormat, pyStr } from './conversions';
import { method } from './define';
import { pyHash } from './hashing';
import { sliceIndices } from './items';
import { argument, checkArgs } from './nativeArgs';
import { toIndex } from './numbers';
import { getItem, getIterator, iterate, toArray } from './objects';
import { formatPercent } from './percentFormat';
import { currentRuntime } from './runtimeContext';
import { hasSurrogates, isPrintable, iterStr, strLength, strRepr } from './strings';
import {
  defineMethod,
  newDict,
  newList,
  newTuple,
  None,
  pyError,
  sliceClass,
  strClass,
  typeError,
  typeName,
  unbox,
  valueError,
} from './types';
import { type DONE, PyDict, PySlice, PyTuple, type PyValue } from './values';

strClass.construct = (_cls, args, kwargs) => {
  checkArgs(
    { qualified: 'str', min: 0, max: 3, style: 'expected', keywords: ['object', 'encoding', 'errors'] },
    args,
    kwargs
  );
  const value = argument(args, kwargs, 0, 'object');
  const encoding = argument(args, kwargs, 1, 'encoding');
  const errors = argument(args, kwargs, 2, 'errors');
  if (encoding !== undefined || errors !== undefined) return decodeObject(value ?? '', encoding, errors);
  return value === undefined ? '' : pyStr(value);
};

// oxlint-disable-next-line eslint/no-control-regex -- Python counts these separators as whitespace.
const PYTHON_SPACE = /^[\s\u001C-\u001F\u0085]$/u;
const WHITESPACE_CHARS = ' \t\n\r\v\f\u001C\u001D\u001E\u001F\u0085                 　';
const LINE_BREAKS = '\n\r\v\f\u001C\u001D\u001E\u0085  ';
const CJK_NUMERALS = new Set('〇一二三四五六七八九十百千万億兆零壱弐参拾廿卅貳參陸伍捌玖');
const DIGIT_LIKE = /[²³¹⁰⁴-⁹₀-₉①-⑨⑴-⑼⒈-⒐⓪⓵-⓽⓿❶-❾➀-➈➊-➒]/u;

export function isSpace(char: string): boolean {
  return PYTHON_SPACE.test(char) || WHITESPACE_CHARS.includes(char);
}

function isDecimal(char: string): boolean {
  return /\p{Nd}/u.test(char);
}

function isDigit(char: string): boolean {
  return isDecimal(char) || DIGIT_LIKE.test(char);
}

function isNumeric(char: string): boolean {
  return /\p{N}/u.test(char) || CJK_NUMERALS.has(char);
}

function isAlpha(char: string): boolean {
  return /\p{L}/u.test(char);
}

function isCased(char: string): boolean {
  return char.toLowerCase() !== char.toUpperCase() || /\p{Lt}/u.test(char);
}

function isUpperChar(char: string): boolean {
  return /\p{Lu}|\p{Lt}/u.test(char) || (isCased(char) && char === char.toUpperCase() && char !== char.toLowerCase());
}

function isLowerChar(char: string): boolean {
  return /\p{Ll}/u.test(char) || (isCased(char) && char === char.toLowerCase() && char !== char.toUpperCase());
}

const asStr = (self: PyValue): string => self as string;

function expectStr(value: PyValue, what: string): string {
  if (typeof value !== 'string') throw typeError(`${what} must be str, not ${typeName(value)}`);
  return value;
}

function every(text: string, test: (char: string) => boolean): boolean {
  const chars = iterStr(text);
  currentRuntime().scan(chars.length);
  return chars.length > 0 && chars.every(test);
}

// Basic protocol ----------------------------------------------------------------------------------------------------

method(strClass, '__repr__', 'none', 0, 0, (self) => strRepr(asStr(self)));
method(strClass, '__str__', 'none', 0, 0, (self) => self);
method(strClass, '__hash__', 'none', 0, 0, (self) => pyHash(self));
method(strClass, '__len__', 'none', 0, 0, (self) => BigInt(strLength(asStr(self))));
method(strClass, '__getitem__', 'one', 1, 1, (self, [key]) => getItem(self, key));
method(strClass, '__iter__', 'none', 0, 0, (self) => getIterator(self));
method(strClass, '__contains__', 'one', 1, 1, (self, [item]) =>
  asStr(self).includes(expectStr(item, "'in <string>' requires string as left operand, not"))
);
method(strClass, '__mod__', 'one', 1, 1, (self, [value]) => formatPercent(asStr(self), value));
method(strClass, '__format__', 'one', 1, 1, (self, [spec]) => pyFormat(self, expectStr(spec, 'format spec')));

// Case --------------------------------------------------------------------------------------------------------------

method(strClass, 'upper', 'none', 0, 0, (self) => asStr(self).toUpperCase());
method(strClass, 'lower', 'none', 0, 0, (self) => asStr(self).toLowerCase());
method(strClass, 'casefold', 'none', 0, 0, (self) =>
  asStr(self).toLowerCase().replaceAll('ß', 'ss').replaceAll('ς', 'σ')
);
method(strClass, 'swapcase', 'none', 0, 0, (self) =>
  iterStr(asStr(self))
    .map((char) => (isUpperChar(char) ? char.toLowerCase() : isLowerChar(char) ? char.toUpperCase() : char))
    .join('')
);
method(strClass, 'capitalize', 'none', 0, 0, (self) => {
  const [first = '', ...rest] = iterStr(asStr(self));
  return titleCase(first) + rest.join('').toLowerCase();
});
method(strClass, 'title', 'none', 0, 0, (self) => {
  let previousCased = false;
  let result = '';
  for (const char of iterStr(asStr(self))) {
    result += previousCased ? char.toLowerCase() : titleCase(char);
    previousCased = isCased(char);
  }
  return result;
});

/** The titlecase form of a character, which differs from its uppercase for digraphs such as ǆ. */
function titleCase(char: string): string {
  const special: Record<string, string> = { ǆ: 'ǅ', Ǆ: 'ǅ', ǉ: 'ǈ', Ǉ: 'ǈ', ǌ: 'ǋ', Ǌ: 'ǋ', ǳ: 'ǲ', Ǳ: 'ǲ', ß: 'Ss' };
  return special[char] ?? char.toUpperCase();
}

// Predicates --------------------------------------------------------------------------------------------------------

method(strClass, 'isalpha', 'none', 0, 0, (self) => every(asStr(self), isAlpha));
method(strClass, 'isdecimal', 'none', 0, 0, (self) => every(asStr(self), isDecimal));
method(strClass, 'isdigit', 'none', 0, 0, (self) => every(asStr(self), isDigit));
method(strClass, 'isnumeric', 'none', 0, 0, (self) => every(asStr(self), isNumeric));
method(strClass, 'isalnum', 'none', 0, 0, (self) =>
  every(asStr(self), (char) => isAlpha(char) || isNumeric(char) || isDigit(char))
);
method(strClass, 'isspace', 'none', 0, 0, (self) => every(asStr(self), isSpace));
// oxlint-disable-next-line eslint/no-control-regex -- ASCII includes the control characters.
method(strClass, 'isascii', 'none', 0, 0, (self) => /^[\u0000-\u007F]*$/.test(asStr(self)));
method(strClass, 'isprintable', 'none', 0, 0, (self) => iterStr(asStr(self)).every(isPrintable));
method(strClass, 'isidentifier', 'none', 0, 0, (self) => /^[\p{XID_Start}_][\p{XID_Continue}]*$/u.test(asStr(self)));
method(strClass, 'isupper', 'none', 0, 0, (self) => {
  const cased = iterStr(asStr(self)).filter(isCased);
  return cased.length > 0 && cased.every((char) => !isLowerChar(char));
});
method(strClass, 'islower', 'none', 0, 0, (self) => {
  const cased = iterStr(asStr(self)).filter(isCased);
  return cased.length > 0 && cased.every((char) => !isUpperChar(char));
});
method(strClass, 'istitle', 'none', 0, 0, (self) => isTitleText(iterStr(asStr(self)), isUpperChar, isLowerChar));

/** Whether a text is titlecased: uppercase only after uncased characters and lowercase only after cased ones. */
export function isTitleText(
  chars: Iterable<string>,
  isUpper: (char: string) => boolean,
  isLower: (char: string) => boolean
): boolean {
  let previousCased = false;
  let sawCased = false;
  for (const char of chars) {
    if (isUpper(char)) {
      if (previousCased) return false;
      previousCased = true;
      sawCased = true;
    } else if (isLower(char)) {
      if (!previousCased) return false;
      previousCased = true;
      sawCased = true;
    } else {
      previousCased = false;
    }
  }
  return sawCased;
}

// Searching ---------------------------------------------------------------------------------------------------------

/** The code points of a string and the bounds a `start`/`end` pair gives, as slice indices clamp them. */
function bounds(
  text: string,
  start: PyValue | undefined,
  end: PyValue | undefined
): { points: string[]; from: number; to: number } {
  const points = iterStr(text);
  const { start: from, stop } = sliceIndices(new PySlice(sliceClass, start ?? None, end ?? None, None), points.length);
  return { points, from, to: Math.max(from, stop) };
}

// code-gauge-allow functionCognitiveComplexity 20 -- Follows str.find's slice arguments and empty-substring cases.
function findIn(
  text: string,
  sub: string,
  start: PyValue | undefined,
  end: PyValue | undefined,
  fromEnd: boolean
): number {
  const { points, from, to } = bounds(text, start, end);
  currentRuntime().scan(points.length);
  if (!hasSurrogates(text) && !hasSurrogates(sub)) {
    if (to - from < sub.length)
      return sub.length === 0 && from <= points.length && to >= from ? (fromEnd ? to : from) : -1;
    const region = text.slice(from, to);
    const index = fromEnd ? region.lastIndexOf(sub) : region.indexOf(sub);
    return index === -1 ? -1 : index + from;
  }
  const subPoints = iterStr(sub);
  const positions = fromEnd ? rangeDown(to - subPoints.length, from) : rangeUp(from, to - subPoints.length);
  for (const position of positions) {
    if (subPoints.every((char, offset) => points[position + offset] === char)) return position;
  }
  return -1;
}

function rangeUp(from: number, to: number): number[] {
  const result: number[] = [];
  for (let index = from; index <= to; index++) result.push(index);
  return result;
}

function rangeDown(from: number, to: number): number[] {
  return rangeUp(to, from).toReversed();
}

for (const [name, fromEnd, raises] of [
  ['find', false, false],
  ['rfind', true, false],
  ['index', false, true],
  ['rindex', true, true],
] as const) {
  method(strClass, name, 'expected', 1, 3, (self, [sub, start, end]) => {
    const index = findIn(asStr(self), expectStr(sub, `${name}() argument 1`), start, end, fromEnd);
    if (index === -1 && raises) throw valueError('substring not found');
    return BigInt(index);
  });
}

method(strClass, 'count', 'expected', 1, 3, (self, [sub, start, end]) => {
  const needle = expectStr(sub, 'count() argument 1');
  const { points, from, to } = bounds(asStr(self), start, end);
  currentRuntime().scan(points.length);
  if (needle === '') return BigInt(to - from + 1);
  const region = points.slice(from, to).join('');
  let count = 0n;
  for (let index = region.indexOf(needle); index !== -1; index = region.indexOf(needle, index + needle.length)) count++;
  return count;
});

for (const [name, atEnd] of [
  ['startswith', false],
  ['endswith', true],
] as const) {
  method(strClass, name, 'expected', 1, 3, (self, [prefix, start, end]) => {
    const { points, from, to } = bounds(asStr(self), start, end);
    const region = points.slice(from, to).join('');
    const candidates = prefix instanceof PyTuple ? prefix.items.map(unbox) : [prefix];
    return candidates.some((candidate) => {
      if (typeof candidate !== 'string') {
        throw typeError(
          prefix instanceof PyTuple
            ? `tuple for ${name} must only contain str, not ${typeName(candidate)}`
            : `${name} first arg must be str or a tuple of str, not ${typeName(candidate)}`
        );
      }
      if (from > points.length) return false;
      return atEnd ? region.endsWith(candidate) : region.startsWith(candidate);
    });
  });
}

// Splitting and joining ---------------------------------------------------------------------------------------------

/**
 * Splits at runs of whitespace, as `isSeparator` tells it, as CPython does: the part left after `limit` splits keeps
 * its far end's spaces.
 */
export function splitWhitespace(
  text: string,
  limit: number,
  fromEnd: boolean,
  isSeparator: (char: string) => boolean = isSpace
): string[] {
  const points = fromEnd ? iterStr(text).toReversed() : iterStr(text);
  const words: string[] = [];
  let index = 0;
  let remaining = limit < 0 ? Number.POSITIVE_INFINITY : limit;
  while (remaining-- > 0) {
    while (index < points.length && isSeparator(points[index])) index++;
    if (index >= points.length) break;
    const start = index;
    while (index < points.length && !isSeparator(points[index])) index++;
    words.push(points.slice(start, index).join(''));
  }
  while (index < points.length && isSeparator(points[index])) index++;
  if (index < points.length) words.push(points.slice(index).join(''));
  if (!fromEnd) return words;
  return words.map((word) => iterStr(word).toReversed().join('')).toReversed();
}

for (const [name, fromEnd] of [
  ['split', false],
  ['rsplit', true],
] as const) {
  method(
    strClass,
    name,
    'takes',
    0,
    2,
    (self, args, kwargs) => {
      const sep = argument(args, kwargs, 0, 'sep') ?? None;
      const limit = Number(toIndex(argument(args, kwargs, 1, 'maxsplit') ?? -1n));
      const text = asStr(self);
      currentRuntime().scan(text.length);
      if (sep === None) return newList(splitWhitespace(text, limit, fromEnd));
      const separator = expectStr(sep, 'must be str or None, not');
      if (separator === '') throw valueError('empty separator');
      return newList(splitOn(text, separator, limit, fromEnd));
    },
    { keywords: ['sep', 'maxsplit'] }
  );
}

/** Splits at a separator at most `limit` times, counting from the end when `fromEnd`, as str.rsplit does. */
export function splitOn(text: string, separator: string, limit: number, fromEnd: boolean): string[] {
  const parts = text.split(separator);
  if (limit < 0 || parts.length - 1 <= limit) return parts;
  if (!fromEnd) return [...parts.slice(0, limit), parts.slice(limit).join(separator)];
  return [parts.slice(0, parts.length - limit).join(separator), ...parts.slice(parts.length - limit)];
}

method(
  strClass,
  'splitlines',
  'takes',
  0,
  1,
  (self, args, kwargs) => {
    const keepends = currentRuntime().truthy(argument(args, kwargs, 0, 'keepends') ?? false);
    return newList(splitLinesOf(iterStr(asStr(self)), (char) => LINE_BREAKS.includes(char), keepends));
  },
  { keywords: ['keepends'] }
);

/** The lines of a text, which end at each character `isBreak` accepts, a \r\n ending as one. */
export function splitLinesOf(
  points: readonly string[],
  isBreak: (char: string) => boolean,
  keepends: boolean
): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < points.length; index++) {
    const char = points[index];
    if (!isBreak(char)) continue;
    let end = index + 1;
    if (char === '\r' && points[index + 1] === '\n') end++;
    lines.push(points.slice(start, keepends ? end : index).join(''));
    start = end;
    index = end - 1;
  }
  if (start < points.length) lines.push(points.slice(start).join(''));
  return lines;
}

method(strClass, 'join', 'one', 1, 1, (self, [iterable]) => {
  const items = toArray(iterable).map(unbox);
  const separator = asStr(self);
  let length = 0;
  for (const [index, item] of items.entries()) {
    if (typeof item !== 'string')
      throw typeError(`sequence item ${index}: expected str instance, ${typeName(item)} found`);
    length += item.length + separator.length;
  }
  currentRuntime().buildString(length);
  return (items as string[]).join(separator);
});

for (const [name, fromEnd] of [
  ['partition', false],
  ['rpartition', true],
] as const) {
  method(strClass, name, 'one', 1, 1, (self, [sep]) => {
    const text = asStr(self);
    const separator = expectStr(sep, 'must be str, not');
    if (separator === '') throw valueError('empty separator');
    const index = fromEnd ? text.lastIndexOf(separator) : text.indexOf(separator);
    if (index === -1) return newTuple(fromEnd ? ['', '', text] : [text, '', '']);
    return newTuple([text.slice(0, index), separator, text.slice(index + separator.length)]);
  });
}

// Stripping and padding ---------------------------------------------------------------------------------------------

for (const [name, left, right] of [
  ['strip', true, true],
  ['lstrip', true, false],
  ['rstrip', false, true],
] as const) {
  method(strClass, name, 'expected', 0, 1, (self, [chars]) => {
    const points = iterStr(asStr(self));
    const strip =
      chars === undefined || chars === None
        ? isSpace
        : (
            (set: Set<string>) => (char: string) =>
              set.has(char)
          )(new Set(iterStr(expectStr(chars, `${name} arg must be None or str, not`))));
    const [start, end] = stripBounds(points, strip, left, right);
    return points.slice(start, end).join('');
  });
}

/** The bounds of what remains after stripping the items `strip` accepts from the left and the right ends. */
export function stripBounds<T>(
  items: ArrayLike<T>,
  strip: (item: T) => boolean,
  left: boolean,
  right: boolean
): [number, number] {
  let start = 0;
  let end = items.length;
  if (left) while (start < end && strip(items[start])) start++;
  if (right) while (end > start && strip(items[end - 1])) end--;
  return [start, end];
}

for (const [name, place] of [
  ['center', 'center'],
  ['ljust', 'left'],
  ['rjust', 'right'],
] as const) {
  method(strClass, name, 'expected', 1, 2, (self, [width, fill]) => {
    const text = asStr(self);
    const target = Number(toIndex(width));
    const fillChar = fill === undefined ? ' ' : expectStr(fill, `${name}() argument 2`);
    if (iterStr(fillChar).length !== 1) throw typeError('The fill character must be exactly one character long');
    return padText(text, strLength(text), target, fillChar, place);
  });
}

/** Pads a text of `length` characters to `target` with `fillChar`, as str.center, str.ljust, and str.rjust do. */
export function padText(
  text: string,
  length: number,
  target: number,
  fillChar: string,
  place: 'center' | 'left' | 'right'
): string {
  const missing = target - length;
  if (missing <= 0) return text;
  currentRuntime().buildString(target);
  if (place === 'left') return text + fillChar.repeat(missing);
  if (place === 'right') return fillChar.repeat(missing) + text;
  const leftPad = Math.floor(missing / 2) + (missing & target & 1);
  return fillChar.repeat(leftPad) + text + fillChar.repeat(missing - leftPad);
}

method(strClass, 'zfill', 'one', 1, 1, (self, [width]) => {
  const text = asStr(self);
  const target = Number(toIndex(width));
  const length = strLength(text);
  if (length >= target) return text;
  const signed = text.startsWith('+') || text.startsWith('-');
  const sign = signed ? text[0] : '';
  return sign + '0'.repeat(target - length) + text.slice(sign.length);
});

method(
  strClass,
  'expandtabs',
  'takes',
  0,
  1,
  (self, args, kwargs) => {
    return expandTabs(iterStr(asStr(self)), Number(toIndex(argument(args, kwargs, 0, 'tabsize') ?? 8n)));
  },
  { keywords: ['tabsize'] }
);

/** Replaces each tab with the spaces up to the next multiple of `size` columns, as str.expandtabs does. */
export function expandTabs(chars: Iterable<string>, size: number): string {
  let column = 0;
  let result = '';
  for (const char of chars) {
    if (char === '\t') {
      if (size > 0) {
        const spaces = size - (column % size);
        result += ' '.repeat(spaces);
        column += spaces;
      }
    } else {
      result += char;
      column = char === '\n' || char === '\r' ? 0 : column + 1;
    }
  }
  currentRuntime().buildString(result.length);
  return result;
}

// Replacing and formatting ------------------------------------------------------------------------------------------

method(
  strClass,
  'replace',
  'takes',
  2,
  3,
  (self, args, kwargs) => {
    const text = asStr(self);
    const old = expectStr(args[0], 'replace() argument 1');
    const replacement = expectStr(args[1], 'replace() argument 2');
    const count = Number(toIndex(argument(args, kwargs, 2, 'count') ?? -1n));
    return replaceText(text, old, replacement, count);
  },
  { keywords: ['count'] }
);

/** Replaces the first `count` occurrences of `old`, or all of them when `count` is negative, as str.replace does. */
export function replaceText(text: string, old: string, replacement: string, limit: number): string {
  const count = limit < 0 ? Number.POSITIVE_INFINITY : limit;
  let result = '';
  if (old === '') {
    const points = iterStr(text);
    let replaced = 0;
    for (const point of points) {
      if (replaced < count) {
        result += replacement;
        replaced++;
      }
      result += point;
    }
    if (replaced < count) result += replacement;
  } else {
    let position = 0;
    let replaced = 0;
    for (let index = text.indexOf(old); index !== -1 && replaced < count; index = text.indexOf(old, position)) {
      result += text.slice(position, index) + replacement;
      position = index + old.length;
      replaced++;
      currentRuntime().buildString(result.length);
    }
    result += text.slice(position);
  }
  currentRuntime().buildString(result.length);
  return result;
}

method(strClass, 'removeprefix', 'one', 1, 1, (self, [prefix]) => {
  const text = asStr(self);
  const value = expectStr(prefix, 'removeprefix() argument');
  return value !== '' && text.startsWith(value) ? text.slice(value.length) : text;
});
method(strClass, 'removesuffix', 'one', 1, 1, (self, [suffix]) => {
  const text = asStr(self);
  const value = expectStr(suffix, 'removesuffix() argument');
  return value !== '' && text.endsWith(value) ? text.slice(0, -value.length) : text;
});

defineMethod(strClass, 'format', (self, args, kwargs) =>
  formatString(asStr(self), args, (name) => {
    const value = kwargs?.get(name);
    if (value === undefined) throw currentRuntime().keyError(name);
    return value;
  })
);
method(strClass, 'format_map', 'one', 1, 1, (self, [mapping]) =>
  formatString(asStr(self), [], (name) => getItem(mapping, name))
);

method(strClass, 'maketrans', 'expected', 1, 3, (_self, args) => makeTranslation(args), { binding: 'static' });
method(strClass, 'translate', 'one', 1, 1, (self, [table]) => {
  let result = '';
  for (const char of iterStr(asStr(self))) {
    let mapped: PyValue;
    try {
      mapped = getItem(table, BigInt(char.codePointAt(0) as number));
    } catch (error) {
      if (currentRuntime().isLookupError(error)) {
        result += char;
        continue;
      }
      throw error;
    }
    if (mapped === None) continue;
    if (typeof mapped === 'bigint') result += String.fromCodePoint(Number(mapped));
    else if (typeof mapped === 'string') result += mapped;
    else throw typeError('character mapping must return integer, None or str');
  }
  return result;
});

// code-gauge-allow functionCognitiveComplexity 17 -- Follows str.maketrans for its one-, two-, and three-argument forms.
function makeTranslation(args: PyValue[]): PyDict {
  const table = newDict();
  if (args.length === 1) {
    const [mapping] = args;
    if (!(mapping instanceof PyDict)) throw typeError('if you give only one argument to maketrans it must be a dict');
    for (const entry of mapping.store.ordered()) {
      const key = typeof entry.key === 'string' ? BigInt(entry.key.codePointAt(0) as number) : entry.key;
      if (typeof entry.key === 'string' && strLength(entry.key) !== 1)
        throw valueError('string keys in translate table must be of length 1');
      table.store.set(key, entry.value);
    }
    return table;
  }
  const from = iterStr(expectStr(args[0], 'maketrans() argument 1'));
  const to = iterStr(expectStr(args[1], 'maketrans() argument 2'));
  if (from.length !== to.length) throw valueError('the first two maketrans arguments must have equal length');
  for (const [index, char] of from.entries())
    table.store.set(BigInt(char.codePointAt(0) as number), BigInt(to[index].codePointAt(0) as number));
  if (args[2] !== undefined)
    for (const char of iterStr(expectStr(args[2], 'maketrans() argument 3')))
      table.store.set(BigInt(char.codePointAt(0) as number), None);
  return table;
}

export function iterString(text: string): () => PyValue | typeof DONE {
  return iterate(text);
}

export { pyError };
