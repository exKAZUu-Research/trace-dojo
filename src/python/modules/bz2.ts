// CPython's `_bz2` over a transcription of bzip2 1.0.8, the version the reference CPython links, and `bz2` over
// CPython's own module.
import { newBytes } from '../bytesValues';
import { method } from '../define';
import { registerModule } from '../modules';
import { registerSourceModule } from '../sourceModules';
import {
  builtinClass,
  defineMethod,
  exceptionClassNamed,
  newException,
  pyError,
  typeError,
  valueError,
} from '../types';
import { PyError, PyOpaque, type PyValue } from '../values';
import { BZ2_CODEC_SOURCE, BZ2_SOURCE } from './bz2Source';
import { BZ_FINISH, BZ_PARAM_ERROR, BZ_RUN, BZ_SEQUENCE_ERROR, BZ_STREAM_END, Bzip2Compressor } from './bzip2Compress';
import { BZ_DATA_ERROR, Bzip2Decompressor } from './bzip2Decompress';
import { cInt, clinicArgs, cSsize } from './clinicArgs';
import { addEncodingsModule } from './codecsNative';
import { dataArgument, defineReadOnly, OutputBuffer } from './zlib';
import { ZStream } from './zlibDeflate';

const compressorClass = builtinClass('BZ2Compressor');
const decompressorClass = builtinClass('BZ2Decompressor');
for (const cls of [compressorClass, decompressorClass]) {
  cls.module = '_bz2';
  cls.typeName = `_bz2.${cls.name}`;
}

/** Raises what CPython's `catch_bz2_error` raises for a libbzip2 error code. */
function bz2Error(code: number): PyError {
  if (code === BZ_PARAM_ERROR) return valueError('Internal error - invalid parameters passed to libbzip2');
  if (code === BZ_SEQUENCE_ERROR) {
    return pyError('RuntimeError', 'Internal error - Invalid sequence of commands sent to libbzip2');
  }
  const message = code === BZ_DATA_ERROR ? 'Invalid data stream' : `Unrecognized error from libbzip2: ${code}`;
  return new PyError(newException(exceptionClassNamed('OSError'), [message]));
}

// BZ2Compressor -----------------------------------------------------------------------------------------------------

interface CompressorState {
  compressor: Bzip2Compressor;
  flushed: boolean;
}

const compressorOf = (self: PyValue): CompressorState => (self as PyOpaque).data as CompressorState;

compressorClass.construct = (cls, args, kwargs) => {
  if (cls === compressorClass && kwargs && kwargs.size > 0)
    throw typeError('BZ2Compressor() takes no keyword arguments');
  if (args.length > 1) throw typeError(`BZ2Compressor expected at most 1 argument, got ${args.length}`);
  const level = cInt(args[0], 9);
  if (level < 1 || level > 9) throw valueError('compresslevel must be between 1 and 9');
  const state: CompressorState = { compressor: new Bzip2Compressor(new ZStream(), level), flushed: false };
  return new PyOpaque(cls, 'BZ2Compressor', state);
};

/** CPython's `compress`: feeds `data` to libbzip2, growing the output buffer as `_BlocksOutputBuffer` does. */
function compress(compressor: Bzip2Compressor, data: Uint8Array, action: number): PyValue {
  const { strm } = compressor;
  const buffer = new OutputBuffer(strm);
  Object.assign(strm, { input: data, nextIn: 0, availIn: 0 });
  let length = data.length;
  for (;;) {
    if (strm.availIn === 0 && length > 0) {
      strm.availIn = length;
      length = 0;
    }
    if (action === BZ_RUN && strm.availIn === 0) break;
    if (strm.availOut === 0) buffer.grow();
    const result = compressor.compress(action);
    if (result < 0) throw bz2Error(result);
    if (action === BZ_FINISH && result === BZ_STREAM_END) break;
  }
  return newBytes(buffer.finish());
}

method(compressorClass, 'compress', 'one', 1, 1, (self, [data]) => {
  const state = compressorOf(self);
  const input = dataArgument(data);
  if (state.flushed) throw valueError('Compressor has been flushed');
  return compress(state.compressor, input, BZ_RUN);
});
method(compressorClass, 'flush', 'none', 0, 0, (self) => {
  const state = compressorOf(self);
  if (state.flushed) throw valueError('Repeated call to flush()');
  state.flushed = true;
  return compress(state.compressor, new Uint8Array(0), BZ_FINISH);
});

// BZ2Decompressor ---------------------------------------------------------------------------------------------------

interface DecompressorState {
  decompressor: Bzip2Decompressor;
  /** The input libbzip2 has not consumed yet, which CPython keeps for the next call. */
  pending: Uint8Array;
  unusedData: Uint8Array;
  eof: boolean;
  needsInput: boolean;
  failed: boolean;
}

const decompressorOf = (self: PyValue): DecompressorState => (self as PyOpaque).data as DecompressorState;

decompressorClass.construct = (cls, args, kwargs) => {
  if (cls === decompressorClass && args.length > 0) throw typeError('BZ2Decompressor() takes no positional arguments');
  if (cls === decompressorClass && kwargs && kwargs.size > 0) {
    throw typeError('BZ2Decompressor() takes no keyword arguments');
  }
  const state: DecompressorState = {
    decompressor: new Bzip2Decompressor(new ZStream()),
    pending: new Uint8Array(0),
    unusedData: new Uint8Array(0),
    eof: false,
    needsInput: true,
    failed: false,
  };
  return new PyOpaque(cls, 'BZ2Decompressor', state);
};

defineMethod(decompressorClass, 'decompress', (self, args, kwargs) => {
  const [dataValue, maxValue] = clinicArgs(
    { name: 'decompress', params: ['data', 'max_length'], positionalOnly: 0, required: 1 },
    args,
    kwargs
  );
  const data = dataArgument(dataValue);
  const maxLength = cSsize(maxValue, -1);
  const state = decompressorOf(self);
  if (state.eof) throw new PyError(newException(exceptionClassNamed('EOFError'), ['End of stream already reached']));
  if (state.failed) throw valueError('Decompressor is unusable after a previous error');
  return decompressInto(state, data, maxLength);
});

// code-gauge-allow functionCognitiveComplexity 16 -- Mirrors decompress and decompress_buf of CPython's _bz2module.c.
// code-gauge-allow functionNcss 34 -- Mirrors decompress and decompress_buf of CPython's _bz2module.c.
function decompressInto(state: DecompressorState, data: Uint8Array, maxLength: number): PyValue {
  const { decompressor } = state;
  const { strm } = decompressor;
  const input = new Uint8Array(state.pending.length + data.length);
  input.set(state.pending);
  input.set(data, state.pending.length);
  const buffer = new OutputBuffer(strm, maxLength);
  Object.assign(strm, { input, nextIn: 0, availIn: input.length });
  for (;;) {
    const result = decompressor.decompress();
    if (result < 0) {
      state.failed = true;
      state.needsInput = false;
      state.pending = new Uint8Array(0);
      throw bz2Error(result);
    }
    if (result === BZ_STREAM_END) {
      state.eof = true;
      break;
    }
    if (strm.availIn === 0) break;
    if (strm.availOut === 0) {
      if (buffer.size === maxLength) break;
      buffer.grow();
    }
  }
  const left = input.slice(strm.nextIn);
  if (state.eof) {
    state.needsInput = false;
    if (left.length > 0) state.unusedData = left;
    state.pending = new Uint8Array(0);
  } else {
    state.needsInput = left.length === 0;
    state.pending = left;
  }
  return newBytes(buffer.finish());
}

defineReadOnly(decompressorClass, 'eof', (self) => decompressorOf(self).eof);
defineReadOnly(decompressorClass, 'unused_data', (self) => newBytes(decompressorOf(self).unusedData));
defineReadOnly(decompressorClass, 'needs_input', (self) => decompressorOf(self).needsInput);

registerModule(
  '_bz2',
  () =>
    new Map<string, PyValue>([
      ['BZ2Compressor', compressorClass],
      ['BZ2Decompressor', decompressorClass],
    ])
);
registerSourceModule('bz2', BZ2_SOURCE);
addEncodingsModule('bz2_codec');
registerSourceModule('encodings.bz2_codec', BZ2_CODEC_SOURCE);
// CPython 3.14's `compression/bz2.py`, which re-exports the module.
registerSourceModule('compression.bz2', 'import bz2\n__doc__ = bz2.__doc__\ndel bz2\n\nfrom bz2 import *\n');
