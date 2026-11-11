// The message digests of hashlib, computed over a whole message at once.

const MASK64 = (1n << 64n) - 1n;

const rotl32 = (value: number, count: number): number => ((value << count) | (value >>> (32 - count))) >>> 0;
const rotr32 = (value: number, count: number): number => ((value >>> count) | (value << (32 - count))) >>> 0;
const rotr64 = (value: bigint, count: bigint): bigint => ((value >> count) | (value << (64n - count))) & MASK64;

/** Pads a message as MD5 and the SHA-1 and SHA-2 families do, with its bit length in `lengthBytes` bytes. */
function mdPad(data: Uint8Array, blockSize: number, lengthBytes: number, littleEndian: boolean): Uint8Array {
  const total = Math.ceil((data.length + 1 + lengthBytes) / blockSize) * blockSize;
  const padded = new Uint8Array(total);
  padded.set(data);
  padded[data.length] = 0x80;
  let bits = BigInt(data.length) * 8n;
  for (let index = 0; index < lengthBytes; index++) {
    padded[littleEndian ? total - lengthBytes + index : total - 1 - index] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  return padded;
}

function words32(block: Uint8Array, offset: number, count: number, littleEndian: boolean): number[] {
  const view = new DataView(block.buffer, block.byteOffset + offset, count * 4);
  return Array.from({ length: count }, (_, index) => view.getUint32(index * 4, littleEndian));
}

function bytesOf32(words: readonly number[], littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(words.length * 4);
  const view = new DataView(out.buffer);
  for (const [index, word] of words.entries()) view.setUint32(index * 4, word, littleEndian);
  return out;
}

function bytesOf64(words: readonly bigint[], littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(words.length * 8);
  const view = new DataView(out.buffer);
  for (const [index, word] of words.entries()) view.setBigUint64(index * 8, word, littleEndian);
  return out;
}

// MD5 ---------------------------------------------------------------------------------------------------------------

const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_CONSTANTS = Array.from(
  { length: 64 },
  (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0
);

export function md5(data: Uint8Array): Uint8Array {
  const state = [0x67_45_23_01, 0xef_cd_ab_89, 0x98_ba_dc_fe, 0x10_32_54_76];
  const padded = mdPad(data, 64, 8, true);
  for (let offset = 0; offset < padded.length; offset += 64) {
    const m = words32(padded, offset, 16, true);
    let [a, b, c, d] = state;
    for (let index = 0; index < 64; index++) {
      const round = index >> 4;
      const f = [(b & c) | (~b & d), (d & b) | (~d & c), b ^ c ^ d, c ^ (b | ~d)][round];
      const g = [index, (5 * index + 1) % 16, (3 * index + 5) % 16, (7 * index) % 16][round];
      const next = (b + rotl32((a + f + MD5_CONSTANTS[index] + m[g]) >>> 0, MD5_SHIFTS[round * 4 + (index % 4)])) >>> 0;
      [a, b, c, d] = [d, next, b, c];
    }
    for (const [index, value] of [a, b, c, d].entries()) state[index] = (state[index] + value) >>> 0;
  }
  return bytesOf32(state, true);
}

// SHA-1 -------------------------------------------------------------------------------------------------------------

export function sha1(data: Uint8Array): Uint8Array {
  const state = [0x67_45_23_01, 0xef_cd_ab_89, 0x98_ba_dc_fe, 0x10_32_54_76, 0xc3_d2_e1_f0];
  const padded = mdPad(data, 64, 8, false);
  for (let offset = 0; offset < padded.length; offset += 64) {
    const w = words32(padded, offset, 16, false);
    for (let index = 16; index < 80; index++)
      w.push(rotl32(w[index - 3] ^ w[index - 8] ^ w[index - 14] ^ w[index - 16], 1));
    let [a, b, c, d, e] = state;
    for (let index = 0; index < 80; index++) {
      const round = Math.floor(index / 20);
      const f = [(b & c) | (~b & d), b ^ c ^ d, (b & c) | (b & d) | (c & d), b ^ c ^ d][round];
      const k = [0x5a_82_79_99, 0x6e_d9_eb_a1, 0x8f_1b_bc_dc, 0xca_62_c1_d6][round];
      const next = (rotl32(a, 5) + f + e + k + w[index]) >>> 0;
      [a, b, c, d, e] = [next, a, rotl32(b, 30), c, d];
    }
    for (const [index, value] of [a, b, c, d, e].entries()) state[index] = (state[index] + value) >>> 0;
  }
  return bytesOf32(state, false);
}

// SHA-2 -------------------------------------------------------------------------------------------------------------

/** The SHA-2 constants, which BLAKE2 also starts from. */
interface Sha2Constants {
  k512: readonly bigint[];
  iv512: readonly bigint[];
  iv384: readonly bigint[];
  k256: readonly number[];
  iv256: readonly number[];
  iv224: readonly number[];
}

let sha2Constants: Sha2Constants | undefined;

/** The SHA-2 constants, computed when a program first uses an algorithm that needs them. */
export function sha2(): Sha2Constants {
  sha2Constants ??= computeSha2Constants();
  return sha2Constants;
}

function computeSha2Constants(): Sha2Constants {
  const primes = [2];
  for (let candidate = 3; primes.length < 80; candidate += 2)
    if (primes.every((prime) => candidate % prime !== 0)) primes.push(candidate);
  const k512 = primes.map((prime) => fractionBits(prime, 3n));
  const iv512 = primes.slice(0, 8).map((prime) => fractionBits(prime, 2n));
  const iv384 = primes.slice(8, 16).map((prime) => fractionBits(prime, 2n));
  return {
    k512,
    iv512,
    iv384,
    k256: k512.slice(0, 64).map((value) => Number(value >> 32n)),
    iv256: iv512.map((value) => Number(value >> 32n)),
    iv224: iv384.map((value) => Number(value & 0xff_ff_ff_ffn)),
  };
}

/** The first 64 bits of the fractional part of a prime's square or cube root, from which SHA-2 takes its constants. */
function fractionBits(prime: number, root: bigint): bigint {
  return integerRoot(BigInt(prime) << (64n * root), root) & MASK64;
}

/** The integer `root`th root of a bigint, by Newton's method. */
function integerRoot(value: bigint, root: bigint): bigint {
  let guess = 1n << BigInt(Math.ceil(value.toString(2).length / Number(root)) + 1);
  for (;;) {
    const next = ((root - 1n) * guess + value / guess ** (root - 1n)) / root;
    if (next >= guess) return guess;
    guess = next;
  }
}

export function sha256(data: Uint8Array, is224 = false): Uint8Array {
  const { k256, iv224, iv256 } = sha2();
  const state = [...(is224 ? iv224 : iv256)];
  const padded = mdPad(data, 64, 8, false);
  for (let offset = 0; offset < padded.length; offset += 64) {
    const w = words32(padded, offset, 16, false);
    for (let index = 16; index < 64; index++) {
      const s0 = rotr32(w[index - 15], 7) ^ rotr32(w[index - 15], 18) ^ (w[index - 15] >>> 3);
      const s1 = rotr32(w[index - 2], 17) ^ rotr32(w[index - 2], 19) ^ (w[index - 2] >>> 10);
      w.push((w[index - 16] + s0 + w[index - 7] + s1) >>> 0);
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const t1 =
        (h + (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) + ((e & f) ^ (~e & g)) + k256[index] + w[index]) >>> 0;
      const t2 = ((rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [a, b, c, d, e, f, g, h] = [(t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g];
    }
    for (const [index, value] of [a, b, c, d, e, f, g, h].entries()) state[index] = (state[index] + value) >>> 0;
  }
  return bytesOf32(state, false).subarray(0, is224 ? 28 : 32);
}

function sha512Core(data: Uint8Array, iv: readonly bigint[]): Uint8Array {
  const { k512 } = sha2();
  const state = [...iv];
  const padded = mdPad(data, 128, 16, false);
  const view = new DataView(padded.buffer);
  for (let offset = 0; offset < padded.length; offset += 128) {
    const w = Array.from({ length: 16 }, (_, index) => view.getBigUint64(offset + index * 8, false));
    for (let index = 16; index < 80; index++) {
      const s0 = rotr64(w[index - 15], 1n) ^ rotr64(w[index - 15], 8n) ^ (w[index - 15] >> 7n);
      const s1 = rotr64(w[index - 2], 19n) ^ rotr64(w[index - 2], 61n) ^ (w[index - 2] >> 6n);
      w.push((w[index - 16] + s0 + w[index - 7] + s1) & MASK64);
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 80; index++) {
      const s1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const t1 = (h + s1 + ((e & f) ^ (~e & MASK64 & g)) + k512[index] + w[index]) & MASK64;
      const t2 = ((rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n)) + ((a & b) ^ (a & c) ^ (b & c))) & MASK64;
      [a, b, c, d, e, f, g, h] = [(t1 + t2) & MASK64, a, b, c, (d + t1) & MASK64, e, f, g];
    }
    for (const [index, value] of [a, b, c, d, e, f, g, h].entries()) state[index] = (state[index] + value) & MASK64;
  }
  return bytesOf64(state, false);
}

const truncatedIvs = new Map<number, bigint[]>();

/** SHA-512, SHA-384, or SHA-512/t, whose initial values SHA-512 derives from the name of the variant. */
export function sha512(data: Uint8Array, bits: 224 | 256 | 384 | 512 = 512): Uint8Array {
  const { iv512, iv384 } = sha2();
  if (bits === 512) return sha512Core(data, iv512);
  if (bits === 384) return sha512Core(data, iv384).subarray(0, 48);
  let iv = truncatedIvs.get(bits);
  if (!iv) {
    const name = Uint8Array.from(`SHA-512/${bits}`, (char) => char.codePointAt(0) as number);
    const digest = sha512Core(
      name,
      iv512.map((value) => value ^ 0xa5_a5_a5_a5_a5_a5_a5_a5n)
    );
    const view = new DataView(digest.buffer);
    iv = Array.from({ length: 8 }, (_, index) => view.getBigUint64(index * 8, false));
    truncatedIvs.set(bits, iv);
  }
  return sha512Core(data, iv).subarray(0, bits / 8);
}

// SHA-3 -------------------------------------------------------------------------------------------------------------

const KECCAK_ROUND_CONSTANTS: bigint[] = [];
const KECCAK_ROTATIONS: number[] = Array.from({ length: 25 }, () => 0);
const KECCAK_PERMUTATION: number[] = Array.from({ length: 25 }, () => 0);
{
  let lfsr = 1;
  for (let round = 0; round < 24; round++) {
    let constant = 0n;
    for (let bit = 0; bit < 7; bit++) {
      if (lfsr & 1) constant |= 1n << ((1n << BigInt(bit)) - 1n);
      lfsr = ((lfsr << 1) ^ (lfsr & 0x80 ? 0x71 : 0)) & 0xff;
    }
    KECCAK_ROUND_CONSTANTS.push(constant);
  }
  let [x, y] = [1, 0];
  for (let step = 0; step < 24; step++) {
    KECCAK_ROTATIONS[x + 5 * y] = (((step + 1) * (step + 2)) / 2) % 64;
    [x, y] = [y, (2 * x + 3 * y) % 5];
  }
  for (let index = 0; index < 25; index++) {
    const [px, py] = [index % 5, Math.floor(index / 5)];
    KECCAK_PERMUTATION[index] = py + 5 * ((2 * px + 3 * py) % 5);
  }
}

const rotl64 = (value: bigint, count: number): bigint =>
  count === 0 ? value : ((value << BigInt(count)) | (value >> BigInt(64 - count))) & MASK64;

function keccakPermute(lanes: bigint[]): void {
  for (const constant of KECCAK_ROUND_CONSTANTS) {
    const c = Array.from(
      { length: 5 },
      (_, x) => lanes[x] ^ lanes[x + 5] ^ lanes[x + 10] ^ lanes[x + 15] ^ lanes[x + 20]
    );
    for (let index = 0; index < 25; index++) lanes[index] ^= c[(index + 4) % 5] ^ rotl64(c[(index + 1) % 5], 1);
    const b: bigint[] = Array.from({ length: 25 }, () => 0n);
    for (let index = 0; index < 25; index++)
      b[KECCAK_PERMUTATION[index]] = rotl64(lanes[index], KECCAK_ROTATIONS[index]);
    for (let index = 0; index < 25; index++) {
      const x = index % 5;
      const row = index - x;
      lanes[index] = b[index] ^ (~b[row + ((x + 1) % 5)] & MASK64 & b[row + ((x + 2) % 5)]);
    }
    lanes[0] ^= constant;
  }
}

/** A Keccak sponge with `rate` bytes per block and the domain `suffix` byte: SHA-3 uses 0x06 and SHAKE 0x1f. */
export function keccak(data: Uint8Array, rate: number, suffix: number, length: number): Uint8Array {
  const lanes: bigint[] = Array.from({ length: 25 }, () => 0n);
  const padded = new Uint8Array(Math.floor(data.length / rate + 1) * rate);
  padded.set(data);
  padded[data.length] ^= suffix;
  padded[padded.length - 1] ^= 0x80;
  const view = new DataView(padded.buffer);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let index = 0; index < rate / 8; index++) lanes[index] ^= view.getBigUint64(offset + index * 8, true);
    keccakPermute(lanes);
  }
  const out = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += rate) {
    out.set(bytesOf64(lanes.slice(0, rate / 8), true).subarray(0, Math.min(rate, length - offset)), offset);
    if (offset + rate < length) keccakPermute(lanes);
  }
  return out;
}

// BLAKE2 ------------------------------------------------------------------------------------------------------------

const BLAKE2_SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

export interface Blake2Parameters {
  digestSize: number;
  key: Uint8Array;
  salt: Uint8Array;
  person: Uint8Array;
  fanout: number;
  depth: number;
  leafSize: number;
  nodeOffset: bigint;
  nodeDepth: number;
  innerSize: number;
  lastNode: boolean;
}

/** The parameter block of BLAKE2b (`wide`) or BLAKE2s, which the initial state is XORed with. */
function blake2ParameterBlock(parameters: Blake2Parameters, wide: boolean): Uint8Array {
  const block = new Uint8Array(wide ? 64 : 32);
  const view = new DataView(block.buffer);
  block.set([parameters.digestSize, parameters.key.length, parameters.fanout, parameters.depth]);
  view.setUint32(4, parameters.leafSize, true);
  if (wide) view.setBigUint64(8, parameters.nodeOffset, true);
  else {
    view.setUint32(8, Number(parameters.nodeOffset & 0xff_ff_ff_ffn), true);
    view.setUint16(12, Number(parameters.nodeOffset >> 32n), true);
  }
  block[wide ? 16 : 14] = parameters.nodeDepth;
  block[wide ? 17 : 15] = parameters.innerSize;
  block.set(parameters.salt, wide ? 32 : 16);
  block.set(parameters.person, wide ? 48 : 24);
  return block;
}

// code-gauge-allow functionNcss 34 -- Transcribes the BLAKE2b compression of RFC 7693.
export function blake2b(data: Uint8Array, parameters: Blake2Parameters): Uint8Array {
  const { iv512 } = sha2();
  const parameterView = new DataView(blake2ParameterBlock(parameters, true).buffer);
  const state = iv512.map((value, index) => value ^ parameterView.getBigUint64(index * 8, true));
  const message = keyedMessage(data, parameters.key, 128);
  const blocks = Math.max(1, Math.ceil(message.length / 128));
  for (let block = 0; block < blocks; block++) {
    const chunk = new Uint8Array(128);
    chunk.set(message.subarray(block * 128, block * 128 + 128));
    const view = new DataView(chunk.buffer);
    const m = Array.from({ length: 16 }, (_, index) => view.getBigUint64(index * 8, true));
    const last = block === blocks - 1;
    const counter = BigInt(last ? message.length : (block + 1) * 128);
    const v = [...state, ...iv512];
    v[12] ^= counter & MASK64;
    v[13] ^= counter >> 64n;
    if (last) v[14] ^= MASK64;
    if (last && parameters.lastNode) v[15] ^= MASK64;
    const mix = (a: number, b: number, c: number, d: number, x: bigint, y: bigint): void => {
      v[a] = (v[a] + v[b] + x) & MASK64;
      v[d] = rotr64(v[d] ^ v[a], 32n);
      v[c] = (v[c] + v[d]) & MASK64;
      v[b] = rotr64(v[b] ^ v[c], 24n);
      v[a] = (v[a] + v[b] + y) & MASK64;
      v[d] = rotr64(v[d] ^ v[a], 16n);
      v[c] = (v[c] + v[d]) & MASK64;
      v[b] = rotr64(v[b] ^ v[c], 63n);
    };
    for (let round = 0; round < 12; round++) blake2Round((a, b, c, d, i, j) => mix(a, b, c, d, m[i], m[j]), round);
    for (let index = 0; index < 8; index++) state[index] ^= v[index] ^ v[index + 8];
  }
  return bytesOf64(state, true).subarray(0, parameters.digestSize);
}

// code-gauge-allow functionNcss 33 -- Transcribes the BLAKE2s compression of RFC 7693.
export function blake2s(data: Uint8Array, parameters: Blake2Parameters): Uint8Array {
  const { iv256 } = sha2();
  const parameterWords = words32(blake2ParameterBlock(parameters, false), 0, 8, true);
  const state = iv256.map((value, index) => (value ^ parameterWords[index]) >>> 0);
  const message = keyedMessage(data, parameters.key, 64);
  const blocks = Math.max(1, Math.ceil(message.length / 64));
  for (let block = 0; block < blocks; block++) {
    const chunk = new Uint8Array(64);
    chunk.set(message.subarray(block * 64, block * 64 + 64));
    const m = words32(chunk, 0, 16, true);
    const last = block === blocks - 1;
    const counter = last ? message.length : (block + 1) * 64;
    const v = [...state, ...iv256];
    v[12] = (v[12] ^ counter) >>> 0;
    v[13] = (v[13] ^ Math.floor(counter / 2 ** 32)) >>> 0;
    if (last) v[14] = ~v[14] >>> 0;
    if (last && parameters.lastNode) v[15] = ~v[15] >>> 0;
    const mix = (a: number, b: number, c: number, d: number, x: number, y: number): void => {
      v[a] = (v[a] + v[b] + x) >>> 0;
      v[d] = rotr32(v[d] ^ v[a], 16);
      v[c] = (v[c] + v[d]) >>> 0;
      v[b] = rotr32(v[b] ^ v[c], 12);
      v[a] = (v[a] + v[b] + y) >>> 0;
      v[d] = rotr32(v[d] ^ v[a], 8);
      v[c] = (v[c] + v[d]) >>> 0;
      v[b] = rotr32(v[b] ^ v[c], 7);
    };
    for (let round = 0; round < 10; round++) blake2Round((a, b, c, d, i, j) => mix(a, b, c, d, m[i], m[j]), round);
    for (let index = 0; index < 8; index++) state[index] = (state[index] ^ v[index] ^ v[index + 8]) >>> 0;
  }
  return bytesOf32(state, true).subarray(0, parameters.digestSize);
}

/** The message BLAKE2 compresses: a key, if any, padded to a whole block, then the data. */
function keyedMessage(data: Uint8Array, key: Uint8Array, blockSize: number): Uint8Array {
  if (key.length === 0) return data;
  const message = new Uint8Array(blockSize + data.length);
  message.set(key);
  message.set(data, blockSize);
  return message;
}

function blake2Round(
  mix: (a: number, b: number, c: number, d: number, i: number, j: number) => void,
  round: number
): void {
  const s = BLAKE2_SIGMA[round % 10];
  mix(0, 4, 8, 12, s[0], s[1]);
  mix(1, 5, 9, 13, s[2], s[3]);
  mix(2, 6, 10, 14, s[4], s[5]);
  mix(3, 7, 11, 15, s[6], s[7]);
  mix(0, 5, 10, 15, s[8], s[9]);
  mix(1, 6, 11, 12, s[10], s[11]);
  mix(2, 7, 8, 13, s[12], s[13]);
  mix(3, 4, 9, 14, s[14], s[15]);
}

// RIPEMD-160 --------------------------------------------------------------------------------------------------------

const digits = (text: string): number[] => text.split(' ').map(Number);
const RIPEMD_R = digits(
  '0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 7 4 13 1 10 6 15 3 12 0 9 5 2 14 11 8 3 10 14 4 9 15 8 1 2 7 0 6 13 11 5 12 1 9 11 10 0 8 12 4 13 3 7 15 14 5 6 2 4 0 5 9 7 12 2 10 14 1 3 8 11 6 15 13'
);
const RIPEMD_R2 = digits(
  '5 14 7 0 9 2 11 4 13 6 15 8 1 10 3 12 6 11 3 7 0 13 5 10 14 15 8 12 4 9 1 2 15 5 1 3 7 14 6 9 11 8 12 2 10 0 4 13 8 6 4 1 3 11 15 0 5 12 2 13 9 7 10 14 12 15 10 4 1 5 8 7 6 2 13 14 0 3 9 11'
);
const RIPEMD_S = digits(
  '11 14 15 12 5 8 7 9 11 13 14 15 6 7 9 8 7 6 8 13 11 9 7 15 7 12 15 9 11 7 13 12 11 13 6 7 14 9 13 15 14 8 13 6 5 12 7 5 11 12 14 15 14 15 9 8 9 14 5 6 8 6 5 12 9 15 5 11 6 8 13 12 5 12 13 14 11 8 5 6'
);
const RIPEMD_S2 = digits(
  '8 9 9 11 13 15 15 5 7 7 8 11 14 14 12 6 9 13 15 7 12 8 9 11 7 7 12 7 6 15 13 11 9 7 15 11 8 6 6 14 12 13 5 14 13 13 7 5 15 5 8 11 14 14 6 14 6 9 12 9 12 5 15 8 8 5 12 9 12 5 14 6 8 13 6 5 15 13 11 11'
);
const RIPEMD_K = [0, 0x5a_82_79_99, 0x6e_d9_eb_a1, 0x8f_1b_bc_dc, 0xa9_53_fd_4e];
const RIPEMD_K2 = [0x50_a2_8b_e6, 0x5c_4d_d1_24, 0x6d_70_3e_f3, 0x7a_6d_76_e9, 0];

function ripemdF(round: number, x: number, y: number, z: number): number {
  switch (round) {
    case 0: {
      return x ^ y ^ z;
    }
    case 1: {
      return (x & y) | (~x & z);
    }
    case 2: {
      return (x | ~y) ^ z;
    }
    case 3: {
      return (x & z) | (y & ~z);
    }
    default: {
      return x ^ (y | ~z);
    }
  }
}

export function ripemd160(data: Uint8Array): Uint8Array {
  const state = [0x67_45_23_01, 0xef_cd_ab_89, 0x98_ba_dc_fe, 0x10_32_54_76, 0xc3_d2_e1_f0];
  const padded = mdPad(data, 64, 8, true);
  for (let offset = 0; offset < padded.length; offset += 64) {
    const x = words32(padded, offset, 16, true);
    let [a, b, c, d, e] = state;
    let [a2, b2, c2, d2, e2] = state;
    for (let index = 0; index < 80; index++) {
      const round = Math.floor(index / 16);
      let t =
        (rotl32((a + ripemdF(round, b, c, d) + x[RIPEMD_R[index]] + RIPEMD_K[round]) >>> 0, RIPEMD_S[index]) + e) >>> 0;
      [a, e, d, c, b] = [e, d, rotl32(c, 10), b, t];
      t =
        (rotl32(
          (a2 + ripemdF(4 - round, b2, c2, d2) + x[RIPEMD_R2[index]] + RIPEMD_K2[round]) >>> 0,
          RIPEMD_S2[index]
        ) +
          e2) >>>
        0;
      [a2, e2, d2, c2, b2] = [e2, d2, rotl32(c2, 10), b2, t];
    }
    const t = (state[1] + c + d2) >>> 0;
    state[1] = (state[2] + d + e2) >>> 0;
    state[2] = (state[3] + e + a2) >>> 0;
    state[3] = (state[4] + a + b2) >>> 0;
    state[4] = (state[0] + b + c2) >>> 0;
    state[0] = t;
  }
  return bytesOf32(state, true);
}

// SM3 ---------------------------------------------------------------------------------------------------------------

const p0 = (x: number): number => (x ^ rotl32(x, 9) ^ rotl32(x, 17)) >>> 0;
const p1 = (x: number): number => (x ^ rotl32(x, 15) ^ rotl32(x, 23)) >>> 0;

// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes the SM3 compression function.
export function sm3(data: Uint8Array): Uint8Array {
  const state = [
    0x73_80_16_6f, 0x49_14_b2_b9, 0x17_24_42_d7, 0xda_8a_06_00, 0xa9_6f_30_bc, 0x16_31_38_aa, 0xe3_8d_ee_4d,
    0xb0_fb_0e_4e,
  ];
  const padded = mdPad(data, 64, 8, false);
  for (let offset = 0; offset < padded.length; offset += 64) {
    const w = words32(padded, offset, 16, false);
    for (let index = 16; index < 68; index++) {
      w.push(
        (p1(w[index - 16] ^ w[index - 9] ^ rotl32(w[index - 3], 15)) ^ rotl32(w[index - 13], 7) ^ w[index - 6]) >>> 0
      );
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const early = index < 16;
      const constant = early ? 0x79_cc_45_19 : 0x7a_87_9d_8a;
      const ss1 = rotl32((rotl32(a, 12) + e + rotl32(constant, index % 32)) >>> 0, 7);
      const ss2 = (ss1 ^ rotl32(a, 12)) >>> 0;
      const ff = early ? a ^ b ^ c : (a & b) | (a & c) | (b & c);
      const gg = early ? e ^ f ^ g : (e & f) | (~e & g);
      const tt1 = (ff + d + ss2 + ((w[index] ^ w[index + 4]) >>> 0)) >>> 0;
      const tt2 = (gg + h + ss1 + w[index]) >>> 0;
      [a, b, c, d, e, f, g, h] = [tt1, a, rotl32(b, 9), c, p0(tt2), e, rotl32(f, 19), g];
    }
    for (const [index, value] of [a, b, c, d, e, f, g, h].entries()) state[index] = (state[index] ^ value) >>> 0;
  }
  return bytesOf32(state, false);
}
