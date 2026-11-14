// The container encoders of liblzma 5.8.4: `stream_encoder.c`, `block_encoder.c`, `block_header_encoder.c`,
// `index_encoder.c`, `stream_flags_encoder.c` and `alone_encoder.c`.
import { checkIsSupported, checkSize, CheckState, crc32, LZMA_CHECK_ID_MAX, LZMA_CHECK_NONE } from './xzCheck';
import {
  bufcpy,
  type Coder,
  type Filter,
  isLcLpPbValid,
  LZMA_BLOCK_HEADER_SIZE_MAX,
  LZMA_FILTER_LZMA1,
  LZMA_FILTERS_MAX,
  LZMA_FINISH,
  LZMA_OK,
  LZMA_OPTIONS_ERROR,
  LZMA_PROG_ERROR,
  LZMA_RUN,
  LZMA_STREAM_END,
  LZMA_STREAM_HEADER_SIZE,
  LZMA_UNSUPPORTED_CHECK,
  type LzmaOptions,
  type Pos,
  vliCeil4,
  vliEncode,
  vliSize,
  write32le,
} from './xzCommon';
import { type CoderResult, filterFlagsEncode, filterFlagsSize, rawEncoderInit } from './xzFilterChain';

export const HEADER_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
export const FOOTER_MAGIC = [0x59, 0x5a];

/** `lzma_stream_header_encode`, or false for a check that does not fit the flags. */
function streamHeader(check: number, out: Uint8Array): boolean {
  if (check < 0 || check > LZMA_CHECK_ID_MAX) return false;
  out.set(HEADER_MAGIC);
  out[6] = 0;
  out[7] = check;
  write32le(out, 8, crc32(out, 6, 8, 0));
  return true;
}

function streamFooter(check: number, backwardSize: number, out: Uint8Array): void {
  write32le(out, 4, backwardSize / 4 - 1);
  out[8] = 0;
  out[9] = check;
  write32le(out, 0, crc32(out, 4, 10, 0));
  out.set(FOOTER_MAGIC, 10);
}

/** `index_size_unpadded` of an Index of `count` records whose list takes `listSize` bytes. */
export const indexSizeUnpadded = (count: number, listSize: number): number => 1 + vliSize(count) + listSize + 4;

interface IndexRecord {
  unpadded: number;
  uncompressed: number;
}

/** `lzma_block` as the stream encoder uses it. */
interface Block {
  check: number;
  headerSize: number;
  compressedSize: number;
  uncompressedSize: number;
  filters: readonly Filter[];
}

/** `lzma_block_header_size`, which sets the header size of a block of unknown sizes. */
function blockHeaderSize(block: Block): number {
  let size = 1 + 1 + 4;
  if (block.filters.length === 0) return LZMA_PROG_ERROR;
  for (const filter of block.filters) {
    const flags = filterFlagsSize(filter);
    if (flags.ret !== LZMA_OK) return flags.ret;
    size += flags.size;
  }
  block.headerSize = (size + 3) & ~3;
  return LZMA_OK;
}

function blockHeaderEncode(block: Block, out: Uint8Array): number {
  const outSize = block.headerSize - 4;
  out[0] = outSize / 4;
  out[1] = 0;
  const outPos = { value: 2 };
  for (const filter of block.filters) {
    const ret = filterFlagsEncode(filter, out, outPos, outSize);
    if (ret !== LZMA_OK) return ret;
  }
  out[1] |= block.filters.length - 1;
  out.fill(0, outPos.value, outSize);
  write32le(out, outSize, crc32(out, 0, outSize, 0));
  return LZMA_OK;
}

const BLOCK_CODE = 0;
const BLOCK_PADDING = 1;
const BLOCK_CHECK = 2;

/** `lzma_block_coder` of the encoder. */
class BlockEncoder implements Coder {
  private sequence = BLOCK_CODE;
  private compressedSize = 0;
  private uncompressedSize = 0;
  private readonly pos: Pos = { value: 0 };
  private readonly check: CheckState;
  private checkBytes: Uint8Array = new Uint8Array(0);

  constructor(
    private readonly block: Block,
    private readonly next: Coder
  ) {
    this.check = new CheckState(block.check);
  }

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
    if (this.sequence === BLOCK_CODE) {
      const inStart = inPos.value;
      const outStart = outPos.value;
      const ret = this.next.code(input, inPos, inSize, out, outPos, outSize, action);
      this.compressedSize += outPos.value - outStart;
      this.uncompressedSize += inPos.value - inStart;
      if (inPos.value > inStart) this.check.update(input, inStart, inPos.value);
      if (ret !== LZMA_STREAM_END) return ret;
      this.block.compressedSize = this.compressedSize;
      this.block.uncompressedSize = this.uncompressedSize;
      this.sequence = BLOCK_PADDING;
    }
    if (this.sequence === BLOCK_PADDING) {
      while (this.compressedSize & 3) {
        if (outPos.value >= outSize) return LZMA_OK;
        out[outPos.value++] = 0;
        ++this.compressedSize;
      }
      if (this.block.check === LZMA_CHECK_NONE) return LZMA_STREAM_END;
      this.checkBytes = this.check.finish();
      this.sequence = BLOCK_CHECK;
    }
    const size = checkSize(this.block.check);
    bufcpy(this.checkBytes, this.pos, size, out, outPos, outSize);
    return this.pos.value < size ? LZMA_OK : LZMA_STREAM_END;
  }
}

/** `lzma_block_encoder_init`. */
function blockEncoderInit(block: Block): CoderResult {
  if (block.check < 0 || block.check > LZMA_CHECK_ID_MAX) return { ret: LZMA_PROG_ERROR };
  if (!checkIsSupported(block.check)) return { ret: LZMA_UNSUPPORTED_CHECK };
  const raw = rawEncoderInit(block.filters);
  if (raw.ret !== LZMA_OK) return raw;
  return { ret: LZMA_OK, coder: new BlockEncoder(block, raw.coder as Coder) };
}

/** What a step of an encoder returns to go on to its next state. */
const CONTINUE = -1;

const INDEX_INDICATOR = 0;
const INDEX_COUNT = 1;
const INDEX_UNPADDED = 2;
const INDEX_UNCOMPRESSED = 3;
const INDEX_NEXT = 4;
const INDEX_PADDING = 5;
const INDEX_CRC32 = 6;

/** `lzma_index_coder` of the encoder. */
class IndexEncoder {
  private sequence = INDEX_INDICATOR;
  private readonly pos: Pos = { value: 0 };
  private crc = 0;
  private record = -1;

  constructor(private readonly records: readonly IndexRecord[]) {}

  get listSize(): number {
    return this.records.reduce((sum, { unpadded, uncompressed }) => sum + vliSize(unpadded) + vliSize(uncompressed), 0);
  }

  /** The size of the Index, `lzma_index_size`. */
  get size(): number {
    return vliCeil4(indexSizeUnpadded(this.records.length, this.listSize));
  }

  /** `index_encode`. */
  code(out: Uint8Array, outPos: Pos, outSize: number): number {
    const outStart = outPos.value;
    while (outPos.value < outSize) {
      const ret = this.step(out, outPos, outSize, outStart);
      if (ret !== CONTINUE) return ret;
    }
    this.crc = crc32(out, outStart, outPos.value, this.crc);
    return LZMA_OK;
  }

  /** One state of `index_encode`: `CONTINUE` goes on, and a result leaving through `out:` has summed the CRC. */
  // code-gauge-allow functionNcss 31 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  private step(out: Uint8Array, outPos: Pos, outSize: number, outStart: number): number {
    switch (this.sequence) {
      case INDEX_INDICATOR: {
        out[outPos.value++] = 0;
        this.sequence = INDEX_COUNT;
        return CONTINUE;
      }
      case INDEX_COUNT:
      case INDEX_UNPADDED:
      case INDEX_UNCOMPRESSED: {
        return this.integer(out, outPos, outSize, outStart);
      }
      case INDEX_NEXT: {
        if (++this.record === this.records.length) {
          this.pos.value = (4 - indexSizeUnpadded(this.records.length, this.listSize)) & 3;
          this.sequence = INDEX_PADDING;
        } else {
          this.sequence = INDEX_UNPADDED;
        }
        return CONTINUE;
      }
      case INDEX_PADDING: {
        if (this.pos.value > 0) {
          --this.pos.value;
          out[outPos.value++] = 0;
          return CONTINUE;
        }
        this.crc = crc32(out, outStart, outPos.value, this.crc);
        this.sequence = INDEX_CRC32;
        return CONTINUE;
      }
      default: {
        do {
          if (outPos.value === outSize) return LZMA_OK;
          out[outPos.value++] = (this.crc >>> (this.pos.value * 8)) & 0xff;
        } while (++this.pos.value < 4);
        return LZMA_STREAM_END;
      }
    }
  }

  private integer(out: Uint8Array, outPos: Pos, outSize: number, outStart: number): number {
    const record = this.records[this.record];
    let value = this.records.length;
    if (this.sequence !== INDEX_COUNT) value = this.sequence === INDEX_UNPADDED ? record.unpadded : record.uncompressed;
    const ret = vliEncode(value, this.pos, out, outPos, outSize);
    if (ret !== LZMA_STREAM_END) {
      this.crc = crc32(out, outStart, outPos.value, this.crc);
      return ret;
    }
    this.pos.value = 0;
    this.sequence = this.sequence === INDEX_UNPADDED ? INDEX_UNCOMPRESSED : INDEX_NEXT;
    return CONTINUE;
  }
}

const STREAM_HEADER = 0;
const STREAM_BLOCK_INIT = 1;
const STREAM_BLOCK_HEADER = 2;
const STREAM_BLOCK_ENCODE = 3;
const STREAM_INDEX_ENCODE = 4;
const STREAM_FOOTER = 5;

/** `lzma_stream_coder` of the encoder. */
class StreamEncoder implements Coder {
  private sequence = STREAM_HEADER;
  private blockEncoder: Coder | undefined;
  private blockEncoderIsInitialized = false;
  private readonly records: IndexRecord[] = [];
  private indexEncoder: IndexEncoder | undefined;
  private readonly bufferPos: Pos = { value: 0 };
  private bufferSize = LZMA_STREAM_HEADER_SIZE;
  readonly buffer = new Uint8Array(LZMA_BLOCK_HEADER_SIZE_MAX);
  readonly block: Block;

  constructor(check: number, filters: readonly Filter[]) {
    this.block = {
      check,
      headerSize: 0,
      compressedSize: -1,
      uncompressedSize: -1,
      filters,
    };
  }

  /** `block_encoder_init` of the stream encoder. */
  blockEncoderInit(): number {
    this.block.compressedSize = -1;
    this.block.uncompressedSize = -1;
    const ret = blockHeaderSize(this.block);
    if (ret !== LZMA_OK) return ret;
    const result = blockEncoderInit(this.block);
    this.blockEncoder = result.coder;
    this.blockEncoderIsInitialized = result.ret === LZMA_OK;
    return result.ret;
  }

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
    while (outPos.value < outSize) {
      const ret = this.step(input, inPos, inSize, out, outPos, outSize, action);
      if (ret !== CONTINUE) return ret;
    }
    return LZMA_OK;
  }

  /** One state of `stream_encode`. */
  // code-gauge-allow functionParameterCount 7 -- Takes the buffers and positions of a liblzma code function separately, as the C does.
  // code-gauge-allow functionNcss 32 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  private step(
    input: Uint8Array,
    inPos: Pos,
    inSize: number,
    out: Uint8Array,
    outPos: Pos,
    outSize: number,
    action: number
  ): number {
    switch (this.sequence) {
      case STREAM_HEADER:
      case STREAM_BLOCK_HEADER:
      case STREAM_FOOTER: {
        bufcpy(this.buffer, this.bufferPos, this.bufferSize, out, outPos, outSize);
        if (this.bufferPos.value < this.bufferSize) return LZMA_OK;
        if (this.sequence === STREAM_FOOTER) return LZMA_STREAM_END;
        this.bufferPos.value = 0;
        ++this.sequence;
        return CONTINUE;
      }
      case STREAM_BLOCK_INIT: {
        return this.blockStart(inPos.value === inSize, action);
      }
      case STREAM_BLOCK_ENCODE: {
        const ret = (this.blockEncoder as Coder).code(input, inPos, inSize, out, outPos, outSize, action);
        if (ret !== LZMA_STREAM_END) return ret;
        const { block } = this;
        this.records.push({
          unpadded: block.compressedSize + block.headerSize + checkSize(block.check),
          uncompressed: block.uncompressedSize,
        });
        this.sequence = STREAM_BLOCK_INIT;
        return CONTINUE;
      }
      default: {
        const index = this.indexEncoder as IndexEncoder;
        const ret = index.code(out, outPos, outSize);
        if (ret !== LZMA_STREAM_END) return ret;
        streamFooter(this.block.check, index.size, this.buffer);
        this.bufferSize = LZMA_STREAM_HEADER_SIZE;
        this.sequence = STREAM_FOOTER;
        return CONTINUE;
      }
    }
  }

  /** `SEQ_BLOCK_INIT`: a block for more input, or the Index once the input has been finished. */
  private blockStart(inputEnded: boolean, action: number): number {
    if (inputEnded) {
      if (action !== LZMA_FINISH) return action === LZMA_RUN ? LZMA_OK : LZMA_STREAM_END;
      this.indexEncoder = new IndexEncoder(this.records);
      this.sequence = STREAM_INDEX_ENCODE;
      return CONTINUE;
    }
    if (!this.blockEncoderIsInitialized) {
      const ret = this.blockEncoderInit();
      if (ret !== LZMA_OK) return ret;
    }
    this.blockEncoderIsInitialized = false;
    if (blockHeaderEncode(this.block, this.buffer) !== LZMA_OK) return LZMA_PROG_ERROR;
    this.bufferSize = this.block.headerSize;
    this.sequence = STREAM_BLOCK_HEADER;
    return CONTINUE;
  }
}

/** `lzma_stream_encoder`. */
export function streamEncoderInit(filters: readonly Filter[], check: number): CoderResult {
  if (filters.length > LZMA_FILTERS_MAX) return { ret: LZMA_OPTIONS_ERROR };
  const encoder = new StreamEncoder(check, filters);
  if (!streamHeader(check, encoder.buffer)) return { ret: LZMA_PROG_ERROR };
  const ret = encoder.blockEncoderInit();
  return ret === LZMA_OK ? { ret, coder: encoder } : { ret };
}

const ALONE_HEADER_SIZE = 1 + 4 + 8;

/** `lzma_alone_coder` of the encoder. */
class AloneEncoder implements Coder {
  private readonly headerPos: Pos = { value: 0 };

  constructor(
    private readonly header: Uint8Array,
    private readonly next: Coder
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
    while (outPos.value < outSize) {
      if (this.headerPos.value < ALONE_HEADER_SIZE) {
        bufcpy(this.header, this.headerPos, ALONE_HEADER_SIZE, out, outPos, outSize);
        if (this.headerPos.value < ALONE_HEADER_SIZE) return LZMA_OK;
      } else {
        return this.next.code(input, inPos, inSize, out, outPos, outSize, action);
      }
    }
    return LZMA_OK;
  }
}

/** `lzma_alone_encoder`. */
export function aloneEncoderInit(options: LzmaOptions): CoderResult {
  if (!isLcLpPbValid(options) || options.dictSize < 4096) return { ret: LZMA_OPTIONS_ERROR };
  const header = new Uint8Array(ALONE_HEADER_SIZE);
  header[0] = (options.pb * 5 + options.lp) * 9 + options.lc;
  let d = options.dictSize - 1;
  d |= d >>> 2;
  d |= d >>> 3;
  d |= d >>> 4;
  d |= d >>> 8;
  d |= d >>> 16;
  d >>>= 0;
  if (d !== 0xff_ff_ff_ff) ++d;
  write32le(header, 1, d);
  header.fill(0xff, 5);
  const lzma = rawEncoderInit([{ id: LZMA_FILTER_LZMA1, options }]);
  if (lzma.ret !== LZMA_OK) return lzma;
  return { ret: LZMA_OK, coder: new AloneEncoder(header, lzma.coder as Coder) };
}
