// The decompression of bzip2 1.0.8 (`bzlib.c`, `decompress.c`), which CPython's `_bz2` links, transcribed so that it
// stops for input and output where libbzip2 stops.
import { currentRuntime } from '../runtimeContext';
import { BZ_MAX_ALPHA_SIZE, createDecodeTable, type DecodeTable, updateCrc } from './bzip2Huffman';
import { BZ2_RNUMS } from './bzip2Randomization';
import type { ZStream } from './zlibDeflate';

export const BZ_OK = 0;
export const BZ_STREAM_END = 4;
export const BZ_DATA_ERROR = -4;
const BZ_SEQUENCE_ERROR = -1;
const BZ_N_GROUPS = 6;
const BZ_G_SIZE = 50;
const BZ_MAX_SELECTORS = 2 + 900_000 / BZ_G_SIZE;

class DataError extends Error {}

/** What the decoding stops for: more input, or a decoded block to write out. */
type Suspend = 'input' | 'output';
type Decoding<T> = Generator<Suspend, T, void>;

/** The bit reader of `GET_BITS`, which suspends for input. */
class BitReader {
  private bsBuff = 0;
  private bsLive = 0;

  constructor(private readonly strm: ZStream) {}

  *bits(n: number): Decoding<number> {
    const { strm } = this;
    while (this.bsLive < n) {
      while (strm.availIn === 0) yield 'input';
      this.bsBuff = ((this.bsBuff << 8) | strm.input[strm.nextIn++]) >>> 0;
      this.bsLive += 8;
      strm.availIn--;
      strm.totalIn++;
    }
    this.bsLive -= n;
    return (this.bsBuff >>> this.bsLive) & ((1 << n) - 1);
  }

  *expect(bytes: readonly number[]): Decoding<void> {
    for (const byte of bytes) if ((yield* this.bits(8)) !== byte) throw new DataError();
  }

  *uint(bytes: number): Decoding<number> {
    let value = 0;
    for (let i = 0; i < bytes; i++) value = ((value << 8) | (yield* this.bits(8))) >>> 0;
    return value;
  }
}

/** One `BZ2_bzDecompressInit` stream, which decompresses as CPython's `_bz2` asks: fast, without small memory. */
export class Bzip2Decompressor {
  readonly strm: ZStream;
  private readonly reader: BitReader;
  private blockSize100k = 0;
  private tt: Uint32Array = new Uint32Array(0);
  private blockRandomised = false;
  private storedBlockCRC = 0;
  private storedCombinedCRC = 0;
  private calculatedBlockCRC = 0;
  private calculatedCombinedCRC = 0;
  private stateOutLen = 0;
  private stateOutCh = 0;
  private nblockUsed = 0;
  private saveNblock = 0;
  private k0 = 0;
  private tPos = 0;
  private rNToGo = 0;
  private rTPos = 0;
  private state: 'header' | 'output' | 'idle' | 'bad' = 'header';
  private readonly machine: Decoding<void>;

  constructor(strm: ZStream) {
    this.strm = strm;
    this.reader = new BitReader(strm);
    this.machine = this.decompressStream();
  }

  /** `BZ2_bzDecompress`. */
  decompress(): number {
    for (;;) {
      if (this.state === 'idle') return BZ_SEQUENCE_ERROR;
      if (this.state === 'bad') return BZ_DATA_ERROR;
      if (this.state === 'output') {
        const result = this.writeBlock();
        if (result !== undefined) return result;
      }
      const result = this.resume();
      if (result !== 'output') return result;
    }
  }

  /** Writes out the decoded block, giving a result to return unless the block is done and its CRC matches. */
  private writeBlock(): number | undefined {
    if (this.blockRandomised ? this.unRLERandomised() : this.unRLEFast()) return this.fail();
    if (this.nblockUsed !== this.saveNblock + 1 || this.stateOutLen !== 0) return BZ_OK;
    this.calculatedBlockCRC = ~this.calculatedBlockCRC >>> 0;
    if (this.calculatedBlockCRC !== this.storedBlockCRC) return this.fail();
    const combined = this.calculatedCombinedCRC;
    this.calculatedCombinedCRC = (((combined << 1) | (combined >>> 31)) ^ this.calculatedBlockCRC) >>> 0;
    this.state = 'header';
    return undefined;
  }

  private fail(): number {
    this.state = 'bad';
    return BZ_DATA_ERROR;
  }

  private resume(): number | 'output' {
    let step: IteratorResult<Suspend, void>;
    try {
      step = this.machine.next();
    } catch (error) {
      if (error instanceof DataError) return this.fail();
      throw error;
    }
    if (step.done) {
      this.state = 'idle';
      return this.calculatedCombinedCRC === this.storedCombinedCRC ? BZ_STREAM_END : this.fail();
    }
    if (step.value === 'input') return BZ_OK;
    this.state = 'output';
    return 'output';
  }

  // `BZ2_decompress` ------------------------------------------------------------------------------------------------

  private *decompressStream(): Decoding<void> {
    const { reader } = this;
    yield* reader.expect([0x42, 0x5a, 0x68]);
    const level = yield* reader.bits(8);
    if (level < 0x31 || level > 0x39) throw new DataError();
    this.blockSize100k = level - 0x30;
    for (;;) {
      const uc = yield* reader.bits(8);
      if (uc === 0x17) break;
      if (uc !== 0x31) throw new DataError();
      yield* reader.expect([0x41, 0x59, 0x26, 0x53, 0x59]);
      yield* this.decompressBlock();
      yield 'output';
    }
    yield* reader.expect([0x72, 0x45, 0x38, 0x50, 0x90]);
    this.storedCombinedCRC = yield* reader.uint(4);
  }

  private *decompressBlock(): Decoding<void> {
    const { reader } = this;
    this.storedBlockCRC = yield* reader.uint(4);
    this.blockRandomised = (yield* reader.bits(1)) === 1;
    const origPtr = yield* reader.uint(3);
    if (origPtr > 10 + 100_000 * this.blockSize100k) throw new DataError();
    const seqToUnseq = yield* readMapping(reader);
    const alphaSize = seqToUnseq.length + 2;
    const nGroups = yield* reader.bits(3);
    if (nGroups < 2 || nGroups > BZ_N_GROUPS) throw new DataError();
    const selector = yield* readSelectors(reader, nGroups);
    const tables: DecodeTable[] = [];
    for (let t = 0; t < nGroups; t++) tables.push(createDecodeTable(yield* readCodingTable(reader, alphaSize)));
    const symbols = new SymbolDecoder(reader, tables, selector);
    const nblock = yield* this.decodeSymbols(symbols, seqToUnseq);
    if (origPtr >= nblock) throw new DataError();
    this.startBlock(origPtr, nblock);
  }

  /** Decodes the block's move-to-front symbols into `tt`, returning its length. */
  // code-gauge-allow functionCognitiveComplexity 22 -- Transcribes the symbol loop of BZ2_decompress of bzip2's decompress.c.
  // code-gauge-allow functionNcss 33 -- Transcribes the symbol loop of BZ2_decompress of bzip2's decompress.c.
  private *decodeSymbols(symbols: SymbolDecoder, seqToUnseq: number[]): Decoding<number> {
    let { tt } = this;
    const eob = seqToUnseq.length + 1;
    const nblockMAX = 100_000 * this.blockSize100k;
    const mtf = Array.from({ length: 256 }, (_, i) => i);
    let nblock = 0;
    let nextSym = yield* symbols.next();
    while (nextSym !== eob) {
      let uc: number;
      let es = 1;
      if (nextSym <= 1) {
        es = -1;
        for (let n = 1; nextSym <= 1; n *= 2) {
          if (n >= 2 * 1024 * 1024) throw new DataError();
          es += (nextSym + 1) * n;
          nextSym = yield* symbols.next();
        }
        es++;
        uc = seqToUnseq[mtf[0]];
      } else {
        if (nblock >= nblockMAX) throw new DataError();
        const [front] = mtf.splice(nextSym - 1, 1);
        mtf.unshift(front);
        uc = seqToUnseq[front];
        nextSym = yield* symbols.next();
      }
      for (; es > 0; es--) {
        if (nblock >= nblockMAX) throw new DataError();
        if (nblock >= tt.length) tt = this.growTable(nblockMAX);
        tt[nblock++] = uc;
      }
    }
    return nblock;
  }

  /** Grows the table of the decoded block up to `limit` entries as it fills, charging what it adds. */
  private growTable(limit: number): Uint32Array {
    const length = Math.min(Math.max(this.tt.length * 2, 4096), limit);
    currentRuntime().allocate(Math.ceil((length - this.tt.length) / 2));
    const grown = new Uint32Array(length);
    grown.set(this.tt);
    this.tt = grown;
    return grown;
  }

  /** Builds the inverse transform of the decoded block in `tt` and reads its first byte. */
  private startBlock(origPtr: number, nblock: number): void {
    const { tt } = this;
    const cftab = new Int32Array(257);
    for (let i = 0; i < nblock; i++) cftab[tt[i] + 1]++;
    for (let i = 1; i <= 256; i++) cftab[i] += cftab[i - 1];
    for (let i = 0; i < nblock; i++) tt[cftab[tt[i] & 0xff]++] |= i << 8;
    this.stateOutLen = 0;
    this.stateOutCh = 0;
    this.calculatedBlockCRC = 0xff_ff_ff_ff;
    this.saveNblock = nblock;
    this.tPos = tt[origPtr] >>> 8;
    this.nblockUsed = 0;
    this.rNToGo = 0;
    this.rTPos = 0;
    this.k0 = this.next();
    if (this.blockRandomised) this.k0 ^= this.randomMask();
    this.nblockUsed++;
  }

  // Undoing the initial run-length encoding -------------------------------------------------------------------------

  /** `BZ_GET_FAST`, which gives -1 for a position past the block, which only a corrupt stream points to. */
  private next(): number {
    if (this.tPos >= 100_000 * this.blockSize100k) return -1;
    this.tPos = this.tt[this.tPos];
    const value = this.tPos & 0xff;
    this.tPos >>>= 8;
    return value;
  }

  private randomMask(): number {
    if (this.rNToGo === 0) {
      this.rNToGo = BZ2_RNUMS[this.rTPos];
      this.rTPos = (this.rTPos + 1) % 512;
    }
    this.rNToGo--;
    return this.rNToGo === 1 ? 1 : 0;
  }

  private emit(): void {
    const { strm } = this;
    strm.output[strm.nextOut++] = this.stateOutCh;
    strm.availOut--;
    strm.totalOut++;
    this.calculatedBlockCRC = updateCrc(this.calculatedBlockCRC, this.stateOutCh);
  }

  /** `unRLE_obuf_to_output_FAST` without randomisation; returns whether the stream is corrupt. */
  // code-gauge-allow functionCognitiveComplexity 23 -- Transcribes unRLE_obuf_to_output_FAST of bzip2's bzlib.c, whose gotos the flag follows.
  private unRLEFast(): boolean {
    let one = false;
    for (;;) {
      if (!one && this.stateOutLen > 0) {
        for (; this.stateOutLen > 1; this.stateOutLen--) {
          if (this.strm.availOut === 0) return false;
          this.emit();
        }
        if (this.strm.availOut === 0) return false;
        one = true;
      }
      if (one) {
        if (this.strm.availOut === 0) {
          this.stateOutLen = 1;
          return false;
        }
        this.emit();
      }
      const run = this.startRun();
      if (run === 'end') return false;
      if (run === 'corrupt') return true;
      one = run === 'one';
    }
  }

  /** Reads the next run after a written one, as the fast path of `unRLE_obuf_to_output_FAST` does. */
  private startRun(): 'corrupt' | 'end' | 'one' | 'run' {
    const done = this.saveNblock + 1;
    if (this.nblockUsed > done) return 'corrupt';
    if (this.nblockUsed === done) {
      this.stateOutLen = 0;
      return 'end';
    }
    this.stateOutCh = this.k0;
    let k1 = this.next();
    if (k1 < 0) return 'corrupt';
    this.nblockUsed++;
    if (k1 !== this.k0) this.k0 = k1;
    if (k1 !== this.stateOutCh || this.nblockUsed === done) return 'one';
    for (const length of [2, 3]) {
      this.stateOutLen = length;
      k1 = this.next();
      if (k1 < 0) return 'corrupt';
      this.nblockUsed++;
      if (this.nblockUsed === done) return 'run';
      if (k1 !== this.k0) {
        this.k0 = k1;
        return 'run';
      }
    }
    return this.readRunLength((value) => value);
  }

  /** Reads the length of a run of four or more and the byte after it. */
  private readRunLength(unmask: (value: number) => number): 'corrupt' | 'run' {
    const extra = this.next();
    if (extra < 0) return 'corrupt';
    this.nblockUsed++;
    this.stateOutLen = unmask(extra) + 4;
    const following = this.next();
    if (following < 0) return 'corrupt';
    this.nblockUsed++;
    this.k0 = unmask(following);
    return 'run';
  }

  /** `unRLE_obuf_to_output_FAST` for the randomised blocks of bzip2 before 0.9.5; returns whether it is corrupt. */
  private unRLERandomised(): boolean {
    const done = this.saveNblock + 1;
    for (;;) {
      for (;;) {
        if (this.strm.availOut === 0) return false;
        if (this.stateOutLen === 0) break;
        this.emit();
        this.stateOutLen--;
      }
      if (this.nblockUsed === done) return false;
      if (this.nblockUsed > done) return true;
      this.stateOutLen = 1;
      this.stateOutCh = this.k0;
      if (this.startRandomisedRun(done) === 'corrupt') return true;
    }
  }

  private startRandomisedRun(done: number): 'corrupt' | 'run' {
    const unmask = (value: number): number => value ^ this.randomMask();
    for (const length of [2, 3, 4]) {
      const value = this.next();
      if (value < 0) return 'corrupt';
      this.nblockUsed++;
      const k1 = unmask(value);
      if (this.nblockUsed === done) return 'run';
      if (k1 !== this.k0) {
        this.k0 = k1;
        return 'run';
      }
      if (length < 4) this.stateOutLen = length;
    }
    return this.readRunLength(unmask);
  }
}

// The parts of a block's header -------------------------------------------------------------------------------------

/** Reads which bytes the block uses, giving the byte of each symbol. */
function* readMapping(reader: BitReader): Decoding<number[]> {
  const inUse16: boolean[] = [];
  for (let i = 0; i < 16; i++) inUse16.push((yield* reader.bits(1)) === 1);
  const seqToUnseq: number[] = [];
  for (const [i, used] of inUse16.entries()) {
    if (!used) continue;
    for (let j = 0; j < 16; j++) if ((yield* reader.bits(1)) === 1) seqToUnseq.push(i * 16 + j);
  }
  if (seqToUnseq.length === 0) throw new DataError();
  return seqToUnseq;
}

/** Reads which coding table each group of symbols uses, undoing their move-to-front. */
function* readSelectors(reader: BitReader, nGroups: number): Decoding<number[]> {
  const nSelectors = yield* reader.bits(15);
  if (nSelectors < 1) throw new DataError();
  const pos = Array.from({ length: nGroups }, (_, v) => v);
  const selector: number[] = [];
  for (let i = 0; i < nSelectors; i++) {
    let j = 0;
    while ((yield* reader.bits(1)) !== 0) {
      j++;
      if (j >= nGroups) throw new DataError();
    }
    if (i >= BZ_MAX_SELECTORS) continue;
    const [tmp] = pos.splice(j, 1);
    pos.unshift(tmp);
    selector.push(tmp);
  }
  return selector;
}

function* readCodingTable(reader: BitReader, alphaSize: number): Decoding<Uint8Array> {
  let curr = yield* reader.bits(5);
  const len = new Uint8Array(alphaSize);
  for (let i = 0; i < alphaSize; i++) {
    for (;;) {
      if (curr < 1 || curr > 20) throw new DataError();
      if ((yield* reader.bits(1)) === 0) break;
      curr += (yield* reader.bits(1)) === 0 ? 1 : -1;
    }
    len[i] = curr;
  }
  return len;
}

/** `GET_MTF_VAL`: the Huffman decoding of the symbols, with the table each group of 50 selects. */
class SymbolDecoder {
  private groupNo = -1;
  private groupPos = 0;
  private table: DecodeTable;

  constructor(
    private readonly reader: BitReader,
    private readonly tables: DecodeTable[],
    private readonly selector: number[]
  ) {
    this.table = tables[0];
  }

  *next(): Decoding<number> {
    if (this.groupPos === 0) {
      this.groupNo++;
      if (this.groupNo >= this.selector.length) throw new DataError();
      this.groupPos = BZ_G_SIZE;
      this.table = this.tables[this.selector[this.groupNo]];
    }
    this.groupPos--;
    const { limit, base, perm, minLen } = this.table;
    let zn = minLen;
    let zvec = yield* this.reader.bits(zn);
    for (;;) {
      if (zn > 20) throw new DataError();
      if (zvec <= limit[zn]) break;
      zn++;
      zvec = (zvec << 1) | (yield* this.reader.bits(1));
    }
    const index = zvec - base[zn];
    if (index < 0 || index >= BZ_MAX_ALPHA_SIZE) throw new DataError();
    return perm[index];
  }
}
