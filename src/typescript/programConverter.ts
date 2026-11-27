import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import type {
  ClassNode,
  Expression,
  FunctionKind,
  FunctionNode,
  IterationSource,
  MemberExpression,
  Program,
  Statement,
} from '../javascript/ast';
import { nameOf, type Node, rowOf, unsupported, unwrapParentheses } from '../javascript/convertNodes';
import { decodeStringLiteral } from '../javascript/literals';
import { isConstructorDefinition, ProgramConverter } from '../javascript/programConverter';
import { countedEnumValue, type EnumsInScope, type FoldedValue, foldEnumValue, memberKeyName } from './enumFolding';
import { IMPORTED_MODULE, isHiddenCallFunction, isUnsteppedStatement, PARAMETER_PROPERTY_ASSIGNMENT } from './jsView';

const functionScopeTypes = new Set([
  'function_declaration',
  'function_expression',
  'generator_function_declaration',
  'generator_function',
  'arrow_function',
  'method_definition',
  'class_static_block',
]);

const blockScopeTypes = new Set([
  'statement_block',
  'for_statement',
  'for_in_statement',
  'switch_body',
  'catch_clause',
  'class',
]);

/** Converts a TypeScript program, viewed as JavaScript, to the JavaScript interpreter's AST. */
export class TypeScriptProgramConverter extends ProgramConverter {
  /**
   * tsx compiles every file, one with `import` or `export` included, to CommonJS that is not strict mode code unless
   * it says `"use strict"`.
   */
  protected override readonly isStrictByDefault = false;
  protected override readonly hasAutoAccessors = true;
  /** The folded members of each enum, by the scope node declaring its name and the name, as esbuild resolves a reference. */
  private readonly foldedEnums = new WeakMap<Node, Map<string, Map<string, FoldedValue>>>();
  private readonly scopeParent = new WeakMap<Node, Node>();
  private readonly scopeNames = new WeakMap<Node, Map<string, Node[]>>();
  private readonly enclosingScope = new WeakMap<Node, Node>();
  private readonly enclosingFnScope = new WeakMap<Node, Node>();
  private readonly foldingEnums = new Map<string, Map<string, FoldedValue>>();
  /** The errors of the statements that failed to convert, which tsc reports all of, unlike Node's first one. */
  private readonly statementErrors: SourceDiagnostic[] = [];

  constructor(source: string, trace: TraceOptions | undefined) {
    super(source, trace);
    this.recoverFromStatementErrors();
    const convertReturn = this.statementConverters.return_statement;
    this.statementConverters.return_statement = (node) => {
      const statement = convertReturn(node);
      if (statement.kind === 'return' && statement.value?.kind === 'call' && statement.value.callee.kind === 'super')
        statement.value.skipsAfterSuper = true;
      return statement;
    };
    this.statementConverters.enum_declaration = (node) => this.enumDeclaration(node);
    for (const type of ['member_expression', 'subscript_expression'] as const) {
      const convertMember = this.expressionConverters[type];
      this.expressionConverters[type] = (node) => this.inlinedConstEnumMember(node) ?? convertMember(node);
    }
    this.expressionConverters[IMPORTED_MODULE] = (node) => ({
      kind: 'importedModule',
      specifier: decodeStringLiteral(node.text),
      row: rowOf(node),
    });
    // `this.name = name` for a parameter property, which steps on the parameter's row as the assignment it stands for.
    this.statementConverters[PARAMETER_PROPERTY_ASSIGNMENT] = (node: Node) => {
      const row = node.startPosition.row;
      const name = nameOf(node);
      return {
        kind: 'expression',
        expression: {
          kind: 'assign',
          operator: '=',
          target: {
            kind: 'member',
            object: { kind: 'this', row },
            property: { kind: 'key', key: name },
            optional: false,
            row,
          },
          value: { kind: 'identifier', name, row },
          row,
        },
        stepRow: this.stepRowOf(node),
        row,
      };
    };
  }

  /**
   * `enum E { A, B = 5 }` as tsx compiles it: `var E = (E = E || {}, E[E["A"] = 0] = "A", …, E)`, with the values
   * esbuild folds (`foldEnumValue`): a member without an initializer counts up from the one before, and a member esbuild
   * knows to be a string has no reverse mapping.
   */
  private enumDeclaration(node: Node): Statement {
    const row = rowOf(node);
    const nameNode = node.childForFieldName('name') as Node;
    const name = nameOf(nameNode);
    this.declareVariable(nameNode, name, 'var');
    const enumObject = (): Expression => ({ kind: 'identifier', name, row });
    const memberOf = (key: Expression): MemberExpression => ({
      kind: 'member',
      object: enumObject(),
      property: { kind: 'computed', expression: key },
      optional: false,
      row,
    });
    const text = (value: string): Expression => ({ kind: 'literal', value, row });
    const assignments: Expression[] = [];
    const currentScope = this.enclosingFnScope.get(node);
    const folded = currentScope ? this.foldedMapFor(currentScope, name) : new Map<string, FoldedValue>();
    const enumsInScope: EnumsInScope = (enumName) =>
      enumName === name ? folded : this.lookupFoldedEnum(node, enumName);
    let previous: FoldedValue;
    let isFirst = true;
    for (const member of node.childForFieldName('body')?.namedChildren ?? []) {
      if (member.type === 'comment') continue;
      const key = enumMemberName(member);
      const initializer = member.childForFieldName('value');
      const known = initializer
        ? foldEnumValue(initializer, enumsInScope, folded)
        : countedEnumValue(previous, isFirst);
      const value: Expression = initializer
        ? this.expression(initializer)
        : { kind: 'literal', value: known?.kind === 'number' ? known.value : undefined, row };
      assignments.push({ kind: 'assign', operator: '=', target: memberOf(text(key)), value, row });
      // esbuild maps the value back to the name unless it knows the value is a string.
      if (known?.kind !== 'string')
        assignments.push({
          kind: 'assign',
          operator: '=',
          target: memberOf(memberOf(text(key))),
          value: text(key),
          row,
        });
      folded.set(key, known);
      previous = known;
      isFirst = false;
    }
    const created: Expression = {
      kind: 'assign',
      operator: '=',
      target: { kind: 'identifier', name, row },
      value: { kind: 'logical', operator: '||', left: enumObject(), right: { kind: 'object', members: [], row }, row },
      row,
    };
    return {
      kind: 'declaration',
      declarationKind: 'var',
      declarators: [
        {
          target: { kind: 'identifier', name, row },
          init: { kind: 'sequence', expressions: [created, ...assignments, enumObject()], row },
        },
      ],
      stepRow: this.stepRowOf(node),
      row,
    };
  }

  override convert(root: Node): Program {
    this.indexEnumScopes(root, root, root);
    const program = super.convert(root);
    if (this.statementErrors.length > 0) throw new CompileError(this.statementErrors);
    return {
      ...program,
      hasCommonJsReceiver: true,
      rejectsFunctionText: true,
      rejectsUnavailableMembers: true,
    };
  }

  private indexEnumScopes(node: Node, blockScope: Node, fnScope: Node): void {
    this.enclosingScope.set(node, blockScope);
    this.enclosingFnScope.set(node, fnScope);
    this.recordOwnScopeBindings(node, fnScope);
    for (const child of node.namedChildren) {
      this.recordScopeDeclaration(child, blockScope, fnScope);
      const next = childScopesOf(child, blockScope, fnScope);
      if (next.block !== blockScope && !this.scopeParent.has(next.block)) this.scopeParent.set(next.block, blockScope);
      this.indexEnumScopes(child, next.block, next.fn);
    }
  }

  private recordOwnScopeBindings(node: Node, fnScope: Node): void {
    for (const entry of ownScopeEntries(node, fnScope)) {
      for (const name of entry.names) this.addScopeEntry(entry.scope, name);
    }
  }

  private recordScopeDeclaration(node: Node, blockScope: Node, fnScope: Node): void {
    const entry = declaredScopeEntry(node, blockScope, fnScope);
    if (!entry) return;
    for (const name of entry.names) this.addScopeEntry(entry.scope, name, entry.enumNode);
  }

  private addScopeEntry(scope: Node, name: string, enumNode?: Node): void {
    let map = this.scopeNames.get(scope);
    if (!map) {
      map = new Map();
      this.scopeNames.set(scope, map);
    }
    const list = map.get(name) ?? [];
    if (enumNode) list.push(enumNode);
    map.set(name, list);
  }

  private inlinedConstEnumMember(node: Node): Expression | undefined {
    const object = node.childForFieldName('object');
    const key = object?.type === 'identifier' ? memberKeyName(node) : undefined;
    if (!object || key === undefined || !this.isConstEnumReference(object, nameOf(object))) return undefined;
    const folded = this.lookupFoldedEnum(node, nameOf(object))?.get(key);
    return folded?.value === undefined ? undefined : { kind: 'literal', value: folded.value, row: rowOf(node) };
  }

  private isConstEnumReference(fromNode: Node, enumName: string): boolean {
    for (let scope = this.enclosingScope.get(fromNode); scope; scope = this.scopeParent.get(scope)) {
      const declarations = this.scopeNames.get(scope)?.get(enumName);
      if (!declarations) continue;
      return declarations.some(isConstEnumDeclaration);
    }
    return false;
  }

  private lookupFoldedEnum(fromNode: Node, enumName: string): Map<string, FoldedValue> | undefined {
    for (let scope = this.enclosingScope.get(fromNode); scope; scope = this.scopeParent.get(scope)) {
      const declarations = this.scopeNames.get(scope)?.get(enumName);
      if (!declarations) continue;
      if (declarations.length === 0) return undefined;
      return this.ensureFoldedEnum(scope, enumName, declarations, fromNode);
    }
    return undefined;
  }

  private ensureFoldedEnum(
    scope: Node,
    enumName: string,
    declarations: Node[],
    fromNode: Node
  ): Map<string, FoldedValue> | undefined {
    const isFullScope = this.enclosingFnScope.get(fromNode) !== scope || declarations.some(isConstEnumDeclaration);
    const existing = !isFullScope ? this.foldedEnums.get(scope)?.get(enumName) : undefined;
    if (existing) return existing;
    const key = `${scope.startIndex}:${enumName}`;
    const inProgress = this.foldingEnums.get(key);
    if (inProgress) return inProgress;
    const folded = new Map<string, FoldedValue>();
    this.foldingEnums.set(key, folded);
    try {
      for (const declaration of declarations) {
        if (!isFullScope && declaration.startIndex > fromNode.startIndex) continue;
        this.foldDeclarationInto(declaration, folded);
      }
      return folded;
    } finally {
      this.foldingEnums.delete(key);
    }
  }

  private foldDeclarationInto(declaration: Node, folded: Map<string, FoldedValue>): void {
    let previous: FoldedValue;
    let isFirst = true;
    for (const member of declaration.childForFieldName('body')?.namedChildren ?? []) {
      if (member.type === 'comment') continue;
      const key = enumMemberName(member);
      const initializer = member.childForFieldName('value');
      const known = initializer
        ? foldEnumValue(initializer, (name) => this.lookupFoldedEnum(initializer, name), folded)
        : countedEnumValue(previous, isFirst);
      folded.set(key, known);
      previous = known;
      isFirst = false;
    }
  }

  private foldedMapFor(scope: Node, name: string): Map<string, FoldedValue> {
    const scopeEnums = this.foldedEnums.get(scope) ?? new Map<string, Map<string, FoldedValue>>();
    this.foldedEnums.set(scope, scopeEnums);
    const folded = scopeEnums.get(name) ?? new Map<string, FoldedValue>();
    scopeEnums.set(name, folded);
    return folded;
  }

  private recoverFromStatementErrors(): void {
    for (const [type, convert] of Object.entries(this.statementConverters)) {
      this.statementConverters[type] = (node) => {
        try {
          return convert(node);
        } catch (error) {
          if (!(error instanceof CompileError)) throw error;
          this.statementErrors.push(...error.diagnostics);
          return { kind: 'empty', row: rowOf(node) };
        }
      };
    }
  }

  override classNode(node: Node, name: string): ClassNode {
    const cls = super.classNode(node, name);
    if (!cls.superClass || !cls.ctor) return cls;
    const constructor = node.childForFieldName('body')?.namedChildren.find((member) => isConstructorDefinition(member));
    const count =
      constructor?.childForFieldName('body')?.children.filter((child) => child?.type === PARAMETER_PROPERTY_ASSIGNMENT)
        .length ?? 0;
    if (count > 0) cls.afterSuper = (cls.ctor.body as Statement[]).splice(0, count);
    return cls;
  }

  /** The decorators of a class or a class member, which run as TypeScript's standard decorators do. */
  protected override decoratorsOf(node: Node): Expression[] | undefined {
    const decorators = node.namedChildren.filter((child) => child.type === 'decorator');
    if (decorators.length === 0) return undefined;
    return decorators.map((decorator) => this.expression(decorator.namedChildren[0] as Node));
  }

  override functionNode(node: Node, kind: FunctionKind, name?: string): FunctionNode {
    const fn = super.functionNode(node, kind, name);
    if (isHiddenCallFunction(node)) fn.hidesCallRow = true;
    return fn;
  }

  protected override stepRowOf(node: Node): number | undefined {
    return isUnsteppedStatement(node) ? undefined : super.stepRowOf(node);
  }

  protected override duplicate(node: Node, name: string): never {
    return super.duplicate(node.childForFieldName('name') ?? node, name);
  }

  protected override arrayDestructuringSource(node: Node): IterationSource | undefined {
    return super.arrayDestructuringSource(unwrapParentheses(node));
  }
}

function isConstEnumDeclaration(declaration: Node): boolean {
  return declaration.children.some((child) => !child?.isNamed && child?.type === 'const');
}

/** The name of an enum member, which an identifier or a string literal gives. */
function enumMemberName(member: Node): string {
  const name = member.type === 'enum_assignment' ? (member.childForFieldName('name') as Node) : member;
  // tsx's esbuild does not compile a member name in brackets.
  if (name.type === 'computed_property_name') unsupported(name, 'enum のメンバー名を [ ] で書くこと');
  return name.type === 'string' ? decodeStringLiteral(name.text) : nameOf(name);
}

function childScopesOf(child: Node, blockScope: Node, fnScope: Node): { block: Node; fn: Node } {
  if (functionScopeTypes.has(child.type)) return { block: child, fn: child };
  if (blockScopeTypes.has(child.type)) return { block: child, fn: fnScope };
  return { block: blockScope, fn: fnScope };
}

const blockNamedDeclarationTypes = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
]);
const variableDeclarationTypes = new Set(['variable_declaration', 'lexical_declaration', 'using_declaration']);

const selfNamedExpressionTypes = new Set(['function_expression', 'generator_function', 'class']);

function ownScopeEntries(node: Node, fnScope: Node): { scope: Node; names: string[] }[] {
  const entries: { scope: Node; names: string[] }[] = [];
  if (selfNamedExpressionTypes.has(node.type)) entries.push({ scope: node, names: declaredNodeName(node) });
  if (functionScopeTypes.has(node.type)) entries.push({ scope: node, names: functionParameterNames(node) });
  if (node.type === 'catch_clause') {
    const parameter = node.childForFieldName('parameter');
    if (parameter) entries.push({ scope: node, names: patternIdentifierNames(parameter) });
  }
  const forIn = node.type === 'for_in_statement' ? forInScopeEntry(node, fnScope) : undefined;
  if (forIn) entries.push(forIn);
  return entries;
}

function forInScopeEntry(node: Node, fnScope: Node): { scope: Node; names: string[] } | undefined {
  const header = node.childForFieldName('header') ?? node;
  const kind = header.childForFieldName('kind')?.text;
  const hasUsing = header.children.some((child) => child?.type === 'using');
  const left = header.childForFieldName('left');
  if (!left || (!kind && !hasUsing)) return undefined;
  return { scope: kind === 'var' ? fnScope : node, names: patternIdentifierNames(left) };
}

function functionParameterNames(node: Node): string[] {
  const single = node.childForFieldName('parameter');
  if (single) return patternIdentifierNames(single);
  return (node.childForFieldName('parameters')?.namedChildren ?? []).flatMap(patternIdentifierNames);
}

function declaredScopeEntry(
  node: Node,
  blockScope: Node,
  fnScope: Node
): { scope: Node; names: string[]; enumNode?: Node } | undefined {
  if (node.type === 'enum_declaration') return { scope: fnScope, names: declaredNodeName(node), enumNode: node };
  if (blockNamedDeclarationTypes.has(node.type)) return { scope: blockScope, names: declaredNodeName(node) };
  if (!variableDeclarationTypes.has(node.type)) return undefined;
  const scope = node.type === 'variable_declaration' ? fnScope : blockScope;
  return { scope, names: declaratorIdentifierNames(node) };
}

function declaredNodeName(node: Node): string[] {
  const nameNode = node.childForFieldName('name');
  return nameNode ? [nameOf(nameNode)] : [];
}

function declaratorIdentifierNames(declaration: Node): string[] {
  return declaration.namedChildren.flatMap((declarator) => {
    const nameNode = declarator.childForFieldName('name');
    return nameNode ? patternIdentifierNames(nameNode) : [];
  });
}

function patternIdentifierNames(node: Node): string[] {
  if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') return [nameOf(node)];
  return node.namedChildren.flatMap((child) => {
    if (node.type === 'pair_pattern' && child === node.childForFieldName('key')) return [];
    if (
      (node.type === 'assignment_pattern' || node.type === 'object_assignment_pattern') &&
      child !== node.childForFieldName('left')
    )
      return [];
    return patternIdentifierNames(child);
  });
}
