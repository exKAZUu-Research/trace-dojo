// CPython's ISO-2022 codecs, iso2022_jp and its variants and iso2022_kr, which switch character sets with escape
// sequences, as _codecs_iso2022.c implements them.
import { cjkTables, type Encoder, registerStatefulCodec, type Step } from './cjkCodecs';
import { jisDecode, jisxCommon } from './japaneseCodecs';
import { decodeIn, encodeIn, encodeWithPairs, jisX0213, lacks, PLANE_2 } from './jisX0213';

const ESC = 0x1b;
const SO = 0x0e;
const SI = 0x0f;
const LF = 0x0a;
const DBCS = 0x80;
const MAX_ESCAPE_LENGTH = 16;

const ASCII = 0x42;
const ISO8859_1 = 0x41;
const ISO8859_7 = 0x46;
const JISX0201_K = 0x49;
const JISX0201_R = 0x4a;
const GB2312 = 0x41 | DBCS;
const JISX0208 = 0x42 | DBCS;
const KSX1001 = 0x43 | DBCS;
const JISX0212 = 0x44 | DBCS;
const JISX0213_2000_1 = 0x4f | DBCS;
const JISX0213_2 = 0x50 | DBCS;
const JISX0213_2004_1 = 0x51 | DBCS;
const JISX0208_O = 0x40 | DBCS;

/** A character set a codec designates, with how it decodes a code and encodes the characters at an index. */
interface Designation {
  mark: number;
  plane: 0 | 1 | 2;
  width: 1 | 2;
  decode: (code: number) => string | undefined;
  encode: (points: readonly number[], index: number) => { code: number; length: number } | undefined;
}

interface Config {
  noShift: boolean;
  useG2: boolean;
  jisx0208Extension: boolean;
  designations: Designation[];
}

const isCell = (byte: number): boolean => byte >= 0x21 && byte <= 0x7e;
const isCode = (code: number): boolean => isCell(code >> 8) && isCell(code & 0xff);
const one = (code: number | undefined): { code: number; length: number } | undefined =>
  code === undefined ? undefined : { code, length: 1 };
const char = (point: number | undefined): string | undefined =>
  point === undefined ? undefined : String.fromCodePoint(point);

/** A set CPython maps through the tables of an EUC codec, whose codes are its bytes without the high bits. */
function eucSet(codec: string, mark: number, plane: 0 | 1, encodable: (bytes: number) => boolean): Designation {
  return {
    mark,
    plane,
    width: 2,
    // KS X 1001's HANGUL FILLER, which the EUC-KR codec reads as the start of a make-up sequence instead.
    decode: (code) =>
      codec === 'euc_kr' && code === 0x24_54
        ? '\u3164'
        : isCode(code)
          ? cjkTables(codec).decode.get(code | 0x80_80)
          : undefined,
    encode: (points, index) => {
      const bytes =
        points[index] < 0x1_00_00
          ? cjkTables(codec === 'euc_kr' ? 'cp949' : codec).encode.get(points[index])
          : undefined;
      return bytes !== undefined && encodable(bytes) ? { code: bytes & 0x7f_7f, length: 1 } : undefined;
    },
  };
}

const isKsx1001 = (bytes: number): boolean => bytes >> 8 >= 0xa1 && (bytes & 0xff) >= 0xa1;

const KSX1001_G1 = eucSet('euc_kr', KSX1001, 1, isKsx1001);
const KSX1001_G0 = eucSet('euc_kr', KSX1001, 0, isKsx1001);
const GB2312_G0 = eucSet('gb2312', GB2312, 0, () => true);

function jisx0208(mark: number): Designation {
  return {
    mark,
    plane: 0,
    width: 2,
    decode: (code) =>
      code === 0x21_40 ? '＼' : isCode(code) ? char(jisDecode('0208', code >> 8, code & 0xff)) : undefined,
    encode: (points, index) => {
      const point = points[index];
      if (point === 0xff_3c) return one(0x21_40);
      const code = point < 0x1_00_00 ? jisxCommon(point) : undefined;
      return one(code !== undefined && !(code & 0x80_00) ? code : undefined);
    },
  };
}

const JISX0212_G0: Designation = {
  mark: JISX0212,
  plane: 0,
  width: 2,
  decode: (code) => (isCode(code) ? char(jisDecode('0212', code >> 8, code & 0xff)) : undefined),
  encode: (points, index) => {
    const code = points[index] < 0x1_00_00 ? jisxCommon(points[index]) : undefined;
    return one(code !== undefined && code & 0x80_00 ? code & 0x7f_ff : undefined);
  },
};

const JISX0201_ROMAN: Designation = {
  mark: JISX0201_R,
  plane: 0,
  width: 1,
  decode: (code) => (code === 0x5c ? '¥' : code === 0x7e ? '‾' : code < 0x80 ? String.fromCodePoint(code) : undefined),
  encode: (points, index) => {
    const point = points[index];
    if (point < 0x80 && point !== 0x5c && point !== 0x7e) return one(point);
    return one(point === 0xa5 ? 0x5c : point === 0x20_3e ? 0x7e : undefined);
  },
};

const JISX0201_KATAKANA: Designation = {
  mark: JISX0201_K,
  plane: 0,
  width: 1,
  decode: (code) => {
    const byte = code ^ 0x80;
    return byte >= 0xa1 && byte <= 0xdf ? String.fromCodePoint(0xfe_c0 + byte) : undefined;
  },
  encode: (points, index) => {
    const point = points[index];
    return one(point >= 0xff_61 && point <= 0xff_9f ? point - 0xfe_c0 - 0x80 : undefined);
  },
};

/** The sets of ISO-8859 that iso2022_jp_2 designates to G2, which it decodes after `ESC N` but never encodes. */
const g2Set = (mark: number): Designation => ({
  mark,
  plane: 2,
  width: 1,
  decode: () => {},
  encode: () => {},
});

/** A character and the combining one after it, which JIS X 0213 encodes together, or undefined. */
function encodePair(
  points: readonly number[],
  index: number,
  edition: 2000 | 2004
): { code: number; length: number } | undefined {
  const point = points[index];
  if (lacks(point, edition) || !jisX0213().pairStarts.has(point) || index + 1 >= points.length) return;
  const pair = jisX0213().pairs.get(`${point},${points[index + 1]}`);
  return pair === undefined ? undefined : { code: pair, length: 2 };
}

/** Plane 1 of JIS X 0213 in an edition: all of it, or only the characters followed by a combining one. */
function jisx0213Plane1(edition: 2000 | 2004, pairsOnly: boolean): Designation {
  return {
    mark: edition === 2000 ? JISX0213_2000_1 : JISX0213_2004_1,
    plane: 0,
    width: 2,
    decode: (code) => {
      if (code === 0x21_40 && decodeIn(code, edition) !== 'refused') return '＼';
      const text = isCode(code) ? decodeIn(code, edition) : undefined;
      return text === 'refused' ? undefined : text;
    },
    encode: (points, index) => {
      if (pairsOnly) return encodePair(points, index, edition);
      const found = encodeWithPairs(points, index, edition);
      return found && !(found.code & PLANE_2) ? found : undefined;
    },
  };
}

function jisx0213Plane2(edition: 2000 | 2004): Designation {
  return {
    mark: JISX0213_2,
    plane: 0,
    width: 2,
    // CPython's :2000 decoder sets U+9B1D for its old code but then looks the code up in the :2004 plane anyway.
    decode: (code) => {
      const text = isCode(code) ? decodeIn(PLANE_2 | code, 2004) : undefined;
      return text === 'refused' ? undefined : text;
    },
    encode: (points, index) => {
      const code = jisX0213().pairStarts.has(points[index]) ? undefined : encodeIn(points[index], edition);
      return one(code !== undefined && code & PLANE_2 ? code & 0x7f_ff : undefined);
    },
  };
}

const CONFIGS: Record<string, Config> = {
  iso2022_kr: { noShift: false, useG2: false, jisx0208Extension: false, designations: [KSX1001_G1] },
  iso2022_jp: {
    noShift: true,
    useG2: false,
    jisx0208Extension: true,
    designations: [jisx0208(JISX0208), JISX0201_ROMAN, jisx0208(JISX0208_O)],
  },
  iso2022_jp_1: {
    noShift: true,
    useG2: false,
    jisx0208Extension: true,
    designations: [jisx0208(JISX0208), JISX0212_G0, JISX0201_ROMAN, jisx0208(JISX0208_O)],
  },
  iso2022_jp_2: {
    noShift: true,
    useG2: true,
    jisx0208Extension: true,
    designations: [
      jisx0208(JISX0208),
      JISX0212_G0,
      KSX1001_G0,
      GB2312_G0,
      JISX0201_ROMAN,
      jisx0208(JISX0208_O),
      g2Set(ISO8859_1),
      g2Set(ISO8859_7),
    ],
  },
  iso2022_jp_2004: {
    noShift: true,
    useG2: false,
    jisx0208Extension: true,
    designations: [jisx0213Plane1(2004, true), jisx0208(JISX0208), jisx0213Plane1(2004, false), jisx0213Plane2(2004)],
  },
  iso2022_jp_3: {
    noShift: true,
    useG2: false,
    jisx0208Extension: true,
    designations: [jisx0213Plane1(2000, true), jisx0208(JISX0208), jisx0213Plane1(2000, false), jisx0213Plane2(2000)],
  },
  iso2022_jp_ext: {
    noShift: true,
    useG2: false,
    jisx0208Extension: true,
    designations: [jisx0208(JISX0208), JISX0212_G0, JISX0201_ROMAN, JISX0201_KATAKANA, jisx0208(JISX0208_O)],
  },
};

// Decoding ----------------------------------------------------------------------------------------------------------

interface DecoderState {
  g: [number, number, number];
  shifted: boolean;
  /** Set after an escape that starts no ISO-2022 sequence, until a final byte passes through. */
  escapeThroughout: boolean;
}

const isEscapeEnd = (byte: number): boolean => (byte >= 0x41 && byte <= 0x5a) || byte === 0x40;
const isIso2022Escape = (byte: number): boolean => [0x28, 0x29, 0x24, 0x2e, 0x26].includes(byte);

/** The length of the escape sequence at `index`, 0 when none ends within 16 bytes, or 'incomplete'. */
function escapeLength(config: Config, data: Uint8Array, index: number): number | 'incomplete' {
  for (let offset = 1; offset < MAX_ESCAPE_LENGTH; offset++) {
    if (index + offset >= data.length) return 'incomplete';
    if (isEscapeEnd(data[index + offset])) return offset + 1;
    // ESC & @, which may come before JIS X 0208's ESC $ B.
    const extension = config.jisx0208Extension && index + offset + 1 < data.length;
    if (extension && data[index + offset] === 0x26 && data[index + offset + 1] === 0x40) offset += 2;
  }
  return 0;
}

/** The character set and the G0 to G2 an escape sequence of `length` designates, or undefined for no designation. */
// code-gauge-allow functionCognitiveComplexity 21 -- One case per form of designation iso2022processesc reads.
function designationOf(config: Config, at: (offset: number) => number, length: number): [number, number] | undefined {
  if (length === 3) {
    if (at(1) === 0x24) return [at(2) | DBCS, 0];
    if (at(1) === 0x28 || at(1) === 0x29) return [at(2), at(1) === 0x28 ? 0 : 1];
    return config.useG2 && at(1) === 0x2e ? [at(2), 2] : undefined;
  }
  if (length === 4) {
    if (at(1) !== 0x24 || (at(2) !== 0x28 && at(2) !== 0x29)) return undefined;
    return [at(3) | DBCS, at(2) === 0x28 ? 0 : 1];
  }
  const prefixed = length === 6 && config.jisx0208Extension && at(3) === ESC && at(4) === 0x24 && at(5) === 0x42;
  return prefixed ? [JISX0208, 0] : undefined;
}

/** Applies the escape sequence at `index`, as iso2022processesc reads it. */
function processEscape(config: Config, state: DecoderState, data: Uint8Array, index: number): Step {
  const length = escapeLength(config, data, index);
  if (length === 'incomplete') return length;
  const found = designationOf(config, (offset) => data[index + offset], length);
  if (!found) return { illegal: length || 1 };
  const [charset, designation] = found;
  if (charset !== ASCII && !config.designations.some((each) => each.mark === charset)) return { illegal: length };
  state.g[designation] = charset;
  return { text: '', length };
}

/** A character after `ESC N`, single-shifted into the set of G2. */
function processG2(state: DecoderState, byte: number): Step {
  let point: number | undefined;
  if (state.g[2] === ISO8859_1) point = byte < 0x80 ? byte + 0x80 : undefined;
  else if (state.g[2] === ISO8859_7) point = iso8859_7(byte ^ 0x80);
  else point = byte & 0x80 ? undefined : byte;
  return point === undefined ? { illegal: 3 } : { text: String.fromCodePoint(point), length: 3 };
}

/** ISO8859_7_DECODE of CPython's ISO-2022 codec. */
function iso8859_7(byte: number): number | undefined {
  if (byte < 0xa0) return byte;
  if (byte < 0xc0 && 0x28_8f_3b_c9 & (1 << (byte - 0xa0))) return byte;
  if (byte >= 0xb4 && byte <= 0xfe && (byte >= 0xd4 || 0xbf_ff_fd_77 & (1 << (byte - 0xb4)))) return 0x02_d0 + byte;
  return byte === 0xa1 ? 0x20_18 : byte === 0xa2 ? 0x20_19 : byte === 0xaf ? 0x20_15 : undefined;
}

// code-gauge-allow functionCognitiveComplexity 26 -- Transcribes CPython's ISO-2022 decoder, one case per control byte.
// code-gauge-allow functionNcss 34 -- Transcribes CPython's ISO-2022 decoder, one case per control byte.
function decodeStep(config: Config, state: DecoderState, data: Uint8Array, index: number): Step {
  const byte = data[index];
  if (state.escapeThroughout) {
    if (isEscapeEnd(byte)) state.escapeThroughout = false;
    return { text: String.fromCodePoint(byte), length: 1 };
  }
  if (byte === ESC) {
    if (index + 1 >= data.length) return 'incomplete';
    if (isIso2022Escape(data[index + 1])) return processEscape(config, state, data, index);
    if (config.useG2 && data[index + 1] === 0x4e) {
      return index + 2 >= data.length ? 'incomplete' : processG2(state, data[index + 2]);
    }
    state.escapeThroughout = true;
    return { text: '\u001B', length: 1 };
  }
  if ((byte === SI || byte === SO) && !config.noShift) {
    state.shifted = byte === SO;
    return { text: '', length: 1 };
  }
  if (byte === LF) {
    state.shifted = false;
    return { text: '\n', length: 1 };
  }
  if (byte < 0x20) return { text: String.fromCodePoint(byte), length: 1 };
  if (byte >= 0x80) return 'illegal';
  const charset = state.shifted ? state.g[1] : state.g[0];
  if (charset === ASCII) return { text: String.fromCodePoint(byte), length: 1 };
  const designation = config.designations.find((each) => each.mark === charset) as Designation;
  if (index + designation.width > data.length) return 'incomplete';
  const code = designation.width === 1 ? byte : (byte << 8) | data[index + 1];
  const text = designation.decode(code);
  return text === undefined ? { illegal: designation.width } : { text, length: designation.width };
}

// Encoding ----------------------------------------------------------------------------------------------------------

interface EncoderState {
  g0: number;
  g1: number;
  shifted: boolean;
}

function designationEscape(designation: Designation): number[] {
  const mark = designation.mark & 0x7f;
  if (designation.plane === 1) return designation.width === 1 ? [ESC, 0x29, mark] : [ESC, 0x24, 0x29, mark];
  if (designation.width === 1) return [ESC, 0x28, mark];
  return designation.mark === JISX0208 ? [ESC, 0x24, mark] : [ESC, 0x24, 0x28, mark];
}

/** Designates a character set to G0 or G1 where it is not, and shifts in or out as its plane needs. */
function switchTo(state: EncoderState, designation: Designation, out: number[]): void {
  if (designation.plane === 0) {
    if (state.shifted) out.push(SI);
    state.shifted = false;
    if (state.g0 !== designation.mark) out.push(...designationEscape(designation));
    state.g0 = designation.mark;
    return;
  }
  if (state.g1 !== designation.mark) out.push(...designationEscape(designation));
  state.g1 = designation.mark;
  if (!state.shifted) out.push(SO);
  state.shifted = true;
}

function encoderOf(config: Config, state: EncoderState): Encoder {
  return (points, index, out) => {
    const point = points[index];
    if (point < 0x80) {
      if (state.g0 !== ASCII) out.push(ESC, 0x28, 0x42);
      state.g0 = ASCII;
      if (state.shifted) out.push(SI);
      state.shifted = false;
      out.push(point);
      return 1;
    }
    let found: { code: number; length: number } | undefined;
    const designation = config.designations.find((each) => (found = each.encode(points, index)) !== undefined);
    if (!designation || !found) return 0;
    switchTo(state, designation, out);
    if (designation.width === 1) out.push(found.code);
    else out.push(found.code >> 8, found.code & 0xff);
    return found.length;
  };
}

/** ENCODER_RESET: back to ASCII, unshifted, at the end of the text. */
function resetEncoder(state: EncoderState, out: number[]): void {
  if (state.shifted) out.push(SI);
  state.shifted = false;
  if (state.g0 !== ASCII) out.push(ESC, 0x28, 0x42);
  state.g0 = ASCII;
}

for (const [name, config] of Object.entries(CONFIGS)) {
  const pairCapable = name === 'iso2022_jp_2004' || name === 'iso2022_jp_3';
  registerStatefulCodec(name, {
    decoder: () => {
      const state: DecoderState = { g: [ASCII, ASCII, ASCII], shifted: false, escapeThroughout: false };
      return (data, index) => decodeStep(config, state, data, index);
    },
    encoder: () => {
      const state: EncoderState = { g0: ASCII, g1: ASCII, shifted: false };
      return { step: encoderOf(config, state), reset: (out) => resetEncoder(state, out) };
    },
    waitsAfter: pairCapable ? (point) => jisX0213().pairStarts.has(point) : undefined,
  });
}

/** The codec modules of this file. */
export const ISO2022_MODULES = Object.keys(CONFIGS);
