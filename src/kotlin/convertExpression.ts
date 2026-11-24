// code-gauge-allow-file fileNcss -- the file holds one layer of the compiler, whose parts share its state.
import type { Node } from '@willbooster/web-tree-sitter';

import { convertAnnotation } from './annotationArguments';
import { VISIBILITY_KEYWORDS } from './ast';
import type {
  Annotation,
  Argument,
  BinaryOperator,
  Block,
  ClassDecl,
  Expression,
  FunctionDecl,
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

  /** The annotations on what is not a declaration, which the compiler checks in the file's scope. */
  protected readonly looseAnnotations: { annotation: Annotation; target: string }[] = [];

  private looseAnnotation(node: Node, target: string): Annotation {
    const annotation = this.convertAnnotation(node);
    this.looseAnnotations.push({ annotation, target });
    return annotation;
  }

  protected abstract convertStatement(node: Node): Statement;

  /** The class an object expression declares. */
  protected abstract convertObjectLiteral(node: Node): ClassDecl;

  /** The function an anonymous function declares, which has no name. */
  protected abstract convertAnonymousFunction(node: Node): FunctionDecl;

  convertStatements(nodes: Node[]): Statement[] {
    for (const [index, node] of nodes.entries()) {
      const next = nodes[index + 1];
      // Statements share a row only through `;`, and kotlinc does not end a function's `=` body at a `;` that
      // another statement follows on its row, so it rejects the statement after it.
      if (next && next.startPosition.row === node.endPosition.row && endsWithExpressionBody(node))
        throw syntaxError(
          next,
          '`=` で本体を書いた関数のあとに、`;` で同じ行に次の文を続けることはできません。改行してください。'
        );
    }
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
  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
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
        return this.convertString(node, true);
      }
      case 'identifier': {
        return this.convertIdentifier(node);
      }
      case 'this_expression': {
        const labelNode = named(node)[0];
        return { kind: 'this', row, label: labelNode ? identifierName(labelNode) : undefined };
      }
      case 'super_expression': {
        const typeNode = named(node).find((part) => part.type !== 'identifier');
        const labelNode = firstOfType(node, 'identifier');
        return {
          kind: 'super',
          row,
          type: typeNode ? this.convertUserType(typeNode, false) : undefined,
          label: labelNode ? identifierName(labelNode) : undefined,
        };
      }
      case 'annotated_expression': {
        const parts = named(node);
        for (const annotation of parts.filter((part) => part.type === 'annotation'))
          this.looseAnnotation(annotation, 'EXPRESSION');
        return this.convertExpression(required(parts.findLast((part) => part.type !== 'annotation')));
      }
      case 'callable_reference': {
        const typeNode = firstOfType(node, 'user_type');
        const nameNode = firstOfType(node, 'identifier');
        return {
          kind: 'reference',
          row,
          receiver: typeNode ? { kind: 'type', type: this.convertUserType(typeNode, false) } : undefined,
          name: nameNode ? identifierName(nameNode) : 'class',
        };
      }
      case 'object_literal': {
        return { kind: 'object', row, decl: this.convertObjectLiteral(node) };
      }
      case 'anonymous_function': {
        return {
          kind: 'anonymousFunction',
          row,
          endRow: node.endPosition.row,
          decl: this.convertAnonymousFunction(node),
        };
      }
      case 'collection_literal': {
        return {
          kind: 'collectionLiteral',
          row,
          elements: named(node).map((element) => this.convertExpression(element)),
        };
      }
      case 'labeled_expression': {
        const [labelNode, inner] = named(node);
        const label = labelNode.text.slice(0, -1).replaceAll(/^`|`$/g, '');
        const expression = this.convertExpression(required(inner));
        // A label names a lambda, which `return@label` leaves; on other expressions it changes nothing.
        if (expression.kind === 'lambda') return { ...expression, label };
        return expression;
      }
      case 'parenthesized_expression': {
        // Grouping changes no expression's meaning, so the compiler never sees it, except around a callee.
        const grouped = this.convertExpression(named(node)[0]);
        GROUPED.add(grouped);
        return grouped;
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
        const labelNode = node.childForFieldName('label');
        const value = named(node).find((part) => part.startIndex !== labelNode?.startIndex);
        return {
          kind: 'return',
          row,
          label: labelNode ? identifierName(labelNode) : undefined,
          value: value ? this.convertExpression(value) : undefined,
        };
      }
      case 'break_expression':
      case 'continue_expression': {
        const labelNode = node.childForFieldName('label');
        return {
          kind: node.type === 'break_expression' ? 'break' : 'continue',
          row,
          label: labelNode ? identifierName(labelNode) : undefined,
        };
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
    if (operator?.type === '::') {
      return {
        kind: 'reference',
        row: rowOf(node),
        receiver: { kind: 'expression', expression: this.convertExpression(receiverNode) },
        name: nameNode ? identifierName(nameNode) : 'class',
      };
    }
    if (!nameNode) throw syntaxError(node, '書き方に誤りがあります。');
    if (nameNode.type !== 'identifier') throw syntaxError(nameNode, '書き方に誤りがあります。');
    return intoRightOperand(this.convertExpression(receiverNode), (receiver) => ({
      kind: 'member',
      row: rowOf(nameNode),
      receiver,
      name: identifierName(nameNode),
      isSafe: operator?.type === '?.',
    }));
  }

  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private convertCall(node: Node): Expression {
    const parts = named(node);
    const callee: Expression =
      parts[0].type === 'parenthesized_expression'
        ? { kind: 'parenthesized', row: rowOf(parts[0]), expression: this.convertExpression(parts[0]) }
        : this.convertExpression(parts[0]);
    let typeArgs: TypeRef[] = [];
    let args: Argument[] = [];
    let trailingLambda: LambdaExpression | undefined;
    for (const part of parts.slice(1)) {
      switch (part.type) {
        case 'type_arguments': {
          typeArgs = namedOfType(part, 'type_projection').map((projection) => {
            const converted = this.convertProjection(projection);
            if (converted.star || converted.variance)
              throw syntaxError(projection, '関数を呼び出すときの型引数には、* や in・out を書けません。');
            return converted.type;
          });
          break;
        }
        case 'value_arguments': {
          args = namedOfType(part, 'value_argument').map((argument) => this.convertArgument(argument));
          break;
        }
        case 'annotated_lambda': {
          const labelNode = firstOfType(part, 'label');
          const lambda = this.convertLambda(required(firstOfType(part, 'lambda_literal')));
          trailingLambda = labelNode
            ? { ...lambda, label: labelNode.text.slice(0, -1).replaceAll(/^`|`$/g, '') }
            : lambda;
          break;
        }
        default: {
          throw syntaxError(part, '書き方に誤りがあります。');
        }
      }
    }
    return intoRightOperand(callee, (operand) => {
      // A lambda passed to a function takes the function's name as its label, unless it has its own.
      const name = operand.kind === 'name' ? operand.name : operand.kind === 'member' ? operand.name : undefined;
      const labeled = (lambda: LambdaExpression): LambdaExpression =>
        lambda.label === undefined ? { ...lambda, label: name } : lambda;
      return {
        kind: 'call',
        row: rowOf(node),
        callee: operand,
        typeArgs,
        args: args.map((argument) =>
          argument.value.kind === 'lambda' && !GROUPED.has(argument.value)
            ? { ...argument, value: labeled(argument.value) }
            : argument
        ),
        trailingLambda: trailingLambda && labeled(trailingLambda),
      };
    });
  }

  protected convertArgument(node: Node): Argument {
    const parts = named(node);
    const isNamed = hasToken(node, '=');
    const valueNode = parts.at(-1) as Node;
    const isSpread = hasToken(node, '*') || valueNode.type === 'spread_expression';
    const value = this.convertExpression(valueNode.type === 'spread_expression' ? named(valueNode)[0] : valueNode);
    return {
      row: rowOf(node),
      name: isNamed ? identifierName(parts[0]) : undefined,
      value,
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
    let subjectVariable: Extract<Expression, { kind: 'when' }>['subjectVariable'];
    const entries: WhenEntry[] = [];
    for (const child of named(node)) {
      if (child.type === 'when_subject') {
        const parts = named(child);
        for (const annotation of parts.filter((part) => part.type === 'annotation'))
          this.looseAnnotation(annotation, 'LOCAL_VARIABLE');
        const variable = parts.find((part) => part.type === 'variable_declaration');
        const expression = parts.find((part) => part !== variable && part.type !== 'annotation');
        if (!expression) throw syntaxError(child, 'when の主語に値を書いてください。');
        if (variable) {
          if (!hasToken(child, 'val')) throw syntaxError(child, 'when の主語で宣言する変数には val を書いてください。');
          const declared = this.convertVariableDeclaration(variable);
          if (declared.name === undefined) throw syntaxError(variable, '_ は変数の名前に使えません。');
          subjectVariable = { row: declared.row, name: declared.name, type: declared.type };
        }
        subject = this.convertExpression(expression);
        continue;
      }
      if (child.type !== 'when_entry') throw syntaxError(child, '書き方に誤りがあります。');
      const guardNode = child.childForFieldName('guard');
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
      entries.push({
        row: rowOf(child),
        conditions,
        guard: guardNode ? this.convertExpression(guardNode) : undefined,
        body: this.convertBody(child.childForFieldName('body'), child),
      });
    }
    return { kind: 'when', row: rowOf(node), subject, subjectVariable, entries };
  }

  private convertTry(node: Node): Expression {
    const parts = named(node);
    const body = this.convertBody(parts[0], node);
    const catches = namedOfType(node, 'catch_block').map((block) => {
      const blockParts = named(block);
      for (const annotation of blockParts.filter((part) => part.type === 'annotation'))
        this.looseAnnotation(annotation, 'VALUE_PARAMETER');
      const nameNode = required(firstOfType(block, 'identifier'));
      const typeNode = required(
        blockParts.find((part) => part !== nameNode && part.type !== 'block' && part.type !== 'annotation')
      );
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
    const destructurings: Statement[] = [];
    const parametersNode = parts.find((part) => part.type === 'lambda_parameters');
    if (parametersNode) {
      params = named(parametersNode).map((parameter, index): LambdaParameter => {
        if (parameter.type !== 'multi_variable_declaration') return this.convertVariableDeclaration(parameter);
        // `{ (k, v) -> ... }` takes a parameter that the body destructures first.
        const typeNode = parameter.childForFieldName('type');
        const row = rowOf(parameter);
        const name = `\0destructured${index}`;
        destructurings.push({
          kind: 'destructuring',
          row,
          modifiers: { keywords: new Set(), annotations: [] },
          isParameter: true,
          isVar: false,
          names: namedOfType(parameter, 'variable_declaration').map((variable) => {
            const declared = this.convertVariableDeclaration(variable);
            return declared.name === undefined ? undefined : { ...declared, name: declared.name };
          }),
          initializer: { kind: 'name', row, name },
        });
        return { row, name, type: typeNode ? this.convertType(typeNode) : undefined };
      });
    } else if (hasToken(node, '->')) {
      params = [];
    }
    return {
      kind: 'lambda',
      row: rowOf(node),
      endRow: node.endPosition.row,
      label: undefined,
      params,
      statements: [
        ...destructurings,
        ...this.convertStatements(parts.filter((part) => part.type !== 'lambda_parameters')),
      ],
    };
  }

  /** A `variable_declaration`: a name with an optional type, where `_` names nothing. */
  convertVariableDeclaration(node: Node): {
    row: number;
    name: string | undefined;
    type: TypeRef | undefined;
  } {
    const parts = named(node);
    for (const annotation of parts.filter((part) => part.type === 'annotation'))
      this.looseAnnotation(annotation, 'LOCAL_VARIABLE');
    const nameNode = required(parts.find((part) => part.type === 'identifier'));
    const typeNode = parts.find((part) => part !== nameNode && part.type !== 'annotation');
    const name = identifierName(nameNode);
    return {
      row: rowOf(node),
      name: nameNode.text === '_' ? undefined : name,
      type: typeNode ? this.convertType(typeNode) : undefined,
    };
  }

  // code-gauge-allow functionNcss -- the parts of the construct this function compiles follow one another, and splitting them would only rename them.
  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  convertType(node: Node): TypeRef {
    const row = rowOf(node);
    switch (node.type) {
      case 'user_type': {
        return this.convertUserType(node, false);
      }
      case 'nullable_type': {
        const parts = named(node);
        const annotations = this.typeAnnotations(parts.find((child) => child.type === 'type_modifiers'));
        const inner = this.convertType(required(parts.find((child) => child.type !== 'type_modifiers')));
        if (inner.kind === 'named' && inner.definitelyNonNull)
          throw syntaxError(node, '確実に null でない型（T & Any）には ? を付けられません。');
        return { ...inner, nullable: true, annotations: [...(inner.annotations ?? []), ...annotations] };
      }
      case 'parenthesized_type': {
        return this.convertType(named(node)[0]);
      }
      case 'non_nullable_type': {
        const [left, right] = named(node).map((part) => this.convertType(part));
        const isAny =
          right.kind === 'named' &&
          !right.nullable &&
          right.parts.length === 1 &&
          right.parts[0].name === 'Any' &&
          right.parts[0].args.length === 0;
        if (left.kind !== 'named' || !isAny) throw syntaxError(node, '& を使った型は、型引数 & Any の形だけ書けます。');
        return { ...left, nullable: false, definitelyNonNull: true };
      }
      case 'function_type': {
        const parts = named(node);
        const modifiersNode = parts.find((part) => part.type === 'type_modifiers');
        const contextNode = parts.find((part) => part.type === 'context_parameters');
        const signature = parts.filter((part) => part !== modifiersNode && part !== contextNode);
        const parametersIndex = signature.findIndex((part) => part.type === 'function_type_parameters');
        const receiverNode = parametersIndex > 0 ? signature[0] : undefined;
        const params = named(signature[parametersIndex]).map((parameter) => {
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
          returnType: this.convertType(required(signature.at(-1))),
          nullable: false,
          // The grammar reads `suspend` of `suspend R.() -> T` as a modifier of the receiver's type.
          isSuspend: [modifiersNode, receiverNode && firstOfType(receiverNode, 'type_modifiers')].some(
            (modifiers) => modifiers !== undefined && children(modifiers).some((child) => child.type === 'suspend')
          ),
          contextTypes: contextNode ? named(contextNode).map((part) => this.convertType(part)) : [],
          annotations: this.typeAnnotations(modifiersNode),
        };
      }
      default: {
        throw syntaxError(node, '型の書き方に誤りがあります。');
      }
    }
  }

  convertUserType(node: Node, nullable: boolean): NamedTypeRef {
    const parts: NamedTypeRef['parts'] = [];
    const annotations: Annotation[] = [];
    for (const child of named(node)) {
      if (child.type === 'identifier') parts.push({ name: identifierName(child), args: [] });
      else if (child.type === 'type_arguments') {
        (parts.at(-1) as NamedTypeRef['parts'][number]).args = namedOfType(child, 'type_projection').map((projection) =>
          this.convertProjection(projection)
        );
      } else if (child.type === 'type_modifiers') {
        annotations.push(...this.typeAnnotations(child));
      } else throw syntaxError(child, '型の書き方に誤りがあります。');
    }
    return { kind: 'named', row: rowOf(node), parts, nullable, annotations };
  }

  /** The annotations of a type's `type_modifiers`, as `@A` of `@A Int`, where `suspend` belongs to function types. */
  private typeAnnotations(node: Node | undefined): Annotation[] {
    if (!node) return [];
    const owner = node.parent;
    const isFunctionReceiver =
      owner?.type === 'user_type' &&
      owner.parent?.type === 'function_type' &&
      owner.parent.namedChildren[0]?.id === owner.id;
    for (const child of children(node))
      if (child.type === 'suspend' && owner?.type !== 'function_type' && !isFunctionReceiver)
        throw syntaxError(child, 'suspend は関数型にだけ付けられます。');
    return namedOfType(node, 'annotation').map((annotation) => this.looseAnnotation(annotation, 'TYPE'));
  }

  private convertProjection(node: Node): TypeProjectionRef {
    const parts = named(node);
    if (parts.length === 0) return { star: true };
    const varianceNode = parts.find((part) => part.type === 'variance_modifier');
    const typeNode = required(parts.find((part) => part.type !== 'variance_modifier'));
    return {
      star: false,
      variance: varianceNode ? (varianceNode.text as 'in' | 'out') : undefined,
      type: this.convertType(typeNode),
    };
  }

  /** Reads a declaration's modifiers, rejecting those that Kotlin/JVM does not accept or this environment does not run. */
  convertModifiers(node: Node | undefined, allowsValueClass = false): Modifiers {
    const keywords = new Set<string>();
    const annotations: Modifiers['annotations'] = [];
    let contextParameters: Modifiers['contextParameters'];
    for (const child of node ? named(node) : []) {
      if (child.type === 'annotation') {
        annotations.push(this.convertAnnotation(child));
        continue;
      }
      if (child.type === 'context_parameters') {
        if (contextParameters) throw syntaxError(child, 'context(...) は1つだけ書けます。');
        contextParameters = named(child).map((parameter) => {
          if (parameter.type !== 'parameter')
            throw syntaxError(parameter, 'context(...) には、名前: 型 の形で引数を書いてください。');
          const [nameNode, typeNode] = named(parameter);
          return {
            row: rowOf(parameter),
            name: identifierName(nameNode),
            type: this.convertType(required(typeNode)),
            defaultValue: undefined,
            modifiers: { keywords: new Set<string>(), annotations: [] },
          };
        });
        continue;
      }
      const keyword = child.text;
      if (!this.isLibrary && keyword === 'external') throw unavailable(child, '外部の関数の宣言（external）');
      if (keyword === 'expect' || keyword === 'actual')
        throw syntaxError(child, `${keyword} 修飾子は、マルチプラットフォームのプロジェクトでだけ使えます。`);
      if (keywords.has(keyword)) throw syntaxError(child, `${keyword} 修飾子が2回書かれています。`);
      keywords.add(keyword);
    }
    const isValueClass = allowsValueClass && keywords.has('value') && !keywords.has('enum');
    if (node && !this.isLibrary && !isValueClass && annotations.some(({ name }) => name === 'JvmInline'))
      throw syntaxError(node, '@JvmInline は value class にだけ付けられます。');
    const visibility = VISIBILITY_KEYWORDS.filter((keyword) => keywords.has(keyword));
    if (node && visibility.length > 1)
      throw syntaxError(node, `公開範囲の修飾子 ${visibility.join(' と ')} は同時に書けません。`);
    for (const [a, b] of EXCLUSIVE_MODIFIERS)
      if (keywords.has(a) && keywords.has(b)) throw syntaxError(required(node), `${a} と ${b} は同時に書けません。`);
    return { keywords, annotations, contextParameters };
  }

  convertAnnotation(node: Node): Annotation {
    return convertAnnotation(node, (argument) => this.convertArgument(argument));
  }
}

/** Modifiers that contradict each other, which kotlinc rejects together. */
const EXCLUSIVE_MODIFIERS = [
  ['open', 'final'],
  ['abstract', 'final'],
  ['open', 'abstract'],
  ['lateinit', 'const'],
  ['data', 'sealed'],
  ['data', 'enum'],
  ['data', 'inner'],
  ['data', 'abstract'],
  ['data', 'open'],
  ['enum', 'inner'],
  ['sealed', 'final'],
  ['in', 'out'],
] as const;

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

/** The expressions written in parentheses, which the AST does not keep. */
const GROUPED = new WeakSet<Expression>();

/**
 * The grammar can parse `2 to listOf<Int>()` as a call of `2 to listOf`. Postfix syntax binds to the rightmost
 * operand in these cases, and parentheses stop the descent, as in `(31 * a).toInt()`.
 */
function intoRightOperand(target: Expression, apply: (operand: Expression) => Expression): Expression {
  if (GROUPED.has(target)) return apply(target);
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
const UNAVAILABLE_EXPRESSIONS: Record<string, string> = {};

/** Whether a statement ends with a function's `=` body, as `fun f() = 1` or `val g = fun() = 2` does. */
function endsWithExpressionBody(statement: Node): boolean {
  for (let node: Node | null = statement; node; node = node.lastChild) {
    if (node.type === 'function_body' && node.firstChild?.type === '=') return true;
  }
  return false;
}
