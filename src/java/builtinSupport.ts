import { type Frame, throwBuiltin } from './runtime';
import {
  type ClassInfo,
  type ClassType,
  createClass,
  type FieldInfo,
  type JavaType,
  type MethodInfo,
  type NativeMethod,
  type TypeVariable,
  VOID,
} from './types';
import { JavaString, type Value } from './values';

export interface Registry {
  classes: Map<string, ClassInfo>;
  qualifiedNames: Map<ClassInfo, string>;
  define: (name: string, superclass: ClassInfo | undefined, packageName?: string) => ClassInfo;
}

export function createRegistry(): Registry {
  const classes = new Map<string, ClassInfo>();
  const qualifiedNames = new Map<ClassInfo, string>();
  return {
    classes,
    qualifiedNames,
    define: (name, superclass, packageName = 'java.lang') => {
      const cls = createClass(name, superclass, true);
      classes.set(name, cls);
      qualifiedNames.set(cls, packageName ? `${packageName}.${name}` : name);
      return cls;
    },
  };
}

/** Gives a builtin class type parameters, returning their types for use in its members' signatures. */
export function addTypeParameters(cls: ClassInfo, names: string[], bound: JavaType): JavaType[] {
  cls.typeParameters = names.map((name): TypeVariable => ({ name, bounds: [bound] }));
  return cls.typeParameters.map((variable) => ({ kind: 'typeVar', variable }));
}

/** Makes a builtin class implement an interface, given as a type that may have type arguments. */
export function addInterface(cls: ClassInfo, type: ClassType): void {
  cls.interfaces.push(type.cls);
  cls.supertypes.push(type);
}

export function defineInterface(registry: Registry, name: string, packageName: string): ClassInfo {
  const cls = registry.define(name, undefined, packageName);
  cls.kind = 'interface';
  cls.isAbstract = true;
  cls.supertypes = [];
  return cls;
}

export function addAbstractMethod(
  cls: ClassInfo,
  name: string,
  parameterTypes: JavaType[],
  returnType: JavaType
): MethodInfo {
  return pushMethod(cls, { name, parameterTypes, returnType, isStatic: false, isAbstract: true });
}

export function addMethod(
  cls: ClassInfo,
  name: string,
  parameterTypes: JavaType[],
  returnType: JavaType,
  isStatic: boolean,
  native: NativeMethod
): MethodInfo {
  return pushMethod(cls, { name, parameterTypes, returnType, isStatic, isAbstract: false, native });
}

/** Adds a public instance or static method to a builtin class. */
function pushMethod(
  cls: ClassInfo,
  method: Pick<MethodInfo, 'name' | 'parameterTypes' | 'returnType' | 'isStatic' | 'isAbstract' | 'native'>
): MethodInfo {
  const info: MethodInfo = { ...method, owner: cls, isConstructor: false, access: 'public', thrownTypes: [] };
  cls.methods.push(info);
  return info;
}

export function addConstructor(cls: ClassInfo, parameterTypes: JavaType[], native: NativeMethod): MethodInfo {
  const constructor: MethodInfo = {
    name: cls.name,
    owner: cls,
    parameterTypes,
    returnType: VOID,
    isStatic: false,
    isAbstract: false,
    isConstructor: true,
    access: 'public',
    thrownTypes: [],
    native,
  };
  cls.constructors.push(constructor);
  return constructor;
}

export function addConstant(cls: ClassInfo, name: string, type: JavaType, constant: Value): void {
  const field: FieldInfo = {
    name,
    owner: cls,
    type,
    isStatic: true,
    isFinal: true,
    access: 'public',
    slot: cls.staticFieldCount++,
    constant,
  };
  cls.fields.set(name, field);
  cls.staticFields.push(field);
}

export function newString(frame: Frame, value: string): JavaString {
  frame.runtime.allocateString(frame, value.length);
  return new JavaString(value);
}

export function text(value: Value): string {
  return (value as JavaString).value;
}

export function requireString(frame: Frame, value: Value): string {
  if (!(value instanceof JavaString)) return throwBuiltin(frame, 'NullPointerException');
  return value.value;
}
