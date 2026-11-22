// code-gauge-allow-file fileNcss 982 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
// oxlint-disable typescript/no-misused-spread -- PHP splits strings into bytes or code points, never into grapheme clusters.
// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { byteAt, charAt, enc, lower, untilNul, upper } from './bytes';
import { byteMembership, literalMatches, spendScan } from './byteSearch';
import { callStack } from './calls';
import { debugType, valueName } from './conversions';
import { deprecated, throwError, warn } from './errors';
import { decodeHtml, escapeHtml, nextChar, translationTable } from './htmlEntities';
import { writeStream } from './libCore';
import { ctypeUpper, isCtypeAlpha, isCtypeSpace, isUtf8Ctype } from './libLocale';
import { defineAlias, defineConstant, defineFunction, defineOverloadedFunction, markDeprecated } from './native';
import { toInt, toStr, withStringConversionErrors } from './operators';
import { rt } from './runtime';
import { shuffle } from './shuffle';
import { formatPrintf } from './sprintf';
import { incrementString } from './strings';
import { allowedTags, stripTags } from './stripTags';
import { UnsupportedFeatureError } from './unsupported';
import { type NativeContext, PhpArray, PhpObject, Ref, type Value } from './values';

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
defineConstant('ENT_XML1', 16n);
defineConstant('ENT_XHTML', 32n);
defineConstant('ENT_DISALLOWED', 128n);
defineConstant('HTML_SPECIALCHARS', 0n);
defineConstant('HTML_ENTITIES', 1n);

const s = (value: Value): string => value as string;
const n = (value: Value): number => Number(value as bigint);

function checkLength(text: string): string {
  rt().ensureStringFits(text.length);
  rt().spend(Math.ceil(text.length / 64));
  return text;
}

defineFunction('strlen(string $string): int', ({ args }) => BigInt(s(args[0]).length));
defineFunction('str_repeat(string $string, int $times): string', ({ args }) => {
  const times = n(args[1]);
  if (times < 0) throwError('ValueError', 'str_repeat(): Argument #2 ($times) must be greater than or equal to 0');
  rt().ensureStringFits(s(args[0]).length * times);
  return checkLength(s(args[0]).repeat(times));
});
defineFunction('strtoupper(string $string): string', ({ args }) => upper(s(args[0])));
defineFunction('strtolower(string $string): string', ({ args }) => lower(s(args[0])));
defineFunction('ucfirst(string $string): string', ({ args }) => upper(s(args[0]).slice(0, 1)) + s(args[0]).slice(1));
defineFunction('lcfirst(string $string): string', ({ args }) => lower(s(args[0]).slice(0, 1)) + s(args[0]).slice(1));
defineFunction(String.raw`ucwords(string $string, string $separators = " \t\r\n\f\v"): string`, ({ args }) => {
  const text = s(args[0]);
  if (text === '') return text;
  const separators = charMask(args[1] === undefined ? ' \t\r\n\f\v' : s(args[1]), 'ucwords');
  let result = '';
  let capitalize = true;
  for (let index = 0; index < text.length; index++) {
    spendScan(index);
    const byte: string = capitalize ? upper(text[index]) : text[index];
    result += byte;
    capitalize = separators[byte.charCodeAt(0)] === 1;
  }
  return result;
});

const DEFAULT_TRIM = ' \n\r\t\v\0';

function trimText(text: string, list: string | undefined, name: string, left: boolean, right: boolean): string {
  const mask = charMask(list ?? DEFAULT_TRIM, name);
  let start = 0;
  let end = text.length;
  if (left) while (start < end && mask[text.charCodeAt(start)]) start++;
  if (right) while (end > start && mask[text.charCodeAt(end - 1)]) end--;
  return text.slice(start, end);
}

/** The characters a character list names, expanding ranges such as `a..z`, as PHP's php_charmask does. */
function charMask(list: string, name: string): Uint8Array {
  rt().spend(4 * Math.ceil(list.length / 256));
  const mask = new Uint8Array(256);
  for (let index = 0; index < list.length; index++) {
    const from = list.charCodeAt(index);
    if (index + 3 < list.length && list.startsWith('..', index + 1) && list.charCodeAt(index + 3) >= from) {
      mask.fill(1, from, list.charCodeAt(index + 3) + 1);
      index += 3;
    } else if (index + 1 < list.length && list.startsWith('..', index)) {
      warn(`${name}(): Invalid '..'-range${rangeProblem(list, index)}`);
    } else mask[from] = 1;
  }
  return mask;
}

function rangeProblem(list: string, index: number): string {
  if (index === 0) return ", no character to the left of '..'";
  if (index + 2 >= list.length) return ", no character to the right of '..'";
  if (list.charCodeAt(index - 1) > list.charCodeAt(index + 2)) return ", '..'-range needs to be incrementing";
  return '';
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
  ({ args }) => padString('str_pad', args)
);
export interface PaddingCharacters {
  length: number;
  prefix(count: number): string;
}

export function padString(
  name: string,
  args: Value[],
  characters: (bytes: string) => PaddingCharacters = (bytes) => ({
    length: bytes.length,
    prefix: (count) => bytes.slice(0, count),
  })
): string {
  const text = s(args[0]);
  const length = n(args[1]);
  const total = length - characters(text).length;
  if (total <= 0) return text;
  const pad = args[2] === undefined ? ' ' : s(args[2]);
  const type = args[3] === undefined ? 1 : n(args[3]);
  const emptyPad = (): never => throwError('ValueError', `${name}(): Argument #3 ($pad_string) must not be empty`);
  if (pad === '') emptyPad();
  if (type < 0 || type > 2) {
    throwError('ValueError', `${name}(): Argument #4 ($pad_type) must be STR_PAD_LEFT, STR_PAD_RIGHT, or STR_PAD_BOTH`);
  }
  const pattern = characters(pad);
  if (pattern.length === 0) emptyPad();
  const left = type === 0 ? total : type === 1 ? 0 : Math.floor(total / 2);
  const [before, after] = [left, total - left].map((count) => ({
    copies: Math.floor(count / pattern.length),
    tail: pattern.prefix(count % pattern.length),
  }));
  const bytes = text.length + pad.length * (before.copies + after.copies) + before.tail.length + after.tail.length;
  const runtime = rt();
  runtime.ensureStringFits(bytes);
  runtime.spend(Math.ceil(length / 64));
  return pad.repeat(before.copies) + before.tail + text + pad.repeat(after.copies) + after.tail;
}

defineFunction('str_split(string $string, int $length = 1): array', ({ args }) => {
  const text = s(args[0]);
  const length = args[1] === undefined ? 1 : n(args[1]);
  if (length < 1) throwError('ValueError', 'str_split(): Argument #2 ($length) must be greater than 0');
  if (text === '') return new PhpArray();
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += length) parts.push(text.slice(index, index + length));
  return PhpArray.list(parts);
});
defineFunction('explode(string $separator, string $string, int $limit = PHP_INT_MAX): array', ({ args }) => {
  const separator = s(args[0]);
  const text = s(args[1]);
  const limit = args[2] === undefined ? Number.MAX_SAFE_INTEGER : n(args[2]);
  if (separator === '') throwError('ValueError', 'explode(): Argument #1 ($separator) must not be empty');
  const parts = text.split(separator);
  if (limit > 0) {
    if (parts.length > limit)
      return PhpArray.list([...parts.slice(0, limit - 1), parts.slice(limit - 1).join(separator)]);
    return PhpArray.list(parts);
  }
  if (limit < 0) return PhpArray.list(parts.slice(0, limit));
  return PhpArray.list([parts.length > 1 ? parts.join(separator) : text]);
});
// `mixed` lets the body report the legacy argument order as PHP does, before the type of `$array` is checked.
defineOverloadedFunction(
  'implode(mixed $separator): string',
  'implode(array|string $separator, mixed $array = null): string',
  implode,
  { shortParamsDirectOnly: true }
);

function implode({ args, directOverload }: NativeContext): string {
  let [separator, array] = args;
  const name = callStack.at(-1)?.name ?? 'implode';
  if (directOverload && args.length === 2 && separator instanceof PhpArray)
    throwError('TypeError', `${name}(): Argument #1 ($separator) must be of type string, array given`);
  if (array !== undefined && array !== null && !(array instanceof PhpArray))
    throwError('TypeError', `${name}(): Argument #2 ($array) must be of type ?array, ${valueName(array)} given`);
  if (array === undefined || array === null) {
    if (!(separator instanceof PhpArray)) {
      throwError(
        'TypeError',
        `${name}(): If argument #1 ($separator) is of type string, argument #2 ($array) must be of type array, null given`
      );
    }
    array = separator;
    separator = '';
  } else if (separator instanceof PhpArray) {
    throwError('TypeError', `${name}(): Argument #1 ($separator) must be of type string, array given`);
  }
  let result = '';
  let first = true;
  for (const item of (array as PhpArray).iterValues()) {
    rt().spend();
    if (!first) result += separator as string;
    first = false;
    result += toStr(item);
    rt().ensureStringFits(result.length);
  }
  return result;
}
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

// code-gauge-allow functionCognitiveComplexity 22 -- Resolves back and forward byte searches with shared case folding and offset checks.
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
    rt().ensureStringFits(subject.length + (parts.length - 1) * (replace.length - search.length));
    return checkLength(parts.join(replace));
  }
  const lowered = lower(subject);
  const target = lower(search);
  let result = '';
  let position = 0;
  for (;;) {
    const found = lowered.indexOf(target, position);
    if (found === -1) break;
    rt().ensureStringFits(result.length + found - position + replace.length);
    result += subject.slice(position, found) + replace;
    position = found + search.length;
    count.value++;
  }
  rt().ensureStringFits(result.length + subject.length - position);
  return checkLength(result + subject.slice(position));
}

function strReplace(args: Value[], refs: (Ref | undefined)[], insensitive: boolean): Value {
  const [search, replace, subject] = args;
  if (!(search instanceof PhpArray) && replace instanceof PhpArray)
    throwError(
      'TypeError',
      `${insensitive ? 'str_ireplace' : 'str_replace'}(): Argument #2 ($replace) must be of type string when argument #1 ($search) is a string`
    );
  const count = { value: 0 };
  let result: Value = '';
  withStringConversionErrors((convert) => {
    const replaceOne = (text: string): string => replaceSubject(text, search, replace, convert, insensitive, count);
    if (subject instanceof PhpArray) {
      const array = new PhpArray();
      for (const [key, item] of subject.entries()) array.set(key, replaceOne(convert(item)));
      result = array;
    } else result = replaceOne(convert(subject));
    if (refs[3]) refs[3].v = BigInt(count.value);
  });
  return result;
}

function replaceSubject(
  text: string,
  search: Value,
  replace: Value,
  convert: (value: Value) => string,
  insensitive: boolean,
  count: { value: number }
): string {
  if (text === '') return '';
  if (!(search instanceof PhpArray)) return replaceAll(text, toStr(search), toStr(replace), insensitive, count);
  const replacements = replace instanceof PhpArray ? replace.entries() : undefined;
  const replacement = replacements ? '' : toStr(replace);
  let result = text;
  for (const [, item] of search.entries()) {
    rt().spend();
    const needle = convert(item);
    const next = replacements?.next();
    const substitute = next?.done === false ? convert(next.value[1]) : replacement;
    result = replaceAll(result, needle, substitute, insensitive, count);
    if (result === '') break;
  }
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
    if (needle === '') throwError('ValueError', 'substr_count(): Argument #2 ($needle) must not be empty');
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
  ({ args }) => {
    const [text, replace, offset, length] = args;
    if (!(text instanceof PhpArray)) {
      if (offset instanceof PhpArray)
        throwError(
          'TypeError',
          'substr_replace(): Argument #3 ($offset) cannot be an array when working on a single string'
        );
      if (length instanceof PhpArray)
        throwError(
          'TypeError',
          'substr_replace(): Argument #4 ($length) cannot be an array when working on a single string'
        );
    }
    const replacements = replace instanceof PhpArray ? replace.iterValues() : undefined;
    const offsets = offset instanceof PhpArray ? offset.iterValues() : undefined;
    const lengths = length instanceof PhpArray ? length.iterValues() : undefined;
    const one = (subject: string): string => {
      let start = Number(toInt(offsets ? (offsets.next().value ?? 0n) : offset));
      const lengthSlot = lengths?.next();
      const lengthValue = lengthSlot ? (lengthSlot.done ? undefined : toInt(lengthSlot.value)) : length;
      if (start < 0) start = Math.max(subject.length + start, 0);
      if (start > subject.length) start = subject.length;
      let end = lengthValue === null || lengthValue === undefined ? subject.length : Number(toInt(lengthValue));
      if (lengthValue !== null && lengthValue !== undefined)
        end = end < 0 ? Math.max(subject.length + end, start) : Math.min(start + end, subject.length);
      const replacement = toStr(replacements ? (replacements.next().value ?? '') : replace);
      rt().ensureStringFits(start + replacement.length + subject.length - Math.max(end, start));
      return subject.slice(0, start) + replacement + subject.slice(Math.max(end, start));
    };
    if (text instanceof PhpArray) {
      const array = new PhpArray();
      for (const [key, item] of text.entries()) array.set(key, one(toStr(item)));
      return array;
    }
    return one(s(text));
  }
);
defineFunction('strrev(string $string): string', ({ args }) => [...s(args[0])].toReversed().join(''));
defineFunction('strcmp(string $string1, string $string2): int', ({ args }) =>
  BigInt(compareLimited(s(args[0]), s(args[1]), Math.max(s(args[0]).length, s(args[1]).length), false))
);
defineFunction('strcasecmp(string $string1, string $string2): int', ({ args }) =>
  BigInt(compareLimited(s(args[0]), s(args[1]), Math.max(s(args[0]).length, s(args[1]).length), true))
);
defineFunction('strncmp(string $string1, string $string2, int $length): int', ({ args }) => {
  const length = n(args[2]);
  if (length < 0) throwError('ValueError', 'strncmp(): Argument #3 ($length) must be greater than or equal to 0');
  return BigInt(compareLimited(s(args[0]), s(args[1]), length, false));
});
defineFunction('strncasecmp(string $string1, string $string2, int $length): int', ({ args }) => {
  const length = n(args[2]);
  if (length < 0) throwError('ValueError', 'strncasecmp(): Argument #3 ($length) must be greater than or equal to 0');
  return BigInt(compareLimited(s(args[0]), s(args[1]), length, true));
});
defineFunction('strnatcmp(string $string1, string $string2): int', ({ args }) =>
  BigInt(naturalCompare(s(args[0]), s(args[1]), false))
);
defineFunction('strnatcasecmp(string $string1, string $string2): int', ({ args }) =>
  BigInt(naturalCompare(s(args[0]), s(args[1]), true))
);

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** Compares two runs of digits that start with a zero as fractions: the first different digit decides. */
function compareLeft(a: string, ap: number, b: string, bp: number): { result: number; ap: number; bp: number } {
  for (; ; ap++, bp++) {
    rt().spend();
    const da = ap < a.length && isDigit(byteAt(a, ap));
    const db = bp < b.length && isDigit(byteAt(b, bp));
    if (!da && !db) return { result: 0, ap, bp };
    if (!da) return { result: -1, ap, bp };
    if (!db) return { result: 1, ap, bp };
    if (byteAt(a, ap) !== byteAt(b, bp)) return { result: byteAt(a, ap) < byteAt(b, bp) ? -1 : 1, ap, bp };
  }
}

/** Compares two runs of digits as integers: the longer run wins, then the first different digit. */
// code-gauge-allow functionCognitiveComplexity 16 -- Compares an entire digit run while preserving first difference and run length.
function compareRight(a: string, ap: number, b: string, bp: number): { result: number; ap: number; bp: number } {
  let bias = 0;
  for (; ; ap++, bp++) {
    rt().spend();
    const da = ap < a.length && isDigit(byteAt(a, ap));
    const db = bp < b.length && isDigit(byteAt(b, bp));
    if (!da && !db) return { result: bias, ap, bp };
    if (!da) return { result: -1, ap, bp };
    if (!db) return { result: 1, ap, bp };
    if (bias === 0 && byteAt(a, ap) !== byteAt(b, bp)) bias = byteAt(a, ap) < byteAt(b, bp) ? -1 : 1;
  }
}

/** Compares strings in natural order, as PHP's strnatcmp_ex does. */
// code-gauge-allow functionNcss 51 -- Preserves the numeric and byte comparison order while advancing both cursors.
export function naturalCompare(a: string, b: string, insensitive: boolean): number {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length > b.length ? 1 : -1;
  let ap = 0;
  let bp = 0;
  let leading = true;
  for (;;) {
    rt().spend();
    let ca = byteAt(a, ap);
    let cb = byteAt(b, bp);
    while (leading && ca === 48 && ap + 1 < a.length && isDigit(byteAt(a, ap + 1))) {
      rt().spend();
      ca = byteAt(a, ++ap);
    }
    while (leading && cb === 48 && bp + 1 < b.length && isDigit(byteAt(b, bp + 1))) {
      rt().spend();
      cb = byteAt(b, ++bp);
    }
    leading = false;
    while (isCtypeSpace(ca)) {
      rt().spend();
      ca = byteAt(a, ++ap);
    }
    while (isCtypeSpace(cb)) {
      rt().spend();
      cb = byteAt(b, ++bp);
    }
    if (isDigit(ca) && isDigit(cb)) {
      const run = ca === 48 || cb === 48 ? compareLeft(a, ap, b, bp) : compareRight(a, ap, b, bp);
      ({ ap, bp } = run);
      if (run.result !== 0) return run.result;
      if (ap >= a.length && bp >= b.length) return 0;
      if (ap >= a.length) return -1;
      if (bp >= b.length) return 1;
      ca = byteAt(a, ap);
      cb = byteAt(b, bp);
    }
    if (insensitive) {
      ca = ctypeUpper(String.fromCharCode(ca)).charCodeAt(0);
      cb = ctypeUpper(String.fromCharCode(cb)).charCodeAt(0);
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
defineOverloadedFunction(
  'strtr(string $string, array $from): string',
  'strtr(string $string, string $from, string $to): string',
  ({ args, row }) => translate(args, row !== undefined),
  { nullTypes: { 1: 'array|string', 2: '?string' } }
);

function translate(args: Value[], inlined: boolean): string | null {
  const text = s(args[0]);
  const from = args[1];
  if (from instanceof PhpArray) return translatePairs(text, from, inlined);
  const source = s(from);
  const target = s(args[2]);
  const length = Math.min(source.length, target.length);
  const map = new Map<string, string>();
  for (let index = 0; index < length; index++) map.set(source[index], target[index]);
  return [...text].map((char) => map.get(char) ?? char).join('');
}

function translatePairs(text: string, replacements: PhpArray, inlined: boolean): string | null {
  if (text === '' || replacements.size === 0) return text;
  if (replacements.size === 1) return translateSinglePair(text, replacements, inlined);
  if (replacements.map.has('')) warn('strtr(): Ignoring replacement of empty string');
  const pairs: (readonly [string, Value | Ref])[] = [];
  for (const [key, value] of replacements.map) {
    const needle = String(key);
    if (needle !== '' && needle.length <= text.length) pairs.push([needle, value]);
  }
  if (pairs.length === 0) return text;
  const sorted = pairs.toSorted((x, y) => y[0].length - x[0].length);
  let result = '';
  for (let index = 0; index < text.length;) {
    const match = translationAt(text, index, sorted);
    if (!match) {
      result += text[index++];
      continue;
    }
    const [key, value] = match;
    const replacement = toStr(value instanceof Ref ? value.v : value);
    rt().ensureStringFits(result.length + replacement.length);
    result += replacement;
    index += key.length;
  }
  return result;
}

function translateSinglePair(text: string, replacements: PhpArray, inlined: boolean): string | null {
  const entry = replacements.map.entries().next();
  if (entry.done) return null;
  const [key, slot] = entry.value;
  const value = slot instanceof Ref ? slot.v : slot;
  if (key === '') {
    withStringConversionErrors((convert) => {
      convert(value);
      const pending = rt().nativeStringConversionPending && inlined;
      const caller = pending ? callStack.at(-1) : undefined;
      const name = caller?.name ?? (pending ? 'main' : 'strtr');
      const scope = caller?.className ? `${caller.className}::` : '';
      warn(`${scope}${name}(): Ignoring replacement of empty string`);
    });
    return text;
  }
  return replaceAll(text, String(key), toStr(value), false, { value: 0 });
}

function translationAt(
  text: string,
  index: number,
  pairs: readonly (readonly [string, Value | Ref])[]
): readonly [string, Value | Ref] | undefined {
  const runtime = rt();
  for (const pair of pairs) {
    const key = pair[0];
    if (text[index] !== key[0] || text.length - index < key.length) {
      runtime.spend();
      continue;
    }
    runtime.spend(Math.ceil(key.length / 64));
    if (text.startsWith(key, index)) return pair;
  }
  return undefined;
}

defineFunction('chr(int $codepoint): string', ({ args }) => {
  const code = args[0] as bigint;
  if (code < 0n || code > 255n) {
    deprecated(
      'chr(): Providing a value not in-between 0 and 255 is deprecated, this is because a byte value must be in the [0, 255] interval. The value used will be constrained using % 256'
    );
  }
  return String.fromCharCode(Number(BigInt.asUintN(8, code)));
});
defineFunction('ord(string $character): int', ({ args }) => {
  const text = s(args[0]);
  if (text === '') deprecated('ord(): Providing an empty string is deprecated');
  else if (text.length > 1) {
    deprecated('ord(): Providing a string that is not one byte long is deprecated. Use ord($str[0]) instead');
  }
  return BigInt(text.charCodeAt(0) || 0);
});
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

// code-gauge-allow functionCognitiveComplexity 17 -- Keeps the last break and current column through each emitted segment.
// code-gauge-allow functionNcss 44 -- Keeps the last break and current column through each emitted segment.
function wordwrap(text: string, width: number, breakText: string, cut: boolean): string {
  if (text === '') return '';
  if (breakText === '') throwError('ValueError', 'wordwrap(): Argument #3 ($break) must not be empty');
  if (width === 0 && cut)
    throwError('ValueError', 'wordwrap(): Argument #4 ($cut_long_words) cannot be true when argument #2 ($width) is 0');
  const breakLength = breakText.length;
  const breaks = literalMatches(text, breakText);
  let nextBreak = breaks.next().value;
  let result = '';
  let lastStart = 0;
  let lastSpace = 0;
  const append = (end: number, suffix = ''): void => {
    rt().ensureStringFits(result.length + end - lastStart + suffix.length);
    result += text.slice(lastStart, end) + suffix;
  };
  for (let current = 0; current < text.length; current++) {
    spendScan(current);
    const char = text[current];
    if (current === nextBreak) {
      append(current + breakLength);
      nextBreak = breaks.next().value;
      current += breakLength - 1;
      lastStart = current + 1;
      lastSpace = lastStart;
    } else if (char === ' ') {
      if (current - lastStart >= width) {
        append(current, breakText);
        lastStart = current + 1;
      }
      lastSpace = current;
    } else if (current - lastStart >= width && cut && lastStart >= lastSpace) {
      append(current, breakText);
      lastStart = current;
      lastSpace = current;
    } else if (current - lastStart >= width && lastStart < lastSpace) {
      append(lastSpace, breakText);
      lastStart = lastSpace + 1;
      lastSpace = lastStart;
    }
  }
  if (lastStart !== text.length) append(text.length);
  return result;
}

defineFunction('str_word_count(string $string, int $format = 0, ?string $characters = null): array|int', ({ args }) => {
  const text = s(args[0]);
  const format = args[1] === undefined ? 0 : n(args[1]);
  if (format < 0 || format > 2) {
    throwError('ValueError', 'str_word_count(): Argument #2 ($format) must be a valid format value');
  }
  const extra = typeof args[2] === 'string' ? charMask(args[2], 'str_word_count') : new Uint8Array();
  const words = text === '' ? [] : findWords(text, extra);
  if (format === 0) return BigInt(words.length);
  const array = new PhpArray();
  for (const [start, word] of words) {
    if (format === 1) array.append(word);
    else array.set(BigInt(start), word);
  }
  return array;
});

/** The words of a non-empty string with their offsets, as PHP's php_str_word_count finds them. */
function findWords(text: string, extra: Uint8Array): [number, string][] {
  let index = (text[0] === "'" || text[0] === '-') && !extra[text.charCodeAt(0)] ? 1 : 0;
  const end = text.endsWith('-') && !extra['-'.charCodeAt(0)] ? text.length - 1 : text.length;
  const words: [number, string][] = [];
  while (index < end) {
    const start = index;
    while (index < end && isWordChar(text[index], extra)) index++;
    if (index > start) words.push([start, text.slice(start, index)]);
    index++;
  }
  return words;
}

function isWordChar(char: string, extra: Uint8Array): boolean {
  const byte = char.charCodeAt(0);
  return isCtypeAlpha(byte) || extra[byte] === 1 || char === "'" || char === '-';
}

defineFunction('nl2br(string $string, bool $use_xhtml = true): string', ({ args }) => {
  const tag = args[1] === false ? '<br>' : '<br />';
  return s(args[0]).replaceAll(/\r\n|\n\r|\n|\r/g, (match) => tag + match);
});
defineFunction(
  'htmlspecialchars(string $string, int $flags = ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML401, ?string $encoding = null, bool $double_encode = true): string',
  ({ args }) => escapeHtml(s(args[0]), entityFlags(args[1]), false, args[3] !== false, htmlEncoding(args[2]))
);
defineFunction(
  'htmlspecialchars_decode(string $string, int $flags = ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML401): string',
  ({ args }) => decodeHtml(s(args[0]), entityFlags(args[1]), false)
);
defineFunction(
  'htmlentities(string $string, int $flags = ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML401, ?string $encoding = null, bool $double_encode = true): string',
  ({ args }) => escapeHtml(s(args[0]), entityFlags(args[1]), true, args[3] !== false, htmlEncoding(args[2]))
);
defineFunction(
  'html_entity_decode(string $string, int $flags = ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML401, ?string $encoding = null): string',
  ({ args }) => decodeHtml(s(args[0]), entityFlags(args[1]), true, htmlEncoding(args[2]))
);

function htmlEncoding(value: Value): boolean {
  const name = value === undefined || value === null ? '' : s(value);
  const charset = htmlCharset(name, callStack.at(-1)?.name ?? 'htmlentities');
  if (charset !== 'utf8' && charset !== 'latin1') throw new UnsupportedFeatureError(`HTML の文字コード（${name}）`);
  return charset === 'latin1';
}

function entityFlags(value: Value): bigint {
  return value === undefined ? 11n : (value as bigint);
}

defineFunction(
  'get_html_translation_table(int $table = HTML_SPECIALCHARS, int $flags = ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML401, string $encoding = "UTF-8"): array',
  ({ args }) => {
    const flags = entityFlags(args[1]);
    const charset = htmlCharset(args[2] === undefined ? '' : s(args[2]));
    const all = args[0] !== undefined && args[0] !== 0n && charset !== 'multibyte';
    if (all && (flags & 48n) === 48n)
      throw new UnsupportedFeatureError('HTML5 の文字実体参照の一覧（get_html_translation_table）');
    if (all && charset === 'other')
      throw new UnsupportedFeatureError('この文字コードの文字実体参照の一覧（get_html_translation_table）');
    const array = new PhpArray();
    for (const [key, entity] of translationTable(all, flags, charset === 'latin1')) array.set(key, entity);
    return array;
  }
);

const HTML_CHARSETS =
  'ISO-8859-1 ISO8859-1 ISO-8859-15 ISO8859-15 utf-8 cp1252 Windows-1252 1252 BIG5 950 GB2312 936 BIG5-HKSCS Shift_JIS SJIS 932 SJIS-win CP932 EUCJP EUC-JP eucJP-win KOI8-R koi8-ru koi8r cp1251 Windows-1251 win-1251 iso8859-5 iso-8859-5 cp866 866 ibm866 MacRoman'.split(
    ' '
  );

/** How htmlspecialchars' determine_charset classifies an encoding name for the tables this grader provides. */
function htmlCharset(
  name: string,
  functionName = 'get_html_translation_table'
): 'utf8' | 'latin1' | 'multibyte' | 'other' {
  if (name === '') return 'utf8';
  const known = HTML_CHARSETS.find((candidate) => lower(candidate) === lower(name));
  if (known === undefined) {
    warn(`${functionName}(): Charset "${name}" is not supported, assuming UTF-8`);
    return 'utf8';
  }
  // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- PHP names the charset `utf-8`.
  if (known === 'utf-8') return 'utf8';
  if (/^ISO-?8859-1$/.test(known)) return 'latin1';
  return /^(BIG5|950|GB2312|936|Shift_JIS|SJIS|932|CP932|EUC-?JP|eucJP-win)/.test(known) ? 'multibyte' : 'other';
}

defineFunction('strip_tags(string $string, array|string|null $allowed_tags = null): string', ({ args }) =>
  stripTags(s(args[0]), allowedTags(args[1] ?? null))
);

defineFunction('addslashes(string $string): string', ({ args }) =>
  s(args[0]).replaceAll(/["'\\\0]/g, (match) => (match === '\0' ? String.raw`\0` : `\\${match}`))
);
defineFunction('stripslashes(string $string): string', ({ args }) =>
  s(args[0]).replaceAll(/\\(.?)/gs, (_match, char: string) => (char === '0' ? '\0' : char))
);
const C_ESCAPES = new Map([
  ['\n', 'n'],
  ['\t', 't'],
  ['\r', 'r'],
  ['\u0007', 'a'],
  ['\v', 'v'],
  ['\b', 'b'],
  ['\f', 'f'],
]);

defineFunction('addcslashes(string $string, string $characters): string', ({ args }) => {
  const text = s(args[0]);
  if (text === '' || s(args[1]) === '') return text;
  const mask = charMask(s(args[1]), 'addcslashes');
  let result = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (!mask[code]) result += char;
    else {
      result +=
        code >= 32 && code <= 126 ? `\\${char}` : `\\${C_ESCAPES.get(char) ?? code.toString(8).padStart(3, '0')}`;
    }
  }
  return result;
});

const C_UNESCAPES = new Map([...C_ESCAPES].map(([char, letter]) => [letter, char]));

defineFunction('stripcslashes(string $string): string', ({ args }) =>
  s(args[0]).replaceAll(/\\(x[\dA-Fa-f]{1,2}|[0-7]{1,3}|[^])/g, (_match, escape: string) => {
    if (escape.length > 1 && escape[0] === 'x') return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    if (/^[0-7]/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8) & 0xff);
    return C_UNESCAPES.get(escape) ?? escape;
  })
);
defineFunction('quotemeta(string $string): string', ({ args }) =>
  s(args[0]).replaceAll(/[.\\+*?[^\]$()]/g, String.raw`\$&`)
);
defineFunction('str_rot13(string $string): string', ({ args }) =>
  s(args[0]).replaceAll(/[A-Za-z]/g, (char) => {
    const base = char <= 'Z' ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  })
);
defineFunction('strpbrk(string $string, string $characters): string|false', ({ args }) => {
  const text = s(args[0]);
  const characters = s(args[1]);
  if (characters === '') throwError('ValueError', 'strpbrk(): Argument #2 ($characters) must be a non-empty string');
  const bytes = byteMembership(characters);
  for (let index = 0; index < text.length; index++) {
    spendScan(index);
    if (bytes[text.charCodeAt(index)]) return text.slice(index);
  }
  return false;
});
defineFunction(
  'substr_compare(string $haystack, string $needle, int $offset, ?int $length = null, bool $case_insensitive = false): int',
  ({ args }) => {
    const haystack = s(args[0]);
    const length = args[3] === undefined || args[3] === null ? undefined : n(args[3]);
    if (length !== undefined && length <= 0) {
      if (length === 0) return 0n;
      throwError('ValueError', 'substr_compare(): Argument #4 ($length) must be greater than or equal to 0');
    }
    let offset = n(args[2]);
    if (offset < 0) offset = Math.max(haystack.length + offset, 0);
    if (offset > haystack.length) offsetError('substr_compare');
    const rest = haystack.slice(offset);
    const needle = s(args[1]);
    return BigInt(compareLimited(rest, needle, length ?? Math.max(needle.length, rest.length), args[4] === true));
  }
);

/** Compares at most `length` bytes as zend_binary_strncmp does: the first different bytes decide by their difference. */
function compareLimited(a: string, b: string, length: number, insensitive: boolean): number {
  const limit = Math.min(length, a.length, b.length);
  for (let index = 0; index < limit; index++) {
    let x = a.charCodeAt(index);
    let y = b.charCodeAt(index);
    if (insensitive) {
      if (x >= 65 && x <= 90) x += 32;
      if (y >= 65 && y <= 90) y += 32;
    }
    if (x !== y) return x - y;
  }
  return Math.sign(Math.min(length, a.length) - Math.min(length, b.length));
}

defineFunction('utf8_encode(string $string): string', ({ args }) => enc(s(args[0])));
defineFunction('utf8_decode(string $string): string', ({ args }) => {
  const text = s(args[0]);
  let result = '';
  for (let index = 0; index < text.length;) {
    const [length, code] = nextChar(text, index);
    result += code === undefined || code > 0xff ? '?' : String.fromCharCode(code);
    index += length;
  }
  return result;
});
for (const name of ['utf8_encode', 'utf8_decode'])
  markDeprecated(
    name,
    `Function ${name}() is deprecated since 8.2, visit the php.net documentation for various alternatives`
  );
defineFunction(
  String.raw`chunk_split(string $string, int $length = 76, string $separator = "\r\n"): string`,
  ({ args }) => {
    const text = s(args[0]);
    const length = args[1] === undefined ? 76 : n(args[1]);
    const separator = args[2] === undefined ? '\r\n' : s(args[2]);
    if (length < 1) throwError('ValueError', 'chunk_split(): Argument #2 ($length) must be greater than 0');
    if (text === '') return separator;
    if (separator === '') return text;
    const count = Math.ceil(text.length / length);
    const size = text.length + count * separator.length;
    rt().ensureStringFits(size);
    rt().spend(count + Math.ceil(size / 64));
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
      rt().spend();
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) {
        rt().spend();
        k++;
      }
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
  ({ args }) =>
    levenshtein(
      s(args[0]),
      s(args[1]),
      (args[2] as bigint | undefined) ?? 1n,
      (args[3] as bigint | undefined) ?? 1n,
      (args[4] as bigint | undefined) ?? 1n
    )
);

// code-gauge-allow functionCognitiveComplexity 17 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
function levenshtein(a: string, b: string, insert: bigint, replace: bigint, remove: bigint): bigint {
  if (a.length === 0) return BigInt.asIntN(64, BigInt(b.length) * insert);
  if (b.length === 0) return BigInt.asIntN(64, BigInt(a.length) * remove);
  if (a.length < b.length && insert === replace && replace === remove) [a, b] = [b, a];
  let previous = new BigInt64Array(b.length + 1);
  let current = new BigInt64Array(b.length + 1);
  for (let j = 1; j <= b.length; j++) previous[j] = previous[j - 1] + insert;
  const runtime = rt();
  for (let i = 0; i < a.length; i++) {
    runtime.spend(Math.ceil(b.length / 16));
    current[0] = previous[0] + remove;
    for (let j = 0; j < b.length; j++) {
      const substitute = BigInt.asIntN(64, previous[j] + (a[i] === b[j] ? 0n : replace));
      const deletion = BigInt.asIntN(64, previous[j + 1] + remove);
      const insertion = BigInt.asIntN(64, current[j] + insert);
      const withoutInsertion = substitute < deletion ? substitute : deletion;
      current[j + 1] = withoutInsertion < insertion ? withoutInsertion : insertion;
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

defineFunction('vfprintf(resource $stream, string $format, array $values): int', ({ args }) => {
  const stream = args[0] as PhpObject;
  const text = formatPrintf(s(args[1]), args[2] as PhpArray, (output) => writeStream(stream, output));
  return BigInt(text.length);
});
defineFunction('metaphone(string $string, int $max_phonemes = 0): string', ({ args }) => {
  const max = args[1] === undefined ? 0 : n(args[1]);
  if (max < 0) throwError('ValueError', 'metaphone(): Argument #2 ($max_phonemes) must be greater than or equal to 0');
  return metaphone(untilNul(s(args[0])), max);
});

/** The phonemes of a letter and how many letters after it they cover; `at` reads the letter at a relative offset. */
type MetaphoneRule = (at: (offset: number) => string) => [string, number];

const METAPHONE_RULES: Record<string, MetaphoneRule> = {
  B: (at) => [at(-1) === 'M' ? '' : 'B', 0],
  C: (at) => {
    if (makesSoft(at(1))) return at(1) === 'I' && at(2) === 'A' ? ['X', 0] : [at(-1) === 'S' ? '' : 'S', 0];
    return at(1) === 'H' ? ['X', 1] : ['K', 0];
  },
  D: (at) => (at(1) === 'G' && makesSoft(at(2)) ? ['J', 1] : ['T', 0]),
  G: (at) => {
    if (at(1) === 'H') return noGhToF(at(-3)) || at(-4) === 'H' ? ['', 0] : ['F', 1];
    if (at(1) === 'N')
      return !isCtypeAlpha(at(2).charCodeAt(0)) || (at(2) === 'E' && at(3) === 'D') ? ['', 0] : ['K', 0];
    return [makesSoft(at(1)) && at(-1) !== 'G' ? 'J' : 'K', 0];
  },
  H: (at) => [isVowel(at(1)) && !'CGPST'.includes(at(-1)) ? 'H' : '', 0],
  K: (at) => [at(-1) === 'C' ? '' : 'K', 0],
  P: (at) => [at(1) === 'H' ? 'F' : 'P', 0],
  Q: () => ['K', 0],
  S: (at) => {
    if (at(1) === 'I' && (at(2) === 'O' || at(2) === 'A')) return ['X', 0];
    return at(1) === 'H' ? ['X', 1] : ['S', 0];
  },
  T: (at) => {
    if (at(1) === 'I' && (at(2) === 'O' || at(2) === 'A')) return ['X', 0];
    if (at(1) === 'H') return ['0', 1];
    return [at(1) === 'C' && at(2) === 'H' ? '' : 'T', 0];
  },
  V: () => ['F', 0],
  W: (at) => [isVowel(at(1)) ? 'W' : '', 0],
  X: () => ['KS', 0],
  Y: (at) => [isVowel(at(1)) ? 'Y' : '', 0],
  Z: () => ['S', 0],
  ...Object.fromEntries([...'FJLMNR'].map((letter): [string, MetaphoneRule] => [letter, () => [letter, 0]])),
};

/** Encodes a word as the metaphone() of PHP's metaphone.c does, which reads letters through the C library's locale. */
function metaphone(word: string, max: number): string {
  const letter = (index: number): string => (index < 0 ? '\0' : ctypeUpper(charAt(word, index)));
  let index = 0;
  while (index < word.length && !isCtypeAlpha(word.charCodeAt(index))) index++;
  if (index >= word.length) return '';
  let [result, skip] = metaphoneStart(letter(index), letter(index + 1));
  for (index += skip; index < word.length && (max === 0 || result.length < max); index++) {
    const current = letter(index);
    if (!isCtypeAlpha(word.charCodeAt(index)) || (current === letter(index - 1) && current !== 'C')) continue;
    const rule = METAPHONE_RULES[current] as MetaphoneRule | undefined;
    let phonemes = '';
    [phonemes, skip] = rule ? rule((offset) => letter(index + offset)) : ['', 0];
    result += phonemes;
    index += skip;
  }
  return result;
}

/** The phonemes of the first letter, which keeps a vowel, and how many letters they cover. */
function metaphoneStart(first: string, next: string): [string, number] {
  if (first === 'A') return next === 'E' ? ['E', 2] : ['A', 1];
  if ('GKP'.includes(first) && next === 'N') return ['N', 2];
  if (first === 'W' && (next === 'R' || next === 'H' || isVowel(next))) return [next === 'R' ? 'R' : 'W', 2];
  if (first === 'X') return ['S', 1];
  return 'EIOU'.includes(first) ? [first, 1] : ['', 0];
}

function isVowel(letter: string): boolean {
  return letter.length === 1 && 'AEIOU'.includes(letter);
}

function makesSoft(letter: string): boolean {
  return letter.length === 1 && 'EIY'.includes(letter);
}

function noGhToF(letter: string): boolean {
  return letter.length === 1 && 'BDH'.includes(letter);
}

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
// code-gauge-allow functionCognitiveComplexity 17 -- Shares one byte histogram across modes that expose counts or character lists.
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
  shuffle(chars, (end) => mt.range(0n, end));
  return chars.join('');
});
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
  if (text === '') throwError('ValueError', 'str_increment(): Argument #1 ($string) must not be empty');
  if (!/^[A-Za-z\d]+$/.test(text))
    throwError(
      'ValueError',
      'str_increment(): Argument #1 ($string) must be composed only of alphanumeric ASCII characters'
    );
  return incrementString(text);
});
// code-gauge-allow functionCognitiveComplexity 18 -- Propagates borrow over ASCII character classes and handles a shortened result.
defineFunction('str_decrement(string $string): string', ({ args }) => {
  const text = s(args[0]);
  if (text === '') throwError('ValueError', 'str_decrement(): Argument #1 ($string) must not be empty');
  if (!/^[A-Za-z\d]+$/.test(text))
    throwError(
      'ValueError',
      'str_decrement(): Argument #1 ($string) must be composed only of alphanumeric ASCII characters'
    );
  if (text.startsWith('0') || text === 'a' || text === 'A')
    throwError('ValueError', `str_decrement(): Argument #1 ($string) "${text}" is out of decrement range`);
  const chars = [...text];
  let carry = true;
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index];
    if (char === 'a' || char === 'A' || char === '0') {
      chars[index] = char === 'a' ? 'z' : char === 'A' ? 'Z' : '9';
      continue;
    }
    chars[index] = String.fromCharCode(char.charCodeAt(0) - 1);
    carry = false;
    break;
  }
  if (carry || (chars[0] === '0' && chars.length > 1)) chars.shift();
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
  const bytes = byteMembership(s(args[1]));
  const matching = Number(inSet);
  let count = 0;
  while (count < text.length && bytes[text.charCodeAt(count)] === matching) {
    spendScan(count);
    count++;
  }
  return BigInt(count);
}

// Character classes --------------------------------------------------------------------------------------------------

// The reference PHP's C library classifies the bytes 0x80–0xFF as the characters of Latin-1 in its C.UTF-8 locale.
for (const [name, pattern] of [
  ['ctype_digit', /^\d+$/],
  ['ctype_alpha', /^[A-Za-z\u00AA\u00B5\u00BA\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF]+$/],
  ['ctype_alnum', /^[A-Za-z\d\u00AA\u00B5\u00BA\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF]+$/],
  ['ctype_upper', /^[A-Z\u00C0-\u00D6\u00D8-\u00DE]+$/],
  ['ctype_lower', /^[a-z\u00B5\u00DF-\u00F6\u00F8-\u00FF]+$/],
  ['ctype_space', /^[ \t\n\r\v\f\u00A0]+$/],
  ['ctype_punct', /^[!-/:-@[-`{-~\u00A1\u00A7\u00AB\u00B6\u00B7\u00BB\u00BF]+$/],
  ['ctype_xdigit', /^[\dA-Fa-f]+$/],
  // oxlint-disable-next-line no-control-regex -- ctype_cntrl matches the control bytes.
  ['ctype_cntrl', /^[\0-\u001F\u007F-\u009F\u00AD]+$/],
  ['ctype_print', /^[ -~\u00A0-\u00AC\u00AE-\u00FF]+$/],
  ['ctype_graph', /^[!-~\u00A1-\u00AC\u00AE-\u00FF]+$/],
] as const) {
  defineFunction(`${name}(mixed $text): bool`, ({ args }) => {
    let [value] = args;
    if (typeof value === 'bigint') {
      deprecated(`${name}(): Argument of type int will be interpreted as string in the future`);
      value =
        value >= -128n && value <= 255n
          ? String.fromCharCode(Number(value < 0n ? value + 256n : value))
          : value.toString();
    } else if (typeof value !== 'string') {
      const type = value instanceof PhpObject && value.isResource ? 'resource' : debugType(value);
      deprecated(`${name}(): Argument of type ${type} will be interpreted as string in the future`);
      return false;
    }
    // oxlint-disable-next-line no-control-regex -- In the C locale, the C library classifies only ASCII bytes.
    return pattern.test(value) && (isUtf8Ctype() || /^[\0-\u007F]*$/.test(value));
  });
}

// Paths, which these functions handle as strings without touching any file ------------------------------------------

defineFunction('basename(string $path, string $suffix = ""): string', ({ args }) => {
  let path = s(args[0]).replace(/\/+$/, '');
  path = path.slice(path.lastIndexOf('/') + 1);
  const suffix = args[1] === undefined ? '' : s(args[1]);
  if (suffix !== '' && path.endsWith(suffix) && path !== suffix) path = path.slice(0, -suffix.length);
  return path;
});
// code-gauge-allow functionCognitiveComplexity 16 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
defineFunction('dirname(string $path, int $levels = 1): string', ({ args }) => {
  const path = s(args[0]);
  const levels = (args[1] as bigint | undefined) ?? 1n;
  if (levels < 1n) throwError('ValueError', 'dirname(): Argument #2 ($levels) must be greater than or equal to 1');
  if (path === '') return '';
  let end = path.length;
  for (let level = 0n; level < levels; level++) {
    rt().spend();
    while (end > 0 && path[end - 1] === '/') end--;
    if (end === 0) return path.startsWith('/') ? '/' : '.';
    end = path.lastIndexOf('/', end - 1);
    if (end === -1) return '.';
  }
  while (end > 0 && path[end - 1] === '/') end--;
  return end === 0 ? '/' : path.slice(0, end);
});
