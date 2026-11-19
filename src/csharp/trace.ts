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
import { enumText } from './objects';
import { parseCSharp } from './parse';
import { type Frame, type NativeState, Runtime } from './runtime';
import { type ArrayType, type FieldSymbol, type NamedType, nullableUnderlying, type Type } from './types';
import { Cell, CsArray, CsBox, CsDelegate, CsObject, CsStruct, UNASSIGNED, type Value } from './values';

// code-gauge-allow duplicateLines 15 -- Each language wires its own runtime into the shared TraceRecorder alike.
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
        const slot = frame.slots[local.slot];
        if (slot === UNASSIGNED) continue;
        const value = slot instanceof Cell ? slot.value : slot;
        if (value === UNASSIGNED) continue;
        if (
          typeof slot === 'object' &&
          slot !== undefined &&
          'get' in slot &&
          typeof (slot as { get: unknown }).get === 'function' &&
          !(slot instanceof CsObject)
        ) {
          addVariable(variables, local.name, (slot as { get(): Value }).get(), local.type);
          continue;
        }
        addVariable(variables, local.name, value as Value, frame.resolve(local.type));
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

function addVariable(variables: TraceVariables, name: string, value: Value, type: Type): void {
  const scalar = scalarOf(value, type);
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  // Arrays also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !(value instanceof CsArray)) return;
  const node = displayNodeOf(value, type, new Set());
  if (node) variables.referenceVars[name] = node;
}

function addThis(variables: TraceVariables, self: CsObject | CsStruct): void {
  for (const field of instanceFields(self)) {
    const scalar = scalarOf(self.fields[field.slot], field.type);
    if (scalar !== NOT_SCALAR) variables.vars[`this.${field.property?.name ?? field.name}`] = scalar;
  }
  const node = displayNodeOf(self, self.type, new Set());
  if (node) variables.referenceVars.this = node;
}

/** The instance fields of an object's type and its bases, with auto-properties' backing fields under their properties' names. */
function instanceFields(self: CsObject | CsStruct): FieldSymbol[] {
  const fields: FieldSymbol[] = [];
  for (let type: NamedType | undefined = self.type; type; type = type.symbol.baseType) {
    if (type.symbol.isLibrary) break;
    fields.unshift(
      ...type.symbol.fields.filter(
        (field) =>
          (!field.isStatic && !field.isConst && !field.name.startsWith('<')) ||
          (field.property !== undefined && !field.isStatic)
      )
    );
  }
  return fields.filter(
    (field, index) =>
      fields.indexOf(field) === index && !field.isStatic && !(field.isPrimaryParameter && !field.property)
  );
}

const NOT_SCALAR = Symbol('notScalar');

// code-gauge-allow functionNcss 40 -- One case per kind of type.
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
    for (const field of instanceFields(value)) {
      const node = displayNodeOf(value.fields[field.slot], field.type, seen);
      if (node) entries[field.property?.name ?? field.name] = node;
    }
    return { kind: 'object', entries };
  } finally {
    seen.delete(value);
  }
}

/** Lists, sets, and queues show as arrays of their elements, and dictionaries as objects keyed by their keys. */
function collectionNodeOf(value: CsObject | CsStruct, seen: Set<unknown>): DisplayNode | undefined {
  const native = value.native as
    | (NativeState & { display?(): { kind: 'array' | 'object'; items: [string, Value][] } })
    | undefined;
  if (!native || typeof native.display !== 'function') return undefined;
  const { kind, items } = native.display();
  const entries: Record<string, DisplayNode> = {};
  for (const [key, item] of items) entries[key] = displayNodeOf(item, elementTypeOf(item), seen) ?? NULL_NODE;
  return { kind, entries };
}

/** The type that a collection element shows by, which only its value tells. */
function elementTypeOf(value: Value): Type {
  return { kind: 'null' } as Type & { kind: 'null' } as Type;
  void value;
}

function turtleNodeOf(turtle: TurtleState): DisplayNode | undefined {
  if (!turtle.isAlive) return undefined;
  return { kind: 'object', entries: { x: { kind: 'value', value: turtle.x }, y: { kind: 'value', value: turtle.y } } };
}
