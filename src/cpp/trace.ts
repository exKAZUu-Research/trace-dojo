import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { byteArray } from './bytes';
import type { CompiledProgram } from './compiler';
import { CppRuntimeError } from './errors';
import { compileCpp, runProgram } from './execute';
import { MapValue, SequenceValue } from './library/containerValues';
import { StringValue } from './library/string';
import { type Frame, Runtime } from './runtime';
import { isCharType, type Type } from './types';
import { ArrayStore, Box, CObject, Liveness, Ptr, type Store, UNINIT, type Value } from './values';

// code-gauge-allow duplicateLines 15 -- Each language wires its own runtime into the shared TraceRecorder alike.
export function traceCppProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const compiled = compileCpp(program, { trace });
  const runtime = new Runtime(input);
  const snapshotter = new Snapshotter(compiled);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.fn?.isAtomic === true,
    variablesOf: (frame) => snapshotter.variablesOf(frame, true),
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  // A model program may end with an uncaught exception to show how one stops the program.
  const run = runProgram(runtime, compiled, (frame) => {
    finalVars = snapshotter.variablesOf(frame, false).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

const NOT_SCALAR = Symbol('notScalar');
type Scalar = TraceItemVariable[string];
// oxlint-disable-next-line unicorn/no-null -- The trace format shows nullptr as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

/** Reads the program's variables as learners see them, leaving out values the program never wrote. */
class Snapshotter {
  constructor(private readonly program: CompiledProgram) {}

  /** The variables a frame shows: its locals in scope, then the members of `this` and the static variables. */
  variablesOf(frame: Frame, withContext: boolean): TraceVariables {
    const variables: TraceVariables = { vars: {}, referenceVars: {} };
    const locals = frame.compiled?.locals ?? [];
    const hidesArgs = frame.fn === this.program.main && this.program.mainTakesArguments;
    for (const local of locals) {
      if (local.name.startsWith('\0') || (hidesArgs && local.isParameter)) continue;
      const slot = frame.slots[local.slot];
      if (slot === undefined) continue;
      const value =
        local.type.kind === 'reference' || slot instanceof Ptr ? readLocation(slot as Ptr) : (slot as Box).value;
      const type = local.type.kind === 'reference' ? local.type.to : local.type;
      addVariable(variables, local.name, value, type);
    }
    if (!withContext) return variables;
    const self = frame.thisObject;
    if (self && frame.fn?.owner) {
      for (const field of self.cls.fields) {
        const scalar = scalarOf(self.values[field.index], field.type);
        if (scalar !== NOT_SCALAR && scalar !== undefined) variables.vars[`this->${field.name}`] = scalar;
      }
      const node = nodeOf(self, { kind: 'class', cls: self.cls }, new Set());
      if (node) variables.referenceVars.this = node;
    }
    const runtime = frame.runtime;
    for (const global of this.program.shownGlobals) {
      if (global.name in variables.vars || global.name in variables.referenceVars) continue;
      const store = runtime.globals[global.index] as Box | undefined;
      if (!store) continue;
      if (global.type.kind === 'reference') {
        const value = store.value instanceof Ptr ? readLocation(store.value) : UNINIT;
        addVariable(variables, global.name, value, global.type.to);
      } else {
        addVariable(variables, global.name, store.value, global.type);
      }
    }
    return variables;
  }
}

function readLocation(pointer: Ptr): Value {
  const store = pointer.store;
  if (!store || store.liveness !== Liveness.Alive) return UNINIT;
  if (store instanceof Box) return pointer.index === 0 ? store.value : UNINIT;
  if (store instanceof ArrayStore || store instanceof CObject) return store.values[pointer.index];
  try {
    return store.get(pointer.index);
  } catch {
    return UNINIT;
  }
}

function addVariable(variables: TraceVariables, name: string, value: Value, type: Type): void {
  if (value === UNINIT || value === undefined) return;
  const scalar = scalarOf(value, type);
  if (scalar === undefined) return;
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  // Arrays also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !Array.isArray(scalar)) return;
  const node = nodeOf(value, type, new Set());
  if (node) variables.referenceVars[name] = node;
}

/** A value as learners write it, NOT_SCALAR for an object, or undefined for a value the program never wrote. */
// code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of type.
function scalarOf(value: Value, type: Type): Scalar | typeof NOT_SCALAR | undefined {
  if (value === UNINIT || value === undefined) return undefined;
  switch (type.kind) {
    case 'int': {
      if (type.name === 'bool') return value !== 0;
      // A char shows as the character it holds, as Java's char does.
      if (isCharType(type)) return String.fromCodePoint(Number(value) & 0xff);
      const number = Number(value);
      return Number.isSafeInteger(number) ? number : (value as bigint);
    }
    case 'float': {
      return type.name === 'float' ? shortestFloat(value as number) : (value as number);
    }
    case 'pointer': {
      const pointer = value as Ptr;
      if (pointer.isNull) return NOT_SCALAR;
      if (isCharType(type.to)) return cStringOf(pointer) ?? NOT_SCALAR;
      return NOT_SCALAR;
    }
    case 'array': {
      if (!(value instanceof ArrayStore)) return NOT_SCALAR;
      if (isCharType(type.of)) return cStringOf(new Ptr(value, 0)) ?? NOT_SCALAR;
      if (!hasScalarElements(type.of)) return NOT_SCALAR;
      return value.values.map((item) => {
        const scalar = scalarOf(item, type.of);
        // oxlint-disable-next-line unicorn/no-null -- The trace format shows values never written as null.
        return scalar === NOT_SCALAR || scalar === undefined ? null : scalar;
      }) as Scalar;
    }
    case 'class': {
      const scalar = type.cls.library?.scalarValue;
      if (scalar) {
        try {
          return scalarOf(scalar.read(value), scalar.type);
        } catch (error) {
          if (error instanceof CppRuntimeError) return;
          throw error;
        }
      }
      if (value instanceof StringValue) return value.text;
      if (value instanceof SequenceValue && value.isArrayLike && hasScalarElements(value.elementType)) {
        return value.items.map((item) => {
          const scalar = scalarOf(item, value.elementType);
          // oxlint-disable-next-line unicorn/no-null -- The trace format shows values never written as null.
          return scalar === NOT_SCALAR || scalar === undefined ? null : scalar;
        }) as Scalar;
      }
      return NOT_SCALAR;
    }
    default: {
      return NOT_SCALAR;
    }
  }
}

function hasScalarElements(type: Type): boolean {
  if (type.kind === 'array') return hasScalarElements(type.of);
  if (type.kind === 'class') {
    const kind = type.cls.library?.kind;
    if (kind === 'vector' || kind === 'array' || kind === 'deque')
      return hasScalarElements(type.cls.library?.args[0] as Type);
    return kind === 'string';
  }
  return type.kind === 'int' || type.kind === 'float';
}

/** The shortest double that rounds to the same float, which is how learners write a float's value. */
function shortestFloat(value: number): number {
  if (!Number.isFinite(value)) return value;
  for (let precision = 1; precision <= 9; precision++) {
    const candidate = Number(value.toPrecision(precision));
    if (Math.fround(candidate) === value) return candidate;
  }
  return value;
}

/** The text of a null-terminated string, or undefined when the pointer reaches none. */
function cStringOf(pointer: Ptr): string | undefined {
  try {
    const { store, index: first } = pointer;
    if (!store || store.liveness !== Liveness.Alive) return undefined;
    let bytes = '';
    for (let index = first; index < store.length; index++) {
      const value = store.get(index);
      if (value === 0) return new TextDecoder().decode(byteArray(bytes));
      bytes += String.fromCodePoint(Number(value) & 0xff);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The node that shows a value in the trace's reference view, or undefined for one that shows nothing. */
// code-gauge-allow functionCognitiveComplexity 30 -- One case per kind of value, each with its own shape.
function nodeOf(value: Value, type: Type, seen: Set<unknown>): DisplayNode | undefined {
  if (value === UNINIT || value === undefined) return undefined;
  if (type.kind === 'pointer') {
    const pointer = value as Ptr;
    if (pointer.isNull) return NULL_NODE;
    // oxlint-disable-next-line unicorn/no-null -- The trace format shows a pointer to an unreadable string as null.
    if (isCharType(type.to)) return { kind: 'value', value: cStringOf(pointer) ?? null };
    return nodeOf(readLocation(pointer), type.to, seen);
  }
  const scalar = scalarOf(value, type);
  if (scalar !== NOT_SCALAR && scalar !== undefined && !Array.isArray(scalar)) return { kind: 'value', value: scalar };
  if (typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (value instanceof CObject) {
      if (value.cls.isTurtle) {
        const turtle = value.turtle;
        if (!turtle?.isAlive) return undefined;
        return {
          kind: 'object',
          entries: { x: { kind: 'value', value: turtle.x }, y: { kind: 'value', value: turtle.y } },
        };
      }
      const entries: Record<string, DisplayNode> = {};
      if (value.message !== undefined)
        entries.message = {
          kind: 'value',
          value: new TextDecoder().decode(byteArray(value.message)),
        };
      for (const field of value.cls.fields) {
        const node = nodeOf(value.values[field.index], field.type, seen);
        if (node) entries[field.name] = node;
      }
      return { kind: 'object', entries };
    }
    if (value instanceof ArrayStore && type.kind === 'array') {
      const entries: Record<string, DisplayNode> = {};
      for (const [index, item] of value.values.entries()) entries[index] = nodeOf(item, type.of, seen) ?? NULL_NODE;
      return { kind: 'array', entries };
    }
    if (value instanceof SequenceValue) {
      const entries: Record<string, DisplayNode> = {};
      for (const [index, item] of value.items.entries())
        entries[index] = nodeOf(item, value.elementType, seen) ?? NULL_NODE;
      return { kind: 'array', entries };
    }
    if (value instanceof MapValue)
      return value.displayNode((item, itemType) => nodeOf(item, itemType, seen) ?? NULL_NODE);
    return undefined;
  } finally {
    seen.delete(value);
  }
}

export type { Store };
