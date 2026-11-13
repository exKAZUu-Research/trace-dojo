import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { bytesText, PyBytes, PyMemoryView } from './bytesValues';
import { complexRepr } from './complexNumbers';
import type { Frame } from './frame';
import { parsePython } from './parse';
import { runModule } from './run';
import { Runtime } from './runtime';
import { strRepr } from './strings';
import { None, unbox } from './types';
import {
  PyBoundMethod,
  PyBuiltinFunction,
  PyClass,
  PyComplex,
  PyDeque,
  PyDescriptor,
  PyDict,
  PyFunction,
  PyGenerator,
  PyInstance,
  PyIterator,
  PyList,
  PyModule,
  PyNumberInstance,
  PyObject,
  PyOpaque,
  PyRange,
  PySet,
  PyTuple,
  type PyValue,
} from './values';

export function tracePythonProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const parsed = parsePython(program, trace);
  const runtime = new Runtime(input);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.isAtomic,
    variablesOf: (frame) => variablesOf(frame, true),
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  // A model program may end with an uncaught exception to show how one stops the program.
  const run = runModule(runtime, parsed, (frame) => {
    finalVars = variablesOf(frame, false).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

/** The variables a frame shows: its own, then the class variables and the fields of `self` when `withContext`. */
function variablesOf(frame: Frame, withContext: boolean): TraceVariables {
  const variables: TraceVariables = { vars: {}, referenceVars: {} };
  for (const [name, value] of namedValues(frame)) addVariable(variables, name, value);
  if (!withContext) return variables;
  addClassVariables(variables, frame.globals);
  const self = selfOf(frame);
  if (self) addSelf(variables, self.name, self.value);
  return variables;
}

/** The variables of a frame in the order learners see them declared. */
function namedValues(frame: Frame): [string, PyValue][] {
  if (frame.kind === 'module' || frame.kind === 'class') {
    return [...frame.locals].filter(([name, value]) => !isDunder(name) && isVariableValue(value));
  }
  const values: [string, PyValue][] = [];
  for (const name of frame.scope.locals) {
    const value = frame.locals.get(name) ?? frame.cells.get(name)?.value;
    if (value !== undefined && isVariableValue(value)) values.push([name, value]);
  }
  return values;
}

function isDunder(name: string): boolean {
  return name.startsWith('__') && name.endsWith('__');
}

/** Functions, classes, and modules are definitions, not variables, to learners. */
function isVariableValue(value: PyValue): boolean {
  return !(
    value instanceof PyFunction ||
    value instanceof PyClass ||
    value instanceof PyModule ||
    value instanceof PyBuiltinFunction ||
    value instanceof PyBoundMethod ||
    value instanceof PyDescriptor ||
    value instanceof PyOpaque ||
    (value instanceof PyInstance && isLibraryClass(value.cls))
  );
}

/**
 * Whether a class is one that a standard library module written in Python defines, such as `threading.Thread`, whose
 * instances the trace hides as it hides those of the builtin classes.
 */
function isLibraryClass(cls: PyClass): boolean {
  return !cls.isBuiltin && cls.module !== '__main__';
}

/** The instance a method runs on: its first parameter, which plays the role of Java's `this`. */
function selfOf(frame: Frame): { name: string; value: PyObject } | undefined {
  const fn = frame.fn;
  if (frame.kind !== 'function' || !fn?.def.isMethod || fn.isStaticOrClassMethod) return undefined;
  const first = fn.def.params[0];
  if (!first || first.kind === 'varArgs' || first.kind === 'varKeywords') return undefined;
  const value = frame.locals.get(first.name) ?? frame.cells.get(first.name)?.value;
  if (value instanceof PyInstance) return value.enumValue === undefined ? { name: first.name, value } : undefined;
  // An instance of a subclass of a builtin type such as list shows the attributes the methods give it too.
  return value instanceof PyObject && !(value instanceof PyClass) && !value.cls.isBuiltin
    ? { name: first.name, value }
    : undefined;
}

/**
 * The attributes of an instance: those `__slots__` declares, then those in its `__dict__`. An instance of a program's
 * subclass of a library class shows only its public attributes, not the private ones the library's code sets.
 */
function attributesOf(instance: PyObject): [string, PyValue][] {
  const own = instance instanceof PyInstance ? instance.dict : instance.instanceDict;
  const attributes = [...(instance.slotValues ?? []), ...(own ?? [])];
  if (!instance.cls.mro.some(isLibraryClass)) return attributes;
  return attributes.filter(([name]) => !name.startsWith('_'));
}

function addVariable(variables: TraceVariables, name: string, value: PyValue): void {
  const scalar = scalarOf(value, new Set());
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  // Lists and tuples also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !(value instanceof PyList || value instanceof PyTuple)) return;
  const node = displayNodeOf(value, new Set());
  if (node) variables.referenceVars[name] = node;
}

function addSelf(variables: TraceVariables, name: string, self: PyObject): void {
  for (const [key, value] of attributesOf(self)) {
    if (!isVariableValue(value)) continue;
    const scalar = scalarOf(value, new Set());
    if (scalar !== NOT_SCALAR) variables.vars[`${name}.${key}`] = scalar;
  }
}

/** The class variables of the classes the program defined, as Java shows static fields. */
function addClassVariables(variables: TraceVariables, globals: Map<string, PyValue>): void {
  for (const value of globals.values()) {
    if (!(value instanceof PyClass) || value.isBuiltin || isLibraryClass(value) || value.enumMembers) continue;
    for (const [key, field] of value.dict) {
      if (isDunder(key) || !isVariableValue(field)) continue;
      const scalar = scalarOf(field, new Set());
      if (scalar !== NOT_SCALAR) variables.vars[`${value.name}.${key}`] = scalar;
    }
  }
}

const NOT_SCALAR = Symbol('notScalar');
type Scalar = TraceItemVariable[string];

// code-gauge-allow duplicateLines 16 -- Each language converts its own values for the trace.
function scalarOf(item: PyValue, seen: Set<PyObject>): Scalar | typeof NOT_SCALAR {
  if (item instanceof PyInstance && item.enumValue !== undefined) return NOT_SCALAR;
  const value = unbox(item);
  switch (typeof value) {
    case 'bigint': {
      return traceIntOf(value);
    }
    case 'number':
    case 'string':
    case 'boolean': {
      return value;
    }
  }
  if (!(value instanceof PyList || value instanceof PyTuple) || seen.has(value)) return NOT_SCALAR;
  seen.add(value);
  const items: Scalar[] = [];
  for (const item of value.items) {
    if (item === None) {
      // oxlint-disable-next-line unicorn/no-null -- The trace format shows None as null.
      items.push(null);
      continue;
    }
    const scalar = scalarOf(item, seen);
    if (scalar === NOT_SCALAR) return NOT_SCALAR;
    items.push(scalar);
  }
  seen.delete(value);
  return items as Scalar;
}

function traceIntOf(value: bigint): number | bigint {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}

// oxlint-disable-next-line unicorn/no-null -- The trace format shows None as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

/** The node showing a value as learners see it, or `undefined` for a value the trace hides. */
// code-gauge-allow functionCognitiveComplexity 23 -- One case per kind of value the trace shows.
// code-gauge-allow functionNcss 33 -- One case per kind of value the trace shows.
function displayNodeOf(item: PyValue, seen: Set<PyObject>): DisplayNode | undefined {
  if (item instanceof PyInstance && item.enumValue !== undefined) {
    if (!isVariableValue(item) || seen.has(item)) return undefined;
    const name = item.dict.get('_name_');
    // A Flag value that no member names, such as `Perm(0)`, is shown as its value.
    return typeof name === 'string' ? { kind: 'value', value: name } : displayNodeOf(item.enumValue, seen);
  }
  const value = unbox(item);
  if (typeof value === 'bigint') return { kind: 'value', value: traceIntOf(value) };
  if (typeof value !== 'object') return { kind: 'value', value };
  if (value === None) return NULL_NODE;
  if (!isVariableValue(value) || value instanceof PyGenerator || value instanceof PyIterator || seen.has(value)) {
    return undefined;
  }
  if (value instanceof PyRange)
    return {
      kind: 'value',
      value: `range(${value.start}, ${value.stop}${value.step === 1n ? '' : `, ${value.step}`})`,
    };
  if (value instanceof PyComplex) return { kind: 'value', value: complexRepr(value) };
  if (value instanceof PyBytes) return { kind: 'value', value: bytesText(value) };
  if (value instanceof PyMemoryView) return undefined;
  if (value instanceof PyNumberInstance) return { kind: 'value', value: value.reprText() };
  if (value instanceof PyInstance && value.turtle) {
    if (!value.turtle.isAlive) return undefined;
    return {
      kind: 'object',
      entries: { x: { kind: 'value', value: value.turtle.x }, y: { kind: 'value', value: value.turtle.y } },
    };
  }
  seen.add(value);
  try {
    return containerNodeOf(value, seen);
  } finally {
    seen.delete(value);
  }
}

function containerNodeOf(value: PyObject, seen: Set<PyObject>): DisplayNode {
  const entries: Record<string, DisplayNode> = {};
  if (value instanceof PyList || value instanceof PyTuple || value instanceof PySet || value instanceof PyDeque) {
    const items = value instanceof PySet ? value.table.keys() : value.items;
    for (const [index, item] of items.entries()) entries[index] = displayNodeOf(item, seen) ?? NULL_NODE;
    return { kind: 'array', entries };
  }
  if (value instanceof PyDict) {
    const ordered = value.store.ordered();
    const labels = keyLabels(ordered.map((entry) => entry.key));
    for (const [index, entry] of ordered.entries())
      entries[labels[index]] = displayNodeOf(entry.value, seen) ?? NULL_NODE;
  } else if (value instanceof PyInstance) {
    addAttributeNodes(entries, value, seen);
  }
  return { kind: 'object', entries };
}

function addAttributeNodes(entries: Record<string, DisplayNode>, instance: PyInstance, seen: Set<PyObject>): void {
  for (const [key, item] of attributesOf(instance)) {
    if (!isVariableValue(item)) continue;
    const node = displayNodeOf(item, seen);
    if (node) entries[key] = node;
  }
}

/**
 * Labels a dict's keys, distinct for distinct keys: by their text when no two keys share one, and otherwise by their
 * literals, with strings quoted, where only keys that are no literal (instances, or NaNs) can share a label, so those
 * get their position among the keys sharing it, a form no literal takes.
 */
function keyLabels(keys: PyValue[]): string[] {
  const texts = keys.map((key) => keyText(key, false));
  if (new Set(texts).size === texts.length) return texts;
  const literals = keys.map((key) => keyText(key, true));
  const counts = new Map<string, number>();
  for (const literal of literals) counts.set(literal, (counts.get(literal) ?? 0) + 1);
  const positions = new Map<string, number>();
  return literals.map((literal) => {
    if (counts.get(literal) === 1) return literal;
    const position = (positions.get(literal) ?? 0) + 1;
    positions.set(literal, position);
    return `${literal} (${position})`;
  });
}

/** A dict key as text, quoting strings when `quoted`, without running any of the program's own methods. */
function keyText(item: PyValue, quoted: boolean): string {
  const key = unbox(item);
  if (typeof key === 'string') return quoted ? strRepr(key) : key;
  if (typeof key === 'boolean') return key ? 'True' : 'False';
  if (typeof key === 'bigint' || typeof key === 'number') return String(key);
  if (key === None) return 'None';
  if (key instanceof PyTuple) {
    const items = key.items.map((item) => keyText(item, quoted));
    return `(${items.join(', ')}${items.length === 1 ? ',' : ''})`;
  }
  return `<${key.cls.name}>`;
}
