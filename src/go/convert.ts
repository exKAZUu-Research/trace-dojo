import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type {
  Block,
  CompositeLiteral,
  ConstSpec,
  DeclarationStatement,
  Expression,
  FieldSyntax,
  File,
  FunctionDeclaration,
  ImportSpec,
  LiteralElement,
  MethodSyntax,
  NameSpan,
  Parameter,
  Receiver,
  SelectCase,
  SignatureSyntax,
  SimpleStatement,
  Span,
  Statement,
  SwitchCase,
  TopLevelDeclaration,
  TypeExpression,
  TypeParameter,
  TypeSpec,
  TypeSwitchCase,
  VarSpec,
} from './ast';
import { parseIntegerText } from './constants';
import { decodeRawStringLiteral, decodeRuneLiteral, decodeStringLiteral } from './literals';

/** Converts tree-sitter's tree into the AST, rejecting syntax this environment does not run. */
export class Converter {
  convertFile(root: Node): File {
    let packageName = '';
    let packageSpan: Span = { row: 0, column: 0 };
    const imports: ImportSpec[] = [];
    const declarations: TopLevelDeclaration[] = [];
    for (const child of named(root)) {
      switch (child.type) {
        case 'package_clause': {
          const name = named(child)[0];
          packageName = name.text;
          packageSpan = spanOf(name);
          break;
        }
        case 'import_declaration': {
          imports.push(...this.convertImports(child));
          break;
        }
        case 'function_declaration':
        case 'method_declaration': {
          declarations.push(this.convertFunction(child));
          break;
        }
        case 'var_declaration':
        case 'const_declaration':
        case 'type_declaration': {
          declarations.push(this.convertDeclaration(child));
          break;
        }
        case 'comment': {
          break;
        }
        default: {
          throw syntaxError(child, '関数や型、変数の宣言の外に文は書けません。');
        }
      }
    }
    return { packageName, packageSpan, imports, declarations };
  }

  private convertImports(node: Node): ImportSpec[] {
    const specs = node.descendantsOfType('import_spec');
    return specs.map((spec) => {
      if (!spec) throw new Error('missing import spec');
      const nameNode = spec.childForFieldName('name');
      if (nameNode?.type === 'dot') unsupported(nameNode, 'import の . （パッケージの名前を省いて使う書き方）');
      const pathNode = required(spec.childForFieldName('path'));
      const path =
        pathNode.type === 'raw_string_literal'
          ? decodeRawStringLiteral(pathNode.text)
          : decodeStringLiteral(pathNode.text, (message) => syntaxError(pathNode, message));
      return { ...spanOf(spec), path, alias: nameNode?.text };
    });
  }

  private convertFunction(node: Node): FunctionDeclaration {
    const nameNode = required(node.childForFieldName('name'));
    const receiverNode = node.childForFieldName('receiver');
    const typeParametersNode = node.childForFieldName('type_parameters');
    if (receiverNode && typeParametersNode) unsupported(typeParametersNode, '型引数を持つメソッド');
    const body = node.childForFieldName('body');
    return {
      kind: 'func',
      ...spanOf(node),
      name: nameNode.text,
      nameSpan: spanOf(nameNode),
      receiver: receiverNode ? this.convertReceiver(receiverNode) : undefined,
      typeParameters: typeParametersNode ? this.convertTypeParameters(typeParametersNode) : [],
      signature: this.convertSignature(node),
      body: body ? this.convertBlock(body) : undefined,
      headerEndRow: (body ?? node).startPosition.row,
    };
  }

  private convertReceiver(node: Node): Receiver {
    const parameters = named(node).filter((child) => child.type !== 'comment');
    if (parameters.length !== 1) throw syntaxError(node, 'メソッドのレシーバは1つだけ書けます。');
    const parameter = parameters[0];
    if (parameter.type === 'variadic_parameter_declaration')
      throw syntaxError(parameter, 'レシーバに ... は使えません。');
    const names = parameter.childrenForFieldName('name').filter((child) => child !== null);
    if (names.length > 1) throw syntaxError(parameter, 'メソッドのレシーバは1つだけ書けます。');
    let typeNode = required(parameter.childForFieldName('type'));
    while (typeNode.type === 'parenthesized_type') typeNode = named(typeNode)[0];
    let pointer = false;
    if (typeNode.type === 'pointer_type') {
      pointer = true;
      typeNode = named(typeNode)[0];
      while (typeNode.type === 'parenthesized_type') typeNode = named(typeNode)[0];
    }
    let typeArguments: string[] = [];
    if (typeNode.type === 'generic_type') {
      const argumentsNode = required(typeNode.childForFieldName('type_arguments'));
      typeArguments = named(argumentsNode).map((argument) => {
        const inner = argument.type === 'type_elem' ? named(argument) : [argument];
        if (inner.length !== 1 || inner[0].type !== 'type_identifier') {
          throw syntaxError(argument, 'レシーバの型引数には名前だけを書いてください。');
        }
        return inner[0].text;
      });
      typeNode = required(typeNode.childForFieldName('type'));
    }
    if (typeNode.type !== 'type_identifier') {
      throw syntaxError(typeNode, 'レシーバには、このパッケージで宣言した型の名前を書いてください。');
    }
    return { ...spanOf(parameter), name: names[0]?.text, pointer, typeName: typeNode.text, typeArguments };
  }

  private convertTypeParameters(node: Node): TypeParameter[] {
    return named(node).flatMap((declaration) => {
      if (declaration.type === 'comment') return [];
      const constraintNode = required(declaration.childForFieldName('type'));
      const constraint = this.convertConstraint(constraintNode);
      return declaration
        .childrenForFieldName('name')
        .filter((name) => name !== null)
        .map((name) => ({ ...spanOf(name), name: name.text, constraint }));
    });
  }

  private convertConstraint(node: Node): TypeExpression {
    const parts = named(node);
    if (parts.length !== 1) unsupported(node, '型の集合（~ や | を使った制約）');
    const part = parts[0];
    if (part.type === 'negated_type') unsupported(part, '型の集合（~ や | を使った制約）');
    return this.convertType(part);
  }

  private convertSignature(node: Node): SignatureSyntax {
    const parametersNode = required(node.childForFieldName('parameters'));
    const resultNode = node.childForFieldName('result');
    const parameters = this.convertParameters(parametersNode);
    let results: Parameter[] = [];
    if (resultNode) {
      results =
        resultNode.type === 'parameter_list'
          ? this.convertParameters(resultNode)
          : [{ ...spanOf(resultNode), type: this.convertType(resultNode) }];
    }
    return { parameters, results };
  }

  private convertParameters(node: Node): Parameter[] {
    const declarations = named(node).filter((child) => child.type !== 'comment');
    const result: Parameter[] = [];
    for (const declaration of declarations) {
      if (declaration.type === 'variadic_parameter_declaration') {
        unsupported(declaration, '可変個の引数（...）');
      }
      const type = this.convertType(required(declaration.childForFieldName('type')));
      const names = declaration.childrenForFieldName('name').filter((name) => name !== null);
      if (names.length === 0) result.push({ ...spanOf(declaration), type });
      for (const name of names) result.push({ ...spanOf(name), name: name.text, type });
    }
    const namedCount = result.filter((parameter) => parameter.name !== undefined).length;
    if (namedCount > 0 && namedCount < result.length) {
      throw syntaxError(node, '引数や結果には、すべてに名前を付けるか、すべてに付けないかのどちらかにしてください。');
    }
    return result;
  }

  // Declarations ------------------------------------------------------------------------------------------------------

  private convertDeclaration(node: Node): DeclarationStatement {
    switch (node.type) {
      case 'var_declaration': {
        const specs = named(node).flatMap((child) => (child.type === 'var_spec_list' ? named(child) : [child]));
        return {
          kind: 'var',
          ...spanOf(node),
          specs: specs.filter((spec) => spec.type === 'var_spec').map((spec) => this.convertVarSpec(spec)),
        };
      }
      case 'const_declaration': {
        return { kind: 'const', ...spanOf(node), specs: this.convertConstSpecs(node) };
      }
      case 'type_declaration': {
        const specs: TypeSpec[] = [];
        for (const child of named(node)) {
          if (child.type === 'type_alias') unsupported(child, '型の別名（type A = B）');
          if (child.type === 'type_spec') specs.push(this.convertTypeSpec(child));
        }
        return { kind: 'type', ...spanOf(node), specs };
      }
      default: {
        throw new Error(`Unexpected declaration ${node.type}`);
      }
    }
  }

  private convertVarSpec(node: Node): VarSpec {
    const typeNode = node.childForFieldName('type');
    const valueNode = node.childForFieldName('value');
    return {
      ...spanOf(node),
      names: this.namesOf(node),
      type: typeNode ? this.convertType(typeNode) : undefined,
      values: valueNode ? this.convertExpressionList(valueNode) : [],
    };
  }

  private convertConstSpecs(node: Node): ConstSpec[] {
    const specs: ConstSpec[] = [];
    let previous: { type?: TypeExpression; values: Expression[] } | undefined;
    for (const child of named(node)) {
      if (child.type !== 'const_spec') continue;
      const typeNode = child.childForFieldName('type');
      const valueNode = child.childForFieldName('value');
      // A spec without values repeats the type and values of the one before, which `iota` makes differ.
      if (!valueNode) {
        if (!previous || typeNode) throw syntaxError(child, '定数の宣言に値がありません。');
      } else {
        previous = {
          type: typeNode ? this.convertType(typeNode) : undefined,
          values: this.convertExpressionList(valueNode),
        };
      }
      const { type, values } = previous as { type?: TypeExpression; values: Expression[] };
      specs.push({ ...spanOf(child), names: this.namesOf(child), type, values, iota: specs.length });
    }
    return specs;
  }

  private convertTypeSpec(node: Node): TypeSpec {
    const typeParametersNode = node.childForFieldName('type_parameters');
    return {
      ...spanOf(node),
      name: required(node.childForFieldName('name')).text,
      typeParameters: typeParametersNode ? this.convertTypeParameters(typeParametersNode) : [],
      type: this.convertType(required(node.childForFieldName('type'))),
    };
  }

  private namesOf(node: Node): NameSpan[] {
    // The grammar also labels the commas between the names as names.
    return node
      .childrenForFieldName('name')
      .filter((name) => name?.isNamed === true)
      .map((name) => ({ ...spanOf(name), name: name.text }));
  }

  // Types -------------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of type syntax.
  convertType(node: Node): TypeExpression {
    const span = spanOf(node);
    switch (node.type) {
      case 'type_identifier': {
        return { kind: 'name', ...span, name: node.text, typeArguments: [] };
      }
      case 'qualified_type': {
        return {
          kind: 'name',
          ...span,
          package: required(node.childForFieldName('package')).text,
          name: required(node.childForFieldName('name')).text,
          typeArguments: [],
        };
      }
      case 'generic_type': {
        const base = this.convertType(required(node.childForFieldName('type')));
        if (base.kind !== 'name') throw syntaxError(node, '型引数は型の名前に付けてください。');
        const argumentsNode = required(node.childForFieldName('type_arguments'));
        return { ...base, ...span, typeArguments: this.convertTypeArguments(argumentsNode) };
      }
      case 'pointer_type': {
        return { kind: 'pointer', ...span, element: this.convertType(named(node)[0]) };
      }
      case 'slice_type': {
        return { kind: 'slice', ...span, element: this.convertType(required(node.childForFieldName('element'))) };
      }
      case 'array_type': {
        return {
          kind: 'array',
          ...span,
          length: this.convertExpression(required(node.childForFieldName('length'))),
          element: this.convertType(required(node.childForFieldName('element'))),
        };
      }
      case 'implicit_length_array_type': {
        return {
          kind: 'array',
          ...span,
          length: undefined,
          element: this.convertType(required(node.childForFieldName('element'))),
        };
      }
      case 'map_type': {
        return {
          kind: 'map',
          ...span,
          key: this.convertType(required(node.childForFieldName('key'))),
          value: this.convertType(required(node.childForFieldName('value'))),
        };
      }
      case 'function_type': {
        return { kind: 'func', ...span, signature: this.convertSignature(node) };
      }
      case 'struct_type': {
        return { kind: 'struct', ...span, fields: this.convertFields(named(node)[0]) };
      }
      case 'interface_type': {
        return { kind: 'interface', ...span, methods: this.convertMethods(node) };
      }
      case 'parenthesized_type': {
        return this.convertType(named(node)[0]);
      }
      case 'channel_type': {
        // `chan<- T` has the arrow after `chan`, `<-chan T` before it.
        const tokens = node.children.filter((child) => child !== null && !child.isNamed).map((child) => child?.type);
        const arrow = tokens.indexOf('<-');
        const dir = arrow === -1 ? 'both' : arrow < tokens.indexOf('chan') ? 'receive' : 'send';
        return { kind: 'chan', ...span, dir, element: this.convertType(required(node.childForFieldName('value'))) };
      }
      case 'negated_type':
      case 'type_elem': {
        return unsupported(node, '型の集合（~ や | を使った制約）');
      }
      default: {
        throw syntaxError(node, '型の書き方に誤りがあります。');
      }
    }
  }

  private convertTypeArguments(node: Node): TypeExpression[] {
    return named(node).map((argument) => {
      if (argument.type !== 'type_elem') return this.convertType(argument);
      const parts = named(argument);
      if (parts.length !== 1 || parts[0].type === 'negated_type') {
        unsupported(argument, '型の集合（~ や | を使った制約）');
      }
      return this.convertType(parts[0]);
    });
  }

  private convertFields(list: Node | undefined): FieldSyntax[] {
    if (!list) return [];
    const fields: FieldSyntax[] = [];
    for (const declaration of named(list)) {
      if (declaration.type !== 'field_declaration') continue;
      const tag = declaration.childForFieldName('tag');
      if (tag) unsupported(tag, '構造体のタグ');
      const typeNode = required(declaration.childForFieldName('type'));
      const names = declaration.childrenForFieldName('name').filter((name) => name !== null);
      if (names.length === 0) {
        // An embedded field: `T`, `*T`, or `pkg.T`, whose name is the type's.
        const pointer = declaration.children.some((child) => child?.type === '*');
        const base = this.convertType(typeNode);
        fields.push({
          ...spanOf(declaration),
          type: pointer ? { kind: 'pointer', ...spanOf(declaration), element: base } : base,
        });
        continue;
      }
      const type = this.convertType(typeNode);
      for (const name of names) fields.push({ ...spanOf(name), name: name.text, type });
    }
    return fields;
  }

  private convertMethods(node: Node): MethodSyntax[] {
    const methods: MethodSyntax[] = [];
    for (const child of named(node)) {
      if (child.type === 'comment') continue;
      if (child.type !== 'method_elem') unsupported(child, 'インターフェースの埋め込みや型の集合');
      methods.push({
        ...spanOf(child),
        name: required(child.childForFieldName('name')).text,
        signature: this.convertSignature(child),
      });
    }
    return methods;
  }

  // Statements --------------------------------------------------------------------------------------------------------

  convertBlock(node: Node): Block {
    const list = named(node).find((child) => child.type === 'statement_list');
    return {
      ...spanOf(node),
      statements: list ? this.convertStatements(list) : [],
      endRow: node.endPosition.row,
    };
  }

  private convertStatements(list: Node): Statement[] {
    return named(list).flatMap((child) => (child.type === 'comment' ? [] : [this.convertStatement(child)]));
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- One case per statement kind.
  private convertStatement(node: Node): Statement {
    const span = spanOf(node);
    switch (node.type) {
      case 'expression_statement':
      case 'assignment_statement':
      case 'short_var_declaration':
      case 'inc_statement':
      case 'dec_statement':
      case 'send_statement':
      case 'empty_statement': {
        return this.convertSimpleStatement(node);
      }
      case 'var_declaration':
      case 'const_declaration':
      case 'type_declaration': {
        return { ...this.convertDeclaration(node), inFunction: true };
      }
      case 'block': {
        return { kind: 'block', ...span, block: this.convertBlock(node) };
      }
      case 'if_statement': {
        return this.convertIf(node);
      }
      case 'for_statement': {
        return this.convertFor(node);
      }
      case 'expression_switch_statement': {
        return this.convertSwitch(node);
      }
      case 'type_switch_statement': {
        return this.convertTypeSwitch(node);
      }
      case 'return_statement': {
        const list = named(node).find((child) => child.type === 'expression_list');
        return { kind: 'return', ...span, results: list ? this.convertExpressionList(list) : [] };
      }
      case 'break_statement':
      case 'continue_statement': {
        const label = named(node).find((child) => child.type === 'label_name');
        if (label) unsupported(label, 'ラベル');
        return { kind: node.type === 'break_statement' ? 'break' : 'continue', ...span };
      }
      case 'fallthrough_statement': {
        return { kind: 'fallthrough', ...span };
      }
      case 'defer_statement': {
        const call = named(node).find((child) => child.type !== 'comment');
        return { kind: 'defer', ...span, call: this.convertExpression(required(call)) };
      }
      case 'labeled_statement': {
        return unsupported(node, 'ラベル');
      }
      case 'goto_statement': {
        return unsupported(node, 'goto 文');
      }
      case 'go_statement': {
        const call = named(node).find((child) => child.type !== 'comment');
        return { kind: 'go', ...span, call: this.convertExpression(required(call)) };
      }
      case 'select_statement': {
        return this.convertSelect(node);
      }
      default: {
        throw syntaxError(node, '文の書き方に誤りがあります。');
      }
    }
  }

  private convertSimpleStatement(node: Node): SimpleStatement {
    const span = spanOf(node);
    switch (node.type) {
      case 'expression_statement': {
        return { kind: 'expression', ...span, expression: this.convertExpression(named(node)[0]) };
      }
      case 'assignment_statement': {
        return {
          kind: 'assign',
          ...span,
          operator: required(node.childForFieldName('operator')).text,
          left: this.convertExpressionList(required(node.childForFieldName('left'))),
          right: this.convertExpressionList(required(node.childForFieldName('right'))),
        };
      }
      case 'short_var_declaration': {
        return {
          kind: 'define',
          ...span,
          left: this.convertExpressionList(required(node.childForFieldName('left'))),
          right: this.convertExpressionList(required(node.childForFieldName('right'))),
        };
      }
      case 'inc_statement':
      case 'dec_statement': {
        return {
          kind: 'incDec',
          ...span,
          operator: node.type === 'inc_statement' ? '++' : '--',
          operand: this.convertExpression(named(node)[0]),
        };
      }
      case 'empty_statement': {
        return { kind: 'empty', ...span };
      }
      case 'send_statement': {
        return {
          kind: 'send',
          ...span,
          channel: this.convertExpression(required(node.childForFieldName('channel'))),
          value: this.convertExpression(required(node.childForFieldName('value'))),
        };
      }
      default: {
        throw syntaxError(node, '文の書き方に誤りがあります。');
      }
    }
  }

  private convertSelect(node: Node): Statement {
    const cases: SelectCase[] = [];
    for (const child of named(node)) {
      if (child.type !== 'communication_case' && child.type !== 'default_case') continue;
      cases.push({ ...spanOf(child), comm: this.convertCommunication(child), body: this.caseBody(child) });
    }
    return { kind: 'select', ...spanOf(node), cases };
  }

  private convertCommunication(node: Node): SelectCase['comm'] {
    if (node.type === 'default_case') return undefined;
    const comm = required(node.childForFieldName('communication'));
    if (comm.type === 'send_statement') return this.convertSimpleStatement(comm) as SelectCase['comm'];
    const right = this.convertExpression(required(comm.childForFieldName('right')));
    let receive = right;
    while (receive.kind === 'paren') receive = receive.expression;
    if (receive.kind !== 'unary' || receive.operator !== '<-') {
      throw syntaxError(comm, 'select の case には、チャネルへの送信かチャネルからの受信を書いてください。');
    }
    const left = comm.childForFieldName('left');
    return {
      kind: 'receive',
      ...spanOf(comm),
      left: left ? this.convertExpressionList(left) : [],
      define: comm.children.some((child) => child?.type === ':='),
      channel: receive.operand,
    };
  }

  private convertIf(node: Node): Extract<Statement, { kind: 'if' }> {
    const init = node.childForFieldName('initializer');
    const alternative = node.childForFieldName('alternative');
    return {
      kind: 'if',
      ...spanOf(node),
      init: init ? this.convertSimpleStatement(init) : undefined,
      condition: this.convertExpression(required(node.childForFieldName('condition'))),
      consequence: this.convertBlock(required(node.childForFieldName('consequence'))),
      alternative: alternative
        ? alternative.type === 'if_statement'
          ? this.convertIf(alternative)
          : this.convertBlock(alternative)
        : undefined,
    };
  }

  private convertFor(node: Node): Statement {
    const span = spanOf(node);
    const body = this.convertBlock(required(node.childForFieldName('body')));
    const header = named(node).find((child) => child.type !== 'block' && child.type !== 'comment');
    if (!header) return { kind: 'for', ...span, body };
    if (header.type === 'range_clause') {
      const left = header.childForFieldName('left');
      const targets = left ? this.convertExpressionList(left) : [];
      if (targets.length > 2) throw syntaxError(header, 'range で受け取れる値は2つまでです。');
      return {
        kind: 'range',
        ...span,
        key: targets[0],
        value: targets[1],
        define: header.children.some((child) => child?.type === ':='),
        range: this.convertExpression(required(header.childForFieldName('right'))),
        body,
      };
    }
    if (header.type === 'for_clause') {
      const init = header.childForFieldName('initializer');
      const condition = header.childForFieldName('condition');
      const post = header.childForFieldName('update');
      const postStatement = post ? this.convertSimpleStatement(post) : undefined;
      if (postStatement?.kind === 'define') throw syntaxError(post as Node, 'for 文の後処理には := を書けません。');
      return {
        kind: 'for',
        ...span,
        init: init ? this.convertSimpleStatement(init) : undefined,
        condition: condition ? this.convertExpression(condition) : undefined,
        post: postStatement,
        body,
      };
    }
    return { kind: 'for', ...span, condition: this.convertExpression(header), body };
  }

  private convertSwitch(node: Node): Statement {
    const init = node.childForFieldName('initializer');
    const value = node.childForFieldName('value');
    const cases: SwitchCase[] = [];
    for (const child of named(node)) {
      if (child.type !== 'expression_case' && child.type !== 'default_case') continue;
      const valueList = child.childForFieldName('value');
      cases.push({
        ...spanOf(child),
        values: child.type === 'default_case' ? undefined : this.convertExpressionList(required(valueList)),
        body: this.caseBody(child),
      });
    }
    return {
      kind: 'switch',
      ...spanOf(node),
      init: init ? this.convertSimpleStatement(init) : undefined,
      tag: value ? this.convertExpression(value) : undefined,
      cases,
      endRow: node.endPosition.row,
    };
  }

  private caseBody(node: Node): Statement[] {
    const list = named(node).find((child) => child.type === 'statement_list');
    return list ? this.convertStatements(list) : [];
  }

  private convertTypeSwitch(node: Node): Statement {
    const init = node.childForFieldName('initializer');
    const alias = node.childForFieldName('alias');
    const aliases = alias ? named(alias) : [];
    if (aliases.length > 1) throw syntaxError(alias as Node, '型の switch で受け取れる名前は1つだけです。');
    const cases: TypeSwitchCase[] = [];
    for (const child of named(node)) {
      if (child.type !== 'type_case' && child.type !== 'default_case') continue;
      const types =
        child.type === 'default_case'
          ? undefined
          : child
              .childrenForFieldName('type')
              .filter((type) => type !== null && type.isNamed)
              .map((type) =>
                type.type === 'type_identifier' && type.text === 'nil' ? undefined : this.convertType(type)
              );
      cases.push({ ...spanOf(child), types, body: this.caseBody(child) });
    }
    return {
      kind: 'typeSwitch',
      ...spanOf(node),
      init: init ? this.convertSimpleStatement(init) : undefined,
      binding: aliases[0] ? { ...spanOf(aliases[0]), name: aliases[0].text } : undefined,
      operand: this.convertExpression(required(node.childForFieldName('value'))),
      cases,
    };
  }

  // Expressions -------------------------------------------------------------------------------------------------------

  private convertExpressionList(node: Node): Expression[] {
    if (node.type !== 'expression_list') return [this.convertExpression(node)];
    return named(node).flatMap((child) => (child.type === 'comment' ? [] : [this.convertExpression(child)]));
  }

  // code-gauge-allow functionCognitiveComplexity 40 -- One case per expression kind.
  convertExpression(node: Node): Expression {
    const span = spanOf(node);
    switch (node.type) {
      case 'identifier':
      case 'type_identifier':
      case 'field_identifier':
      case 'package_identifier':
      case 'blank_identifier': {
        return { kind: 'name', ...span, name: node.text };
      }
      case 'true':
      case 'false':
      case 'nil': {
        return { kind: 'name', ...span, name: node.type };
      }
      case 'iota': {
        return { kind: 'name', ...span, name: 'iota' };
      }
      case 'int_literal': {
        checkNumberLiteral(node);
        return { kind: 'int', ...span, value: parseIntegerText(node.text), text: node.text };
      }
      case 'float_literal':
      case 'imaginary_literal': {
        checkNumberLiteral(node);
        return { kind: node.type === 'float_literal' ? 'float' : 'imaginary', ...span, text: node.text };
      }
      case 'rune_literal': {
        return { kind: 'rune', ...span, value: decodeRuneLiteral(node.text, (message) => syntaxError(node, message)) };
      }
      case 'interpreted_string_literal': {
        return {
          kind: 'string',
          ...span,
          value: decodeStringLiteral(node.text, (message) => syntaxError(node, message)),
        };
      }
      case 'raw_string_literal': {
        return { kind: 'string', ...span, value: decodeRawStringLiteral(node.text) };
      }
      case 'composite_literal': {
        return this.convertComposite(node, this.convertType(required(node.childForFieldName('type'))));
      }
      case 'func_literal': {
        return {
          kind: 'funcLiteral',
          ...span,
          signature: this.convertSignature(node),
          body: this.convertBlock(required(node.childForFieldName('body'))),
        };
      }
      case 'parenthesized_expression': {
        return { kind: 'paren', ...span, expression: this.convertExpression(named(node)[0]) };
      }
      case 'selector_expression': {
        const field = required(node.childForFieldName('field'));
        return {
          kind: 'selector',
          ...span,
          operand: this.convertExpression(required(node.childForFieldName('operand'))),
          field: field.text,
          fieldSpan: spanOf(field),
        };
      }
      case 'index_expression': {
        return {
          kind: 'index',
          ...span,
          operand: this.convertExpression(required(node.childForFieldName('operand'))),
          indices: node
            .childrenForFieldName('index')
            .filter((index) => index !== null)
            .map((index) => this.convertExpression(index)),
        };
      }
      case 'slice_expression': {
        const start = node.childForFieldName('start');
        const end = node.childForFieldName('end');
        const capacity = node.childForFieldName('capacity');
        if (capacity) unsupported(capacity, '3つ目の添字（容量）を書いたスライス式');
        return {
          kind: 'slice',
          ...span,
          operand: this.convertExpression(required(node.childForFieldName('operand'))),
          low: start ? this.convertExpression(start) : undefined,
          high: end ? this.convertExpression(end) : undefined,
        };
      }
      case 'type_assertion_expression': {
        return {
          kind: 'typeAssert',
          ...span,
          operand: this.convertExpression(required(node.childForFieldName('operand'))),
          type: this.convertType(required(node.childForFieldName('type'))),
        };
      }
      case 'type_conversion_expression': {
        const type = this.convertType(required(node.childForFieldName('type')));
        return {
          kind: 'call',
          ...span,
          callee: { kind: 'type', ...spanOf(node), type },
          typeArguments: [],
          args: [this.convertExpression(required(node.childForFieldName('operand')))],
        };
      }
      case 'type_instantiation_expression': {
        return unsupported(node, '型引数を明示する書き方（f[int] など）');
      }
      case 'call_expression': {
        return this.convertCall(node);
      }
      case 'unary_expression': {
        const operator = required(node.childForFieldName('operator')).text;
        return {
          kind: 'unary',
          ...span,
          operator,
          operand: this.convertExpression(required(node.childForFieldName('operand'))),
        };
      }
      case 'binary_expression': {
        return {
          kind: 'binary',
          ...span,
          operator: required(node.childForFieldName('operator')).text,
          left: this.convertExpression(required(node.childForFieldName('left'))),
          right: this.convertExpression(required(node.childForFieldName('right'))),
        };
      }
      case 'pointer_type':
      case 'slice_type':
      case 'array_type':
      case 'map_type':
      case 'function_type':
      case 'struct_type':
      case 'interface_type':
      case 'generic_type':
      case 'qualified_type':
      case 'channel_type':
      case 'implicit_length_array_type':
      case 'parenthesized_type': {
        const type = this.convertType(node);
        return { kind: 'type', ...span, type };
      }
      default: {
        throw syntaxError(node, '式の書き方に誤りがあります。');
      }
    }
  }

  private convertCall(node: Node): Expression {
    const argumentsNode = required(node.childForFieldName('arguments'));
    const typeArgumentsNode = node.childForFieldName('type_arguments');
    const args: Expression[] = [];
    for (const argument of named(argumentsNode)) {
      if (argument.type === 'comment') continue;
      if (argument.type === 'variadic_argument') unsupported(argument, '可変個の引数に ... で渡す書き方');
      args.push(this.convertExpression(argument));
    }
    let callee = this.convertExpression(required(node.childForFieldName('function')));
    // The grammar reads `m[k](x)` as a call with type arguments; whether `k` is a type the checker decides.
    if (typeArgumentsNode) {
      const indices = named(typeArgumentsNode).map((argument) => this.typeArgumentExpression(argument));
      callee = { kind: 'index', ...spanOf(node), operand: callee, indices };
    }
    return { kind: 'call', ...spanOf(node), callee, typeArguments: [], args };
  }

  /** A type argument of a call, as the index expression it may also be. */
  private typeArgumentExpression(argument: Node): Expression {
    const parts = argument.type === 'type_elem' ? named(argument) : [argument];
    if (parts.length !== 1 || parts[0].type === 'negated_type')
      return unsupported(argument, '型の集合（~ や | を使った制約）');
    const part = parts[0];
    if (part.type === 'type_identifier') return { kind: 'name', ...spanOf(part), name: part.text };
    if (part.type === 'qualified_type') {
      const pkg = required(part.childForFieldName('package'));
      const member = required(part.childForFieldName('name'));
      return {
        kind: 'selector',
        ...spanOf(part),
        operand: { kind: 'name', ...spanOf(pkg), name: pkg.text },
        field: member.text,
        fieldSpan: spanOf(member),
      };
    }
    const type = this.convertType(part);
    return { kind: 'type', ...spanOf(part), type };
  }

  private convertComposite(node: Node, type: TypeExpression | undefined): CompositeLiteral {
    const body = required(node.type === 'literal_value' ? node : node.childForFieldName('body'));
    const elements: LiteralElement[] = [];
    for (const child of named(body)) {
      if (child.type === 'comment') continue;
      if (child.type === 'keyed_element') {
        const key = required(child.childForFieldName('key'));
        const value = required(child.childForFieldName('value'));
        elements.push({ ...spanOf(child), key: this.convertElement(key), value: this.convertElement(value) });
      } else {
        elements.push({ ...spanOf(child), value: this.convertElement(child) });
      }
    }
    return { kind: 'composite', ...spanOf(node), type, elements, endRow: body.endPosition.row };
  }

  /** Converts a literal element, which may be a composite literal with its type elided. */
  private convertElement(node: Node): Expression {
    const inner = node.type === 'literal_element' ? named(node)[0] : node;
    if (inner.type === 'literal_value') return this.convertComposite(inner, undefined);
    return this.convertExpression(inner);
  }
}

function named(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function required(node: Node | null | undefined): Node {
  if (!node) throw new Error('A node the grammar requires is missing');
  return node;
}

export function spanOf(node: Node): Span {
  return { row: node.startPosition.row, column: node.startPosition.column };
}

function syntaxError(node: Node, message: string): CompileError {
  return new CompileError([{ row: node.startPosition.row, message }]);
}

/**
 * Checks the digits of a number literal as Go's scanner does: `_` only between digits or after a base prefix, octal
 * digits in an octal literal, and digits after a prefix.
 */
function checkNumberLiteral(node: Node): void {
  const text = node.type === 'imaginary_literal' ? node.text.slice(0, -1) : node.text;
  const body = text.replace(/^0[xXbBoO]_?/, '');
  if (/(^|[^\da-fA-F])_|_($|[^\da-fA-F])/.test(body)) {
    throw syntaxError(node, '数の書き方に誤りがあります（_ は数字と数字の間にだけ書けます）。');
  }
  const digits = text.replaceAll('_', '');
  if (/^0[xXbBoO]$/.test(digits))
    throw syntaxError(node, '数の書き方に誤りがあります（0x などの後に数字がありません）。');
  if (node.type !== 'int_literal') return;
  const invalid = /^0[bB].*?([2-9])/.exec(digits) ?? /^0[oO]?\d*?([89])/.exec(digits);
  if (invalid && !/^0[xX]/.test(digits)) {
    const base = /^0[bB]/.test(digits) ? '2進数' : '8進数';
    throw syntaxError(node, `${base}の数に使えない数字 ${invalid[1]} があります。`);
  }
}

function unsupported(node: Node, what: string): never {
  throw new CompileError([{ row: node.startPosition.row, message: `${what}は、この採点環境では使えません。` }]);
}
