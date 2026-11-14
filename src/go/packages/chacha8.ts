// oxlint-disable unicorn/prefer-code-point -- Go strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
/*
 * Go's ChaCha8 generator (Go 1.27.3) transcribed to TypeScript, so that math/rand/v2 programs draw the same values as
 * real Go. Original code: Copyright The Go Authors, BSD license (see the Go distribution's LICENSE file).
 */

import { boundsPanic } from '../runtimeErrors';

const CTR_INC = 4;
const CTR_MAX = 16;
const CHUNK = 32;
const RESEED = 4;
const STATE_PREFIX = 'chacha8:';
const READ_BUF_PREFIX = 'readbuf:';
const INVALID_ENCODING = 'invalid ChaCha8 encoding';

/** Transcribes Go's internal/chacha8rand (chacha8.go, chacha8_generic.go) and math/rand/v2's chacha8.go. */
export class ChaCha8 {
  /** `[32]uint64` stored as little-endian uint32 pairs, i.e. Go's `[16][4]uint32` view of it. */
  private buf = new Uint32Array(CHUNK * 2);
  /** `[4]uint64` stored as little-endian uint32 pairs. */
  private seedWords = new Uint32Array(RESEED * 2);
  private i = 0;
  private n = 0;
  private c = 0;
  private readBuf = new Uint8Array(8);
  private readLen = 0;

  /** A generator from the seed, or without one, Go's zero ChaCha8. */
  constructor(seed?: string) {
    if (seed !== undefined) this.init(seed);
  }

  seed(seed: string): void {
    this.init(seed);
    this.readLen = 0;
    this.readBuf.fill(0);
  }

  uint64(): bigint {
    while (this.i >= this.n) this.refill();
    const k = this.i++ * 2;
    return (BigInt(this.buf[k + 1]) << 32n) | BigInt(this.buf[k]);
  }

  read(length: number): string {
    const bytes: number[] = [];
    if (this.readLen > 0) {
      const copied = Math.min(length, this.readLen);
      for (let j = 0; j < copied; j++) bytes.push(this.readBuf[8 - this.readLen + j]);
      this.readLen -= copied;
    }
    while (length - bytes.length >= 8) bytes.push(...littleEndianBytes(this.uint64()));
    const rest = length - bytes.length;
    if (rest > 0) {
      this.readBuf.set(littleEndianBytes(this.uint64()));
      for (let j = 0; j < rest; j++) bytes.push(this.readBuf[j]);
      this.readLen = 8 - rest;
    }
    return String.fromCharCode(...bytes);
  }

  appendBinary(): string {
    let out = '';
    if (this.readLen > 0) {
      out += READ_BUF_PREFIX + String.fromCharCode(this.readLen, ...this.readBuf.subarray(8 - this.readLen));
    }
    const used = (this.c / CTR_INC) * CHUNK + this.i;
    out += STATE_PREFIX;
    for (let shift = 56; shift >= 0; shift -= 8) out += String.fromCharCode(shift >= 32 ? 0 : (used >>> shift) & 0xff);
    for (const word of this.seedWords) out += String.fromCharCode(...wordBytes(word));
    return out;
  }

  unmarshalBinary(data: string): string | undefined {
    if (data.startsWith(READ_BUF_PREFIX)) {
      data = data.slice(READ_BUF_PREFIX.length);
      if (data.length === 0 || data.length < 1 + data.charCodeAt(0)) return 'invalid ChaCha8 Read buffer encoding';
      const length = data.charCodeAt(0);
      if (length > 8) boundsPanic(`slice bounds out of range [${8 - length}:]`);
      for (let j = 0; j < length; j++) this.readBuf[8 - length + j] = data.charCodeAt(1 + j);
      this.readLen = length;
      data = data.slice(1 + length);
    }
    return this.unmarshalState(data);
  }

  clone(): ChaCha8 {
    const copy = Object.create(ChaCha8.prototype) as ChaCha8;
    copy.buf = new Uint32Array(this.buf);
    copy.seedWords = new Uint32Array(this.seedWords);
    copy.i = this.i;
    copy.n = this.n;
    copy.c = this.c;
    copy.readBuf = new Uint8Array(this.readBuf);
    copy.readLen = this.readLen;
    return copy;
  }

  private init(seed: string): void {
    this.setSeedWords(seed, 0);
    this.c = 0;
    this.restart(0);
  }

  private refill(): void {
    this.c += CTR_INC;
    if (this.c === CTR_MAX) {
      this.seedWords.set(this.buf.subarray((CHUNK - RESEED) * 2));
      this.c = 0;
    }
    this.restart(0);
  }

  private unmarshalState(data: string): string | undefined {
    if (data.length !== 6 * 8 || !data.startsWith(STATE_PREFIX)) return INVALID_ENCODING;
    let used = 0;
    for (let j = 8; j < 16; j++) {
      if (j < 12 && data.charCodeAt(j) !== 0) return INVALID_ENCODING;
      used = used * 256 + data.charCodeAt(j);
    }
    if (used > (CTR_MAX / CTR_INC) * CHUNK - RESEED) return INVALID_ENCODING;
    this.setSeedWords(data, 16);
    this.c = CTR_INC * Math.floor(used / CHUNK);
    this.restart(used % CHUNK);
    return undefined;
  }

  private setSeedWords(bytes: string, offset: number): void {
    for (let w = 0; w < this.seedWords.length; w++) {
      const at = offset + w * 4;
      this.seedWords[w] =
        (bytes.charCodeAt(at) |
          (bytes.charCodeAt(at + 1) << 8) |
          (bytes.charCodeAt(at + 2) << 16) |
          (bytes.charCodeAt(at + 3) << 24)) >>>
        0;
    }
  }

  private restart(i: number): void {
    block(this.seedWords, this.buf, this.c);
    this.i = i;
    this.n = this.c === CTR_MAX - CTR_INC ? CHUNK - RESEED : CHUNK;
  }
}

function littleEndianBytes(value: bigint): number[] {
  return [...wordBytes(Number(value & 0xff_ff_ff_ffn)), ...wordBytes(Number(value >> 32n))];
}

function wordBytes(word: number): number[] {
  return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff];
}

/** Go's `block_generic`: four ChaCha8 blocks for counters `counter..counter+3`, interleaved word by word. */
function block(seed: Uint32Array, buf: Uint32Array, counter: number): void {
  for (let lane = 0; lane < 4; lane++) {
    let b0 = 0x61_70_78_65;
    let b1 = 0x33_20_64_6e;
    let b2 = 0x79_62_2d_32;
    let b3 = 0x6b_20_65_74;
    let b4 = seed[0];
    let b5 = seed[1];
    let b6 = seed[2];
    let b7 = seed[3];
    let b8 = seed[4];
    let b9 = seed[5];
    let b10 = seed[6];
    let b11 = seed[7];
    let b12 = counter + lane;
    let b13 = 0;
    let b14 = 0;
    let b15 = 0;
    for (let round = 0; round < 4; round++) {
      // Each quarter round is inlined: qr(a, b, c, d) as in chacha8_generic.go.
      b0 = (b0 + b4) >>> 0;
      b12 ^= b0;
      b12 = (b12 << 16) | (b12 >>> 16);
      b8 = (b8 + b12) >>> 0;
      b4 ^= b8;
      b4 = (b4 << 12) | (b4 >>> 20);
      b0 = (b0 + b4) >>> 0;
      b12 ^= b0;
      b12 = (b12 << 8) | (b12 >>> 24);
      b8 = (b8 + b12) >>> 0;
      b4 ^= b8;
      b4 = (b4 << 7) | (b4 >>> 25);

      b1 = (b1 + b5) >>> 0;
      b13 ^= b1;
      b13 = (b13 << 16) | (b13 >>> 16);
      b9 = (b9 + b13) >>> 0;
      b5 ^= b9;
      b5 = (b5 << 12) | (b5 >>> 20);
      b1 = (b1 + b5) >>> 0;
      b13 ^= b1;
      b13 = (b13 << 8) | (b13 >>> 24);
      b9 = (b9 + b13) >>> 0;
      b5 ^= b9;
      b5 = (b5 << 7) | (b5 >>> 25);

      b2 = (b2 + b6) >>> 0;
      b14 ^= b2;
      b14 = (b14 << 16) | (b14 >>> 16);
      b10 = (b10 + b14) >>> 0;
      b6 ^= b10;
      b6 = (b6 << 12) | (b6 >>> 20);
      b2 = (b2 + b6) >>> 0;
      b14 ^= b2;
      b14 = (b14 << 8) | (b14 >>> 24);
      b10 = (b10 + b14) >>> 0;
      b6 ^= b10;
      b6 = (b6 << 7) | (b6 >>> 25);

      b3 = (b3 + b7) >>> 0;
      b15 ^= b3;
      b15 = (b15 << 16) | (b15 >>> 16);
      b11 = (b11 + b15) >>> 0;
      b7 ^= b11;
      b7 = (b7 << 12) | (b7 >>> 20);
      b3 = (b3 + b7) >>> 0;
      b15 ^= b3;
      b15 = (b15 << 8) | (b15 >>> 24);
      b11 = (b11 + b15) >>> 0;
      b7 ^= b11;
      b7 = (b7 << 7) | (b7 >>> 25);

      b0 = (b0 + b5) >>> 0;
      b15 ^= b0;
      b15 = (b15 << 16) | (b15 >>> 16);
      b10 = (b10 + b15) >>> 0;
      b5 ^= b10;
      b5 = (b5 << 12) | (b5 >>> 20);
      b0 = (b0 + b5) >>> 0;
      b15 ^= b0;
      b15 = (b15 << 8) | (b15 >>> 24);
      b10 = (b10 + b15) >>> 0;
      b5 ^= b10;
      b5 = (b5 << 7) | (b5 >>> 25);

      b1 = (b1 + b6) >>> 0;
      b12 ^= b1;
      b12 = (b12 << 16) | (b12 >>> 16);
      b11 = (b11 + b12) >>> 0;
      b6 ^= b11;
      b6 = (b6 << 12) | (b6 >>> 20);
      b1 = (b1 + b6) >>> 0;
      b12 ^= b1;
      b12 = (b12 << 8) | (b12 >>> 24);
      b11 = (b11 + b12) >>> 0;
      b6 ^= b11;
      b6 = (b6 << 7) | (b6 >>> 25);

      b2 = (b2 + b7) >>> 0;
      b13 ^= b2;
      b13 = (b13 << 16) | (b13 >>> 16);
      b8 = (b8 + b13) >>> 0;
      b7 ^= b8;
      b7 = (b7 << 12) | (b7 >>> 20);
      b2 = (b2 + b7) >>> 0;
      b13 ^= b2;
      b13 = (b13 << 8) | (b13 >>> 24);
      b8 = (b8 + b13) >>> 0;
      b7 ^= b8;
      b7 = (b7 << 7) | (b7 >>> 25);

      b3 = (b3 + b4) >>> 0;
      b14 ^= b3;
      b14 = (b14 << 16) | (b14 >>> 16);
      b9 = (b9 + b14) >>> 0;
      b4 ^= b9;
      b4 = (b4 << 12) | (b4 >>> 20);
      b3 = (b3 + b4) >>> 0;
      b14 ^= b3;
      b14 = (b14 << 8) | (b14 >>> 24);
      b9 = (b9 + b14) >>> 0;
      b4 ^= b9;
      b4 = (b4 << 7) | (b4 >>> 25);
    }
    // Go keeps the input words only for the seed rows (b[4]..b[11] +=); the other rows store the round output alone.
    const words = [b0, b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11, b12, b13, b14, b15];
    for (let row = 0; row < 16; row++) {
      buf[row * 4 + lane] = row >= 4 && row < 12 ? words[row] + seed[row - 4] : words[row];
    }
  }
}
