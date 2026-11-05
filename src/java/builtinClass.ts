import { addMethod, addTypeParameters, newString, type Registry } from './builtinSupport';
import type { Frame } from './runtime';
import { type ClassInfo, createClass, type JavaType, typeName } from './types';
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
    return newString(frame, `${cls.kind === 'interface' ? 'interface' : 'class'} ${classNameOf(frame, cls)}`);
  });
  const getClass = addMethod(objectClass, 'getClass', [], classClass.type, false, (frame, receiver) => {
    if (receiver instanceof JavaArray) return classObjectOf(arrayClassOf(frame, receiver.elementType), classClass);
    const cls = receiver instanceof JavaObject ? receiver.cls : frame.runtime.builtins.stringClass;
    return classObjectOf(cls, classClass);
  });
  getClass.isFinal = true;
}

const arrayClasses = new Map<string, ClassInfo>();

/** A class standing for an array type, named as `Class.getName` (`[I`) and `getSimpleName` (`int[]`) name it. */
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
