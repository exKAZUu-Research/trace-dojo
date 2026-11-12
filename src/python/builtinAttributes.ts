// code-gauge-allow-file fileNcss 471 -- The methods and attributes of the builtin types it defines belong together.
import type { BinaryOperator } from './ast';
import { BUILTIN_DOC } from './attributes';
import { enumerateClass, isSubclassOfClass } from './builtins';
import './builtinComparisons';
import { pyRepr } from './conversions';
import { method, redeclareMethods } from './define';
import { defineGetSet, defineUnsupportedAttributes } from './descriptors';
import { deleteItem, setItem, sliceIndices } from './items';
import { mappingProxyClass, newMappingProxy } from './mappingProxy';
import { exactBinary, scaleToFloat, toIndex } from './numbers';
import { bindValue, callValue, getAttribute, isCallable, toArray } from './objects';
import { binaryOp, inplaceOp, nativeBinaryOperation, unaryOp } from './operators';
import { currentRuntime } from './runtimeContext';
import { newGenericAlias } from './typeHints';
import {
  baseExceptionClass,
  boolClass,
  builtinFunctionClass,
  cellClass,
  classmethodClass,
  classOf,
  complexClass,
  dictClass,
  dictItemsClass,
  dictKeysClass,
  dictValuesClass,
  exceptionClassNamed,
  floatClass,
  frozensetClass,
  functionClass,
  generatorClass,
  intClass,
  listClass,
  methodClass,
  methodDescriptorClass,
  namespaceDict,
  newDict,
  newTuple,
  None,
  NotImplemented,
  notImplementedClass,
  objectClass,
  propertyClass,
  pyError,
  rangeClass,
  setClass,
  sliceClass,
  staticmethodClass,
  strClass,
  superClass,
  tupleClass,
  typeClass,
  typeError,
  typeName,
  valueError,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import {
  type ExceptionState,
  type PyBoundMethod,
  PyBuiltinFunction,
  type PyCell,
  PyClass,
  PyComplex,
  type PyDescriptor,
  PyDict,
  type PyDictView,
  PyFunction,
  type PyGenerator,
  PyInstance,
  PyList,
  PyOpaque,
  type PyRange,
  PySet,
  type PySlice,
  type PySuper,
  PyTuple,
  type PyValue,
} from './values';

/**
 * The methods and data descriptors of builtin types that the interpreter's operators and attribute reads implement
 * natively, so that the types' dictionaries, and `dir()` of their objects, list what CPython's list.
 */

/** Calls a builtin function by name, as the dunders that defer to builtins such as pow() and divmod() do. */
function callBuiltin(name: string, args: PyValue[]): PyValue {
  return callValue(currentRuntime().builtins.get(name) as PyValue, args);
}

// Numbers -----------------------------------------------------------------------------------------------------------

const BINARY_DUNDERS: [string, string, BinaryOperator][] = [
  ['__add__', '__radd__', '+'],
  ['__sub__', '__rsub__', '-'],
  ['__mul__', '__rmul__', '*'],
  ['__truediv__', '__rtruediv__', '/'],
  ['__floordiv__', '__rfloordiv__', '//'],
  ['__mod__', '__rmod__', '%'],
  ['__lshift__', '__rlshift__', '<<'],
  ['__rshift__', '__rrshift__', '>>'],
  ['__and__', '__rand__', '&'],
  ['__or__', '__ror__', '|'],
  ['__xor__', '__rxor__', '^'],
];

const isInt = (value: PyValue): boolean => typeof value === 'bigint' || typeof value === 'boolean';
const isReal = (value: PyValue): boolean => isInt(value) || typeof value === 'number';
const isComplexOperand = (value: PyValue): boolean => isReal(value) || value instanceof PyComplex;

/** Defines a numeric type's binary dunders, which give NotImplemented for operands the type does not handle. */
// code-gauge-allow functionCognitiveComplexity 22 -- Defines each dunder of a numeric type, which differ only in their operator.
function defineNumberDunders(
  cls: PyClass,
  accepts: (value: PyValue) => boolean,
  operators: readonly BinaryOperator[]
): void {
  for (const [name, reflected, operator] of BINARY_DUNDERS) {
    if (!operators.includes(operator)) continue;
    method(cls, name, 'one', 1, 1, (self, [other]) =>
      accepts(other) ? binaryOp(operator, self, other) : NotImplemented
    );
    method(cls, reflected, 'one', 1, 1, (self, [other]) =>
      accepts(other) ? binaryOp(operator, other, self) : NotImplemented
    );
  }
  method(cls, '__pow__', 'expected', 1, 2, (self, [other, mod]) =>
    accepts(other)
      ? callBuiltin('pow', [self, other, ...(mod === undefined || mod === None ? [] : [mod])])
      : NotImplemented
  );
  method(cls, '__rpow__', 'expected', 1, 2, (self, [other, mod]) =>
    accepts(other)
      ? callBuiltin('pow', [other, self, ...(mod === undefined || mod === None ? [] : [mod])])
      : NotImplemented
  );
  for (const [name, operator] of [
    ['__neg__', '-'],
    ['__pos__', '+'],
  ] as const) {
    method(cls, name, 'none', 0, 0, (self) => unaryOp(operator, self));
  }
}

const INT_OPERATORS: BinaryOperator[] = ['+', '-', '*', '/', '//', '%', '<<', '>>', '&', '|', '^'];
defineNumberDunders(intClass, isInt, INT_OPERATORS);
method(intClass, '__invert__', 'none', 0, 0, (self) => unaryOp('~', self));
redeclareMethods(boolClass, intClass, [
  '__and__',
  '__rand__',
  '__or__',
  '__ror__',
  '__xor__',
  '__rxor__',
  '__invert__',
]);
for (const name of ['__divmod__', '__rdivmod__']) {
  for (const [cls, accepts] of [
    [intClass, isInt],
    [floatClass, isReal],
  ] as const) {
    method(cls, name, 'one', 1, 1, (self, [other]) => {
      if (!accepts(other)) return NotImplemented;
      return callBuiltin('divmod', name === '__divmod__' ? [self, other] : [other, self]);
    });
  }
}
for (const name of ['__ceil__', '__floor__', '__trunc__']) {
  method(intClass, name, 'none', 0, 0, (self) => BigInt(self as bigint | boolean));
  method(floatClass, name, 'none', 0, 0, (self) => callMath(name.slice(2, -2), self));
}
method(intClass, '__getnewargs__', 'none', 0, 0, (self) => newTuple([BigInt(self as bigint | boolean)]));
for (const name of ['real', 'numerator']) defineGetSet(intClass, name, (self) => BigInt(self as bigint | boolean));
defineGetSet(intClass, 'imag', () => 0n);
defineGetSet(intClass, 'denominator', () => 1n);
method(intClass, 'from_bytes', 'takes', 1, 2, (cls, args, kwargs) => intFromBytes(cls, args, kwargs), {
  binding: 'class',
  keywords: ['bytes', 'byteorder', 'signed'],
  named: 2,
});

function intFromBytes(cls: PyValue, args: PyValue[], kwargs: Map<string, PyValue> | undefined): PyValue {
  const source = args[0] ?? kwargs?.get('bytes');
  const order = args[1] ?? kwargs?.get('byteorder') ?? 'big';
  const signed = kwargs?.get('signed') ?? false;
  if (typeof source === 'string') throw typeError("cannot convert 'str' object to bytes");
  if (order !== 'big' && order !== 'little') throw valueError("byteorder must be either 'little' or 'big'");
  const bytes = toArray(source as PyValue).map((item) => {
    const value = toIndex(item);
    if (value < 0n || value > 255n) throw valueError('bytes must be in range(0, 256)');
    return value;
  });
  if (order === 'little') bytes.reverse();
  currentRuntime().chargeBits(BigInt(bytes.length * 8));
  // One hex literal builds the integer in linear time, where shifting a growing integer per byte is quadratic.
  let result =
    bytes.length === 0 ? 0n : BigInt(`0x${bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}`);
  if (signed === true && bytes.length > 0 && (bytes[0] & 0x80n) !== 0n) result -= 1n << BigInt(bytes.length * 8);
  return cls === intClass || cls === boolClass
    ? cls === boolClass
      ? result !== 0n
      : result
    : callValue(cls, [result]);
}

const FLOAT_OPERATORS: BinaryOperator[] = ['+', '-', '*', '/', '//', '%'];
defineNumberDunders(floatClass, isReal, FLOAT_OPERATORS);
defineGetSet(floatClass, 'real', (self) => self);
defineGetSet(floatClass, 'imag', () => 0);
method(floatClass, '__getnewargs__', 'none', 0, 0, (self) => newTuple([self]));
method(
  floatClass,
  '__getformat__',
  'one',
  1,
  1,
  (_cls, [kind]) => {
    if (typeof kind !== 'string') throw typeError(`__getformat__() argument must be str, not ${typeName(kind)}`);
    if (kind !== 'double' && kind !== 'float')
      throw valueError("__getformat__() argument 1 must be 'double' or 'float'");
    return 'IEEE, little-endian';
  },
  { binding: 'class' }
);
method(
  floatClass,
  'from_number',
  'one',
  1,
  1,
  (cls, [number]) => {
    if (typeof number === 'string' || !isNumberLike(number)) {
      throw typeError(`must be real number, not ${typeName(number)}`);
    }
    const value = callValue(floatClass, [number]);
    return cls === floatClass ? value : callValue(cls, [value]);
  },
  { binding: 'class' }
);

function isNumberLike(value: PyValue): boolean {
  if (isReal(value)) return true;
  return (
    typeof value === 'object' &&
    (classOf(value).lookup('__float__') !== undefined || classOf(value).lookup('__index__') !== undefined)
  );
}

defineNumberDunders(complexClass, isComplexOperand, ['+', '-', '*', '/']);
defineGetSet(complexClass, 'real', (self) => (self as PyComplex).real, { member: true });
defineGetSet(complexClass, 'imag', (self) => (self as PyComplex).imag, { member: true });
method(complexClass, '__abs__', 'none', 0, 0, (self) => callBuiltin('abs', [self]));
method(complexClass, '__complex__', 'none', 0, 0, (self) => self);
method(complexClass, '__getnewargs__', 'none', 0, 0, (self) =>
  newTuple([(self as PyComplex).real, (self as PyComplex).imag])
);
method(
  complexClass,
  'from_number',
  'one',
  1,
  1,
  (cls, [number]) => {
    if (typeof number === 'string') throw typeError(`complex() argument 'number' must be a number, not str`);
    const value = callValue(complexClass, [number]);
    return cls === complexClass ? value : callValue(cls, [value]);
  },
  { binding: 'class' }
);

function callMath(name: string, value: PyValue): PyValue {
  const math = currentRuntime().importModule('math');
  return callValue(math.dict.get(name) as PyValue, [value]);
}

// Sequences, mappings, and sets -------------------------------------------------------------------------------------

method(strClass, '__add__', 'one', 1, 1, (self, [other]) => {
  if (typeof other !== 'string') throw typeError(`can only concatenate str (not "${typeName(other)}") to str`);
  return binaryOp('+', self, other);
});
for (const name of ['__mul__', '__rmul__']) {
  method(strClass, name, 'one', 1, 1, (self, [count]) => repeat(self, count));
}
method(strClass, '__rmod__', 'one', 1, 1, (self, [other]) =>
  typeof other === 'string' ? binaryOp('%', other, self) : NotImplemented
);
method(strClass, '__getnewargs__', 'none', 0, 0, (self) => newTuple([self]));

function repeat(sequence: PyValue, count: PyValue): PyValue {
  return binaryOp(
    '*',
    sequence,
    toIndex(count, (value) => `'${typeName(value)}' object cannot be interpreted as an integer`)
  );
}

for (const cls of [listClass, tupleClass]) {
  method(cls, '__add__', 'one', 1, 1, (self, [other]) => {
    if (!(other instanceof (cls === listClass ? PyList : PyTuple)) || other instanceof PyClass) {
      throw typeError(`can only concatenate ${cls.name} (not "${typeName(other)}") to ${cls.name}`);
    }
    return binaryOp('+', self, other);
  });
  for (const name of ['__mul__', '__rmul__']) method(cls, name, 'one', 1, 1, (self, [count]) => repeat(self, count));
  method(cls, '__class_getitem__', 'one', 1, 1, (owner, [key]) => newGenericAlias(owner, key), { binding: 'class' });
}
method(tupleClass, '__getnewargs__', 'none', 0, 0, (self) => newTuple([...(self as PyTuple).items]));
method(listClass, '__iadd__', 'one', 1, 1, (self, [other]) => inplaceOp('+', self, other));
method(listClass, '__imul__', 'one', 1, 1, (self, [count]) =>
  inplaceOp(
    '*',
    self,
    toIndex(count, (value) => `'${typeName(value)}' object cannot be interpreted as an integer`)
  )
);
method(listClass, '__setitem__', 'expected', 2, 2, (self, [key, value]) => {
  setItem(self, key, value);
  return None;
});
method(listClass, '__delitem__', 'one', 1, 1, (self, [key]) => {
  deleteItem(self, key);
  return None;
});

method(dictClass, '__class_getitem__', 'one', 1, 1, (owner, [key]) => newGenericAlias(owner, key), {
  binding: 'class',
});
method(dictClass, '__or__', 'one', 1, 1, (self, [other]) =>
  other instanceof PyDict ? nativeBinaryOperation('|', self, other) : NotImplemented
);
method(dictClass, '__ror__', 'one', 1, 1, (self, [other]) =>
  other instanceof PyDict ? nativeBinaryOperation('|', other, self) : NotImplemented
);
method(dictClass, '__ior__', 'one', 1, 1, (self, [other]) => {
  callValue(getAttribute(self, 'update'), [other]);
  return self;
});

const SET_OPERATORS = new Set<BinaryOperator>(['&', '|', '-', '^']);
for (const cls of [setClass, frozensetClass]) {
  for (const [name, reflected, operator] of BINARY_DUNDERS) {
    if (!SET_OPERATORS.has(operator)) continue;
    method(cls, name, 'one', 1, 1, (self, [other]) =>
      other instanceof PySet ? binaryOp(operator, self, other) : NotImplemented
    );
    method(cls, reflected, 'one', 1, 1, (self, [other]) =>
      other instanceof PySet ? binaryOp(operator, other, self) : NotImplemented
    );
  }
  method(cls, '__class_getitem__', 'one', 1, 1, (owner, [key]) => newGenericAlias(owner, key), { binding: 'class' });
}
for (const [name, operator] of [
  ['__iand__', '&'],
  ['__ior__', '|'],
  ['__isub__', '-'],
  ['__ixor__', '^'],
] as const) {
  method(setClass, name, 'one', 1, 1, (self, [other]) =>
    other instanceof PySet ? inplaceOp(operator, self, other) : NotImplemented
  );
}

for (const cls of [dictKeysClass, dictItemsClass]) {
  for (const [name, reflected, operator] of BINARY_DUNDERS) {
    if (!SET_OPERATORS.has(operator)) continue;
    method(cls, name, 'one', 1, 1, (self, [other]) => binaryOp(operator, self, other));
    method(cls, reflected, 'one', 1, 1, (self, [other]) => binaryOp(operator, other, self));
  }
}
dictValuesClass.dict.delete('__contains__');
for (const cls of [dictKeysClass, dictValuesClass, dictItemsClass]) {
  defineGetSet(cls, 'mapping', (self) => newMappingProxy((self as PyDictView).dict));
}
method(mappingProxyClass, '__class_getitem__', 'one', 1, 1, (owner, [key]) => newGenericAlias(owner, key), {
  binding: 'class',
});

defineGetSet(rangeClass, 'start', (self) => (self as PyRange).start, { member: true });
defineGetSet(rangeClass, 'stop', (self) => (self as PyRange).stop, { member: true });
defineGetSet(rangeClass, 'step', (self) => (self as PyRange).step, { member: true });
method(rangeClass, '__bool__', 'none', 0, 0, (self) => (self as PyRange).length > 0n);
for (const name of ['start', 'stop', 'step'] as const) {
  defineGetSet(sliceClass, name, (self) => (self as PySlice)[name], { member: true });
}
method(sliceClass, 'indices', 'one', 1, 1, (self, [length]) => sliceIndicesOf(self as PySlice, length));

/** `slice.indices(length)`, which clamps the slice to a sequence of that length as slicing does. */
function sliceIndicesOf(slice: PySlice, lengthValue: PyValue): PyValue {
  const length = toIndex(lengthValue);
  if (length < 0n) throw valueError('length should not be negative');
  const { start, stop, step } = sliceIndices(slice, Number(length));
  return newTuple([BigInt(start), BigInt(stop), BigInt(step)]);
}

method(notImplementedClass, '__bool__', 'none', 0, 0, () => {
  throw typeError('NotImplemented should not be used in a boolean context');
});

// Functions and methods ---------------------------------------------------------------------------------------------

const asFunction = (self: PyValue): PyFunction => self as PyFunction;

defineGetSet(functionClass, '__name__', (self) => asFunction(self).name, {
  set: (self, value) => {
    if (typeof value !== 'string') throw typeError('__name__ must be set to a string object');
    asFunction(self).name = value;
  },
});
defineGetSet(functionClass, '__qualname__', (self) => asFunction(self).qualifiedName, {
  set: (self, value) => {
    if (typeof value !== 'string') throw typeError('__qualname__ must be set to a string object');
    asFunction(self).qualifiedName = value;
  },
});
defineGetSet(functionClass, '__module__', (self) => asFunction(self).module, {
  set: (self, value) => {
    asFunction(self).module = value as string;
  },
});
defineGetSet(
  functionClass,
  '__defaults__',
  (self) => (asFunction(self).defaults.length > 0 ? newTuple(asFunction(self).defaults) : None),
  {
    set: (self, value) => {
      if (value !== None && !(value instanceof PyTuple)) throw typeError('__defaults__ must be set to a tuple object');
      asFunction(self).defaults = value === None ? [] : [...(value as PyTuple).items];
    },
  }
);
defineGetSet(
  functionClass,
  '__kwdefaults__',
  (self) => (asFunction(self).keywordDefaults.size > 0 ? newDict(asFunction(self).keywordDefaults.entries()) : None),
  {
    set: (self, value) => {
      if (value !== None && !(value instanceof PyDict)) throw typeError('__kwdefaults__ must be set to a dict object');
      asFunction(self).keywordDefaults = new Map(
        value === None ? [] : (value as PyDict).store.ordered().map((entry) => [entry.key as string, entry.value])
      );
    },
  }
);
defineGetSet(functionClass, '__closure__', (self) => closureOf(asFunction(self)));
defineGetSet(
  functionClass,
  '__annotations__',
  (self) => {
    const fn = asFunction(self);
    fn.annotations ??= evaluateAnnotations(fn);
    return fn.annotations;
  },
  {
    set: (self, value) => {
      if (value !== None && !(value instanceof PyDict)) throw typeError('__annotations__ must be set to a dict object');
      const fn = asFunction(self);
      fn.annotations = value instanceof PyDict ? value : undefined;
      fn.annotate = None;
    },
  }
);
defineGetSet(
  functionClass,
  '__annotate__',
  (self) => asFunction(self).annotate ?? annotateFunctionOf(asFunction(self)),
  {
    set: (self, value) => {
      if (value !== None && !isCallable(value)) throw typeError('__annotate__ must be callable or None');
      const fn = asFunction(self);
      fn.annotate = value;
      if (value !== None) fn.annotations = undefined;
    },
  }
);
defineGetSet(functionClass, '__type_params__', (self) => asFunction(self).typeParams ?? newTuple([]), {
  set: (self, value) => {
    if (!(value instanceof PyTuple)) throw typeError('__type_params__ must be set to a tuple');
    asFunction(self).typeParams = value;
  },
});
defineGetSet(functionClass, '__dict__', (self) => namespaceDict(asFunction(self).dict));
defineGetSet(functionClass, '__doc__', (self) => asFunction(self).doc ?? None, {
  set: (self, value) => {
    asFunction(self).doc = value;
  },
});
defineUnsupportedAttributes(functionClass, {
  __code__: '関数のコードオブジェクト（__code__）',
  __globals__: '関数の __globals__（モジュールの名前空間そのもの）',
  __builtins__: '関数の __builtins__（組み込みの名前空間そのもの）',
});
method(
  functionClass,
  '__call__',
  'expected',
  0,
  Number.POSITIVE_INFINITY,
  (self, args, kwargs) => callValue(self, args, kwargs),
  {
    keywords: [],
  }
);

/** A function's `__closure__`: the cells of its free variables in name order, as CPython orders `co_freevars`. */
function closureOf(fn: PyFunction): PyValue {
  const names = [...fn.closure.keys()].toSorted();
  if (fn.classCell && fn.def.usesClassCell) names.push('__class__');
  if (names.length === 0) return None;
  return newTuple(
    names.map((name) =>
      newCell(
        name === '__class__' && !fn.closure.has(name) ? (fn.classCell as PyCell) : (fn.closure.get(name) as PyCell)
      )
    )
  );
}

function newCell(cell: PyCell): PyOpaque {
  return new PyOpaque(cellClass, 'cell', cell);
}

defineGetSet(
  cellClass,
  'cell_contents',
  (self) => {
    const { value } = (self as PyOpaque).data as PyCell;
    if (value === undefined) throw valueError('Cell is empty');
    return value;
  },
  {
    set: (self, value) => {
      ((self as PyOpaque).data as PyCell).value = value;
    },
  }
);

/** What the first read of a function's `__annotations__` gives: the result of its `__annotate__`. */
function evaluateAnnotations(fn: PyFunction): PyDict {
  const { annotate } = fn;
  if (annotate === undefined) return currentRuntime().evaluator.annotationsOf(fn);
  if (annotate === None) return newDict();
  const annotations = callValue(annotate, [1n]);
  if (!(annotations instanceof PyDict)) {
    throw typeError(`__annotate__ returned non-dict of type '${typeName(annotations)}'`);
  }
  return annotations;
}

/** A function's `__annotate__`: None without annotations, else a function giving them for the VALUE format. */
function annotateFunctionOf(fn: PyFunction): PyValue {
  const hasAnnotations = fn.def.returns !== undefined || fn.def.params.some((param) => param.annotation !== undefined);
  if (!hasAnnotations) return None;
  return new PyBuiltinFunction(builtinFunctionClass, '__annotate__', ([format]) => {
    if (format !== 1n && format !== 2n) throw pyError('NotImplementedError', pyRepr(format));
    return currentRuntime().evaluator.annotationsOf(fn);
  });
}

defineGetSet(methodClass, '__func__', (self) => (self as PyBoundMethod).fn);
defineGetSet(methodClass, '__self__', (self) => (self as PyBoundMethod).self);
method(
  methodClass,
  '__call__',
  'expected',
  0,
  Number.POSITIVE_INFINITY,
  (self, args, kwargs) => callValue(self, args, kwargs),
  {
    keywords: [],
  }
);
method(methodClass, '__get__', 'expected', 1, 2, (self) => self);

for (const cls of [builtinFunctionClass, methodDescriptorClass]) {
  defineGetSet(cls, '__name__', (self) => (self as PyBuiltinFunction).name);
  defineGetSet(cls, '__qualname__', (self) => (self as PyBuiltinFunction).qualifiedName);
  defineUnsupportedAttributes(cls, { __text_signature__: '組み込み関数の __text_signature__（シグネチャのデータ）' });
  method(
    cls,
    '__call__',
    'expected',
    0,
    Number.POSITIVE_INFINITY,
    (self, args, kwargs) => callValue(self, args, kwargs),
    {
      keywords: [],
    }
  );
}
defineGetSet(
  builtinFunctionClass,
  '__self__',
  (self) => (self as PyBuiltinFunction).self ?? currentRuntime().builtinsModule()
);
defineGetSet(builtinFunctionClass, '__module__', (self) =>
  (self as PyBuiltinFunction).self === undefined ? ((self as PyBuiltinFunction).module ?? 'builtins') : None
);
defineGetSet(methodDescriptorClass, '__objclass__', (self) => objclassOf(self as PyBuiltinFunction));
method(methodDescriptorClass, '__get__', 'expected', 1, 2, (self, [instance]) =>
  instance === None ? self : bindValue(self, instance)
);

function objclassOf(fn: PyBuiltinFunction): PyValue {
  const name = fn.ownerName;
  const owner = [intClass, floatClass, strClass, listClass, tupleClass, dictClass, setClass, frozensetClass].find(
    (cls) => cls.name === name
  );
  return owner ?? None;
}

// Generators --------------------------------------------------------------------------------------------------------

const asGenerator = (self: PyValue): PyGenerator => self as PyGenerator;
defineGetSet(generatorClass, '__name__', (self) => asGenerator(self).name);
defineGetSet(generatorClass, '__qualname__', (self) => asGenerator(self).qualifiedName);
defineGetSet(generatorClass, 'gi_running', (self) => asGenerator(self).running);
defineGetSet(
  generatorClass,
  'gi_suspended',
  (self) => asGenerator(self).started && !asGenerator(self).running && !asGenerator(self).finished
);
defineGetSet(generatorClass, 'gi_yieldfrom', () => None);
defineUnsupportedAttributes(generatorClass, {
  gi_code: 'ジェネレータのコードオブジェクト（gi_code）',
  gi_frame: 'ジェネレータのフレームオブジェクト（gi_frame）',
  __del__: 'ジェネレータの __del__()',
});
method(generatorClass, '__class_getitem__', 'one', 1, 1, (owner, [key]) => newGenericAlias(owner, key), {
  binding: 'class',
});

// Descriptors and super ---------------------------------------------------------------------------------------------

const asDescriptor = (self: PyValue): PyDescriptor => self as PyDescriptor;
defineGetSet(propertyClass, 'fget', (self) => asDescriptor(self).fn);
defineGetSet(propertyClass, 'fset', (self) => asDescriptor(self).setter ?? None);
defineGetSet(propertyClass, 'fdel', (self) => asDescriptor(self).deleter ?? None);
defineGetSet(propertyClass, '__name__', (self) => {
  const getter = asDescriptor(self).fn;
  if (getter === None) throw pyError('AttributeError', `'property' object has no attribute '__name__'`);
  return getAttribute(getter, '__name__');
});
defineGetSet(
  propertyClass,
  '__isabstractmethod__',
  (self) =>
    isAbstract(asDescriptor(self).fn) || isAbstract(asDescriptor(self).setter) || isAbstract(asDescriptor(self).deleter)
);
method(propertyClass, '__set__', 'expected', 2, 2, (self, [instance, value]) => {
  const { setter } = asDescriptor(self);
  if (setter === undefined || setter === None) {
    throw pyError('AttributeError', `property of '${typeName(instance)}' object has no setter`);
  }
  callValue(setter, [instance, value]);
  return None;
});
method(propertyClass, '__delete__', 'one', 1, 1, (self, [instance]) => {
  const { deleter } = asDescriptor(self);
  if (deleter === undefined || deleter === None)
    throw pyError('AttributeError', `property of '${typeName(instance)}' object has no deleter`);
  callValue(deleter, [instance]);
  return None;
});
method(propertyClass, '__set_name__', 'expected', 2, 2, () => None);

function isAbstract(value: PyValue | undefined): boolean {
  return value instanceof PyFunction && value.dict.get('__isabstractmethod__') === true;
}

for (const cls of [staticmethodClass, classmethodClass]) {
  defineGetSet(cls, '__func__', (self) => asDescriptor(self).fn);
  defineGetSet(cls, '__wrapped__', (self) => asDescriptor(self).fn);
  for (const name of ['__name__', '__qualname__', '__module__', '__doc__', '__annotations__', '__annotate__']) {
    defineGetSet(cls, name, (self) => getAttribute(asDescriptor(self).fn, name));
  }
  defineGetSet(cls, '__isabstractmethod__', (self) => isAbstract(asDescriptor(self).fn));
  defineGetSet(cls, '__dict__', () => newDict());
  method(cls, '__class_getitem__', 'one', 1, 1, (owner, [key]) => newGenericAlias(owner, key), { binding: 'class' });
}
method(
  staticmethodClass,
  '__call__',
  'expected',
  0,
  Number.POSITIVE_INFINITY,
  (self, args, kwargs) => callValue(asDescriptor(self).fn, args, kwargs),
  { keywords: [] }
);

const asSuper = (self: PyValue): PySuper => self as PySuper;
defineGetSet(superClass, '__self__', (self) => asSuper(self).self);
defineGetSet(superClass, '__self_class__', (self) => asSuper(self).selfClass);
defineGetSet(superClass, '__thisclass__', (self) => asSuper(self).thisClass);
method(superClass, '__get__', 'expected', 1, 2, (self) => self);

// Exceptions --------------------------------------------------------------------------------------------------------

const stateOf = (self: PyValue): ExceptionState => (self as PyInstance).exception as ExceptionState;

defineGetSet(baseExceptionClass, 'args', (self) => stateOf(self).args, {
  set: (self, value) => {
    stateOf(self).args = newTuple(toArray(value));
  },
});
defineGetSet(baseExceptionClass, '__cause__', (self) => stateOf(self).cause ?? None, {
  set: (self, value) => {
    if (value !== None && !isException(value))
      throw typeError('exception cause must be None or derive from BaseException');
    stateOf(self).cause = value;
    stateOf(self).suppressContext = true;
  },
});
defineGetSet(baseExceptionClass, '__context__', (self) => stateOf(self).context ?? None, {
  set: (self, value) => {
    if (value !== None && !isException(value))
      throw typeError('exception context must be None or derive from BaseException');
    stateOf(self).context = value;
  },
});
defineGetSet(baseExceptionClass, '__suppress_context__', (self) => stateOf(self).suppressContext, {
  member: true,
  set: (self, value) => {
    stateOf(self).suppressContext = currentRuntime().truthy(value);
  },
});
// A raised exception's traceback holds frame objects with the script's path, which this grader does not make.
defineGetSet(
  baseExceptionClass,
  '__traceback__',
  (self) => {
    if (stateOf(self).raised) throw new UnsupportedFeatureError('例外のトレースバック（__traceback__）');
    return None;
  },
  {
    set: (self, value) => {
      if (value !== None) throw new UnsupportedFeatureError('例外のトレースバック（__traceback__）');
      stateOf(self).raised = false;
    },
  }
);
defineGetSet(baseExceptionClass, '__dict__', (self) => namespaceDict((self as PyInstance).dict));
method(baseExceptionClass, '__setstate__', 'one', 1, 1, (self, [state]) => {
  if (state !== None) {
    if (!(state instanceof PyDict)) throw typeError('state is not a dictionary');
    for (const entry of state.store.ordered()) currentRuntime().setAttributeOf(self, entry.key as string, entry.value);
  }
  return None;
});

function isException(value: PyValue): boolean {
  return value instanceof PyInstance && value.exception !== undefined;
}

/** Adds a field an exception type keeps, read from its arguments until assigned. */
function defineExceptionField(className: string, name: string, initial: (state: ExceptionState) => PyValue): void {
  defineGetSet(
    exceptionClassNamed(className),
    name,
    (self) => {
      const state = stateOf(self);
      return state.fields?.get(name) ?? initial(state);
    },
    {
      member: true,
      set: (self, value) => {
        const state = stateOf(self);
        state.fields ??= new Map();
        state.fields.set(name, value);
      },
    }
  );
}

const argument = (index: number) => (state: ExceptionState) => state.args.items[index] ?? None;
defineExceptionField('StopIteration', 'value', argument(0));
defineExceptionField('SystemExit', 'code', (state) => {
  const { items } = state.args;
  if (items.length === 0) return None;
  return items.length === 1 ? items[0] : state.args;
});
defineExceptionField('AttributeError', 'name', (state) => state.name ?? None);
defineExceptionField('AttributeError', 'obj', (state) => state.object ?? None);
defineExceptionField('NameError', 'name', (state) => state.name ?? None);
defineExceptionField('ImportError', 'name', (state) => state.name ?? None);
defineExceptionField('ImportError', 'msg', (state) => (state.args.items.length === 1 ? state.args.items[0] : None));
for (const name of ['path', 'name_from']) defineExceptionField('ImportError', name, () => None);
const osErrorArgument = (index: number) => (state: ExceptionState) =>
  state.args.items.length >= 2 ? (state.args.items[index] ?? None) : None;
defineExceptionField('OSError', 'errno', osErrorArgument(0));
defineExceptionField('OSError', 'strerror', osErrorArgument(1));
defineExceptionField('OSError', 'filename', osErrorArgument(2));
defineExceptionField('OSError', 'filename2', osErrorArgument(4));
defineUnsupportedAttributes(exceptionClassNamed('OSError'), {
  characters_written: 'OSError.characters_written（ファイルへの書き込み）',
});
const syntaxDetail = (index: number) => (state: ExceptionState) => {
  const detail = state.args.items[1];
  return detail instanceof PyTuple ? (detail.items[index] ?? None) : None;
};
defineExceptionField('SyntaxError', 'msg', argument(0));
defineExceptionField('SyntaxError', 'filename', syntaxDetail(0));
defineExceptionField('SyntaxError', 'lineno', syntaxDetail(1));
defineExceptionField('SyntaxError', 'offset', syntaxDetail(2));
defineExceptionField('SyntaxError', 'text', syntaxDetail(3));
defineExceptionField('SyntaxError', 'end_lineno', syntaxDetail(4));
defineExceptionField('SyntaxError', 'end_offset', syntaxDetail(5));
defineExceptionField('SyntaxError', 'print_file_and_line', () => None);
defineExceptionField('SyntaxError', '_metadata', () => None);

// object ------------------------------------------------------------------------------------------------------------

defineGetSet(objectClass, '__class__', (self) => classOf(self), {
  set: () => {
    throw new UnsupportedFeatureError('__class__ への代入');
  },
});
defineGetSet(
  objectClass,
  '__doc__',
  (self) => {
    const { doc } = classOf(self);
    if (doc === undefined) throw new UnsupportedFeatureError(BUILTIN_DOC);
    return doc;
  },
  { nonData: true }
);

// type --------------------------------------------------------------------------------------------------------------

const asClass = (self: PyValue): PyClass => self as PyClass;
for (const name of [
  '__name__',
  '__qualname__',
  '__module__',
  '__bases__',
  '__base__',
  '__mro__',
  '__dict__',
  '__annotations__',
]) {
  defineGetSet(typeClass, name, (self) => getAttribute(asClass(self), name));
}
defineGetSet(typeClass, '__abstractmethods__', (self) => {
  const value = asClass(self).dict.get('__abstractmethods__');
  if (value === undefined || self === typeClass) {
    throw pyError('AttributeError', `type object '${asClass(self).name}' has no attribute '__abstractmethods__'`);
  }
  return value;
});
defineGetSet(typeClass, '__type_params__', () => newTuple([]));
defineGetSet(typeClass, '__annotate__', (self) => {
  if (asClass(self).isBuiltin)
    throw pyError('AttributeError', `type object '${asClass(self).name}' has no attribute '__annotate__'`);
  if ((currentRuntime().classAnnotationThunks.get(asClass(self)) ?? []).length === 0) return None;
  return new PyBuiltinFunction(builtinFunctionClass, '__annotate__', ([format]) => {
    if (format !== 1n && format !== 2n) throw pyError('NotImplementedError', pyRepr(format));
    return newDict(currentRuntime().evaluateClassAnnotations(asClass(self)));
  });
});
defineUnsupportedAttributes(typeClass, {
  __basicsize__: '型の __basicsize__（CPython のメモリ上の大きさ）',
  __itemsize__: '型の __itemsize__（CPython のメモリ上の大きさ）',
  __dictoffset__: '型の __dictoffset__（CPython のメモリ上の配置）',
  __weakrefoffset__: '型の __weakrefoffset__（CPython のメモリ上の配置）',
  __flags__: '型の __flags__（CPython の内部のフラグ）',
  __text_signature__: '型の __text_signature__（シグネチャのデータ）',
});
method(
  typeClass,
  '__call__',
  'expected',
  0,
  Number.POSITIVE_INFINITY,
  (self, args, kwargs) => callValue(self, args, kwargs),
  {
    keywords: [],
  }
);
method(typeClass, '__prepare__', 'expected', 0, Number.POSITIVE_INFINITY, () => newDict(), {
  binding: 'class',
  keywords: [],
});
method(typeClass, '__instancecheck__', 'one', 1, 1, (self, [instance]) => isInstanceOf(instance, asClass(self)));
method(typeClass, '__subclasscheck__', 'one', 1, 1, (self, [cls]) => {
  if (!(cls instanceof PyClass)) throw typeError('issubclass() arg 1 must be a class');
  return isSubclassOfClass(cls, asClass(self));
});

function isInstanceOf(value: PyValue, cls: PyClass): boolean {
  return isSubclassOfClass(classOf(value), cls);
}

// float.hex and float.fromhex -----------------------------------------------------------------------------------------

method(floatClass, 'hex', 'none', 0, 0, (self) => floatHex(self as number));
method(
  floatClass,
  'fromhex',
  'one',
  1,
  1,
  (cls, [text]) => {
    if (typeof text !== 'string') throw typeError(`fromhex() argument must be str, not ${typeName(text)}`);
    const value = floatFromHex(text);
    return cls === floatClass ? value : callValue(cls, [value]);
  },
  { binding: 'class' }
);

/** `float.hex()`: a hexadecimal mantissa of 13 digits after the point and a binary exponent, as float_hex writes. */
function floatHex(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  if (value === 0) return `${sign}0x0.0p+0`;
  const { mantissa, exponent } = exactBinary(Math.abs(value));
  // Normalize to a 53-bit mantissa with its leading bit 1, or the subnormal exponent -1022.
  let bits = mantissa;
  let shift = exponent;
  while (bits < 1n << 52n && shift > -1074) {
    bits <<= 1n;
    shift--;
  }
  while (bits >= 1n << 53n) {
    bits >>= 1n;
    shift++;
  }
  const leading = bits >> 52n;
  const fraction = (bits & ((1n << 52n) - 1n)).toString(16).padStart(13, '0');
  const power = shift + 52;
  return `${sign}0x${leading}.${fraction}p${power < 0 ? '-' : '+'}${Math.abs(power)}`;
}

/** `float.fromhex()`, rounding to nearest with ties to even, as float_fromhex does. */
function floatFromHex(text: string): number {
  const trimmed = text.trim();
  const match = /^([+-]?)(?:(inf|infinity)|(nan)|(?:0x)?([0-9a-f]*)(?:\.([0-9a-f]*))?(?:p([+-]?[0-9]+))?)$/i.exec(
    trimmed
  );
  if (!match) throw valueError('invalid hexadecimal floating-point string');
  const [, sign, infinity, nan, whole = '', fraction = '', power = '0'] = match;
  const negative = sign === '-';
  if (infinity) return negative ? -Infinity : Infinity;
  if (nan) return Number.NaN;
  if (whole === '' && fraction === '') throw valueError('invalid hexadecimal floating-point string');
  const digits = BigInt(`0x${whole}${fraction}` === '0x' ? '0' : `0x${whole}${fraction}`);
  const exponent = Number(power) - 4 * fraction.length;
  if (digits === 0n) return negative ? -0 : 0;
  const result = scaleToFloat(digits, exponent);
  if (!Number.isFinite(result)) throw pyError('OverflowError', 'hexadecimal value too large to represent as a float');
  return negative ? -result : result;
}

method(enumerateClass, '__class_getitem__', 'one', 1, 1, (owner, [key]) => newGenericAlias(owner, key), {
  binding: 'class',
});
