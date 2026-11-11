import { pyRepr, pyStr } from './conversions';
import { hashInt, NATIVE_HASHES } from './hashing';
import { intEnumValue, keysEqual } from './operators';
import { currentRuntime } from './runtimeContext';
import { builtinClass, defineMethod, newList, None, pyError, typeClass, typeError } from './types';
import {
  type Kwargs,
  PyBuiltinFunction,
  PyClass,
  PyDescriptor,
  PyFunction,
  PyInstance,
  PyOpaque,
  type PyValue,
} from './values';

export const enumClass = builtinClass('Enum', undefined, true);
enumClass.module = 'enum';
enumClass.flags.isEnum = true;
enumClass.layout = { base: 'object' };
export const intEnumClass = builtinClass('IntEnum', enumClass, true);
intEnumClass.module = 'enum';
intEnumClass.flags.isEnum = true;
intEnumClass.layout = { base: 'object' };
export const autoClass = builtinClass('auto');
autoClass.module = 'enum';

export function isEnumClass(cls: PyClass): boolean {
  return cls.flags.isEnum === true;
}

/** `Color(value)`: the member whose value equals `value`. */
export function enumLookup(cls: PyClass, args: PyValue[], kwargs: Kwargs): PyValue {
  if (args.length !== 1 || (kwargs && kwargs.size > 0)) {
    throw typeError(`${cls.name}() takes 1 positional argument but ${args.length} were given`);
  }
  const [value] = args;
  if (value instanceof PyInstance && value.cls === cls) return value;
  for (const member of cls.enumMembers ?? []) if (keysEqual(member.enumValue as PyValue, value)) return member;
  throw pyError('ValueError', `${pyRepr(value)} is not a valid ${cls.qualifiedName}`);
}

/** Replaces the plain attributes of an Enum class body with members, in definition order. */
export function createEnumMembers(cls: PyClass): void {
  cls.flags.isEnum = true;
  const members: PyInstance[] = [];
  let lastInt = 0n;
  for (const [name, value] of cls.dict) {
    if (name.startsWith('_') || isDescriptorLike(value)) continue;
    let memberValue = value;
    if (value instanceof PyOpaque && value.cls === autoClass) {
      memberValue = lastInt + 1n;
    }
    if (typeof memberValue === 'bigint') lastInt = memberValue;
    const alias = members.find((member) => keysEqual(member.enumValue as PyValue, memberValue));
    if (alias) {
      cls.dict.set(name, alias);
      continue;
    }
    const member = new PyInstance(cls);
    member.enumValue = memberValue;
    member.dict.set('_name_', name);
    members.push(member);
    cls.dict.set(name, member);
  }
  cls.enumMembers = members;
}

function isDescriptorLike(value: PyValue): boolean {
  return (
    value instanceof PyFunction ||
    value instanceof PyDescriptor ||
    value instanceof PyBuiltinFunction ||
    value instanceof PyClass
  );
}

function memberName(member: PyValue): string {
  return (member as PyInstance).dict.get('_name_') as string;
}

defineMethod(enumClass, '__repr__', (self) => {
  const member = self as PyInstance;
  return `<${member.cls.qualifiedName}.${memberName(member)}: ${pyRepr(member.enumValue as PyValue)}>`;
});
defineMethod(enumClass, '__str__', (self) => `${(self as PyInstance).cls.qualifiedName}.${memberName(self)}`);
defineMethod(enumClass, '__format__', (self, [spec]) => {
  const text = `${(self as PyInstance).cls.qualifiedName}.${memberName(self)}`;
  return spec === '' ? text : pyStr(text);
});
defineMethod(
  enumClass,
  '__hash__',
  (self) => BigInt(memberName(self).length) * 1_000_003n + BigInt(memberName(self).codePointAt(0) ?? 0)
);
// CPython hashes a member by its name, whose hash is randomized, so the identity hash is as good and keeps sets cheap.
NATIVE_HASHES.add(enumClass.dict.get('__hash__') as PyValue);
defineMethod(enumClass, '__eq__', (self, [other]) => self === other);
defineMethod(intEnumClass, '__str__', (self) => pyStr((self as PyInstance).enumValue as PyValue));
defineMethod(intEnumClass, '__format__', (self) => pyStr((self as PyInstance).enumValue as PyValue));
defineMethod(intEnumClass, '__hash__', (self) => hashInt((self as PyInstance).enumValue as bigint));
defineMethod(intEnumClass, '__eq__', (self, [other]) =>
  keysEqual((self as PyInstance).enumValue as PyValue, intEnumValue(other))
);
defineMethod(intEnumClass, '__index__', (self) => (self as PyInstance).enumValue as PyValue);
defineMethod(intEnumClass, '__int__', (self) => (self as PyInstance).enumValue as PyValue);

export function newAuto(): PyValue {
  return new PyOpaque(autoClass, 'auto()');
}

/** The members of an Enum class, which iterating the class gives. */
export function enumMembersOf(cls: PyClass): PyValue {
  return newList([...(cls.enumMembers ?? [])]);
}

export { None, typeClass };

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
