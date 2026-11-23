import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItem, TraceItemVariable, TraceScalar } from '../problems/trace';
import type { ClassInfo, FieldMember } from './classes';
import type { CompiledProgram } from './compiler';
import { newRuntime, runProgram } from './execute';
import { formatDouble } from './format';
import type { HashStore } from './hashStore';
import { parseDart } from './parse';
import { compileProgram } from './program';
import type { Frame, Runtime } from './runtime';
import { coreTypes, type DartType, DYNAMIC } from './types';
import {
  DartList,
  DartObject,
  DartPackedList,
  DartRecord,
  LateInitializer,
  UNASSIGNED,
  UNINITIALIZED,
  type Value,
} from './values';

// code-gauge-allow duplicateLines -- Dart wires its runtime into the shared recorder.
export function traceDartProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const compiled = compileProgram(parseDart(program), { atomicRows: new Set(trace.atomicAnnotations.keys()) });
  const runtime = newRuntime(input);
  const snapshotter = new Snapshotter(runtime, compiled);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.info.isAtomic,
    hidesCallRow: (frame) => frame.info.isLibrary,
    recordItem: (item) => snapshotter.recordItem(item),
    variablesOf: (frame) => snapshotter.variablesOf(frame, true, true),
    scalarVarsOf: (frame) => snapshotter.variablesOf(frame, true).vars,
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  // A model program may end with an uncaught exception to show how one stops the program.
  const run = runProgram(runtime, compiled, (frame) => {
    finalVars = snapshotter.variablesOf(frame, false).vars;
  });
  snapshotter.chargeScalars(finalVars);
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

const MAX_SNAPSHOT_NODES = 4096;
const TRACE_NODE_COST = 32;

interface ListSnapshots {
  scalar: WeakMap<TraceList, Scalar[]>;
  display: WeakMap<TraceList, { node: ArrayNode; count: number }>;
}

type ArrayNode = Extract<DisplayNode, { kind: 'array' | 'object' }>;

type TraceList = DartList | DartPackedList;

interface SnapshotBudget {
  remaining: number;
  path: Set<DartObject>;
  lists: ListSnapshots;
}

interface SnapshotRoot {
  name: string;
  value: Value;
  type: DartType;
  mode?: 'scalar' | 'reference';
}

class Snapshotter {
  private readonly lists: ListSnapshots = { scalar: new WeakMap(), display: new WeakMap() };
  private readonly chargedSnapshots = new WeakSet<object>();
  private remainingTraceSize = LIMITS.maxDartTraceSize;

  constructor(
    private readonly runtime: Runtime,
    private readonly program: CompiledProgram
  ) {}

  recordItem(item: TraceItem): TraceItem {
    this.charge(item.board.length + TRACE_NODE_COST * (item.callLines.length + item.turtles.length * 4 + 1));
    this.chargeScalars(item.vars);
    for (const [name, node] of Object.entries(item.referenceVars)) {
      this.charge(name.length);
      this.chargeReference(node);
    }
    return item;
  }

  chargeScalars(vars: TraceItemVariable): void {
    for (const [name, value] of Object.entries(vars)) {
      this.charge(name.length);
      this.chargeScalar(value);
    }
  }

  private chargeScalar(value: Scalar): void {
    if (!Array.isArray(value)) {
      this.charge(TRACE_NODE_COST + (typeof value === 'string' ? value.length : 0));
      return;
    }
    if (!this.chargeSnapshot(value)) return;
    this.charge(8 * value.length);
    for (const item of value) {
      if (Array.isArray(item)) this.chargeScalar(item);
      else if (typeof item === 'string') this.charge(item.length);
    }
  }

  private chargeReference(node: DisplayNode): void {
    if (!this.chargeSnapshot(node)) return;
    if (node.kind === 'value') {
      if (typeof node.value === 'string') this.charge(node.value.length);
      return;
    }
    for (const [name, child] of Object.entries(node.entries)) {
      this.charge(node.kind === 'array' ? 8 : 16 + name.length);
      this.chargeReference(child);
    }
  }

  private chargeSnapshot(snapshot: object): boolean {
    if (this.chargedSnapshots.has(snapshot)) return false;
    this.chargedSnapshots.add(snapshot);
    this.charge(TRACE_NODE_COST);
    return true;
  }

  private charge(cost: number): void {
    this.remainingTraceSize -= cost;
    if (this.remainingTraceSize < 0) throw new ExecutionLimitError('trace');
  }

  variablesOf(frame: Frame, withContext: boolean, includeReferences = false): TraceVariables {
    return snapshot(this.rootsOf(frame, withContext), includeReferences, this.lists);
  }

  // code-gauge-allow functionCognitiveComplexity -- One case per kind of value a trace shows.
  private *rootsOf(frame: Frame, withContext: boolean): Iterable<SnapshotRoot> {
    const shown = new Set<string>();
    const hidesArgs = frame.info.name === 'main' && this.program.mainTakesArguments;
    for (const [slot, local] of frame.info.locals.entries()) {
      const cell = frame.locals[slot];
      if (!cell || local.name.startsWith('\0') || (hidesArgs && slot === 0)) continue;
      if (!showsValue(cell.v)) continue;
      shown.add(local.name);
      yield { name: local.name, value: cell.v, type: local.type };
    }
    for (const [position, capture] of frame.info.captures.entries()) {
      const cell = frame.captured[position];
      if (!cell || shown.has(capture.name) || !showsValue(cell.v)) continue;
      shown.add(capture.name);
      yield { name: capture.name, value: cell.v, type: capture.type };
    }
    if (!withContext) return;
    for (const global of this.program.programGlobals) {
      if (global.isConst || shown.has(global.displayName)) continue;
      const cell = this.runtime.globals[global.slot];
      if (!cell || cell.v === UNINITIALIZED || typeof cell.v === 'symbol') continue;
      yield { name: global.displayName, value: cell.v, type: global.type };
    }
    if (frame.info.showsThis && frame.receiver instanceof DartObject) yield* thisRoots(frame.receiver);
  }
}

function snapshot(roots: Iterable<SnapshotRoot>, includeReferences: boolean, lists: ListSnapshots): TraceVariables {
  const variables: TraceVariables = { vars: traceEntries(), referenceVars: traceEntries() };
  const visible = [...roots].filter(({ value }) => !(value instanceof DartObject && value.cls === coreTypes.function));
  let objectRoots = visible.filter(({ value }) => value instanceof DartObject).length;
  let scalarNodes = MAX_SNAPSHOT_NODES;
  let referenceNodes = MAX_SNAPSHOT_NODES;
  const path = new Set<DartObject>();
  for (const root of visible) {
    const object = root.value instanceof DartObject;
    const scalarLimit = object ? Math.ceil(scalarNodes / objectRoots) : 1;
    const refLimit = object ? Math.ceil(referenceNodes / objectRoots) : 1;
    const scalar = { remaining: scalarLimit, path, lists };
    const reference = includeReferences ? { remaining: refLimit, path, lists } : undefined;
    addVariable(variables, root, scalar, reference);
    const scalarUsed = scalarLimit - scalar.remaining;
    const referenceUsed = reference ? refLimit - reference.remaining : 0;
    if (object) {
      scalarNodes -= scalarUsed;
      referenceNodes -= referenceUsed;
      objectRoots--;
    }
  }
  return variables;
}

function showsValue(value: Value): boolean {
  return value !== UNASSIGNED && value !== UNINITIALIZED && !(value instanceof LateInitializer);
}

const NOT_SCALAR = Symbol('notScalar');
const TRUNCATED = '…';
const CYCLE = '… (cycle)';
type Scalar = TraceItemVariable[string];

function addVariable(
  variables: TraceVariables,
  { name, value, type, mode }: SnapshotRoot,
  scalars: SnapshotBudget,
  references: SnapshotBudget | undefined
): void {
  // A null variable is a reference that refers to nothing, as Java shows a null String or array.
  const scalar = mode === 'reference' || value === undefined ? NOT_SCALAR : scalarOf(value, type, scalars);
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  if (!references || mode === 'scalar' || (scalar !== NOT_SCALAR && !isTraceList(value))) return;
  const node = displayNodeOf(value, references);
  if (node) variables.referenceVars[name] = node;
}

function* thisRoots(self: DartObject): Iterable<SnapshotRoot> {
  for (const field of allFields(self.cls)) {
    const value = self.fields[field.slot];
    if (value !== UNINITIALIZED) yield { name: `this.${field.name}`, value, type: field.type, mode: 'scalar' };
  }
  yield { name: 'this', value: self, type: DYNAMIC, mode: 'reference' };
}

function* allFields(cls: ClassInfo): Iterable<FieldMember> {
  const chain: ClassInfo[] = [];
  for (let current: ClassInfo | undefined = cls; current; current = current.superclass?.cls) chain.unshift(current);
  for (const current of chain) yield* current.fields;
}

function primitiveScalar(value: Value): TraceScalar | typeof NOT_SCALAR {
  switch (typeof value) {
    case 'undefined': {
      // oxlint-disable-next-line unicorn/no-null -- The trace format shows Dart's null as null.
      return null;
    }
    case 'bigint': {
      const number = Number(value);
      return Number.isSafeInteger(number) ? number : value;
    }
    case 'number': {
      return Number.isFinite(value) ? value : formatDouble(value);
    }
    case 'string':
    case 'boolean': {
      return value;
    }
    default: {
      return NOT_SCALAR;
    }
  }
}

/**
 * The value learners write down for a variable of a type: numbers, booleans, strings, and lists of them. A null of an
 * object type is a reference, as Java shows a null object.
 */
function scalarOf(value: Value, type: DartType, budget: SnapshotBudget): Scalar | typeof NOT_SCALAR {
  if (budget.remaining === 0) return NOT_SCALAR;
  budget.remaining--;
  if (!isScalarType(type)) return NOT_SCALAR;
  const primitive = primitiveScalar(value);
  if (primitive !== NOT_SCALAR) return primitive;
  return isTraceList(value) ? listScalar(value, budget) : NOT_SCALAR;
}

function isTraceList(value: Value): value is TraceList {
  return value instanceof DartList || value instanceof DartPackedList;
}

function listScalar(list: TraceList, budget: SnapshotBudget): Scalar | typeof NOT_SCALAR {
  const seen = budget.path;
  if (seen.has(list)) return CYCLE;
  if (seen.size >= LIMITS.maxCallDepth) return TRUNCATED;
  if (list.length > 0 && budget.remaining === 0) return omittedElements(list.length);
  const elementType = list.typeArgs[0] ?? DYNAMIC;
  seen.add(list);
  try {
    const entries: Scalar[] = [];
    for (const [index, element] of list.entries()) {
      const reserveMarker = index + 1 < list.length ? 1 : 0;
      if (budget.remaining === reserveMarker) {
        budget.remaining -= reserveMarker;
        entries.push(omittedElements(list.length - index));
        break;
      }
      budget.remaining -= reserveMarker;
      const scalar = scalarOf(element, elementType, budget);
      budget.remaining += reserveMarker;
      // oxlint-disable-next-line unicorn/no-null -- The trace format shows a non-scalar list entry as null.
      entries.push(scalar === NOT_SCALAR ? null : scalar);
    }
    const previous = budget.lists.scalar.get(list);
    if (previous?.length === entries.length && entries.every((entry, index) => Object.is(entry, previous[index])))
      return previous;
    budget.lists.scalar.set(list, entries);
    return entries;
  } finally {
    seen.delete(list);
  }
}

function omittedElements(length: number): string {
  return `${TRUNCATED} (${length} more)`;
}

function isScalarType(type: DartType): boolean {
  if (type.kind === 'dynamic') return true;
  if (type.kind !== 'interface') return false;
  const { cls } = type;
  if (cls === coreTypes.list) return isScalarType(type.args[0] ?? DYNAMIC);
  return [coreTypes.int, coreTypes.double, coreTypes.num, coreTypes.bool, coreTypes.string].includes(cls);
}

// oxlint-disable-next-line unicorn/no-null -- The trace format shows Dart's null as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };
const TRUNCATED_NODE: DisplayNode = { kind: 'value', value: TRUNCATED, verbatim: true };
const CYCLE_NODE: DisplayNode = { kind: 'value', value: CYCLE, verbatim: true };

// code-gauge-allow functionCognitiveComplexity -- One case per kind of value a trace shows.
// code-gauge-allow functionNcss -- One case per kind of value a trace shows.
function displayNodeOf(value: Value, budget: SnapshotBudget, previous?: DisplayNode): DisplayNode | undefined {
  if (budget.remaining === 0) return TRUNCATED_NODE;
  budget.remaining--;
  const seen = budget.path;
  // A late field not yet initialized holds a marker, which shows nothing.
  if (typeof value === 'symbol') return undefined;
  const primitive = primitiveScalar(value);
  if (primitive !== NOT_SCALAR) {
    if (previous?.kind === 'value' && !previous.verbatim && Object.is(previous.value, primitive)) return previous;
    return { kind: 'value', value: primitive };
  }
  const object = value as DartObject;
  if (object.turtle) {
    if (!object.turtle.isAlive) return undefined;
    return {
      kind: 'object',
      entries: { x: { kind: 'value', value: object.turtle.x }, y: { kind: 'value', value: object.turtle.y } },
    };
  }
  if (seen.has(object)) return CYCLE_NODE;
  if (seen.size >= LIMITS.maxCallDepth) return TRUNCATED_NODE;
  if (object.cls === coreTypes.function) return undefined;
  // An enum value shows as its name, which is what learners write for it.
  if (object.cls.kind === 'enum')
    return { kind: 'value', value: `${object.cls.name}.${object.native?.name as string}` };
  if (object.native && typeof (object.native as { text?: unknown }).text === 'string') {
    return { kind: 'value', value: (object.native as unknown as { text: string }).text };
  }
  seen.add(object);
  try {
    if (isTraceList(object)) return listDisplayNode(object, budget);
    if (object instanceof DartRecord) return entriesNode('object', recordFields(object), budget);
    const store = object.native as unknown as HashStore | undefined;
    if (store && typeof store.positions === 'function') return storeNodeOf(store, budget);
    const entries = traceEntries<DisplayNode>();
    for (const field of allFields(object.cls)) {
      const node = displayNodeOf(object.fields[field.slot], budget);
      if (node) entries[field.name] = node;
      if (node === TRUNCATED_NODE) break;
    }
    return { kind: 'object', entries };
  } finally {
    seen.delete(object);
  }
}

function listDisplayNode(list: TraceList, budget: SnapshotBudget): DisplayNode {
  const previous = budget.lists.display.get(list);
  const entries = traceEntries<DisplayNode>();
  let unchanged = previous !== undefined;
  let count = 0;
  for (const [position, item] of list.entries()) {
    const prior = previous?.node.entries[position];
    const node = displayNodeOf(item, budget, prior) ?? NULL_NODE;
    if (node !== prior) unchanged = false;
    entries[position] = node;
    count++;
    if (node === TRUNCATED_NODE) break;
  }
  if (unchanged && previous?.count === count) return previous.node;
  const node: ArrayNode = { kind: 'array', entries };
  budget.lists.display.set(list, { node, count });
  return node;
}

function entriesNode(
  kind: 'array' | 'object',
  fields: Iterable<readonly [string | number, Value]>,
  budget: SnapshotBudget
): DisplayNode {
  const entries = traceEntries<DisplayNode>();
  for (const [name, item] of fields) {
    const node = displayNodeOf(item, budget) ?? NULL_NODE;
    entries[name] = node;
    if (node === TRUNCATED_NODE) break;
  }
  return { kind, entries };
}

function* recordFields(record: DartRecord): Iterable<readonly [string, Value]> {
  for (const [position, item] of record.positional.entries()) yield [`$${position + 1}`, item];
  yield* record.named;
}

/** Sets show as arrays of their elements, and maps as objects keyed by their keys' text. */
function storeNodeOf(store: HashStore, budget: SnapshotBudget): DisplayNode {
  if (!store.isMap) {
    const entries = traceEntries<DisplayNode>();
    let position = 0;
    for (const key of store.values()) {
      const node = displayNodeOf(key, budget) ?? NULL_NODE;
      entries[position++] = node;
      if (node === TRUNCATED_NODE) break;
    }
    return { kind: 'array', entries };
  }
  const entries = traceEntries<DisplayNode>();
  for (const position of store.positions()) {
    if (budget.remaining === 0) {
      entries[TRUNCATED] = TRUNCATED_NODE;
      break;
    }
    const key = store.keyAt(position);
    const node = displayNodeOf(key, budget);
    const label = node?.kind === 'value' ? String(node.value) : `#${(key as DartObject).identity}`;
    let unique = label;
    for (let suffix = 2; unique === TRUNCATED || Object.hasOwn(entries, unique); suffix++) {
      unique = `${label} (${suffix})`;
    }
    entries[unique] = displayNodeOf(store.entryValues[position], budget) ?? NULL_NODE;
  }
  return { kind: 'object', entries };
}

function traceEntries<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export type { DartType };
