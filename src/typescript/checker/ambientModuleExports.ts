import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { ExecutionBudget } from '../../interpreter/limits';
import { isInstantiatedNamespace } from '../namespaceInstantiation';
import { unsupportedMessage } from '../unsupported';
import type { Checker } from './checker';
import { unavailableNodeMember } from './nodeLibrary';
import { canonicalIdentifier, type MeaningSpace, type Scope, Sym } from './scopes';
import { named, stringValue } from './syntax';
import { anyType, errorType, type Type } from './types';

interface DefaultExportSymbols {
  value?: Sym;
  type?: Sym;
  namespace?: Sym;
}

export interface DefaultExportLookup {
  scope: Scope;
  exports: Scope;
  scopeOf: (site: TreeNode) => Scope;
  budget?: ExecutionBudget;
  findModule?: (specifier: string) => Sym | undefined;
  isLibraryModule?: (module: Sym) => boolean;
}

/** Binds an unnamed `export default class / abstract class / function` inside an ambient module under `'default'`. */
export function bindAnonymousDefaultDeclaration(
  declaration: TreeNode,
  scope: Scope,
  exportNamed: (exportName: string, symbol: Sym, meaning: MeaningSpace) => void
): void {
  if (declaration.type === 'class_declaration' || declaration.type === 'abstract_class_declaration') {
    const symbol = scope.defaultTypeSymbol ?? new Sym('default', scope);
    symbol.valueKind = 'class';
    if (!symbol.valueDeclarations.includes(declaration)) {
      symbol.valueDeclarations.push(declaration);
      symbol.valueEntries.push({ kind: 'class', name: declaration });
    }
    symbol.typeKind = 'class';
    if (!symbol.typeDeclarations.includes(declaration)) {
      symbol.typeDeclarations.push(declaration);
      symbol.typeEntries.push({ kind: 'class', name: declaration });
    }
    exportNamed('default', symbol, 'value');
    exportNamed('default', symbol, 'type');
    return;
  }
  if (
    declaration.type === 'function_signature' ||
    declaration.type === 'function_declaration' ||
    declaration.type === 'generator_function_declaration'
  ) {
    const existing = (scope.namespace as Sym).namespaceExports?.values.get('default');
    const symbol = existing?.valueKind === 'function' ? existing : new Sym('default', scope);
    symbol.valueKind = 'function';
    symbol.valueDeclarations.push(declaration);
    symbol.valueEntries.push({ kind: 'function', name: declaration });
    exportNamed('default', symbol, 'value');
  }
}

/** Binds `export default Target;` in an ambient body after all declarations in the program have been bound. */
export function bindAmbientDefaultValueExport(node: TreeNode, lookup: DefaultExportLookup): boolean {
  if (!node.children.some((part) => !part.isNamed && part.type === 'default')) return false;
  const value = node.childForFieldName('value');
  if (!value) return false;
  const resolved = resolveAmbientEntityInBinder(node, value, lookup);
  const { exports } = lookup;
  let added = false;
  if (resolved.value && !exports.values.has('default')) {
    exports.exportViaClause('default', resolved.value, 'value');
    added = true;
  }
  if (resolved.type && !exports.types.has('default')) {
    exports.exportViaClause('default', resolved.type, 'type');
    added = true;
  }
  if (resolved.namespace && !exports.namespaces.has('default')) {
    exports.exportViaClause('default', resolved.namespace, 'namespace');
    added = true;
  }
  if (resolved.value || resolved.type || resolved.namespace) {
    exports.recordClauseExport('default', value, resolved);
  }
  return added;
}

export function resolveAmbientEntityInBinder(
  node: TreeNode,
  target: TreeNode,
  lookup: DefaultExportLookup
): DefaultExportSymbols {
  const path = entityNamePath(target);
  if (!path) return {};
  return path.length === 1
    ? resolveSingleDefaultTarget(path[0], lookup)
    : resolveQualifiedDefaultTarget(node, target, path, lookup);
}

export function resolveBinderEntityMeaning(
  target: TreeNode,
  meaning: MeaningSpace,
  lookup: DefaultExportLookup,
  seen = new Set<string>()
): Sym | undefined {
  const path = entityNamePath(target);
  if (!path) return undefined;
  return resolveBinderEntityPath(path, meaning, lookup, seen);
}

function resolveSingleDefaultTarget(ident: TreeNode, lookup: DefaultExportLookup): DefaultExportSymbols {
  const localName = canonicalIdentifier(ident.text, ident);
  return {
    value: unaliasInBinder(lookupInBodyOrExports(lookup, localName, 'value'), 'value', lookup),
    type: unaliasInBinder(lookupInBodyOrExports(lookup, localName, 'type'), 'type', lookup),
    namespace: unaliasInBinder(lookupInBodyOrExports(lookup, localName, 'namespace'), 'namespace', lookup),
  };
}

function resolveQualifiedDefaultTarget(
  node: TreeNode,
  valueNode: TreeNode,
  path: TreeNode[],
  lookup: DefaultExportLookup
): DefaultExportSymbols {
  const rootName = canonicalIdentifier(path[0].text, path[0]);
  const rootValue = unaliasInBinder(lookupInBodyOrExports(lookup, rootName, 'value'), 'value', lookup);
  const hasRuntimeRoot = Boolean(
    rootValue && (rootValue.valueKind !== 'namespace' || isInstantiatedNamespace(rootValue))
  );
  const rootContainer = lookupContainerFromScope(lookup.scope, lookup.exports, rootName, lookup);
  const container = rootContainer ? walkQualifiedDefaultFromRoot(rootContainer, path, lookup) : undefined;
  if (container) {
    const entity = resolveQualifiedFinalMember(container, path.at(-1) as TreeNode, lookup);
    if (entity.value) return entity;
    if (hasNonNamespaceValue(container)) {
      return { ...entity, value: syntheticDefaultValueSymbol(node, valueNode, lookup.scope) };
    }
    if ((entity.type || entity.namespace) && hasRuntimeRoot && rootValue !== rootContainer) return entity;
    if (rootValue === rootContainer) return {};
  }
  if (!hasRuntimeRoot) return {};
  return { value: syntheticDefaultValueSymbol(node, valueNode, lookup.scope) };
}

function walkQualifiedDefaultFromRoot(root: Sym, path: TreeNode[], lookup: DefaultExportLookup): Sym | undefined {
  let current: Sym | undefined = root;
  if (!isAddressableContainer(current, path.length === 2)) return undefined;
  for (let index = 1; index < path.length - 1; index++) {
    lookup.budget?.spend();
    if (!current.namespaceExports) return undefined;
    const partName = canonicalIdentifier(path[index].text, path[index]);
    current = lookupContainerInExports(current.namespaceExports, partName, lookup);
    if (!current || !isAddressableContainer(current, index === path.length - 2)) return undefined;
  }
  return current;
}

function lookupContainerFromScope(
  startScope: Scope,
  moduleExports: Scope,
  name: string,
  lookup: DefaultExportLookup,
  seen = new Set<string>()
): Sym | undefined {
  for (let current: Scope | undefined = startScope; current; current = current.parent) {
    lookup.budget?.spend();
    const found = scopeContainerAt(current, name, current === moduleExports, lookup, seen);
    if (found) return found;
  }
  return unaliasContainer(startScope.lookupContainer(name, lookup.budget), lookup, seen);
}

function scopeContainerAt(
  scope: Scope,
  name: string,
  allowClause: boolean,
  lookup: DefaultExportLookup,
  seen: Set<string>
): Sym | undefined {
  const ns = !allowClause && scope.isClauseOnlyExport(name, 'namespace') ? undefined : scope.namespaces.get(name);
  const resolvedNs = unaliasInBinder(ns, 'namespace', lookup, seen);
  if (resolvedNs?.namespaceExports) return resolvedNs;
  const val = !allowClause && scope.isClauseOnlyExport(name, 'value') ? undefined : scope.values.get(name);
  if (!val || (val.valueKind !== 'enum' && val.valueKind !== 'importAlias' && val.valueKind !== 'import'))
    return undefined;
  return unaliasContainer(val, lookup, seen);
}

function unaliasContainer(symbol: Sym | undefined, lookup: DefaultExportLookup, seen: Set<string>): Sym | undefined {
  if (!symbol) return undefined;
  if (symbol.namespaceKind === 'importAlias' || symbol.namespaceKind === 'import') {
    const ns = unaliasInBinder(symbol, 'namespace', lookup, seen);
    if (ns?.namespaceExports) return ns;
  }
  const val = unaliasInBinder(symbol, 'value', lookup, seen);
  return val?.namespaceExports || val?.valueKind === 'enum' ? val : undefined;
}

function lookupContainerInExports(
  exports: Scope,
  name: string,
  lookup: DefaultExportLookup,
  seen = new Set<string>()
): Sym | undefined {
  const ns = unaliasInBinder(exports.namespaces.get(name), 'namespace', lookup, seen);
  if (ns?.namespaceExports) return ns;
  return unaliasContainer(exports.values.get(name), lookup, seen);
}

function isAddressableContainer(symbol: Sym, beforeLast: boolean): boolean {
  if (symbol.valueKind === 'enum' && beforeLast) return true;
  return Boolean(symbol.namespaceExports);
}

function hasNonNamespaceValue(symbol: Sym): boolean {
  return symbol.valueEntries.some((entry) => entry.kind !== 'namespace');
}

function resolveQualifiedFinalMember(
  container: Sym,
  lastNode: TreeNode,
  lookup: DefaultExportLookup
): DefaultExportSymbols {
  const lastName = canonicalIdentifier(lastNode.text, lastNode);
  const enumMember = enumMemberNamed(container, lastName);
  if (!container.namespaceExports) return enumMember ? { value: enumMember, type: enumMember } : {};
  const type = unaliasInBinder(container.namespaceExports.types.get(lastName), 'type', lookup);
  const namespace = unaliasInBinder(container.namespaceExports.namespaces.get(lastName), 'namespace', lookup);
  const value = exportedRuntimeValue(container.namespaceExports, lastName, lookup) ?? enumMember;
  if (value) return { value, type: type ?? enumMember, namespace };
  return { type, namespace };
}

function enumMemberNamed(container: Sym, name: string): Sym | undefined {
  return container.valueKind === 'enum' ? container.enumMembers?.values.get(name) : undefined;
}

function exportedRuntimeValue(exports: Scope, name: string, lookup: DefaultExportLookup): Sym | undefined {
  const value = unaliasInBinder(exports.values.get(name), 'value', lookup);
  if (!value || (value.valueKind === 'namespace' && !isInstantiatedNamespace(value))) return undefined;
  return value;
}

function syntheticDefaultValueSymbol(node: TreeNode, valueNode: TreeNode, scope: Scope): Sym {
  const symbol = new Sym('default', scope);
  symbol.valueKind = 'const';
  symbol.valueDeclarations.push(node);
  symbol.valueEntries.push({ kind: 'const', name: valueNode });
  return symbol;
}

function lookupInBodyOrExports(lookup: DefaultExportLookup, name: string, meaning: MeaningSpace): Sym | undefined {
  return (
    lookup.scope.tableOf(meaning).get(name) ??
    lookup.exports.tableOf(meaning).get(name) ??
    lookupScopeMeaning(lookup.scope, name, meaning, lookup.budget)
  );
}

function unaliasInBinder(
  symbol: Sym | undefined,
  meaning: MeaningSpace,
  lookup: DefaultExportLookup,
  seen = new Set<string>()
): Sym | undefined {
  if (!symbol) return undefined;
  const kind =
    meaning === 'value' ? symbol.valueKind : meaning === 'namespace' ? symbol.namespaceKind : symbol.typeKind;
  if (kind === 'import') return unaliasImportSymbolInBinder(symbol, meaning, lookup, seen);
  if (kind !== 'importAlias') return symbol;
  const declaration =
    symbol.valueDeclarations.find((decl) => decl.type === 'import_alias') ??
    symbol.typeDeclarations.find((decl) => decl.type === 'import_alias') ??
    symbol.namespaceDeclarations.find((decl) => decl.type === 'import_alias');
  const target = declaration ? named(declaration)[1] : undefined;
  const path = target ? entityNamePath(target) : undefined;
  const key = declaration ? `${declaration.id}:${meaning}` : undefined;
  if (!key || !path || seen.has(key)) return undefined;
  seen.add(key);
  try {
    return resolveBinderEntityPath(path, meaning, lookup, seen);
  } finally {
    seen.delete(key);
  }
}

function unaliasImportSymbolInBinder(
  symbol: Sym,
  meaning: MeaningSpace,
  lookup: DefaultExportLookup,
  seen: Set<string>
): Sym | undefined {
  const target = symbol.importTarget;
  if (!target || !lookup.findModule) return undefined;
  if (meaning === 'value' && target.typeOnly) return undefined;
  const key = `imp:${symbol.id}:${meaning}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  try {
    const dep = lookup.findModule(target.module);
    if (!dep) return undefined;
    return resolveImportedModuleMemberInBinder(dep, target.name, meaning, lookup, seen);
  } finally {
    seen.delete(key);
  }
}

function resolveImportedModuleMemberInBinder(
  dep: Sym,
  name: string,
  meaning: MeaningSpace,
  lookup: DefaultExportLookup,
  seen: Set<string>
): Sym | undefined {
  if (dep.exportEquals) return resolveImportedExportEqualsInBinder(dep, name, meaning, lookup, seen);
  if (name === '*') return meaning === 'type' ? undefined : dep;
  const depExports = dep.namespaceExports;
  if (name === 'default' && !depExports?.values.has('default') && lookup.isLibraryModule?.(dep)) {
    return meaning === 'type' ? undefined : dep;
  }
  return unaliasInBinder(depExports?.tableOf(meaning).get(name), meaning, lookup, seen);
}

function resolveImportedExportEqualsInBinder(
  dep: Sym,
  name: string,
  meaning: MeaningSpace,
  lookup: DefaultExportLookup,
  seen: Set<string>
): Sym | undefined {
  const eqTarget = dep.exportEquals;
  const eqPath = eqTarget ? entityNamePath(eqTarget) : undefined;
  if (!eqTarget || !eqPath) return undefined;
  const eqLookup: DefaultExportLookup = {
    ...lookup,
    scope: lookup.scopeOf(eqTarget),
    exports: dep.namespaceExports ?? lookup.exports,
  };
  if (name === '*' || name === 'default') return resolveBinderEntityPath(eqPath, meaning, eqLookup, seen);
  const container =
    resolveBinderEntityPath(eqPath, 'namespace', eqLookup, seen) ??
    resolveBinderEntityPath(eqPath, 'value', eqLookup, seen);
  return unaliasInBinder(container?.namespaceExports?.tableOf(meaning).get(name), meaning, lookup, seen);
}

function resolveBinderEntityPath(
  path: TreeNode[],
  meaning: MeaningSpace,
  lookup: DefaultExportLookup,
  seen: Set<string>
): Sym | undefined {
  const [root, ...rest] = path;
  const scope = lookup.scopeOf(root);
  const rootName = canonicalIdentifier(root.text, root);
  if (rest.length === 0) {
    const direct =
      scope === lookup.scope
        ? lookupInBodyOrExports(lookup, rootName, meaning)
        : lookupScopeMeaning(scope, rootName, meaning, lookup.budget);
    return unaliasInBinder(direct, meaning, lookup, seen);
  }
  let current = lookupContainerFromScope(scope, lookup.exports, rootName, lookup, seen);
  for (let index = 0; index < rest.length - 1; index++) {
    lookup.budget?.spend();
    const partName = canonicalIdentifier(rest[index].text, rest[index]);
    current = current?.namespaceExports
      ? lookupContainerInExports(current.namespaceExports, partName, lookup, seen)
      : undefined;
  }
  return current ? resolveBinderFinalMember(current, rest.at(-1) as TreeNode, meaning, lookup, seen) : undefined;
}

function lookupScopeMeaning(
  scope: Scope,
  name: string,
  meaning: MeaningSpace,
  budget?: ExecutionBudget
): Sym | undefined {
  if (meaning === 'value') return scope.lookupValue(name, budget);
  return meaning === 'namespace' ? scope.lookupNamespace(name, budget) : scope.lookupType(name);
}

function resolveBinderFinalMember(
  current: Sym,
  part: TreeNode,
  meaning: MeaningSpace,
  lookup: DefaultExportLookup,
  seen: Set<string>
): Sym | undefined {
  const partName = canonicalIdentifier(part.text, part);
  if (current.namespaceExports) {
    const exported = unaliasInBinder(current.namespaceExports.tableOf(meaning).get(partName), meaning, lookup, seen);
    if (exported) {
      if (meaning === 'value' && exported.valueKind === 'namespace' && !isRuntimeNamespaceSymbol(exported)) {
        return undefined;
      }
      return exported;
    }
  }
  return meaning === 'value' || meaning === 'type' ? enumMemberNamed(current, partName) : undefined;
}

function isRuntimeNamespaceSymbol(symbol: Sym): boolean {
  return (
    symbol.valueDeclarations.some((decl) => decl.childForFieldName('name')?.type === 'string') ||
    isInstantiatedNamespace(symbol)
  );
}

/** Checks the target of `export default X` or `export = X` in an ambient context, which may name a value, type, or namespace. */
export function checkAmbientExportTarget(c: Checker, target: TreeNode): void {
  const path = entityNamePath(target);
  if (!path) {
    c.error(target, 'エクスポートの代入の式は、環境コンテキストの識別子または修飾名にする必要があります。');
    return;
  }
  if (path.length === 1) {
    const [ident] = path;
    const scope = c.scopeOf(ident);
    if (!scope.lookupValue(ident.text) && !scope.lookupType(ident.text) && !scope.lookupNamespace(ident.text, c.budget))
      c.error(ident, `名前 ${ident.text} が見つかりません。`);
    return;
  }
  c.expressions.check(target);
}

function entityNamePath(node: TreeNode): TreeNode[] | undefined {
  if (node.type === 'identifier') return [node];
  if (node.type !== 'member_expression' && node.type !== 'nested_identifier') return undefined;
  const left = node.childForFieldName('object') ?? node.childForFieldName('module');
  const right = node.childForFieldName('property') ?? node.childForFieldName('name');
  if (!left || !right || (right.type !== 'property_identifier' && right.type !== 'identifier')) return undefined;
  const prefix = entityNamePath(left);
  return prefix ? [...prefix, right] : undefined;
}

export function exportEqualsTargetOf(node: TreeNode): TreeNode | undefined {
  if (node.childForFieldName('declaration') || node.childForFieldName('value') || node.childForFieldName('source'))
    return undefined;
  if (!node.children.some((child) => !child.isNamed && child.type === '=')) return undefined;
  return named(node).find((child) => child.type !== 'export_clause' && child.type !== 'comment');
}

export function isImportTypeCall(node: TreeNode): boolean {
  return node.type === 'call_expression' && node.childForFieldName('function')?.type === 'import';
}

export function importTypeMemberChain(node: TreeNode): { call: TreeNode; members: TreeNode[] } | undefined {
  const members: TreeNode[] = [];
  let current = node;
  while (current.type === 'member_expression') {
    const object = current.childForFieldName('object');
    const property = current.childForFieldName('property');
    if (!object || !property) return undefined;
    members.unshift(property);
    current = object;
  }
  return isImportTypeCall(current) && members.length > 0 ? { call: current, members } : undefined;
}

export function resolveImportTypeModuleOf(c: Checker, callNode: TreeNode): Sym | undefined {
  const argumentsNode = callNode.childForFieldName('arguments');
  const first = argumentsNode ? named(argumentsNode)[0] : undefined;
  const literal = importSpecifierLiteral(first);
  if (!literal) {
    c.error(first ?? callNode, '文字列リテラルが必要です。');
    return undefined;
  }
  const specifier = stringValue(literal);
  const module = c.namespaces.moduleNamed(specifier);
  if (!module) {
    c.error(first ?? literal, `モジュール '${specifier}' またはそれに対応する型宣言が見つかりません。`);
    return undefined;
  }
  return module;
}

function importSpecifierLiteral(first: TreeNode | undefined): TreeNode | undefined {
  if (first?.type === 'string') return first;
  return first?.type === 'literal_type' && named(first)[0]?.type === 'string' ? named(first)[0] : undefined;
}

export function importTypeQueryOf(c: Checker, callNode: TreeNode): Type {
  const module = resolveImportTypeModuleOf(c, callNode);
  if (!module) return errorType;
  if (isShorthandAmbientModule(module)) return anyType;
  if (!module.exportEquals) return c.namespaces.objectType(module);
  const valueSymbol = c.namespaces.exportEqualsSymbol(module, 'value');
  if (valueSymbol) return c.expressions.valueTypeOf(valueSymbol);
  const namespaceSymbol = c.namespaces.exportEqualsSymbol(module, 'namespace');
  if (namespaceSymbol && c.namespaces.isInstantiated(namespaceSymbol)) return c.namespaces.objectType(namespaceSymbol);
  c.error(callNode, `モジュール '"${module.name}"' は値に解決されません。`);
  return errorType;
}

export function resolveImportTypeMemberOf(
  c: Checker,
  node: TreeNode,
  stepMember: (current: Sym, name: string, isLast: boolean) => Sym | undefined
): { symbol?: Sym; error?: string; site?: TreeNode } {
  const parts = importTypeMemberChain(node);
  if (!parts) return {};
  const { call, members } = parts;
  const module = resolveImportTypeModuleOf(c, call);
  if (!module) return {};
  const isLibrary = c.libraryBinder.ambientModules.get(module.name) === module;
  const firstUnavailable = isLibrary && unavailableNodeMember(`"${module.name}"`, members[0].text);
  if (firstUnavailable) {
    c.error(members[0], unsupportedMessage(firstUnavailable));
    return {};
  }
  const root = module.exportEquals
    ? (c.namespaces.exportEqualsSymbol(module, 'namespace') ?? c.namespaces.exportEqualsSymbol(module, 'value'))
    : module;
  if (!root) return missingNamespaceMember(`"${module.name}"`, members[0]);
  return walkImportTypeMembers(root, `"${module.name}"`, members, stepMember);
}

function walkImportTypeMembers(
  root: Sym,
  rootLabel: string,
  members: TreeNode[],
  stepMember: (current: Sym, name: string, isLast: boolean) => Sym | undefined
): { symbol?: Sym; error?: string; site?: TreeNode } {
  let current = root;
  let label = rootLabel;
  for (const [index, part] of members.entries()) {
    const isLast = index === members.length - 1;
    const member = stepMember(current, part.text, isLast);
    const canContinue =
      isLast || Boolean(member?.namespaceExports) || (member?.valueKind === 'enum' && index === members.length - 2);
    if (!member || !canContinue) return missingNamespaceMember(label, part);
    current = member;
    label = `${label}.${part.text}`;
  }
  return { symbol: current };
}

function missingNamespaceMember(label: string, site: TreeNode): { error: string; site: TreeNode } {
  return { error: `名前空間 '${label}' にエクスポートされたメンバー '${site.text}' がありません。`, site };
}

function isShorthandAmbientModule(module: Sym): boolean {
  return (
    module.valueDeclarations.length > 0 && module.valueDeclarations.every((decl) => !decl.childForFieldName('body'))
  );
}

export function matchWildcardAmbientModule(modules: ReadonlyMap<string, Sym>, specifier: string): Sym | undefined {
  let best: Sym | undefined;
  let bestPrefixLength = -1;
  for (const [pattern, symbol] of modules) {
    const star = pattern.indexOf('*');
    if (star === -1 || pattern.includes('*', star + 1)) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      prefix.length > bestPrefixLength
    ) {
      bestPrefixLength = prefix.length;
      best = symbol;
    }
  }
  return best;
}
