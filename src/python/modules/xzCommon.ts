// The definitions shared by the transcription of liblzma 5.8.4 (`common.h`, `lzma.h`), the version the reference
// CPython links, behind `_lzma`.

export const LZMA_OK = 0;
export const LZMA_STREAM_END = 1;
export const LZMA_NO_CHECK = 2;
export const LZMA_UNSUPPORTED_CHECK = 3;
export const LZMA_GET_CHECK = 4;
export const LZMA_MEM_ERROR = 5;
export const LZMA_MEMLIMIT_ERROR = 6;
export const LZMA_FORMAT_ERROR = 7;
export const LZMA_OPTIONS_ERROR = 8;
export const LZMA_DATA_ERROR = 9;
export const LZMA_BUF_ERROR = 10;
export const LZMA_PROG_ERROR = 11;

export const LZMA_RUN = 0;
export const LZMA_SYNC_FLUSH = 1;
export const LZMA_FINISH = 3;

export const UINT32_MAX = 0xff_ff_ff_ff;
export const LZMA_VLI_MAX = 2n ** 63n - 1n;
/** `LZMA_VLI_UNKNOWN` among sizes kept as numbers. */
export const VLI_UNKNOWN = -1;
export const LZMA_MEMUSAGE_BASE = 1 << 15;
export const LZMA_FILTERS_MAX = 4;
export const LZMA_BUFFER_SIZE = 4096;
export const LZMA_DICT_SIZE_MIN = 4096;
export const LZMA_STREAM_HEADER_SIZE = 12;
export const LZMA_BLOCK_HEADER_SIZE_MAX = 1024;

export const LZMA_FILTER_LZMA1 = 0x40_00_00_00_00_00_00_01n;
export const LZMA_FILTER_LZMA1EXT = 0x40_00_00_00_00_00_00_02n;
export const LZMA_FILTER_LZMA2 = 0x21n;
export const LZMA_FILTER_DELTA = 0x03n;
export const LZMA_FILTER_X86 = 0x04n;
export const LZMA_FILTER_POWERPC = 0x05n;
export const LZMA_FILTER_IA64 = 0x06n;
export const LZMA_FILTER_ARM = 0x07n;
export const LZMA_FILTER_ARMTHUMB = 0x08n;
export const LZMA_FILTER_SPARC = 0x09n;
export const LZMA_FILTER_ARM64 = 0x0an;
export const LZMA_FILTER_RISCV = 0x0bn;
export const LZMA_FILTER_RESERVED_START = 1n << 62n;

export const LZMA_MF_HC3 = 0x03;
export const LZMA_MF_HC4 = 0x04;
export const LZMA_MF_BT2 = 0x12;
export const LZMA_MF_BT3 = 0x13;
export const LZMA_MF_BT4 = 0x14;
export const LZMA_MODE_FAST = 1;
export const LZMA_MODE_NORMAL = 2;
export const LZMA_PRESET_DEFAULT = 6;
export const LZMA_PRESET_EXTREME = 0x80_00_00_00;

/** A position that a coder advances, standing for C's `size_t *`. */
export interface Pos {
  value: number;
}

/** `lzma_next_coder`'s `code` function. */
export interface Coder {
  code(
    input: Uint8Array,
    inPos: Pos,
    inSize: number,
    out: Uint8Array,
    outPos: Pos,
    outSize: number,
    action: number
  ): number;
}

/** `lzma_options_lzma`, without a preset dictionary, which CPython never passes. */
export interface LzmaOptions {
  dictSize: number;
  lc: number;
  lp: number;
  pb: number;
  mode: number;
  niceLen: number;
  mf: number;
  depth: number;
}

/** `lzma_options_delta` (always of type byte) and `lzma_options_bcj`. */
export interface DistanceOptions {
  dist?: number;
  startOffset?: number;
}

export interface Filter {
  id: bigint;
  options: LzmaOptions | DistanceOptions | undefined;
}

export function bufcpy(
  input: Uint8Array,
  inPos: Pos,
  inSize: number,
  out: Uint8Array,
  outPos: Pos,
  outSize: number
): number {
  const size = Math.min(inSize - inPos.value, outSize - outPos.value);
  if (size > 0) {
    out.set(input.subarray(inPos.value, inPos.value + size), outPos.value);
    inPos.value += size;
    outPos.value += size;
  }
  return size;
}

export const read32le = (buf: Uint8Array, at: number): number =>
  (buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> 0;

export function write32le(buf: Uint8Array, at: number, value: number): void {
  for (let i = 0; i < 4; i++) buf[at + i] = (value >>> (8 * i)) & 0xff;
}

export const vliCeil4 = (vli: number): number => Math.ceil(vli / 4) * 4;

export function vliSize(vli: number | bigint): number {
  let value = BigInt(vli);
  if (value > LZMA_VLI_MAX) return 0;
  let size = 0;
  do {
    value >>= 7n;
    size++;
  } while (value !== 0n);
  return size;
}

/** `lzma_vli_encode`; `vliPos` is undefined for the single-call mode. */
export function vliEncode(
  vli: number | bigint,
  vliPos: Pos | undefined,
  out: Uint8Array,
  outPos: Pos,
  outSize: number
): number {
  const single = vliPos === undefined;
  const position = vliPos ?? { value: 0 };
  if (outPos.value >= outSize) return single ? LZMA_PROG_ERROR : LZMA_BUF_ERROR;
  let value = BigInt(vli);
  if (position.value >= 9 || value > LZMA_VLI_MAX) return LZMA_PROG_ERROR;
  value >>= BigInt(position.value * 7);
  while (value >= 0x80n) {
    position.value++;
    out[outPos.value] = Number(value & 0xffn) | 0x80;
    value >>= 7n;
    if (++outPos.value === outSize) return single ? LZMA_PROG_ERROR : LZMA_OK;
  }
  out[outPos.value++] = Number(value);
  position.value++;
  return single ? LZMA_OK : LZMA_STREAM_END;
}

/** The value and position of a variable-length integer `lzma_vli_decode` decodes. */
export class VliState {
  value = 0n;
  pos = 0;
}

/** `lzma_vli_decode`; `single` is the mode without a `vli_pos`. */
// code-gauge-allow functionCognitiveComplexity 24 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
export function vliDecode(state: VliState, single: boolean, input: Uint8Array, inPos: Pos, inSize: number): number {
  if (single) {
    state.pos = 0;
    state.value = 0n;
    if (inPos.value >= inSize) return LZMA_DATA_ERROR;
  } else {
    if (state.pos === 0) state.value = 0n;
    if (state.pos >= 9 || state.value >> BigInt(state.pos * 7) !== 0n) return LZMA_PROG_ERROR;
    if (inPos.value >= inSize) return LZMA_BUF_ERROR;
  }
  do {
    const byte = input[inPos.value++];
    state.value += BigInt(byte & 0x7f) << BigInt(state.pos * 7);
    state.pos++;
    if ((byte & 0x80) === 0) {
      if (byte === 0 && state.pos > 1) return LZMA_DATA_ERROR;
      return single ? LZMA_OK : LZMA_STREAM_END;
    }
    if (state.pos === 9) return LZMA_DATA_ERROR;
  } while (inPos.value < inSize);
  return single ? LZMA_DATA_ERROR : LZMA_OK;
}

export function isLcLpPbValid(options: LzmaOptions): boolean {
  return options.lc <= 4 && options.lp <= 4 && options.lc + options.lp <= 4 && options.pb <= 4;
}

/** `lzma_lzma_lclppb_decode`, which fills `options` and reports whether the byte is invalid. */
export function lclppbDecode(options: LzmaOptions, byte: number): boolean {
  if (byte > (4 * 5 + 4) * 9 + 8) return true;
  options.pb = Math.floor(byte / (9 * 5));
  const rest = byte - options.pb * 9 * 5;
  options.lp = Math.floor(rest / 9);
  options.lc = rest - options.lp * 9;
  return options.lc + options.lp > 4;
}

export const emptyLzmaOptions = (dictSize = 0): LzmaOptions => ({
  dictSize,
  lc: 0,
  lp: 0,
  pb: 0,
  mode: 0,
  niceLen: 0,
  mf: 0,
  depth: 0,
});
