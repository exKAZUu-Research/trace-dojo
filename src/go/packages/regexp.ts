// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { type Matcher, RE2JS, RE2JSSyntaxException } from 're2js';

import type { Entity } from '../entities';
import { decodeRune, encodeRune, RUNE_ERROR, utf8Decode, utf8Encode } from '../literals';
import {
  addMethod,
  currentRuntime,
  definePackage,
  fn,
  namedType,
  nativeFunction,
  opaqueType,
  typeEntity,
} from '../native';
import { canBackquote, quote } from '../quote';
import { nilPointerPanic } from '../runtimeErrors';
import { grownCapacity } from '../sliceOps';
import { ERROR_TYPE, type FuncType, pointerTo, sliceOf, type Type, underlying } from '../types';
import { Cell, GoStruct, Iface, type NativeState, Pointer, Slice, type Value } from '../values';
import { IO_RUNE_READER } from './io';
import {
  appendBytes,
  BOOL,
  BYTES,
  bytesOf,
  callFunction,
  callMethod,
  INT,
  receiverStruct,
  sliceValues,
  spendFor,
  STRING,
  stringPanic,
} from './support';
import { isDigit, isLetter } from './unicodeSupport';

const INTS = sliceOf(INT);
const STRINGS = sliceOf(STRING);
const BYTES_LIST = sliceOf(BYTES);

// syntax.Error ----------------------------------------------------------------------------------------------------

const ERROR_CODE = namedType('regexp/syntax', 'ErrorCode', STRING);
addMethod(ERROR_CODE, 'String', fn([], [STRING]), (receiver) => receiver);

/** `*syntax.Error`, with its exported fields Code and Expr. */
const SYNTAX_ERROR = namedType('regexp/syntax', 'Error', {
  kind: 'struct',
  fields: [
    { name: 'Code', type: ERROR_CODE, embedded: false },
    { name: 'Expr', type: STRING, embedded: false },
  ],
});

interface SyntaxFailure {
  code: string;
  expr: string;
}

addMethod(
  SYNTAX_ERROR,
  'Error',
  fn([], [STRING]),
  (receiver) => {
    const [code, expr] = receiverStruct(receiver).fields as [string, string];
    return syntaxMessage({ code, expr });
  },
  true
);

function syntaxMessage({ code, expr }: SyntaxFailure): string {
  return `error parsing regexp: ${code}: \`${expr}\``;
}

function syntaxError({ code, expr }: SyntaxFailure): Iface {
  return new Iface(pointerTo(SYNTAX_ERROR), new Pointer(new Cell(new GoStruct([code, expr])), 'v'));
}

// Regexp ----------------------------------------------------------------------------------------------------------

class RegexpState implements NativeState {
  [key: string]: unknown;

  constructor(
    /** The expression as the program wrote it, in UTF-8 bytes. */
    readonly expr: string,
    public engine: RE2JS,
    /** The name of each group by its index, where the whole match and the unnamed groups have "". */
    readonly names: string[],
    readonly subexpNames: Slice
  ) {}

  get numSubexp(): number {
    return this.names.length - 1;
  }

  clone(): RegexpState {
    return new RegexpState(this.expr, this.engine, this.names, this.subexpNames);
  }
}

const REGEXP = opaqueType(namedType('regexp', 'Regexp', { kind: 'struct', fields: [] }));
REGEXP.unsupported = new Set(['LiteralPrefix']);
const REGEXP_POINTER = pointerTo(REGEXP);

function compileFunction(name: string): Entity {
  return nativeFunction(name, fn([STRING], [REGEXP_POINTER, ERROR_TYPE]), ([expr]) => {
    const state = compileRegexp(expr as string);
    return state instanceof RegexpState ? [newRegexp(state), undefined] : [undefined, syntaxError(state)];
  });
}

function mustCompileFunction(name: string, compileName: string): Entity {
  return nativeFunction(name, fn([STRING], [REGEXP_POINTER]), ([expr]) => {
    const text = expr as string;
    const state = compileRegexp(text);
    if (state instanceof RegexpState) return newRegexp(state);
    return stringPanic(
      `regexp: ${compileName}(${canBackquote(text) ? `\`${text}\`` : quote(text)}): ${syntaxMessage(state)}`
    );
  });
}

function compileRegexp(expr: string): RegexpState | SyntaxFailure {
  spendFor(expr.length);
  for (let at = 0; at < expr.length;) {
    const { rune, size } = decodeRune(expr, at);
    if (rune === RUNE_ERROR && size === 1) return { code: 'invalid UTF-8', expr: expr.slice(at) };
    at += size;
  }
  let engine;
  try {
    engine = RE2JS.compile(utf8Decode(expr));
  } catch (error) {
    if (!(error instanceof RE2JSSyntaxException)) throw error;
    // Go accepts groups that share a name, which the engine refuses.
    if (error.error === 'duplicate capture group name') {
      stringPanic('正規表現の中で同じ名前を複数のグループに付けることは、この採点環境では使えません。');
    }
    return { code: error.error, expr: utf8Encode(error.input ?? '') };
  }
  const names = Array.from({ length: engine.groupCount() + 1 }, () => '');
  for (const [name, index] of Object.entries(engine.namedGroups())) names[index] = utf8Encode(name);
  return new RegexpState(expr, engine, names, new Slice(names, 0, names.length, names.length));
}

function newRegexp(state: RegexpState): Pointer {
  return new Pointer(new Cell(new GoStruct([], state)), 'v');
}

function stateOf(receiver: Value): RegexpState {
  const state = receiverStruct(receiver).native;
  if (!(state instanceof RegexpState)) nilPointerPanic();
  return state;
}

/** Adds a method of `*Regexp`, whose implementation receives the regexp's state. */
function method(name: string, signature: FuncType, impl: (re: RegexpState, args: Value[]) => Value | Value[]): void {
  addMethod(REGEXP, name, signature, (receiver, args) => impl(stateOf(receiver), args), true);
}

// Matching --------------------------------------------------------------------------------------------------------

/** A text to match, whose matcher reports positions in the bytes of the text. */
interface Source {
  matcher: Matcher;
  length: number;
}

function stringSource(re: RegexpState, s: string): Source {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return { matcher: re.engine.matcher(bytes), length: s.length };
}

/** Reads the whole `io.RuneReader`, as Go permits: its matching may read arbitrarily far past a match. */
function readerSource(re: RegexpState, reader: Value): Source {
  const runtime = currentRuntime();
  const chunks: string[] = [];
  let length = 0;
  while (reader !== undefined) {
    const [rune, size, error] = callMethod(reader, 'ReadRune') as [bigint, bigint, Value];
    if (error !== undefined) break;
    // An invalid byte stays one byte, which the matcher decodes as U+FFFD of width 1 again.
    const chunk = Number(rune) === RUNE_ERROR && size === 1n ? 'ÿ' : encodeRune(Number(rune));
    chunks.push(chunk);
    length += chunk.length;
    runtime.checkStringLength(length);
    runtime.spend();
  }
  return stringSource(re, chunks.join(''));
}

/**
 * The byte positions of the leftmost match at or after `pos`, followed by those of each group when `submatches`;
 * -1 marks a group that took no part in the match.
 */
function doFind({ matcher, length }: Source, pos: number, submatches = false): number[] | undefined {
  const found = matcher.find(pos);
  spendFor((found ? matcher.end() : length) - pos);
  if (!found) return undefined;
  const match = [matcher.start(), matcher.end()];
  if (submatches) {
    for (let group = 1; group <= matcher.groupCount(); group++) match.push(matcher.start(group), matcher.end(group));
  }
  return match;
}

/** Go's `(*Regexp).matches`: the successive matches, up to `max` when it is not negative. */
// code-gauge-allow functionCognitiveComplexity 21 -- Transcribes Go's matches step by step.
function allMatches(re: RegexpState, s: string, max: number, submatches: boolean): number[][] {
  const results: number[][] = [];
  if (max === 0) return results;
  const end = s.length;
  const source = stringSource(re, s);
  for (let pos = 0, prevMatchEnd = -1; pos <= end;) {
    const matches = doFind(source, pos, submatches);
    if (!matches) break;
    let accept = true;
    if (matches[1] === pos) {
      if (matches[0] === prevMatchEnd) accept = false;
      const width = pos < end ? decodeRune(s, pos).size : 0;
      pos = width > 0 ? pos + width : end + 1;
    } else {
      pos = matches[1];
    }
    prevMatchEnd = matches[1];
    if (accept) {
      results.push(matches);
      if (results.length === max) break;
    }
  }
  return results;
}

/** The capacity of a slice built by appending chunks of these lengths to a nil slice. */
function appendedCapacity(chunks: number[], element: Type): number {
  let length = 0;
  let capacity = 0;
  for (const chunk of chunks) {
    if (chunk > 0 && length + chunk > capacity) capacity = grownCapacity(capacity, length + chunk, element);
    length += chunk;
  }
  return capacity;
}

/** A slice built as `slices.Collect` builds it, one append per element; nil when empty. */
function collect(values: Value[], element: Type): Slice | undefined {
  if (values.length === 0) return undefined;
  const capacity = appendedCapacity(
    values.map(() => 1),
    element
  );
  currentRuntime().allocate(capacity);
  const array = [...values];
  // The elements are strings or slices, whose zero values are "" and nil.
  const zero = underlying(element).kind === 'basic' ? '' : undefined;
  while (array.length < capacity) array.push(zero);
  return new Slice(array, 0, values.length, capacity);
}

/** An []int of capture positions as one `append` to a nil slice builds it. */
function positions(match: number[]): Slice {
  const capacity = appendedCapacity([match.length], INT);
  const array: Value[] = match.map(BigInt);
  while (array.length < capacity) array.push(0n);
  currentRuntime().allocate(capacity);
  return new Slice(array, 0, match.length, capacity);
}

function exactSlice(values: Value[]): Slice {
  currentRuntime().allocate(values.length);
  return new Slice(values, 0, values.length, values.length);
}

/** `b[from:to:to]`, which shares the array of the []byte. */
function subslice(b: Value, from: number, to: number): Slice | undefined {
  const slice = b as Slice | undefined;
  if (!slice) return undefined;
  return new Slice(slice.array, slice.offset + from, to - from, to - from);
}

function intsOf(value: Value): number[] {
  return sliceValues(value).map((element) => Number(element as bigint));
}

function submatchStrings(s: string, match: number[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < match.length / 2; i++)
    result.push(match[2 * i] >= 0 ? s.slice(match[2 * i], match[2 * i + 1]) : '');
  return result;
}

function submatchBytes(b: Value, match: number[]): Value[] {
  const result: Value[] = [];
  for (let i = 0; i < match.length / 2; i++) {
    result.push(match[2 * i] >= 0 ? subslice(b, match[2 * i], match[2 * i + 1]) : undefined);
  }
  return result;
}

// Replacing -------------------------------------------------------------------------------------------------------

/**
 * Go's `(*Regexp).replaceAll`, returning the pieces in the order Go appends them to its buffer; `repl` returns the
 * pieces it appends for a match.
 */
function replaceAll(re: RegexpState, src: string, submatches: boolean, repl: (match: number[]) => string[]): string[] {
  const pieces: string[] = [];
  let lastMatchEnd = 0;
  let searchPos = 0;
  const source = stringSource(re, src);
  while (searchPos <= src.length) {
    const a = doFind(source, searchPos, submatches);
    if (!a) break;
    pieces.push(src.slice(lastMatchEnd, a[0]));
    if (a[1] > lastMatchEnd || a[0] === 0) pieces.push(...repl(a));
    lastMatchEnd = a[1];
    const width = searchPos < src.length ? decodeRune(src, searchPos).size : 0;
    if (searchPos + width > a[1]) searchPos += width;
    else if (searchPos + 1 > a[1]) searchPos++;
    else searchPos = a[1];
  }
  pieces.push(src.slice(lastMatchEnd));
  return pieces;
}

function joinPieces(pieces: string[]): string {
  const runtime = currentRuntime();
  const length = pieces.reduce((sum, piece) => sum + piece.length, 0);
  runtime.checkStringLength(length);
  spendFor(length);
  return pieces.join('');
}

/** Appends each piece with its own `append`, as Go's buffer grows. */
function appendPieces(dst: Value, pieces: string[]): Slice | undefined {
  let result = dst as Slice | undefined;
  for (const piece of pieces) result = appendBytes(result, piece);
  return result;
}

/** Go's `(*Regexp).expand`, returning the pieces it appends. */
// code-gauge-allow functionCognitiveComplexity 18 -- Transcribes Go's expand step by step.
function expand(re: RegexpState, templateText: string, src: string, match: number[]): string[] {
  const pieces: string[] = [];
  let template = templateText;
  const group = (i: number): void => {
    if (2 * i + 1 < match.length && match[2 * i] >= 0) pieces.push(src.slice(match[2 * i], match[2 * i + 1]));
  };
  while (template.length > 0) {
    const dollar = template.indexOf('$');
    if (dollar === -1) break;
    pieces.push(template.slice(0, dollar));
    template = template.slice(dollar + 1);
    if (template !== '' && template[0] === '$') {
      pieces.push('$');
      template = template.slice(1);
      continue;
    }
    const extracted = extract(template);
    if (!extracted) {
      pieces.push('$');
      continue;
    }
    template = extracted.rest;
    if (extracted.num >= 0) {
      group(extracted.num);
    } else {
      const index = re.names.findIndex(
        (name, i) => extracted.name === name && 2 * i + 1 < match.length && match[2 * i] >= 0
      );
      if (index !== -1) group(index);
    }
  }
  pieces.push(template);
  return pieces;
}

// code-gauge-allow functionCognitiveComplexity 17 -- Transcribes Go's extract step by step.
function extract(text: string): { name: string; num: number; rest: string } | undefined {
  if (text === '') return undefined;
  let str = text;
  const brace = str[0] === '{';
  if (brace) str = str.slice(1);
  let i = 0;
  while (i < str.length) {
    const { rune, size } = decodeRune(str, i);
    if (!isLetter(rune) && !isDigit(rune) && rune !== 0x5f) break;
    i += size;
  }
  if (i === 0) return undefined;
  const name = str.slice(0, i);
  if (brace) {
    if (i >= str.length || str[i] !== '}') return undefined;
    i++;
  }
  let num = 0;
  for (let j = 0; j < name.length; j++) {
    if (name[j] < '0' || name[j] > '9' || num >= 1e8) {
      num = -1;
      break;
    }
    num = num * 10 + name.charCodeAt(j) - 0x30;
  }
  if (name[0] === '0' && name.length > 1) num = -1;
  return { name, num, rest: str.slice(i) };
}

const SPECIAL = new Set(String.raw`\.+*?()|[]{}^$`);

function quoteMeta(s: string): string {
  spendFor(s.length);
  let result = '';
  for (const char of s) result += SPECIAL.has(char) ? `\\${char}` : char;
  return result;
}

// Methods ---------------------------------------------------------------------------------------------------------

method('String', fn([], [STRING]), (re) => re.expr);
method('Copy', fn([], [REGEXP_POINTER]), (re) => newRegexp(re.clone()));
method('Longest', fn([], []), (re) => {
  re.engine = RE2JS.compile(re.engine.pattern(), RE2JS.LONGEST_MATCH);
  return;
});
method('NumSubexp', fn([], [INT]), (re) => BigInt(re.numSubexp));
method('SubexpNames', fn([], [STRINGS]), (re) => re.subexpNames);
method('SubexpIndex', fn([STRING], [INT]), (re, [name]) => BigInt(name === '' ? -1 : re.names.indexOf(name as string)));

method('MatchString', fn([STRING], [BOOL]), (re, [s]) => doFind(stringSource(re, s as string), 0) !== undefined);
method('Match', fn([BYTES], [BOOL]), (re, [b]) => doFind(stringSource(re, bytesOf(b)), 0) !== undefined);
method('MatchReader', fn([IO_RUNE_READER], [BOOL]), (re, [r]) => doFind(readerSource(re, r), 0) !== undefined);

method('FindString', fn([STRING], [STRING]), (re, [s]) => {
  const a = doFind(stringSource(re, s as string), 0);
  return a ? (s as string).slice(a[0], a[1]) : '';
});
method('Find', fn([BYTES], [BYTES]), (re, [b]) => {
  const a = doFind(stringSource(re, bytesOf(b)), 0);
  return a ? subslice(b, a[0], a[1]) : undefined;
});

function findIndex(source: Source, submatches = false): Slice | undefined {
  const a = doFind(source, 0, submatches);
  return a ? positions(a) : undefined;
}

method('FindStringIndex', fn([STRING], [INTS]), (re, [s]) => findIndex(stringSource(re, s as string)));
method('FindIndex', fn([BYTES], [INTS]), (re, [b]) => findIndex(stringSource(re, bytesOf(b))));
method('FindReaderIndex', fn([IO_RUNE_READER], [INTS]), (re, [r]) => findIndex(readerSource(re, r)));
method('FindStringSubmatchIndex', fn([STRING], [INTS]), (re, [s]) => findIndex(stringSource(re, s as string), true));
method('FindSubmatchIndex', fn([BYTES], [INTS]), (re, [b]) => findIndex(stringSource(re, bytesOf(b)), true));
method('FindReaderSubmatchIndex', fn([IO_RUNE_READER], [INTS]), (re, [r]) => findIndex(readerSource(re, r), true));
method('FindStringSubmatch', fn([STRING], [STRINGS]), (re, [s]) => {
  const a = doFind(stringSource(re, s as string), 0, true);
  return a ? exactSlice(submatchStrings(s as string, a)) : undefined;
});
method('FindSubmatch', fn([BYTES], [BYTES_LIST]), (re, [b]) => {
  const a = doFind(stringSource(re, bytesOf(b)), 0, true);
  return a ? exactSlice(submatchBytes(b, a)) : undefined;
});

/** Adds a `FindAll...` method, which maps each match to an element of the result. */
function findAllMethod(
  name: string,
  input: Type,
  element: Type,
  submatches: boolean,
  toElement: (text: Value, s: string, match: number[]) => Value
): void {
  method(name, fn([input, INT], [sliceOf(element)]), (re, [text, n]) => {
    const s = input === STRING ? (text as string) : bytesOf(text);
    const matches = allMatches(re, s, Number(n as bigint), submatches);
    return collect(
      matches.map((match) => toElement(text, s, match)),
      element
    );
  });
}

findAllMethod('FindAllString', STRING, STRING, false, (_, s, m) => s.slice(m[0], m[1]));
findAllMethod('FindAll', BYTES, BYTES, false, (b, _, m) => subslice(b, m[0], m[1]));
findAllMethod('FindAllStringIndex', STRING, INTS, false, (_, __, m) => exactSlice([BigInt(m[0]), BigInt(m[1])]));
findAllMethod('FindAllIndex', BYTES, INTS, false, (_, __, m) => exactSlice([BigInt(m[0]), BigInt(m[1])]));
findAllMethod('FindAllStringSubmatch', STRING, STRINGS, true, (_, s, m) => exactSlice(submatchStrings(s, m)));
findAllMethod('FindAllSubmatch', BYTES, BYTES_LIST, true, (b, _, m) => exactSlice(submatchBytes(b, m)));
findAllMethod('FindAllStringSubmatchIndex', STRING, INTS, true, (_, __, m) => positions(m));
findAllMethod('FindAllSubmatchIndex', BYTES, INTS, true, (_, __, m) => positions(m));

method('ReplaceAllString', fn([STRING, STRING], [STRING]), (re, [src, repl]) => {
  const s = src as string;
  const template = repl as string;
  return joinPieces(replaceAll(re, s, template.includes('$'), (m) => expand(re, template, s, m)));
});
method('ReplaceAllLiteralString', fn([STRING, STRING], [STRING]), (re, [src, repl]) =>
  joinPieces(replaceAll(re, src as string, false, () => [repl as string]))
);
method('ReplaceAllStringFunc', fn([STRING, fn([STRING], [STRING])], [STRING]), (re, [src, repl]) => {
  const s = src as string;
  return joinPieces(replaceAll(re, s, false, (m) => [callFunction(repl, [s.slice(m[0], m[1])]) as string]));
});
method('ReplaceAll', fn([BYTES, BYTES], [BYTES]), (re, [src, repl]) => {
  const s = bytesOf(src);
  const template = bytesOf(repl);
  return appendPieces(
    undefined,
    replaceAll(re, s, template.includes('$'), (m) => expand(re, template, s, m))
  );
});
method('ReplaceAllLiteral', fn([BYTES, BYTES], [BYTES]), (re, [src, repl]) =>
  appendPieces(
    undefined,
    replaceAll(re, bytesOf(src), false, () => [bytesOf(repl)])
  )
);
method('ReplaceAllFunc', fn([BYTES, fn([BYTES], [BYTES])], [BYTES]), (re, [src, repl]) =>
  appendPieces(
    undefined,
    replaceAll(re, bytesOf(src), false, (m) => [bytesOf(callFunction(repl, [subslice(src, m[0], m[1])]) as Value)])
  )
);
method('Expand', fn([BYTES, BYTES, BYTES, INTS], [BYTES]), (re, [dst, template, src, match]) =>
  appendPieces(dst, expand(re, bytesOf(template), bytesOf(src), intsOf(match)))
);
method('ExpandString', fn([BYTES, STRING, STRING, INTS], [BYTES]), (re, [dst, template, src, match]) =>
  appendPieces(dst, expand(re, template as string, src as string, intsOf(match)))
);

method('Split', fn([STRING, INT], [STRINGS]), (re, [text, count]) => {
  const s = text as string;
  const n = Number(count as bigint);
  if (n === 0) return;
  if (re.expr.length > 0 && s.length === 0) return exactSlice(['']);
  const matches = allMatches(re, s, n, false);
  const strings: string[] = [];
  let beg = 0;
  let end = 0;
  for (const match of matches) {
    if (n > 0 && strings.length >= n - 1) break;
    end = match[0];
    if (match[1] !== 0) strings.push(s.slice(beg, end));
    beg = match[1];
  }
  if (end !== s.length) strings.push(s.slice(beg));
  const capacity =
    strings.length > matches.length ? grownCapacity(matches.length, strings.length, STRING) : matches.length;
  const array: Value[] = [...strings];
  while (array.length < capacity) array.push('');
  currentRuntime().allocate(capacity);
  return new Slice(array, 0, strings.length, capacity);
});

method('AppendText', fn([BYTES], [BYTES, ERROR_TYPE]), (re, [b]) => [appendBytes(b, re.expr), undefined]);
method('MarshalText', fn([], [BYTES, ERROR_TYPE]), (re) => [appendBytes(undefined, re.expr), undefined]);
addMethod(
  REGEXP,
  'UnmarshalText',
  fn([BYTES], [ERROR_TYPE]),
  (receiver, [text]) => {
    const struct = receiverStruct(receiver);
    const state = compileRegexp(bytesOf(text));
    if (!(state instanceof RegexpState)) return syntaxError(state);
    struct.native = state;
    return;
  },
  true
);

// Package ---------------------------------------------------------------------------------------------------------

function matchFunction(name: string, input: Type, source: (re: RegexpState, value: Value) => Source): Entity {
  return nativeFunction(name, fn([STRING, input], [BOOL, ERROR_TYPE]), ([pattern, value]) => {
    const state = compileRegexp(pattern as string);
    if (!(state instanceof RegexpState)) return [false, syntaxError(state)];
    return [doFind(source(state, value), 0) !== undefined, undefined];
  });
}

const members: Record<string, Entity> = {
  Regexp: typeEntity(REGEXP),
  Compile: compileFunction('Compile'),
  MustCompile: mustCompileFunction('MustCompile', 'Compile'),
  MatchString: matchFunction('MatchString', STRING, (re, s) => stringSource(re, s as string)),
  Match: matchFunction('Match', BYTES, (re, b) => stringSource(re, bytesOf(b))),
  MatchReader: matchFunction('MatchReader', IO_RUNE_READER, readerSource),
  QuoteMeta: nativeFunction('QuoteMeta', fn([STRING], [STRING]), ([s]) => quoteMeta(s as string)),
};

export const REGEXP_PACKAGE = definePackage('regexp', members);
