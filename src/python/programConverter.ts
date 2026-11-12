// code-gauge-allow-file fileNcss 645 -- The statement converter keeps one method per kind of statement node together.
import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import type {
  ClassDef,
  ExceptHandler,
  Expression,
  FunctionDef,
  ImportName,
  MatchCase,
  Module,
  NameRef,
  Pattern,
  Statement,
  Target,
  WithItem,
} from './ast';
import { children, field, fieldNodes, hasToken, namedChildren, rowOf, unsupported } from './convertNodes';
import { ExpressionConverter } from './expressionConverter';
import { isSupportedModule, unsupportedModuleFeature } from './moduleNames';
import { fail, resolveScopes, ScopeBuilder } from './scopes';

export const misplacedPythonAtomicMessage =
  '# atomic は、関数・メソッドを宣言する行（def から本体の前の : がある行まで）に付けてください。';

const MAX_STATIC_BLOCKS = 20;

interface ConvertedFunction {
  fn: FunctionDef;
  row: number;
  headerEndRow: number;
}

/** Converts a tree-sitter tree to the AST, settling scopes, steps, and the errors CPython reports before running. */
export class ProgramConverter extends ExpressionConverter {
  private readonly module: ScopeBuilder;
  private readonly functions: ConvertedFunction[] = [];
  private blockDepth = 0;

  constructor(
    source: string,
    private readonly trace: TraceOptions | undefined
  ) {
    const module = new ScopeBuilder('module', undefined);
    super(source, module);
    this.module = module;
  }

  convert(root: Node): Module {
    const body = this.block(namedChildren(root));
    resolveScopes(this.module);
    this.assignAtomicAnnotations();
    return { body, scope: this.module.info, doc: docOf(body) };
  }

  /** The row whose step a statement records when tracing; a class body declares members and records none. */
  private stepRowOf(node: Node): number | undefined {
    return this.trace && this.context.scope.info.kind !== 'class' ? rowOf(node) : undefined;
  }

  // Statements ------------------------------------------------------------------------------------------------------

  private block(nodes: Node[]): Statement[] {
    return nodes.flatMap((node) => this.statement(node));
  }

  private body(node: Node): Statement[] {
    return this.block(node.type === 'block' ? namedChildren(node) : [node]);
  }

  /** Converts a nested block that counts toward CPython's limit of statically nested blocks. */
  private nestedBlock<T>(node: Node, convert: () => T): T {
    this.blockDepth++;
    try {
      if (this.blockDepth > MAX_STATIC_BLOCKS) fail(rowOf(node), 'ループや try などの入れ子が深すぎます。');
      return convert();
    } finally {
      this.blockDepth--;
    }
  }

  // code-gauge-allow functionNcss 55 -- One case per kind of statement node, each delegating where it grows.
  private statement(node: Node): Statement[] {
    const row = rowOf(node);
    switch (node.type) {
      case 'expression_statement': {
        return [this.expressionStatement(node)];
      }
      case 'pass_statement': {
        return [{ kind: 'pass', row }];
      }
      case 'break_statement':
      case 'continue_statement': {
        return [this.jumpStatement(node)];
      }
      case 'return_statement': {
        return [this.returnStatement(node)];
      }
      case 'if_statement': {
        return [this.ifStatement(node)];
      }
      case 'while_statement': {
        return [this.whileStatement(node)];
      }
      case 'for_statement': {
        return [this.forStatement(node)];
      }
      case 'try_statement': {
        return [this.tryStatement(node)];
      }
      case 'with_statement': {
        return [this.withStatement(node)];
      }
      case 'match_statement': {
        return [this.matchStatement(node)];
      }
      case 'function_definition': {
        return [this.functionDefinition(node, [])];
      }
      case 'class_definition': {
        return [this.classDefinition(node, [])];
      }
      case 'decorated_definition': {
        return [this.decoratedDefinition(node)];
      }
      case 'global_statement':
      case 'nonlocal_statement': {
        return [this.declaration(node)];
      }
      case 'delete_statement': {
        return [this.deleteStatement(node)];
      }
      case 'raise_statement': {
        return [this.raiseStatement(node)];
      }
      case 'import_statement': {
        return [this.importStatement(node)];
      }
      case 'import_from_statement': {
        return [this.importFromStatement(node)];
      }
      case 'future_import_statement': {
        return unsupported(node, 'from __future__ import');
      }
      case 'lazy_import_statement': {
        return fail(row, 'lazy import は、この版の Python では使えません。');
      }
      case 'print_statement': {
        return fail(row, 'print は関数なので、print(...) のように ( ) を付けて呼び出してください。');
      }
      case 'exec_statement': {
        return fail(row, 'exec は関数なので、exec(...) のように ( ) を付けて呼び出してください。');
      }
      case 'assert_statement': {
        return unsupported(node, 'assert 文');
      }
      case 'type_alias_statement': {
        return unsupported(node, 'type 文（型の別名）');
      }
      default: {
        return unsupported(node, `構文「${node.type}」`);
      }
    }
  }

  private jumpStatement(node: Node): Statement {
    const row = rowOf(node);
    const word = node.type === 'break_statement' ? 'break' : 'continue';
    if (!this.context.inLoop) fail(row, `${word} 文はループの中にしか書けません。`);
    if (this.context.inExceptStar) fail(row, `except* の中には ${word} 文を書けません。`);
    return { kind: word, row };
  }

  private returnStatement(node: Node): Statement {
    const row = rowOf(node);
    if (this.context.scope.info.kind !== 'function') fail(row, 'return 文は関数の中にしか書けません。');
    if (this.context.inExceptStar) fail(row, 'except* の中には return 文を書けません。');
    const valueNode = namedChildren(node)[0];
    return { kind: 'return', value: valueNode ? this.valueExpression(valueNode) : undefined, row };
  }

  private declaration(node: Node): Statement {
    const declaration = node.type === 'global_statement' ? 'global' : 'nonlocal';
    for (const nameNode of namedChildren(node)) {
      this.context.scope.declare(this.mangle(nameNode.text), declaration, rowOf(nameNode));
    }
    return { kind: declaration, row: rowOf(node) };
  }

  private raiseStatement(node: Node): Statement {
    const causeNode = node.childForFieldName('cause');
    const exceptionNode = namedChildren(node).find((child) => child.id !== causeNode?.id);
    return {
      kind: 'raise',
      exception: exceptionNode ? this.valueExpression(exceptionNode) : undefined,
      cause: causeNode ? this.expression(causeNode) : undefined,
      row: rowOf(node),
    };
  }

  /** An expression that may be an unparenthesized tuple, as a `return` or an assignment's value may be. */
  private valueExpression(node: Node): Expression {
    if (node.type === 'yield') unsupported(node, '値を受け取る yield');
    return this.expression(node);
  }

  private expressionStatement(node: Node): Statement {
    const row = rowOf(node);
    const nodes = namedChildren(node);
    if (nodes.length > 1) {
      const elements = nodes.map((child) => this.expression(child));
      return { kind: 'expression', expression: { kind: 'tuple', elements, row }, stepRow: this.stepRowOf(node), row };
    }
    const inner = nodes[0];
    switch (inner.type) {
      case 'assignment': {
        return this.assignment(node, inner);
      }
      case 'augmented_assignment': {
        return this.augmentedAssignment(node, inner);
      }
      case 'yield': {
        return this.yieldStatement(inner);
      }
      case 'named_expression': {
        return fail(row, '代入式（:=）を文として書くときは、( ) で囲んでください。');
      }
      default: {
        const expression = this.expression(inner);
        // CPython drops a constant expression statement, such as a docstring, so it records no step.
        const stepRow = expression.kind === 'constant' ? undefined : this.stepRowOf(node);
        return { kind: 'expression', expression, stepRow, row };
      }
    }
  }

  private yieldStatement(node: Node): Statement {
    const row = rowOf(node);
    const { scope } = this.context;
    if (scope.info.kind !== 'function') fail(row, 'yield は関数の中にしか書けません。');
    if (hasToken(node, 'from')) unsupported(node, 'yield from');
    scope.info.isGenerator = true;
    const valueNode = namedChildren(node)[0];
    return { kind: 'yield', value: valueNode ? this.expression(valueNode) : undefined, row };
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Follows the rules CPython applies to each kind of assignment.
  private assignment(statementNode: Node, node: Node): Statement {
    const row = rowOf(node);
    const typeNode = node.childForFieldName('type');
    const rightNode = node.childForFieldName('right');
    if (typeNode) {
      const leftNode = field(node, 'left');
      if (!['identifier', 'attribute', 'subscript'].includes(leftNode.type)) {
        fail(row, '型ヒントを付けて代入できるのは、1つの変数・属性・要素だけです。');
      }
      if (rightNode?.type === 'assignment') fail(row, '型ヒントを付けた代入は、連続して書けません。');
      this.checkAnnotatedName(leftNode);
      const value = rightNode ? this.valueExpression(rightNode) : undefined;
      const annotation = this.annotation(typeNode);
      const target =
        leftNode.type === 'identifier' && !value && this.context.scope.info.kind === 'function'
          ? this.declareAnnotated(leftNode)
          : this.target(leftNode);
      return {
        kind: 'annotatedAssign',
        target,
        annotation,
        value,
        stepRow: value ? this.stepRowOf(statementNode) : undefined,
        row,
      };
    }
    const targetNodes: Node[] = [];
    let current: Node = node;
    while (current.type === 'assignment') {
      if (current.childForFieldName('type')) fail(row, '型ヒントを付けた代入は、連続して書けません。');
      targetNodes.push(field(current, 'left'));
      current = field(current, 'right');
    }
    if (current.type === 'augmented_assignment') fail(row, '書き方に誤りがあります。');
    if (current.type === 'named_expression') fail(row, '代入式（:=）を代入の右辺に書くときは、( ) で囲んでください。');
    // The value is evaluated before the targets, whose names it may read before they are bound.
    const value = this.valueExpression(current);
    const targets = targetNodes.map((targetNode) => this.target(targetNode));
    return { kind: 'assign', targets, value, stepRow: this.stepRowOf(statementNode), row };
  }

  /** `x: int` in a function declares x as a local variable without assigning it. */
  private checkAnnotatedName(node: Node): void {
    const { scope } = this.context;
    if (node.type !== 'identifier' || scope.info.kind === 'module') return;
    const declaration = scope.declarations.get(this.mangle(node.text));
    if (declaration) {
      fail(rowOf(node), `${node.text} は ${declaration} 宣言されているので、型ヒントを付けられません。`);
    }
  }

  private declareAnnotated(node: Node): Target {
    return this.bindName(node);
  }

  private augmentedAssignment(statementNode: Node, node: Node): Statement {
    const row = rowOf(node);
    const leftNode = field(node, 'left');
    if (!['identifier', 'attribute', 'subscript'].includes(leftNode.type)) {
      fail(row, `${this.textOf(leftNode)} には複合代入（+= など）を使えません。`);
    }
    const operator = field(node, 'operator').type.slice(0, -1);
    const value = this.valueExpression(field(node, 'right'));
    // The target reads its name before storing, so a name it binds is also used.
    if (leftNode.type === 'identifier') this.useName(leftNode);
    const target = this.target(leftNode);
    return {
      kind: 'augmentedAssign',
      target,
      operator: operator as Extract<Statement, { kind: 'augmentedAssign' }>['operator'],
      value,
      stepRow: this.stepRowOf(statementNode),
      row,
    };
  }

  private deleteStatement(node: Node): Statement {
    const inner = namedChildren(node)[0];
    const nodes = inner.type === 'expression_list' ? namedChildren(inner) : [inner];
    const targets = nodes.map((target) => this.deleteTarget(target));
    return { kind: 'delete', targets, stepRow: this.stepRowOf(node), row: rowOf(node) };
  }

  private deleteTarget(node: Node): Target {
    if (['identifier', 'attribute', 'subscript', 'parenthesized_expression', 'tuple', 'list'].includes(node.type)) {
      return this.target(node);
    }
    return fail(rowOf(node), `${this.textOf(node)} は del で削除できません。`);
  }

  private ifStatement(node: Node): Statement {
    const test = this.expression(field(node, 'condition'));
    const body = this.body(field(node, 'consequence'));
    return { kind: 'if', test, body, orelse: this.elifChain(fieldNodes(node, 'alternative')), row: rowOf(node) };
  }

  /** Converts elif and else clauses in source order, which the scope analysis depends on. */
  private elifChain(alternatives: Node[]): Statement[] {
    const converted: { test?: Expression; body: Statement[]; row: number }[] = [];
    for (const alternative of alternatives) {
      if (alternative.type === 'else_clause') {
        converted.push({ body: this.body(field(alternative, 'body')), row: rowOf(alternative) });
      } else {
        const test = this.expression(field(alternative, 'condition'));
        converted.push({ test, body: this.body(field(alternative, 'consequence')), row: rowOf(alternative) });
      }
    }
    let orelse: Statement[] = [];
    for (const clause of converted.toReversed()) {
      orelse = clause.test
        ? [{ kind: 'if', test: clause.test, body: clause.body, orelse, row: clause.row }]
        : clause.body;
    }
    return orelse;
  }

  private loopBody(node: Node): Statement[] {
    const outer = this.context;
    this.context = { ...outer, inLoop: true, inExceptStar: false };
    try {
      return this.nestedBlock(node, () => this.body(node));
    } finally {
      this.context = outer;
    }
  }

  private elseBody(node: Node): Statement[] {
    const alternative = node.childForFieldName('alternative');
    return alternative ? this.body(field(alternative, 'body')) : [];
  }

  private whileStatement(node: Node): Statement {
    const test = this.expression(field(node, 'condition'));
    const body = this.loopBody(field(node, 'body'));
    return { kind: 'while', test, body, orelse: this.elseBody(node), row: rowOf(node) };
  }

  private forStatement(node: Node): Statement {
    if (hasToken(node, 'async')) unsupported(node, 'async for');
    const iterable = this.expression(field(node, 'right'));
    const target = this.target(field(node, 'left'));
    const body = this.loopBody(field(node, 'body'));
    return {
      kind: 'for',
      target,
      iterable,
      body,
      orelse: this.elseBody(node),
      stepRow: this.stepRowOf(node),
      row: rowOf(node),
    };
  }

  private tryStatement(node: Node): Statement {
    return this.nestedBlock(node, () => {
      const body = this.body(field(node, 'body'));
      const clauses = namedChildren(node);
      const handlerNodes = clauses.filter((clause) => clause.type === 'except_clause');
      const isGroupFlags = handlerNodes.map((handler) =>
        children(handler).some((child) => child.type === '*' || child.text === 'except*')
      );
      const isGroup = isGroupFlags.some(Boolean);
      if (isGroup && isGroupFlags.some((flag) => !flag)) {
        fail(rowOf(node), '1つの try 文に except と except* を混ぜて書くことはできません。');
      }
      const handlers = handlerNodes.map((handler, index) =>
        this.exceptHandler(handler, index === handlerNodes.length - 1, isGroup)
      );
      const elseNode = clauses.find((clause) => clause.type === 'else_clause');
      const finallyNode = clauses.find((clause) => clause.type === 'finally_clause');
      if (handlers.length === 0 && !finallyNode) fail(rowOf(node), 'try には except か finally が必要です。');
      const orelse = elseNode ? this.body(field(elseNode, 'body')) : [];
      const finalbody = finallyNode
        ? this.body(namedChildren(finallyNode).find((child) => child.type === 'block') as Node)
        : [];
      const statement: Statement = { kind: 'try', body, handlers, isGroup, orelse, finalbody, row: rowOf(node) };
      return statement;
    });
  }

  /** Converts an except clause, checking the rules CPython applies to it. */
  private exceptHandler(handler: Node, isLast: boolean, isGroup: boolean): ExceptHandler {
    const typeNodes = fieldNodes(handler, 'value');
    const aliasNode = handler.childForFieldName('alias');
    const row = rowOf(handler);
    if (typeNodes.length === 0 && !isLast) fail(row, '型を書かない except: は、最後にしか書けません。');
    if (typeNodes.length === 0 && isGroup) fail(row, 'except* の後には例外の型を書いてください。');
    if (typeNodes.length > 1 && aliasNode) fail(row, 'as を付けるときは、複数の例外の型を ( ) で囲んでください。');
    const types =
      typeNodes.length === 0
        ? undefined
        : typeNodes.length === 1
          ? this.expression(typeNodes[0])
          : { kind: 'tuple' as const, elements: typeNodes.map((typeNode) => this.expression(typeNode)), row };
    const name = aliasNode ? this.bindName(aliasNode) : undefined;
    const blockNode = namedChildren(handler).find((child) => child.type === 'block') as Node;
    const outer = this.context;
    this.context = { ...outer, inExceptStar: isGroup || outer.inExceptStar };
    try {
      return { types, name, body: this.body(blockNode), row };
    } finally {
      this.context = outer;
    }
  }

  private withStatement(node: Node): Statement {
    if (hasToken(node, 'async')) unsupported(node, 'async with');
    return this.nestedBlock(node, () => {
      const items: WithItem[] = [];
      const clause = namedChildren(node).find((child) => child.type === 'with_clause') as Node;
      for (const item of namedChildren(clause)) {
        const valueNode = field(item, 'value');
        if (valueNode.type === 'as_pattern') {
          const [contextNode] = namedChildren(valueNode);
          const context = this.expression(contextNode);
          const targetNode = namedChildren(field(valueNode, 'alias'))[0];
          items.push({ context, target: this.target(targetNode) });
        } else {
          items.push({ context: this.expression(valueNode) });
        }
      }
      const body = this.body(field(node, 'body'));
      const statement: Statement = { kind: 'with', items, body, stepRow: this.stepRowOf(node), row: rowOf(node) };
      return statement;
    });
  }

  // Definitions -----------------------------------------------------------------------------------------------------

  private decoratedDefinition(node: Node): Statement {
    const decorators = namedChildren(node)
      .filter((child) => child.type === 'decorator')
      .map((decorator) => this.expression(namedChildren(decorator)[0]));
    const definition = field(node, 'definition');
    return definition.type === 'class_definition'
      ? this.classDefinition(definition, decorators)
      : this.functionDefinition(definition, decorators);
  }

  private functionDefinition(node: Node, decorators: Expression[]): Statement {
    if (hasToken(node, 'async')) unsupported(node, 'async def');
    if (node.childForFieldName('type_parameters')) unsupported(node, '型引数');
    const name = this.mangle(field(node, 'name').text);
    const isMethod = this.context.scope.info.kind === 'class';
    const fn = this.newFunction(node, name, `${this.context.qualifiedPrefix}${name}`);
    fn.decorators = decorators;
    fn.isMethod = isMethod;
    fn.params = this.parameters(field(node, 'parameters'));
    const returnsNode = node.childForFieldName('return_type');
    fn.returns = returnsNode ? this.annotation(returnsNode) : undefined;
    const bodyNode = field(node, 'body');
    this.functionBody(bodyNode, fn);
    this.functions.push({ fn, row: rowOf(node), headerEndRow: rowOf(bodyNode.previousSibling ?? bodyNode) });
    const binding = this.bindName(field(node, 'name'));
    return { kind: 'functionDef', fn, binding, row: rowOf(node) };
  }

  protected functionBody(bodyNode: Node, fn: FunctionDef): void {
    this.inFunction(fn, () => {
      for (const parameter of fn.params) this.bindParameter(parameter);
      const outerDepth = this.blockDepth;
      this.blockDepth = 0;
      try {
        const body = this.body(bodyNode);
        fn.body = body;
        fn.doc = docOf(body);
      } finally {
        this.blockDepth = outerDepth;
      }
    });
  }

  private classDefinition(node: Node, decorators: Expression[]): Statement {
    if (node.childForFieldName('type_parameters')) unsupported(node, '型引数');
    const nameNode = field(node, 'name');
    const name = this.mangle(nameNode.text);
    const superclasses = node.childForFieldName('superclasses');
    const bases = superclasses ? this.argumentList(superclasses) : [];
    const outer = this.context;
    const scope = new ScopeBuilder('class', outer.scope);
    const qualifiedName = `${outer.qualifiedPrefix}${name}`;
    this.context = {
      scope,
      className: nameNode.text,
      qualifiedPrefix: `${qualifiedName}.`,
      inLoop: false,
      inExceptStar: false,
    };
    let body: Statement[];
    try {
      body = this.body(field(node, 'body'));
    } finally {
      this.context = outer;
    }
    const cls: ClassDef = {
      name,
      staticAttributes: staticAttributesOf(body),
      qualifiedName,
      bases,
      body,
      scope: scope.info,
      decorators,
      doc: docOf(body),
      row: rowOf(node),
    };
    const binding = this.bindName(nameNode);
    return { kind: 'classDef', cls, binding, row: rowOf(node) };
  }

  // Imports ---------------------------------------------------------------------------------------------------------

  private importStatement(node: Node): Statement {
    const names: ImportName[] = fieldNodes(node, 'name').map((nameNode) => {
      const aliased = nameNode.type === 'aliased_import';
      const dotted = aliased ? field(nameNode, 'name') : nameNode;
      const module = dotted.text.replaceAll(/\s/g, '');
      this.checkModule(nameNode, module);
      const bindingNode = aliased ? field(nameNode, 'alias') : namedChildren(dotted)[0];
      return { module, binding: this.bindName(bindingNode), bindsModule: aliased || !module.includes('.') };
    });
    return { kind: 'import', names, row: rowOf(node) };
  }

  private importFromStatement(node: Node): Statement {
    const moduleNode = field(node, 'module_name');
    if (moduleNode.type === 'relative_import') unsupported(node, '相対 import（from . import）');
    const module = moduleNode.text.replaceAll(/\s/g, '');
    this.checkModule(node, module);
    const row = rowOf(node);
    if (namedChildren(node).some((child) => child.type === 'wildcard_import')) {
      if (this.context.scope.info.kind !== 'module') fail(row, 'import * はモジュールの最上位にしか書けません。');
      return { kind: 'importStar', module, row };
    }
    const names = fieldNodes(node, 'name').map((nameNode) => {
      const aliased = nameNode.type === 'aliased_import';
      const nameText = (aliased ? field(nameNode, 'name') : nameNode).text;
      if (nameText.includes('.')) fail(rowOf(nameNode), 'from ... import の後の名前には . を書けません。');
      const bindingNode = aliased ? field(nameNode, 'alias') : (namedChildren(nameNode)[0] ?? nameNode);
      return { name: nameText, binding: this.bindName(bindingNode) };
    });
    return { kind: 'importFrom', module, names, row };
  }

  private checkModule(node: Node, module: string): void {
    if (module === '__future__') unsupported(node, 'from __future__ import');
    if (!isSupportedModule(module)) unsupported(node, unsupportedModuleFeature(module));
  }

  // Match -----------------------------------------------------------------------------------------------------------

  private matchStatement(node: Node): Statement {
    const subjects = fieldNodes(node, 'subject');
    const row = rowOf(node);
    const subject: Expression =
      subjects.length === 1 && !children(node).some((child) => child.type === ',')
        ? this.expression(subjects[0])
        : { kind: 'tuple', elements: subjects.map((child) => this.expression(child)), row };
    const caseNodes = fieldNodes(field(node, 'body'), 'alternative');
    const cases: MatchCase[] = caseNodes.map((caseNode, index) => {
      const patternNodes = namedChildren(caseNode).filter((child) => child.type === 'case_pattern');
      const caseRow = rowOf(caseNode);
      const names = new Set<string>();
      const pattern: Pattern =
        patternNodes.length === 1 && !children(caseNode).some((child) => child.type === ',')
          ? this.pattern(patternNodes[0], names)
          : { kind: 'sequence', patterns: patternNodes.map((child) => this.pattern(child, names)), row: caseRow };
      if (pattern.kind === 'sequence') pattern.starIndex = starIndexOf(pattern.patterns, caseRow);
      const guardNode = caseNode.childForFieldName('guard');
      const guard = guardNode ? this.expression(namedChildren(guardNode)[0]) : undefined;
      if (!guard && index < caseNodes.length - 1 && isIrrefutable(pattern)) {
        fail(caseRow, 'この case はどんな値にも当てはまるので、後の case が実行されなくなります。');
      }
      const body = this.body(field(caseNode, 'consequence'));
      return { pattern, guard, body, row: caseRow };
    });
    return { kind: 'match', subject, cases, row };
  }

  // code-gauge-allow functionNcss 57 -- One case per kind of pattern node.
  // code-gauge-allow functionCognitiveComplexity 22 -- One case per kind of pattern node.
  private pattern(node: Node, names: Set<string>): Pattern {
    const row = rowOf(node);
    const named = namedChildren(node);
    switch (node.type) {
      case 'case_pattern': {
        if (named.length === 0) return { kind: 'capture', row };
        if (children(node).some((child) => child.type === '-')) return this.negativeLiteral(named[0], row);
        return this.pattern(named[0], names);
      }
      case 'integer':
      case 'float':
      case 'string':
      case 'concatenated_string': {
        const value = this.expression(node);
        if (value.kind === 'fstring') fail(row, 'パターンには f-string を書けません。');
        return { kind: 'value', value, row };
      }
      case 'true':
      case 'false':
      case 'none': {
        return { kind: 'singleton', value: node.type === 'none' ? undefined : node.type === 'true', row };
      }
      case 'dotted_name': {
        const parts = named.map((part) => part.text);
        if (parts.length === 1) {
          if (parts[0] === '_') return { kind: 'capture', row };
          return { kind: 'capture', name: this.patternName(named[0], names), row };
        }
        return { kind: 'value', value: this.dottedValue(named), row };
      }
      case 'list_pattern':
      case 'tuple_pattern': {
        const patterns = named.map((child) => this.pattern(child, names));
        const isGroup =
          node.type === 'tuple_pattern' && patterns.length === 1 && !children(node).some((child) => child.type === ',');
        if (isGroup) return patterns[0];
        return { kind: 'sequence', patterns, starIndex: starIndexOf(patterns, row), row };
      }
      case 'splat_pattern': {
        const nameNode = named[0];
        if (!nameNode || nameNode.text === '_') return { kind: 'star', row };
        return { kind: 'star', name: this.patternName(nameNode, names), row };
      }
      case 'dict_pattern': {
        return this.mappingPattern(node, names);
      }
      case 'class_pattern': {
        return this.classPattern(node, names);
      }
      case 'union_pattern': {
        return this.orPattern(node, names);
      }
      case 'as_pattern': {
        const aliasNode = field(node, 'alias');
        if (aliasNode.text === '_') fail(row, 'as の後に _ は書けません。');
        const pattern = this.pattern(named[0], names);
        return { kind: 'as', pattern, name: this.patternName(aliasNode, names), row };
      }
      case 'complex_pattern': {
        return unsupported(node, '複素数のパターン（case 1+2j:）');
      }
      default: {
        return unsupported(node, `パターン「${node.type}」`);
      }
    }
  }

  private negativeLiteral(node: Node, row: number): Pattern {
    if (node.type !== 'integer' && node.type !== 'float') fail(row, 'パターンの - の後には数を書いてください。');
    return { kind: 'value', value: { kind: 'unary', operator: '-', operand: this.expression(node), row }, row };
  }

  private dottedValue(parts: Node[]): Expression {
    let value: Expression = this.useName(parts[0]);
    for (const part of parts.slice(1)) value = { kind: 'attribute', object: value, name: part.text, row: rowOf(part) };
    return value;
  }

  private patternName(node: Node, names: Set<string>): NameRef {
    const name = this.mangle(node.text);
    if (names.has(name)) fail(rowOf(node), `パターンの中で、${name} に2回代入しています。`);
    names.add(name);
    return this.bindName(node);
  }

  private mappingPattern(node: Node, names: Set<string>): Pattern {
    const keys: Expression[] = [];
    const patterns: Pattern[] = [];
    let rest: NameRef | undefined;
    const keyTexts = new Set<string>();
    const keyNodes = fieldNodes(node, 'key');
    const valueNodes = fieldNodes(node, 'value');
    for (const [index, keyNode] of keyNodes.entries()) {
      const text = this.textOf(keyNode);
      if (keyNode.type !== 'dotted_name' && keyTexts.has(text))
        fail(rowOf(keyNode), `マッピングのパターンで、キー ${text} が重複しています。`);
      keyTexts.add(text);
      keys.push(this.mappingKey(keyNode, names));
      patterns.push(this.pattern(valueNodes[index], names));
    }
    const splat = namedChildren(node).find((child) => child.type === 'splat_pattern');
    if (splat) {
      const nameNode = namedChildren(splat)[0];
      if (!nameNode || nameNode.text === '_') fail(rowOf(splat), '** の後に _ は書けません。');
      rest = this.patternName(nameNode, names);
    }
    return { kind: 'mapping', keys, patterns, rest, row: rowOf(node) };
  }

  private mappingKey(node: Node, names: Set<string>): Expression {
    if (node.type === 'dotted_name') return this.dottedValue(namedChildren(node));
    const pattern = this.pattern(node, names);
    return pattern.kind === 'value' ? pattern.value : this.expression(node);
  }

  private classPattern(node: Node, names: Set<string>): Pattern {
    const [clsNode, ...argumentNodes] = namedChildren(node);
    const patterns: Pattern[] = [];
    const keywords: string[] = [];
    const keywordPatterns: Pattern[] = [];
    for (const argument of argumentNodes) {
      const inner = argument.type === 'case_pattern' ? namedChildren(argument)[0] : argument;
      if (inner?.type === 'keyword_pattern') {
        const [keywordNode, valueNode] = namedChildren(inner);
        if (keywords.includes(keywordNode.text))
          fail(rowOf(inner), `クラスのパターンで、${keywordNode.text} を2回書いています。`);
        keywords.push(keywordNode.text);
        keywordPatterns.push(this.patternOrLiteral(valueNode, names));
        continue;
      }
      if (keywords.length > 0)
        fail(rowOf(argument), 'クラスのパターンで、位置で書くパターンは名前で書くパターンより前に書いてください。');
      patterns.push(this.pattern(argument, names));
    }
    return {
      kind: 'class',
      cls: this.dottedValue(namedChildren(clsNode)),
      patterns,
      keywords,
      keywordPatterns,
      row: rowOf(node),
    };
  }

  private patternOrLiteral(node: Node, names: Set<string>): Pattern {
    return this.pattern(node, names);
  }

  private orPattern(node: Node, names: Set<string>): Pattern {
    const alternatives = namedChildren(node);
    const patterns: Pattern[] = [];
    let bound: Set<string> | undefined;
    for (const [index, alternative] of alternatives.entries()) {
      const own = new Set<string>();
      const pattern = this.pattern(alternative, own);
      if (index < alternatives.length - 1 && isIrrefutable(pattern)) {
        fail(rowOf(alternative), '| の前のパターンがどんな値にも当てはまるので、後のパターンが使われません。');
      }
      if (bound && (bound.size !== own.size || [...own].some((name) => !bound?.has(name)))) {
        fail(rowOf(node), '| でつないだパターンは、どれも同じ名前に代入してください。');
      }
      bound = own;
      patterns.push(pattern);
    }
    for (const name of bound ?? []) {
      if (names.has(name)) fail(rowOf(node), `パターンの中で、${name} に2回代入しています。`);
      names.add(name);
    }
    return { kind: 'or', patterns, row: rowOf(node) };
  }

  // Atomic annotations ----------------------------------------------------------------------------------------------

  /** Marks the function whose header (from `def` to the colon before its body) holds each `# atomic`. */
  private assignAtomicAnnotations(): void {
    const misplaced: number[] = [];
    for (const [row] of this.trace?.atomicAnnotations ?? []) {
      const owners = this.functions.filter((fn) => fn.row <= row && row <= fn.headerEndRow);
      const owner = owners.toSorted((a, b) => b.row - a.row)[0];
      if (owner) owner.fn.isAtomic = true;
      else misplaced.push(row);
    }
    if (misplaced.length > 0) {
      throw new CompileError(misplaced.map((row) => ({ row, message: misplacedPythonAtomicMessage })));
    }
  }
}

/** The attributes the methods of a class body assign through their first parameter, such as `self.x = 1`. */
function staticAttributesOf(body: Statement[]): string[] {
  const names = new Set<string>();
  for (const statement of body) {
    if (statement.kind !== 'functionDef' || !Array.isArray(statement.fn.body)) continue;
    const self = statement.fn.params[0]?.name;
    if (self !== undefined) collectAttributeStores(statement.fn.body, self, names);
  }
  return [...names].toSorted();
}

// code-gauge-allow functionCognitiveComplexity 23 -- Walks each kind of statement for self attribute stores, as __static_attributes__ does.
function collectAttributeStores(statements: Statement[], self: string, names: Set<string>): void {
  const visitTarget = (target: Target): void => {
    if (target.kind === 'attribute' && target.object.kind === 'name' && target.object.name === self)
      names.add(target.name);
    if (target.kind === 'unpack') for (const element of target.elements) visitTarget(element);
  };
  for (const statement of statements) {
    switch (statement.kind) {
      case 'assign':
      case 'delete': {
        for (const target of statement.targets) visitTarget(target);
        break;
      }
      case 'augmentedAssign':
      case 'annotatedAssign':
      case 'for': {
        visitTarget(statement.target);
        break;
      }
      case 'with': {
        for (const item of statement.items) if (item.target) visitTarget(item.target);
        break;
      }
      default: {
        break;
      }
    }
    for (const nested of nestedBlocks(statement)) collectAttributeStores(nested, self, names);
  }
}

/** The statement lists a compound statement runs, without those of nested definitions. */
function nestedBlocks(statement: Statement): Statement[][] {
  switch (statement.kind) {
    case 'if':
    case 'while':
    case 'for': {
      return [statement.body, statement.orelse];
    }
    case 'try': {
      return [
        statement.body,
        ...statement.handlers.map((handler) => handler.body),
        statement.orelse,
        statement.finalbody,
      ];
    }
    case 'with': {
      return [statement.body];
    }
    case 'match': {
      return statement.cases.map((matchCase) => matchCase.body);
    }
    default: {
      return [];
    }
  }
}

function docOf(body: Statement[]): string | undefined {
  const first = body[0];
  if (first?.kind === 'expression' && first.expression.kind === 'constant' && first.expression.value.kind === 'str') {
    return cleanDoc(first.expression.value.value);
  }
  return undefined;
}

/** Removes a docstring's common indentation, as the compiler of CPython 3.13 and later does. */
function cleanDoc(doc: string): string {
  const lines = expandTabs(doc).split('\n');
  let margin = Number.POSITIVE_INFINITY;
  for (const line of lines.slice(1)) {
    const indent = line.length - line.replace(/^ +/, '').length;
    if (indent < line.length) margin = Math.min(margin, indent);
  }
  if (margin === Number.POSITIVE_INFINITY) margin = 0;
  return [
    lines[0].replace(/^ +/, ''),
    ...lines.slice(1).map((line) => line.slice(Math.min(margin, line.length - line.replace(/^ +/, '').length))),
  ].join('\n');
}

function expandTabs(text: string): string {
  let result = '';
  let column = 0;
  for (const char of text) {
    if (char === '\t') {
      const spaces = 8 - (column % 8);
      result += ' '.repeat(spaces);
      column += spaces;
    } else {
      result += char;
      column = char === '\n' ? 0 : column + 1;
    }
  }
  return result;
}

function starIndexOf(patterns: Pattern[], row: number): number | undefined {
  const indexes = patterns.flatMap((pattern, index) => (pattern.kind === 'star' ? [index] : []));
  if (indexes.length > 1) fail(row, 'シーケンスのパターンには、* を1つしか書けません。');
  return indexes[0];
}

function isIrrefutable(pattern: Pattern): boolean {
  if (pattern.kind === 'capture') return true;
  if (pattern.kind === 'as') return isIrrefutable(pattern.pattern);
  if (pattern.kind === 'or') return pattern.patterns.some(isIrrefutable);
  return false;
}

export type { Target };
