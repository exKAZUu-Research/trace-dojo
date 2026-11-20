import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { Scope, type Sym, type ValueKind } from './scopes';
import { assignmentKind, named, patternIdentifiers } from './syntax';

const functionLikeTypes = new Set([
  'function_declaration',
  'function_expression',
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
  private readonly assignedIdentifiers: TreeNode[] = [];
  readonly moduleScope: Scope;
  /** How each kind of node that declares names or opens a scope of its own is bound. */
  private readonly binders = new Map<string, (node: TreeNode, scope: Scope) => void>([
    ['lexical_declaration', (node, scope) => this.bindVariableDeclaration(node, scope)],
    ['variable_declaration', (node, scope) => this.bindVariableDeclaration(node, scope)],
    ['function_declaration', (node, scope) => this.bindFunctionDeclaration(node, scope)],
    ['function_signature', (node, scope) => this.bindFunctionDeclaration(node, scope)],
    ['class_declaration', (node, scope) => this.bindClassDeclaration(node, scope)],
    ['abstract_class_declaration', (node, scope) => this.bindClassDeclaration(node, scope)],
    ['class', (node, scope) => this.bindClass(node, scope)],
    ['interface_declaration', (node, scope) => this.bindTypeDeclaration(node, scope, 'interface')],
    ['type_alias_declaration', (node, scope) => this.bindTypeDeclaration(node, scope, 'alias')],
    ['ambient_declaration', (node, scope) => this.bindAmbient(node, scope)],
    ['assignment_expression', (node, scope) => this.bindAssignment(node, scope, 'left')],
    ['augmented_assignment_expression', (node, scope) => this.bindAssignment(node, scope, 'left')],
    ['update_expression', (node, scope) => this.bindAssignment(node, scope, 'argument')],
    ['for_in_statement', (node, scope) => this.bindForIn(node, scope)],
    ['catch_clause', (node, scope) => this.bindCatch(node, scope)],
  ]);

  constructor(
    root: TreeNode,
    readonly globalScope: Scope,
    private readonly options?: { rootScope?: Scope; deferLibraryTypes?: boolean }
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
    for (const identifier of this.assignedIdentifiers) {
      const scope = this.scopeOf(identifier);
      const symbol = scope.lookupValue(identifier.text);
      if (!symbol) continue;
      symbol.isReassigned = true;
      symbol.isDefinitelyAssigned ||= assignmentKind(identifier) !== 'compound';
      const position =
        assignmentOwner(scope) === assignmentOwner(symbol.scope)
          ? assignmentEnd(identifier, symbol.valueDeclaration?.startIndex ?? 0)
          : Number.POSITIVE_INFINITY;
      symbol.lastAssignment = Math.max(symbol.lastAssignment, position);
    }
  }

  /** The scope a node sees names in. */
  scopeOf(node: TreeNode): Scope {
    for (let current: TreeNode | null = node; current; current = current.parent) {
      const scope = this.scopes.get(current.id);
      if (scope) return scope;
    }
    return this.moduleScope;
  }

  /** The scope a scope-creating node itself creates. */
  ownScope(node: TreeNode): Scope | undefined {
    return this.scopes.get(node.id);
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
    return [this.moduleScope, ...this.scopes.values()].filter(
      (scope, index, scopes) => scopes.indexOf(scope) === index
    );
  }

  private bind(node: TreeNode, scope: Scope): void {
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

  private bindAssignment(node: TreeNode, scope: Scope, field: 'left' | 'argument'): void {
    const target = node.childForFieldName(field);
    if (target) this.noteAssigned(target);
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
      this.noteAssigned(left);
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

  private noteAssigned(target: TreeNode): void {
    let current = target;
    while (current.type === 'parenthesized_expression' || current.type === 'non_null_expression') {
      const inner = current.namedChildren[0];
      if (!inner) return;
      current = inner;
    }
    if (current.type === 'identifier') this.assignedIdentifiers.push(current);
    else if (
      current.type === 'array_pattern' ||
      current.type === 'object_pattern' ||
      current.type === 'array' ||
      current.type === 'object'
    )
      for (const identifier of patternIdentifiers(current)) this.assignedIdentifiers.push(identifier);
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Declares each form of parameter a function-like node has.
  private bindFunction(node: TreeNode, scope: Scope): void {
    const functionScope = this.newScope(node, 'function', scope);
    const signatureScope = new SignatureScope(functionScope);
    this.declareTypeParameters(node, functionScope);
    // A named function expression sees its own name.
    if (node.type === 'function_expression') {
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

  // code-gauge-allow functionCognitiveComplexity 16 -- Binds ambient variables with their declaration kind and initialized resolution mode, functions with parameter scopes, and other ambient forms recursively.
  private bindAmbient(node: TreeNode, scope: Scope): void {
    for (const child of named(node)) {
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
          // `declare global { ... }`
          this.bindAmbient(child, this.newScope(child, 'block', scope, this.moduleScope));
          break;
        }
        default: {
          this.bind(child, scope);
        }
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

  override lookupValue(name: string): Sym | undefined {
    const symbol = this.declaring.values.get(name);
    if (symbol && !bodyOnlyValueKinds.has(symbol.valueKind as ValueKind)) return symbol;
    return this.parent?.lookupValue(name);
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

function assignmentOwner(scope: Scope): number | undefined {
  let owner = scope.functionScope;
  while (owner.node?.type === 'class_static_block' && owner.parent) owner = owner.parent.functionScope;
  return owner.node?.id;
}

function assignmentEnd(identifier: TreeNode, declarationStart: number): number {
  let end = identifier.startIndex;
  for (let node: TreeNode | null = identifier; node && node.startIndex > declarationStart; node = node.parent)
    if (assignmentBoundaries.has(node.type)) end = node.endIndex;
  return end;
}
