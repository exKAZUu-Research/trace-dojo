// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity } from '../entities';
import { decodeRune } from '../literals';
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
import { find, type Input, type Matcher, ReaderInput, StringInput } from './regexpExec';
import { compileOnePass, onePassPrefix } from './regexpOnePass';
import { parse } from './regexpParse';
import { compileProg, minInputLen, progPrefix, simplify, startCond } from './regexpProg';
import { capNames, maxCap, PERL_FLAGS, POSIX_FLAGS, RegexpSyntaxError } from './regexpSyntax';
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
addMethod(
  SYNTAX_ERROR,
  'Error',
  fn([], [STRING]),
  (receiver) => {
    const [code, expr] = receiverStruct(receiver).fields as [string, string];
    return new RegexpSyntaxError(code, expr).message();
  },
  true
);

function syntaxError(error: RegexpSyntaxError): Iface {
  return new Iface(pointerTo(SYNTAX_ERROR), new Pointer(new Cell(new GoStruct([error.code, error.expr])), 'v'));
}

// Regexp ----------------------------------------------------------------------------------------------------------

/** What Go's `compile` computes for a `*regexp.Regexp`, which never changes after compilation. */
interface Compiled extends Matcher {
  expr: string;
  numSubexp: number;
  subexpNames: Slice;
  names: string[];
  prefixComplete: boolean;
}

class RegexpState implements NativeState {
  [key: string]: unknown;

  constructor(
    readonly compiled: Compiled,
    public longest: boolean
  ) {}

  clone(): RegexpState {
    return new RegexpState(this.compiled, this.longest);
  }
}

const REGEXP = opaqueType(namedType('regexp', 'Regexp', { kind: 'struct', fields: [] }));
const REGEXP_POINTER = pointerTo(REGEXP);

function compileRegexp(expr: string, mode: number, longest: boolean): RegexpState | RegexpSyntaxError {
  const runtime = currentRuntime();
  let tree;
  try {
    tree = parse(expr, mode, (cost) => runtime.spend(cost));
  } catch (error) {
    if (error instanceof RegexpSyntaxError) return error;
    throw error;
  }
  const names = capNames(tree);
  const numSubexp = maxCap(tree);
  const simplified = simplify(tree);
  const prog = compileProg(simplified, (count) => runtime.allocate(count));
  const onepass = compileOnePass(prog);
  const { prefix, complete, pc } = onepass ? onePassPrefix(prog) : { ...progPrefix(prog), pc: 0 };
  const compiled: Compiled = {
    expr,
    prog,
    onepass,
    numSubexp,
    names,
    subexpNames: new Slice(names, 0, names.length, names.length),
    cond: startCond(prog),
    minInputLen: minInputLen(simplified),
    prefix,
    prefixComplete: complete,
    prefixEnd: pc,
    prefixRune: prefix === '' ? 0 : decodeRune(prefix, 0).rune,
  };
  return new RegexpState(compiled, longest);
}

function newRegexp(state: RegexpState): Pointer {
  return new Pointer(new Cell(new GoStruct([], state)), 'v');
}

function compileFunction(name: string, mode: number, longest: boolean): Entity {
  return nativeFunction(name, fn([STRING], [REGEXP_POINTER, ERROR_TYPE]), ([expr]) => {
    const state = compileRegexp(expr as string, mode, longest);
    return state instanceof RegexpState ? [newRegexp(state), undefined] : [undefined, syntaxError(state)];
  });
}

function mustCompileFunction(name: string, compileName: string, mode: number, longest: boolean): Entity {
  return nativeFunction(name, fn([STRING], [REGEXP_POINTER]), ([expr]) => {
    const text = expr as string;
    const state = compileRegexp(text, mode, longest);
    if (state instanceof RegexpState) return newRegexp(state);
    return stringPanic(
      `regexp: ${compileName}(${canBackquote(text) ? `\`${text}\`` : quote(text)}): ${state.message()}`
    );
  });
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

/** The text to match: a string, a []byte read as its bytes, or an `io.RuneReader`. */
interface Source {
  input: Input;
  /** The length of a string or []byte, which a reader does not know. */
  length?: number;
}

function stringSource(s: string): Source {
  return { input: new StringInput(s), length: s.length };
}

function readerSource(reader: Value): Source {
  if (reader === undefined) return stringSource('');
  return {
    input: new ReaderInput(() => {
      const [rune, size, error] = callMethod(reader, 'ReadRune') as [bigint, bigint, Value];
      return error === undefined ? { rune: Number(rune), size: Number(size) } : undefined;
    }),
  };
}

function doFind(re: RegexpState, source: Source, pos: number, ncap: number): number[] | undefined {
  const runtime = currentRuntime();
  return find(re.compiled, re.longest, source.input, source.length, pos, ncap, (cost) => runtime.spend(cost));
}

/** Go's `(*Regexp).pad`: fills the positions of the groups the program never reached with -1. */
function pad(re: RegexpState, match: number[]): number[] {
  const padded = [...match];
  while (padded.length < (1 + re.compiled.numSubexp) * 2) padded.push(-1);
  return padded;
}

/** Go's `(*Regexp).matches`: the successive matches, up to `max` when it is not negative. */
// code-gauge-allow functionCognitiveComplexity 21 -- Transcribes Go's matches step by step.
function allMatches(re: RegexpState, s: string, max: number, ncap: number): number[][] {
  const results: number[][] = [];
  if (max === 0) return results;
  const end = s.length;
  const source = stringSource(s);
  for (let pos = 0, prevMatchEnd = -1; pos <= end;) {
    const matches = doFind(re, source, pos, ncap);
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
      results.push(pad(re, matches));
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

/** An []int of capture positions as `append(dstCap, matchcap...)` and then `pad` build it. */
function positions(match: number[], appended: number): Slice {
  const chunks = [appended, ...Array.from<number>({ length: match.length - appended }).fill(1)];
  const capacity = appendedCapacity(chunks, INT);
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
function replaceAll(re: RegexpState, src: string, ncap: number, repl: (match: number[]) => string[]): string[] {
  const pieces: string[] = [];
  let lastMatchEnd = 0;
  let searchPos = 0;
  const nmatch = Math.min(ncap, re.compiled.prog.numCap);
  const source = stringSource(src);
  while (searchPos <= src.length) {
    const a = doFind(re, source, searchPos, nmatch);
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
      const index = re.compiled.names.findIndex(
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

method('String', fn([], [STRING]), (re) => re.compiled.expr);
method('Copy', fn([], [REGEXP_POINTER]), (re) => newRegexp(re.clone()));
method('Longest', fn([], []), (re) => {
  re.longest = true;
  return;
});
method('NumSubexp', fn([], [INT]), (re) => BigInt(re.compiled.numSubexp));
method('SubexpNames', fn([], [STRINGS]), (re) => re.compiled.subexpNames);
method('SubexpIndex', fn([STRING], [INT]), (re, [name]) =>
  BigInt(name === '' ? -1 : re.compiled.names.indexOf(name as string))
);
method('LiteralPrefix', fn([], [STRING, BOOL]), (re) => [re.compiled.prefix, re.compiled.prefixComplete]);

method('MatchString', fn([STRING], [BOOL]), (re, [s]) => doFind(re, stringSource(s as string), 0, 0) !== undefined);
method('Match', fn([BYTES], [BOOL]), (re, [b]) => doFind(re, stringSource(bytesOf(b)), 0, 0) !== undefined);
method('MatchReader', fn([IO_RUNE_READER], [BOOL]), (re, [r]) => doFind(re, readerSource(r), 0, 0) !== undefined);

method('FindString', fn([STRING], [STRING]), (re, [s]) => {
  const a = doFind(re, stringSource(s as string), 0, 2);
  return a ? (s as string).slice(a[0], a[1]) : '';
});
method('Find', fn([BYTES], [BYTES]), (re, [b]) => {
  const a = doFind(re, stringSource(bytesOf(b)), 0, 2);
  return a ? subslice(b, a[0], a[1]) : undefined;
});
method('FindStringIndex', fn([STRING], [INTS]), (re, [s]) => {
  const a = doFind(re, stringSource(s as string), 0, 2);
  return a ? positions(a, 2) : undefined;
});
method('FindIndex', fn([BYTES], [INTS]), (re, [b]) => {
  const a = doFind(re, stringSource(bytesOf(b)), 0, 2);
  return a ? positions(a, 2) : undefined;
});
method('FindReaderIndex', fn([IO_RUNE_READER], [INTS]), (re, [r]) => {
  const a = doFind(re, readerSource(r), 0, 2);
  return a ? positions(a, 2) : undefined;
});
method('FindStringSubmatch', fn([STRING], [STRINGS]), (re, [s]) => {
  const a = doFind(re, stringSource(s as string), 0, re.compiled.prog.numCap);
  return a ? exactSlice(submatchStrings(s as string, pad(re, a))) : undefined;
});
method('FindSubmatch', fn([BYTES], [BYTES_LIST]), (re, [b]) => {
  const a = doFind(re, stringSource(bytesOf(b)), 0, re.compiled.prog.numCap);
  return a ? exactSlice(submatchBytes(b, pad(re, a))) : undefined;
});

function submatchIndex(re: RegexpState, source: Source): Slice | undefined {
  const a = doFind(re, source, 0, re.compiled.prog.numCap);
  return a ? positions(pad(re, a), a.length) : undefined;
}

method('FindStringSubmatchIndex', fn([STRING], [INTS]), (re, [s]) => submatchIndex(re, stringSource(s as string)));
method('FindSubmatchIndex', fn([BYTES], [INTS]), (re, [b]) => submatchIndex(re, stringSource(bytesOf(b))));
method('FindReaderSubmatchIndex', fn([IO_RUNE_READER], [INTS]), (re, [r]) => submatchIndex(re, readerSource(r)));

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
    const ncap = submatches ? re.compiled.prog.numCap : 2;
    const matches = allMatches(re, s, Number(n as bigint), ncap);
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
findAllMethod('FindAllStringSubmatchIndex', STRING, INTS, true, (_, __, m) => positions(m, m.length));
findAllMethod('FindAllSubmatchIndex', BYTES, INTS, true, (_, __, m) => positions(m, m.length));

function expandNcap(re: RegexpState, template: string): number {
  return template.includes('$') ? 2 * (re.compiled.numSubexp + 1) : 2;
}

method('ReplaceAllString', fn([STRING, STRING], [STRING]), (re, [src, repl]) => {
  const s = src as string;
  const template = repl as string;
  return joinPieces(replaceAll(re, s, expandNcap(re, template), (m) => expand(re, template, s, m)));
});
method('ReplaceAllLiteralString', fn([STRING, STRING], [STRING]), (re, [src, repl]) =>
  joinPieces(replaceAll(re, src as string, 2, () => [repl as string]))
);
method('ReplaceAllStringFunc', fn([STRING, fn([STRING], [STRING])], [STRING]), (re, [src, repl]) => {
  const s = src as string;
  return joinPieces(replaceAll(re, s, 2, (m) => [callFunction(repl, [s.slice(m[0], m[1])]) as string]));
});
method('ReplaceAll', fn([BYTES, BYTES], [BYTES]), (re, [src, repl]) => {
  const s = bytesOf(src);
  const template = bytesOf(repl);
  return appendPieces(
    undefined,
    replaceAll(re, s, expandNcap(re, template), (m) => expand(re, template, s, m))
  );
});
method('ReplaceAllLiteral', fn([BYTES, BYTES], [BYTES]), (re, [src, repl]) =>
  appendPieces(
    undefined,
    replaceAll(re, bytesOf(src), 2, () => [bytesOf(repl)])
  )
);
method('ReplaceAllFunc', fn([BYTES, fn([BYTES], [BYTES])], [BYTES]), (re, [src, repl]) =>
  appendPieces(
    undefined,
    replaceAll(re, bytesOf(src), 2, (m) => [bytesOf(callFunction(repl, [subslice(src, m[0], m[1])]) as Value)])
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
  if (re.compiled.expr.length > 0 && s.length === 0) return exactSlice(['']);
  const matches = allMatches(re, s, n, 2);
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

method('AppendText', fn([BYTES], [BYTES, ERROR_TYPE]), (re, [b]) => [appendBytes(b, re.compiled.expr), undefined]);
method('MarshalText', fn([], [BYTES, ERROR_TYPE]), (re) => [appendBytes(undefined, re.compiled.expr), undefined]);
addMethod(
  REGEXP,
  'UnmarshalText',
  fn([BYTES], [ERROR_TYPE]),
  (receiver, [text]) => {
    const struct = receiverStruct(receiver);
    const state = compileRegexp(bytesOf(text), PERL_FLAGS, false);
    if (!(state instanceof RegexpState)) return syntaxError(state);
    struct.native = state;
    return;
  },
  true
);

// Package ---------------------------------------------------------------------------------------------------------

function matchFunction(name: string, input: Type, source: (value: Value) => Source): Entity {
  return nativeFunction(name, fn([STRING, input], [BOOL, ERROR_TYPE]), ([pattern, value]) => {
    const state = compileRegexp(pattern as string, PERL_FLAGS, false);
    if (!(state instanceof RegexpState)) return [false, syntaxError(state)];
    return [doFind(state, source(value), 0, 0) !== undefined, undefined];
  });
}

const members: Record<string, Entity> = {
  Regexp: typeEntity(REGEXP),
  Compile: compileFunction('Compile', PERL_FLAGS, false),
  CompilePOSIX: compileFunction('CompilePOSIX', POSIX_FLAGS, true),
  MustCompile: mustCompileFunction('MustCompile', 'Compile', PERL_FLAGS, false),
  MustCompilePOSIX: mustCompileFunction('MustCompilePOSIX', 'CompilePOSIX', POSIX_FLAGS, true),
  MatchString: matchFunction('MatchString', STRING, (s) => stringSource(s as string)),
  Match: matchFunction('Match', BYTES, (b) => stringSource(bytesOf(b))),
  MatchReader: matchFunction('MatchReader', IO_RUNE_READER, readerSource),
  QuoteMeta: nativeFunction('QuoteMeta', fn([STRING], [STRING]), ([s]) => quoteMeta(s as string)),
};

export const REGEXP_PACKAGE = definePackage('regexp', members);
