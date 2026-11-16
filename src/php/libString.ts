// code-gauge-allow-file fileNcss 908 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { createHash } from 'node:crypto';

import { eastAsianWidth } from 'get-east-asian-width';

import { codePointBytes, dec, enc, lower, upper, utf8Chars, utf8Length } from './bytes';
import { compareBytes } from './conversions';
import { deprecated, throwError, warn } from './errors';
import { HTML401_ENTITIES } from './htmlEntities';
import { defineAlias, defineConstant, defineFunction } from './native';
import { toStr } from './operators';
import { rt } from './runtime';
import { incrementString } from './strings';
import { PhpArray, type Ref, type Value } from './values';

defineConstant('STR_PAD_RIGHT', 1n);
defineConstant('STR_PAD_LEFT', 0n);
defineConstant('STR_PAD_BOTH', 2n);
defineConstant('ENT_QUOTES', 3n);
defineConstant('ENT_COMPAT', 2n);
defineConstant('ENT_NOQUOTES', 0n);
defineConstant('ENT_HTML401', 0n);
defineConstant('ENT_HTML5', 48n);
defineConstant('ENT_SUBSTITUTE', 8n);
defineConstant('ENT_IGNORE', 4n);
defineConstant('MB_CASE_UPPER', 0n);
defineConstant('MB_CASE_LOWER', 1n);
defineConstant('MB_CASE_TITLE', 2n);

const s = (value: Value): string => value as string;
const n = (value: Value): number => Number(value as bigint);

function checkLength(text: string): string {
  if (text.length > 1_000_000) throwError('Error', 'Allowed memory size exhausted');
  rt().spend(Math.ceil(text.length / 64));
  return text;
}

defineFunction('strlen(string $string): int', ({ args }) => BigInt(s(args[0]).length));
defineFunction('str_repeat(string $string, int $times): string', ({ args }) => {
  const times = n(args[1]);
  if (times < 0) throwError('ValueError', 'str_repeat(): Argument #2 ($times) must be greater than or equal to 0');
  if (s(args[0]).length * times > 1_000_000) throwError('Error', 'Allowed memory size of 134217728 bytes exhausted');
  return checkLength(s(args[0]).repeat(times));
});
defineFunction('strtoupper(string $string): string', ({ args }) => upper(s(args[0])));
defineFunction('strtolower(string $string): string', ({ args }) => lower(s(args[0])));
defineFunction('ucfirst(string $string): string', ({ args }) => upper(s(args[0]).slice(0, 1)) + s(args[0]).slice(1));
defineFunction('lcfirst(string $string): string', ({ args }) => lower(s(args[0]).slice(0, 1)) + s(args[0]).slice(1));
defineFunction(String.raw`ucwords(string $string, string $separators = " \t\r\n\f\v"): string`, ({ args }) => {
  const separators = args[1] === undefined ? ' \t\r\n\f\v' : s(args[1]);
  let result = '';
  let capitalize = true;
  for (const char of s(args[0])) {
    result += capitalize ? upper(char) : char;
    capitalize = separators.includes(char);
  }
  return result;
});

/** The characters a trim character list names, expanding ranges such as `a..z`. */
function trimSet(list: string, name: string): Set<string> {
  const set = new Set<string>();
  for (let index = 0; index < list.length; index++) {
    if (list.slice(index + 1, index + 3) === '..' && index + 3 < list.length) {
      const from = list.charCodeAt(index);
      const to = list.charCodeAt(index + 3);
      if (to >= from) {
        for (let code = from; code <= to; code++) set.add(String.fromCharCode(code));
        index += 3;
        continue;
      }
      warn(`${name}(): Invalid '..'-range, '..'-range needs to be incrementing`);
    }
    set.add(list[index]);
  }
  return set;
}

const DEFAULT_TRIM = ' \n\r\t\v\0';

function trimText(text: string, list: string | undefined, name: string, left: boolean, right: boolean): string {
  const set = trimSet(list ?? DEFAULT_TRIM, name);
  let start = 0;
  let end = text.length;
  if (left) while (start < end && set.has(text[start])) start++;
  if (right) while (end > start && set.has(text[end - 1])) end--;
  return text.slice(start, end);
}

defineFunction(String.raw`trim(string $string, string $characters = " \n\r\t\v\x00"): string`, ({ args }) =>
  trimText(s(args[0]), args[1] as string | undefined, 'trim', true, true)
);
defineFunction(String.raw`ltrim(string $string, string $characters = " \n\r\t\v\x00"): string`, ({ args }) =>
  trimText(s(args[0]), args[1] as string | undefined, 'ltrim', true, false)
);
defineFunction(String.raw`rtrim(string $string, string $characters = " \n\r\t\v\x00"): string`, ({ args }) =>
  trimText(s(args[0]), args[1] as string | undefined, 'rtrim', false, true)
);
defineAlias('chop', 'rtrim');

defineFunction(
  'str_pad(string $string, int $length, string $pad_string = " ", int $pad_type = STR_PAD_RIGHT): string',
  ({ args }) => {
    const text = s(args[0]);
    const length = n(args[1]);
    const pad = args[2] === undefined ? ' ' : s(args[2]);
    const type = args[3] === undefined ? 1 : n(args[3]);
    if (length <= text.length) return text;
    if (pad === '') throwError('ValueError', 'str_pad(): Argument #3 ($pad_string) must be a non-empty string');
    if (type < 0 || type > 2)
      throwError(
        'ValueError',
        'str_pad(): Argument #4 ($pad_type) must be STR_PAD_LEFT, STR_PAD_RIGHT, or STR_PAD_BOTH'
      );
    return padUnits([...text], length, [...pad], type);
  }
);
defineFunction('str_split(string $string, int $length = 1): array', ({ args }) => {
  const text = s(args[0]);
  const length = args[1] === undefined ? 1 : n(args[1]);
  if (length < 1) throwError('ValueError', 'str_split(): Argument #2 ($length) must be greater than 0');
  if (text === '') return PhpArray.list(['']);
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += length) parts.push(text.slice(index, index + length));
  return PhpArray.list(parts);
});
defineFunction('explode(string $separator, string $string, int $limit = PHP_INT_MAX): array', ({ args }) => {
  const separator = s(args[0]);
  const text = s(args[1]);
  const limit = args[2] === undefined ? Number.MAX_SAFE_INTEGER : n(args[2]);
  if (separator === '') throwError('ValueError', 'explode(): Argument #1 ($separator) cannot be empty');
  const parts = text.split(separator);
  if (limit > 0) {
    if (parts.length > limit)
      return PhpArray.list([...parts.slice(0, limit - 1), parts.slice(limit - 1).join(separator)]);
    return PhpArray.list(parts);
  }
  if (limit < 0) return PhpArray.list(parts.slice(0, limit));
  return PhpArray.list([parts.length > 1 ? parts.join(separator) : text]);
});
defineFunction('implode(array|string $separator, ?array $array = null): string', ({ args }) => {
  let [separator, array] = args;
  if (array === undefined || array === null) {
    if (!(separator instanceof PhpArray)) {
      if (array === null)
        throwError('TypeError', 'implode(): Argument #1 ($array) must be of type array, string given');
      throwError('TypeError', 'implode(): Argument #2 ($array) must be of type ?array, string given');
    }
    array = separator;
    separator = '';
  } else if (separator instanceof PhpArray) {
    throwError('TypeError', 'implode(): Argument #1 ($separator) must be of type string, array given');
  }
  let result = '';
  let first = true;
  for (const item of (array as PhpArray).values()) {
    if (!first) result += separator as string;
    first = false;
    result += toStr(item);
    if (result.length > 1_000_000) throwError('Error', 'Allowed memory size exhausted');
  }
  return result;
});
defineAlias('join', 'implode');

defineFunction('substr(string $string, int $offset, ?int $length = null): string', ({ args }) =>
  substring(s(args[0]), n(args[1]), args[2] === undefined || args[2] === null ? undefined : n(args[2]))
);

export function substring(text: string, offset: number, length: number | undefined): string {
  let start = offset;
  if (start > text.length) return '';
  if (start < 0) start = Math.max(text.length + start, 0);
  let end = text.length;
  if (length !== undefined) {
    if (length < 0) {
      end = text.length + length;
      if (end < start) return '';
    } else end = Math.min(start + length, text.length);
  }
  return text.slice(start, end);
}

function offsetError(name: string, argument = 3, parameter = 'offset', haystack = 'haystack'): never {
  throwError(
    'ValueError',
    `${name}(): Argument #${argument} ($${parameter}) must be contained in argument #1 ($${haystack})`
  );
}

// code-gauge-allow functionCognitiveComplexity 22 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function search(
  name: string,
  haystack: string,
  needle: string,
  offset: number,
  reverse: boolean,
  insensitive: boolean
): Value {
  const text = insensitive ? lower(haystack) : haystack;
  const target = insensitive ? lower(needle) : needle;
  if (offset > text.length || offset < -text.length) offsetError(name);
  if (!reverse) {
    const start = offset < 0 ? text.length + offset : offset;
    const index = text.indexOf(target, start);
    return index === -1 ? false : BigInt(index);
  }
  let index: number;
  if (offset >= 0) {
    index = text.lastIndexOf(target);
    if (index < offset) return false;
  } else {
    const limit = text.length + offset;
    index = text.lastIndexOf(
      target,
      limit + target.length - (target.length > 0 ? 1 : 0) > text.length ? text.length : limit
    );
    if (index !== -1 && index > limit) index = text.lastIndexOf(target, limit);
  }
  return index === -1 ? false : BigInt(index);
}

defineFunction('strpos(string $haystack, string $needle, int $offset = 0): int|false', ({ args }) =>
  search('strpos', s(args[0]), s(args[1]), args[2] === undefined ? 0 : n(args[2]), false, false)
);
defineFunction('stripos(string $haystack, string $needle, int $offset = 0): int|false', ({ args }) =>
  search('stripos', s(args[0]), s(args[1]), args[2] === undefined ? 0 : n(args[2]), false, true)
);
defineFunction('strrpos(string $haystack, string $needle, int $offset = 0): int|false', ({ args }) =>
  search('strrpos', s(args[0]), s(args[1]), args[2] === undefined ? 0 : n(args[2]), true, false)
);
defineFunction('strripos(string $haystack, string $needle, int $offset = 0): int|false', ({ args }) =>
  search('strripos', s(args[0]), s(args[1]), args[2] === undefined ? 0 : n(args[2]), true, true)
);
defineFunction('str_contains(string $haystack, string $needle): bool', ({ args }) => s(args[0]).includes(s(args[1])));
defineFunction('str_starts_with(string $haystack, string $needle): bool', ({ args }) =>
  s(args[0]).startsWith(s(args[1]))
);
defineFunction('str_ends_with(string $haystack, string $needle): bool', ({ args }) => s(args[0]).endsWith(s(args[1])));

function replaceAll(
  subject: string,
  search: string,
  replace: string,
  insensitive: boolean,
  count: { value: number }
): string {
  if (search === '') return subject;
  if (!insensitive) {
    const parts = subject.split(search);
    count.value += parts.length - 1;
    return checkLength(parts.join(replace));
  }
  const lowered = lower(subject);
  const target = lower(search);
  let result = '';
  let position = 0;
  for (;;) {
    const found = lowered.indexOf(target, position);
    if (found === -1) break;
    result += subject.slice(position, found) + replace;
    position = found + search.length;
    count.value++;
  }
  return checkLength(result + subject.slice(position));
}

// code-gauge-allow functionCognitiveComplexity 28 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function strReplace(args: Value[], refs: (Ref | undefined)[], insensitive: boolean): Value {
  const [search, replace, subject] = args;
  const count = { value: 0 };
  const replaceOne = (text: string): string => {
    if (!(search instanceof PhpArray)) {
      if (replace instanceof PhpArray)
        throwError(
          'TypeError',
          `${insensitive ? 'str_ireplace' : 'str_replace'}(): Argument #2 ($replace) must be of type string when argument #1 ($search) is a string`
        );
      return replaceAll(text, toStr(search), toStr(replace), insensitive, count);
    }
    const replacements = replace instanceof PhpArray ? replace.values() : undefined;
    let result = text;
    for (const [index, item] of search.values().entries()) {
      const replacement = replacements
        ? index < replacements.length
          ? toStr(replacements[index])
          : ''
        : toStr(replace);
      result = replaceAll(result, toStr(item), replacement, insensitive, count);
    }
    return result;
  };
  let result: Value;
  if (subject instanceof PhpArray) {
    const array = new PhpArray();
    for (const [key, item] of subject.entries()) {
      array.set(key, item instanceof PhpArray ? item : replaceOne(toStr(item)));
    }
    result = array;
  } else result = replaceOne(toStr(subject));
  if (refs[3]) refs[3].v = BigInt(count.value);
  return result;
}

defineFunction(
  'str_replace(array|string $search, array|string $replace, string|array $subject, &$count = null): string|array',
  ({ args, refs }) => strReplace(args, refs, false)
);
defineFunction(
  'str_ireplace(array|string $search, array|string $replace, string|array $subject, &$count = null): string|array',
  ({ args, refs }) => strReplace(args, refs, true)
);
defineFunction(
  'substr_count(string $haystack, string $needle, int $offset = 0, ?int $length = null): int',
  ({ args }) => {
    const haystack = s(args[0]);
    const needle = s(args[1]);
    if (needle === '') throwError('ValueError', 'substr_count(): Argument #2 ($needle) cannot be empty');
    let offset = args[2] === undefined ? 0 : n(args[2]);
    if (offset < 0) offset += haystack.length;
    if (offset < 0 || offset > haystack.length) offsetError('substr_count');
    let end = haystack.length;
    if (args[3] !== undefined && args[3] !== null) {
      let length = n(args[3]);
      if (length < 0) length += haystack.length - offset;
      if (length < 0 || offset + length > haystack.length)
        throwError('ValueError', 'substr_count(): Argument #4 ($length) must be contained in argument #1 ($haystack)');
      end = offset + length;
    }
    return BigInt(haystack.slice(offset, end).split(needle).length - 1);
  }
);
defineFunction(
  'substr_replace(array|string $string, array|string $replace, array|int $offset, array|int|null $length = null): string|array',
  // code-gauge-allow functionCognitiveComplexity 21 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
  ({ args }) => {
    const [text, replace, offset, length] = args;
    const one = (subject: string, index: number): string => {
      const pick = (value: Value): Value => (value instanceof PhpArray ? (value.values()[index] ?? null) : value);
      const replacement = replace instanceof PhpArray ? toStr(replace.values()[index] ?? '') : toStr(replace);
      let start = Number(pick(offset) ?? 0n);
      const lengthValue = pick(length ?? null);
      if (start < 0) start = Math.max(subject.length + start, 0);
      if (start > subject.length) start = subject.length;
      let end = lengthValue === null || lengthValue === undefined ? subject.length : Number(lengthValue);
      if (lengthValue !== null && lengthValue !== undefined)
        end = end < 0 ? Math.max(subject.length + end, start) : Math.min(start + end, subject.length);
      return subject.slice(0, start) + replacement + subject.slice(Math.max(end, start));
    };
    if (text instanceof PhpArray) {
      const array = new PhpArray();
      for (const [index, [key, item]] of [...text.entries()].entries()) array.set(key, one(toStr(item), index));
      return array;
    }
    return one(s(text), 0);
  }
);
defineFunction('strrev(string $string): string', ({ args }) => [...s(args[0])].toReversed().join(''));
defineFunction('strcmp(string $string1, string $string2): int', ({ args }) =>
  BigInt(compareBytes(s(args[0]), s(args[1])))
);
defineFunction('strcasecmp(string $string1, string $string2): int', ({ args }) =>
  BigInt(compareBytes(lower(s(args[0])), lower(s(args[1]))))
);
defineFunction('strncmp(string $string1, string $string2, int $length): int', ({ args }) => {
  const length = n(args[2]);
  if (length < 0) throwError('ValueError', 'strncmp(): Argument #3 ($length) must be greater than or equal to 0');
  return BigInt(compareBytes(s(args[0]).slice(0, length), s(args[1]).slice(0, length)));
});
defineFunction('strncasecmp(string $string1, string $string2, int $length): int', ({ args }) => {
  const length = n(args[2]);
  if (length < 0) throwError('ValueError', 'strncasecmp(): Argument #3 ($length) must be greater than or equal to 0');
  return BigInt(compareBytes(lower(s(args[0]).slice(0, length)), lower(s(args[1]).slice(0, length))));
});
defineFunction('strnatcmp(string $string1, string $string2): int', ({ args }) =>
  BigInt(naturalCompare(s(args[0]), s(args[1]), false))
);
defineFunction('strnatcasecmp(string $string1, string $string2): int', ({ args }) =>
  BigInt(naturalCompare(s(args[0]), s(args[1]), true))
);

/** The byte at `index`, or 0 past the end, as C reads a string's terminator. */
function at(text: string, index: number): number {
  return index < text.length ? text.charCodeAt(index) : 0;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

/** Compares two runs of digits that start with a zero as fractions: the first different digit decides. */
function compareLeft(a: string, ap: number, b: string, bp: number): { result: number; ap: number; bp: number } {
  for (; ; ap++, bp++) {
    const da = ap < a.length && isDigit(at(a, ap));
    const db = bp < b.length && isDigit(at(b, bp));
    if (!da && !db) return { result: 0, ap, bp };
    if (!da) return { result: -1, ap, bp };
    if (!db) return { result: 1, ap, bp };
    if (at(a, ap) !== at(b, bp)) return { result: at(a, ap) < at(b, bp) ? -1 : 1, ap, bp };
  }
}

/** Compares two runs of digits as integers: the longer run wins, then the first different digit. */
// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function compareRight(a: string, ap: number, b: string, bp: number): { result: number; ap: number; bp: number } {
  let bias = 0;
  for (; ; ap++, bp++) {
    const da = ap < a.length && isDigit(at(a, ap));
    const db = bp < b.length && isDigit(at(b, bp));
    if (!da && !db) return { result: bias, ap, bp };
    if (!da) return { result: -1, ap, bp };
    if (!db) return { result: 1, ap, bp };
    if (bias === 0 && at(a, ap) !== at(b, bp)) bias = at(a, ap) < at(b, bp) ? -1 : 1;
  }
}

/** Compares strings in natural order, as PHP's strnatcmp_ex does. */
// code-gauge-allow functionNcss 46 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
export function naturalCompare(a: string, b: string, insensitive: boolean): number {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length > b.length ? 1 : -1;
  let ap = 0;
  let bp = 0;
  let leading = true;
  for (;;) {
    let ca = at(a, ap);
    let cb = at(b, bp);
    while (leading && ca === 48 && ap + 1 < a.length && isDigit(at(a, ap + 1))) ca = at(a, ++ap);
    while (leading && cb === 48 && bp + 1 < b.length && isDigit(at(b, bp + 1))) cb = at(b, ++bp);
    leading = false;
    while (isSpace(ca)) ca = at(a, ++ap);
    while (isSpace(cb)) cb = at(b, ++bp);
    if (isDigit(ca) && isDigit(cb)) {
      const run = ca === 48 || cb === 48 ? compareLeft(a, ap, b, bp) : compareRight(a, ap, b, bp);
      ({ ap, bp } = run);
      if (run.result !== 0) return run.result;
      if (ap >= a.length && bp >= b.length) return 0;
      if (ap >= a.length) return -1;
      if (bp >= b.length) return 1;
      ca = at(a, ap);
      cb = at(b, bp);
    }
    if (insensitive) {
      ca = upper(String.fromCharCode(ca)).charCodeAt(0);
      cb = upper(String.fromCharCode(cb)).charCodeAt(0);
    }
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    ap++;
    bp++;
    if (ap >= a.length && bp >= b.length) return 0;
    if (ap >= a.length) return -1;
    if (bp >= b.length) return 1;
  }
}

function strstr(args: Value[], insensitive: boolean): Value {
  const haystack = s(args[0]);
  const needle = s(args[1]);
  const index = insensitive ? lower(haystack).indexOf(lower(needle)) : haystack.indexOf(needle);
  if (index === -1) return false;
  return args[2] === true ? haystack.slice(0, index) : haystack.slice(index);
}

defineFunction('strstr(string $haystack, string $needle, bool $before_needle = false): string|false', ({ args }) =>
  strstr(args, false)
);
defineAlias('strchr', 'strstr');
defineFunction('stristr(string $haystack, string $needle, bool $before_needle = false): string|false', ({ args }) =>
  strstr(args, true)
);
defineFunction('strrchr(string $haystack, string $needle, bool $before_needle = false): string|false', ({ args }) => {
  const haystack = s(args[0]);
  const needle = s(args[1]);
  const index = haystack.lastIndexOf(needle[0] ?? '\0');
  if (index === -1) return false;
  return args[2] === true ? haystack.slice(0, index) : haystack.slice(index);
});
// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
defineFunction('strtr(string $string, string|array $from, ?string $to = null): string', ({ args }) => {
  const text = s(args[0]);
  const from = args[1];
  if (from instanceof PhpArray) {
    const pairs = [...from.entries()]
      .map(([key, value]) => [String(key), toStr(value)] as const)
      .filter(([key]) => key !== '');
    if (pairs.length === 0) return text;
    const sorted = pairs.toSorted((x, y) => y[0].length - x[0].length);
    let result = '';
    let index = 0;
    outer: while (index < text.length) {
      for (const [key, value] of sorted) {
        if (text.startsWith(key, index)) {
          result += value;
          index += key.length;
          continue outer;
        }
      }
      result += text[index++];
    }
    return result;
  }
  if (args[2] === undefined || args[2] === null) {
    throwError('ArgumentCountError', 'strtr(): Argument #2 ($from) must be of type array, string given');
  }
  const source = toStr(from);
  const target = s(args[2]);
  const length = Math.min(source.length, target.length);
  const map = new Map<string, string>();
  for (let index = 0; index < length; index++) map.set(source[index], target[index]);
  return [...text].map((char) => map.get(char) ?? char).join('');
});
defineFunction('chr(int $codepoint): string', ({ args }) =>
  String.fromCharCode(Number(BigInt.asUintN(8, args[0] as bigint)))
);
defineFunction('ord(string $character): int', ({ args }) => BigInt(s(args[0]).charCodeAt(0) || 0));
defineFunction(
  String.raw`wordwrap(string $string, int $width = 75, string $break = "\n", bool $cut_long_words = false): string`,
  ({ args }) =>
    wordwrap(
      s(args[0]),
      args[1] === undefined ? 75 : n(args[1]),
      args[2] === undefined ? '\n' : s(args[2]),
      args[3] === true
    )
);

// code-gauge-allow functionCognitiveComplexity 17 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
// code-gauge-allow functionNcss 37 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function wordwrap(text: string, width: number, breakText: string, cut: boolean): string {
  if (text === '') return '';
  if (breakText === '') throwError('ValueError', 'wordwrap(): Argument #3 ($break) cannot be empty');
  if (width === 0 && cut)
    throwError('ValueError', 'wordwrap(): Argument #4 ($cut_long_words) cannot be true when argument #2 ($width) is 0');
  const breakLength = breakText.length;
  let result = '';
  let lastStart = 0;
  let lastSpace = 0;
  for (let current = 0; current < text.length; current++) {
    const char = text[current];
    if (char === breakText[0] && current + breakLength < text.length && text.startsWith(breakText, current)) {
      result += text.slice(lastStart, current + breakLength);
      current += breakLength - 1;
      lastStart = current + 1;
      lastSpace = lastStart;
    } else if (char === ' ') {
      if (current - lastStart >= width) {
        result += text.slice(lastStart, current) + breakText;
        lastStart = current + 1;
      }
      lastSpace = current;
    } else if (current - lastStart >= width && cut && lastStart >= lastSpace) {
      result += text.slice(lastStart, current) + breakText;
      lastStart = current;
      lastSpace = current;
    } else if (current - lastStart >= width && lastStart < lastSpace) {
      result += text.slice(lastStart, lastSpace) + breakText;
      lastStart = lastSpace + 1;
      lastSpace = lastStart;
    }
  }
  if (lastStart !== text.length) result += text.slice(lastStart);
  return result;
}

// code-gauge-allow functionCognitiveComplexity 18 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
defineFunction('str_word_count(string $string, int $format = 0, ?string $characters = null): array|int', ({ args }) => {
  const text = s(args[0]);
  const format = args[1] === undefined ? 0 : n(args[1]);
  const extra = (args[2] as string | null | undefined) ?? '';
  const isWordChar = (char: string, index: number, word: string): boolean =>
    /[A-Za-z]/.test(char) || extra.includes(char) || char === "'" || (char === '-' && index > 0 && word !== '');
  const words: [number, string][] = [];
  let index = 0;
  while (index < text.length) {
    let word = '';
    const start = index;
    while (index < text.length && isWordChar(text[index], index - start, word)) word += text[index++];
    if (word.endsWith('-') && !extra.includes('-')) {
      word = word.slice(0, -1);
    }
    if (word !== '') words.push([start, word]);
    else index++;
  }
  if (format === 0) return BigInt(words.length);
  const array = new PhpArray();
  for (const [start, word] of words) {
    if (format === 1) array.append(word);
    else array.set(BigInt(start), word);
  }
  return array;
});
defineFunction('nl2br(string $string, bool $use_xhtml = true): string', ({ args }) => {
  const tag = args[1] === false ? '<br>' : '<br />';
  return s(args[0]).replaceAll(/\r\n|\n\r|\n|\r/g, (match) => tag + match);
});
defineFunction(
  'htmlspecialchars(string $string, int $flags = ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML401, ?string $encoding = null, bool $double_encode = true): string',
  ({ args }) => {
    const flags = args[1] === undefined ? 11n : (args[1] as bigint);
    const doubleEncode = args[3] !== false;
    let text = s(args[0]);
    text = doubleEncode
      ? text.replaceAll('&', '&amp;')
      : text.replaceAll(/&(?![A-Za-z]+;|#\d+;|#x[\dA-Fa-f]+;)/g, '&amp;');
    text = text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    if (flags & 2n) text = text.replaceAll('"', '&quot;');
    if ((flags & 3n) === 3n) text = text.replaceAll("'", (flags & 48n) === 0n ? '&#039;' : '&apos;');
    return text;
  }
);
defineFunction(
  'htmlspecialchars_decode(string $string, int $flags = ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML401): string',
  ({ args }) => {
    const flags = args[1] === undefined ? 11n : (args[1] as bigint);
    let text = s(args[0]).replaceAll('&lt;', '<').replaceAll('&gt;', '>');
    if (flags & 2n) text = text.replaceAll('&quot;', '"');
    if ((flags & 3n) === 3n) text = text.replaceAll('&#039;', "'").replaceAll('&#39;', "'").replaceAll('&apos;', "'");
    return text.replaceAll('&amp;', '&');
  }
);
const ENTITY_BY_CODE = new Map(HTML401_ENTITIES.map(([code, name]) => [code, name]));
const CODE_BY_ENTITY = new Map(HTML401_ENTITIES.map(([code, name]) => [name, code]));

defineFunction(
  'htmlentities(string $string, int $flags = ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML401, ?string $encoding = null, bool $double_encode = true): string',
  // code-gauge-allow functionCognitiveComplexity 30 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
  ({ args }) => {
    const flags = args[1] === undefined ? 11n : (args[1] as bigint);
    const doubleEncode = args[3] !== false;
    const text = s(args[0]);
    let result = '';
    for (let index = 0; index < text.length;) {
      const length = utf8Length(text, index);
      const char = text.slice(index, index + length);
      index += length;
      const code = length === 1 ? char.charCodeAt(0) : (dec(char).codePointAt(0) as number);
      if (length === 1 && code >= 0x80) {
        if ((flags & 8n) === 0n) return '';
        result += 'ï¿½';
        continue;
      }
      if (
        char === '&' &&
        !doubleEncode &&
        /^&(?:[A-Za-z][A-Za-z\d]*|#\d+|#[xX][\dA-Fa-f]+);/.test(text.slice(index - 1))
      ) {
        result += char;
        continue;
      }
      if (char === '"') result += flags & 2n ? '&quot;' : char;
      else if (char === "'") result += (flags & 3n) === 3n ? ((flags & 48n) === 0n ? '&#039;' : '&apos;') : char;
      else {
        const name = ENTITY_BY_CODE.get(code);
        result += name ? `&${name};` : char;
      }
    }
    return result;
  }
);
defineFunction(
  'html_entity_decode(string $string, int $flags = ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML401, ?string $encoding = null): string',
  // code-gauge-allow functionCognitiveComplexity 24 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
  ({ args }) => {
    const flags = args[1] === undefined ? 11n : (args[1] as bigint);
    return s(args[0]).replaceAll(/&(#[xX][\dA-Fa-f]+|#\d+|[A-Za-z][A-Za-z\d]*);/g, (match, body: string) => {
      if (body.startsWith('#')) {
        const code = /^#[xX]/.test(body) ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
        if (code === 0x27 && (flags & 3n) !== 3n) return match;
        if (code === 0x22 && (flags & 2n) === 0n) return match;
        if (code > 0x10_ff_ff || (code >= 0xd8_00 && code <= 0xdf_ff)) return match;
        return codePointBytes(code);
      }
      if (body === 'quot' && (flags & 2n) === 0n) return match;
      const code = CODE_BY_ENTITY.get(body);
      return code === undefined ? match : codePointBytes(code);
    });
  }
);
defineFunction('strip_tags(string $string, array|string|null $allowed_tags = null): string', ({ args }) =>
  stripTags(s(args[0]), allowedTags(args[1] ?? null))
);

function allowedTags(value: Value): Set<string> {
  if (value === null) return new Set();
  const names =
    value instanceof PhpArray
      ? value.values().map((item) => toStr(item))
      : [...toStr(value).matchAll(/<([A-Za-z\d]+)>/g)].map((match) => match[1]);
  return new Set(names.map((name) => lower(name)));
}

/** Removes HTML and PHP tags as PHP's strip_tags does, keeping the allowed tags. */
// code-gauge-allow functionCognitiveComplexity 26 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
// code-gauge-allow functionNcss 37 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function stripTags(text: string, allowed: Set<string>): string {
  let result = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char !== '<' || index + 1 >= text.length || /\s/.test(text[index + 1])) {
      result += char;
      index++;
      continue;
    }
    if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4);
      index = end === -1 ? text.length : end + 3;
      continue;
    }
    let end = index + 1;
    let quote = '';
    let depth = 1;
    while (end < text.length) {
      const current = text[end];
      if (quote) {
        if (current === quote) quote = '';
      } else if (current === '"' || current === "'") quote = current;
      else if (current === '<') depth++;
      else if (current === '>' && --depth === 0) break;
      end++;
    }
    const tag = text.slice(index, Math.min(end + 1, text.length));
    const name = /^<\/?\s*([A-Za-z\d]+)/.exec(tag)?.[1];
    if (name && allowed.has(lower(name))) result += tag;
    index = end + 1;
  }
  return result;
}

defineFunction('addslashes(string $string): string', ({ args }) =>
  s(args[0]).replaceAll(/["'\\\0]/g, (match) => (match === '\0' ? String.raw`\0` : `\\${match}`))
);
defineFunction('stripslashes(string $string): string', ({ args }) =>
  s(args[0]).replaceAll(/\\(.?)/gs, (_match, char: string) => (char === '0' ? '\0' : char))
);
defineFunction(
  String.raw`chunk_split(string $string, int $length = 76, string $separator = "\r\n"): string`,
  ({ args }) => {
    const text = s(args[0]);
    const length = args[1] === undefined ? 76 : n(args[1]);
    const separator = args[2] === undefined ? '\r\n' : s(args[2]);
    if (length < 1) throwError('ValueError', 'chunk_split(): Argument #2 ($length) must be greater than 0');
    let result = '';
    for (let index = 0; index < text.length; index += length) result += text.slice(index, index + length) + separator;
    return result;
  }
);
defineFunction('similar_text(string $string1, string $string2, &$percent = null): int', ({ args, refs }) => {
  const a = s(args[0]);
  const b = s(args[1]);
  const sim = similarChars(a, b);
  if (refs[2]) refs[2].v = a.length + b.length === 0 ? 0 : (sim * 2 * 100) / (a.length + b.length);
  return BigInt(sim);
});

function similarChars(a: string, b: string): number {
  rt().spend();
  let max = 0;
  let posA = 0;
  let posB = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > max) {
        max = k;
        posA = i;
        posB = j;
      }
    }
  }
  if (max === 0) return 0;
  return (
    max + similarChars(a.slice(0, posA), b.slice(0, posB)) + similarChars(a.slice(posA + max), b.slice(posB + max))
  );
}

defineFunction(
  'levenshtein(string $string1, string $string2, int $insertion_cost = 1, int $replacement_cost = 1, int $deletion_cost = 1): int',
  ({ args }) => {
    const a = s(args[0]);
    const b = s(args[1]);
    const insert = args[2] === undefined ? 1 : n(args[2]);
    const replace = args[3] === undefined ? 1 : n(args[3]);
    const remove = args[4] === undefined ? 1 : n(args[4]);
    if (a.length === 0) return BigInt(b.length * insert);
    if (b.length === 0) return BigInt(a.length * remove);
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index * insert);
    for (let i = 0; i < a.length; i++) {
      rt().spend(Math.ceil(b.length / 16));
      const current = [(i + 1) * remove];
      for (let j = 0; j < b.length; j++) {
        const cost = previous[j] + (a[i] === b[j] ? 0 : replace);
        current.push(Math.min(cost, previous[j + 1] + remove, current[j] + insert));
      }
      previous = current;
    }
    return BigInt(previous[b.length]);
  }
);
defineFunction('soundex(string $string): string', ({ args }) => {
  const codes = '01230120022455012623010202';
  let result = '';
  let last = '';
  for (const char of upper(s(args[0]))) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) continue;
    const digit = codes[code - 65];
    if (result === '') {
      result = char;
      last = digit;
    } else if (digit !== last) {
      if (digit !== '0') result += digit;
      last = digit;
    }
    if (result.length === 4) break;
  }
  return result.padEnd(4, '0');
});
// code-gauge-allow functionCognitiveComplexity 17 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
defineFunction('count_chars(string $string, int $mode = 0): array|string', ({ args }) => {
  const text = s(args[0]);
  const mode = args[1] === undefined ? 0 : n(args[1]);
  const counts = Array.from({ length: 256 }, () => 0);
  for (let index = 0; index < text.length; index++) counts[text.charCodeAt(index)]++;
  if (mode < 0 || mode > 4)
    throwError('ValueError', 'count_chars(): Argument #2 ($mode) must be between 0 and 4 (inclusive)');
  if (mode === 3 || mode === 4) {
    let result = '';
    for (let code = 0; code < 256; code++) if (counts[code] > 0 === (mode === 3)) result += String.fromCharCode(code);
    return result;
  }
  const array = new PhpArray();
  for (let code = 0; code < 256; code++) {
    if (mode === 0 || (mode === 1 && counts[code] > 0) || (mode === 2 && counts[code] === 0))
      array.set(BigInt(code), BigInt(counts[code]));
  }
  return array;
});
defineFunction('str_shuffle(string $string): string', ({ args }) => {
  const chars = [...s(args[0])];
  const mt = rt().mt;
  for (let left = chars.length - 1; left > 0; left--) {
    const index = Number(mt.range(0n, BigInt(left)));
    if (index !== left) [chars[left], chars[index]] = [chars[index], chars[left]];
  }
  return chars.join('');
});
defineFunction('md5(string $string, bool $binary = false): string', ({ args }) =>
  hash('md5', s(args[0]), args[1] === true)
);
defineFunction('sha1(string $string, bool $binary = false): string', ({ args }) =>
  hash('sha1', s(args[0]), args[1] === true)
);
defineFunction('crc32(string $string): int', ({ args }) => BigInt(crc32(s(args[0]))));
defineFunction('hash(string $algo, string $data, bool $binary = false, array $options = []): string', ({ args }) => {
  const algorithm = lower(s(args[0]));
  if (!['md5', 'sha1', 'sha256', 'sha512', 'sha384', 'sha224'].includes(algorithm)) {
    if (algorithm === 'crc32b') return crc32(s(args[1])).toString(16).padStart(8, '0');
    throwError('ValueError', 'hash(): Argument #1 ($algo) must be a valid hashing algorithm');
  }
  return hash(algorithm, s(args[1]), args[2] === true);
});

function hash(algorithm: string, data: string, binary: boolean): string {
  const digest = createHash(algorithm).update(Buffer.from(data, 'latin1'));
  return binary ? digest.digest('latin1') : digest.digest('hex');
}

function crc32(data: string): number {
  let crc = 0xff_ff_ff_ff;
  for (let index = 0; index < data.length; index++) {
    crc ^= data.charCodeAt(index);
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xed_b8_83_20 : crc >>> 1;
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

defineFunction('bin2hex(string $string): string', ({ args }) =>
  [...s(args[0])].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('')
);
defineFunction('hex2bin(string $string): string|false', ({ args }) => {
  const text = s(args[0]);
  if (text.length % 2 !== 0) {
    warn('hex2bin(): Hexadecimal input string must have an even length');
    return false;
  }
  if (!/^[\dA-Fa-f]*$/.test(text)) {
    warn('hex2bin(): Input string must be hexadecimal string');
    return false;
  }
  let result = '';
  for (let index = 0; index < text.length; index += 2)
    result += String.fromCharCode(Number.parseInt(text.slice(index, index + 2), 16));
  return result;
});
defineFunction('str_increment(string $string): string', ({ args }) => {
  const text = s(args[0]);
  if (text === '') throwError('ValueError', 'str_increment(): Argument #1 ($string) cannot be empty');
  if (!/^[A-Za-z\d]+$/.test(text))
    throwError(
      'ValueError',
      'str_increment(): Argument #1 ($string) must be composed only of alphanumeric ASCII characters'
    );
  return incrementString(text);
});
// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
defineFunction('str_decrement(string $string): string', ({ args }) => {
  const text = s(args[0]);
  if (text === '') throwError('ValueError', 'str_decrement(): Argument #1 ($string) cannot be empty');
  if (!/^[A-Za-z\d]+$/.test(text))
    throwError(
      'ValueError',
      'str_decrement(): Argument #1 ($string) must be composed only of alphanumeric ASCII characters'
    );
  if (/^(a|A|0)$/.test(text))
    throwError('ValueError', `str_decrement(): Argument #1 ($string) "${text}" is out of decrement range`);
  const chars = [...text];
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index];
    if (char === 'a' || char === 'A' || char === '0') {
      chars[index] = char === 'a' ? 'z' : char === 'A' ? 'Z' : '9';
      continue;
    }
    chars[index] = String.fromCharCode(char.charCodeAt(0) - 1);
    break;
  }
  if (
    chars.length > 1 &&
    /[azAZ09]/.test(text[0]) &&
    /^(a|A|0)/.test(text) &&
    chars[0] !== text[0] &&
    ['z', 'Z', '9'].includes(chars[0])
  ) {
    chars.shift();
  }
  return chars.join('');
});
defineFunction('strspn(string $string, string $characters, int $offset = 0, ?int $length = null): int', ({ args }) =>
  span(args, true)
);
defineFunction('strcspn(string $string, string $characters, int $offset = 0, ?int $length = null): int', ({ args }) =>
  span(args, false)
);

function span(args: Value[], inSet: boolean): bigint {
  const text = substring(
    s(args[0]),
    args[2] === undefined ? 0 : n(args[2]),
    args[3] === undefined || args[3] === null ? undefined : n(args[3])
  );
  const set = s(args[1]);
  let count = 0;
  while (count < text.length && set.includes(text[count]) === inSet) count++;
  return BigInt(count);
}

// Character classes --------------------------------------------------------------------------------------------------

for (const [name, pattern] of [
  ['ctype_digit', /^\d+$/],
  ['ctype_alpha', /^[A-Za-z]+$/],
  ['ctype_alnum', /^[A-Za-z\d]+$/],
  ['ctype_upper', /^[A-Z]+$/],
  ['ctype_lower', /^[a-z]+$/],
  ['ctype_space', /^[ \t\n\r\v\f]+$/],
  ['ctype_punct', /^[!-/:-@[-`{-~]+$/],
  ['ctype_xdigit', /^[\dA-Fa-f]+$/],
  ['ctype_cntrl', /^[\0-\u001F\u007F]+$/],
  ['ctype_print', /^[ -~]+$/],
  ['ctype_graph', /^[!-~]+$/],
] as const) {
  // code-gauge-allow functionCognitiveComplexity 17 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
  defineFunction(`${name}(mixed $text): bool`, ({ args }) => {
    let [value] = args;
    if (typeof value === 'bigint') {
      deprecated(`${name}(): Argument of type int will be interpreted as string in the future`);
      value =
        value >= -128n && value <= 255n
          ? String.fromCharCode(Number(value < 0n ? value + 256n : value))
          : value.toString();
    } else if (typeof value !== 'string') {
      deprecated(
        `${name}(): Argument of type ${typeof value === 'number' ? 'float' : value === null ? 'null' : typeof value === 'boolean' ? 'bool' : 'array'} will be interpreted as string in the future`
      );
      return false;
    }
    return pattern.test(value);
  });
}

// Multibyte strings --------------------------------------------------------------------------------------------------

const chars = (value: Value): string[] => utf8Chars(s(value));

defineFunction('mb_strlen(string $string, ?string $encoding = null): int', ({ args }) => BigInt(chars(args[0]).length));
defineFunction(
  'mb_substr(string $string, int $start, ?int $length = null, ?string $encoding = null): string',
  ({ args }) => {
    const list = chars(args[0]);
    let start = n(args[1]);
    if (start < 0) start = Math.max(list.length + start, 0);
    if (start > list.length) return '';
    let end = list.length;
    if (args[2] !== undefined && args[2] !== null) {
      const length = n(args[2]);
      end = length < 0 ? Math.max(list.length + length, start) : Math.min(start + length, list.length);
    }
    return list.slice(start, end).join('');
  }
);
defineFunction('mb_strtoupper(string $string, ?string $encoding = null): string', ({ args }) =>
  enc(dec(s(args[0])).toUpperCase())
);
defineFunction('mb_strtolower(string $string, ?string $encoding = null): string', ({ args }) =>
  enc(dec(s(args[0])).toLowerCase())
);
defineFunction('mb_str_split(string $string, int $length = 1, ?string $encoding = null): array', ({ args }) => {
  const list = chars(args[0]);
  const length = args[1] === undefined ? 1 : n(args[1]);
  if (length < 1) throwError('ValueError', 'mb_str_split(): Argument #2 ($length) must be greater than 0');
  const parts: string[] = [];
  for (let index = 0; index < list.length; index += length) parts.push(list.slice(index, index + length).join(''));
  return PhpArray.list(parts);
});

/** Pads a sequence of bytes or characters to `length` units on the side `type` names, as `str_pad` does. */
function padUnits(text: string[], length: number, pad: string[], type: number): string {
  if (length <= text.length) return text.join('');
  const total = length - text.length;
  const fill = (count: number): string => Array.from({ length: count }, (_, index) => pad[index % pad.length]).join('');
  const left = type === 0 ? total : type === 1 ? 0 : Math.floor(total / 2);
  return fill(left) + text.join('') + fill(total - left);
}

// code-gauge-allow functionCognitiveComplexity 17 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function mbSearch(args: Value[], reverse: boolean, insensitive: boolean, name: string): Value {
  const haystack = chars(insensitive ? enc(dec(s(args[0])).toLowerCase()) : args[0]);
  const needle = chars(insensitive ? enc(dec(s(args[1])).toLowerCase()) : args[1]);
  let offset = args[2] === undefined ? 0 : n(args[2]);
  if (offset > haystack.length || offset < -haystack.length) {
    throwError('ValueError', `${name}(): Argument #3 ($offset) must be contained in argument #1 ($haystack)`);
  }
  const matchesAt = (index: number): boolean => needle.every((char, at) => haystack[index + at] === char);
  if (!reverse) {
    if (offset < 0) offset += haystack.length;
    for (let index = offset; index + needle.length <= haystack.length; index++)
      if (matchesAt(index)) return BigInt(index);
    return false;
  }
  const start = Math.max(offset, 0);
  const limit = offset < 0 ? haystack.length + offset : haystack.length - needle.length;
  for (let index = Math.min(limit, haystack.length - needle.length); index >= start; index--)
    if (matchesAt(index)) return BigInt(index);
  return false;
}

defineFunction(
  'mb_strpos(string $haystack, string $needle, int $offset = 0, ?string $encoding = null): int|false',
  ({ args }) => mbSearch(args, false, false, 'mb_strpos')
);
defineFunction(
  'mb_strrpos(string $haystack, string $needle, int $offset = 0, ?string $encoding = null): int|false',
  ({ args }) => mbSearch(args, true, false, 'mb_strrpos')
);
defineFunction(
  'mb_stripos(string $haystack, string $needle, int $offset = 0, ?string $encoding = null): int|false',
  ({ args }) => mbSearch(args, false, true, 'mb_stripos')
);
defineFunction('mb_substr_count(string $haystack, string $needle, ?string $encoding = null): int', ({ args }) => {
  if (s(args[1]) === '') throwError('ValueError', 'mb_substr_count(): Argument #2 ($needle) must not be empty');
  return BigInt(s(args[0]).split(s(args[1])).length - 1);
});
defineFunction(
  'mb_str_pad(string $string, int $length, string $pad_string = " ", int $pad_type = STR_PAD_RIGHT, ?string $encoding = null): string',
  ({ args }) => {
    const text = chars(args[0]);
    const length = n(args[1]);
    const pad = args[2] === undefined ? [' '] : chars(args[2]);
    const type = args[3] === undefined ? 1 : n(args[3]);
    if (pad.length === 0)
      throwError('ValueError', 'mb_str_pad(): Argument #3 ($pad_string) must be a non-empty string');
    return padUnits(text, length, pad, type);
  }
);
defineFunction('mb_strwidth(string $string, ?string $encoding = null): int', ({ args }) => {
  let width = 0;
  for (const char of dec(s(args[0]))) width += eastAsianWidth(char.codePointAt(0) as number) === 2 ? 2 : 1;
  return BigInt(width);
});
defineFunction('mb_convert_case(string $string, int $mode, ?string $encoding = null): string', ({ args }) => {
  const text = dec(s(args[0]));
  const mode = n(args[1]);
  if (mode === 0 || mode === 4) return enc(text.toUpperCase());
  if (mode === 1 || mode === 5) return enc(text.toLowerCase());
  return enc(
    text
      .toLowerCase()
      .replaceAll(
        /(^|[^\p{L}\p{N}'])(\p{L})/gu,
        (_match, before: string, letter: string) => before + letter.toUpperCase()
      )
  );
});
defineFunction('mb_internal_encoding(?string $encoding = null): string|bool', ({ args }) =>
  // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- PHP returns the encoding's name as `UTF-8`.
  args[0] ? true : 'UTF-8'
);
defineFunction('mb_ucfirst(string $string, ?string $encoding = null): string', ({ args }) => {
  const list = chars(args[0]);
  if (list.length === 0) return '';
  return enc(dec(list[0]).toUpperCase()) + list.slice(1).join('');
});
defineFunction('mb_lcfirst(string $string, ?string $encoding = null): string', ({ args }) => {
  const list = chars(args[0]);
  if (list.length === 0) return '';
  return enc(dec(list[0]).toLowerCase()) + list.slice(1).join('');
});
const MB_WHITESPACE = String.raw`[\s\0\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\u180E]`;
const MB_TRIM = new RegExp(`^${MB_WHITESPACE}+|${MB_WHITESPACE}+$`, 'gu');

defineFunction('mb_trim(string $string, ?string $characters = null, ?string $encoding = null): string', ({ args }) => {
  const text = dec(s(args[0]));
  if (args[1] === undefined || args[1] === null) return enc(text.replaceAll(MB_TRIM, ''));
  const set = new Set(dec(s(args[1])));
  const list = [...text];
  let start = 0;
  let end = list.length;
  while (start < end && set.has(list[start])) start++;
  while (end > start && set.has(list[end - 1])) end--;
  return enc(list.slice(start, end).join(''));
});
defineFunction('mb_chr(int $codepoint, ?string $encoding = null): string|false', ({ args }) => {
  const code = n(args[0]);
  if (code < 0 || code > 0x10_ff_ff || (code >= 0xd8_00 && code <= 0xdf_ff)) return false;
  return codePointBytes(code);
});
defineFunction('mb_ord(string $string, ?string $encoding = null): int|false', ({ args }) => {
  const text = dec(s(args[0]));
  if (text === '') throwError('ValueError', 'mb_ord(): Argument #1 ($string) must not be empty');
  return BigInt(text.codePointAt(0) as number);
});

// Paths, which these functions handle as strings without touching any file ------------------------------------------

defineFunction('basename(string $path, string $suffix = ""): string', ({ args }) => {
  let path = s(args[0]).replace(/\/+$/, '');
  path = path.slice(path.lastIndexOf('/') + 1);
  const suffix = args[1] === undefined ? '' : s(args[1]);
  if (suffix !== '' && path.endsWith(suffix) && path !== suffix) path = path.slice(0, -suffix.length);
  return path;
});
defineFunction('dirname(string $path, int $levels = 1): string', ({ args }) => {
  let path = s(args[0]);
  for (let level = 0; level < Number(args[1] ?? 1n); level++) {
    const trimmed = path.replace(/\/+$/, '');
    const slash = trimmed.lastIndexOf('/');
    if (slash === -1) return '.';
    path = trimmed.slice(0, slash).replace(/\/+$/, '') || '/';
  }
  return path;
});
