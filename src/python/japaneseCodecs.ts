// CPython's Japanese codecs: shift_jis, cp932, euc_jp, and iso2022_jp, built from the JIS tables when first used.
import { decodeWithSteps, type ErrorHandling, registerCodec, type TextCodec } from './codecs';
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
  multibyteCodec('euc_jp', eucJpTables(), (byte) => (byte === 0x8f ? 3 : byte >= 0x80 ? 2 : 0))
);

// ISO-2022-JP -------------------------------------------------------------------------------------------------------

type Charset = 'ascii' | 'roman' | 'jis';

const ESCAPES: Record<Charset, number[]> = {
  ascii: [0x1b, 0x28, 0x42],
  roman: [0x1b, 0x28, 0x4a],
  jis: [0x1b, 0x24, 0x42],
};
/** The escape sequences the decoder accepts, which include JIS X 0208-1978's `ESC $ @`. */
const DESIGNATIONS = new Map<string, Charset>([
  ['(B', 'ascii'],
  ['(J', 'roman'],
  ['$@', 'jis'],
  ['$B', 'jis'],
]);

function iso2022JpCodec(): TextCodec {
  const jis = new Map<number, number>();
  const encode = new Map<number, number[]>();
  for (let index = 0; index < JIS_X_0208.length; index++) {
    const char = JIS_X_0208[index];
    if (char === UNASSIGNED) continue;
    const bytes = [Math.floor(index / 94) + 0x21, (index % 94) + 0x21];
    const point = char.codePointAt(0) as number;
    jis.set(packBytes(bytes), point);
    if (!encode.has(point)) encode.set(point, bytes);
  }
  return {
    name: 'iso2022_jp',
    inlineHandlers: INLINE_HANDLERS,
    encode: (points, errors) => encodeIso2022Jp(points, errors, encode),
    decode: (data, errors) => decodeIso2022Jp(data, errors, jis),
  };
}

registerCodec('iso2022_jp', iso2022JpCodec);

/** Encodes in ASCII, JIS X 0208, or JIS X 0201 Roman for ¥ and ‾, switching with escapes and ending in ASCII. */
// code-gauge-allow functionCognitiveComplexity 21 -- Follows CPython's ISO-2022-JP encoder, which switches character sets with escapes.
// code-gauge-allow functionNcss 33 -- Follows CPython's ISO-2022-JP encoder, which switches character sets with escapes.
function encodeIso2022Jp(points: readonly number[], errors: ErrorHandling, encode: Map<number, number[]>): Uint8Array {
  let charset: Charset = 'ascii';
  const out: number[] = [];
  const write = (target: Charset, bytes: readonly number[]): void => {
    if (charset !== target) out.push(...ESCAPES[target]);
    charset = target;
    out.push(...bytes);
  };
  const encodePoint = (point: number): boolean => {
    const bytes = encode.get(point);
    if (point < 0x80) write('ascii', [point]);
    else if (bytes) write('jis', bytes);
    else if (point === 0xa5 || point === 0x20_3e) write('roman', [point === 0xa5 ? 0x5c : 0x7e]);
    else return false;
    return true;
  };
  for (let index = 0; index < points.length; index++) {
    if (encodePoint(points[index])) continue;
    const replacement = errors.encodeError(index, index + 1, ILLEGAL);
    if ('bytes' in replacement) out.push(...replacement.bytes);
    else for (const char of replacement.text) encodePoint(char.codePointAt(0) as number);
  }
  if (charset !== 'ascii') out.push(...ESCAPES.ascii);
  return Uint8Array.from(out);
}

/** The state of CPython's ISO-2022 decoder. */
interface Iso2022State {
  charset: Charset;
  /** Set after an escape that starts no ISO-2022 sequence, until a final byte (A to Z or @) passes through. */
  escapeThroughout: boolean;
}

type DecodeStep = { text: string; length: number } | { reason: string; length: number };

const isEscapeEnd = (byte: number | undefined): boolean =>
  byte !== undefined && ((byte >= 0x41 && byte <= 0x5a) || byte === 0x40);

function decodeIso2022Jp(data: Uint8Array, errors: ErrorHandling, jis: Map<number, number>): string {
  const state: Iso2022State = { charset: 'ascii', escapeThroughout: false };
  return decodeWithSteps(data, errors, (bytes, index) => {
    const step = decodeIso2022Step(bytes, index, state, jis);
    return 'text' in step ? step : { reason: step.reason, end: Math.min(index + step.length, bytes.length) };
  });
}

/** Decodes the character or escape sequence at `index`, or describes the error there. */
// code-gauge-allow functionCognitiveComplexity 19 -- Follows the cases of CPython's ISO-2022 decoder.
function decodeIso2022Step(data: Uint8Array, index: number, state: Iso2022State, jis: Map<number, number>): DecodeStep {
  const byte = data[index];
  const incomplete = { reason: INCOMPLETE, length: data.length - index };
  if (state.escapeThroughout) {
    if (isEscapeEnd(byte)) state.escapeThroughout = false;
    return { text: String.fromCodePoint(byte), length: 1 };
  }
  if (byte === 0x1b) {
    if (index + 1 >= data.length) return incomplete;
    if (!'()$.&'.includes(String.fromCodePoint(data[index + 1]))) {
      state.escapeThroughout = true;
      return { text: '\u001B', length: 1 };
    }
    return processEscape(data, index, state);
  }
  if (byte >= 0x80) return { reason: ILLEGAL, length: 1 };
  if (byte < 0x20 || state.charset === 'ascii') return { text: String.fromCodePoint(byte), length: 1 };
  if (state.charset === 'roman') {
    return { text: String.fromCodePoint(byte === 0x5c ? 0xa5 : byte === 0x7e ? 0x20_3e : byte), length: 1 };
  }
  if (index + 1 >= data.length) return incomplete;
  const point = jis.get(packBytes([byte, data[index + 1]]));
  return point === undefined ? { reason: ILLEGAL, length: 2 } : { text: String.fromCodePoint(point), length: 2 };
}

/** Applies the escape sequence at `index`, as CPython's iso2022processesc reads it. */
// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes iso2022processesc.
function processEscape(data: Uint8Array, index: number, state: Iso2022State): DecodeStep {
  let length = 0;
  for (let offset = 1; offset < 16; offset++) {
    if (index + offset >= data.length) return { reason: INCOMPLETE, length: data.length - index };
    if (isEscapeEnd(data[index + offset])) {
      length = offset + 1;
      break;
    }
    if (data[index + offset] === 0x26 && data[index + offset + 1] === 0x40) offset += 2;
  }
  const at = (offset: number): string => String.fromCodePoint(data[index + offset]);
  let sequence: string | undefined;
  if (length === 3) sequence = at(1) + at(2);
  else if (length === 4 && at(1) === '$' && '()'.includes(at(2))) sequence = `$${at(2)}${at(3)}`;
  else if (length === 6 && at(3) === '\u001B' && at(4) === '$' && at(5) === 'B') sequence = '$B';
  // The sequences for G1 designate a set that the codec never shifts to.
  const designation =
    sequence === undefined ? undefined : DESIGNATIONS.get(sequence.replace(/^\$[()]/, '$').replace(/^\)/, '('));
  if (length === 0 || designation === undefined) return { reason: ILLEGAL, length: length || 1 };
  if (!sequence?.includes(')')) state.charset = designation;
  return { text: '', length };
}
