// code-gauge-allow-file fileNcss 460 -- Transcribes liblzma 5.8.4 C sources together, which read best side by side with them.
// The LZ encoder of liblzma 5.8.4 (`lz_encoder.c`, `lz_encoder_mf.c`): the window that the filters before it fill, and
// its hash chain and binary tree match finders. The window, hash table, and tree grow as they are used rather than being
// allocated at their full size, charging the runtime budget before each host allocation.
import { currentRuntime } from '../runtimeContext';
import { CRC32_TABLE } from './xzCheck';
import {
  type Coder,
  LZMA_MF_BT2,
  LZMA_MF_BT3,
  LZMA_MF_BT4,
  LZMA_MF_HC3,
  LZMA_MF_HC4,
  LZMA_OK,
  LZMA_RUN,
  LZMA_STREAM_END,
  LZMA_SYNC_FLUSH,
  type Pos,
  UINT32_MAX,
} from './xzCommon';

const HASH_2_SIZE = 1 << 10;
const HASH_3_SIZE = 1 << 16;
const HASH_2_MASK = HASH_2_SIZE - 1;
const HASH_3_MASK = HASH_3_SIZE - 1;
const FIX_3_HASH_SIZE = HASH_2_SIZE;
const FIX_4_HASH_SIZE = HASH_2_SIZE + HASH_3_SIZE;
/** `LZMA_MEMCMPLEN_EXTRA`: how many bytes after the data are kept zero. */
const MEMCMPLEN_EXTRA = 8;

/** `lzma_lz_options`. */
export interface LzOptions {
  beforeSize: number;
  dictSize: number;
  afterSize: number;
  matchLenMax: number;
  niceLen: number;
  matchFinder: number;
  depth: number;
}

/** What the LZ encoder drives: `lzma_lz_encoder`'s `code`. */
export interface LzCoder {
  code(mf: MatchFinder, out: Uint8Array, outPos: Pos, outSize: number): number;
}

export const hashBytesOf = (matchFinder: number): number => matchFinder & 0x0f;

function memcmplen(buf: Uint8Array, a: number, b: number, start: number, limit: number): number {
  let len = start;
  while (len < limit && buf[a + len] === buf[b + len]) len++;
  return len;
}

const HASH_PAGE_SHIFT = 10;
const HASH_PAGE_SIZE = 1 << HASH_PAGE_SHIFT;
const HASH_PAGE_MASK = HASH_PAGE_SIZE - 1;

function chargeBytes(bytes: number): void {
  if (bytes > 0) currentRuntime().allocate(Math.ceil(bytes / 8));
}

/** A `Uint32Array` hash table allocated in 1024-entry pages on first write so large `dict_size` tables stay sparse. */
class SparseHash {
  private readonly pages = new Map<number, Uint32Array>();

  get(index: number): number {
    return this.pages.get(index >>> HASH_PAGE_SHIFT)?.[index & HASH_PAGE_MASK] ?? 0;
  }

  set(index: number, value: number): void {
    const pageIndex = index >>> HASH_PAGE_SHIFT;
    let page = this.pages.get(pageIndex);
    if (!page) {
      chargeBytes(HASH_PAGE_SIZE * 4);
      page = new Uint32Array(HASH_PAGE_SIZE);
      this.pages.set(pageIndex, page);
    }
    page[index & HASH_PAGE_MASK] = value;
  }

  normalize(subvalue: number): void {
    for (const page of this.pages.values()) {
      for (let i = 0; i < page.length; i++) page[i] = page[i] <= subvalue ? 0 : page[i] - subvalue;
    }
  }
}

/** `lzma_mf`. */
export class MatchFinder {
  buffer = new Uint8Array(0);
  size = 0;
  keepSizeBefore = 0;
  keepSizeAfter = 0;
  offset = 0;
  readPos = 0;
  readAhead = 0;
  readLimit = 0;
  writePos = 0;
  pending = 0;
  hash = new SparseHash();
  son = new Uint32Array(0);
  cyclicPos = 0;
  cyclicSize = 0;
  hashMask = 0;
  depth = 0;
  niceLen = 0;
  matchLenMax = 0;
  action = LZMA_RUN;
  hashCount = 0;
  sonsCount = 0;
  kind = 0;
  readonly matchLens = new Uint32Array(274);
  readonly matchDists = new Uint32Array(274);
  matchesCount = 0;

  /** `lz_encoder_prepare`, which reports whether the options are invalid. */
  // code-gauge-allow functionNcss 43 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  // code-gauge-allow functionCognitiveComplexity 16 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  prepare(options: LzOptions): boolean {
    const { dictSize } = options;
    if (dictSize < 4096 || dictSize > 2 ** 30 + 2 ** 29 || options.niceLen > options.matchLenMax) return true;
    this.keepSizeBefore = options.beforeSize + dictSize;
    this.keepSizeAfter = options.afterSize + options.matchLenMax;
    let reserve = Math.floor(dictSize / 2);
    if (reserve > 2 ** 30) reserve = Math.floor(reserve / 2);
    reserve += Math.floor((options.beforeSize + options.matchLenMax + options.afterSize) / 2) + (1 << 19);
    this.size = this.keepSizeBefore + reserve + this.keepSizeAfter;
    this.matchLenMax = options.matchLenMax;
    this.niceLen = options.niceLen;
    this.cyclicSize = dictSize + 1;
    const kind = options.matchFinder;
    if (![LZMA_MF_HC3, LZMA_MF_HC4, LZMA_MF_BT2, LZMA_MF_BT3, LZMA_MF_BT4].includes(kind)) return true;
    this.kind = kind;
    const hashBytes = hashBytesOf(kind);
    const isBt = (kind & 0x10) !== 0;
    let hs: number;
    if (hashBytes === 2) {
      hs = 0xff_ff;
    } else {
      hs = dictSize - 1;
      hs |= hs >>> 1;
      hs |= hs >>> 2;
      hs |= hs >>> 4;
      hs |= hs >>> 8;
      hs >>>= 1;
      hs |= 0xff_ff;
      if (hs > 1 << 24) hs = hashBytes === 3 ? (1 << 24) - 1 : hs >>> 1;
    }
    this.hashMask = hs;
    hs++;
    if (hashBytes > 2) hs += HASH_2_SIZE;
    if (hashBytes > 3) hs += HASH_3_SIZE;
    this.hashCount = hs;
    this.sonsCount = isBt ? this.cyclicSize * 2 : this.cyclicSize;
    this.depth = options.depth || (isBt ? 16 + Math.floor(this.niceLen / 2) : 4 + Math.floor(this.niceLen / 4));
    return false;
  }

  /** `lz_encoder_init`, without a preset dictionary. */
  init(): void {
    const initialBuffer = Math.min(this.size, 1 << 14) + MEMCMPLEN_EXTRA;
    const initialSon = Math.min(this.sonsCount, 1 << 12);
    chargeBytes(initialBuffer + initialSon * 4);
    this.buffer = new Uint8Array(initialBuffer);
    this.offset = this.cyclicSize;
    this.readPos = 0;
    this.readAhead = 0;
    this.readLimit = 0;
    this.writePos = 0;
    this.pending = 0;
    this.hash = new SparseHash();
    this.son = new Uint32Array(initialSon);
    this.cyclicPos = 0;
    this.action = LZMA_RUN;
  }

  get avail(): number {
    return this.writePos - this.readPos;
  }

  /** Grows the window so that `end` and the zeroed bytes after it fit. */
  reserve(end: number): void {
    if (end + MEMCMPLEN_EXTRA <= this.buffer.length) return;
    const nextLength = Math.min(Math.max(end, this.buffer.length * 2), this.size) + MEMCMPLEN_EXTRA;
    chargeBytes(nextLength - this.buffer.length);
    const grown = new Uint8Array(nextLength);
    grown.set(this.buffer.subarray(0, this.writePos));
    this.buffer = grown;
  }

  /** `mf_skip`. */
  skipAhead(amount: number): void {
    if (amount !== 0) {
      this.skip(amount);
      this.readAhead += amount;
    }
  }

  /** `lzma_mf_find`: finds the matches into `matchLens`/`matchDists` and returns the longest length. */
  find(): number {
    const count = this.findRaw();
    let lenBest = 0;
    if (count > 0) {
      lenBest = this.matchLens[count - 1];
      if (lenBest === this.niceLen) {
        const limit = Math.min(this.avail + 1, this.matchLenMax);
        const p1 = this.readPos - 1;
        lenBest = memcmplen(this.buffer, p1, p1 - this.matchDists[count - 1] - 1, lenBest, limit);
      }
    }
    this.matchesCount = count;
    this.readAhead++;
    return lenBest;
  }

  skip(amount: number): void {
    let left = amount;
    do {
      if (!this.skipOne()) this.movePending();
    } while (--left !== 0);
  }

  private findRaw(): number {
    const isBt = (this.kind & 0x10) !== 0;
    const lenMin = hashBytesOf(this.kind);
    let lenLimit = this.avail;
    if (this.niceLen <= lenLimit) {
      lenLimit = this.niceLen;
    } else if (lenLimit < lenMin || (isBt && this.action === LZMA_SYNC_FLUSH)) {
      this.movePending();
      return 0;
    }
    this.reserveSon();
    const cur = this.readPos;
    const pos = (this.readPos + this.offset) >>> 0;
    if (this.kind === LZMA_MF_BT2) return this.bt2Find(lenLimit, pos, cur);
    if (hashBytesOf(this.kind) === 3) return this.find3(lenLimit, pos, cur, isBt);
    return this.find4(lenLimit, pos, cur, isBt);
  }

  private bt2Find(lenLimit: number, pos: number, cur: number): number {
    const hashValue = this.buffer[cur] | (this.buffer[cur + 1] << 8);
    const curMatch = this.hash.get(hashValue);
    this.hash.set(hashValue, pos);
    return this.chainFind(true, lenLimit, pos, cur, curMatch, 0, 1);
  }

  private find3(lenLimit: number, pos: number, cur: number, isBt: boolean): number {
    const { buffer, hash } = this;
    const temp = CRC32_TABLE[buffer[cur]] ^ buffer[cur + 1];
    const hash2Value = temp & HASH_2_MASK;
    const hashValue = (temp ^ (buffer[cur + 2] << 8)) & this.hashMask;
    const delta2 = (pos - hash.get(hash2Value)) >>> 0;
    const curMatch = hash.get(FIX_3_HASH_SIZE + hashValue);
    hash.set(hash2Value, pos);
    hash.set(FIX_3_HASH_SIZE + hashValue, pos);
    let lenBest = 2;
    let count = 0;
    if (delta2 < this.cyclicSize && buffer[cur - delta2] === buffer[cur]) {
      lenBest = memcmplen(buffer, cur - delta2, cur, lenBest, lenLimit);
      this.matchLens[0] = lenBest;
      this.matchDists[0] = delta2 - 1;
      count = 1;
      if (lenBest === lenLimit) {
        this.chainSkip(isBt, lenLimit, pos, cur, curMatch);
        return 1;
      }
    }
    return this.chainFind(isBt, lenLimit, pos, cur, curMatch, count, lenBest);
  }

  private find4(lenLimit: number, pos: number, cur: number, isBt: boolean): number {
    const { buffer, hash } = this;
    const temp = CRC32_TABLE[buffer[cur]] ^ buffer[cur + 1];
    const hash2Value = temp & HASH_2_MASK;
    const hash3Value = (temp ^ (buffer[cur + 2] << 8)) & HASH_3_MASK;
    const hashValue = (temp ^ (buffer[cur + 2] << 8) ^ (CRC32_TABLE[buffer[cur + 3]] << 5)) & this.hashMask;
    let delta2 = (pos - hash.get(hash2Value)) >>> 0;
    const delta3 = (pos - hash.get(FIX_3_HASH_SIZE + hash3Value)) >>> 0;
    const curMatch = hash.get(FIX_4_HASH_SIZE + hashValue);
    hash.set(hash2Value, pos);
    hash.set(FIX_3_HASH_SIZE + hash3Value, pos);
    hash.set(FIX_4_HASH_SIZE + hashValue, pos);
    let lenBest = 1;
    let count = 0;
    if (delta2 < this.cyclicSize && buffer[cur - delta2] === buffer[cur]) {
      lenBest = 2;
      this.matchLens[0] = 2;
      this.matchDists[0] = delta2 - 1;
      count = 1;
    }
    if (delta2 !== delta3 && delta3 < this.cyclicSize && buffer[cur - delta3] === buffer[cur]) {
      lenBest = 3;
      this.matchDists[count++] = delta3 - 1;
      delta2 = delta3;
    }
    if (count !== 0) {
      lenBest = memcmplen(buffer, cur - delta2, cur, lenBest, lenLimit);
      this.matchLens[count - 1] = lenBest;
      if (lenBest === lenLimit) {
        this.chainSkip(isBt, lenLimit, pos, cur, curMatch);
        return count;
      }
    }
    return this.chainFind(isBt, lenLimit, pos, cur, curMatch, count, Math.max(lenBest, 3));
  }

  /** `hc_find`/`bt_find`, which also move to the next position. */
  // code-gauge-allow functionParameterCount 7 -- Takes the buffers and positions of a liblzma code function separately, as the C does.
  private chainFind(
    isBt: boolean,
    lenLimit: number,
    pos: number,
    cur: number,
    curMatch: number,
    count: number,
    lenBest: number
  ): number {
    const result = isBt
      ? this.btFindFunc(lenLimit, pos, cur, curMatch, count, lenBest)
      : this.hcFindFunc(lenLimit, pos, cur, curMatch, count, lenBest);
    this.movePos();
    return result;
  }

  private chainSkip(isBt: boolean, lenLimit: number, pos: number, cur: number, curMatch: number): void {
    if (isBt) this.btSkipFunc(lenLimit, pos, cur, curMatch);
    else this.son[this.cyclicPos] = curMatch;
    this.movePos();
  }

  /** One position of the `*_skip` functions; false when too little data is left. */
  // code-gauge-allow functionNcss 36 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  private skipOne(): boolean {
    const isBt = (this.kind & 0x10) !== 0;
    const hashBytes = hashBytesOf(this.kind);
    let lenLimit = this.avail;
    if (isBt) {
      if (this.niceLen <= lenLimit) lenLimit = this.niceLen;
      else if (lenLimit < hashBytes || this.action === LZMA_SYNC_FLUSH) return false;
    } else if (lenLimit < hashBytes) {
      return false;
    }
    this.reserveSon();
    const { buffer, hash } = this;
    const cur = this.readPos;
    const pos = (this.readPos + this.offset) >>> 0;
    let curMatch: number;
    if (hashBytes === 2) {
      const hashValue = buffer[cur] | (buffer[cur + 1] << 8);
      curMatch = hash.get(hashValue);
      hash.set(hashValue, pos);
    } else {
      const temp = CRC32_TABLE[buffer[cur]] ^ buffer[cur + 1];
      hash.set(temp & HASH_2_MASK, pos);
      if (hashBytes === 3) {
        const hashValue = (temp ^ (buffer[cur + 2] << 8)) & this.hashMask;
        curMatch = hash.get(FIX_3_HASH_SIZE + hashValue);
        hash.set(FIX_3_HASH_SIZE + hashValue, pos);
      } else {
        hash.set(FIX_3_HASH_SIZE + ((temp ^ (buffer[cur + 2] << 8)) & HASH_3_MASK), pos);
        const hashValue = (temp ^ (buffer[cur + 2] << 8) ^ (CRC32_TABLE[buffer[cur + 3]] << 5)) & this.hashMask;
        curMatch = hash.get(FIX_4_HASH_SIZE + hashValue);
        hash.set(FIX_4_HASH_SIZE + hashValue, pos);
      }
    }
    this.chainSkip(isBt, lenLimit, pos, cur, curMatch);
    return true;
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  private hcFindFunc(
    lenLimit: number,
    pos: number,
    cur: number,
    startMatch: number,
    startCount: number,
    startLenBest: number
  ): number {
    const { buffer, son, cyclicPos, cyclicSize } = this;
    let curMatch = startMatch;
    let count = startCount;
    let lenBest = startLenBest;
    let depth = this.depth;
    son[cyclicPos] = curMatch;
    for (;;) {
      const delta = (pos - curMatch) >>> 0;
      if (depth-- === 0 || delta >= cyclicSize) return count;
      const pb = cur - delta;
      curMatch = son[cyclicPos - delta + (delta > cyclicPos ? cyclicSize : 0)];
      if (buffer[pb + lenBest] === buffer[cur + lenBest] && buffer[pb] === buffer[cur]) {
        const len = memcmplen(buffer, pb, cur, 1, lenLimit);
        if (lenBest < len) {
          lenBest = len;
          this.matchLens[count] = len;
          this.matchDists[count++] = delta - 1;
          if (len === lenLimit) return count;
        }
      }
    }
  }

  // code-gauge-allow functionNcss 39 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  // code-gauge-allow functionCognitiveComplexity 18 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  private btFindFunc(
    lenLimit: number,
    pos: number,
    cur: number,
    startMatch: number,
    startCount: number,
    startLenBest: number
  ): number {
    const { buffer, son, cyclicPos, cyclicSize } = this;
    let curMatch = startMatch;
    let count = startCount;
    let lenBest = startLenBest;
    let depth = this.depth;
    let ptr0 = cyclicPos * 2 + 1;
    let ptr1 = cyclicPos * 2;
    let len0 = 0;
    let len1 = 0;
    for (;;) {
      const delta = (pos - curMatch) >>> 0;
      if (depth-- === 0 || delta >= cyclicSize) {
        son[ptr0] = 0;
        son[ptr1] = 0;
        return count;
      }
      const pair = (cyclicPos - delta + (delta > cyclicPos ? cyclicSize : 0)) * 2;
      const pb = cur - delta;
      let len = Math.min(len0, len1);
      if (buffer[pb + len] === buffer[cur + len]) {
        len = memcmplen(buffer, pb, cur, len + 1, lenLimit);
        if (lenBest < len) {
          lenBest = len;
          this.matchLens[count] = len;
          this.matchDists[count++] = delta - 1;
          if (len === lenLimit) {
            son[ptr1] = son[pair];
            son[ptr0] = son[pair + 1];
            return count;
          }
        }
      }
      if (buffer[pb + len] < buffer[cur + len]) {
        son[ptr1] = curMatch;
        ptr1 = pair + 1;
        curMatch = son[ptr1];
        len1 = len;
      } else {
        son[ptr0] = curMatch;
        ptr0 = pair;
        curMatch = son[ptr0];
        len0 = len;
      }
    }
  }

  // code-gauge-allow functionNcss 33 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  private btSkipFunc(lenLimit: number, pos: number, cur: number, startMatch: number): void {
    const { buffer, son, cyclicPos, cyclicSize } = this;
    let curMatch = startMatch;
    let depth = this.depth;
    let ptr0 = cyclicPos * 2 + 1;
    let ptr1 = cyclicPos * 2;
    let len0 = 0;
    let len1 = 0;
    for (;;) {
      const delta = (pos - curMatch) >>> 0;
      if (depth-- === 0 || delta >= cyclicSize) {
        son[ptr0] = 0;
        son[ptr1] = 0;
        return;
      }
      const pair = (cyclicPos - delta + (delta > cyclicPos ? cyclicSize : 0)) * 2;
      const pb = cur - delta;
      let len = Math.min(len0, len1);
      if (buffer[pb + len] === buffer[cur + len]) {
        len = memcmplen(buffer, pb, cur, len + 1, lenLimit);
        if (len === lenLimit) {
          son[ptr1] = son[pair];
          son[ptr0] = son[pair + 1];
          return;
        }
      }
      if (buffer[pb + len] < buffer[cur + len]) {
        son[ptr1] = curMatch;
        ptr1 = pair + 1;
        curMatch = son[ptr1];
        len1 = len;
      } else {
        son[ptr0] = curMatch;
        ptr0 = pair;
        curMatch = son[ptr0];
        len0 = len;
      }
    }
  }

  private reserveSon(): void {
    const end = (this.kind & 0x10 ? this.cyclicPos * 2 + 2 : this.cyclicPos + 1) + 1;
    if (end <= this.son.length) return;
    const nextLength = Math.min(Math.max(end, this.son.length * 2), this.sonsCount);
    chargeBytes((nextLength - this.son.length) * 4);
    const grown = new Uint32Array(nextLength);
    grown.set(this.son);
    this.son = grown;
  }

  private movePos(): void {
    if (++this.cyclicPos === this.cyclicSize) this.cyclicPos = 0;
    ++this.readPos;
    if (this.readPos + this.offset === UINT32_MAX) this.normalize();
  }

  private movePending(): void {
    ++this.readPos;
    ++this.pending;
  }

  private normalize(): void {
    const subvalue = UINT32_MAX - this.cyclicSize;
    this.hash.normalize(subvalue);
    for (let i = 0; i < this.son.length; i++) this.son[i] = this.son[i] <= subvalue ? 0 : this.son[i] - subvalue;
    this.offset -= subvalue;
  }
}

/** The LZ encoder's `lzma_coder`: the window, filled from the input or the filters before it. */
export class LzEncoder implements Coder {
  constructor(
    readonly mf: MatchFinder,
    private readonly lz: LzCoder,
    private readonly next: Coder | undefined
  ) {}

  // code-gauge-allow functionParameterCount 7 -- Takes the buffers and positions of a liblzma code function separately, as the C does.
  code(
    input: Uint8Array,
    inPos: Pos,
    inSize: number,
    out: Uint8Array,
    outPos: Pos,
    outSize: number,
    action: number
  ): number {
    const { mf } = this;
    while (outPos.value < outSize && (inPos.value < inSize || action !== LZMA_RUN)) {
      if (mf.action === LZMA_RUN && mf.readPos >= mf.readLimit) {
        const ret = this.fillWindow(input, inPos, inSize, action);
        if (ret !== LZMA_OK) return ret;
      }
      const ret = this.lz.code(mf, out, outPos, outSize);
      if (ret !== LZMA_OK) {
        mf.action = LZMA_RUN;
        return ret;
      }
    }
    return LZMA_OK;
  }

  // code-gauge-allow functionNcss 31 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  private fillWindow(input: Uint8Array, inPos: Pos, inSize: number, action: number): number {
    const { mf } = this;
    if (mf.readPos >= mf.size - mf.keepSizeAfter) this.moveWindow();
    const writePos = { value: mf.writePos };
    let ret: number;
    // The filters before see as much room as the window has, but no more than the input can fill.
    const end = Math.min(mf.size, mf.writePos + (inSize - inPos.value) + 4096);
    mf.reserve(end);
    if (this.next === undefined) {
      const size = Math.min(inSize - inPos.value, end - writePos.value);
      mf.buffer.set(input.subarray(inPos.value, inPos.value + size), writePos.value);
      inPos.value += size;
      writePos.value += size;
      ret = action !== LZMA_RUN && inPos.value === inSize ? LZMA_STREAM_END : LZMA_OK;
    } else {
      ret = this.next.code(input, inPos, inSize, mf.buffer, writePos, end, action);
    }
    mf.writePos = writePos.value;
    mf.buffer.fill(0, mf.writePos, mf.writePos + MEMCMPLEN_EXTRA);
    if (ret === LZMA_STREAM_END) {
      ret = LZMA_OK;
      mf.action = action;
      mf.readLimit = mf.writePos;
    } else if (mf.writePos > mf.keepSizeAfter) {
      mf.readLimit = mf.writePos - mf.keepSizeAfter;
    }
    if (mf.pending > 0 && mf.readPos < mf.readLimit) {
      const { pending } = mf;
      mf.pending = 0;
      mf.readPos -= pending;
      mf.skip(pending);
    }
    return ret;
  }

  private moveWindow(): void {
    const { mf } = this;
    const moveOffset = (mf.readPos - mf.keepSizeBefore) & ~15;
    mf.buffer.copyWithin(0, moveOffset, mf.writePos);
    mf.offset += moveOffset;
    mf.readPos -= moveOffset;
    mf.readLimit -= moveOffset;
    mf.writePos -= moveOffset;
  }
}
