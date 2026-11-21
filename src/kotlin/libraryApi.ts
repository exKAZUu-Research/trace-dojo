import { unavailableJavaFeature } from './convertSupport';
import { libraryDeclarationNames, libraryMemberNames } from './libraryApiData';
import type { ClassSymbol, TypeParameterSymbol } from './symbols';
import { type KType, resolved, typeToString } from './types';

const memberLabels = new Map([
  ['asSequence', 'シーケンス（asSequence）'],
  ['filterIsInstance', '型で要素を絞り込む filterIsInstance'],
  ['toRegex', '正規表現（toRegex）'],
  ['toSortedMap', '並べ替えた Map（toSortedMap）'],
  ['toSortedSet', '並べ替えた Set（toSortedSet）'],
]);

export function unavailableLibraryMember(type: KType, name: string): string | undefined {
  if (hasLibraryMember(type, name, new Set())) {
    return memberLabels.get(name) ?? `${typeToString(type)} の ${name}`;
  }
}

export function isKnownLibraryPackage(path: string): boolean {
  return Object.hasOwn(libraryDeclarationNames, path);
}

export function knownLibraryDeclaration(path: string, visiblePackages: readonly string[][]): string | undefined {
  const separator = path.lastIndexOf('.');
  if (separator !== -1) {
    if (hasName(libraryDeclarationNames, path.slice(0, separator), path.slice(separator + 1))) return path;
    return undefined;
  }
  for (const packages of visiblePackages) {
    for (const pkg of packages) {
      if (hasName(libraryDeclarationNames, pkg, path)) return `${pkg}.${path}`;
    }
  }
}

export function unavailableQualifiedLibraryMember(
  cls: ClassSymbol,
  holder: ClassSymbol | undefined,
  name: string
): string | undefined {
  return (
    unavailableJavaFeature(`${cls.kotlinName}.${name}`) ??
    (holder && knownLibraryMember(holder, name) ? `${cls.name}.${name}` : undefined)
  );
}

function knownLibraryMember(cls: ClassSymbol, name: string): boolean {
  return cls.isLibrary && hasName(libraryMemberNames, cls.kotlinName, name);
}

function hasLibraryMember(type: KType, name: string, visited: Set<ClassSymbol | TypeParameterSymbol>): boolean {
  const actual = resolved(type);
  if (actual.kind === 'param') {
    if (visited.has(actual.param)) return false;
    visited.add(actual.param);
    return actual.param.bounds.some((bound) => hasLibraryMember(bound, name, visited));
  }
  if (actual.kind !== 'class' || visited.has(actual.cls)) return false;
  const { cls } = actual;
  visited.add(cls);
  return knownLibraryMember(cls, name) || cls.supertypes.some((parent) => hasLibraryMember(parent, name, visited));
}

function hasName(index: Readonly<Record<string, string>>, owner: string, name: string): boolean {
  return Object.hasOwn(index, owner) && index[owner].split(' ').includes(name);
}
