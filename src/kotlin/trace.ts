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
import { UNSIGNED_ARRAYS } from './prelude/arrays';
import { type Frame, Runtime, UNASSIGNED } from './runtime';
import type { ClassSymbol, PropertySymbol } from './symbols';
import { type KType, resolved } from './types';
import { Boxed, Cell, indexedItems, KObject, type PrimitiveKind, type Value } from './values';

// code-gauge-allow duplicateLines -- the same trace setup as the other interpreters, adapted to Kotlin's values.
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
   * `this` as `this.x`, the program's top-level properties, and the properties of its objects as `Name.x`. A lambda's
   * steps also show the variables and `this` of the function that created it, as the JVM inlines `repeat` and `forEach`
   * bodies into that function; the lambda's own variables shadow them.
   */
  variablesOf(frame: Frame, withContext: boolean): TraceVariables {
    const { variables, shown } = this.frameVariables(frame);
    if (!withContext) return variables;
    const thisFrame = enclosingFrames(frame).find((each) => each.info.showsThis);
    if (thisFrame?.thisValue instanceof KObject) addThis(variables, thisFrame.thisValue);
    for (const global of this.program.globals) {
      if (shown.has(global.name) || global.isConstant) continue;
      addVariable(variables, global.name, this.runtime.globals[global.slot], global.type);
    }
    for (const object of this.program.objects) this.addObject(variables, object);
    return variables;
  }

  /**
   * The variables visible where a frame's statement runs, with the names they take: for each name the nearest
   * binding, looking from the frame through the frames enclosing a lambda, where a frame's own locals come before what
   * it captured and a captured variable before an enclosing frame's of the same name. Farther frames' variables come
   * first in the display.
   */
  private frameVariables(frame: Frame): { variables: TraceVariables; shown: Set<string> } {
    const shown = new Set<string>();
    const levels = enclosingFrames(frame).map((each) =>
      this.bindingsOf(each).filter(({ name }) => !shown.has(name) && shown.add(name))
    );
    const variables: TraceVariables = { vars: {}, referenceVars: {} };
    for (const { name, value, type } of levels.toReversed().flat()) addVariable(variables, name, value, type);
    return { variables, shown };
  }

  /**
   * A frame's assigned locals, where a later one of a name, declared in a nested block, shadows an earlier one, then
   * what it captured, by name.
   */
  private bindingsOf(frame: Frame): { name: string; value: Value; type: KType }[] {
    const locals = new Map<string, { name: string; value: Value; type: KType }>();
    // Only the entry point's frame, the first on the stack, receives the launcher's arguments; another `main` keeps its.
    const hidesArgs = this.program.mainTakesArgs && this.runtime.frames[0] === frame;
    for (const local of frame.info.locals) {
      const slot = frame.locals[local.slot];
      // `main`'s parameter only receives the launcher's arguments, which these programs never use.
      if (
        slot === UNASSIGNED ||
        (slot instanceof Cell && !slot.isAssigned) ||
        (hidesArgs && local.slot === 0) ||
        local.name.startsWith('\0')
      )
        continue;
      locals.set(local.name, {
        name: local.name,
        value: slot instanceof Cell ? slot.value : (slot as Value),
        type: local.type,
      });
    }
    const bindings = [...locals.values()];
    for (const capture of frame.info.captures) {
      const captured = frame.captured[capture.slot];
      if (captured instanceof Cell && !captured.isAssigned) continue;
      bindings.push({
        name: capture.name,
        value: captured instanceof Cell ? captured.value : (captured as Value),
        type: capture.type,
      });
    }
    return bindings;
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

function enclosingFrames(frame: Frame): Frame[] {
  const frames: Frame[] = [];
  for (let current: Frame | undefined = frame; current; current = current.enclosing) frames.push(current);
  return frames;
}

function addVariable(variables: TraceVariables, name: string, value: Value, type: KType): void {
  if (resolved(type).kind === 'function') return;
  if (value instanceof KObject && value.function) return;
  const scalar = typedScalar(value, type);
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  // Arrays also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !isArray(value)) return;
  const node = displayNodeOf(value, new Set());
  if (node) variables.referenceVars[name] = node;
}

/** The properties of the instance a method runs on, which Java's traces show as `this.x`. */
function addThis(variables: TraceVariables, self: KObject): void {
  for (const property of fieldsOf(self.cls)) {
    const value = self.fields[property.slot as number];
    const scalar = typedScalar(value, property.type as KType);
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

/** Whether the elements of an array of the type are values learners write, nested arrays included. */
function holdsScalars(type: KType): boolean {
  const actual = resolved(type);
  if (actual.kind !== 'class' || !actual.cls.isLibrary) return false;
  if (actual.cls.name !== 'Array') return ARRAY_CLASSES.has(actual.cls.name);
  const [argument] = actual.args;
  if (!argument || argument.variance === 'star') return false;
  const element = resolved(argument.type);
  if (element.kind !== 'class' || !element.cls.isLibrary) return false;
  const { boolean, string, primitives } = getLibrary().core;
  return element.cls === boolean || element.cls === string || primitives.has(element.cls) || holdsScalars(element);
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
  ...UNSIGNED_ARRAYS.map(([name]) => name),
]);

function isArray(value: Value): value is KObject {
  return value instanceof KObject && value.cls.isLibrary && ARRAY_CLASSES.has(value.cls.name);
}

/** The kind of the elements of a primitive array, whose elements are unboxed. */
function arrayElementKind(array: KObject): PrimitiveKind | undefined {
  const name = array.cls.name.replace('Array', '');
  return name === '' || name === 'Boolean' ? undefined : (name as PrimitiveKind);
}

// code-gauge-allow duplicateLines -- converts a primitive to a trace value, which differs from format.ts's conversion to text in every case.
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

function typedScalar(value: Value, type: KType): Scalar | typeof NOT_SCALAR {
  const kind = primitiveKindOf(type);
  if (kind && (typeof value === 'number' || typeof value === 'bigint')) return primitiveScalar(kind, value);
  if (isArray(value) && !holdsScalars(type)) return NOT_SCALAR;
  return scalarOf(value);
}

/** The value a learner writes for a variable: a number, a character, a string, a boolean, or an array of those. */
function scalarOf(value: Value, path?: Set<KObject>): Scalar | typeof NOT_SCALAR {
  if (typeof value === 'number' || typeof value === 'bigint') return NOT_SCALAR;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Boxed) return primitiveScalar(value.kind, value.value);
  if (!isArray(value) || path?.has(value)) return NOT_SCALAR;
  const active = path ?? new Set<KObject>();
  active.add(value);
  const kind = arrayElementKind(value);
  const scalars: Scalar[] = [];
  for (const item of value.items as Value[]) {
    // oxlint-disable-next-line unicorn/no-null -- The trace format shows Kotlin's null as null.
    const scalar = item === undefined ? null : arrayItemScalar(item, kind, active);
    if (scalar === NOT_SCALAR) {
      active.delete(value);
      return NOT_SCALAR;
    }
    scalars.push(scalar);
  }
  active.delete(value);
  return scalars as Scalar;
}

function arrayItemScalar(item: Value, kind: PrimitiveKind | undefined, path: Set<KObject>): Scalar | typeof NOT_SCALAR {
  return kind && (typeof item === 'number' || typeof item === 'bigint')
    ? primitiveScalar(kind, item)
    : scalarOf(item, path);
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
  if (value.builder !== undefined) return { kind: 'value', value: value.builder.text() };
  // An enum constant shows as its name, which is what learners write for it.
  const enumName = (value.native as { name?: unknown } | undefined)?.name;
  if (value.cls.kind === 'enum' && typeof enumName === 'string') return { kind: 'value', value: enumName };
  seen.add(value);
  const node = collectionNodeOf(value, seen) ?? { kind: 'object' as const, entries: objectEntriesOf(value, seen) };
  seen.delete(value);
  return node;
}

/** Lists, arrays, and sets show as arrays of their elements, and maps as objects keyed by their keys. */
function collectionNodeOf(object: KObject, seen: Set<unknown>): DisplayNode | undefined {
  const kind = isArray(object) ? arrayElementKind(object) : undefined;
  const items =
    indexedItems(object) ??
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
  // Keys are the learner's strings, so they must not reach Object.prototype's setters, as `__proto__` would.
  const entries = Object.create(null) as Record<string, DisplayNode>;
  for (const entry of object.store.ordered())
    entries[keyText(entry.key, seen)] = displayNodeOf(entry.value, seen) ?? NULL_NODE;
  return { kind: 'object', entries };
}

/**
 * The text a map's key shows as, which is what learners write for it, rendered with the objects being rendered around
 * it so that a key reaching its own map stops there.
 */
function keyText(key: Value, seen: ReadonlySet<unknown>): string {
  if (key === undefined) return 'null';
  const node = displayNodeOf(key, new Set(seen));
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
