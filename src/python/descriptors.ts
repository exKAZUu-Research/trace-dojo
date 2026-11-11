// The parts of attribute access that a program's own classes customize: descriptors, instance dictionaries outside
// PyInstance, and `__getattribute__`.
import { bindValue, callValue, getAttribute, lookupSpecial } from './objects';
import { instancesHaveDict } from './slots';
import { classOf, objectClass, pyError } from './types';
import { PyClass, PyError, PyFunction, PyInstance, PyObject, type PyValue } from './values';

/** The `__get__` of an attribute whose class the program defined, or undefined for any other attribute. */
export function descriptorGetter(attribute: PyValue): PyValue | undefined {
  if (!(attribute instanceof PyObject) || attribute.cls.isBuiltin) return undefined;
  return attribute.cls.lookup('__get__');
}

/** Whether an attribute of a program's class defines `__set__` or `__delete__`, which takes it over instance dicts. */
export function isDataDescriptor(attribute: PyValue): boolean {
  if (!(attribute instanceof PyObject) || attribute.cls.isBuiltin) return false;
  return attribute.cls.lookup('__set__') !== undefined || attribute.cls.lookup('__delete__') !== undefined;
}

/** `obj.__class__` as builtin objects answer it, or undefined when the program's class defines `__class__` itself. */
export function builtinClassAttribute(value: PyValue): PyClass | undefined {
  const defined = value instanceof PyInstance && !value.cls.isBuiltin && value.cls.lookup('__class__') !== undefined;
  return defined ? undefined : classOf(value);
}

/** The class an instance's own `__class__` attribute claims, as `unittest.mock`'s spec'd mocks do, when not its type. */
export function claimedClass(value: PyValue): PyClass | undefined {
  if (builtinClassAttribute(value) !== undefined) return undefined;
  const claimed = getAttribute(value, '__class__');
  return claimed instanceof PyClass && claimed !== classOf(value) ? claimed : undefined;
}

/** Calls a descriptor's `__get__` for an instance, or for a class when `instance` is None. */
export function callGetter(getter: PyValue, attribute: PyValue, instance: PyValue, owner: PyClass): PyValue {
  return callValue(bindValue(getter, attribute), [instance, owner]);
}

/** Calls a descriptor's `__set__`, or `__delete__` when `value` is undefined, raising AttributeError without it. */
export function callSetter(attribute: PyValue, instance: PyValue, value: PyValue | undefined): boolean {
  if (!isDataDescriptor(attribute)) return false;
  const name = value === undefined ? '__delete__' : '__set__';
  const method = lookupSpecial(attribute, name);
  if (method === undefined) throw pyError('AttributeError', name);
  callValue(bindValue(method, attribute), value === undefined ? [instance] : [instance, value]);
  return true;
}

/** The builtin classes whose instances take attributes all the same, as `functools.partial` objects do. */
export const builtinClassesWithDict = new Set<PyClass>();

/** The dictionary of an object's own attributes, or undefined for an object without one. */
export function ownDict(value: PyValue): Map<string, PyValue> | undefined {
  if (value instanceof PyInstance) return value.cls.slotNames === undefined ? value.dict : undefined;
  if (typeof value !== 'object') return undefined;
  if (value instanceof PyFunction) return value.dict;
  if (!(value instanceof PyObject)) return undefined;
  if (value.cls.isBuiltin ? !builtinClassesWithDict.has(value.cls) : !instancesHaveDict(value.cls)) return undefined;
  value.instanceDict ??= new Map();
  return value.instanceDict;
}

/** Whether a program assigned `__getattribute__` to a class, which class bodies' flags do not record. */
let getattributeAssigned = false;

export function noteGetattributeAssigned(): void {
  getattributeAssigned = true;
}

/** A `__getattribute__` that a program's class defines in place of `object`'s, or undefined. */
export function customGetattribute(value: PyValue): PyValue | undefined {
  const cls = classOf(value);
  if (cls.isBuiltin || !(cls.flags.definesGetattribute || getattributeAssigned)) return undefined;
  const method = cls.lookup('__getattribute__');
  return method === objectClass.dict.get('__getattribute__') ? undefined : method;
}

/** Reads an attribute with a program's `__getattribute__`, falling back to its `__getattr__` on AttributeError. */
export function getWithCustomGetattribute(value: PyValue, name: string, method: PyValue): PyValue {
  try {
    return callValue(bindValue(method, value), [name]);
  } catch (error) {
    const getattr = lookupSpecial(value, '__getattr__');
    if (getattr === undefined || !isAttributeError(error)) throw error;
    return callValue(bindValue(getattr, value), [name]);
  }
}

function isAttributeError(error: unknown): boolean {
  return (
    error instanceof PyError && error.exception.cls.mro.some((cls) => cls.isBuiltin && cls.name === 'AttributeError')
  );
}
