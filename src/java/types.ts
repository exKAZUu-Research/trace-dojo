import type { ClassDeclaration, ConstructorDeclaration, FieldDeclaration, MethodDeclaration, Modifiers } from './ast';
import type { Frame } from './runtime';
import type { Value } from './values';

export type PrimitiveType =
  | { kind: 'int' }
  | { kind: 'double' }
  | { kind: 'boolean' }
  | { kind: 'char' }
  | { kind: 'void' }
  | { kind: 'null' };

export type JavaType = PrimitiveType | { kind: 'class'; cls: ClassInfo } | { kind: 'array'; element: JavaType };

export const INT: JavaType = { kind: 'int' };
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
  isConstructor: boolean;
  access: Access;
  thrownTypes: ClassInfo[];
  declaration?: MethodDeclaration | ConstructorDeclaration;
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
  superclass: ClassInfo | undefined;
  isAbstract: boolean;
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
    superclass,
    isAbstract: false,
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

export function isSubclass(cls: ClassInfo, ancestor: ClassInfo): boolean {
  for (let current: ClassInfo | undefined = cls; current; current = current.superclass) {
    if (current === ancestor) return true;
  }
  return false;
}

export function isPrimitive(type: JavaType): boolean {
  return type.kind !== 'class' && type.kind !== 'array' && type.kind !== 'null';
}

export function isReference(type: JavaType): boolean {
  return type.kind === 'class' || type.kind === 'array' || type.kind === 'null';
}

export function isNumeric(type: JavaType): boolean {
  return type.kind === 'int' || type.kind === 'double' || type.kind === 'char';
}

export function isIntegral(type: JavaType): boolean {
  return type.kind === 'int' || type.kind === 'char';
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
  if (from.kind === 'char') return to.kind === 'int' || to.kind === 'double';
  if (from.kind === 'int') return to.kind === 'double';
  if (from.kind === 'null') return isReference(to);
  if (to.kind !== 'class' && to.kind !== 'array') return false;
  if (from.kind === 'class') return to.kind === 'class' && isSubclass(from.cls, to.cls);
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
  return isWidening(from, to, objectClass) || isWidening(to, from, objectClass);
}
