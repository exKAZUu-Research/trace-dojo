import { addMethod, addTypeParameters, newString, type Registry } from './builtinSupport';
import { type Frame, throwBuiltin } from './runtime';
import { type ClassInfo, createClass, isWidening, type JavaType, typeName } from './types';
import { JavaArray, JavaObject, type Value } from './values';

/** The name `Class.getName` gives: the qualified name of a builtin class, or the binary name of a program's class. */
export function classNameOf(frame: Frame, cls: ClassInfo): string {
  return frame.runtime.builtins.qualifiedNames.get(cls) ?? cls.binaryName;
}

function reflected(receiver: Value): ClassInfo {
  return (receiver as JavaObject).reflected as ClassInfo;
}

/** The objects `getClass()` returns, one for each class, so that `==` compares classes. */
const classObjects = new WeakMap<ClassInfo, JavaObject>();

export function defineClassClass(registry: Registry, objectClass: ClassInfo, stringType: JavaType): void {
  const classClass = registry.define('Class', objectClass);
  classClass.isFinal = true;
  // `Void`, which `void.class` is a `Class` of, has no instances.
  registry.define('Void', objectClass).isFinal = true;
  addTypeParameters(classClass, ['T'], objectClass.type);
  addMethod(classClass, 'getName', [], stringType, false, (frame, receiver) =>
    newString(frame, classNameOf(frame, reflected(receiver)))
  );
  addMethod(classClass, 'getSimpleName', [], stringType, false, (frame, receiver) => {
    const cls = reflected(receiver);
    // An anonymous class has no simple name.
    return newString(frame, /\$\d+$/.test(cls.binaryName) ? '' : cls.name);
  });
  addMethod(classClass, 'toString', [], stringType, false, (frame, receiver) => {
    const cls = reflected(receiver);
    if (primitiveClassInfos.has(cls)) return newString(frame, cls.name);
    return newString(frame, `${cls.kind === 'interface' ? 'interface' : 'class'} ${classNameOf(frame, cls)}`);
  });
  const getClass = addMethod(objectClass, 'getClass', [], classClass.type, false, (frame, receiver) =>
    classObjectOf(runtimeClassOf(frame, receiver), classClass)
  );
  getClass.isFinal = true;
}

/** The classes standing for array types, named as `Class.getName` (`[I`) and `getSimpleName` (`int[]`) name them. */
const arrayClasses = new Map<string, ClassInfo>();

/** The class of a value, which `getClass()` returns: an array's own class, or `String` for a string. */
function runtimeClassOf(frame: Frame, value: Value): ClassInfo {
  if (value instanceof JavaArray) return arrayClassOf(frame, value.elementType);
  return value instanceof JavaObject ? value.cls : frame.runtime.builtins.stringClass;
}

/** The name `getClass().getName()` gives for a value, such as `java.lang.Integer` or `[I`. */
export function runtimeClassNameOf(frame: Frame, value: Value): string {
  return classNameOf(frame, runtimeClassOf(frame, value));
}

function arrayClassOf(frame: Frame, element: JavaType): ClassInfo {
  const descriptor = `[${descriptorOf(frame, element)}`;
  let cls = arrayClasses.get(descriptor);
  if (!cls) {
    cls = createClass(`${typeName(element)}[]`, frame.runtime.builtins.objectClass, true);
    cls.binaryName = descriptor;
    arrayClasses.set(descriptor, cls);
  }
  return cls;
}

const PRIMITIVE_DESCRIPTORS: Partial<Record<JavaType['kind'], string>> = {
  boolean: 'Z',
  byte: 'B',
  char: 'C',
  short: 'S',
  int: 'I',
  long: 'J',
  float: 'F',
  double: 'D',
};

function descriptorOf(frame: Frame, type: JavaType): string {
  if (type.kind === 'array') return `[${descriptorOf(frame, type.element)}`;
  if (type.kind === 'class') return `L${classNameOf(frame, type.cls)};`;
  return PRIMITIVE_DESCRIPTORS[type.kind] ?? `L${classNameOf(frame, frame.runtime.builtins.objectClass)};`;
}

/** The name `Class.getName` gives a type: a class's name, or an array's descriptor such as `[I`. */
export function typeClassName(frame: Frame, type: JavaType): string {
  return type.kind === 'array'
    ? `[${descriptorOf(frame, type.element)}`
    : descriptorOf(frame, type).replace(/^L(.*);$/, '$1');
}

/** Where the JVM says a class lives: the program's in the application loader's unnamed module, the JDK's in java.base. */
function moduleOfClass(name: string): string {
  return /^java\.|^\[+(?:[ZBCSIJFD]$|Ljava\.)/.test(name)
    ? "module java.base of loader 'bootstrap'"
    : "unnamed module of loader 'app'";
}

/** The message of the `ClassCastException` for casting `value` to the class named `target`, as the JVM words it. */
export function classCastMessage(frame: Frame, value: Value, target: string): string {
  const actual = runtimeClassNameOf(frame, value);
  const [from, to] = [moduleOfClass(actual), moduleOfClass(target)];
  const where =
    from === to ? `${actual} and ${target} are in ${from}` : `${actual} is in ${from}; ${target} is in ${to}`;
  return `class ${actual} cannot be cast to class ${target} (${where})`;
}

/** Whether a class literal may name `type`: one with no type variable or type arguments, an array's element included. */
export function isReifiable(type: JavaType): boolean {
  if (type.kind === 'array') return isReifiable(type.element);
  return type.kind !== 'typeVar' && !(type.kind === 'class' && type.args);
}

/** The classes standing for the primitive types and `void`, which `int.class` and the like name. */
const primitiveClasses = new Map<string, ClassInfo>();
const primitiveClassInfos = new WeakSet<ClassInfo>();

/** The `Class` object a class literal gives: a class's, an array type's, or a primitive type's or `void`'s. */
export function classObjectOfType(frame: Frame, type: JavaType, classClass: ClassInfo): JavaObject {
  if (type.kind === 'class') return classObjectOf(type.cls, classClass);
  if (type.kind === 'array') return classObjectOf(arrayClassOf(frame, type.element), classClass);
  let cls = primitiveClasses.get(type.kind);
  if (!cls) {
    cls = createClass(type.kind, undefined, true);
    primitiveClasses.set(type.kind, cls);
    primitiveClassInfos.add(cls);
  }
  return classObjectOf(cls, classClass);
}

/** The `Class` object of `cls`, which `getClass()` and class literals share. */
export function classObjectOf(cls: ClassInfo, classClass: ClassInfo): JavaObject {
  let object = classObjects.get(cls);
  if (!object) {
    object = new JavaObject(classClass);
    object.reflected = cls;
    classObjects.set(cls, object);
  }
  return object;
}

/** Stores `value` at `index` of `array`, failing with `ArrayStoreException` where its runtime type forbids it. */
export function storeElement(frame: Frame, array: JavaArray, index: number, value: Value): void {
  checkStore(frame, array, value);
  array.values[index] = value;
}

/** Fails with `ArrayStoreException` when the array's runtime element type does not admit `value`. */
export function checkStore(frame: Frame, array: JavaArray, value: Value): void {
  if (!fitsElement(frame, array.elementType, value)) {
    throwBuiltin(frame, 'ArrayStoreException', runtimeClassNameOf(frame, value));
  }
}

/** Whether `value` may be stored in an array of `elementType`, which the JVM checks at run time. */
export function fitsElement(frame: Frame, elementType: JavaType, value: Value): boolean {
  if (value === undefined) return true;
  if (elementType.kind === 'class') return frame.runtime.isInstance(value, elementType.cls);
  if (elementType.kind === 'array') {
    return (
      value instanceof JavaArray &&
      isWidening({ kind: 'array', element: value.elementType }, elementType, frame.runtime.builtins.objectClass)
    );
  }
  return true;
}
