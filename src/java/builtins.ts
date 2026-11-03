import { TURTLE_METHOD_NAMES, type TurtleState } from '../interpreter/turtleWorld';
import { type Frame, throwBuiltin } from './runtime';
import {
  BOOLEAN,
  CHAR,
  type ClassInfo,
  createClass,
  DOUBLE,
  type FieldInfo,
  INT,
  type JavaType,
  type MethodInfo,
  type NativeMethod,
  VOID,
} from './types';
import {
  charCodeOf,
  charToString,
  formatDouble,
  JavaArray,
  JavaObject,
  JavaString,
  toInt32,
  type Value,
} from './values';

export interface Builtins {
  classes: Map<string, ClassInfo>;
  objectClass: ClassInfo;
  stringClass: ClassInfo;
  throwableClass: ClassInfo;
  /** The qualified names `Throwable.toString` prints for builtin classes. */
  qualifiedNames: Map<ClassInfo, string>;
}

let cachedBuiltins: Builtins | undefined;

/** Builtin classes carry no per-run state, so every program shares one set. */
export function getBuiltins(): Builtins {
  cachedBuiltins ??= createBuiltins();
  return cachedBuiltins;
}

interface Registry {
  classes: Map<string, ClassInfo>;
  qualifiedNames: Map<ClassInfo, string>;
  define: (name: string, superclass: ClassInfo | undefined, packageName?: string) => ClassInfo;
}

function createBuiltins(): Builtins {
  const registry = createRegistry();
  const objectClass = registry.define('Object', undefined);
  const stringClass = registry.define('String', objectClass);
  defineObject(objectClass, stringClass.type);
  defineString(stringClass, objectClass.type);
  const throwableClass = defineThrowables(registry, objectClass, stringClass.type);
  defineTurtle(registry.define('Turtle', objectClass, ''), stringClass.type);
  defineMath(registry.define('Math', objectClass));
  defineInteger(registry.define('Integer', objectClass), stringClass.type);
  defineSystem(registry, objectClass, stringClass.type);
  return {
    classes: registry.classes,
    objectClass,
    stringClass,
    throwableClass,
    qualifiedNames: registry.qualifiedNames,
  };
}

function createRegistry(): Registry {
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

function defineObject(objectClass: ClassInfo, stringType: JavaType): void {
  addMethod(objectClass, 'equals', [objectClass.type], BOOLEAN, false, (_, receiver, [other]) => receiver === other);
  addMethod(objectClass, 'hashCode', [], INT, false, (_, receiver) => identityOf(receiver));
  addMethod(objectClass, 'toString', [], stringType, false, (frame, receiver) => {
    const name = receiver instanceof JavaObject ? receiver.cls.name : 'Object';
    return newString(frame, `${name}@${identityOf(receiver).toString(16)}`);
  });
  addConstructor(objectClass, [], () => {});
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

function defineThrowables(registry: Registry, objectClass: ClassInfo, stringType: JavaType): ClassInfo {
  const defineThrowable = (name: string, superclass: ClassInfo): ClassInfo => {
    const cls = registry.define(name, superclass);
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
  addMethod(throwableClass, 'toString', [], stringType, false, (frame, receiver) => {
    const exception = receiver as JavaObject;
    const name = registry.qualifiedNames.get(exception.cls) ?? exception.cls.name;
    return newString(frame, exception.message ? `${name}: ${exception.message.value}` : name);
  });
  const exceptionClass = defineThrowable('Exception', throwableClass);
  const runtimeExceptionClass = defineThrowable('RuntimeException', exceptionClass);
  const errorClass = defineThrowable('Error', throwableClass);
  for (const name of [
    'ArithmeticException',
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

function defineMath(mathClass: ClassInfo): void {
  for (const type of [INT, DOUBLE]) {
    addMethod(mathClass, 'abs', [type], type, true, (_, __, [value]) =>
      type === INT ? toInt32(Math.abs(value as number)) : Math.abs(value as number)
    );
    addMethod(mathClass, 'max', [type, type], type, true, (_, __, [a, b]) => javaMax(a as number, b as number));
    addMethod(mathClass, 'min', [type, type], type, true, (_, __, [a, b]) => javaMin(a as number, b as number));
  }
  for (const name of ['sqrt', 'floor', 'ceil'] as const) {
    addMethod(mathClass, name, [DOUBLE], DOUBLE, true, (_, __, [value]) => Math[name](value as number));
  }
  addMethod(mathClass, 'pow', [DOUBLE, DOUBLE], DOUBLE, true, (_, __, [a, b]) => (a as number) ** (b as number));
  addConstant(mathClass, 'PI', DOUBLE, Math.PI);
  addConstant(mathClass, 'E', DOUBLE, Math.E);
}

function defineInteger(integerClass: ClassInfo, stringType: JavaType): void {
  addConstant(integerClass, 'MAX_VALUE', INT, 2_147_483_647);
  addConstant(integerClass, 'MIN_VALUE', INT, -2_147_483_648);
  addMethod(integerClass, 'parseInt', [stringType], INT, true, (frame, _, [text]) => {
    const value = (text as JavaString | undefined)?.value;
    frame.runtime.scanString(value?.length ?? 0);
    if (value === undefined || !/^[+-]?\d+$/.test(value) || Math.abs(Number(value)) > 2_147_483_648) {
      throwBuiltin(
        frame,
        'NumberFormatException',
        value === undefined ? 'Cannot parse null string: null' : `For input string: "${value}"`
      );
    }
    const parsed = Number(value);
    if (parsed > 2_147_483_647) throwBuiltin(frame, 'NumberFormatException', `For input string: "${value}"`);
    return parsed;
  });
  addMethod(integerClass, 'toString', [INT], stringType, true, (frame, __, [value]) =>
    newString(frame, String(value as number))
  );
}

function defineSystem(registry: Registry, objectClass: ClassInfo, stringType: JavaType): void {
  const printStreamClass = registry.define('PrintStream', objectClass, 'java.io');
  const systemClass = registry.define('System', objectClass);
  addConstant(systemClass, 'out', printStreamClass.type, new JavaObject(printStreamClass));
  for (const [name, suffix] of [
    ['print', ''],
    ['println', '\n'],
  ] as const) {
    for (const type of [INT, DOUBLE, CHAR, BOOLEAN, stringType, objectClass.type]) {
      addMethod(printStreamClass, name, [type], VOID, false, (frame, _, [value]) => {
        frame.runtime.budget.print(`${stringify(frame, value, type)}${suffix}`);
      });
    }
  }
  addMethod(printStreamClass, 'println', [], VOID, false, (frame) => {
    frame.runtime.budget.print('\n');
  });
}

function defineString(stringClass: ClassInfo, objectType: JavaType): void {
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
  for (const type of [INT, DOUBLE, CHAR, BOOLEAN, objectType]) {
    addMethod(stringClass, 'valueOf', [type], stringType, true, (frame, _, [value]) =>
      newString(frame, stringify(frame, value, type))
    );
  }
}

function newString(frame: Frame, value: string): JavaString {
  frame.runtime.allocateString(frame, value.length);
  return new JavaString(value);
}

function text(value: Value): string {
  return (value as JavaString).value;
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

function requireString(frame: Frame, value: Value): string {
  if (!(value instanceof JavaString)) return throwBuiltin(frame, 'NullPointerException');
  return value.value;
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

function addMethod(
  cls: ClassInfo,
  name: string,
  parameterTypes: JavaType[],
  returnType: JavaType,
  isStatic: boolean,
  native: NativeMethod
): MethodInfo {
  const method: MethodInfo = {
    name,
    owner: cls,
    parameterTypes,
    returnType,
    isStatic,
    isAbstract: false,
    isConstructor: false,
    access: 'public',
    thrownTypes: [],
    native,
  };
  cls.methods.push(method);
  return method;
}

function addConstructor(cls: ClassInfo, parameterTypes: JavaType[], native: NativeMethod): void {
  cls.constructors.push({
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
  });
}

function addConstant(cls: ClassInfo, name: string, type: JavaType, constant: Value): void {
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

function identityOf(value: Value): number {
  if (value instanceof JavaObject || value instanceof JavaArray) return value.identity;
  return 0;
}

function javaMax(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return a === 0 && b === 0 ? (Object.is(a, -0) ? b : a) : Math.max(a, b);
}

function javaMin(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return a === 0 && b === 0 ? (Object.is(a, -0) ? a : b) : Math.min(a, b);
}

/** Converts a value to the text that string concatenation and `print` produce. */
export function stringify(frame: Frame, value: Value, type: JavaType): string {
  switch (type.kind) {
    case 'int': {
      return String(value as number);
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

function arrayTypeCode(type: JavaType): string {
  switch (type.kind) {
    case 'int': {
      return 'I';
    }
    case 'double': {
      return 'D';
    }
    case 'char': {
      return 'C';
    }
    case 'boolean': {
      return 'Z';
    }
    case 'array': {
      return `[${arrayTypeCode(type.element)}`;
    }
    default: {
      return `L${type.kind === 'class' ? type.cls.name : 'Object'};`;
    }
  }
}
