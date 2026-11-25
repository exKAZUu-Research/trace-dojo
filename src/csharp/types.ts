// code-gauge-allow-file fileNcss -- The types module keeps the symbols and types that every stage shares together.
import type {
  ArrayInitializer,
  ConstructorDeclaration,
  Expression,
  MethodDeclaration,
  OperatorDeclaration,
  Position,
  PropertyDeclaration,
  TypeDeclaration,
} from './ast';
import type { CallerInfo } from './attributeBinder';
import type { TypeContext } from './binderBase';
import type { BoundBlock, BoundExpression } from './bound';
import type { NativeMethod } from './natives';

/** The C# keyword types and the kinds of values the interpreter keeps for them. */
export type SpecialType =
  | 'object'
  | 'string'
  | 'bool'
  | 'char'
  | 'sbyte'
  | 'byte'
  | 'short'
  | 'ushort'
  | 'int'
  | 'uint'
  | 'long'
  | 'ulong'
  | 'float'
  | 'double'
  | 'decimal'
  | 'void'
  | 'nullable'
  | 'valueType'
  | 'enum'
  | 'array'
  | 'delegate'
  | 'multicastDelegate'
  | 'exception'
  | 'valueTuple';

export type Accessibility =
  | 'public'
  | 'private'
  | 'protected'
  | 'internal'
  | 'protected internal'
  | 'private protected';

export interface NamedType {
  kind: 'named';
  symbol: TypeSymbol;
  args: Type[];
  /** The element names of a tuple type, which only the compiler sees. */
  tupleNames?: (string | undefined)[];
  /** Whether a reference type is written nullable, as `string?`, which only Roslyn's messages show. */
  isAnnotated?: boolean;
}

export interface ArrayType {
  kind: 'array';
  element: Type;
  rank: number;
  isAnnotated?: boolean;
}

export interface TypeParameterType {
  kind: 'typeParameter';
  symbol: TypeParameterSymbol;
  isAnnotated?: boolean;
}

/** The types that only expressions have, never variables. */
export type SpecialExpressionType = { kind: 'null' } | { kind: 'error' } | { kind: 'void' };

export type Type = NamedType | ArrayType | TypeParameterType | SpecialExpressionType;

/**
 * The most elements of a tuple type that the library declares, each arity as one flat `ValueTuple`; .NET nests the
 * elements after the seventh in a `TRest` tuple, which only the runtime type names show.
 */
export const MAX_TUPLE_ARITY = 64;

export const NULL_TYPE: Type = { kind: 'null' };
export const ERROR_TYPE: Type = { kind: 'error' };
export const VOID_TYPE: Type = { kind: 'void' };

export class TypeParameterSymbol {
  /** The interfaces and the class that the type argument must derive from. */
  constraintTypes: Type[] = [];
  hasReferenceConstraint = false;
  hasValueConstraint = false;
  hasConstructorConstraint = false;
  hasNotNullConstraint = false;
  /** The `unmanaged` constraint, which also makes the parameter a value type. */
  hasUnmanagedConstraint = false;

  constructor(
    readonly name: string,
    /** The type or method that declares the parameter. */
    readonly owner: TypeSymbol | MethodSymbol,
    readonly ordinal: number,
    readonly variance: 'in' | 'out' | undefined
  ) {}

  get type(): TypeParameterType {
    return { kind: 'typeParameter', symbol: this };
  }
}

export interface ParameterSymbol {
  name: string;
  type: Type;
  refKind: 'ref' | 'out' | 'in' | undefined;
  isParams: boolean;
  /** The value an omitted optional argument takes, already converted to the parameter's type. */
  defaultValue?: { value: unknown };
  /** The default value before binding, which members bind once their types are known. */
  defaultSyntax?: Expression;
  /** The names in scope where the default value is written, such as the declaring type's constants. */
  defaultContext?: TypeContext;
  /** What a `[Caller...]` attribute makes an omitted argument receive. */
  callerInfo?: CallerInfo;
  position?: Position;
}

export type MethodKind =
  | 'method'
  | 'constructor'
  | 'staticConstructor'
  | 'operator'
  | 'getter'
  | 'setter'
  | 'localFunction'
  | 'destructor'
  | 'delegateInvoke';

/**
 * What an async function's return type makes of its body: a task (`Task`, `Task<T>`, `ValueTask`, `ValueTask<T>`) that
 * its `return` completes with `resultType`, nothing (`async void`), or an async stream of `resultType` values.
 */
export interface AsyncShape {
  kind: 'void' | 'task' | 'valueTask' | 'asyncEnumerable' | 'asyncEnumerator';
  resultType: Type;
}

export class MethodSymbol {
  typeParameters: TypeParameterSymbol[] = [];
  parameters: ParameterSymbol[] = [];
  returnType: Type = VOID_TYPE;
  isStatic = false;
  isVirtual = false;
  isAbstract = false;
  isOverride = false;
  isSealed = false;
  isNew = false;
  isExtension = false;
  isExtern = false;
  access: Accessibility = 'private';
  /** The method this one overrides, which virtual calls of it reach this one through. */
  overridden: MethodSymbol | undefined;
  /** The property or indexer whose accessor this method is. */
  property: PropertySymbol | undefined;
  native: NativeMethod | undefined;
  /** The compiled body, set once the method is bound. */
  body: BoundBlock | undefined;
  /** The locals the body uses, of which the parameters come first. */
  locals: LocalSymbol[] = [];
  declaration: MethodDeclaration | ConstructorDeclaration | OperatorDeclaration | undefined;
  /** For a constructor, the call to another constructor that runs first. */
  constructorInitializer: BoundExpression | undefined;
  /** Whether a model program marked the method `// atomic`. */
  isAtomic = false;
  /** For a local function, the captured locals of enclosing functions that it reads. */
  captures: LocalSymbol[] = [];
  /**
   * For a local function, which locals are definitely assigned when it returns, or 'never' when it cannot return, which
   * a call of it gives its caller's flow analysis; undefined until the function's own body is analyzed.
   */
  assignedAtExit?: ((local: LocalSymbol) => boolean) | 'never';
  /** For a local function, the captured locals it reads before assigning them, which its callers must have assigned. */
  readsBeforeAssigned: LocalSymbol[] = [];
  /** The row of the method's declaration, for diagnostics and the trace. */
  row = 0;
  /** For an operator, its token (`+`, `==`). */
  operatorToken: string | undefined;
  /**
   * Whether C# removes the method's calls, arguments and all: a partial method without an implementation, or a
   * `[Conditional]` method whose symbols the program does not define.
   */
  callsAreRemoved = false;
  /** The symbols of the method's `[Conditional]` attributes. */
  conditionalSymbols: string[] | undefined;
  /** Whether the method is `async`, and for one, what its return type wraps: the type its `return` statements give. */
  isAsync = false;
  /** For the getter of an extension block's property, the property's name, which `x.P` finds it by. */
  extensionProperty: string | undefined;
  /** For a static member of an extension block, the receiver type, whose static members it joins (`string.M()`). */
  staticExtensionOf: Type | undefined;
  /** How a method returns by reference (`ref T M()`, `ref readonly T M()`), if it does. */
  returnsByRef: 'ref' | 'readonly' | undefined;
  async: AsyncShape | undefined;
  /** For an iterator (a body with `yield`), the type of its values and whether it returns an enumerable. */
  iterator: { elementType: Type; isEnumerable: boolean } | undefined;
  /** Whether `[ModuleInitializer]` runs the method before the entry point. */
  isModuleInitializer = false;
  /** The message of an `[Obsolete(message, true)]` attribute, which makes every use an error (CS0619). */
  obsoleteError: string | undefined;
  /** For an explicit interface implementation (`void IShape.Draw()`), the interface it implements a member of. */
  explicitInterface: NamedType | undefined;
  /** Whether the method is an event's `add` or `remove` accessor, which no name finds. */
  isEventAccessor = false;
  /** Whether a constructor has `[SetsRequiredMembers]`, which frees its callers from setting the required members. */
  setsRequiredMembers = false;

  constructor(
    readonly name: string,
    readonly owner: TypeSymbol,
    readonly kind: MethodKind
  ) {}
}

export class FieldSymbol {
  isStatic = false;
  isReadonly = false;
  isConst = false;
  constantValue: unknown;
  access: Accessibility = 'private';
  /** The index of the field among its object's or its type's fields. */
  slot = 0;
  initializer: Expression | ArrayInitializer | undefined;
  /** For an auto-property's backing field, the property. */
  property: PropertySymbol | undefined;
  /** For an event's backing field, the event. */
  isEvent = false;
  row = 0;
  /** The column of the declaration, which orders the members a record prints. */
  column = 0;
  /** Whether the field holds a primary constructor's parameter, which the program reads by the parameter's name. */
  isPrimaryParameter = false;
  /** Whether the field is `required`, which every object creation's initializer must set. */
  isRequired = false;
  obsoleteError: string | undefined;
  /** For an event with `add` and `remove` accessors, which it uses in place of a delegate field. */
  eventAccessors: { add: MethodSymbol; remove: MethodSymbol } | undefined;

  constructor(
    readonly name: string,
    public type: Type,
    readonly owner: TypeSymbol
  ) {}
}

export class PropertySymbol {
  getter: MethodSymbol | undefined;
  setter: MethodSymbol | undefined;
  /** Whether the setter is an `init` accessor. */
  isInitOnly = false;
  isStatic = false;
  access: Accessibility = 'private';
  /** The backing field of an auto-property. */
  backingField: FieldSymbol | undefined;
  /** For an indexer, its parameters. */
  parameters: ParameterSymbol[] = [];
  declaration: PropertyDeclaration | undefined;
  isVirtual = false;
  isAbstract = false;
  isOverride = false;
  overridden: PropertySymbol | undefined;
  /** Whether the property is `required`, which every object creation's initializer must set. */
  isRequired = false;
  obsoleteError: string | undefined;
  /** For an explicit interface implementation (`int IShape.Area { get; }`), the interface. */
  explicitInterface: NamedType | undefined;
  row = 0;
  /** The column of the declaration, which orders the members a record prints. */
  column = 0;

  constructor(
    readonly name: string,
    public type: Type,
    readonly owner: TypeSymbol,
    readonly isIndexer: boolean
  ) {}
}

export class LocalSymbol {
  /** The index of the variable among its function's locals. */
  slot = 0;
  isConst = false;
  constantValue: unknown;
  /** Whether a lambda or a local function reads the variable, which then lives in a cell that outlives the frame. */
  isCaptured = false;
  /** Whether the variable is a parameter, and how it is passed. */
  isParameter = false;
  refKind: 'ref' | 'out' | 'in' | undefined;
  /** Whether the variable is a ref local (`ref int r = ref x;`), whose slot holds a reference to another variable. */
  isRefLocal = false;
  /** Whether a ref local refers to a variable that outlives the method, so that the method may return it by `ref`. */
  refEscapes = false;
  /** Whether the program can assign the variable, which `foreach` variables and `using` variables forbid. */
  isReadonly = false;
  /** What makes a readonly variable so, as Roslyn's messages name it (`foreach 繰り返し変数`, `using 変数`). */
  readonlyReason = 'foreach 繰り返し変数';
  /** Whether the program read the variable, for the warning-free checks that need it. */
  isUsed = false;
  /** The function that declares the variable. */
  owner: MethodSymbol | undefined;
  /** Whether the trace shows the variable, which the compiler's own temporaries hide. */
  isHidden = false;
  /** Whether the variable carries a query's range variables, whose names the binder looks up in its members. */
  isTransparent = false;

  constructor(
    readonly name: string,
    public type: Type,
    readonly row: number,
    readonly column: number
  ) {}
}

export interface EnumMemberSymbol {
  name: string;
  value: number | bigint;
}

export class TypeSymbol {
  typeParameters: TypeParameterSymbol[] = [];
  baseType: NamedType | undefined;
  interfaces: NamedType[] = [];
  fields: FieldSymbol[] = [];
  methods: MethodSymbol[] = [];
  constructors: MethodSymbol[] = [];
  properties: PropertySymbol[] = [];
  nestedTypes: TypeSymbol[] = [];
  enumMembers: EnumMemberSymbol[] = [];
  enumUnderlying: NamedType | undefined;
  /** For a delegate type, its `Invoke` method. */
  invoke: MethodSymbol | undefined;
  staticConstructor: MethodSymbol | undefined;
  /** The method that runs the instance field initializers, before a constructor's own body. */
  instanceInitializer: BoundBlock | undefined;
  staticInitializer: BoundBlock | undefined;
  /** The locals that the field initializers use, such as pattern variables. */
  initializerLocals: LocalSymbol[] = [];
  staticInitializerLocals: LocalSymbol[] = [];
  isStatic = false;
  isAbstract = false;
  isSealed = false;
  isRecord = false;
  isReadonly = false;
  access: Accessibility = 'internal';
  special: SpecialType | undefined;
  declaration: TypeDeclaration | undefined;
  isLibrary = false;
  /** The names of a positional record's or a primary constructor's parameters, in order. */
  primaryParameters: ParameterSymbol[] | undefined;
  instanceFieldCount = 0;
  staticFieldCount = 0;
  /** The name that .NET's `Type.FullName` gives, which `ToString()` prints for objects. */
  runtimeNameOverride: string | undefined;
  /** How Roslyn shows an anonymous type, such as `<anonymous type: int X>`. */
  anonymousDisplay: string | undefined;
  /** Whether an enum has `[Flags]`, which prints a combination of members by their names. */
  isFlags = false;
  obsoleteError: string | undefined;
  /** For an attribute class, the declarations its `[AttributeUsage]` allows it on, as AttributeTargets bits. */
  attributeUsage: { validOn: number; allowMultiple: boolean } | undefined;
  row = 0;

  constructor(
    readonly name: string,
    readonly kind: 'class' | 'struct' | 'interface' | 'enum' | 'delegate',
    readonly namespace: string,
    readonly containing: TypeSymbol | undefined
  ) {}

  /** The type with the symbol's own type parameters as arguments. */
  get declaredType(): NamedType {
    return { kind: 'named', symbol: this, args: this.allTypeParameters.map((parameter) => parameter.type) };
  }

  get isValueType(): boolean {
    return this.kind === 'struct' || this.kind === 'enum';
  }

  get isReferenceType(): boolean {
    return this.kind === 'class' || this.kind === 'interface' || this.kind === 'delegate';
  }

  /** The name with its arity, as metadata spells it (`List`1`). */
  get metadataName(): string {
    return this.typeParameters.length > 0 ? `${this.name}\`${this.typeParameters.length}` : this.name;
  }

  /** The full name that .NET's reflection gives, with `+` before nested types. */
  get fullName(): string {
    if (this.runtimeNameOverride) return this.runtimeNameOverride;
    if (this.containing) return `${this.containing.fullName}+${this.metadataName}`;
    return this.namespace ? `${this.namespace}.${this.metadataName}` : this.metadataName;
  }

  /** The type parameters of the containing types and then of this type, which a constructed type's args follow. */
  get allTypeParameters(): TypeParameterSymbol[] {
    return [...(this.containing?.allTypeParameters ?? []), ...this.typeParameters];
  }
}

export function namedType(symbol: TypeSymbol, args: Type[] = []): NamedType {
  return { kind: 'named', symbol, args };
}

export function arrayType(element: Type, rank = 1): ArrayType {
  return { kind: 'array', element, rank };
}

export function isSpecial(type: Type, special: SpecialType): boolean {
  return type.kind === 'named' && type.symbol.special === special;
}

export function specialOf(type: Type): SpecialType | undefined {
  return type.kind === 'named' ? type.symbol.special : undefined;
}

/** The type itself, or the type that it wraps when it is a `T?` of a value type. */
export function withoutNullable(type: Type): Type {
  return nullableUnderlying(type) ?? type;
}

/** The type that a `T?` of a value type wraps, or undefined. */
export function nullableUnderlying(type: Type): Type | undefined {
  return type.kind === 'named' && type.symbol.special === 'nullable' ? type.args[0] : undefined;
}

export function isValueType(type: Type): boolean {
  if (type.kind === 'named') return type.symbol.isValueType;
  if (type.kind === 'typeParameter') return type.symbol.hasValueConstraint;
  return false;
}

export function isReferenceType(type: Type): boolean {
  if (type.kind === 'named') return type.symbol.isReferenceType;
  if (type.kind === 'array') return true;
  if (type.kind === 'typeParameter') {
    return (
      type.symbol.hasReferenceConstraint ||
      type.symbol.constraintTypes.some(
        (constraint) =>
          constraint.kind === 'named' &&
          constraint.symbol.kind === 'class' &&
          constraint.symbol.special !== 'valueType' &&
          constraint.symbol.special !== 'enum'
      )
    );
  }
  return false;
}

/** Whether `null` converts to the type. */
export function acceptsNull(type: Type): boolean {
  return isReferenceType(type) || nullableUnderlying(type) !== undefined;
}

export function sameType(a: Type, b: Type): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'named': {
      const other = b as NamedType;
      return (
        a.symbol === other.symbol &&
        a.args.length === other.args.length &&
        a.args.every((arg, index) => sameType(arg, other.args[index]))
      );
    }
    case 'array': {
      const other = b as ArrayType;
      return a.rank === other.rank && sameType(a.element, other.element);
    }
    case 'typeParameter': {
      return a.symbol === (b as TypeParameterType).symbol;
    }
    default: {
      return true;
    }
  }
}

export type Substitution = ReadonlyMap<TypeParameterSymbol, Type>;

/** A type parameter's argument, where `T?` of a reference type argument is that type, annotated. */
function substituteParameter(type: TypeParameterType, substitution: Substitution): Type {
  const argument = substitution.get(type.symbol);
  if (!argument) return type;
  return type.isAnnotated && (argument.kind === 'named' || argument.kind === 'array') && !isValueType(argument)
    ? { ...argument, isAnnotated: true }
    : argument;
}

export function substitute(type: Type, substitution: Substitution): Type {
  if (substitution.size === 0) return type;
  switch (type.kind) {
    case 'typeParameter': {
      return substituteParameter(type, substitution);
    }
    case 'array': {
      const result: ArrayType = { kind: 'array', element: substitute(type.element, substitution), rank: type.rank };
      if (type.isAnnotated) result.isAnnotated = true;
      return result;
    }
    case 'named': {
      if (type.args.length === 0) return type;
      const result: NamedType = {
        kind: 'named',
        symbol: type.symbol,
        args: type.args.map((arg) => substitute(arg, substitution)),
      };
      if (type.tupleNames) result.tupleNames = type.tupleNames;
      if (type.isAnnotated) result.isAnnotated = true;
      return result;
    }
    default: {
      return type;
    }
  }
}

/** The substitution that a constructed type makes for its symbol's type parameters, including the containing types'. */
export function substitutionOf(type: NamedType): Map<TypeParameterSymbol, Type> {
  const parameters = type.symbol.allTypeParameters;
  const map = new Map<TypeParameterSymbol, Type>();
  for (const [index, parameter] of parameters.entries()) {
    const arg = type.args[index];
    if (arg) map.set(parameter, arg);
  }
  return map;
}

/** The base class of a type, with its type arguments substituted. */
export function baseTypeOf(type: Type): NamedType | undefined {
  if (type.kind !== 'named' || !type.symbol.baseType) return undefined;
  return substitute(type.symbol.baseType, substitutionOf(type)) as NamedType;
}

export function interfacesOf(type: NamedType): NamedType[] {
  const substitution = substitutionOf(type);
  return type.symbol.interfaces.map((face) => substitute(face, substitution) as NamedType);
}

/** Every interface a type implements, directly or through its bases and other interfaces, without duplicates. */
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
export function allInterfacesOf(type: Type, arrayInterfaces: (element: Type) => NamedType[]): NamedType[] {
  const result: NamedType[] = [];
  const add = (face: NamedType): void => {
    if (result.some((existing) => sameType(existing, face))) return;
    result.push(face);
    for (const parent of interfacesOf(face)) add(parent);
  };
  if (type.kind === 'array') {
    // Only a single-dimensional array implements the generic interfaces, such as IEnumerable<T>, as in .NET.
    if (type.rank === 1) for (const face of arrayInterfaces(type.element)) add(face);
    return result;
  }
  if (type.kind === 'typeParameter') {
    for (const constraint of type.symbol.constraintTypes) {
      if (constraint.kind === 'named' && constraint.symbol.kind === 'interface') add(constraint);
      else for (const face of allInterfacesOf(constraint, arrayInterfaces)) add(face);
    }
    return result;
  }
  for (
    let current: NamedType | undefined = type.kind === 'named' ? type : undefined;
    current;
    current = baseTypeOf(current)
  ) {
    if (current.symbol.kind === 'interface') add(current);
    for (const face of interfacesOf(current)) add(face);
  }
  return result;
}

/** The C# names of the keyword types, which diagnostics use. */
const KEYWORD_NAMES: Partial<Record<SpecialType, string>> = {
  object: 'object',
  string: 'string',
  bool: 'bool',
  char: 'char',
  sbyte: 'sbyte',
  byte: 'byte',
  short: 'short',
  ushort: 'ushort',
  int: 'int',
  uint: 'uint',
  long: 'long',
  ulong: 'ulong',
  float: 'float',
  double: 'double',
  decimal: 'decimal',
  void: 'void',
};

/**
 * A type as Roslyn's diagnostics show it. With `qualified`, as its conversion errors do, a type outside the global
 * namespace carries its namespace, such as `System.Collections.Generic.List<int>`.
 */
/**
 * A type as Roslyn's messages show it; `qualified` adds the namespaces, and `annotated` the `?` of a nullable reference
 * type, which Roslyn shows for the types that declarations write.
 */
/** Whether a type is `dynamic`, which the library's hidden `__Dynamic` stands for. */
export function isDynamicType(type: Type): boolean {
  return type.kind === 'named' && type.symbol.isLibrary && type.symbol.name === '__Dynamic';
}

/** Whether a type is a pointer type `T*`, which the library's hidden `__Pointer<T>` stands for. */
export function isPointerType(type: Type): boolean {
  return type.kind === 'named' && type.symbol.isLibrary && type.symbol.name === '__Pointer';
}

/** Whether a type is `void*`, which points to no type that a dereference could read. */
export function isVoidPointer(type: Type): boolean {
  const pointee = pointeeOf(type);
  return pointee?.kind === 'named' && pointee.symbol.name === '__Void';
}

/** The type a pointer type points to. */
export function pointeeOf(type: Type): Type | undefined {
  return type.kind === 'named' && isPointerType(type) ? type.args[0] : undefined;
}

// code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
export function displayType(type: Type, qualified = false, annotated = false): string {
  const mark = annotated && 'isAnnotated' in type && type.isAnnotated ? '?' : '';
  switch (type.kind) {
    case 'named': {
      if (isDynamicType(type)) return 'dynamic';
      if (isPointerType(type))
        return `${isVoidPointer(type) ? 'void' : displayType(pointeeOf(type) as Type, qualified, annotated)}*`;
      const keyword = type.symbol.special ? KEYWORD_NAMES[type.symbol.special] : undefined;
      if (keyword) return `${keyword}${mark}`;
      if (type.symbol.special === 'nullable') return `${displayType(type.args[0], qualified, annotated)}?`;
      if (type.symbol.special === 'valueTuple' && type.args.length > 1) {
        return `(${type.args
          .map((arg, index) => {
            const name = type.tupleNames?.[index];
            const text = displayType(arg, qualified, annotated);
            return name ? `${text} ${name}` : text;
          })
          .join(', ')})`;
      }
      return `${displayTypeSymbol(type.symbol, type.args, qualified, annotated)}${mark}`;
    }
    case 'array': {
      let element: Type = type.element;
      let ranks = `[${','.repeat(type.rank - 1)}]`;
      while (element.kind === 'array') {
        ranks += `[${','.repeat(element.rank - 1)}]`;
        element = element.element;
      }
      return `${displayType(element, qualified, annotated)}${ranks}${mark}`;
    }
    case 'typeParameter': {
      return `${type.symbol.name}${mark}`;
    }
    case 'null': {
      return '<null>';
    }
    case 'void': {
      return 'void';
    }
    default: {
      return '?';
    }
  }
}

export function displayTypeSymbol(
  symbol: TypeSymbol,
  args: Type[] = symbol.allTypeParameters.map((parameter) => parameter.type),
  qualified = false,
  annotated = false
): string {
  const keyword = symbol.special ? KEYWORD_NAMES[symbol.special] : undefined;
  if (keyword) return keyword;
  if (symbol.anonymousDisplay) return symbol.anonymousDisplay;
  const ownCount = symbol.typeParameters.length;
  const ownArgs = args.slice(args.length - ownCount);
  const outerArgs = args.slice(0, args.length - ownCount);
  const namespace = qualified && symbol.namespace ? `${symbol.namespace}.` : '';
  const prefix = symbol.containing
    ? `${displayTypeSymbol(symbol.containing, outerArgs, qualified, annotated)}.`
    : namespace;
  const suffix = ownCount > 0 ? `<${ownArgs.map((arg) => displayType(arg, qualified, annotated)).join(', ')}>` : '';
  return `${prefix}${symbol.name}${suffix}`;
}

/** The name of a method as Roslyn's diagnostics show it, such as `A.M(int, string)`. */
export function displayMethod(method: MethodSymbol): string {
  const owner = displayTypeSymbol(method.owner);
  const parameters = method.parameters
    .map(
      (parameter) =>
        `${parameter.refKind ? `${parameter.refKind} ` : ''}${parameter.isParams ? 'params ' : ''}${displayType(parameter.type)}`
    )
    .join(', ');
  const typeParameters =
    method.typeParameters.length > 0 ? `<${method.typeParameters.map((parameter) => parameter.name).join(', ')}>` : '';
  switch (method.kind) {
    case 'constructor':
    case 'staticConstructor': {
      return `${owner}.${method.owner.name}(${parameters})`;
    }
    case 'getter': {
      return `${owner}.${method.property?.isIndexer ? 'this[]' : method.property?.name}.get`;
    }
    case 'setter': {
      return `${owner}.${method.property?.isIndexer ? 'this[]' : method.property?.name}.set`;
    }
    case 'operator': {
      return `${owner}.operator ${method.operatorToken}(${parameters})`;
    }
    case 'localFunction': {
      return `${method.name}${typeParameters}(${parameters})`;
    }
    default: {
      return `${owner}.${method.name}${typeParameters}(${parameters})`;
    }
  }
}

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
