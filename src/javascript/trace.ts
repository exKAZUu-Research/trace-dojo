import { ExecutionLimitError, MAX_TRACE_ITEMS } from '../interpreter/limits';
import type { ProgramRecording } from '../interpreter/program';
import type { Annotations } from '../interpreter/traceAnnotations';
import type { DisplayNode, TraceItem, TraceItemVariable } from '../problems/trace';
import { parseJavaScript } from './parse';
import { runProgram } from './run';
import { type Frame, Runtime } from './runtime';
import { isAccessor, JsArray, JsFunction, JsObject, type Scope, UNINITIALIZED, type Value } from './values';

export function traceJavaScriptProgram(program: string, annotations: Annotations): ProgramRecording {
  const parsed = parseJavaScript(program, annotations.stepIdByRow);
  const runtime = new Runtime();
  const snapshotter = new Snapshotter(runtime, annotations.callerIdByRow);
  const traceItems: TraceItem[] = [snapshotter.initialItem()];
  runtime.onStep = (stepId) => {
    if (traceItems.length >= MAX_TRACE_ITEMS) throw new ExecutionLimitError('trace');
    traceItems.push(snapshotter.snapshot(stepId));
  };
  let finalVars: TraceItemVariable = {};
  // A model program may end with an uncaught exception to show how one stops the program.
  const run = runProgram(runtime, parsed, (scope) => {
    finalVars = snapshotter.variablesOf(scope, false).vars;
  });
  return { traceItems, finalVars, ...run };
}

class Snapshotter {
  constructor(
    private readonly runtime: Runtime,
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
      board: this.runtime.world.boardText(),
    };
  }

  snapshot(stepId: number): TraceItem {
    this.runtime.collectGarbage();
    const { frames } = this.runtime;
    const frame = frames.at(-1) as Frame;
    const { vars, referenceVars } = this.variablesOf(frame.scope, true);
    // Frames without a call row (implicit calls such as getters and default constructors) are part of their caller's step.
    const calls = frames.slice(1).filter((callee) => callee.callRow !== undefined);
    return {
      depth: calls.length,
      sid: stepId,
      callStack: calls.map((callee) => this.callerIdByRow.get(callee.callRow as number) ?? 0),
      vars,
      referenceVars,
      turtles: this.runtime.world.turtleTraces(),
      board: this.runtime.world.boardText(),
    };
  }

  /**
   * The variables visible from `scope`: those of the running function in declaration order, then those of the
   * functions enclosing it, and the fields of `this` when `withThis`. Functions and classes are not variables to
   * learners, and neither is a `var` whose declaration has not run.
   */
  variablesOf(scope: Scope, withThis: boolean): Variables {
    const variables: Variables = { vars: {}, referenceVars: {} };
    const seen = new Set<string>();
    const segments: [string, Value][][][] = [[]];
    for (let current: Scope | undefined = scope; current && current !== this.runtime.realm.globals; current = current.parent) {
      const entries: [string, Value][] = [];
      for (const [name, binding] of current.bindings) {
        if (seen.has(name)) continue;
        seen.add(name);
        const { value } = binding;
        if (value === UNINITIALIZED || binding.isHoisted || value instanceof JsFunction) continue;
        entries.push([name, value]);
      }
      (segments.at(-1) as [string, Value][][]).unshift(entries);
      if (current.isCallScope) segments.push([]);
    }
    for (const segment of segments) {
      for (const entries of segment) for (const [name, value] of entries) addVariable(variables, name, value);
    }
    const thisValue = scope.nearestFunctionFrame()?.thisValue;
    if (withThis && thisValue instanceof JsObject && !(thisValue instanceof JsFunction)) addThis(variables, thisValue);
    return variables;
  }
}

interface Variables {
  vars: TraceItemVariable;
  referenceVars: Record<string, DisplayNode>;
}

function addVariable(variables: Variables, name: string, value: Value): void {
  const scalar = scalarOf(value, new Set());
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  // Arrays also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !(value instanceof JsArray)) return;
  const node = displayNodeOf(value, new Set());
  if (node) variables.referenceVars[name] = node;
}

function addThis(variables: Variables, self: JsObject): void {
  for (const [key, value] of displayedEntries(self)) {
    const scalar = scalarOf(value, new Set());
    if (scalar !== NOT_SCALAR) variables.vars[`this.${key}`] = scalar;
  }
  const node = displayNodeOf(self, new Set());
  if (node) variables.referenceVars.this = node;
}

const NOT_SCALAR = Symbol('notScalar');
type Scalar = TraceItemVariable[string];

function scalarOf(value: Value, seen: Set<JsArray>): Scalar | typeof NOT_SCALAR {
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (!(value instanceof JsArray) || seen.has(value)) return NOT_SCALAR;
  seen.add(value);
  const items: Scalar[] = [];
  for (const element of value.elements) {
    if (element === undefined || element === null) {
      // oxlint-disable-next-line unicorn/no-null -- The trace format shows null and undefined as null.
      items.push(null);
      continue;
    }
    const scalar = scalarOf(element, seen);
    if (scalar === NOT_SCALAR) return NOT_SCALAR;
    items.push(scalar);
  }
  seen.delete(value);
  return items as Scalar;
}

// oxlint-disable-next-line unicorn/no-null -- The trace format shows null and undefined as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

function displayNodeOf(value: Value, seen: Set<JsObject>): DisplayNode | undefined {
  if (value === undefined || value === null) return NULL_NODE;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return { kind: 'value', value };
  if (value instanceof JsFunction || seen.has(value)) return undefined;
  if (value.turtle) {
    if (!value.turtle.isAlive) return undefined;
    return {
      kind: 'object',
      entries: { x: { kind: 'value', value: value.turtle.x }, y: { kind: 'value', value: value.turtle.y } },
    };
  }
  seen.add(value);
  const entries: Record<string, DisplayNode> = {};
  for (const [key, item] of value instanceof JsArray ? value.elements.entries() : displayedEntries(value)) {
    const node = displayNodeOf(item, seen);
    if (node) entries[key] = node;
    else if (value instanceof JsArray) entries[key] = NULL_NODE;
  }
  seen.delete(value);
  return { kind: value instanceof JsArray ? 'array' : 'object', entries };
}

/** The fields learners see in an object: its own enumerable data properties and private fields. */
function displayedEntries(object: JsObject): [string, Value][] {
  const entries: [string, Value][] = [];
  // Errors keep their message in a non-enumerable property.
  const message = object.isError ? object.properties.get('message') : undefined;
  if (message && !isAccessor(message)) entries.push(['message', message.value]);
  for (const [key, property] of object.properties) {
    if (property.enumerable && !isAccessor(property) && !(property.value instanceof JsFunction)) entries.push([key, property.value]);
  }
  for (const [key, property] of object.privateMembers ?? []) {
    if (!isAccessor(property) && !(property.value instanceof JsFunction)) entries.push([key, property.value]);
  }
  return entries;
}
