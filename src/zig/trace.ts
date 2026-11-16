// code-gauge-allow-file duplicateLines 17 -- Library types repeat the same shape of method on purpose, each over its own state.
import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable, TraceScalar } from '../problems/trace';
import { type CompiledProgram, compileProgram } from './compiler';
import { runProgram } from './execute';
import { type AnyFloat, BigFloat, shortestDecimal, toNumber } from './floats';
import { stringBytes } from './fmt';
import { parseZig } from './parse';
import { type Frame, Runtime } from './runtime';
import { UNASSIGNED } from './semaBase';
import type { Type } from './types';
import {
  ErrorValue,
  NativeHandle,
  NULL,
  type Pointer,
  type Slice,
  Some,
  type Value,
  ZArray,
  ZStruct,
  ZUnion,
} from './values';

export function traceZigProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const compiled = compileProgram(parseZig(program), {
    atomicRows: new Set(trace.atomicAnnotations.keys()),
  });
  const runtime = new Runtime(input);
  const snapshotter = new Snapshotter(compiled);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.fn.isAtomic,
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
  constructor(private readonly program: CompiledProgram) {}

  /**
   * The variables a frame shows: its locals in scope, then, when `withGlobals`, the container-level variables. A
   * method's receiver also shows its fields as `self.x`, as Java's `this.x`.
   */
  variablesOf(frame: Frame, withGlobals: boolean): TraceVariables {
    const variables: TraceVariables = { vars: {}, referenceVars: {} };
    if (frame.fn.internal) return variables;
    const shown = new Set<string>();
    for (const local of frame.fn.locals) {
      const value = frame.slots[local.slot];
      if (value === UNASSIGNED || local.name.startsWith('\0') || local.name === '_') continue;
      shown.add(local.name);
      addVariable(variables, local.name, value, local.type);
      if (local.isReceiver) addReceiverFields(variables, local.name, value, local.type);
    }
    if (!withGlobals) return variables;
    for (const global of this.program.globals) {
      if (shown.has(global.name)) continue;
      addVariable(variables, global.name, global.cell.slots[0], global.type);
    }
    return variables;
  }
}

type Scalar = TraceItemVariable[string];
const NOT_SCALAR = Symbol('notScalar');

function addVariable(variables: TraceVariables, name: string, value: Value, type: Type): void {
  if (type.kind === 'fn' || (type.kind === 'pointer' && type.child.kind === 'fn')) return;
  const scalar = scalarOf(value, type);
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  // Arrays and slices also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !isSequence(type)) return;
  const node = displayNodeOf(value, type, new Set());
  if (node) variables.referenceVars[name] = node;
}

function isSequence(type: Type): boolean {
  if (type.kind === 'array') return !isByte(type.child) || true;
  if (type.kind === 'pointer')
    return type.size === 'slice' ? !isByte(type.child) : type.child.kind === 'array' && !isByte(type.child.child);
  return false;
}

/** A receiver's fields show as `self.x`, as Java shows `this.x`. */
function addReceiverFields(variables: TraceVariables, name: string, value: Value, type: Type): void {
  let struct = value;
  let structType = type;
  if (type.kind === 'pointer' && type.size === 'one') {
    struct = (value as Pointer).load();
    structType = type.child;
  }
  if (structType.kind !== 'struct' || !(struct instanceof ZStruct)) return;
  for (const [index, field] of (structType.fields ?? []).entries()) {
    const scalar = scalarOf(struct.slots[index], field.type);
    if (scalar !== NOT_SCALAR) variables.vars[`${name}.${field.name}`] = scalar;
  }
}

function isByte(type: Type): boolean {
  return type.kind === 'int' && type.bits === 8 && !type.signed;
}

function isString(type: Type): boolean {
  if (type.kind === 'pointer')
    return type.size === 'slice' ? isByte(type.child) : type.child.kind === 'array' && isByte(type.child.child);
  return false;
}

// code-gauge-allow functionNcss 41 -- One case per kind of syntax node, type, or format specifier, as Zig defines them.
// code-gauge-allow functionCognitiveComplexity 27 -- One case per kind of syntax node, type, or format specifier, as Zig defines them.
function scalarOf(value: Value, type: Type): Scalar | typeof NOT_SCALAR {
  if (value === UNASSIGNED) return NOT_SCALAR;
  switch (type.kind) {
    case 'int':
    case 'comptime_int':
    case 'comptime_float':
    case 'bool': {
      return basicScalar(value);
    }
    case 'float': {
      if (type.bits > 32 || typeof value !== 'number' || !Number.isFinite(value)) return basicScalar(value);
      const decimal = shortestDecimal(value, type.bits);
      return Number(`${decimal.sign ? '-' : ''}${decimal.mantissa}e${decimal.exponent}`);
    }
    case 'enum': {
      const field = type.fields?.find((each) => each.value === value);
      return field ? `.${field.name}` : basicScalar(value);
    }
    case 'error_set': {
      return value instanceof ErrorValue ? `error.${value.name}` : NOT_SCALAR;
    }
    case 'optional': {
      // An optional object is a reference, which shows among the references as Java's null references do.
      if (!hasScalarElements(type.child)) return NOT_SCALAR;
      // oxlint-disable-next-line unicorn/no-null -- The trace format shows null as null.
      if (value === NULL) return null;
      return scalarOf(value instanceof Some ? value.value : value, type.child);
    }
    case 'error_union': {
      if (value instanceof ErrorValue) return `error.${value.name}`;
      return scalarOf(value, type.payload);
    }
    case 'pointer': {
      if (isString(type)) return new TextDecoder().decode(new Uint8Array(stringBytes(value, type).map(Number)));
      if (type.size === 'slice' && hasScalarElements(type.child)) {
        return (value as Slice).values().map((item) => toArrayItem(scalarOf(item, type.child)));
      }
      return NOT_SCALAR;
    }
    case 'array': {
      if (!hasScalarElements(type.child) || !(value instanceof ZArray)) return NOT_SCALAR;
      return value.values().map((item) => toArrayItem(scalarOf(item, type.child)));
    }
    default: {
      return NOT_SCALAR;
    }
  }
}

function toArrayItem(scalar: Scalar | typeof NOT_SCALAR): TraceScalar | TraceItemVariable[string] {
  // oxlint-disable-next-line unicorn/no-null -- The trace format shows a missing value as null.
  return scalar === NOT_SCALAR ? null : scalar;
}

function hasScalarElements(type: Type): boolean {
  if (type.kind === 'array') return hasScalarElements(type.child);
  if (type.kind === 'pointer' && type.size === 'slice' && !isString(type)) return hasScalarElements(type.child);
  if (type.kind === 'optional') return hasScalarElements(type.child);
  return type.kind === 'int' || type.kind === 'float' || type.kind === 'bool' || type.kind === 'enum' || isString(type);
}

function basicScalar(value: Value): TraceScalar {
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof BigFloat) return toNumber(value as AnyFloat as BigFloat);
  // oxlint-disable-next-line unicorn/no-null -- The trace format shows a missing value as null.
  return null;
}

// oxlint-disable-next-line unicorn/no-null -- The trace format shows null as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

function displayNodeOf(value: Value, type: Type, seen: Set<unknown>): DisplayNode | undefined {
  if (typeof value !== 'object' || type.kind === 'optional' || type.kind === 'error_union')
    return displayValue(value, type, seen);
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    return displayValue(value, type, seen);
  } finally {
    seen.delete(value);
  }
}

function displayValue(value: Value, type: Type, seen: Set<unknown>): DisplayNode | undefined {
  if (value === UNASSIGNED) return undefined;
  if (type.kind === 'fn' || (type.kind === 'pointer' && type.child.kind === 'fn')) return undefined;
  if (value instanceof NativeHandle) {
    const turtle = value.state.turtle;
    if (!turtle) return { kind: 'object', entries: {} };
    if (!turtle.isAlive) return undefined;
    return {
      kind: 'object',
      entries: { x: { kind: 'value', value: turtle.x }, y: { kind: 'value', value: turtle.y } },
    };
  }
  const scalar = scalarOf(value, type);
  if (scalar !== NOT_SCALAR && !Array.isArray(scalar)) return { kind: 'value', value: scalar };
  switch (type.kind) {
    case 'optional': {
      if (value === NULL) return NULL_NODE;
      return displayNodeOf(value instanceof Some ? value.value : value, type.child, seen);
    }
    case 'error_union': {
      return displayNodeOf(value, type.payload, seen);
    }
    case 'pointer': {
      if (type.size === 'slice') return sequenceNode((value as Slice).values(), type.child, seen);
      const target = (value as Pointer).load();
      return displayNodeOf(target, type.child, seen);
    }
    case 'array': {
      return sequenceNode((value as ZArray).values(), type.child, seen);
    }
    case 'struct': {
      if (!(value instanceof ZStruct)) return undefined;
      const entries: Record<string, DisplayNode> = {};
      for (const [index, field] of (type.fields ?? []).entries()) {
        const node = displayNodeOf(field.comptimeValue ?? value.slots[index], field.type, seen);
        if (node) entries[field.name] = node;
      }
      return { kind: type.isTuple ? 'array' : 'object', entries };
    }
    case 'union': {
      if (!(value instanceof ZUnion)) return undefined;
      const field = type.fields?.[value.tag];
      if (!field) return undefined;
      const node = displayNodeOf(value.slots[0], field.type, seen);
      return { kind: 'object', entries: node ? { [field.name]: node } : {} };
    }
    default: {
      return undefined;
    }
  }
}

function sequenceNode(items: Value[], child: Type, seen: Set<unknown>): DisplayNode {
  const entries: Record<string, DisplayNode> = {};
  for (const [index, item] of items.entries()) entries[index] = displayNodeOf(item, child, seen) ?? NULL_NODE;
  return { kind: 'array', entries };
}
