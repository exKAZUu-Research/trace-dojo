// code-gauge-allow-file fileNcss 500 -- Scalar answers and reference nodes share bounded display traversal and caches.
import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { CHAR_TYPE, CONS_CON, FLOAT_TYPE, NIL_CON, UNIT_CON } from './builtinTypes';
import { compileProgram } from './compile';
import { type CachedDisplay, displayCacheFor } from './displayCache';
import { boundDisplayOutput } from './displayOutput';
import { constructorFieldType, isConcreteType, slotDisplayType, UNKNOWN_TYPE } from './displayTypes';
import { DISPLAY_OPERATIONS } from './previewBudget';
import { floatToDigits } from './primitives';
import { RecordingOutput } from './recordingOutput';
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
  const output = new RecordingOutput(runtime);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.isAtomic,
    variablesOf: (frame) => variablesOf(runtime, frame),
    recordItem: (item) => output.record(item),
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = Object.create(null);
  // A model program may end with an uncaught exception to show how one stops the program.
  const run = runProgram(runtime, compiled, (frame) => {
    if (frame) finalVars = output.bound({ vars: variablesOf(runtime, frame).vars, referenceVars: {} }).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...output.finish(run) };
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
  return boundDisplayOutput(runtime, variables);
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
  pending: boolean;
  spine: Slot[];
  items: ListItem[];
  primitive: boolean;
  scalar: Scalar | undefined;
}

const listViews = new WeakMap<ConValue, WeakMap<Type, ListView>>();
const oversizedLists = new WeakSet<ConValue>();

function listItems(runtime: Runtime, value: ConValue, type: Type): ListItem[] | undefined {
  if (oversizedLists.has(value)) return undefined;
  const cached = listViews.get(value)?.get(type);
  if (cached) return reuseListItems(runtime, cached);
  const items: ListItem[] = [];
  const spine: Slot[] = [];
  let current: Value | undefined = value;
  while (current instanceof ConValue && current.con === CONS_CON) {
    runtime.spend();
    if (items.length >= MAX_ELEMENTS) {
      oversizedLists.add(value);
      return undefined;
    }
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
      pending: true,
      spine,
      items,
      primitive: items.every((item) => typeof item.value !== 'object'),
      scalar: undefined,
    });
  }
  return items;
}

function reuseListItems(runtime: Runtime, view: ListView): ListItem[] {
  if (view.pending) {
    let pending = false;
    for (const slot of view.spine) pending = runtime.trackPreview(slot) || pending;
    for (const item of view.items) pending = runtime.trackPreview(item.slot) || pending;
    view.pending = pending;
  }
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
  if (value.con.type.traceKind === 'ratio') return ratioScalarOf(runtime, value);
  if (value.con.type.traceKind === 'bool') return value.con.tag === 1;
  if (value.con === CONS_CON || value.con === NIL_CON) return listScalarOf(runtime, value, type, depth);
  if (value.con === UNIT_CON || value.con.type.traceKind === 'maybe') return NOT_SCALAR;
  if (value.fields.length === 0 && !value.con.isLibraryPrivate) return value.con.name;
  return NOT_SCALAR;
}

const ratioScalars = new WeakMap<ConValue, string>();

function ratioScalarOf(runtime: Runtime, value: ConValue): Scalar | typeof NOT_SCALAR {
  for (const field of value.fields) runtime.trackPreview(field);
  const cached = ratioScalars.get(value);
  if (cached !== undefined) return cached;
  return runtime.withRenderBudget('answer', () => {
    const numerator = forceForDisplay(runtime, value.fields[0]);
    const denominator = forceForDisplay(runtime, value.fields[1]);
    if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint') return NOT_SCALAR;
    const scalar = `${numerator} % ${denominator}`;
    runtime.spend(scalar.length);
    ratioScalars.set(value, scalar);
    return scalar;
  });
}

function listScalarOf(runtime: Runtime, value: ConValue, type: Type, depth: number): Scalar | typeof NOT_SCALAR {
  if (oversizedLists.has(value)) return NOT_SCALAR;
  const cached = listViews.get(value)?.get(type);
  if (cached?.scalar !== undefined && depth < MAX_DISPLAY_DEPTH) {
    reuseListItems(runtime, cached);
    return cached.scalar;
  }
  return runtime.withRenderBudget(isStringType(type, value) ? 'answer' : 'reference', () =>
    uncachedListScalarOf(runtime, value, type, depth)
  );
}

function uncachedListScalarOf(
  runtime: Runtime,
  value: ConValue,
  type: Type,
  depth: number
): Scalar | typeof NOT_SCALAR {
  const items = listItems(runtime, value, type);
  if (!items) return NOT_SCALAR;
  const view = listViews.get(value)?.get(type);
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

interface NodeCapture {
  slots: Slot[];
  dependencies: CachedDisplay[];
  cacheable: boolean;
}

class DisplayNodes {
  private readonly ancestors = new Set<ConValue>();
  private capture: NodeCapture | undefined;
  private readonly cache: ReturnType<typeof displayCacheFor>;
  constructor(private readonly runtime: Runtime) {
    this.cache = displayCacheFor(runtime);
  }

  build(value: Value, type: Type, depth: number): DisplayNode | undefined {
    this.runtime.spend();
    if (depth > MAX_DISPLAY_DEPTH) return this.truncated();
    if (!(value instanceof ConValue)) {
      if (typeof value !== 'object') return this.primitiveNode(value, type, depth);
      if (this.capture) this.capture.cacheable = false;
      this.runtime.allocateDisplay();
      return this.nodeOf(value, type, depth);
    }
    if (oversizedLists.has(value) || this.ancestors.has(value)) return this.truncated();
    return this.memo(value, type, `node:${depth}`, () => {
      this.ancestors.add(value);
      try {
        return this.nodeOf(value, type, depth);
      } finally {
        this.ancestors.delete(value);
      }
    });
  }

  // code-gauge-allow functionCognitiveComplexity 27 -- One branch per kind of value shown as a node.
  // code-gauge-allow functionNcss 34 -- Node formatting dispatches on each supported value representation.
  private nodeOf(value: Value, type: Type, depth: number): DisplayNode | undefined {
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
      if (con.name === 'Nothing') return NULL_NODE;
      const inner = this.force(value.fields[0]);
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
      const node = this.force(slot);
      if (!(node instanceof ConValue)) return false;
      if (node.fields.length === 0) return true;
      const left = kind === 'map' ? 3 : 2;
      if (!visit(node.fields[left]) || count >= MAX_ELEMENTS) return false;
      const key = this.force(node.fields[1]);
      if (key === undefined) return false;
      entries[count++] =
        this.memo(node, type, `entry:${depth}`, () => {
          const keyNode = this.build(key, elementType(type, 0), depth + 1) ?? NULL_NODE;
          if (kind === 'set') return keyNode;
          const item = this.force(node.fields[2]);
          return {
            kind: 'array',
            entries: {
              0: keyNode,
              1: item === undefined ? NULL_NODE : (this.build(item, elementType(type, 1), depth + 1) ?? NULL_NODE),
            },
          };
        }) ?? NULL_NODE;
      return visit(node.fields[left + 1]);
    };
    return visit(value) ? { kind: 'array', entries } : this.truncated();
  }

  private listNodeOf(value: ConValue, type: Type, depth: number): DisplayNode {
    const items = listItems(this.runtime, value, type);
    if (!items) return this.truncated();
    const view = listViews.get(value)?.get(type);
    if (view && this.capture) {
      for (const slot of view.spine) this.capture.slots.push(slot);
      for (const item of items) this.capture.slots.push(item.slot);
    }
    if (isStringType(type, value)) return { kind: 'value', value: charsOf(items) };
    const entries: Record<string, DisplayNode> = Object.create(null);
    for (const [index, item] of items.entries()) {
      entries[index] = this.build(item.value, item.type, depth + 1) ?? NULL_NODE;
    }
    return { kind: 'array', entries };
  }

  private truncated(): DisplayNode {
    if (this.capture) this.capture.cacheable = false;
    this.runtime.incompletePreview();
    return { kind: 'value', value: '…' };
  }

  private dataNodeOf(value: ConValue, type: Type, depth: number): DisplayNode {
    const { con } = value;
    const entries: Record<string, DisplayNode> = Object.create(null);
    const isTuple = con.type.special === 'tuple';
    if (!isTuple && con.type.cons.length > 1) entries['<constructor>'] = { kind: 'value', value: con.name };
    for (const [index, field] of value.fields.entries()) {
      const forced = this.force(field);
      if (forced === undefined) continue;
      const fieldType = isTuple ? elementType(type, index) : constructorFieldType(con, type, index);
      const node = this.build(forced, slotDisplayType(field, fieldType), depth + 1);
      if (node) entries[con.fieldNames?.[index] ?? String(index)] = node;
    }
    return { kind: isTuple ? 'array' : 'object', entries };
  }

  private primitiveNode(value: Value, type: Type, depth: number): DisplayNode | undefined {
    const cache = this.cache;
    const cached = cache.get(value, type, 'primitive');
    if (cached) return cached.node;
    this.runtime.allocateDisplay();
    const node = this.nodeOf(value, type, depth);
    if (node && isConcreteType(type)) {
      cache.set(value, type, 'primitive', { node, slots: [], dependencies: [], pending: false });
      this.runtime.retainDisplay();
    }
    return node;
  }

  private memo(value: ConValue, type: Type, key: string, work: () => DisplayNode | undefined): DisplayNode | undefined {
    const cached = this.cache.get(value, type, key);
    if (cached) {
      this.reuse(cached);
      return cached.node;
    }
    return this.runtime.withRenderBudget('reference', () => this.captureNode(value, type, key, work));
  }

  private captureNode(
    value: ConValue,
    type: Type,
    key: string,
    work: () => DisplayNode | undefined
  ): DisplayNode | undefined {
    this.runtime.allocateDisplay();
    const parent = this.capture;
    const capture: NodeCapture = { slots: [...value.fields], dependencies: [], cacheable: true };
    this.capture = capture;
    let completed: CachedDisplay | undefined;
    try {
      const node = work();
      if (node && capture.cacheable && isConcreteType(type)) {
        completed = { node, slots: capture.slots, dependencies: capture.dependencies, pending: true };
        this.cache.set(value, type, key, completed);
        this.runtime.retainDisplay();
      }
      return node;
    } finally {
      this.capture = parent;
      if (parent) {
        parent.cacheable &&= completed !== undefined;
        if (completed) parent.dependencies.push(completed);
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- One postorder walk settles a shared cache-dependency graph once.
  private reuse(cached: CachedDisplay): void {
    if (cached.pending) {
      const pending = [{ view: cached, visited: false }];
      const seen = new Set<CachedDisplay>();
      while (pending.length > 0) {
        const { view, visited } = pending.pop()!;
        if (!view.pending) continue;
        if (!visited) {
          if (seen.has(view)) continue;
          seen.add(view);
          pending.push({ view, visited: true });
          for (const dependency of view.dependencies) pending.push({ view: dependency, visited: false });
          continue;
        }
        let unreleased = view.dependencies.some((dependency) => dependency.pending);
        for (const slot of view.slots) unreleased = this.runtime.trackPreview(slot) || unreleased;
        view.pending = unreleased;
      }
    }
    if (this.capture) this.capture.dependencies.push(cached);
  }

  private force(slot: Slot): Value | undefined {
    const value = forceForDisplay(this.runtime, slot);
    if (this.capture) {
      this.capture.slots.push(slot);
      if (value === undefined) this.capture.cacheable = false;
    }
    return value;
  }
}
