// zlib 1.2.12's trees.c: the Huffman coding of deflate's blocks, transcribed so that output matches zlib's byte for byte.

export const LENGTH_CODES = 29;
export const LITERALS = 256;
export const L_CODES = LITERALS + 1 + LENGTH_CODES;
export const D_CODES = 30;
const BL_CODES = 19;
const HEAP_SIZE = 2 * L_CODES + 1;
const MAX_BITS = 15;
const MAX_BL_BITS = 7;
const END_BLOCK = 256;
const REP_3_6 = 16;
const REPZ_3_10 = 17;
const REPZ_11_138 = 18;
const STORED_BLOCK = 0;
const STATIC_TREES = 1;
const DYN_TREES = 2;
export const Z_FIXED = 4;

const EXTRA_LBITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const EXTRA_DBITS = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const EXTRA_BLBITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7];
const BL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A tree as zlib lays out `ct_data`: `[freq or code, dad or len]` pairs, whose unions the algorithms rely on. */
type Tree = Uint16Array;

interface StaticDesc {
  tree: Tree | undefined;
  extra: readonly number[];
  base: number;
  elems: number;
  maxLength: number;
}

interface TreeDesc {
  tree: Tree;
  maxCode: number;
  stat: StaticDesc;
}

const lengthCode = new Uint8Array(256);
const distCode = new Uint8Array(512);
const baseLength = new Int32Array(LENGTH_CODES);
const baseDist = new Int32Array(D_CODES);
const staticLtree: Tree = new Uint16Array((L_CODES + 2) * 2);
const staticDtree: Tree = new Uint16Array(D_CODES * 2);

initStaticTables();

const STATIC_L_DESC: StaticDesc = {
  tree: staticLtree,
  extra: EXTRA_LBITS,
  base: LITERALS + 1,
  elems: L_CODES,
  maxLength: MAX_BITS,
};
const STATIC_D_DESC: StaticDesc = {
  tree: staticDtree,
  extra: EXTRA_DBITS,
  base: 0,
  elems: D_CODES,
  maxLength: MAX_BITS,
};
const STATIC_BL_DESC: StaticDesc = {
  tree: undefined,
  extra: EXTRA_BLBITS,
  base: 0,
  elems: BL_CODES,
  maxLength: MAX_BL_BITS,
};

function initStaticTables(): void {
  let length = 0;
  let code = 0;
  for (code = 0; code < LENGTH_CODES - 1; code++) {
    baseLength[code] = length;
    for (let n = 0; n < 1 << EXTRA_LBITS[code]; n++) lengthCode[length++] = code;
  }
  lengthCode[length - 1] = code;
  let dist = 0;
  for (code = 0; code < 16; code++) {
    baseDist[code] = dist;
    for (let n = 0; n < 1 << EXTRA_DBITS[code]; n++) distCode[dist++] = code;
  }
  dist >>= 7;
  for (; code < D_CODES; code++) {
    baseDist[code] = dist << 7;
    for (let n = 0; n < 1 << (EXTRA_DBITS[code] - 7); n++) distCode[256 + dist++] = code;
  }
  const blCount = new Uint16Array(MAX_BITS + 1);
  let n = 0;
  for (const [last, bits] of [
    [143, 8],
    [255, 9],
    [279, 7],
    [287, 8],
  ]) {
    for (; n <= last; n++) {
      staticLtree[n * 2 + 1] = bits;
      blCount[bits]++;
    }
  }
  genCodes(staticLtree, L_CODES + 1, blCount);
  for (n = 0; n < D_CODES; n++) {
    staticDtree[n * 2 + 1] = 5;
    staticDtree[n * 2] = biReverse(n, 5);
  }
}

function genCodes(tree: Tree, maxCode: number, blCount: Uint16Array): void {
  const nextCode = new Uint16Array(MAX_BITS + 1);
  let code = 0;
  for (let bits = 1; bits <= MAX_BITS; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  for (let n = 0; n <= maxCode; n++) {
    const len = tree[n * 2 + 1];
    if (len !== 0) tree[n * 2] = biReverse(nextCode[len]++, len);
  }
}

function biReverse(code: number, len: number): number {
  let result = 0;
  let value = code;
  for (let index = 0; index < len; index++) {
    result = (result << 1) | (value & 1);
    value >>>= 1;
  }
  return result;
}

const dCode = (dist: number): number => (dist < 256 ? distCode[dist] : distCode[256 + (dist >> 7)]);

/** The block coder of one deflate stream: the bit buffer, the pending output and the symbols of the current block. */
export class TreeCoder {
  readonly pendingBuf: Uint8Array;
  pending = 0;
  pendingOut = 0;
  readonly symBuf: Uint8Array;
  symNext = 0;
  readonly symEnd: number;
  biBuf = 0;
  biValid = 0;
  optLen = 0;
  staticLen = 0;
  private readonly dynLtree: Tree = new Uint16Array(HEAP_SIZE * 2);
  private readonly dynDtree: Tree = new Uint16Array((2 * D_CODES + 1) * 2);
  private readonly blTree: Tree = new Uint16Array((2 * BL_CODES + 1) * 2);
  private readonly lDesc: TreeDesc = { tree: this.dynLtree, maxCode: 0, stat: STATIC_L_DESC };
  private readonly dDesc: TreeDesc = { tree: this.dynDtree, maxCode: 0, stat: STATIC_D_DESC };
  private readonly blDesc: TreeDesc = { tree: this.blTree, maxCode: 0, stat: STATIC_BL_DESC };
  private readonly blCount = new Uint16Array(MAX_BITS + 1);
  private readonly heap = new Int32Array(HEAP_SIZE);
  private heapLen = 0;
  private heapMax = 0;
  private readonly depth = new Uint8Array(HEAP_SIZE);

  constructor(litBufsize: number) {
    this.pendingBuf = new Uint8Array(litBufsize * 4);
    this.symBuf = new Uint8Array(litBufsize * 3);
    this.symEnd = (litBufsize - 1) * 3;
    this.initBlock();
  }

  /** Copies another coder's whole state, as deflateCopy does. */
  copyFrom(other: TreeCoder): void {
    this.pendingBuf.set(other.pendingBuf);
    this.symBuf.set(other.symBuf);
    this.dynLtree.set(other.dynLtree);
    this.dynDtree.set(other.dynDtree);
    this.blTree.set(other.blTree);
    this.lDesc.maxCode = other.lDesc.maxCode;
    this.dDesc.maxCode = other.dDesc.maxCode;
    this.blDesc.maxCode = other.blDesc.maxCode;
    for (const key of ['pending', 'pendingOut', 'symNext', 'biBuf', 'biValid', 'optLen', 'staticLen'] as const) {
      this[key] = other[key];
    }
  }

  reset(): void {
    this.biBuf = 0;
    this.biValid = 0;
    this.initBlock();
  }

  putByte(value: number): void {
    this.pendingBuf[this.pending++] = value & 0xff;
  }

  putShortMSB(value: number): void {
    this.putByte(value >> 8);
    this.putByte(value);
  }

  /** Records a literal, returning whether the block must be flushed. */
  tallyLit(literal: number): boolean {
    this.symBuf[this.symNext++] = 0;
    this.symBuf[this.symNext++] = 0;
    this.symBuf[this.symNext++] = literal;
    this.dynLtree[literal * 2]++;
    return this.symNext === this.symEnd;
  }

  /** Records a match of `length + 3` bytes `distance` back, returning whether the block must be flushed. */
  tallyDist(distance: number, length: number): boolean {
    this.symBuf[this.symNext++] = distance & 0xff;
    this.symBuf[this.symNext++] = (distance >> 8) & 0xff;
    this.symBuf[this.symNext++] = length;
    this.dynLtree[(lengthCode[length] + LITERALS + 1) * 2]++;
    this.dynDtree[dCode(distance - 1) * 2]++;
    return this.symNext === this.symEnd;
  }

  /** zlib's `_tr_flush_block`, where `buf` is the window offset of the block's bytes, or -1 when they are gone. */
  // code-gauge-allow functionParameterCount 6 -- Mirrors _tr_flush_block's parameters plus the deflate state it reads.
  flushBlock(window: Uint8Array, buf: number, storedLen: number, last: boolean, level: number, strategy: number): void {
    let optLenb: number;
    let staticLenb: number;
    let maxBlindex = 0;
    if (level > 0) {
      this.buildTree(this.lDesc);
      this.buildTree(this.dDesc);
      maxBlindex = this.buildBlTree();
      optLenb = (this.optLen + 3 + 7) >>> 3;
      staticLenb = (this.staticLen + 3 + 7) >>> 3;
      if (staticLenb <= optLenb || strategy === Z_FIXED) optLenb = staticLenb;
    } else {
      optLenb = staticLenb = storedLen + 5;
    }
    const lastBit = last ? 1 : 0;
    if (storedLen + 4 <= optLenb && buf !== -1) {
      this.storedBlock(window, buf, storedLen, last);
    } else if (staticLenb === optLenb) {
      this.sendBits((STATIC_TREES << 1) + lastBit, 3);
      this.compressBlock(staticLtree, staticDtree);
    } else {
      this.sendBits((DYN_TREES << 1) + lastBit, 3);
      this.sendAllTrees(this.lDesc.maxCode + 1, this.dDesc.maxCode + 1, maxBlindex + 1);
      this.compressBlock(this.dynLtree, this.dynDtree);
    }
    this.initBlock();
    if (last) this.biWindup();
  }

  storedBlock(source: Uint8Array | undefined, offset: number, storedLen: number, last: boolean): void {
    this.sendBits((STORED_BLOCK << 1) + (last ? 1 : 0), 3);
    this.biWindup();
    this.putShort(storedLen);
    this.putShort(~storedLen & 0xff_ff);
    if (source && storedLen) this.pendingBuf.set(source.subarray(offset, offset + storedLen), this.pending);
    this.pending += storedLen;
  }

  align(): void {
    this.sendBits(STATIC_TREES << 1, 3);
    this.sendCode(END_BLOCK, staticLtree);
    this.biFlush();
  }

  biFlush(): void {
    if (this.biValid === 16) {
      this.putShort(this.biBuf);
      this.biBuf = 0;
      this.biValid = 0;
    } else if (this.biValid >= 8) {
      this.putByte(this.biBuf);
      this.biBuf >>= 8;
      this.biValid -= 8;
    }
  }

  private initBlock(): void {
    for (let n = 0; n < L_CODES; n++) this.dynLtree[n * 2] = 0;
    for (let n = 0; n < D_CODES; n++) this.dynDtree[n * 2] = 0;
    for (let n = 0; n < BL_CODES; n++) this.blTree[n * 2] = 0;
    this.dynLtree[END_BLOCK * 2] = 1;
    this.optLen = 0;
    this.staticLen = 0;
    this.symNext = 0;
  }

  private putShort(value: number): void {
    this.putByte(value);
    this.putByte(value >> 8);
  }

  private sendBits(value: number, length: number): void {
    if (this.biValid > 16 - length) {
      this.biBuf = (this.biBuf | (value << this.biValid)) & 0xff_ff;
      this.putShort(this.biBuf);
      this.biBuf = (value & 0xff_ff) >>> (16 - this.biValid);
      this.biValid += length - 16;
    } else {
      this.biBuf = (this.biBuf | (value << this.biValid)) & 0xff_ff;
      this.biValid += length;
    }
  }

  private sendCode(code: number, tree: Tree): void {
    this.sendBits(tree[code * 2], tree[code * 2 + 1]);
  }

  private biWindup(): void {
    if (this.biValid > 8) this.putShort(this.biBuf);
    else if (this.biValid > 0) this.putByte(this.biBuf);
    this.biBuf = 0;
    this.biValid = 0;
  }

  private smaller(tree: Tree, n: number, m: number): boolean {
    return tree[n * 2] < tree[m * 2] || (tree[n * 2] === tree[m * 2] && this.depth[n] <= this.depth[m]);
  }

  private pqdownheap(tree: Tree, start: number): void {
    let k = start;
    const v = this.heap[k];
    let j = k << 1;
    while (j <= this.heapLen) {
      if (j < this.heapLen && this.smaller(tree, this.heap[j + 1], this.heap[j])) j++;
      if (this.smaller(tree, v, this.heap[j])) break;
      this.heap[k] = this.heap[j];
      k = j;
      j <<= 1;
    }
    this.heap[k] = v;
  }

  private buildTree(desc: TreeDesc): void {
    const { tree } = desc;
    const { tree: stree, elems } = desc.stat;
    let maxCode = -1;
    this.heapLen = 0;
    this.heapMax = HEAP_SIZE;
    for (let n = 0; n < elems; n++) {
      if (tree[n * 2] === 0) {
        tree[n * 2 + 1] = 0;
      } else {
        this.heap[++this.heapLen] = maxCode = n;
        this.depth[n] = 0;
      }
    }
    while (this.heapLen < 2) {
      const node = (this.heap[++this.heapLen] = maxCode < 2 ? ++maxCode : 0);
      tree[node * 2] = 1;
      this.depth[node] = 0;
      this.optLen--;
      if (stree) this.staticLen -= stree[node * 2 + 1];
    }
    desc.maxCode = maxCode;
    for (let n = this.heapLen >> 1; n >= 1; n--) this.pqdownheap(tree, n);
    this.combineNodes(tree, elems);
    this.genBitlen(desc);
    genCodes(tree, maxCode, this.blCount);
  }

  private combineNodes(tree: Tree, elems: number): void {
    let node = elems;
    do {
      const n = this.heap[1];
      this.heap[1] = this.heap[this.heapLen--];
      this.pqdownheap(tree, 1);
      const m = this.heap[1];
      this.heap[--this.heapMax] = n;
      this.heap[--this.heapMax] = m;
      tree[node * 2] = tree[n * 2] + tree[m * 2];
      this.depth[node] = Math.max(this.depth[n], this.depth[m]) + 1;
      tree[n * 2 + 1] = tree[m * 2 + 1] = node;
      this.heap[1] = node++;
      this.pqdownheap(tree, 1);
    } while (this.heapLen >= 2);
    this.heap[--this.heapMax] = this.heap[1];
  }

  private genBitlen(desc: TreeDesc): void {
    const { tree, maxCode } = desc;
    const { tree: stree, extra, base, maxLength } = desc.stat;
    let overflow = 0;
    this.blCount.fill(0);
    tree[this.heap[this.heapMax] * 2 + 1] = 0;
    let h: number;
    for (h = this.heapMax + 1; h < HEAP_SIZE; h++) {
      const n = this.heap[h];
      let bits = tree[tree[n * 2 + 1] * 2 + 1] + 1;
      if (bits > maxLength) {
        bits = maxLength;
        overflow++;
      }
      tree[n * 2 + 1] = bits;
      if (n > maxCode) continue;
      this.blCount[bits]++;
      const xbits = n >= base ? extra[n - base] : 0;
      const f = tree[n * 2];
      this.optLen += f * (bits + xbits);
      if (stree) this.staticLen += f * (stree[n * 2 + 1] + xbits);
    }
    if (overflow === 0) return;
    this.fixOverflow(desc, overflow, h);
  }

  private fixOverflow(desc: TreeDesc, initialOverflow: number, end: number): void {
    const { tree, maxCode } = desc;
    const { maxLength } = desc.stat;
    let overflow = initialOverflow;
    do {
      let bits = maxLength - 1;
      while (this.blCount[bits] === 0) bits--;
      this.blCount[bits]--;
      this.blCount[bits + 1] += 2;
      this.blCount[maxLength]--;
      overflow -= 2;
    } while (overflow > 0);
    let h = end;
    for (let bits = maxLength; bits !== 0; bits--) {
      let n = this.blCount[bits];
      while (n !== 0) {
        const m = this.heap[--h];
        if (m > maxCode) continue;
        if (tree[m * 2 + 1] !== bits) {
          this.optLen += (bits - tree[m * 2 + 1]) * tree[m * 2];
          tree[m * 2 + 1] = bits;
        }
        n--;
      }
    }
  }

  private scanTree(tree: Tree, maxCode: number): void {
    let prevlen = -1;
    let nextlen = tree[1];
    let count = 0;
    let maxCount = nextlen === 0 ? 138 : 7;
    let minCount = nextlen === 0 ? 3 : 4;
    tree[(maxCode + 1) * 2 + 1] = 0xff_ff;
    for (let n = 0; n <= maxCode; n++) {
      const curlen = nextlen;
      nextlen = tree[(n + 1) * 2 + 1];
      if (++count < maxCount && curlen === nextlen) continue;
      if (count < minCount) {
        this.blTree[curlen * 2] += count;
      } else if (curlen !== 0) {
        if (curlen !== prevlen) this.blTree[curlen * 2]++;
        this.blTree[REP_3_6 * 2]++;
      } else if (count <= 10) {
        this.blTree[REPZ_3_10 * 2]++;
      } else {
        this.blTree[REPZ_11_138 * 2]++;
      }
      count = 0;
      prevlen = curlen;
      [maxCount, minCount] = runLimits(curlen, nextlen);
    }
  }

  private sendTree(tree: Tree, maxCode: number): void {
    let prevlen = -1;
    let nextlen = tree[1];
    let count = 0;
    let maxCount = nextlen === 0 ? 138 : 7;
    let minCount = nextlen === 0 ? 3 : 4;
    for (let n = 0; n <= maxCode; n++) {
      const curlen = nextlen;
      nextlen = tree[(n + 1) * 2 + 1];
      if (++count < maxCount && curlen === nextlen) continue;
      if (count < minCount) {
        do this.sendCode(curlen, this.blTree);
        while (--count !== 0);
      } else if (curlen !== 0) {
        if (curlen !== prevlen) {
          this.sendCode(curlen, this.blTree);
          count--;
        }
        this.sendCode(REP_3_6, this.blTree);
        this.sendBits(count - 3, 2);
      } else if (count <= 10) {
        this.sendCode(REPZ_3_10, this.blTree);
        this.sendBits(count - 3, 3);
      } else {
        this.sendCode(REPZ_11_138, this.blTree);
        this.sendBits(count - 11, 7);
      }
      count = 0;
      prevlen = curlen;
      [maxCount, minCount] = runLimits(curlen, nextlen);
    }
  }

  private buildBlTree(): number {
    this.scanTree(this.dynLtree, this.lDesc.maxCode);
    this.scanTree(this.dynDtree, this.dDesc.maxCode);
    this.buildTree(this.blDesc);
    let maxBlindex: number;
    for (maxBlindex = BL_CODES - 1; maxBlindex >= 3; maxBlindex--) {
      if (this.blTree[BL_ORDER[maxBlindex] * 2 + 1] !== 0) break;
    }
    this.optLen += 3 * (maxBlindex + 1) + 5 + 5 + 4;
    return maxBlindex;
  }

  private sendAllTrees(lcodes: number, dcodes: number, blcodes: number): void {
    this.sendBits(lcodes - 257, 5);
    this.sendBits(dcodes - 1, 5);
    this.sendBits(blcodes - 4, 4);
    for (let rank = 0; rank < blcodes; rank++) this.sendBits(this.blTree[BL_ORDER[rank] * 2 + 1], 3);
    this.sendTree(this.dynLtree, lcodes - 1);
    this.sendTree(this.dynDtree, dcodes - 1);
  }

  private compressBlock(ltree: Tree, dtree: Tree): void {
    for (let sx = 0; sx < this.symNext; sx += 3) {
      let dist = this.symBuf[sx] | (this.symBuf[sx + 1] << 8);
      let lc = this.symBuf[sx + 2];
      if (dist === 0) {
        this.sendCode(lc, ltree);
        continue;
      }
      let code = lengthCode[lc];
      this.sendCode(code + LITERALS + 1, ltree);
      let extra = EXTRA_LBITS[code];
      if (extra !== 0) {
        lc -= baseLength[code];
        this.sendBits(lc, extra);
      }
      dist--;
      code = dCode(dist);
      this.sendCode(code, dtree);
      extra = EXTRA_DBITS[code];
      if (extra !== 0) this.sendBits(dist - baseDist[code], extra);
    }
    this.sendCode(END_BLOCK, ltree);
  }
}

function runLimits(curlen: number, nextlen: number): [number, number] {
  if (nextlen === 0) return [138, 3];
  if (curlen === nextlen) return [6, 3];
  return [7, 4];
}
