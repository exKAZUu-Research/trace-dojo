// The LZMA1 and LZMA2 encoder filters of liblzma 5.8.4 (`lzma_encoder.c`'s init, `lzma2_encoder.c`).
import {
  bufcpy,
  type Coder,
  LZMA_FILTER_LZMA1,
  LZMA_FINISH,
  LZMA_OK,
  LZMA_OPTIONS_ERROR,
  LZMA_PROG_ERROR,
  LZMA_RUN,
  LZMA_STREAM_END,
  LZMA_SYNC_FLUSH,
  type LzmaOptions,
  type Pos,
  UINT32_MAX,
} from './xzCommon';
import { hashBytesOf, type LzCoder, LzEncoder, type LzOptions, MatchFinder } from './xzLzEncoder';
import { MATCH_LEN_MAX } from './xzLzmaCommon';
import { lclppbByte, LZMA2_CHUNK_MAX, LzmaEncoder, OPTS } from './xzLzmaEncoder';

const LZMA2_UNCOMPRESSED_MAX = 1 << 21;
const LZMA2_HEADER_MAX = 6;
const LZMA2_HEADER_UNCOMPRESSED = 3;

/** `lzma_encode`: LZMA1, which ends with an end marker. */
class Lzma1Coder implements LzCoder {
  constructor(readonly lzma: LzmaEncoder) {}

  code(mf: MatchFinder, out: Uint8Array, outPos: Pos, outSize: number): number {
    if (mf.action === LZMA_SYNC_FLUSH) return LZMA_OPTIONS_ERROR;
    return this.lzma.encode(mf, out, outPos, outSize, UINT32_MAX);
  }
}

/** What a step of the encoder returns to go on to its next state. */
const CONTINUE = -1;

const SEQ_INIT = 0;
const SEQ_LZMA_ENCODE = 1;
const SEQ_LZMA_COPY = 2;
const SEQ_UNCOMPRESSED_HEADER = 3;
const SEQ_UNCOMPRESSED_COPY = 4;

/** `lzma_lzma2_coder` of the encoder. */
class Lzma2Coder implements LzCoder {
  private sequence = SEQ_INIT;
  private needProperties = true;
  private needStateReset = false;
  private needDictionaryReset = true;
  private uncompressedSize = 0;
  private readonly compressedSize: Pos = { value: 0 };
  private bufPos = 0;
  private readonly buf = new Uint8Array(LZMA2_HEADER_MAX + LZMA2_CHUNK_MAX);
  private readonly chunk = this.buf.subarray(LZMA2_HEADER_MAX);

  constructor(
    private readonly lzma: LzmaEncoder,
    private readonly options: LzmaOptions
  ) {}

  code(mf: MatchFinder, out: Uint8Array, outPos: Pos, outSize: number): number {
    while (outPos.value < outSize) {
      const ret = this.step(mf, out, outPos, outSize);
      if (ret !== CONTINUE) return ret;
    }
    return LZMA_OK;
  }

  /** One state of `lzma2_encode`. */
  private step(mf: MatchFinder, out: Uint8Array, outPos: Pos, outSize: number): number {
    switch (this.sequence) {
      case SEQ_INIT: {
        return this.chunkStart(mf, out, outPos);
      }
      case SEQ_LZMA_ENCODE: {
        return this.encode(mf);
      }
      case SEQ_LZMA_COPY: {
        if (!this.copy(this.compressedSize.value, out, outPos, outSize)) return LZMA_OK;
        this.sequence = SEQ_INIT;
        return CONTINUE;
      }
      case SEQ_UNCOMPRESSED_HEADER: {
        if (!this.copy(LZMA2_HEADER_UNCOMPRESSED, out, outPos, outSize)) return LZMA_OK;
        this.sequence = SEQ_UNCOMPRESSED_COPY;
        return CONTINUE;
      }
      default: {
        const copySize = Math.min(outSize - outPos.value, this.uncompressedSize);
        const start = mf.readPos - this.uncompressedSize;
        out.set(mf.buffer.subarray(start, start + copySize), outPos.value);
        outPos.value += copySize;
        this.uncompressedSize -= copySize;
        if (this.uncompressedSize !== 0) return LZMA_OK;
        this.sequence = SEQ_INIT;
        return CONTINUE;
      }
    }
  }

  private chunkStart(mf: MatchFinder, out: Uint8Array, outPos: Pos): number {
    if (mf.writePos - mf.readPos + mf.readAhead === 0) {
      if (mf.action === LZMA_FINISH) out[outPos.value++] = 0;
      return mf.action === LZMA_RUN ? LZMA_OK : LZMA_STREAM_END;
    }
    if (this.needStateReset && !this.lzma.reset(this.options)) return LZMA_OPTIONS_ERROR;
    this.uncompressedSize = 0;
    this.compressedSize.value = 0;
    this.sequence = SEQ_LZMA_ENCODE;
    return CONTINUE;
  }

  private encode(mf: MatchFinder): number {
    const left = LZMA2_UNCOMPRESSED_MAX - this.uncompressedSize;
    const limit = left < mf.matchLenMax ? 0 : mf.readPos - mf.readAhead + left - mf.matchLenMax;
    const readStart = mf.readPos - mf.readAhead;
    const ret = this.lzma.encode(mf, this.chunk, this.compressedSize, LZMA2_CHUNK_MAX, limit);
    this.uncompressedSize += mf.readPos - mf.readAhead - readStart;
    if (ret !== LZMA_STREAM_END) return LZMA_OK;
    if (this.compressedSize.value >= this.uncompressedSize) {
      this.uncompressedSize += mf.readAhead;
      mf.readAhead = 0;
      this.headerUncompressed();
      this.needStateReset = true;
      this.sequence = SEQ_UNCOMPRESSED_HEADER;
    } else {
      this.headerLzma();
      this.sequence = SEQ_LZMA_COPY;
    }
    return CONTINUE;
  }

  /** Copies the buffer up to `end`, reporting whether it all went out. */
  private copy(end: number, out: Uint8Array, outPos: Pos, outSize: number): boolean {
    const bufPos = { value: this.bufPos };
    bufcpy(this.buf, bufPos, end, out, outPos, outSize);
    this.bufPos = bufPos.value;
    return this.bufPos === end;
  }

  private headerLzma(): void {
    let pos: number;
    if (this.needProperties) {
      pos = 0;
      this.buf[pos] = this.needDictionaryReset ? 0x80 + (3 << 5) : 0x80 + (2 << 5);
    } else {
      pos = 1;
      this.buf[pos] = this.needStateReset ? 0x80 + (1 << 5) : 0x80;
    }
    this.bufPos = pos;
    let size = this.uncompressedSize - 1;
    this.buf[pos++] += size >>> 16;
    this.buf[pos++] = (size >>> 8) & 0xff;
    this.buf[pos++] = size & 0xff;
    size = this.compressedSize.value - 1;
    this.buf[pos++] = size >>> 8;
    this.buf[pos++] = size & 0xff;
    if (this.needProperties) this.buf[pos] = lclppbByte(this.options);
    this.needProperties = false;
    this.needStateReset = false;
    this.needDictionaryReset = false;
    this.compressedSize.value += LZMA2_HEADER_MAX;
  }

  private headerUncompressed(): void {
    this.buf[0] = this.needDictionaryReset ? 1 : 2;
    this.needDictionaryReset = false;
    this.buf[1] = (this.uncompressedSize - 1) >>> 8;
    this.buf[2] = (this.uncompressedSize - 1) & 0xff;
    this.bufPos = 0;
  }
}

/** `lzma_lzma_encoder_init` or `lzma_lzma2_encoder_init`, with `next` the filters before it. */
export function lzmaEncoderInit(
  id: bigint,
  options: LzmaOptions | undefined,
  next: () => { ret: number; coder?: Coder }
): { ret: number; coder?: Coder } {
  if (options === undefined) return { ret: LZMA_PROG_ERROR };
  const isLzma1 = id === LZMA_FILTER_LZMA1;
  const lzma = new LzmaEncoder();
  const niceLen = Math.max(hashBytesOf(options.mf), options.niceLen);
  if (!lzma.create(isLzma1, options, niceLen)) return { ret: LZMA_OPTIONS_ERROR };
  const lzOptions: LzOptions = {
    beforeSize: OPTS,
    dictSize: options.dictSize,
    afterSize: OPTS + 1,
    matchLenMax: MATCH_LEN_MAX,
    niceLen,
    matchFinder: options.mf,
    depth: options.depth,
  };
  if (!isLzma1 && lzOptions.beforeSize + lzOptions.dictSize < LZMA2_CHUNK_MAX) {
    lzOptions.beforeSize = LZMA2_CHUNK_MAX - lzOptions.dictSize;
  }
  const mf = new MatchFinder();
  if (mf.prepare(lzOptions)) return { ret: LZMA_OPTIONS_ERROR };
  mf.init();
  const lz = isLzma1 ? new Lzma1Coder(lzma) : new Lzma2Coder(lzma, { ...options });
  const rest = next();
  if (rest.ret !== LZMA_OK) return rest;
  return { ret: LZMA_OK, coder: new LzEncoder(mf, lz, rest.coder) };
}
