import { pyFormat, pyRepr, pyStr } from './conversions';
import { defineGetSet } from './descriptors';
import { hashInt, identityHash, NATIVE_HASHES } from './hashing';
import { importModule } from './modules';
import { bindValue, callValue, getIterator } from './objects';
import { intEnumValue, keysEqual } from './operators';
import type { Runtime } from './runtime';
import { currentRuntime } from './runtimeContext';
import { builtinClass, defineMethod, intClass, newList, newTuple, None, objectClass, typeClass } from './types';
import { type Kwargs, PyBuiltinFunction, type PyClass, PyInstance, type PyObject, type PyValue } from './values';

/**
 * The `enum` module's native part: the classes `Enum` and `IntEnum`, the metaclass their subclasses get, and the
 * creation of members. What `EnumType` does when a class is created or called is written in Python (enumSource.ts),
 * which registers its functions here as hooks.
 */

export const enumTypeClass = builtinClass('EnumType', typeClass);
enumTypeClass.module = 'enum';
export const enumClass = builtinClass('Enum', undefined, true);
enumClass.module = 'enum';
enumClass.flags.isEnum = true;
enumClass.layout = { base: 'object' };
enumClass.cls = enumTypeClass;
enumClass.dict.set('_member_type_', objectClass);
export const intEnumClass = builtinClass('IntEnum', enumClass, true);
intEnumClass.module = 'enum';
intEnumClass.flags.isEnum = true;
intEnumClass.layout = { base: 'object' };
intEnumClass.cls = enumTypeClass;
intEnumClass.dict.set('_member_type_', intClass);

export function isEnumClass(cls: PyClass): boolean {
  return cls.flags.isEnum === true;
}

interface EnumHooks {
  /** `EnumType.__prepare__`: creates the state `EnumDict` keeps while a class body runs. */
  prepare: PyValue;
  /** `EnumDict.__setitem__`: returns the value to bind a name of the class body to. */
  setItem: PyValue;
  /** Turns the names a class body bound into members. */
  build: PyValue;
  /** `EnumType.__call__`: looks a member up by value, or creates an enum class from names. */
  call: PyValue;
  /** `EnumType.__contains__`. */
  contains: PyValue;
}

const hooksByRuntime = new WeakMap<Runtime, EnumHooks>();

/** Registers the functions of the Python part for the running program. */
export function registerEnumHooks(hooks: EnumHooks): void {
  hooksByRuntime.set(currentRuntime(), hooks);
}

function enumHooks(): EnumHooks {
  const runtime = currentRuntime();
  if (!hooksByRuntime.has(runtime)) importModule(runtime, 'enum');
  return hooksByRuntime.get(runtime) as EnumHooks;
}

/** The namespace of an Enum class body, which resolves `auto()` and records the members as names are bound. */
export class EnumNamespace extends Map<string, PyValue> {
  state: PyValue = None;

  override set(name: string, value: PyValue): this {
    const args = [this.state, name, value, this.has(name), this.get(name) ?? None];
    return super.set(name, callValue(enumHooks().setItem, args));
  }
}

/** Creates the namespace for the body of a class whose bases include an Enum class. */
export function newEnumNamespace(name: string, bases: PyClass[], isLibraryClass: boolean): EnumNamespace {
  const namespace = new EnumNamespace();
  namespace.state = callValue(enumHooks().prepare, [name, newTuple(bases), isLibraryClass]);
  return namespace;
}

/** Calls an Enum class: `Color(value)` gives the member of that value. */
export function enumLookup(cls: PyClass, args: PyValue[], kwargs: Kwargs): PyValue {
  return callValue(enumHooks().call, [cls, ...args], kwargs);
}

/** Replaces the names an Enum class body bound to values with members, in definition order. */
export function createEnumMembers(cls: PyClass, namespace: EnumNamespace, boundary: PyValue = None): void {
  cls.flags.isEnum = true;
  cls.cls = enumTypeClass;
  callValue(enumHooks().build, [cls, namespace.state, boundary]);
}

/** A member without its value yet, so that the class's `__init__` can still set attributes on it. */
export function newEnumMember(cls: PyClass, name: PyValue, value: PyValue): PyInstance {
  const member = new PyInstance(cls);
  member.dict.set('_name_', name);
  member.dict.set('_value_', value);
  return member;
}

/** Gives a member the value its `__init__` left in `_value_`, from which on its attributes cannot be set. */
export function finishEnumMember(member: PyInstance): PyValue {
  const value = member.dict.get('_value_') ?? None;
  member.dict.delete('_value_');
  member.enumValue = value;
  return value;
}

/** Sets the members that iterating the class gives, which exclude aliases. */
export function setEnumMembers(cls: PyClass, members: PyInstance[]): void {
  cls.enumMembers = members;
}

/** The members of an Enum class, which iterating the class gives. */
export function enumMembersOf(cls: PyClass): PyValue {
  return newList([...(cls.enumMembers ?? [])]);
}

// EnumType ----------------------------------------------------------------------------------------------------------

defineMethod(enumTypeClass, '__repr__', (self) => {
  const cls = self as PyClass;
  return `<${cls.lookup('_flag_mask_') === undefined ? 'enum' : 'flag'} '${cls.name}'>`;
});
defineMethod(enumTypeClass, '__contains__', (self, [value]) => callValue(enumHooks().contains, [self, value]));
defineMethod(enumTypeClass, '__iter__', (self) => getIterator(enumMembersOf(self as PyClass)));
defineMethod(enumTypeClass, '__len__', (self) => BigInt((self as PyClass).enumMembers?.length ?? 0));
defineMethod(enumTypeClass, '__bool__', () => true);
defineMethod(enumTypeClass, '__reversed__', (self) =>
  getIterator(newList([...((self as PyClass).enumMembers ?? [])].toReversed()))
);

// Enum --------------------------------------------------------------------------------------------------------------

const valueOf = (member: PyValue): PyValue => (member as PyInstance).enumValue as PyValue;
const describe = (member: PyValue): string => `${(member as PyInstance).cls.name}.${pyStr(memberName(member))}`;

function memberName(member: PyValue): PyValue {
  return (member as PyInstance).dict.get('_name_') ?? None;
}

defineMethod(enumClass, '__repr__', (self) => `<${describe(self)}: ${pyRepr(valueOf(self))}>`);
defineMethod(enumClass, '__str__', (self) => describe(self));
defineMethod(enumClass, '__format__', (self, [spec]) => {
  const str = (self as PyInstance).cls.lookup('__str__') as PyValue;
  return pyFormat(callValue(bindValue(str, self), []), spec as string);
});
defineMethod(enumClass, '__hash__', (self) => identityHash(self as PyObject));
// CPython hashes a member by its name, whose hash is randomized, so the identity hash is as good and keeps sets cheap.
NATIVE_HASHES.add(enumClass.dict.get('__hash__') as PyValue);
defineMethod(enumClass, '__eq__', (self, [other]) => self === other);
defineMethod(enumClass, '_missing_', () => None, 'class');
defineMethod(enumClass, '__reduce_ex__', (self) => newTuple([(self as PyInstance).cls, newTuple([valueOf(self)])]));
defineMethod(enumClass, '__copy__', (self) => self);
defineMethod(enumClass, '__deepcopy__', (self) => self);

/** `Enum.__dir__`: a member lists the attributes it is meant to have, plus its own and its class's public ones. */
enumClass.dirNames = (self) => {
  const member = self as PyInstance;
  const names = new Set(['__class__', '__doc__', '__eq__', '__hash__', '__module__', 'name', 'value']);
  const memberNames = new Set((member.cls.enumMembers ?? []).map((each) => each.dict.get('_name_') as string));
  if (member.cls.isSubclassOf(intEnumClass)) for (const name of currentRuntime().dirNames(0n)) names.add(name);
  for (const name of member.dict.keys()) if (!name.startsWith('_') && !memberNames.has(name)) names.add(name);
  for (const cls of member.cls.mro) {
    for (const name of cls.dict.keys()) if (!name.startsWith('_') && !memberNames.has(name)) names.add(name);
  }
  return names;
};

// IntEnum -----------------------------------------------------------------------------------------------------------

defineMethod(intEnumClass, '__str__', (self) => pyRepr(valueOf(self)));
defineMethod(intEnumClass, '__format__', (self, [spec]) => pyFormat(valueOf(self), spec as string));
defineMethod(intEnumClass, '__hash__', (self) => hashInt(valueOf(self) as bigint));
defineMethod(intEnumClass, '__eq__', (self, [other]) => keysEqual(valueOf(self), intEnumValue(other)));
defineMethod(intEnumClass, '__index__', (self) => valueOf(self));
defineMethod(intEnumClass, '__int__', (self) => valueOf(self));
defineMethod(intEnumClass, '__bool__', (self) => valueOf(self) !== 0n);

/**
 * The operators of int apply to a member through `intEnumValue`; the other methods of int that a member inherits in
 * CPython, such as `bit_length()` or the one `abs()` calls, run here on its value.
 */
const INHERITED_INT_SPECIALS = new Set([
  '__abs__',
  '__round__',
  '__divmod__',
  '__rdivmod__',
  '__float__',
  '__trunc__',
  '__floor__',
  '__ceil__',
]);

/** Runs once all of int's methods are defined, which is after this module is first imported. */
export function inheritIntMethods(): void {
  for (const [name, attribute] of intClass.dict) inheritIntMethod(name, attribute);
}

function inheritIntMethod(name: string, attribute: PyValue): void {
  const isInherited = !name.startsWith('_') || INHERITED_INT_SPECIALS.has(name);
  if (!isInherited || intEnumClass.dict.has(name) || !(attribute instanceof PyBuiltinFunction)) return;
  defineMethod(intEnumClass, name, (self, args, kwargs) =>
    callValue(
      bindValue(attribute, valueOf(self)),
      args.map((arg) => intEnumValue(arg)),
      kwargs
    )
  );
}
for (const name of ['real', 'numerator']) defineGetSet(intEnumClass, name, (self) => valueOf(self));
defineGetSet(intEnumClass, 'imag', () => 0n);
defineGetSet(intEnumClass, 'denominator', () => 1n);
