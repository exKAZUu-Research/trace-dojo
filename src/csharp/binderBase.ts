import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import type { Position, TypeNode, UsingDirective } from './ast';
import { Conversions, type WellKnownTypes } from './conversions';
import { IMPLICIT_USINGS, NamespaceSymbol } from './namespaces';
import {
  arrayType,
  displayType,
  displayTypeSymbol,
  ERROR_TYPE,
  type NamedType,
  namedType,
  type SpecialType,
  substitute,
  substitutionOf,
  type Type,
  type TypeParameterSymbol,
  type TypeSymbol,
  VOID_TYPE,
} from './types';
import { unavailableTypeOf } from './unavailable';

/** The full names of the library types that C# keywords and the compiler know by role. */
export const SPECIAL_TYPE_NAMES: Record<string, SpecialType> = {
  'System.Object': 'object',
  'System.String': 'string',
  'System.Boolean': 'bool',
  'System.Char': 'char',
  'System.SByte': 'sbyte',
  'System.Byte': 'byte',
  'System.Int16': 'short',
  'System.UInt16': 'ushort',
  'System.Int32': 'int',
  'System.UInt32': 'uint',
  'System.Int64': 'long',
  'System.UInt64': 'ulong',
  'System.Single': 'float',
  'System.Double': 'double',
  'System.Decimal': 'decimal',
  'System.Nullable`1': 'nullable',
  'System.ValueType': 'valueType',
  'System.Enum': 'enum',
  'System.Array': 'array',
  'System.Delegate': 'delegate',
  'System.MulticastDelegate': 'multicastDelegate',
  'System.Exception': 'exception',
};

const KEYWORD_TYPES: Record<string, SpecialType | 'void'> = {
  object: 'object',
  string: 'string',
  bool: 'bool',
  char: 'char',
  sbyte: 'sbyte',
  byte: 'byte',
  short: 'short',
  ushort: 'ushort',
  int: 'int',
  uint: 'uint',
  long: 'long',
  ulong: 'ulong',
  float: 'float',
  double: 'double',
  decimal: 'decimal',
  void: 'void',
};

/** Where names in a declaration resolve: its namespace, its usings, its enclosing types, and its type parameters. */
export interface TypeContext {
  namespace: NamespaceSymbol[];
  usings: NamespaceSymbol[][];
  type: TypeSymbol | undefined;
  /** The type parameters of the enclosing methods, innermost last. */
  methodTypeParameters: TypeParameterSymbol[];
}

/** The library's namespaces and the types the compiler knows by role, shared by every compilation. */
export interface Library {
  root: NamespaceSymbol;
  specials: Map<SpecialType, TypeSymbol>;
  /** `System.ValueTuple` by arity. */
  valueTuples: Map<number, TypeSymbol>;
  typeNamed(fullName: string, arity?: number): TypeSymbol;
}

/** Thrown to stop compiling after too many errors, or at an error that later ones would only repeat. */
class TooManyErrors extends Error {}

export class BinderBase {
  readonly diagnostics: SourceDiagnostic[] = [];
  /** The root of the program's own namespaces, apart from the library's. */
  readonly userRoot = new NamespaceSymbol('', undefined);
  private wellKnownCache: WellKnownTypes | undefined;
  private conversionsCache: Conversions | undefined;

  constructor(readonly library: Library) {}

  /** The types known by role, which exist once the library's types are declared. */
  get wellKnown(): WellKnownTypes {
    this.wellKnownCache ??= this.createWellKnown();
    return this.wellKnownCache;
  }

  get conversions(): Conversions {
    this.conversionsCache ??= new Conversions(this.wellKnown);
    return this.conversionsCache;
  }

  private createWellKnown(): WellKnownTypes {
    const library = this.library;
    const special = (name: SpecialType): NamedType => namedType(library.specials.get(name) as TypeSymbol);
    return {
      object: special('object'),
      string: special('string'),
      valueType: special('valueType'),
      enum: special('enum'),
      array: special('array'),
      delegate: special('delegate'),
      multicastDelegate: special('multicastDelegate'),
      nullable: library.specials.get('nullable') as TypeSymbol,
      arrayInterfaces: (element) =>
        ['IList', 'ICollection', 'IEnumerable', 'IReadOnlyList', 'IReadOnlyCollection'].map((name) =>
          namedType(library.typeNamed(`System.Collections.Generic.${name}`, 1), [element])
        ),
      special,
    };
  }

  /** Reports an error with Roslyn's code and Japanese message, then lets binding continue with an error type. */
  error(position: Position | number, code: string, message: string): void {
    const row = typeof position === 'number' ? position : position.row;
    this.diagnostics.push({ row, message: `${code}: ${message}` });
    if (this.diagnostics.length >= 200) throw new TooManyErrors();
  }

  /** Rejects a feature this grader does not run, which stops compiling at once. */
  unsupported(position: Position | number, what: string): never {
    const row = typeof position === 'number' ? position : position.row;
    throw new CompileError([...this.diagnostics, { row, message: `${what}は、この採点環境では使えません。` }]);
  }

  /** Runs a compilation step, turning the errors it reported into a `CompileError`. */
  protected finishWithErrors(): void {
    if (this.diagnostics.length > 0) throw new CompileError(this.diagnostics);
  }

  protected runGuarded(run: () => void): void {
    try {
      run();
    } catch (error) {
      if (!(error instanceof TooManyErrors)) throw error;
    }
  }

  specialType(special: SpecialType): NamedType {
    return this.wellKnown.special(special);
  }

  get objectType(): NamedType {
    return this.wellKnown.object;
  }

  get stringType(): NamedType {
    return this.wellKnown.string;
  }

  get intType(): NamedType {
    return this.specialType('int');
  }

  get boolType(): NamedType {
    return this.specialType('bool');
  }

  nullableOf(type: Type): NamedType {
    return namedType(this.wellKnown.nullable, [type]);
  }

  tupleType(elements: Type[], names?: (string | undefined)[]): NamedType {
    const symbol = this.library.valueTuples.get(elements.length);
    if (!symbol) this.unsupported(0, '要素が17個以上のタプル');
    const type = namedType(symbol, elements);
    if (names?.some((name) => name !== undefined)) type.tupleNames = names;
    return type;
  }

  /** The namespaces that a list of `using` directives imports, with the implicit ones of a file-based app. */
  protected resolveUsings(usings: UsingDirective[], withImplicit = true): NamespaceSymbol[][] {
    const result: NamespaceSymbol[][] = withImplicit ? IMPLICIT_USINGS.map((path) => this.namespacesAt(path)) : [];
    for (const using of usings) {
      const namespaces = this.namespacesAt(using.name);
      if (namespaces.length === 0) {
        const type = this.findTypeByPath(using.name);
        if (type) {
          this.error(
            using,
            'CS0138',
            `using namespace' ディレクティブは名前空間に対してのみ適用できます。'${using.name.join('.')}' は名前空間ではなく型です。代わりに 'using static' ディレクティブを使用することを検討してください。`
          );
          continue;
        }
        const unavailable = unavailableNamespaceOf(using.name);
        if (unavailable) this.unsupported(using, unavailable);
        this.error(
          using,
          'CS0246',
          `型または名前空間の名前 '${using.name[0]}' が見つかりませんでした (using ディレクティブまたはアセンブリ参照が指定されていることを確認してください)`
        );
        continue;
      }
      result.push(namespaces);
    }
    return result;
  }

  /** The program's and the library's namespaces at a path, of which either may lack it. */
  /**
   * The namespaces a declaration's names resolve in, innermost first: each namespace around it, both the program's
   * and the library's of the same name, so that a program's class finds the library's global `Turtle`.
   */
  *enclosingNamespaces(context: TypeContext): Generator<NamespaceSymbol[]> {
    const [first] = context.namespace;
    if (!first) return;
    yield context.namespace;
    const path = namespacePathOf(first);
    yield this.namespacesAt(path).filter((namespace) => !context.namespace.includes(namespace));
    while (path.length > 0) {
      path.pop();
      yield this.namespacesAt(path);
    }
  }

  namespacesAt(path: readonly string[]): NamespaceSymbol[] {
    return [this.userRoot.resolve(path, false), this.library.root.resolve(path, false)].filter(
      (namespace): namespace is NamespaceSymbol => namespace !== undefined
    );
  }

  private findTypeByPath(path: readonly string[]): TypeSymbol | undefined {
    const namespaces = this.namespacesAt(path.slice(0, -1));
    for (const namespace of namespaces) {
      const found = namespace.types.get(path.at(-1) as string)?.[0];
      if (found) return found;
    }
    return undefined;
  }

  /** Resolves a type in a declaration's context, reporting the names it cannot find. */
  resolveType(node: TypeNode, context: TypeContext): Type {
    switch (node.kind) {
      case 'predefinedType': {
        return this.resolvePredefinedType(node);
      }
      case 'varType': {
        // `var` outside a declaration of a local names a type called `var`, which no program declares.
        return this.resolveNamedType(node, 'var', [], context);
      }
      case 'namedType': {
        if (node.name === 'dynamic' && !node.typeArgs) this.unsupported(node, '`dynamic`');
        if (node.name === 'nint' || node.name === 'nuint') this.unsupported(node, `\`${node.name}\` 型`);
        const args = (node.typeArgs ?? []).map((arg) => this.resolveType(arg, context));
        return this.resolveNamedType(node, node.name, args, context);
      }
      case 'qualifiedType': {
        return this.resolveQualifiedType(node, context);
      }
      case 'arrayType': {
        return this.resolveArrayType(node, context);
      }
      case 'nullableType': {
        return this.resolveNullableType(node, context);
      }
      case 'tupleType': {
        if (node.elements.length < 2) {
          this.error(node, 'CS8124', 'タプルには 2 つ以上の要素が必要です。');
          return ERROR_TYPE;
        }
        return this.tupleType(
          node.elements.map((element) => this.resolveType(element.type, context)),
          node.elements.map((element) => element.name)
        );
      }
    }
  }

  private resolvePredefinedType(node: Extract<TypeNode, { kind: 'predefinedType' }>): Type {
    const special = KEYWORD_TYPES[node.name];
    if (special === 'void') return VOID_TYPE;
    if (special) return this.specialType(special);
    if (node.name === 'nint' || node.name === 'nuint') this.unsupported(node, `\`${node.name}\` 型`);
    if (node.name === 'dynamic') this.unsupported(node, '`dynamic`');
    return ERROR_TYPE;
  }

  private resolveArrayType(node: Extract<TypeNode, { kind: 'arrayType' }>, context: TypeContext): Type {
    const element = this.resolveType(node.element, context);
    if (element.kind === 'void') {
      this.error(node, 'CS1547', "キーワード 'void' はこのコンテキストでは使用できません");
      return ERROR_TYPE;
    }
    if (element.kind === 'named' && element.symbol.isStatic) {
      this.error(node, 'CS0719', `'${displayType(element)}': 配列要素をスタティック型にすることはできません`);
    }
    return arrayType(element, node.rank);
  }

  private resolveNullableType(node: Extract<TypeNode, { kind: 'nullableType' }>, context: TypeContext): Type {
    const inner = this.resolveType(node.inner, context);
    if (inner.kind === 'named' && inner.symbol.isValueType && inner.symbol.special !== 'nullable')
      return this.nullableOf(inner);
    if (inner.kind === 'typeParameter' && inner.symbol.hasValueConstraint) return this.nullableOf(inner);
    // A nullable reference type is the type itself to the runtime; nullability only produces warnings.
    return inner;
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Each branch handles one case of the C# rule that the function applies.
  private resolveQualifiedType(node: Extract<TypeNode, { kind: 'qualifiedType' }>, context: TypeContext): Type {
    const args = (node.typeArgs ?? []).map((arg) => this.resolveType(arg, context));
    const path = qualifiedPath(node.left);
    if (path) {
      const namespaces = this.namespacesAt(path);
      if (namespaces.length > 0) {
        for (const namespace of namespaces) {
          const found = namespace.findType(node.name, args.length);
          if (found) return this.construct(node, found, args);
        }
        const unavailable = unavailableTypeOf([...path, node.name].join('.'), node.name);
        if (unavailable) this.unsupported(node, unavailable);
        this.error(
          node,
          'CS0234',
          `型または名前空間の名前 '${node.name}' が名前空間 '${path.join('.')}' に存在しません (アセンブリ参照があることを確認してください)`
        );
        return ERROR_TYPE;
      }
    }
    const left = this.resolveType(node.left, context);
    if (left.kind === 'error') return ERROR_TYPE;
    if (left.kind === 'named') {
      const nested = this.findNestedType(left, node.name, args.length);
      if (nested) return this.construct(node, nested.symbol, [...nested.outerArgs, ...args]);
      this.error(node, 'CS0426', `型名 '${node.name}' が型 '${displayType(left)}' に存在しません`);
    }
    return ERROR_TYPE;
  }

  /** Finds a type by its simple name, from the innermost scope out, as C#'s name lookup does. */
  // code-gauge-allow functionCognitiveComplexity 20 -- Each branch handles one case of the C# rule that the function applies.
  resolveNamedType(position: Position, name: string, args: Type[], context: TypeContext): Type {
    if (args.length === 0) {
      for (const parameter of context.methodTypeParameters.toReversed())
        if (parameter.name === name) return parameter.type;
    }
    for (let type = context.type; type; type = type.containing) {
      if (args.length === 0) {
        const parameter = type.typeParameters.find((candidate) => candidate.name === name);
        if (parameter) return parameter.type;
      }
      const nested = this.findNestedType(type.declaredType, name, args.length);
      if (nested) return this.construct(position, nested.symbol, [...nested.outerArgs, ...args]);
    }
    const found = this.findTypeInScope(name, args.length, context);
    if (found) return this.construct(position, found, args);
    if (this.findTypeInScope(name, -1, context)) {
      const candidate = this.findTypeInScope(name, -1, context) as TypeSymbol;
      const arity = candidate.typeParameters.length;
      if (arity === 0)
        this.error(position, 'CS0308', `非ジェネリック 種類 '${candidate.name}' は型引数と一緒には使用できません`);
      else
        this.error(
          position,
          'CS0305',
          `ジェネリック 種類 '${candidate.name}<${candidate.typeParameters.map((parameter) => parameter.name).join(', ')}>' を使用するには、${arity} 型引数が必要です`
        );
      return ERROR_TYPE;
    }
    const unavailable = unavailableTypeOf(name, name);
    if (unavailable) this.unsupported(position, unavailable);
    this.error(
      position,
      'CS0246',
      `型または名前空間の名前 '${name}' が見つかりませんでした (using ディレクティブまたはアセンブリ参照が指定されていることを確認してください)`
    );
    return ERROR_TYPE;
  }

  /** Finds a type in the namespaces around a declaration and its usings; an arity of -1 matches any arity. */
  findTypeInScope(name: string, arity: number, context: TypeContext): TypeSymbol | undefined {
    const matches = (namespace: NamespaceSymbol): TypeSymbol | undefined =>
      arity < 0 ? namespace.types.get(name)?.[0] : namespace.findType(name, arity);
    for (const namespaces of this.enclosingNamespaces(context)) {
      for (const namespace of namespaces) {
        const found = matches(namespace);
        if (found) return found;
      }
    }
    for (const group of context.usings) {
      for (const namespace of group) {
        const found = matches(namespace);
        if (found) return found;
      }
    }
    return undefined;
  }

  /** A nested type of a type or of its bases, with the outer type arguments it takes from the type it is found in. */
  findNestedType(type: NamedType, name: string, arity: number): { symbol: TypeSymbol; outerArgs: Type[] } | undefined {
    for (
      let current: NamedType | undefined = type;
      current;
      current = current.symbol.baseType
        ? (substitute(current.symbol.baseType, substitutionOf(current)) as NamedType)
        : undefined
    ) {
      const nested = current.symbol.nestedTypes.find(
        (candidate) => candidate.name === name && candidate.typeParameters.length === arity
      );
      if (nested) return { symbol: nested, outerArgs: current.args };
    }
    return undefined;
  }

  /** Constructs a generic type with its arguments, checking their number. */
  /** The constructed types whose type arguments the compiler checks against their constraints once they are known. */
  readonly constraintChecks: { symbol: TypeSymbol; args: Type[]; row: number }[] = [];

  construct(position: Position, symbol: TypeSymbol, args: Type[]): Type {
    const expected = symbol.allTypeParameters.length;
    if (args.length !== expected) {
      this.error(
        position,
        'CS0305',
        `ジェネリック 種類 '${displayTypeSymbol(symbol)}' を使用するには、${symbol.typeParameters.length} 型引数が必要です`
      );
      return ERROR_TYPE;
    }
    if (
      symbol.special === 'nullable' &&
      args[0].kind === 'named' &&
      (args[0].symbol.special === 'nullable' || !args[0].symbol.isValueType)
    ) {
      this.error(
        position,
        'CS0453',
        `型 '${displayType(args[0])}' は、ジェネリック型のパラメーター 'T'、またはメソッド 'Nullable<T>' として使用するために、Null 非許容の値型でなければなりません`
      );
    }
    if (args.length > 0 && symbol.special !== 'nullable')
      this.constraintChecks.push({ symbol, args, row: position.row });
    return namedType(symbol, args);
  }
}

export function namespacePathOf(namespace: NamespaceSymbol): string[] {
  const path: string[] = [];
  for (let current: NamespaceSymbol | undefined = namespace; current?.parent; current = current.parent) {
    path.unshift(current.name);
  }
  return path;
}

/** The dotted path of a type name that may name a namespace, such as `System.Collections`. */
function qualifiedPath(node: TypeNode): string[] | undefined {
  if (node.kind === 'namedType' && !node.typeArgs) return [node.name];
  if (node.kind === 'qualifiedType' && !node.typeArgs) {
    const left = qualifiedPath(node.left);
    return left ? [...left, node.name] : undefined;
  }
  return undefined;
}

const UNAVAILABLE_NAMESPACES: Record<string, string> = {
  'System.IO': 'ファイルの読み書き（System.IO）',
  'System.Net': 'ネットワーク（System.Net）',
  'System.Threading': 'スレッド（System.Threading）',
  'System.Threading.Tasks': '非同期処理（System.Threading.Tasks）',
  'System.Reflection': 'リフレクション（System.Reflection）',
  'System.Diagnostics': 'System.Diagnostics',
  'System.Runtime': 'System.Runtime',
};

function unavailableNamespaceOf(path: string[]): string | undefined {
  const name = path.join('.');
  for (const [prefix, what] of Object.entries(UNAVAILABLE_NAMESPACES)) {
    if (name === prefix || name.startsWith(`${prefix}.`)) return what;
  }
  if (path[0] === 'System' || path[0] === 'Microsoft') return `名前空間 ${name}`;
  return undefined;
}
