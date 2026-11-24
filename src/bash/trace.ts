import type { ProgramRecording } from '../interpreter/interpreter';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { parseBash } from './parse';
import { runProgram } from './run';
import { type Frame, Runtime } from './runtime';
import { Shell } from './shell';
import { sortedElements, type VariableValue } from './variables';

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
  for (const variable of shell.visibleVariables(frame)) {
    const value = shell.shownValueOf(frame, variable);
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
