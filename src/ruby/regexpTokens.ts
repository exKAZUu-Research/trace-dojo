import { regexpByteEscape, RegexpSourceError } from './regexpEscapes';

export interface RegexpToken {
  kind: 'escape' | 'char' | 'classOpen' | 'classClose' | 'posix' | 'groupOpen' | 'directive' | 'groupClose' | 'ignored';
  raw: string;
  start: number;
  inClass: boolean;
  /** The name of a `(?<name>` or `(?'name'` capture. */
  name?: string;
  /** The option letters of `(?on-off)` and `(?on-off:`. */
  options?: { on: string; off: string };
}

interface RegexpFlags {
  multiline: boolean;
  ignoreCase: boolean;
  extended: boolean;
}

const ESCAPE = /\\(?:[\s\S])?/uy;
// Outside a class a reference is one token with its name, so that punctuation in the name cannot open a class or a
// group; inside a class `\k` and `\g` are the letters.
const ESCAPE_OR_REFERENCE = /\\(?:[kg](?:<[^>]*>|'[^']*')|[\s\S])?/uy;
const POSIX_BRACKET = /\[:\^?\w*:\]/y;
const CLASS_OPEN = /\[\^?/y;
const COMMENT_GROUP = /\(\?#(?:\\[\s\S]|[^)\\])*\)?/y;
const NAMED_GROUP = /\(\?(?:<([^>=!][^>]*)>|'([^']*)')/y;
const OPTION_GROUP = /\(\?([a-zA-Z]*)(?:-([a-zA-Z]*))?([:)])/y;
const SPECIAL_GROUP = /\(\?(?:<[=!]|[=!>~])?/y;
const EXTENDED_IGNORED = /[ \t\n\f\r]+|#[^\n]*/y;
const CODE_POINT = /[\s\S]/uy;
const UNICODE_LIST = /\{[ \t\n\r\v\f]*([0-9a-fA-F]{1,6}(?:[ \t\n\r\v\f]+[0-9a-fA-F]{1,6})*)[ \t\n\r\v\f]*\}/y;

export function regexpTokens(source: string, extended: boolean): RegexpToken[] {
  return new RegexpLexer(source, extended).read();
}

class RegexpLexer {
  private readonly tokens: RegexpToken[] = [];
  /** The extended-mode setting to restore when each open group closes. */
  private readonly extendedScopes: boolean[] = [];
  private classDepth = 0;
  private index = 0;

  constructor(
    private readonly source: string,
    private extended: boolean
  ) {}

  read(): RegexpToken[] {
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === '\\') this.push('escape', this.at(this.classDepth > 0 ? ESCAPE : ESCAPE_OR_REFERENCE)![0]);
      else if (this.classDepth > 0) this.readInClass(char);
      else if (char === '[') this.openClass();
      else if (char === '(') this.openGroup();
      else if (char === ')') {
        this.extended = this.extendedScopes.pop() ?? this.extended;
        this.push('groupClose', char);
      } else this.readLiteral();
    }
    return this.tokens;
  }

  private readInClass(char: string): void {
    const posix = this.at(POSIX_BRACKET);
    if (posix) this.push('posix', posix[0]);
    else if (char === '[') this.openClass();
    else if (char === ']') {
      this.classDepth--;
      this.push('classClose', char);
    } else this.push('char', this.at(CODE_POINT)![0]);
  }

  private readLiteral(): void {
    const ignored = this.extended ? this.at(EXTENDED_IGNORED) : undefined;
    if (ignored) this.push('ignored', ignored[0]);
    else this.push('char', this.at(CODE_POINT)![0]);
  }

  private openClass(): void {
    this.push('classOpen', this.at(CLASS_OPEN)![0]);
    this.classDepth++;
    if (this.source[this.index] === ']') this.push('char', ']');
  }

  private openGroup(): void {
    const comment = this.at(COMMENT_GROUP);
    if (comment) {
      this.push('ignored', comment[0]);
      return;
    }
    const named = this.at(NAMED_GROUP);
    const option = named ? undefined : this.at(OPTION_GROUP);
    const directive = option?.[3] === ')';
    if (!directive) this.extendedScopes.push(this.extended);
    if (named) this.push('groupOpen', named[0], { name: named[1] ?? named[2] });
    else if (option) {
      const options = { on: option[1], off: option[2] ?? '' };
      if (options.on.includes('x')) this.extended = true;
      if (options.off.includes('x')) this.extended = false;
      this.push(directive ? 'directive' : 'groupOpen', option[0], { options });
    } else this.push('groupOpen', this.at(SPECIAL_GROUP)?.[0] ?? '(');
  }

  private at(pattern: RegExp): RegExpExecArray | undefined {
    pattern.lastIndex = this.index;
    return pattern.exec(this.source) ?? undefined;
  }

  private push(kind: RegexpToken['kind'], raw: string, extra?: Partial<RegexpToken>): void {
    this.tokens.push({ kind, raw, start: this.index, inClass: this.classDepth > 0, ...extra });
    this.index += raw.length;
  }
}

export function regexpCaptureNames(source: string, extended = false): string[] {
  return regexpTokens(source, extended).flatMap((token) => (token.name === undefined ? [] : [token.name]));
}

export function hasRegexpProperty(source: string, extended: boolean): boolean {
  return (
    /\\[pP]\{/.test(source) &&
    regexpTokens(source, extended).some(
      (token) => (token.raw === String.raw`\p` || token.raw === String.raw`\P`) && source[token.start + 2] === '{'
    )
  );
}

export function hasSearchStartAnchor(source: string, extended: boolean): boolean {
  return (
    source.includes(String.raw`\G`) &&
    regexpTokens(source, extended).some((token) => token.raw === String.raw`\G` && !token.inClass)
  );
}

export function hasNonAsciiRegexpEscape(source: string, extended: boolean): boolean {
  return regexpTokens(source, extended).some((token) => {
    if (token.kind !== 'escape') return false;
    if (token.raw === String.raw`\u`)
      return unicodeEscapePoints(source, token.start + 2)?.points.some((point) => point > 127) ?? false;
    return (regexpByteEscape(source, token.start)?.value ?? 0) > 127;
  });
}

/** Whether a search may start in the middle of a UTF-8 character without changing what the expression matches. */
export function supportsRegexpByteView(source: string, extended: boolean): boolean {
  return regexpTokens(source, extended).every((token) => {
    if (token.kind === 'posix' || token.options?.on.includes('i')) return false;
    if (token.kind === 'groupOpen') return !/^\(\?<[=!]/.test(token.raw);
    if (token.kind === 'escape') return !(token.inClass ? /^\\[pPxu0-7]/ : /^\\[pPbBXRyY]/).test(token.raw);
    return !(token.inClass && token.kind === 'char' && token.raw.codePointAt(0)! >= 128);
  });
}

export function unicodeEscapePoints(source: string, start: number): { points: number[]; length: number } | undefined {
  UNICODE_LIST.lastIndex = start;
  const braced = UNICODE_LIST.exec(source);
  if (braced) {
    const points = braced[1].split(/[ \t\n\r\v\f]+/).map((point) => Number.parseInt(point, 16));
    if (points.some((point) => point > 0x10_ff_ff || (point >= 0xd8_00 && point <= 0xdf_ff)))
      throw new RegexpSourceError('invalid Unicode range');
    return { points, length: braced[0].length };
  }
  const fixed = /^[0-9a-fA-F]{4}/.exec(source.slice(start, start + 4));
  if (!fixed) return undefined;
  const point = Number.parseInt(fixed[0], 16);
  if (point >= 0xd8_00 && point <= 0xdf_ff) throw new RegexpSourceError('invalid Unicode range');
  return { points: [point], length: 4 };
}

/** The options and source that `Regexp#to_s` shows: leading `(?i)` and one enclosing `(?i:...)` fold into the options. */
export function regexpOuterOptions(source: string, flags: RegexpFlags): RegexpFlags & { source: string } {
  const tokens = regexpTokens(source, flags.extended);
  let start = 0;
  let index = 0;
  for (const token of tokens) {
    if (token.kind !== 'directive' || token.start !== start) break;
    flags = modifiedFlags(flags, token);
    start += token.raw.length;
    index++;
  }
  const first = tokens[index];
  const last = tokens.at(-1);
  if (
    first?.kind !== 'groupOpen' ||
    !first.options ||
    first.start !== start ||
    last?.kind !== 'groupClose' ||
    last.start !== source.length - 1
  )
    return { ...flags, source: source.slice(start) };
  let depth = 0;
  for (let cursor = index; cursor < tokens.length; cursor++) {
    const token = tokens[cursor];
    if (token.kind === 'groupOpen') depth++;
    else if (token.kind === 'groupClose') depth--;
    if (depth === 0 && cursor < tokens.length - 1) return { ...flags, source: source.slice(start) };
  }
  return { ...modifiedFlags(flags, first), source: source.slice(start + first.raw.length, -1) };
}

function modifiedFlags(flags: RegexpFlags, token: RegexpToken): RegexpFlags {
  const { on = '', off = '' } = token.options ?? {};
  return {
    multiline: !off.includes('m') && (on.includes('m') || flags.multiline),
    ignoreCase: !off.includes('i') && (on.includes('i') || flags.ignoreCase),
    extended: !off.includes('x') && (on.includes('x') || flags.extended),
  };
}
