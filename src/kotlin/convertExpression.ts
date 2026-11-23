import type { Node } from '@willbooster/web-tree-sitter';

import { convertAnnotation } from './annotationArguments';
import { unparenthesized, VISIBILITY_KEYWORDS } from './ast';
import type {
  Argument,
  BinaryOperator,
  Block,
  Expression,
  LambdaExpression,
  LambdaParameter,
  Modifiers,
  NamedTypeRef,
  Statement,
  TypeProjectionRef,
  TypeRef,
  WhenCondition,
  WhenEntry,
} from './ast';
import {
  children,
  firstOfType,
  hasToken,
  identifierName,
  named,
  namedOfType,
  required,
  rowOf,
  syntaxError,
  unavailable,
} from './convertSupport';
import { decodeCharLiteral, decodeEscape, parseIntegerLiteral, parseRealLiteral } from './literals';

/**
 * Converts expressions and types. The prelude of the standard library, written in Kotlin, may use what learners'
 * programs may not.
 */
export abstract class ExpressionConverter {
  constructor(protected readonly isLibrary: boolean) {}

  protected abstract convertStatement(node: Node): Statement;

  /** Rejects a construct in learners' programs; the prelude may use it. */
  protected requireLibrary(node: Node, what: string): void {
    if (!this.isLibrary) throw unavailable(node, what);
  }

  convertStatements(nodes: Node[]): Statement[] {
    return nodes.map((node) => this.convertStatement(node));
  }

  /** Converts a control structure's body, which is a block or a single statement. */
  convertBody(node: Node | null | undefined, ownerNode: Node): Block {
    if (!node) {
      const row = ownerNode.endPosition.row;
      return { row, endRow: row, statements: [], isBraced: false };
    }
    if (node.type === 'block') {
      return {
        row: rowOf(node),
        endRow: node.endPosition.row,
        statements: this.convertStatements(named(node)),
        isBraced: true,
      };
    }
    return {
      row: rowOf(node),
      endRow: node.endPosition.row,
      statements: [this.convertStatement(node)],
      isBraced: false,
    };
  }

  // code-gauge-allow functionNcss -- one case per kind of tree-sitter's expression nodes.
  convertExpression(node: Node): Expression {
    if (Object.hasOwn(UNAVAILABLE_EXPRESSIONS, node.type)) throw unavailable(node, UNAVAILABLE_EXPRESSIONS[node.type]);
    const row = rowOf(node);
    switch (node.type) {
      case 'number_literal': {
        return { row, ...parseIntegerLiteral(node.text, (message) => syntaxError(node, message)) };
      }
      case 'float_literal': {
        return { row, ...parseRealLiteral(node.text, (message) => syntaxError(node, message)) };
      }
      case 'character_literal': {
        return { kind: 'char', row, value: decodeCharLiteral(node.text, (message) => syntaxError(node, message)) };
      }
      case 'string_literal': {
        return this.convertString(node);
      }
      case 'multiline_string_literal': {
        this.requireLibrary(node, '複数行の文字列リテラル（"""）');
        return this.convertString(node, true);
      }
      case 'identifier': {
        return this.convertIdentifier(node);
      }
      case 'this_expression': {
        const labelNode = named(node)[0];
        if (labelNode) this.requireLibrary(node, 'ラベル付きの this（this@名前）');
        return { kind: 'this', row, label: labelNode ? identifierName(labelNode) : undefined };
      }
      case 'super_expression': {
        if (named(node).length > 0) throw unavailable(node, 'super<型> や super@名前');
        return { kind: 'super', row };
      }
      case 'parenthesized_expression': {
        return { kind: 'parenthesized', row, expression: this.convertExpression(named(node)[0]) };
      }
      case 'navigation_expression': {
        return this.convertNavigation(node);
      }
      case 'call_expression': {
        return this.convertCall(node);
      }
      default: {
        return this.convertOperatorExpression(node);
      }
    }
  }

  /** Operators, indexes, and the `in`, `is`, and `as` tests. */
  private convertOperatorExpression(node: Node): Expression {
    const row = rowOf(node);
    switch (node.type) {
      case 'index_expression': {
        const [receiver, ...indices] = named(node);
        return intoRightOperand(this.convertExpression(receiver), (operand) => ({
          kind: 'index',
          row,
          receiver: operand,
          indices: indices.map((index) => this.convertExpression(index)),
        }));
      }
      case 'unary_expression': {
        return this.convertUnary(node);
      }
      case 'binary_expression': {
        const operator = required(node.childForFieldName('operator')).type as BinaryOperator;
        return {
          kind: 'binary',
          row,
          operator,
          left: this.convertExpression(required(node.childForFieldName('left'))),
          right: this.convertExpression(required(node.childForFieldName('right'))),
        };
      }
      case 'range_expression': {
        const [left, right] = named(node);
        return {
          kind: 'binary',
          row,
          operator: hasToken(node, '..<') ? '..<' : '..',
          left: this.convertExpression(left),
          right: this.convertExpression(right),
        };
      }
      case 'infix_expression': {
        const [left, name, right] = named(node);
        return {
          kind: 'infix',
          row: rowOf(name),
          name: identifierName(name),
          left: this.convertExpression(left),
          right: this.convertExpression(right),
        };
      }
      case 'in_expression': {
        return {
          kind: 'in',
          row,
          negated: hasToken(node, '!in'),
          left: this.convertExpression(required(node.childForFieldName('left'))),
          right: this.convertExpression(required(node.childForFieldName('right'))),
        };
      }
      case 'is_expression': {
        return {
          kind: 'is',
          row,
          negated: hasToken(node, '!is'),
          operand: this.convertExpression(required(node.childForFieldName('left'))),
          type: this.convertType(required(node.childForFieldName('right'))),
        };
      }
      case 'as_expression': {
        return {
          kind: 'as',
          row,
          isSafe: hasToken(node, 'as?'),
          operand: this.convertExpression(required(node.childForFieldName('left'))),
          type: this.convertType(required(node.childForFieldName('right'))),
        };
      }
      default: {
        return this.convertControlExpression(node);
      }
    }
  }

  /** `if`, `when`, `try`, lambdas, and the jumps. */
  private convertControlExpression(node: Node): Expression {
    const row = rowOf(node);
    switch (node.type) {
      case 'if_expression': {
        const alternative = node.childForFieldName('alternative');
        return {
          kind: 'if',
          row,
          condition: this.convertExpression(required(node.childForFieldName('condition'))),
          thenBranch: this.convertBody(node.childForFieldName('consequence'), node),
          elseBranch: alternative || hasToken(node, 'else') ? this.convertBody(alternative, node) : undefined,
        };
      }
      case 'when_expression': {
        return this.convertWhen(node);
      }
      case 'try_expression': {
        return this.convertTry(node);
      }
      case 'lambda_literal': {
        return this.convertLambda(node);
      }
      case 'throw_expression': {
        return { kind: 'throw', row, value: this.convertExpression(named(node)[0]) };
      }
      case 'return_expression': {
        if (node.childForFieldName('label')) throw unavailable(node, 'ラベル付きの return（return@名前）');
        const value = named(node)[0];
        return { kind: 'return', row, value: value ? this.convertExpression(value) : undefined };
      }
      case 'break_expression':
      case 'continue_expression': {
        if (node.childForFieldName('label')) throw unavailable(node, 'ラベル付きの break・continue');
        return { kind: node.type === 'break_expression' ? 'break' : 'continue', row };
      }
      default: {
        throw syntaxError(node, '書き方に誤りがあります。');
      }
    }
  }

  private convertIdentifier(node: Node): Expression {
    const row = rowOf(node);
    // The grammar reads the keywords `true`, `false`, and `null` as identifiers.
    switch (node.text) {
      case 'true':
      case 'false': {
        return { kind: 'boolean', row, value: node.text === 'true' };
      }
      case 'null': {
        return { kind: 'null', row };
      }
      default: {
        return { kind: 'name', row, name: identifierName(node) };
      }
    }
  }

  private convertString(node: Node, isRaw = false): Expression {
    const parts: (string | Expression)[] = [];
    const append = (text: string): void => {
      if (typeof parts.at(-1) === 'string') parts[parts.length - 1] = `${parts.at(-1) as string}${text}`;
      else parts.push(text);
    };
    const nodes = named(node);
    let skipped = 0;
    for (const [index, child] of nodes.entries()) {
      switch (child.type) {
        case 'string_content': {
          const content = isRaw ? { text: child.text, consumed: 0 } : decodeContent(child, nodes[index + 1]);
          append(content.text.slice(skipped));
          skipped = content.consumed;
          break;
        }
        case 'escape_sequence': {
          append(decodeEscape(child.text, (message) => syntaxError(child, message)));
          skipped = 0;
          break;
        }
        case 'interpolation': {
          const inner = named(child)[0];
          parts.push(this.convertExpression(inner));
          skipped = 0;
          break;
        }
        default: {
          throw syntaxError(child, '文字列の書き方に誤りがあります。');
        }
      }
    }
    return { kind: 'string', row: rowOf(node), parts };
  }

  private convertNavigation(node: Node): Expression {
    const [receiverNode, nameNode] = named(node);
    const operator = children(node).find((child) => !child.isNamed && ['.', '?.', '::'].includes(child.type));
    if (operator?.type === '::' || !nameNode) throw unavailable(node, '関数や型の参照（::）');
    if (nameNode.type !== 'identifier') throw syntaxError(nameNode, '書き方に誤りがあります。');
    return intoRightOperand(this.convertExpression(receiverNode), (receiver) => ({
      kind: 'member',
      row: rowOf(nameNode),
      receiver,
      name: identifierName(nameNode),
      isSafe: operator?.type === '?.',
    }));
  }

  private convertCall(node: Node): Expression {
    const parts = named(node);
    const callee = this.convertExpression(parts[0]);
    let typeArgs: TypeRef[] = [];
    let args: Argument[] = [];
    let trailingLambda: LambdaExpression | undefined;
    for (const part of parts.slice(1)) {
      switch (part.type) {
        case 'type_arguments': {
          typeArgs = namedOfType(part, 'type_projection').map((projection) => {
            const converted = this.convertProjection(projection);
            if (converted.star || converted.variance)
              throw unavailable(projection, '呼び出しの型引数での * や in・out');
            return converted.type;
          });
          break;
        }
        case 'value_arguments': {
          args = namedOfType(part, 'value_argument').map((argument) => this.convertArgument(argument));
          break;
        }
        case 'annotated_lambda': {
          const lambda = named(part);
          if (lambda.some((child) => child.type !== 'lambda_literal')) throw unavailable(part, 'ラベル付きのラムダ式');
          trailingLambda = this.convertLambda(lambda[0]);
          break;
        }
        default: {
          throw syntaxError(part, '書き方に誤りがあります。');
        }
      }
    }
    return intoRightOperand(callee, (operand) => ({
      kind: 'call',
      row: rowOf(node),
      callee: operand,
      typeArgs,
      args,
      trailingLambda,
    }));
  }

  protected convertArgument(node: Node): Argument {
    const parts = named(node);
    const isNamed = hasToken(node, '=');
    const valueNode = parts.at(-1) as Node;
    const isSpread = hasToken(node, '*') || valueNode.type === 'spread_expression';
    if (isSpread) this.requireLibrary(node, '配列の展開（*配列）');
    const value = this.convertExpression(valueNode.type === 'spread_expression' ? named(valueNode)[0] : valueNode);
    // A parenthesized lambda is the same argument, which its candidates give its parameter types to.
    const inner = unparenthesized(value);
    return {
      row: rowOf(node),
      name: isNamed ? identifierName(parts[0]) : undefined,
      value: inner.kind === 'lambda' ? inner : value,
      isSpread,
    };
  }

  private convertUnary(node: Node): Expression {
    const operatorNode = required(node.childForFieldName('operator'));
    const operand = this.convertExpression(required(node.childForFieldName('argument')));
    const operator = operatorNode.type;
    const isPostfix = operatorNode.startIndex > required(node.childForFieldName('argument')).startIndex;
    if (isPostfix) {
      return intoRightOperand(operand, (target) => ({
        kind: 'postfix',
        row: rowOf(node),
        operator: operator as '++' | '--' | '!!',
        operand: target,
      }));
    }
    return { kind: 'prefix', row: rowOf(node), operator: operator as '-' | '+' | '!' | '++' | '--', operand };
  }

  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private convertWhen(node: Node): Expression {
    let subject: Expression | undefined;
    const entries: WhenEntry[] = [];
    for (const child of named(node)) {
      if (child.type === 'when_subject') {
        const parts = named(child);
        if (parts.some((part) => part.type !== 'variable_declaration' && part.type !== 'annotation')) {
          const expression = parts.find((part) => part.type !== 'annotation');
          if (parts.length !== 1 || !expression) throw unavailable(child, 'when の主語での変数の宣言');
          subject = this.convertExpression(expression);
        } else {
          throw unavailable(child, 'when の主語での変数の宣言');
        }
        continue;
      }
      if (child.type !== 'when_entry') throw syntaxError(child, '書き方に誤りがあります。');
      if (child.childForFieldName('guard')) throw unavailable(child, 'when の条件のあとの if（ガード）');
      const conditions = child.childrenForFieldName('condition').map((condition): WhenCondition => {
        const row = rowOf(condition);
        if (condition.type === 'type_test') {
          return { kind: 'is', row, negated: hasToken(condition, '!is'), type: this.convertType(named(condition)[0]) };
        }
        if (condition.type === 'range_test') {
          return {
            kind: 'in',
            row,
            negated: hasToken(condition, '!in'),
            expression: this.convertExpression(named(condition)[0]),
          };
        }
        return { kind: 'expression', row, expression: this.convertExpression(condition) };
      });
      if (conditions.length === 0 && !hasToken(child, 'else')) throw syntaxError(child, 'when の条件が足りません。');
      entries.push({ row: rowOf(child), conditions, body: this.convertBody(child.childForFieldName('body'), child) });
    }
    return { kind: 'when', row: rowOf(node), subject, entries };
  }

  private convertTry(node: Node): Expression {
    const parts = named(node);
    const body = this.convertBody(parts[0], node);
    const catches = namedOfType(node, 'catch_block').map((block) => {
      const blockParts = named(block);
      if (blockParts.some((part) => part.type === 'annotation'))
        throw unavailable(block, 'catch の引数へのアノテーション');
      const nameNode = required(firstOfType(block, 'identifier'));
      const typeNode = required(blockParts.find((part) => part !== nameNode && part.type !== 'block'));
      return {
        row: rowOf(block),
        name: identifierName(nameNode),
        type: this.convertType(typeNode),
        body: this.convertBody(firstOfType(block, 'block'), block),
      };
    });
    const finallyNode = firstOfType(node, 'finally_block');
    if (catches.length === 0 && !finallyNode) throw syntaxError(node, 'try には catch か finally が要ります。');
    return {
      kind: 'try',
      row: rowOf(node),
      body,
      catches,
      finally: finallyNode ? this.convertBody(firstOfType(finallyNode, 'block'), finallyNode) : undefined,
    };
  }

  convertLambda(node: Node): LambdaExpression {
    const parts = named(node);
    let params: LambdaParameter[] | undefined;
    const parametersNode = parts.find((part) => part.type === 'lambda_parameters');
    if (parametersNode) {
      params = named(parametersNode).map((parameter) => {
        if (parameter.type === 'multi_variable_declaration')
          throw unavailable(parameter, 'ラムダ式の引数の分解（(a, b) ->）');
        return this.convertVariableDeclaration(parameter);
      });
    } else if (hasToken(node, '->')) {
      params = [];
    }
    return {
      kind: 'lambda',
      row: rowOf(node),
      endRow: node.endPosition.row,
      params,
      statements: this.convertStatements(parts.filter((part) => part.type !== 'lambda_parameters')),
    };
  }

  /** A `variable_declaration`: a name with an optional type, where `_` names nothing. */
  convertVariableDeclaration(node: Node): {
    row: number;
    name: string | undefined;
    type: TypeRef | undefined;
  } {
    const parts = named(node);
    if (parts.some((part) => part.type === 'annotation')) throw unavailable(node, '変数へのアノテーション');
    const nameNode = required(parts.find((part) => part.type === 'identifier'));
    const typeNode = parts.find((part) => part !== nameNode);
    const name = identifierName(nameNode);
    return {
      row: rowOf(node),
      name: nameNode.text === '_' ? undefined : name,
      type: typeNode ? this.convertType(typeNode) : undefined,
    };
  }

  convertType(node: Node): TypeRef {
    const row = rowOf(node);
    switch (node.type) {
      case 'user_type': {
        return this.convertUserType(node, false);
      }
      case 'nullable_type': {
        const inner = this.convertType(required(named(node).find((child) => child.type !== 'type_modifiers')));
        return { ...inner, nullable: true };
      }
      case 'parenthesized_type': {
        return this.convertType(named(node)[0]);
      }
      case 'non_nullable_type': {
        throw unavailable(node, '確実に null でない型（T & Any）');
      }
      case 'function_type': {
        const parts = named(node);
        if (parts.some((part) => part.type === 'type_modifiers' || part.type === 'context_parameters')) {
          throw unavailable(node, '関数型への修飾子');
        }
        const parametersIndex = parts.findIndex((part) => part.type === 'function_type_parameters');
        const receiverNode = parametersIndex > 0 ? parts[0] : undefined;
        const params = named(parts[parametersIndex]).map((parameter) => {
          if (parameter.type === 'parameter') {
            const typeNode = named(parameter).find((child) => child.type !== 'identifier');
            return this.convertType(required(typeNode));
          }
          return this.convertType(parameter);
        });
        return {
          kind: 'function',
          row,
          receiver: receiverNode ? this.convertType(receiverNode) : undefined,
          params,
          returnType: this.convertType(required(parts.at(-1))),
          nullable: false,
        };
      }
      default: {
        throw syntaxError(node, '型の書き方に誤りがあります。');
      }
    }
  }

  convertUserType(node: Node, nullable: boolean): NamedTypeRef {
    const parts: NamedTypeRef['parts'] = [];
    for (const child of named(node)) {
      if (child.type === 'identifier') parts.push({ name: identifierName(child), args: [] });
      else if (child.type === 'type_arguments') {
        (parts.at(-1) as NamedTypeRef['parts'][number]).args = namedOfType(child, 'type_projection').map((projection) =>
          this.convertProjection(projection)
        );
      } else throw unavailable(child, '型へのアノテーション');
    }
    return { kind: 'named', row: rowOf(node), parts, nullable };
  }

  private convertProjection(node: Node): TypeProjectionRef {
    const parts = named(node);
    if (parts.length === 0) return { star: true };
    const varianceNode = parts.find((part) => part.type === 'variance_modifier');
    if (varianceNode) this.requireLibrary(varianceNode, '型引数の in・out（使う側の変位）');
    const typeNode = required(parts.find((part) => part.type !== 'variance_modifier'));
    return {
      star: false,
      variance: varianceNode ? (varianceNode.text as 'in' | 'out') : undefined,
      type: this.convertType(typeNode),
    };
  }

  /** Reads a declaration's modifiers, rejecting the annotations and keywords learners' programs may not use. */
  convertModifiers(node: Node | undefined, allowed: ReadonlySet<string>, allowsValueClass = false): Modifiers {
    const keywords = new Set<string>();
    const annotations: Modifiers['annotations'] = [];
    for (const child of node ? named(node) : []) {
      if (child.type === 'annotation') {
        annotations.push(convertAnnotation(child, this.isLibrary));
        continue;
      }
      const keyword = child.text;
      if (!this.isLibrary && !allowed.has(keyword)) throw unavailable(child, `${keyword} 修飾子`);
      if (keywords.has(keyword)) throw syntaxError(child, `${keyword} 修飾子が2回書かれています。`);
      keywords.add(keyword);
    }
    const isValueClass = allowsValueClass && keywords.has('value') && !keywords.has('enum');
    if (node && !this.isLibrary && !isValueClass && annotations.some(({ name }) => name === 'JvmInline'))
      throw syntaxError(node, '@JvmInline は value class にだけ付けられます。');
    const visibility = VISIBILITY_KEYWORDS.filter((keyword) => keywords.has(keyword));
    if (node && visibility.length > 1)
      throw syntaxError(node, `公開範囲の修飾子 ${visibility.join(' と ')} は同時に書けません。`);
    return { keywords, annotations };
  }
}

/**
 * A string's content, where the grammar reads `\\uXXXX` as the content `\\u` before the content of the digits, and an
 * unknown escape as content too. `consumed` counts the digits taken from the next content.
 */
function decodeContent(node: Node, next: Node | undefined): { text: string; consumed: number } {
  if (!node.text.startsWith('\\')) return { text: node.text, consumed: 0 };
  const digits = node.text === String.raw`\u` && next?.type === 'string_content' ? next.text.slice(0, 4) : '';
  return {
    text: decodeEscape(`${node.text}${digits}`, (message) => syntaxError(node, message)),
    consumed: digits.length,
  };
}

/**
 * The grammar can parse `2 to listOf<Int>()` as a call of `2 to listOf`. Postfix syntax binds to the rightmost
 * operand in these cases, and parentheses stop the descent.
 */
function intoRightOperand(target: Expression, apply: (operand: Expression) => Expression): Expression {
  switch (target.kind) {
    case 'binary':
    case 'infix':
    case 'in': {
      return { ...target, right: intoRightOperand(target.right, apply) };
    }
    case 'prefix': {
      return { ...target, operand: intoRightOperand(target.operand, apply) };
    }
    default: {
      return apply(target);
    }
  }
}

/** The expressions of syntax this environment does not run, by tree-sitter's node type, with what the error names. */
const UNAVAILABLE_EXPRESSIONS: Record<string, string> = {
  labeled_expression: 'ラベル（名前@）',
  callable_reference: '関数や型の参照（::）',
  object_literal: 'オブジェクト式（object : 型 { ... }）',
  anonymous_function: '無名関数（fun (...) { ... }）',
  annotated_expression: '式へのアノテーション',
  collection_literal: 'アノテーションの外での [...]',
  spread_expression: '配列の展開（*配列）',
};
