import { deleteInstanceAttribute, isInstanceWithAttributes, setInstanceAttribute } from './attributes';
import { typeNewFromArguments } from './classes';
import { addressOf, defaultRepr, pyFormat, pyRepr, pyStr } from './conversions';
import { method } from './define';
import { callGetter, descriptorGetter } from './descriptors';
import { isEnumClass, isFlagClass } from './enums';
import { generatorNext } from './generators';
import { identityHash } from './hashing';
import { defineNew, objectInitImplementation, objectNewImplementation, typeCall } from './instances';
import { argument, checkArgs } from './nativeArgs';
import {
  bindValue,
  callValue,
  deleteAttribute,
  genericGetAttribute,
  getAttribute,
  isCallable,
  lookupSpecial,
  nextOf,
} from './objects';
import { currentRuntime } from './runtimeContext';
import {
  builtinFunctionClass,
  classmethodClass,
  classmethodDescriptorClass,
  classOf,
  defineMethod,
  descriptorOwners,
  ellipsisClass,
  functionClass,
  isIteratorGenerator,
  iteratorClasses,
  iteratorClassSetup,
  methodClass,
  methodDescriptorClass,
  methodWrapperClass,
  moduleClass,
  newDict,
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
  wrapperDescriptorClass,
} from './types';
import {
  DONE,
  PyBoundMethod,
  PyBuiltinFunction,
  PyClass,
  PyDescriptor,
  PyFunction,
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
objectClass.dict.set(
  '__init__',
  new PyBuiltinFunction(
    wrapperDescriptorClass,
    '__init__',
    ([self, ...args], kwargs) => objectInitImplementation(self, args, kwargs),
    undefined,
    'method',
    'object'
  )
);
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
method(objectClass, '__format__', 'one', 1, 1, (self, [spec]) => {
  if (typeof spec !== 'string') throw typeError(`__format__() argument must be str, not ${typeName(spec)}`);
  if (spec !== '') throw typeError(`unsupported format string passed to ${typeName(self)}.__format__`);
  return pyStr(self);
});
method(objectClass, '__setattr__', 'expected', 2, 2, (self, [name, value]) => {
  if (typeof name !== 'string') throw typeError(`attribute name must be string, not '${typeName(name)}'`);
  if (isInstanceWithAttributes(self)) setInstanceAttribute(self as PyObject, name, value);
  else currentRuntime().setAttributeOf(self, name, value);
  return None;
});
method(objectClass, '__getattribute__', 'one', 1, 1, (self, [name]) => {
  if (typeof name !== 'string') throw typeError(`attribute name must be string, not '${typeName(name)}'`);
  return genericGetAttribute(self, name);
});
method(objectClass, '__delattr__', 'one', 1, 1, (self, [name]) => {
  if (typeof name !== 'string') throw typeError(`attribute name must be string, not '${typeName(name)}'`);
  if (isInstanceWithAttributes(self)) deleteInstanceAttribute(self as PyObject, name);
  else deleteAttribute(self, name);
  return None;
});
method(objectClass, '__sizeof__', 'none', 0, 0, () => 16n);
objectClass.dict.set(
  '__init_subclass__',
  new PyBuiltinFunction(
    classmethodDescriptorClass,
    '__init_subclass__',
    ([cls, ...args], kwargs) => {
      const name = `${(cls as PyClass).name}.__init_subclass__`;
      if (kwargs && kwargs.size > 0) throw typeError(`${name}() takes no keyword arguments`);
      if (args.length > 0) throw typeError(`${name}() takes no arguments (${args.length} given)`);
      return None;
    },
    undefined,
    'class',
    'object'
  )
);
method(objectClass, '__subclasshook__', 'expected', 0, Number.POSITIVE_INFINITY, () => NotImplemented, {
  binding: 'class',
});
objectClass.dict.set(
  '__new__',
  new PyBuiltinFunction(builtinFunctionClass, '__new__', objectNewImplementation, objectClass, 'static', 'object')
);
method(objectClass, '__dir__', 'none', 0, 0, (self) => currentRuntime().dir(self));

// type --------------------------------------------------------------------------------------------------------------

typeClass.construct = (_cls, args, kwargs) => {
  if (args.length === 1 && !(kwargs && kwargs.size > 0)) return classOf(args[0]);
  if (args.length !== 3) throw typeError('type() takes 1 or 3 arguments');
  return typeNewFromArguments(typeClass, args, kwargs);
};
defineNew(typeClass, (meta, args, kwargs) => typeNewFromArguments(meta, args, kwargs));
defineMethod(typeClass, '__init__', (_self, args, kwargs) => {
  if (args.length === 1 && kwargs && kwargs.size > 0) throw typeError('type.__init__() takes no keyword arguments');
  if (args.length !== 1 && args.length !== 3) throw typeError('type.__init__() takes 1 or 3 arguments');
  return None;
});
defineMethod(typeClass, '__call__', (self, args, kwargs) => typeCall(self as PyClass, args, kwargs));
defineMethod(typeClass, '__prepare__', () => newDict(), 'class');
method(typeClass, '__repr__', 'none', 0, 0, (self) => {
  const cls = self as PyClass;
  if (isEnumClass(cls) && !cls.isBuiltin) return `<${isFlagClass(cls) ? 'flag' : 'enum'} '${cls.name}'>`;
  const module = cls.module === 'builtins' ? '' : `${cls.module}.`;
  return `<class '${module}${cls.qualifiedName}'>`;
});
method(typeClass, 'mro', 'none', 0, 0, (self) => currentRuntime().listOf([...(self as PyClass).mro]));
method(typeClass, '__subclasses__', 'none', 0, 0, () => currentRuntime().listOf([]));
method(typeClass, '__instancecheck__', 'one', 1, 1, (self, [value]) => classOf(value).isSubclassOf(self as PyClass));
method(
  typeClass,
  '__subclasscheck__',
  'one',
  1,
  1,
  (self, [value]) => value instanceof PyClass && value.isSubclassOf(self as PyClass)
);
method(typeClass, '__or__', 'one', 1, 1, (self, [other]) => currentRuntime().unionType(self, other));
method(typeClass, '__ror__', 'one', 1, 1, (self, [other]) => currentRuntime().unionType(other, self));

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
  return `<built-in method ${fn.name} of ${boundObjectText(fn.self)}>`;
});
method(methodWrapperClass, '__repr__', 'none', 0, 0, (self) => {
  const fn = self as PyBuiltinFunction;
  return `<method-wrapper '${fn.name}' of ${boundObjectText(fn.self as PyValue)}>`;
});
for (const cls of [builtinFunctionClass, methodWrapperClass]) {
  method(cls, '__eq__', 'one', 1, 1, (self, [other]) => {
    if (!(other instanceof PyBuiltinFunction)) return NotImplemented;
    const fn = self as PyBuiltinFunction;
    return fn === other || (fn.run === other.run && fn.self === other.self);
  });
  method(cls, '__hash__', 'none', 0, 0, (self) => identityHash(self as PyObject));
}
for (const [cls, kind] of [
  [methodDescriptorClass, 'method'],
  [classmethodDescriptorClass, 'method'],
  [wrapperDescriptorClass, 'slot wrapper'],
] as const) {
  method(cls, '__repr__', 'none', 0, 0, (self) => {
    const fn = self as PyBuiltinFunction;
    const owner = descriptorOwners.get(fn);
    return `<${kind} '${fn.name}' of '${owner ? (owner.typeName ?? owner.name) : fn.ownerName}' objects>`;
  });
}
method(moduleClass, '__repr__', 'none', 0, 0, (self) => `<module '${(self as PyModule).name}' (built-in)>`);

/** How the repr of a builtin method shows the object it is bound to. */
function boundObjectText(self: PyValue): string {
  if (self instanceof PyClass) return `type object at ${addressOf(self)}`;
  return `${typeName(self)} object at ${self instanceof PyObject ? addressOf(self) : '0x0'}`;
}

// Generators and iterators ------------------------------------------------------------------------------------------

/** `next(iterator)`, raising StopIteration at the end, with the return value of a generator. */
export function nextValue(iterator: PyValue): PyValue {
  if (isIteratorGenerator(iterator)) return generatorNext(iterator, { value: None });
  const value = nextOf(iterator)();
  if (value === DONE) throw pyError('StopIteration');
  return value;
}

/** Gives every native iterator class the iterator protocol and a repr. */
export function defineIteratorClass(cls: PyClass): void {
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
    { qualified: 'property', min: 0, max: 4, style: 'takes', keywords: ['fget', 'fset', 'fdel', 'doc'] },
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
  return self === undefined ? new PySuper(cls, thisClass) : boundSuper(cls, thisClass, self);
};

/** A `super()` bound to `self`, an instance or subclass of `thisClass`. */
export function boundSuper(cls: PyClass, thisClass: PyClass, self: PyValue): PySuper {
  const selfClass = self instanceof PyClass && self.isSubclassOf(thisClass) ? self : classOf(self);
  if (!selfClass.isSubclassOf(thisClass)) {
    const shown = self instanceof PyClass ? `type ${self.name}` : `instance of ${typeName(self)}`;
    throw typeError(`super(type, obj): obj (${shown}) is not an instance or subtype of type (${thisClass.name}).`);
  }
  return new PySuper(cls, thisClass, self, selfClass);
}

method(superClass, '__repr__', 'none', 0, 0, (self) => {
  const sup = self as PySuper;
  const bound = sup.selfClass === undefined ? 'NULL' : `<${sup.selfClass.name} object>`;
  return `<super: <class '${sup.thisClass.name}'>, ${bound}>`;
});
method(superClass, '__get__', 'expected', 1, 2, (self, [instance]) => {
  const sup = self as PySuper;
  if (instance === None || sup.self !== undefined) return self;
  return boundSuper(sup.cls, sup.thisClass, instance);
});

/** Reads an attribute through `super()`: from the classes after `thisClass` in the MRO of the object's class. */
export function superAttribute(sup: PySuper, name: string): PyValue | undefined {
  const { self, selfClass } = sup;
  if (self !== undefined && selfClass !== undefined && name !== '__class__') {
    const { mro } = selfClass;
    const start = mro.indexOf(sup.thisClass) + 1;
    for (const cls of mro.slice(start)) {
      const value = cls.dict.get(name);
      if (value !== undefined) return bindThroughSuper(value, self, selfClass);
    }
  }
  const own = superClass.lookup(name);
  return own === undefined ? undefined : bindValue(own, sup, superClass);
}

function bindThroughSuper(value: PyValue, self: PyValue, selfClass: PyClass): PyValue {
  const getter = descriptorGetter(value);
  if (self === selfClass) {
    if (value instanceof PyDescriptor && value.cls === classmethodClass)
      return new PyBoundMethod(methodClass, self, value.fn);
    if (value instanceof PyDescriptor && value.cls === staticmethodClass) return value.fn;
    if (value instanceof PyBuiltinFunction && value.binding === 'class') return bindValue(value, selfClass, selfClass);
    return getter === undefined ? value : callGetter(getter, value, None, selfClass);
  }
  return getter === undefined ? bindValue(value, self, selfClass) : callGetter(getter, value, self, selfClass);
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
