import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type {
  ArrayInitializer,
  AssignmentOperator,
  BinaryOperator,
  Expression,
  LambdaParameter,
  LiteralValue,
  MethodReference,
  TypeSyntax,
} from './ast';
import { parseHexFloat } from './hexFloat';
import { convertMember, convertVarargsParameter } from './parseDeclarations';
import {
  convertModifiers,
  convertPattern,
  convertType,
  convertVariableType,
  countDimensions,
  field,
  isAnnotation,
  isComment,
  modifiersOf,
  namedChildren,
  span,
  unsupported,
} from './parseNodes';
import { convertBlock, convertSwitchParts } from './parseStatement';
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
  hex_floating_point_literal: convertFloatingPointLiteral,
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
  lambda_expression: convertLambda,
  method_reference: convertMethodReference,
  switch_expression: (node) => ({ kind: 'switchExpression', ...convertSwitchParts(node, true), ...span(node) }),
  class_literal: (node) => {
    const [typeNode] = namedChildren(node);
    const type = typeNode.type === 'void_type' ? undefined : convertType(typeNode);
    return { kind: 'classLiteral', type, ...span(node) };
  },
};

function convertLambda(node: Node): Expression {
  const parametersNode = field(node, 'parameters');
  const bodyNode = field(node, 'body');
  let parameters: LambdaParameter[];
  if (parametersNode.type === 'identifier' || parametersNode.type === 'underscore_pattern') {
    parameters = [{ name: parametersNode.text, type: undefined, isFinal: false, ...span(parametersNode) }];
  } else if (parametersNode.type === 'inferred_parameters') {
    parameters = namedChildren(parametersNode).map((parameter) => ({
      name: parameter.text,
      type: undefined,
      isFinal: false,
      ...span(parameter),
    }));
  } else {
    parameters = namedChildren(parametersNode).map((parameter) => {
      if (parameter.type === 'spread_parameter') {
        const { name, type, isFinal } = convertVarargsParameter(parameter);
        return { name, type, isFinal, ...span(parameter) };
      }
      const typeNode = field(parameter, 'type');
      return {
        name: field(parameter, 'name').text,
        type: typeNode.text === 'var' ? undefined : convertVariableType(parameter),
        isFinal: convertModifiers(modifiersOf(parameter)).isFinal,
        ...span(parameter),
      };
    });
  }
  return {
    kind: 'lambda',
    parameters,
    body: bodyNode.type === 'block' ? convertBlock(bodyNode) : convertExpression(bodyNode),
    ...span(node),
  };
}

const TYPE_NODES = new Set([
  'array_type',
  'generic_type',
  'integral_type',
  'floating_point_type',
  'boolean_type',
  'type_identifier',
  'scoped_type_identifier',
]);

function convertMethodReference(node: Node): Expression {
  const parts = node.children.filter(
    (child): child is Node => !!child && (child.isNamed || child.type === 'new') && !isComment(child)
  );
  const [targetNode] = parts;
  const argumentsNode = parts.find((part) => part.type === 'type_arguments');
  const nameNode = parts.at(-1) as Node;
  const target = convertMethodReferenceTarget(targetNode, parts);
  const typeArgs = argumentsNode && namedChildren(argumentsNode).map((arg) => convertType(arg));
  return {
    kind: 'methodRef',
    target,
    name: nameNode.type === 'new' ? 'new' : nameNode.text,
    ...(typeArgs && { typeArgs }),
    ...span(node),
  };
}

function convertMethodReferenceTarget(targetNode: Node, parts: Node[]): MethodReference['target'] {
  if (targetNode.type === 'super') return { super: undefined };
  if (parts[1]?.type === 'super') return { super: expressionAsTypeSyntax(targetNode) ?? unsupported(targetNode, '式') };
  return TYPE_NODES.has(targetNode.type)
    ? { type: convertType(targetNode) }
    : { expression: convertExpression(targetNode) };
}

function convertIntegerLiteral(node: Node): Expression {
  return { kind: 'literal', literal: parseIntegerLiteral(node), ...span(node) };
}

function convertFloatingPointLiteral(node: Node): Expression {
  const text = node.text.replaceAll('_', '');
  const isFloat = /[fF]$/.test(text);
  const isHex = /^0[xX]/.test(text);
  const value = isHex
    ? (parseHexFloat(text, isFloat ? 'float' : 'double') as number)
    : Number(text.replace(/[dDfF]$/, ''));
  const rounded = isFloat ? Math.fround(value) : value;
  const significand = isHex ? text.slice(2).replace(/[pP].*$/, '') : text.replace(/[eE].*$|[dDfF]$/, '');
  if (!Number.isFinite(rounded) || (rounded === 0 && (isHex ? /[1-9a-fA-F]/ : /[1-9]/).test(significand))) {
    throw new CompileError([
      {
        row: node.startPosition.row,
        message: `浮動小数点数「${node.text}」が ${isFloat ? 'float' : 'double'} 型の範囲を超えています。`,
      },
    ]);
  }
  return {
    kind: 'literal',
    literal: isFloat ? { type: 'float', value: rounded } : { type: 'double', value },
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
  const value = node.text.startsWith('"""')
    ? decodeEscapes(stripIndentation(node.text.slice(3, -3)), node)
    : decodeEscapes(node.text.slice(1, -1), node);
  return { kind: 'literal', literal: { type: 'string', value }, ...span(node) };
}

/**
 * Removes a text block's incidental indentation as `String.stripIndent` does: the content starts after the line break
 * that follows the opening quotes, and the closing quotes on their own line count toward the common indentation.
 */
function stripIndentation(content: string): string {
  const lines = content.replace(/^[ \t\f]*\r?\n/, '').split(/\r\n|\r|\n/);
  const last = lines.at(-1) ?? '';
  const significant = lines.filter((line, index) => line.trim() !== '' || index === lines.length - 1);
  const indentation = Math.min(...significant.map((line) => line.length - line.trimStart().length));
  const stripped = lines.map((line, index) =>
    line.trim() === '' && index !== lines.length - 1 ? '' : line.slice(indentation).replace(/[ \t\f]+$/, '')
  );
  // Closing quotes on their own line end the content with a line break, which the split leaves as an empty last line.
  if (last.trim() === '') stripped[stripped.length - 1] = '';
  return stripped.join('\n');
}

function convertFieldAccess(node: Node): Expression {
  const object = field(node, 'object');
  const name = field(node, 'field');
  if (name.type === 'this') {
    const qualifier = expressionAsTypeSyntax(object);
    if (!qualifier) return unsupported(node, '修飾された this');
    return { kind: 'this', qualifier, ...span(node) };
  }
  // `Outer.super.field` writes the type where the object goes and `super` after it.
  if (node.children.some((child) => child?.type === 'super' && child.startIndex !== object.startIndex)) {
    const superQualifier = expressionAsTypeSyntax(object) ?? unsupported(node, '修飾された super');
    return { kind: 'fieldAccess', object: 'super', superQualifier, name: name.text, ...span(node) };
  }
  return {
    kind: 'fieldAccess',
    object: object.type === 'super' ? 'super' : convertExpression(object),
    name: name.text,
    ...span(node),
  };
}

/** The type that a name or a qualified name such as `Outer.Inner` before `.this` writes. */
function expressionAsTypeSyntax(node: Node): TypeSyntax | undefined {
  if (node.type !== 'identifier' && node.type !== 'field_access') return;
  const names = node.text.split('.').map((part) => part.trim());
  return { kind: 'named', name: names.at(-1) as string, qualifier: names.slice(0, -1), ...span(node) };
}

function convertMethodInvocation(node: Node): Expression {
  const typeArgs = node.childForFieldName('type_arguments');
  const object = node.childForFieldName('object');
  // `Type.super.m()` writes the type where the object goes and `super` after it.
  const superQualifier =
    object && node.children.some((child) => child?.type === 'super' && child.startIndex !== object.startIndex)
      ? expressionAsTypeSyntax(object)
      : undefined;
  if (
    object &&
    !superQualifier &&
    node.children.some((child) => child?.type === 'super' && child.startIndex !== object.startIndex)
  ) {
    unsupported(node, '修飾された super');
  }
  return {
    kind: 'call',
    object: superQualifier
      ? 'super'
      : object
        ? object.type === 'super'
          ? 'super'
          : convertExpression(object)
        : undefined,
    superQualifier,
    name: field(node, 'name').text,
    args: convertArguments(field(node, 'arguments')),
    typeArgs: typeArgs ? namedChildren(typeArgs).map((type) => convertType(type)) : undefined,
    ...span(node),
  };
}

function convertObjectCreation(node: Node): Expression {
  const typeArgs = node.childForFieldName('type_arguments');
  const typeNode = field(node, 'type');
  const parts = namedChildren(node);
  const outerNode = [typeNode, typeArgs].some((child) => child?.startIndex === parts[0]?.startIndex)
    ? undefined
    : parts[0];
  const bodyNode = parts.find((child) => child.type === 'class_body');
  return {
    kind: 'new',
    type: convertType(typeNode),
    args: convertArguments(field(node, 'arguments')),
    ...(typeArgs && { typeArgs: namedChildren(typeArgs).map((type) => convertType(type)) }),
    body: bodyNode ? namedChildren(bodyNode).map((member) => convertMember(member)) : undefined,
    outer: outerNode ? convertExpression(outerNode) : undefined,
    ...span(node),
  };
}

function convertArrayCreation(node: Node): Expression {
  const dimensionLengths: Expression[] = [];
  let extraDimensions = 0;
  for (const dimension of node.childrenForFieldName('dimensions')) {
    if (dimension.type === 'dimensions_expr') {
      const expression = namedChildren(dimension).find((child) => !isAnnotation(child)) as Node;
      dimensionLengths.push(convertExpression(expression));
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
  const patternNode = node.childForFieldName('pattern');
  const pattern = patternNode ? convertPattern(patternNode) : undefined;
  const name = node.childForFieldName('name');
  return {
    kind: 'instanceOf',
    value: convertExpression(field(node, 'left')),
    type: pattern?.kind === 'recordPattern' ? pattern.type : convertType(field(node, 'right')),
    pattern: pattern?.kind === 'recordPattern' ? pattern : undefined,
    binding: name
      ? { name: name.text, isFinal: node.children.some((child) => child?.type === 'final'), ...span(name) }
      : undefined,
    ...span(node),
  };
}

function parseIntegerLiteral(node: Node): LiteralValue {
  const isLong = /[lL]$/.test(node.text);
  const text = node.text.replaceAll('_', '').replace(/[lL]$/, '');
  const value = node.type === 'octal_integer_literal' ? BigInt(`0o${text.slice(1)}`) : BigInt(text);
  const isDecimal = node.type === 'decimal_integer_literal';
  const bits = isLong ? 64 : 32;
  // A decimal literal may only reach 2^31 (or 2^63) as the operand of unary minus, which the compiler verifies.
  const limit = isDecimal ? 2n ** BigInt(bits - 1) : 2n ** BigInt(bits) - 1n;
  if (value > limit) {
    throw new CompileError([
      {
        row: node.startPosition.row,
        message: `整数「${node.text}」が ${isLong ? 'long' : 'int'} 型の範囲を超えています。`,
      },
    ]);
  }
  if (isLong) return { type: 'long', value: isDecimal ? value : BigInt.asIntN(64, value) };
  return { type: 'int', value: isDecimal ? Number(value) : Number(BigInt.asIntN(32, value)) };
}

const simpleEscapes: Record<string, string> = {
  // A backslash before a line break joins the lines of a text block.
  '\n': '',
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
  return text.replaceAll(/\\(u+[\dA-Fa-f]{4}|[0-7]{1,3}|.)/gs, (_, escape: string) => {
    if (escape.startsWith('u') && escape.length > 1) return String.fromCodePoint(Number.parseInt(escape.slice(-4), 16));
    if (/^[0-7]/.test(escape)) return String.fromCodePoint(Number.parseInt(escape, 8));
    const decoded = simpleEscapes[escape];
    if (decoded === undefined) unsupported(node, `エスケープ「\\${escape}」`);
    return decoded;
  });
}
