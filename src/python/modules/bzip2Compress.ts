// The compression of bzip2 1.0.8 (`bzlib.c`, `compress.c`), which CPython's `_bz2` links, transcribed so that it
// writes the same bytes and hands them out at the same calls.
import { type BitWriter, writeBlock } from './bzip2Block';
import { updateCrc } from './bzip2Huffman';
import { blockSort, BZ_N_OVERSHOOT } from './bzip2Sort';
import type { ZStream } from './zlibDeflate';

export const BZ_RUN = 0;
export const BZ_FINISH = 2;
export const BZ_RUN_OK = 1;
export const BZ_FINISH_OK = 3;
export const BZ_STREAM_END = 4;
export const BZ_SEQUENCE_ERROR = -1;
export const BZ_PARAM_ERROR = -2;

const BZ_M_IDLE = 1;
const BZ_M_RUNNING = 2;
const BZ_M_FINISHING = 4;
const BZ_S_OUTPUT = 1;
const BZ_S_INPUT = 2;
const WORK_FACTOR = 30;

/** One `BZ2_bzCompressInit` stream, whose block size must already be valid. */
export class Bzip2Compressor implements BitWriter {
  readonly strm: ZStream;
  private mode = BZ_M_RUNNING;
  private state = BZ_S_INPUT;
  private availInExpect = 0;
  private readonly blockSize100k: number;
  private readonly nblockMAX: number;
  private readonly block: Uint8Array;
  private readonly ptr: Int32Array;
  private zbits = new Uint8Array(1024);
  private stateInCh = 256;
  private stateInLen = 0;
  private nblock = 0;
  private numZ = 0;
  private stateOutPos = 0;
  private readonly inUse = Array.from({ length: 256 }, () => false);
  private bsBuff = 0;
  private bsLive = 0;
  private blockCRC = 0;
  private combinedCRC = 0;
  private blockNo = 0;

  constructor(strm: ZStream, blockSize100k: number) {
    this.strm = strm;
    this.blockSize100k = blockSize100k;
    const n = 100_000 * blockSize100k;
    this.nblockMAX = n - 19;
    this.block = new Uint8Array(n + BZ_N_OVERSHOOT);
    this.ptr = new Int32Array(n);
    this.prepareNewBlock();
  }

  /** `BZ2_bzCompress` with BZ_RUN or BZ_FINISH, which are the actions CPython's `_bz2` takes. */
  compress(action: number): number {
    if (this.mode === BZ_M_IDLE) return BZ_SEQUENCE_ERROR;
    if (this.mode === BZ_M_RUNNING) {
      if (action === BZ_RUN) return this.handleCompress() ? BZ_RUN_OK : BZ_PARAM_ERROR;
      this.availInExpect = this.strm.availIn;
      this.mode = BZ_M_FINISHING;
    }
    if (action !== BZ_FINISH || this.availInExpect !== this.strm.availIn) return BZ_SEQUENCE_ERROR;
    if (!this.handleCompress()) return BZ_SEQUENCE_ERROR;
    if (this.availInExpect > 0 || !this.isEmptyRL() || this.stateOutPos < this.numZ) return BZ_FINISH_OK;
    this.mode = BZ_M_IDLE;
    return BZ_STREAM_END;
  }

  bsW(n: number, v: number): void {
    while (this.bsLive >= 8) this.putTopByte();
    this.bsBuff = (this.bsBuff | (v << (32 - this.bsLive - n))) >>> 0;
    this.bsLive += n;
  }

  private prepareNewBlock(): void {
    this.nblock = 0;
    this.numZ = 0;
    this.stateOutPos = 0;
    this.blockCRC = 0xff_ff_ff_ff;
    this.inUse.fill(false);
    this.blockNo++;
  }

  private isEmptyRL(): boolean {
    return !(this.stateInCh < 256 && this.stateInLen > 0);
  }

  private handleCompress(): boolean {
    let progress = false;
    for (;;) {
      if (this.state === BZ_S_OUTPUT) {
        progress = this.copyOutputUntilStop() || progress;
        if (this.stateOutPos < this.numZ || this.finishedAll()) break;
        this.prepareNewBlock();
        this.state = BZ_S_INPUT;
      }
      progress = this.copyInputUntilStop() || progress;
      if (this.mode !== BZ_M_RUNNING && this.availInExpect === 0) {
        this.flushRL();
        this.compressBlock(this.mode === BZ_M_FINISHING);
        this.state = BZ_S_OUTPUT;
      } else if (this.nblock >= this.nblockMAX) {
        this.compressBlock(false);
        this.state = BZ_S_OUTPUT;
      } else if (this.strm.availIn === 0) {
        break;
      }
    }
    return progress;
  }

  private finishedAll(): boolean {
    return this.mode === BZ_M_FINISHING && this.availInExpect === 0 && this.isEmptyRL();
  }

  private copyInputUntilStop(): boolean {
    const { strm } = this;
    let progress = false;
    while (this.nblock < this.nblockMAX && strm.availIn > 0) {
      if (this.mode !== BZ_M_RUNNING) {
        if (this.availInExpect === 0) break;
        this.availInExpect--;
      }
      progress = true;
      this.addCharToBlock(strm.input[strm.nextIn]);
      strm.nextIn++;
      strm.availIn--;
      strm.totalIn++;
    }
    return progress;
  }

  private copyOutputUntilStop(): boolean {
    const { strm } = this;
    let progress = false;
    while (strm.availOut > 0 && this.stateOutPos < this.numZ) {
      progress = true;
      strm.output[strm.nextOut++] = this.zbits[this.stateOutPos++];
      strm.availOut--;
      strm.totalOut++;
    }
    return progress;
  }

  private addCharToBlock(ch: number): void {
    if (ch !== this.stateInCh && this.stateInLen === 1) {
      this.blockCRC = updateCrc(this.blockCRC, this.stateInCh);
      this.inUse[this.stateInCh] = true;
      this.block[this.nblock++] = this.stateInCh;
      this.stateInCh = ch;
    } else if (ch !== this.stateInCh || this.stateInLen === 255) {
      if (this.stateInCh < 256) this.addPairToBlock();
      this.stateInCh = ch;
      this.stateInLen = 1;
    } else {
      this.stateInLen++;
    }
  }

  private addPairToBlock(): void {
    const ch = this.stateInCh;
    for (let i = 0; i < this.stateInLen; i++) this.blockCRC = updateCrc(this.blockCRC, ch);
    this.inUse[ch] = true;
    for (let i = Math.min(this.stateInLen, 4); i > 0; i--) this.block[this.nblock++] = ch;
    if (this.stateInLen >= 4) {
      this.inUse[this.stateInLen - 4] = true;
      this.block[this.nblock++] = this.stateInLen - 4;
    }
  }

  private flushRL(): void {
    if (this.stateInCh < 256) this.addPairToBlock();
    this.stateInCh = 256;
    this.stateInLen = 0;
  }

  private putTopByte(): void {
    if (this.numZ === this.zbits.length) {
      const grown = new Uint8Array(this.zbits.length * 2);
      grown.set(this.zbits);
      this.zbits = grown;
    }
    this.zbits[this.numZ++] = this.bsBuff >>> 24;
    this.bsBuff = (this.bsBuff << 8) >>> 0;
    this.bsLive -= 8;
  }

  private bsPutBytes(bytes: readonly number[]): void {
    for (const byte of bytes) this.bsW(8, byte);
  }

  private bsPutUInt32(u: number): void {
    this.bsPutBytes([u >>> 24, (u >>> 16) & 0xff, (u >>> 8) & 0xff, u & 0xff]);
  }

  /** `BZ2_compressBlock`. */
  private compressBlock(isLastBlock: boolean): void {
    const hasData = this.nblock > 0;
    let origPtr = 0;
    if (hasData) {
      this.blockCRC = ~this.blockCRC >>> 0;
      this.combinedCRC = (((this.combinedCRC << 1) | (this.combinedCRC >>> 31)) ^ this.blockCRC) >>> 0;
      origPtr = blockSort(this.block, this.ptr, this.nblock, WORK_FACTOR);
    }
    if (this.blockNo === 1) {
      this.bsBuff = 0;
      this.bsLive = 0;
      this.bsPutBytes([0x42, 0x5a, 0x68, 0x30 + this.blockSize100k]);
    }
    if (hasData) {
      this.bsPutBytes([0x31, 0x41, 0x59, 0x26, 0x53, 0x59]);
      this.bsPutUInt32(this.blockCRC);
      this.bsW(1, 0);
      this.bsW(24, origPtr);
      writeBlock(this, this.block, this.ptr, this.nblock, this.inUse);
    }
    if (isLastBlock) {
      this.bsPutBytes([0x17, 0x72, 0x45, 0x38, 0x50, 0x90]);
      this.bsPutUInt32(this.combinedCRC);
      while (this.bsLive > 0) this.putTopByte();
    }
  }
}
