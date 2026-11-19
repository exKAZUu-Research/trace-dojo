// oxlint-disable unicorn/prefer-code-point -- C# characters are UTF-16 code units, which code points would merge.
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
import type { EnumerableState } from './library/iteration';
import { enumText } from './objects';
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
  CsStruct,
  UNASSIGNED,
  type Value,
  type VariableReference,
} from './values';

// code-gauge-allow duplicateLines 16 -- Each language wires its own runtime into the shared TraceRecorder alike.
export function traceCSharpProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const compiled = compileProgram(parseCSharp(program), { trace });
  const runtime = new Runtime(compiled.library, input);
  const evaluator = new Evaluator(runtime, compiled);
  evaluator.tracing = true;
  const snapshotter = new Snapshotter(runtime, compiled);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.method?.isAtomic === true,
    variablesOf: (frame) => snapshotter.variablesOf(frame, true),
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  // A model program may end with an uncaught exception to show how one stops the program.
  const run = runProgram(evaluator, (frame) => {
    finalVars = snapshotter.variablesOf(frame, false).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

class Snapshotter {
  constructor(
    private readonly runtime: Runtime,
    private readonly program: CompiledProgram
  ) {}

  /** The variables a frame shows: its locals in scope, then static fields and the fields of `this` when `withContext`. */
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

// code-gauge-allow functionNcss 41 -- One case per kind of type.
function scalarOf(value: Value, type: Type): TraceScalar | TraceItemVariable[string] | typeof NOT_SCALAR {
  const underlying = nullableUnderlying(type) ?? type;
  if (value instanceof CsBox) return scalarOf(value.value, value.type);
  if (value === undefined) {
    // oxlint-disable-next-line unicorn/no-null -- The trace format shows C# null as null.
    return underlying.kind === 'named' &&
      (underlying.symbol.special === 'string' || nullableUnderlying(type) !== undefined)
      ? // oxlint-disable-next-line unicorn/no-null -- The trace format shows C# null as null.
        null
      : NOT_SCALAR;
  }
  if (underlying.kind === 'array') {
    if (!(value instanceof CsArray) || !hasScalarElements(underlying)) return NOT_SCALAR;
    return value.values.map((item) => {
      const scalar = scalarOf(item, underlying.element);
      // oxlint-disable-next-line unicorn/no-null -- The trace format shows C# null as null.
      return scalar === NOT_SCALAR ? null : scalar;
    }) as TraceItemVariable[string];
  }
  if (underlying.kind !== 'named') return NOT_SCALAR;
  if (underlying.symbol.kind === 'enum') return enumText(underlying, value);
  switch (underlying.symbol.special) {
    case 'bool': {
      return value as boolean;
    }
    case 'char': {
      return String.fromCharCode(value as number);
    }
    case 'string': {
      return value as string;
    }
    case 'long':
    case 'ulong': {
      return Number(value as bigint);
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
    case 'float':
    case 'double': {
      return value as number;
    }
    case 'object': {
      return typeof value === 'string' ? value : NOT_SCALAR;
    }
    default: {
      return NOT_SCALAR;
    }
  }
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

function displayNodeOf(value: Value, type: Type, seen: Set<unknown>): DisplayNode | undefined {
  if (value === undefined) return NULL_NODE;
  const scalar = scalarOf(value, type);
  if (scalar !== NOT_SCALAR && !Array.isArray(scalar)) return { kind: 'value', value: scalar as TraceScalar };
  if (typeof value !== 'object' || value instanceof CsDecimal) return { kind: 'value', value: String(value) };
  if (seen.has(value)) return undefined;
  if (value instanceof CsObject && value.turtle) return turtleNodeOf(value.turtle);
  if (value instanceof CsDelegate) return undefined;
  seen.add(value);
  try {
    if (value instanceof CsArray) {
      const entries: Record<string, DisplayNode> = {};
      for (const [index, item] of value.values.entries())
        entries[index] = displayNodeOf(item, value.type.element, seen) ?? NULL_NODE;
      return { kind: 'array', entries };
    }
    if (value instanceof CsBox) return displayNodeOf(value.value, value.type, seen);
    const collection = collectionNodeOf(value, seen);
    if (collection) return collection;
    const entries: Record<string, DisplayNode> = {};
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
  const entries: Record<string, DisplayNode> = {};
  for (const [key, item, type] of shown.items) {
    entries[key] = displayNodeOf(item, type, seen) ?? NULL_NODE;
  }
  return { kind: shown.kind, entries };
}

function turtleNodeOf(turtle: TurtleState): DisplayNode | undefined {
  if (!turtle.isAlive) return undefined;
  return { kind: 'object', entries: { x: { kind: 'value', value: turtle.x }, y: { kind: 'value', value: turtle.y } } };
}
