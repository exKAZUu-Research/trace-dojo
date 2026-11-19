import type {
  Accessor,
  CompilationUnit,
  ConstraintClause,
  EventFieldDeclaration,
  FieldDeclaration,
  MethodDeclaration,
  Modifiers,
  NamespaceDeclaration,
  Parameter,
  Position,
  TypeDeclaration,
  TypeNode,
  TypeParameterDeclaration,
  UsingDirective,
  VariableDeclarator,
} from './ast';
import { BinderBase, namespacePathOf, SPECIAL_TYPE_NAMES, type TypeContext } from './binderBase';
import type { NamespaceSymbol } from './namespaces';
import { nativeOf, OPERATOR_NAMES, UNARY_OPERATOR_NAMES } from './natives';
import {
  type Accessibility,
  baseTypeOf,
  displayMethod,
  displayType,
  displayTypeSymbol,
  ERROR_TYPE,
  FieldSymbol,
  interfacesOf,
  isReferenceType,
  MethodSymbol,
  type NamedType,
  type ParameterSymbol,
  PropertySymbol,
  sameType,
  substitute,
  substitutionOf,
  type Type,
  TypeParameterSymbol,
  TypeSymbol,
  VOID_TYPE,
} from './types';

/** A type declared in source, with where its names resolve. */
export interface DeclaredType {
  symbol: TypeSymbol;
  declaration: TypeDeclaration;
  context: TypeContext;
}

/** Declares the types and members of compilation units: the library's, then a program's. */
export class DeclarationBinder extends BinderBase {
  readonly declaredTypes: DeclaredType[] = [];
  /** The contexts of the methods' signatures and bodies, which include their type parameters. */
  readonly methodContexts = new Map<MethodSymbol, TypeContext>();
  protected isLibraryUnit = false;

  /** Declares every type of a unit and its members, in the order that inheritance needs. */
  declareUnit(unit: CompilationUnit, root: NamespaceSymbol, isLibrary: boolean): DeclaredType[] {
    this.isLibraryUnit = isLibrary;
    const start = this.declaredTypes.length;
    const rootContext: TypeContext = { namespace: [root], usings: [], type: undefined, methodTypeParameters: [] };
    this.collectMembers(unit.members, root, rootContext, []);
    const declared = this.declaredTypes.slice(start);
    // Usings resolve once every namespace exists, since a using may name a namespace declared later.
    const unitUsings = this.resolveUsings(unit.usings);
    for (const type of declared) {
      const chain = this.namespaceUsings.get(type) ?? [];
      type.context.usings = [
        ...chain.toReversed().flatMap((usings) => this.resolveUsings(usings, false)),
        ...unitUsings,
      ];
    }
    for (const type of declared) this.resolveBases(type);
    const ordered = this.orderByInheritance(declared);
    for (const type of ordered) this.resolveConstraints(type);
    for (const type of ordered) this.declareMembers(type);
    for (const type of ordered) this.assignSlots(type.symbol);
    if (isLibrary) {
      // The library's overrides need their links for virtual calls, though its declarations need no other checks.
      for (const type of ordered) for (const method of type.symbol.methods) this.resolveOverride(method, type.symbol);
      for (const type of ordered)
        for (const property of type.symbol.properties) this.resolvePropertyOverride(property, type.symbol);
    } else {
      for (const type of ordered) this.checkInheritance(type);
    }
    return ordered;
  }

  /** The `using` directives of the namespaces around each type, outermost first. */
  private readonly namespaceUsings = new Map<DeclaredType, UsingDirective[][]>();

  private collectMembers(
    members: (TypeDeclaration | NamespaceDeclaration)[],
    namespace: NamespaceSymbol,
    context: TypeContext,
    usingChain: UsingDirective[][]
  ): void {
    for (const member of members) {
      if (member.kind === 'namespace') {
        const inner = namespace.resolve(member.name, true) as NamespaceSymbol;
        const namespaces = [
          inner,
          ...this.namespacesAt(namespacePathOf(inner)).filter((candidate) => candidate !== inner),
        ];
        this.collectMembers(member.members, inner, { ...context, namespace: namespaces }, [
          ...usingChain,
          member.usings,
        ]);
      } else {
        this.declareType(member, namespace, undefined, context, usingChain);
      }
    }
  }

  private declareType(
    declaration: TypeDeclaration,
    namespace: NamespaceSymbol,
    containing: TypeSymbol | undefined,
    outer: TypeContext,
    usingChain: UsingDirective[][]
  ): void {
    const symbol = new TypeSymbol(
      declaration.name,
      declaration.typeKind,
      containing ? containing.namespace : namespace.fullName,
      containing
    );
    symbol.declaration = declaration;
    symbol.isLibrary = this.isLibraryUnit;
    symbol.isRecord = declaration.isRecord;
    symbol.row = declaration.row;
    const modifiers = declaration.modifiers.set;
    symbol.isStatic = modifiers.has('static');
    symbol.isAbstract = modifiers.has('abstract') || declaration.typeKind === 'interface';
    symbol.isSealed =
      modifiers.has('sealed') ||
      modifiers.has('static') ||
      declaration.typeKind === 'struct' ||
      declaration.typeKind === 'enum' ||
      declaration.typeKind === 'delegate';
    symbol.isReadonly = modifiers.has('readonly');
    symbol.access = accessibilityOf(declaration.modifiers, containing ? 'private' : 'internal');
    symbol.typeParameters = declaration.typeParameters.map(
      (parameter, index) => new TypeParameterSymbol(parameter.name, symbol, index, parameter.variance)
    );
    this.checkTypeModifiers(declaration, containing);
    const fullName = symbol.containing
      ? undefined
      : `${symbol.namespace ? `${symbol.namespace}.` : ''}${symbol.metadataName}`;
    if (this.isLibraryUnit && fullName) {
      const special = SPECIAL_TYPE_NAMES[fullName];
      if (special) {
        symbol.special = special;
        this.library.specials.set(special, symbol);
      }
      if (fullName.startsWith('System.ValueTuple`')) {
        symbol.special = 'valueTuple';
        this.library.valueTuples.set(symbol.typeParameters.length, symbol);
      }
    }
    if (containing) {
      if (
        containing.nestedTypes.some(
          (other) => other.name === symbol.name && other.typeParameters.length === symbol.typeParameters.length
        )
      ) {
        this.error(
          declaration,
          'CS0102',
          `型 '${displayTypeSymbol(containing)}' は既に '${symbol.name}' の定義を含んでいます`
        );
      }
      containing.nestedTypes.push(symbol);
    } else {
      if (namespace.findType(symbol.name, symbol.typeParameters.length)) {
        this.error(
          declaration,
          'CS0101',
          `名前空間 '${namespace.fullName || '<global namespace>'}' は既に '${symbol.name}' の定義を含んでいます`
        );
      }
      namespace.addType(symbol);
    }
    const context: TypeContext = { namespace: outer.namespace, usings: [], type: symbol, methodTypeParameters: [] };
    const declared = { symbol, declaration, context };
    this.declaredTypes.push(declared);
    this.namespaceUsings.set(declared, usingChain);
    for (const member of declaration.members) {
      if (member.kind === 'type') this.declareType(member, namespace, symbol, context, usingChain);
    }
  }

  private checkTypeModifiers(declaration: TypeDeclaration, containing: TypeSymbol | undefined): void {
    const modifiers = declaration.modifiers;
    if (!containing && (modifiers.set.has('private') || modifiers.set.has('protected'))) {
      this.error(
        declaration,
        'CS1527',
        '名前空間で定義された要素は明示的に private、protected、protected internal、または private protected に宣言することはできません'
      );
    }
    if (modifiers.set.has('abstract') && modifiers.set.has('sealed')) {
      this.error(
        declaration,
        'CS0418',
        `'${declaration.name}': 抽象型を sealed または static に指定することはできません`
      );
    }
  }

  private resolveBases(type: DeclaredType): void {
    const { symbol, declaration, context } = type;
    if (symbol.kind === 'enum') {
      this.resolveEnumUnderlying(type);
      return;
    }
    if (symbol.kind === 'delegate') {
      symbol.baseType = this.wellKnown.multicastDelegate;
      return;
    }
    const bases = declaration.bases.map((node) => ({ node, type: this.resolveType(node, context) }));
    for (const [index, { node, type: baseType }] of bases.entries()) this.addBase(symbol, node, baseType, index);
    if (symbol.kind === 'struct') symbol.baseType = this.wellKnown.valueType;
    else if (symbol.kind === 'class' && !symbol.baseType && symbol !== this.library.specials.get('object'))
      symbol.baseType = this.objectType;
    if (
      symbol.kind === 'class' &&
      declaration.isRecord &&
      symbol.baseType &&
      !symbol.baseType.symbol.isRecord &&
      symbol.baseType.symbol !== this.objectType.symbol
    ) {
      symbol.baseType = this.objectType;
    }
  }

  private resolveEnumUnderlying({ symbol, declaration, context }: DeclaredType): void {
    symbol.baseType = this.wellKnown.enum;
    const underlying = declaration.enumUnderlyingType
      ? this.resolveType(declaration.enumUnderlyingType, context)
      : this.intType;
    const allowed = ['byte', 'sbyte', 'short', 'ushort', 'int', 'uint', 'long', 'ulong'];
    if (underlying.kind !== 'named' || !allowed.includes(underlying.symbol.special ?? '')) {
      this.error(
        declaration,
        'CS1008',
        'byte、sbyte、short、ushort、int、uint、long または ulong のいずれかの型を使用してください'
      );
      symbol.enumUnderlying = this.intType;
    } else {
      symbol.enumUnderlying = underlying;
    }
  }

  /** Adds one type of a declaration's base list as an interface or the base class, reporting an invalid one. */
  private addBase(symbol: TypeSymbol, node: TypeNode, baseType: Type, index: number): void {
    if (baseType.kind === 'error') return;
    if (baseType.kind !== 'named') {
      this.error(
        node,
        'CS0527',
        `インターフェイス リストの型 '${displayType(baseType)}' はインターフェイスではありません`
      );
      return;
    }
    if (baseType.symbol.kind === 'interface') {
      if (symbol.interfaces.some((existing) => sameType(existing, baseType))) {
        this.error(node, 'CS0528', `'${displayType(baseType)}' は既にインターフェイス リストに存在します`);
      }
      symbol.interfaces.push(baseType);
      return;
    }
    if (this.reportsInvalidBaseClass(symbol, node, baseType, index)) return;
    symbol.baseType = baseType;
  }

  private reportsInvalidBaseClass(symbol: TypeSymbol, node: TypeNode, baseType: NamedType, index: number): boolean {
    if (symbol.kind === 'class' && index > 0) {
      this.error(
        node,
        'CS1721',
        `クラス '${displayTypeSymbol(symbol)}' は複数の基底クラス ('${displayType(symbol.baseType ?? this.objectType)}' と '${displayType(baseType)}') を持つことができません`
      );
      return true;
    }
    if (symbol.kind !== 'class') {
      this.error(
        node,
        'CS0527',
        `インターフェイス リストの型 '${displayType(baseType)}' はインターフェイスではありません`
      );
      return true;
    }
    if (baseType.symbol.isStatic) {
      this.error(
        node,
        'CS0709',
        `'${displayTypeSymbol(symbol)}': 静的クラス '${displayType(baseType)}' から派生することはできません`
      );
      return true;
    }
    if (baseType.symbol.isSealed) {
      this.error(
        node,
        'CS0509',
        `'${displayTypeSymbol(symbol)}': シール型 '${displayType(baseType)}' から派生することはできません`
      );
      return true;
    }
    if (
      !symbol.isLibrary &&
      ['valueType', 'enum', 'array', 'delegate', 'multicastDelegate'].includes(baseType.symbol.special ?? '')
    ) {
      this.error(
        node,
        'CS0644',
        `'${displayTypeSymbol(symbol)}' は特殊クラス '${displayType(baseType)}' から派生することはできません`
      );
      return true;
    }
    if (symbol.isRecord && !baseType.symbol.isRecord && baseType.symbol !== this.objectType.symbol) {
      this.error(node, 'CS8864', "レコードは、レコードまたは 'object' からのみ継承できます。");
      return true;
    }
    return false;
  }

  /** Orders types so that every type follows its base class and its containing type, reporting cycles. */
  private orderByInheritance(types: DeclaredType[]): DeclaredType[] {
    const ordered: DeclaredType[] = [];
    const state = new Map<TypeSymbol, 'visiting' | 'done'>();
    const bySymbol = new Map(types.map((type) => [type.symbol, type]));
    const visit = (type: DeclaredType): void => {
      const current = state.get(type.symbol);
      if (current === 'done') return;
      if (current === 'visiting') {
        this.error(
          type.declaration,
          'CS0146',
          `'${displayTypeSymbol(type.symbol)}' と '${displayType(type.symbol.baseType ?? this.objectType)}' を含む、循環する基本データ型の依存関係です`
        );
        type.symbol.baseType = this.objectType;
        return;
      }
      state.set(type.symbol, 'visiting');
      const dependencies = [
        type.symbol.baseType?.symbol,
        type.symbol.containing,
        ...type.symbol.interfaces.map((face) => face.symbol),
      ];
      for (const dependency of dependencies) {
        const declared = dependency ? bySymbol.get(dependency) : undefined;
        if (declared) visit(declared);
      }
      state.set(type.symbol, 'done');
      ordered.push(type);
    };
    for (const type of types) visit(type);
    return ordered;
  }

  private resolveConstraints(type: DeclaredType): void {
    this.applyConstraints(type.symbol.typeParameters, type.declaration.constraints, type.context);
  }

  protected applyConstraints(
    parameters: TypeParameterSymbol[],
    clauses: ConstraintClause[],
    context: TypeContext
  ): void {
    for (const clause of clauses) {
      const parameter = parameters.find((candidate) => candidate.name === clause.name);
      if (!parameter) {
        this.error(
          clause,
          'CS0699',
          `'${context.type?.name ?? ''}' は、型のパラメーター '${clause.name}' を定義しません`
        );
        continue;
      }
      for (const constraint of clause.constraints) {
        switch (constraint.kind) {
          case 'class': {
            parameter.hasReferenceConstraint = true;
            break;
          }
          case 'struct': {
            parameter.hasValueConstraint = true;
            break;
          }
          case 'new': {
            parameter.hasConstructorConstraint = true;
            break;
          }
          case 'notnull': {
            parameter.hasNotNullConstraint = true;
            break;
          }
          case 'type': {
            const constraintType = this.resolveType(constraint.type, context);
            if (
              constraintType.kind === 'named' &&
              constraintType.symbol.isSealed &&
              constraintType.symbol.kind !== 'interface' &&
              !this.isLibraryUnit &&
              constraintType.symbol.special !== 'enum'
            ) {
              this.error(
                constraint,
                'CS0701',
                `'${displayType(constraintType)}' は有効な制約ではありません。制約として使用された型はインターフェイス、非シール クラス、または型パラメーターでなければなりません。`
              );
            }
            if (constraintType.kind !== 'error') parameter.constraintTypes.push(constraintType);
            break;
          }
        }
      }
    }
  }

  // code-gauge-allow functionNcss 42 -- One case per kind of member declaration.
  // code-gauge-allow functionCognitiveComplexity 16 -- One case per kind of member declaration.
  private declareMembers(type: DeclaredType): void {
    const { symbol, declaration } = type;
    if (symbol.kind === 'enum') {
      this.declareEnumMembers(type);
      return;
    }
    if (symbol.kind === 'delegate') {
      this.declareDelegateInvoke(type);
      return;
    }
    if (declaration.primaryParameters) this.declarePrimaryParameters(type);
    for (const member of declaration.members) {
      switch (member.kind) {
        case 'field': {
          for (const declarator of member.declarators) this.declareField(type, member, declarator);
          break;
        }
        case 'event': {
          for (const declarator of member.declarators) this.declareEvent(type, member, declarator);
          break;
        }
        case 'method': {
          this.declareMethodMember(type, member);
          break;
        }
        case 'constructor': {
          this.declareConstructor(type, member);
          break;
        }
        case 'destructor': {
          if (symbol.kind !== 'class') this.error(member, 'CS0575', 'クラスのみがデストラクターを含むことができます');
          break;
        }
        case 'property':
        case 'indexer': {
          this.declareProperty(type, member);
          break;
        }
        case 'operator': {
          this.declareOperator(type, member);
          break;
        }
        case 'type': {
          break;
        }
      }
    }
    if (symbol.isRecord) this.declareRecordMembers(type);
    this.declareImplicitConstructors(type);
  }

  private declareDelegateInvoke({ symbol, declaration, context }: DeclaredType): void {
    const invoke = new MethodSymbol('Invoke', symbol, 'delegateInvoke');
    invoke.access = 'public';
    invoke.parameters = this.resolveParameters(declaration.delegateParameters, context, invoke);
    invoke.returnType = declaration.delegateReturnType
      ? this.resolveType(declaration.delegateReturnType, context)
      : VOID_TYPE;
    symbol.invoke = invoke;
    symbol.methods.push(invoke);
  }

  private declareField(type: DeclaredType, member: FieldDeclaration, declarator: VariableDeclarator): void {
    const { symbol, context } = type;
    const field = new FieldSymbol(declarator.name, ERROR_TYPE, symbol);
    field.type = this.resolveType(member.type, context);
    field.isStatic = member.modifiers.set.has('static') || member.modifiers.set.has('const');
    field.isConst = member.modifiers.set.has('const');
    field.isReadonly = member.modifiers.set.has('readonly');
    field.access = accessibilityOf(member.modifiers, symbol.kind === 'interface' ? 'public' : 'private');
    field.initializer = declarator.initializer;
    field.row = declarator.row;
    field.column = declarator.column;
    if (member.type.kind === 'varType' && field.type.kind === 'error') this.diagnostics.pop();
    this.checkField(type, member, declarator, field);
    this.addMember(symbol, field, declarator);
    symbol.fields.push(field);
  }

  private checkField(
    { symbol, declaration }: DeclaredType,
    member: FieldDeclaration,
    declarator: VariableDeclarator,
    field: FieldSymbol
  ): void {
    if (member.type.kind === 'varType')
      this.error(
        member.type,
        'CS0825',
        "コンテキスト キーワード 'var' は、ローカル変数宣言またはスクリプト コード内でのみ使用できます"
      );
    if (symbol.kind === 'interface' && !field.isStatic)
      this.error(declarator, 'CS0525', 'インターフェイスにインスタンス フィールドを含めることはできません');
    if (symbol.isStatic && !field.isStatic)
      this.error(
        declarator,
        'CS0708',
        `'${declarator.name}': 静的クラスでインスタンスのメンバーを宣言することはできません`
      );
    if (field.isConst && member.modifiers.set.has('static'))
      this.error(
        declarator,
        'CS0504',
        `定数 '${displayTypeSymbol(symbol)}.${declarator.name}' を static に設定することはできません`
      );
    if (
      symbol.kind === 'struct' &&
      !field.isStatic &&
      declarator.initializer &&
      !declaration.primaryParameters &&
      !declaration.members.some((other) => other.kind === 'constructor')
    ) {
      this.error(
        declarator,
        'CS8983',
        "'struct' でフィールド初期化子を使用するには、明示的に宣言されたコンストラクターが必要です。"
      );
    }
  }

  private declareEvent(
    { symbol, context }: DeclaredType,
    member: EventFieldDeclaration,
    declarator: VariableDeclarator
  ): void {
    const field = new FieldSymbol(declarator.name, this.resolveType(member.type, context), symbol);
    field.isEvent = true;
    field.isStatic = member.modifiers.set.has('static');
    field.access = accessibilityOf(member.modifiers, 'private');
    field.initializer = declarator.initializer;
    field.row = declarator.row;
    field.column = declarator.column;
    if (field.type.kind !== 'error' && !(field.type.kind === 'named' && field.type.symbol.kind === 'delegate')) {
      this.error(
        declarator,
        'CS0066',
        `'${displayTypeSymbol(symbol)}.${declarator.name}': イベントはデリゲート型である必要があります`
      );
    }
    this.addMember(symbol, field, declarator);
    symbol.fields.push(field);
  }

  private declareMethodMember({ symbol, context }: DeclaredType, member: MethodDeclaration): void {
    const method = this.declareMethod(
      symbol,
      member.name,
      'method',
      member.modifiers,
      member,
      context,
      member.typeParameters,
      member.constraints
    );
    method.declaration = member;
    const methodContext = this.methodContexts.get(method) as TypeContext;
    method.returnType = this.resolveType(member.returnType, methodContext);
    method.parameters = this.resolveParameters(member.parameters, methodContext, method);
    method.isExtension = member.parameters[0]?.modifier === 'this';
    this.attachNative(method, member.body === undefined);
    this.checkMethodBody(method, member.body !== undefined, member);
    if (method.name === symbol.name)
      this.error(member, 'CS0542', `'${member.name}': メンバー名をそれを囲む型の名前と同じにすることはできません`);
    this.addMethod(symbol, method, member);
  }

  private declareEnumMembers(type: DeclaredType): void {
    const { symbol } = type;
    const enumType = symbol.declaredType;
    for (const member of type.declaration.enumMembers) {
      const field = new FieldSymbol(member.name, enumType, symbol);
      field.isStatic = true;
      field.isConst = true;
      field.access = 'public';
      field.initializer = member.value;
      field.row = member.row;
      field.column = member.column;
      this.addMember(symbol, field, member);
      symbol.fields.push(field);
    }
  }

  /** The parameters of a class's or struct's primary constructor, which its members read as captured fields. */
  private declarePrimaryParameters(type: DeclaredType): void {
    const { symbol, declaration, context } = type;
    const constructor = new MethodSymbol('.ctor', symbol, 'constructor');
    constructor.access = symbol.isAbstract ? 'protected' : 'public';
    constructor.row = declaration.row;
    const parameters = this.resolveParameters(declaration.primaryParameters ?? [], context, constructor);
    constructor.parameters = parameters;
    symbol.primaryParameters = parameters;
    symbol.constructors.push(constructor);
    this.methodContexts.set(constructor, context);
  }

  private declareConstructor(
    type: DeclaredType,
    member: Extract<TypeDeclaration['members'][number], { kind: 'constructor' }>
  ): void {
    const { symbol, context } = type;
    const isStatic = member.modifiers.set.has('static');
    const constructor = new MethodSymbol(
      isStatic ? '.cctor' : '.ctor',
      symbol,
      isStatic ? 'staticConstructor' : 'constructor'
    );
    constructor.declaration = member;
    constructor.isStatic = isStatic;
    constructor.row = member.row;
    constructor.access = isStatic ? 'private' : accessibilityOf(member.modifiers, 'private');
    if (member.name !== symbol.name) {
      this.error(member, 'CS1520', 'メソッドは戻り値の型を持たなければなりません');
      return;
    }
    if (symbol.kind === 'interface')
      this.error(member, 'CS0526', 'インターフェイスにインスタンス コンストラクターを含めることはできません');
    if (symbol.isStatic && !isStatic) this.error(member, 'CS0710', '静的クラスにはコンストラクターを指定できません');
    if (symbol.primaryParameters && !isStatic && member.initializer?.kind !== 'this') {
      this.error(
        member,
        'CS8862',
        "パラメーター リストを持つ型で宣言されたコンストラクターには、'this' コンストラクター初期化子が必要です。"
      );
    }
    constructor.parameters = this.resolveParameters(member.parameters, context, constructor);
    if (isStatic && member.parameters.length > 0)
      this.error(
        member,
        'CS0132',
        `'${displayMethod(constructor)}': 静的コンストラクターにパラメーターがあってはなりません`
      );
    if (isStatic && accessModifierCount(member.modifiers) > 0)
      this.error(
        member,
        'CS0515',
        `'${displayMethod(constructor)}': アクセス修飾子は静的コンストラクターでは許可されていません`
      );
    this.methodContexts.set(constructor, context);
    this.attachNative(constructor, member.body === undefined);
    if (isStatic) {
      symbol.staticConstructor = constructor;
      return;
    }
    if (symbol.constructors.some((other) => this.sameParameters(other, constructor))) {
      this.error(
        member,
        'CS0111',
        `型 '${displayTypeSymbol(symbol)}' は、'${symbol.name}' と呼ばれるメンバーを同じパラメーターの型で既に定義しています`
      );
    }
    symbol.constructors.push(constructor);
  }

  private declareProperty(
    type: DeclaredType,
    member: Extract<TypeDeclaration['members'][number], { kind: 'property' | 'indexer' }>
  ): void {
    const { symbol, context } = type;
    const isIndexer = member.kind === 'indexer';
    const name = isIndexer ? 'Item' : member.name;
    const property = new PropertySymbol(name, this.resolveType(member.type, context), symbol, isIndexer);
    const modifiers = member.modifiers.set;
    property.isStatic = modifiers.has('static');
    property.access = accessibilityOf(member.modifiers, symbol.kind === 'interface' ? 'public' : 'private');
    property.isVirtual = modifiers.has('virtual');
    property.isAbstract = modifiers.has('abstract') || (symbol.kind === 'interface' && !modifiers.has('static'));
    property.isOverride = modifiers.has('override');
    property.row = member.row;
    property.column = member.column;
    if (member.kind === 'property') property.declaration = member;
    if (isIndexer) {
      if (property.isStatic) this.error(member, 'CS0106', "修飾子 'static' がこの項目に対して有効ではありません");
      property.parameters = this.resolveParameters(member.parameters, context, undefined);
    }
    if (property.type.kind === 'void')
      this.error(
        member,
        'CS0547',
        `'${displayTypeSymbol(symbol)}.${member.kind === 'property' ? member.name : 'this'}': プロパティまたはインデクサーに void 型を指定することはできません`
      );
    const hasBodies = member.accessors.some((accessor) => accessor.body !== undefined);
    const isAuto =
      !this.isLibraryUnit &&
      member.kind === 'property' &&
      !member.isExpressionBodied &&
      !hasBodies &&
      !property.isAbstract &&
      symbol.kind !== 'interface';
    if (member.kind === 'property' && member.initializer && !isAuto) {
      this.error(
        member,
        'CS8050',
        `自動実装プロパティ、または 'field' キーワードを使用するプロパティのみが初期化子を持つことができます。`
      );
    }
    if (isAuto) {
      const field = new FieldSymbol(`<${name}>k__BackingField`, property.type, symbol);
      field.isStatic = property.isStatic;
      field.isReadonly = !member.accessors.some((accessor) => accessor.kind === 'set');
      field.property = property;
      field.initializer = member.initializer;
      field.row = member.row;
      field.column = member.column;
      property.backingField = field;
      symbol.fields.push(field);
      if (symbol.isStatic && !property.isStatic)
        this.error(member, 'CS0708', `'${name}': 静的クラスでインスタンスのメンバーを宣言することはできません`);
    }
    for (const accessor of member.accessors) this.declareAccessor(type, property, accessor, member.modifiers);
    if (
      member.accessors.filter((accessor) => accessor.kind === 'get').length > 1 ||
      member.accessors.filter((accessor) => accessor.kind !== 'get').length > 1
    ) {
      this.error(member, 'CS1007', 'プロパティ アクセサーは既に定義されています');
    }
    if (isAuto && !property.getter)
      this.error(member, 'CS8051', '自動実装プロパティは get アクセサーを持つ必要があります。');
    this.addMember(symbol, property, member);
    symbol.properties.push(property);
  }

  private declareAccessor(
    type: DeclaredType,
    property: PropertySymbol,
    accessor: Accessor,
    propertyModifiers: Modifiers
  ): void {
    const { symbol, context } = type;
    const isGetter = accessor.kind === 'get';
    const method = new MethodSymbol(
      `${isGetter ? 'get' : 'set'}_${property.name}`,
      symbol,
      isGetter ? 'getter' : 'setter'
    );
    method.property = property;
    method.isStatic = property.isStatic;
    method.isVirtual = property.isVirtual;
    method.isAbstract = property.isAbstract;
    method.isOverride = property.isOverride;
    method.isSealed = propertyModifiers.set.has('sealed');
    method.access =
      accessModifierCount(accessor.modifiers) > 0
        ? accessibilityOf(accessor.modifiers, property.access)
        : property.access;
    method.row = accessor.row;
    method.returnType = isGetter ? property.type : VOID_TYPE;
    method.parameters = [...property.parameters];
    if (!isGetter) method.parameters.push({ name: 'value', type: property.type, refKind: undefined, isParams: false });
    this.methodContexts.set(method, context);
    method.declaration = accessor.body
      ? ({ kind: 'method', body: accessor.body, bodyRow: accessor.row, row: accessor.row } as never)
      : undefined;
    this.attachNative(method, accessor.body === undefined && !property.backingField);
    if (isGetter) property.getter = method;
    else {
      property.setter = method;
      property.isInitOnly = accessor.kind === 'init';
    }
  }

  private declareOperator(
    type: DeclaredType,
    member: Extract<TypeDeclaration['members'][number], { kind: 'operator' }>
  ): void {
    const { symbol, context } = type;
    const isUnary = member.parameters.length === 1;
    const name = (isUnary ? UNARY_OPERATOR_NAMES[member.operator] : undefined) ?? OPERATOR_NAMES[member.operator];
    const method = this.declareMethod(symbol, name, 'operator', member.modifiers, member, context);
    method.operatorToken = member.operator;
    method.declaration = member;
    method.returnType = this.resolveType(member.returnType, context);
    method.parameters = this.resolveParameters(member.parameters, context, method);
    if (!member.modifiers.set.has('public') || !member.modifiers.set.has('static')) {
      this.error(
        member,
        'CS0558',
        `ユーザー定義の演算子 '${displayTypeSymbol(symbol)}.operator ${member.operator}(${method.parameters.map((parameter) => displayType(parameter.type)).join(', ')})' は static および public として宣言されなければなりません`
      );
    }
    const ownType = symbol.declaredType;
    if (
      !method.parameters.some(
        (parameter) => sameType(parameter.type, ownType) || sameType(parameter.type, this.nullableOf(ownType))
      )
    ) {
      const code = isUnary ? 'CS0562' : 'CS0563';
      const what = isUnary ? '単項演算子のパラメーター' : '二項演算子のパラメーターのうち 1 つ';
      this.error(member, code, `${what}は、それを含んでいる型でなければなりません`);
    }
    this.attachNative(method, member.body === undefined);
    this.addMethod(symbol, method, member);
  }

  private declareMethod(
    symbol: TypeSymbol,
    name: string,
    kind: 'method' | 'operator',
    modifiers: Modifiers,
    position: Position,
    context: TypeContext,
    typeParameters: TypeParameterDeclaration[] = [],
    constraints: ConstraintClause[] = []
  ): MethodSymbol {
    const method = new MethodSymbol(name, symbol, kind);
    const set = modifiers.set;
    method.isStatic = set.has('static');
    method.isVirtual = set.has('virtual');
    method.isAbstract = set.has('abstract') || (symbol.kind === 'interface' && !set.has('static'));
    method.isOverride = set.has('override');
    method.isSealed = set.has('sealed');
    method.isNew = set.has('new');
    method.isExtern = set.has('extern');
    method.access = accessibilityOf(modifiers, symbol.kind === 'interface' ? 'public' : 'private');
    method.row = position.row;
    method.typeParameters = typeParameters.map(
      (parameter, index) => new TypeParameterSymbol(parameter.name, method, index, undefined)
    );
    const methodContext: TypeContext = {
      ...context,
      methodTypeParameters: [...context.methodTypeParameters, ...method.typeParameters],
    };
    this.methodContexts.set(method, methodContext);
    this.applyConstraints(method.typeParameters, constraints, methodContext);
    if (symbol.isStatic && !method.isStatic && kind === 'method')
      this.error(position, 'CS0708', `'${name}': 静的クラスでインスタンスのメンバーを宣言することはできません`);
    this.checkMethodModifiers(method, modifiers, position);
    return method;
  }

  private checkMethodModifiers(method: MethodSymbol, modifiers: Modifiers, position: Position): void {
    const display = (): string => displayMethod(method);
    if (method.isAbstract && !method.owner.isAbstract && method.owner.kind === 'class') {
      this.error(
        position,
        'CS0513',
        `'${display()}' は抽象ですが、非抽象型の '${displayTypeSymbol(method.owner)}' に含まれています`
      );
    }
    if (
      (method.isVirtual || method.isAbstract || method.isOverride) &&
      modifiers.set.has('private') &&
      method.owner.kind !== 'interface'
    ) {
      this.error(position, 'CS0621', `'${display()}': 仮想または抽象メンバーには、private を指定できません`);
    }
    if (
      method.isStatic &&
      (method.isVirtual || method.isOverride || (modifiers.set.has('abstract') && method.owner.kind !== 'interface'))
    ) {
      const keyword = method.isVirtual ? 'virtual' : method.isOverride ? 'override' : 'abstract';
      this.error(position, 'CS0112', `静的なメンバーを '${keyword}' とマークすることはできません。`);
    }
    if (method.isVirtual && method.isOverride)
      this.error(
        position,
        'CS0113',
        `override 型のメンバー '${display()}' を、new または virtual にすることはできません`
      );
    if (
      method.owner.kind === 'struct' &&
      (method.isVirtual || modifiers.set.has('abstract') || modifiers.set.has('protected'))
    ) {
      this.error(
        position,
        'CS0106',
        `修飾子 '${modifiers.set.has('protected') ? 'protected' : method.isVirtual ? 'virtual' : 'abstract'}' がこの項目に対して有効ではありません`
      );
    }
  }

  private checkMethodBody(method: MethodSymbol, hasBody: boolean, position: Position): void {
    if (this.isLibraryUnit) return;
    if (method.owner.kind === 'interface') {
      if (hasBody && !method.isStatic) this.unsupported(position, 'インターフェイスの既定の実装');
      if (method.isStatic) this.unsupported(position, 'インターフェイスの静的メンバー');
      return;
    }
    if (!hasBody && !method.isAbstract && !method.isExtern) {
      this.error(
        position,
        'CS0501',
        `'${displayMethod(method)}' は abstract、extern、または partial に指定されていないため、本体を宣言する必要があります`
      );
    }
    if (hasBody && method.isAbstract)
      this.error(position, 'CS0500', `'${displayMethod(method)}' は abstract に指定されているため本体を宣言できません`);
  }

  /** Links a library method without a body to its TypeScript implementation. */
  private attachNative(method: MethodSymbol, lacksBody: boolean): void {
    if (!this.isLibraryUnit || !lacksBody || (method.isAbstract && method.owner.kind === 'interface')) return;
    // An abstract method of the library has a native only when the library's own objects of the abstract class
    // implement it, as `Comparer<T>.Default` does.
    method.native = nativeOf(method);
  }

  resolveParameters(
    parameters: Parameter[],
    context: TypeContext,
    method: MethodSymbol | undefined
  ): ParameterSymbol[] {
    const result: ParameterSymbol[] = [];
    for (const [index, parameter] of parameters.entries()) {
      const type = parameter.type ? this.resolveType(parameter.type, context) : ERROR_TYPE;
      if (result.some((other) => other.name === parameter.name)) {
        this.error(parameter, 'CS0100', `パラメーター名 '${parameter.name}' が重複しています`);
      }
      if (parameter.modifier === 'params') {
        if (index !== parameters.length - 1)
          this.error(
            parameter,
            'CS0231',
            'params パラメーターは、パラメーター リストの最後のパラメーターでなければなりません'
          );
        if (type.kind !== 'array' && type.kind !== 'error')
          this.error(parameter, 'CS0225', 'params パラメーターには有効なコレクションの種類が必要です');
      }
      if (
        parameter.modifier === 'this' &&
        method &&
        (!method.owner.isStatic || method.owner.typeParameters.length > 0 || method.owner.containing)
      ) {
        this.error(parameter, 'CS1106', `拡張メソッドは、非ジェネリック静的クラスで定義される必要があります`);
      }
      result.push({
        name: parameter.name,
        type,
        refKind:
          parameter.modifier === 'ref' || parameter.modifier === 'out' || parameter.modifier === 'in'
            ? parameter.modifier
            : undefined,
        isParams: parameter.modifier === 'params',
        defaultSyntax: parameter.defaultValue,
        position: parameter,
      });
    }
    return result;
  }

  /** Declares the members that the compiler gives a record. */
  private declareRecordMembers(type: DeclaredType): void {
    const { symbol, context } = type;
    for (const [index, parameter] of (symbol.primaryParameters ?? []).entries()) {
      const existing = this.ownMembers(symbol, parameter.name);
      if (existing.length > 0 || this.inheritsProperty(symbol, parameter.name)) continue;
      const property = new PropertySymbol(parameter.name, parameter.type, symbol, false);
      property.access = 'public';
      property.row = symbol.row;
      // The positional properties come before the body's members.
      property.column = index - (symbol.primaryParameters?.length ?? 0);
      const field = new FieldSymbol(`<${parameter.name}>k__BackingField`, parameter.type, symbol);
      field.property = property;
      field.isReadonly = symbol.kind === 'class';
      field.row = symbol.row;
      field.isPrimaryParameter = true;
      // A positional record's property starts with its parameter's value, as a field initializer gives it.
      field.initializer = { kind: 'name', name: parameter.name, typeArgs: undefined, row: symbol.row, column: 0 };
      property.backingField = field;
      symbol.fields.push(field);
      for (const kind of ['get', symbol.kind === 'class' ? 'init' : 'set'] as const) {
        this.declareAccessor(
          type,
          property,
          { kind, modifiers: { set: new Set(), positions: new Map() }, body: undefined, row: symbol.row, column: 0 },
          { set: new Set(), positions: new Map() }
        );
      }
      this.addMember(symbol, property, { row: symbol.row, column: 0 });
      symbol.properties.push(property);
    }
    void context;
    const synthesize = (
      name: string,
      parameters: ParameterSymbol[],
      returnType: Type,
      modifiers: { isOverride?: boolean; isVirtual?: boolean; isStatic?: boolean },
      operatorToken?: string
    ): void => {
      if (
        this.ownMembers(symbol, name).some(
          (member) =>
            member instanceof MethodSymbol &&
            member.parameters.length === parameters.length &&
            member.parameters.every((parameter, index) => sameType(parameter.type, parameters[index].type))
        )
      )
        return;
      const method = new MethodSymbol(name, symbol, operatorToken ? 'operator' : 'method');
      method.access = 'public';
      method.parameters = parameters;
      method.returnType = returnType;
      method.isOverride = modifiers.isOverride === true;
      method.isVirtual = modifiers.isVirtual === true && symbol.kind === 'class';
      method.isStatic = modifiers.isStatic === true;
      method.operatorToken = operatorToken;
      method.row = symbol.row;
      method.native = recordNative(name);
      this.addMethod(symbol, method, { row: symbol.row, column: 0 });
    };
    const own = symbol.declaredType;
    synthesize('ToString', [], this.stringType, { isOverride: true });
    synthesize('Equals', [parameter('obj', this.objectType)], this.boolType, { isOverride: true });
    synthesize('Equals', [parameter('other', own)], this.boolType, { isVirtual: true });
    synthesize('GetHashCode', [], this.intType, { isOverride: true });
    synthesize(
      'op_Equality',
      [parameter('left', own), parameter('right', own)],
      this.boolType,
      { isStatic: true },
      '=='
    );
    synthesize(
      'op_Inequality',
      [parameter('left', own), parameter('right', own)],
      this.boolType,
      { isStatic: true },
      '!='
    );
    if (symbol.primaryParameters && symbol.primaryParameters.length > 0) {
      synthesize(
        'Deconstruct',
        symbol.primaryParameters.map((primary) => parameter(primary.name, primary.type, 'out')),
        VOID_TYPE,
        {}
      );
    }
  }

  /** Gives a class without constructors a parameterless one, and a struct its implicit one. */
  private declareImplicitConstructors(type: DeclaredType): void {
    const { symbol } = type;
    if (symbol.kind === 'interface' || symbol.isStatic) return;
    const hasParameterless = symbol.constructors.some((constructor) => constructor.parameters.length === 0);
    if (symbol.kind === 'class' && symbol.constructors.length > 0) return;
    if (symbol.kind === 'struct' && hasParameterless) return;
    const constructor = new MethodSymbol('.ctor', symbol, 'constructor');
    constructor.access = symbol.isAbstract ? 'protected' : 'public';
    constructor.row = symbol.row;
    if (symbol.isLibrary) constructor.native = nativeOf(constructor);
    symbol.constructors.push(constructor);
    this.methodContexts.set(constructor, type.context);
  }

  /** Whether a record's base has an accessible property of a name, which a positional parameter then does not declare. */
  private inheritsProperty(symbol: TypeSymbol, name: string): boolean {
    for (let base = symbol.baseType; base; base = base.symbol.baseType) {
      if (base.symbol.properties.some((property) => property.name === name && property.access !== 'private'))
        return true;
    }
    return false;
  }

  private ownMembers(symbol: TypeSymbol, name: string): (FieldSymbol | MethodSymbol | PropertySymbol | TypeSymbol)[] {
    return [
      ...symbol.fields.filter((field) => field.name === name),
      ...symbol.methods.filter((method) => method.name === name),
      ...symbol.properties.filter((property) => property.name === name && !property.isIndexer),
      ...symbol.nestedTypes.filter((nested) => nested.name === name),
    ];
  }

  private addMember(symbol: TypeSymbol, member: FieldSymbol | PropertySymbol, position: Position): void {
    if (member instanceof PropertySymbol && member.isIndexer) {
      const clash = symbol.properties.find(
        (other) =>
          other.isIndexer &&
          other.parameters.length === member.parameters.length &&
          other.parameters.every((parameter, index) => sameType(parameter.type, member.parameters[index].type))
      );
      if (clash)
        this.error(
          position,
          'CS0111',
          `型 '${displayTypeSymbol(symbol)}' は、'this' と呼ばれるメンバーを同じパラメーターの型で既に定義しています`
        );
      return;
    }
    if (this.ownMembers(symbol, member.name).length > 0) {
      this.error(position, 'CS0102', `型 '${displayTypeSymbol(symbol)}' は既に '${member.name}' の定義を含んでいます`);
    }
    if (member.name === symbol.name && !symbol.isLibrary)
      this.error(position, 'CS0542', `'${member.name}': メンバー名をそれを囲む型の名前と同じにすることはできません`);
  }

  private addMethod(symbol: TypeSymbol, method: MethodSymbol, position: Position): void {
    const others = this.ownMembers(symbol, method.name);
    if (others.some((other) => !(other instanceof MethodSymbol))) {
      this.error(position, 'CS0102', `型 '${displayTypeSymbol(symbol)}' は既に '${method.name}' の定義を含んでいます`);
    } else if (others.some((other) => other instanceof MethodSymbol && this.sameParameters(other, method))) {
      this.error(
        position,
        'CS0111',
        `型 '${displayTypeSymbol(symbol)}' は、'${method.name}' と呼ばれるメンバーを同じパラメーターの型で既に定義しています`
      );
    }
    symbol.methods.push(method);
  }

  /** Whether two methods have the same parameter types and passing modes, mapping their type parameters by position. */
  sameParameters(a: MethodSymbol, b: MethodSymbol, aOwner?: NamedType, bOwner?: NamedType): boolean {
    if (a.parameters.length !== b.parameters.length || a.typeParameters.length !== b.typeParameters.length)
      return false;
    const aSubstitution = new Map(aOwner ? substitutionOf(aOwner) : []);
    const bSubstitution = new Map(bOwner ? substitutionOf(bOwner) : []);
    for (const [index, parameter] of a.typeParameters.entries())
      aSubstitution.set(parameter, b.typeParameters[index].type);
    return a.parameters.every((parameter, index) => {
      const other = b.parameters[index];
      return (
        (parameter.refKind === undefined) === (other.refKind === undefined) &&
        sameType(substitute(parameter.type, aSubstitution), substitute(other.type, bSubstitution))
      );
    });
  }

  /** Numbers the fields of each type after those of its bases, since an object keeps them in one array. */
  protected assignSlots(symbol: TypeSymbol): void {
    let instance = symbol.baseType?.symbol.instanceFieldCount ?? 0;
    let statics = 0;
    for (const field of symbol.fields) {
      if (field.isConst) continue;
      field.slot = field.isStatic ? statics++ : instance++;
    }
    symbol.instanceFieldCount = instance;
    symbol.staticFieldCount = statics;
  }

  private checkInheritance(type: DeclaredType): void {
    const { symbol } = type;
    if (symbol.kind !== 'class' && symbol.kind !== 'struct') return;
    for (const method of symbol.methods) this.resolveOverride(method, symbol);
    for (const property of symbol.properties) this.resolvePropertyOverride(property, symbol);
    if (symbol.kind === 'class' && !symbol.isAbstract) {
      for (const missing of this.unimplementedAbstracts(symbol)) {
        this.error(
          symbol.row,
          'CS0534',
          `'${displayTypeSymbol(symbol)}' は継承抽象メンバー '${missing}' を実装しません`
        );
      }
    }
    // The library's classes implement their interfaces in .NET, which their declarations here do not all spell out.
    const libraryBase = this.libraryBaseOf(symbol);
    const inherited = libraryBase ? this.allInterfaces(libraryBase) : [];
    for (const face of this.allInterfaces(symbol.declaredType)) {
      if (inherited.some((other) => sameType(other, face))) continue;
      for (const member of face.symbol.methods) {
        if (member.isStatic || member.property) continue;
        if (!this.findImplementation(symbol.declaredType, member, face)) this.reportUnimplemented(symbol, member, face);
      }
      for (const property of face.symbol.properties) {
        const implementation = this.findPropertyImplementation(symbol.declaredType, property, face);
        if (!implementation) {
          this.error(
            symbol.row,
            'CS0535',
            `'${displayTypeSymbol(symbol)}' はインターフェイス メンバー '${displayTypeSymbol(face.symbol, face.args)}.${property.isIndexer ? `this[${property.parameters.map((parameter) => displayType(substitute(parameter.type, substitutionOf(face)))).join(', ')}]` : property.name}' を実装しません`
          );
        }
      }
    }
  }

  private libraryBaseOf(symbol: TypeSymbol): NamedType | undefined {
    for (let base = symbol.baseType; base; base = baseTypeOf(base)) if (base.symbol.isLibrary) return base;
    return undefined;
  }

  protected allInterfaces(type: NamedType): NamedType[] {
    const result: NamedType[] = [];
    const add = (face: NamedType): void => {
      if (result.some((existing) => sameType(existing, face))) return;
      result.push(face);
      for (const parent of interfacesOf(face)) add(parent);
    };
    for (let current: NamedType | undefined = type; current; current = baseTypeOf(current)) {
      for (const face of interfacesOf(current)) add(face);
    }
    return result;
  }

  private resolveOverride(method: MethodSymbol, symbol: TypeSymbol): void {
    if (method.kind === 'operator' || method.isStatic) return;
    const base = symbol.baseType;
    if (!method.isOverride) return;
    for (let current = base; current; current = baseTypeOf(current)) {
      const candidate = current.symbol.methods.find(
        (other) => other.name === method.name && this.sameParameters(other, method, current, symbol.declaredType)
      );
      if (!candidate) continue;
      if (!candidate.isVirtual && !candidate.isAbstract && !candidate.isOverride) {
        this.error(
          method.row,
          'CS0506',
          `'${displayMethod(method)}': 継承されたメンバー '${displayMethodIn(candidate, current)}' は virtual、abstract または override に設定されていないためオーバーライドできません`
        );
        return;
      }
      if (candidate.isSealed) {
        this.error(
          method.row,
          'CS0239',
          `'${displayMethod(method)}': 継承されたメンバー '${displayMethodIn(candidate, current)}' はシールされているため、オーバーライドできません`
        );
        return;
      }
      const expectedReturn = substitute(candidate.returnType, substitutionOf(current));
      if (
        !sameType(expectedReturn, method.returnType) &&
        method.returnType.kind !== 'error' &&
        expectedReturn.kind !== 'error'
      ) {
        this.error(
          method.row,
          'CS0508',
          `'${displayMethod(method)}': オーバーライドされたメンバー '${displayMethodIn(candidate, current)}' に対応するために戻り値の型は '${displayType(expectedReturn)}' でなければなりません`
        );
      }
      if (
        candidate.access !== method.access &&
        !(candidate.owner.isLibrary && candidate.access === 'protected' && method.access === 'protected')
      ) {
        this.error(
          method.row,
          'CS0507',
          `'${displayMethod(method)}': '${accessibilityText(candidate.access)}' の継承メンバー '${displayMethodIn(candidate, current)}' をオーバーライドするときに、アクセス修飾子を変更できません`
        );
      }
      method.overridden = candidate;
      return;
    }
    this.error(
      method.row,
      'CS0115',
      `'${displayMethod(method)}': オーバーライドする適切なメソッドが見つかりませんでした`
    );
  }

  private resolvePropertyOverride(property: PropertySymbol, symbol: TypeSymbol): void {
    if (!property.isOverride) return;
    for (let current = symbol.baseType; current; current = baseTypeOf(current)) {
      const candidate = current.symbol.properties.find(
        (other) => other.name === property.name && other.isIndexer === property.isIndexer
      );
      if (!candidate) continue;
      if (!candidate.isVirtual && !candidate.isAbstract && !candidate.isOverride) {
        this.error(
          property.row,
          'CS0506',
          `'${displayTypeSymbol(symbol)}.${property.name}': 継承されたメンバー '${displayTypeSymbol(current.symbol, current.args)}.${candidate.name}' は virtual、abstract または override に設定されていないためオーバーライドできません`
        );
        return;
      }
      property.overridden = candidate;
      if (property.getter) property.getter.overridden = this.accessorOf(candidate, 'getter');
      if (property.setter) property.setter.overridden = this.accessorOf(candidate, 'setter');
      return;
    }
    this.error(
      property.row,
      'CS0115',
      `'${displayTypeSymbol(symbol)}.${property.name}': オーバーライドする適切なメソッドが見つかりませんでした`
    );
  }

  private accessorOf(property: PropertySymbol, kind: 'getter' | 'setter'): MethodSymbol | undefined {
    for (let current: PropertySymbol | undefined = property; current; current = current.overridden) {
      const accessor = kind === 'getter' ? current.getter : current.setter;
      if (accessor) return accessor;
    }
    return undefined;
  }

  private unimplementedAbstracts(symbol: TypeSymbol): string[] {
    const missing: string[] = [];
    const implemented = new Set<MethodSymbol | PropertySymbol>();
    for (let current: NamedType | undefined = symbol.declaredType; current; current = baseTypeOf(current)) {
      for (const method of current.symbol.methods) {
        if (method.isAbstract && !implemented.has(method)) missing.push(displayMethodIn(method, current));
        addOverriddenChain(method, implemented);
      }
      for (const property of current.symbol.properties) {
        if (property.isAbstract && !implemented.has(property)) missing.push(...displayAccessorsIn(property, current));
        addOverriddenChain(property, implemented);
      }
    }
    return missing;
  }

  /** The method of a class or its bases that implements an interface's method, which must be public and an instance method. */
  /**
   * Reports an interface method that a class does not implement: as CS0737 or CS0738 when a method of the same
   * signature is not public or returns another type, and as CS0535 otherwise.
   */
  private reportUnimplemented(symbol: TypeSymbol, member: MethodSymbol, face: NamedType): void {
    const memberText = displayMethodIn(member, face);
    for (let current: NamedType | undefined = symbol.declaredType; current; current = baseTypeOf(current)) {
      const owner = current;
      const close = owner.symbol.methods.find(
        (method) =>
          method.name === member.name &&
          !method.isStatic &&
          method.kind === 'method' &&
          this.sameParameters(method, member, owner, face)
      );
      if (!close) continue;
      const closeText = displayMethodIn(close, owner);
      if (close.access !== 'public') {
        this.error(
          symbol.row,
          'CS0737',
          `'${displayTypeSymbol(symbol)}' は、インターフェイス メンバー '${memberText}' を実装していません。'${closeText}' は public ではないため、インターフェイス メンバーを実装できません。`
        );
      } else {
        const expected = displayType(substitute(member.returnType, substitutionOf(face)));
        this.error(
          symbol.row,
          'CS0738',
          `'${displayTypeSymbol(symbol)}' は、インターフェイス メンバー '${memberText}' を実装していません。'${closeText}' は一致する '${expected}' の戻り値の型を持たないため、'${memberText}' を実装できません。`
        );
      }
      return;
    }
    this.error(
      symbol.row,
      'CS0535',
      `'${displayTypeSymbol(symbol)}' はインターフェイス メンバー '${memberText}' を実装しません`
    );
  }

  findImplementation(type: NamedType, member: MethodSymbol, face: NamedType): MethodSymbol | undefined {
    for (let current: NamedType | undefined = type; current; current = baseTypeOf(current)) {
      const candidate = current.symbol.methods.find(
        (method) =>
          method.name === member.name &&
          !method.isStatic &&
          method.kind === 'method' &&
          this.sameParameters(method, member, current, face) &&
          sameType(
            substitute(method.returnType, substitutionOf(current as NamedType)),
            substitute(member.returnType, substitutionOf(face))
          )
      );
      if (candidate) return candidate.access === 'public' || current.symbol.isLibrary ? candidate : undefined;
    }
    return undefined;
  }

  findPropertyImplementation(type: NamedType, member: PropertySymbol, face: NamedType): PropertySymbol | undefined {
    for (let current: NamedType | undefined = type; current; current = baseTypeOf(current)) {
      const candidate = current.symbol.properties.find(
        (property) => property.name === member.name && property.isIndexer === member.isIndexer && !property.isStatic
      );
      if (candidate) {
        const ok =
          sameType(
            substitute(candidate.type, substitutionOf(current)),
            substitute(member.type, substitutionOf(face))
          ) &&
          (!member.getter || candidate.getter?.access === 'public') &&
          (!member.setter || candidate.setter?.access === 'public');
        return ok ? candidate : undefined;
      }
    }
    return undefined;
  }
}

/** Synthesized record members run natively, comparing and printing the record's fields. */
function recordNative(name: string): MethodSymbol['native'] {
  return (call, receiver, args) => call.frame.runtime.recordMember(call, name, receiver, args);
}

export function accessibilityOf(modifiers: Modifiers, fallback: Accessibility): Accessibility {
  const set = modifiers.set;
  if (set.has('protected') && set.has('internal')) return 'protected internal';
  if (set.has('private') && set.has('protected')) return 'private protected';
  if (set.has('public')) return 'public';
  if (set.has('private')) return 'private';
  if (set.has('protected')) return 'protected';
  if (set.has('internal')) return 'internal';
  return fallback;
}

function accessModifierCount(modifiers: Modifiers): number {
  return ['public', 'private', 'protected', 'internal'].filter((modifier) => modifiers.set.has(modifier as never))
    .length;
}

function accessibilityText(access: Accessibility): string {
  return access;
}

/** A method's display name as a member of a constructed type, as diagnostics show inherited members. */
export function displayMethodIn(method: MethodSymbol, owner: NamedType): string {
  const substitution = substitutionOf(owner);
  const parameters = method.parameters
    .map(
      (parameter) =>
        `${parameter.refKind ? `${parameter.refKind} ` : ''}${displayType(substitute(parameter.type, substitution))}`
    )
    .join(', ');
  if (method.kind === 'getter' || method.kind === 'setter') return displayMethod(method);
  // Roslyn names a constructor after its type, as `A.A(int)`.
  const name = method.kind === 'constructor' ? owner.symbol.name : method.name;
  return `${displayTypeSymbol(owner.symbol, owner.args)}.${name}${method.typeParameters.length > 0 ? `<${method.typeParameters.map((parameter) => parameter.name).join(', ')}>` : ''}(${parameters})`;
}

export function isDelegateType(type: Type): type is NamedType {
  return type.kind === 'named' && type.symbol.kind === 'delegate';
}

export { isReferenceType };

function parameter(name: string, parameterType: Type, refKind?: 'out'): ParameterSymbol {
  return { name, type: parameterType, refKind, isParams: false };
}

function addOverriddenChain(
  member: MethodSymbol | PropertySymbol,
  implemented: Set<MethodSymbol | PropertySymbol>
): void {
  for (
    let overridden: MethodSymbol | PropertySymbol | undefined = member.overridden;
    overridden;
    overridden = overridden.overridden
  )
    implemented.add(overridden);
}

function displayAccessorsIn(property: PropertySymbol, owner: NamedType): string[] {
  return [property.getter, property.setter]
    .filter((accessor) => accessor !== undefined)
    .map(
      (accessor) =>
        `${displayTypeSymbol(owner.symbol, owner.args)}.${property.name}.${accessor === property.getter ? 'get' : 'set'}`
    );
}
