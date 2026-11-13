// JIS X 0213, the character set of CPython's shift_jis_2004, euc_jis_2004, and iso2022_jp_2004 codecs, with its
// :2000 edition, which shift_jisx0213, euc_jisx0213, and iso2022_jp_3 emulate, built from data/jisX0213.ts.
import { JIS_X_0213_ENCODINGS, JIS_X_0213_PAIRS, JIS_X_0213_PLANE_1, JIS_X_0213_PLANE_2 } from './data/jisX0213';

const UNASSIGNED = 0xff_ff;
/** A code of plane 2 has this bit, as CPython's JIS X 0213 maps mark it. */
export const PLANE_2 = 0x80_00;

/** The characters of JIS X 0213:2004: what each code (row and cell from 0x21, plane 2 with the bit) decodes to. */
interface Tables {
  decode: Map<number, string>;
  encode: Map<number, number>;
  /** The codes of a character followed by a combining one, by the two code points joined with a comma. */
  pairs: Map<string, number>;
  /** The characters that start a pair, which the encoders look past. */
  pairStarts: Set<number>;
}

let tables: Tables | undefined;

export function jisX0213(): Tables {
  tables ??= buildTables();
  return tables;
}

function buildTables(): Tables {
  const decode = new Map<number, string>();
  const encode = new Map<number, number>();
  for (const [plane, text] of [
    [0, JIS_X_0213_PLANE_1],
    [PLANE_2, JIS_X_0213_PLANE_2],
  ] as const) {
    // oxlint-disable-next-line typescript/no-misused-spread -- The planes hold one character per cell.
    for (const [index, char] of [...text].entries()) {
      const point = char.codePointAt(0) as number;
      if (point === UNASSIGNED) continue;
      const code = plane | ((Math.floor(index / 94) + 0x21) << 8) | ((index % 94) + 0x21);
      decode.set(code, char);
      encode.set(point, code);
    }
  }
  const pairs = new Map<string, number>();
  const pairStarts = new Set<number>();
  for (const [row, cell, text] of JIS_X_0213_PAIRS) {
    const code = ((row + 0x20) << 8) | (cell + 0x20);
    decode.set(code, text);
    // oxlint-disable-next-line typescript/no-misused-spread -- A pair is two characters.
    const [first, second] = [...text].map((char) => char.codePointAt(0) as number);
    pairs.set(`${first},${second}`, code);
    pairStarts.add(first);
  }
  for (const [point, plane, row, cell] of JIS_X_0213_ENCODINGS) {
    if (plane === 0) encode.delete(point);
    else encode.set(point, (plane === 2 ? PLANE_2 : 0) | ((row + 0x20) << 8) | (cell + 0x20));
  }
  return { decode, encode, pairs, pairStarts };
}

// JIS X 0213:2000 ---------------------------------------------------------------------------------------------------

/** The characters JIS X 0213:2004 added, which the :2000 encoders cannot encode. */
const ADDED_IN_2004 = new Set([
  0x9b_1c, 0x4f_f1, 0x52_5d, 0x54_1e, 0x56_53, 0x59_f8, 0x5c_5b, 0x5e_77, 0x76_26, 0x7e_6b, 0x2_0b_9f,
]);
/** The cells of plane 1 JIS X 0213:2004 added, which the :2000 decoders refuse. */
const CELLS_ADDED_IN_2004 = new Set([
  0x2e_21, 0x2f_7e, 0x4f_54, 0x4f_7e, 0x74_27, 0x7e_7a, 0x7e_7b, 0x7e_7c, 0x7e_7d, 0x7e_7e,
]);
/** The code of plane 2 that JIS X 0213:2000 gives U+9B1D, which :2004 moved to plane 1. */
const OLD_9B1D = PLANE_2 | 0x7d_3b;

/** Whether an edition lacks a character, which its encoders refuse before trying any other map. */
export function lacks(point: number, edition: 2000 | 2004): boolean {
  return edition === 2000 && ADDED_IN_2004.has(point);
}

/** How an edition encodes a character alone: its code, or undefined. */
export function encodeIn(point: number, edition: 2000 | 2004): number | undefined {
  if (edition === 2000) {
    if (ADDED_IN_2004.has(point)) return undefined;
    if (point === 0x9b_1d) return OLD_9B1D;
  }
  return jisX0213().encode.get(point);
}

/**
 * How an edition decodes a code: its text, `'refused'` for a cell :2000 lacks, which CPython's Japanese codecs report
 * as an error of two bytes, or undefined.
 */
export function decodeIn(code: number, edition: 2000 | 2004): string | undefined {
  if (edition === 2000) {
    if (CELLS_ADDED_IN_2004.has(code)) return 'refused';
    if (code === OLD_9B1D) return '鬝';
  }
  return jisX0213().decode.get(code);
}

/**
 * Encodes the character at `index`, with the one after it when they make a pair: its code and how many characters
 * it took, or undefined. Without `flush`, a character that may start a pair at the end waits for the next.
 */
export function encodeWithPairs(
  points: readonly number[],
  index: number,
  edition: 2000 | 2004
): { code: number; length: number } | undefined {
  const point = points[index];
  const { pairs, pairStarts } = jisX0213();
  if (pairStarts.has(point) && !(edition === 2000 && ADDED_IN_2004.has(point)) && index + 1 < points.length) {
    const pair = pairs.get(`${point},${points[index + 1]}`);
    if (pair !== undefined) return { code: pair, length: 2 };
  }
  const code = encodeIn(point, edition);
  return code === undefined ? undefined : { code, length: 1 };
}
