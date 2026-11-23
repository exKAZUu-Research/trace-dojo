import type { Modifiers, TypeProjectionRef, TypeRef } from './ast';
import {
  type Compiled,
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
import { unavailableJavaFeature, unavailableMessage } from './convertSupport';
import { isJavaTypeAlias, isKnownLibraryAnnotation, knownLibraryDeclaration } from './libraryApi';
import type { Frame } from './runtime';
import type { ClassSymbol, FunctionSymbol, MemberSymbol, PropertySymbol, TypeParameterSymbol } from './symbols';
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
import { Cell, type KObject, type Value } from './values';

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
];

/** The names a file sees beyond its own scopes: its package, its imports, and the default imports. */
export interface FileContext {
  packageName: string;
  isLibrary: boolean;
  importedClasses: Map<string, ClassSymbol>;
  importedAnnotations: Map<string, string>;
  importedFunctions: Map<string, FunctionSymbol[]>;
  importedProperties: Map<string, PropertySymbol[]>;
  /** The packages of the file's `import p.*`, which come before the default imports. */
  starPackages: string[];
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
  }

  protected validateAnnotations(scope: Scope, modifiers: Modifiers): void {
    if (this.file.isLibrary) return;
    for (const { qualifiedName, name, row, markers } of modifiers.annotations) {
      if (!qualifiedName && this.findClass(scope, name))
        this.error(row, `${name} はアノテーションクラスではありません。`);
      for (const marker of markers ?? []) this.validateAnnotationMarker(scope, marker.path, marker.row);
    }
  }

  private validateAnnotationMarker(scope: Scope, path: string[], row: number): void {
    const name = path.join('.');
    const qualified = path.length > 1;
    const ordinary = qualified ? this.findQualifiedClass(path) : this.findClass(scope, name);
    const libraryName = qualified
      ? name
      : (this.file.importedAnnotations.get(name) ?? knownLibraryDeclaration(name, this.visiblePackageLevels()));
    if (!ordinary && libraryName && isKnownLibraryAnnotation(libraryName)) return;
    if (ordinary || (libraryName && knownLibraryDeclaration(libraryName, [])))
      this.error(row, `${name} はアノテーションクラスではありません。`);
    this.error(row, `${name} 型が見つかりません。`);
  }

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
      };
    }
    const [first, ...rest] = ref.parts;
    if (rest.length === 0) {
      const param = this.findTypeParameter(scope, first.name);
      if (param) {
        if (first.args.length > 0) this.error(ref.row, `型引数 ${first.name} には型引数を書けません。`);
        return { kind: 'param', param, nullable: ref.nullable };
      }
      if (first.name === 'Nothing' && !this.findClass(scope, 'Nothing')) {
        return ref.nullable ? nullable(NOTHING) : NOTHING;
      }
    }
    const local = this.findClass(scope, first.name);
    const names = ref.parts.map((part) => part.name);
    const qualified = local ? undefined : this.findQualifiedClass(names);
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
    for (const part of ref.parts.slice(consumed)) {
      const nested: ClassSymbol | undefined = cls.nested.get(part.name);
      if (!nested) this.error(ref.row, `型 ${cls.name}.${part.name} が見つかりません。`);
      cls = nested;
      args =
        allowsBareClass && part.args.length === 0
          ? cls.typeParameters.map((): TypeArgument => ({ variance: 'star' }))
          : this.resolveArguments(scope, cls, part.args, ref.row);
    }
    this.checkNestedAccessible(scope, cls, ref.row);
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

  /** The class a simple name stands for: in the scopes, then in the file's package, its imports, and the defaults. */
  findClass(scope: Scope | undefined, name: string): ClassSymbol | undefined {
    const local = findClassInScope(scope, name);
    if (local) return local;
    const imported = this.file.importedClasses.get(name);
    if (imported) return imported;
    const own = this.packages.get(this.file.packageName)?.classes.get(name);
    if (own) return own;
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
      if (found) return found;
    }
    return undefined;
  }

  /** The class a fully qualified name such as `kotlin.collections.List` stands for. */
  protected findQualifiedClass(path: string[]): ClassSymbol | undefined {
    for (let split = path.length - 1; split >= 1; split--) {
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

  /** Reads an implicit receiver, which a lambda inside the function that has it captures. */
  protected receiverAccess(context: FunctionContext, receiver: ReceiverSymbol): Eval {
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

  protected compiledConstant(compiled: Compiled): Value | undefined {
    return compiled.constant;
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
