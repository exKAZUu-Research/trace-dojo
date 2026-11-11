import { SHA256_IV, SHA256_K } from '../hashAlgorithms';
import { currentRuntime } from '../runtimeContext';

/** A hash function with the block size HMAC pads its key to. */
export interface HmacHash {
  name: string;
  digest: (data: Uint8Array) => Uint8Array;
  blockSize: number;
  digestSize: number;
}

/** HMAC (RFC 2104) of a message, with a key already reduced to a block by {@link hmacKey}. */
function hmac(hash: HmacHash, key: Uint8Array, message: Uint8Array): Uint8Array {
  const inner = new Uint8Array(hash.blockSize + message.length);
  const outer = new Uint8Array(hash.blockSize + hash.digestSize);
  for (let index = 0; index < hash.blockSize; index++) {
    inner[index] = key[index] ^ 0x36;
    outer[index] = key[index] ^ 0x5c;
  }
  inner.set(message, hash.blockSize);
  outer.set(hash.digest(inner), hash.blockSize);
  return hash.digest(outer);
}

function hmacKey(hash: HmacHash, password: Uint8Array): Uint8Array {
  const key = new Uint8Array(hash.blockSize);
  key.set(password.length > hash.blockSize ? hash.digest(password) : password);
  return key;
}

/** PBKDF2 (RFC 8018) with HMAC of `hash`, as `hashlib.pbkdf2_hmac` derives a key. */
export function pbkdf2(
  hash: HmacHash,
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  length: number
): Uint8Array {
  const runtime = currentRuntime();
  const key = hmacKey(hash, password);
  const result = new Uint8Array(length);
  const message = new Uint8Array(salt.length + 4);
  message.set(salt);
  for (let block = 1, offset = 0; offset < length; block++, offset += hash.digestSize) {
    new DataView(message.buffer).setUint32(salt.length, block);
    let u = hmac(hash, key, message);
    const t = Uint8Array.from(u);
    const next = hash.name === 'sha256' ? sha256HmacOfDigest(key) : (digest: Uint8Array) => hmac(hash, key, digest);
    for (let iteration = 1; iteration < iterations; iteration++) {
      if (iteration % 256 === 0) runtime.spend(16);
      u = next(u);
      for (let index = 0; index < t.length; index++) t[index] ^= u[index];
    }
    result.set(t.subarray(0, Math.min(hash.digestSize, length - offset)), offset);
  }
  return result;
}

/**
 * HMAC-SHA256 of a 32-byte digest under a key of one block, which PBKDF2 computes for every iteration: the states after
 * the padded key blocks are computed once, so that each HMAC compresses only two blocks.
 */
function sha256HmacOfDigest(key: Uint8Array): (digest: Uint8Array) => Uint8Array {
  const pad = (byte: number): Int32Array => {
    const state = Int32Array.from(SHA256_IV);
    const block = new Int32Array(16);
    for (let index = 0; index < 16; index++) {
      block[index] =
        ((key[index * 4] ^ byte) << 24) |
        ((key[index * 4 + 1] ^ byte) << 16) |
        ((key[index * 4 + 2] ^ byte) << 8) |
        (key[index * 4 + 3] ^ byte);
    }
    sha256Compress(state, block);
    return state;
  };
  const inner = pad(0x36);
  const outer = pad(0x5c);
  const block = new Int32Array(16);
  const state = new Int32Array(8);
  // One block of a 32-byte message after a 64-byte block: the message, the 0x80 marker, and the length of 96 bytes.
  const hashDigest = (from: Int32Array): void => {
    state.set(from);
    block[8] = 0x80_00_00_00;
    block.fill(0, 9, 15);
    block[15] = 96 * 8;
    sha256Compress(state, block);
  };
  return (digest) => {
    for (let index = 0; index < 8; index++) {
      block[index] =
        (digest[index * 4] << 24) |
        (digest[index * 4 + 1] << 16) |
        (digest[index * 4 + 2] << 8) |
        digest[index * 4 + 3];
    }
    hashDigest(inner);
    block.set(state.subarray(0, 8));
    hashDigest(outer);
    const result = new Uint8Array(32);
    const view = new DataView(result.buffer);
    for (let index = 0; index < 8; index++) view.setInt32(index * 4, state[index]);
    return result;
  };
}

const schedule = new Int32Array(64);

// code-gauge-allow functionNcss 31 -- The SHA-256 compression function as FIPS 180-4 states it.
function sha256Compress(state: Int32Array, block: Int32Array): void {
  const w = schedule;
  w.set(block);
  for (let index = 16; index < 64; index++) {
    const a = w[index - 15];
    const b = w[index - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    w[index] = w[index - 16] + s0 + w[index - 7] + s1;
  }
  let [a, b, c, d, e, f, g, h] = state;
  for (let index = 0; index < 64; index++) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + s1 + ((e & f) ^ (~e & g)) + SHA256_K[index] + w[index]) >>> 0;
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

/** scrypt (RFC 7914), as `hashlib.scrypt` derives a key, using PBKDF2 with HMAC-SHA256 as `sha256` gives it. */
export function scrypt(
  sha256: HmacHash,
  password: Uint8Array,
  salt: Uint8Array,
  { n, r, p, length }: { n: number; r: number; p: number; length: number }
): Uint8Array {
  const runtime = currentRuntime();
  const blockLength = 128 * r;
  const blocks = pbkdf2(sha256, password, salt, 1, p * blockLength);
  const words = new Uint32Array(blockLength / 4);
  const memory = new Uint32Array((blockLength / 4) * n);
  const scratch = new Uint32Array(blockLength / 4);
  for (let index = 0; index < p; index++) {
    const view = new DataView(blocks.buffer, index * blockLength, blockLength);
    for (let word = 0; word < words.length; word++) words[word] = view.getUint32(word * 4, true);
    for (let step = 0; step < n; step++) {
      memory.set(words, step * words.length);
      blockMix(words, scratch, r);
    }
    runtime.spend(Math.ceil((n * r) / 4));
    for (let step = 0; step < n; step++) {
      const j = words[(2 * r - 1) * 16] % n;
      for (let word = 0; word < words.length; word++) words[word] ^= memory[j * words.length + word];
      blockMix(words, scratch, r);
    }
    runtime.spend(Math.ceil((n * r) / 4));
    for (let word = 0; word < words.length; word++) view.setUint32(word * 4, words[word], true);
  }
  return pbkdf2(sha256, password, blocks, 1, length);
}

/** scryptBlockMix: Salsa20/8 over the 2r 64-byte blocks of `words`, in place, with `scratch` of the same size. */
function blockMix(words: Uint32Array, scratch: Uint32Array, r: number): void {
  const x = words.slice((2 * r - 1) * 16, 2 * r * 16);
  for (let index = 0; index < 2 * r; index++) {
    for (let word = 0; word < 16; word++) x[word] ^= words[index * 16 + word];
    salsa208(x);
    // The even blocks go to the first half of the output, the odd ones to the second.
    scratch.set(x, ((index % 2) * r + Math.floor(index / 2)) * 16);
  }
  words.set(scratch);
}

function salsa208(block: Uint32Array): void {
  const x = Uint32Array.from(block);
  const quarter = (a: number, b: number, c: number, d: number): void => {
    x[b] ^= rotate(x[a] + x[d], 7);
    x[c] ^= rotate(x[b] + x[a], 9);
    x[d] ^= rotate(x[c] + x[b], 13);
    x[a] ^= rotate(x[d] + x[c], 18);
  };
  for (let round = 0; round < 8; round += 2) {
    quarter(0, 4, 8, 12);
    quarter(5, 9, 13, 1);
    quarter(10, 14, 2, 6);
    quarter(15, 3, 7, 11);
    quarter(0, 1, 2, 3);
    quarter(5, 6, 7, 4);
    quarter(10, 11, 8, 9);
    quarter(15, 12, 13, 14);
  }
  for (let index = 0; index < 16; index++) block[index] = (block[index] + x[index]) >>> 0;
}

function rotate(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}
