import type { ProgramRecording } from '../interpreter/interpreter';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { parseBash } from './parse';
import { runProgram } from './run';
import { DiscardSignal, ExitSignal, type Frame, ObservationAbortError, Runtime } from './runtime';
import { type OutputTarget, Shell } from './shell';
import { TurtleError } from './turtle';
import { UnsupportedFeatureError } from './unsupported';
import {
  cloneDynamicAttributes,
  cloneScope,
  isIdentifier,
  popFuncname,
  type Scope,
  sortedElements,
  type Variable,
  type VariableValue,
} from './variables';

class PureReadAbort extends Error {}

// code-gauge-allow duplicateLines -- Each language's trace entry point wires its runtime into the shared recorder in the same way.
export function traceBashProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const parsed = parseBash(program, trace);
  const runtime = new Runtime(input);
  const shell = new Shell(runtime);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.isAtomic,
    variablesOf: (frame) => variablesOf(shell, frame),
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  // A model program may end with a turtle's error to show how one stops the program.
  const run = runProgram(shell, parsed, (frame) => {
    finalVars = variablesOf(shell, frame).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

/**
 * The variables a frame shows: the ones its code can read by name, its own locals first and the globals last. A
 * variable holding a turtle's handle shows the turtle, and a name reference shows the variable it names.
 */
function variablesOf(shell: Shell, frame: Frame): TraceVariables {
  const variables: TraceVariables = { vars: {}, referenceVars: {} };
  for (const variable of visibleVariables(shell, frame)) {
    const { value, nullReference } = shownValueOf(shell, frame, variable);
    addVariable(shell, variables, variable.name, value, nullReference);
    // A function receives a structure through a name reference (`local -n this=$1`), as a Java method receives
    // `this`, so its fields show among the values learners answer, as Java shows `this.x`.
    if (variable.attributes.has('n') && value?.kind === 'associative') {
      for (const [key, element] of value.table.entries()) {
        if (!turtleNode(shell, element)) define(variables.vars, `${variable.name}[${key}]`, element);
      }
    }
  }
  return variables;
}

/** The variables a frame sees: its locals and its callers', then the globals, the innermost first. */
function visibleVariables(shell: Shell, frame: Frame): Variable[] {
  const scopes = shell.state.scopes.slice(0, frame.scopeIndex + 1);
  const seen = new Set<string>();
  const result: Variable[] = [];
  for (let i = scopes.length - 1; i >= 0; i--) {
    for (const variable of scopes[i].values()) {
      if (seen.has(variable.name)) continue;
      seen.add(variable.name);
      if ((!variable.isSystem || variable.userAssigned) && isIdentifier(variable.name) && variable.value) {
        result.push(variable);
      }
    }
  }
  return result.toSorted((a, b) => scopeRank(scopes, b) - scopeRank(scopes, a));
}

function scopeRank(scopes: Scope[], variable: Variable): number {
  for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].get(variable.name) === variable) return i;
  return -1;
}

/**
 * The value a variable shows in `frame`, resolving name references (including `arr[sub]` targets) within `frame`'s
 * visible scopes without mutating live shell state.
 */
function shownValueOf(
  shell: Shell,
  frame: Frame,
  variable: Variable
): { value: VariableValue | undefined; nullReference: boolean } {
  const maxScope = frame.scopeIndex;
  const visited = new Set<Variable>();
  let current: Variable | undefined = variable;
  for (let depth = 0; depth < 16 && current; depth++) {
    if (!current.attributes.has('n') || current.value?.kind !== 'scalar') {
      return { value: current.value, nullReference: current.nullReference === true };
    }
    if (visited.has(current)) return { value: undefined, nullReference: false };
    visited.add(current);
    const ref = current.value.value;
    if (ref === '') return { value: current.value, nullReference: false };
    const direct = findOwnVariableIn(shell, ref, maxScope);
    if (direct) {
      current = direct;
      continue;
    }
    const split = shell.splitSubscript(ref);
    return split
      ? observeElement(shell, split.name, split.subscript, maxScope)
      : observeDynamicVariable(shell, ref, maxScope);
  }
  return { value: undefined, nullReference: false };
}

function observeDynamicVariable(
  shell: Shell,
  name: string,
  maxScope: number
): { value: VariableValue | undefined; nullReference: boolean } {
  const dynamic = withObservedScopes(shell, maxScope, () => shell.dynamicDeclaration(name));
  return { value: dynamic?.value, nullReference: false };
}

/** Evaluates `name[subscript]` against a discarded copy-on-write snapshot of `frame`'s visible scopes. */
// code-gauge-allow functionCognitiveComplexity -- Resolves chained namerefs, dynamic arrays, whole-array `@`/`*` subscripts, and isolated CoW element reads.
function observeElement(
  shell: Shell,
  name: string,
  subscript: string,
  maxScope: number
): { value: VariableValue | undefined; nullReference: boolean } {
  let targetName = name;
  let target: Variable | undefined = findOwnVariableIn(shell, name, maxScope);
  const visited = new Set<Variable>();
  for (let depth = 0; depth < 16 && target?.attributes.has('n') && target.value?.kind === 'scalar'; depth++) {
    if (visited.has(target)) return { value: undefined, nullReference: false };
    visited.add(target);
    const ref = target.value.value;
    if (ref === '' || ref.includes('[')) return { value: undefined, nullReference: false };
    targetName = ref;
    target = findOwnVariableIn(shell, ref, maxScope);
  }
  const effective = target?.value
    ? target
    : withObservedScopes(shell, maxScope, () => shell.dynamicDeclaration(targetName));
  if (!effective?.value) return { value: undefined, nullReference: false };
  const targetIsNullScalar = effective.value.kind === 'scalar' && effective.nullReference === true;
  if (subscript === '@' || subscript === '*') return { value: effective.value, nullReference: targetIsNullScalar };
  const observed = withObservedScopes(shell, maxScope, () => {
    const expanded = shell.expandDynamicSubscript(subscript);
    const normalized = expanded === '' && subscript !== '' && effective.value?.kind !== 'associative' ? '0' : expanded;
    return shell.elementValue(effective.name, normalized);
  });
  return observed === undefined
    ? { value: undefined, nullReference: false }
    : { value: { kind: 'scalar', value: observed }, nullReference: targetIsNullScalar };
}

function withObservedScopes<T>(shell: Shell, maxScope: number, run: () => T): T | undefined {
  const { runtime } = shell;
  const savedState = shell.state;
  const savedLastStored = shell.lastStored;
  const savedRow = shell.currentRow;
  const savedSlots = shell.slotCount;
  const savedObservation = runtime.beginObservation();
  const savedRecorder = runtime.steps.recorder;
  const savedFrameCount = runtime.frames.length;
  const silentAbort: OutputTarget = {
    write: () => {
      throw new PureReadAbort();
    },
  };
  const functionScopes = savedState.functionScopes.filter((idx) => idx <= maxScope);
  const funcname = new Map(savedState.funcname);
  for (let c = savedState.calls.length - 1; c >= functionScopes.length; c--) popFuncname(funcname);
  runtime.steps.recorder = undefined;
  shell.state = {
    ...savedState,
    scopes: savedState.scopes.slice(0, maxScope + 1).map((scope) => cloneScope(scope)),
    functionScopes,
    calls: savedState.calls.slice(0, functionScopes.length).map((call) => ({ ...call })),
    funcname,
    pipeStatus: new Map(savedState.pipeStatus),
    unsetDynamic: new Set(savedState.unsetDynamic),
    dynamicAttributes: cloneDynamicAttributes(savedState.dynamicAttributes),
    unsetEnv: new Set(savedState.unsetEnv),
    fd1: silentAbort,
    fd2: silentAbort,
  };
  try {
    return run();
  } catch (error) {
    if (
      error instanceof PureReadAbort ||
      error instanceof ObservationAbortError ||
      error instanceof TurtleError ||
      error instanceof DiscardSignal ||
      error instanceof ExitSignal ||
      error instanceof UnsupportedFeatureError
    ) {
      return undefined;
    }
    throw error;
  } finally {
    shell.state = savedState;
    shell.lastStored = savedLastStored;
    shell.currentRow = savedRow;
    shell.restoreSlots(savedSlots);
    runtime.endObservation(savedObservation);
    runtime.steps.recorder = savedRecorder;
    runtime.frames.length = savedFrameCount;
  }
}

function findOwnVariableIn(shell: Shell, name: string, maxScope: number): Variable | undefined {
  const { scopes } = shell.state;
  for (let i = Math.min(maxScope, scopes.length - 1); i >= 0; i--) {
    const variable = scopes[i].get(name);
    if (variable) return variable;
  }
  return undefined;
}

function define(record: object, name: string, value: unknown): void {
  Object.defineProperty(record, name, { value, enumerable: true, configurable: true, writable: true });
}

// oxlint-disable-next-line unicorn/no-null -- Trace format represents null references as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

// code-gauge-allow functionCognitiveComplexity -- One case per kind of value the trace shows: turtles, scalars, dense and sparse arrays, and structures.
function addVariable(
  shell: Shell,
  variables: TraceVariables,
  name: string,
  value: VariableValue | undefined,
  nullReference = false
): void {
  if (!value) return;
  if (value.kind === 'scalar') {
    const node = nullReference && value.value === '' ? NULL_NODE : turtleNode(shell, value.value);
    if (node) define(variables.referenceVars, name, node);
    else define(variables.vars, name, value.value);
    return;
  }
  const entries: Record<string, DisplayNode> = Object.create(null);
  if (value.kind === 'indexed') {
    const elements = sortedElements(value.elements);
    let isDense = true;
    for (const [index, [key, element]] of elements.entries()) {
      if (key !== BigInt(index)) isDense = false;
      const turtle = turtleNode(shell, element);
      if (turtle) isDense = false;
      define(entries, String(key), turtle ?? { kind: 'value', value: element });
    }
    // An array of strings without gaps also shows as a list, which learners can answer as one value.
    if (isDense)
      define(
        variables.vars,
        name,
        elements.map(([, element]) => element)
      );
    define(variables.referenceVars, name, { kind: 'array', entries });
    return;
  }
  for (const [key, element] of value.table.entries()) {
    define(entries, key, turtleNode(shell, element) ?? { kind: 'value', value: element });
  }
  define(variables.referenceVars, name, { kind: 'object', entries });
}

function turtleNode(shell: Shell, text: string): DisplayNode | undefined {
  const turtle = shell.runtime.turtleOf(text);
  if (!turtle) return undefined;
  return { kind: 'object', entries: { x: { kind: 'value', value: turtle.x }, y: { kind: 'value', value: turtle.y } } };
}
