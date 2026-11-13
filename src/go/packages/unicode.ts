// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity } from '../entities';
import { decodeRune, encodeRune, RUNE_ERROR, runesOf } from '../literals';
import { definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { indexPanic, nilPointerPanic } from '../runtimeErrors';
import { BASIC, pointerTo, RUNE, sliceOf } from '../types';
import { Cell, GoStruct, Pointer, type Value } from '../values';
import { BOOL, BYTES, byteSlice, bytesOf, INT, sliceValues, STRING } from './support';
import * as unicode from './unicodeSupport';

function predicate(name: string, test: (rune: number) => boolean): Entity {
  return nativeFunction(name, fn([RUNE], [BOOL]), ([rune]) => test(Number(rune as bigint)));
}

function mapping(name: string, map: (rune: number) => number): Entity {
  return nativeFunction(name, fn([RUNE], [RUNE]), ([rune]) => BigInt(map(Number(rune as bigint))));
}

function runeConstant(name: string, value: number): Entity {
  return {
    kind: 'const',
    name,
    type: BASIC.untypedRune,
    value: { kind: 'int', value: BigInt(value) },
    span: { row: 0, column: 0 },
    used: true,
  };
}

/** `*unicode.RangeTable`, which this environment represents by the Unicode property that it tests. */
const RANGE_TABLE = namedType('unicode', 'RangeTable', { kind: 'struct', fields: [] });
const RANGE_TABLE_POINTER = pointerTo(RANGE_TABLE);

const TABLES: Record<string, RegExp> = {
  Letter: /^\p{L}$/u,
  L: /^\p{L}$/u,
  Digit: /^\p{Nd}$/u,
  Nd: /^\p{Nd}$/u,
  Number: /^\p{N}$/u,
  N: /^\p{N}$/u,
  Upper: /^\p{Lu}$/u,
  Lu: /^\p{Lu}$/u,
  Lower: /^\p{Ll}$/u,
  Ll: /^\p{Ll}$/u,
  Punct: /^\p{P}$/u,
  P: /^\p{P}$/u,
  Symbol: /^\p{S}$/u,
  S: /^\p{S}$/u,
  Space: /^\p{Zs}$|^[\t\n\v\f\r\u0085\u2028\u2029]$/u,
  Mark: /^\p{M}$/u,
  Han: /^\p{Script=Han}$/u,
  Hiragana: /^\p{Script=Hiragana}$/u,
  Katakana: /^\p{Script=Katakana}$/u,
  Latin: /^\p{Script=Latin}$/u,
  Greek: /^\p{Script=Greek}$/u,
  Cyrillic: /^\p{Script=Cyrillic}$/u,
  Hangul: /^\p{Script=Hangul}$/u,
};

const tableValues = new Map(
  Object.entries(TABLES).map(([name, pattern]) => [name, new Pointer(new Cell(new GoStruct([], { pattern })), 'v')])
);

function inTable(table: Value, rune: number): boolean {
  if (!(table instanceof Pointer)) nilPointerPanic();
  const pattern = (table.load() as GoStruct).native?.pattern as RegExp | undefined;
  return pattern !== undefined && rune >= 0 && rune <= 0x10_ff_ff && pattern.test(String.fromCodePoint(rune));
}

const unicodeMembers: Record<string, Entity> = {
  RangeTable: typeEntity(RANGE_TABLE),
  ...Object.fromEntries(
    [...tableValues].map(([name, value]): [string, Entity] => [
      name,
      {
        kind: 'var',
        name,
        type: RANGE_TABLE_POINTER,
        span: { row: 0, column: 0 },
        used: true,
        boxed: false,
        owner: undefined,
        slot: -1,
        library: () => value,
      },
    ])
  ),
  Is: nativeFunction('Is', fn([RANGE_TABLE_POINTER, RUNE], [BOOL]), ([table, rune]) =>
    inTable(table, Number(rune as bigint))
  ),
  In: nativeFunction('In', fn([RUNE, sliceOf(RANGE_TABLE_POINTER)], [BOOL], true), ([rune, tables]) =>
    sliceValues(tables).some((table) => inTable(table, Number(rune as bigint)))
  ),
  SimpleFold: nativeFunction('SimpleFold', fn([RUNE], [RUNE]), ([rune]) =>
    BigInt(unicode.simpleFold(Number(rune as bigint)))
  ),
  IsLetter: predicate('IsLetter', unicode.isLetter),
  IsDigit: predicate('IsDigit', unicode.isDigit),
  IsNumber: predicate('IsNumber', unicode.isNumber),
  IsSpace: predicate('IsSpace', unicode.isSpace),
  IsUpper: predicate('IsUpper', unicode.isUpper),
  IsLower: predicate('IsLower', unicode.isLower),
  IsTitle: predicate('IsTitle', unicode.isTitle),
  IsPunct: predicate('IsPunct', unicode.isPunct),
  IsSymbol: predicate('IsSymbol', unicode.isSymbol),
  IsMark: predicate('IsMark', unicode.isMark),
  IsControl: predicate('IsControl', unicode.isControl),
  IsGraphic: predicate('IsGraphic', unicode.isGraphic),
  IsPrint: predicate(
    'IsPrint',
    (rune) => rune === 0x20 || (unicode.isGraphic(rune) && !/^\p{Zs}$/u.test(String.fromCodePoint(rune)))
  ),
  ToUpper: mapping('ToUpper', unicode.toUpper),
  ToLower: mapping('ToLower', unicode.toLower),
  ToTitle: mapping('ToTitle', unicode.toTitle),
  MaxRune: runeConstant('MaxRune', 0x10_ff_ff),
  ReplacementChar: runeConstant('ReplacementChar', RUNE_ERROR),
  MaxASCII: runeConstant('MaxASCII', 0x7f),
  MaxLatin1: runeConstant('MaxLatin1', 0xff),
};

export const UNICODE_PACKAGE = definePackage('unicode', unicodeMembers, [
  'IsOneOf',
  'To',
  'UpperCase',
  'LowerCase',
  'TitleCase',
  'SpecialCase',
  'TurkishCase',
  'CaseRanges',
  'Categories',
  'Scripts',
  'Properties',
  'GraphicRanges',
  'PrintRanges',
]);

function runeLength(rune: number): number {
  if (rune < 0) return -1;
  if (rune < 0x80) return 1;
  if (rune < 0x8_00) return 2;
  if (rune >= 0xd8_00 && rune <= 0xdf_ff) return -1;
  if (rune < 0x1_00_00) return 3;
  if (rune <= 0x10_ff_ff) return 4;
  return -1;
}

function lastRune(bytes: string): [number, number] {
  if (bytes.length === 0) return [RUNE_ERROR, 0];
  for (let start = bytes.length - 1; start >= Math.max(0, bytes.length - 4); start--) {
    const byte = bytes.charCodeAt(start);
    if (byte < 0x80 || byte >= 0xc0) {
      const { rune, size } = decodeRune(bytes, start);
      return start + size === bytes.length ? [rune, size] : [RUNE_ERROR, 1];
    }
  }
  return [RUNE_ERROR, 1];
}

function isValid(bytes: string): boolean {
  for (let at = 0; at < bytes.length;) {
    const { rune, size } = decodeRune(bytes, at);
    if (rune === RUNE_ERROR && size === 1) return false;
    at += size;
  }
  return true;
}

export function fullRune(bytes: string): boolean {
  const n = bytes.length;
  if (n === 0) return false;
  const b0 = bytes.charCodeAt(0);
  if (b0 < 0xc2 || b0 > 0xf4) return true;
  let size: number;
  let lo1 = 0x80;
  let hi1 = 0xbf;
  if (b0 <= 0xdf) {
    size = 2;
  } else if (b0 <= 0xef) {
    size = 3;
    if (b0 === 0xe0) lo1 = 0xa0;
    else if (b0 === 0xed) hi1 = 0x9f;
  } else {
    size = 4;
    if (b0 === 0xf0) lo1 = 0x90;
    else if (b0 === 0xf4) hi1 = 0x8f;
  }
  if (n >= size) return true;
  if (n > 1) {
    const b1 = bytes.charCodeAt(1);
    if (b1 < lo1 || b1 > hi1) return true;
  }
  if (n > 2) {
    const b2 = bytes.charCodeAt(2);
    if (b2 < 0x80 || b2 > 0xbf) return true;
  }
  return false;
}

const utf8Members: Record<string, Entity> = {
  RuneError: runeConstant('RuneError', RUNE_ERROR),
  UTFMax: {
    kind: 'const',
    name: 'UTFMax',
    type: BASIC.untypedInt,
    value: { kind: 'int', value: 4n },
    span: { row: 0, column: 0 },
    used: true,
  },
  RuneSelf: {
    kind: 'const',
    name: 'RuneSelf',
    type: BASIC.untypedInt,
    value: { kind: 'int', value: 0x80n },
    span: { row: 0, column: 0 },
    used: true,
  },
  MaxRune: runeConstant('MaxRune', 0x10_ff_ff),
  RuneCountInString: nativeFunction('RuneCountInString', fn([STRING], [INT]), ([s]) =>
    BigInt(runesOf(s as string).length)
  ),
  RuneCount: nativeFunction('RuneCount', fn([BYTES], [INT]), ([b]) => BigInt(runesOf(bytesOf(b)).length)),
  RuneLen: nativeFunction('RuneLen', fn([RUNE], [INT]), ([rune]) => BigInt(runeLength(Number(rune as bigint)))),
  ValidString: nativeFunction('ValidString', fn([STRING], [BOOL]), ([s]) => isValid(s as string)),
  Valid: nativeFunction('Valid', fn([BYTES], [BOOL]), ([b]) => isValid(bytesOf(b))),
  ValidRune: nativeFunction('ValidRune', fn([RUNE], [BOOL]), ([rune]) => runeLength(Number(rune as bigint)) > 0),
  DecodeRuneInString: nativeFunction('DecodeRuneInString', fn([STRING], [RUNE, INT]), ([s]) => {
    if ((s as string).length === 0) return [BigInt(RUNE_ERROR), 0n];
    const { rune, size } = decodeRune(s as string, 0);
    return [BigInt(rune), BigInt(size)];
  }),
  DecodeRune: nativeFunction('DecodeRune', fn([BYTES], [RUNE, INT]), ([b]) => {
    const bytes = bytesOf(b);
    if (bytes.length === 0) return [BigInt(RUNE_ERROR), 0n];
    const { rune, size } = decodeRune(bytes, 0);
    return [BigInt(rune), BigInt(size)];
  }),
  DecodeLastRuneInString: nativeFunction('DecodeLastRuneInString', fn([STRING], [RUNE, INT]), ([s]) => {
    const [rune, size] = lastRune(s as string);
    return [BigInt(rune), BigInt(size)];
  }),
  DecodeLastRune: nativeFunction('DecodeLastRune', fn([BYTES], [RUNE, INT]), ([b]) => {
    const [rune, size] = lastRune(bytesOf(b));
    return [BigInt(rune), BigInt(size)];
  }),
  EncodeRune: nativeFunction('EncodeRune', fn([BYTES, RUNE], [INT]), ([b, rune]) => {
    const encoded = encodeRune(Number(rune as bigint));
    const slice = b as { length: number; set(index: number, value: unknown): void } | undefined;
    const length = slice?.length ?? 0;
    if (length < encoded.length) indexPanic(encoded.length - 1, length);
    for (let index = 0; index < encoded.length; index++) slice?.set(index, BigInt(encoded.charCodeAt(index)));
    return BigInt(encoded.length);
  }),
  AppendRune: nativeFunction('AppendRune', fn([BYTES, RUNE], [BYTES]), ([b, rune]) =>
    byteSlice(bytesOf(b) + encodeRune(Number(rune as bigint)))
  ),
  RuneStart: nativeFunction('RuneStart', fn([BASIC.uint8], [BOOL]), ([byte]) => ((byte as bigint) & 0xc0n) !== 0x80n),
  FullRuneInString: nativeFunction('FullRuneInString', fn([STRING], [BOOL]), ([s]) => fullRune(s as string)),
};

export const UTF8_PACKAGE = definePackage(
  'unicode/utf8',
  utf8Members,
  ['FullRune', 'AppendRune'].filter((name) => !(name in utf8Members))
);
