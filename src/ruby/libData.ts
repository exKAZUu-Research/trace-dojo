import { toIndex } from './conversions';
import { def, sdef } from './define';
import { argumentError } from './errors';
import { callProc } from './interp';
import { makeEnumerator } from './libEnumerator';
import { checkFrozenIo } from './libIo';
import { NIL, RObject, type Value } from './objects';
import { rt, UnsupportedFeatureError } from './runtime';
import { arr, str, stringFromBytes } from './values';

export function makeData(text: string, file: string): RObject {
  const data = new RObject(rt().c.File);
  data.data = {
    bytes: new TextEncoder().encode(file),
    position: new TextEncoder().encode(file.slice(0, file.length - text.length)).length,
  };
  dataFiles.add(data);
  return data;
}

interface DataState {
  bytes: Uint8Array;
  position: number;
}

const dataFiles = new WeakSet<RObject>();

function dataState(self: RObject): DataState {
  if (!dataFiles.has(self)) throw new UnsupportedFeatureError('File オブジェクトの生成');
  return self.data as DataState;
}

function mutableDataState(self: RObject): DataState {
  const state = dataState(self);
  checkFrozenIo(self);
  return state;
}

function remaining(self: RObject): string {
  const state = mutableDataState(self);
  return stringFromBytes(state.bytes.subarray(state.position)).s;
}

sdef('File', ['new', 'allocate'], [0, -1], () => {
  throw new UnsupportedFeatureError('File オブジェクトの生成');
});
def('File', 'inspect', 0, (self: RObject) => {
  dataState(self);
  return str('#<File:main.rb>');
});
def('File', 'read', [0, 2], function* (self: RObject, args) {
  const state = mutableDataState(self);
  if (args.length > 1) throw new UnsupportedFeatureError('DATA.read の出力バッファ');
  const bounded = args.length > 0 && args[0] !== NIL;
  const length = bounded ? yield* toIndex(args[0]) : state.bytes.length - state.position;
  if (length < 0) throw argumentError(`negative length ${length} given`);
  if (bounded && length > 0 && state.position >= state.bytes.length) return NIL;
  const end = Math.min(state.position + length, state.bytes.length);
  const value = stringFromBytes(state.bytes.slice(state.position, end), bounded);
  state.position = end;
  return value;
});
def('File', 'gets', 0, (self: RObject) => {
  const line = readLine(self);
  rt().frame.home.scope.vars.set('$_', line);
  return line;
});

function readLine(self: RObject): Value {
  const state = mutableDataState(self);
  if (state.position >= state.bytes.length) return NIL;
  const end = state.bytes.indexOf(10, state.position);
  const stop = end === -1 ? state.bytes.length : end + 1;
  const line = stringFromBytes(state.bytes.slice(state.position, stop));
  state.position = stop;
  return line;
}
def('File', 'readlines', 0, (self: RObject) => {
  const lines = remaining(self)
    .split(/(?<=\n)/)
    .filter((line) => line.length > 0);
  const state = dataState(self);
  state.position = state.bytes.length;
  return arr(lines.map((line) => str(line)));
});
def('File', 'each_line', 0, function* (self: RObject, _args, block) {
  if (!block) return makeEnumerator(self, 'each_line', []);
  let line: Value;
  while ((line = readLine(self)) !== NIL) yield* callProc(block, [line], { used: false });
  return self;
});
def('File', 'rewind', 0, (self: RObject) => {
  mutableDataState(self).position = 0;
  return 0n;
});
def('File', 'eof?', 0, (self: RObject) => remaining(self).length === 0);
for (const name of ['lineno', 'each', 'getc', 'readline', 'close', 'pos']) {
  def('File', name, [0, -1], () => {
    throw new UnsupportedFeatureError(`DATA.${name}`);
  });
}
