import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { dec } from './bytes';
import { canAccessProp, declForKey, type LazyRef, lookupProp, propNameOf } from './classes';
import { cachedObjectFree } from './gcRoots';
import { parsePhp } from './parse';
import { runProgram } from './run';
import { type Frame, rt, Runtime } from './runtime';
import { isClosure, type Key, PhpArray, PhpObject, Ref, UNDEFINED_RESULT, UNINIT, type Value } from './values';

export function tracePhpProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const parsed = parsePhp(program, trace);
  const runtime = new Runtime(input);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.isAtomic,
    variablesOf: (frame) => variablesOf(runtime, frame, true),
    stateVariables,
    ignoreStateVariable: (value, otherValue) =>
      value === DISPLAY_ONLY_ARRAY || (otherValue === DISPLAY_ONLY_ARRAY && Array.isArray(value)),
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  // A model program may end with an uncaught exception to show how one stops the program.
  const run = runProgram(runtime, parsed, (frame) => {
    finalVars = variablesOf(runtime, frame, false).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

const arraySnapshots = new WeakMap<DisplayNode, unknown>();
const DISPLAY_ONLY_ARRAY = Symbol('display-only array');

function stateVariables({ vars, referenceVars }: TraceVariables): Record<string, unknown> {
  const snapshots = Object.entries(referenceVars)
    .filter(([name]) => !Object.hasOwn(vars, name))
    .map(([name, node]) => [name, arraySnapshots.get(node)] as const)
    .filter(([, snapshot]) => snapshot !== undefined);
  return snapshots.length > 0 ? { ...vars, ...Object.fromEntries(snapshots) } : vars;
}

/**
 * The variables a frame shows: its local variables (`$x`), then, when `withContext`, the properties of `$this`
 * (`$this->x`, as Java's `this.x`) and the static properties of the program's classes (`Foo::$x`, as Java's static
 * fields).
 */
function variablesOf(runtime: Runtime, frame: Frame, withContext: boolean): TraceVariables {
  runtime.budget.checkClock();
  const variables: TraceVariables = { vars: {}, referenceVars: {} };
  for (const [name, ref] of frame.vars) {
    if (name === 'GLOBALS') continue;
    addVariable(variables, `$${dec(name)}`, ref.v, withContext);
  }
  if (!withContext) return variables;
  contextProperties(variables, frame);
  staticVariables(variables, runtime);
  return variables;
}

function contextProperties(variables: TraceVariables, frame: Frame): void {
  const self = frame.thisObj;
  if (!self) return;
  for (const [key, slot] of self.props) {
    if (slot === UNINIT) continue;
    const name = propNameOf(key);
    const decl = lookupProp(self.cls, name, frame.scope);
    if (decl && (decl.key !== key || !canAccessProp(decl, frame.scope))) continue;
    addVariable(variables, `$this->${dec(name)}`, slot instanceof Ref ? slot.v : slot);
  }
}

function staticVariables(variables: TraceVariables, runtime: Runtime): void {
  for (const cls of runtime.userClasses) {
    if (cls.isAnonymous) continue;
    for (const [name, { ref, decl }] of cls.staticProps) {
      if (decl.cls !== cls) continue;
      if ((ref as LazyRef).lazy) continue;
      const value = ref.v;
      if ((value as unknown) === UNINIT) continue;
      addVariable(variables, `${dec(cls.name)}::$${dec(name)}`, value);
    }
  }
}

/** Closures are definitions, not variables, to learners. */
function isVariableValue(value: Value): boolean {
  return !(value instanceof PhpObject && isClosure(value));
}

const MAX_SCALAR_EXPANSION = 10_000;
const MAX_DISPLAY_EXPANSION = 2000;

interface PrimitiveArraySnapshot {
  version: number;
  scalar: Scalar | typeof NOT_SCALAR;
  node: DisplayNode;
}

const primitiveArrayCache = new WeakMap<PhpArray, PrimitiveArraySnapshot>();

function define(target: Record<string, unknown>, name: string, value: unknown): void {
  if (name === '__proto__')
    Object.defineProperty(target, name, { value, enumerable: true, configurable: true, writable: true });
  else target[name] = value;
}

function addVariable(variables: TraceVariables, name: string, value: Value, compareSteps = true): void {
  if (!isVariableValue(value)) return;
  if (value instanceof PhpArray && !value.composite) {
    const snapshot = primitiveArraySnapshot(value);
    if (snapshot.scalar !== NOT_SCALAR) define(variables.vars, name, snapshot.scalar);
    define(variables.referenceVars, name, snapshot.node);
    return;
  }
  // As JavaScript's trace does, null is a reference that refers to nothing, which only the references show.
  const scalar = value === null ? NOT_SCALAR : scalarOf(value, new Set(), { remaining: MAX_SCALAR_EXPANSION });
  if (scalar !== NOT_SCALAR) define(variables.vars, name, scalar);
  // Arrays also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !(value instanceof PhpArray)) return;
  const node = displayNodeOf(value, new Set(), { remaining: MAX_DISPLAY_EXPANSION });
  if (!node) return;
  if (compareSteps && value instanceof PhpArray && scalar === NOT_SCALAR && arrayContainsObjects(value))
    arraySnapshots.set(node, DISPLAY_ONLY_ARRAY);
  define(variables.referenceVars, name, node);
}

// code-gauge-allow functionCognitiveComplexity -- Visits each reachable array once and skips known object-free storage.
function arrayContainsObjects(array: PhpArray): boolean {
  const pending = new Set([array]);
  let scanned = 0;
  for (const current of pending) {
    if (!current.composite || cachedObjectFree(current) === true) continue;
    for (const slot of current.map.ownedSlots()) {
      if ((++scanned & 255) === 0) rt().budget.checkClock();
      const value = slot instanceof Ref ? slot.v : slot;
      if (value instanceof PhpObject) return true;
      if (value instanceof PhpArray) pending.add(value);
    }
  }
  return false;
}

function primitiveArraySnapshot(array: PhpArray): PrimitiveArraySnapshot {
  const cached = primitiveArrayCache.get(array);
  if (cached?.version === array.mutationVersion) return cached;
  const packed = array.map.packedSlots();
  const isList = packed !== undefined || array.isList();
  const collectScalar = isList && array.size < MAX_SCALAR_EXPANSION;
  const scalarItems: Scalar[] | undefined = collectScalar ? [] : undefined;
  const entries: Record<string, DisplayNode> = {};
  const ordered: [string, unknown][] | undefined = collectScalar ? undefined : [];
  if (packed) fillPackedPrimitives(packed, scalarItems, entries, ordered);
  else fillMapPrimitives(array, isList, scalarItems, entries, ordered);
  const node: DisplayNode = { kind: isList ? 'array' : 'object', entries };
  if (ordered) arraySnapshots.set(node, ordered);
  const snapshot: PrimitiveArraySnapshot = {
    version: array.mutationVersion,
    scalar: scalarItems ? (scalarItems as Scalar) : NOT_SCALAR,
    node,
  };
  primitiveArrayCache.set(array, snapshot);
  return snapshot;
}

function fillPackedPrimitives(
  packed: readonly (Value | Ref)[],
  scalarItems: Scalar[] | undefined,
  entries: Record<string, DisplayNode>,
  ordered: [string, unknown][] | undefined
): void {
  const limit = scalarItems ? packed.length : Math.min(packed.length, MAX_DISPLAY_EXPANSION - 1);
  for (let index = 0; index < limit; index++) {
    const scalar = primitiveScalar(packed[index] as Value);
    scalarItems?.push(scalar);
    if (index < MAX_DISPLAY_EXPANSION - 1) {
      const label = String(index);
      const child = primitiveNode(scalar);
      entries[label] = child;
      ordered?.push([label, child]);
    }
  }
}

function fillMapPrimitives(
  array: PhpArray,
  isList: boolean,
  scalarItems: Scalar[] | undefined,
  entries: Record<string, DisplayNode>,
  ordered: [string, unknown][] | undefined
): void {
  let count = 0;
  for (const [key, slot] of array.map.entries()) {
    const scalar = primitiveScalar(slot as Value);
    scalarItems?.push(scalar);
    if (count < MAX_DISPLAY_EXPANSION - 1) {
      const label = keyLabel(key, isList);
      const child = primitiveNode(scalar);
      define(entries, label, child);
      ordered?.push([label, child]);
      count++;
    } else if (!scalarItems) break;
  }
}

function primitiveScalar(value: Value): Scalar {
  // oxlint-disable-next-line unicorn/no-null -- The trace format shows null as null.
  if (value === null || value === UNDEFINED_RESULT) return null;
  if (typeof value === 'bigint') return traceInt(value);
  if (typeof value === 'string') return dec(value);
  return value as number | boolean;
}

function primitiveNode(scalar: Scalar): DisplayNode {
  if (scalar === null) return NULL_NODE;
  if (scalar === true) return TRUE_NODE;
  if (scalar === false) return FALSE_NODE;
  return { kind: 'value', value: scalar as string | number | bigint };
}

const NOT_SCALAR = Symbol('notScalar');
type Scalar = TraceItemVariable[string];

function scalarOf(value: Value, seen: Set<object>, budget: { remaining: number }): Scalar | typeof NOT_SCALAR {
  if (budget.remaining-- <= 0) return NOT_SCALAR;
  if (value === null || typeof value !== 'object') return primitiveScalar(value);
  if (
    !(value instanceof PhpArray) ||
    value.size > budget.remaining ||
    seen.size >= 256 ||
    seen.has(value) ||
    !value.isList()
  )
    return NOT_SCALAR;
  if (!value.composite) {
    const scalar = primitiveArraySnapshot(value).scalar;
    if (scalar !== NOT_SCALAR) budget.remaining -= value.size;
    return scalar;
  }
  seen.add(value);
  const items: Scalar[] = [];
  for (const [, slot] of value.map.entries()) {
    const scalar = scalarOf(slot instanceof Ref ? slot.v : slot, seen, budget);
    if (scalar === NOT_SCALAR) return NOT_SCALAR;
    items.push(scalar);
  }
  seen.delete(value);
  return items as Scalar;
}

function traceInt(value: bigint): number | bigint {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}

// oxlint-disable-next-line unicorn/no-null -- The trace format shows null as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };
const TRUE_NODE: DisplayNode = { kind: 'value', value: true };
const FALSE_NODE: DisplayNode = { kind: 'value', value: false };

// code-gauge-allow functionCognitiveComplexity -- Each branch maps a PHP value shape to the shared trace display tree.
// code-gauge-allow functionNcss -- Each branch maps a PHP value shape to the shared trace display tree.
function displayNodeOf(value: Value, seen: Set<object>, budget: { remaining: number }): DisplayNode | undefined {
  if (budget.remaining-- <= 0) return { kind: 'value', value: '…' };
  if (value === UNDEFINED_RESULT) return undefined;
  if (value === null || typeof value !== 'object') return primitiveNode(primitiveScalar(value));
  if (!isVariableValue(value) || seen.has(value)) return undefined;
  if (seen.size >= 256) return { kind: 'value', value: '…' };
  if (value instanceof PhpObject && value.turtle) {
    if (!value.turtle.isAlive) return undefined;
    return {
      kind: 'object',
      entries: { x: { kind: 'value', value: value.turtle.x }, y: { kind: 'value', value: value.turtle.y } },
    };
  }
  if (value instanceof PhpArray && !value.composite) {
    const cost = Math.min(value.size, MAX_DISPLAY_EXPANSION - 1);
    if (budget.remaining >= cost) {
      budget.remaining -= cost;
      return primitiveArraySnapshot(value).node;
    }
  }
  seen.add(value);
  try {
    const entries: Record<string, DisplayNode> = {};
    if (value instanceof PhpArray) {
      const isList = value.isList();
      const ordered: [string, unknown][] = [];
      for (const [key, slot] of value.map.entries()) {
        const label = keyLabel(key, isList);
        const child = displayNodeOf(slot instanceof Ref ? slot.v : slot, seen, budget) ?? NULL_NODE;
        define(entries, label, child);
        ordered.push([label, arraySnapshots.get(child) ?? child]);
        if (budget.remaining <= 0) break;
      }
      const node: DisplayNode = { kind: isList ? 'array' : 'object', entries };
      arraySnapshots.set(node, ordered);
      return node;
    }
    return { kind: 'object', entries: objectEntries(value, seen, budget) };
  } finally {
    seen.delete(value);
  }
}

function objectEntries(
  value: PhpObject,
  seen: Set<object>,
  budget: { remaining: number }
): Record<string, DisplayNode> {
  const entries: Record<string, DisplayNode> = {};
  const counts = new Map<string, number>();
  for (const [key, slot] of value.props)
    if (slot !== UNINIT) {
      const name = propNameOf(key);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  for (const [key, slot] of value.props) {
    if (slot === UNINIT) continue;
    const node = displayNodeOf(slot instanceof Ref ? slot.v : slot, seen, budget);
    const name = propNameOf(key);
    const decl = declForKey(value.cls, key);
    const label = (counts.get(name) ?? 0) > 1 && decl ? `${decl.cls.name}::$${name}` : name;
    if (node) define(entries, dec(label), node);
    if (budget.remaining <= 0) break;
  }
  return entries;
}

function keyLabel(key: Key, isList: boolean): string {
  if (isList || typeof key === 'bigint') return String(key);
  return dec(key);
}
