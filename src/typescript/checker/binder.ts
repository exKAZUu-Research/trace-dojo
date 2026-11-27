// code-gauge-allow-file fileNcss -- Binds every declaration, import, namespace, and scope form in one tree walk.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { ExecutionBudget } from '../../interpreter/limits';
import { blockHasRuntimeCode, isAmbient } from '../namespaceInstantiation';
import {
  bindAmbientDefaultValueExport,
  bindAnonymousDefaultDeclaration,
  exportEqualsTargetOf,
} from './ambientModuleExports';
import { memberNameOf } from './enums';
import { fsImportMeanings } from './nodeLibrary';
import { canonicalIdentifier, Scope, Sym, type ValueKind } from './scopes';
import {
  assignmentKind,
  isDirectGlobalAugmentationContainer,
  isGlobalAugmentationNamespace,
  isTopLevelAmbientModule,
  isWithin,
  named,
  patternIdentifiers,
  stringValue,
} from './syntax';

export const functionLikeTypes = new Set([
  'function_declaration',
  'function_expression',
  'generator_function_declaration',
  'generator_function',
  'arrow_function',
  'method_definition',
  'function_signature',
  'method_signature',
  'abstract_method_signature',
  'class_static_block',
  'call_signature',
  'construct_signature',
  'function_type',
  'constructor_type',
]);
const assignmentBoundaries = new Set([
  'lexical_declaration',
  'variable_declaration',
  'expression_statement',
  'if_statement',
  'do_statement',
  'while_statement',
  'for_statement',
  'for_in_statement',
  'with_statement',
  'switch_statement',
  'try_statement',
  'class_declaration',
  'abstract_class_declaration',
]);

const blockTypes = new Set(['statement_block', 'for_statement', 'for_in_statement', 'switch_body', 'catch_clause']);
const typeParameterOwners = new Set([
  'interface_declaration',
  'type_alias_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'class',
]);

/** The scopes of a program: which names each node can see, as values and as types. */
export class Binder {
  private readonly scopes = new Map<number, Scope>();
  private readonly deferredTypes = new Map<number, Scope>();
  /** The identifiers that name what an assignment changes, to find the variables a program reassigns. */
  private readonly assignedIdentifiers: { identifier: TreeNode; scope: Scope }[] = [];
  private readonly pendingAmbientDefaults: { node: TreeNode; scope: Scope; exports: Scope }[] = [];
  readonly moduleScope: Scope;
  /** The modules `declare module "m"` declares, by their names. */
  readonly ambientModules = new Map<string, Sym>();
  /** How each kind of node that declares names or opens a scope of its own is bound. */
  private readonly binders = new Map<string, (node: TreeNode, scope: Scope) => void>([
    ['lexical_declaration', (node, scope) => this.bindVariableDeclaration(node, scope)],
    ['variable_declaration', (node, scope) => this.bindVariableDeclaration(node, scope)],
    ['function_declaration', (node, scope) => this.bindFunctionDeclaration(node, scope)],
    ['generator_function_declaration', (node, scope) => this.bindFunctionDeclaration(node, scope)],
    ['function_signature', (node, scope) => this.bindFunctionDeclaration(node, scope)],
    ['class_declaration', (node, scope) => this.bindClassDeclaration(node, scope)],
    ['abstract_class_declaration', (node, scope) => this.bindClassDeclaration(node, scope)],
    ['class', (node, scope) => this.bindClass(node, scope)],
    ['interface_declaration', (node, scope) => this.bindTypeDeclaration(node, scope, 'interface')],
    ['type_alias_declaration', (node, scope) => this.bindTypeDeclaration(node, scope, 'alias')],
    ['ambient_declaration', (node, scope) => this.bindAmbient(node, scope)],
    ['enum_declaration', (node, scope) => this.bindEnum(node, scope)],
    ['internal_module', (node, scope) => this.bindNamespace(node, scope)],
    ['module', (node, scope) => this.bindNamespace(node, scope)],
    ['export_statement', (node, scope) => this.bindExport(node, scope)],
    ['import_alias', (node, scope) => this.bindImportAlias(node, scope)],
    ['import_statement', (node, scope) => this.bindImport(node, scope)],
    ['assignment_expression', (node, scope) => this.bindAssignment(node, scope, 'left')],
    ['augmented_assignment_expression', (node, scope) => this.bindAssignment(node, scope, 'left')],
    ['update_expression', (node, scope) => this.bindAssignment(node, scope, 'argument')],
    ['for_in_statement', (node, scope) => this.bindForIn(node, scope)],
    ['catch_clause', (node, scope) => this.bindCatch(node, scope)],
  ]);

  constructor(
    root: TreeNode,
    readonly globalScope: Scope,
    private readonly options?: {
      rootScope?: Scope;
      deferLibraryTypes?: boolean;
      budget?: ExecutionBudget;
      skipAssignmentAnalysis?: boolean;
      isExternalModule?: boolean;
      existingModules?: ReadonlyMap<string, Sym>;
      augmentableModules?: ReadonlySet<string>;
    }
  ) {
    this.moduleScope = options?.rootScope ?? new Scope('module', globalScope, root);
    this.scopes.set(root.id, this.moduleScope);
    this.bindChildren(root, this.moduleScope);
    for (const { node, scope, exports } of this.pendingAmbientDefaults) {
      bindAmbientDefaultValueExport(node, scope, exports, (site) => this.scopeOf(site), this.options?.budget);
    }
    this.markAssignments();
  }

  bindDeferredType(node: TreeNode): boolean {
    const scope = this.deferredTypes.get(node.id);
    if (!scope) return false;
    this.deferredTypes.delete(node.id);
    this.bind(node, scope);
    return true;
  }

  private markAssignments(): void {
    const budget = this.options?.budget;
    for (const { identifier, scope } of this.assignedIdentifiers) {
      budget?.spend();
      const symbol = scope.lookupValue(identifier.text, budget);
      if (!symbol) continue;
      symbol.isReassigned = true;
      symbol.isDefinitelyAssigned ||= assignmentKind(identifier) !== 'compound';
      const position =
        assignmentOwner(scope, budget) === assignmentOwner(symbol.scope, budget)
          ? assignmentEnd(identifier, symbol.valueDeclaration?.startIndex ?? 0, budget)
          : Number.POSITIVE_INFINITY;
      symbol.lastAssignment = Math.max(symbol.lastAssignment, position);
    }
  }

  /** The scope a node sees names in. */
  scopeOf(node: TreeNode): Scope {
    for (let current: TreeNode | null = node; current; current = current.parent) {
      this.options?.budget?.spend();
      const scope = this.scopes.get(current.id);
      if (scope) return scope;
    }
    return this.moduleScope;
  }

  /** The scope a scope-creating node itself creates. */
  ownScope(node: TreeNode): Scope | undefined {
    return this.scopes.get(node.id);
  }

  lookupValue(node: TreeNode, name: string): Sym | undefined {
    return this.scopeOf(node).lookupValue(name, this.options?.budget);
  }

  lookupNamespace(node: TreeNode, name: string): Sym | undefined {
    return this.scopeOf(node).lookupNamespace(name, this.options?.budget);
  }

  private bindChildren(node: TreeNode, scope: Scope): void {
    for (const child of node.namedChildren) if (child) this.bind(child, scope);
  }

  private newScope(node: TreeNode, kind: Scope['kind'], parent: Scope, augments?: Scope): Scope {
    const scope = new Scope(kind, parent, node, augments);
    this.scopes.set(node.id, scope);
    return scope;
  }

  /** Every scope of the program, the module's first. */
  get allScopes(): Scope[] {
    return [...new Set([this.moduleScope, ...this.scopes.values()])];
  }

  private bind(node: TreeNode, scope: Scope): void {
    this.options?.budget?.spend();
    const bindKind = this.binders.get(node.type);
    if (bindKind) bindKind(node, scope);
    else if (functionLikeTypes.has(node.type)) this.bindFunction(node, scope);
    else if (blockTypes.has(node.type) && !this.isFunctionBody(node))
      this.bindChildren(node, this.newScope(node, 'block', scope));
    else if (typeParameterOwners.has(node.type)) this.bindTypeParameterOwner(node, scope);
    else this.bindChildren(node, scope);
  }

  private bindVariableDeclaration(node: TreeNode, scope: Scope): void {
    const kind =
      node.type === 'variable_declaration' ? 'var' : (node.childForFieldName('kind')?.text as 'let' | 'const');
    const target = kind === 'var' ? scope.functionScope : scope;
    for (const declarator of named(node)) {
      if (declarator.type !== 'variable_declarator') continue;
      const name = declarator.childForFieldName('name');
      if (name)
        for (const identifier of patternIdentifiers(name))
          target.declareValue(identifier.text, kind, declarator, identifier);
      this.bindChildren(declarator, scope);
    }
  }

  private bindFunctionDeclaration(node: TreeNode, scope: Scope): void {
    const name = node.childForFieldName('name');
    if (name) scope.declareValue(name.text, 'function', node, name);
    this.bindFunction(node, scope);
  }

  private bindClassDeclaration(node: TreeNode, scope: Scope): void {
    const name = node.childForFieldName('name');
    if (name) {
      scope.declareValue(name.text, 'class', node, name);
      scope.declareType(name.text, 'class', node, name);
    }
    this.bindClass(node, scope);
  }

  private bindTypeDeclaration(node: TreeNode, scope: Scope, kind: 'interface' | 'alias'): void {
    const name = node.childForFieldName('name');
    if (name) scope.declareType(name.text, kind, node, name);
    this.bindTypeParameterOwner(node, scope);
  }

  /**
   * `namespace A.B { ... }`: each name of the path is a namespace that the one before exports, and the body declares
   * its names in a scope of its own, which sees the names every declaration of the namespace exports.
   */
  private bindNamespace(node: TreeNode, scope: Scope, isAmbient = scope.isAmbient): void {
    const name = node.childForFieldName('name');
    const body = node.childForFieldName('body');
    if (name?.type === 'string') {
      this.bindAmbientModule(node, stringValue(name), scope);
      return;
    }
    if (isGlobalAugmentationNamespace(node)) {
      const augments = this.globalAugmentationTarget(node, isAmbient);
      if (body) this.bindAmbient(body, this.newScope(body, 'block', scope, augments));
      return;
    }
    if (!name) return;
    const instantiated = body !== null && blockHasRuntimeCode(body);
    let outer = scope;
    let namespace: Sym | undefined;
    for (const part of namespacePath(name)) {
      const partName = canonicalIdentifier(part.text, part);
      this.seedMergedNamespacePart(outer, scope, node, partName, isAmbient, instantiated);
      namespace = outer.declareNamespace(partName, 'namespace', node, part);
      if (instantiated) outer.declareValue(partName, 'namespace', node, part);
      // The path's first name is exported only by an `export` or an ambient body, which `exportDeclared` handles.
      if (outer !== scope) {
        this.exportFrom(outer, namespace, 'namespace');
        if (instantiated) this.exportFrom(outer, namespace, 'value');
      }
      namespace.namespaceExports ??= new Scope('block', outer, node);
      outer = this.newNamespaceBody(node, namespace, isAmbient);
    }
    if (body) this.bindNamespaceBody(body, outer, isAmbient);
  }

  private seedMergedNamespacePart(
    outer: Scope,
    rootScope: Scope,
    node: TreeNode,
    partName: string,
    isAmbient: boolean,
    instantiated: boolean
  ): void {
    // `namespace A.B` declared again adds to the `B` (or class/function/enum `B`) that an earlier `A` exports.
    if (outer === rootScope && !isAmbient && !isExportedNamespaceRoot(node)) return;
    const namespaceExports = outer.namespace?.namespaceExports;
    if (!namespaceExports) return;
    const exportedNamespace = !namespaceExports.isClauseOnlyExport(partName, 'namespace')
      ? namespaceExports.namespaces.get(partName)
      : undefined;
    if (exportedNamespace && !outer.namespaces.has(partName)) outer.namespaces.set(partName, exportedNamespace);
    const exportedValue = !namespaceExports.isClauseOnlyExport(partName, 'value')
      ? namespaceExports.values.get(partName)
      : undefined;
    if (
      exportedValue &&
      (instantiated || ['class', 'function', 'enum'].includes(exportedValue.valueKind ?? '')) &&
      !outer.values.has(partName)
    ) {
      outer.values.set(partName, exportedValue);
    }
  }

  /** The statements of a namespace's body, where those of a `declare namespace` are ambient and all exported. */
  private bindNamespaceBody(body: TreeNode, scope: Scope, isAmbientBody: boolean): void {
    this.scopes.set(body.id, scope);
    const hasExplicitExportList = isAmbientBody && hasAmbientExportClause(body);
    for (const child of named(body)) {
      if (!isAmbientBody) {
        this.bind(child, scope);
        continue;
      }
      this.bindAmbientChild(child, scope);
      if (!hasExplicitExportList && child.type !== 'export_statement') this.exportDeclared(child, scope);
    }
    if (scope.namespace) this.bindNamespaceExportClauses(body, scope);
  }

  private bindNamespaceExportClauses(body: TreeNode, scope: Scope): void {
    const exports = (scope.namespace as Sym).namespaceExports as Scope;
    for (const child of named(body)) {
      if (child.type !== 'export_statement' || child.childForFieldName('source')) continue;
      if (scope.isAmbient) this.pendingAmbientDefaults.push({ node: child, scope, exports });
      const stmtTypeOnly = child.children.some((part) => !part.isNamed && part.type === 'type');
      for (const part of named(child)) {
        if (part.type !== 'export_clause') continue;
        for (const specifier of named(part)) this.exportClauseSpecifier(specifier, scope, exports, stmtTypeOnly);
      }
    }
  }

  private exportClauseSpecifier(specifier: TreeNode, scope: Scope, exports: Scope, stmtTypeOnly: boolean): void {
    const nameNode = specifier.childForFieldName('name');
    const aliasNode = specifier.childForFieldName('alias') ?? nameNode;
    if (!nameNode || !aliasNode) return;
    const localName = nameNode.type === 'string' ? stringValue(nameNode) : canonicalIdentifier(nameNode.text, nameNode);
    const exportedName =
      aliasNode.type === 'string' ? stringValue(aliasNode) : canonicalIdentifier(aliasNode.text, aliasNode);
    const typeOnly = stmtTypeOnly || specifier.children.some((part) => !part.isNamed && part.type === 'type');
    const value = !typeOnly ? scope.values.get(localName) : undefined;
    if (value) exports.exportViaClause(exportedName, value, 'value');
    const type = scope.types.get(localName);
    if (type) exports.exportViaClause(exportedName, type, 'type');
    const namespace = scope.namespaces.get(localName);
    if (namespace) exports.exportViaClause(exportedName, namespace, 'namespace');
    if (value || type || namespace) exports.recordClauseExport(exportedName, aliasNode, { value, type, namespace });
  }

  /** `declare module "m" { ... }`, whose declarations are the exports an `import` of "m" sees. */
  private bindAmbientModule(node: TreeNode, name: string, scope: Scope): void {
    const valid = Boolean(this.options?.deferLibraryTypes) || (isAmbient(node) && isTopLevelAmbientModule(node));
    const existing = valid ? this.options?.existingModules?.get(name) : undefined;
    const registersModule =
      valid && (!this.isExternalModule || Boolean(existing) || Boolean(this.options?.augmentableModules?.has(name)));
    let module = existing ?? (registersModule ? this.ambientModules.get(name) : undefined);
    if (!module) {
      module = new Sym(name, scope);
      module.valueKind = 'namespace';
      module.namespaceKind = 'namespace';
      module.namespaceExports = new Scope('block', scope, node);
      if (registersModule) this.ambientModules.set(name, module);
    }
    module.valueDeclarations.push(node);
    module.namespaceDeclarations.push(node);
    const body = node.childForFieldName('body');
    if (!body) return;
    const bodyScope = this.newNamespaceBody(node, module, true);
    this.copyDeclarationExportsToBody(module.namespaceExports as Scope, bodyScope);
    this.bindNamespaceBody(body, bodyScope, true);
  }

  private copyDeclarationExportsToBody(exports: Scope, bodyScope: Scope): void {
    for (const [exportName, exported] of exports.values) {
      if (!exports.isClauseOnlyExport(exportName, 'value')) bodyScope.values.set(exportName, exported);
    }
    for (const [exportName, exported] of exports.types) {
      if (!exports.isClauseOnlyExport(exportName, 'type')) bodyScope.types.set(exportName, exported);
    }
    for (const [exportName, exported] of exports.namespaces) {
      if (!exports.isClauseOnlyExport(exportName, 'namespace')) bodyScope.namespaces.set(exportName, exported);
    }
  }

  private get isExternalModule(): boolean {
    return Boolean(this.options?.isExternalModule ?? (!this.options?.rootScope && !this.options?.deferLibraryTypes));
  }

  /** The names an `import` declares, which stand for what a module exports. */
  private bindImport(node: TreeNode, scope: Scope): void {
    const clause = node.childForFieldName('import_clause');
    const source = node.childForFieldName('source') ?? clause?.childForFieldName('source');
    if (!source || !clause) return;
    const module = stringValue(source);
    const clauseTypeOnly = node.children.some((child) => !child.isNamed && child.type === 'type');
    for (const { local, name, typeOnly: specTypeOnly } of importedNames(clause)) {
      const typeOnly = clauseTypeOnly || specTypeOnly;
      const localName = canonicalIdentifier(local.text, local);
      const meanings = this.importMeaningsOf(module, name);
      if (meanings.value) {
        scope.declareValue(localName, 'import', node, local).importTarget = { module, name, typeOnly };
      }
      if (meanings.type) {
        scope.declareType(localName, 'import', node, local).importTarget = { module, name, typeOnly };
      }
      if (meanings.namespace) {
        scope.declareNamespace(localName, 'import', node, local).importTarget = { module, name, typeOnly };
      }
    }
  }

  private importMeaningsOf(module: string, name: string): { value: boolean; type: boolean; namespace: boolean } {
    const fsMeanings = fsImportMeanings(module, name);
    const ambientSymbol = this.ambientModules.get(module) ?? this.options?.existingModules?.get(module);
    if (ambientSymbol?.exportEquals) return { value: true, type: name !== '*', namespace: true };
    const ambient = ambientSymbol?.namespaceExports;
    if (ambient && name !== '*') {
      const value = Boolean(fsMeanings?.value) || ambient.values.has(name);
      const type = Boolean(fsMeanings?.type) || ambient.types.has(name);
      const namespace =
        ambient.namespaces.has(name) || (Boolean(fsMeanings) && (name === 'default' || name === 'promises'));
      if (value || type || namespace) return { value, type, namespace };
    }
    if (fsMeanings) return { ...fsMeanings, namespace: name === '*' || name === 'default' || name === 'promises' };
    if (ambient && name === '*') return { value: true, type: false, namespace: true };
    return { value: true, type: name !== '*', namespace: true };
  }

  private newNamespaceBody(node: TreeNode, namespace: Sym, isAmbient: boolean): Scope {
    const body = new Scope('function', namespace.namespaceExports, node);
    body.namespace = namespace;
    body.isAmbient = isAmbient;
    return body;
  }

  /** `import X = N.Y` names what `N.Y` names, as a value, a type, and a namespace. */
  private bindImportAlias(node: TreeNode, scope: Scope): void {
    const name = named(node)[0];
    if (!name) return;
    scope.declareValue(name.text, 'importAlias', node, name);
    scope.declareType(name.text, 'importAlias', node, name);
    scope.declareNamespace(name.text, 'importAlias', node, name);
  }

  /** `export` in a namespace adds the names its declaration declares to the namespace's exports. */
  private bindExport(node: TreeNode, scope: Scope): void {
    const isDefault = node.children.some((child) => !child.isNamed && child.type === 'default');
    const declaration = node.childForFieldName('declaration');
    if (scope.isAmbient && declaration) this.bindAmbientChild(declaration, scope);
    else this.bindChildren(node, scope);
    if (!scope.namespace) return;
    if (isDefault) {
      if (!declaration) return;
      if (declaredNames(declaration).length > 0) this.exportDeclared(declaration, scope, 'default');
      else
        bindAnonymousDefaultDeclaration(declaration, scope, (exportName, symbol, meaning) =>
          this.exportFrom(scope, symbol, meaning, exportName)
        );
      return;
    }
    const exportEquals = exportEqualsTargetOf(node);
    if (exportEquals) {
      if (this.isValidAmbientModuleExportEquals(scope)) scope.namespace.exportEquals ??= exportEquals;
      return;
    }
    if (declaration) this.exportDeclared(declaration, scope);
  }

  private isValidAmbientModuleExportEquals(scope: Scope): boolean {
    const namespace = scope.namespace;
    if (!scope.isAmbient || !namespace || this.isExternalModule) return false;
    return namespace.valueDeclarations.some((decl) => decl.childForFieldName('name')?.type === 'string');
  }

  private exportDeclared(declaration: TreeNode, scope: Scope, targetExportName?: string): void {
    for (const nameNode of declaredNames(declaration)) {
      const name = canonicalIdentifier(nameNode.text, nameNode);
      const exportName = targetExportName ?? name;
      const value = scope.values.get(name);
      if (value && value.valueDeclarations.some((node) => isWithin(node, declaration) || node.id === declaration.id))
        this.exportFrom(scope, value, 'value', exportName);
      const type = scope.types.get(name);
      if (type && type.typeDeclarations.some((node) => isWithin(node, declaration) || node.id === declaration.id))
        this.exportTypeFrom(scope, type, exportName);
      const namespace = scope.namespaces.get(name);
      if (
        namespace &&
        namespace.namespaceDeclarations.some((node) => isWithin(node, declaration) || node.id === declaration.id)
      )
        this.exportFrom(scope, namespace, 'namespace', exportName);
    }
  }

  private exportTypeFrom(scope: Scope, symbol: Sym, exportName: string): void {
    const exports = (scope.namespace as Sym).namespaceExports as Scope;
    const existing = exportName === 'default' ? exports.types.get('default') : undefined;
    if (existing && existing !== symbol && existing.typeKind === 'interface' && symbol.typeKind === 'interface') {
      existing.typeDeclarations.push(...symbol.typeDeclarations);
      existing.typeEntries.push(...symbol.typeEntries);
      return;
    }
    this.exportFrom(scope, symbol, 'type', exportName);
  }

  private exportFrom(
    scope: Scope,
    symbol: Sym,
    meaning: 'value' | 'type' | 'namespace',
    exportName = symbol.name
  ): void {
    const namespace = scope.namespace as Sym;
    const exports = namespace.namespaceExports as Scope;
    exports.exportViaDeclaration(exportName, symbol, meaning);
    if (exportName === symbol.name && (meaning === 'value' || meaning === 'namespace')) symbol.exportedFrom = namespace;
  }

  /** An enum is a value and a type; its initializers see its members by name. */
  private bindEnum(node: TreeNode, scope: Scope): void {
    const name = node.childForFieldName('name');
    const symbol = name ? scope.declareValue(name.text, 'enum', node, name) : undefined;
    if (name) scope.declareType(name.text, 'enum', node, name);
    const body = node.childForFieldName('body');
    if (!body) return;
    // Every declaration of an enum sees the members of the declarations before it by name.
    const membersScope = symbol?.enumMembers ?? new Scope('block', scope, body);
    if (symbol) symbol.enumMembers = membersScope;
    this.scopes.set(body.id, membersScope);
    for (const member of named(body)) {
      const memberName = memberNameOf(member);
      if (memberName !== undefined)
        membersScope.declareValue(memberName, 'enumMember', member, member.childForFieldName('name') ?? member);
    }
    this.bindChildren(body, membersScope);
  }

  private bindAssignment(node: TreeNode, scope: Scope, field: 'left' | 'argument'): void {
    const target = node.childForFieldName(field);
    if (target) this.noteAssigned(target, scope);
    this.bindChildren(node, scope);
  }

  private bindForIn(node: TreeNode, scope: Scope): void {
    const blockScope = this.newScope(node, 'block', scope);
    const header = node.childForFieldName('header') ?? node;
    const left = header.childForFieldName('left');
    const kind = header.childForFieldName('kind')?.text as 'let' | 'const' | 'var' | undefined;
    if (left && kind) {
      const target = kind === 'var' ? scope.functionScope : blockScope;
      for (const identifier of patternIdentifiers(left)) target.declareValue(identifier.text, kind, node, identifier);
    } else if (left) {
      this.noteAssigned(left, blockScope);
    }
    this.bindChildren(node, blockScope);
  }

  private bindCatch(node: TreeNode, scope: Scope): void {
    const blockScope = this.newScope(node, 'block', scope);
    const parameter = node.childForFieldName('parameter');
    if (parameter)
      for (const identifier of patternIdentifiers(parameter))
        blockScope.declareValue(identifier.text, 'catch', node, identifier);
    this.bindChildren(node, blockScope);
  }

  private isFunctionBody(node: TreeNode): boolean {
    const { parent } = node;
    return parent !== null && functionLikeTypes.has(parent.type) && parent.childForFieldName('body')?.id === node.id;
  }

  private noteAssigned(target: TreeNode, scope: Scope): void {
    if (this.options?.skipAssignmentAnalysis) return;
    let current = target;
    while (current.type === 'parenthesized_expression' || current.type === 'non_null_expression') {
      this.options?.budget?.spend();
      const inner = current.namedChildren[0];
      if (!inner) return;
      current = inner;
    }
    if (current.type === 'identifier') this.assignedIdentifiers.push({ identifier: current, scope });
    else if (
      current.type === 'array_pattern' ||
      current.type === 'object_pattern' ||
      current.type === 'array' ||
      current.type === 'object'
    )
      for (const identifier of patternIdentifiers(current)) this.assignedIdentifiers.push({ identifier, scope });
  }

  // code-gauge-allow functionCognitiveComplexity -- Declares each form of parameter a function-like node has.
  private bindFunction(node: TreeNode, scope: Scope): void {
    const functionScope = this.newScope(node, 'function', scope);
    const signatureScope = new SignatureScope(functionScope);
    this.declareTypeParameters(node, functionScope);
    // A named function expression sees its own name.
    if (node.type === 'function_expression' || node.type === 'generator_function') {
      const name = node.childForFieldName('name');
      if (name) functionScope.declareValue(name.text, 'function', node, name);
    }
    const parameters = node.childForFieldName('parameters');
    if (parameters) {
      for (const parameter of named(parameters)) {
        const pattern = parameter.childForFieldName('pattern') ?? parameter;
        if (pattern.type === 'this') continue;
        for (const identifier of patternIdentifiers(pattern))
          functionScope.declareValue(identifier.text, 'parameter', parameter, identifier);
      }
    }
    const single = node.childForFieldName('parameter');
    if (single) functionScope.declareValue(single.text, 'parameter', single, single);
    for (const child of named(node)) {
      if (child.type === 'statement_block') {
        this.bindChildren(child, functionScope);
      } else {
        this.scopes.set(child.id, signatureScope);
        this.bind(child, signatureScope);
      }
    }
  }

  private bindClass(node: TreeNode, scope: Scope): void {
    const classScope = this.newScope(node, 'class', scope);
    this.declareTypeParameters(node, classScope);
    // A class expression sees its own name.
    if (node.type === 'class') {
      const name = node.childForFieldName('name');
      if (name) {
        classScope.declareValue(name.text, 'class', node, name);
        classScope.declareType(name.text, 'class', node, name);
      }
    }
    this.bindChildren(node, classScope);
  }

  private bindTypeParameterOwner(node: TreeNode, scope: Scope): void {
    const ownerScope = this.newScope(node, 'block', scope);
    this.declareTypeParameters(node, ownerScope);
    const interfaceBody = node.type === 'interface_declaration' ? node.childForFieldName('body') : undefined;
    for (const child of named(node)) {
      if (child.id === interfaceBody?.id) this.bindLibraryType(child, ownerScope);
      else this.bind(child, ownerScope);
    }
  }

  private bindAmbient(node: TreeNode, scope: Scope): void {
    for (const child of named(node)) this.bindAmbientChild(child, scope);
  }

  private bindAmbientChild(child: TreeNode, scope: Scope): void {
    switch (child.type) {
      case 'variable_declaration':
      case 'lexical_declaration': {
        const kind =
          child.type === 'variable_declaration' ? 'var' : (child.childForFieldName('kind')?.text as 'let' | 'const');
        for (const declarator of named(child)) this.bindAmbientVariable(declarator, scope, kind);
        break;
      }
      case 'function_signature': {
        const name = child.childForFieldName('name');
        if (name) scope.declareValue(name.text, 'function', child, name);
        this.bindFunction(child, scope);
        break;
      }
      case 'statement_block': {
        const augments = child.parent ? this.globalAugmentationTarget(child.parent, true) : undefined;
        this.bindAmbient(child, this.newScope(child, 'block', scope, augments));
        break;
      }
      case 'internal_module':
      case 'module': {
        this.bindNamespace(child, scope, true);
        break;
      }
      default: {
        this.bind(child, scope);
      }
    }
  }

  private bindAmbientVariable(node: TreeNode, scope: Scope, kind: 'let' | 'const' | 'var'): void {
    const name = node.childForFieldName('name');
    if (!name) return;
    scope.declareAmbientValue(name.text, kind, node, name);
    const annotation = node.childForFieldName('type');
    const type = annotation && named(annotation)[0];
    if (type) this.bindLibraryType(type, scope);
  }

  private bindLibraryType(node: TreeNode, scope: Scope): void {
    if (this.options?.deferLibraryTypes) this.deferredTypes.set(node.id, scope);
    else this.bind(node, scope);
  }

  private globalAugmentationTarget(node: TreeNode, isAmbientNode: boolean): Scope | undefined {
    if (this.options?.deferLibraryTypes) return this.moduleScope;
    return isAmbientNode && isDirectGlobalAugmentationContainer(node, this.isExternalModule)
      ? (this.options?.rootScope ?? this.globalScope)
      : undefined;
  }

  private declareTypeParameters(node: TreeNode, scope: Scope): void {
    const parameters = node.childForFieldName('type_parameters');
    if (!parameters) return;
    for (const parameter of named(parameters)) {
      const name = parameter.childForFieldName('name');
      if (name) scope.declareType(name.text, 'typeParameter', parameter, name);
    }
  }
}

/** The declarations of a function's body that its parameters, type parameters, and return type cannot see. */
const bodyOnlyValueKinds = new Set<ValueKind>(['var', 'let', 'const', 'class']);

/**
 * What a function's parameters, type parameters, and return type see of the names the function declares, as tsc
 * resolves them: its parameters, type parameters, and own name, and the functions its body declares, but not the
 * variables, classes, and types the body declares, for which they see the enclosing scope's names instead.
 */
class SignatureScope extends Scope {
  constructor(private readonly declaring: Scope) {
    super('function', declaring.parent, declaring.node);
  }

  override lookupValue(name: string, budget?: ExecutionBudget): Sym | undefined {
    budget?.spend();
    const symbol = this.declaring.values.get(name);
    if (symbol && !bodyOnlyValueKinds.has(symbol.valueKind as ValueKind)) return symbol;
    return this.parent?.lookupValue(name, budget);
  }

  override lookupType(name: string): Sym | undefined {
    const symbol = this.declaring.types.get(name);
    if (symbol?.typeKind === 'typeParameter') return symbol;
    return this.parent?.lookupType(name);
  }

  override lookupNamespace(name: string, budget?: ExecutionBudget): Sym | undefined {
    return this.parent?.lookupNamespace(name, budget);
  }

  override lookupContainer(name: string, budget?: ExecutionBudget): Sym | undefined {
    return this.parent?.lookupContainer(name, budget);
  }
}

export function symbolDeclaredBy(scope: Scope, name: string): Sym | undefined {
  return scope.values.get(name);
}

/** The names an import clause declares, with the export each names: `*` for the module, `default` for its default. */
function importedNames(clause: TreeNode): { local: TreeNode; name: string; typeOnly: boolean }[] {
  if (clause.type === 'import_require_clause')
    return named(clause)
      .slice(0, 1)
      .map((local) => ({ local, name: '*', typeOnly: false }));
  return named(clause).flatMap((part): { local: TreeNode; name: string; typeOnly: boolean }[] => {
    if (part.type === 'identifier') return [{ local: part, name: 'default', typeOnly: false }];
    if (part.type === 'namespace_import')
      return named(part)
        .slice(0, 1)
        .map((local) => ({ local, name: '*', typeOnly: false }));
    return part.type === 'named_imports' ? named(part).flatMap(importedSpecifier) : [];
  });
}

function importedSpecifier(specifier: TreeNode): { local: TreeNode; name: string; typeOnly: boolean }[] {
  const imported = specifier.childForFieldName('name');
  const local = specifier.childForFieldName('alias') ?? imported;
  if (!imported || !local || local.type === 'string') return [];
  const typeOnly = specifier.children.some((child) => !child.isNamed && child.type === 'type');
  const name = imported.type === 'string' ? stringValue(imported) : canonicalIdentifier(imported.text, imported);
  return [{ local, name, typeOnly }];
}

/** The names of a namespace's path, as `A`, `B`, and `C` of `A.B.C`. */
function namespacePath(name: TreeNode): TreeNode[] {
  if (name.type !== 'nested_identifier' && name.type !== 'member_expression') return [name];
  const object = name.childForFieldName('object');
  const property = name.childForFieldName('property');
  return [...(object ? namespacePath(object) : []), ...(property ? [property] : [])];
}

function isExportedNamespaceRoot(node: TreeNode): boolean {
  const outer =
    node.parent?.type === 'expression_statement' || node.parent?.type === 'ambient_declaration' ? node.parent : node;
  return outer.parent?.type === 'export_statement';
}

function hasAmbientExportClause(body: TreeNode): boolean {
  return named(body).some((child) => child.type === 'export_statement' && !child.childForFieldName('declaration'));
}

/**
 * The name nodes a declaration declares: the names of a variable declaration's patterns, the name of any other
 * declaration, and the first name of `namespace A.B`.
 */
export function declaredNames(declaration: TreeNode): TreeNode[] {
  if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration')
    return named(declaration).flatMap((declarator) => {
      const name = declarator.childForFieldName('name');
      return name ? patternIdentifiers(name) : [];
    });
  if (declaration.type === 'ambient_declaration') return named(declaration).flatMap(declaredNames);
  if (declaration.type === 'expression_statement') return named(declaration).flatMap(declaredNames);
  if (declaration.type === 'import_alias') return named(declaration).slice(0, 1);
  const name = declaration.childForFieldName('name');
  if (!name) return [];
  return name.type === 'nested_identifier' ? namespacePath(name).slice(0, 1) : [name];
}

function assignmentOwner(scope: Scope, budget: ExecutionBudget | undefined): number | undefined {
  let owner = scope.functionScope;
  while (owner.node?.type === 'class_static_block' && owner.parent) {
    budget?.spend();
    owner = owner.parent.functionScope;
  }
  return owner.node?.id;
}

function assignmentEnd(identifier: TreeNode, declarationStart: number, budget: ExecutionBudget | undefined): number {
  let end = identifier.startIndex;
  for (let node: TreeNode | null = identifier; node && node.startIndex > declarationStart; node = node.parent) {
    budget?.spend();
    if (assignmentBoundaries.has(node.type)) end = node.endIndex;
  }
  return end;
}
