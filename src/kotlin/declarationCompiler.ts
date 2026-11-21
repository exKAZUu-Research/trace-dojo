// code-gauge-allow-file fileNcss 819 -- The declaration compiler shares symbol and class-linking logic.
import { misplacedAtomicMessage } from '../interpreter/traceAnnotations';
import type {
  ClassDecl,
  ClassParameterDecl,
  Declaration,
  FunctionDecl,
  Import,
  KotlinFile,
  MemberDecl,
  Modifiers,
  ParameterDecl,
  PropertyDecl,
  SuperSpec,
  TypeParameterDecl,
} from './ast';
import { type Compiled, convertRepr, FunctionContext, type PackageScope, type Repr, Scope } from './compilerBase';
import type { FileContext } from './compilerCore';
import { unavailableMessage } from './convertSupport';
import { callFunction, isVirtual, propertyRepr } from './dispatch';
import { hashOf, stringHash, stringOf, valueEquals } from './format';
import { type NativeFunction, type NativeProperty, typeRefText } from './nativeTypes';
import { toInt32 } from './operators';
import { type Frame, MISSING } from './runtime';
import { StatementCompiler } from './statementCompiler';
import {
  ClassSymbol,
  type ClassSymbolKind,
  FunctionSymbol,
  type MemberSymbol,
  type ParameterSymbol,
  PropertySymbol,
  TypeParameterSymbol,
  type Visibility,
} from './symbols';
import { anyType, isSameType, isSubtype } from './typeRelations';
import { type ClassType, type KType, NOTHING, resolved, substitute, type Substitution, typeToString } from './types';
import { Boxed, KObject, type Value } from './values';

export interface ClassEntry {
  decl: ClassDecl;
  symbol: ClassSymbol;
  file: FileContext;
  /** The scope of the class's body: its type parameters, nested classes, and companion. */
  scope: Scope;
  outer: ClassEntry | undefined;
  /** The fields of the delegates of `: I by expression`, by the interface. */
  delegateFields: { type: ClassType; slot: number; spec: Extract<SuperSpec, { kind: 'delegated' }> }[];
  constructorSymbol: FunctionSymbol | undefined;
  /** Parameters of the primary constructor that declare properties, with those properties. */
  parameterProperties: { param: ClassParameterDecl; symbol: PropertySymbol; index: number }[];
}

export interface FunctionEntry {
  kind: 'function';
  decl: FunctionDecl;
  symbol: FunctionSymbol;
  file: FileContext;
  scope: Scope;
  cls: ClassEntry | undefined;
  state: 'pending' | 'compiling' | 'done';
}

export interface PropertyEntry {
  kind: 'property';
  decl: PropertyDecl;
  symbol: PropertySymbol;
  file: FileContext;
  scope: Scope;
  cls: ClassEntry | undefined;
  state: 'pending' | 'compiling' | 'done';
  /** The initializer, compiled in the class's initializer or the file's, when its type had to be inferred first. */
  initializer: Compiled | undefined;
  /** The slot of a delegate the property is delegated to. */
  delegateSlot: number | undefined;
  /** For a top-level property, the global that holds its delegate. */
  delegateGlobal?: number;
}

const ACCESS_KEYWORDS: Visibility[] = ['private', 'protected', 'internal', 'public'];

const VISIBILITY_RANK: Record<Visibility, number> = { private: 0, protected: 1, internal: 2, public: 2 };

function visibilityOf(modifiers: Modifiers): Visibility {
  return ACCESS_KEYWORDS.find((keyword) => modifiers.keywords.has(keyword)) ?? 'public';
}

export abstract class DeclarationCompiler extends StatementCompiler {
  protected readonly classEntries: ClassEntry[] = [];
  protected readonly entryOfClass = new Map<ClassSymbol, ClassEntry>();
  protected readonly functionEntries: FunctionEntry[] = [];
  protected readonly propertyEntries: PropertyEntry[] = [];
  protected readonly entryOfFunction = new Map<FunctionSymbol, FunctionEntry>();
  protected readonly entryOfProperty = new Map<PropertySymbol, PropertyEntry>();
  protected globalCount = 0;
  protected natives: ReadonlyMap<string, NativeFunction> = new Map();
  protected nativeProperties: ReadonlyMap<string, NativeProperty> = new Map();
  /** The natives a library declaration names that have no implementation, which the library reports at once. */
  readonly missingNatives: string[] = [];

  // Phase 1: classes.

  protected declareClasses(file: KotlinFile, context: FileContext): void {
    const packageScope = this.packageScope(context.packageName);
    for (const declaration of file.declarations) {
      if (declaration.kind !== 'class') continue;
      if (packageScope.classes.has(declaration.name)) {
        this.error(declaration.row, `クラス ${declaration.name} が2回宣言されています。`);
      }
      const entry = this.declareClass(declaration, context, undefined);
      packageScope.classes.set(declaration.name, entry.symbol);
    }
  }

  // code-gauge-allow functionNcss 45 -- One flag per modifier of a class.
  // code-gauge-allow functionCognitiveComplexity 24 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private declareClass(decl: ClassDecl, file: FileContext, outer: ClassEntry | undefined): ClassEntry {
    const kind: ClassSymbolKind = decl.classKind === 'enum' ? 'enum' : decl.classKind;
    const prefix = outer ? `${outer.symbol.qualifiedName}$` : file.packageName ? `${file.packageName}.` : '';
    const kotlinPrefix = outer ? `${outer.symbol.kotlinName}.` : file.packageName ? `${file.packageName}.` : '';
    const symbol = new ClassSymbol(kind, decl.name, `${prefix}${decl.name}`, outer?.symbol);
    symbol.kotlinName = `${kotlinPrefix}${decl.name}`;
    const { keywords } = decl.modifiers;
    symbol.isOpen = keywords.has('open');
    symbol.isAbstract = keywords.has('abstract') || kind === 'interface';
    symbol.isSealed = keywords.has('sealed');
    if (symbol.isSealed) symbol.isAbstract = true;
    symbol.isData = keywords.has('data');
    symbol.isValue = keywords.has('value');
    symbol.isFunInterface = decl.isFunInterface;
    symbol.isNative = file.isLibrary && keywords.has('external');
    symbol.visibility = visibilityOf(decl.modifiers);
    symbol.row = decl.row;
    symbol.isLibrary = file.isLibrary;
    symbol.enumEntries = decl.enumEntries.map((entry, ordinal) => ({ name: entry.name, ordinal }));
    this.checkClassHeader(decl, symbol);
    const scope = new Scope(outer?.scope, undefined);
    scope.staticClass = symbol;
    const entry: ClassEntry = {
      decl,
      symbol,
      file,
      scope,
      outer,
      delegateFields: [],
      constructorSymbol: undefined,
      parameterProperties: [],
    };
    this.classEntries.push(entry);
    this.entryOfClass.set(symbol, entry);
    for (const member of decl.members) {
      if (member.kind !== 'class') continue;
      if (member.classKind === 'companion') {
        if (symbol.companion) this.error(member.row, 'companion object は1つしか書けません。');
        const companion = this.declareClass(member, file, entry);
        symbol.companion = companion.symbol;
        symbol.nested.set(member.name, companion.symbol);
        continue;
      }
      const nested = this.declareClass(member, file, entry);
      symbol.nested.set(member.name, nested.symbol);
    }
    return entry;
  }

  private checkClassHeader(decl: ClassDecl, symbol: ClassSymbol): void {
    this.rejectDuplicateNames(decl.enumEntries);
    const params = decl.primaryConstructor?.params ?? [];
    this.rejectDuplicateNames(params);
    if (symbol.isData && symbol.kind === 'class') {
      if (params.length === 0)
        this.error(decl.row, 'data class には、プロパティを1つ以上持つコンストラクタが要ります。');
      const plain = params.find((param) => !param.binding);
      if (plain)
        this.error(plain.row, `data class のコンストラクタの引数 ${plain.name} には、val か var を付けてください。`);
    }
    if (symbol.isData && (symbol.isOpen || symbol.isAbstract || symbol.isSealed)) {
      this.error(decl.row, 'data class は open・abstract・sealed にできません。');
    }
  }

  /** Rejects a name declared twice among parameters or enum entries, which Kotlin reports as conflicting. */
  private rejectDuplicateNames(declarations: { name: string; row: number }[]): void {
    for (const [index, declaration] of declarations.entries()) {
      if (declarations.slice(0, index).some((other) => other.name === declaration.name))
        this.error(declaration.row, `${declaration.name} が2回宣言されています。`);
    }
  }

  /** Resolves a file's imports, which name classes, top-level functions and properties, and members of objects. */
  protected resolveImports(file: KotlinFile, context: FileContext): void {
    for (const declaration of file.imports) {
      const { path, row } = declaration;
      if (declaration.isWildcard) {
        const name = path.join('.');
        if (!this.packages.has(name)) this.rejectImport(row, name);
        context.starPackages.push(name);
        continue;
      }
      const name = path.at(-1) as string;
      const packageScope = this.packages.get(path.slice(0, -1).join('.'));
      if (packageScope) this.importFromPackage(context, packageScope, name, declaration);
      else this.importFromClass(context, name, declaration);
    }
  }

  /** Imports a class, functions, or properties of a package by their name. */
  private importFromPackage(
    context: FileContext,
    packageScope: PackageScope,
    name: string,
    { path, row }: Import
  ): void {
    const cls = packageScope.classes.get(name);
    const functions = packageScope.functions.get(name);
    const properties = packageScope.properties.get(name);
    if (!cls && !functions && !properties) this.rejectImport(row, path.join('.'));
    if (cls) context.importedClasses.set(name, cls);
    if (functions)
      context.importedFunctions.set(name, [...new Set([...(context.importedFunctions.get(name) ?? []), ...functions])]);
    if (properties)
      context.importedProperties.set(name, [
        ...new Set([...(context.importedProperties.get(name) ?? []), ...properties]),
      ]);
  }

  /** Imports a nested class or the members of an object, or a class by its qualified name. */
  private importFromClass(context: FileContext, name: string, { path, row }: Import): void {
    const owner = this.findQualifiedClass(path.slice(0, -1));
    const nested = owner?.nested.get(name);
    if (nested) {
      context.importedClasses.set(name, nested);
      return;
    }
    if (owner) {
      const members = owner.members.get(name) ?? [];
      if (members.length === 0 || !owner.isObject) this.rejectImport(row, path.join('.'));
      this.importObjectMembers(context, owner, name, members);
      return;
    }
    const cls = this.findQualifiedClass(path);
    if (cls) context.importedClasses.set(name, cls);
    else this.rejectImport(row, path.join('.'));
  }

  /** Imports members of an object, such as `Delegates.observable`, as if they were top-level. */
  protected abstract importObjectMembers(
    context: FileContext,
    owner: ClassSymbol,
    name: string,
    members: MemberSymbol[]
  ): void;

  private rejectImport(row: number, path: string): never {
    const what = describeUnavailableImport(path);
    if (what) this.error(row, unavailableMessage(what));
    return this.error(row, `import ${path} が見つかりません。`);
  }

  // Phase 2: headers.

  /** @param assign Receives the parameters before their bounds are resolved, since a bound may mention its class. */
  protected declareTypeParameters(
    scope: Scope,
    decls: TypeParameterDecl[],
    assign?: (params: TypeParameterSymbol[]) => void
  ): TypeParameterSymbol[] {
    const params = decls.map((decl) => {
      const param = new TypeParameterSymbol(decl.name, decl.variance ?? 'inv', decl.isReified);
      scope.typeParameters.set(decl.name, param);
      return param;
    });
    assign?.(params);
    for (const [index, decl] of decls.entries()) {
      params[index].bounds = decl.bounds.map((bound) => this.resolveType(scope, bound));
    }
    return params;
  }

  /** Resolves the supertypes and members' signatures of every class, and declares the top-level functions and properties. */
  protected declareHeaders(files: { file: KotlinFile; context: FileContext }[]): void {
    for (const entry of this.classEntries) {
      this.file = entry.file;
      this.declareTypeParameters(entry.scope, entry.decl.typeParameters, (params) => {
        entry.symbol.typeParameters = params;
      });
    }
    for (const entry of this.classEntries) {
      this.file = entry.file;
      this.declareSupertypes(entry);
    }
    for (const entry of this.classEntries) {
      this.file = entry.file;
      this.declareMembers(entry);
    }
    for (const { file, context } of files) {
      this.file = context;
      const packageScope = this.packageScope(context.packageName);
      const fileScope = new Scope(undefined, undefined);
      for (const declaration of file.declarations) this.declareTopLevel(declaration, fileScope, context, packageScope);
    }
  }

  private declareTopLevel(
    declaration: Declaration,
    fileScope: Scope,
    context: FileContext,
    packageScope: PackageScope
  ): void {
    const checks = !context.isLibrary;
    if (declaration.kind === 'function') {
      const { symbol } = this.declareFunction(declaration, fileScope, undefined, context);
      if (checks) this.checkDuplicateFunction(packageScope.functions.get(symbol.name) ?? [], symbol, declaration.row);
      packageScope.addFunction(symbol);
    } else if (declaration.kind === 'property') {
      const { symbol } = this.declareProperty(declaration, fileScope, undefined, context);
      const isDuplicate =
        !symbol.extensionReceiver &&
        packageScope.properties.get(symbol.name)?.some((other) => !other.extensionReceiver) === true;
      if (checks && isDuplicate) this.error(declaration.row, `プロパティ ${declaration.name} が2回宣言されています。`);
      packageScope.addProperty(symbol);
    } else if (declaration.kind === 'destructuring') {
      this.error(declaration.row, '分解宣言は、関数の中の変数にだけ使えます。');
    }
  }

  private declareSupertypes(entry: ClassEntry): void {
    const { symbol } = entry;
    for (const spec of entry.decl.supers) {
      const type = this.resolveType(entry.scope, spec.type) as ClassType;
      if (type.kind !== 'class') this.error(spec.row, '親にはクラスかインターフェースを書いてください。');
      if (type.cls.isInterface) this.declareInterface(entry, spec, type);
      else this.declareSuperclass(entry, spec, type);
    }
    if (symbol.kind === 'enum') {
      symbol.superclass = {
        kind: 'class',
        cls: this.core.enum,
        args: [{ variance: 'inv', type: symbol.type }],
        nullable: false,
      };
    }
    if (!symbol.superclass && !symbol.isInterface && symbol !== this.core?.any)
      symbol.superclass = this.core ? anyType() : undefined;
  }

  private declareInterface(entry: ClassEntry, spec: SuperSpec, type: ClassType): void {
    const { symbol } = entry;
    const parent = type.cls;
    if (spec.kind === 'constructorCall')
      this.error(spec.row, `インターフェース ${parent.name} にはコンストラクタがないので、() を付けられません。`);
    if (symbol.interfaces.some((existing) => existing.cls === parent))
      this.error(spec.row, `${parent.name} が2回書かれています。`);
    symbol.interfaces.push(type);
    if (parent.isSealed) this.declareSealedCase(symbol, parent, spec, 'sealed interface');
    if (spec.kind === 'delegated') entry.delegateFields.push({ type, slot: -1, spec });
  }

  private declareSuperclass(entry: ClassEntry, spec: SuperSpec, type: ClassType): void {
    const { symbol, decl } = entry;
    const parent = type.cls;
    if (spec.kind === 'delegated') this.error(spec.row, '委譲（by）できるのはインターフェースだけです。');
    if (symbol.superclass) this.error(spec.row, '親のクラスは1つだけ書けます。');
    if (symbol.isInterface) this.error(spec.row, 'インターフェースの親にはインターフェースだけを書けます。');
    this.checkInheritable(parent, spec.row);
    if (
      spec.kind === 'type' &&
      !symbol.isInterface &&
      // A class of the program has its primary constructor, which phase 2 declares only after the supertypes.
      (parent.constructors.length > 0 || !parent.isLibrary) &&
      !this.hasSecondaryConstructors(decl)
    ) {
      this.error(spec.row, `${parent.name} の後に、コンストラクタを呼ぶ () を書いてください。`);
    }
    if (parent.isSealed) this.declareSealedCase(symbol, parent, spec, 'sealed class');
    symbol.superclass = type;
  }

  private checkInheritable(parent: ClassSymbol, row: number): void {
    if (!parent.isInheritable && !parent.isLibrary)
      this.error(row, `クラス ${parent.name} は open ではないので、継承できません。`);
    if (!parent.isInheritable && parent.isLibrary && parent !== this.core.any)
      this.error(row, `クラス ${parent.name} は継承できません。`);
    if (parent.isObject || parent.kind === 'enum') this.error(row, `${parent.name} は継承できません。`);
  }

  /** Makes a class one of the cases of a sealed class or interface, which only its own file may extend. */
  private declareSealedCase(symbol: ClassSymbol, parent: ClassSymbol, spec: SuperSpec, what: string): void {
    if (parent.isLibrary !== symbol.isLibrary) this.error(spec.row, `${what} ${parent.name} は継承できません。`);
    parent.sealedSubclasses.push(symbol);
  }

  private hasSecondaryConstructors(decl: ClassDecl): boolean {
    return decl.members.some((member) => member.kind === 'constructor');
  }

  private declareMembers(entry: ClassEntry): void {
    const { symbol, decl } = entry;
    const primary = decl.primaryConstructor;
    if (primary && symbol.isObject) this.error(decl.row, 'object にはコンストラクタを書けません。');
    if (primary && symbol.isInterface) this.error(decl.row, 'インターフェースにはコンストラクタを書けません。');
    if (!symbol.isInterface && !symbol.isObject) {
      const constructorSymbol = this.declarePrimaryConstructor(entry);
      for (const [index, param] of (primary?.params ?? []).entries()) {
        this.declareParameterProperty(entry, param, constructorSymbol.params[index].type, index);
      }
    }
    for (const member of decl.members) this.declareMember(entry, member);
    if (symbol.isValue && entry.parameterProperties.length !== 1)
      this.error(decl.row, 'value class には、プロパティを1つだけ持つコンストラクタが要ります。');
    if (symbol.isData || symbol.isValue || (symbol.isObject && decl.modifiers.keywords.has('data')))
      this.declareDataMembers(entry);
  }

  /** The primary constructor, written or implicit, which an enum's and a sealed class's own code alone may call. */
  private declarePrimaryConstructor(entry: ClassEntry): FunctionSymbol {
    const { symbol, decl, scope } = entry;
    const primary = decl.primaryConstructor;
    const constructorSymbol = new FunctionSymbol(symbol.name);
    constructorSymbol.isConstructor = true;
    constructorSymbol.owner = symbol;
    constructorSymbol.row = primary?.row ?? decl.row;
    constructorSymbol.isLibrary = entry.file.isLibrary;
    constructorSymbol.isAtomic = !entry.file.isLibrary && this.claimAtomicRange(decl.row, decl.headerEndRow);
    constructorSymbol.returnType = this.unitTypeOrUndefined();
    constructorSymbol.visibility =
      symbol.kind === 'enum'
        ? 'private'
        : symbol.isSealed
          ? 'protected'
          : visibilityOf(primary?.modifiers ?? { keywords: new Set(), annotations: [] });
    const ctorScope = new Scope(scope, undefined);
    constructorSymbol.params = (primary?.params ?? []).map((param) => this.declareParameter(ctorScope, param));
    // An external class of the library has only the constructors it declares: the natives make the others' instances,
    // as `EmptyList`'s, which a program cannot create.
    const isExternal = entry.file.isLibrary && decl.modifiers.keywords.has('external');
    if (!(entry.file.isLibrary && primary === undefined && (this.hasSecondaryConstructors(decl) || isExternal))) {
      symbol.constructors.push(constructorSymbol);
    }
    entry.constructorSymbol = constructorSymbol;
    return constructorSymbol;
  }

  /** The property that a primary constructor's parameter declares with `val` or `var`. */
  private declareParameterProperty(entry: ClassEntry, param: ClassParameterDecl, type: KType, index: number): void {
    const { symbol } = entry;
    if (!param.binding) {
      if (param.modifiers.keywords.has('override') || param.modifiers.keywords.has('open')) {
        this.error(param.row, 'val か var を付けていない引数には、override や open を付けられません。');
      }
      return;
    }
    const property = new PropertySymbol(param.name);
    property.owner = symbol;
    property.type = type;
    property.isVar = param.binding === 'var';
    this.applyMemberModifiers(property, param.modifiers, symbol);
    property.row = param.row;
    property.isLibrary = entry.file.isLibrary;
    symbol.addMember(property);
    entry.parameterProperties.push({ param, symbol: property, index });
  }

  private unitTypeOrUndefined(): KType {
    return this.core.unit.type;
  }

  private declareMember(entry: ClassEntry, member: MemberDecl): void {
    switch (member.kind) {
      case 'function': {
        const functionEntry = this.declareFunction(member, entry.scope, entry, entry.file);
        this.checkDuplicateFunction(
          entry.symbol.members
            .get(member.name)
            ?.filter((existing): existing is FunctionSymbol => existing.kind === 'function') ?? [],
          functionEntry.symbol,
          member.row
        );
        entry.symbol.addMember(functionEntry.symbol);
        break;
      }
      case 'property': {
        const propertyEntry = this.declareProperty(member, entry.scope, entry, entry.file);
        const { extensionReceiver } = propertyEntry.symbol;
        const isDuplicate = entry.symbol.members
          .get(member.name)
          ?.some(
            (existing) =>
              existing.kind === 'property' &&
              (existing.extensionReceiver === undefined) === (extensionReceiver === undefined) &&
              (!existing.extensionReceiver ||
                !extensionReceiver ||
                isSameType(existing.extensionReceiver, extensionReceiver))
          );
        if (isDuplicate) this.error(member.row, `プロパティ ${member.name} が2回宣言されています。`);
        entry.symbol.addMember(propertyEntry.symbol);
        break;
      }
      case 'constructor': {
        if (!entry.file.isLibrary || !member.modifiers.keywords.has('external')) {
          this.unavailable(member.row, '2つ目以降のコンストラクタ（constructor(...)）');
        }
        this.declareNativeConstructor(entry, member);
        break;
      }
      default: {
        break;
      }
    }
  }

  /** A constructor of a library class that a native implements, which initializes the instance `invoke` creates. */
  // code-gauge-allow functionNcss 33 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private declareNativeConstructor(entry: ClassEntry, member: Extract<MemberDecl, { kind: 'constructor' }>): void {
    const { symbol: cls } = entry;
    const ctor = new FunctionSymbol(cls.name);
    ctor.isConstructor = true;
    ctor.owner = cls;
    ctor.isLibrary = true;
    ctor.returnType = this.core.unit.type;
    ctor.visibility = visibilityOf(member.modifiers);
    const scope = new Scope(entry.scope, undefined);
    ctor.params = member.params.map((param) => this.declareParameter(scope, param));
    const key = `${cls.kotlinName}.<init>(${member.params.map(nativeParameterText).join(', ')})`;
    const native = this.natives.get(key);
    if (!native) {
      this.missingNatives.push(key);
      return;
    }
    const defaults = member.params.map((param, index) => {
      const value = param.defaultValue;
      if (!value) return;
      const context = new FunctionContext(undefined, false, '<init>', true, undefined);
      const compiled = this.compileExpression(new Scope(scope, context), context, value, ctor.params[index].type);
      return this.expectType(compiled, ctor.params[index].type, value.row);
    });
    for (const [index, evaluate] of defaults.entries()) if (evaluate) ctor.params[index].defaultValue = evaluate;
    ctor.initialize = (caller, instance, args) => {
      const filled = args.map((arg, index) => (arg === MISSING ? ctor.params[index].defaultValue?.(caller) : arg));
      native(caller, instance, filled);
    };
    ctor.invoke = (caller, _receiver, args, callRow) => {
      const instance = new KObject(cls, cls.fieldCount);
      (ctor.initialize as NonNullable<FunctionSymbol['initialize']>)(caller, instance, args, callRow);
      return instance;
    };
    cls.constructors.push(ctor);
  }

  /** Rejects two functions with the same parameter types, which Kotlin reports as a conflicting overload. */
  private checkDuplicateFunction(existing: FunctionSymbol[], symbol: FunctionSymbol, row: number): void {
    for (const other of existing) {
      if (other === symbol || other.params.length !== symbol.params.length) continue;
      const sameReceiver =
        (other.extensionReceiver === undefined) === (symbol.extensionReceiver === undefined) &&
        (!other.extensionReceiver ||
          !symbol.extensionReceiver ||
          isSameType(other.extensionReceiver, symbol.extensionReceiver));
      if (sameReceiver && other.params.every((param, index) => isSameType(param.type, symbol.params[index].type))) {
        this.error(row, `同じ引数の型の関数 ${symbol.name} が2回宣言されています。`);
      }
    }
  }

  private declareParameter(scope: Scope, param: ParameterDecl): ParameterSymbol {
    if (!param.type) this.error(param.row, `引数 ${param.name} の型を書いてください。`);
    const isVararg = param.modifiers.keywords.has('vararg');
    return {
      name: param.name,
      type: this.resolveType(scope, param.type),
      hasDefault: param.defaultValue !== undefined,
      isVararg,
    };
  }

  private applyMemberModifiers(symbol: MemberSymbol, modifiers: Modifiers, owner: ClassSymbol | undefined): void {
    const { keywords } = modifiers;
    symbol.visibility = visibilityOf(modifiers);
    symbol.isAbstract = keywords.has('abstract');
    symbol.isOverride = keywords.has('override');
    symbol.isOpen = keywords.has('open') || (symbol.isOverride && !keywords.has('final'));
    if (owner?.isInterface && !keywords.has('private')) symbol.isOpen = true;
    if (symbol.isAbstract && owner && !owner.isAbstract) {
      this.error(symbol.row, `abstract なメンバー ${symbol.name} は、abstract なクラスにだけ書けます。`);
    }
    const memberOnly = ['open', 'abstract', 'override', 'protected'].find((keyword) => keywords.has(keyword));
    if (!owner && memberOnly) {
      this.error(symbol.row, `${memberOnly} 修飾子は、クラスのメンバーにだけ書けます。`);
    }
    const inheritable = ['open', 'abstract', 'override'].find((keyword) => keywords.has(keyword));
    if (owner && keywords.has('private') && inheritable) {
      this.error(symbol.row, `private と ${inheritable} は、いっしょには書けません。`);
    }
  }

  private declareFunction(
    decl: FunctionDecl,
    ownerScope: Scope,
    cls: ClassEntry | undefined,
    file: FileContext
  ): FunctionEntry {
    const symbol = new FunctionSymbol(decl.name);
    symbol.owner = cls?.symbol;
    symbol.row = decl.row;
    symbol.isLibrary = file.isLibrary;
    symbol.packageName = file.packageName;
    const scope = new Scope(ownerScope, undefined);
    symbol.typeParameters = this.declareTypeParameters(scope, decl.typeParameters);
    const { keywords } = decl.modifiers;
    this.applyMemberModifiers(symbol, decl.modifiers, cls?.symbol);
    symbol.isInline = keywords.has('inline');
    symbol.isInfix = keywords.has('infix');
    symbol.isOperator = keywords.has('operator');
    symbol.isAtomic = !file.isLibrary && this.claimAtomicRange(decl.row, decl.headerEndRow);
    if (decl.receiver) symbol.extensionReceiver = this.resolveType(scope, decl.receiver);
    symbol.params = decl.params.map((param) => this.declareParameter(scope, param));
    this.rejectDuplicateNames(decl.params);
    if (decl.returnType) symbol.returnType = this.resolveType(scope, decl.returnType);
    else if (decl.body?.kind !== 'expression') symbol.returnType = this.core.unit.type;
    this.checkFunctionBody(decl, symbol, cls?.symbol);
    if (keywords.has('external')) this.bindNativeFunction(symbol, decl, cls?.symbol, file);
    const entry: FunctionEntry = { kind: 'function', decl, symbol, file, scope, cls, state: 'pending' };
    this.functionEntries.push(entry);
    this.entryOfFunction.set(symbol, entry);
    return entry;
  }

  private checkFunctionBody(decl: FunctionDecl, symbol: FunctionSymbol, owner: ClassSymbol | undefined): void {
    const { keywords } = decl.modifiers;
    const isInterface = owner?.isInterface ?? false;
    if (!decl.body && !symbol.isAbstract && !isInterface && !keywords.has('external')) {
      this.error(decl.row, `関数 ${decl.name} に本体を書いてください。`);
    }
    if (decl.body && symbol.isAbstract) this.error(decl.row, `abstract な関数 ${decl.name} には本体を書けません。`);
    if (!decl.body && isInterface) {
      symbol.isAbstract = true;
      if (keywords.has('private')) this.error(decl.row, `本体のない関数 ${decl.name} は、private にできません。`);
    }
    if (symbol.isInfix && (symbol.params.length !== 1 || (!owner && !symbol.extensionReceiver))) {
      this.error(decl.row, 'infix 修飾子は、引数が1つのメンバー関数か拡張関数にだけ書けます。');
    }
  }

  protected checkAtomicRows(): void {
    for (const row of this.atomicRows) {
      if (!this.claimedAtomicRows.has(row)) this.error(row, misplacedAtomicMessage);
    }
  }

  private claimAtomicRange(firstRow: number, lastRow: number): boolean {
    let claimed = false;
    for (const row of this.atomicRows) {
      if (row < firstRow || row > lastRow) continue;
      this.claimedAtomicRows.add(row);
      claimed = true;
    }
    return claimed;
  }

  /** The key that names the native implementation of a library declaration. */
  protected nativeKey(
    owner: ClassSymbol | undefined,
    file: FileContext,
    receiverText: string | undefined,
    name: string
  ): string {
    if (owner) return `${owner.kotlinName}.${name}`;
    const scope = file.packageName;
    return receiverText ? `${scope}.${receiverText}.${name}` : `${scope}.${name}`;
  }

  private bindNativeFunction(
    symbol: FunctionSymbol,
    decl: FunctionDecl,
    owner: ClassSymbol | undefined,
    file: FileContext
  ): void {
    const receiverText = decl.receiver ? typeRefText(decl.receiver) : undefined;
    const base = this.nativeKey(owner, file, receiverText, decl.name);
    const key = `${base}(${decl.params.map(nativeParameterText).join(', ')})`;
    const native = this.natives.get(key);
    if (!native) {
      this.missingNatives.push(key);
      return;
    }
    symbol.invoke = this.nativeInvoker(symbol, native);
  }

  /** Wraps a native as a function's implementation, which fills in the default values of the arguments left out. */
  protected abstract nativeInvoker(
    symbol: FunctionSymbol,
    native: NativeFunction
  ): NonNullable<FunctionSymbol['invoke']>;

  // code-gauge-allow functionNcss 45 -- The parts of a property declaration and their checks.
  // code-gauge-allow functionCognitiveComplexity 19 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private declareProperty(
    decl: PropertyDecl,
    ownerScope: Scope,
    cls: ClassEntry | undefined,
    file: FileContext
  ): PropertyEntry {
    const symbol = new PropertySymbol(decl.name);
    symbol.owner = cls?.symbol;
    symbol.row = decl.row;
    symbol.isLibrary = file.isLibrary;
    symbol.packageName = file.packageName;
    symbol.isVar = decl.isVar;
    const scope = new Scope(ownerScope, undefined);
    symbol.typeParameters = this.declareTypeParameters(scope, decl.typeParameters);
    this.applyMemberModifiers(symbol, decl.modifiers, cls?.symbol);
    symbol.isLateinit = decl.modifiers.keywords.has('lateinit');
    if (decl.receiver) symbol.extensionReceiver = this.resolveType(scope, decl.receiver);
    if (decl.type) symbol.type = this.resolveType(scope, decl.type);
    symbol.hasCustomGetter = decl.getter?.body !== undefined || decl.delegate !== undefined;
    if (decl.setter) symbol.setterVisibility = visibilityOf(decl.setter.modifiers);
    if (
      !decl.type &&
      !decl.initializer &&
      !decl.getter?.body &&
      !decl.delegate &&
      !decl.modifiers.keywords.has('external')
    ) {
      this.error(decl.row, `プロパティ ${decl.name} の型を書くか、初期値を書いてください。`);
    }
    if (!decl.isVar && decl.setter) this.error(decl.row, 'val には set を書けません。');
    if (decl.receiver && decl.initializer) {
      this.error(decl.row, '拡張プロパティには初期値を書けません。get() を書いてください。');
    }
    const isInterface = cls?.symbol.isInterface ?? false;
    if (isInterface && decl.initializer) this.error(decl.row, 'インターフェースのプロパティには初期値を書けません。');
    if (isInterface && !decl.getter?.body) symbol.isAbstract = true;
    if (symbol.isAbstract && decl.initializer)
      this.error(decl.row, `abstract なプロパティ ${decl.name} には初期値を書けません。`);
    if (!cls && !decl.initializer && !decl.delegate && this.hasBackingField(decl, symbol)) {
      this.error(decl.row, `プロパティ ${decl.name} には初期値を書いてください。`);
    }
    if (decl.modifiers.keywords.has('external')) this.bindNativeProperty(symbol, decl, cls?.symbol, file);
    const entry: PropertyEntry = {
      kind: 'property',
      decl,
      symbol,
      file,
      scope,
      cls,
      state: 'pending',
      initializer: undefined,
      delegateSlot: undefined,
    };
    this.propertyEntries.push(entry);
    this.entryOfProperty.set(symbol, entry);
    return entry;
  }

  private bindNativeProperty(
    symbol: PropertySymbol,
    decl: PropertyDecl,
    owner: ClassSymbol | undefined,
    file: FileContext
  ): void {
    const key = this.nativeKey(owner, file, decl.receiver ? typeRefText(decl.receiver) : undefined, decl.name);
    const native = this.nativeProperties.get(key);
    if (!native) {
      this.missingNatives.push(key);
      return;
    }
    symbol.get = native.get;
    symbol.set = native.set;
  }

  /** The members a data class, a value class, and a data object get: `toString`, `equals`, `hashCode`, `copy`, `componentN`. */
  private declareDataMembers(entry: ClassEntry): void {
    const { symbol } = entry;
    const properties = entry.parameterProperties.map((item) => item.symbol);
    this.declareDataAnyMembers(symbol, properties);
    if (symbol.isObject || symbol.isValue) return;
    for (const [index, property] of properties.entries()) {
      const name = `component${index + 1}`;
      if (declaresFunction(symbol, name, 0)) continue;
      addGenerated(
        symbol,
        name,
        [],
        property.type as KType,
        (_frame, receiver) => (receiver as KObject).fields[property.slot as number],
        false
      );
    }
    this.declareCopy(entry);
  }

  /** `toString`, `hashCode`, and `equals` of a data class, a value class, or a data object, unless it declares its own. */
  // code-gauge-allow functionCognitiveComplexity 23 -- one generated member after another, each as Kotlin defines it for data classes.
  private declareDataAnyMembers(symbol: ClassSymbol, properties: PropertySymbol[]): void {
    const isDataObject = symbol.isObject;
    if (!declaresFunction(symbol, 'toString', 0)) {
      addGenerated(
        symbol,
        'toString',
        [],
        this.core.string.type,
        (frame, receiver) => {
          if (isDataObject) return symbol.name;
          const object = receiver as KObject;
          const parts = properties.map(
            (property) => `${property.name}=${stringOf(frame, this.boxedField(object, property))}`
          );
          return `${symbol.name}(${parts.join(', ')})`;
        },
        true
      );
    }
    if (!declaresFunction(symbol, 'hashCode', 0)) {
      addGenerated(
        symbol,
        'hashCode',
        [],
        this.primitiveType('Int'),
        (frame, receiver) => {
          if (isDataObject) return stringHash(symbol.name);
          let hash = 0;
          for (const [index, property] of properties.entries()) {
            const value = hashOf(frame, this.boxedField(receiver as KObject, property));
            hash = index === 0 ? value : toInt32(Math.imul(hash, 31) + value);
          }
          return hash;
        },
        true
      );
    }
    if (!declaresFunction(symbol, 'equals', 1)) {
      addGenerated(
        symbol,
        'equals',
        [{ name: 'other', type: anyType(true), hasDefault: false, isVararg: false }],
        this.booleanType,
        (frame, receiver, args) => {
          const other = args[0];
          if (receiver === other) return true;
          if (!(other instanceof KObject) || other.cls !== symbol) return false;
          return properties.every((property) =>
            valueEquals(frame, this.boxedField(receiver as KObject, property), this.boxedField(other, property))
          );
        },
        true
      );
    }
  }

  /** `copy` of a data class, whose omitted arguments are the receiver's properties. */
  private declareCopy(entry: ClassEntry): void {
    const ctor = entry.constructorSymbol as FunctionSymbol;
    const copyParams: ParameterSymbol[] = ctor.params.map((param) => ({
      name: param.name,
      type: param.type,
      hasDefault: true,
      isVararg: false,
    }));
    // The fields' slots are laid out after the members are declared, so copy reads them when it runs.
    const copiedProperties = ctor.params.map(
      (_, index) => entry.parameterProperties.find((item) => item.index === index)?.symbol
    );
    addGenerated(
      entry.symbol,
      'copy',
      copyParams,
      entry.symbol.selfType,
      (frame, receiver, args) => {
        const values = args.map((arg, index) => {
          if (arg !== MISSING) return arg;
          const slot = copiedProperties[index]?.slot;
          return slot === undefined ? undefined : (receiver as KObject).fields[slot];
        });
        return (ctor.invoke as NonNullable<FunctionSymbol['invoke']>)(frame, undefined, values, undefined);
      },
      false
    );
  }

  /** A property's value in an instance, boxed as a reference for natives that format and compare it. */
  protected boxedField(object: KObject, property: PropertySymbol): Value {
    const value = object.fields[property.slot as number];
    const repr = propertyRepr(property);
    return repr === 'ref' ? value : convertRepr(() => value, repr, 'ref')(undefined as unknown as Frame);
  }

  /** The JVM's default value of a field of the type, before its initializer runs. */
  protected defaultValueOf(type: KType | undefined): Value {
    const kind = type ? this.primitiveOf(type) : undefined;
    if (kind === undefined)
      return type && this.isClass(type, this.core.boolean) && !resolved(type).nullable ? false : undefined;
    return kind === 'Long' || kind === 'ULong' ? 0n : 0;
  }

  // Phase 3: layout, overrides, and dispatch.

  /** Lays out fields and links overrides, superclasses before subclasses. */
  protected linkClasses(): void {
    const done = new Set<ClassSymbol>();
    const visit = (entry: ClassEntry): void => {
      if (done.has(entry.symbol)) return;
      done.add(entry.symbol);
      for (const supertype of entry.symbol.supertypes) {
        const parent = this.entryOfClass.get(supertype.cls);
        if (parent) visit(parent);
      }
      this.file = entry.file;
      this.layOutFields(entry);
      this.linkOverrides(entry);
    };
    for (const entry of this.classEntries) visit(entry);
  }

  private layOutFields(entry: ClassEntry): void {
    const { symbol } = entry;
    let count = symbol.superclass?.cls.fieldCount ?? 0;
    for (const field of entry.delegateFields) field.slot = count++;
    for (const { symbol: property } of entry.parameterProperties) {
      property.slot = count++;
      symbol.ownFields.push(property);
      this.bindFieldAccessors(property);
    }
    for (const member of entry.decl.members) {
      if (member.kind !== 'property') continue;
      const property = this.findOwnProperty(symbol, member.name);
      const propertyEntry = this.entryOfProperty.get(property) as PropertyEntry;
      if (member.delegate) {
        propertyEntry.delegateSlot = count++;
        continue;
      }
      if (this.hasBackingField(member, property)) {
        property.slot = count++;
        symbol.ownFields.push(property);
        // Custom accessors, compiled later, replace the default ones they declare.
        this.bindFieldAccessors(property);
      }
    }
    symbol.fieldCount = count;
  }

  protected findOwnProperty(cls: ClassSymbol, name: string): PropertySymbol {
    return cls.members
      .get(name)
      ?.find((member): member is PropertySymbol => member.kind === 'property') as PropertySymbol;
  }

  /** Whether a property stores a value: unless it is abstract, external, or has accessors that never use `field`. */
  protected hasBackingField(decl: PropertyDecl, symbol: PropertySymbol): boolean {
    if (symbol.isAbstract || decl.modifiers.keywords.has('external') || decl.receiver) return false;
    // An accessor left to its default, or one that reads or writes `field`, keeps the value in a backing field.
    const getterUses = !decl.getter?.body || usesField(decl.getter.body);
    const setterUses = decl.isVar && (!decl.setter?.body || usesField(decl.setter.body));
    return decl.initializer !== undefined || getterUses || setterUses;
  }

  /** Reads and writes a property's backing field directly, as its default accessors do. */
  protected bindFieldAccessors(property: PropertySymbol): void {
    const slot = property.slot as number;
    const isLateinit = property.isLateinit;
    property.get = (frame, receiver) => {
      const value = (receiver as KObject).fields[slot];
      if (isLateinit && value === undefined) {
        return frame.runtime.throwError(
          frame,
          'kotlin.UninitializedPropertyAccessException',
          `lateinit property ${property.name} has not been initialized`
        );
      }
      return value;
    };
    property.set = (_frame, receiver, value) => {
      (receiver as KObject).fields[slot] = value;
    };
  }

  private linkOverrides(entry: ClassEntry): void {
    const { symbol } = entry;
    for (const supertype of symbol.supertypes) {
      for (const [root, implementation] of supertype.cls.vtable) {
        if (!symbol.vtable.has(root) || !implementation.isAbstract) symbol.vtable.set(root, implementation);
      }
    }
    for (const members of symbol.members.values()) for (const member of members) this.linkMember(symbol, member);
    this.linkDelegates(entry);
    if (!symbol.isAbstract && !symbol.isLibrary) this.checkImplemented(symbol);
  }

  /** Links a member to the members of the supertypes that it overrides, checking that it may override them. */
  // code-gauge-allow functionCognitiveComplexity 21 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private linkMember(symbol: ClassSymbol, member: MemberSymbol): void {
    const overridden = this.findOverridden(symbol, member);
    if (overridden.length === 0) {
      if (member.isOverride && !(member.kind === 'function' && symbol.isLibrary)) {
        this.error(member.row, `override を付けた ${member.name} は、親のクラスやインターフェースにありません。`);
      }
      if (isVirtual(member) || member.isOpen || member.isAbstract) symbol.vtable.set(member, member);
      return;
    }
    if (!member.isOverride && !symbol.isLibrary && !this.isGenerated(member)) {
      this.error(member.row, `${member.name} は親の ${member.name} を上書きするので、override を付けてください。`);
    }
    for (const base of overridden) this.checkOverridable(member, base);
    member.overridden = overridden;
    member.root = overridden[0].root;
    // An override of an operator or infix function is one as well, as Kotlin inherits these modifiers.
    if (member.kind === 'function') {
      this.inheritDefaults(member, overridden);
      for (const base of overridden) {
        if (base.kind !== 'function') continue;
        member.isOperator ||= base.isOperator;
        member.isInfix ||= base.isInfix;
      }
      if (!member.isOverride && this.isGenerated(member)) member.isOverride = true;
    }
    for (const base of overridden) symbol.vtable.set(base.root, member);
    symbol.vtable.set(member.root, member);
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Each inherited parameter must agree on the default owner.
  private inheritDefaults(member: FunctionSymbol, overridden: MemberSymbol[]): void {
    if (!member.isLibrary && member.params.some((parameter) => parameter.hasDefault)) {
      this.error(member.row, `override する関数 ${member.name} では、引数の初期値を指定できません。`);
    }
    for (const base of overridden) {
      if (base.kind !== 'function') continue;
      for (const [index, inherited] of base.params.entries()) {
        if (!inherited.hasDefault) continue;
        const parameter = member.params[index];
        const owner = inherited.defaultOwner ?? base;
        if (parameter.defaultOwner && parameter.defaultOwner !== owner && !member.isLibrary) {
          this.error(member.row, `${member.name} の引数 ${parameter.name} の初期値が複数あります。`);
        }
        if (parameter.hasDefault) continue;
        parameter.hasDefault = true;
        parameter.defaultOwner = owner;
      }
    }
  }

  private checkOverridable(member: MemberSymbol, base: MemberSymbol): void {
    if (!isVirtual(base) && !base.isOpen && !base.isAbstract && !base.isOverride) {
      this.error(member.row, `${base.owner?.name ?? ''}.${member.name} は open ではないので、上書きできません。`);
    }
    if (base.kind === 'property' && member.kind === 'property' && base.isVar && !member.isVar) {
      this.error(member.row, `var の ${member.name} を val で上書きすることはできません。`);
    }
  }

  /** Rejects a class that is not abstract but leaves an abstract member without an implementation. */
  private checkImplemented(symbol: ClassSymbol): void {
    for (const [root, implementation] of symbol.vtable) {
      if (!implementation.isAbstract) continue;
      const kind = root.kind === 'function' ? '関数' : 'プロパティ';
      this.error(
        symbol.row,
        `クラス ${symbol.name} は abstract ではないので、${kind} ${root.name} を実装してください。`
      );
    }
  }

  private isGenerated(member: MemberSymbol): boolean {
    return member.kind === 'function' && !this.entryOfFunction.has(member) && !member.isLibrary;
  }

  /** The members of the supertypes that a member overrides: same name, and for functions the same parameter types. */
  // code-gauge-allow functionCognitiveComplexity 24 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private findOverridden(cls: ClassSymbol, member: MemberSymbol): MemberSymbol[] {
    const found: MemberSymbol[] = [];
    for (const supertype of cls.supertypes) {
      const candidates = this.membersOf<MemberSymbol>(supertype, member.name, member.kind);
      for (const { symbol: candidate, substitution } of candidates) {
        if (candidate.visibility === 'private') continue;
        if (member.kind === 'function' && candidate.kind === 'function') {
          if (candidate.params.length !== member.params.length) continue;
          const matches = candidate.params.every((param, index) =>
            isSameType(substitute(param.type, substitution), member.params[index].type)
          );
          if (!matches) continue;
        }
        if ((member.extensionReceiver === undefined) !== (candidate.extensionReceiver === undefined)) continue;
        this.checkOverrideType(cls, member, candidate, substitution);
        if (!found.includes(candidate)) found.push(candidate);
      }
    }
    return found;
  }

  protected validateOverrideTypes(): void {
    for (const { symbol } of this.classEntries) {
      if (symbol.isLibrary) continue;
      for (const members of symbol.members.values()) {
        for (const member of members) {
          if (member.overridden.length > 0) this.findOverridden(symbol, member);
        }
      }
    }
  }

  private checkOverrideType(
    cls: ClassSymbol,
    member: MemberSymbol,
    base: MemberSymbol,
    substitution: Substitution
  ): void {
    if (cls.isLibrary) return;
    if (VISIBILITY_RANK[member.visibility] < VISIBILITY_RANK[base.visibility]) {
      this.error(
        member.row,
        `${member.name} は、上書きする ${base.owner?.name ?? ''}.${member.name} より公開範囲を狭くできません。`
      );
    }
    const own = member.kind === 'function' ? member.returnType : member.type;
    const inherited = base.kind === 'function' ? base.returnType : base.type;
    // A type that the member's body has yet to infer is checked against the inherited one where it is inferred.
    if (!own || !inherited) return;
    const expected = substitute(inherited, substitution);
    const fits = base.kind === 'property' && base.isVar ? isSameType(own, expected) : isSubtype(own, expected);
    if (!fits) {
      this.error(
        member.row,
        `${member.name} の型 ${typeToString(own)} は、上書きする ${base.owner?.name ?? ''}.${member.name} の型 ${typeToString(expected)} と合いません。`
      );
    }
  }

  /** Forwards the members of an interface delegated with `by` that the class does not override to the delegate. */
  // code-gauge-allow functionCognitiveComplexity 23 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private linkDelegates(entry: ClassEntry): void {
    const { symbol } = entry;
    for (const field of entry.delegateFields) {
      const visit = (type: ClassType): void => {
        for (const members of type.cls.members.values()) {
          for (const member of members) {
            const current = symbol.vtable.get(member.root);
            if (current && current.owner === symbol) continue;
            if (
              current &&
              !current.isAbstract &&
              current.owner &&
              !current.owner.isInterface &&
              current.owner !== type.cls
            )
              continue;
            symbol.vtable.set(member.root, this.forwarder(member, field.slot, symbol));
          }
        }
        for (const supertype of type.cls.supertypes) visit(supertype);
      };
      visit(field.type);
    }
  }

  /** A member that calls the delegate's implementation of `member`. */
  private forwarder(member: MemberSymbol, slot: number, owner: ClassSymbol): MemberSymbol {
    if (member.kind === 'function') {
      const forward = new FunctionSymbol(member.name);
      Object.assign(forward, member, { owner, isAbstract: false, root: member.root });
      forward.invoke = (frame, receiver, args, callRow) =>
        callFunction(member, frame, (receiver as KObject).fields[slot], args, callRow);
      return forward;
    }
    const forward = new PropertySymbol(member.name);
    Object.assign(forward, member, { owner, isAbstract: false, root: member.root });
    forward.get = (frame, receiver) => {
      const delegate = (receiver as KObject).fields[slot];
      const target = (delegate as KObject).cls.dispatch(member);
      return (target.get as NonNullable<PropertySymbol['get']>)(frame, delegate);
    };
    forward.set = (frame, receiver, value) => {
      const delegate = (receiver as KObject).fields[slot];
      const target = (delegate as KObject).cls.dispatch(member);
      (target.set as NonNullable<PropertySymbol['set']>)(frame, delegate, value);
    };
    return forward;
  }

  // Helpers for subclasses.

  protected propertyReprOf(symbol: PropertySymbol): Repr {
    return propertyRepr(symbol);
  }

  protected newFileContext(packageName: string, isLibrary: boolean): FileContext {
    return {
      packageName,
      isLibrary,
      importedClasses: new Map(),
      importedFunctions: new Map(),
      importedProperties: new Map(),
      starPackages: [],
    };
  }

  protected unboxed(value: Value): Value {
    return value instanceof Boxed ? value.value : value;
  }

  protected nothing(): KType {
    return NOTHING;
  }

  protected describe(type: KType): string {
    return typeToString(type);
  }
}

/** A parameter as the key of a native names it, such as `vararg T`. */
function nativeParameterText(param: ParameterDecl): string {
  const type = param.type ? typeRefText(param.type) : '';
  return param.modifiers.keywords.has('vararg') ? `vararg ${type}` : type;
}

/** Whether an accessor's body names `field`, which gives its property a backing field. */
function usesField(body: unknown): boolean {
  return JSON.stringify(body, (key, value) => (typeof value === 'bigint' ? 0 : value)).includes('"name":"field"');
}

/** What an import names that this environment cannot run, by the feature it stands for. */
export function describeUnavailableImport(path: string): string | undefined {
  if (path === 'java.util.Scanner' || path.startsWith('kotlin.io.readLine')) return '標準入力';
  if (path.startsWith('java.io') || path.startsWith('java.nio') || path.startsWith('kotlin.io.path'))
    return 'ファイルの読み書き';
  if (path.startsWith('java.net') || path.startsWith('io.ktor')) return 'ネットワーク';
  if (
    path.startsWith('kotlinx.coroutines') ||
    path.startsWith('kotlin.concurrent') ||
    path.startsWith('java.util.concurrent')
  )
    return 'コルーチン・スレッド';
  if (path.startsWith('kotlin.reflect') || path.startsWith('java.lang.reflect')) return 'リフレクション';
  if (path.startsWith('java.') || path.startsWith('javax.')) return `Java のクラスの直接の利用（${path}）`;
  if (path.startsWith('kotlin.')) return `標準ライブラリの ${path} `;
  return `標準ライブラリ以外のライブラリ（${path}）`;
}

function declaresFunction(symbol: ClassSymbol, name: string, paramCount: number): boolean {
  return (
    symbol.members.get(name)?.some((member) => member.kind === 'function' && member.params.length === paramCount) ??
    false
  );
}

/** Adds a member that Kotlin generates for a data class, such as `toString` or `component1`. */
function addGenerated(
  symbol: ClassSymbol,
  name: string,
  params: ParameterSymbol[],
  returnType: KType,
  invoke: FunctionSymbol['invoke'],
  isOverride: boolean
): FunctionSymbol {
  const generated = new FunctionSymbol(name);
  generated.owner = symbol;
  generated.params = params;
  generated.returnType = returnType;
  generated.isOverride = isOverride;
  generated.isOperator = name.startsWith('component');
  generated.isLibrary = symbol.isLibrary;
  generated.invoke = invoke;
  generated.row = symbol.row;
  symbol.addMember(generated);
  return generated;
}
