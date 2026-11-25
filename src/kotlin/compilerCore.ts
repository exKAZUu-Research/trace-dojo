// code-gauge-allow-file fileNcss -- the file holds one layer of the compiler, whose parts share its state.
import type { AnnotationSite } from './annotationSites';
import type { Annotation, Expression, Modifiers, Statement, TypeProjectionRef, TypeRef } from './ast';
import {
  compileError,
  type Core,
  type Eval,
  findClassInScope,
  Flow,
  FunctionContext,
  PackageScope,
  readSlot,
  ReceiverSymbol,
  Scope,
  typeMismatchMessage,
} from './compilerBase';
import { unavailableFunction, unavailableJavaFeature, unavailableMessage } from './convertSupport';
import { keyOf } from './flowKeys';
import { assignedNames } from './flowWrites';
import { isJavaTypeAlias, knownLibraryDeclaration } from './libraryApi';
import type { Frame } from './runtime';
import type {
  ClassSymbol,
  FunctionSymbol,
  MemberSymbol,
  PropertySymbol,
  TypeAliasSymbol,
  TypeParameterSymbol,
} from './symbols';
import { VariableSymbol } from './symbols';
import {
  anyType,
  approximatedReadType,
  asSuper,
  isSubtype,
  memberSubstitutionOf,
  substitutionOf,
} from './typeRelations';
import {
  type ClassType,
  type KType,
  NOTHING,
  nullable,
  resolved,
  substitute,
  type Substitution,
  type TypeArgument,
} from './types';
import { Cell, type KObject, type PrimitiveKind, type Value } from './values';

/** The package of `Turtle`, which no program can name. */
export const TURTLE_PACKAGE = 'tracedojo';

/** The packages every Kotlin file imports, and `Turtle`'s, which trace-dojo provides to every program. */
export const DEFAULT_IMPORTS = [
  TURTLE_PACKAGE,
  'kotlin',
  'kotlin.annotation',
  'kotlin.collections',
  'kotlin.comparisons',
  'kotlin.io',
  'kotlin.ranges',
  'kotlin.sequences',
  'kotlin.text',
  'java.lang',
  'kotlin.jvm',
  // Where the prelude declares Function0 to Function22, which kotlinc names without an import as kotlin's built-ins.
  'kotlin.jvm.functions',
];

/** The names a file sees beyond its own scopes: its package, its imports, and the default imports. */
export interface FileContext {
  packageName: string;
  isLibrary: boolean;
  importedClasses: Map<string, ClassSymbol>;
  importedTypeAliases: Map<string, TypeAliasSymbol>;
  /**
   * The enum entries the file imports by name, by the name it uses, which an alias may give, as `RED` of
   * `import demo.Color.RED`: their enum class and their own name.
   */
  importedEnumEntries: Map<string, { owner: ClassSymbol; entry: string }>;
  importedAnnotations: Map<string, string>;
  importedFunctions: Map<string, FunctionSymbol[]>;
  importedProperties: Map<string, PropertySymbol[]>;
  /** The packages of the file's `import p.*`, which come before the default imports. */
  starPackages: string[];
  /** The opt-in markers that `@file:OptIn` opts the whole file in to. */
  optIns: ClassSymbol[];
}

/** A member found on a receiver's type, with the type arguments that the receiver gives its class. */
export interface MemberRef<T extends MemberSymbol = MemberSymbol> {
  symbol: T;
  substitution: Substitution;
}

export abstract class CompilerCore {
  protected core!: Core;
  readonly packages: Map<string, PackageScope>;
  protected file!: FileContext;
  protected flow = new Flow();
  /** The rows of `// atomic` annotations, which mark the functions declared on or before them. */
  protected atomicRows: ReadonlySet<number> = new Set();
  protected readonly claimedAtomicRows = new Set<number>();
  /** Whether the program records the steps of its statements, which only traces do. */
  protected recordsSteps = false;
  private pendingTypeBounds: { type: ClassType; row: number }[] | undefined;

  constructor(packages: Map<string, PackageScope>) {
    this.packages = packages;
  }

  protected error(row: number, message: string): never {
    throw compileError(row, message);
  }

  protected unavailable(row: number, what: string): never {
    throw compileError(row, unavailableMessage(what));
  }

  protected rejectUnavailableLibraryReference(path: string, row: number): void {
    const known = knownLibraryDeclaration(path, this.visiblePackageLevels());
    const qualified = known && isJavaPath(known) ? known : path;
    const unavailable = unavailableJavaFeature(qualified);
    if (unavailable) this.unavailable(row, unavailable);
    if (isJavaPath(qualified)) {
      this.unavailable(row, `Java のクラスの直接の利用（${qualified}）`);
    }
    if (known) this.unavailable(row, known);
    const unavailableName = unavailableFunction(path);
    if (unavailableName) this.unavailable(row, unavailableName);
  }

  /** Checks the annotations of a declaration written at `site`, as kotlinc does. */
  protected validateAnnotations(scope: Scope, modifiers: Modifiers, site: AnnotationSite): void {
    if (this.file.isLibrary) return;
    this.checkAnnotations(scope, modifiers.annotations, site);
  }

  protected abstract checkAnnotations(scope: Scope, annotations: Annotation[], site: AnnotationSite): void;

  /** The opt-in markers among annotations: annotation classes that `@RequiresOptIn` marks with an error level. */
  protected abstract optInMarkersOf(scope: Scope, annotations: Annotation[]): ClassSymbol[];

  /** The markers annotations opt their declaration in to: those `@OptIn` names and the markers it carries. */
  protected abstract optInsOf(scope: Scope, annotations: Annotation[]): ClassSymbol[];

  /** The opt-in markers the code being compiled is opted in to. */
  protected currentOptIns: ReadonlySet<ClassSymbol> = new Set();

  protected withOptIns<T>(added: Iterable<ClassSymbol>, run: () => T): T {
    const saved = this.currentOptIns;
    this.currentOptIns = new Set([...saved, ...added]);
    try {
      return run();
    } finally {
      this.currentOptIns = saved;
    }
  }

  /** The markers code in a class is opted in to: the file's, and each enclosing class's. */
  protected classOptIns(cls: ClassSymbol | undefined): ClassSymbol[] {
    const optIns = [...this.file.optIns];
    for (let current = cls; current; current = current.outer) optIns.push(...current.optIns);
    return optIns;
  }

  /** Rejects a use of a declaration that an opt-in marker marks, in code that is not opted in to the marker. */
  protected requireOptIn(markers: readonly ClassSymbol[], name: string, row: number): void {
    if (this.file.isLibrary) return;
    for (const marker of markers) {
      if (!this.currentOptIns.has(marker))
        this.error(row, `${name} を使うには、@OptIn(${marker.name}::class) か @${marker.name} が必要です。`);
    }
  }

  /** The level of a declaration's `@Deprecated`, whose `ERROR` and `HIDDEN` reject uses of the declaration. */
  protected abstract deprecationLevel(scope: Scope, modifiers: Modifiers): 'WARNING' | 'ERROR' | 'HIDDEN' | undefined;

  protected packageScope(name: string): PackageScope {
    let scope = this.packages.get(name);
    if (!scope) {
      scope = new PackageScope();
      this.packages.set(name, scope);
    }
    return scope;
  }

  /** The packages whose top-level declarations a file sees, nearest first, grouped by how near they are. */
  protected visiblePackageLevels(): string[][] {
    return [[this.file.packageName], [...new Set(this.file.starPackages)], DEFAULT_IMPORTS];
  }

  // Types.

  /** @param allowsBareClass Whether a generic class may be written without arguments, as `is List` may. */
  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  // code-gauge-allow functionNcss -- the type is resolved and checked in the order the written name and arguments determine it.
  resolveType(scope: Scope, ref: TypeRef, allowsBareClass = false): KType {
    if (ref.kind === 'function') {
      return {
        kind: 'function',
        receiver: ref.receiver ? this.resolveType(scope, ref.receiver) : undefined,
        params: ref.params.map((param) => this.resolveType(scope, param)),
        returnType: this.resolveType(scope, ref.returnType),
        nullable: ref.nullable,
        isSuspend: ref.isSuspend || undefined,
        contextTypes:
          ref.contextTypes.length > 0 ? ref.contextTypes.map((each) => this.resolveType(scope, each)) : undefined,
      };
    }
    const [first, ...rest] = ref.parts;
    if (rest.length === 0) {
      const param = this.findTypeParameter(scope, first.name);
      if (param) {
        if (first.args.length > 0) this.error(ref.row, `型引数 ${first.name} には型引数を書けません。`);
        if (ref.definitelyNonNull) return { kind: 'param', param, nullable: false, definitelyNonNull: true };
        return { kind: 'param', param, nullable: ref.nullable };
      }
      if (ref.definitelyNonNull) this.error(ref.row, '& Any の前には、型引数を書いてください。');
      if (first.name === 'Nothing' && !this.findClass(scope, 'Nothing')) {
        return ref.nullable ? nullable(NOTHING) : NOTHING;
      }
      const alias = this.findTypeAlias(scope, first.name);
      if (alias) return this.expandTypeAlias(scope, alias, first.args, ref.nullable, ref.row);
    }
    const local = this.findClass(scope, first.name);
    const names = ref.parts.map((part) => part.name);
    const found = local ? undefined : this.findQualifiedClass(names);
    const qualified = found && this.canName(found) ? found : undefined;
    let cls = local ?? qualified;
    if (!cls) {
      const path = names.join('.');
      this.rejectUnavailableLibraryReference(path, ref.row);
      this.error(ref.row, `型 ${path} が見つかりません。`);
    }
    // A fully qualified name such as `kotlin.reflect.KProperty<*>` carries its arguments on its last part.
    const consumed = qualified ? ref.parts.length : 1;
    const argumentsPart = qualified ? (ref.parts.at(-1) as typeof first) : first;
    // A qualifier such as `Map` in `Map.Entry<K, V>` names a scope, whose own type arguments it may leave out.
    const isQualifier = consumed < ref.parts.length;
    let args: TypeArgument[] =
      isQualifier && argumentsPart.args.length === 0
        ? []
        : allowsBareClass && argumentsPart.args.length === 0 && !isQualifier
          ? cls.typeParameters.map((): TypeArgument => ({ variance: 'star' }))
          : this.resolveArguments(scope, cls, argumentsPart.args, ref.row);
    for (const [index, part] of ref.parts.slice(consumed).entries()) {
      const nestedAlias = cls.typeAliases.get(part.name);
      if (nestedAlias && index === ref.parts.length - consumed - 1)
        return this.expandTypeAlias(scope, nestedAlias, part.args, ref.nullable, ref.row);
      const nested: ClassSymbol | undefined = cls.nested.get(part.name);
      if (!nested) this.error(ref.row, `型 ${cls.name}.${part.name} が見つかりません。`);
      cls = nested;
      args =
        allowsBareClass && part.args.length === 0
          ? cls.typeParameters.map((): TypeArgument => ({ variance: 'star' }))
          : this.resolveArguments(scope, cls, part.args, ref.row);
    }
    this.checkNestedAccessible(scope, cls, ref.row);
    this.requireOptIn(cls.optInMarkers, cls.name, ref.row);
    // A program's FunctionN<P..., R> is the function type (P...) -> R, as kotlinc reads it, which lambdas then fit.
    const arity = this.core.functionInterfaces.indexOf(cls);
    const types = args.flatMap((argument) => (argument.variance === 'star' ? [] : [argument.type]));
    if (arity !== -1 && !this.file.isLibrary && types.length === args.length)
      return {
        kind: 'function',
        receiver: undefined,
        params: types.slice(0, -1),
        returnType: types.at(-1) as KType,
        nullable: ref.nullable,
      };
    return { kind: 'class', cls, args, nullable: ref.nullable };
  }

  private resolveArguments(scope: Scope, cls: ClassSymbol, refs: TypeProjectionRef[], row: number): TypeArgument[] {
    if (refs.length !== cls.typeParameters.length) {
      if (refs.length === 0) this.error(row, `型 ${cls.name} には型引数が ${cls.typeParameters.length} 個要ります。`);
      this.error(row, `型 ${cls.name} の型引数の数が違います。`);
    }
    const args = refs.map((projection): TypeArgument => {
      if (projection.star) return { variance: 'star' };
      return { variance: projection.variance ?? 'inv', type: this.resolveType(scope, projection.type) };
    });
    if (!this.file.isLibrary && cls.typeParameters.some((param) => param.bounds.length > 0)) {
      const type: ClassType = { kind: 'class', cls, args, nullable: false };
      if (this.pendingTypeBounds) this.pendingTypeBounds.push({ type, row });
      else this.checkTypeBounds(type, row);
    }
    return args;
  }

  protected checkTypeBoundsAfter<T>(resolve: () => T): T {
    const previous = this.pendingTypeBounds;
    const pending: NonNullable<CompilerCore['pendingTypeBounds']> = [];
    this.pendingTypeBounds = pending;
    try {
      const result = resolve();
      for (const { type, row } of pending) this.checkTypeBounds(type, row);
      return result;
    } finally {
      this.pendingTypeBounds = previous;
    }
  }

  private checkTypeBounds(type: ClassType, row: number): void {
    const substitution = substitutionOf(type);
    for (const [index, parameter] of type.cls.typeParameters.entries()) {
      const argument = type.args[index];
      if (argument.variance === 'star') continue;
      for (const bound of parameter.bounds) {
        const expected = substitute(bound, substitution);
        if (!isSubtype(argument.type, expected)) this.error(row, typeMismatchMessage(expected, argument.type));
      }
    }
  }

  protected findTypeParameter(scope: Scope | undefined, name: string): TypeParameterSymbol | undefined {
    for (let current = scope; current; current = current.parent) {
      const found = current.typeParameters.get(name);
      if (found) return found;
    }
    return undefined;
  }

  /** A type alias's expansion with the type arguments of a use, as `StrMap<Int>` is `Map<String, Int>`. */
  protected expandTypeAlias(
    scope: Scope,
    alias: TypeAliasSymbol,
    refs: TypeProjectionRef[],
    isNullable: boolean,
    row: number
  ): KType {
    const expansion = this.typeAliasExpansion(alias, row);
    if (refs.length !== alias.typeParameters.length) this.error(row, `型の別名 ${alias.name} の型引数の数が違います。`);
    const substitution = new Map<TypeParameterSymbol, KType>();
    for (const [index, projection] of refs.entries()) {
      if (projection.star || projection.variance)
        this.error(row, `型の別名 ${alias.name} の型引数には、* や in・out を書けません。`);
      substitution.set(alias.typeParameters[index], this.resolveType(scope, projection.type));
    }
    const type = substitute(expansion, substitution);
    return isNullable ? nullable(type) : type;
  }

  protected typeAliasExpansion(alias: TypeAliasSymbol, row: number): KType {
    if (alias.expansion) return alias.expansion;
    if (alias.isResolving) this.error(row, `型の別名 ${alias.name} が自分自身を使っています。`);
    alias.isResolving = true;
    try {
      const { typeParameters, expansion } = alias.resolve();
      alias.typeParameters = typeParameters;
      alias.expansion = expansion;
      return expansion;
    } finally {
      alias.isResolving = false;
    }
  }

  /**
   * The type alias a simple name stands for, when no class of the name is nearer: in the classes around the scope, then
   * the file's explicit imports, its package, and its star imports.
   */
  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  protected findTypeAlias(scope: Scope | undefined, name: string): TypeAliasSymbol | undefined {
    if (findClassInScope(scope, name)) return undefined;
    for (let current = scope; current; current = current.parent) {
      for (let cls = current.staticClass; cls; cls = cls.outer) {
        const nested = cls.typeAliases.get(name);
        if (nested) return nested;
      }
    }
    const imported = this.file.importedTypeAliases.get(name);
    if (imported) return imported;
    if (this.file.importedClasses.has(name)) return undefined;
    const own = this.packages.get(this.file.packageName)?.typeAliases.get(name);
    if (own) return own;
    if (this.packages.get(this.file.packageName)?.classes.has(name)) return undefined;
    for (const packageName of this.file.starPackages) {
      const found = this.packages.get(packageName)?.typeAliases.get(name);
      if (found) return found;
      if (this.packages.get(packageName)?.classes.has(name)) return undefined;
    }
    return undefined;
  }

  /**
   * The class a simple name stands for: in the scopes, then the file's explicit imports, its package, its star imports,
   * and the defaults. A type alias of a class stands for that class.
   */
  findClass(scope: Scope | undefined, name: string): ClassSymbol | undefined {
    const alias = this.findTypeAlias(scope, name);
    if (alias) {
      const expansion = resolved(this.typeAliasExpansion(alias, alias.row));
      return expansion.kind === 'class' ? expansion.cls : undefined;
    }
    const local = findClassInScope(scope, name);
    if (local) return local;
    const imported = this.file.importedClasses.get(name);
    if (imported) return imported;
    const own = this.packages.get(this.file.packageName)?.classes.get(name);
    if (own && this.canName(own)) return own;
    const fromWildcard = this.findClassInPackages(name, this.file.starPackages);
    if (fromWildcard) return fromWildcard;
    const omittedJava = this.file.starPackages.filter(isJavaPath);
    const javaImport = knownLibraryDeclaration(name, [omittedJava]);
    const fromDefaults = this.findClassInPackages(name, DEFAULT_IMPORTS);
    if (!javaImport || (fromDefaults && isJavaTypeAlias(javaImport, fromDefaults.kotlinName))) return fromDefaults;
    return undefined;
  }

  private findClassInPackages(name: string, packages: string[]): ClassSymbol | undefined {
    for (const packageName of packages) {
      const found = this.packages.get(packageName)?.classes.get(name);
      if (found && this.canName(found)) return found;
    }
    return undefined;
  }

  /**
   * Whether the code compiling may name a class: a program sees only the library's public classes, as code outside a
   * module sees, so the internal classes that implement the library, as java.util.TreeMap, read as unknown to it.
   */
  protected canName(cls: ClassSymbol): boolean {
    return this.file.isLibrary || !cls.isLibrary || cls.visibility === 'public';
  }

  /** The class a fully qualified name such as `kotlin.collections.List` stands for. */
  protected findQualifiedClass(path: string[]): ClassSymbol | undefined {
    // A split of 0 looks the path up in the default package, as `Config.Companion` names a class there.
    for (let split = path.length - 1; split >= 0; split--) {
      const scope = this.packages.get(path.slice(0, split).join('.'));
      let cls = scope?.classes.get(path[split]);
      if (!cls) continue;
      for (const name of path.slice(split + 1)) {
        cls = cls.nested.get(name);
        if (!cls) return undefined;
      }
      return cls;
    }
    return undefined;
  }

  /**
   * The functions of a name in the visible packages, nearest first, each level a group of equally near ones; explicit
   * imports come before the current package, as in Kotlin.
   */
  protected topLevelFunctions(name: string, includeEmpty = false): FunctionSymbol[][] {
    const imported = this.file.importedFunctions.get(name) ?? [];
    const own = this.packages.get(this.file.packageName)?.functions.get(name) ?? [];
    const levels = [imported, own.filter((symbol) => !imported.includes(symbol))];
    for (const level of this.visiblePackageLevels().slice(1)) {
      levels.push(level.flatMap((packageName) => this.packages.get(packageName)?.functions.get(name) ?? []));
    }
    return includeEmpty ? levels : levels.filter((level) => level.length > 0);
  }

  protected topLevelProperties(name: string, includeEmpty = false): PropertySymbol[][] {
    const imported = this.file.importedProperties.get(name) ?? [];
    const own = this.packages.get(this.file.packageName)?.properties.get(name) ?? [];
    const levels = [imported, own.filter((symbol) => !imported.includes(symbol))];
    for (const level of this.visiblePackageLevels().slice(1)) {
      levels.push(level.flatMap((packageName) => this.packages.get(packageName)?.properties.get(name) ?? []));
    }
    return includeEmpty ? levels : levels.filter((level) => level.length > 0);
  }

  /** The nearest top-level property of a name that takes no receiver, which a bare name reads and assigns. */
  protected topLevelPlainProperty(name: string): PropertySymbol | undefined {
    for (const level of this.topLevelProperties(name)) {
      const property = level.find((candidate) => !candidate.extensionReceiver);
      if (property) return property;
    }
    return undefined;
  }

  // Members.

  /** The members of a name on a receiver type, those of subclasses hiding the ones they override. */
  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  protected membersOf<T extends MemberSymbol>(type: KType, name: string, kind: T['kind']): MemberRef<T>[] {
    const actual = resolved(type);
    if (actual.kind === 'param') {
      const bounds = actual.param.bounds.length > 0 ? actual.param.bounds : [anyType()];
      return bounds.flatMap((bound) => this.membersOf<T>(bound, name, kind));
    }
    if (actual.kind === 'function') {
      return this.membersOf<T>(
        { kind: 'class', cls: this.core.function, args: [{ variance: 'star' }], nullable: false },
        name,
        kind
      );
    }
    if (actual.kind === 'nothing') return [];
    if (actual.kind !== 'class') return [];
    const found: MemberRef<T>[] = [];
    const visited = new Set<ClassSymbol>();
    const queue: ClassType[] = [actual];
    while (queue.length > 0) {
      const current = queue.shift() as ClassType;
      if (visited.has(current.cls)) continue;
      visited.add(current.cls);
      const substitution = memberSubstitutionOf(current);
      for (const member of current.cls.members.get(name) ?? []) {
        if (member.kind !== kind) continue;
        const types = allowsProjectedSearch(member)
          ? new Map([...substitution].map(([param, type]) => [param, approximatedReadType(type)]))
          : substitution;
        this.addMemberReference(found, { symbol: member as T, substitution: types }, actual.cls);
      }
      for (const supertype of current.cls.supertypes) queue.push(substitute(supertype, substitution) as ClassType);
      if (current.cls.supertypes.length === 0 && current.cls !== this.core.any) {
        queue.push(anyType());
      }
    }
    return found;
  }

  private addMemberReference<T extends MemberSymbol>(
    found: MemberRef<T>[],
    member: MemberRef<T>,
    receiver: ClassSymbol
  ): void {
    const implementation = receiver.dispatch(member.symbol);
    const same = found.findIndex(
      (existing) =>
        existing.symbol.root === member.symbol.root ||
        overrides(existing.symbol, member.symbol) ||
        receiver.dispatch(existing.symbol) === implementation
    );
    if (same === -1) found.push(member);
    else if (member.symbol.root === implementation.root && found[same].symbol.root !== implementation.root)
      found[same] = member;
  }

  /** The type of a class's own `this`, with the class's type parameters as its arguments. */
  protected thisTypeOf(cls: ClassSymbol): ClassType {
    return cls.selfType;
  }

  /** The supertype `asSuper` finds, or the type itself for a type that is not a class type. */
  protected supertypeAs(type: KType, cls: ClassSymbol): ClassType | undefined {
    const actual = resolved(type);
    if (actual.kind === 'class') return asSuper(actual, cls);
    if (actual.kind === 'param') {
      for (const bound of actual.param.bounds) {
        const found = this.supertypeAs(bound, cls);
        if (found) return found;
      }
    }
    return undefined;
  }

  // Variables, receivers, and captures.

  /** The implicit receivers a scope sees, innermost first. */
  protected receiversOf(scope: Scope): ReceiverSymbol[] {
    const receivers: ReceiverSymbol[] = [];
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      if (current.receiver) receivers.push(current.receiver);
    }
    return receivers;
  }

  /**
   * Drops the smart casts of the variables that code assigns, for code that may run again after its own writes (a
   * loop body, a lambda that may be invoked again) or that an exception may enter after any of them (a catch clause).
   */
  protected forgetAssignedIn(scope: Scope, code: Statement[] | Expression): void {
    for (const name of assignedNames(code)) {
      const variable = this.findVariable(scope, name);
      if (variable) this.flow.forget(keyOf(variable));
    }
  }

  protected primitiveOf(type: KType): PrimitiveKind | undefined {
    const actual = resolved(type);
    if (actual.kind !== 'class' || actual.nullable) return undefined;
    return this.core.primitives.get(actual.cls);
  }

  /**
   * Where the class a simple name means sits among the levels of `topLevelFunctions`: -1 for a class of the scopes,
   * then explicit imports, the current package, star imports and the defaults, as `findClass` looks them up.
   */
  protected classLevel(scope: Scope, name: string): number {
    if (findClassInScope(scope, name)) return -1;
    if (this.file.importedClasses.has(name)) return 0;
    if (this.packages.get(this.file.packageName)?.classes.has(name)) return 1;
    return this.file.starPackages.some((packageName) => this.packages.get(packageName)?.classes.has(name)) ? 2 : 3;
  }

  /** The local functions of a name that a scope sees, innermost first, which hide the other functions of the name. */
  protected localFunctions(scope: Scope, name: string): FunctionSymbol[] {
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      const found = current.functions.get(name);
      if (found && found.length > 0) return found;
    }
    return [];
  }

  protected findVariable(scope: Scope, name: string): VariableSymbol | undefined {
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      const found = current.variables.get(name);
      if (found) return found;
    }
    return undefined;
  }

  /** Where a variable's value lives as `context` sees it: its own frame's slot, or what a lambda captured. */
  protected variableAccess(
    context: FunctionContext,
    variable: VariableSymbol
  ): { read: Eval; write: (frame: Frame, value: Value) => void } {
    if (variable.owner === context) {
      const { slot } = variable;
      return {
        read: (frame) => readSlot(frame.locals[slot]),
        write: (frame, value) => {
          const current = frame.locals[slot];
          if (current instanceof Cell) current.value = value;
          else frame.locals[slot] = variable.isCell ? new Cell(value) : value;
        },
      };
    }
    if (variable.isVar) variable.isCell = true;
    const index = context.captureIndex(variable);
    return {
      read: (frame) => readSlot(frame.captured[index]),
      write: (frame, value) => {
        (frame.captured[index] as Cell).value = value;
      },
    };
  }

  protected backingFieldAccess(
    context: FunctionContext,
    field: NonNullable<VariableSymbol['backingField']>
  ): { read: Eval; write: (frame: Frame, value: Value) => void } {
    const { property } = field;
    if (!context.isProbe) property.backingFieldReferenced = true;
    const receiver = field.receiver && this.receiverAccess(context, field.receiver);
    const storage = receiver
      ? (frame: Frame) => (receiver(frame) as KObject).fields
      : (frame: Frame) => frame.runtime.globals;
    return {
      read: (frame) => storage(frame)[property.slot as number],
      write: (frame, value) => {
        storage(frame)[property.slot as number] = value;
      },
    };
  }

  /**
   * The instance whose constructor header (defaults, superclass arguments, delegates) is compiling. The header's scope
   * leaves the instance out, as Kotlin does, so this only words the error for a name that only its members declare.
   */
  protected headerInstance: KType | undefined;

  /** Rejects a name that nothing but a member of the instance a constructor header builds declares. */
  protected rejectHeaderMember(name: string, row: number): void {
    const instance = this.headerInstance;
    if (!instance) return;
    if (this.membersOf(instance, name, 'property').length + this.membersOf(instance, name, 'function').length > 0)
      this.error(row, 'インスタンスの初期化が終わる前なので、this やそのメンバーは使えません。');
  }

  /** Reads an implicit receiver, which a lambda inside the function that has it captures. */
  protected receiverAccess(context: FunctionContext, receiver: ReceiverSymbol): Eval {
    const path = receiver.outerPath;
    if (receiver.context === context && path)
      return (frame) => {
        let value = frame.thisValue;
        for (const inner of path) value = (value as KObject).fields[inner.outerSlot as number];
        return value;
      };
    const { slot } = receiver;
    if (receiver.context === context && slot !== undefined) return (frame) => frame.locals[slot] as Value;
    if (receiver.context === context) return (frame) => frame.thisValue;
    const index = context.captureIndex(receiver);
    return (frame) => frame.captured[index] as Value;
  }

  /** The frame of an enclosing function, which a `return` in a lambda of an inline call leaves. */
  protected frameAccess(context: FunctionContext, target: FunctionContext): (frame: Frame) => Frame {
    if (target === context) return (frame) => frame;
    const index = context.captureIndex(target);
    return (frame) => frame.captured[index] as Frame;
  }

  /**
   * Makes code that calls a local function or creates a local class elsewhere than where it is declared capture what
   * the declaration made, as it captures a variable, so that a lambda outliving the declaring block keeps it.
   */
  protected useLocalEnv(context: FunctionContext, envVariable: VariableSymbol | undefined): void {
    if (!envVariable || envVariable.owner === context) return;
    const index = context.captureIndex(envVariable);
    (context.info.localEnvs ??= new Map()).set(envVariable, index);
  }

  /** Builds what a lambda captures, as the function creating it sees each captured thing. */
  protected captureBuilder(outer: FunctionContext, lambda: FunctionContext): (frame: Frame) => unknown[] {
    const readers = lambda.captures.map((source): ((frame: Frame) => unknown) => {
      if (source instanceof VariableSymbol) {
        if (source.owner === outer) {
          const { slot } = source;
          return (frame) => frame.locals[slot];
        }
        const index = outer.captureIndex(source);
        return (frame) => frame.captured[index];
      }
      if (source instanceof ReceiverSymbol) return this.receiverAccess(outer, source);
      return this.frameAccess(outer, source);
    });
    return (frame) => readers.map((read) => read(frame));
  }

  // code-gauge-allow functionParameterCount -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  protected newVariable(
    scope: Scope,
    context: FunctionContext,
    name: string | undefined,
    type: KType,
    isVar: boolean,
    row: number,
    isShown = true
  ): VariableSymbol {
    const localName = name ?? '_';
    const slot = context.allocate(localName, type, isShown && !context.info.isLibrary);
    const variable = new VariableSymbol(localName, type, isVar, 0, slot, row);
    variable.owner = context;
    if (name !== undefined) this.bindLocalVariable(scope, variable);
    return variable;
  }

  protected bindLocalVariable(scope: Scope, variable: VariableSymbol): void {
    const { name, row } = variable;
    // The body's scope includes parameters, which Kotlin allows locals to shadow.
    if (!name.startsWith('\0') && scope.variables.get(name)?.isParameter === false) {
      this.error(row, `${name} は、すでに宣言されています。`);
    }
    scope.variables.set(name, variable);
  }

  /** Declares a parameter, which a local of the body may hide. */
  protected newParameter(
    scope: Scope,
    context: FunctionContext,
    name: string | undefined,
    type: KType,
    row: number
  ): VariableSymbol {
    const variable = this.newVariable(scope, context, name, type, false, row, name !== undefined);
    variable.isParameter = true;
    return variable;
  }

  protected rejectDuplicateNames(declarations: { name: string | undefined; row: number }[]): void {
    const names = new Set<string>();
    for (const { name, row } of declarations) {
      if (name === undefined) continue;
      if (names.has(name)) this.error(row, `${name} が2回宣言されています。`);
      names.add(name);
    }
  }

  protected checkNestedAccessible(scope: Scope | undefined, nested: ClassSymbol, row: number): void {
    for (let current = nested; current.outer; current = current.outer) {
      const { outer, visibility } = current;
      if (visibility !== 'private' && visibility !== 'protected') continue;
      if (this.canSeeNestedClass(scope, outer, visibility)) continue;
      this.error(row, `${current.name} は ${visibility} なので、${outer.name} の外からは使えません。`);
    }
  }

  private canSeeNestedClass(
    scope: Scope | undefined,
    outer: ClassSymbol,
    visibility: 'private' | 'protected'
  ): boolean {
    for (let current = scope; current; current = current.parent) {
      for (let cls = current.receiver?.cls ?? current.staticClass; cls; cls = cls.outer) {
        if (visibility === 'private' ? cls === outer : cls.isSubclassOf(outer)) return true;
      }
    }
    return false;
  }
}

/** Whether `member` overrides `other`, directly or through members in between. */
function overrides(member: MemberSymbol, other: MemberSymbol): boolean {
  return member.overridden.some((overridden) => overridden === other || overrides(overridden, other));
}

export { FunctionContext, Scope };

const COLLECTION_SEARCH_NAMES = new Set([
  'contains',
  'containsAll',
  'containsKey',
  'containsValue',
  'get',
  'getOrDefault',
  'indexOf',
  'lastIndexOf',
  'remove',
  'removeAll',
  'retainAll',
]);

function allowsProjectedSearch(member: MemberSymbol): boolean {
  return (
    member.kind === 'function' &&
    member.isLibrary &&
    member.owner?.kotlinName.startsWith('kotlin.collections.') === true &&
    COLLECTION_SEARCH_NAMES.has(member.name)
  );
}

function isJavaPath(path: string): boolean {
  return path.startsWith('java.') || path.startsWith('javax.');
}
