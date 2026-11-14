// The integrity checks of liblzma 5.8.4 (`check.c`, `crc32_*.c`, `crc64_*.c`, `sha256.c`).
import { sha256 } from '../hashAlgorithms';

export const LZMA_CHECK_NONE = 0;
export const LZMA_CHECK_CRC32 = 1;
export const LZMA_CHECK_CRC64 = 4;
export const LZMA_CHECK_SHA256 = 10;
export const LZMA_CHECK_ID_MAX = 15;

/** `lzma_crc32_table[0]`, which the match finders also hash with. */
export const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
  return value;
});

const CRC64_LOW = new Uint32Array(256);
const CRC64_HIGH = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let low = index;
  let high = 0;
  for (let bit = 0; bit < 8; bit++) {
    const carry = low & 1;
    low = ((low >>> 1) | (high << 31)) >>> 0;
    high >>>= 1;
    if (carry) {
      low = (low ^ 0xd7_87_0f_42) >>> 0;
      high = (high ^ 0xc9_6c_57_95) >>> 0;
    }
  }
  CRC64_LOW[index] = low;
  CRC64_HIGH[index] = high;
}

export function crc32(buf: Uint8Array, start: number, end: number, crc: number): number {
  let value = ~crc >>> 0;
  for (let i = start; i < end; i++) value = CRC32_TABLE[(value ^ buf[i]) & 0xff] ^ (value >>> 8);
  return ~value >>> 0;
}

export function checkIsSupported(type: number): boolean {
  return (
    type === LZMA_CHECK_NONE || type === LZMA_CHECK_CRC32 || type === LZMA_CHECK_CRC64 || type === LZMA_CHECK_SHA256
  );
}

const CHECK_SIZES = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64];

export function checkSize(type: number): number {
  return type >= 0 && type <= LZMA_CHECK_ID_MAX ? CHECK_SIZES[type] : -1;
}

/** `lzma_check_state` of one check type, which `finish` turns into the stored bytes. */
export class CheckState {
  private crcValue = 0;
  private crcHigh = 0;
  private readonly chunks: Uint8Array[] = [];

  constructor(private readonly type: number) {}

  update(buf: Uint8Array, start: number, end: number): void {
    if (this.type === LZMA_CHECK_CRC32) this.crcValue = crc32(buf, start, end, this.crcValue);
    else if (this.type === LZMA_CHECK_CRC64) this.updateCrc64(buf, start, end);
    else if (this.type === LZMA_CHECK_SHA256) this.chunks.push(buf.slice(start, end));
  }

  finish(): Uint8Array {
    const result = new Uint8Array(64);
    if (this.type === LZMA_CHECK_CRC32 || this.type === LZMA_CHECK_CRC64) {
      for (let i = 0; i < 4; i++) {
        result[i] = (this.crcValue >>> (8 * i)) & 0xff;
        result[4 + i] = (this.crcHigh >>> (8 * i)) & 0xff;
      }
    } else if (this.type === LZMA_CHECK_SHA256) {
      const size = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of this.chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      result.set(sha256(data));
    }
    return result;
  }

  private updateCrc64(buf: Uint8Array, start: number, end: number): void {
    let low = ~this.crcValue >>> 0;
    let high = ~this.crcHigh >>> 0;
    for (let i = start; i < end; i++) {
      const index = (low ^ buf[i]) & 0xff;
      low = (((low >>> 8) | (high << 24)) ^ CRC64_LOW[index]) >>> 0;
      high = ((high >>> 8) ^ CRC64_HIGH[index]) >>> 0;
    }
    this.crcValue = ~low >>> 0;
    this.crcHigh = ~high >>> 0;
  }
}
