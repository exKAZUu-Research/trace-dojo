// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { decodeRune, encodeRune, RUNE_ERROR, runesOf } from '../literals';
import { addMethod, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { GoPanic } from '../runtime';
import { BASIC, ERROR_TYPE, funcType, pointerTo, RUNE, sliceOf } from '../types';
import { Cell, GoFunc, GoStruct, Pointer, type Value } from '../values';
import { EOF } from './io';
import { seqOf } from './iter';
import { BOOL, bytesOf, callFunction, INT, sliceOfValues, sliceValues, spendFor, STRING } from './support';
import { isSpace, mapRunes, toLower, toTitle, toUpper } from './unicodeSupport';

const STRINGS = sliceOf(STRING);
const RUNE_PREDICATE = funcType([RUNE], [BOOL]);
const BYTES = sliceOf(BASIC.uint8);

function index(s: string, sub: string): number {
  return s.indexOf(sub);
}

function runeIndex(s: string, predicate: (rune: number) => boolean, fromEnd = false): number {
  let found = -1;
  for (let at = 0; at < s.length;) {
    const { rune, size } = decodeRune(s, at);
    if (predicate(rune)) {
      if (!fromEnd) return at;
      found = at;
    }
    at += size;
  }
  return found;
}

function containsRune(chars: string, rune: number): boolean {
  return runesOf(chars).includes(rune);
}

/** `strings.Split` and its variants: `after` keeps the separator, and `limit` caps the number of pieces. */
function split(s: string, sep: string, after: boolean, limit: number): string[] {
  if (limit === 0) return [];
  if (sep === '') {
    const pieces: string[] = [];
    let at = 0;
    while (at < s.length && (limit < 0 || pieces.length < limit - 1)) {
      const { size } = decodeRune(s, at);
      pieces.push(s.slice(at, at + size));
      at += size;
    }
    if (at < s.length) pieces.push(s.slice(at));
    return pieces;
  }
  const pieces: string[] = [];
  let start = 0;
  while (limit < 0 || pieces.length < limit - 1) {
    const found = s.indexOf(sep, start);
    if (found === -1) break;
    pieces.push(s.slice(start, after ? found + sep.length : found));
    start = found + sep.length;
  }
  pieces.push(s.slice(start));
  return pieces;
}

/** An iterator over strings computed in advance, which stops when the yield function returns false. */
function sequence(pieces: string[]): GoFunc {
  return new GoFunc(([yieldFunction]) => {
    for (const piece of pieces) if (callFunction(yieldFunction, [piece]) === false) break;
    return;
  });
}

/** `strings.Lines`: the lines of a text, each with its newline, the last one without when the text lacks one. */
function lines(s: string): string[] {
  const result: string[] = [];
  let start = 0;
  while (start < s.length) {
    const end = s.indexOf('\n', start);
    if (end === -1) {
      result.push(s.slice(start));
      break;
    }
    result.push(s.slice(start, end + 1));
    start = end + 1;
  }
  return result;
}

function fields(s: string, isSeparator: (rune: number) => boolean): string[] {
  const pieces: string[] = [];
  let start = -1;
  for (let at = 0; at < s.length;) {
    const { rune, size } = decodeRune(s, at);
    if (isSeparator(rune)) {
      if (start >= 0) pieces.push(s.slice(start, at));
      start = -1;
    } else if (start < 0) {
      start = at;
    }
    at += size;
  }
  if (start >= 0) pieces.push(s.slice(start));
  return pieces;
}

function trimLeft(s: string, predicate: (rune: number) => boolean): string {
  let at = 0;
  while (at < s.length) {
    const { rune, size } = decodeRune(s, at);
    if (!predicate(rune)) break;
    at += size;
  }
  return s.slice(at);
}

function trimRight(s: string, predicate: (rune: number) => boolean): string {
  const runes: { rune: number; at: number }[] = [];
  for (let at = 0; at < s.length;) {
    const { rune, size } = decodeRune(s, at);
    runes.push({ rune, at });
    at += size;
  }
  let end = s.length;
  for (let index = runes.length - 1; index >= 0 && predicate(runes[index].rune); index--) end = runes[index].at;
  return s.slice(0, end);
}

function cutset(chars: string): (rune: number) => boolean {
  const set = new Set(runesOf(chars));
  return (rune) => set.has(rune);
}

function replace(s: string, old: string, replacement: string, count: number): string {
  if (old === replacement || count === 0) return s;
  let result = '';
  let start = 0;
  let replaced = 0;
  if (old === '') {
    // An empty old string matches at the start and after each rune.
    let at = 0;
    for (;;) {
      if (count >= 0 && replaced >= count) break;
      result += replacement;
      replaced++;
      if (at >= s.length) {
        return result;
      }
      const { size } = decodeRune(s, at);
      result += s.slice(at, at + size);
      at += size;
    }
    return result + s.slice(at);
  }
  for (;;) {
    if (count >= 0 && replaced >= count) break;
    const found = s.indexOf(old, start);
    if (found === -1) break;
    result += s.slice(start, found) + replacement;
    start = found + old.length;
    replaced++;
  }
  return result + s.slice(start);
}

function equalFold(a: string, b: string): boolean {
  const x = runesOf(a);
  const y = runesOf(b);
  if (x.length !== y.length) return false;
  return x.every(
    (rune, index) => rune === y[index] || toLower(rune) === toLower(y[index]) || toUpper(rune) === toUpper(y[index])
  );
}

/** The separators of words for `strings.Title`, as its isSeparator decides. */
function isWordSeparator(rune: number): boolean {
  if (rune <= 0x7f) {
    const char = String.fromCodePoint(rune);
    return !/[\dA-Za-z_]/.test(char);
  }
  if (/^[\p{L}\p{Nd}]$/u.test(String.fromCodePoint(rune))) return false;
  return isSpace(rune);
}

function predicateOf(fnValue: Value): (rune: number) => boolean {
  return (rune) => callFunction(fnValue, [BigInt(rune)]) === true;
}

function stringList(values: string[]): Value {
  return sliceOfValues(values);
}

function bytesString(value: Value): string {
  return value as string;
}

// Builder -----------------------------------------------------------------------------------------------------------

/** `strings.Builder`, whose text lives outside Go's view of its fields, as a JavaScript string of bytes. */
export const BUILDER = namedType('strings', 'Builder', { kind: 'struct', fields: [] });

function builderOf(receiver: Value): { builder: string } {
  const struct = (receiver as Pointer | undefined)?.load() as GoStruct | undefined;
  if (!struct) throw new GoPanic(newError('invalid memory address or nil pointer dereference'));
  struct.native ??= { builder: '' };
  return struct.native as { builder: string };
}

function appendToBuilder(receiver: Value, text: string): Value[] {
  const state = builderOf(receiver);
  state.builder += text;
  spendFor(text.length);
  return [BigInt(text.length), undefined];
}

addMethod(
  BUILDER,
  'WriteString',
  fn([STRING], [INT, ERROR_TYPE]),
  (receiver, [text]) => appendToBuilder(receiver, text as string),
  true
);
addMethod(
  BUILDER,
  'WriteByte',
  fn([BASIC.uint8], [ERROR_TYPE]),
  (receiver, [byte]) => {
    appendToBuilder(receiver, String.fromCharCode(Number(byte as bigint)));
    return;
  },
  true
);
addMethod(
  BUILDER,
  'WriteRune',
  fn([RUNE], [INT, ERROR_TYPE]),
  (receiver, [rune]) => appendToBuilder(receiver, encodeRune(Number(rune as bigint))),
  true
);
addMethod(
  BUILDER,
  'Write',
  fn([BYTES], [INT, ERROR_TYPE]),
  (receiver, [bytes]) => appendToBuilder(receiver, bytesOf(bytes)),
  true
);
addMethod(BUILDER, 'String', fn([], [STRING]), (receiver) => builderOf(receiver).builder, true);
addMethod(BUILDER, 'Len', fn([], [INT]), (receiver) => BigInt(builderOf(receiver).builder.length), true);
addMethod(BUILDER, 'Cap', fn([], [INT]), (receiver) => BigInt(builderOf(receiver).builder.length), true);
addMethod(
  BUILDER,
  'Reset',
  fn([], []),
  (receiver) => {
    builderOf(receiver).builder = '';
    return;
  },
  true
);
addMethod(
  BUILDER,
  'Grow',
  fn([INT], []),
  (receiver, [count]) => {
    if ((count as bigint) < 0n) throw new GoPanic(newError('strings.Builder.Grow: negative count'));
    return;
  },
  true
);

// Reader ------------------------------------------------------------------------------------------------------------

export const READER = namedType('strings', 'Reader', { kind: 'struct', fields: [] });

function readerOf(receiver: Value): { text: string; offset: number } {
  return ((receiver as Pointer).load() as GoStruct).native as { text: string; offset: number };
}

addMethod(
  READER,
  'Read',
  fn([BYTES], [INT, ERROR_TYPE]),
  (receiver, [buffer]) => {
    const state = readerOf(receiver);
    if (state.offset >= state.text.length) return [0n, EOF];
    const slice = buffer as { length: number; set(index: number, value: Value): void } | undefined;
    const count = Math.min(slice?.length ?? 0, state.text.length - state.offset);
    for (let at = 0; at < count; at++) slice?.set(at, BigInt(state.text.charCodeAt(state.offset + at)));
    state.offset += count;
    return [BigInt(count), undefined];
  },
  true
);
addMethod(
  READER,
  'ReadByte',
  fn([], [BASIC.uint8, ERROR_TYPE]),
  (receiver) => {
    const state = readerOf(receiver);
    if (state.offset >= state.text.length) return [0n, EOF];
    return [BigInt(state.text.charCodeAt(state.offset++)), undefined];
  },
  true
);
addMethod(
  READER,
  'ReadRune',
  fn([], [RUNE, INT, ERROR_TYPE]),
  (receiver) => {
    const state = readerOf(receiver);
    if (state.offset >= state.text.length) return [0n, 0n, EOF];
    const { rune, size } = decodeRune(state.text, state.offset);
    state.offset += size;
    return [BigInt(rune), BigInt(size), undefined];
  },
  true
);
addMethod(
  READER,
  'Len',
  fn([], [INT]),
  (receiver) => {
    const state = readerOf(receiver);
    return BigInt(Math.max(state.text.length - state.offset, 0));
  },
  true
);
addMethod(READER, 'Size', fn([], [BASIC.int64]), (receiver) => BigInt(readerOf(receiver).text.length), true);

// Replacer ----------------------------------------------------------------------------------------------------------

const REPLACER = namedType('strings', 'Replacer', { kind: 'struct', fields: [] });

/** Replaces at each position the first old string, in argument order, that matches there, without overlaps. */
function replaceAllPairs(s: string, pairs: string[]): string {
  let result = '';
  let at = 0;
  const hasEmpty = pairs.some((value, index) => index % 2 === 0 && value === '');
  while (at <= s.length) {
    let matched = false;
    for (let pair = 0; pair < pairs.length; pair += 2) {
      const old = pairs[pair];
      if (old !== '' && s.startsWith(old, at)) {
        result += pairs[pair + 1];
        at += old.length;
        matched = true;
        break;
      }
      if (old === '') {
        result += pairs[pair + 1];
        break;
      }
    }
    if (matched) continue;
    if (at >= s.length) break;
    const size = hasEmpty ? decodeRune(s, at).size : 1;
    result += s.slice(at, at + size);
    at += size;
  }
  return result;
}

addMethod(
  REPLACER,
  'Replace',
  fn([STRING], [STRING]),
  (receiver, [text]) => {
    const pairs = ((receiver as Pointer).load() as GoStruct).native?.pairs as string[];
    return replaceAllPairs(text as string, pairs);
  },
  true
);

// Package -----------------------------------------------------------------------------------------------------------

const s2 =
  (impl: (a: string, b: string) => Value | Value[]) =>
  ([a, b]: Value[]) =>
    impl(a as string, b as string);

const members: Record<string, Entity> = {
  Builder: typeEntity(BUILDER),
  Reader: typeEntity(READER),
  Replacer: typeEntity(REPLACER),
  Contains: nativeFunction(
    'Contains',
    fn([STRING, STRING], [BOOL]),
    s2((a, b) => a.includes(b))
  ),
  ContainsRune: nativeFunction('ContainsRune', fn([STRING, RUNE], [BOOL]), ([s, rune]) =>
    containsRune(s as string, Number(rune as bigint))
  ),
  ContainsAny: nativeFunction(
    'ContainsAny',
    fn([STRING, STRING], [BOOL]),
    s2((s, chars) => runeIndex(s, cutset(chars)) >= 0)
  ),
  ContainsFunc: nativeFunction(
    'ContainsFunc',
    fn([STRING, RUNE_PREDICATE], [BOOL]),
    ([s, f]) => runeIndex(s as string, predicateOf(f)) >= 0
  ),
  Count: nativeFunction(
    'Count',
    fn([STRING, STRING], [INT]),
    s2((s, sub) => BigInt(sub === '' ? runesOf(s).length + 1 : split(s, sub, false, -1).length - 1))
  ),
  Cut: nativeFunction(
    'Cut',
    fn([STRING, STRING], [STRING, STRING, BOOL]),
    s2((s, sep) => {
      const found = s.indexOf(sep);
      return found === -1 ? [s, '', false] : [s.slice(0, found), s.slice(found + sep.length), true];
    })
  ),
  CutPrefix: nativeFunction(
    'CutPrefix',
    fn([STRING, STRING], [STRING, BOOL]),
    s2((s, prefix) => (s.startsWith(prefix) ? [s.slice(prefix.length), true] : [s, false]))
  ),
  CutSuffix: nativeFunction(
    'CutSuffix',
    fn([STRING, STRING], [STRING, BOOL]),
    s2((s, suffix) => (s.endsWith(suffix) ? [s.slice(0, s.length - suffix.length), true] : [s, false]))
  ),
  EqualFold: nativeFunction('EqualFold', fn([STRING, STRING], [BOOL]), s2(equalFold)),
  Fields: nativeFunction('Fields', fn([STRING], [STRINGS]), ([s]) => stringList(fields(s as string, isSpace))),
  FieldsFunc: nativeFunction('FieldsFunc', fn([STRING, RUNE_PREDICATE], [STRINGS]), ([s, f]) =>
    stringList(fields(s as string, predicateOf(f)))
  ),
  HasPrefix: nativeFunction(
    'HasPrefix',
    fn([STRING, STRING], [BOOL]),
    s2((s, prefix) => s.startsWith(prefix))
  ),
  HasSuffix: nativeFunction(
    'HasSuffix',
    fn([STRING, STRING], [BOOL]),
    s2((s, suffix) => s.endsWith(suffix))
  ),
  Index: nativeFunction(
    'Index',
    fn([STRING, STRING], [INT]),
    s2((s, sub) => BigInt(index(s, sub)))
  ),
  IndexByte: nativeFunction('IndexByte', fn([STRING, BASIC.uint8], [INT]), ([s, byte]) =>
    BigInt((s as string).indexOf(String.fromCharCode(Number(byte as bigint))))
  ),
  IndexRune: nativeFunction('IndexRune', fn([STRING, RUNE], [INT]), ([s, rune]) =>
    BigInt(runeIndex(s as string, (r) => r === Number(rune as bigint)))
  ),
  IndexAny: nativeFunction(
    'IndexAny',
    fn([STRING, STRING], [INT]),
    s2((s, chars) => BigInt(runeIndex(s, cutset(chars))))
  ),
  IndexFunc: nativeFunction('IndexFunc', fn([STRING, RUNE_PREDICATE], [INT]), ([s, f]) =>
    BigInt(runeIndex(s as string, predicateOf(f)))
  ),
  LastIndex: nativeFunction(
    'LastIndex',
    fn([STRING, STRING], [INT]),
    s2((s, sub) => BigInt(s.lastIndexOf(sub)))
  ),
  LastIndexByte: nativeFunction('LastIndexByte', fn([STRING, BASIC.uint8], [INT]), ([s, byte]) =>
    BigInt((s as string).lastIndexOf(String.fromCharCode(Number(byte as bigint))))
  ),
  LastIndexAny: nativeFunction(
    'LastIndexAny',
    fn([STRING, STRING], [INT]),
    s2((s, chars) => BigInt(runeIndex(s, cutset(chars), true)))
  ),
  LastIndexFunc: nativeFunction('LastIndexFunc', fn([STRING, RUNE_PREDICATE], [INT]), ([s, f]) =>
    BigInt(runeIndex(s as string, predicateOf(f), true))
  ),
  Join: nativeFunction('Join', fn([STRINGS, STRING], [STRING]), ([elements, sep]) => {
    const parts = sliceValues(elements) as string[];
    spendFor(parts.length);
    return parts.join(sep as string);
  }),
  Map: nativeFunction('Map', fn([funcType([RUNE], [RUNE]), STRING], [STRING]), ([mapping, s]) =>
    mapRunes(s as string, (rune) => Number(callFunction(mapping, [BigInt(rune)]) as bigint))
  ),
  Repeat: nativeFunction('Repeat', fn([STRING, INT], [STRING]), ([s, count]) => {
    const times = count as bigint;
    if (times < 0n) throw new GoPanic(newError('strings: negative Repeat count'));
    if ((s as string).length * Number(times) > 1_000_000)
      throw new GoPanic(newError('strings: Repeat output length overflow'));
    spendFor((s as string).length * Number(times));
    return (s as string).repeat(Number(times));
  }),
  Replace: nativeFunction('Replace', fn([STRING, STRING, STRING, INT], [STRING]), ([s, old, replacement, count]) =>
    replace(s as string, old as string, replacement as string, Number(count as bigint))
  ),
  ReplaceAll: nativeFunction('ReplaceAll', fn([STRING, STRING, STRING], [STRING]), ([s, old, replacement]) =>
    replace(s as string, old as string, replacement as string, -1)
  ),
  NewReplacer: nativeFunction('NewReplacer', fn([STRINGS], [pointerTo(REPLACER)], true), ([pairs]) => {
    const values = sliceValues(pairs) as string[];
    if (values.length % 2 === 1) throw new GoPanic(newError('strings.NewReplacer: odd argument count'));
    return new Pointer(new Cell(new GoStruct([], { pairs: values })), 'v');
  }),
  NewReader: nativeFunction(
    'NewReader',
    fn([STRING], [pointerTo(READER)]),
    ([s]) => new Pointer(new Cell(new GoStruct([], { text: s as string, offset: 0 })), 'v')
  ),
  SplitSeq: nativeFunction('SplitSeq', fn([STRING, STRING], [seqOf(STRING)]), ([s, sep]) =>
    sequence(split(s as string, sep as string, false, -1))
  ),
  SplitAfterSeq: nativeFunction('SplitAfterSeq', fn([STRING, STRING], [seqOf(STRING)]), ([s, sep]) =>
    sequence(split(s as string, sep as string, true, -1))
  ),
  FieldsSeq: nativeFunction('FieldsSeq', fn([STRING], [seqOf(STRING)]), ([s]) =>
    sequence(fields(s as string, isSpace))
  ),
  FieldsFuncSeq: nativeFunction('FieldsFuncSeq', fn([STRING, RUNE_PREDICATE], [seqOf(STRING)]), ([s, predicate]) =>
    sequence(fields(s as string, (rune) => callFunction(predicate, [BigInt(rune)]) === true))
  ),
  Lines: nativeFunction('Lines', fn([STRING], [seqOf(STRING)]), ([s]) => sequence(lines(s as string))),
  Split: nativeFunction(
    'Split',
    fn([STRING, STRING], [STRINGS]),
    s2((s, sep) => stringList(split(s, sep, false, -1)))
  ),
  SplitN: nativeFunction('SplitN', fn([STRING, STRING, INT], [STRINGS]), ([s, sep, n]) => {
    const pieces = split(s as string, sep as string, false, Number(n as bigint));
    return Number(n as bigint) === 0 ? undefined : stringList(pieces);
  }),
  SplitAfter: nativeFunction(
    'SplitAfter',
    fn([STRING, STRING], [STRINGS]),
    s2((s, sep) => stringList(split(s, sep, true, -1)))
  ),
  SplitAfterN: nativeFunction('SplitAfterN', fn([STRING, STRING, INT], [STRINGS]), ([s, sep, n]) => {
    const pieces = split(s as string, sep as string, true, Number(n as bigint));
    return Number(n as bigint) === 0 ? undefined : stringList(pieces);
  }),
  ToLower: nativeFunction('ToLower', fn([STRING], [STRING]), ([s]) => mapRunes(s as string, toLower)),
  ToUpper: nativeFunction('ToUpper', fn([STRING], [STRING]), ([s]) => mapRunes(s as string, toUpper)),
  Title: nativeFunction('Title', fn([STRING], [STRING]), ([s]) => {
    let previous = 0x20;
    return mapRunes(s as string, (rune) => {
      const mapped = isWordSeparator(previous) ? toTitle(rune) : rune;
      previous = rune;
      return mapped;
    });
  }),
  ToTitle: nativeFunction('ToTitle', fn([STRING], [STRING]), ([s]) => mapRunes(s as string, toTitle)),
  Trim: nativeFunction(
    'Trim',
    fn([STRING, STRING], [STRING]),
    s2((s, chars) => trimRight(trimLeft(s, cutset(chars)), cutset(chars)))
  ),
  TrimLeft: nativeFunction(
    'TrimLeft',
    fn([STRING, STRING], [STRING]),
    s2((s, chars) => trimLeft(s, cutset(chars)))
  ),
  TrimRight: nativeFunction(
    'TrimRight',
    fn([STRING, STRING], [STRING]),
    s2((s, chars) => trimRight(s, cutset(chars)))
  ),
  TrimSpace: nativeFunction('TrimSpace', fn([STRING], [STRING]), ([s]) =>
    trimRight(trimLeft(s as string, isSpace), isSpace)
  ),
  TrimPrefix: nativeFunction(
    'TrimPrefix',
    fn([STRING, STRING], [STRING]),
    s2((s, prefix) => (s.startsWith(prefix) ? s.slice(prefix.length) : s))
  ),
  TrimSuffix: nativeFunction(
    'TrimSuffix',
    fn([STRING, STRING], [STRING]),
    s2((s, suffix) => (suffix !== '' && s.endsWith(suffix) ? s.slice(0, s.length - suffix.length) : s))
  ),
  TrimFunc: nativeFunction('TrimFunc', fn([STRING, RUNE_PREDICATE], [STRING]), ([s, f]) =>
    trimRight(trimLeft(s as string, predicateOf(f)), predicateOf(f))
  ),
  TrimLeftFunc: nativeFunction('TrimLeftFunc', fn([STRING, RUNE_PREDICATE], [STRING]), ([s, f]) =>
    trimLeft(s as string, predicateOf(f))
  ),
  TrimRightFunc: nativeFunction('TrimRightFunc', fn([STRING, RUNE_PREDICATE], [STRING]), ([s, f]) =>
    trimRight(s as string, predicateOf(f))
  ),
  Compare: nativeFunction(
    'Compare',
    fn([STRING, STRING], [INT]),
    s2((a, b) => (a < b ? -1n : a > b ? 1n : 0n))
  ),
  Clone: nativeFunction('Clone', fn([STRING], [STRING]), ([s]) => bytesString(s)),
  ToValidUTF8: nativeFunction(
    'ToValidUTF8',
    fn([STRING, STRING], [STRING]),
    s2((s, replacement) => {
      let result = '';
      let invalid = false;
      for (let at = 0; at < s.length;) {
        const { rune, size } = decodeRune(s, at);
        if (rune === RUNE_ERROR && size === 1) {
          if (!invalid) result += replacement;
          invalid = true;
        } else {
          result += s.slice(at, at + size);
          invalid = false;
        }
        at += size;
      }
      return result;
    })
  ),
};

export const STRINGS_PACKAGE = definePackage(
  'strings',
  members,
  ['NewReader'].filter((name) => !(name in members))
);
