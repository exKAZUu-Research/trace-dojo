import type { MemberRef } from './compilerCore';
import { overriddenMembers } from './jvmSignatures';
import type { ClassSymbol, MemberSymbol, PropertySymbol } from './symbols';
import { isSameType, isSubtype } from './typeRelations';
import { type ClassType, type KType, substitute } from './types';

export interface InheritedBridge {
  cls: ClassSymbol;
  implementation: MemberRef;
  contract: MemberRef;
}

export function linkInheritedMembers(
  cls: ClassSymbol,
  lookup: (parent: ClassType, name: string, kind: MemberSymbol['kind']) => MemberRef[],
  reportConflict: (name: string) => never
): InheritedBridge[] {
  const parents = cls.supertypes;
  if (parents.length < 2) return [];
  const bridges: InheritedBridge[] = [];
  const checked = new Set<string>();
  for (const { kind, name } of cls.vtable.keys()) {
    const key = `${kind}:${name}`;
    if (checked.has(key)) continue;
    checked.add(key);
    const inherited = parents.flatMap((parent) => lookup(parent, name, kind));
    const defaults = inherited.filter(
      ({ symbol }) => !symbol.isAbstract && symbol.visibility !== 'private' && cls.dispatch(symbol).owner !== cls
    );
    if (hasConflictingDefaults(defaults)) reportConflict(name);
    bridges.push(...linkInheritedBridges(cls, inherited, defaults));
  }
  return bridges;
}

function linkInheritedBridges(cls: ClassSymbol, inherited: MemberRef[], defaults: MemberRef[]): InheritedBridge[] {
  const superclassMembers = defaults.filter(({ symbol }) => symbol.owner && !symbol.owner.isInterface);
  if (superclassMembers.length === 0) return [];
  const bridges: InheritedBridge[] = [];
  for (const contract of inherited) {
    const base = contract.symbol;
    const current = cls.dispatch(base);
    if (!base.owner?.isInterface || !current.isAbstract || current.owner === cls) continue;
    const implementation = superclassMembers.find((member) => sameInheritedSignature(member, contract));
    if (!implementation) continue;
    cls.vtable.set(base.root, implementation.symbol);
    bridges.push({ cls, implementation, contract });
  }
  return bridges;
}

export function mostSpecificProperties(properties: MemberRef<PropertySymbol>[]): MemberRef<PropertySymbol>[] {
  const unique = new Map(properties.filter(({ symbol }) => !symbol.isAbstract).map((ref) => [ref.symbol, ref]));
  const concrete = [...unique.values()];
  return concrete.filter(
    ({ symbol }) =>
      !concrete.some(
        ({ symbol: other }) =>
          symbol.owner && other.owner && other.owner !== symbol.owner && other.owner.isSubclassOf(symbol.owner)
      )
  );
}

export function aliasedOverrides(cls: ClassSymbol, bases: MemberSymbol[]): MemberSymbol[] {
  const targets = new Set(bases.map((base) => cls.dispatch(base)));
  const expanded = new Set(bases);
  for (const [root, target] of cls.vtable) {
    if (targets.has(target)) expanded.add(root);
  }
  return [...expanded];
}

export function prefersImplementation(implementation: MemberSymbol, inherited: MemberSymbol | undefined): boolean {
  if (!inherited || overriddenMembers(implementation).has(inherited)) return true;
  return inherited.isAbstract && !implementation.isAbstract && !overriddenMembers(inherited).has(implementation);
}

function hasConflictingDefaults(defaults: MemberRef[]): boolean {
  const overrides = new Map(defaults.map(({ symbol }) => [symbol, overriddenMembers(symbol)]));
  for (const [index, first] of defaults.entries()) {
    for (const second of defaults.slice(index + 1)) {
      if (first.symbol === second.symbol) continue;
      if (overrides.get(first.symbol)?.has(second.symbol) || overrides.get(second.symbol)?.has(first.symbol)) continue;
      if (sameInheritedSignature(first, second)) return true;
    }
  }
  return false;
}

function sameInheritedSignature(first: MemberRef, second: MemberRef): boolean {
  const left = first.symbol;
  const right = second.symbol;
  if (left.kind !== right.kind) return false;
  const rightTypes = new Map(second.substitution);
  if (left.kind === 'function' && right.kind === 'function') {
    if (left.typeParameters.length !== right.typeParameters.length || left.params.length !== right.params.length)
      return false;
    for (const [index, param] of right.typeParameters.entries()) {
      rightTypes.set(param, { kind: 'param', param: left.typeParameters[index], nullable: false });
    }
    const sameParameters = left.params.every((param, index) =>
      isSameType(substitute(param.type, first.substitution), substitute(right.params[index].type, rightTypes))
    );
    if (!sameParameters) return false;
  }
  if (!left.extensionReceiver || !right.extensionReceiver) return left.extensionReceiver === right.extensionReceiver;
  return isSameType(
    substitute(left.extensionReceiver, first.substitution),
    substitute(right.extensionReceiver, rightTypes)
  );
}

export function fitsInheritedContract(implementation: MemberRef, contract: MemberRef): boolean {
  const target = implementation.symbol;
  const base = contract.symbol;
  const actual = resultType(implementation);
  const expected = resultType(contract);
  if (base.kind === 'property' && base.isVar) {
    return target.kind === 'property' && target.isVar && (!actual || !expected || isSameType(actual, expected));
  }
  return !actual || !expected || isSubtype(actual, expected);
}

export function resultType({ symbol, substitution }: MemberRef): KType | undefined {
  const declared = symbol.kind === 'function' ? symbol.returnType : symbol.type;
  return declared && substitute(declared, substitution);
}
