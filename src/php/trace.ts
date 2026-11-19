import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { dec } from './bytes';
import { canAccessProp, declForKey, type LazyRef, lookupProp, propNameOf } from './classes';
import { parsePhp } from './parse';
import { runProgram } from './run';
import { type Frame, Runtime } from './runtime';
import { isClosure, type Key, PhpArray, PhpObject, Ref, UNDEFINED_RESULT, UNINIT, type Value } from './values';

export function tracePhpProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const parsed = parsePhp(program, trace);
  const runtime = new Runtime(input);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.isAtomic,
    variablesOf: (frame) => variablesOf(runtime, frame, true),
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  // A model program may end with an uncaught exception to show how one stops the program.
  const run = runProgram(runtime, parsed, (frame) => {
    finalVars = variablesOf(runtime, frame, false).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
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
    addVariable(variables, `$${dec(name)}`, ref.v);
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

function define(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, enumerable: true, configurable: true, writable: true });
}

function addVariable(variables: TraceVariables, name: string, value: Value): void {
  if (!isVariableValue(value)) return;
  // As JavaScript's trace does, null is a reference that refers to nothing, which only the references show.
  const scalar = value === null ? NOT_SCALAR : scalarOf(value, new Set(), { remaining: MAX_SCALAR_EXPANSION });
  if (scalar !== NOT_SCALAR) define(variables.vars, name, scalar);
  // Arrays also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !(value instanceof PhpArray)) return;
  const node = displayNodeOf(value, new Set(), { remaining: MAX_DISPLAY_EXPANSION });
  if (node) define(variables.referenceVars, name, node);
}

const NOT_SCALAR = Symbol('notScalar');
type Scalar = TraceItemVariable[string];

function scalarOf(value: Value, seen: Set<object>, budget: { remaining: number }): Scalar | typeof NOT_SCALAR {
  if (budget.remaining-- <= 0) return NOT_SCALAR;
  // oxlint-disable-next-line unicorn/no-null -- The trace format shows null as null.
  if (value === null) return null;
  switch (typeof value) {
    case 'bigint': {
      return traceInt(value);
    }
    case 'number':
    case 'boolean': {
      return value;
    }
    case 'string': {
      return dec(value);
    }
  }
  if (
    !(value instanceof PhpArray) ||
    value.size > budget.remaining ||
    seen.size >= 256 ||
    seen.has(value) ||
    !value.isList()
  )
    return NOT_SCALAR;
  seen.add(value);
  const items: Scalar[] = [];
  for (const item of value.iterValues()) {
    const scalar = scalarOf(item, seen, budget);
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

// code-gauge-allow functionCognitiveComplexity 29 -- Each branch maps a PHP value shape to the shared trace display tree.
// code-gauge-allow functionNcss 40 -- Each branch maps a PHP value shape to the shared trace display tree.
function displayNodeOf(value: Value, seen: Set<object>, budget: { remaining: number }): DisplayNode | undefined {
  if (budget.remaining-- <= 0) return { kind: 'value', value: '…' };
  if (value === UNDEFINED_RESULT) return undefined;
  if (value === null) return NULL_NODE;
  if (typeof value === 'bigint') return { kind: 'value', value: traceInt(value) };
  if (typeof value === 'string') return { kind: 'value', value: dec(value) };
  if (typeof value !== 'object') return { kind: 'value', value };
  if (!isVariableValue(value) || seen.has(value)) return undefined;
  if (seen.size >= 256) return { kind: 'value', value: '…' };
  if (value instanceof PhpObject && value.turtle) {
    if (!value.turtle.isAlive) return undefined;
    return {
      kind: 'object',
      entries: { x: { kind: 'value', value: value.turtle.x }, y: { kind: 'value', value: value.turtle.y } },
    };
  }
  seen.add(value);
  try {
    const entries: Record<string, DisplayNode> = {};
    if (value instanceof PhpArray) {
      const isList = value.isList();
      for (const [key, item] of value.entries()) {
        define(entries, keyLabel(key, isList), displayNodeOf(item, seen, budget) ?? NULL_NODE);
        if (budget.remaining <= 0) break;
      }
      return { kind: isList ? 'array' : 'object', entries };
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
