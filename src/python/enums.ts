// code-gauge-allow-file fileNcss 420 -- The enum machinery keeps the members, flags, and their boundaries together.
import { pyRepr, pyStr } from './conversions';
import { hashInt, pyHash } from './hashing';
import { getItem } from './items';
import { callValue, getAttribute, getIterator } from './objects';
import { intEnumValue, keysEqual } from './operators';
import { currentRuntime } from './runtimeContext';
import { defineValueHash } from './slotWrappers';
import {
  builtinClass,
  classOf,
  defineMethod,
  intClass,
  newDict,
  newList,
  newTuple,
  None,
  NotImplemented,
  objectClass,
  propertyClass,
  pyError,
  strClass,
  typeClass,
  typeError,
} from './types';
import {
  type Kwargs,
  PyBuiltinFunction,
  PyClass,
  PyDescriptor,
  PyFunction,
  PyInstance,
  PyList,
  PyOpaque,
  PyTuple,
  type PyValue,
} from './values';

/** `enum.EnumType`, the metaclass of every Enum class. */
export const enumTypeClass = new PyClass('EnumType', [typeClass], typeClass);
enumTypeClass.mro = [enumTypeClass, ...typeClass.mro];
enumTypeClass.module = 'enum';

export const enumClass = enumBuiltin('Enum', []);
export const reprEnumClass = enumBuiltin('ReprEnum', [enumClass]);
export const intEnumClass = enumBuiltin('IntEnum', [intClass, reprEnumClass]);
export const strEnumClass = enumBuiltin('StrEnum', [strClass, reprEnumClass]);
export const flagClass = enumBuiltin('Flag', [enumClass]);
export const intFlagClass = enumBuiltin('IntFlag', [intClass, reprEnumClass, flagClass]);
export const autoClass = builtinClass('auto');
autoClass.module = 'enum';
/** `enum.member()` and `enum.nonmember()`, which mark what a class body's attribute becomes. */
export const memberClass = builtinClass('member');
memberClass.module = 'enum';
export const nonmemberClass = builtinClass('nonmember');
nonmemberClass.module = 'enum';

function enumBuiltin(name: string, bases: PyClass[]): PyClass {
  const cls = new PyClass(name, bases.length > 0 ? bases : [objectClass], enumTypeClass);
  cls.mro = linearize(cls);
  cls.module = 'enum';
  cls.isBaseType = true;
  cls.flags.isEnum = true;
  cls.layout = { base: 'object' };
  return cls;
}

/** The C3 linearization of a builtin enum class, whose bases always admit one. */
function linearize(cls: PyClass): PyClass[] {
  const sequences = [...cls.bases.map((base) => [...base.mro]), [...cls.bases]];
  const result = [cls];
  for (;;) {
    const nonEmpty = sequences.filter((sequence) => sequence.length > 0);
    if (nonEmpty.length === 0) return result;
    const head = nonEmpty
      .map((sequence) => sequence[0])
      .find((candidate) => nonEmpty.every((sequence) => !sequence.slice(1).includes(candidate))) as PyClass;
    result.push(head);
    for (const sequence of nonEmpty) if (sequence[0] === head) sequence.shift();
  }
}

export function isEnumClass(cls: PyClass): boolean {
  return cls.flags.isEnum === true;
}

export function isFlagClass(cls: PyClass): boolean {
  return cls.isSubclassOf(flagClass);
}

/** The members of each Enum class by name, in definition order, aliases and multi-bit flags included. */
const namedMembers = new WeakMap<PyClass, Map<string, PyInstance>>();
/** The flag values without a name of their own that each Flag class has made members for. */
const pseudoMembers = new WeakMap<PyClass, Map<bigint, PyInstance>>();

export function membersByName(cls: PyClass): Map<string, PyInstance> {
  return namedMembers.get(cls) ?? new Map();
}

/** `Color(value)`: the member whose value equals `value`, a combination of flags, or what `_missing_` returns. */
// code-gauge-allow functionCognitiveComplexity 19 -- Follows EnumType.__call__ and Enum.__new__.
export function enumLookup(cls: PyClass, args: PyValue[], kwargs: Kwargs): PyValue {
  if (args.length > 1 || (kwargs && kwargs.size > 0)) return createEnum(cls, args, kwargs);
  if (args.length !== 1) {
    throw typeError(`${cls.name}() takes 1 positional argument but ${args.length} were given`);
  }
  const [value] = args;
  if (value instanceof PyInstance && value.cls === cls) return value;
  for (const member of membersByName(cls).values()) if (keysEqual(member.enumValue as PyValue, value)) return member;
  const missing = cls.lookup('_missing_');
  if (missing !== undefined && missing !== enumClass.dict.get('_missing_')) {
    const result = callValue(getAttribute(cls, '_missing_'), [value]);
    if (result instanceof PyInstance && result.cls.isSubclassOf(cls)) return result;
    if (result !== None) {
      throw typeError(
        `error in ${cls.qualifiedName}._missing_: returned ${pyRepr(result)} instead of None or a valid member`
      );
    }
  } else if (isFlagClass(cls) && (typeof value === 'bigint' || typeof value === 'boolean')) {
    return flagMember(cls, BigInt(value));
  }
  throw pyError('ValueError', `${pyRepr(value)} is not a valid ${cls.qualifiedName}`);
}

const FUNCTIONAL_KEYWORDS = new Set(['value', 'names', 'module', 'qualname', 'type', 'start', 'boundary']);

/**
 * `Enum('Name', names, *, module=None, qualname=None, type=None, start=1, boundary=None)`, the functional API of
 * EnumType.__call__, which creates a new Enum class as `_create_` does.
 */
// code-gauge-allow functionCognitiveComplexity 26 -- Follows EnumType._create_, which accepts names in four forms.
// code-gauge-allow functionNcss 40 -- Follows EnumType._create_, which accepts names in four forms.
function createEnum(cls: PyClass, args: PyValue[], kwargs: Kwargs): PyValue {
  for (const key of kwargs?.keys() ?? []) {
    if (!FUNCTIONAL_KEYWORDS.has(key)) {
      throw typeError(`EnumType.__call__() got an unexpected keyword argument '${key}'`);
    }
  }
  if (args.length > 2) throw typeError(`${cls.name}() takes 1 positional argument but ${args.length} were given`);
  const option = (name: string, index: number): PyValue | undefined => args[index] ?? kwargs?.get(name);
  const value = option('value', 0);
  let names = option('names', 1) ?? None;
  const start = option('start', -1) ?? 1n;
  if (cls.enumMembers && cls.enumMembers.length > 0) throw typeError(`${cls.name} has no members defined`);
  if (typeof names === 'string') names = newList(names.replaceAll(',', ' ').split(/\s+/).filter(Boolean));
  const entries: [string, PyValue][] = [];
  const items = names === None ? [] : currentRuntime().toArray(names);
  const isSequence = names instanceof PyList || (names instanceof PyTuple && names.cls.isBuiltin);
  if (isSequence && items.length > 0 && typeof items[0] === 'string') {
    const generate = getAttribute(cls, '_generate_next_value_');
    const lastValues: PyValue[] = [];
    for (const [count, name] of items.entries()) {
      const generated = callValue(generate, [name, start, BigInt(count), newList([...lastValues])]);
      lastValues.push(generated);
      entries.push([name as string, generated]);
    }
  } else {
    for (const item of items) {
      if (typeof item === 'string') entries.push([item, getItem(names, item)]);
      else {
        const [name, member] = currentRuntime().toArray(item);
        entries.push([name as string, member]);
      }
    }
  }
  const mixin = option('type', -1);
  const bases = mixin === undefined || mixin === None ? [cls] : [mixin, cls];
  const module = option('module', -1);
  const namespace = newDict([
    ['__module__', module === undefined || module === None ? '__main__' : module],
    ...entries,
  ]);
  const created = callValue(classOf(cls), [value as PyValue, newTuple(bases), namespace]) as PyClass;
  const qualname = option('qualname', -1);
  if (typeof qualname === 'string') created.qualifiedName = qualname;
  return created;
}

/** `value in Color`: a member, or the value of one, as Python 3.12 and later decide. */
export function enumContains(cls: PyClass, value: PyValue): boolean {
  if (value instanceof PyInstance && value.cls.isSubclassOf(cls) && value.enumValue !== undefined) return true;
  for (const member of membersByName(cls).values()) if (keysEqual(member.enumValue as PyValue, value)) return true;
  if (isFlagClass(cls) && typeof value === 'bigint') return (value & ~flagMask(cls)) === 0n && value >= 0n;
  return false;
}

// Members -----------------------------------------------------------------------------------------------------------

/** Replaces the plain attributes of an Enum class body with members, in definition order. */
// code-gauge-allow functionCognitiveComplexity 22 -- Follows how EnumType turns a class body into members.
// code-gauge-allow functionNcss 32 -- Follows how EnumType turns a class body into members.
export function createEnumMembers(cls: PyClass): void {
  cls.flags.isEnum = true;
  // As EnumType does, the body's own `__new__` creates the members, and calling the class looks one up.
  const create = cls.dict.get('__new__');
  if (create !== undefined) {
    cls.dict.delete('__new__');
    cls.dict.set('__new_member__', create);
  }
  const iterated: PyInstance[] = [];
  const named = new Map<string, PyInstance>();
  const lastValues: PyValue[] = [];
  // The members so far, which a `__new__` creating the next one may read through `__members__`.
  namedMembers.set(cls, named);
  for (const [name, attribute] of cls.dict) {
    let value = attribute;
    if (value instanceof PyOpaque && value.cls === nonmemberClass) {
      cls.dict.set(name, value.data as PyValue);
      continue;
    }
    const forced = value instanceof PyOpaque && value.cls === memberClass;
    if (forced) value = (attribute as PyOpaque).data as PyValue;
    if (!forced && (isDunderOrSunder(name) || isDescriptorLike(value))) continue;
    if (value instanceof PyOpaque && value.cls === autoClass) value = nextValue(cls, name, named.size, lastValues);
    const created = create === undefined ? undefined : customMember(cls, value);
    value = created ? (created.enumValue as PyValue) : mixinValue(cls, value);
    lastValues.push(value);
    const alias = [...named.values()].find((member) => keysEqual(member.enumValue as PyValue, value));
    if (alias) {
      cls.dict.set(name, alias);
      named.set(name, alias);
      continue;
    }
    const member = created ? initializeMember(created, name, value) : newMember(cls, name, value);
    named.set(name, member);
    cls.dict.set(name, member);
    if (!isFlagClass(cls) || isSingleBit(value)) iterated.push(member);
  }
  cls.enumMembers = iterated;
  useEnumMethodsOverMixin(cls);
}

/**
 * Gives an Enum class that mixes in `str` or `int` the reprs and comparisons of Enum, which EnumType puts before the
 * mixed-in type's: `repr()` shows the member, `str()` follows ReprEnum, and members equal their values.
 */
function useEnumMethodsOverMixin(cls: PyClass): void {
  if (!cls.isSubclassOf(strClass) && !cls.isSubclassOf(intClass)) return;
  const reprEnum = cls.isSubclassOf(reprEnumClass);
  const methods: [string, PyClass][] = [
    ['__repr__', enumClass],
    ['__str__', reprEnum ? reprEnumClass : enumClass],
    ['__format__', reprEnum ? reprEnumClass : enumClass],
    ['__eq__', strEnumClass],
    ['__hash__', strEnumClass],
  ];
  for (const [name, source] of methods) {
    const definedByProgram = cls.mro.some((each) => !each.isBuiltin && each.dict.has(name));
    if (!definedByProgram && !(isFlagClass(cls) && (name === '__eq__' || name === '__hash__'))) {
      cls.dict.set(name, source.dict.get(name) as PyValue);
    }
  }
}

function isDunderOrSunder(name: string): boolean {
  return name.startsWith('_');
}

function isDescriptorLike(value: PyValue): boolean {
  if (
    value instanceof PyFunction ||
    value instanceof PyDescriptor ||
    value instanceof PyBuiltinFunction ||
    value instanceof PyClass
  ) {
    return true;
  }
  // `enum._is_descriptor`: an object whose class defines __get__, __set__, or __delete__, as enum.property does.
  return (
    value instanceof PyInstance &&
    ['__get__', '__set__', '__delete__'].some((name) => value.cls.lookup(name) !== undefined)
  );
}

function newMember(cls: PyClass, name: string | undefined, value: PyValue): PyInstance {
  const member = new PyInstance(cls);
  member.enumValue = value;
  return initializeMember(member, name, value);
}

/** Names a new member and runs the class's `__init__` with the arguments its value stands for. */
function initializeMember(member: PyInstance, name: string | undefined, value: PyValue): PyInstance {
  member.dict.set('_name_', name ?? None);
  const init = member.cls.lookup('__init__');
  if (init instanceof PyFunction) callValue(init, [member, ...memberArguments(value)]);
  return member;
}

/**
 * The member the class body's own `__new__` creates from the arguments a value stands for, whose value is the
 * `_value_` it sets, else the value converted by the mixed-in type.
 */
function customMember(cls: PyClass, value: PyValue): PyInstance {
  const args = memberArguments(value);
  const member = callValue(getAttribute(cls, '__new_member__'), [cls, ...args]);
  if (!(member instanceof PyInstance)) throw typeError(`${cls.name}.__new__ must return an instance of ${cls.name}`);
  const own = member.dict.get('_value_');
  member.dict.delete('_value_');
  if (own !== undefined) member.enumValue = own;
  else if (cls.isSubclassOf(intClass) || cls.isSubclassOf(strClass))
    member.enumValue = mixinValue(cls, args[0] as PyValue);
  else member.enumValue = value;
  return member;
}

function memberArguments(value: PyValue): PyValue[] {
  return value instanceof PyInstance || !isTupleValue(value) ? [value] : [...(value as PyTuple).items];
}

function isTupleValue(value: PyValue): boolean {
  return typeof value === 'object' && value.cls.name === 'tuple';
}

/** The value `auto()` stands for, from the class's `_generate_next_value_`. */
function nextValue(cls: PyClass, name: string, count: number, lastValues: PyValue[]): PyValue {
  const generate = cls.lookup('_generate_next_value_') as PyValue;
  const fn = generate instanceof PyDescriptor ? generate.fn : generate;
  return callValue(fn, [name, 1n, BigInt(count), newList([...lastValues])]);
}

/** A member's value converted by the type its class mixes in, as `int` and `str` subclasses of Enum do. */
function mixinValue(cls: PyClass, value: PyValue): PyValue {
  if (cls.isSubclassOf(strEnumClass) && typeof value !== 'string') throw typeError(`${pyRepr(value)} is not a string`);
  if (cls.isSubclassOf(intClass) && typeof value !== 'bigint') return callValue(intClass, [value]);
  if (cls.isSubclassOf(strClass) && typeof value !== 'string') return callValue(strClass, [value]);
  return value;
}

function memberName(member: PyValue): PyValue {
  return (member as PyInstance).dict.get('_name_') as PyValue;
}

function memberValue(member: PyValue): PyValue {
  return (member as PyInstance).enumValue as PyValue;
}

defineMethod(enumClass, '__repr__', (self) => {
  const member = self as PyInstance;
  const name = memberName(member);
  const cls = member.cls.qualifiedName;
  return `<${name === None ? cls : `${cls}.${name as string}`}: ${pyRepr(memberValue(member))}>`;
});
defineMethod(enumClass, '__str__', (self) => enumStr(self as PyInstance));
defineMethod(enumClass, '__format__', (self, [spec]) => {
  const text = enumStr(self as PyInstance);
  return spec === '' ? text : pyStr(text);
});

function enumStr(member: PyInstance): string {
  const name = memberName(member);
  return name === None
    ? `${member.cls.qualifiedName}(${pyRepr(memberValue(member))})`
    : `${member.cls.qualifiedName}.${name as string}`;
}

defineMethod(enumClass, '__eq__', (self, [other]) => self === other);
defineValueHash(enumClass, (self) => pyHash(memberName(self)));
defineMethod(enumClass, '_missing_', () => None, 'class');
enumClass.dict.set(
  '_generate_next_value_',
  new PyBuiltinFunction(
    builtinClass('function'),
    '_generate_next_value_',
    ([, start, , lastValues]) => {
      for (const value of [...(lastValues as PyList).items].toReversed()) {
        if (typeof value === 'bigint') return value + 1n;
      }
      return start;
    },
    undefined,
    'static'
  )
);

defineMethod(reprEnumClass, '__str__', (self) => pyStr(memberValue(self)));
defineMethod(reprEnumClass, '__format__', (self, [spec]) => {
  const text = pyStr(memberValue(self));
  return spec === '' ? text : pyStr(text);
});
for (const cls of [intEnumClass, strEnumClass]) {
  defineMethod(cls, '__eq__', (self, [other]) => keysEqual(memberValue(self), intEnumValue(other)));
  defineValueHash(cls, (self) => pyHash(memberValue(self)));
}
defineMethod(intEnumClass, '__index__', (self) => memberValue(self));
defineMethod(intEnumClass, '__int__', (self) => memberValue(self));
strEnumClass.dict.set(
  '_generate_next_value_',
  new PyBuiltinFunction(
    builtinClass('function'),
    '_generate_next_value_',
    ([name]) => (name as string).toLowerCase(),
    undefined,
    'static'
  )
);

// Flags -------------------------------------------------------------------------------------------------------------

function isSingleBit(value: PyValue): boolean {
  return typeof value === 'bigint' && value > 0n && (value & (value - 1n)) === 0n;
}

/** The bits of every member of a Flag class. */
function flagMask(cls: PyClass): bigint {
  let mask = 0n;
  for (const member of cls.enumMembers ?? []) mask |= member.enumValue as bigint;
  return mask;
}

/** The member for a flag value: a named member, or a combination named after the members whose bits it has. */
export function flagMember(cls: PyClass, value: bigint): PyValue {
  for (const member of membersByName(cls).values()) if (member.enumValue === value) return member;
  let cache = pseudoMembers.get(cls);
  if (!cache) {
    cache = new Map();
    pseudoMembers.set(cls, cache);
  }
  const cached = cache.get(value);
  if (cached) return cached;
  const mask = flagMask(cls);
  const bounded = withinBoundary(cls, value, mask);
  if (bounded === undefined) return value;
  if (bounded !== value) return flagMember(cls, bounded);
  const extra = value & ~mask;
  if (extra !== 0n && boundaryOf(cls) !== 'keep') throw invalidFlag(cls, value, mask);
  const names = (cls.enumMembers ?? [])
    .filter((member) => ((member.enumValue as bigint) & value) !== 0n)
    .map((member) => memberName(member) as string);
  // Unknown bits join the names of the known ones; a value with no known bits has no name.
  if (extra !== 0n && names.length > 0) names.push(String(extra));
  const member = new PyInstance(cls);
  member.enumValue = value;
  member.dict.set('_name_', names.length === 0 ? None : names.join('|'));
  cache.set(value, member);
  return member;
}

/** The FlagBoundary of a Flag class: `_boundary_` of the class or a base, KEEP for an IntFlag and STRICT otherwise. */
function boundaryOf(cls: PyClass): string {
  const boundary = cls.lookup('_boundary_');
  const value = boundary instanceof PyInstance ? boundary.enumValue : boundary;
  if (typeof value === 'string') return value;
  return cls.isSubclassOf(intClass) ? 'keep' : 'strict';
}

/**
 * A flag value out of the class's range, adjusted as `Flag._missing_` does for the class's boundary: STRICT raises,
 * CONFORM keeps the defined bits, EJECT gives the plain int (undefined here), and KEEP turns a negative value positive.
 */
function withinBoundary(cls: PyClass, value: bigint, mask: bigint): bigint | undefined {
  const allBits = (1n << BigInt(mask.toString(2).length)) - 1n;
  if (mask === 0n || (value >= ~allBits && value <= allBits && (value & (allBits ^ mask)) === 0n)) {
    return value < 0n ? allBits + 1n + value : value;
  }
  switch (boundaryOf(cls)) {
    case 'strict': {
      throw invalidFlag(cls, value, mask);
    }
    case 'conform': {
      return value & mask;
    }
    case 'eject': {
      return undefined;
    }
    default: {
      if (value >= 0n) return value;
      const width = BigInt((-value).toString(2).length);
      const ceiling = allBits + 1n > 1n << width ? allBits + 1n : 1n << width;
      return ceiling + value;
    }
  }
}

function invalidFlag(cls: PyClass, value: bigint, mask: bigint): Error {
  const bits = Math.max(value.toString(2).length, mask.toString(2).length);
  return pyError(
    'ValueError',
    `<flag '${cls.name}'> invalid value ${value}\n    given ${binary(value, bits)}\n  allowed ${binary(mask, bits)}`
  );
}

/** `enum.bin()`, which shows a value's bits after its sign. */
function binary(value: bigint, bits: number): string {
  const digits = value.toString(2);
  return `0b0 ${digits.padStart(bits, '0')}`;
}

function flagOf(self: PyValue): bigint {
  return memberValue(self) as bigint;
}

/** The value of the other operand of a flag operator, or undefined when it is not a flag of the class or an int. */
function otherFlag(self: PyValue, other: PyValue): bigint | undefined {
  const cls = (self as PyInstance).cls;
  if (other instanceof PyInstance && other.cls.isSubclassOf(cls) && typeof other.enumValue === 'bigint') {
    return other.enumValue;
  }
  if (cls.isSubclassOf(intClass) && (typeof other === 'bigint' || typeof other === 'boolean')) return BigInt(other);
  return undefined;
}

for (const [name, apply] of [
  ['__or__', (a: bigint, b: bigint) => a | b],
  ['__and__', (a: bigint, b: bigint) => a & b],
  ['__xor__', (a: bigint, b: bigint) => a ^ b],
] as const) {
  const run = (self: PyValue, [other]: PyValue[]): PyValue => {
    const value = otherFlag(self, other);
    if (value === undefined) return NotImplemented;
    return flagMember((self as PyInstance).cls, apply(flagOf(self), value));
  };
  // IntFlag puts them before int's, as CPython's IntFlag assigns Flag's operators in its own body.
  for (const cls of [flagClass, intFlagClass]) {
    defineMethod(cls, name, run);
    defineMethod(cls, `__r${name.slice(2)}`, run);
  }
}

for (const cls of [flagClass, intFlagClass]) {
  defineMethod(cls, '__invert__', (self) => {
    const owner = (self as PyInstance).cls;
    return flagMember(owner, flagMask(owner) & ~flagOf(self));
  });
}
defineMethod(flagClass, '__contains__', (self, [other]) => {
  const value = otherFlag(self, other);
  if (value === undefined || !(other instanceof PyInstance)) {
    throw typeError(
      `unsupported operand type(s) for 'in': '${typeNameOf(other)}' and '${(self as PyInstance).cls.name}'`
    );
  }
  return (value & flagOf(self)) === value;
});

function typeNameOf(value: PyValue): string {
  return typeof value === 'object' ? value.cls.name : typeof value === 'bigint' ? 'int' : typeof value;
}

defineMethod(flagClass, '__iter__', (self) => {
  const value = flagOf(self);
  const members = ((self as PyInstance).cls.enumMembers ?? []).filter(
    (member) => ((member.enumValue as bigint) & value) !== 0n
  );
  return getIterator(newList(members));
});

defineMethod(flagClass, '__len__', (self) => {
  const value = flagOf(self);
  return BigInt(
    ((self as PyInstance).cls.enumMembers ?? []).filter((member) => ((member.enumValue as bigint) & value) !== 0n)
      .length
  );
});
defineMethod(flagClass, '__bool__', (self) => flagOf(self) !== 0n);
defineValueHash(flagClass, (self) => hashInt(flagOf(self)));
defineMethod(flagClass, '__eq__', (self, [other]) => {
  if (other instanceof PyInstance && other.cls === (self as PyInstance).cls) return other.enumValue === flagOf(self);
  if ((self as PyInstance).cls.isSubclassOf(intClass)) return keysEqual(flagOf(self), intEnumValue(other));
  return false;
});
flagClass.dict.set(
  '_generate_next_value_',
  new PyBuiltinFunction(
    builtinClass('function'),
    '_generate_next_value_',
    ([, start, count, lastValues]) => {
      if (count === 0n) return start;
      let high = 0n;
      for (const value of (lastValues as PyList).items) {
        if (typeof value !== 'bigint') throw typeError(`invalid flag value ${pyRepr(value)}`);
        if (value > high) high = value;
      }
      return 1n << BigInt(high.toString(2).length);
    },
    undefined,
    'static'
  )
);
defineMethod(intFlagClass, '__str__', (self) => pyStr(memberValue(self)));
defineMethod(intFlagClass, '__index__', (self) => memberValue(self));
defineMethod(intFlagClass, '__int__', (self) => memberValue(self));

// EnumType ----------------------------------------------------------------------------------------------------------

enumTypeClass.dict.set(
  '__members__',
  new PyDescriptor(
    propertyClass,
    new PyBuiltinFunction(builtinClass('function'), '__members__', ([cls]) => {
      const types = currentRuntime().importModule('types');
      const entries = [...membersByName(cls as PyClass)].map(([name, member]): [PyValue, PyValue] => [name, member]);
      return callValue(types.dict.get('MappingProxyType') as PyValue, [newDict(entries)]);
    })
  )
);

defineMethod(enumTypeClass, '__contains__', (cls, [value]) => enumContains(cls as PyClass, value));
defineMethod(enumTypeClass, '__iter__', (cls) => getIterator(newList([...((cls as PyClass).enumMembers ?? [])])));
defineMethod(enumTypeClass, '__reversed__', (cls) =>
  getIterator(newList([...((cls as PyClass).enumMembers ?? [])].toReversed()))
);

/** `EnumType.__dir__`: the members and the class's protocol, with what `dir()` lists of a mixed-in type. */
export function enumClassDir(cls: PyClass, runtime: { dirNames: (value: PyValue) => string[] }): string[] {
  const names = new Set([
    '__class__',
    '__contains__',
    '__doc__',
    '__getitem__',
    '__init_subclass__',
    '__iter__',
    '__len__',
    '__members__',
    '__module__',
    '__name__',
    '__qualname__',
    ...(cls.enumMembers ?? []).map((member) => memberName(member) as string),
  ]);
  const memberType = cls.mro.find((each) => each.isBuiltin && !each.flags.isEnum && each !== objectClass);
  if (memberType) {
    names.add('__new__');
    for (const name of runtime.dirNames(memberType)) names.add(name);
  }
  return [...names].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `Enum.__dir__`: what a member offers beside the members, with all of `object.__dir__` for a mixed-in type. */
export function enumMemberDir(member: PyInstance, runtime: { dirNames: (value: PyValue) => string[] }): string[] {
  const cls = member.cls;
  const memberType = cls.mro.find((each) => each.isBuiltin && !each.flags.isEnum && each !== objectClass);
  const names = new Set(
    memberType
      ? runtime.dirNames(memberValue(member))
      : ['__class__', '__doc__', '__eq__', '__hash__', '__module__', 'name', 'value']
  );
  const members = membersByName(cls);
  for (const each of cls.mro) {
    for (const name of each.dict.keys()) if (!name.startsWith('_') && !members.has(name)) names.add(name);
  }
  for (const name of ['__class__', '__doc__', '__eq__', '__hash__', '__module__']) names.add(name);
  return [...names].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The data of an Enum class that EnumType keeps: its members by name and by value, and the bits of a Flag's. */
export function enumClassData(cls: PyClass, name: string): PyValue | undefined {
  const runtime = currentRuntime();
  const named = membersByName(cls);
  switch (name) {
    case '_member_names_': {
      return runtime.listOf((cls.enumMembers ?? []).map((member) => memberName(member)));
    }
    case '_member_map_': {
      return newDict([...named].map(([key, member]): [PyValue, PyValue] => [key, member]));
    }
    case '_value2member_map_': {
      return newDict([...named.values()].map((member): [PyValue, PyValue] => [member.enumValue as PyValue, member]));
    }
    case '_flag_mask_':
    case '_singles_mask_': {
      return isFlagClass(cls) ? flagMask(cls) : undefined;
    }
    case '_all_bits_': {
      return isFlagClass(cls) ? (1n << BigInt(flagMask(cls).toString(2).length)) - 1n : undefined;
    }
    default: {
      return undefined;
    }
  }
}

export function newAuto(): PyValue {
  return new PyOpaque(autoClass, 'auto()');
}

/** The members of an Enum class, which iterating the class gives. */
export function enumMembersOf(cls: PyClass): PyValue {
  return newList([...(cls.enumMembers ?? [])]);
}

/**
 * `enum.global_enum`: shows the members as attributes of their module, where it also puts them, as `re.IGNORECASE`
 * and `calendar.MONDAY` are.
 */
export function globalEnum(cls: PyValue): PyValue {
  if (!(cls instanceof PyClass)) throw typeError('global_enum() argument must be an enum class');
  const qualified = (self: PyValue): string => `${cls.module}.${memberName(self) as string}`;
  defineMethod(cls, '__repr__', qualified);
  if (!cls.isSubclassOf(reprEnumClass)) defineMethod(cls, '__str__', (self) => memberName(self) as string);
  const globals = currentRuntime().frame.globals;
  for (const [name, member] of membersByName(cls)) globals.set(name, member);
  return cls;
}

/** `enum.unique`: the class, after checking that no member is an alias of another. */
export function uniqueEnum(cls: PyValue): PyValue {
  if (!(cls instanceof PyClass)) throw typeError(`unique() argument must be an enum class`);
  const duplicates: string[] = [];
  for (const [name, member] of membersByName(cls)) {
    const canonical = memberName(member) as string;
    if (canonical !== name) duplicates.push(`${name} -> ${canonical}`);
  }
  if (duplicates.length > 0) {
    throw pyError('ValueError', `duplicate values found in <enum '${cls.name}'>: ${duplicates.join(', ')}`);
  }
  return cls;
}

export { None, typeClass };
