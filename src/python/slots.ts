import { PyAttribute } from './attributeDescriptors';
import { toArray } from './objects';
import { intClass, pyError, tupleClass, typeError, typeName, valueError } from './types';
import { type PyClass, type PyObject, type PyValue } from './values';

/** Whether a class attribute is a slot's descriptor. */
export function isMember(value: PyValue | undefined): value is PyAttribute {
  return value instanceof PyAttribute && value.isMember;
}

/** The descriptor of a slot, which stores an attribute of the class's instances outside any `__dict__`. */
function slotMember(name: string, cls: PyClass): PyAttribute {
  const missing = (instance: PyValue): Error =>
    pyError('AttributeError', `'${typeName(instance)}' object has no attribute '${name}'`);
  return new PyAttribute(
    'member',
    name,
    cls,
    (instance) => {
      const value = (instance as PyObject).slotValues?.get(name);
      if (value === undefined) throw missing(instance);
      return value;
    },
    (instance, value) => {
      const object = instance as PyObject;
      if (value !== undefined) (object.slotValues ??= new Map()).set(name, value);
      else if (!object.slotValues?.delete(name)) throw missing(instance);
    }
  );
}

/**
 * Reads a new class's `__slots__`, adding a descriptor to its namespace for each slot, and returns the names it
 * declares, or undefined when it declares none.
 */
// code-gauge-allow functionCognitiveComplexity 19 -- Follows the checks of CPython's type_new_slots.
export function defineClassSlots(cls: PyClass, entries: Map<string, PyValue>): string[] | undefined {
  const declared = entries.get('__slots__');
  if (declared === undefined) return undefined;
  const names = typeof declared === 'string' ? [declared] : toArray(declared);
  const result: string[] = [];
  for (const name of names) {
    if (typeof name !== 'string') throw typeError(`__slots__ items must be strings, not '${typeName(name)}'`);
    if (!/^[\p{XID_Start}_][\p{XID_Continue}]*$/u.test(name)) throw typeError('__slots__ must be identifiers');
    if (name === '__dict__' && (result.includes(name) || basesHaveDict(cls))) {
      throw typeError('__dict__ slot disallowed: we already got one');
    }
    result.push(name);
  }
  const members = result.filter((name) => name !== '__dict__' && name !== '__weakref__');
  const variableSized = cls.mro.find((each) => each === intClass || each === tupleClass);
  if (members.length > 0 && variableSized) {
    throw typeError(`nonempty __slots__ not supported for subtype of '${variableSized.name}'`);
  }
  const keys = members.map((name) => mangle(cls.name, name));
  for (const key of keys) {
    if (entries.has(key)) throw valueError(`'${key}' in __slots__ conflicts with class variable`);
  }
  for (const key of keys) entries.set(key, slotMember(key, cls));
  return result;
}

/** Private names in `__slots__` are mangled as private names in a class body are. */
function mangle(className: string, name: string): string {
  if (!name.startsWith('__') || name.endsWith('__')) return name;
  const stripped = className.replace(/^_+/, '');
  return stripped === '' ? name : `_${stripped}${name}`;
}

/**
 * The names a class's instances may store, when they have no `__dict__`: a class has one unless it and every base
 * declare `__slots__` without `__dict__`.
 */
export function slotNamesOf(cls: PyClass, slots: string[] | undefined): Set<string> | undefined {
  if (slots === undefined || slots.includes('__dict__') || basesHaveDict(cls)) return undefined;
  const names = new Set(slots.map((name) => mangle(cls.name, name)));
  for (const base of cls.bases) for (const name of base.slotNames ?? []) names.add(name);
  return names;
}

function basesHaveDict(cls: PyClass): boolean {
  return cls.bases.some((base) => instancesHaveDict(base));
}

/** Whether the instances of a class have a `__dict__`, which builtin classes give only exceptions and turtles. */
export function instancesHaveDict(cls: PyClass): boolean {
  if (cls.isBuiltin) return cls.layout.base === 'exception' || cls.layout.base === 'turtle';
  return cls.slotNames === undefined;
}
