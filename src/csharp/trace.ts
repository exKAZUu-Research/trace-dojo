// oxlint-disable unicorn/prefer-code-point -- C# characters are UTF-16 code units, which code points would merge.
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { TurtleState } from '../interpreter/turtleWorld';
import type { DisplayNode, TraceItemVariable, TraceScalar } from '../problems/trace';
import { type CompiledProgram, compileProgram } from './compiler';
import { CsDecimal } from './decimal';
import { Evaluator } from './evaluator';
import { runProgram } from './execute';
import { formatFloat } from './format';
import type { EnumerableState } from './library/iteration';
import { enumText, exceptionMessage, isExceptionState } from './objects';
import { parseCSharp } from './parse';
import { type Frame, Runtime } from './runtime';
import {
  type ArrayType,
  baseTypeOf,
  type FieldSymbol,
  type NamedType,
  nullableUnderlying,
  substitute,
  substitutionOf,
  type Type,
} from './types';
import {
  Cell,
  CsArray,
  CsBox,
  CsDelegate,
  CsObject,
  CsString,
  CsStruct,
  isString,
  stringText,
  UNASSIGNED,
  type Value,
  type VariableReference,
} from './values';

// code-gauge-allow duplicateLines -- Each language wires its own runtime into the shared TraceRecorder alike.
export function traceCSharpProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const compiled = compileProgram(parseCSharp(program), { trace });
  const runtime = new Runtime(compiled.library, input);
  const evaluator = new Evaluator(runtime, compiled);
  evaluator.tracing = true;
  const snapshotter = new Snapshotter(runtime, compiled);
  // The trace keeps every step's snapshot, so a large array shown at each step adds up past what the run allocates:
  // each recorded item is charged once for all it stores.
  let remaining = LIMITS.maxCSharpTraceSize;
  const charge = (cost: number): void => {
    remaining -= cost;
    if (remaining < 0) throw new ExecutionLimitError('trace');
  };
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.method?.isAtomic === true,
    variablesOf: (frame) => guardedSnapshot(() => snapshotter.variablesOf(frame, true)),
    recordItem: (item) => {
      charge(item.board.length + NODE_COST * (item.callLines.length + item.turtles.length * 4 + 1));
      charge(traceCost(item.vars) + traceCost(item.referenceVars));
      return item;
    },
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  // A model program may end with an uncaught exception to show how one stops the program.
  const run = runProgram(evaluator, (frame) => {
    finalVars = guardedSnapshot(() => snapshotter.variablesOf(frame, false)).vars;
  });
  charge(traceCost(finalVars));
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

/**
 * Builds one snapshot under its own budget: an array shared by many rows expands into far more nodes than the run
 * allocates, so the snapshot must stop before it is built in full, ahead of the charge for what the trace stores.
 */
function guardedSnapshot<T>(build: () => T): T {
  // One snapshot gets the budget the C++ and Rust recorders give a whole trace, far more than a model program shows.
  let remaining = LIMITS.maxTraceSize;
  chargeSnapshot = (cost) => {
    remaining -= cost;
    if (remaining < 0) throw new ExecutionLimitError('trace');
  };
  try {
    return build();
  } finally {
    chargeSnapshot = undefined;
  }
}

/** The cost of trace data, in the units of {@link LIMITS.maxCSharpTraceSize}: its text, plus a node's cost per object. */
function traceCost(data: unknown): number {
  if (typeof data !== 'object' || data === null) return String(data).length;
  let cost = NODE_COST;
  for (const [key, child] of Object.entries(data)) cost += key.length + traceCost(child);
  return cost;
}

/** The cost of a node in the trace, as the C++ and Rust recorders count it. */
const NODE_COST = 32;

/** What building the current snapshot spends of its budget; set only while a snapshot is being built. */
let chargeSnapshot: ((cost: number) => void) | undefined;

/** A text a snapshot shows, charged by its length whatever the static type that shows it. */
function shownText(text: string): string {
  chargeSnapshot?.(text.length);
  return text;
}

class Snapshotter {
  constructor(
    private readonly runtime: Runtime,
    private readonly program: CompiledProgram
  ) {}

  /** The variables a frame shows: its locals in scope, then static fields and the fields of `this` when `withContext`. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  variablesOf(frame: Frame, withContext: boolean): TraceVariables {
    const variables: TraceVariables = { vars: {}, referenceVars: {} };
    const method = frame.method;
    if (method) {
      for (const local of method.locals) {
        if (local.owner !== method || local.isHidden || local.name.startsWith('<') || local.name.startsWith('\0'))
          continue;
        // The entry point's `args` only receives the launcher's arguments, which these programs never use.
        if (method === this.program.entry && local.isParameter) continue;
        const value = valueOfSlot(frame.slots[local.slot]);
        if (value === UNASSIGNED) continue;
        addVariable(variables, local.name, value, frame.resolve(local.type));
      }
    }
    if (!withContext) return variables;
    this.addStatics(variables);
    if (frame.thisValue instanceof CsObject || frame.thisValue instanceof CsStruct) addThis(variables, frame.thisValue);
    return variables;
  }

  /** Static fields exist from the start for learners, so a type not yet initialized shows its defaults. */
  private addStatics(variables: TraceVariables): void {
    for (const type of this.program.types) {
      if (type.typeParameters.length > 0) continue;
      for (const field of type.fields) {
        if (!field.isStatic || field.isConst || field.isEvent) continue;
        const name = field.property?.name ?? field.name;
        if (name.startsWith('<')) continue;
        const values = this.runtime.peekStatics(type.declaredType);
        const value = values
          ? values[field.slot]
          : (((field as { initialConstant?: unknown }).initialConstant as Value | undefined) ??
            this.runtime.evaluator.defaultOf(field.type));
        addVariable(variables, `${type.name}.${name}`, value, field.type);
      }
    }
  }
}

/** The value a local's slot holds: directly, in the cell of a captured local, or behind a `ref` parameter. */
function valueOfSlot(slot: Frame['slots'][number]): Value | typeof UNASSIGNED {
  if (slot instanceof Cell) return slot.value;
  if (isReference(slot)) return slot.get();
  return slot as Value | typeof UNASSIGNED;
}

function isReference(slot: unknown): slot is VariableReference {
  return (
    slot instanceof Object &&
    !(slot instanceof CsObject || slot instanceof CsStruct || slot instanceof CsArray || slot instanceof CsBox) &&
    typeof (slot as VariableReference).get === 'function'
  );
}

function addVariable(variables: TraceVariables, name: string, value: Value, type: Type): void {
  const scalar = scalarOf(value, type);
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  // Arrays also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !(value instanceof CsArray)) return;
  const node = displayNodeOf(value, type, new Set());
  if (node) variables.referenceVars[name] = node;
}

function addThis(variables: TraceVariables, self: CsObject | CsStruct): void {
  for (const [field, type] of instanceFields(self)) {
    const scalar = scalarOf(self.fields[field.slot], type);
    if (scalar !== NOT_SCALAR) variables.vars[`this.${field.property?.name ?? field.name}`] = scalar;
  }
  const node = displayNodeOf(self, self.type, new Set());
  if (node) variables.referenceVars.this = node;
}

/**
 * The instance fields of an object's type and its bases, with their types in the object's type arguments and
 * auto-properties' backing fields under their properties' names. The library's types show none, except tuples and
 * pairs, which hold the program's values in public fields.
 */
function instanceFields(self: CsObject | CsStruct): [FieldSymbol, Type][] {
  const fields: [FieldSymbol, Type][] = [];
  for (let type: NamedType | undefined = self.type; type; type = baseTypeOf(type)) {
    if (type.symbol.isLibrary && !SHOWN_LIBRARY_TYPES.has(type.symbol.special ?? type.symbol.metadataName)) break;
    const substitution = substitutionOf(type);
    const own = type.symbol.fields.filter(
      (field) =>
        !field.isStatic &&
        !(field.isPrimaryParameter && !field.property) &&
        (!field.name.startsWith('<') || field.property !== undefined)
    );
    fields.unshift(...own.map((field): [FieldSymbol, Type] => [field, substitute(field.type, substitution)]));
  }
  return fields;
}

const SHOWN_LIBRARY_TYPES = new Set(['valueTuple', 'KeyValuePair`2']);

const NOT_SCALAR = Symbol('notScalar');

// code-gauge-allow functionNcss -- One case per kind of type.
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
function scalarOf(value: Value, type: Type): TraceScalar | TraceItemVariable[string] | typeof NOT_SCALAR {
  const underlying = nullableUnderlying(type) ?? type;
  if (value instanceof CsBox) return scalarOf(value.value, value.type);
  // A null variable shows no value, as a null String in the Java interpreter's traces; arrays show null elements.
  if (value === undefined) return NOT_SCALAR;
  if (underlying.kind === 'array') {
    if (!(value instanceof CsArray) || !hasScalarElements(underlying)) return NOT_SCALAR;
    return byDimensions(
      value,
      (item) => {
        const scalar = scalarOf(item, underlying.element);
        // oxlint-disable-next-line unicorn/no-null -- The trace format shows C# null as null.
        return scalar === NOT_SCALAR ? null : scalar;
      },
      (items) => items
    ) as TraceItemVariable[string];
  }
  if (underlying.kind !== 'named') return NOT_SCALAR;
  if (underlying.symbol.kind === 'enum') return shownText(enumText(underlying, value));
  switch (underlying.symbol.special) {
    case 'bool': {
      return value as boolean;
    }
    case 'char': {
      return String.fromCharCode(value as number);
    }
    case 'string': {
      return shownText(stringText(value as string | CsString));
    }
    case 'long':
    case 'ulong': {
      const number = Number(value as bigint);
      return Number.isSafeInteger(number) ? number : (value as bigint);
    }
    case 'decimal': {
      return (value as CsDecimal).toDouble();
    }
    case 'sbyte':
    case 'byte':
    case 'short':
    case 'ushort':
    case 'int':
    case 'uint':
    case 'double': {
      return value as number;
    }
    case 'float': {
      // A float shows its own shortest digits, as .NET prints `1.1f` as 1.1, not the double it widens to.
      const number = value as number;
      return Number.isFinite(number) && number !== 0 ? Number(formatFloat(number, true)) : number;
    }
    case 'object': {
      return isString(value) ? shownText(stringText(value)) : NOT_SCALAR;
    }
    default: {
      return NOT_SCALAR;
    }
  }
}

/** An array's elements nested by its dimensions, as a rectangular array `int[2, 3]` shows two rows of three. */
function byDimensions<T>(array: CsArray, leaf: (item: Value) => T, nest: (items: T[]) => T): T {
  // The whole shape is charged before any of it is built: every row container, an empty dimension's included, and
  // every element, so no host array of the snapshot is allocated before its size is paid for.
  let containers = 0;
  let rows = 1;
  for (const length of array.lengths) {
    containers += rows;
    rows *= length;
  }
  chargeSnapshot?.(NODE_COST * (containers + array.values.length));
  const build = (dimension: number, offset: number): T => {
    const length = array.lengths[dimension];
    if (dimension === array.lengths.length - 1)
      return nest(array.values.slice(offset, offset + length).map((item) => leaf(item)));
    const stride = array.lengths.slice(dimension + 1).reduce((product, size) => product * size, 1);
    return nest(Array.from({ length }, (_unused, index) => build(dimension + 1, offset + index * stride)));
  };
  return build(0, 0);
}

function hasScalarElements(type: ArrayType): boolean {
  const element = nullableUnderlying(type.element) ?? type.element;
  if (element.kind === 'array') return hasScalarElements(element);
  if (element.kind !== 'named') return false;
  return (
    element.symbol.kind === 'enum' ||
    (element.symbol.special !== undefined &&
      ![
        'object',
        'valueType',
        'exception',
        'array',
        'delegate',
        'multicastDelegate',
        'enum',
        'nullable',
        'valueTuple',
      ].includes(element.symbol.special))
  );
}

// oxlint-disable-next-line unicorn/no-null -- The trace format shows C# null as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

// code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
function displayNodeOf(value: Value, type: Type, seen: Set<unknown>): DisplayNode | undefined {
  chargeSnapshot?.(NODE_COST);
  if (value === undefined) return NULL_NODE;
  const scalar = scalarOf(value, type);
  if (scalar !== NOT_SCALAR && !Array.isArray(scalar)) return { kind: 'value', value: scalar as TraceScalar };
  if (typeof value !== 'object' || value instanceof CsDecimal || value instanceof CsString)
    return { kind: 'value', value: shownText(String(value)) };
  if (seen.has(value)) return undefined;
  if (value instanceof CsObject && value.turtle) return turtleNodeOf(value.turtle);
  // A delegate shows as the Java interpreter shows a lambda: an object without fields.
  if (value instanceof CsDelegate) return { kind: 'object', entries: {} };
  seen.add(value);
  try {
    if (value instanceof CsArray) {
      return byDimensions<DisplayNode>(
        value,
        (item) => displayNodeOf(item, value.type.element, seen) ?? NULL_NODE,
        (items) => ({ kind: 'array', entries: Object.fromEntries(items.entries()) })
      );
    }
    if (value instanceof CsBox) return displayNodeOf(value.value, value.type, seen);
    const collection = collectionNodeOf(value, seen);
    if (collection) return collection;
    const entries: Record<string, DisplayNode> = {};
    // An exception keeps its message in the library's state rather than in a field, as Java's Throwable does.
    if (value instanceof CsObject && isExceptionState(value.native))
      entries.Message = { kind: 'value', value: shownText(exceptionMessage(value)) };
    for (const [field, fieldType] of instanceFields(value)) {
      const node = displayNodeOf(value.fields[field.slot], fieldType, seen);
      if (node) entries[field.property?.name ?? field.name] = node;
    }
    return { kind: 'object', entries };
  } finally {
    seen.delete(value);
  }
}

/** Lists, sets, and queues show as arrays of their elements, and dictionaries as objects keyed by their keys. */
function collectionNodeOf(value: CsObject | CsStruct, seen: Set<unknown>): DisplayNode | undefined {
  const native = value.native as EnumerableState | undefined;
  const shown = native && typeof native.display === 'function' ? native.display() : undefined;
  if (!shown) return undefined;
  // The keys are the program's, so they become own properties, which a key such as `__proto__` stays as.
  const entries: Record<string, DisplayNode> = Object.fromEntries(
    shown.items.map(([key, item, type]) => [key, displayNodeOf(item, type, seen) ?? NULL_NODE])
  );
  return { kind: shown.kind, entries };
}

function turtleNodeOf(turtle: TurtleState): DisplayNode | undefined {
  if (!turtle.isAlive) return undefined;
  return { kind: 'object', entries: { x: { kind: 'value', value: turtle.x }, y: { kind: 'value', value: turtle.y } } };
}
