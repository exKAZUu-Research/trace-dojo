// code-gauge-allow-file fileNcss 635 -- The enum machinery keeps the members, flags, and their boundaries together.
import { pyFormat, pyRepr, pyStr } from './conversions';
import { pythonMethod } from './define';
import { ownDict } from './descriptors';
import { hashInt, pyHash } from './hashing';
import { getItem, keyError } from './items';
import { bindValue, callValue, enumMemberGenerator, getAttribute, isTruthy, setItem } from './objects';
import { binaryOp, intEnumValue, keysEqual } from './operators';
import { currentRuntime, runningRuntime } from './runtimeContext';
import { defineValueHash } from './slotWrappers';
import {
  argumentTypeName,
  classOf,
  defineMethod,
  exceptionClassNamed,
  functionClass,
  generatorClass,
  intClass,
  newDict,
  newList,
  newTuple,
  None,
  NotImplemented,
  objectClass,
  propertyClass,
  pyError,
  staticmethodClass,
  strClass,
  typeClass,
  typeError,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import {
  type Kwargs,
  PyBuiltinFunction,
  PyClass,
  PyDescriptor,
  PyDict,
  PyError,
  PyFunction,
  PyGenerator,
  PyInstance,
  PyList,
  PyTuple,
  type PyValue,
} from './values';

/** `enum.EnumType`, the metaclass of every Enum class. */
export const enumTypeClass = new PyClass('EnumType', [typeClass], typeClass);
enumTypeClass.mro = [enumTypeClass, ...typeClass.mro];
enumTypeClass.module = 'enum';
enumTypeClass.isWrittenInPython = true;

export const enumClass = enumBuiltin('Enum', []);
export const reprEnumClass = enumBuiltin('ReprEnum', [enumClass]);
export const intEnumClass = enumBuiltin('IntEnum', [intClass, reprEnumClass]);
export const strEnumClass = enumBuiltin('StrEnum', [strClass, reprEnumClass]);
export const flagClass = enumBuiltin('Flag', [enumClass]);
export const intFlagClass = enumBuiltin('IntFlag', [intClass, reprEnumClass, flagClass]);

function enumBuiltin(name: string, bases: PyClass[]): PyClass {
  const cls = new PyClass(name, bases.length > 0 ? bases : [objectClass], enumTypeClass);
  cls.mro = linearize(cls);
  cls.module = 'enum';
  cls.isBaseType = true;
  cls.isWrittenInPython = true;
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
/** The canonical member for each distinct value of an Enum class, keyed by its value before `__init__` runs. */
const memberLookups = new WeakMap<PyClass, [PyValue, PyInstance][]>();
/** The flag values without a name of their own that each Flag class has made members for. */
const pseudoMembers = new WeakMap<PyClass, Map<bigint, PyInstance>>();

export function membersByName(cls: PyClass): Map<string, PyInstance> {
  return namedMembers.get(cls) ?? new Map();
}

function lookupEntries(cls: PyClass): [PyValue, PyInstance][] {
  return memberLookups.get(cls) ?? [];
}

const FUNCTIONAL_KEYWORDS = new Set(['value', 'names', 'module', 'qualname', 'type', 'start', 'boundary']);

/** `Color(value)` or `Enum('Name', names, ...)`: `EnumType.__call__`. */
// code-gauge-allow functionCognitiveComplexity 24 -- Follows EnumType.__call__ and Enum.__new__.
export function enumLookup(cls: PyClass, args: PyValue[], kwargs: Kwargs): PyValue {
  validateEnumCallArgs(args, kwargs);
  const firstValue = args.length > 0 ? args[0] : (kwargs?.get('value') as PyValue);
  const hasNames = args.length >= 2 || (kwargs?.has('names') ?? false);
  if (membersByName(cls).size === 0) return emptyEnumCall(cls, firstValue, hasNames, args, kwargs);
  const value =
    args.length > 1
      ? newTuple(args)
      : kwargs?.has('names')
        ? newTuple([firstValue, kwargs.get('names') as PyValue])
        : firstValue;
  if (value instanceof PyInstance && value.cls === cls) return value;
  for (const [memberVal, member] of lookupEntries(cls)) if (keysEqual(memberVal, value)) return member;
  const missing = cls.lookup('_missing_');
  if (missing !== undefined && missing !== enumClass.dict.get('_missing_')) return callMissing(cls, value);
  if (isFlagClass(cls) && (typeof value === 'bigint' || typeof value === 'boolean')) {
    return flagMember(cls, BigInt(value));
  }
  throw pyError('ValueError', `${pyRepr(value)} is not a valid ${cls.qualifiedName}`);
}

function validateEnumCallArgs(args: PyValue[], kwargs: Kwargs): void {
  for (const key of kwargs?.keys() ?? []) {
    if (!FUNCTIONAL_KEYWORDS.has(key)) {
      throw typeError(`EnumType.__call__() got an unexpected keyword argument '${key}'`);
    }
  }
  if (args.length > 0 && kwargs?.has('value')) {
    throw typeError("EnumType.__call__() got multiple values for argument 'value'");
  }
  if (args.length >= 2 && kwargs?.has('names')) {
    throw typeError("EnumType.__call__() got multiple values for argument 'names'");
  }
  if (args.length === 0 && !kwargs?.has('value')) {
    throw typeError("EnumType.__call__() missing 1 required positional argument: 'value'");
  }
}

function emptyEnumCall(cls: PyClass, firstValue: PyValue, hasNames: boolean, args: PyValue[], kwargs: Kwargs): PyValue {
  const mixin = kwargs?.get('type') ?? None;
  if (!hasNames && mixin === None) {
    throw typeError(`${pyRepr(cls)} has no members; specify \`names=()\` if you meant to create a new, empty, enum`);
  }
  if (args.length > 2) throw typeError(`${cls.name}() takes at most 2 positional arguments (${args.length} given)`);
  const names = hasNames ? (args.length >= 2 ? args[1] : (kwargs?.get('names') as PyValue)) : None;
  return createEnum(cls, firstValue, names, kwargs);
}

function callMissing(cls: PyClass, value: PyValue): PyValue {
  let result: PyValue = None;
  let caught: unknown;
  try {
    result = callValue(getAttribute(cls, '_missing_'), [value]);
  } catch (error) {
    caught = error;
  }
  if (caught === undefined && result instanceof PyInstance && result.cls.isSubclassOf(cls)) return result;
  if (caught === undefined && isFlagClass(cls) && boundaryOf(cls) === 'eject' && typeof result === 'bigint') {
    return result;
  }
  const invalid = pyError('ValueError', `${pyRepr(value)} is not a valid ${cls.qualifiedName}`);
  if (caught === undefined && result === None) throw invalid;
  const raised =
    caught ?? typeError(`error in ${cls.name}._missing_: returned ${pyRepr(result)} instead of None or a valid member`);
  if (
    raised instanceof PyError &&
    !raised.exception.cls.isSubclassOf(exceptionClassNamed('ValueError')) &&
    raised.exception.exception
  ) {
    raised.exception.exception.context = invalid.exception;
  }
  throw raised;
}

/**
 * `Enum('Name', names, *, module=None, qualname=None, type=None, start=1, boundary=None)`, the functional API of
 * EnumType.__call__, which creates a new Enum class as `_create_` does.
 */
// code-gauge-allow functionCognitiveComplexity 28 -- Follows EnumType._create_, which accepts names in four forms.
// code-gauge-allow functionNcss 42 -- Follows EnumType._create_, which accepts names in four forms.
function createEnum(cls: PyClass, className: PyValue, rawNames: PyValue, kwargs: Kwargs): PyValue {
  let names = rawNames;
  const start = kwargs?.get('start') ?? 1n;
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
  const mixin = kwargs?.get('type');
  const bases = mixin === undefined || mixin === None ? [cls] : [mixin, cls];
  const meta = classOf(cls);
  const prepareFn = meta.dict.get('__prepare__');
  const namespace =
    prepareFn === undefined ? newDict() : callValue(bindValue(prepareFn, meta, meta), [className, newTuple(bases)]);
  const module = kwargs?.get('module');
  setItem(namespace, '__module__', module === undefined || module === None ? '__main__' : module);
  for (const [key, val] of entries) setItem(namespace, key, val);
  const boundary = kwargs?.get('boundary');
  const metaKwargs =
    boundary !== undefined && boundary !== None ? new Map<string, PyValue>([['boundary', boundary]]) : undefined;
  const created = callValue(meta, [className, newTuple(bases), namespace], metaKwargs) as PyClass;
  const qualname = kwargs?.get('qualname');
  if (typeof qualname === 'string') created.qualifiedName = qualname;
  return created;
}

/** `value in Color`: a member, or the value of one, as Python 3.12 and later decide. */
export function enumContains(cls: PyClass, value: PyValue): boolean {
  if (value instanceof PyInstance && value.cls.isSubclassOf(cls) && value.enumValue !== undefined) return true;
  if (isFlagClass(cls) && (typeof value === 'bigint' || typeof value === 'boolean')) {
    try {
      const result = flagMember(cls, BigInt(value));
      return result instanceof PyInstance && result.cls.isSubclassOf(cls);
    } catch {
      return false;
    }
  }
  for (const [memberVal] of lookupEntries(cls)) if (keysEqual(memberVal, value)) return true;
  return false;
}

// Members -----------------------------------------------------------------------------------------------------------

/** Replaces the plain attributes of an Enum class body with members, in definition order. */
// code-gauge-allow functionCognitiveComplexity 29 -- Follows how EnumType turns a class body into members.
// code-gauge-allow functionNcss 56 -- Follows how EnumType turns a class body into members.
export function createEnumMembers(cls: PyClass, namespace?: Map<string, PyValue> | PyDict): void {
  cls.flags.isEnum = true;
  if (cls.bases.includes(reprEnumClass) && memberTypeOf(cls) === objectClass) {
    throw typeError('ReprEnum subclasses must be mixed with a data type (i.e. int, str, float, etc.)');
  }
  const enumDictFields = namespace instanceof PyDict ? ownDict(namespace) : undefined;
  const memberNamesDict = enumDictFields?.get('_member_names');
  const ignoredList = enumDictFields?.get('_ignore');
  if (ignoredList instanceof PyList) {
    for (const ignored of ignoredList.items) if (typeof ignored === 'string') cls.dict.delete(ignored);
  }
  cls.dict.delete('_ignore_');
  const rawOrder = cls.dict.get('_order_');
  cls.dict.delete('_order_');
  // As EnumType does, the body's own `__new__` creates the members, and calling the class looks one up.
  const create = cls.dict.get('__new__');
  if (create !== undefined) {
    cls.dict.delete('__new__');
    cls.dict.set('__new_member__', create);
  }
  const iterated: PyInstance[] = [];
  const iteratedNames: string[] = [];
  const named = new Map<string, PyInstance>();
  const lookups: [PyValue, PyInstance][] = [];
  // The members so far, which a `__new__` creating the next one may read through `__members__`.
  namedMembers.set(cls, named);
  memberLookups.set(cls, lookups);
  const candidateNames =
    memberNamesDict instanceof PyDict
      ? [...memberNamesDict.store.ordered()].map((entry) => entry.key as string).filter((key) => cls.dict.has(key))
      : [...cls.dict.entries()]
          .filter(([key, val]) => !isDunderOrSunder(key) && !isDescriptorLike(val))
          .map(([key]) => key);
  for (const name of candidateNames) {
    if (name === 'mro' || name === '') throw pyError('ValueError', `invalid enum member name(s) ${pyRepr(name)}`);
    const rawValue = cls.dict.get(name) as PyValue;
    const created = create === undefined ? undefined : customMember(cls, rawValue);
    const converted = created ? (created.enumValue as PyValue) : mixinValue(cls, rawValue);
    const member = created ? initializeMember(created, name, rawValue) : newMember(cls, name, converted, rawValue);
    const alias = lookups.find(([existingKey]) => keysEqual(existingKey, converted))?.[1];
    if (alias) {
      cls.dict.set(name, alias);
      named.set(name, alias);
      runningRuntime()?.finalizer.release([member]);
      continue;
    }
    lookups.push([converted, member]);
    named.set(name, member);
    cls.dict.set(name, member);
    if (!isFlagClass(cls) || isSingleBit(converted)) {
      iterated.push(member);
      iteratedNames.push(name);
    }
  }
  cls.enumMembers = iterated;
  checkMemberOrder(rawOrder, named, iteratedNames);
  useEnumMethodsOverMixin(cls);
}

function checkMemberOrder(
  rawOrder: PyValue | undefined,
  named: Map<string, PyInstance>,
  iteratedNames: string[]
): void {
  if (rawOrder === undefined || rawOrder === None) return;
  const orderItems =
    typeof rawOrder === 'string'
      ? rawOrder.replaceAll(',', ' ').split(/\s+/).filter(Boolean)
      : currentRuntime().toArray(rawOrder);
  if (orderItems.length === 0) return;
  const filtered = orderItems.filter(
    (entry) => typeof entry !== 'string' || !named.has(entry) || iteratedNames.includes(entry)
  );
  if (filtered.length !== iteratedNames.length || filtered.some((entry, idx) => entry !== iteratedNames[idx])) {
    throw typeError(
      `member order does not match _order_:\n  ${pyRepr(newList(iteratedNames))}\n  ${pyRepr(newList(filtered))}`
    );
  }
}

/**
 * Gives an Enum class that mixes in `str` or `int` the reprs and comparisons of Enum, which EnumType puts before the
 * mixed-in type's: `repr()` shows the member, `str()` follows ReprEnum, and members equal their values.
 */
function useEnumMethodsOverMixin(cls: PyClass): void {
  if (!cls.isSubclassOf(strClass) && !cls.isSubclassOf(intClass)) return;
  const reprEnum = cls.isSubclassOf(reprEnumClass);
  const methods: [string, PyClass][] = [
    ['__repr__', isFlagClass(cls) ? flagClass : enumClass],
    ['__str__', reprEnum ? reprEnumClass : isFlagClass(cls) ? flagClass : enumClass],
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

function newMember(cls: PyClass, name: string | undefined, value: PyValue, initArgSource = value): PyInstance {
  const member = new PyInstance(cls);
  member.enumValue = value;
  return initializeMember(member, name, initArgSource);
}

/** Names a new member and runs the class's `__init__` with the arguments its value stands for. */
function initializeMember(member: PyInstance, name: string | undefined, initArgSource: PyValue): PyInstance {
  member.dict.set('_name_', name ?? None);
  const init = member.cls.lookup('__init__');
  if (init instanceof PyFunction) callValue(init, [member, ...memberArguments(initArgSource)]);
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

/** A member's value converted by the type its class mixes in, as `int` and `str` subclasses of Enum do. */
function mixinValue(cls: PyClass, value: PyValue): PyValue {
  if (cls.isSubclassOf(strEnumClass) && typeof value !== 'string') throw typeError(`${pyRepr(value)} is not a string`);
  if (cls.isSubclassOf(intClass) && typeof value !== 'bigint') return callValue(intClass, [value]);
  if (cls.isSubclassOf(strClass) && typeof value !== 'string') return callValue(strClass, [value]);
  return value;
}

function memberName(member: PyValue): PyValue {
  return (member as PyInstance).dict.get('_name_') ?? None;
}

function memberValue(member: PyValue): PyValue {
  return (member as PyInstance).enumValue as PyValue;
}

pythonMethod(enumClass, '__repr__', '', (self) => {
  if (self instanceof PyInstance && self.enumValue !== undefined) {
    const name = memberName(self);
    const cls = self.cls.name;
    return `<${name === None ? cls : `${cls}.${name as string}`}: ${pyRepr(memberValue(self))}>`;
  }
  const valueRepr = getAttribute(classOf(self), '_value_repr_');
  const name = getAttribute(self, '_name_');
  const value = getAttribute(self, '_value_');
  const rendered = isTruthy(valueRepr) ? pyStr(callValue(valueRepr, [value])) : pyRepr(value);
  return `<${classOf(self).name}.${pyStr(name)}: ${rendered}>`;
});
pythonMethod(enumClass, '__str__', '', (self) => {
  if (self instanceof PyInstance && self.enumValue !== undefined) return enumStr(self);
  return `${classOf(self).name}.${pyStr(getAttribute(self, '_name_'))}`;
});
pythonMethod(enumClass, '__format__', 'format_spec', (self, [spec]) => {
  if (typeof spec !== 'string') throw typeError(`__format__() argument must be str, not ${argumentTypeName(spec)}`);
  return pyFormat(pyStr(self), spec);
});

function enumStr(member: PyInstance): string {
  const name = memberName(member);
  return name === None ? `${member.cls.name}(${pyRepr(memberValue(member))})` : `${member.cls.name}.${name as string}`;
}

defineMethod(enumClass, '__eq__', (self, [other]) => self === other);
defineValueHash(enumClass, (self) => pyHash(memberName(self)));
defineMethod(enumClass, '_missing_', () => None, 'class');
enumClass.dict.set(
  '_generate_next_value_',
  new PyDescriptor(
    staticmethodClass,
    new PyBuiltinFunction(
      functionClass,
      '_generate_next_value_',
      ([, start, , lastValues]) => {
        const items = (lastValues as PyList).items;
        if (items.length === 0) return start;
        let sortedList: PyList;
        try {
          sortedList = callValue(currentRuntime().builtins.get('sorted') as PyValue, [lastValues]) as PyList;
        } catch (error) {
          if (error instanceof PyError && error.exception.cls.isSubclassOf(exceptionClassNamed('TypeError'))) {
            throw typeError('unable to sort non-numeric values');
          }
          throw error;
        }
        const lastValue = sortedList.items.at(-1) as PyValue;
        try {
          return binaryOp('+', lastValue, 1n);
        } catch (error) {
          if (error instanceof PyError && error.exception.cls.isSubclassOf(exceptionClassNamed('TypeError'))) {
            throw typeError(`unable to increment ${pyRepr(lastValue)}`);
          }
          throw error;
        }
      },
      undefined,
      'static'
    )
  )
);

defineMethod(reprEnumClass, '__str__', (self) => pyStr(valueOrSelf(self)));
pythonMethod(reprEnumClass, '__format__', 'format_spec', (self, [spec]) => {
  if (typeof spec !== 'string') throw typeError(`__format__() argument must be str, not ${argumentTypeName(spec)}`);
  return pyFormat(valueOrSelf(self), spec);
});
for (const cls of [intEnumClass, strEnumClass]) {
  defineMethod(cls, '__eq__', (self, [other]) => keysEqual(memberValue(self), intEnumValue(other)));
  defineValueHash(cls, (self) => pyHash(memberValue(self)));
}
defineMethod(intEnumClass, '__index__', (self) => memberValue(self));
defineMethod(intEnumClass, '__int__', (self) => memberValue(self));
strEnumClass.dict.set(
  '_generate_next_value_',
  new PyDescriptor(
    staticmethodClass,
    new PyBuiltinFunction(
      functionClass,
      '_generate_next_value_',
      ([name]) => (name as string).toLowerCase(),
      undefined,
      'static'
    )
  )
);

// Flags -------------------------------------------------------------------------------------------------------------

function isSingleBit(value: PyValue): boolean {
  return typeof value === 'bigint' && value > 0n && (value & (value - 1n)) === 0n;
}

/** The bits of every single-bit member of a Flag class. */
function singlesMask(cls: PyClass): bigint {
  let mask = 0n;
  for (const member of cls.enumMembers ?? []) mask |= member.enumValue as bigint;
  return mask;
}

/** The bits of every integer member of a Flag class, multi-bit aliases included. */
function flagMask(cls: PyClass): bigint {
  let mask = 0n;
  for (const member of membersByName(cls).values()) {
    if (typeof member.enumValue === 'bigint') mask |= member.enumValue;
  }
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
  if ((value & ~mask) !== 0n && boundaryOf(cls) !== 'keep') throw invalidFlag(cls, value, mask);
  const member = new PyInstance(cls);
  member.enumValue = value;
  member.dict.set('_name_', pseudoFlagName(cls, value, singlesMask(cls)));
  cache.set(value, member);
  return member;
}

// code-gauge-allow functionCognitiveComplexity 26 -- Follows Flag._missing_ for single-bit members, multi-bit aliases, and unknown bits.
function pseudoFlagName(cls: PyClass, value: bigint, singles: bigint): string | typeof None {
  const aliases = value & ~singles;
  const memberBits = value & singles;
  const parts: PyInstance[] = [];
  let combined = 0n;
  if (memberBits !== 0n || aliases !== 0n) {
    for (const member of cls.enumMembers ?? []) {
      const bit = member.enumValue as bigint;
      if ((bit & memberBits) !== 0n) {
        parts.push(member);
        combined |= bit;
      }
    }
    if (aliases !== 0n) {
      for (const candidate of membersByName(cls).values()) {
        const candidateVal = candidate.enumValue;
        if (
          !parts.includes(candidate) &&
          typeof candidateVal === 'bigint' &&
          candidateVal !== 0n &&
          (candidateVal & value) === candidateVal
        ) {
          parts.push(candidate);
          combined |= candidateVal;
        }
      }
    }
  }
  if (combined === 0n) return None;
  const leftover = value ^ combined;
  const names = parts.map((part) => memberName(part) as string);
  if (leftover !== 0n) {
    if (boundaryOf(cls) === 'strict') {
      throw pyError('ValueError', `${pyRepr(cls)}: no members with value ${leftover}`);
    }
    names.push(String(leftover));
  }
  return names.join('|');
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
    const boundary = boundaryOf(owner);
    const inverted = boundary === 'eject' || boundary === 'keep' ? ~flagOf(self) : singlesMask(owner) & ~flagOf(self);
    return flagMember(owner, inverted);
  });
}
pythonMethod(flagClass, '__repr__', '', (self) => {
  const member = self as PyInstance;
  const name = memberName(member);
  const cls = member.cls.name;
  return `<${name === None ? cls : `${cls}.${name as string}`}: ${pyRepr(memberValue(member))}>`;
});
pythonMethod(flagClass, '__str__', '', (self) => enumStr(self as PyInstance));
pythonMethod(flagClass, '__contains__', 'other', (self, [other]) => {
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

pythonMethod(flagClass, '__iter__', '', (self) => {
  const value = flagOf(self);
  const members = ((self as PyInstance).cls.enumMembers ?? []).filter(
    (member) => ((member.enumValue as bigint) & value) !== 0n
  );
  return enumMemberGeneratorFromList(members, 'Flag.__iter__');
});

pythonMethod(flagClass, '__len__', '', (self) => {
  let bits = flagOf(self);
  if (bits < 0n) bits = -bits;
  let count = 0n;
  while (bits > 0n) {
    bits &= bits - 1n;
    count++;
  }
  return count;
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
  new PyDescriptor(
    staticmethodClass,
    new PyBuiltinFunction(
      functionClass,
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
  )
);
defineMethod(intFlagClass, '__str__', (self) => pyStr(valueOrSelf(self)));
defineMethod(intFlagClass, '__index__', (self) => memberValue(self));
defineMethod(intFlagClass, '__int__', (self) => memberValue(self));

function valueOrSelf(self: PyValue): PyValue {
  return self instanceof PyInstance && self.enumValue !== undefined ? self.enumValue : self;
}

// EnumType ----------------------------------------------------------------------------------------------------------

enumTypeClass.dict.set(
  '__members__',
  new PyDescriptor(
    propertyClass,
    new PyBuiltinFunction(functionClass, '__members__', ([cls]) => {
      const types = currentRuntime().importModule('types');
      const entries = [...membersByName(cls as PyClass)].map(([name, member]): [PyValue, PyValue] => [name, member]);
      return callValue(types.dict.get('MappingProxyType') as PyValue, [newDict(entries)]);
    })
  )
);

function enumMemberGeneratorFromList(members: PyInstance[], ownerQualified: string): PyValue {
  let index = 0;
  return new PyGenerator(
    generatorClass,
    '<genexpr>',
    `${ownerQualified}.<locals>.<genexpr>`,
    (input) => {
      if (input.error) throw input.error;
      return index < members.length ? { done: false, value: members[index++] } : { done: true, value: None };
    },
    () => members
  );
}

pythonMethod(enumTypeClass, '__contains__', 'value', (cls, [value]) => enumContains(cls as PyClass, value));
pythonMethod(enumTypeClass, '__iter__', '', (cls) => enumMemberGenerator(cls as PyClass, false));
pythonMethod(enumTypeClass, '__reversed__', '', (cls) => enumMemberGenerator(cls as PyClass, true));
pythonMethod(enumTypeClass, '__len__', '', (cls) => BigInt(((cls as PyClass).enumMembers ?? []).length));
pythonMethod(enumTypeClass, '__bool__', '', () => true);
pythonMethod(
  enumTypeClass,
  '__repr__',
  '',
  (cls) => `<${isFlagClass(cls as PyClass) ? 'flag' : 'enum'} '${(cls as PyClass).name}'>`
);
pythonMethod(enumTypeClass, '__getitem__', 'name', (cls, [name]) => {
  const member = typeof name === 'string' ? membersByName(cls as PyClass).get(name) : undefined;
  if (member === undefined) throw keyError(name);
  return member;
});
defineMethod(enumTypeClass, '__call__', (cls, args, kwargs) => enumLookup(cls as PyClass, args, kwargs), {
  receiver: 'unchecked',
});

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
// code-gauge-allow functionNcss 31 -- One case per EnumType class attribute.
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
      return newDict(lookupEntries(cls).filter(([val]) => isHashable(val)));
    }
    case '_member_type_': {
      return memberTypeOf(cls);
    }
    case '_use_args_': {
      return memberTypeOf(cls) !== objectClass;
    }
    case '_new_member_': {
      return getAttribute(memberTypeOf(cls), '__new__');
    }
    case '_value_repr_': {
      const type = memberTypeOf(cls);
      return type === objectClass ? None : (type.lookup('__repr__') ?? None);
    }
    case '_hashable_values_':
    case '_unhashable_values_':
    case '_unhashable_values_map_': {
      return hashableData(cls, name);
    }
    case '_flag_mask_': {
      return isFlagClass(cls) ? flagMask(cls) : undefined;
    }
    case '_singles_mask_': {
      return isFlagClass(cls) ? singlesMask(cls) : undefined;
    }
    case '_all_bits_': {
      return isFlagClass(cls) ? (1n << BigInt(flagMask(cls).toString(2).length)) - 1n : undefined;
    }
    default: {
      return undefined;
    }
  }
}

/** The data EnumType keeps in a member: its order among the members, and its class. */
export function enumMemberData(member: PyInstance, name: string): PyValue | undefined {
  if (name === '__objclass__') return member.cls;
  if (name === '_sort_order_') return BigInt((member.cls.enumMembers ?? []).indexOf(member));
  return undefined;
}

/** The type of the values of an Enum's members, as its first base that is no Enum gives. */
function memberTypeOf(cls: PyClass): PyClass {
  return cls.mro.find((base) => base !== objectClass && !isEnumClass(base) && base.isBuiltin) ?? objectClass;
}

/** The values of an Enum's members by whether they hash, which this grader keeps only for hashable values. */
function hashableData(cls: PyClass, name: string): PyValue {
  const values = [...new Set((cls.enumMembers ?? []).map((member) => member.enumValue as PyValue))];
  if (values.some((value) => !isHashable(value))) {
    throw new UnsupportedFeatureError(`ハッシュできない値の Enum の ${name}（EnumType の内部）`);
  }
  if (name === '_hashable_values_') return newList(values);
  return name === '_unhashable_values_' ? newList([]) : newDict([]);
}

function isHashable(value: PyValue): boolean {
  try {
    pyHash(value);
    return true;
  } catch {
    return false;
  }
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

/**
 * The int or str a member of an enum whose members CPython makes ints or strs (IntEnum, IntFlag, StrEnum) stands for,
 * which consumers such as JSON encoders read in place of the member; any other value as it is.
 */
export function builtinMemberValue(value: PyValue): PyValue {
  if (!(value instanceof PyInstance) || value.enumValue === undefined) return value;
  const memberType = enumClassData(value.cls, '_member_type_');
  return memberType === intClass || memberType === strClass ? value.enumValue : value;
}

/** Sets the members that iterating the class gives, which exclude aliases. */
export function setEnumMembers(cls: PyClass, members: PyInstance[]): void {
  cls.enumMembers = members;
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
