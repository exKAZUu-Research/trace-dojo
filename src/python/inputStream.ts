import { defineAttribute } from './attributeDescriptors';
import { newBytes, PyBytes, requireBytesLike } from './bytesValues';
import { pyRepr, strObject } from './conversions';
import { method } from './define';
import { builtinClassesWithDict, ownDict } from './descriptors';
import { defineNew } from './instances';
import { clinicMethod } from './modules/clinicArgs';
import { toIndex } from './numbers';
import { callValue, getAttribute, getAttributeOrUndefined, setAttribute } from './objects';
import type { Runtime } from './runtime';
import { currentRuntime } from './runtimeContext';
import {
  builtinClass,
  exceptionClassNamed,
  newException,
  None,
  pyError,
  stringValue,
  typeError,
  unbox,
  valueError,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import { type PyClass, PyError, PyOpaque, type PyValue } from './values';
import { withWritableBuffer } from './writableBuffer';

interface InputState {
  runtime: Runtime;
  pending: Uint8Array;
}

const encoder = new TextEncoder();
const stateOf = (value: PyValue): InputState => (value as PyOpaque).data as InputState;

export function createInputStream(runtime: Runtime): PyValue {
  const io = runtime.importModule('io');
  const raw = new PyOpaque(io.dict.get('FileIO') as PyClass, '', {
    runtime,
    pending: new Uint8Array(0),
  } satisfies InputState);
  ownDict(raw)?.set('name', '<stdin>');
  const buffer = callValue(io.dict.get('BufferedReader') as PyValue, [raw]);
  const text = callValue(
    io.dict.get('TextIOWrapper') as PyValue,
    [buffer],
    new Map([
      ['encoding', encoder.encoding],
      ['errors', 'surrogateescape'],
      ['newline', '\n'],
    ])
  );
  setAttribute(text, 'mode', 'r');
  return text;
}

// code-gauge-allow functionNcss 39 -- Registers one native class's I/O operations and read-only attributes together.
export function createFileIOClass(runtime: Runtime, rawBase: PyClass): PyClass {
  const rawClass = builtinClass('FileIO', rawBase);
  rawClass.module = '_io';
  rawClass.typeName = '_io.FileIO';
  rawClass.construct = unsupportedFileAccess;
  defineNew(rawClass, unsupportedFileAccess);
  method(rawClass, '__init__', 'takes', 0, Number.POSITIVE_INFINITY, unsupportedFileAccess);
  builtinClassesWithDict.add(rawClass);
  clinicMethod(rawClass, { name: 'readinto', params: ['buffer'], positionalOnly: 1, required: 1 }, (self, [target]) =>
    readInto(self, target as PyValue)
  );
  method(rawClass, 'read', 'expected', 0, 1, (self, [size]) => {
    const count = size === undefined || size === None ? -1n : toIndex(size);
    return callValue(getAttribute(rawBase, 'read'), [self, count]);
  });
  method(rawClass, 'close', 'none', 0, 0, (self) => {
    try {
      return callValue(getAttribute(rawBase, 'close'), [self]);
    } finally {
      stateOf(self).runtime.io.stdin.isClosed = true;
    }
  });
  for (const [name, result] of [
    ['readable', true],
    ['writable', false],
    ['seekable', false],
    ['isatty', false],
  ] as const) {
    method(rawClass, name, 'none', 0, 0, (self) => {
      checkOpen(self);
      return result;
    });
  }
  method(rawClass, 'fileno', 'none', 0, 0, (self) => {
    checkOpen(self);
    return 0n;
  });
  for (const name of ['seek', 'tell'])
    method(rawClass, name, 'takes', name === 'seek' ? 1 : 0, name === 'seek' ? 2 : 0, (self) => {
      checkOpen(self);
      throw new PyError(newException(exceptionClassNamed('OSError'), [29n, 'Illegal seek']));
    });
  const readOnly = (self: PyValue): never => {
    checkOpen(self);
    throw new PyError(
      newException(runtime.importModule('io').dict.get('UnsupportedOperation') as PyClass, [
        'File not open for writing',
      ])
    );
  };
  method(rawClass, 'write', 'one', 1, 1, (self, [data]) => {
    requireBytesLike(data);
    return readOnly(self);
  });
  method(rawClass, 'truncate', 'expected', 0, 1, (self) => readOnly(self));
  method(rawClass, '__repr__', 'none', 0, 0, fileRepr);
  defineAttribute(rawClass, 'closed', (self) => stateOf(self).runtime.io.stdin.isClosed);
  defineAttribute(rawClass, 'mode', () => 'rb');
  defineAttribute(rawClass, 'closefd', () => false);
  return rawClass;
}

function fileRepr(self: PyValue): string {
  if (stateOf(self).runtime.io.stdin.isClosed) return '<_io.FileIO [closed]>';
  const name = ownDict(self)?.get('name');
  const shown = name === undefined ? 'fd=0' : `name=${pyRepr(name)}`;
  return `<_io.FileIO ${shown} mode='rb' closefd=False>`;
}

function readInto(self: PyValue, target: PyValue): PyValue {
  return withWritableBuffer(target, { name: 'readinto', position: 1 }, (view) => {
    checkOpen(self);
    const destination = view.source.data.subarray(view.offset, view.offset + view.nbytes);
    const state = stateOf(self);
    let written = Math.min(destination.length, state.pending.length);
    destination.set(state.pending.subarray(0, written));
    state.pending = state.pending.subarray(written);
    const reader = state.runtime.io.stdin.reader;
    if (written < destination.length && !reader.isAtEnd) {
      const result = encoder.encodeInto(reader.text.slice(reader.position), destination.subarray(written));
      reader.position += result.read;
      written += result.written;
      if (written < destination.length && !reader.isAtEnd) {
        const character = String.fromCodePoint(reader.text.codePointAt(reader.position) as number);
        const bytes = encoder.encode(character);
        reader.position += character.length;
        const count = Math.min(destination.length - written, bytes.length);
        destination.set(bytes.subarray(0, count), written);
        written += count;
        state.pending = bytes.subarray(count);
      }
    }
    state.runtime.spendNative(Math.ceil(written / 64));
    return BigInt(written);
  });
}

function checkOpen(self: PyValue): void {
  if (stateOf(self).runtime.io.stdin.isClosed) throw valueError('I/O operation on closed file');
}

export function input(prompt: PyValue | undefined): PyValue {
  const runtime = currentRuntime();
  const sys = runtime.importModule('sys');
  const stdin = getAttributeOrUndefined(sys, 'stdin');
  const stdout = getAttributeOrUndefined(sys, 'stdout');
  if (stdin === undefined || stdin === None) throw pyError('RuntimeError', 'lost sys.stdin');
  if (stdout === undefined || stdout === None) throw pyError('RuntimeError', 'lost sys.stdout');
  const stderr = getAttributeOrUndefined(sys, 'stderr');
  if (stderr === undefined || stderr === None) throw pyError('RuntimeError', 'lost sys.stderr');
  flushQuietly(stderr);
  if (prompt !== undefined) callValue(getAttribute(stdout, 'write'), [strObject(prompt)]);
  flushQuietly(stdout);
  return inputResult(callValue(getAttribute(stdin, 'readline'), []));
}

function flushQuietly(stream: PyValue): void {
  try {
    callValue(getAttribute(stream, 'flush'), []);
  } catch (error) {
    if (!(error instanceof PyError)) throw error;
  }
}

function inputResult(line: PyValue): PyValue {
  const text = stringValue(line);
  if (text === undefined) {
    const bytes = unbox(line);
    if (!(bytes instanceof PyBytes) || bytes.isMutable) throw typeError('object.readline() returned non-string');
    if (bytes.length === 0) throw pyError('EOFError', 'EOF when reading a line');
    return bytes.data[bytes.length - 1] === 10 ? newBytes(bytes.data.slice(0, -1)) : line;
  }
  if (text.length === 0) throw pyError('EOFError', 'EOF when reading a line');
  return text.endsWith('\n') ? text.slice(0, -1) : line;
}

function unsupportedFileAccess(): never {
  throw new UnsupportedFeatureError('ファイルの読み書き');
}
