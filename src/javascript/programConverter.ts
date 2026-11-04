import type { Node } from '@willbooster/web-tree-sitter';

import type {
  Block,
  CatchClause,
  ClassMember,
  ClassNode,
  DeclarationKind,
  Expression,
  FunctionKind,
  FunctionNode,
  Pattern,
  Program,
  PropertyName,
  Statement,
  VariableDeclaration,
} from './ast';
import { newContext } from './converterBase';
import {
  accessorOf,
  fail,
  field,
  hasChild,
  isPresent,
  keyName,
  namedChildren,
  namedField,
  rowOf,
  unsupported,
  unsupportedFeatures,
} from './convertNodes';
import { ExpressionConverter } from './expressionConverter';

type StatementConverter = (node: Node) => Statement;

const loopTypes = new Set(['for_statement', 'for_in_statement', 'while_statement', 'do_statement']);
const declarationTypes = new Set(['lexical_declaration', 'class_declaration', 'function_declaration']);

/** Converts a tree-sitter tree to the AST, settling scopes, steps, and early errors. */
export class ProgramConverter extends ExpressionConverter {
  /** Whether the class being converted extends another, which lets its constructor call `super()`. */
  private derivedConstructor = false;

  private readonly statementConverters: Record<string, StatementConverter> = {
    expression_statement: (node) =>
      this.steppable(node, {
        kind: 'expression',
        expression: this.expression(namedChildren(node)[0]),
        row: rowOf(node),
      }),
    lexical_declaration: (node) => this.declaration(node, true),
    variable_declaration: (node) => this.declaration(node, true),
    function_declaration: (node) => {
      this.declareFunction(node, this.functionNode(node, 'normal'));
      return { kind: 'function', row: rowOf(node) };
    },
    class_declaration: (node) => {
      const name = field(node, 'name').text;
      this.declareLexical(node, name, false);
      return { kind: 'class', cls: this.classNode(node, name), row: rowOf(node) };
    },
    return_statement: (node) => this.returnStatement(node),
    if_statement: (node) => {
      const alternative = node.childForFieldName('alternative');
      return {
        kind: 'if',
        test: this.parenthesized(field(node, 'condition')),
        consequent: this.substatement(field(node, 'consequence')),
        alternate: alternative ? this.substatement(namedChildren(alternative)[0]) : undefined,
        row: rowOf(node),
      };
    },
    statement_block: (node) => this.block(node),
    for_statement: (node) => this.forStatement(node),
    for_in_statement: (node) => this.forInStatement(node),
    while_statement: (node) =>
      this.inBreakable(true, () => ({
        kind: 'while',
        test: this.parenthesized(field(node, 'condition')),
        body: this.substatement(field(node, 'body')),
        row: rowOf(node),
      })),
    do_statement: (node) =>
      this.inBreakable(true, () => ({
        kind: 'doWhile',
        body: this.substatement(field(node, 'body')),
        test: this.parenthesized(field(node, 'condition')),
        row: rowOf(node),
      })),
    break_statement: (node) => this.jump(node, 'break'),
    continue_statement: (node) => this.jump(node, 'continue'),
    labeled_statement: (node) => this.labeled(node),
    switch_statement: (node) => this.switchStatement(node),
    throw_statement: (node) => ({ kind: 'throw', argument: this.expression(namedChildren(node)[0]), row: rowOf(node) }),
    try_statement: (node) => this.tryStatement(node),
    empty_statement: (node) => ({ kind: 'empty', row: rowOf(node) }),
  };

  convert(root: Node): Program {
    const scope = this.pushScope(true);
    const body = this.statementList(namedChildren(root).filter((child) => child.type !== 'hash_bang_line'));
    this.popScope();
    this.checkAtomicRows();
    return { body, scope };
  }

  // Statements ------------------------------------------------------------------------------------------------------

  private statementList(nodes: Node[]): Statement[] {
    return nodes.map((node) => this.statement(node));
  }

  private statement(node: Node): Statement {
    const convert = this.statementConverters[node.type] as StatementConverter | undefined;
    if (convert) return convert(node);
    return unsupported(node, unsupportedFeatures[node.type] ?? `構文「${node.type}」`);
  }

  /** Lets a statement record the step of its row. */
  private steppable<T extends Statement | ClassMember>(node: Node, statement: T): T {
    (statement as { stepRow?: number }).stepRow = this.stepRowOf(node);
    return statement;
  }

  /** A statement in a position that only allows a single statement, where a declaration needs braces. */
  private substatement(node: Node): Statement {
    if (declarationTypes.has(node.type)) fail(node, '宣言を書くには { } で囲んでください。');
    return this.statement(node);
  }

  private block(node: Node): Block {
    return this.withScope((scope) => ({
      kind: 'block',
      body: this.statementList(namedChildren(node)),
      scope,
      row: rowOf(node),
    }));
  }

  private returnStatement(node: Node): Statement {
    if (!this.context.canReturn) fail(node, 'return 文は関数の中にしか書けません。');
    const valueNode = namedChildren(node).at(0);
    return { kind: 'return', value: valueNode ? this.expression(valueNode) : undefined, row: rowOf(node) };
  }

  private declaration(node: Node, recordsStep: boolean): VariableDeclaration {
    const declarationKind: DeclarationKind =
      node.type === 'variable_declaration' ? 'var' : (field(node, 'kind').text as DeclarationKind);
    const declarators = namedChildren(node).map((declarator) => {
      const valueNode = declarator.childForFieldName('value');
      const target = this.bindingPattern(field(declarator, 'name'), (identifier, name) =>
        this.declareVariable(identifier, name, declarationKind)
      );
      if (!valueNode && declarationKind === 'const') fail(declarator, 'const で宣言する変数には初期値が必要です。');
      if (!valueNode && target.kind !== 'identifier') fail(declarator, '分割代入には初期値が必要です。');
      return { target, init: valueNode ? this.namedValue(valueNode, target) : undefined };
    });
    const declaration: VariableDeclaration = { kind: 'declaration', declarationKind, declarators, row: rowOf(node) };
    // A declaration without an initializer assigns nothing that learners could answer, so it records no step.
    if (recordsStep && declarators.some((declarator) => declarator.init)) this.steppable(node, declaration);
    return declaration;
  }

  private forStatement(node: Node): Statement {
    const header = field(node, 'header');
    return this.withScope((scope) => {
      const initNode = header.childForFieldName('initializer');
      const incrementNode = namedField(header, 'increment');
      const init = this.forInit(initNode);
      const conditionNode = namedField(header, 'condition');
      const isLexical = init?.kind === 'declaration' && init.declarationKind !== 'var';
      const test = conditionNode ? this.expression(conditionNode) : undefined;
      const update = incrementNode ? this.expression(incrementNode) : undefined;
      const perIterationNames = isLexical ? scope.lexical.map(({ name }) => name) : [];
      return {
        kind: 'for',
        init,
        test,
        update,
        body: this.inBreakable(true, () => this.substatement(field(node, 'body'))),
        perIterationNames,
        scope,
        stepRow: recordsHeaderStep(init, update) ? this.stepRowOf(node) : undefined,
        row: rowOf(node),
      };
    });
  }

  private forInit(initNode: Node | null): VariableDeclaration | Expression | undefined {
    if (!initNode?.isNamed || initNode.type === 'empty_statement') return undefined;
    if (initNode.type === 'lexical_declaration' || initNode.type === 'variable_declaration') {
      return this.declaration(initNode, false);
    }
    return this.expression(initNode.type === 'expression_statement' ? namedChildren(initNode)[0] : initNode);
  }

  private forInStatement(node: Node): Statement {
    const header = field(node, 'header');
    if (hasChild(header, 'await')) unsupported(node, 'for await 文');
    if (header.childForFieldName('value')) fail(node, 'for-in 文の変数には初期値を書けません。');
    const declarationKind = header.childForFieldName('kind')?.text as DeclarationKind | undefined;
    return this.withScope((scope) => {
      const leftNode = field(header, 'left');
      const target = declarationKind
        ? this.bindingPattern(leftNode, (identifier, name) => this.declareVariable(identifier, name, declarationKind))
        : this.assignmentTarget(leftNode);
      return {
        kind: field(header, 'operator').text === 'of' ? 'forOf' : 'forIn',
        declarationKind,
        target,
        iterable: this.expression(field(header, 'right')),
        body: this.inBreakable(true, () => this.substatement(field(node, 'body'))),
        scope,
        stepRow: this.stepRowOf(node),
        row: rowOf(node),
      };
    });
  }

  /** Converts a statement that `break` can leave, and `continue` too when it is a loop. */
  private inBreakable<T>(isLoop: boolean, convert: () => T): T {
    const { context } = this;
    context.breakableDepth++;
    if (isLoop) context.loopDepth++;
    try {
      return convert();
    } finally {
      context.breakableDepth--;
      if (isLoop) context.loopDepth--;
    }
  }

  private jump(node: Node, kind: 'break' | 'continue'): Statement {
    const label = node.childForFieldName('label')?.text;
    const { context } = this;
    if (label !== undefined) {
      const isLoop = context.labels.get(label);
      if (isLoop === undefined) fail(node, `ラベル ${label} が見つかりません。`);
      if (kind === 'continue' && !isLoop) fail(node, `ラベル ${label} はループに付いていません。`);
    } else if (kind === 'break' && context.breakableDepth === 0) {
      fail(node, 'break 文はループや switch 文の中にしか書けません。');
    } else if (kind === 'continue' && context.loopDepth === 0) {
      fail(node, 'continue 文はループの中にしか書けません。');
    }
    return { kind, label, row: rowOf(node) };
  }

  private labeled(node: Node): Statement {
    const labels: string[] = [];
    let current = node;
    while (current.type === 'labeled_statement') {
      const label = field(current, 'label').text;
      if (this.context.labels.has(label) || labels.includes(label))
        fail(current, `ラベル ${label} はすでに使われています。`);
      labels.push(label);
      current = field(current, 'body');
    }
    const isLoop = loopTypes.has(current.type);
    for (const label of labels) this.context.labels.set(label, isLoop);
    try {
      // `break label` leaves any labeled statement, which context.labels validates; a plain `break` needs a loop or switch.
      let body = this.substatement(current);
      for (const label of labels.toReversed()) body = { kind: 'labeled', label, body, row: rowOf(node) };
      return body;
    } finally {
      for (const label of labels) this.context.labels.delete(label);
    }
  }

  private switchStatement(node: Node): Statement {
    const discriminant = this.parenthesized(field(node, 'value'));
    return this.withScope((scope) =>
      this.inBreakable(false, () => {
        const caseNodes = namedChildren(field(node, 'body'));
        const defaults = caseNodes.filter((caseNode) => caseNode.type === 'switch_default');
        if (defaults.length > 1) fail(defaults[1], 'default は1つしか書けません。');
        const cases = caseNodes.map((caseNode) => {
          const valueNode = caseNode.childForFieldName('value');
          return {
            test: valueNode ? this.expression(valueNode) : undefined,
            body: this.statementList(caseNode.childrenForFieldName('body').filter(isPresent)),
          };
        });
        return { kind: 'switch', discriminant, cases, scope, row: rowOf(node) };
      })
    );
  }

  private tryStatement(node: Node): Statement {
    const handlerNode = node.childForFieldName('handler');
    const finalizerNode = node.childForFieldName('finalizer');
    const block = this.block(field(node, 'body'));
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
    const finalizer = finalizerNode ? this.block(field(finalizerNode, 'body')) : undefined;
    return { kind: 'try', block, handler, finalizer, row: rowOf(node) };
  }

  // Functions and classes -------------------------------------------------------------------------------------------

  functionNode(node: Node, kind: FunctionKind, name = node.childForFieldName('name')?.text ?? ''): FunctionNode {
    if (hasChild(node, 'async')) unsupported(node, 'async 関数');
    if (hasChild(node, '*')) unsupported(node, 'ジェネレータ関数');
    const bodyNode = field(node, 'body');
    const isAtomic = this.claimsAtomicRow(node, bodyNode);
    const outer = this.context;
    const isArrow = kind === 'arrow';
    const context = newContext(
      true,
      isArrow ? outer.canCallSuper : kind === 'classConstructor' && this.derivedConstructor,
      isArrow ? outer.canReferenceSuper : kind !== 'normal'
    );
    if (isArrow) context.argumentsUse = outer.argumentsUse;
    return this.withContext(context, () => {
      const scope = this.pushScope(true);
      try {
        const { params, rest } = this.parameters(node, kind);
        const body =
          bodyNode.type === 'statement_block' ? this.statementList(namedChildren(bodyNode)) : this.expression(bodyNode);
        const bindsOwnName = node.type === 'function_expression' && node.childForFieldName('name') !== null;
        // Only an arrow function's own uses are its enclosing function's; a function's own uses get its arguments.
        const usesArguments = !isArrow && context.argumentsUse.isUsed;
        return {
          name,
          kind,
          params,
          rest,
          bindsOwnName,
          usesArguments,
          body,
          scope,
          isAtomic,
          source: this.sourceOf(node),
          row: rowOf(node),
        };
      } finally {
        this.popScope();
      }
    });
  }

  private parameters(node: Node, kind: FunctionKind): { params: Pattern[]; rest?: Pattern } {
    const parameterNode = node.childForFieldName('parameters');
    const parameterNodes = parameterNode ? namedChildren(parameterNode) : [field(node, 'parameter')];
    const declare = (identifier: Node, name: string): void => this.declareParameter(identifier, name);
    const params: Pattern[] = [];
    let rest: Pattern | undefined;
    for (const parameter of parameterNodes) {
      if (rest) fail(parameter, '残余引数は最後の引数にしか書けません。');
      if (parameter.type === 'rest_pattern') rest = this.bindingPattern(namedChildren(parameter)[0], declare);
      else params.push(this.bindingPattern(parameter, declare));
    }
    if (kind === 'getter' && (params.length > 0 || rest)) fail(node, 'getter には引数を書けません。');
    if (kind === 'setter' && (params.length !== 1 || rest)) fail(node, 'setter には引数を1つだけ書いてください。');
    return { params, rest };
  }

  classNode(node: Node, name: string): ClassNode {
    if (namedChildren(node).some((child) => child.type === 'decorator')) unsupported(node, 'デコレータ');
    const heritage = namedChildren(node).find((child) => child.type === 'class_heritage');
    const superClass = heritage ? this.expression(namedChildren(heritage)[0]) : undefined;
    const members: ClassMember[] = [];
    let ctor: FunctionNode | undefined;
    const outerDerived = this.derivedConstructor;
    this.derivedConstructor = superClass !== undefined;
    try {
      for (const member of namedChildren(field(node, 'body'))) {
        if (!isConstructorDefinition(member)) {
          members.push(this.classMember(member));
          continue;
        }
        if (accessorOf(member)) fail(member, 'constructor を getter や setter にはできません。');
        if (ctor) fail(member, 'constructor は1つしか書けません。');
        ctor = this.functionNode(member, 'classConstructor', name);
      }
    } finally {
      this.derivedConstructor = outerDerived;
    }
    return { name, superClass, ctor, members, source: this.sourceOf(node), row: rowOf(node) };
  }

  private classMember(member: Node): ClassMember {
    const isStatic = hasChild(member, 'static');
    if (member.type === 'method_definition') {
      const key = this.propertyName(field(member, 'name'));
      checkMemberName(member, key, isStatic, false);
      const kind = accessorOf(member) ?? 'method';
      return { kind, isStatic, key, fn: this.functionNode(member, kind, keyName(key)) };
    }
    if (member.type === 'field_definition') {
      const key = this.propertyName(field(member, 'property'));
      checkMemberName(member, key, isStatic, true);
      const valueNode = member.childForFieldName('value');
      // Field initializers run like method bodies, where `this` is the instance and `super.x` works.
      const value = valueNode
        ? this.withContext(newContext(false, false, true), () => this.expression(valueNode))
        : undefined;
      const fieldMember: ClassMember = { kind: 'field', isStatic, key, value, row: rowOf(member) };
      // As in Java, a static field's constant initializer records no step: it changes nothing learners see.
      const recordsStep = value !== undefined && !(isStatic && isConstantExpression(value));
      return recordsStep ? this.steppable(member, fieldMember) : fieldMember;
    }
    if (member.type === 'class_static_block') return unsupported(member, 'static ブロック');
    return unsupported(member, `クラスの中の「${member.type}」`);
  }
}

/** Whether an expression combines only literals, as a Java constant expression does, so evaluating it has no effect. */
function isConstantExpression(expression: Expression): boolean {
  switch (expression.kind) {
    case 'literal': {
      return true;
    }
    case 'parenthesized': {
      return isConstantExpression(expression.expression);
    }
    case 'unary': {
      return ['-', '+', '!', '~'].includes(expression.operator) && isConstantExpression(expression.argument);
    }
    case 'binary': {
      return (
        !['in', 'instanceof'].includes(expression.operator) &&
        isConstantExpression(expression.left) &&
        isConstantExpression(expression.right)
      );
    }
    case 'logical': {
      return isConstantExpression(expression.left) && isConstantExpression(expression.right);
    }
    case 'conditional': {
      return [expression.test, expression.consequent, expression.alternate].every(isConstantExpression);
    }
    default: {
      return false;
    }
  }
}

/** Whether a `for` header assigns something, which its step shows: an init with a value or an update. */
function recordsHeaderStep(
  init: VariableDeclaration | Expression | undefined,
  update: Expression | undefined
): boolean {
  if (update) return true;
  if (!init) return false;
  return init.kind !== 'declaration' || init.declarators.some((declarator) => declarator.init);
}

/** Rejects the class member names JavaScript reserves: a static `prototype`, and a field named `constructor`. */
function checkMemberName(member: Node, key: PropertyName, isStatic: boolean, isField: boolean): void {
  if (key.kind !== 'key') return;
  if (isStatic && key.key === 'prototype') fail(member, 'static メンバーに prototype という名前は使えません。');
  if (isField && key.key === 'constructor') fail(member, 'フィールドに constructor という名前は使えません。');
}

function isConstructorDefinition(member: Node): boolean {
  if (member.type !== 'method_definition' || hasChild(member, 'static')) return false;
  const name = member.childForFieldName('name');
  return name?.type === 'property_identifier' && name.text === 'constructor';
}
