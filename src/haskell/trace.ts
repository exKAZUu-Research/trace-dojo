import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { CHAR_TYPE, CONS_CON, FLOAT_TYPE, NIL_CON, UNIT_CON } from './builtinTypes';
import { compileProgram } from './compile';
import { constructorFieldType, slotDisplayType, UNKNOWN_TYPE } from './displayTypes';
import { floatToDigits } from './primitives';
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
  untypedSlot,
  type Value,
} from './values';
import { visibleVariables } from './visibleScope';

export function traceHaskellProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const compiled = compileProgram(program, new Set(trace.atomicAnnotations.keys()), true);
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
  let finalVars: TraceItemVariable = Object.create(null);
  // A model program may end with an uncaught exception to show how one stops the program.
  const run = runProgram(runtime, compiled, (frame) => {
    if (frame) finalVars = variablesOf(runtime, frame).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

/** The variables a frame's running statement sees: its parameters and the variables bound before it, in order. */
// code-gauge-allow functionCognitiveComplexity 18 -- Variables come from each trace context with shadowing and record fields applied.
function variablesOf(runtime: Runtime, frame: TraceFrame): TraceVariables {
  const variables: TraceVariables = { vars: Object.create(null), referenceVars: Object.create(null) };
  const context = frame.contexts.at(-1);
  if (!context) return variables;
  let self: { value: Value; type: Type } | undefined;
  for (const visible of visibleVariables(context.visible)) {
    const slot = context.env.at(visible.depth).slots[visible.index];
    if (slot === undefined) continue;
    let displayType = visible.type;
    const value = displayAttempt(runtime, () => {
      const forced = forceForDisplay(runtime, slot);
      if (forced !== undefined) {
        displayType = slotDisplayType(slot, visible.type);
        addVariable(runtime, variables, visible.name, forced, displayType);
      }
      return forced;
    });
    if (value === undefined) continue;
    if (visible.name === 'this') self = { value, type: displayType };
  }
  addSelfFields(runtime, variables, self);
  return variables;
}

function addSelfFields(
  runtime: Runtime,
  variables: TraceVariables,
  entry: { value: Value; type: Type } | undefined
): void {
  if (!entry) return;
  const self = entry.value;
  if (!(self instanceof ConValue) || !self.con.fieldNames) return;
  for (const [index, field] of self.fields.entries()) {
    const scalar = displayAttempt(runtime, () => {
      const forced = forceForDisplay(runtime, field);
      return forced === undefined
        ? NOT_SCALAR
        : scalarOf(runtime, forced, slotDisplayType(field, constructorFieldType(self.con, entry.type, index)), 0);
    });
    if (scalar !== undefined && scalar !== NOT_SCALAR) variables.vars[`this.${self.con.fieldNames[index]}`] = scalar;
  }
}

/** The limit of the work that showing one variable may do, which a variable bound to a long computation exceeds. */
const DISPLAY_OPERATIONS = 20_000;

function displayAttempt<T>(runtime: Runtime, work: () => T): T | undefined {
  try {
    return runtime.withDisplayBudget(DISPLAY_OPERATIONS, work);
  } catch (error) {
    if (error instanceof DisplayAbort) return;
    throw error;
  }
}

/** Evaluates a value for display, leaving it unevaluated when that fails or takes too long. */
function forceForDisplay(runtime: Runtime, slot: Slot): Value | undefined {
  slot = untypedSlot(slot);
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
  try {
    const node = new DisplayNodes(runtime).build(value, type, 0);
    if (node) variables.referenceVars[name] = node;
  } catch (error) {
    if (!(error instanceof DisplayAbort)) throw error;
    variables.referenceVars[name] = { kind: 'value', value: '…' };
  }
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
  return args[position] ?? UNKNOWN_TYPE;
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
  slot = untypedSlot(slot);
  return slot instanceof Object && 'state' in slot ? (slot.state === 'done' ? slot.value : undefined) : (slot as Value);
}

const MAX_ELEMENTS = 1000;

/** The elements of a list, forcing it as far as display allows. */
function listItems(runtime: Runtime, value: ConValue, type: Type): { value: Value; type: Type }[] | undefined {
  const items: { value: Value; type: Type }[] = [];
  let current: Value | undefined = value;
  while (current instanceof ConValue && current.con === CONS_CON) {
    runtime.spend();
    if (items.length >= MAX_ELEMENTS) return undefined;
    const head = forceForDisplay(runtime, current.fields[0]);
    if (head === undefined) return undefined;
    items.push({ value: head, type: slotDisplayType(current.fields[0], elementType(type, 0)) });
    current = forceForDisplay(runtime, current.fields[1]);
  }
  return current instanceof ConValue && current.con === NIL_CON ? items : undefined;
}

function charsOf(items: { value: Value }[]): string {
  return items.map(({ value }) => (typeof value === 'string' ? value : '')).join('');
}

function traceInt(value: bigint): number | bigint {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}

function traceFloat(value: number, type: Type): number {
  const actual = prune(type);
  if (actual.tag !== 'tcon' || actual.entity !== FLOAT_TYPE || !Number.isFinite(value) || value === 0) return value;
  const { digits, exponent } = floatToDigits(Math.abs(value), true);
  return Math.sign(value) * Number(`${digits.join('')}e${exponent - digits.length}`);
}

// code-gauge-allow functionCognitiveComplexity 26 -- One branch per kind of value shown as a scalar.
// code-gauge-allow functionNcss 37 -- Scalar formatting handles primitive values and library abstract values together.
function scalarOf(runtime: Runtime, value: Value, type: Type, depth: number): Scalar | typeof NOT_SCALAR {
  runtime.spend();
  if (depth > 20) return NOT_SCALAR;
  if (typeof value === 'bigint') return traceInt(value);
  if (typeof value === 'number') return traceFloat(value, type);
  if (typeof value === 'string') return value;
  if (!(value instanceof ConValue)) return NOT_SCALAR;
  if (containerKind(value)) return NOT_SCALAR;
  if (value.con.type.module === 'Base' && value.con.type.name === 'Ratio') {
    const numerator = forceForDisplay(runtime, value.fields[0]);
    const denominator = forceForDisplay(runtime, value.fields[1]);
    return typeof numerator === 'bigint' && typeof denominator === 'bigint'
      ? `${numerator} % ${denominator}`
      : NOT_SCALAR;
  }
  if (value.con.type.name === 'Bool' && value.con.type.module === 'Base') return value.con.tag === 1;
  if (value.con === CONS_CON || value.con === NIL_CON) {
    const items = listItems(runtime, value, type);
    if (!items) return NOT_SCALAR;
    if (isStringType(type, value)) return charsOf(items);
    const scalars: Scalar[] = [];
    for (const item of items) {
      const scalar = scalarOf(runtime, item.value, item.type, depth + 1);
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

function containerKind(value: ConValue): 'map' | 'set' | undefined {
  if (value.con.type.module === 'Data.Map.Internal') return 'map';
  if (value.con.type.module === 'Data.Set.Internal') return 'set';
  return undefined;
}

class DisplayNodes {
  private readonly ancestors = new Set<ConValue>();
  constructor(private readonly runtime: Runtime) {}

  build(value: Value, type: Type, depth: number): DisplayNode | undefined {
    this.runtime.spend();
    if (!(value instanceof ConValue)) return this.nodeOf(value, type, depth);
    if (this.ancestors.has(value)) return { kind: 'value', value: '…' };
    this.ancestors.add(value);
    try {
      return this.nodeOf(value, type, depth);
    } finally {
      this.ancestors.delete(value);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- One branch per kind of value shown as a node.
  // code-gauge-allow functionNcss 34 -- Node formatting dispatches on each supported value representation.
  private nodeOf(value: Value, type: Type, depth: number): DisplayNode | undefined {
    if (depth > 20) return { kind: 'value', value: '…' };
    if (typeof value === 'bigint') return { kind: 'value', value: traceInt(value) };
    if (typeof value === 'number') return { kind: 'value', value: traceFloat(value, type) };
    if (typeof value === 'string') return { kind: 'value', value };
    if (value instanceof TurtleValue) {
      if (!value.turtle.isAlive) return undefined;
      return {
        kind: 'object',
        entries: { x: { kind: 'value', value: value.turtle.x }, y: { kind: 'value', value: value.turtle.y } },
      };
    }
    if (!(value instanceof ConValue) || isHidden(value, type)) return undefined;
    const container = containerKind(value);
    if (container) return this.containerNodeOf(value, type, depth, container);
    if (value.con.type.module === 'Base' && value.con.type.name === 'Ratio') {
      const scalar = scalarOf(this.runtime, value, type, depth);
      return typeof scalar === 'string' ? { kind: 'value', value: scalar } : undefined;
    }
    const con = value.con;
    if (con.type.name === 'Bool' && con.type.module === 'Base') return { kind: 'value', value: con.tag === 1 };
    if (con === CONS_CON || con === NIL_CON) return this.listNodeOf(value, type, depth);
    if (con.type.name === 'Maybe' && con.type.module === 'Base') {
      // A Maybe shows as what it holds, or as null, as a Java reference does.
      if (con.name === 'Nothing') return NULL_NODE;
      const inner = forceForDisplay(this.runtime, value.fields[0]);
      return inner === undefined ? undefined : this.build(inner, elementType(type, 0), depth + 1);
    }
    if (value.fields.length === 0) return { kind: 'value', value: con.name };
    return this.dataNodeOf(value, type, depth);
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- One bounded in-order walk handles the shared Set and Map tree representation.
  private containerNodeOf(value: ConValue, type: Type, depth: number, kind: 'map' | 'set'): DisplayNode {
    const entries: Record<string, DisplayNode> = Object.create(null);
    let count = 0;
    const visit = (slot: Slot): boolean => {
      this.runtime.spend();
      const node = forceForDisplay(this.runtime, slot);
      if (!(node instanceof ConValue)) return false;
      if (node.fields.length === 0) return true;
      const left = kind === 'map' ? 3 : 2;
      if (!visit(node.fields[left]) || count >= MAX_ELEMENTS) return false;
      const key = forceForDisplay(this.runtime, node.fields[1]);
      if (key === undefined) return false;
      const keyNode = this.build(key, elementType(type, 0), depth + 1) ?? NULL_NODE;
      if (kind === 'map') {
        const item = forceForDisplay(this.runtime, node.fields[2]);
        entries[count++] = {
          kind: 'array',
          entries: {
            0: keyNode,
            1: item === undefined ? NULL_NODE : (this.build(item, elementType(type, 1), depth + 1) ?? NULL_NODE),
          },
        };
      } else entries[count++] = keyNode;
      return visit(node.fields[left + 1]);
    };
    return visit(value) ? { kind: 'array', entries } : { kind: 'value', value: '…' };
  }

  private listNodeOf(value: ConValue, type: Type, depth: number): DisplayNode {
    const items = listItems(this.runtime, value, type);
    if (!items) return { kind: 'value', value: '…' };
    if (isStringType(type, value)) return { kind: 'value', value: charsOf(items) };
    const entries: Record<string, DisplayNode> = Object.create(null);
    for (const [index, item] of items.entries()) {
      entries[index] = this.build(item.value, item.type, depth + 1) ?? NULL_NODE;
    }
    return { kind: 'array', entries };
  }

  /** A tuple shows as an array, and a constructor with fields as an object of them, by name in a record. */
  private dataNodeOf(value: ConValue, type: Type, depth: number): DisplayNode {
    const { con } = value;
    const entries: Record<string, DisplayNode> = Object.create(null);
    const isTuple = con.type.special === 'tuple';
    if (!isTuple && con.type.cons.length > 1) entries['<constructor>'] = { kind: 'value', value: con.name };
    for (const [index, field] of value.fields.entries()) {
      const forced = forceForDisplay(this.runtime, field);
      if (forced === undefined) continue;
      const fieldType = isTuple ? elementType(type, index) : constructorFieldType(con, type, index);
      const node = this.build(forced, slotDisplayType(field, fieldType), depth + 1);
      if (node) entries[con.fieldNames?.[index] ?? String(index)] = node;
    }
    return { kind: isTuple ? 'array' : 'object', entries };
  }
}
