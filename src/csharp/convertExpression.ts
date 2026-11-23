// code-gauge-allow-file fileNcss -- The convertExpression module keeps one stage of the C# interpreter together.
// oxlint-disable unicorn/prefer-code-point -- C# characters are UTF-16 code units, which code points would merge.
import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type {
  Argument,
  ArrayInitializer,
  Block,
  CollectionElement,
  Designation,
  Expression,
  Initializer,
  InterpolationPart,
  LambdaParameter,
  LiteralValue,
  MemberInitializer,
  Pattern,
  Position,
  QueryClause,
  Subpattern,
  TypeNode,
} from './ast';
import {
  childrenOf,
  field,
  fieldChildren,
  hasToken,
  namedChildren,
  positionOf,
  requiredField,
  sameNode,
  unescape,
  unsupported,
} from './convertBase';

/** The syntax of each stage C or D expression node, named for learners. */
const UNSUPPORTED_EXPRESSIONS: Record<string, string> = {
  alias_qualified_name: '`global::` などの別名で修飾した名前',
  anonymous_method_expression: '`delegate` による匿名メソッド',
  checked_expression: '`checked`・`unchecked` 式',
  makeref_expression: '`__makeref`',
  reftype_expression: '`__reftype`',
  refvalue_expression: '`__refvalue`',
  range_expression: '範囲（`..`）',
  ref_expression: '`ref` 式',
  sizeof_expression: '`sizeof`',
  typeof_expression: '`typeof`',
  await_expression: '`await`',
  stackalloc_expression: '`stackalloc`',
  implicit_stackalloc_expression: '`stackalloc`',
  preproc_if: 'プリプロセッサ ディレクティブ（`#if` など）',
};

const UNSUPPORTED_TYPES: Record<string, string> = {
  alias_qualified_name: '`global::` などの別名で修飾した名前',
  pointer_type: 'ポインター型',
  function_pointer_type: '関数ポインター型',
  ref_type: '`ref` 型',
  scoped_type: '`scoped`',
};

export class ExpressionConverter {
  /** @param isLibrary Whether the source is this grader's own library declarations, which use more syntax. */
  constructor(protected readonly isLibrary: boolean) {}

  /** Converts the body of a block, provided by the statement converter. */
  protected convertBlockNode(_node: Node): Block {
    throw new Error('convertBlockNode is provided by the statement converter');
  }

  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  convertType(node: Node): TypeNode {
    const position = positionOf(node);
    switch (node.type) {
      case 'predefined_type': {
        return { kind: 'predefinedType', name: node.text, ...position };
      }
      case 'implicit_type': {
        return { kind: 'varType', ...position };
      }
      case 'identifier': {
        return { kind: 'namedType', name: node.text, typeArgs: undefined, ...position };
      }
      case 'generic_name': {
        const [name, args] = this.genericParts(node);
        return { kind: 'namedType', name, typeArgs: args, ...position };
      }
      case 'qualified_name': {
        const left = this.convertType(requiredField(node, 'qualifier'));
        const nameNode = requiredField(node, 'name');
        const [name, typeArgs] =
          nameNode.type === 'generic_name' ? this.genericParts(nameNode) : [nameNode.text, undefined];
        return { kind: 'qualifiedType', left, name, typeArgs, ...position };
      }
      case 'array_type': {
        const element = this.convertType(requiredField(node, 'type'));
        const rank = requiredField(node, 'rank');
        if (namedChildren(rank).length > 0) {
          throw new CompileError([
            {
              row: rank.startPosition.row,
              message: "CS0270: 配列のサイズは変数宣言の中で指定できません ('new' を使用して初期化してください)",
            },
          ]);
        }
        return { kind: 'arrayType', element, rank: rankOf(rank), ...position };
      }
      case 'nullable_type': {
        return { kind: 'nullableType', inner: this.convertType(requiredField(node, 'type')), ...position };
      }
      case 'tuple_type': {
        const elements = namedChildren(node).map((element) => ({
          type: this.convertType(requiredField(element, 'type')),
          name: field(element, 'name')?.text,
        }));
        return { kind: 'tupleType', elements, ...position };
      }
      default: {
        const what = UNSUPPORTED_TYPES[node.type];
        if (what) unsupported(node, what);
        throw new CompileError([{ row: node.startPosition.row, message: 'CS1031: 型が必要です' }]);
      }
    }
  }

  protected genericParts(node: Node): [string, TypeNode[]] {
    const [nameNode, argsNode] = namedChildren(node);
    return [nameNode.text, namedChildren(argsNode).map((arg) => this.convertType(arg))];
  }

  convertExpression(node: Node): Expression {
    return (
      this.convertPrimaryExpression(node) ??
      this.convertAccessExpression(node) ??
      this.convertCreationExpression(node) ??
      this.convertOperatorExpression(node) ??
      this.convertOtherExpression(node)
    );
  }

  // code-gauge-allow functionNcss -- One case per kind of primary expression node in the grammar.
  private convertPrimaryExpression(node: Node): Expression | undefined {
    const position = positionOf(node);
    switch (node.type) {
      case 'parenthesized_expression': {
        const [inner] = namedChildren(node);
        return this.convertExpression(inner);
      }
      case 'integer_literal':
      case 'real_literal':
      case 'character_literal':
      case 'string_literal':
      case 'verbatim_string_literal':
      case 'raw_string_literal':
      case 'boolean_literal':
      case 'null_literal': {
        return { kind: 'literal', value: this.convertLiteral(node), ...position };
      }
      case 'interpolated_string_expression': {
        return { kind: 'interpolated', parts: this.convertInterpolated(node), ...position };
      }
      case 'identifier': {
        return { kind: 'name', name: node.text, typeArgs: undefined, ...position };
      }
      case 'generic_name': {
        const [name, typeArgs] = this.genericParts(node);
        return { kind: 'name', name, typeArgs, ...position };
      }
      case 'predefined_type': {
        return { kind: 'predefinedTypeName', name: node.text, ...position };
      }
      case 'this': {
        return { kind: 'this', ...position };
      }
      case 'base': {
        return { kind: 'base', ...position };
      }
      case 'default_expression': {
        const typeNode = field(node, 'type');
        return { kind: 'default', type: typeNode ? this.convertType(typeNode) : undefined, ...position };
      }
      case 'declaration_expression': {
        return {
          kind: 'declaration',
          type: this.convertType(requiredField(node, 'type')),
          designation: {
            kind: 'single',
            name: requiredField(node, 'name').text,
            ...positionOf(requiredField(node, 'name')),
          },
          ...position,
        };
      }
      case 'tuple_expression': {
        return { kind: 'tuple', elements: namedChildren(node).map((arg) => this.convertArgument(arg)), ...position };
      }
      case 'discard': {
        return { kind: 'name', name: '_', typeArgs: undefined, ...position };
      }
      default: {
        return undefined;
      }
    }
  }

  private convertAccessExpression(node: Node): Expression | undefined {
    const position = positionOf(node);
    switch (node.type) {
      case 'qualified_name': {
        // A qualified name in an expression is a member access on a namespace or type.
        const target = this.convertExpression(requiredField(node, 'qualifier'));
        return this.memberAccess(target, requiredField(node, 'name'), position);
      }
      case 'member_access_expression': {
        const targetNode = requiredField(node, 'expression');
        const target = this.convertOperand(targetNode);
        return this.memberAccess(target, requiredField(node, 'name'), position);
      }
      case 'member_binding_expression': {
        return this.memberAccess({ kind: 'conditionalReceiver', ...position }, requiredField(node, 'name'), position);
      }
      case 'element_binding_expression': {
        const args = namedChildren(node).map((arg) => this.convertArgument(arg));
        return { kind: 'elementAccess', target: { kind: 'conditionalReceiver', ...position }, args, ...position };
      }
      case 'conditional_access_expression': {
        return {
          kind: 'conditionalAccess',
          target: this.convertOperand(requiredField(node, 'condition')),
          access: this.convertExpression(requiredField(node, 'consequence')),
          ...position,
        };
      }
      case 'invocation_expression': {
        return {
          kind: 'invocation',
          target: this.convertOperand(requiredField(node, 'function')),
          args: this.convertArguments(requiredField(node, 'arguments')),
          ...position,
        };
      }
      case 'element_access_expression': {
        const subscript = requiredField(node, 'subscript');
        const target = requiredField(node, 'expression');
        // `new int[2][2]` reads as indexing a new array, which C# takes as a second rank with a size.
        if (
          target.type === 'array_creation_expression' &&
          !namedChildren(target).some((child) => child.type === 'initializer_expression')
        )
          throw new CompileError(
            namedChildren(subscript).map((size) => ({
              row: size.startPosition.row,
              message: "CS0178: 無効な次元指定子です: ',' または ']' を指定してください",
            }))
          );
        return {
          kind: 'elementAccess',
          target: this.convertOperand(requiredField(node, 'expression')),
          args: namedChildren(subscript).map((arg) => this.convertArgument(arg)),
          ...position,
        };
      }
      default: {
        return undefined;
      }
    }
  }

  // code-gauge-allow functionNcss -- One case per kind of creation expression node in the grammar.
  private convertCreationExpression(node: Node): Expression | undefined {
    const position = positionOf(node);
    switch (node.type) {
      case 'object_creation_expression': {
        const argsNode = field(node, 'arguments');
        const initializerNode = field(node, 'initializer');
        return {
          kind: 'new',
          type: this.convertType(requiredField(node, 'type')),
          args: argsNode ? this.convertArguments(argsNode) : undefined,
          initializer: initializerNode ? this.convertInitializer(initializerNode) : undefined,
          ...position,
        };
      }
      case 'implicit_object_creation_expression': {
        let args: Argument[] = [];
        let initializer: Initializer | undefined;
        for (const child of namedChildren(node)) {
          if (child.type === 'argument_list') args = this.convertArguments(child);
          else initializer = this.convertInitializer(child);
        }
        return { kind: 'implicitNew', args, initializer, ...position };
      }
      case 'array_creation_expression': {
        return this.convertArrayCreation(node);
      }
      case 'implicit_array_creation_expression': {
        const [initializer] = namedChildren(node);
        // `new[,]` writes its rank as the commas between its brackets.
        const rank = childrenOf(node).filter((child) => child.type === ',').length + 1;
        return { kind: 'implicitNewArray', rank, initializer: this.convertArrayInitializer(initializer), ...position };
      }
      case 'initializer_expression': {
        return this.convertArrayInitializer(node);
      }
      case 'collection_expression': {
        return {
          kind: 'collection',
          elements: namedChildren(node).map((element) => this.convertCollectionElement(element)),
          ...position,
        };
      }
      case 'anonymous_object_creation_expression': {
        return { kind: 'anonymousObject', members: this.convertAnonymousMembers(node), ...position };
      }
      case 'with_expression': {
        const [value, initializer] = namedChildren(node);
        return {
          kind: 'with',
          value: this.convertExpression(value),
          members: initializer ? this.convertWithMembers(initializer) : [],
          ...position,
        };
      }
      default: {
        return undefined;
      }
    }
  }

  private convertOperatorExpression(node: Node): Expression | undefined {
    const position = positionOf(node);
    switch (node.type) {
      case 'prefix_unary_expression': {
        return this.convertPrefixUnary(node);
      }
      case 'postfix_unary_expression': {
        const [operand] = namedChildren(node);
        const operator = childrenOf(node).at(-1)?.type;
        if (operator === '!') return { kind: 'nullForgiving', operand: this.convertExpression(operand), ...position };
        return {
          kind: 'increment',
          operator: operator === '++' ? '++' : '--',
          prefix: false,
          operand: this.convertExpression(operand),
          ...position,
        };
      }
      case 'binary_expression': {
        const operatorNode = requiredField(node, 'operator');
        return {
          kind: 'binary',
          operator: operatorNode.type,
          left: this.convertExpression(requiredField(node, 'left')),
          right: this.convertExpression(requiredField(node, 'right')),
          operatorRow: operatorNode.startPosition.row,
          ...position,
        };
      }
      case 'assignment_expression': {
        return {
          kind: 'assign',
          operator: requiredField(node, 'operator').type,
          target: this.convertExpression(requiredField(node, 'left')),
          value: this.convertExpression(requiredField(node, 'right')),
          ...position,
        };
      }
      case 'conditional_expression': {
        return {
          kind: 'conditional',
          condition: this.convertExpression(requiredField(node, 'condition')),
          whenTrue: this.convertExpression(requiredField(node, 'consequence')),
          whenFalse: this.convertExpression(requiredField(node, 'alternative')),
          ...position,
        };
      }
      case 'cast_expression': {
        return {
          kind: 'cast',
          type: this.convertType(requiredField(node, 'type')),
          operand: this.convertExpression(requiredField(node, 'value')),
          ...position,
        };
      }
      case 'as_expression': {
        return {
          kind: 'as',
          operand: this.convertExpression(requiredField(node, 'left')),
          type: this.convertType(requiredField(node, 'right')),
          ...position,
        };
      }
      case 'is_pattern_expression': {
        return {
          kind: 'is',
          operand: this.convertExpression(requiredField(node, 'expression')),
          pattern: this.convertPattern(requiredField(node, 'pattern')),
          ...position,
        };
      }
      default: {
        return undefined;
      }
    }
  }

  private convertOtherExpression(node: Node): Expression {
    const position = positionOf(node);
    switch (node.type) {
      case 'lambda_expression': {
        return this.convertLambda(node);
      }
      case 'switch_expression': {
        return this.convertSwitchExpression(node);
      }
      case 'throw_expression': {
        const [value] = namedChildren(node);
        return { kind: 'throw', value: this.convertExpression(value), ...position };
      }
      case 'query_expression': {
        return { kind: 'query', clauses: this.convertQuery(node), ...position };
      }
      default: {
        const what = UNSUPPORTED_EXPRESSIONS[node.type];
        if (what) unsupported(node, what);
        if (node.type === 'unary_expression') unsupported(node, 'プリプロセッサ ディレクティブ（`#if` など）');
        throw new CompileError([{ row: node.startPosition.row, message: 'CS1733: 式が必要です' }]);
      }
    }
  }

  /** Converts the operand of a member access or a call, where a predefined type names its type. */
  private convertOperand(node: Node): Expression {
    return this.convertExpression(node);
  }

  private memberAccess(target: Expression, nameNode: Node, position: ReturnType<typeof positionOf>): Expression {
    const [name, typeArgs] =
      nameNode.type === 'generic_name' ? this.genericParts(nameNode) : [nameNode.text, undefined];
    return { kind: 'memberAccess', target, name, typeArgs, nameRow: nameNode.startPosition.row, ...position };
  }

  private convertPrefixUnary(node: Node): Expression {
    const position = positionOf(node);
    const [operand] = namedChildren(node);
    const operator = childrenOf(node)[0].type;
    switch (operator) {
      case '++':
      case '--': {
        return { kind: 'increment', operator, prefix: true, operand: this.convertExpression(operand), ...position };
      }
      case '-':
      case '+':
      case '!':
      case '~': {
        return { kind: 'unary', operator, operand: this.convertExpression(operand), ...position };
      }
      case '^': {
        return unsupported(node, '末尾からの添字（`^`）');
      }
      case '&': {
        return unsupported(node, 'アドレス演算子（`&`）');
      }
      case '*': {
        return unsupported(node, 'ポインターの間接参照（`*`）');
      }
      default: {
        throw new CompileError([{ row: node.startPosition.row, message: 'CS1733: 式が必要です' }]);
      }
    }
  }

  protected convertArguments(node: Node): Argument[] {
    return namedChildren(node).map((arg) => this.convertArgument(arg));
  }

  protected convertArgument(node: Node): Argument {
    if (node.type !== 'argument') {
      if (node.type === 'preproc_if') unsupported(node, 'プリプロセッサ ディレクティブ（`#if` など）');
      return {
        name: undefined,
        modifier: undefined,
        value: this.convertExpression(node),
        text: node.text,
        ...positionOf(node),
      };
    }
    const nameNode = field(node, 'name');
    const valueNode = namedChildren(node).find((child) => !sameNode(child, nameNode)) as Node;
    // The grammar puts an empty identifier where an argument is left out, as in `f(a, )`.
    if (valueNode.text === '')
      throw new CompileError([
        { row: valueNode.startPosition.row, message: `CS1525: '${node.nextSibling?.text ?? ')'}' は無効です` },
      ]);
    const modifier = (['ref', 'out', 'in'] as const).find((token) => hasToken(node, token));
    return {
      name: nameNode?.text,
      modifier,
      value: this.convertExpression(valueNode),
      text: valueNode.text,
      ...positionOf(node),
    };
  }

  private convertArrayCreation(node: Node): Expression {
    const typeNode = requiredField(node, 'type');
    // The grammar nests `int[2][]` as an array of `int[2]`, while C# makes it an array of 2 `int[]`: the first rank
    // in the source is the created array's, and the later ranks make up its element type.
    const ranks: Node[] = [];
    let base = typeNode;
    while (base.type === 'array_type') {
      ranks.unshift(requiredField(base, 'rank'));
      base = requiredField(base, 'type');
    }
    const [rank, ...elementRanks] = ranks;
    const sizeNodes = namedChildren(rank);
    const rankCount = rankOf(rank);
    const sizes: (Expression | undefined)[] =
      sizeNodes.length > 0 ? sizeNodes.map((size) => this.convertExpression(size)) : Array.from({ length: rankCount });
    let elementType = this.convertType(base);
    for (const inner of elementRanks.toReversed()) {
      if (namedChildren(inner).length > 0) {
        throw new CompileError([
          { row: inner.startPosition.row, message: "CS0178: 無効な次元指定子です: ',' または ']' を指定してください" },
        ]);
      }
      elementType = { kind: 'arrayType', element: elementType, rank: rankOf(inner), ...positionOf(inner) };
    }
    const initializerNode = namedChildren(node).find((child) => child.type === 'initializer_expression');
    return {
      kind: 'newArray',
      type: { kind: 'arrayType', element: elementType, rank: rankCount, ...positionOf(typeNode) },
      sizes,
      initializer: initializerNode ? this.convertArrayInitializer(initializerNode) : undefined,
      ...positionOf(node),
    };
  }

  protected convertArrayInitializer(node: Node): ArrayInitializer {
    const elements = namedChildren(node).map((element) =>
      element.type === 'initializer_expression'
        ? this.convertArrayInitializer(element)
        : this.convertExpression(element)
    );
    return { kind: 'arrayInitializer', elements, ...positionOf(node) };
  }

  /** An object or collection initializer, told apart by whether its elements assign members. */
  private convertInitializer(node: Node): Initializer {
    const elements = namedChildren(node);
    // Empty braces initialize no member, which C# reads as an object initializer, so any type takes them.
    const isObject =
      elements.length === 0 ||
      elements.some(
        (element) =>
          element.type === 'assignment_expression' &&
          ['identifier', 'element_binding_expression'].includes(requiredField(element, 'left').type)
      );
    if (!isObject) {
      return {
        kind: 'collectionInitializer',
        elements: elements.map((element) =>
          element.type === 'initializer_expression'
            ? {
                kind: 'arrayInitializer',
                elements: namedChildren(element).map((item) => this.convertExpression(item)),
                ...positionOf(element),
              }
            : this.convertExpression(element)
        ),
        ...positionOf(node),
      };
    }
    return {
      kind: 'objectInitializer',
      members: elements.map((element) => this.convertMemberInitializer(element)),
      ...positionOf(node),
    };
  }

  private convertMemberInitializer(node: Node): MemberInitializer {
    if (node.type !== 'assignment_expression' || requiredField(node, 'operator').type !== '=') {
      throw new CompileError([{ row: node.startPosition.row, message: 'CS0747: 初期化子のメンバー宣言子が無効です' }]);
    }
    const left = requiredField(node, 'left');
    const right = requiredField(node, 'right');
    const value =
      right.type === 'initializer_expression' ? this.convertInitializer(right) : this.convertExpression(right);
    if (left.type === 'identifier') return { kind: 'memberAssign', name: left.text, value, ...positionOf(node) };
    if (left.type === 'element_binding_expression') {
      return {
        kind: 'indexAssign',
        args: namedChildren(left).map((arg) => this.convertArgument(arg)),
        value,
        ...positionOf(node),
      };
    }
    throw new CompileError([{ row: node.startPosition.row, message: 'CS0747: 初期化子のメンバー宣言子が無効です' }]);
  }

  private convertWithMembers(node: Node): MemberInitializer[] {
    const members: MemberInitializer[] = [];
    const parts = namedChildren(node);
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const value = this.convertExpression(parts[index + 1]);
      members.push({ kind: 'memberAssign', name: parts[index].text, value, ...positionOf(parts[index]) });
    }
    return members;
  }

  private convertCollectionElement(node: Node): CollectionElement {
    const [element] = namedChildren(node);
    if (!element) unsupported(node, 'プリプロセッサ ディレクティブ（`#if` など）');
    const [value] = namedChildren(element);
    return { spread: element.type === 'spread_element', value: this.convertExpression(value), ...positionOf(node) };
  }

  private convertAnonymousMembers(node: Node): { name: string | undefined; value: Expression }[] {
    const members: { name: string | undefined; value: Expression }[] = [];
    const children = childrenOf(node).slice(1);
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (!child.isNamed) continue;
      if (children[index + 1]?.type === '=') {
        members.push({ name: child.text, value: this.convertExpression(children[index + 2]) });
        index += 2;
      } else {
        members.push({ name: undefined, value: this.convertExpression(child) });
      }
    }
    return members;
  }

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private convertLambda(node: Node): Expression {
    const modifiers = new Set(
      childrenOf(node)
        .filter((child) => child.type === 'modifier')
        .map((child) => child.text)
    );
    if (modifiers.has('async')) unsupported(node, '`async` のラムダ式');
    if (childrenOf(node).some((child) => child.type === 'attribute_list')) unsupported(node, '属性');
    const parameters: LambdaParameter[] = [];
    for (const parameterNode of fieldChildren(node, 'parameters')) {
      if (parameterNode.type === 'implicit_parameter') {
        parameters.push({
          name: parameterNode.text,
          type: undefined,
          modifier: undefined,
          ...positionOf(parameterNode),
        });
      } else if (parameterNode.type === 'parameter_list') {
        for (const parameter of namedChildren(parameterNode)) {
          if (parameter.type !== 'parameter') unsupported(parameter, '属性');
          const typeNode = field(parameter, 'type');
          const modifier = namedChildren(parameter).find((child) => child.type === 'modifier')?.text;
          if (modifier !== undefined && !['ref', 'out', 'in'].includes(modifier))
            unsupported(parameter, `ラムダ式の引数の \`${modifier}\``);
          parameters.push({
            name: requiredField(parameter, 'name').text,
            type: typeNode ? this.convertType(typeNode) : undefined,
            modifier: modifier as LambdaParameter['modifier'],
            ...positionOf(parameter),
          });
        }
      }
    }
    const bodyNode = requiredField(node, 'body');
    const returnTypeNode = field(node, 'type');
    return {
      kind: 'lambda',
      parameters,
      body: bodyNode.type === 'block' ? this.convertBlockNode(bodyNode) : this.convertExpression(bodyNode),
      isStatic: modifiers.has('static'),
      returnType: returnTypeNode ? this.convertType(returnTypeNode) : undefined,
      ...positionOf(node),
    };
  }

  private convertSwitchExpression(node: Node): Expression {
    const [valueNode, ...armNodes] = namedChildren(node);
    const arms = armNodes.map((arm) => {
      const parts = namedChildren(arm);
      const patternNode = parts[0];
      const guardNode = parts.find((part) => part.type === 'when_clause');
      const valuePart = parts.at(-1) as Node;
      return {
        pattern: this.convertPattern(patternNode),
        guard: guardNode ? this.convertExpression(namedChildren(guardNode)[0]) : undefined,
        value: this.convertExpression(valuePart),
        ...positionOf(arm),
      };
    });
    return { kind: 'switch', value: this.convertExpression(valueNode), arms, ...positionOf(node) };
  }

  // code-gauge-allow functionNcss -- One case per query clause.
  private convertQuery(node: Node): QueryClause[] {
    const clauses: QueryClause[] = [];
    const children = childrenOf(node);
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      const position = positionOf(child);
      const parts = namedChildren(child);
      switch (child.type) {
        case 'from_clause': {
          const typeNode = field(child, 'type');
          const nameNode = requiredField(child, 'name');
          const source = parts.find((part) => !sameNode(part, nameNode) && !sameNode(part, typeNode)) as Node;
          clauses.push({
            kind: 'from',
            name: nameNode.text,
            type: typeNode ? this.convertType(typeNode) : undefined,
            source: this.convertExpression(source),
            ...position,
          });
          break;
        }
        case 'let_clause': {
          clauses.push({ kind: 'let', name: parts[0].text, value: this.convertExpression(parts[1]), ...position });
          break;
        }
        case 'where_clause': {
          clauses.push({ kind: 'where', condition: this.convertExpression(parts[0]), ...position });
          break;
        }
        case 'join_clause': {
          clauses.push(this.convertJoin(child));
          break;
        }
        case 'order_by_clause': {
          clauses.push({ kind: 'orderby', orderings: this.convertOrderings(child), ...position });
          break;
        }
        case 'select_clause': {
          clauses.push({ kind: 'select', value: this.convertExpression(parts[0]), ...position });
          break;
        }
        case 'group_clause': {
          clauses.push({
            kind: 'group',
            value: this.convertExpression(parts[0]),
            key: this.convertExpression(parts[1]),
            ...position,
          });
          break;
        }
        case 'into': {
          const nameNode = children[index + 1];
          clauses.push({ kind: 'into', name: nameNode.text, ...positionOf(nameNode) });
          index++;
          break;
        }
        default: {
          if (child.type === 'identifier') break;
          throw new CompileError([
            { row: child.startPosition.row, message: 'クエリ本体の終わりは select 句か group 句でなければなりません' },
          ]);
        }
      }
    }
    return clauses;
  }

  private convertJoin(node: Node): QueryClause {
    const typeNode = field(node, 'type');
    const parts = namedChildren(node).filter((part) => !sameNode(part, typeNode));
    const intoNode = parts.find((part) => part.type === 'join_into_clause');
    const [nameNode, source, outerKey, innerKey] = parts.filter((part) => !sameNode(part, intoNode));
    return {
      kind: 'join',
      name: nameNode.text,
      type: typeNode ? this.convertType(typeNode) : undefined,
      source: this.convertExpression(source),
      outerKey: this.convertExpression(outerKey),
      innerKey: this.convertExpression(innerKey),
      into: intoNode ? namedChildren(intoNode)[0].text : undefined,
      ...positionOf(node),
    };
  }

  private convertOrderings(node: Node): { key: Expression; descending: boolean }[] {
    const orderings: { key: Expression; descending: boolean }[] = [];
    for (const child of childrenOf(node).slice(1)) {
      if (child.isNamed) orderings.push({ key: this.convertExpression(child), descending: false });
      else if (child.type === 'descending') (orderings.at(-1) as { descending: boolean }).descending = true;
    }
    return orderings;
  }

  // code-gauge-allow functionNcss -- One case per kind of pattern node in the grammar.
  convertPattern(node: Node): Pattern {
    const position = positionOf(node);
    const parts = namedChildren(node);
    switch (node.type) {
      case 'constant_pattern': {
        return { kind: 'constantPattern', value: this.convertExpression(parts[0]), ...position };
      }
      case 'declaration_pattern': {
        const typeNode = requiredField(node, 'type');
        const nameNode = field(node, 'name');
        const designation: Designation = nameNode
          ? { kind: 'single', name: nameNode.text, ...positionOf(nameNode) }
          : { kind: 'discard', ...position };
        if (typeNode.type === 'implicit_type') return { kind: 'varPattern', designation, ...position };
        return { kind: 'declarationPattern', type: this.convertType(typeNode), designation, ...position };
      }
      case 'type_pattern': {
        return { kind: 'typePattern', type: this.convertType(requiredField(node, 'type')), ...position };
      }
      case 'var_pattern': {
        return { kind: 'varPattern', designation: this.convertDesignation(parts[0]), ...position };
      }
      case 'discard': {
        return { kind: 'discardPattern', ...position };
      }
      case 'relational_pattern': {
        const operator = childrenOf(node)[0].type as '<' | '<=' | '>' | '>=';
        return { kind: 'relationalPattern', operator, value: this.convertExpression(parts[0]), ...position };
      }
      case 'negated_pattern': {
        return this.negatedPattern(parts[0], position);
      }
      case 'and_pattern':
      case 'or_pattern': {
        return {
          kind: node.type === 'and_pattern' ? 'andPattern' : 'orPattern',
          left: this.convertPattern(requiredField(node, 'left')),
          right: this.convertPattern(requiredField(node, 'right')),
          ...position,
        };
      }
      case 'parenthesized_pattern': {
        return this.convertPattern(parts[0]);
      }
      case 'recursive_pattern': {
        return this.convertRecursivePattern(node);
      }
      case 'list_pattern':
      case 'slice_pattern': {
        return unsupported(node, 'リスト パターン（`[1, .., 3]`）');
      }
      default: {
        // An expression in a pattern position, such as a constant without the constant_pattern wrapper.
        return { kind: 'constantPattern', value: this.convertExpression(node), ...position };
      }
    }
  }

  /**
   * `not` applied to a pattern. The grammar lets `not` take a whole `and` or `or` chain, as `not (a and b)`, where C#
   * binds `not` tighter than both, as `(not a) and b`, so the negation moves to the chain's leftmost operand.
   */
  private negatedPattern(operand: Node, position: Position): Pattern {
    if (operand.type === 'and_pattern' || operand.type === 'or_pattern') {
      return {
        kind: operand.type === 'and_pattern' ? 'andPattern' : 'orPattern',
        left: this.negatedPattern(requiredField(operand, 'left'), position),
        right: this.convertPattern(requiredField(operand, 'right')),
        ...positionOf(operand),
      };
    }
    return { kind: 'notPattern', pattern: this.convertPattern(operand), ...position };
  }

  private convertRecursivePattern(node: Node): Pattern {
    const typeNode = field(node, 'type');
    const nameNode = field(node, 'name');
    let positional: Subpattern[] | undefined;
    let properties: Subpattern[] | undefined;
    for (const child of namedChildren(node)) {
      if (child.type === 'positional_pattern_clause')
        positional = namedChildren(child).map((sub) => this.convertSubpattern(sub, false));
      if (child.type === 'property_pattern_clause')
        properties = namedChildren(child).map((sub) => this.convertSubpattern(sub, true));
    }
    return {
      kind: 'recursivePattern',
      type: typeNode ? this.convertType(typeNode) : undefined,
      positional,
      properties,
      designation: nameNode ? { kind: 'single', name: nameNode.text, ...positionOf(nameNode) } : undefined,
      ...positionOf(node),
    };
  }

  private convertSubpattern(node: Node, isProperty: boolean): Subpattern {
    const parts = namedChildren(node);
    const patternNode = parts.at(-1) as Node;
    if (parts.length === 1) {
      if (isProperty)
        throw new CompileError([
          {
            row: node.startPosition.row,
            message:
              "プロパティのサブパターンには、照合するプロパティまたはフィールドへの参照が必要です。例: '{ Name: x }'",
          },
        ]);
      return { names: undefined, pattern: this.convertPattern(patternNode), ...positionOf(node) };
    }
    const names = parts[0].text.split('.').map((name) => name.trim());
    return { names, pattern: this.convertPattern(patternNode), ...positionOf(node) };
  }

  protected convertDesignation(node: Node): Designation {
    const position = positionOf(node);
    if (node.type === 'identifier') return { kind: 'single', name: node.text, ...position };
    if (node.type === 'discard') return { kind: 'discard', ...position };
    if (node.type === 'parenthesized_variable_designation' || node.type === 'tuple_pattern') {
      return {
        kind: 'parenthesized',
        elements: namedChildren(node).map((child) => this.convertDesignation(child)),
        ...position,
      };
    }
    throw new CompileError([{ row: node.startPosition.row, message: 'CS1001: 識別子がありません' }]);
  }

  // code-gauge-allow functionNcss -- One case per kind of literal.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  convertLiteral(node: Node): LiteralValue {
    switch (node.type) {
      case 'integer_literal': {
        return parseIntegerLiteral(node);
      }
      case 'real_literal': {
        const match = /^(.*?)([fFdDmM])?$/s.exec(node.text) as RegExpExecArray;
        return {
          type: 'real',
          text: match[1].replaceAll('_', ''),
          suffix: (match[2]?.toLowerCase() ?? '') as '' | 'f' | 'd' | 'm',
        };
      }
      case 'character_literal': {
        const [content] = namedChildren(node);
        const text = content.type === 'escape_sequence' ? unescape(content, content.text) : content.text;
        if (text.length !== 1)
          throw new CompileError([{ row: node.startPosition.row, message: 'CS1012: 文字リテラルに文字が多すぎます' }]);
        return { type: 'char', value: text.charCodeAt(0) };
      }
      case 'string_literal': {
        let value = '';
        for (const part of namedChildren(node)) {
          if (part.type === 'string_literal_encoding') unsupported(node, 'UTF-8 文字列リテラル（`u8`）');
          value += part.type === 'escape_sequence' ? unescape(part, part.text) : part.text;
        }
        return { type: 'string', value };
      }
      case 'verbatim_string_literal': {
        if (/u8$/i.test(node.text)) unsupported(node, 'UTF-8 文字列リテラル（`u8`）');
        return { type: 'string', value: node.text.slice(2, -1).replaceAll('""', '"') };
      }
      case 'raw_string_literal': {
        if (/u8$/i.test(node.text)) unsupported(node, 'UTF-8 文字列リテラル（`u8`）');
        const content = namedChildren(node).find((part) => part.type === 'raw_string_content');
        return { type: 'string', value: rawStringValue(node, content?.text ?? '', node.text) };
      }
      case 'boolean_literal': {
        return { type: 'bool', value: node.text === 'true' };
      }
      default: {
        return { type: 'null' };
      }
    }
  }

  private convertInterpolated(node: Node): InterpolationPart[] {
    const start = namedChildren(node).find((part) => part.type === 'interpolation_start')?.text ?? '$';
    const isVerbatim = start.includes('@');
    const dollarCount = (start.match(/\$/g) ?? []).length;
    const quoteChildren = childrenOf(node).filter((part) => part.type === '"' || part.type === 'interpolation_quote');
    const isRaw = quoteChildren.some((part) => part.text.startsWith('"""')) || dollarCount > 1;
    const parts: InterpolationPart[] = [];
    for (const part of namedChildren(node)) {
      if (part.type === 'string_content') {
        let text = part.text;
        if (!isRaw) text = text.replaceAll('{{', '{').replaceAll('}}', '}');
        if (isVerbatim) text = text.replaceAll('""', '"');
        parts.push({ text });
      } else if (part.type === 'escape_sequence') {
        parts.push({ text: unescape(part, part.text) });
      } else if (part.type === 'interpolation') {
        parts.push({ hole: this.convertInterpolation(part, !isVerbatim && !isRaw) });
      }
    }
    if (isRaw) return dedentRawParts(node, parts);
    return parts;
  }

  /** @param hasEscapes Whether the string reads escape sequences, which then apply to a hole's format too. */
  private convertInterpolation(node: Node, hasEscapes: boolean): NonNullable<InterpolationPart['hole']> {
    let expression: Expression | undefined;
    let alignment: Expression | undefined;
    let format: string | undefined;
    for (const part of namedChildren(node)) {
      if (part.type === 'interpolation_alignment_clause') alignment = this.convertExpression(namedChildren(part)[0]);
      else if (part.type === 'interpolation_format_clause') {
        format = part.text.slice(1);
        // The grammar marks an empty format as an error it hides, so the converter reports Roslyn's error for it.
        if (format === '')
          throw new CompileError([{ row: part.startPosition.row, message: 'CS8089: 書式指定子が空です。' }]);
        if (hasEscapes)
          format = format.replaceAll(/\\(u[\dA-Fa-f]{4}|U[\dA-Fa-f]{8}|x[\dA-Fa-f]{1,4}|.)/g, (escape) =>
            unescape(part, escape)
          );
      } else if (part.type !== 'interpolation_brace') expression = this.convertExpression(part);
    }
    if (!expression) throw new CompileError([{ row: node.startPosition.row, message: 'CS1733: 式が必要です' }]);
    return { expression, alignment, format };
  }
}

function rankOf(rank: Node): number {
  return childrenOf(rank).filter((child) => child.type === ',').length + 1;
}

function parseIntegerLiteral(node: Node): LiteralValue {
  const text = node.text;
  const match = /^(0[xX][\dA-Fa-f_]+|0[bB][01_]+|[\d_]+)([uUlL]*)$/.exec(text);
  if (!match) throw new CompileError([{ row: node.startPosition.row, message: 'CS1021: 整数定数が大きすぎます' }]);
  const digits = match[1].replaceAll('_', '');
  const value = BigInt(digits);
  const suffixText = match[2].toLowerCase();
  const suffix = suffixText === '' ? '' : suffixText === 'u' ? 'u' : suffixText === 'l' ? 'l' : 'ul';
  return { type: 'int', value, suffix, text };
}

/** The value of a raw string literal, whose lines lose the indentation of its closing quotes. */
function rawStringValue(node: Node, content: string, text: string): string {
  const quotes = /^"+/.exec(text)?.[0] ?? '"""';
  const inner = text.slice(quotes.length, text.length - quotes.length);
  if (!inner.includes('\n')) return content;
  return dedentRaw(node, inner);
}

function dedentRaw(node: Node, inner: string): string {
  const lines = inner.split('\n');
  const last = lines.at(-1) as string;
  if (!/^[ \t]*$/.test(last) || lines[0].trim() !== '') {
    throw new CompileError([
      {
        row: node.startPosition.row,
        message: 'CS9000: 生文字列リテラルの区切り記号は、独自の行に置かれる必要があります。',
      },
    ]);
  }
  const indentation = last;
  const body = lines.slice(1, -1).map((line) => {
    // A whitespace-only line keeps what follows the delimiter's indentation, and may be shorter than it.
    if (line.trim() === '')
      return line.startsWith(indentation) ? line.slice(indentation.length) : line.replace(/^[ \t]*/, '');
    if (!line.startsWith(indentation)) {
      throw new CompileError([
        {
          row: node.startPosition.row,
          message: 'CS8999: 行の先頭が生文字列リテラルの終了行と同じ空白ではありません。',
        },
      ]);
    }
    return line.slice(indentation.length);
  });
  // The value keeps the source's line breaks, CRLF included, except the one before the closing delimiter.
  const text = body.join('\n');
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

/** Removes the indentation of a multi-line raw interpolated string from its literal parts. */
function dedentRawParts(node: Node, parts: InterpolationPart[]): InterpolationPart[] {
  const joined = parts.map((part) => part.text ?? '\0').join('');
  if (!joined.includes('\n')) return parts;
  const lines = joined.split('\n');
  const indentation = lines.at(-1) as string;
  if (!/^[ \t]*$/.test(indentation)) {
    throw new CompileError([
      {
        row: node.startPosition.row,
        message: 'CS9000: 生文字列リテラルの区切り記号は、独自の行に置かれる必要があります。',
      },
    ]);
  }
  const holes = parts.filter((part) => part.hole);
  const joinedLines = lines
    .slice(1, -1)
    .map((line) => (line.startsWith(indentation) ? line.slice(indentation.length) : line.trimStart()))
    .join('\n');
  // As in a plain raw string, the line break before the closing delimiter, CR included, is not part of the value.
  const dedented = joinedLines.endsWith('\r') ? joinedLines.slice(0, -1) : joinedLines;
  const result: InterpolationPart[] = [];
  let holeIndex = 0;
  for (const piece of dedented.split('\0').entries()) {
    const [index, text] = piece;
    if (text !== '') result.push({ text });
    if (index < holes.length) result.push(holes[holeIndex++]);
  }
  return result;
}
