import { type FloatName, INT_PROPERTIES, type IntName } from '../c/types';
import type { ConstantLocation, Expr, LibraryConstant } from './expr';
import type { ClassOperations, LibraryClass } from './library/libraryClass';
import type { CompiledFunction, Eval, Frame } from './runtime';
import type { Entity, NamespaceInfo, Scope } from './scopes';
import type { Syntax } from './syntax';
import type { Ptr } from './values';

export type { FloatName, IntName } from '../c/types';

interface Qualified {
  isConst?: boolean;
}

/** A C++ type; a reference type appears only where a variable, parameter, or function result is declared. */
export type Type =
  | ({ kind: 'void' } & Qualified)
  /** An integer type, or an enumeration whose values have the type `name` underlies. */
  | ({
      kind: 'int';
      name: IntName;
      enumeration?: EnumInfo;
      /** The value of a non-type template argument this type carries (`Array<int, 3>`). */
      templateValue?: number | bigint;
      /** The character type whose values the integer type `name` holds (`wchar_t` holds `int`'s on arm64 macOS). */
      character?: CharacterTypeName;
    } & Qualified)
  | ({ kind: 'float'; name: FloatName } & Qualified)
  | ({ kind: 'nullptr' } & Qualified)
  | ({ kind: 'pointer'; to: Type } & Qualified)
  /** An lvalue reference, or an rvalue reference (`T&&`) when `isRvalue`. */
  | { kind: 'reference'; to: Type; isRvalue?: boolean }
  /** An array, whose length is undefined while it is incomplete (`int a[]` before its initializer). */
  | ({ kind: 'array'; of: Type; length?: number; variableLength?: Eval<unknown> } & Qualified)
  | ({ kind: 'class'; cls: ClassInfo } & Qualified)
  /** A pointer to a member of a class (`int P::*`, `int (P::*)() const`), whose member has type `to`. */
  | ({ kind: 'memberPointer'; cls: ClassInfo; to: Type } & Qualified)
  /**
   * The type of a function's name, which only a call or a library algorithm's argument may use; a member function's
   * type, which a pointer to a member has, says whether the function is const.
   */
  | { kind: 'function'; ret: Type; params: Type[]; isConstMember?: boolean };

/** The character types besides `char`, each a distinct type with the representation of an integer type. */
export type CharacterTypeName = 'wchar_t' | 'char8_t' | 'char16_t' | 'char32_t';

export const CHARACTER_TYPES: Readonly<Record<CharacterTypeName, IntName>> = {
  wchar_t: 'int',
  char8_t: 'uchar',
  char16_t: 'ushort',
  char32_t: 'uint',
};

export type IntType = Extract<Type, { kind: 'int' }>;
export type FloatType = Extract<Type, { kind: 'float' }>;
export type ArithmeticType = IntType | FloatType;
export type PointerType = Extract<Type, { kind: 'pointer' }>;
export type ArrayType = Extract<Type, { kind: 'array' }>;
export type ClassType = Extract<Type, { kind: 'class' }>;
export type ReferenceType = Extract<Type, { kind: 'reference' }>;

export const VOID: Type = { kind: 'void' };
export const BOOL: IntType = { kind: 'int', name: 'bool' };
export const CHAR: IntType = { kind: 'int', name: 'char' };
export const SCHAR: IntType = { kind: 'int', name: 'schar' };
export const UCHAR: IntType = { kind: 'int', name: 'uchar' };
export const SHORT: IntType = { kind: 'int', name: 'short' };
export const USHORT: IntType = { kind: 'int', name: 'ushort' };
export const INT: IntType = { kind: 'int', name: 'int' };
export const UINT: IntType = { kind: 'int', name: 'uint' };
export const LONG: IntType = { kind: 'int', name: 'long' };
export const ULONG: IntType = { kind: 'int', name: 'ulong' };
export const LLONG: IntType = { kind: 'int', name: 'llong' };
export const ULLONG: IntType = { kind: 'int', name: 'ullong' };
export const FLOAT: FloatType = { kind: 'float', name: 'float' };
export const DOUBLE: FloatType = { kind: 'float', name: 'double' };
export const LDOUBLE: FloatType = { kind: 'float', name: 'ldouble' };
export const NULLPTR: Type = { kind: 'nullptr' };
export const SIZE_T = ULONG;
export const PTRDIFF_T = LONG;
export const CONST_CHAR: IntType = { kind: 'int', name: 'char', isConst: true };
export const CHAR_POINTER: PointerType = { kind: 'pointer', to: CHAR };

export type Access = 'public' | 'protected' | 'private';

/** An enumeration (`enum Color { RED };`, `enum class Dir : char { N };`). */
export class EnumInfo {
  readonly enumerators = new Map<string, number | bigint>();
  isComplete = false;

  constructor(
    readonly name: string,
    readonly isScoped: boolean,
    /** The underlying type, which the enumerators decide unless the declaration fixes it. */
    public underlying: IntName,
    readonly hasFixedType: boolean
  ) {}
}

/** The scoped enumeration a type is, which converts to no other type implicitly. */
export function isScopedEnum(type: Type): boolean {
  return type.kind === 'int' && type.enumeration?.isScoped === true;
}

export interface FieldInfo {
  name: string;
  type: Type;
  /** The position of the member in the objects of its class and of every class derived from it. */
  index: number;
  access: Access;
  owner: ClassInfo;
  row: number;
  /** The default member initializer (`int speed = 2;`, `Turtle t{1, 2};`), compiled with the class. */
  initializer?: Syntax;
  /** Whether the member is `mutable`, which a const object's member function may still change. */
  isMutable?: boolean;
  /** The alignment `alignas` gives the member, in bytes. */
  alignment?: number;
  directInitializer?: boolean;
  /** The anonymous union or struct members through which a member of one of them is reached from the class. */
  path?: readonly FieldInfo[];
  /** The width in bits of a bit-field. */
  bitWidth?: number;
}

/** A base that the objects of a class hold in a member: a base after the first, or a virtual base. */
export interface SecondaryBase {
  cls: ClassInfo;
  access: Access;
  field: FieldInfo;
  /** Whether the base is virtual, whose subobject the complete object holds once for every class that names it. */
  isVirtual?: boolean;
}

export interface StaticFieldInfo {
  name: string;
  type: Type;
  access: Access;
  owner: ClassInfo;
  row: number;
  /** The variable's storage, which its definition (in the class with `inline`, or outside it) creates. */
  global?: GlobalInfo;
  /** The value of a `const` integral member initialized with a constant expression. */
  constant?: number | bigint;
}

export interface GlobalInfo {
  /** The name the trace shows, such as `count` or `Controller::stepCount`. */
  name: string;
  type: Type;
  index: number;
  row: number;
  isDefined: boolean;
  isConstexpr?: boolean;
  hasStaticReferenceBinding?: boolean;
  referentConstant?: number | bigint;
  foldedValue?: number | bigint;
  isConstexprPointer?: boolean;
  hasConstantObjectValue?: boolean;
  constantLocation?: ConstantLocation;
  constantPointee?: ConstantLocation;
  /** Whether learners see the variable: constants never change, so they would only crowd the variable table. */
  isShown: boolean;
}

export interface ParamInfo {
  name: string | undefined;
  type: Type;
  defaultValue?: {
    node: Syntax;
    use?: () => Eval<unknown>;
  };
  /** Whether a call to a library function may leave the argument out, which the library then supplies. */
  isOptional?: boolean;
  /** The function parameter pack (`Ts... xs`) whose element the parameter is. */
  pack?: string;
  row: number;
}

/** A function, a member function, a constructor, or a destructor, written by the program or by the library. */
export interface FunctionInfo {
  name: string;
  /** The name in messages, such as `MyTurtle::move` or `std::max`. */
  displayName: string;
  params: ParamInfo[];
  ret: Type;
  owner?: ClassInfo;
  isStatic: boolean;
  isVirtual: boolean;
  isInline?: boolean;
  isConst: boolean;
  isPure: boolean;
  isConstructor: boolean;
  isDestructor: boolean;
  isOverride: boolean;
  isFinal: boolean;
  isNoexcept?: boolean;
  access: Access;
  row: number;
  /** Whether a call counts as one step of the caller, as `// atomic` on its header marks. */
  isAtomic: boolean;
  isDefined: boolean;
  /** The compiled body, set when the compiler reaches the definition. */
  compiled?: CompiledFunction;
  /** The library's implementation, which runs instead of a body. */
  native?: NativeFunction;
  nativeUses?: (row: number) => void;
  /** The result of a call with constant arguments, or undefined when the call is no constant expression. */
  evaluateConstant?: (args: readonly (number | bigint)[]) => number | bigint | undefined;
  libraryConstant?: (args: readonly Expr[]) => LibraryConstant | undefined;
  constantAccess?: (object: Expr, args: readonly Expr[]) => ConstantLocation | undefined;
  /** A result known at compile time from the object and argument expressions, such as a fixed array's length. */
  constantValue?: (object: Expr | undefined, args: readonly Expr[]) => number | bigint | undefined;
  streamManipulator?: 'both' | 'output';
  mathIntrinsic?: boolean;
  libcGlobal?: boolean;
  /** The syntax of the definition, which the compiler compiles once the declarations it may use are known. */
  definition?: Syntax;
  /** Whether the function takes any number of further arguments, as `printf` does. */
  isVariadic?: boolean;
  /** Whether the function is constexpr (or consteval), which constant expressions may call. */
  isConstexpr?: boolean;
  /** Whether the function is consteval, whose every call is a constant expression. */
  isConsteval?: boolean;
  /** The ref-qualifier of a member function (`void f() &;`), which says whether its object is an lvalue or an rvalue. */
  refQualifier?: '&' | '&&';
  /** Whether a constructor takes part only in direct initialization, as `std::vector(size_type)` does. */
  isExplicit?: boolean;
  /**
   * Deduces a library function template's parameter types from the arguments of a call, giving the function the call
   * uses, or undefined when deduction fails.
   */
  instantiate?: (args: Expr[], templateArgs: Type[] | undefined) => FunctionInfo | undefined;
  /** Whether the function is an instance of a template, which overload resolution likes less than a function. */
  isTemplate?: boolean;
  /** The function template a template's pattern declares, whose `instantiate` makes its instances. */
  templatePattern?: { node: Syntax | undefined };
  /** How specialized a function template's parameter types are, which partial ordering prefers more of. */
  templateSpecificity?: number;
  /** Compiles a template instance's body the first time the program uses it. */
  lazyCompile?: () => void;
  /** The bindings of the template parameters the function's declaration and body see. */
  templateScopes?: Scope[];
  /** The namespace a non-member function is a member of. */
  namespace?: NamespaceInfo;
  /** Whether the function is a conversion function (`operator int() const`). */
  isConversion?: boolean;
  /** Whether the function is deleted (`= delete`), which overload resolution may choose but no call may use. */
  isDeleted?: boolean;
  /** Whether the function is defaulted on its first declaration (`= default`), which leaves it not user-provided. */
  isDefaulted?: boolean;
}

/** The library's implementation of a function: it receives the arguments as the parameters declare them. */
export type NativeFunction = (args: unknown[], context: NativeContext) => unknown;

export interface NativeContext {
  /** The object of a member function. */
  self: unknown;
  readonly selfLocation?: Ptr;
  readonly frame: Frame;
  readonly row: number;
}

let nextClassId = 0;

/** A class or struct, written by the program or provided by the library. */
export class ClassInfo {
  readonly id = nextClassId++;
  base?: ClassInfo;
  baseAccess: Access = 'public';
  /** Every non-static data member, the base's first, in the order objects hold them. */
  fields: FieldInfo[] = [];
  staticFields = new Map<string, StaticFieldInfo>();
  /** The member functions declared in this class, by name. */
  methods = new Map<string, FunctionInfo[]>();
  constructors: FunctionInfo[] = [];
  destructor?: FunctionInfo;
  hasUserDestructor = false;
  isComplete = false;
  /** The final overrider of each virtual function, by its signature. */
  virtuals = new Map<string, FunctionInfo>();
  /** The library's behavior for a class it provides, such as `std::string`. */
  library?: LibraryClass;
  /** How objects are copied, assigned, and destroyed, set once the class is complete. */
  operations?: ClassOperations;
  /** The classes nested in a library class, such as `std::vector<int>::iterator`. */
  memberTypes = new Map<string, Type>();
  /** The static constants of a library class, such as `std::string::npos`. */
  constants = new Map<string, (row: number) => Expr>();
  isTurtle = false;
  /** Whether copying is deleted, as for `Turtle`. */
  isNoncopyable = false;
  implicitCopyFromConst = true;
  /** Whether the implicit copy assignment is deleted, as for a class with a const or reference member. */
  isAssignmentDeleted = false;
  /** Whether the implicit default constructor is deleted, as for a class with an uninitialized reference member. */
  isDefaultConstructorDeleted = false;
  /** Whether the class is `final`, which no class may derive from. */
  isFinal = false;
  /** The constructor a class without user-declared ones has, when it has anything to initialize. */
  row = -1;

  /** The class template this class is an instance of, with its arguments. */
  templateOrigin?: object;
  templateArgs?: readonly Type[];
  /** The bindings of the template parameters the class's members see. */
  templateScopes?: Scope[];
  /** The template the class's name denotes with template arguments in its own scope (`Box<T>` in `Box`). */
  templateEntity?: Entity;
  /** The namespace the class is a member of. */
  namespace?: NamespaceInfo;
  /** The alignment `alignas` gives the class, in bytes. */
  alignment?: number;
  /** Whether the class is a lambda's closure type. */
  isLambda = false;
  /** The class this one is nested in. */
  outer?: ClassInfo;
  /** The scopes of the blocks a local class is defined in, whose names its members see. */
  localScopes?: Scope[];
  /** The classes whose code may use this class's private and protected members (`friend class B;`). */
  readonly friendClasses = new Set<ClassInfo>();
  /** The functions that may use this class's private and protected members (`friend void f(A&);`). */
  readonly friendFunctions = new Set<FunctionInfo>();
  /** The class templates every instance of which is a friend (`template <class U> friend class Box;`). */
  readonly friendClassTemplates = new Set<object>();
  /** The names of the function templates every instance of which is a friend. */
  readonly friendTemplateNames = new Set<string>();
  /** Whether the class declares a constructor that `constructors` leaves out (a defaulted copy constructor). */
  declaresConstructor = false;
  /** Whether the class has no name, which a typedef that names it gives it (`typedef struct { ... } P;`). */
  isUnnamed = false;
  /**
   * The bases after the first (`class C : A, B`), each of which an object holds as a subobject in a member of its
   * own, which conversions to the base and the base's members reach.
   */
  secondaryBases: SecondaryBase[] = [];
  /** The virtual bases the class's base clause names, whose members the class adds once its members are declared. */
  directVirtualBases: { cls: ClassInfo; access: Access }[] = [];

  /**
   * The virtual bases of the class and of its bases (`class B : virtual public A`), each of which only the complete
   * object holds, in a member of the class whose objects are complete.
   */
  get virtualBases(): ClassInfo[] {
    const found: ClassInfo[] = [];
    const add = (cls: ClassInfo): void => {
      if (!found.includes(cls)) found.push(cls);
    };
    for (const current of firstBaseChain(this)) {
      for (const { cls } of current.directVirtualBases) {
        for (const inner of cls.virtualBases) add(inner);
        add(cls);
      }
      for (const secondary of current.secondaryBases) {
        for (const inner of secondary.cls.virtualBases) add(inner);
        if (secondary.isVirtual) add(secondary.cls);
      }
    }
    return found;
  }

  /** The member that holds a virtual base's subobject in this class's complete objects. */
  virtualBaseField(base: ClassInfo): FieldInfo | undefined {
    for (const current of firstBaseChain(this)) {
      const secondary = current.secondaryBases.find((candidate) => candidate.isVirtual && candidate.cls === base);
      if (secondary) return secondary.field;
    }
    return undefined;
  }

  /** The members of its anonymous unions and structs, which the class names as its own. */
  anonymousFields: FieldInfo[] = [];
  /** The bit-fields without names, which only take room, each before the own member at position `before`. */
  unnamedBitFields: { before: number; type: Type; width: number }[] = [];

  constructor(
    public name: string,
    readonly key: 'class' | 'struct' | 'union'
  ) {}

  get isUnion(): boolean {
    return this.key === 'union';
  }

  get ownFields(): FieldInfo[] {
    return this.fields.filter((field) => field.owner === this);
  }

  get isPolymorphic(): boolean {
    return this.virtuals.size > 0;
  }

  get isAbstract(): boolean {
    return [...this.virtuals.values()].some((fn) => fn.isPure);
  }

  isDerivedFrom(other: ClassInfo): boolean {
    return this.distanceToBase(other) !== undefined;
  }

  distanceToBase(other: ClassInfo): number | undefined {
    if (this === other) return 0;
    for (const { cls: base } of this.directVirtualBases) {
      const distance = base.distanceToBase(other);
      if (distance !== undefined) return distance + 1;
    }
    const primary = this.base?.distanceToBase(other);
    if (primary !== undefined) return primary + 1;
    for (const { cls: base } of this.secondaryBases) {
      const distance = base.distanceToBase(other);
      if (distance !== undefined) return distance + 1;
    }
    for (const base of this.library?.additionalPublicBases ?? []) {
      const distance = base.distanceToBase(other);
      if (distance !== undefined) return distance + 1;
    }
  }
}

export function isCopyConstructor(fn: FunctionInfo, cls: ClassInfo): boolean {
  if (fn.params.length === 0) return false;
  const [first, ...rest] = fn.params;
  return (
    first.type.kind === 'reference' &&
    first.type.to.kind === 'class' &&
    first.type.to.cls === cls &&
    rest.every((param) => param.defaultValue !== undefined)
  );
}

export function sameParameters(a: FunctionInfo, b: FunctionInfo): boolean {
  return (
    a.params.length === b.params.length &&
    a.params.every((param, index) => sameType(unqualified(param.type), unqualified(b.params[index].type))) &&
    (!a.owner || a.isConst === b.isConst)
  );
}

export function pointerTo(type: Type, isConst = false): PointerType {
  return isConst ? { kind: 'pointer', to: type, isConst } : { kind: 'pointer', to: type };
}

export function referenceTo(type: Type, isRvalue = false): ReferenceType {
  return isRvalue ? { kind: 'reference', to: type, isRvalue } : { kind: 'reference', to: type };
}

export function classType(cls: ClassInfo, isConst = false): ClassType {
  return isConst ? { kind: 'class', cls, isConst } : { kind: 'class', cls };
}

export function allowsConstantCopy(type: Type): boolean {
  if (type.kind === 'class') {
    const { cls } = type;
    if (cls.library) return cls.library.allowsConstantCopy === true;
    return (
      !cls.isNoncopyable &&
      !cls.constructors.some((constructor) => isCopyConstructor(constructor, cls)) &&
      (!cls.base || allowsConstantCopy(classType(cls.base))) &&
      cls.ownFields.every((field) => allowsConstantCopy(field.type))
    );
  }
  if (type.kind === 'array') return allowsConstantCopy(type.of);
  return isArithmetic(type) || type.kind === 'pointer' || type.kind === 'nullptr' || type.kind === 'reference';
}

export function allowsMemberAssignment(type: Type): boolean {
  if (type.kind === 'reference' || isConstType(type)) return false;
  if (type.kind === 'array') return allowsMemberAssignment(type.of);
  return type.kind !== 'class' || !type.cls.isAssignmentDeleted;
}

export function isConstType(type: Type): boolean {
  if (type.kind === 'reference' || type.kind === 'function') return false;
  if (type.kind === 'array') return type.isConst === true || isConstType(type.of);
  return type.isConst === true;
}

export function isReferenceRelated(source: Type, target: Type): boolean {
  if (source.kind === 'class' && target.kind === 'class') return source.cls.isDerivedFrom(target.cls);
  return sameType(unqualified(source), unqualified(target), false);
}

export function unqualified<T extends Type>(type: T): T {
  if (!('isConst' in type) || !type.isConst) return type;
  const { isConst: _, ...rest } = type;
  return rest as T;
}

export function withConst<T extends Type>(type: T, isConst = true): T {
  if (type.kind === 'reference' || type.kind === 'function') return type;
  if (type.kind === 'array') return { ...type, of: withConst(type.of, isConst) };
  return isConst ? { ...type, isConst: true } : unqualified(type);
}

/** The type of the object a reference refers to, or the type itself. */
export function nonReference(type: Type): Type {
  return type.kind === 'reference' ? type.to : type;
}

export function isInteger(type: Type): type is IntType {
  return type.kind === 'int';
}

export function isArithmetic(type: Type): type is ArithmeticType {
  return type.kind === 'int' || type.kind === 'float';
}

export function isScalar(type: Type): boolean {
  return isArithmetic(type) || type.kind === 'pointer' || type.kind === 'nullptr';
}

export function isLibraryClass(type: Type, name?: string): type is ClassType {
  return type.kind === 'class' && type.cls.library !== undefined && (!name || type.cls.library.kind === name);
}

export function hasVacuousInitialization(type: Type): boolean {
  if (type.kind === 'array') return hasVacuousInitialization(type.of);
  if (type.kind !== 'class') return true;
  const { cls } = type;
  if (cls.library) {
    const array = cls.library.aggregateArray?.type;
    return array ? array.length === 0 || hasVacuousInitialization(array.of) : cls.library.kind === 'functor';
  }
  return (
    cls.constructors.length === 0 &&
    !cls.isPolymorphic &&
    !cls.hasUserDestructor &&
    (!cls.base || hasVacuousInitialization(classType(cls.base))) &&
    cls.ownFields.every((field) => !field.initializer && hasVacuousInitialization(field.type))
  );
}

export function isCharType(type: Type): boolean {
  return type.kind === 'int' && (type.name === 'char' || type.name === 'schar' || type.name === 'uchar');
}

export function intMax(name: IntName): bigint {
  return INT_PROPERTIES[name].max;
}

export function intMin(name: IntName): bigint {
  return INT_PROPERTIES[name].min;
}

/** The integer conversion rank of a type, which the usual arithmetic conversions compare. */
export function intRank(name: IntName): number {
  return INT_PROPERTIES[name].rank;
}

export function isWide(type: IntType): boolean {
  return INT_PROPERTIES[type.name].size === 8;
}

export function isSigned(type: IntType): boolean {
  return INT_PROPERTIES[type.name].signed;
}

/** The type an array or function decays to where a value is needed. */
export function decay(type: Type): Type {
  if (type.kind === 'array') return pointerTo(type.of);
  return type;
}

/** Whether two types are the same, comparing qualifiers only when `withQualifiers`. */
export function sameType(a: Type, b: Type, withQualifiers = true): boolean {
  if (a.kind !== b.kind) return false;
  if (withQualifiers && isConstType(a) !== isConstType(b) && a.kind !== 'array') return false;
  switch (a.kind) {
    case 'int': {
      const other = b as typeof a;
      return a.name === other.name && a.enumeration === other.enumeration && a.character === other.character;
    }
    case 'float': {
      return a.name === (b as typeof a).name;
    }
    case 'pointer': {
      return sameType(a.to, (b as typeof a).to, true);
    }
    case 'reference': {
      const other = b as typeof a;
      return a.isRvalue === other.isRvalue && sameType(a.to, other.to, true);
    }
    case 'array': {
      const other = b as typeof a;
      return a.length === other.length && sameType(a.of, other.of, withQualifiers);
    }
    case 'class': {
      return a.cls === (b as typeof a).cls;
    }
    case 'memberPointer': {
      const other = b as typeof a;
      return a.cls === other.cls && sameType(a.to, other.to);
    }
    case 'function': {
      const other = b as typeof a;
      if ((a.isConstMember === true) !== (other.isConstMember === true)) return false;
      return (
        sameType(a.ret, other.ret) &&
        a.params.length === other.params.length &&
        a.params.every((param, index) => sameType(param, other.params[index]))
      );
    }
    default: {
      return true;
    }
  }
}

const INT_NAMES: Record<IntName, string> = {
  bool: 'bool',
  char: 'char',
  schar: 'signed char',
  uchar: 'unsigned char',
  short: 'short',
  ushort: 'unsigned short',
  int: 'int',
  uint: 'unsigned int',
  long: 'long',
  ulong: 'unsigned long',
  llong: 'long long',
  ullong: 'unsigned long long',
};

/** The type as C++ writes it, such as `const std::string &` or `int[3]`, for messages. */
export function typeName(type: Type, inner = ''): string {
  const constText = 'isConst' in type && type.isConst ? 'const ' : '';
  switch (type.kind) {
    case 'void':
    case 'int':
    case 'float':
    case 'nullptr':
    case 'class': {
      const base = `${constText}${baseName(type)}`;
      return inner ? `${base} ${inner.trimStart()}` : base;
    }
    case 'pointer': {
      const star = `*${constText ? ' const' : ''}${inner}`;
      if (type.to.kind === 'array' || type.to.kind === 'function') return typeName(type.to, `(${star})`);
      return typeName(type.to, star);
    }
    case 'reference': {
      const ampersands = type.isRvalue ? '&&' : '&';
      if (type.to.kind === 'array') return typeName(type.to, `(${ampersands}${inner})`);
      return typeName(type.to, `${ampersands}${inner}`);
    }
    case 'array': {
      return typeName(type.of, `${inner}[${type.length ?? ''}]`);
    }
    case 'function': {
      const qualifier = type.isConstMember ? ' const' : '';
      return typeName(type.ret, `${inner}(${type.params.map((param) => typeName(param)).join(', ')})${qualifier}`);
    }
    case 'memberPointer': {
      const pointer = `${classDisplayName(type.cls)}::*${constText ? ' const' : ''}${inner}`;
      return typeName(type.to, type.to.kind === 'function' ? `(${pointer})` : ` ${pointer}`);
    }
  }
}

function baseName(type: Type): string {
  switch (type.kind) {
    case 'int': {
      return type.enumeration?.name ?? type.character ?? INT_NAMES[type.name];
    }
    case 'float': {
      return type.name === 'ldouble' ? 'long double' : type.name;
    }
    case 'nullptr': {
      return 'std::nullptr_t';
    }
    case 'class': {
      return classDisplayName(type.cls);
    }
    default: {
      return 'void';
    }
  }
}

/** A class's name with the classes it is nested in, such as `Outer::Inner`. */
export function classDisplayName(cls: ClassInfo): string {
  const args = cls.templateArgs ? `<${cls.templateArgs.map(templateArgumentName).join(', ')}>` : '';
  if (cls.outer) return `${classDisplayName(cls.outer)}::${cls.name}${args}`;
  return cls.namespace ? `${cls.namespace.qualifiedName}::${cls.name}${args}` : `${cls.name}${args}`;
}

function templateArgumentName(type: Type): string {
  return type.kind === 'int' && type.templateValue !== undefined ? String(type.templateValue) : typeName(type);
}

/** The size in bytes, as `sizeof` gives on arm64 macOS with libc++. */
export function sizeOf(type: Type): number {
  switch (type.kind) {
    case 'int': {
      return INT_PROPERTIES[type.name].size;
    }
    case 'float': {
      return type.name === 'float' ? 4 : 8;
    }
    case 'pointer':
    case 'nullptr': {
      return 8;
    }
    case 'reference': {
      return sizeOf(type.to);
    }
    case 'array': {
      return sizeOf(type.of) * (type.length ?? 0);
    }
    case 'class': {
      return classLayout(type.cls).size;
    }
    case 'memberPointer': {
      // The Itanium C++ ABI's pointer to a member function holds the function and an adjustment of `this`.
      return type.to.kind === 'function' ? 16 : 8;
    }
    default: {
      return 1;
    }
  }
}

export function alignOf(type: Type): number {
  switch (type.kind) {
    case 'array': {
      return alignOf(type.of);
    }
    case 'class': {
      return classLayout(type.cls).align;
    }
    case 'reference': {
      return alignOf(type.to);
    }
    default: {
      return Math.max(1, Math.min(sizeOf(type), 8));
    }
  }
}

export function isStandardLayout(cls: ClassInfo): boolean {
  if (!cls.isComplete || cls.isPolymorphic) return false;
  if (cls.library?.aggregateArray) return standardLayoutMember(cls.library.aggregateArray.type);
  if (cls.library && cls.library.kind !== 'pair') return false;
  const first = cls.fields[0];
  if (
    cls.fields.some(
      (field) => field.owner !== first.owner || field.access !== first.access || !standardLayoutMember(field.type)
    )
  )
    return false;
  const firstTypes = first && typesAtOrigin(first.type);
  for (let base = cls.base; base; base = base.base) {
    if (firstTypes?.has(base)) return false;
  }
  return !cls.base || isStandardLayout(cls.base);
}

function standardLayoutMember(type: Type): boolean {
  if (type.kind === 'reference') return false;
  if (type.kind === 'array') return standardLayoutMember(type.of);
  return type.kind !== 'class' || isStandardLayout(type.cls);
}

export function baseSubobjectOffset(derived: ClassInfo, base: ClassInfo): number {
  let offset = 0;
  for (let cls: ClassInfo | undefined = derived; cls && cls !== base; cls = cls.base) {
    offset += classLayout(cls).baseOffset;
  }
  return offset;
}

export function fieldSubobjectOffset(derived: ClassInfo, field: FieldInfo): number {
  const own = classLayout(field.owner).fieldOffsets?.[field.index] ?? field.index;
  return baseSubobjectOffset(derived, field.owner) + own;
}

interface ClassLayout {
  size: number;
  align: number;
  dataSize: number;
  baseOffset: number;
  fieldOffsets?: readonly number[];
  atOrigin: ReadonlySet<ClassInfo>;
}

const completedLayouts = new WeakMap<ClassInfo, ClassLayout>();

/** The size and alignment of a class's objects, laid out as the Itanium C++ ABI lays them out. */
function classLayout(cls: ClassInfo): ClassLayout {
  const cached = completedLayouts.get(cls);
  if (cached) return cached;
  const atOrigin = new Set([cls]);
  if (cls.library && !cls.library.layoutFromFields) {
    const { size, align, fieldOffsets } = cls.library;
    return { size, align, dataSize: size, baseOffset: 0, fieldOffsets, atOrigin };
  }
  let offset = cls.isPolymorphic && !cls.base?.isPolymorphic ? 8 : 0;
  let align = Math.max(offset > 0 ? 8 : 1, cls.alignment ?? 1);
  let baseOffset = 0;
  let emptyBase: ReadonlySet<ClassInfo> | undefined;
  if (cls.base) {
    const base = classLayout(cls.base);
    // An empty base takes no room (the empty base optimization).
    if (base.dataSize > 0) {
      // The members of a derived class reuse the tail padding of a base that is not POD.
      baseOffset = Math.ceil(offset / base.align) * base.align;
      if (baseOffset === 0) for (const type of base.atOrigin) atOrigin.add(type);
      offset = baseOffset + (isPodForLayout(cls.base) ? base.size : base.dataSize);
    } else {
      emptyBase = base.atOrigin;
      for (const type of emptyBase) atOrigin.add(type);
    }
    align = Math.max(align, base.align);
  }
  const fieldOffsets: number[] = [];
  // The bit at which the next bit-field may start while bit-fields follow one another.
  let bits: number | undefined;
  const placeBits = (type: Type, width: number): number => {
    const unit = sizeOf(type) * 8;
    let at = bits ?? offset * 8;
    // A bit-field starts a new unit of its type when it would straddle one; a zero-width one ends the unit.
    if (width === 0 || Math.floor(at / unit) !== Math.floor((at + width - 1) / unit)) at = Math.ceil(at / unit) * unit;
    bits = at + width;
    return at;
  };
  const ownFields = cls.ownFields;
  for (const [position, field] of [...ownFields, undefined].entries()) {
    for (const padding of cls.unnamedBitFields) if (padding.before === position) placeBits(padding.type, padding.width);
    if (!field) break;
    // A reference member takes the room of a pointer, though `sizeof` of a reference type is that of its referent.
    const type = field.type.kind === 'reference' ? pointerTo(field.type.to) : field.type;
    const fieldAlign = Math.max(alignOf(type), field.alignment ?? 1);
    // Every member of a union starts at its beginning.
    if (cls.isUnion) {
      fieldOffsets[field.index] = 0;
      offset = Math.max(offset, field.bitWidth === undefined ? sizeOf(type) : Math.ceil(field.bitWidth / 8));
      align = Math.max(align, fieldAlign);
      continue;
    }
    if (field.bitWidth !== undefined) {
      fieldOffsets[field.index] = Math.floor(placeBits(type, field.bitWidth) / 8);
      align = Math.max(align, fieldAlign);
      continue;
    }
    if (bits !== undefined) offset = Math.ceil(bits / 8);
    bits = undefined;
    const at = Math.ceil(offset / fieldAlign) * fieldAlign;
    const members = at === 0 ? typesAtOrigin(type) : undefined;
    const hasConflict = members && emptyBase && [...members].some((member) => emptyBase.has(member));
    if (members && !hasConflict) for (const member of members) atOrigin.add(member);
    const fieldOffset = at + (hasConflict ? fieldAlign : 0);
    fieldOffsets[field.index] = fieldOffset;
    offset = fieldOffset + sizeOf(type);
    align = Math.max(align, fieldAlign);
  }
  if (bits !== undefined) offset = Math.ceil(bits / 8);
  const size = Math.ceil(offset / align) * align;
  const layout = { size: size === 0 ? 1 : size, align, dataSize: offset, baseOffset, fieldOffsets, atOrigin };
  if (cls.isComplete && !cls.library) completedLayouts.set(cls, layout);
  return layout;
}

function typesAtOrigin(type: Type): ReadonlySet<ClassInfo> | undefined {
  if (type.kind === 'class') return classLayout(type.cls).atOrigin;
  if (type.kind === 'array' && (type.length ?? 0) > 0) return typesAtOrigin(type.of);
}

/** Whether the ABI lays out a class as POD, which arm64 macOS decides by the C++11 definition ([class]p10). */
function isPodForLayout(cls: ClassInfo): boolean {
  if (cls.library) return cls.library.kind === 'array' && isPodType(cls.library.args[0]);
  if (cls.isPolymorphic || cls.constructors.length > 0 || cls.destructor) return false;
  // A standard-layout class declares all its data members in one class of its hierarchy, with the same access.
  if (cls.base && (!isPodForLayout(cls.base) || (cls.base.fields.length > 0 && cls.ownFields.length > 0))) return false;
  const [first] = cls.fields;
  return cls.fields.every((field) => field.access === first.access && !field.initializer && isPodType(field.type));
}

function isPodType(type: Type): boolean {
  if (type.kind === 'array') return isPodType(type.of);
  if (type.kind === 'class') return isPodForLayout(type.cls);
  return type.kind !== 'reference';
}

/** A class and its first bases, the class first. */
function firstBaseChain(cls: ClassInfo): ClassInfo[] {
  const chain: ClassInfo[] = [];
  for (let current: ClassInfo | undefined = cls; current; current = current.base) chain.push(current);
  return chain;
}
