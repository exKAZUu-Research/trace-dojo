import type { ProgramRecording } from '../interpreter/program';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { TurtleState } from '../interpreter/turtleWorld';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { type CompiledProgram, compileProgram } from './compiler';
import { runProgram } from './execute';
import { parseJava } from './parse';
import { type Frame, Runtime, UNASSIGNED } from './runtime';
import type { JavaType } from './types';
import { charToString, defaultValue, JavaArray, JavaObject, JavaString, type Value } from './values';

// code-gauge-allow duplicateLines 23 -- Each language wires its own runtime into the shared TraceRecorder alike.
export function traceJavaProgram(program: string, atomicRows: ReadonlySet<number>): ProgramRecording {
  const compiled = compileProgram(parseJava(program), { trace: { atomicRows } });
  const runtime = new Runtime(compiled.builtins);
  const snapshotter = new Snapshotter(runtime, compiled);
  const recorder = new TraceRecorder(runtime.world);
  runtime.steps.onStep = (row) => {
    const { frames } = runtime;
    if (frames.some((frame) => frame.method?.isAtomic)) return false;
    runtime.collectGarbage();
    const variables = snapshotter.variablesOf(frames.at(-1) as Frame, true);
    recorder.record(
      row,
      frames.slice(1).map((frame) => frame.callRow),
      variables
    );
    return true;
  };
  let finalVars: TraceItemVariable = {};
  // A model program may end with an uncaught exception to show how one stops the program.
  const run = runProgram(runtime, compiled, (frame) => {
    finalVars = snapshotter.variablesOf(frame, false).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

class Snapshotter {
  constructor(
    private readonly runtime: Runtime,
    private readonly program: CompiledProgram
  ) {}

  /** The variables a frame shows: its locals, then static fields and the fields of `this` when `withContext`. */
  variablesOf(frame: Frame, withContext: boolean): Variables {
    const variables: Variables = { vars: {}, referenceVars: {} };
    const isMain = frame.method === this.program.mainMethod;
    for (const [slot, local] of frame.localInfos.entries()) {
      const value = frame.locals[slot];
      // `main`'s parameter only receives the launcher's arguments, which these programs never use.
      if (value === UNASSIGNED || (isMain && slot === 0)) continue;
      addVariable(variables, local.name, value, local.type);
    }
    if (!withContext) return variables;
    this.addStatics(variables);
    if (frame.thisObject) addThis(variables, frame.thisObject);
    return variables;
  }

  /** Static fields exist from the start for learners, so a class not yet initialized shows its defaults. */
  private addStatics(variables: Variables): void {
    for (const cls of this.program.classes) {
      const statics = this.runtime.staticValues.get(cls);
      for (const field of cls.staticFields) {
        // Constants never change, so they would only crowd the table learners fill in.
        if (this.program.constantOf(field) !== undefined) continue;
        const value = statics
          ? statics[field.slot]
          : (this.program.initialConstantOf(field) ?? defaultValue(field.type));
        addVariable(variables, `${cls.name}.${field.name}`, value, field.type);
      }
    }
  }
}

type Variables = TraceVariables;

function addVariable(variables: Variables, name: string, value: Value, type: JavaType): void {
  const scalar = scalarOf(value, type);
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  // Arrays also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !(value instanceof JavaArray)) return;
  const node = displayNodeOf(value, type, new Set());
  if (node) variables.referenceVars[name] = node;
}

function addThis(variables: Variables, self: JavaObject): void {
  for (const field of self.cls.instanceFields) {
    const scalar = scalarOf(self.fields[field.slot], field.type);
    if (scalar !== NOT_SCALAR) variables.vars[`this.${field.name}`] = scalar;
  }
  const node = displayNodeOf(self, self.cls.type, new Set());
  if (node) variables.referenceVars.this = node;
}

const NOT_SCALAR = Symbol('notScalar');
type Scalar = TraceItemVariable[string];

function scalarOf(value: Value, type: JavaType): Scalar | typeof NOT_SCALAR {
  switch (type.kind) {
    case 'int':
    case 'double': {
      return value as number;
    }
    case 'char': {
      return charToString(value as number);
    }
    case 'boolean': {
      return value as boolean;
    }
    case 'class': {
      if (value instanceof JavaString) return value.value;
      return NOT_SCALAR;
    }
    case 'array': {
      if (!(value instanceof JavaArray) || !hasScalarElements(type)) return NOT_SCALAR;
      const element = type.element;
      return value.values.map((item) => {
        const scalar = scalarOf(item, element);
        // oxlint-disable-next-line unicorn/no-null -- The trace format shows Java null as null.
        return scalar === NOT_SCALAR ? null : scalar;
      }) as Scalar;
    }
    default: {
      return NOT_SCALAR;
    }
  }
}

function hasScalarElements(type: JavaType): boolean {
  if (type.kind === 'array') return hasScalarElements(type.element);
  return type.kind !== 'class' || type.cls.name === 'String';
}

// oxlint-disable-next-line unicorn/no-null -- The trace format shows Java null as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

function displayNodeOf(value: Value, type: JavaType, seen: Set<unknown>): DisplayNode | undefined {
  if (value === undefined) return NULL_NODE;
  if (typeof value === 'number') return { kind: 'value', value: type.kind === 'char' ? charToString(value) : value };
  if (typeof value === 'boolean') return { kind: 'value', value };
  if (value instanceof JavaString) return { kind: 'value', value: value.value };
  if (seen.has(value)) return undefined;
  if (value instanceof JavaObject && value.turtle) return turtleNodeOf(value.turtle);
  seen.add(value);
  const node: DisplayNode =
    value instanceof JavaArray
      ? { kind: 'array', entries: arrayEntriesOf(value, seen) }
      : { kind: 'object', entries: objectEntriesOf(value, seen) };
  seen.delete(value);
  return node;
}

function turtleNodeOf(turtle: TurtleState): DisplayNode | undefined {
  if (!turtle.isAlive) return undefined;
  return {
    kind: 'object',
    entries: { x: { kind: 'value', value: turtle.x }, y: { kind: 'value', value: turtle.y } },
  };
}

function arrayEntriesOf(array: JavaArray, seen: Set<unknown>): Record<string, DisplayNode> {
  const entries: Record<string, DisplayNode> = {};
  for (const [index, item] of array.values.entries()) {
    entries[index] = displayNodeOf(item, array.elementType, seen) ?? NULL_NODE;
  }
  return entries;
}

function objectEntriesOf(object: JavaObject, seen: Set<unknown>): Record<string, DisplayNode> {
  const entries: Record<string, DisplayNode> = {};
  // Throwable keeps its message outside the declared fields.
  if (object.message) entries.message = { kind: 'value', value: object.message.value };
  for (const field of object.cls.instanceFields) {
    const node = displayNodeOf(object.fields[field.slot], field.type, seen);
    if (node) entries[field.name] = node;
  }
  return entries;
}
