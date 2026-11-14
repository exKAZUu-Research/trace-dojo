// CPython's zlib module over a transcription of zlib 1.2.12, the version the reference CPython links.
import { LIMITS } from '../../interpreter/limits';
import { bytesLikeData, newBytes } from '../bytesValues';
import { builtin, method } from '../define';
import { registerModule } from '../modules';
import { currentRuntime } from '../runtimeContext';
import {
  builtinClass,
  defineMethod,
  exceptionClassNamed,
  nativeFunction,
  newException,
  None,
  propertyClass,
  typeError,
  typeName,
  valueError,
} from '../types';
import { type Kwargs, type PyClass, PyDescriptor, PyError, PyOpaque, type PyValue } from '../values';
import { crc32, uint32Argument } from './binascii';
import { cInt, clinicArgs, type ClinicSpec, cSsize } from './clinicArgs';
import { builtinClassWithBase } from './moduleClasses';
import {
  adler32,
  Deflater,
  Z_BLOCK,
  Z_BUF_ERROR,
  Z_FINISH,
  Z_FIXED,
  Z_NO_FLUSH,
  Z_OK,
  Z_STREAM_END,
  Z_STREAM_ERROR,
  type ZStream,
} from './zlibDeflate';
import { Inflater, Z_NEED_DICT } from './zlibInflate';

const Z_SYNC_FLUSH = 2;
const DEF_BUF_SIZE = 16_384;
const zlibErrorClass = builtinClassWithBase('error', exceptionClassNamed('Exception'), 'zlib');

/** CPython's `_BlocksOutputBuffer`: the sizes of the output blocks it hands zlib decide stored blocks and windows. */
const BLOCK_SIZES = [
  32 * 1024,
  64 * 1024,
  256 * 1024,
  1024 * 1024,
  4 * 1024 * 1024,
  8 * 1024 * 1024,
  16 * 1024 * 1024,
  16 * 1024 * 1024,
  32 * 1024 * 1024,
  32 * 1024 * 1024,
  32 * 1024 * 1024,
  32 * 1024 * 1024,
  64 * 1024 * 1024,
  64 * 1024 * 1024,
  128 * 1024 * 1024,
  128 * 1024 * 1024,
  256 * 1024 * 1024,
];

export class OutputBuffer {
  private readonly blocks: Uint8Array[] = [];
  private allocated = 0;

  constructor(
    private readonly strm: ZStream,
    private readonly maxLength = -1,
    initSize?: number
  ) {
    if (initSize === undefined) this.grow();
    else this.addBlock(initSize);
  }

  get size(): number {
    return this.allocated - this.strm.availOut;
  }

  grow(): void {
    let size = BLOCK_SIZES[Math.min(this.blocks.length, BLOCK_SIZES.length - 1)];
    if (this.maxLength >= 0) size = Math.min(size, this.maxLength - this.allocated);
    // The capacity stops one byte past the result's length limit, which is enough to tell a result beyond it.
    const room = LIMITS.maxStringLength + 1 - this.allocated;
    if (room <= 0) currentRuntime().ensureStringFits(this.allocated);
    this.addBlock(Math.min(size, room));
  }

  finish(): Uint8Array {
    currentRuntime().ensureStringFits(this.size);
    const result = new Uint8Array(this.size);
    let offset = 0;
    for (const block of this.blocks) {
      const part = block.subarray(0, Math.min(block.length, result.length - offset));
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  private addBlock(size: number): void {
    if (size > LIMITS.maxStringLength + 1 - this.allocated) currentRuntime().ensureStringFits(this.allocated + size);
    const block = new Uint8Array(size);
    this.blocks.push(block);
    this.allocated += size;
    Object.assign(this.strm, { output: block, nextOut: 0, availOut: size });
  }
}

export function zlibError(strm: ZStream, err: number, message: string): PyError {
  let text = strm.msg;
  if (text === undefined) {
    if (err === Z_BUF_ERROR) text = 'incomplete or truncated stream';
    else if (err === Z_STREAM_ERROR) text = 'inconsistent stream state';
    else if (err === -3) text = 'invalid input data';
  }
  return new PyError(
    newException(zlibErrorClass, [text === undefined ? `Error ${err} ${message}` : `Error ${err} ${message}: ${text}`])
  );
}

export function dataArgument(value: PyValue | undefined): Uint8Array {
  const data = value === undefined ? undefined : bytesLikeData(value);
  if (data === undefined) throw typeError(`a bytes-like object is required, not '${typeName(value as PyValue)}'`);
  return data;
}

function setInput(strm: ZStream, data: Uint8Array): void {
  currentRuntime().scan(data.length);
  Object.assign(strm, { input: data, nextIn: 0, availIn: data.length });
}

function validDeflateOptions(level: number, wbits: number, memLevel: number, strategy: number, method = 8): boolean {
  const bits = wbits < 0 ? -wbits : wbits > 15 ? wbits - 16 : wbits;
  return (
    method === 8 &&
    level >= -1 &&
    level <= 9 &&
    memLevel >= 1 &&
    memLevel <= 9 &&
    strategy >= 0 &&
    strategy <= Z_FIXED &&
    bits >= 8 &&
    bits <= 15 &&
    !(bits === 8 && (wbits < 0 || wbits > 15)) &&
    wbits >= -15
  );
}

function validInflateBits(wbits: number): boolean {
  if (wbits < 0) return wbits >= -15 && -wbits >= 8;
  const bits = wbits < 48 ? wbits & 15 : wbits;
  return bits === 0 || (bits >= 8 && bits <= 15);
}

function newDeflater(level: number, wbits: number, memLevel: number, strategy: number): Deflater {
  return new Deflater(level === -1 ? 6 : level, wbits, memLevel, strategy);
}

/** Runs deflate until it leaves output room, growing the output buffer as CPython's loops do. */
function deflateAll(deflater: Deflater, buffer: OutputBuffer, flush: number, context: string): number {
  let err: number;
  do {
    if (deflater.strm.availOut === 0) buffer.grow();
    err = deflater.deflate(flush);
    if (err === Z_STREAM_ERROR) throw zlibError(deflater.strm, err, context);
  } while (deflater.strm.availOut === 0);
  return err;
}

// The functions ---------------------------------------------------------------------------------------------------

const COMPRESS: ClinicSpec = { name: 'compress', params: ['data', 'level', 'wbits'], positionalOnly: 1, required: 1 };

function compress(args: PyValue[], kwargs: Kwargs): PyValue {
  const [dataValue, levelValue, wbitsValue] = clinicArgs(COMPRESS, args, kwargs);
  const data = dataArgument(dataValue);
  const level = cInt(levelValue, -1);
  const wbits = cInt(wbitsValue, 15);
  if (!validDeflateOptions(level, wbits, 8, 0)) {
    throw new PyError(newException(zlibErrorClass, ['Bad compression level']));
  }
  const deflater = newDeflater(level, wbits, 8, 0);
  const buffer = new OutputBuffer(deflater.strm);
  setInput(deflater.strm, data);
  deflateAll(deflater, buffer, Z_FINISH, 'while compressing data');
  return newBytes(buffer.finish());
}

const DECOMPRESS: ClinicSpec = {
  name: 'decompress',
  params: ['data', 'wbits', 'bufsize'],
  positionalOnly: 1,
  required: 1,
};

function decompress(args: PyValue[], kwargs: Kwargs): PyValue {
  const [dataValue, wbitsValue, bufsizeValue] = clinicArgs(DECOMPRESS, args, kwargs);
  const data = dataArgument(dataValue);
  const wbits = cInt(wbitsValue, 15);
  let bufsize = cSsize(bufsizeValue, DEF_BUF_SIZE);
  if (bufsize < 0) throw valueError('bufsize must be non-negative');
  if (bufsize === 0) bufsize = 1;
  const inflater = new Inflater(validInflateBits(wbits) ? wbits : 15);
  if (!validInflateBits(wbits)) throw zlibError(inflater.strm, Z_STREAM_ERROR, 'while preparing to decompress data');
  const buffer = new OutputBuffer(inflater.strm, -1, Math.min(bufsize, 0xff_ff_ff_ff));
  setInput(inflater.strm, data);
  let err: number;
  do {
    if (inflater.strm.availOut === 0) buffer.grow();
    err = inflater.inflate(Z_FINISH);
    if (err !== Z_OK && err !== Z_BUF_ERROR && err !== Z_STREAM_END) {
      throw zlibError(inflater.strm, err, 'while decompressing data');
    }
  } while (inflater.strm.availOut === 0);
  if (err !== Z_STREAM_END) throw zlibError(inflater.strm, err, 'while decompressing data');
  return newBytes(buffer.finish());
}

// Compression objects ---------------------------------------------------------------------------------------------

const compressClass = builtinClass('Compress');
compressClass.typeName = 'zlib.Compress';
compressClass.module = 'zlib';
const decompressClass = builtinClass('Decompress');
decompressClass.typeName = 'zlib.Decompress';
decompressClass.module = 'zlib';
for (const cls of [compressClass, decompressClass]) {
  cls.construct = () => {
    throw typeError(`cannot create 'zlib.${cls.name}' instances`);
  };
}

interface CompressState {
  deflater: Deflater | undefined;
}

const COMPRESSOBJ: ClinicSpec = {
  name: 'compressobj',
  params: ['level', 'method', 'wbits', 'memLevel', 'strategy', 'zdict'],
  positionalOnly: 0,
  required: 0,
};

function compressobj(args: PyValue[], kwargs: Kwargs): PyValue {
  const [levelValue, methodValue, wbitsValue, memLevelValue, strategyValue, zdictValue] = clinicArgs(
    COMPRESSOBJ,
    args,
    kwargs
  );
  const level = cInt(levelValue, -1);
  const methodNumber = cInt(methodValue, 8);
  const wbits = cInt(wbitsValue, 15);
  const memLevel = cInt(memLevelValue, 8);
  const strategy = cInt(strategyValue, 0);
  const zdict = zdictValue === undefined || zdictValue === None ? undefined : dataArgument(zdictValue);
  if (!validDeflateOptions(level, wbits, memLevel, strategy, methodNumber)) {
    throw valueError('Invalid initialization option');
  }
  const deflater = newDeflater(level, wbits, memLevel, strategy);
  if (zdict && !deflater.setDictionary(zdict)) throw valueError('Invalid dictionary');
  return new PyOpaque(compressClass, 'Compress', { deflater } satisfies CompressState);
}

const compressState = (self: PyValue): CompressState => (self as PyOpaque).data as CompressState;

function streamError(context: string): PyError {
  return new PyError(newException(zlibErrorClass, [`Error -2 ${context}: inconsistent stream state`]));
}

const COMPRESS_METHOD: ClinicSpec = { name: 'compress', params: ['data'], positionalOnly: 1, required: 1 };

defineMethod(compressClass, 'compress', (self, args, kwargs) => {
  const bytes = dataArgument(clinicArgs(COMPRESS_METHOD, args, kwargs)[0]);
  const { deflater } = compressState(self);
  if (!deflater) throw streamError('while compressing data');
  const buffer = new OutputBuffer(deflater.strm);
  setInput(deflater.strm, bytes);
  deflateAll(deflater, buffer, Z_NO_FLUSH, 'while compressing data');
  return newBytes(buffer.finish());
});

method(compressClass, 'flush', 'takes', 0, 1, (self, args) => {
  const mode = cInt(args[0], Z_FINISH);
  if (mode === Z_NO_FLUSH) return newBytes(new Uint8Array(0));
  const state = compressState(self);
  const { deflater } = state;
  if (!deflater || mode < 0 || mode > Z_BLOCK) throw streamError('while flushing');
  deflater.strm.availIn = 0;
  const buffer = new OutputBuffer(deflater.strm);
  const err = deflateAll(deflater, buffer, mode, 'while flushing');
  if (err === Z_STREAM_END && mode === Z_FINISH) state.deflater = undefined;
  else if (err !== Z_OK && err !== Z_BUF_ERROR) throw zlibError(deflater.strm, err, 'while flushing');
  return newBytes(buffer.finish());
});

for (const name of ['copy', '__copy__']) {
  method(compressClass, name, 'none', 0, 0, (self) => copyCompress(self));
}
method(compressClass, '__deepcopy__', 'one', 1, 1, (self) => copyCompress(self));

function copyCompress(self: PyValue): PyValue {
  const { deflater } = compressState(self);
  if (!deflater) throw valueError('Inconsistent stream state');
  return new PyOpaque(compressClass, 'Compress', { deflater: deflater.copy() } satisfies CompressState);
}

/** A decompression stream, with the calls made so far, which `copy` replays to clone the stream. */
interface DecompressState {
  inflater: Inflater | undefined;
  wbits: number;
  zdict: Uint8Array | undefined;
  unusedData: Uint8Array;
  unconsumedTail: Uint8Array;
  eof: boolean;
  history: ((inflater: Inflater) => void)[];
}

const DECOMPRESSOBJ: ClinicSpec = { name: 'decompressobj', params: ['wbits', 'zdict'], positionalOnly: 0, required: 0 };

function decompressobj(args: PyValue[], kwargs: Kwargs): PyValue {
  const { wbits, zdict } = inflateOptions(DECOMPRESSOBJ, args, kwargs);
  const state: DecompressState = {
    inflater: new Inflater(wbits),
    wbits,
    zdict,
    unusedData: new Uint8Array(0),
    unconsumedTail: new Uint8Array(0),
    eof: false,
    history: [],
  };
  if (zdict && wbits < 0) setInflateDictionary(state);
  return new PyOpaque(decompressClass, 'Decompress', state);
}

/** The window bits and the dictionary decompressobj and _ZlibDecompressor take. */
function inflateOptions(
  spec: ClinicSpec,
  args: PyValue[],
  kwargs: Kwargs
): { wbits: number; zdict: Uint8Array | undefined } {
  const [wbitsValue, zdictValue] = clinicArgs(spec, args, kwargs);
  const wbits = cInt(wbitsValue, 15);
  let zdict: Uint8Array | undefined;
  if (zdictValue !== undefined) {
    zdict = bytesLikeData(zdictValue);
    if (zdict === undefined) throw typeError('zdict argument must support the buffer protocol');
  }
  if (!validInflateBits(wbits)) throw valueError('Invalid initialization option');
  return { wbits, zdict };
}

const decompressState = (self: PyValue): DecompressState => (self as PyOpaque).data as DecompressState;

function setInflateDictionary(state: DecompressState): void {
  const inflater = state.inflater as Inflater;
  const zdict = state.zdict as Uint8Array;
  const err = inflater.setDictionary(zdict);
  state.history.push((each) => each.setDictionary(zdict));
  if (err !== Z_OK) throw zlibError(inflater.strm, err, 'while setting zdict');
}

/** Runs inflate over `data` as Decompress.decompress and flush do, recording the calls for `copy`. */
function inflateInto(state: DecompressState, buffer: OutputBuffer, flush: number, hardLimit: number): number {
  const inflater = state.inflater as Inflater;
  const { strm } = inflater;
  let err: number;
  do {
    if (strm.availOut === 0) {
      if (buffer.size === hardLimit) return Z_OK;
      buffer.grow();
    }
    const room = strm.availOut;
    err = inflater.inflate(flush);
    const consumed = strm.nextIn;
    const input = strm.input;
    state.history.push((each) => replayInflate(each, input, consumed, room, flush));
    if (err === Z_NEED_DICT && state.zdict) setInflateDictionary(state);
    else if (err !== Z_OK && err !== Z_BUF_ERROR && err !== Z_STREAM_END) return err;
  } while (strm.availOut === 0 || err === Z_NEED_DICT);
  return err;
}

function replayInflate(inflater: Inflater, input: Uint8Array, end: number, room: number, flush: number): void {
  const { strm } = inflater;
  Object.assign(strm, {
    input,
    nextIn: strm.nextIn,
    availIn: input.length - strm.nextIn,
    output: new Uint8Array(room),
  });
  Object.assign(strm, { nextOut: 0, availOut: room });
  inflater.inflate(flush);
  if (strm.nextIn !== end) throw new Error('A replayed inflate call consumed different input');
}

function saveUnconsumedInput(state: DecompressState, data: Uint8Array, err: number): void {
  const { strm } = state.inflater as Inflater;
  if (err === Z_STREAM_END && strm.availIn > 0) {
    state.unusedData = concat(state.unusedData, data.subarray(strm.nextIn));
    strm.availIn = 0;
  }
  if (strm.availIn > 0 || state.unconsumedTail.length > 0)
    state.unconsumedTail = Uint8Array.from(data.subarray(strm.nextIn));
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const result = new Uint8Array(first.length + second.length);
  result.set(first);
  result.set(second, first.length);
  return result;
}

defineMethod(decompressClass, 'decompress', (self, args, kwargs) => {
  const [dataValue, maxValue] = clinicArgs(
    { name: 'decompress', params: ['data', 'max_length'], positionalOnly: 1, required: 1 },
    args,
    kwargs
  );
  const data = dataArgument(dataValue);
  const maxLength = cSsize(maxValue, 0);
  if (maxLength < 0) throw valueError('max_length must be non-negative');
  const state = decompressState(self);
  if (!state.inflater) throw streamError('while decompressing data');
  const hardLimit = maxLength === 0 ? Number.MAX_SAFE_INTEGER : maxLength;
  const { strm } = state.inflater;
  const buffer = new OutputBuffer(strm, hardLimit);
  setInput(strm, data);
  const err = inflateInto(state, buffer, Z_SYNC_FLUSH, hardLimit);
  saveUnconsumedInput(state, data, err);
  if (err === Z_STREAM_END) state.eof = true;
  else if (err !== Z_OK && err !== Z_BUF_ERROR) throw zlibError(strm, err, 'while decompressing data');
  return newBytes(buffer.finish());
});

method(decompressClass, 'flush', 'takes', 0, 1, (self, args) => {
  const length = cSsize(args[0], DEF_BUF_SIZE);
  if (length <= 0) throw valueError('length must be greater than zero');
  const state = decompressState(self);
  if (!state.inflater) return newBytes(new Uint8Array(0));
  const { strm } = state.inflater;
  const buffer = new OutputBuffer(strm, -1, length);
  const data = state.unconsumedTail;
  setInput(strm, data);
  const err = inflateInto(state, buffer, data.length === 0 ? Z_FINISH : Z_NO_FLUSH, Number.MAX_SAFE_INTEGER);
  saveUnconsumedInput(state, data, err);
  if (err === Z_STREAM_END) {
    state.eof = true;
    state.inflater = undefined;
  }
  return newBytes(buffer.finish());
});

for (const name of ['copy', '__copy__']) {
  method(decompressClass, name, 'none', 0, 0, (self) => copyDecompress(self));
}
method(decompressClass, '__deepcopy__', 'one', 1, 1, (self) => copyDecompress(self));

function copyDecompress(self: PyValue): PyValue {
  const state = decompressState(self);
  if (!state.inflater) throw valueError('Inconsistent stream state');
  const inflater = new Inflater(state.wbits);
  for (const call of state.history) call(inflater);
  return new PyOpaque(decompressClass, 'Decompress', { ...state, inflater, history: [...state.history] });
}

defineReadOnly(decompressClass, 'unused_data', (self) => newBytes(decompressState(self).unusedData));
defineReadOnly(decompressClass, 'unconsumed_tail', (self) => newBytes(decompressState(self).unconsumedTail));
defineReadOnly(decompressClass, 'eof', (self) => decompressState(self).eof);

export function defineReadOnly(cls: PyClass, name: string, read: (self: PyValue) => PyValue): void {
  cls.dict.set(
    name,
    new PyDescriptor(
      propertyClass,
      nativeFunction(name, ([self]) => read(self))
    )
  );
}

// _ZlibDecompressor -------------------------------------------------------------------------------------------------

/** The state of a one-shot decompressor, as gzip's reader uses it. */
interface ZlibDecompressorState {
  inflater: Inflater;
  zdict: Uint8Array | undefined;
  pending: Uint8Array;
  unusedData: Uint8Array;
  eof: boolean;
  needsInput: boolean;
}

const zlibDecompressorClass = builtinClass('_ZlibDecompressor');
zlibDecompressorClass.module = 'zlib';
zlibDecompressorClass.construct = (cls, args, kwargs) => {
  const { wbits, zdict } = inflateOptions(
    { name: '_ZlibDecompressor', params: ['wbits', 'zdict'], positionalOnly: 0, required: 0 },
    args,
    kwargs
  );
  const inflater = new Inflater(wbits);
  if (zdict && wbits < 0) inflater.setDictionary(zdict);
  const state: ZlibDecompressorState = {
    inflater,
    zdict,
    pending: new Uint8Array(0),
    unusedData: new Uint8Array(0),
    eof: false,
    needsInput: true,
  };
  return new PyOpaque(cls, '_ZlibDecompressor', state);
};

const decompressorState = (self: PyValue): ZlibDecompressorState => (self as PyOpaque).data as ZlibDecompressorState;

defineMethod(zlibDecompressorClass, 'decompress', (self, args, kwargs) => {
  const [dataValue, maxValue] = clinicArgs(
    { name: 'decompress', params: ['data', 'max_length'], positionalOnly: 0, required: 1 },
    args,
    kwargs
  );
  const data = dataArgument(dataValue);
  const maxLength = cSsize(maxValue, -1);
  const state = decompressorState(self);
  if (state.eof) throw new PyError(newException(exceptionClassNamed('EOFError'), ['End of stream already reached']));
  const input = concat(state.pending, data);
  const { strm } = state.inflater;
  setInput(strm, input);
  const buffer = new OutputBuffer(strm, maxLength);
  const err = decompressBuffer(state, buffer, maxLength);
  const left = input.subarray(strm.nextIn);
  if (err === Z_STREAM_END) {
    state.eof = true;
    state.needsInput = false;
    state.unusedData = Uint8Array.from(left);
    state.pending = new Uint8Array(0);
  } else {
    state.needsInput = left.length === 0 && strm.availOut !== 0;
    state.pending = Uint8Array.from(left);
  }
  return newBytes(buffer.finish());
});

// code-gauge-allow functionCognitiveComplexity 16 -- Mirrors the loop of CPython's decompress_buf.
function decompressBuffer(state: ZlibDecompressorState, buffer: OutputBuffer, maxLength: number): number {
  const { inflater } = state;
  const { strm } = inflater;
  let err: number;
  do {
    if (strm.availOut === 0) {
      if (buffer.size === maxLength) return Z_OK;
      buffer.grow();
    }
    err = inflater.inflate(Z_SYNC_FLUSH);
    if (err === Z_NEED_DICT && state.zdict) {
      const result = inflater.setDictionary(state.zdict);
      if (result !== Z_OK) throw zlibError(strm, result, 'while setting zdict');
    } else if (err !== Z_OK && err !== Z_BUF_ERROR && err !== Z_STREAM_END) {
      throw zlibError(strm, err, 'while decompressing data');
    }
  } while ((strm.availOut === 0 || err === Z_NEED_DICT) && err !== Z_STREAM_END);
  return err;
}

defineReadOnly(zlibDecompressorClass, 'unused_data', (self) => newBytes(decompressorState(self).unusedData));
defineReadOnly(zlibDecompressorClass, 'eof', (self) => decompressorState(self).eof);
defineReadOnly(zlibDecompressorClass, 'needs_input', (self) => decompressorState(self).needsInput);

// The module ------------------------------------------------------------------------------------------------------

const CONSTANTS: [string, PyValue][] = [
  ['DEFLATED', 8n],
  ['DEF_BUF_SIZE', 16_384n],
  ['DEF_MEM_LEVEL', 8n],
  ['MAX_WBITS', 15n],
  ['ZLIB_RUNTIME_VERSION', '1.2.12'],
  ['ZLIB_VERSION', '1.2.12'],
  ['Z_BEST_COMPRESSION', 9n],
  ['Z_BEST_SPEED', 1n],
  ['Z_BLOCK', 5n],
  ['Z_DEFAULT_COMPRESSION', -1n],
  ['Z_DEFAULT_STRATEGY', 0n],
  ['Z_FILTERED', 1n],
  ['Z_FINISH', 4n],
  ['Z_FIXED', 4n],
  ['Z_FULL_FLUSH', 3n],
  ['Z_HUFFMAN_ONLY', 2n],
  ['Z_NO_COMPRESSION', 0n],
  ['Z_NO_FLUSH', 0n],
  ['Z_PARTIAL_FLUSH', 1n],
  ['Z_RLE', 3n],
  ['Z_SYNC_FLUSH', 2n],
  ['Z_TREES', 6n],
];

// code-gauge-allow duplicateLines 16 -- zlib and binascii check their checksum arguments alike, each in its own words.
function checksumData(value: PyValue): Uint8Array {
  const data = bytesLikeData(value);
  if (data === undefined) throw typeError(`a bytes-like object is required, not '${typeName(value)}'`);
  return data;
}

const ZLIB_DOC = `The functions in this module allow compression and decompression using the
zlib library, which is based on GNU zip.

adler32(string[, start]) -- Compute an Adler-32 checksum.
compress(data[, level]) -- Compress data, with compression level 0-9 or -1.
compressobj([level[, ...]]) -- Return a compressor object.
crc32(string[, start]) -- Compute a CRC-32 checksum.
decompress(string,[wbits],[bufsize]) -- Decompresses a compressed string.
decompressobj([wbits[, zdict]]) -- Return a decompressor object.

'wbits' is window buffer size and container format.
Compressor objects support compress() and flush() methods; decompressor
objects support decompress() and flush().`;

registerModule('zlib', () => {
  return new Map<string, PyValue>([
    ...CONSTANTS,
    ['__doc__', ZLIB_DOC],
    ['__version__', '1.0'],
    [
      'adler32',
      builtin('adler32', 'expected', 1, 2, ([data, start]) =>
        BigInt(adler32(start === undefined ? 1 : uint32Argument(start), checksumData(data)))
      ),
    ],
    [
      'crc32',
      builtin('crc32', 'expected', 1, 2, ([data, start]) => BigInt(crc32(checksumData(data), uint32Argument(start)))),
    ],
    ['compress', nativeFunction('compress', compress)],
    ['decompress', nativeFunction('decompress', decompress)],
    ['compressobj', nativeFunction('compressobj', compressobj)],
    ['decompressobj', nativeFunction('decompressobj', decompressobj)],
    ['error', zlibErrorClass],
    ['_ZlibDecompressor', zlibDecompressorClass],
  ]);
});
