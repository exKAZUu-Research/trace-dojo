// code-gauge-allow-file fileNcss -- The binder base keeps the type resolution that every later binder stage shares together.
import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import type { Position, TypeNode, UsingDirective } from './ast';
import type { LambdaInfo } from './bound';
import { Conversions, type WellKnownTypes } from './conversions';
import { IMPLICIT_USINGS, NamespaceSymbol } from './namespaces';
import {
  arrayType,
  displayType,
  displayTypeSymbol,
  ERROR_TYPE,
  isRefLikeType,
  isRestrictedType,
  MAX_TUPLE_ARITY,
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
import { isDotnetNamespace, unavailableTypeOf } from './unavailable';

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
  /** The `using` aliases in scope. */
  aliases?: ReadonlyMap<string, UsingAlias>;
  /** The types whose static members `using static` imports. */
  staticUsings?: readonly NamedType[];
  type: TypeSymbol | undefined;
  /** The type parameters of the enclosing methods, innermost last. */
  methodTypeParameters: TypeParameterSymbol[];
}

/** What a `using` alias names: a type, or a namespace by its path. */
export type UsingAlias =
  | { kind: 'type'; type: Type }
  | { kind: 'namespace'; path: string[]; namespaces: NamespaceSymbol[] };

/** The names that `using` directives bring into scope. */
export interface Imports {
  usings: NamespaceSymbol[][];
  aliases: ReadonlyMap<string, UsingAlias>;
  staticUsings: readonly NamedType[];
}

/** The imports of a compilation unit or namespace while its using directives are read. */
interface MutableImports extends Imports {
  aliases: Map<string, UsingAlias>;
  staticUsings: NamedType[];
}

/** Imports of an inner scope before those of an outer one, whose aliases the inner ones hide. */
function mergeImports(inner: Imports, outer: Imports): Imports {
  return {
    usings: [...inner.usings, ...outer.usings],
    aliases: new Map([...outer.aliases, ...inner.aliases]),
    staticUsings: [...inner.staticUsings, ...outer.staticUsings],
  };
}

/** The dotted path of a using's target when it names a namespace or a non-generic type, with `global::` dropped. */
function usingPath(node: TypeNode): string[] | undefined {
  if (node.kind === 'namedType') return node.typeArgs ? undefined : [node.name];
  if (node.kind === 'aliasQualifiedType') return node.alias === 'global' && !node.typeArgs ? [node.name] : undefined;
  if (node.kind === 'qualifiedType' && !node.typeArgs) {
    const left = usingPath(node.left);
    return left ? [...left, node.name] : undefined;
  }
  return undefined;
}

/** The operations whose overflow a `checked` context makes throw. */
const OVERFLOW_CHECKED_KINDS = new Set(['binary', 'unary', 'convert']);

/** Marks the operations of a bound tree that no inner context marked, descending into the lambdas it contains. */
export function markOverflowChecks(node: unknown, isChecked: boolean, seen = new Set<object>()): void {
  if (typeof node !== 'object' || node === null || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) markOverflowChecks(item, isChecked, seen);
    return;
  }
  if (Object.getPrototypeOf(node) !== Object.prototype) return;
  const record = node as Record<string, unknown> & { kind?: string; isChecked?: boolean };
  if (record.kind && OVERFLOW_CHECKED_KINDS.has(record.kind) && record.isChecked === undefined)
    record.isChecked = isChecked;
  if (record.kind === 'lambda') markOverflowChecks((record.lambda as LambdaInfo).method.body, isChecked, seen);
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'type' && key !== 'node' && key !== 'context') markOverflowChecks(value, isChecked, seen);
  }
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

/** A nested type a name resolves to, with the outer type arguments of the type it is found in. */
export interface NestedTypeFound {
  symbol: TypeSymbol;
  outerArgs: Type[];
}

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

  /** The diagnostics of reference lifetimes, which Roslyn reports after the rest of its member's binding errors. */
  private readonly refSafetyDiagnostics = new WeakSet<object>();

  /** Reports an error of a reference's lifetime (`return ref` of a local), which a member reports last. */
  protected refSafetyError(position: Position | number, code: string, message: string): void {
    this.error(position, code, message);
    const diagnostic = this.diagnostics.at(-1);
    if (diagnostic) this.refSafetyDiagnostics.add(diagnostic);
  }

  /** Moves the member's reference lifetime errors after its other binding errors, as Roslyn's separate pass orders them. */
  protected flushRefSafetyDiagnostics(): void {
    const late = this.diagnostics.filter((diagnostic) => this.refSafetyDiagnostics.has(diagnostic));
    if (late.length === 0) return;
    const rest = this.diagnostics.filter((diagnostic) => !this.refSafetyDiagnostics.has(diagnostic));
    this.diagnostics.splice(0, this.diagnostics.length, ...rest, ...late);
    for (const diagnostic of late) this.refSafetyDiagnostics.delete(diagnostic);
  }

  /**
   * Runs a binding whose result only informs another binding, which reports the diagnostics itself: those of this one
   * are dropped, and a binding that stops compiling gives undefined.
   */
  protected quietly<T>(bind: () => T): T | undefined {
    const count = this.diagnostics.length;
    try {
      return bind();
    } catch (error) {
      if (error instanceof CompileError || error instanceof TooManyErrors) return undefined;
      throw error;
    } finally {
      this.diagnostics.length = count;
    }
  }

  /** Rejects a feature this grader does not run, which stops compiling at once. */
  unsupported(position: Position | number, what: string): never {
    const row = typeof position === 'number' ? position : position.row;
    throw new CompileError([...this.diagnostics, { row, message: `${what}は、この採点環境では使えません。` }]);
  }

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

  /** @param row Where the program writes the tuple, whose element types are checked as type arguments there. */
  tupleType(elements: Type[], names?: (string | undefined)[], row?: number): NamedType {
    const symbol = this.library.valueTuples.get(elements.length);
    if (!symbol) this.unsupported(0, `要素が${MAX_TUPLE_ARITY + 1}個以上のタプル`);
    if (row !== undefined) {
      const owner = `(${symbol.typeParameters.map((parameter) => parameter.name).join(', ')})`;
      for (const [index, element] of elements.entries())
        this.checkTypeArgumentKind(element, `T${index + 1}`, owner, row);
    }
    const type = namedType(symbol, elements);
    if (names?.some((name) => name !== undefined)) type.tupleNames = names;
    return type;
  }

  /**
   * Whether the arithmetic being bound is in a `checked` (true) or an `unchecked` (false) context, or in neither, where
   * constants are checked and the rest follows the program's `CheckForOverflowUnderflow`.
   */
  checkedContext: boolean | undefined;

  /**
   * Binds in a `checked` or `unchecked` context, marking the integral operations and conversions that the binding made
   * and that no inner context marked, which is lexical, as C# spec §12.8.20 says: lambdas written inside it are in it.
   */
  inCheckedContext<T>(isChecked: boolean, bind: () => T): T {
    const saved = this.checkedContext;
    this.checkedContext = isChecked;
    try {
      const result = bind();
      markOverflowChecks(result, isChecked);
      return result;
    } finally {
      this.checkedContext = saved;
    }
  }

  /** Whether the program imports the implicit global usings of a file-based app, as it does unless it turns them off. */
  implicitUsings = true;
  private readonly importsCache = new Map<readonly UsingDirective[], Imports>();
  private globalImportsCache: Imports | undefined;

  /**
   * The names that the compilation unit's global usings and the implicit usings bring into every scope, which also
   * resolve the targets of the other `using` directives.
   */
  protected globalImports(unitUsings: readonly UsingDirective[]): Imports {
    if (this.globalImportsCache) return this.globalImportsCache;
    const implicit: Imports = {
      usings: this.implicitUsings ? IMPLICIT_USINGS.map((path) => this.namespacesAt(path)) : [],
      aliases: new Map(),
      staticUsings: [],
    };
    this.globalImportsCache = implicit;
    const globals = unitUsings.filter((using) => using.isGlobal);
    const firstLocal = unitUsings.findIndex((using) => !using.isGlobal);
    for (const using of unitUsings.slice(firstLocal === -1 ? unitUsings.length : firstLocal))
      if (using.isGlobal)
        this.error(
          using,
          'CS8915',
          'グローバル using ディレクティブは、すべての非グローバル using ディレクティブの前に指定する必要があります。'
        );
    this.globalImportsCache = mergeImports(this.importUsings(globals, [this.userRoot, this.library.root]), implicit);
    return this.globalImportsCache;
  }

  /**
   * The names that the non-global `using` directives of a compilation unit or a namespace import, whose targets resolve
   * in the namespace with only the global usings (C# spec §14.5: using directives do not affect each other).
   */
  protected resolveUsings(usings: readonly UsingDirective[], namespace: NamespaceSymbol[]): Imports {
    const cached = this.importsCache.get(usings);
    if (cached) return cached;
    const imports = this.importUsings(
      usings.filter((using) => !using.isGlobal),
      namespace
    );
    this.importsCache.set(usings, imports);
    return imports;
  }

  /** Sets what a declaration's context imports: its namespaces' usings, innermost first, then the unit's. */
  protected importInto(
    context: TypeContext,
    levels: readonly { usings: readonly UsingDirective[]; namespace: NamespaceSymbol[] }[],
    unitUsings: readonly UsingDirective[]
  ): void {
    let imports = this.globalImports(unitUsings);
    imports = mergeImports(this.resolveUsings(unitUsings, [this.userRoot, this.library.root]), imports);
    for (const level of levels) {
      imports = mergeImports(this.resolveUsings(level.usings, level.namespace), imports);
    }
    context.usings = imports.usings;
    context.aliases = imports.aliases;
    context.staticUsings = imports.staticUsings;
  }

  private importUsings(usings: readonly UsingDirective[], namespace: NamespaceSymbol[]): Imports {
    const imports: MutableImports = { usings: [], aliases: new Map(), staticUsings: [] };
    const global = this.globalImportsCache;
    const context: TypeContext = {
      namespace,
      usings: global?.usings ?? [],
      aliases: global?.aliases,
      staticUsings: global?.staticUsings,
      type: undefined,
      methodTypeParameters: [],
    };
    for (const using of usings) {
      if (using.kind === 'alias') this.importAlias(using, imports, context);
      else if (using.kind === 'static') this.importStatic(using, imports, context);
      else this.importNamespace(using, imports, context);
    }
    return imports;
  }

  /** `using A = X;`, naming a namespace or a type. */
  private importAlias(
    using: Extract<UsingDirective, { kind: 'alias' }>,
    imports: MutableImports,
    context: TypeContext
  ): void {
    if (imports.aliases.has(using.alias)) {
      this.error(using, 'CS1537', `using エイリアス '${using.alias}' は以前にこの名前空間で使用されています`);
      return;
    }
    const path = usingPath(using.name);
    const namespaces = path ? this.namespacesAt(path) : [];
    if (path && namespaces.length > 0) {
      imports.aliases.set(using.alias, { kind: 'namespace', path, namespaces });
      return;
    }
    // An alias whose target is missing still names it, so its uses report nothing more.
    imports.aliases.set(using.alias, { kind: 'type', type: this.resolveType(using.name, context) });
  }

  /** `using static T;`, which a namespace may not be. */
  private importStatic(using: UsingDirective, imports: MutableImports, context: TypeContext): void {
    const path = usingPath(using.name);
    if (path && this.namespacesAt(path).length > 0) {
      this.error(
        using.name,
        'CS7007',
        `using static' ディレクティブは型に対してのみ適用できます。'${path.join('.')}' は型ではなく名前空間です。代わりに 'using namespace' ディレクティブを使用することを検討してください。`
      );
      return;
    }
    const type = this.resolveType(using.name, context);
    if (type.kind === 'named') imports.staticUsings.push(type);
  }

  /** `using N;`, which a type may not be. */
  private importNamespace(using: UsingDirective, imports: MutableImports, context: TypeContext): void {
    const path = usingPath(using.name);
    const namespaces = path ? this.namespacesAt(path) : [];
    if (namespaces.length > 0) {
      imports.usings.push(namespaces);
      return;
    }
    const display = path?.join('.') ?? '';
    const type = path ? this.quietly(() => this.resolveType(using.name, context)) : undefined;
    if (type && type.kind !== 'error') {
      this.error(
        using,
        'CS0138',
        `using namespace' ディレクティブは名前空間に対してのみ適用できます。'${display}' は名前空間ではなく型です。代わりに 'using static' ディレクティブを使用することを検討してください。`
      );
      return;
    }
    const unavailable = path ? unavailableNamespaceOf(path) : undefined;
    if (unavailable) this.unsupported(using, unavailable);
    this.resolveType(using.name, context);
  }

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

  /** The program's and the library's namespaces at a path, of which either may lack it. */
  namespacesAt(path: readonly string[]): NamespaceSymbol[] {
    return [this.userRoot.resolve(path, false), this.library.root.resolve(path, false)].filter(
      (namespace): namespace is NamespaceSymbol => namespace !== undefined
    );
  }

  /** `dynamic`, whose operations bind at run time to the types of the values. */
  get dynamicType(): NamedType {
    return namedType(this.library.typeNamed('System.Runtime.CompilerServices.__Dynamic'));
  }

  /** Resolves a method's return type, noting a method that returns by reference (`ref T`, `ref readonly T`). */
  resolveReturnType(
    node: TypeNode,
    context: TypeContext,
    method: { returnsByRef: 'ref' | 'readonly' | undefined }
  ): Type {
    if (node.kind !== 'refType') return this.checkReturnType(this.resolveType(node, context), node);
    method.returnsByRef = node.isReadonly ? 'readonly' : 'ref';
    return this.checkReturnType(this.resolveType(node.type, context), node);
  }

  /** Reports a `TypedReference` return type, which C# allows no method or delegate. */
  checkReturnType(type: Type, position: Position): Type {
    if (isRestrictedType(type))
      this.error(
        position,
        'CS1599',
        `メソッド、デリゲート、または関数ポインターの戻り値の型を '${displayType(type)}' にすることはできません`
      );
    return type;
  }

  /** Reports a pointer outside an unsafe context (CS0214). */
  reportOutsideUnsafe(position: Position | number): void {
    this.error(
      position,
      'CS0214',
      'ポインターおよび固定サイズ バッファーは、unsafe コンテキストでのみ使用することができます'
    );
  }

  /** Resolves a type in a declaration's context, reporting the names it cannot find. */
  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  resolveType(node: TypeNode, context: TypeContext): Type {
    switch (node.kind) {
      case 'predefinedType': {
        return this.resolvePredefinedType(node);
      }
      case 'refType': {
        // Declarations that may be references take the type apart; elsewhere Roslyn's parser rejects the `ref`.
        this.error(node, 'CS1073', "予期しないトークン 'ref'");
        return this.resolveType(node.type, context);
      }
      case 'pointerType': {
        if (!node.isUnsafe) this.reportOutsideUnsafe(node);
        const element =
          node.element.kind === 'predefinedType' && node.element.name === 'void'
            ? namedType(this.library.typeNamed('System.Runtime.CompilerServices.__Void'))
            : this.resolveType(node.element, context);
        return namedType(this.library.typeNamed('System.Runtime.CompilerServices.__Pointer', 1), [element]);
      }
      case 'functionPointerType': {
        // A function pointer of managed calling convention calls as the delegate of its signature does.
        if (!node.isUnsafe) this.reportOutsideUnsafe(node);
        const parameters = node.parameters.map((parameter) => this.resolveType(parameter, context));
        const returnType = this.resolveType(node.returnType, context);
        return returnType.kind === 'void'
          ? namedType(this.library.typeNamed('System.Action', parameters.length), parameters)
          : namedType(this.library.typeNamed('System.Func', parameters.length + 1), [...parameters, returnType]);
      }
      case 'varType': {
        // `var` outside a declaration of a local names a type called `var`, which no program declares.
        return this.resolveNamedType(node, 'var', [], context);
      }
      case 'namedType': {
        if (node.name === 'dynamic' && !node.typeArgs && !this.findTypeInScope('dynamic', 0, context))
          return this.dynamicType;
        if (node.name === 'nint' || node.name === 'nuint') this.unsupported(node, `\`${node.name}\` 型`);
        const args = (node.typeArgs ?? []).map((arg) => this.resolveType(arg, context));
        return this.resolveNamedType(node, node.name, args, context);
      }
      case 'qualifiedType': {
        return this.resolveQualifiedType(node, context);
      }
      case 'aliasQualifiedType': {
        const namespaces = this.aliasNamespaces(node.alias, node, context);
        if (!namespaces) return ERROR_TYPE;
        const args = (node.typeArgs ?? []).map((arg) => this.resolveType(arg, context));
        return this.typeInNamespaces(node, namespaces.path, namespaces.namespaces, node.name, args);
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
          node.elements.map((element) => element.name),
          node.row
        );
      }
    }
  }

  private resolvePredefinedType(node: Extract<TypeNode, { kind: 'predefinedType' }>): Type {
    const special = KEYWORD_TYPES[node.name];
    if (special === 'void') return VOID_TYPE;
    if (special) return this.specialType(special);
    if (node.name === 'nint' || node.name === 'nuint') this.unsupported(node, `\`${node.name}\` 型`);
    if (node.name === 'dynamic') return this.dynamicType;
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
    if (isRefLikeType(element))
      this.error(node, 'CS0611', `配列要素を '${displayType(element)}' 型にすることはできません`);
    return arrayType(element, node.rank);
  }

  private resolveNullableType(node: Extract<TypeNode, { kind: 'nullableType' }>, context: TypeContext): Type {
    const inner = this.resolveType(node.inner, context);
    if (inner.kind === 'named' && inner.symbol.isValueType && inner.symbol.special !== 'nullable') {
      this.checkTypeArgumentKind(inner, 'T', 'Nullable<T>', node.row);
      return this.nullableOf(inner);
    }
    if (inner.kind === 'typeParameter' && inner.symbol.hasValueConstraint) return this.nullableOf(inner);
    // A nullable reference type is the type itself to the runtime and to conversions, which only Roslyn's messages show.
    if (inner.kind === 'named' || inner.kind === 'array' || inner.kind === 'typeParameter')
      return { ...inner, isAnnotated: true };
    return inner;
  }

  private resolveQualifiedType(node: Extract<TypeNode, { kind: 'qualifiedType' }>, context: TypeContext): Type {
    const args = (node.typeArgs ?? []).map((arg) => this.resolveType(arg, context));
    const namespaces = this.namespaceOfQualifier(node.left, context);
    if (namespaces) return this.typeInNamespaces(node, namespaces.path, namespaces.namespaces, node.name, args);
    const left = this.resolveType(node.left, context);
    if (left.kind === 'error') return ERROR_TYPE;
    if (left.kind === 'named') {
      const { nested, inaccessible } = this.findNestedType(left, node.name, args.length, context);
      if (nested) return this.construct(node, nested.symbol, [...nested.outerArgs, ...args]);
      if (inaccessible) {
        this.reportInaccessibleType(node, inaccessible.symbol);
        return this.construct(node, inaccessible.symbol, [...inaccessible.outerArgs, ...args]);
      }
      this.error(node, 'CS0426', `型名 '${node.name}' が型 '${displayType(left)}' に存在しません`);
    }
    return ERROR_TYPE;
  }

  /**
   * The namespaces a qualifier names, when it names one: a dotted path from the global namespace, `global::N`, or a
   * namespace alias, which takes the place of the path's first name.
   */
  private namespaceOfQualifier(
    node: TypeNode,
    context: TypeContext
  ): { path: string[]; namespaces: NamespaceSymbol[] } | undefined {
    if (node.kind === 'aliasQualifiedType' && !node.typeArgs) {
      const outer = this.aliasNamespaces(node.alias, node, context);
      if (!outer) return undefined;
      const path = [...outer.path, node.name];
      const namespaces = this.namespacesAt(path);
      return namespaces.length > 0 ? { path, namespaces } : undefined;
    }
    let path = qualifiedPath(node);
    if (!path) return undefined;
    const alias = context.aliases?.get(path[0]);
    if (alias?.kind === 'namespace') path = [...alias.path, ...path.slice(1)];
    else if (alias) return undefined;
    const namespaces = this.namespacesAt(path);
    return namespaces.length > 0 ? { path, namespaces } : undefined;
  }

  /** The namespaces of the left side of `alias::name`, reporting an alias that names none. */
  protected aliasNamespaces(
    alias: string,
    position: Position,
    context: TypeContext
  ): { path: string[]; namespaces: NamespaceSymbol[] } | undefined {
    if (alias === 'global') return { path: [], namespaces: [this.userRoot, this.library.root] };
    const target = context.aliases?.get(alias);
    if (target?.kind === 'namespace') return target;
    if (target)
      this.error(
        position,
        'CS0431',
        `エイリアスが型を参照しているため、エイリアス '${alias}' を '::' と使用できません。'.' を使用してください。`
      );
    else this.error(position, 'CS0432', `エイリアス '${alias}' が見つかりません`);
    return undefined;
  }

  /** A type of a name in namespaces, reporting it as CS0234 when they lack it. */
  private typeInNamespaces(
    position: Position,
    path: string[],
    namespaces: NamespaceSymbol[],
    name: string,
    args: Type[]
  ): Type {
    for (const namespace of namespaces) {
      const found = namespace.findType(name, args.length);
      if (found) return this.construct(position, found, args);
    }
    // `global::Name` names a type of the global namespace, where .NET has none.
    const unavailable =
      (path.length > 0 ? this.unavailableType([...path, name].join('.'), name) : undefined) ??
      unavailableDotnetNamespace([...path, name]);
    if (unavailable) this.unsupported(position, unavailable);
    if (path.length === 0) {
      this.error(
        position,
        'CS0400',
        `型名または名前空間名 '${name}' がグローバル名前空間に見つかりませんでした (アセンブリ参照が存在することを確認してください)`
      );
      return ERROR_TYPE;
    }
    this.error(
      position,
      'CS0234',
      `型または名前空間の名前 '${name}' が名前空間 '${path.join('.')}' に存在しません (アセンブリ参照があることを確認してください)`
    );
    return ERROR_TYPE;
  }

  /** Finds a type by its simple name, from the innermost scope out, as C#'s name lookup does. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  resolveNamedType(position: Position, name: string, args: Type[], context: TypeContext): Type {
    if (args.length === 0) {
      for (const parameter of context.methodTypeParameters.toReversed())
        if (parameter.name === name) return parameter.type;
    }
    let inaccessible: { symbol: TypeSymbol; outerArgs: Type[] } | undefined;
    for (let type = context.type; type; type = type.containing) {
      if (args.length === 0) {
        const parameter = type.typeParameters.find((candidate) => candidate.name === name);
        if (parameter) return parameter.type;
      }
      const lookup = this.findNestedType(type.declaredType, name, args.length, context);
      if (lookup.nested) return this.construct(position, lookup.nested.symbol, [...lookup.nested.outerArgs, ...args]);
      inaccessible ??= lookup.inaccessible;
    }
    const alias = args.length === 0 ? context.aliases?.get(name) : undefined;
    if (alias?.kind === 'type') return alias.type;
    const found = this.findTypeInScope(name, args.length, context);
    if (found?.obsoleteError !== undefined)
      this.error(position, 'CS0619', `'${displayTypeSymbol(found)}' は旧形式です ('${found.obsoleteError}')`);
    if (found) return this.construct(position, found, args);
    if (inaccessible) {
      this.reportInaccessibleType(position, inaccessible.symbol);
      return this.construct(position, inaccessible.symbol, [...inaccessible.outerArgs, ...args]);
    }
    const otherArity = this.findTypeInScope(name, -1, context);
    if (otherArity) {
      this.reportTypeArityMismatch(position, otherArity);
      return ERROR_TYPE;
    }
    const unavailable = this.unavailableType(name, name, context);
    if (unavailable) this.unsupported(position, unavailable);
    this.error(
      position,
      'CS0246',
      `型または名前空間の名前 '${name}' が見つかりませんでした (using ディレクティブまたはアセンブリ参照が指定されていることを確認してください)`
    );
    return ERROR_TYPE;
  }

  private reportTypeArityMismatch(position: Position, candidate: TypeSymbol): void {
    const arity = candidate.typeParameters.length;
    if (arity === 0)
      this.error(position, 'CS0308', `非ジェネリック 種類 '${candidate.name}' は型引数と一緒には使用できません`);
    else
      this.error(
        position,
        'CS0305',
        `ジェネリック 種類 '${candidate.name}<${candidate.typeParameters.map((parameter) => parameter.name).join(', ')}>' を使用するには、${arity} 型引数が必要です`
      );
  }

  /**
   * Describes a .NET type that the library lacks, or undefined for one it has or a name .NET lacks too; a simple name
   * names one only through a namespace in scope of the context, as the name would bind to it in .NET.
   */
  protected unavailableType(name: string, simpleName: string, context?: TypeContext): string | undefined {
    const inScope = context ? this.namespacePathsInScope(context) : new Set<string>();
    return unavailableTypeOf(
      name,
      simpleName,
      (fullName) => {
        const parts = fullName.split('.');
        return this.library.root.resolve(parts.slice(0, -1), false)?.types.has(parts.at(-1) as string) ?? false;
      },
      (namespace) => inScope.has(namespace)
    );
  }

  /**
   * The dotted paths of the namespaces whose types a simple name finds in a context: those around it and those its
   * usings import, with the implicit usings that .NET has although the library lacks some of their namespaces.
   */
  private namespacePathsInScope(context: TypeContext): Set<string> {
    const paths = new Set<string>();
    for (const group of [...this.enclosingNamespaces(context), ...context.usings])
      for (const namespace of group) paths.add(namespacePathOf(namespace).join('.'));
    if (this.implicitUsings) for (const path of IMPLICIT_USINGS) paths.add(path.join('.'));
    return paths;
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

  /** Whether code in the context may name a nested type, which the binder that knows accessibility decides. */
  protected canUseNestedType(_nested: TypeSymbol, _context: TypeContext): boolean {
    return true;
  }

  /**
   * The nested type of a name in a type or its bases that code in the context may use, with the outer type arguments it
   * takes from the type it is found in, and else the first one it may not use, which callers report as CS0122 only
   * when nothing else gives the name. Every resolution of a name to a nested type goes through here.
   */
  findNestedType(
    type: NamedType,
    name: string,
    arity: number,
    context: TypeContext,
    /** Whether to search the bases too, which member lookup, walking the bases level by level itself, leaves out. */
    withBases = true
  ): { nested?: NestedTypeFound; inaccessible?: NestedTypeFound } {
    let inaccessible: NestedTypeFound | undefined;
    for (
      let current: NamedType | undefined = type;
      current;
      current =
        withBases && current.symbol.baseType
          ? (substitute(current.symbol.baseType, substitutionOf(current)) as NamedType)
          : undefined
    ) {
      const nested = current.symbol.nestedTypes.find(
        (candidate) => candidate.name === name && candidate.typeParameters.length === arity
      );
      if (!nested) continue;
      const found = { symbol: nested, outerArgs: current.args };
      if (this.canUseNestedType(nested, context)) return { nested: found };
      inaccessible ??= found;
    }
    return { inaccessible };
  }

  reportInaccessibleType(position: Position | number, symbol: TypeSymbol): void {
    this.error(position, 'CS0122', `'${displayTypeSymbol(symbol)}' はアクセスできない保護レベルになっています`);
  }

  /** The constructed types whose type arguments the compiler checks against their constraints once they are known. */
  readonly constraintChecks: { symbol: TypeSymbol; args: Type[]; row: number }[] = [];

  /** Constructs a generic type with its arguments, checking their number. */
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
    const parameters = symbol.allTypeParameters;
    const display = displayTypeSymbol(symbol);
    const areKindsAllowed = args
      .map((arg, index) =>
        this.checkTypeArgumentKind(
          arg,
          parameters[index].name,
          display,
          position.row,
          parameters[index].allowsRefStruct
        )
      )
      .every(Boolean);
    if (areKindsAllowed && args.length > 0 && symbol.special !== 'nullable')
      this.constraintChecks.push({ symbol, args, row: position.row });
    return namedType(symbol, args);
  }

  /** Reports a ref struct as a type argument, which only a type parameter with `allows ref struct` takes. */
  checkTypeArgumentKind(arg: Type, parameter: string, owner: string, row: number, allowsRefStruct = false): boolean {
    if (isRestrictedType(arg)) {
      this.error(row, 'CS0306', `型 '${displayType(arg)}' は型引数として使用できません`);
      return false;
    }
    if (isRefLikeType(arg) && !allowsRefStruct) {
      this.error(
        row,
        'CS9244',
        `'${displayType(arg)}' 型は、ジェネリック型またはメソッド '${owner}' のパラメーター '${parameter}' として使用するためには、ref 構造体または ref 構造体を許容する型パラメーターにすることはできません。`
      );
      return false;
    }
    return true;
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
  'System.Net': 'ネットワーク（System.Net）',
  'System.Threading': 'スレッド（System.Threading）',
  'System.Reflection': 'リフレクション（System.Reflection）',
  'System.Diagnostics': 'System.Diagnostics',
  'System.Runtime': 'System.Runtime',
};

/** Describes a namespace that .NET has and the library lacks, which a qualified name may reach without a using. */
export function unavailableDotnetNamespace(path: string[]): string | undefined {
  return isDotnetNamespace(path.join('.')) ? unavailableNamespaceOf(path) : undefined;
}

function unavailableNamespaceOf(path: string[]): string | undefined {
  const name = path.join('.');
  for (const [prefix, what] of Object.entries(UNAVAILABLE_NAMESPACES)) {
    if (name === prefix || name.startsWith(`${prefix}.`)) return what;
  }
  if (path[0] === 'System' || path[0] === 'Microsoft') return `名前空間 ${name}`;
  return undefined;
}
