import type { Node } from '@willbooster/web-tree-sitter';

import type { Argument, Expression, ObjectMember, Pattern, PropertyName } from './ast';
import { ConverterBase } from './converterBase';
import {
  accessorOf,
  calleeText,
  checkBindingName,
  fail,
  field,
  keyName,
  nameAnonymous,
  namedChildren,
  rowOf,
  unsupported,
  unsupportedFeatures,
  unwrapParentheses,
} from './convertNodes';
import { decodeStringLiteral, decodeTemplateFragment, parseNumberLiteral } from './literals';

type ExpressionConverterFunction = (node: Node) => Expression;

const assignableTypes = new Set(['identifier', 'member_expression', 'subscript_expression']);

export abstract class ExpressionConverter extends ConverterBase {
  private readonly expressionConverters: Record<string, ExpressionConverterFunction> = {
    number: (node) => ({ kind: 'literal', value: this.number(node), row: rowOf(node) }),
    string: (node) => ({
      kind: 'literal',
      value: decodeStringLiteral(node.text),
      row: rowOf(node),
    }),
    template_string: (node) => this.template(node),
    regex: (node) => regexLiteral(node),
    true: (node) => ({ kind: 'literal', value: true, row: rowOf(node) }),
    false: (node) => ({ kind: 'literal', value: false, row: rowOf(node) }),
    // oxlint-disable-next-line unicorn/no-null -- JavaScript null is a value of the interpreted language.
    null: (node) => ({ kind: 'literal', value: null, row: rowOf(node) }),
    undefined: (node) => ({ kind: 'identifier', name: node.text, row: rowOf(node) }),
    identifier: (node) => this.identifierRead(node),
    this: (node) => ({ kind: 'this', row: rowOf(node) }),
    super: (node) => fail(node, 'super は super(...) か super.メソッド名 の形でしか書けません。'),
    array: (node) => ({ kind: 'array', elements: this.arrayElements(node), row: rowOf(node) }),
    object: (node) => ({ kind: 'object', members: this.objectMembers(node), row: rowOf(node) }),
    function_expression: (node) => ({
      kind: 'functionExpression',
      fn: this.functionNode(node, 'normal'),
      row: rowOf(node),
    }),
    generator_function: (node) => ({
      kind: 'functionExpression',
      fn: this.functionNode(node, 'normal'),
      row: rowOf(node),
    }),
    yield_expression: (node) => this.yieldExpression(node),
    await_expression: (node) => this.awaitExpression(node),
    arrow_function: (node) => ({
      kind: 'functionExpression',
      fn: this.functionNode(node, 'arrow'),
      row: rowOf(node),
    }),
    class: (node) => ({
      kind: 'classExpression',
      cls: this.classNode(node, node.childForFieldName('name')?.text ?? ''),
      row: rowOf(node),
    }),
    member_expression: (node) => this.member(node),
    subscript_expression: (node) => this.member(node),
    call_expression: (node) => this.call(node),
    new_expression: (node) => this.newExpression(node),
    assignment_expression: (node) => this.assignment(node, '='),
    augmented_assignment_expression: (node) => this.assignment(node, field(node, 'operator').text),
    update_expression: (node) => this.update(node),
    unary_expression: (node) => this.unary(node),
    binary_expression: (node) => this.binary(node),
    ternary_expression: (node) => ({
      kind: 'conditional',
      test: this.expression(field(node, 'condition')),
      consequent: this.expression(field(node, 'consequence')),
      alternate: this.expression(field(node, 'alternative')),
      row: rowOf(node),
    }),
    sequence_expression: (node) => ({
      kind: 'sequence',
      expressions: namedChildren(node).map((child) => this.expression(child)),
      row: rowOf(node),
    }),
    parenthesized_expression: (node) => ({
      kind: 'parenthesized',
      expression: this.expression(namedChildren(node)[0]),
      row: rowOf(node),
    }),
    meta_property: (node) => this.metaProperty(node),
  };

  expression(node: Node): Expression {
    const convert = this.expressionConverters[node.type] as ExpressionConverterFunction | undefined;
    if (!convert) return unsupported(node, unsupportedFeatures[node.type] ?? `式「${node.type}」`);
    const { context } = this;
    const suspensionsBefore = context.suspensionCount;
    const expression = convert(node);
    if (context.suspensionCount !== suspensionsBefore) {
      expression.suspends = true;
      if (!canSuspendIn(expression)) unsupported(node, 'この位置の yield や await ');
    }
    return expression;
  }

  private awaitExpression(node: Node): Expression {
    const argument = this.expression(namedChildren(node)[0]);
    this.context.suspensionCount++;
    return { kind: 'await', argument, row: rowOf(node) };
  }

  private yieldExpression(node: Node): Expression {
    const argumentNode = namedChildren(node).at(0);
    const argument = argumentNode ? this.expression(argumentNode) : undefined;
    const delegate = node.children.some((child) => child?.type === '*');
    this.context.suspensionCount++;
    return { kind: 'yield', argument, delegate, isAsync: this.context.isAsync, row: rowOf(node) };
  }

  private metaProperty(node: Node): Expression {
    if (node.text !== 'new.target') return unsupported(node, `${node.text} `);
    if (!this.context.canUseNewTarget) fail(node, 'new.target は関数の中にしか書けません。');
    return { kind: 'newTarget', row: rowOf(node) };
  }

  /** Reads a variable by name, noting a read of `arguments`, which the enclosing function then creates. */
  private identifierRead(node: Node): Expression {
    if (node.text === 'arguments') {
      if (this.context.argumentsUse.isForbidden)
        fail(node, 'フィールドの初期値や static ブロックの中では arguments を使えません。');
      this.context.argumentsUse.isUsed = true;
    }
    return { kind: 'identifier', name: node.text, row: rowOf(node) };
  }

  protected parenthesized(node: Node): Expression {
    return this.expression(node.type === 'parenthesized_expression' ? namedChildren(node)[0] : node);
  }

  /** Converts the value of `name = value`, which names an anonymous function after the variable. */
  protected namedValue(node: Node, target: Pattern): Expression {
    const value = this.expression(node);
    if (target.kind === 'identifier') nameAnonymous(value, target.name);
    return value;
  }

  private number(node: Node): number | bigint {
    const value = parseNumberLiteral(node.text);
    if (value === undefined) return unsupported(node, `数値「${node.text}」`);
    return value;
  }

  private template(node: Node): Expression {
    const { raw, expressions } = this.templateParts(node);
    return {
      kind: 'template',
      strings: raw.map((text) => decodeTemplateFragment(text)),
      expressions,
      row: rowOf(node),
    };
  }

  /** The source texts between a template's substitutions, with line breaks normalized to `\n`, and the substitutions. */
  private templateParts(node: Node): { raw: string[]; expressions: Expression[] } {
    const raw: string[] = [''];
    const expressions: Expression[] = [];
    for (const child of node.children) {
      if (child?.type === 'template_substitution') {
        expressions.push(this.expression(namedChildren(child)[0]));
        raw.push('');
      } else if (child?.type === 'string_fragment' || child?.type === 'escape_sequence') {
        raw[raw.length - 1] += child.text.replaceAll(/\r\n?/g, '\n');
      }
    }
    return { raw, expressions };
  }

  /** Converts a tagged template to a call of its tag with the template's strings and substitutions. */
  private taggedTemplate(node: Node, functionNode: Node, template: Node): Expression {
    const row = rowOf(node);
    const { raw, expressions } = this.templateParts(template);
    const cooked = raw.map((text) => (hasInvalidEscape(text) ? undefined : decodeTemplateFragment(text)));
    const strings: Expression = { kind: 'templateObject', cooked, raw, row: rowOf(template) };
    const callee = this.expression(functionNode);
    if (callee.kind === 'member' && callee.optional) fail(node, '?. の後ろにはタグ付きテンプレートを書けません。');
    return {
      kind: 'call',
      callee,
      args: [strings, ...expressions],
      optional: false,
      calleeText: calleeText(functionNode),
      row,
    };
  }

  private assignment(node: Node, operator: string): Expression {
    const left = field(node, 'left');
    if (operator !== '=' && !assignableTypes.has(unwrapParentheses(left).type))
      fail(left, 'この式には代入できません。');
    const target = this.assignmentTarget(left);
    return {
      kind: 'assign',
      operator,
      target,
      value: this.namedValue(field(node, 'right'), target),
      row: rowOf(node),
    };
  }

  private update(node: Node): Expression {
    const argument = unwrapParentheses(field(node, 'argument'));
    if (!assignableTypes.has(argument.type)) fail(argument, 'この式は ++ や -- で変更できません。');
    const operator = field(node, 'operator');
    return {
      kind: 'update',
      operator: operator.text as '++' | '--',
      prefix: operator.startIndex === node.startIndex,
      target: this.assignmentTarget(argument),
      row: rowOf(node),
    };
  }

  private unary(node: Node): Expression {
    const operator = field(node, 'operator').text;
    const argument = field(node, 'argument');
    if (operator === 'delete' && unwrapParentheses(argument).type === 'identifier')
      fail(node, '変数は delete できません。');
    return { kind: 'unary', operator, argument: this.expression(argument), row: rowOf(node) };
  }

  private binary(node: Node): Expression {
    const operator = field(node, 'operator').text;
    const leftNode = field(node, 'left');
    if (leftNode.type === 'private_property_identifier') {
      if (operator !== 'in') fail(leftNode, '# で始まる名前は、in の左か「.」の後ろにしか書けません。');
      return {
        kind: 'privateIn',
        name: leftNode.text,
        right: this.expression(field(node, 'right')),
        row: rowOf(node),
      };
    }
    const left = this.expression(leftNode);
    const right = this.expression(field(node, 'right'));
    if (operator === '&&' || operator === '||' || operator === '??') {
      return { kind: 'logical', operator, left, right, row: rowOf(node) };
    }
    return { kind: 'binary', operator, left, right, row: rowOf(node) };
  }

  /** Converts the elements of an array literal, where a comma without an element leaves a hole. */
  private arrayElements(node: Node): (Argument | undefined)[] {
    return elementsOf(node, (child) => this.argument(child));
  }

  private objectMembers(node: Node): ObjectMember[] {
    let hasPrototype = false;
    return namedChildren(node).map((member): ObjectMember => {
      switch (member.type) {
        case 'pair': {
          const keyNode = field(member, 'key');
          const key = this.propertyName(keyNode);
          const value = this.expression(field(member, 'value'));
          if (keyNode.type !== 'computed_property_name' && key.kind === 'key' && key.key === '__proto__') {
            if (hasPrototype) fail(member, '__proto__ は1つしか書けません。');
            hasPrototype = true;
            return { kind: 'prototype', value };
          }
          if (key.kind === 'key') nameAnonymous(value, key.key);
          return { kind: 'property', key, value };
        }
        case 'shorthand_property_identifier': {
          return {
            kind: 'property',
            key: { kind: 'key', key: member.text },
            value: this.identifierRead(member),
          };
        }
        case 'method_definition': {
          return this.objectMethod(member);
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

  private objectMethod(member: Node): ObjectMember {
    const key = this.propertyName(field(member, 'name'));
    if (key.kind === 'private') fail(member, 'オブジェクトリテラルには # で始まる名前を書けません。');
    const accessor = accessorOf(member);
    if (accessor) return { kind: accessor, key, fn: this.functionNode(member, accessor, keyName(key)) };
    const fn = this.functionNode(member, 'method', keyName(key));
    return { kind: 'property', key, value: { kind: 'functionExpression', fn, row: rowOf(member) } };
  }

  private member(node: Node): Expression {
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
      property = { kind: 'computed', expression: this.expression(field(node, 'index')) };
    }
    return { kind: 'member', object, property, optional, row: rowOf(node) };
  }

  private superReference(node: Node): { kind: 'super'; row: number } {
    if (!this.context.canReferenceSuper) fail(node, 'super.名前 はメソッドの中にしか書けません。');
    return { kind: 'super', row: rowOf(node) };
  }

  private call(node: Node): Expression {
    const functionNode = field(node, 'function');
    const argumentsNode = field(node, 'arguments');
    if (functionNode.type === 'import') unsupported(node, 'import() ');
    if (argumentsNode.type === 'template_string') return this.taggedTemplate(node, functionNode, argumentsNode);
    const args = this.arguments(argumentsNode);
    const row = rowOf(node);
    if (functionNode.type === 'super') {
      if (!this.context.canCallSuper) fail(node, 'super(...) は継承したクラスのコンストラクタの中にしか書けません。');
      return {
        kind: 'call',
        callee: { kind: 'super', row },
        args,
        optional: false,
        calleeText: 'super',
        row,
      };
    }
    const optional = node.childForFieldName('optional_chain') !== null;
    const callee = this.expression(functionNode);
    return { kind: 'call', callee, args, optional, calleeText: calleeText(functionNode), row };
  }

  private newExpression(node: Node): Expression {
    const argumentsNode = node.childForFieldName('arguments');
    const callee = field(node, 'constructor');
    return {
      kind: 'new',
      callee: this.expression(callee),
      args: argumentsNode ? this.arguments(argumentsNode) : [],
      calleeText: calleeText(callee),
      row: rowOf(node),
    };
  }

  private arguments(node: Node): Argument[] {
    return namedChildren(node).map((child) => this.argument(child));
  }

  private argument(node: Node): Argument {
    if (node.type === 'spread_element') return { kind: 'spread', argument: this.expression(namedChildren(node)[0]) };
    return this.expression(node);
  }

  protected propertyName(node: Node): PropertyName {
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

  // Patterns --------------------------------------------------------------------------------------------------------

  /** A pattern that declares variables, calling `declare` for each name. */
  protected bindingPattern(node: Node, declare: (identifier: Node, name: string) => void): Pattern {
    return this.pattern(node, (target) => {
      if (target.type !== 'identifier' && target.type !== 'shorthand_property_identifier_pattern') {
        fail(target, '宣言では変数名しか書けません。');
      }
      checkBindingName(target);
      declare(target, target.text);
      return { kind: 'identifier', name: target.text, row: rowOf(target) };
    });
  }

  /** A pattern that assigns to existing variables and properties. */
  protected assignmentTarget(node: Node): Pattern {
    return this.pattern(node, (target) => {
      const unwrapped = unwrapParentheses(target);
      if (unwrapped.type === 'identifier' || unwrapped.type === 'shorthand_property_identifier_pattern') {
        checkBindingName(unwrapped);
        return { kind: 'identifier', name: unwrapped.text, row: rowOf(unwrapped) };
      }
      if (unwrapped.type !== 'member_expression' && unwrapped.type !== 'subscript_expression') {
        return fail(target, 'この式には代入できません。');
      }
      const member = this.expression(unwrapped);
      if (member.kind !== 'member' || member.optional) fail(unwrapped, '?. を含む式には代入できません。');
      return member;
    });
  }

  private pattern(node: Node, leaf: (node: Node) => Pattern): Pattern {
    switch (node.type) {
      case 'assignment_pattern':
      case 'object_assignment_pattern':
      // An object or array literal used as a pattern spells defaults as assignments.
      case 'assignment_expression': {
        const target = this.pattern(field(node, 'left'), leaf);
        const value = this.expression(field(node, 'right'));
        if (value.suspends) unsupported(node, '分割代入の初期値の yield や await ');
        return {
          kind: 'default',
          target,
          value,
          row: rowOf(node),
        };
      }
      case 'array_pattern':
      case 'array': {
        return this.arrayPattern(node, leaf);
      }
      case 'object_pattern':
      case 'object': {
        return this.objectPattern(node, leaf);
      }
      default: {
        return leaf(node);
      }
    }
  }

  private arrayPattern(node: Node, leaf: (node: Node) => Pattern): Pattern {
    let rest: Pattern | undefined;
    const elements = elementsOf(node, (child) => {
      if (rest) fail(child, '残余要素は最後にしか書けません。');
      if (child.type !== 'rest_pattern' && child.type !== 'spread_element') return this.pattern(child, leaf);
      rest = this.pattern(namedChildren(child)[0], leaf);
      return 'rest';
    }).filter((element): element is Pattern | undefined => element !== 'rest');
    return { kind: 'arrayPattern', elements, rest, row: rowOf(node) };
  }

  private objectPattern(node: Node, leaf: (node: Node) => Pattern): Pattern {
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
          properties.push({
            key: { kind: 'key', key: field(child, 'left').text },
            value: this.pattern(child, leaf),
          });
          break;
        }
        case 'pair_pattern':
        case 'pair': {
          const key = this.propertyName(field(child, 'key'));
          if (key.kind === 'computed' && key.expression.suspends)
            unsupported(child, '分割代入のキーの yield や await ');
          properties.push({ key, value: this.pattern(field(child, 'value'), leaf) });
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
    return { kind: 'objectPattern', properties, rest, row: rowOf(node) };
  }
}

/**
 * Whether a generator can evaluate an expression containing a `yield` step by step: the parts of the expression that
 * hold the `yield` must be evaluated in order without a callback, as operands and arguments are, but destructuring
 * defaults and object literal members are not.
 */
function canSuspendIn(expression: Expression): boolean {
  switch (expression.kind) {
    case 'yield':
    case 'await':
    case 'parenthesized':
    case 'sequence':
    case 'binary':
    case 'logical':
    case 'conditional':
    case 'unary':
    case 'template':
    case 'array':
    case 'object':
    case 'member':
    case 'new': {
      return true;
    }
    case 'assign': {
      // A member target evaluates its parts step by step, but a destructuring target binds in one go.
      return expression.target.kind === 'member' || !patternSuspends(expression.target);
    }
    case 'call': {
      return expression.callee.kind !== 'super';
    }
    default: {
      return false;
    }
  }
}

/** Whether assigning to a pattern suspends, at a `yield` or an `await` in a member it assigns to or in a key. */
function patternSuspends(pattern: Pattern): boolean {
  switch (pattern.kind) {
    case 'identifier': {
      return false;
    }
    case 'member': {
      return (
        (pattern.object.kind !== 'super' && pattern.object.suspends === true) ||
        (pattern.property.kind === 'computed' && pattern.property.expression.suspends === true)
      );
    }
    case 'arrayPattern': {
      return [...pattern.elements, pattern.rest].some((element) => element !== undefined && patternSuspends(element));
    }
    case 'objectPattern': {
      return (
        pattern.properties.some(
          ({ key, value }) => (key.kind === 'computed' && key.expression.suspends === true) || patternSuspends(value)
        ) ||
        (pattern.rest !== undefined && patternSuspends(pattern.rest))
      );
    }
    case 'default': {
      return pattern.value.suspends === true || patternSuspends(pattern.target);
    }
  }
}

/** Converts a regular expression literal, rejecting a pattern or flags that JavaScript rejects. */
function regexLiteral(node: Node): Expression {
  const pattern = field(node, 'pattern').text;
  const flags = node.childForFieldName('flags')?.text ?? '';
  try {
    new RegExp(pattern, flags);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    fail(node, '正規表現の書き方に誤りがあります。');
  }
  return { kind: 'regex', pattern, flags, row: rowOf(node) };
}

/** Whether a template's source text has an escape that a tagged template leaves without a cooked string. */
function hasInvalidEscape(raw: string): boolean {
  return /\\(?:u(?!\{[\dA-Fa-f]+\}|[\dA-Fa-f]{4})|x(?![\dA-Fa-f]{2})|0\d|[1-9])/.test(
    raw.replaceAll(String.raw`\\`, '')
  );
}

/** Converts the elements between brackets, where a comma without an element leaves a hole. */
function elementsOf<T>(node: Node, convert: (child: Node) => T): (T | undefined)[] {
  const elements: (T | undefined)[] = [];
  let expectsElement = true;
  for (const child of node.children) {
    if (!child || child.type === '[' || child.type === ']' || child.type === 'comment') continue;
    if (child.type === ',') {
      if (expectsElement) elements.push(undefined);
      expectsElement = true;
      continue;
    }
    elements.push(convert(child));
    expectsElement = false;
  }
  return elements;
}
