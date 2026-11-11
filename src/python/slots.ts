import { method } from './define';
import { toArray } from './objects';
import { builtinClass, intClass, pyError, tupleClass, typeError, typeName, valueError } from './types';
import { type PyClass, type PyObject, PyOpaque, type PyValue } from './values';

/** The class of the descriptors `__slots__` creates, which store an attribute outside any `__dict__`. */
const memberDescriptorClass = builtinClass('member_descriptor');
method(memberDescriptorClass, '__repr__', 'none', 0, 0, (self) => {
  const member = self as PyOpaque;
  return `<member '${member.text}' of '${(member.data as PyClass).name}' objects>`;
});

/** Whether a class attribute is a slot's descriptor. */
export function isMember(value: PyValue | undefined): value is PyOpaque {
  return value instanceof PyOpaque && value.cls === memberDescriptorClass;
}

/** Reads a slot of an instance, raising AttributeError when it holds nothing. */
export function readMember(member: PyOpaque, instance: PyObject): PyValue {
  const value = instance.slotValues?.get(member.text);
  if (value === undefined) {
    throw pyError('AttributeError', `'${typeName(instance)}' object has no attribute '${member.text}'`);
  }
  return value;
}

export function writeMember(member: PyOpaque, instance: PyObject, value: PyValue): void {
  instance.slotValues ??= new Map();
  instance.slotValues.set(member.text, value);
}

export function deleteMember(member: PyOpaque, instance: PyObject): void {
  if (!instance.slotValues?.delete(member.text)) {
    throw pyError('AttributeError', `'${typeName(instance)}' object has no attribute '${member.text}'`);
  }
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
  for (const key of keys) entries.set(key, new PyOpaque(memberDescriptorClass, key, cls));
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
