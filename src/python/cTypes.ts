import { convertBuiltinAttributes } from './builtinAttributeKinds';
import { builtinClassLayout } from './builtinDocs';
import { unsupportedSizeof } from './define';
import { builtinClassesWithDict, fieldedCTypes } from './descriptors';
import { defineNew } from './instances';
import { bindValue, callValue } from './objects';
import { currentRuntime } from './runtimeContext';
import { defineMethod, None, propertyClass, staticmethodClass, typeClass } from './types';
import { type PyClass, PyDescriptor, PyFunction, PyInstance, type PyValue } from './values';

/** The entries a class statement adds to a class's namespace, which a C type has only when CPython's data lists them. */
const CLASS_STATEMENT_NAMES = [
  '__firstlineno__',
  '__static_attributes__',
  '__slots__',
  '__module__',
  '__qualname__',
  '__dict__',
  '__weakref__',
];

/**
 * Makes a class written in Python here the C type CPython's is: its functions become builtin methods, a `__new__`
 * written as a static method becomes the type's `__new__`, the class statement's own entries and the private helpers
 * go unless CPython's type has them, and the type gets the docstring and slot wrappers CPython's data gives it.
 */
export function makeCType(cls: PyClass, subclassable = true): void {
  cls.qualifiedName = cls.name;
  const layout = builtinClassLayout(cls);
  const names = layout === undefined ? undefined : new Set(layout.split(' ').map((word) => word.split(':')[0]));
  if (!cls.dict.has('__new__') && (names?.has('__new__') ?? true)) {
    defineNew(cls, (subclass) => allocateInstance(subclass));
  }
  inheritOwnAttributes(cls, names);
  if (names !== undefined) hidePrivateHelpers(cls, names);
  for (const [name, attribute] of new Map(cls.dict)) {
    if (attribute instanceof PyFunction) {
      defineMethod(cls, name, (self, args, kwargs) => callValue(attribute, [self, ...args], kwargs));
    } else if (name === '__new__' && attribute instanceof PyDescriptor && attribute.cls === staticmethodClass) {
      defineNew(cls, (subclass, args, kwargs) => callValue(attribute.fn, [subclass, ...args], kwargs));
    }
  }
  cls.isBuiltin = true;
  cls.isBaseType = subclassable;
  fieldedCTypes.add(cls);
  removeClassStatementNames(cls, names);
  if (names?.has('__sizeof__') && !cls.dict.has('__sizeof__')) unsupportedSizeof(cls);
  // A C type's docstring comes from CPython's data.
  if (cls.dict.get('__doc__') === None) cls.dict.delete('__doc__');
  convertBuiltinAttributes([cls]);
}

function removeClassStatementNames(cls: PyClass, names: Set<string | undefined> | undefined): void {
  const kept = names ?? new Set(['__module__', '__dict__', '__weakref__']);
  for (const name of CLASS_STATEMENT_NAMES) if (!kept.has(name)) cls.dict.delete(name);
  // The objects of a class written without __slots__ keep their fields in their dict here.
  if (kept.has('__dict__') || cls.slotNames === undefined) builtinClassesWithDict.add(cls);
  if (cls.cls !== typeClass && names !== undefined) {
    // A C type is no abstract base class, even when the classes it derives from here are.
    cls.cls = typeClass;
    for (const name of ['__abstractmethods__', '_abc_impl']) if (!kept.has(name)) cls.dict.delete(name);
  }
}

/**
 * Moves out of a class's namespace the private helpers its methods written in Python use and CPython's type lacks,
 * where its objects' lookup still finds them, as C keeps such helpers outside the type.
 */
function hidePrivateHelpers(cls: PyClass, names: Set<string | undefined>): void {
  const helpers = new Map<string, PyValue>();
  for (const [name, value] of cls.dict) {
    if (name.startsWith('_') && !/^__\w+__$/.test(name) && !names.has(name)) helpers.set(name, value);
  }
  if (helpers.size === 0) return;
  for (const name of helpers.keys()) cls.dict.delete(name);
  cls.missingAttribute = (self, name) => {
    const helper = helpers.get(name);
    return helper === undefined ? undefined : bindValue(helper, self);
  };
}

/**
 * Copies into a class the methods and properties that CPython's type has itself and the class inherits here from a
 * base written in Python, which CPython's C type does not derive from.
 */
function inheritOwnAttributes(cls: PyClass, names: Set<string | undefined> | undefined): void {
  for (const name of names ?? []) {
    if (name === undefined || cls.dict.has(name)) continue;
    const inherited = cls.lookup(name);
    const isProperty = inherited instanceof PyDescriptor && inherited.cls === propertyClass;
    if (inherited instanceof PyFunction || isProperty) cls.dict.set(name, inherited);
  }
}

/** The instance a C type's tp_alloc creates, which `object.__new__` refuses for a builtin type. */
export function allocateInstance(cls: PyClass): PyInstance {
  currentRuntime().allocate(1);
  return new PyInstance(cls);
}

/** The fields each object of a C type written in Python keeps outside its instance, as C keeps them in its struct. */
const fields = new WeakMap<object, PyValue[]>();

export function fieldsOf(instance: PyValue): PyValue[] {
  let found = fields.get(instance as object);
  if (!found) fields.set(instance as object, (found = []));
  return found;
}
