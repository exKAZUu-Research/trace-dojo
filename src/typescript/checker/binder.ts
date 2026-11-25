import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { ExecutionBudget } from '../../interpreter/limits';
import { memberNameOf } from './enums';
import { Scope, Sym, type ValueKind } from './scopes';
import { assignmentKind, isWithin, named, patternIdentifiers, stringValue } from './syntax';

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
    }
  ) {
    this.moduleScope = options?.rootScope ?? new Scope('module', globalScope, root);
    this.scopes.set(root.id, this.moduleScope);
    this.bindChildren(root, this.moduleScope);
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
    if (!name) return;
    let outer = scope;
    let namespace: Sym | undefined;
    for (const part of namespacePath(name)) {
      namespace = outer.declareValue(part.text, 'namespace', node, part);
      if (outer.namespace) this.exportFrom(outer, namespace, 'value');
      namespace.namespaceExports ??= new Scope('block', outer, node);
      outer = this.newNamespaceBody(node, namespace, isAmbient);
    }
    if (body) this.bindNamespaceBody(body, outer, isAmbient);
  }

  /** The statements of a namespace's body, where those of a `declare namespace` are ambient and all exported. */
  private bindNamespaceBody(body: TreeNode, scope: Scope, isAmbient: boolean): void {
    this.scopes.set(body.id, scope);
    for (const child of named(body)) {
      if (!isAmbient) {
        this.bind(child, scope);
        continue;
      }
      this.bindAmbientChild(child, scope);
      this.exportDeclared(child, scope);
    }
  }

  /** `declare module "m" { ... }`, whose declarations are the exports an `import` of "m" sees. */
  private bindAmbientModule(node: TreeNode, name: string, scope: Scope): void {
    const module = new Sym(name, scope);
    module.valueKind = 'namespace';
    module.valueDeclarations.push(node);
    module.namespaceExports = new Scope('block', scope, node);
    this.ambientModules.set(name, module);
    const body = node.childForFieldName('body');
    if (body) this.bindNamespaceBody(body, this.newNamespaceBody(node, module, true), true);
  }

  /** The names an `import` declares, which stand for what a module exports. */
  private bindImport(node: TreeNode, scope: Scope): void {
    const clause = node.childForFieldName('import_clause');
    const source = node.childForFieldName('source') ?? clause?.childForFieldName('source');
    if (!source || !clause) return;
    const module = stringValue(source);
    for (const [nameNode, name] of importedNames(clause)) {
      const value = scope.declareValue(nameNode.text, 'import', node, nameNode);
      value.importTarget = { module, name };
      scope.declareType(nameNode.text, 'import', node, nameNode).importTarget = { module, name };
    }
  }

  private newNamespaceBody(node: TreeNode, namespace: Sym, isAmbient: boolean): Scope {
    const body = new Scope('function', namespace.namespaceExports, node);
    body.namespace = namespace;
    body.isAmbient = isAmbient;
    return body;
  }

  /** `import X = N.Y` names what `N.Y` names, as a value and as a type. */
  private bindImportAlias(node: TreeNode, scope: Scope): void {
    const name = named(node)[0];
    if (!name) return;
    scope.declareValue(name.text, 'importAlias', node, name);
    scope.declareType(name.text, 'importAlias', node, name);
  }

  /** `export` in a namespace adds the names its declaration declares to the namespace's exports. */
  private bindExport(node: TreeNode, scope: Scope): void {
    this.bindChildren(node, scope);
    const declaration = node.childForFieldName('declaration');
    if (declaration && scope.namespace) this.exportDeclared(declaration, scope);
  }

  private exportDeclared(declaration: TreeNode, scope: Scope): void {
    for (const nameNode of declaredNames(declaration)) {
      const value = scope.values.get(nameNode.text);
      if (value && value.valueDeclarations.some((node) => isWithin(node, declaration) || node.id === declaration.id))
        this.exportFrom(scope, value, 'value');
      const type = scope.types.get(nameNode.text);
      if (type && type.typeDeclarations.some((node) => isWithin(node, declaration) || node.id === declaration.id))
        this.exportFrom(scope, type, 'type');
    }
  }

  private exportFrom(scope: Scope, symbol: Sym, meaning: 'value' | 'type'): void {
    const namespace = scope.namespace as Sym;
    const exports = namespace.namespaceExports as Scope;
    (meaning === 'value' ? exports.values : exports.types).set(symbol.name, symbol);
    if (meaning === 'value') symbol.exportedFrom = namespace;
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
        // `declare global { ... }` augments the globals from a module (the library's own included), but not from a script.
        const augments = this.options?.deferLibraryTypes
          ? this.moduleScope
          : this.options?.rootScope
            ? undefined
            : this.globalScope;
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
}

export function symbolDeclaredBy(scope: Scope, name: string): Sym | undefined {
  return scope.values.get(name);
}

/** The names an import clause declares, with the export each names: `*` for the module, `default` for its default. */
function importedNames(clause: TreeNode): [TreeNode, string][] {
  if (clause.type === 'import_require_clause')
    return named(clause)
      .slice(0, 1)
      .map((name) => [name, '*']);
  return named(clause).flatMap((part): [TreeNode, string][] => {
    if (part.type === 'identifier') return [[part, 'default']];
    if (part.type === 'namespace_import')
      return named(part)
        .slice(0, 1)
        .map((name) => [name, '*']);
    if (part.type !== 'named_imports') return [];
    return named(part).flatMap((specifier): [TreeNode, string][] => {
      const imported = specifier.childForFieldName('name');
      const local = specifier.childForFieldName('alias') ?? imported;
      return imported && local ? [[local, imported.text]] : [];
    });
  });
}

/** The names of a namespace's path, as `A`, `B`, and `C` of `A.B.C`. */
function namespacePath(name: TreeNode): TreeNode[] {
  if (name.type !== 'nested_identifier' && name.type !== 'member_expression') return [name];
  const object = name.childForFieldName('object');
  const property = name.childForFieldName('property');
  return [...(object ? namespacePath(object) : []), ...(property ? [property] : [])];
}

/** The name nodes a declaration declares, as the names of a variable declaration's patterns or a class's name. */
function declaredNames(declaration: TreeNode): TreeNode[] {
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
