import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type {
  Argument,
  Block,
  CatchClause,
  ClassMember,
  ClassNode,
  DeclarationKind,
  Expression,
  FunctionKind,
  FunctionNode,
  ObjectMember,
  Pattern,
  Program,
  PropertyName,
  ScopeDeclarations,
  Statement,
  SwitchCase,
  VariableDeclaration,
} from './ast';
import { decodeStringLiteral, decodeTemplateFragment, parseNumberLiteral } from './literals';

interface ScopeBuilder {
  declarations: ScopeDeclarations;
  /** Each declared name with whether it may be declared again by `var` or a function at the top of a function. */
  names: Map<string, 'lexical' | 'var' | 'parameter'>;
  isFunction: boolean;
}

interface FunctionContext {
  canReturn: boolean;
  canCallSuper: boolean;
  canReferenceSuper: boolean;
  /** Labels in scope, each with whether it labels a loop. */
  labels: Map<string, boolean>;
  breakableDepth: number;
  loopDepth: number;
}

interface Steppable {
  row: number;
  endRow: number;
  depth: number;
  assign: (stepId: number) => void;
}

/** Converts a tree-sitter tree to the AST, settling scopes, steps, and early errors. */
export class ProgramConverter {
  private readonly scopes: ScopeBuilder[] = [];
  private context: FunctionContext = newContext(false, false, false);
  private readonly steppables: Steppable[] = [];
  /** Rows strictly inside function bodies, which belong to the statements of that body. */
  private readonly bodyRanges: { row: number; endRow: number }[] = [];
  /** Whether the class being converted extends another, which lets its constructor call `super()`. */
  private derivedConstructor = false;

  constructor(
    private readonly source: string,
    private readonly stepIdByRow: ReadonlyMap<number, number>
  ) {}

  convert(root: Node): Program {
    const scope = this.pushScope(true);
    const body = this.statementList(namedChildren(root).filter((child) => child.type !== 'hash_bang_line'));
    this.scopes.pop();
    this.assignSteps();
    return { body, scope: scope.declarations };
  }

  // Steps ---------------------------------------------------------------------------------------------------------

  private addSteppable(node: Node, assign: (stepId: number) => void, depthOffset = 0): void {
    this.steppables.push({ row: node.startPosition.row, endRow: node.endPosition.row, depth: depthOf(node) + depthOffset, assign });
  }

  /** Gives each `// step` row to the innermost statements on it, outside the bodies of functions they contain. */
  private assignSteps(): void {
    for (const [row, stepId] of this.stepIdByRow) {
      const candidates = this.steppables.filter(
        (steppable) =>
          steppable.row <= row &&
          row <= steppable.endRow &&
          !this.bodyRanges.some(
            (body) => steppable.row <= body.row && body.endRow <= steppable.endRow && body.row < row && row < body.endRow
          )
      );
      if (candidates.length === 0) {
        throw new CompileError([
          {
            row,
            message: '// step は、式文、初期値のある変数宣言やフィールド、return 文、for 文の行に付けてください。',
          },
        ]);
      }
      const depth = Math.max(...candidates.map((candidate) => candidate.depth));
      for (const candidate of candidates) if (candidate.depth === depth) candidate.assign(stepId);
    }
  }

  // Scopes --------------------------------------------------------------------------------------------------------

  private pushScope(isFunction: boolean): ScopeBuilder {
    const scope: ScopeBuilder = {
      declarations: { lexical: [], functions: [], vars: [] },
      names: new Map(),
      isFunction,
    };
    this.scopes.push(scope);
    return scope;
  }

  private withScope<T>(convert: (scope: ScopeDeclarations) => T): T {
    const scope = this.pushScope(false);
    try {
      return convert(scope.declarations);
    } finally {
      this.scopes.pop();
    }
  }

  private get currentScope(): ScopeBuilder {
    return this.scopes.at(-1) as ScopeBuilder;
  }

  private declareLexical(node: Node, name: string, isConst: boolean): void {
    const scope = this.currentScope;
    if (scope.names.has(name)) this.duplicate(node, name);
    scope.names.set(name, 'lexical');
    scope.declarations.lexical.push({ name, isConst });
  }

  private declareVar(node: Node, name: string): void {
    for (let index = this.scopes.length - 1; index >= 0; index--) {
      const scope = this.scopes[index];
      if (scope.names.get(name) === 'lexical') this.duplicate(node, name);
      if (!scope.isFunction) continue;
      if (!scope.names.has(name)) {
        scope.names.set(name, 'var');
        scope.declarations.vars.push(name);
      }
      return;
    }
  }

  private declareFunction(node: Node, fn: FunctionNode): void {
    const scope = this.currentScope;
    const previous = scope.names.get(fn.name);
    // At the top of a function, a function declaration may repeat a `var` or another function as in sloppy code.
    if (previous && (previous === 'lexical' || !scope.isFunction)) this.duplicate(node, fn.name);
    scope.names.set(fn.name, scope.isFunction ? 'var' : 'lexical');
    scope.declarations.functions.push(fn);
  }

  private declareParameter(node: Node, name: string): void {
    const scope = this.currentScope;
    if (scope.names.has(name)) this.duplicate(node, name);
    scope.names.set(name, 'parameter');
  }

  private duplicate(node: Node, name: string): never {
    return fail(node, `${name} はすでに宣言されています。`);
  }

  // Statements ----------------------------------------------------------------------------------------------------

  private statementList(nodes: Node[]): Statement[] {
    return nodes.map((node) => this.statement(node));
  }

  private statement(node: Node): Statement {
    const row = node.startPosition.row;
    switch (node.type) {
      case 'expression_statement': {
        const expression = this.expressionOrSequence(namedChildren(node)[0]);
        const statement: Statement = { kind: 'expression', expression, row };
        this.addSteppable(node, (stepId) => (statement.stepId = stepId));
        return statement;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        return this.declaration(node, true);
      }
      case 'function_declaration': {
        const fn = this.functionNode(node, 'normal');
        this.declareFunction(node, fn);
        return { kind: 'function', row };
      }
      case 'class_declaration': {
        const name = field(node, 'name').text;
        this.declareLexical(node, name, false);
        return { kind: 'class', cls: this.classNode(node, name), row };
      }
      case 'return_statement': {
        if (!this.context.canReturn) fail(node, 'return 文は関数の中にしか書けません。');
        const valueNode = namedChildren(node)[0] as Node | undefined;
        const statement: Statement = {
          kind: 'return',
          value: valueNode ? this.expressionOrSequence(valueNode) : undefined,
          row,
        };
        this.addSteppable(node, (stepId) => (statement.stepId = stepId));
        return statement;
      }
      case 'if_statement': {
        const alternative = node.childForFieldName('alternative');
        return {
          kind: 'if',
          test: this.parenthesized(field(node, 'condition')),
          consequent: this.substatement(field(node, 'consequence')),
          alternate: alternative ? this.substatement(namedChildren(alternative)[0]) : undefined,
          row,
        };
      }
      case 'statement_block': {
        return this.block(node);
      }
      case 'for_statement': {
        return this.forStatement(node);
      }
      case 'for_in_statement': {
        return this.forInStatement(node);
      }
      case 'while_statement': {
        return this.loop(node, [], () => ({
          kind: 'while',
          test: this.parenthesized(field(node, 'condition')),
          body: this.substatement(field(node, 'body')),
          row,
        }));
      }
      case 'do_statement': {
        return this.loop(node, [], () => ({
          kind: 'doWhile',
          body: this.substatement(field(node, 'body')),
          test: this.parenthesized(field(node, 'condition')),
          row,
        }));
      }
      case 'break_statement':
      case 'continue_statement': {
        return this.jump(node);
      }
      case 'labeled_statement': {
        return this.labeled(node);
      }
      case 'switch_statement': {
        return this.switchStatement(node);
      }
      case 'throw_statement': {
        return { kind: 'throw', argument: this.expressionOrSequence(namedChildren(node)[0]), row };
      }
      case 'try_statement': {
        return this.tryStatement(node);
      }
      case 'empty_statement': {
        return { kind: 'empty', row };
      }
      case 'generator_function_declaration': {
        return unsupported(node, 'ジェネレータ関数');
      }
      case 'import_statement':
      case 'export_statement': {
        return unsupported(node, 'import や export');
      }
      case 'with_statement': {
        return unsupported(node, 'with 文');
      }
      case 'debugger_statement': {
        return unsupported(node, 'debugger 文');
      }
      case 'using_declaration': {
        return unsupported(node, 'using 宣言');
      }
      default: {
        return unsupported(node, `構文「${node.type}」`);
      }
    }
  }

  /** A statement in a position that only allows a single statement, where a declaration needs braces. */
  private substatement(node: Node): Statement {
    if (['lexical_declaration', 'class_declaration', 'function_declaration'].includes(node.type)) {
      fail(node, '宣言を書くには { } で囲んでください。');
    }
    return this.statement(node);
  }

  private block(node: Node): Block {
    return this.withScope((scope) => ({
      kind: 'block',
      body: this.statementList(namedChildren(node)),
      scope,
      row: node.startPosition.row,
    }));
  }

  private declaration(node: Node, recordsStep: boolean): VariableDeclaration {
    const declarationKind = field(node, 'kind').text as DeclarationKind;
    if (node.type === 'variable_declaration' && declarationKind !== 'var') unsupported(node, `${declarationKind} 宣言`);
    const declarators = namedChildren(node).map((declarator) => {
      const valueNode = declarator.childForFieldName('value');
      const target = this.bindingPattern(field(declarator, 'name'), (identifier, name) => {
        if (declarationKind === 'var') this.declareVar(identifier, name);
        else this.declareLexical(identifier, name, declarationKind === 'const');
      });
      if (!valueNode && declarationKind === 'const') fail(declarator, 'const で宣言する変数には初期値が必要です。');
      if (!valueNode && target.kind !== 'identifier') fail(declarator, '分割代入には初期値が必要です。');
      return { target, init: valueNode ? this.namedValue(valueNode, target) : undefined };
    });
    const declaration: VariableDeclaration = {
      kind: 'declaration',
      declarationKind,
      declarators,
      row: node.startPosition.row,
    };
    // Only an initialized declarator records a step, so a declaration without one leaves its annotation unused.
    if (recordsStep && declarators.some((declarator) => declarator.init)) {
      this.addSteppable(node, (stepId) => (declaration.stepId = stepId));
    }
    return declaration;
  }

  private forStatement(node: Node): Statement {
    const row = node.startPosition.row;
    const header = field(node, 'header');
    return this.withScope((scope) => {
      const initNode = header.childForFieldName('initializer');
      const conditionNode = namedField(header, 'condition');
      const incrementNode = namedField(header, 'increment');
      let init: VariableDeclaration | Expression | undefined;
      if (initNode?.type === 'lexical_declaration' || initNode?.type === 'variable_declaration') {
        init = this.declaration(initNode, false);
      } else if (initNode && initNode.type !== 'empty_statement' && initNode.isNamed) {
        init = this.expressionOrSequence(initNode.type === 'expression_statement' ? namedChildren(initNode)[0] : initNode);
      }
      const statement = {
        kind: 'for' as const,
        init,
        test: conditionNode ? this.expressionOrSequence(conditionNode) : undefined,
        update: incrementNode ? this.expressionOrSequence(incrementNode) : undefined,
        body: undefined as unknown as Statement,
        stepId: undefined as number | undefined,
        perIterationNames:
          init?.kind === 'declaration' && init.declarationKind !== 'var' ? scope.lexical.map(({ name }) => name) : [],
        scope,
        row,
      };
      const hasStepPart =
        (init && (init.kind !== 'declaration' || init.declarators.some((declarator) => declarator.init))) ||
        statement.update;
      if (hasStepPart) {
        // The header records its step as one statement nested in the loop, at the depth of the loop's body.
        for (const part of [initNode, incrementNode]) {
          if (part) this.addSteppable(part, (stepId) => (statement.stepId = stepId), depthOf(node) + 1 - depthOf(part));
        }
      }
      statement.body = this.loop(node, [], () => this.substatement(field(node, 'body')));
      return statement;
    });
  }

  private forInStatement(node: Node): Statement {
    const row = node.startPosition.row;
    const header = field(node, 'header');
    const isOf = field(header, 'operator').text === 'of';
    if (header.children.some((child) => child?.type === 'await')) unsupported(node, 'for await 文');
    const kindNode = header.childForFieldName('kind');
    const declarationKind = kindNode?.text as DeclarationKind | undefined;
    if (header.childForFieldName('value')) fail(node, 'for-in 文の変数には初期値を書けません。');
    return this.withScope((scope) => {
      const leftNode = field(header, 'left');
      const target = declarationKind
        ? this.bindingPattern(leftNode, (identifier, name) => {
            if (declarationKind === 'var') this.declareVar(identifier, name);
            else this.declareLexical(identifier, name, declarationKind === 'const');
          })
        : this.assignmentTarget(leftNode);
      const statement = {
        kind: isOf ? ('forOf' as const) : ('forIn' as const),
        declarationKind,
        target,
        iterable: this.expressionOrSequence(field(header, 'right')),
        body: undefined as unknown as Statement,
        stepId: undefined as number | undefined,
        scope,
        row,
      };
      this.addSteppable(leftNode, (stepId) => (statement.stepId = stepId), depthOf(node) + 1 - depthOf(leftNode));
      statement.body = this.loop(node, [], () => this.substatement(field(node, 'body')));
      return statement;
    });
  }

  /** Converts a loop body or a switch, with `labels` naming the statement. */
  private loop<T>(_node: Node, labels: string[], convert: () => T, isLoop = true): T {
    const { context } = this;
    for (const label of labels) context.labels.set(label, isLoop);
    context.breakableDepth++;
    if (isLoop) context.loopDepth++;
    try {
      return convert();
    } finally {
      context.breakableDepth--;
      if (isLoop) context.loopDepth--;
    }
  }

  private jump(node: Node): Statement {
    const kind = node.type === 'break_statement' ? 'break' : 'continue';
    const label = node.childForFieldName('label')?.text;
    const { context } = this;
    if (label === undefined) {
      if (kind === 'break' && context.breakableDepth === 0) fail(node, 'break 文はループや switch 文の中にしか書けません。');
      if (kind === 'continue' && context.loopDepth === 0) fail(node, 'continue 文はループの中にしか書けません。');
    } else {
      const isLoop = context.labels.get(label);
      if (isLoop === undefined) fail(node, `ラベル ${label} が見つかりません。`);
      if (kind === 'continue' && !isLoop) fail(node, `ラベル ${label} はループに付いていません。`);
    }
    return { kind, label, row: node.startPosition.row };
  }

  private labeled(node: Node): Statement {
    const labels: string[] = [];
    let current = node;
    while (current.type === 'labeled_statement') {
      const label = field(current, 'label').text;
      if (this.context.labels.has(label) || labels.includes(label)) fail(current, `ラベル ${label} はすでに使われています。`);
      labels.push(label);
      current = field(current, 'body');
    }
    const isLoop = ['for_statement', 'for_in_statement', 'while_statement', 'do_statement'].includes(current.type);
    for (const label of labels) this.context.labels.set(label, isLoop);
    try {
      let body: Statement;
      if (isLoop || current.type === 'switch_statement') {
        body = this.substatement(current);
      } else {
        // A labeled block or other statement can be left with `break label`.
        this.context.breakableDepth++;
        try {
          body = this.substatement(current);
        } finally {
          this.context.breakableDepth--;
        }
      }
      return labels.reduceRight<Statement>(
        (inner, label) => ({ kind: 'labeled', label, body: inner, row: node.startPosition.row }),
        body
      );
    } finally {
      for (const label of labels) this.context.labels.delete(label);
    }
  }

  private switchStatement(node: Node): Statement {
    const discriminant = this.parenthesized(field(node, 'value'));
    return this.withScope((scope) =>
      this.loop(
        node,
        [],
        () => {
          let hasDefault = false;
          const cases: SwitchCase[] = namedChildren(field(node, 'body')).map((caseNode) => {
            if (caseNode.type === 'switch_default') {
              if (hasDefault) fail(caseNode, 'default は1つしか書けません。');
              hasDefault = true;
            }
            const valueNode = caseNode.childForFieldName('value');
            return {
              test: valueNode ? this.expressionOrSequence(valueNode) : undefined,
              body: this.statementList(caseNode.childrenForFieldName('body').filter(isPresent)),
            };
          });
          return { kind: 'switch' as const, discriminant, cases, scope, row: node.startPosition.row };
        },
        false
      )
    );
  }

  private tryStatement(node: Node): Statement {
    const handlerNode = node.childForFieldName('handler');
    const finalizerNode = node.childForFieldName('finalizer');
    let handler: CatchClause | undefined;
    if (handlerNode) {
      handler = this.withScope((scope) => {
        const parameterNode = handlerNode.childForFieldName('parameter');
        const param = parameterNode
          ? this.bindingPattern(parameterNode, (identifier, name) => this.declareLexical(identifier, name, false))
          : undefined;
        return { param, body: this.block(field(handlerNode, 'body')), scope };
      });
    }
    return {
      kind: 'try',
      block: this.block(field(node, 'body')),
      handler,
      finalizer: finalizerNode ? this.block(field(finalizerNode, 'body')) : undefined,
      row: node.startPosition.row,
    };
  }

  // Functions and classes -----------------------------------------------------------------------------------------

  private functionNode(node: Node, kind: FunctionKind, name = node.childForFieldName('name')?.text ?? ''): FunctionNode {
    if (node.children.some((child) => child?.type === 'async')) unsupported(node, 'async 関数');
    if (node.children.some((child) => child?.type === '*')) unsupported(node, 'ジェネレータ関数');
    const bodyNode = field(node, 'body');
    if (bodyNode.type === 'statement_block') {
      this.bodyRanges.push({ row: bodyNode.startPosition.row, endRow: bodyNode.endPosition.row });
    }
    const outerContext = this.context;
    const isArrow = kind === 'arrow';
    this.context = {
      ...newContext(
        true,
        isArrow ? outerContext.canCallSuper : kind === 'classConstructor' && this.derivedConstructor,
        isArrow ? outerContext.canReferenceSuper : kind !== 'normal'
      ),
    };
    const scope = this.pushScope(true);
    try {
      const parameterNode = node.childForFieldName('parameters');
      const parameterNodes = parameterNode
        ? namedChildren(parameterNode)
        : [field(node, 'parameter')];
      const declare = (identifier: Node, parameterName: string): void => this.declareParameter(identifier, parameterName);
      const params: Pattern[] = [];
      let rest: Pattern | undefined;
      for (const parameter of parameterNodes) {
        if (rest) fail(parameter, '残余引数は最後の引数にしか書けません。');
        if (parameter.type === 'rest_pattern') rest = this.bindingPattern(namedChildren(parameter)[0], declare);
        else params.push(this.bindingPattern(parameter, declare));
      }
      if (kind === 'getter' && (params.length > 0 || rest)) fail(node, 'getter には引数を書けません。');
      if (kind === 'setter' && (params.length !== 1 || rest)) fail(node, 'setter には引数を1つだけ書いてください。');
      const body =
        bodyNode.type === 'statement_block'
          ? this.statementList(namedChildren(bodyNode))
          : this.expression(bodyNode);
      return {
        name,
        kind,
        params,
        rest,
        bindsOwnName: node.type === 'function_expression' && node.childForFieldName('name') !== null,
        body,
        scope: scope.declarations,
        source: this.source.slice(node.startIndex, node.endIndex),
        row: node.startPosition.row,
      };
    } finally {
      this.scopes.pop();
      this.context = outerContext;
    }
  }

  private classNode(node: Node, name: string): ClassNode {
    const heritage = namedChildren(node).find((child) => child.type === 'class_heritage');
    if (namedChildren(node).some((child) => child.type === 'decorator')) unsupported(node, 'デコレータ');
    const superClass = heritage ? this.expression(namedChildren(heritage)[0]) : undefined;
    const members: ClassMember[] = [];
    let ctor: FunctionNode | undefined;
    const outerDerived = this.derivedConstructor;
    this.derivedConstructor = superClass !== undefined;
    try {
      for (const member of namedChildren(field(node, 'body'))) {
        switch (member.type) {
          case 'method_definition': {
            const isStatic = member.children.some((child) => child?.type === 'static');
            const key = this.propertyName(field(member, 'name'));
            const accessor = member.children.find((child) => child?.type === 'get' || child?.type === 'set')?.type;
            if (!isStatic && key.kind === 'key' && key.key === 'constructor') {
              if (accessor) fail(member, 'constructor を getter や setter にはできません。');
              if (ctor) fail(member, 'constructor は1つしか書けません。');
              ctor = this.functionNode(member, 'classConstructor', name);
              break;
            }
            const kind = accessor === 'get' ? 'getter' : accessor === 'set' ? 'setter' : 'method';
            members.push({ kind, isStatic, key, fn: this.functionNode(member, kind, keyName(key)) });
            break;
          }
          case 'field_definition': {
            const isStatic = member.children.some((child) => child?.type === 'static');
            const key = this.propertyName(field(member, 'property'));
            const valueNode = member.childForFieldName('value');
            const fieldMember: ClassMember = {
              kind: 'field',
              isStatic,
              key,
              value: valueNode ? this.fieldInitializer(valueNode) : undefined,
              row: member.startPosition.row,
            };
            if (valueNode) this.addSteppable(member, (stepId) => (fieldMember.stepId = stepId));
            members.push(fieldMember);
            break;
          }
          case 'class_static_block': {
            unsupported(member, 'static ブロック');
            break;
          }
          default: {
            unsupported(member, `クラスの中の「${member.type}」`);
          }
        }
      }
    } finally {
      this.derivedConstructor = outerDerived;
    }
    return {
      name,
      superClass,
      ctor,
      members,
      source: this.source.slice(node.startIndex, node.endIndex),
      row: node.startPosition.row,
    };
  }

  /** Field initializers run like method bodies, where `this` is the instance and `super.x` works. */
  private fieldInitializer(node: Node): Expression {
    const outerContext = this.context;
    this.context = newContext(false, false, true);
    try {
      return this.expression(node);
    } finally {
      this.context = outerContext;
    }
  }

  private propertyName(node: Node): PropertyName {
    switch (node.type) {
      case 'property_identifier':
      case 'identifier': {
        return { kind: 'key', key: node.text };
      }
      case 'private_property_identifier': {
        return { kind: 'private', name: node.text };
      }
      case 'string': {
        return { kind: 'key', key: decodeStringLiteral(node.text) };
      }
      case 'number': {
        return { kind: 'key', key: String(this.number(node)) };
      }
      case 'computed_property_name': {
        return { kind: 'computed', expression: this.expression(namedChildren(node)[0]) };
      }
      default: {
        return unsupported(node, `プロパティ名「${node.type}」`);
      }
    }
  }

  // Patterns ------------------------------------------------------------------------------------------------------

  /** A pattern that declares variables, calling `declare` for each name. */
  private bindingPattern(node: Node, declare: (identifier: Node, name: string) => void): Pattern {
    return this.pattern(node, (target) => {
      if (target.type !== 'identifier' && target.type !== 'shorthand_property_identifier_pattern') {
        fail(target, '宣言では変数名しか書けません。');
      }
      checkBindingName(target);
      declare(target, target.text);
      return { kind: 'identifier', name: target.text, row: target.startPosition.row };
    });
  }

  /** A pattern that assigns to existing variables and properties. */
  private assignmentTarget(node: Node): Pattern {
    return this.pattern(node, (target) => {
      const unwrapped = unwrapParentheses(target);
      if (unwrapped.type === 'identifier' || unwrapped.type === 'shorthand_property_identifier_pattern') {
        checkBindingName(unwrapped);
        return { kind: 'identifier', name: unwrapped.text, row: unwrapped.startPosition.row };
      }
      if (unwrapped.type === 'member_expression' || unwrapped.type === 'subscript_expression') {
        const member = this.expression(unwrapped);
        if (member.kind !== 'member' || member.optional) fail(unwrapped, '?. を含む式には代入できません。');
        return member;
      }
      return fail(target, 'この式には代入できません。');
    });
  }

  private pattern(node: Node, leaf: (node: Node) => Pattern): Pattern {
    const row = node.startPosition.row;
    switch (node.type) {
      case 'assignment_pattern':
      case 'object_assignment_pattern': {
        return { kind: 'default', target: this.pattern(field(node, 'left'), leaf), value: this.expression(field(node, 'right')), row };
      }
      case 'array_pattern':
      case 'array': {
        const elements: (Pattern | undefined)[] = [];
        let rest: Pattern | undefined;
        let expectsElement = true;
        for (const child of node.children) {
          if (!child || child.type === '[' || child.type === ']' || child.type === 'comment') continue;
          if (child.type === ',') {
            if (expectsElement) elements.push(undefined);
            expectsElement = true;
            continue;
          }
          if (rest) fail(child, '残余要素は最後にしか書けません。');
          if (child.type === 'rest_pattern' || child.type === 'spread_element') {
            rest = this.pattern(namedChildren(child)[0], leaf);
          } else {
            elements.push(this.pattern(child, leaf));
          }
          expectsElement = false;
        }
        return { kind: 'arrayPattern', elements, rest, row };
      }
      case 'object_pattern':
      case 'object': {
        const properties: { key: PropertyName; value: Pattern }[] = [];
        let rest: Pattern | undefined;
        for (const child of namedChildren(node)) {
          if (rest) fail(child, '残余プロパティは最後にしか書けません。');
          switch (child.type) {
            case 'shorthand_property_identifier_pattern':
            case 'shorthand_property_identifier': {
              properties.push({ key: { kind: 'key', key: child.text }, value: leaf(child) });
              break;
            }
            case 'object_assignment_pattern': {
              const left = field(child, 'left');
              properties.push({ key: { kind: 'key', key: left.text }, value: this.pattern(child, leaf) });
              break;
            }
            case 'pair_pattern':
            case 'pair': {
              properties.push({ key: this.propertyName(field(child, 'key')), value: this.pattern(field(child, 'value'), leaf) });
              break;
            }
            case 'rest_pattern':
            case 'spread_element': {
              rest = this.pattern(namedChildren(child)[0], leaf);
              break;
            }
            default: {
              fail(child, '分割代入の書き方に誤りがあります。');
            }
          }
        }
        return { kind: 'objectPattern', properties, rest, row };
      }
      case 'assignment_expression': {
        // An object or array literal used as a pattern spells defaults as assignments.
        return { kind: 'default', target: this.pattern(field(node, 'left'), leaf), value: this.expression(field(node, 'right')), row };
      }
      case 'parenthesized_expression': {
        return leaf(node);
      }
      default: {
        return leaf(node);
      }
    }
  }

  // Expressions ---------------------------------------------------------------------------------------------------

  private expressionOrSequence(node: Node): Expression {
    return this.expression(node);
  }

  private parenthesized(node: Node): Expression {
    return this.expression(node.type === 'parenthesized_expression' ? namedChildren(node)[0] : node);
  }

  // code-gauge-allow functionNcss 120 -- One case per expression kind, each delegating where it grows.
  private expression(node: Node): Expression {
    const row = node.startPosition.row;
    switch (node.type) {
      case 'number': {
        return { kind: 'literal', value: this.number(node), row };
      }
      case 'string': {
        return { kind: 'literal', value: decodeStringLiteral(node.text), row };
      }
      case 'template_string': {
        return this.template(node);
      }
      case 'true':
      case 'false': {
        return { kind: 'literal', value: node.type === 'true', row };
      }
      case 'null': {
        // oxlint-disable-next-line unicorn/no-null -- JavaScript null is a value of the interpreted language.
        return { kind: 'literal', value: null, row };
      }
      case 'undefined':
      case 'identifier': {
        return { kind: 'identifier', name: node.text, row };
      }
      case 'this': {
        return { kind: 'this', row };
      }
      case 'super': {
        return fail(node, 'super は super(...) か super.メソッド名 の形でしか書けません。');
      }
      case 'array': {
        return { kind: 'array', elements: this.arrayElements(node), row };
      }
      case 'object': {
        return { kind: 'object', members: this.objectMembers(node), row };
      }
      case 'function_expression': {
        return { kind: 'functionExpression', fn: this.functionNode(node, 'normal'), row };
      }
      case 'arrow_function': {
        return { kind: 'functionExpression', fn: this.functionNode(node, 'arrow'), row };
      }
      case 'class': {
        return { kind: 'classExpression', cls: this.classNode(node, node.childForFieldName('name')?.text ?? ''), row };
      }
      case 'member_expression':
      case 'subscript_expression': {
        return this.member(node);
      }
      case 'call_expression': {
        return this.call(node);
      }
      case 'new_expression': {
        const argumentsNode = node.childForFieldName('arguments');
        const callee = field(node, 'constructor');
        if (callee.type === 'call_expression' && callee.childForFieldName('arguments')?.type === 'template_string') {
          unsupported(callee, 'タグ付きテンプレート');
        }
        return {
          kind: 'new',
          callee: this.expression(callee),
          args: argumentsNode ? this.arguments(argumentsNode) : [],
          calleeText: calleeText(callee),
          row,
        };
      }
      case 'assignment_expression': {
        const left = field(node, 'left');
        const target = this.assignmentTarget(left);
        return { kind: 'assign', operator: '=', target, value: this.namedValue(field(node, 'right'), target), row };
      }
      case 'augmented_assignment_expression': {
        const left = unwrapParentheses(field(node, 'left'));
        if (left.type !== 'identifier' && left.type !== 'member_expression' && left.type !== 'subscript_expression') {
          fail(left, 'この式には代入できません。');
        }
        const target = this.assignmentTarget(left);
        const operator = field(node, 'operator').text;
        return { kind: 'assign', operator, target, value: this.namedValue(field(node, 'right'), target), row };
      }
      case 'update_expression': {
        const argument = unwrapParentheses(field(node, 'argument'));
        if (argument.type !== 'identifier' && argument.type !== 'member_expression' && argument.type !== 'subscript_expression') {
          fail(argument, 'この式は ++ や -- で変更できません。');
        }
        return {
          kind: 'update',
          operator: field(node, 'operator').text as '++' | '--',
          prefix: node.firstChild?.type === '++' || node.firstChild?.type === '--',
          target: this.assignmentTarget(argument),
          row,
        };
      }
      case 'unary_expression': {
        const operator = field(node, 'operator').text;
        const argument = field(node, 'argument');
        if (operator === 'delete' && unwrapParentheses(argument).type === 'identifier') {
          fail(node, '変数は delete できません。');
        }
        return { kind: 'unary', operator, argument: this.expression(argument), row };
      }
      case 'binary_expression': {
        const operator = field(node, 'operator').text;
        const leftNode = field(node, 'left');
        if (leftNode.type === 'private_property_identifier') unsupported(leftNode, '#name in 式');
        const left = this.expression(leftNode);
        const right = this.expression(field(node, 'right'));
        if (operator === '&&' || operator === '||' || operator === '??') {
          return { kind: 'logical', operator, left, right, row };
        }
        return { kind: 'binary', operator, left, right, row };
      }
      case 'ternary_expression': {
        return {
          kind: 'conditional',
          test: this.expression(field(node, 'condition')),
          consequent: this.expression(field(node, 'consequence')),
          alternate: this.expression(field(node, 'alternative')),
          row,
        };
      }
      case 'sequence_expression': {
        return { kind: 'sequence', expressions: namedChildren(node).map((child) => this.expression(child)), row };
      }
      case 'parenthesized_expression': {
        const inner = namedChildren(node)[0];
        return { kind: 'parenthesized', expression: this.expression(inner), row };
      }
      case 'regex': {
        return unsupported(node, '正規表現');
      }
      case 'await_expression': {
        return unsupported(node, 'await');
      }
      case 'yield_expression':
      case 'generator_function': {
        return unsupported(node, 'ジェネレータ');
      }
      case 'meta_property': {
        return unsupported(node, node.text);
      }
      case 'jsx_element':
      case 'jsx_self_closing_element': {
        return unsupported(node, 'JSX');
      }
      default: {
        return unsupported(node, `式「${node.type}」`);
      }
    }
  }

  /** Converts the value of `name = value`, which names an anonymous function after the variable. */
  private namedValue(node: Node, target: Pattern): Expression {
    const value = this.expression(node);
    if (target.kind === 'identifier') nameAnonymous(value, target.name);
    return value;
  }

  private number(node: Node): number {
    const value = parseNumberLiteral(node.text);
    if (value === undefined) return unsupported(node, `数値「${node.text}」`);
    return value;
  }

  private template(node: Node): Expression {
    const strings: string[] = [''];
    const expressions: Expression[] = [];
    for (const child of node.children) {
      if (!child) continue;
      if (child.type === 'template_substitution') {
        expressions.push(this.expressionOrSequence(namedChildren(child)[0]));
        strings.push('');
      } else if (child.type === 'string_fragment' || child.type === 'escape_sequence') {
        strings[strings.length - 1] += decodeTemplateFragment(child.text);
      }
    }
    return { kind: 'template', strings, expressions, row: node.startPosition.row };
  }

  private arrayElements(node: Node): (Argument | undefined)[] {
    const elements: (Argument | undefined)[] = [];
    let expectsElement = true;
    for (const child of node.children) {
      if (!child || child.type === '[' || child.type === ']' || child.type === 'comment') continue;
      if (child.type === ',') {
        if (expectsElement) elements.push(undefined);
        expectsElement = true;
        continue;
      }
      elements.push(this.argument(child));
      expectsElement = false;
    }
    return elements;
  }

  private objectMembers(node: Node): ObjectMember[] {
    return namedChildren(node).map((member): ObjectMember => {
      switch (member.type) {
        case 'pair': {
          const key = this.propertyName(field(member, 'key'));
          const value = this.expression(field(member, 'value'));
          if (key.kind === 'key') nameAnonymous(value, key.key);
          return { kind: 'property', key, value };
        }
        case 'shorthand_property_identifier': {
          return {
            kind: 'property',
            key: { kind: 'key', key: member.text },
            value: { kind: 'identifier', name: member.text, row: member.startPosition.row },
          };
        }
        case 'method_definition': {
          const key = this.propertyName(field(member, 'name'));
          if (key.kind === 'private') fail(member, 'オブジェクトリテラルには # で始まる名前を書けません。');
          const accessor = member.children.find((child) => child?.type === 'get' || child?.type === 'set')?.type;
          if (accessor) {
            const kind = accessor === 'get' ? 'getter' : 'setter';
            return { kind, key, fn: this.functionNode(member, kind, keyName(key)) };
          }
          return {
            kind: 'property',
            key,
            value: {
              kind: 'functionExpression',
              fn: this.functionNode(member, 'method', keyName(key)),
              row: member.startPosition.row,
            },
          };
        }
        case 'spread_element': {
          return { kind: 'spread', argument: this.expression(namedChildren(member)[0]) };
        }
        default: {
          return unsupported(member, `オブジェクトリテラルの「${member.type}」`);
        }
      }
    });
  }

  private member(node: Node): Expression {
    const row = node.startPosition.row;
    const objectNode = field(node, 'object');
    const optional = node.childForFieldName('optional_chain') !== null;
    const object = objectNode.type === 'super' ? this.superReference(objectNode) : this.expression(objectNode);
    if (object.kind === 'super' && optional) fail(node, 'super に ?. は使えません。');
    let property: PropertyName;
    if (node.type === 'member_expression') {
      const propertyNode = field(node, 'property');
      property =
        propertyNode.type === 'private_property_identifier'
          ? { kind: 'private', name: propertyNode.text }
          : { kind: 'key', key: propertyNode.text };
      if (property.kind === 'private' && object.kind === 'super') fail(node, 'super.#name とは書けません。');
    } else {
      property = { kind: 'computed', expression: this.expressionOrSequence(field(node, 'index')) };
    }
    return { kind: 'member', object, property, optional, row };
  }

  private superReference(node: Node): { kind: 'super'; row: number } {
    if (!this.context.canReferenceSuper) fail(node, 'super.名前 はメソッドの中にしか書けません。');
    return { kind: 'super', row: node.startPosition.row };
  }

  private call(node: Node): Expression {
    const row = node.startPosition.row;
    const functionNode = field(node, 'function');
    const argumentsNode = field(node, 'arguments');
    if (argumentsNode.type === 'template_string') unsupported(node, 'タグ付きテンプレート');
    if (functionNode.type === 'import') unsupported(node, 'import()');
    const optional = node.childForFieldName('optional_chain') !== null;
    if (functionNode.type === 'super') {
      if (!this.context.canCallSuper) fail(node, 'super(...) は継承したクラスのコンストラクタの中にしか書けません。');
      return {
        kind: 'call',
        callee: { kind: 'super', row },
        args: this.arguments(argumentsNode),
        optional: false,
        calleeText: 'super',
        row,
      };
    }
    return {
      kind: 'call',
      callee: this.expression(functionNode),
      args: this.arguments(argumentsNode),
      optional,
      calleeText: calleeText(functionNode),
      row,
    };
  }

  private arguments(node: Node): Argument[] {
    return namedChildren(node).map((child) => this.argument(child));
  }

  private argument(node: Node): Argument {
    if (node.type === 'spread_element') return { kind: 'spread', argument: this.expression(namedChildren(node)[0]) };
    return this.expression(node);
  }
}

function newContext(canReturn: boolean, canCallSuper: boolean, canReferenceSuper: boolean): FunctionContext {
  return { canReturn, canCallSuper, canReferenceSuper, labels: new Map(), breakableDepth: 0, loopDepth: 0 };
}

/** Gives an anonymous function or class the name it is assigned to, as `name` and stack traces show. */
function nameAnonymous(value: Expression, name: string): void {
  if (value.kind === 'functionExpression' && value.fn.name === '') value.fn.name = name;
  if (value.kind === 'classExpression' && value.cls.name === '') value.cls.name = name;
}

function keyName(key: PropertyName): string {
  if (key.kind === 'key') return key.key;
  if (key.kind === 'private') return key.name;
  return '';
}

const reservedBindingNames = new Set(['eval', 'arguments']);

function checkBindingName(node: Node): void {
  if (reservedBindingNames.has(node.text)) fail(node, `${node.text} は変数名に使えません。`);
}

function unwrapParentheses(node: Node): Node {
  let current = node;
  while (current.type === 'parenthesized_expression') current = namedChildren(current)[0];
  return current;
}

/** The text of a callee for error messages, shortened as long expressions are. */
function calleeText(node: Node): string {
  const text = node.text.replaceAll(/\s+/g, ' ');
  return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}

function depthOf(node: Node): number {
  let depth = 0;
  for (let current = node.parent; current; current = current.parent) depth++;
  return depth;
}

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null && child.type !== 'comment');
}

function namedField(node: Node, name: string): Node | undefined {
  return node.childrenForFieldName(name).find((child): child is Node => child !== null && child.isNamed && child.type !== 'empty_statement');
}

function field(node: Node, name: string): Node {
  const child = node.childForFieldName(name);
  if (!child) return fail(node, '書き方に誤りがあります。');
  return child;
}

function isPresent(node: Node | null): node is Node {
  return node !== null && node.type !== 'comment';
}

function fail(node: Node, message: string): never {
  throw new CompileError([{ row: node.startPosition.row, message }]);
}

function unsupported(node: Node, feature: string): never {
  return fail(node, `${feature}は、この採点環境では使えません。`);
}
