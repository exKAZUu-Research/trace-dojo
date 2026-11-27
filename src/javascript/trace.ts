import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import { NOT_SCALAR, type Scalar, scalarItems } from '../interpreter/traceScalars';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import type { Program } from './ast';
import { parseJavaScript } from './parse';
import type { CollectionState } from './realmCollections';
import { dateValueOf, inspectDate } from './realmDate';
import { runProgram } from './run';
import { Runtime } from './runtime';
import {
  type AccessorProperty,
  type Binding,
  type DataProperty,
  isAccessor,
  JsArray,
  JsFunction,
  JsObject,
  privateClassOf,
  privateNameOf,
  type Property,
  type Scope,
  UNINITIALIZED,
  type Value,
  valueOfElement,
} from './values';

export function traceJavaScriptProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  return recordProgram(parseJavaScript(program, trace), input);
}

/**
 * Runs a program parsed for tracing, recording its steps.
 *
 * @param showsStatics Shows the static fields of the program's classes after a step's variables, as Java does.
 */
export function recordProgram(parsed: Program, input?: ProgramInput, showsStatics = false): ProgramRecording {
  const runtime = new Runtime(input);
  const snapshotter = new Snapshotter(runtime, showsStatics);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.isAtomic,
    hidesCallRow: (frame) => frame.callee?.behavior.kind === 'user' && frame.callee.behavior.node.hidesCallRow === true,
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
  constructor(
    private readonly runtime: Runtime,
    private readonly showsStatics: boolean
  ) {}

  /** The variables visible from `scope`, followed by static fields and the fields of `this` when `withThis`. */
  variablesOf(scope: Scope, withThis: boolean): Variables {
    const variables: Variables = { vars: Object.create(null), referenceVars: Object.create(null) };
    for (const [name, value] of this.visibleBindings(scope)) addVariable(variables, name, value, this.runtime);
    if (withThis && this.showsStatics) this.addStatics(variables, scope);
    const frame = scope.nearestFunctionFrame();
    const thisValue = frame?.hasImplicitThis ? undefined : frame?.thisValue;
    if (withThis && thisValue instanceof JsObject && !(thisValue instanceof JsFunction))
      addThis(variables, thisValue, this.runtime);
    return variables;
  }

  /** The static fields of the classes the program declares at its top level, as `Class.field`. */
  private addStatics(variables: Variables, scope: Scope): void {
    let top: Scope | undefined = scope;
    while (top?.parent && top.parent !== this.runtime.realm.globals) top = top.parent;
    if (!top) return;
    for (const [className, cls] of classBindings(top)) {
      if (cls.behavior.kind !== 'class') continue;
      for (const [key, property] of displayedProperties(cls, this.runtime)) {
        const name = `${className}.${key}`;
        if (isAccessor(property)) variables.referenceVars[name] = accessorNode(property);
        else addVariable(variables, name, property.value, this.runtime);
      }
    }
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

function classBindings(scope: Scope): [string, JsFunction][] {
  const classes = new Map<JsFunction, string>();
  for (const [name, binding] of scope.bindings) {
    const value = binding.initializingClass ?? binding.value;
    if (!(value instanceof JsFunction) || value.behavior.kind !== 'class') continue;
    if (binding === value.behavior.traceBinding) classes.delete(value);
    if (!classes.has(value)) classes.set(value, name);
  }
  return [...classes].map(([value, name]) => [name, value]);
}

/** Functions and classes are not variables to learners, and neither is a `var` whose declaration has not run. */
function isVariable(binding: Binding): boolean {
  return binding.value !== UNINITIALIZED && !binding.isHoisted && !(binding.value instanceof JsFunction);
}

type Variables = TraceVariables;

function addVariable(variables: Variables, name: string, value: Value, runtime: Runtime): void {
  const scalar = traceScalarOf(value, runtime);
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  // Arrays also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !(value instanceof JsArray)) return;
  const node = displayNodeOf(value, new Set(), runtime);
  if (node) variables.referenceVars[name] = node;
}

function addThis(variables: Variables, self: JsObject, runtime: Runtime): void {
  for (const [key, property] of displayedProperties(self, runtime)) {
    if (isAccessor(property)) continue;
    const scalar = traceScalarOf(property.value, runtime);
    if (scalar !== NOT_SCALAR) variables.vars[`this.${key}`] = scalar;
  }
  const node = displayNodeOf(self, new Set(), runtime);
  if (node) variables.referenceVars.this = node;
}

function traceScalarOf(value: Value, runtime: Runtime): Scalar | typeof NOT_SCALAR {
  if (value instanceof JsObject && value.primitive !== undefined && displayedProperties(value, runtime).length > 0)
    return NOT_SCALAR;
  return scalarOf(value, new Set());
}

function scalarOf(value: Value, seen: Set<JsArray>): Scalar | typeof NOT_SCALAR {
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint' || typeof value === 'symbol') return displayedPrimitive(value);
  if (value instanceof JsObject && value.primitive !== undefined) return scalarOf(value.primitive, seen);
  if (!(value instanceof JsArray)) return NOT_SCALAR;
  for (const property of value.definedElements?.values() ?? []) if (isAccessor(property)) return NOT_SCALAR;
  return scalarItems(value, value.elements.map(valueOfElement), seen, (element) =>
    // oxlint-disable-next-line unicorn/no-null -- The trace format shows null and undefined as null.
    element === undefined || element === null ? null : scalarOf(element, seen)
  );
}

// oxlint-disable-next-line unicorn/no-null -- The trace format shows null and undefined as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

type DisplayEntry = [string, DisplayNode];

const BUILTIN_VALUE_LABEL = '[[PrimitiveValue]]';

function displayNodeOf(value: Value, seen: Set<JsObject>, runtime: Runtime): DisplayNode | undefined {
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
  seen.add(value);
  const node = containerNodeOf(value, seen, runtime);
  seen.delete(value);
  return node;
}

function containerNodeOf(value: JsObject, seen: Set<JsObject>, runtime: Runtime): DisplayNode {
  const fields = displayFieldsOf(value, seen, runtime);
  const builtin = scalarBuiltinNodeOf(value, seen, runtime);
  if (builtin) return fields.length === 0 ? builtin : containerNode('object', [[BUILTIN_VALUE_LABEL, builtin]], fields);
  if (value instanceof JsArray) return containerNode('array', arrayEntries(value, seen, runtime), fields);
  if (value.collection && !value.collection.isWeak) return collectionNodeOf(value.collection, fields, seen, runtime);
  return containerNode('object', [], fields);
}

function arrayEntries(value: JsArray, seen: Set<JsObject>, runtime: Runtime): DisplayEntry[] {
  return Array.from(value.elements.entries(), ([key, item]) => {
    const property = value.definedElements?.get(key);
    const node =
      property && isAccessor(property) ? accessorNode(property) : displayNodeOf(valueOfElement(item), seen, runtime);
    return [String(key), node ?? NULL_NODE];
  });
}

function displayFieldsOf(value: JsObject, seen: Set<JsObject>, runtime: Runtime): DisplayEntry[] {
  const entries: DisplayEntry[] = [];
  for (const [key, property] of displayedProperties(value, runtime)) {
    const node = isAccessor(property) ? accessorNode(property) : displayNodeOf(property.value, seen, runtime);
    if (node) entries.push([key, node]);
  }
  return entries;
}

function accessorNode(property: AccessorProperty): DisplayNode {
  if (!property.get && !property.set) return NULL_NODE;
  const label = property.get ? (property.set ? 'Getter/Setter' : 'Getter') : 'Setter';
  return { kind: 'value', value: `[${label}]`, verbatim: true };
}

function scalarBuiltinNodeOf(object: JsObject, seen: Set<JsObject>, runtime: Runtime): DisplayNode | undefined {
  if (object.primitive !== undefined) return displayNodeOf(object.primitive, seen, runtime);
  const time = dateValueOf(object);
  if (time !== undefined) return { kind: 'value', value: inspectDate(time), verbatim: true };
  if (object.regexp) return { kind: 'value', value: String(object.regexp), verbatim: true };
  return undefined;
}

function collectionNodeOf(
  collection: CollectionState,
  fields: DisplayEntry[],
  seen: Set<JsObject>,
  runtime: Runtime
): DisplayNode {
  const items = collection.entries.filter((entry) => entry !== undefined);
  const node = (value: Value): DisplayNode => displayNodeOf(value, seen, runtime) ?? NULL_NODE;
  if (collection.kind === 'Set')
    return containerNode(
      'array',
      items.map((entry, index) => [String(index), node(entry.key)]),
      fields
    );
  const keys = items.map((entry) => node(entry.key));
  const fieldNames = new Set(fields.map(([name]) => name));
  const texts = items.flatMap((entry, index) => {
    const key = keys[index];
    if (key.kind !== 'value' || entry.key instanceof JsObject) return [];
    const text = String(key.value);
    // Integer-like keys would be listed first in an object, out of the Map's order.
    return /^(?:0|[1-9]\d*)$/.test(text) || fieldNames.has(text) ? [] : [text];
  });
  if (texts.length === items.length && new Set(texts).size === texts.length) {
    return containerNode(
      'object',
      texts.map((text, index) => [text, node(items[index].value)]),
      fields
    );
  }
  const pairs = items.map((entry, index): DisplayEntry => [
    String(index),
    { kind: 'array', entries: { 0: keys[index], 1: node(entry.value) } },
  ]);
  return containerNode('array', pairs, fields);
}

function containerNode(kind: 'array' | 'object', contents: DisplayEntry[], fields: DisplayEntry[]): DisplayNode {
  if (fields.length === 0) return { kind, entries: Object.fromEntries(contents) };
  const entries = new Map(contents);
  const reserved = new Set(fields.map(([name]) => name));
  const suffixes = new Map<string, number>();
  for (const [name, value] of fields) {
    let label = name;
    if (entries.has(label)) {
      let suffix = suffixes.get(name) ?? 2;
      do {
        label = `${name} (${suffix++})`;
      } while (entries.has(label) || reserved.has(label));
      suffixes.set(name, suffix);
    }
    entries.set(label, value);
  }
  return { kind, entries: Object.fromEntries(entries) };
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

/** The fields learners see in an object: its own enumerable properties and private data fields. */
function displayedProperties(object: JsObject, runtime: Runtime): [string, Property][] {
  const entries: [string, Property][] = [];
  // Errors keep their message in a non-enumerable property.
  const message = object.isError ? object.properties.get('message') : undefined;
  if (message && !message.enumerable && !isAccessor(message) && traceField(runtime, message))
    entries.push(['message', message]);
  for (const [key, property] of object.properties) {
    if (typeof key === 'string' && property.enumerable && (isAccessor(property) || traceField(runtime, property)))
      entries.push([key, property]);
  }
  const fields = [...(object.privateMembers ?? [])].filter(
    ([, property]) => !isAccessor(property) && traceField(runtime, property)
  );
  const labels = privateLabels(fields.map(([key]) => key));
  for (const [index, [, property]] of fields.entries()) entries.push([labels[index], property]);
  return entries;
}

function traceField(runtime: Runtime, { value, hiddenTraceConstant }: DataProperty): boolean {
  return !hiddenTraceConstant && !(value instanceof JsFunction) && !runtime.isUnavailableValue(value);
}

function primitiveNode(value: bigint | symbol): DisplayNode {
  return typeof value === 'symbol'
    ? { kind: 'value', value: value.toString(), verbatim: true }
    : { kind: 'value', value: displayedPrimitive(value) };
}

/** A BigInt as the number it equals while that is exact, else itself; a symbol as its description text. */
function displayedPrimitive(value: bigint | symbol): number | bigint | string {
  if (typeof value === 'symbol') return value.toString();
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}
