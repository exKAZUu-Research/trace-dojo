import { DictStore } from './dictStore';
import { SetTable } from './setTable';
import { recordRootClass, recordSubclass } from './subclasses';
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
recordRootClass(objectClass);
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
/** `collections._tuplegetter`, the read-only descriptor of a namedtuple's field, which works as a property does. */
export const tupleGetterClass = builtinClass('_tuplegetter');
tupleGetterClass.module = 'collections';

/** Whether a descriptor's class is property's kind: property, or a namedtuple field's `_tuplegetter`. */
export function isPropertyKind(cls: PyClass): boolean {
  return cls === propertyClass || cls === tupleGetterClass;
}
for (const cls of [staticmethodClass, classmethodClass, propertyClass]) cls.isBaseType = true;
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

/** The class of a native iterator, such as `list_iterator` or `collections._deque_iterator`. */
export function iteratorClass(name: string): PyClass {
  let cls = iteratorClasses.get(name);
  if (!cls) {
    const dot = name.indexOf('.');
    if (dot === -1) {
      cls = builtinClass(name);
    } else {
      cls = builtinClass(name.slice(dot + 1));
      cls.module = name.slice(0, dot);
      cls.typeName = name;
    }
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
  initExceptionFields(cls, state, args);
  exception.exception = state;
  return exception;
}

/** Initializes the C member attributes a builtin exception class derives from its constructor arguments. */
// code-gauge-allow functionCognitiveComplexity 20 -- One case per builtin exception type with C member attributes.
export function initExceptionFields(
  cls: PyClass,
  state: ExceptionState,
  args: readonly PyValue[],
  kwargs?: ReadonlyMap<string, PyValue>
): void {
  const is = (name: string): boolean => cls.mro.some((each) => each.isBuiltin && each.name === name);
  const fields = (state.fields ??= new Map<string, PyValue>());
  if (is('StopIteration')) fields.set('value', args[0] ?? None);
  if (is('SystemExit')) fields.set('code', args.length === 0 ? None : args.length === 1 ? args[0] : state.args);
  if (is('ImportError')) {
    fields.set('msg', args.length === 1 ? args[0] : None);
    fields.set('name', kwargs?.get('name') ?? None);
    fields.set('path', kwargs?.get('path') ?? None);
    fields.set('name_from', kwargs?.get('name_from') ?? None);
  }
  if (is('AttributeError') || is('NameError')) {
    const name = kwargs?.get('name') ?? state.name ?? None;
    fields.set('name', name);
    if (is('AttributeError')) fields.set('obj', kwargs?.get('obj') ?? state.object ?? None);
  }
  if (is('OSError')) initOSErrorFields(state, fields, args);
  const errorName = fields.get('name');
  if (errorName !== undefined) state.name = typeof errorName === 'string' ? errorName : undefined;
  if (fields.has('obj')) state.object = fields.get('obj');
}

/** The fields of OSError, whose `args` keep only errno and strerror when a filename is given. */
function initOSErrorFields(state: ExceptionState, fields: Map<string, PyValue>, args: readonly PyValue[]): void {
  const tupleForm = args.length >= 2 && args.length <= 5;
  fields.set('errno', tupleForm ? args[0] : None);
  fields.set('strerror', tupleForm ? args[1] : None);
  const hasFile = args.length >= 3 && args.length <= 5 && args[2] !== None;
  fields.set('filename', hasFile ? args[2] : None);
  fields.set('filename2', hasFile && args.length === 5 ? args[4] : None);
  if (hasFile) state.args = newTuple(args.slice(0, 2));
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

/** BaseException.add_note on an exception, which the interpreter also calls as CPython's _PyErr_FormatNote does. */
export function addNote(exception: PyInstance, note: string): void {
  if (!exception.exception) return;
  let notes = exception.dict.get('__notes__');
  if (notes === undefined) {
    notes = newList([]);
    exception.dict.set('__notes__', notes);
  }
  if (!(notes instanceof PyList)) throw typeError('Cannot add note: __notes__ is not a list');
  notes.append(note);
}

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

/**
 * Adds a builtin method to a class, which receives the instance as its first argument. The methods of int, float, and
 * str receive the builtin values that instances of a program's subclasses stand for, as their own arguments too,
 * except where CPython renders an argument with its own methods.
 */
export function defineMethod(
  cls: PyClass,
  name: string,
  run: (self: PyValue, args: PyValue[], kwargs: Kwargs, boundTo?: PyValue) => PyValue,
  options: NativeBinding | MethodOptions = {}
): void {
  const opts = typeof options === 'string' ? { binding: options } : options;
  const binding = opts.binding ?? 'method';
  const descriptorClass = descriptorClassOf(cls, name, binding);
  const receiver = opts.receiver ?? (descriptorClass === wrapperDescriptorClass ? 'wrapper' : 'method');
  const check = binding === 'method' ? receiverCheck(cls, name, receiver, opts.ownerName) : undefined;
  const unboxes = PRIMITIVE_CLASSES.has(cls) && binding === 'method';
  const unboxesArguments = unboxes && !RENDERING_METHODS.has(name);
  const fn = new PyBuiltinFunction(
    descriptorClass,
    name,
    (args, kwargs, boundTo) => {
      check?.(args[0]);
      if (!unboxes) return run(args[0], args.slice(1), kwargs, boundTo);
      return run(unbox(args[0]), unboxesArguments ? args.slice(1).map(unbox) : args.slice(1), kwargs, boundTo);
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
  if (cls.isWrittenInPython && binding !== 'class') return functionClass;
  if (binding === 'static') return builtinFunctionClass;
  if (binding === 'class') return classmethodDescriptorClass;
  return SLOT_NAMES.has(name) && !METHOD_TABLE_SLOTS.get(cls)?.includes(name)
    ? wrapperDescriptorClass
    : methodDescriptorClass;
}

const PRIMITIVE_CLASSES = new Set([intClass, boolClass, floatClass, strClass]);
const RENDERING_METHODS = new Set(['__mod__', '__rmod__', 'format', 'format_map']);

/** The builtin value an instance of a subclass of int, float, or str (including IntEnum and StrEnum) stands for. */
export function unbox(value: PyValue): PyValue {
  if (!(value instanceof PyInstance)) return value;
  if (value.primitive !== undefined) return value.primitive;
  const { enumValue, cls } = value;
  if (enumValue !== undefined) {
    if (typeof enumValue === 'bigint' && cls.isSubclassOf(intClass)) return enumValue;
    if (typeof enumValue === 'number' && cls.isSubclassOf(floatClass)) return enumValue;
    if (typeof enumValue === 'string' && cls.isSubclassOf(strClass)) return enumValue;
  }
  return value;
}

function receiverCheck(
  cls: PyClass,
  name: string,
  receiver: ReceiverCheck,
  ownerName = cls.typeName ?? cls.name
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
/** A class's name as CPython's `%T` and `%N` formats show it: qualified by its module unless builtin or `__main__`. */
export function fullyQualifiedName(cls: PyClass): string {
  return cls.module === '__main__' || cls.module === 'builtins'
    ? cls.qualifiedName
    : `${cls.module}.${cls.qualifiedName}`;
}

export function typeName(value: PyValue): string {
  const cls = classOf(value);
  return cls.typeName ?? cls.name;
}

/** The type an Argument Clinic error names for an argument, which spells None as `None` rather than its type. */
export function argumentTypeName(value: PyValue): string {
  return value === None ? 'None' : typeName(value);
}

export type { Kwargs };

/**
 * Whether a value is a generator object that is an iterator: a generator or an awaitable helper, but not a coroutine or
 * an async generator, which share the machinery of generators without being iterators.
 */
export function isIteratorGenerator(value: PyValue): value is PyGenerator {
  return value instanceof PyGenerator && value.cls !== coroutineClass && value.cls !== asyncGeneratorClass;
}
