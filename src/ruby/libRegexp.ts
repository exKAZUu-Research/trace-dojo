import vm from 'node:vm';

import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import {
  addressOf,
  className,
  combinedStringEncoding,
  inspect,
  rEquals,
  strInspect,
  toIndex,
  toStrValue,
  toSValue,
  tryImplicitConversion,
} from './conversions';
import { coreMethod, def, extend, sdef, sundef } from './define';
import { argumentError, frozenError, indexError, rubyError, typeError } from './errors';
import { validateKeywords } from './exceptionOption';
import { digest, hashDefault, hashGet, hashSet, stringKeyEquals, stringKeyHash } from './hashes';
import { callBlock, callMethod, type Gen, invoke } from './interp';
import { tryAry } from './libArray';
import { validStringEncoding } from './libEncoding';
import { makeEnumerator } from './libEnumerator';
import {
  copyStringEncoding,
  inspectStringEncoding,
  setBytes,
  sliceStringEncoding,
  symbolString,
  textByteLengthOf,
} from './libString';
import {
  type NativeFn,
  NIL,
  RArray,
  type RClass,
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
import { RegexpCursor } from './regexpCursor';
import { decodeRegexpByteEscape, regexpByteEscape, RegexpEncodingError } from './regexpEscapes';
import { charIndex, regexpByteIndex, unitIndex } from './regexpPositions';
import {
  hasRegexpProperty,
  regexpSyntaxReason,
  supportsRegexpByteView,
  validateRegexpStructure,
  validateSourceRanges,
} from './regexpStructure';
import { type Frame, rt, UnsupportedFeatureError } from './runtime';
import { arr, asciiString, newHash, realClassOf, str, stringBytes, stringFromBytes, sym, truthy } from './values';

// oxlint-disable-next-line unicorn/text-encoding-identifier-case -- Ruby exposes the canonical name with a hyphen and uppercase letters.
const RUBY_UTF8 = 'UTF-8';

export interface RegexpData {
  source: string;
  encoding: 'US-ASCII' | typeof RUBY_UTF8 | 'BINARY (ASCII-8BIT)';
  ignoreCase: boolean;
  multiline: boolean;
  extended: boolean;
  /** The translated expression; its `lastIndex` is set before each use. */
  js: RegExp;
  binaryJs?: RegExp;
  byteViewSafe?: boolean;
  safeNative: boolean;
  captureNames?: string[];
  foldCheck?: { text: string; unsupported: boolean };
  reverseSticky?: RegExp;
  binaryReverseSticky?: RegExp;
  context?: vm.Context;
  binaryContext?: vm.Context;
  reverseContext?: vm.Context;
  binaryReverseContext?: vm.Context;
}

const MATCH_SCRIPT = new vm.Script('regexp.exec(input)');

const POSIX_CLASSES: Record<string, string> = {
  alpha: String.raw`\p{Alphabetic}`,
  digit: String.raw`\p{Nd}`,
  alnum: String.raw`\p{Alphabetic}\p{Nd}`,
  upper: String.raw`\p{Uppercase}`,
  lower: String.raw`\p{Lowercase}`,
  space: String.raw`\p{White_Space}`,
  punct: String.raw`\p{P}\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E`,
  xdigit: '0-9A-Fa-f',
  word: String.raw`\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\u200C\u200D`,
  cntrl: String.raw`\p{Cc}`,
  print: String.raw`\p{L}\p{M}\p{N}\p{P}\p{S}\p{Cf}\p{Co}\p{Zs}`,
  graph: String.raw`\p{L}\p{M}\p{N}\p{P}\p{S}\p{Cf}\p{Co}`,
  blank: String.raw`\p{Zs}\t`,
};

const ASCII_POSIX_CLASSES: Record<string, string> = {
  ascii: String.raw`\x00-\x7F`,
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: 'A-Za-z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: String.raw` \t\n\v\f\r`,
  punct: String.raw`\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E`,
  xdigit: '0-9A-Fa-f',
  word: 'A-Za-z0-9_',
  cntrl: String.raw`\x00-\x1F\x7F`,
  print: String.raw`\x20-\x7E`,
  graph: String.raw`\x21-\x7E`,
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
  upper: 'Uppercase',
  lower: 'Lowercase',
  space: 'White_Space',
  word: 'Word',
  punct: 'P',
};

interface RegexpOptions {
  ignoreCase?: boolean;
  multiline?: boolean;
  extended?: boolean;
  sourceBinary?: boolean;
  fixedEncoding?: boolean;
}

const SYNTAX = String.raw`^$\.*+?()[]{}|/-`;

function unicodeRegexpEscape(source: string): { points: string[]; length: number } | undefined {
  const braced = /^\{[ \t\n\r\v\f]*([0-9a-fA-F]{1,6}(?:[ \t\n\r\v\f]+[0-9a-fA-F]{1,6})*)[ \t\n\r\v\f]*\}/.exec(source);
  if (braced) {
    const points = braced[1].split(/[ \t\n\r\v\f]+/);
    if (
      points.some((point) => {
        const value = Number.parseInt(point, 16);
        return value > 0x10_ff_ff || (value >= 0xd8_00 && value <= 0xdf_ff);
      })
    )
      throw new SyntaxError('invalid Unicode codepoint');
    return { points, length: braced[0].length };
  }
  const fixed = /^[0-9a-fA-F]{4}/.exec(source);
  if (!fixed) return undefined;
  const value = Number.parseInt(fixed[0], 16);
  if (value >= 0xd8_00 && value <= 0xdf_ff) throw new SyntaxError('invalid Unicode codepoint');
  return { points: [fixed[0]], length: fixed[0].length };
}

/** Translates a Ruby (Onigmo) expression into JavaScript's syntax, rejecting what has no counterpart. */
export function translate(
  source: string,
  extended: boolean,
  multiline = false,
  dynamic = false,
  ascii = false,
  ignoreCase = false
): string {
  validateSourceRanges(source, extended);
  const classes = ascii ? ASCII_POSIX_CLASSES : POSIX_CLASSES;
  for (const name of captureNamesForValidation(source, extended))
    if ((/^[\p{ID_Start}_]/u.test(name) || /^\\u(?:[\dA-Fa-f]{4}|\{[\dA-Fa-f]+\})/.test(name)) && /[-\\]/.test(name))
      throw unsupportedSyntax('特殊なキャプチャ名');
  let out = '';
  let inClass = 0;
  let classStart = 0;
  let classAlternatives: string[] = [];
  let atomStart = 0;
  const groupStarts: number[] = [];
  const dotallStack: boolean[] = [];
  const casefoldStack: boolean[] = [];
  let dotall = multiline;
  let casefold = ignoreCase;
  const namedCaptures = regexpCaptureNames(source, extended).length > 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (extended && inClass === 0) {
      if (/[ \t\n\r\f]/.test(char)) continue;
      if (char === '#') {
        index = regexpLineCommentEnd(source, index);
        continue;
      }
    }
    if (char === '\\') {
      if (index === source.length - 1) throw new SyntaxError('trailing regexp escape');
      if (inClass === 0) atomStart = out.length;
      const next = source[++index] ?? '\\';
      const byteEscape =
        next === 'x' ||
        (inClass > 0 && /^[0-7]$/.test(next)) ||
        next === '0' ||
        (/^[1-7]$/.test(next) && /^[0-7]/.test(source.slice(index + 1)))
          ? regexpByteEscape(source, index - 1)
          : undefined;
      if (byteEscape) {
        const decoded = ascii ? byteEscape : decodeRegexpByteEscape(source, index - 1, byteEscape);
        out += `\\u{${decoded.value.toString(16)}}`;
        index += decoded.length - 2;
        continue;
      }
      if (inClass > 0 && /^[89]$/.test(next)) {
        out += next;
        continue;
      }
      if (next === 'u') {
        const escape = unicodeRegexpEscape(source.slice(index + 1));
        if (escape) {
          for (const [position, point] of escape.points.entries()) {
            if (inClass === 0 && position === escape.points.length - 1) atomStart = out.length;
            out += `\\u{${point}}`;
          }
          index += escape.length;
          continue;
        }
      }
      if (next === 'c' && /^[A-Za-z]/.test(source[index + 1] ?? '')) {
        out += `\\x${(source[index + 1].toUpperCase().codePointAt(0)! & 31).toString(16).padStart(2, '0')}`;
        index++;
        continue;
      }
      out += translateEscape(
        next,
        source,
        index,
        inClass > 0,
        (count) => {
          index += count;
        },
        (body, negate = true, noCasefold = false) => {
          const atom = noCasefold ? `(?-i:[${body}])` : `[${body}]`;
          classAlternatives.push(negate ? `(?:(?!${atom})[\\s\\S])` : atom);
        },
        classes,
        casefold
      );
      continue;
    }
    if (char === '[') {
      const posix = /^\[:(\^?)(\w+):\]/.exec(source.slice(index));
      if (inClass > 0 && posix) {
        const body = classes[posix[2]];
        if (!body) throw unsupportedSyntax(`[:${posix[2]}:]`);
        if (posix[1]) {
          if (casefold && (posix[2] === 'lower' || posix[2] === 'upper'))
            out += classes === ASCII_POSIX_CLASSES ? String.raw`\x00-\xFF` : String.raw`\s\S`;
          else classAlternatives.push(`(?:(?![${body}])[\\s\\S])`);
        } else out += body;
        index += posix[0].length - 1;
        continue;
      }
      if (inClass > 0) {
        throw unsupportedSyntax('入れ子の文字クラス');
      }
      atomStart = out.length;
      classStart = out.length;
      classAlternatives = [];
      inClass++;
      out += char;
      continue;
    }
    if (char === ']' && inClass > 0) {
      if (out.length === classStart + 1 && classAlternatives.length === 0) {
        if (dynamic && source.includes(']', index + 1)) {
          out += String.raw`\]`;
          continue;
        }
        throw new SyntaxError('empty char-class');
      }
      if (out.slice(classStart + 1) === '^' && classAlternatives.length === 0) {
        out += String.raw`\]`;
        continue;
      }
      inClass--;
      if (classAlternatives.length > 0) {
        const regularBody = out.slice(classStart + 1);
        const outerNegated = regularBody.startsWith('^');
        const literalBody = outerNegated ? regularBody.slice(1) : regularBody;
        const alternatives = [...(literalBody ? [`[${literalBody}]`] : []), ...classAlternatives];
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
        casefoldStack.push(casefold);
        if (enabled.includes('m')) dotall = true;
        if (disabled.includes('m')) dotall = false;
        if (enabled.includes('i')) casefold = true;
        if (disabled.includes('i')) casefold = false;
        out += on || off ? `(?${on}${off ? `-${off}` : ''}:` : '(?:';
        index += scoped[0].length + 1;
        continue;
      }
      if (/^[imx-]+[:)]/.test(rest)) throw unsupportedSyntax('中のオプションの指定（(?i) など）');
      if (rest.startsWith('#')) {
        const end = regexpCommentEnd(source, index + 3);
        if (end === -1) throw new SyntaxError('end pattern in group');
        index = end;
        continue;
      }
    }
    if (inClass === 0 && char === '(' && source[index + 1] !== '?' && namedCaptures) {
      groupStarts.push(out.length);
      dotallStack.push(dotall);
      casefoldStack.push(casefold);
      out += '(?:';
      continue;
    }
    if (inClass === 0 && char === '(') {
      groupStarts.push(out.length);
      dotallStack.push(dotall);
      casefoldStack.push(casefold);
    }
    if (inClass === 0 && char === ')') {
      atomStart = groupStarts.pop() ?? out.length;
      dotall = dotallStack.pop() ?? multiline;
      casefold = casefoldStack.pop() ?? ignoreCase;
    }
    if (inClass === 0 && char === '{') {
      const interval = /^\{(?:\d+(?:,\d*)?|,\d+)\}/.exec(source.slice(index));
      if (interval) {
        const reluctant = interval[0].includes(',') && source[index + interval[0].length] === '?';
        const quantified = out.slice(atomStart) + interval[0].replace('{,', '{0,') + (reluctant ? '?' : '');
        const length = interval[0].length + (reluctant ? 1 : 0);
        const next = source[index + length];
        const repeated = next !== undefined && '*+?{'.includes(next);
        out = `${out.slice(0, atomStart)}${repeated ? `(?:${quantified})` : quantified}`;
        index += length - 1;
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
  validateRegexpStructure(out, source, extended);
  return out;
}

function* captureNamesForValidation(source: string, extended: boolean): Generator<string> {
  let start = -1;
  let inClass = false;
  for (let index = 0; index < source.length; index++) {
    if (start >= 0) {
      if (source[index] === '>') {
        if (index > start) yield source.slice(start, index);
        start = -1;
      }
      continue;
    }
    if (source[index] === '\\') {
      index++;
      continue;
    }
    if (!inClass && source.startsWith('(?#', index)) {
      index = regexpCommentEnd(source, index + 3);
      if (index < 0) break;
      continue;
    }
    if (extended && !inClass && source[index] === '#') {
      index = regexpLineCommentEnd(source, index);
      continue;
    }
    if (source[index] === '[') inClass = true;
    else if (source[index] === ']') inClass = false;
    else if (!inClass && source.startsWith('(?<', index)) start = index + 3;
  }
}

function translateEscape(
  next: string,
  source: string,
  index: number,
  inClass: boolean,
  skip: (count: number) => void,
  addNegatedClass: (body: string, negate?: boolean, noCasefold?: boolean) => void,
  classes: Record<string, string>,
  casefold: boolean
): string {
  if (inClass && 'AzZR'.includes(next)) return next;
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
      if (inClass) throw unsupportedClassEscape(String.raw`\H`);
      return '[^0-9a-fA-F]';
    }
    case 'w': {
      if (inClass && casefold) {
        addNegatedClass('A-Za-z0-9_', false, true);
        return '';
      }
      return inClass ? 'A-Za-z0-9_' : casefold ? '(?-i:[A-Za-z0-9_])' : '[A-Za-z0-9_]';
    }
    case 'W': {
      if (inClass && casefold) {
        addNegatedClass('A-Za-z0-9_', true, true);
        return '';
      }
      if (inClass) {
        addNegatedClass('A-Za-z0-9_');
        return '';
      }
      return casefold ? String.raw`(?:(?!(?-i:[A-Za-z0-9_]))[\s\S])` : '[^A-Za-z0-9_]';
    }
    case 'G': {
      throw unsupportedSyntax(String.raw`\G`);
    }
    case 'b': {
      if (inClass) return String.raw`\b`;
      const word = `[${classes.word}]`;
      return `(?:(?<=${word})(?!${word})|(?<!${word})(?=${word}))`;
    }
    case 'B': {
      if (inClass) throw unsupportedClassEscape(String.raw`\B`);
      const word = `[${classes.word}]`;
      return `(?:(?<=${word})(?=${word})|(?<!${word})(?!${word}))`;
    }
    case 'R': {
      return String.raw`(?:\r\n|\r(?!\n)|[\n\v\f\u0085  ])`;
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
      if (inClass) throw unsupportedClassEscape(String.raw`\S`);
      return String.raw`[^ \t\r\n\f\v]`;
    }
    case 'p':
    case 'P': {
      const property = /^\{(\^?)(\w+)\}/.exec(source.slice(index + 1));
      if (!property) return `\\${next}`;
      const rawName = property[2];
      const key = rawName.toLowerCase();
      skip(property[0].length);
      const negated = (next === 'P') !== (property[1] === '^');
      const body =
        classes !== ASCII_POSIX_CLASSES && (key === 'punct' || key === 'upper' || key === 'lower')
          ? undefined
          : classes[key];
      if (classes === ASCII_POSIX_CLASSES && body === undefined)
        throw new RegexpEncodingError(`invalid character property name {${rawName}}`);
      if (body !== undefined) {
        if (inClass && negated) {
          if (classes === ASCII_POSIX_CLASSES && casefold && (key === 'lower' || key === 'upper'))
            return String.raw`\x00-\xFF`;
          addNegatedClass(body);
          return '';
        }
        return inClass ? body : `[${negated ? '^' : ''}${body}]`;
      }
      let name = PROPERTY_NAMES[key] ?? rawName;
      if (name === rawName) {
        try {
          new RegExp(`\\p{${name}}`, 'u');
        } catch {
          const script = `${rawName[0].toUpperCase()}${rawName.slice(1).toLowerCase()}`;
          try {
            new RegExp(`\\p{Script=${script}}`, 'u');
            name = `Script=${script}`;
          } catch {
            throw unsupportedSyntax(`Unicode プロパティ ${rawName}`);
          }
        }
      }
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

function unsupportedClassEscape(escape: string): unknown {
  return unsupportedSyntax(`文字クラス内の${escape}`);
}

// code-gauge-allow functionCognitiveComplexity 26 -- Encoding checks, syntax diagnostics, and host compilation preserve distinct Ruby errors.
export function makeRegexp(source: string, options: RegexpOptions): RObject {
  const display = `/${source}/${regexpSuffix(options)}`;
  rt().spend(Math.ceil(source.length / 64));
  if (((/\\+$/.exec(source)?.[0].length ?? 0) & 1) === 1)
    throw rubyError(rt().c.RegexpError, `too short escape sequence: ${display}`);
  if (regexpCaptureNames(source, options.extended).length > 0 && regexpHasNumberedBackref(source, options.extended))
    throw rubyError(rt().c.RegexpError, `numbered backref/call is not allowed. (use name): ${display}`);
  const regexp = new RObject(rt().c.Regexp);
  let translated: string;
  let encoding: RegexpData['encoding'];
  try {
    encoding =
      options.fixedEncoding ||
      /[^\u0000-\u007F]/.test(source) ||
      hasNonAsciiRegexpEscape(source, options.extended ?? false) ||
      hasRegexpProperty(source, options.extended ?? false)
        ? options.sourceBinary
          ? 'BINARY (ASCII-8BIT)'
          : RUBY_UTF8
        : 'US-ASCII';
    translated = translate(
      source,
      options.extended ?? false,
      options.multiline ?? false,
      true,
      encoding === 'BINARY (ASCII-8BIT)',
      options.ignoreCase
    );
  } catch (error) {
    if (error instanceof SyntaxError && error.message === 'invalid pattern in look-behind')
      throw rubyError(rt().c.RegexpError, `${error.message}: ${display}`);
    if (error instanceof RegexpEncodingError) throw rubyError(rt().c.RegexpError, `${error.message}: ${display}`);
    if (error instanceof SyntaxError)
      throw rubyError(
        rt().c.RegexpError,
        `${error.message === 'empty char-class' ? error.message : regexpSyntaxReason(source, options.extended)}: ${display}`
      );
    throw error;
  }
  let js: RegExp;
  try {
    js = new RegExp(translated, `dgmu${options.ignoreCase ? 'i' : ''}${options.multiline ? 's' : ''}`);
  } catch {
    const names = regexpCaptureNames(source, options.extended);
    if (new Set(names).size !== names.length) throw new UnsupportedFeatureError('重複する名前付きキャプチャ');
    throw rubyError(rt().c.RegexpError, `${regexpSyntaxReason(source, options.extended)}: ${display}`);
  }
  const data: RegexpData = {
    source,
    encoding,
    ignoreCase: options.ignoreCase ?? false,
    multiline: options.multiline ?? false,
    extended: options.extended ?? false,
    js,
    safeNative: triviallyLinearRegexp(source),
  };
  regexp.data = data;
  return regexp;
}

function hasNonAsciiRegexpEscape(source: string, extended: boolean): boolean {
  let inClass = false;
  for (let index = 0; index < source.length; index++) {
    if (!inClass && source.startsWith('(?#', index)) {
      index = regexpCommentEnd(source, index + 3);
      if (index < 0) break;
      continue;
    }
    const posixLength = inClass ? (/^\[:\^?\w+:\]/.exec(source.slice(index))?.[0].length ?? 0) : 0;
    if (posixLength > 0) {
      index += posixLength - 1;
      continue;
    }
    if (source[index] === '[') inClass = true;
    if (source[index] === ']') inClass = false;
    if (extended && !inClass && source[index] === '#') {
      index = regexpLineCommentEnd(source, index);
      continue;
    }
    if (source[index] !== '\\') continue;
    if (nonAsciiRegexpEscapeAt(source, index)) return true;
    index++;
  }
  return false;
}

function nonAsciiRegexpEscapeAt(source: string, index: number): boolean {
  const escape = source[index + 1];
  if (escape === 'u') {
    const unicode = unicodeRegexpEscape(source.slice(index + 2));
    return unicode?.points.some((point) => Number.parseInt(point, 16) > 127) ?? false;
  }
  if ((escape === 'p' || escape === 'P') && /^\{\^?\w+\}/.test(source.slice(index + 2))) return true;
  return (regexpByteEscape(source, index)?.value ?? 0) > 127;
}

export function normalizeSlashLiteralSource(source: string): string {
  return source.replaceAll(/(\\+)\//g, (_match, slashes: string) =>
    slashes.length % 2 === 1 ? `${slashes.slice(0, -1)}/` : `${slashes}/`
  );
}

// code-gauge-allow functionCognitiveComplexity 28 -- Native execution is permitted only after excluding every construct that can introduce costly backtracking.
// code-gauge-allow functionNcss 35 -- The classifier scans once while tracking classes, groups, alternatives, and quantifiers.
function triviallyLinearRegexp(source: string): boolean {
  let inClass = false;
  let quantifier = -1;
  let alternation = false;
  let grouped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') {
      const next = source[++index];
      if (next && /[1-9kg]/.test(next)) return false;
      continue;
    }
    if (char === '[') {
      inClass = true;
      continue;
    }
    if (char === ']') {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (char === '{' || (char === '(' && source[index + 1] === '?')) return false;
    alternation ||= char === '|';
    grouped ||= char === '(';
    if (!'*+?'.includes(char)) continue;
    if (quantifier >= 0) return false;
    quantifier = index;
  }
  if (quantifier < 0) return !alternation || !grouped;
  if (alternation) return false;
  const tail = source.slice(quantifier + 1).replaceAll(')', '');
  return (
    tail === '' ||
    ((tail === '$' || tail === String.raw`\z`) && (source.startsWith('^') || source.startsWith(String.raw`\A`)))
  );
}

export function isRegexp(value: Value): value is RObject {
  return value instanceof RObject && value.cls.isSubclassOf(rt().c.Regexp);
}

function dataOf(regexp: RObject): RegexpData {
  if (!regexp.data) throw typeError('uninitialized Regexp');
  return regexp.data as RegexpData;
}

// Matching -------------------------------------------------------------------------------------------------------------

export interface MatchState {
  text: string;
  snapshot?: RString;
  literal?: boolean;
  groups: (readonly [number, number] | undefined)[];
  byteView?: { groups: (readonly [number, number] | undefined)[]; bytes: Uint8Array };
  names: string[];
  namedGroups: Record<string, number>;
  regexp: RObject;
}

// code-gauge-allow functionCognitiveComplexity 25 -- Match execution retains encoding, bounded forward/reverse searches and numbered/named capture state.
// code-gauge-allow functionParameterCount 7 -- Search callers select shared subject state, validation and anchoring without rebuilding snapshots.
export function execAt(
  regexp: RObject,
  text: string,
  start: number,
  source?: RString,
  snapshot?: RString,
  validated = false,
  anchored = false
): MatchState | undefined {
  if (start < 0 || start > charIndex(text, text.length)) return undefined;
  const data = dataOf(regexp);
  if (source && !validated) validateRegexpSubject(regexp, source);
  if (data.ignoreCase) {
    if (data.foldCheck?.text !== text)
      data.foldCheck = { text, unsupported: requiresMultiCharacterFold(data.source, text) };
    if (data.foldCheck.unsupported) throw new UnsupportedFeatureError('Unicode の複数文字 casefold');
  }
  const binaryMatch = source?.binary === true && data.encoding === 'US-ASCII';
  const js = regexpForMatch(data, source, anchored);
  rt().spend();
  const startUnit = unitIndex(text, start);
  js.lastIndex = startUnit;
  const result =
    data.safeNative || (text.length <= 8 && data.source.length <= 16)
      ? js.exec(text)
      : execWithinBudget(data, js, text, binaryMatch, anchored);
  const work =
    anchored && data.safeNative
      ? Math.max(1, result ? (result.indices?.[0]?.[1] ?? startUnit) - startUnit : 1)
      : (result?.index ?? text.length) - startUnit;
  rt().spend(Math.ceil(work / 64));
  if (!result?.indices) return undefined;
  const names: string[] = [];
  const namedGroups: Record<string, number> = Object.create(null) as Record<string, number>;
  const nameOrder = (data.captureNames ??= regexpCaptureNames(js.source));
  for (const [position, name] of nameOrder.entries()) {
    if (!(name in namedGroups)) names.push(name);
    if (!(name in namedGroups) || result.indices[position + 1] !== undefined) namedGroups[name] = position + 1;
  }
  return {
    text,
    snapshot: snapshot ?? (source ? matchSnapshot(source) : undefined),
    groups: [...result.indices],
    names,
    namedGroups,
    regexp,
  };
}

function execWithinBudget(
  data: RegexpData,
  js: RegExp,
  text: string,
  binaryMatch: boolean,
  anchored: boolean
): RegExpExecArray | null {
  const remaining = rt().budget.remainingMilliseconds;
  if (remaining === 0) throw new ExecutionLimitError('time');
  const context = anchored
    ? binaryMatch
      ? (data.binaryReverseContext ??= vm.createContext({ regexp: js, input: text }))
      : (data.reverseContext ??= vm.createContext({ regexp: js, input: text }))
    : binaryMatch
      ? (data.binaryContext ??= vm.createContext({ regexp: js, input: text }))
      : (data.context ??= vm.createContext({ regexp: js, input: text }));
  context.input = text;
  try {
    return MATCH_SCRIPT.runInContext(context, { timeout: remaining }) as RegExpExecArray | null;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT')
      throw new ExecutionLimitError('time');
    throw error;
  }
}

function regexpForMatch(data: RegexpData, source?: RString, anchored = false): RegExp {
  const binary = source?.binary && data.encoding === 'US-ASCII';
  const base = binary
    ? (data.binaryJs ??= new RegExp(
        translate(data.source, data.extended, data.multiline, true, true, data.ignoreCase),
        data.js.flags
      ))
    : data.js;
  if (!anchored) return base;
  return binary
    ? (data.binaryReverseSticky ??= new RegExp(base.source, base.flags.replace('g', 'y')))
    : (data.reverseSticky ??= new RegExp(base.source, base.flags.replace('g', 'y')));
}

export function validateRegexpByteView(regexp: RObject): void {
  const data = dataOf(regexp);
  data.byteViewSafe ??= !data.ignoreCase && supportsRegexpByteView(data.source, data.extended);
  if (!data.byteViewSafe) throw new UnsupportedFeatureError('UTF-8 の文字途中からの文脈依存の正規表現検索');
}

export function validateRegexpSubject(regexp: RObject, source: RString): void {
  if (!validStringEncoding(source))
    throw argumentError(`invalid byte sequence in ${source.usAscii ? 'US-ASCII' : RUBY_UTF8}`);
  const data = dataOf(regexp);
  if (data.encoding === 'US-ASCII' || !stringBytes(source).some((byte) => byte >= 0x80)) return;
  const subjectEncoding = source.binary ? 'BINARY (ASCII-8BIT)' : source.usAscii ? 'US-ASCII' : RUBY_UTF8;
  if (data.encoding !== subjectEncoding)
    throw rubyError(
      rt().c['Encoding::CompatibilityError'],
      `incompatible encoding regexp match (${data.encoding} regexp with ${subjectEncoding} string)`
    );
}

function requiresMultiCharacterFold(source: string, text: string): boolean {
  if ([...source].some((char) => char.toUpperCase().length > char.length || char.toLowerCase().length > char.length))
    return true;
  const upperSource = source.toUpperCase();
  return [...text].some((char) => {
    const expanded = char.toUpperCase();
    return expanded.length > char.length && upperSource.includes(expanded);
  });
}

function matchData(state: MatchState): RObject {
  state.snapshot ??= str(state.text);
  const original = state.snapshot;
  if (!original.frozen) {
    const snapshot = new RString(original.cls, original.s);
    snapshot.binary = original.binary;
    snapshot.usAscii = original.usAscii;
    snapshot.rawBytes = original.rawBytes;
    snapshot.frozen = true;
    state.snapshot = snapshot;
  }
  const match = new RObject(rt().c.MatchData);
  match.data = {
    ...state,
    held: () => [state.regexp, state.snapshot ?? NIL],
  };
  return match;
}

export function matchSnapshot(source: RString): RString {
  if (source.frozen) return source;
  const snapshot = new RString(source.cls, source.s);
  snapshot.binary = source.binary;
  snapshot.usAscii = source.usAscii;
  snapshot.rawBytes = source.rawBytes;
  return snapshot;
}

function stateOf(match: RObject): MatchState {
  return match.data as MatchState;
}

function groupText(state: MatchState, group: number): Value {
  if (state.byteView) {
    const range = state.byteView.groups[group];
    return range ? byteViewSlice(state, range[0], range[1]) : NIL;
  }
  const range = state.groups[group];
  return range ? sliceStringEncoding(state.snapshot ?? str(state.text), range[0], range[1]) : NIL;
}

function matchPrefix(state: MatchState): RString {
  return state.byteView
    ? byteViewSlice(state, 0, state.byteView.groups[0]![0])
    : sliceStringEncoding(state.snapshot ?? str(state.text), 0, state.groups[0]![0]);
}

function matchSuffix(state: MatchState): RString {
  return state.byteView
    ? byteViewSlice(state, state.byteView.groups[0]![1])
    : sliceStringEncoding(state.snapshot ?? str(state.text), state.groups[0]![1]);
}

function byteViewSlice(state: MatchState, from: number, to?: number): RString {
  const snapshot = state.snapshot!;
  return stringFromBytes(state.byteView!.bytes.subarray(from, to), snapshot.binary, snapshot.usAscii);
}

function matchByteRanges(state: MatchState): (readonly [number, number] | undefined)[] {
  if (state.byteView) return state.byteView.groups;
  const source = state.snapshot ?? str(state.text);
  return state.groups.map((range) => range && [regexpByteIndex(source, range[0]), regexpByteIndex(source, range[1])]);
}

/** Sets `$~` for the method frame that called a matching method, as Ruby keeps it per frame. */
export function setLastMatch(state: MatchState | undefined): Value {
  const frame = callerFrame();
  const match = state ? matchData(state) : NIL;
  frame.extra.lastMatch = match;
  return match;
}

export function setLiteralMatch(source: RString, text: string, target: string, from: number): MatchState | undefined {
  if (from < 0) {
    setLastMatch(undefined);
    return undefined;
  }
  const state: MatchState = {
    text,
    snapshot: matchSnapshot(source),
    literal: true,
    groups: [[from, from + target.length]],
    names: [],
    namedGroups: Object.create(null) as Record<string, number>,
    regexp: makeRegexp(escapeRegexpSource(target), { sourceBinary: source.binary }),
  };
  setLastMatch(state);
  return state;
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
  switch (name) {
    case '$&': {
      return groupText(state, 0);
    }
    case '$`': {
      return matchPrefix(state);
    }
    case "$'": {
      return matchSuffix(state);
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
function allMatches(regexp: RObject, source: RString): MatchState[] {
  const matches: MatchState[] = [];
  const snapshot = matchSnapshot(source);
  validateRegexpSubject(regexp, source);
  let start = 0;
  const text = source.s;
  const length = charIndex(text, text.length);
  while (start <= length) {
    const state = execAt(regexp, text, start, source, snapshot, true);
    if (!state) break;
    matches.push(state);
    const [from, to] = state.groups[0] as readonly [number, number];
    start = charIndex(text, to) + (from === to ? 1 : 0);
  }
  return matches;
}

// Regexp ---------------------------------------------------------------------------------------------------------------

function* optionsOf(value: Value | undefined): Gen<RegexpOptions> {
  if (value === undefined || value === NIL || value === false)
    return { ignoreCase: false, multiline: false, extended: false };
  if (typeof value === 'bigint') {
    if ((value & 32n) !== 0n) throw new UnsupportedFeatureError('正規表現の no encoding モード');
    return {
      fixedEncoding: (value & 16n) !== 0n,
      ignoreCase: (value & 1n) !== 0n,
      extended: (value & 2n) !== 0n,
      multiline: (value & 4n) !== 0n,
    };
  }
  if (value instanceof RString) {
    if (/[^imx]/.test(value.s)) throw argumentError(`unknown regexp option: ${value.s}`);
    return { ignoreCase: value.s.includes('i'), multiline: value.s.includes('m'), extended: value.s.includes('x') };
  }
  yield* [];
  return { ignoreCase: true, multiline: false, extended: false };
}

function invalidPatternMessage(pattern: RString, options: RegexpOptions): RString {
  const source = stringBytes(pattern);
  const result = new Uint8Array(LIMITS.maxStringLength);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let length = 0;
  const appendByte = (byte: number): void => {
    rt().checkStringLength(length + 1);
    result[length++] = byte;
  };
  const appendAscii = (text: string): void => {
    for (const char of text) appendByte(char.codePointAt(0) ?? 0);
  };
  appendAscii('invalid multibyte character: /');
  rt().spend(Math.ceil(source.length / 256));
  for (let index = 0; index < source.length;) {
    const first = source[index];
    if (first === 92) {
      appendByte(first);
      index++;
      if (source[index] === 92) {
        appendByte(92);
        index++;
        continue;
      }
      if ((source[index] ?? 0) < 0x80) continue;
      const escaped = source[index];
      let count = 1;
      if (!pattern.usAscii) {
        const width = escaped < 0xe0 ? 2 : escaped < 0xf0 ? 3 : 4;
        if (index + width <= source.length)
          try {
            decoder.decode(source.subarray(index, index + width));
            count = width;
          } catch {}
      }
      for (let offset = 0; offset < count; offset++) appendByte(source[index + offset]);
      index += count;
      continue;
    }
    if (first < 0x80) {
      appendByte(first);
      index++;
      continue;
    }
    if (!pattern.usAscii) {
      const width = first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
      try {
        const character = decoder.decode(source.subarray(index, index + width));
        const point = character.codePointAt(0);
        if (point !== undefined) {
          appendAscii(
            point <= 0xff_ff
              ? `\\u${point.toString(16).toUpperCase().padStart(4, '0')}`
              : `\\u{${point.toString(16).toUpperCase()}}`
          );
          index += width;
          continue;
        }
      } catch {}
    }
    appendAscii(`\\x${first.toString(16).toUpperCase().padStart(2, '0')}`);
    index++;
  }
  appendAscii(`/${regexpSuffix(options)}`);
  return stringFromBytes(result.subarray(0, length), false, pattern.usAscii);
}

function regexpSuffix(options: RegexpOptions): string {
  return `${options.multiline ? 'm' : ''}${options.ignoreCase ? 'i' : ''}${options.extended ? 'x' : ''}`;
}

sdef(
  'Regexp',
  ['new', 'compile'],
  [0, -1],
  function* (self: RClass, args, block, keywords) {
    const value = new RObject(self);
    yield* callMethod(value, 'initialize', args, keywords, block, { fcall: true, used: false });
    return value;
  },
  { keywords: true }
);
def(
  'Regexp',
  'initialize',
  [1, 2],
  function* (self: RObject, [source, options], _block, keywords) {
    yield* checkRegexpKeywords(keywords);
    if (self.frozen)
      throw frozenError(
        self,
        self.data ? regexpInspect(self) : `#<${className(realClassOf(self))}:${addressOf(self)}>`
      );
    if (self.data) throw typeError('already initialized regexp');
    if (isRegexp(source)) {
      const data = dataOf(source);
      self.data = makeRegexp(data.source, {
        ...data,
        sourceBinary: data.encoding === 'BINARY (ASCII-8BIT)',
        fixedEncoding: data.encoding !== 'US-ASCII',
      }).data;
    } else {
      const parsedOptions = yield* optionsOf(options);
      const pattern = yield* toStrValue(source);
      self.data = regexpFromString(pattern, parsedOptions).data;
    }
    return self;
  },
  { visibility: 'private', keywords: true }
);
function* checkRegexpKeywords(keywords: RHash | undefined): Gen<void> {
  if (keywords) {
    yield* validateKeywords(keywords, ['timeout']);
    const timeout = (yield* hashGet(keywords, sym('timeout')))?.value;
    if (timeout !== undefined && timeout !== NIL) throw new UnsupportedFeatureError('Regexp のタイムアウト');
  }
}
sdef('Regexp', ['escape', 'quote'], 1, function* (_self, [value]) {
  return escapeRegexpPattern(value instanceof RSymbol ? symbolString(value) : yield* toStrValue(value));
});
sdef('Regexp', 'union', [0, -1], function* (_self, args) {
  const items = args.length === 1 ? ((yield* tryAry(args[0]))?.items ?? args) : args;
  if (items.length === 1 && isRegexp(items[0])) return items[0];
  if (items.length === 1 && items[0] instanceof RSymbol)
    return regexpFromString(escapeRegexpPattern(symbolString(items[0])));
  const parts: string[] = [];
  let binary = false;
  let ascii = true;
  let lockedBinary: boolean | undefined;
  let length = 0;
  for (const item of items) {
    const part = isRegexp(item)
      ? regexpText(regexpToS(item), dataOf(item).encoding)
      : escapeRegexpPattern(yield* toStrValue(item));
    binary = regexpPatternEncoding(binary, ascii, part, 'union');
    const bytes = stringBytes(part);
    const partAscii = bytes.every((byte) => byte < 0x80);
    const fixed = isRegexp(item) ? dataOf(item).encoding !== 'US-ASCII' : !partAscii;
    if (fixed) {
      if (lockedBinary !== undefined && lockedBinary !== part.binary)
        throw argumentError(
          `incompatible encodings: ${lockedBinary ? 'ASCII-8BIT' : RUBY_UTF8} and ${part.binary ? 'ASCII-8BIT' : RUBY_UTF8}`
        );
      lockedBinary = part.binary;
    }
    ascii &&= partAscii;
    length += bytes.length + (parts.length > 0 ? 1 : 0);
    rt().checkStringLength(length);
    parts.push(part.s);
  }
  return regexpFromString(
    regexpText(
      parts.length === 0 ? '(?!)' : parts.join('|'),
      (lockedBinary ?? binary) ? 'BINARY (ASCII-8BIT)' : RUBY_UTF8
    )
  );
});

export function regexpPatternEncoding(
  binary: boolean,
  ascii: boolean,
  part: RString,
  context: 'union' | 'dynamic'
): boolean {
  return combinedStringEncoding(binary, ascii, part, (leftBinary, rightBinary) => {
    const encodings = `${leftBinary ? 'ASCII-8BIT' : RUBY_UTF8} and ${rightBinary ? 'ASCII-8BIT' : RUBY_UTF8}`;
    return context === 'union'
      ? argumentError(`incompatible encodings: ${encodings}`)
      : rubyError(rt().c.RegexpError, `encoding mismatch in dynamic regexp : ${encodings}`);
  });
}

export function validateRegexpInterpolation(segment: RString): void {
  if (!validStringEncoding(segment)) throw argumentError('invalid multibyte character');
}

function escapeRegexpPattern(pattern: RString): RString {
  const ascii = stringBytes(pattern).every((byte) => byte < 0x80);
  return regexpText(
    escapeRegexpSource(pattern.s),
    ascii || pattern.usAscii ? 'US-ASCII' : pattern.binary ? 'BINARY (ASCII-8BIT)' : RUBY_UTF8
  );
}

function regexpText(text: string, encoding: RegexpData['encoding']): RString {
  if (encoding === 'US-ASCII') return asciiString(text);
  return encoding === 'BINARY (ASCII-8BIT)'
    ? stringFromBytes(
        Uint8Array.from(text, (char) => char.codePointAt(0)!),
        true
      )
    : str(text);
}

export function regexpFromString(pattern: RString, options: RegexpOptions = {}): RObject {
  if (!validStringEncoding(pattern)) throw rubyError(rt().c.RegexpError, invalidPatternMessage(pattern, options));
  return makeRegexp(pattern.s, { ...options, sourceBinary: pattern.binary });
}

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
  return `(?${on}${off ? `-${off}` : ''}:${escapedRegexpSource(data.source)})`;
}

function regexpInspect(regexp: RObject): string {
  const data = dataOf(regexp);
  const source = escapedRegexpSource(data.source);
  const shown =
    data.encoding === 'BINARY (ASCII-8BIT)'
      ? source.replaceAll(
          /[\u0080-\u00FF]/g,
          (byte) => `\\x${byte.codePointAt(0)!.toString(16).toUpperCase().padStart(2, '0')}`
        )
      : source;
  return `/${shown}/${data.multiline ? 'm' : ''}${data.ignoreCase ? 'i' : ''}${data.extended ? 'x' : ''}`;
}

function escapedRegexpSource(source: string): string {
  return source.replaceAll(/(\\*)\//g, (_match, slashes: string) =>
    slashes.length % 2 === 0 ? `${slashes}\\/` : `${slashes}/`
  );
}

function literalRegexpText(regexp: RObject): string | undefined {
  const data = dataOf(regexp);
  if (data.ignoreCase || data.extended) return undefined;
  const syntax = String.raw`\\^$.*+?()[]{}|`;
  if (data.source.length === 2 && !syntax.includes(data.source[0]) && data.source[1] === '+') return data.source[0];
  return [...data.source].some((char) => syntax.includes(char)) ? undefined : data.source;
}

export function regexpValueDisplayOf(value: RObject): string | undefined {
  if (value.cls.isSubclassOf(rt().c.Regexp)) return regexpInspect(value);
  if (value.cls === rt().c.MatchData) return matchDataInspect(value);
  return undefined;
}

def('Regexp', 'source', 0, (self: RObject) => regexpText(dataOf(self).source, dataOf(self).encoding));
def('Regexp', 'inspect', 0, (self: RObject) => regexpText(regexpInspect(self), dataOf(self).encoding));
def('Regexp', 'to_s', 0, (self: RObject) => regexpText(regexpToS(self), dataOf(self).encoding));
def('Regexp', 'options', 0, (self: RObject) => {
  const data = dataOf(self);
  return BigInt(
    (data.ignoreCase ? 1 : 0) |
      (data.extended ? 2 : 0) |
      (data.multiline ? 4 : 0) |
      (data.encoding !== 'US-ASCII' ? 16 : 0)
  );
});
def(
  'Regexp',
  'encoding',
  0,
  (self: RObject) =>
    rt().c.Encoding.constants.get(
      dataOf(self).encoding === 'BINARY (ASCII-8BIT)'
        ? 'ASCII_8BIT'
        : dataOf(self).encoding === RUBY_UTF8
          ? 'UTF_8'
          : 'US_ASCII'
    ) as Value
);
def('Regexp', 'casefold?', 0, (self: RObject) => dataOf(self).ignoreCase);
def('Regexp', ['==', 'eql?'], 1, (self: RObject, [other]) => {
  if (!isRegexp(other)) return false;
  const a = dataOf(self);
  const b = dataOf(other);
  return (
    a.source === b.source &&
    a.encoding === b.encoding &&
    a.ignoreCase === b.ignoreCase &&
    a.multiline === b.multiline &&
    a.extended === b.extended
  );
});
def('Regexp', 'hash', 0, (self: RObject) =>
  BigInt(
    `0x${digest(JSON.stringify([dataOf(self).source, dataOf(self).encoding, dataOf(self).ignoreCase, dataOf(self).multiline, dataOf(self).extended]))}`
  )
);
def('Regexp', 'names', 0, (self: RObject) =>
  arr([...new Set(regexpCaptureNames(dataOf(self).js.source))].map((name) => captureNameString(self, name)))
);

function captureNameString(regexp: RObject, name: string): RString {
  const encoding = dataOf(regexp).encoding;
  if (encoding === 'US-ASCII') return asciiString(name);
  if (encoding === 'BINARY (ASCII-8BIT)')
    return stringFromBytes(
      Uint8Array.from(name, (char) => char.codePointAt(0) as number),
      true
    );
  return str(name);
}

function captureNameSymbol(regexp: RObject, name: string): RSymbol {
  const string = captureNameString(regexp, name);
  return RSymbol.of(name, string.binary, string.usAscii, stringBytes(string));
}

function namedCaptureGroup(state: MatchState, key: RString | RSymbol): number {
  const symbol = key instanceof RSymbol ? key : RSymbol.of(key.s, key.binary, key.usAscii, stringBytes(key));
  const name = state.names.find((candidate) => captureNameSymbol(state.regexp, candidate) === symbol);
  if (name === undefined)
    throw indexError(`undefined group name reference: ${key instanceof RSymbol ? key.name : key.s}`);
  return state.namedGroups[name];
}

function* subjectText(value: Value): Gen<RString | undefined> {
  if (value === NIL) return undefined;
  if (value instanceof RSymbol) return symbolString(value);
  return yield* toStrValue(value);
}

function matchAt(regexp: RObject, subject: RString, offset: number): MatchState | undefined {
  const text = subject.s;
  const start = offset < 0 ? offset + charIndex(text, text.length) : offset;
  if (start < 0) return undefined;
  validateRegexpSubject(regexp, subject);
  return execAt(regexp, text, start, subject, undefined, true);
}

def('Regexp', 'match', [1, 2], function* (self: RObject, args, block) {
  const subject = yield* subjectText(args[0]);
  if (subject === undefined) return setLastMatch(undefined);
  const start = args.length > 1 ? yield* toIndex(args[1]) : 0;
  const match = setLastMatch(matchAt(self, subject, start));
  if (block && match !== NIL) return yield* callBlock(block, [match]);
  return match;
});
def('Regexp', 'match?', [1, 2], function* (self: RObject, args) {
  const subject = yield* subjectText(args[0]);
  if (subject === undefined) return false;
  const text = subject.s;
  const start = args.length > 1 ? yield* toIndex(args[1]) : 0;
  return execAt(self, text, start < 0 ? start + charIndex(text, text.length) : start, subject) !== undefined;
});
def('Regexp', '=~', 1, function* (self: RObject, [value]) {
  const subject = yield* subjectText(value);
  if (subject === undefined) return setLastMatch(undefined);
  const text = subject.s;
  const state = execAt(self, text, 0, subject);
  setLastMatch(state);
  return state ? BigInt(charIndex(text, (state.groups[0] as readonly [number, number])[0])) : NIL;
});
def('Regexp', '===', 1, function* (self: RObject, [value]) {
  const converted =
    value instanceof RString || value instanceof RSymbol ? value : yield* tryImplicitConversion(value, 'to_str');
  if (converted === undefined || converted === NIL) {
    setLastMatch(undefined);
    return false;
  }
  if (!(converted instanceof RString) && (converted !== value || !(converted instanceof RSymbol))) {
    const name = realClassOf(value).name;
    throw typeError(`can't convert ${name} to String (${name}#to_str gives ${realClassOf(converted).name})`);
  }
  const subject = converted instanceof RString ? converted : symbolString(converted);
  const state = execAt(self, subject.s, 0, subject);
  setLastMatch(state);
  yield* [];
  return state !== undefined;
});

// MatchData ------------------------------------------------------------------------------------------------------------

sundef('MatchData', ['new', 'allocate']);

function* matchIndex(match: RObject, key: Value): Gen {
  const state = stateOf(match);
  if (key instanceof RString || key instanceof RSymbol) {
    return groupText(state, namedCaptureGroup(state, key));
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
  const leftRanges = matchByteRanges(left);
  const rightRanges = matchByteRanges(right);
  const leftSource = left.snapshot ?? str(left.text);
  const rightSource = right.snapshot ?? str(right.text);
  return (
    stringKeyEquals(leftSource, rightSource) &&
    leftRegexp.source === rightRegexp.source &&
    leftRegexp.encoding === rightRegexp.encoding &&
    leftRegexp.ignoreCase === rightRegexp.ignoreCase &&
    leftRegexp.multiline === rightRegexp.multiline &&
    leftRegexp.extended === rightRegexp.extended &&
    left.groups.length === right.groups.length &&
    leftRanges.every((range, index) =>
      range === undefined
        ? rightRanges[index] === undefined
        : range[0] === rightRanges[index]?.[0] && range[1] === rightRanges[index]?.[1]
    )
  );
});
def('MatchData', 'hash', 0, (self: RObject) => {
  const state = stateOf(self);
  const regexp = dataOf(state.regexp);
  const source = state.snapshot ?? str(state.text);
  const encoding = source.binary && stringBytes(source).some((byte) => byte >= 0x80) ? 'binary' : 'ascii-compatible';
  return BigInt(
    `0x${digest(JSON.stringify([String(stringKeyHash(source)), encoding, regexp.source, regexp.encoding, regexp.ignoreCase, regexp.multiline, regexp.extended, matchByteRanges(state)]))}`
  );
});
def(
  'MatchData',
  'named_captures',
  0,
  function* (self: RObject, _args, _block, keywords) {
    yield* validateKeywords(keywords, ['symbolize_names']);
    let symbolize = false;
    for (const entry of keywords?.map.values() ?? []) symbolize = truthy(entry.value);
    const hash = newHash();
    const state = stateOf(self);
    for (const name of state.names)
      yield* hashSet(
        hash,
        symbolize ? captureNameSymbol(state.regexp, name) : captureNameString(state.regexp, name),
        groupText(state, state.namedGroups[name])
      );
    return hash;
  },
  { keywords: true }
);

def('MatchData', 'names', 0, (self: RObject) => {
  const state = stateOf(self);
  return arr(state.names.map((name) => captureNameString(state.regexp, name)));
});
def('MatchData', ['to_s'], 0, (self: RObject) => groupText(stateOf(self), 0));
def('MatchData', 'pre_match', 0, (self: RObject) => {
  const state = stateOf(self);
  return matchPrefix(state);
});
def('MatchData', 'post_match', 0, (self: RObject) => {
  const state = stateOf(self);
  return matchSuffix(state);
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
  if (key instanceof RString || key instanceof RSymbol) return namedCaptureGroup(state, key);
  const group = yield* toIndex(key);
  if (group < 0 || group >= state.groups.length) throw indexError(`index ${group} out of matches`);
  return group;
}
def('MatchData', ['size', 'length'], 0, (self: RObject) => BigInt(stateOf(self).groups.length));
def('MatchData', 'values_at', [0, -1], function* (self: RObject, args) {
  const values: Value[] = [];
  for (const arg of args) {
    if (arg instanceof RRange) {
      const state = stateOf(self);
      const all = arr(state.groups.map((_range, group) => groupText(state, group)));
      const selected = (yield* callMethod(all, 'values_at', [arg])) as RArray;
      values.push(...selected.items);
    } else values.push(yield* matchIndex(self, arg));
  }
  return arr(values);
});
def('MatchData', 'string', 0, (self: RObject) => stateOf(self).snapshot as RString);
def('MatchData', 'regexp', 0, (self: RObject) => stateOf(self).regexp);
def('MatchData', 'inspect', 0, (self: RObject) => {
  const state = stateOf(self);
  if (!state.literal) return str(matchDataInspect(self));
  const range = state.groups[0] as readonly [number, number];
  const matched = sliceStringEncoding(state.snapshot ?? str(state.text), range[0], range[1]);
  const prefix = new TextEncoder().encode('#<MatchData: ');
  const body = stringBytes(matched);
  const bytes = new Uint8Array(prefix.length + body.length + 1);
  bytes.set(prefix);
  bytes.set(body, prefix.length);
  bytes[bytes.length - 1] = 62;
  return stringFromBytes(
    bytes,
    matched.binary || body.every((byte) => byte < 0x80),
    matched.usAscii && body.some((byte) => byte >= 0x80)
  );
});

function matchDataInspect(match: RObject): string {
  const state = stateOf(match);
  if (state.literal) {
    const range = state.groups[0] as readonly [number, number];
    return `#<MatchData: ${state.text.slice(range[0], range[1])}>`;
  }
  const parts = state.groups.map((range, group) => {
    const shown = range ? inspectStringEncoding(groupText(state, group) as RString) : 'nil';
    if (group === 0) return shown;
    const name = state.names.find((candidate) => state.namedGroups[candidate] === group);
    return `${name ?? group}:${shown}`;
  });
  return `#<MatchData ${parts.join(' ')}>`;
}
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
  if (keys instanceof RArray && keys.items.length > state.names.length) return hash;
  const requested =
    keys instanceof RArray ? keys.items : state.names.map((name) => captureNameSymbol(state.regexp, name));
  for (const key of requested) {
    if (!(key instanceof RSymbol)) throw typeError(`wrong argument type ${realClassOf(key).name} (expected Symbol)`);
    const name = state.names.find((candidate) => captureNameSymbol(state.regexp, candidate) === key);
    const group = name === undefined ? undefined : state.namedGroups[name];
    if (group === undefined) break;
    yield* hashSet(hash, key, groupText(state, group));
  }
  return hash;
});

// String's regular-expression forms ------------------------------------------------------------------------------------

/** Expands capture references and match-context escapes in a replacement string. */
function expand(replacement: RString, state: MatchState, limit: number): RString {
  const replacementBytes = stringBytes(replacement);
  const parts: RString[] = [];
  let literalBytes: number[] = [];
  let length = 0;
  const append = (part: RString): void => {
    const bytes = stringBytes(part).length;
    if (bytes === 0) return;
    length += bytes;
    if (length > limit) throw new ExecutionLimitError('storage');
    rt().spend(Math.ceil(bytes / 256));
    parts.push(part);
  };
  const flushLiteral = (): void => {
    if (literalBytes.length === 0) return;
    const literal = stringFromBytes(Uint8Array.from(literalBytes), replacement.binary);
    literal.usAscii = replacement.usAscii;
    literalBytes = [];
    append(literal);
  };
  const appendLiteral = (from: number, to: number): void => {
    for (let index = from; index < to; index++) {
      literalBytes.push(replacementBytes[index]);
      if (length + literalBytes.length > limit) throw new ExecutionLimitError('storage');
      if (literalBytes.length === 4096) flushLiteral();
    }
  };
  let position = 0;
  let bytePosition = 0;
  for (const match of replacement.s.matchAll(/\\(k<([\p{ID_Start}_][\p{ID_Continue}_]*)>|[0-9&+\\`'])/gu)) {
    rt().spend(1);
    if (match.index > position) {
      const byteEnd = bytePosition + textByteLengthOf(replacement, replacement.s.slice(position, match.index));
      appendLiteral(bytePosition, byteEnd);
      bytePosition = byteEnd;
    }
    const [, code, name] = match;
    let part: RString;
    if (name !== undefined) {
      const group = state.namedGroups[name];
      if (group === undefined) throw indexError(`undefined group name reference: ${name}`);
      const value = groupText(state, group);
      part = value === NIL ? str('') : (value as RString);
    } else {
      switch (code) {
        case '&': {
          part = groupText(state, 0) as RString;
          break;
        }
        case '+': {
          const group = state.groups.findLastIndex((range, index) => index > 0 && range !== undefined);
          const value = group > 0 ? groupText(state, group) : NIL;
          part = value === NIL ? str('') : (value as RString);
          break;
        }
        case '\\': {
          appendLiteral(bytePosition + 1, bytePosition + 2);
          position = match.index + match[0].length;
          bytePosition += textByteLengthOf(replacement, match[0]);
          continue;
        }
        case '`': {
          part = matchPrefix(state);
          break;
        }
        case "'": {
          part = matchSuffix(state);
          break;
        }
        default: {
          const value = state.names.length > 0 && code !== '0' ? NIL : groupText(state, Number(code));
          part = value === NIL ? str('') : (value as RString);
        }
      }
    }
    if (stringBytes(part).length > 0) {
      flushLiteral();
      append(part);
    }
    position = match.index + match[0].length;
    bytePosition += textByteLengthOf(replacement, match[0]);
  }
  if (position < replacement.s.length) {
    appendLiteral(bytePosition, replacementBytes.length);
  }
  flushLiteral();
  return concatRegexpPieces(parts, limit);
}

// code-gauge-allow functionCognitiveComplexity 25 -- Substitution separates callback, Hash and replacement-string values while preserving each operation's match-state rules.
// code-gauge-allow functionNcss 49 -- Substitution shares one byte cursor and output builder across the four Ruby operations.
function* substituteRegexp(
  self: RString,
  regexp: RObject,
  replacement: Value | undefined,
  block: RProc | undefined,
  mode: 'sub' | 'sub!' | 'gsub' | 'gsub!'
): Gen<{ value: RString; matched: boolean }> {
  const replacementText =
    replacement === undefined || replacement instanceof RHash ? undefined : yield* toStrValue(replacement);
  const cursor = new RegexpCursor(regexp, self);
  const global = mode === 'gsub' || mode === 'gsub!';
  const chunks: RString[] = [cursor.slice(0, 0)];
  let length = 0;
  const append = (part: RString): void => {
    const bytes = stringBytes(part);
    length += bytes.length;
    if (length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
    rt().spend(Math.ceil(bytes.length / 256));
    chunks.push(part);
  };
  let position = 0;
  let search = 0;
  let lastSearch: number | undefined;
  let state = cursor.match(search);
  let last: MatchState | undefined;
  while (state) {
    const [from, to] = cursor.range(state)!;
    setLastMatch(state);
    let piece: RString;
    if (replacement instanceof RHash) {
      const key = cursor.slice(from, to);
      const entry = yield* hashGet(replacement, key);
      piece = yield* toSValue(entry ? entry.value : yield* hashDefault(replacement, key));
    } else if (replacementText !== undefined) {
      piece = expand(replacementText, state, LIMITS.maxStringLength - length);
    } else {
      piece = yield* toSValue(yield* callBlock(block as RProc, [cursor.slice(from, to)]));
    }
    if (mode !== 'sub') cursor.refresh();
    if (position < from) append(cursor.slice(position, from));
    append(piece);
    position = to;
    lastSearch = search;
    last = state;
    search = cursor.next(state, true);
    state = global ? cursor.match(search) : undefined;
  }
  if (global) setLastMatch(lastSearch === undefined ? undefined : cursor.match(lastSearch));
  else if ((!block && !(replacement instanceof RHash)) || !last) setLastMatch(last);
  append(cursor.slice(position));
  return { value: concatRegexpPieces(chunks, LIMITS.maxStringLength), matched: last !== undefined };
}

function concatRegexpPieces(parts: RString[], limit: number): RString {
  const buffers = parts.map(stringBytes);
  const length = buffers.reduce((sum, bytes) => sum + bytes.length, 0);
  if (length > limit) throw new ExecutionLimitError('storage');
  let binary = parts[0]?.binary ?? false;
  let ascii = true;
  for (const [index, part] of parts.entries()) {
    if (index > 0) binary = combinedStringEncoding(binary, ascii, part);
    ascii &&= buffers[index].every((byte) => byte < 0x80);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const buffer of buffers) {
    bytes.set(buffer, offset);
    offset += buffer.length;
  }
  const result = stringFromBytes(bytes, binary);
  result.usAscii = !binary && (parts[0]?.usAscii ?? false) && ascii;
  return result;
}

function wrapFirst(
  names: string | string[],
  handle: (self: RString, args: Value[], block: RProc | undefined, previous: NativeFn, used: boolean) => Gen | Value,
  anyRegexp = false
): void {
  extend(
    'String',
    typeof names === 'string' ? [names] : names,
    (previous) => (self: RString, args, block, keywords, used) => {
      if (args.length > 0 && (anyRegexp ? args.some(isRegexp) : isRegexp(args[0])))
        return handle(self, args, block, previous, used);
      return previous(self, args, block, keywords, used);
    }
  );
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
      if (global) return makeEnumerator(self, name, args);
      throw argumentError('wrong number of arguments (given 1, expected 2)');
    }
    const result = yield* substituteRegexp(self, args[0] as RObject, args[1], block, name);
    if (!bang) return result.value;
    if (!result.matched) return NIL;
    setBytes(self, stringBytes(result.value), result.value.binary);
    self.usAscii = result.value.usAscii;
    return self;
  });
}
wrapFirst('scan', function* (self, args, block) {
  const regexp = args[0] as RObject;
  if (!block) {
    const matches = allMatches(regexp, self);
    setLastMatch(matches.at(-1));
    return arr(matches.map(scanValue));
  }
  const cursor = new RegexpCursor(regexp, self);
  let search = 0;
  let lastSearch: number | undefined;
  let state = cursor.match(search);
  while (state) {
    const next = cursor.next(state);
    setLastMatch(state);
    yield* callBlock(block, [scanValue(state)], false);
    cursor.refresh();
    lastSearch = search;
    search = next;
    state = cursor.match(search);
  }
  setLastMatch(lastSearch === undefined ? undefined : cursor.match(lastSearch));
  return self;
});
function scanValue(state: MatchState): Value {
  return state.groups.length > 1
    ? arr(state.groups.slice(1).map((_range, group) => groupText(state, group + 1)))
    : groupText(state, 0);
}

wrapFirst('split', function* (self, args, block) {
  const limit = args.length > 1 ? yield* toIndex(args[1]) : 0;
  if (limit === 1) return yield* splitSingle(self, block);
  setLastMatch(undefined);
  const cursor = new RegexpCursor(args[0] as RObject, self);
  if (cursor.length === 0) return block ? self : arr([]);
  const parts: RString[] = [];
  const emit = splitEmitter(cursor, limit, block, parts);
  let fields = 0;
  let position = 0;
  let search = 0;
  while (search <= cursor.length) {
    if (limit > 0 && fields === limit - 1) break;
    const state = cursor.match(search);
    if (!state) break;
    const [from, to] = cursor.range(state)!;
    const next = cursor.next(state);
    if (from === to && from >= cursor.length) break;
    if (from === to && from === position && position === 0) {
      search = next;
      continue;
    }
    if (!(from === to && from === position)) {
      yield* emit(position, from);
      fields++;
      for (let group = 1; group < state.groups.length; group++) {
        const range = cursor.range(state, group);
        if (range) yield* emit(range[0], range[1]);
      }
      position = to;
    }
    search = next;
  }
  yield* emit(position, cursor.length);
  return block ? self : arr(parts);
});
function* splitSingle(self: RString, block: RProc | undefined): Gen {
  if (self.s.length === 0) return block ? self : arr([]);
  const part = copyStringEncoding(self);
  if (!block) return arr([part]);
  yield* callBlock(block, [part], false);
  return self;
}

function splitEmitter(
  cursor: RegexpCursor,
  limit: number,
  block: RProc | undefined,
  parts: RString[]
): (from: number, to: number) => Gen<void> {
  const emptyRanges: (readonly [number, number])[] = [];
  return function* (from: number, to: number): Gen<void> {
    if (limit === 0 && from === to) {
      emptyRanges.push([from, to]);
      return;
    }
    const ranges = [...emptyRanges.splice(0), [from, to] as const];
    for (const range of ranges) {
      const part = cursor.slice(range[0], range[1]);
      if (block) {
        yield* callBlock(block, [part], false);
        cursor.refresh();
      } else parts.push(part);
    }
  };
}

for (const name of ['index', 'rindex'] as const) {
  wrapFirst(name, function* (self, args) {
    const regexp = args[0] as RObject;
    const length = charIndex(self.s, self.s.length);
    let start = args.length > 1 ? yield* toIndex(args[1]) : name === 'index' ? 0 : length;
    if (start < 0) start += length;
    if (name === 'rindex' && start > length) start = length;
    if (start < 0 || start > length) return setLastMatch(undefined) && NIL;
    if (name === 'index') {
      const state = execAt(regexp, self.s, start, self);
      setLastMatch(state);
      return state ? BigInt(charIndex(self.s, (state.groups[0] as readonly [number, number])[0])) : NIL;
    }
    const state = reverseRegexpSearch(regexp, self, start);
    setLastMatch(state);
    return state ? BigInt(charIndex(self.s, state.groups[0]![0])) : NIL;
  });
}
wrapFirst(['[]', 'slice'], function* (self, args) {
  const state = execAt(args[0] as RObject, self.s, 0, self);
  setLastMatch(state);
  if (!state) return NIL;
  if (args.length > 1) return yield* matchIndex(setLastMatch(state) as RObject, args[1]);
  return groupText(state, 0);
});
wrapFirst('slice!', function* (self, args) {
  if (self.frozen) throw frozenError(self, strInspect(self.s));
  const state = execAt(args[0] as RObject, self.s, 0, self);
  setLastMatch(state);
  if (!state) return NIL;
  const range = args.length > 1 ? yield* sliceCaptureRange(state, args[1]) : state.groups[0];
  if (range === 'unmatched') return sliceStringEncoding(self, 0, 0);
  if (!range) return NIL;
  const [from, to] = range;
  const removed = sliceStringEncoding(self, from, to);
  const remainder = concatRegexpPieces(
    [sliceStringEncoding(self, 0, from), sliceStringEncoding(self, to)],
    LIMITS.maxStringLength
  );
  setBytes(self, stringBytes(remainder), remainder.binary);
  self.usAscii = remainder.usAscii;
  return removed;
});
function* sliceCaptureRange(state: MatchState, key: Value): Gen<readonly [number, number] | 'unmatched' | undefined> {
  if (key instanceof RString || key instanceof RSymbol) {
    return state.groups[namedCaptureGroup(state, key)] ?? 'unmatched';
  }
  let group = yield* toIndex(key);
  if (group < 0) group += state.groups.length;
  return group >= 0 && group < state.groups.length ? (state.groups[group] ?? 'unmatched') : undefined;
}
// code-gauge-allow functionCognitiveComplexity 16 -- Regexp assignment distinguishes numeric and named captures and preserves Ruby's unmatched-group errors.
wrapFirst('[]=', function* (self, args) {
  const state = execAt(args[0] as RObject, self.s, 0, self);
  setLastMatch(state);
  if (!state) throw indexError('regexp not matched');
  let group = 0;
  if (args.length === 3) {
    const key = args[1];
    if (key instanceof RString || key instanceof RSymbol) group = namedCaptureGroup(state, key);
    else {
      const index = yield* toIndex(key);
      group = index < 0 ? index + state.groups.length : index;
      if (group < 0 || group >= state.groups.length || (index < 0 && group === 0))
        throw indexError(`index ${index} out of regexp`);
    }
  }
  const range = state.groups[group];
  if (!range) throw indexError(`regexp group ${group} not matched`);
  const replacement = yield* toStrValue(args.at(-1) as Value);
  if (self.frozen) throw frozenError(self, strInspect(self.s));
  const [from, to] = range;
  const result = concatRegexpPieces(
    [sliceStringEncoding(self, 0, from), replacement, sliceStringEncoding(self, to)],
    LIMITS.maxStringLength
  );
  setBytes(self, stringBytes(result), result.binary);
  self.usAscii = result.usAscii;
  return args.at(-1) as Value;
});
wrapFirst(
  'start_with?',
  function* (self, args, block, previous, used) {
    for (const arg of args) {
      if (isRegexp(arg)) {
        const state = execAt(arg, self.s, 0, self);
        const prefix = state && (state.groups[0] as readonly [number, number])[0] === 0 ? state : undefined;
        setLastMatch(prefix);
        if (prefix) {
          return true;
        }
      } else if (truthy((yield* asGen(previous(self, [arg], block, undefined, used))) as Value)) {
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
    const regexp = args[0] as RObject;
    const state = last
      ? reverseRegexpSearch(regexp, self, charIndex(self.s, self.s.length))
      : execAt(regexp, self.s, 0, self);
    setLastMatch(state);
    if (!state)
      return last
        ? arr([sliceStringEncoding(self, 0, 0), sliceStringEncoding(self, 0, 0), copyStringEncoding(self)])
        : arr([copyStringEncoding(self), sliceStringEncoding(self, 0, 0), sliceStringEncoding(self, 0, 0)]);
    const [from, to] = state.groups[0] as readonly [number, number];
    yield* [];
    return arr([
      sliceStringEncoding(self, 0, from),
      sliceStringEncoding(self, from, to),
      sliceStringEncoding(self, to),
    ]);
  });
}

function reverseRegexpSearch(regexp: RObject, source: RString, start: number): MatchState | undefined {
  const snapshot = matchSnapshot(source);
  validateRegexpSubject(regexp, source);
  const literal = literalRegexpText(regexp);
  if (literal !== undefined) {
    rt().spend(Math.ceil(source.s.length / 64));
    const position = source.s.lastIndexOf(literal, unitIndex(source.s, start));
    return position === -1
      ? undefined
      : execAt(regexp, source.s, charIndex(source.s, position), source, snapshot, true);
  }
  if (dataOf(regexp).safeNative) {
    for (let position = start; position >= 0; position--) {
      const state = execAt(regexp, source.s, position, source, snapshot, true, true);
      if (state) return state;
    }
    return undefined;
  }
  let last: MatchState | undefined;
  let position = 0;
  while (position <= start) {
    const state = execAt(regexp, source.s, position, source, snapshot, true);
    if (!state) break;
    const from = charIndex(source.s, state.groups[0]![0]);
    if (from > start) break;
    last = state;
    position = from + 1;
  }
  return last;
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
  const state = execAt(pattern, self.s, 0, self);
  setLastMatch(state);
  return state ? BigInt(charIndex(self.s, (state.groups[0] as readonly [number, number])[0])) : NIL;
});
def('NilClass', '=~', 1, () => NIL);
function* asRegexp(pattern: Value): Gen<RObject> {
  if (isRegexp(pattern)) return pattern;
  return regexpFromString(yield* toStrValue(pattern));
}

def('String', 'match', [1, 2], function* (self: RString, args, block) {
  const regexp = yield* asRegexp(args[0]);
  const start = args.length > 1 ? yield* toIndex(args[1]) : 0;
  const match = setLastMatch(matchAt(regexp, self, start));
  if (block && match !== NIL) return yield* callBlock(block, [match]);
  return match;
});
def('String', 'match?', [1, 2], function* (self: RString, args) {
  const regexp = yield* asRegexp(args[0]);
  const start = args.length > 1 ? yield* toIndex(args[1]) : 0;
  return execAt(regexp, self.s, start < 0 ? start + charIndex(self.s, self.s.length) : start, self) !== undefined;
});
for (const name of ['=~', 'match', 'match?']) {
  def('Symbol', name, [1, 2], (self: RSymbol, args, block) =>
    invoke(coreMethod(rt().c.String, name), symbolString(self), args, undefined, block, false)
  );
}

export { inspect, rEquals, sym };
