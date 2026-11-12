import { DictStore, NamespaceDictStore } from './dictStore';
import { SetTable } from './setTable';
import {
  type ExceptionState,
  type Kwargs,
  type NativeBinding,
  type NativeFunction,
  PyBuiltinFunction,
  PyClass,
  PyDict,
  PyError,
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
export const methodDescriptorClass = builtinClass('method_descriptor');
export const moduleClass = builtinClass('module');
export const generatorClass = builtinClass('generator');
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
  | 'NotImplementedError'
  | 'MemoryError'
  | 'ImportError'
  | 'ModuleNotFoundError'
  | 'SystemError'
  | 'LookupError'
  | 'UnicodeEncodeError'
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

const namespaceDicts = new WeakMap<Map<string, PyValue>, PyDict>();

/** The `__dict__` of an attribute map, one dict per map, which reads and writes the attributes themselves. */
export function namespaceDict(namespace: Map<string, PyValue>): PyDict {
  let dict = namespaceDicts.get(namespace);
  if (!dict) {
    dict = new PyDict(dictClass, new NamespaceDictStore(namespace));
    namespaceDicts.set(namespace, dict);
  }
  return dict;
}

export function newSet(items: Iterable<PyValue> = [], frozen = false): PySet {
  const set = new PySet(frozen ? frozensetClass : setClass, new SetTable());
  for (const item of items) set.table.add(item);
  return set;
}

// Builtin functions -------------------------------------------------------------------------------------------------

export function nativeFunction(name: string, run: NativeFunction, ownerName?: string): PyBuiltinFunction {
  return new PyBuiltinFunction(builtinFunctionClass, name, run, undefined, 'method', ownerName);
}

/**
 * How a builtin method treats the receiver it is called with: CPython's method descriptors (`method`) and slot wrappers
 * (`wrapper`) reject one that is not an instance of the declaring class, each in its own words, while a method its
 * library writes in Python (`unchecked`) runs its body with any receiver.
 */
export type ReceiverCheck = 'method' | 'wrapper' | 'unchecked';

export interface MethodOptions {
  binding?: NativeBinding;
  receiver?: ReceiverCheck;
  /** The name receiver errors give the declaring class, when CPython declares the method on a C base of it. */
  ownerName?: string;
}

/** Adds a builtin method to a class, which receives the instance as its first argument. */
export function defineMethod(
  cls: PyClass,
  name: string,
  run: (self: PyValue, args: PyValue[], kwargs: Kwargs) => PyValue,
  { binding = 'method', receiver = 'method', ownerName }: MethodOptions = {}
): void {
  const check = binding === 'method' ? receiverCheck(cls, name, receiver, ownerName) : undefined;
  cls.dict.set(
    name,
    new PyBuiltinFunction(
      methodDescriptorClass,
      name,
      (args, kwargs) => {
        check?.(args[0]);
        return run(args[0], args.slice(1), kwargs);
      },
      undefined,
      binding,
      cls.name
    )
  );
}

function receiverCheck(
  cls: PyClass,
  name: string,
  receiver: ReceiverCheck,
  ownerName = cls.tpName ?? cls.name
): ((self: PyValue | undefined) => void) | undefined {
  if (receiver === 'unchecked') return undefined;
  return (self) => {
    if (self === undefined) throw typeError(missingReceiverMessage(cls, name, receiver, ownerName));
    if (cls.isWrittenInPython || isInstanceOf(self, cls)) return;
    throw typeError(
      receiver === 'wrapper'
        ? `descriptor '${name}' requires a '${ownerName}' object but received a '${typeName(self)}'`
        : `descriptor '${name}' for '${ownerName}' objects doesn't apply to a '${typeName(self)}' object`
    );
  };
}

function missingReceiverMessage(cls: PyClass, name: string, receiver: ReceiverCheck, ownerName: string): string {
  if (cls.isWrittenInPython) return `${cls.name}.${name}() missing 1 required positional argument: 'self'`;
  return receiver === 'wrapper'
    ? `descriptor '${name}' of '${ownerName}' object needs an argument`
    : `unbound method ${cls.name}.${name}() needs an argument`;
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

/** The name of a value's class, as error messages quote it. */
export function typeName(value: PyValue): string {
  const cls = classOf(value);
  return cls.tpName ?? cls.name;
}

export type { Kwargs };
