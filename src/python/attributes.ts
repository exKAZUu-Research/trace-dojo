import { registerVirtualSubclass } from './abstractClasses';
import { isSubclassOfClass } from './builtins';
import { isDataDescriptor, readDescriptor, writeDescriptor } from './descriptors';
import { newMappingProxy } from './mappingProxy';
import { attributeError, bindValue, callValue, getAttribute, lookupSpecial } from './objects';
import { currentRuntime } from './runtimeContext';
import {
  classmethodClass,
  classOf,
  namespaceDict,
  nativeFunction,
  newDict,
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
  PyBoundMethod,
  PyBuiltinFunction,
  PyClass,
  PyDescriptor,
  PyFunction,
  PyInstance,
  PyModule,
  PyObject,
  PyOpaque,
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
      return newDict(currentRuntime().classAnnotations(cls));
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
  if (value instanceof PyModule) return name === '__dict__' ? namespaceDict(value.dict) : undefined;
  if (value instanceof PyInstance) return instanceAttribute(value, name);
  if (value instanceof PyOpaque) return value.cls.opaqueAttribute?.(value, name);
  return undefined;
}

/** A bound method reads the attributes it does not have from its function. */
function boundMethodAttribute(method: PyBoundMethod, name: string): PyValue | undefined {
  if (name === '__name__' || name === '__qualname__' || name === '__doc__' || name === '__module__') {
    return getAttribute(method.fn, name);
  }
  return undefined;
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
  return undefined;
}

// code-gauge-allow functionNcss 33 -- Follows the rules of attribute assignment for each kind of object.
// code-gauge-allow functionCognitiveComplexity 21 -- Follows the rules of attribute assignment for each kind of object.
export function setAttribute(target: PyValue, name: string, value: PyValue): void {
  currentRuntime().spend();
  if (target instanceof PyInstance) {
    const cls = target.cls;
    const custom = cls.isBuiltin ? undefined : lookupSpecial(target, '__setattr__');
    if (custom !== undefined && !(custom instanceof PyBuiltinFunction)) {
      callValue(bindValue(custom, target), [name, value]);
      return;
    }
    setInstanceAttribute(target, name, value);
    return;
  }
  if (target instanceof PyClass) {
    if (target.isBuiltin) throw typeError(`cannot set '${name}' attribute of immutable type '${target.name}'`);
    if (target.enumMembers?.some((member) => member.dict.get('_name_') === name)) {
      throw pyError('AttributeError', `cannot reassign member '${name}'`);
    }
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
  if (target instanceof PyOpaque && target.attributes) {
    target.attributes.set(name, value);
    return;
  }
  if (target instanceof PyModule) {
    target.dict.set(name, value);
    return;
  }
  if (classOf(target).lookup(name) !== undefined || specialAttribute(target, name) !== undefined) {
    throw pyError('AttributeError', `'${typeName(target)}' object attribute '${name}' is read-only`);
  }
  throw noDictError(target, name);
}

/** Stores an instance attribute, honoring properties and the special attributes of exceptions. */
export function setInstanceAttribute(target: PyInstance, name: string, value: PyValue): void {
  const cls = target.cls;
  const attribute = cls.lookup(name);
  if (isDataDescriptor(attribute)) {
    writeDescriptor(attribute, target, value);
    return;
  }
  if (attribute instanceof PyDescriptor && attribute.cls === propertyClass) {
    if (attribute.setter === undefined || attribute.setter === None) {
      throw pyError(
        'AttributeError',
        `property '${propertyName(attribute, name)}' of '${cls.name}' object has no setter`
      );
    }
    callValue(attribute.setter, [target, value]);
    return;
  }
  if (target.enumValue !== undefined) {
    throw pyError('AttributeError', `cannot set '${name}' attribute of enum member`);
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

// code-gauge-allow functionCognitiveComplexity 23 -- Follows the rules of attribute deletion for each kind of object.
export function deleteAttribute(target: PyValue, name: string): void {
  if (target instanceof PyInstance) {
    const custom = target.cls.isBuiltin ? undefined : lookupSpecial(target, '__delattr__');
    if (custom !== undefined && !(custom instanceof PyBuiltinFunction)) {
      callValue(bindValue(custom, target), [name]);
      return;
    }
    deleteInstanceAttribute(target, name);
    return;
  }
  if (target instanceof PyClass) {
    if (target.isBuiltin) throw typeError(`cannot delete '${name}' attribute of immutable type '${target.name}'`);
    if (!target.dict.delete(name)) throw attributeError(target, name);
    return;
  }
  if (target instanceof PyFunction || target instanceof PyModule) {
    if (!target.dict.delete(name)) throw attributeError(target, name);
    return;
  }
  if (classOf(target).lookup(name) !== undefined) {
    throw pyError('AttributeError', `'${typeName(target)}' object attribute '${name}' is read-only`);
  }
  throw attributeError(target, name);
}

/** Deletes an instance attribute, honoring properties, as `object.__delattr__` does. */
export function deleteInstanceAttribute(target: PyInstance, name: string): void {
  const attribute = target.cls.lookup(name);
  if (attribute instanceof PyDescriptor && attribute.cls === propertyClass) {
    if (attribute.deleter === undefined || attribute.deleter === None) {
      throw pyError(
        'AttributeError',
        `property '${propertyName(attribute, name)}' of '${target.cls.name}' object has no deleter`
      );
    }
    callValue(attribute.deleter, [target]);
    return;
  }
  if (!target.dict.delete(name)) throw attributeError(target, name);
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
  if (name === '__module__' && typeof value === 'string') cls.module = value;
  cls.dict.set(name, value);
}
