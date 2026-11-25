import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { ExecutionBudget } from '../interpreter/limits';
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
  PointerQualifiers,
  SourceFile,
  Span,
  Statement,
  SwitchCase,
  SwitchItem,
  TestDeclaration,
  UnaryOperator,
  VariableDeclaration,
} from './ast';
import { LiteralDecoder, parseFloatText, parseIntegerText, validateCommentText } from './literals';
// code-gauge-allow-file fileNcss -- The file holds one layer of the compiler, whose parts share its private state.
import { unavailableMessage } from './unavailable';

/** Converts tree-sitter's tree of a file into the AST, rejecting the syntax this grader does not run. */
export function convertFile(root: Node, budget = new ExecutionBudget()): SourceFile {
  conversionBudget = budget;
  source = root.text;
  validateCommentText(root, source, budget);
  literals = new LiteralDecoder(budget);
  functions = [];
  const { members, fields, tests, comptimeBlocks } = containerBody(root.namedChildren);
  return { members, fields, functions, tests, comptimeBlocks };
}

/** The text of the file being converted, for checks of the spaces around operators. */
let source = '';
let literals: LiteralDecoder;
let functions: FunctionDeclaration[] = [];
let conversionBudget: ExecutionBudget;

/** The keyword tokens that stand for values where an expression is expected. */
const KEYWORD_VALUES = new Set(['null', 'undefined', 'unreachable', 'anyframe']);

function identifierName(node: Node): { name: string; quotedName: boolean } {
  return { name: literals.decodeIdentifier(node), quotedName: node.text.startsWith('@') };
}

function spanOf(node: Node): Span {
  conversionBudget.spend();
  return {
    row: node.startPosition.row,
    col: node.startPosition.column,
    endRow: node.endPosition.row,
  };
}

function fail(node: Node, message: string): never {
  throw new CompileError([{ row: node.startPosition.row, message }]);
}

export function unavailable(node: Node, key: string): never {
  fail(node, unavailableMessage(key));
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

interface ContainerBody {
  members: ContainerMember[];
  fields: ContainerField[];
  tests: TestDeclaration[];
  comptimeBlocks: Block[];
}

function containerBody(children: readonly Node[], containerKind?: Container['containerKind']): ContainerBody {
  const body: ContainerBody = { members: [], fields: [], tests: [], comptimeBlocks: [] };
  conversionBudget.spend(children.length);
  for (const child of children) {
    if (!child.isNamed || isComment(child)) continue;
    switch (child.type) {
      case 'function_declaration': {
        body.members.push(functionDeclaration(child));
        break;
      }
      case 'variable_declaration': {
        body.members.push(containerVariable(child));
        break;
      }
      case 'container_field': {
        body.fields.push(containerField(child, containerKind === 'struct'));
        break;
      }
      case 'test_declaration': {
        body.tests.push(testDeclaration(child));
        break;
      }
      case 'comptime_declaration': {
        body.comptimeBlocks.push(block(child.namedChildren.find((part) => part.type === 'block') as Node));
        break;
      }
      default: {
        fail(child, '書き方に誤りがあります。');
      }
    }
  }
  return body;
}

function testDeclaration(node: Node): TestDeclaration {
  const nameNode = node.namedChildren.find((child) => child.type === 'identifier');
  return {
    ...spanOf(node),
    decl: nameNode ? { ...spanOf(nameNode), name: literals.decodeIdentifier(nameNode) } : undefined,
    body: block(node.namedChildren.find((child) => child.type === 'block') as Node),
  };
}

/**
 * Rejects `extern`, which declares a function or variable that another object file defines. `export`, `noinline`,
 * and `threadlocal` change only how the program links, which a run of one thread does not observe.
 */
function rejectExtern(node: Node): void {
  for (const child of node.children) {
    if (!child.isNamed && child.type === 'extern') unavailable(child, 'syntax:extern');
  }
}

interface Attributes {
  alignment?: Expression;
  addressSpace?: Expression;
  callingConvention?: Expression;
}

/** `align(...)`, `addrspace(...)`, and `callconv(...)`; `linksection` names a section of the object file's format. */
function attributesOf(node: Node): Attributes {
  const attributes: Attributes = {};
  for (const child of node.namedChildren) {
    if (child.type === 'link_section') unavailable(child, 'syntax:linksection');
    else if (child.type === 'byte_alignment') attributes.alignment = onlyChild(child);
    else if (child.type === 'address_space') attributes.addressSpace = onlyChild(child);
    else if (child.type === 'calling_convention') attributes.callingConvention = onlyChild(child);
  }
  return attributes;
}

function functionDeclaration(node: Node): FunctionDeclaration {
  rejectExtern(node);
  const nameNode = node.childForFieldName('name');
  const body = node.childForFieldName('body');
  if (!nameNode) fail(node, '関数の名前がありません。');
  if (!body) fail(node, '関数の本体がありません。');
  const { returnType, inferredErrorSet } = returnTypeOf(node);
  const attributes = attributesOf(node);
  const declaration: FunctionDeclaration = {
    kind: 'fn',
    ...spanOf(node),
    ...identifierName(nameNode),
    isPub: hasToken(node, 'pub'),
    isInline: hasToken(node, 'inline'),
    isExport: hasToken(node, 'export'),
    params: parameters(node.childForFieldName('parameters') as Node, attributes.callingConvention !== undefined),
    returnType,
    inferredErrorSet,
    body: block(body),
    bodyRow: body.startPosition.row,
    ...attributes,
  };
  functions.push(declaration);
  return declaration;
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

function parameters(node: Node, hasCallingConvention: boolean): Parameter[] {
  const result: Parameter[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== 'parameter') continue;
    if (hasToken(child, '...')) {
      // Zig rejects a variadic function unless it uses the C calling convention, for which it takes C's va_list.
      if (hasCallingConvention) unavailable(child, 'syntax:cVarargs');
      result.push({ ...spanOf(child), name: '_', isComptime: false, isNoalias: false, isVarargs: true });
      continue;
    }
    const nameNode = child.childForFieldName('name');
    const typeNode = child.childForFieldName('type');
    if (!typeNode) fail(child, '引数の型がありません。');
    const isAnytype = typeNode.type === 'builtin_type' && typeNode.text === 'anytype';
    result.push({
      ...spanOf(child),
      ...(nameNode ? identifierName(nameNode) : { name: '_' }),
      type: isAnytype ? undefined : typeExpression(typeNode),
      isComptime: hasToken(child, 'comptime'),
      isNoalias: hasToken(child, 'noalias'),
    });
  }
  return result;
}

function containerVariable(node: Node): VariableDeclaration {
  rejectExtern(node);
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
  const { alignment, addressSpace } = attributesOf(node);
  return {
    kind: 'var',
    ...spanOf(node),
    ...identifierName(nameNode),
    isConst: keyword.type === 'const',
    isPub: hasToken(node, 'pub'),
    type: typeNode ? typeExpression(typeNode) : undefined,
    value: valueNode ? expression(valueNode) : undefined,
    alignment,
    addressSpace,
  };
}

function containerField(node: Node, tupleElement = false): ContainerField {
  const { alignment } = attributesOf(node);
  const isComptime = hasToken(node, 'comptime');
  const nameNode = node.childForFieldName('name');
  const typeNode = node.childForFieldName('type');
  const equals = node.children.findIndex((child) => child.type === '=');
  const valueNode = equals === -1 ? undefined : node.children.slice(equals + 1).find((c) => isExpressionNode(c));
  const value = valueNode ? expression(valueNode) : undefined;
  if (typeNode && nameNode) {
    return {
      ...spanOf(node),
      ...identifierName(nameNode),
      type: typeExpression(typeNode),
      value,
      isComptime,
      alignment,
    };
  }
  if (!nameNode) fail(node, '書き方に誤りがあります。');
  if (!tupleElement) return { ...spanOf(node), ...identifierName(nameNode), value, isComptime, alignment };
  return { ...spanOf(node), type: typeExpression(nameNode), value, isComptime, alignment };
}

function container(node: Node): Container {
  const containerKind =
    node.type === 'struct_declaration'
      ? 'struct'
      : node.type === 'enum_declaration'
        ? 'enum'
        : node.type === 'union_declaration'
          ? 'union'
          : 'opaque';
  const layout = hasToken(node, 'extern') ? 'extern' : hasToken(node, 'packed') ? 'packed' : 'auto';
  // `union(enum)` holds the keyword `enum`, and `union(enum(u8))` an argument after it.
  const children = node.children;
  const brace = children.findIndex((child) => child.type === '{');
  const header = children.slice(0, brace);
  const taggedByEnum = containerKind === 'union' && header.some((child) => child.type === 'enum');
  const argumentNode = header.find((child) => isExpressionNode(child));
  return {
    kind: 'container',
    ...spanOf(node),
    containerKind,
    layout,
    argument: argumentNode ? expression(argumentNode) : undefined,
    taggedByEnum,
    ...containerBody(children.slice(brace + 1), containerKind),
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
      // Zig 0.17's grammar has no capture after errdefer.
      const capture = node.namedChildren.find((child) => child.type === 'payload');
      if (capture) fail(capture, 'errdefer の後には、値を受け取る |err| を書けません。');
      return { kind: 'defer', ...spanOf(node), isErrdefer: node.type === 'errdefer_statement', body: deferBody(node) };
    }
    case 'comptime_statement': {
      const inner = node.namedChildren.find((child) => !isComment(child)) as Node;
      if (inner.type === 'variable_declaration') {
        const converted = variableStatement(inner);
        if (converted.kind === 'var') return { ...converted, ...spanOf(node), isComptime: true };
        if (converted.kind === 'expression') return { kind: 'comptime', ...spanOf(node), body: converted.expression };
        return fail(node, 'comptime の分割代入は書けません。');
      }
      return { kind: 'comptime', ...spanOf(node), body: deferBody(node) };
    }
    case 'nosuspend_statement': {
      return {
        kind: 'expression',
        ...spanOf(node),
        expression: { kind: 'nosuspend', ...spanOf(node), operand: deferBody(node) },
      };
    }
    case 'suspend_statement': {
      return { kind: 'expression', ...spanOf(node), expression: { kind: 'async', ...spanOf(node) } };
    }
    default: {
      return { kind: 'expression', ...spanOf(node), expression: expression(node) };
    }
  }
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
  rejectExtern(node);
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
// code-gauge-allow functionNcss -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
// code-gauge-allow functionCognitiveComplexity -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
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
          ...identifierName(nameNode),
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
  return expression(node);
}

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
        return { kind: 'async', ...span };
      }
      default: {
        fail(node, '書き方に誤りがあります。');
      }
    }
  }
  switch (node.type) {
    case 'integer': {
      checkNumberBoundary(node);
      return { kind: 'integer', ...span, value: parseIntegerText(node.text, node, conversionBudget) };
    }
    case 'float': {
      checkNumberBoundary(node);
      parseFloatText(node.text, node, conversionBudget);
      return { kind: 'float', ...span, text: node.text };
    }
    case 'character': {
      return { kind: 'character', ...span, value: literals.decodeCharacter(node) };
    }
    case 'string':
    case 'multiline_string': {
      return { kind: 'string', ...span, bytes: literals.decodeString(node) };
    }
    case 'boolean': {
      return { kind: 'bool', ...span, value: node.text === 'true' };
    }
    case 'identifier': {
      return { kind: 'identifier', ...span, ...identifierName(node) };
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
      if (!object) return { kind: 'enumLiteral', ...span, name: literals.decodeIdentifier(member) };
      const name = literals.decodeIdentifier(member);
      return intoPrefixType(expression(object), (inner) => ({ kind: 'field', ...span, object: inner, name }));
    }
    case 'error_type': {
      const name = node.namedChildren.find((child) => child.type === 'identifier') as Node;
      return { kind: 'errorValue', ...span, name: literals.decodeIdentifier(name) };
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
      const converted = args.map((arg) => expression(arg));
      return intoPrefixType(expression(callee), (inner) => ({ kind: 'call', ...span, callee: inner, args: converted }));
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
      checkOperatorSpacing(node.children.find((child) => child.type === 'catch') as Node);
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
    case 'if_expression':
    case 'if_type_expression': {
      return ifExpression(node, span);
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
      const payload = typeExpression(ok);
      return intoPrefixType(typeExpression(errorSet), (inner) => ({
        kind: 'errorUnionType',
        ...span,
        errorSet: inner,
        payload,
      }));
    }
    case 'error_set_declaration': {
      const names = node.namedChildren
        .filter((child) => child.type === 'identifier')
        .map((child) => literals.decodeIdentifier(child));
      return { kind: 'errorSetType', ...span, names };
    }
    case 'function_signature': {
      const { callingConvention, alignment, addressSpace } = attributesOf(node);
      if (alignment) unavailable(node, 'syntax:fnTypeAlign');
      if (addressSpace) unavailable(node, 'syntax:fnTypeAddrspace');
      const { returnType, inferredErrorSet } = returnTypeOf(node);
      if (inferredErrorSet) fail(node, '関数の型の戻り値に、推論されるエラー集合（!T）は書けません。');
      return {
        kind: 'fnType',
        ...span,
        params: parameters(node.childForFieldName('parameters') as Node, callingConvention !== undefined),
        returnType,
        callingConvention,
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
    case 'comptime_expression':
    case 'comptime_type_expression': {
      return { kind: 'comptime', ...span, operand: onlyChild(node) };
    }
    case 'nosuspend_expression': {
      return { kind: 'nosuspend', ...span, operand: onlyChild(node) };
    }
    case 'resume_expression': {
      return { kind: 'async', ...span, operand: onlyChild(node) };
    }
    case 'anyframe_type': {
      return { kind: 'async', ...span };
    }
    case 'asm_expression': {
      unavailable(node, 'syntax:asm');
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

/**
 * Applies a field access, call, or error-union suffix to the operand of a prefix type such as `*std.Io.Writer`. tree-sitter's grammar binds
 * `*`, `?`, `[]`, and `[N]` tighter than `.`, calls, and named error-union suffixes (`(*std).Io.Writer`), while Zig's binds them looser.
 */
function intoPrefixType(object: Expression, build: (inner: Expression) => Expression): Expression {
  switch (object.kind) {
    case 'fnType': {
      return { ...object, returnType: intoPrefixType(object.returnType, build) };
    }
    case 'errorUnionType': {
      return { ...object, payload: intoPrefixType(object.payload, build) };
    }
    case 'optionalType':
    case 'pointerType':
    case 'sliceType':
    case 'arrayType': {
      return { ...object, child: intoPrefixType(object.child, build) };
    }
    default: {
      return build(object);
    }
  }
}

function binaryExpression(node: Node, span: Span): Expression {
  return binaryWith(
    node,
    span,
    expression(node.childForFieldName('left') as Node),
    expression(node.childForFieldName('right') as Node)
  );
}

/** A binary expression with the operator of `node` and the given operands, which may differ from its children. */
function binaryWith(node: Node, span: Span, leftOperand: Expression, rightOperand: Expression): Expression {
  const operatorNode = node.childForFieldName('operator') as Node;
  const operator = operatorNode.type as BinaryOperator;
  // Zig 0.17 has no `**` operator; its tokenizer reads two `*`s, which its parser rejects.
  if (operator === '**') fail(operatorNode, '演算子 ** はありません（配列を繰り返すには @splat を使います）。');
  checkOperatorSpacing(operatorNode);
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
  return { kind: 'binary', ...span, operator, left: leftOperand, right: rightOperand };
}

interface RangeParts {
  start: Expression;
  end: Expression | undefined;
}

/**
 * The two ends of a range such as `0..n - 1` in a for operand or a slice. Zig parses each end as a whole expression,
 * while tree-sitter's grammar binds `..` tighter than any operator (`(0..n) - 1`), so the operators around it are
 * moved back to the end they belong to. Returns undefined when `node` holds no range.
 */
function rangeParts(node: Node): RangeParts | undefined {
  if (node.type === 'range_expression') {
    const end = node.childForFieldName('right');
    return { start: expression(node.childForFieldName('left') as Node), end: end ? expression(end) : undefined };
  }
  if (node.type !== 'binary_expression') return undefined;
  const left = node.childForFieldName('left') as Node;
  const right = node.childForFieldName('right') as Node;
  const leftParts = rangeParts(left);
  if (leftParts) {
    if (!leftParts.end) fail(node, '書き方に誤りがあります。');
    return { start: leftParts.start, end: binaryWith(node, spanOf(node), leftParts.end, expression(right)) };
  }
  const rightParts = rangeParts(right);
  if (!rightParts) return undefined;
  return { start: binaryWith(node, spanOf(node), expression(left), rightParts.start), end: rightParts.end };
}

function isSpace(char: string): boolean {
  return /\s/.test(char);
}

function checkNumberBoundary(node: Node): void {
  const next = source[node.endIndex];
  if (/^0x[\da-f_]*e$/i.test(node.text) && (next === '+' || next === '-'))
    fail(node, `16進数の e の直後には ${next} を書けません。`);
}

/** Zig's parser rejects a binary operator with a space on one side only, such as `a+ b`. */
function checkOperatorSpacing(operator: Node): void {
  const before = source[operator.startIndex - 1] ?? '';
  const after = source[operator.endIndex] ?? '';
  if (operator.type === '&' && after === '&') fail(operator, '&& はありません（論理積は and と書きます）。');
  if (isSpace(before) !== isSpace(after)) {
    fail(operator, `演算子 ${operator.type} の両側の空白をそろえてください（片側だけに空白があります）。`);
  }
}

function indexExpression(node: Node, span: Span): Expression {
  const object = expression(node.childForFieldName('object') as Node);
  const indexNode = node.childForFieldName('index') as Node;
  const sentinelNode = node.childForFieldName('sentinel');
  const range = rangeParts(indexNode);
  if (range) {
    return {
      kind: 'slice',
      ...span,
      object,
      start: range.start,
      end: range.end,
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
  return { ...spanOf(node), name: literals.decodeIdentifier(name) };
}

function breakLabel(node: Node): Label {
  const name = node.namedChildren.find((child) => child.type === 'identifier') as Node;
  return { ...spanOf(node), name: literals.decodeIdentifier(name) };
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

// code-gauge-allow functionNcss -- Walks the parts of one syntax node in source order.
// code-gauge-allow functionCognitiveComplexity -- Walks the parts of one syntax node in source order.
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
    otherwise: otherwiseNode ? elseBranch(otherwiseNode) : undefined,
  };
}

// code-gauge-allow functionNcss -- Walks the parts of one syntax node in source order.
// code-gauge-allow functionCognitiveComplexity -- Walks the parts of one syntax node in source order.
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
    otherwise: otherwiseNode ? elseBranch(otherwiseNode) : undefined,
  };
}

// code-gauge-allow functionNcss -- Walks the parts of one syntax node in source order.
// code-gauge-allow functionCognitiveComplexity -- Walks the parts of one syntax node in source order.
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
    const range = rangeParts(child);
    if (range) {
      operands.push({ ...spanOf(child), value: range.start, rangeEnd: range.end, isRange: true });
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
    otherwise: otherwiseNode ? elseBranch(otherwiseNode) : undefined,
  };
}

/**
 * The expression after `else`. tree-sitter's grammar parses an assignment there, as in `else x = 2;`, as a variable
 * declaration without `var`, the node it uses for assignment statements.
 */
function elseBranch(node: Node): Expression {
  if (node.type !== 'variable_declaration') return expression(node);
  const converted = variableStatement(node);
  if (converted.kind !== 'expression') fail(node, '書き方に誤りがあります。');
  return converted.expression;
}

function payload(node: Node): Capture[] {
  const captures: Capture[] = [];
  let byPointer = false;
  for (const child of node.children) {
    if (child.type === '*') byPointer = true;
    else if (child.type === 'identifier') {
      captures.push({ ...spanOf(child), ...identifierName(child), byPointer });
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
      name: literals.decodeIdentifier(child.childForFieldName('name') as Node),
      value: expression(child.childForFieldName('value') as Node),
    }));
    return { kind: 'structInit', ...span, type, fields };
  }
  const elements = expressionChildren(list).map((child) => expression(child));
  // `.{}` and `T{}` initialize a struct with its default field values, or an empty array or tuple.
  if (elements.length === 0 && type?.kind !== 'arrayType') return { kind: 'structInit', ...span, type, fields: [] };
  return { kind: 'arrayInit', ...span, type, elements };
}

/** The qualifiers after a pointer's `*` or `[*]`, or a slice's `[]`, and the pointee type that ends them. */
// code-gauge-allow functionNcss -- Walks the parts of one syntax node in source order.
function pointerParts(node: Node, after: number): PointerQualifiers & { child: Expression } {
  const qualifiers: PointerQualifiers = { isConst: false, isVolatile: false, allowZero: false };
  const children = node.children.slice(after);
  let child: Node | undefined;
  for (let index = 0; index < children.length; index++) {
    const part = children[index];
    switch (part.type) {
      case 'const': {
        qualifiers.isConst = true;
        break;
      }
      case 'volatile': {
        qualifiers.isVolatile = true;
        break;
      }
      case 'allowzero': {
        qualifiers.allowZero = true;
        break;
      }
      case 'align': {
        const close = children.findIndex((each, position) => position > index && each.type === ')');
        const operands = children.slice(index + 1, close).filter((each) => isExpressionNode(each));
        qualifiers.alignment = expression(operands[0]);
        if (operands.length === 3) qualifiers.bitRange = [expression(operands[1]), expression(operands[2])];
        index = close;
        break;
      }
      case 'byte_alignment': {
        qualifiers.alignment = onlyChild(part);
        break;
      }
      case 'address_space': {
        qualifiers.addressSpace = onlyChild(part);
        break;
      }
      default: {
        if (isExpressionNode(part)) child = part;
      }
    }
  }
  if (!child) fail(node, '書き方に誤りがあります。');
  return { ...qualifiers, child: typeExpression(child) };
}

function pointerType(node: Node, span: Span): Expression {
  if (node.children[0].type !== '[') return { kind: 'pointerType', ...span, size: 'one', ...pointerParts(node, 1) };
  // `[*]T`, `[*c]T`, or `[*:s]T`.
  const close = node.children.findIndex((child) => child.type === ']');
  const inside = node.children.slice(1, close);
  const isC = inside.some((child) => child.type === 'c');
  const sentinelNode = inside.find((child) => isExpressionNode(child));
  return {
    kind: 'pointerType',
    ...span,
    size: isC ? 'c' : 'many',
    sentinel: sentinelNode ? expression(sentinelNode) : undefined,
    ...pointerParts(node, close + 1),
  };
}

function sliceType(node: Node, span: Span): Expression {
  const close = node.children.findIndex((child) => child.type === ']');
  const sentinelNode = node.childForFieldName('sentinel');
  return {
    kind: 'sliceType',
    ...span,
    sentinel: sentinelNode ? expression(sentinelNode) : undefined,
    ...pointerParts(node, close + 1),
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
