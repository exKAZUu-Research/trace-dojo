import type { ProgramRecording } from '../interpreter/program';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { complexRepr } from './complexNumbers';
import type { Frame } from './frame';
import { parsePython } from './parse';
import { runModule } from './run';
import { Runtime } from './runtime';
import { None } from './types';
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
  type PyObject,
  PyOpaque,
  PyRange,
  PySet,
  PyTuple,
  type PyValue,
} from './values';

export function tracePythonProgram(program: string, trace: TraceOptions): ProgramRecording {
  const parsed = parsePython(program, trace);
  const runtime = new Runtime();
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.isAtomic,
    variablesOf: (frame) => variablesOf(frame, true),
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  // A model program may end with an uncaught exception to show how one stops the program.
  const { output: _output, ...run } = runModule(runtime, parsed, (frame) => {
    finalVars = variablesOf(frame, false).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

/** The variables a frame shows: its own, then the fields of `self` and the class variables when `withContext`. */
function variablesOf(frame: Frame, withContext: boolean): TraceVariables {
  const variables: TraceVariables = { vars: {}, referenceVars: {} };
  for (const [name, value] of namedValues(frame)) addVariable(variables, name, value);
  if (!withContext) return variables;
  const self = selfOf(frame);
  if (self) addSelf(variables, self.name, self.value);
  addClassVariables(variables, frame.globals);
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
    value instanceof PyOpaque
  );
}

/** The instance a method runs on: its first parameter, which plays the role of Java's `this`. */
function selfOf(frame: Frame): { name: string; value: PyInstance } | undefined {
  const fn = frame.fn;
  if (frame.kind !== 'function' || !fn?.def.isMethod) return undefined;
  const first = fn.def.params[0];
  if (!first || first.kind === 'varArgs' || first.kind === 'varKeywords') return undefined;
  const value = frame.locals.get(first.name) ?? frame.cells.get(first.name)?.value;
  return value instanceof PyInstance && value.enumValue === undefined ? { name: first.name, value } : undefined;
}

function addVariable(variables: TraceVariables, name: string, value: PyValue): void {
  const scalar = scalarOf(value, new Set());
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  // Lists and tuples also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !(value instanceof PyList || value instanceof PyTuple)) return;
  const node = displayNodeOf(value, new Set());
  if (node) variables.referenceVars[name] = node;
}

function addSelf(variables: TraceVariables, name: string, self: PyInstance): void {
  for (const [key, value] of self.dict) {
    if (!isVariableValue(value)) continue;
    const scalar = scalarOf(value, new Set());
    if (scalar !== NOT_SCALAR) variables.vars[`${name}.${key}`] = scalar;
  }
}

/** The class variables of the classes the program defined, as Java shows static fields. */
function addClassVariables(variables: TraceVariables, globals: Map<string, PyValue>): void {
  for (const value of globals.values()) {
    if (!(value instanceof PyClass) || value.isBuiltin || value.module !== '__main__' || value.enumMembers) continue;
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
function scalarOf(value: PyValue, seen: Set<PyObject>): Scalar | typeof NOT_SCALAR {
  switch (typeof value) {
    case 'bigint': {
      return Number(value);
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

// oxlint-disable-next-line unicorn/no-null -- The trace format shows None as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

/** The node showing a value as learners see it, or `undefined` for a value the trace hides. */
function displayNodeOf(value: PyValue, seen: Set<PyObject>): DisplayNode | undefined {
  if (typeof value === 'bigint') return { kind: 'value', value: Number(value) };
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
  if (value instanceof PyInstance && value.turtle) {
    if (!value.turtle.isAlive) return undefined;
    return {
      kind: 'object',
      entries: { x: { kind: 'value', value: value.turtle.x }, y: { kind: 'value', value: value.turtle.y } },
    };
  }
  if (value instanceof PyInstance && value.enumValue !== undefined) {
    return { kind: 'value', value: value.dict.get('_name_') as string };
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
    for (const entry of value.store.ordered())
      entries[keyText(entry.key)] = displayNodeOf(entry.value, seen) ?? NULL_NODE;
  } else if (value instanceof PyInstance) {
    addAttributeNodes(entries, value, seen);
  }
  return { kind: 'object', entries };
}

function addAttributeNodes(entries: Record<string, DisplayNode>, instance: PyInstance, seen: Set<PyObject>): void {
  for (const [key, item] of instance.dict) {
    if (!isVariableValue(item)) continue;
    const node = displayNodeOf(item, seen);
    if (node) entries[key] = node;
  }
}

/** A dict key as text, without running any of the program's own methods. */
function keyText(key: PyValue): string {
  if (typeof key === 'string') return key;
  if (typeof key === 'bigint' || typeof key === 'number' || typeof key === 'boolean') {
    return typeof key === 'boolean' ? (key ? 'True' : 'False') : String(key);
  }
  if (key === None) return 'None';
  if (key instanceof PyTuple) return `(${key.items.map(keyText).join(', ')}${key.items.length === 1 ? ',' : ''})`;
  return `<${key.cls.name}>`;
}
