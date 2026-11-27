import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { ExecutionBudget } from '../../interpreter/limits';
import { exportEqualsTargetOf, matchWildcardAmbientModule } from './ambientModuleExports';
import { canonicalIdentifier, type MeaningSpace, type Scope, type Sym } from './scopes';
import { hasToken, named, stringValue } from './syntax';

interface ReExportEntry {
  node: TreeNode;
  exports: Scope;
  specifier: string;
}

/** Resolves `export ... from "..."` statements across ambient modules in value, type, and namespace spaces. */
export function resolveAmbientModuleReExports(
  ambientModules: ReadonlyMap<string, Sym>,
  existingModules: ReadonlyMap<string, Sym> | undefined,
  ownScopes: ReadonlyMap<number, Scope>,
  budget?: ExecutionBudget
): void {
  const entries = collectAmbientReExports(ambientModules, existingModules, ownScopes);
  if (entries.length === 0) return;
  while (
    applyReExportPass(entries, ambientModules, existingModules, false, budget) ||
    applyReExportPass(entries, ambientModules, existingModules, true, budget)
  ) {
    budget?.spend();
  }
}

function collectAmbientReExports(
  ambientModules: ReadonlyMap<string, Sym>,
  existingModules: ReadonlyMap<string, Sym> | undefined,
  ownScopes: ReadonlyMap<number, Scope>
): ReExportEntry[] {
  const modules = new Set<Sym>([...ambientModules.values(), ...(existingModules?.values() ?? [])]);
  const entries: ReExportEntry[] = [];
  for (const module of modules) {
    const exports = module.namespaceExports;
    if (!exports) continue;
    for (const declaration of module.valueDeclarations) {
      const body = declaration.childForFieldName('body');
      if (!body || !ownScopes.has(body.id)) continue;
      for (const child of named(body)) {
        const source = child.type === 'export_statement' ? child.childForFieldName('source') : undefined;
        if (source) entries.push({ node: child, exports, specifier: stringValue(source) });
      }
    }
  }
  return entries;
}

function applyReExportPass(
  entries: ReExportEntry[],
  ambientModules: ReadonlyMap<string, Sym>,
  existingModules: ReadonlyMap<string, Sym> | undefined,
  starOnly: boolean,
  budget?: ExecutionBudget
): boolean {
  let changed = false;
  for (const entry of entries) {
    budget?.spend();
    const clause = named(entry.node).find((part) => part.type === 'export_clause');
    const nsExport = named(entry.node).find((part) => part.type === 'namespace_export');
    const isStar = !clause && !nsExport;
    if (isStar !== starOnly) continue;
    const dep = findTargetModule(entry.specifier, ambientModules, existingModules);
    if (!dep) continue;
    const stmtTypeOnly = hasToken(entry.node, 'type');
    if (clause)
      changed = exportNamedClauseFromModule(clause, dep, entry.exports, existingModules, stmtTypeOnly) || changed;
    else if (nsExport) changed = exportNamespaceFromModule(nsExport, dep, entry.exports, stmtTypeOnly) || changed;
    else changed = exportStarFromModule(dep, entry.exports, stmtTypeOnly) || changed;
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

function exportNamedClauseFromModule(
  clause: TreeNode,
  dep: Sym,
  exports: Scope,
  existingModules: ReadonlyMap<string, Sym> | undefined,
  stmtTypeOnly: boolean
): boolean {
  let changed = false;
  const depExports = targetExportsOf(dep);
  for (const specifier of named(clause)) {
    const nameNode = specifier.childForFieldName('name');
    const aliasNode = specifier.childForFieldName('alias') ?? nameNode;
    if (!nameNode || !aliasNode) continue;
    const sourceName = decodedExportName(nameNode);
    const targetName = decodedExportName(aliasNode);
    const typeOnly = stmtTypeOnly || hasToken(specifier, 'type');
    const resolved = resolveModuleExportByName(dep, depExports, sourceName, existingModules, typeOnly);
    const added = exportResolvedMeanings(exports, targetName, resolved);
    if (added) {
      exports.recordClauseExport(targetName, aliasNode, resolved);
      changed = true;
    }
  }
  return changed;
}

function resolveModuleExportByName(
  dep: Sym,
  depExports: Scope | undefined,
  sourceName: string,
  existingModules: ReadonlyMap<string, Sym> | undefined,
  typeOnly: boolean
): { value?: Sym; type?: Sym; namespace?: Sym } {
  if (
    sourceName === 'default' &&
    !depExports?.values.has('default') &&
    (dep.exportEquals || existingModules?.get(dep.name) === dep)
  ) {
    return { value: typeOnly ? undefined : dep, namespace: dep };
  }
  return {
    value: typeOnly ? undefined : depExports?.values.get(sourceName),
    type: depExports?.types.get(sourceName),
    namespace: depExports?.namespaces.get(sourceName),
  };
}

function exportNamespaceFromModule(nsExport: TreeNode, dep: Sym, exports: Scope, stmtTypeOnly: boolean): boolean {
  const aliasNode = named(nsExport)[0];
  if (!aliasNode) return false;
  const targetName = decodedExportName(aliasNode);
  const resolved = { value: stmtTypeOnly ? undefined : dep, namespace: dep };
  const added = exportResolvedMeanings(exports, targetName, resolved);
  if (added) exports.recordClauseExport(targetName, aliasNode, resolved);
  return added;
}

function exportStarFromModule(dep: Sym, exports: Scope, stmtTypeOnly: boolean): boolean {
  const depExports = targetExportsOf(dep);
  if (!depExports) return false;
  let changed = false;
  if (!stmtTypeOnly) changed = copyNonDefaultSpace(depExports, exports, 'value') || changed;
  changed = copyNonDefaultSpace(depExports, exports, 'type') || changed;
  changed = copyNonDefaultSpace(depExports, exports, 'namespace') || changed;
  return changed;
}

function copyNonDefaultSpace(source: Scope, target: Scope, meaning: MeaningSpace): boolean {
  let changed = false;
  const targetTable = target.tableOf(meaning);
  for (const [name, symbol] of source.tableOf(meaning)) {
    if (name === 'default' || targetTable.has(name)) continue;
    target.exportViaClause(name, symbol, meaning);
    changed = true;
  }
  return changed;
}

function exportResolvedMeanings(
  exports: Scope,
  name: string,
  resolved: { value?: Sym; type?: Sym; namespace?: Sym }
): boolean {
  let added = false;
  if (resolved.value && !exports.values.has(name)) {
    exports.exportViaClause(name, resolved.value, 'value');
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
  return added;
}

function targetExportsOf(dep: Sym): Scope | undefined {
  if (!dep.exportEquals) return dep.namespaceExports;
  const targetName =
    dep.exportEquals.type === 'identifier' ? canonicalIdentifier(dep.exportEquals.text, dep.exportEquals) : undefined;
  if (!targetName) return dep.namespaceExports;
  for (const declaration of dep.valueDeclarations) {
    const body = declaration.childForFieldName('body');
    if (!body) continue;
    for (const child of named(body)) {
      if (!exportEqualsTargetOf(child)) continue;
      const found = dep.namespaceExports?.namespaces.get(targetName) ?? dep.namespaceExports?.values.get(targetName);
      if (found?.namespaceExports) return found.namespaceExports;
    }
  }
  return dep.namespaceExports;
}

function decodedExportName(node: TreeNode): string {
  return node.type === 'string' ? stringValue(node) : canonicalIdentifier(node.text, node);
}
