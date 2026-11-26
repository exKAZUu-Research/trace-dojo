import { DOTNET_MEMBERS, DOTNET_TYPES } from './library/dotnetNames';
import { DOTNET_OVERLOADS } from './library/dotnetOverloads';

/** What learners call the .NET features this grader rejects, by the namespace of their types. */
const FEATURES_BY_NAMESPACE: Record<string, string> = {
  'System.Net.Http': 'ネットワーク',
  'System.Threading': 'スレッド',
  'System.Threading.Tasks': '並列処理',
  'System.Diagnostics': '処理系の診断',
  'System.Numerics': 'System.Numerics',
  'System.Globalization': 'カルチャの指定',
};

/** The .NET types by simple name, without their arity. */
const TYPES_BY_NAME = new Map<string, string[]>();
for (const fullName of DOTNET_TYPES) {
  const name = fullName.slice(fullName.lastIndexOf('.') + 1).replace(/`\d+$/, '');
  const types = TYPES_BY_NAME.get(name);
  if (types) types.push(fullName);
  else TYPES_BY_NAME.set(name, [fullName]);
}

/**
 * Describes a .NET library type that this grader lacks, by its dotted name or by a simple name that a namespace in
 * scope would give it, or returns undefined for a name .NET does not have either, or a type the grader has that the
 * program did not import, which are ordinary errors.
 */
export function unavailableTypeOf(
  name: string,
  simpleName: string,
  isAvailable: (fullName: string) => boolean,
  isNamespaceInScope: (namespace: string) => boolean
): string | undefined {
  const fullName = name.includes('.')
    ? DOTNET_TYPES.find((type) => type.replace(/`\d+$/, '') === name)
    : TYPES_BY_NAME.get(simpleName)?.find((type) => isNamespaceInScope(type.slice(0, type.lastIndexOf('.'))));
  if (!fullName || isAvailable(fullName.replace(/`\d+$/, ''))) return undefined;
  const namespace = fullName.slice(0, fullName.lastIndexOf('.'));
  const display = fullName.replace(/`\d+$/, '');
  const feature = FEATURES_BY_NAMESPACE[namespace];
  return feature ? `${feature}（${display}）` : display;
}

/** The namespaces of .NET's types and the namespaces around them, such as `System.Threading` and `System`. */
const DOTNET_NAMESPACES = new Set(
  DOTNET_TYPES.flatMap((fullName) => {
    const parts = fullName.split('.').slice(0, -1);
    return parts.map((_part, index) => parts.slice(0, index + 1).join('.'));
  })
);

/** Whether .NET has a namespace of a dotted name. */
export function isDotnetNamespace(name: string): boolean {
  return DOTNET_NAMESPACES.has(name);
}

/** A .NET overload by its parameters' metadata names, `*` for one involving generics. */
export interface DotnetOverload {
  required: number;
  /** Whether the last parameter is a params array. */
  takesMore: boolean;
  types: string[];
}

/** .NET's overloads of a type's method (or `.ctor`), leaving out those that take a pointer or a span. */
export function dotnetOverloadsOf(fullName: string, member: string): DotnetOverload[] {
  const entry = DOTNET_OVERLOADS[fullName]?.split(';').find((overloads) => overloads.startsWith(`${member}=`));
  if (!entry) return [];
  return entry
    .slice(member.length + 1)
    .split(',')
    .map((overload) => {
      const [count, types] = overload.split(':');
      return {
        required: Number.parseInt(count, 10),
        takesMore: count.endsWith('+'),
        types: types ? types.split('|') : [],
      };
    });
}

/** Whether .NET's type of a full metadata name has a public member of the name. */
export function isKnownLibraryMember(fullName: string, member: string): boolean {
  const members = DOTNET_MEMBERS[fullName];
  return members !== undefined && members.split(',').includes(member);
}
