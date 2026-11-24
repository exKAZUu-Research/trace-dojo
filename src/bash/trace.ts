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
import { cloneScope, type Scope, sortedElements, type Variable, type VariableValue } from './variables';

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
    const value = shownValueOf(shell, frame, variable);
    addVariable(shell, variables, variable.name, value, variable.nullReference === true);
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
      if (!variable.isSystem && variable.value) result.push(variable);
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
function shownValueOf(shell: Shell, frame: Frame, variable: Variable): VariableValue | undefined {
  if (!variable.attributes.has('n') || variable.value?.kind !== 'scalar') return variable.value;
  const maxScope = frame.scopeIndex;
  let current: Variable | undefined = variable;
  for (let depth = 0; depth < 8; depth++) {
    if (!current?.attributes.has('n') || current.value?.kind !== 'scalar') return current?.value;
    const ref = current.value.value;
    if (ref === '') return current.value;
    const split = shell.splitSubscript(ref);
    if (split) return observeElement(shell, split.name, split.subscript, maxScope);
    const next = findOwnVariableIn(shell, ref, maxScope);
    if (!next || next === current) return undefined;
    current = next;
  }
  return undefined;
}

/** Evaluates `name[subscript]` against a discarded copy-on-write snapshot of `frame`'s visible scopes. */
// code-gauge-allow functionCognitiveComplexity -- Resolves chained namerefs, whole-array `@`/`*` subscripts, and isolated CoW element reads.
// code-gauge-allow functionNcss -- Resolves chained namerefs and evaluates element subscripts against a discarded CoW ShellState.
function observeElement(shell: Shell, name: string, subscript: string, maxScope: number): VariableValue | undefined {
  let target: Variable | undefined = findOwnVariableIn(shell, name, maxScope);
  for (let depth = 0; depth < 8 && target?.attributes.has('n') && target.value?.kind === 'scalar'; depth++) {
    const ref = target.value.value;
    if (ref === '' || ref.includes('[')) return undefined;
    const next = findOwnVariableIn(shell, ref, maxScope);
    if (!next || next === target) return undefined;
    target = next;
  }
  if (!target?.value) return undefined;
  if (subscript === '@' || subscript === '*') return target.value;
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
  runtime.steps.recorder = undefined;
  shell.state = {
    ...savedState,
    scopes: savedState.scopes.slice(0, maxScope + 1).map((scope) => cloneScope(scope)),
    functionScopes: savedState.functionScopes.filter((idx) => idx <= maxScope),
    unsetDynamic: new Set(savedState.unsetDynamic),
    fd1: silentAbort,
    fd2: silentAbort,
  };
  try {
    const element = shell.elementValue(target.name, subscript);
    return element === undefined ? undefined : { kind: 'scalar', value: element };
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
