import { DictStore } from './dictStore';
import { SetTable } from './setTable';
import { recordSubclass } from './subclasses';
import {
  type ExceptionState,
  type Kwargs,
  type NativeBinding,
  type NativeFunction,
  PyBuiltinFunction,
  PyClass,
  PyDict,
  PyError,
  PyGenerator,
  PyInstance,
  PyList,
  PyObject,
  PySet,
  PyTuple,
  type PyValue,
} from './values';

// Metatypes ---------------------------------------------------------------------------------------------------------

export const typeClass = new PyClass('type', []);
export const objectClass = new PyClass('object', []);
typeClass.cls = typeClass;
objectClass.cls = typeClass;
typeClass.bases = [objectClass];
recordSubclass(typeClass);
objectClass.mro = [objectClass];
typeClass.mro = [typeClass, objectClass];
typeClass.isBaseType = true;
objectClass.isBaseType = true;

/** Creates a builtin class with a single inheritance chain. */
export function builtinClass(name: string, base: PyClass = objectClass, isBaseType = false): PyClass {
  const cls = new PyClass(name, [base], typeClass);
  cls.mro = [cls, ...base.mro];
  cls.isBaseType = isBaseType;
  cls.layout = { base: base.layout.base === 'object' && base !== objectClass ? 'native' : base.layout.base };
  if (base === objectClass) cls.layout = { base: 'native' };
  return cls;
}

export const intClass = builtinClass('int');
export const boolClass = builtinClass('bool', intClass);
export const floatClass = builtinClass('float');
export const complexClass = builtinClass('complex');
export const strClass = builtinClass('str');
export const bytesClass = builtinClass('bytes');
export const bytearrayClass = builtinClass('bytearray');
export const memoryviewClass = builtinClass('memoryview');
export const listClass = builtinClass('list');
export const tupleClass = builtinClass('tuple');
export const dictClass = builtinClass('dict');
export const setClass = builtinClass('set');
export const frozensetClass = builtinClass('frozenset');
export const rangeClass = builtinClass('range');
export const sliceClass = builtinClass('slice');
export const noneClass = builtinClass('NoneType');
export const ellipsisClass = builtinClass('ellipsis');
export const notImplementedClass = builtinClass('NotImplementedType');
export const functionClass = builtinClass('function');
export const methodClass = builtinClass('method');
export const builtinFunctionClass = builtinClass('builtin_function_or_method');
// The type of CPython's builtin methods that take their defining class, which none here are, but which pydoc lists.
builtinClass('builtin_method', builtinFunctionClass);
export const methodDescriptorClass = builtinClass('method_descriptor');
/** The class of a builtin type's special method that fills one of CPython's type slots, such as `int.__add__`. */
export const wrapperDescriptorClass = builtinClass('wrapper_descriptor');
/** The class of a slot's special method bound to an object, such as `(1).__add__`. */
export const methodWrapperClass = builtinClass('method-wrapper');
/** The class of a builtin type's class method as its dictionary holds it, such as `dict.fromkeys`. */
export const classmethodDescriptorClass = builtinClass('classmethod_descriptor');
export const moduleClass = builtinClass('module');
export const generatorClass = builtinClass('generator');
export const coroutineClass = builtinClass('coroutine');
export const asyncGeneratorClass = builtinClass('async_generator');
export const staticmethodClass = builtinClass('staticmethod');
export const classmethodClass = builtinClass('classmethod');
export const propertyClass = builtinClass('property');
export const superClass = builtinClass('super');
export const dictKeysClass = builtinClass('dict_keys');
export const dictValuesClass = builtinClass('dict_values');
export const dictItemsClass = builtinClass('dict_items');
export const cellClass = builtinClass('cell');

for (const cls of [
  intClass,
  floatClass,
  complexClass,
  strClass,
  listClass,
  tupleClass,
  dictClass,
  setClass,
  frozensetClass,
]) {
  cls.isBaseType = true;
}

export const None = new PyObject(noneClass);
export const Ellipsis = new PyObject(ellipsisClass);
export const NotImplemented = new PyObject(notImplementedClass);

export const iteratorClasses = new Map<string, PyClass>();
/** Gives each new iterator class the iterator protocol, registered by the module that defines it. */
export const iteratorClassSetup: ((cls: PyClass) => void)[] = [];

/** The class of a native iterator, such as `list_iterator`. */
export function iteratorClass(name: string): PyClass {
  let cls = iteratorClasses.get(name);
  if (!cls) {
    cls = builtinClass(name);
    iteratorClasses.set(name, cls);
    for (const setup of iteratorClassSetup) setup(cls);
  }
  return cls;
}

// Exceptions --------------------------------------------------------------------------------------------------------

export const baseExceptionClass = builtinClass('BaseException', objectClass, true);
baseExceptionClass.layout = { base: 'exception' };

function exceptionClass(name: string, base: PyClass): PyClass {
  const cls = builtinClass(name, base, true);
  cls.layout = { base: 'exception' };
  return cls;
}

export const exceptionClasses = new Map<string, PyClass>([['BaseException', baseExceptionClass]]);

/** The builtin exception hierarchy, as CPython defines it, in its order of definition. */
const EXCEPTION_TREE: [string, string][] = [
  ['BaseExceptionGroup', 'BaseException'],
  ['Exception', 'BaseException'],
  ['GeneratorExit', 'BaseException'],
  ['KeyboardInterrupt', 'BaseException'],
  ['SystemExit', 'BaseException'],
  ['ArithmeticError', 'Exception'],
  ['AssertionError', 'Exception'],
  ['AttributeError', 'Exception'],
  ['BufferError', 'Exception'],
  ['EOFError', 'Exception'],
  ['ImportError', 'Exception'],
  ['LookupError', 'Exception'],
  ['MemoryError', 'Exception'],
  ['NameError', 'Exception'],
  ['OSError', 'Exception'],
  ['ReferenceError', 'Exception'],
  ['RuntimeError', 'Exception'],
  ['StopAsyncIteration', 'Exception'],
  ['StopIteration', 'Exception'],
  ['SyntaxError', 'Exception'],
  ['SystemError', 'Exception'],
  ['TypeError', 'Exception'],
  ['ValueError', 'Exception'],
  ['Warning', 'Exception'],
  ['FloatingPointError', 'ArithmeticError'],
  ['OverflowError', 'ArithmeticError'],
  ['ZeroDivisionError', 'ArithmeticError'],
  ['BytesWarning', 'Warning'],
  ['DeprecationWarning', 'Warning'],
  ['EncodingWarning', 'Warning'],
  ['FutureWarning', 'Warning'],
  ['ImportWarning', 'Warning'],
  ['PendingDeprecationWarning', 'Warning'],
  ['ResourceWarning', 'Warning'],
  ['RuntimeWarning', 'Warning'],
  ['SyntaxWarning', 'Warning'],
  ['UnicodeWarning', 'Warning'],
  ['UserWarning', 'Warning'],
  ['BlockingIOError', 'OSError'],
  ['ChildProcessError', 'OSError'],
  ['ConnectionError', 'OSError'],
  ['FileExistsError', 'OSError'],
  ['FileNotFoundError', 'OSError'],
  ['InterruptedError', 'OSError'],
  ['IsADirectoryError', 'OSError'],
  ['NotADirectoryError', 'OSError'],
  ['PermissionError', 'OSError'],
  ['ProcessLookupError', 'OSError'],
  ['TimeoutError', 'OSError'],
  ['IndentationError', 'SyntaxError'],
  ['_IncompleteInputError', 'SyntaxError'],
  ['IndexError', 'LookupError'],
  ['KeyError', 'LookupError'],
  ['ModuleNotFoundError', 'ImportError'],
  ['NotImplementedError', 'RuntimeError'],
  ['PythonFinalizationError', 'RuntimeError'],
  ['RecursionError', 'RuntimeError'],
  ['UnboundLocalError', 'NameError'],
  ['UnicodeError', 'ValueError'],
  ['BrokenPipeError', 'ConnectionError'],
  ['ConnectionAbortedError', 'ConnectionError'],
  ['ConnectionRefusedError', 'ConnectionError'],
  ['ConnectionResetError', 'ConnectionError'],
  ['TabError', 'IndentationError'],
  ['UnicodeDecodeError', 'UnicodeError'],
  ['UnicodeEncodeError', 'UnicodeError'],
  ['UnicodeTranslateError', 'UnicodeError'],
];
for (const [name, base] of EXCEPTION_TREE) {
  exceptionClasses.set(name, exceptionClass(name, exceptionClasses.get(base) as PyClass));
}
const exceptionGroupClass = new PyClass(
  'ExceptionGroup',
  [exceptionClasses.get('BaseExceptionGroup') as PyClass, exceptionClasses.get('Exception') as PyClass],
  typeClass
);
exceptionGroupClass.mro = [
  exceptionGroupClass,
  exceptionClasses.get('BaseExceptionGroup') as PyClass,
  exceptionClasses.get('Exception') as PyClass,
  baseExceptionClass,
  objectClass,
];
exceptionGroupClass.layout = { base: 'exception' };
exceptionGroupClass.isBaseType = true;
exceptionClasses.set('ExceptionGroup', exceptionGroupClass);

export function exceptionClassNamed(name: string): PyClass {
  const cls = exceptionClasses.get(name);
  if (!cls) throw new Error(`Unknown exception class ${name}`);
  return cls;
}

export type ExceptionName =
  | 'TypeError'
  | 'ValueError'
  | 'IndexError'
  | 'KeyError'
  | 'NameError'
  | 'UnboundLocalError'
  | 'AttributeError'
  | 'ZeroDivisionError'
  | 'OverflowError'
  | 'RuntimeError'
  | 'RecursionError'
  | 'StopIteration'
  | 'StopAsyncIteration'
  | 'NotImplementedError'
  | 'MemoryError'
  | 'ImportError'
  | 'ModuleNotFoundError'
  | 'SystemError'
  | 'LookupError'
  | 'UnicodeEncodeError'
  | 'EOFError'
  | 'SystemExit';

/** Creates an exception instance whose `args` are `args`. */
export function newException(cls: PyClass, args: readonly PyValue[]): PyInstance {
  const exception = new PyInstance(cls);
  const state: ExceptionState = { args: newTuple(args), suppressContext: false };
  exception.exception = state;
  return exception;
}

/** The JavaScript error that raises a builtin exception with a message. */
export function pyError(name: ExceptionName, message?: string): PyError {
  return new PyError(newException(exceptionClassNamed(name), message === undefined ? [] : [message]));
}

export function typeError(message: string): PyError {
  return pyError('TypeError', message);
}

export function valueError(message: string): PyError {
  return pyError('ValueError', message);
}

// Containers --------------------------------------------------------------------------------------------------------

export function newList(items: PyValue[]): PyList {
  return new PyList(listClass, items);
}

const emptyTuple = new PyTuple(tupleClass, []);

export function newTuple(items: readonly PyValue[]): PyTuple {
  return items.length === 0 ? emptyTuple : new PyTuple(tupleClass, items);
}

export function newDict(entries: Iterable<[PyValue, PyValue]> = []): PyDict {
  const dict = new PyDict(dictClass, new DictStore());
  for (const [key, value] of entries) dict.store.set(key, value);
  return dict;
}

export function newSet(items: Iterable<PyValue> = [], frozen = false): PySet {
  const set = new PySet(frozen ? frozensetClass : setClass, new SetTable());
  for (const item of items) set.table.add(item);
  return set;
}

/** The class that defines each builtin method descriptor, whose name its repr shows. */
export const descriptorOwners = new WeakMap<PyBuiltinFunction, PyClass>();

/** The special methods that fill CPython's type slots, which `wrapper_descriptor` objects stand for. */
const SLOT_NAMES = new Set(
  [
    'repr str hash call getattribute getattr setattr delattr init del lt le eq ne gt ge iter next get set delete',
    'len contains getitem setitem delitem await aiter anext buffer release_buffer bool int float index',
    'neg pos abs invert add sub mul matmul truediv floordiv mod divmod pow lshift rshift and or xor',
    'radd rsub rmul rmatmul rtruediv rfloordiv rmod rdivmod rpow rlshift rrshift rand ror rxor',
    'iadd isub imul imatmul itruediv ifloordiv imod ipow ilshift irshift iand ior ixor',
  ]
    .join(' ')
    .split(' ')
    .map((name) => `__${name}__`)
);

/** The special methods that a builtin type defines as ordinary methods although they fill a slot, as METH_COEXIST does. */
const METHOD_TABLE_SLOTS = new Map<PyClass, readonly string[]>([
  [listClass, ['__getitem__']],
  [dictClass, ['__contains__', '__getitem__']],
  [setClass, ['__contains__']],
  [frozensetClass, ['__contains__']],
]);

// Builtin functions -------------------------------------------------------------------------------------------------

export function nativeFunction(name: string, run: NativeFunction, ownerName?: string): PyBuiltinFunction {
  return new PyBuiltinFunction(builtinFunctionClass, name, run, undefined, 'method', ownerName);
}

/**
 * Adds a builtin method to a class, which receives the instance as its first argument. The methods of int, float, and
 * str receive the builtin values that instances of a program's subclasses stand for, as their own arguments too,
 * except where CPython renders an argument with its own methods.
 */
export function defineMethod(
  cls: PyClass,
  name: string,
  run: (self: PyValue, args: PyValue[], kwargs: Kwargs) => PyValue,
  binding: NativeBinding = 'method'
): void {
  const unboxes = PRIMITIVE_CLASSES.has(cls) && binding === 'method';
  const unboxesArguments = unboxes && !RENDERING_METHODS.has(name);
  const fn = new PyBuiltinFunction(
    descriptorClassOf(cls, name, binding),
    name,
    (args, kwargs) => {
      if (args.length === 0 && binding === 'method') {
        throw typeError(`unbound method ${cls.name}.${name}() needs an argument`);
      }
      if (!unboxes) return run(args[0], args.slice(1), kwargs);
      return run(unbox(args[0]), unboxesArguments ? args.slice(1).map(unbox) : args.slice(1), kwargs);
    },
    // A static method of a builtin type is a builtin function bound to the type, which calling passes no instance.
    binding === 'static' ? cls : undefined,
    binding,
    cls.name
  );
  descriptorOwners.set(fn, cls);
  cls.dict.set(name, fn);
}

/**
 * Whether a special method found on a class is a builtin type's own, which the interpreter implements natively rather
 * than by calling it.
 */
export function isNativeMethod(value: PyValue | undefined): boolean {
  if (!(value instanceof PyBuiltinFunction)) return false;
  const { cls } = value;
  return cls.name === 'method_descriptor' || cls === wrapperDescriptorClass || cls === classmethodDescriptorClass;
}

/** The class CPython gives a builtin method that `cls` defines under `name`. */
export function descriptorClassOf(cls: PyClass, name: string, binding: NativeBinding): PyClass {
  if (binding === 'static') return builtinFunctionClass;
  if (binding === 'class') return classmethodDescriptorClass;
  return SLOT_NAMES.has(name) && !METHOD_TABLE_SLOTS.get(cls)?.includes(name)
    ? wrapperDescriptorClass
    : methodDescriptorClass;
}

const PRIMITIVE_CLASSES = new Set([intClass, boolClass, floatClass, strClass]);
const RENDERING_METHODS = new Set(['__mod__', '__rmod__', 'format', 'format_map']);

/** The builtin value of an instance of a program's subclass of int, float, or str, or any other value as it is. */
export function unbox(value: PyValue): PyValue {
  return value instanceof PyInstance && value.primitive !== undefined ? value.primitive : value;
}

/** Whether a value is an instance of `cls`, counting `bool` as an `int`. */
export function isInstanceOf(value: PyValue, cls: PyClass): boolean {
  return classOf(value).isSubclassOf(cls);
}

export function classOf(value: PyValue): PyClass {
  switch (typeof value) {
    case 'bigint': {
      return intClass;
    }
    case 'number': {
      return floatClass;
    }
    case 'string': {
      return strClass;
    }
    case 'boolean': {
      return boolClass;
    }
    default: {
      return value.cls;
    }
  }
}

/**
 * The class of the instance that a builtin method copying or combining an instance of `cls` creates: the builtin
 * type itself for a program's subclass of list, tuple, dict, set, or frozenset, which CPython's C types create, and
 * `cls` for the others, such as the collections types, which create an instance of the receiver's class.
 */
export function resultClassOf(cls: PyClass): PyClass {
  if (cls.isBuiltin) return cls;
  const base = cls.mro.find((each) => each.isBuiltin) ?? objectClass;
  return [listClass, tupleClass, dictClass, setClass, frozensetClass].includes(base) ? base : cls;
}

/** The name of a value's class, as error messages quote it. */
export function typeName(value: PyValue): string {
  const cls = classOf(value);
  return cls.typeName ?? cls.name;
}

export type { Kwargs };

/**
 * Whether a value is a generator object that is an iterator: a generator or an awaitable helper, but not a coroutine or
 * an async generator, which share the machinery of generators without being iterators.
 */
export function isIteratorGenerator(value: PyValue): value is PyGenerator {
  return value instanceof PyGenerator && value.cls !== coroutineClass && value.cls !== asyncGeneratorClass;
}
