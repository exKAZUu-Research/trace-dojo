import { TURTLE_METHOD_NAMES, type TurtleState } from '../interpreter/turtleWorld';
import { type Collections, defineCollections, javaEquals, javaHash, linkComparator } from './builtinCollections';
import { defineFunctions, type Functions } from './builtinFunctions';
import { defineMath } from './builtinMath';
import { defineMisc } from './builtinMisc';
import { defineStreams } from './builtinStreams';
import {
  addConstant,
  addConstructor,
  addInterface,
  addMethod,
  addTypeParameters,
  createRegistry,
  newString,
  type Registry,
  requireString,
  text,
} from './builtinSupport';
import { defineText } from './builtinText';
import { defineUtilities } from './builtinUtilities';
import { type BoxableKind, defineWrappers, hashOf, type Wrappers } from './builtinWrappers';
import { type Frame, ProgramExit, throwBuiltin } from './runtime';
import {
  BOOLEAN,
  CHAR,
  type ClassInfo,
  DOUBLE,
  type FieldInfo,
  FLOAT,
  INT,
  isPrimitive,
  type JavaType,
  LONG,
  type MethodInfo,
  type NativeMethod,
  OBJECT_TYPE,
  VOID,
} from './types';
import {
  charCodeOf,
  charToString,
  formatDouble,
  formatFloat,
  JavaArray,
  JavaObject,
  JavaString,
  toInt32,
  type Value,
} from './values';

const CHAR_ARRAY: JavaType = { kind: 'array', element: CHAR };

export interface Builtins {
  classes: Map<string, ClassInfo>;
  objectClass: ClassInfo;
  stringClass: ClassInfo;
  enumClass: ClassInfo;
  recordClass: ClassInfo;
  throwableClass: ClassInfo;
  wrappers: Wrappers;
  collections: Collections;
  functions: Functions;
  /** The qualified names `Throwable.toString` prints for builtin classes. */
  qualifiedNames: Map<ClassInfo, string>;
}

let cachedBuiltins: Builtins | undefined;

/** Builtin classes carry no per-run state, so every program shares one set. */
export function getBuiltins(): Builtins {
  cachedBuiltins ??= createBuiltins();
  return cachedBuiltins;
}

function createBuiltins(): Builtins {
  const registry = createRegistry();
  const objectClass = registry.define('Object', undefined);
  OBJECT_TYPE.value = objectClass.type;
  const stringClass = registry.define('String', objectClass);
  defineObject(objectClass, stringClass.type);
  defineClassClass(registry, objectClass, stringClass.type);
  defineString(stringClass, objectClass.type);
  stringClass.isFinal = true;
  const enumClass = defineEnum(registry.define('Enum', objectClass), stringClass.type);
  const recordClass = defineRecord(registry.define('Record', objectClass), objectClass, stringClass.type);
  const throwableClass = defineThrowables(registry, objectClass, stringClass.type);
  defineTurtle(registry.define('Turtle', objectClass, ''), stringClass.type);
  defineMath(registry.define('Math', objectClass));
  const wrappers = defineWrappers(registry, objectClass, stringClass.type);
  const stringCompareTo = stringClass.methods.find((method) => method.name === 'compareTo') as MethodInfo;
  stringCompareTo.overrides = new Set([wrappers.compareTo]);
  addInterface(stringClass, { kind: 'class', cls: wrappers.comparableClass, args: [stringClass.type] });
  const collections = defineCollections(registry, objectClass, stringClass.type, wrappers);
  defineSystem(registry, objectClass, stringClass.type);
  defineMisc(registry, objectClass, stringClass.type);
  defineUtilities(registry, objectClass, stringClass.type, collections, wrappers.comparableClass);
  defineText(registry, objectClass, stringClass, registry.classes.get('PrintStream') as ClassInfo, collections);
  const functions = defineFunctions(registry, objectClass, collections, wrappers.comparableClass);
  linkComparator(collections, functions.comparatorClass);
  defineStreams(registry, objectClass, stringClass.type, collections, wrappers, functions);
  return {
    classes: registry.classes,
    objectClass,
    stringClass,
    enumClass,
    recordClass,
    throwableClass,
    wrappers,
    collections,
    functions,
    qualifiedNames: registry.qualifiedNames,
  };
}

function defineObject(objectClass: ClassInfo, stringType: JavaType): void {
  addMethod(objectClass, 'equals', [objectClass.type], BOOLEAN, false, (_, receiver, [other]) => receiver === other);
  addMethod(objectClass, 'hashCode', [], INT, false, (_, receiver) => identityOf(receiver));
  addMethod(objectClass, 'toString', [], stringType, false, (frame, receiver) => {
    const name = receiver instanceof JavaObject ? classNameOf(frame, receiver.cls) : 'java.lang.Object';
    return newString(frame, `${name}@${identityOf(receiver).toString(16)}`);
  });
  addConstructor(objectClass, [], () => {});
}

/** The name `Class.getName` gives: the qualified name of a builtin class, or the binary name of a program's class. */
function classNameOf(frame: Frame, cls: ClassInfo): string {
  return frame.runtime.builtins.qualifiedNames.get(cls) ?? cls.binaryName;
}

function reflected(receiver: Value): ClassInfo {
  return (receiver as JavaObject).reflected as ClassInfo;
}

/** The objects `getClass()` returns, one for each class, so that `==` compares classes. */
const classObjects = new WeakMap<ClassInfo, JavaObject>();

function defineClassClass(registry: Registry, objectClass: ClassInfo, stringType: JavaType): void {
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
    const cls =
      receiver instanceof JavaObject
        ? receiver.cls
        : receiver instanceof JavaString
          ? frame.runtime.builtins.stringClass
          : objectClass;
    return classObjectOf(cls, classClass);
  });
  getClass.isFinal = true;
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

function defineEnum(enumClass: ClassInfo, stringType: JavaType): ClassInfo {
  enumClass.isAbstract = true;
  addMethod(enumClass, 'name', [], stringType, false, (_, receiver) => nameOf(receiver)).isFinal = true;
  addMethod(enumClass, 'toString', [], stringType, false, (_, receiver) => nameOf(receiver));
  addMethod(enumClass, 'ordinal', [], INT, false, (_, receiver) => ordinalOf(receiver)).isFinal = true;
  addConstructor(enumClass, [], () => {});
  return enumClass;
}

/** `Record`, whose `toString`, `equals`, and `hashCode` read the components that each record declares. */
function defineRecord(recordClass: ClassInfo, objectClass: ClassInfo, stringType: JavaType): ClassInfo {
  recordClass.isAbstract = true;
  addConstructor(recordClass, [], () => {});
  addMethod(recordClass, 'toString', [], stringType, false, (frame, receiver) => {
    const object = receiver as JavaObject;
    const parts = componentsOf(receiver).map(
      (field) => `${field.name}=${stringify(frame, object.fields[field.slot], field.type)}`
    );
    return newString(frame, `${object.cls.name}[${parts.join(', ')}]`);
  });
  addMethod(recordClass, 'equals', [objectClass.type], BOOLEAN, false, (frame, receiver, [other]) => {
    const object = receiver as JavaObject;
    if (!(other instanceof JavaObject) || other.cls !== object.cls) return false;
    return componentsOf(receiver).every((field) => {
      const [a, b] = [object.fields[field.slot], other.fields[field.slot]];
      // Primitive components compare as their wrappers' compare does, so NaN equals NaN.
      return isPrimitive(field.type) ? Object.is(a, b) || a === b : javaEquals(frame, a, b);
    });
  });
  addMethod(recordClass, 'hashCode', [], INT, false, (frame, receiver) => {
    const object = receiver as JavaObject;
    let hash = 0;
    for (const field of componentsOf(receiver)) {
      const value = object.fields[field.slot];
      const fieldHash = isPrimitive(field.type)
        ? hashOf(value, field.type.kind as BoxableKind)
        : javaHash(frame, value);
      hash = toInt32(Math.imul(hash, 31) + fieldHash);
    }
    return hash;
  });
  return recordClass;
}

function componentsOf(receiver: Value): FieldInfo[] {
  return (receiver as JavaObject).cls.recordComponents ?? [];
}

function nameOf(receiver: Value): JavaString {
  return (receiver as JavaObject).enumConstant?.name as JavaString;
}

function ordinalOf(value: Value): number {
  return (value as JavaObject).enumConstant?.ordinal as number;
}

const causeTakers = new Set([
  'Throwable',
  'Exception',
  'RuntimeException',
  'Error',
  'IllegalArgumentException',
  'IllegalStateException',
  'UnsupportedOperationException',
]);

// code-gauge-allow functionNcss 44 -- One registration per builtin method, each a small native.
function defineThrowables(registry: Registry, objectClass: ClassInfo, stringType: JavaType): ClassInfo {
  const defineThrowable = (name: string, superclass: ClassInfo, packageName = 'java.lang'): ClassInfo => {
    const cls = registry.define(name, superclass, packageName);
    // Constructors are not inherited, and only these classes declare the ones taking a cause.
    addMessageConstructors(cls, stringType, causeTakers.has(name) ? throwableClass.type : undefined);
    return cls;
  };
  const throwableClass = registry.define('Throwable', objectClass);
  addMessageConstructors(throwableClass, stringType, throwableClass.type);
  addMethod(throwableClass, 'getMessage', [], stringType, false, (_, receiver) => (receiver as JavaObject).message);
  addMethod(
    throwableClass,
    'getCause',
    [],
    throwableClass.type,
    false,
    (_, receiver) => (receiver as JavaObject).cause
  );
  addMethod(throwableClass, 'addSuppressed', [throwableClass.type], VOID, false, (frame, receiver, [other]) => {
    if (other === receiver) throwBuiltin(frame, 'IllegalArgumentException', 'Self-suppression not permitted');
    if (!(other instanceof JavaObject))
      throwBuiltin(frame, 'NullPointerException', 'Cannot suppress a null exception.');
    ((receiver as JavaObject).suppressed ??= []).push(other);
  });
  addMethod(
    throwableClass,
    'getSuppressed',
    [],
    { kind: 'array', element: throwableClass.type },
    false,
    (frame, receiver) => {
      const suppressed = (receiver as JavaObject).suppressed ?? [];
      frame.runtime.allocateArray(frame, suppressed.length);
      return new JavaArray(throwableClass.type, [...suppressed]);
    }
  );
  // A stack trace goes to standard error, which learners do not see.
  addMethod(throwableClass, 'printStackTrace', [], VOID, false, () => {});
  addMethod(throwableClass, 'toString', [], stringType, false, (frame, receiver) => {
    const exception = receiver as JavaObject;
    const name = registry.qualifiedNames.get(exception.cls) ?? exception.cls.name;
    return newString(frame, exception.message ? `${name}: ${exception.message.value}` : name);
  });
  const exceptionClass = defineThrowable('Exception', throwableClass);
  defineThrowable('InterruptedException', exceptionClass);
  const runtimeExceptionClass = defineThrowable('RuntimeException', exceptionClass);
  const errorClass = defineThrowable('Error', throwableClass);
  for (const name of [
    'ArithmeticException',
    'ArrayStoreException',
    'ClassCastException',
    'IllegalArgumentException',
    'IllegalStateException',
    'IndexOutOfBoundsException',
    'NegativeArraySizeException',
    'NullPointerException',
    'UnsupportedOperationException',
  ]) {
    defineThrowable(name, runtimeExceptionClass);
  }
  const indexOutOfBounds = registry.classes.get('IndexOutOfBoundsException') as ClassInfo;
  defineThrowable('ArrayIndexOutOfBoundsException', indexOutOfBounds);
  defineThrowable('StringIndexOutOfBoundsException', indexOutOfBounds);
  defineThrowable('NumberFormatException', registry.classes.get('IllegalArgumentException') as ClassInfo);
  defineThrowable('ConcurrentModificationException', runtimeExceptionClass, 'java.util');
  const illegalArgument = registry.classes.get('IllegalArgumentException') as ClassInfo;
  defineThrowable('PatternSyntaxException', illegalArgument, 'java.util.regex');
  const illegalFormat = defineThrowable('IllegalFormatException', illegalArgument, 'java.util');
  for (const name of [
    'MissingFormatArgumentException',
    'UnknownFormatConversionException',
    'IllegalFormatConversionException',
  ]) {
    defineThrowable(name, illegalFormat, 'java.util');
  }
  defineThrowable('NoSuchElementException', runtimeExceptionClass, 'java.util');
  defineThrowable('StackOverflowError', errorClass);
  defineThrowable('OutOfMemoryError', errorClass);
  return throwableClass;
}

function addMessageConstructors(cls: ClassInfo, stringType: JavaType, throwableType: JavaType | undefined): void {
  addConstructor(cls, [], () => {});
  addConstructor(cls, [stringType], (_, receiver, [message]) => {
    (receiver as JavaObject).message = message as JavaString | undefined;
  });
  if (!throwableType) return;
  addConstructor(cls, [throwableType], (frame, receiver, [cause]) => {
    const exception = receiver as JavaObject;
    exception.cause = cause as JavaObject | undefined;
    // Java uses the cause's description as the message.
    if (exception.cause) exception.message = frame.runtime.invokeToString(frame, exception.cause);
  });
  addConstructor(cls, [stringType, throwableType], (_, receiver, [message, cause]) => {
    const exception = receiver as JavaObject;
    exception.message = message as JavaString | undefined;
    exception.cause = cause as JavaObject | undefined;
  });
}

function defineSystem(registry: Registry, objectClass: ClassInfo, stringType: JavaType): void {
  const printStreamClass = registry.define('PrintStream', objectClass, 'java.io');
  const systemClass = registry.define('System', objectClass);
  addConstant(systemClass, 'out', printStreamClass.type, new JavaObject(printStreamClass));
  // Learners see only standard output, so standard error discards what it prints.
  const errorStream = new JavaObject(printStreamClass);
  addConstant(systemClass, 'err', printStreamClass.type, errorStream);
  addMethod(systemClass, 'exit', [INT], VOID, true, () => {
    throw new ProgramExit();
  });
  for (const [name, suffix] of [
    ['print', ''],
    ['println', '\n'],
  ] as const) {
    for (const type of [INT, LONG, FLOAT, DOUBLE, CHAR, BOOLEAN, stringType, objectClass.type]) {
      addMethod(printStreamClass, name, [type], VOID, false, (frame, receiver, [value]) => {
        const text = `${stringify(frame, value, type)}${suffix}`;
        if (receiver !== errorStream) frame.runtime.budget.print(text);
      });
    }
    addMethod(printStreamClass, name, [CHAR_ARRAY], VOID, false, (frame, receiver, [value]) => {
      if (!(value instanceof JavaArray)) throwBuiltin(frame, 'NullPointerException');
      frame.runtime.scanString(value.values.length);
      const text = `${value.values.map((code) => charToString(code as number)).join('')}${suffix}`;
      if (receiver !== errorStream) frame.runtime.budget.print(text);
    });
  }
  addMethod(printStreamClass, 'println', [], VOID, false, (frame, receiver) => {
    if (receiver !== errorStream) frame.runtime.budget.print('\n');
  });
}

function defineString(stringClass: ClassInfo, objectType: JavaType): void {
  addConstructor(stringClass, [], (frame) => newString(frame, ''));
  addConstructor(stringClass, [stringClass.type], (frame, _, [original]) =>
    newString(frame, requireString(frame, original))
  );
  addConstructor(stringClass, [CHAR_ARRAY], (frame, _, [chars]) => {
    if (!(chars instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
    return newString(frame, chars.values.map((code) => charToString(code as number)).join(''));
  });
  addConstructor(stringClass, [CHAR_ARRAY, INT, INT], (frame, _, [chars, offset, count]) => {
    if (!(chars instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
    const [start, length] = [offset as number, count as number];
    if (start < 0 || length < 0 || start + length > chars.values.length) {
      throwBuiltin(
        frame,
        'StringIndexOutOfBoundsException',
        `offset ${start}, count ${length}, length ${chars.values.length}`
      );
    }
    const codes = chars.values.slice(start, start + length);
    return newString(frame, codes.map((code) => charToString(code as number)).join(''));
  });
  defineStringQueries(stringClass, objectType);
  defineStringTransforms(stringClass, objectType);
}

// code-gauge-allow functionNcss 47 -- One registration per String method, each charging the characters it reads.
function defineStringQueries(stringClass: ClassInfo, objectType: JavaType): void {
  const stringType = stringClass.type;
  addMethod(stringClass, 'length', [], INT, false, (_, receiver) => text(receiver).length);
  addMethod(stringClass, 'isEmpty', [], BOOLEAN, false, (_, receiver) => text(receiver).length === 0);
  addMethod(stringClass, 'charAt', [INT], CHAR, false, (frame, receiver, [index]) => {
    checkIndex(frame, index as number, text(receiver).length);
    return charCodeOf(text(receiver), index as number);
  });
  addMethod(stringClass, 'equals', [objectType], BOOLEAN, false, (frame, receiver, [other]) => {
    frame.runtime.scanString(text(receiver).length);
    return other instanceof JavaString && other.value === text(receiver);
  });
  addMethod(stringClass, 'equalsIgnoreCase', [stringType], BOOLEAN, false, (frame, receiver, [other]) => {
    if (!(other instanceof JavaString)) return false;
    frame.runtime.scanString(text(receiver).length + other.value.length);
    return other.value.toLowerCase() === text(receiver).toLowerCase();
  });
  addMethod(stringClass, 'hashCode', [], INT, false, (frame, receiver) => {
    const value = text(receiver);
    frame.runtime.scanString(value.length);
    let hash = 0;
    for (let index = 0; index < value.length; index++) hash = toInt32(Math.imul(hash, 31) + charCodeOf(value, index));
    return hash;
  });
  addMethod(stringClass, 'toString', [], stringType, false, (_, receiver) => receiver);
  addMethod(stringClass, 'substring', [INT], stringType, false, (frame, receiver, [begin]) => {
    const value = text(receiver);
    checkRange(frame, begin as number, value.length, value.length);
    return newString(frame, value.slice(begin as number));
  });
  addMethod(stringClass, 'substring', [INT, INT], stringType, false, (frame, receiver, [begin, end]) => {
    const value = text(receiver);
    checkRange(frame, begin as number, end as number, value.length);
    return newString(frame, value.slice(begin as number, end as number));
  });
  addMethod(stringClass, 'indexOf', [stringType], INT, false, (frame, receiver, [other]) => {
    const pattern = requireString(frame, other);
    // A search may compare the pattern at every position of the text.
    frame.runtime.scanString(text(receiver).length * Math.max(pattern.length, 1));
    return text(receiver).indexOf(pattern);
  });
  addMethod(stringClass, 'indexOf', [INT], INT, false, (frame, receiver, [code]) => {
    frame.runtime.scanString(text(receiver).length);
    const codePoint = code as number;
    if (codePoint < 0 || codePoint > 0x10_ff_ff) return -1;
    return text(receiver).indexOf(String.fromCodePoint(codePoint));
  });
  for (const name of ['contains', 'startsWith', 'endsWith'] as const) {
    const method = name === 'contains' ? 'includes' : name;
    addMethod(stringClass, name, [stringType], BOOLEAN, false, (frame, receiver, [other]) => {
      const pattern = requireString(frame, other);
      frame.runtime.scanString(
        name === 'contains' ? text(receiver).length * Math.max(pattern.length, 1) : pattern.length
      );
      return text(receiver)[method](pattern);
    });
  }
}

// code-gauge-allow functionNcss 38 -- One registration per String method, each charging the characters it reads.
function defineStringTransforms(stringClass: ClassInfo, objectType: JavaType): void {
  const stringType = stringClass.type;
  addMethod(stringClass, 'toUpperCase', [], stringType, false, (frame, receiver) =>
    newString(frame, text(receiver).toUpperCase())
  );
  addMethod(stringClass, 'toLowerCase', [], stringType, false, (frame, receiver) =>
    newString(frame, text(receiver).toLowerCase())
  );
  addMethod(stringClass, 'trim', [], stringType, false, (frame, receiver) => {
    const value = text(receiver);
    frame.runtime.scanString(value.length);
    // String.trim removes every code unit up to U+0020 from both ends.
    let start = 0;
    let end = value.length;
    while (start < end && charCodeOf(value, start) <= 0x20) start++;
    while (end > start && charCodeOf(value, end - 1) <= 0x20) end--;
    return newString(frame, value.slice(start, end));
  });
  addMethod(stringClass, 'concat', [stringType], stringType, false, (frame, receiver, [other]) => {
    const left = text(receiver);
    const right = requireString(frame, other);
    frame.runtime.allocateString(frame, left.length + right.length);
    return new JavaString(left + right);
  });
  addMethod(stringClass, 'repeat', [INT], stringType, false, (frame, receiver, [count]) => {
    if ((count as number) < 0) throwBuiltin(frame, 'IllegalArgumentException', `count is negative: ${count as number}`);
    frame.runtime.allocateString(frame, text(receiver).length * (count as number));
    return new JavaString(text(receiver).repeat(count as number));
  });
  addMethod(stringClass, 'compareTo', [stringType], INT, false, (frame, receiver, [other]) => {
    const left = text(receiver);
    const right = requireString(frame, other);
    frame.runtime.scanString(Math.min(left.length, right.length));
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      if (left[index] !== right[index]) return charCodeOf(left, index) - charCodeOf(right, index);
    }
    return left.length - right.length;
  });
  addMethod(stringClass, 'toCharArray', [], { kind: 'array', element: CHAR }, false, (frame, receiver) => {
    const value = text(receiver);
    frame.runtime.allocateArray(frame, value.length);
    return new JavaArray(
      CHAR,
      Array.from({ length: value.length }, (_, index) => charCodeOf(value, index))
    );
  });
  for (const type of [INT, LONG, FLOAT, DOUBLE, CHAR, BOOLEAN, objectType]) {
    addMethod(stringClass, 'valueOf', [type], stringType, true, (frame, _, [value]) =>
      newString(frame, stringify(frame, value, type))
    );
  }
}

function checkIndex(frame: Frame, index: number, length: number): void {
  if (index < 0 || index >= length) {
    throwBuiltin(frame, 'StringIndexOutOfBoundsException', `Index ${index} out of bounds for length ${length}`);
  }
}

function checkRange(frame: Frame, begin: number, end: number, length: number): void {
  if (begin < 0 || end > length || begin > end) {
    throwBuiltin(frame, 'StringIndexOutOfBoundsException', `begin ${begin}, end ${end}, length ${length}`);
  }
}

function defineTurtle(turtleClass: ClassInfo, stringType: JavaType): void {
  addConstructor(turtleClass, [], createTurtle);
  addConstructor(turtleClass, [INT, INT], createTurtle);
  addConstructor(turtleClass, [INT, INT, stringType], (frame, receiver, args) => {
    // Distinguishes an explicit null color from the default one.
    if (args[2] === undefined) throwBuiltin(frame, 'RuntimeException', 'Invalid color: null');
    return createTurtle(frame, receiver, args);
  });
  const define = (names: readonly string[], returnType: JavaType, impl: NativeMethod): void => {
    for (const name of names) addMethod(turtleClass, name, [], returnType, false, impl);
  };
  define(TURTLE_METHOD_NAMES.forward, VOID, moveTurtle(1));
  define(TURTLE_METHOD_NAMES.backward, VOID, moveTurtle(-1));
  define(TURTLE_METHOD_NAMES.turnRight, VOID, turnTurtle(1));
  define(TURTLE_METHOD_NAMES.turnLeft, VOID, turnTurtle(3));
  define(TURTLE_METHOD_NAMES.canMoveForward, BOOLEAN, canMoveForward);
  define(TURTLE_METHOD_NAMES.isFrontPainted, BOOLEAN, (frame, receiver) =>
    frame.runtime.world.isFrontPainted(stateOf(receiver))
  );
  define(TURTLE_METHOD_NAMES.remove, VOID, (frame, receiver) => {
    const { turtle } = receiver as JavaObject;
    if (turtle) frame.runtime.world.remove(turtle);
  });
}

function createTurtle(frame: Frame, receiver: Value, [x = 0, y = 0, color]: Value[]): Value {
  const created = frame.runtime.world.create(x as number, y as number, (color as JavaString | undefined)?.value);
  if ('error' in created) return throwBuiltin(frame, 'RuntimeException', created.error);
  (receiver as JavaObject).turtle = created;
  return undefined;
}

function moveTurtle(sign: number): NativeMethod {
  return (frame, receiver) => {
    frame.runtime.spend();
    const error = frame.runtime.world.move(stateOf(receiver), sign);
    if (error) throwBuiltin(frame, 'RuntimeException', error);
  };
}

function turnTurtle(quarters: number): NativeMethod {
  return (frame, receiver) => {
    frame.runtime.spend();
    frame.runtime.world.turn(stateOf(receiver), quarters);
  };
}

function canMoveForward(frame: Frame, receiver: Value): Value {
  frame.runtime.collectGarbage();
  return frame.runtime.world.canMoveForward(stateOf(receiver));
}

function stateOf(receiver: Value): TurtleState {
  const state = (receiver as JavaObject).turtle;
  if (!state) throw new Error('A turtle without its state');
  return state;
}

function identityOf(value: Value): number {
  if (value instanceof JavaObject || value instanceof JavaArray) return value.identity;
  return 0;
}

/** Converts a value to the text that string concatenation and `print` produce. */
export function stringify(frame: Frame, value: Value, type: JavaType): string {
  switch (type.kind) {
    case 'byte':
    case 'short':
    case 'int':
    case 'long': {
      return String(value as number | bigint);
    }
    case 'float': {
      return formatFloat(value as number);
    }
    case 'double': {
      return formatDouble(value as number);
    }
    case 'char': {
      return charToString(value as number);
    }
    case 'boolean': {
      return String(value as boolean);
    }
    default: {
      if (value === undefined) return 'null';
      if (value instanceof JavaString) return value.value;
      if (value instanceof JavaArray) {
        return `[${arrayTypeCode(value.elementType)}@${value.identity.toString(16)}`;
      }
      const result = frame.runtime.invokeToString(frame, value as JavaObject);
      return result === undefined ? 'null' : result.value;
    }
  }
}

const primitiveTypeCodes: Record<string, string> = {
  byte: 'B',
  short: 'S',
  int: 'I',
  long: 'J',
  float: 'F',
  double: 'D',
  char: 'C',
  boolean: 'Z',
};

function arrayTypeCode(type: JavaType): string {
  const primitiveCode = primitiveTypeCodes[type.kind] as string | undefined;
  if (primitiveCode) return primitiveCode;
  switch (type.kind) {
    case 'array': {
      return `[${arrayTypeCode(type.element)}`;
    }
    default: {
      return `L${type.kind === 'class' ? type.cls.name : 'Object'};`;
    }
  }
}
