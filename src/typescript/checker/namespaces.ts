import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { isAmbient, isInstantiatedNamespace } from '../namespaceInstantiation';
import { unsupportedMessage } from '../unsupported';
import {
  importTypeMemberChain,
  importTypeQueryOf,
  isImportTypeCall,
  matchWildcardAmbientModule,
  resolveImportTypeMemberOf,
  resolveImportTypeModuleOf,
} from './ambientModuleExports';
import type { Checker } from './checker';
import { FlowState } from './flow';
import { unavailableNodeMember } from './nodeLibrary';
import { canonicalIdentifier, type MeaningSpace, type Scope, type Sym } from './scopes';
import { nameSuggestionHint, spellingSuggestion } from './spelling';
import { globalAugmentationPlacementMessage } from './statements';
import {
  isAmbientModuleBody,
  isDirectGlobalAugmentationContainer,
  isGlobalAugmentationNamespace,
  isNamespaceBody,
  isTopLevelAmbientModule,
  named,
  stringValue,
} from './syntax';
import {
  anonymousObject,
  anyType,
  emptyStructure,
  intersectionOf,
  type ObjectType,
  simpleProperty,
  type Type,
} from './types';

/**
 * Namespaces: the object a namespace's exported values make, the types it exports, and the checks of its declarations.
 */
export class Namespaces {
  private readonly objectTypes = new Map<number, ObjectType>();
  private readonly resolvingAliases = new Set<number>();

  constructor(private readonly c: Checker) {}

  /** The type of a namespace's object: its exported values, as properties that `const` and functions make read-only. */
  objectType(symbol: Sym): ObjectType {
    const cached = this.objectTypes.get(symbol.id);
    if (cached) return cached;
    const exports = symbol.namespaceExports;
    const type = anonymousObject(
      () => {
        const structure = emptyStructure();
        for (const [name, member] of exports?.values ?? []) {
          if (member.valueKind === 'namespace' && !this.isInstantiated(member)) continue;
          if (member.valueKind === 'importAlias' && !this.imported(member, 'value')) continue;
          const resolved = this.unaliased(member, 'value') ?? member;
          // Only a `const` export is read-only: tsc lets a program reassign an exported function, class, or enum.
          const readonly = member.valueEntries.every((entry) => entry.kind === 'const');
          structure.properties.set(name, {
            ...simpleProperty(name, anyType, { readonly, declaration: member.valueDeclaration }),
            enumSymbol: resolved.valueKind === 'enum' ? resolved : undefined,
            type: () => this.c.expressions.valueTypeOf(member),
          });
        }
        return structure;
      },
      { valueName: qualifiedName(symbol), nonGeneric: true }
    );
    this.objectTypes.set(symbol.id, type);
    return type;
  }

  /** The type of a function, class, or enum merged with a namespace, which has the namespace's exports too. */
  withExports(symbol: Sym, type: Type): Type {
    if (!symbol.namespaceExports || symbol.valueKind === 'namespace' || !this.isInstantiated(symbol)) return type;
    return intersectionOf([type, this.objectType(symbol)], this.c);
  }

  /** Whether a namespace has values, which give it an object; one that only declares types has none. */
  isInstantiated(symbol: Sym): boolean {
    return isInstantiatedNamespace(symbol);
  }

  /** Whether a namespace has an object to use as a value, reporting one that only declares types. */
  checkValueUse(node: TreeNode, symbol: Sym, name = symbol.name): boolean {
    if (symbol.valueEntries.some((entry) => entry.kind !== 'namespace') || this.isInstantiated(symbol)) return true;
    this.c.error(node, `名前空間 '${name}' は値として使えません。`);
    return false;
  }

  /** What `import X = N.Y` names, as a value, a type, or a namespace, or undefined when its path names nothing. */
  aliasTarget(alias: Sym, meaning: MeaningSpace): Sym | undefined {
    const declaration =
      alias.valueDeclarations.find((node) => node.type === 'import_alias') ??
      alias.typeDeclarations.find((node) => node.type === 'import_alias') ??
      alias.namespaceDeclarations.find((node) => node.type === 'import_alias') ??
      alias.valueDeclaration ??
      alias.typeDeclarations[0] ??
      alias.namespaceDeclarations[0];
    return declaration ? this.aliasDeclarationTarget(declaration, meaning) : undefined;
  }

  aliasDeclarationTarget(declaration: TreeNode, meaning: MeaningSpace): Sym | undefined {
    const target = named(declaration)[1];
    if (!target || this.resolvingAliases.has(declaration.id)) return undefined;
    this.resolvingAliases.add(declaration.id);
    try {
      return this.resolvePath(qualifiedPath(target), meaning).symbol;
    } finally {
      this.resolvingAliases.delete(declaration.id);
    }
  }

  /** Drops the unused bindings of an `import` or `import X = N.Y` that resolves only in other symbol spaces. */
  pruneImportAliasMeanings(scopes: Scope[]): void {
    for (const scope of scopes) {
      this.pruneScopeImportAliases(scope, 'value');
      this.pruneScopeImportAliases(scope, 'type');
      this.pruneScopeImportAliases(scope, 'namespace');
    }
  }

  private pruneScopeImportAliases(scope: Scope, meaning: MeaningSpace): void {
    const { table, entriesOf, declarationsOf, others } = scopeAliasTables(scope, meaning);
    for (const [name, symbol] of table) {
      const entries = entriesOf(symbol);
      const declarations = declarationsOf(symbol);
      if (!entries.some((entry) => entry.kind === 'importAlias' || entry.kind === 'import')) continue;
      const keptIndices = entries
        .map((_, index) => index)
        .filter((index) => !this.isOtherSpaceImport(symbol, entries[index].kind, declarations[index], meaning, others));
      if (keptIndices.length === entries.length) continue;
      if (keptIndices.length === 0) {
        table.delete(name);
        scope.namespace?.namespaceExports?.deleteClauseExportSymbol(symbol, meaning);
      } else {
        retainIndices(declarations, keptIndices);
        this.restoreKeptSymbolKind(symbol, keptIndices, meaning);
      }
    }
  }

  private restoreKeptSymbolKind(symbol: Sym, keptIndices: number[], meaning: MeaningSpace): void {
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
      symbol.typeKind = symbol.typeEntries.some((entry) => entry.kind === 'class')
        ? 'class'
        : symbol.typeEntries[0].kind;
      return;
    }
    retainIndices(symbol.namespaceEntries, keptIndices);
    symbol.namespaceKind = symbol.namespaceEntries[0].kind;
  }

  private isOtherSpaceImport(
    symbol: Sym,
    kind: string,
    declaration: TreeNode | undefined,
    meaning: MeaningSpace,
    others: readonly MeaningSpace[]
  ): boolean {
    if (kind === 'import' && declaration?.type === 'import_statement') {
      if (symbol.importTarget?.typeOnly && meaning !== 'namespace') return false;
      return (
        this.importTarget(symbol, meaning) === undefined &&
        others.some((other) => this.importTarget(symbol, other) !== undefined)
      );
    }
    return (
      kind === 'importAlias' &&
      declaration?.type === 'import_alias' &&
      this.aliasDeclarationTarget(declaration, meaning) === undefined &&
      others.some((other) => this.aliasDeclarationTarget(declaration, other) !== undefined)
    );
  }

  /** Reports the path of `import X = N.Y` that names nothing. */
  checkImportAlias(node: TreeNode): void {
    const target = named(node)[1];
    if (!target) return;
    const path = qualifiedPath(target);
    const value = this.resolvePath(path, 'value');
    const namespace = this.resolvePath(path, 'namespace');
    const type = value.symbol || namespace.symbol ? undefined : this.resolvePath(path, 'type');
    if (path.length === 1) {
      this.checkSingleNameAlias(target, value.symbol, namespace.symbol, type?.symbol);
      return;
    }
    if (!value.symbol && !namespace.symbol && !type?.symbol && value.error) this.c.error(target, value.error);
  }

  /** `import X = Y` names a namespace or an enum, as a namespace path names its first name. */
  private checkSingleNameAlias(
    target: TreeNode,
    value: Sym | undefined,
    namespace: Sym | undefined,
    type: Sym | undefined
  ): void {
    if (namespace?.namespaceExports || value?.namespaceExports || value?.valueKind === 'enum') return;
    const name = target.text;
    if (value?.unsupported) this.c.error(target, unsupportedMessage(value.unsupported));
    else if (type || this.c.scopeOf(target).lookupType(name))
      this.c.error(target, `'${name}' は型のみを参照していますが、ここでは名前空間として使われています。`);
    else if (value) this.c.error(target, `名前空間 ${name} が見つかりません。`);
    else
      this.c.error(
        target,
        `名前 ${name} が見つかりません。${nameSuggestionHint(this.c.scopeOf(target), name, 'value', this.c.budget)}`
      );
  }

  /** The symbol the last name of a path names, as a value, a type, or a namespace, through the namespaces before it. */
  private resolvePath(path: TreeNode[], meaning: MeaningSpace): { symbol?: Sym; error?: string } {
    const [root, ...rest] = path;
    const scope = this.c.scopeOf(root);
    if (rest.length === 0) return { symbol: this.directSymbol(scope, root.text, meaning) };
    const rootContainer = this.unaliasedContainer(scope.lookupContainer(root.text, this.c.budget));
    const isEnumMember = rootContainer?.valueKind === 'enum' && rest.length === 1;
    if (!rootContainer?.namespaceExports && !isEnumMember) return { error: `名前空間 ${root.text} が見つかりません。` };
    let current = rootContainer as Sym;
    for (const [index, part] of rest.entries()) {
      const remaining = rest.length - 1 - index;
      const next =
        remaining === 0 ? this.pathMember(current, part.text, meaning) : this.pathContainerMember(current, part.text);
      if (next.error) return next;
      const symbol = next.symbol as Sym;
      // An enum's members are the last name of a path, as in `import X = N.E.A`.
      if (remaining > 0 && !symbol.namespaceExports && !(symbol.valueKind === 'enum' && remaining === 1))
        return { error: missingMemberError(current, part.text) };
      current = symbol;
    }
    return { symbol: current };
  }

  private directSymbol(scope: Scope, name: string, meaning: MeaningSpace): Sym | undefined {
    if (meaning === 'value') return this.unaliased(scope.lookupValue(name, this.c.budget), 'value');
    if (meaning === 'namespace') return this.unaliased(scope.lookupNamespace(name, this.c.budget), 'namespace');
    return this.unaliased(scope.lookupType(name), 'type');
  }

  private unaliasedContainer(symbol: Sym | undefined): Sym | undefined {
    if (!symbol) return undefined;
    if (symbol.namespaceKind === 'import' || symbol.namespaceKind === 'importAlias') {
      return this.imported(symbol, 'namespace') ?? this.unaliased(symbol, 'value');
    }
    return this.unaliased(symbol, 'value');
  }

  private pathContainerMember(container: Sym, name: string): { symbol?: Sym; error?: string } {
    const member = this.containerMemberOf(container, name);
    return member ? { symbol: member } : this.missingPathMember(container, name);
  }

  private containerMemberOf(container: Sym, name: string): Sym | undefined {
    return container.namespaceExports
      ? (this.exportedMember(container, name, 'namespace') ?? this.exportedMember(container, name, 'value'))
      : container.enumMembers?.values.get(name);
  }

  /** What a name of a path names in the namespace or enum before it, or why it names nothing there. */
  private pathMember(container: Sym, name: string, meaning: MeaningSpace): { symbol?: Sym; error?: string } {
    const symbol = container.namespaceExports
      ? this.exportedMember(container, name, meaning)
      : meaning === 'value'
        ? container.enumMembers?.values.get(name)
        : undefined;
    return symbol ? { symbol } : this.missingPathMember(container, name);
  }

  private missingPathMember(container: Sym, name: string): { error: string } {
    // The Node library declares only part of @types/node's NodeJS namespace.
    if (container.name === 'NodeJS' && container.valueDeclarations.every((node) => this.c.isLibrary(node)))
      return { error: `NodeJS.${name} は、この採点環境では使えません。` };
    return { error: missingMemberError(container, name) };
  }

  private exportedMember(namespace: Sym, name: string, meaning: MeaningSpace): Sym | undefined {
    return this.unaliased((namespace.namespaceExports as Scope).tableOf(meaning).get(name), meaning);
  }

  private unaliased(symbol: Sym | undefined, meaning: MeaningSpace): Sym | undefined {
    const kind =
      meaning === 'value' ? symbol?.valueKind : meaning === 'namespace' ? symbol?.namespaceKind : symbol?.typeKind;
    return symbol && (kind === 'import' || kind === 'importAlias') ? this.imported(symbol, meaning) : symbol;
  }

  /** What a name that `import` or `import X = N.Y` declares stands for, as a value, a type, or a namespace. */
  imported(symbol: Sym, meaning: MeaningSpace): Sym | undefined {
    return symbol.importTarget ? this.importTarget(symbol, meaning) : this.aliasTarget(symbol, meaning);
  }

  /** What a name an `import` declares stands for: the module, or what the module exports by that name. */
  importTarget(symbol: Sym, meaning: MeaningSpace): Sym | undefined {
    const target = symbol.importTarget;
    const module = target && this.moduleNamed(target.module);
    if (!target || !module) return undefined;
    if (module.exportEquals) {
      if (target.name === '*' || target.name === 'default') return this.exportEqualsSymbol(module, meaning);
      const container = this.exportEqualsContainer(module);
      return container?.namespaceExports ? this.exportedMember(container, target.name, meaning) : undefined;
    }
    if (target.name === '*' || this.isSyntheticDefault(module, target.name)) return module;
    return this.exportedMember(module, target.name, meaning);
  }

  exportEqualsSymbol(module: Sym, meaning: MeaningSpace): Sym | undefined {
    const target = module.exportEquals;
    if (!target || this.resolvingAliases.has(target.id)) return undefined;
    this.resolvingAliases.add(target.id);
    try {
      return this.resolvePath(qualifiedPath(target), meaning).symbol;
    } finally {
      this.resolvingAliases.delete(target.id);
    }
  }

  private exportEqualsContainer(module: Sym): Sym | undefined {
    return this.exportEqualsSymbol(module, 'namespace') ?? this.exportEqualsSymbol(module, 'value');
  }

  resolveEntityPath(path: TreeNode[]): { symbol?: Sym; error?: string } {
    const value = this.resolvePath(path, 'value');
    if (value.symbol) return value;
    const namespace = this.resolvePath(path, 'namespace');
    if (namespace.symbol) return namespace;
    const type = this.resolvePath(path, 'type');
    return type.symbol ? type : value;
  }

  /**
   * Whether `import x from "m"` names the whole of a Node module, which has no default export of its own: tsc's default
   * `esModuleInterop` lets a default import stand for a CommonJS module.
   */
  private isSyntheticDefault(module: Sym, name: string): boolean {
    return name === 'default' && !module.namespaceExports?.values.has('default') && this.isLibraryModule(module);
  }

  private isLibraryModule(module: Sym): boolean {
    return this.c.libraryBinder.ambientModules.get(module.name) === module;
  }

  /** The object of a module the library declares, as `import * as` gives it, or undefined for another module. */
  moduleObjectType(name: string): Type | undefined {
    const module = this.c.libraryBinder.ambientModules.get(name);
    return module && this.objectType(module);
  }

  moduleNamed(name: string): Sym | undefined {
    return (
      this.c.libraryBinder.ambientModules.get(name) ??
      this.c.binder.ambientModules.get(name) ??
      matchWildcardAmbientModule(this.c.binder.ambientModules, name)
    );
  }

  /** Resolves the target module of a type-position `import("...")`, reporting invalid specifiers or unknown modules. */
  resolveImportTypeModule(callNode: TreeNode): Sym | undefined {
    return resolveImportTypeModuleOf(this.c, callNode);
  }

  /** Resolves `typeof import("...")` to the module's namespace object type or `export =` value type. */
  importTypeQuery(callNode: TreeNode): Type {
    return importTypeQueryOf(this.c, callNode);
  }

  /** Resolves `import("...").A.B` in type space, enforcing unavailable Node member checks and TS2694 diagnostics. */
  resolveImportTypeMember(node: TreeNode): { symbol?: Sym; error?: string; site?: TreeNode } {
    return resolveImportTypeMemberOf(this.c, node, (current, name, isLast) => {
      if (!isLast) return this.containerMemberOf(current, name);
      return current.namespaceExports
        ? (this.exportedMember(current, name, 'type') ?? current.enumMembers?.values.get(name))
        : current.enumMembers?.values.get(name);
    });
  }

  /** Reports a default import of a module without a default export, and a name a module does not export. */
  checkImport(node: TreeNode): void {
    const source = node.childForFieldName('source');
    const clause = node.childForFieldName('import_clause');
    if (!this.checkImportPlacementAndSyntax(node, source, clause)) return;
    if (!source || !clause || clause.type === 'import_require_clause') return;
    const module = this.moduleNamed(stringValue(source));
    if (!module) return;
    const moduleName = `'"${stringValue(source)}"'`;
    for (const part of named(clause)) {
      if (part.type === 'identifier' && !this.hasDefaultExport(module))
        this.c.error(part, `モジュール ${moduleName} には既定のエクスポートがありません。`);
      if (part.type === 'named_imports') this.checkNamedImports(part, module, moduleName);
    }
  }

  private hasDefaultExport(module: Sym): boolean {
    const exports = module.namespaceExports;
    return Boolean(
      exports?.values.has('default') ||
      exports?.types.has('default') ||
      exports?.namespaces.has('default') ||
      module.exportEquals ||
      this.isSyntheticDefault(module, 'default')
    );
  }

  private checkImportPlacementAndSyntax(node: TreeNode, source: TreeNode | null, clause: TreeNode | null): boolean {
    const specifier = source ?? clause?.childForFieldName('source');
    if (isNamespaceBody(node.parent)) {
      this.c.error(specifier ?? node, '名前空間内のインポート宣言は、モジュールを参照できません。');
      return false;
    }
    if (this.c.isModule && isAmbientModuleBody(node.parent)) {
      this.c.error(
        node,
        'インポートはモジュールの拡張では許可されていません。外側の外部モジュールに移動することを検討してください。'
      );
      return false;
    }
    if (node.parent?.type !== 'program' && !isAmbientModuleBody(node.parent)) {
      this.c.error(node, 'インポート宣言は、名前空間またはモジュールの最上位レベルでのみ使用できます。');
      return false;
    }
    const attributes = named(node).find((child) => child.type === 'import_attribute');
    if (attributes)
      this.c.error(
        attributes,
        "インポート属性は、'--module' オプションが 'esnext'、'node18'、'node20'、'nodenext'、'preserve' のどれかのときしか使えません。"
      );
    // tsc without `--module` compiles to ECMAScript modules, which have no `import x = require("m")`.
    if (clause?.type === 'import_require_clause')
      this.c.error(
        node,
        `ECMAScript モジュールを対象にする場合は、インポート代入を使用できません。代わりに 'import * as ns from "mod"'、'import {a} from "mod"'、'import d from "mod"' などのモジュール書式の使用をご検討ください。`
      );
    return true;
  }

  checkReExport(clause: TreeNode | undefined, source: TreeNode): void {
    const module = this.moduleNamed(stringValue(source));
    if (!module || !clause) return;
    this.checkNamedImports(clause, module, `'"${stringValue(source)}"'`);
  }

  private checkNamedImports(imports: TreeNode, module: Sym, moduleName: string): void {
    const target = module.exportEquals ? this.exportEqualsContainer(module) : module;
    const exports = target?.namespaceExports;
    for (const specifier of named(imports)) {
      const name = specifier.childForFieldName('name');
      const exported = name && canonicalImportSpecifier(name);
      const unavailable =
        exported && this.isLibraryModule(module) && unavailableNodeMember(`"${module.name}"`, exported);
      if (name && unavailable) this.c.error(name, unsupportedMessage(unavailable));
      else if (
        name &&
        exported &&
        (!exports ||
          (!exports.values.has(exported) &&
            !exports.types.has(exported) &&
            !exports.namespaces.has(exported) &&
            !this.isSyntheticDefault(module, exported)))
      )
        this.reportMissingImport(name, exports, moduleName);
    }
  }

  /** A name a module does not export, with the export tsc suggests for a misspelling of one. */
  private reportMissingImport(name: TreeNode, exports: Scope | undefined, moduleName: string): void {
    const candidates = exports
      ? new Set([...exports.values.keys(), ...exports.types.keys(), ...exports.namespaces.keys()])
      : new Set<string>();
    const suggestion = spellingSuggestion(name.text, candidates, this.c.budget);
    this.c.error(
      name,
      suggestion
        ? `'${name.text}' という名前のエクスポートされたメンバーが ${moduleName} に含まれていません。候補: '${suggestion}'`
        : `モジュール ${moduleName} には、エクスポートされたメンバー '${name.text}' がありません。`
    );
  }

  /** The symbol of the type a qualified name such as `N.T` or `A.B.T` names, through the namespaces of its path. */
  qualifiedTypeSymbol(node: TreeNode): { symbol?: Sym; error?: string } {
    return this.resolvePath(qualifiedPath(node), 'type');
  }

  /** The symbol of the value a qualified name such as `N.E` names, or undefined when it names no value at run time. */
  qualifiedValueSymbol(node: TreeNode): Sym | undefined {
    const { symbol } = this.resolvePath(qualifiedPath(node), 'value');
    return symbol?.valueKind === 'namespace' && !this.isInstantiated(symbol) ? undefined : symbol;
  }

  /** Checks a namespace's body, whose code runs once where the namespace is declared, from a flow of its own. */
  checkDeclaration(node: TreeNode): void {
    if (isGlobalAugmentationNamespace(node)) {
      this.checkGlobalAugmentationNamespace(node);
      return;
    }
    const name = node.childForFieldName('name');
    this.checkDeclarationPlacement(node, name);
    const body = node.childForFieldName('body');
    if (!body || this.c.isLibrary(node)) return;
    const ambientBody = isAmbient(node);
    const outer = this.c.flow.current;
    this.c.flow.current = new FlowState();
    try {
      this.c.statements.declareHoistedVariables(this.c.binder.ownScope(body));
      if (ambientBody) this.c.statements.checkAmbientBodyStatements(body);
      else this.c.statements.checkBlockStatements(named(body));
    } finally {
      this.c.flow.current = outer;
    }
  }

  private checkDeclarationPlacement(node: TreeNode, name: TreeNode | null): void {
    if (name?.type === 'string') {
      this.checkStringModulePlacement(node, name);
      return;
    }
    if (node.type === 'module')
      this.c.error(
        node,
        "'namespace' の宣言に 'module' キーワードは使えません。代わりに 'namespace' キーワードを使ってください。"
      );
    if (!isNamespaceOrModuleTopLevel(node))
      this.c.error(node, '名前空間宣言は、名前空間またはモジュールの最上位レベルでのみ許可されます。');
  }

  private checkStringModulePlacement(node: TreeNode, name: TreeNode): void {
    if (!isAmbient(node)) {
      this.c.error(name, '引用符付きの名前を使用できるのはアンビエント モジュールのみです。');
      return;
    }
    if (!isTopLevelAmbientModule(node)) {
      this.c.error(
        isNamespaceOrModuleTopLevel(node) ? name : node,
        isNamespaceOrModuleTopLevel(node)
          ? 'アンビエント モジュールを、他のモジュールまたは名前空間内の入れ子にすることはできません。'
          : 'アンビエント モジュール宣言は、ファイルの最上位にのみ使用できます。'
      );
      return;
    }
    const exportSite = exportedModuleSite(node);
    if (exportSite) {
      this.c.error(
        exportSite,
        "環境モジュールとモジュール拡張は常に表示されるので、これらに 'export' 修飾子を適用することはできません。"
      );
    }
    const specifier = stringValue(name);
    if (this.c.isModule && !this.c.libraryBinder.ambientModules.has(specifier)) {
      this.c.error(name, `拡張のモジュール名が無効です。モジュール '${specifier}' が見つかりません。`);
    }
  }

  private checkGlobalAugmentationNamespace(node: TreeNode): void {
    if (this.c.isLibrary(node)) return;
    if (!isAmbient(node)) {
      this.c.error(
        node,
        "グローバル スコープを拡張するには、モジュールがアンビエントでない限り 'declare' 修飾子が必要です。"
      );
      return;
    }
    if (!isDirectGlobalAugmentationContainer(node, this.c.isModule)) {
      this.c.error(node, globalAugmentationPlacementMessage(node));
      return;
    }
    const body = node.childForFieldName('body');
    if (body) this.c.statements.checkAmbientBodyStatements(body);
  }
}

export { importTypeMemberChain, isImportTypeCall };

function canonicalImportSpecifier(node: TreeNode): string {
  return node.type === 'string' ? stringValue(node) : canonicalIdentifier(node.text, node);
}

function exportedModuleSite(node: TreeNode): TreeNode | undefined {
  const outer = node.parent?.type === 'ambient_declaration' ? node.parent : node;
  return outer.parent?.type === 'export_statement' ? outer.parent : undefined;
}

/** Whether a namespace is declared in the program or in another namespace's body, the places tsc allows one. */
function isNamespaceOrModuleTopLevel(node: TreeNode): boolean {
  let container = node.parent;
  while (container && ['expression_statement', 'export_statement', 'ambient_declaration'].includes(container.type))
    container = container.parent;
  if (container?.type === 'program') return true;
  const owner = container?.type === 'statement_block' ? container.parent : undefined;
  return owner?.type === 'internal_module' || owner?.type === 'module';
}

/** The names of a qualified type name, as `A`, `B`, and `T` of `A.B.T`. */
function qualifiedPath(node: TreeNode): TreeNode[] {
  if (node.type !== 'nested_type_identifier' && node.type !== 'nested_identifier' && node.type !== 'member_expression')
    return [node];
  const left = node.childForFieldName('module') ?? node.childForFieldName('object');
  const right = node.childForFieldName('name') ?? node.childForFieldName('property');
  return [...(left ? qualifiedPath(left) : []), ...(right ? [right] : [])];
}

function missingMemberError(container: Sym, name: string): string {
  return `名前空間 '${qualifiedName(container)}' には、エクスポートされたメンバー '${name}' がありません。`;
}

/** The name a namespace is printed with, `A.B` for `B` in `A`. */
function qualifiedName(symbol: Sym): string {
  return symbol.exportedFrom ? `${qualifiedName(symbol.exportedFrom)}.${symbol.name}` : symbol.name;
}

function retainIndices<T>(items: T[], indices: number[]): void {
  const kept = indices.map((index) => items[index]);
  items.splice(0, items.length, ...kept);
}

const allMeanings: readonly MeaningSpace[] = ['value', 'type', 'namespace'];

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
