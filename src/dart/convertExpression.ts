// code-gauge-allow-file fileNcss 815 -- One converter per file; splitting it further would scatter the cases of one kind of node.
import type { Node } from '@willbooster/web-tree-sitter';

import type {
  Arguments,
  Block,
  CascadeSection,
  CascadeSelector,
  CollectionElement,
  Expression,
  ForInBinding,
  FormalParameters,
  FunctionBody,
  ListPatternElement,
  NamedArgument,
  ParameterTypes,
  Pattern,
  RecordLiteralField,
  RecordPatternField,
  Span,
  StringPart,
  SwitchExpressionCase,
  TypeParameter,
  TypeSyntax,
  VariableDeclaration,
} from './ast';
import {
  childrenOf,
  fieldOf,
  fieldsOf,
  hasToken,
  namedOf,
  requireNode,
  spanOf,
  syntaxError,
  unsupported,
} from './convertBase';

const BINARY_NODES = new Set([
  'additive_expression',
  'multiplicative_expression',
  'shift_expression',
  'bitwise_and_expression',
  'bitwise_or_expression',
  'bitwise_xor_expression',
  'equality_expression',
  'relational_expression',
  'logical_and_expression',
  'logical_or_expression',
  'if_null_expression',
]);

const PATTERN_NODES = new Set([
  'cast_pattern',
  'constant_pattern',
  'list_pattern',
  'map_pattern',
  'null_assert_pattern',
  'null_check_pattern',
  'object_pattern',
  'record_pattern',
  'rest_pattern',
  'variable_pattern',
]);

/** Converts expressions, patterns, and types; the subclass adds statements and declarations. */
export abstract class ExpressionConverter {
  /** Whether the source is one of the interpreter's own libraries, which may use `external` and other internals. */
  protected abstract readonly isLibrary: boolean;

  abstract convertBlock(node: Node): Block;
  abstract convertFormalParameters(node: Node): FormalParameters;
  abstract convertFunctionBody(node: Node): FunctionBody;
  abstract convertTypeParameters(node: Node | undefined): TypeParameter[];
  abstract convertLocalDeclaration(node: Node): VariableDeclaration;

  /**
   * The expressions among a node's children, each with the cascade sections that follow it, since the grammar places
   * the sections of `a..b()..c()` beside `a` rather than inside a node of their own.
   */
  protected expressionChildren(nodes: Node[]): { node: Node; expression: Expression }[] {
    const result: { node: Node; expression: Expression }[] = [];
    for (const node of nodes) {
      if (node.type === 'cascade_section') {
        const last = result.at(-1);
        if (!last) return syntaxError(node, '書き方に誤りがあります。');
        last.expression = this.appendCascade(last.expression, node);
        continue;
      }
      if (node.type === 'this' || node.type === 'super') {
        result.push({ node, expression: { kind: node.type, ...spanOf(node) } });
        continue;
      }
      if (!node.isNamed || node.type === 'comment') continue;
      result.push({ node, expression: this.convertExpression(node) });
    }
    return result;
  }

  /** The single expression a node's named children hold, with the cascade sections that follow it. */
  protected soleExpression(node: Node, children = childrenOf(node)): Expression {
    const expressions = this.expressionChildren(children);
    if (expressions.length !== 1) return syntaxError(node, '書き方に誤りがあります。');
    return expressions[0].expression;
  }

  /** The expression in a field, with the cascade sections after it until the next field. */
  protected fieldExpression(node: Node, field: string): Expression {
    const nodes = fieldsOf(node, field);
    if (nodes.length === 0) return syntaxError(node, '書き方に誤りがあります。');
    const children = childrenOf(node);
    const first = children.findIndex((child) => child.id === nodes[0].id);
    let end = first + 1;
    while (end < children.length && (children[end].type === 'cascade_section' || children[end].type === 'comment')) {
      end++;
    }
    return this.soleExpression(node, children.slice(first, end));
  }

  private appendCascade(target: Expression, node: Node): Expression {
    const section = this.convertCascadeSection(node);
    if (target.kind === 'cascade' && target.end <= node.startIndex) {
      return { ...target, sections: [...target.sections, section], end: node.endIndex };
    }
    return { kind: 'cascade', target, sections: [section], ...spanOf(node), row: target.row, start: target.start };
  }

  private convertCascadeSection(node: Node): CascadeSection {
    const children = childrenOf(node);
    const nullAware = hasToken(node, '?..');
    const selectors: CascadeSelector[] = [];
    let assignment: CascadeSection['assignment'];
    for (const [index, child] of children.entries()) {
      if (child.type === 'cascade_selector' || child.type.startsWith('cascade_')) {
        if (child.type === 'cascade_section') continue;
        selectors.push(...this.cascadeSelectors(child));
        continue;
      }
      if (!child.isNamed && /^(\?\?|~\/|>>>|<<|>>|[-+*/%&|^])?=$/.test(child.type)) {
        const value = this.soleExpression(node, children.slice(index + 1));
        assignment = { operator: child.type, value };
        break;
      }
    }
    return { nullAware, selectors, assignment, ...spanOf(node) };
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Each selector is a distinct grammar form.
  private cascadeSelectors(node: Node): CascadeSelector[] {
    const span = spanOf(node);
    switch (node.type) {
      case 'cascade_selector': {
        const index = namedOf(node).find((child) => child.type !== 'identifier');
        if (hasToken(node, '[') || hasToken(node, '?[')) {
          return [
            {
              kind: 'index',
              index: this.soleExpression(node),
              nullAware: hasToken(node, '?[') || hasToken(node, '?'),
              ...span,
            },
          ];
        }
        const name = namedOf(node).find((child) => child.type === 'identifier');
        if (!name || index) return syntaxError(node, '書き方に誤りがあります。');
        return [{ kind: 'member', name: name.text, nullAware: false, ...span }];
      }
      case 'cascade_member_expression':
      case 'cascade_null_aware_member_expression': {
        const object = fieldOf(node, 'object');
        const property = requireNode(fieldOf(node, 'property'), node);
        return [
          ...(object ? this.cascadeSelectors(object) : []),
          { kind: 'member', name: property.text, nullAware: node.type.includes('null_aware'), ...spanOf(property) },
        ];
      }
      case 'cascade_index_expression':
      case 'cascade_null_aware_index_expression': {
        const object = requireNode(fieldOf(node, 'object'), node);
        return [
          ...this.cascadeSelectors(object),
          {
            kind: 'index',
            index: this.fieldExpression(node, 'index'),
            nullAware: node.type.includes('null_aware'),
            ...span,
          },
        ];
      }
      case 'cascade_call_expression': {
        const fn = fieldOf(node, 'function');
        const property = fieldOf(node, 'property');
        const typeArguments = fieldOf(node, 'type_arguments');
        return [
          ...(fn ? this.cascadeSelectors(fn) : []),
          ...(property
            ? [{ kind: 'member' as const, name: property.text, nullAware: false, ...spanOf(property) }]
            : []),
          {
            kind: 'call',
            typeArguments: typeArguments ? this.convertTypeArguments(typeArguments) : undefined,
            arguments: this.convertArguments(requireNode(fieldOf(node, 'arguments'), node)),
            ...span,
          },
        ];
      }
      case 'cascade_null_assertion_expression': {
        return [...this.cascadeSelectors(requireNode(fieldOf(node, 'value'), node)), { kind: 'nullAssert', ...span }];
      }
      default: {
        return syntaxError(node, '書き方に誤りがあります。');
      }
    }
  }

  // code-gauge-allow functionNcss 52 -- One case per kind of node in the grammar.
  convertExpression(node: Node): Expression {
    const span = spanOf(node);
    if (BINARY_NODES.has(node.type)) return this.convertBinary(node);
    switch (node.type) {
      case 'decimal_integer_literal':
      case 'hex_integer_literal': {
        const text = node.text.replaceAll('_', '');
        return { kind: 'int', value: BigInt(text), text, ...span };
      }
      case 'decimal_floating_point_literal': {
        return { kind: 'double', value: Number(node.text.replaceAll('_', '')), ...span };
      }
      case 'true':
      case 'false': {
        return { kind: 'bool', value: node.type === 'true', ...span };
      }
      case 'null_literal': {
        return { kind: 'null', ...span };
      }
      case 'string_literal': {
        return { kind: 'string', parts: this.convertStringParts(node), ...span };
      }
      case 'symbol_literal': {
        return {
          kind: 'symbol',
          name: childrenOf(node)
            .slice(1)
            .map((child) => child.text)
            .join(''),
          ...span,
        };
      }
      case 'list_literal': {
        return this.convertListLiteral(node);
      }
      case 'set_or_map_literal': {
        return this.convertSetOrMapLiteral(node);
      }
      case 'record_literal': {
        return this.convertRecordLiteral(node);
      }
      case 'identifier': {
        return { kind: 'identifier', name: node.text, ...span };
      }
      case 'this':
      case 'super': {
        return { kind: node.type, ...span };
      }
      case 'parenthesized_expression': {
        return { kind: 'parenthesized', expression: this.soleExpression(node), ...span };
      }
      case 'member_expression':
      case 'null_aware_member_expression': {
        return {
          kind: 'member',
          object: this.objectOf(node),
          name: requireNode(fieldOf(node, 'property'), node).text,
          nullAware: node.type === 'null_aware_member_expression',
          ...span,
        };
      }
      case 'index_expression':
      case 'null_aware_index_expression': {
        return {
          kind: 'index',
          object: this.objectOf(node),
          index: this.fieldExpression(node, 'index'),
          nullAware: node.type === 'null_aware_index_expression',
          ...span,
        };
      }
      case 'call_expression': {
        return this.convertCall(node);
      }
      case 'instantiation_expression': {
        return {
          kind: 'instantiation',
          target: this.objectOf(node, 'function'),
          typeArguments: this.convertTypeArguments(requireNode(fieldOf(node, 'type_arguments'), node)),
          ...span,
        };
      }
      case 'new_expression':
      case 'const_object_expression': {
        return this.convertNew(node);
      }
      case 'constructor_invocation': {
        return this.convertConstructorInvocation(node);
      }
      case 'constructor_tearoff': {
        return this.convertConstructorTearoff(node);
      }
      default: {
        return this.convertOperatorExpression(node, span);
      }
    }
  }

  /** Assignments, operators, conditionals, casts, and the other expressions that combine expressions. */
  // code-gauge-allow functionNcss 35 -- One case per kind of node in the grammar.
  private convertOperatorExpression(node: Node, span: Span): Expression {
    switch (node.type) {
      case 'assignment_expression': {
        return {
          kind: 'assign',
          target: this.convertAssignable(requireNode(fieldOf(node, 'left'), node)),
          operator: requireNode(fieldOf(node, 'operator'), node).type,
          value: this.fieldExpression(node, 'right'),
          ...span,
        };
      }
      case 'pattern_assignment': {
        return this.convertPatternAssignment(node);
      }
      case 'unary_expression': {
        return this.convertUnary(node);
      }
      case 'postfix_expression': {
        const operator = childrenOf(node).find((child) => child.type === '++' || child.type === '--');
        return {
          kind: 'postfix',
          operator: requireNode(operator, node).type as '++' | '--',
          operand: this.convertAssignable(requireNode(fieldOf(node, 'argument'), node)),
          ...span,
        };
      }
      case 'null_assertion_expression': {
        return { kind: 'nullAssert', operand: this.objectOf(node, 'value'), ...span };
      }
      case 'conditional_expression': {
        const condition = namedOf(node)[0];
        return {
          kind: 'conditional',
          condition: this.convertExpression(condition),
          consequent: this.fieldExpression(node, 'consequence'),
          alternative: this.fieldExpression(node, 'alternative'),
          ...span,
        };
      }
      case 'type_test_expression': {
        const [value, test] = operandsOf(node);
        const isOperator = namedOf(test).find((child) => child.type === 'is_operator');
        return {
          kind: 'is',
          value: this.convertExpression(value),
          type: this.convertType(
            requireNode(
              namedOf(test).find((child) => child.type === 'type'),
              node
            )
          ),
          negated: isOperator ? hasToken(isOperator, '!') : false,
          ...span,
        };
      }
      case 'type_cast_expression': {
        const [value, cast] = operandsOf(node);
        return {
          kind: 'as',
          value: this.convertExpression(value),
          type: this.convertType(
            requireNode(
              namedOf(cast).find((child) => child.type === 'type'),
              node
            )
          ),
          ...span,
        };
      }
      case 'throw_expression': {
        return { kind: 'throw', value: this.fieldExpression(node, 'value'), ...span };
      }
      case 'function_expression': {
        return this.convertFunctionExpression(node);
      }
      case 'switch_expression': {
        return this.convertSwitchExpression(node);
      }
      case 'static_member_shorthand': {
        return this.convertDotShorthand(node);
      }
      case 'await_expression': {
        return unsupported(node, 'await（非同期処理）');
      }
      default: {
        return syntaxError(node, '書き方に誤りがあります。');
      }
    }
  }

  /** The receiver of a member, index, or call node, which the grammar may give as a `this` or `super` token. */
  private objectOf(node: Node, field = 'object'): Expression {
    const object = requireNode(fieldOf(node, field), node);
    if (object.type === 'this' || object.type === 'super') return { kind: object.type, ...spanOf(object) };
    return this.convertExpression(object);
  }

  private convertBinary(node: Node): Expression {
    const children = childrenOf(node).filter((child) => child.type !== 'comment');
    const operands: { expression: Expression }[] = [];
    const operators: string[] = [];
    let pendingOperand: Node[] = [];
    const flush = (): void => {
      if (pendingOperand.length === 0) return;
      operands.push({ expression: this.soleExpression(node, pendingOperand) });
      pendingOperand = [];
    };
    for (const child of children) {
      if (child.type === 'relational_operator') {
        flush();
        operators.push(child.text);
      } else if (!child.isNamed && child.type !== 'this' && child.type !== 'super') {
        flush();
        operators.push(child.type);
      } else {
        pendingOperand.push(child);
      }
    }
    flush();
    if (operands.length !== operators.length + 1) return syntaxError(node, '書き方に誤りがあります。');
    let result = operands[0].expression;
    for (const [index, operator] of operators.entries()) {
      const right = operands[index + 1].expression;
      result = { kind: 'binary', operator, left: result, right, ...spanOf(node), row: result.row, start: result.start };
    }
    return result;
  }

  private convertUnary(node: Node): Expression {
    const children = childrenOf(node).filter((child) => child.type !== 'comment');
    const [operatorNode, ...rest] = children;
    const span = spanOf(node);
    if (children.length === 1) return this.convertExpression(operatorNode);
    if (operatorNode.type === '++' || operatorNode.type === '--') {
      return {
        kind: 'prefix',
        operator: operatorNode.type,
        operand: this.convertAssignable(requireNode(rest[0], node)),
        ...span,
      };
    }
    const operator = operatorNode.type === 'negate_operator' ? '!' : operatorNode.text;
    if (operator !== '-' && operator !== '!' && operator !== '~') return syntaxError(node, '書き方に誤りがあります。');
    const operandNode = requireNode(rest[0], node);
    const operand =
      operandNode.type === 'super'
        ? ({ kind: 'super', ...spanOf(operandNode) } as Expression)
        : this.convertExpression(operandNode);
    return { kind: 'prefix', operator, operand, ...span };
  }

  /** The target of an assignment or an increment: a variable, a property, or an element. */
  protected convertAssignable(node: Node): Expression {
    if (node.type !== 'assignable_expression') return this.convertExpression(node);
    const span = spanOf(node);
    const property = fieldOf(node, 'property');
    const indices = fieldsOf(node, 'index');
    if (property || indices.length > 0) {
      const object = this.objectOf(node);
      if (property) {
        return { kind: 'member', object, name: property.text, nullAware: hasToken(node, '?.'), ...span };
      }
      return {
        kind: 'index',
        object,
        index: this.fieldExpression(node, 'index'),
        nullAware: hasToken(node, '?.[') || hasToken(node, '?[') || hasToken(node, '?'),
        ...span,
      };
    }
    return this.soleExpression(node);
  }

  private convertCall(node: Node): Expression {
    const fn = requireNode(fieldOf(node, 'function'), node);
    const args = this.convertArguments(requireNode(fieldOf(node, 'arguments'), node));
    if (fn.type === 'instantiation_expression') {
      return {
        kind: 'call',
        callee: this.objectOf(fn, 'function'),
        typeArguments: this.convertTypeArguments(requireNode(fieldOf(fn, 'type_arguments'), fn)),
        arguments: args,
        ...spanOf(node),
      };
    }
    return {
      kind: 'call',
      callee: this.objectOf(node, 'function'),
      typeArguments: undefined,
      arguments: args,
      ...spanOf(node),
    };
  }

  protected convertArguments(node: Node): Arguments {
    const positional: Expression[] = [];
    const named: NamedArgument[] = [];
    const order: Arguments['order'] = [];
    const children = childrenOf(node).filter((child) => child.type !== '(' && child.type !== ')');
    for (const group of splitByComma(children)) {
      if (group.length === 0) continue;
      if (group[0].type === 'named_argument') {
        if (group.length > 1) return syntaxError(group[1], '書き方に誤りがあります。');
        named.push(this.convertNamedArgument(group[0]));
        order.push({ kind: 'named', index: named.length - 1 });
      } else {
        positional.push(this.soleExpression(node, group));
        order.push({ kind: 'positional', index: positional.length - 1 });
      }
    }
    return { positional, named, order, ...spanOf(node) };
  }

  private convertNamedArgument(node: Node): NamedArgument {
    const label = requireNode(
      namedOf(node).find((child) => child.type === 'label'),
      node
    );
    const name = requireNode(
      namedOf(label).find((child) => child.type === 'identifier'),
      label
    ).text;
    const rest = childrenOf(node).filter((child) => child.id !== label.id);
    return { name, value: this.soleExpression(node, rest), ...spanOf(node) };
  }

  private convertNew(node: Node): Expression {
    const typeNode = requireNode(fieldOf(node, 'type'), node);
    return {
      kind: 'new',
      type: this.convertType(typeNode),
      constructorName: fieldOf(node, 'constructor')?.text,
      arguments: this.convertArguments(requireNode(fieldOf(node, 'arguments'), node)),
      isConst: node.type === 'const_object_expression',
      isSelectorCall: false,
      ...spanOf(node),
    };
  }

  private convertConstructorInvocation(node: Node): Expression {
    return {
      kind: 'new',
      type: this.constructorType(node, fieldsOf(node, 'type')),
      constructorName: fieldOf(node, 'constructor')?.text,
      arguments: this.convertArguments(requireNode(fieldOf(node, 'arguments'), node)),
      isConst: false,
      isSelectorCall: true,
      ...spanOf(node),
    };
  }

  private convertConstructorTearoff(node: Node): Expression {
    const nameNode = childrenOf(node).at(-1);
    return {
      kind: 'constructorTearoff',
      type: this.constructorType(node, namedOf(node)),
      name: nameNode?.type === 'new' ? undefined : nameNode?.text,
      ...spanOf(node),
    };
  }

  private constructorType(node: Node, parts: Node[]): TypeSyntax {
    const identifiers = parts.filter((child) => child.type === 'type_identifier');
    const typeArguments = namedOf(node).find((child) => child.type === 'type_arguments');
    return {
      kind: 'named',
      prefix: identifiers.length > 1 ? identifiers[0].text : undefined,
      name: identifiers.at(-1)?.text ?? '',
      args: typeArguments ? this.convertTypeArguments(typeArguments) : [],
      nullable: false,
      ...spanOf(node),
    };
  }

  private convertDotShorthand(node: Node): Expression {
    const nameNode = childrenOf(node).find((child) => child.type === 'identifier' || child.type === 'new');
    const args = namedOf(node).find((child) => child.type === 'arguments');
    return {
      kind: 'dotShorthand',
      name: nameNode?.type === 'identifier' ? nameNode.text : 'new',
      arguments: args ? this.convertArguments(args) : undefined,
      isConst: hasToken(node, 'const'),
      ...spanOf(node),
    };
  }

  private convertFunctionExpression(node: Node): Expression {
    const parameters = fieldsOf(node, 'parameters');
    const typeParameters = parameters.find((child) => child.type === 'type_parameters');
    const formal = requireNode(
      parameters.find((child) => child.type === 'formal_parameter_list'),
      node
    );
    return {
      kind: 'function',
      typeParameters: this.convertTypeParameters(typeParameters),
      parameters: this.convertFormalParameters(formal),
      body: this.convertFunctionBody(requireNode(fieldOf(node, 'body'), node)),
      ...spanOf(node),
    };
  }

  private convertListLiteral(node: Node): Expression {
    const typeArguments = namedOf(node).find((child) => child.type === 'type_arguments');
    return {
      kind: 'list',
      typeArguments: typeArguments ? this.convertTypeArguments(typeArguments) : undefined,
      elements: this.convertElements(node),
      isConst: hasToken(node, 'const'),
      ...spanOf(node),
    };
  }

  private convertSetOrMapLiteral(node: Node): Expression {
    const typeArguments = namedOf(node).find((child) => child.type === 'type_arguments');
    return {
      kind: 'setOrMap',
      typeArguments: typeArguments ? this.convertTypeArguments(typeArguments) : undefined,
      elements: this.convertElements(node),
      isConst: hasToken(node, 'const'),
      ...spanOf(node),
    };
  }

  private convertElements(node: Node): CollectionElement[] {
    const children = childrenOf(node).filter((child) => child.type !== 'type_arguments');
    const elements: CollectionElement[] = [];
    for (const child of children) {
      if (child.type === 'cascade_section') {
        const last = elements.pop();
        if (!last || !isExpression(last)) return syntaxError(child, '書き方に誤りがあります。');
        elements.push(this.appendCascade(last, child));
        continue;
      }
      if (!child.isNamed || child.type === 'comment') continue;
      elements.push(this.convertElement(child));
    }
    return elements;
  }

  protected convertElement(node: Node): CollectionElement {
    const span = spanOf(node);
    switch (node.type) {
      case 'spread_element': {
        return {
          kind: 'spread',
          value: this.fieldExpression(node, 'value'),
          nullAware: hasToken(node, '...?'),
          ...span,
        };
      }
      case 'null_aware_element': {
        return { kind: 'nullAwareElement', value: this.soleExpression(node), ...span };
      }
      case 'pair':
      case 'null_aware_pair': {
        const valueNode = requireNode(fieldOf(node, 'value'), node);
        const nullAwareValue = valueNode.type === 'null_aware_element';
        const nullAwareKey = node.type === 'null_aware_pair' && childrenOf(node)[0]?.type === '?';
        return {
          kind: 'mapEntry',
          key: this.fieldExpression(node, 'key'),
          value: nullAwareValue ? this.soleExpression(valueNode) : this.fieldExpression(node, 'value'),
          nullAwareKey,
          nullAwareValue,
          ...span,
        };
      }
      case 'if_element': {
        const caseClause = namedOf(node).find((child) => child.type === 'if_case_clause');
        const alternative = fieldsOf(node, 'alternative');
        return {
          kind: 'ifElement',
          condition: this.fieldExpression(node, 'condition'),
          casePattern: caseClause ? this.convertCaseClause(caseClause) : undefined,
          consequent: this.elementField(node, 'consequence'),
          alternative: alternative.length > 0 ? this.elementField(node, 'alternative') : undefined,
          ...span,
        };
      }
      case 'for_element': {
        const loop = this.convertForParts(node);
        const body = this.elementField(node, 'body');
        if (loop.kind === 'forIn') {
          return { kind: 'forInElement', binding: loop.binding, iterable: loop.iterable, body, ...span };
        }
        return { kind: 'forElement', init: loop.init, condition: loop.condition, updates: loop.updates, body, ...span };
      }
      default: {
        return this.convertExpression(node);
      }
    }
  }

  private elementField(node: Node, field: string): CollectionElement {
    const nodes = fieldsOf(node, field);
    const children = childrenOf(node);
    const first = children.findIndex((child) => child.id === nodes[0]?.id);
    if (first === -1) return syntaxError(node, '書き方に誤りがあります。');
    const element = this.convertElement(children[first]);
    let result = element;
    for (const child of children.slice(first + 1)) {
      if (child.type !== 'cascade_section') break;
      if (!isExpression(result)) return syntaxError(child, '書き方に誤りがあります。');
      result = this.appendCascade(result, child);
    }
    return result;
  }

  private convertRecordLiteral(node: Node): Expression {
    // A record of one field has no record_field node; its parts sit directly in the literal.
    const children = childrenOf(node).filter(
      (child) => child.type !== '(' && child.type !== ')' && child.type !== 'const'
    );
    const groups = children.some((child) => child.type === 'record_field')
      ? children.filter((child) => child.type === 'record_field').map((field) => childrenOf(field))
      : splitByComma(children).filter((group) => group.length > 0);
    const fields: RecordLiteralField[] = groups.map((group) => {
      const label = group.find((child) => child.type === 'label');
      const rest = group.filter((child) => child.id !== label?.id);
      const value = this.soleExpression(node, rest);
      const name = label ? requireNode(namedOf(label)[0], label).text : undefined;
      return { ...spanOf(label ?? group[0]), name, value };
    });
    return { kind: 'record', fields, isConst: hasToken(node, 'const'), ...spanOf(node) };
  }

  private convertSwitchExpression(node: Node): Expression {
    const subject = this.soleExpression(requireNode(fieldOf(node, 'condition'), node));
    const cases = fieldsOf(node, 'body')
      .filter((child) => child.type === 'switch_expression_case')
      .map((child) => this.convertSwitchExpressionCase(child));
    return { kind: 'switch', subject, cases, ...spanOf(node) };
  }

  private convertSwitchExpressionCase(node: Node): SwitchExpressionCase {
    const children = childrenOf(node);
    const arrow = children.findIndex((child) => child.type === '=>');
    const when = children.findIndex((child) => child.type === 'when');
    const patternEnd = when !== -1 ? when : arrow;
    return {
      pattern: this.convertPatternSequence(node, children.slice(0, patternEnd), 'matching'),
      guard: when !== -1 ? this.soleExpression(node, children.slice(when + 1, arrow)) : undefined,
      body: this.soleExpression(node, children.slice(arrow + 1)),
      ...spanOf(node),
    };
  }

  protected convertCaseClause(node: Node): { pattern: Pattern; guard: Expression | undefined } {
    const children = childrenOf(node).filter((child) => child.type !== 'case');
    const when = children.findIndex((child) => child.type === 'when');
    const patternNodes = when !== -1 ? children.slice(0, when) : children;
    return {
      pattern: this.convertPatternSequence(node, patternNodes, 'matching'),
      guard: when !== -1 ? this.soleExpression(node, children.slice(when + 1)) : undefined,
    };
  }

  private convertPatternAssignment(node: Node): Expression {
    const children = childrenOf(node);
    const equals = children.findIndex((child) => child.type === '=');
    return {
      kind: 'patternAssign',
      pattern: this.convertPatternSequence(node, children.slice(0, equals), 'assignment'),
      value: this.soleExpression(node, children.slice(equals + 1)),
      ...spanOf(node),
    };
  }

  // Patterns

  /**
   * Parses the flat sequence of pattern nodes and tokens that the grammar gives for a pattern with `||`, `&&`,
   * relational operators, and parentheses.
   *
   * @param context In a declaration, a bare name declares a variable; in an assignment, it assigns one; in a
   * matching context (a case), it is a constant.
   */
  // code-gauge-allow functionCognitiveComplexity 24 -- One case per kind of node in the grammar.
  // code-gauge-allow functionNcss 46 -- One case per kind of node in the grammar.
  protected convertPatternSequence(parent: Node, nodes: Node[], context: PatternContext): Pattern {
    const tokens = nodes.filter((child) => child.type !== 'comment' && child.type !== ',');
    let position = 0;
    const peek = (): Node | undefined => tokens[position];
    const parseOr = (): Pattern => {
      let left = parseAnd();
      while (peek()?.type === '||') {
        position++;
        const right = parseAnd();
        left = { kind: 'or', left, right, ...spanOf(parent), row: left.row, start: left.start };
      }
      return left;
    };
    const parseAnd = (): Pattern => {
      let left = parsePrimary();
      while (peek()?.type === '&&') {
        position++;
        const right = parsePrimary();
        left = { kind: 'and', left, right, ...spanOf(parent), row: left.row, start: left.start };
      }
      return left;
    };
    const parsePrimary = (): Pattern => {
      const token = peek();
      if (!token) return syntaxError(parent, '書き方に誤りがあります。');
      position++;
      if (token.type === '(') {
        const inner = parseOr();
        if (peek()?.type !== ')') return syntaxError(parent, '書き方に誤りがあります。');
        position++;
        return { kind: 'parenthesized', pattern: inner, ...spanOf(token) };
      }
      if (token.type === 'relational_operator' || token.type === '==' || token.type === '!=') {
        const operand = peek();
        if (!operand) return syntaxError(parent, '書き方に誤りがあります。');
        position++;
        let value = this.convertExpression(operand);
        while (peek()?.type === 'cascade_section') {
          value = this.appendCascade(value, tokens[position]);
          position++;
        }
        return { kind: 'relational', operator: token.text, value, ...spanOf(token) };
      }
      if (PATTERN_NODES.has(token.type)) return this.convertPattern(token, context);
      return syntaxError(token, '書き方に誤りがあります。');
    };
    const pattern = parseOr();
    if (position !== tokens.length) return syntaxError(parent, '書き方に誤りがあります。');
    return pattern;
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- One case per kind of pattern node in the grammar.
  // code-gauge-allow functionNcss 42 -- One case per kind of pattern node in the grammar.
  protected convertPattern(node: Node, context: PatternContext): Pattern {
    const span = spanOf(node);
    switch (node.type) {
      case 'constant_pattern': {
        return this.convertConstantPattern(node, context);
      }
      case 'variable_pattern': {
        const name = requireNode(fieldOf(node, 'name'), node).text;
        const typeNode = namedOf(node).find((child) => child.type === 'type');
        const type = typeNode ? this.convertType(typeNode) : undefined;
        const keyword = hasToken(node, 'var') || hasToken(node, 'final') || type !== undefined;
        if (name === '_') return { kind: 'wildcard', type, ...span };
        if (context === 'assignment' && keyword) {
          return syntaxError(node, 'パターンによる代入では、新しい変数を宣言できません。');
        }
        if (context === 'assignment') return { kind: 'assignedVariable', name, ...span };
        return { kind: 'variable', name, type, isFinal: hasToken(node, 'final'), keyword, ...span };
      }
      case 'cast_pattern': {
        const inner = namedOf(node).filter((child) => child.type !== 'type');
        return {
          kind: 'cast',
          pattern: this.convertPatternSequence(node, inner, context),
          type: this.convertType(requireNode(fieldOf(node, 'type'), node)),
          ...span,
        };
      }
      case 'null_check_pattern':
      case 'null_assert_pattern': {
        const inner = childrenOf(node).filter((child) => child.type !== '?' && child.type !== '!');
        return {
          kind: node.type === 'null_check_pattern' ? 'nullCheck' : 'nullAssert',
          pattern: this.convertPatternSequence(node, inner, context),
          ...span,
        };
      }
      case 'list_pattern': {
        return this.convertListPattern(node, context);
      }
      case 'map_pattern': {
        return this.convertMapPattern(node, context);
      }
      case 'record_pattern': {
        const fields = this.convertPatternFields(node, childrenOf(node), context);
        // `(p)` is a parenthesized pattern; a record of one positional field needs a trailing comma.
        if (fields.length === 1 && fields[0].name === undefined && !hasTrailingComma(node)) {
          return { kind: 'parenthesized', pattern: fields[0].pattern, ...span };
        }
        return { kind: 'record', fields, ...span };
      }
      case 'object_pattern': {
        const children = childrenOf(node);
        const typeEnd = children.findIndex((child) => child.type === '(');
        const typeNodes = children.slice(0, typeEnd);
        return {
          kind: 'object',
          type: this.convertTypeFromParts(node, typeNodes),
          fields: this.convertPatternFields(node, children.slice(typeEnd), context),
          ...span,
        };
      }
      case 'rest_pattern': {
        return syntaxError(node, '... はリストのパターンの中にしか書けません。');
      }
      default: {
        return syntaxError(node, '書き方に誤りがあります。');
      }
    }
  }

  private convertConstantPattern(node: Node, context: PatternContext): Pattern {
    const span = spanOf(node);
    const children = childrenOf(node).filter((child) => child.type !== 'comment');
    const named = children.filter((child) => child.isNamed);
    if (named.length === 1 && named[0].type === 'identifier' && children.length === 1) {
      const name = named[0].text;
      if (name === '_') return { kind: 'wildcard', type: undefined, ...span };
      if (context === 'declaration')
        return { kind: 'variable', name, type: undefined, isFinal: false, keyword: false, ...span };
      if (context === 'assignment') return { kind: 'assignedVariable', name, ...span };
    }
    if (hasToken(node, 'const')) {
      const rest = children.filter((child) => child.type !== 'const');
      return { kind: 'constant', value: this.constantPatternExpression(node, rest, true), ...span };
    }
    return { kind: 'constant', value: this.constantPatternExpression(node, children, false), ...span };
  }

  /**
   * The expression of a constant pattern, which the grammar flattens: `-1`, `Color.red`, `m.pi`, `const [1]`, or
   * `const Point(1, 2)`.
   */
  // code-gauge-allow functionCognitiveComplexity 21 -- One case per kind of node in the grammar.
  private constantPatternExpression(node: Node, children: Node[], isConst: boolean): Expression {
    const span = spanOf(node);
    if (children[0]?.type === '.' && children.length === 2) {
      return {
        kind: 'dotShorthand',
        name: children[1].type === 'new' ? 'new' : children[1].text,
        arguments: undefined,
        isConst,
        ...span,
      };
    }
    if (children.length === 1 && children[0].type === 'static_member_shorthand')
      return this.convertExpression(children[0]);
    if (children[0]?.type === '-') {
      const operand = this.constantPatternExpression(node, children.slice(1), isConst);
      return { kind: 'prefix', operator: '-', operand, ...span };
    }
    if (isConst) {
      const collection = this.constCollectionPattern(node, children, span);
      if (collection) return collection;
    }
    const creation = this.constCreationPattern(node, children, isConst, span);
    if (creation) return creation;
    const tokens = children.flatMap((child) => (child.type === 'qualified' ? childrenOf(child) : [child]));
    const parts = tokens.filter((child) => child.type === 'identifier' || child.type === 'type_identifier');
    if (
      parts.length > 1 &&
      tokens.every((child) => child.type === '.' || child.type === 'identifier' || child.type === 'type_identifier')
    ) {
      let expression: Expression = { kind: 'identifier', name: parts[0].text, ...spanOf(parts[0]) };
      for (const part of parts.slice(1)) {
        expression = { kind: 'member', object: expression, name: part.text, nullAware: false, ...span };
      }
      return expression;
    }
    const expression = this.soleExpression(node, children);
    if (isConst && expression.kind === 'record') return { ...expression, isConst: true };
    return expression;
  }

  /** `const [...]`, `const <T>[...]`, and `const {...}` in a constant pattern. */
  private constCollectionPattern(node: Node, children: Node[], span: Span): Expression | undefined {
    if (children[0]?.type === '[') {
      return {
        kind: 'list',
        typeArguments: undefined,
        elements: this.elementsOf(node, children),
        isConst: true,
        ...span,
      };
    }
    if (children[0]?.type === 'type_arguments' && children[1]?.type === '[') {
      return {
        kind: 'list',
        typeArguments: this.convertTypeArguments(children[0]),
        elements: this.elementsOf(node, children.slice(1)),
        isConst: true,
        ...span,
      };
    }
    if (children[0]?.type === '{' || (children[0]?.type === 'type_arguments' && children[1]?.type === '{')) {
      const typeArguments = children[0].type === 'type_arguments' ? this.convertTypeArguments(children[0]) : undefined;
      return {
        kind: 'setOrMap',
        typeArguments,
        elements: this.elementsOf(node, children.slice(typeArguments ? 1 : 0)),
        isConst: true,
        ...span,
      };
    }
    return undefined;
  }

  /** A creation `const C(...)` in a constant pattern. */
  private constCreationPattern(node: Node, children: Node[], isConst: boolean, span: Span): Expression | undefined {
    const argumentsNode = children.find((child) => child.type === 'arguments');
    const parts = children.filter((child) => child.type === 'identifier' || child.type === 'type_identifier');
    if (argumentsNode || (isConst && children.some((child) => child.type === 'type_arguments'))) {
      const typeArguments = children.find((child) => child.type === 'type_arguments');
      const type: TypeSyntax = {
        kind: 'named',
        prefix: undefined,
        name: parts[0]?.text ?? '',
        args: typeArguments ? this.convertTypeArguments(typeArguments) : [],
        nullable: false,
        ...span,
      };
      return {
        kind: 'new',
        type,
        constructorName: parts[1]?.text,
        arguments: this.convertArguments(requireNode(argumentsNode, node)),
        isConst: true,
        isSelectorCall: false,
        ...span,
      };
    }
    return undefined;
  }

  private elementsOf(node: Node, children: Node[]): CollectionElement[] {
    return children
      .filter((child) => child.isNamed && child.type !== 'comment')
      .map((child) => this.convertElement(child));
  }

  // code-gauge-allow duplicateLines 19 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  private convertListPattern(node: Node, context: PatternContext): Pattern {
    const children = childrenOf(node);
    const typeArguments = children.find((child) => child.type === 'type_arguments');
    const inner = children.slice(children.findIndex((child) => child.type === '[') + 1, -1);
    const elements: ListPatternElement[] = [];
    for (const group of splitByComma(inner)) {
      if (group.length === 0) continue;
      if (group.length === 1 && group[0].type === 'rest_pattern') {
        const restInner = childrenOf(group[0]).filter((child) => child.type !== '...');
        elements.push({
          kind: 'rest',
          pattern: restInner.length > 0 ? this.convertPatternSequence(group[0], restInner, context) : undefined,
          ...spanOf(group[0]),
        });
        continue;
      }
      elements.push(this.convertPatternSequence(node, group, context));
    }
    return {
      kind: 'list',
      typeArguments: typeArguments ? this.convertTypeArguments(typeArguments) : undefined,
      elements,
      ...spanOf(node),
    };
  }

  // code-gauge-allow duplicateLines 19 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  private convertMapPattern(node: Node, context: PatternContext): Pattern {
    const children = childrenOf(node);
    const typeArguments = children.find((child) => child.type === 'type_arguments');
    const inner = children.slice(children.findIndex((child) => child.type === '{') + 1, -1);
    const entries: { key: Expression; value: Pattern }[] = [];
    for (const group of splitByComma(inner)) {
      if (group.length === 0) continue;
      if (group.length === 1 && group[0].type === 'rest_pattern') {
        return syntaxError(group[0], 'マップのパターンに ... は書けません。');
      }
      const colon = group.findIndex((child) => child.type === ':');
      if (colon === -1) return syntaxError(node, '書き方に誤りがあります。');
      entries.push({
        key: this.soleExpression(node, group.slice(0, colon)),
        value: this.convertPatternSequence(node, group.slice(colon + 1), context),
      });
    }
    return {
      kind: 'map',
      typeArguments: typeArguments ? this.convertTypeArguments(typeArguments) : undefined,
      entries,
      ...spanOf(node),
    };
  }

  /** The fields of a record or object pattern: `name: p`, `:var name`, or a positional `p`. */
  private convertPatternFields(node: Node, children: Node[], context: PatternContext): RecordPatternField[] {
    const open = children.findIndex((child) => child.type === '(');
    const inner = children.slice(open + 1, -1);
    const fields: RecordPatternField[] = [];
    for (const group of splitByComma(inner)) {
      if (group.length === 0) continue;
      const span = spanOf(group[0]);
      if (group[0].type === 'label') {
        const name = requireNode(namedOf(group[0])[0], group[0]).text;
        fields.push({ name, pattern: this.convertPatternSequence(node, group.slice(1), context), ...span });
        continue;
      }
      if (group[0].type === ':') {
        const pattern = this.convertPatternSequence(node, group.slice(1), context);
        const name = variableNameOf(pattern);
        if (name === undefined)
          return syntaxError(group[0], 'フィールドの名前を省くには、変数のパターンを書いてください。');
        fields.push({ name, pattern, ...span });
        continue;
      }
      fields.push({ name: undefined, pattern: this.convertPatternSequence(node, group, context), ...span });
    }
    return fields;
  }

  // Strings

  // code-gauge-allow functionCognitiveComplexity 22 -- One case per kind of node in the grammar.
  private convertStringParts(node: Node): StringPart[] {
    const parts: StringPart[] = [];
    const pushText = (text: string): void => {
      if (typeof parts.at(-1) === 'string') parts[parts.length - 1] = `${parts.at(-1) as string}${text}`;
      else parts.push(text);
    };
    for (const literal of namedOf(node)) {
      const isRaw = literal.type.startsWith('raw_');
      const isMultiline = literal.type.endsWith('_multiple');
      const pieces = childrenOf(literal).filter((child) => child.type !== 'comment');
      // The opening and closing quote tokens.
      const inner = pieces.slice(1, -1);
      for (const [index, piece] of inner.entries()) {
        let text: string | undefined;
        if (piece.type === 'escape_sequence') {
          text = isRaw ? piece.text : unescape(piece);
        } else if (piece.type === 'template_substitution') {
          parts.push(this.convertSubstitution(piece));
          continue;
        } else {
          text = isMultiline && index === 0 ? stripFirstNewline(piece.text) : piece.text;
        }
        pushText(text);
      }
      if (inner.length === 0) pushText('');
    }
    return parts;
  }

  private convertSubstitution(node: Node): Expression {
    const named = namedOf(node);
    if (
      named.length === 1 &&
      (named[0].type === 'identifier_dollar_escaped' || (named[0].type === 'identifier' && !hasToken(node, '{')))
    ) {
      const identifier = named[0];
      const span = spanOf(identifier);
      if (identifier.text === 'this') return { kind: 'this', ...span };
      return { kind: 'identifier', name: identifier.text, ...span };
    }
    const children = childrenOf(node).filter(
      (child) => child.type !== '$' && child.type !== '{' && child.type !== '}' && child.type !== '${'
    );
    return this.soleExpression(node, children);
  }

  // Types

  convertType(node: Node): TypeSyntax {
    const span = spanOf(node);
    const children = childrenOf(node).filter((child) => child.type !== 'comment');
    const nullable = children.at(-1)?.type === '?';
    const first = children.find((child) => child.isNamed);
    // The bare type `Function` is a keyword token rather than a type identifier.
    if (!first && children.some((child) => child.type === 'Function')) {
      return { kind: 'named', prefix: undefined, name: 'Function', args: [], nullable, ...span };
    }
    if (!first) return syntaxError(node, '型の書き方に誤りがあります。');
    switch (first.type) {
      case 'void_type': {
        return { kind: 'void', ...span };
      }
      case 'function_type': {
        const type = this.convertFunctionType(first) as Extract<TypeSyntax, { kind: 'function' }>;
        return { ...type, nullable: nullable || type.nullable };
      }
      case 'record_type': {
        const type = this.convertRecordType(first) as Extract<TypeSyntax, { kind: 'record' }>;
        return { ...type, nullable };
      }
      default: {
        const type = this.convertTypeFromParts(node, children);
        return type;
      }
    }
  }

  /** A named type written as tokens (`m.Random<int>?`), as in a type node or before an object pattern's fields. */
  protected convertTypeFromParts(node: Node, children: Node[]): TypeSyntax {
    const identifiers = children.filter((child) => child.type === 'type_identifier' || child.type === 'identifier');
    const typeArguments = children.find((child) => child.type === 'type_arguments');
    if (identifiers.length === 0 || identifiers.length > 2) return syntaxError(node, '型の書き方に誤りがあります。');
    return {
      kind: 'named',
      prefix: identifiers.length === 2 ? identifiers[0].text : undefined,
      name: (identifiers.at(-1) as Node).text,
      args: typeArguments ? this.convertTypeArguments(typeArguments) : [],
      nullable: children.at(-1)?.type === '?',
      ...spanOf(node),
    };
  }

  protected convertTypeArguments(node: Node): TypeSyntax[] {
    return namedOf(node)
      .filter((child) => child.type === 'type')
      .map((child) => this.convertType(child));
  }

  private convertFunctionType(node: Node): TypeSyntax {
    const children = childrenOf(node);
    const functionIndex = children.findIndex((child) => child.type === 'Function');
    const returnNode = children.slice(0, functionIndex).find((child) => child.type === 'type');
    const typeParameters = children.find((child) => child.type === 'type_parameters');
    const parameterList = children.find((child) => child.type === 'parameter_type_list');
    // A nested function type, as the result of `int Function(int) Function()`, nests its nodes.
    const innerFunction = children.slice(functionIndex + 1).find((child) => child.type === 'function_type');
    const type: TypeSyntax = {
      kind: 'function',
      returnType: returnNode ? this.convertType(returnNode) : undefined,
      typeParameters: this.convertTypeParameters(typeParameters),
      parameters: parameterList
        ? this.convertParameterTypes(parameterList)
        : { positional: [], requiredCount: 0, named: [] },
      nullable: children.slice(functionIndex).some((child) => child.type === '?'),
      ...spanOf(node),
    };
    if (innerFunction) return syntaxError(node, '型の書き方に誤りがあります。');
    return type;
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- One case per kind of node in the grammar.
  private convertParameterTypes(node: Node): ParameterTypes {
    const result: ParameterTypes = { positional: [], requiredCount: 0, named: [] };
    for (const child of namedOf(node)) {
      if (child.type === 'normal_parameter_type') {
        result.positional.push(this.convertNormalParameterType(child));
        result.requiredCount++;
      } else if (child.type === 'optional_parameter_types') {
        for (const group of namedOf(child)) {
          if (group.type === 'optional_positional_parameter_types') {
            for (const parameter of namedOf(group)) result.positional.push(this.convertNormalParameterType(parameter));
          } else {
            result.named.push(...this.convertNamedParameterTypes(group));
          }
        }
      }
    }
    return result;
  }

  private convertNamedParameterTypes(group: Node): ParameterTypes['named'] {
    const named: ParameterTypes['named'] = [];
    let isRequired = false;
    for (const part of childrenOf(group)) {
      if (part.type === 'required') isRequired = true;
      if (part.type !== 'typed_identifier') continue;
      named.push({
        name: requireNode(fieldOf(part, 'name'), part).text,
        type: this.convertType(requireNode(fieldOf(part, 'type'), part)),
        isRequired,
      });
      isRequired = false;
    }
    return named;
  }

  private convertNormalParameterType(node: Node): { name: string | undefined; type: TypeSyntax } {
    const typed = namedOf(node).find((child) => child.type === 'typed_identifier');
    if (typed) {
      return {
        name: requireNode(fieldOf(typed, 'name'), typed).text,
        type: this.convertType(requireNode(fieldOf(typed, 'type'), typed)),
      };
    }
    return {
      name: undefined,
      type: this.convertType(
        requireNode(
          namedOf(node).find((child) => child.type === 'type'),
          node
        )
      ),
    };
  }

  private convertRecordType(node: Node): TypeSyntax {
    const positional: TypeSyntax[] = [];
    const named: { name: string; type: TypeSyntax }[] = [];
    for (const child of namedOf(node)) {
      if (child.type === 'record_type_field') {
        positional.push(this.convertType(requireNode(fieldOf(child, 'type'), child)));
      } else if (child.type === 'record_type_named_field') {
        const typed = requireNode(
          namedOf(child).find((part) => part.type === 'typed_identifier'),
          child
        );
        named.push({
          name: requireNode(fieldOf(typed, 'name'), typed).text,
          type: this.convertType(requireNode(fieldOf(typed, 'type'), typed)),
        });
      }
    }
    return { kind: 'record', positional, named, nullable: false, ...spanOf(node) };
  }

  // Loops shared by statements and collection elements

  protected convertForParts(node: Node):
    | {
        kind: 'for';
        init: VariableDeclaration | Expression[] | undefined;
        condition: Expression | undefined;
        updates: Expression[];
      }
    | { kind: 'forIn'; binding: ForInBinding; iterable: Expression } {
    if (hasToken(node, 'await')) return unsupported(node, 'await for（非同期処理）');
    const children = childrenOf(node);
    const inIndex = children.findIndex((child) => child.type === 'in');
    if (inIndex !== -1) {
      const open = children.findIndex((child) => child.type === '(');
      const bindingNodes = children.slice(open + 1, inIndex).filter((child) => child.type !== 'comment');
      return {
        kind: 'forIn',
        binding: this.convertForInBinding(node, bindingNodes),
        iterable: this.fieldExpression(node, 'value'),
      };
    }
    const initNodes = fieldsOf(node, 'init');
    let init: VariableDeclaration | Expression[] | undefined;
    if (initNodes.length === 1 && initNodes[0].type === 'local_variable_declaration') {
      init = this.convertLocalDeclaration(initNodes[0]);
    } else if (initNodes.length > 0) {
      init = this.fieldExpressions(node, 'init');
    }
    const conditionNodes = fieldsOf(node, 'condition');
    return {
      kind: 'for',
      init,
      condition: conditionNodes.length > 0 ? this.fieldExpression(node, 'condition') : undefined,
      updates: this.fieldExpressions(node, 'update'),
    };
  }

  /** Every expression in a repeated field, each with the cascade sections after it. */
  private fieldExpressions(node: Node, field: string): Expression[] {
    const ids = new Set(fieldsOf(node, field).map((child) => child.id));
    const children = childrenOf(node);
    const result: Expression[] = [];
    for (const [index, child] of children.entries()) {
      if (!ids.has(child.id)) continue;
      let end = index + 1;
      while (end < children.length && children[end].type === 'cascade_section') end++;
      result.push(this.soleExpression(node, children.slice(index, end)));
    }
    return result;
  }

  private convertForInBinding(node: Node, nodes: Node[]): ForInBinding {
    const annotations = nodes.filter((child) => child.type === 'annotation');
    const parts = nodes.filter((child) => child.type !== 'annotation');
    const span = spanOf(parts[0] ?? node);
    void annotations;
    const isFinal = parts.some((child) => child.type === 'final');
    const keyword = parts.some((child) => child.type === 'final' || child.type === 'var');
    const rest = parts.filter((child) => child.type !== 'final' && child.type !== 'var');
    const patternNode = rest.find((child) => PATTERN_NODES.has(child.type));
    if (patternNode) {
      return { kind: 'pattern', isFinal, pattern: this.convertPattern(patternNode, 'declaration'), ...span };
    }
    const typeNode = rest.find((child) => child.type === 'type');
    if (typeNode && parts.some((child) => child.type === 'var')) {
      return syntaxError(typeNode, VAR_WITH_TYPE);
    }
    const nameNode = rest.find((child) => child.type === 'identifier');
    if (!nameNode) return syntaxError(node, '書き方に誤りがあります。');
    if (!keyword && !typeNode) return { kind: 'identifier', name: nameNode.text, ...span };
    return {
      kind: 'declaration',
      isFinal,
      type: typeNode ? this.convertType(typeNode) : undefined,
      name: nameNode.text,
      ...span,
    };
  }
}

export type PatternContext = 'declaration' | 'assignment' | 'matching';

function isExpression(element: CollectionElement): element is Expression {
  return !['spread', 'nullAwareElement', 'ifElement', 'forElement', 'forInElement', 'mapEntry'].includes(element.kind);
}

function splitByComma(nodes: Node[]): Node[][] {
  const groups: Node[][] = [[]];
  for (const node of nodes) {
    if (node.type === 'comment') continue;
    if (node.type === ',') groups.push([]);
    else (groups.at(-1) as Node[]).push(node);
  }
  return groups;
}

function hasTrailingComma(node: Node): boolean {
  const children = childrenOf(node).filter((child) => child.type !== 'comment');
  return children.at(-2)?.type === ',';
}

function variableNameOf(pattern: Pattern): string | undefined {
  switch (pattern.kind) {
    case 'variable':
    case 'assignedVariable': {
      return pattern.name;
    }
    case 'nullCheck':
    case 'nullAssert':
    case 'cast': {
      return variableNameOf(pattern.pattern);
    }
    default: {
      return undefined;
    }
  }
}

const SIMPLE_ESCAPES: Record<string, string> = { n: '\n', r: '\r', f: '\f', b: '\b', t: '\t', v: '\v' };

function unescape(node: Node): string {
  const body = node.text.slice(1);
  const simple = SIMPLE_ESCAPES[body];
  if (simple !== undefined) return simple;
  if (body.startsWith('x')) return String.fromCodePoint(Number.parseInt(body.slice(1), 16));
  if (body.startsWith('u{')) {
    const code = Number.parseInt(body.slice(2, -1), 16);
    if (code > 0x10_ff_ff) return syntaxError(node, 'Unicode のコードポイントが大きすぎます。');
    return String.fromCodePoint(code);
  }
  if (body.startsWith('u')) return String.fromCodePoint(Number.parseInt(body.slice(1), 16));
  if (body.startsWith('\r\n')) return '';
  if (body === '\n' || body === '\r') return '';
  return body;
}

/** A multi-line string drops its first line when that holds only blanks (and an optional backslash). */
function stripFirstNewline(text: string): string {
  const match = /^[ \t]*\\?[ \t]*(\r\n|\n|\r)/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

export type { Span };

/** The operands of an operator, where `this` and `super` are anonymous tokens of the grammar. */
function operandsOf(node: Node): Node[] {
  return childrenOf(node).filter((child) => child.isNamed || child.type === 'this' || child.type === 'super');
}

export const VAR_WITH_TYPE = 'var と型の名前は、一緒には書けません。どちらか一方にしてください。';
