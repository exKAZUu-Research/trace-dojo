// The .xz decoders of liblzma 5.8.4: `stream_decoder.c`, `block_decoder.c`, `block_header_decoder.c`, `index_hash.c`
// and `stream_flags_decoder.c`.
import { checkIsSupported, checkSize, CheckState, crc32, LZMA_CHECK_ID_MAX, LZMA_CHECK_NONE } from './xzCheck';
import {
  bufcpy,
  type Coder,
  type Filter,
  LZMA_BLOCK_HEADER_SIZE_MAX,
  LZMA_BUF_ERROR,
  LZMA_DATA_ERROR,
  LZMA_FORMAT_ERROR,
  LZMA_GET_CHECK,
  LZMA_MEMLIMIT_ERROR,
  LZMA_NO_CHECK,
  LZMA_OK,
  LZMA_OPTIONS_ERROR,
  LZMA_PROG_ERROR,
  LZMA_STREAM_END,
  LZMA_STREAM_HEADER_SIZE,
  type Pos,
  read32le,
  VLI_UNKNOWN,
  vliCeil4,
  vliDecode,
  vliSize,
  VliState,
} from './xzCommon';
import { FOOTER_MAGIC, HEADER_MAGIC, indexSizeUnpadded } from './xzEncoders';
import { filterFlagsDecode, rawDecoderInit, rawDecoderMemusage } from './xzFilterChain';

/** A decoder at the top of a stream, which can tell its stream's check. */
export interface TopDecoder extends Coder {
  getCheck?(): number;
}

const UNPADDED_SIZE_MAX = 2 ** 63 - 4;
const VLI_MAX = 2 ** 63 - 1;

/** `lzma_block` as the stream decoder uses it. */
interface Block {
  check: number;
  headerSize: number;
  compressedSize: number;
  uncompressedSize: number;
  filters: Filter[];
  rawCheck: Uint8Array;
}

/** `lzma_block_unpadded_size`, with 0 for invalid and `VLI_UNKNOWN` for unknown. */
function blockUnpaddedSize(block: Block): number {
  if (
    block.headerSize < 8 ||
    block.headerSize > LZMA_BLOCK_HEADER_SIZE_MAX ||
    block.headerSize & 3 ||
    block.compressedSize > VLI_MAX ||
    block.compressedSize === 0 ||
    block.check > LZMA_CHECK_ID_MAX
  ) {
    return 0;
  }
  if (block.compressedSize === VLI_UNKNOWN) return VLI_UNKNOWN;
  const unpadded = block.compressedSize + block.headerSize + checkSize(block.check);
  return unpadded > UNPADDED_SIZE_MAX ? 0 : unpadded;
}

function decodeSize(input: Uint8Array, inPos: Pos, inSize: number): { ret: number; value: number } {
  const vli = new VliState();
  const ret = vliDecode(vli, true, input, inPos, inSize);
  return { ret, value: Number(vli.value) };
}

/** `lzma_block_header_decode`. */
// code-gauge-allow functionNcss 36 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
// code-gauge-allow functionCognitiveComplexity 18 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
function blockHeaderDecode(block: Block, input: Uint8Array): number {
  block.filters = [];
  if ((input[0] + 1) * 4 !== block.headerSize || block.check > LZMA_CHECK_ID_MAX) return LZMA_PROG_ERROR;
  const inSize = block.headerSize - 4;
  if (crc32(input, 0, inSize, 0) !== read32le(input, inSize)) return LZMA_DATA_ERROR;
  if (input[1] & 0x3c) return LZMA_OPTIONS_ERROR;
  const inPos = { value: 2 };
  block.compressedSize = VLI_UNKNOWN;
  block.uncompressedSize = VLI_UNKNOWN;
  if (input[1] & 0x40) {
    const size = decodeSize(input, inPos, inSize);
    block.compressedSize = size.value;
    if (size.ret !== LZMA_OK) return size.ret;
    if (blockUnpaddedSize(block) === 0) return LZMA_DATA_ERROR;
  }
  if (input[1] & 0x80) {
    const size = decodeSize(input, inPos, inSize);
    block.uncompressedSize = size.value;
    if (size.ret !== LZMA_OK) return size.ret;
  }
  const filterCount = (input[1] & 3) + 1;
  for (let i = 0; i < filterCount; ++i) {
    const result = filterFlagsDecode(input, inPos, inSize);
    if (result.ret !== LZMA_OK) {
      block.filters = [];
      return result.ret;
    }
    block.filters.push(result.filter as Filter);
  }
  while (inPos.value < inSize) {
    if (input[inPos.value++] !== 0) {
      block.filters = [];
      return LZMA_OPTIONS_ERROR;
    }
  }
  return LZMA_OK;
}

/** What a step of a decoder returns to go on to its next state, where C falls through or loops. */
export const CONTINUE = -1;

const sizeValid = (size: number, reference: number): boolean => reference === VLI_UNKNOWN || reference === size;

const BLOCK_CODE = 0;
const BLOCK_PADDING = 1;
const BLOCK_CHECK = 2;

/** `lzma_block_coder` of the decoder. */
class BlockDecoder implements Coder {
  private sequence = BLOCK_CODE;
  private compressedSize = 0;
  private uncompressedSize = 0;
  private readonly compressedLimit: number;
  private readonly uncompressedLimit: number;
  private readonly checkPos: Pos = { value: 0 };
  private readonly check: CheckState;
  private checkBytes: Uint8Array = new Uint8Array(0);

  constructor(
    private readonly block: Block,
    private readonly next: Coder
  ) {
    this.compressedLimit =
      block.compressedSize === VLI_UNKNOWN
        ? UNPADDED_SIZE_MAX - block.headerSize - checkSize(block.check)
        : block.compressedSize;
    this.uncompressedLimit = block.uncompressedSize === VLI_UNKNOWN ? VLI_MAX : block.uncompressedSize;
    this.check = new CheckState(block.check);
  }

  // code-gauge-allow functionParameterCount 7 -- Takes the buffers and positions of a liblzma code function separately, as the C does.
  // code-gauge-allow functionCognitiveComplexity 17 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  code(
    input: Uint8Array,
    inPos: Pos,
    inSize: number,
    out: Uint8Array,
    outPos: Pos,
    outSize: number,
    action: number
  ): number {
    const { block } = this;
    if (this.sequence === BLOCK_CODE) {
      const ret = this.decodeData(input, inPos, inSize, out, outPos, outSize, action);
      if (ret !== LZMA_STREAM_END) return ret;
      this.sequence = BLOCK_PADDING;
    }
    if (this.sequence === BLOCK_PADDING) {
      while (this.compressedSize & 3) {
        if (inPos.value >= inSize) return LZMA_OK;
        ++this.compressedSize;
        if (input[inPos.value++] !== 0) return LZMA_DATA_ERROR;
      }
      if (block.check === LZMA_CHECK_NONE) return LZMA_STREAM_END;
      this.checkBytes = this.check.finish();
      this.sequence = BLOCK_CHECK;
    }
    const size = checkSize(block.check);
    bufcpy(input, inPos, inSize, block.rawCheck, this.checkPos, size);
    if (this.checkPos.value < size) return LZMA_OK;
    const matches = block.rawCheck.subarray(0, size).every((byte, i) => byte === this.checkBytes[i]);
    return checkIsSupported(block.check) && !matches ? LZMA_DATA_ERROR : LZMA_STREAM_END;
  }

  /** The `SEQ_CODE` part of `block_decode`, returning `LZMA_STREAM_END` once the data has ended. */
  // code-gauge-allow functionParameterCount 7 -- Takes the buffers and positions of a liblzma code function separately, as the C does.
  private decodeData(
    input: Uint8Array,
    inPos: Pos,
    inSize: number,
    out: Uint8Array,
    outPos: Pos,
    outSize: number,
    action: number
  ): number {
    const { block } = this;
    const inStart = inPos.value;
    const outStart = outPos.value;
    const inStop = inPos.value + Math.min(inSize - inPos.value, this.compressedLimit - this.compressedSize);
    const outStop = outPos.value + Math.min(outSize - outPos.value, this.uncompressedLimit - this.uncompressedSize);
    const ret = this.next.code(input, inPos, inStop, out, outPos, outStop, action);
    const outUsed = outPos.value - outStart;
    this.compressedSize += inPos.value - inStart;
    this.uncompressedSize += outUsed;
    if (ret === LZMA_OK && this.endsEarly(inPos.value < inSize, outPos.value < outSize)) return LZMA_DATA_ERROR;
    if (outUsed > 0) this.check.update(out, outStart, outPos.value);
    if (ret !== LZMA_STREAM_END) return ret;
    if (
      !sizeValid(this.compressedSize, block.compressedSize) ||
      !sizeValid(this.uncompressedSize, block.uncompressedSize)
    ) {
      return LZMA_DATA_ERROR;
    }
    block.compressedSize = this.compressedSize;
    block.uncompressedSize = this.uncompressedSize;
    return LZMA_STREAM_END;
  }

  /** Whether a size the header gives was reached while the data went on. */
  private endsEarly(inputLeft: boolean, outputLeft: boolean): boolean {
    const compDone = this.compressedSize === this.block.compressedSize;
    const uncompDone = this.uncompressedSize === this.block.uncompressedSize;
    return (compDone && uncompDone) || (compDone && outputLeft) || (uncompDone && inputLeft);
  }
}

const HASH_BLOCK = 0;
const HASH_COUNT = 1;
const HASH_UNPADDED = 2;
const HASH_UNCOMPRESSED = 3;
const HASH_PADDING_INIT = 4;
const HASH_PADDING = 5;
const HASH_CRC32 = 6;

/** `lzma_index_hash_info`, whose check is the list of its records. */
class IndexHashInfo {
  blocksSize = 0;
  uncompressedSize = 0;
  count = 0;
  indexListSize = 0;
  records = '';

  /** Whether every sum of this is at least that of `other`. */
  covers(other: IndexHashInfo): boolean {
    return (
      this.blocksSize >= other.blocksSize &&
      this.uncompressedSize >= other.uncompressedSize &&
      this.indexListSize >= other.indexListSize
    );
  }

  append(unpadded: number, uncompressed: number): void {
    this.blocksSize += vliCeil4(unpadded);
    this.uncompressedSize += uncompressed;
    this.indexListSize += vliSize(unpadded) + vliSize(uncompressed);
    ++this.count;
    this.records += `${unpadded},${uncompressed};`;
  }
}

/** `lzma_index_hash`. */
class IndexHash {
  private sequence = HASH_BLOCK;
  readonly blocks = new IndexHashInfo();
  private readonly records = new IndexHashInfo();
  private remaining = 0;
  private unpaddedSize = 0;
  private readonly vli = new VliState();
  private pos = 0;
  private crc = 0;

  get size(): number {
    return vliCeil4(indexSizeUnpadded(this.blocks.count, this.blocks.indexListSize));
  }

  append(unpadded: number, uncompressed: number): number {
    if (this.sequence !== HASH_BLOCK || unpadded < 5 || unpadded > UNPADDED_SIZE_MAX || uncompressed > VLI_MAX) {
      return LZMA_PROG_ERROR;
    }
    this.blocks.append(unpadded, uncompressed);
    if (
      this.blocks.blocksSize > VLI_MAX ||
      this.blocks.uncompressedSize > VLI_MAX ||
      this.size > 2 ** 34 ||
      LZMA_STREAM_HEADER_SIZE * 2 + this.blocks.blocksSize + this.size > VLI_MAX
    ) {
      return LZMA_DATA_ERROR;
    }
    return LZMA_OK;
  }

  /** `lzma_index_hash_decode`. */
  decode(input: Uint8Array, inPos: Pos, inSize: number): number {
    if (inPos.value >= inSize) return LZMA_BUF_ERROR;
    const inStart = inPos.value;
    while (inPos.value < inSize) {
      const ret = this.step(input, inPos, inSize, inStart);
      if (ret !== CONTINUE) return ret;
    }
    this.crc = crc32(input, inStart, inPos.value, this.crc);
    return LZMA_OK;
  }

  private step(input: Uint8Array, inPos: Pos, inSize: number, inStart: number): number {
    switch (this.sequence) {
      case HASH_BLOCK: {
        if (input[inPos.value++] !== 0) return LZMA_DATA_ERROR;
        this.sequence = HASH_COUNT;
        return CONTINUE;
      }
      case HASH_COUNT:
      case HASH_UNPADDED:
      case HASH_UNCOMPRESSED: {
        return this.integer(input, inPos, inSize, inStart);
      }
      case HASH_PADDING_INIT: {
        this.pos = (4 - indexSizeUnpadded(this.records.count, this.records.indexListSize)) & 3;
        this.sequence = HASH_PADDING;
        return CONTINUE;
      }
      case HASH_PADDING: {
        return this.padding(input, inPos, inStart);
      }
      default: {
        do {
          if (inPos.value === inSize) return LZMA_OK;
          if (((this.crc >>> (this.pos * 8)) & 0xff) !== input[inPos.value++]) return LZMA_DATA_ERROR;
        } while (++this.pos < 4);
        return LZMA_STREAM_END;
      }
    }
  }

  /** Decodes the count or a size of a record; leaving early is `goto out`, which also sums the input in the CRC. */
  private integer(input: Uint8Array, inPos: Pos, inSize: number, inStart: number): number {
    this.vli.pos = this.pos;
    const ret = vliDecode(this.vli, false, input, inPos, inSize);
    this.pos = this.vli.pos;
    if (ret !== LZMA_STREAM_END) {
      this.crc = crc32(input, inStart, inPos.value, this.crc);
      return ret;
    }
    this.pos = 0;
    const value = Number(this.vli.value);
    const { blocks, records } = this;
    if (this.sequence === HASH_COUNT) {
      this.remaining = value;
      if (this.remaining !== blocks.count) return LZMA_DATA_ERROR;
      this.sequence = this.remaining === 0 ? HASH_PADDING_INIT : HASH_UNPADDED;
    } else if (this.sequence === HASH_UNPADDED) {
      if (value < 5 || value > UNPADDED_SIZE_MAX) return LZMA_DATA_ERROR;
      this.unpaddedSize = value;
      this.sequence = HASH_UNCOMPRESSED;
    } else {
      records.append(this.unpaddedSize, value);
      if (!blocks.covers(records)) return LZMA_DATA_ERROR;
      this.sequence = --this.remaining === 0 ? HASH_PADDING_INIT : HASH_UNPADDED;
    }
    return CONTINUE;
  }

  private padding(input: Uint8Array, inPos: Pos, inStart: number): number {
    if (this.pos > 0) {
      --this.pos;
      return input[inPos.value++] === 0 ? CONTINUE : LZMA_DATA_ERROR;
    }
    const { blocks, records } = this;
    if (!blocks.covers(records) || !records.covers(blocks) || blocks.records !== records.records)
      return LZMA_DATA_ERROR;
    this.crc = crc32(input, inStart, inPos.value, this.crc);
    this.sequence = HASH_CRC32;
    return CONTINUE;
  }
}

/** `stream_flags_decode` of the two flag bytes at `at`, or undefined when they are invalid. */
function streamFlags(input: Uint8Array, at: number): number | undefined {
  if (input[at] !== 0 || input[at + 1] & 0xf0) return undefined;
  return input[at + 1] & 0x0f;
}

const startsWith = (input: Uint8Array, at: number, magic: readonly number[]): boolean =>
  magic.every((byte, i) => input[at + i] === byte);

const STREAM_HEADER = 0;
const STREAM_BLOCK_HEADER = 1;
const STREAM_BLOCK_INIT = 2;
const STREAM_BLOCK_RUN = 3;
const STREAM_INDEX = 4;
const STREAM_FOOTER = 5;

/** `lzma_stream_coder` of the decoder, as CPython asks for it: telling the check, without concatenation. */
export class StreamDecoder implements TopDecoder {
  private sequence = STREAM_HEADER;
  private blockDecoder: Coder | undefined;
  private readonly block: Block = {
    check: 0,
    headerSize: 0,
    compressedSize: VLI_UNKNOWN,
    uncompressedSize: VLI_UNKNOWN,
    filters: [],
    rawCheck: new Uint8Array(64),
  };
  private check = 0;
  private indexHash = new IndexHash();
  private readonly memlimit: number;
  private readonly pos: Pos = { value: 0 };
  private readonly buffer = new Uint8Array(LZMA_BLOCK_HEADER_SIZE_MAX);

  constructor(memlimit: number) {
    this.memlimit = Math.max(1, memlimit);
  }

  getCheck(): number {
    return this.check;
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
    for (;;) {
      const ret = this.step(input, inPos, inSize, out, outPos, outSize, action);
      if (ret !== CONTINUE) return ret;
    }
  }

  /** One state of `stream_decode`, which moves to the next state and returns `CONTINUE` where C falls through. */
  // code-gauge-allow functionParameterCount 7 -- Takes the buffers and positions of a liblzma code function separately, as the C does.
  // code-gauge-allow functionNcss 38 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  // code-gauge-allow functionCognitiveComplexity 19 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
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
      case STREAM_HEADER: {
        if (!this.fill(input, inPos, inSize, LZMA_STREAM_HEADER_SIZE)) return LZMA_OK;
        const ret = this.header();
        if (ret !== LZMA_OK) return ret;
        this.block.check = this.check;
        this.sequence = STREAM_BLOCK_HEADER;
        return this.check === LZMA_CHECK_NONE ? LZMA_NO_CHECK : LZMA_GET_CHECK;
      }
      case STREAM_BLOCK_HEADER: {
        return this.blockHeader(input, inPos, inSize);
      }
      case STREAM_BLOCK_INIT: {
        const ret = this.blockInit();
        if (ret !== LZMA_OK) return ret;
        this.sequence = STREAM_BLOCK_RUN;
        return CONTINUE;
      }
      case STREAM_BLOCK_RUN: {
        let ret = (this.blockDecoder as Coder).code(input, inPos, inSize, out, outPos, outSize, action);
        if (ret !== LZMA_STREAM_END) return ret;
        ret = this.indexHash.append(blockUnpaddedSize(this.block), this.block.uncompressedSize);
        if (ret !== LZMA_OK) return ret;
        this.sequence = STREAM_BLOCK_HEADER;
        return CONTINUE;
      }
      case STREAM_INDEX: {
        if (inPos.value >= inSize) return LZMA_OK;
        const ret = this.indexHash.decode(input, inPos, inSize);
        if (ret !== LZMA_STREAM_END) return ret;
        this.sequence = STREAM_FOOTER;
        return CONTINUE;
      }
      default: {
        return this.fill(input, inPos, inSize, LZMA_STREAM_HEADER_SIZE) ? this.footer() : LZMA_OK;
      }
    }
  }

  /** Copies input into the buffer until it holds `size` bytes, which then starts over. */
  private fill(input: Uint8Array, inPos: Pos, inSize: number, size: number): boolean {
    bufcpy(input, inPos, inSize, this.buffer, this.pos, size);
    if (this.pos.value < size) return false;
    this.pos.value = 0;
    return true;
  }

  private blockHeader(input: Uint8Array, inPos: Pos, inSize: number): number {
    if (inPos.value >= inSize) return LZMA_OK;
    if (this.pos.value === 0) {
      if (input[inPos.value] === 0) {
        this.sequence = STREAM_INDEX;
        return CONTINUE;
      }
      this.block.headerSize = (input[inPos.value] + 1) * 4;
    }
    if (!this.fill(input, inPos, inSize, this.block.headerSize)) return LZMA_OK;
    this.sequence = STREAM_BLOCK_INIT;
    return CONTINUE;
  }

  private header(): number {
    const { buffer } = this;
    if (!startsWith(buffer, 0, HEADER_MAGIC)) return LZMA_FORMAT_ERROR;
    if (crc32(buffer, 6, 8, 0) !== read32le(buffer, 8)) return LZMA_DATA_ERROR;
    const check = streamFlags(buffer, 6);
    if (check === undefined) return LZMA_OPTIONS_ERROR;
    this.check = check;
    return LZMA_OK;
  }

  private footer(): number {
    const { buffer } = this;
    if (!startsWith(buffer, 10, FOOTER_MAGIC)) return LZMA_DATA_ERROR;
    if (crc32(buffer, 4, 10, 0) !== read32le(buffer, 0)) return LZMA_DATA_ERROR;
    const check = streamFlags(buffer, 8);
    if (check === undefined) return LZMA_OPTIONS_ERROR;
    const backwardSize = (read32le(buffer, 4) + 1) * 4;
    if (this.indexHash.size !== backwardSize) return LZMA_DATA_ERROR;
    if (check !== this.check) return LZMA_DATA_ERROR;
    return LZMA_STREAM_END;
  }

  private blockInit(): number {
    const ret = blockHeaderDecode(this.block, this.buffer);
    if (ret !== LZMA_OK) return ret;
    const memusage = rawDecoderMemusage(this.block.filters);
    if (memusage === undefined) return LZMA_OPTIONS_ERROR;
    if (memusage > this.memlimit) return LZMA_MEMLIMIT_ERROR;
    if (blockUnpaddedSize(this.block) === 0) return LZMA_PROG_ERROR;
    const raw = rawDecoderInit(this.block.filters);
    if (raw.ret !== LZMA_OK) return raw.ret;
    this.blockDecoder = new BlockDecoder(this.block, raw.coder as Coder);
    return LZMA_OK;
  }
}
