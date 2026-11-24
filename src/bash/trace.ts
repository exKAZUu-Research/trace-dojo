import type { ProgramRecording } from '../interpreter/interpreter';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { ArithmeticError, ArithmeticStoreError, type ArithmeticTarget, evaluateArithmetic } from './arithmetic';
import { parseBash } from './parse';
import { runProgram } from './run';
import { type Frame, Runtime } from './runtime';
import { Shell } from './shell';
import { type Scope, sortedElements, type Variable, type VariableValue } from './variables';

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
    addVariable(shell, variables, variable.name, value);
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
 * visible scopes without executing side effects.
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
    if (split) return shownElementOf(shell, split.name, split.subscript, maxScope);
    const next = findOwnVariableIn(shell, ref, maxScope);
    if (!next || next === current) return undefined;
    current = next;
  }
  return undefined;
}

// code-gauge-allow functionCognitiveComplexity -- Chases chained namerefs and resolves associative, scalar, or pure-indexed elements.
function shownElementOf(shell: Shell, name: string, subscript: string, maxScope: number): VariableValue | undefined {
  let target: Variable | undefined = findOwnVariableIn(shell, name, maxScope);
  for (let depth = 0; depth < 8 && target?.attributes.has('n') && target.value?.kind === 'scalar'; depth++) {
    const ref = target.value.value;
    if (ref === '' || ref.includes('[')) return undefined;
    const next = findOwnVariableIn(shell, ref, maxScope);
    if (!next || next === target) return undefined;
    target = next;
  }
  const value = target?.value;
  if (!value) return undefined;
  if (subscript === '@' || subscript === '*') return value;
  if (value.kind === 'associative') {
    const element = value.table.get(subscript);
    return element === undefined ? undefined : { kind: 'scalar', value: element };
  }
  const index = pureSubscriptIndex(shell, value, subscript, maxScope);
  if (index === undefined) return undefined;
  if (value.kind === 'scalar') return index === 0n ? value : undefined;
  const element = value.elements.get(index);
  return element === undefined ? undefined : { kind: 'scalar', value: element };
}

function pureSubscriptIndex(
  shell: Shell,
  value: VariableValue,
  subscript: string,
  maxScope: number
): bigint | undefined {
  const overlay = new Map<string, string>();
  const evalPure = (expr: string): bigint | undefined => {
    try {
      return evaluateArithmetic(
        expr,
        {
          resolveTarget: (name, rawSubscript) => pureResolveTarget(shell, name, rawSubscript, maxScope, evalPure),
          readTarget: (target) => pureReadTarget(shell, target, maxScope, overlay),
          writeTarget: (target, written) => {
            if (target.kind === 'invalidElement') return false;
            overlay.set(pureTargetKey(target), written);
            return true;
          },
          reportError: () => {
            throw new PureReadAbort();
          },
        },
        undefined,
        () => shell.runtime.spend()
      );
    } catch (error) {
      if (error instanceof ArithmeticError || error instanceof ArithmeticStoreError || error instanceof PureReadAbort) {
        return undefined;
      }
      throw error;
    }
  };
  const raw = evalPure(subscript);
  if (raw === undefined) return undefined;
  if (raw >= 0n) return raw;
  const length = value.kind === 'indexed' ? shell.maxIndex(value.elements) + 1n : 1n;
  const resolved = length + raw;
  return resolved < 0n ? undefined : resolved;
}

function pureResolveTarget(
  shell: Shell,
  name: string,
  rawSubscript: string | undefined,
  maxScope: number,
  evalPure: (expr: string) => bigint | undefined
): ArithmeticTarget {
  if (rawSubscript === undefined) return { kind: 'scalar', name };
  if (rawSubscript === '') return { kind: 'invalidElement', raw: `${name}[]` };
  const variable = findOwnVariableIn(shell, name, maxScope);
  if (variable?.value?.kind === 'associative' || variable?.attributes.has('A')) {
    return { kind: 'associativeElement', name, key: rawSubscript };
  }
  const raw = evalPure(rawSubscript);
  if (raw === undefined) return { kind: 'invalidElement', raw: `${name}[${rawSubscript}]` };
  const length = variable?.value?.kind === 'indexed' ? shell.maxIndex(variable.value.elements) + 1n : 1n;
  const resolved = raw < 0n ? length + raw : raw;
  return resolved < 0n
    ? { kind: 'invalidElement', raw: `${name}[${rawSubscript}]` }
    : { kind: 'indexedElement', name, index: resolved };
}

function pureTargetKey(target: Exclude<ArithmeticTarget, { kind: 'invalidElement' }>): string {
  if (target.kind === 'scalar') return target.name;
  if (target.kind === 'associativeElement') return `${target.name}[${target.key}]`;
  return `${target.name}[${target.index}]`;
}

function pureReadTarget(
  shell: Shell,
  target: ArithmeticTarget,
  maxScope: number,
  overlay: ReadonlyMap<string, string>
): string | undefined {
  if (target.kind === 'invalidElement') return undefined;
  const shadowed = overlay.get(pureTargetKey(target));
  if (shadowed !== undefined) return shadowed;
  if (target.kind === 'associativeElement') {
    const element = shownElementOf(shell, target.name, target.key, maxScope);
    return element?.kind === 'scalar' ? element.value : undefined;
  }
  if (target.kind === 'indexedElement') {
    const element = shownElementOf(shell, target.name, String(target.index), maxScope);
    return element?.kind === 'scalar' ? element.value : undefined;
  }
  const variable = findOwnVariableIn(shell, target.name, maxScope);
  const val = variable
    ? shownValueOf(shell, { callRow: undefined, isAtomic: false, scopeIndex: maxScope }, variable)
    : undefined;
  if (!val) return undefined;
  if (val.kind === 'scalar') return val.value;
  if (val.kind === 'indexed') return val.elements.get(0n);
  return val.table.get('0');
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

// code-gauge-allow functionCognitiveComplexity -- One case per kind of value the trace shows: turtles, scalars, dense and sparse arrays, and structures.
function addVariable(shell: Shell, variables: TraceVariables, name: string, value: VariableValue | undefined): void {
  if (!value) return;
  if (value.kind === 'scalar') {
    const turtle = turtleNode(shell, value.value);
    if (turtle) define(variables.referenceVars, name, turtle);
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
