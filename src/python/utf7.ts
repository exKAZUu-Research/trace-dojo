// UTF-7 (RFC 2152), as CPython's PyUnicode_EncodeUTF7 and PyUnicode_DecodeUTF7Stateful convert it, with the
// `_codecs` functions utf_7_encode and utf_7_decode.
import { bytesLikeData, newBytes } from './bytesValues';
import { ErrorHandling, registerCodec } from './codecs';
import { builtin } from './define';
import { isTruthy } from './objects';
import { currentRuntime } from './runtimeContext';
import { newTuple, None, typeError, typeName } from './types';
import type { PyValue } from './values';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const PLUS = 0x2b;
const MINUS = 0x2d;

const isBase64 = (byte: number): boolean => byte < 0x80 && BASE64.includes(String.fromCodePoint(byte));
/** Whether the encoder writes a character as itself: printable ASCII and whitespace, but for `+`, `\`, and `~`. */
const encodesDirectly = (point: number): boolean =>
  point === 0x09 ||
  point === 0x0a ||
  point === 0x0d ||
  (point >= 0x20 && point < 0x7f && point !== PLUS && point !== 0x5c && point !== 0x7e);

/** Encodes code points, writing those outside the direct set as base-64 UTF-16 between `+` and `-`. */
// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes PyUnicode_EncodeUTF7.
function encodeUtf7(points: readonly number[]): Uint8Array {
  const out: number[] = [];
  let inShift = false;
  let bits = 0;
  let buffer = 0;
  const writeUnit = (unit: number): void => {
    bits += 16;
    buffer = (buffer << 16) | unit;
    while (bits >= 6) {
      out.push(BASE64.codePointAt((buffer >> (bits - 6)) & 0x3f) as number);
      bits -= 6;
    }
    buffer &= (1 << bits) - 1;
  };
  for (const point of points) {
    if (inShift && encodesDirectly(point)) {
      if (bits > 0) out.push(BASE64.codePointAt((buffer << (6 - bits)) & 0x3f) as number);
      bits = 0;
      buffer = 0;
      inShift = false;
      // A character outside the base-64 set ends the shift by itself, and a `-` would be absorbed.
      if (isBase64(point) || point === MINUS) out.push(MINUS);
      out.push(point);
      continue;
    }
    if (!inShift) {
      if (point === PLUS) {
        out.push(PLUS, MINUS);
        continue;
      }
      if (encodesDirectly(point)) {
        out.push(point);
        continue;
      }
      out.push(PLUS);
      inShift = true;
    }
    if (point >= 0x1_00_00) {
      writeUnit(0xd8_00 | ((point - 0x1_00_00) >> 10));
      writeUnit(0xdc_00 | ((point - 0x1_00_00) & 0x3_ff));
    } else writeUnit(point);
  }
  if (bits > 0) out.push(BASE64.codePointAt((buffer << (6 - bits)) & 0x3f) as number);
  if (inShift) out.push(MINUS);
  return Uint8Array.from(out);
}

/** The state of the decoder in a base-64 section. */
interface Shift {
  /** Where the section's `+` is. */
  start: number;
  /** How much text the decoder had written before the section. */
  textStart: number;
  bits: number;
  buffer: number;
  surrogate: number;
}

/** Decodes UTF-7, or, unless `final`, as much as ends outside a base-64 section, with how many bytes it used. */
// code-gauge-allow functionCognitiveComplexity 40 -- Transcribes PyUnicode_DecodeUTF7Stateful, one case per state of the decoder.
// code-gauge-allow functionNcss 60 -- Transcribes PyUnicode_DecodeUTF7Stateful, one case per state of the decoder.
function decodeUtf7(data: Uint8Array, errors: ErrorHandling, final: boolean): { text: string; consumed: number } {
  let text = '';
  let shift: Shift | undefined;
  let index = 0;
  let errorStart = 0;
  const fail = (reason: string): void => {
    const failure = errors.decodeError(errorStart, index, reason);
    text += failure.text;
    index = failure.resume;
  };
  for (;;) {
    while (index < data.length) {
      const byte = data[index];
      if (shift) {
        if (isBase64(byte)) {
          shift.buffer = (shift.buffer << 6) | BASE64.indexOf(String.fromCodePoint(byte));
          shift.bits += 6;
          index++;
          if (shift.bits < 16) continue;
          const unit = shift.buffer >> (shift.bits - 16);
          shift.bits -= 16;
          shift.buffer &= (1 << shift.bits) - 1;
          if (shift.surrogate !== 0) {
            if (unit >= 0xdc_00 && unit <= 0xdf_ff) {
              text += String.fromCodePoint(0x1_00_00 + ((shift.surrogate - 0xd8_00) << 10) + unit - 0xdc_00);
              shift.surrogate = 0;
              continue;
            }
            text += String.fromCodePoint(shift.surrogate);
            shift.surrogate = 0;
          }
          if (unit >= 0xd8_00 && unit <= 0xdb_ff) shift.surrogate = unit;
          else text += String.fromCodePoint(unit);
          continue;
        }
        const left = shift;
        shift = undefined;
        if (left.bits >= 6 || (left.bits > 0 && left.buffer !== 0)) {
          index++;
          fail(left.bits >= 6 ? 'partial character in shift sequence' : 'non-zero padding bits in shift sequence');
          continue;
        }
        if (left.surrogate !== 0 && byte <= 0x7f) text += String.fromCodePoint(left.surrogate);
        if (byte === MINUS) index++;
        continue;
      }
      if (byte === PLUS) {
        errorStart = index;
        index++;
        if (index < data.length && data[index] === MINUS) {
          index++;
          text += '+';
        } else if (index < data.length && !isBase64(data[index])) {
          index++;
          fail('ill-formed sequence');
        } else {
          shift = { start: errorStart, textStart: text.length, bits: 0, buffer: 0, surrogate: 0 };
        }
        continue;
      }
      errorStart = index;
      index++;
      if (byte <= 0x7f) text += String.fromCodePoint(byte);
      else fail('unexpected special character');
    }
    if (shift && !final) return { text: text.slice(0, shift.textStart), consumed: shift.start };
    const left = shift;
    shift = undefined;
    if (!left || (left.surrogate === 0 && left.bits < 6 && (left.bits === 0 || left.buffer === 0))) break;
    const failure = errors.decodeError(left.start, data.length, 'unterminated shift sequence');
    text += failure.text;
    index = failure.resume;
    // A handler may resume inside the data, where decoding goes on outside a base-64 section.
    if (index >= data.length) break;
  }
  return { text, consumed: data.length };
}

registerCodec('utf_7', () => ({
  name: 'utf7',
  encode: (points) => encodeUtf7(points),
  decode: (data, errors) => decodeUtf7(data, errors, true).text,
}));

function errorsName(name: string, errors: PyValue | undefined): string {
  if (errors === undefined || errors === None) return 'strict';
  if (typeof errors !== 'string') throw typeError(`${name}() argument 2 must be str or None, not ${typeName(errors)}`);
  return errors;
}

/** The UTF-7 functions of `_codecs`. */
export function utf7Natives(): [string, PyValue][] {
  return [
    [
      'utf_7_encode',
      builtin('utf_7_encode', 'expected', 1, 2, ([input, errors]) => {
        if (typeof input !== 'string') throw typeError(`utf_7_encode() argument 1 must be str, not ${typeName(input)}`);
        errorsName('utf_7_encode', errors);
        // oxlint-disable-next-line typescript/no-misused-spread -- Python encodes strings by code point.
        const points = [...input].map((char) => char.codePointAt(0) as number);
        currentRuntime().scan(points.length);
        return newTuple([newBytes(encodeUtf7(points)), BigInt(points.length)]);
      }),
    ],
    [
      'utf_7_decode',
      builtin('utf_7_decode', 'expected', 1, 3, ([input, errors, final]) => {
        const data = bytesLikeData(input);
        if (data === undefined) throw typeError(`a bytes-like object is required, not '${typeName(input)}'`);
        const handling = new ErrorHandling(errorsName('utf_7_decode', errors), 'utf7', new Uint8Array(data));
        currentRuntime().scan(data.length);
        const { text, consumed } = decodeUtf7(data, handling, final !== undefined && isTruthy(final));
        return newTuple([text, BigInt(consumed)]);
      }),
    ],
  ];
}
