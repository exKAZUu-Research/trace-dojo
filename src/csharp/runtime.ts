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
  typeKey,
  type TypeParameterSymbol,
  type TypeSymbol,
} from './types';
import {
  Cell,
  CsArray,
  CsBox,
  CsDelegate,
  CsObject,
  CsString,
  CsStruct,
  freshString,
  isString,
  structFieldSlots,
  UNASSIGNED,
  type Value,
  type VariableReference,
} from './values';

/** What a frame's slot holds: a value, a cell for a captured local, or a reference for a `ref` parameter. */
export type Slot = Value | Cell | VariableReference | typeof UNASSIGNED;

/** The state of a library object, which tells the garbage collector what it holds. */
export interface NativeState {
  references(): Iterable<Value>;
  /** For a state the trace shows as its text, as a StringBuilder, the text. */
  displayText?(): string;
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
  /** The string object of the message, which `Message` returns each time .NET returns the stored message. */
  messageString?: string | CsString;
  inner: CsObject | undefined;
  paramName?: string | undefined;
  /** The program's string object of the parameter name; the library's names are literals, so interned. */
  paramNameString?: string | CsString;
  /** The text of `ArgumentOutOfRangeException`'s actual value, which its message shows. */
  actualValue?: Value;
  /** The actual value itself, which `ActualValue` returns. */
  actualObject?: Value;
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
  /** The exception of each type whose initializer threw, which .NET throws again on every later use of the type. */
  private readonly failedInitializations = new Map<string, CsThrow>();
  private readonly dispatchCache = new Map<MethodSymbol, Map<string, MethodSymbol>>();
  /** The strings .NET makes once and returns again, such as a small number's text, by what they are the text of. */
  private readonly sharedStrings = new Map<string, CsString>();
  /**
   * The state of CoreCLR's hash codes for the main thread, the second thread the runtime makes: each new hash code
   * steps `seed * (4 * threadId + 5) + 1` with thread id 1 and keeps the top 26 bits, never 0.
   */
  private hashCodeSeed = (Math.imul(123_456_789, 1_566_083_941) + 1) >>> 0;
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

  private readonly displayIdentities = new WeakMap<object, number>();
  private shownIdentities = 0;

  /**
   * A label for an object a trace names by identity, as the Java trace names a map's object keys (`#1`): numbered in
   * the order the trace first shows them, apart from the hash codes the program sees.
   */
  displayIdentity(value: object): string {
    let identity = this.displayIdentities.get(value);
    if (identity === undefined) {
      identity = ++this.shownIdentities;
      this.displayIdentities.set(value, identity);
    }
    return `#${identity}`;
  }

  /** The struct fields made since the last operation they were charged. */
  private unchargedStructFields = 0;

  /** Charges the fields of the structs a run makes as one operation per STRUCT_FIELDS_PER_OPERATION. */
  meterStructFields(fieldCount: number): void {
    this.unchargedStructFields += fieldCount;
    if (this.unchargedStructFields < STRUCT_FIELDS_PER_OPERATION) return;
    const operations = Math.floor(this.unchargedStructFields / STRUCT_FIELDS_PER_OPERATION);
    this.unchargedStructFields -= operations * STRUCT_FIELDS_PER_OPERATION;
    this.spend(operations);
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

  /**
   * The text of an integer as .NET's number formatting returns it: one cached string for each of 0 to 299, whatever
   * the integer type, and a new string for others.
   */
  numberString(text: string): string | CsString {
    return /^(?:[12]?\d)?\d$/.test(text) ? this.sharedString(`number:${text}`, text) : freshString(text);
  }

  /** The name of an enum member, which .NET keeps for each enum type, or a number's text for a value with none. */
  enumString(type: NamedType, text: string): string | CsString {
    if (/^-?\d+$/.test(text)) return this.numberString(text);
    const isMember = type.symbol.fields.some((field) => field.isConst && field.name === text);
    return isMember ? this.sharedString(`enum:${typeKey(type)}:${text}`, text) : freshString(text);
  }

  private hasInterpolationHandler = false;

  /**
   * The first interpolated string handler takes a hash code when it returns its buffer to `ArrayPool<char>.Shared`,
   * whose set-up gives an object one, as .NET 10 shows in the hash codes of the program's objects around it.
   */
  returnInterpolationBuffer(): void {
    if (this.hasInterpolationHandler) return;
    this.hasInterpolationHandler = true;
    this.nextHashCode();
  }

  /** The next hash code that `RuntimeHelpers.GetHashCode` gives an object. */
  nextHashCode(): number {
    let hashCode = 0;
    while (hashCode === 0) {
      this.hashCodeSeed = (Math.imul(this.hashCodeSeed, 9) + 1) >>> 0;
      hashCode = this.hashCodeSeed >>> 6;
    }
    return hashCode;
  }

  /** A string that .NET makes once for a key, such as the name of a type, and returns again. */
  sharedString(key: string, text: string): CsString {
    let shared = this.sharedStrings.get(key);
    if (!shared) {
      shared = new CsString(text);
      this.sharedStrings.set(key, shared);
    }
    return shared;
  }

  /**
   * Charges a store into existing storage for the struct fields it adds, as when a struct replaces null in an `S?[]`
   * or a box enters an `object` field, so a struct kept by any store counts against the slot limit.
   */
  chargeStore(previous: Value, next: Value): void {
    const boxes = new Set<CsBox>();
    const growth = structFieldSlots(next, boxes) - structFieldSlots(previous, new Set());
    this.allocateSlots(Math.max(0, growth));
    for (const box of boxes) box.isCharged = true;
  }

  /**
   * Charges storage that newly keeps values: `baseSlots` and each value's struct fields, a box's only the first time
   * any storage keeps it. The boxes counted are marked as charged only once the charge succeeds, so storage a failed
   * or abandoned operation counted is charged again when a later store keeps it.
   */
  retainSlots(baseSlots: number, values: Iterable<Value>): void {
    const boxes = new Set<CsBox>();
    let count = baseSlots;
    for (const value of values) count += structFieldSlots(value, boxes);
    this.allocateSlots(count);
    for (const box of boxes) box.isCharged = true;
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
    const failure = this.failedInitializations.get(key);
    if (failure) throw new CsThrow(failure.exception);
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
    const fieldTypes = symbol.fields
      .filter((field) => field.isStatic && !field.isConst)
      .map((field): [number, Type] => [field.slot, substitute(field.type, substitutionOf(type))]);
    // A static field of a struct type keeps the fields its default value allocates, charged before they exist.
    // The static fields are slots themselves, besides the default layouts of struct ones.
    this.allocateSlots(
      symbol.staticFieldCount +
        fieldTypes.reduce((sum, [, fieldType]) => sum + this.evaluator.defaultSlotCount(fieldType), 0)
    );
    const values: Value[] = Array.from({ length: symbol.staticFieldCount });
    for (const [slot, fieldType] of fieldTypes) values[slot] = this.evaluator.defaultOf(fieldType);
    const storage = { values };
    this.statics.set(key, storage);
    if (this.initializing.has(key)) return storage;
    this.initializing.add(key);
    try {
      this.evaluator.runStaticInitialization(type);
    } catch (error) {
      if (error instanceof CsThrow || error instanceof PendingException) {
        this.statics.delete(key);
        const failure = this.typeInitializationError(type, error);
        this.failedInitializations.set(key, failure);
        throw failure;
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
    if (!symbol) throw new Error(`The library lacks the exception ${fullName}`);
    return namedType(symbol);
  }

  createException(
    fullName: string,
    message: string | undefined,
    inner: CsObject | undefined = undefined,
    paramName?: string
  ): CsObject {
    const type = this.exceptionType(fullName);
    const exception = new CsObject(type, Array.from({ length: type.symbol.instanceFieldCount }));
    const state: ExceptionState = {
      message,
      inner,
      paramName,
      wasThrown: false,
    };
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
    // The generic collection interfaces of an array map to the helper; its other members to System.Array.
    if (type?.kind === 'array') {
      type =
        type.rank === 1 && method.owner.kind === 'interface' && method.owner.typeParameters.length > 0
          ? namedType(this.library.typeNamed('System.Linq.Internal.ArrayHelper', 1), [type.element])
          : namedType(this.library.typeNamed('System.Array'));
    }
    if (!type || type.kind !== 'named') return method;
    if (type.symbol === method.owner && !method.isAbstract) return method;
    let byType = this.dispatchCache.get(method);
    if (!byType) {
      byType = new Map();
      this.dispatchCache.set(method, byType);
    }
    // A class may implement one generic interface for several type arguments, which the call's static type picks.
    const face =
      method.owner.kind === 'interface' && staticType?.kind === 'named' && staticType.symbol === method.owner
        ? staticType
        : undefined;
    const key = face ? `${typeKey(type)} as ${typeKey(face)}` : typeKey(type);
    let found = byType.get(key);
    if (!found) {
      found = this.findImplementation(type, method, face) ?? method;
      byType.set(key, found);
    }
    return found;
  }

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private findImplementation(type: NamedType, method: MethodSymbol, face?: NamedType): MethodSymbol | undefined {
    const isInterface = method.owner.kind === 'interface';
    if (isInterface) {
      const explicit = this.findExplicitImplementation(type, method);
      if (explicit) return explicit;
    }
    // Without the call's interface type, the interface's own suits a non-generic interface, whose overloads (such as
    // indexers) then map by their parameter types.
    const exact = isInterface
      ? this.findExactImplementation(type, method, face ?? method.owner.declaredType)
      : undefined;
    if (exact) return exact;
    const implementsMethod = (candidate: MethodSymbol): boolean =>
      candidate.name === method.name &&
      (isInterface ? this.implementsByName(candidate, method) : this.overrides(candidate, method));
    // An interface's members map to those of the most derived class that lists the interface, searching up from it
    // (C# spec §19.6.5), so a `new` member of a class below does not implement it; virtual ones then dispatch.
    const start = isInterface ? (this.declaringClass(type, method.owner) ?? type) : type;
    for (let current: NamedType | undefined = start; current; current = baseTypeOf(current)) {
      const found =
        current.symbol.methods.find((candidate) => !candidate.isStatic && implementsMethod(candidate)) ??
        current.symbol.properties
          .flatMap((property) => [property.getter, property.setter])
          .find((accessor): accessor is MethodSymbol => accessor !== undefined && implementsMethod(accessor));
      if (found) {
        if (!isInterface || start === type || !(found.isVirtual || found.isOverride || found.isAbstract)) return found;
        return this.findImplementation(type, found) ?? found;
      }
    }
    return undefined;
  }

  /**
   * The explicit implementation (`void I.M()`) of an interface method in a type's chain, which maps before any public
   * method does (C# spec §19.6.5), or else the default body that an interface the type implements gives it.
   */
  private findExplicitImplementation(type: NamedType, method: MethodSymbol): MethodSymbol | undefined {
    const isFor = (candidate: MethodSymbol): boolean =>
      candidate.explicitInterface?.symbol === method.owner &&
      candidate.name === method.name &&
      candidate.isStatic === method.isStatic &&
      candidate.parameters.length === method.parameters.length;
    for (let current: NamedType | undefined = type; current; current = baseTypeOf(current)) {
      const accessors = current.symbol.properties.flatMap((property) => [property.getter, property.setter]);
      const found = [...current.symbol.methods, ...accessors].find(
        (candidate): candidate is MethodSymbol => candidate !== undefined && isFor(candidate)
      );
      if (found) return found;
    }
    // An interface below the method's may override its body with an explicit one, as `void I.M() { }` in `J : I`.
    for (const face of allInterfacesOf(type)) {
      const accessors = face.symbol.properties.flatMap((property) => [property.getter, property.setter]);
      const found = [...face.symbol.methods, ...accessors].find(
        (candidate): candidate is MethodSymbol => candidate !== undefined && isFor(candidate) && !candidate.isAbstract
      );
      if (found) return found;
    }
    return undefined;
  }

  /** The static method of a type argument that implements an interface's static abstract or virtual method. */
  staticImplementation(type: NamedType, method: MethodSymbol): MethodSymbol {
    const explicit = this.findExplicitImplementation(type, method);
    if (explicit) return explicit;
    for (let current: NamedType | undefined = type; current; current = baseTypeOf(current)) {
      const accessors = current.symbol.properties.flatMap((property) => [property.getter, property.setter]);
      const found = [...current.symbol.methods, ...accessors].find(
        (candidate): candidate is MethodSymbol =>
          candidate !== undefined &&
          candidate.isStatic &&
          candidate.name === method.name &&
          candidate.access === 'public' &&
          candidate.parameters.length === method.parameters.length
      );
      if (found) return found;
    }
    return method;
  }

  /** The method whose parameter types are those of an interface method for the interface's type arguments. */
  private findExactImplementation(type: NamedType, method: MethodSymbol, face: NamedType): MethodSymbol | undefined {
    const wanted = method.parameters.map((parameter) => substitute(parameter.type, substitutionOf(face)));
    const start = this.declaringClass(type, method.owner) ?? type;
    for (let current: NamedType | undefined = start; current; current = baseTypeOf(current)) {
      const substitution = substitutionOf(current);
      const accessors = current.symbol.properties.flatMap((property) => [property.getter, property.setter]);
      const found = [...current.symbol.methods, ...accessors].find(
        (candidate): candidate is MethodSymbol =>
          candidate !== undefined &&
          candidate.name === method.name &&
          !candidate.isStatic &&
          candidate.typeParameters.length === method.typeParameters.length &&
          candidate.parameters.length === wanted.length &&
          candidate.parameters.every((parameter, index) =>
            sameType(substitute(parameter.type, substitution), wanted[index])
          )
      );
      if (found && start !== type && (found.isVirtual || found.isOverride || found.isAbstract))
        return this.findImplementation(type, found) ?? found;
      if (found) return found;
    }
    return undefined;
  }

  /** The most derived class of a type's chain whose own base list includes an interface, directly or inherited. */
  private declaringClass(type: NamedType, face: TypeSymbol): NamedType | undefined {
    const listsInterface = (symbol: TypeSymbol): boolean =>
      symbol === face || symbol.interfaces.some((parent) => listsInterface(parent.symbol));
    for (let current: NamedType | undefined = type; current; current = baseTypeOf(current)) {
      if (current.symbol.interfaces.some((parent) => listsInterface(parent.symbol))) return current;
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
    if (isString(value)) return namedType(this.library.specials.get('string') as TypeSymbol);
    return undefined;
  }

  /** Removes the turtles that no frame, static field, or pending value can reach any more. */
  collectGarbage(): void {
    if (!this.world.hasTurtles) return;
    const reached = new Set<TurtleState>();
    const seen = new Set<object>();
    const pending = this.garbageRoots();
    // Every entry the traversal visits is charged, primitives and repeated references included, so that a program
    // cannot repeat collections over a large array for free.
    let scanned = 0;
    while (pending.length > 0) {
      const value = pending.pop();
      if (++scanned % 64 === 0) this.spend();
      if (!(value instanceof Object) || seen.has(value)) continue;
      seen.add(value);
      if (value instanceof CsObject && value.turtle?.isAlive) reached.add(value.turtle);
      for (const reference of referencesOf(value)) pending.push(reference);
    }
    this.world.retain((turtle) => reached.has(turtle));
  }

  private garbageRoots(): unknown[] {
    const roots: unknown[] = [];
    for (const frame of this.frames) {
      roots.push(frame.thisValue);
      for (const values of [frame.slots, frame.temporaries, frame.operands, frame.captured.values()])
        for (const value of values) roots.push(value);
    }
    for (const storage of this.statics.values()) for (const value of storage.values) roots.push(value);
    return roots;
  }

  /** Synthesized record and anonymous type members, which compare and print the object's fields. */
  recordMember(call: NativeCall, name: string, receiver: Value, args: (Value | VariableReference)[]): Value {
    return this.evaluator.recordMember(call, name, receiver, args as Value[]);
  }

  anonymousConstruct(receiver: Value, args: (Value | VariableReference)[]): Value {
    const object = receiver as CsObject;
    for (const [index, arg] of args.entries()) {
      this.chargeStore(object.fields[index], arg as Value);
      object.fields[index] = arg as Value;
    }
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

/** The struct fields made per operation charged, so a run makes at most this many times its operations of them. */
const STRUCT_FIELDS_PER_OPERATION = 16;

/** Every interface that a type implements, through its bases and the interfaces' own bases. */
function allInterfacesOf(type: NamedType): NamedType[] {
  const result: NamedType[] = [];
  const add = (face: NamedType): void => {
    if (result.some((existing) => existing.symbol === face.symbol)) return;
    result.push(face);
    for (const parent of face.symbol.interfaces) add(substitute(parent, substitutionOf(face)) as NamedType);
  };
  for (let current: NamedType | undefined = type; current; current = baseTypeOf(current))
    for (const face of current.symbol.interfaces) add(substitute(face, substitutionOf(current)) as NamedType);
  return result;
}
