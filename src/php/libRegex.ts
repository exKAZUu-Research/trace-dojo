// code-gauge-allow-file fileNcss 526 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { dec, enc } from './bytes';
import { callCallback } from './callables';
import { throwError, warn } from './errors';
import { defineConstant, defineFunction } from './native';
import { toStr } from './operators';
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

/** A compiled pattern: the JavaScript regex and whether it matches UTF-8 text by characters (`u`). */
interface Compiled {
  regex: RegExp;
  utf8: boolean;
  names: (string | undefined)[];
  groupCount: number;
}

const cache = new Map<string, Compiled | string>();

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
    cache.set(pattern, compiled);
  }
  if (typeof compiled === 'string') {
    warn(`${name}(): ${compiled}`);
    rt().lastPregError = 1;
    return undefined;
  }
  return compiled;
}

class PatternError extends Error {}

const BRACKETS: Record<string, string> = { '(': ')', '{': '}', '[': ']', '<': '>' };

function translate(pattern: string): Compiled {
  const trimmed = pattern.replace(/^[ \t\n\r\v\f]+/, '');
  if (trimmed === '') throw new PatternError('Empty regular expression');
  const delimiter = trimmed[0];
  if (/[\dA-Za-z\\]/.test(delimiter)) throw new PatternError('Delimiter must not be alphanumeric, backslash, or NUL');
  const closing = BRACKETS[delimiter] ?? delimiter;
  let end = -1;
  let depth = 0;
  for (let index = 1; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (closing !== delimiter && char === delimiter) depth++;
    else if (char === closing) {
      if (depth === 0) {
        end = index;
        break;
      }
      depth--;
    }
  }
  if (end === -1) {
    throw new PatternError(
      closing === delimiter
        ? `No ending delimiter '${delimiter}' found`
        : `No ending matching delimiter '${closing}' found`
    );
  }
  const body = trimmed.slice(1, end);
  const modifiers = trimmed.slice(end + 1);
  let flags = 'g';
  let extended = false;
  let ungreedy = false;
  let dollarEndOnly = false;
  let anchored = false;
  let utf8 = false;
  for (const modifier of modifiers) {
    switch (modifier) {
      case 'i':
      case 'm':
      case 's': {
        if (!flags.includes(modifier)) flags += modifier;
        break;
      }
      case 'x': {
        extended = true;
        break;
      }
      case 'u': {
        utf8 = true;
        break;
      }
      case 'U': {
        ungreedy = true;
        break;
      }
      case 'D': {
        dollarEndOnly = true;
        break;
      }
      case 'A': {
        anchored = true;
        break;
      }
      case 'S':
      case 'X':
      case 'J':
      case '\n':
      case '\r':
      case ' ': {
        break;
      }
      default: {
        throw new PatternError(`Unknown modifier '${modifier}'`);
      }
    }
  }
  if (utf8) flags += 'u';
  let source = utf8 ? dec(body) : body;
  const leadingFlags = /^\(\?([imsxU]+)\)/.exec(source);
  if (leadingFlags) {
    for (const flag of leadingFlags[1]) {
      if (flag === 'x') extended = true;
      else if (flag === 'U') ungreedy = true;
      else if (!flags.includes(flag)) flags += flag;
    }
    source = source.slice(leadingFlags[0].length);
  }
  const names: (string | undefined)[] = [undefined];
  const converted = convertSyntax(source, { extended, ungreedy, dollarEndOnly, multiline: flags.includes('m'), names });
  const regex = new RegExp(anchored ? `^(?:${converted})` : converted, flags.includes('y') ? flags : flags);
  return { regex, utf8, names, groupCount: names.length - 1 };
}

interface SyntaxOptions {
  extended: boolean;
  ungreedy: boolean;
  dollarEndOnly: boolean;
  multiline: boolean;
  names: (string | undefined)[];
}

const POSIX_CLASSES: Record<string, string> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: 'A-Za-z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: String.raw` \t\n\r\v\f`,
  blank: String.raw` \t`,
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f',
  word: String.raw`\w`,
  cntrl: String.raw`\x00-\x1f\x7f`,
  print: ' -~',
  graph: '!-~',
};

function unsupported(what: string): never {
  throw new UnsupportedFeatureError(`正規表現の${what}`);
}

/** Rewrites PCRE syntax that JavaScript spells differently, rejecting what JavaScript cannot express. */
function convertSyntax(source: string, options: SyntaxOptions): string {
  let result = '';
  let index = 0;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      const next = source[index + 1] ?? '';
      index += 2;
      if (inClass) {
        result += next === 'h' ? String.raw` \t` : `\\${next}`;
        continue;
      }
      switch (next) {
        case 'A': {
          result += String.raw`(?<![\s\S])`;
          break;
        }
        case 'z': {
          result += String.raw`(?![\s\S])`;
          break;
        }
        case 'Z': {
          result += String.raw`(?=\n?(?![\s\S]))`;
          break;
        }
        case 'h': {
          result += String.raw`[ \t]`;
          break;
        }
        case 'R': {
          result += String.raw`(?:\r\n|\n|\r)`;
          break;
        }
        case 'G':
        case 'K': {
          unsupported(`\\${next}`);
          break;
        }
        case 'g': {
          const reference = /^\{?(-?\d+|\w+)\}?/.exec(source.slice(index));
          if (!reference) unsupported(String.raw`\g`);
          index += (reference as RegExpExecArray)[0].length;
          const target = (reference as RegExpExecArray)[1];
          result += /^\d+$/.test(target) ? `\\${target}` : `\\k<${target}>`;
          break;
        }
        default: {
          result += `\\${next}`;
        }
      }
      continue;
    }
    if (inClass) {
      if (char === '[' && source[index + 1] === ':') {
        const match = /^\[:(\^?)(\w+):\]/.exec(source.slice(index));
        if (match && POSIX_CLASSES[match[2]] !== undefined) {
          if (match[1]) unsupported('否定の POSIX 文字クラス');
          result += POSIX_CLASSES[match[2]];
          index += match[0].length;
          continue;
        }
      }
      if (char === ']') inClass = false;
      result += char === '[' ? String.raw`\[` : char;
      index++;
      continue;
    }
    if (options.extended) {
      if (/\s/.test(char)) {
        index++;
        continue;
      }
      if (char === '#') {
        while (index < source.length && source[index] !== '\n') index++;
        continue;
      }
    }
    switch (char) {
      case '[': {
        inClass = true;
        result += '[';
        index++;
        if (source[index] === '^') {
          result += '^';
          index++;
        }
        if (source[index] === ']') {
          result += String.raw`\]`;
          index++;
        }
        continue;
      }
      case '$': {
        result += options.multiline
          ? '$'
          : options.dollarEndOnly
            ? String.raw`(?![\s\S])`
            : String.raw`(?=\n?(?![\s\S]))`;
        index++;
        continue;
      }
      case '(': {
        if (source[index + 1] === '?') {
          const rest = source.slice(index + 2);
          const named = /^(?:P?<([A-Za-z_]\w*)>|'([A-Za-z_]\w*)')/.exec(rest);
          if (named) {
            options.names.push(named[1] ?? named[2]);
            result += `(?<${named[1] ?? named[2]}>`;
            index += 2 + named[0].length;
            continue;
          }
          const backReference = /^P=(\w+)\)/.exec(rest);
          if (backReference) {
            result += `\\k<${backReference[1]}>`;
            index += 2 + backReference[0].length;
            continue;
          }
          if (/^[:=!]|^<[=!]/.test(rest)) {
            const length = rest.startsWith('<') ? 3 : 2;
            result += source.slice(index, index + 1 + length);
            index += 1 + length;
            continue;
          }
          if (rest.startsWith('#')) {
            const close = source.indexOf(')', index);
            index = close === -1 ? source.length : close + 1;
            continue;
          }
          if (rest.startsWith('>')) unsupported('アトミックグループ');
          if (/^[R\d+-]/.test(rest) || rest.startsWith('&') || rest.startsWith('P>')) unsupported('再帰');
          if (rest.startsWith('(')) unsupported('条件分岐');
          if (rest.startsWith('|')) unsupported('グループ番号のリセット');
          unsupported('途中のフラグの指定');
        }
        options.names.push(undefined);
        result += '(';
        index++;
        continue;
      }
      case '{': {
        const quantifier = /^\{\d+(,\d*)?\}/.exec(source.slice(index));
        if (!quantifier) {
          result += String.raw`\{`;
          index++;
          continue;
        }
        result += quantifier[0];
        index += quantifier[0].length;
        index = quantifierSuffix(source, index, options, (text) => (result += text), unsupported);
        continue;
      }
      case '}': {
        result += String.raw`\}`;
        index++;
        continue;
      }
      case '*':
      case '+':
      case '?': {
        result += char;
        index = quantifierSuffix(source, index + 1, options, (text) => (result += text), unsupported);
        continue;
      }
      default: {
        result += char;
        index++;
      }
    }
  }
  return result;
}

/** Handles the lazy (`?`) and possessive (`+`) suffixes after a quantifier, returning the index after them. */
function quantifierSuffix(
  source: string,
  index: number,
  options: SyntaxOptions,
  emit: (text: string) => void,
  unsupported: (what: string) => never
): number {
  if (source[index] === '+') unsupported('強欲な量指定子');
  const lazy = source[index] === '?';
  if (lazy !== options.ungreedy) emit('?');
  return lazy ? index + 1 : index;
}

// Matching -------------------------------------------------------------------------------------------------------------

interface Match {
  /** Byte offsets of the start and end of the whole match and each group, -1 for a group that did not take part. */
  starts: number[];
  ends: number[];
  texts: (string | undefined)[];
}

/** The matches of a compiled pattern in a subject, from `offset` on, as PCRE finds them. */
function* matchesOf(compiled: Compiled, subject: string, offset = 0): Generator<Match> {
  const text = compiled.utf8 ? dec(subject) : subject;
  if (compiled.utf8 && enc(text) !== subject) {
    rt().lastPregError = 4;
    return;
  }
  const byteOffset = compiled.utf8 ? byteIndexer(text) : (index: number): number => index;
  let position = compiled.utf8 ? charIndexOf(text, offset) : offset;
  const { regex } = compiled;
  while (position <= text.length) {
    rt().spend();
    regex.lastIndex = position;
    const result = regex.exec(text);
    if (!result) return;
    const starts: number[] = [];
    const ends: number[] = [];
    const texts: (string | undefined)[] = [];
    const indices = groupIndices(result);
    for (const [start, end] of indices) {
      starts.push(start === -1 ? -1 : byteOffset(start));
      ends.push(end === -1 ? -1 : byteOffset(end));
    }
    for (const value of result) texts.push(value === undefined ? undefined : compiled.utf8 ? enc(value) : value);
    yield { starts, ends, texts };
    const matchEnd = result.index + result[0].length;
    position =
      result[0].length === 0
        ? matchEnd + (compiled.utf8 && (text.codePointAt(matchEnd) ?? 0) > 0xff_ff ? 2 : 1)
        : matchEnd;
  }
}

/** The start and end of the whole match and each group, found by matching each group's text where it can be. */
function groupIndices(result: RegExpExecArray): [number, number][] {
  const withIndices = result as RegExpExecArray & { indices?: [number, number][] };
  if (withIndices.indices) return withIndices.indices.map((pair) => pair ?? [-1, -1]);
  const start = result.index;
  const pairs: [number, number][] = [[start, start + result[0].length]];
  let cursor = start;
  for (const group of result.slice(1)) {
    if (group === undefined) {
      pairs.push([-1, -1]);
      continue;
    }
    const at = result.input.indexOf(group, cursor);
    const position = at === -1 ? start : at;
    pairs.push([position, position + group.length]);
  }
  return pairs;
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

function withIndices(compiled: Compiled): Compiled {
  if (compiled.regex.flags.includes('d')) return compiled;
  return { ...compiled, regex: new RegExp(compiled.regex.source, `${compiled.regex.flags}d`) };
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
    rt().lastPregError = 0;
    const flags = (args[3] as bigint | undefined) ?? 0n;
    const offset = Number((args[4] as bigint | undefined) ?? 0n);
    const subject = args[1] as string;
    const start = offset < 0 ? Math.max(subject.length + offset, 0) : offset;
    const first = matchesOf(withIndices(compiled), subject, start).next();
    if (refs[2]) {
      refs[2].v = first.done
        ? new PhpArray()
        : matchArray(compiled, first.value, (flags & 256n) !== 0n, (flags & 512n) !== 0n, true);
    }
    if (rt().lastPregError === 4) {
      if (refs[2]) refs[2].v = new PhpArray();
      return false;
    }
    return first.done ? 0n : 1n;
  }
);
defineFunction(
  'preg_match_all(string $pattern, string $subject, &$matches = null, int $flags = 0, int $offset = 0): int|false',
  ({ args, refs }) => {
    const compiled = compile('preg_match_all', args[0] as string);
    if (!compiled) return false;
    rt().lastPregError = 0;
    let flags = (args[3] as bigint | undefined) ?? 0n;
    if ((flags & 3n) === 0n) flags |= 1n;
    const offsetCapture = (flags & 256n) !== 0n;
    const unmatchedAsNull = (flags & 512n) !== 0n;
    const matches = [
      ...matchesOf(withIndices(compiled), args[1] as string, Number((args[4] as bigint | undefined) ?? 0n)),
    ];
    if (refs[2]) {
      const result = new PhpArray();
      if ((flags & 2n) !== 0n) {
        for (const match of matches) result.append(matchArray(compiled, match, offsetCapture, unmatchedAsNull, true));
      } else {
        for (let group = 0; group <= compiled.groupCount; group++) {
          const column = new PhpArray();
          for (const match of matches) {
            const text = match.texts[group];
            const value: Value = text ?? (unmatchedAsNull ? null : '');
            column.append(offsetCapture ? PhpArray.list([value, BigInt(match.starts[group])]) : value);
          }
          const name = compiled.names[group];
          if (name !== undefined) result.set(name, column);
          result.set(BigInt(group), name !== undefined ? column.copy() : column);
        }
      }
      refs[2].v = result;
    }
    return BigInt(matches.length);
  }
);

/** Expands `$1`, `\1`, and `${1}` in a replacement. */
function expandReplacement(replacement: string, match: Match): string {
  return replacement.replaceAll(
    /\\\\|\\(\d{1,2})|\$(\d{1,2})|\$\{(\d{1,2})\}/g,
    (token, a?: string, b?: string, c?: string) => {
      if (token === String.raw`\\`) return '\\';
      const group = Number(a ?? b ?? c);
      return match.texts[group] ?? '';
    }
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
  if (!compiled) return undefined;
  let result = '';
  let last = 0;
  let done = 0;
  for (const match of matchesOf(withIndices(compiled), subject)) {
    if (limit >= 0 && done >= limit) break;
    result += subject.slice(last, match.starts[0]) + replace(match);
    last = match.ends[0];
    done++;
    if (result.length > 1_000_000) throwError('Error', 'Allowed memory size exhausted');
  }
  count.value += done;
  return result + subject.slice(last);
}

function pregReplace(
  name: string,
  args: Value[],
  refs: (Ref | undefined)[],
  replacer: (pattern: number) => (match: Match) => string
): Value {
  rt().lastPregError = 0;
  const [patternValue, , subjectValue, limitValue] = args;
  const limit = limitValue === undefined ? -1 : Number(limitValue);
  const patterns =
    patternValue instanceof PhpArray ? patternValue.values().map((item) => toStr(item)) : [toStr(patternValue)];
  const count = { value: 0 };
  const replaceSubject = (subject: string): string | undefined => {
    let current: string | undefined = subject;
    for (const [index, pattern] of patterns.entries()) {
      current = replaceOne(name, pattern, current, limit, count, replacer(index));
      if (current === undefined) return undefined;
    }
    return current;
  };
  let result: Value;
  if (subjectValue instanceof PhpArray) {
    const array = new PhpArray();
    for (const [key, item] of subjectValue.entries()) {
      const replaced = replaceSubject(toStr(item));
      if (replaced !== undefined) array.set(key, replaced);
    }
    result = array;
  } else result = replaceSubject(toStr(subjectValue)) ?? null;
  if (refs[4]) refs[4].v = BigInt(count.value);
  return result;
}

defineFunction(
  'preg_replace(string|array $pattern, string|array $replacement, string|array $subject, int $limit = -1, &$count = null): string|array|null',
  ({ args, refs }) => {
    const replacement = args[1];
    if (replacement instanceof PhpArray && !(args[0] instanceof PhpArray)) {
      throwError(
        'TypeError',
        'preg_replace(): Argument #1 ($pattern) must be of type array when argument #2 ($replacement) is an array, string given'
      );
    }
    const replacements = replacement instanceof PhpArray ? replacement.values().map((item) => toStr(item)) : undefined;
    return pregReplace(
      'preg_replace',
      args,
      refs,
      (index) => (match) => expandReplacement(replacements ? (replacements[index] ?? '') : toStr(replacement), match)
    );
  }
);
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
  'preg_split(string $pattern, string $subject, int $limit = -1, int $flags = 0): array|false',
  // code-gauge-allow functionCognitiveComplexity 29 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
  // code-gauge-allow functionNcss 33 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
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
    for (const match of matchesOf(withIndices(compiled), subject)) {
      if (limit !== -1 && limit <= 1) break;
      if (!noEmpty || match.starts[0] !== last) {
        add(subject.slice(last, match.starts[0]), last);
        if (limit !== -1) limit--;
      }
      if (delimCapture) {
        for (let group = 1; group < match.texts.length; group++) {
          const text = match.texts[group];
          if (text !== undefined && !(noEmpty && text === '')) add(text, match.starts[group]);
        }
      }
      last = match.ends[0];
    }
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
