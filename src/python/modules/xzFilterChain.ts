// The filter chains of liblzma 5.8.4 (`filter_common.c`, `filter_encoder.c`, `filter_decoder.c`,
// `filter_flags_*.c`): which filters may follow which, how a raw coder chains them, and their properties.
import {
  type Coder,
  type DistanceOptions,
  emptyLzmaOptions,
  type Filter,
  isLcLpPbValid,
  lclppbDecode,
  LZMA_DATA_ERROR,
  LZMA_FILTER_ARM64,
  LZMA_FILTER_DELTA,
  LZMA_FILTER_LZMA1,
  LZMA_FILTER_LZMA1EXT,
  LZMA_FILTER_LZMA2,
  LZMA_FILTER_RESERVED_START,
  LZMA_FILTER_RISCV,
  LZMA_FILTERS_MAX,
  LZMA_MEMUSAGE_BASE,
  LZMA_OK,
  LZMA_OPTIONS_ERROR,
  LZMA_PROG_ERROR,
  LZMA_VLI_MAX,
  type LzmaOptions,
  type Pos,
  read32le,
  vliDecode,
  vliEncode,
  vliSize,
  VliState,
  write32le,
} from './xzCommon';
import { DeltaCoder, SIMPLE_FILTERS, SimpleCoder } from './xzFilters';
import { lzmaEncoderInit } from './xzLzma2Encoder';
import { getDistSlot } from './xzLzmaCommon';
import { lzma1DecoderInit, lzma2DecoderInit, lzma2DecoderMemusage, lzmaDecoderMemusage } from './xzLzmaDecoder';

export interface CoderResult {
  ret: number;
  coder?: Coder;
}

const isLzma = (id: bigint): boolean =>
  id === LZMA_FILTER_LZMA1 || id === LZMA_FILTER_LZMA1EXT || id === LZMA_FILTER_LZMA2;
const isBcj = (id: bigint): boolean => SIMPLE_FILTERS.has(id) || id === LZMA_FILTER_ARM64 || id === LZMA_FILTER_RISCV;
const isKnown = (id: bigint): boolean => isLzma(id) || isBcj(id) || id === LZMA_FILTER_DELTA;

/** `lzma_validate_chain`. */
export function validateChain(filters: readonly Filter[]): number {
  if (filters.length === 0) return LZMA_PROG_ERROR;
  let changesSizeCount = 0;
  let nonLastOk = true;
  let lastOk = false;
  for (const filter of filters) {
    if (!isKnown(filter.id) || !nonLastOk) return LZMA_OPTIONS_ERROR;
    nonLastOk = !isLzma(filter.id);
    lastOk = isLzma(filter.id);
    if (isLzma(filter.id)) changesSizeCount++;
  }
  if (filters.length > LZMA_FILTERS_MAX || !lastOk || changesSizeCount > 3) return LZMA_OPTIONS_ERROR;
  return LZMA_OK;
}

/** `lzma_raw_encoder_init`: the coder of the last filter, which reads through the ones before it. */
export function rawEncoderInit(filters: readonly Filter[]): CoderResult {
  const ret = validateChain(filters);
  if (ret !== LZMA_OK) return { ret };
  // The ARM64 and RISC-V filters, which CPython's _lzma cannot ask for, are left out.
  if (filters.some((filter) => filter.id === LZMA_FILTER_ARM64 || filter.id === LZMA_FILTER_RISCV)) {
    return { ret: LZMA_OPTIONS_ERROR };
  }
  return encoderAt(filters, filters.length - 1);
}

function encoderAt(filters: readonly Filter[], index: number): CoderResult {
  if (index < 0) return { ret: LZMA_OK };
  const { id, options } = filters[index];
  const rest = (): CoderResult => encoderAt(filters, index - 1);
  if (isLzma(id)) return lzmaEncoderInit(id, options as LzmaOptions | undefined, rest);
  return filterInit(id, options as DistanceOptions | undefined, true, rest);
}

function filterInit(
  id: bigint,
  options: DistanceOptions | undefined,
  isEncoder: boolean,
  rest: () => CoderResult
): CoderResult {
  if (id === LZMA_FILTER_DELTA) {
    if (deltaMemusage(options) === undefined) return { ret: LZMA_OPTIONS_ERROR };
    const next = rest();
    if (next.ret !== LZMA_OK) return next;
    return {
      ret: LZMA_OK,
      coder: new DeltaCoder(options?.dist ?? 1, isEncoder, next.coder),
    };
  }
  const kind = SIMPLE_FILTERS.get(id);
  if (kind === undefined) return { ret: LZMA_OPTIONS_ERROR };
  const nowPos = options?.startOffset ?? 0;
  if (nowPos & (kind.alignment - 1)) return { ret: LZMA_OPTIONS_ERROR };
  const next = rest();
  if (next.ret !== LZMA_OK) return next;
  return {
    ret: LZMA_OK,
    coder: new SimpleCoder(kind, nowPos, isEncoder, next.coder),
  };
}

/** `lzma_raw_decoder_init`: the coder of the first filter, which reads through the ones after it. */
export function rawDecoderInit(filters: readonly Filter[], uncompressedSize?: number): CoderResult {
  const ret = validateChain(filters);
  if (ret !== LZMA_OK) return { ret };
  if (filters.some((filter) => filter.id === LZMA_FILTER_ARM64 || filter.id === LZMA_FILTER_RISCV)) {
    return { ret: LZMA_OPTIONS_ERROR };
  }
  return decoderAt(filters, 0, uncompressedSize);
}

function decoderAt(filters: readonly Filter[], index: number, uncompressedSize?: number): CoderResult {
  if (index === filters.length) return { ret: LZMA_OK };
  const { id, options } = filters[index];
  if (id === LZMA_FILTER_LZMA2) return lzma2DecoderInit(options as LzmaOptions);
  if (isLzma(id)) return lzma1DecoderInit(id, options as LzmaOptions, uncompressedSize);
  return filterInit(id, options as DistanceOptions | undefined, false, () => decoderAt(filters, index + 1));
}

const deltaMemusage = (options: DistanceOptions | undefined): number | undefined =>
  options?.dist !== undefined && options.dist >= 1 && options.dist <= 256 ? 352 : undefined;

/** `lzma_raw_decoder_memusage`, undefined for `UINT64_MAX`. */
export function rawDecoderMemusage(filters: readonly Filter[]): number | undefined {
  if (validateChain(filters) !== LZMA_OK) return undefined;
  let total = 0;
  for (const { id, options } of filters) {
    let usage: number | undefined;
    if (id === LZMA_FILTER_LZMA2) {
      usage = lzma2DecoderMemusage((options as LzmaOptions).dictSize);
    } else if (isLzma(id)) {
      const lzma = options as LzmaOptions;
      usage = isLcLpPbValid(lzma) ? lzmaDecoderMemusage(lzma.dictSize) : undefined;
    } else if (id === LZMA_FILTER_DELTA) {
      usage = deltaMemusage(options as DistanceOptions | undefined);
    } else {
      usage = 1024;
    }
    if (usage === undefined) return undefined;
    total += usage;
  }
  return total + LZMA_MEMUSAGE_BASE;
}

// Properties ---------------------------------------------------------------------------------------------------------

/** `lzma_properties_size`. */
export function propertiesSize(filter: Filter): { ret: number; size: number } {
  const { id, options } = filter;
  if (!isKnown(id))
    return {
      ret: id <= LZMA_VLI_MAX ? LZMA_OPTIONS_ERROR : LZMA_PROG_ERROR,
      size: 0,
    };
  if (id === LZMA_FILTER_LZMA2 || id === LZMA_FILTER_DELTA) return { ret: LZMA_OK, size: 1 };
  if (isLzma(id)) return { ret: LZMA_OK, size: 5 };
  const startOffset = (options as DistanceOptions | undefined)?.startOffset ?? 0;
  return { ret: LZMA_OK, size: startOffset === 0 ? 0 : 4 };
}

/** `lzma_properties_encode` into `out` at `at`. */
export function propertiesEncode(filter: Filter, out: Uint8Array, at: number): number {
  const { id, options } = filter;
  if (!isKnown(id)) return LZMA_PROG_ERROR;
  if (options === undefined && (isLzma(id) || id === LZMA_FILTER_DELTA)) return LZMA_PROG_ERROR;
  if (id === LZMA_FILTER_LZMA2) {
    out[at] = lzma2DictByte((options as LzmaOptions).dictSize);
  } else if (isLzma(id)) {
    const lzma = options as LzmaOptions;
    if (!isLcLpPbValid(lzma)) return LZMA_PROG_ERROR;
    out[at] = (lzma.pb * 5 + lzma.lp) * 9 + lzma.lc;
    write32le(out, at + 1, lzma.dictSize);
  } else if (id === LZMA_FILTER_DELTA) {
    const delta = options as DistanceOptions;
    if (deltaMemusage(delta) === undefined) return LZMA_PROG_ERROR;
    out[at] = (delta.dist as number) - 1;
  } else {
    const startOffset = (options as DistanceOptions | undefined)?.startOffset ?? 0;
    if (startOffset !== 0) write32le(out, at, startOffset);
  }
  return LZMA_OK;
}

function lzma2DictByte(dictSize: number): number {
  let d = Math.max(dictSize, 4096) - 1;
  d |= d >>> 2;
  d |= d >>> 3;
  d |= d >>> 4;
  d |= d >>> 8;
  d |= d >>> 16;
  d >>>= 0;
  return d === 0xff_ff_ff_ff ? 40 : getDistSlot(d + 1) - 24;
}

/** `lzma_properties_decode`. */
// code-gauge-allow functionCognitiveComplexity 18 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
export function propertiesDecode(
  id: bigint,
  props: Uint8Array
): { ret: number; options?: LzmaOptions | DistanceOptions } {
  if (!isKnown(id)) return { ret: LZMA_OPTIONS_ERROR };
  if (id === LZMA_FILTER_LZMA2) {
    if (props.length !== 1 || props[0] & 0xc0 || props[0] > 40) return { ret: LZMA_OPTIONS_ERROR };
    const dictSize = props[0] === 40 ? 0xff_ff_ff_ff : (2 | (props[0] & 1)) * 2 ** (Math.floor(props[0] / 2) + 11);
    return { ret: LZMA_OK, options: emptyLzmaOptions(dictSize) };
  }
  if (isLzma(id)) {
    if (props.length !== 5) return { ret: LZMA_OPTIONS_ERROR };
    const options = emptyLzmaOptions();
    if (lclppbDecode(options, props[0])) return { ret: LZMA_OPTIONS_ERROR };
    options.dictSize = read32le(props, 1);
    return { ret: LZMA_OK, options };
  }
  if (id === LZMA_FILTER_DELTA) {
    if (props.length !== 1) return { ret: LZMA_OPTIONS_ERROR };
    return { ret: LZMA_OK, options: { dist: props[0] + 1 } };
  }
  if (props.length === 0) return { ret: LZMA_OK };
  if (props.length !== 4) return { ret: LZMA_OPTIONS_ERROR };
  const startOffset = read32le(props, 0);
  return {
    ret: LZMA_OK,
    options: startOffset === 0 ? undefined : { startOffset },
  };
}

// Filter flags -------------------------------------------------------------------------------------------------------

/** `lzma_filter_flags_size`. */
export function filterFlagsSize(filter: Filter): { ret: number; size: number } {
  if (filter.id >= LZMA_FILTER_RESERVED_START) return { ret: LZMA_PROG_ERROR, size: 0 };
  const props = propertiesSize(filter);
  if (props.ret !== LZMA_OK) return props;
  return {
    ret: LZMA_OK,
    size: props.size + vliSize(filter.id) + vliSize(props.size),
  };
}

/** `lzma_filter_flags_encode`. */
export function filterFlagsEncode(filter: Filter, out: Uint8Array, outPos: Pos, outSize: number): number {
  if (filter.id >= LZMA_FILTER_RESERVED_START) return LZMA_PROG_ERROR;
  let ret = vliEncode(filter.id, undefined, out, outPos, outSize);
  if (ret !== LZMA_OK) return ret;
  const props = propertiesSize(filter);
  if (props.ret !== LZMA_OK) return props.ret;
  ret = vliEncode(props.size, undefined, out, outPos, outSize);
  if (ret !== LZMA_OK) return ret;
  if (outSize - outPos.value < props.size) return LZMA_PROG_ERROR;
  ret = propertiesEncode(filter, out, outPos.value);
  if (ret !== LZMA_OK) return ret;
  outPos.value += props.size;
  return LZMA_OK;
}

/** `lzma_filter_flags_decode`. */
export function filterFlagsDecode(input: Uint8Array, inPos: Pos, inSize: number): { ret: number; filter?: Filter } {
  const vli = new VliState();
  let ret = vliDecode(vli, true, input, inPos, inSize);
  if (ret !== LZMA_OK) return { ret };
  const id = vli.value;
  if (id >= LZMA_FILTER_RESERVED_START) return { ret: LZMA_DATA_ERROR };
  ret = vliDecode(vli, true, input, inPos, inSize);
  if (ret !== LZMA_OK) return { ret };
  const propsSize = vli.value;
  if (BigInt(inSize - inPos.value) < propsSize) return { ret: LZMA_DATA_ERROR };
  const size = Number(propsSize);
  const decoded = propertiesDecode(id, input.subarray(inPos.value, inPos.value + size));
  inPos.value += size;
  return { ret: decoded.ret, filter: { id, options: decoded.options } };
}
