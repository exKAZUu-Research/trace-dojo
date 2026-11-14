import { PyAttribute } from './attributeDescriptors';
import { assignExceptionAttribute, specialAttribute } from './attributes';
import { builtinClassLayout, builtinDoc } from './builtinDocs';
import { orderClassNamespace, orderModuleClasses } from './classOrders';
import { CPYTHON_TYPE_NAMES } from './data/typeNames';
import { method } from './define';
import { ownDict } from './descriptors';
import { defineConstructingNew } from './instances';
import { addModuleCreationHook } from './modules';
import { attributeError, bindValue, callValue } from './objects';
import { nativeCompare } from './operators';
import { allBuiltinClasses } from './subclasses';
import { baseExceptionClass, classmethodClass, defineMethod, nativeFunction, None, propertyClass } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { PyBuiltinFunction, PyClass, PyDescriptor, PyObject, type PyValue } from './values';

/**
 * Makes the data attributes of the builtin classes, which their modules define as properties, the getset or member
 * descriptors CPython's C types have, as CPython's data of each type tells; a class CPython writes in Python keeps its
 * properties.
 */
export function convertBuiltinAttributes(classes: Iterable<PyClass> = allBuiltinClasses()): void {
  for (const cls of classes) {
    cls.typeName ??= CPYTHON_TYPE_NAMES[`${cls.module}.${cls.qualifiedName}`];
    if (!cls.isBuiltin || converted.has(cls)) continue;
    converted.add(cls);
    const layout = builtinClassLayout(cls);
    if (layout !== undefined) convertAttributes(cls, layout);
    orderClassNamespace(cls);
  }
}

function convertAttributes(cls: PyClass, layout: string): void {
  const kinds = new Map(layout.split(' ').map((word) => word.split(':') as [string, string]));
  // A type CPython gives tp_new has `__new__` in its namespace, which creates its objects as calling it does.
  if (kinds.get('__new__') === 'builtin_function_or_method' && !cls.dict.has('__new__')) defineTypeNew(cls);
  if (cls.isSubclassOf(baseExceptionClass)) defineOwnSlots(cls, kinds);
  for (const [name, kind] of kinds) convertAttribute(cls, name, kind);
}

/** Makes one attribute of a builtin class the kind of object CPython's type has under its name. */
// code-gauge-allow functionCognitiveComplexity 18 -- One case per kind of attribute CPython's data names.
function convertAttribute(cls: PyClass, name: string, kind: string): void {
  const value = cls.dict.get(name);
  // A C type's namespace holds its docstring, which this grader keeps in CPython's data.
  if (name === '__doc__' && (kind === 'str' || kind === 'NoneType') && value === undefined) {
    cls.dict.set(name, builtinDoc(cls) ?? None);
    return;
  }
  // The comparisons of a C type that defines tp_richcompare, which this grader's values compare by natively.
  if (kind === 'wrapper_descriptor' && value === undefined && COMPARISONS.has(name)) {
    const operator = COMPARISONS.get(name) as Parameters<typeof nativeCompare>[0];
    method(cls, name, 'one', 1, 1, (self, [other]) => nativeCompare(operator, self, other));
    return;
  }
  // A C type's class method is a classmethod_descriptor, not a classmethod object wrapping a function.
  if (kind === 'classmethod_descriptor' && value instanceof PyDescriptor && value.cls === classmethodClass) {
    defineMethod(cls, name, (owner, args, kwargs) => callValue(value.fn, [owner, ...args], kwargs), 'class');
    return;
  }
  if (kind !== 'getset_descriptor' && kind !== 'member_descriptor') return;
  const descriptorKind = kind === 'member_descriptor' ? 'member' : 'getset';
  if (value instanceof PyDescriptor && value.cls === propertyClass) {
    cls.dict.set(name, attributeOf(cls, name, value, descriptorKind));
  } else if (value === undefined || (name === '__doc__' && (typeof value === 'string' || value === None))) {
    // A type whose objects have their own __doc__ gives its own by type.__doc__, from CPython's data.
    cls.dict.set(name, specialAttributeOf(cls, name, descriptorKind));
  } else if (!(value instanceof PyObject) || value.cls.isBuiltin === false || isPlainValue(value)) {
    // A class attribute standing for what the objects have by default, as function's __type_params__.
    const attribute = specialAttributeOf(cls, name, descriptorKind);
    attribute.fallback = value;
    cls.dict.set(name, attribute);
  }
}

const converted = new WeakSet<PyClass>();

const COMPARISONS = new Map([
  ['__lt__', '<'],
  ['__le__', '<='],
  ['__eq__', '=='],
  ['__ne__', '!='],
  ['__gt__', '>'],
  ['__ge__', '>='],
]);

/**
 * Gives an exception class the slot methods its C type defines itself, such as KeyError's `__str__`, which this
 * grader's base exception implements for every class: each calls the inherited one.
 */
function defineOwnSlots(cls: PyClass, kinds: Map<string, string>): void {
  for (const [name, kind] of kinds) {
    if ((kind !== 'wrapper_descriptor' && kind !== 'method_descriptor') || cls.dict.has(name)) continue;
    const inherited = cls.lookup(name);
    if (!(inherited instanceof PyBuiltinFunction)) continue;
    defineMethod(cls, name, (self, args, kwargs) => callValue(bindValue(inherited, self), args, kwargs));
  }
}

/**
 * The descriptor of an attribute this grader's objects of a builtin class keep natively, as an exception's `args`
 * or a range's `start`, which reads and writes them as their attribute lookup does.
 */
function specialAttributeOf(cls: PyClass, name: string, kind: 'getset' | 'member'): PyAttribute {
  const get = (instance: PyValue): PyValue => {
    const value = specialAttribute(instance, name) ?? ownDict(instance)?.get(name);
    // An object that lacks it natively lacks it as this grader's lookup does.
    if (value === undefined) throw attributeError(instance, name);
    return value;
  };
  const set = cls.isSubclassOf(baseExceptionClass)
    ? (instance: PyValue, value: PyValue | undefined): void => assignExceptionAttribute(instance, name, value)
    : undefined;
  return new PyAttribute(kind, name, cls, get, set, undefined, true);
}

const present = (value: PyValue | undefined): value is PyValue => value !== undefined && value !== None;

function attributeOf(cls: PyClass, name: string, property: PyDescriptor, kind: 'getset' | 'member'): PyAttribute {
  const { fn, setter, deleter } = property;
  const set = present(setter)
    ? (instance: PyValue, value: PyValue | undefined): void => {
        if (value !== undefined) callValue(setter, [instance, value]);
        else if (present(deleter)) callValue(deleter, [instance]);
        else callValue(setter, [instance, None]);
      }
    : undefined;
  const doc = typeof property.doc === 'string' ? property.doc : undefined;
  return new PyAttribute(kind, name, cls, (instance) => callValue(fn, [instance]), set, doc);
}

// The classes a module creates when a run imports it become CPython's descriptors as well.
addModuleCreationHook((runtime, name) => () => {
  const module = runtime.modules.get(name);
  if (!module) return;
  convertBuiltinAttributes([...module.dict.values()].filter((value) => value instanceof PyClass));
  orderModuleClasses(module.dict.values());
});

/** Gives a builtin type the `__new__` CPython's tp_new is, which creates objects as calling the type does. */
function defineTypeNew(cls: PyClass): void {
  if (cls.construct) {
    defineConstructingNew(cls);
    return;
  }
  // A type whose objects this grader creates only from what programs run, such as functions from `def`.
  const run = (): never => {
    throw new UnsupportedFeatureError(`${cls.name} オブジェクトを型から直接作ること（${cls.name}.__new__）`);
  };
  cls.dict.set('__new__', nativeFunction('__new__', run));
}

/** Whether a class attribute is a value rather than a descriptor or a method. */
function isPlainValue(value: PyValue): boolean {
  return !(value instanceof PyAttribute || value instanceof PyDescriptor || value instanceof PyBuiltinFunction);
}
