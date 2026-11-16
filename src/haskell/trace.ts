import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { CHAR_TYPE, CONS_CON, NIL_CON, UNIT_CON } from './builtinTypes';
import { compileProgram } from './compile';
import { runProgram } from './run';
import { DisplayAbort, Runtime, type TraceFrame } from './runtime';
import { prune, splitApp, type Type } from './types';
import {
  ConValue,
  Dict,
  HaskellException,
  isFunction,
  isIOAction,
  type Slot,
  Thunk,
  TurtleValue,
  type Value,
} from './values';

export function traceHaskellProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const compiled = compileProgram(program, new Set(trace.atomicAnnotations.keys()));
  const runtime = new Runtime(input);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.isAtomic,
    variablesOf: (frame) => variablesOf(runtime, frame),
  });
  runtime.steps.recorder = recorder;
  // Evaluating what a step shows may replace a variable's thunk by a value that no longer reaches a turtle.
  runtime.beforeCollect = () => {
    for (const frame of runtime.frames) variablesOf(runtime, frame);
  };
  let finalVars: TraceItemVariable = {};
  // A model program may end with an uncaught exception to show how one stops the program.
  const run = runProgram(runtime, compiled, (frame) => {
    if (frame) finalVars = variablesOf(runtime, frame).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

/** The variables a frame's running statement sees: its parameters and the variables bound before it, in order. */
// code-gauge-allow functionCognitiveComplexity 18 -- Variables come from each trace context with shadowing and record fields applied.
function variablesOf(runtime: Runtime, frame: TraceFrame): TraceVariables {
  const variables: TraceVariables = { vars: {}, referenceVars: {} };
  const context = frame.contexts.at(-1);
  if (!context) return variables;
  let self: Value | undefined;
  for (const visible of context.visible) {
    const slot = context.env.at(visible.depth).slots[visible.index];
    if (slot === undefined) continue;
    const value = forceForDisplay(runtime, slot);
    if (value === undefined) continue;
    addVariable(runtime, variables, visible.name, value, visible.type);
    if (visible.name === 'this') self = value;
  }
  // A record named `this` shows its fields after the locals, as Java shows `this.x`.
  if (self instanceof ConValue && self.con.fieldNames) {
    for (const [index, field] of self.fields.entries()) {
      const forced = forceForDisplay(runtime, field);
      if (forced === undefined) continue;
      const scalar = scalarOf(runtime, forced, { tag: 'tgen', index: -1 } as Type, 0);
      if (scalar !== NOT_SCALAR) variables.vars[`this.${self.con.fieldNames[index]}`] = scalar;
    }
  }
  return variables;
}

/** The limit of the work that showing one variable may do, which a variable bound to a long computation exceeds. */
const DISPLAY_OPERATIONS = 20_000;

/** Evaluates a value for display, leaving it unevaluated when that fails or takes too long. */
function forceForDisplay(runtime: Runtime, slot: Slot): Value | undefined {
  if (slot instanceof Thunk && slot.state !== 'done' && runtime.displayAborted.has(slot)) return;
  return runtime.withDisplayBudget(DISPLAY_OPERATIONS, () => {
    try {
      return runtime.machine.force(slot);
    } catch (error) {
      if (error instanceof DisplayAbort && slot instanceof Thunk) runtime.displayAborted.add(slot);
      if (error instanceof HaskellException || error instanceof DisplayAbort) return;
      throw error;
    }
  });
}

type Scalar = TraceItemVariable[string];
const NOT_SCALAR = Symbol('notScalar');

function addVariable(runtime: Runtime, variables: TraceVariables, name: string, value: Value, type: Type): void {
  if (isHidden(value, type)) return;
  const scalar = scalarOf(runtime, value, type, 0);
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  // Lists also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !isListValue(value, type)) return;
  const node = displayNodeOf(runtime, value, type, 0);
  if (node) variables.referenceVars[name] = node;
}

/** Functions, actions, and `()` are not variables to learners. */
function isHidden(value: Value, type: Type): boolean {
  if (isFunction(value) || isIOAction(value) || value instanceof Dict) return true;
  if (value instanceof ConValue && value.con === UNIT_CON) return true;
  const { head } = splitApp(prune(type));
  return head.tag === 'tcon' && head.entity.special === 'function';
}

function isListValue(value: Value, type: Type): boolean {
  if (value instanceof ConValue && (value.con === CONS_CON || value.con === NIL_CON)) return !isStringType(type, value);
  return false;
}

function elementType(type: Type, position: number): Type {
  const { args } = splitApp(prune(type));
  return args[position] ?? ({ tag: 'tgen', index: -1 } as Type);
}

function isStringType(type: Type, value: Value): boolean {
  const { head, args } = splitApp(prune(type));
  if (head.tag === 'tcon' && head.entity.special === 'list' && args.length === 1) {
    const elem = prune(args[0]);
    if (elem.tag === 'tcon') return elem.entity === CHAR_TYPE;
  }
  // Without a known element type, a list of characters is a string.
  return value instanceof ConValue && value.con === CONS_CON && typeof peek(value.fields[0]) === 'string';
}

function peek(slot: Slot): Value | undefined {
  return slot instanceof Object && 'state' in slot ? (slot.state === 'done' ? slot.value : undefined) : (slot as Value);
}

const MAX_ELEMENTS = 1000;

/** The elements of a list, forcing it as far as display allows. */
function listItems(runtime: Runtime, value: ConValue): Value[] | undefined {
  const items: Value[] = [];
  let current: Value | undefined = value;
  while (current instanceof ConValue && current.con === CONS_CON) {
    if (items.length >= MAX_ELEMENTS) return undefined;
    const head = forceForDisplay(runtime, current.fields[0]);
    if (head === undefined) return undefined;
    items.push(head);
    current = forceForDisplay(runtime, current.fields[1]);
  }
  return current instanceof ConValue && current.con === NIL_CON ? items : undefined;
}

function charsOf(items: Value[]): string {
  return items.map((item) => (typeof item === 'string' ? item : '')).join('');
}

function traceInt(value: bigint): number | bigint {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}

// code-gauge-allow functionCognitiveComplexity 20 -- One branch per kind of value shown as a scalar.
function scalarOf(runtime: Runtime, value: Value, type: Type, depth: number): Scalar | typeof NOT_SCALAR {
  if (depth > 20) return NOT_SCALAR;
  if (typeof value === 'bigint') return traceInt(value);
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (!(value instanceof ConValue)) return NOT_SCALAR;
  if (value.con.type.name === 'Bool' && value.con.type.module === 'Base') return value.con.tag === 1;
  if (value.con === CONS_CON || value.con === NIL_CON) {
    const items = listItems(runtime, value);
    if (!items) return NOT_SCALAR;
    if (isStringType(type, value)) return charsOf(items);
    const elemType = elementType(type, 0);
    const scalars: Scalar[] = [];
    for (const item of items) {
      const scalar = scalarOf(runtime, item, elemType, depth + 1);
      if (scalar === NOT_SCALAR) return NOT_SCALAR;
      scalars.push(scalar);
    }
    return scalars as Scalar;
  }
  // An enumeration's constructor shows as its name.
  if (value.fields.length === 0 && value.con.type.module !== 'Base') return value.con.name;
  return NOT_SCALAR;
}

// oxlint-disable-next-line unicorn/no-null -- The trace format shows Nothing as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

// code-gauge-allow functionCognitiveComplexity 20 -- One branch per kind of value shown as a node.
function displayNodeOf(runtime: Runtime, value: Value, type: Type, depth: number): DisplayNode | undefined {
  if (depth > 20) return { kind: 'value', value: '…' };
  if (typeof value === 'bigint') return { kind: 'value', value: traceInt(value) };
  if (typeof value === 'number' || typeof value === 'string') return { kind: 'value', value };
  if (value instanceof TurtleValue) {
    if (!value.turtle.isAlive) return undefined;
    return {
      kind: 'object',
      entries: { x: { kind: 'value', value: value.turtle.x }, y: { kind: 'value', value: value.turtle.y } },
    };
  }
  if (!(value instanceof ConValue) || isHidden(value, type)) return undefined;
  const con = value.con;
  if (con.type.name === 'Bool' && con.type.module === 'Base') return { kind: 'value', value: con.tag === 1 };
  if (con === CONS_CON || con === NIL_CON) return listNodeOf(runtime, value, type, depth);
  if (con.type.name === 'Maybe' && con.type.module === 'Base') {
    // A Maybe shows as what it holds, or as null, as a Java reference does.
    if (con.name === 'Nothing') return NULL_NODE;
    const inner = forceForDisplay(runtime, value.fields[0]);
    return inner === undefined ? undefined : displayNodeOf(runtime, inner, elementType(type, 0), depth + 1);
  }
  if (value.fields.length === 0) return { kind: 'value', value: con.name };
  return dataNodeOf(runtime, value, type, depth);
}

function listNodeOf(runtime: Runtime, value: ConValue, type: Type, depth: number): DisplayNode {
  const items = listItems(runtime, value);
  if (!items) return { kind: 'value', value: '…' };
  if (isStringType(type, value)) return { kind: 'value', value: charsOf(items) };
  const entries: Record<string, DisplayNode> = {};
  for (const [index, item] of items.entries()) {
    entries[index] = displayNodeOf(runtime, item, elementType(type, 0), depth + 1) ?? NULL_NODE;
  }
  return { kind: 'array', entries };
}

/** A tuple shows as an array, and a constructor with fields as an object of them, by name in a record. */
function dataNodeOf(runtime: Runtime, value: ConValue, type: Type, depth: number): DisplayNode {
  const { con } = value;
  const entries: Record<string, DisplayNode> = {};
  const isTuple = con.type.special === 'tuple';
  for (const [index, field] of value.fields.entries()) {
    const forced = forceForDisplay(runtime, field);
    if (forced === undefined) continue;
    const fieldType = isTuple ? elementType(type, index) : ({ tag: 'tgen', index: -1 } as Type);
    const node = displayNodeOf(runtime, forced, fieldType, depth + 1);
    if (node) entries[con.fieldNames?.[index] ?? String(index)] = node;
  }
  return { kind: isTuple ? 'array' : 'object', entries };
}
