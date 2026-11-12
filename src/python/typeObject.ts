import { deleteAttributeDirectly, setAttributeDirectly } from './attributes';
import { addressOf, defaultRepr, pyFormat, pyRepr, pyStr } from './conversions';
import { method } from './define';
import { defineUnsupportedAttributes } from './descriptors';
import { isEnumClass } from './enums';
import { identityHash, NATIVE_HASHES, pyHash } from './hashing';
import { argument, checkArgs } from './nativeArgs';
import { attributeName, bindValue, callValue, getAttribute, isCallable, lookupSpecial, nextOf } from './objects';
import { currentRuntime } from './runtimeContext';
import { typeOr } from './typeHints';
import {
  argumentTypeName,
  builtinFunctionClass,
  classmethodClass,
  classOf,
  defineMethod,
  ellipsisClass,
  exceptionClassNamed,
  functionClass,
  generatorClass,
  iteratorClasses,
  iteratorClassSetup,
  methodClass,
  methodDescriptorClass,
  moduleClass,
  newException,
  newTuple,
  None,
  noneClass,
  NotImplemented,
  notImplementedClass,
  objectClass,
  propertyClass,
  pyError,
  sliceClass,
  staticmethodClass,
  superClass,
  typeClass,
  typeError,
  typeName,
} from './types';
import {
  DONE,
  PyBoundMethod,
  PyBuiltinFunction,
  PyClass,
  PyDescriptor,
  PyError,
  PyFunction,
  PyGenerator,
  PyInstance,
  type PyIterator,
  type PyModule,
  PyObject,
  PySlice,
  PySuper,
  type PyValue,
} from './values';

// object ------------------------------------------------------------------------------------------------------------

objectClass.construct = (cls, args, kwargs) => {
  if (cls === objectClass && (args.length > 0 || (kwargs && kwargs.size > 0)))
    throw typeError('object() takes no arguments');
  return new PyInstance(cls);
};
defineMethod(objectClass, '__init__', () => None, { receiver: 'wrapper' });
method(objectClass, '__repr__', 'none', 0, 0, (self) => defaultRepr(self as PyObject));
// Calls the class's __repr__ without checking its result, which str() then checks as __str__'s, as CPython does.
method(objectClass, '__str__', 'none', 0, 0, (self) => {
  const repr = lookupSpecial(self, '__repr__');
  return repr === undefined ? pyRepr(self) : callValue(bindValue(repr, self), []);
});
method(objectClass, '__eq__', 'one', 1, 1, (self, [other]) => (self === other ? true : NotImplemented));
method(objectClass, '__ne__', 'one', 1, 1, (self, [other]) => {
  const eq = lookupSpecial(self, '__eq__');
  if (eq === undefined) return NotImplemented;
  const result = callValue(bindValue(eq, self), [other]);
  return result === NotImplemented ? NotImplemented : !currentRuntime().truthy(result);
});
for (const name of ['__lt__', '__le__', '__gt__', '__ge__'])
  method(objectClass, name, 'one', 1, 1, () => NotImplemented);
method(objectClass, '__hash__', 'none', 0, 0, (self) => identityHash(self as PyObject));
NATIVE_HASHES.add(objectClass.dict.get('__hash__') as PyValue);
method(objectClass, '__format__', 'one', 1, 1, (self, [spec]) => {
  if (typeof spec !== 'string') throw typeError(`__format__() argument must be str, not ${argumentTypeName(spec)}`);
  if (spec !== '') throw typeError(`unsupported format string passed to ${typeName(self)}.__format__`);
  return pyStr(self);
});
method(objectClass, '__setattr__', 'expected', 2, 2, (self, [nameValue, value]) => {
  const name = attributeName(nameValue);
  setAttributeDirectly(self, name, value);
  return None;
});
method(objectClass, '__getattribute__', 'one', 1, 1, (self, [name]) => getAttribute(self, attributeName(name)));
method(objectClass, '__delattr__', 'one', 1, 1, (self, [nameValue]) => {
  const name = attributeName(nameValue);
  deleteAttributeDirectly(self, name);
  return None;
});
method(objectClass, '__sizeof__', 'none', 0, 0, () => 16n);
method(objectClass, '__getstate__', 'none', 0, 0, (self) =>
  self instanceof PyInstance ? currentRuntime().dir(self) : None
);
for (const name of ['__reduce__', '__reduce_ex__']) {
  method(objectClass, name, 'expected', 0, 1, () => {
    throw currentRuntime().unsupported(`object.${name}()`);
  });
}
method(objectClass, '__init_subclass__', 'none', 0, 0, () => None, { binding: 'class' });
method(objectClass, '__subclasshook__', 'expected', 0, Number.POSITIVE_INFINITY, () => NotImplemented, {
  binding: 'class',
});
method(
  objectClass,
  '__new__',
  'expected',
  1,
  Number.POSITIVE_INFINITY,
  (_self, [cls]) => {
    if (!(cls instanceof PyClass)) throw typeError(`object.__new__(X): X is not a type object (${typeName(cls)})`);
    return new PyInstance(cls);
  },
  { binding: 'static', keywords: [] }
);
method(objectClass, '__dir__', 'none', 0, 0, (self) => currentRuntime().dir(self));

// type --------------------------------------------------------------------------------------------------------------

typeClass.construct = (_cls, args, kwargs) => {
  if (args.length === 1 && !(kwargs && kwargs.size > 0)) return classOf(args[0]);
  if (args.length === 3) throw currentRuntime().unsupported('type() による3引数でのクラスの作成');
  throw typeError('type() takes 1 or 3 arguments');
};
method(typeClass, '__repr__', 'none', 0, 0, (self) => {
  const cls = self as PyClass;
  if (isEnumClass(cls) && !cls.isBuiltin) return `<enum '${cls.name}'>`;
  const module = cls.module === 'builtins' ? '' : `${cls.module}.`;
  return `<class '${module}${cls.qualifiedName}'>`;
});
method(typeClass, 'mro', 'none', 0, 0, (self) => currentRuntime().listOf([...(self as PyClass).mro]));
method(typeClass, '__subclasses__', 'none', 0, 0, (self) =>
  currentRuntime().listOf([...currentRuntime().subclassesOf(self as PyClass)])
);
method(typeClass, '__instancecheck__', 'one', 1, 1, (self, [value]) => classOf(value).isSubclassOf(self as PyClass));
method(
  typeClass,
  '__subclasscheck__',
  'one',
  1,
  1,
  (self, [value]) => value instanceof PyClass && value.isSubclassOf(self as PyClass)
);
method(typeClass, '__or__', 'one', 1, 1, (self, [other]) => typeOr(self, other));
method(typeClass, '__ror__', 'one', 1, 1, (self, [other]) => typeOr(other, self));

// Singletons --------------------------------------------------------------------------------------------------------

noneClass.construct = (_cls, args) => {
  if (args.length > 0) throw typeError('NoneType takes no arguments');
  return None;
};
method(noneClass, '__repr__', 'none', 0, 0, () => 'None');
method(noneClass, '__bool__', 'none', 0, 0, () => false);
method(noneClass, '__hash__', 'none', 0, 0, () => 4_238_894_112n);
method(ellipsisClass, '__repr__', 'none', 0, 0, () => 'Ellipsis');
method(notImplementedClass, '__repr__', 'none', 0, 0, () => 'NotImplemented');

// Functions and methods ---------------------------------------------------------------------------------------------

method(
  functionClass,
  '__repr__',
  'none',
  0,
  0,
  (self) => `<function ${(self as PyFunction).qualifiedName} at ${addressOf(self as PyObject)}>`
);
method(functionClass, '__get__', 'expected', 1, 2, (self, [instance]) =>
  instance === None ? self : new PyBoundMethod(methodClass, instance, self)
);
method(methodClass, '__repr__', 'none', 0, 0, (self) => {
  const bound = self as PyBoundMethod;
  const name = bound.fn instanceof PyFunction ? bound.fn.qualifiedName : pyStr(getAttribute(bound.fn, '__qualname__'));
  return `<bound method ${name} of ${pyRepr(bound.self)}>`;
});
method(methodClass, '__eq__', 'one', 1, 1, (self, [other]) => {
  const bound = self as PyBoundMethod;
  return other instanceof PyBoundMethod && other.self === bound.self && other.fn === bound.fn;
});
method(methodClass, '__hash__', 'none', 0, 0, (self) => identityHash((self as PyBoundMethod).fn as PyObject));
method(builtinFunctionClass, '__repr__', 'none', 0, 0, (self) => {
  const fn = self as PyBuiltinFunction;
  if (fn.self === undefined || (fn.self instanceof PyObject && fn.self.cls === moduleClass))
    return `<built-in function ${fn.name}>`;
  if (fn.self instanceof PyClass) return `<built-in method ${fn.name} of type object at ${addressOf(fn.self)}>`;
  return `<built-in method ${fn.name} of ${typeName(fn.self)} object at ${fn.self instanceof PyObject ? addressOf(fn.self) : '0x0'}>`;
});
method(builtinFunctionClass, '__eq__', 'one', 1, 1, (self, [other]) => {
  if (!(other instanceof PyBuiltinFunction)) return NotImplemented;
  const fn = self as PyBuiltinFunction;
  return fn === other || (fn.run === other.run && fn.self === other.self);
});
// Hashes what equality compares, the native function and the receiver, as CPython hashes m_self and ml_meth.
method(builtinFunctionClass, '__hash__', 'none', 0, 0, (self) => {
  const fn = self as PyBuiltinFunction;
  return receiverHash(fn.self) ^ nativeIdentity(fn.run);
});
method(methodDescriptorClass, '__repr__', 'none', 0, 0, (self) => {
  const fn = self as PyBuiltinFunction;
  return `<method '${fn.name}' of '${fn.ownerName}' objects>`;
});
method(moduleClass, '__repr__', 'none', 0, 0, (self) => {
  const module = self as PyModule;
  // The repr of a module written in Python shows the path of its file.
  if (module.unsupported.has('__file__'))
    throw currentRuntime().unsupported(`モジュール ${module.name} の repr（ファイルのパス）`);
  return `<module '${module.name}' (built-in)>`;
});

// Generators and iterators ------------------------------------------------------------------------------------------

method(
  generatorClass,
  '__repr__',
  'none',
  0,
  0,
  (self) => `<generator object ${(self as PyGenerator).qualifiedName} at ${addressOf(self as PyObject)}>`
);
method(generatorClass, '__iter__', 'none', 0, 0, (self) => self);
method(generatorClass, '__next__', 'none', 0, 0, (self) => nextValue(self));
for (const name of ['send', 'throw', 'close']) {
  method(generatorClass, name, 'expected', 0, 3, () => {
    throw currentRuntime().unsupported(`ジェネレータの ${name}()`);
  });
}

/** The hash of a builtin method's receiver: its identity, which for an unboxed value is the value itself. */
function receiverHash(receiver: PyValue | undefined): bigint {
  if (receiver === undefined) return 0n;
  return receiver instanceof PyObject ? identityHash(receiver) : pyHash(receiver);
}

const nativeIdentities = new WeakMap<object, bigint>();
let nextNativeIdentity = 1n;

/** A stable number for a native function, which equal builtin methods share. */
function nativeIdentity(run: object): bigint {
  let identity = nativeIdentities.get(run);
  if (identity === undefined) {
    identity = nextNativeIdentity++;
    nativeIdentities.set(run, identity);
  }
  return identity;
}

/** `next(iterator)`, raising StopIteration at the end. */
export function nextValue(iterator: PyValue): PyValue {
  const value = nextOf(iterator)();
  if (value === DONE) throw stopIteration(iterator);
  return value;
}

/** The StopIteration that ends an iterator, carrying a generator's return value the first time it is reported. */
function stopIteration(iterator: PyValue): PyError {
  if (!(iterator instanceof PyGenerator) || iterator.returned === undefined) return pyError('StopIteration');
  const value = iterator.returned;
  iterator.returned = undefined;
  return new PyError(newException(exceptionClassNamed('StopIteration'), [value]));
}

/** Gives every native iterator class the iterator protocol and a repr. */
/** The iterator types whose `__length_hint__` gives how many items are left, and that can be pickled. */
const SIZED_ITERATORS = new Set([
  'list_iterator',
  'list_reverseiterator',
  'tuple_iterator',
  'str_ascii_iterator',
  'str_iterator',
  'range_iterator',
  'set_iterator',
  'dict_keyiterator',
  'dict_valueiterator',
  'dict_itemiterator',
  'dict_reversekeyiterator',
  'dict_reversevalueiterator',
  'dict_reverseitemiterator',
  'reversed',
]);
const PICKLED_ITERATORS = new Set([
  'list_iterator',
  'list_reverseiterator',
  'tuple_iterator',
  'str_ascii_iterator',
  'str_iterator',
  'range_iterator',
  'reversed',
  'zip',
  'map',
]);

export function defineIteratorClass(cls: PyClass): void {
  if (SIZED_ITERATORS.has(cls.name)) {
    method(cls, '__length_hint__', 'none', 0, 0, (self) => BigInt((self as PyIterator).lengthHint?.() ?? 0));
  }
  if (PICKLED_ITERATORS.has(cls.name)) {
    defineUnsupportedAttributes(cls, { __setstate__: `${cls.name}.__setstate__()（pickle で使う状態の復元）` });
  }
  method(cls, '__iter__', 'none', 0, 0, (self) => self);
  method(cls, '__next__', 'none', 0, 0, (self) => {
    const value = (self as PyIterator).next();
    if (value === DONE) throw pyError('StopIteration');
    return value;
  });
  method(cls, '__repr__', 'none', 0, 0, (self) => `<${cls.name} object at ${addressOf(self as PyObject)}>`);
}

for (const cls of iteratorClasses.values()) defineIteratorClass(cls);
iteratorClassSetup.push(defineIteratorClass);

// Descriptors -------------------------------------------------------------------------------------------------------

propertyClass.construct = (cls, args, kwargs) => {
  checkArgs(
    { qualified: 'property', min: 0, max: 4, style: 'takes', keywords: ['fget', 'fset', 'fdel', 'doc'], named: 4 },
    args,
    kwargs
  );
  const get = (index: number, name: string): PyValue => argument(args, kwargs, index, name) ?? None;
  return new PyDescriptor(cls, get(0, 'fget'), get(1, 'fset'), get(2, 'fdel'), get(3, 'doc'));
};
method(propertyClass, 'getter', 'one', 1, 1, (self, [fn]) => copyProperty(self, { fn }));
method(propertyClass, 'setter', 'one', 1, 1, (self, [fn]) => copyProperty(self, { setter: fn }));
method(propertyClass, 'deleter', 'one', 1, 1, (self, [fn]) => copyProperty(self, { deleter: fn }));
method(propertyClass, '__get__', 'expected', 1, 2, (self, [instance]) => {
  const property = self as PyDescriptor;
  if (instance === None) return self;
  return callValue(property.fn, [instance]);
});
method(propertyClass, '__repr__', 'none', 0, 0, (self) => `<property object at ${addressOf(self as PyObject)}>`);

function copyProperty(self: PyValue, change: { fn?: PyValue; setter?: PyValue; deleter?: PyValue }): PyValue {
  const property = self as PyDescriptor;
  return new PyDescriptor(
    propertyClass,
    change.fn ?? property.fn,
    change.setter ?? property.setter,
    change.deleter ?? property.deleter,
    property.doc
  );
}

for (const cls of [staticmethodClass, classmethodClass]) {
  cls.construct = (descriptorClass, args, kwargs) => {
    checkArgs({ qualified: cls.name, min: 1, max: 1, style: 'expected' }, args, kwargs);
    return new PyDescriptor(descriptorClass, args[0]);
  };
  method(cls, '__repr__', 'none', 0, 0, (self) => `<${cls.name}(${pyRepr((self as PyDescriptor).fn)})>`);
  method(cls, '__get__', 'expected', 1, 2, (self, [instance, owner]) => {
    const descriptor = self as PyDescriptor;
    if (cls === staticmethodClass) return descriptor.fn;
    return new PyBoundMethod(methodClass, owner instanceof PyClass ? owner : classOf(instance), descriptor.fn);
  });
}

// super -------------------------------------------------------------------------------------------------------------

superClass.construct = (cls, args, kwargs) => {
  checkArgs({ qualified: 'super', short: 'super()', min: 0, max: 2, style: 'expected' }, args, kwargs);
  if (args.length === 0) return currentRuntime().zeroArgumentSuper();
  const [thisClass, self] = args;
  if (!(thisClass instanceof PyClass)) throw typeError(`super() argument 1 must be a type, not ${typeName(thisClass)}`);
  if (self === undefined) throw currentRuntime().unsupported('引数が1つの super()');
  const selfClass = self instanceof PyClass && self.isSubclassOf(thisClass) ? self : classOf(self);
  if (!selfClass.isSubclassOf(thisClass))
    throw typeError('super(type, obj): obj must be an instance or subtype of type');
  return new PySuper(cls, thisClass, self, selfClass);
};
method(superClass, '__repr__', 'none', 0, 0, (self) => {
  const sup = self as PySuper;
  return `<super: <class '${sup.thisClass.name}'>, <${sup.selfClass.name} object>>`;
});

/** Reads an attribute through `super()`: from the classes after `thisClass` in the MRO of the object's class. */
export function superAttribute(sup: PySuper, name: string): PyValue | undefined {
  const { mro } = sup.selfClass;
  const start = mro.indexOf(sup.thisClass) + 1;
  for (const cls of mro.slice(start)) {
    const value = cls.dict.get(name);
    if (value === undefined) continue;
    if (sup.self instanceof PyClass) {
      if (value instanceof PyDescriptor && value.cls === classmethodClass)
        return new PyBoundMethod(methodClass, sup.self, value.fn);
      if (value instanceof PyDescriptor && value.cls === staticmethodClass) return value.fn;
      return value;
    }
    return bindValue(value, sup.self, sup.selfClass);
  }
  return undefined;
}

// slice -------------------------------------------------------------------------------------------------------------

sliceClass.construct = (_cls, args, kwargs) => {
  checkArgs({ qualified: 'slice', min: 1, max: 3, style: 'expected' }, args, kwargs);
  if (args.length === 1) return new PySlice(sliceClass, None, args[0], None);
  return new PySlice(sliceClass, args[0], args[1], args[2] ?? None);
};
method(sliceClass, '__repr__', 'none', 0, 0, (self) => {
  const slice = self as PySlice;
  return `slice(${pyRepr(slice.start)}, ${pyRepr(slice.stop)}, ${pyRepr(slice.step)})`;
});
method(sliceClass, '__hash__', 'none', 0, 0, (self) =>
  currentRuntime().hashOf(newTuple([(self as PySlice).start, (self as PySlice).stop, (self as PySlice).step]))
);

export { isCallable, pyFormat };
