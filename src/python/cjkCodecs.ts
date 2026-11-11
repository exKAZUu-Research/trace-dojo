// CPython's Chinese and Korean codecs: gb2312, gbk, gb18030, hz, big5, cp950, big5hkscs, euc_kr, cp949, and johab,
// built from the tables of data/cjkCodecs.ts when a program first uses one.
import { decodeWithSteps, type ErrorHandling, registerCodec, type TextCodec } from './codecs';
import { CJK_ENCODINGS, CJK_SEQUENCES, CJK_TABLES, GB18030_RANGES } from './data/cjkCodecs';

/** The codec modules of this file, whose `encodings` modules are those of CPython's multibyte codecs. */
export const CJK_MODULES = ['gb2312', 'gbk', 'gb18030', 'hz', 'big5', 'cp950', 'big5hkscs', 'euc_kr', 'cp949', 'johab'];

export const ILLEGAL = 'illegal multibyte sequence';
export const INCOMPLETE = 'incomplete multibyte sequence';
/** The handlers CPython's multibyte codecs apply without creating an exception. */
export const INLINE_HANDLERS = { encode: new Set(['ignore', 'replace']), decode: new Set(['ignore', 'replace']) };
const SKIP = 0xff_f0;
const NEXT = 0xff_f1;
const BASE = 0xff_f2;

/** A codec's two-byte sequences, packed as `lead * 256 + trail`, and what they decode to and encode from. */
interface Tables {
  decode: Map<number, string>;
  encode: Map<number, number>;
}

const decodeTables = new Map<string, Map<number, string>>();

/** The characters of each two-byte sequence of a codec, read from its table and the table of its base. */
function decodeTable(codec: string): Map<number, string> {
  const cached = decodeTables.get(codec);
  if (cached) return cached;
  const { leads, trails, base, cells } = CJK_TABLES[codec];
  const baseTable = base === undefined ? undefined : decodeTable(base);
  const width = trails[1] - trails[0] + 1;
  const table = new Map<number, string>();
  const packed = (cell: number): number => (leads[0] + Math.floor(cell / width)) * 256 + trails[0] + (cell % width);
  let cell = 0;
  let previous = 0;
  // oxlint-disable-next-line typescript/no-misused-spread -- The table holds one character per cell.
  const chars = [...cells];
  for (let position = 0; position < chars.length; position++) {
    const point = chars[position].codePointAt(0) as number;
    if (point !== SKIP && point !== NEXT && point !== BASE) {
      table.set(packed(cell++), chars[position]);
      previous = point;
      continue;
    }
    const count = chars[++position].codePointAt(0) as number;
    for (let index = 0; index < count; index++, cell++) {
      if (point === NEXT) table.set(packed(cell), String.fromCodePoint(++previous));
      else if (point === BASE) {
        const char = baseTable?.get(packed(cell)) as string;
        table.set(packed(cell), char);
        previous = char.codePointAt(0) as number;
      }
    }
  }
  decodeTables.set(codec, table);
  return table;
}

/** The tables of a codec, each character encoding to the last sequence that decodes to it unless listed otherwise. */
const sharedTables = new Map<string, Tables>();

/** The tables of a codec, built once, which the ISO-2022 codecs share. */
export function cjkTables(codec: string): Tables {
  let tables = sharedTables.get(codec);
  if (!tables) {
    tables = tablesOf(codec);
    sharedTables.set(codec, tables);
  }
  return tables;
}

function tablesOf(codec: string): Tables {
  const decode = new Map(decodeTable(codec));
  const encode = new Map<number, number>();
  for (const [bytes, char] of [...decode].toSorted(([a], [b]) => a - b))
    encode.set(char.codePointAt(0) as number, bytes);
  for (const [point, bytes] of CJK_ENCODINGS[codec] ?? []) {
    if (bytes === 0) encode.delete(point);
    else encode.set(point, bytes);
  }
  for (const [bytes, text] of CJK_SEQUENCES[codec] ?? []) decode.set(bytes, text);
  return { decode, encode };
}

// Decoding ----------------------------------------------------------------------------------------------------------

/** What decoding at a position finds: text and the bytes it took, an illegal byte, or a sequence the data cuts off. */
/** A step can also report an illegal sequence of more than one byte, as JIS X 0213:2000's emulation does. */
export type Step = { text: string; length: number } | { illegal: number } | 'illegal' | 'incomplete';

export type Stepper = (data: Uint8Array, index: number) => Step;

/** The step of a codec of ASCII and two-byte sequences, each byte above ASCII leading one. */
function pairStep(decode: Map<number, string>, data: Uint8Array, index: number): Step {
  const lead = data[index];
  if (lead < 0x80) return { text: String.fromCodePoint(lead), length: 1 };
  if (index + 1 >= data.length) return 'incomplete';
  const text = decode.get(lead * 256 + data[index + 1]);
  return text === undefined ? 'illegal' : { text, length: 2 };
}

export function decodeSteps(data: Uint8Array, errors: ErrorHandling, step: Stepper): string {
  return decodeWithSteps(data, errors, (bytes, index) => {
    const found = step(bytes, index);
    if (typeof found === 'object') return 'illegal' in found ? { reason: ILLEGAL, end: index + found.illegal } : found;
    return found === 'incomplete' ? { reason: INCOMPLETE, end: bytes.length } : { reason: ILLEGAL, end: index + 1 };
  });
}

/** The bytes at the end of data that start a sequence more data may complete. */
export function incompleteTail(data: Uint8Array, step: Stepper): number {
  let index = 0;
  while (index < data.length) {
    const found = step(data, index);
    if (found === 'incomplete') return data.length - index;
    index += typeof found !== 'object' ? 1 : 'illegal' in found ? found.illegal : found.length;
  }
  return 0;
}

// Encoding ----------------------------------------------------------------------------------------------------------

/** Writes the bytes of the characters at `index`, returning how many characters it took, or 0 when it cannot. */
export type Encoder = (points: readonly number[], index: number, out: number[]) => number;

/** Encodes characters, giving each one the encoder refuses to the error handler, as CPython's multibyte codecs do. */
export function encodeSteps(points: readonly number[], errors: ErrorHandling, encode: Encoder): number[] {
  const out: number[] = [];
  let index = 0;
  while (index < points.length) {
    const taken = encode(points, index, out);
    if (taken > 0) {
      index += taken;
      continue;
    }
    const replacement = errors.encodeError(index, index + 1, ILLEGAL);
    if ('bytes' in replacement) out.push(...replacement.bytes);
    else {
      // oxlint-disable-next-line typescript/no-misused-spread -- Python encodes strings by code point.
      const replaced = [...replacement.text].map((char) => char.codePointAt(0) as number);
      for (let at = 0; at < replaced.length; at++) encode(replaced, at, out);
    }
    index++;
  }
  return out;
}

function pushPacked(out: number[], bytes: number): void {
  out.push(bytes >> 8, bytes & 0xff);
}

/** The encoder of ASCII and a table of two-byte sequences. */
function pairEncoder(encode: Map<number, number>): Encoder {
  return (points, index, out) => {
    const point = points[index];
    if (point < 0x80) {
      out.push(point);
      return 1;
    }
    const bytes = encode.get(point);
    if (bytes === undefined) return 0;
    pushPacked(out, bytes);
    return 1;
  };
}

/** The parts of a codec that keeps a state: its decoder's steps and its encoder, made afresh for each text. */
export interface StatefulParts {
  decoder: () => Stepper;
  encoder: () => { step: Encoder; reset: (out: number[]) => void };
  /** Whether a character at the end of a piece waits for the next, which may combine with it. */
  waitsAfter?: (point: number) => boolean;
}

/** Decodes as far as the data goes, stopping before a sequence the data cuts off unless `final`. */
function decodeIncrementally(
  data: Uint8Array,
  errors: ErrorHandling,
  final: boolean,
  step: Stepper
): { text: string; consumed: number } {
  let consumed = data.length;
  const text = decodeSteps(data, errors, (bytes, index) => {
    if (consumed !== data.length) return { text: '', length: bytes.length - index };
    const found = step(bytes, index);
    if (found !== 'incomplete' || final) return found;
    consumed = index;
    return { text: '', length: bytes.length - index };
  });
  return { text, consumed };
}

export function registerStatefulCodec(name: string, parts: StatefulParts): void {
  registerCodec(name, () => ({
    name,
    inlineHandlers: INLINE_HANDLERS,
    encode: (points, errors) => {
      const { step, reset } = parts.encoder();
      const out = encodeSteps(points, errors, step);
      reset(out);
      return Uint8Array.from(out);
    },
    decode: (data, errors) => decodeSteps(data, errors, parts.decoder()),
    incompleteTail: (data) => incompleteTail(data, parts.decoder()),
    incrementalDecoder: () => {
      const step = parts.decoder();
      return (data, errors, final) => decodeIncrementally(data, errors, final, step);
    },
    incrementalEncoder: () => {
      const { step, reset } = parts.encoder();
      let pending: number[] = [];
      return (points, errors, final) => {
        const all = [...pending, ...points];
        const keep = !final && all.length > 0 && parts.waitsAfter?.(all.at(-1) as number) === true ? 1 : 0;
        pending = all.slice(all.length - keep);
        const out = encodeSteps(all.slice(0, all.length - keep), errors, step);
        if (final) reset(out);
        return Uint8Array.from(out);
      };
    },
  }));
}

export function doubleByteCodec(name: string, step: Stepper, encoder: Encoder): TextCodec {
  return {
    name,
    inlineHandlers: INLINE_HANDLERS,
    encode: (points, errors) => Uint8Array.from(encodeSteps(points, errors, encoder)),
    decode: (data, errors) => decodeSteps(data, errors, step),
    incompleteTail: (data) => incompleteTail(data, step),
  };
}

for (const codec of ['gb2312', 'gbk', 'big5', 'cp950', 'cp949', 'johab']) {
  registerCodec(codec, () => {
    const { decode, encode } = tablesOf(codec);
    return doubleByteCodec(codec, (data, index) => pairStep(decode, data, index), pairEncoder(encode));
  });
}

// Big5-HKSCS --------------------------------------------------------------------------------------------------------

/** The sequences of Ê and ê with a combining macron or caron, which Big5-HKSCS encodes as one character. */
const HKSCS_PAIRS = new Map([
  [0xca * 0x1_00_00 + 0x3_04, 0x88_62],
  [0xca * 0x1_00_00 + 0x3_0c, 0x88_64],
  [0xea * 0x1_00_00 + 0x3_04, 0x88_a3],
  [0xea * 0x1_00_00 + 0x3_0c, 0x88_a5],
]);

registerCodec('big5hkscs', () => {
  const { decode, encode } = tablesOf('big5hkscs');
  const single = pairEncoder(encode);
  return doubleByteCodec(
    'big5hkscs',
    (data, index) => pairStep(decode, data, index),
    (points, index, out) => {
      const pair = HKSCS_PAIRS.get(points[index] * 0x1_00_00 + (points[index + 1] ?? 0));
      if (pair === undefined) return single(points, index, out);
      pushPacked(out, pair);
      return 2;
    }
  );
});

// GB18030 -----------------------------------------------------------------------------------------------------------

const isDigit = (byte: number | undefined): boolean => byte !== undefined && byte >= 0x30 && byte <= 0x39;
const isGbByte = (byte: number | undefined): boolean => byte !== undefined && byte >= 0x81 && byte <= 0xfe;
/** The linear index of GB18030's first four-byte sequence for the supplementary planes, 0x90 0x30 0x81 0x30. */
const SUPPLEMENTARY_START = 0x90 - 0x81;

/** The runs of GB18030's four-byte sequences for the BMP, as triples of first index, first code point, and length. */
function gb18030Runs(): [number, number, number][] {
  const runs: [number, number, number][] = [];
  for (let index = 0; index < GB18030_RANGES.length; index += 3) {
    runs.push([GB18030_RANGES[index], GB18030_RANGES[index + 1], GB18030_RANGES[index + 2]]);
  }
  return runs;
}

/** The run that holds `value` at field `field` of its triple, by binary search. */
function findRun(runs: [number, number, number][], value: number, field: 0 | 1): [number, number, number] | undefined {
  let low = 0;
  let high = runs.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const run = runs[middle];
    if (value < run[field]) high = middle - 1;
    else if (value >= run[field] + run[2]) low = middle + 1;
    else return run;
  }
  return undefined;
}

// code-gauge-allow functionCognitiveComplexity 23 -- Follows CPython's GB18030 codec, with its two- and four-byte sequences.
// code-gauge-allow functionNcss 33 -- Follows CPython's GB18030 codec, with its two- and four-byte sequences.
function gb18030Codec(): TextCodec {
  const { decode, encode } = tablesOf('gb18030');
  const runs = gb18030Runs();
  const step: Stepper = (data, index) => {
    if (data[index] < 0x80 || !isDigit(data[index + 1])) return pairStep(decode, data, index);
    if (index + 3 >= data.length) return 'incomplete';
    const [b1, b2, b3, b4] = data.subarray(index, index + 4);
    if (!isGbByte(b1) || !isGbByte(b3) || !isDigit(b4)) return 'illegal';
    const linear = (((b1 - 0x81) * 10 + b2 - 0x30) * 126 + b3 - 0x81) * 10 + b4 - 0x30;
    const supplementary = linear - SUPPLEMENTARY_START * 12_600;
    if (supplementary >= 0) {
      return supplementary < 0x10_00_00
        ? { text: String.fromCodePoint(0x1_00_00 + supplementary), length: 4 }
        : 'illegal';
    }
    const run = findRun(runs, linear, 0);
    return run ? { text: String.fromCodePoint(run[1] + linear - run[0]), length: 4 } : 'illegal';
  };
  const pairs = pairEncoder(encode);
  const encoder: Encoder = (points, index, out) => {
    if (pairs(points, index, out) > 0) return 1;
    const point = points[index];
    let linear: number;
    if (point >= 0x1_00_00) linear = SUPPLEMENTARY_START * 12_600 + point - 0x1_00_00;
    else {
      const run = findRun(runs, point, 1);
      if (!run) return 0;
      linear = run[0] + point - run[1];
    }
    out.push(
      0x81 + Math.floor(linear / 12_600),
      0x30 + (Math.floor(linear / 1260) % 10),
      0x81 + (Math.floor(linear / 10) % 126),
      0x30 + (linear % 10)
    );
    return 1;
  };
  return doubleByteCodec('gb18030', step, encoder);
}

registerCodec('gb18030', gb18030Codec);

// EUC-KR ------------------------------------------------------------------------------------------------------------

/** The compatibility jamo, from U+3131, of the initial consonants and of the final ones after none, in index order. */
const CHOSEONG = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JONGSEONG = 'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';
const JAMO_LEAD = 0xa4;
const FILLER = 0xd4;
const HANGUL_FIRST = 0xac_00;
const HANGUL_LAST = 0xd7_a3;

/** The byte after 0xA4 of a compatibility jamo, which KS X 1001 lists from U+3131 at 0xA4A1. */
const jamoByte = (jamo: string): number => 0xa1 + (jamo.codePointAt(0) as number) - 0x31_31;

/**
 * Decodes a KS X 1001:1998 Annex 3 make-up sequence at `index`: 0xA4 0xD4, then the initial, the medial, and the
 * final jamo, each after 0xA4, the final 0xD4 for none.
 */
function decodeMakeUp(data: Uint8Array, index: number): Step {
  if (index + 7 >= data.length) return 'incomplete';
  if (data[index + 2] !== JAMO_LEAD || data[index + 4] !== JAMO_LEAD || data[index + 6] !== JAMO_LEAD) return 'illegal';
  const initial = CHOSEONG.split('').findIndex((jamo) => jamoByte(jamo) === data[index + 3]);
  const medial = data[index + 5] - 0xbf;
  const last = data[index + 7];
  const final = last === FILLER ? 0 : JONGSEONG.split('').findIndex((jamo) => jamoByte(jamo) === last) + 1;
  if (initial === -1 || medial < 0 || medial > 20 || (final === 0 && last !== FILLER)) return 'illegal';
  return { text: String.fromCodePoint(HANGUL_FIRST + initial * 588 + medial * 28 + final), length: 8 };
}

/** Encodes a Hangul syllable outside KS X 1001 as a make-up sequence. */
function encodeMakeUp(point: number, out: number[]): void {
  const index = point - HANGUL_FIRST;
  const final = index % 28;
  out.push(JAMO_LEAD, FILLER, JAMO_LEAD, jamoByte(CHOSEONG[Math.floor(index / 588)]));
  out.push(JAMO_LEAD, 0xbf + (Math.floor(index / 28) % 21), JAMO_LEAD);
  out.push(final === 0 ? FILLER : jamoByte(JONGSEONG[final - 1]));
}

registerCodec('euc_kr', () => {
  const { decode, encode } = tablesOf('euc_kr');
  const pairs = pairEncoder(encode);
  return doubleByteCodec(
    'euc_kr',
    (data, index) =>
      data[index] === JAMO_LEAD && data[index + 1] === FILLER
        ? decodeMakeUp(data, index)
        : pairStep(decode, data, index),
    (points, index, out) => {
      if (pairs(points, index, out) > 0) return 1;
      if (points[index] < HANGUL_FIRST || points[index] > HANGUL_LAST) return 0;
      encodeMakeUp(points[index], out);
      return 1;
    }
  );
});

// HZ ----------------------------------------------------------------------------------------------------------------

/** HZ, which writes GB2312 in seven bits between `~{` and `~}`, and `~~` for a tilde. */
function hzParts(): StatefulParts {
  const gb2312 = tablesOf('gb2312');
  return {
    decoder: () => {
      const state = { inGb: false };
      return (bytes, index) => hzStep(bytes, index, state, gb2312.decode);
    },
    encoder: () => {
      const state = { inGb: false };
      return {
        step: hzEncoder(state, gb2312.encode),
        reset: (out) => {
          if (state.inGb) out.push(0x7e, 0x7d);
          state.inGb = false;
        },
      };
    },
  };
}

/** Encodes in ASCII and in GB2312 between `~{` and `~}`. */
function hzEncoder(state: { inGb: boolean }, encode: Map<number, number>): Encoder {
  return (all, index, bytes) => {
    const point = all[index];
    const packed = encode.get(point);
    if (point >= 0x80 && packed === undefined) return 0;
    if (point < 0x80 === state.inGb) bytes.push(0x7e, state.inGb ? 0x7d : 0x7b);
    state.inGb = point >= 0x80;
    if (point === 0x7e) bytes.push(0x7e, 0x7e);
    else if (state.inGb) bytes.push(((packed as number) >> 8) & 0x7f, (packed as number) & 0x7f);
    else bytes.push(point);
    return 1;
  };
}

/** Decodes the character or escape at `index`, in ASCII or, after `~{`, in GB2312's seven-bit bytes. */
function hzStep(bytes: Uint8Array, index: number, state: { inGb: boolean }, decode: Map<number, string>): Step {
  const byte = bytes[index];
  if (byte === 0x7e) return hzEscape(bytes, index, state);
  if (byte >= 0x80) return 'illegal';
  if (!state.inGb) return { text: String.fromCodePoint(byte), length: 1 };
  if (index + 1 >= bytes.length) return 'incomplete';
  if (bytes[index + 1] >= 0x80) return 'illegal';
  const text = decode.get((byte | 0x80) * 256 + (bytes[index + 1] | 0x80));
  return text === undefined ? 'illegal' : { text, length: 2 };
}

/** `~~` for a tilde, `~{` and `~}` to switch to GB2312 and back, and `~` before a newline that continues the line. */
function hzEscape(bytes: Uint8Array, index: number, state: { inGb: boolean }): Step {
  if (index + 1 >= bytes.length) return 'incomplete';
  const next = bytes[index + 1];
  if (next === 0x7e && !state.inGb) return { text: '~', length: 2 };
  if ((next === 0x7b && !state.inGb) || (next === 0x7d && state.inGb)) state.inGb = next === 0x7b;
  else if (next !== 0x0a || state.inGb) return 'illegal';
  return { text: '', length: 2 };
}

// HZ's tables are built when a program first uses it.
let hz: StatefulParts | undefined;
registerStatefulCodec('hz', {
  decoder: () => (hz ??= hzParts()).decoder(),
  encoder: () => (hz ??= hzParts()).encoder(),
});
