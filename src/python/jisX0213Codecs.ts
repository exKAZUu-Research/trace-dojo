// CPython's shift_jis_2004, shift_jisx0213, euc_jis_2004, and euc_jisx0213 codecs, which write JIS X 0213 in the
// layouts of Shift_JIS and EUC-JP, as _codecs_jp.c does.
import { type Encoder, registerStatefulCodec, type Step, type Stepper } from './cjkCodecs';
import { jisDecode, jisxCommon } from './japaneseCodecs';
import { decodeIn, encodeWithPairs, jisX0213, lacks, PLANE_2 } from './jisX0213';

type Edition = 2000 | 2004;

const HALFWIDTH_KATAKANA_OFFSET = 0xfe_c0;

/** A decoded code's step: its text, or the error CPython reports, two bytes for a cell :2000 lacks. */
function codeStep(text: string | undefined, length: number): Step {
  if (text === 'refused') return { illegal: 2 };
  return text === undefined ? 'illegal' : { text, length };
}

// Shift_JIS-2004 ----------------------------------------------------------------------------------------------------

/** JIS X 0201 Roman and katakana, which Shift_JIS-2004 writes in single bytes. */
function jisX0201(byte: number): string | undefined {
  if (byte === 0x5c) return '¥';
  if (byte === 0x7e) return '‾';
  if (byte < 0x80) return String.fromCodePoint(byte);
  return byte >= 0xa1 && byte <= 0xdf ? String.fromCodePoint(HALFWIDTH_KATAKANA_OFFSET + byte) : undefined;
}

/** The code, plane 2 with the bit, of a Shift_JIS-2004 lead and trail byte, as CPython's decoder computes it. */
function shiftJisCode(lead: number, byte: number): number {
  const trail = byte < 0x80 ? byte - 0x40 : byte - 0x41;
  let first = 2 * (lead < 0xe0 ? lead - 0x81 : lead - 0xc1) + (trail < 0x5e ? 0 : 1);
  const second = (trail < 0x5e ? trail : trail - 0x5e) + 0x21;
  if (first < 0x5e) return ((first + 0x21) << 8) | second;
  if (first >= 0x67) first += 0x07;
  else if (first >= 0x63 || first === 0x5f) first -= 0x37;
  else first -= 0x3d;
  return PLANE_2 | (first << 8) | second;
}

// code-gauge-allow functionCognitiveComplexity 18 -- Follows CPython's Shift_JIS-2004 decoder, one case per kind of byte.
function shiftJisStep(edition: Edition): Stepper {
  return (data, index) => {
    const lead = data[index];
    const single = jisX0201(lead);
    if (single !== undefined) return { text: single, length: 1 };
    if (!((lead >= 0x81 && lead <= 0x9f) || (lead >= 0xe0 && lead <= 0xfc))) return 'illegal';
    if (index + 1 >= data.length) return 'incomplete';
    const byte = data[index + 1];
    if (byte < 0x40 || (byte > 0x7e && byte < 0x80) || byte > 0xfc) return 'illegal';
    const code = shiftJisCode(lead, byte);
    if (!(code & PLANE_2)) return codeStep(decodeIn(code, edition), 2);
    const text = decodeIn(code, edition);
    return text === 'refused' || text === undefined ? 'illegal' : { text, length: 2 };
  };
}

/** The Shift_JIS-2004 bytes of a code, as CPython's encoder lays out plane 1 and plane 2. */
function shiftJisBytes(code: number): [number, number] {
  let first = code >> 8;
  const second = (code & 0xff) - 0x21;
  if (first & 0x80) {
    if (first >= 0xee) first -= 0x87;
    else if (first >= 0xac || first === 0xa8) first -= 0x49;
    else first -= 0x43;
  } else {
    first -= 0x21;
  }
  const trail = second + (first & 1 ? 0x5e : 0);
  const lead = first >> 1;
  return [lead + (lead < 0x1f ? 0x81 : 0xc1), trail + (trail < 0x3f ? 0x40 : 0x41)];
}

function shiftJisEncoder(edition: Edition): Encoder {
  return (points, index, out) => {
    const point = points[index];
    if (point < 0x80 && point !== 0x5c && point !== 0x7e) out.push(point);
    else if (point === 0xa5) out.push(0x5c);
    else if (point === 0x20_3e) out.push(0x7e);
    else if (point >= 0xff_61 && point <= 0xff_9f) out.push(point - HALFWIDTH_KATAKANA_OFFSET);
    else {
      const found = encodeWithPairs(points, index, edition);
      if (found === undefined) return 0;
      out.push(...shiftJisBytes(found.code));
      return found.length;
    }
    return 1;
  };
}

// EUC-JIS-2004 ------------------------------------------------------------------------------------------------------

/** A character after EUC's 0x8F: of plane 2, or of JIS X 0212 where plane 2 has nothing. */
function eucPlane2(first: number, last: number, edition: Edition): Step {
  const text = decodeIn(PLANE_2 | (first << 8) | last, edition);
  if (typeof text === 'string' && text !== 'refused') return { text, length: 3 };
  const inRange = first >= 0x21 && last >= 0x21 && first <= 0x7e && last <= 0x7e;
  const point = inRange ? jisDecode('0212', first, last) : undefined;
  return point === undefined ? 'illegal' : { text: String.fromCodePoint(point), length: 3 };
}

// code-gauge-allow functionCognitiveComplexity 21 -- Follows CPython's EUC-JIS-2004 decoder, one case per kind of lead byte.
function eucStep(edition: Edition): Stepper {
  return (data, index) => {
    const lead = data[index];
    if (lead < 0x80) return { text: String.fromCodePoint(lead), length: 1 };
    const needed = lead === 0x8f ? 3 : 2;
    if (index + needed > data.length) return 'incomplete';
    const second = data[index + 1];
    if (lead === 0x8e) {
      return second >= 0xa1 && second <= 0xdf
        ? { text: String.fromCodePoint(HALFWIDTH_KATAKANA_OFFSET + second), length: 2 }
        : 'illegal';
    }
    if (lead === 0x8f) return eucPlane2(second ^ 0x80, data[index + 2] ^ 0x80, edition);
    const code = ((lead ^ 0x80) << 8) | (second ^ 0x80);
    if (edition === 2000 && decodeIn(code, 2000) === 'refused') return { illegal: 2 };
    if (code === 0x21_40) return { text: '＼', length: 2 };
    if (code === 0x22_32) return { text: '～', length: 2 };
    return codeStep(decodeIn(code, edition), 2);
  };
}

// code-gauge-allow functionCognitiveComplexity 20 -- Follows CPython's EUC-JIS-2004 encoder, which tries each map in turn.
function eucEncoder(edition: Edition): Encoder {
  return (points, index, out) => {
    const point = points[index];
    if (point < 0x80) {
      out.push(point);
      return 1;
    }
    if (lacks(point, edition)) return 0;
    const found = encodeWithPairs(points, index, edition);
    const common = found === undefined && point <= 0xff_ff ? jisxCommon(point) : undefined;
    if (found) {
      const { code } = found;
      out.push(
        ...(code & PLANE_2 ? [0x8f, code >> 8, (code & 0xff) | 0x80] : [(code >> 8) | 0x80, (code & 0xff) | 0x80])
      );
      return found.length;
    }
    if (common !== undefined && common & PLANE_2) out.push(0x8f, common >> 8, (common & 0xff) | 0x80);
    else if (point >= 0xff_61 && point <= 0xff_9f) out.push(0x8e, point - HALFWIDTH_KATAKANA_OFFSET);
    else if (point === 0xff_3c) out.push(0xa1, 0xc0);
    else if (point === 0xff_5e) out.push(0xa2, 0xb2);
    else return 0;
    return 1;
  };
}

/** The codecs of this file end their text in no state of their own. */
const noReset = (): void => {};

// A character that may start a pair waits for the next at the end of a piece an incremental encoder gets.
const waitsAfter = (point: number): boolean => jisX0213().pairStarts.has(point);
for (const [name, edition] of [
  ['shift_jis_2004', 2004],
  ['shift_jisx0213', 2000],
] as const) {
  registerStatefulCodec(name, {
    decoder: () => shiftJisStep(edition),
    encoder: () => ({ step: shiftJisEncoder(edition), reset: noReset }),
    waitsAfter,
  });
}
for (const [name, edition] of [
  ['euc_jis_2004', 2004],
  ['euc_jisx0213', 2000],
] as const) {
  registerStatefulCodec(name, {
    decoder: () => eucStep(edition),
    encoder: () => ({ step: eucEncoder(edition), reset: noReset }),
    waitsAfter,
  });
}

/** The codec modules of this file. */
export const JIS_X_0213_MODULES = ['shift_jis_2004', 'shift_jisx0213', 'euc_jis_2004', 'euc_jisx0213'];
