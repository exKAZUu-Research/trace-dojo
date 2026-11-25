// code-gauge-allow-file fileNcss -- The declarations module keeps one stage of the C# interpreter together.
import type {
  Accessor,
  CompilationUnit,
  ConstraintClause,
  EventAccessorDeclaration,
  EventFieldDeclaration,
  FieldDeclaration,
  IndexerDeclaration,
  MethodDeclaration,
  Modifiers,
  NamespaceDeclaration,
  Parameter,
  Position,
  PropertyDeclaration,
  TypeDeclaration,
  TypeNode,
  TypeParameterDeclaration,
  UsingDirective,
  VariableDeclarator,
} from './ast';
import { BinderBase, namespacePathOf, SPECIAL_TYPE_NAMES, type TypeContext } from './binderBase';
import type { NamespaceSymbol } from './namespaces';
import {
  ASSIGNMENT_OPERATOR_NAMES,
  checkedOperatorName,
  nativeOf,
  OPERATOR_NAMES,
  UNARY_OPERATOR_NAMES,
} from './natives';
import { joinPartialMembers, joinPartialType } from './partials';
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
  isValueType,
  MethodSymbol,
  type NamedType,
  type ParameterSymbol,
  PropertySymbol,
  sameType,
  substitute,
  type Substitution,
  substitutionOf,
  type Type,
  TypeParameterSymbol,
  TypeSymbol,
  VOID_TYPE,
  withoutNullable,
} from './types';

/** A type declared in source, with where its names resolve. */
/** The `using` directives of a namespace declaration, with the namespace their targets resolve in. */
interface UsingLevel {
  usings: readonly UsingDirective[];
  namespace: NamespaceSymbol[];
}

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
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  // code-gauge-allow functionNcss -- Each branch handles one case of the C# rule that the function applies.
  declareUnit(unit: CompilationUnit, root: NamespaceSymbol, isLibrary: boolean): DeclaredType[] {
    this.isLibraryUnit = isLibrary;
    const start = this.declaredTypes.length;
    const rootContext: TypeContext = { namespace: [root], usings: [], type: undefined, methodTypeParameters: [] };
    this.collectMembers(unit.members, root, rootContext, []);
    const declared = this.declaredTypes.slice(start);
    // Usings resolve once every namespace exists, since a using may name a namespace declared later.
    if (!isLibrary && unit.options) this.implicitUsings = unit.options.implicitUsings;
    for (const type of declared)
      this.importInto(type.context, (this.namespaceUsings.get(type) ?? []).toReversed(), unit.usings);
    for (const type of declared) this.resolveBases(type);
    this.breakInheritanceCycles(declared);
    const ordered = this.orderByInheritance(declared);
    for (const type of ordered) this.resolveConstraints(type);
    for (const type of ordered) this.declareMembers(type);
    for (const type of ordered) this.assignSlots(type.symbol);
    if (isLibrary) {
      // The library's overrides need their links for virtual calls, though its declarations need no other checks.
      for (const type of ordered) for (const method of type.symbol.methods) this.resolveOverride(method, type.symbol);
      for (const type of ordered)
        for (const property of type.symbol.properties) this.resolvePropertyOverride(property, type.symbol);
      for (const type of ordered) this.checkLibraryInterfaces(type.symbol);
    } else {
      for (const type of ordered) this.checkInheritance(type);
      for (const type of ordered) this.checkAccessibility(type.symbol);
    }
    return ordered;
  }

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  /** Checks that each member's types are at least as accessible as the member, as CS0050 to CS0061 require. */
  private checkAccessibility(symbol: TypeSymbol): void {
    const display = displayTypeSymbol(symbol);
    const check = (
      types: Type[],
      member: Accessibility,
      row: number,
      code: string,
      message: (type: string) => string
    ): void => {
      const limit = effectiveRank(member, symbol);
      const narrower = types.find((type) => typeRank(type) < limit);
      if (narrower) this.error(row, code, `アクセシビリティに一貫性がありません。${message(displayType(narrower))}`);
    };
    if (symbol.baseType && symbol.kind === 'class') {
      check(
        [symbol.baseType],
        symbol.access,
        symbol.row,
        'CS0060',
        (type) => `基底クラス '${type}' のアクセシビリティはクラス '${display}' よりも低く設定されています`
      );
    }
    for (const field of symbol.fields) {
      if (field.property || field.isEvent || field.name.startsWith('<')) continue;
      check(
        [field.type],
        field.access,
        field.row,
        'CS0052',
        (type) =>
          `フィールド型 '${type}' のアクセシビリティはフィールド '${display}.${field.name}' よりも低く設定されています`
      );
    }
    for (const property of symbol.properties) {
      if (property.isIndexer) continue;
      check(
        [property.type],
        property.access,
        property.row,
        'CS0053',
        (type) =>
          `プロパティ型 '${type}' のアクセシビリティはプロパティ '${display}.${property.name}' よりも低く設定されています`
      );
    }
    for (const method of [...symbol.methods, ...symbol.constructors]) {
      if (method.kind !== 'method' && method.kind !== 'constructor') continue;
      const name = displayMethodIn(method, symbol.declaredType);
      if (method.kind === 'method')
        check(
          [method.returnType],
          method.access,
          method.row,
          'CS0050',
          (type) => `戻り値の型 '${type}' のアクセシビリティはメソッド '${name}' よりも低く設定されています`
        );
      check(
        method.parameters.map((parameter) => parameter.type),
        method.access,
        method.row,
        'CS0051',
        (type) => `パラメーター型 '${type}' のアクセシビリティはメソッド '${name}' よりも低く設定されています`
      );
    }
  }

  /** The `using` directives of the namespaces around each type, outermost first. */
  private readonly namespaceUsings = new Map<DeclaredType, UsingLevel[]>();

  private collectMembers(
    members: (TypeDeclaration | NamespaceDeclaration)[],
    namespace: NamespaceSymbol,
    context: TypeContext,
    usingChain: UsingLevel[]
  ): void {
    for (const member of members) {
      if (member.kind === 'namespace') {
        for (const using of member.usings)
          if (using.isGlobal)
            this.error(using, 'CS8914', 'グローバル using ディレクティブを名前空間宣言で使用することはできません。');
        const inner = namespace.resolve(member.name, true) as NamespaceSymbol;
        const namespaces = [
          inner,
          ...this.namespacesAt(namespacePathOf(inner)).filter((candidate) => candidate !== inner),
        ];
        this.collectMembers(member.members, inner, { ...context, namespace: namespaces }, [
          ...usingChain,
          { usings: member.usings, namespace: namespaces },
        ]);
      } else {
        this.declareType(member, namespace, undefined, context, usingChain);
      }
    }
  }

  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private declareType(
    declaration: TypeDeclaration,
    namespace: NamespaceSymbol,
    containing: TypeSymbol | undefined,
    outer: TypeContext,
    usingChain: UsingLevel[]
  ): void {
    if (this.joinsPartialType(declaration, namespace, containing, usingChain)) return;
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

  /**
   * Adds a declaration to an earlier part of the same partial type, telling whether it did; a type declared twice
   * without `partial` on both is left to the duplicate checks, which report CS0260 for the part that lacks it.
   */
  private joinsPartialType(
    declaration: TypeDeclaration,
    namespace: NamespaceSymbol,
    containing: TypeSymbol | undefined,
    usingChain: UsingLevel[]
  ): boolean {
    if (this.isLibraryUnit) return false;
    const arity = declaration.typeParameters.length;
    const existing = containing
      ? containing.nestedTypes.find((other) => other.name === declaration.name && other.typeParameters.length === arity)
      : namespace.types
          .get(declaration.name)
          ?.find((other) => other.typeParameters.length === arity && !other.isLibrary);
    const first = existing && this.declaredTypes.find((type) => type.symbol === existing);
    if (!first) return false;
    const isPartial = declaration.modifiers.set.has('partial');
    const wasPartial = first.declaration.modifiers.set.has('partial');
    if (!isPartial && !wasPartial) return false;
    if (!isPartial || !wasPartial) {
      const lacking = isPartial ? first.declaration : declaration;
      this.error(
        lacking,
        'CS0260',
        `partial 修飾子が型 '${displayTypeSymbol(first.symbol)}' にありません。この型の別の部分宣言が存在します`
      );
      return true;
    }
    joinPartialType(first.declaration, declaration, (position, code, message) => this.error(position, code, message));
    for (const member of declaration.members) {
      if (member.kind === 'type') this.declareType(member, namespace, first.symbol, first.context, usingChain);
    }
    return true;
  }

  private checkTypeModifiers(declaration: TypeDeclaration, containing: TypeSymbol | undefined): void {
    if (declaration.modifiers.set.has('file') && containing)
      this.error(
        declaration,
        'CS9054',
        `ファイル ローカル型 '${displayTypeSymbol(containing)}.${declaration.name}' は、最上位レベルの型で定義する必要があります。'${displayTypeSymbol(containing)}.${declaration.name}' は入れ子にされた型です。`
      );
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
    if (symbol.kind === 'class' && index > 0 && symbol.declaration?.modifiers.set.has('partial') && symbol.baseType) {
      // The parts of a partial class each name a base class of their own.
      this.error(
        symbol.row,
        'CS0263',
        `'${displayTypeSymbol(symbol)}' の partial 宣言では、異なる基底クラスを指定してはいけません`
      );
      return true;
    }
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

  /**
   * Reports each class whose base class leads back to it (CS0146) and each interface that one of its base interfaces
   * leads back to (CS0529), as Roslyn does for every type in the cycle, and then cuts the cycles.
   */
  private breakInheritanceCycles(types: DeclaredType[]): void {
    const cyclicClasses: TypeSymbol[] = [];
    const cyclicInterfaces: [TypeSymbol, NamedType][] = [];
    for (const { symbol, declaration } of types) {
      if (symbol.kind === 'interface') {
        for (const face of symbol.interfaces) {
          if (!reachesInterface(face.symbol, symbol)) continue;
          this.error(
            declaration,
            'CS0529',
            `継承インターフェイス '${displayType(face)}' により、'${displayTypeSymbol(symbol)}' のインターフェイス階層内で循環参照が発生します`
          );
          cyclicInterfaces.push([symbol, face]);
        }
      } else if (symbol.baseType && reachesBase(symbol.baseType.symbol, symbol)) {
        this.error(
          declaration,
          'CS0146',
          `'${displayType(symbol.baseType)}' と '${displayTypeSymbol(symbol)}' を含む、循環する基本データ型の依存関係です`
        );
        cyclicClasses.push(symbol);
      }
    }
    for (const symbol of cyclicClasses) symbol.baseType = this.objectType;
    for (const [symbol, face] of cyclicInterfaces)
      symbol.interfaces = symbol.interfaces.filter((other) => other !== face);
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

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
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
      for (const [index, constraint] of clause.constraints.entries()) {
        if (index > 0 && ['class', 'struct', 'unmanaged', 'notnull', 'default'].includes(constraint.kind)) {
          this.error(
            constraint,
            'CS0449',
            "'class'、'struct'、'unmanaged'、'notnull'、'default' の制約を組み合わせたり、複製したりすることはできません。これらは制約リストの最初に指定する必要があります。"
          );
          continue;
        }
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
          case 'unmanaged': {
            parameter.hasUnmanagedConstraint = true;
            parameter.hasValueConstraint = true;
            break;
          }
          case 'default': {
            // `default` only tells an override's `T?` from a nullable value type, which needs no check at run time.
            const owner = parameter.owner;
            if (!(owner instanceof MethodSymbol) || !(owner.isOverride || owner.explicitInterface))
              this.error(
                constraint,
                'CS8823',
                "'default' 制約は、オーバーライドおよび明示的なインターフェイスの実装メソッドでのみ有効です。"
              );
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
            // A constraint that leads back to its own parameter, as `where T : U where U : T`, is circular (CS0454).
            if (
              constraintType.kind === 'typeParameter' &&
              constrainsBackTo(constraintType.symbol, parameter, new Set())
            ) {
              this.error(
                constraint,
                'CS0454',
                `'${constraintType.symbol.name}' と '${parameter.name}' を含む、循環制約の依存関係です`
              );
              break;
            }
            if (constraintType.kind !== 'error') parameter.constraintTypes.push(constraintType);
            break;
          }
        }
      }
    }
  }

  // code-gauge-allow functionNcss -- One case per kind of member declaration.
  // code-gauge-allow functionCognitiveComplexity -- One case per kind of member declaration.
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
    if (!this.isLibraryUnit)
      joinPartialMembers(declaration, (position, code, message) => this.error(position, code, message));
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
        case 'eventAccessors': {
          this.declareEventAccessors(type, member);
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
    if (!this.isLibraryUnit) this.checkOperatorPairs(symbol);
    if (symbol.isRecord) this.declareRecordMembers(type);
    this.declareImplicitConstructors(type);
  }

  /** Reports CS0216 for an operator declared without its pair, as `==` without `!=` with the same operand types. */
  private checkOperatorPairs(symbol: TypeSymbol): void {
    const operators = symbol.methods.filter((method) => method.kind === 'operator');
    for (const method of operators) {
      const pair = method.operatorToken ? OPERATOR_PAIRS[method.operatorToken] : undefined;
      if (!pair) continue;
      const hasPair = operators.some(
        (other) =>
          other.operatorToken === pair &&
          other.parameters.length === method.parameters.length &&
          other.parameters.every((parameter, index) => sameType(parameter.type, method.parameters[index].type))
      );
      if (!hasPair)
        this.error(
          method.row ?? 0,
          'CS0216',
          `演算子 '${displayMethod(method)}' を定義するには、合致する演算子 '${pair}' が必要です`
        );
    }
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
    field.isRequired = member.modifiers.set.has('required');
    if (field.isRequired) this.checkRequiredAccess(field, declarator);
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
        `'${displayTypeSymbol(symbol)}.${declarator.name}': 静的クラスでインスタンスのメンバーを宣言することはできません`
      );
    if (field.isConst && member.modifiers.set.has('static'))
      this.error(
        declarator,
        'CS0504',
        `定数 '${displayTypeSymbol(symbol)}.${declarator.name}' を static に設定することはできません`
      );
    if (member.modifiers.set.has('volatile')) this.checkVolatile(declarator, field);
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

  /** Reports a required member less accessible than its type, which code creating the type could not set (CS9032). */
  private checkRequiredAccess(member: FieldSymbol | PropertySymbol, position: Position): void {
    if (ACCESS_RANKS[member.access] >= ACCESS_RANKS[member.owner.access]) return;
    this.error(
      position,
      'CS9032',
      `必要なメンバー '${displayTypeSymbol(member.owner)}.${member.name}' の表示を減らす、また含まれる型の '${displayTypeSymbol(member.owner)}' より小さいセッターの表示を設定することはできません。`
    );
  }

  /** Checks a volatile field's type, which must be read and written atomically (C# spec §15.5.4). */
  private checkVolatile(declarator: VariableDeclarator, field: FieldSymbol): void {
    const display = `${displayTypeSymbol(field.owner)}.${declarator.name}`;
    if (field.isReadonly)
      this.error(
        declarator,
        'CS0678',
        `'${display}': フィールドに volatile と readonly の両方を指定することはできません`
      );
    const { type } = field;
    const special = type.kind === 'named' ? (type.symbol.enumUnderlying ?? type).symbol.special : undefined;
    const allowed =
      isReferenceType(type) ||
      (type.kind === 'named' &&
        ['sbyte', 'byte', 'short', 'ushort', 'int', 'uint', 'char', 'float', 'bool'].includes(special ?? ''));
    if (!allowed && type.kind !== 'error')
      this.error(
        declarator,
        'CS0677',
        `'${display}': volatile フィールドの型を '${displayType(type)}' にすることはできません`
      );
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

  /** Reports an explicit implementation of a member that its interface lacks (CS0539). */
  private checkExplicitImplementation(symbol: TypeSymbol, method: MethodSymbol): void {
    const face = method.explicitInterface;
    if (!face || method.property || method.isEventAccessor) return;
    const exists = [...this.allInterfaces(face), face].some((owner) =>
      owner.symbol.methods.some(
        (member) => member.name === method.name && this.sameParameters(member, method, owner, symbol.declaredType)
      )
    );
    if (!exists)
      this.error(
        method.row,
        'CS0539',
        `明示的なインターフェイス宣言内の '${displayTypeSymbol(symbol)}.${method.name}(${method.parameters.map((parameter) => displayType(parameter.type)).join(', ')})' が、実装可能なインターフェイスのメンバーの中に見つかりません`
      );
  }

  /**
   * Resolves the interface of an explicit implementation, reporting a type that is no interface (CS0538), one the
   * containing type does not implement (CS0540), and the access modifiers explicit implementations may not have (CS0106).
   */
  private explicitInterfaceOf(
    { symbol, context }: DeclaredType,
    member: MethodDeclaration | PropertyDeclaration | IndexerDeclaration | EventAccessorDeclaration,
    node: TypeNode,
    /** The member's name after the interface's, with its parameter types for a method. */
    describe: () => string
  ): NamedType | undefined {
    const face = this.resolveType(node, context);
    const modifier = (['public', 'private', 'protected', 'internal', 'virtual', 'override', 'abstract'] as const).find(
      (candidate) => member.modifiers.set.has(candidate)
    );
    if (modifier && symbol.kind !== 'interface')
      this.error(member, 'CS0106', `修飾子 '${modifier}' がこの項目に対して有効ではありません`);
    if (face.kind === 'error') return undefined;
    if (face.kind !== 'named' || face.symbol.kind !== 'interface') {
      this.error(
        node,
        'CS0538',
        `明示的なインターフェイス宣言内の '${displayType(face)}' はインターフェイスではありません`
      );
      return undefined;
    }
    if (!this.allInterfaces(symbol.declaredType).some((implemented) => sameType(implemented, face))) {
      this.error(
        member,
        'CS0540',
        `'${displayTypeSymbol(symbol)}.${displayType(face)}.${describe()}': 含む型は、インターフェイス '${displayType(face)}' を実装しません`
      );
      return undefined;
    }
    return face;
  }

  /** Declares an event with `add` and `remove` accessors, which `+=` and `-=` call in place of a delegate field. */
  private declareEventAccessors(type: DeclaredType, member: EventAccessorDeclaration): void {
    const { symbol, context } = type;
    const field = new FieldSymbol(member.name, this.resolveType(member.type, context), symbol);
    field.isEvent = true;
    field.isStatic = member.modifiers.set.has('static');
    field.access = accessibilityOf(member.modifiers, symbol.kind === 'interface' ? 'public' : 'private');
    field.row = member.row;
    field.column = member.column;
    const explicitInterface = member.explicitInterface
      ? this.explicitInterfaceOf(type, member, member.explicitInterface, () => member.name)
      : undefined;
    if (explicitInterface) field.access = 'private';
    if (!member.add || !member.remove)
      this.error(
        member,
        'CS0065',
        `'${displayTypeSymbol(symbol)}.${member.name}': イベント プロパティには、add および remove アクセサーの両方を指定する必要があります`
      );
    const accessor = (kind: 'add' | 'remove', body: EventAccessorDeclaration['add']): MethodSymbol => {
      const method = new MethodSymbol(`${kind}_${member.name}`, symbol, 'method');
      method.isEventAccessor = true;
      method.isStatic = field.isStatic;
      method.isVirtual = member.modifiers.set.has('virtual');
      method.isOverride = member.modifiers.set.has('override');
      method.isAbstract = member.modifiers.set.has('abstract');
      method.access = field.access;
      method.explicitInterface = explicitInterface;
      method.row = member.row;
      method.parameters = [{ name: 'value', type: field.type, refKind: undefined, isParams: false }];
      method.declaration = body ? ({ kind: 'method', body, bodyRow: member.row, row: member.row } as never) : undefined;
      this.methodContexts.set(method, context);
      symbol.methods.push(method);
      return method;
    };
    field.eventAccessors = { add: accessor('add', member.add), remove: accessor('remove', member.remove) };
    this.addMember(symbol, field, member);
    symbol.fields.push(field);
  }

  private declareMethodMember(type: DeclaredType, member: MethodDeclaration): void {
    const { symbol, context } = type;
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
    method.isRemovedPartial = member.isRemovedPartial === true;
    const methodContext = this.methodContexts.get(method) as TypeContext;
    method.returnType = this.resolveType(member.returnType, methodContext);
    method.parameters = this.resolveParameters(member.parameters, methodContext, method);
    method.isExtension = member.parameters[0]?.isThis === true;
    if (member.explicitInterface) {
      method.explicitInterface = this.explicitInterfaceOf(
        type,
        member,
        member.explicitInterface,
        () => `${member.name}(${method.parameters.map((parameter) => displayType(parameter.type)).join(', ')})`
      );
      method.access = 'private';
      method.isAbstract = false;
      method.isVirtual = false;
    }
    this.attachNative(method, member.body === undefined);
    this.checkMethodBody(method, member.body !== undefined, member);
    if (method.name === symbol.name)
      this.error(member, 'CS0542', `'${member.name}': メンバー名をそれを囲む型の名前と同じにすることはできません`);
    this.addMethod(symbol, method, member);
  }

  /** Checks where an extension method's `this` parameter may stand (C# spec §15.6.10). */
  private checkExtensionReceiver(parameter: Parameter, type: Type, method: MethodSymbol, index: number): void {
    const owner = method.owner;
    if (index > 0) {
      this.error(
        parameter,
        'CS1100',
        `メソッド '${method.name}' には、最初のパラメーターではないパラメーター修飾子 'this' が指定されています`
      );
    } else if (!owner.isStatic || owner.typeParameters.length > 0 || method.kind === 'localFunction') {
      this.error(owner.row, 'CS1106', '拡張メソッドは、非ジェネリック静的クラスで定義される必要があります');
    } else if (owner.containing) {
      this.error(
        parameter,
        'CS1109',
        `拡張メソッドは、トップ レベルの静的クラスで定義される必要があります。${owner.name} は入れ子にされたクラスです`
      );
    } else if (!method.isStatic) {
      this.error(parameter, 'CS1105', '拡張メソッドはスタティックでなければなりません');
    } else if (parameter.modifier === 'ref' && !isValueType(type)) {
      this.error(
        parameter,
        'CS8337',
        `ref' 拡張メソッド '${method.name}' の最初のパラメーターは、値型または構造体に制限されたジェネリック型でなければなりません。`
      );
    }
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

  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private declareProperty(
    type: DeclaredType,
    member: Extract<TypeDeclaration['members'][number], { kind: 'property' | 'indexer' }>
  ): void {
    const { symbol, context } = type;
    const isIndexer = member.kind === 'indexer';
    const name = isIndexer ? 'Item' : member.name;
    const shownName = isIndexer ? 'this' : name;
    const property = new PropertySymbol(name, this.resolveType(member.type, context), symbol, isIndexer);
    const modifiers = member.modifiers.set;
    property.isStatic = modifiers.has('static');
    property.access = accessibilityOf(member.modifiers, symbol.kind === 'interface' ? 'public' : 'private');
    property.isVirtual = modifiers.has('virtual');
    property.isAbstract = modifiers.has('abstract') || (symbol.kind === 'interface' && !modifiers.has('static'));
    property.isOverride = modifiers.has('override');
    property.isRequired = modifiers.has('required');
    if (member.explicitInterface) {
      property.explicitInterface = this.explicitInterfaceOf(type, member, member.explicitInterface, () => shownName);
      property.access = 'private';
      property.isAbstract = false;
    }
    if (property.isRequired) this.checkRequiredAccess(property, member);
    if (
      (property.isVirtual || property.isAbstract || property.isOverride) &&
      property.access === 'private' &&
      symbol.kind !== 'interface' &&
      !this.isLibraryUnit
    ) {
      const shown = isIndexer ? 'this' : name;
      this.error(
        member,
        'CS0621',
        `'${displayTypeSymbol(symbol)}.${shown}': 仮想または抽象メンバーには、private を指定できません`
      );
    }
    if (modifiers.has('sealed') && !property.isOverride && symbol.kind !== 'interface' && !this.isLibraryUnit) {
      const shown = isIndexer ? 'this' : name;
      this.error(
        member,
        'CS0238',
        `'${displayTypeSymbol(symbol)}.${shown}' はオーバーライドではないため、シールドにできません`
      );
    }
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
    // A body makes an interface property its default implementation, which is virtual, not abstract.
    if (symbol.kind === 'interface' && hasBodies && !modifiers.has('abstract')) {
      property.isAbstract = false;
      property.isVirtual = !property.isStatic && property.access !== 'private' && !modifiers.has('sealed');
    }
    const isAuto =
      !this.isLibraryUnit &&
      member.kind === 'property' &&
      !member.isExpressionBodied &&
      !hasBodies &&
      !property.isAbstract &&
      (symbol.kind !== 'interface' || property.isStatic);
    if (member.kind === 'property' && member.initializer && !isAuto) {
      this.error(
        member,
        'CS8050',
        `自動実装プロパティ、または 'field' キーワードを使用するプロパティのみが初期化子を持つことができます。`
      );
    }
    if (isAuto) this.declareBackingField(symbol, property, member);
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

  private declareBackingField(
    symbol: TypeSymbol,
    property: PropertySymbol,
    member: Extract<TypeDeclaration['members'][number], { kind: 'property' }>
  ): void {
    const field = new FieldSymbol(`<${property.name}>k__BackingField`, property.type, symbol);
    field.isStatic = property.isStatic;
    field.isReadonly = !member.accessors.some((accessor) => accessor.kind === 'set');
    field.property = property;
    field.initializer = member.initializer;
    field.row = member.row;
    field.column = member.column;
    property.backingField = field;
    symbol.fields.push(field);
    if (symbol.isStatic && !property.isStatic)
      this.error(
        member,
        'CS0708',
        `'${displayTypeSymbol(symbol)}.${property.name}': 静的クラスでインスタンスのメンバーを宣言することはできません`
      );
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
    method.explicitInterface = property.explicitInterface;
    if (accessModifierCount(accessor.modifiers) > 0) {
      method.access = accessibilityOf(accessor.modifiers, property.access);
      this.checkAccessorAccessibility(accessor, method, property, symbol);
    } else {
      method.access = property.access;
    }
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

  private checkAccessorAccessibility(
    accessor: Accessor,
    method: MethodSymbol,
    property: PropertySymbol,
    symbol: TypeSymbol
  ): void {
    if (this.isLibraryUnit) return;
    if (method.access !== property.access && ACCESS_RANKS[method.access] <= ACCESS_RANKS[property.access]) return;
    const shown = `${displayTypeSymbol(symbol)}.${property.isIndexer ? 'this' : property.name}`;
    this.error(
      accessor,
      'CS0273',
      `'${shown}.${accessor.kind === 'get' ? 'get' : 'set'}' アクセサーのアクセシビリティ修飾子は、プロパティまたはインデクサー '${shown}' よりも制限されていなければなりません`
    );
  }

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one kind of operator declaration.
  private declareOperator(
    type: DeclaredType,
    member: Extract<TypeDeclaration['members'][number], { kind: 'operator' }>
  ): void {
    const { symbol, context } = type;
    const isUnary = member.parameters.length === 1;
    const assignmentName = ASSIGNMENT_OPERATOR_NAMES[member.operator];
    if (member.operator.endsWith('=') && assignmentName && member.modifiers.set.has('static')) {
      this.error(member, 'CS1020', 'オーバーロード可能な 2 項演算子が必要です');
      return;
    }
    // C# 14's compound assignment and `++`/`--` operators are instance methods that change the operand in place.
    const isInstanceAssignment =
      assignmentName !== undefined &&
      !member.modifiers.set.has('static') &&
      member.parameters.length === (member.operator === '++' || member.operator === '--' ? 0 : 1);
    const regularName = isInstanceAssignment
      ? assignmentName
      : ((isUnary ? UNARY_OPERATOR_NAMES[member.operator] : undefined) ?? OPERATOR_NAMES[member.operator]);
    const name = member.isChecked ? checkedOperatorName(regularName) : regularName;
    const method = this.declareMethod(symbol, name, 'operator', member.modifiers, member, context);
    method.operatorToken = member.operator;
    method.declaration = member;
    method.returnType = this.resolveType(member.returnType, context);
    method.parameters = this.resolveParameters(member.parameters, context, method);
    const signature = `${displayTypeSymbol(symbol)}.operator ${member.operator}(${method.parameters.map((parameter) => displayType(parameter.type)).join(', ')})`;
    if (isInstanceAssignment) {
      if (!member.modifiers.set.has('public'))
        this.error(member, 'CS9308', `ユーザー定義演算子 '${signature}' は公開用として宣言する必要があります`);
      if (method.returnType.kind !== 'void')
        this.error(member.returnType, 'CS9310', 'この演算子の戻り値の型は void である必要があります');
    } else if (method.access !== 'public' || !method.isStatic) {
      this.error(
        member,
        'CS0558',
        `ユーザー定義の演算子 '${signature}' は static および public として宣言されなければなりません`
      );
    }
    const ownType = symbol.declaredType;
    // An interface's static abstract operator may take a type parameter that the interface constrains to itself.
    const isOwn = (candidate: Type): boolean =>
      sameType(candidate, ownType) ||
      sameType(candidate, this.nullableOf(ownType)) ||
      (symbol.kind === 'interface' &&
        candidate.kind === 'typeParameter' &&
        candidate.symbol.owner === symbol &&
        candidate.symbol.constraintTypes.some(
          (constraint) => constraint.kind === 'named' && constraint.symbol === symbol
        ));
    if (member.operator === 'implicit' || member.operator === 'explicit') {
      this.checkConversionOperator(symbol, method, member);
    } else if (!isInstanceAssignment && !method.parameters.some((parameter) => isOwn(parameter.type))) {
      const code = isUnary ? 'CS0562' : 'CS0563';
      const what = isUnary ? '単項演算子のパラメーター' : '二項演算子のパラメーターのうち 1 つ';
      this.error(member, code, `${what}は、それを含んでいる型でなければなりません`);
    }
    this.attachNative(method, member.body === undefined);
    this.addMethod(symbol, method, member);
  }

  /** Checks a conversion operator's types (C# spec §15.10.4), and that the type declares no other between them. */
  private checkConversionOperator(symbol: TypeSymbol, method: MethodSymbol, position: Position): void {
    const ownType = symbol.declaredType;
    const source = withoutNullable(method.parameters[0]?.type ?? ERROR_TYPE);
    const target = withoutNullable(method.returnType);
    const signature = `${displayTypeSymbol(symbol)}.${method.name === 'op_Implicit' ? 'implicit' : 'explicit'} operator ${displayType(method.returnType)}(${method.parameters.map((parameter) => displayType(parameter.type)).join(', ')})`;
    if (!sameType(source, ownType) && !sameType(target, ownType)) {
      this.error(position, 'CS0556', 'ユーザー定義の変換では、それを囲む型に/から変換しなければなりません');
      return;
    }
    if (sameType(source, target)) {
      this.error(position, 'CS0555', 'ユーザー定義の演算子は、型をそれ自体に変換することはできません。');
      return;
    }
    const other = sameType(source, ownType) ? target : source;
    if (other.kind === 'named' && other.symbol.kind === 'interface') {
      this.error(
        position,
        'CS0552',
        `'${signature}': インターフェイスとの間におけるユーザー定義の変換は許可されていません`
      );
      return;
    }
    if (other.kind === 'named' && (derivesFromClass(symbol, other.symbol) || derivesFromClass(other.symbol, symbol))) {
      this.error(
        position,
        'CS0553',
        `'${signature}': 基本データ型との間におけるユーザー定義の変換は許可されていません`
      );
      return;
    }
    const isConversion = (candidate: MethodSymbol): boolean =>
      (candidate.name === 'op_Implicit' || candidate.name === 'op_Explicit') &&
      sameType(candidate.returnType, method.returnType) &&
      sameType(candidate.parameters[0]?.type ?? ERROR_TYPE, method.parameters[0]?.type ?? ERROR_TYPE);
    if (symbol.methods.some(isConversion))
      this.error(position, 'CS0557', `型 '${displayTypeSymbol(symbol)}' で重複するユーザー定義の変換です`);
  }

  // code-gauge-allow functionParameterCount -- The values that the operation needs, which share no object.
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
    method.isAbstract =
      set.has('abstract') ||
      (symbol.kind === 'interface' && !set.has('static') && !set.has('sealed') && !set.has('private'));
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

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
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
      method.access === 'private' &&
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
    if (method.isSealed && !method.isOverride && method.owner.kind !== 'interface')
      this.error(position, 'CS0238', `'${display()}' はオーバーライドではないため、シールドにできません`);
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
      // A body makes an interface member its default implementation (C# spec §19.4), which classes need not write.
      if (
        hasBody &&
        method.isAbstract &&
        !(method.declaration && 'modifiers' in method.declaration && method.declaration.modifiers.set.has('abstract'))
      ) {
        method.isAbstract = false;
        method.isVirtual = method.access !== 'private' && !method.isSealed && !method.isStatic;
      } else if (hasBody && method.isAbstract) {
        this.error(
          position,
          'CS0500',
          `'${displayMethod(method)}' は abstract に指定されているため本体を宣言できません`
        );
      } else if (!hasBody && !method.isAbstract) {
        this.error(
          position,
          'CS0501',
          `'${displayMethod(method)}' は abstract、extern、または partial に指定されていないため、本体を宣言する必要があります`
        );
      }
      return;
    }
    if (!hasBody && !method.isAbstract && !method.isExtern && !method.isRemovedPartial) {
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

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
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
      if (!parameter.defaultValue && parameter.modifier !== 'params' && result.some((other) => other.defaultSyntax))
        this.error(parameter, 'CS1737', '省略可能なパラメーターはすべての必須パラメーターの後で指定する必要があります');
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
      if (parameter.isThis && method) this.checkExtensionReceiver(parameter, type, method, index);
      result.push({
        name: parameter.name,
        type,
        refKind:
          parameter.modifier === 'ref' || parameter.modifier === 'out' || parameter.modifier === 'in'
            ? parameter.modifier
            : undefined,
        isParams: parameter.modifier === 'params',
        defaultSyntax: parameter.defaultValue,
        defaultContext: parameter.defaultValue ? context : undefined,
        position: parameter,
      });
    }
    return result;
  }

  /** Declares the members that the compiler gives a record. */
  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
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
      ...symbol.methods.filter((method) => method.name === name && !method.explicitInterface),
      ...symbol.properties.filter(
        (property) => property.name === name && !property.isIndexer && !property.explicitInterface
      ),
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
    // An explicit implementation's name is its interface's member's, apart from the type's own members.
    if (method.explicitInterface) {
      const face = method.explicitInterface;
      const duplicate = symbol.methods.find(
        (other) =>
          other.name === method.name &&
          other.explicitInterface !== undefined &&
          sameType(other.explicitInterface, face) &&
          this.sameParameters(other, method)
      );
      if (duplicate) {
        const display = `${displayType(face)}.${method.name}(${method.parameters.map((parameter) => displayType(parameter.type)).join(', ')})`;
        this.error(symbol.row, 'CS8646', `'${display}' が複数回、明示的に実装されています。`);
        this.error(
          position,
          'CS0111',
          `型 '${displayTypeSymbol(symbol)}' は、'${displayType(face)}.${method.name}' と呼ばれるメンバーを同じパラメーターの型で既に定義しています`
        );
      }
      symbol.methods.push(method);
      return;
    }
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
    const aSubstitution = this.methodSubstitution(a, b, aOwner);
    const bSubstitution = new Map(bOwner ? substitutionOf(bOwner) : []);
    return a.parameters.every((parameter, index) => {
      const other = b.parameters[index];
      return (
        (parameter.refKind === undefined) === (other.refKind === undefined) &&
        sameType(substitute(parameter.type, aSubstitution), substitute(other.type, bSubstitution))
      );
    });
  }

  /** The substitution that maps a method's owner's and its own type parameters onto those of a method it matches. */
  private methodSubstitution(
    method: MethodSymbol,
    matched: MethodSymbol,
    owner?: NamedType
  ): Map<TypeParameterSymbol, Type> {
    const substitution = new Map(owner ? substitutionOf(owner) : []);
    for (const [index, parameter] of method.typeParameters.entries())
      substitution.set(parameter, matched.typeParameters[index].type);
    return substitution;
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

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private checkInheritance(type: DeclaredType): void {
    const { symbol } = type;
    if (symbol.kind !== 'class' && symbol.kind !== 'struct') return;
    for (const method of symbol.methods) this.resolveOverride(method, symbol);
    for (const property of symbol.properties) this.resolvePropertyOverride(property, symbol);
    for (const method of symbol.methods) this.checkExplicitImplementation(symbol, method);
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
        if ((member.isStatic && !member.isAbstract) || member.property || member.isEventAccessor) continue;
        if (!this.findImplementation(symbol.declaredType, member, face)) this.reportUnimplemented(symbol, member, face);
      }
      for (const property of face.symbol.properties) this.checkPropertyImplementation(symbol, property, face);
    }
  }

  /**
   * A library class implements each member of its interfaces by a method of the same name and parameter types, the
   * one the runtime dispatches an interface call to, so no call through an interface reaches an abstract member.
   */
  private checkLibraryInterfaces(symbol: TypeSymbol): void {
    if ((symbol.kind !== 'class' && symbol.kind !== 'struct') || symbol.isAbstract) return;
    for (const face of this.allInterfaces(symbol.declaredType)) {
      const accessors = face.symbol.properties.flatMap((property) => [property.getter, property.setter]);
      for (const member of [...face.symbol.methods, ...accessors]) {
        if (!member || member.isStatic || !member.isAbstract) continue;
        if (!this.libraryImplementation(symbol.declaredType, member, face))
          this.error(
            symbol.row,
            'CS0535',
            `'${displayTypeSymbol(symbol)}' does not implement '${displayTypeSymbol(face.symbol, face.args)}.${member.name}(${member.parameters.map((parameter) => displayType(parameter.type)).join(', ')})'`
          );
      }
    }
  }

  private libraryImplementation(type: NamedType, member: MethodSymbol, face: NamedType): MethodSymbol | undefined {
    const wanted = member.parameters.map((parameter) => substitute(parameter.type, substitutionOf(face)));
    for (let current: NamedType | undefined = type; current; current = baseTypeOf(current)) {
      const substitution = substitutionOf(current);
      const accessors = current.symbol.properties.flatMap((property) => [property.getter, property.setter]);
      const found = [...current.symbol.methods, ...accessors].find(
        (candidate): candidate is MethodSymbol =>
          candidate !== undefined &&
          candidate.name === member.name &&
          !candidate.isStatic &&
          candidate.typeParameters.length === member.typeParameters.length &&
          candidate.parameters.length === wanted.length &&
          candidate.parameters.every((parameter, index) =>
            sameType(substitute(parameter.type, substitution), wanted[index])
          )
      );
      if (found) return found.isAbstract || !found.native ? undefined : found;
    }
    return undefined;
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

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
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
      // An override may return a type with an implicit reference conversion to the base's return type (C# 9).
      if (
        !sameType(expectedReturn, method.returnType) &&
        !(
          isReferenceType(method.returnType) &&
          this.conversions.isReferenceConvertible(method.returnType, expectedReturn)
        ) &&
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
      const substitution = substitutionOf(current);
      const candidate = current.symbol.properties.find((other) =>
        isSameProperty(other, substitution, property, new Map())
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
      const baseType = substitute(candidate.type, substitution);
      // A get-only property may override a get-only one with a more derived reference type (covariant return); any
      // other must match.
      const isCovariant =
        !property.setter &&
        !this.accessorOf(candidate, 'setter') &&
        isReferenceType(property.type) &&
        isReferenceType(baseType) &&
        this.conversions.isReferenceConvertible(property.type, baseType);
      if (!sameType(property.type, baseType) && !isCovariant && property.type.kind !== 'error') {
        this.error(
          property.row,
          'CS1715',
          `'${displayTypeSymbol(symbol)}.${property.name}': オーバーライドされたメンバー '${displayTypeSymbol(current.symbol, current.args)}.${candidate.name}' に対応するために、型は '${displayType(baseType)}' でなければなりません`
        );
        return;
      }
      property.overridden = candidate;
      const overriddenSetter = this.accessorOf(candidate, 'setter');
      if (property.setter && overriddenSetter && property.isInitOnly !== overriddenSetter.property?.isInitOnly)
        this.error(
          property.row,
          'CS8853',
          `'${displayTypeSymbol(symbol)}.${property.name}' は、オーバーライドされたメンバー '${displayTypeSymbol(current.symbol, current.args)}.${candidate.name}' の init 専用と一致する必要があります`
        );
      for (const [kind, keyword, code] of [
        ['getter', 'get', 'CS0545'],
        ['setter', 'set', 'CS0546'],
      ] as const) {
        const accessor = property[kind];
        if (!accessor) continue;
        accessor.overridden = this.accessorOf(candidate, kind);
        if (!accessor.overridden)
          this.error(
            property.row,
            code,
            `'${displayTypeSymbol(symbol)}.${property.name}.${keyword}': '${displayTypeSymbol(current.symbol, current.args)}.${candidate.name}' にオーバーライド可能な ${keyword} アクセサーがないため、オーバーライドできません`
          );
      }
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
      // The class's own abstract members are CS0513 instead, as are those of a base class that is not abstract.
      const isOwn = current.symbol === symbol || !current.symbol.isAbstract;
      for (const method of current.symbol.methods) {
        if (method.isAbstract && !isOwn && !implemented.has(method)) missing.push(displayMethodIn(method, current));
        addOverriddenChain(method, implemented);
      }
      for (const property of current.symbol.properties) {
        // An override implements only the accessors it declares, so each abstract accessor is checked on its own.
        for (const accessor of [property.getter, property.setter]) {
          if (!accessor) continue;
          if (property.isAbstract && !isOwn && !implemented.has(accessor))
            missing.push(displayAccessorIn(property, accessor, current));
          addOverriddenChain(accessor, implemented);
        }
      }
    }
    return missing;
  }

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
          method.isStatic === member.isStatic &&
          !method.explicitInterface &&
          (method.kind === 'method' || method.kind === 'operator') &&
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

  /**
   * The method of a class or its bases that implements an interface's method (C# spec §19.6.5): an explicit
   * implementation first, then a public method of the same signature, static for a static abstract member, and else the
   * interface's own default body.
   */
  findImplementation(type: NamedType, member: MethodSymbol, face: NamedType): MethodSymbol | undefined {
    const matches = (method: MethodSymbol, current: NamedType): boolean =>
      method.name === member.name &&
      method.isStatic === member.isStatic &&
      (method.kind === 'method' || method.kind === 'operator') &&
      this.sameParameters(method, member, current, face) &&
      sameType(
        substitute(method.returnType, this.methodSubstitution(method, member, current)),
        substitute(member.returnType, substitutionOf(face))
      );
    for (let current: NamedType | undefined = type; current; current = baseTypeOf(current)) {
      const owner = current;
      const explicit = owner.symbol.methods.find(
        (method) =>
          method.explicitInterface !== undefined && sameType(method.explicitInterface, face) && matches(method, owner)
      );
      if (explicit) return explicit;
      const candidate = owner.symbol.methods.find((method) => !method.explicitInterface && matches(method, owner));
      if (candidate) return candidate.access === 'public' || owner.symbol.isLibrary ? candidate : undefined;
    }
    return member.isAbstract ? undefined : member;
  }

  /**
   * Reports an interface property that a class does not implement: as a whole when no property of its name and type
   * matches, else each accessor the match lacks (CS0535) or does not make public (CS0277), as Roslyn names them.
   */
  private checkPropertyImplementation(symbol: TypeSymbol, member: PropertySymbol, face: NamedType): void {
    const memberName = `${displayTypeSymbol(face.symbol, face.args)}.${member.isIndexer ? `this[${member.parameters.map((parameter) => displayType(substitute(parameter.type, substitutionOf(face)))).join(', ')}]` : member.name}`;
    const missing = (name: string): void =>
      this.error(
        symbol.row,
        'CS0535',
        `'${displayTypeSymbol(symbol)}' はインターフェイス メンバー '${name}' を実装しません`
      );
    // A property with a default body, and a static one without `abstract`, need no implementation.
    if (!member.isAbstract) return;
    for (let current: NamedType | undefined = symbol.declaredType; current; current = baseTypeOf(current)) {
      const substitution = substitutionOf(current);
      const explicit = current.symbol.properties.find(
        (property) =>
          property.explicitInterface !== undefined &&
          sameType(property.explicitInterface, face) &&
          isSameProperty(property, substitution, member, substitutionOf(face))
      );
      if (explicit) return;
      const candidate = current.symbol.properties.find(
        (property) =>
          property.isStatic === member.isStatic &&
          !property.explicitInterface &&
          isSameProperty(property, substitution, member, substitutionOf(face))
      );
      if (!candidate) continue;
      const expected = substitute(member.type, substitutionOf(face));
      if (!sameType(substitute(candidate.type, substitution), expected)) {
        const closeText = `${displayTypeSymbol(current.symbol, current.args)}.${candidate.isIndexer ? 'this[]' : candidate.name}`;
        this.error(
          symbol.row,
          'CS0738',
          `'${displayTypeSymbol(symbol)}' は、インターフェイス メンバー '${memberName}' を実装していません。'${closeText}' は一致する '${displayType(expected)}' の戻り値の型を持たないため、'${memberName}' を実装できません。`
        );
        return;
      }
      for (const [kind, keyword] of [
        ['getter', 'get'],
        ['setter', 'set'],
      ] as const) {
        if (!member[kind]) continue;
        const accessor = candidate[kind];
        const candidateName = `${displayTypeSymbol(current.symbol, current.args)}.${candidate.isIndexer ? 'this[]' : candidate.name}`;
        if (!accessor) missing(`${memberName}.${keyword}`);
        else if (kind === 'setter' && candidate.isInitOnly !== member.isInitOnly) {
          const [wanted, given] = member.isInitOnly ? ['init', 'set'] : ['set', 'init'];
          this.error(
            symbol.row,
            'CS8854',
            `'${displayTypeSymbol(symbol)}' はインターフェイス メンバー '${memberName}.${wanted}' を実装しません。'${candidateName}.${given}' は '${memberName}.${wanted}' を実装できません。`
          );
        } else if (accessor.access !== 'public')
          this.error(
            symbol.row,
            'CS0277',
            `'${displayTypeSymbol(symbol)}' はインターフェイス メンバー '${memberName}.${keyword}' を実装しません。'${displayTypeSymbol(current.symbol, current.args)}.${candidate.isIndexer ? 'this[]' : candidate.name}.${keyword}' はパブリックではありません。`
          );
      }
      return;
    }
    missing(memberName);
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

/**
 * Whether two properties have the same name and parameter types, each under its substitution, as an indexer overrides
 * or implements the one of the same parameter types among the overloads.
 */
function isSameProperty(
  property: PropertySymbol,
  substitution: Substitution,
  other: PropertySymbol,
  otherSubstitution: Substitution
): boolean {
  return (
    property.name === other.name &&
    property.isIndexer === other.isIndexer &&
    property.parameters.length === other.parameters.length &&
    property.parameters.every((parameter, index) =>
      sameType(substitute(parameter.type, substitution), substitute(other.parameters[index].type, otherSubstitution))
    )
  );
}

function accessModifierCount(modifiers: Modifiers): number {
  return ['public', 'private', 'protected', 'internal'].filter((modifier) => modifiers.set.has(modifier as never))
    .length;
}

function accessibilityText(access: Accessibility): string {
  return access;
}

/**
 * A method as Roslyn's diagnostics name it, such as `A.M(int)`. With `isFull`, as its ambiguity errors do, the
 * parameters carry `params` and their types' namespaces.
 */
export function displayMethodIn(method: MethodSymbol, owner: NamedType, isFull = false): string {
  const substitution = substitutionOf(owner);
  const parameters = method.parameters
    .map(
      (parameter) =>
        `${parameter.refKind ? `${parameter.refKind} ` : ''}${isFull && parameter.isParams ? 'params ' : ''}${displayType(substitute(parameter.type, substitution), isFull)}`
    )
    .join(', ');
  if (method.kind === 'getter' || method.kind === 'setter' || method.kind === 'localFunction')
    return displayMethod(method);
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

function displayAccessorIn(property: PropertySymbol, accessor: MethodSymbol, owner: NamedType): string {
  return `${displayTypeSymbol(owner.symbol, owner.args)}.${property.name}.${accessor === property.getter ? 'get' : 'set'}`;
}

/** The operators C# requires to be declared together. */
/** Whether a type has a class among its bases, which the declarations know before the binders can tell. */
function derivesFromClass(type: TypeSymbol, base: TypeSymbol): boolean {
  for (let current = type.baseType; current; current = current.symbol.baseType)
    if (current.symbol === base) return true;
  return false;
}

const OPERATOR_PAIRS: Record<string, string> = {
  '==': '!=',
  '!=': '==',
  '<': '>',
  '>': '<',
  '<=': '>=',
  '>=': '<=',
  true: 'false',
  false: 'true',
};

const ACCESS_RANKS: Record<Accessibility, number> = {
  private: 0,
  'private protected': 1,
  protected: 2,
  internal: 2,
  'protected internal': 3,
  public: 4,
};

/** How widely code can reach a member of a type: no wider than the type and the types around it. */
function effectiveRank(access: Accessibility, owner: TypeSymbol | undefined): number {
  let rank = ACCESS_RANKS[access];
  for (let current = owner; current; current = current.containing) rank = Math.min(rank, ACCESS_RANKS[current.access]);
  return rank;
}

/** How widely code can reach a type, through its own accessibility and its type arguments' and elements'. */
function typeRank(type: Type): number {
  if (type.kind === 'array') return typeRank(type.element);
  if (type.kind !== 'named' || type.symbol.isLibrary)
    return type.kind === 'named' ? Math.min(4, ...type.args.map(typeRank)) : 4;
  return Math.min(effectiveRank(type.symbol.access, type.symbol.containing), ...type.args.map(typeRank));
}

/** Whether a class's chain of base classes from a type reaches a type. */
function reachesBase(start: TypeSymbol, target: TypeSymbol): boolean {
  const seen = new Set<TypeSymbol>();
  for (let current: TypeSymbol | undefined = start; current && !seen.has(current); current = current.baseType?.symbol) {
    if (current === target) return true;
    seen.add(current);
  }
  return false;
}

/** Whether an interface's base interfaces, directly or through others, reach an interface. */
function reachesInterface(start: TypeSymbol, target: TypeSymbol): boolean {
  const seen = new Set<TypeSymbol>();
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop() as TypeSymbol;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...current.interfaces.map((face) => face.symbol));
  }
  return false;
}

/** Whether a type parameter is, or is constrained through other type parameters to, the target. */
function constrainsBackTo(
  from: TypeParameterSymbol,
  target: TypeParameterSymbol,
  seen: Set<TypeParameterSymbol>
): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return from.constraintTypes.some(
    (constraint) => constraint.kind === 'typeParameter' && constrainsBackTo(constraint.symbol, target, seen)
  );
}
