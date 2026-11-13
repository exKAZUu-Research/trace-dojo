import { hexOf } from '../bytesCase';
import { bytesLikeData, latin1Bytes, latin1Text, newBytes } from '../bytesValues';
import { builtin } from '../define';
import { registerModule } from '../modules';
import { argument } from '../nativeArgs';
import { toIndex } from '../numbers';
import { isTruthy } from '../objects';
import { exceptionClassNamed, newException, typeError, typeName, unbox, valueError } from '../types';
import { PyError, type PyValue } from '../values';
import { decodeQp, decodeUu, encodeQp, encodeUu } from './binasciiText';
import { builtinClassWithBase } from './moduleClasses';

export const binasciiErrorClass = builtinClassWithBase('Error', exceptionClassNamed('ValueError'), 'binascii');
const incompleteClass = builtinClassWithBase('Incomplete', exceptionClassNamed('Exception'), 'binascii');

export function binasciiError(message: string): PyError {
  return new PyError(newException(binasciiErrorClass, [message]));
}

/** The bytes of an argument that may also be an ASCII string, as binascii's `ascii_buffer` converter reads it. */
function asciiData(argumentValue: PyValue): Uint8Array {
  const value = unbox(argumentValue);
  if (typeof value === 'string') {
    // oxlint-disable-next-line eslint/no-control-regex -- ASCII includes the control characters.
    if (!/^[\u0000-\u007F]*$/.test(value)) throw valueError('string argument should contain only ASCII characters');
    return latin1Bytes(value);
  }
  const data = bytesLikeData(value);
  if (data === undefined) throw typeError(`argument should be bytes, buffer or ASCII string, not '${typeName(value)}'`);
  return data;
}

function binaryData(value: PyValue): Uint8Array {
  const data = bytesLikeData(value);
  if (data === undefined) throw typeError(`a bytes-like object is required, not '${typeName(value)}'`);
  return data;
}

// Base64 ------------------------------------------------------------------------------------------------------------

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES = new Map(BASE64_ALPHABET.split('').map((char, index) => [char.codePointAt(0) as number, index]));

export function encodeBase64(data: Uint8Array, newline: boolean): Uint8Array {
  let text = '';
  for (let index = 0; index < data.length; index += 3) {
    const chunk = (data[index] << 16) | ((data[index + 1] ?? 0) << 8) | (data[index + 2] ?? 0);
    const available = Math.min(3, data.length - index);
    for (let position = 0; position < 4; position++) {
      text += position <= available ? BASE64_ALPHABET[(chunk >> (18 - 6 * position)) & 0x3f] : '=';
    }
  }
  return latin1Bytes(newline ? `${text}\n` : text);
}

/** Decodes base64 as CPython's binascii.a2b_base64 does, skipping other characters unless `strict`. */
export function decodeBase64(data: Uint8Array, strict: boolean): Uint8Array {
  if (strict && data[0] === 0x3d) throw binasciiError('Leading padding not allowed');
  const decoder = new Base64Decoder(strict);
  for (let index = 0; index < data.length; index++) {
    if (decoder.feed(data[index], index + 1 < data.length)) return Uint8Array.from(decoder.out);
  }
  return decoder.finish();
}

/** The state of binascii.a2b_base64: the position in the current quad and the bits it carries over. */
class Base64Decoder {
  readonly out: number[] = [];
  private quadPosition = 0;
  private leftover = 0;
  private pads = 0;
  private paddingStarted = false;

  constructor(private readonly strict: boolean) {}

  /** Takes one byte, returning true when padding ends the data. */
  feed(byte: number, more: boolean): boolean {
    if (byte === 0x3d) return this.pad(more);
    const value = BASE64_VALUES.get(byte);
    if (value === undefined) {
      if (this.strict) throw binasciiError('Only base64 data is allowed');
      return false;
    }
    if (this.strict && this.paddingStarted) throw binasciiError('Discontinuous padding not allowed');
    this.pads = 0;
    const { quadPosition, leftover } = this;
    if (quadPosition === 1) this.out.push((leftover << 2) | (value >> 4));
    else if (quadPosition === 2) this.out.push(((leftover << 4) | (value >> 2)) & 0xff);
    else if (quadPosition === 3) this.out.push(((leftover << 6) | value) & 0xff);
    this.leftover = quadPosition === 0 ? value : value & [0, 0x0f, 0x03, 0][quadPosition];
    this.quadPosition = (quadPosition + 1) % 4;
    return false;
  }

  private pad(more: boolean): boolean {
    this.paddingStarted = true;
    if (this.strict && this.quadPosition === 0) throw binasciiError('Excess padding not allowed');
    if (this.quadPosition < 2 || this.quadPosition + ++this.pads < 4) return false;
    if (this.strict && more) throw binasciiError('Excess data after padding');
    return true;
  }

  finish(): Uint8Array {
    if (this.quadPosition === 1) {
      throw binasciiError(
        `Invalid base64-encoded string: number of data characters (${Math.floor(this.out.length / 3) * 4 + 1}) cannot be 1 more than a multiple of 4`
      );
    }
    if (this.quadPosition !== 0) throw binasciiError('Incorrect padding');
    return Uint8Array.from(this.out);
  }
}

// Hexadecimal -------------------------------------------------------------------------------------------------------

export function unhexlify(value: PyValue): Uint8Array {
  const data = asciiData(value);
  if (data.length % 2 !== 0) throw binasciiError('Odd-length string');
  const text = latin1Text(data);
  if (!/^[0-9a-fA-F]*$/.test(text)) throw binasciiError('Non-hexadecimal digit found');
  return Uint8Array.from({ length: data.length / 2 }, (_, index) =>
    Number.parseInt(text.slice(index * 2, index * 2 + 2), 16)
  );
}

const hexlify = (name: string): PyValue =>
  builtin(
    name,
    'takes',
    1,
    3,
    (args, kwargs) =>
      newBytes(
        latin1Bytes(
          hexOf(binaryData(args[0]), argument(args, kwargs, 1, 'sep'), argument(args, kwargs, 2, 'bytes_per_sep'))
        )
      ),
    { keywords: ['sep', 'bytes_per_sep'] }
  );

// Checksums ---------------------------------------------------------------------------------------------------------

let crcTable: Uint32Array | undefined;

/** CRC-32 as zlib computes it, continuing from `start`. */
export function crc32(data: Uint8Array, start: number): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    return value;
  });
  let crc = ~start >>> 0;
  for (const byte of data) crc = (crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
  return ~crc >>> 0;
}

function crcHqx(data: Uint8Array, start: number): number {
  let crc = start & 0xff_ff;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80_00 ? ((crc << 1) ^ 0x10_21) & 0xff_ff : (crc << 1) & 0xff_ff;
  }
  return crc;
}

/** An unsigned int argument, which C reduces modulo 2**32 as `unsigned int` does. */
export function uint32Argument(value: PyValue | undefined): number {
  return Number(BigInt.asUintN(32, toIndex(value ?? 0n)));
}

registerModule(
  'binascii',
  () =>
    new Map<string, PyValue>([
      [
        'a2b_base64',
        builtin(
          'a2b_base64',
          'takes',
          1,
          1,
          (args, kwargs) => newBytes(decodeBase64(asciiData(args[0]), isTruthy(kwargs?.get('strict_mode') ?? false))),
          { keywords: ['strict_mode'] }
        ),
      ],
      [
        'b2a_base64',
        builtin(
          'b2a_base64',
          'takes',
          1,
          1,
          (args, kwargs) => newBytes(encodeBase64(binaryData(args[0]), isTruthy(kwargs?.get('newline') ?? true))),
          { keywords: ['newline'] }
        ),
      ],
      ['a2b_hex', builtin('a2b_hex', 'one', 1, 1, ([value]) => newBytes(unhexlify(value)))],
      ['b2a_hex', hexlify('b2a_hex')],
      ['hexlify', hexlify('hexlify')],
      ['unhexlify', builtin('unhexlify', 'one', 1, 1, ([value]) => newBytes(unhexlify(value)))],
      [
        'crc32',
        builtin('crc32', 'expected', 1, 2, ([data, start]) => BigInt(crc32(binaryData(data), uint32Argument(start)))),
      ],
      [
        'crc_hqx',
        builtin('crc_hqx', 'expected', 2, 2, ([data, start]) =>
          BigInt(crcHqx(binaryData(data), uint32Argument(start)))
        ),
      ],
      [
        'a2b_uu',
        builtin('a2b_uu', 'one', 1, 1, ([value]) => {
          const decoded = decodeUu(asciiData(value));
          if (typeof decoded === 'string') throw binasciiError(decoded);
          return newBytes(decoded);
        }),
      ],
      [
        'b2a_uu',
        builtin(
          'b2a_uu',
          'takes',
          1,
          1,
          (args, kwargs) => {
            const data = binaryData(args[0]);
            if (data.length > 45) throw binasciiError('At most 45 bytes at once');
            return newBytes(encodeUu(data, isTruthy(kwargs?.get('backtick') ?? false)));
          },
          { keywords: ['backtick'] }
        ),
      ],
      [
        'a2b_qp',
        builtin(
          'a2b_qp',
          'takes',
          1,
          2,
          (args, kwargs) => {
            const [data, header] = ['data', 'header'].map((name, index) => argument(args, kwargs, index, name));
            return newBytes(decodeQp(asciiData(data as PyValue), isTruthy(header ?? false)));
          },
          { keywords: ['data', 'header'] }
        ),
      ],
      [
        'b2a_qp',
        builtin(
          'b2a_qp',
          'takes',
          1,
          4,
          (args, kwargs) => {
            const [data, quotetabs, istext, header] = ['data', 'quotetabs', 'istext', 'header'].map((name, index) =>
              argument(args, kwargs, index, name)
            );
            return newBytes(
              encodeQp(binaryData(data as PyValue), {
                quotetabs: isTruthy(quotetabs ?? false),
                istext: isTruthy(istext ?? true),
                header: isTruthy(header ?? false),
              })
            );
          },
          { keywords: ['data', 'quotetabs', 'istext', 'header'] }
        ),
      ],
      ['Error', binasciiErrorClass],
      ['Incomplete', incompleteClass],
    ])
);
