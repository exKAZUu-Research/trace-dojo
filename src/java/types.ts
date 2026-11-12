import type {
  ClassDeclaration,
  ConstructorDeclaration,
  EnumConstant,
  FieldDeclaration,
  MethodDeclaration,
  Modifiers,
} from './ast';
import type { Frame } from './runtime';
import type { Value } from './values';

export type NumericKind = 'byte' | 'short' | 'char' | 'int' | 'long' | 'float' | 'double';

export type PrimitiveType = { kind: NumericKind } | { kind: 'boolean' } | { kind: 'void' } | { kind: 'null' };

/** A class type; `args` holds the type arguments of a parameterized type and is absent for a raw or plain one. */
export interface ClassType {
  kind: 'class';
  cls: ClassInfo;
  args?: JavaType[];
  /**
   * The type of the enclosing instance of an inner class that a generic class encloses, whose type arguments the inner
   * class's members use, as `O<String>` in `O<String>.I`; a raw one erases them.
   */
  outer?: ClassType;
}

export interface TypeVariable {
  name: string;
  /** The upper bounds, the first of which decides the erasure. */
  bounds: JavaType[];
}

/** A wildcard type argument: `?`, `? extends bound`, or `? super bound`. */
export interface WildcardType {
  kind: 'wildcard';
  bound: JavaType | undefined;
  isSuper: boolean;
  /**
   * Marks a type argument that inference left undecided, as in the result of `Collectors.toList()`, which fits wherever
   * Java's inference would have decided it.
   */
  isHole?: boolean;
}

export type JavaType =
  | PrimitiveType
  | ClassType
  | { kind: 'array'; element: JavaType }
  | { kind: 'typeVar'; variable: TypeVariable }
  | WildcardType
  /** A lambda or method reference argument, typed once overload resolution picks its functional interface. */
  | {
      kind: 'pending';
      arity: number | undefined;
      /**
       * For a method reference, the numbers of parameters a function type may have for it to name a method, or
       * `undefined` when any number may.
       */
      arities?: readonly number[];
      /**
       * For a generic call or creation whose implicit lambdas need the parameter's type, postponed until overload
       * resolution gives it one, which any parameter may take.
       */
      isPoly?: boolean;
      /** For a postponed call or creation, the erased type it produces, when its candidates all agree on one. */
      polyErasure?: JavaType;
      /** The class a method reference such as `String::length` names, which the first parameter takes. */
      receiverHint?: JavaType;
      /**
       * For a lambda, whether its body suits a void function and a value-returning one, and whether its parameters'
       * types are known, written or none, so that overload resolution reads its body (JLS 15.12.2.1, 15.12.2.5).
       */
      lambda?: { inVoid: boolean; inValue: boolean; isExplicit: boolean; isReference?: boolean };
    };

export const BYTE: JavaType = { kind: 'byte' };
export const SHORT: JavaType = { kind: 'short' };
export const INT: JavaType = { kind: 'int' };
export const LONG: JavaType = { kind: 'long' };
export const FLOAT: JavaType = { kind: 'float' };
export const DOUBLE: JavaType = { kind: 'double' };
export const BOOLEAN: JavaType = { kind: 'boolean' };
export const CHAR: JavaType = { kind: 'char' };
export const VOID: JavaType = { kind: 'void' };
export const NULL: JavaType = { kind: 'null' };

export type Access = Modifiers['access'];

export interface FieldInfo {
  name: string;
  owner: ClassInfo;
  type: JavaType;
  isStatic: boolean;
  isFinal: boolean;
  access: Access;
  /** The index into the object's or the class's slots. */
  slot: number;
  declaration?: FieldDeclaration;
  /** The value of a builtin constant such as `Integer.MAX_VALUE`. */
  constant?: Value;
  /** The declaration of the enum constant this field holds. */
  enumConstant?: EnumConstant;
}

/** Runs a builtin method; `receiver` is `undefined` for static methods. */
export type NativeMethod = (frame: Frame, receiver: Value, args: Value[]) => Value;

export interface MethodInfo {
  name: string;
  owner: ClassInfo;
  parameterTypes: JavaType[];
  returnType: JavaType;
  isStatic: boolean;
  isAbstract: boolean;
  /** Whether subclasses may not override the method. */
  isFinal?: boolean;
  isConstructor: boolean;
  access: Access;
  thrownTypes: ClassInfo[];
  declaration?: MethodDeclaration | ConstructorDeclaration;
  /** Whether a trace shows a call to this method as part of its caller's step, marked by `// atomic`. */
  isAtomic?: boolean;
  native?: NativeMethod;
  /** Whether the last parameter takes a variable number of arguments. */
  isVarargs?: boolean;
  /** For a call that passes variable arity arguments, how many arguments precede them. */
  varargsStart?: number;
  /** The type parameters of a generic method, such as `T` of `<T> T first(T[] a)`. */
  typeParameters?: TypeVariable[];
  /** The methods of supertypes that this one overrides, directly or indirectly. */
  overrides?: Set<MethodInfo>;
  /** For an anonymous class's constructor, the superclass constructor it passes its arguments to. */
  forwardsTo?: MethodInfo;
  /** For a view of a method with its receiver's type arguments substituted, the declared method. */
  declared?: MethodInfo;
  /** Filled in by the compiler for source methods. */
  code?: CompiledCode;
}

export interface LocalInfo {
  name: string;
  type: JavaType;
}

export interface CompiledCode {
  locals: LocalInfo[];
  /** Runs the body with the arguments already stored in the first slots of `frame.locals`. */
  run: (frame: Frame) => Value;
}

export interface ClassInfo {
  name: string;
  /** The name `Object.toString` and `Throwable.toString` print, such as `Outer$Inner`. */
  binaryName: string;
  kind: 'class' | 'interface' | 'enum';
  /** Interfaces have no superclass, though their members include those of `Object`. */
  superclass: ClassInfo | undefined;
  /** The interfaces a class implements or an interface extends directly. */
  interfaces: ClassInfo[];
  /** The class whose body declares this one. */
  enclosing: ClassInfo | undefined;
  /** The classes, interfaces, and enums declared directly in this class's body. */
  memberTypes: Map<string, ClassInfo>;
  isAbstract: boolean;
  isFinal: boolean;
  isBuiltin: boolean;
  /** The primitive type a wrapper class such as `Integer` boxes. */
  unboxedType?: JavaType;
  /** The direct subclasses a sealed class or interface permits. */
  permits?: ClassInfo[];
  /** The fields of a record's components, in declaration order. */
  recordComponents?: FieldInfo[];
  /** Whether instances hold an instance of the enclosing class, as inner, local, and anonymous classes may. */
  hasOuterInstance?: boolean;
  declaration?: ClassDeclaration;
  fields: Map<string, FieldInfo>;
  methods: MethodInfo[];
  constructors: MethodInfo[];
  /** The type parameters of a generic class, such as `T` of `Box<T>`. */
  typeParameters: TypeVariable[];
  /** The superclass and interfaces as written, with type arguments in terms of this class's type parameters. */
  supertypes: ClassType[];
  /** Instance slots including those of superclasses. */
  instanceFieldCount: number;
  staticFieldCount: number;
  /** Instance fields in slot order, including those of superclasses. */
  instanceFields: FieldInfo[];
  staticFields: FieldInfo[];
  /** Runs the static initializers in textual order. */
  initializeStatics?: (frame: Frame) => void;
  type: JavaType;
}

export function createClass(name: string, superclass: ClassInfo | undefined, isBuiltin: boolean): ClassInfo {
  const cls: ClassInfo = {
    name,
    binaryName: name,
    kind: 'class',
    superclass,
    interfaces: [],
    typeParameters: [],
    supertypes: superclass ? [superclass.type as ClassType] : [],
    enclosing: undefined,
    memberTypes: new Map(),
    isAbstract: false,
    isFinal: false,
    isBuiltin,
    fields: new Map(),
    methods: [],
    constructors: [],
    instanceFieldCount: superclass?.instanceFieldCount ?? 0,
    staticFieldCount: 0,
    instanceFields: [...(superclass?.instanceFields ?? [])],
    staticFields: [],
    type: { kind: 'class', cls: undefined as unknown as ClassInfo },
  };
  cls.type = { kind: 'class', cls };
  return cls;
}

/** The type of `this` in `cls`'s body: the class parameterized by its own type parameters and its enclosing ones. */
export function thisTypeOf(cls: ClassInfo): ClassType {
  const outer = cls.enclosing && hasGenericOuter(cls) ? thisTypeOf(cls.enclosing) : undefined;
  if (cls.typeParameters.length === 0 && !outer) return cls.type as ClassType;
  const args = cls.typeParameters.map((variable): JavaType => ({ kind: 'typeVar', variable }));
  return { kind: 'class', cls, args: args.length > 0 ? args : undefined, outer };
}

/** Whether `cls` is an inner class whose enclosing instance's class, or that one's, has type parameters. */
export function hasGenericOuter(cls: ClassInfo): boolean {
  for (let current = cls; current.hasOuterInstance && current.enclosing; current = current.enclosing) {
    if (current.enclosing.typeParameters.length > 0) return true;
  }
  return false;
}

/** Whether `cls` is `ancestor` or extends or implements it, directly or indirectly. */
export function isSubclass(cls: ClassInfo, ancestor: ClassInfo): boolean {
  for (let current: ClassInfo | undefined = cls; current; current = current.superclass) {
    if (current === ancestor) return true;
    if (ancestor.kind === 'interface' && current.interfaces.some((parent) => isSubclass(parent, ancestor))) return true;
  }
  return false;
}

/** The interfaces that `cls` implements or extends, directly or indirectly, nearest first. */
export function superinterfacesOf(cls: ClassInfo): ClassInfo[] {
  const found: ClassInfo[] = [];
  const pending: ClassInfo[] = [];
  for (let current: ClassInfo | undefined = cls; current; current = current.superclass)
    pending.push(...current.interfaces);
  while (pending.length > 0) {
    const next = pending.shift() as ClassInfo;
    if (found.includes(next)) continue;
    found.push(next);
    pending.push(...next.interfaces);
  }
  return found;
}

export function isPrimitive(type: JavaType): boolean {
  return !isReference(type) && type.kind !== 'void';
}

export function isReference(type: JavaType): boolean {
  return ['class', 'array', 'null', 'typeVar', 'wildcard'].includes(type.kind);
}

/** The numeric kinds in the order of widening: each widens to every kind after it, except `char` to `short`. */
const NUMERIC_RANKS: Record<NumericKind, number> = { byte: 0, short: 1, char: 1, int: 2, long: 3, float: 4, double: 5 };

export function isNumeric(type: JavaType): type is { kind: NumericKind } {
  return Object.hasOwn(NUMERIC_RANKS, type.kind);
}

export function isIntegral(type: JavaType): boolean {
  return isNumeric(type) && type.kind !== 'float' && type.kind !== 'double';
}

/** Whether a numeric kind widens to another by a primitive widening conversion. */
export function isNumericWidening(from: NumericKind, to: NumericKind): boolean {
  if (from === to) return true;
  if (to === 'char' || (from === 'char' && to === 'short')) return false;
  return NUMERIC_RANKS[from] < NUMERIC_RANKS[to];
}

/** The type that unary numeric promotion gives an operand: `byte`, `short`, and `char` become `int`. */
export function promoteUnary(type: { kind: NumericKind }): JavaType {
  return NUMERIC_RANKS[type.kind] < NUMERIC_RANKS.int ? INT : type;
}

/** The type that binary numeric promotion gives two operands. */
export function promoteBinary(a: { kind: NumericKind }, b: { kind: NumericKind }): JavaType {
  for (const type of [DOUBLE, FLOAT, LONG]) if (a.kind === type.kind || b.kind === type.kind) return type;
  return INT;
}

export function sameType(a: JavaType, b: JavaType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'class': {
      return sameClassType(a, b as ClassType);
    }
    case 'array': {
      return sameType(a.element, (b as typeof a).element);
    }
    case 'typeVar': {
      return a.variable === (b as typeof a).variable;
    }
    case 'wildcard': {
      const other = b as WildcardType;
      if (a.isSuper !== other.isSuper || (a.bound === undefined) !== (other.bound === undefined)) return false;
      return !a.bound || sameType(a.bound, other.bound as JavaType);
    }
    default: {
      return true;
    }
  }
}

function sameClassType(a: ClassType, b: ClassType): boolean {
  if (a.cls !== b.cls) return false;
  if (a.outer && b.outer && !sameType(a.outer, b.outer)) return false;
  if (!a.args || !b.args) return !a.args && !b.args;
  return a.args.length === b.args.length && a.args.every((arg, index) => sameType(arg, (b.args as JavaType[])[index]));
}

/** Whether two types erase to the same type, as overriding and overloading compare signatures. */
export function sameErasure(a: JavaType, b: JavaType): boolean {
  return sameType(erasure(a), erasure(b));
}

/** The type with its type arguments removed and type variables replaced by their first bounds' erasures. */
// code-gauge-allow duplicateLines 15 -- Erasure and substitution each map every kind of type, which reads alike.
export function erasure(type: JavaType): JavaType {
  switch (type.kind) {
    case 'class': {
      return type.args || type.outer ? type.cls.type : type;
    }
    case 'array': {
      return { kind: 'array', element: erasure(type.element) };
    }
    case 'typeVar': {
      return erasure(type.variable.bounds[0]);
    }
    case 'wildcard': {
      return type.bound && !type.isSuper ? erasure(type.bound) : (OBJECT_TYPE.value as JavaType);
    }
    default: {
      return type;
    }
  }
}

/** The type `Object`, which the builtins set once they define it. */
export const OBJECT_TYPE: { value: JavaType | undefined } = { value: undefined };

/** The upper bound that reading a value of `type` gives: a wildcard's or a type variable's bound. */
export function upperBound(type: JavaType): JavaType {
  if (type.kind === 'wildcard')
    return type.bound && !type.isSuper ? upperBound(type.bound) : (OBJECT_TYPE.value as JavaType);
  if (type.kind === 'typeVar') return upperBound(type.variable.bounds[0]);
  return type;
}

/** The type reading a value of `type` gives: a wildcard's own bound, keeping a type variable it names. */
export function wildcardBound(type: JavaType): JavaType {
  if (type.kind !== 'wildcard') return type;
  return type.bound && !type.isSuper ? wildcardBound(type.bound) : (OBJECT_TYPE.value as JavaType);
}

/** Replaces type variables by the types `bindings` gives them, leaving those without one. */
// code-gauge-allow duplicateLines 16 -- Erasure and substitution each map every kind of type, which reads alike.
export function substitute(type: JavaType, bindings: ReadonlyMap<TypeVariable, JavaType>): JavaType {
  if (bindings.size === 0) return type;
  switch (type.kind) {
    case 'class': {
      if (!type.args && !type.outer) return type;
      const args = type.args?.map((arg) => substitute(arg, bindings));
      const outer = type.outer && (substitute(type.outer, bindings) as ClassType);
      return { kind: 'class', cls: type.cls, args, ...(outer && { outer }) };
    }
    case 'array': {
      return { kind: 'array', element: substitute(type.element, bindings) };
    }
    case 'typeVar': {
      return bindings.get(type.variable) ?? type;
    }
    case 'wildcard': {
      return type.bound ? { ...type, bound: substitute(type.bound, bindings) } : type;
    }
    default: {
      return type;
    }
  }
}

/** The bindings of `cls`'s type parameters that the class type `type` gives; a raw type erases them. */
export function bindingsOf(type: ClassType): Map<TypeVariable, JavaType> {
  const { typeParameters } = type.cls;
  const bindings = type.outer ? bindingsOf(type.outer) : new Map<TypeVariable, JavaType>();
  for (const [index, variable] of typeParameters.entries()) {
    bindings.set(variable, type.args?.[index] ?? erasure({ kind: 'typeVar', variable }));
  }
  return bindings;
}

/** The supertype of `type` that is a type of `target`, with its type arguments, or `undefined` if none is. */
export function asSuper(type: ClassType, target: ClassInfo): ClassType | undefined {
  if (type.cls === target) return type;
  // A raw type's supertypes are raw too.
  const isRaw = !type.args && type.cls.typeParameters.length > 0;
  const bindings = isRaw ? undefined : bindingsOf(type);
  for (const supertype of type.cls.supertypes) {
    const viewed = bindings ? (substitute(supertype, bindings) as ClassType) : (supertype.cls.type as ClassType);
    const found = asSuper(viewed, target);
    if (found) return found;
  }
  return undefined;
}

/** Whether a type argument `argument` lies within `parameter`, which may be a wildcard. */
function containsTypeArgument(parameter: JavaType, argument: JavaType, objectClass: ClassInfo): boolean {
  const isHole = (type: JavaType | undefined): boolean => type?.kind === 'wildcard' && type.isHole === true;
  if (isHole(argument) || isHole(parameter) || (parameter.kind === 'wildcard' && isHole(parameter.bound))) return true;
  if (parameter.kind !== 'wildcard') return sameType(parameter, argument);
  if (!parameter.bound) return true;
  if (parameter.isSuper) {
    // `? super Number` lies within `? super Integer`, as every type above Number is above Integer.
    if (argument.kind === 'wildcard')
      return argument.isSuper && !!argument.bound && isWidening(parameter.bound, argument.bound, objectClass);
    return isWidening(parameter.bound, argument, objectClass);
  }
  return isWidening(wildcardBound(argument), parameter.bound, objectClass);
}

export function typeName(type: JavaType): string {
  switch (type.kind) {
    case 'class': {
      const name = type.outer ? `${typeName(type.outer)}.${type.cls.name}` : type.cls.name;
      return type.args ? `${name}<${type.args.map((arg) => typeName(arg)).join(',')}>` : name;
    }
    case 'typeVar': {
      return type.variable.name;
    }
    case 'wildcard': {
      return type.bound ? `? ${type.isSuper ? 'super' : 'extends'} ${typeName(type.bound)}` : '?';
    }
    case 'pending': {
      return 'ラムダ式';
    }
    case 'array': {
      return `${typeName(type.element)}[]`;
    }
    default: {
      return type.kind;
    }
  }
}

/**
 * Whether a value of `from` converts to `to` by identity, primitive widening, or reference widening, the
 * conversions that method invocation allows without boxing.
 */
export function isWidening(from: JavaType, to: JavaType, objectClass: ClassInfo): boolean {
  if (sameType(from, to)) return true;
  if (isNumeric(from)) return isNumeric(to) && isNumericWidening(from.kind, to.kind);
  if (from.kind === 'null') return isReference(to);
  if (from.kind === 'typeVar' || from.kind === 'wildcard') {
    return from.kind === 'typeVar'
      ? from.variable.bounds.some((bound) => isWidening(bound, to, objectClass))
      : isWidening(upperBound(from), to, objectClass);
  }
  if (to.kind !== 'class' && to.kind !== 'array') return false;
  if (from.kind === 'class') return to.kind === 'class' && isClassWidening(from, to, objectClass);
  return from.kind === 'array' && isArrayWidening(from, to, objectClass);
}

/** Whether an array type widens to `Object`, an interface every array implements, or an array of a supertype. */
function isArrayWidening(
  from: Extract<JavaType, { kind: 'array' }>,
  to: Extract<JavaType, { kind: 'class' | 'array' }>,
  objectClass: ClassInfo
): boolean {
  if (to.kind === 'class') return to.cls === objectClass || arrayInterfaces.has(to.cls);
  if (isPrimitive(from.element) || isPrimitive(to.element)) return sameType(from.element, to.element);
  return isWidening(from.element, to.element, objectClass);
}

/** The interfaces every array type implements, `Cloneable` and `Serializable` (JLS 4.10.3). */
export const arrayInterfaces = new Set<ClassInfo>();

/** The classes an intersection type such as `Number & Comparable` stands for, keyed by the class that models it. */
export const intersectionParts = new WeakMap<ClassInfo, readonly ClassInfo[]>();

/** Whether a class type widens to another: to a supertype whose type arguments contain the ones `from` gives it. */
function isClassWidening(from: ClassType, to: ClassType, objectClass: ClassInfo): boolean {
  if (to.cls === objectClass) return true;
  const parts = intersectionParts.get(to.cls);
  if (parts) return parts.every((part) => isClassWidening(from, { kind: 'class', cls: part }, objectClass));
  const supertype = asSuper(from, to.cls);
  if (!supertype) return false;
  const supertypeArgs = supertype.args;
  // Raw types convert to and from parameterized ones, as an unchecked conversion.
  if (!supertypeArgs || !to.args) return true;
  return (
    supertypeArgs.length === to.args.length &&
    to.args.every((arg, index) => containsTypeArgument(arg, supertypeArgs[index], objectClass))
  );
}

/** Whether a cast from `from` to `to` may succeed, as javac decides at compile time. */
export function isCastable(fromType: JavaType, toType: JavaType, objectClass: ClassInfo): boolean {
  // Casts check only what survives erasure.
  const from = erasure(fromType);
  const to = erasure(toType);
  if (isNumeric(from) && isNumeric(to)) return true;
  if (from.kind === 'boolean' || to.kind === 'boolean') return from.kind === to.kind;
  if (isPrimitive(from) || isPrimitive(to)) return false;
  if (isWidening(from, to, objectClass) || isWidening(to, from, objectClass)) return true;
  // A class that is not final may have a subclass implementing any interface.
  if (from.kind !== 'class' || to.kind !== 'class') return false;
  const [a, b] = [from.cls, to.cls];
  if (a.kind === 'interface') return b.kind === 'interface' || !b.isFinal;
  return b.kind === 'interface' && !a.isFinal;
}
