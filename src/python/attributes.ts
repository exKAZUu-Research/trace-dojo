// code-gauge-allow-file fileNcss 445 -- The attribute lookup keeps the special attributes of every builtin kind of object together.
import { solidBase } from './classes';
import {
  builtinClassesWithDict,
  callGetter,
  callSetter,
  descriptorGetter,
  isDataDescriptor,
  noteGetattributeAssigned,
  ownDict,
} from './descriptors';
import { namespaceDict, namespaceOf } from './namespaces';
import { attributeError, bindValue, callValue, lookupSpecial } from './objects';
import { currentRuntime } from './runtimeContext';
import { deleteMember, instancesHaveDict, isMember, writeMember } from './slots';
import {
  builtinFunctionClass,
  classmethodClass,
  classOf,
  descriptorOwners,
  isNativeMethod,
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
import {
  type ExceptionState,
  PyBoundMethod,
  PyBuiltinFunction,
  PyClass,
  PyComplex,
  PyDescriptor,
  PyDict,
  PyFunction,
  PyGenerator,
  PyInstance,
  PyModule,
  PyObject,
  PyRange,
  PySlice,
  type PyValue,
} from './values';
import { weakReferenceOf } from './weakReferences';

/** Reads an attribute of a class: its own data, then the attributes of its MRO, bound as a class reads them. */
// code-gauge-allow functionCognitiveComplexity 18 -- Follows the order CPython's type_getattro looks up an attribute in.
export function classAttribute(cls: PyClass, name: string): PyValue | undefined {
  const own = typeData(cls, name);
  if (own !== undefined) return own;
  const meta = cls.cls;
  const metaAttribute = meta === typeClass ? undefined : meta.lookup(name);
  if (metaAttribute !== undefined && isMetaDataDescriptor(metaAttribute)) return bindToClass(metaAttribute, cls);
  const attribute = cls.lookup(name);
  if (attribute === undefined) {
    // Methods of the metaclass, such as `mro()`, bind to the class.
    if (metaAttribute !== undefined) return bindToClass(metaAttribute, cls);
    const typeAttribute = typeClass.lookup(name);
    return typeAttribute instanceof PyBuiltinFunction ? bindValue(typeAttribute, cls, typeClass) : undefined;
  }
  const getter = descriptorGetter(attribute);
  if (getter !== undefined) return callGetter(getter, attribute, None, cls);
  if (attribute instanceof PyDescriptor) {
    if (attribute.cls === staticmethodClass) return attribute.fn;
    if (attribute.cls === classmethodClass) return bindValue(attribute, cls, cls);
    return attribute;
  }
  if (attribute instanceof PyBuiltinFunction && attribute.binding === 'class' && attribute.self === undefined) {
    return bindValue(attribute, cls, cls);
  }
  return attribute;
}

/** Binds an attribute of a metaclass to a class, which is an instance of the metaclass. */
function bindToClass(attribute: PyValue, cls: PyClass): PyValue {
  const getter = descriptorGetter(attribute);
  return getter === undefined ? bindValue(attribute, cls, cls.cls) : callGetter(getter, attribute, cls, cls.cls);
}

function isMetaDataDescriptor(attribute: PyValue): boolean {
  return (attribute instanceof PyDescriptor && attribute.cls === propertyClass) || isDataDescriptor(attribute);
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
      return cls.isBuiltin ? (cls.doc ?? None) : (cls.dict.get('__doc__') ?? None);
    }
    case '__mro__': {
      return newTuple(cls.mro);
    }
    case '__bases__': {
      return newTuple(cls.bases);
    }
    case '__type_params__': {
      return cls.dict.get('__type_params__') ?? newTuple([]);
    }
    case '__base__': {
      return cls.bases[0] ?? None;
    }
    case '__class__': {
      return cls.cls;
    }
    case '__dict__': {
      // A read-only view of the class's own namespace, as CPython's mappingproxy.
      const types = currentRuntime().importModule('types');
      return callValue(types.dict.get('MappingProxyType') as PyValue, [namespaceDict(cls.dict)]);
    }
    case '__annotations__': {
      return cls.dict.get('__annotations__') ?? newDict(currentRuntime().classAnnotations(cls));
    }
    default: {
      return undefined;
    }
  }
}

/** The attributes builtin objects have of their own, outside any class dictionary. */
// code-gauge-allow functionCognitiveComplexity 22 -- One case per kind of builtin object with attributes of its own.
export function specialAttribute(value: PyValue, name: string): PyValue | undefined {
  if (name === '__class__') return classOf(value);
  if (typeof value === 'bigint' || typeof value === 'boolean') return integerAttribute(BigInt(value), name);
  if (typeof value === 'number') return realPartAttribute(value, 0, name);
  if (typeof value === 'string') return undefined;
  // No other kind of object checked below is a PyInstance.
  if (value instanceof PyInstance) return instanceAttribute(value, name);
  if (value instanceof PyComplex) return realPartAttribute(value.real, value.imag, name);
  if (value instanceof PyFunction) return functionAttribute(value, name);
  if (value instanceof PyBoundMethod) return boundMethodAttribute(value, name);
  if (value instanceof PyBuiltinFunction) return builtinFunctionAttribute(value, name);
  if (value instanceof PyModule) return name === '__dict__' ? namespaceDict(value.dict) : undefined;
  if (value instanceof PySlice || value instanceof PyRange) {
    return name === 'start' || name === 'stop' || name === 'step' ? value[name] : undefined;
  }
  if (value instanceof PyGenerator) return generatorAttribute(value, name);
  if (value instanceof PyDescriptor) return wrappedFunction(value, name);
  if (name === '__dict__' && value instanceof PyObject && !value.cls.isBuiltin) return dictAttribute(value);
  return undefined;
}

/** The function a staticmethod or classmethod wraps, as its `__func__` and `__wrapped__` give it. */
function wrappedFunction(descriptor: PyDescriptor, name: string): PyValue | undefined {
  if (name === '__doc__' && descriptor.cls === propertyClass) return propertyDoc(descriptor);
  if (name !== '__func__' && name !== '__wrapped__') return undefined;
  return descriptor.cls.isSubclassOf(staticmethodClass) || descriptor.cls.isSubclassOf(classmethodClass)
    ? descriptor.fn
    : undefined;
}

/** A property's `__doc__`: the one it was given or assigned, else its getter's. */
function propertyDoc(property: PyDescriptor): PyValue {
  if (property.doc !== undefined && property.doc !== None) return property.doc;
  return property.fn === None ? None : (specialAttribute(property.fn, '__doc__') ?? None);
}

/** The `__dict__` of an object, or undefined for one whose class gives its instances none. */
function dictAttribute(value: PyObject): PyValue | undefined {
  const dict = ownDict(value);
  return dict === undefined ? undefined : namespaceDict(dict);
}

function integerAttribute(integer: bigint, name: string): PyValue | undefined {
  if (name === 'real' || name === 'numerator') return integer;
  if (name === 'imag') return 0n;
  if (name === 'denominator') return 1n;
  return undefined;
}

function realPartAttribute(real: number, imag: number, name: string): PyValue | undefined {
  if (name === 'real') return real;
  if (name === 'imag') return imag;
  return undefined;
}

function boundMethodAttribute(method: PyBoundMethod, name: string): PyValue | undefined {
  if (name === '__self__') return method.self;
  if (name === '__func__') return method.fn;
  if (name === '__name__' || name === '__qualname__' || name === '__doc__' || name === '__module__') {
    return specialAttribute(method.fn, name);
  }
  return undefined;
}

function builtinFunctionAttribute(fn: PyBuiltinFunction, name: string): PyValue | undefined {
  if (name === '__name__') return fn.name;
  if (name === '__qualname__') return fn.qualifiedName;
  if (name === '__self__') {
    // A static method such as `str.maketrans` shows its type in its repr but has no `__self__`, unlike `__new__`.
    if (fn.binding === 'static' && fn.name !== '__new__') return None;
    return fn.self ?? (fn.cls === builtinFunctionClass ? moduleOf(fn) : undefined);
  }
  if (name === '__objclass__') return descriptorOwners.get(fn);
  if (name === '__doc__') return None;
  return undefined;
}

/** The module a builtin function without a bound object belongs to, which its `__self__` gives. */
function moduleOf(fn: PyBuiltinFunction): PyValue {
  const runtime = currentRuntime();
  if (runtime.builtins.get(fn.name) === fn) return runtime.importModule('builtins');
  for (const module of runtime.modules.values()) if (module.dict.get(fn.name) === fn) return module;
  return None;
}

/** The prefix of the attributes of each kind of generator object, such as `cr_running` of a coroutine. */
const GENERATOR_PREFIXES: Record<string, string> = { coroutine: 'cr_', async_generator: 'ag_' };

function generatorAttribute(generator: PyGenerator, attribute: string): PyValue | undefined {
  if (attribute === '__name__') return generator.name;
  if (attribute === '__qualname__') return generator.qualifiedName;
  const prefix = GENERATOR_PREFIXES[generator.cls.name] ?? 'gi_';
  if (!attribute.startsWith(prefix)) return undefined;
  const name = `gi_${attribute.slice(prefix.length)}`;
  if (name === 'gi_await' && prefix !== 'gi_') return generatorAttribute(generator, 'gi_yieldfrom');
  if (name === 'gi_running') return generator.running;
  if (name === 'gi_suspended') return generator.started && !generator.running && !generator.finished;
  if (name === 'gi_frame' && generator.finished) return None;
  if (name === 'gi_frame' || name === 'gi_code' || name === 'gi_yieldfrom') {
    throw currentRuntime().unsupported(`ジェネレータの ${attribute}`);
  }
  return undefined;
}

function functionAttribute(fn: PyFunction, name: string): PyValue | undefined {
  switch (name) {
    case '__name__': {
      return fn.name;
    }
    case '__qualname__': {
      return fn.qualifiedName;
    }
    case '__doc__': {
      return fn.dict.get('__doc__') ?? fn.def.doc ?? None;
    }
    case '__module__': {
      return fn.module;
    }
    case '__defaults__': {
      return fn.defaults.length > 0 ? newTuple(fn.defaults) : None;
    }
    case '__type_params__': {
      return newTuple(fn.typeParams);
    }
    case '__kwdefaults__': {
      return fn.keywordDefaults.size > 0 ? newDict(fn.keywordDefaults.entries()) : None;
    }
    case '__annotations__': {
      return currentRuntime().evaluator.annotationsOf(fn);
    }
    case '__dict__': {
      return namespaceDict(fn.dict);
    }
    default: {
      return undefined;
    }
  }
}

// code-gauge-allow functionNcss 34 -- One case per attribute an instance of a builtin class keeps outside its dictionary.
function instanceAttribute(instance: PyInstance, name: string): PyValue | undefined {
  if (name === '__dict__') return dictAttribute(instance);
  if (name === '__weakref__' && instance.cls.lookup('__weakref__') !== undefined)
    return weakReferenceOf(instance) ?? None;
  if (instance.primitive !== undefined) return specialAttribute(instance.primitive, name);
  if (instance.enumValue !== undefined) {
    if (name === 'value' || name === '_value_') return instance.enumValue;
    if (name === 'name' || name === '_name_') return instance.dict.get('_name_');
  }
  const state = instance.exception;
  if (!state) return undefined;
  switch (name) {
    case 'args': {
      return state.args;
    }
    case '__notes__': {
      return state.notes;
    }
    case '__cause__': {
      return state.cause ?? None;
    }
    case '__context__': {
      return state.context ?? None;
    }
    case '__suppress_context__': {
      return state.suppressContext;
    }
    case '__traceback__': {
      return None;
    }
    case 'exceptions': {
      return state.exceptions;
    }
    case 'message': {
      return state.message;
    }
    default: {
      return exceptionFieldOf(instance, name);
    }
  }
}

/** The fields some builtin exceptions derive from their arguments, such as `StopIteration.value`. */
// code-gauge-allow functionCognitiveComplexity 26 -- One case per attribute exceptions keep outside their dictionary.
function exceptionFieldOf(instance: PyInstance, name: string): PyValue | undefined {
  const state = instance.exception;
  if (!state) return undefined;
  const args = state.args.items;
  const is = (className: string): boolean => instance.cls.mro.some((cls) => cls.isBuiltin && cls.name === className);
  if (name === 'value' && is('StopIteration')) return args[0] ?? None;
  if (name === 'code' && is('SystemExit')) return args.length === 0 ? None : args.length === 1 ? args[0] : state.args;
  if ((name === 'name' || name === 'obj') && (is('AttributeError') || is('NameError') || is('ImportError'))) {
    if (name === 'name') return state.name ?? None;
    return state.object ?? None;
  }
  return is('OSError') ? osErrorField(state, name) : undefined;
}

/** The fields an OSError derives from the arguments it was created with, as `OSError(errno, strerror, filename)`. */
function osErrorField(state: ExceptionState, name: string): PyValue | undefined {
  const args = state.args.items;
  if (name === 'errno' || name === 'strerror') {
    return args.length >= 2 && args.length <= 5 ? args[name === 'errno' ? 0 : 1] : None;
  }
  if (name === 'filename') return state.filename ?? None;
  if (name === 'filename2') return state.filename2 ?? None;
  return undefined;
}

export function setAttribute(target: PyValue, name: string, value: PyValue): void {
  currentRuntime().spend();
  if (takesInstanceAttributes(target)) {
    const custom = userHook(target as PyObject, '__setattr__');
    if (custom === undefined) setInstanceAttribute(target as PyObject, name, value);
    else callValue(bindValue(custom, target), [name, value]);
    return;
  }
  if (target instanceof PyClass) {
    setClassAttribute(target, name, value);
    return;
  }
  if (target instanceof PyFunction) {
    if (name === '__name__' && typeof value === 'string') target.name = value;
    else if (name === '__qualname__' && typeof value === 'string') target.qualifiedName = value;
    else target.dict.set(name, value);
    return;
  }
  if (target instanceof PyModule) {
    target.dict.set(name, value);
    return;
  }
  if (target instanceof PyDescriptor && target.cls === propertyClass && name === '__doc__') {
    target.doc = value;
    return;
  }
  throw readOnlyError(target, name);
}

/** Whether assigning an attribute of `target` follows the rules of instances, as opposed to classes or modules. */
function takesInstanceAttributes(target: PyValue): boolean {
  return (
    target instanceof PyInstance ||
    isSubclassInstance(target) ||
    (target instanceof PyObject && builtinClassesWithDict.has(target.cls))
  );
}

/** The AttributeError for assigning to an attribute of an object of a builtin type, which has no `__dict__`. */
function readOnlyError(target: PyValue, name: string): Error {
  const attribute = classOf(target).lookup(name);
  if (
    attribute instanceof PyDescriptor &&
    attribute.cls === propertyClass &&
    attribute.fn instanceof PyBuiltinFunction
  ) {
    // A builtin type's read-only member says less than its read-only computed attribute, as in CPython.
    if (classOf(attribute.fn).name === 'member_descriptor') return pyError('AttributeError', 'readonly attribute');
    return pyError('AttributeError', `attribute '${name}' of '${typeName(target)}' objects is not writable`);
  }
  if (attribute !== undefined || specialAttribute(target, name) !== undefined) {
    return pyError('AttributeError', `'${typeName(target)}' object attribute '${name}' is read-only`);
  }
  return noDictError(target, name);
}

/** The `__setattr__` or `__delattr__` a program's class defines, or undefined. */
function userHook(target: PyObject, name: string): PyValue | undefined {
  const custom = lookupSpecial(target, name);
  // Builtin classes implement these hooks natively, except for those whose slot is not a method descriptor.
  return isNativeMethod(custom) ? undefined : custom;
}

function setClassAttribute(target: PyClass, name: string, value: PyValue): void {
  if (target.isBuiltin) throw typeError(`cannot set '${name}' attribute of immutable type '${target.name}'`);
  if (setClassAttributeThroughMeta(target, name, value)) return;
  if (name === '__getattribute__') noteGetattributeAssigned();
  if (target.enumMembers?.some((member) => member.dict.get('_name_') === name)) {
    throw pyError('AttributeError', `cannot reassign member '${name}'`);
  }
  if (name === '__module__' && typeof value === 'string') target.module = value;
  target.dict.set(name, value);
}

/** Whether a value is an instance of a program's subclass of a builtin type other than object, such as list. */
function isSubclassInstance(value: PyValue): boolean {
  return value instanceof PyObject && !(value instanceof PyClass) && !value.cls.isBuiltin;
}

/** Whether attribute assignment on a value follows the rules of instances, as opposed to classes or modules. */
export function isInstanceWithAttributes(value: PyValue): boolean {
  return value instanceof PyInstance || isSubclassInstance(value);
}

/** Sets a class attribute through its metaclass's `__setattr__` or data descriptor, returning whether one did. */
function setClassAttributeThroughMeta(target: PyClass, name: string, value: PyValue): boolean {
  const meta = target.cls;
  if (meta.isBuiltin) return false;
  const custom = meta.lookup('__setattr__');
  if (custom !== undefined && !(custom instanceof PyBuiltinFunction)) {
    callValue(bindValue(custom, target), [name, value]);
    return true;
  }
  const attribute = meta.lookup(name);
  if (attribute instanceof PyDescriptor && attribute.cls === propertyClass) {
    setProperty(attribute, target, name, value);
    return true;
  }
  return attribute !== undefined && callSetter(attribute, target, value);
}

/** Assigns `__class__`, which only a class whose instances are laid out alike may take. */
function setClassOf(target: PyObject, value: PyValue): void {
  if (!(value instanceof PyClass)) {
    throw typeError(`__class__ must be set to a class, not '${typeName(value)}' object`);
  }
  if (target.cls.isBuiltin || value.isBuiltin) {
    throw typeError('__class__ assignment only supported for mutable types or ModuleType subclasses');
  }
  const sameSlots = [...(target.cls.slotNames ?? [])].join(',') === [...(value.slotNames ?? [])].join(',');
  if (
    solidBase(target.cls) !== solidBase(value) ||
    !sameSlots ||
    instancesHaveDict(target.cls) !== instancesHaveDict(value)
  ) {
    throw typeError(`__class__ assignment: '${value.name}' object layout differs from '${target.cls.name}'`);
  }
  target.cls = value;
}

function setProperty(property: PyDescriptor, target: PyObject, name: string, value: PyValue): void {
  if (property.setter === undefined || property.setter === None) {
    if (property.fn instanceof PyBuiltinFunction) {
      const cls = target.cls;
      throw pyError('AttributeError', `attribute '${name}' of '${cls.typeName ?? cls.name}' objects is not writable`);
    }
    throw pyError(
      'AttributeError',
      `property '${propertyName(property, name)}' of '${target.cls.name}' object has no setter`
    );
  }
  callValue(property.setter, [target, value]);
}

/** Stores an instance attribute, honoring descriptors, slots, and the special attributes of exceptions. */
export function setInstanceAttribute(target: PyObject, name: string, value: PyValue): void {
  if (name === '__class__') {
    setClassOf(target, value);
    return;
  }
  if (name === '__dict__' && ownDict(target) !== undefined) {
    replaceDict(target, value);
    return;
  }
  const attribute = target.cls.lookup(name);
  if (attribute instanceof PyDescriptor && attribute.cls === propertyClass) {
    setProperty(attribute, target, name, value);
    return;
  }
  if (isMember(attribute)) {
    writeMember(attribute, target, value);
    return;
  }
  if (attribute !== undefined && callSetter(attribute, target, value)) return;
  if (target instanceof PyInstance) {
    setInstanceDictEntry(target, name, value, attribute);
    return;
  }
  const dict = ownDict(target);
  if (dict === undefined) throw noDictError(target, name, attribute);
  dict.set(name, value);
}

/** Assigns `__dict__`, which makes the dict itself hold the object's attributes from then on. */
function replaceDict(target: PyObject, value: PyValue): void {
  if (!(value instanceof PyDict)) {
    throw typeError(`__dict__ must be set to a dictionary, not a '${typeName(value)}'`);
  }
  const namespace = namespaceOf(value);
  if (target instanceof PyInstance) target.dict = namespace;
  else target.instanceDict = namespace;
}

/** Stores an attribute of a PyInstance once no descriptor took it, checking what its builtin class allows. */
function setInstanceDictEntry(target: PyInstance, name: string, value: PyValue, attribute: PyValue | undefined): void {
  const cls = target.cls;
  if (cls.slotNames !== undefined) throw noDictError(target, name, attribute);
  if (cls.flags.isDataclass && currentRuntime().isFrozenDataclass(cls)) {
    throw currentRuntime().frozenInstanceError(`cannot assign to field '${name}'`);
  }
  if (target.enumValue !== undefined && (name === 'name' || name === 'value')) {
    throw pyError('AttributeError', `<enum 'Enum'> cannot set attribute '${name}'`);
  }
  const state = target.exception;
  if (state && setExceptionField(state, name, value)) return;
  if (target.turtle && !cls.isBuiltin && attribute === undefined) {
    target.dict.set(name, value);
    return;
  }
  if (cls.isBuiltin && !state && !target.turtle) throw noDictError(target, name);
  target.dict.set(name, value);
}

/** Sets an attribute exceptions keep outside their dictionary, returning whether `name` is one. */
function setExceptionField(state: ExceptionState, name: string, value: PyValue): boolean {
  switch (name) {
    case '__cause__': {
      state.cause = value;
      state.suppressContext = true;
      return true;
    }
    case '__context__': {
      state.context = value;
      return true;
    }
    case '__suppress_context__': {
      state.suppressContext = value === true;
      return true;
    }
    case 'args': {
      state.args = newTuple(currentRuntime().toArray(value));
      return true;
    }
    case '__notes__': {
      state.notes = value as never;
      return true;
    }
    default: {
      return false;
    }
  }
}

function propertyName(property: PyDescriptor, fallback: string): string {
  const getter = property.fn;
  return getter instanceof PyFunction ? getter.name : fallback;
}

function noDictError(target: PyValue, name: string, attribute?: PyValue): Error {
  if (attribute !== undefined) {
    return pyError('AttributeError', `'${typeName(target)}' object attribute '${name}' is read-only`);
  }
  return pyError(
    'AttributeError',
    `'${typeName(target)}' object has no attribute '${name}' and no __dict__ for setting new attributes`
  );
}

export function deleteAttribute(target: PyValue, name: string): void {
  if (target instanceof PyInstance || isSubclassInstance(target)) {
    const custom = userHook(target as PyObject, '__delattr__');
    if (custom === undefined) deleteInstanceAttribute(target as PyObject, name);
    else callValue(bindValue(custom, target), [name]);
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

/** Deletes an instance attribute, honoring descriptors and slots, as `object.__delattr__` does. */
export function deleteInstanceAttribute(target: PyObject, name: string): void {
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
  if (isMember(attribute)) {
    deleteMember(attribute, target);
    return;
  }
  if (attribute !== undefined && callSetter(attribute, target, undefined)) return;
  if (target.cls.flags.isDataclass && currentRuntime().isFrozenDataclass(target.cls)) {
    throw currentRuntime().frozenInstanceError(`cannot delete field '${name}'`);
  }
  if (!ownDict(target)?.delete(name)) throw attributeError(target, name);
}
