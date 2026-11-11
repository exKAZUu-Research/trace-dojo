import type { Frame } from './frame';
import { checkNamespaceListing } from './namespaceDifferences';
import { namespaceDict } from './namespaces';
import { getAttributeOrUndefined, getIterator } from './objects';
import { currentRuntime } from './runtimeContext';
import { newDict, newList, typeError } from './types';
import type { PyDict, PyList, PyValue } from './values';

/** `globals()`: the dict of the calling frame's module variables, which shares them with the frame. */
export function callerGlobals(): PyDict {
  // The calling frame may be a library module's, such as token.py building its table from its own globals.
  return namespaceDict((currentRuntime().frames.at(-1) as Frame).globals);
}

/**
 * `locals()` and `vars()`: the calling frame's variables. A module's or class body's namespace is a dict the frame
 * shares; a function's is a new snapshot on each call, as PEP 667 specifies.
 */
export function callerLocals(): PyDict {
  // The program can now read the frames' variables as objects.
  currentRuntime().finalizer.locals.expose();
  const frames = programFrames();
  const frame = frames.at(-1) as Frame;
  if (frame.kind === 'module' || frame.kind === 'class') return namespaceDict(frame.locals);
  return newDict(localVariables(frames, frames.length - 1));
}

/**
 * The frames of the program's own code, outermost first. The standard library modules written in Python are C code in
 * CPython, whose calls of `locals()` or `eval()` see the frame of the program that called them.
 */
export function programFrames(): Frame[] {
  const runtime = currentRuntime();
  return runtime.frames.filter((frame) => !runtime.libraryNamespaces.has(frame.globals));
}

/** `vars(obj)`: the `__dict__` of an object. */
export function vars(value: PyValue): PyValue {
  checkNamespaceListing(value, 'vars()');
  const dict = getAttributeOrUndefined(value, '__dict__');
  if (dict === undefined) throw typeError('vars() argument must have __dict__ attribute');
  return dict;
}

/** `dir()` without an argument: the sorted names of the calling frame's variables. */
export function callerNames(): PyList {
  const runtime = currentRuntime();
  const names = [...callerLocals().store.ordered()].map((entry) => entry.key as string).toSorted();
  runtime.allocate(names.length + 1);
  return newList(names);
}

/**
 * The iterable of each generator expression's frame, which CPython runs in a frame of its own, whose variable `.0`
 * holds the iterator over the iterable, unlike the other comprehensions, which run in the frame around them.
 */
const generatorIterables = new WeakMap<Frame, { value: PyValue; iterator?: PyValue }>();

export function markGeneratorExpression(frame: Frame, iterable: PyValue): void {
  generatorIterables.set(frame, { value: iterable });
}

/** The frames CPython has on its stack: those of `frames` but the comprehensions it runs in the frame around them. */
export function cpythonFrames(frames: readonly Frame[]): Frame[] {
  return frames.filter((frame) => frame.kind !== 'comprehension' || generatorIterables.has(frame));
}

/**
 * The variables of a function's frame in CPython's order: the parameters and other variables in the order the
 * function first binds them, then the variables nested functions capture, then those it captures, each by name.
 * CPython runs a comprehension in the frame of the function around it, so its variables join the function's.
 */
export function localVariables(frames: readonly Frame[], index: number): Map<string, PyValue> {
  const frame = frames[index];
  const parent = frames[index - 1];
  const iterable = generatorIterables.get(frame);
  const variables =
    frame.kind === 'comprehension' && iterable === undefined && parent?.kind === 'function'
      ? localVariables(frames, index - 1)
      : new Map<string, PyValue>();
  if (iterable !== undefined) variables.set('.0', (iterable.iterator ??= getIterator(iterable.value)));
  if (frame.kind === 'module' || frame.kind === 'class') {
    for (const [name, value] of frame.locals) variables.set(name, value);
  } else {
    addFunctionVariables(frame, variables);
  }
  return variables;
}

function addFunctionVariables(frame: Frame, variables: Map<string, PyValue>): void {
  const { scope } = frame;
  const params = new Set(frame.kind === 'function' ? frame.fn?.def.params.map((param) => param.name) : []);
  const cellValue = (name: string): PyValue | undefined => frame.cells.get(name)?.value;
  const add = (name: string, value: PyValue | undefined): void => {
    if (value !== undefined) variables.set(name, value);
  };
  for (const name of scope.locals) {
    if (params.has(name) || !scope.cells.includes(name)) add(name, frame.locals.get(name) ?? cellValue(name));
  }
  for (const name of scope.cells.toSorted()) if (!params.has(name)) add(name, cellValue(name));
  for (const name of scope.frees.toSorted()) add(name, cellValue(name));
}
