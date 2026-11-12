// code-gauge-allow-file fileNcss 544 -- The expression converter keeps one method per kind of expression node together.
import type { Node } from '@willbooster/web-tree-sitter';

import { assignmentExpressionError } from './assignmentExpressions';
import type {
  Argument,
  BinaryOperator,
  CompareOperator,
  Comprehension,
  Constant,
  DictItem,
  Element,
  Expression,
  FormattedValue,
  FunctionDef,
  NameRef,
  Parameter,
  Target,
} from './ast';
import { BITWISE_PRECEDENCE, groupBitwise } from './bitwisePrecedence';
import {
  children,
  decodeEscapes,
  field,
  fieldNodes,
  hasToken,
  namedChildren,
  rowOf,
  unsupported,
} from './convertNodes';
import { hasUnbracketedLambda } from './fStringLambdas';
import { parseNumber } from './numberLiterals';
import { fail, ScopeBuilder } from './scopes';

/** What a function body being converted allows, which its early errors depend on. */
export interface Context {
  scope: ScopeBuilder;
  /** The name of the class whose body (or a function in it) is being converted, for name mangling. */
  className?: string;
  /** The qualified name prefix of definitions here, such as `A.f.<locals>.`. */
  qualifiedPrefix: string;
  inLoop: boolean;
  /** Whether a `break`, `continue`, or `return` here would leave an `except*` block. */
  inExceptStar: boolean;
  /** Whether a loop of the except* clause encloses the statement, so that break and continue stay inside the clause. */
  inLoopOfExceptStar: boolean;
  /** The function being converted, which `super` and `__class__` mark. */
  fn?: FunctionDef;
}

const BINARY_OPERATORS = new Set(['+', '-', '*', '/', '//', '%', '**', '@', '<<', '>>', '&', '|', '^']);

/** What the parameters converted so far allow next, as CPython checks their order. */
interface ParameterOrder {
  kind: Parameter['kind'];
  sawDefault: boolean;
  sawStar: boolean;
}

/** Converts expressions, targets, and parameters, registering the names they use and bind in their scopes. */

/** The string prefixes CPython 3.14 accepts, in lowercase. */
const STRING_PREFIXES = new Set(['', 'r', 'u', 'b', 'f', 't', 'br', 'rb', 'fr', 'rf', 'tr', 'rt']);

export abstract class ExpressionConverter {
  protected context: Context;

  constructor(
    protected readonly source: string,
    module: ScopeBuilder
  ) {
    this.context = {
      scope: module,
      qualifiedPrefix: '',
      inLoop: false,
      inExceptStar: false,
      inLoopOfExceptStar: false,
    };
  }

  protected abstract functionBody(node: Node, fn: FunctionDef): void;

  protected textOf(node: Node): string {
    return this.source.slice(node.startIndex, node.endIndex);
  }

  // Names -----------------------------------------------------------------------------------------------------------

  protected mangle(name: string): string {
    const { className } = this.context;
    if (!className || !name.startsWith('__') || name.endsWith('__') || name.includes('.')) return name;
    const stripped = className.replace(/^_+/, '');
    return stripped ? `_${stripped}${name}` : name;
  }

  protected useName(node: Node, name = node.text): NameRef {
    const ref: NameRef = { kind: 'name', name: this.mangle(name), access: 'global', row: rowOf(node) };
    if (ref.name === 'super' || ref.name === '__class__') this.markClassCell();
    this.context.scope.use(ref);
    return ref;
  }

  protected bindName(node: Node, name = node.text): NameRef {
    const mangled = this.mangle(name);
    if (mangled === '__debug__') fail(rowOf(node), '__debug__ には代入できません。');
    const ref: NameRef = { kind: 'name', name: mangled, access: 'global', row: rowOf(node) };
    this.context.scope.bind(ref);
    return ref;
  }

  private markClassCell(): void {
    if (this.context.fn) this.context.fn.usesClassCell = true;
  }

  // Expressions -----------------------------------------------------------------------------------------------------

  // code-gauge-allow functionNcss 51 -- One case per kind of expression node, each delegating where it grows.
  expression(node: Node): Expression {
    const row = rowOf(node);
    switch (node.type) {
      case 'identifier': {
        return this.useName(node);
      }
      case 'integer':
      case 'float':
      case 'true':
      case 'false':
      case 'none':
      case 'ellipsis': {
        return { kind: 'constant', value: constantOf(node), row };
      }
      case 'string':
      case 'concatenated_string': {
        return this.stringLiteral(node);
      }
      case 'parenthesized_expression': {
        return this.parenthesized(node);
      }
      case 'list':
      case 'set':
      case 'tuple':
      case 'expression_list': {
        return {
          kind: node.type === 'expression_list' ? 'tuple' : node.type,
          elements: namedChildren(node).map((child) => this.element(child)),
          row,
        };
      }
      case 'dictionary': {
        return { kind: 'dict', items: namedChildren(node).map((child) => this.dictItem(child)), row };
      }
      case 'attribute': {
        return this.attribute(node);
      }
      case 'subscript': {
        return this.subscript(node);
      }
      case 'slice': {
        return this.slice(node);
      }
      case 'call': {
        return this.call(node);
      }
      case 'binary_operator': {
        return this.binaryOperator(node);
      }
      case 'unary_operator':
      case 'not_operator':
      case 'boolean_operator': {
        return this.logicalOrUnary(node);
      }
      case 'comparison_operator': {
        return this.comparison(node);
      }
      case 'lambda': {
        return { kind: 'lambda', fn: this.lambda(node), row };
      }
      case 'named_expression': {
        return this.namedExpression(node);
      }
      case 'list_comprehension':
      case 'set_comprehension':
      case 'dictionary_comprehension':
      case 'generator_expression': {
        return this.comprehension(node);
      }
      default: {
        return rejectExpression(node);
      }
    }
  }

  private parenthesized(node: Node): Expression {
    const inner = namedChildren(node)[0];
    if (inner.type === 'yield') return unsupported(inner, '値を受け取る yield');
    if (inner.type === 'list_splat') fail(rowOf(node), '* を付けた式は、ここには書けません。');
    return this.expression(inner);
  }

  private attribute(node: Node): Extract<Expression, { kind: 'attribute' }> {
    return {
      kind: 'attribute',
      object: this.expression(field(node, 'object')),
      name: this.mangle(field(node, 'attribute').text),
      row: rowOf(node),
    };
  }

  private subscript(node: Node): Extract<Expression, { kind: 'subscript' }> {
    return {
      kind: 'subscript',
      object: this.expression(field(node, 'value')),
      index: this.subscriptIndex(node),
      row: rowOf(node),
    };
  }

  private logicalOrUnary(node: Node): Expression {
    const row = rowOf(node);
    if (node.type === 'not_operator') return { kind: 'not', operand: this.expression(field(node, 'argument')), row };
    if (node.type === 'unary_operator') {
      return {
        kind: 'unary',
        operator: field(node, 'operator').type as '-' | '+' | '~',
        operand: this.expression(field(node, 'argument')),
        row,
      };
    }
    return {
      kind: 'boolean',
      operator: field(node, 'operator').type as 'and' | 'or',
      left: this.expression(field(node, 'left')),
      right: this.expression(field(node, 'right')),
      row,
    };
  }

  private binaryOperator(node: Node): Expression {
    const operator = field(node, 'operator').type;
    if (!BINARY_OPERATORS.has(operator)) fail(rowOf(node), `演算子 ${operator} は Python 3 では使えません。`);
    if (operator in BITWISE_PRECEDENCE) return this.bitwiseChain(node);
    return {
      kind: 'binary',
      operator: operator as BinaryOperator,
      left: this.expression(field(node, 'left')),
      right: this.expression(field(node, 'right')),
      row: rowOf(node),
    };
  }

  /**
   * Converts a chain of `|`, `^`, and `&` with Python's precedence (`&` binds tighter than `^`), which the grammar has
   * the other way round for `&` and `^`: the chain is read in source order and grouped again.
   */
  private bitwiseChain(node: Node): Expression {
    const operands: Expression[] = [];
    const operators: Node[] = [];
    const collect = (part: Node): void => {
      const operator = part.type === 'binary_operator' ? field(part, 'operator') : undefined;
      if (!operator || !(operator.type in BITWISE_PRECEDENCE)) {
        operands.push(this.expression(part));
        return;
      }
      collect(field(part, 'left'));
      operators.push(operator);
      collect(field(part, 'right'));
    };
    collect(node);
    return groupBitwise(operands, operators);
  }

  private comparison(node: Node): Expression {
    const operators = fieldNodes(node, 'operators').map((operator) => operator.type);
    if (operators.includes('<>')) fail(rowOf(node), '演算子 <> は Python 3 では使えません。!= を使ってください。');
    return {
      kind: 'compare',
      operands: fieldNodes(node, 'operands').map((operand) => this.expression(operand)),
      operators: operators as CompareOperator[],
      row: rowOf(node),
    };
  }

  private element(node: Node): Element {
    if (node.type === 'list_splat') {
      return { kind: 'starred', value: this.expression(namedChildren(node)[0]), row: rowOf(node) };
    }
    if (node.type === 'parenthesized_expression' && namedChildren(node)[0]?.type === 'list_splat') {
      fail(rowOf(node), '* を付けた式は、ここには書けません。');
    }
    return this.expression(node);
  }

  private dictItem(node: Node): DictItem {
    if (node.type === 'dictionary_splat') return { kind: 'doubleStar', value: this.expression(namedChildren(node)[0]) };
    return { kind: 'pair', key: this.expression(field(node, 'key')), value: this.expression(field(node, 'value')) };
  }

  private subscriptIndex(node: Node): Expression {
    const indexes = fieldNodes(node, 'subscript');
    const hasTrailingComma = children(node).some((child) => child.type === ',');
    if (indexes.length === 1 && !hasTrailingComma) return this.expression(indexes[0]);
    return { kind: 'tuple', elements: indexes.map((index) => this.element(index)), row: rowOf(node) };
  }

  private slice(node: Node): Expression {
    const parts: (Expression | undefined)[] = [undefined];
    for (const child of children(node)) {
      if (child.type === ':') parts.push(undefined);
      else parts[parts.length - 1] = this.expression(child);
    }
    return { kind: 'slice', lower: parts[0], upper: parts[1], step: parts[2], row: rowOf(node) };
  }

  private call(node: Node): Expression {
    const callee = this.expression(field(node, 'function'));
    const argumentsNode = field(node, 'arguments');
    if (argumentsNode.type === 'generator_expression') {
      // The parser folds a trailing comma into the generator's last clause, which only ( ) around it would allow.
      const lastClause = namedChildren(argumentsNode).at(-1);
      if (lastClause && hasToken(lastClause, ',')) {
        fail(rowOf(argumentsNode), 'ジェネレータ式を引数にするときは、それだけを書くか、( ) で囲んでください。');
      }
      return {
        kind: 'call',
        callee,
        args: [{ kind: 'positional', value: this.expression(argumentsNode) }],
        row: rowOf(node),
      };
    }
    return { kind: 'call', callee, args: this.argumentList(argumentsNode), row: rowOf(node) };
  }

  // code-gauge-allow functionNcss 34 -- Checks the order rules CPython applies to call arguments.
  // code-gauge-allow functionCognitiveComplexity 21 -- Checks the order rules CPython applies to call arguments.
  protected argumentList(node: Node): Argument[] {
    const nodes = namedChildren(node);
    const positionals: Argument[] = [];
    const named: Argument[] = [];
    const keywords = new Set<string>();
    let seenKeyword = false;
    let seenDoubleStar = false;
    for (const argument of nodes) {
      const row = rowOf(argument);
      if (argument.type === 'generator_expression' && nodes.length > 1 && argument.child(0)?.type !== '(') {
        fail(row, 'ジェネレータ式を引数にするときは、それだけを書くか、( ) で囲んでください。');
      }
      if (argument.type === 'keyword_argument') {
        const name = field(argument, 'name').text;
        if (keywords.has(name)) fail(row, `キーワード引数 ${name} を2回書いています。`);
        keywords.add(name);
        seenKeyword = true;
        named.push({ kind: 'keyword', name, value: this.expression(field(argument, 'value')) });
      } else if (argument.type === 'dictionary_splat') {
        seenDoubleStar = true;
        named.push({ kind: 'doubleStar', value: this.expression(namedChildren(argument)[0]) });
      } else if (argument.type === 'list_splat') {
        if (seenDoubleStar) fail(row, '* を付けた引数は、** を付けた引数より前に書いてください。');
        positionals.push({ kind: 'star', value: this.expression(namedChildren(argument)[0]) });
      } else {
        if (seenDoubleStar) fail(row, '位置引数は、** を付けた引数より前に書いてください。');
        if (seenKeyword) fail(row, '位置引数は、キーワード引数より前に書いてください。');
        positionals.push({ kind: 'positional', value: this.expression(argument) });
      }
    }
    // CPython evaluates a * argument written after a keyword argument before that keyword's value.
    return [...positionals, ...named];
  }

  private namedExpression(node: Node): Expression {
    const error = assignmentExpressionError(node);
    if (error) fail(rowOf(node), error);
    const nameNode = field(node, 'name');
    const value = this.expression(field(node, 'value'));
    const { scope } = this.context;
    const target: NameRef =
      scope.info.kind === 'comprehension' ? this.bindFromComprehension(nameNode) : this.bindName(nameNode);
    return { kind: 'namedExpression', target, value, row: rowOf(node) };
  }

  /** Binds the target of an assignment expression in a comprehension, which binds it in the enclosing scope. */
  private bindFromComprehension(node: Node): NameRef {
    const name = this.mangle(node.text);
    const row = rowOf(node);
    let owner = this.context.scope;
    const comprehensions: ScopeBuilder[] = [];
    while (owner.info.kind === 'comprehension') {
      if (owner.iterationVariables.has(name)) {
        fail(row, `代入式で、内包表記の繰り返しの変数 ${name} に代入することはできません。`);
      }
      comprehensions.push(owner);
      owner = owner.parent as ScopeBuilder;
    }
    if (owner.info.kind === 'class') fail(row, 'クラスの本体の内包表記では、代入式を使えません。');
    const declaration =
      owner.info.kind === 'module' || owner.declarations.get(name) === 'global' ? 'global' : 'nonlocal';
    for (const comprehension of comprehensions) comprehension.declarations.set(name, declaration);
    if (!owner.bound.has(name)) owner.bound.set(name, row);
    const ref: NameRef = { kind: 'name', name, access: 'global', row };
    this.context.scope.bind(ref);
    return ref;
  }

  // Strings ---------------------------------------------------------------------------------------------------------

  private stringLiteral(node: Node): Expression {
    const strings = node.type === 'concatenated_string' ? namedChildren(node) : [node];
    const parts: (string | FormattedValue)[] = [];
    let isFormatted = false;
    for (const string of strings) {
      const startNode = children(string)[0];
      if (startNode.text.endsWith('`')) {
        fail(rowOf(string), 'バッククォート（`...`）は Python 3 では使えません。repr(...) を使ってください。');
      }
      const prefix = startNode.text.replace(/['"]+$/, '').toLowerCase();
      if (!STRING_PREFIXES.has(prefix)) fail(rowOf(string), `文字列の接頭辞「${prefix}」は使えません。`);
      if (prefix.includes('b')) unsupported(string, "bytes のリテラル（b'...'）");
      if (prefix.includes('u')) unsupported(string, '接頭辞 u の付いた文字列');
      if (prefix.includes('t')) fail(rowOf(string), "テンプレート文字列（t'...'）は、この版の Python では使えません。");
      const isRaw = prefix.includes('r');
      if (prefix.includes('f')) isFormatted = true;
      this.stringParts(string, isRaw, parts);
    }
    const row = rowOf(node);
    if (!isFormatted) return { kind: 'constant', value: { kind: 'str', value: (parts as string[]).join('') }, row };
    return { kind: 'fstring', parts, row };
  }

  /** Appends the text and the interpolations of one string literal, between its quotes. */
  private stringParts(string: Node, isRaw: boolean, parts: (string | FormattedValue)[]): void {
    const nodes = children(string);
    const startNode = nodes[0];
    const endNode = nodes.at(-1) as Node;
    let position = startNode.endIndex;
    const row = rowOf(string);
    const pushText = (end: number): void => {
      if (end <= position) return;
      const raw = this.source.slice(position, end);
      const text = startNode.text.toLowerCase().includes('f') ? raw.replaceAll('{{', '{').replaceAll('}}', '}') : raw;
      parts.push(isRaw ? text : decodeEscapes(text, row));
    };
    for (const child of nodes.slice(1, -1)) {
      if (child.type !== 'interpolation') continue;
      pushText(child.startIndex);
      parts.push(this.interpolation(child));
      position = child.endIndex;
    }
    pushText(endNode.startIndex);
  }

  private interpolation(node: Node): FormattedValue {
    const expressionNode = field(node, 'expression');
    const row = rowOf(node);
    if (expressionNode.type === 'yield') unsupported(node, '値を受け取る yield');
    if (hasUnbracketedLambda(expressionNode)) fail(row, 'f-string の { } の中の lambda は、( ) で囲んでください。');
    const expression =
      expressionNode.type === 'expression_list' || expressionNode.type === 'pattern_list'
        ? { kind: 'tuple' as const, elements: namedChildren(expressionNode).map((child) => this.element(child)), row }
        : this.expression(expressionNode);
    const conversionNode = node.childForFieldName('type_conversion');
    const specNode = node.childForFieldName('format_specifier');
    const equals = children(node).find((child) => child.type === '=');
    const conversionText = conversionNode?.text.slice(1);
    if (conversionText !== undefined && !['r', 's', 'a'].includes(conversionText)) {
      fail(row, `f-string の変換 !${conversionText} は使えません。!r・!s・!a のどれかを書いてください。`);
    }
    const value: FormattedValue = {
      expression,
      conversion: conversionText as FormattedValue['conversion'],
      spec: specNode ? this.formatSpec(specNode) : undefined,
    };
    if (equals) {
      value.debugText = this.source.slice(node.startIndex + 1, equals.endIndex);
      // The text after `=` up to the conversion or the spec also belongs to the shown text.
      const next = conversionNode ?? specNode;
      const end = next ? next.startIndex : (children(node).at(-1) as Node).startIndex;
      value.debugText += this.source.slice(equals.endIndex, end);
      if (!value.conversion && !value.spec) value.conversion = 'r';
    }
    return value;
  }

  private formatSpec(node: Node): Expression {
    const parts: (string | FormattedValue)[] = [];
    // The specifier's text starts after its colon.
    let position = node.startIndex + 1;
    for (const child of namedChildren(node)) {
      if (child.type !== 'format_expression') continue;
      if (child.startIndex > position) parts.push(this.source.slice(position, child.startIndex));
      parts.push(this.interpolation(child));
      position = child.endIndex;
    }
    if (node.endIndex > position) parts.push(this.source.slice(position, node.endIndex));
    return { kind: 'fstring', parts, row: rowOf(node) };
  }

  // Comprehensions and lambdas --------------------------------------------------------------------------------------

  // code-gauge-allow functionNcss 37 -- Follows how CPython scopes each part of a comprehension.
  // code-gauge-allow functionCognitiveComplexity 24 -- Follows how CPython scopes each part of a comprehension.
  private comprehension(node: Node): Expression {
    const type =
      node.type === 'list_comprehension'
        ? 'list'
        : node.type === 'set_comprehension'
          ? 'set'
          : node.type === 'dictionary_comprehension'
            ? 'dict'
            : 'generator';
    const clauses = namedChildren(node).filter((child) => child.type === 'for_in_clause' || child.type === 'if_clause');
    const outer = this.context;
    const scope = new ScopeBuilder('comprehension', outer.scope, type !== 'generator');
    const generators: Comprehension[] = [];
    for (const [index, clause] of clauses.entries()) {
      if (clause.type === 'if_clause') {
        this.context = { ...outer, scope };
        (generators.at(-1) as Comprehension).conditions.push(this.expression(namedChildren(clause)[0]));
        continue;
      }
      if (hasToken(clause, 'async')) unsupported(clause, 'async for');
      const rights = fieldNodes(clause, 'right');
      if (rights.length > 1 || hasToken(clause, ',')) {
        fail(rowOf(clause), '内包表記の in の後に複数の式を書くときは、( ) で囲んでください。');
      }
      // The first iterable is evaluated in the enclosing scope, before the comprehension starts.
      this.context = index === 0 ? outer : { ...outer, scope };
      const iterable = this.expression(rights[0]);
      if (iterable.kind === 'namedExpression') fail(rowOf(clause), '内包表記の繰り返す対象には、代入式を使えません。');
      this.context = { ...outer, scope };
      const target = this.target(field(clause, 'left'), (nameNode) => {
        const ref = this.bindName(nameNode);
        scope.iterationVariables.add(ref.name);
        return ref;
      });
      generators.push({ target, iterable, conditions: [] });
    }
    this.context = { ...outer, scope };
    try {
      const body = field(node, 'body');
      if (body.type === 'list_splat' || body.type === 'dictionary_splat') {
        fail(rowOf(body), '内包表記の要素に * や ** を付けることはできません。');
      }
      if (body.type === 'yield') fail(rowOf(body), '内包表記の中には yield を書けません。');
      const element = body.type === 'pair' ? this.expression(field(body, 'key')) : this.expression(body);
      const value = body.type === 'pair' ? this.expression(field(body, 'value')) : undefined;
      return { kind: 'comprehension', type, element, value, generators, scope: scope.info, row: rowOf(node) };
    } finally {
      this.context = outer;
    }
  }

  private lambda(node: Node): FunctionDef {
    const parametersNode = node.childForFieldName('parameters');
    const qualifiedName = `${this.context.qualifiedPrefix}<lambda>`;
    const fn = this.newFunction(node, '<lambda>', qualifiedName);
    fn.params = parametersNode ? this.parameters(parametersNode) : [];
    this.inFunction(fn, () => {
      for (const parameter of fn.params) this.bindParameter(parameter);
      const bodyNode = field(node, 'body');
      if (bodyNode.type === 'yield') unsupported(bodyNode, 'lambda の中の yield');
      fn.body = this.expression(bodyNode);
    });
    return fn;
  }

  protected newFunction(node: Node, name: string, qualifiedName: string): FunctionDef {
    return {
      name,
      qualifiedName,
      params: [],
      body: [],
      scope: new ScopeBuilder('function', this.context.scope).info,
      decorators: [],
      isAtomic: false,
      isMethod: false,
      className: this.context.className,
      usesClassCell: false,
      row: rowOf(node),
    };
  }

  /** Runs `convert` in the scope of `fn`, which `newFunction` created as the last child of the current scope. */
  protected inFunction(fn: FunctionDef, convert: () => void): void {
    const outer = this.context;
    const scope = outer.scope.children.find((child) => child.info === fn.scope) as ScopeBuilder;
    this.context = {
      scope,
      className: outer.className,
      qualifiedPrefix: `${fn.qualifiedName}.<locals>.`,
      inLoop: false,
      inExceptStar: false,
      inLoopOfExceptStar: false,
      fn,
    };
    try {
      convert();
    } finally {
      this.context = outer;
    }
    // A nested function that uses the class cell makes its enclosing method capture it too.
    if (fn.usesClassCell && outer.fn) outer.fn.usesClassCell = true;
  }

  protected bindParameter(parameter: Parameter): void {
    const { scope } = this.context;
    scope.parameters.add(parameter.name);
    scope.bind({ kind: 'name', name: parameter.name, access: 'local', row: parameter.row });
  }

  /** Converts parameters, whose defaults and annotations belong to the enclosing scope. */
  protected parameters(node: Node): Parameter[] {
    const params: Parameter[] = [];
    const order: ParameterOrder = { kind: 'positional', sawDefault: false, sawStar: false };
    const names = new Set<string>();
    for (const child of namedChildren(node)) {
      const row = rowOf(child);
      if (child.type === 'positional_separator') {
        makePositionalOnly(params, order, row);
        continue;
      }
      if (child.type === 'keyword_separator') {
        startKeywordOnly(order, row);
        continue;
      }
      if (child.type === 'tuple_pattern') fail(row, 'Python 3 では、引数を ( ) で分解して受け取ることはできません。');
      if (params.some((param) => param.kind === 'varKeywords'))
        fail(row, '** を付けた引数の後には、引数を書けません。');
      const parameter = this.parameter(child, order.kind);
      if (names.has(parameter.name)) fail(row, `引数 ${parameter.name} が重複しています。`);
      names.add(parameter.name);
      checkParameterOrder(parameter, params, order, row);
      params.push(parameter);
    }
    const hasNamedAfterStar = params.some((param) => param.kind === 'keywordOnly' || param.kind === 'varArgs');
    if (order.sawStar && !hasNamedAfterStar) {
      fail(rowOf(node), '* の後には、名前で渡す引数が必要です。');
    }
    return params;
  }

  private parameter(node: Node, kind: Parameter['kind']): Parameter {
    const row = rowOf(node);
    const valueNode = node.childForFieldName('value');
    const typeNode = node.childForFieldName('type');
    const annotation = typeNode ? this.annotation(typeNode) : undefined;
    const value = valueNode ? this.expression(valueNode) : undefined;
    const base = { default: value, annotation, row };
    const target =
      node.type === 'identifier' || node.type === 'list_splat_pattern' || node.type === 'dictionary_splat_pattern'
        ? node
        : (node.childForFieldName('name') ?? namedChildren(node)[0]);
    if (target.type === 'list_splat_pattern') {
      return { name: this.mangle(namedChildren(target)[0].text), kind: 'varArgs', ...base };
    }
    if (target.type === 'dictionary_splat_pattern') {
      return { name: this.mangle(namedChildren(target)[0].text), kind: 'varKeywords', ...base };
    }
    return { name: this.mangle(target.text), kind, ...base };
  }

  /** Converts a type annotation, which runs only when a program reads `__annotations__`. */
  protected annotation(node: Node): Expression {
    const inner = node.type === 'type' ? namedChildren(node)[0] : node;
    return this.typeExpression(inner);
  }

  private typeExpression(node: Node): Expression {
    const row = rowOf(node);
    switch (node.type) {
      case 'generic_type': {
        const [base, parameters] = namedChildren(node);
        const args = namedChildren(parameters).map((argument) => this.annotation(argument));
        const index: Expression = args.length === 1 ? args[0] : { kind: 'tuple', elements: args, row };
        return { kind: 'subscript', object: this.typeExpression(base), index, row };
      }
      case 'union_type': {
        const [left, right] = namedChildren(node);
        return { kind: 'binary', operator: '|', left: this.annotation(left), right: this.annotation(right), row };
      }
      case 'member_type': {
        const [object, name] = namedChildren(node);
        return { kind: 'attribute', object: this.typeExpression(object), name: name.text, row };
      }
      case 'type': {
        return this.annotation(node);
      }
      case 'list': {
        // A bracketed list of types, as Callable[[int], int] takes its parameters, which may also unpack iterables.
        return { kind: 'list', elements: namedChildren(node).map((element) => this.typeListElement(element)), row };
      }
      case 'constrained_type':
      case 'splat_type': {
        return unsupported(node, '型引数');
      }
      default: {
        return this.expression(node);
      }
    }
  }
  /** An element of a bracketed list in a type position: a type, or a `*` that unpacks one. */
  private typeListElement(node: Node): Element {
    if (node.type === 'list_splat') {
      return { kind: 'starred', value: this.typeExpression(namedChildren(node)[0]), row: rowOf(node) };
    }
    return node.type === 'type' ? this.annotation(node) : this.element(node);
  }

  // Targets ---------------------------------------------------------------------------------------------------------

  /** Converts what an assignment stores into, binding its names with `bind`. */
  // code-gauge-allow functionNcss 31 -- One case per kind of assignment target node.
  protected target(node: Node, bind: (nameNode: Node) => NameRef = (nameNode) => this.bindName(nameNode)): Target {
    const row = rowOf(node);
    switch (node.type) {
      case 'identifier': {
        return bind(node);
      }
      case 'attribute': {
        return this.attribute(node);
      }
      case 'subscript': {
        return this.subscript(node);
      }
      case 'parenthesized_expression': {
        return this.target(namedChildren(node)[0], bind);
      }
      case 'pattern_list':
      case 'expression_list':
      case 'tuple_pattern':
      case 'tuple':
      case 'list_pattern':
      case 'list': {
        const elements = namedChildren(node);
        const isParenthesizedName =
          (node.type === 'tuple_pattern' || node.type === 'tuple') &&
          elements.length === 1 &&
          !children(node).some((child) => child.type === ',');
        if (isParenthesizedName) return this.target(elements[0], bind);
        return { kind: 'unpack', elements: elements.map((element) => this.target(element, bind)), row };
      }
      case 'list_splat_pattern':
      case 'list_splat': {
        return unsupported(node, '代入の左辺の *（残りをまとめて受け取る書き方）');
      }
      case 'true':
      case 'false':
      case 'none': {
        return fail(row, `${node.text} には代入できません。`);
      }
      default: {
        return fail(row, `${this.textOf(node)} には代入できません。`);
      }
    }
  }
}

function makePositionalOnly(params: Parameter[], order: ParameterOrder, row: number): void {
  if (params.length === 0) fail(row, '/ の前には引数が1つ以上必要です。');
  if (order.sawStar || params.some((param) => param.kind === 'positionalOnly'))
    fail(row, '/ は * より前に1回だけ書けます。');
  for (const param of params) param.kind = 'positionalOnly';
}

function startKeywordOnly(order: ParameterOrder, row: number): void {
  if (order.sawStar) fail(row, '* は1回しか書けません。');
  order.sawStar = true;
  order.kind = 'keywordOnly';
}

function checkParameterOrder(parameter: Parameter, params: Parameter[], order: ParameterOrder, row: number): void {
  if (parameter.kind === 'varArgs') {
    startKeywordOnly(order, row);
  } else if (parameter.kind === 'varKeywords') {
    order.kind = 'varKeywords';
  } else if (params.some((param) => param.kind === 'varKeywords')) {
    fail(row, '** を付けた引数の後には、引数を書けません。');
  } else if (parameter.default) {
    order.sawDefault = true;
  } else if (order.sawDefault && order.kind === 'positional') {
    fail(row, 'デフォルト値のない引数は、デフォルト値のある引数より前に書いてください。');
  }
}

/** Rejects a node that is no expression this grader converts, saying why. */
function rejectExpression(node: Node): never {
  switch (node.type) {
    case 'conditional_expression': {
      return unsupported(node, '条件式（a if c else b）');
    }
    case 'await': {
      return unsupported(node, 'await');
    }
    case 'yield': {
      return unsupported(node, '値を受け取る yield');
    }
    case 'list_splat': {
      return fail(rowOf(node), '* を付けた式は、ここには書けません。');
    }
    case 'keyword_argument':
    case 'dictionary_splat': {
      return fail(rowOf(node), '書き方に誤りがあります。');
    }
    default: {
      return unsupported(node, `構文「${node.type}」`);
    }
  }
}

function constantOf(node: Node): Constant {
  switch (node.type) {
    case 'true':
    case 'false': {
      return { kind: 'bool', value: node.type === 'true' };
    }
    case 'none': {
      return { kind: 'none' };
    }
    case 'ellipsis': {
      return { kind: 'ellipsis' };
    }
    default: {
      return parseNumber(node);
    }
  }
}
