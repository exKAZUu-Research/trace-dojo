// code-gauge-allow-file fileNcss 462 -- The regex functions share matching, offsets, capture handling, and error state.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { dec, enc } from './bytes';
import { callCallback, consumeInvokedResult } from './callables';
import { type CleanupException, throwError, warn, withCleanupExceptions } from './errors';
import { isCallable } from './libCore';
import { defineConstant, defineFunction } from './native';
import { toStr } from './operators';
import { type Compiled, groupName, PatternError, translate } from './pcrePattern';
import { ExitSignal, PhpThrow, rt } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import { copyValueSlot, deref, PhpArray, PhpObject, type Ref, type Value } from './values';

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
// These constants describe the linked PCRE2 build of the PHP CLI used to record the parity fixtures.
const REFERENCE_PCRE = { version: '10.49 2026-09-28', jitSupport: true };
const [major, minor] = REFERENCE_PCRE.version.split(/[. ]/, 2).map(BigInt);
defineConstant('PCRE_VERSION', REFERENCE_PCRE.version);
defineConstant('PCRE_VERSION_MAJOR', major);
defineConstant('PCRE_VERSION_MINOR', minor);
defineConstant('PCRE_JIT_SUPPORT', REFERENCE_PCRE.jitSupport);

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
      if (!(error instanceof PatternError)) throw error;
      compiled = error.message;
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

interface MatchOffsets {
  range: [number, number];
  groups?: Record<string, [number, number] | undefined>;
}

interface PreparedSubject {
  text: string;
  position: number;
  byteOffset(index: number): number;
}

type ProjectMatch<T> = (
  compiled: Compiled,
  result: MatchOffsets,
  text: string,
  bounds: [number, number],
  byteOffset: (index: number) => number
) => T;

function matchesOf(compiled: Compiled, subject: string, offset = 0, status?: { error: number }): Generator<Match> {
  return scanMatches(compiled, subject, offset, toMatch, status);
}

/**
 * The matches of a compiled pattern in a subject, from byte `offset` on (counted from the end if negative), as PCRE
 * finds them: after an empty match, PCRE looks for a non-empty one at the same place before moving on. Sets the PCRE
 * error and yields nothing for a bad subject or offset.
 */
function* scanMatches<T>(
  compiled: Compiled,
  subject: string,
  offset: number,
  project: ProjectMatch<T>,
  status?: { error: number }
): Generator<T> {
  const prepared = prepareSubject(compiled, subject, offset);
  if (!prepared) {
    if (status) status.error = rt().lastPregError;
    return;
  }
  const { text, byteOffset } = prepared;
  let position = prepared.position;
  let retry = false;
  while (position <= text.length) {
    rt().spend();
    const result = executeMatch(retry ? compiled.retry : compiled.regex, text, position);
    if (result) {
      const bounds = matchBounds(compiled, result);
      yield project(compiled, result, text, bounds, byteOffset);
      position = bounds[1];
      retry = bounds[0] === bounds[1];
    } else if (retry && position < text.length) {
      retry = false;
      position += compiled.utf8 && (text.codePointAt(position) ?? 0) > 0xff_ff ? 2 : 1;
    } else return;
  }
}

function executeMatch(regex: RegExp, text: string, position: number): MatchOffsets | undefined {
  const budget = rt().budget;
  regex.lastIndex = position;
  try {
    const indices = regex.exec(text)?.indices;
    budget.checkClock();
    return indices?.[0] ? { range: indices[0], groups: indices.groups } : undefined;
  } catch (error) {
    // The host reports a pattern or subject past its own limits this way.
    if (error instanceof SyntaxError || error instanceof RangeError)
      throw new UnsupportedFeatureError('ホストエンジンの制限を超える正規表現');
    throw error;
  }
}

/**
 * The text to match a subject as and where to start, from byte `offset` (counted from the end if negative), or
 * undefined after setting the PCRE error for a bad subject or offset.
 */
function prepareSubject(compiled: Compiled, subject: string, offset: number): PreparedSubject | undefined {
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
function matchBounds(compiled: Compiled, result: MatchOffsets): [number, number] {
  let [start, end] = result.range;
  for (const name of compiled.keeps) {
    const keep = result.groups?.[name];
    if (keep) start = Math.max(start, keep[0]);
  }
  return [start, end];
}

function toMatch(
  compiled: Compiled,
  result: MatchOffsets,
  input: string,
  bounds: [number, number],
  byteOffset: (index: number) => number
): Match {
  const pairs = [bounds];
  for (let group = 1; group <= compiled.groupCount; group++) {
    pairs.push(result.groups?.[groupName(group)] ?? [-1, -1]);
  }
  const text = (start: number, end: number): string | undefined => {
    if (start === -1) return undefined;
    const value = input.slice(start, end);
    return compiled.utf8 ? enc(value) : value;
  };
  return {
    starts: pairs.map(([start]) => (start === -1 ? -1 : byteOffset(start))),
    ends: pairs.map(([, end]) => (end === -1 ? -1 : byteOffset(end))),
    texts: pairs.map(([start, end]) => text(start, end)),
  };
}

// code-gauge-allow functionCognitiveComplexity 19 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function byteIndexer(text: string): (index: number) => number {
  let offsets: Uint32Array | undefined;
  let cursor = 0;
  let bytes = 0;
  return (position) => {
    if (position === 0) return 0;
    offsets ??= new Uint32Array(text.length + 1);
    if (position > cursor) rt().spend(Math.ceil((position - cursor) / 64));
    while (cursor < position) {
      const point = text.codePointAt(cursor) as number;
      if (point >= 0x1_00_00) {
        offsets[++cursor] = bytes + 3;
        bytes += 4;
      } else bytes += point < 0x80 ? 1 : point < 0x8_00 ? 2 : 3;
      offsets[++cursor] = bytes;
    }
    return offsets[position];
  };
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
    if (refs[2]) refs[2].v = new PhpArray();
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
    const resultRef = args[2] === undefined ? undefined : refs[2];
    if (refs[2]) refs[2].v = new PhpArray();
    let flags = (args[3] as bigint | undefined) ?? 0n;
    if ((flags & 0xffn) > 2n) {
      throwError('ValueError', 'preg_match_all(): Argument #4 ($flags) must be a PREG_* constant');
    }
    rt().lastPregError = 0;
    if ((flags & 3n) === 0n) flags |= 1n;
    const subject = args[1] as string;
    const offset = Number((args[4] as bigint | undefined) ?? 0n);
    const count = resultRef
      ? collectMatches(compiled, matchesOf(compiled, subject, offset), resultRef, flags)
      : countMatches(scanMatches(compiled, subject, offset, () => {}));
    return rt().lastPregError === 0 ? BigInt(count) : false;
  }
);

function countMatches(matches: Iterator<unknown>): number {
  let count = 0;
  while (!matches.next().done) count++;
  return count;
}

function collectMatches(compiled: Compiled, matches: Generator<Match>, output: Ref, flags: bigint): number {
  const result = output.v as PhpArray;
  const offsetCapture = (flags & 256n) !== 0n;
  const unmatchedAsNull = (flags & 512n) !== 0n;
  if ((flags & 2n) === 0n) return collectMatchColumns(compiled, matches, result, offsetCapture, unmatchedAsNull);
  let count = 0;
  for (const match of matches) {
    result.append(matchArray(compiled, match, offsetCapture, unmatchedAsNull, true));
    count++;
  }
  return count;
}

function collectMatchColumns(
  compiled: Compiled,
  matches: Generator<Match>,
  result: PhpArray,
  offsetCapture: boolean,
  unmatchedAsNull: boolean
): number {
  const columns = Array.from({ length: compiled.groupCount + 1 }, () => new PhpArray());
  let count = 0;
  for (const match of matches) {
    count++;
    for (const [group, column] of columns.entries()) {
      const value: Value = match.texts[group] ?? (unmatchedAsNull ? null : '');
      column.append(offsetCapture ? PhpArray.list([value, BigInt(match.starts[group])]) : value);
    }
  }
  // An offset past the end fails before PHP fills in the empty groups.
  if (rt().lastPregError === 1) return count;
  for (const [group, column] of columns.entries()) {
    const name = compiled.names[group];
    if (name !== undefined) result.set(name, column);
    result.set(BigInt(group), name === undefined ? column : column.copy());
  }
  return count;
}

/** Expands `$1`, `\1`, and `${1}` in a replacement, where a backslash before `\` or `$` makes it literal. */
function expandReplacement(replacement: string, match: Match): string {
  return replacement.replaceAll(
    /\\([\\$])|\\(\d{1,2})|\$(\d{1,2})|\$\{(\d{1,2})\}/g,
    (_token, escaped?: string, a?: string, b?: string, c?: string) => escaped ?? match.texts[Number(a ?? b ?? c)] ?? ''
  );
}

type MatchReplacement = (compiled: Compiled, match: Match) => string | undefined;

interface ReplacementState {
  value: number;
  callbackFailed: boolean;
  capture: (error: CleanupException) => void;
}

function replaceOne(
  name: string,
  pattern: string,
  subject: string,
  limit: number,
  count: { value: number },
  replace: MatchReplacement
): string | undefined {
  const compiled = compile(name, pattern);
  if (!compiled) return undefined;
  if (limit === 0) return subject;
  const status = { error: 0 };
  const matches = matchesOf(compiled, subject, 0, status);
  let result = '';
  let last = 0;
  for (let done = 0; limit < 0 || done < limit; done++) {
    const next = matches.next();
    if (next.done) break;
    const match = next.value;
    count.value++;
    const replacement = replace(compiled, match);
    if (replacement === undefined) return undefined;
    rt().ensureStringFits(result.length + match.starts[0] - last + replacement.length);
    result += subject.slice(last, match.starts[0]) + replacement;
    last = match.ends[0];
  }
  if (status.error !== 0) return undefined;
  rt().ensureStringFits(result.length + subject.length - last);
  return result + subject.slice(last);
}

// code-gauge-allow functionNcss 32 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionCognitiveComplexity 26 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function pregReplace(
  name: string,
  args: Value[],
  countRef: Ref | undefined,
  replacement: (index: number, state: ReplacementState) => MatchReplacement,
  filter = false
): Value {
  const runtime = rt();
  runtime.lastPregError = 0;
  const [pattern, , subject, limitValue] = args;
  const limit = limitValue === undefined ? -1 : Number(limitValue);
  const patterns: (Value | Ref)[] = pattern instanceof PhpArray ? [...pattern.map.values()] : [pattern];
  let result: Value = null;
  withCleanupExceptions(runtime, (capture) => {
    const state: ReplacementState = { value: 0, callbackFailed: false, capture };
    const canConvert = (value: Value): boolean =>
      !state.callbackFailed || !(value instanceof PhpObject) || value.isResource;
    try {
      result = mapSubjects(
        subject,
        (text) => {
          const before = state.value;
          let current = text;
          for (const [index, entry] of patterns.entries()) {
            const value = deref(entry);
            if (!canConvert(value)) break;
            const patternText = toStr(value);
            const replaced = replaceOne(name, patternText, current, limit, state, replacement(index, state));
            if (replaced === undefined) return;
            current = replaced;
          }
          return filter && state.value === before ? undefined : current;
        },
        canConvert
      );
    } catch (error) {
      if (!(error instanceof PhpThrow || error instanceof ExitSignal)) throw error;
      capture(error);
    }
    if (countRef) {
      const previous = countRef.v;
      countRef.assign(BigInt(state.value));
      runtime.release([previous]);
    }
  });
  return result;
}

function mapSubjects(
  subject: Value,
  replace: (subject: string) => string | undefined,
  canConvert: (value: Value) => boolean = () => true
): Value {
  if (!(subject instanceof PhpArray)) return replace(toStr(subject)) ?? null;
  const array = new PhpArray();
  for (const [key, slot] of subject.map) {
    const value = deref(slot);
    if (!canConvert(value)) break;
    const replaced = replace(toStr(value));
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
      const slots = replacement instanceof PhpArray ? [...replacement.map.values()] : undefined;
      return pregReplace(
        name,
        args,
        refs[4],
        (index) => {
          const value = slots ? toStr(deref(slots[index] ?? '')) : toStr(replacement);
          return (_compiled, match) => expandReplacement(value, match);
        },
        filter
      );
    }
  );
}

defineFunction(
  'preg_replace_callback(string|array $pattern, callable $callback, string|array $subject, int $limit = -1, &$count = null, int $flags = 0): string|array|null',
  ({ args, refs }) => {
    const flags = (args[5] as bigint | undefined) ?? 0n;
    return pregReplace('preg_replace_callback', args, refs[4], (_index, state) => (compiled, match) => {
      if (state.callbackFailed) return;
      return callbackReplacement(args[1], compiled, match, flags, (error) => {
        state.callbackFailed = true;
        state.capture(error);
      });
    });
  }
);

function callbackReplacement(
  callback: Value,
  compiled: Compiled,
  match: Match,
  flags: bigint,
  retain?: (error: CleanupException) => void
): string | undefined {
  const args = matchArray(compiled, match, (flags & 256n) !== 0n, (flags & 512n) !== 0n, true);
  let converted: string | undefined;
  try {
    return consumeInvokedResult(
      () => callCallback(callback, [args]),
      (value) => {
        converted = toStr(value);
        return converted;
      },
      { releaseOnExit: true }
    );
  } catch (error) {
    if (!retain || !(error instanceof PhpThrow || error instanceof ExitSignal)) throw error;
    retain(error);
    return converted;
  }
}

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
        replaceOne('preg_replace_callback_array', pattern, text, limit, count, (compiled, match) =>
          callbackReplacement(callback, compiled, match, flags)
        )
      );
      if (subject === null) return null;
    }
    if (refs[3]) refs[3].v = BigInt(count.value);
    return subject;
  }
);
defineFunction(
  'preg_split(string $pattern, string $subject, int $limit = -1, int $flags = 0): array|false',
  // code-gauge-allow functionCognitiveComplexity 29 -- Keeps the match iterator, capture offsets and split flags on the same state.
  // code-gauge-allow functionNcss 39 -- Keeps the match iterator, capture offsets and split flags on the same state.
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
    const matches = matchesOf(compiled, subject);
    while (limit === -1 || limit > 1) {
      const next = matches.next();
      if (next.done) break;
      const match = next.value;
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
  rt().lastPregError = 0;
  const invert = (((args[2] as bigint | undefined) ?? 0n) & 1n) !== 0n;
  const result = new PhpArray();
  for (const [key, value] of (args[1] as PhpArray).entries()) {
    const status = { error: 0 };
    const matched = !matchesOf(compiled, toStr(value), 0, status).next().done;
    if (status.error !== 0) break;
    if (matched !== invert) result.setSlot(key, copyValueSlot((args[1] as PhpArray).map.get(key) as Value | Ref));
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
