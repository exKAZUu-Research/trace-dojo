// UTF-7 (RFC 2152), as CPython's PyUnicode_EncodeUTF7 and PyUnicode_DecodeUTF7Stateful convert it, with the
// `_codecs` functions utf_7_encode and utf_7_decode.
import { bytesLikeData, newBytes } from './bytesValues';
import { ErrorHandling, registerCodec } from './codecs';
import { builtin } from './define';
import { isTruthy } from './objects';
import { currentRuntime } from './runtimeContext';
import { newTuple, None, stringValue, typeError, typeName } from './types';
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

/** Writes UTF-16 code units as base-64, six bits at a time, keeping the bits that do not fill a character. */
class Base64Writer {
  private bits = 0;
  private buffer = 0;

  constructor(private readonly out: number[]) {}

  write(unit: number): void {
    this.bits += 16;
    this.buffer = (this.buffer << 16) | unit;
    while (this.bits >= 6) {
      this.out.push(BASE64.codePointAt((this.buffer >> (this.bits - 6)) & 0x3f) as number);
      this.bits -= 6;
    }
    this.buffer &= (1 << this.bits) - 1;
  }

  /** Writes the bits left, padded with zeros. */
  flush(): void {
    if (this.bits > 0) this.out.push(BASE64.codePointAt((this.buffer << (6 - this.bits)) & 0x3f) as number);
    this.bits = 0;
    this.buffer = 0;
  }
}

/** Encodes code points, writing those outside the direct set as base-64 UTF-16 between `+` and `-`. */
// code-gauge-allow functionCognitiveComplexity 22 -- Transcribes PyUnicode_EncodeUTF7, which decides each character in one pass.
function encodeUtf7(points: readonly number[]): Uint8Array {
  const out: number[] = [];
  const writer = new Base64Writer(out);
  let inShift = false;
  for (const point of points) {
    if (encodesDirectly(point)) {
      if (inShift) {
        writer.flush();
        // A character outside the base-64 set ends the shift by itself, and a `-` would be absorbed.
        if (isBase64(point) || point === MINUS) out.push(MINUS);
      }
      inShift = false;
      out.push(point);
    } else if (!inShift && point === PLUS) {
      out.push(PLUS, MINUS);
    } else {
      if (!inShift) out.push(PLUS);
      inShift = true;
      if (point >= 0x1_00_00) {
        writer.write(0xd8_00 | ((point - 0x1_00_00) >> 10));
        writer.write(0xdc_00 | ((point - 0x1_00_00) & 0x3_ff));
      } else writer.write(point);
    }
  }
  writer.flush();
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

const isHighSurrogate = (unit: number): boolean => unit >= 0xd8_00 && unit <= 0xdb_ff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc_00 && unit <= 0xdf_ff;
/** Whether a base-64 section ends with bits that make no character, which CPython reports. */
const hasLeftoverBits = (shift: Shift): boolean => shift.bits >= 6 || (shift.bits > 0 && shift.buffer !== 0);

/** CPython's PyUnicode_DecodeUTF7Stateful, one method per state of the decoder. */
class Utf7Decoder {
  text = '';
  private shift: Shift | undefined;
  private index = 0;
  private errorStart = 0;

  constructor(
    private readonly data: Uint8Array,
    private readonly errors: ErrorHandling
  ) {}

  /** Decodes all the data, or, unless `final`, as much as ends outside a base-64 section. */
  run(final: boolean): { text: string; consumed: number } {
    const { data } = this;
    for (;;) {
      while (this.index < data.length) this.step(data[this.index]);
      const left = this.shift;
      if (left && !final) return { text: this.text.slice(0, left.textStart), consumed: left.start };
      this.shift = undefined;
      if (!left || (left.surrogate === 0 && !hasLeftoverBits(left))) break;
      this.errorStart = left.start;
      this.index = data.length;
      this.fail('unterminated shift sequence');
      // A handler may resume inside the data, where decoding goes on outside a base-64 section.
      if (this.index >= data.length) break;
    }
    return { text: this.text, consumed: data.length };
  }

  private fail(reason: string): void {
    const failure = this.errors.decodeError(this.errorStart, this.index, reason);
    this.text += failure.text;
    this.index = failure.resume;
  }

  private step(byte: number): void {
    if (this.shift && isBase64(byte)) this.base64Byte(this.shift, byte);
    else if (this.shift) this.leaveShift(this.shift, byte);
    else if (byte === PLUS) this.plus();
    else {
      this.errorStart = this.index++;
      if (byte <= 0x7f) this.text += String.fromCodePoint(byte);
      else this.fail('unexpected special character');
    }
  }

  private base64Byte(shift: Shift, byte: number): void {
    shift.buffer = (shift.buffer << 6) | BASE64.indexOf(String.fromCodePoint(byte));
    shift.bits += 6;
    this.index++;
    if (shift.bits < 16) return;
    const unit = shift.buffer >> (shift.bits - 16);
    shift.bits -= 16;
    shift.buffer &= (1 << shift.bits) - 1;
    if (shift.surrogate !== 0 && isLowSurrogate(unit)) {
      this.text += String.fromCodePoint(0x1_00_00 + ((shift.surrogate - 0xd8_00) << 10) + unit - 0xdc_00);
      shift.surrogate = 0;
      return;
    }
    if (shift.surrogate !== 0) this.text += String.fromCodePoint(shift.surrogate);
    shift.surrogate = isHighSurrogate(unit) ? unit : 0;
    if (!isHighSurrogate(unit)) this.text += String.fromCodePoint(unit);
  }

  /** Ends a base-64 section at a byte outside the base-64 set, which a `-` is absorbed into. */
  private leaveShift(shift: Shift, byte: number): void {
    this.shift = undefined;
    if (hasLeftoverBits(shift)) {
      this.index++;
      this.fail(shift.bits >= 6 ? 'partial character in shift sequence' : 'non-zero padding bits in shift sequence');
      return;
    }
    if (shift.surrogate !== 0 && byte <= 0x7f) this.text += String.fromCodePoint(shift.surrogate);
    if (byte === MINUS) this.index++;
  }

  /** A `+`: a `+` itself before `-`, or the start of a base-64 section. */
  private plus(): void {
    const { data } = this;
    this.errorStart = this.index++;
    if (this.index < data.length && data[this.index] === MINUS) {
      this.index++;
      this.text += '+';
    } else if (this.index < data.length && !isBase64(data[this.index])) {
      this.index++;
      this.fail('ill-formed sequence');
    } else {
      this.shift = { start: this.errorStart, textStart: this.text.length, bits: 0, buffer: 0, surrogate: 0 };
    }
  }
}

function decodeUtf7(data: Uint8Array, errors: ErrorHandling, final: boolean): { text: string; consumed: number } {
  return new Utf7Decoder(data, errors).run(final);
}

registerCodec('utf_7', () => ({
  name: 'utf7',
  encode: (points) => encodeUtf7(points),
  decode: (data, errors) => decodeUtf7(data, errors, true).text,
}));

function errorsName(name: string, errors: PyValue | undefined): string {
  if (errors === undefined || errors === None) return 'strict';
  errors = stringValue(errors) ?? errors;
  if (typeof errors !== 'string') throw typeError(`${name}() argument 2 must be str or None, not ${typeName(errors)}`);
  return errors;
}

/** The UTF-7 functions of `_codecs`. */
export function utf7Natives(): [string, PyValue][] {
  return [
    [
      'utf_7_encode',
      builtin('utf_7_encode', 'expected', 1, 2, ([input, errors]) => {
        input = stringValue(input) ?? input;
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
