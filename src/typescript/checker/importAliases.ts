import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import type { MeaningSpace, Scope, Sym } from './scopes';

const allMeanings: readonly MeaningSpace[] = ['value', 'type', 'namespace'];

/** Drops the unused bindings of an `import` or `import X = N.Y` that resolves only in other symbol spaces. */
export function pruneImportAliasMeaningsInScopes(c: Checker, scopes: Scope[]): void {
  for (const scope of scopes) {
    pruneScopeImportAliases(c, scope, 'value');
    pruneScopeImportAliases(c, scope, 'type');
    pruneScopeImportAliases(c, scope, 'namespace');
  }
}

export function checkCircularAliasesInScopes(c: Checker, scopes: Scope[]): void {
  const reportedSites = new Set<number>();
  const checkedSymbols = new Set<number>();
  for (const scope of scopes) {
    for (const symbol of [...scope.values.values(), ...scope.types.values(), ...scope.namespaces.values()]) {
      if (checkedSymbols.has(symbol.id)) continue;
      checkedSymbols.add(symbol.id);
      checkSymbolCircularAlias(c, symbol, reportedSites);
    }
  }
}

function checkSymbolCircularAlias(c: Checker, symbol: Sym, reportedSites: Set<number>): void {
  const entries = [...symbol.valueEntries, ...symbol.typeEntries, ...symbol.namespaceEntries];
  const aliasSites = entries
    .filter((entry) => (entry.kind === 'import' || entry.kind === 'importAlias') && !c.isLibrary(entry.name))
    .map((entry) => entry.name);
  if (aliasSites.length === 0) return;
  if (entries.some((entry) => entry.kind !== 'import' && entry.kind !== 'importAlias')) return;
  if (!c.namespaces.probeCircularImportSymbol(symbol)) return;
  for (const site of aliasSites) {
    if (reportedSites.has(site.id)) continue;
    reportedSites.add(site.id);
    c.error(site, `インポート エイリアス '${symbol.name}' の循環定義です。`);
  }
}

function pruneScopeImportAliases(c: Checker, scope: Scope, meaning: MeaningSpace): void {
  const { table, entriesOf, declarationsOf, others } = scopeAliasTables(scope, meaning);
  for (const [name, symbol] of table) {
    const entries = entriesOf(symbol);
    const declarations = declarationsOf(symbol);
    if (!entries.some((entry) => entry.kind === 'importAlias' || entry.kind === 'import')) continue;
    const keptIndices = entries
      .map((_, index) => index)
      .filter((index) => !isOtherSpaceImport(c, symbol, entries[index].kind, declarations[index], meaning, others));
    if (keptIndices.length === entries.length) continue;
    if (keptIndices.length === 0) {
      table.delete(name);
      scope.namespace?.namespaceExports?.deleteClauseExportSymbol(symbol, meaning);
    } else {
      retainIndices(declarations, keptIndices);
      restoreKeptSymbolKind(symbol, keptIndices, meaning);
    }
  }
}

function isOtherSpaceImport(
  c: Checker,
  symbol: Sym,
  kind: string,
  declaration: TreeNode | undefined,
  meaning: MeaningSpace,
  others: readonly MeaningSpace[]
): boolean {
  if (kind === 'import' && declaration?.type === 'import_statement') {
    if (symbol.importTarget?.typeOnly && meaning !== 'namespace') return false;
    return (
      c.namespaces.importTarget(symbol, meaning) === undefined &&
      others.some((other) => c.namespaces.importTarget(symbol, other) !== undefined)
    );
  }
  return (
    kind === 'importAlias' &&
    declaration?.type === 'import_alias' &&
    c.namespaces.aliasDeclarationTarget(declaration, meaning) === undefined &&
    others.some((other) => c.namespaces.aliasDeclarationTarget(declaration, other) !== undefined)
  );
}

function restoreKeptSymbolKind(symbol: Sym, keptIndices: number[], meaning: MeaningSpace): void {
  if (meaning === 'value') {
    retainIndices(symbol.valueEntries, keptIndices);
    const merged = symbol.valueEntries.find(
      (entry) => entry.kind === 'enum' || entry.kind === 'function' || entry.kind === 'class'
    );
    symbol.valueKind =
      symbol.valueEntries[0].kind === 'namespace' && merged ? merged.kind : symbol.valueEntries[0].kind;
    return;
  }
  if (meaning === 'type') {
    retainIndices(symbol.typeEntries, keptIndices);
    symbol.typeKind = symbol.typeEntries.some((entry) => entry.kind === 'class') ? 'class' : symbol.typeEntries[0].kind;
    return;
  }
  retainIndices(symbol.namespaceEntries, keptIndices);
  symbol.namespaceKind = symbol.namespaceEntries[0].kind;
}

function retainIndices<T>(items: T[], indices: number[]): void {
  const kept = indices.map((index) => items[index]);
  items.splice(0, items.length, ...kept);
}

function scopeAliasTables(
  scope: Scope,
  meaning: MeaningSpace
): {
  table: Map<string, Sym>;
  entriesOf: (symbol: Sym) => { kind: string; name: TreeNode }[];
  declarationsOf: (symbol: Sym) => TreeNode[];
  others: readonly MeaningSpace[];
} {
  return {
    table: scope.tableOf(meaning),
    entriesOf: (symbol) =>
      meaning === 'value' ? symbol.valueEntries : meaning === 'type' ? symbol.typeEntries : symbol.namespaceEntries,
    declarationsOf: (symbol) =>
      meaning === 'value'
        ? symbol.valueDeclarations
        : meaning === 'type'
          ? symbol.typeDeclarations
          : symbol.namespaceDeclarations,
    others: allMeanings.filter((other) => other !== meaning),
  };
}
