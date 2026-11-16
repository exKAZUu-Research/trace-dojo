import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type {
  AssignOperator,
  BinaryOperator,
  Block,
  Capture,
  Container,
  ContainerField,
  ContainerMember,
  DestructureTarget,
  Expression,
  FieldInit,
  ForOperand,
  FunctionDeclaration,
  Label,
  Parameter,
  SourceFile,
  Span,
  Statement,
  SwitchCase,
  SwitchItem,
  UnaryOperator,
  VariableDeclaration,
} from './ast';
import { decodeCharacter, decodeIdentifier, decodeString, parseFloatText, parseIntegerText } from './literals';

/** Converts tree-sitter's tree of a file into the AST, rejecting the syntax this grader does not run. */
export function convertFile(root: Node): SourceFile {
  const { members, fields } = containerMembers(root);
  return { members, fields };
}

/** The keyword tokens that stand for values where an expression is expected. */
const KEYWORD_VALUES = new Set(['null', 'undefined', 'unreachable', 'anyframe']);

function spanOf(node: Node): Span {
  return {
    row: node.startPosition.row,
    col: node.startPosition.column,
    endRow: node.endPosition.row,
  };
}

function fail(node: Node, message: string): never {
  throw new CompileError([{ row: node.startPosition.row, message }]);
}

export function unavailable(node: Node, what: string): never {
  fail(node, `${what}は、この採点環境では使えません。`);
}

/** The children that stand for expressions: named nodes other than comments, and keyword values such as `null`. */
function expressionChildren(node: Node): Node[] {
  return node.children.filter((child) => isExpressionNode(child));
}

function isExpressionNode(child: Node): boolean {
  if (child.isNamed) return !isComment(child);
  return KEYWORD_VALUES.has(child.type);
}

function isComment(node: Node): boolean {
  return node.type === 'comment' || node.type === 'doc_comment' || node.type === 'container_doc_comment';
}

function hasToken(node: Node, token: string): boolean {
  return node.children.some((child) => !child.isNamed && child.type === token);
}

// Containers ----------------------------------------------------------------------------------------------------------

function containerMembers(node: Node): { members: ContainerMember[]; fields: ContainerField[] } {
  const members: ContainerMember[] = [];
  const fields: ContainerField[] = [];
  for (const child of node.namedChildren) {
    switch (child.type) {
      case 'function_declaration': {
        members.push(functionDeclaration(child));
        break;
      }
      case 'variable_declaration': {
        members.push(containerVariable(child));
        break;
      }
      case 'container_field': {
        fields.push(containerField(child));
        break;
      }
      case 'test_declaration': {
        unavailable(child, 'test 宣言');
        break;
      }
      case 'comptime_declaration': {
        unavailable(child, 'comptime');
        break;
      }
      default: {
        if (!isComment(child)) fail(child, '書き方に誤りがあります。');
      }
    }
  }
  return { members, fields };
}

function rejectDeclarationModifiers(node: Node): void {
  for (const child of node.children) {
    if (child.isNamed) continue;
    if (child.type === 'export') unavailable(child, 'export');
    if (child.type === 'extern') unavailable(child, 'extern');
    if (child.type === 'threadlocal') unavailable(child, 'threadlocal');
    if (child.type === 'noinline') unavailable(child, 'noinline');
  }
}

function rejectAttributes(node: Node): void {
  for (const child of node.namedChildren) {
    if (child.type === 'byte_alignment') unavailable(child, 'align による整列の指定');
    if (child.type === 'address_space') unavailable(child, 'addrspace');
    if (child.type === 'link_section') unavailable(child, 'linksection');
    if (child.type === 'calling_convention') unavailable(child, 'callconv');
  }
}

function functionDeclaration(node: Node): FunctionDeclaration {
  rejectDeclarationModifiers(node);
  rejectAttributes(node);
  const nameNode = node.childForFieldName('name');
  const body = node.childForFieldName('body');
  if (!nameNode) fail(node, '関数の名前がありません。');
  if (!body) unavailable(node, '本体のない関数の宣言');
  const { returnType, inferredErrorSet } = returnTypeOf(node);
  return {
    kind: 'fn',
    ...spanOf(node),
    name: decodeIdentifier(nameNode),
    isPub: hasToken(node, 'pub'),
    isInline: hasToken(node, 'inline'),
    params: parameters(node.childForFieldName('parameters') as Node),
    returnType,
    inferredErrorSet,
    body: block(body),
    bodyRow: body.startPosition.row,
  };
}

function returnTypeOf(node: Node): { returnType: Expression; inferredErrorSet: boolean } {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) fail(node, '戻り値の型がありません。');
  // `!T` is an error union whose left operand is missing.
  if (typeNode.type === 'error_union_type' && !typeNode.childForFieldName('error')) {
    const ok = typeNode.childForFieldName('ok');
    if (!ok) fail(typeNode, '戻り値の型がありません。');
    return { returnType: typeExpression(ok), inferredErrorSet: true };
  }
  return { returnType: typeExpression(typeNode), inferredErrorSet: false };
}

function parameters(node: Node): Parameter[] {
  return node.namedChildren
    .filter((child) => child.type === 'parameter')
    .map((child) => {
      if (hasToken(child, 'comptime')) unavailable(child, 'comptime の引数');
      if (hasToken(child, 'noalias')) unavailable(child, 'noalias');
      if (hasToken(child, '...')) unavailable(child, '可変個の引数（...）');
      const nameNode = child.childForFieldName('name');
      const typeNode = child.childForFieldName('type');
      if (!typeNode) fail(child, '引数の型がありません。');
      const isAnytype = typeNode.type === 'builtin_type' && typeNode.text === 'anytype';
      return {
        ...spanOf(child),
        name: nameNode ? decodeIdentifier(nameNode) : '_',
        type: isAnytype ? undefined : typeExpression(typeNode),
      };
    });
}

function containerVariable(node: Node): VariableDeclaration {
  rejectDeclarationModifiers(node);
  rejectAttributes(node);
  const declaration = variableHeader(node);
  if (!declaration) fail(node, '書き方に誤りがあります。');
  return declaration;
}

/** A declaration `const x: T = v;`, or undefined for a statement that assigns (tree-sitter calls both alike). */
function variableHeader(node: Node): VariableDeclaration | undefined {
  const keyword = node.children.find((child) => child.type === 'const' || child.type === 'var');
  if (!keyword) return undefined;
  const nameNode = node.namedChildren.find((child) => child.type === 'identifier');
  if (!nameNode) fail(node, '名前がありません。');
  const typeNode = node.childForFieldName('type');
  const equals = node.children.findIndex((child) => child.type === '=');
  const valueNode = equals === -1 ? undefined : node.children.slice(equals + 1).find((c) => isExpressionNode(c));
  return {
    kind: 'var',
    ...spanOf(node),
    name: decodeIdentifier(nameNode),
    isConst: keyword.type === 'const',
    isPub: hasToken(node, 'pub'),
    type: typeNode ? typeExpression(typeNode) : undefined,
    value: valueNode ? expression(valueNode) : undefined,
  };
}

function containerField(node: Node): ContainerField {
  if (hasToken(node, 'comptime')) unavailable(node, 'comptime のフィールド');
  rejectAttributes(node);
  const nameNode = node.childForFieldName('name');
  const typeNode = node.childForFieldName('type');
  const equals = node.children.findIndex((child) => child.type === '=');
  const valueNode = equals === -1 ? undefined : node.children.slice(equals + 1).find((c) => isExpressionNode(c));
  const value = valueNode ? expression(valueNode) : undefined;
  if (typeNode && nameNode) {
    return {
      ...spanOf(node),
      name: decodeIdentifier(nameNode),
      type: typeExpression(typeNode),
      value,
    };
  }
  if (!nameNode) fail(node, '書き方に誤りがあります。');
  // A bare name is an enum's or a union's field, or the type of a tuple's field; the container decides which.
  if (nameNode.type === 'identifier') return { ...spanOf(node), name: decodeIdentifier(nameNode), value };
  return { ...spanOf(node), type: typeExpression(nameNode), value };
}

function container(node: Node): Container {
  if (node.type === 'opaque_declaration') unavailable(node, 'opaque 型');
  const containerKind =
    node.type === 'struct_declaration' ? 'struct' : node.type === 'enum_declaration' ? 'enum' : 'union';
  const layout = hasToken(node, 'extern') ? 'extern' : hasToken(node, 'packed') ? 'packed' : 'auto';
  // `union(enum)` holds the keyword `enum`, and `union(enum(u8))` an argument after it.
  const children = node.children;
  const brace = children.findIndex((child) => child.type === '{');
  const header = children.slice(0, brace);
  const taggedByEnum = containerKind === 'union' && header.some((child) => child.type === 'enum');
  const argumentNode = header.find((child) => isExpressionNode(child));
  const body = children.slice(brace + 1);
  const members: ContainerMember[] = [];
  const fields: ContainerField[] = [];
  for (const child of body) {
    if (!child.isNamed || isComment(child)) continue;
    if (child.type === 'function_declaration') members.push(functionDeclaration(child));
    else if (child.type === 'variable_declaration') members.push(containerVariable(child));
    else if (child.type === 'container_field') fields.push(containerField(child));
    else if (child.type === 'test_declaration') unavailable(child, 'test 宣言');
    else if (child.type === 'comptime_declaration') unavailable(child, 'comptime');
    else fail(child, '書き方に誤りがあります。');
  }
  return {
    kind: 'container',
    ...spanOf(node),
    containerKind,
    layout,
    argument: argumentNode ? expression(argumentNode) : undefined,
    taggedByEnum,
    fields,
    members,
  };
}

// Statements ----------------------------------------------------------------------------------------------------------

function block(node: Node): Block {
  return { kind: 'block', ...spanOf(node), statements: statements(node) };
}

function statements(node: Node): Statement[] {
  return node.namedChildren.filter((child) => !isComment(child)).map((child) => statement(child));
}

function statement(node: Node): Statement {
  switch (node.type) {
    case 'variable_declaration': {
      return variableStatement(node);
    }
    case 'expression_statement': {
      return { kind: 'expression', ...spanOf(node), expression: expressionStatementBody(node) };
    }
    case 'defer_statement':
    case 'errdefer_statement': {
      const capture = node.namedChildren.find((child) => child.type === 'payload');
      const captures = capture ? payload(capture) : [];
      return {
        kind: 'defer',
        ...spanOf(node),
        isErrdefer: node.type === 'errdefer_statement',
        capture: captures[0],
        body: deferBody(node),
      };
    }
    case 'comptime_statement': {
      unavailable(node, 'comptime');
      break;
    }
    case 'nosuspend_statement': {
      unavailable(node, 'nosuspend');
      break;
    }
    case 'suspend_statement': {
      unavailable(node, 'suspend');
      break;
    }
    default: {
      return { kind: 'expression', ...spanOf(node), expression: expression(node) };
    }
  }
  return fail(node, '書き方に誤りがあります。');
}

function deferBody(node: Node): Expression {
  const body = node.namedChildren.filter((child) => child.type !== 'payload' && !isComment(child));
  const label = body.find((child) => child.type === 'block_label');
  const blockNode = body.find((child) => child.type === 'block');
  if (blockNode) {
    return {
      kind: 'block',
      ...spanOf(blockNode),
      label: label ? blockLabel(label) : undefined,
      statements: statements(blockNode),
    };
  }
  const statementNode = body.find((child) => child.type === 'expression_statement');
  if (!statementNode) fail(node, '書き方に誤りがあります。');
  return expressionStatementBody(statementNode);
}

function expressionStatementBody(node: Node): Expression {
  const inner = expressionChildren(node)[0];
  if (!inner) fail(node, '書き方に誤りがあります。');
  return expression(inner);
}

function variableStatement(node: Node): Statement {
  rejectDeclarationModifiers(node);
  rejectAttributes(node);
  const equals = node.children.findIndex((child) => child.type === '=');
  const commas = node.children.filter((child) => child.type === ',');
  if (
    commas.length > 0 &&
    (equals === -1 || commas.some((comma) => comma.startIndex < node.children[equals].startIndex))
  ) {
    return destructure(node, equals);
  }
  const declaration = variableHeader(node);
  if (declaration) return declaration;
  // `target op value;`
  const operatorIndex = node.children.findIndex((child) => !child.isNamed && ASSIGN_OPERATORS.has(child.type));
  const parts = expressionChildren(node);
  if (operatorIndex === -1 || parts.length !== 2) fail(node, '書き方に誤りがあります。');
  return {
    kind: 'expression',
    ...spanOf(node),
    expression: {
      kind: 'assign',
      ...spanOf(node),
      operator: node.children[operatorIndex].type as AssignOperator,
      targets: [expression(parts[0])],
      value: expression(parts[1]),
    },
  };
}

const ASSIGN_OPERATORS = new Set<string>([
  '=',
  '*=',
  '*%=',
  '*|=',
  '/=',
  '%=',
  '+=',
  '+%=',
  '+|=',
  '-=',
  '-%=',
  '-|=',
  '<<=',
  '<<|=',
  '>>=',
  '&=',
  '^=',
  '|=',
]);

/** `const a, var b, c.x = value;`: the parts before `=`, separated by commas, then the value. */
function destructure(node: Node, equals: number): Statement {
  const before = node.children.slice(0, equals);
  const after = node.children.slice(equals + 1);
  const targets: DestructureTarget[] = [];
  let current: Node[] = [];
  const flush = (): void => {
    if (current.length === 0) fail(node, '書き方に誤りがあります。');
    const keyword = current.find((child) => child.type === 'const' || child.type === 'var');
    const first = current[0];
    if (keyword) {
      const nameNode = current.find((child) => child.type === 'identifier');
      if (!nameNode) fail(node, '名前がありません。');
      const colon = current.findIndex((child) => child.type === ':');
      const typeNode = colon === -1 ? undefined : current.slice(colon + 1).find((c) => isExpressionNode(c));
      targets.push({
        ...spanOf(first),
        declaration: {
          name: decodeIdentifier(nameNode),
          isConst: keyword.type === 'const',
          type: typeNode ? typeExpression(typeNode) : undefined,
        },
      });
    } else {
      const targetNode = current.find((c) => isExpressionNode(c));
      if (!targetNode) fail(node, '書き方に誤りがあります。');
      targets.push({ ...spanOf(targetNode), target: expression(targetNode) });
    }
    current = [];
  };
  for (const child of before) {
    if (child.type === ',') flush();
    else current.push(child);
  }
  flush();
  const valueNode = after.find((c) => isExpressionNode(c));
  if (!valueNode) fail(node, '書き方に誤りがあります。');
  return { kind: 'destructure', ...spanOf(node), targets, value: expression(valueNode) };
}

// Expressions ---------------------------------------------------------------------------------------------------------

function typeExpression(node: Node): Expression {
  if (node.type === 'if_type_expression') unavailable(node, '型の位置の if 式');
  if (node.type === 'comptime_type_expression') unavailable(node, 'comptime');
  return expression(node);
}

// code-gauge-allow functionCognitiveComplexity 40 -- One case per kind of syntax node.
// code-gauge-allow functionNcss 120 -- One case per kind of syntax node.
export function expression(node: Node): Expression {
  const span = spanOf(node);
  if (!node.isNamed) {
    switch (node.type) {
      case 'null': {
        return { kind: 'null', ...span };
      }
      case 'undefined': {
        return { kind: 'undefined', ...span };
      }
      case 'unreachable': {
        return { kind: 'unreachable', ...span };
      }
      case 'anyframe': {
        unavailable(node, 'anyframe');
        break;
      }
      default: {
        fail(node, '書き方に誤りがあります。');
      }
    }
  }
  switch (node.type) {
    case 'integer': {
      return { kind: 'integer', ...span, value: parseIntegerText(node.text, node) };
    }
    case 'float': {
      parseFloatText(node.text, node);
      return { kind: 'float', ...span, text: node.text };
    }
    case 'character': {
      return { kind: 'character', ...span, value: decodeCharacter(node) };
    }
    case 'string': {
      return { kind: 'string', ...span, bytes: decodeString(node) };
    }
    case 'multiline_string': {
      unavailable(node, String.raw`複数行の文字列リテラル（\\）`);
      break;
    }
    case 'boolean': {
      return { kind: 'bool', ...span, value: node.text === 'true' };
    }
    case 'identifier': {
      return { kind: 'identifier', ...span, name: decodeIdentifier(node) };
    }
    case 'builtin_type': {
      return { kind: 'builtinType', ...span, name: node.text };
    }
    case 'parenthesized_expression': {
      return { kind: 'paren', ...span, operand: onlyChild(node) };
    }
    case 'field_expression': {
      const member = node.childForFieldName('member') as Node;
      const object = node.childForFieldName('object');
      if (!object) return { kind: 'enumLiteral', ...span, name: decodeIdentifier(member) };
      return { kind: 'field', ...span, object: expression(object), name: decodeIdentifier(member) };
    }
    case 'error_type': {
      const name = node.namedChildren.find((child) => child.type === 'identifier') as Node;
      return { kind: 'errorValue', ...span, name: decodeIdentifier(name) };
    }
    case 'index_expression': {
      return indexExpression(node, span);
    }
    case 'dereference_expression': {
      return { kind: 'deref', ...span, operand: onlyChild(node) };
    }
    case 'null_coercion_expression': {
      return { kind: 'unwrap', ...span, operand: onlyChild(node) };
    }
    case 'call_expression': {
      const callee = node.childForFieldName('function') as Node;
      const args = expressionChildren(node).filter((child) => child.id !== callee.id);
      return {
        kind: 'call',
        ...span,
        callee: expression(callee),
        args: args.map((arg) => expression(arg)),
      };
    }
    case 'builtin_function': {
      const name = (node.namedChildren.find((child) => child.type === 'builtin_identifier') as Node).text;
      const argsNode = node.namedChildren.find((child) => child.type === 'arguments');
      const args = argsNode ? expressionChildren(argsNode) : [];
      return { kind: 'builtinCall', ...span, name, args: args.map((arg) => expression(arg)) };
    }
    case 'unary_expression': {
      const operator = (node.childForFieldName('operator') as Node).type as UnaryOperator;
      return {
        kind: 'unary',
        ...span,
        operator,
        operand: expression(node.childForFieldName('argument') as Node),
      };
    }
    case 'binary_expression': {
      return binaryExpression(node, span);
    }
    case 'try_expression': {
      return { kind: 'try', ...span, operand: onlyChild(node) };
    }
    case 'catch_expression': {
      const [operand, handler] = expressionChildren(node).filter((child) => child.type !== 'payload');
      const capture = node.namedChildren.find((child) => child.type === 'payload');
      return {
        kind: 'catch',
        ...span,
        operand: expression(operand),
        capture: capture ? single(payload(capture), capture) : undefined,
        handler: expression(handler),
      };
    }
    case 'if_statement':
    case 'if_expression': {
      return ifExpression(node, span);
    }
    case 'if_type_expression': {
      unavailable(node, '型の位置の if 式');
      break;
    }
    case 'while_statement':
    case 'while_expression': {
      return whileExpression(node, span, undefined);
    }
    case 'for_statement':
    case 'for_expression': {
      return forExpression(node, span, undefined);
    }
    case 'labeled_statement':
    case 'block_expression':
    case 'labeled_type_expression': {
      return labeled(node);
    }
    case 'block': {
      return block(node);
    }
    case 'switch_expression': {
      return switchExpression(node, span);
    }
    case 'break_expression':
    case 'continue_expression': {
      const label = node.namedChildren.find((child) => child.type === 'break_label');
      const value = expressionChildren(node).find((child) => child.type !== 'break_label');
      const parts = {
        label: label ? breakLabel(label) : undefined,
        value: value ? expression(value) : undefined,
      };
      return node.type === 'break_expression'
        ? { kind: 'break', ...span, ...parts }
        : { kind: 'continue', ...span, ...parts };
    }
    case 'return_expression': {
      const value = expressionChildren(node)[0];
      return { kind: 'return', ...span, value: value ? expression(value) : undefined };
    }
    case 'anonymous_struct_initializer': {
      return initializer(
        node.namedChildren.find((child) => child.type === 'initializer_list') as Node,
        span,
        undefined
      );
    }
    case 'struct_initializer': {
      const [typeNode, list] = node.namedChildren.filter((child) => !isComment(child));
      return initializer(list, span, expression(typeNode));
    }
    case 'nullable_type': {
      return { kind: 'optionalType', ...span, child: typeExpression(onlyChildNode(node)) };
    }
    case 'pointer_type': {
      return pointerType(node, span);
    }
    case 'slice_type': {
      return sliceType(node, span);
    }
    case 'array_type': {
      return arrayType(node, span);
    }
    case 'error_union_type': {
      const errorSet = node.childForFieldName('error');
      const ok = node.childForFieldName('ok') as Node;
      if (!errorSet) fail(node, '書き方に誤りがあります。');
      return {
        kind: 'errorUnionType',
        ...span,
        errorSet: typeExpression(errorSet),
        payload: typeExpression(ok),
      };
    }
    case 'error_set_declaration': {
      const names = node.namedChildren
        .filter((child) => child.type === 'identifier')
        .map((child) => decodeIdentifier(child));
      return { kind: 'errorSetType', ...span, names };
    }
    case 'function_signature': {
      rejectAttributes(node);
      const { returnType, inferredErrorSet } = returnTypeOf(node);
      if (inferredErrorSet) fail(node, '関数の型の戻り値に、推論されるエラー集合（!T）は書けません。');
      return {
        kind: 'fnType',
        ...span,
        params: parameters(node.childForFieldName('parameters') as Node),
        returnType,
      };
    }
    case 'struct_declaration':
    case 'enum_declaration':
    case 'union_declaration':
    case 'opaque_declaration': {
      return container(node);
    }
    case 'range_expression': {
      fail(node, '範囲（..）は、for の対象とスライスの添字にだけ書けます。');
      break;
    }
    case 'assignment_expression': {
      return assignment(node, span);
    }
    case 'comptime_expression': {
      unavailable(node, 'comptime');
      break;
    }
    case 'nosuspend_expression': {
      unavailable(node, 'nosuspend');
      break;
    }
    case 'resume_expression': {
      unavailable(node, 'resume');
      break;
    }
    case 'anyframe_type': {
      unavailable(node, 'anyframe');
      break;
    }
    case 'asm_expression': {
      unavailable(node, 'インラインアセンブリ（asm）');
      break;
    }
    case 'expression_statement': {
      return expressionStatementBody(node);
    }
    default: {
      fail(node, '書き方に誤りがあります。');
    }
  }
  return fail(node, '書き方に誤りがあります。');
}

function onlyChildNode(node: Node): Node {
  const child = expressionChildren(node)[0];
  if (!child) fail(node, '書き方に誤りがあります。');
  return child;
}

function onlyChild(node: Node): Expression {
  return expression(onlyChildNode(node));
}

function single(captures: Capture[], node: Node): Capture {
  if (captures.length !== 1) fail(node, 'ここで受け取れる値は1つです。');
  return captures[0];
}

const COMPARISONS = new Set(['==', '!=', '<', '>', '<=', '>=']);

function binaryExpression(node: Node, span: Span): Expression {
  const operatorNode = node.childForFieldName('operator') as Node;
  const operator = operatorNode.type as BinaryOperator;
  // Zig 0.17 has no `**` operator; its tokenizer reads two `*`s, which its parser rejects.
  if (operator === '**') fail(operatorNode, '演算子 ** はありません（配列を繰り返すには @splat を使います）。');
  const left = node.childForFieldName('left') as Node;
  const right = node.childForFieldName('right') as Node;
  // Zig's grammar does not chain comparisons, which tree-sitter's parses as nested binary expressions.
  if (COMPARISONS.has(operator)) {
    for (const operand of [left, right]) {
      if (
        operand.type === 'binary_expression' &&
        COMPARISONS.has((operand.childForFieldName('operator') as Node).type)
      ) {
        fail(node, '比較の演算子は続けて書けません。括弧で囲んでください。');
      }
    }
  }
  return { kind: 'binary', ...span, operator, left: expression(left), right: expression(right) };
}

function indexExpression(node: Node, span: Span): Expression {
  const object = expression(node.childForFieldName('object') as Node);
  const indexNode = node.childForFieldName('index') as Node;
  const sentinelNode = node.childForFieldName('sentinel');
  if (indexNode.type === 'range_expression') {
    const start = indexNode.childForFieldName('left') as Node;
    const end = indexNode.childForFieldName('right');
    return {
      kind: 'slice',
      ...span,
      object,
      start: expression(start),
      end: end ? expression(end) : undefined,
      sentinel: sentinelNode ? expression(sentinelNode) : undefined,
    };
  }
  if (sentinelNode) fail(sentinelNode, '番兵（:）は、スライスのときだけ書けます。');
  return { kind: 'index', ...span, object, index: expression(indexNode) };
}

function assignment(node: Node, span: Span): Expression {
  const operator = (node.childForFieldName('operator') as Node).type as AssignOperator;
  const targets = node.children
    .filter((child, index) => node.fieldNameForChild(index) === 'left')
    .map((child) => expression(child));
  const value = expression(node.childForFieldName('right') as Node);
  return { kind: 'assign', ...span, operator, targets, value };
}

function blockLabel(node: Node): Label {
  const name = node.namedChildren.find((child) => child.type === 'identifier') as Node;
  return { ...spanOf(node), name: decodeIdentifier(name) };
}

function breakLabel(node: Node): Label {
  const name = node.namedChildren.find((child) => child.type === 'identifier') as Node;
  return { ...spanOf(node), name: decodeIdentifier(name) };
}

/** A labeled block or loop, or a loop or block that tree-sitter wraps in a node without a label. */
function labeled(node: Node): Expression {
  const children = node.namedChildren.filter((child) => !isComment(child));
  const labelNode = children.find((child) => child.type === 'block_label');
  const label = labelNode ? blockLabel(labelNode) : undefined;
  const inner = children.find((child) => child.type !== 'block_label') as Node;
  const span = spanOf(node);
  switch (inner.type) {
    case 'block': {
      return { kind: 'block', ...span, label, statements: statements(inner) };
    }
    case 'while_statement':
    case 'while_expression': {
      return whileExpression(inner, span, label);
    }
    case 'for_statement':
    case 'for_expression': {
      return forExpression(inner, span, label);
    }
    default: {
      return fail(inner, '書き方に誤りがあります。');
    }
  }
}

/**
 * The parts of an `if`, `while`, or `for` in source order: the children after the header's `)`, where a payload
 * before `else` captures the condition's value and one after it captures the error.
 */
function afterHeader(node: Node): Node[] {
  const close = node.children.findIndex((child) => child.type === ')');
  return node.children.slice(close + 1);
}

function ifExpression(node: Node, span: Span): Expression {
  const condition = expression(node.childForFieldName('condition') as Node);
  const rest = afterHeader(node);
  let capture: Capture | undefined;
  let thenNode: Node | undefined;
  let elseCapture: Capture | undefined;
  let otherwiseNode: Node | undefined;
  let afterElse = false;
  for (const child of rest) {
    if (child.type === 'else_clause') {
      const elsePayload = child.namedChildren.find((part) => part.type === 'payload');
      if (elsePayload) elseCapture = single(payload(elsePayload), elsePayload);
      otherwiseNode = child.childForFieldName('alternative') ?? undefined;
    } else if (child.type === 'else') {
      afterElse = true;
    } else if (child.type === 'payload') {
      if (afterElse) elseCapture = single(payload(child), child);
      else capture = single(payload(child), child);
    } else if (isExpressionNode(child)) {
      if (afterElse) otherwiseNode = child;
      else thenNode ??= child;
    }
  }
  if (!thenNode) fail(node, '書き方に誤りがあります。');
  return {
    kind: 'if',
    ...span,
    condition,
    capture,
    consequent: expression(thenNode),
    elseCapture,
    otherwise: otherwiseNode ? expression(otherwiseNode) : undefined,
  };
}

// code-gauge-allow functionCognitiveComplexity 25 -- Walks the parts of a while loop in source order.
function whileExpression(node: Node, span: Span, outerLabel: Label | undefined): Expression {
  const condition = expression(node.childForFieldName('condition') as Node);
  const labelNode = node.namedChildren.find((child) => child.type === 'block_label');
  const label = outerLabel ?? (labelNode ? blockLabel(labelNode) : undefined);
  const close = node.children.findIndex((child) => child.type === ')');
  const rest = node.children.slice(close + 1);
  let capture: Capture | undefined;
  let continueExpression: Expression | undefined;
  let bodyNode: Node | undefined;
  let elseCapture: Capture | undefined;
  let otherwiseNode: Node | undefined;
  let afterElse = false;
  let inContinue = false;
  for (const child of rest) {
    if (child.type === ':' && !bodyNode) {
      inContinue = true;
    } else if (child.type === ')' && inContinue) {
      inContinue = false;
    } else if (child.type === 'else_clause') {
      const elsePayload = child.namedChildren.find((part) => part.type === 'payload');
      if (elsePayload) elseCapture = single(payload(elsePayload), elsePayload);
      otherwiseNode = child.childForFieldName('alternative') ?? undefined;
    } else if (child.type === 'else') {
      afterElse = true;
    } else if (child.type === 'payload') {
      if (afterElse) elseCapture = single(payload(child), child);
      else capture = single(payload(child), child);
    } else if (isExpressionNode(child)) {
      if (inContinue) continueExpression = expression(child);
      else if (afterElse) otherwiseNode = child;
      else bodyNode ??= child;
    }
  }
  if (!bodyNode) fail(node, '書き方に誤りがあります。');
  return {
    kind: 'while',
    ...span,
    label,
    isInline: hasToken(node, 'inline'),
    condition,
    capture,
    continueExpression,
    body: expression(bodyNode),
    elseCapture,
    otherwise: otherwiseNode ? expression(otherwiseNode) : undefined,
  };
}

function forExpression(node: Node, span: Span, outerLabel: Label | undefined): Expression {
  const labelNode = node.namedChildren.find((child) => child.type === 'block_label');
  const label = outerLabel ?? (labelNode ? blockLabel(labelNode) : undefined);
  const open = node.children.findIndex((child) => child.type === '(');
  const close = node.children.findIndex((child) => child.type === ')');
  const operands: ForOperand[] = [];
  let pendingRange: Node | undefined;
  for (const child of node.children.slice(open + 1, close)) {
    if (child.type === '..') {
      pendingRange = child;
      continue;
    }
    if (!isExpressionNode(child)) continue;
    if (pendingRange) {
      const previous = operands.at(-1) as ForOperand;
      previous.rangeEnd = expression(child);
      pendingRange = undefined;
      continue;
    }
    if (child.type === 'range_expression') {
      const start = child.childForFieldName('left') as Node;
      const end = child.childForFieldName('right');
      operands.push({
        ...spanOf(child),
        value: expression(start),
        rangeEnd: end ? expression(end) : undefined,
        isRange: true,
      });
    } else {
      operands.push({ ...spanOf(child), value: expression(child), isRange: false });
    }
  }
  const rest = node.children.slice(close + 1);
  const payloadNode = rest.find((child) => child.type === 'payload');
  if (!payloadNode) fail(node, 'for には |x| のように受け取る名前が要ります。');
  let bodyNode: Node | undefined;
  let otherwiseNode: Node | undefined;
  let afterElse = false;
  for (const child of rest) {
    if (child.type === 'else_clause') {
      const elsePayload = child.namedChildren.find((part) => part.type === 'payload');
      if (elsePayload) fail(elsePayload, 'for の else では値を受け取れません。');
      otherwiseNode = child.childForFieldName('alternative') ?? undefined;
    } else if (child.type === 'else') {
      afterElse = true;
    } else if (child.type !== 'payload' && isExpressionNode(child)) {
      if (afterElse) otherwiseNode = child;
      else bodyNode ??= child;
    }
  }
  if (!bodyNode) fail(node, '書き方に誤りがあります。');
  return {
    kind: 'for',
    ...span,
    label,
    isInline: hasToken(node, 'inline'),
    operands,
    captures: payload(payloadNode),
    body: expression(bodyNode),
    otherwise: otherwiseNode ? expression(otherwiseNode) : undefined,
  };
}

function payload(node: Node): Capture[] {
  const captures: Capture[] = [];
  let byPointer = false;
  for (const child of node.children) {
    if (child.type === '*') byPointer = true;
    else if (child.type === 'identifier') {
      captures.push({ ...spanOf(child), name: decodeIdentifier(child), byPointer });
      byPointer = false;
    }
  }
  return captures;
}

function switchExpression(node: Node, span: Span): Expression {
  const labelNode = node.namedChildren.find((child) => child.type === 'block_label');
  const open = node.children.findIndex((child) => child.type === '(');
  const operandNode = node.children.slice(open + 1).find((child) => isExpressionNode(child)) as Node;
  return {
    kind: 'switch',
    ...span,
    label: labelNode ? blockLabel(labelNode) : undefined,
    operand: expression(operandNode),
    cases: node.namedChildren.filter((child) => child.type === 'switch_case').map((child) => switchCase(child)),
  };
}

function switchCase(node: Node): SwitchCase {
  const arrow = node.children.findIndex((child) => child.type === '=>');
  const head = node.children.slice(0, arrow);
  const tail = node.children.slice(arrow + 1);
  const isElse = head.some((child) => child.type === 'else');
  const items: SwitchItem[] = [];
  let rangePending = false;
  for (const child of head) {
    if (child.type === '...') {
      rangePending = true;
    } else if (isExpressionNode(child)) {
      if (rangePending) {
        (items.at(-1) as SwitchItem).last = expression(child);
        rangePending = false;
      } else {
        items.push({ ...spanOf(child), value: expression(child) });
      }
    }
  }
  const payloadNode = tail.find((child) => child.type === 'payload');
  const captures = payloadNode ? payload(payloadNode) : [];
  if (captures.length > 2 && payloadNode) fail(payloadNode, 'switch の枝で受け取れる値は2つまでです。');
  const bodyNode = tail.find((child) => child.type !== 'payload' && isExpressionNode(child));
  if (!bodyNode) fail(node, '書き方に誤りがあります。');
  return {
    ...spanOf(node),
    items,
    isElse,
    isInline: head.some((child) => child.type === 'inline'),
    capture: captures[0],
    tagCapture: captures[1],
    body: expression(bodyNode),
  };
}

function initializer(list: Node, span: Span, type: Expression | undefined): Expression {
  const fieldNodes = list.namedChildren.filter((child) => child.type === 'field_initializer');
  if (fieldNodes.length > 0) {
    const fields: FieldInit[] = fieldNodes.map((child) => ({
      ...spanOf(child),
      name: decodeIdentifier(child.childForFieldName('name') as Node),
      value: expression(child.childForFieldName('value') as Node),
    }));
    return { kind: 'structInit', ...span, type, fields };
  }
  const elements = expressionChildren(list).map((child) => expression(child));
  // `.{}` and `T{}` initialize a struct with its default field values, or an empty array or tuple.
  if (elements.length === 0) return { kind: 'structInit', ...span, type, fields: [] };
  return { kind: 'arrayInit', ...span, type, elements };
}

function pointerQualifiers(node: Node, after: number): { isConst: boolean } {
  let isConst = false;
  for (const child of node.children.slice(after)) {
    if (child.type === 'const') isConst = true;
    else if (child.type === 'volatile') unavailable(child, 'volatile');
    else if (child.type === 'allowzero') unavailable(child, 'allowzero');
    else if (child.type === 'align') unavailable(child, 'align による整列の指定');
    else if (child.type === 'address_space') unavailable(child, 'addrspace');
    else if (child.type === 'byte_alignment') unavailable(child, 'align による整列の指定');
  }
  return { isConst };
}

function pointerType(node: Node, span: Span): Expression {
  if (node.children[0].type === '[') unavailable(node, '多要素のポインタ（[*]T）');
  const childNode = expressionChildren(node).at(-1) as Node;
  const { isConst } = pointerQualifiers(node, 1);
  return { kind: 'pointerType', ...span, isConst, child: typeExpression(childNode) };
}

function sliceType(node: Node, span: Span): Expression {
  const close = node.children.findIndex((child) => child.type === ']');
  const sentinelNode = node.childForFieldName('sentinel');
  const { isConst } = pointerQualifiers(node, close + 1);
  const childNode = expressionChildren(node).at(-1) as Node;
  return {
    kind: 'sliceType',
    ...span,
    isConst,
    sentinel: sentinelNode ? expression(sentinelNode) : undefined,
    child: typeExpression(childNode),
  };
}

function arrayType(node: Node, span: Span): Expression {
  const close = node.children.findIndex((child) => child.type === ']');
  const inside = node.children.slice(1, close).filter((child) => isExpressionNode(child));
  const childNode = node.children.slice(close + 1).find((child) => isExpressionNode(child)) as Node;
  const [lengthNode, sentinelNode] = inside;
  const inferred = lengthNode.type === 'identifier' && lengthNode.text === '_';
  return {
    kind: 'arrayType',
    ...span,
    count: inferred ? undefined : expression(lengthNode),
    sentinel: sentinelNode ? expression(sentinelNode) : undefined,
    child: typeExpression(childNode),
  };
}
