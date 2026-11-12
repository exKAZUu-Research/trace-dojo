import { method } from './define';
import { defineGetSet, defineUnsupportedAttributes } from './descriptors';
import { checkArgs } from './nativeArgs';
import { toIndex } from './numbers';
import { callValue, getAttribute, iterate } from './objects';
import type { Runtime } from './runtime';
import { strLength } from './strings';
import { argumentTypeName, builtinClass, defineMethod, None, pyError, typeError, typeName, valueError } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { AttributeMap, DONE, type Kwargs, PyOpaque, type PyValue } from './values';

interface StreamState {
  write: (text: string) => void;
  encoding: string;
  errors: string;
  lineBuffering: boolean;
  writeThrough: boolean;
}

const textIOClass = builtinClass('TextIOWrapper');
textIOClass.module = '_io';
textIOClass.tpName = '_io.TextIOWrapper';

const stateOf = (self: PyValue): StreamState => (self as PyOpaque).data as StreamState;

/** `sys.stdout` or `sys.stderr` as CPython has them when they are not a terminal; stderr's writes go nowhere. */
export function createStream(runtime: Runtime, name: 'stdout' | 'stderr'): PyValue {
  const isStdout = name === 'stdout';
  const stream = new PyOpaque(textIOClass, name, {
    write: isStdout ? (text: string) => runtime.budget.print(text) : () => {},
    // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- CPython names the encoding 'utf-8'.
    encoding: 'utf-8',
    errors: isStdout ? 'strict' : 'backslashreplace',
    lineBuffering: !isStdout,
    writeThrough: false,
  } satisfies StreamState);
  stream.attributes = new AttributeMap([['mode', 'w']]);
  return stream;
}

method(textIOClass, 'write', 'one', 1, 1, (self, [text]) => {
  if (typeof text !== 'string') throw typeError(`write() argument must be str, not ${argumentTypeName(text)}`);
  stateOf(self).write(text);
  return BigInt(strLength(text));
});
defineMethod(textIOClass, 'writelines', (self, args, kwargs) => {
  // CPython reports a wrong call with the base class that defines the method.
  checkArgs({ qualified: '_IOBase.writelines', min: 1, max: 1, style: 'one' }, args, kwargs);
  const next = iterate(args[0]);
  for (let line = next(); line !== DONE; line = next()) callValue(getAttribute(self, 'write'), [line]);
  return None;
});
method(textIOClass, 'flush', 'none', 0, 0, () => None);
method(textIOClass, 'isatty', 'none', 0, 0, () => false);
method(textIOClass, 'writable', 'none', 0, 0, () => true);
method(textIOClass, 'readable', 'none', 0, 0, () => false);
method(textIOClass, 'seekable', 'none', 0, 0, () => false);
method(textIOClass, 'reconfigure', 'takes', 0, 0, reconfigure, {
  keywords: ['encoding', 'errors', 'newline', 'line_buffering', 'write_through'],
});
method(
  textIOClass,
  '__repr__',
  'none',
  0,
  0,
  (self) => `<_io.TextIOWrapper name='<${(self as PyOpaque).text}>' mode='w' encoding='${stateOf(self).encoding}'>`
);

defineGetSet(textIOClass, 'encoding', (self) => stateOf(self).encoding, { member: true });
defineGetSet(textIOClass, 'line_buffering', (self) => stateOf(self).lineBuffering, { member: true });
defineGetSet(textIOClass, 'write_through', (self) => stateOf(self).writeThrough, { member: true });
defineReadOnly('errors', (self) => stateOf(self).errors);
defineReadOnly('closed', () => false);
defineReadOnly('name', (self) => `<${(self as PyOpaque).text}>`);
defineReadOnly('newlines', () => None);

function defineReadOnly(name: string, get: (self: PyValue) => PyValue): void {
  defineGetSet(textIOClass, name, get, {
    set: () => {
      throw pyError('AttributeError', `attribute '${name}' of '_io.TextIOWrapper' objects is not writable`);
    },
  });
}

defineUnsupportedAttributes(
  textIOClass,
  Object.fromEntries(
    [
      'buffer',
      'close',
      'detach',
      'fileno',
      'read',
      'readline',
      'readlines',
      'seek',
      'tell',
      'truncate',
      '_CHUNK_SIZE',
      '_checkClosed',
      '_checkReadable',
      '_checkSeekable',
      '_checkWritable',
      '_finalizing',
      '__enter__',
      '__exit__',
      '__iter__',
      '__next__',
      '__del__',
    ].map((name) => [name, `標準出力・標準エラー出力の ${name}（ファイルや入力の操作）`])
  )
);

/** `TextIOWrapper.reconfigure`, which keeps what None or an omitted argument stands for. */
function reconfigure(self: PyValue, _args: PyValue[], kwargs: Kwargs): PyValue {
  const state = stateOf(self);
  const encoding = textOption(kwargs, 'encoding');
  const errors = textOption(kwargs, 'errors');
  const newline = textOption(kwargs, 'newline');
  if (newline !== undefined && !['', '\n', '\r', '\r\n'].includes(newline)) {
    throw valueError(`illegal newline value: ${newline}`);
  }
  const lineBuffering = flagOption(kwargs, 'line_buffering');
  const writeThrough = flagOption(kwargs, 'write_through');
  if (encoding !== undefined && !/^(utf[-_]?8|u8|utf|cp65001)$/i.test(encoding)) {
    throw new UnsupportedFeatureError(`UTF-8 以外の文字コードでの出力（encoding='${encoding}'）`);
  }
  if (newline === '\r' || newline === '\r\n') throw new UnsupportedFeatureError('出力の改行コードの変更（newline=）');
  if (encoding !== undefined) state.errors = errors ?? 'strict';
  else if (errors !== undefined) state.errors = errors;
  state.encoding = encoding ?? state.encoding;
  state.lineBuffering = lineBuffering ?? state.lineBuffering;
  state.writeThrough = writeThrough ?? state.writeThrough;
  return None;
}

function textOption(kwargs: Kwargs, name: string): string | undefined {
  const value = kwargs?.get(name) ?? None;
  if (value === None) return undefined;
  if (typeof value !== 'string') {
    throw typeError(`reconfigure() argument '${name}' must be str or None, not ${typeName(value)}`);
  }
  return value;
}

function flagOption(kwargs: Kwargs, name: string): boolean | undefined {
  const value = kwargs?.get(name) ?? None;
  return value === None ? undefined : toIndex(value) !== 0n;
}
