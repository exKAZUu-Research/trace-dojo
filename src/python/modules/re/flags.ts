// `re.RegexFlag`, an `enum.IntFlag` with the `KEEP` boundary whose members CPython shows as `re.IGNORECASE`.
import { createEnumMembers, enumTypeClass, intFlagClass, membersByName } from '../../enums';
import { hashInt } from '../../hashing';
import { attributeError, callValue, getAttribute, getAttributeOrUndefined } from '../../objects';
import { binaryOp } from '../../operators';
import type { Runtime } from '../../runtime';
import { currentRuntime } from '../../runtimeContext';
import { defineValueHash } from '../../slotWrappers';
import { classOf, defineMethod, None, NotImplemented, stringValue, typeClass, typeError, typeName } from '../../types';
import { PyClass, PyInstance, PyObject, type PyValue } from '../../values';
import { defineSlot } from '../numberSupport';

/** The members in definition order, with their aliases. */
const MEMBER_DEFINITIONS: [string, number, string | undefined][] = [
  ['NOFLAG', 0, undefined],
  // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- The name of the re.ASCII flag.
  ['ASCII', 256, 'A'],
  ['IGNORECASE', 2, 'I'],
  ['LOCALE', 4, 'L'],
  ['UNICODE', 32, 'U'],
  ['MULTILINE', 8, 'M'],
  ['DOTALL', 16, 'S'],
  ['VERBOSE', 64, 'X'],
  ['DEBUG', 128, undefined],
];
const CANONICAL = MEMBER_DEFINITIONS.filter(([, value]) => value !== 0);
const ALL_BITS = 511n;

interface FlagState {
  cls: PyClass;
  flags: Map<bigint, PyInstance>;
}

const states = new WeakMap<Runtime, FlagState>();

export function createRegexFlagClass(runtime: Runtime): PyClass {
  // A metaclass of its own shows the class as CPython shows a Flag class.
  const flagMetaclass = new PyClass('EnumType', [enumTypeClass], typeClass);
  flagMetaclass.mro = [flagMetaclass, ...enumTypeClass.mro];
  flagMetaclass.module = 'enum';
  defineMethod(flagMetaclass, '__repr__', (self) => `<flag '${(self as PyClass).name}'>`);

  const regexFlagClass = new PyClass('RegexFlag', [intFlagClass], flagMetaclass);
  regexFlagClass.mro = [regexFlagClass, ...intFlagClass.mro];
  regexFlagClass.module = 're';
  regexFlagClass.layout = { base: 'object' };
  // Not builtin, as a class that the program defines with enum.IntFlag, so that comparisons use its methods.
  regexFlagClass.isBuiltin = false;

  const flags = new Map<bigint, PyInstance>();
  states.set(runtime, { cls: regexFlagClass, flags });
  for (const [name, value, alias] of MEMBER_DEFINITIONS) {
    regexFlagClass.dict.set(name, BigInt(value));
    if (alias) regexFlagClass.dict.set(alias, BigInt(value));
  }
  createEnumMembers(regexFlagClass);
  for (const member of membersByName(regexFlagClass).values()) flags.set(member.enumValue as bigint, member);
  defineFlagMethods(regexFlagClass);
  return regexFlagClass;
}

function flagState(): FlagState {
  return states.get(currentRuntime()) as FlagState;
}

function newFlag(value: bigint, name: string | undefined): PyInstance {
  const { cls, flags } = flagState();
  const flag = new PyInstance(cls);
  flag.enumValue = value;
  flag.dict.set('_name_', name ?? None);
  flags.set(value, flag);
  return flag;
}

/** The flag with `value`, which a composite flag names by its members in definition order. */
export function flagOf(value: bigint): PyInstance {
  let bits = value;
  if (bits < 0n) {
    const width = 1n << BigInt((-bits).toString(2).length);
    bits = (width > ALL_BITS + 1n ? width : ALL_BITS + 1n) + bits;
  }
  const known = flagState().flags.get(bits);
  if (known) return known;
  const names = CANONICAL.filter(([, member]) => (bits & BigInt(member)) !== 0n).map(([name]) => name);
  const unknown = bits & ~510n;
  if (names.length === 0) return newFlag(bits, undefined);
  return newFlag(bits, unknown ? [...names, `0x${unknown.toString(16)}`].join('|') : names.join('|'));
}

export function flagValue(flag: PyValue): bigint {
  return (flag as PyInstance).enumValue as bigint;
}

export function isFlag(value: PyValue): value is PyInstance {
  return value instanceof PyInstance && value.cls === states.get(currentRuntime())?.cls;
}

function flagRepr(flag: PyValue): string {
  const name = (flag as PyInstance).dict.get('_name_');
  if (typeof name !== 'string') return `re.RegexFlag(${flagValue(flag)})`;
  return name
    .split('|')
    .map((part) => (/^\d/.test(part) ? part : `re.${part}`))
    .join('|');
}

function defineFlagMethods(regexFlagClass: PyClass): void {
  defineMethod(regexFlagClass, '__repr__', (self) => flagRepr(self));
  defineMethod(regexFlagClass, '__str__', (self) => flagRepr(self));
  // Slots rather than method descriptors, which format() and hash() would take for the builtin ones.
  defineSlot(regexFlagClass, '__format__', (self, [spec]) =>
    stringValue(spec) === '' ? flagRepr(self) : callValue(getAttribute(flagValue(self), '__format__'), [spec])
  );
  defineValueHash(regexFlagClass, (self) => hashInt(flagValue(self)));
  // EnumType.__call__ asks _missing_ for a value without a member, which KEEP turns into a combination.
  defineSlot(
    regexFlagClass,
    '_missing_',
    (_cls, [value]) => (typeof value === 'bigint' || typeof value === 'boolean' ? flagOf(BigInt(value)) : None),
    'class'
  );
  defineMethod(regexFlagClass, '__invert__', (self) => flagOf(-flagValue(self) - 1n));
  defineMethod(regexFlagClass, '__len__', (self) => BigInt(membersOf(self).length));
  defineMethod(regexFlagClass, '__contains__', (self, [other]) => {
    if (!isFlag(other)) {
      throw typeError(`unsupported operand type(s) for 'in': '${typeName(other)}' and 'RegexFlag'`);
    }
    return (flagValue(other) & flagValue(self)) === flagValue(other);
  });

  const BITWISE: [string, '|' | '&' | '^'][] = [
    ['or', '|'],
    ['and', '&'],
    ['xor', '^'],
  ];
  for (const [name, operator] of BITWISE) {
    defineMethod(regexFlagClass, `__${name}__`, (self, [other]) => bitwiseResult(operator, self, other, false));
    defineMethod(regexFlagClass, `__r${name}__`, (self, [other]) => bitwiseResult(operator, self, other, true));
  }

  // The attributes of int that are not methods, such as `real`, which RegexFlag inherits from int.
  defineMethod(regexFlagClass, '__getattr__', (self, [name]) => {
    const value = getAttributeOrUndefined(flagValue(self), name as string);
    if (value === undefined) throw attributeError(self, name as string);
    return value;
  });
}

function membersOf(flag: PyValue): PyInstance[] {
  const value = flagValue(flag);
  return CANONICAL.filter(([, member]) => (value & BigInt(member)) !== 0n).map(
    ([name]) => flagState().cls.dict.get(name) as PyInstance
  );
}

function bitwiseResult(operator: '|' | '&' | '^', self: PyValue, other: PyValue, reflected: boolean): PyValue {
  if (!isFlag(other) && typeof other !== 'bigint' && typeof other !== 'boolean') {
    if (other instanceof PyObject && !classOf(other).isBuiltin) return NotImplemented;
    const [left, right] = reflected ? [typeName(other), 'RegexFlag'] : ['RegexFlag', typeName(other)];
    throw typeError(`unsupported operand type(s) for ${operator}: '${left}' and '${right}'`);
  }
  return flagOf(binaryOp(operator, flagValue(self), isFlag(other) ? flagValue(other) : other) as bigint);
}
