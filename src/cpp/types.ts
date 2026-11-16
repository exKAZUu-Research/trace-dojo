import { type FloatName, INT_PROPERTIES, type IntName } from '../c/types';
import type { Expr } from './expr';
import type { ClassOperations, LibraryClass } from './library/libraryClass';
import type { CompiledFunction, Frame } from './runtime';
import type { Syntax } from './syntax';

export type { FloatName, IntName } from '../c/types';

interface Qualified {
  isConst?: boolean;
}

/** A C++ type; a reference type appears only where a variable, parameter, or function result is declared. */
export type Type =
  | ({ kind: 'void' } & Qualified)
  | ({ kind: 'int'; name: IntName } & Qualified)
  | ({ kind: 'float'; name: FloatName } & Qualified)
  | ({ kind: 'nullptr' } & Qualified)
  | ({ kind: 'pointer'; to: Type } & Qualified)
  | { kind: 'reference'; to: Type }
  /** An array, whose length is undefined while it is incomplete (`int a[]` before its initializer). */
  | ({ kind: 'array'; of: Type; length?: number } & Qualified)
  | ({ kind: 'class'; cls: ClassInfo } & Qualified)
  /** The type of a function's name, which only a call or a library algorithm's argument may use. */
  | { kind: 'function'; ret: Type; params: Type[] };

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
export const CONST_CHAR_POINTER: PointerType = { kind: 'pointer', to: CONST_CHAR };
export const CHAR_POINTER: PointerType = { kind: 'pointer', to: CHAR };

export type Access = 'public' | 'protected' | 'private';

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
  /** Whether learners see the variable: constants never change, so they would only crowd the variable table. */
  isShown: boolean;
}

export interface ParamInfo {
  name: string | undefined;
  type: Type;
  /** The syntax of the default argument, compiled where a call leaves the argument out. */
  defaultValue?: Syntax;
  /** Whether a call to a library function may leave the argument out, which the library then supplies. */
  isOptional?: boolean;
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
  isConst: boolean;
  isPure: boolean;
  isConstructor: boolean;
  isDestructor: boolean;
  isOverride: boolean;
  isFinal: boolean;
  /** Whether the function is `noexcept`, which only the library's functions are. */
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
  /** The syntax of the definition, which the compiler compiles once the declarations it may use are known. */
  definition?: Syntax;
  /** Whether the function takes any number of further arguments, as `printf` does. */
  isVariadic?: boolean;
  /** Whether a constructor takes part only in direct initialization, as `std::vector(size_type)` does. */
  isExplicit?: boolean;
  /**
   * Deduces a library function template's parameter types from the arguments of a call, giving the function the call
   * uses, or undefined when deduction fails.
   */
  instantiate?: (args: Expr[], templateArgs: Type[] | undefined) => FunctionInfo | undefined;
  /** Whether the function is an instance of a template, which overload resolution likes less than a function. */
  isTemplate?: boolean;
}

/** The library's implementation of a function: it receives the arguments as the parameters declare them. */
export type NativeFunction = (args: unknown[], context: NativeContext) => unknown;

export interface NativeContext {
  /** The object of a member function. */
  self: unknown;
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
  /** Whether the implicit copy assignment is deleted, as for a class with a const or reference member. */
  isAssignmentDeleted = false;
  /** Whether the implicit default constructor is deleted, as for a class with an uninitialized reference member. */
  isDefaultConstructorDeleted = false;
  /** Whether the class is `final`, which no class may derive from. */
  isFinal = false;
  /** The constructor a class without user-declared ones has, when it has anything to initialize. */
  implicitDefault?: FunctionInfo;
  row = -1;

  constructor(
    readonly name: string,
    readonly key: 'class' | 'struct'
  ) {}

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
    return this === other || (this.base?.isDerivedFrom(other) ?? false);
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

export function pointerTo(type: Type, isConst = false): PointerType {
  return isConst ? { kind: 'pointer', to: type, isConst } : { kind: 'pointer', to: type };
}

export function referenceTo(type: Type): ReferenceType {
  return { kind: 'reference', to: type };
}

export function classType(cls: ClassInfo, isConst = false): ClassType {
  return isConst ? { kind: 'class', cls, isConst } : { kind: 'class', cls };
}

export function isConstType(type: Type): boolean {
  if (type.kind === 'reference' || type.kind === 'function') return false;
  if (type.kind === 'array') return type.isConst === true || isConstType(type.of);
  return type.isConst === true;
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

export function isClass(type: Type): type is ClassType {
  return type.kind === 'class';
}

export function isLibraryClass(type: Type, name?: string): type is ClassType {
  return type.kind === 'class' && type.cls.library !== undefined && (!name || type.cls.library.kind === name);
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
    case 'int':
    case 'float': {
      return a.name === (b as typeof a).name;
    }
    case 'pointer': {
      return sameType(a.to, (b as typeof a).to, true);
    }
    case 'reference': {
      return sameType(a.to, (b as typeof a).to, true);
    }
    case 'array': {
      const other = b as typeof a;
      return a.length === other.length && sameType(a.of, other.of, withQualifiers);
    }
    case 'class': {
      return a.cls === (b as typeof a).cls;
    }
    case 'function': {
      const other = b as typeof a;
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
      if (type.to.kind === 'array') return typeName(type.to, `(&${inner})`);
      return typeName(type.to, `&${inner}`);
    }
    case 'array': {
      return typeName(type.of, `${inner}[${type.length ?? ''}]`);
    }
    case 'function': {
      return typeName(type.ret, `${inner}(${type.params.map((param) => typeName(param)).join(', ')})`);
    }
  }
}

function baseName(type: Type): string {
  switch (type.kind) {
    case 'int': {
      return INT_NAMES[type.name];
    }
    case 'float': {
      return type.name === 'ldouble' ? 'long double' : type.name;
    }
    case 'nullptr': {
      return 'std::nullptr_t';
    }
    case 'class': {
      return type.cls.name;
    }
    default: {
      return 'void';
    }
  }
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

/** The size and alignment of a class's objects, laid out as the Itanium C++ ABI lays them out. */
function classLayout(cls: ClassInfo): { size: number; align: number; dataSize: number } {
  if (cls.library) return { size: cls.library.size, align: cls.library.align, dataSize: cls.library.size };
  let offset = cls.isPolymorphic && !cls.base?.isPolymorphic ? 8 : 0;
  let align = offset > 0 ? 8 : 1;
  if (cls.base) {
    const base = classLayout(cls.base);
    // An empty base takes no room (the empty base optimization).
    if (cls.base.fields.length > 0 || cls.base.isPolymorphic) {
      // The members of a derived class reuse the tail padding of a base that is not POD.
      offset = Math.ceil(offset / base.align) * base.align + (isPodForLayout(cls.base) ? base.size : base.dataSize);
    }
    align = Math.max(align, base.align);
  }
  for (const field of cls.ownFields) {
    // A reference member takes the room of a pointer, though `sizeof` of a reference type is that of its referent.
    const type = field.type.kind === 'reference' ? pointerTo(field.type.to) : field.type;
    const fieldAlign = alignOf(type);
    offset = Math.ceil(offset / fieldAlign) * fieldAlign + sizeOf(type);
    align = Math.max(align, fieldAlign);
  }
  const size = Math.ceil(offset / align) * align;
  return { size: size === 0 ? 1 : size, align, dataSize: offset };
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
