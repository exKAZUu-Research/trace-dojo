import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { ExecutionBudget } from '../../interpreter/limits';
import {
  bindAmbientDefaultValueExport,
  type DefaultExportLookup,
  matchWildcardAmbientModule,
  resolveAmbientEntityInBinder,
  resolveBinderEntityMeaning,
} from './ambientModuleExports';
import { canonicalIdentifier, type Scope, type Sym } from './scopes';
import { hasToken, named, stringValue } from './syntax';

interface ReExportContext {
  ambientModules: ReadonlyMap<string, Sym>;
  existingModules: ReadonlyMap<string, Sym> | undefined;
  ownScopes: ReadonlyMap<number, Scope>;
  pendingDefaults?: readonly { node: TreeNode; scope: Scope; exports: Scope }[];
  scopeOf: (site: TreeNode) => Scope;
  budget?: ExecutionBudget;
}

interface ReExportEntry {
  node: TreeNode;
  exports: Scope;
  specifier: string;
}

interface ResolvedExportTarget {
  value?: Sym;
  type?: Sym;
  namespace?: Sym;
  typeOnlyValue?: Sym;
}

interface StarOrigin {
  firstModule: string;
  value?: Sym;
  type?: Sym;
  namespace?: Sym;
  typeOnlyValue?: Sym;
  conflicted: boolean;
}

/** Resolves `export ... from "..."` statements across ambient modules in value, type, and namespace spaces. */
export function resolveAmbientModuleReExports(context: ReExportContext): void {
  const entries = collectAmbientReExports(context);
  const hasDefaults = (context.pendingDefaults?.length ?? 0) > 0;
  if (entries.length === 0 && !hasDefaults) return;
  const starOrigins = new Map<Scope, Map<string, StarOrigin>>();
  while (
    applyPendingDefaultsPass(context) ||
    applyReExportPass(entries, context, starOrigins, false) ||
    applyReExportPass(entries, context, starOrigins, true)
  ) {
    context.budget?.spend();
  }
}

function applyPendingDefaultsPass(context: ReExportContext): boolean {
  let changed = false;
  for (const { node, scope, exports } of context.pendingDefaults ?? []) {
    context.budget?.spend();
    changed = bindAmbientDefaultValueExport(node, binderLookupFor(scope, exports, context)) || changed;
  }
  return changed;
}

function binderLookupFor(scope: Scope, exports: Scope, context: ReExportContext): DefaultExportLookup {
  return {
    scope,
    exports,
    scopeOf: context.scopeOf,
    budget: context.budget,
    findModule: (specifier) => findTargetModule(specifier, context.ambientModules, context.existingModules),
    isLibraryModule: (module) => context.existingModules?.get(module.name) === module,
  };
}

function collectAmbientReExports(context: ReExportContext): ReExportEntry[] {
  const modules = new Set<Sym>([...context.ambientModules.values(), ...(context.existingModules?.values() ?? [])]);
  const entries: ReExportEntry[] = [];
  for (const module of modules) {
    const exports = module.namespaceExports;
    if (!exports) continue;
    for (const declaration of module.valueDeclarations) {
      const body = declaration.childForFieldName('body');
      if (body && context.ownScopes.has(body.id)) collectBodyReExports(body, exports, entries);
    }
  }
  return entries;
}

function collectBodyReExports(body: TreeNode, exports: Scope, entries: ReExportEntry[]): void {
  for (const child of named(body)) {
    const source = child.type === 'export_statement' ? child.childForFieldName('source') : undefined;
    if (source) entries.push({ node: child, exports, specifier: stringValue(source) });
  }
}

function applyReExportPass(
  entries: ReExportEntry[],
  context: ReExportContext,
  starOrigins: Map<Scope, Map<string, StarOrigin>>,
  starOnly: boolean
): boolean {
  let changed = false;
  for (const entry of entries) {
    context.budget?.spend();
    const clause = named(entry.node).find((part) => part.type === 'export_clause');
    const nsExport = named(entry.node).find((part) => part.type === 'namespace_export');
    if ((!clause && !nsExport) !== starOnly) continue;
    const dep = findTargetModule(entry.specifier, context.ambientModules, context.existingModules);
    if (!dep) continue;
    const stmtTypeOnly = hasToken(entry.node, 'type');
    if (clause) changed = exportNamedClause(clause, dep, entry.exports, context, stmtTypeOnly) || changed;
    else if (nsExport) changed = exportNamespaceClause(nsExport, dep, entry.exports, stmtTypeOnly) || changed;
    else changed = exportStarClause(entry.node, dep, entry.exports, context, starOrigins, stmtTypeOnly) || changed;
  }
  return changed;
}

function findTargetModule(
  specifier: string,
  ambientModules: ReadonlyMap<string, Sym>,
  existingModules: ReadonlyMap<string, Sym> | undefined
): Sym | undefined {
  return (
    existingModules?.get(specifier) ??
    ambientModules.get(specifier) ??
    matchWildcardAmbientModule(ambientModules, specifier)
  );
}

function exportNamedClause(
  clause: TreeNode,
  dep: Sym,
  exports: Scope,
  context: ReExportContext,
  stmtTypeOnly: boolean
): boolean {
  let changed = false;
  const depExports = targetExportsOf(dep, context);
  for (const specifier of named(clause)) {
    const nameNode = specifier.childForFieldName('name');
    const aliasNode = specifier.childForFieldName('alias') ?? nameNode;
    if (!nameNode || !aliasNode) continue;
    const sourceName = decodedExportName(nameNode);
    const targetName = decodedExportName(aliasNode);
    const typeOnly = stmtTypeOnly || hasToken(specifier, 'type');
    const resolved = resolveModuleExportByName(dep, depExports, sourceName, context, typeOnly);
    exports.recordClauseExport(targetName, aliasNode, resolved);
    changed = exportResolvedMeanings(exports, targetName, resolved) || changed;
  }
  return changed;
}

function resolveModuleExportByName(
  dep: Sym,
  depExports: Scope | undefined,
  sourceName: string,
  context: ReExportContext,
  typeOnly: boolean,
  seen = new Set<string>()
): ResolvedExportTarget {
  if (sourceName === 'default' && dep.exportEquals) {
    const eq = resolveExportEqualsEntity(dep, context);
    return {
      value: typeOnly ? undefined : eq.value,
      type: eq.type,
      namespace: eq.namespace,
      typeOnlyValue: typeOnly ? eq.value : undefined,
    };
  }
  if (
    sourceName === 'default' &&
    !depExports?.values.has('default') &&
    context.existingModules?.get(dep.name) === dep
  ) {
    return {
      value: typeOnly ? undefined : dep,
      namespace: dep,
      typeOnlyValue: typeOnly ? dep : undefined,
    };
  }
  return depExports ? readNormalizedExportSlot(depExports, sourceName, typeOnly, context, seen) : {};
}

function exportNamespaceClause(nsExport: TreeNode, dep: Sym, exports: Scope, stmtTypeOnly: boolean): boolean {
  if (dep.exportEquals) return false;
  const aliasNode = named(nsExport)[0];
  if (!aliasNode) return false;
  const targetName = decodedExportName(aliasNode);
  const resolved: ResolvedExportTarget = {
    value: stmtTypeOnly ? undefined : dep,
    namespace: dep,
    typeOnlyValue: stmtTypeOnly ? dep : undefined,
  };
  exports.recordClauseExport(targetName, aliasNode, resolved);
  return exportResolvedMeanings(exports, targetName, resolved);
}

function exportStarClause(
  starNode: TreeNode,
  dep: Sym,
  exports: Scope,
  context: ReExportContext,
  starOrigins: Map<Scope, Map<string, StarOrigin>>,
  stmtTypeOnly: boolean
): boolean {
  if (dep.exportEquals) return false;
  const depExports = dep.namespaceExports;
  if (!depExports) return false;
  let origins = starOrigins.get(exports);
  if (!origins) {
    origins = new Map();
    starOrigins.set(exports, origins);
  }
  let changed = false;
  for (const name of collectStarCandidateNames(depExports)) {
    if (hasExplicitExport(exports, name)) continue;
    const incoming = readNormalizedExportSlot(depExports, name, stmtTypeOnly, context);
    if (!hasAnyMeaning(incoming)) continue;
    changed = mergeStarCandidate(starNode, dep.name, name, incoming, exports, origins) || changed;
  }
  return changed;
}

function collectStarCandidateNames(depExports: Scope): Set<string> {
  const names = new Set<string>([
    ...depExports.values.keys(),
    ...depExports.types.keys(),
    ...depExports.namespaces.keys(),
    ...depExports.typeOnlyValues.keys(),
  ]);
  names.delete('default');
  return names;
}

function hasExplicitExport(exports: Scope, name: string): boolean {
  return (
    exports.hasDeclarationExport(name, 'value') ||
    exports.hasDeclarationExport(name, 'type') ||
    exports.hasDeclarationExport(name, 'namespace') ||
    exports.clauseExportSpecifiers.some((entry) => entry.name === name)
  );
}

function readNormalizedExportSlot(
  depExports: Scope,
  name: string,
  typeOnly: boolean,
  context: ReExportContext,
  seen = new Set<string>()
): ResolvedExportTarget {
  const directValue = unwrapExportOrigin(depExports.values.get(name), 'value', context, seen);
  const fallbackTypeOnly =
    unwrapExportOrigin(depExports.typeOnlyValues.get(name), 'typeOnlyValue', context, seen) ??
    unwrapExportOrigin(depExports.values.get(name), 'typeOnlyValue', context, seen);
  const value = typeOnly ? undefined : directValue;
  return {
    value,
    type: unwrapExportOrigin(depExports.types.get(name), 'type', context, seen),
    namespace: unwrapExportOrigin(depExports.namespaces.get(name), 'namespace', context, seen),
    typeOnlyValue: value ? undefined : typeOnly ? (directValue ?? fallbackTypeOnly) : fallbackTypeOnly,
  };
}

type OriginMeaning = 'value' | 'type' | 'namespace' | 'typeOnlyValue';

function unwrapExportOrigin(
  symbol: Sym | undefined,
  meaning: OriginMeaning,
  context: ReExportContext,
  seen: Set<string>
): Sym | undefined {
  if (!symbol) return undefined;
  const kind = symbolEntryKind(symbol, meaning);
  if (kind !== 'import' && kind !== 'importAlias') return symbol;
  const key = `${symbol.id}:${meaning}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  try {
    return kind === 'import'
      ? unwrapImportedSymbolOrigin(symbol, meaning, context, seen)
      : unwrapAliasSymbolOrigin(symbol, meaning, context, seen);
  } finally {
    seen.delete(key);
  }
}

function symbolEntryKind(symbol: Sym, meaning: OriginMeaning): string | undefined {
  if (meaning === 'value' || meaning === 'typeOnlyValue') return symbol.valueKind;
  return meaning === 'type' ? symbol.typeKind : symbol.namespaceKind;
}

function unwrapImportedSymbolOrigin(
  symbol: Sym,
  meaning: OriginMeaning,
  context: ReExportContext,
  seen: Set<string>
): Sym | undefined {
  const target = symbol.importTarget;
  const dep = target ? findTargetModule(target.module, context.ambientModules, context.existingModules) : undefined;
  if (!target || !dep) return undefined;
  if (meaning === 'value' && target.typeOnly) return undefined;
  if (target.name === '*') {
    return meaning === 'type' ? undefined : dep;
  }
  const resolved = resolveModuleExportByName(
    dep,
    targetExportsOf(dep, context),
    target.name,
    context,
    Boolean(target.typeOnly),
    seen
  );
  if (meaning === 'typeOnlyValue') return resolved.typeOnlyValue ?? resolved.value;
  return resolved[meaning];
}

function unwrapAliasSymbolOrigin(
  symbol: Sym,
  meaning: OriginMeaning,
  context: ReExportContext,
  seen: Set<string>
): Sym | undefined {
  const decl =
    symbol.valueDeclarations.find((node) => node.type === 'import_alias') ??
    symbol.typeDeclarations.find((node) => node.type === 'import_alias') ??
    symbol.namespaceDeclarations.find((node) => node.type === 'import_alias');
  const target = decl ? named(decl)[1] : undefined;
  if (!decl || !target) return undefined;
  const scope = context.scopeOf(decl);
  const exports = scope.namespace?.namespaceExports ?? scope;
  const binderMeaning = meaning === 'typeOnlyValue' ? 'value' : meaning;
  const picked = resolveBinderEntityMeaning(target, binderMeaning, binderLookupFor(scope, exports, context));
  return unwrapExportOrigin(picked, meaning, context, seen);
}

function hasAnyMeaning(target: ResolvedExportTarget): boolean {
  return Boolean(target.value ?? target.type ?? target.namespace ?? target.typeOnlyValue);
}

function mergeStarCandidate(
  starNode: TreeNode,
  depName: string,
  name: string,
  incoming: ResolvedExportTarget,
  exports: Scope,
  origins: Map<string, StarOrigin>
): boolean {
  const existing = origins.get(name);
  if (!existing) {
    origins.set(name, { firstModule: depName, ...incoming, conflicted: false });
    return exportResolvedMeanings(exports, name, incoming);
  }
  if (sameStarSymbols(existing, incoming)) {
    if (incoming.value && !existing.value) existing.value = incoming.value;
    if (incoming.typeOnlyValue && !existing.value && !existing.typeOnlyValue) {
      existing.typeOnlyValue = incoming.typeOnlyValue;
    }
    return exportResolvedMeanings(exports, name, incoming);
  }
  exports.recordAmbiguousStarExport(starNode, existing.firstModule, name);
  if (existing.conflicted) return false;
  existing.conflicted = true;
  exports.removeStarExport(name);
  return true;
}

function sameStarSymbols(a: StarOrigin, b: ResolvedExportTarget): boolean {
  return (
    (a.value ?? a.typeOnlyValue) === (b.value ?? b.typeOnlyValue) && a.type === b.type && a.namespace === b.namespace
  );
}

function exportResolvedMeanings(exports: Scope, name: string, resolved: ResolvedExportTarget): boolean {
  let added = false;
  if (resolved.value && !exports.values.has(name)) {
    exports.exportViaClause(name, resolved.value, 'value');
    exports.typeOnlyValues.delete(name);
    added = true;
  }
  if (resolved.type && !exports.types.has(name)) {
    exports.exportViaClause(name, resolved.type, 'type');
    added = true;
  }
  if (resolved.namespace && !exports.namespaces.has(name)) {
    exports.exportViaClause(name, resolved.namespace, 'namespace');
    added = true;
  }
  if (resolved.typeOnlyValue && !exports.values.has(name) && !exports.typeOnlyValues.has(name)) {
    exports.exportTypeOnlyValue(name, resolved.typeOnlyValue);
    added = true;
  }
  return added;
}

function targetExportsOf(dep: Sym, context: ReExportContext): Scope | undefined {
  if (!dep.exportEquals) return dep.namespaceExports;
  const eq = resolveExportEqualsEntity(dep, context);
  return eq.namespace?.namespaceExports ?? eq.value?.namespaceExports;
}

function resolveExportEqualsEntity(dep: Sym, context: ReExportContext): { value?: Sym; type?: Sym; namespace?: Sym } {
  const target = dep.exportEquals;
  const exports = dep.namespaceExports;
  if (!target || !exports) return {};
  return resolveAmbientEntityInBinder(target, target, binderLookupFor(context.scopeOf(target), exports, context));
}

function decodedExportName(node: TreeNode): string {
  return node.type === 'string' ? stringValue(node) : canonicalIdentifier(node.text, node);
}
