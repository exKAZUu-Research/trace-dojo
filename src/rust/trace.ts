import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable, TraceScalar } from '../problems/trace';
import { buildProgram } from './build';
import { runProgram } from './execute';
import { debugFloat, displayFloat } from './floatFormat';
import { DEFAULT_SPEC, Formatter } from './fmt';
import { normalize } from './infer';
import { fieldTypes } from './interpreter';
import { type Frame, MOVED, Runtime, UNASSIGNED } from './runtime';
import { concreteType } from './runtimeTypes';
import { shallow, type Type } from './types';
import {
  DynValue,
  EnumValue,
  FnValue,
  isPlace,
  IterValue,
  MapValue,
  SetValue,
  sliceItems,
  SliceView,
  StructValue,
  TurtleValue,
  type Value,
} from './values';

export function traceRustProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const built = buildProgram(program, new Set(trace.atomicAnnotations.keys()));
  const runtime = new Runtime(input);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.info.isAtomic,
    variablesOf: (frame) => variablesOf(frame),
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  // A model program may end with a panic to show how one stops the program.
  const run = runProgram(runtime, built, true, (frame) => {
    finalVars = variablesOf(frame).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

/**
 * The variables a frame shows: its locals in scope, then the variables a closure captured. `self`'s fields show as
 * `self.x`, as Java's `this.x`.
 */
function variablesOf(frame: Frame): TraceVariables {
  const variables: TraceVariables = { vars: {}, referenceVars: {} };
  const shown = new Set<string>();
  let receiver: { stored: Value; type: Type } | undefined;
  for (const local of frame.info.locals) {
    const sharedPlace = frame.referents.get(local.slot)?.place;
    const stored = sharedPlace ? (sharedPlace.get() as Value | typeof UNASSIGNED) : frame.locals[local.slot];
    if (stored === UNASSIGNED) continue;
    const type = concreteType(local.type, frame.typeArgs);
    if (local.isSelf) {
      receiver = { stored, type };
      continue;
    }
    if (shown.has(local.name)) {
      delete variables.vars[local.name];
      delete variables.referenceVars[local.name];
    }
    shown.add(local.name);
    addVariable(variables, local.name, stored, type);
  }
  for (const [index, capture] of frame.info.captures.entries()) {
    if (shown.has(capture.name)) continue;
    const place = frame.captures[index];
    if (!place) continue;
    addVariable(variables, capture.name, place.get(), concreteType(capture.type, frame.typeArgs));
  }
  if (receiver) addSelf(variables, receiver.stored, receiver.type);
  return variables;
}

type Scalar = TraceItemVariable[string];
const NOT_SCALAR = Symbol('notScalar');

function addVariable(variables: TraceVariables, name: string, value: Value, type: Type): void {
  const t = derefType(type);
  if (t.kind === 'closure' || t.kind === 'fn') return;
  const scalar = scalarOf(value, type);
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  // Arrays and vectors also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !isSequence(t)) return;
  const node = displayNodeOf(value, type, new Set());
  if (node) variables.referenceVars[name] = node;
}

function addSelf(variables: TraceVariables, value: Value, type: Type): void {
  const t = derefType(type);
  const target = deref(value);
  if (t.kind === 'adt' && target instanceof StructValue) {
    const types = fieldTypes(t.def, t.args, 0);
    for (const [index, field] of t.def.variants[0].fields.entries()) {
      const scalar = scalarOf(target.fields[index], types[index]);
      if (scalar !== NOT_SCALAR) variables.vars[`self.${field.name}`] = scalar;
    }
  }
  const node = displayNodeOf(value, type, new Set());
  if (node) variables.referenceVars.self = node;
}

function deref(value: Value): Value {
  let current = value;
  while (isPlace(current)) current = current.get();
  return current;
}

function derefType(type: Type): Type {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  if (t.kind === 'adt' && t.def.builtin === 'Box') return derefType(t.args[0]);
  return t;
}

function isSequence(t: Type): boolean {
  return (
    t.kind === 'array' ||
    t.kind === 'slice' ||
    (t.kind === 'adt' && (t.def.builtin === 'Vec' || t.def.builtin === 'VecDeque'))
  );
}

function elementType(t: Type): Type | undefined {
  if (t.kind === 'array' || t.kind === 'slice') return t.elem;
  if (t.kind === 'adt' && (t.def.builtin === 'Vec' || t.def.builtin === 'VecDeque')) return t.args[0];
  return undefined;
}

function scalarOf(value: Value, type: Type): Scalar | typeof NOT_SCALAR {
  const t = derefType(type);
  const v = deref(value);
  if (v === MOVED) return NOT_SCALAR;
  switch (t.kind) {
    case 'int': {
      const number = Number(v as bigint);
      return Number.isSafeInteger(number) ? number : (v as bigint);
    }
    case 'float': {
      // Learners write a float as Java shows a double.
      return Number(t.name === 'f32' ? displayFloat(v as number, true) : (v as number));
    }
    case 'bool': {
      return v as boolean;
    }
    case 'char':
    case 'str': {
      return v as string;
    }
    case 'adt': {
      if (t.def.builtin === 'String') return v as string;
      if (t.def.builtin === 'Vec' || t.def.builtin === 'VecDeque') return sequenceScalar(v, t);
      return NOT_SCALAR;
    }
    case 'array':
    case 'slice': {
      return sequenceScalar(v, t);
    }
    default: {
      return NOT_SCALAR;
    }
  }
}

function sequenceScalar(value: Value, t: Type): Scalar | typeof NOT_SCALAR {
  const elem = elementType(t);
  if (!elem || !hasScalarElements(elem)) return NOT_SCALAR;
  return sliceItems(value).map((item) => {
    const scalar = scalarOf(item, elem);
    // oxlint-disable-next-line unicorn/no-null -- The trace format shows a missing value as null.
    return scalar === NOT_SCALAR ? null : scalar;
  }) as Scalar;
}

function hasScalarElements(type: Type): boolean {
  const t = derefType(type);
  const elem = elementType(t);
  if (elem) return hasScalarElements(elem);
  return (
    t.kind === 'int' ||
    t.kind === 'float' ||
    t.kind === 'bool' ||
    t.kind === 'char' ||
    t.kind === 'str' ||
    (t.kind === 'adt' && t.def.builtin === 'String')
  );
}

// oxlint-disable-next-line unicorn/no-null -- The trace format shows a missing value as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

// code-gauge-allow functionCognitiveComplexity 16 -- One case per kind of value the trace shows.
function displayNodeOf(value: Value, type: Type, seen: Set<unknown>): DisplayNode | undefined {
  const t = derefType(type);
  const v = deref(value);
  // A part moved out (`let a = s.a;`) leaves what held it.
  if (v === MOVED || t.kind === 'closure' || t.kind === 'fn') return undefined;
  if (v instanceof DynValue) return displayNodeOf(v.value, v.type, seen);
  if (v instanceof TurtleValue) {
    if (!v.state.isAlive) return undefined;
    return {
      kind: 'object',
      entries: { x: { kind: 'value', value: v.state.x }, y: { kind: 'value', value: v.state.y } },
    };
  }
  const scalar = scalarOf(v, t);
  if (scalar !== NOT_SCALAR && !isSequence(t)) return { kind: 'value', value: scalar as TraceScalar };
  if (v instanceof FnValue || v instanceof IterValue) return undefined;
  if (typeof v === 'object' && v !== null) {
    if (seen.has(v)) return undefined;
    seen.add(v);
  }
  try {
    return containerNodeOf(v, t, seen);
  } finally {
    if (typeof v === 'object' && v !== null) seen.delete(v);
  }
}

function containerNodeOf(v: Value, t: Type, seen: Set<unknown>): DisplayNode | undefined {
  const elem = elementType(t);
  if (elem && (Array.isArray(v) || v instanceof SliceView)) return arrayNodeOf(sliceItems(v), elem, seen);
  if (t.kind === 'tuple' && Array.isArray(v)) return tupleNodeOf(v, t.elems, seen);
  if (t.kind !== 'adt') return undefined;
  if (v instanceof StructValue) {
    const types = fieldTypes(t.def, t.args, 0);
    return { kind: 'object', entries: fieldEntries(v.fields, t.def.variants[0].fields, types, seen) };
  }
  if (v instanceof EnumValue) return enumNodeOf(v, t, seen);
  if (v instanceof MapValue) return mapNodeOf(v, t, seen);
  if (v instanceof SetValue) {
    const items = [...v.entries.values()];
    return arrayNodeOf(items, t.args[0], seen);
  }
  return undefined;
}

function arrayNodeOf(items: Value[], elem: Type, seen: Set<unknown>): DisplayNode {
  const entries: Record<string, DisplayNode> = {};
  for (const [index, item] of items.entries()) entries[index] = displayNodeOf(item, elem, seen) ?? NULL_NODE;
  return { kind: 'array', entries };
}

function tupleNodeOf(items: Value[], types: Type[], seen: Set<unknown>): DisplayNode {
  const entries: Record<string, DisplayNode> = {};
  for (const [index, item] of items.entries()) {
    if (item !== MOVED) entries[index] = displayNodeOf(item, types[index], seen) ?? NULL_NODE;
  }
  return { kind: 'object', entries };
}

function fieldEntries(
  values: Value[],
  fields: { name: string }[],
  types: Type[],
  seen: Set<unknown>
): Record<string, DisplayNode> {
  const entries: Record<string, DisplayNode> = {};
  for (const [index, field] of fields.entries()) {
    const node = displayNodeOf(values[index], types[index], seen);
    if (node) entries[field.name] = node;
  }
  return entries;
}

function enumNodeOf(v: EnumValue, t: Type & { kind: 'adt' }, seen: Set<unknown>): DisplayNode | undefined {
  const variant = t.def.variants[v.variant];
  // `None` shows as null and `Some(x)` as x, as Java shows null and a reference.
  if (t.def.builtin === 'Option') return v.variant === 0 ? NULL_NODE : displayNodeOf(v.fields[0], t.args[0], seen);
  if (v.fields.length === 0) return { kind: 'value', value: variant.name };
  const types = fieldTypes(t.def, t.args, v.variant);
  const entries = fieldEntries(v.fields, variant.fields, types, seen);
  return { kind: 'object', entries: { [variant.name]: { kind: 'object', entries } } };
}

function mapNodeOf(v: MapValue, t: Type & { kind: 'adt' }, seen: Set<unknown>): DisplayNode {
  const entries = Object.create(null) as Record<string, DisplayNode>;
  const items = [...v.entries.values()];
  for (const [key, item] of items)
    entries[keyLabel(key, t.args[0])] = displayNodeOf(item, t.args[1], seen) ?? NULL_NODE;
  return { kind: 'object', entries };
}

/** Writes map keys that are no scalars as `{:?}` does, without running the program's own `Debug` impls. */
const keyFormatter = new Formatter({
  userFmt: () => {},
  fieldTypes,
  concrete: (type) => type,
  allocateString: () => {},
});

function keyLabel(key: Value, type: Type): string {
  const scalar = scalarOf(key, type);
  if (scalar !== NOT_SCALAR) return String(scalar);
  return keyFormatter.debug(key, type, DEFAULT_SPEC, undefined);
}

export { debugFloat };
