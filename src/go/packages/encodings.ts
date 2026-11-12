// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { addMethod, definePackage, fn, namedType, nativeFunction } from '../native';
import { GoPanic } from '../runtime';
import { BASIC, ERROR_TYPE, pointerTo, type Type } from '../types';
import { Cell, GoArray, GoStruct, Iface, Pointer, type Slice, type Value } from '../values';
import { BYTES, byteSlice, bytesOf, INT, STRING } from './support';

const libraryVariable = (name: string, type: Type, value: Value): Entity => ({
  kind: 'var',
  name,
  type,
  span: { row: 0, column: 0 },
  used: true,
  boxed: false,
  owner: undefined,
  slot: -1,
  library: () => value,
});

const byteArray = (bytes: number[]): GoArray => new GoArray(bytes.map(BigInt));
const codes = (bytes: string): number[] => Array.from(bytes, (char) => char.charCodeAt(0));

// encoding/hex --------------------------------------------------------------------------------------------------------

const HEX = '0123456789abcdef';
const hexEncode = (bytes: string): string =>
  Array.from(bytes, (char) => HEX[char.charCodeAt(0) >> 4] + HEX[char.charCodeAt(0) & 15]).join('');

function hexDecode(text: string): [string, Value] {
  let result = '';
  for (let index = 0; index + 1 < text.length; index += 2) {
    const high = HEX.indexOf(text[index].toLowerCase());
    const low = HEX.indexOf(text[index + 1].toLowerCase());
    if (high === -1)
      return [
        result,
        newError(`encoding/hex: invalid byte: U+00${hexEncode(text[index]).toUpperCase()} '${text[index]}'`),
      ];
    if (low === -1)
      return [
        result,
        newError(`encoding/hex: invalid byte: U+00${hexEncode(text[index + 1]).toUpperCase()} '${text[index + 1]}'`),
      ];
    result += String.fromCharCode(high * 16 + low);
  }
  if (text.length % 2 === 1) {
    if (HEX.includes(text.at(-1)?.toLowerCase() ?? ''))
      return [result, newError('encoding/hex: odd length hex string')];
    return [
      result,
      newError(`encoding/hex: invalid byte: U+00${hexEncode(text.at(-1) as string).toUpperCase()} '${text.at(-1)}'`),
    ];
  }
  return [result, undefined];
}

/** hex.Dump: the bytes as hexdump -C prints them, 16 to a line with their printable characters. */
function hexDump(bytes: string): string {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const line = bytes.slice(offset, offset + 16);
    let hex = '';
    for (let index = 0; index < 16; index++) {
      hex += index < line.length ? `${hexEncode(line[index])} ` : '   ';
      if (index === 7) hex += ' ';
    }
    const printable = Array.from(line, (char) => (char >= ' ' && char <= '~' ? char : '.')).join('');
    result += `${offset.toString(16).padStart(8, '0')}  ${hex} |${printable}|\n`;
  }
  return result;
}

export const HEX_PACKAGE = definePackage(
  'encoding/hex',
  {
    EncodeToString: nativeFunction('EncodeToString', fn([BYTES], [STRING]), ([b]) => hexEncode(bytesOf(b))),
    DecodeString: nativeFunction('DecodeString', fn([STRING], [BYTES, ERROR_TYPE]), ([s]) => {
      const [bytes, error] = hexDecode(s as string);
      return [byteSlice(bytes), error];
    }),
    EncodedLen: nativeFunction('EncodedLen', fn([INT], [INT]), ([n]) => (n as bigint) * 2n),
    DecodedLen: nativeFunction('DecodedLen', fn([INT], [INT]), ([n]) => (n as bigint) / 2n),
    Dump: nativeFunction('Dump', fn([BYTES], [STRING]), ([b]) => hexDump(bytesOf(b))),
  },
  [
    'Encode',
    'Decode',
    'Dumper',
    'NewEncoder',
    'NewDecoder',
    'ErrLength',
    'InvalidByteError',
    'AppendEncode',
    'AppendDecode',
  ]
);

// encoding/base64 -----------------------------------------------------------------------------------------------------

const STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

interface Encoding {
  alphabet: string;
  padded: boolean;
}

function base64Encode(bytes: string, { alphabet, padded }: Encoding): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const [a, b, c] = [0, 1, 2].map((offset) => bytes.charCodeAt(index + offset) || 0);
    const chunk = (a << 16) | (b << 8) | c;
    const count = Math.min(3, bytes.length - index);
    const chars = [18, 12, 6, 0].map((shift) => alphabet[(chunk >> shift) & 63]);
    result += chars.slice(0, count + 1).join('');
    if (padded) result += '='.repeat(3 - count);
  }
  return result;
}

/** base64's DecodeString, with Go's CorruptInputError at the first byte that does not fit. */
function base64Decode(text: string, { alphabet, padded }: Encoding): [string, Value] {
  const clean = text.replaceAll(/[\r\n]/g, '');
  let result = '';
  let index = 0;
  const corrupt = (at: number): [string, Value] => [result, newError(`illegal base64 data at input byte ${at}`)];
  while (index < clean.length) {
    const values: number[] = [];
    const start = index;
    while (values.length < 4 && index < clean.length && clean[index] !== '=') {
      const value = alphabet.indexOf(clean[index]);
      if (value === -1) return corrupt(index);
      values.push(value);
      index++;
    }
    if (values.length === 1) return corrupt(start + 1 > clean.length - 1 ? start : start + 1);
    if (values.length < 4) {
      if (padded) {
        // Input that ends without its padding is corrupt from the start of its last quantum, as Go reports.
        if (index >= clean.length) return corrupt(start);
        const padding = 4 - values.length;
        if (clean[index] !== '=') return corrupt(index);
        // The second `=` of "==" is missing: at the end Go reports the input's length, elsewhere the first `=`.
        if (padding === 2 && index + 1 >= clean.length) return corrupt(clean.length);
        if (padding === 2 && clean[index + 1] !== '=') return corrupt(index);
        index += padding;
      }
      if (index < clean.length) return corrupt(index);
    }
    const chunk = values.reduce((total, value, position) => total | (value << (18 - 6 * position)), 0);
    const count = values.length - 1;
    for (let byte = 0; byte < count; byte++) result += String.fromCharCode((chunk >> (16 - 8 * byte)) & 255);
  }
  return [result, undefined];
}

const ENCODING = namedType('base64', 'Encoding', { kind: 'struct', fields: [] });
const encodingOf = (receiver: Value): Encoding =>
  ((receiver as Pointer).load() as GoStruct).native?.encoding as Encoding;
addMethod(
  ENCODING,
  'EncodeToString',
  fn([BYTES], [STRING]),
  (receiver, [b]) => base64Encode(bytesOf(b), encodingOf(receiver)),
  true
);
addMethod(
  ENCODING,
  'DecodeString',
  fn([STRING], [BYTES, ERROR_TYPE]),
  (receiver, [s]) => {
    const [bytes, error] = base64Decode(s as string, encodingOf(receiver));
    return [byteSlice(bytes), error];
  },
  true
);
addMethod(
  ENCODING,
  'EncodedLen',
  fn([INT], [INT]),
  (receiver, [n]) => {
    const count = Number(n as bigint);
    return BigInt(encodingOf(receiver).padded ? Math.ceil(count / 3) * 4 : Math.ceil((count * 8) / 6));
  },
  true
);

const encodingValue = (encoding: Encoding): Pointer => new Pointer(new Cell(new GoStruct([], { encoding })), 'v');
const ENCODING_POINTER = pointerTo(ENCODING);

export const BASE64_PACKAGE = definePackage(
  'encoding/base64',
  {
    StdEncoding: libraryVariable('StdEncoding', ENCODING_POINTER, encodingValue({ alphabet: STANDARD, padded: true })),
    URLEncoding: libraryVariable('URLEncoding', ENCODING_POINTER, encodingValue({ alphabet: URL_SAFE, padded: true })),
    RawStdEncoding: libraryVariable(
      'RawStdEncoding',
      ENCODING_POINTER,
      encodingValue({ alphabet: STANDARD, padded: false })
    ),
    RawURLEncoding: libraryVariable(
      'RawURLEncoding',
      ENCODING_POINTER,
      encodingValue({ alphabet: URL_SAFE, padded: false })
    ),
  },
  ['Encoding', 'NewEncoding', 'NewEncoder', 'NewDecoder', 'CorruptInputError', 'StdPadding', 'NoPadding']
);

// encoding/binary -----------------------------------------------------------------------------------------------------

const UINT16 = BASIC.uint16;
const UINT32 = BASIC.uint32;
const UINT64 = BASIC.uint64;

function readBytes(slice: Value, count: number): bigint[] {
  const values = (slice as Slice | undefined)?.values() ?? [];
  if (values.length < count) {
    throw new GoPanic(
      new Iface(STRING, `runtime error: index out of range [${count - 1}] with length ${values.length}`)
    );
  }
  return values.slice(0, count) as bigint[];
}

function writeBytes(slice: Value, bytes: bigint[]): void {
  const target = slice as Slice | undefined;
  if ((target?.length ?? 0) < bytes.length) {
    throw new GoPanic(
      new Iface(STRING, `runtime error: index out of range [${bytes.length - 1}] with length ${target?.length ?? 0}`)
    );
  }
  for (const [index, byte] of bytes.entries()) (target as Slice).set(index, byte);
}

function byteOrder(name: string, littleEndian: boolean): Value {
  const type = namedType('binary', name, { kind: 'struct', fields: [] });
  for (const [bits, type2] of [
    [16, UINT16],
    [32, UINT32],
    [64, UINT64],
  ] as const) {
    const count = bits / 8;
    addMethod(type, `Uint${bits}`, fn([BYTES], [type2]), (_receiver, [b]) => {
      const bytes = readBytes(b, count);
      const ordered = littleEndian ? bytes.toReversed() : bytes;
      return ordered.reduce((total, byte) => (total << 8n) | byte, 0n);
    });
    addMethod(type, `PutUint${bits}`, fn([BYTES, type2], []), (_receiver, [b, value]) => {
      const bytes = Array.from(
        { length: count },
        (_, index) => ((value as bigint) >> BigInt(8 * (count - 1 - index))) & 255n
      );
      writeBytes(b, littleEndian ? bytes.toReversed() : bytes);
      return;
    });
  }
  addMethod(type, 'String', fn([], [STRING]), () => name);
  return new Iface(type, new GoStruct([]));
}

const BYTE_ORDER = namedType('binary', 'ByteOrder', {
  kind: 'interface',
  methods: [
    { name: 'PutUint16', type: fn([BYTES, UINT16], []) },
    { name: 'PutUint32', type: fn([BYTES, UINT32], []) },
    { name: 'PutUint64', type: fn([BYTES, UINT64], []) },
    { name: 'String', type: fn([], [STRING]) },
    { name: 'Uint16', type: fn([BYTES], [UINT16]) },
    { name: 'Uint32', type: fn([BYTES], [UINT32]) },
    { name: 'Uint64', type: fn([BYTES], [UINT64]) },
  ],
});
const bigEndian = byteOrder('BigEndian', false);
const littleEndian = byteOrder('LittleEndian', true);

export const BINARY_PACKAGE = definePackage(
  'encoding/binary',
  {
    BigEndian: libraryVariable('BigEndian', (bigEndian as Iface).type, (bigEndian as Iface).value),
    LittleEndian: libraryVariable('LittleEndian', (littleEndian as Iface).type, (littleEndian as Iface).value),
    ByteOrder: { kind: 'type', name: 'ByteOrder', type: BYTE_ORDER },
  },
  [
    'Read',
    'Write',
    'Size',
    'PutVarint',
    'PutUvarint',
    'Varint',
    'Uvarint',
    'AppendByteOrder',
    'NativeEndian',
    'MaxVarintLen64',
    'Append',
    'Encode',
    'Decode',
  ]
);

// crypto/md5, crypto/sha256, hash/crc32 -------------------------------------------------------------------------------

function md5(bytes: number[]): number[] {
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const table = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0);
  const message = [...bytes, 0x80];
  while (message.length % 64 !== 56) message.push(0);
  const bitLength = BigInt(bytes.length) * 8n;
  for (let index = 0; index < 8; index++) message.push(Number((bitLength >> BigInt(8 * index)) & 255n));
  let [a0, b0, c0, d0] = [0x67_45_23_01, 0xef_cd_ab_89, 0x98_ba_dc_fe, 0x10_32_54_76];
  for (let chunk = 0; chunk < message.length; chunk += 64) {
    const words = Array.from(
      { length: 16 },
      (_, index) =>
        (message[chunk + index * 4] |
          (message[chunk + index * 4 + 1] << 8) |
          (message[chunk + index * 4 + 2] << 16) |
          (message[chunk + index * 4 + 3] << 24)) >>>
        0
    );
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let index = 0; index < 64; index++) {
      let f: number;
      let g: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      f = (f + a + table[index] + words[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      const shift = shifts[Math.floor(index / 16) * 4 + (index % 4)];
      b = (b + ((f << shift) | (f >>> (32 - shift)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].flatMap((word) => [word & 255, (word >>> 8) & 255, (word >>> 16) & 255, word >>> 24]);
}

const SHA256_K = [
  0x42_8a_2f_98, 0x71_37_44_91, 0xb5_c0_fb_cf, 0xe9_b5_db_a5, 0x39_56_c2_5b, 0x59_f1_11_f1, 0x92_3f_82_a4,
  0xab_1c_5e_d5, 0xd8_07_aa_98, 0x12_83_5b_01, 0x24_31_85_be, 0x55_0c_7d_c3, 0x72_be_5d_74, 0x80_de_b1_fe,
  0x9b_dc_06_a7, 0xc1_9b_f1_74, 0xe4_9b_69_c1, 0xef_be_47_86, 0x0f_c1_9d_c6, 0x24_0c_a1_cc, 0x2d_e9_2c_6f,
  0x4a_74_84_aa, 0x5c_b0_a9_dc, 0x76_f9_88_da, 0x98_3e_51_52, 0xa8_31_c6_6d, 0xb0_03_27_c8, 0xbf_59_7f_c7,
  0xc6_e0_0b_f3, 0xd5_a7_91_47, 0x06_ca_63_51, 0x14_29_29_67, 0x27_b7_0a_85, 0x2e_1b_21_38, 0x4d_2c_6d_fc,
  0x53_38_0d_13, 0x65_0a_73_54, 0x76_6a_0a_bb, 0x81_c2_c9_2e, 0x92_72_2c_85, 0xa2_bf_e8_a1, 0xa8_1a_66_4b,
  0xc2_4b_8b_70, 0xc7_6c_51_a3, 0xd1_92_e8_19, 0xd6_99_06_24, 0xf4_0e_35_85, 0x10_6a_a0_70, 0x19_a4_c1_16,
  0x1e_37_6c_08, 0x27_48_77_4c, 0x34_b0_bc_b5, 0x39_1c_0c_b3, 0x4e_d8_aa_4a, 0x5b_9c_ca_4f, 0x68_2e_6f_f3,
  0x74_8f_82_ee, 0x78_a5_63_6f, 0x84_c8_78_14, 0x8c_c7_02_08, 0x90_be_ff_fa, 0xa4_50_6c_eb, 0xbe_f9_a3_f7,
  0xc6_71_78_f2,
];

const rotate = (value: number, count: number): number => (value >>> count) | (value << (32 - count));

function sha256(bytes: number[]): number[] {
  const message = [...bytes, 0x80];
  while (message.length % 64 !== 56) message.push(0);
  const bitLength = BigInt(bytes.length) * 8n;
  for (let index = 7; index >= 0; index--) message.push(Number((bitLength >> BigInt(8 * index)) & 255n));
  const hash = [
    0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a, 0x51_0e_52_7f, 0x9b_05_68_8c, 0x1f_83_d9_ab,
    0x5b_e0_cd_19,
  ];
  for (let chunk = 0; chunk < message.length; chunk += 64) {
    const w = Array.from<number>({ length: 64 });
    for (let index = 0; index < 16; index++) {
      const at = chunk + index * 4;
      w[index] = ((message[at] << 24) | (message[at + 1] << 16) | (message[at + 2] << 8) | message[at + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index++) {
      const s0 = rotate(w[index - 15], 7) ^ rotate(w[index - 15], 18) ^ (w[index - 15] >>> 3);
      const s1 = rotate(w[index - 2], 17) ^ rotate(w[index - 2], 19) ^ (w[index - 2] >>> 10);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choose + SHA256_K[index] + w[index]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + temp1) >>> 0, c, b, a, (temp1 + temp2) >>> 0];
    }
    for (const [index, value] of [a, b, c, d, e, f, g, h].entries()) hash[index] = (hash[index] + value) >>> 0;
  }
  return hash.flatMap((word) => [word >>> 24, (word >>> 16) & 255, (word >>> 8) & 255, word & 255]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: number[]): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

const arrayOf = (length: number): Type => ({ kind: 'array', element: BASIC.uint8, length });

export const MD5_PACKAGE = definePackage(
  'crypto/md5',
  {
    Sum: nativeFunction('Sum', fn([BYTES], [arrayOf(16)]), ([b]) => byteArray(md5(codes(bytesOf(b))))),
    Size: {
      kind: 'const',
      name: 'Size',
      type: BASIC.untypedInt,
      value: { kind: 'int', value: 16n },
      span: { row: 0, column: 0 },
      used: true,
    },
  },
  ['New', 'BlockSize']
);

export const SHA256_PACKAGE = definePackage(
  'crypto/sha256',
  {
    Sum256: nativeFunction('Sum256', fn([BYTES], [arrayOf(32)]), ([b]) => byteArray(sha256(codes(bytesOf(b))))),
    Size: {
      kind: 'const',
      name: 'Size',
      type: BASIC.untypedInt,
      value: { kind: 'int', value: 32n },
      span: { row: 0, column: 0 },
      used: true,
    },
  },
  ['New', 'New224', 'Sum224', 'BlockSize', 'Size224']
);

export const CRC32_PACKAGE = definePackage(
  'hash/crc32',
  {
    ChecksumIEEE: nativeFunction('ChecksumIEEE', fn([BYTES], [UINT32]), ([b]) => BigInt(crc32(codes(bytesOf(b))))),
  },
  ['New', 'NewIEEE', 'MakeTable', 'Checksum', 'Update', 'IEEETable', 'IEEE', 'Castagnoli', 'Koopman', 'Size', 'Table']
);
