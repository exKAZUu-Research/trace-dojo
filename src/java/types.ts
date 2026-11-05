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

export type JavaType = PrimitiveType | { kind: 'class'; cls: ClassInfo } | { kind: 'array'; element: JavaType };

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
  declaration?: ClassDeclaration;
  fields: Map<string, FieldInfo>;
  methods: MethodInfo[];
  constructors: MethodInfo[];
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
  return type.kind !== 'class' && type.kind !== 'array' && type.kind !== 'null';
}

export function isReference(type: JavaType): boolean {
  return type.kind === 'class' || type.kind === 'array' || type.kind === 'null';
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
  if (a.kind === 'class') return a.cls === (b as typeof a).cls;
  if (a.kind === 'array') return sameType(a.element, (b as typeof a).element);
  return true;
}

export function typeName(type: JavaType): string {
  switch (type.kind) {
    case 'class': {
      return type.cls.name;
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
  if (to.kind !== 'class' && to.kind !== 'array') return false;
  if (from.kind === 'class') return to.kind === 'class' && (to.cls === objectClass || isSubclass(from.cls, to.cls));
  if (from.kind === 'array') {
    if (to.kind === 'class') return to.cls === objectClass;
    if (isPrimitive(from.element) || isPrimitive(to.element)) return sameType(from.element, to.element);
    return isWidening(from.element, to.element, objectClass);
  }
  return false;
}

/** Whether a cast from `from` to `to` may succeed, as javac decides at compile time. */
export function isCastable(from: JavaType, to: JavaType, objectClass: ClassInfo): boolean {
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
