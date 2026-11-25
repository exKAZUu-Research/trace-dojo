import type { ProgramRecording } from '../interpreter/interpreter';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { parseBash } from './parse';
import { runProgram } from './run';
import { type Frame, Runtime } from './runtime';
import { Shell } from './shell';
import { sortedElements, type VariableView } from './variables';

// code-gauge-allow duplicateLines -- Each language's trace entry point wires its runtime into the shared recorder in the same way.
export function traceBashProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const parsed = parseBash(program, trace);
  const runtime = new Runtime(input);
  const shell = new Shell(runtime);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.isAtomic,
    variablesOf: (frame) => variablesOf(runtime, frame),
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  const run = runProgram(shell, parsed, (frame) => {
    finalVars = variablesOf(runtime, frame).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

/**
 * Pure frame-bounded variable projection from `VariableStore`: reads stored cells without evaluating expressions,
 * detaching copy-on-write state, drawing `RANDOM`, or mutating external turtle devices.
 */
function variablesOf(runtime: Runtime, frame: Frame): TraceVariables {
  const { store } = frame;
  const variables: TraceVariables = { vars: {}, referenceVars: {} };
  for (const view of store.visibleViews(frame.scopeIndex)) {
    const resolved = store.resolveViewInFrame(view, frame.scopeIndex);
    if (!resolved || resolved.kind === 'unset') continue;
    addVariable(runtime, variables, view.name, resolved);
    if (view.attributes.has('n') && resolved.kind === 'associative') {
      for (const [key, element] of resolved.associative?.entries() ?? []) {
        if (!turtleNode(runtime, element)) define(variables.vars, `${view.name}[${key}]`, element);
      }
    }
  }
  return variables;
}

function define(record: object, name: string, value: unknown): void {
  Object.defineProperty(record, name, { value, enumerable: true, configurable: true, writable: true });
}

// oxlint-disable-next-line unicorn/no-null -- Trace format represents null references as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

// code-gauge-allow functionCognitiveComplexity -- Projects scalars, null references, turtles, dense/sparse arrays, and associative objects.
function addVariable(runtime: Runtime, variables: TraceVariables, name: string, view: VariableView): void {
  if (view.kind === 'unset') return;
  if (view.kind === 'scalar') {
    const text = view.scalar ?? '';
    const node = view.nullReference && text === '' ? NULL_NODE : turtleNode(runtime, text);
    if (node) define(variables.referenceVars, name, node);
    else define(variables.vars, name, text);
    return;
  }
  const entries: Record<string, DisplayNode> = Object.create(null);
  if (view.kind === 'indexed') {
    const elements = sortedElements(view.indexed as ReadonlyMap<bigint, string>);
    let isDense = true;
    for (const [index, [key, element]] of elements.entries()) {
      if (key !== BigInt(index)) isDense = false;
      const turtle = turtleNode(runtime, element);
      if (turtle) isDense = false;
      define(entries, String(key), turtle ?? { kind: 'value', value: element });
    }
    if (isDense) {
      define(
        variables.vars,
        name,
        elements.map(([, element]) => element)
      );
    }
    define(variables.referenceVars, name, { kind: 'array', entries });
    return;
  }
  for (const [key, element] of view.associative?.entries() ?? []) {
    define(entries, key, turtleNode(runtime, element) ?? { kind: 'value', value: element });
  }
  define(variables.referenceVars, name, { kind: 'object', entries });
}

function turtleNode(runtime: Runtime, text: string): DisplayNode | undefined {
  const turtle = runtime.turtleOf(text);
  if (!turtle) return undefined;
  return { kind: 'object', entries: { x: { kind: 'value', value: turtle.x }, y: { kind: 'value', value: turtle.y } } };
}
