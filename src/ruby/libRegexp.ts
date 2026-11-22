// code-gauge-allow-file fileNcss 962 -- Regexp, MatchData and the regexp forms of String methods share match state and the helpers that slice it.
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import {
  addressOf,
  className,
  combinedStringEncoding,
  inspect,
  rEquals,
  toIndex,
  toStrValue,
  toSValue,
  tryImplicitConversion,
} from './conversions';
import { coreMethod, def, extend, sdef, sundef } from './define';
import { checkStringEncodingCompatibility, EncodedStringBuilder, joinEncodedStrings } from './encodedStringJoin';
import { argumentError, frozenError, indexError, rubyError, runtimeError, typeError } from './errors';
import { validateKeywords } from './exceptionOption';
import { digest, hashDefault, hashGet, hashSet, stringKeyEquals, stringKeyHash } from './hashes';
import { callBlock, callMethod, type Gen, invoke } from './interp';
import { tryAry } from './libArray';
import { builtinEncoding, validStringEncoding } from './libEncoding';
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
import { compileRegexp, stickyRegexp } from './regexpCompile';
import { RegexpCursor } from './regexpCursor';
import { RegexpSourceError } from './regexpEscapes';
import { invalidPatternMessage, type RegexpOptions, regexpSuffix } from './regexpPatternMessage';
import { charIndex, regexpByteIndex, unitIndex } from './regexpPositions';
import {
  hasNonAsciiRegexpEscape,
  hasRegexpProperty,
  regexpCaptureNames,
  regexpOuterOptions,
  supportsRegexpByteView,
} from './regexpTokens';
import { type Frame, rt, UnsupportedFeatureError } from './runtime';
import { isAsciiText } from './unicodeText';
import { arr, asciiString, newHash, realClassOf, str, stringBytes, stringFromBytes, sym, truthy } from './values';

// oxlint-disable-next-line unicorn/text-encoding-identifier-case -- Ruby exposes the canonical name with a hyphen and uppercase letters.
const RUBY_UTF8 = 'UTF-8';

export interface RegexpData {
  source: string;
  encoding: 'US-ASCII' | typeof RUBY_UTF8 | 'BINARY (ASCII-8BIT)';
  ignoreCase: boolean;
  multiline: boolean;
  extended: boolean;
  /** The compiled expression; its `lastIndex` is set before each use. */
  js: RegExp;
  sticky?: RegExp;
  byteViewSafe?: boolean;
  /** The name of each capture in group order; empty when the captures are numbered. */
  captureNames: string[];
}

export function makeRegexp(source: string, options: RegexpOptions): RObject {
  rt().spend(Math.ceil(source.length / 64));
  const extended = options.extended ?? false;
  let js: RegExp;
  try {
    js = compileRegexp(source, options);
  } catch (error) {
    if (error instanceof RegexpSourceError)
      throw rubyError(rt().c.RegexpError, `${error.message}: /${source}/${regexpSuffix(options)}`);
    throw error;
  }
  const regexp = new RObject(rt().c.Regexp);
  const data: RegexpData = {
    source,
    encoding:
      options.fixedEncoding ||
      !isAsciiText(source) ||
      hasNonAsciiRegexpEscape(source, extended) ||
      hasRegexpProperty(source, extended)
        ? options.sourceBinary
          ? 'BINARY (ASCII-8BIT)'
          : RUBY_UTF8
        : 'US-ASCII',
    ignoreCase: options.ignoreCase ?? false,
    multiline: options.multiline ?? false,
    extended,
    js,
    captureNames: regexpCaptureNames(source, extended),
  };
  regexp.data = data;
  return regexp;
}

export function normalizeSlashLiteralSource(source: string): string {
  return source.replaceAll(/(\\+)\//g, (_match, slashes: string) =>
    slashes.length % 2 === 1 ? `${slashes.slice(0, -1)}/` : `${slashes}/`
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
  const js = anchored ? (data.sticky ??= stickyRegexp(data.js)) : data.js;
  rt().spend();
  const startUnit = unitIndex(text, start);
  js.lastIndex = startUnit;
  const result = js.exec(text);
  rt().spend(anchored ? 1 : Math.ceil(((result?.index ?? text.length) - startUnit) / 64));
  if (!result?.indices) return undefined;
  rt().chargeSlots(result.indices.length * 3);
  const names: string[] = [];
  const namedGroups: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [position, name] of data.captureNames.entries()) {
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

export type MatchSnapshotPolicy = 'preserveClass' | 'plainString' | 'plainCopy';

export function matchSnapshot(source: RString, policy: MatchSnapshotPolicy = 'preserveClass'): RString {
  const cls = policy === 'preserveClass' ? source.cls : rt().c.String;
  if (source.frozen && policy !== 'plainCopy' && source.cls === cls) return source;
  const snapshot = new RString(cls, source.s);
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

export function setLiteralMatch(
  source: RString,
  text: string,
  target: string,
  from: number,
  policy: MatchSnapshotPolicy = 'plainString'
): MatchState | undefined {
  if (from < 0) {
    setLastMatch(undefined);
    return undefined;
  }
  const state: MatchState = {
    text,
    snapshot: matchSnapshot(source, policy),
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
  function* (self: RObject, args, _block, keywords) {
    const [source, options] = args;
    yield* checkRegexpKeywords(keywords);
    if (self.frozen)
      throw frozenError(
        self,
        self.data ? regexpInspect(self) : `#<${className(realClassOf(self))}:${addressOf(self)}>`
      );
    if (self.data) throw typeError('already initialized regexp');
    if (isRegexp(source)) {
      if (args.length > 1 && options !== NIL)
        rt().io.stderr.write(`main.rb:${rt().currentRow + 1}: warning: flags ignored\n`);
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
// code-gauge-allow functionCognitiveComplexity 28 -- The ordered cases for Ruby regexp encoding and match state share state; splitting them solely for the metric would hide their sequencing.
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
  const original = dataOf(regexp);
  const data = regexpOuterOptions(original.source, original);
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
  // oxlint-disable-next-line no-control-regex -- Ruby descriptions escape nonprinting controls while preserving whitespace.
  return source.replaceAll(/\\[\s\S]|\/|[\u0000-\u0008\u000E-\u001F\u007F]/g, (part) => {
    if (part.startsWith('\\')) return part;
    if (part === '/') return String.raw`\/`;
    return `\\x${part.codePointAt(0)!.toString(16).toUpperCase().padStart(2, '0')}`;
  });
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
def('Regexp', 'encoding', 0, (self: RObject) =>
  builtinEncoding(
    dataOf(self).encoding === 'BINARY (ASCII-8BIT)'
      ? 'ASCII_8BIT'
      : dataOf(self).encoding === RUBY_UTF8
        ? 'UTF_8'
        : 'US_ASCII'
  )
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
  arr([...new Set(dataOf(self).captureNames)].map((name) => captureNameString(self, name)))
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
  if (name === undefined) {
    const text = key instanceof RSymbol ? symbolString(key) : key;
    const shown = inspectStringEncoding(text, true)
      .slice(1, -1)
      .replaceAll(/\\(["\\#])/g, '$1');
    const message = `undefined group name reference: ${shown}`;
    throw rubyError(rt().c.IndexError, stringFromBytes(new TextEncoder().encode(message), isAsciiText(shown)));
  }
  return state.namedGroups[name];
}

function* subjectText(value: Value): Gen<RString | undefined> {
  if (value === NIL) return undefined;
  if (value instanceof RSymbol) return symbolString(value);
  return yield* toStrValue(value);
}

function matchAt(regexp: RObject, subject: RString, offset: number): MatchState | undefined {
  const text = subject.s;
  const length = charIndex(text, text.length);
  const start = offset < 0 ? offset + length : Math.min(offset, length);
  if (start < 0) return undefined;
  validateRegexpSubject(regexp, subject);
  return execAt(regexp, text, start, subject, undefined, true);
}

def('Regexp', 'match', [1, 2], function* (self: RObject, args, block) {
  const start = args.length > 1 ? yield* toIndex(args[1]) : 0;
  const subject = yield* subjectText(args[0]);
  if (subject === undefined) return setLastMatch(undefined);
  const match = setLastMatch(matchAt(self, subject, start));
  if (block && match !== NIL) return yield* callBlock(block, [match]);
  return match;
});
def('Regexp', 'match?', [1, 2], function* (self: RObject, args) {
  const start = args.length > 1 ? yield* toIndex(args[1]) : 0;
  const subject = yield* subjectText(args[0]);
  if (subject === undefined) return false;
  const text = subject.s;
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
    return yield* invoke(
      coreMethod(rt().c.Array, '[]'),
      arr(state.groups.map((_range, group) => groupText(state, group))),
      args,
      undefined,
      undefined,
      true
    );
  }
  return yield* matchIndex(self, args[0]);
});
def('MatchData', ['captures', 'deconstruct'], 0, (self: RObject) =>
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
      const selected = (yield* invoke(
        coreMethod(rt().c.Array, 'values_at'),
        all,
        [arg],
        undefined,
        undefined,
        true
      )) as RArray;
      for (const item of selected.items) values.push(item);
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
    const name = dataOf(state.regexp).captureNames[group - 1];
    return `${name ?? group}:${shown}`;
  });
  return `#<MatchData ${parts.join(' ')}>`;
}
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
  const output = new EncodedStringBuilder(limit);
  let literalBytes: number[] = [];
  const flushLiteral = (): void => {
    if (literalBytes.length === 0) return;
    const literal = stringFromBytes(Uint8Array.from(literalBytes), replacement.binary);
    literal.usAscii = replacement.usAscii;
    literalBytes = [];
    output.append(literal);
  };
  const appendLiteral = (from: number, to: number): void => {
    for (let index = from; index < to; index++) {
      literalBytes.push(replacementBytes[index]);
      if (output.length + literalBytes.length > limit) throw new ExecutionLimitError('storage');
      if (literalBytes.length === 4096) flushLiteral();
    }
  };
  let position = 0;
  let bytePosition = 0;
  for (const match of replacement.s.matchAll(/\\(k<([^>]*)(>)?|[0-9&+\\`'])/gu)) {
    rt().spend(1);
    if (match.index > position) {
      const byteEnd = bytePosition + textByteLengthOf(replacement, replacement.s.slice(position, match.index));
      appendLiteral(bytePosition, byteEnd);
      bytePosition = byteEnd;
    }
    const [, code, name, closing] = match;
    let part: RString;
    if (name !== undefined) {
      if (closing === undefined)
        throw rubyError(
          rt().c.RuntimeError,
          stringFromBytes(new TextEncoder().encode('invalid group name reference format'), true)
        );
      const group = namedCaptureGroup(
        state,
        sliceStringEncoding(replacement, match.index + 3, match.index + 3 + name.length)
      );
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
      output.append(part);
    }
    position = match.index + match[0].length;
    bytePosition += textByteLengthOf(replacement, match[0]);
  }
  if (position < replacement.s.length) {
    appendLiteral(bytePosition, replacementBytes.length);
  }
  flushLiteral();
  return output.finish();
}

function* substituteRegexp(
  self: RString,
  regexp: RObject,
  replacement: Value | undefined,
  block: RProc | undefined,
  mode: 'sub' | 'sub!' | 'gsub' | 'gsub!'
): Gen<{ value: RString; matched: boolean }> {
  return mode === 'gsub' || mode === 'gsub!'
    ? yield* substituteAllRegexp(self, regexp, replacement, block)
    : yield* substituteOnceRegexp(self, regexp, replacement, block, mode === 'sub!');
}

function* substituteOnceRegexp(
  self: RString,
  regexp: RObject,
  replacement: Value | undefined,
  block: RProc | undefined,
  bang: boolean
): Gen<{ value: RString; matched: boolean }> {
  const target = bang ? self : copyStringEncoding(self);
  replacement = yield* regexpReplacement(replacement);
  if (target.frozen) throw frozenError(target, inspectStringEncoding(target));
  const cursor = new RegexpCursor(regexp, target);
  const state = cursor.match(0);
  setLastMatch(state);
  if (!state) return { value: target, matched: false };
  const [from, to] = cursor.range(state)!;
  const piece = yield* regexpReplacementPiece(cursor, state, replacement, block, LIMITS.maxStringLength);
  cursor.refresh();
  if (target.frozen) throw frozenError(target, inspectStringEncoding(target));
  const bytes = stringBytes(cursor.snapshot);
  const retainedAscii =
    bytes.subarray(0, from).every((byte) => byte < 0x80) && bytes.subarray(to).every((byte) => byte < 0x80);
  checkStringEncodingCompatibility(
    cursor.snapshot,
    retainedAscii,
    piece,
    stringBytes(piece).every((byte) => byte < 0x80)
  );
  if (!block && !(replacement instanceof RHash)) setLastMatch(state);
  const value = joinEncodedStrings([cursor.slice(0, 0), cursor.slice(0, from), piece, cursor.slice(to)]);
  return { value, matched: true };
}

function* substituteAllRegexp(
  self: RString,
  regexp: RObject,
  replacement: Value | undefined,
  block: RProc | undefined
): Gen<{ value: RString; matched: boolean }> {
  replacement = yield* regexpReplacement(replacement);
  const cursor = new RegexpCursor(regexp, self);
  const output = new EncodedStringBuilder(LIMITS.maxStringLength, cursor.slice(0, 0));
  let position = 0;
  let search = 0;
  let lastSearch: number | undefined;
  let state = cursor.match(search);
  while (state) {
    const [from, to] = cursor.range(state)!;
    setLastMatch(state);
    const piece = yield* regexpReplacementPiece(
      cursor,
      state,
      replacement,
      block,
      LIMITS.maxStringLength - output.length
    );
    cursor.refresh();
    if (position < from) output.append(cursor.sliceSource(position, from));
    output.append(piece);
    position = to;
    lastSearch = search;
    if (from === to && to >= cursor.length) break;
    search = cursor.nextSource(state);
    if (from === to) {
      output.append(cursor.sliceSource(to, search));
      position = search;
    }
    state = cursor.match(search);
    setLastMatch(state);
  }
  output.append(cursor.sliceSource(position));
  setLastMatch(lastSearch === undefined ? undefined : cursor.match(lastSearch));
  return { value: output.finish(), matched: lastSearch !== undefined };
}

function* regexpReplacementPiece(
  cursor: RegexpCursor,
  state: MatchState,
  replacement: Value | undefined,
  block: RProc | undefined,
  limit: number
): Gen<RString> {
  const [from, to] = cursor.range(state)!;
  if (replacement instanceof RHash) {
    const key = cursor.slice(from, to);
    const entry = yield* hashGet(replacement, key);
    return yield* toSValue(entry ? entry.value : yield* hashDefault(replacement, key));
  }
  if (replacement instanceof RString) return expand(replacement, state, limit);
  return yield* toSValue(yield* callBlock(block as RProc, [cursor.slice(from, to)]));
}

function* regexpReplacement(value: Value | undefined): Gen<RHash | RString | undefined> {
  if (value === undefined || value instanceof RHash) return value;
  const hash = yield* tryImplicitConversion(value, 'to_hash');
  if (hash === undefined || hash === NIL) return yield* toStrValue(value);
  if (!(hash instanceof RHash))
    throw typeError(
      `can't convert ${realClassOf(value).name} to Hash (${realClassOf(value).name}#to_hash gives ${realClassOf(hash).name})`
    );
  return hash;
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
    if (bang && global && self.frozen) throw frozenError(self, inspectStringEncoding(self));
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
  const regexp = args[0] as RObject;
  const source = dataOf(regexp).source;
  const literalSeparator = source === '' || source === ' ';
  if (!literalSeparator) setLastMatch(undefined);
  const cursor = new RegexpCursor(regexp, self);
  if (source === '') return yield* splitCharacters(self, cursor, limit, block);
  return yield* splitRegexp(self, cursor, limit, block, !literalSeparator);
});

// code-gauge-allow functionCognitiveComplexity 29 -- Native split sequencing shares the nullable-match state, field/capture emission, limit checks and terminal match state.
// code-gauge-allow functionNcss 40 -- Native split sequencing keeps the ordered empty-match transitions, field/capture emissions and limit break in one loop.
function* splitRegexp(
  self: RString,
  cursor: RegexpCursor,
  limit: number,
  block: RProc | undefined,
  trackMatch: boolean
): Gen {
  if (cursor.length === 0) return block ? self : arr([]);
  const parts: RString[] = [];
  const emit = splitEmitter(cursor, limit, block, parts);
  let fields = 0;
  let position = 0;
  let search = 0;
  let lastNull = false;
  for (;;) {
    const state = cursor.match(search);
    if (trackMatch) setLastMatch(state);
    if (!state) break;
    const [from, to] = cursor.range(state)!;
    if (search === from && from === to) {
      if (lastNull) {
        yield* emit(position, position + (cursor.sourceCharacterLength(position) ?? 1));
        position = search;
      } else {
        search = cursor.nextSource(state);
        lastNull = true;
        continue;
      }
    } else {
      yield* emit(position, from);
      position = search = to;
    }
    lastNull = false;
    for (let group = 1; group < state.groups.length; group++) {
      const range = cursor.range(state, group);
      if (range) yield* emit(range[0], range[1]);
    }
    fields++;
    if (limit > 0 && fields >= limit - 1) break;
    if (trackMatch) setLastMatch(state);
  }
  if (limit !== 0 || position < cursor.length) yield* emit(position, cursor.length);
  return block ? self : arr(parts);
}

function* splitCharacters(self: RString, cursor: RegexpCursor, limit: number, block: RProc | undefined): Gen {
  if (cursor.length === 0) return block ? self : arr([]);
  const parts: RString[] = [];
  const emit = splitEmitter(cursor, limit, block, parts);
  let position = 0;
  let fields = 0;
  while (position < cursor.length && (limit <= 0 || fields < limit - 1)) {
    rt().spend();
    const width = cursor.sourceCharacterLength(position, true);
    if (width === undefined) break;
    const next = position + width;
    yield* emit(position, next);
    fields++;
    position = next;
  }
  yield* emit(position, cursor.length);
  return block ? self : arr(parts);
}

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
  if (self.frozen) throw frozenError(self, inspectStringEncoding(self));
  const state = execAt(args[0] as RObject, self.s, 0, self);
  setLastMatch(state);
  if (!state) return NIL;
  const ranges = matchByteRanges(state);
  const range = args.length > 1 ? yield* sliceCaptureRange(state, args[1], ranges) : ranges[0];
  if (range === 'unmatched') return sliceStringEncoding(self, 0, 0);
  if (!range) return NIL;
  const [from, to] = range;
  const bytes = regexpEditBytes(self, to);
  const removed = stringFromBytes(bytes.subarray(from, to), self.binary, self.usAscii);
  const remainder = joinEncodedStrings(
    [
      stringFromBytes(bytes.subarray(0, from), self.binary, self.usAscii),
      stringFromBytes(bytes.subarray(to), self.binary, self.usAscii),
    ],
    LIMITS.maxStringLength
  );
  setBytes(self, stringBytes(remainder), remainder.binary);
  self.usAscii = remainder.usAscii;
  return removed;
});
function* sliceCaptureRange(
  state: MatchState,
  key: Value,
  ranges: (readonly [number, number] | undefined)[]
): Gen<readonly [number, number] | 'unmatched' | undefined> {
  if (key instanceof RString || key instanceof RSymbol) {
    return ranges[namedCaptureGroup(state, key)] ?? 'unmatched';
  }
  let group = yield* toIndex(key);
  if (group < 0) group += state.groups.length;
  return group >= 0 && group < state.groups.length ? (ranges[group] ?? 'unmatched') : undefined;
}
// code-gauge-allow functionCognitiveComplexity 16 -- Regexp assignment distinguishes numeric and named captures and preserves Ruby's unmatched-group errors.
wrapFirst('[]=', function* (self, args) {
  const state = execAt(args[0] as RObject, self.s, 0, self);
  setLastMatch(state);
  if (!state) throw indexError('regexp not matched');
  const ranges = matchByteRanges(state);
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
  const range = ranges[group];
  if (!range) throw indexError(`regexp group ${group} not matched`);
  const replacement = yield* toStrValue(args.at(-1) as Value);
  checkStringEncodingCompatibility(
    self,
    stringBytes(self).every((byte) => byte < 0x80),
    replacement,
    stringBytes(replacement).every((byte) => byte < 0x80)
  );
  if (self.frozen) throw frozenError(self, inspectStringEncoding(self));
  const [from, to] = range;
  const bytes = regexpEditBytes(self, to);
  const result = joinEncodedStrings(
    [
      stringFromBytes(bytes.subarray(0, from), self.binary, self.usAscii),
      replacement,
      stringFromBytes(bytes.subarray(to), self.binary, self.usAscii),
    ],
    LIMITS.maxStringLength
  );
  setBytes(self, stringBytes(result), result.binary);
  self.usAscii = result.usAscii;
  return args.at(-1) as Value;
});
function regexpEditBytes(self: RString, end: number): Uint8Array {
  const bytes = stringBytes(self);
  if (end > bytes.length) throw runtimeError('string modified');
  return bytes;
}

wrapFirst(
  'start_with?',
  function* (self, args, block, previous, used) {
    for (const arg of args) {
      if (isRegexp(arg)) {
        const state = execAt(arg, self.s, 0, self, undefined, false, true);
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
  for (let position = start; position >= 0; position--) {
    const state = execAt(regexp, source.s, position, source, snapshot, true, true);
    if (state) return state;
  }
  return undefined;
}

function* asGen(value: Gen | Value): Gen {
  if (typeof value === 'object' && value !== null && Symbol.iterator in value && 'next' in value)
    return yield* value as Gen;
  return value as Value;
}

def('String', '=~', 1, function* (self: RString, [pattern]) {
  if (pattern instanceof RString) throw typeError('type mismatch: String given');
  if (!isRegexp(pattern)) {
    return yield* callMethod(pattern, '=~', [self], undefined, undefined, { fcall: true });
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
