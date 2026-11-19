import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import { type TurtleState, TurtleWorld } from '../interpreter/turtleWorld';
import type { Library } from './binderBase';
import type { Evaluator } from './evaluator';
import type { NativeCall } from './natives';
import { PendingException } from './numeric';
import {
  baseTypeOf,
  type FieldSymbol,
  type LocalSymbol,
  type MethodSymbol,
  type NamedType,
  namedType,
  sameType,
  substitute,
  substitutionOf,
  type Type,
  type TypeParameterSymbol,
  type TypeSymbol,
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

/** What a frame's slot holds: a value, a cell for a captured local, or a reference for a `ref` parameter. */
export type Slot = Value | Cell | VariableReference | typeof UNASSIGNED;

/** The state of a library object, which tells the garbage collector what it holds. */
export interface NativeState {
  references(): Iterable<Value>;
}

/** A C# exception in flight. */
export class CsThrow {
  constructor(readonly exception: CsObject) {}
}

/** Ends the program as `Environment.Exit` does, skipping finally blocks and catch clauses. */
export class ProgramExit {
  constructor(readonly code: number) {}
}

/** The state of a library exception object. */
export interface ExceptionState {
  message: string | undefined;
  inner: CsObject | undefined;
  paramName?: string | undefined;
  actualValue?: Value;
  /** Whether a `throw` threw the exception, after which `ToString()` would print a stack trace. */
  wasThrown: boolean;
  data?: undefined;
}

export class Frame {
  readonly slots: Slot[];
  /** The cells of the enclosing functions' locals that this function captured. */
  captured: Map<LocalSymbol, Cell> = new Map();
  /** Values a pending call or allocation holds outside any variable, which must keep their turtles alive. */
  readonly temporaries: Value[] = [];
  /** The current values of compound assignments' targets and of initialized objects, innermost last. */
  readonly operands: Value[] = [];

  constructor(
    readonly runtime: Runtime,
    readonly method: MethodSymbol | undefined,
    readonly thisValue: Value,
    /** The type arguments of a generic method, by type parameter, together with those of the method's type. */
    readonly typeEnvironment: Map<TypeParameterSymbol, Type>,
    /** The row of the call that created this frame. */
    readonly callRow: number | undefined,
    slotCount: number
  ) {
    this.slots = Array.from({ length: slotCount }, () => UNASSIGNED);
  }

  /** Substitutes the frame's type arguments into a type, as generic code needs at run time. */
  resolve(type: Type): Type {
    return this.typeEnvironment.size === 0 ? type : substitute(type, this.typeEnvironment);
  }
}

interface StaticStorage {
  values: Value[];
}

export class Runtime {
  readonly frames: Frame[] = [];
  readonly world = new TurtleWorld();
  readonly steps = new StepTracker();
  readonly budget = new ExecutionBudget();
  readonly io: ProgramIO;
  /** The static fields of each constructed type, keyed by the type's identity. */
  private readonly statics = new Map<string, StaticStorage>();
  private readonly initializing = new Set<string>();
  private readonly dispatchCache = new Map<MethodSymbol, Map<string, MethodSymbol>>();
  private allocatedSlots = 0;

  constructor(
    readonly library: Library,
    input?: ProgramInput
  ) {
    this.io = new ProgramIO(this.budget, input);
  }

  /** Set by the evaluator: runs a method's body, and the hooks the library calls back into the program with. */
  evaluator!: Evaluator;

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  /** Checks a string's length and charges for building it, or for the `written` characters an edit writes. */
  allocateString(length: number, written = length): void {
    if (length > LIMITS.maxStringLength)
      throw new PendingException(
        'System.OutOfMemoryException',
        "Exception of type 'System.OutOfMemoryException' was thrown."
      );
    this.spend(Math.ceil(written / 16));
  }

  /** Charges for array elements or object fields before they are allocated. */
  allocateSlots(count: number): void {
    this.allocatedSlots += count;
    this.spend(Math.ceil(count / 64));
    if (this.allocatedSlots > LIMITS.maxSlots)
      throw new PendingException(
        'System.OutOfMemoryException',
        "Exception of type 'System.OutOfMemoryException' was thrown."
      );
  }

  pushFrame(frame: Frame): void {
    this.spend();
    if (this.frames.length >= LIMITS.maxCallDepth) throw new StackOverflow();
    this.frames.push(frame);
  }

  popFrame(): void {
    const frame = this.frames.pop();
    if (frame?.method?.isAtomic) this.steps.completeAtomicCall();
    this.onExit?.(frame as Frame);
  }

  /** Called when a method returns or throws, while its frame still holds its locals. */
  onExit?: (frame: Frame) => void;

  /** The static fields of a type, initializing the type on first use as .NET does. */
  staticsOf(type: NamedType): Value[] {
    const key = typeKey(type);
    const existing = this.statics.get(key);
    if (existing) return existing.values;
    return this.initializeType(type, key).values;
  }

  /** The static fields of a type that has initialized, or undefined before its first use. */
  peekStatics(type: NamedType): Value[] | undefined {
    return this.statics.get(typeKey(type))?.values;
  }

  /** Runs a type's static constructor before the first use of a member, for types that declare one. */
  ensureInitialized(type: NamedType): void {
    if (!type.symbol.staticConstructor) return;
    this.staticsOf(type);
  }

  private initializeType(type: NamedType, key: string): StaticStorage {
    const symbol = type.symbol;
    const values: Value[] = Array.from({ length: symbol.staticFieldCount });
    for (const field of symbol.fields) {
      if (field.isStatic && !field.isConst)
        values[field.slot] = this.evaluator.defaultOf(substitute(field.type, substitutionOf(type)));
    }
    const storage = { values };
    this.statics.set(key, storage);
    if (this.initializing.has(key)) return storage;
    this.initializing.add(key);
    try {
      this.evaluator.runStaticInitialization(type);
    } catch (error) {
      if (error instanceof CsThrow || error instanceof PendingException) {
        this.statics.delete(key);
        throw this.typeInitializationError(type, error);
      }
      throw error;
    } finally {
      this.initializing.delete(key);
    }
    return storage;
  }

  private typeInitializationError(type: NamedType, cause: CsThrow | PendingException): CsThrow {
    const inner = cause instanceof CsThrow ? cause.exception : this.materialize(cause);
    const exception = this.createException(
      'System.TypeInitializationException',
      `The type initializer for '${type.symbol.fullName}' threw an exception.`,
      inner
    );
    return new CsThrow(exception);
  }

  /** The library exception type of a full name. */
  exceptionType(fullName: string): NamedType {
    const parts = fullName.split('.');
    const namespace = this.library.root.resolve(parts.slice(0, -1), false);
    const symbol = namespace?.findType(parts.at(-1) as string, 0);
    if (symbol) return namedType(symbol);
    return this.exceptionTypeFallback(fullName);
  }

  /** Exceptions that the library declares nowhere, such as those of the runtime's own internals, as plain exceptions. */
  private exceptionTypeFallback(fullName: string): NamedType {
    const cached = this.syntheticExceptions.get(fullName);
    if (cached) return cached;
    const base = namedType(this.library.specials.get('exception') as TypeSymbol);
    const name = fullName.slice(fullName.lastIndexOf('.') + 1);
    const symbol = Object.assign(Object.create(Object.getPrototypeOf(base.symbol)), base.symbol, {
      name,
      namespace: fullName.slice(0, fullName.lastIndexOf('.')),
      baseType: base,
      runtimeNameOverride: fullName,
      fields: [],
      methods: [],
      properties: [],
      constructors: [],
      special: undefined,
    }) as TypeSymbol;
    const type = namedType(symbol);
    this.syntheticExceptions.set(fullName, type);
    return type;
  }

  private readonly syntheticExceptions = new Map<string, NamedType>();

  createException(
    fullName: string,
    message: string | undefined,
    inner: CsObject | undefined = undefined,
    paramName?: string
  ): CsObject {
    const type = this.exceptionType(fullName);
    const exception = new CsObject(type, Array.from({ length: type.symbol.instanceFieldCount }));
    const state: ExceptionState = { message, inner, paramName, wasThrown: false };
    exception.native = state;
    return exception;
  }

  /** Turns a library exception into the C# exception object that a catch clause sees. */
  materialize(pending: PendingException): CsObject {
    return this.createException(pending.typeName, pending.exceptionMessage, undefined, pending.paramName);
  }

  /** The implementation that a virtual call of a method runs for a receiver's runtime type. */
  dispatch(method: MethodSymbol, receiver: Value, staticType?: Type): MethodSymbol {
    // A primitive carries no type, which its static type with the frame's type arguments gives instead.
    let type = this.runtimeTypeOf(receiver) ?? staticType;
    if (type?.kind === 'array' && type.rank === 1 && method.owner.kind === 'interface') {
      type = namedType(this.library.typeNamed('System.Linq.Internal.ArrayHelper', 1), [type.element]);
    }
    if (!type || type.kind !== 'named') return method;
    if (type.symbol === method.owner && !method.isAbstract) return method;
    let byType = this.dispatchCache.get(method);
    if (!byType) {
      byType = new Map();
      this.dispatchCache.set(method, byType);
    }
    const key = typeKey(type);
    let found = byType.get(key);
    if (!found) {
      found = this.findImplementation(type, method) ?? method;
      byType.set(key, found);
    }
    return found;
  }

  private findImplementation(type: NamedType, method: MethodSymbol): MethodSymbol | undefined {
    const isInterface = method.owner.kind === 'interface';
    const implementsMethod = (candidate: MethodSymbol): boolean =>
      candidate.name === method.name &&
      (isInterface ? this.implementsByName(candidate, method) : this.overrides(candidate, method));
    for (let current: NamedType | undefined = type; current; current = baseTypeOf(current)) {
      const found =
        current.symbol.methods.find((candidate) => !candidate.isStatic && implementsMethod(candidate)) ??
        current.symbol.properties
          .flatMap((property) => [property.getter, property.setter])
          .find((accessor): accessor is MethodSymbol => accessor !== undefined && implementsMethod(accessor));
      if (found) return found;
    }
    return undefined;
  }

  private overrides(candidate: MethodSymbol, method: MethodSymbol): boolean {
    for (let current: MethodSymbol | undefined = candidate; current; current = current.overridden)
      if (current === method) return true;
    return false;
  }

  /** Whether a class's method implements an interface's, which C# matches by name and parameter count and types. */
  private implementsByName(candidate: MethodSymbol, method: MethodSymbol): boolean {
    if (candidate.parameters.length !== method.parameters.length) return false;
    if (candidate.access !== 'public' && !candidate.owner.isLibrary) return false;
    return candidate.parameters.every((parameter, index) => {
      const other = method.parameters[index].type;
      return (
        parameter.type.kind === other.kind || parameter.type.kind === 'typeParameter' || other.kind === 'typeParameter'
      );
    });
  }

  /** The runtime type of a value, which boxes and objects carry. */
  runtimeTypeOf(value: Value): Type | undefined {
    if (
      value instanceof CsObject ||
      value instanceof CsStruct ||
      value instanceof CsBox ||
      value instanceof CsArray ||
      value instanceof CsDelegate
    )
      return value.type;
    if (typeof value === 'string') return namedType(this.library.specials.get('string') as TypeSymbol);
    return undefined;
  }

  /** Removes the turtles that no frame, static field, or pending value can reach any more. */
  collectGarbage(): void {
    if (!this.world.hasTurtles) return;
    const reached = new Set<TurtleState>();
    const seen = new Set<object>();
    const pending = this.garbageRoots();
    let scanned = 0;
    while (pending.length > 0) {
      const value = pending.pop();
      if (!(value instanceof Object) || seen.has(value)) continue;
      seen.add(value);
      scanned++;
      if (value instanceof CsObject && value.turtle?.isAlive) reached.add(value.turtle);
      pending.push(...referencesOf(value));
    }
    this.spend(Math.ceil(scanned / 64));
    this.world.retain((turtle) => reached.has(turtle));
  }

  private garbageRoots(): unknown[] {
    const roots: unknown[] = [];
    for (const frame of this.frames) {
      roots.push(frame.thisValue, ...frame.slots, ...frame.temporaries, ...frame.operands, ...frame.captured.values());
    }
    for (const storage of this.statics.values()) roots.push(...storage.values);
    return roots;
  }

  /** Synthesized record and anonymous type members, which compare and print the object's fields. */
  recordMember(call: NativeCall, name: string, receiver: Value, args: (Value | VariableReference)[]): Value {
    return this.evaluator.recordMember(call, name, receiver, args as Value[]);
  }

  anonymousConstruct(receiver: Value, args: (Value | VariableReference)[]): Value {
    const object = receiver as CsObject;
    for (const [index, arg] of args.entries()) object.fields[index] = arg as Value;
    return undefined;
  }

  /** The turtle a Turtle object controls. */
  turtleOf(value: Value): TurtleState {
    if (!(value instanceof CsObject) || !value.turtle)
      throw new PendingException(
        'System.NullReferenceException',
        'Object reference not set to an instance of an object.'
      );
    return value.turtle;
  }
}

/** The host's stack ran out, or the program recursed past the call depth limit. */
export class StackOverflow extends Error {}

/** A key that identifies a constructed type, for per-type static storage and caches. */
export function typeKey(type: Type): string {
  switch (type.kind) {
    case 'named': {
      return type.args.length === 0
        ? type.symbol.fullName + `#${symbolId(type.symbol)}`
        : `${type.symbol.fullName}#${symbolId(type.symbol)}[${type.args.map(typeKey).join(',')}]`;
    }
    case 'array': {
      return `${typeKey(type.element)}[${type.rank}]`;
    }
    case 'typeParameter': {
      return `!${type.symbol.name}`;
    }
    default: {
      return type.kind;
    }
  }
}

const symbolIds = new WeakMap<TypeSymbol, number>();
let nextSymbolId = 1;

function symbolId(symbol: TypeSymbol): number {
  let id = symbolIds.get(symbol);
  if (id === undefined) {
    id = nextSymbolId++;
    symbolIds.set(symbol, id);
  }
  return id;
}

export function isSameRuntimeType(a: Type, b: Type): boolean {
  return sameType(a, b);
}

export type { FieldSymbol };

/** The values that a value holds, which the garbage collector reaches through it. */
function referencesOf(value: object): unknown[] {
  if (value instanceof Cell) return [value.value === UNASSIGNED ? undefined : value.value];
  if (value instanceof CsObject || value instanceof CsStruct) return [...value.fields, ...nativeReferencesOf(value)];
  if (value instanceof CsBox) return [value.value];
  if (value instanceof CsArray) return value.values;
  if (value instanceof CsDelegate) {
    return value.entries.flatMap((entry) =>
      entry.lambda ? [entry.target, entry.lambda.thisValue, ...entry.lambda.cells.values()] : [entry.target]
    );
  }
  if ('get' in value && typeof (value as VariableReference).get === 'function')
    return [(value as VariableReference).get()];
  return [];
}

function nativeReferencesOf(value: CsObject | CsStruct): Iterable<unknown> {
  const native = value.native as NativeState | undefined;
  return native && typeof native.references === 'function' ? native.references() : [];
}
