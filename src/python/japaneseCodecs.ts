// CPython's Japanese codecs: shift_jis, cp932, and euc_jp, built from the JIS tables when first used.
import { type ErrorHandling, registerCodec, type TextCodec } from './codecs';
import {
  CP932_CHANGES,
  CP932_ROW_13,
  CP932_ROWS_89_TO_92,
  CP932_ROWS_115_TO_119,
  JIS_X_0208,
  JIS_X_0212,
} from './data/japaneseCodecs';
import { encodePoints } from './unicodeCodecs';

const ILLEGAL = 'illegal multibyte sequence';
const INCOMPLETE = 'incomplete multibyte sequence';
/** The handlers CPython's multibyte codecs apply without creating an exception. */
const INLINE_HANDLERS = { encode: new Set(['ignore', 'replace']), decode: new Set(['ignore', 'replace']) };
const UNASSIGNED = ' ';
const HALFWIDTH_KATAKANA = 0xff_61;

/** A codec's mappings between code points and byte sequences, each sequence packed into one number. */
interface Tables {
  decode: Map<number, number>;
  encode: Map<number, number[]>;
}

/** Fills the mappings from rows of 94 cells, starting at `firstRow`, whose byte sequences `bytesOf` gives. */
function addRows(
  entries: [number[], number][],
  rows: string,
  firstRow: number,
  bytesOf: (row: number, cell: number) => number[]
): void {
  for (let index = 0; index < rows.length; index++) {
    const char = rows[index];
    if (char === UNASSIGNED) continue;
    entries.push([bytesOf(firstRow + Math.floor(index / 94), (index % 94) + 1), char.codePointAt(0) as number]);
  }
}

/**
 * Builds the tables from byte sequences and their characters. A character with several sequences encodes to the first
 * in byte order, as CPython's tables do, unless `extraEncodings` names another.
 */
function buildTables(entries: [number[], number][], extraEncodings: [number, number[]][] = []): Tables {
  entries.sort(([a], [b]) => (hexKey(a) < hexKey(b) ? -1 : 1));
  const decode = new Map<number, number>();
  const encode = new Map<number, number[]>();
  for (const [bytes, point] of entries) {
    decode.set(packBytes(bytes), point);
    if (!encode.has(point)) encode.set(point, bytes);
  }
  for (const [point, bytes] of extraEncodings) encode.set(point, bytes);
  return { decode, encode };
}

function hexKey(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function packBytes(bytes: readonly number[]): number {
  return bytes.reduce((packed, byte) => packed * 256 + byte, 0);
}

function singleBytes(entries: [number[], number][], from: number, to: number, firstPoint: number): void {
  for (let byte = from; byte <= to; byte++) entries.push([[byte], firstPoint + byte - from]);
}

/** The Shift_JIS bytes of a JIS row and cell, which cp932 also uses beyond row 94. */
function shiftJisBytes(row: number, cell: number): number[] {
  const lead = Math.floor((row + 1) / 2) + (row <= 62 ? 0x80 : 0xc0);
  if (row % 2 === 1) return [lead, cell + (cell <= 63 ? 0x3f : 0x40)];
  return [lead, cell + 0x9e];
}

const eucBytes = (row: number, cell: number): number[] => [row + 0xa0, cell + 0xa0];
const YEN_AND_OVERLINE: [number, number[]][] = [
  [0xa5, [0x5c]],
  [0x20_3e, [0x7e]],
];

function shiftJisTables(): Tables {
  const entries: [number[], number][] = [];
  singleBytes(entries, 0x00, 0x7f, 0x00);
  singleBytes(entries, 0xa1, 0xdf, HALFWIDTH_KATAKANA);
  addRows(entries, JIS_X_0208, 1, shiftJisBytes);
  return buildTables(entries, YEN_AND_OVERLINE);
}

function cp932Tables(): Tables {
  const entries: [number[], number][] = [];
  singleBytes(entries, 0x00, 0x80, 0x00);
  singleBytes(entries, 0xa0, 0xa0, 0xf8_f0);
  singleBytes(entries, 0xa1, 0xdf, HALFWIDTH_KATAKANA);
  singleBytes(entries, 0xfd, 0xff, 0xf8_f1);
  const jis = JIS_X_0208.split('');
  for (const [index, point] of CP932_CHANGES) jis[index] = String.fromCodePoint(point);
  addRows(entries, jis.join(''), 1, shiftJisBytes);
  addRows(entries, CP932_ROW_13, 13, shiftJisBytes);
  addRows(entries, CP932_ROWS_89_TO_92, 89, shiftJisBytes);
  for (let index = 0; index < 20 * 94; index++) {
    // The user-defined rows 95 to 114 map to the private use area in order.
    entries.push([shiftJisBytes(95 + Math.floor(index / 94), (index % 94) + 1), 0xe0_00 + index]);
  }
  addRows(entries, CP932_ROWS_115_TO_119, 115, shiftJisBytes);
  return buildTables(entries, [
    [0xa2, [0x81, 0x91]],
    [0xa3, [0x81, 0x92]],
    [0xac, [0x81, 0xca]],
    [0x20_16, [0x81, 0x61]],
    [0x22_12, [0x81, 0x7c]],
    [0x30_1c, [0x81, 0x60]],
  ]);
}

function eucJpTables(): Tables {
  const entries: [number[], number][] = [];
  singleBytes(entries, 0x00, 0x7f, 0x00);
  for (let byte = 0xa1; byte <= 0xdf; byte++) entries.push([[0x8e, byte], HALFWIDTH_KATAKANA + byte - 0xa1]);
  addRows(entries, JIS_X_0208, 1, eucBytes);
  addRows(entries, JIS_X_0212, 2, (row, cell) => [0x8f, ...eucBytes(row, cell)]);
  return buildTables(entries, YEN_AND_OVERLINE);
}

let eucJp: Tables | undefined;
const eucJpTablesOnce = (): Tables => (eucJp ??= eucJpTables());

/**
 * CPython's `jisxcommon` map: the JIS X 0208 code of a character, or its JIS X 0212 code with the bit 0x8000, as
 * EUC-JP encodes it, or undefined for a character in neither.
 */
export function jisxCommon(point: number): number | undefined {
  const bytes = eucJpTablesOnce().encode.get(point);
  if (bytes?.length === 2 && bytes[0] !== 0x8e) return ((bytes[0] & 0x7f) << 8) | (bytes[1] & 0x7f);
  if (bytes?.length === 3) return 0x80_00 | ((bytes[1] & 0x7f) << 8) | (bytes[2] & 0x7f);
  return undefined;
}

/** The character a JIS X 0208 or JIS X 0212 code (row and cell from 0x21) decodes to, as EUC-JP decodes it. */
export function jisDecode(set: '0208' | '0212', first: number, second: number): number | undefined {
  const bytes = set === '0208' ? [first | 0x80, second | 0x80] : [0x8f, first | 0x80, second | 0x80];
  return eucJpTablesOnce().decode.get(packBytes(bytes));
}

// Shift_JIS, cp932, and EUC-JP --------------------------------------------------------------------------------------

/**
 * A codec of single bytes and multibyte sequences. `sequenceLength` gives the length of the sequence a byte without
 * its own character starts, or 0 when it starts none.
 */
function multibyteCodec(name: string, tables: Tables, sequenceLength: (byte: number) => number): TextCodec {
  return {
    name,
    inlineHandlers: INLINE_HANDLERS,
    encode: (points, errors) =>
      encodePoints(
        points,
        errors,
        ILLEGAL,
        (point, out) => {
          const bytes = tables.encode.get(point);
          if (bytes) out.push(...bytes);
          return bytes !== undefined;
        },
        { groupErrors: false }
      ),
    decode: (data, errors) => decodeMultibyte(data, errors, tables, sequenceLength),
  };
}

function decodeMultibyte(
  data: Uint8Array,
  errors: ErrorHandling,
  tables: Tables,
  sequenceLength: (byte: number) => number
): string {
  let text = '';
  let index = 0;
  while (index < data.length) {
    const single = tables.decode.get(data[index]);
    if (single !== undefined) {
      text += String.fromCodePoint(single);
      index++;
      continue;
    }
    const length = sequenceLength(data[index]);
    const point = length > 0 ? tables.decode.get(packBytes([...data.subarray(index, index + length)])) : undefined;
    if (point !== undefined && index + length <= data.length) {
      text += String.fromCodePoint(point);
      index += length;
      continue;
    }
    const incomplete = length > 0 && index + length > data.length;
    const failure = errors.decodeError(index, incomplete ? data.length : index + 1, incomplete ? INCOMPLETE : ILLEGAL);
    text += failure.text;
    index = failure.resume;
  }
  return text;
}

registerCodec('shift_jis', () =>
  multibyteCodec('shift_jis', shiftJisTables(), (byte) =>
    (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xea) ? 2 : 0
  )
);
registerCodec('cp932', () =>
  multibyteCodec('cp932', cp932Tables(), (byte) =>
    (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc) ? 2 : 0
  )
);
registerCodec('euc_jp', () =>
  multibyteCodec('euc_jp', eucJpTablesOnce(), (byte) => (byte === 0x8f ? 3 : byte >= 0x80 ? 2 : 0))
);
