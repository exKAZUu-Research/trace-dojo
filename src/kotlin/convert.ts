import type { Node } from '@willbooster/web-tree-sitter';

import type {
  Accessor,
  AssignmentOperator,
  ClassDecl,
  ClassKind,
  ClassParameterDecl,
  Declaration,
  DestructuredName,
  DestructuringDecl,
  EnumEntryDecl,
  FunctionBody,
  FunctionDecl,
  Import,
  KotlinFile,
  MemberDecl,
  Modifiers,
  NamedTypeRef,
  ParameterDecl,
  PropertyDecl,
  Statement,
  SuperSpec,
  TypeParameterDecl,
} from './ast';
import { ExpressionConverter, identifierName } from './convertExpression';
import { firstOfType, hasToken, named, namedOfType, required, rowOf, syntaxError, unavailable } from './convertSupport';

/** The modifiers of the Kotlin tour and of the curriculum's Java programs, which learners' programs may use. */
const CLASS_MODIFIERS = new Set([
  'data',
  'sealed',
  'enum',
  'value',
  'open',
  'abstract',
  'private',
  'public',
  'protected',
]);
const MEMBER_MODIFIERS = new Set([
  'open',
  'abstract',
  'override',
  'private',
  'public',
  'protected',
  'operator',
  'infix',
]);
const NO_MODIFIERS = new Set<string>();

/** Converts tree-sitter's tree into the AST, rejecting syntax that this environment does not run. */
export class Converter extends ExpressionConverter {
  convertFile(root: Node): KotlinFile {
    let packageName: string | undefined;
    const imports: Import[] = [];
    const declarations: Declaration[] = [];
    for (const child of named(root)) {
      switch (child.type) {
        case 'package_header': {
          packageName = named(child)[0].text;
          break;
        }
        case 'import': {
          imports.push(this.convertImport(child));
          break;
        }
        case 'shebang': {
          throw unavailable(child, '#! の行');
        }
        case 'file_annotation': {
          throw unavailable(child, 'ファイルへのアノテーション（@file:）');
        }
        case 'class_declaration':
        case 'object_declaration':
        case 'function_declaration':
        case 'property_declaration': {
          declarations.push(this.convertDeclaration(child, true));
          break;
        }
        case 'type_alias': {
          throw unavailable(child, '型の別名（typealias）');
        }
        default: {
          throw syntaxError(child, '関数やクラス、変数の宣言の外に文は書けません。');
        }
      }
    }
    return { packageName, imports, declarations };
  }

  private convertImport(node: Node): Import {
    const parts = named(node);
    const pathNode = parts[0];
    const path =
      pathNode.type === 'qualified_identifier' ? named(pathNode).map(identifierName) : [identifierName(pathNode)];
    const isWildcard = hasToken(node, '*');
    const aliasNode = parts[1];
    if (aliasNode) throw unavailable(aliasNode, 'import の別名（as）');
    return { row: rowOf(node), path, isWildcard, alias: undefined };
  }

  private convertDeclaration(node: Node, isTopLevel: boolean): Declaration {
    switch (node.type) {
      case 'class_declaration':
      case 'object_declaration': {
        return this.convertClass(node, isTopLevel);
      }
      case 'function_declaration': {
        return this.convertFunction(node, isTopLevel);
      }
      case 'property_declaration': {
        const multi = firstOfType(node, 'multi_variable_declaration');
        if (!multi) return this.convertProperty(node, isTopLevel);
        if (!this.isLocal) throw syntaxError(node, '分解宣言は、関数の中の変数にだけ使えます。');
        return this.convertDestructuring(node, multi);
      }
      case 'type_alias': {
        throw unavailable(node, '型の別名（typealias）');
      }
      default: {
        throw syntaxError(node, '書き方に誤りがあります。');
      }
    }
  }

  private convertTypeParameters(node: Node | undefined, constraints?: Node): TypeParameterDecl[] {
    const declared = this.convertTypeParameterList(node);
    // `where T : A` adds bounds to the type parameters it names.
    for (const constraint of constraints ? namedOfType(constraints, 'type_constraint') : []) {
      const [nameNode, typeNode] = named(constraint);
      const param = declared.find((candidate) => candidate.name === identifierName(nameNode));
      if (!param) throw syntaxError(constraint, `型引数 ${nameNode.text} がありません。`);
      param.bounds.push(this.convertType(required(typeNode)));
    }
    return declared;
  }

  private convertTypeParameterList(node: Node | undefined): TypeParameterDecl[] {
    if (!node) return [];
    this.requireLibrary(node, '型引数を持つ関数・クラスの宣言');
    return namedOfType(node, 'type_parameter').map((parameter) => {
      const parts = named(parameter);
      const modifiers = parts.find((part) => part.type === 'type_parameter_modifiers');
      const keywords = modifiers ? named(modifiers).map((modifier) => modifier.text) : [];
      const bound = parts.find((part) => part.type !== 'identifier' && part.type !== 'type_parameter_modifiers');
      return {
        row: rowOf(parameter),
        name: identifierName(required(parts.find((part) => part.type === 'identifier'))),
        bounds: bound ? [this.convertType(bound)] : [],
        variance: keywords.includes('in') ? 'in' : keywords.includes('out') ? 'out' : undefined,
        isReified: keywords.includes('reified'),
      };
    });
  }

  private convertParameters(node: Node | undefined): ParameterDecl[] {
    if (!node) return [];
    const parameters: ParameterDecl[] = [];
    let modifiers: Modifiers = { keywords: NO_MODIFIERS, annotations: [] };
    for (const child of named(node)) {
      if (child.type === 'parameter_modifiers') {
        modifiers = this.convertModifiers(child, NO_MODIFIERS);
        continue;
      }
      if (child.type === 'parameter') {
        const parts = named(child);
        parameters.push({
          row: rowOf(child),
          name: identifierName(parts[0]),
          type: parts[1] ? this.convertType(parts[1]) : undefined,
          defaultValue: undefined,
          modifiers,
        });
        modifiers = { keywords: NO_MODIFIERS, annotations: [] };
        continue;
      }
      // An expression after a parameter is its default value.
      const last = required(parameters.at(-1));
      last.defaultValue = this.convertExpression(child);
    }
    return parameters;
  }

  private convertFunction(node: Node, isTopLevel: boolean): FunctionDecl {
    if (!isTopLevel && !this.isLibrary && this.isLocal) throw unavailable(node, '関数の中での関数の宣言');
    const parts = named(node);
    const modifiers = this.convertModifiers(firstOfType(node, 'modifiers'), MEMBER_MODIFIERS);
    if (parts.some((part) => part.type === 'type_constraints')) this.requireLibrary(node, '型引数の制約（where）');
    if (parts.some((part) => part.type === 'type_modifiers')) throw unavailable(node, '型へのアノテーション');
    const nameNode = required(node.childForFieldName('name'));
    const parametersNode = required(firstOfType(node, 'function_value_parameters'));
    const bodyNode = firstOfType(node, 'function_body');
    // A type before the name is the receiver of an extension function; the one after the parameters is the result.
    const typeNodes = parts.filter((part) => isTypeNode(part));
    const receiverNode = typeNodes.find((part) => part.startIndex < nameNode.startIndex);
    const returnNode = typeNodes.find((part) => part.startIndex > parametersNode.startIndex);
    const name = identifierName(nameNode);
    if (modifiers.keywords.has('operator') && !this.isLibrary && !['getValue', 'setValue'].includes(name)) {
      throw unavailable(node, '演算子のオーバーロード（operator fun）');
    }
    return {
      kind: 'function',
      row: rowOf(node),
      headerEndRow: rowOf(bodyNode ?? node),
      name,
      modifiers,
      typeParameters: this.convertTypeParameters(
        firstOfType(node, 'type_parameters'),
        firstOfType(node, 'type_constraints')
      ),
      receiver: receiverNode ? this.convertType(receiverNode) : undefined,
      params: this.convertParameters(parametersNode),
      returnType: returnNode ? this.convertType(returnNode) : undefined,
      body: bodyNode ? this.convertFunctionBody(bodyNode) : undefined,
    };
  }

  private convertFunctionBody(node: Node): FunctionBody {
    const inner = named(node)[0];
    if (inner.type === 'block') return { kind: 'block', block: this.convertBody(inner, node) };
    return { kind: 'expression', expression: this.convertExpression(inner) };
  }

  /** Whether the converter is inside a function body, where declarations are local. */
  private isLocal = false;

  private withLocal<T>(isLocal: boolean, convert: () => T): T {
    const outer = this.isLocal;
    this.isLocal = isLocal;
    try {
      return convert();
    } finally {
      this.isLocal = outer;
    }
  }

  private convertProperty(node: Node, isTopLevel: boolean): PropertyDecl {
    const parts = named(node);
    const modifiers = this.convertModifiers(
      firstOfType(node, 'modifiers'),
      this.isLocal ? NO_MODIFIERS : MEMBER_MODIFIERS
    );
    if (parts.some((part) => part.type === 'type_constraints')) this.requireLibrary(node, '型引数の制約（where）');
    const variable = required(firstOfType(node, 'variable_declaration'));
    const declared = this.convertVariableDeclaration(variable);
    if (declared.name === undefined) throw syntaxError(variable, '_ は変数の名前に使えません。');
    const receiverNode = parts.find((part) => isTypeNode(part) && part.startIndex < variable.startIndex);
    const delegateNode = firstOfType(node, 'property_delegate');
    const initializerNode = parts.find(
      (part) =>
        part !== receiverNode &&
        part.startIndex > variable.startIndex &&
        !['getter', 'setter', 'property_delegate', 'modifiers', 'type_constraints'].includes(part.type)
    );
    const getterNode = firstOfType(node, 'getter');
    const setterNode = firstOfType(node, 'setter');
    if (!isTopLevel && this.isLocal && (getterNode || setterNode))
      throw syntaxError(node, 'ローカル変数には get・set を書けません。');
    return {
      kind: 'property',
      row: rowOf(node),
      modifiers,
      isVar: hasToken(node, 'var'),
      name: declared.name,
      type: declared.type,
      receiver: receiverNode ? this.convertType(receiverNode) : undefined,
      typeParameters: this.convertTypeParameters(
        firstOfType(node, 'type_parameters'),
        firstOfType(node, 'type_constraints')
      ),
      initializer: initializerNode ? this.convertExpression(initializerNode) : undefined,
      delegate: delegateNode ? this.convertExpression(named(delegateNode)[0]) : undefined,
      getter: getterNode ? this.convertAccessor(getterNode) : undefined,
      setter: setterNode ? this.convertAccessor(setterNode) : undefined,
    };
  }

  private convertAccessor(node: Node): Accessor {
    const parts = named(node);
    const modifiersNode = firstOfType(node, 'modifiers');
    if (modifiersNode) this.requireLibrary(modifiersNode, 'get・set への修飾子（private set など）');
    const parameterNode = parts.find((part) => part.type === 'identifier');
    const typeNode = parts.find((part) => isTypeNode(part));
    const bodyNode = firstOfType(node, 'function_body');
    return {
      row: rowOf(node),
      modifiers: this.convertModifiers(modifiersNode, NO_MODIFIERS),
      parameterName: parameterNode ? identifierName(parameterNode) : undefined,
      type: typeNode ? this.convertType(typeNode) : undefined,
      body: bodyNode ? this.withLocal(true, () => this.convertFunctionBody(bodyNode)) : undefined,
    };
  }

  private convertClass(node: Node, isTopLevel: boolean): ClassDecl {
    if (!isTopLevel && this.isLocal && !this.isLibrary) throw unavailable(node, '関数の中でのクラスの宣言');
    const modifiersNode = firstOfType(node, 'modifiers');
    const modifiers = this.convertModifiers(modifiersNode, CLASS_MODIFIERS);
    if (hasToken(node, 'interface') && hasToken(node, 'fun')) {
      this.requireLibrary(node, '関数型のインターフェース（fun interface）');
    }
    const classKind: ClassKind =
      node.type === 'object_declaration'
        ? 'object'
        : hasToken(node, 'interface')
          ? 'interface'
          : modifiers.keywords.has('enum')
            ? 'enum'
            : 'class';
    if (
      modifiers.keywords.has('value') &&
      !modifiers.annotations.some((annotation) => annotation.name === 'JvmInline')
    ) {
      throw syntaxError(node, 'value class には @JvmInline を付けてください。');
    }
    const primaryNode = firstOfType(node, 'primary_constructor');
    const bodyNode = firstOfType(node, 'class_body') ?? firstOfType(node, 'enum_class_body');
    if (firstOfType(node, 'type_constraints')) this.requireLibrary(node, '型引数の制約（where）');
    return {
      kind: 'class',
      row: rowOf(node),
      headerEndRow: rowOf(bodyNode ?? node),
      endRow: node.endPosition.row,
      classKind,
      name: identifierName(required(node.childForFieldName('name'))),
      isFunInterface: hasToken(node, 'interface') && hasToken(node, 'fun'),
      modifiers,
      typeParameters: this.convertTypeParameters(
        firstOfType(node, 'type_parameters'),
        firstOfType(node, 'type_constraints')
      ),
      primaryConstructor: primaryNode ? this.convertPrimaryConstructor(primaryNode) : undefined,
      supers: this.convertSupers(firstOfType(node, 'delegation_specifiers')),
      ...this.withLocal(false, () => this.convertClassBody(bodyNode)),
    };
  }

  private convertPrimaryConstructor(node: Node): NonNullable<ClassDecl['primaryConstructor']> {
    const modifiersNode = firstOfType(node, 'modifiers');
    if (modifiersNode || hasToken(node, 'constructor'))
      this.requireLibrary(node, 'constructor キーワードを書いた主コンストラクタ');
    const parametersNode = firstOfType(node, 'class_parameters');
    const params = (parametersNode ? namedOfType(parametersNode, 'class_parameter') : []).map(
      (parameter): ClassParameterDecl => {
        const parts = named(parameter);
        const parameterModifiers = this.convertModifiers(firstOfType(parameter, 'modifiers'), MEMBER_MODIFIERS);
        const nameNode = required(parts.find((part) => part.type === 'identifier'));
        const typeNode = parts.find((part) => isTypeNode(part));
        const defaultNode = parts.find((part) => part !== nameNode && part !== typeNode && part.type !== 'modifiers');
        return {
          row: rowOf(parameter),
          name: identifierName(nameNode),
          type: typeNode ? this.convertType(typeNode) : undefined,
          defaultValue: defaultNode ? this.convertExpression(defaultNode) : undefined,
          modifiers: parameterModifiers,
          binding: hasToken(parameter, 'val') ? 'val' : hasToken(parameter, 'var') ? 'var' : undefined,
        };
      }
    );
    return { row: rowOf(node), params, modifiers: this.convertModifiers(modifiersNode, NO_MODIFIERS) };
  }

  private convertSupers(node: Node | undefined): SuperSpec[] {
    if (!node) return [];
    return namedOfType(node, 'delegation_specifier').map((specifier): SuperSpec => {
      const inner = named(specifier)[0];
      const row = rowOf(specifier);
      switch (inner.type) {
        case 'constructor_invocation': {
          const [typeNode, argumentsNode] = named(inner);
          return {
            kind: 'constructorCall',
            row,
            type: this.namedType(typeNode),
            args: namedOfType(argumentsNode, 'value_argument').map((argument) => this.convertArgument(argument)),
          };
        }
        case 'explicit_delegation': {
          const [typeNode, delegateNode] = named(inner);
          return {
            kind: 'delegated',
            row,
            type: this.namedType(typeNode),
            delegate: this.convertExpression(delegateNode),
          };
        }
        case 'annotation': {
          throw unavailable(inner, '親の型へのアノテーション');
        }
        default: {
          return { kind: 'type', row, type: this.namedType(inner) };
        }
      }
    });
  }

  private namedType(node: Node): NamedTypeRef {
    const type = this.convertType(node);
    if (type.kind !== 'named' || type.nullable)
      throw syntaxError(node, '親にはクラスかインターフェースを書いてください。');
    return type;
  }

  private convertClassBody(node: Node | undefined): Pick<ClassDecl, 'members' | 'enumEntries'> {
    const members: MemberDecl[] = [];
    const enumEntries: EnumEntryDecl[] = [];
    for (const child of node ? named(node) : []) {
      if (child.type === 'enum_entry') {
        enumEntries.push(this.convertEnumEntry(child));
        continue;
      }
      members.push(this.convertMember(child));
    }
    return { members, enumEntries };
  }

  private convertEnumEntry(node: Node): EnumEntryDecl {
    const parts = named(node);
    if (firstOfType(node, 'modifiers')) throw unavailable(node, '列挙型の定数へのアノテーション');
    const argumentsNode = firstOfType(node, 'value_arguments');
    const bodyNode = firstOfType(node, 'class_body');
    if (bodyNode) this.requireLibrary(bodyNode, '本体を持つ列挙型の定数');
    return {
      row: rowOf(node),
      name: identifierName(required(parts.find((part) => part.type === 'identifier'))),
      args: argumentsNode
        ? namedOfType(argumentsNode, 'value_argument').map((argument) => this.convertArgument(argument))
        : [],
      members: bodyNode ? this.convertClassBody(bodyNode).members : undefined,
    };
  }

  private convertMember(node: Node): MemberDecl {
    switch (node.type) {
      case 'anonymous_initializer': {
        return {
          kind: 'init',
          row: rowOf(node),
          block: this.withLocal(true, () => this.convertBody(named(node)[0], node)),
        };
      }
      case 'secondary_constructor': {
        this.requireLibrary(node, '2つ目以降のコンストラクタ（constructor(...)）');
        return this.convertSecondaryConstructor(node);
      }
      case 'companion_object': {
        return this.convertCompanion(node);
      }
      case 'class_declaration':
      case 'object_declaration':
      case 'function_declaration':
      case 'property_declaration': {
        return this.withLocal(false, () => this.convertDeclaration(node, false)) as MemberDecl;
      }
      case 'type_alias': {
        throw unavailable(node, '型の別名（typealias）');
      }
      default: {
        throw syntaxError(node, 'クラスの本体に書けるのは、プロパティや関数などの宣言だけです。');
      }
    }
  }

  private convertCompanion(node: Node): ClassDecl {
    const nameNode = node.childForFieldName('name');
    const bodyNode = firstOfType(node, 'class_body');
    return {
      kind: 'class',
      row: rowOf(node),
      headerEndRow: rowOf(bodyNode ?? node),
      endRow: node.endPosition.row,
      classKind: 'companion',
      name: nameNode ? identifierName(nameNode) : 'Companion',
      isFunInterface: false,
      modifiers: this.convertModifiers(firstOfType(node, 'modifiers'), CLASS_MODIFIERS),
      typeParameters: [],
      primaryConstructor: undefined,
      supers: this.convertSupers(firstOfType(node, 'delegation_specifiers')),
      ...this.withLocal(false, () => this.convertClassBody(bodyNode)),
    };
  }

  private convertSecondaryConstructor(node: Node): MemberDecl {
    const delegationNode = firstOfType(node, 'constructor_delegation_call');
    const bodyNode = firstOfType(node, 'block');
    return {
      kind: 'constructor',
      row: rowOf(node),
      headerEndRow: rowOf(bodyNode ?? node),
      modifiers: this.convertModifiers(firstOfType(node, 'modifiers'), MEMBER_MODIFIERS),
      params: this.convertParameters(firstOfType(node, 'function_value_parameters')),
      delegation: delegationNode
        ? {
            kind: hasToken(delegationNode, 'this') ? 'this' : 'super',
            row: rowOf(delegationNode),
            args: namedOfType(required(firstOfType(delegationNode, 'value_arguments')), 'value_argument').map(
              (argument) => this.convertArgument(argument)
            ),
          }
        : undefined,
      body: bodyNode ? this.withLocal(true, () => this.convertBody(bodyNode, node)) : undefined,
    };
  }

  protected convertStatement(node: Node): Statement {
    const row = rowOf(node);
    switch (node.type) {
      case 'class_declaration':
      case 'object_declaration':
      case 'function_declaration':
      case 'property_declaration': {
        return this.withLocal(true, () => this.convertDeclaration(node, false));
      }
      case 'type_alias': {
        throw unavailable(node, '型の別名（typealias）');
      }
      case 'destructuring_declaration': {
        return this.convertDestructuring(node, required(firstOfType(node, 'multi_variable_declaration')));
      }
      case 'assignment': {
        return {
          kind: 'assignment',
          row,
          operator: required(node.childForFieldName('operator')).type as AssignmentOperator,
          target: this.convertExpression(required(node.childForFieldName('left'))),
          value: this.convertExpression(required(node.childForFieldName('right'))),
        };
      }
      case 'for_statement': {
        return this.convertFor(node);
      }
      case 'while_statement': {
        if (firstOfType(node, 'label') || firstOfType(node, 'annotation')) throw unavailable(node, 'ラベル（名前@）');
        return {
          kind: 'while',
          row,
          condition: this.convertExpression(required(node.childForFieldName('condition'))),
          body: this.withLocal(true, () => this.convertBody(node.childForFieldName('body'), node)),
        };
      }
      case 'do_while_statement': {
        if (firstOfType(node, 'label') || firstOfType(node, 'annotation')) throw unavailable(node, 'ラベル（名前@）');
        const condition = required(node.childForFieldName('condition'));
        return {
          kind: 'doWhile',
          row,
          conditionRow: rowOf(condition),
          condition: this.convertExpression(condition),
          body: this.withLocal(true, () => this.convertBody(node.childForFieldName('body'), node)),
        };
      }
      default: {
        return {
          kind: 'expressionStatement',
          row,
          expression: this.withLocal(true, () => this.convertExpression(node)),
        };
      }
    }
  }

  private convertFor(node: Node): Statement {
    const parts = named(node);
    if (parts.some((part) => part.type === 'label' || part.type === 'annotation'))
      throw unavailable(node, 'ラベル（名前@）');
    const body = node.childForFieldName('body');
    const variableNode = required(
      parts.find((part) => part.type === 'variable_declaration' || part.type === 'multi_variable_declaration')
    );
    const iterableNode = required(parts.find((part) => part !== variableNode && part !== body));
    let variable: Extract<Statement, { kind: 'for' }>['variable'];
    if (variableNode.type === 'multi_variable_declaration') {
      if (variableNode.childForFieldName('type')) throw syntaxError(variableNode, '分解宣言の全体には型を書けません。');
      variable = { row: rowOf(variableNode), names: this.destructuredNames(variableNode) };
    } else {
      const declared = this.convertVariableDeclaration(variableNode);
      variable = { row: declared.row, name: declared.name ?? '_', type: declared.type };
    }
    return {
      kind: 'for',
      row: rowOf(node),
      variable,
      iterable: this.convertExpression(iterableNode),
      body: this.withLocal(true, () => this.convertBody(body, node)),
    };
  }

  private convertDestructuring(node: Node, multi: Node): DestructuringDecl {
    if (firstOfType(node, 'modifiers')) throw unavailable(node, '分解宣言への修飾子・アノテーション');
    if (multi.childForFieldName('type')) throw syntaxError(multi, '分解宣言の全体には型を書けません。');
    const initializer = named(node).find((part) => part.startIndex > multi.startIndex);
    if (!initializer) throw syntaxError(node, '分解宣言には = で値を書いてください。');
    return {
      kind: 'destructuring',
      row: rowOf(node),
      isVar: hasToken(node, 'var'),
      names: this.destructuredNames(multi),
      initializer: this.convertExpression(initializer),
    };
  }

  private destructuredNames(node: Node): DestructuredName[] {
    return namedOfType(node, 'variable_declaration').map((variable) => {
      const declared = this.convertVariableDeclaration(variable);
      return declared.name === undefined ? undefined : { row: declared.row, name: declared.name, type: declared.type };
    });
  }
}

const TYPE_NODES = new Set(['user_type', 'nullable_type', 'function_type', 'parenthesized_type', 'non_nullable_type']);

function isTypeNode(node: Node): boolean {
  return TYPE_NODES.has(node.type);
}
