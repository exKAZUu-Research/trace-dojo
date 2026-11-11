import { implicitlyWrapped } from './annotations';
import { builtinTextSignature } from './builtinDocs';
import { enumerateClass } from './builtins';
import { addressOf } from './conversions';
import { method } from './define';
import { sliceIndices } from './items';
import { defineProperty } from './modules/numberSupport';
import { namespaceDict } from './namespaces';
import { exactBinary, scaleToFloat, toIndex } from './numbers';
import { bindValue, callValue, getAttribute, setAttribute } from './objects';
import { binaryOp } from './operators';
import { currentRuntime } from './runtimeContext';
import { sharedNamespaceModules } from './sharedNamespaces';
import { newGenericAlias } from './typeHints';
import {
  asyncGeneratorClass,
  baseExceptionClass,
  boolClass,
  builtinFunctionClass,
  cellClass,
  classmethodClass,
  classmethodDescriptorClass,
  classOf,
  complexClass,
  coroutineClass,
  dictClass,
  dictItemsClass,
  dictKeysClass,
  dictValuesClass,
  floatClass,
  frozensetClass,
  functionClass,
  generatorClass,
  intClass,
  listClass,
  methodClass,
  methodDescriptorClass,
  methodWrapperClass,
  newDict,
  newTuple,
  None,
  notImplementedClass,
  propertyClass,
  pyError,
  rangeClass,
  setClass,
  sliceClass,
  staticmethodClass,
  strClass,
  superClass,
  tupleClass,
  typeError,
  typeName,
  unbox,
  valueError,
  wrapperDescriptorClass,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import {
  type PyBoundMethod,
  type PyBuiltinFunction,
  type PyCell,
  PyClass,
  type PyComplex,
  type PyDescriptor,
  PyDict,
  type PyDictView,
  PyFunction,
  type PyGenerator,
  PyOpaque,
  type PyRange,
  type PySlice,
  type PySuper,
  type PyTuple,
  type PyValue,
} from './values';

/**
 * The methods and data descriptors of builtin types that the interpreter's operators and attribute reads implement
 * natively, so that the types' dictionaries, and `dir()` of their objects, list what CPython's list.
 */

/** Calls a builtin function by name, as the dunders that defer to builtins such as abs() do. */
function callBuiltin(name: string, args: PyValue[]): PyValue {
  return callValue(currentRuntime().builtins.get(name) as PyValue, args);
}

function callMath(name: string, value: PyValue): PyValue {
  const math = currentRuntime().importModule('math');
  return callValue(math.dict.get(name) as PyValue, [value]);
}

/** An attribute that CPython has and this grader does not support, which raises the unsupported error. */
function unsupportedProperty(cls: PyClass, name: string, feature: string): void {
  defineProperty(cls, name, () => {
    throw new UnsupportedFeatureError(feature);
  });
}

function classGetItem(cls: PyClass): void {
  method(cls, '__class_getitem__', 'one', 1, 1, (owner, [key]) => newGenericAlias(owner, key), { binding: 'class' });
}

// Numbers -----------------------------------------------------------------------------------------------------------

const intOf = (self: PyValue): bigint => toIndex(self);
for (const name of ['__ceil__', '__floor__', '__trunc__']) {
  method(intClass, name, 'none', 0, 0, (self) => intOf(self));
}
for (const name of ['__ceil__', '__floor__']) {
  method(floatClass, name, 'none', 0, 0, (self) => callMath(name.slice(2, -2), unbox(self)));
}
method(intClass, '__getnewargs__', 'none', 0, 0, (self) => newTuple([intOf(self)]));
for (const name of ['real', 'numerator']) defineProperty(intClass, name, (self) => intOf(self));
defineProperty(intClass, 'imag', () => 0n);
defineProperty(intClass, 'denominator', () => 1n);

defineProperty(floatClass, 'real', (self) => unbox(self));
defineProperty(floatClass, 'imag', () => 0);
method(floatClass, '__getnewargs__', 'none', 0, 0, (self) => newTuple([unbox(self)]));
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
  if (typeof value === 'bigint' || typeof value === 'boolean' || typeof value === 'number') return true;
  return (
    typeof value === 'object' &&
    (classOf(value).lookup('__float__') !== undefined || classOf(value).lookup('__index__') !== undefined)
  );
}

defineProperty(complexClass, 'real', (self) => (self as PyComplex).real);
defineProperty(complexClass, 'imag', (self) => (self as PyComplex).imag);
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

// float.hex and float.fromhex -----------------------------------------------------------------------------------------

method(floatClass, 'hex', 'none', 0, 0, (self) => floatHex(unbox(self) as number));
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

// Sequences, mappings, and sets -------------------------------------------------------------------------------------

method(strClass, '__getnewargs__', 'none', 0, 0, (self) => newTuple([unbox(self)]));
method(tupleClass, '__getnewargs__', 'none', 0, 0, (self) => newTuple([...(self as PyTuple).items]));
for (const cls of [
  listClass,
  tupleClass,
  dictClass,
  setClass,
  frozensetClass,
  enumerateClass,
  generatorClass,
  coroutineClass,
  asyncGeneratorClass,
]) {
  classGetItem(cls);
}

const SET_DUNDERS = [
  ['__and__', '__rand__', '&'],
  ['__or__', '__ror__', '|'],
  ['__sub__', '__rsub__', '-'],
  ['__xor__', '__rxor__', '^'],
] as const;
for (const cls of [dictKeysClass, dictItemsClass]) {
  for (const [name, reflected, operator] of SET_DUNDERS) {
    method(cls, name, 'one', 1, 1, (self, [other]) => binaryOp(operator, self, other));
    method(cls, reflected, 'one', 1, 1, (self, [other]) => binaryOp(operator, other, self));
  }
}
for (const cls of [dictKeysClass, dictValuesClass, dictItemsClass]) {
  defineProperty(cls, 'mapping', (self) => {
    const types = currentRuntime().importModule('types');
    return callValue(types.dict.get('MappingProxyType') as PyValue, [(self as PyDictView).dict]);
  });
}

defineProperty(rangeClass, 'start', (self) => (self as PyRange).start);
defineProperty(rangeClass, 'stop', (self) => (self as PyRange).stop);
defineProperty(rangeClass, 'step', (self) => (self as PyRange).step);
method(rangeClass, '__bool__', 'none', 0, 0, (self) => (self as PyRange).length > 0n);
for (const name of ['start', 'stop', 'step'] as const) {
  defineProperty(sliceClass, name, (self) => (self as PySlice)[name]);
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

method(methodClass, '__get__', 'expected', 1, 2, (self) => self);
defineProperty(methodClass, '__func__', (self) => (self as PyBoundMethod).fn);
defineProperty(methodClass, '__self__', (self) => (self as PyBoundMethod).self);

for (const cls of [builtinFunctionClass, methodDescriptorClass]) {
  defineProperty(cls, '__text_signature__', (self) => builtinTextSignature(self) ?? None);
  defineProperty(cls, '__name__', (self) => (self as PyBuiltinFunction).name);
  defineProperty(cls, '__qualname__', (self) => (self as PyBuiltinFunction).qualifiedName);
}
defineProperty(
  builtinFunctionClass,
  '__self__',
  (self) => (self as PyBuiltinFunction).self ?? currentRuntime().importModule('builtins')
);
defineProperty(builtinFunctionClass, '__module__', (self) =>
  (self as PyBuiltinFunction).self === undefined ? 'builtins' : None
);
defineProperty(methodDescriptorClass, '__objclass__', (self) => objclassOf(self as PyBuiltinFunction));
method(methodDescriptorClass, '__get__', 'expected', 1, 2, (self, [instance]) =>
  instance === None ? self : bindValue(self, instance)
);

method(wrapperDescriptorClass, '__get__', 'expected', 1, 2, (self, [instance]) =>
  instance === None ? self : bindValue(self, instance)
);
method(classmethodDescriptorClass, '__get__', 'expected', 1, 2, (self, [instance, owner]) => {
  const cls = owner === undefined || owner === None ? classOf(instance as PyValue) : owner;
  if (!(cls instanceof PyClass)) throw typeError(`descriptor '${(self as PyBuiltinFunction).name}' needs a type`);
  return bindValue(self, cls, cls);
});

function objclassOf(fn: PyBuiltinFunction): PyValue {
  const name = fn.ownerName;
  const owner = [intClass, boolClass, floatClass, strClass, listClass, tupleClass, dictClass, setClass].find(
    (cls) => cls.name === name
  );
  return owner ?? None;
}

// Generators --------------------------------------------------------------------------------------------------------

const asGenerator = (self: PyValue): PyGenerator => self as PyGenerator;
for (const cls of [generatorClass, coroutineClass, asyncGeneratorClass]) {
  defineProperty(cls, '__name__', (self) => asGenerator(self).name);
  defineProperty(cls, '__qualname__', (self) => asGenerator(self).qualifiedName);
}
defineProperty(generatorClass, 'gi_running', (self) => asGenerator(self).running);
defineProperty(
  generatorClass,
  'gi_suspended',
  (self) => asGenerator(self).started && !asGenerator(self).running && !asGenerator(self).finished
);

// Descriptors and super ---------------------------------------------------------------------------------------------

const asDescriptor = (self: PyValue): PyDescriptor => self as PyDescriptor;
defineProperty(propertyClass, 'fget', (self) => asDescriptor(self).fn);
defineProperty(propertyClass, 'fset', (self) => asDescriptor(self).setter ?? None);
defineProperty(propertyClass, 'fdel', (self) => asDescriptor(self).deleter ?? None);
defineProperty(propertyClass, '__name__', (self) => {
  const getter = asDescriptor(self).fn;
  if (getter === None) throw pyError('AttributeError', `'property' object has no attribute '__name__'`);
  return getAttribute(getter, '__name__');
});
defineProperty(
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
  defineProperty(cls, '__func__', (self) => asDescriptor(self).fn);
  // CPython copies the function's __name__, __qualname__, and __module__ into the wrapper's own namespace.
  for (const name of ['__wrapped__', '__annotations__', '__annotate__']) {
    defineProperty(cls, name, (self) => {
      if (implicitlyWrapped.has(self as object)) {
        throw pyError('AttributeError', `'${typeName(self)}' object has no attribute '${name}'`);
      }
      const { fn } = asDescriptor(self);
      return name === '__wrapped__' ? fn : getAttribute(fn, name);
    });
  }
  defineProperty(cls, '__isabstractmethod__', (self) => isAbstract(asDescriptor(self).fn));
  defineProperty(cls, '__dict__', () => newDict());
  classGetItem(cls);
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
defineProperty(superClass, '__self__', (self) => asSuper(self).self ?? None);
defineProperty(superClass, '__self_class__', (self) => asSuper(self).selfClass ?? None);
defineProperty(superClass, '__thisclass__', (self) => asSuper(self).thisClass);

// Closures ----------------------------------------------------------------------------------------------------------

defineProperty(functionClass, '__closure__', (self) => closureOf(self as PyFunction));
unsupportedProperty(functionClass, '__code__', '関数のコードオブジェクト（__code__）');
defineProperty(functionClass, '__globals__', (self) => {
  const { globals } = self as PyFunction;
  const module = sharedNamespaceModules.get(globals);
  return namespaceDict(module === undefined ? globals : currentRuntime().importModule(module).dict);
});
unsupportedProperty(functionClass, '__builtins__', '関数の __builtins__（組み込みの名前空間そのもの）');
for (const cls of [
  functionClass,
  methodClass,
  builtinFunctionClass,
  methodDescriptorClass,
  wrapperDescriptorClass,
  classmethodDescriptorClass,
  methodWrapperClass,
]) {
  method(
    cls,
    '__call__',
    'expected',
    0,
    Number.POSITIVE_INFINITY,
    (self, args, kwargs) => callValue(self, args, kwargs),
    { keywords: [] }
  );
}

/** A function's `__closure__`: the cells of its free variables in name order, as CPython orders `co_freevars`. */
function closureOf(fn: PyFunction): PyValue {
  const names = [...fn.closure.keys()].toSorted();
  if (fn.classCell && fn.def.usesClassCell && !fn.closure.has('__class__')) names.push('__class__');
  if (names.length === 0) return None;
  return newTuple(
    names.map((name) => {
      const cell = fn.closure.get(name) ?? (fn.classCell as PyCell);
      return new PyOpaque(cellClass, 'cell', cell);
    })
  );
}

// CPython's cells compare by their contents, which makes them unhashable.
cellClass.dict.set('__hash__', None);
method(cellClass, '__repr__', 'none', 0, 0, (self) => {
  const { value } = (self as PyOpaque).data as PyCell;
  const here = addressOf(self as PyOpaque);
  if (value === undefined) return `<cell at ${here}: empty>`;
  const there = `0x${currentRuntime().idOf(value).toString(16)}`;
  return `<cell at ${here}: ${typeName(value)} object at ${there}>`;
});
defineProperty(cellClass, 'cell_contents', (self) => {
  const { value } = (self as PyOpaque).data as PyCell;
  if (value === undefined) throw valueError('Cell is empty');
  return value;
});

// Exceptions --------------------------------------------------------------------------------------------------------

method(baseExceptionClass, '__setstate__', 'one', 1, 1, (self, [state]) => {
  if (state !== None) {
    if (!(state instanceof PyDict)) throw typeError('state is not a dictionary');
    for (const entry of state.store.ordered()) setAttribute(self, entry.key as string, entry.value);
  }
  return None;
});

// dict_values has no `__contains__`: `in` searches it as an iterable.
dictValuesClass.dict.delete('__contains__');
