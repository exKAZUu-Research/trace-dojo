import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { parseJavaScript } from './parse';
import { dateValueOf, inspectDate } from './realmDate';
import { runProgram } from './run';
import { Runtime } from './runtime';
import {
  type Binding,
  type DataProperty,
  isAccessor,
  JsArray,
  JsFunction,
  JsObject,
  privateClassOf,
  privateNameOf,
  type Scope,
  UNINITIALIZED,
  type Value,
  valueOfElement,
} from './values';

// code-gauge-allow duplicateLines 15 -- Each language wires its own runtime into the shared TraceRecorder alike.
export function traceJavaScriptProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const parsed = parseJavaScript(program, trace);
  const runtime = new Runtime(input);
  const snapshotter = new Snapshotter(runtime);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.isAtomic,
    variablesOf: (frame) => snapshotter.variablesOf(frame.scope, true),
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  // A model program may end with an uncaught exception to show how one stops the program.
  const run = runProgram(runtime, parsed, (scope) => {
    finalVars = snapshotter.variablesOf(scope, false).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

class Snapshotter {
  constructor(private readonly runtime: Runtime) {}

  /** The variables visible from `scope`, followed by the fields of `this` when `withThis`. */
  variablesOf(scope: Scope, withThis: boolean): Variables {
    const variables: Variables = { vars: {}, referenceVars: {} };
    for (const [name, value] of this.visibleBindings(scope)) addVariable(variables, name, value);
    const thisValue = scope.nearestFunctionFrame()?.thisValue;
    if (withThis && thisValue instanceof JsObject && !(thisValue instanceof JsFunction)) addThis(variables, thisValue);
    return variables;
  }

  /** The bindings that `scope` sees, ordered by function from the innermost, and by declaration within one. */
  private visibleBindings(scope: Scope): [string, Value][] {
    const seen = new Set<string>();
    const functions: [string, Value][][][] = [[]];
    for (
      let current: Scope | undefined = scope;
      current && current !== this.runtime.realm.globals;
      current = current.parent
    ) {
      const entries: [string, Value][] = [];
      for (const [name, binding] of current.bindings) {
        // `arguments` and private names are bindings the program never declared.
        if (!seen.has(name) && !name.startsWith('#') && name !== 'arguments' && isVariable(binding))
          entries.push([name, binding.value as Value]);
        seen.add(name);
      }
      (functions.at(-1) as [string, Value][][]).unshift(entries);
      if (current.isCallScope) functions.push([]);
    }
    return functions.flat(2 /* functions, then their scopes */);
  }
}

/** Functions and classes are not variables to learners, and neither is a `var` whose declaration has not run. */
function isVariable(binding: Binding): boolean {
  return binding.value !== UNINITIALIZED && !binding.isHoisted && !(binding.value instanceof JsFunction);
}

type Variables = TraceVariables;

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
  if (typeof value === 'bigint' || typeof value === 'symbol') return displayedPrimitive(value);
  if (!(value instanceof JsArray) || seen.has(value)) return NOT_SCALAR;
  seen.add(value);
  const items: Scalar[] = [];
  for (const element of value.elements.map(valueOfElement)) {
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

// code-gauge-allow functionCognitiveComplexity 19 -- One check per kind of value, as learners see each.
function displayNodeOf(value: Value, seen: Set<JsObject>): DisplayNode | undefined {
  if (value === undefined || value === null) return NULL_NODE;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')
    return { kind: 'value', value };
  if (typeof value === 'bigint' || typeof value === 'symbol') return primitiveNode(value);
  if (value instanceof JsFunction || seen.has(value)) return undefined;
  if (value.turtle) {
    if (!value.turtle.isAlive) return undefined;
    return {
      kind: 'object',
      entries: { x: { kind: 'value', value: value.turtle.x }, y: { kind: 'value', value: value.turtle.y } },
    };
  }
  const builtin = builtinNodeOf(value, seen);
  if (builtin) return builtin;
  seen.add(value);
  const entries: Record<string, DisplayNode> = {};
  for (const [key, item] of value instanceof JsArray
    ? value.elements.map(valueOfElement).entries()
    : displayedEntries(value)) {
    const node = displayNodeOf(item, seen);
    if (node) entries[key] = node;
    else if (value instanceof JsArray) entries[key] = NULL_NODE;
  }
  seen.delete(value);
  return { kind: value instanceof JsArray ? 'array' : 'object', entries };
}

/**
 * How a builtin object holding state of its own shows: a boxed primitive as its primitive, a Date or a RegExp as the
 * text console.log prints, a Set as an array of its values, and a Map as an object keyed by its keys' text, or as an
 * array of key-value pairs when keys are objects, integers, or show alike.
 */
function builtinNodeOf(object: JsObject, seen: Set<JsObject>): DisplayNode | undefined {
  if (object.primitive !== undefined) return displayNodeOf(object.primitive, seen);
  const time = dateValueOf(object);
  if (time !== undefined) return { kind: 'value', value: inspectDate(time), verbatim: true };
  if (object.regexp) return { kind: 'value', value: String(object.regexp), verbatim: true };
  const { collection } = object;
  if (!collection || collection.isWeak) return undefined;
  seen.add(object);
  const items = collection.entries.filter((entry) => entry !== undefined);
  const node = (value: Value): DisplayNode => displayNodeOf(value, seen) ?? NULL_NODE;
  let result: DisplayNode;
  if (collection.kind === 'Set') {
    result = { kind: 'array', entries: Object.fromEntries(items.map((entry, index) => [index, node(entry.key)])) };
  } else {
    const keys = items.map((entry) => node(entry.key));
    const texts = keys.map((key) => (key.kind === 'value' ? String(key.value) : undefined));
    // Integer-like keys would be listed first in an object, out of the Map's order.
    result =
      texts.every((text) => text !== undefined && !/^(?:0|[1-9]\d*)$/.test(text)) &&
      new Set(texts).size === texts.length
        ? {
            kind: 'object',
            entries: Object.fromEntries(items.map((entry, index) => [texts[index], node(entry.value)])),
          }
        : {
            kind: 'array',
            entries: Object.fromEntries(
              items.map((entry, index) => [
                index,
                { kind: 'array', entries: { 0: keys[index], 1: node(entry.value) } } satisfies DisplayNode,
              ])
            ),
          };
  }
  seen.delete(object);
  return result;
}

/**
 * Labels private fields by their names. A class and its subclass may each declare the same name, so a repeated name
 * gets its declaring class, and a repeated class name (as from a class factory) also gets its position.
 */
function privateLabels(keys: string[]): string[] {
  const names = keys.map((key) => privateNameOf(key));
  const qualified = keys.map((key, index) =>
    names.indexOf(names[index]) === names.lastIndexOf(names[index])
      ? names[index]
      : `${privateClassOf(key)}.${names[index]}`
  );
  return qualified.map((label, index) => {
    const count = qualified.filter((other) => other === label).length;
    return count === 1
      ? label
      : `${label} (${qualified.slice(0, index + 1).filter((other) => other === label).length})`;
  });
}

/** The fields learners see in an object: its own enumerable data properties and private fields. */
function displayedEntries(object: JsObject): [string, Value][] {
  const entries: [string, Value][] = [];
  // Errors keep their message in a non-enumerable property.
  const message = object.isError ? object.properties.get('message') : undefined;
  if (message && !isAccessor(message)) entries.push(['message', message.value]);
  for (const [key, property] of object.properties) {
    if (
      typeof key === 'string' &&
      property.enumerable &&
      !isAccessor(property) &&
      !(property.value instanceof JsFunction)
    )
      entries.push([key, property.value]);
  }
  const fields = [...(object.privateMembers ?? [])].filter(
    ([, property]) => !isAccessor(property) && !(property.value instanceof JsFunction)
  );
  const labels = privateLabels(fields.map(([key]) => key));
  for (const [index, [, property]] of fields.entries()) entries.push([labels[index], (property as DataProperty).value]);
  return entries;
}

function primitiveNode(value: bigint | symbol): DisplayNode {
  const displayed = displayedPrimitive(value);
  return typeof displayed === 'string'
    ? { kind: 'value', value: displayed, verbatim: true }
    : { kind: 'value', value: displayed };
}

/** A BigInt as the number it equals while that is exact, else its digits; a symbol as its description text. */
function displayedPrimitive(value: bigint | symbol): number | string {
  if (typeof value === 'symbol') return value.toString();
  return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
}
