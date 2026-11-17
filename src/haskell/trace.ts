import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { CHAR_TYPE, CONS_CON, FLOAT_TYPE, NIL_CON, UNIT_CON } from './builtinTypes';
import { compileProgram } from './compile';
import { constructorFieldType, isConcreteType, slotDisplayType, UNKNOWN_TYPE } from './displayTypes';
import { DISPLAY_OPERATIONS } from './previewBudget';
import { floatToDigits } from './primitives';
import { runProgram } from './run';
import { DisplayAbort, type PreviewContext, Runtime, type TraceFrame } from './runtime';
import { prune, splitApp, type Type } from './types';
import { chargeTypeWork } from './typeWorkBudget';
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
  runtime.displaysAnswer = (name, slot, type, context) => slotDisplaysAnswer(runtime, name, slot, type, context);
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

type VariableDisplay = Pick<TraceVariables, 'vars'> & Partial<Pick<TraceVariables, 'referenceVars'>>;

interface VariableEntry extends PreviewContext {
  slot: Slot;
  value: Value;
  type: Type;
}

function slotDisplaysAnswer(runtime: Runtime, name: string, slot: Slot, type: Type, context: PreviewContext): boolean {
  const variables: VariableDisplay = { vars: Object.create(null) };
  const entry = addSlotVariable(runtime, variables, name, slot, type, context);
  if (name === 'this') addSelfFields(runtime, variables, entry);
  return Object.values(variables.vars).some((value) => typeof value !== 'object');
}

/** The variables a frame's running statement sees: its parameters and the variables bound before it, in order. */
function variablesOf(runtime: Runtime, frame: TraceFrame): TraceVariables {
  const variables: TraceVariables = { vars: Object.create(null), referenceVars: Object.create(null) };
  const context = frame.contexts.at(-1);
  if (!context) return variables;
  let self: VariableEntry | undefined;
  for (const visible of visibleVariables(context.visible)) {
    const ownerEnv = context.env.at(visible.depth);
    const slot = ownerEnv.slots[visible.index];
    if (slot === undefined) continue;
    const entry = addSlotVariable(runtime, variables, visible.name, slot, visible.type, {
      owner: visible.previewOwner,
      frame,
      scope: runtime.previewScope(frame, ownerEnv),
    });
    if (visible.name === 'this') self = entry;
  }
  addSelfFields(runtime, variables, self);
  return variables;
}

function addSlotVariable(
  runtime: Runtime,
  variables: VariableDisplay,
  name: string,
  slot: Slot,
  type: Type,
  context: PreviewContext
): VariableEntry | undefined {
  return displayAttempt(runtime, () => {
    const entry = runtime.withPreviewBudget({ ...context, key: 'root', share: 1 }, () => {
      const value = forceForDisplay(runtime, slot);
      return value === undefined ? undefined : { slot, value, type: slotDisplayType(slot, type), ...context };
    });
    if (!entry) return;
    const fields = entry.value instanceof ConValue ? entry.value.con.fieldNames : undefined;
    const share = name === 'this' && fields ? 1 / 3 : 1;
    try {
      runtime.withPreviewBudget({ ...context, key: 'value', share }, () => {
        addVariable(runtime, variables, name, entry.value, entry.type);
        completeVariable(runtime, variables, name, slot);
      });
    } catch (error) {
      if (!(error instanceof DisplayAbort)) throw error;
    }
    return entry;
  });
}

function completeVariable(runtime: Runtime, variables: VariableDisplay, name: string, slot: Slot): void {
  if (Object.hasOwn(variables.vars, name) || Object.hasOwn(variables.referenceVars ?? {}, name)) {
    runtime.completePreview(slot);
  }
}

function addSelfFields(runtime: Runtime, variables: VariableDisplay, entry: VariableEntry | undefined): void {
  if (!entry) return;
  const self = entry.value;
  if (!(self instanceof ConValue) || !self.con.fieldNames) return;
  for (const [index, field] of self.fields.entries()) {
    const scalar = displayAttempt(runtime, () =>
      runtime.withPreviewBudget(
        {
          owner: entry.owner,
          frame: entry.frame,
          scope: entry.scope,
          key: `field:${self.con.fieldNames![index]}`,
          share: 1 / (3 * Math.max(self.con.type.fields.size, self.fields.length)),
        },
        () => {
          const fieldType = constructorFieldType(self.con, entry.type, index);
          return scalarSlotForDisplay(runtime, field, fieldType, entry.slot);
        }
      )
    );
    if (scalar !== undefined && scalar !== NOT_SCALAR) variables.vars[`this.${self.con.fieldNames[index]}`] = scalar;
  }
}

function scalarSlotForDisplay(runtime: Runtime, slot: Slot, type: Type, owner: Slot): Scalar | typeof NOT_SCALAR {
  const fieldType = slotDisplayType(slot, type);
  const forced = forceForDisplay(runtime, slot);
  if (forced === undefined) return NOT_SCALAR;
  const scalar = scalarForDisplay(runtime, forced, slotDisplayType(slot, fieldType));
  if (scalar !== NOT_SCALAR && typeof scalar !== 'object') runtime.completePreview(slot, owner);
  return scalar;
}

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
  if (slot instanceof Thunk) runtime.trackPreview(slot);
  const ready = peek(slot);
  if (ready !== undefined) return ready;
  return runtime.withDisplayBudget(DISPLAY_OPERATIONS, () => {
    try {
      return slot instanceof Thunk ? runtime.forcePreview(slot) : slot;
    } catch (error) {
      if (error instanceof HaskellException || error instanceof DisplayAbort) {
        runtime.incompletePreview();
        return;
      }
      throw error;
    }
  });
}

type Scalar = TraceItemVariable[string];
const NOT_SCALAR = Symbol('notScalar');

function addVariable(runtime: Runtime, variables: VariableDisplay, name: string, value: Value, type: Type): void {
  if (isHidden(value, type)) return;
  const scalar = scalarForDisplay(runtime, value, type);
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  if (!variables.referenceVars) return;
  // Lists also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !isListValue(value, type)) return;
  try {
    const node = new DisplayNodes(runtime).build(value, type, 0);
    if (node) variables.referenceVars[name] = node;
  } catch (error) {
    if (!(error instanceof DisplayAbort)) throw error;
    runtime.incompletePreview();
    variables.referenceVars[name] = { kind: 'value', value: '…' };
  }
}

function scalarForDisplay(runtime: Runtime, value: Value, type: Type): ReturnType<typeof scalarOf> {
  if (!(value instanceof ConValue) || value.fields.length === 0) return scalarOf(runtime, value, type, 0);
  try {
    return scalarOf(runtime, value, type, 0);
  } catch (error) {
    if (error instanceof DisplayAbort) {
      runtime.incompletePreview();
      return NOT_SCALAR;
    }
    throw error;
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
  while (slot instanceof Thunk) {
    chargeTypeWork();
    if (slot.state === 'done') return slot.value;
    if (!slot.target) return;
    slot = slot.target;
  }
  return slot;
}

const MAX_ELEMENTS = 1000;
const MAX_DISPLAY_DEPTH = 20;

interface ListItem {
  slot: Slot;
  value: Value;
  type: Type;
}

interface ListView {
  spine: Slot[];
  items: ListItem[];
  primitive: boolean;
  scalar: Scalar | undefined;
  node: DisplayNode | undefined;
}

const listViews = new WeakMap<ConValue, WeakMap<Type, ListView>>();

/** The elements of a list, forcing it as far as display allows. */
function listItems(runtime: Runtime, value: ConValue, type: Type): ListItem[] | undefined {
  const cached = listViews.get(value)?.get(type);
  if (cached) return reuseListItems(runtime, cached);
  const items: ListItem[] = [];
  const spine: Slot[] = [];
  let current: Value | undefined = value;
  while (current instanceof ConValue && current.con === CONS_CON) {
    runtime.spend();
    if (items.length >= MAX_ELEMENTS) return undefined;
    const head = forceForDisplay(runtime, current.fields[0]);
    if (head === undefined) return undefined;
    items.push({
      slot: current.fields[0],
      value: head,
      type: slotDisplayType(current.fields[0], elementType(type, 0)),
    });
    spine.push(current.fields[1]);
    current = forceForDisplay(runtime, current.fields[1]);
  }
  if (!(current instanceof ConValue) || current.con !== NIL_CON) return undefined;
  if (isConcreteType(type)) {
    let views = listViews.get(value);
    if (!views) {
      views = new WeakMap();
      listViews.set(value, views);
    }
    views.set(type, {
      spine,
      items,
      primitive: items.every((item) => typeof item.value !== 'object'),
      scalar: undefined,
      node: undefined,
    });
  }
  return items;
}

function reuseListItems(runtime: Runtime, view: ListView): ListItem[] {
  for (const slot of view.spine) runtime.trackPreview(slot);
  for (const item of view.items) runtime.trackPreview(item.slot);
  return view.items;
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

// code-gauge-allow functionCognitiveComplexity 29 -- One branch per kind of value shown as a scalar.
function scalarOf(runtime: Runtime, value: Value, type: Type, depth: number): Scalar | typeof NOT_SCALAR {
  runtime.spend();
  if (depth > MAX_DISPLAY_DEPTH) return NOT_SCALAR;
  if (typeof value === 'bigint') return traceInt(value);
  if (typeof value === 'number') return traceFloat(value, type);
  if (typeof value === 'string') return value;
  if (!(value instanceof ConValue)) return NOT_SCALAR;
  if (containerKind(value)) return NOT_SCALAR;
  if (value.con.type.traceKind === 'ratio') {
    const numerator = forceForDisplay(runtime, value.fields[0]);
    const denominator = forceForDisplay(runtime, value.fields[1]);
    return typeof numerator === 'bigint' && typeof denominator === 'bigint'
      ? `${numerator} % ${denominator}`
      : NOT_SCALAR;
  }
  if (value.con.type.traceKind === 'bool') return value.con.tag === 1;
  if (value.con === CONS_CON || value.con === NIL_CON) return listScalarOf(runtime, value, type, depth);
  if (value.con === UNIT_CON || value.con.type.traceKind === 'maybe') return NOT_SCALAR;
  if (value.fields.length === 0 && !value.con.isLibraryPrivate) return value.con.name;
  return NOT_SCALAR;
}

function listScalarOf(runtime: Runtime, value: ConValue, type: Type, depth: number): Scalar | typeof NOT_SCALAR {
  const items = listItems(runtime, value, type);
  if (!items) return NOT_SCALAR;
  const view = listViews.get(value)?.get(type);
  if (view?.scalar !== undefined && depth < MAX_DISPLAY_DEPTH) return view.scalar;
  if (isStringType(type, value)) {
    const scalar = charsOf(items);
    if (view?.primitive) view.scalar = scalar;
    return scalar;
  }
  const scalars: Scalar[] = [];
  for (const item of items) {
    const scalar = scalarOf(runtime, item.value, item.type, depth + 1);
    if (scalar === NOT_SCALAR) return NOT_SCALAR;
    scalars.push(scalar);
  }
  if (view?.primitive) view.scalar = scalars as Scalar;
  return scalars as Scalar;
}

// oxlint-disable-next-line unicorn/no-null -- The trace format shows Nothing as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

function containerKind(value: ConValue): 'map' | 'set' | undefined {
  if (value.con.type.traceKind === 'map') return 'map';
  if (value.con.type.traceKind === 'set') return 'set';
  return undefined;
}

class DisplayNodes {
  private readonly ancestors = new Set<ConValue>();
  constructor(private readonly runtime: Runtime) {}

  build(value: Value, type: Type, depth: number): DisplayNode | undefined {
    this.runtime.spend();
    if (!(value instanceof ConValue)) return this.nodeOf(value, type, depth);
    if (this.ancestors.has(value)) return this.truncated();
    this.ancestors.add(value);
    try {
      return this.nodeOf(value, type, depth);
    } finally {
      this.ancestors.delete(value);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 27 -- One branch per kind of value shown as a node.
  // code-gauge-allow functionNcss 34 -- Node formatting dispatches on each supported value representation.
  private nodeOf(value: Value, type: Type, depth: number): DisplayNode | undefined {
    if (depth > MAX_DISPLAY_DEPTH) return this.truncated();
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
    if (value.con.type.traceKind === 'ratio') {
      const scalar = scalarOf(this.runtime, value, type, depth);
      return typeof scalar === 'string' ? { kind: 'value', value: scalar } : undefined;
    }
    const con = value.con;
    if (con.type.traceKind === 'bool') return { kind: 'value', value: con.tag === 1 };
    if (con === CONS_CON || con === NIL_CON) return this.listNodeOf(value, type, depth);
    if (con.type.traceKind === 'maybe') {
      // A Maybe shows as what it holds, or as null, as a Java reference does.
      if (con.name === 'Nothing') return NULL_NODE;
      const inner = forceForDisplay(this.runtime, value.fields[0]);
      return inner === undefined ? undefined : this.build(inner, elementType(type, 0), depth + 1);
    }
    if (value.fields.length === 0)
      return con.isLibraryPrivate ? { kind: 'object', entries: {} } : { kind: 'value', value: con.name };
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
    return visit(value) ? { kind: 'array', entries } : this.truncated();
  }

  private listNodeOf(value: ConValue, type: Type, depth: number): DisplayNode {
    const items = listItems(this.runtime, value, type);
    if (!items) return this.truncated();
    const view = listViews.get(value)?.get(type);
    if (view?.node && depth < MAX_DISPLAY_DEPTH) return view.node;
    if (isStringType(type, value)) return { kind: 'value', value: charsOf(items) };
    const entries: Record<string, DisplayNode> = Object.create(null);
    for (const [index, item] of items.entries()) {
      entries[index] = this.build(item.value, item.type, depth + 1) ?? NULL_NODE;
    }
    const node: DisplayNode = { kind: 'array', entries };
    if (view?.primitive && depth < MAX_DISPLAY_DEPTH) view.node = node;
    return node;
  }

  private truncated(): DisplayNode {
    this.runtime.incompletePreview();
    return { kind: 'value', value: '…' };
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
