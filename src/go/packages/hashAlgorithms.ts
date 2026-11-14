/** A streaming message digest over bytes, as the digests behind Go's `hash.Hash` values keep their state. */
export interface Digest {
  readonly size: number;
  readonly blockSize: number;
  write(bytes: Uint8Array): void;
  /** The checksum of what was written so far, leaving the state as it is. */
  sum(): Uint8Array;
  reset(): void;
  clone(): Digest;
}

export type DigestName = 'md5' | 'sha1' | 'sha224' | 'sha256' | 'sha384' | 'sha512' | 'sha512_224' | 'sha512_256';

export function newDigest(name: DigestName): Digest {
  switch (name) {
    case 'md5': {
      return new Md5();
    }
    case 'sha1': {
      return new Sha1();
    }
    case 'sha224': {
      return new Sha256(true);
    }
    case 'sha256': {
      return new Sha256(false);
    }
    default: {
      return new Sha512(name);
    }
  }
}

/** The Merkle–Damgård framing shared by MD5 and the SHA family: whole blocks are compressed as they fill. */
abstract class BlockDigest implements Digest {
  abstract readonly size: number;
  protected pending: number[] = [];
  protected length = 0;

  constructor(readonly blockSize: number) {}

  write(bytes: Uint8Array): void {
    this.length += bytes.length;
    for (const byte of bytes) {
      this.pending.push(byte);
      if (this.pending.length === this.blockSize) {
        this.compress(this.pending);
        this.pending = [];
      }
    }
  }

  sum(): Uint8Array {
    const copy = this.clone() as BlockDigest;
    const lengthBytes = this.blockSize === 128 ? 16 : 8;
    const bitLength = BigInt(copy.length) * 8n;
    copy.write(Uint8Array.of(0x80));
    while (copy.pending.length !== this.blockSize - lengthBytes) copy.write(Uint8Array.of(0));
    const trailer = new Uint8Array(lengthBytes);
    for (let index = 0; index < lengthBytes; index++) {
      const shift = BigInt(this.littleEndian ? index * 8 : (lengthBytes - 1 - index) * 8);
      trailer[index] = Number((bitLength >> shift) & 0xffn);
    }
    copy.write(trailer);
    return copy.output();
  }

  reset(): void {
    this.pending = [];
    this.length = 0;
    this.initialize();
  }

  clone(): Digest {
    const copy = Object.assign(Object.create(Object.getPrototypeOf(this) as object) as BlockDigest, this);
    copy.pending = [...this.pending];
    copy.copyState(this);
    return copy;
  }

  protected get littleEndian(): boolean {
    return false;
  }

  protected abstract initialize(): void;
  protected abstract compress(block: number[]): void;
  protected abstract output(): Uint8Array;
  protected abstract copyState(from: this): void;
}

function wordsOut(words: ArrayLike<number>, count: number, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(count * 4);
  for (let index = 0; index < count; index++) {
    const word = words[index] >>> 0;
    for (let byte = 0; byte < 4; byte++) {
      out[index * 4 + byte] = (word >>> (littleEndian ? byte * 8 : (3 - byte) * 8)) & 0xff;
    }
  }
  return out;
}

function bigEndianWords(block: number[], count: number): number[] {
  const words: number[] = [];
  for (let index = 0; index < count; index++) {
    const at = index * 4;
    words.push(((block[at] << 24) | (block[at + 1] << 16) | (block[at + 2] << 8) | block[at + 3]) >>> 0);
  }
  return words;
}

const rotl = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0;
const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

// MD5 ---------------------------------------------------------------------------------------------------------------

const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_TABLE = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0);

class Md5 extends BlockDigest {
  readonly size = 16;
  private state: number[] = [];

  constructor() {
    super(64);
    this.initialize();
  }

  protected override get littleEndian(): boolean {
    return true;
  }

  protected initialize(): void {
    this.state = [0x67_45_23_01, 0xef_cd_ab_89, 0x98_ba_dc_fe, 0x10_32_54_76];
  }

  protected compress(block: number[]): void {
    const x: number[] = [];
    for (let index = 0; index < 16; index++) {
      const at = index * 4;
      x.push((block[at] | (block[at + 1] << 8) | (block[at + 2] << 16) | (block[at + 3] << 24)) >>> 0);
    }
    let [a, b, c, d] = this.state;
    for (let round = 0; round < 64; round++) {
      let f: number;
      let g: number;
      if (round < 16) {
        f = (b & c) | (~b & d);
        g = round;
      } else if (round < 32) {
        f = (b & d) | (c & ~d);
        g = (5 * round + 1) % 16;
      } else if (round < 48) {
        f = b ^ c ^ d;
        g = (3 * round + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * round) % 16;
      }
      const shift = MD5_SHIFTS[(round >> 4) * 4 + (round % 4)];
      const next = (b + rotl((a + f + MD5_TABLE[round] + x[g]) >>> 0, shift)) >>> 0;
      a = d;
      d = c;
      c = b;
      b = next;
    }
    this.state = [
      (this.state[0] + a) >>> 0,
      (this.state[1] + b) >>> 0,
      (this.state[2] + c) >>> 0,
      (this.state[3] + d) >>> 0,
    ];
  }

  protected output(): Uint8Array {
    return wordsOut(this.state, 4, true);
  }

  protected copyState(from: this): void {
    this.state = [...from.state];
  }
}

// SHA-1 -------------------------------------------------------------------------------------------------------------

class Sha1 extends BlockDigest {
  readonly size = 20;
  private state: number[] = [];

  constructor() {
    super(64);
    this.initialize();
  }

  protected initialize(): void {
    this.state = [0x67_45_23_01, 0xef_cd_ab_89, 0x98_ba_dc_fe, 0x10_32_54_76, 0xc3_d2_e1_f0];
  }

  protected compress(block: number[]): void {
    const w = bigEndianWords(block, 16);
    for (let index = 16; index < 80; index++)
      w.push(rotl(w[index - 3] ^ w[index - 8] ^ w[index - 14] ^ w[index - 16], 1));
    let [a, b, c, d, e] = this.state;
    for (let round = 0; round < 80; round++) {
      let f: number;
      let k: number;
      if (round < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a_82_79_99;
      } else if (round < 40) {
        f = b ^ c ^ d;
        k = 0x6e_d9_eb_a1;
      } else if (round < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f_1b_bc_dc;
      } else {
        f = b ^ c ^ d;
        k = 0xca_62_c1_d6;
      }
      const t = (rotl(a, 5) + (f >>> 0) + e + k + w[round]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    this.state = this.state.map((value, index) => (value + [a, b, c, d, e][index]) >>> 0);
  }

  protected output(): Uint8Array {
    return wordsOut(this.state, 5, false);
  }

  protected copyState(from: this): void {
    this.state = [...from.state];
  }
}

// SHA-256 and SHA-224 -----------------------------------------------------------------------------------------------

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

class Sha256 extends BlockDigest {
  readonly size: number;
  private state: number[] = [];

  constructor(private readonly is224: boolean) {
    super(64);
    this.size = is224 ? 28 : 32;
    this.initialize();
  }

  protected initialize(): void {
    this.state = this.is224
      ? [
          0xc1_05_9e_d8, 0x36_7c_d5_07, 0x30_70_dd_17, 0xf7_0e_59_39, 0xff_c0_0b_31, 0x68_58_15_11, 0x64_f9_8f_a7,
          0xbe_fa_4f_a4,
        ]
      : [
          0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a, 0x51_0e_52_7f, 0x9b_05_68_8c, 0x1f_83_d9_ab,
          0x5b_e0_cd_19,
        ];
  }

  protected compress(block: number[]): void {
    const w = bigEndianWords(block, 16);
    for (let index = 16; index < 64; index++) {
      const v1 = w[index - 2];
      const v2 = w[index - 15];
      const s1 = rotr(v1, 17) ^ rotr(v1, 19) ^ (v1 >>> 10);
      const s0 = rotr(v2, 7) ^ rotr(v2, 18) ^ (v2 >>> 3);
      w.push((s1 + w[index - 7] + s0 + w[index - 16]) >>> 0);
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let round = 0; round < 64; round++) {
      const t1 =
        (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[round] + w[round]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this.state = this.state.map((value, index) => (value + [a, b, c, d, e, f, g, h][index]) >>> 0);
  }

  protected output(): Uint8Array {
    return wordsOut(this.state, this.size / 4, false);
  }

  protected copyState(from: this): void {
    this.state = [...from.state];
  }
}

// SHA-512 and its truncations ---------------------------------------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;
const SHA512_K = [
  '428a2f98d728ae22 7137449123ef65cd b5c0fbcfec4d3b2f e9b5dba58189dbbc 3956c25bf348b538 59f111f1b605d019',
  '923f82a4af194f9b ab1c5ed5da6d8118 d807aa98a3030242 12835b0145706fbe 243185be4ee4b28c 550c7dc3d5ffb4e2',
  '72be5d74f27b896f 80deb1fe3b1696b1 9bdc06a725c71235 c19bf174cf692694 e49b69c19ef14ad2 efbe4786384f25e3',
  '0fc19dc68b8cd5b5 240ca1cc77ac9c65 2de92c6f592b0275 4a7484aa6ea6e483 5cb0a9dcbd41fbd4 76f988da831153b5',
  '983e5152ee66dfab a831c66d2db43210 b00327c898fb213f bf597fc7beef0ee4 c6e00bf33da88fc2 d5a79147930aa725',
  '06ca6351e003826f 142929670a0e6e70 27b70a8546d22ffc 2e1b21385c26c926 4d2c6dfc5ac42aed 53380d139d95b3df',
  '650a73548baf63de 766a0abb3c77b2a8 81c2c92e47edaee6 92722c851482353b a2bfe8a14cf10364 a81a664bbc423001',
  'c24b8b70d0f89791 c76c51a30654be30 d192e819d6ef5218 d69906245565a910 f40e35855771202a 106aa07032bbd1b8',
  '19a4c116b8d2d0c8 1e376c085141ab53 2748774cdf8eeb99 34b0bcb5e19b48a8 391c0cb3c5c95a63 4ed8aa4ae3418acb',
  '5b9cca4f7763e373 682e6ff3d6b2b8a3 748f82ee5defb2fc 78a5636f43172f60 84c87814a1f0ab72 8cc702081a6439ec',
  '90befffa23631e28 a4506cebde82bde9 bef9a3f7b2c67915 c67178f2e372532b ca273eceea26619c d186b8c721c0c207',
  'eada7dd6cde0eb1e f57d4f7fee6ed178 06f067aa72176fba 0a637dc5a2c898a6 113f9804bef90dae 1b710b35131c471b',
  '28db77f523047d84 32caab7b40c72493 3c9ebe0a15c9bebc 431d67c49c100d4c 4cc5d4becb3e42b6 597f299cfc657e2a',
  '5fcb6fab3ad6faec 6c44198c4a475817',
]
  .join(' ')
  .split(' ')
  .map((hex) => BigInt(`0x${hex}`));

const SHA512_INITIAL: Record<string, string> = {
  sha512:
    '6a09e667f3bcc908 bb67ae8584caa73b 3c6ef372fe94f82b a54ff53a5f1d36f1 510e527fade682d1 9b05688c2b3e6c1f 1f83d9abfb41bd6b 5be0cd19137e2179',
  sha384:
    'cbbb9d5dc1059ed8 629a292a367cd507 9159015a3070dd17 152fecd8f70e5939 67332667ffc00b31 8eb44a8768581511 db0c2e0d64f98fa7 47b5481dbefa4fa4',
  sha512_224:
    '8c3d37c819544da2 73e1996689dcd4d6 1dfab7ae32ff9c82 679dd514582f9fcf 0f6d2b697bd44da8 77e36f7304c48942 3f9d85a86a1d36c8 1112e6ad91d692a1',
  sha512_256:
    '22312194fc2bf72c 9f555fa3c84c64c2 2393b86b6f53b151 963877195940eabd 96283ee2a88effe3 be5e1e2553863992 2b0199fc2c85b8aa 0eb72ddc81c52ca2',
};

const SHA512_SIZES: Record<string, number> = { sha512: 64, sha384: 48, sha512_224: 28, sha512_256: 32 };

const rotr64 = (x: bigint, n: bigint): bigint => ((x >> n) | (x << (64n - n))) & MASK64;

class Sha512 extends BlockDigest {
  readonly size: number;
  private state: bigint[] = [];

  constructor(private readonly variant: string) {
    super(128);
    this.size = SHA512_SIZES[variant];
    this.initialize();
  }

  protected initialize(): void {
    this.state = SHA512_INITIAL[this.variant].split(' ').map((hex) => BigInt(`0x${hex}`));
  }

  protected compress(block: number[]): void {
    const w: bigint[] = [];
    for (let index = 0; index < 16; index++) {
      let word = 0n;
      for (let byte = 0; byte < 8; byte++) word = (word << 8n) | BigInt(block[index * 8 + byte]);
      w.push(word);
    }
    for (let index = 16; index < 80; index++) {
      const v1 = w[index - 2];
      const v2 = w[index - 15];
      const s1 = rotr64(v1, 19n) ^ rotr64(v1, 61n) ^ (v1 >> 6n);
      const s0 = rotr64(v2, 1n) ^ rotr64(v2, 8n) ^ (v2 >> 7n);
      w.push((s1 + w[index - 7] + s0 + w[index - 16]) & MASK64);
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let round = 0; round < 80; round++) {
      const ch = (e & f) ^ (~e & MASK64 & g);
      const t1 = (h + (rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n)) + ch + SHA512_K[round] + w[round]) & MASK64;
      const t2 = ((rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n)) + ((a & b) ^ (a & c) ^ (b & c))) & MASK64;
      h = g;
      g = f;
      f = e;
      e = (d + t1) & MASK64;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & MASK64;
    }
    this.state = this.state.map((value, index) => (value + [a, b, c, d, e, f, g, h][index]) & MASK64);
  }

  protected output(): Uint8Array {
    const out = new Uint8Array(64);
    for (const [index, word] of this.state.entries()) {
      for (let byte = 0; byte < 8; byte++) out[index * 8 + byte] = Number((word >> BigInt((7 - byte) * 8)) & 0xffn);
    }
    return out.slice(0, this.size);
  }

  protected copyState(from: this): void {
    this.state = [...from.state];
  }
}

// CRC-32 ------------------------------------------------------------------------------------------------------------

/** `crc32.simpleMakeTable`: the table of the reversed polynomial. */
export function crc32Table(poly: number): number[] {
  const table: number[] = [];
  for (let index = 0; index < 256; index++) {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? ((crc >>> 1) ^ poly) >>> 0 : crc >>> 1;
    table.push(crc >>> 0);
  }
  return table;
}

/** `crc32.simpleUpdate`. */
export function crc32Update(crc: number, table: readonly number[], bytes: Uint8Array): number {
  let value = ~crc >>> 0;
  for (const byte of bytes) value = (table[(value ^ byte) & 0xff] ^ (value >>> 8)) >>> 0;
  return ~value >>> 0;
}
