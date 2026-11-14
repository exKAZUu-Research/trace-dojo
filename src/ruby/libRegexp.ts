import vm from 'node:vm';

// code-gauge-allow-file fileNcss 558 -- The libRegexp module keeps one concern's cases together.
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { inspect, rEquals, strInspect, toIndex, toS, toStr } from './conversions';
import { def, extend, sdef } from './define';
import { argumentError, frozenError, indexError, rubyError, typeError } from './errors';
import { hashGet, hashSet } from './hashes';
import { callBlock, callMethod, type Gen } from './interp';
import { makeEnumerator } from './libEnumerator';
import { setText } from './libString';
import {
  type NativeFn,
  NIL,
  RArray,
  RHash,
  RObject,
  type RProc,
  RRange,
  RString,
  RSymbol,
  type Value,
} from './objects';
import {
  regexpCaptureNames,
  regexpCommentEnd,
  regexpHasNumberedBackref,
  regexpLineCommentEnd,
} from './regexpCaptureNames';
import { type Frame, rt, UnsupportedFeatureError } from './runtime';
import { arr, newHash, realClassOf, str, sym, truthy } from './values';

export interface RegexpData {
  source: string;
  ignoreCase: boolean;
  multiline: boolean;
  extended: boolean;
  /** The translated expression; its `lastIndex` is set before each use. */
  js: RegExp;
  safeNative: boolean;
  context?: vm.Context;
}

const MATCH_SCRIPT = new vm.Script('regexp.exec(input)');

const POSIX_CLASSES: Record<string, string> = {
  alpha: String.raw`\p{L}\p{M}`,
  digit: '0-9',
  alnum: String.raw`\p{L}\p{M}\p{Nd}`,
  upper: String.raw`\p{Lu}`,
  lower: String.raw`\p{Ll}`,
  space: String.raw` \t\r\n\f\v`,
  punct: String.raw`\p{P}`,
  xdigit: '0-9A-Fa-f',
  word: String.raw`\p{L}\p{M}\p{Nd}\p{Nl}\p{Pc}\u200C\u200D`,
  cntrl: String.raw`\p{Cc}`,
  print: String.raw`\P{C}`,
  graph: String.raw`\p{L}\p{M}\p{N}\p{P}\p{S}`,
  blank: String.raw` \t`,
};

const PROPERTY_NAMES: Record<string, string> = {
  hiragana: 'Script=Hiragana',
  katakana: 'Script=Katakana',
  han: 'Script=Han',
  latin: 'Script=Latin',
  greek: 'Script=Greek',
  cyrillic: 'Script=Cyrillic',
  alpha: 'Alphabetic',
  digit: 'Nd',
  upper: 'Lu',
  lower: 'Ll',
  space: 'White_Space',
  word: 'L',
  punct: 'P',
};

const SYNTAX = String.raw`^$\.*+?()[]{}|/-`;

/** Translates a Ruby (Onigmo) expression into JavaScript's syntax, rejecting what has no counterpart. */
export function translate(source: string, extended: boolean, multiline = false): string {
  rejectNestedRepetition(source, extended);
  let out = '';
  let inClass = 0;
  let classStart = 0;
  let negatedClassBodies: string[] = [];
  let atomStart = 0;
  const groupStarts: number[] = [];
  const dotallStack: boolean[] = [];
  let dotall = multiline;
  const namedCaptures = regexpCaptureNames(source, extended).length > 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (extended && inClass === 0) {
      if (/\s/.test(char)) continue;
      if (char === '#') {
        index = regexpLineCommentEnd(source, index);
        continue;
      }
    }
    if (char === '\\') {
      if (inClass === 0) atomStart = out.length;
      const next = source[++index] ?? '\\';
      if (inClass > 0 && /^[0-7]$/.test(next)) {
        const octal = /^[0-7]{0,2}/.exec(source.slice(index + 1))?.[0] ?? '';
        out += `\\x${Number.parseInt(next + octal, 8)
          .toString(16)
          .padStart(2, '0')}`;
        index += octal.length;
        continue;
      }
      if (inClass > 0 && /^[89]$/.test(next)) {
        out += next;
        continue;
      }
      if (next === 'x' && /^[0-9a-fA-F]{2}/.test(source.slice(index + 1))) {
        out += `\\x${source.slice(index + 1, index + 3)}`;
        index += 2;
        continue;
      }
      if (next === 'u') {
        const braced = /^\{[0-9a-fA-F]{1,6}\}/.exec(source.slice(index + 1));
        const fixed = /^[0-9a-fA-F]{4}/.exec(source.slice(index + 1));
        if (braced || fixed) {
          out += `\\u${braced?.[0] ?? fixed?.[0]}`;
          index += (braced?.[0] ?? fixed?.[0])!.length;
          continue;
        }
      }
      if (next === '0' || (/^[1-7]$/.test(next) && /^[0-7]/.test(source.slice(index + 1)))) {
        const octal = /^[0-7]{0,2}/.exec(source.slice(index + 1))?.[0] ?? '';
        out += `\\x${Number.parseInt(next + octal, 8)
          .toString(16)
          .padStart(2, '0')}`;
        index += octal.length;
        continue;
      }
      if (next === 'c' && /^[A-Za-z]/.test(source[index + 1] ?? '')) {
        out += `\\x${(source[index + 1].toUpperCase().codePointAt(0)! & 31).toString(16).padStart(2, '0')}`;
        index++;
        continue;
      }
      out += translateEscape(next, source, index, inClass > 0, (count) => {
        index += count;
      });
      continue;
    }
    if (char === '[') {
      const posix = /^\[:(\^?)(\w+):\]/.exec(source.slice(index));
      if (inClass > 0 && posix) {
        const body = POSIX_CLASSES[posix[2]];
        if (!body) throw unsupportedSyntax(`[:${posix[2]}:]`);
        if (posix[1]) negatedClassBodies.push(body);
        else out += body;
        index += posix[0].length - 1;
        continue;
      }
      if (inClass > 0) {
        if (source[index + 1] === '[' || source[index + 1] === '^') throw unsupportedSyntax('入れ子の文字クラス');
        out += String.raw`\[`;
        continue;
      }
      atomStart = out.length;
      classStart = out.length;
      negatedClassBodies = [];
      inClass++;
      out += char;
      continue;
    }
    if (char === ']' && inClass > 0) {
      if (out.slice(classStart + 1) === '^' && negatedClassBodies.length === 0) {
        out += String.raw`\]`;
        continue;
      }
      inClass--;
      if (negatedClassBodies.length > 0) {
        const regularBody = out.slice(classStart + 1);
        const outerNegated = regularBody.startsWith('^');
        const literalBody = outerNegated ? regularBody.slice(1) : regularBody;
        const alternatives = [
          ...(literalBody ? [`[${literalBody}]`] : []),
          ...negatedClassBodies.map((body) => `(?:(?![${body}])[\\s\\S])`),
        ];
        const union = alternatives.length === 1 ? alternatives[0] : `(?:${alternatives.join('|')})`;
        out = out.slice(0, classStart) + (outerNegated ? `(?:(?!(?:${union}))[\\s\\S])` : union);
      } else out += char;
      continue;
    }
    if (inClass > 0 && char === '&' && source[index + 1] === '&') throw unsupportedSyntax('文字クラスの積集合（&&）');
    if (inClass === 0 && char === '(' && source[index + 1] === '?') {
      const rest = source.slice(index + 2);
      if (rest.startsWith('>')) throw unsupportedSyntax('アトミックグループ（(?>)）');
      if (rest.startsWith('~')) throw unsupportedSyntax('不在演算子（(?~...)）');
      const scoped = /^([imx]*)(?:-([imx]*))?:/.exec(rest);
      if (scoped) {
        const enabled = scoped[1];
        const disabled = scoped[2] ?? '';
        if (enabled.includes('x') || (extended && disabled.includes('x')))
          throw unsupportedSyntax('中のオプションの指定（(?x:...)）');
        const on = enabled.replaceAll('m', 's').replaceAll('x', '');
        const off = disabled.replaceAll('m', 's').replaceAll('x', '');
        groupStarts.push(out.length);
        dotallStack.push(dotall);
        if (enabled.includes('m')) dotall = true;
        if (disabled.includes('m')) dotall = false;
        out += on || off ? `(?${on}${off ? `-${off}` : ''}:` : '(?:';
        index += scoped[0].length + 1;
        continue;
      }
      if (/^[imx-]+[:)]/.test(rest)) throw unsupportedSyntax('中のオプションの指定（(?i) など）');
      if (rest.startsWith('#')) {
        const end = regexpCommentEnd(source, index + 3);
        if (end === -1) throw rubyError(rt().c.RegexpError, `invalid pattern: /${source}/`);
        index = end;
        continue;
      }
    }
    if (inClass === 0 && char === '(' && source[index + 1] !== '?' && namedCaptures) {
      groupStarts.push(out.length);
      dotallStack.push(dotall);
      out += '(?:';
      continue;
    }
    if (inClass === 0 && char === '(') {
      groupStarts.push(out.length);
      dotallStack.push(dotall);
    }
    if (inClass === 0 && char === ')') {
      atomStart = groupStarts.pop() ?? out.length;
      dotall = dotallStack.pop() ?? multiline;
    }
    if (inClass === 0 && char === '{') {
      const interval = /^\{(?:\d+(?:,\d*)?|,\d+)\}/.exec(source.slice(index));
      if (interval) {
        const quantified = out.slice(atomStart) + interval[0].replace('{,', '{0,');
        const next = source[index + interval[0].length];
        const repeated =
          next !== undefined &&
          ('*+{'.includes(next) || (next === '?' && source[index + interval[0].length + 1] === '?'));
        out = `${out.slice(0, atomStart)}${repeated ? `(?:${quantified})` : quantified}`;
        index += interval[0].length - 1;
        continue;
      }
    }
    if (inClass === 0 && (char === '{' || char === '}' || char === ']')) {
      out += `\\${char}`;
      continue;
    }
    if (inClass === 0 && char === '+' && /[*+?]/.test(source[index - 1] ?? '') && source[index - 2] !== '\\') {
      throw unsupportedSyntax('強欲な量指定子（*+ など）');
    }
    if (inClass === 0 && char === '.') {
      atomStart = out.length;
      out += dotall ? String.raw`[\s\S]` : String.raw`[^\n]`;
      continue;
    }
    if (inClass === 0 && char === '^') {
      out += String.raw`(?:(?<![\s\S])|(?<=\n)(?=[\s\S]))`;
      continue;
    }
    if (inClass === 0 && char === '$') {
      out += String.raw`(?![^\n])`;
      continue;
    }
    if (inClass === 0 && !'*+?)}|'.includes(char)) {
      atomStart = out.length;
    }
    if (inClass === 0 && (source.codePointAt(index) ?? 0) > 0xff_ff) {
      out += source.slice(index, index + 2);
      index++;
      continue;
    }
    out += char;
  }
  return out;
}

function rejectNestedRepetition(source: string, extended: boolean): void {
  const groups: boolean[] = [];
  let inClass = false;
  let closedGroupRisky = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (extended && !inClass) {
      if (/\s/.test(char)) continue;
      if (char === '#') {
        index = regexpLineCommentEnd(source, index);
        if (index >= source.length) break;
        continue;
      }
    }
    if (!inClass && source.startsWith('(?#', index)) {
      index = regexpCommentEnd(source, index + 3);
      if (index < 0) break;
      continue;
    }
    if (char === '\\') {
      index++;
      closedGroupRisky = false;
      continue;
    }
    if (char === '[') inClass = true;
    if (char === ']') inClass = false;
    if (inClass) continue;
    if (char === '(') {
      groups.push(false);
      closedGroupRisky = false;
      continue;
    }
    if (char === ')') {
      closedGroupRisky = groups.pop() ?? false;
      if (closedGroupRisky && groups.length > 0) groups[groups.length - 1] = true;
      continue;
    }
    const quantified =
      char === '+' ||
      char === '*' ||
      (char === '?' && source[index - 1] !== '(') ||
      (char === '{' && /^\{(?:\d+(?:,\d*)?|,\d+)\}/.test(source.slice(index)));
    if (quantified && closedGroupRisky) throw unsupportedSyntax('入れ子の繰り返し');
    if ((quantified || char === '|') && groups.length > 0) groups[groups.length - 1] = true;
    if (!'?*+{}'.includes(char)) closedGroupRisky = false;
  }
}

// code-gauge-allow functionNcss 35 -- Ruby's method takes these argument forms, which the branches mirror.
function translateEscape(
  next: string,
  source: string,
  index: number,
  inClass: boolean,
  skip: (count: number) => void
): string {
  switch (next) {
    case 'A': {
      return String.raw`(?<![\s\S])`;
    }
    case 'z': {
      return String.raw`(?![\s\S])`;
    }
    case 'Z': {
      return String.raw`(?=\n?(?![\s\S]))`;
    }
    case 'h': {
      return inClass ? '0-9a-fA-F' : '[0-9a-fA-F]';
    }
    case 'H': {
      return '[^0-9a-fA-F]';
    }
    case 'G': {
      throw unsupportedSyntax(String.raw`\G`);
    }
    case 'b': {
      if (inClass) return String.raw`\b`;
      const word = `[${POSIX_CLASSES.word}]`;
      return `(?:(?<=${word})(?!${word})|(?<!${word})(?=${word}))`;
    }
    case 'B': {
      if (inClass) throw unsupportedSyntax(String.raw`文字クラス内の\B`);
      const word = `[${POSIX_CLASSES.word}]`;
      return `(?:(?<=${word})(?=${word})|(?<!${word})(?!${word}))`;
    }
    case 'R': {
      return String.raw`(?:\r\n|[\n\v\f\r\u0085  ])`;
    }
    case 'e': {
      return String.raw`\x1B`;
    }
    case 'a': {
      return String.raw`\x07`;
    }
    case 's': {
      return inClass ? String.raw` \t\r\n\f\v` : String.raw`[ \t\r\n\f\v]`;
    }
    case 'S': {
      if (inClass) throw unsupportedSyntax(String.raw`文字クラス内の\S`);
      return String.raw`[^ \t\r\n\f\v]`;
    }
    case 'p':
    case 'P': {
      const property = /^\{(\^?)(\w+)\}/.exec(source.slice(index + 1));
      if (!property) return `\\${next}`;
      const name = PROPERTY_NAMES[property[2].toLowerCase()] ?? property[2];
      skip(property[0].length);
      const negated = (next === 'P') !== (property[1] === '^');
      return `\\${negated ? 'P' : 'p'}{${name}}`;
    }
    case 'k': {
      if (/^<\d+>/.test(source.slice(index + 1))) throw unsupportedSyntax('番号付き後方参照');
      return String.raw`\k`;
    }
    default: {
      if (/[dDwWsSbBnrtfv0-9xuc]/.test(next)) return `\\${next}`;
      if (/[A-Za-z0-9]/.test(next)) throw unsupportedSyntax(`\\${next}`);
      return SYNTAX.includes(next) && (next !== '-' || inClass) ? `\\${next}` : next;
    }
  }
}

function unsupportedSyntax(feature: string): unknown {
  return new UnsupportedFeatureError(`正規表現の${feature}`);
}

export function makeRegexp(
  source: string,
  options: { ignoreCase?: boolean; multiline?: boolean; extended?: boolean; literal?: boolean }
): RObject {
  if (options.literal) source = source.replaceAll(/(?<!\\)\\\//g, '/');
  if (regexpCaptureNames(source, options.extended).length > 0 && regexpHasNumberedBackref(source, options.extended))
    throw rubyError(rt().c.RegexpError, `numbered backref/call is not allowed. (use name): /${source}/`);
  const regexp = new RObject(rt().c.Regexp);
  const translated = translate(source, options.extended ?? false, options.multiline ?? false);
  let js: RegExp;
  try {
    js = new RegExp(translated, `dgmu${options.ignoreCase ? 'i' : ''}${options.multiline ? 's' : ''}`);
  } catch {
    throw rubyError(rt().c.RegexpError, `invalid pattern: /${source}/`);
  }
  const data: RegexpData = {
    source,
    ignoreCase: options.ignoreCase ?? false,
    multiline: options.multiline ?? false,
    extended: options.extended ?? false,
    js,
    safeNative: triviallyLinearRegexp(source),
  };
  regexp.data = data;
  return regexp;
}

function triviallyLinearRegexp(source: string): boolean {
  let inClass = false;
  let quantifier = -1;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') {
      const next = source[++index];
      if (next && /[1-9kg]/.test(next)) return false;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (!inClass) {
      if (char === '|' || char === '{' || (char === '(' && source[index + 1] === '?')) return false;
      if ('*+?'.includes(char)) {
        if (quantifier >= 0) return false;
        quantifier = index;
      }
    }
  }
  if (quantifier < 0) return true;
  const tail = source.slice(quantifier + 1).replaceAll(')', '');
  return (
    tail === '' ||
    ((tail === '$' || tail === String.raw`\z`) && (source.startsWith('^') || source.startsWith(String.raw`\A`)))
  );
}

export function isRegexp(value: Value): value is RObject {
  return value instanceof RObject && value.cls === rt().c.Regexp;
}

function dataOf(regexp: RObject): RegexpData {
  return regexp.data as RegexpData;
}

// Matching -------------------------------------------------------------------------------------------------------------

export interface MatchState {
  text: string;
  literal?: boolean;
  groups: (readonly [number, number] | undefined)[];
  names: string[];
  namedGroups: Record<string, number>;
  regexp: RObject;
}

/** Character positions from UTF-16 offsets, as Ruby counts positions in characters. */
function charIndex(text: string, unit: number): number {
  if (!/[\uD800-\uDFFF]/.test(text)) return unit;
  let count = 0;
  for (let index = 0; index < unit; index++) {
    if ((text.codePointAt(index) as number) > 0xff_ff) index++;
    count++;
  }
  return count;
}

function unitIndex(text: string, char: number): number {
  if (!/[\uD800-\uDFFF]/.test(text)) return char;
  return [...text].slice(0, char).join('').length;
}

/** Runs a regexp from a character position, returning the match's state or undefined. */
export function execAt(regexp: RObject, text: string, start: number): MatchState | undefined {
  if (start < 0 || start > charIndex(text, text.length)) return undefined;
  const data = dataOf(regexp);
  const { js } = data;
  rt().spend(Math.ceil(text.length / 64));
  js.lastIndex = unitIndex(text, start);
  let result: RegExpExecArray | null;
  if (data.safeNative) result = js.exec(text);
  else {
    const remaining = rt().budget.remainingMilliseconds;
    if (remaining === 0) throw new ExecutionLimitError('time');
    const context = (data.context ??= vm.createContext({ regexp: js, input: text }));
    context.input = text;
    try {
      result = MATCH_SCRIPT.runInContext(context, { timeout: remaining }) as RegExpExecArray | null;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT')
        throw new ExecutionLimitError('time');
      throw error;
    }
  }
  if (!result?.indices) return undefined;
  const names: string[] = [];
  const namedGroups: Record<string, number> = Object.create(null) as Record<string, number>;
  const nameOrder = regexpCaptureNames(js.source);
  for (const [position, name] of nameOrder.entries()) {
    if (!(name in namedGroups)) names.push(name);
    if (!(name in namedGroups) || result.indices[position + 1] !== undefined) namedGroups[name] = position + 1;
  }
  return { text, groups: [...result.indices], names, namedGroups, regexp };
}

function matchData(state: MatchState): RObject {
  const match = new RObject(rt().c.MatchData);
  match.data = state;
  return match;
}

function stateOf(match: RObject): MatchState {
  return match.data as MatchState;
}

function groupText(state: MatchState, group: number): Value {
  const range = state.groups[group];
  return range ? str(state.text.slice(range[0], range[1])) : NIL;
}

/** Sets `$~` for the method frame that called a matching method, as Ruby keeps it per frame. */
function setLastMatch(state: MatchState | undefined): Value {
  const frame = callerFrame();
  const match = state ? matchData(state) : NIL;
  frame.extra.lastMatch = match;
  return match;
}

export function setLiteralMatch(text: string, target: string, from: number): void {
  if (from < 0) {
    setLastMatch(undefined);
    return;
  }
  setLastMatch({
    text,
    literal: true,
    groups: [[from, from + target.length]],
    names: [],
    namedGroups: Object.create(null) as Record<string, number>,
    regexp: makeRegexp(escapeRegexpSource(target), {}),
  });
}

function callerFrame(): Frame {
  return rt().frame.home;
}

export function lastMatch(): Value {
  return callerFrame().extra.lastMatch ?? NIL;
}

/** The value of a match global: `$~`, `$&`, `` $` ``, `$'`, `$+`, or `$1`... */
export function matchGlobal(name: string): Value {
  const match = lastMatch();
  if (name === '$~') return match;
  if (match === NIL) return NIL;
  const state = stateOf(match as RObject);
  const whole = state.groups[0] as readonly [number, number];
  switch (name) {
    case '$&': {
      return groupText(state, 0);
    }
    case '$`': {
      return str(state.text.slice(0, whole[0]));
    }
    case "$'": {
      return str(state.text.slice(whole[1]));
    }
    case '$+': {
      for (let group = state.groups.length - 1; group > 0; group--)
        if (state.groups[group]) return groupText(state, group);
      return NIL;
    }
    default: {
      return groupText(state, Number(name.slice(1)));
    }
  }
}

/** All matches from the start of a text, advancing past empty matches as Ruby does. */
function allMatches(regexp: RObject, text: string): MatchState[] {
  const matches: MatchState[] = [];
  let start = 0;
  const length = charIndex(text, text.length);
  while (start <= length) {
    const state = execAt(regexp, text, start);
    if (!state) break;
    matches.push(state);
    const [from, to] = state.groups[0] as readonly [number, number];
    start = charIndex(text, to) + (from === to ? 1 : 0);
  }
  return matches;
}

// Regexp ---------------------------------------------------------------------------------------------------------------

function* optionsOf(value: Value | undefined): Gen<{ ignoreCase: boolean; multiline: boolean; extended: boolean }> {
  if (value === undefined || value === NIL || value === false)
    return { ignoreCase: false, multiline: false, extended: false };
  if (typeof value === 'bigint') {
    return { ignoreCase: (value & 1n) !== 0n, extended: (value & 2n) !== 0n, multiline: (value & 4n) !== 0n };
  }
  if (value instanceof RString) {
    return { ignoreCase: value.s.includes('i'), multiline: value.s.includes('m'), extended: value.s.includes('x') };
  }
  yield* [];
  return { ignoreCase: true, multiline: false, extended: false };
}

sdef('Regexp', ['new', 'compile'], [1, 2], function* (_self, [source, options]) {
  if (isRegexp(source)) {
    const data = dataOf(source);
    return makeRegexp(data.source, data);
  }
  return makeRegexp(yield* toStr(source), yield* optionsOf(options));
});
sdef('Regexp', ['escape', 'quote'], 1, function* (_self, [value]) {
  const text = value instanceof RSymbol ? value.name : yield* toStr(value);
  return str(escapeRegexpSource(text));
});
sdef('Regexp', 'union', [0, -1], function* (_self, args) {
  const items = args.length === 1 && args[0] instanceof RArray ? args[0].items : args;
  const parts: string[] = [];
  for (const item of items) {
    if (isRegexp(item)) parts.push(regexpToS(item));
    else parts.push(escapeRegexpSource(yield* toStr(item)));
  }
  return makeRegexp(parts.length === 0 ? '(?!)' : parts.join('|'), {});
});

function escapeRegexpSource(value: string): string {
  return Array.from(value, (char) => {
    switch (char) {
      case '\n': {
        return String.raw`\n`;
      }
      case '\t': {
        return String.raw`\t`;
      }
      case '\r': {
        return String.raw`\r`;
      }
      case '\f': {
        return String.raw`\f`;
      }
      case '\v': {
        return String.raw`\v`;
      }
      default: {
        return String.raw`.*?+^$|()[]{}\-# `.includes(char) ? `\\${char}` : char;
      }
    }
  }).join('');
}
sdef('Regexp', 'last_match', [0, 1], function* (_self, args) {
  if (args.length === 0) return lastMatch();
  const match = lastMatch();
  if (match === NIL) return NIL;
  return yield* matchIndex(match as RObject, args[0]);
});

function regexpToS(regexp: RObject): string {
  const data = dataOf(regexp);
  const on = `${data.multiline ? 'm' : ''}${data.ignoreCase ? 'i' : ''}${data.extended ? 'x' : ''}`;
  const off = `${data.multiline ? '' : 'm'}${data.ignoreCase ? '' : 'i'}${data.extended ? '' : 'x'}`;
  return `(?${on}${off ? `-${off}` : ''}:${data.source})`;
}

function regexpInspect(regexp: RObject): string {
  const data = dataOf(regexp);
  const source = data.source.replaceAll(/(?<!\\)\//g, String.raw`\/`);
  return `/${source}/${data.multiline ? 'm' : ''}${data.ignoreCase ? 'i' : ''}${data.extended ? 'x' : ''}`;
}

export function regexpDisplayOf(value: RObject): string | undefined {
  return isRegexp(value) ? regexpInspect(value) : undefined;
}

def('Regexp', 'source', 0, (self: RObject) => str(dataOf(self).source));
def('Regexp', 'inspect', 0, (self: RObject) => str(regexpInspect(self)));
def('Regexp', 'to_s', 0, (self: RObject) => str(regexpToS(self)));
def('Regexp', 'options', 0, (self: RObject) => {
  const data = dataOf(self);
  return BigInt((data.ignoreCase ? 1 : 0) | (data.extended ? 2 : 0) | (data.multiline ? 4 : 0));
});
def('Regexp', 'casefold?', 0, (self: RObject) => dataOf(self).ignoreCase);
def('Regexp', ['==', 'eql?'], 1, (self: RObject, [other]) => {
  if (!isRegexp(other)) return false;
  const a = dataOf(self);
  const b = dataOf(other);
  return (
    a.source === b.source && a.ignoreCase === b.ignoreCase && a.multiline === b.multiline && a.extended === b.extended
  );
});
def('Regexp', 'hash', 0, (self: RObject) => BigInt(dataOf(self).source.length));
def('Regexp', 'names', 0, (self: RObject) =>
  arr([...new Set(regexpCaptureNames(dataOf(self).js.source))].map((name) => str(name)))
);

function* subjectText(value: Value): Gen<string | undefined> {
  if (value === NIL) return undefined;
  if (value instanceof RSymbol) return value.name;
  return yield* toStr(value);
}

def('Regexp', 'match', [1, 2], function* (self: RObject, args, block) {
  const text = yield* subjectText(args[0]);
  if (text === undefined) return setLastMatch(undefined);
  const start = args.length > 1 ? yield* toIndex(args[1]) : 0;
  const match = setLastMatch(execAt(self, text, start < 0 ? start + charIndex(text, text.length) : start));
  if (block && match !== NIL) return yield* callBlock(block, [match]);
  return match;
});
def('Regexp', 'match?', [1, 2], function* (self: RObject, args) {
  const text = yield* subjectText(args[0]);
  if (text === undefined) return false;
  const start = args.length > 1 ? yield* toIndex(args[1]) : 0;
  return execAt(self, text, start < 0 ? start + charIndex(text, text.length) : start) !== undefined;
});
def('Regexp', '=~', 1, function* (self: RObject, [value]) {
  const text = yield* subjectText(value);
  if (text === undefined) return setLastMatch(undefined);
  const state = execAt(self, text, 0);
  setLastMatch(state);
  return state ? BigInt(charIndex(text, (state.groups[0] as readonly [number, number])[0])) : NIL;
});
def('Regexp', '===', 1, function* (self: RObject, [value]) {
  if (!(value instanceof RString) && !(value instanceof RSymbol)) return false;
  const state = execAt(self, value instanceof RString ? value.s : value.name, 0);
  setLastMatch(state);
  yield* [];
  return state !== undefined;
});

// MatchData ------------------------------------------------------------------------------------------------------------

function* matchIndex(match: RObject, key: Value): Gen {
  const state = stateOf(match);
  if (key instanceof RString || key instanceof RSymbol) {
    const name = key instanceof RString ? key.s : key.name;
    const group = state.namedGroups[name];
    if (group === undefined) throw indexError(`undefined group name reference: ${name}`);
    return groupText(state, group);
  }
  let group = yield* toIndex(key);
  if (group < 0) group += state.groups.length;
  return group >= 0 && group < state.groups.length ? groupText(state, group) : NIL;
}

def('MatchData', '[]', [1, 2], function* (self: RObject, args) {
  if (args.length === 2 || args[0] instanceof RRange) {
    const state = stateOf(self);
    return yield* callMethod(arr(state.groups.map((_range, group) => groupText(state, group))), '[]', args);
  }
  return yield* matchIndex(self, args[0]);
});
def('MatchData', 'captures', 0, (self: RObject) =>
  arr(
    stateOf(self)
      .groups.slice(1)
      .map((_range, group) => groupText(stateOf(self), group + 1))
  )
);
def('MatchData', 'to_a', 0, (self: RObject) =>
  arr(stateOf(self).groups.map((_range, group) => groupText(stateOf(self), group)))
);
def('MatchData', ['==', 'eql?'], 1, (self: RObject, [other]) => {
  if (!(other instanceof RObject) || realClassOf(other) !== rt().c.MatchData) return false;
  const left = stateOf(self);
  const right = stateOf(other);
  const leftRegexp = dataOf(left.regexp);
  const rightRegexp = dataOf(right.regexp);
  return (
    left.text === right.text &&
    leftRegexp.source === rightRegexp.source &&
    leftRegexp.ignoreCase === rightRegexp.ignoreCase &&
    leftRegexp.multiline === rightRegexp.multiline &&
    leftRegexp.extended === rightRegexp.extended &&
    left.groups.length === right.groups.length &&
    left.groups.every((range, index) =>
      range === undefined
        ? right.groups[index] === undefined
        : range[0] === right.groups[index]?.[0] && range[1] === right.groups[index]?.[1]
    )
  );
});
def('MatchData', 'named_captures', 0, function* (self: RObject) {
  const hash = newHash();
  const state = stateOf(self);
  for (const name of state.names) yield* hashSet(hash, str(name), groupText(state, state.namedGroups[name]));
  return hash;
});

def('MatchData', 'names', 0, (self: RObject) => arr(stateOf(self).names.map((name) => str(name))));
def('MatchData', ['to_s'], 0, (self: RObject) => groupText(stateOf(self), 0));
def('MatchData', 'pre_match', 0, (self: RObject) => {
  const state = stateOf(self);
  return str(state.text.slice(0, (state.groups[0] as readonly [number, number])[0]));
});
def('MatchData', 'post_match', 0, (self: RObject) => {
  const state = stateOf(self);
  return str(state.text.slice((state.groups[0] as readonly [number, number])[1]));
});
for (const [name, side] of [
  ['begin', 0],
  ['end', 1],
] as const) {
  def('MatchData', name, 1, function* (self: RObject, [key]) {
    const state = stateOf(self);
    const range = state.groups[yield* captureGroup(state, key)];
    return range ? BigInt(charIndex(state.text, range[side])) : NIL;
  });
}
def('MatchData', 'offset', 1, function* (self: RObject, [key]) {
  const state = stateOf(self);
  const range = state.groups[yield* captureGroup(state, key)];
  return range
    ? arr([BigInt(charIndex(state.text, range[0])), BigInt(charIndex(state.text, range[1]))])
    : arr([NIL, NIL]);
});

function* captureGroup(state: MatchState, key: Value): Gen<number> {
  if (key instanceof RString || key instanceof RSymbol) {
    const name = key instanceof RString ? key.s : key.name;
    const group = state.namedGroups[name];
    if (group === undefined) throw indexError(`undefined group name reference: ${name}`);
    return group;
  }
  const group = yield* toIndex(key);
  if (group < 0 || group >= state.groups.length) throw indexError(`index ${group} out of matches`);
  return group;
}
def('MatchData', ['size', 'length'], 0, (self: RObject) => BigInt(stateOf(self).groups.length));
def('MatchData', 'values_at', [0, -1], function* (self: RObject, args) {
  const values: Value[] = [];
  for (const arg of args) values.push(yield* matchIndex(self, arg));
  return arr(values);
});
def('MatchData', 'string', 0, (self: RObject) => str(stateOf(self).text));
def('MatchData', 'regexp', 0, (self: RObject) => stateOf(self).regexp);
def('MatchData', 'inspect', 0, (self: RObject) => {
  const state = stateOf(self);
  if (state.literal) {
    const range = state.groups[0] as readonly [number, number];
    return str(`#<MatchData: ${state.text.slice(range[0], range[1])}>`);
  }
  const parts = state.groups.map((range, group) => {
    const shown = range ? strInspect(state.text.slice(range[0], range[1])) : 'nil';
    if (group === 0) return shown;
    const name = state.names.find((candidate) => state.namedGroups[candidate] === group);
    return `${name ?? group}:${shown}`;
  });
  return str(`#<MatchData ${parts.join(' ')}>`);
});
def('MatchData', 'deconstruct', 0, (self: RObject) =>
  arr(
    stateOf(self)
      .groups.slice(1)
      .map((_range, group) => groupText(stateOf(self), group + 1))
  )
);
def('MatchData', 'deconstruct_keys', 1, function* (self: RObject, [keys]) {
  if (keys !== NIL && !(keys instanceof RArray))
    throw typeError(`wrong argument type ${realClassOf(keys).name} (expected Array)`);
  const state = stateOf(self);
  const hash = newHash();
  const requested = keys instanceof RArray ? keys.items : state.names.map((name) => sym(name));
  for (const key of requested) {
    if (!(key instanceof RSymbol)) throw typeError(`wrong argument type ${realClassOf(key).name} (expected Symbol)`);
    const group = state.namedGroups[key.name];
    if (group !== undefined) yield* hashSet(hash, key, groupText(state, group));
  }
  return hash;
});

// String's regular-expression forms ------------------------------------------------------------------------------------

/** Expands `\1`, `\k<name>`, `\0`, `\&`, `\\`, `` \` ``, and `\'` in a replacement string. */
function expand(replacement: string, state: MatchState, limit: number): string {
  const whole = state.groups[0] as readonly [number, number];
  const parts: string[] = [];
  let length = 0;
  const append = (part: string): void => {
    length += part.length;
    if (length > limit) throw new ExecutionLimitError('storage');
    rt().spend(Math.ceil(part.length / 256));
    parts.push(part);
  };
  let position = 0;
  for (const match of replacement.matchAll(/\\(k<(\w+)>|[0-9&\\`'])/g)) {
    append(replacement.slice(position, match.index));
    const [, code, name] = match;
    let part: string;
    if (name !== undefined) {
      const group = state.namedGroups[name];
      if (group === undefined) throw indexError(`undefined group name reference: ${name}`);
      const value = groupText(state, group);
      part = value === NIL ? '' : (value as RString).s;
    } else {
      switch (code) {
        case '&': {
          part = state.text.slice(whole[0], whole[1]);
          break;
        }
        case '\\': {
          part = '\\';
          break;
        }
        case '`': {
          part = state.text.slice(0, whole[0]);
          break;
        }
        case "'": {
          part = state.text.slice(whole[1]);
          break;
        }
        default: {
          const value = groupText(state, Number(code));
          part = value === NIL ? '' : (value as RString).s;
        }
      }
    }
    append(part);
    position = match.index + match[0].length;
  }
  append(replacement.slice(position));
  return parts.join('');
}

function* substituteRegexp(
  self: RString,
  regexp: RObject,
  replacement: Value | undefined,
  block: RProc | undefined,
  global: boolean
): Gen<{ text: string; matched: boolean }> {
  const text = self.s;
  const matches = global ? allMatches(regexp, text) : [execAt(regexp, text, 0)].filter((m): m is MatchState => !!m);
  const chunks: string[] = [];
  let length = 0;
  const append = (part: string): void => {
    length += part.length;
    if (length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
    rt().spend(Math.ceil(part.length / 256));
    chunks.push(part);
  };
  let position = 0;
  for (const state of matches) {
    const [from, to] = state.groups[0] as readonly [number, number];
    let piece: string;
    if (replacement instanceof RHash) {
      const entry = yield* hashGet(replacement, str(text.slice(from, to)));
      piece = yield* toS(entry ? entry.value : replacement.defaultValue);
    } else if (replacement !== undefined) {
      piece = expand(yield* toStr(replacement), state, LIMITS.maxStringLength - length - (from - position));
    } else {
      setLastMatch(state);
      piece = yield* toS(yield* callBlock(block as RProc, [str(text.slice(from, to))]));
    }
    append(text.slice(position, from));
    append(piece);
    position = to;
  }
  setLastMatch(matches.at(-1));
  append(text.slice(position));
  return { text: chunks.join(''), matched: matches.length > 0 };
}

function wrapFirst(
  name: string,
  handle: (self: RString, args: Value[], block: RProc | undefined, previous: NativeFn) => Gen | Value,
  anyRegexp = false
): void {
  extend('String', [name], (previous) => (self: RString, args, block, keywords) => {
    if (args.length > 0 && (anyRegexp ? args.some(isRegexp) : isRegexp(args[0])))
      return handle(self, args, block, previous);
    return previous(self, args, block, keywords);
  });
}

for (const [name, global, bang] of [
  ['sub', false, false],
  ['gsub', true, false],
  ['sub!', false, true],
  ['gsub!', true, true],
] as const) {
  wrapFirst(name, function* (self, args, block) {
    if (bang && self.frozen) throw frozenError(self, strInspect(self.s));
    if (args.length === 1 && !block) {
      if (global && !bang) return makeEnumerator(self, name, args);
      throw argumentError('wrong number of arguments (given 1, expected 2)');
    }
    const result = yield* substituteRegexp(self, args[0] as RObject, args[1], block, global);
    if (!bang) return str(result.text);
    if (!result.matched) return NIL;
    setText(self, result.text);
    return self;
  });
}
wrapFirst('scan', function* (self, args, block) {
  const matches = allMatches(args[0] as RObject, self.s);
  const values = matches.map((state) =>
    state.groups.length > 1
      ? arr(state.groups.slice(1).map((_range, group) => groupText(state, group + 1)))
      : groupText(state, 0)
  );
  if (!block) {
    setLastMatch(matches.at(-1));
    return arr(values);
  }
  for (const [index, value] of values.entries()) {
    setLastMatch(matches[index]);
    yield* callBlock(block, [value], false);
  }
  return self;
});
wrapFirst('split', function* (self, args) {
  const text = self.s;
  const limit = args.length > 1 ? yield* toIndex(args[1]) : 0;
  const parts: string[] = [];
  let fields = 0;
  let position = 0;
  let searchFrom = 0;
  const length = charIndex(text, text.length);
  while (searchFrom <= length) {
    if (limit > 0 && fields === limit - 1) break;
    const state = execAt(args[0] as RObject, text, searchFrom);
    if (!state) break;
    const [from, to] = state.groups[0] as readonly [number, number];
    if (from === to) {
      if (from >= text.length) break;
      if (from === position) {
        searchFrom = charIndex(text, from) + 1;
        if (position === 0 && from === 0) continue;
      }
    }
    if (!(from === to && from === position)) {
      parts.push(text.slice(position, from));
      fields++;
      for (let group = 1; group < state.groups.length; group++) {
        const value = groupText(state, group);
        if (value !== NIL) parts.push((value as RString).s);
      }
      position = to;
    }
    searchFrom = charIndex(text, to) + (from === to ? 1 : 0);
  }
  parts.push(text.slice(position));
  if (text.length === 0) return arr([]);
  if (limit === 0) while (parts.length > 0 && parts.at(-1) === '') parts.pop();
  return arr(parts.map((part) => str(part)));
});
for (const name of ['index', 'rindex'] as const) {
  wrapFirst(name, function* (self, args) {
    const regexp = args[0] as RObject;
    const length = charIndex(self.s, self.s.length);
    let start = args.length > 1 ? yield* toIndex(args[1]) : name === 'index' ? 0 : length;
    if (start < 0) start += length;
    if (start < 0 || start > length) return setLastMatch(undefined) && NIL;
    if (name === 'index') {
      const state = execAt(regexp, self.s, start);
      setLastMatch(state);
      return state ? BigInt(charIndex(self.s, (state.groups[0] as readonly [number, number])[0])) : NIL;
    }
    for (let position = start; position >= 0; position--) {
      const state = execAt(regexp, self.s, position);
      if (state && charIndex(self.s, (state.groups[0] as readonly [number, number])[0]) === position) {
        setLastMatch(state);
        return BigInt(position);
      }
    }
    setLastMatch(undefined);
    return NIL;
  });
}
for (const name of ['[]', 'slice'] as const) {
  wrapFirst(name, function* (self, args) {
    const state = execAt(args[0] as RObject, self.s, 0);
    setLastMatch(state);
    if (!state) return NIL;
    if (args.length > 1) return yield* matchIndex(setLastMatch(state) as RObject, args[1]);
    return groupText(state, 0);
  });
}
wrapFirst('slice!', function* (self, args) {
  if (self.frozen) throw frozenError(self, strInspect(self.s));
  const state = execAt(args[0] as RObject, self.s, 0);
  setLastMatch(state);
  if (!state) return NIL;
  const range = args.length > 1 ? yield* sliceCaptureRange(state, args[1]) : state.groups[0];
  if (range === 'unmatched') return str('');
  if (!range) return NIL;
  const [from, to] = range;
  const removed = str(self.s.slice(from, to));
  setText(self, self.s.slice(0, from) + self.s.slice(to));
  return removed;
});
function* sliceCaptureRange(state: MatchState, key: Value): Gen<readonly [number, number] | 'unmatched' | undefined> {
  if (key instanceof RString || key instanceof RSymbol) {
    const name = key instanceof RString ? key.s : key.name;
    const group = state.namedGroups[name];
    if (group === undefined) throw indexError(`undefined group name reference: ${name}`);
    return state.groups[group] ?? 'unmatched';
  }
  let group = yield* toIndex(key);
  if (group < 0) group += state.groups.length;
  return group >= 0 && group < state.groups.length ? (state.groups[group] ?? 'unmatched') : undefined;
}
wrapFirst(
  'start_with?',
  function* (self, args, block, previous) {
    for (const arg of args) {
      if (isRegexp(arg)) {
        const state = execAt(arg, self.s, 0);
        const prefix = state && (state.groups[0] as readonly [number, number])[0] === 0 ? state : undefined;
        setLastMatch(prefix);
        if (prefix) {
          return true;
        }
      } else if (truthy((yield* asGen(previous(self, [arg], block, undefined))) as Value)) {
        return true;
      }
    }
    return false;
  },
  true
);
for (const [name, last] of [
  ['partition', false],
  ['rpartition', true],
] as const) {
  wrapFirst(name, function* (self, args) {
    const matches = allMatches(args[0] as RObject, self.s);
    const state = last ? matches.at(-1) : matches[0];
    setLastMatch(state);
    if (!state) return last ? arr([str(''), str(''), str(self.s)]) : arr([str(self.s), str(''), str('')]);
    const [from, to] = state.groups[0] as readonly [number, number];
    yield* [];
    return arr([str(self.s.slice(0, from)), str(self.s.slice(from, to)), str(self.s.slice(to))]);
  });
}

function* asGen(value: Gen | Value): Gen {
  if (typeof value === 'object' && value !== null && Symbol.iterator in value && 'next' in value)
    return yield* value as Gen;
  return value as Value;
}

def('String', '=~', 1, function* (self: RString, [pattern]) {
  if (pattern instanceof RString) throw typeError('type mismatch: String given');
  if (!isRegexp(pattern)) {
    return yield* callMethod(pattern, '=~', [self]);
  }
  const state = execAt(pattern, self.s, 0);
  setLastMatch(state);
  return state ? BigInt(charIndex(self.s, (state.groups[0] as readonly [number, number])[0])) : NIL;
});
def('NilClass', '=~', 1, () => setLastMatch(undefined));
def('Symbol', '=~', 1, function* (self: RSymbol, [pattern]) {
  return yield* callMethod(str(self.name), '=~', [pattern]);
});

function* asRegexp(pattern: Value): Gen<RObject> {
  if (isRegexp(pattern)) return pattern;
  return makeRegexp(yield* toStr(pattern), {});
}

def('String', 'match', [1, 2], function* (self: RString, args, block) {
  const regexp = yield* asRegexp(args[0]);
  const start = args.length > 1 ? yield* toIndex(args[1]) : 0;
  const match = setLastMatch(execAt(regexp, self.s, start < 0 ? start + charIndex(self.s, self.s.length) : start));
  if (block && match !== NIL) return yield* callBlock(block, [match]);
  return match;
});
def('String', 'match?', [1, 2], function* (self: RString, args) {
  const regexp = yield* asRegexp(args[0]);
  const start = args.length > 1 ? yield* toIndex(args[1]) : 0;
  return execAt(regexp, self.s, start < 0 ? start + charIndex(self.s, self.s.length) : start) !== undefined;
});
for (const name of ['=~', 'match', 'match?']) {
  def('Symbol', name, [1, 2], (self: RSymbol, args, block) => callMethod(str(self.name), name, args, undefined, block));
}

export { inspect, rEquals, sym };
