import { ExecutionBudget, ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { TurtleWorld } from '../interpreter/turtleWorld';
import type { ClassInfo, ConstructorInfo, Member } from './classes';
import {
  asInstanceOf,
  boundOf,
  coreTypes,
  type DartType,
  type FunctionType,
  instantiateFunction,
  instantiateToBounds,
  type InterfaceType,
  interfaceType,
  isSubtype,
  mentionsTypeParams,
  objectType,
  substitute,
  TypeParam,
  typeParamType,
  vmTypeString,
} from './types';
import {
  type Arguments,
  Cell,
  DartClosure,
  DartList,
  DartObject,
  DartRecord,
  DartTypeValue,
  NO_ARGUMENTS,
  type Value,
} from './values';

/** What a frame's function is, which traces read to show its variables. */
export interface FunctionInfo {
  name: string;
  isAtomic: boolean;
  /** Library code records no steps and shows no variables. */
  isLibrary: boolean;
  /** The local variables by slot, which a trace shows while they hold values. */
  locals: LocalInfo[];
  /** The variables a closure captured, by their index among its captured cells. */
  captures: LocalInfo[];
  /** Whether `this` is an object of the program whose fields the trace shows as `this.x`. */
  showsThis: boolean;
}

export interface LocalInfo {
  name: string;
  type: DartType;
}

export type TypeEnv = ReadonlyMap<TypeParam, DartType>;
export const EMPTY_TYPE_ENV: TypeEnv = new Map();

export class Frame implements TracedFrame {
  readonly locals: (Cell | undefined)[];
  /** Values a statement holds while it evaluates the rest of an expression, which garbage collection keeps. */
  readonly temporaries: Value[] = [];

  // code-gauge-allow functionParameterCount 7 -- The parameters are the parts a caller already holds; grouping them would only rename them.
  constructor(
    readonly runtime: Runtime,
    readonly info: FunctionInfo,
    slotCount: number,
    /** `this`; an extension type's constructor replaces it with the representation once its initializers have run. */
    public receiver: Value,
    readonly captured: readonly Cell[],
    readonly typeEnv: TypeEnv,
    readonly callRow: number | undefined
  ) {
    this.locals = Array.from({ length: slotCount });
  }
}

/** A Dart exception in flight, with the stack trace `catch (e, s)` receives. */
export class DartThrow {
  constructor(
    readonly value: Value,
    readonly stackTrace: Value
  ) {}
}

/** `exit()` from dart:io, which ends the program without an error. */
export class ProgramExit {
  constructor(readonly code: number) {}
}

/** The classes, constructors, and helpers natives need to create library objects such as errors. */
export interface LibraryLinks {
  classNamed(name: string): ClassInfo;
  newList(
    runtime: Runtime,
    elementType: DartType,
    elements: Value[],
    growable: boolean,
    unmodifiable?: boolean
  ): DartList;
  newSet(runtime: Runtime, elementType: DartType, isConst: boolean): DartObject;
  newMap(runtime: Runtime, keyType: DartType, valueType: DartType, isConst: boolean): DartObject;
  /** The canonical copy of a constant, which equal constants share. */
  canonicalize(runtime: Runtime, value: Value): Value;
  /** The exception a `throw` raises, recording a stack trace in an `Error`. */
  newThrow(runtime: Runtime, value: Value): DartThrow;
  stackTraceOf(runtime: Runtime, error: DartThrow): Value;
  /** The iterable a `sync*` function returns. */
  syncStarIterable(
    frame: Frame,
    elementType: DartType,
    body: (frame: Frame) => Generator<Value, unknown, undefined>
  ): Value;
  listIterator(runtime: Runtime, list: DartList): DartObject;
  /** Whether a value is of a type that holds no type parameters. */
  isValueOf(runtime: Runtime, value: Value, type: DartType): boolean;
  /** Creates an object of a library class by calling its constructor. */
  construct(
    runtime: Runtime,
    className: string,
    constructorName: string,
    args: Value[],
    named?: Record<string, Value>,
    typeArgs?: readonly DartType[]
  ): DartObject;
  /** `map.addAll(other)` of the VM's maps, by which a map literal adds a spread map. */
  addAllToMap(runtime: Runtime, map: DartObject, other: Value): void;
  /** The table copy of `set.addAll(other)` into an empty set, by which a set literal may add a spread set. */
  quickCopySet(runtime: Runtime, set: DartObject, other: Value): boolean;
  /** The value `toString` gives, or a fallback when the object's own `toString` fails. */
  stringify(runtime: Runtime, value: Value): string;
}

export class Runtime implements TracedRuntime<Frame> {
  readonly world = new TurtleWorld();
  readonly budget = new ExecutionBudget();
  readonly io: ProgramIO;
  readonly steps = new StepTracker();
  readonly frames: Frame[] = [];
  /** Top-level variables and static fields, by slot; a late or lazily initialized one starts unset. */
  globals: Cell[] = [];
  /** Canonical constants by their structure, so that equal constants are identical. */
  readonly constants = new Map<string, Value>();
  /** Structurally distinct constant types that share a display name. */
  readonly constantTypes = new Map<string, DartType[]>();
  /** The canonical tear-offs of top-level functions and static methods. */
  readonly tearOffs = new Map<unknown, DartClosure>();
  /** The value of each constant expression evaluated so far, by the code that builds it. */
  readonly constantSites = new Map<unknown, Value>();
  allocatedSlots = 0;
  checkingConstants = false;
  links!: LibraryLinks;
  /** Objects `toString` is visiting, which collections print as `[...]` when they contain themselves. */
  readonly toStringVisiting: Value[] = [];
  /** Runs when the entry point returns or throws, while its frame is still on the stack. */
  onMainExit: (() => void) | undefined;
  /** Extra roots for garbage collection, such as the iterators of running loops. */
  readonly roots = new Set<() => Iterable<Value>>();

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  /** Counts slots an allocation takes against the limit. */
  allocate(slots: number): void {
    this.allocatedSlots += slots;
    if (this.allocatedSlots > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
  }

  enter(frame: Frame): void {
    // Constructing the error enters its constructor's frame, which the check must let through.
    if (this.frames.length >= LIMITS.maxCallDepth && !this.overflowing) {
      this.overflowing = true;
      try {
        this.throwError('StackOverflowError', '', []);
      } finally {
        this.overflowing = false;
      }
    }
    this.frames.push(frame);
  }

  private overflowing = false;

  exit(frame: Frame): void {
    if (this.frames.length === 1 && this.onMainExit) {
      // The entry point's frame still holds its variables, which the end of a trace shows.
      const callback = this.onMainExit;
      this.onMainExit = undefined;
      callback();
    }
    const top = this.frames.pop();
    if (top !== frame) throw new Error('The frames got out of order');
    if (frame.info.isAtomic) this.steps.completeAtomicCall();
  }

  get currentFrame(): Frame | undefined {
    return this.frames.at(-1);
  }

  /** The row of the call that a library function called back from would show: the row its library frame was called at. */
  get userCallRow(): number | undefined {
    for (let index = this.frames.length - 1; index >= 0; index--) {
      const frame = this.frames[index];
      if (!frame.info.isLibrary) return undefined;
      if (frame.callRow !== undefined) return frame.callRow;
    }
    return undefined;
  }

  throwError(className: string, constructorName: string, args: Value[], named?: Record<string, Value>): never {
    throw new DartThrow(this.links.construct(this, className, constructorName, args, named), undefined);
  }

  /** Throws a `TypeError` with the VM's message, as failed casts and null checks do. */
  throwTypeError(message: string): never {
    this.throwError('_TypeError', '_withMessage', [message]);
  }

  // Classes and types of values

  classOf(value: Value): ClassInfo {
    switch (typeof value) {
      case 'undefined': {
        return coreTypes.nullClass;
      }
      case 'boolean': {
        return coreTypes.bool;
      }
      case 'bigint': {
        return coreTypes.int;
      }
      case 'number': {
        return coreTypes.double;
      }
      case 'string': {
        return coreTypes.string;
      }
      default: {
        return value.cls;
      }
    }
  }

  // Members

  /** Calls a method on a value, dispatching on its class, or calls a getter's result as `noSuchMethod` would not. */
  invoke(
    receiver: Value,
    name: string,
    args: Arguments,
    typeArgs: readonly DartType[],
    callRow: number | undefined
  ): Value {
    if (name === 'call' && receiver instanceof DartClosure) return this.callValue(receiver, args, typeArgs, callRow);
    const cls = this.classOf(receiver);
    const member = cls.implementation(name);
    if (member?.kind === 'method') {
      if (args.isDynamic && !argumentsFit(member.type, args, typeArgs)) {
        return this.noSuchMethod(receiver, name, 'method', args, typeArgs, vmSignature(name, member));
      }
      const supplied = args.isDynamic
        ? this.dynamicTypeArguments(this.memberTypeFor(receiver, member), typeArgs)
        : typeArgs;
      if (args.isDynamic && member.nativeParameterNames) this.checkNativeArguments(receiver, member, args, supplied);
      return (member.impl as NonNullable<typeof member.impl>)(this, receiver, args, supplied, callRow);
    }
    if (member) {
      const target = this.readMember(receiver, member, callRow);
      return this.callValue(target, args, typeArgs, callRow);
    }
    if (receiver instanceof DartRecord)
      return this.callValue(this.getProperty(receiver, name, callRow), args, typeArgs, callRow);
    return this.noSuchMethod(receiver, name, 'method', args, typeArgs);
  }

  getProperty(receiver: Value, name: string, callRow: number | undefined): Value {
    // A function's `call` is the function itself.
    if (name === 'call' && receiver instanceof DartClosure) return receiver;
    const cls = this.classOf(receiver);
    const member = cls.implementation(name);
    if (member) return this.readMember(receiver, member, callRow);
    const field = receiver instanceof DartRecord ? receiver.field(name) : undefined;
    return field ? field[1] : this.noSuchMethod(receiver, name, 'getter', NO_ARGUMENTS);
  }

  readMember(receiver: Value, member: Member, callRow: number | undefined): Value {
    switch (member.kind) {
      case 'field': {
        const value = (receiver as DartObject).fields[member.slot];
        return value;
      }
      case 'getter': {
        return (member.impl as NonNullable<typeof member.impl>)(this, receiver, NO_ARGUMENTS, [], callRow);
      }
      case 'method': {
        return this.tearOff(receiver, member);
      }
      default: {
        return this.noSuchMethod(receiver, member.name, 'getter', NO_ARGUMENTS);
      }
    }
  }

  /**
   * A dynamic or covariant field write is checked against the type of the actual object.
   */
  private checkCovariantField(receiver: DartObject, field: Member & { kind: 'field' }, value: Value): void {
    const owner = asInstanceOf(interfaceType(receiver.cls, receiver.typeArgs), field.owner);
    const env = new Map(
      field.owner.typeParams.map((param, index) => [param, owner?.args[index] ?? ({ kind: 'dynamic' } as const)])
    );
    const expected = substitute(field.type, env);
    if (this.links.isValueOf(this, value, expected)) return;
    this.throwTypeError(
      `type '${vmTypeString(this.runtimeTypeOf(value))}' is not a subtype of type '${vmTypeString(expected)}' of 'value'`
    );
  }

  setProperty(receiver: Value, name: string, value: Value, callRow: number | undefined, isDynamic = false): void {
    const cls = this.classOf(receiver);
    const member = cls.setterImplementation(name);
    if (!member) {
      this.noSuchMethod(receiver, `${name}=`, 'setter', { positional: [value], named: undefined });
      return;
    }
    if (member.kind === 'field') {
      if (isDynamic || member.isCovariant || mentionsTypeParams(member.type))
        this.checkCovariantField(receiver as DartObject, member, value);
      (receiver as DartObject).fields[member.slot] = value;
      return;
    }
    (member.impl as NonNullable<typeof member.impl>)(
      this,
      receiver,
      { positional: [value], named: undefined, isDynamic },
      [],
      callRow
    );
  }

  /** A method's tear-off, which is equal to another tear-off of the same method from the same receiver. */
  tearOff(receiver: Value, member: Member & { kind: 'method' }): DartClosure {
    // A static method's tear-off is canonical, as a top-level function's is.
    if (member.isStatic) {
      const existing = this.tearOffs.get(member);
      if (existing) return existing;
    }
    const closure = this.newTearOff(receiver, member);
    if (member.isStatic) this.tearOffs.set(member, closure);
    return closure;
  }

  private newTearOff(receiver: Value, member: Member & { kind: 'method' }): DartClosure {
    const impl = member.impl as NonNullable<typeof member.impl>;
    const type = member.isStatic ? member.type : covariantErased(member, this.memberTypeFor(receiver, member));
    return new DartClosure(
      coreTypes.function,
      type,
      (runtime, _receiver, args, typeArgs, callRow) => impl(runtime, receiver, args, typeArgs, callRow),
      receiver,
      [],
      {
        name: member.name,
        origin: `Function '${member.name}':${member.isStatic ? ' static' : ''}.`,
        qualifiedName: `${member.owner.name}.${member.name}`,
      },
      member
    );
  }

  /** A member's function type with the receiver's type arguments in place of its class's type parameters. */
  memberTypeFor(receiver: Value, member: Member & { kind: 'method' }): FunctionType {
    if (member.owner.typeParams.length === 0 || member.isStatic) return member.type;
    const instance = asInstanceOf(this.runtimeTypeOf(receiver) as InterfaceType, member.owner);
    if (!instance) return member.type;
    const map = new Map(member.owner.typeParams.map((param, index) => [param, instance.args[index]]));
    return substituteFunction(member.type, map);
  }

  /** Calls a value as a function: a closure, or an object with a `call` method. */
  callValue(target: Value, args: Arguments, typeArgs: readonly DartType[], callRow: number | undefined): Value {
    if (target instanceof DartClosure) {
      if (args.isDynamic && !argumentsFit(target.type, args, typeArgs))
        this.throwClosureMismatch(target, args, typeArgs);
      const supplied = args.isDynamic ? this.dynamicTypeArguments(target.type, typeArgs) : typeArgs;
      return target.call(this, target.receiver, args, supplied, callRow);
    }
    if (target === undefined) return this.noSuchMethod(target, 'call', 'method', args);
    return this.invoke(target, 'call', args, typeArgs, callRow);
  }

  private dynamicTypeArguments(type: FunctionType, written: readonly DartType[]): readonly DartType[] {
    const params = type.typeParams;
    if (params.length === 0) return written;
    const args = written.length > 0 ? written : instantiateToBounds(params);
    const env = new Map(params.map((param, index) => [param, args[index]]));
    for (const [index, param] of params.entries()) {
      const bound = substitute(boundOf(param), env);
      if (!isSubtype(args[index], bound))
        this.throwTypeError(
          `type '${vmTypeString(args[index])}' is not a subtype of type '${vmTypeString(bound)}' of '${param.name}'`
        );
    }
    return args;
  }

  /** A dynamic call of a native checks its positional arguments' types as a Dart method's parameters would. */
  private checkNativeArguments(
    receiver: Value,
    member: Member & { kind: 'method' },
    args: Arguments,
    typeArgs: readonly DartType[]
  ): void {
    const type = instantiateFunction(this.memberTypeFor(receiver, member), typeArgs);
    for (const [index, value] of args.positional.entries()) {
      const expected = type.positional[index];
      if (!expected || this.links.isValueOf(this, value, expected)) continue;
      this.throwTypeError(
        `type '${vmTypeString(this.runtimeTypeOf(value))}' is not a subtype of type '${vmTypeString(expected)}' of '${member.nativeParameterNames?.[index] ?? ''}'`
      );
    }
  }

  private throwClosureMismatch(closure: DartClosure, args: Arguments, typeArgs: readonly DartType[]): never {
    const name = closure.description.qualifiedName ?? closure.description.name ?? '<anonymous closure>';
    const types = typeArgs.length > 0 ? `<${typeArgs.map(vmTypeString).join(', ')}>` : '';
    const call = `${name}${types}(${describeArguments(this, args)})`;
    return this.throwError('NoSuchMethodError', '_withMessage', [
      `NoSuchMethodError: Closure call with mismatched arguments: function '${name}'\nReceiver: ${this.links.stringify(this, closure)}\nTried calling: ${call}\nFound: ${name}${vmTypeString(closure.type)}`,
    ]);
  }

  /**
   * Calls the receiver's `noSuchMethod` for a member it lacks, or whose parameters the arguments do not fit (`found`
   * is then the member's signature); Object's throws a NoSuchMethodError.
   */
  noSuchMethod(
    receiver: Value,
    name: string,
    kind: 'method' | 'getter' | 'setter',
    args: Arguments,
    typeArgs: readonly DartType[] = [],
    found?: string
  ): Value {
    const invocation = this.newInvocation(name, kind, args, typeArgs);
    const handler = this.classOf(receiver).implementation('noSuchMethod');
    if (handler?.kind === 'method' && handler.owner !== coreTypes.object) {
      return (handler.impl as NonNullable<typeof handler.impl>)(
        this,
        receiver,
        { positional: [invocation], named: undefined },
        [],
        this.userCallRow
      );
    }
    if (found) return this.throwError('NoSuchMethodError', '_withFound', [receiver, invocation, found]);
    return this.throwError('NoSuchMethodError', '_withInvocation', [receiver, invocation]);
  }

  private newInvocation(
    name: string,
    kind: 'method' | 'getter' | 'setter',
    args: Arguments,
    typeArgs: readonly DartType[]
  ): DartObject {
    const named = this.links.newMap(this, interfaceType(this.links.classNamed('Symbol')), objectType(true), false);
    for (const [key, value] of args.named ?? []) {
      this.invoke(
        named,
        '[]=',
        { positional: [this.links.construct(this, 'Symbol', '', [key]), value], named: undefined },
        [],
        undefined
      );
    }
    return this.links.construct(this, '_InvocationMirror', '_', [
      name,
      BigInt(['method', 'getter', 'setter'].indexOf(kind)),
      new DartList(coreTypes.list, objectType(true), [...args.positional], false, true),
      named,
      new DartList(
        coreTypes.list,
        interfaceType(coreTypes.type),
        typeArgs.map((type) => new DartTypeValue(coreTypes.type, type)),
        false,
        true
      ),
    ]);
  }

  // Equality and hashing

  /** `a == b`, calling the left operand's `==` for objects of the program. */
  equals(a: Value, b: Value): boolean {
    if (this.checkingConstants && a instanceof DartObject && a.cls.implementation('==')?.owner.isLibrary === false)
      this.throwError('ArgumentError', '', ['A constant comparison requires primitive equality']);
    // `==` calls an object's operator even on itself; only a record's own `==` starts with `identical`.
    if (a === b && (!(a instanceof DartObject) || a instanceof DartRecord)) {
      return typeof a !== 'number' || !Number.isNaN(a);
    }
    if (a === undefined || b === undefined) return false;
    switch (typeof a) {
      case 'bigint': {
        return typeof b === 'number' ? Number(a) === b : false;
      }
      case 'number': {
        return typeof b === 'bigint' ? a === Number(b) : a === b;
      }
      case 'string':
      case 'boolean': {
        return false;
      }
      default: {
        return this.invoke(a, '==', { positional: [b], named: undefined }, [], undefined) === true;
      }
    }
  }

  requireConstantKey(value: Value): void {
    if (value instanceof DartRecord) {
      for (const field of value.positional) this.requireConstantKey(field);
      for (const [, field] of value.named) this.requireConstantKey(field);
      return;
    }
    if (
      value instanceof DartObject &&
      ['==', 'hashCode'].some((name) => value.cls.implementation(name)?.owner.isLibrary === false)
    )
      this.throwError('ArgumentError', '', ['A constant key requires primitive equality']);
  }

  // Runtime types

  runtimeTypeOf(value: Value): DartType {
    if (value instanceof DartClosure) return value.type;
    if (value instanceof DartRecord) {
      return {
        kind: 'record',
        positional: value.positional.map((field) => this.runtimeTypeOf(field)),
        named: value.named.map(([name, field]) => ({ name, type: this.runtimeTypeOf(field) })),
        nullable: false,
      };
    }
    if (value === undefined) return { kind: 'null' };
    if (value instanceof DartList && value.vmType) return value.vmType;
    if (value instanceof DartObject) return interfaceType(value.cls, value.typeArgs);
    return interfaceType(this.classOf(value));
  }

  typeValue(type: DartType): DartTypeValue {
    return new DartTypeValue(coreTypes.type, type);
  }

  // Garbage collection

  /** Removes the turtles that no variable, field, or value in flight still reaches. */
  // code-gauge-allow functionCognitiveComplexity 27 -- One case per kind of value garbage collection reaches.
  // code-gauge-allow functionNcss 35 -- One case per kind of value garbage collection reaches.
  collectGarbage(): void {
    if (!this.world.hasTurtles) return;
    const reached = new Set<unknown>();
    const pending: Value[] = [];
    const mark = (value: Value): void => {
      if (value instanceof DartObject && !reached.has(value)) {
        reached.add(value);
        pending.push(value);
      }
    };
    for (const frame of this.frames) {
      for (const cell of frame.locals) if (cell) mark(cell.v);
      for (const cell of frame.captured) mark(cell.v);
      mark(frame.receiver);
      for (const value of frame.temporaries) mark(value);
    }
    for (const cell of this.globals) if (cell) mark(cell.v);
    for (const value of this.constants.values()) mark(value);
    for (const root of this.roots) for (const value of root()) mark(value);
    while (pending.length > 0) {
      const object = pending.pop() as DartObject;
      for (const child of childrenOf(object)) mark(child);
    }
    const turtles = new Set<unknown>();
    for (const object of reached) if ((object as DartObject).turtle) turtles.add((object as DartObject).turtle);
    this.world.retain((turtle) => turtles.has(turtle));
  }
}

function* childrenOf(object: DartObject): Iterable<Value> {
  yield* object.fields;
  if (object instanceof DartList) yield* object.elements;
  if (object instanceof DartRecord) {
    yield* object.positional;
    for (const [, value] of object.named) yield value;
  }
  if (object instanceof DartClosure) {
    yield object.receiver;
    for (const cell of object.captured) yield cell.v;
  }
  if (object.native) {
    yield* object.native.values();
    if (object.native.roots) yield* object.native.roots();
  }
}

function substituteFunction(type: FunctionType, map: Map<TypeParam, DartType>): FunctionType {
  return substitute(type, map) as FunctionType;
}

export { Cell, type ConstructorInfo };

/** Whether arguments fit a function's parameters by count and name, which dynamic calls check before calling. */
function argumentsFit(type: FunctionType, args: Arguments, typeArgs: readonly DartType[]): boolean {
  if (typeArgs.length > 0 && typeArgs.length !== type.typeParams.length) return false;
  const count = args.positional.length;
  if (count < type.requiredCount || count > type.positional.length) return false;
  const names = new Set(type.named.map((named) => named.name));
  for (const name of args.named?.keys() ?? []) if (!names.has(name)) return false;
  return type.named.every((named) => !named.isRequired || args.named?.has(named.name) === true);
}

/** A member's signature as the VM's NoSuchMethodError writes it: its class's type parameters as X0, X1. */
function vmSignature(memberName: string, member: Member & { kind: 'method' }): string {
  const params = member.owner.typeParams;
  const map = new Map(params.map((param, index) => [param, typeParamType(new TypeParam(`X${index}`))]));
  return `${memberName}${vmTypeString(substitute(member.type, map))}`;
}

/** Arguments as `Tried calling:` lists them: positional ones in order, then named ones by name. */
function describeArguments(runtime: Runtime, args: Arguments): string {
  const parts = args.positional.map((value) => runtime.links.stringify(runtime, value));
  const named = [...(args.named ?? new Map<string, Value>())].toSorted(([a], [b]) => (a < b ? -1 : 1));
  for (const [key, value] of named) parts.push(`${key}: ${runtime.links.stringify(runtime, value)}`);
  return parts.join(', ');
}

/**
 * The type of an instance method's tear-off: parameters typed by the class's type parameters are checked when called,
 * so the VM gives them the type Object?, as `[].add` shows `(Object?) => void`.
 */
function covariantErased(member: Member & { kind: 'method' }, type: FunctionType): FunctionType {
  const params = new Set(member.owner.typeParams);
  if (params.size === 0) return type;
  const objectQ = interfaceType(coreTypes.object, [], true);
  const erase = (declared: DartType | undefined, actual: DartType): DartType =>
    declared && mentionsCovariantly(declared, params, true) ? objectQ : actual;
  return {
    ...type,
    positional: type.positional.map((actual, index) => erase(member.type.positional[index], actual)),
    named: type.named.map((named) => ({
      ...named,
      type: erase(member.type.named.find((other) => other.name === named.name)?.type, named.type),
    })),
  };
}

/** Whether a type uses one of the parameters where a value of it flows in, outside the parameters of function types. */
function mentionsCovariantly(type: DartType, params: ReadonlySet<TypeParam>, positive: boolean): boolean {
  switch (type.kind) {
    case 'typeParam': {
      return positive && params.has(type.param);
    }
    case 'interface': {
      return type.args.some((arg) => mentionsCovariantly(arg, params, positive));
    }
    case 'function': {
      return (
        mentionsCovariantly(type.returnType, params, positive) ||
        [...type.positional, ...type.named.map((named) => named.type)].some((parameter) =>
          mentionsCovariantly(parameter, params, !positive)
        )
      );
    }
    case 'record': {
      return [...type.positional, ...type.named.map((field) => field.type)].some((field) =>
        mentionsCovariantly(field, params, positive)
      );
    }
    default: {
      return false;
    }
  }
}
