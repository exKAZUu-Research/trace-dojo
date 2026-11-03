import type { Node } from '@willbooster/web-tree-sitter';

import type {
  Block,
  CatchClause,
  Expression,
  ExpressionStatement,
  LocalVariableDeclaration,
  Statement,
  SwitchGroup,
  VariableDeclarator,
} from './ast';
import { convertArrayInitializer, convertExpression } from './parseExpression';
import {
  convertModifiers,
  convertType,
  convertVariableType,
  countDimensions,
  field,
  identifierOf,
  modifiersOf,
  namedChildren,
  span,
  unsupported,
} from './parseNodes';

export function convertStatement(node: Node): Statement {
  if (!Object.hasOwn(statementConverters, node.type)) return unsupported(node, `文「${node.type}」`);
  return statementConverters[node.type](node);
}

export function convertBlock(node: Node): Block {
  if (node.type !== 'block') return unsupported(node, '文');
  return {
    kind: 'block',
    statements: namedChildren(node).map((child) => convertStatement(child)),
    ...span(node),
  };
}

export function convertDeclarator(node: Node): VariableDeclarator {
  const name = identifierOf(node, '名前のない変数');
  const dimensions = node.childForFieldName('dimensions');
  const value = node.childForFieldName('value');
  return {
    name: name.text,
    extraDimensions: dimensions ? countDimensions(dimensions) : 0,
    initializer: value ? convertInitializer(value) : undefined,
    ...span(node),
  };
}

function convertInitializer(value: Node): VariableDeclarator['initializer'] {
  return value.type === 'array_initializer' ? convertArrayInitializer(value) : convertExpression(value);
}

const unsupportedDeclaration = (node: Node): never => unsupported(node, 'メソッドの中で宣言するクラス');

const statementConverters: Record<string, (node: Node) => Statement> = {
  block: convertBlock,
  local_variable_declaration: convertLocal,
  expression_statement: (node) => ({
    kind: 'expression',
    expression: convertExpression(namedChildren(node)[0]),
    ...span(node),
  }),
  if_statement: convertIf,
  while_statement: (node) => ({
    kind: 'while',
    condition: convertCondition(field(node, 'condition')),
    body: convertStatement(field(node, 'body')),
    ...span(node),
  }),
  do_statement: (node) => ({
    kind: 'do',
    body: convertStatement(field(node, 'body')),
    condition: convertCondition(field(node, 'condition')),
    ...span(node),
  }),
  for_statement: convertFor,
  enhanced_for_statement: convertForEach,
  switch_expression: convertSwitch,
  break_statement: convertJump,
  continue_statement: convertJump,
  return_statement: (node) => {
    const value = namedChildren(node)[0] as Node | undefined;
    return { kind: 'return', value: value ? convertExpression(value) : undefined, ...span(node) };
  },
  throw_statement: (node) => ({ kind: 'throw', value: convertExpression(namedChildren(node)[0]), ...span(node) }),
  try_statement: convertTry,
  try_with_resources_statement: (node) => unsupported(node, 'try-with-resources 文'),
  labeled_statement: (node) => {
    const [label, body] = namedChildren(node);
    return { kind: 'labeled', label: label.text, body: convertStatement(body), ...span(node) };
  },
  ';': (node) => ({ kind: 'empty', ...span(node) }),
  class_declaration: unsupportedDeclaration,
  interface_declaration: unsupportedDeclaration,
  record_declaration: unsupportedDeclaration,
  enum_declaration: unsupportedDeclaration,
};

function convertLocal(node: Node): LocalVariableDeclaration {
  const modifiers = convertModifiers(modifiersOf(node));
  if (modifiers.isStatic || modifiers.isAbstract || modifiers.access !== 'package')
    unsupported(node, 'ローカル変数への修飾子');
  return {
    kind: 'local',
    isFinal: modifiers.isFinal,
    type: convertType(field(node, 'type')),
    declarators: node.childrenForFieldName('declarator').map((declarator) => convertDeclarator(declarator)),
    ...span(node),
  };
}

function convertIf(node: Node): Statement {
  const alternative = node.childForFieldName('alternative');
  return {
    kind: 'if',
    condition: convertCondition(field(node, 'condition')),
    consequence: convertStatement(field(node, 'consequence')),
    alternative: alternative ? convertStatement(alternative) : undefined,
    ...span(node),
  };
}

function convertFor(node: Node): Statement {
  const initNodes = node.childrenForFieldName('init');
  const condition = node.childForFieldName('condition');
  return {
    kind: 'for',
    init:
      initNodes.length === 1 && initNodes[0].type === 'local_variable_declaration'
        ? convertLocal(initNodes[0])
        : initNodes.map((init) => convertExpressionStatement(init)),
    condition: condition ? convertExpression(condition) : undefined,
    update: node.childrenForFieldName('update').map((update) => convertExpressionStatement(update)),
    body: convertStatement(field(node, 'body')),
    ...span(node),
  };
}

function convertForEach(node: Node): Statement {
  const modifiers = convertModifiers(modifiersOf(node));
  const name = identifierOf(node, '名前のない変数');
  return {
    kind: 'forEach',
    isFinal: modifiers.isFinal,
    type: convertVariableType(node),
    name: name.text,
    variable: span(name),
    iterable: convertExpression(field(node, 'value')),
    body: convertStatement(field(node, 'body')),
    ...span(node),
  };
}

function convertSwitch(node: Node): Statement {
  const groupNodes = namedChildren(field(node, 'body'));
  const groups = groupNodes.map((groupNode) => convertSwitchGroup(groupNode));
  return {
    kind: 'switch',
    selector: convertCondition(field(node, 'condition')),
    isArrowForm: groupNodes.some((groupNode) => groupNode.type === 'switch_rule'),
    groups,
    ...span(node),
  };
}

function convertSwitchGroup(groupNode: Node): SwitchGroup {
  const labels: (Expression | undefined)[] = [];
  const statements: Statement[] = [];
  for (const child of namedChildren(groupNode)) {
    if (child.type === 'switch_label') labels.push(...convertSwitchLabel(child));
    else statements.push(convertStatement(child));
  }
  return { labels, statements, ...span(groupNode) };
}

/** `undefined` stands for `default`. */
function convertSwitchLabel(label: Node): (Expression | undefined)[] {
  const values = namedChildren(label);
  if (values.length === 0) return [undefined];
  return values.map((value) => {
    if (value.type === 'pattern' || value.type === 'guard') unsupported(value, 'パターンマッチング');
    return convertExpression(value);
  });
}

function convertJump(node: Node): Statement {
  const label = namedChildren(node).find((child) => child.type === 'identifier');
  return {
    kind: node.type === 'break_statement' ? 'break' : 'continue',
    label: label?.text,
    ...span(node),
  };
}

function convertTry(node: Node): Statement {
  const catches: CatchClause[] = [];
  let finallyBlock: Block | undefined;
  for (const child of namedChildren(node)) {
    if (child.type === 'catch_clause') catches.push(convertCatch(child));
    else if (child.type === 'finally_clause') finallyBlock = convertBlock(namedChildren(child)[0]);
  }
  return {
    kind: 'try',
    body: convertBlock(field(node, 'body')),
    catches,
    finallyBlock,
    ...span(node),
  };
}

function convertCatch(clause: Node): CatchClause {
  const parameter = namedChildren(clause).find((part) => part.type === 'catch_formal_parameter');
  if (!parameter) throw new Error('A catch clause without its parameter');
  if (parameter.childForFieldName('dimensions')) unsupported(parameter, 'catch の配列');
  const catchType = namedChildren(parameter).find((part) => part.type === 'catch_type');
  const name = identifierOf(parameter, '名前のない変数');
  return {
    types: catchType ? namedChildren(catchType).map((type) => convertType(type)) : [],
    name: name.text,
    body: convertBlock(field(clause, 'body')),
    ...span(clause),
  };
}

function convertExpressionStatement(node: Node): ExpressionStatement {
  return { kind: 'expression', expression: convertExpression(node), ...span(node) };
}

function convertCondition(node: Node): Expression {
  return convertExpression(namedChildren(node)[0]);
}
