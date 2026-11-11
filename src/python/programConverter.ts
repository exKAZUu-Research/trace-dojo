// code-gauge-allow-file fileNcss 802 -- The statement converter keeps one method per kind of statement node together.
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
  TypeParam,
  TypeParams,
  WithItem,
} from './ast';
import { children, field, fieldNodes, hasToken, namedChildren, rowOf, unsupported } from './convertNodes';
import { type Context, ExpressionConverter } from './expressionConverter';
import { isSupportedModule, unsupportedModuleFeature } from './moduleNames';
import { fail, resolveScopes, ScopeBuilder } from './scopes';
import { blocksOf, markAllSuspending, markSuspendingStatements } from './suspension';

export const misplacedPythonAtomicMessage =
  '# atomic は、関数・メソッドを宣言する行（def から本体の前の : がある行まで）に付けてください。';

const MAX_STATIC_BLOCKS = 20;

/**
 * The packages whose import makes every call of the module able to suspend, since the program may then run threads,
 * whose blocking operations suspend the thread running them wherever the program calls them.
 */
const THREAD_PACKAGES: ReadonlySet<string> = new Set(['_thread', 'asyncio', 'concurrent', 'queue', 'threading']);

interface ConvertedFunction {
  fn: FunctionDef;
  row: number;
  headerEndRow: number;
}

/** Converts a tree-sitter tree to the AST, settling scopes, steps, and the errors CPython reports before running. */
export class ProgramConverter extends ExpressionConverter {
  private readonly module: ScopeBuilder;
  private readonly functions: ConvertedFunction[] = [];
  /** The `from __future__ import` statements at the start of the module, the only place they may be. */
  private readonly futureStatements = new Set<number>();
  /** The top-level packages the module imports, which tell whether it may run threads. */
  private readonly importedPackages = new Set<string>();
  private blockDepth = 0;

  constructor(
    source: string,
    private readonly trace: TraceOptions | undefined,
    namesInLocals = false,
    /** Whether the source is a standard library module, whose imports of unsupported modules fail only when run. */
    private readonly library = false,
    inheritedFutureFeatures: readonly string[] = []
  ) {
    const module = new ScopeBuilder('module', undefined, namesInLocals);
    super(source, module);
    this.module = module;
    for (const feature of inheritedFutureFeatures) this.futureFeatures.add(feature);
  }

  convert(root: Node): Module {
    const nodes = namedChildren(root);
    const start = isDocstring(nodes[0]) ? 1 : 0;
    const end = nodes.findIndex((node, index) => index >= start && node.type !== 'future_import_statement');
    for (const node of nodes.slice(start, end === -1 ? undefined : end)) this.futureStatements.add(node.id);
    const body = this.block(nodes);
    if ([...this.importedPackages].some((name) => THREAD_PACKAGES.has(name))) markAllSuspending(body);
    resolveScopes(this.module);
    this.assignAtomicAnnotations();
    return {
      body: this.withAnnotationSetup(body, true),
      scope: this.module.info,
      doc: docOf(body),
      futureFeatures: [...this.futureFeatures],
    };
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
        return [this.futureImport(node)];
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
        return [this.assertStatement(node)];
      }
      case 'type_alias_statement': {
        return [this.typeAlias(node)];
      }
      default: {
        return unsupported(node, `構文「${node.type}」`);
      }
    }
  }

  private assertStatement(node: Node): Statement {
    const nodes = namedChildren(node);
    if (nodes.length > 2 || nodes.some((child) => child.type === 'named_expression')) {
      fail(rowOf(node), '書き方に誤りがあります。');
    }
    const [test, message] = nodes.map((child) => this.expression(child));
    return { kind: 'assert', test, message, row: rowOf(node) };
  }

  /**
   * Starts a module or class body with creating `__annotations__` when it stores annotations into it, or a module with
   * binding its `__annotate__`, numbering its annotations.
   */
  private withAnnotationSetup(body: Statement[], isModule = false): Statement[] {
    const annotated: Extract<Statement, { kind: 'annotatedAssign' }>[] = [];
    const collect = (statements: Statement[]): void => {
      for (const statement of statements) {
        if (statement.kind === 'annotatedAssign') annotated.push(statement);
        for (const block of blocksOf(statement)) collect(block);
      }
    };
    collect(body);
    if (annotated.length === 0) return body;
    if (this.futureFeatures.has('annotations')) return [{ kind: 'setupAnnotations', row: body[0].row }, ...body];
    if (!isModule) return body;
    for (const [index, statement] of annotated.filter((each) => each.target.kind === 'name').entries()) {
      statement.annotationIndex = index;
    }
    return [{ kind: 'setupAnnotate', row: body[0].row }, ...body];
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
    return { kind: 'return', value: valueNode ? this.expression(valueNode) : undefined, row };
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
      exception: exceptionNode ? this.expression(exceptionNode) : undefined,
      cause: causeNode ? this.expression(causeNode) : undefined,
      row: rowOf(node),
    };
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
        // A `yield` statement records no step: the step of the code that resumes the generator shows its effect.
        return { kind: 'expression', expression: this.yieldExpression(inner), row };
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

  // code-gauge-allow functionCognitiveComplexity 18 -- Follows the rules CPython applies to each kind of assignment.
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
      const value = rightNode ? this.expression(rightNode) : undefined;
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
        storesAnnotation:
          this.futureFeatures.has('annotations') &&
          this.context.scope.info.kind !== 'function' &&
          target.kind === 'name',
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
    const value = this.expression(current);
    const targets = targetNodes.map((targetNode) => this.target(targetNode));
    return { kind: 'assign', targets, value, stepRow: this.stepRowOf(statementNode), row };
  }

  /** `x: int` in a function declares x as a local variable without assigning it. */
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
    const value = this.expression(field(node, 'right'));
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
      const target = this.target(node);
      if (hasStarredTarget(target)) fail(rowOf(node), '* を付けた代入先は、del で削除できません。');
      return target;
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
    const isAsync = hasToken(node, 'async');
    if (isAsync) this.enterAsync(rowOf(node), 'async for は async def の関数の中にしか書けません。');
    const iterable = this.expression(field(node, 'right'));
    const target = this.target(field(node, 'left'));
    const body = this.loopBody(field(node, 'body'));
    const statement: Statement = {
      kind: 'for',
      target,
      iterable,
      body,
      orelse: this.elseBody(node),
      stepRow: this.stepRowOf(node),
      row: rowOf(node),
    };
    if (isAsync) statement.isAsync = true;
    return statement;
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
    const isAsync = hasToken(node, 'async');
    if (isAsync) this.enterAsync(rowOf(node), 'async with は async def の関数の中にしか書けません。');
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
      if (isAsync) statement.isAsync = true;
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
    const name = this.mangle(field(node, 'name').text);
    const isMethod = this.context.scope.info.kind === 'class';
    const typeParamsNode = node.childForFieldName('type_parameters');
    const typeContext = typeParamsNode ? this.typeParamContext() : undefined;
    const fn = this.inContext(typeContext, () =>
      this.newFunction(node, name, `${this.context.qualifiedPrefix}${name}`)
    );
    if (hasToken(node, 'async')) fn.scope.isAsync = true;
    if (typeParamsNode && typeContext) fn.typeParams = this.typeParameters(typeParamsNode, typeContext);
    fn.decorators = decorators;
    fn.isMethod = isMethod;
    this.annotationContext = typeContext;
    try {
      fn.params = this.parameters(field(node, 'parameters'));
    } finally {
      this.annotationContext = undefined;
    }
    const returnsNode = node.childForFieldName('return_type');
    fn.returns = returnsNode ? this.inContext(typeContext, () => this.annotation(returnsNode)) : undefined;
    const bodyNode = field(node, 'body');
    this.inContext(typeContext, () => this.functionBody(bodyNode, fn));
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
        if (fn.scope.isGenerator && fn.scope.isAsync) rejectReturnValues(body);
        if (fn.scope.isGenerator || fn.scope.isAsync) markSuspendingStatements(body);
        fn.body = body;
        fn.doc = docOf(body);
      } finally {
        this.blockDepth = outerDepth;
      }
    });
  }

  private classDefinition(node: Node, decorators: Expression[]): Statement {
    const nameNode = field(node, 'name');
    const name = this.mangle(nameNode.text);
    const typeParamsNode = node.childForFieldName('type_parameters');
    const typeContext = typeParamsNode ? this.typeParamContext() : undefined;
    const typeParams =
      typeParamsNode && typeContext ? this.classTypeParameters(typeParamsNode, typeContext) : undefined;
    const superclasses = node.childForFieldName('superclasses');
    const bases = this.inContext(typeContext, () => (superclasses ? this.argumentList(superclasses) : []));
    if (typeParams) bases.push({ kind: 'positional', value: typeParams.genericBase });
    const outer = this.context;
    const scope = new ScopeBuilder('class', (typeContext ?? outer).scope);
    const qualifiedName = `${outer.qualifiedPrefix}${name}`;
    this.context = {
      scope,
      className: nameNode.text,
      qualifiedPrefix: `${qualifiedName}.`,
      inLoop: false,
      inExceptStar: false,
    };
    let body: Statement[];
    let setup: Statement[] = [];
    try {
      if (typeParams) setup = [this.typeParamsAssignment(scope, rowOf(node))];
      body = this.body(field(node, 'body'));
    } finally {
      this.context = outer;
    }
    const cls: ClassDef = {
      name,
      staticAttributes: staticAttributesOf(body),
      qualifiedName,
      bases,
      body: this.withAnnotationSetup([...setup, ...body]),
      scope: scope.info,
      decorators,
      doc: docOf(body),
      typeParams,
      row: rowOf(node),
    };
    const binding = this.bindName(nameNode);
    return { kind: 'classDef', cls, binding, row: rowOf(node) };
  }

  // Type parameters -------------------------------------------------------------------------------------------------

  /** The context of a scope of type parameters, nested in the current scope, which keeps the names of definitions. */
  private typeParamContext(): Context {
    return {
      ...this.context,
      scope: new ScopeBuilder('function', this.context.scope),
      inLoop: false,
      inExceptStar: false,
    };
  }

  private classTypeParameters(node: Node, context: Context): ClassDef['typeParams'] {
    const typeParams = this.typeParameters(node, context);
    const row = rowOf(node);
    const hidden = (name: string): NameRef => {
      const ref: NameRef = { kind: 'name', name, access: 'global', row };
      context.scope.bind(ref);
      return ref;
    };
    return { ...typeParams, tuple: hidden('.type_params'), genericBase: hidden('.generic_base') };
  }

  /** `__type_params__ = .type_params`, with which a class body with type parameters starts. */
  private typeParamsAssignment(scope: ScopeBuilder, row: number): Statement {
    const value: NameRef = { kind: 'name', name: '.type_params', access: 'global', row };
    const target: NameRef = { kind: 'name', name: '__type_params__', access: 'global', row };
    scope.use(value);
    scope.bind(target);
    return { kind: 'assign', targets: [target], value, row };
  }

  /** Converts a type parameter's bound or constraints and its default, which its scope evaluates when first read. */
  private typeParamValues(param: TypeParam, { boundNode, defaultNode }: TypeParamNodes): void {
    const boundInner = boundNode && namedChildren(boundNode)[0];
    if (boundInner?.type === 'tuple')
      param.constraints = namedChildren(boundInner).map((each) => this.expression(each));
    else if (boundNode) param.bound = this.expression(boundNode);
    if (defaultNode?.type === 'list_splat') {
      // A TypeVarTuple's `= *X` defaults to the one item that unpacking X gives, as `[*X][0]`.
      const row = rowOf(defaultNode);
      const value = this.expression(namedChildren(defaultNode)[0]);
      param.default = {
        kind: 'subscript',
        object: { kind: 'list', elements: [{ kind: 'starred', value, row }], row },
        index: { kind: 'constant', value: { kind: 'int', value: 0n }, row },
        row,
      };
    } else if (defaultNode) param.default = this.expression(defaultNode);
  }

  /** `type Name[T] = value`. */
  private typeAlias(node: Node): Statement {
    const row = rowOf(node);
    const left = namedChildren(field(node, 'left'))[0];
    const [nameNode, typeParamsNode] = left.type === 'generic_type' ? namedChildren(left) : [left];
    if (nameNode.type !== 'identifier') fail(row, 'type 文の = の左には、名前を書いてください。');
    const valueNode = field(node, 'right');
    rejectInTypeParts(valueNode);
    const context = this.typeParamContext();
    const typeParams: TypeParams = typeParamsNode
      ? this.typeParameters(typeParamsNode, context)
      : { scope: context.scope.info, params: [] };
    const value = this.inContext(context, () => this.expression(valueNode));
    return { kind: 'typeAlias', name: nameNode.text, binding: this.bindName(nameNode), typeParams, value, row };
  }

  /** Converts type parameters into their scope, checking the rules CPython applies to them. */
  private typeParameters(node: Node, context: Context): TypeParams {
    const nodes = namedChildren(node);
    if (nodes.length === 0) fail(rowOf(node), '型引数の [ ] の中には、型引数を1つ以上書いてください。');
    const written = nodes.map((child) => typeParamParts(child));
    checkTypeParams(written);
    return this.inContext(context, () => {
      const params = written.map(({ kind, nameNode }) => {
        const binding = this.bindName(nameNode);
        context.scope.typeParameters.add(binding.name);
        return { kind, name: nameNode.text, binding, row: rowOf(nameNode) };
      });
      for (const [index, parts] of written.entries()) this.typeParamValues(params[index], parts);
      return { scope: context.scope.info, params };
    });
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

  /** `from __future__ import annotations`, which enables the feature while converting and binds its `_Feature`. */
  private futureImport(node: Node): Statement {
    const row = rowOf(node);
    if (!this.futureStatements.has(node.id)) fail(row, 'from __future__ import は、ファイルの先頭に書いてください。');
    const names = fieldNodes(node, 'name').map((nameNode) => {
      const aliased = nameNode.type === 'aliased_import';
      const name = (aliased ? field(nameNode, 'name') : nameNode).text;
      if (name === 'braces') fail(row, 'Python では、ブロックを { } で囲むことはありません（not a chance）。');
      if (!FUTURE_FEATURES.has(name)) fail(row, `from __future__ import で、${name} という機能はありません。`);
      this.futureFeatures.add(name);
      return { name, binding: this.bindName(aliased ? field(nameNode, 'alias') : nameNode) };
    });
    if (names.length === 0) fail(row, 'from __future__ import * は書けません。');
    return { kind: 'importFrom', module: '__future__', names, row };
  }

  private checkModule(node: Node, module: string): void {
    if (!this.library && !isSupportedModule(module)) unsupported(node, unsupportedModuleFeature(module));
    this.importedPackages.add(module.split('.')[0]);
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
        return this.complexLiteral(node);
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

  /** `1+2j` or `-1-2j`, whose real part must be a real number and whose imaginary part an imaginary one. */
  private complexLiteral(node: Node): Pattern {
    const row = rowOf(node);
    const tokens = children(node);
    const [realNode, operatorNode, imaginaryNode] = tokens[0].type === '-' ? tokens.slice(1) : tokens;
    const real = this.expression(realNode);
    const imaginary = this.expression(imaginaryNode);
    if (real.kind !== 'constant' || real.value.kind === 'imaginary') {
      fail(row, '複素数のパターンの + や - の前には、実数を書いてください。');
    }
    if (imaginary.kind !== 'constant' || imaginary.value.kind !== 'imaginary') {
      fail(row, '複素数のパターンの + や - の後には、虚数（2j など）を書いてください。');
    }
    const left: Expression = tokens[0].type === '-' ? { kind: 'unary', operator: '-', operand: real, row } : real;
    const operator = operatorNode.type as '+' | '-';
    return { kind: 'value', value: { kind: 'binary', operator, left, right: imaginary, row }, row };
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
      const key =
        keyNode.type === 'dotted_name' ? this.dottedValue(namedChildren(keyNode)) : this.pattern(keyNode, names);
      const keyExpression = 'kind' in key && key.kind === 'value' ? key.value : (key as Expression);
      const text = this.textOf(keyNode);
      if (keyNode.type !== 'dotted_name' && keyTexts.has(text))
        fail(rowOf(keyNode), `マッピングのパターンで、キー ${text} が重複しています。`);
      keyTexts.add(text);
      keys.push(keyExpression);
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
    for (const nested of blocksOf(statement)) collectAttributeStores(nested, self, names);
  }
}

interface TypeParamNodes {
  kind: TypeParam['kind'];
  nameNode: Node;
  boundNode?: Node;
  defaultNode?: Node;
}

/** The parts of a type parameter as the grammar writes it: `T`, `T: bound`, `*Ts`, `**P`, or any of them with `= default`. */
function typeParamParts(node: Node): TypeParamNodes {
  const kind = hasToken(node, '**') ? 'ParamSpec' : hasToken(node, '*') ? 'TypeVarTuple' : 'TypeVar';
  if (node.type === 'default_type_parameter') {
    const boundNode = node.childForFieldName('bound') ?? undefined;
    return { kind, nameNode: field(node, 'name'), boundNode, defaultNode: field(node, 'value') };
  }
  if (node.type === 'splat_type') return { kind, nameNode: namedChildren(node)[0] };
  const inner = node.type === 'type' ? namedChildren(node)[0] : node;
  if (inner.type === 'constrained_type') {
    const [nameType, boundNode] = namedChildren(inner);
    return { kind, nameNode: namedChildren(nameType)[0] ?? nameType, boundNode };
  }
  if (inner.type !== 'identifier') fail(rowOf(node), '型引数には、名前を書いてください。');
  return { kind, nameNode: inner };
}

/** Checks the rules CPython applies to a list of type parameters. */
function checkTypeParams(written: TypeParamNodes[]): void {
  const names = new Set<string>();
  let sawDefault = false;
  for (const { kind, nameNode, boundNode, defaultNode } of written) {
    const row = rowOf(nameNode);
    if (names.has(nameNode.text)) fail(row, `型引数 ${nameNode.text} が重複しています。`);
    names.add(nameNode.text);
    if (defaultNode) sawDefault = true;
    else if (sawDefault)
      fail(row, `デフォルトのない型引数 ${nameNode.text} は、デフォルトのある型引数より前に書いてください。`);
    if (boundNode && kind !== 'TypeVar') fail(row, `${kind} には、: の後に型を書けません。`);
    for (const part of [boundNode, defaultNode]) if (part) rejectInTypeParts(part);
  }
}

/** Rejects what CPython forbids in a type parameter's bound or default and in a type alias's value. */
function rejectInTypeParts(node: Node): void {
  const forbidden = node.type === 'yield' || node.type === 'named_expression' || node.type === 'await';
  if (forbidden || node.descendantsOfType(['yield', 'named_expression', 'await']).length > 0) {
    fail(rowOf(node), '型引数の境界やデフォルト、type 文の値には、yield・代入式（:=）・await を書けません。');
  }
}

function hasStarredTarget(target: Target): boolean {
  return target.kind === 'unpack' && (target.starIndex !== undefined || target.elements.some(hasStarredTarget));
}

const FUTURE_FEATURES = new Set([
  'nested_scopes',
  'generators',
  'division',
  'absolute_import',
  'with_statement',
  'print_function',
  'unicode_literals',
  'barry_as_FLUFL',
  'generator_stop',
  'annotations',
]);

function isDocstring(node: Node | undefined): boolean {
  const inner = node?.type === 'expression_statement' ? namedChildren(node) : [];
  return inner.length === 1 && (inner[0].type === 'string' || inner[0].type === 'concatenated_string');
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

/** Rejects a `return` with a value in an async generator, which CPython reports at the first such statement. */
function rejectReturnValues(statements: Statement[]): void {
  for (const statement of statements) {
    if (statement.kind === 'return' && statement.value)
      fail(statement.row, 'async def の中で yield を使う関数では、return に値を書けません。');
    for (const block of blocksOf(statement)) rejectReturnValues(block);
  }
}
