// oxlint-disable unicorn/prefer-code-point -- Each code unit is one PHP byte.
import { jisDetectionCodePoint } from './detectionDecodeTables';
import { legacyDetectionCodePoint, type LegacyDetectionTable } from './legacyDetectionTables';
import { rt } from './runtime';

const BAD = -1;
const ASCII = 0;
const ROMAN = 1;
const KANA = 2;
const SHIFTED_KANA = 3;
const JIS_0208 = 4;
const JIS_0212 = 5;
const MS_USER = 6;
const JIS_0213_PLANE_1 = 7;
const JIS_0213_PLANE_2 = 8;
const JIS_0213_SECOND_PLANE_ROWS = [
  0, 7, 2, 3, 4, 11, 12, 13, 14, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93,
];
const JIS_0213_TABLES = new Map<number, LegacyDetectionTable>([
  [JIS_0213_PLANE_1, 'jis0213Plane1'],
  [JIS_0213_PLANE_2, 'jis0213Plane2'],
]);
const ESCAPES = new Map([
  ['(B', ASCII],
  ['(H', ASCII],
  ['(J', ROMAN],
  ['(I', KANA],
  ['$@', JIS_0208],
  ['$B', JIS_0208],
  ['$(B', JIS_0208],
  ['$(@', JIS_0208],
  ['$(D', JIS_0212],
]);
const ISO_ESCAPES = new Set(['(B', '(J', '$@', '$B']);

const EXTENDED_JIS = {
  cp5022x: { escapes: ESCAPES, lastLead: 0x97, kanji: 'cp5022x' },
  ms: {
    escapes: new Map([
      ['(B', ASCII],
      ['(J', ASCII],
      ['(I', KANA],
      ['$@', JIS_0208],
      ['$B', JIS_0208],
      ['$(@', JIS_0208],
      ['$(B', JIS_0208],
      ['$(?', MS_USER],
    ]),
    lastLead: 0x7f,
    kanji: 'iso2022JpMs',
  },
  '2004': {
    escapes: new Map([
      ['(B', ASCII],
      ['$B', JIS_0208],
      ['$(Q', JIS_0213_PLANE_1],
      ['$(P', JIS_0213_PLANE_2],
    ]),
    lastLead: 0x7e,
    kanji: undefined,
  },
} satisfies Record<string, { escapes: ReadonlyMap<string, number>; lastLead: number; kanji?: LegacyDetectionTable }>;

// code-gauge-allow functionCognitiveComplexity 20 -- Keeps the cursor and designation shifts in one state machine.
export function readExtendedJisEncoding(bytes: string, kind: keyof typeof EXTENDED_JIS): number[] {
  const { escapes, lastLead, kanji } = EXTENDED_JIS[kind];
  const replayInvalid = kind === 'cp5022x';
  const codes: number[] = [];
  let state = ASCII;
  rt().spend(Math.ceil(bytes.length / 64));
  for (let index = 0; index < bytes.length;) {
    const lead = bytes.charCodeAt(index++);
    if (lead === 0x1b) {
      const escape = readEscape(bytes, index, escapes, replayInvalid);
      index += escape.width;
      if (escape.state === undefined) pushInvalidEscape(codes, escape.prefix);
      else state = escape.state;
      continue;
    }
    if (replayInvalid && (lead === 0x0e || lead === 0x0f)) {
      state = lead === 0x0e ? KANA : ASCII;
      continue;
    }
    if (state >= JIS_0208 && lead >= 0x21 && lead <= lastLead) {
      pushExtendedPair(codes, state, kanji, lead, bytes.charCodeAt(index++));
      continue;
    }
    codes.push(kind === '2004' && lead >= 0x80 ? BAD : directCode(state, lead));
  }
  return codes;
}

export function readSjis2004(bytes: string): number[] {
  const codes: number[] = [];
  rt().spend(Math.ceil(bytes.length / 64));
  for (let index = 0; index < bytes.length;) {
    const lead = bytes.charCodeAt(index++);
    const double = (lead >= 0x81 && lead <= 0x9f) || (lead >= 0xe0 && lead <= 0xfc);
    if (!double) {
      codes.push(directCode(ROMAN, lead));
      continue;
    }
    pushSjis2004Pair(codes, lead, bytes.charCodeAt(index++));
  }
  return codes;
}

function pushSjis2004Pair(codes: number[], lead: number, trail: number): void {
  if (!(trail >= 0x40 && trail <= 0xfc) || trail === 0x7f) {
    codes.push(BAD);
    return;
  }
  const column = trail - (trail < 0x7f ? 0x40 : 0x41);
  const rowPair = lead <= 0x9f ? lead - 0x81 : lead - 0xe0 + 31;
  const row = rowPair * 2 + Math.floor(column / 94);
  const second = row >= 94;
  const graphicRow = second ? JIS_0213_SECOND_PLANE_ROWS[row - 94] : row;
  pushExtendedPair(
    codes,
    second ? JIS_0213_PLANE_2 : JIS_0213_PLANE_1,
    undefined,
    graphicRow + 0x21,
    (column % 94) + 0x21
  );
}

function pushExtendedPair(
  codes: number[],
  state: number,
  kanji: LegacyDetectionTable | undefined,
  lead: number,
  trail: number
): void {
  if (!isGraphic(trail)) {
    codes.push(BAD);
    return;
  }
  const index = (lead - 0x21) * 94 + trail - 0x21;
  if (state === MS_USER) {
    codes.push(lead <= 0x34 ? 0xe0_00 + index : BAD);
    return;
  }
  const table = state === JIS_0208 ? kanji : JIS_0213_TABLES.get(state);
  const extended = table ? legacyDetectionCodePoint(table, index) : 0;
  if (extended >= 0x80_00_00_00) {
    // The high bit marks two BMP code points emitted for one JIS pair.
    codes.push((extended >>> 16) & 0x7f_ff, extended & 0xff_ff);
    return;
  }
  if (extended !== 0) {
    codes.push(extended === 0xff_fd ? BAD : extended);
    return;
  }
  codes.push(isGraphic(lead) ? jisPair(state === JIS_0212 ? JIS_0212 : JIS_0208, lead, trail) : BAD);
}

// code-gauge-allow functionNcss 34 -- Shares the byte cursor and shift state between scoring and validation.
// code-gauge-allow functionCognitiveComplexity 28 -- Shares the byte cursor and shift state between scoring and validation.
export function readJisEncoding(bytes: string, strictIso = false): { codes: number[]; valid: boolean } {
  const codes: number[] = [];
  let valid = true;
  let state = ASCII;
  rt().spend(Math.ceil(bytes.length / 64));
  for (let index = 0; index < bytes.length;) {
    const lead = bytes.charCodeAt(index++);
    if (lead === 0x1b) {
      const escape = readEscape(bytes, index);
      index += escape.width;
      if (escape.state === undefined) {
        pushInvalidEscape(codes, escape.prefix);
        valid = false;
      } else {
        valid &&= state !== SHIFTED_KANA && (!strictIso || ISO_ESCAPES.has(escape.prefix));
        state = escape.state;
      }
    } else if (lead === 0x0e || lead === 0x0f) {
      const entering = lead === 0x0e;
      valid &&= !strictIso && state === (entering ? ASCII : SHIFTED_KANA);
      state = entering ? SHIFTED_KANA : ASCII;
    } else if (state >= JIS_0208 && isGraphic(lead)) {
      const trail = bytes.charCodeAt(index++);
      const code = jisPair(state, lead, trail);
      valid &&= code !== BAD;
      codes.push(code);
    } else {
      const code = directCode(state, lead);
      valid &&= code !== BAD && (!strictIso || lead < 0x80);
      codes.push(code);
    }
  }
  return { codes, valid: valid && state === ASCII };
}

function readEscape(
  bytes: string,
  start: number,
  escapes: ReadonlyMap<string, number> = ESCAPES,
  replayInvalid = true
): { width: number; prefix: string; state?: number } {
  const available = bytes.length - start;
  const first = bytes[start];
  const stem = first === '(' || first === '$' ? first : '';
  if (available < 2) return { width: replayInvalid ? stem.length : available, prefix: '' };
  const long = bytes.startsWith('$(', start);
  if (long && available === 2) return { width: 2, prefix: '' };
  const prefix = bytes.slice(start, start + (long ? 3 : 2));
  const state = escapes.get(prefix);
  if (state !== undefined) return { width: prefix.length, prefix, state };
  if (!replayInvalid) return { width: stem ? prefix.length : 1, prefix: '' };
  const partial = long ? '$(' : stem;
  return { width: partial.length, prefix: partial };
}

function pushInvalidEscape(codes: number[], prefix: string): void {
  codes.push(BAD);
  for (const byte of prefix) codes.push(byte.charCodeAt(0));
}

function isGraphic(code: number): boolean {
  return code >= 0x21 && code < 0x7f;
}

function jisPair(state: number, lead: number, trail: number): number {
  if (!isGraphic(trail)) return BAD;
  const index = ((state - JIS_0208) * 94 + lead - 0x21) * 94 + trail - 0x21;
  const code = jisDetectionCodePoint(index);
  return code === 0xff_fd ? BAD : code;
}

function directCode(state: number, lead: number): number {
  if (state === ROMAN && lead === 0x5c) return 0xa5;
  if (state === ROMAN && lead === 0x7e) return 0x20_3e;
  if ((state === KANA || state === SHIFTED_KANA) && lead > 0x20 && lead < 0x60) return 0xff_40 + lead;
  if (lead < 0x80) return lead;
  return lead >= 0xa1 && lead <= 0xdf ? 0xfe_c0 + lead : BAD;
}
