import { findJavaTraceAnnotations } from '../problems/fillInBlank/javaSource';
import type { DisplayNode, TraceItem, TraceItemVariable, TurtleTrace } from '../problems/trace';
import { type CompiledProgram, compileProgram } from './compiler';
import { parseJava } from './parse';
import { ExecutionLimitError, Frame, JavaThrow, Runtime, type RuntimeLimits, UNASSIGNED } from './runtime';
import type { JavaType } from './types';
import { charToString, defaultValue, JavaArray, JavaObject, JavaString, type TurtleState, type Value } from './values';

export interface JavaTrace {
  /** The program without its `// step` and `// caller` annotations. */
  displayProgram: string;
  traceItems: TraceItem[];
  sidToLineIndex: Map<number, number>;
  callerIdToLineIndex: Map<number, number>;
  finalVars: TraceItemVariable;
  finalBoard: string;
  finalTurtles: TurtleTrace[];
}

/** Model programs are trusted but must not hang the server through an accidental unbounded loop. */
const TRACE_LIMITS: RuntimeLimits = {
  maxOperations: 1_000_000,
  maxCallDepth: 512,
  maxArrayElements: 1_000_000,
  maxOutputLength: 100_000,
};
const MAX_TRACE_ITEMS = 10_000;

interface Annotations {
  /** The program without its annotations and the blanks before them. */
  program: string;
  stepIdByRow: Map<number, number>;
  callerIdByRow: Map<number, number>;
}

/**
 * Reads `// step` and `// caller` comments, which number the rows a trace item or a call refers to. A step's ID
 * counts up from the previous one unless written as `// step: n`.
 */
function readAnnotations(source: string): Annotations {
  const stepIdByRow = new Map<number, number>();
  const callerIdByRow = new Map<number, number>();
  let lastStepId = 0;
  let lastCallerId = 0;
  let program = '';
  let copied = 0;
  for (const { index, text } of findJavaTraceAnnotations(source)) {
    const row = source.slice(0, index).split('\n').length - 1;
    for (const [, kind, id] of text.matchAll(/(step|caller)(?:[ \t]*:[ \t]*(\d+))?/g)) {
      if (kind === 'step') {
        lastStepId = id ? Number(id) : lastStepId + 1;
        stepIdByRow.set(row, lastStepId);
      } else {
        lastCallerId++;
        callerIdByRow.set(row, lastCallerId);
      }
    }
    program += source.slice(copied, index).replace(/[ \t]+$/, '');
    copied = index + text.length;
  }
  program += source.slice(copied);
  return { program, stepIdByRow, callerIdByRow };
}

/**
 * Runs a model program and records the state after every statement on a `// step` row.
 *
 * @param program The program to run, with every blank filled in.
 * @param displayProgram The program shown to learners, whose blanks may be placeholders on the same rows.
 */
export function traceJavaProgram(program: string, displayProgram: string): JavaTrace {
  const executed = readAnnotations(program);
  const displayed = readAnnotations(displayProgram);
  const compiled = compileProgram(parseJava(program), { stepIdByRow: executed.stepIdByRow });
  const runtime = new Runtime(compiled.builtins, TRACE_LIMITS);
  const snapshotter = new Snapshotter(runtime, compiled, executed.callerIdByRow);
  const traceItems: TraceItem[] = [snapshotter.initialItem()];
  runtime.onStep = (stepId) => {
    if (traceItems.length >= MAX_TRACE_ITEMS) throw new ExecutionLimitError('trace');
    traceItems.push(snapshotter.snapshot(stepId));
  };
  let finalVars: TraceItemVariable = {};
  let finalTurtles: TurtleTrace[] = [];
  runtime.onExit = (frame) => {
    if (frame.method !== compiled.mainMethod || runtime.frames.length !== 1) return;
    finalVars = snapshotter.variablesOf(frame, false).vars;
    // Collecting while main's frame still exists keeps the turtles its variables hold.
    runtime.collectGarbage();
    finalTurtles = turtlesOf(runtime);
  };
  // A model program may end with an uncaught exception to show how one stops the program.
  runMain(runtime, compiled);
  return {
    displayProgram: displayed.program,
    traceItems,
    sidToLineIndex: new Map([...displayed.stepIdByRow].map(([row, id]) => [id, row + 1])),
    callerIdToLineIndex: new Map([...displayed.callerIdByRow].map(([row, id]) => [id, row + 1])),
    finalVars,
    finalBoard: boardText(runtime),
    finalTurtles,
  };
}

/** Runs `main` and returns the uncaught exception's `toString()`, if any. */
export function runMain(runtime: Runtime, program: CompiledProgram): string | undefined {
  const root = new Frame(runtime, undefined, [], undefined, undefined);
  try {
    runtime.initializeClass(root, program.entryClass);
    const args = new JavaArray(program.builtins.stringClass.type, []);
    runtime.invoke(root, program.mainMethod, undefined, [args], undefined);
    return undefined;
  } catch (error) {
    if (!(error instanceof JavaThrow)) throw error;
    return runtime.invokeToString(root, error.value)?.value ?? error.value.cls.name;
  }
}

class Snapshotter {
  constructor(
    private readonly runtime: Runtime,
    private readonly program: CompiledProgram,
    private readonly callerIdByRow: Map<number, number>
  ) {}

  initialItem(): TraceItem {
    return {
      depth: 0,
      sid: 0,
      callStack: [],
      vars: {},
      referenceVars: {},
      turtles: [],
      board: boardText(this.runtime),
    };
  }

  snapshot(stepId: number): TraceItem {
    this.runtime.collectGarbage();
    const { frames } = this.runtime;
    const frame = frames.at(-1) as Frame;
    const { vars, referenceVars } = this.variablesOf(frame, true);
    // Frames without a call row (implicit super() calls and class initialization) are part of their caller's step.
    const calls = frames.slice(1).filter((callee) => callee.callRow !== undefined);
    return {
      depth: calls.length,
      sid: stepId,
      callStack: calls.map((callee) => this.callerIdByRow.get(callee.callRow as number) ?? 0),
      vars,
      referenceVars,
      turtles: turtlesOf(this.runtime),
      board: boardText(this.runtime),
    };
  }

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

interface Variables {
  vars: TraceItemVariable;
  referenceVars: Record<string, DisplayNode>;
}

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

function boardText(runtime: Runtime): string {
  return runtime.world.board.map((row) => row.join('')).join('\n');
}

function turtlesOf(runtime: Runtime): TurtleTrace[] {
  return runtime.turtleStates().map(({ color, dir, x, y }) => ({ x, y, color, dir }));
}
