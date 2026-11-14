// The Huffman coding of bzip2 1.0.8's `huffman.c`, and its CRC-32.

export const BZ_MAX_ALPHA_SIZE = 258;
const BZ_MAX_CODE_LEN = 23;

/** bzip2's CRC-32, which shifts the most significant bit out first. */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let c = index << 24;
  for (let bit = 0; bit < 8; bit++) c = c & 0x80_00_00_00 ? (c << 1) ^ 0x04_c1_1d_b7 : c << 1;
  return c >>> 0;
});

export function updateCrc(crc: number, byte: number): number {
  return ((crc << 8) ^ CRC_TABLE[(crc >>> 24) ^ byte]) >>> 0;
}

/** The heap of tree nodes by weight, whose entry 0 is a sentinel, as `BZ2_hbMakeCodeLengths` keeps it. */
class NodeHeap {
  readonly heap = new Int32Array(BZ_MAX_ALPHA_SIZE + 2);
  size = 0;

  constructor(private readonly weight: Int32Array) {}

  push(node: number): void {
    const { heap, weight } = this;
    let zz = ++this.size;
    while (weight[node] < weight[heap[zz >> 1]]) {
      heap[zz] = heap[zz >> 1];
      zz >>= 1;
    }
    heap[zz] = node;
  }

  pop(): number {
    const { heap, weight } = this;
    const top = heap[1];
    heap[1] = heap[this.size--];
    let zz = 1;
    const tmp = heap[zz];
    for (;;) {
      let yy = zz << 1;
      if (yy > this.size) break;
      if (yy < this.size && weight[heap[yy + 1]] < weight[heap[yy]]) yy++;
      if (weight[tmp] < weight[heap[yy]]) break;
      heap[zz] = heap[yy];
      zz = yy;
    }
    heap[zz] = tmp;
    return top;
  }
}

/** `BZ2_hbMakeCodeLengths`: code lengths of at most `maxLen` bits for the frequencies, scaling them down until fit. */
export function makeCodeLengths(len: Uint8Array, freq: Int32Array, alphaSize: number, maxLen: number): void {
  const weight = new Int32Array(BZ_MAX_ALPHA_SIZE * 2);
  for (let i = 0; i < alphaSize; i++) weight[i + 1] = (freq[i] === 0 ? 1 : freq[i]) << 8;
  while (!treeLengths(len, weight, alphaSize, maxLen)) {
    for (let i = 1; i <= alphaSize; i++) weight[i] = (1 + Math.trunc((weight[i] >> 8) / 2)) << 8;
  }
}

/** Builds the Huffman tree of the weights, writing its code lengths; returns whether they all fit `maxLen`. */
function treeLengths(len: Uint8Array, weight: Int32Array, alphaSize: number, maxLen: number): boolean {
  const parent = new Int32Array(BZ_MAX_ALPHA_SIZE * 2);
  const heap = new NodeHeap(weight);
  let nNodes = alphaSize;
  weight[0] = 0;
  parent[0] = -2;
  for (let i = 1; i <= alphaSize; i++) {
    parent[i] = -1;
    heap.push(i);
  }
  while (heap.size > 1) {
    const n1 = heap.pop();
    const n2 = heap.pop();
    nNodes++;
    parent[n1] = nNodes;
    parent[n2] = nNodes;
    const [w1, w2] = [weight[n1], weight[n2]];
    weight[nNodes] = ((w1 & 0xff_ff_ff_00) + (w2 & 0xff_ff_ff_00)) | (1 + Math.max(w1 & 0xff, w2 & 0xff));
    parent[nNodes] = -1;
    heap.push(nNodes);
  }
  let fits = true;
  for (let i = 1; i <= alphaSize; i++) {
    let j = 0;
    for (let k = i; parent[k] >= 0; k = parent[k]) j++;
    len[i - 1] = j;
    if (j > maxLen) fits = false;
  }
  return fits;
}

/** `BZ2_hbAssignCodes`: the canonical codes of the lengths. */
export function assignCodes(code: Int32Array, length: Uint8Array, alphaSize: number): void {
  const lengths = length.subarray(0, alphaSize);
  let vec = 0;
  for (let n = Math.min(...lengths); n <= Math.max(...lengths); n++) {
    for (let i = 0; i < alphaSize; i++) if (length[i] === n) code[i] = vec++;
    vec <<= 1;
  }
}

export interface DecodeTable {
  limit: Int32Array;
  base: Int32Array;
  perm: Int32Array;
  minLen: number;
}

/** `BZ2_hbCreateDecodeTables`. */
export function createDecodeTable(length: Uint8Array): DecodeTable {
  const minLen = Math.min(...length);
  const maxLen = Math.max(...length);
  const perm = new Int32Array(BZ_MAX_ALPHA_SIZE);
  const base = new Int32Array(BZ_MAX_CODE_LEN);
  const limit = new Int32Array(BZ_MAX_CODE_LEN);
  let pp = 0;
  for (let i = minLen; i <= maxLen; i++) for (const [j, each] of length.entries()) if (each === i) perm[pp++] = j;
  for (const each of length) base[each + 1]++;
  for (let i = 1; i < BZ_MAX_CODE_LEN; i++) base[i] += base[i - 1];
  let vec = 0;
  for (let i = minLen; i <= maxLen; i++) {
    vec += base[i + 1] - base[i];
    limit[i] = vec - 1;
    vec <<= 1;
  }
  for (let i = minLen + 1; i <= maxLen; i++) base[i] = ((limit[i - 1] + 1) << 1) - base[i];
  return { limit, base, perm, minLen };
}
