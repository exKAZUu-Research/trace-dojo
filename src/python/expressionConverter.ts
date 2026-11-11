// code-gauge-allow-file fileNcss 618 -- The expression converter keeps one method per kind of expression node together.
import type { Node } from '@willbooster/web-tree-sitter';

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
import {
  children,
  decodeBytesEscapes,
  decodeEscapes,
  field,
  fieldNodes,
  hasToken,
  namedChildren,
  rowOf,
  unsupported,
} from './convertNodes';
import { fail, ScopeBuilder } from './scopes';
import { markSuspendingExpression } from './suspension';
import { unparseAnnotation } from './unparse';

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
export abstract class ExpressionConverter {
  protected context: Context;
  /** The scope of the type parameters of the function being defined, which its annotations belong to. */
  protected annotationContext: Context | undefined;
  /** The features the module's `from __future__ import` statements enable. */
  protected readonly futureFeatures = new Set<string>();

  constructor(
    protected readonly source: string,
    module: ScopeBuilder
  ) {
    this.context = { scope: module, qualifiedPrefix: '', inLoop: false, inExceptStar: false };
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

  // code-gauge-allow functionNcss 60 -- One case per kind of expression node, each delegating where it grows.
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
      case 'type': {
        // The grammar wraps the elements of a tuple or a list written in an annotation as types.
        return this.typeExpression(namedChildren(node)[0]);
      }
      case 'conditional_expression': {
        const [body, test, orelse] = namedChildren(node).map((child) => this.expression(child));
        return { kind: 'conditional', test, body, orelse, row };
      }
      case 'lambda': {
        return { kind: 'lambda', fn: this.lambda(node), row };
      }
      case 'named_expression': {
        return this.namedExpression(node);
      }
      case 'yield': {
        return this.yieldExpression(node);
      }
      case 'await': {
        return this.awaitExpression(node);
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
    return {
      kind: 'binary',
      operator: operator as BinaryOperator,
      left: this.expression(field(node, 'left')),
      right: this.expression(field(node, 'right')),
      row: rowOf(node),
    };
  }

  private comparison(node: Node): Expression {
    let operators = fieldNodes(node, 'operators').map((operator) => operator.type);
    if (this.futureFeatures.has('barry_as_FLUFL')) {
      if (operators.includes('!='))
        fail(rowOf(node), 'from __future__ import barry_as_FLUFL の後では、!= の代わりに <> を使ってください。');
      operators = operators.map((operator) => (operator === '<>' ? '!=' : operator));
    }
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
      return {
        kind: 'call',
        callee,
        args: [{ kind: 'positional', value: this.expression(argumentsNode) }],
        row: rowOf(node),
      };
    }
    return { kind: 'call', callee, args: this.argumentList(argumentsNode), row: rowOf(node) };
  }

  // code-gauge-allow functionNcss 33 -- Checks the order rules CPython applies to call arguments.
  // code-gauge-allow functionCognitiveComplexity 21 -- Checks the order rules CPython applies to call arguments.
  protected argumentList(node: Node): Argument[] {
    const nodes = namedChildren(node);
    const args: Argument[] = [];
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
        args.push({ kind: 'keyword', name, value: this.expression(field(argument, 'value')) });
      } else if (argument.type === 'dictionary_splat') {
        seenDoubleStar = true;
        args.push({ kind: 'doubleStar', value: this.expression(namedChildren(argument)[0]) });
      } else if (argument.type === 'list_splat') {
        if (seenDoubleStar) fail(row, '* を付けた引数は、** を付けた引数より前に書いてください。');
        args.push({ kind: 'star', value: this.expression(namedChildren(argument)[0]) });
      } else {
        if (seenDoubleStar) fail(row, '位置引数は、** を付けた引数より前に書いてください。');
        if (seenKeyword) fail(row, '位置引数は、キーワード引数より前に書いてください。');
        args.push({ kind: 'positional', value: this.expression(argument) });
      }
    }
    return args;
  }

  /** `yield value` or `yield from iterable`, which makes the function it is in a generator. */
  protected yieldExpression(node: Node): Expression {
    const row = rowOf(node);
    const { scope } = this.context;
    if (scope.info.kind === 'comprehension') fail(row, '内包表記の中には yield を書けません。');
    if (scope.info.kind !== 'function') fail(row, 'yield は関数の中にしか書けません。');
    scope.info.isGenerator = true;
    const valueNode = namedChildren(node)[0];
    if (hasToken(node, 'from')) {
      if (scope.info.isAsync) fail(row, 'async def の関数の中には yield from を書けません。');
      if (!valueNode || valueNode.type === 'expression_list') fail(row, 'yield from の後には式を1つ書いてください。');
      return { kind: 'yieldFrom', value: this.expression(valueNode), row };
    }
    return { kind: 'yield', value: valueNode ? this.expression(valueNode) : undefined, row };
  }

  private awaitExpression(node: Node): Expression {
    const row = rowOf(node);
    this.enterAsync(row, 'await は async def の関数の中にしか書けません。');
    return { kind: 'await', value: this.expression(namedChildren(node)[0]), row };
  }

  /**
   * Checks that an `await` or an `async for` at `row` runs in a coroutine, marking the comprehensions around it as
   * async: up to a generator expression, which then is an async generator, or to the `async def` running them.
   */
  protected enterAsync(row: number, message: string): void {
    let { scope } = this.context;
    while (scope.info.kind === 'comprehension') {
      scope.info.isAsync = true;
      if (scope.isGeneratorExpression) return;
      scope = scope.parent as ScopeBuilder;
    }
    if (scope.info.kind !== 'function' || !scope.info.isAsync) fail(row, message);
  }

  private namedExpression(node: Node): Expression {
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
    const prefixes = strings.map((string) =>
      children(string)[0]
        .text.replace(/['"]+$/, '')
        .toLowerCase()
    );
    if (prefixes.some((prefix) => prefix.includes('b'))) return this.bytesLiteral(node, strings, prefixes);
    const parts: (string | FormattedValue)[] = [];
    let isFormatted = false;
    for (const [index, string] of strings.entries()) {
      const prefix = prefixes[index];
      if (prefix.includes('u') && prefix !== 'u')
        fail(rowOf(string), '接頭辞 u は、ほかの接頭辞と組み合わせられません。');
      if (prefix.includes('t')) fail(rowOf(string), "テンプレート文字列（t'...'）は、この版の Python では使えません。");
      const isRaw = prefix.includes('r');
      if (prefix.includes('f')) isFormatted = true;
      this.stringParts(string, isRaw, parts);
    }
    const row = rowOf(node);
    if (!isFormatted) {
      const isUnicode = /^[uU]['"]/.test(children(strings[0])[0].text) || undefined;
      return { kind: 'constant', value: { kind: 'str', value: (parts as string[]).join(''), isUnicode }, row };
    }
    return { kind: 'fstring', parts, row };
  }

  /** A bytes literal, or adjacent ones, which a str literal must not join. */
  private bytesLiteral(node: Node, strings: Node[], prefixes: string[]): Expression {
    const isBytes = prefixes.map((prefix) => prefix.includes('b'));
    const mixed = strings.find((_, index) => isBytes[index] !== isBytes[0]);
    if (mixed) fail(rowOf(mixed), 'bytes のリテラルと str のリテラルは、続けて書けません。');
    const incompatible = strings.find((_, index) => /[fut]/.test(prefixes[index]));
    if (incompatible) fail(rowOf(incompatible), 'bytes のリテラルには、接頭辞 b と f・u・t を一緒に付けられません。');
    const parts: Uint8Array[] = [];
    for (const [index, string] of strings.entries()) {
      const nodes = children(string);
      const text = this.source.slice(nodes[0].endIndex, (nodes.at(-1) as Node).startIndex);
      // oxlint-disable-next-line eslint/no-control-regex -- Bytes literals may contain any ASCII character.
      if (!/^[\u0000-\u007F]*$/.test(text)) fail(rowOf(string), 'bytes のリテラルには、ASCII の文字しか書けません。');
      parts.push(decodeBytesEscapes(text, rowOf(string), prefixes[index].includes('r')));
    }
    const value = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      value.set(part, offset);
      offset += part.length;
    }
    return { kind: 'constant', value: { kind: 'bytes', value }, row: rowOf(node) };
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
    // The grammar's string_end of a raw string such as r"\\" also covers the text, so the quote alone is measured.
    pushText(endNode.endIndex - startNode.text.replace(/^[a-zA-Z]+/, '').length);
  }

  private interpolation(node: Node): FormattedValue {
    const expressionNode = field(node, 'expression');
    const row = rowOf(node);
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

  // code-gauge-allow functionNcss 38 -- Follows how CPython scopes each part of a comprehension.
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
    const scope = new ScopeBuilder('comprehension', outer.scope);
    scope.isGeneratorExpression = type === 'generator';
    const generators: Comprehension[] = [];
    for (const [index, clause] of clauses.entries()) {
      if (clause.type === 'if_clause') {
        this.context = { ...outer, scope };
        (generators.at(-1) as Comprehension).conditions.push(this.expression(namedChildren(clause)[0]));
        continue;
      }
      const isAsync = hasToken(clause, 'async');
      if (isAsync) {
        this.context = { ...outer, scope };
        this.enterAsync(rowOf(clause), 'async for を使う内包表記は、async def の関数の中にしか書けません。');
      }
      const rights = fieldNodes(clause, 'right');
      if (rights.length > 1) fail(rowOf(clause), '内包表記の in の後に複数の式を書くときは、( ) で囲んでください。');
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
      generators.push(isAsync ? { target, iterable, conditions: [], isAsync } : { target, iterable, conditions: [] });
    }
    this.context = { ...outer, scope };
    try {
      const body = field(node, 'body');
      if (body.type === 'list_splat' || body.type === 'dictionary_splat') {
        fail(rowOf(body), '内包表記の要素に * や ** を付けることはできません。');
      }
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
      if (bodyNode.type === 'yield') fail(rowOf(bodyNode), 'lambda の本体の yield は、( ) で囲んでください。');
      const body = this.expression(bodyNode);
      if (fn.scope.isGenerator) markSuspendingExpression(body);
      fn.body = body;
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

  /** Runs `convert` in `context`, or in the current context when it is undefined. */
  protected inContext<T>(context: Context | undefined, convert: () => T): T {
    const outer = this.context;
    this.context = context ?? outer;
    try {
      return convert();
    } finally {
      this.context = outer;
    }
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
    const last = params.at(-1);
    const endsAfterStar = last && ['keywordOnly', 'varArgs', 'varKeywords'].includes(last.kind);
    if (order.sawStar && !endsAfterStar && !params.some((param) => param.kind === 'varArgs')) {
      fail(rowOf(node), '* の後には、名前で渡す引数が必要です。');
    }
    return params;
  }

  private parameter(node: Node, kind: Parameter['kind']): Parameter {
    const row = rowOf(node);
    const valueNode = node.childForFieldName('value');
    const typeNode = node.childForFieldName('type');
    const annotation = typeNode ? this.inContext(this.annotationContext, () => this.annotation(typeNode)) : undefined;
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
    if (node.descendantsOfType(['named_expression', 'yield']).length > 0) {
      fail(rowOf(node), '型ヒントの中では、代入式（:=）や yield を使えません。');
    }
    if (!this.futureFeatures.has('annotations')) return this.typeExpression(inner);
    // A stringified annotation is never evaluated, so the names it reads belong to no scope and are not mangled.
    const outer = this.context;
    this.context = { ...outer, scope: new ScopeBuilder('function', undefined), className: undefined };
    try {
      const text = unparseAnnotation(this.typeExpression(inner));
      return { kind: 'constant', value: { kind: 'str', value: text }, row: rowOf(node) };
    } finally {
      this.context = outer;
    }
  }

  private typeExpression(node: Node): Expression {
    const row = rowOf(node);
    switch (node.type) {
      case 'generic_type': {
        const [base, parameters] = namedChildren(node);
        const args = namedChildren(parameters).map((argument) => this.typeArgument(argument));
        const [only] = args;
        const index: Expression =
          args.length === 1 && only.kind !== 'starred' && !hasToken(parameters, ',')
            ? only
            : { kind: 'tuple', elements: args, row };
        return { kind: 'subscript', object: this.typeExpression(base), index, row };
      }
      case 'union_type': {
        const [left, right] = namedChildren(node).map((child) => this.typeExpression(child));
        return { kind: 'binary', operator: '|', left, right, row };
      }
      case 'member_type': {
        const [object, name] = namedChildren(node);
        return { kind: 'attribute', object: this.typeExpression(object), name: name.text, row };
      }
      case 'type': {
        return this.typeExpression(namedChildren(node)[0]);
      }
      case 'splat_type': {
        // `*args: *Ts` annotates with the one item that unpacking `Ts` gives, `typing.Unpack[Ts]`.
        const value = this.typeExpression(namedChildren(node)[0]);
        const unpacked: Expression = { kind: 'list', elements: [{ kind: 'starred', value, row }], row };
        return {
          kind: 'subscript',
          object: unpacked,
          index: { kind: 'constant', value: { kind: 'int', value: 0n }, row },
          row,
        };
      }
      default: {
        return this.expression(node);
      }
    }
  }

  /** An index of a subscript the grammar reads as a generic type, such as `x[a:b]` or `x[*a]`. */
  private typeArgument(node: Node): Element {
    const row = rowOf(node);
    switch (node.type) {
      case 'type': {
        return this.typeArgument(namedChildren(node)[0]);
      }
      case 'constrained_type': {
        const [lower, upper] = namedChildren(node).map((child) => this.typeExpression(child));
        return { kind: 'slice', lower, upper, row };
      }
      case 'splat_type': {
        return { kind: 'starred', value: this.typeExpression(namedChildren(node)[0]), row };
      }
      default: {
        return this.typeExpression(node);
      }
    }
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
        return this.unpackTarget(elements, bind, row);
      }
      case 'list_splat_pattern':
      case 'list_splat': {
        return fail(row, '* を付けた代入先は、( ) や [ ] で囲んだ並びの中にしか書けません。');
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

  private unpackTarget(elements: Node[], bind: (nameNode: Node) => NameRef, row: number): Target {
    const starIndexes = elements.flatMap((element, index) => (isStarred(element) ? [index] : []));
    if (starIndexes.length > 1) fail(row, '代入先の並びには、* を1つしか書けません。');
    const targets = elements.map((element) =>
      isStarred(element) ? this.target(namedChildren(element)[0], bind) : this.target(element, bind)
    );
    return { kind: 'unpack', elements: targets, starIndex: starIndexes[0], row };
  }
}

function isStarred(node: Node): boolean {
  return node.type === 'list_splat_pattern' || node.type === 'list_splat';
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

/** Parses a number literal, rejecting the forms CPython's tokenizer rejects. */
function parseNumber(node: Node): Constant {
  const text = node.text;
  const row = rowOf(node);
  const digits = text.replaceAll('_', '').toLowerCase();
  if (INTEGER_LITERAL.test(text)) return { kind: 'int', value: BigInt(digits) };
  if (FLOAT_LITERAL.test(text)) return { kind: 'float', value: Number(digits) };
  if (IMAGINARY_LITERAL.test(text)) return { kind: 'imaginary', value: Number(digits.slice(0, -1)) };
  if (/^0+_?\d/.test(text) && /^[\d_]+$/.test(text)) {
    fail(row, '0 で始まる整数は書けません（8進数は 0o を付けて書きます）。');
  }
  return fail(row, `数値「${text}」の書き方に誤りがあります。`);
}

const DIGIT_PART = String.raw`\d(?:_?\d)*`;
const POINT_FLOAT = String.raw`(?:(?:${DIGIT_PART})?\.${DIGIT_PART}|${DIGIT_PART}\.)`;
const FLOAT_NUMBER = String.raw`(?:${POINT_FLOAT}(?:[eE][+-]?${DIGIT_PART})?|${DIGIT_PART}[eE][+-]?${DIGIT_PART})`;
const INTEGER_LITERAL = /^(?:[1-9](?:_?\d)*|0+(?:_?0)*|0[bB](?:_?[01])+|0[oO](?:_?[0-7])+|0[xX](?:_?[\dA-Fa-f])+)$/;
const FLOAT_LITERAL = new RegExp(`^${FLOAT_NUMBER}$`);
const IMAGINARY_LITERAL = new RegExp(`^(?:${FLOAT_NUMBER}|${DIGIT_PART})[jJ]$`);
