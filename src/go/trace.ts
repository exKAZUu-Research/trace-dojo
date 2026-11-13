import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { type CompiledProgram, compileProgram } from './compiler';
import { runProgram } from './execute';
import { formatFloat } from './floatFormat';
import { utf8Decode } from './literals';
import { compareMapKeys } from './mapOrder';
import { parseGo } from './parse';
import { type Frame, Runtime, UNASSIGNED } from './runtime';
import { type Type, underlying } from './types';
import { Cell, Complex, GoArray, GoMap, GoStruct, Iface, Pointer, Slice, type Value } from './values';

// code-gauge-allow duplicateLines 15 -- Each language wires its own runtime into the shared TraceRecorder alike.
export function traceGoProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const compiled = compileProgram(parseGo(program), { atomicRows: new Set(trace.atomicAnnotations.keys()) });
  const runtime = new Runtime(input);
  const snapshotter = new Snapshotter(runtime, compiled);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.info.isAtomic,
    variablesOf: (frame) => snapshotter.variablesOf(frame, true),
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  // A model program may end with a panic to show how one stops the program.
  const run = runProgram(runtime, compiled, (frame) => {
    finalVars = snapshotter.variablesOf(frame, false).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

class Snapshotter {
  constructor(
    private readonly runtime: Runtime,
    private readonly program: CompiledProgram
  ) {}

  /**
   * The variables a frame shows: its locals in scope and the variables its closure captured, then, when
   * `withGlobals`, the package-level variables that no local hides. A receiver's fields also show as `t.x`, as
   * Java's `this.x`.
   */
  variablesOf(frame: Frame, withGlobals: boolean): TraceVariables {
    const variables: TraceVariables = { vars: {}, referenceVars: {} };
    const shown = new Set<string>();
    for (const local of frame.info.locals) {
      const stored = frame.locals[local.slot];
      if (stored === UNASSIGNED) continue;
      const value = stored instanceof Cell ? stored.v : stored;
      shown.add(local.name);
      addVariable(variables, local.name, value, local.type);
      if (local.isReceiver) addReceiverFields(variables, local.name, value, local.type);
    }
    for (const [index, capture] of frame.info.captures.entries()) {
      if (shown.has(capture.name)) continue;
      shown.add(capture.name);
      addVariable(variables, capture.name, frame.cells[index].v, capture.type);
    }
    if (!withGlobals) return variables;
    for (const global of this.program.globals) {
      if (shown.has(global.name)) continue;
      addVariable(variables, global.name, this.runtime.globals[global.slot].v, global.type);
    }
    return variables;
  }
}

type Scalar = TraceItemVariable[string];
const NOT_SCALAR = Symbol('notScalar');

function addVariable(variables: TraceVariables, name: string, value: Value, type: Type): void {
  if (underlying(type).kind === 'func') return;
  const scalar = scalarOf(value, type);
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  // Arrays and slices also appear as references so that learners can expand their elements.
  const kind = underlying(type).kind;
  if (scalar !== NOT_SCALAR && kind !== 'array' && kind !== 'slice') return;
  const node = displayNodeOf(value, type, new Set());
  if (node) variables.referenceVars[name] = node;
}

/** A receiver's fields show as `t.x`, as Java shows `this.x`. */
function addReceiverFields(variables: TraceVariables, name: string, value: Value, type: Type): void {
  let struct: Value = value;
  let structType = type;
  if (value instanceof Pointer) {
    struct = value.load();
    structType = (underlying(type) as { element: Type }).element;
  }
  const under = underlying(structType);
  if (!(struct instanceof GoStruct) || under.kind !== 'struct') return;
  for (const [index, field] of under.fields.entries()) {
    const scalar = scalarOf(struct.fields[index], field.type);
    if (scalar !== NOT_SCALAR) variables.vars[`${name}.${field.name}`] = scalar;
  }
}

// code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of type.
function scalarOf(value: Value, type: Type): Scalar | typeof NOT_SCALAR {
  const under = underlying(type);
  switch (under.kind) {
    case 'basic': {
      return basicScalar(value);
    }
    case 'array':
    case 'slice': {
      if (!hasScalarElements(under.element)) return NOT_SCALAR;
      const items = value instanceof GoArray ? value.elements : value instanceof Slice ? value.values() : [];
      return items.map((item) => {
        const scalar = scalarOf(item, under.element);
        // oxlint-disable-next-line unicorn/no-null -- The trace format shows nil as null.
        return scalar === NOT_SCALAR ? null : scalar;
      }) as Scalar;
    }
    case 'interface': {
      return value instanceof Iface ? scalarOf(value.value, value.type) : NOT_SCALAR;
    }
    default: {
      return NOT_SCALAR;
    }
  }
}

function basicScalar(value: Value): Scalar {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return utf8Decode(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Complex) {
    return `(${formatFloat(value.re, 'g', -1, 64)}${value.im >= 0 || Number.isNaN(value.im) ? '+' : ''}${formatFloat(value.im, 'g', -1, 64)}i)`;
  }
  // oxlint-disable-next-line unicorn/no-null -- The trace format shows nil as null.
  return null;
}

function hasScalarElements(type: Type): boolean {
  const under = underlying(type);
  if (under.kind === 'array' || under.kind === 'slice') return hasScalarElements(under.element);
  return under.kind === 'basic';
}

// oxlint-disable-next-line unicorn/no-null -- The trace format shows nil as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

function displayNodeOf(value: Value, type: Type, seen: Set<unknown>): DisplayNode | undefined {
  const under = underlying(type);
  if (under.kind === 'func') return undefined;
  if (value === undefined) return NULL_NODE;
  if (under.kind === 'basic') return { kind: 'value', value: basicScalar(value) as number | string | boolean | null };
  if (value instanceof Iface) return displayNodeOf(value.value, value.type, seen);
  if (value instanceof Pointer) return pointerNodeOf(value, (under as { element: Type }).element, seen);
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    return containerNodeOf(value, under, seen);
  } finally {
    seen.delete(value);
  }
}

/** What a pointer refers to, shown in its place: a turtle shows its position, as Java shows a Turtle. */
function pointerNodeOf(pointer: Pointer, element: Type, seen: Set<unknown>): DisplayNode | undefined {
  const target = pointer.load();
  const turtle = target instanceof GoStruct ? target.native?.turtle : undefined;
  if (turtle) {
    if (!turtle.isAlive) return undefined;
    return {
      kind: 'object',
      entries: { x: { kind: 'value', value: turtle.x }, y: { kind: 'value', value: turtle.y } },
    };
  }
  if (seen.has(pointer.base)) return undefined;
  seen.add(pointer.base);
  try {
    return displayNodeOf(target, element, seen);
  } finally {
    seen.delete(pointer.base);
  }
}

/** Structs show as objects of their fields, arrays and slices as arrays, and maps as objects keyed by their keys. */
function containerNodeOf(value: Value, under: Type, seen: Set<unknown>): DisplayNode | undefined {
  if (value instanceof GoStruct && under.kind === 'struct') {
    // A strings.Builder shows the text it holds, as Java shows a StringBuilder.
    const builder = value.native?.builder;
    if (typeof builder === 'string') return { kind: 'value', value: utf8Decode(builder) };
    const entries: Record<string, DisplayNode> = {};
    for (const [index, field] of under.fields.entries()) {
      const node = displayNodeOf(value.fields[index], field.type, seen);
      if (node) entries[field.name] = node;
    }
    return { kind: 'object', entries };
  }
  if ((value instanceof GoArray || value instanceof Slice) && (under.kind === 'array' || under.kind === 'slice')) {
    const items = value instanceof GoArray ? value.elements : value.values();
    const entries: Record<string, DisplayNode> = {};
    for (const [index, item] of items.entries()) entries[index] = displayNodeOf(item, under.element, seen) ?? NULL_NODE;
    return { kind: 'array', entries };
  }
  if (value instanceof GoMap && under.kind === 'map') {
    const entries: Record<string, DisplayNode> = {};
    const sorted = [...value.entries.values()].toSorted((a, b) => compareMapKeys(a.key, b.key, under.key));
    for (const entry of sorted) {
      const keyNode = displayNodeOf(entry.key, under.key, new Set());
      const key = keyNode?.kind === 'value' ? String(keyNode.value) : '?';
      entries[key] = displayNodeOf(entry.value, under.value, seen) ?? NULL_NODE;
    }
    return { kind: 'object', entries };
  }
  return undefined;
}
