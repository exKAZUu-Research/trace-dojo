// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity } from '../entities';
import { decodeRune, encodeRune, RUNE_ERROR, runesOf } from '../literals';
import { definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { nilPointerPanic } from '../runtimeErrors';
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
  const pattern = (table.load() as GoStruct).native?.pattern as RegExp;
  return rune >= 0 && rune <= 0x10_ff_ff && pattern.test(String.fromCodePoint(rune));
}

/** Runes whose case folding goes beyond simple upper and lower case, as Unicode's CaseFolding.txt lists them. */
const FOLD_ORBITS: number[][] = [
  [0x4b, 0x6b, 0x21_2a],
  [0x53, 0x73, 0x1_7f],
  [0xc5, 0xe5, 0x21_2b],
  [0x3_92, 0x3_b2, 0x3_d0],
  [0x3_95, 0x3_b5, 0x3_f5],
  [0x3_98, 0x3_b8, 0x3_d1, 0x3_f4],
  [0x3_99, 0x3_b9, 0x1f_be, 0x3_45],
  [0x3_9a, 0x3_ba, 0x3_f0],
  [0x3_9c, 0x3_bc, 0xb5],
  [0x3_a0, 0x3_c0, 0x3_d6],
  [0x3_a1, 0x3_c1, 0x3_f1],
  [0x3_a3, 0x3_c2, 0x3_c3],
  [0x3_a6, 0x3_c6, 0x3_d5],
  [0x3_a9, 0x3_c9, 0x21_26],
];

/** `unicode.SimpleFold`: the next rune, cyclically, among those equivalent under simple case folding. */
function simpleFold(rune: number): number {
  if (rune < 0 || rune > 0x10_ff_ff) return rune;
  const orbit = FOLD_ORBITS.find((candidates) => candidates.includes(rune)) ?? [
    ...new Set([rune, unicode.toUpper(rune), unicode.toLower(rune)]),
  ];
  const sorted = orbit.toSorted((a, b) => a - b);
  return sorted.find((candidate) => candidate > rune) ?? sorted[0];
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
  SimpleFold: nativeFunction('SimpleFold', fn([RUNE], [RUNE]), ([rune]) => BigInt(simpleFold(Number(rune as bigint)))),
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
    if ((slice?.length ?? 0) < encoded.length) {
      throw new RangeError('index out of range');
    }
    for (let index = 0; index < encoded.length; index++) slice?.set(index, BigInt(encoded.charCodeAt(index)));
    return BigInt(encoded.length);
  }),
  AppendRune: nativeFunction('AppendRune', fn([BYTES, RUNE], [BYTES]), ([b, rune]) =>
    byteSlice(bytesOf(b) + encodeRune(Number(rune as bigint)))
  ),
  RuneStart: nativeFunction('RuneStart', fn([BASIC.uint8], [BOOL]), ([byte]) => ((byte as bigint) & 0xc0n) !== 0x80n),
  FullRuneInString: nativeFunction('FullRuneInString', fn([STRING], [BOOL]), ([s]) => {
    const bytes = s as string;
    if (bytes.length === 0) return false;
    const { rune, size } = decodeRune(bytes, 0);
    return !(rune === RUNE_ERROR && size === 1 && bytes.length < 4 && bytes.charCodeAt(0) >= 0xc2);
  }),
};

export const UTF8_PACKAGE = definePackage(
  'unicode/utf8',
  utf8Members,
  ['FullRune', 'AppendRune'].filter((name) => !(name in utf8Members))
);
