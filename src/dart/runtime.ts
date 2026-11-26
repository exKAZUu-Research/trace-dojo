import { ExecutionBudget, ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { TurtleWorld } from '../interpreter/turtleWorld';
// code-gauge-allow-file fileNcss -- Keep runtime dispatch alongside reified types, call frames, and roots.
import type { AsyncTask } from './asyncTask';
import {
  type ClassInfo,
  type ConstructorInfo,
  covariantSetter,
  type FieldMember,
  type Member,
  type MethodMember,
  sourceMemberName,
} from './classes';
import { eraseFunctionType } from './eraseExtensionTypes';
import { EventLoop } from './eventLoop';
import { RecordShapes } from './recordShapes';
import {
  asInstanceOf,
  boundOf,
  coreTypes,
  type DartType,
  DYNAMIC,
  type FunctionType,
  instantiateFunction,
  instantiateToBounds,
  type InterfaceType,
  interfaceType,
  isSubtype,
  objectType,
  resolveBound,
  sameType,
  substitute,
  TypeParam,
  typeParamType,
  vmTypeString,
} from './types';
import {
  type Arguments,
  type Callable,
  Cell,
  DartClosure,
  DartList,
  DartObject,
  DartRecord,
  DartTypeValue,
  LateInitializer,
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
  recordFieldNames?: Set<string>;
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
  /** Whether the frame's `async` body is waiting at an `await` or `yield`, so that leaving the frame does not end it. */
  isSuspended = false;
  /** The steps the frame's `async` or `async*` body recorded while it ran, which its driver counts. */
  asyncTask: AsyncTask | undefined;

  // code-gauge-allow functionParameterCount -- The parameters are the parts a caller already holds; grouping them would only rename them.
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
  constantIdentityKey(runtime: Runtime, value: Value): string;
  /** The iterable a `sync*` function returns. */
  syncStarIterable(
    frame: Frame,
    elementType: DartType,
    body: (frame: Frame) => Generator<unknown, unknown, Value>
  ): Value;
  /** Starts an `async` function's body, which runs until its first `await`, and returns its future. */
  startAsync(frame: Frame, valueType: DartType, body: (frame: Frame) => Generator<unknown, unknown, Value>): Value;
  /** The stream an `async*` function returns, whose body starts when the stream is listened to. */
  startAsyncStar(
    frame: Frame,
    elementType: DartType,
    body: (frame: Frame) => Generator<unknown, unknown, Value>
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

interface InstantiatedTearOff {
  typeArguments: readonly DartType[];
  canonical?: DartClosure;
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
  readonly constantStrings = new Map<string, number>();
  /** Structurally distinct constant types that share a display name. */
  readonly constantTypes = new Map<string, DartType[]>();
  /** The canonical tear-offs of top-level functions and static methods. */
  readonly tearOffs = new Map<unknown, DartClosure>();
  private readonly constructorTearOffs = new Map<ConstructorInfo, DartClosure[]>();
  private readonly tearOffConstructors = new WeakMap<DartClosure, ConstructorInfo>();
  private readonly instantiatedTearOffs = new WeakMap<object, InstantiatedTearOff[]>();
  private readonly getterForwarders = new WeakMap<Member, Member>();
  private readonly setterForwarders = new WeakMap<Member, Member>();
  private readonly checkedMethods = new WeakMap<ClassInfo, Map<MethodMember, MethodMember>>();
  private readonly covariantFields = new WeakMap<FieldMember, boolean>();
  private readonly errorTraces = new WeakMap<DartObject, Value>();
  readonly recordShapes = new RecordShapes(this);
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
  private readonly activeCalls: {
    receiver: Value;
    args: Arguments;
    frameDepth: number;
    callRow?: number;
  }[] = [];

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
    this.events = new EventLoop(this);
  }

  readonly events: EventLoop;
  /** The prefixes of `deferred as` imports whose libraries `loadLibrary` has loaded. */
  readonly loadedPrefixes = new Set<string>();
  /** The entry point's frame once its `async` body suspended, which ends the entry point when it completes. */
  private suspendedEntry: Frame | undefined;

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  spendString(length: number): void {
    this.spend(Math.ceil(length / 16));
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
    this.recordShapes.registerFunction(frame.info);
    this.frames.push(frame);
  }

  private overflowing = false;

  exit(frame: Frame): void {
    if (this.onMainExit) {
      const isEntry = this.frames.length === 1 ? this.suspendedEntry === undefined : frame === this.suspendedEntry;
      if (isEntry && frame.isSuspended) {
        this.suspendedEntry = frame;
      } else if (isEntry || frame === this.suspendedEntry) {
        // The entry point's frame still holds its variables, which the end of a trace shows.
        const callback = this.onMainExit;
        this.onMainExit = undefined;
        callback();
      }
    }
    const top = this.frames.pop();
    if (top !== frame) throw new Error('The frames got out of order');
    if (frame.info.isAtomic) this.steps.completeAtomicCall();
  }

  get currentFrame(): Frame | undefined {
    return this.frames.at(-1);
  }

  get userCallRow(): number | undefined {
    const nativeCall = this.activeCalls.findLast((call) => call.callRow !== undefined);
    for (let index = this.frames.length - 1; index >= 0; index--) {
      if (nativeCall?.frameDepth === index + 1) return nativeCall.callRow;
      const frame = this.frames[index];
      if (!frame.info.isLibrary) return undefined;
      if (frame.callRow !== undefined) return frame.callRow;
    }
    return undefined;
  }

  throwError(className: string, constructorName: string, args: Value[], named?: Record<string, Value>): never {
    throw this.newThrow(this.links.construct(this, className, constructorName, args, named));
  }

  newThrow(value: Value, stackTrace: Value = this.newStackTrace()): DartThrow {
    if (value instanceof DartObject && !this.errorTraces.has(value)) {
      const errorClass = this.links.classNamed('Error');
      for (const cls of value.cls.superclassChain()) {
        if (cls !== errorClass) continue;
        this.errorTraces.set(value, stackTrace);
        break;
      }
    }
    return new DartThrow(value, stackTrace);
  }

  private newStackTrace(): DartObject {
    this.allocate(1);
    return new DartObject(this.links.classNamed('_StackTrace'), [], []);
  }

  errorStackTrace(value: Value): Value {
    return value instanceof DartObject ? this.errorTraces.get(value) : undefined;
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
    const member = this.instanceMember(this.classOf(receiver), name);
    if (member?.kind === 'method') {
      if (args.invocation && !argumentsFit(member.type, args, typeArgs)) {
        return this.noSuchMethod(receiver, name, 'method', args, typeArgs, vmSignature(name, member));
      }
      const signature = args.invocation ? this.memberTypeFor(receiver, member) : undefined;
      const supplied = signature ? this.dynamicTypeArguments(signature, typeArgs, args.invocation) : typeArgs;
      if (signature && member.nativeParameterNames) this.checkNativeArguments(member, args, supplied, signature);
      return (member.impl as NonNullable<typeof member.impl>)(this, receiver, args, supplied, callRow);
    }
    if (member) return this.callGetterValue(receiver, member, args, typeArgs, callRow);
    if (receiver instanceof DartRecord)
      return this.callValue(this.getProperty(receiver, name, callRow), args, typeArgs, callRow);
    return this.noSuchMethod(receiver, name, 'method', args, typeArgs);
  }

  callGetterValue(
    receiver: Value,
    member: Member,
    args: Arguments,
    typeArgs: readonly DartType[],
    callRow: number | undefined
  ): Value {
    return this.withCallRoots(receiver, args, () =>
      this.callValue(this.readMember(receiver, member, callRow), args, typeArgs, callRow)
    );
  }

  getProperty(receiver: Value, name: string, callRow: number | undefined): Value {
    // A function's `call` is the function itself.
    if (name === 'call' && receiver instanceof DartClosure) return receiver;
    const member = this.instanceMember(this.classOf(receiver), name);
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
  checkFieldWrite(receiver: DartObject, field: FieldMember, value: Value, isDynamic = false): void {
    if (!isDynamic) {
      let check = this.covariantFields.get(field);
      if (check === undefined) {
        check = covariantSetter(field.owner, field.name, field.type, field.isCovariant);
        this.covariantFields.set(field, check);
      }
      if (!check) return;
    }
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
    const member = this.instanceMember(this.classOf(receiver), name, true);
    if (!member) {
      this.noSuchMethod(receiver, `${name}=`, 'setter', { positional: [value], named: undefined });
      return;
    }
    if (member.kind === 'field') {
      const object = receiver as DartObject;
      this.checkFieldWrite(object, member, value, isDynamic);
      object.fields[member.slot] = value;
      return;
    }
    (member.impl as NonNullable<typeof member.impl>)(
      this,
      receiver,
      { positional: [value], named: undefined, invocation: isDynamic ? 'dynamic' : undefined },
      [],
      callRow
    );
  }

  instanceMember(cls: ClassInfo, name: string, setter = false): Member | undefined {
    const concrete = setter ? cls.setterImplementation(name) : cls.implementation(name);
    if (concrete?.kind === 'method') return this.checkedImplementation(cls, concrete);
    return concrete ?? this.forwardedMember(cls, name, setter);
  }

  private forwardedMember(cls: ClassInfo, name: string, setter: boolean): Member | undefined {
    const declared = cls.forwardingDeclaration(name, setter);
    if (!declared) return undefined;
    const cache = setter ? this.setterForwarders : this.getterForwarders;
    const existing = cache.get(declared);
    if (existing) return existing;
    const kind = setter ? 'setter' : declared.kind === 'method' ? 'method' : 'getter';
    const impl: Callable = (runtime, value, args, types) =>
      runtime.invokeForwarder(value, name, kind, declared, args, types);
    const forwarder: Member =
      kind === 'method' && declared.kind === 'method'
        ? { ...declared, isAbstract: false, impl }
        : setter
          ? { ...declared, kind: 'setter', isAbstract: false, impl }
          : { ...declared, kind: 'getter', isAbstract: false, impl };
    cache.set(declared, forwarder);
    return forwarder;
  }

  private checkedImplementation(cls: ClassInfo, member: MethodMember): MethodMember {
    const methods = this.checkedMethods.get(cls) ?? new Map<MethodMember, MethodMember>();
    this.checkedMethods.set(cls, methods);
    const existing = methods.get(member);
    if (existing) return existing;
    const contract = cls.covarianceFor(member);
    if (!contract) {
      methods.set(member, member);
      return member;
    }
    const { obligation, positions } = contract;
    const impl = member.impl as Callable;
    const checked: MethodMember = {
      ...obligation,
      isAbstract: false,
      covariantPositional: new Set([...(obligation.covariantPositional ?? []), ...positions]),
      impl: (runtime, receiver, args, types, row) => {
        const bound = obligation.forwarding?.bind?.(runtime, receiver, args, types) ?? args;
        const signature = instantiateFunction(runtime.memberTypeFor(receiver, member), types);
        for (const index of positions) {
          if (index >= bound.positional.length) continue;
          const name = member.forwarding?.positionalNames[index] ?? '';
          runtime.checkForwardedType(bound.positional[index], signature.positional[index], name);
        }
        return impl(runtime, receiver, bound, types, row);
      },
    };
    methods.set(member, checked);
    return checked;
  }

  private invokeForwarder(
    receiver: Value,
    name: string,
    kind: 'method' | 'getter' | 'setter',
    declared: Member,
    args: Arguments,
    typeArgs: readonly DartType[]
  ): Value {
    const reifiedType = this.reifyMemberType(receiver, declared);
    const bound = declared.forwarding?.bind?.(this, receiver, args, typeArgs);
    if (!bound && kind === 'setter') this.checkForwardedType(args.positional[0], reifiedType, 'value');
    const invocationName = kind === 'setter' ? `${name}=` : name;
    const result = this.noSuchMethod(receiver, invocationName, kind, bound ?? args, typeArgs);
    if (kind !== 'setter') {
      const resultType =
        declared.kind === 'method'
          ? instantiateFunction(reifiedType as FunctionType, typeArgs).returnType
          : reifiedType;
      this.checkForwardedType(result, resultType);
    }
    return result;
  }

  private checkForwardedType(value: Value, expected: DartType, parameter?: string): void {
    if (expected.kind === 'void' || this.links.isValueOf(this, value, expected)) return;
    const argument = parameter === undefined ? '' : ` of '${parameter}'`;
    this.throwTypeError(
      `type '${vmTypeString(this.runtimeTypeOf(value))}' is not a subtype of type '${vmTypeString(expected)}'${argument}`
    );
  }

  /** A method's tear-off, which is equal to another tear-off of the same method from the same receiver. */
  tearOff(receiver: Value, member: Member & { kind: 'method' }, staticSignature?: FunctionType): DartClosure {
    // A static method's tear-off is canonical, as a top-level function's is.
    if (member.isStatic) {
      const existing = this.tearOffs.get(member);
      if (existing) return existing;
    }
    const closure = this.newTearOff(receiver, member, staticSignature);
    if (member.isStatic) this.tearOffs.set(member, closure);
    return closure;
  }

  instantiateTearOff(original: DartClosure, typeArguments: readonly DartType[]): DartClosure {
    const type = instantiateFunction(original.type, typeArguments);
    const make = (key: object | undefined): DartClosure =>
      new DartClosure(
        coreTypes.function,
        type,
        (runtime, _receiver, args, _written, row) => runtime.callValue(original, args, typeArguments, row),
        original.receiver,
        [new Cell(original)],
        original.description,
        key
      );
    const constructor = this.tearOffConstructors.get(original);
    if (constructor) return this.constructorTearOff(constructor, type, () => make(undefined));
    const key = original.tearOffKey ?? original;
    const instances = this.instantiatedTearOffs.get(key) ?? [];
    let instance = instances.find((other) => {
      this.spend();
      return (
        other.typeArguments.length === typeArguments.length &&
        other.typeArguments.every((argument, index) => sameType(argument, typeArguments[index]))
      );
    });
    if (!instance) {
      instance = { typeArguments };
      instances.push(instance);
      this.instantiatedTearOffs.set(key, instances);
    }
    if (instance.canonical) return instance.canonical;
    this.allocate(1);
    const closure = make(instance);
    if (this.tearOffs.get(key) === original) instance.canonical = closure;
    return closure;
  }

  constructorTearOff(constructor: ConstructorInfo, type: FunctionType, create: () => DartClosure): DartClosure {
    const closures = this.constructorTearOffs.get(constructor) ?? [];
    for (const closure of closures) {
      this.spend();
      if (sameType(closure.type, type)) return closure;
    }
    this.allocate(1);
    const closure = create();
    closures.push(closure);
    this.constructorTearOffs.set(constructor, closures);
    this.tearOffConstructors.set(closure, constructor);
    return closure;
  }

  private newTearOff(
    receiver: Value,
    member: Member & { kind: 'method' },
    staticSignature?: FunctionType
  ): DartClosure {
    const impl = member.impl as NonNullable<typeof member.impl>;
    const signature = staticSignature ? eraseFunctionType(staticSignature) : this.memberTypeFor(receiver, member);
    const type = staticSignature || member.isStatic ? signature : covariantErased(member, signature);
    return new DartClosure(
      coreTypes.function,
      type,
      (runtime, _receiver, args, typeArgs, callRow) => {
        if (args.invocation && member.nativeParameterNames)
          runtime.checkNativeArguments(member, args, typeArgs, signature);
        return impl(runtime, receiver, args, typeArgs, callRow);
      },
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
    return eraseFunctionType(this.reifyMemberType(receiver, member) as FunctionType);
  }

  private reifyMemberType(receiver: Value, member: Member): DartType {
    if (member.owner.typeParams.length === 0 || member.isStatic) return member.type;
    const instance = asInstanceOf(this.runtimeTypeOf(receiver) as InterfaceType, member.owner);
    if (!instance) return member.type;
    const map = new Map(member.owner.typeParams.map((param, index) => [param, instance.args[index]]));
    return substitute(member.type, map);
  }

  /** Calls a value as a function: a closure, or an object with a `call` method. */
  callValue(target: Value, args: Arguments, typeArgs: readonly DartType[], callRow: number | undefined): Value {
    if (target instanceof DartClosure) {
      if (args.invocation && !argumentsFit(target.type, args, typeArgs))
        this.throwClosureMismatch(target, args, typeArgs);
      const supplied = args.invocation
        ? this.dynamicTypeArguments(target.type, typeArgs, args.invocation, target.dynamicTypeArgumentDefaults)
        : typeArgs;
      return target.call(this, target.receiver, args, supplied, callRow);
    }
    if (target === undefined) return this.noSuchMethod(target, 'call', 'method', args);
    return this.invoke(target, 'call', args, typeArgs, callRow);
  }

  private dynamicTypeArguments(
    type: FunctionType,
    written: readonly DartType[],
    invocation: Arguments['invocation'],
    defaults?: readonly DartType[]
  ): readonly DartType[] {
    const params = type.typeParams;
    if (params.length === 0) return written;
    const args = written.length > 0 ? written : (defaults ?? instantiateToBounds(params));
    const env = new Map(params.map((param, index) => [param, args[index]]));
    for (const [index, param] of params.entries()) {
      const bound = substitute(boundOf(param), env);
      if (!isSubtype(args[index], bound)) {
        const actual = invocation === 'apply' ? '_Type' : vmTypeString(args[index]);
        this.throwTypeError(`type '${actual}' is not a subtype of type '${vmTypeString(bound)}' of '${param.name}'`);
      }
    }
    return args;
  }

  private checkNativeArguments(
    member: Member & { kind: 'method' },
    args: Arguments,
    typeArgs: readonly DartType[],
    signature: FunctionType
  ): void {
    const type = instantiateFunction(signature, typeArgs);
    for (const [index, value] of args.positional.entries())
      this.checkNativeArgument(value, type.positional[index], member.nativeParameterNames?.[index] ?? '');
    for (const { name, type: expected } of type.named) {
      if (args.named?.has(name)) this.checkNativeArgument(args.named.get(name), expected, name);
    }
  }

  private checkNativeArgument(value: Value, expected: DartType | undefined, name: string): void {
    if (!expected || this.links.isValueOf(this, value, expected)) return;
    this.throwTypeError(
      `type '${vmTypeString(this.runtimeTypeOf(value))}' is not a subtype of type '${vmTypeString(expected)}' of '${name}'`
    );
  }

  private throwClosureMismatch(closure: DartClosure, args: Arguments, typeArgs: readonly DartType[]): never {
    const name = closure.description.qualifiedName ?? closure.description.name ?? '<anonymous closure>';
    const invocation = this.newInvocation(name, 'method', args, typeArgs);
    return this.throwError('NoSuchMethodError', '_withFound', [
      closure,
      invocation,
      `${name}${vmTypeString(closure.type)}`,
    ]);
  }

  throwMissingExternal(
    owner: string | undefined,
    name: string,
    kind: 'method' | 'getter' | 'setter',
    args: Arguments,
    typeArgs: readonly DartType[]
  ): never {
    return this.throwError('NoSuchMethodError', '_withExternal', [
      owner,
      this.newInvocation(name, kind, args, typeArgs),
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

  symbol(name: string, library?: string): Value {
    return library === undefined
      ? this.links.construct(this, '_Symbol', '', [name])
      : this.links.construct(this, '_Symbol', '_scoped', [name, library]);
  }

  private newInvocation(
    name: string,
    kind: 'method' | 'getter' | 'setter',
    args: Arguments,
    typeArgs: readonly DartType[]
  ): DartObject {
    this.allocate(2 + args.positional.length + typeArgs.length);
    const named = this.links.newMap(this, interfaceType(this.links.classNamed('Symbol')), objectType(true), false);
    for (const [key, value] of args.named ?? []) {
      this.invoke(named, '[]=', { positional: [this.symbol(key), value], named: undefined }, [], undefined);
    }
    const scopeEnd = name.indexOf('\0');
    const symbol = this.symbol(sourceMemberName(name), scopeEnd === -1 ? undefined : name.slice(0, scopeEnd));
    const positionalType = args.positional.length === 0 ? objectType(true) : DYNAMIC;
    return this.links.construct(this, '_InvocationMirror', '_', [
      symbol,
      BigInt(['method', 'getter', 'setter'].indexOf(kind)),
      new DartList(coreTypes.list, positionalType, [...args.positional], false, true),
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
    if (value instanceof DartObject) return interfaceType(value.cls, value.typeArgs);
    return interfaceType(this.classOf(value));
  }

  typeValue(type: DartType): DartTypeValue {
    return new DartTypeValue(coreTypes.type, type);
  }

  // Garbage collection

  withCallRoots<T>(receiver: Value, args: Arguments, call: () => T, callRow?: number): T {
    this.activeCalls.push({ receiver, args, frameDepth: this.frames.length, callRow });
    try {
      return call();
    } finally {
      this.activeCalls.pop();
    }
  }

  /** Removes the turtles that no variable, field, or value in flight still reaches. */
  // code-gauge-allow functionCognitiveComplexity -- One case per kind of value garbage collection reaches.
  // code-gauge-allow functionNcss -- One case per kind of value garbage collection reaches.
  collectGarbage(): void {
    if (!this.world.hasTurtles) return;
    const reached = new Set<DartObject>();
    const pending: DartObject[] = [];
    const mark = (root: Value): void => markRoot(root, reached, pending);
    for (const frame of this.frames) {
      for (const cell of frame.locals) if (cell) mark(cell.v);
      for (const cell of frame.captured) mark(cell.v);
      mark(frame.receiver);
      for (const value of frame.temporaries) mark(value);
    }
    for (const cell of this.globals) if (cell) mark(cell.v);
    for (const value of this.constants.values()) mark(value);
    for (const root of this.roots) for (const value of root()) mark(value);
    for (const value of this.activeCallValues()) mark(value);
    while (pending.length > 0) {
      const object = pending.pop() as DartObject;
      mark(this.errorTraces.get(object));
      for (const child of childrenOf(object)) mark(child);
    }
    const turtles = new Set<unknown>();
    for (const object of reached) if (object.turtle) turtles.add(object.turtle);
    this.world.retain((turtle) => turtles.has(turtle));
  }

  private *activeCallValues(): Iterable<Value> {
    for (const { receiver, args } of this.activeCalls) {
      yield receiver;
      yield* args.positional;
      if (args.named) yield* args.named.values();
    }
  }
}

function markRoot(root: Value | DartThrow, reached: Set<DartObject>, pending: DartObject[]): void {
  if (root instanceof DartThrow) {
    markRoot(root.value, reached, pending);
    markRoot(root.stackTrace, reached, pending);
    return;
  }
  const value = root instanceof LateInitializer ? root.closure : root;
  if (value instanceof DartObject && !reached.has(value)) {
    reached.add(value);
    pending.push(value);
  }
}

function* childrenOf(object: DartObject): Iterable<Value> {
  yield* object.fields;
  if (object instanceof DartList && listCanReachObjects(object)) yield* object.elements;
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

function listCanReachObjects(list: DartList): boolean {
  const element = list.typeArgs[0];
  if (!element) return true;
  const type = resolveBound(element);
  if (type.kind === 'null' || type.kind === 'never') return false;
  if (type.kind !== 'interface') return true;
  const { cls } = type;
  return (
    cls !== coreTypes.int &&
    cls !== coreTypes.double &&
    cls !== coreTypes.num &&
    cls !== coreTypes.bool &&
    cls !== coreTypes.string
  );
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

/**
 * The type of an instance method's tear-off: parameters typed by the class's type parameters are checked when called,
 * so the VM gives them the type Object?, as `[].add` shows `(Object?) => void`.
 */
function covariantErased(member: Member & { kind: 'method' }, type: FunctionType): FunctionType {
  if (!member.covariantPositional?.size && !member.covariantNamed?.size) return type;
  const objectQ = interfaceType(coreTypes.object, [], true);
  return {
    ...type,
    positional: type.positional.map((actual, index) => (member.covariantPositional?.has(index) ? objectQ : actual)),
    named: type.named.map((named) => ({
      ...named,
      type: member.covariantNamed?.has(named.name) ? objectQ : named.type,
    })),
  };
}
