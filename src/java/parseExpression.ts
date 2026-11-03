import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { ArrayInitializer, AssignmentOperator, BinaryOperator, Expression, LiteralValue } from './ast';
import { convertType, countDimensions, field, namedChildren, span, unsupported } from './parseNodes';
import { charCodeOf } from './values';

export function convertExpression(node: Node): Expression {
  if (!Object.hasOwn(expressionConverters, node.type)) return unsupported(node, `式「${node.text}」`);
  return expressionConverters[node.type](node);
}

export function convertArguments(node: Node): Expression[] {
  return namedChildren(node).map((argument) => convertExpression(argument));
}

export function convertArrayInitializer(node: Node): ArrayInitializer {
  return {
    kind: 'arrayInitializer',
    elements: namedChildren(node).map((element) =>
      element.type === 'array_initializer' ? convertArrayInitializer(element) : convertExpression(element)
    ),
    ...span(node),
  };
}

const expressionConverters: Record<string, (node: Node) => Expression> = {
  parenthesized_expression: (node) => convertExpression(namedChildren(node)[0]),
  decimal_integer_literal: convertIntegerLiteral,
  hex_integer_literal: convertIntegerLiteral,
  octal_integer_literal: convertIntegerLiteral,
  binary_integer_literal: convertIntegerLiteral,
  decimal_floating_point_literal: convertFloatingPointLiteral,
  hex_floating_point_literal: (node) => unsupported(node, '16進数の浮動小数点数'),
  true: convertBooleanLiteral,
  false: convertBooleanLiteral,
  null_literal: (node) => ({ kind: 'literal', literal: { type: 'null' }, ...span(node) }),
  character_literal: convertCharacterLiteral,
  string_literal: convertStringLiteral,
  identifier: (node) => ({ kind: 'name', name: node.text, ...span(node) }),
  this: (node) => ({ kind: 'this', ...span(node) }),
  field_access: convertFieldAccess,
  array_access: (node) => ({
    kind: 'arrayAccess',
    array: convertExpression(field(node, 'array')),
    index: convertExpression(field(node, 'index')),
    ...span(node),
  }),
  method_invocation: convertMethodInvocation,
  object_creation_expression: convertObjectCreation,
  array_creation_expression: convertArrayCreation,
  assignment_expression: (node) => ({
    kind: 'assign',
    operator: field(node, 'operator').text as AssignmentOperator,
    target: convertExpression(field(node, 'left')),
    value: convertExpression(field(node, 'right')),
    ...span(node),
  }),
  update_expression: convertUpdate,
  binary_expression: (node) => ({
    kind: 'binary',
    operator: field(node, 'operator').text as BinaryOperator,
    left: convertExpression(field(node, 'left')),
    right: convertExpression(field(node, 'right')),
    ...span(node),
  }),
  unary_expression: (node) => ({
    kind: 'unary',
    operator: field(node, 'operator').text as '!' | '-' | '+' | '~',
    operand: convertExpression(field(node, 'operand')),
    ...span(node),
  }),
  ternary_expression: (node) => ({
    kind: 'conditional',
    condition: convertExpression(field(node, 'condition')),
    consequence: convertExpression(field(node, 'consequence')),
    alternative: convertExpression(field(node, 'alternative')),
    ...span(node),
  }),
  cast_expression: convertCast,
  instanceof_expression: convertInstanceOf,
  lambda_expression: (node) => unsupported(node, 'ラムダ式'),
  method_reference: (node) => unsupported(node, 'メソッド参照'),
  switch_expression: (node) => unsupported(node, 'switch 式'),
  class_literal: (node) => unsupported(node, 'クラスリテラル'),
};

function convertIntegerLiteral(node: Node): Expression {
  return { kind: 'literal', literal: parseIntegerLiteral(node), ...span(node) };
}

function convertFloatingPointLiteral(node: Node): Expression {
  if (/[fF]$/.test(node.text)) unsupported(node, 'float 型');
  return {
    kind: 'literal',
    literal: { type: 'double', value: Number(node.text.replaceAll('_', '').replace(/[dD]$/, '')) },
    ...span(node),
  };
}

function convertBooleanLiteral(node: Node): Expression {
  return { kind: 'literal', literal: { type: 'boolean', value: node.type === 'true' }, ...span(node) };
}

function convertCharacterLiteral(node: Node): Expression {
  const value = decodeEscapes(node.text.slice(1, -1), node);
  if (value.length !== 1) unsupported(node, `文字「${node.text}」`);
  return { kind: 'literal', literal: { type: 'char', value: charCodeOf(value, 0) }, ...span(node) };
}

function convertStringLiteral(node: Node): Expression {
  if (node.text.startsWith('"""')) unsupported(node, 'テキストブロック');
  return {
    kind: 'literal',
    literal: { type: 'string', value: decodeEscapes(node.text.slice(1, -1), node) },
    ...span(node),
  };
}

function convertFieldAccess(node: Node): Expression {
  const object = field(node, 'object');
  const name = field(node, 'field');
  if (name.type === 'this') unsupported(node, '修飾された this');
  if (node.children.filter((child) => child?.type === 'super').length > (object.type === 'super' ? 1 : 0))
    unsupported(node, '修飾された super');
  return {
    kind: 'fieldAccess',
    object: object.type === 'super' ? 'super' : convertExpression(object),
    name: name.text,
    ...span(node),
  };
}

function convertMethodInvocation(node: Node): Expression {
  if (node.childForFieldName('type_arguments')) unsupported(node, '型引数');
  const object = node.childForFieldName('object');
  if (node.children.some((child) => child?.type === 'super' && child.startIndex !== object?.startIndex))
    unsupported(node, '修飾された super');
  return {
    kind: 'call',
    object: object ? (object.type === 'super' ? 'super' : convertExpression(object)) : undefined,
    name: field(node, 'name').text,
    args: convertArguments(field(node, 'arguments')),
    ...span(node),
  };
}

function convertObjectCreation(node: Node): Expression {
  if (node.childForFieldName('type_arguments')) unsupported(node, '型引数');
  if (namedChildren(node).some((child) => child.type === 'class_body')) unsupported(node, '匿名クラス');
  if (namedChildren(node)[0]?.startIndex !== field(node, 'type').startIndex) unsupported(node, '修飾された new');
  return {
    kind: 'new',
    type: convertType(field(node, 'type')),
    args: convertArguments(field(node, 'arguments')),
    ...span(node),
  };
}

function convertArrayCreation(node: Node): Expression {
  const dimensionLengths: Expression[] = [];
  let extraDimensions = 0;
  for (const dimension of node.childrenForFieldName('dimensions')) {
    if (dimension.type === 'dimensions_expr') {
      const expressions = namedChildren(dimension);
      if (expressions.length !== 1) unsupported(dimension, '配列の次元へのアノテーション');
      dimensionLengths.push(convertExpression(expressions[0]));
    } else {
      extraDimensions += countDimensions(dimension);
    }
  }
  const value = node.childForFieldName('value');
  return {
    kind: 'newArray',
    elementType: convertType(field(node, 'type')),
    dimensionLengths,
    extraDimensions,
    initializer: value ? convertArrayInitializer(value) : undefined,
    ...span(node),
  };
}

function convertUpdate(node: Node): Expression {
  const operand = namedChildren(node)[0];
  const operator = node.children.find((child) => child?.type === '++' || child?.type === '--');
  if (!operator) throw new Error('An update expression without its operator');
  return {
    kind: 'update',
    operator: operator.type as '++' | '--',
    isPrefix: operator.startIndex < operand.startIndex,
    target: convertExpression(operand),
    ...span(node),
  };
}

function convertCast(node: Node): Expression {
  const types = node.childrenForFieldName('type');
  if (types.length !== 1) unsupported(node, '交差型へのキャスト');
  return {
    kind: 'cast',
    type: convertType(types[0]),
    value: convertExpression(field(node, 'value')),
    ...span(node),
  };
}

function convertInstanceOf(node: Node): Expression {
  if (node.childForFieldName('name') || node.childForFieldName('pattern')) unsupported(node, 'パターンマッチング');
  return {
    kind: 'instanceOf',
    value: convertExpression(field(node, 'left')),
    type: convertType(field(node, 'right')),
    ...span(node),
  };
}

function parseIntegerLiteral(node: Node): LiteralValue {
  const text = node.text.replaceAll('_', '');
  if (/[lL]$/.test(text)) unsupported(node, 'long 型');
  const value = node.type === 'octal_integer_literal' ? BigInt(`0o${text.slice(1)}`) : BigInt(text);
  const isDecimal = node.type === 'decimal_integer_literal';
  // A decimal literal may only reach 2^31 as the operand of unary minus, which the checker verifies.
  const limit = isDecimal ? 2n ** 31n : 2n ** 32n - 1n;
  if (value > limit) {
    throw new CompileError([
      {
        row: node.startPosition.row,
        message: `整数「${node.text}」が int 型の範囲を超えています。`,
      },
    ]);
  }
  return { type: 'int', value: isDecimal ? Number(value) : Number(BigInt.asIntN(32, value)) };
}

const simpleEscapes: Record<string, string> = {
  b: '\b',
  s: ' ',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  "'": "'",
  '\\': '\\',
};

function decodeEscapes(text: string, node: Node): string {
  return text.replaceAll(/\\([0-7]{1,3}|.)/gs, (_, escape: string) => {
    if (/^[0-7]/.test(escape)) return String.fromCodePoint(Number.parseInt(escape, 8));
    const decoded = simpleEscapes[escape];
    if (decoded === undefined) unsupported(node, `エスケープ「\\${escape}」`);
    return decoded;
  });
}
