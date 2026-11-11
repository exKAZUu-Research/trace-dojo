// The base64 module, whose functions follow base64.py so that they raise the same errors in the same cases.
import { bytesLikeData, latin1Bytes, newBytes } from '../bytesValues';
import { pyRepr } from '../conversions';
import { builtin } from '../define';
import { registerModule } from '../modules';
import { argument } from '../nativeArgs';
import { isTruthy } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { exceptionClassNamed, newException, None, pyError, typeError, typeName, unbox, valueError } from '../types';
import { type Kwargs, PyError, type PyValue } from '../values';
import { binasciiError, decodeBase64, encodeBase64, unhexlify } from './binascii';

/** `_bytes_from_decode_data`: the bytes of a bytes-like object or an ASCII string. */
function decodeData(argumentValue: PyValue): Uint8Array {
  const value = unbox(argumentValue);
  if (typeof value === 'string') {
    // oxlint-disable-next-line eslint/no-control-regex -- ASCII includes the control characters.
    if (!/^[\u0000-\u007F]*$/.test(value)) throw valueError('string argument should contain only ASCII characters');
    return latin1Bytes(value);
  }
  const data = bytesLikeData(value);
  if (data === undefined) {
    throw typeError(`argument should be a bytes-like object or ASCII string, not '${typeName(value)}'`);
  }
  return data;
}

function encodeData(value: PyValue): Uint8Array {
  const data = bytesLikeData(value);
  if (data === undefined) throw typeError(`a bytes-like object is required, not '${typeName(value)}'`);
  return data;
}

function translate(data: Uint8Array, from: string, to: string): Uint8Array {
  return data.map((byte) => {
    const index = from.indexOf(String.fromCodePoint(byte));
    return index === -1 ? byte : (to.codePointAt(index) as number);
  });
}

/** An `altchars` argument, which base64.py checks with an assert. */
function altChars(value: PyValue, data: Uint8Array): string {
  if (data.length !== 2) throw assertionError(value);
  return String.fromCodePoint(...data);
}

function assertionError(value: PyValue): PyError {
  return new PyError(newException(exceptionClassNamed('AssertionError'), [pyRepr(value)]));
}

// Base64 ------------------------------------------------------------------------------------------------------------

function b64encode(args: PyValue[], kwargs: Kwargs): PyValue {
  const encoded = encodeBase64(encodeData(args[0]), false);
  const alt = argument(args, kwargs, 1, 'altchars') ?? None;
  if (alt === None) return newBytes(encoded);
  const data = bytesLikeData(alt);
  if (data === undefined) throw typeError(`a bytes-like object is required, not '${typeName(alt)}'`);
  return newBytes(translate(encoded, '+/', altChars(alt, data)));
}

function b64decode(args: PyValue[], kwargs: Kwargs): PyValue {
  let data = decodeData(args[0]);
  const alt = argument(args, kwargs, 1, 'altchars') ?? None;
  if (alt !== None) data = translate(data, altChars(alt, decodeData(alt)), '+/');
  return newBytes(decodeBase64(data, isTruthy(argument(args, kwargs, 2, 'validate') ?? false)));
}

// Base32 ------------------------------------------------------------------------------------------------------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_HEX = '0123456789ABCDEFGHIJKLMNOPQRSTUV';

function b32encode(alphabet: string, data: Uint8Array): Uint8Array {
  let text = '';
  for (let index = 0; index < data.length; index += 5) {
    let quantum = 0n;
    for (let offset = 0; offset < 5; offset++) quantum = (quantum << 8n) | BigInt(data[index + offset] ?? 0);
    for (let position = 0; position < 8; position++)
      text += alphabet[Number((quantum >> BigInt(35 - 5 * position)) & 31n)];
  }
  const keep = [8, 2, 4, 5, 7][data.length % 5];
  if (keep !== 8) text = text.slice(0, text.length - 8 + keep) + '='.repeat(8 - keep);
  return latin1Bytes(text);
}

// code-gauge-allow functionNcss 31 -- Transcribes base64._b32decode.
function b32decode(alphabet: string, args: PyValue[], kwargs: Kwargs, withMap01: boolean): Uint8Array {
  let data = decodeData(args[0]);
  if (data.length % 8 !== 0) throw binasciiError('Incorrect padding');
  const map01 = withMap01 ? (argument(args, kwargs, 2, 'map01') ?? None) : None;
  if (map01 !== None) {
    const mapped = decodeData(map01);
    if (mapped.length !== 1) throw assertionError(map01);
    data = translate(data, '01', `O${String.fromCodePoint(mapped[0])}`);
  }
  if (isTruthy(argument(args, kwargs, 1, 'casefold') ?? false))
    data = translate(data, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  const text = String.fromCodePoint(...data);
  const stripped = text.replace(/=+$/, '');
  const padding = text.length - stripped.length;
  const decoded: number[] = [];
  let quantum = 0n;
  for (let index = 0; index < stripped.length; index += 8) {
    quantum = 0n;
    for (const char of stripped.slice(index, index + 8)) {
      const value = alphabet.indexOf(char);
      if (value === -1) throw binasciiError('Non-base32 digit found');
      quantum = (quantum << 5n) + BigInt(value);
    }
    decoded.push(...bigBytes(quantum, 5));
  }
  if (![0, 1, 3, 4, 6].includes(padding)) throw binasciiError('Incorrect padding');
  if (padding > 0 && decoded.length > 0) {
    const last = bigBytes(quantum << BigInt(5 * padding), 5);
    decoded.splice(-5, 5, ...last.slice(0, Math.floor((43 - 5 * padding) / 8)));
  }
  return Uint8Array.from(decoded);
}

/** The low `count` bytes of an integer, big-endian, raising OverflowError as int.to_bytes does. */
function bigBytes(value: bigint, count: number): number[] {
  if (value >= 1n << BigInt(count * 8)) throw pyError('OverflowError', 'int too big to convert');
  return Array.from({ length: count }, (_, index) => Number((value >> BigInt(8 * (count - 1 - index))) & 0xffn));
}

// Base16 ------------------------------------------------------------------------------------------------------------

function b16decode(args: PyValue[], kwargs: Kwargs): PyValue {
  let data = decodeData(args[0]);
  if (isTruthy(argument(args, kwargs, 1, 'casefold') ?? false)) data = translate(data, 'abcdef', 'ABCDEF');
  if (!/^[0-9A-F]*$/.test(String.fromCodePoint(...data))) throw binasciiError('Non-base16 digit found');
  return newBytes(unhexlify(newBytes(data)));
}

// Base85 and Ascii85 ------------------------------------------------------------------------------------------------

const BASE85 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
const Z85 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';
const ASCII85 = Array.from({ length: 85 }, (_, index) => String.fromCodePoint(33 + index)).join('');

/** `_85encode`: each 4-byte word as 5 digits, folding zero words to `z` and space words to `y` when asked. */
function encode85(
  data: Uint8Array,
  alphabet: string,
  options: { pad: boolean; foldNuls?: boolean; foldSpaces?: boolean }
): string {
  const padding = (4 - (data.length % 4)) % 4;
  const chunks: string[] = [];
  for (let index = 0; index < data.length + padding; index += 4) {
    const word =
      (((data[index] ?? 0) << 24) |
        ((data[index + 1] ?? 0) << 16) |
        ((data[index + 2] ?? 0) << 8) |
        (data[index + 3] ?? 0)) >>>
      0;
    if (options.foldNuls && word === 0) chunks.push('z');
    else if (options.foldSpaces && word === 0x20_20_20_20) chunks.push('y');
    else {
      let text = '';
      for (let divisor = 85 ** 4; divisor >= 1; divisor /= 85) text += alphabet[Math.floor(word / divisor) % 85];
      chunks.push(text);
    }
  }
  if (padding && !options.pad) {
    if (chunks.at(-1) === 'z') chunks[chunks.length - 1] = alphabet[0].repeat(5);
    chunks[chunks.length - 1] = (chunks.at(-1) as string).slice(0, -padding);
  }
  currentRuntime().buildString(chunks.length * 5);
  return chunks.join('');
}

function a85encode(args: PyValue[], kwargs: Kwargs): PyValue {
  const flag = (name: string): boolean => isTruthy(kwargs?.get(name) ?? false);
  const adobe = flag('adobe');
  let result = encode85(encodeData(args[0]), ASCII85, {
    pad: flag('pad'),
    foldNuls: true,
    foldSpaces: flag('foldspaces'),
  });
  if (adobe) result = `<~${result}`;
  let wrap = Number(kwargs?.get('wrapcol') ?? 0n);
  if (wrap) {
    wrap = Math.max(adobe ? 2 : 1, wrap);
    const chunks: string[] = [];
    for (let index = 0; index < result.length; index += wrap) chunks.push(result.slice(index, index + wrap));
    if (adobe && (chunks.at(-1) as string).length + 2 > wrap) chunks.push('');
    result = chunks.join('\n');
  }
  if (adobe) result += '~>';
  return newBytes(latin1Bytes(result));
}

// code-gauge-allow functionCognitiveComplexity 29 -- Transcribes base64.a85decode.
function a85decode(args: PyValue[], kwargs: Kwargs): PyValue {
  let text = String.fromCodePoint(...decodeData(args[0]));
  const ignore = kwargs?.has('ignorechars')
    ? String.fromCodePoint(...decodeData(kwargs.get('ignorechars') as PyValue))
    : ' \t\n\r\v';
  if (isTruthy(kwargs?.get('adobe') ?? false)) {
    if (!text.endsWith('~>')) throw valueError("Ascii85 encoded byte sequences must end with b'~>'");
    text = text.startsWith('<~') ? text.slice(2, -2) : text.slice(0, -2);
  }
  const foldSpaces = isTruthy(kwargs?.get('foldspaces') ?? false);
  const decoded: number[] = [];
  let current: number[] = [];
  for (const char of `${text}uuuu`) {
    const code = char.codePointAt(0) as number;
    if (code >= 33 && code <= 117) {
      current.push(code - 33);
      if (current.length === 5) {
        const word = current.reduce((acc, digit) => acc * 85 + digit, 0);
        if (word > 0xff_ff_ff_ff) throw valueError('Ascii85 overflow');
        decoded.push(word >>> 24, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
        current = [];
      }
    } else if (char === 'z' || (foldSpaces && char === 'y')) {
      if (current.length > 0) throw valueError(`${char} inside Ascii85 5-tuple`);
      decoded.push(...Array.from({ length: 4 }, () => (char === 'z' ? 0 : 0x20)));
    } else if (!ignore.includes(char)) {
      throw valueError(`Non-Ascii85 digit found: ${char}`);
    }
  }
  const padding = 4 - current.length;
  return newBytes(Uint8Array.from(padding ? decoded.slice(0, -padding) : decoded));
}

function decode85(data: Uint8Array, alphabet: string, name: string): Uint8Array {
  const padding = (5 - (data.length % 5)) % 5;
  const digits = [...data, ...Array.from({ length: padding }, () => 0x7e)];
  const result: number[] = [];
  for (let index = 0; index < digits.length; index += 5) {
    let word = 0;
    for (let offset = 0; offset < 5; offset++) {
      const value = alphabet.indexOf(String.fromCodePoint(digits[index + offset]));
      if (value === -1) throw valueError(`bad ${name} character at position ${index + offset}`);
      word = word * 85 + value;
    }
    if (word > 0xff_ff_ff_ff) throw valueError(`${name} overflow in hunk starting at byte ${index}`);
    result.push(word >>> 24, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
  }
  return Uint8Array.from(padding ? result.slice(0, -padding) : result);
}

/** z85 decoding, which translates to base85 first and so treats base85's extra characters as bad ones. */
function z85decode(value: PyValue): Uint8Array {
  const data = decodeData(value).map((byte) => {
    const index = Z85.indexOf(String.fromCodePoint(byte));
    if (index !== -1) return BASE85.codePointAt(index) as number;
    return ';_`|~'.includes(String.fromCodePoint(byte)) ? 0 : byte;
  });
  return decode85(data, BASE85, 'z85');
}

// Line-wrapped base64 -----------------------------------------------------------------------------------------------

function inputTypeCheck(value: PyValue): Uint8Array {
  const data = bytesLikeData(value);
  if (data === undefined) throw typeError(`expected bytes-like object, not ${typeName(value)}`);
  return data;
}

function encodeBytes([value]: PyValue[]): PyValue {
  const data = inputTypeCheck(value);
  const pieces: number[] = [];
  for (let index = 0; index < data.length; index += 57)
    pieces.push(...encodeBase64(data.subarray(index, index + 57), true));
  return newBytes(Uint8Array.from(pieces));
}

registerModule(
  'base64',
  () =>
    new Map<string, PyValue>([
      ['b64encode', builtin('b64encode', 'takes', 1, 2, b64encode, { keywords: ['s', 'altchars'] })],
      ['b64decode', builtin('b64decode', 'takes', 1, 3, b64decode, { keywords: ['s', 'altchars', 'validate'] })],
      ['standard_b64encode', builtin('standard_b64encode', 'takes', 1, 1, b64encode, { keywords: ['s'] })],
      ['standard_b64decode', builtin('standard_b64decode', 'takes', 1, 1, b64decode, { keywords: ['s'] })],
      [
        'urlsafe_b64encode',
        builtin('urlsafe_b64encode', 'one', 1, 1, ([value]) =>
          newBytes(translate(encodeBase64(encodeData(value), false), '+/', '-_'))
        ),
      ],
      [
        'urlsafe_b64decode',
        builtin('urlsafe_b64decode', 'one', 1, 1, ([value]) =>
          newBytes(decodeBase64(translate(decodeData(value), '-_', '+/'), false))
        ),
      ],
      ['b32encode', builtin('b32encode', 'one', 1, 1, ([value]) => newBytes(b32encode(BASE32, encodeData(value))))],
      [
        'b32decode',
        builtin('b32decode', 'takes', 1, 3, (args, kwargs) => newBytes(b32decode(BASE32, args, kwargs, true)), {
          keywords: ['s', 'casefold', 'map01'],
        }),
      ],
      [
        'b32hexencode',
        builtin('b32hexencode', 'one', 1, 1, ([value]) => newBytes(b32encode(BASE32_HEX, encodeData(value)))),
      ],
      [
        'b32hexdecode',
        builtin('b32hexdecode', 'takes', 1, 2, (args, kwargs) => newBytes(b32decode(BASE32_HEX, args, kwargs, false)), {
          keywords: ['s', 'casefold'],
        }),
      ],
      [
        'b16encode',
        builtin('b16encode', 'one', 1, 1, ([value]) =>
          newBytes(
            latin1Bytes([...encodeData(value)].map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(''))
          )
        ),
      ],
      ['b16decode', builtin('b16decode', 'takes', 1, 2, b16decode, { keywords: ['s', 'casefold'] })],
      [
        'b85encode',
        builtin(
          'b85encode',
          'takes',
          1,
          2,
          (args, kwargs) =>
            newBytes(
              latin1Bytes(
                encode85(encodeData(args[0]), BASE85, { pad: isTruthy(argument(args, kwargs, 1, 'pad') ?? false) })
              )
            ),
          { keywords: ['b', 'pad'] }
        ),
      ],
      [
        'b85decode',
        builtin('b85decode', 'one', 1, 1, ([value]) => newBytes(decode85(decodeData(value), BASE85, 'base85'))),
      ],
      [
        'a85encode',
        builtin('a85encode', 'takes', 1, 1, a85encode, { keywords: ['b', 'foldspaces', 'wrapcol', 'pad', 'adobe'] }),
      ],
      [
        'a85decode',
        builtin('a85decode', 'takes', 1, 1, a85decode, { keywords: ['b', 'foldspaces', 'adobe', 'ignorechars'] }),
      ],
      [
        'z85encode',
        builtin(
          'z85encode',
          'takes',
          1,
          2,
          (args, kwargs) =>
            newBytes(
              latin1Bytes(
                encode85(encodeData(args[0]), Z85, { pad: isTruthy(argument(args, kwargs, 1, 'pad') ?? false) })
              )
            ),
          { keywords: ['s', 'pad'] }
        ),
      ],
      ['z85decode', builtin('z85decode', 'one', 1, 1, ([value]) => newBytes(z85decode(value)))],
      ['encodebytes', builtin('encodebytes', 'one', 1, 1, encodeBytes)],
      [
        'decodebytes',
        builtin('decodebytes', 'one', 1, 1, ([value]) => newBytes(decodeBase64(inputTypeCheck(value), false))),
      ],
    ]),
  { encode: 'base64.encode（ファイルの読み書き）', decode: 'base64.decode（ファイルの読み書き）' }
);
