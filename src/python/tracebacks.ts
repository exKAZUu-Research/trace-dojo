import { addressOf } from './conversions';
import { method } from './define';
import type { Frame } from './frame';
import { defineProperty } from './modules/numberSupport';
import { namespaceDict } from './namespaces';
import { callValue, getAttribute } from './objects';
import { firstRowOf } from './programSource';
import { cpythonFrames } from './reflection';
import { currentRuntime } from './runtimeContext';
import { builtinClass, newDict, newTuple, None, pyError, typeError } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { type ExceptionState, PyError, type PyFunction, PyGenerator, PyObject, PyOpaque, type PyValue } from './values';

// Traceback, frame, and code objects. An exception's traceback grows as it leaves each frame, as CPython adds an entry
// for every frame it passes through: the frame it was raised in, each caller with the row of its call, up to the frame
// that catches it.

export const tracebackClass = builtinClass('traceback');
export const frameClass = builtinClass('frame');
export const codeClass = builtinClass('code');

export class PyTraceback extends PyObject {
  constructor(
    readonly frame: Frame,
    readonly row: number,
    public next: PyValue
  ) {
    super(tracebackClass);
  }
}

/** The caller of each frame an exception left, and the row each frame stopped at, which its frame object reports. */
const callers = new WeakMap<Frame, Frame | undefined>();
const finishedRows = new WeakMap<Frame, number>();

/** Adds an entry for `frame` at `row` in front of an exception's traceback, as raising it there does. */
export function prependTraceback(state: ExceptionState, frame: Frame, row: number | undefined): void {
  const head = state.traceback;
  state.traceback = new PyTraceback(frame, row ?? 0, head ?? None);
}

function headFrame(state: ExceptionState): Frame | undefined {
  return state.traceback instanceof PyTraceback ? state.traceback.frame : undefined;
}

/**
 * Records that an exception leaves the innermost frame of the stack: the frame where it was raised, if it has no entry
 * yet, and the caller at the row of the call. Runs before the frame is taken off the stack.
 */
export function noteUnwinding(error: unknown): void {
  if (!(error instanceof PyError)) return;
  const state = error.exception.exception;
  if (!state) return;
  const runtime = currentRuntime();
  const frames = cpythonFrames(runtime.frames);
  const frame = frames.at(-1);
  if (!frame) return;
  if (headFrame(state) !== frame) prependTraceback(state, frame, runtime.currentRow);
  finishedRows.set(frame, (state.traceback as PyTraceback).row);
  const caller = frames.at(-2);
  callers.set(frame, caller);
  if (caller) prependTraceback(state, caller, frame.callRow ?? runtime.currentRow);
}

/** Records the entry of the frame that catches an exception raised in it, as the traceback it handles shows. */
export function noteCaught(error: PyError, frame: Frame): void {
  const state = error.exception.exception;
  if (state && headFrame(state) !== frame) prependTraceback(state, frame, currentRuntime().currentRow);
}

// Traceback objects -------------------------------------------------------------------------------------------------

method(tracebackClass, '__repr__', 'none', 0, 0, (self) => `<traceback object at ${addressOf(self as PyObject)}>`);
method(tracebackClass, '__dir__', 'none', 0, 0, () =>
  currentRuntime().listOf(['tb_frame', 'tb_next', 'tb_lasti', 'tb_lineno'])
);
defineProperty(tracebackClass, 'tb_frame', (self) => frameObject((self as PyTraceback).frame));
defineProperty(tracebackClass, 'tb_lineno', (self) => BigInt((self as PyTraceback).row + 1));
defineProperty(tracebackClass, 'tb_next', (self) => (self as PyTraceback).next);
defineProperty(tracebackClass, 'tb_lasti', () => {
  throw new UnsupportedFeatureError('バイトコードの位置（tb_lasti）');
});

// Frame objects -----------------------------------------------------------------------------------------------------

const frameObjects = new WeakMap<Frame, PyOpaque>();

/** The frame object of a frame, the same each time, as CPython keeps one per running frame. */
export function frameObject(frame: Frame): PyOpaque {
  let object = frameObjects.get(frame);
  if (!object) {
    object = new PyOpaque(frameClass, '', frame);
    frameObjects.set(frame, object);
  }
  return object;
}

const frameOf = (self: PyValue): Frame => (self as PyOpaque).data as Frame;

const frameGenerators = new WeakMap<Frame, PyValue>();

/** Records the generator, coroutine, or async generator whose frame `frame` is, which `f_generator` gives. */
export function setFrameGenerator(frame: Frame, generator: PyValue): void {
  frameGenerators.set(frame, generator);
}

/** The frame object `depth` frames below the innermost one, as `sys._getframe(depth)` gives it. */
export function stackFrame(depth: number): PyValue | undefined {
  const frames = cpythonFrames(currentRuntime().frames);
  const frame = frames.at(-1 - depth);
  if (!frame) return undefined;
  for (let index = frames.length - 1 - depth; index >= 0; index--) callers.set(frames[index], frames[index - 1]);
  return frameObject(frame);
}

/** The row a frame runs: the current one while it is on the stack, or the one it stopped at. */
function frameRow(frame: Frame): number {
  const running = currentRuntime()
    .allFrames()
    .find((each) => each.frame === frame);
  return running?.row ?? finishedRows.get(frame) ?? 0;
}

method(frameClass, '__repr__', 'none', 0, 0, () => {
  throw new UnsupportedFeatureError('フレームオブジェクトの表示（スクリプトのファイルのパスを含む）');
});
defineProperty(frameClass, 'f_lineno', (self) => BigInt(frameRow(frameOf(self)) + 1));
defineProperty(frameClass, 'f_code', (self) => codeObject(frameOf(self)));
defineProperty(frameClass, 'f_globals', (self) => namespaceDict(frameOf(self).globals));
defineProperty(frameClass, 'f_builtins', (self) => {
  const builtins = frameOf(self).globals.get('__builtins__');
  return builtins instanceof PyObject && 'dict' in builtins
    ? namespaceDict((builtins as { dict: Map<string, PyValue> }).dict)
    : namespaceDict(currentRuntime().builtins);
});
defineProperty(frameClass, 'f_locals', (self) => frameLocals(frameOf(self)));
defineProperty(frameClass, 'f_back', (self) => {
  const frame = frameOf(self);
  const frames = cpythonFrames(currentRuntime().frames);
  const index = frames.indexOf(frame);
  const caller = index === -1 ? callers.get(frame) : frames[index - 1];
  return caller ? frameObject(caller) : None;
});
method(frameClass, 'clear', 'none', 0, 0, (self) => {
  const frame = frameOf(self);
  const generator = frameGenerators.get(frame);
  const executing = currentRuntime()
    .allFrames()
    .some((each) => each.frame === frame);
  if (executing || (generator instanceof PyGenerator && generator.running)) {
    throw pyError('RuntimeError', 'cannot clear an executing frame');
  }
  if (generator instanceof PyGenerator && !generator.finished) {
    if (generator.started) throw pyError('RuntimeError', 'cannot clear a suspended frame');
    callValue(getAttribute(generator, 'close'), []);
  }
  // A module's or a class body's frame shares its namespace, which clearing the frame leaves.
  if (frame.kind === 'function' || frame.kind === 'comprehension') {
    frame.locals.clear();
    frame.cells.clear();
  }
  return None;
});
defineProperty(frameClass, 'f_generator', (self) => frameGenerators.get(frameOf(self)) ?? None);
defineProperty(frameClass, 'f_trace', () => None);
defineProperty(frameClass, 'f_trace_lines', () => true);
defineProperty(frameClass, 'f_trace_opcodes', () => false);
defineProperty(frameClass, 'f_lasti', () => {
  throw new UnsupportedFeatureError('バイトコードの位置（f_lasti）');
});

/** `frame.f_locals`: a module's or class body's namespace, or a snapshot of a function's variables. */
function frameLocals(frame: Frame): PyValue {
  if (frame.kind === 'module' || frame.kind === 'class') return namespaceDict(frame.locals);
  const variables = new Map<PyValue, PyValue>();
  for (const [name, value] of frame.locals) variables.set(name, value);
  for (const [name, cell] of frame.cells) if (cell.value !== undefined) variables.set(name, cell.value);
  return newDict(variables.entries());
}

// Code objects ------------------------------------------------------------------------------------------------------

/** What a code object describes: the function it compiles, the module or class body it runs, or compiled source. */
export interface CodeInfo {
  name: string;
  qualifiedName: string;
  firstRow: number;
  fn?: PyFunction;
  /** The file name compile() was given, which code from the program's own file does not reveal. */
  filename?: string;
  /** What compile() compiled, which exec() and eval() run. */
  compiled?: unknown;
  /** The scope of the code, which tells whether the code is the program's own. */
  scope?: object;
}

const codeObjects = new WeakMap<object, PyOpaque>();

export function hasCode(scope: object): boolean {
  return codeObjects.has(scope);
}

/** Makes `code` the code object of the frames that run `scope`, as compile() returns it for the code it compiles. */
export function registerCode(scope: object, code: PyOpaque): void {
  codeObjects.set(scope, code);
}

/** The code object of a frame's code: its function's, or one of a module or a class body. */
export function codeObject(frame: Frame): PyOpaque {
  if (frame.fn) return functionCode(frame.fn);
  let code = codeObjects.get(frame.scope);
  if (!code) {
    const qualifiedName = frame.locals.get('__qualname__');
    const name = frame.kind === 'class' && typeof qualifiedName === 'string' ? qualifiedName : '<module>';
    const info: CodeInfo = {
      name: name.split('.').at(-1) ?? name,
      qualifiedName: name,
      firstRow: Number(frame.locals.get('__firstlineno__') ?? 1n) - 1,
      scope: frame.scope,
    };
    code = new PyOpaque(codeClass, '', info);
    codeObjects.set(frame.scope, code);
  }
  return code;
}

/** `function.__code__`, the same for every function a definition creates. */
export function functionCode(fn: PyFunction): PyOpaque {
  let code = codeObjects.get(fn.def);
  if (!code) {
    const info: CodeInfo = {
      name: fn.def.name,
      qualifiedName: fn.def.qualifiedName,
      firstRow: firstRowOf(fn.def),
      fn,
      scope: fn.def.scope,
    };
    code = new PyOpaque(codeClass, '', info);
    codeObjects.set(fn.def, code);
  }
  return code;
}

export const infoOf = (self: PyValue): CodeInfo => (self as PyOpaque).data as CodeInfo;

function parameterCount(self: PyValue, kinds: string[]): bigint {
  const fn = infoOf(self).fn;
  return BigInt(fn ? fn.def.params.filter((param) => kinds.includes(param.kind)).length : 0);
}

method(codeClass, '__repr__', 'none', 0, 0, (self) => {
  const { name, filename, firstRow } = infoOf(self);
  if (filename === undefined) {
    throw new UnsupportedFeatureError('コードオブジェクトの表示（スクリプトのファイルのパスを含む）');
  }
  return `<code object ${name} at ${addressOf(self as PyOpaque)}, file "${filename}", line ${firstRow + 1}>`;
});
defineProperty(codeClass, 'co_name', (self) => infoOf(self).name);
defineProperty(codeClass, 'co_qualname', (self) => infoOf(self).qualifiedName);
defineProperty(codeClass, 'co_firstlineno', (self) => BigInt(infoOf(self).firstRow + 1));
defineProperty(codeClass, 'co_argcount', (self) => parameterCount(self, ['positionalOnly', 'positional']));
defineProperty(codeClass, 'co_posonlyargcount', (self) => parameterCount(self, ['positionalOnly']));
defineProperty(codeClass, 'co_kwonlyargcount', (self) => parameterCount(self, ['keywordOnly']));
defineProperty(codeClass, 'co_filename', (self) => {
  const { filename } = infoOf(self);
  if (filename === undefined) throw new UnsupportedFeatureError('スクリプトのファイルのパス（co_filename）');
  return filename;
});
defineProperty(codeClass, 'co_cellvars', (self) => newTuple(cellNames(infoOf(self).fn)));
defineProperty(codeClass, 'co_freevars', (self) => newTuple(freeNames(infoOf(self).fn)));
for (const name of ['co_code', 'co_consts', 'co_names', 'co_varnames', 'co_nlocals', 'co_stacksize', 'co_flags']) {
  defineProperty(codeClass, name, () => {
    throw new UnsupportedFeatureError(`CPython のバイトコードの情報（${name}）`);
  });
}

/** A function's variables that nested functions capture: its parameters in their order, then the others sorted. */
function cellNames(fn: PyFunction | undefined): string[] {
  if (!fn) return [];
  const { scope, params } = fn.def;
  const cells = new Set([...scope.cells, ...(scope.inlinedCells ?? [])]);
  const parameters = params.map((param) => param.name).filter((name) => cells.has(name));
  return [...parameters, ...[...cells].filter((name) => !parameters.includes(name)).toSorted()];
}

/** The variables a function reads from the functions enclosing it, sorted, with the class cell `super()` reads. */
function freeNames(fn: PyFunction | undefined): string[] {
  if (!fn) return [];
  const { scope, usesClassCell, className } = fn.def;
  const frees = new Set(scope.frees);
  if (usesClassCell && className !== undefined) frees.add('__class__');
  return [...frees].toSorted();
}

// Exceptions --------------------------------------------------------------------------------------------------------

/** `exception.__traceback__ = value` and `with_traceback(value)`. */
export function setTraceback(state: ExceptionState, value: PyValue): void {
  if (value !== None && !(value instanceof PyTraceback)) throw typeError('__traceback__ must be a traceback or None');
  state.traceback = value;
}
