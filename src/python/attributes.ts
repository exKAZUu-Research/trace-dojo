import { attributeError, bindValue, callValue, lookupSpecial } from './objects';
import { currentRuntime } from './runtimeContext';
import {
  classmethodClass,
  classOf,
  complexClass,
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
  PyBoundMethod,
  PyBuiltinFunction,
  PyClass,
  PyComplex,
  PyDescriptor,
  PyFunction,
  PyGenerator,
  PyInstance,
  PyModule,
  PyRange,
  PySlice,
  type PyValue,
} from './values';

/** Reads an attribute of a class: its own data, then the attributes of its MRO, bound as a class reads them. */
export function classAttribute(cls: PyClass, name: string): PyValue | undefined {
  const own = typeData(cls, name);
  if (own !== undefined) return own;
  const attribute = cls.lookup(name);
  if (attribute === undefined) {
    // Methods of the metaclass, such as `mro()`, bind to the class.
    const meta = typeClass.lookup(name);
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
      return cls.isBuiltin ? (cls.doc ?? None) : (cls.dict.get('__doc__') ?? None);
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
      return newDict(cls.dict.entries());
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
// code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of builtin object with attributes of its own.
export function specialAttribute(value: PyValue, name: string): PyValue | undefined {
  if (name === '__class__') return classOf(value);
  if (typeof value === 'bigint' || typeof value === 'boolean') return integerAttribute(BigInt(value), name);
  if (typeof value === 'number') return realPartAttribute(value, 0, name);
  if (typeof value === 'string') return undefined;
  if (value instanceof PyComplex && value.cls === complexClass) return realPartAttribute(value.real, value.imag, name);
  if (value instanceof PyFunction) return functionAttribute(value, name);
  if (value instanceof PyBoundMethod) return boundMethodAttribute(value, name);
  if (value instanceof PyBuiltinFunction) return builtinFunctionAttribute(value, name);
  if (value instanceof PyModule) return name === '__dict__' ? newDict(value.dict.entries()) : undefined;
  if (value instanceof PySlice || value instanceof PyRange) {
    return name === 'start' || name === 'stop' || name === 'step' ? value[name] : undefined;
  }
  if (value instanceof PyGenerator) return generatorAttribute(value, name);
  if (value instanceof PyInstance) return instanceAttribute(value, name);
  return undefined;
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
  if (name === '__self__') return fn.self ?? None;
  if (name === '__doc__') return None;
  return undefined;
}

function generatorAttribute(generator: PyGenerator, name: string): PyValue | undefined {
  if (name === '__name__') return generator.name;
  if (name === '__qualname__') return generator.qualifiedName;
  if (name === 'gi_running') return generator.running;
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
    case '__kwdefaults__': {
      return fn.keywordDefaults.size > 0 ? newDict(fn.keywordDefaults.entries()) : None;
    }
    case '__annotations__': {
      return currentRuntime().evaluator.annotationsOf(fn);
    }
    case '__dict__': {
      return newDict(fn.dict.entries());
    }
    default: {
      return undefined;
    }
  }
}

function instanceAttribute(instance: PyInstance, name: string): PyValue | undefined {
  if (name === '__dict__') return newDict(instance.dict.entries());
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
  if (is('OSError') && (name === 'errno' || name === 'strerror' || name === 'filename')) {
    if (args.length >= 2 && name !== 'filename') return name === 'errno' ? args[0] : args[1];
    return None;
  }
  return undefined;
}

// code-gauge-allow functionNcss 32 -- Follows the rules of attribute assignment for each kind of object.
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
    target.dict.set(name, value);
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
  if (classOf(target).lookup(name) !== undefined || specialAttribute(target, name) !== undefined) {
    throw pyError('AttributeError', `'${typeName(target)}' object attribute '${name}' is read-only`);
  }
  throw noDictError(target, name);
}

/** Stores an instance attribute, honoring properties and the special attributes of exceptions. */
// code-gauge-allow functionNcss 36 -- Follows the order CPython checks data descriptors, slots, and the instance dictionary in.
// code-gauge-allow functionCognitiveComplexity 23 -- Follows the order CPython checks data descriptors, slots, and the instance dictionary in.
export function setInstanceAttribute(target: PyInstance, name: string, value: PyValue): void {
  const cls = target.cls;
  const attribute = cls.lookup(name);
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
  if (cls.flags.isDataclass && currentRuntime().isFrozenDataclass(cls)) {
    throw currentRuntime().frozenInstanceError(`cannot assign to field '${name}'`);
  }
  if (target.enumValue !== undefined) {
    throw pyError('AttributeError', `cannot set '${name}' attribute of enum member`);
  }
  const state = target.exception;
  if (state) {
    if (name === '__cause__') {
      state.cause = value;
      state.suppressContext = true;
      return;
    }
    if (name === '__context__') {
      state.context = value;
      return;
    }
    if (name === '__suppress_context__') {
      state.suppressContext = value === true;
      return;
    }
    if (name === 'args') {
      state.args = newTuple(currentRuntime().toArray(value));
      return;
    }
    if (name === '__notes__') {
      state.notes = value as never;
      return;
    }
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
    if (target.cls.flags.isDataclass && currentRuntime().isFrozenDataclass(target.cls)) {
      throw currentRuntime().frozenInstanceError(`cannot delete field '${name}'`);
    }
    if (!target.dict.delete(name)) throw attributeError(target, name);
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
