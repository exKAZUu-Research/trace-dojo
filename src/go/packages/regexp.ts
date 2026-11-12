import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { utf8Decode, utf8Encode } from '../literals';
import { addMethod, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { GoPanic } from '../runtime';
import { BASIC, ERROR_TYPE, pointerTo, sliceOf, type Type } from '../types';
import { Cell, GoStruct, Iface, Pointer, type Value } from '../values';
import { BOOL, byteSlice, bytesOf, callFunction, INT, sliceOfValues, STRING } from './support';

/**
 * Regular expressions of Go's RE2 syntax, which this environment translates to JavaScript's: both match leftmost-first
 * as Perl does, and the translation keeps Go's meanings of the escapes and classes that differ (`\s`, `\z`, POSIX
 * classes, scripts). The syntax RE2 rejects, such as backreferences and lookarounds, fails to compile with Go's
 * messages; the few forms JavaScript lacks (`(?U)`, flags in the middle of a pattern) are reported as unavailable.
 */
class SyntaxFailure {
  constructor(
    readonly code: string,
    readonly expression: string
  ) {}
}

class Unavailable {
  constructor(readonly what: string) {}
}

const POSIX_CLASSES: Record<string, string> = {
  alnum: '0-9A-Za-z',
  alpha: 'A-Za-z',
  ascii: String.raw`\x00-\x7F`,
  blank: String.raw`\t `,
  cntrl: String.raw`\x00-\x1F\x7F`,
  digit: '0-9',
  graph: '!-~',
  lower: 'a-z',
  print: ' -~',
  punct: '!-/:-@[-`{-~',
  space: String.raw`\t\n\v\f\r `,
  upper: 'A-Z',
  word: '0-9A-Za-z_',
  xdigit: '0-9A-Fa-f',
};

const PERL_CLASSES: Record<string, string> = {
  d: '0-9',
  s: String.raw`\t\n\f\r `,
  w: '0-9A-Za-z_',
};

const GENERAL_CATEGORIES = new Set([
  'C',
  'Cc',
  'Cf',
  'Co',
  'Cs',
  'L',
  'Ll',
  'Lm',
  'Lo',
  'Lt',
  'Lu',
  'M',
  'Mc',
  'Me',
  'Mn',
  'N',
  'Nd',
  'Nl',
  'No',
  'P',
  'Pc',
  'Pd',
  'Pe',
  'Pf',
  'Pi',
  'Po',
  'Ps',
  'S',
  'Sc',
  'Sk',
  'Sm',
  'So',
  'Z',
  'Zl',
  'Zp',
  'Zs',
]);

interface Translation {
  source: string;
  flags: string;
  names: string[];
}

/** Translates a Go regular expression, as a JavaScript string of its runes, to JavaScript's syntax. */
// code-gauge-allow functionCognitiveComplexity 80 -- A parser of Go's regular expression syntax, one case per form.
function translate(pattern: string): Translation {
  let flags = 'u';
  let index = 0;
  const leading = /^\(\?([imsU]+)\)/.exec(pattern);
  if (leading) {
    if (leading[1].includes('U')) throw new Unavailable('正規表現の (?U)（最短一致を既定にする書き方）');
    for (const flag of leading[1]) if (!flags.includes(flag)) flags += flag;
    index = leading[0].length;
  }
  const multiline = flags.includes('m');
  const names: string[] = [''];
  let out = '';
  let depth = 0;
  const groupStarts: number[] = [];
  /** Whether the last item can take a repetition operator, as RE2 decides for `**` and a leading `*`. */
  let repeatable = false;
  let lastWasRepeat = false;
  const fail = (code: string, from: number, to = pattern.length): never => {
    throw new SyntaxFailure(code, pattern.slice(from, to));
  };
  while (index < pattern.length) {
    const char = pattern[index];
    const start = index;
    if (char === '\\') {
      const [text, length] = translateEscape(pattern, index, multiline, false);
      out += text;
      index += length;
      repeatable = ![String.raw`\b`, String.raw`\B`, '^', '$'].includes(text) && !text.startsWith('(?');
      lastWasRepeat = false;
      continue;
    }
    if (char === '[') {
      const [text, length] = translateClass(pattern, index);
      out += text;
      index += length;
      repeatable = true;
      lastWasRepeat = false;
      continue;
    }
    if (char === '(') {
      if (pattern.startsWith('(?', index)) {
        const named = /^\(\?P?<([A-Za-z_]\w*)>/.exec(pattern.slice(index));
        if (named) {
          if (names.includes(named[1])) fail('duplicate capture group name', index, index + named[0].length);
          names.push(named[1]);
          out += `(?<${named[1]}>`;
          index += named[0].length;
        } else if (pattern.startsWith('(?:', index)) {
          out += '(?:';
          index += 3;
        } else if (/^\(\?[imsU-]+[:)]/.test(pattern.slice(index))) {
          throw new Unavailable('正規表現の途中でのフラグ（(?i) など）');
        } else {
          const end = pattern.indexOf(')', index);
          fail('invalid or unsupported Perl syntax', index, Math.min(index + 3, end === -1 ? pattern.length : end + 1));
        }
      } else {
        names.push('');
        out += '(';
        index++;
      }
      depth++;
      groupStarts.push(start);
      repeatable = false;
      lastWasRepeat = false;
      continue;
    }
    if (char === ')') {
      if (depth === 0) fail('unexpected )', 0);
      depth--;
      groupStarts.pop();
      out += ')';
      index++;
      repeatable = true;
      lastWasRepeat = false;
      continue;
    }
    if (char === '*' || char === '+' || char === '?' || char === '{') {
      let operator = char;
      if (char === '{') {
        const repeat = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index));
        if (!repeat) {
          // A brace that does not start a repetition is a literal, as in Go.
          out += String.raw`\{`;
          index++;
          repeatable = true;
          lastWasRepeat = false;
          continue;
        }
        const min = Number(repeat[1]);
        const max = repeat[3] === undefined ? (repeat[2] ? -1 : min) : Number(repeat[3]);
        if (min > 1000 || max > 1000 || (max >= 0 && max < min))
          fail('invalid repeat count', index, index + repeat[0].length);
        operator = repeat[0];
      }
      const end = index + operator.length + (pattern[index + operator.length] === '?' ? 1 : 0);
      if (lastWasRepeat) fail('invalid nested repetition operator', index - 1, end);
      if (!repeatable) fail('missing argument to repetition operator', index, end);
      out += pattern.slice(index, end);
      index = end;
      lastWasRepeat = true;
      continue;
    }
    if (char === '^') {
      out += multiline ? String.raw`(?<![^\n])` : String.raw`(?<![\s\S])`;
      repeatable = false;
    } else if (char === '$') {
      out += multiline ? String.raw`(?=\n|(?![\s\S]))` : String.raw`(?![\s\S])`;
      repeatable = false;
    } else if (char === '.') {
      out += flags.includes('s') ? String.raw`[\s\S]` : String.raw`[^\n]`;
      repeatable = true;
    } else {
      out += /[|]/.test(char) ? char : escapeLiteral(char);
      repeatable = char !== '|';
    }
    lastWasRepeat = false;
    index++;
  }
  if (depth > 0) fail('missing closing )', groupStarts[0]);
  return { source: out, flags: flags.replace('m', '').replace('s', ''), names };
}

function escapeLiteral(char: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char;
}

/** An escape outside a class, or inside one when `inClass`: its translation and its length in the pattern. */
// code-gauge-allow functionCognitiveComplexity 40 -- One case per escape that Go accepts.
function translateEscape(pattern: string, index: number, multiline: boolean, inClass: boolean): [string, number] {
  const next = pattern[index + 1];
  if (next === undefined) throw new SyntaxFailure('trailing backslash at end of expression', '');
  const fail = (length: number): never => {
    throw new SyntaxFailure('invalid escape sequence', pattern.slice(index, index + length));
  };
  if (/[dswDSW]/.test(next)) {
    const ranges = PERL_CLASSES[next.toLowerCase()];
    const negated = next === next.toUpperCase();
    if (inClass) return [negated ? `\\${next}` : ranges, 2];
    return [`[${negated ? '^' : ''}${ranges}]`, 2];
  }
  if (next === 'p' || next === 'P') {
    const braced = /^\\[pP]\{(\^?)([A-Za-z_]+)\}/.exec(pattern.slice(index));
    const name = braced ? braced[2] : pattern[index + 2];
    const length = braced ? braced[0].length : 3;
    if (!name) fail(2);
    const negated = (next === 'P') !== (braced?.[1] === '^');
    const property = name === 'Any' ? 'Any' : GENERAL_CATEGORIES.has(name) ? name : `Script=${name}`;
    try {
      new RegExp(`\\p{${property}}`, 'u');
    } catch {
      throw new SyntaxFailure('invalid character class range', pattern.slice(index, index + length));
    }
    return [`\\${negated ? 'P' : 'p'}{${property}}`, length];
  }
  if (!inClass) {
    if (next === 'A') return [String.raw`(?<![\s\S])`, 2];
    if (next === 'z') return [String.raw`(?![\s\S])`, 2];
    if (next === 'b' || next === 'B') return [`\\${next}`, 2];
  }
  if (next === 'Q') {
    const end = pattern.indexOf(String.raw`\E`, index + 2);
    const literal = pattern.slice(index + 2, end === -1 ? pattern.length : end);
    return [[...literal].map(escapeLiteral).join(''), end === -1 ? pattern.length - index : end + 2 - index];
  }
  if (next === 'x') {
    const braced = /^\\x\{([0-9A-Fa-f]+)\}/.exec(pattern.slice(index));
    if (braced) return [`\\u{${braced[1]}}`, braced[0].length];
    const short = /^\\x([0-9A-Fa-f]{2})/.exec(pattern.slice(index));
    if (!short) fail(Math.min(4, pattern.length - index));
    return [`\\x${(short as RegExpExecArray)[1]}`, 4];
  }
  if (/[0-7]/.test(next)) {
    // Go reads \0 to \7 followed by octal digits as octal, but \1-\9 alone are backreferences, which it rejects.
    if (next === '0' || /^[0-7]{2}/.test(pattern.slice(index + 1))) {
      const octal = /^[0-7]{1,3}/.exec(pattern.slice(index + 1))?.[0] ?? '0';
      return [`\\u{${Number.parseInt(octal, 8).toString(16)}}`, 1 + octal.length];
    }
    fail(2);
  }
  const controls: Record<string, string> = {
    a: String.raw`\x07`,
    f: String.raw`\f`,
    n: String.raw`\n`,
    r: String.raw`\r`,
    t: String.raw`\t`,
    v: String.raw`\v`,
  };
  if (controls[next]) return [controls[next], 2];
  // JavaScript's Unicode mode escapes only its syntax characters, and `-` only inside a class.
  if (/[!-/:-@[-`{-~]/.test(next)) {
    if (/[\\^$.*+?()[\]{}|/]/.test(next) || (inClass && next === '-')) return [`\\${next}`, 2];
    return [next, 2];
  }
  return fail(2);
}

/** A bracketed class: its translation and its length in the pattern. */
// code-gauge-allow functionCognitiveComplexity 30 -- Go's classes with POSIX names, escapes, and ranges.
function translateClass(pattern: string, start: number): [string, number] {
  let index = start + 1;
  let out = '[';
  if (pattern[index] === '^') {
    out += '^';
    index++;
  }
  let first = true;
  let previous: string | undefined;
  while (index < pattern.length && (pattern[index] !== ']' || first)) {
    first = false;
    const posix = /^\[:(\^?)([a-z]+):\]/.exec(pattern.slice(index));
    if (posix) {
      const ranges = POSIX_CLASSES[posix[2]];
      if (!ranges) throw new SyntaxFailure('invalid character class range', posix[0]);
      if (posix[1]) throw new Unavailable('正規表現の否定した POSIX の文字クラス（[[:^alpha:]] など）');
      out += ranges;
      index += posix[0].length;
      previous = undefined;
      continue;
    }
    let item: string;
    let length: number;
    let literal: string | undefined;
    if (pattern[index] === '\\') {
      [item, length] = translateEscape(pattern, index, false, true);
      if (length === 2 && /^\\[!-/:-@[-`{-~]$/.test(item)) literal = item[1];
    } else {
      const char = String.fromCodePoint(pattern.codePointAt(index) as number);
      item = /[\\\]^-]/.test(char) ? `\\${char}` : char === '[' ? String.raw`\[` : char;
      length = char.length;
      literal = char;
    }
    if (pattern[index + length] === '-' && pattern[index + length + 1] !== ']' && literal !== undefined) {
      const endIndex = index + length + 1;
      const endChar = String.fromCodePoint(pattern.codePointAt(endIndex) ?? 0);
      if ((endChar.codePointAt(0) ?? 0) < (literal.codePointAt(0) ?? 0)) {
        throw new SyntaxFailure('invalid character class range', pattern.slice(index, endIndex + endChar.length));
      }
      out += `${item}-${/[\\\]^-]/.test(endChar) ? `\\${endChar}` : endChar}`;
      index = endIndex + endChar.length;
      previous = undefined;
      continue;
    }
    out += item;
    previous = item;
    index += length;
  }
  void previous;
  if (index >= pattern.length) throw new SyntaxFailure('missing closing ]', pattern.slice(start));
  return [`${out}]`, index + 1 - start];
}

// Compiled expressions ------------------------------------------------------------------------------------------------

interface Compiled {
  text: string;
  regex: RegExp;
  names: string[];
}

/** One match: the byte offsets of the whole match and of each group, -1 for a group that did not take part. */
type Match = number[];

function compile(text: string): Compiled {
  const decoded = utf8Decode(text);
  const translation = translate(decoded);
  return {
    text,
    regex: new RegExp(translation.source, `${translation.flags}gd`),
    names: translation.names,
  };
}

function compileError(text: string, error: unknown): Value {
  if (error instanceof SyntaxFailure) {
    return newError(`error parsing regexp: ${error.code}: \`${utf8Encode(error.expression)}\``);
  }
  if (error instanceof Unavailable) throw new GoPanic(newError(`${error.what}は、この採点環境では使えません。`));
  void text;
  throw error;
}

/** The byte offset of each UTF-16 index of a decoded text, so that matches report Go's byte offsets. */
function byteOffsets(text: string): number[] {
  const offsets = Array.from<number>({ length: text.length + 1 });
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    offsets[index] = bytes;
    const code = text.codePointAt(index) as number;
    const units = code > 0xff_ff ? 2 : 1;
    if (units === 2) offsets[index + 1] = bytes;
    bytes += code < 0x80 ? 1 : code < 0x8_00 ? 2 : code < 0x1_00_00 ? 3 : 4;
    index += units;
  }
  offsets[text.length] = bytes;
  return offsets;
}

/**
 * The matches in a byte string, at most `limit` of them (all when negative), as Go's allMatches finds them: after an
 * empty match the search moves on one rune, and an empty match right after the previous match is skipped.
 */
function allMatches(compiled: Compiled, input: string, limit: number): Match[] {
  const text = utf8Decode(input);
  const offsets = byteOffsets(text);
  const { regex } = compiled;
  const matches: Match[] = [];
  let position = 0;
  let previousEnd = -1;
  while ((limit < 0 || matches.length < limit) && position <= text.length) {
    regex.lastIndex = position;
    const found = regex.exec(text);
    if (!found?.indices) break;
    const [start, end] = found.indices[0] as [number, number];
    let accept = true;
    if (end === start && start === previousEnd) accept = false;
    if (accept) {
      matches.push(found.indices.flatMap((pair) => (pair ? [offsets[pair[0]], offsets[pair[1]]] : [-1, -1])));
      previousEnd = end;
    }
    if (end > start) position = end;
    else {
      const code = text.codePointAt(start);
      position = start + (code !== undefined && code > 0xff_ff ? 2 : 1);
    }
  }
  return matches;
}

const firstMatch = (compiled: Compiled, input: string): Match | undefined => allMatches(compiled, input, 1)[0];

/** Go's Regexp.expand: `$1`, `${1}`, `$name`, `${name}`, and `$$`, from the template into the result. */
function expand(compiled: Compiled, template: string, input: string, match: Match): string {
  let result = '';
  let rest = template;
  for (;;) {
    const dollar = rest.indexOf('$');
    if (dollar === -1) break;
    result += rest.slice(0, dollar);
    rest = rest.slice(dollar);
    if (rest.startsWith('$$')) {
      result += '$';
      rest = rest.slice(2);
      continue;
    }
    const reference = /^\$(?:\{(\w+)\}|(\w+))/.exec(rest);
    if (!reference) {
      result += '$';
      rest = rest.slice(1);
      continue;
    }
    rest = rest.slice(reference[0].length);
    const name = reference[1] ?? reference[2];
    const group = /^\d+$/.test(name) ? Number(name) : compiled.names.indexOf(name);
    if (group >= 0 && group * 2 < match.length && match[group * 2] >= 0) {
      result += input.slice(match[group * 2], match[group * 2 + 1]);
    }
  }
  return result + rest;
}

function replaceAll(compiled: Compiled, input: string, replacement: (match: Match) => string): string {
  let result = '';
  let last = 0;
  for (const match of allMatches(compiled, input, -1)) {
    result += input.slice(last, match[0]) + replacement(match);
    last = match[1];
  }
  return result + input.slice(last);
}

function split(compiled: Compiled, input: string, limit: number): string[] {
  if (limit === 0) return [];
  if (compiled.text === '' && input === '') return [''];
  const matches = allMatches(compiled, input, -1);
  const pieces: string[] = [];
  let begin = 0;
  let end = 0;
  for (const match of matches) {
    if (limit > 0 && pieces.length === limit - 1) break;
    end = match[0];
    if (match[1] === 0) continue;
    pieces.push(input.slice(begin, end));
    begin = match[1];
  }
  if (end !== input.length) pieces.push(input.slice(begin));
  return pieces;
}

// Package -------------------------------------------------------------------------------------------------------------

const REGEXP = namedType('regexp', 'Regexp', { kind: 'struct', fields: [] });
const REGEXP_POINTER = pointerTo(REGEXP);
const STRINGS = sliceOf(STRING);
const INTS = sliceOf(INT);
const BYTES = sliceOf(BASIC.uint8);

const compiledOf = (receiver: Value): Compiled => {
  if (!(receiver instanceof Pointer)) throw new GoPanic(newError('invalid memory address or nil pointer dereference'));
  return (receiver.load() as GoStruct).native?.regexp as Compiled;
};

const strings = (values: string[]): Value => sliceOfValues(values);
const ints = (values: number[]): Value => sliceOfValues(values.map(BigInt));
const groups = (input: string, match: Match): string[] =>
  Array.from({ length: match.length / 2 }, (_, index) =>
    match[index * 2] < 0 ? '' : input.slice(match[index * 2], match[index * 2 + 1])
  );

const methods: [string, Type[], Type[], (compiled: Compiled, args: Value[]) => Value | Value[]][] = [
  ['String', [], [STRING], (compiled) => compiled.text],
  ['NumSubexp', [], [INT], (compiled) => BigInt(compiled.names.length - 1)],
  ['SubexpNames', [], [STRINGS], (compiled) => strings(compiled.names)],
  [
    'SubexpIndex',
    [STRING],
    [INT],
    (compiled, [name]) => BigInt(name === '' ? -1 : compiled.names.indexOf(name as string)),
  ],
  ['MatchString', [STRING], [BOOL], (compiled, [s]) => firstMatch(compiled, s as string) !== undefined],
  ['Match', [BYTES], [BOOL], (compiled, [b]) => firstMatch(compiled, bytesOf(b)) !== undefined],
  [
    'FindString',
    [STRING],
    [STRING],
    (compiled, [s]) => {
      const match = firstMatch(compiled, s as string);
      return match ? (s as string).slice(match[0], match[1]) : '';
    },
  ],
  [
    'Find',
    [BYTES],
    [BYTES],
    (compiled, [b]) => {
      const input = bytesOf(b);
      const match = firstMatch(compiled, input);
      return match ? byteSlice(input.slice(match[0], match[1])) : undefined;
    },
  ],
  [
    'FindStringIndex',
    [STRING],
    [INTS],
    (compiled, [s]) => {
      const match = firstMatch(compiled, s as string);
      return match ? ints(match.slice(0, 2)) : undefined;
    },
  ],
  [
    'FindStringSubmatch',
    [STRING],
    [STRINGS],
    (compiled, [s]) => {
      const match = firstMatch(compiled, s as string);
      return match ? strings(groups(s as string, match)) : undefined;
    },
  ],
  [
    'FindStringSubmatchIndex',
    [STRING],
    [INTS],
    (compiled, [s]) => {
      const match = firstMatch(compiled, s as string);
      return match ? ints(match) : undefined;
    },
  ],
  [
    'FindAllString',
    [STRING, INT],
    [STRINGS],
    (compiled, [s, n]) => {
      const matches = allMatches(compiled, s as string, Number(n as bigint));
      return matches.length === 0
        ? undefined
        : strings(matches.map((match) => (s as string).slice(match[0], match[1])));
    },
  ],
  [
    'FindAll',
    [BYTES, INT],
    [sliceOf(BYTES)],
    (compiled, [b, n]) => {
      const input = bytesOf(b);
      const matches = allMatches(compiled, input, Number(n as bigint));
      return matches.length === 0
        ? undefined
        : sliceOfValues(matches.map((match) => byteSlice(input.slice(match[0], match[1]))));
    },
  ],
  [
    'FindAllStringIndex',
    [STRING, INT],
    [sliceOf(INTS)],
    (compiled, [s, n]) => {
      const matches = allMatches(compiled, s as string, Number(n as bigint));
      return matches.length === 0 ? undefined : sliceOfValues(matches.map((match) => ints(match.slice(0, 2))));
    },
  ],
  [
    'FindAllStringSubmatch',
    [STRING, INT],
    [sliceOf(STRINGS)],
    (compiled, [s, n]) => {
      const matches = allMatches(compiled, s as string, Number(n as bigint));
      return matches.length === 0
        ? undefined
        : sliceOfValues(matches.map((match) => strings(groups(s as string, match))));
    },
  ],
  [
    'FindAllStringSubmatchIndex',
    [STRING, INT],
    [sliceOf(INTS)],
    (compiled, [s, n]) => {
      const matches = allMatches(compiled, s as string, Number(n as bigint));
      return matches.length === 0 ? undefined : sliceOfValues(matches.map((match) => ints(match)));
    },
  ],
  [
    'ReplaceAllString',
    [STRING, STRING],
    [STRING],
    (compiled, [s, template]) =>
      replaceAll(compiled, s as string, (match) => expand(compiled, template as string, s as string, match)),
  ],
  [
    'ReplaceAllLiteralString',
    [STRING, STRING],
    [STRING],
    (compiled, [s, replacement]) => replaceAll(compiled, s as string, () => replacement as string),
  ],
  [
    'ReplaceAllStringFunc',
    [STRING, fn([STRING], [STRING])],
    [STRING],
    (compiled, [s, replace]) =>
      replaceAll(
        compiled,
        s as string,
        (match) => callFunction(replace, [(s as string).slice(match[0], match[1])]) as string
      ),
  ],
  [
    'ReplaceAll',
    [BYTES, BYTES],
    [BYTES],
    (compiled, [b, template]) => {
      const input = bytesOf(b);
      return byteSlice(replaceAll(compiled, input, (match) => expand(compiled, bytesOf(template), input, match)));
    },
  ],
  ['Split', [STRING, INT], [STRINGS], (compiled, [s, n]) => strings(split(compiled, s as string, Number(n as bigint)))],
];
for (const [name, params, results, impl] of methods) {
  addMethod(REGEXP, name, fn(params, results), (receiver, args) => impl(compiledOf(receiver), args), true);
}

const regexpValue = (compiled: Compiled): Pointer => new Pointer(new Cell(new GoStruct([], { regexp: compiled })), 'v');

function compileValue(text: string): [Value, Value] {
  try {
    return [regexpValue(compile(text)), undefined];
  } catch (error) {
    return [undefined, compileError(text, error)];
  }
}

const members: Record<string, Entity> = {
  Regexp: typeEntity(REGEXP),
  Compile: nativeFunction('Compile', fn([STRING], [REGEXP_POINTER, ERROR_TYPE]), ([text]) =>
    compileValue(text as string)
  ),
  MustCompile: nativeFunction('MustCompile', fn([STRING], [REGEXP_POINTER]), ([text]) => {
    const [value, error] = compileValue(text as string);
    if (error !== undefined) {
      const message = (((error as Iface).value as Pointer).load() as GoStruct).fields[0] as string;
      throw new GoPanic(new Iface(BASIC.string, `regexp: Compile(${quoteForPanic(text as string)}): ${message}`));
    }
    return value;
  }),
  MatchString: nativeFunction('MatchString', fn([STRING, STRING], [BOOL, ERROR_TYPE]), ([pattern, s]) => {
    const [value, error] = compileValue(pattern as string);
    if (error !== undefined) return [false, error];
    return [firstMatch(compiledOf(value), s as string) !== undefined, undefined];
  }),
  QuoteMeta: nativeFunction('QuoteMeta', fn([STRING], [STRING]), ([s]) =>
    (s as string).replaceAll(/[\\.+*?()|[\]{}^$]/g, (char) => `\\${char}`)
  ),
};

/** Go's quote of the pattern in MustCompile's panic, which uses backquotes when it can. */
function quoteForPanic(text: string): string {
  return /[`\n\r]/.test(text) ? JSON.stringify(text) : `\`${text}\``;
}

export const REGEXP_PACKAGE = definePackage('regexp', members, [
  'CompilePOSIX',
  'MustCompilePOSIX',
  'Match',
  'MatchReader',
]);
