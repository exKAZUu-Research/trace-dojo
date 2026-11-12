import { formatString, pyFormat, pyStr } from './conversions';
import { method } from './define';
import { pyHash } from './hashing';
import { sliceIndices } from './items';
import { argument, checkArgs } from './nativeArgs';
import { toIndex } from './numbers';
import { getItem, getIterator, iterate, toArray } from './objects';
import { contains } from './operators';
import { formatPercent } from './percentFormat';
import { currentRuntime } from './runtimeContext';
import { repeatText, StringBuilder } from './stringBuilder';
import { isPrintable, iterStr, PYTHON_WHITESPACE, strLength, strRepr } from './strings';
import { hasAt, occurrences, pointIndex, unitOffset } from './strSearch';
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
  valueError,
} from './types';
import {
  capitalize,
  casefold,
  isLowerText,
  isTitleText,
  isUpperText,
  lower,
  swapcase,
  title,
  upper,
} from './unicodeCase';
import { type DONE, PyDict, PySlice, PyTuple, type PyValue } from './values';

strClass.construct = (_cls, args, kwargs) => {
  checkArgs(
    {
      qualified: 'str',
      min: 0,
      max: 3,
      // Called with keywords, str parses its arguments as a keyword parser does.
      style: kwargs && kwargs.size > 0 ? 'takes' : 'expected',
      keywords: ['object', 'encoding', 'errors'],
      named: 3,
    },
    args,
    kwargs
  );
  const value = argument(args, kwargs, 0, 'object');
  if (args.length > 1 || kwargs?.has('encoding') || kwargs?.has('errors')) {
    throw currentRuntime().unsupported('str() に encoding を渡す書き方（bytes の変換）');
  }
  return value === undefined ? '' : pyStr(value);
};

const LINE_BREAKS = '\n\r\v\f\u001C\u001D\u001E\u0085  ';
const CJK_NUMERALS = new Set('〇一二三四五六七八九十百千万億兆零壱弐参拾廿卅貳參陸伍捌玖');
const DIGIT_LIKE = /[²³¹⁰⁴-⁹₀-₉①-⑨⑴-⑼⒈-⒐⓪⓵-⓽⓿❶-❾➀-➈➊-➒]/u;

function isSpace(char: string): boolean {
  return char.length === 1 && PYTHON_WHITESPACE.test(char);
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

const asStr = (self: PyValue): string => self as string;

/** Checks that an argument is a str, raising the TypeError whose text `message` makes from the argument's type. */
function expectStr(value: PyValue, message: (type: string) => string): string {
  if (typeof value !== 'string') throw typeError(message(typeName(value)));
  return value;
}

const mustBeStr =
  (what: string) =>
  (type: string): string =>
    `${what} must be str, not ${type}`;

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
method(strClass, '__contains__', 'one', 1, 1, (self, [item]) => contains(self, item));
method(strClass, '__mod__', 'one', 1, 1, (self, [value]) => formatPercent(asStr(self), value));
method(strClass, '__format__', 'one', 1, 1, (self, [spec]) =>
  pyFormat(self, expectStr(spec, mustBeStr('__format__() argument')))
);

// Case --------------------------------------------------------------------------------------------------------------

method(strClass, 'upper', 'none', 0, 0, (self) => upper(asStr(self)));
method(strClass, 'lower', 'none', 0, 0, (self) => lower(asStr(self)));
method(strClass, 'casefold', 'none', 0, 0, (self) => casefold(asStr(self)));
method(strClass, 'swapcase', 'none', 0, 0, (self) => swapcase(asStr(self)));
method(strClass, 'capitalize', 'none', 0, 0, (self) => capitalize(asStr(self)));
method(strClass, 'title', 'none', 0, 0, (self) => title(asStr(self)));

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
method(strClass, 'isupper', 'none', 0, 0, (self) => isUpperText(asStr(self)));
method(strClass, 'islower', 'none', 0, 0, (self) => isLowerText(asStr(self)));
method(strClass, 'istitle', 'none', 0, 0, (self) => isTitleText(asStr(self)));

// Searching ---------------------------------------------------------------------------------------------------------

for (const [name, fromEnd, raises] of [
  ['find', false, false],
  ['rfind', true, false],
  ['index', false, true],
  ['rindex', true, true],
] as const) {
  method(strClass, name, 'expected', 1, 3, (self, [sub, start, end]) => {
    const index = findIn(asStr(self), expectStr(sub, mustBeStr(`${name}() argument 1`)), start, end, fromEnd);
    if (index === -1 && raises) throw valueError('substring not found');
    return BigInt(index);
  });
}

function findIn(
  text: string,
  sub: string,
  start: PyValue | undefined,
  end: PyValue | undefined,
  fromEnd: boolean
): number {
  const { length, from, to } = bounds(text, start, end);
  if (sub === '') return from <= length && to >= from ? (fromEnd ? to : from) : -1;
  if (to < from) return -1;
  const [offset] = occurrences(text, sub, {
    from: unitOffset(text, from),
    to: unitOffset(text, to),
    fromEnd,
    limit: 1,
  });
  return offset === undefined ? -1 : pointIndex(text, offset);
}

/**
 * The length in code points of a string and the bounds a `start`/`end` pair gives, adjusted as CPython's
 * ADJUST_INDICES does: unlike the bounds of a slice, `from` may exceed the length and `to` may precede `from`, and such
 * a range holds no match, not even of an empty string.
 */
function bounds(
  text: string,
  start: PyValue | undefined,
  end: PyValue | undefined
): { length: number; from: number; to: number } {
  currentRuntime().scan(text.length);
  const length = strLength(text);
  const { start: from, stop: to } = sliceIndices(new PySlice(sliceClass, start ?? None, end ?? None, None), length);
  const isBeyond = start !== undefined && start !== None && toIndex(start) > BigInt(length);
  return { length, from: isBeyond ? length + 1 : from, to };
}

method(strClass, 'count', 'expected', 1, 3, (self, [sub, start, end]) => {
  const text = asStr(self);
  const needle = expectStr(sub, mustBeStr('count() argument 1'));
  const { from, to } = bounds(text, start, end);
  if (needle === '') return BigInt(Math.max(to - from + 1, 0));
  if (to < from) return 0n;
  return BigInt(occurrences(text, needle, { from: unitOffset(text, from), to: unitOffset(text, to) }).length);
});

for (const [name, atEnd] of [
  ['startswith', false],
  ['endswith', true],
] as const) {
  method(strClass, name, 'expected', 1, 3, (self, [prefix, start, end]) => {
    const text = asStr(self);
    const { from, to } = bounds(text, start, end);
    const candidates = prefix instanceof PyTuple ? prefix.items : [prefix];
    const runtime = currentRuntime();
    const anchor = unitOffset(text, atEnd ? to : from);
    return candidates.some((candidate) => {
      if (typeof candidate !== 'string') {
        throw typeError(
          prefix instanceof PyTuple
            ? `tuple for ${name} must only contain str, not ${typeName(candidate)}`
            : `${name} first arg must be str or a tuple of str, not ${typeName(candidate)}`
        );
      }
      // Counting the candidate's code points and comparing it with the text each scan its length.
      runtime.scan(candidate.length * 2);
      if (to - strLength(candidate) < from) return false;
      return hasAt(text, candidate, atEnd ? anchor - candidate.length : anchor);
    });
  });
}

// Splitting and joining ---------------------------------------------------------------------------------------------

/** Splits at the first or, from the end, the last `limit` occurrences of `separator`, or at all for a negative one. */
function splitAt(text: string, separator: string, limit: number, fromEnd: boolean): string[] {
  const offsets = occurrences(text, separator, { fromEnd, limit: limit < 0 ? Number.POSITIVE_INFINITY : limit });
  if (fromEnd) offsets.reverse();
  const parts: string[] = [];
  let position = 0;
  for (const offset of offsets) {
    parts.push(text.slice(position, offset));
    position = offset + separator.length;
  }
  parts.push(text.slice(position));
  return parts;
}

/** Splits at runs of whitespace as CPython does: the part left after `limit` splits keeps its far end's spaces. */
function splitWhitespace(text: string, limit: number, fromEnd: boolean): string[] {
  const points = fromEnd ? iterStr(text).toReversed() : iterStr(text);
  const words: string[] = [];
  let index = 0;
  let remaining = limit < 0 ? Number.POSITIVE_INFINITY : limit;
  while (remaining-- > 0) {
    while (index < points.length && isSpace(points[index])) index++;
    if (index >= points.length) break;
    const start = index;
    while (index < points.length && !isSpace(points[index])) index++;
    words.push(points.slice(start, index).join(''));
  }
  while (index < points.length && isSpace(points[index])) index++;
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
      const separator = expectStr(sep, (type) => `must be str or None, not ${type}`);
      if (separator === '') throw valueError('empty separator');
      return newList(splitAt(text, separator, limit, fromEnd));
    },
    { keywords: ['sep', 'maxsplit'], named: 2 }
  );
}

method(
  strClass,
  'splitlines',
  'takes',
  0,
  1,
  (self, args, kwargs) => {
    const keepends = currentRuntime().truthy(argument(args, kwargs, 0, 'keepends') ?? false);
    const points = iterStr(asStr(self));
    const lines: string[] = [];
    let start = 0;
    for (let index = 0; index < points.length; index++) {
      const char = points[index];
      if (!LINE_BREAKS.includes(char)) continue;
      let end = index + 1;
      if (char === '\r' && points[index + 1] === '\n') end++;
      lines.push(points.slice(start, keepends ? end : index).join(''));
      start = end;
      index = end - 1;
    }
    if (start < points.length) lines.push(points.slice(start).join(''));
    return newList(lines);
  },
  { keywords: ['keepends'], named: 1 }
);

method(strClass, 'join', 'one', 1, 1, (self, [iterable]) => {
  const items = toArray(iterable, 'can only join an iterable');
  const separator = asStr(self);
  let length = 0;
  for (const [index, item] of items.entries()) {
    if (typeof item !== 'string')
      throw typeError(`sequence item ${index}: expected str instance, ${typeName(item)} found`);
    length += item.length + (index > 0 ? separator.length : 0);
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
    const separator = expectStr(sep, (type) => `must be str, not ${type}`);
    if (separator === '') throw valueError('empty separator');
    const [index] = occurrences(text, separator, { fromEnd, limit: 1 });
    if (index === undefined) return newTuple(fromEnd ? ['', '', text] : [text, '', '']);
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
    currentRuntime().scan(points.length);
    const strip =
      chars === undefined || chars === None
        ? isSpace
        : (
            (set: Set<string>) => (char: string) =>
              set.has(char)
          )(new Set(iterStr(expectStr(chars, () => `${name} arg must be None or str`))));
    let start = 0;
    let end = points.length;
    if (left) while (start < end && strip(points[start])) start++;
    if (right) while (end > start && strip(points[end - 1])) end--;
    return points.slice(start, end).join('');
  });
}

for (const [name, place] of [
  ['center', 'center'],
  ['ljust', 'left'],
  ['rjust', 'right'],
] as const) {
  method(strClass, name, 'expected', 1, 2, (self, [width, fill]) => {
    const text = asStr(self);
    const target = Number(toIndex(width));
    const fillChar =
      fill === undefined
        ? ' '
        : expectStr(fill, (type) => `The fill character must be a unicode character, not ${type}`);
    if (iterStr(fillChar).length !== 1) throw typeError('The fill character must be exactly one character long');
    const length = strLength(text);
    const missing = target - length;
    if (missing <= 0) return text;
    const centered = Math.floor(missing / 2) + (missing & target & 1);
    const leftPad = place === 'left' ? 0 : place === 'right' ? missing : centered;
    return new StringBuilder()
      .appendRepeated(fillChar, leftPad)
      .append(text)
      .appendRepeated(fillChar, missing - leftPad)
      .build();
  });
}

method(strClass, 'zfill', 'one', 1, 1, (self, [width]) => {
  const text = asStr(self);
  const target = Number(toIndex(width));
  const length = strLength(text);
  if (length >= target) return text;
  const signed = text.startsWith('+') || text.startsWith('-');
  const sign = signed ? text[0] : '';
  return sign + repeatText('0', target - length) + text.slice(sign.length);
});

method(
  strClass,
  'expandtabs',
  'takes',
  0,
  1,
  (self, args, kwargs) => {
    const size = Number(toIndex(argument(args, kwargs, 0, 'tabsize') ?? 8n));
    let column = 0;
    const result = new StringBuilder();
    for (const char of iterStr(asStr(self))) {
      if (char === '\t') {
        if (size > 0) {
          const spaces = size - (column % size);
          result.appendRepeated(' ', spaces);
          column += spaces;
        }
      } else {
        result.append(char);
        column = char === '\n' || char === '\r' ? 0 : column + 1;
      }
    }
    return result.build();
  },
  { keywords: ['tabsize'], named: 1 }
);

// Replacing and formatting ------------------------------------------------------------------------------------------

method(
  strClass,
  'replace',
  'takes',
  2,
  3,
  (self, args, kwargs) => {
    const text = asStr(self);
    const old = expectStr(args[0], mustBeStr('replace() argument 1'));
    const replacement = expectStr(args[1], mustBeStr('replace() argument 2'));
    let count = Number(toIndex(argument(args, kwargs, 2, 'count') ?? -1n));
    if (count < 0) count = Number.POSITIVE_INFINITY;
    const result = new StringBuilder();
    if (old === '') {
      const points = iterStr(text);
      let replaced = 0;
      for (const point of points) {
        if (replaced < count) {
          result.append(replacement);
          replaced++;
        }
        result.append(point);
      }
      if (replaced < count) result.append(replacement);
    } else {
      let position = 0;
      for (const index of occurrences(text, old, { limit: count })) {
        result.append(text.slice(position, index)).append(replacement);
        position = index + old.length;
      }
      result.append(text.slice(position));
    }
    return result.build();
  },
  { keywords: ['count'], named: 1 }
);

method(strClass, 'removeprefix', 'one', 1, 1, (self, [prefix]) => {
  const text = asStr(self);
  const value = expectStr(prefix, mustBeStr('removeprefix() argument'));
  return value !== '' && hasAt(text, value, 0) ? text.slice(value.length) : text;
});
method(strClass, 'removesuffix', 'one', 1, 1, (self, [suffix]) => {
  const text = asStr(self);
  const value = expectStr(suffix, mustBeStr('removesuffix() argument'));
  return value !== '' && hasAt(text, value, text.length - value.length) ? text.slice(0, -value.length) : text;
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
  const result = new StringBuilder();
  for (const char of iterStr(asStr(self))) {
    let mapped: PyValue;
    try {
      mapped = getItem(table, BigInt(char.codePointAt(0) as number));
    } catch (error) {
      if (currentRuntime().isLookupError(error)) {
        result.append(char);
        continue;
      }
      throw error;
    }
    if (mapped === None) continue;
    if (typeof mapped === 'bigint') result.append(String.fromCodePoint(Number(mapped)));
    else if (typeof mapped === 'string') result.append(mapped);
    else throw typeError('character mapping must return integer, None or str');
  }
  return result.build();
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
  const from = iterStr(
    expectStr(args[0], () => 'first maketrans argument must be a string if there is a second argument')
  );
  const to = iterStr(expectStr(args[1], mustBeStr('maketrans() argument 2')));
  if (from.length !== to.length) throw valueError('the first two maketrans arguments must have equal length');
  for (const [index, char] of from.entries())
    table.store.set(BigInt(char.codePointAt(0) as number), BigInt(to[index].codePointAt(0) as number));
  if (args[2] !== undefined)
    for (const char of iterStr(expectStr(args[2], mustBeStr('maketrans() argument 3'))))
      table.store.set(BigInt(char.codePointAt(0) as number), None);
  return table;
}

method(
  strClass,
  'encode',
  'takes',
  0,
  2,
  () => {
    throw currentRuntime().unsupported('str.encode()（bytes への変換）');
  },
  { keywords: ['encoding', 'errors'], named: 2 }
);

export function iterString(text: string): () => PyValue | typeof DONE {
  return iterate(text);
}

export { pyError };
