// code-gauge-allow-file fileNcss 659 -- Transcribes zlib 1.2.12's deflate.c, whose output depends on each of its branches.
// zlib 1.2.12's deflate.c, transcribed so that compressed data matches zlib's byte for byte, including how the
// output depends on the sizes of the input and output buffers a caller passes.
import { crc32 } from './binascii';
import { TreeCoder } from './zlibTrees';

export const Z_NO_FLUSH = 0;
export const Z_PARTIAL_FLUSH = 1;
export const Z_FULL_FLUSH = 3;
export const Z_FINISH = 4;
export const Z_BLOCK = 5;
export const Z_OK = 0;
export const Z_STREAM_END = 1;
export const Z_STREAM_ERROR = -2;
export const Z_BUF_ERROR = -5;
const Z_FILTERED = 1;
const Z_HUFFMAN_ONLY = 2;
const Z_RLE = 3;
const Z_FIXED = 4;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const MIN_LOOKAHEAD = MAX_MATCH + MIN_MATCH + 1;
const TOO_FAR = 4096;
const WIN_INIT = MAX_MATCH;
const MAX_STORED = 65_535;
const OS_CODE = 19;
const INIT_STATE = 42;
const GZIP_STATE = 57;
const BUSY_STATE = 113;
const FINISH_STATE = 666;

const enum BlockState {
  NeedMore,
  BlockDone,
  FinishStarted,
  FinishDone,
}

interface Config {
  goodLength: number;
  maxLazy: number;
  niceLength: number;
  maxChain: number;
  kind: 'stored' | 'fast' | 'slow';
}

const config = (
  goodLength: number,
  maxLazy: number,
  niceLength: number,
  maxChain: number,
  kind: Config['kind']
): Config => ({
  goodLength,
  maxLazy,
  niceLength,
  maxChain,
  kind,
});

const CONFIGURATION_TABLE: readonly Config[] = [
  config(0, 0, 0, 0, 'stored'),
  config(4, 4, 8, 4, 'fast'),
  config(4, 5, 16, 8, 'fast'),
  config(4, 6, 32, 32, 'fast'),
  config(4, 4, 16, 16, 'slow'),
  config(8, 16, 32, 32, 'slow'),
  config(8, 16, 128, 128, 'slow'),
  config(8, 32, 128, 256, 'slow'),
  config(32, 128, 258, 1024, 'slow'),
  config(32, 258, 258, 4096, 'slow'),
];

const rank = (flush: number): number => flush * 2 - (flush > 4 ? 9 : 0);

/** The input and output buffers of a z_stream, which the caller sets before each call. */
export class ZStream {
  input: Uint8Array = new Uint8Array(0);
  nextIn = 0;
  availIn = 0;
  output: Uint8Array = new Uint8Array(0);
  nextOut = 0;
  availOut = 0;
  totalIn = 0;
  totalOut = 0;
  adler = 0;
  msg: string | undefined;
}

/** One deflate stream, created with deflateInit2's parameters, which must already be valid. */
export class Deflater {
  readonly strm = new ZStream();
  private status: number;
  private wrap: number;
  private lastFlush = -2;
  private readonly wBits: number;
  private readonly wSize: number;
  private readonly wMask: number;
  private readonly window: Uint8Array;
  private readonly windowSize: number;
  private readonly prev: Uint16Array;
  private readonly head: Uint16Array;
  private insH = 0;
  private readonly hashSize: number;
  private readonly hashMask: number;
  private readonly hashShift: number;
  private blockStart = 0;
  private matchLength = MIN_MATCH - 1;
  private prevMatch = 0;
  private matchAvailable = false;
  private strstart = 0;
  private matchStart = 0;
  private lookahead = 0;
  private prevLength = MIN_MATCH - 1;
  private maxChainLength = 0;
  private maxLazyMatch = 0;
  private goodMatch = 0;
  private niceMatch = 0;
  private insert = 0;
  private highWater = 0;
  private readonly pendingBufSize: number;
  private readonly trees: TreeCoder;

  constructor(
    private readonly level: number,
    windowBits: number,
    memLevel: number,
    private readonly strategy: number
  ) {
    let bits = windowBits;
    this.wrap = 1;
    if (bits < 0) {
      this.wrap = 0;
      bits = -bits;
    } else if (bits > 15) {
      this.wrap = 2;
      bits -= 16;
    }
    if (bits === 8) bits = 9;
    this.wBits = bits;
    this.wSize = 1 << bits;
    this.wMask = this.wSize - 1;
    const hashBits = memLevel + 7;
    this.hashSize = 1 << hashBits;
    this.hashMask = this.hashSize - 1;
    this.hashShift = Math.floor((hashBits + MIN_MATCH - 1) / MIN_MATCH);
    this.window = new Uint8Array(this.wSize * 2);
    this.windowSize = 2 * this.wSize;
    this.prev = new Uint16Array(this.wSize);
    this.head = new Uint16Array(this.hashSize);
    const litBufsize = 1 << (memLevel + 6);
    this.pendingBufSize = litBufsize * 4;
    this.trees = new TreeCoder(litBufsize);
    this.status = this.wrap === 2 ? GZIP_STATE : INIT_STATE;
    this.strm.adler = this.wrap === 2 ? 0 : 1;
    this.lmInit();
  }

  /** deflateCopy: an independent stream in the same state. */
  copy(): Deflater {
    const result = Object.assign(Object.create(Deflater.prototype) as Deflater, this);
    const fields = result as unknown as Record<string, unknown>;
    fields.strm = Object.assign(new ZStream(), this.strm);
    fields.window = Uint8Array.from(this.window);
    fields.prev = Uint16Array.from(this.prev);
    fields.head = Uint16Array.from(this.head);
    fields.trees = new TreeCoder(this.pendingBufSize / 4);
    result.trees.copyFrom(this.trees);
    return result;
  }

  /** deflateSetDictionary; returns false where zlib returns Z_STREAM_ERROR. */
  // code-gauge-allow functionNcss 38 -- Transcribes zlib 1.2.12's deflate.c, whose output depends on each of its branches.
  setDictionary(dictionary: Uint8Array): boolean {
    const { wrap } = this;
    if (wrap === 2 || (wrap === 1 && this.status !== INIT_STATE) || this.lookahead) return false;
    if (wrap === 1) this.strm.adler = adler32(this.strm.adler, dictionary);
    this.wrap = 0;
    let dict = dictionary;
    if (dict.length >= this.wSize) {
      if (wrap === 0) {
        this.head.fill(0);
        this.strstart = 0;
        this.blockStart = 0;
        this.insert = 0;
      }
      dict = dict.subarray(dict.length - this.wSize);
    }
    const { input, nextIn, availIn } = this.strm;
    Object.assign(this.strm, { input: dict, nextIn: 0, availIn: dict.length });
    this.fillWindow();
    while (this.lookahead >= MIN_MATCH) {
      let str = this.strstart;
      let n = this.lookahead - (MIN_MATCH - 1);
      do {
        this.updateHash(this.window[str + MIN_MATCH - 1]);
        this.prev[str & this.wMask] = this.head[this.insH];
        this.head[this.insH] = str;
        str++;
      } while (--n);
      this.strstart = str;
      this.lookahead = MIN_MATCH - 1;
      this.fillWindow();
    }
    this.strstart += this.lookahead;
    this.blockStart = this.strstart;
    this.insert = this.lookahead;
    this.lookahead = 0;
    this.matchLength = this.prevLength = MIN_MATCH - 1;
    this.matchAvailable = false;
    Object.assign(this.strm, { input, nextIn, availIn });
    this.wrap = wrap;
    return true;
  }

  // code-gauge-allow functionNcss 32 -- Transcribes zlib 1.2.12's deflate.c, whose output depends on each of its branches.
  // code-gauge-allow functionCognitiveComplexity 16 -- Transcribes zlib 1.2.12's deflate.c, whose output depends on each of its branches.
  deflate(flush: number): number {
    const { strm } = this;
    if (this.status === FINISH_STATE && flush !== Z_FINISH) return Z_STREAM_ERROR;
    if (strm.availOut === 0) return Z_BUF_ERROR;
    const oldFlush = this.lastFlush;
    this.lastFlush = flush;
    if (this.trees.pending !== 0) {
      this.flushPending();
      if (strm.availOut === 0) {
        this.lastFlush = -1;
        return Z_OK;
      }
    } else if (strm.availIn === 0 && rank(flush) <= rank(oldFlush) && flush !== Z_FINISH) {
      return Z_BUF_ERROR;
    }
    if (this.status === FINISH_STATE && strm.availIn !== 0) return Z_BUF_ERROR;
    if (!this.writeHeader()) return Z_OK;
    const result = this.compressInput(flush);
    if (result !== undefined) return result;
    if (flush !== Z_FINISH) return Z_OK;
    if (this.wrap <= 0) return Z_STREAM_END;
    this.writeTrailer();
    this.flushPending();
    if (this.wrap > 0) this.wrap = -this.wrap;
    return this.trees.pending !== 0 ? Z_OK : Z_STREAM_END;
  }

  /** Writes the zlib or gzip header, returning false when it does not fit the output yet. */
  // code-gauge-allow functionNcss 33 -- Transcribes zlib 1.2.12's deflate.c, whose output depends on each of its branches.
  // code-gauge-allow functionCognitiveComplexity 21 -- Transcribes zlib 1.2.12's deflate.c, whose output depends on each of its branches.
  private writeHeader(): boolean {
    const trees = this.trees;
    if (this.status === INIT_STATE && this.wrap === 0) this.status = BUSY_STATE;
    if (this.status === INIT_STATE) {
      let header = (8 + ((this.wBits - 8) << 4)) << 8;
      let levelFlags = 3;
      if (this.strategy >= Z_HUFFMAN_ONLY || this.level < 2) levelFlags = 0;
      else if (this.level < 6) levelFlags = 1;
      else if (this.level === 6) levelFlags = 2;
      header |= levelFlags << 6;
      if (this.strstart !== 0) header |= 0x20;
      header += 31 - (header % 31);
      trees.putShortMSB(header);
      if (this.strstart !== 0) {
        trees.putShortMSB(this.strm.adler >>> 16);
        trees.putShortMSB(this.strm.adler & 0xff_ff);
      }
      this.strm.adler = 1;
      return this.headerWritten();
    }
    if (this.status === GZIP_STATE) {
      this.strm.adler = 0;
      for (const byte of [31, 139, 8, 0, 0, 0, 0, 0]) trees.putByte(byte);
      trees.putByte(this.level === 9 ? 2 : this.strategy >= Z_HUFFMAN_ONLY || this.level < 2 ? 4 : 0);
      trees.putByte(OS_CODE);
      return this.headerWritten();
    }
    return true;
  }

  private headerWritten(): boolean {
    this.status = BUSY_STATE;
    this.flushPending();
    if (this.trees.pending !== 0) {
      this.lastFlush = -1;
      return false;
    }
    return true;
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- Transcribes zlib 1.2.12's deflate.c, whose output depends on each of its branches.
  private compressInput(flush: number): number | undefined {
    const { strm } = this;
    if (strm.availIn === 0 && this.lookahead === 0 && (flush === Z_NO_FLUSH || this.status === FINISH_STATE)) {
      return undefined;
    }
    const bstate = this.runBlock(flush);
    if (bstate === BlockState.FinishStarted || bstate === BlockState.FinishDone) this.status = FINISH_STATE;
    if (bstate === BlockState.NeedMore || bstate === BlockState.FinishStarted) {
      if (strm.availOut === 0) this.lastFlush = -1;
      return Z_OK;
    }
    if (bstate === BlockState.BlockDone) {
      if (flush === Z_PARTIAL_FLUSH) {
        this.trees.align();
      } else if (flush !== Z_BLOCK) {
        this.trees.storedBlock(undefined, 0, 0, false);
        if (flush === Z_FULL_FLUSH) {
          this.head.fill(0);
          if (this.lookahead === 0) {
            this.strstart = 0;
            this.blockStart = 0;
            this.insert = 0;
          }
        }
      }
      this.flushPending();
      if (strm.availOut === 0) {
        this.lastFlush = -1;
        return Z_OK;
      }
    }
    return undefined;
  }

  private runBlock(flush: number): BlockState {
    if (this.level === 0) return this.deflateStored(flush);
    if (this.strategy === Z_HUFFMAN_ONLY) return this.deflateHuff(flush);
    if (this.strategy === Z_RLE) return this.deflateRle(flush);
    return CONFIGURATION_TABLE[this.level].kind === 'fast' ? this.deflateFast(flush) : this.deflateSlow(flush);
  }

  private writeTrailer(): void {
    const { trees, strm } = this;
    if (this.wrap === 2) {
      for (const value of [strm.adler, strm.totalIn]) {
        for (let shift = 0; shift < 32; shift += 8) trees.putByte(value >>> shift);
      }
    } else {
      trees.putShortMSB(strm.adler >>> 16);
      trees.putShortMSB(strm.adler & 0xff_ff);
    }
  }

  private lmInit(): void {
    this.head.fill(0);
    const table = CONFIGURATION_TABLE[this.level];
    this.maxLazyMatch = table.maxLazy;
    this.goodMatch = table.goodLength;
    this.niceMatch = table.niceLength;
    this.maxChainLength = table.maxChain;
  }

  private flushPending(): void {
    const { strm, trees } = this;
    trees.biFlush();
    const len = Math.min(trees.pending, strm.availOut);
    if (len === 0) return;
    strm.output.set(trees.pendingBuf.subarray(trees.pendingOut, trees.pendingOut + len), strm.nextOut);
    strm.nextOut += len;
    trees.pendingOut += len;
    strm.totalOut += len;
    strm.availOut -= len;
    trees.pending -= len;
    if (trees.pending === 0) trees.pendingOut = 0;
  }

  private readBuf(target: Uint8Array, offset: number, size: number): number {
    const { strm } = this;
    const len = Math.min(strm.availIn, size);
    if (len === 0) return 0;
    strm.availIn -= len;
    const chunk = strm.input.subarray(strm.nextIn, strm.nextIn + len);
    target.set(chunk, offset);
    if (this.wrap === 1) strm.adler = adler32(strm.adler, chunk);
    else if (this.wrap === 2) strm.adler = crc32(chunk, strm.adler);
    strm.nextIn += len;
    strm.totalIn += len;
    return len;
  }

  private updateHash(byte: number): void {
    this.insH = ((this.insH << this.hashShift) ^ byte) & this.hashMask;
  }

  /** INSERT_STRING: returns the previous head of the hash chain. */
  private insertString(str: number): number {
    this.updateHash(this.window[str + MIN_MATCH - 1]);
    const matchHead = (this.prev[str & this.wMask] = this.head[this.insH]);
    this.head[this.insH] = str;
    return matchHead;
  }

  private maxDist(): number {
    return this.wSize - MIN_LOOKAHEAD;
  }

  private slideHash(): void {
    const wsize = this.wSize;
    for (const table of [this.head, this.prev]) {
      for (let n = 0; n < table.length; n++) table[n] = table[n] >= wsize ? table[n] - wsize : 0;
    }
  }

  private fillWindow(): void {
    const wsize = this.wSize;
    do {
      let more = this.windowSize - this.lookahead - this.strstart;
      if (this.strstart >= wsize + this.maxDist()) {
        this.window.copyWithin(0, wsize, wsize + wsize - more);
        this.matchStart -= wsize;
        this.strstart -= wsize;
        this.blockStart -= wsize;
        if (this.insert > this.strstart) this.insert = this.strstart;
        this.slideHash();
        more += wsize;
      }
      if (this.strm.availIn === 0) break;
      this.lookahead += this.readBuf(this.window, this.strstart + this.lookahead, more);
      if (this.lookahead + this.insert >= MIN_MATCH) this.insertPending();
    } while (this.lookahead < MIN_LOOKAHEAD && this.strm.availIn !== 0);
    this.initHighWater();
  }

  private insertPending(): void {
    let str = this.strstart - this.insert;
    this.insH = this.window[str];
    this.updateHash(this.window[str + 1]);
    while (this.insert) {
      this.updateHash(this.window[str + MIN_MATCH - 1]);
      this.prev[str & this.wMask] = this.head[this.insH];
      this.head[this.insH] = str;
      str++;
      this.insert--;
      if (this.lookahead + this.insert < MIN_MATCH) break;
    }
  }

  private initHighWater(): void {
    if (this.highWater >= this.windowSize) return;
    const curr = this.strstart + this.lookahead;
    if (this.highWater < curr) {
      const init = Math.min(this.windowSize - curr, WIN_INIT);
      this.window.fill(0, curr, curr + init);
      this.highWater = curr + init;
    } else if (this.highWater < curr + WIN_INIT) {
      const init = Math.min(curr + WIN_INIT - this.highWater, this.windowSize - this.highWater);
      this.window.fill(0, this.highWater, this.highWater + init);
      this.highWater += init;
    }
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Transcribes zlib 1.2.12's deflate.c, whose output depends on each of its branches.
  private longestMatch(start: number): number {
    let curMatch = start;
    let chainLength = this.maxChainLength;
    const { window, strstart: scan } = this;
    let bestLen = this.prevLength;
    let niceMatch = this.niceMatch;
    const limit = this.strstart > this.maxDist() ? this.strstart - this.maxDist() : 0;
    if (this.prevLength >= this.goodMatch) chainLength >>= 2;
    if (niceMatch > this.lookahead) niceMatch = this.lookahead;
    do {
      const match = curMatch;
      if (
        window[match + bestLen] !== window[scan + bestLen] ||
        window[match + bestLen - 1] !== window[scan + bestLen - 1] ||
        window[match] !== window[scan] ||
        window[match + 1] !== window[scan + 1]
      ) {
        continue;
      }
      let len = 3;
      while (len < MAX_MATCH && window[scan + len] === window[match + len]) len++;
      if (len > bestLen) {
        this.matchStart = curMatch;
        bestLen = len;
        if (len >= niceMatch) break;
      }
    } while ((curMatch = this.prev[curMatch & this.wMask]) > limit && --chainLength !== 0);
    return Math.min(bestLen, this.lookahead);
  }

  /** FLUSH_BLOCK_ONLY. */
  private flushBlockOnly(last: boolean): void {
    this.trees.flushBlock(
      this.window,
      this.blockStart >= 0 ? this.blockStart : -1,
      this.strstart - this.blockStart,
      last,
      this.level,
      this.strategy
    );
    this.blockStart = this.strstart;
    this.flushPending();
  }

  /** FLUSH_BLOCK without its return: whether the output is full, so the caller must return. */
  private flushBlock(last: boolean): boolean {
    this.flushBlockOnly(last);
    return this.strm.availOut === 0;
  }

  /** The common ending of the compressing functions once the input runs out. */
  private finishBlock(flush: number): BlockState {
    if (flush === Z_FINISH) return this.flushBlock(true) ? BlockState.FinishStarted : BlockState.FinishDone;
    if (this.trees.symNext && this.flushBlock(false)) return BlockState.NeedMore;
    return BlockState.BlockDone;
  }

  /** Refills the window when the lookahead is short; returns whether to stop: need more input, or no input left. */
  private refill(flush: number, minimum: number): 'more' | 'end' | undefined {
    if (this.lookahead >= minimum) return undefined;
    this.fillWindow();
    if (this.lookahead < minimum && flush === Z_NO_FLUSH) return 'more';
    return this.lookahead === 0 ? 'end' : undefined;
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Transcribes zlib 1.2.12's deflate.c, whose output depends on each of its branches.
  private deflateFast(flush: number): BlockState {
    for (;;) {
      const stop = this.refill(flush, MIN_LOOKAHEAD);
      if (stop === 'more') return BlockState.NeedMore;
      if (stop === 'end') break;
      let hashHead = 0;
      if (this.lookahead >= MIN_MATCH) hashHead = this.insertString(this.strstart);
      if (hashHead !== 0 && this.strstart - hashHead <= this.maxDist()) this.matchLength = this.longestMatch(hashHead);
      let bflush: boolean;
      if (this.matchLength >= MIN_MATCH) {
        bflush = this.trees.tallyDist(this.strstart - this.matchStart, this.matchLength - MIN_MATCH);
        this.lookahead -= this.matchLength;
        this.advanceAfterFastMatch();
      } else {
        bflush = this.trees.tallyLit(this.window[this.strstart]);
        this.lookahead--;
        this.strstart++;
      }
      if (bflush && this.flushBlock(false)) return BlockState.NeedMore;
    }
    this.insert = Math.min(this.strstart, MIN_MATCH - 1);
    return this.finishBlock(flush);
  }

  private advanceAfterFastMatch(): void {
    if (this.matchLength <= this.maxLazyMatch && this.lookahead >= MIN_MATCH) {
      this.matchLength--;
      do {
        this.strstart++;
        this.insertString(this.strstart);
      } while (--this.matchLength !== 0);
      this.strstart++;
    } else {
      this.strstart += this.matchLength;
      this.matchLength = 0;
      this.insH = this.window[this.strstart];
      this.updateHash(this.window[this.strstart + 1]);
    }
  }

  // code-gauge-allow functionNcss 35 -- Transcribes zlib 1.2.12's deflate.c, whose output depends on each of its branches.
  // code-gauge-allow functionCognitiveComplexity 26 -- Transcribes zlib 1.2.12's deflate.c, whose output depends on each of its branches.
  private deflateSlow(flush: number): BlockState {
    for (;;) {
      const stop = this.refill(flush, MIN_LOOKAHEAD);
      if (stop === 'more') return BlockState.NeedMore;
      if (stop === 'end') break;
      let hashHead = 0;
      if (this.lookahead >= MIN_MATCH) hashHead = this.insertString(this.strstart);
      this.prevLength = this.matchLength;
      this.prevMatch = this.matchStart;
      this.matchLength = MIN_MATCH - 1;
      if (hashHead !== 0 && this.prevLength < this.maxLazyMatch && this.strstart - hashHead <= this.maxDist()) {
        this.findLazyMatch(hashHead);
      }
      if (this.prevLength >= MIN_MATCH && this.matchLength <= this.prevLength) {
        if (this.emitPreviousMatch() && this.flushBlock(false)) return BlockState.NeedMore;
      } else if (this.matchAvailable) {
        if (this.trees.tallyLit(this.window[this.strstart - 1])) this.flushBlockOnly(false);
        this.strstart++;
        this.lookahead--;
        if (this.strm.availOut === 0) return BlockState.NeedMore;
      } else {
        this.matchAvailable = true;
        this.strstart++;
        this.lookahead--;
      }
    }
    if (this.matchAvailable) {
      this.trees.tallyLit(this.window[this.strstart - 1]);
      this.matchAvailable = false;
    }
    this.insert = Math.min(this.strstart, MIN_MATCH - 1);
    return this.finishBlock(flush);
  }

  private findLazyMatch(hashHead: number): void {
    this.matchLength = this.longestMatch(hashHead);
    if (
      this.matchLength <= 5 &&
      (this.strategy === Z_FILTERED || (this.matchLength === MIN_MATCH && this.strstart - this.matchStart > TOO_FAR))
    ) {
      this.matchLength = MIN_MATCH - 1;
    }
  }

  /** Tallies the match found at the previous position and skips over it, returning whether to flush the block. */
  private emitPreviousMatch(): boolean {
    const maxInsert = this.strstart + this.lookahead - MIN_MATCH;
    const bflush = this.trees.tallyDist(this.strstart - 1 - this.prevMatch, this.prevLength - MIN_MATCH);
    this.lookahead -= this.prevLength - 1;
    this.prevLength -= 2;
    do {
      if (++this.strstart <= maxInsert) this.insertString(this.strstart);
    } while (--this.prevLength !== 0);
    this.matchAvailable = false;
    this.matchLength = MIN_MATCH - 1;
    this.strstart++;
    return bflush;
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- Transcribes zlib 1.2.12's deflate.c, whose output depends on each of its branches.
  private deflateRle(flush: number): BlockState {
    for (;;) {
      if (this.lookahead <= MAX_MATCH) {
        this.fillWindow();
        if (this.lookahead <= MAX_MATCH && flush === Z_NO_FLUSH) return BlockState.NeedMore;
        if (this.lookahead === 0) break;
      }
      this.matchLength = this.lookahead >= MIN_MATCH && this.strstart > 0 ? this.runLength() : 0;
      let bflush: boolean;
      if (this.matchLength >= MIN_MATCH) {
        bflush = this.trees.tallyDist(1, this.matchLength - MIN_MATCH);
        this.lookahead -= this.matchLength;
        this.strstart += this.matchLength;
        this.matchLength = 0;
      } else {
        bflush = this.trees.tallyLit(this.window[this.strstart]);
        this.lookahead--;
        this.strstart++;
      }
      if (bflush && this.flushBlock(false)) return BlockState.NeedMore;
    }
    this.insert = 0;
    return this.finishBlock(flush);
  }

  private runLength(): number {
    const { window, strstart } = this;
    const prev = window[strstart - 1];
    if (prev !== window[strstart] || prev !== window[strstart + 1] || prev !== window[strstart + 2]) return 0;
    let len = 3;
    while (len < MAX_MATCH && window[strstart + len] === prev) len++;
    return Math.min(len, this.lookahead);
  }

  private deflateHuff(flush: number): BlockState {
    for (;;) {
      if (this.lookahead === 0) {
        this.fillWindow();
        if (this.lookahead === 0) {
          if (flush === Z_NO_FLUSH) return BlockState.NeedMore;
          break;
        }
      }
      this.matchLength = 0;
      const bflush = this.trees.tallyLit(this.window[this.strstart]);
      this.lookahead--;
      this.strstart++;
      if (bflush && this.flushBlock(false)) return BlockState.NeedMore;
    }
    this.insert = 0;
    return this.finishBlock(flush);
  }

  private deflateStored(flush: number): BlockState {
    const used = this.strm.availIn;
    const last = this.copyStoredBlocks(flush);
    this.keepCopiedInput(used - this.strm.availIn);
    if (last) return BlockState.FinishDone;
    const { strm } = this;
    if (flush !== Z_NO_FLUSH && flush !== Z_FINISH && strm.availIn === 0 && this.strstart === this.blockStart) {
      return BlockState.BlockDone;
    }
    this.fillStoredWindow();
    return this.storePending(flush) ? BlockState.FinishStarted : BlockState.NeedMore;
  }

  /** Copies stored blocks straight to the output while it has room, returning whether the last block was written. */
  // code-gauge-allow functionNcss 36 -- Transcribes zlib 1.2.12's deflate.c, whose output depends on each of its branches.
  // code-gauge-allow functionCognitiveComplexity 20 -- Transcribes zlib 1.2.12's deflate.c, whose output depends on each of its branches.
  private copyStoredBlocks(flush: number): boolean {
    const { strm, trees } = this;
    const minBlock = Math.min(this.pendingBufSize - 5, this.wSize);
    let last = false;
    do {
      let len = MAX_STORED;
      let have = (trees.biValid + 42) >> 3;
      if (strm.availOut < have) break;
      have = strm.availOut - have;
      let left = this.strstart - this.blockStart;
      if (len > left + strm.availIn) len = left + strm.availIn;
      if (len > have) len = have;
      if (
        len < minBlock &&
        ((len === 0 && flush !== Z_FINISH) || flush === Z_NO_FLUSH || len !== left + strm.availIn)
      ) {
        break;
      }
      last = flush === Z_FINISH && len === left + strm.availIn;
      trees.storedBlock(undefined, 0, 0, last);
      trees.pendingBuf.set([len & 0xff, (len >> 8) & 0xff, ~len & 0xff, (~len >> 8) & 0xff], trees.pending - 4);
      this.flushPending();
      if (left) {
        if (left > len) left = len;
        strm.output.set(this.window.subarray(this.blockStart, this.blockStart + left), strm.nextOut);
        strm.nextOut += left;
        strm.availOut -= left;
        strm.totalOut += left;
        this.blockStart += left;
        len -= left;
      }
      if (len) {
        this.readBuf(strm.output, strm.nextOut, len);
        strm.nextOut += len;
        strm.availOut -= len;
        strm.totalOut += len;
      }
    } while (!last);
    return last;
  }

  /** Keeps the input copied straight to the output as the window's history. */
  private keepCopiedInput(used: number): void {
    if (!used) return;
    const { strm } = this;
    if (used >= this.wSize) {
      this.window.set(strm.input.subarray(strm.nextIn - this.wSize, strm.nextIn), 0);
      this.strstart = this.wSize;
      this.insert = this.strstart;
    } else {
      if (this.windowSize - this.strstart <= used) {
        this.strstart -= this.wSize;
        this.window.copyWithin(0, this.wSize, this.wSize + this.strstart);
        if (this.insert > this.strstart) this.insert = this.strstart;
      }
      this.window.set(strm.input.subarray(strm.nextIn - used, strm.nextIn), this.strstart);
      this.strstart += used;
      this.insert += Math.min(used, this.wSize - this.insert);
    }
    this.blockStart = this.strstart;
    if (this.highWater < this.strstart) this.highWater = this.strstart;
  }

  private fillStoredWindow(): void {
    const { strm } = this;
    let have = this.windowSize - this.strstart;
    if (strm.availIn > have && this.blockStart >= this.wSize) {
      this.blockStart -= this.wSize;
      this.strstart -= this.wSize;
      this.window.copyWithin(0, this.wSize, this.wSize + this.strstart);
      have += this.wSize;
      if (this.insert > this.strstart) this.insert = this.strstart;
    }
    if (have > strm.availIn) have = strm.availIn;
    if (have) {
      this.readBuf(this.window, this.strstart, have);
      this.strstart += have;
      this.insert += Math.min(have, this.wSize - this.insert);
    }
    if (this.highWater < this.strstart) this.highWater = this.strstart;
  }

  /** Writes a stored block to the pending buffer when worthwhile, returning whether it was the last. */
  private storePending(flush: number): boolean {
    const { strm, trees } = this;
    let have = (trees.biValid + 42) >> 3;
    have = Math.min(this.pendingBufSize - have, MAX_STORED);
    const minBlock = Math.min(have, this.wSize);
    const left = this.strstart - this.blockStart;
    let last = false;
    if (
      left >= minBlock ||
      ((left || flush === Z_FINISH) && flush !== Z_NO_FLUSH && strm.availIn === 0 && left <= have)
    ) {
      const len = Math.min(left, have);
      last = flush === Z_FINISH && strm.availIn === 0 && len === left;
      trees.storedBlock(this.window, this.blockStart, len, last);
      this.blockStart += len;
      this.flushPending();
    }
    return last;
  }
}

export function adler32(start: number, data: Uint8Array): number {
  let low = start & 0xff_ff;
  let high = start >>> 16;
  for (let index = 0; index < data.length;) {
    const end = Math.min(data.length, index + 3800);
    for (; index < end; index++) {
      low += data[index];
      high += low;
    }
    low %= 65_521;
    high %= 65_521;
  }
  return ((high << 16) | low) >>> 0;
}

export { Z_FIXED };
