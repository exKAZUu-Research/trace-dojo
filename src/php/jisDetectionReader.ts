// oxlint-disable unicorn/prefer-code-point -- Each code unit is one PHP byte.
import { jisDetectionCodePoint } from './detectionDecodeTables';
import { rt } from './runtime';

const BAD = -1;
const ASCII = 0;
const ROMAN = 1;
const KANA = 2;
const SHIFTED_KANA = 3;
const JIS_0208 = 4;
const JIS_0212 = 5;
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
        codes.push(BAD);
        for (const byte of escape.prefix) codes.push(byte.charCodeAt(0));
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

function readEscape(bytes: string, start: number): { width: number; prefix: string; state?: number } {
  const available = bytes.length - start;
  const first = bytes[start];
  const stem = first === '(' || first === '$' ? first : '';
  if (available < 2) return { width: stem.length, prefix: '' };
  const long = bytes.startsWith('$(', start);
  if (long && available === 2) return { width: 2, prefix: '' };
  const prefix = bytes.slice(start, start + (long ? 3 : 2));
  const state = ESCAPES.get(prefix);
  if (state !== undefined) return { width: prefix.length, prefix, state };
  const partial = long ? '$(' : stem;
  return { width: partial.length, prefix: partial };
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
