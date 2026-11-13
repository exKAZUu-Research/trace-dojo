import { decodeObject } from './codecs';
import { formatString, pyFormat, pyStr } from './conversions';
import { method } from './define';
import { pyHash } from './hashing';
import { sliceIndices } from './items';
import { argument, checkArgs } from './nativeArgs';
import { toIndex } from './numbers';
import { builtinIterator, getItem, iterate, toArray } from './objects';
import { contains } from './operators';
import { formatPercent } from './percentFormat';
import { currentRuntime } from './runtimeContext';
import { repeatText, StringBuilder } from './stringBuilder';
import { codePointIndex, codePointOffset, isSpaceCode, iterStr, strLength, strRepr } from './strings';
import { hasAt, occurrences } from './strSearch';
import {
  argumentTypeName,
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
import {
  capitalize,
  casefold,
  everyCode,
  isLowerText,
  isTitleText as isTitleStr,
  isUpperText,
  lower,
  swapcase,
  title,
  upper,
} from './unicodeCase';
import {
  isAlphaCode,
  isDecimalCode,
  isDigitCode,
  isIdentifierContinueCode,
  isIdentifierStartCode,
  isNumericCode,
  isPrintableCode,
} from './unicodeClasses';
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
  const encoding = argument(args, kwargs, 1, 'encoding');
  const errors = argument(args, kwargs, 2, 'errors');
  if (encoding !== undefined || errors !== undefined) return decodeObject(value ?? '', encoding, errors);
  return value === undefined ? '' : pyStr(value);
};

const LINE_BREAKS = '\n\r\v\f\u001C\u001D\u001E\u0085  ';

export function isSpace(char: string): boolean {
  return isSpaceCode(char.codePointAt(0) as number);
}

const asStr = (self: PyValue): string => self as string;

/** Checks that an argument is a str, raising the TypeError whose text `message` makes from the argument's type. */
function expectStr(value: PyValue, message: (type: string) => string): string {
  if (typeof value !== 'string') throw typeError(message(typeName(value)));
  return value;
}

/** Checks a str argument that Argument Clinic converts, raising its TypeError naming the argument as `what`. */
function expectStrArgument(value: PyValue, what: string): string {
  if (typeof value !== 'string') throw typeError(`${what} must be str, not ${argumentTypeName(value)}`);
  return value;
}

/** The text of a str receiver whose characters a native loop is about to visit, charged for all of them. */
function scanned(self: PyValue): string {
  const text = asStr(self);
  currentRuntime().scan(text.length);
  return text;
}

/** Whether a text is nonempty and every character passes a test, read lazily and charged as everyCode charges. */
function every(text: string, test: (code: number) => boolean): boolean {
  return text !== '' && everyCode(text, test);
}

// Basic protocol ----------------------------------------------------------------------------------------------------

method(strClass, '__repr__', 'none', 0, 0, (self) => strRepr(asStr(self)));
method(strClass, '__str__', 'none', 0, 0, (self) => self);
method(strClass, '__hash__', 'none', 0, 0, (self) => pyHash(self));
method(strClass, '__len__', 'none', 0, 0, (self) => BigInt(strLength(asStr(self))));
method(strClass, '__getitem__', 'one', 1, 1, (self, [key]) => getItem(self, key));
method(strClass, '__iter__', 'none', 0, 0, (self) => builtinIterator(self));
method(strClass, '__contains__', 'one', 1, 1, (self, [item]) => contains(self, item));
method(strClass, '__mod__', 'one', 1, 1, (self, [value]) => formatPercent(asStr(self), value));
method(strClass, '__format__', 'one', 1, 1, (self, [spec]) =>
  pyFormat(self, expectStrArgument(spec, '__format__() argument'))
);

// Case --------------------------------------------------------------------------------------------------------------

method(strClass, 'upper', 'none', 0, 0, (self) => upper(asStr(self)));
method(strClass, 'lower', 'none', 0, 0, (self) => lower(asStr(self)));
method(strClass, 'casefold', 'none', 0, 0, (self) => casefold(asStr(self)));
method(strClass, 'swapcase', 'none', 0, 0, (self) => swapcase(asStr(self)));
method(strClass, 'capitalize', 'none', 0, 0, (self) => capitalize(asStr(self)));
method(strClass, 'title', 'none', 0, 0, (self) => title(asStr(self)));

// Predicates --------------------------------------------------------------------------------------------------------

method(strClass, 'isalpha', 'none', 0, 0, (self) => every(asStr(self), isAlphaCode));
method(strClass, 'isdecimal', 'none', 0, 0, (self) => every(asStr(self), isDecimalCode));
method(strClass, 'isdigit', 'none', 0, 0, (self) => every(asStr(self), isDigitCode));
method(strClass, 'isnumeric', 'none', 0, 0, (self) => every(asStr(self), isNumericCode));
method(strClass, 'isalnum', 'none', 0, 0, (self) =>
  every(asStr(self), (code) => isAlphaCode(code) || isNumericCode(code) || isDigitCode(code))
);
method(strClass, 'isspace', 'none', 0, 0, (self) => every(asStr(self), isSpaceCode));
// oxlint-disable-next-line eslint/no-control-regex -- ASCII includes the control characters.
method(strClass, 'isascii', 'none', 0, 0, (self) => everyCode(asStr(self), (code) => code < 0x80));
method(strClass, 'isprintable', 'none', 0, 0, (self) => everyCode(asStr(self), isPrintableCode));
method(strClass, 'isidentifier', 'none', 0, 0, (self) => {
  const text = asStr(self);
  let first = true;
  return (
    text !== '' &&
    everyCode(text, (code) => {
      const isValid = first ? isIdentifierStartCode(code) : isIdentifierContinueCode(code);
      first = false;
      return isValid;
    })
  );
});
method(strClass, 'isupper', 'none', 0, 0, (self) => isUpperText(asStr(self)));
method(strClass, 'islower', 'none', 0, 0, (self) => isLowerText(asStr(self)));
method(strClass, 'istitle', 'none', 0, 0, (self) => isTitleStr(asStr(self)));

// Searching ---------------------------------------------------------------------------------------------------------

for (const [name, fromEnd, raises] of [
  ['find', false, false],
  ['rfind', true, false],
  ['index', false, true],
  ['rindex', true, true],
] as const) {
  method(strClass, name, 'expected', 1, 3, (self, [sub, start, end]) => {
    const index = findIn(asStr(self), expectStrArgument(sub, `${name}() argument 1`), start, end, fromEnd);
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
    from: codePointOffset(text, from),
    to: codePointOffset(text, to),
    fromEnd,
    limit: 1,
  });
  return offset === undefined ? -1 : codePointIndex(text, offset);
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
  const length = strLength(text);
  const { start: from, stop: to } = sliceIndices(new PySlice(sliceClass, start ?? None, end ?? None, None), length);
  const isBeyond = start !== undefined && start !== None && toIndex(start) > BigInt(length);
  return { length, from: isBeyond ? length + 1 : from, to };
}

method(strClass, 'count', 'expected', 1, 3, (self, [sub, start, end]) => {
  const text = asStr(self);
  const needle = expectStrArgument(sub, 'count() argument 1');
  const { from, to } = bounds(text, start, end);
  if (needle === '') return BigInt(Math.max(to - from + 1, 0));
  if (to < from) return 0n;
  return BigInt(occurrences(text, needle, { from: codePointOffset(text, from), to: codePointOffset(text, to) }).length);
});

for (const [name, atEnd] of [
  ['startswith', false],
  ['endswith', true],
] as const) {
  method(strClass, name, 'expected', 1, 3, (self, [prefix, start, end]) => {
    const text = asStr(self);
    const { from, to } = bounds(text, start, end);
    const candidates = prefix instanceof PyTuple ? prefix.items : [prefix];
    const anchor = codePointOffset(text, atEnd ? to : from);
    return candidates.some((raw) => {
      const candidate = unbox(raw);
      if (typeof candidate !== 'string') {
        throw typeError(
          prefix instanceof PyTuple
            ? `tuple for ${name} must only contain str, not ${typeName(raw)}`
            : `${name} first arg must be str or a tuple of str, not ${typeName(raw)}`
        );
      }
      if (to - strLength(candidate) < from) return false;
      return hasAt(text, candidate, atEnd ? anchor - candidate.length : anchor);
    });
  });
}

// Splitting and joining ---------------------------------------------------------------------------------------------

/** Splits at the first or, from the end, the last `limit` occurrences of `separator`, or at all for a negative one. */
export function splitOn(text: string, separator: string, limit: number, fromEnd: boolean): string[] {
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
      if (sep === None) {
        currentRuntime().scan(text.length);
        return newList(splitWhitespace(text, limit, fromEnd));
      }
      const separator = expectStr(sep, (type) => `must be str or None, not ${type}`);
      if (separator === '') throw valueError('empty separator');
      // No split leaves the text as it is without looking at it.
      if (limit === 0) return newList([text]);
      return newList(splitOn(text, separator, limit, fromEnd));
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
    return newList(splitLinesOf(iterStr(scanned(self)), (char) => LINE_BREAKS.includes(char), keepends));
  },
  { keywords: ['keepends'], named: 1 }
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
  const items = toArray(iterable, 'can only join an iterable');
  const separator = asStr(self);
  let length = 0;
  const parts: string[] = [];
  for (const [index, raw] of items.entries()) {
    const item = unbox(raw);
    if (typeof item !== 'string')
      throw typeError(`sequence item ${index}: expected str instance, ${typeName(raw)} found`);
    length += item.length + (index > 0 ? separator.length : 0);
    parts.push(item);
  }
  currentRuntime().buildString(length);
  return parts.join(separator);
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
    const fillChar =
      fill === undefined
        ? ' '
        : expectStr(fill, (type) => `The fill character must be a unicode character, not ${type}`);
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
  const centered = Math.floor(missing / 2) + (missing & target & 1);
  const leftPad = place === 'left' ? 0 : place === 'right' ? missing : centered;
  return new StringBuilder()
    .appendRepeated(fillChar, leftPad)
    .append(text)
    .appendRepeated(fillChar, missing - leftPad)
    .build();
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
    return expandTabs(iterStr(asStr(self)), Number(toIndex(argument(args, kwargs, 0, 'tabsize') ?? 8n)));
  },
  { keywords: ['tabsize'], named: 1 }
);

/** Replaces each tab with the spaces up to the next multiple of `size` columns, as str.expandtabs does. */
export function expandTabs(chars: Iterable<string>, size: number): string {
  let column = 0;
  const result = new StringBuilder();
  for (const char of chars) {
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
    const old = expectStrArgument(args[0], 'replace() argument 1');
    const replacement = expectStrArgument(args[1], 'replace() argument 2');
    const count = Number(toIndex(argument(args, kwargs, 2, 'count') ?? -1n));
    return replaceText(text, old, replacement, count);
  },
  { keywords: ['count'], named: 1 }
);

/** Replaces the first `count` occurrences of `old`, or all of them when `count` is negative, as str.replace does. */
export function replaceText(text: string, old: string, replacement: string, limit: number): string {
  const count = limit < 0 ? Number.POSITIVE_INFINITY : limit;
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
}

method(strClass, 'removeprefix', 'one', 1, 1, (self, [prefix]) => {
  const text = asStr(self);
  const value = expectStrArgument(prefix, 'removeprefix() argument');
  return value !== '' && hasAt(text, value, 0) ? text.slice(value.length) : text;
});
method(strClass, 'removesuffix', 'one', 1, 1, (self, [suffix]) => {
  const text = asStr(self);
  const value = expectStrArgument(suffix, 'removesuffix() argument');
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
  formatString(asStr(self), undefined, (name) => getItem(mapping, name))
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
    result.append(translation(mapped));
  }
  return result.build();
});

/** The text a translation table maps a character to: an integer as its character, None as nothing, or a string. */
function translation(mapped: PyValue): string {
  if (mapped === None) return '';
  if (typeof mapped === 'string') return mapped;
  if (typeof mapped !== 'bigint' && typeof mapped !== 'boolean') {
    throw typeError('character mapping must return integer, None or str');
  }
  const code = BigInt(mapped);
  if (code < 0n || code > 0x10_ff_ffn) throw valueError('character mapping must be in range(0x110000)');
  return String.fromCodePoint(Number(code));
}

function makeTranslation(args: PyValue[]): PyDict {
  const table = newDict();
  if (args.length === 1) {
    const [mapping] = args;
    if (!(mapping instanceof PyDict)) throw typeError('if you give only one argument to maketrans it must be a dict');
    for (const entry of mapping.store.ordered()) table.store.set(translationKey(entry.key), entry.value);
    return table;
  }
  const from = iterStr(
    expectStr(args[0], () => 'first maketrans argument must be a string if there is a second argument')
  );
  const to = iterStr(expectStrArgument(args[1], 'maketrans() argument 2'));
  if (from.length !== to.length) throw valueError('the first two maketrans arguments must have equal length');
  for (const [index, char] of from.entries())
    table.store.set(BigInt(char.codePointAt(0) as number), BigInt(to[index].codePointAt(0) as number));
  if (args[2] !== undefined)
    for (const char of iterStr(expectStrArgument(args[2], 'maketrans() argument 3')))
      table.store.set(BigInt(char.codePointAt(0) as number), None);
  return table;
}

/** A key of the dict str.maketrans takes, whose characters it turns into code points, with CPython's errors. */
function translationKey(key: PyValue): PyValue {
  if (typeof key === 'bigint' || typeof key === 'boolean') return key;
  if (typeof key !== 'string') throw typeError('keys in translate table mustbe strings or integers');
  if (strLength(key) !== 1) throw valueError('string keys in translatetable must be of length 1');
  return BigInt(key.codePointAt(0) as number);
}
export function iterString(text: string): () => PyValue | typeof DONE {
  return iterate(text);
}

export { pyError };
