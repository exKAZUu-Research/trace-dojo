// The other decoders of liblzma 5.8.4 that CPython's `_lzma` starts: `alone_decoder.c`, `lzip_decoder.c` and
// `auto_decoder.c`.
import { crc32, LZMA_CHECK_CRC32, LZMA_CHECK_NONE } from './xzCheck';
import {
  bufcpy,
  type Coder,
  emptyLzmaOptions,
  lclppbDecode,
  LZMA_DATA_ERROR,
  LZMA_FILTER_LZMA1,
  LZMA_FILTER_LZMA1EXT,
  LZMA_FORMAT_ERROR,
  LZMA_GET_CHECK,
  LZMA_MEMLIMIT_ERROR,
  LZMA_MEMUSAGE_BASE,
  LZMA_NO_CHECK,
  LZMA_OK,
  LZMA_OPTIONS_ERROR,
  LZMA_STREAM_END,
  type LzmaOptions,
  type Pos,
  read32le,
  VLI_UNKNOWN,
} from './xzCommon';
import { StreamDecoder, type TopDecoder } from './xzDecoders';
import { lzma1DecoderInit, lzmaDecoderMemusage } from './xzLzmaDecoder';

const ALONE_PROPERTIES = 0;
const ALONE_DICTIONARY_SIZE = 1;
const ALONE_UNCOMPRESSED_SIZE = 2;
const ALONE_CODER_INIT = 3;
const ALONE_CODE = 4;
const UNKNOWN_SIZE = 2n ** 64n - 1n;

/** `lzma_alone_coder` of the decoder. */
export class AloneDecoder implements TopDecoder {
  private sequence = ALONE_PROPERTIES;
  private pos = 0;
  private uncompressedSize = 0n;
  private memusage = LZMA_MEMUSAGE_BASE;
  private readonly options = emptyLzmaOptions();
  private next: Coder | undefined;
  private readonly memlimit: number;

  constructor(
    memlimit: number,
    private readonly picky: boolean
  ) {
    this.memlimit = Math.max(1, memlimit);
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
    while (outPos.value < outSize && (this.sequence === ALONE_CODE || inPos.value < inSize)) {
      if (this.sequence === ALONE_CODE) {
        return (this.next as Coder).code(input, inPos, inSize, out, outPos, outSize, action);
      }
      if (this.sequence !== ALONE_CODER_INIT) {
        const ret = this.headerByte(input, inPos);
        if (ret !== LZMA_OK) return ret;
      }
      // The last byte of the header falls through to the initialization, whatever input is left.
      if (this.sequence === ALONE_CODER_INIT) {
        const ret = this.coderInit();
        if (ret !== LZMA_OK) return ret;
      }
    }
    return LZMA_OK;
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  private headerByte(input: Uint8Array, inPos: Pos): number {
    const { options } = this;
    const byte = input[inPos.value];
    if (this.sequence === ALONE_PROPERTIES) {
      if (lclppbDecode(options, byte)) return LZMA_FORMAT_ERROR;
      this.sequence = ALONE_DICTIONARY_SIZE;
    } else if (this.sequence === ALONE_DICTIONARY_SIZE) {
      options.dictSize = (options.dictSize + byte * 2 ** (this.pos * 8)) >>> 0;
      if (++this.pos === 4) {
        if (this.picky && options.dictSize !== 0xff_ff_ff_ff && !isRoundedDictSize(options.dictSize)) {
          return LZMA_FORMAT_ERROR;
        }
        this.pos = 0;
        this.sequence = ALONE_UNCOMPRESSED_SIZE;
      }
    } else {
      this.uncompressedSize |= BigInt(byte) << BigInt(this.pos * 8);
      ++inPos.value;
      if (++this.pos < 8) return LZMA_OK;
      if (this.picky && this.uncompressedSize !== UNKNOWN_SIZE && this.uncompressedSize >= 1n << 38n) {
        return LZMA_FORMAT_ERROR;
      }
      this.memusage = lzmaDecoderMemusage(options.dictSize) + LZMA_MEMUSAGE_BASE;
      this.pos = 0;
      this.sequence = ALONE_CODER_INIT;
      return LZMA_OK;
    }
    ++inPos.value;
    return LZMA_OK;
  }

  private coderInit(): number {
    if (this.memusage > this.memlimit) return LZMA_MEMLIMIT_ERROR;
    const size = this.uncompressedSize === UNKNOWN_SIZE ? VLI_UNKNOWN : Number(this.uncompressedSize);
    const result = lzma1DecoderInit(LZMA_FILTER_LZMA1EXT, this.options, size);
    if (result.ret !== LZMA_OK) return result.ret;
    this.next = result.coder;
    this.sequence = ALONE_CODE;
    return LZMA_OK;
  }
}

function isRoundedDictSize(dictSize: number): boolean {
  let d = dictSize - 1;
  d |= d >>> 2;
  d |= d >>> 3;
  d |= d >>> 4;
  d |= d >>> 8;
  d |= d >>> 16;
  return ((d >>> 0) + 1) % 2 ** 32 === dictSize;
}

const LZIP_ID_STRING = 0;
const LZIP_VERSION = 1;
const LZIP_DICT_SIZE = 2;
const LZIP_CODER_INIT = 3;
const LZIP_LZMA_STREAM = 4;

/** `lzma_lzip_coder`, as the auto decoder starts it for CPython: telling the check, without concatenation. */
class LzipDecoder implements TopDecoder {
  private sequence = LZIP_ID_STRING;
  private version = 0;
  private crc = 0;
  private uncompressedSize = 0;
  private memberSize = 0;
  private memusage = LZMA_MEMUSAGE_BASE;
  private readonly pos: Pos = { value: 0 };
  private readonly buffer = new Uint8Array(20);
  private readonly options: LzmaOptions = {
    ...emptyLzmaOptions(),
    lc: 3,
    lp: 0,
    pb: 2,
  };
  private lzma: Coder | undefined;

  constructor(private readonly memlimit: number) {}

  getCheck(): number {
    return LZMA_CHECK_CRC32;
  }

  // code-gauge-allow functionParameterCount 7 -- Takes the buffers and positions of a liblzma code function separately, as the C does.
  // code-gauge-allow functionNcss 58 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  // code-gauge-allow functionCognitiveComplexity 25 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  code(
    input: Uint8Array,
    inPos: Pos,
    inSize: number,
    out: Uint8Array,
    outPos: Pos,
    outSize: number,
    action: number
  ): number {
    switch (this.sequence) {
      case LZIP_ID_STRING: {
        const id = [0x4c, 0x5a, 0x49, 0x50];
        while (this.pos.value < 4) {
          if (inPos.value >= inSize) return LZMA_OK;
          if (input[inPos.value] !== id[this.pos.value]) return LZMA_FORMAT_ERROR;
          ++inPos.value;
          ++this.pos.value;
        }
        this.pos.value = 0;
        this.crc = 0;
        this.uncompressedSize = 0;
        this.memberSize = 4;
        this.sequence = LZIP_VERSION;
      }
      // falls through
      case LZIP_VERSION: {
        if (inPos.value >= inSize) return LZMA_OK;
        this.version = input[inPos.value++];
        if (this.version > 1) return LZMA_OPTIONS_ERROR;
        ++this.memberSize;
        this.sequence = LZIP_DICT_SIZE;
        return LZMA_GET_CHECK;
      }
      case LZIP_DICT_SIZE: {
        if (inPos.value >= inSize) return LZMA_OK;
        const ds = input[inPos.value++];
        ++this.memberSize;
        const b2log = ds & 0x1f;
        const fracnum = ds >>> 5;
        if (b2log < 12 || b2log > 29 || (b2log === 12 && fracnum > 0)) return LZMA_DATA_ERROR;
        this.options.dictSize = 2 ** b2log - fracnum * 2 ** (b2log - 4);
        this.memusage = lzmaDecoderMemusage(this.options.dictSize) + LZMA_MEMUSAGE_BASE;
        this.sequence = LZIP_CODER_INIT;
      }
      // falls through
      case LZIP_CODER_INIT: {
        if (this.memusage > Math.max(1, this.memlimit)) return LZMA_MEMLIMIT_ERROR;
        const result = lzma1DecoderInit(LZMA_FILTER_LZMA1, this.options);
        if (result.ret !== LZMA_OK) return result.ret;
        this.lzma = result.coder;
        this.crc = 0;
        this.sequence = LZIP_LZMA_STREAM;
      }
      // falls through
      case LZIP_LZMA_STREAM: {
        const inStart = inPos.value;
        const outStart = outPos.value;
        const ret = (this.lzma as Coder).code(input, inPos, inSize, out, outPos, outSize, action);
        this.memberSize += inPos.value - inStart;
        this.uncompressedSize += outPos.value - outStart;
        this.crc = crc32(out, outStart, outPos.value, this.crc);
        if (ret !== LZMA_STREAM_END) return ret;
        this.sequence = LZIP_LZMA_STREAM + 1;
      }
      // falls through
      default: {
        return this.footer(input, inPos, inSize);
      }
    }
  }

  private footer(input: Uint8Array, inPos: Pos, inSize: number): number {
    const footerSize = this.version === 0 ? 12 : 20;
    bufcpy(input, inPos, inSize, this.buffer, this.pos, footerSize);
    if (this.pos.value < footerSize) return LZMA_OK;
    this.pos.value = 0;
    this.memberSize += footerSize;
    const read64 = (at: number): number => read32le(this.buffer, at) + read32le(this.buffer, at + 4) * 2 ** 32;
    if (this.crc !== read32le(this.buffer, 0)) return LZMA_DATA_ERROR;
    if (this.uncompressedSize !== read64(4)) return LZMA_DATA_ERROR;
    if (this.version > 0 && this.memberSize !== read64(12)) return LZMA_DATA_ERROR;
    return LZMA_STREAM_END;
  }
}

/** `lzma_auto_coder`, as CPython asks for it: telling the check, without concatenation. */
export class AutoDecoder implements TopDecoder {
  private next: TopDecoder | undefined;

  constructor(private readonly memlimit: number) {}

  getCheck(): number {
    return this.next?.getCheck?.() ?? LZMA_CHECK_NONE;
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
    if (this.next === undefined) {
      if (inPos.value >= inSize) return LZMA_OK;
      const first = input[inPos.value];
      if (first === 0xfd) {
        this.next = new StreamDecoder(this.memlimit);
      } else if (first === 0x4c) {
        this.next = new LzipDecoder(this.memlimit);
      } else {
        this.next = new AloneDecoder(this.memlimit, true);
        return LZMA_NO_CHECK;
      }
    }
    return this.next.code(input, inPos, inSize, out, outPos, outSize, action);
  }
}
