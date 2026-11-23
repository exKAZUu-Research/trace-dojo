// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { hmac } from '@noble/hashes/hmac.js';
import { md5, ripemd160, sha1 } from '@noble/hashes/legacy.js';
import { sha224, sha256, sha384, sha512, sha512_224, sha512_256 } from '@noble/hashes/sha2.js';
import { sha3_224, sha3_256, sha3_384, sha3_512 } from '@noble/hashes/sha3.js';

import { bytesToString, lower, stringToBytes } from './bytes';
import { throwError } from './errors';
import { defineFunction } from './native';
import { UnsupportedFeatureError } from './unsupported';
import type { Value } from './values';

const s = (value: Value): string => value as string;

defineFunction('md5(string $string, bool $binary = false): string', ({ args }) =>
  hash(md5, s(args[0]), args[1] === true)
);
defineFunction('sha1(string $string, bool $binary = false): string', ({ args }) =>
  hash(sha1, s(args[0]), args[1] === true)
);
defineFunction('crc32(string $string): int', ({ args }) => BigInt(crc32(s(args[0]))));
/** The algorithms of PHP's `hash_algos()`, whose cryptographic ones come before `adler32`. */
const PHP_HASHES =
  'md2 md4 md5 sha1 sha224 sha256 sha384 sha512/224 sha512/256 sha512 sha3-224 sha3-256 sha3-384 sha3-512 ripemd128 ripemd160 ripemd256 ripemd320 whirlpool tiger128,3 tiger160,3 tiger192,3 tiger128,4 tiger160,4 tiger192,4 snefru snefru256 gost gost-crypto haval128,3 haval160,3 haval192,3 haval224,3 haval256,3 haval128,4 haval160,4 haval192,4 haval224,4 haval256,4 haval128,5 haval160,5 haval192,5 haval224,5 haval256,5 adler32 crc32 crc32b crc32c fnv132 fnv1a32 fnv164 fnv1a64 joaat murmur3a murmur3c murmur3f xxh32 xxh64 xxh3 xxh128'.split(
    ' '
  );

defineFunction('hash(string $algo, string $data, bool $binary = false, array $options = []): string', ({ args }) => {
  const algorithm = lower(s(args[0]));
  if (algorithm === 'crc32b') {
    const digest = crc32(s(args[1])).toString(16).padStart(8, '0');
    return args[2] === true
      ? digest.replaceAll(/../g, (byte) => String.fromCharCode(Number.parseInt(byte, 16)))
      : digest;
  }
  if (!PHP_HASHES.includes(algorithm))
    throwError('ValueError', 'hash(): Argument #1 ($algo) must be a valid hashing algorithm');
  return hash(hashFunction(algorithm, 'hash'), s(args[1]), args[2] === true);
});
defineFunction('hash_hmac(string $algo, string $data, string $key, bool $binary = false): string', ({ args }) => {
  const algorithm = lower(s(args[0]));
  if (!PHP_HASHES.slice(0, PHP_HASHES.indexOf('adler32')).includes(algorithm)) {
    throwError('ValueError', 'hash_hmac(): Argument #1 ($algo) must be a valid cryptographic hashing algorithm');
  }
  const digest = hmac(hashFunction(algorithm, 'hash_hmac'), stringToBytes(s(args[2])), stringToBytes(s(args[1])));
  return digestText(digest, args[3] === true);
});

const HASH_FUNCTIONS = new Map<string, typeof sha1>([
  ['md5', md5],
  ['sha1', sha1],
  ['sha224', sha224],
  ['sha256', sha256],
  ['sha384', sha384],
  ['sha512/224', sha512_224],
  ['sha512/256', sha512_256],
  ['sha512', sha512],
  ['sha3-224', sha3_224],
  ['sha3-256', sha3_256],
  ['sha3-384', sha3_384],
  ['sha3-512', sha3_512],
  ['ripemd160', ripemd160],
]);

/** The implementation of an algorithm of PHP's, which stops the program when this grader lacks it. */
function hashFunction(algorithm: string, functionName: string): typeof sha1 {
  const implementation = HASH_FUNCTIONS.get(algorithm);
  if (!implementation) throw new UnsupportedFeatureError(`ハッシュアルゴリズム ${algorithm}（${functionName}）`);
  return implementation;
}

function hash(algorithm: typeof sha1, data: string, binary: boolean): string {
  return digestText(algorithm(stringToBytes(data)), binary);
}

function digestText(digest: Uint8Array, binary: boolean): string {
  return binary ? bytesToString(digest) : Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function crc32(data: string): number {
  let crc = 0xff_ff_ff_ff;
  for (let index = 0; index < data.length; index++) {
    crc ^= data.charCodeAt(index);
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xed_b8_83_20 : crc >>> 1;
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}
