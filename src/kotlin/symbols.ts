import type { VISIBILITY_KEYWORDS } from './ast';
import type { FunctionContext, ReceiverSymbol } from './compilerBase';
import type { Frame, FunctionInfo, Invoker, SuspendInvoker } from './runtime';
import type { ClassType, KType } from './types';
import type { Value } from './values';

export type Visibility = (typeof VISIBILITY_KEYWORDS)[number];

export class TypeParameterSymbol {
  bounds: KType[] = [];
  projectionLowerBound: KType | undefined;

  constructor(
    readonly name: string,
    readonly variance: 'inv' | 'in' | 'out',
    readonly isReified: boolean,
    readonly onlyInputTypes = false
  ) {}
}

/** A `typealias`, which stands for its expansion with its type parameters replaced by the arguments of a use. */
export class TypeAliasSymbol {
  typeParameters: TypeParameterSymbol[] = [];
  /** The type the alias stands for, resolved when first used. */
  expansion: KType | undefined;
  isResolving = false;
  visibility: Visibility = 'public';

  constructor(
    readonly name: string,
    readonly row: number,
    /** Resolves the expansion in the scope of the declaration, after declaring the alias's type parameters. */
    readonly resolve: () => { typeParameters: TypeParameterSymbol[]; expansion: KType }
  ) {}
}

export type ClassSymbolKind = 'class' | 'interface' | 'object' | 'companion' | 'enum' | 'enumEntry';

export interface EnumEntrySymbol {
  name: string;
  ordinal: number;
}

export class ClassSymbol {
  typeParameters: TypeParameterSymbol[] = [];
  superclass: ClassType | undefined;
  interfaces: ClassType[] = [];
  readonly members = new Map<string, MemberSymbol[]>();
  readonly constructors: FunctionSymbol[] = [];
  readonly nested = new Map<string, ClassSymbol>();
  readonly typeAliases = new Map<string, TypeAliasSymbol>();
  /** For an enum class, the classes of its entries that have bodies, as `PLUS { ... }`, by the entries' names. */
  readonly enumEntryClasses = new Map<string, ClassSymbol>();
  companion: ClassSymbol | undefined;
  enumEntries: EnumEntrySymbol[] = [];
  /** The subclasses of a sealed class, which `when` must cover to be exhaustive. */
  readonly sealedSubclasses: ClassSymbol[] = [];
  isOpen = false;
  isAbstract = false;
  isSealed = false;
  isData = false;
  isValue = false;
  /** Whether natives create and initialize the instances, as for the library's `external` classes. */
  isNative = false;
  /** Whether the class is a `fun interface`, which a lambda converts to. */
  isFunInterface = false;
  /** Whether the class is declared in a function body, which `KClass.qualifiedName` does not name. */
  isLocal = false;
  /** Whether the class is an object expression's, which has no name. */
  isAnonymous = false;
  /** Whether the class is an `annotation class`. */
  isAnnotation = false;
  /** The opt-in markers on the class, as `@Exp` of `@RequiresOptIn annotation class Exp`, which its uses need. */
  optInMarkers: ClassSymbol[] = [];
  /** The markers the class's code is opted in to: those its `@OptIn` names and those it carries. */
  optIns: ClassSymbol[] = [];
  /** Whether the class is `inner`, whose instances hold an instance of the class around it. */
  isInner = false;
  /** For an inner class, the slot of the field that holds the instance of the class around it. */
  outerSlot: number | undefined;
  /** For an annotation class, the annotations written on it, whose `@Target` and `@Repeatable` say where it applies. */
  ownAnnotations: readonly { name: string; args?: readonly { value: unknown }[] }[] = [];
  visibility: Visibility = 'public';
  /** The number of fields each instance holds, its superclasses' first. */
  fieldCount = 0;
  /** The value of each field before its initializer runs: the JVM's default of its type (0, false, or null). */
  fieldDefaults: Value[] = [];
  /** The member that runs for each overridable member, by the member it overrides first. */
  readonly vtable = new Map<MemberSymbol, MemberSymbol>();
  /** The instance fields of the class itself, which traces show and data classes compare. */
  readonly ownFields: PropertySymbol[] = [];
  /** Sets up a new instance: runs property initializers and `init` blocks after the superclass's constructor. */
  initialize: ((frame: Frame, instance: Value) => void) | undefined;
  initializeEnumEntries: ((frame: Frame) => void) | undefined;
  row = 0;
  isLibrary = false;
  /** The name Kotlin's runtime messages use, such as `kotlin.String`; set with the package. */
  kotlinName: string;
  readonly type: ClassType;

  constructor(
    readonly kind: ClassSymbolKind,
    readonly name: string,
    /** The name `toString` of an exception and of a default object prints, such as `java.lang.Exception`. */
    public qualifiedName: string,
    readonly outer: ClassSymbol | undefined
  ) {
    this.type = { kind: 'class', cls: this, args: [], nullable: false };
    this.kotlinName = qualifiedName;
  }

  /** The type of the class itself, with its own type parameters as arguments. */
  get selfType(): ClassType {
    return {
      kind: 'class',
      cls: this,
      args: this.typeParameters.map((param) => ({ variance: 'inv', type: { kind: 'param', param, nullable: false } })),
      nullable: false,
    };
  }

  get supertypes(): ClassType[] {
    return this.superclass ? [this.superclass, ...this.interfaces] : this.interfaces;
  }

  get isInterface(): boolean {
    return this.kind === 'interface';
  }

  get isObject(): boolean {
    return this.kind === 'object' || this.kind === 'companion';
  }

  /** Whether a program may declare a subclass. */
  get isInheritable(): boolean {
    return this.isOpen || this.isAbstract || this.isSealed || this.isInterface;
  }

  addMember(member: MemberSymbol): void {
    const existing = this.members.get(member.name);
    if (existing) existing.push(member);
    else this.members.set(member.name, [member]);
  }

  /** Whether the class is `other` or inherits from it. */
  isSubclassOf(other: ClassSymbol): boolean {
    if (this === other) return true;
    return this.supertypes.some((type) => type.cls.isSubclassOf(other));
  }

  /** The member that runs for `member` on instances of this class. */
  dispatch<T extends MemberSymbol>(member: T): T {
    return (this.vtable.get(member.root) as T | undefined) ?? member;
  }
}

export interface ParameterSymbol {
  name: string;
  type: KType;
  hasDefault: boolean;
  defaultOwner?: FunctionSymbol;
  isVararg: boolean;
  blocksNonlocalControl?: boolean;
  invokesExactlyOnce?: boolean;
  /** Computes the default value in the callee's frame, where the earlier parameters are set. */
  defaultValue?: (frame: Frame) => Value;
}

interface MemberBase {
  name: string;
  /** The class that declares a member, or `undefined` for a top-level or local declaration. */
  owner: ClassSymbol | undefined;
  /** The receiver type of an extension, as in `fun String.bold()`. */
  extensionReceiver: KType | undefined;
  typeParameters: TypeParameterSymbol[];
  visibility: Visibility;
  isAbstract: boolean;
  isOpen: boolean;
  isOverride: boolean;
  /** The members this one overrides, directly. */
  overridden: MemberSymbol[];
  /** The member this one overrides first, which dispatch looks up. */
  root: MemberSymbol;
  row: number;
  isLibrary: boolean;
  /** The package a top-level declaration belongs to, which imports name. */
  packageName: string;
}

export class FunctionSymbol implements MemberBase {
  readonly kind = 'function';
  owner: ClassSymbol | undefined;
  extensionReceiver: KType | undefined;
  typeParameters: TypeParameterSymbol[] = [];
  params: ParameterSymbol[] = [];
  /** `undefined` until the body of a function without a declared result type has been checked. */
  returnType: KType | undefined;
  visibility: Visibility = 'public';
  isAbstract = false;
  isOpen = false;
  isOverride = false;
  isInline = false;
  /** The context parameters of `context(name: Type) fun f()`, which calls pass after the arguments. */
  contextParameters: { name: string; type: KType }[] = [];
  /** Whether calls pass the instance of the class that declares the extension, after the context arguments. */
  passesDispatchReceiver = false;
  /** Whether calls pass the type arguments of the function's reified type parameters after its arguments. */
  passesTypeArguments = false;
  /** The opt-in markers on the function, which its calls need. */
  optInMarkers: ClassSymbol[] = [];
  /** The markers the function's code is opted in to. */
  optIns: ClassSymbol[] = [];
  /** Whether the function is `suspend`, which only coroutines and other suspend functions call. */
  isSuspend = false;
  /** Runs a suspend function as a coroutine's step, which suspends where the generator yields. */
  invokeSuspend: SuspendInvoker | undefined;
  /** Whether the function is `tailrec`, whose calls of itself in tail position reuse its frame. */
  isTailrec = false;
  resolvesByLambdaResult = false;
  isDeprecatedError = false;
  isInfix = false;
  isOperator = false;
  isConstructor = false;
  /** Whether `// atomic` marks the function, so that its steps are part of its caller's. */
  isAtomic = false;
  overridden: MemberSymbol[] = [];
  root: MemberSymbol = this;
  row = 0;
  isLibrary = false;
  packageName = '';
  /** Runs the function; set when its body is compiled or its native implementation is bound. */
  invoke: Invoker | undefined;
  /** The frame layout used to compute defaults from the receiver and earlier parameters. */
  defaultsInfo: FunctionInfo | undefined;
  /** For a constructor, runs it on an instance that a subclass's constructor or `invoke` allocated. */
  initialize: ((caller: Frame, instance: Value, args: Value[], callRow: number | undefined) => void) | undefined;

  constructor(readonly name: string) {}
}

export class PropertySymbol implements MemberBase {
  readonly kind = 'property';
  owner: ClassSymbol | undefined;
  extensionReceiver: KType | undefined;
  typeParameters: TypeParameterSymbol[] = [];
  /** `undefined` until the initializer of a property without a declared type has been checked. */
  type: KType | undefined;
  isVar = false;
  visibility: Visibility = 'public';
  isAbstract = false;
  isOpen = false;
  isOverride = false;
  overridden: MemberSymbol[] = [];
  root: MemberSymbol = this;
  row = 0;
  isLibrary = false;
  packageName = '';
  /** The slot of the backing field in each instance, or in the program's globals for a top-level property. */
  slot: number | undefined;
  backingFieldReferenced = false;
  /** Whether reading the property may return a different value each time, which rules out smart casts. */
  hasCustomGetter = false;
  get: ((frame: Frame, receiver: Value) => Value) | undefined;
  set: ((frame: Frame, receiver: Value, value: Value) => void) | undefined;
  /** The value of a constant initializer, such as `0` in `var count = 0`, which a trace shows before it runs. */
  constantInitializer: Value | undefined;
  /** The visibility of a `var`'s setter, such as `private set`. */
  setterVisibility: Visibility = 'public';
  /** The opt-in markers on the property, which its uses need. */
  optInMarkers: ClassSymbol[] = [];
  /** The markers the property's code is opted in to. */
  optIns: ClassSymbol[] = [];
  /** Whether the property is `lateinit`, whose read before its first assignment throws. */
  isLateinit = false;
  /** Whether the property is a `const val`, a compile-time constant. */
  isConst = false;

  constructor(readonly name: string) {}
}

export type MemberSymbol = FunctionSymbol | PropertySymbol;

/** A local variable or parameter. */
export class VariableSymbol {
  readonly capturedWriteTypes = new Set<KType>();
  /** Whether a lambda captures the `var`, which then lives in a cell that the lambda and the function share. */
  isCell = false;
  /** The function or lambda whose frame holds the variable. */
  owner: FunctionContext | undefined;
  /** For a name the compiler binds to a computed value, such as a delegated local's `getValue`, how to read it. */
  delegateRead: ((frame: Frame) => Value) | undefined;
  backingField: { property: PropertySymbol; receiver: ReceiverSymbol | undefined } | undefined;
  localDelegate:
    | {
        holder: VariableSymbol;
        read: (frame: Frame, delegate: Value) => Value;
        write: ((frame: Frame, delegate: Value, value: Value) => void) | undefined;
      }
    | undefined;
  /** Whether the variable is a `val` declared without a value, which one assignment may give it later. */
  awaitsValue = false;
  /** Whether the variable is a `lateinit var`, whose read before its first assignment throws. */
  isLateinit = false;
  /** Whether the variable is a context parameter, which calls needing a context of its type receive. */
  isContextParameter = false;
  isParameter = false;

  constructor(
    readonly name: string,
    public type: KType,
    readonly isVar: boolean,
    /** The nesting depth of the function whose frame holds the variable. */
    readonly depth: number,
    readonly slot: number,
    readonly row: number
  ) {}
}
