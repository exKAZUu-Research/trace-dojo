// code-gauge-allow-file fileNcss 545 -- Keep declaration syntax and parameter validation together.
import type { Node } from '@willbooster/web-tree-sitter';

import type {
  Annotation,
  Block,
  CatchClause,
  ClassDeclaration,
  ClassKind,
  ConstructorDeclaration,
  ConstructorInitializer,
  EnumConstant,
  Expression,
  ExtensionDeclaration,
  FieldDeclaration,
  FormalParameter,
  FormalParameters,
  FunctionBody,
  FunctionDeclaration,
  ImportDirective,
  Library,
  MemberDeclaration,
  MethodDeclaration,
  PrimaryConstructor,
  Statement,
  SwitchCase,
  TopLevelDeclaration,
  TypeAliasDeclaration,
  TypeParameter,
  TypeSyntax,
  VariableDeclaration,
  VariableDeclarator,
} from './ast';
import {
  childrenOf,
  fieldOf,
  fieldsOf,
  hasToken,
  namedOf,
  requireNode,
  spanOf,
  syntaxChildrenOf,
  syntaxError,
  unsupported,
} from './convertBase';
import { ExpressionConverter, VAR_WITH_TYPE } from './convertExpression';

/** Converts a tree-sitter tree of a Dart library into the AST, rejecting syntax the interpreter does not run. */
export class Converter extends ExpressionConverter {
  constructor(protected readonly isLibrary: boolean) {
    super();
  }

  // code-gauge-allow functionNcss 33 -- One case per kind of top-level node, which reads best as one dispatch.
  convertLibrary(root: Node): Library {
    const imports: ImportDirective[] = [];
    const declarations: TopLevelDeclaration[] = [];
    let pendingAnnotations: Annotation[] = [];
    for (const node of namedOf(root)) {
      switch (node.type) {
        case 'import_or_export': {
          imports.push(...this.convertImportOrExport(node));
          break;
        }
        case 'library_name': {
          // `library;` or `library name;` only names the library; dotted names are a legacy form.
          if (namedOf(node).some((child) => child.type === 'dotted_identifier_list' && child.text.includes('.'))) {
            return unsupported(node, '. で区切った名前のライブラリ（library a.b;）');
          }
          break;
        }
        case 'part_directive':
        case 'part_of_directive': {
          return unsupported(node, 'part（別のファイルの読み込み）');
        }
        case 'script_tag': {
          return unsupported(node, '#! で始まる行（スクリプトの指定）');
        }
        case 'annotation': {
          pendingAnnotations.push(this.convertAnnotation(node));
          break;
        }
        case 'external_variable_declaration': {
          declarations.push(...this.convertExternalVariables(node));
          pendingAnnotations = [];
          break;
        }
        default: {
          const declaration = this.convertTopLevel(node);
          if (declaration) {
            if ('annotations' in declaration) declaration.annotations.push(...pendingAnnotations);
            declarations.push(declaration);
          }
          pendingAnnotations = [];
        }
      }
    }
    return { imports, declarations, ...spanOf(root) };
  }

  private convertImportOrExport(node: Node): ImportDirective[] {
    const inner = requireNode(namedOf(node)[0], node);
    if (inner.type === 'library_export') return unsupported(inner, 'export（ライブラリの再公開）');
    const specification = requireNode(
      namedOf(inner).find((child) => child.type === 'import_specification'),
      inner
    );
    const uriNode = requireNode(fieldOf(specification, 'uri'), specification);
    if (uriNode.type === 'configurable_uri' && namedOf(uriNode).some((child) => child.type === 'configuration_uri')) {
      return unsupported(uriNode, '条件付きの import');
    }
    if (hasToken(specification, 'deferred'))
      return unsupported(specification, 'deferred as（ライブラリの遅延読み込み）');
    const uri = this.uriText(uriNode);
    if (!uri.startsWith('dart:')) return unsupported(uriNode, `import '${uri}'（標準ライブラリ以外の読み込み）`);
    let show: string[] | undefined;
    const hide: string[] = [];
    for (const combinator of namedOf(specification).filter((child) => child.type === 'combinator')) {
      const names = namedOf(combinator).map((child) => child.text);
      if (hasToken(combinator, 'show')) show = show?.filter((name) => names.includes(name)) ?? names;
      else hide.push(...names);
    }
    return [{ uri, prefix: fieldOf(specification, 'alias')?.text, show, hide, ...spanOf(node) }];
  }

  private uriText(node: Node): string {
    const uri =
      node.type === 'uri'
        ? node
        : requireNode(
            namedOf(node).find((child) => child.type === 'uri'),
            node
          );
    const literal = this.convertExpression(requireNode(namedOf(uri)[0], uri));
    if (literal.kind !== 'string' || literal.parts.some((part) => typeof part !== 'string')) {
      return syntaxError(node, 'import の URI には、式の入らない文字列を書いてください。');
    }
    return (literal.parts as string[]).join('');
  }

  private convertTopLevel(node: Node): TopLevelDeclaration | undefined {
    switch (node.type) {
      case 'class_declaration': {
        return this.convertClass(node);
      }
      case 'mixin_declaration': {
        return this.convertMixin(node);
      }
      case 'enum_declaration': {
        return this.convertEnum(node);
      }
      case 'extension_declaration': {
        return this.convertExtension(node);
      }
      case 'extension_type_declaration': {
        return this.convertExtensionType(node);
      }
      case 'type_alias': {
        return this.convertTypeAlias(node);
      }
      case 'function_declaration': {
        return this.convertFunctionDeclaration(node);
      }
      case 'getter_declaration':
      case 'setter_declaration': {
        return this.convertTopLevelAccessor(node);
      }
      case 'top_level_variable_declaration': {
        return this.convertTopLevelVariables(node);
      }
      case 'external_function_declaration':
      case 'external_getter_declaration':
      case 'external_setter_declaration': {
        return this.convertExternalTopLevel(node);
      }
      default: {
        return syntaxError(node, '書き方に誤りがあります。');
      }
    }
  }

  convertAnnotation(node: Node): Annotation {
    const target = requireNode(fieldOf(node, 'name'), node);
    const names = target.type === 'qualified' ? namedOf(target).map((part) => part.text) : [target.text];
    const children = namedOf(node);
    const selector = children.find((child) => child.type === 'identifier' && child.id !== target.id);
    if (selector) names.push(selector.text);
    const types = children.find((child) => child.type === 'type_arguments');
    const args = children.find((child) => child.type === 'arguments' || child.type === 'annotation_arguments');
    return {
      names,
      typeArguments: types ? this.convertTypeArguments(types) : [],
      arguments: args ? this.convertArguments(args) : undefined,
      ...spanOf(node),
    };
  }

  private annotationsOf(node: Node): Annotation[] {
    return namedOf(node)
      .filter((child) => child.type === 'annotation')
      .map((child) => this.convertAnnotation(child));
  }

  // Classes

  // code-gauge-allow duplicateLines 19 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  private convertClass(node: Node): ClassDeclaration {
    const tokens = new Set(
      childrenOf(node)
        .filter((child) => !child.isNamed)
        .map((child) => child.type)
    );
    if (namedOf(node).some((child) => child.type === 'mixin_application_class')) {
      return unsupported(node, 'class C = A with M; の形のクラス宣言（mixin application）');
    }
    const superclassNode = fieldOf(node, 'superclass');
    const superType = superclassNode ? fieldOf(superclassNode, 'type') : undefined;
    const mixinsNode = superclassNode ? namedOf(superclassNode).find((child) => child.type === 'mixins') : undefined;
    const classKind: ClassKind = tokens.has('mixin') ? 'mixinClass' : 'class';
    const bodyNode = fieldOf(node, 'body');
    const primary = namedOf(node).find((child) => child.type === 'primary_constructor');
    return {
      kind: 'class',
      classKind,
      name: requireNode(fieldOf(node, 'name'), node).text,
      typeParameters: this.convertTypeParameters(fieldOf(node, 'type_parameters')),
      modifiers: {
        isAbstract: tokens.has('abstract'),
        isSealed: tokens.has('sealed'),
        isBase: tokens.has('base'),
        isFinal: tokens.has('final'),
        isInterface: tokens.has('interface'),
      },
      superclass: superType ? this.convertType(superType) : undefined,
      mixins: mixinsNode ? this.typesOf(mixinsNode) : [],
      interfaces: this.interfacesOf(fieldOf(node, 'interfaces')),
      onTypes: [],
      members: bodyNode ? this.convertMembers(bodyNode) : [],
      enumConstants: [],
      primaryConstructor: primary ? this.convertPrimaryConstructor(primary, tokens.has('const')) : undefined,
      annotations: this.annotationsOf(node),
      isLibrary: this.isLibrary,
      ...spanOf(node),
    };
  }

  // code-gauge-allow duplicateLines 22 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  private convertMixin(node: Node): ClassDeclaration {
    const children = childrenOf(node);
    const onIndex = children.findIndex((child) => child.type === 'on');
    const onTypes: TypeSyntax[] = [];
    if (onIndex !== -1) {
      for (const child of children.slice(onIndex + 1)) {
        if (child.type === 'type') onTypes.push(this.convertType(child));
        else if (child.type !== ',' && child.type !== 'comment') break;
      }
    }
    const bodyNode = fieldOf(node, 'body');
    return {
      kind: 'class',
      classKind: 'mixin',
      name: requireNode(fieldOf(node, 'name'), node).text,
      typeParameters: this.convertTypeParameters(fieldOf(node, 'type_parameters')),
      modifiers: {
        isAbstract: true,
        isSealed: false,
        isBase: hasToken(node, 'base'),
        isFinal: false,
        isInterface: false,
      },
      superclass: undefined,
      mixins: [],
      interfaces: this.interfacesOf(fieldOf(node, 'interfaces')),
      onTypes,
      members: bodyNode ? this.convertMembers(bodyNode) : [],
      enumConstants: [],
      primaryConstructor: undefined,
      annotations: this.annotationsOf(node),
      isLibrary: this.isLibrary,
      ...spanOf(node),
    };
  }

  // code-gauge-allow duplicateLines 17 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  private convertEnum(node: Node): ClassDeclaration {
    const named = namedOf(node);
    const typeParameters = named.find((child) => child.type === 'type_parameters');
    const mixinsNode = named.find((child) => child.type === 'mixins');
    const interfacesNode = named.find((child) => child.type === 'interfaces');
    const bodyNode = fieldOf(node, 'body');
    const primary = named.find((child) => child.type === 'primary_constructor');
    const constants: EnumConstant[] = [];
    const members: MemberDeclaration[] = [];
    if (bodyNode) {
      for (const child of namedOf(bodyNode)) {
        if (child.type === 'enum_constant') constants.push(this.convertEnumConstant(child));
        else if (child.type === 'class_member') members.push(...this.convertMember(child));
      }
    }
    return {
      kind: 'class',
      classKind: 'enum',
      name: requireNode(fieldOf(node, 'name'), node).text,
      typeParameters: this.convertTypeParameters(typeParameters),
      modifiers: { isAbstract: false, isSealed: false, isBase: false, isFinal: false, isInterface: false },
      superclass: undefined,
      mixins: mixinsNode ? this.typesOf(mixinsNode) : [],
      interfaces: this.interfacesOf(interfacesNode),
      onTypes: [],
      members,
      enumConstants: constants,
      primaryConstructor: primary ? this.convertPrimaryConstructor(primary, true) : undefined,
      annotations: this.annotationsOf(node),
      isLibrary: this.isLibrary,
      ...spanOf(node),
    };
  }

  private convertEnumConstant(node: Node): EnumConstant {
    const children = childrenOf(node);
    const dot = children.findIndex((child) => child.type === '.');
    const typeArguments = namedOf(node).find((child) => child.type === 'type_arguments');
    const args = namedOf(node).find((child) => child.type === 'arguments');
    return {
      annotations: this.annotationsOf(node),
      name: requireNode(fieldOf(node, 'name'), node).text,
      typeArguments: typeArguments ? this.convertTypeArguments(typeArguments) : undefined,
      constructorName: dot !== -1 ? children[dot + 1]?.text : undefined,
      arguments: args ? this.convertArguments(args) : undefined,
      ...spanOf(node),
    };
  }

  private convertExtension(node: Node): ExtensionDeclaration {
    const bodyNode = fieldOf(node, 'body');
    return {
      kind: 'extension',
      name: fieldOf(node, 'name')?.text,
      typeParameters: this.convertTypeParameters(fieldOf(node, 'type_parameters')),
      onType: this.convertType(requireNode(fieldOf(node, 'class'), node)),
      members: bodyNode ? this.convertMembers(bodyNode) : [],
      annotations: this.annotationsOf(node),
      ...spanOf(node),
    };
  }

  // code-gauge-allow duplicateLines 20 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  private convertExtensionType(node: Node): ClassDeclaration {
    const primary = requireNode(
      namedOf(node).find((child) => child.type === 'primary_constructor'),
      node
    );
    const bodyNode = fieldOf(node, 'body');
    return {
      kind: 'class',
      classKind: 'extensionType',
      name: requireNode(fieldOf(node, 'name'), node).text,
      typeParameters: this.convertTypeParameters(fieldOf(node, 'type_parameters')),
      modifiers: { isAbstract: false, isSealed: false, isBase: false, isFinal: false, isInterface: false },
      superclass: undefined,
      mixins: [],
      interfaces: this.interfacesOf(fieldOf(node, 'interfaces')),
      onTypes: [],
      members: bodyNode ? this.convertMembers(bodyNode) : [],
      enumConstants: [],
      primaryConstructor: this.convertPrimaryConstructor(primary, hasToken(node, 'const'), false),
      annotations: this.annotationsOf(node),
      isLibrary: this.isLibrary,
      ...spanOf(node),
    };
  }

  private convertPrimaryConstructor(node: Node, isConst: boolean, allowInitializingFormals = true): PrimaryConstructor {
    return {
      name: fieldOf(node, 'name')?.text,
      isConst: isConst || hasToken(node, 'const'),
      parameters: this.convertFormalParameters(
        requireNode(fieldOf(node, 'parameters'), node),
        allowInitializingFormals
      ),
      ...spanOf(node),
    };
  }

  private convertTypeAlias(node: Node): TypeAliasDeclaration {
    if (!hasToken(node, '=')) return unsupported(node, '古い形の typedef（typedef int F(int x);）');
    const named = namedOf(node);
    const nameNode = requireNode(
      named.find((child) => child.type === 'type_identifier'),
      node
    );
    const aliased = requireNode(
      named.find((child) => child.type === 'type'),
      node
    );
    return {
      kind: 'typeAlias',
      name: nameNode.text,
      typeParameters: this.convertTypeParameters(named.find((child) => child.type === 'type_parameters')),
      aliased: this.convertType(aliased),
      annotations: this.annotationsOf(node),
      ...spanOf(node),
    };
  }

  private typesOf(node: Node): TypeSyntax[] {
    return namedOf(node)
      .filter((child) => child.type === 'type')
      .map((child) => this.convertType(child));
  }

  private interfacesOf(node: Node | undefined): TypeSyntax[] {
    return node ? this.typesOf(node) : [];
  }

  convertTypeParameters(node: Node | undefined): TypeParameter[] {
    if (!node) return [];
    return namedOf(node)
      .filter((child) => child.type === 'type_parameter')
      .map((child) => {
        if (fieldOf(child, 'variance')) {
          return syntaxError(child, '型引数の in・out・inout は、実験中の機能（variance）なので使えません。');
        }
        const bound = fieldOf(child, 'bound');
        return {
          annotations: this.annotationsOf(child),
          name: requireNode(fieldOf(child, 'name'), child).text,
          bound: bound ? this.convertType(bound) : undefined,
          ...spanOf(child),
        };
      });
  }

  private convertMembers(body: Node): MemberDeclaration[] {
    const owner = body.parent ? fieldOf(body.parent, 'name')?.text : undefined;
    return namedOf(body)
      .filter((child) => child.type === 'class_member')
      .flatMap((child) => this.convertMember(child))
      .map((member) => asUntypedMethod(member, owner) ?? member);
  }

  private convertMember(node: Node): MemberDeclaration[] {
    const annotations = this.annotationsOf(node);
    const inner = requireNode(
      namedOf(node).find((child) => child.type === 'declaration' || child.type === 'method_declaration'),
      node
    );
    if (inner.type === 'method_declaration') {
      const signatureNode = requireNode(fieldOf(inner, 'signature'), inner);
      const body = this.convertFunctionBody(requireNode(fieldOf(inner, 'body'), inner));
      return [
        this.convertSignature(inner, childrenOf(signatureNode), body, [...annotations, ...this.annotationsOf(inner)]),
      ];
    }
    const children = childrenOf(inner);
    const tokens = new Set(children.filter((child) => !child.isNamed).map((child) => child.type));
    const isExternal = children.some((child) => child.type === 'external');
    const signature = children.find((child) =>
      [
        'constructor_signature',
        'constant_constructor_signature',
        'factory_constructor_signature',
        'redirecting_factory_constructor_signature',
        'function_signature',
        'getter_signature',
        'setter_signature',
        'operator_signature',
        'primary_constructor_body_signature',
      ].includes(child.type)
    );
    if (signature) return [this.convertSignature(inner, children, undefined, annotations)];
    // Fields.
    const typeNode = children.find((child) => child.type === 'type');
    if (typeNode && children.some((child) => child.type === 'var')) return syntaxError(inner, VAR_WITH_TYPE);
    const list = children.find((child) =>
      ['initialized_identifier_list', 'static_final_declaration_list', 'identifier_list'].includes(child.type)
    );
    if (!list) return syntaxError(inner, '書き方に誤りがあります。');
    const variables: VariableDeclarator[] = namedOf(list).map((child) => {
      if (child.type === 'identifier') return { name: child.text, initializer: undefined, ...spanOf(child) };
      const value = fieldsOf(child, 'value');
      return {
        name: requireNode(fieldOf(child, 'name'), child).text,
        initializer: value.length > 0 ? this.fieldExpression(child, 'value') : undefined,
        ...spanOf(child),
      };
    });
    const field: FieldDeclaration = {
      kind: 'field',
      isStatic: tokens.has('static'),
      isFinal: tokens.has('final'),
      isConst: tokens.has('const'),
      isLate: tokens.has('late'),
      isCovariant: tokens.has('covariant'),
      isExternal,
      isAbstract: tokens.has('abstract'),
      type: typeNode ? this.convertType(typeNode) : undefined,
      variables,
      annotations,
      ...spanOf(inner),
    };
    return [field];
  }

  /**
   * A method, accessor, operator, or constructor, from the nodes of its signature: modifier tokens, the signature,
   * and a constructor's initializers or redirection.
   */
  // code-gauge-allow functionCognitiveComplexity 23 -- One case per kind of signature.
  private convertSignature(
    declaration: Node,
    parts: Node[],
    body: FunctionBody | undefined,
    annotations: Annotation[]
  ): MemberDeclaration {
    const tokens = new Set(parts.filter((child) => !child.isNamed).map((child) => child.type));
    const isExternal = parts.some((child) => child.type === 'external');
    const signature = requireNode(
      parts.find((child) => child.isNamed && child.type.endsWith('signature')),
      declaration
    );
    // A member's position is its signature's, after any annotations, which is where Dart reports its errors.
    const span = { ...spanOf(declaration), row: signature.startPosition.row };
    const headerEndRow = body ? body.row : declaration.endPosition.row;
    const initializersNode = parts.find((child) => child.type === 'initializers');
    const redirection = parts.find((child) => child.type === 'redirection');
    switch (signature.type) {
      case 'constructor_signature':
      case 'constant_constructor_signature':
      case 'factory_constructor_signature':
      case 'redirecting_factory_constructor_signature': {
        const nameParts = fieldsOf(signature, 'name');
        const name = nameParts.length >= 3 ? nameParts[2].text : undefined;
        const initializers = initializersNode ? this.convertInitializers(initializersNode) : [];
        if (redirection) initializers.push(this.convertRedirection(redirection));
        const isRedirectingFactory = signature.type === 'redirecting_factory_constructor_signature';
        const isFactory = signature.type === 'factory_constructor_signature';
        const target = isRedirectingFactory ? requireNode(fieldOf(signature, 'target'), signature) : undefined;
        const constructor: ConstructorDeclaration = {
          kind: 'constructor',
          constructorKind: isRedirectingFactory ? 'redirectingFactory' : isFactory ? 'factory' : 'generative',
          name,
          isConst:
            signature.type === 'constant_constructor_signature' || tokens.has('const') || hasToken(signature, 'const'),
          isExternal,
          parameters: this.convertFormalParameters(
            requireNode(fieldOf(signature, 'parameters'), signature),
            !isFactory && !isRedirectingFactory && !redirection
          ),
          initializers,
          body,
          redirectTarget: target
            ? { type: this.convertType(target), name: fieldOf(signature, 'target_constructor')?.text }
            : undefined,
          annotations,
          headerEndRow,
          className: nameParts[0]?.text,
          ...span,
        };
        return constructor;
      }
      case 'primary_constructor_body_signature': {
        return {
          kind: 'constructor',
          constructorKind: 'generative',
          className: undefined,
          name: '\0primaryBody',
          isConst: false,
          isExternal,
          parameters: emptyParameters(span),
          initializers: initializersNode ? this.convertInitializers(initializersNode) : [],
          body,
          redirectTarget: undefined,
          annotations,
          headerEndRow,
          ...span,
        };
      }
      default: {
        return this.convertMethodSignature(signature, tokens, isExternal, body, annotations, headerEndRow, span);
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- One case per kind of node in the grammar.
  // code-gauge-allow functionParameterCount 7 -- The parameters are the parts a caller already holds; grouping them would only rename them.
  private convertMethodSignature(
    signature: Node,
    tokens: Set<string>,
    isExternal: boolean,
    body: FunctionBody | undefined,
    annotations: Annotation[],
    headerEndRow: number,
    span: ReturnType<typeof spanOf>
  ): MethodDeclaration {
    const returnTypeNode = fieldOf(signature, 'return_type');
    const parameterNodes = fieldsOf(signature, 'parameters');
    const formal = parameterNodes.find((child) => child.type === 'formal_parameter_list');
    const methodKind =
      signature.type === 'getter_signature'
        ? 'getter'
        : signature.type === 'setter_signature'
          ? 'setter'
          : signature.type === 'operator_signature'
            ? 'operator'
            : 'method';
    let name: string;
    if (signature.type === 'operator_signature') {
      const operator = requireNode(fieldOf(signature, 'operator'), signature);
      name = operator.type === 'binary_operator' ? operator.text : operator.type;
      if (name === '-' && formal && namedOf(formal).length === 0) name = 'unary-';
    } else {
      name = requireNode(fieldOf(signature, 'name'), signature).text;
    }
    return {
      kind: 'method',
      methodKind,
      name,
      isStatic: tokens.has('static') || hasToken(signature, 'static'),
      isExternal,
      typeParameters: this.convertTypeParameters(parameterNodes.find((child) => child.type === 'type_parameters')),
      returnType: returnTypeNode ? this.convertType(returnTypeNode) : undefined,
      parameters: formal ? this.convertFormalParameters(formal) : emptyParameters(span),
      body,
      annotations,
      headerEndRow,
      ...span,
    };
  }

  private convertInitializers(node: Node): ConstructorInitializer[] {
    return namedOf(node)
      .filter((child) => child.type === 'initializer_list_entry')
      .map((entry) => {
        const span = spanOf(entry);
        const [first] = namedOf(entry);
        if (first?.type === 'field_initializer') {
          return {
            kind: 'field',
            name: requireNode(fieldOf(first, 'name'), first).text,
            value: this.fieldExpression(first, 'value'),
            ...span,
          };
        }
        if (first?.type === 'assertion') {
          const [condition, message] = this.assertionParts(first);
          return { kind: 'assert', condition, message, ...span };
        }
        const isSuper = hasToken(entry, 'super');
        const name = namedOf(entry).find((child) => child.type === 'identifier')?.text;
        const args = requireNode(
          namedOf(entry).find((child) => child.type === 'arguments'),
          entry
        );
        return { kind: isSuper ? 'super' : 'this', name, arguments: this.convertArguments(args), ...span };
      });
  }

  private convertRedirection(node: Node): ConstructorInitializer {
    const name = namedOf(node).find((child) => child.type === 'identifier')?.text;
    const args = requireNode(
      namedOf(node).find((child) => child.type === 'arguments'),
      node
    );
    return { kind: 'this', name, arguments: this.convertArguments(args), ...spanOf(node) };
  }

  private assertionParts(node: Node): [Expression, Expression | undefined] {
    const expressions = this.expressionChildren(childrenOf(node)).map((child) => child.expression);
    if (expressions.length === 0 || expressions.length > 2) return syntaxError(node, '書き方に誤りがあります。');
    return [expressions[0], expressions[1]];
  }

  // Functions

  private convertFunctionDeclaration(node: Node): FunctionDeclaration {
    const signature = requireNode(fieldOf(node, 'signature'), node);
    const body = this.convertFunctionBody(requireNode(fieldOf(node, 'body'), node));
    return this.functionFromSignature(signature, body, 'function', this.annotationsOf(node), spanOf(node), false);
  }

  private functionFromSignature(
    signature: Node,
    body: FunctionBody | undefined,
    functionKind: FunctionDeclaration['functionKind'],
    annotations: Annotation[],
    span: ReturnType<typeof spanOf>,
    isExternal: boolean
  ): FunctionDeclaration {
    const parameterNodes = fieldsOf(signature, 'parameters');
    const formal = parameterNodes.find((child) => child.type === 'formal_parameter_list');
    const returnType = fieldOf(signature, 'return_type');
    return {
      kind: 'function',
      name: requireNode(fieldOf(signature, 'name'), signature).text,
      functionKind,
      isExternal,
      typeParameters: this.convertTypeParameters(parameterNodes.find((child) => child.type === 'type_parameters')),
      returnType: returnType ? this.convertType(returnType) : undefined,
      parameters: formal ? this.convertFormalParameters(formal) : emptyParameters(span),
      body,
      annotations,
      headerEndRow: body ? body.row : span.row,
      ...span,
    };
  }

  private convertTopLevelAccessor(node: Node): FunctionDeclaration {
    const signature = requireNode(fieldOf(node, 'signature'), node);
    const body = this.convertFunctionBody(requireNode(fieldOf(node, 'body'), node));
    const kind = node.type === 'getter_declaration' ? 'getter' : 'setter';
    return this.functionFromSignature(signature, body, kind, this.annotationsOf(node), spanOf(node), false);
  }

  private convertExternalTopLevel(node: Node): TopLevelDeclaration {
    const signature = requireNode(fieldOf(node, 'signature'), node);
    const kind =
      node.type === 'external_getter_declaration'
        ? 'getter'
        : node.type === 'external_setter_declaration'
          ? 'setter'
          : 'function';
    return this.functionFromSignature(signature, undefined, kind, this.annotationsOf(node), spanOf(node), true);
  }

  /** `external int v;`, which declares a getter and, unless final, a setter. */
  private convertExternalVariables(node: Node): FunctionDeclaration[] {
    const span = spanOf(node);
    const typeNode = namedOf(node).find((child) => child.type === 'type');
    const type = typeNode ? this.convertType(typeNode) : undefined;
    const isFinal = childrenOf(node).some((child) => child.type === 'final');
    const names = namedOf(
      requireNode(
        namedOf(node).find((child) => child.type === 'identifier_list'),
        node
      )
    );
    return names.flatMap((identifier) => {
      const base = {
        kind: 'function' as const,
        name: identifier.text,
        isExternal: true,
        typeParameters: [],
        body: undefined,
        annotations: [],
        headerEndRow: span.row,
        ...span,
      };
      const getter: FunctionDeclaration = {
        ...base,
        functionKind: 'getter',
        returnType: type,
        parameters: emptyParameters(span),
      };
      if (isFinal) return [getter];
      const parameter: FormalParameter = {
        name: 'value',
        type,
        binding: 'plain',
        isFinal: false,
        isCovariant: false,
        isRequired: true,
        defaultValue: undefined,
        functionType: undefined,
        ...span,
      };
      const setter: FunctionDeclaration = {
        ...base,
        functionKind: 'setter',
        returnType: undefined,
        parameters: { positional: [parameter], requiredCount: 1, named: [], ...span },
      };
      return [getter, setter];
    });
  }

  private convertTopLevelVariables(node: Node): VariableDeclaration {
    const modifier = fieldOf(node, 'modifier')?.type;
    const children = childrenOf(node);
    const tokens = new Set(children.filter((child) => !child.isNamed).map((child) => child.type));
    const typeNode = children.find((child) => child.type === 'type');
    if (typeNode && tokens.has('var')) return syntaxError(node, VAR_WITH_TYPE);
    const list = requireNode(
      children.find(
        (child) => child.type === 'initialized_identifier_list' || child.type === 'static_final_declaration_list'
      ),
      node
    );
    return {
      kind: 'variables',
      isFinal: modifier === 'final' || tokens.has('final'),
      isConst: modifier === 'const' || tokens.has('const'),
      isLate: modifier === 'late' || tokens.has('late'),
      type: typeNode ? this.convertType(typeNode) : undefined,
      variables: namedOf(list).map((child) => {
        const value = fieldsOf(child, 'value');
        return {
          name: requireNode(fieldOf(child, 'name'), child).text,
          initializer: value.length > 0 ? this.fieldExpression(child, 'value') : undefined,
          ...spanOf(child),
        };
      }),
      annotations: this.annotationsOf(node),
      ...spanOf(node),
    };
  }

  convertFunctionBody(node: Node): FunctionBody {
    const span = spanOf(node);
    if (namedOf(node).some((child) => child.type === 'native')) {
      return unsupported(node, 'native（処理系の外で定義する本体）');
    }
    const tokens = new Set(
      childrenOf(node)
        .filter((child) => !child.isNamed)
        .map((child) => child.type)
    );
    let modifier: FunctionBody['modifier'] = 'sync';
    if (tokens.has('async')) modifier = tokens.has('*') ? 'async*' : 'async';
    else if (tokens.has('async*')) modifier = 'async*';
    else if (tokens.has('sync*') || tokens.has('sync')) modifier = 'sync*';
    if (modifier === 'async' || modifier === 'async*') return unsupported(node, `${modifier}（非同期処理）`);
    const block = namedOf(node).find((child) => child.type === 'block');
    if (block) return { kind: 'block', block: this.convertBlock(block), modifier, ...span };
    const children = childrenOf(node);
    const arrow = children.findIndex((child) => child.type === '=>');
    if (arrow === -1) return syntaxError(node, '書き方に誤りがあります。');
    const rest = children.slice(arrow + 1).filter((child) => child.type !== ';');
    return { kind: 'expression', expression: this.soleExpression(node, rest), modifier, ...span };
  }

  convertFormalParameters(node: Node, allowInitializingFormals = false): FormalParameters {
    const positional: FormalParameter[] = [];
    const named: FormalParameter[] = [];
    let requiredCount = 0;
    for (const child of namedOf(node)) {
      if (child.type === 'formal_parameter') {
        positional.push(this.convertFormalParameter(child, false, undefined));
        requiredCount++;
      } else if (child.type === 'optional_formal_parameters') {
        const isNamed = !hasToken(child, '[');
        (isNamed ? named : positional).push(...this.convertOptionalParameters(child, isNamed));
      }
    }
    if (!allowInitializingFormals) requirePlainParameters(positional, named);
    return { positional, requiredCount, named, ...spanOf(node) };
  }

  /** The parameters inside `[...]` or `{...}`, with their default values and `required`. */
  private convertOptionalParameters(node: Node, isNamed: boolean): FormalParameter[] {
    const parameters: FormalParameter[] = [];
    let isRequired = false;
    const parts = syntaxChildrenOf(node);
    for (const [index, part] of parts.entries()) {
      if (part.type === 'required') isRequired = true;
      if (part.type !== 'formal_parameter') continue;
      const next = parts[index + 1];
      let defaultValue: Expression | undefined;
      if (next && (next.type === '=' || next.type === ':')) {
        let end = index + 2;
        while (end < parts.length && ![',', ']', '}', 'formal_parameter'].includes(parts[end].type)) end++;
        defaultValue = this.soleExpression(node, parts.slice(index + 2, end));
      }
      parameters.push(this.convertFormalParameter(part, isNamed && isRequired, defaultValue));
      isRequired = false;
    }
    return parameters;
  }

  private convertFormalParameter(
    node: Node,
    isRequired: boolean,
    defaultValue: Expression | undefined
  ): FormalParameter {
    const span = spanOf(node);
    const children = childrenOf(node).filter((child) => child.type !== 'comment' && child.type !== 'annotation');
    const tokens = new Set(children.filter((child) => !child.isNamed).map((child) => child.type));
    const constructorParam = children.find(
      (child) => child.type === 'constructor_param' || child.type === 'super_formal_parameter'
    );
    if (constructorParam) {
      const parts = childrenOf(constructorParam);
      const typeNode = parts.find((child) => child.type === 'type');
      const name = requireNode(
        parts.find((child) => child.type === 'identifier'),
        constructorParam
      ).text;
      if (parts.some((child) => child.type === 'formal_parameter_list')) {
        return unsupported(node, '関数の型を古い形で書いた引数');
      }
      const ownTokens = new Set(parts.filter((child) => !child.isNamed).map((child) => child.type));
      return {
        annotations: this.annotationsOf(node),
        name,
        type: typeNode ? this.convertType(typeNode) : undefined,
        binding: constructorParam.type === 'constructor_param' ? 'this' : 'super',
        isFinal: tokens.has('final') || ownTokens.has('final'),
        isCovariant: tokens.has('covariant'),
        isRequired,
        defaultValue,
        functionType: undefined,
        ...span,
      };
    }
    if (children.some((child) => child.type === 'formal_parameter_list')) {
      return unsupported(node, '関数の型を古い形で書いた引数（int f(int x) の形）');
    }
    const typeNode = children.find((child) => child.type === 'type');
    const nameNode = fieldOf(node, 'name') ?? children.find((child) => child.type === 'identifier');
    return {
      annotations: this.annotationsOf(node),
      name: requireNode(nameNode, node).text,
      type: typeNode ? this.convertType(typeNode) : undefined,
      binding: 'plain',
      isFinal: tokens.has('final'),
      isCovariant: tokens.has('covariant'),
      isRequired,
      defaultValue,
      functionType: undefined,
      ...span,
    };
  }

  // Statements

  convertBlock(node: Node): Block {
    return { kind: 'block', statements: this.convertStatements(namedOf(node)), ...spanOf(node) };
  }

  private convertStatements(nodes: Node[]): Statement[] {
    return nodes.filter((child) => child.type !== 'comment').map((child) => this.convertStatement(child));
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- One case per kind of statement node in the grammar.
  // code-gauge-allow functionNcss 57 -- One case per kind of statement node in the grammar.
  convertStatement(node: Node): Statement {
    const span = spanOf(node);
    switch (node.type) {
      case 'block': {
        return this.convertBlock(node);
      }
      case 'expression_statement': {
        // Dart reads a `{` that starts a statement as a block, so a statement cannot begin with a set or map literal.
        if (node.text.startsWith('{'))
          return syntaxError(
            node,
            '文の先頭の { はブロックになるので、集合やマップのリテラルは ( ) で囲んでください。'
          );
        const children = childrenOf(node).filter((child) => child.type !== ';');
        return { kind: 'expression', expression: this.soleExpression(node, children), ...span };
      }
      case 'local_variable_declaration': {
        const pattern = namedOf(node).find((child) => child.type === 'pattern_variable_declaration');
        if (pattern) return this.convertPatternDeclaration(pattern);
        return { kind: 'local', declaration: this.convertLocalDeclaration(node), ...span };
      }
      case 'local_function_declaration': {
        const signature = requireNode(
          namedOf(node).find((child) => child.type === 'function_signature'),
          node
        );
        const body = this.convertFunctionBody(
          requireNode(
            namedOf(node).find((child) => child.type === 'function_body'),
            node
          )
        );
        return {
          kind: 'localFunction',
          declaration: this.functionFromSignature(signature, body, 'function', this.annotationsOf(node), span, false),
          ...span,
        };
      }
      case 'if_statement': {
        return this.convertIf(node);
      }
      case 'while_statement':
      case 'do_statement': {
        return {
          kind: node.type === 'while_statement' ? 'while' : 'do',
          condition: this.soleExpression(requireNode(fieldOf(node, 'condition'), node)),
          body: this.convertStatement(requireNode(fieldOf(node, 'body'), node)),
          ...span,
        };
      }
      case 'for_statement': {
        const parts = this.convertForParts(node);
        const body = this.convertStatement(requireNode(fieldOf(node, 'body'), node));
        if (parts.kind === 'forIn') {
          return { kind: 'forIn', binding: parts.binding, iterable: parts.iterable, body, isAwait: false, ...span };
        }
        return { kind: 'for', init: parts.init, condition: parts.condition, updates: parts.updates, body, ...span };
      }
      case 'switch_statement': {
        return this.convertSwitch(node);
      }
      case 'break_statement':
      case 'continue_statement': {
        return {
          kind: node.type === 'break_statement' ? 'break' : 'continue',
          label: namedOf(node).find((child) => child.type === 'identifier')?.text,
          ...span,
        };
      }
      case 'return_statement': {
        const children = childrenOf(node).filter((child) => child.type !== 'return' && child.type !== ';');
        return {
          kind: 'return',
          value: children.some(
            (child) => (child.isNamed && child.type !== 'comment') || child.type === 'this' || child.type === 'super'
          )
            ? this.soleExpression(node, children)
            : undefined,
          ...span,
        };
      }
      case 'try_statement': {
        return this.convertTry(node);
      }
      case 'rethrow_statement': {
        return { kind: 'rethrow', ...span };
      }
      case 'labeled_statement': {
        const labels = namedOf(node)
          .filter((child) => child.type === 'identifier')
          .map((child) => child.text);
        const body = requireNode(
          namedOf(node).find((child) => child.type !== 'identifier'),
          node
        );
        return { kind: 'labeled', labels, body: this.convertStatement(body), ...span };
      }
      case 'assert_statement': {
        const [condition, message] = this.assertionParts(requireNode(namedOf(node)[0], node));
        return { kind: 'assert', condition, message, ...span };
      }
      case 'yield_statement':
      case 'yield_each_statement': {
        const children = childrenOf(node).filter((child) => !['yield', '*', ';'].includes(child.type));
        return {
          kind: 'yield',
          value: this.soleExpression(node, children),
          isEach: node.type === 'yield_each_statement',
          ...span,
        };
      }
      case 'empty_statement': {
        return { kind: 'block', statements: [], ...span };
      }
      default: {
        return syntaxError(node, '書き方に誤りがあります。');
      }
    }
  }

  convertLocalDeclaration(node: Node): VariableDeclaration {
    const annotations = this.annotationsOf(node);
    const definition = requireNode(
      namedOf(node).find((child) => child.type === 'initialized_variable_definition'),
      node
    );
    const children = childrenOf(definition);
    const tokens = new Set(children.filter((child) => !child.isNamed).map((child) => child.type));
    const typeNode = children.find((child) => child.type === 'type');
    if (typeNode && tokens.has('var')) return syntaxError(definition, VAR_WITH_TYPE);
    const variables: VariableDeclarator[] = [];
    const nameNode = requireNode(fieldOf(definition, 'name'), definition);
    const values = fieldsOf(definition, 'value');
    variables.push({
      name: nameNode.text,
      initializer: values.length > 0 ? this.fieldExpression(definition, 'value') : undefined,
      ...spanOf(nameNode),
    });
    for (const child of children.filter((part) => part.type === 'initialized_identifier')) {
      const value = fieldsOf(child, 'value');
      variables.push({
        name: requireNode(fieldOf(child, 'name'), child).text,
        initializer: value.length > 0 ? this.fieldExpression(child, 'value') : undefined,
        ...spanOf(child),
      });
    }
    return {
      kind: 'variables',
      isFinal: tokens.has('final'),
      isConst: tokens.has('const'),
      isLate: tokens.has('late'),
      type: typeNode ? this.convertType(typeNode) : undefined,
      variables,
      annotations,
      ...spanOf(node),
    };
  }

  private convertPatternDeclaration(node: Node): Statement {
    const children = childrenOf(node);
    const equals = children.findIndex((child) => child.type === '=');
    const patternNodes = children.slice(0, equals).filter((child) => child.type !== 'var' && child.type !== 'final');
    return {
      kind: 'patternDeclaration',
      isFinal: hasToken(node, 'final'),
      pattern: this.convertPatternSequence(node, patternNodes, 'declaration'),
      value: this.soleExpression(
        node,
        children.slice(equals + 1).filter((child) => child.type !== ';')
      ),
      ...spanOf(node),
    };
  }

  private convertIf(node: Node): Statement {
    const children = childrenOf(node);
    const caseClause = children.find((child) => child.type === 'if_case_clause');
    const consequence = requireNode(fieldOf(node, 'consequence'), node);
    const open = children.findIndex((child) => child.type === '(');
    const conditionNodes = children
      .slice(open + 1)
      .filter(
        (child) => child.startIndex < consequence.startIndex && child.type !== ')' && child.type !== 'if_case_clause'
      );
    const alternative = fieldOf(node, 'alternative');
    return {
      kind: 'if',
      condition: this.soleExpression(node, conditionNodes),
      casePattern: caseClause ? this.convertCaseClause(caseClause) : undefined,
      consequence: this.convertStatement(consequence),
      alternative: alternative ? this.convertStatement(alternative) : undefined,
      ...spanOf(node),
    };
  }

  private convertSwitch(node: Node): Statement {
    const subject = this.soleExpression(requireNode(fieldOf(node, 'condition'), node));
    const block = requireNode(fieldOf(node, 'body'), node);
    const cases: SwitchCase[] = namedOf(block).map((child) => this.convertSwitchCase(child));
    return { kind: 'switch', subject, cases, ...spanOf(node) };
  }

  private convertSwitchCase(node: Node): SwitchCase {
    const children = syntaxChildrenOf(node);
    const labels = children
      .filter((child) => child.type === 'label')
      .map((child) => requireNode(namedOf(child)[0], child).text);
    const colon = children.findIndex((child) => child.type === ':');
    const statements = this.convertStatements(children.slice(colon + 1).filter((child) => child.isNamed));
    if (node.type === 'switch_statement_default') {
      return { pattern: undefined, guard: undefined, labels, statements, ...spanOf(node) };
    }
    const caseIndex = children.findIndex((child) => child.type === 'case');
    const header = children.slice(caseIndex + 1, colon);
    const when = header.findIndex((child) => child.type === 'when');
    return {
      pattern: this.convertPatternSequence(node, when !== -1 ? header.slice(0, when) : header, 'matching'),
      guard: when !== -1 ? this.soleExpression(node, header.slice(when + 1)) : undefined,
      labels,
      statements,
      ...spanOf(node),
    };
  }

  private convertTry(node: Node): Statement {
    const children = syntaxChildrenOf(node);
    const body = this.convertBlock(requireNode(fieldOf(node, 'body'), node));
    const catches: CatchClause[] = [];
    let finallyBlock: Block | undefined;
    let pending:
      | { type: TypeSyntax | undefined; exception?: string; stackTrace?: string; span: ReturnType<typeof spanOf> }
      | undefined;
    for (const child of children.slice(2)) {
      if (child.type === 'on') {
        pending = { type: undefined, span: spanOf(child) };
      } else if (child.type === 'type') {
        if (pending) pending.type = this.convertType(child);
      } else if (child.type === 'catch_clause') {
        pending ??= { type: undefined, span: spanOf(child) };
        pending.exception = fieldOf(child, 'exception')?.text;
        pending.stackTrace = fieldOf(child, 'stack_trace')?.text;
      } else if (child.type === 'block') {
        if (!pending) return syntaxError(child, '書き方に誤りがあります。');
        catches.push({
          type: pending.type,
          exception: pending.exception,
          stackTrace: pending.stackTrace,
          body: this.convertBlock(child),
          ...pending.span,
        });
        pending = undefined;
      } else if (child.type === 'finally_clause') {
        finallyBlock = this.convertBlock(requireNode(namedOf(child)[0], child));
      }
    }
    if (catches.length === 0 && !finallyBlock)
      return syntaxError(node, 'try の後には on、catch、finally のいずれかを書いてください。');
    return { kind: 'try', body, catches, finally: finallyBlock, ...spanOf(node) };
  }
}

function emptyParameters(span: ReturnType<typeof spanOf>): FormalParameters {
  return { positional: [], requiredCount: 0, named: [], ...span };
}

/**
 * A method written without a return type, as `noSuchMethod(Invocation i) {}`, which the grammar reads as a constructor
 * because only its name tells them apart.
 */
function asUntypedMethod(member: MemberDeclaration, owner: string | undefined): MemberDeclaration | undefined {
  if (member.kind !== 'constructor' || member.constructorKind !== 'generative') return undefined;
  if (member.className === undefined || member.className === owner || member.name !== undefined) return undefined;
  if (member.isConst || member.initializers.length > 0) return undefined;
  requirePlainParameters(member.parameters.positional, member.parameters.named);
  return {
    kind: 'method',
    methodKind: 'method',
    name: member.className,
    isStatic: false,
    isExternal: member.isExternal,
    typeParameters: [],
    returnType: undefined,
    parameters: member.parameters,
    body: member.body,
    annotations: member.annotations,
    headerEndRow: member.headerEndRow,
    row: member.row,
    column: member.column,
    start: member.start,
    end: member.end,
  };
}

function requirePlainParameters(positional: FormalParameter[], named: FormalParameter[]): void {
  const invalid = [...positional, ...named].find((parameter) => parameter.binding !== 'plain');
  if (invalid) syntaxError(invalid, `引数 ${invalid.binding}.${invalid.name} は、この引数リストでは使えません。`);
}
