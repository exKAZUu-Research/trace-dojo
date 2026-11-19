import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { TurtleState } from '../interpreter/turtleWorld';
import { floatToShortestDouble } from '../java/values';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import type { CompiledProgram } from './compiler';
import { runProgram } from './execute';
import { charToString } from './format';
import { compileKotlin, getLibrary, libraryExceptions } from './library';
import { parseKotlin } from './parse';
import { type Frame, Runtime, UNASSIGNED } from './runtime';
import type { ClassSymbol, PropertySymbol } from './symbols';
import { type KType, resolved } from './types';
import { Boxed, Cell, KObject, type PrimitiveKind, type Value } from './values';

// code-gauge-allow duplicateLines 17 -- the same trace setup as the other interpreters, adapted to Kotlin's values.
export function traceKotlinProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const compiled = compileKotlin(parseKotlin(program), {
    atomicRows: new Set(trace.atomicAnnotations.keys()),
    recordsSteps: true,
  });
  const runtime = new Runtime(libraryExceptions(), input);
  const snapshotter = new Snapshotter(runtime, compiled);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.info.isAtomic,
    variablesOf: (frame) => snapshotter.variablesOf(frame, true),
  });
  runtime.steps.recorder = recorder;
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

  /**
   * The variables a frame shows: its locals and what a lambda captured, then with `withContext` the properties of
   * `this` as `this.x`, the program's top-level properties, and the properties of its objects as `Name.x`.
   */
  // code-gauge-allow functionCognitiveComplexity 21 -- builds one snapshot of a frame, whose kinds of variables are listed side by side as Java's trace does.
  variablesOf(frame: Frame, withContext: boolean): TraceVariables {
    const variables: TraceVariables = { vars: {}, referenceVars: {} };
    const shown = new Set<string>();
    const hidesArgs = frame.info.name === this.program.main.name && this.program.mainTakesArgs;
    for (const local of frame.info.locals) {
      const slot = frame.locals[local.slot];
      // `main`'s parameter only receives the launcher's arguments, which these programs never use.
      if (slot === UNASSIGNED || (hidesArgs && local.slot === 0) || local.name.startsWith('\0')) continue;
      shown.add(local.name);
      addVariable(variables, local.name, slot instanceof Cell ? slot.value : (slot as Value), local.type);
    }
    for (const capture of frame.info.captures) {
      if (shown.has(capture.name)) continue;
      shown.add(capture.name);
      const captured = frame.captured[capture.slot];
      addVariable(
        variables,
        capture.name,
        captured instanceof Cell ? captured.value : (captured as Value),
        capture.type
      );
    }
    if (!withContext) return variables;
    if (frame.info.showsThis && frame.thisValue instanceof KObject) addThis(variables, frame.thisValue);
    for (const global of this.program.globals) {
      if (shown.has(global.name) || global.isConstant) continue;
      addVariable(variables, global.name, this.runtime.globals[global.slot], global.type);
    }
    for (const object of this.program.objects) this.addObject(variables, object);
    return variables;
  }

  /**
   * The properties of an object or companion object, which exist from the start for learners, as Java's static fields
   * do: before the object is created, they show the values their constant initializers give them.
   */
  private addObject(variables: TraceVariables, object: ClassSymbol): void {
    const instance = this.runtime.objects.get(object);
    const owner = object.kind === 'companion' && object.outer ? object.outer.name : object.name;
    for (const property of object.ownFields) {
      if (!property.isVar && property.constantInitializer !== undefined) continue;
      const value = instance ? instance.fields[property.slot as number] : property.constantInitializer;
      addVariable(variables, `${owner}.${property.name}`, value, property.type as KType);
    }
  }
}

function addVariable(variables: TraceVariables, name: string, value: Value, type: KType): void {
  if (resolved(type).kind === 'function') return;
  if (value instanceof KObject && value.function) return;
  // A variable of a primitive type holds its value unboxed, whose type tells what it is.
  const kind = primitiveKindOf(type);
  const scalar =
    kind && (typeof value === 'number' || typeof value === 'bigint') ? primitiveScalar(kind, value) : scalarOf(value);
  // An array shows as a value only when its type holds values learners write, as a Java `int[]` does and a
  // `Turtle[]` of nulls does not.
  if (scalar !== NOT_SCALAR && (!isArray(value) || holdsScalars(type))) variables.vars[name] = scalar;
  // Arrays also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !isArray(value)) return;
  const node = displayNodeOf(value, new Set());
  if (node) variables.referenceVars[name] = node;
}

/** The properties of the instance a method runs on, which Java's traces show as `this.x`. */
function addThis(variables: TraceVariables, self: KObject): void {
  for (const property of fieldsOf(self.cls)) {
    const value = self.fields[property.slot as number];
    const kind = primitiveKindOf(property.type as KType);
    const scalar =
      kind && (typeof value === 'number' || typeof value === 'bigint') ? primitiveScalar(kind, value) : scalarOf(value);
    if (scalar !== NOT_SCALAR) variables.vars[`this.${property.name}`] = scalar;
  }
  const node = displayNodeOf(self, new Set());
  if (node) variables.referenceVars.this = node;
}

/** The properties with backing fields of a class and its superclasses, the superclasses' first. */
function fieldsOf(cls: ClassSymbol): PropertySymbol[] {
  const inherited = cls.superclass ? fieldsOf(cls.superclass.cls) : [];
  return [...inherited, ...cls.ownFields];
}

/** The primitive kind a non-null primitive type holds its values as, unboxed. */
function primitiveKindOf(type: KType): PrimitiveKind | undefined {
  const actual = resolved(type);
  if (actual.kind !== 'class' || actual.nullable) return undefined;
  return getLibrary().core.primitives.get(actual.cls);
}

const SCALAR_CLASSES = new Set([
  'Int',
  'Long',
  'Short',
  'Byte',
  'Double',
  'Float',
  'Char',
  'Boolean',
  'String',
  'UInt',
  'ULong',
]);

/** Whether the elements of an array of the type are values learners write, nested arrays included. */
function holdsScalars(type: KType): boolean {
  const actual = resolved(type);
  if (actual.kind !== 'class' || !actual.cls.isLibrary) return false;
  if (actual.cls.name !== 'Array') return ARRAY_CLASSES.has(actual.cls.name);
  const [argument] = actual.args;
  if (!argument || argument.variance === 'star') return false;
  const element = resolved(argument.type);
  if (element.kind !== 'class' || !element.cls.isLibrary) return false;
  return SCALAR_CLASSES.has(element.cls.name) || holdsScalars(element);
}

const NOT_SCALAR = Symbol('notScalar');
type Scalar = TraceItemVariable[string];

const ARRAY_CLASSES = new Set([
  'Array',
  'IntArray',
  'LongArray',
  'DoubleArray',
  'FloatArray',
  'ShortArray',
  'ByteArray',
  'CharArray',
  'BooleanArray',
  'UIntArray',
]);

function isArray(value: Value): value is KObject {
  return value instanceof KObject && value.cls.isLibrary && ARRAY_CLASSES.has(value.cls.name);
}

/** The kind of the elements of a primitive array, whose elements are unboxed. */
function arrayElementKind(array: KObject): PrimitiveKind | undefined {
  const name = array.cls.name.replace('Array', '');
  return name === '' || name === 'Boolean' ? undefined : (name as PrimitiveKind);
}

// code-gauge-allow duplicateLines 15 -- converts a primitive to a trace value, which differs from format.ts's conversion to text in every case.
function primitiveScalar(kind: PrimitiveKind, value: number | bigint): Scalar {
  switch (kind) {
    case 'Long':
    case 'ULong': {
      return Number(value);
    }
    case 'Float': {
      return floatToShortestDouble(value as number);
    }
    case 'Char': {
      return charToString(value as number);
    }
    case 'UInt': {
      return (value as number) >>> 0;
    }
    default: {
      return value as number;
    }
  }
}

/** The value a learner writes for a variable: a number, a character, a string, a boolean, or an array of those. */
function scalarOf(value: Value): Scalar | typeof NOT_SCALAR {
  if (typeof value === 'number' || typeof value === 'bigint') return NOT_SCALAR;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Boxed) return primitiveScalar(value.kind, value.value);
  if (!isArray(value)) return NOT_SCALAR;
  const kind = arrayElementKind(value);
  const items = value.items as Value[];
  const scalars = items.map((item) => {
    if (kind && (typeof item === 'number' || typeof item === 'bigint')) return primitiveScalar(kind, item);
    // oxlint-disable-next-line unicorn/no-null -- The trace format shows Kotlin's null as null.
    return item === undefined ? null : scalarOf(item);
  });
  if (scalars.some((scalar) => scalar === NOT_SCALAR)) return NOT_SCALAR;
  return scalars as Scalar;
}

// oxlint-disable-next-line unicorn/no-null -- The trace format shows Kotlin's null as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

function displayNodeOf(value: Value, seen: Set<unknown>): DisplayNode | undefined {
  if (value === undefined) return NULL_NODE;
  if (typeof value === 'string' || typeof value === 'boolean') return { kind: 'value', value };
  if (typeof value === 'number' || typeof value === 'bigint') return { kind: 'value', value: Number(value) };
  if (value instanceof Boxed)
    return { kind: 'value', value: primitiveScalar(value.kind, value.value) as number | string };
  if (!(value instanceof KObject) || seen.has(value)) return undefined;
  if (value.turtle) return turtleNodeOf(value.turtle);
  if (value.builder !== undefined) return { kind: 'value', value: value.builder };
  // An enum constant shows as its name, which is what learners write for it.
  const enumName = (value.native as { name?: unknown } | undefined)?.name;
  if (value.cls.kind === 'enum' && typeof enumName === 'string') return { kind: 'value', value: enumName };
  seen.add(value);
  const node = collectionNodeOf(value, seen) ?? { kind: 'object' as const, entries: objectEntriesOf(value, seen) };
  seen.delete(value);
  return node;
}

/** Lists, arrays, and sets show as arrays of their elements, and maps as objects keyed by their keys. */
// code-gauge-allow duplicateLines 16 -- the same snapshot of objects as Java's trace, over Kotlin's objects.
function collectionNodeOf(object: KObject, seen: Set<unknown>): DisplayNode | undefined {
  const kind = isArray(object) ? arrayElementKind(object) : undefined;
  const items =
    object.items ??
    (object.store && object.native?.isSet ? object.store.ordered().map((entry) => entry.key) : undefined);
  if (items && !object.cls.name.endsWith('Iterator')) {
    const entries: Record<string, DisplayNode> = {};
    for (const [index, item] of items.entries()) {
      const shown = kind && typeof item !== 'object' ? new Boxed(kind, item as number) : item;
      entries[index] = displayNodeOf(shown, seen) ?? NULL_NODE;
    }
    return { kind: 'array', entries };
  }
  if (!object.store) return undefined;
  const entries: Record<string, DisplayNode> = {};
  for (const entry of object.store.ordered())
    entries[keyText(entry.key)] = displayNodeOf(entry.value, seen) ?? NULL_NODE;
  return { kind: 'object', entries };
}

/** The text a map's key shows as, which is what learners write for it. */
function keyText(key: Value): string {
  if (key === undefined) return 'null';
  const node = displayNodeOf(key, new Set());
  return node?.kind === 'value' ? String(node.value) : `#${(key as KObject).identity}`;
}

function turtleNodeOf(turtle: TurtleState): DisplayNode | undefined {
  if (!turtle.isAlive) return undefined;
  return { kind: 'object', entries: { x: { kind: 'value', value: turtle.x }, y: { kind: 'value', value: turtle.y } } };
}

function objectEntriesOf(object: KObject, seen: Set<unknown>): Record<string, DisplayNode> {
  const entries: Record<string, DisplayNode> = {};
  // A Throwable keeps its message outside the declared fields.
  const message = (object.native as { message?: unknown } | undefined)?.message;
  if (typeof message === 'string') entries.message = { kind: 'value', value: message };
  for (const property of fieldsOf(object.cls)) {
    const value = object.fields[property.slot as number];
    const kind = primitiveKindOf(property.type as KType);
    const node = displayNodeOf(
      kind && (typeof value === 'number' || typeof value === 'bigint') ? new Boxed(kind, value) : value,
      seen
    );
    if (node) entries[property.name] = node;
  }
  return entries;
}
