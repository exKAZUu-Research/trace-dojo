// code-gauge-allow-file fileNcss -- The convert module keeps one stage of the C# interpreter together.
import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type {
  Accessor,
  Argument,
  AttributeNode,
  Block,
  CatchClause,
  CompilationUnit,
  Constraint,
  ConstraintClause,
  Designation,
  EnumMember,
  Expression,
  MemberDeclaration,
  MethodDeclaration,
  Modifier,
  Modifiers,
  NamespaceDeclaration,
  OperatorDeclaration,
  Parameter,
  Statement,
  SwitchLabel,
  SwitchSection,
  TypeDeclaration,
  TypeNode,
  TypeParameterDeclaration,
  UsingDirective,
  VariableDeclarator,
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
  unsupported,
} from './convertBase';
import { ExpressionConverter } from './convertExpression';

const UNSUPPORTED_STATEMENTS: Record<string, string> = {};

const MODIFIERS: ReadonlySet<string> = new Set<Modifier>([
  'unsafe',
  'public',
  'private',
  'protected',
  'internal',
  'static',
  'readonly',
  'const',
  'abstract',
  'virtual',
  'override',
  'sealed',
  'new',
  'partial',
  'required',
  'file',
  'volatile',
  'async',
]);

const UNSUPPORTED_MODIFIERS: Record<string, string> = { extern: '`extern`', fixed: '`fixed`', scoped: '`scoped`' };

/** C#'s reserved keywords, which are identifiers only with an `@` prefix. */
const RESERVED_KEYWORDS = new Set([
  'abstract',
  'as',
  'base',
  'bool',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'checked',
  'class',
  'const',
  'continue',
  'decimal',
  'default',
  'delegate',
  'do',
  'double',
  'else',
  'enum',
  'event',
  'explicit',
  'extern',
  'false',
  'finally',
  'fixed',
  'float',
  'for',
  'foreach',
  'goto',
  'if',
  'implicit',
  'in',
  'int',
  'interface',
  'internal',
  'is',
  'lock',
  'long',
  'namespace',
  'new',
  'null',
  'object',
  'operator',
  'out',
  'override',
  'params',
  'private',
  'protected',
  'public',
  'readonly',
  'ref',
  'return',
  'sbyte',
  'sealed',
  'short',
  'sizeof',
  'stackalloc',
  'static',
  'string',
  'struct',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'uint',
  'ulong',
  'unchecked',
  'unsafe',
  'ushort',
  'using',
  'virtual',
  'void',
  'volatile',
  'while',
]);

/**
 * Rejects a reserved keyword where the grammar reads it as an identifier, as in `int class = 1;` or `class => 1`,
 * where Roslyn expects an identifier and C# needs `@class`.
 */
function rejectKeywordIdentifiers(root: Node): void {
  for (const node of root.descendantsOfType('identifier')) {
    // The grammar reads the `default` constraint as a type named `default`.
    if (node?.text === 'default' && node.parent?.type === 'type_parameter_constraint') continue;
    if (node && RESERVED_KEYWORDS.has(node.text))
      throw new CompileError([{ row: node.startPosition.row, message: 'CS1001: 識別子がありません' }]);
  }
}

/** Reports each `unsafe` of a program built without `AllowUnsafeBlocks`, as Roslyn does (CS0227). */
function rejectUnsafe(root: Node): void {
  const rows = [
    ...root.descendantsOfType('unsafe_statement'),
    ...root.descendantsOfType('modifier').filter((node) => node?.text === 'unsafe'),
  ]
    .map((node) => node?.startPosition.row as number)
    .toSorted((a, b) => a - b);
  if (rows.length === 0) return;
  throw new CompileError(
    rows.map((row) => ({ row, message: 'CS0227: アンセーフ コードは /unsafe でコンパイルした場合のみ有効です' }))
  );
}

/** Converts tree-sitter's C# tree into the program's syntax tree. */
export class Converter extends ExpressionConverter {
  convertCompilationUnit(root: Node): CompilationUnit {
    if (!this.isLibrary) rejectKeywordIdentifiers(root);
    if (!this.isLibrary && !this.allowsUnsafe) rejectUnsafe(root);
    const unit: CompilationUnit = { usings: [], statements: [], members: [], sourceRows: root.endPosition.row + 1 };
    for (const child of namedChildren(root)) {
      switch (child.type) {
        case 'using_directive': {
          unit.usings.push(this.convertUsing(child));
          break;
        }
        case 'global_attribute': {
          const target = childrenOf(child).find((part) => part.type === 'assembly' || part.type === 'module')?.text;
          for (const attribute of namedChildren(child).filter((part) => part.type === 'attribute'))
            (unit.attributes ??= []).push(this.convertAttribute(attribute, target));
          break;
        }
        case 'global_statement': {
          if (unit.members.length > 0) {
            throw new CompileError([
              {
                row: child.startPosition.row,
                message: 'CS8803: トップレベルのステートメントは、名前空間および型の宣言の前にある必要があります。',
              },
            ]);
          }
          unit.statements.push(this.convertStatement(namedChildren(child)[0]));
          break;
        }
        case 'file_scoped_namespace_declaration': {
          unit.members.push(this.convertFileScopedNamespace(child));
          break;
        }
        default: {
          unit.members.push(this.convertNamespaceMember(child));
        }
      }
    }
    return unit;
  }

  private convertUsing(node: Node): UsingDirective {
    const aliasNode = field(node, 'name');
    const target = namedChildren(node).find((child) => !sameNode(child, aliasNode)) as Node;
    const common = { name: this.convertType(target), isGlobal: hasToken(node, 'global'), ...positionOf(node) };
    if (aliasNode) return { kind: 'alias', alias: aliasNode.text, ...common };
    return { kind: hasToken(node, 'static') ? 'static' : 'namespace', ...common };
  }

  private convertFileScopedNamespace(node: Node): NamespaceDeclaration {
    const declaration: NamespaceDeclaration = {
      kind: 'namespace',
      name: qualifiedNameParts(requiredField(node, 'name')),
      usings: [],
      members: [],
      ...positionOf(node),
    };
    for (const child of namedChildren(node)) {
      if (sameNode(child, field(node, 'name'))) continue;
      if (child.type === 'using_directive') declaration.usings.push(this.convertUsing(child));
      else declaration.members.push(this.convertNamespaceMember(child));
    }
    return declaration;
  }

  private convertNamespaceMember(node: Node): TypeDeclaration | NamespaceDeclaration {
    switch (node.type) {
      case 'namespace_declaration': {
        const declaration: NamespaceDeclaration = {
          kind: 'namespace',
          name: qualifiedNameParts(requiredField(node, 'name')),
          usings: [],
          members: [],
          ...positionOf(node),
        };
        for (const child of namedChildren(requiredField(node, 'body'))) {
          if (child.type === 'using_directive') declaration.usings.push(this.convertUsing(child));
          else declaration.members.push(this.convertNamespaceMember(child));
        }
        return declaration;
      }
      case 'class_declaration':
      case 'struct_declaration':
      case 'record_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'delegate_declaration': {
        return this.convertTypeDeclaration(node);
      }
      case 'extern_alias_directive': {
        return unsupported(node, '`extern alias`');
      }
      case 'global_attribute': {
        throw new CompileError([
          {
            row: node.startPosition.row,
            message:
              'CS1730: アセンブリおよびモジュールの属性は、すべての using 句の後に指定し、ファイルで定義されているすべての型の前に指定する必要があります',
          },
        ]);
      }
      case 'file_scoped_namespace_declaration': {
        throw new CompileError([
          {
            row: node.startPosition.row,
            message:
              'CS8954: ソース ファイルには、ファイルスコープ付きの名前空間の宣言を 1 つだけ含めることができます。',
          },
        ]);
      }
      default: {
        if (node.type === 'global_statement') {
          throw new CompileError([
            {
              row: node.startPosition.row,
              message: 'CS8803: トップレベルのステートメントは、名前空間および型の宣言の前にある必要があります。',
            },
          ]);
        }
        throw new CompileError([
          { row: node.startPosition.row, message: 'CS1022: 型、名前空間の定義、またはファイルの終わりが必要です' },
        ]);
      }
    }
  }

  // code-gauge-allow functionNcss -- Each kind of type declaration keeps its parts in different children.
  private convertTypeDeclaration(node: Node): TypeDeclaration {
    const typeKind =
      node.type === 'record_declaration'
        ? hasToken(node, 'struct')
          ? 'struct'
          : 'class'
        : (node.type.replace('_declaration', '') as TypeDeclaration['typeKind']);
    const declaration: TypeDeclaration = {
      kind: 'type',
      typeKind,
      isRecord: node.type === 'record_declaration',
      isRefStruct: typeKind === 'struct' && hasToken(node, 'ref'),
      modifiers: this.convertModifiers(node),
      name: requiredField(node, 'name').text,
      typeParameters: [],
      constraints: [],
      primaryParameters: undefined,
      bases: [],
      baseArguments: undefined,
      members: [],
      enumMembers: [],
      enumUnderlyingType: undefined,
      delegateReturnType: undefined,
      delegateParameters: [],
      endRow: node.endPosition.row,
      ...this.attributed(node),
      ...positionOf(requiredField(node, 'name')),
    };
    for (const child of namedChildren(node)) {
      switch (child.type) {
        case 'type_parameter_list': {
          declaration.typeParameters = this.convertTypeParameters(child);
          break;
        }
        case 'type_parameter_constraints_clause': {
          declaration.constraints.push(this.convertConstraintClause(child));
          break;
        }
        case 'parameter_list': {
          if (typeKind === 'delegate') declaration.delegateParameters = this.convertParameters(child);
          else declaration.primaryParameters = this.convertParameters(child);
          break;
        }
        case 'base_list': {
          this.convertBaseList(child, declaration);
          break;
        }
        case 'declaration_list': {
          declaration.members = namedChildren(child).flatMap((member) => this.convertMember(member, declaration));
          break;
        }
        case 'enum_member_declaration_list': {
          declaration.enumMembers = namedChildren(child).map((member) => this.convertEnumMember(member));
          break;
        }
        default: {
          break;
        }
      }
    }
    if (typeKind === 'delegate') declaration.delegateReturnType = this.convertType(requiredField(node, 'type'));
    return declaration;
  }

  private convertBaseList(node: Node, declaration: TypeDeclaration): void {
    const underlying = field(node, 'underlying_type');
    if (underlying) {
      declaration.enumUnderlyingType = this.convertType(underlying);
      return;
    }
    for (const child of namedChildren(node)) {
      if (child.type === 'argument_list') declaration.baseArguments = this.convertArguments(child);
      else declaration.bases.push(this.convertType(child));
    }
  }

  private convertEnumMember(node: Node): EnumMember {
    const valueNode = field(node, 'value');
    return {
      name: requiredField(node, 'name').text,
      value: valueNode ? this.convertExpression(valueNode) : undefined,
      ...this.attributed(node),
      ...positionOf(node),
    };
  }

  private convertTypeParameters(node: Node): TypeParameterDeclaration[] {
    return namedChildren(node).map((parameter) => {
      const variance = hasToken(parameter, 'out') ? 'out' : hasToken(parameter, 'in') ? 'in' : undefined;
      return {
        name: requiredField(parameter, 'name').text,
        variance,
        ...this.attributed(parameter),
        ...positionOf(parameter),
      };
    });
  }

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private convertConstraintClause(node: Node): ConstraintClause {
    const [nameNode, ...constraintNodes] = namedChildren(node);
    const constraints = constraintNodes.map((constraint): Constraint => {
      const position = positionOf(constraint);
      const typeNode = field(constraint, 'type');
      if (typeNode) {
        if (typeNode.type === 'identifier' && typeNode.text === 'notnull') return { kind: 'notnull', ...position };
        if (typeNode.type === 'identifier' && typeNode.text === 'unmanaged') return { kind: 'unmanaged', ...position };
        if (typeNode.type === 'identifier' && typeNode.text === 'default') return { kind: 'default', ...position };
        return { kind: 'type', type: this.convertType(typeNode), ...position };
      }
      if (namedChildren(constraint).some((child) => child.type === 'constructor_constraint'))
        return { kind: 'new', ...position };
      if (hasToken(constraint, 'notnull')) return { kind: 'notnull', ...position };
      if (hasToken(constraint, 'unmanaged')) return { kind: 'unmanaged', ...position };
      if (hasToken(constraint, 'class')) return { kind: 'class', nullable: hasToken(constraint, '?'), ...position };
      if (hasToken(constraint, 'struct')) return { kind: 'struct', ...position };
      if (hasToken(constraint, 'default')) return { kind: 'default', ...position };
      return unsupported(constraint, 'この制約');
    });
    return { name: nameNode.text, constraints, ...positionOf(node) };
  }

  private convertMember(node: Node, owner: TypeDeclaration): MemberDeclaration[] {
    if (node.type === 'extension_declaration') return this.convertExtensionBlock(node, owner);
    const attributes = this.attributed(node);
    return this.convertMemberWithoutAttributes(node, owner).map((member) => ({ ...member, ...attributes }));
  }

  // code-gauge-allow functionNcss -- One case per kind of member declaration.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private convertMemberWithoutAttributes(node: Node, owner: TypeDeclaration): MemberDeclaration[] {
    if (
      node.type !== 'field_declaration' &&
      node.type !== 'event_field_declaration' &&
      field(node, 'name') === undefined &&
      node.type !== 'indexer_declaration' &&
      node.type !== 'operator_declaration' &&
      !node.type.endsWith('_declaration')
    ) {
      throw new CompileError([
        {
          row: node.startPosition.row,
          message:
            "クラス、レコード、構造体、またはインターフェイス メンバー宣言の中のトークン '" +
            node.text.split(/\s/)[0] +
            "' は無効です",
        },
      ]);
    }
    const specifier = namedChildren(node).find((child) => child.type === 'explicit_interface_specifier');
    const explicitInterface = specifier ? { explicitInterface: this.convertType(namedChildren(specifier)[0]) } : {};
    const position = positionOf(field(node, 'name') ?? node);
    switch (node.type) {
      case 'method_declaration': {
        return [{ ...this.convertMethod(node), ...explicitInterface }];
      }
      case 'event_declaration': {
        return [this.convertEventAccessors(node, explicitInterface.explicitInterface)];
      }
      case 'constructor_declaration': {
        const initializerNode = namedChildren(node).find((child) => child.type === 'constructor_initializer');
        const bodyNode = field(node, 'body');
        return [
          {
            kind: 'constructor',
            modifiers: this.convertModifiers(node),
            name: requiredField(node, 'name').text,
            parameters: this.convertParameters(requiredField(node, 'parameters')),
            initializer: initializerNode
              ? {
                  kind: hasToken(initializerNode, 'base') ? 'base' : 'this',
                  args: this.convertArguments(namedChildren(initializerNode)[0]),
                  ...positionOf(initializerNode),
                }
              : undefined,
            body: this.convertBody(bodyNode),
            bodyRow: bodyNode?.startPosition.row ?? node.startPosition.row,
            startRow: node.startPosition.row,
            ...position,
          },
        ];
      }
      case 'destructor_declaration': {
        return [
          {
            kind: 'destructor',
            name: requiredField(node, 'name').text,
            body: this.convertBody(field(node, 'body')),
            ...position,
          },
        ];
      }
      case 'field_declaration': {
        const declarationNode = namedChildren(node).find((child) => child.type === 'variable_declaration') as Node;
        const { type, declarators } = this.convertVariableDeclaration(declarationNode);
        const modifiers = this.convertModifiers(node);
        if (modifiers.set.has('const')) rejectConstantsWithoutValues(declarators);
        return [{ kind: 'field', modifiers, type, declarators, ...positionOf(node) }];
      }
      case 'event_field_declaration': {
        const declarationNode = namedChildren(node).find((child) => child.type === 'variable_declaration') as Node;
        const { type, declarators } = this.convertVariableDeclaration(declarationNode);
        return [{ kind: 'event', modifiers: this.convertModifiers(node), type, declarators, ...positionOf(node) }];
      }
      case 'property_declaration': {
        return [{ ...this.convertProperty(node), ...explicitInterface } as MemberDeclaration];
      }
      case 'indexer_declaration': {
        const valueNode = field(node, 'value');
        const accessorsNode = field(node, 'accessors');
        return [
          {
            kind: 'indexer',
            modifiers: this.convertModifiers(node),
            type: this.convertType(requiredField(node, 'type')),
            parameters: this.convertParameters(requiredField(node, 'parameters')),
            accessors: accessorsNode
              ? this.convertAccessors(accessorsNode)
              : [{ kind: 'get', modifiers: emptyModifiers(), body: this.convertBody(valueNode), ...positionOf(node) }],
            ...explicitInterface,
            ...positionOf(node),
          },
        ];
      }
      case 'operator_declaration':
      case 'conversion_operator_declaration': {
        const bodyNode = field(node, 'body');
        const isConversion = node.type === 'conversion_operator_declaration';
        const operatorNode = isConversion ? undefined : requiredField(node, 'operator');
        const operator = isConversion
          ? hasToken(node, 'implicit')
            ? 'implicit'
            : 'explicit'
          : (operatorNode as Node).type;
        return [
          {
            kind: 'operator',
            modifiers: this.convertModifiers(node),
            returnType: this.convertType(requiredField(node, 'type')),
            operator,
            isChecked: hasToken(node, 'checked'),
            parameters: this.convertParameters(requiredField(node, 'parameters')),
            body: this.convertBody(bodyNode),
            bodyRow: bodyNode?.startPosition.row ?? node.startPosition.row,
            startRow: node.startPosition.row,
            ...positionOf(operatorNode ?? requiredField(node, 'type')),
          },
        ];
      }
      case 'class_declaration':
      case 'struct_declaration':
      case 'record_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'delegate_declaration': {
        return [this.convertTypeDeclaration(node)];
      }
      default: {
        if (owner.typeKind === 'interface') unsupported(node, 'この宣言');
        throw new CompileError([
          {
            row: node.startPosition.row,
            message: `CS1519: メンバー宣言のトークン '${node.text.split(/\s/)[0]}' が無効です`,
          },
        ]);
      }
    }
  }

  private convertMethod(node: Node): MethodDeclaration {
    const bodyNode = field(node, 'body');
    const typeParametersNode = field(node, 'type_parameters');
    return {
      kind: 'method',
      modifiers: this.convertModifiers(node),
      returnType: this.convertType(requiredField(node, node.type === 'local_function_statement' ? 'type' : 'returns')),
      name: requiredField(node, 'name').text,
      typeParameters: typeParametersNode ? this.convertTypeParameters(typeParametersNode) : [],
      constraints: namedChildren(node)
        .filter((child) => child.type === 'type_parameter_constraints_clause')
        .map((child) => this.convertConstraintClause(child)),
      parameters: this.convertParameters(requiredField(node, 'parameters')),
      body: this.convertBody(bodyNode),
      bodyRow: bodyNode?.startPosition.row ?? node.startPosition.row,
      startRow: node.startPosition.row,
      ...positionOf(requiredField(node, 'name')),
    };
  }

  private convertEventAccessors(node: Node, explicitInterface: TypeNode | undefined): MemberDeclaration {
    const accessors = namedChildren(requiredField(node, 'accessors'));
    const bodyOf = (kind: string): Block | Expression | undefined => {
      const accessor = accessors.find((candidate) => requiredField(candidate, 'name').text === kind);
      return accessor ? this.convertBody(field(accessor, 'body')) : undefined;
    };
    for (const accessor of accessors) {
      if (!['add', 'remove'].includes(requiredField(accessor, 'name').text))
        throw new CompileError([
          { row: accessor.startPosition.row, message: 'CS1055: add または remove アクセサーが必要です' },
        ]);
    }
    return {
      kind: 'eventAccessors',
      modifiers: this.convertModifiers(node),
      type: this.convertType(requiredField(node, 'type')),
      name: requiredField(node, 'name').text,
      add: bodyOf('add'),
      remove: bodyOf('remove'),
      ...(explicitInterface ? { explicitInterface } : {}),
      ...positionOf(requiredField(node, 'name')),
    };
  }

  private convertProperty(node: Node): MemberDeclaration {
    const valueNode = field(node, 'value');
    const accessorsNode = field(node, 'accessors');
    const isExpressionBodied = valueNode?.type === 'arrow_expression_clause';
    const accessors: Accessor[] = accessorsNode
      ? this.convertAccessors(accessorsNode)
      : [
          {
            kind: 'get',
            modifiers: emptyModifiers(),
            body: this.convertBody(valueNode),
            ...positionOf(valueNode ?? node),
          },
        ];
    let initializer: Expression | undefined;
    if (valueNode && !isExpressionBodied)
      initializer =
        valueNode.type === 'initializer_expression'
          ? this.convertArrayInitializer(valueNode)
          : this.convertExpression(valueNode);
    return {
      kind: 'property',
      modifiers: this.convertModifiers(node),
      type: this.convertType(requiredField(node, 'type')),
      name: requiredField(node, 'name').text,
      accessors,
      initializer,
      isExpressionBodied,
      ...positionOf(requiredField(node, 'name')),
    };
  }

  private convertAccessors(node: Node): Accessor[] {
    return namedChildren(node).map((accessor) => {
      const kind = requiredField(accessor, 'name').text;
      if (!['get', 'set', 'init'].includes(kind)) {
        throw new CompileError([
          { row: accessor.startPosition.row, message: 'CS1014: get または set アクセサーが必要です' },
        ]);
      }
      return {
        kind: kind as Accessor['kind'],
        modifiers: this.convertModifiers(accessor),
        body: this.convertBody(field(accessor, 'body')),
        ...this.attributed(accessor),
        ...positionOf(accessor),
      };
    });
  }

  private convertBody(node: Node | undefined): Block | Expression | undefined {
    if (!node) return undefined;
    if (node.type === 'block') return this.convertBlockNode(node);
    return this.convertExpression(namedChildren(node)[0]);
  }

  protected convertParameters(node: Node): Parameter[] {
    const parameters: Parameter[] = [];
    const children = childrenOf(node);
    // The grammar keeps the attributes of a `params` parameter before its parts in the list.
    let pending: AttributeNode[] = [];
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (child.type === 'parameter') {
        parameters.push(this.convertParameter(child));
      } else if (child.type === 'params') {
        // The grammar keeps a `params` parameter's parts directly in the list.
        const typeNode = children[index + 1];
        const nameNode = children[index + 2];
        parameters.push({
          name: nameNode.text,
          type: this.convertType(typeNode),
          modifier: 'params',
          isThis: false,
          defaultValue: undefined,
          ...(pending.length > 0 ? { attributes: pending } : {}),
          ...positionOf(nameNode),
        });
        pending = [];
        index += 2;
      } else if (child.type === 'attribute_list') {
        pending.push(...this.convertAttributeList(child));
      }
    }
    return parameters;
  }

  private convertParameter(node: Node): Parameter {
    const modifiers = namedChildren(node)
      .filter((child) => child.type === 'modifier')
      .map((child) => child.text);
    let modifier: Parameter['modifier'];
    for (const text of modifiers) {
      // `scoped` limits how far a reference may escape, which this grader does not check.
      if (['ref', 'out', 'in', 'params'].includes(text)) modifier = text as Parameter['modifier'];
    }
    // A `ref readonly` parameter is passed by reference and read only, as an `in` parameter is.
    if (modifiers.includes('ref') && modifiers.includes('readonly')) modifier = 'in';
    const typeNode = field(node, 'type');
    // The grammar lets a parameter omit its type for lambdas, whose parameters convertLambda takes instead; Roslyn
    // reads the name of `int Add(int a, b)` as a type still waiting for its name.
    if (!typeNode) throw new CompileError([{ row: node.endPosition.row, message: 'CS1001: 識別子がありません' }]);
    const defaultNode = namedChildren(node).find(
      (child) =>
        !sameNode(child, typeNode) &&
        !sameNode(child, field(node, 'name')) &&
        child.type !== 'modifier' &&
        child.type !== 'attribute_list'
    );
    return {
      name: requiredField(node, 'name').text,
      type: this.convertType(typeNode),
      modifier,
      isThis: modifiers.includes('this'),
      defaultValue: defaultNode ? this.convertExpression(defaultNode) : undefined,
      ...this.attributed(node),
      ...positionOf(node),
    };
  }

  /**
   * An extension block, as the methods of the enclosing static class that C# 14 lowers it to: an instance method
   * takes the receiver as its `this` parameter, a property becomes its accessors, and a static member is the class's,
   * found through the receiver's type, as an operator joins the type's operators. The block's type parameters and
   * constraints go to each member.
   */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private convertExtensionBlock(node: Node, owner: TypeDeclaration): MemberDeclaration[] {
    if (!owner.modifiers.set.has('static') || owner.typeParameters.length > 0)
      throw new CompileError([
        {
          row: node.startPosition.row,
          message: 'CS9283: 拡張機能は、最上位レベルの非ジェネリック静的クラスで宣言する必要があります',
        },
      ]);
    const parts = namedChildren(node);
    const typeParametersNode = parts.find((part) => part.type === 'type_parameter_list');
    const typeParameters = typeParametersNode ? this.convertTypeParameters(typeParametersNode) : [];
    const constraints = parts
      .filter((part) => part.type === 'type_parameter_constraints_clause')
      .map((part) => this.convertConstraintClause(part));
    const receiverNode = parts.find((part) => part.type === 'receiver_parameter') as Node;
    const receiverType = this.convertType(requiredField(receiverNode, 'type'));
    const receiverName = field(receiverNode, 'name')?.text;
    const receiverModifier = namedChildren(receiverNode)
      .filter((child) => child.type === 'modifier')
      .map((child) => child.text)
      .find((text) => text === 'ref' || text === 'in') as Parameter['modifier'];
    const body = parts.find((part) => part.type === 'extension_body') as Node;
    const receiver: Parameter = {
      name: receiverName ?? '',
      type: receiverType,
      modifier: receiverModifier,
      isThis: true,
      defaultValue: undefined,
      ...positionOf(receiverNode),
    };
    const members: MemberDeclaration[] = [];
    for (const memberNode of namedChildren(body)) {
      if (memberNode.type === 'comment') continue;
      for (const member of this.convertMember(memberNode, owner)) {
        if (member.kind === 'operator') {
          if (typeParameters.length > 0) unsupported(memberNode, 'ジェネリックな拡張ブロックの演算子');
          const operand = receiverName ? { ...receiver, isThis: false } : undefined;
          members.push(this.extensionOperator(member, memberNode, receiverType, operand));
          continue;
        }
        for (const method of this.extensionMethods(member, memberNode, receiverType)) {
          const isStatic = method.modifiers.set.has('static');
          if (!isStatic && !receiverName)
            throw new CompileError([
              {
                row: method.row,
                message: `CS9303: '${method.extension?.property ?? method.name}': 名前のないレシーバー パラメーターを持つ拡張ブロックでインスタンス メンバーを宣言することはできません`,
              },
            ]);
          const set = new Set<Modifier>([...method.modifiers.set, 'static']);
          members.push({
            ...method,
            modifiers: { set, positions: method.modifiers.positions },
            typeParameters: [...typeParameters, ...method.typeParameters],
            constraints: [...constraints, ...method.constraints],
            parameters: isStatic ? method.parameters : [receiver, ...method.parameters],
            extension: { ...method.extension, ...(isStatic ? { staticReceiver: receiverType } : {}) },
          });
        }
      }
    }
    return members;
  }

  /**
   * An operator of an extension block: a static one joins the operators of the type that the block extends, and an
   * instance compound assignment or `++`/`--` (C# 14) takes the block's receiver first, which it changes in place.
   */
  private extensionOperator(
    member: OperatorDeclaration,
    node: Node,
    receiverType: TypeNode,
    receiver: Parameter | undefined
  ): OperatorDeclaration {
    const isInstanceAssignment =
      (member.operator.endsWith('=') && !['==', '!=', '<=', '>='].includes(member.operator)) ||
      ((member.operator === '++' || member.operator === '--') && member.parameters.length === 0);
    if (!isInstanceAssignment)
      return { ...member, extension: { staticReceiver: receiverType, receiver: receiverType } };
    if (member.modifiers.set.has('static'))
      throw new CompileError([
        { row: member.row, message: "CS0106: 修飾子 'static' がこの項目に対して有効ではありません" },
      ]);
    if (!receiver)
      throw new CompileError([
        {
          row: member.row,
          message: `CS9303: 'operator ${member.operator}': 名前のないレシーバー パラメーターを持つ拡張ブロックでインスタンス メンバーを宣言することはできません`,
        },
      ]);
    return { ...member, extension: { receiver: receiverType, receiverParameter: receiver } };
  }

  /** A member of an extension block as methods: a method itself, or a property as its accessors. */
  private extensionMethods(member: MemberDeclaration, node: Node, receiverType: TypeNode): MethodDeclaration[] {
    if (member.kind === 'method') return [member];
    if (member.kind !== 'property') unsupported(node, '拡張ブロックのメソッド、プロパティ、演算子以外のメンバー');
    if (!member.isExpressionBodied && member.accessors.every((accessor) => accessor.body === undefined))
      throw new CompileError([{ row: member.row, message: 'CS9282: このメンバーは拡張ブロックでは使用できません' }]);
    if (member.initializer) unsupported(node, '拡張ブロックのプロパティの初期化子');
    return member.accessors.map((accessor): MethodDeclaration => {
      const isGetter = accessor.kind === 'get';
      const value: Parameter = {
        name: 'value',
        type: member.type,
        modifier: undefined,
        isThis: false,
        defaultValue: undefined,
        ...positionOf(node),
      };
      return {
        kind: 'method',
        modifiers: accessorModifiers(member.modifiers, accessor.modifiers),
        returnType: isGetter ? member.type : { kind: 'predefinedType', name: 'void', ...positionOf(node) },
        name: `${isGetter ? 'get' : 'set'}_${member.name}`,
        typeParameters: [],
        constraints: [],
        parameters: isGetter ? [] : [value],
        body: accessor.body,
        bodyRow: accessor.row,
        startRow: member.row,
        attributes: [...(member.attributes ?? []), ...(accessor.attributes ?? [])],
        extension: {
          property: member.name,
          propertyKey: `${member.row}:${member.column}`,
          accessor: accessor.kind,
          receiver: receiverType,
        },
        row: isGetter ? member.row : accessor.row,
        column: member.column,
      };
    });
  }

  private convertModifiers(node: Node): Modifiers {
    const set = new Set<Modifier>();
    const positions = new Map<Modifier, ReturnType<typeof positionOf>>();
    for (const child of namedChildren(node)) {
      if (child.type !== 'modifier') continue;
      const text = child.text;
      const what = UNSUPPORTED_MODIFIERS[text];
      if (what && !(this.isLibrary && text === 'extern')) unsupported(child, what);
      if (!MODIFIERS.has(text) && text !== 'extern') unsupported(child, `\`${text}\``);
      if (set.has(text as Modifier)) {
        throw new CompileError([
          { row: child.startPosition.row, message: `CS1004: 修飾子 '${text}' が重複しています` },
        ]);
      }
      set.add(text as Modifier);
      positions.set(text as Modifier, positionOf(child));
    }
    return { set, positions };
  }

  protected override convertBlockNode(node: Node): Block {
    return {
      kind: 'block',
      statements: namedChildren(node).map((statement) => this.convertStatement(statement)),
      endRow: node.endPosition.row,
      ...positionOf(node),
    };
  }

  // code-gauge-allow functionNcss -- One case per kind of statement node in the grammar.
  convertStatement(node: Node): Statement {
    const position = positionOf(node);
    const parts = namedChildren(node);
    switch (node.type) {
      case 'block': {
        return this.convertBlockNode(node);
      }
      case 'empty_statement': {
        return { kind: 'empty', ...position };
      }
      case 'expression_statement': {
        if (parts.length === 0) return { kind: 'empty', ...position };
        return { kind: 'expression', expression: this.convertExpression(parts[0]), ...position };
      }
      case 'local_declaration_statement': {
        return this.convertLocalDeclaration(node);
      }
      case 'local_function_statement': {
        return {
          kind: 'localFunction',
          declaration: { ...this.convertMethod(node), ...this.attributed(node) },
          ...position,
        };
      }
      case 'if_statement': {
        const alternative = field(node, 'alternative');
        return {
          kind: 'if',
          condition: this.convertExpression(requiredField(node, 'condition')),
          consequence: this.convertEmbedded(requiredField(node, 'consequence')),
          alternative: alternative ? this.convertEmbedded(alternative) : undefined,
          ...position,
        };
      }
      case 'while_statement': {
        return {
          kind: 'while',
          condition: this.convertExpression(requiredField(node, 'condition')),
          body: this.convertEmbedded(requiredField(node, 'body')),
          ...position,
        };
      }
      case 'do_statement': {
        const condition = requiredField(node, 'condition');
        return {
          kind: 'do',
          body: this.convertEmbedded(requiredField(node, 'body')),
          condition: this.convertExpression(condition),
          conditionRow: condition.startPosition.row,
          ...position,
        };
      }
      case 'for_statement': {
        return this.convertFor(node);
      }
      case 'foreach_statement': {
        return this.convertForeach(node);
      }
      case 'switch_statement': {
        return {
          kind: 'switch',
          value: this.convertExpression(requiredField(node, 'value')),
          sections: this.convertSwitchSections(requiredField(node, 'body')),
          ...position,
        };
      }
      case 'break_statement': {
        return { kind: 'break', ...position };
      }
      case 'continue_statement': {
        return { kind: 'continue', ...position };
      }
      case 'return_statement': {
        return { kind: 'return', value: parts[0] ? this.convertExpression(parts[0]) : undefined, ...position };
      }
      case 'throw_statement': {
        return { kind: 'throw', value: parts[0] ? this.convertExpression(parts[0]) : undefined, ...position };
      }
      case 'try_statement': {
        return this.convertTry(node);
      }
      default: {
        return this.convertLessCommonStatement(node);
      }
    }
  }

  /** The statements beyond the ones learners write first: `checked`, `lock`, `goto`, labels, `using`, `yield`, `unsafe`. */
  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  private convertLessCommonStatement(node: Node): Statement {
    const position = positionOf(node);
    const parts = namedChildren(node);
    switch (node.type) {
      case 'checked_statement': {
        return {
          kind: 'checked',
          isChecked: hasToken(node, 'checked'),
          body: this.convertBlockNode(parts[0]),
          ...position,
        };
      }
      case 'lock_statement': {
        return {
          kind: 'lock',
          value: this.convertExpression(parts[0]),
          body: this.convertEmbedded(parts[1]),
          ...position,
        };
      }
      case 'goto_statement': {
        if (hasToken(node, 'case'))
          return { kind: 'goto', target: { kind: 'case', value: this.convertExpression(parts[0]) }, ...position };
        if (hasToken(node, 'default')) return { kind: 'goto', target: { kind: 'default' }, ...position };
        return { kind: 'goto', target: { kind: 'label', name: parts[0].text }, ...position };
      }
      case 'labeled_statement': {
        return { kind: 'labeled', label: parts[0].text, statement: this.convertEmbedded(parts[1]), ...position };
      }
      case 'using_statement': {
        return this.convertUsingStatement(node);
      }
      case 'yield_statement': {
        return { kind: 'yield', value: parts[0] ? this.convertExpression(parts[0]) : undefined, ...position };
      }
      case 'unsafe_statement': {
        return { kind: 'unsafe', body: this.convertBlockNode(parts[0]), ...position };
      }
      case 'fixed_statement': {
        const declaration = parts.find((part) => part.type === 'variable_declaration') as Node;
        const { type, declarators } = this.convertVariableDeclaration(declaration);
        return { kind: 'fixed', type, declarators, body: this.convertStatement(parts.at(-1) as Node), ...position };
      }
      default: {
        const what = UNSUPPORTED_STATEMENTS[node.type];
        if (what) unsupported(node, what);
        throw new CompileError([
          { row: node.startPosition.row, message: `CS1525: '${node.text.split(/\s/)[0]}' は無効です` },
        ]);
      }
    }
  }

  private convertUsingStatement(node: Node): Statement {
    const body = this.convertEmbedded(requiredField(node, 'body'));
    const resourceNode = namedChildren(node).find((child) => !sameNode(child, field(node, 'body'))) as Node;
    const resource =
      resourceNode.type === 'variable_declaration'
        ? { kind: 'declaration' as const, ...this.convertVariableDeclaration(resourceNode) }
        : { kind: 'expression' as const, value: this.convertExpression(resourceNode) };
    return { kind: 'using', resource, body, isAwait: hasToken(node, 'await'), ...positionOf(node) };
  }

  /** Converts the statement that an `if`, a loop, or `else` contains, which cannot be a declaration. */
  private convertEmbedded(node: Node): Statement {
    if (node.type === 'local_declaration_statement') {
      throw new CompileError([
        {
          row: node.startPosition.row,
          message: 'CS1023: 埋め込みステートメントを宣言やラベル付きのステートメントにすることはできません',
        },
      ]);
    }
    return this.convertStatement(node);
  }

  private convertLocalDeclaration(node: Node): Statement {
    const modifiers = namedChildren(node)
      .filter((child) => child.type === 'modifier')
      .map((child) => child.text);
    const using = hasToken(node, 'using') ? (hasToken(node, 'await') ? 'await using' : 'using') : undefined;
    for (const text of modifiers) if (text !== 'const') unsupported(node, `\`${text}\` のローカル変数`);
    const declarationNode = namedChildren(node).find((child) => child.type === 'variable_declaration') as Node;
    const deconstruction = namedChildren(declarationNode).find(
      (child) =>
        child.type === 'variable_declarator' && namedChildren(child).some((part) => part.type === 'tuple_pattern')
    );
    if (deconstruction) {
      const parts = namedChildren(deconstruction);
      const pattern = parts.find((part) => part.type === 'tuple_pattern') as Node;
      const value = parts.find((part) => !sameNode(part, pattern)) as Node;
      const designation = this.convertDesignation(pattern);
      return {
        kind: 'deconstruction',
        designation,
        value: this.convertExpression(value),
        ...positionOf(node),
      };
    }
    const { type, declarators } = this.convertVariableDeclaration(declarationNode);
    if (modifiers.includes('const')) rejectConstantsWithoutValues(declarators);
    return {
      kind: 'localDeclaration',
      isConst: modifiers.includes('const'),
      type,
      declarators,
      ...(using ? { using } : {}),
      ...positionOf(node),
    };
  }

  protected convertVariableDeclaration(node: Node): { type: TypeNode; declarators: VariableDeclarator[] } {
    const type = this.convertType(requiredField(node, 'type'));
    const declarators = namedChildren(node)
      .filter((child) => child.type === 'variable_declarator')
      .map((declarator) => {
        const nameNode = field(declarator, 'name');
        if (!nameNode)
          throw new CompileError([{ row: declarator.startPosition.row, message: 'CS1001: 識別子がありません' }]);
        const parts = namedChildren(declarator).filter((part) => !sameNode(part, nameNode));
        const bracketed = parts.find((part) => part.type === 'bracketed_argument_list');
        if (bracketed) {
          throw new CompileError([
            {
              row: bracketed.startPosition.row,
              message:
                'CS0650: 不適切な配列の宣言子: マネージ配列を宣言するには、次元指定子を変数の識別子の前に指定します。固定サイズ バッファー フィールドを宣言するには、フィールド型の前に fixed キーワードを使用します。',
            },
          ]);
        }
        const valueNode = parts[0];
        let initializer: VariableDeclarator['initializer'];
        if (valueNode)
          initializer =
            valueNode.type === 'initializer_expression'
              ? this.convertArrayInitializer(valueNode)
              : this.convertExpression(valueNode);
        return { name: nameNode.text, initializer, ...positionOf(nameNode) };
      });
    return { type, declarators };
  }

  private convertFor(node: Node): Statement {
    const initializerNodes = fieldChildren(node, 'initializer').filter((child) => child.isNamed);
    let initializer: Extract<Statement, { kind: 'for' }>['initializer'];
    if (initializerNodes.length === 1 && initializerNodes[0].type === 'variable_declaration') {
      initializer = { kind: 'declaration', ...this.convertVariableDeclaration(initializerNodes[0]) };
    } else if (initializerNodes.length > 0) {
      initializer = {
        kind: 'expressions',
        expressions: initializerNodes.map((child) => this.convertExpression(child)),
      };
    }
    const condition = field(node, 'condition');
    return {
      kind: 'for',
      initializer,
      condition: condition ? this.convertExpression(condition) : undefined,
      updates: fieldChildren(node, 'update')
        .filter((child) => child.isNamed)
        .map((child) => this.convertExpression(child)),
      body: this.convertEmbedded(requiredField(node, 'body')),
      ...positionOf(node),
    };
  }

  private convertForeach(node: Node): Statement {
    const typeNode = field(node, 'type');
    const left = requiredField(node, 'left');
    let type: TypeNode;
    let variable;
    if (typeNode) {
      type = this.convertType(typeNode);
      variable = this.convertDesignation(left);
    } else if (left.type === 'declaration_expression') {
      type = this.convertType(requiredField(left, 'type'));
      variable = this.convertDesignation(requiredField(left, 'name'));
    } else {
      // `foreach (var (a, b) in xs)` parses as a call of `var`.
      const expression = this.convertExpression(left);
      if (expression.kind === 'invocation' && expression.target.kind === 'name' && expression.target.name === 'var') {
        type = { kind: 'varType', ...positionOf(left) };
        variable = {
          kind: 'parenthesized' as const,
          elements: expression.args.map((arg) => argumentDesignation(arg)),
          ...positionOf(left),
        };
      } else if (
        expression.kind === 'tuple' &&
        expression.elements.every((element) => element.value.kind === 'declaration')
      ) {
        type = { kind: 'varType', ...positionOf(left) };
        variable = {
          kind: 'parenthesized' as const,
          elements: expression.elements.map((element) => typedDesignation(element.value)),
          ...positionOf(left),
        };
      } else {
        // C# has no foreach over existing variables: a name lacks its type, and a tuple of names declares nothing.
        const message =
          expression.kind === 'tuple'
            ? 'CS8186: foreach ループでは繰り返し変数を宣言する必要があります。'
            : 'CS0230: foreach ステートメントには、型と識別子の両方が必要です';
        throw new CompileError([{ row: left.startPosition.row, message }]);
      }
    }
    return {
      kind: 'foreach',
      type,
      variable,
      collection: this.convertExpression(requiredField(node, 'right')),
      body: this.convertEmbedded(requiredField(node, 'body')),
      ...(hasToken(node, 'await') ? { isAwait: true as const } : {}),
      ...positionOf(node),
    };
  }

  /** The grammar gives every case label its own section, so labels without statements join the next section. */
  private convertSwitchSections(body: Node): SwitchSection[] {
    const sections: SwitchSection[] = [];
    let pendingLabels: SwitchLabel[] = [];
    let pendingPosition: ReturnType<typeof positionOf> | undefined;
    for (const sectionNode of namedChildren(body)) {
      const { labels, statements } = this.convertSwitchSection(sectionNode);
      pendingLabels.push(...labels);
      pendingPosition ??= positionOf(sectionNode);
      if (statements.length === 0) continue;
      sections.push({ labels: pendingLabels, statements, ...pendingPosition });
      pendingLabels = [];
      pendingPosition = undefined;
    }
    if (pendingLabels.length > 0 && pendingPosition)
      sections.push({ labels: pendingLabels, statements: [], ...pendingPosition });
    return sections;
  }

  private convertSwitchSection(node: Node): { labels: SwitchLabel[]; statements: Statement[] } {
    const labels: SwitchLabel[] = [];
    const statements: Statement[] = [];
    const children = childrenOf(node);
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (child.type === 'case') {
        const patternNode = children[index + 1];
        const guardNode = children[index + 2]?.type === 'when_clause' ? children[index + 2] : undefined;
        labels.push({
          kind: 'case',
          pattern: this.convertPattern(patternNode),
          guard: guardNode ? this.convertExpression(namedChildren(guardNode)[0]) : undefined,
          ...positionOf(child),
        });
        index += guardNode ? 2 : 1;
      } else if (child.type === 'default') {
        labels.push({ kind: 'default', ...positionOf(child) });
      } else if (child.isNamed) {
        statements.push(this.convertStatement(child));
      }
    }
    return { labels, statements };
  }

  private convertTry(node: Node): Statement {
    const catches: CatchClause[] = [];
    let finallyBlock: Block | undefined;
    for (const child of namedChildren(node)) {
      if (child.type === 'catch_clause') catches.push(this.convertCatch(child));
      else if (child.type === 'finally_clause') finallyBlock = this.convertBlockNode(namedChildren(child)[0]);
    }
    if (catches.length === 0 && !finallyBlock) {
      // The grammar takes a `try` block alone, which Roslyn rejects as a syntax error.
      throw new CompileError([
        { row: requiredField(node, 'body').endPosition.row, message: 'CS1524: catch または finally が必要です' },
      ]);
    }
    return {
      kind: 'try',
      body: this.convertBlockNode(requiredField(node, 'body')),
      catches,
      finally: finallyBlock,
      ...positionOf(node),
    };
  }

  private convertCatch(node: Node): CatchClause {
    const declaration = namedChildren(node).find((child) => child.type === 'catch_declaration');
    const filter = namedChildren(node).find((child) => child.type === 'catch_filter_clause');
    const nameNode = declaration ? field(declaration, 'name') : undefined;
    return {
      type: declaration ? this.convertType(requiredField(declaration, 'type')) : undefined,
      name: nameNode?.text,
      filter: filter ? this.convertExpression(namedChildren(filter)[0]) : undefined,
      body: this.convertBlockNode(requiredField(node, 'body')),
      ...positionOf(node),
    };
  }
}

function emptyModifiers(): Modifiers {
  return { set: new Set(), positions: new Map() };
}

function qualifiedNameParts(node: Node): string[] {
  if (node.type === 'identifier') return [node.text];
  if (node.type === 'qualified_name') {
    return [
      ...qualifiedNameParts(requiredField(node, 'qualifier')),
      ...qualifiedNameParts(requiredField(node, 'name')),
    ];
  }
  if (node.type === 'alias_qualified_name')
    throw new CompileError([{ row: node.startPosition.row, message: 'CS7000: エイリアス名の予期しない使用方法です' }]);
  return unsupported(node, 'この名前');
}

function argumentDesignation(arg: Argument): Designation {
  const value = arg.value;
  if (value.kind === 'name' && value.name === '_') return { kind: 'discard', row: value.row, column: value.column };
  if (value.kind === 'name') return { kind: 'single', name: value.name, row: value.row, column: value.column };
  if (value.kind === 'tuple')
    return {
      kind: 'parenthesized',
      elements: value.elements.map((element) => argumentDesignation(element)),
      row: value.row,
      column: value.column,
    };
  throw new CompileError([{ row: arg.row, message: 'CS1001: 識別子がありません' }]);
}

/** The variable of a typed element of a deconstruction, which keeps its type unless it is `var`. */
function typedDesignation(declaration: Expression): Designation {
  const { type, designation } = declaration as Extract<Expression, { kind: 'declaration' }>;
  if (designation.kind !== 'single' || type.kind === 'varType') return designation;
  return { ...designation, type };
}

/** A constant without a value, which Roslyn's parser rejects before anything else is checked. */
function rejectConstantsWithoutValues(declarators: VariableDeclarator[]): void {
  const missing = declarators.find((declarator) => !declarator.initializer);
  if (missing)
    throw new CompileError([{ row: missing.row, message: 'CS0145: const フィールドに値を指定する必要があります' }]);
}

const ACCESS_MODIFIERS: ReadonlySet<Modifier> = new Set(['public', 'private', 'protected', 'internal']);

/** The modifiers of a property's accessor: the property's, with the accessor's own accessibility if it has one. */
function accessorModifiers(property: Modifiers, accessor: Modifiers): Modifiers {
  const own = [...accessor.set].filter((modifier) => ACCESS_MODIFIERS.has(modifier));
  if (own.length === 0) return property;
  const set = new Set([...property.set].filter((modifier) => !ACCESS_MODIFIERS.has(modifier)));
  for (const modifier of own) set.add(modifier);
  return { set, positions: new Map([...property.positions, ...accessor.positions]) };
}
