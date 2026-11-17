// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { dec, enc } from './bytes';
import { callCallback } from './callables';
import { throwError, warn } from './errors';
import { isCallable } from './libCore';
import { defineConstant, defineFunction } from './native';
import { toStr } from './operators';
import { type Compiled, groupName, PatternError, translate } from './pcrePattern';
import { rt } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import { PhpArray, type Ref, type Value } from './values';

const PREG_CONSTANTS: [string, bigint][] = [
  ['PREG_PATTERN_ORDER', 1n],
  ['PREG_SET_ORDER', 2n],
  ['PREG_OFFSET_CAPTURE', 256n],
  ['PREG_UNMATCHED_AS_NULL', 512n],
  ['PREG_SPLIT_NO_EMPTY', 1n],
  ['PREG_SPLIT_DELIM_CAPTURE', 2n],
  ['PREG_SPLIT_OFFSET_CAPTURE', 4n],
  ['PREG_GREP_INVERT', 1n],
  ['PREG_NO_ERROR', 0n],
  ['PREG_INTERNAL_ERROR', 1n],
  ['PREG_BACKTRACK_LIMIT_ERROR', 2n],
  ['PREG_RECURSION_LIMIT_ERROR', 3n],
  ['PREG_BAD_UTF8_ERROR', 4n],
  ['PREG_BAD_UTF8_OFFSET_ERROR', 5n],
  ['PREG_JIT_STACKLIMIT_ERROR', 6n],
];
for (const [name, value] of PREG_CONSTANTS) defineConstant(name, value);
defineConstant('PCRE_VERSION', '10.47 2025-10-21');
defineConstant('PCRE_VERSION_MAJOR', 10n);
defineConstant('PCRE_VERSION_MINOR', 47n);
defineConstant('PCRE_JIT_SUPPORT', false);

/**
 * Translated patterns, shared by all runs in the server's process, so that a pattern in a loop is translated once. It
 * keeps only the latest ones, as the patterns that programs build are unbounded.
 */
const cache = new Map<string, Compiled | string>();
const CACHE_LIMIT = 256;

/** Compiles a PCRE pattern with delimiters, warning and returning undefined as PHP does for a bad pattern. */
function compile(name: string, pattern: string): Compiled | undefined {
  let compiled = cache.get(pattern);
  if (compiled === undefined) {
    try {
      compiled = translate(pattern);
    } catch (error) {
      if (error instanceof UnsupportedFeatureError) throw error;
      compiled = error instanceof PatternError ? error.message : `Compilation failed: ${(error as Error).message}`;
    }
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    cache.set(pattern, compiled);
  }
  if (typeof compiled === 'string') {
    warn(`${name}(): ${compiled}`);
    rt().lastPregError = 1;
    return undefined;
  }
  return compiled;
}

// Matching -------------------------------------------------------------------------------------------------------------

interface Match {
  /** Byte offsets of the start and end of the whole match and each group, -1 for a group that did not take part. */
  starts: number[];
  ends: number[];
  texts: (string | undefined)[];
}

/**
 * The matches of a compiled pattern in a subject, from byte `offset` on (counted from the end if negative), as PCRE
 * finds them: after an empty match, PCRE looks for a non-empty one at the same place before moving on. Sets the PCRE
 * error and yields nothing for a bad subject or offset.
 */
// code-gauge-allow functionCognitiveComplexity 16 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function* matchesOf(compiled: Compiled, subject: string, offset = 0, status?: { error: number }): Generator<Match> {
  const prepared = prepareSubject(compiled, subject, offset);
  if (!prepared) {
    if (status) status.error = rt().lastPregError;
    return;
  }
  const { text, byteOffset } = prepared;
  let { position } = prepared;
  let retry = false;
  while (position <= text.length) {
    rt().spend();
    const regex = retry ? compiled.retry : compiled.regex;
    regex.lastIndex = position;
    const result = regex.exec(text) as (RegExpExecArray & { indices: RegExpIndicesArray }) | null;
    // The host's engine cannot be interrupted and may backtrack for seconds before giving up.
    rt().budget.checkClock();
    if (!result) {
      if (!retry || position >= text.length) return;
      retry = false;
      position += compiled.utf8 && (text.codePointAt(position) ?? 0) > 0xff_ff ? 2 : 1;
      continue;
    }
    const [matchStart, matchEnd] = matchBounds(compiled, result);
    yield toMatch(compiled, result, [matchStart, matchEnd], byteOffset);
    position = matchEnd;
    retry = matchStart === matchEnd;
  }
}

/**
 * The text to match a subject as and where to start, from byte `offset` (counted from the end if negative), or
 * undefined after setting the PCRE error for a bad subject or offset.
 */
function prepareSubject(
  compiled: Compiled,
  subject: string,
  offset: number
): { text: string; position: number; byteOffset: (index: number) => number } | undefined {
  const start = offset < 0 ? Math.max(subject.length + offset, 0) : offset;
  const text = compiled.utf8 ? dec(subject) : subject;
  rt().lastPregError = subjectError(compiled, subject, text, start);
  if (rt().lastPregError !== 0) return undefined;
  if (!compiled.utf8) return { text, position: start, byteOffset: (index) => index };
  return { text, position: charIndexOf(text, start), byteOffset: byteIndexer(text) };
}

/** The subject error that matching from byte `start` gives before matching anything, 0 for none. */
function subjectError(compiled: Compiled, subject: string, text: string, start: number): number {
  if (start > subject.length) return 1;
  if (!compiled.utf8) return 0;
  if (enc(text) !== subject) return 4;
  return ((subject.codePointAt(start) ?? 0) & 0xc0) === 0x80 ? 5 : 0;
}

/** Where the reported match starts and ends: after the last `\K` passed, if any. */
function matchBounds(compiled: Compiled, result: RegExpExecArray & { indices: RegExpIndicesArray }): [number, number] {
  let [start, end] = result.indices[0] as [number, number];
  for (const name of compiled.keeps) {
    const keep = result.indices.groups?.[name];
    if (keep) start = Math.max(start, keep[0]);
  }
  return [start, end];
}

function toMatch(
  compiled: Compiled,
  result: RegExpExecArray & { indices: RegExpIndicesArray },
  bounds: [number, number],
  byteOffset: (index: number) => number
): Match {
  const pairs = [bounds];
  for (let group = 1; group <= compiled.groupCount; group++) {
    pairs.push(result.indices.groups?.[groupName(group)] ?? [-1, -1]);
  }
  const text = (start: number, end: number): string | undefined => {
    if (start === -1) return undefined;
    const value = result.input.slice(start, end);
    return compiled.utf8 ? enc(value) : value;
  };
  return {
    starts: pairs.map(([start]) => (start === -1 ? -1 : byteOffset(start))),
    ends: pairs.map(([, end]) => (end === -1 ? -1 : byteOffset(end))),
    texts: pairs.map(([start, end]) => text(start, end)),
  };
}

function byteIndexer(text: string): (index: number) => number {
  const offsets = new Map<number, number>();
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    offsets.set(index, bytes);
    bytes += enc(char).length;
    index += char.length;
  }
  offsets.set(index, bytes);
  return (position) => offsets.get(position) ?? bytes;
}

function charIndexOf(text: string, byteOffset: number): number {
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    if (bytes >= byteOffset) return index;
    bytes += enc(char).length;
    index += char.length;
  }
  return index;
}

/** Builds the array a match fills: by group number, with named groups before their numbers. */
function matchArray(
  compiled: Compiled,
  match: Match,
  offsetCapture: boolean,
  unmatchedAsNull: boolean,
  trim: boolean
): PhpArray {
  const array = new PhpArray();
  let last = match.texts.length - 1;
  if (trim && !unmatchedAsNull) while (last > 0 && match.texts[last] === undefined) last--;
  for (let group = 0; group <= last; group++) {
    const text = match.texts[group];
    const value: Value = text ?? (unmatchedAsNull ? null : '');
    const entry = offsetCapture ? PhpArray.list([value, BigInt(match.starts[group])]) : value;
    const name = compiled.names[group];
    if (name !== undefined) array.set(name, entry);
    array.set(BigInt(group), entry);
  }
  return array;
}

defineFunction(
  'preg_match(string $pattern, string $subject, &$matches = null, int $flags = 0, int $offset = 0): int|false',
  ({ args, refs }) => {
    const compiled = compile('preg_match', args[0] as string);
    if (!compiled) return false;
    const flags = (args[3] as bigint | undefined) ?? 0n;
    if ((flags & 0xffn) !== 0n)
      throwError('ValueError', 'preg_match(): Argument #4 ($flags) must be a PREG_* constant');
    rt().lastPregError = 0;
    const offset = Number((args[4] as bigint | undefined) ?? 0n);
    const first = matchesOf(compiled, args[1] as string, offset).next();
    if (refs[2]) {
      refs[2].v = first.done
        ? new PhpArray()
        : matchArray(compiled, first.value, (flags & 256n) !== 0n, (flags & 512n) !== 0n, true);
    }
    if (rt().lastPregError !== 0) return false;
    return first.done ? 0n : 1n;
  }
);
defineFunction(
  'preg_match_all(string $pattern, string $subject, &$matches = null, int $flags = 0, int $offset = 0): int|false',
  ({ args, refs }) => {
    const compiled = compile('preg_match_all', args[0] as string);
    if (!compiled) return false;
    let flags = (args[3] as bigint | undefined) ?? 0n;
    if ((flags & 0xffn) > 2n) {
      throwError('ValueError', 'preg_match_all(): Argument #4 ($flags) must be a PREG_* constant');
    }
    rt().lastPregError = 0;
    if ((flags & 3n) === 0n) flags |= 1n;
    const offsetCapture = (flags & 256n) !== 0n;
    const unmatchedAsNull = (flags & 512n) !== 0n;
    const matches = [...matchesOf(compiled, args[1] as string, Number((args[4] as bigint | undefined) ?? 0n))];
    if (refs[2]) {
      let result = new PhpArray();
      if ((flags & 2n) !== 0n) {
        for (const match of matches) result.append(matchArray(compiled, match, offsetCapture, unmatchedAsNull, true));
      } else if (rt().lastPregError !== 1) {
        // An offset past the end fails before PHP fills in the empty groups.
        result = patternOrder(compiled, matches, offsetCapture, unmatchedAsNull);
      }
      refs[2].v = result;
    }
    return rt().lastPregError === 0 ? BigInt(matches.length) : false;
  }
);

/** Builds `preg_match_all`'s matches by group (`PREG_PATTERN_ORDER`), with named groups before their numbers. */
function patternOrder(
  compiled: Compiled,
  matches: Match[],
  offsetCapture: boolean,
  unmatchedAsNull: boolean
): PhpArray {
  const result = new PhpArray();
  for (let group = 0; group <= compiled.groupCount; group++) {
    const column = new PhpArray();
    for (const match of matches) {
      const value: Value = match.texts[group] ?? (unmatchedAsNull ? null : '');
      column.append(offsetCapture ? PhpArray.list([value, BigInt(match.starts[group])]) : value);
    }
    const name = compiled.names[group];
    if (name !== undefined) result.set(name, column);
    result.set(BigInt(group), name === undefined ? column : column.copy());
  }
  return result;
}

/** Expands `$1`, `\1`, and `${1}` in a replacement, where a backslash before `\` or `$` makes it literal. */
function expandReplacement(replacement: string, match: Match): string {
  return replacement.replaceAll(
    /\\([\\$])|\\(\d{1,2})|\$(\d{1,2})|\$\{(\d{1,2})\}/g,
    (_token, escaped?: string, a?: string, b?: string, c?: string) => escaped ?? match.texts[Number(a ?? b ?? c)] ?? ''
  );
}

function replaceOne(
  name: string,
  pattern: string,
  subject: string,
  limit: number,
  count: { value: number },
  replace: (match: Match) => string
): string | undefined {
  const compiled = compile(name, pattern);
  return compiled && replaceCompiled(compiled, subject, limit, count, replace);
}

function replaceCompiled(
  compiled: Compiled,
  subject: string,
  limit: number,
  count: { value: number },
  replace: (match: Match) => string
): string | undefined {
  const status = { error: 0 };
  let result = '';
  let last = 0;
  let done = 0;
  for (const match of matchesOf(compiled, subject, 0, status)) {
    if (limit >= 0 && done >= limit) break;
    result += subject.slice(last, match.starts[0]) + replace(match);
    last = match.ends[0];
    done++;
    rt().ensureStringFits(result.length);
  }
  if (status.error !== 0) return undefined;
  count.value += done;
  return result + subject.slice(last);
}

function pregReplace(
  name: string,
  args: Value[],
  refs: (Ref | undefined)[],
  replacer: (pattern: number) => (match: Match) => string,
  filter = false
): Value {
  rt().lastPregError = 0;
  const [patternValue, , subjectValue, limitValue] = args;
  const limit = limitValue === undefined ? -1 : Number(limitValue);
  const patterns =
    patternValue instanceof PhpArray ? patternValue.values().map((item) => toStr(item)) : [toStr(patternValue)];
  const count = { value: 0 };
  // preg_filter drops a subject that no pattern matched.
  const replaceSubject = (subject: string): string | undefined => {
    const before = count.value;
    let current: string | undefined = subject;
    for (const [index, pattern] of patterns.entries()) {
      current = replaceOne(name, pattern, current, limit, count, replacer(index));
      if (current === undefined) return undefined;
    }
    return filter && count.value === before ? undefined : current;
  };
  const result = mapSubjects(subjectValue, replaceSubject);
  if (refs[4]) refs[4].v = BigInt(count.value);
  return result;
}

/** Replaces in a subject, or in each subject of an array, leaving out those whose replacement fails. */
function mapSubjects(subject: Value, replace: (subject: string) => string | undefined): Value {
  if (!(subject instanceof PhpArray)) return replace(toStr(subject)) ?? null;
  const array = new PhpArray();
  for (const [key, item] of subject.entries()) {
    const replaced = replace(toStr(item));
    if (replaced !== undefined) array.set(key, replaced);
  }
  return array;
}

for (const [name, filter] of [
  ['preg_replace', false],
  ['preg_filter', true],
] as const) {
  defineFunction(
    `${name}(string|array $pattern, string|array $replacement, string|array $subject, int $limit = -1, &$count = null): string|array|null`,
    ({ args, refs }) => {
      const replacement = args[1];
      if (replacement instanceof PhpArray && !(args[0] instanceof PhpArray)) {
        throwError(
          'TypeError',
          `${name}(): Argument #1 ($pattern) must be of type array when argument #2 ($replacement) is an array, string given`
        );
      }
      const replacements =
        replacement instanceof PhpArray ? replacement.values().map((item) => toStr(item)) : undefined;
      return pregReplace(
        name,
        args,
        refs,
        (index) => (match) => expandReplacement(replacements ? (replacements[index] ?? '') : toStr(replacement), match),
        filter
      );
    }
  );
}
defineFunction(
  'preg_replace_callback(string|array $pattern, callable $callback, string|array $subject, int $limit = -1, &$count = null, int $flags = 0): string|array|null',
  ({ args, refs }) => {
    const flags = (args[5] as bigint | undefined) ?? 0n;
    return pregReplace('preg_replace_callback', args, refs, (index) => (match) => {
      const compiled = compile(
        'preg_replace_callback',
        toStr(args[0] instanceof PhpArray ? (args[0].values()[index] as Value) : args[0])
      ) as Compiled;
      return toStr(
        callCallback(args[1], [matchArray(compiled, match, (flags & 256n) !== 0n, (flags & 512n) !== 0n, true)])
      );
    });
  }
);
defineFunction(
  'preg_replace_callback_array(array $pattern, string|array $subject, int $limit = -1, &$count = null, int $flags = 0): string|array|null',
  ({ args, refs }) => {
    rt().lastPregError = 0;
    const limit = Number((args[2] as bigint | undefined) ?? -1n);
    const flags = (args[4] as bigint | undefined) ?? 0n;
    const count = { value: 0 };
    let subject: Value = args[1];
    // Each pattern replaces in every subject before the next pattern does.
    for (const [pattern, callback] of (args[0] as PhpArray).entries()) {
      if (typeof pattern !== 'string') {
        throwError(
          'TypeError',
          'preg_replace_callback_array(): Argument #1 ($pattern) must contain only string patterns as keys'
        );
      }
      if (!isCallable(callback)) {
        throwError(
          'TypeError',
          'preg_replace_callback_array(): Argument #1 ($pattern) must contain only valid callbacks'
        );
      }
      subject = mapSubjects(subject, (text) =>
        replaceOne('preg_replace_callback_array', pattern, text, limit, count, (match) => {
          const compiled = compile('preg_replace_callback_array', pattern) as Compiled;
          return toStr(
            callCallback(callback, [matchArray(compiled, match, (flags & 256n) !== 0n, (flags & 512n) !== 0n, true)])
          );
        })
      );
      if (subject === null) return null;
    }
    if (refs[3]) refs[3].v = BigInt(count.value);
    return subject;
  }
);
defineFunction(
  'preg_split(string $pattern, string $subject, int $limit = -1, int $flags = 0): array|false',
  // code-gauge-allow functionCognitiveComplexity 29 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
  // code-gauge-allow functionNcss 36 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
  ({ args }) => {
    const compiled = compile('preg_split', args[0] as string);
    if (!compiled) return false;
    rt().lastPregError = 0;
    const subject = args[1] as string;
    let limit = args[2] === undefined || args[2] === null ? -1 : Number(args[2]);
    if (limit === 0) limit = -1;
    const flags = (args[3] as bigint | undefined) ?? 0n;
    const noEmpty = (flags & 1n) !== 0n;
    const delimCapture = (flags & 2n) !== 0n;
    const offsetCapture = (flags & 4n) !== 0n;
    const result = new PhpArray();
    const add = (text: string, offset: number): void => {
      result.append(offsetCapture ? PhpArray.list([text, BigInt(offset)]) : text);
    };
    let last = 0;
    for (const match of matchesOf(compiled, subject)) {
      if (limit !== -1 && limit <= 1) break;
      if (!noEmpty || match.starts[0] !== last) {
        add(subject.slice(last, match.starts[0]), last);
        if (limit !== -1) limit--;
      }
      if (delimCapture) {
        const lastGroup = match.texts.findLastIndex((text) => text !== undefined);
        for (let group = 1; group <= lastGroup; group++) {
          const text = match.texts[group] ?? '';
          if (!(noEmpty && text === '')) add(text, match.starts[group]);
        }
      }
      last = match.ends[0];
    }
    if (rt().lastPregError !== 0) return false;
    if (!noEmpty || last < subject.length) add(subject.slice(last), last);
    return result;
  }
);
defineFunction('preg_quote(string $str, ?string $delimiter = null): string', ({ args }) => {
  const delimiter = (args[1] as string | null | undefined) ?? '';
  let result = '';
  for (const char of args[0] as string) {
    if (String.raw`.\+*?[^]$(){}=!<>|:-#/`.includes(char) && (char !== '/' || delimiter === '/')) result += `\\${char}`;
    else if (char === '\0') result += String.raw`\000`;
    else if (delimiter !== '' && char === delimiter[0]) result += `\\${char}`;
    else result += char;
  }
  return result;
});
defineFunction('preg_grep(string $pattern, array $array, int $flags = 0): array|false', ({ args }) => {
  const compiled = compile('preg_grep', args[0] as string);
  if (!compiled) return false;
  const invert = ((args[2] as bigint | undefined) ?? 0n) === 1n;
  const result = new PhpArray();
  for (const [key, value] of (args[1] as PhpArray).entries()) {
    const matched = !matchesOf(compiled, toStr(value)).next().done;
    if (matched !== invert) result.set(key, value);
  }
  return result;
});
defineFunction('preg_last_error(): int', () => BigInt(rt().lastPregError));
defineFunction('preg_last_error_msg(): string', () => {
  const messages = [
    'No error',
    'Internal error',
    'Backtrack limit exhausted',
    'Recursion limit exhausted',
    'Malformed UTF-8 characters, possibly incorrectly encoded',
    'The offset did not correspond to the beginning of a valid UTF-8 code point',
    'JIT stack limit exhausted',
  ];
  return messages[rt().lastPregError] ?? 'Internal error';
});
