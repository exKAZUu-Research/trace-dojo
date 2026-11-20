import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItem, TraceItemVariable } from '../problems/trace';
import { byteArray } from './bytes';
import type { CompiledProgram } from './compiler';
import { CppRuntimeError } from './errors';
import { compileCpp, runProgram } from './execute';
import { MapValue, SequenceValue } from './library/containerValues';
import { StringValue } from './library/string';
import { type Frame, Runtime } from './runtime';
import { type ClassInfo, isCharType, type Type } from './types';
import { ArrayStore, type Box, CObject, Ptr, type Store, UNINIT, type Value } from './values';

// code-gauge-allow duplicateLines 15 -- Each language wires its own runtime into the shared TraceRecorder alike.
export function traceCppProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const compiled = compileCpp(program, { trace });
  const runtime = new Runtime(input);
  const snapshotter = new Snapshotter(compiled);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.fn?.isAtomic === true,
    recordItem: (item) => snapshotter.recordItem(item),
    scalarVarsOf: (frame) => snapshotter.variablesOf(frame, true, false).vars,
    variablesOf: (frame) => snapshotter.variablesOf(frame, true, true),
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  // A model program may end with an uncaught exception to show how one stops the program.
  const run = runProgram(runtime, compiled, (frame) => {
    finalVars = snapshotter.variablesOf(frame, false, false).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

const NODE_COST = 32;
const NOT_SCALAR = Symbol('notScalar');
type Scalar = TraceItemVariable[string];
// oxlint-disable-next-line unicorn/no-null -- The trace format shows nullptr as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

/** Reads the program's variables as learners see them, leaving out values the program never wrote. */
class Snapshotter {
  private remaining = LIMITS.maxCppTraceSize;

  constructor(private readonly program: CompiledProgram) {}

  recordItem(item: TraceItem): TraceItem {
    this.take(item.board.length + NODE_COST * (item.callLines.length + item.turtles.length * 4 + 1));
    return item;
  }

  /** The variables a frame shows: its locals in scope, then the members of `this` and the static variables. */
  // code-gauge-allow functionCognitiveComplexity 20 -- The three scopes share the shadowing rules and snapshot budget.
  variablesOf(frame: Frame, withContext: boolean, withReferences: boolean): TraceVariables {
    this.take(NODE_COST * 2);
    const variables: TraceVariables = { vars: {}, referenceVars: {} };
    const hidesArgs = frame.fn === this.program.main && this.program.mainTakesArguments;
    const locals = activeLocals(frame, hidesArgs);
    for (const [name, { slot, type }] of locals) {
      const value = slot instanceof Ptr ? readLocation(slot) : (slot as Box).value;
      this.addVariable(variables, name, value, type.kind === 'reference' ? type.to : type, withReferences);
    }
    if (!withContext) return variables;
    const self = frame.thisObject;
    const owner = frame.fn?.owner;
    if (self && owner) this.addReceiver(variables, self, owner, withReferences);
    const runtime = frame.runtime;
    for (const global of this.program.shownGlobals) {
      if (locals.has(global.name)) continue;
      const store = runtime.globals[global.index] as Box | undefined;
      if (!store) continue;
      if (global.type.kind === 'reference') {
        const value = store.value instanceof Ptr ? readLocation(store.value) : UNINIT;
        this.addVariable(variables, global.name, value, global.type.to, withReferences);
      } else {
        this.addVariable(variables, global.name, store.value, global.type, withReferences);
      }
    }
    return variables;
  }

  private addReceiver(variables: TraceVariables, self: CObject, owner: ClassInfo, withReferences: boolean): void {
    for (const field of owner.fields) {
      const scalar = this.scalarOf(self.values[field.index], field.type);
      if (scalar === NOT_SCALAR || scalar === undefined) continue;
      const name = `this->${field.name}`;
      this.take(NODE_COST + name.length);
      variables.vars[name] = scalar;
    }
    if (!withReferences) return;
    const node = this.nodeOf(self, { kind: 'class', cls: owner }, new Set(), owner);
    if (node) variables.referenceVars.this = node;
  }

  private addVariable(
    variables: TraceVariables,
    name: string,
    value: Value,
    type: Type,
    withReferences: boolean
  ): void {
    if (value === UNINIT || value === undefined) return;
    this.take(NODE_COST + name.length);
    const scalar = this.scalarOf(value, type);
    if (scalar === undefined) return;
    if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
    // Arrays also appear as references so that learners can expand their elements.
    if (!withReferences || (scalar !== NOT_SCALAR && !Array.isArray(scalar))) return;
    this.take(name.length);
    const node = this.nodeOf(value, type, new Set());
    if (node) variables.referenceVars[name] = node;
  }

  /** The node that shows a value in the trace's reference view, or undefined for one that shows nothing. */
  // code-gauge-allow functionCognitiveComplexity 25 -- Dispatches by type and value with one cycle guard.
  // code-gauge-allow functionNcss 33 -- Dispatch and cycle detection belong to the same traversal.
  private nodeOf(value: Value, type: Type, seen: Set<unknown>, receiverClass?: ClassInfo): DisplayNode | undefined {
    this.take(NODE_COST);
    if (value === UNINIT || value === undefined) return undefined;
    if (type.kind === 'reference')
      return value instanceof Ptr ? this.nodeOf(readLocation(value), type.to, seen) : undefined;
    if (type.kind === 'pointer') {
      const pointer = value as Ptr;
      if (pointer.isNull) return NULL_NODE;
      if (isCharType(type.to)) {
        const text = this.cStringOf(pointer);
        if (text !== undefined) return { kind: 'value', value: text };
      }
      return this.nodeOf(readLocation(pointer), type.to, seen);
    }
    if (!(value instanceof ArrayStore || value instanceof SequenceValue)) {
      const scalar = this.scalarOf(value, type);
      if (scalar !== NOT_SCALAR && scalar !== undefined && !Array.isArray(scalar))
        return { kind: 'value', value: scalar };
    }
    if (typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    try {
      if (value instanceof CObject) return this.objectNode(value, receiverClass ?? value.cls, seen);
      if (value instanceof ArrayStore && type.kind === 'array') return this.arrayNode(value.values, type.of, seen);
      if (value instanceof SequenceValue) return this.arrayNode(value.items, value.elementType, seen);
      if (value instanceof MapValue)
        return value.displayNode((item, itemType) => this.nodeOf(item, itemType, seen) ?? NULL_NODE);
      return undefined;
    } finally {
      seen.delete(value);
    }
  }

  private objectNode(value: CObject, cls: ClassInfo, seen: Set<unknown>): DisplayNode | undefined {
    if (value.cls.isTurtle) {
      const turtle = value.turtle;
      if (!turtle?.isAlive) return undefined;
      this.take(NODE_COST * 2);
      return {
        kind: 'object',
        entries: { x: { kind: 'value', value: turtle.x }, y: { kind: 'value', value: turtle.y } },
      };
    }
    const entries: Record<string, DisplayNode> = {};
    if (value.message !== undefined) {
      this.take(NODE_COST + value.message.length);
      entries.message = { kind: 'value', value: new TextDecoder().decode(byteArray(value.message)) };
    }
    for (const field of cls.fields) {
      const node = this.nodeOf(value.values[field.index], field.type, seen);
      if (!node) continue;
      this.take(field.name.length);
      entries[field.name] = node;
    }
    return { kind: 'object', entries };
  }

  private arrayNode(items: readonly Value[], type: Type, seen: Set<unknown>): DisplayNode {
    const entries: Record<string, DisplayNode> = {};
    for (const [index, item] of items.entries()) entries[index] = this.nodeOf(item, type, seen) ?? NULL_NODE;
    return { kind: 'array', entries };
  }

  /** A value as learners write it, NOT_SCALAR for an object, or undefined for a value the program never wrote. */
  // code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of type.
  // code-gauge-allow functionNcss 32 -- One case per kind of type.
  private scalarOf(value: Value, type: Type): Scalar | typeof NOT_SCALAR | undefined {
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
      case 'reference': {
        return value instanceof Ptr ? this.scalarOf(readLocation(value), type.to) : undefined;
      }
      case 'pointer': {
        const pointer = value as Ptr;
        if (pointer.isNull) return NOT_SCALAR;
        if (isCharType(type.to)) return this.cStringOf(pointer) ?? NOT_SCALAR;
        return NOT_SCALAR;
      }
      case 'array': {
        if (!(value instanceof ArrayStore)) return NOT_SCALAR;
        if (!hasScalarElements(type.of)) return NOT_SCALAR;
        return this.scalarArray(value.values, type.of);
      }
      case 'class': {
        return this.scalarOfClass(value, type.cls);
      }
      default: {
        return NOT_SCALAR;
      }
    }
  }

  private scalarOfClass(value: Value, cls: ClassInfo): Scalar | typeof NOT_SCALAR | undefined {
    const scalar = cls.library?.scalarValue;
    if (scalar) {
      try {
        return this.scalarOf(scalar.read(value), scalar.type);
      } catch (error) {
        if (error instanceof CppRuntimeError) return;
        throw error;
      }
    }
    if (value instanceof StringValue) {
      this.take(value.length);
      return value.text;
    }
    if (value instanceof SequenceValue && value.isArrayLike && hasScalarElements(value.elementType))
      return this.scalarArray(value.items, value.elementType);
    return NOT_SCALAR;
  }

  private scalarArray(items: readonly Value[], type: Type): Scalar {
    this.take(NODE_COST * items.length);
    return items.map((item) => {
      const scalar = this.scalarOf(item, type);
      // oxlint-disable-next-line unicorn/no-null -- The trace format shows values never written as null.
      return scalar === NOT_SCALAR || scalar === undefined ? null : scalar;
    }) as Scalar;
  }

  /** The text of a null-terminated string, or undefined when the pointer reaches none. */
  private cStringOf(pointer: Ptr): string | undefined {
    try {
      const store = pointer.target();
      let bytes = '';
      for (let index = pointer.index; index < store.length; index++) {
        const value = store.get(index);
        if (value === 0) return new TextDecoder().decode(byteArray(bytes));
        this.take(1);
        bytes += String.fromCodePoint(Number(value) & 0xff);
      }
    } catch (error) {
      if (!(error instanceof CppRuntimeError)) throw error;
    }
  }

  private take(cost: number): void {
    this.remaining -= cost;
    if (this.remaining < 0) throw new ExecutionLimitError('trace');
  }
}

function activeLocals(frame: Frame, hidesArgs: boolean): Map<string, { slot: Store | Ptr; type: Type }> {
  const locals = new Map<string, { slot: Store | Ptr; type: Type }>();
  for (const local of frame.compiled?.locals ?? []) {
    if (local.name.startsWith('\0') || (hidesArgs && local.isParameter)) continue;
    const slot = frame.slots[local.slot];
    if (slot !== undefined) locals.set(local.name, { slot, type: local.type });
  }
  return locals;
}

function readLocation(pointer: Ptr): Value {
  try {
    const store = pointer.target();
    if (pointer.index < 0 || pointer.index >= store.length) return UNINIT;
    return pointer.readRaw();
  } catch {
    return UNINIT;
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

export type { Store };
