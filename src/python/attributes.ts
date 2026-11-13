// code-gauge-allow-file fileNcss 661 -- The attribute lookup keeps the special attributes of every builtin kind of object together.
import {
  classAnnotate,
  classAnnotations,
  functionAnnotate,
  functionAnnotations,
  implicitlyWrapped,
  setClassAnnotate,
  setClassAnnotations,
  setFunctionAnnotationAttribute,
  sharedPythonClasses,
} from './annotations';
import { attributeDescriptorField, PyAttribute } from './attributeDescriptors';
import { builtinDoc, builtinTextSignature, builtinTypeImmutable } from './builtinDocs';
import { setClassBases, solidBase } from './classes';
import { pyRepr } from './conversions';
import {
  builtinClassesWithDict,
  callGetter,
  callSetter,
  descriptorGetter,
  ensureThreadLocalDict,
  isDataDescriptor,
  isThreadLocal,
  noteGetattributeAssigned,
  ownDict,
} from './descriptors';
import { enumClassData, enumMemberData, membersByName } from './enums';
import type { Frame } from './frame';
import { delegateOf } from './generators';
import { hasPythonLevelNew } from './instances';
import { builtinFunctionModule } from './modules';
import { completeNamespace } from './modules/moduleLayout';
import { checkNamespaceListing } from './namespaceDifferences';
import { namespaceDict, namespaceOf } from './namespaces';
import {
  attributeError,
  attributeName,
  bindValue,
  callValue,
  getAttribute,
  getAttributeOrUndefined,
  lookupSpecial,
} from './objects';
import { currentRuntime } from './runtimeContext';
import { instancesHaveDict } from './slots';
import { runSubclasses } from './subclasses';
import { codeObject, frameObject, functionCode, setTraceback } from './tracebacks';
import { typeFlags } from './typeFlags';
import {
  builtinFunctionClass,
  classmethodClass,
  classOf,
  descriptorOwners,
  isNativeMethod,
  isPropertyKind,
  newDict,
  newTuple,
  None,
  objectClass,
  pyError,
  staticmethodClass,
  stringValue,
  tupleGetterClass,
  typeClass,
  typeError,
  typeName,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import {
  type ExceptionState,
  PyBoundMethod,
  PyBuiltinFunction,
  PyClass,
  PyComplex,
  PyDescriptor,
  PyDict,
  PyError,
  PyFunction,
  PyGenerator,
  PyInstance,
  PyModule,
  PyObject,
  PyRange,
  PySlice,
  PyTuple,
  type PyValue,
} from './values';
import { weakReferenceOf } from './weakReferences';

export const BUILTIN_DOC = '組み込みの関数・型・モジュールの説明文（__doc__）';

/** Reads an attribute of a class: its own data, then the attributes of its MRO, bound as a class reads them. */
export function classAttribute(cls: PyClass, name: string, key = name): PyValue | undefined {
  const meta = cls.cls;
  const metaAttribute = meta === typeClass ? undefined : meta.lookup(key);
  if (
    metaAttribute !== undefined &&
    metaAttribute !== typeClass.dict.get(name) &&
    isMetaDataDescriptor(metaAttribute)
  ) {
    return bindToClass(metaAttribute, cls);
  }
  const own = typeData(cls, name) ?? (cls.flags.isEnum ? enumClassData(cls, name) : undefined);
  if (own !== undefined) return own;
  if (metaAttribute !== undefined && isMetaDataDescriptor(metaAttribute)) return bindToClass(metaAttribute, cls);
  const attribute = cls.lookup(key);
  if (attribute === undefined) {
    // Methods of the metaclass, such as `mro()`, bind to the class.
    if (metaAttribute !== undefined) return bindToClass(metaAttribute, cls);
    const typeAttribute = typeClass.lookup(name);
    return typeAttribute === undefined ? undefined : bindToClass(typeAttribute, cls);
  }
  return boundClassAttribute(cls, name, attribute);
}

/** An attribute a class found in its MRO, bound as a class reads it. */
function boundClassAttribute(cls: PyClass, name: string, attribute: PyValue): PyValue {
  const getter = descriptorGetter(attribute);
  // `type` and its subclasses are instances of type, whose own getsets, such as `__abstractmethods__`, apply to them.
  if (getter !== undefined && attribute === typeClass.dict.get(name) && cls.isSubclassOf(typeClass)) {
    return callGetter(getter, attribute, cls, cls.cls);
  }
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
  return (attribute instanceof PyDescriptor && isPropertyKind(attribute.cls)) || isDataDescriptor(attribute);
}

// code-gauge-allow functionNcss 34 -- One case per attribute a class keeps outside its dictionary.
export function typeData(cls: PyClass, name: string): PyValue | undefined {
  switch (name) {
    case '__name__': {
      return cls.nameValue ?? cls.name;
    }
    case '__qualname__': {
      return cls.qualifiedNameValue ?? cls.qualifiedName;
    }
    case '__module__': {
      return (!cls.isBuiltin ? cls.dict.get('__module__') : undefined) ?? cls.module;
    }
    case '__flags__': {
      return BigInt(typeFlags(cls));
    }
    case '__doc__': {
      return cls.isBuiltin ? (cls.doc ?? builtinDoc(cls) ?? None) : (cls.dict.get('__doc__') ?? None);
    }
    case '__text_signature__': {
      return (cls.isBuiltin && builtinTextSignature(cls)) || None;
    }
    case '__mro__': {
      return newTuple(cls.mro);
    }
    case '__bases__': {
      return newTuple(cls.bases);
    }
    case '__type_params__': {
      // type.__type_params__ reads the class's own entry, which for a builtin type may be its objects' descriptor.
      return (cls === typeClass ? undefined : cls.dict.get('__type_params__')) ?? newTuple([]);
    }
    case '__base__': {
      return cls.bases[0] ?? None;
    }
    case '__class__': {
      return cls.cls;
    }
    case '__dict__': {
      checkNamespaceListing(cls, 'クラスの __dict__・vars()');
      // A read-only view of the class's own namespace, as CPython's mappingproxy.
      const types = currentRuntime().importModule('types');
      return callValue(types.dict.get('MappingProxyType') as PyValue, [namespaceDict(cls.dict)]);
    }
    case '__annotations__': {
      return cls.isBuiltin && !sharedPythonClasses.has(cls) ? undefined : classAnnotations(cls);
    }
    case '__annotate__': {
      return cls.isBuiltin && !sharedPythonClasses.has(cls) ? undefined : classAnnotate(cls);
    }
    default: {
      return undefined;
    }
  }
}

/** `obj.__class__`, or undefined when a program's class defines `__class__`, as `unittest.mock`'s spec'd mocks do. */
function ownClassAttribute(value: PyValue): PyValue | undefined {
  const defines =
    value instanceof PyInstance &&
    !value.cls.isBuiltin &&
    value.cls.lookup('__class__') !== objectClass.dict.get('__class__');
  return defines ? undefined : classOf(value);
}

/** The attributes builtin objects have of their own, outside any class dictionary. */
// code-gauge-allow functionCognitiveComplexity 26 -- One case per kind of builtin object with attributes of its own.
// code-gauge-allow functionNcss 37 -- One case per kind of builtin object with attributes of its own.
export function specialAttribute(value: PyValue, name: string): PyValue | undefined {
  if (name === '__class__') return ownClassAttribute(value);
  if (typeof value === 'bigint' || typeof value === 'boolean') return integerAttribute(BigInt(value), name);
  if (typeof value === 'number') return realPartAttribute(value, 0, name);
  if (typeof value === 'string') return undefined;
  // No other kind of object checked below is a PyInstance.
  if (value instanceof PyInstance) return instanceAttribute(value, name);
  if (value instanceof PyComplex) return realPartAttribute(value.real, value.imag, name);
  if (value instanceof PyFunction) return functionAttribute(value, name);
  if (value instanceof PyBoundMethod) return boundMethodAttribute(value, name);
  if (value instanceof PyBuiltinFunction) return builtinFunctionAttribute(value, name);
  if (value instanceof PyModule) {
    if (name !== '__dict__') return undefined;
    completeNamespace(value);
    return namespaceDict(value.dict);
  }
  if (value instanceof PySlice || value instanceof PyRange) {
    return name === 'start' || name === 'stop' || name === 'step' ? value[name] : undefined;
  }
  if (value instanceof PyGenerator) return generatorAttribute(value, name);
  if (value instanceof PyDescriptor) return wrappedFunction(value, name);
  if (value instanceof PyAttribute) {
    if (name === '__doc__') return value.doc ?? builtinDoc(value) ?? None;
    return attributeDescriptorField(value, name);
  }
  if (name === '__dict__' && value instanceof PyObject && (!value.cls.isBuiltin || isThreadLocal(value)))
    return dictAttribute(value);
  return undefined;
}

/** The attributes of its function that a staticmethod or classmethod copies into its own namespace. */
const WRAPPER_COPIES = new Set(['__name__', '__qualname__', '__module__']);

function wrapperCopy(descriptor: PyDescriptor, name: string): PyValue | undefined {
  if (implicitlyWrapped.has(descriptor)) return undefined;
  try {
    return getAttribute(descriptor.fn, name);
  } catch (error) {
    if (error instanceof PyError) return undefined;
    throw error;
  }
}

/** The function a staticmethod or classmethod wraps, as its `__func__` and `__wrapped__` give it. */
function wrappedFunction(descriptor: PyDescriptor, name: string): PyValue | undefined {
  if (name === '__doc__' && isPropertyKind(descriptor.cls)) return propertyDoc(descriptor);
  const wraps = descriptor.cls.isSubclassOf(staticmethodClass) || descriptor.cls.isSubclassOf(classmethodClass);
  if (wraps && WRAPPER_COPIES.has(name)) return wrapperCopy(descriptor, name);
  if (name !== '__func__' && name !== '__wrapped__') return undefined;
  return wraps ? descriptor.fn : undefined;
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
  // As CPython's method_getattro does, a method reads the other attributes of its function.
  if (method.fn instanceof PyFunction) return getAttributeOrUndefined(method.fn, name);
  return undefined;
}

function builtinFunctionAttribute(fn: PyBuiltinFunction, name: string): PyValue | undefined {
  if (name === '__name__') return fn.name;
  if (name === '__qualname__') return fn.qualifiedName;
  if (name === '__self__') {
    // A static method such as `str.maketrans` shows its type in its repr but has no `__self__`, unlike `__new__`.
    if (fn.binding === 'static' && fn.name !== '__new__') return None;
    if (fn.self instanceof PyClass && hasPythonLevelNew(fn.self)) return None;
    return fn.self ?? (fn.cls === builtinFunctionClass ? moduleOf(fn) : undefined);
  }
  if (name === '__objclass__') return descriptorOwners.get(fn);
  if (name === '__doc__') return builtinDoc(fn) ?? None;
  if (name === '__text_signature__') return builtinTextSignature(fn) ?? None;
  if (name === '__module__') return builtinFunctionModule(currentRuntime(), fn) ?? None;
  return undefined;
}

/** The module a builtin function without a bound object belongs to, which its `__self__` gives. */
function moduleOf(fn: PyBuiltinFunction): PyValue {
  const runtime = currentRuntime();
  if (runtime.builtins.get(fn.name) === fn) return runtime.importModule('builtins');
  // A function of a C accelerator, as `operator.add` is of `_operator`, belongs to it.
  const owner = runtime.modules.get(builtinFunctionModule(runtime, fn) ?? '');
  if (owner?.dict.get(fn.name) === fn) return owner;
  for (const module of runtime.modules.values()) if (module.dict.get(fn.name) === fn) return module;
  return None;
}

/** The prefix of the attributes of each kind of generator object, such as `cr_running` of a coroutine. */
const GENERATOR_PREFIXES: Record<string, string> = { coroutine: 'cr_', async_generator: 'ag_' };

// code-gauge-allow functionCognitiveComplexity 19 -- One case per attribute of CPython's generator getset table.
function generatorAttribute(generator: PyGenerator, attribute: string): PyValue | undefined {
  if (attribute === '__name__') return generator.name;
  if (attribute === '__qualname__') return generator.qualifiedName;
  const prefix = GENERATOR_PREFIXES[generator.cls.name] ?? 'gi_';
  if (!attribute.startsWith(prefix)) return undefined;
  const name = `gi_${attribute.slice(prefix.length)}`;
  if (name === 'gi_origin' && prefix === 'cr_') return None;
  if (name === 'gi_running') return generator.running;
  if (name === 'gi_suspended') return generator.started && !generator.running && !generator.finished;
  const frame = generator.frame as Frame | undefined;
  if (name === 'gi_frame') return generator.finished || !frame ? None : frameObject(frame);
  if (name === 'gi_code' && frame) return codeObject(frame);
  // A generator's `gi_yieldfrom` is what a coroutine and an async generator call `cr_await` and `ag_await`.
  if (name === (prefix === 'gi_' ? 'gi_yieldfrom' : 'gi_await')) {
    return (frame && !generator.finished && delegateOf(frame)) || None;
  }
  return undefined;
}

function functionAttribute(fn: PyFunction, name: string): PyValue | undefined {
  switch (name) {
    case '__name__': {
      return fn.nameValue ?? fn.name;
    }
    case '__qualname__': {
      return fn.qualifiedNameValue ?? fn.qualifiedName;
    }
    case '__doc__': {
      return fn.doc ?? fn.dict.get('__doc__') ?? fn.def.doc ?? None;
    }
    case '__module__': {
      return fn.module;
    }
    case '__code__': {
      return functionCode(fn);
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
      return functionAnnotations(fn);
    }
    case '__annotate__': {
      return functionAnnotate(fn);
    }
    case '__dict__': {
      return namespaceDict(fn.dict);
    }
    default: {
      return undefined;
    }
  }
}

// code-gauge-allow functionNcss 37 -- One case per attribute an instance of a builtin class keeps outside its dictionary.
function instanceAttribute(instance: PyInstance, name: string): PyValue | undefined {
  if (name === '__dict__') return dictAttribute(instance);
  if (name === '__weakref__' && instance.cls.lookup('__weakref__') !== undefined)
    return weakReferenceOf(instance) ?? None;
  if (instance.primitive !== undefined) return specialAttribute(instance.primitive, name);
  if (instance.enumValue !== undefined) {
    if (name === 'value' || name === '_value_') return instance.enumValue;
    if (name === 'name' || name === '_name_') return instance.dict.get('_name_');
    const member = enumMemberData(instance, name);
    if (member !== undefined) return member;
  }
  const state = instance.exception;
  if (!state) return undefined;
  switch (name) {
    case 'args': {
      return state.args;
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
      return state.traceback ?? None;
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

/** The fields some builtin exceptions keep outside their dictionary, initialized from their arguments. */
function exceptionFieldOf(instance: PyInstance, name: string): PyValue | undefined {
  const state = instance.exception;
  if (!state) return undefined;
  const stored = state.fields?.get(name);
  if (stored !== undefined) return stored;
  if (name === 'name' && state.name !== undefined) return state.name;
  if (name === 'obj' && state.object !== undefined) return state.object;
  return undefined;
}

// code-gauge-allow functionCognitiveComplexity 28 -- One case per writable attribute a function keeps outside its dictionary.
// code-gauge-allow functionNcss 38 -- One case per writable attribute a function keeps outside its dictionary.
function setFunctionAttribute(fn: PyFunction, name: string, value: PyValue, nameValue: PyValue = name): void {
  if (name === '__globals__' || name === '__closure__' || name === '__builtins__') {
    throw pyError('AttributeError', 'readonly attribute');
  }
  if (name === '__annotations__' || name === '__annotate__') setFunctionAnnotationAttribute(fn, name, value);
  else if (name === '__name__' || name === '__qualname__') setFunctionName(fn, name, value);
  else if (name === '__module__') fn.module = value;
  else if (name === '__doc__') fn.doc = value;
  else if (name === '__defaults__') {
    if (value !== None && !(value instanceof PyTuple)) throw typeError('__defaults__ must be set to a tuple object');
    fn.defaults = value instanceof PyTuple ? [...value.items] : [];
  } else if (name === '__kwdefaults__') {
    if (value !== None && !(value instanceof PyDict)) throw typeError('__kwdefaults__ must be set to a dict object');
    fn.keywordDefaults = new Map(
      value instanceof PyDict ? value.store.ordered().map((entry) => [entry.key as string, entry.value]) : []
    );
  } else if (name === '__type_params__') {
    if (!(value instanceof PyTuple)) throw typeError('__type_params__ must be set to a tuple');
    fn.typeParams = [...value.items];
  } else storeNamedAttribute(fn.dict, nameValue, value);
}

export function setAttribute(target: PyValue, nameValue: PyValue, value: PyValue): void {
  const name = attributeName(nameValue);
  currentRuntime().spend();
  if (takesInstanceAttributes(target)) {
    const custom = userHook(target as PyObject, '__setattr__');
    if (custom === undefined) setInstanceAttribute(target as PyObject, name, value, nameValue);
    else callValue(bindValue(custom, target), [nameValue, value]);
    return;
  }
  if (target instanceof PyClass) {
    setClassAttribute(target, name, value, true, nameValue);
    return;
  }
  if (target instanceof PyFunction) {
    setFunctionAttribute(target, name, value, nameValue);
    return;
  }
  if (target instanceof PyModule) {
    storeNamedAttribute(target.dict, nameValue, value);
    target.unsupported.delete(name);
    target.imports.delete(name);
    return;
  }
  if (target instanceof PyDescriptor && isPropertyKind(target.cls) && name === '__doc__') {
    target.doc = value;
    return;
  }
  assignBuiltinAttribute(target, name, value);
}

/** Whether assigning an attribute of `target` follows the rules of instances, as opposed to classes or modules. */
function takesInstanceAttributes(target: PyValue): boolean {
  return (
    target instanceof PyInstance ||
    isSubclassInstance(target) ||
    isThreadLocal(target) ||
    (target instanceof PyObject && builtinClassesWithDict.has(target.cls))
  );
}

/** Assigns or deletes an attribute of an object of a builtin type, which only its data descriptors take. */
function assignBuiltinAttribute(target: PyValue, name: string, value: PyValue | undefined): void {
  const attribute = classOf(target).lookup(name);
  if (!(attribute instanceof PyAttribute) || attribute.stands) throw readOnlyError(target, name);
  attribute.assign(target, value);
}

/** The AttributeError for assigning to an attribute of an object of a builtin type, which has no `__dict__`. */
function readOnlyError(target: PyValue, name: string): Error {
  const attribute = classOf(target).lookup(name);
  if (attribute instanceof PyDescriptor && attribute.cls === tupleGetterClass) {
    return pyError('AttributeError', "can't set attribute");
  }
  if (attribute instanceof PyDescriptor && isPropertyKind(attribute.cls) && attribute.fn instanceof PyBuiltinFunction) {
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

// code-gauge-allow functionCognitiveComplexity 21 -- Class metadata keeps string data and original objects together; splitting these cases only moves their complexity.
function setClassAttribute(
  target: PyClass,
  name: string,
  value: PyValue,
  callsHook = true,
  nameValue: PyValue = name
): void {
  refuseSharedClass(target);
  if (target.isBuiltin) throw typeError(`cannot set '${name}' attribute of immutable type '${target.name}'`);
  if (setClassAttributeThroughMeta(target, name, value, callsHook, nameValue)) return;
  if (name === '__getattribute__') noteGetattributeAssigned();
  // Instances created from now on are tracked; CPython also finalizes the existing ones, which this grader does not.
  if (name === '__del__') markDefinesDel(target);
  if (membersByName(target).has(name)) {
    throw pyError('AttributeError', `cannot reassign member '${name}'`);
  }
  if (name === '__name__' || name === '__qualname__') {
    const previous = name === '__name__' ? target.nameValue : target.qualifiedNameValue;
    const text = stringValue(value);
    if (text === undefined) {
      throw typeError(`can only assign string to ${target.name}.${name}, not '${typeName(value)}'`);
    }
    if (name === '__name__') {
      (target as { name: string }).name = text;
      target.nameValue = typeof value === 'string' ? undefined : value;
    } else {
      target.qualifiedName = text;
      target.qualifiedNameValue = typeof value === 'string' ? undefined : value;
    }
    currentRuntime().finalizer.release([previous], [target, value]);
    return;
  }
  if (name === '__module__') target.module = stringValue(value) ?? target.module;
  storeClassAttribute(target, name, value, nameValue);
}

/** Records that a class and the subclasses the run created so far define `__del__`, which their instances inherit. */
function markDefinesDel(cls: PyClass): void {
  cls.flags.definesDel = true;
  for (const [subclass] of runSubclasses(currentRuntime(), cls)) markDefinesDel(subclass);
}

/** Stores a class attribute: the ones type's getsets keep outside the class's dictionary, or in it. */
function storeClassAttribute(target: PyClass, name: string, value: PyValue, nameValue: PyValue): void {
  if (name === '__bases__') setClassBases(target, value);
  else if (name === '__annotations__') setClassAnnotations(target, value);
  else if (name === '__annotate__') setClassAnnotate(target, value);
  else storeNamedAttribute(target.dict, nameValue, value);
}

/** Whether a value is an instance of a program's subclass of a builtin type other than object, such as list. */
function isSubclassInstance(value: PyValue): boolean {
  return value instanceof PyObject && !(value instanceof PyClass) && !value.cls.isBuiltin;
}

/** Whether attribute assignment on a value follows the rules of instances, as opposed to classes or modules. */
export function isInstanceWithAttributes(value: PyValue): boolean {
  return value instanceof PyInstance || isSubclassInstance(value) || isThreadLocal(value);
}

/** `type.__setattr__`: sets a class attribute as a metaclass's `__setattr__` does when it defers to `type`'s. */
export function setClassAttributeWithoutHook(
  target: PyClass,
  name: string,
  value: PyValue,
  nameValue: PyValue = name
): void {
  setClassAttribute(target, name, value, false, nameValue);
}

/** Sets a class attribute through its metaclass's `__setattr__` or data descriptor, returning whether one did. */
function setClassAttributeThroughMeta(
  target: PyClass,
  name: string,
  value: PyValue,
  callsHook: boolean,
  nameValue: PyValue
): boolean {
  const meta = target.cls;
  if (meta.isBuiltin) return false;
  const custom = callsHook ? meta.lookup('__setattr__') : undefined;
  if (custom !== undefined && !(custom instanceof PyBuiltinFunction)) {
    callValue(bindValue(custom, target), [nameValue, value]);
    return true;
  }
  const attribute = meta.lookup(name);
  if (attribute instanceof PyDescriptor && isPropertyKind(attribute.cls)) {
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
  // CPython finalizes the object by its class when freed, so an object taking a class with `__del__` is watched.
  if (value.flags.definesDel && !target.cls.flags.definesDel) currentRuntime().finalizer.watch(target);
  target.cls = value;
}

function setProperty(property: PyDescriptor, target: PyObject, name: string, value: PyValue): void {
  if (property.cls === tupleGetterClass) throw pyError('AttributeError', "can't set attribute");
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
export function setInstanceAttribute(target: PyObject, name: string, value: PyValue, nameValue: PyValue = name): void {
  if (isThreadLocal(target)) {
    ensureThreadLocalDict(target);
    if (name === '__dict__') throw readOnlyError(target, name);
  }
  if (name === '__class__') {
    setClassOf(target, value);
    return;
  }
  if (name === '__dict__' && ownDict(target) !== undefined) {
    replaceDict(target, value);
    return;
  }
  const attribute = target.cls.lookup(name);
  if (attribute instanceof PyAttribute && !attribute.stands) {
    attribute.assign(target, value);
    return;
  }
  if (attribute instanceof PyDescriptor && isPropertyKind(attribute.cls)) {
    setProperty(attribute, target, name, value);
    return;
  }
  if (attribute !== undefined && callSetter(attribute, target, value)) return;
  if (target instanceof PyInstance) {
    setInstanceDictEntry(target, name, value, attribute, nameValue);
    return;
  }
  const dict = ownDict(target);
  if (dict === undefined) throw noDictError(target, name, attribute);
  storeNamedAttribute(dict, nameValue, value);
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
function setInstanceDictEntry(
  target: PyInstance,
  name: string,
  value: PyValue,
  attribute: PyValue | undefined,
  nameValue: PyValue
): void {
  const cls = target.cls;
  if (cls.slotNames !== undefined) throw noDictError(target, name, attribute);
  if (target.enumValue !== undefined) {
    if (name === 'name' || name === 'value') {
      throw pyError('AttributeError', `<enum 'Enum'> cannot set attribute '${name}'`);
    }
    if (name === '_value_') {
      target.enumValue = value;
      return;
    }
  }
  const state = target.exception;
  if (state && setExceptionField(state, name, value)) return;
  if (target.turtle && !cls.isBuiltin && attribute === undefined) {
    storeNamedAttribute(target.dict, nameValue, value);
    return;
  }
  if (cls.isBuiltin && !state && !target.turtle && !builtinClassesWithDict.has(cls)) throw noDictError(target, name);
  storeNamedAttribute(target.dict, nameValue, value);
}

const UNDELETABLE_EXCEPTION_ATTRIBUTES = new Set([
  'args',
  '__traceback__',
  '__cause__',
  '__context__',
  '__suppress_context__',
]);

/** Assigns, or deletes when `value` is undefined, an attribute that an exception's class lists as a descriptor. */
export function assignExceptionAttribute(target: PyValue, name: string, value: PyValue | undefined): void {
  const instance = target as PyInstance;
  if (value === undefined) {
    if (UNDELETABLE_EXCEPTION_ATTRIBUTES.has(name)) throw typeError(`${name} may not be deleted`);
    assignExceptionAttribute(target, name, None);
    return;
  }
  if (instance.exception && setExceptionField(instance.exception, name, value)) return;
  instance.dict.set(name, value);
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
    case '__traceback__': {
      setTraceback(state, value);
      return true;
    }
    case 'args': {
      state.args = newTuple(currentRuntime().toArray(value));
      return true;
    }
    default: {
      return setKeywordField(state, name, value);
    }
  }
}

/** Sets a field an exception's keyword arguments set, such as ImportError's `path`, returning whether it has it. */
function setKeywordField(state: ExceptionState, name: string, value: PyValue): boolean {
  const known = state.fields?.has(name) ?? false;
  if (!known && !(name === 'name' && state.name !== undefined) && !(name === 'obj' && state.object !== undefined))
    return false;
  (state.fields ??= new Map()).set(name, value);
  if (name === 'name') state.name = stringValue(value);
  if (name === 'obj') state.object = value;
  return true;
}

/**
 * Refuses mutations CPython allows on library classes shared across runs, which would leak between programs.
 */
function refuseSharedClass(target: PyClass): void {
  if (sharedPythonClasses.has(target) || (target.isBuiltin && builtinTypeImmutable(target) === false)) {
    throw new UnsupportedFeatureError(`標準ライブラリのクラス ${target.module}.${target.name} の属性の書き換え`);
  }
}

/** `type.__delattr__`: deletes a class attribute without its metaclass's `__delattr__`. */
export function deleteClassAttribute(target: PyClass, name: string, nameValue: PyValue = name): void {
  refuseSharedClass(target);
  // CPython words deleting as it does assigning.
  if (target.isBuiltin) throw typeError(`cannot set '${name}' attribute of immutable type '${target.name}'`);
  if (membersByName(target).has(name)) {
    throw pyError('AttributeError', `${pyRepr(target.name)} cannot delete member ${pyRepr(name)}.`);
  }
  if (name === '__annotations__') setClassAnnotations(target, undefined);
  else if (!target.dict.delete(nameValue as string)) throw attributeError(target, name);
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

// code-gauge-allow functionCognitiveComplexity 22 -- Follows the order object.__delattr__ tries data descriptors, special stores, and the instance dict in.
export function deleteAttribute(target: PyValue, nameValue: PyValue): void {
  const name = attributeName(nameValue);
  currentRuntime().spend();
  if (takesInstanceAttributes(target)) {
    const custom = userHook(target as PyObject, '__delattr__');
    if (custom === undefined) deleteInstanceAttribute(target as PyObject, name, nameValue);
    else callValue(bindValue(custom, target), [nameValue]);
    return;
  }
  if (target instanceof PyClass) {
    const custom = target.cls.isBuiltin ? undefined : target.cls.lookup('__delattr__');
    if (custom === undefined || custom instanceof PyBuiltinFunction) deleteClassAttribute(target, name, nameValue);
    else callValue(bindValue(custom, target), [nameValue]);
    return;
  }
  if (target instanceof PyFunction && (name === '__annotations__' || name === '__annotate__')) {
    setFunctionAnnotationAttribute(target, name, undefined);
    return;
  }
  if (target instanceof PyFunction && name === '__doc__') {
    target.doc = None;
    return;
  }
  if (target instanceof PyFunction || target instanceof PyModule) {
    if (!deleteNamespaceEntry(target, name, nameValue)) throw attributeError(target, name);
    return;
  }
  // Deleting an attribute of a builtin type's object fails as assigning it does.
  assignBuiltinAttribute(target, name, undefined);
}

/** Deletes a function's or module's attribute, including a module's not yet imported or unsupported names. */
function deleteNamespaceEntry(target: PyFunction | PyModule, name: string, nameValue: PyValue): boolean {
  if (target.dict.delete(nameValue as string)) return true;
  return target instanceof PyModule && (target.imports.delete(name) || target.unsupported.delete(name));
}

/** Deletes an instance attribute, honoring descriptors and slots, as `object.__delattr__` does. */
// code-gauge-allow functionCognitiveComplexity 19 -- Honors native descriptors, properties, user descriptors, enum members, and own dict.
export function deleteInstanceAttribute(target: PyObject, name: string, nameValue: PyValue = name): void {
  if (isThreadLocal(target)) {
    ensureThreadLocalDict(target);
    if (name === '__dict__') throw readOnlyError(target, name);
  }
  const attribute = target.cls.lookup(name);
  if (attribute instanceof PyAttribute && !attribute.stands) {
    attribute.assign(target, undefined);
    return;
  }
  if (attribute instanceof PyDescriptor && isPropertyKind(attribute.cls)) {
    if (attribute.cls === tupleGetterClass) throw pyError('AttributeError', "can't delete attribute");
    if (attribute.deleter === undefined || attribute.deleter === None) {
      throw pyError(
        'AttributeError',
        `property '${propertyName(attribute, name)}' of '${target.cls.name}' object has no deleter`
      );
    }
    callValue(attribute.deleter, [target]);
    return;
  }
  if (attribute !== undefined && callSetter(attribute, target, undefined)) return;
  if (target instanceof PyInstance && target.enumValue !== undefined && (name === 'name' || name === 'value')) {
    throw pyError('AttributeError', `<enum 'Enum'> cannot delete attribute '${name}'`);
  }
  const dict = ownDict(target);
  if (dict === undefined) throw noDictError(target, name, attribute);
  if (!dict.delete(nameValue as string)) throw attributeError(target, name);
}

function storeNamedAttribute(namespace: Map<string, PyValue>, name: PyValue, value: PyValue): void {
  if (typeof name === 'string') namespace.set(name, value);
  else namespaceDict(namespace).store.set(name, value);
}

function setFunctionName(fn: PyFunction, field: '__name__' | '__qualname__', value: PyValue): void {
  const text = stringValue(value);
  if (text === undefined) throw typeError(`${field} must be set to a string object`);
  const original = typeof value === 'string' ? undefined : value;
  if (field === '__name__') {
    fn.name = text;
    fn.nameValue = original;
  } else {
    fn.qualifiedName = text;
    fn.qualifiedNameValue = original;
  }
}
