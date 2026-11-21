import type { Core } from './compilerBase';
import type { FunctionSymbol, MemberSymbol, ParameterSymbol, PropertySymbol } from './symbols';
import { type ClassType, isNonNullClass, type KType, resolved } from './types';

interface PropertyAccessors {
  constant: boolean;
  customSetter: boolean;
}

const OBJECT = 'Ljava/lang/Object;';

const PRIMITIVES: Record<string, string> = {
  Boolean: 'Z',
  Byte: 'B',
  Char: 'C',
  Short: 'S',
  Int: 'I',
  Long: 'J',
  Float: 'F',
  Double: 'D',
};

const JVM_ALIASES: Record<string, string> = {
  'kotlin.collections.MutableIterable': 'java.lang.Iterable',
  'kotlin.collections.MutableIterator': 'java.util.Iterator',
  'kotlin.collections.ListIterator': 'java.util.ListIterator',
  'kotlin.collections.MutableListIterator': 'java.util.ListIterator',
  'kotlin.collections.MutableCollection': 'java.util.Collection',
  'kotlin.collections.Map.Entry': 'java.util.Map$Entry',
  'kotlin.collections.MutableMap.MutableEntry': 'java.util.Map$Entry',
};

const JVM_MEMBER_ALIASES: Readonly<Record<string, string>> = {
  'kotlin.CharSequence.get': 'charAt',
  'kotlin.CharSequence.length': 'length',
  'kotlin.Enum.name': 'name',
  'kotlin.Enum.ordinal': 'ordinal',
  'kotlin.collections.Collection.size': 'size',
  'kotlin.collections.List.size': 'size',
  'kotlin.collections.MutableCollection.size': 'size',
  'kotlin.collections.MutableList.size': 'size',
  'kotlin.collections.MutableList.removeAt': 'remove',
  'kotlin.collections.Set.size': 'size',
  'kotlin.collections.MutableSet.size': 'size',
  'kotlin.collections.Map.size': 'size',
  'kotlin.collections.Map.keys': 'keySet',
  'kotlin.collections.Map.values': 'values',
  'kotlin.collections.Map.entries': 'entrySet',
  'kotlin.collections.MutableMap.size': 'size',
  'kotlin.collections.MutableMap.keys': 'keySet',
  'kotlin.collections.MutableMap.values': 'values',
  'kotlin.collections.MutableMap.entries': 'entrySet',
};

export function jvmSignatures(core: Core, member: MemberSymbol, accessors?: PropertyAccessors): string[] {
  if (member.kind === 'function') {
    const alias = jvmMemberAlias(member);
    return alias
      ? [functionSignature(core, member), functionSignature(core, member, alias)]
      : [functionSignature(core, member)];
  }
  if (accessors?.constant || !member.type) return [];
  return propertySignatures(core, member, accessors?.customSetter === true);
}

export function jvmParameterDescriptor(core: Core, parameter: ParameterSymbol): string {
  const descriptor = typeDescriptor(core, parameter.type);
  return parameter.isVararg ? `[${descriptor}` : descriptor;
}

function functionSignature(core: Core, member: FunctionSymbol, name = member.name): string {
  const inputs = [
    ...(member.extensionReceiver ? [member.extensionReceiver] : []),
    ...member.params.map((parameter) => parameter.type),
  ];
  const result = member.returnType && resolved(member.returnType);
  const descriptor = isNonNullClass(result, core.unit) ? 'V' : typeDescriptor(core, result);
  const parameters = [
    ...(member.extensionReceiver ? [typeDescriptor(core, member.extensionReceiver)] : []),
    ...member.params.map((param) => jvmParameterDescriptor(core, param)),
  ].join('');
  return `${jvmName(member, name, [...inputs, ...(result && member.owner ? [result] : [])])}(${parameters})${descriptor}`;
}

function propertySignatures(core: Core, member: PropertySymbol, customSetter: boolean): string[] {
  const type = member.type as KType;
  const descriptor = typeDescriptor(core, type);
  const booleanName = /^is[^a-z]/.test(member.name);
  const baseName = booleanName ? member.name.slice(2) : capitalize(member.name);
  const receiver = member.extensionReceiver ? [member.extensionReceiver] : [];
  const parameters = receiver.map((type) => typeDescriptor(core, type)).join('');
  const signatures: string[] = [];
  if (member.visibility !== 'private' || member.hasCustomGetter) {
    const get = booleanName ? member.name : `get${baseName}`;
    signatures.push(`${jvmName(member, get, [...receiver, type])}(${parameters})${descriptor}`);
    const alias = jvmMemberAlias(member);
    if (alias) signatures.push(`${alias}(${parameters})${descriptor}`);
  }
  if (member.isVar && ((member.visibility !== 'private' && member.setterVisibility !== 'private') || customSetter)) {
    signatures.push(`${jvmName(member, `set${baseName}`, [...receiver, type])}(${parameters}${descriptor})V`);
  }
  return signatures;
}

function jvmMemberAlias(member: MemberSymbol): string | undefined {
  const owner = member.owner;
  return owner?.isLibrary ? JVM_MEMBER_ALIASES[`${owner.kotlinName}.${member.name}`] : undefined;
}

function jvmName(member: MemberSymbol, name: string, types: KType[]): string {
  const internal =
    member.owner &&
    member.visibility === 'internal' &&
    member.overridden.every((base) => base.visibility === 'internal');
  const valueTypes = types.map((type) => {
    const actual = resolved(type);
    return actual.kind === 'class' && actual.cls.isValue
      ? `${actual.cls.qualifiedName}${actual.nullable ? '?' : ''}`
      : '';
  });
  const mangled = valueTypes.some(Boolean) ? `#${valueTypes.join(',')}` : '';
  return `${name}${internal ? '$main' : ''}${mangled}`;
}

function capitalize(name: string): string {
  return name.replace(/^[a-z]/, (first) => first.toUpperCase());
}

function typeDescriptor(core: Core, input: KType | undefined, boxed = false): string {
  if (!input) return OBJECT;
  const type = resolved(input);
  switch (type.kind) {
    case 'class': {
      return classDescriptor(core, type, boxed);
    }
    case 'function': {
      const arity = type.params.length + Number(type.receiver !== undefined);
      return arity > 22 ? 'Lkotlin/jvm/functions/FunctionN;' : `Lkotlin/jvm/functions/Function${arity};`;
    }
    case 'nothing': {
      return 'Ljava/lang/Void;';
    }
    case 'param': {
      const bound =
        type.param.bounds.find((candidate) => {
          const actual = resolved(candidate);
          return actual.kind === 'class' && !actual.cls.isInterface;
        }) ?? type.param.bounds[0];
      return typeDescriptor(core, bound, true);
    }
    case 'variable': {
      return OBJECT;
    }
  }
}

function classDescriptor(core: Core, type: ClassType, boxed: boolean): string {
  if (type.cls === core.array) {
    const element = type.args[0];
    const component =
      element && (element.variance === 'inv' || element.variance === 'out')
        ? typeDescriptor(core, element.type, true)
        : OBJECT;
    return `[${component}`;
  }
  const primitive = type.cls.isLibrary && PRIMITIVES[type.cls.name];
  if (primitive && !type.nullable && !boxed) return primitive;
  const name = JVM_ALIASES[type.cls.kotlinName] ?? type.cls.qualifiedName;
  if (name.startsWith('[')) return name.replaceAll('.', '/');
  return `L${name.replaceAll('.', '/')};`;
}
