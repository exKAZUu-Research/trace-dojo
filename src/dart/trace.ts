import { LIMITS } from '../interpreter/limits';
import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable, TraceScalar } from '../problems/trace';
import type { ClassInfo, FieldMember } from './classes';
import type { CompiledProgram } from './compiler';
import { newRuntime, runProgram } from './execute';
import { formatDouble } from './format';
import type { HashStore } from './hashStore';
import { parseDart } from './parse';
import { compileProgram } from './program';
import type { Frame, Runtime } from './runtime';
import { coreTypes, type DartType, DYNAMIC } from './types';
import { DartList, DartObject, DartRecord, UNASSIGNED, UNINITIALIZED, type Value } from './values';

// code-gauge-allow duplicateLines 16 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
export function traceDartProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const compiled = compileProgram(parseDart(program), { atomicRows: new Set(trace.atomicAnnotations.keys()) });
  const runtime = newRuntime(input);
  const snapshotter = new Snapshotter(runtime, compiled);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.info.isAtomic,
    variablesOf: (frame) => snapshotter.variablesOf(frame, true, true),
    scalarVarsOf: (frame) => snapshotter.variablesOf(frame, true).vars,
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  // A model program may end with an uncaught exception to show how one stops the program.
  const run = runProgram(runtime, compiled, (frame) => {
    finalVars = snapshotter.variablesOf(frame, false).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

const MAX_SNAPSHOT_NODES = 4096;

interface ListSnapshots {
  scalar: WeakMap<DartList, Scalar[]>;
  display: WeakMap<DartList, { node: ArrayNode; count: number }>;
}

type ArrayNode = Extract<DisplayNode, { kind: 'array' | 'object' }>;

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

  constructor(
    private readonly runtime: Runtime,
    private readonly program: CompiledProgram
  ) {}

  variablesOf(frame: Frame, withContext: boolean, includeReferences = false): TraceVariables {
    return snapshot(this.rootsOf(frame, withContext), includeReferences, this.lists);
  }

  // code-gauge-allow functionCognitiveComplexity 23 -- One case per kind of value a trace shows.
  private *rootsOf(frame: Frame, withContext: boolean): Iterable<SnapshotRoot> {
    const shown = new Set<string>();
    const hidesArgs = frame.info.name === 'main' && this.program.mainTakesArguments;
    for (const [slot, local] of frame.info.locals.entries()) {
      const cell = frame.locals[slot];
      if (!cell || local.name.startsWith('\0') || (hidesArgs && slot === 0)) continue;
      if (cell.v === UNASSIGNED || cell.v === UNINITIALIZED || isLateInitializer(cell.v)) continue;
      shown.add(local.name);
      yield { name: local.name, value: cell.v, type: local.type };
    }
    for (const [position, capture] of frame.info.captures.entries()) {
      const cell = frame.captured[position];
      if (!cell || shown.has(capture.name) || cell.v === UNASSIGNED || cell.v === UNINITIALIZED) continue;
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
  const variables: TraceVariables = { vars: {}, referenceVars: {} };
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

function isLateInitializer(value: Value): boolean {
  return typeof value === 'object' && !(value instanceof DartObject);
}

const NOT_SCALAR = Symbol('notScalar');
type Scalar = TraceItemVariable[string];

function addVariable(
  variables: TraceVariables,
  { name, value, type, mode }: SnapshotRoot,
  scalars: SnapshotBudget,
  references: SnapshotBudget | undefined
): void {
  const scalar = mode === 'reference' ? NOT_SCALAR : scalarOf(value, type, scalars);
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  if (!references || mode === 'scalar' || (scalar !== NOT_SCALAR && !(value instanceof DartList))) return;
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
// code-gauge-allow functionCognitiveComplexity 18 -- Lists share an unchanged snapshot after checking their elements.
function scalarOf(value: Value, type: DartType, budget: SnapshotBudget): Scalar | typeof NOT_SCALAR {
  if (budget.remaining === 0) return NOT_SCALAR;
  budget.remaining--;
  if (!isScalarType(type)) return NOT_SCALAR;
  const primitive = primitiveScalar(value);
  if (primitive !== NOT_SCALAR) return primitive;
  if (value instanceof DartList) {
    const seen = budget.path;
    if (seen.has(value) || seen.size >= LIMITS.maxCallDepth) return NOT_SCALAR;
    const elementType = value.typeArgs[0] ?? DYNAMIC;
    seen.add(value);
    try {
      const entries: Scalar[] = [];
      for (const element of value.elements) {
        if (budget.remaining === 0) break;
        const scalar = scalarOf(element, elementType, budget);
        // oxlint-disable-next-line unicorn/no-null -- The trace format shows a non-scalar list entry as null.
        entries.push(scalar === NOT_SCALAR ? null : scalar);
      }
      const previous = budget.lists.scalar.get(value);
      if (previous?.length === entries.length && entries.every((entry, index) => Object.is(entry, previous[index])))
        return previous;
      budget.lists.scalar.set(value, entries);
      return entries;
    } finally {
      seen.delete(value);
    }
  }
  return NOT_SCALAR;
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
const TRUNCATED_NODE: DisplayNode = { kind: 'value', value: '…', verbatim: true };

// code-gauge-allow functionCognitiveComplexity 24 -- One case per kind of value a trace shows.
// code-gauge-allow functionNcss 43 -- One case per kind of value a trace shows.
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
  if (seen.has(object) || seen.size >= LIMITS.maxCallDepth) return undefined;
  if (object.cls === coreTypes.function) return undefined;
  // An enum value shows as its name, which is what learners write for it.
  if (object.cls.kind === 'enum')
    return { kind: 'value', value: `${object.cls.name}.${object.native?.name as string}` };
  if (object.native && typeof (object.native as { text?: unknown }).text === 'string') {
    return { kind: 'value', value: (object.native as unknown as { text: string }).text };
  }
  seen.add(object);
  try {
    if (object instanceof DartList) return listDisplayNode(object, budget);
    if (object instanceof DartRecord) return entriesNode('object', recordFields(object), budget);
    const store = object.native as unknown as HashStore | undefined;
    if (store && typeof store.positions === 'function') return storeNodeOf(store, budget);
    const entries: Record<string, DisplayNode> = {};
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

function listDisplayNode(list: DartList, budget: SnapshotBudget): DisplayNode {
  const previous = budget.lists.display.get(list);
  const entries: Record<string, DisplayNode> = {};
  let unchanged = previous !== undefined;
  let count = 0;
  for (const [position, item] of list.elements.entries()) {
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
  const entries: Record<string, DisplayNode> = {};
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
    const entries: Record<string, DisplayNode> = {};
    let position = 0;
    for (const key of store.values()) {
      const node = displayNodeOf(key, budget) ?? NULL_NODE;
      entries[position++] = node;
      if (node === TRUNCATED_NODE) break;
    }
    return { kind: 'array', entries };
  }
  const entries = Object.create(null) as Record<string, DisplayNode>;
  for (const position of store.positions()) {
    if (budget.remaining === 0) {
      entries['…'] = TRUNCATED_NODE;
      break;
    }
    const key = store.keyAt(position);
    const node = displayNodeOf(key, budget);
    const label = node?.kind === 'value' ? String(node.value) : `#${(key as DartObject).identity}`;
    entries[label] = displayNodeOf(store.entryValues[position], budget) ?? NULL_NODE;
  }
  return { kind: 'object', entries };
}

export type { DartType };
