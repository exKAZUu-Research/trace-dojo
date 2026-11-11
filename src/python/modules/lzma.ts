// CPython's `_lzma` (`Modules/_lzmamodule.c`) over a transcription of liblzma 5.8.4, the version the reference
// CPython links, and `lzma` over CPython's own module.
import { newBytes } from '../bytesValues';
import { builtin, method } from '../define';
import { getItem } from '../items';
import { registerModule } from '../modules';
import { toIndex } from '../numbers';
import { lengthOf } from '../objects';
import { registerSourceModule } from '../sourceModules';
import {
  builtinClass,
  exceptionClassNamed,
  newDict,
  newException,
  None,
  pyError,
  typeError,
  valueError,
} from '../types';
import { PyDict, PyError, PyOpaque, type PyValue } from '../values';
import { cInt, clinicArgs, clinicMethod, cSsize } from './clinicArgs';
import { LZMA_SOURCE } from './lzmaSource';
import { builtinClassWithBase } from './moduleClasses';
import { readOnlyAttribute } from './re/attributes';
import { AloneDecoder, AutoDecoder } from './xzAloneDecoders';
import {
  checkIsSupported,
  LZMA_CHECK_CRC32,
  LZMA_CHECK_CRC64,
  LZMA_CHECK_ID_MAX,
  LZMA_CHECK_NONE,
  LZMA_CHECK_SHA256,
} from './xzCheck';
import {
  type Coder,
  type DistanceOptions,
  type Filter,
  LZMA_BUF_ERROR,
  LZMA_DATA_ERROR,
  LZMA_FILTER_ARM,
  LZMA_FILTER_ARMTHUMB,
  LZMA_FILTER_DELTA,
  LZMA_FILTER_IA64,
  LZMA_FILTER_LZMA1,
  LZMA_FILTER_LZMA2,
  LZMA_FILTER_POWERPC,
  LZMA_FILTER_SPARC,
  LZMA_FILTER_X86,
  LZMA_FILTERS_MAX,
  LZMA_FINISH,
  LZMA_FORMAT_ERROR,
  LZMA_GET_CHECK,
  LZMA_MEM_ERROR,
  LZMA_MEMLIMIT_ERROR,
  LZMA_MF_BT2,
  LZMA_MF_BT3,
  LZMA_MF_BT4,
  LZMA_MF_HC3,
  LZMA_MF_HC4,
  LZMA_MODE_FAST,
  LZMA_MODE_NORMAL,
  LZMA_NO_CHECK,
  LZMA_OK,
  LZMA_OPTIONS_ERROR,
  LZMA_PRESET_DEFAULT,
  LZMA_PRESET_EXTREME,
  LZMA_PROG_ERROR,
  LZMA_RUN,
  LZMA_STREAM_END,
  LZMA_UNSUPPORTED_CHECK,
  type LzmaOptions,
} from './xzCommon';
import { StreamDecoder } from './xzDecoders';
import { aloneEncoderInit, streamEncoderInit } from './xzEncoders';
import {
  type CoderResult,
  propertiesDecode,
  propertiesEncode,
  propertiesSize,
  rawDecoderInit,
  rawEncoderInit,
} from './xzFilterChain';
import { LzmaStream } from './xzStream';
import { dataArgument, OutputBuffer } from './zlib';
import { ZStream } from './zlibDeflate';

const FORMAT_AUTO = 0;
const FORMAT_XZ = 1;
const FORMAT_ALONE = 2;
const FORMAT_RAW = 3;
const CHECK_UNKNOWN = LZMA_CHECK_ID_MAX + 1;

const compressorClass = builtinClass('LZMACompressor');
const decompressorClass = builtinClass('LZMADecompressor');
for (const cls of [compressorClass, decompressorClass]) {
  cls.module = '_lzma';
  cls.typeName = `_lzma.${cls.name}`;
}
const lzmaErrorClass = builtinClassWithBase('LZMAError', exceptionClassNamed('Exception'), '_lzma');
lzmaErrorClass.doc = 'Call to liblzma failed.';

const lzmaError = (message: string): PyError => new PyError(newException(lzmaErrorClass, [message]));

const ERROR_MESSAGES = new Map<number, string>([
  [LZMA_UNSUPPORTED_CHECK, 'Unsupported integrity check'],
  [LZMA_MEMLIMIT_ERROR, 'Memory usage limit exceeded'],
  [LZMA_FORMAT_ERROR, 'Input format not supported by decoder'],
  [LZMA_OPTIONS_ERROR, 'Invalid or unsupported options'],
  [LZMA_DATA_ERROR, 'Corrupt input data'],
  [LZMA_BUF_ERROR, 'Insufficient buffer space'],
  [LZMA_PROG_ERROR, 'Internal error'],
]);

/** CPython's `catch_lzma_error`. */
function catchLzmaError(ret: number): void {
  if (ret === LZMA_OK || ret === LZMA_GET_CHECK || ret === LZMA_NO_CHECK || ret === LZMA_STREAM_END) return;
  if (ret === LZMA_MEM_ERROR) throw pyError('MemoryError');
  throw lzmaError(ERROR_MESSAGES.get(ret) ?? `Unrecognized error from liblzma: ${ret}`);
}

// Conversions --------------------------------------------------------------------------------------------------------

/** `_PyLong_UInt32_Converter` and its kind for `type`: an integer of `bits` bits that is not negative. */
function unsignedArg(value: PyValue, bits: bigint, type: string): bigint {
  const result = toIndex(value);
  if (result < 0n) throw valueError('Cannot convert negative int');
  if (result >= 1n << bits) throw pyError('OverflowError', `Python int too large for C ${type}`);
  return result;
}

const uint32Arg = (value: PyValue): number => Number(unsignedArg(value, 32n, 'uint32_t'));

/** The `i` format of `PyArg_ParseTupleAndKeywords`. */
function parseInt(value: PyValue | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const result = toIndex(value);
  if (result > 2n ** 63n - 1n || result < -(2n ** 63n)) {
    throw pyError('OverflowError', 'Python int too large to convert to C long');
  }
  if (result > 2_147_483_647n) throw pyError('OverflowError', 'signed integer is greater than maximum');
  if (result < -2_147_483_648n) throw pyError('OverflowError', 'signed integer is less than minimum');
  return Number(result);
}

// Filter specifiers --------------------------------------------------------------------------------------------------

/** `lzma_lzma_preset`, or undefined for an invalid preset. */
// code-gauge-allow functionCognitiveComplexity 19 -- Transcribes lzma_lzma_preset of liblzma 5.8.4, keeping it comparable with the C.
function lzmaPreset(preset: number): LzmaOptions | undefined {
  const level = preset & 0x1f;
  const flags = preset & ~0x1f;
  if (level > 9 || flags & ~LZMA_PRESET_EXTREME) return undefined;
  const dictPow2 = [18, 20, 21, 22, 22, 23, 23, 24, 25, 26][level];
  const options: LzmaOptions = {
    dictSize: 2 ** dictPow2,
    lc: 3,
    lp: 0,
    pb: 2,
    mode: 0,
    niceLen: 0,
    mf: 0,
    depth: 0,
  };
  if (level <= 3) {
    options.mode = LZMA_MODE_FAST;
    options.mf = level === 0 ? LZMA_MF_HC3 : LZMA_MF_HC4;
    options.niceLen = level <= 1 ? 128 : 273;
    options.depth = [4, 8, 24, 48][level];
  } else {
    options.mode = LZMA_MODE_NORMAL;
    options.mf = LZMA_MF_BT4;
    options.niceLen = level === 4 ? 16 : level === 5 ? 32 : 64;
  }
  if (flags & LZMA_PRESET_EXTREME) {
    options.mode = LZMA_MODE_NORMAL;
    options.mf = LZMA_MF_BT4;
    const short = level === 3 || level === 5;
    options.niceLen = short ? 192 : 273;
    options.depth = short ? 0 : 512;
  }
  return options;
}

/** `PyMapping_GetOptionalItemString`. */
function optionalItem(spec: PyValue, key: string): PyValue | undefined {
  try {
    return getItem(spec, key);
  } catch (error) {
    if (error instanceof PyError && error.exception.cls === exceptionClassNamed('KeyError')) return undefined;
    throw error;
  }
}

/**
 * `PyArg_ParseTupleAndKeywords` over a specifier's entries: every key must be one of `names`, and each value must
 * convert. Any failure becomes CPython's ValueError for the filter.
 */
function specEntries(spec: PyValue, names: readonly string[], filterName: string): Map<string, number> {
  const fail = (): PyError => valueError(`Invalid filter specifier for ${filterName} filter`);
  if (!(spec instanceof PyDict)) throw fail();
  const values = new Map<string, number>();
  for (const { key, value } of spec.store.ordered()) {
    if (typeof key !== 'string' || !names.includes(key)) throw fail();
    if (key === 'id' || key === 'preset') continue;
    try {
      values.set(key, uint32Arg(value));
    } catch (error) {
      if (error instanceof PyError) throw fail();
      throw error;
    }
  }
  return values;
}

const LZMA_NAMES = ['id', 'preset', 'dict_size', 'lc', 'lp', 'pb', 'mode', 'nice_len', 'mf', 'depth'];

function parseLzmaSpec(spec: PyValue): LzmaOptions {
  const presetValue = optionalItem(spec, 'preset');
  const preset = presetValue === undefined ? LZMA_PRESET_DEFAULT : uint32Arg(presetValue);
  const options = lzmaPreset(preset);
  if (options === undefined) throw lzmaError(`Invalid compression preset: ${preset}`);
  const values = specEntries(spec, LZMA_NAMES, 'LZMA');
  const fields: [string, keyof LzmaOptions][] = [
    ['dict_size', 'dictSize'],
    ['lc', 'lc'],
    ['lp', 'lp'],
    ['pb', 'pb'],
    ['mode', 'mode'],
    ['nice_len', 'niceLen'],
    ['mf', 'mf'],
    ['depth', 'depth'],
  ];
  for (const [name, field] of fields) {
    const value = values.get(name);
    if (value !== undefined) options[field] = value;
  }
  return options;
}

const BCJ_FILTERS = new Set([
  LZMA_FILTER_X86,
  LZMA_FILTER_POWERPC,
  LZMA_FILTER_IA64,
  LZMA_FILTER_ARM,
  LZMA_FILTER_ARMTHUMB,
  LZMA_FILTER_SPARC,
]);

/** CPython's `lzma_filter_converter`. */
function parseFilter(spec: PyValue): Filter {
  if (!isMapping(spec)) throw typeError('Filter specifier must be a dict or dict-like object');
  const idValue = optionalItem(spec, 'id');
  if (idValue === undefined) throw valueError('Filter specifier must have an "id" entry');
  const id = unsignedArg(idValue, 64n, 'lzma_vli');
  if (id === LZMA_FILTER_LZMA1 || id === LZMA_FILTER_LZMA2) return { id, options: parseLzmaSpec(spec) };
  if (id === LZMA_FILTER_DELTA) {
    return {
      id,
      options: {
        dist: specEntries(spec, ['id', 'dist'], 'delta').get('dist') ?? 1,
      },
    };
  }
  if (BCJ_FILTERS.has(id)) {
    return {
      id,
      options: {
        startOffset: specEntries(spec, ['id', 'start_offset'], 'BCJ').get('start_offset') ?? 0,
      },
    };
  }
  throw valueError(`Invalid filter ID: ${id}`);
}

/** `PyMapping_Check`: whether the value's type can be subscripted. */
function isMapping(value: PyValue): boolean {
  if (typeof value === 'string' || value instanceof PyDict) return true;
  if (typeof value !== 'object' || value === null) return false;
  return value.cls.mro.some((cls) => cls.dict.has('__getitem__'));
}

/** CPython's `parse_filter_chain_spec`. */
function parseFilterChain(specs: PyValue): Filter[] {
  if (specs instanceof PyDict) throw typeError(`${specs.cls.name} is not a sequence`);
  const count = lengthOf(specs);
  if (count > LZMA_FILTERS_MAX)
    throw valueError(`Too many filters - liblzma supports a maximum of ${LZMA_FILTERS_MAX}`);
  const filters: Filter[] = [];
  for (let i = 0; i < count; i++) filters.push(parseFilter(getItem(specs, BigInt(i))));
  return filters;
}

/** CPython's `build_filter_spec`. */
function buildFilterSpec(filter: Filter): PyValue {
  const entries: [string, bigint][] = [['id', filter.id]];
  const { id } = filter;
  if (id === LZMA_FILTER_LZMA1) {
    const options = filter.options as LzmaOptions;
    entries.push(['lc', BigInt(options.lc)], ['lp', BigInt(options.lp)], ['pb', BigInt(options.pb)]);
    entries.push(['dict_size', BigInt(options.dictSize)]);
  } else if (id === LZMA_FILTER_LZMA2) {
    entries.push(['dict_size', BigInt((filter.options as LzmaOptions).dictSize)]);
  } else if (id === LZMA_FILTER_DELTA) {
    entries.push(['dist', BigInt((filter.options as DistanceOptions).dist ?? 1)]);
  } else if (BCJ_FILTERS.has(id)) {
    const options = filter.options as DistanceOptions | undefined;
    if (options !== undefined) entries.push(['start_offset', BigInt(options.startOffset ?? 0)]);
  } else {
    throw valueError(`Invalid filter ID: ${id}`);
  }
  return newDict(entries);
}

// LZMACompressor -----------------------------------------------------------------------------------------------------

interface CompressorState {
  stream: LzmaStream;
  flushed: boolean;
}

const compressorOf = (self: PyValue): CompressorState => (self as PyOpaque).data as CompressorState;

function coderOrThrow(result: CoderResult): Coder {
  catchLzmaError(result.ret);
  return result.coder as Coder;
}

// code-gauge-allow functionNcss 34 -- Follows CPython's _lzmamodule.c, whose order of checks decides which error is raised.
// code-gauge-allow functionCognitiveComplexity 19 -- Follows CPython's _lzmamodule.c, whose order of checks decides which error is raised.
compressorClass.construct = (cls, args, kwargs) => {
  const [formatValue, checkValue, presetValue, filterValue] = clinicArgs(
    {
      name: 'LZMACompressor',
      params: ['format', 'check', 'preset', 'filters'],
      positionalOnly: 0,
      required: 0,
    },
    args,
    kwargs
  );
  const format = parseInt(formatValue, FORMAT_XZ);
  let check = parseInt(checkValue, -1);
  const presetObject = presetValue ?? None;
  const filterSpecs = filterValue ?? None;
  if (format !== FORMAT_XZ && check !== -1 && check !== LZMA_CHECK_NONE) {
    throw valueError('Integrity checks are only supported by FORMAT_XZ');
  }
  if (presetObject !== None && filterSpecs !== None) throw valueError('Cannot specify both preset and filter chain');
  const preset = presetObject === None ? LZMA_PRESET_DEFAULT : uint32Arg(presetObject);
  let coder: Coder;
  if (format === FORMAT_XZ) {
    if (check === -1) check = LZMA_CHECK_CRC64;
    if (filterSpecs === None) {
      const options = lzmaPreset(preset);
      if (options === undefined) throw lzmaError(ERROR_MESSAGES.get(LZMA_OPTIONS_ERROR) as string);
      coder = coderOrThrow(streamEncoderInit([{ id: LZMA_FILTER_LZMA2, options }], check));
    } else {
      coder = coderOrThrow(streamEncoderInit(parseFilterChain(filterSpecs), check));
    }
  } else if (format === FORMAT_ALONE) {
    coder = coderOrThrow(aloneEncoderInit(aloneOptions(preset, filterSpecs)));
  } else if (format === FORMAT_RAW) {
    if (filterSpecs === None) throw valueError('Must specify filters for FORMAT_RAW');
    coder = coderOrThrow(rawEncoderInit(parseFilterChain(filterSpecs)));
  } else {
    throw valueError(`Invalid container format: ${format}`);
  }
  const state: CompressorState = {
    stream: new LzmaStream(new ZStream(), coder),
    flushed: false,
  };
  return new PyOpaque(cls, 'LZMACompressor', state);
};

function aloneOptions(preset: number, filterSpecs: PyValue): LzmaOptions {
  if (filterSpecs === None) {
    const options = lzmaPreset(preset);
    if (options === undefined) throw lzmaError(`Invalid compression preset: ${preset}`);
    return options;
  }
  const filters = parseFilterChain(filterSpecs);
  if (filters.length !== 1 || filters[0].id !== LZMA_FILTER_LZMA1) {
    throw valueError('Invalid filter chain for FORMAT_ALONE - must be a single LZMA1 filter');
  }
  return filters[0].options as LzmaOptions;
}

/** CPython's `compress`, which grows the output as `_BlocksOutputBuffer` does. */
function compress(stream: LzmaStream, data: Uint8Array, action: number): PyValue {
  const { strm } = stream;
  const buffer = new OutputBuffer(strm);
  Object.assign(strm, { input: data, nextIn: 0, availIn: data.length });
  for (;;) {
    let ret = stream.code(action);
    if (ret === LZMA_BUF_ERROR && data.length === 0 && strm.availOut > 0) ret = LZMA_OK;
    catchLzmaError(ret);
    if ((action === LZMA_RUN && strm.availIn === 0) || (action === LZMA_FINISH && ret === LZMA_STREAM_END)) break;
    if (strm.availOut === 0) buffer.grow();
  }
  return newBytes(buffer.finish());
}

method(compressorClass, 'compress', 'one', 1, 1, (self, [data]) => {
  const state = compressorOf(self);
  const input = dataArgument(data);
  if (state.flushed) throw valueError('Compressor has been flushed');
  return compress(state.stream, input, LZMA_RUN);
});
method(compressorClass, 'flush', 'none', 0, 0, (self) => {
  const state = compressorOf(self);
  if (state.flushed) throw valueError('Repeated call to flush()');
  state.flushed = true;
  return compress(state.stream, new Uint8Array(0), LZMA_FINISH);
});

// LZMADecompressor ---------------------------------------------------------------------------------------------------

interface DecompressorState {
  stream: LzmaStream;
  check: number;
  eof: boolean;
  unusedData: Uint8Array;
  needsInput: boolean;
  /** The input liblzma has not consumed, which CPython keeps in its input buffer; undefined for `next_in == NULL`. */
  pending: Uint8Array | undefined;
}

const decompressorOf = (self: PyValue): DecompressorState => (self as PyOpaque).data as DecompressorState;

// code-gauge-allow functionNcss 33 -- Follows CPython's _lzmamodule.c, whose order of checks decides which error is raised.
decompressorClass.construct = (cls, args, kwargs) => {
  const [formatValue, memlimitValue, filterValue] = clinicArgs(
    {
      name: 'LZMADecompressor',
      params: ['format', 'memlimit', 'filters'],
      positionalOnly: 0,
      required: 0,
    },
    args,
    kwargs
  );
  const format = cInt(formatValue, FORMAT_AUTO);
  const memlimit = memlimitValue ?? None;
  const filters = filterValue ?? None;
  let limit = Number.POSITIVE_INFINITY;
  if (memlimit !== None) {
    if (format === FORMAT_RAW) throw valueError('Cannot specify memory limit with FORMAT_RAW');
    limit = Number(unsignedArg(memlimit, 64n, 'uint64_t'));
  }
  if (format === FORMAT_RAW && filters === None) throw valueError('Must specify filters for FORMAT_RAW');
  if (format !== FORMAT_RAW && filters !== None) throw valueError('Cannot specify filters except with FORMAT_RAW');
  let check = CHECK_UNKNOWN;
  let coder: Coder;
  if (format === FORMAT_AUTO) {
    coder = new AutoDecoder(limit);
  } else if (format === FORMAT_XZ) {
    coder = new StreamDecoder(limit);
  } else if (format === FORMAT_ALONE) {
    check = LZMA_CHECK_NONE;
    coder = new AloneDecoder(limit, false);
  } else if (format === FORMAT_RAW) {
    check = LZMA_CHECK_NONE;
    coder = coderOrThrow(rawDecoderInit(parseFilterChain(filters)));
  } else {
    throw valueError(`Invalid container format: ${format}`);
  }
  const state: DecompressorState = {
    stream: new LzmaStream(new ZStream(), coder),
    check,
    eof: false,
    unusedData: new Uint8Array(0),
    needsInput: true,
    pending: undefined,
  };
  return new PyOpaque(cls, 'LZMADecompressor', state);
};

clinicMethod(
  decompressorClass,
  { name: 'decompress', params: ['data', 'max_length'], positionalOnly: 0, required: 1 },
  (self, [data, maxLength]) => decompress(decompressorOf(self), dataArgument(data), cSsize(maxLength, -1))
);

/** CPython's `decompress`, with its input buffer. */
function decompress(state: DecompressorState, data: Uint8Array, maxLength: number): PyValue {
  if (state.eof) throw new PyError(newException(exceptionClassNamed('EOFError'), ['Already at end of stream']));
  const { strm } = state.stream;
  let input = data;
  if (state.pending !== undefined) {
    input = new Uint8Array(state.pending.length + data.length);
    input.set(state.pending);
    input.set(data, state.pending.length);
  }
  Object.assign(strm, { input, nextIn: 0, availIn: input.length });
  let result: PyValue;
  try {
    result = decompressBuf(state, maxLength);
  } catch (error) {
    state.pending = undefined;
    throw error;
  }
  if (state.eof) {
    state.needsInput = false;
    if (strm.availIn > 0) state.unusedData = input.slice(strm.nextIn);
  } else if (strm.availIn === 0) {
    state.pending = undefined;
    state.needsInput = strm.availOut !== 0;
  } else {
    state.needsInput = false;
    state.pending = input.slice(strm.nextIn);
  }
  return result;
}

/** CPython's `decompress_buf`. */
function decompressBuf(state: DecompressorState, maxLength: number): PyValue {
  const { stream } = state;
  const { strm } = stream;
  const buffer = new OutputBuffer(strm, maxLength);
  for (;;) {
    let ret = stream.code(LZMA_RUN);
    if (ret === LZMA_BUF_ERROR && strm.availIn === 0 && strm.availOut > 0) ret = LZMA_OK;
    catchLzmaError(ret);
    if (ret === LZMA_GET_CHECK || ret === LZMA_NO_CHECK) state.check = stream.getCheck();
    if (ret === LZMA_STREAM_END) {
      state.eof = true;
      break;
    }
    if (strm.availOut === 0) {
      if (buffer.size === maxLength) break;
      buffer.grow();
    } else if (strm.availIn === 0) {
      break;
    }
  }
  return newBytes(buffer.finish());
}

readOnlyAttribute(decompressorClass, 'check', 'member', (self) => BigInt(decompressorOf(self).check));
readOnlyAttribute(decompressorClass, 'eof', 'member', (self) => decompressorOf(self).eof);
readOnlyAttribute(decompressorClass, 'needs_input', 'member', (self) => decompressorOf(self).needsInput);
readOnlyAttribute(decompressorClass, 'unused_data', 'member', (self) => newBytes(decompressorOf(self).unusedData));

// The module ---------------------------------------------------------------------------------------------------------

function encodeFilterProperties(spec: PyValue): PyValue {
  const filter = parseFilter(spec);
  const size = propertiesSize(filter);
  catchLzmaError(size.ret);
  const out = new Uint8Array(size.size);
  catchLzmaError(propertiesEncode(filter, out, 0));
  return newBytes(out);
}

function decodeFilterProperties(args: PyValue[]): PyValue {
  const id = unsignedArg(args[0], 64n, 'lzma_vli');
  const props = dataArgument(args[1]);
  const decoded = propertiesDecode(id, props);
  catchLzmaError(decoded.ret);
  return buildFilterSpec({ id, options: decoded.options });
}

const CONSTANTS: [string, bigint][] = [
  ['FORMAT_AUTO', BigInt(FORMAT_AUTO)],
  ['FORMAT_XZ', BigInt(FORMAT_XZ)],
  ['FORMAT_ALONE', BigInt(FORMAT_ALONE)],
  ['FORMAT_RAW', BigInt(FORMAT_RAW)],
  ['CHECK_NONE', BigInt(LZMA_CHECK_NONE)],
  ['CHECK_CRC32', BigInt(LZMA_CHECK_CRC32)],
  ['CHECK_CRC64', BigInt(LZMA_CHECK_CRC64)],
  ['CHECK_SHA256', BigInt(LZMA_CHECK_SHA256)],
  ['CHECK_ID_MAX', BigInt(LZMA_CHECK_ID_MAX)],
  ['CHECK_UNKNOWN', BigInt(CHECK_UNKNOWN)],
  ['FILTER_LZMA1', LZMA_FILTER_LZMA1],
  ['FILTER_LZMA2', LZMA_FILTER_LZMA2],
  ['FILTER_DELTA', LZMA_FILTER_DELTA],
  ['FILTER_X86', LZMA_FILTER_X86],
  ['FILTER_IA64', LZMA_FILTER_IA64],
  ['FILTER_ARM', LZMA_FILTER_ARM],
  ['FILTER_ARMTHUMB', LZMA_FILTER_ARMTHUMB],
  ['FILTER_SPARC', LZMA_FILTER_SPARC],
  ['FILTER_POWERPC', LZMA_FILTER_POWERPC],
  ['MF_HC3', BigInt(LZMA_MF_HC3)],
  ['MF_HC4', BigInt(LZMA_MF_HC4)],
  ['MF_BT2', BigInt(LZMA_MF_BT2)],
  ['MF_BT3', BigInt(LZMA_MF_BT3)],
  ['MF_BT4', BigInt(LZMA_MF_BT4)],
  ['MODE_FAST', BigInt(LZMA_MODE_FAST)],
  ['MODE_NORMAL', BigInt(LZMA_MODE_NORMAL)],
  ['PRESET_DEFAULT', BigInt(LZMA_PRESET_DEFAULT)],
  ['PRESET_EXTREME', BigInt(LZMA_PRESET_EXTREME)],
];

registerModule(
  '_lzma',
  () =>
    new Map<string, PyValue>([
      ...CONSTANTS,
      ['LZMAError', lzmaErrorClass],
      ['LZMACompressor', compressorClass],
      ['LZMADecompressor', decompressorClass],
      ['is_check_supported', builtin('is_check_supported', 'one', 1, 1, ([id]) => checkIsSupported(cInt(id, 0)))],
      [
        '_encode_filter_properties',
        builtin('_encode_filter_properties', 'one', 1, 1, ([spec]) => encodeFilterProperties(spec)),
      ],
      ['_decode_filter_properties', builtin('_decode_filter_properties', 'expected', 2, 2, decodeFilterProperties)],
    ])
);
registerSourceModule('lzma', LZMA_SOURCE);
// CPython 3.14's `compression/lzma.py`, which re-exports the module.
registerSourceModule('compression.lzma', 'import lzma\n__doc__ = lzma.__doc__\ndel lzma\n\nfrom lzma import *\n');
