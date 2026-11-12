import { registerVirtualSubclass } from './abstractClasses';
import { isSubclassOfClass } from './builtins';
import { pyRepr } from './conversions';
import { deleteDescriptor, isDataDescriptor, readDescriptor, writeDescriptor } from './descriptors';
import { newMappingProxy } from './mappingProxy';
import { attributeError, bindValue, callValue, getAttribute, lookupSpecial } from './objects';
import { currentRuntime } from './runtimeContext';
import {
  classmethodClass,
  classOf,
  namespaceDict,
  nativeFunction,
  newTuple,
  None,
  propertyClass,
  pyError,
  staticmethodClass,
  typeClass,
  typeError,
  typeName,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import {
  ownAttributesOf,
  PyBoundMethod,
  PyBuiltinFunction,
  PyClass,
  PyDescriptor,
  PyDict,
  PyFunction,
  PyInstance,
  PyModule,
  PyObject,
  PyOpaque,
  PyTuple,
  type PyValue,
} from './values';

/** CPython's docstrings of its builtins and C modules are over 500 KB, which this grader does not carry. */
export const BUILTIN_DOC = '組み込みの関数・型・モジュールの説明文（__doc__）';

/** Reads an attribute of a class: its own data, then the attributes of its MRO, bound as a class reads them. */
// code-gauge-allow functionCognitiveComplexity 21 -- One case per kind of class attribute and descriptor CPython binds.
export function classAttribute(cls: PyClass, name: string): PyValue | undefined {
  const own = typeData(cls, name);
  if (own !== undefined) return own;
  const attribute = cls.lookup(name);
  if (attribute === undefined && name === 'register' && cls.abc) {
    return nativeFunction('register', ([subclass]) => registerVirtualSubclass(cls, subclass, isSubclassOfClass));
  }
  if (attribute === undefined) {
    // Methods of the metaclass, such as `mro()`, bind to the class.
    const meta = typeClass.lookup(name);
    if (isDataDescriptor(meta)) return readDescriptor(meta, cls);
    return meta instanceof PyBuiltinFunction ? bindValue(meta, cls, typeClass) : undefined;
  }
  if (attribute instanceof PyDescriptor) {
    if (attribute.cls === staticmethodClass) return attribute.fn;
    if (attribute.cls === classmethodClass) return bindValue(attribute, cls, cls);
    return attribute;
  }
  if (attribute instanceof PyBuiltinFunction && attribute.binding === 'class' && attribute.self === undefined) {
    return bindValue(attribute, cls, cls);
  }
  if (attribute instanceof PyInstance && !attribute.cls.isBuiltin) {
    const get = attribute.cls.lookup('__get__');
    if (get !== undefined) return callValue(bindValue(get, attribute), [None, cls]);
  }
  if (attribute instanceof PyObject && attribute.cls.nativeGet) return attribute.cls.nativeGet(attribute, None, cls);
  return attribute;
}

function typeData(cls: PyClass, name: string): PyValue | undefined {
  switch (name) {
    case '__name__': {
      return cls.name;
    }
    case '__qualname__': {
      return cls.qualifiedName;
    }
    case '__module__': {
      return cls.module;
    }
    case '__doc__': {
      if (!cls.isBuiltin) return cls.dict.get('__doc__') ?? None;
      if (cls.doc === undefined) throw new UnsupportedFeatureError(BUILTIN_DOC);
      return cls.doc;
    }
    case '__mro__': {
      return newTuple(cls.mro);
    }
    case '__bases__': {
      return newTuple(cls.bases);
    }
    case '__base__': {
      return cls.bases[0] ?? None;
    }
    case '__class__': {
      return typeClass;
    }
    case '__dict__': {
      return newMappingProxy(namespaceDict(cls.dict));
    }
    case '__annotations__': {
      if (cls.isBuiltin) throw attributeError(cls, name);
      return currentRuntime().classAnnotationsValue(cls);
    }
    default: {
      return undefined;
    }
  }
}

/** The attributes builtin objects have of their own, outside any class dictionary. */
export function specialAttribute(value: PyValue, name: string): PyValue | undefined {
  if (name === '__class__') return classOf(value);
  if (typeof value !== 'object') return undefined;
  if (value instanceof PyBoundMethod) return boundMethodAttribute(value, name);
  if (value instanceof PyModule) return name === '__dict__' ? moduleDict(value) : undefined;
  if (value instanceof PyInstance) return instanceAttribute(value, name);
  if (value instanceof PyOpaque) return value.cls.opaqueAttribute?.(value, name);
  const ownAttributes = ownAttributesOf(value);
  if (ownAttributes && name === '__dict__') return namespaceDict(ownAttributes);
  return undefined;
}

/** A module's namespace as a dict, with the attributes it creates when first read created first, as CPython has them. */
function moduleDict(module: PyModule): PyValue {
  for (const name of module.lazy.keys()) module.attribute(name);
  return namespaceDict(module.dict);
}

const FUNCTION_ATTRIBUTES_OF_METHODS = new Set([
  '__name__',
  '__qualname__',
  '__doc__',
  '__module__',
  '__annotations__',
  '__annotate__',
]);

/** A bound method reads the attributes it does not have from its function. */
function boundMethodAttribute(method: PyBoundMethod, name: string): PyValue | undefined {
  return FUNCTION_ATTRIBUTES_OF_METHODS.has(name) ? getAttribute(method.fn, name) : undefined;
}

function instanceAttribute(instance: PyInstance, name: string): PyValue | undefined {
  if (name === '__dict__') return namespaceDict(instance.dict);
  if (instance.enumValue !== undefined) {
    if (name === 'value' || name === '_value_') return instance.enumValue;
    if (name === 'name' || name === '_name_') return instance.dict.get('_name_');
  }
  const state = instance.exception;
  if (name === 'exceptions') return state?.exceptions;
  if (name === 'message') return state?.message;
  if (name === '__notes__') return state?.notes;
  return undefined;
}

export function setAttribute(target: PyValue, name: string, value: PyValue): void {
  currentRuntime().spend();
  const hook = attributeHook(target, '__setattr__');
  if (hook !== undefined) {
    callValue(bindValue(hook, target), [name, value]);
    return;
  }
  setAttributeDirectly(target, name, value);
}

/** A `__setattr__` or `__delattr__` a program's class defines, which the class's instances, native or not, go through. */
function attributeHook(target: PyValue, name: string): PyValue | undefined {
  if (!(target instanceof PyInstance || target instanceof PyTuple) || target.cls.isBuiltin) return undefined;
  const hook = lookupSpecial(target, name);
  return hook instanceof PyBuiltinFunction ? undefined : hook;
}

/** `object.__setattr__`: sets an attribute without the hook a program's class may define. */
export function setAttributeDirectly(target: PyValue, name: string, value: PyValue): void {
  if (target instanceof PyInstance) {
    setInstanceAttribute(target, name, value);
    return;
  }
  if (target instanceof PyClass) {
    if (target.isBuiltin) throw typeError(`cannot set '${name}' attribute of immutable type '${target.name}'`);
    if (isEnumMemberName(target, name)) throw pyError('AttributeError', `cannot reassign member '${name}'`);
    setClassAttribute(target, name, value);
    return;
  }
  const descriptor = classOf(target).lookup(name);
  if (isDataDescriptor(descriptor)) {
    writeDescriptor(descriptor, target, value);
    return;
  }
  if (target instanceof PyFunction) {
    target.dict.set(name, value);
    return;
  }
  if (target instanceof PyModule) {
    target.dict.set(name, value);
    return;
  }
  setNativeObjectAttribute(target, name, value, descriptor);
}

/** Sets an attribute of a native object that is not an instance: a namedtuple's, an opaque value's, or a builtin's. */
function setNativeObjectAttribute(
  target: PyValue,
  name: string,
  value: PyValue,
  descriptor: PyValue | undefined
): void {
  if (isNamedTupleField(descriptor)) throw pyError('AttributeError', "can't set attribute");
  if (isProperty(descriptor)) return setProperty(descriptor, target, name, value);
  const ownAttributes = ownAttributesOf(target);
  if (ownAttributes) {
    ownAttributes.set(name, value);
    return;
  }
  if (descriptor !== undefined || specialAttribute(target, name) !== undefined) {
    throw pyError('AttributeError', `'${typeName(target)}' object attribute '${name}' is read-only`);
  }
  throw noDictError(target, name);
}

/** Whether a class attribute is a field namedtuple made, a property whose getter is a builtin `getter`. */
function isNamedTupleField(attribute: PyValue | undefined): boolean {
  return isProperty(attribute) && attribute.fn instanceof PyBuiltinFunction && attribute.fn.cls.name === 'getter';
}

function isProperty(attribute: PyValue | undefined): attribute is PyDescriptor {
  return attribute instanceof PyDescriptor && attribute.cls === propertyClass;
}

/** Sets an attribute through a property's setter, as `property.__set__` does. */
function setProperty(property: PyDescriptor, target: PyValue, name: string, value: PyValue): void {
  if (property.setter === undefined || property.setter === None) {
    throw pyError(
      'AttributeError',
      `property '${propertyName(property, name)}' of '${typeName(target)}' object has no setter`
    );
  }
  callValue(property.setter, [target, value]);
}

/** Deletes an attribute through a property's deleter, as `property.__delete__` does. */
function deleteProperty(property: PyDescriptor, target: PyValue, name: string): void {
  if (property.deleter === undefined || property.deleter === None) {
    throw pyError(
      'AttributeError',
      `property '${propertyName(property, name)}' of '${typeName(target)}' object has no deleter`
    );
  }
  callValue(property.deleter, [target]);
}

/** Stores an instance attribute, honoring properties and the special attributes of exceptions. */
export function setInstanceAttribute(target: PyInstance, name: string, value: PyValue): void {
  const cls = target.cls;
  const attribute = cls.lookup(name);
  if (isDataDescriptor(attribute)) {
    writeDescriptor(attribute, target, value);
    return;
  }
  if (isProperty(attribute)) {
    setProperty(attribute, target, name, value);
    return;
  }
  if (target.enumValue !== undefined) {
    // Enum's `name` and `value` are data descriptors refusing writes; `_value_` is where `value` reads from.
    if (isEnumMemberProperty(name)) throw pyError('AttributeError', `<enum 'Enum'> cannot set attribute '${name}'`);
    if (name === '_value_') {
      target.enumValue = value;
      return;
    }
  }
  const state = target.exception;
  if (state && name === '__notes__') {
    state.notes = value as never;
    return;
  }
  if (target.turtle && !cls.isBuiltin && cls.lookup(name) === undefined) {
    target.dict.set(name, value);
    return;
  }
  if (cls.isBuiltin && !state && !target.turtle) throw noDictError(target, name);
  target.dict.set(name, value);
}

function propertyName(property: PyDescriptor, fallback: string): string {
  const getter = property.fn;
  return getter instanceof PyFunction ? getter.name : fallback;
}

function noDictError(target: PyValue, name: string): Error {
  return pyError(
    'AttributeError',
    `'${typeName(target)}' object has no attribute '${name}' and no __dict__ for setting new attributes`
  );
}

export function deleteAttribute(target: PyValue, name: string): void {
  const hook = attributeHook(target, '__delattr__');
  if (hook !== undefined) {
    callValue(bindValue(hook, target), [name]);
    return;
  }
  deleteAttributeDirectly(target, name);
}

/** `object.__delattr__`: deletes an attribute without the hook a program's class may define. */
export function deleteAttributeDirectly(target: PyValue, name: string): void {
  if (target instanceof PyInstance) {
    deleteInstanceAttribute(target, name);
    return;
  }
  if (target instanceof PyClass) {
    deleteClassAttribute(target, name);
    return;
  }
  if (target instanceof PyFunction && name === '__annotations__') {
    // CPython's setter of a function's annotations takes a deletion as an assignment of None.
    setAttribute(target, name, None);
    return;
  }
  if (target instanceof PyFunction || target instanceof PyModule) {
    if (!target.dict.delete(name)) throw attributeError(target, name);
    return;
  }
  const descriptor = classOf(target).lookup(name);
  if (isDataDescriptor(descriptor)) return deleteDescriptor(descriptor, target);
  deleteNativeObjectAttribute(target, name, descriptor);
}

/** Deletes an attribute of a native object that is not an instance, as {@link setNativeObjectAttribute} sets one. */
function deleteNativeObjectAttribute(target: PyValue, name: string, descriptor: PyValue | undefined): void {
  if (isNamedTupleField(descriptor)) throw pyError('AttributeError', "can't delete attribute");
  if (isProperty(descriptor)) return deleteProperty(descriptor, target, name);
  const ownAttributes = ownAttributesOf(target);
  if (ownAttributes) {
    if (!ownAttributes.delete(name)) throw attributeError(target, name);
    return;
  }
  if (descriptor !== undefined) {
    throw pyError('AttributeError', `'${typeName(target)}' object attribute '${name}' is read-only`);
  }
  throw noDictError(target, name);
}

/** Deletes an instance attribute, honoring properties, as `object.__delattr__` does. */
export function deleteInstanceAttribute(target: PyInstance, name: string): void {
  const attribute = target.cls.lookup(name);
  if (isProperty(attribute)) {
    deleteProperty(attribute, target, name);
    return;
  }
  if (target.enumValue !== undefined && isEnumMemberProperty(name)) {
    throw pyError('AttributeError', `<enum 'Enum'> cannot delete attribute '${name}'`);
  }
  if (!target.dict.delete(name)) throw attributeError(target, name);
}

/** Deletes a class attribute, refusing a builtin type's and an Enum's members, as `type.__delattr__` and EnumType do. */
function deleteClassAttribute(cls: PyClass, name: string): void {
  if (cls.isBuiltin) throw typeError(`cannot delete '${name}' attribute of immutable type '${cls.name}'`);
  if (isEnumMemberName(cls, name)) {
    throw pyError('AttributeError', `${pyRepr(cls.name)} cannot delete member ${pyRepr(name)}.`);
  }
  if (name === '__annotations__') {
    if (cls.annotations === undefined) throw pyError('AttributeError', name);
    replaceClassAnnotations(cls, undefined);
  } else if (!cls.dict.delete(name)) throw attributeError(cls, name);
}

const isEnumMemberProperty = (name: string): boolean => name === 'name' || name === 'value';

/** Whether a name is a member of an Enum class, as EnumType's `__setattr__` and `__delattr__` find it in `_member_map_`. */
function isEnumMemberName(cls: PyClass, name: string): boolean {
  const memberMap = cls.enumMembers ? cls.dict.get('_member_map_') : undefined;
  return memberMap instanceof PyDict && memberMap.store.has(name);
}

/** Sets a class attribute, of which `__module__`, `__name__`, and `__qualname__` are the class's own data. */
function setClassAttribute(cls: PyClass, name: string, value: PyValue): void {
  if (name === '__name__' || name === '__qualname__') {
    if (typeof value !== 'string') {
      throw typeError(`can only assign string to ${cls.name}.${name}, not '${typeName(value)}'`);
    }
    if (name === '__name__') (cls as { name: string }).name = value;
    else cls.qualifiedName = value;
    return;
  }
  if (name === '__annotations__') {
    replaceClassAnnotations(cls, value);
    return;
  }
  if (name === '__module__' && typeof value === 'string') cls.module = value;
  cls.dict.set(name, value);
}

/** Assigns or deletes a class's `__annotations__`, after which the annotations of its body are no longer evaluated. */
function replaceClassAnnotations(cls: PyClass, value: PyValue | undefined): void {
  cls.annotations = value;
  currentRuntime().classAnnotationThunks.delete(cls);
}
