import type {
  ClassDecl,
  ClassParameterDecl,
  Declaration,
  Expression,
  FunctionDecl,
  KotlinFile,
  MemberDecl,
  Modifiers,
  ParameterDecl,
  PropertyDecl,
  Statement,
  SuperSpec,
  TypeParameterDecl,
} from './ast';
import type { ArgumentSyntax, Candidate, ResolvedCall } from './callCompiler';
import {
  type Compiled,
  convertRepr,
  type Eval,
  Flow,
  FunctionContext,
  Handoff,
  PackageScope,
  ReceiverSymbol,
  type Repr,
  reprOf,
  Scope,
  typeMismatchMessage,
} from './compilerBase';
import { DEFAULT_IMPORTS, type FileContext } from './compilerCore';
import { unavailableMessage } from './convertSupport';
import { callFunction, isVirtual, parameterReprs, propertyRepr, receiverRepr, returnRepr } from './dispatch';
import { defaultToString, hashOf, identityHash, stringHash, stringOf, valueEquals } from './format';
import { type NativeFunction, type NativeProperty, typeRefText } from './nativeTypes';
import { toInt32 } from './operators';
import { type Frame, MISSING, UNASSIGNED } from './runtime';
import { StatementCompiler } from './statementCompiler';
import {
  ClassSymbol,
  type ClassSymbolKind,
  FunctionSymbol,
  type MemberSymbol,
  type ParameterSymbol,
  PropertySymbol,
  TypeParameterSymbol,
  VariableSymbol,
  type Visibility,
} from './symbols';
import { anyType, asSuper, isSameType, isSubtype, substitutionOf } from './typeRelations';
import {
  type ClassType,
  type KType,
  NOTHING,
  nullable,
  resolved,
  substitute,
  type Substitution,
  typeToString,
} from './types';
import { Boxed, KObject, UNIT, type Value } from './values';

interface ClassEntry {
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

interface FunctionEntry {
  kind: 'function';
  decl: FunctionDecl;
  symbol: FunctionSymbol;
  file: FileContext;
  scope: Scope;
  cls: ClassEntry | undefined;
  state: 'pending' | 'compiling' | 'done';
}

interface PropertyEntry {
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

/** What a batch of files compiled into, for the runtime to start from. */
export interface CompiledFiles {
  /** Initializes the top-level properties of the files, in order, when a run starts. */
  initializers: { row: number; isConstant: boolean; run: (frame: Frame) => void }[];
  globalCount: number;
}

const ACCESS_KEYWORDS: Visibility[] = ['private', 'protected', 'internal', 'public'];

const VISIBILITY_RANK: Record<Visibility, number> = { private: 0, protected: 1, internal: 2, public: 2 };

function visibilityOf(modifiers: Modifiers): Visibility {
  return ACCESS_KEYWORDS.find((keyword) => modifiers.keywords.has(keyword)) ?? 'public';
}

export abstract class DeclarationCompiler extends StatementCompiler {
  protected readonly classEntries: ClassEntry[] = [];
  private readonly entryOfClass = new Map<ClassSymbol, ClassEntry>();
  protected readonly functionEntries: FunctionEntry[] = [];
  protected readonly propertyEntries: PropertyEntry[] = [];
  private readonly entryOfFunction = new Map<FunctionSymbol, FunctionEntry>();
  private readonly entryOfProperty = new Map<PropertySymbol, PropertyEntry>();
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
      const packagePath = path.slice(0, -1).join('.');
      const packageScope = this.packages.get(packagePath);
      if (packageScope) {
        const cls = packageScope.classes.get(name);
        const functions = packageScope.functions.get(name);
        const properties = packageScope.properties.get(name);
        if (!cls && !functions && !properties) this.rejectImport(row, path.join('.'));
        if (cls) context.importedClasses.set(name, cls);
        if (functions)
          context.importedFunctions.set(name, [
            ...new Set([...(context.importedFunctions.get(name) ?? []), ...functions]),
          ]);
        if (properties)
          context.importedProperties.set(name, [
            ...new Set([...(context.importedProperties.get(name) ?? []), ...properties]),
          ]);
        continue;
      }
      const owner = this.findQualifiedClass(path.slice(0, -1));
      if (owner) {
        const nested = owner.nested.get(name);
        if (nested) {
          context.importedClasses.set(name, nested);
          continue;
        }
        const members = owner.members.get(name) ?? [];
        if (members.length === 0 || !owner.isObject) this.rejectImport(row, path.join('.'));
        this.importObjectMembers(context, owner, name, members);
        continue;
      }
      const cls = this.findQualifiedClass(path);
      if (cls) {
        context.importedClasses.set(name, cls);
        continue;
      }
      this.rejectImport(row, path.join('.'));
    }
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
    const { symbol, decl } = entry;
    for (const spec of decl.supers) {
      const type = this.resolveType(entry.scope, spec.type) as ClassType;
      if (type.kind !== 'class') this.error(spec.row, '親にはクラスかインターフェースを書いてください。');
      const parent = type.cls;
      if (parent.isInterface) {
        if (spec.kind === 'constructorCall')
          this.error(spec.row, `インターフェース ${parent.name} にはコンストラクタがないので、() を付けられません。`);
        if (symbol.interfaces.some((existing) => existing.cls === parent))
          this.error(spec.row, `${parent.name} が2回書かれています。`);
        symbol.interfaces.push(type);
        if (parent.isSealed) {
          if (parent.isLibrary !== symbol.isLibrary)
            this.error(spec.row, `sealed interface ${parent.name} は継承できません。`);
          parent.sealedSubclasses.push(symbol);
        }
        if (spec.kind === 'delegated') {
          entry.delegateFields.push({ type, slot: -1, spec });
        }
        continue;
      }
      if (spec.kind === 'delegated') this.error(spec.row, '委譲（by）できるのはインターフェースだけです。');
      if (symbol.superclass) this.error(spec.row, '親のクラスは1つだけ書けます。');
      if (symbol.isInterface) this.error(spec.row, 'インターフェースの親にはインターフェースだけを書けます。');
      if (!parent.isInheritable && !parent.isLibrary)
        this.error(spec.row, `クラス ${parent.name} は open ではないので、継承できません。`);
      if (!parent.isInheritable && parent.isLibrary && parent !== this.core.any)
        this.error(spec.row, `クラス ${parent.name} は継承できません。`);
      if (parent.isObject || parent.kind === 'enum') this.error(spec.row, `${parent.name} は継承できません。`);
      if (
        spec.kind === 'type' &&
        !symbol.isInterface &&
        // A class of the program has its primary constructor, which phase 2 declares only after the supertypes.
        (parent.constructors.length > 0 || !parent.isLibrary) &&
        !this.hasSecondaryConstructors(decl)
      ) {
        this.error(spec.row, `${parent.name} の後に、コンストラクタを呼ぶ () を書いてください。`);
      }
      if (parent.isSealed) {
        if (parent.isLibrary !== symbol.isLibrary)
          this.error(spec.row, `sealed class ${parent.name} は継承できません。`);
        parent.sealedSubclasses.push(symbol);
      }
      symbol.superclass = type;
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

  private hasSecondaryConstructors(decl: ClassDecl): boolean {
    return decl.members.some((member) => member.kind === 'constructor');
  }

  private declareMembers(entry: ClassEntry): void {
    const { symbol, decl, scope } = entry;
    const primary = decl.primaryConstructor;
    if (primary && symbol.isObject) this.error(decl.row, 'object にはコンストラクタを書けません。');
    if (primary && symbol.isInterface) this.error(decl.row, 'インターフェースにはコンストラクタを書けません。');
    if (!symbol.isInterface && !symbol.isObject) {
      const constructorSymbol = new FunctionSymbol(symbol.name);
      constructorSymbol.isConstructor = true;
      constructorSymbol.owner = symbol;
      constructorSymbol.row = primary?.row ?? decl.row;
      constructorSymbol.isLibrary = entry.file.isLibrary;
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
      for (const [index, param] of (primary?.params ?? []).entries()) {
        if (!param.binding) {
          if (param.modifiers.keywords.has('override') || param.modifiers.keywords.has('open')) {
            this.error(param.row, 'val か var を付けていない引数には、override や open を付けられません。');
          }
          continue;
        }
        const property = new PropertySymbol(param.name);
        property.owner = symbol;
        property.type = constructorSymbol.params[index].type;
        property.isVar = param.binding === 'var';
        this.applyMemberModifiers(property, param.modifiers, symbol);
        property.row = param.row;
        property.isLibrary = entry.file.isLibrary;
        symbol.addMember(property);
        entry.parameterProperties.push({ param, symbol: property, index });
      }
    }
    for (const member of decl.members) this.declareMember(entry, member);
    if (symbol.isValue && entry.parameterProperties.length !== 1)
      this.error(decl.row, 'value class には、プロパティを1つだけ持つコンストラクタが要ります。');
    if (symbol.isData || symbol.isValue || (symbol.isObject && decl.modifiers.keywords.has('data')))
      this.declareDataMembers(entry);
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
    symbol.isAtomic = !file.isLibrary && this.isAtomicRange(decl.row, decl.headerEndRow);
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

  protected isAtomicRange(firstRow: number, lastRow: number): boolean {
    for (const row of this.atomicRows) if (row >= firstRow && row <= lastRow) return true;
    return false;
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
  // code-gauge-allow functionNcss 60 -- The members Kotlin generates for data classes.
  private declareDataMembers(entry: ClassEntry): void {
    const { symbol } = entry;
    const properties = entry.parameterProperties.map((item) => item.symbol);
    const declares = (name: string, paramCount: number): boolean =>
      symbol.members.get(name)?.some((member) => member.kind === 'function' && member.params.length === paramCount) ??
      false;
    const add = (
      name: string,
      params: ParameterSymbol[],
      returnType: KType,
      invoke: FunctionSymbol['invoke'],
      isOverride: boolean
    ): FunctionSymbol => {
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
    };
    const isDataObject = symbol.isObject;
    if (!declares('toString', 0)) {
      add(
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
    if (!declares('hashCode', 0)) {
      add(
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
    if (!declares('equals', 1)) {
      add(
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
    if (isDataObject || symbol.isValue) return;
    for (const [index, property] of properties.entries()) {
      const name = `component${index + 1}`;
      if (declares(name, 0)) continue;
      add(
        name,
        [],
        property.type as KType,
        (_frame, receiver) => (receiver as KObject).fields[property.slot as number],
        false
      );
    }
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
    add(
      'copy',
      copyParams,
      symbol.selfType,
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
  private defaultValueOf(type: KType | undefined): Value {
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

  private findOwnProperty(cls: ClassSymbol, name: string): PropertySymbol {
    return cls.members
      .get(name)
      ?.find((member): member is PropertySymbol => member.kind === 'property') as PropertySymbol;
  }

  /** Whether a property stores a value: unless it is abstract, external, or has accessors that never use `field`. */
  private hasBackingField(decl: PropertyDecl, symbol: PropertySymbol): boolean {
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
    for (const members of symbol.members.values()) {
      for (const member of members) {
        const overridden = this.findOverridden(symbol, member);
        if (overridden.length === 0) {
          if (member.isOverride && !(member.kind === 'function' && symbol.isLibrary)) {
            this.error(member.row, `override を付けた ${member.name} は、親のクラスやインターフェースにありません。`);
          }
          if (isVirtual(member) || member.isOpen || member.isAbstract) symbol.vtable.set(member, member);
          continue;
        }
        if (!member.isOverride && !symbol.isLibrary && !this.isGenerated(member)) {
          this.error(member.row, `${member.name} は親の ${member.name} を上書きするので、override を付けてください。`);
        }
        for (const base of overridden) {
          if (!isVirtual(base) && !base.isOpen && !base.isAbstract && !base.isOverride) {
            this.error(member.row, `${base.owner?.name ?? ''}.${member.name} は open ではないので、上書きできません。`);
          }
          if (base.kind === 'property' && member.kind === 'property' && base.isVar && !member.isVar) {
            this.error(member.row, `var の ${member.name} を val で上書きすることはできません。`);
          }
        }
        member.overridden = overridden;
        member.root = overridden[0].root;
        // An override of an operator or infix function is one as well, as Kotlin inherits these modifiers.
        if (member.kind === 'function') {
          for (const base of overridden) {
            if (base.kind !== 'function') continue;
            member.isOperator ||= base.isOperator;
            member.isInfix ||= base.isInfix;
          }
        }
        if (member.kind === 'function' && !member.isOverride && this.isGenerated(member)) member.isOverride = true;
        for (const base of overridden) symbol.vtable.set(base.root, member);
        symbol.vtable.set(member.root, member);
      }
    }
    this.linkDelegates(entry);
    if (!symbol.isAbstract && !symbol.isLibrary) {
      for (const [root, implementation] of symbol.vtable) {
        if (implementation.isAbstract) {
          const kind = root.kind === 'function' ? '関数' : 'プロパティ';
          this.error(
            symbol.row,
            `クラス ${symbol.name} は abstract ではないので、${kind} ${root.name} を実装してください。`
          );
        }
      }
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
    const fits = member.kind === 'property' && member.isVar ? isSameType(own, expected) : isSubtype(own, expected);
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

  // Phase 4: bodies.

  protected compileBodies(): void {
    for (const entry of this.propertyEntries) this.ensurePropertyCompiled(entry);
    // The defaults need the types of the fields, which inferred properties have only now.
    const done = new Set<ClassSymbol>();
    const setDefaults = (cls: ClassSymbol): void => {
      if (done.has(cls) || !this.entryOfClass.has(cls)) return;
      done.add(cls);
      if (cls.superclass) setDefaults(cls.superclass.cls);
      const defaults: Value[] = [...(cls.superclass?.cls.fieldDefaults ?? [])];
      defaults.length = cls.fieldCount;
      for (const property of cls.ownFields) defaults[property.slot as number] = this.defaultValueOf(property.type);
      cls.fieldDefaults = defaults;
    };
    for (const entry of this.classEntries) setDefaults(entry.symbol);
    for (const entry of this.functionEntries) this.ensureFunctionCompiled(entry);
    for (const entry of this.classEntries) {
      this.file = entry.file;
      this.compileClassInitializer(entry);
    }
  }

  protected ensureReturnType(func: FunctionSymbol, row: number): KType {
    if (func.returnType) return func.returnType;
    const entry = this.entryOfFunction.get(func);
    if (!entry) return this.core.unit.type;
    if (entry.state === 'compiling')
      this.error(row, `関数 ${func.name} は自分を呼んでいるので、戻り値の型を書いてください。`);
    this.ensureFunctionCompiled(entry);
    return func.returnType ?? this.core.unit.type;
  }

  protected ensurePropertyType(property: PropertySymbol, row: number): KType {
    if (property.type) return property.type;
    const entry = this.entryOfProperty.get(property);
    if (!entry) return anyType(true);
    if (entry.state === 'compiling')
      this.error(row, `プロパティ ${property.name} は自分を使っているので、型を書いてください。`);
    this.ensurePropertyCompiled(entry);
    return property.type ?? anyType(true);
  }

  /** Runs a compilation of another declaration in the middle of one, restoring what the current one had. */
  private withSavedState<T>(file: FileContext, compile: () => T): T {
    const savedFile = this.file;
    const savedFlow = this.flow;
    this.file = file;
    this.flow = new Flow();
    for (const variable of this.initializerVariables) this.flow.assigned.add(variable);
    try {
      return compile();
    } finally {
      this.file = savedFile;
      this.flow = savedFlow;
    }
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Parameters, receivers, defaults, the body, and the frame of a function.
  // code-gauge-allow functionNcss 52 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private ensureFunctionCompiled(entry: FunctionEntry): void {
    if (entry.state !== 'pending') return;
    entry.state = 'compiling';
    this.withSavedState(entry.file, () => {
      const { decl, symbol } = entry;
      const context = new FunctionContext(undefined, false, symbol.name, entry.file.isLibrary, undefined);
      Object.defineProperty(context, 'returnTarget', { value: context });
      context.info.isAtomic = symbol.isAtomic;
      const scope = new Scope(entry.scope, context);
      const thisType = this.addReceivers(scope, context, entry.cls, symbol.extensionReceiver, symbol.name);
      // An object's members show its properties as `Name.x`, as Java's static members do, rather than as `this.x`.
      context.info.showsThis =
        thisType !== undefined && entry.cls !== undefined && !entry.cls.symbol.isObject && !entry.file.isLibrary;
      const variables = symbol.params.map((param, index) =>
        this.newParameter(
          scope,
          context,
          param.name,
          param.isVararg ? this.varargType(param.type) : param.type,
          decl.params[index].row
        )
      );
      // A default value sees only the parameters before its own.
      const defaults = symbol.params.map((param, index) => {
        this.flow.assigned.add(variables[index]);
        const value = decl.params[index].defaultValue;
        if (!value) return;
        const compiled = this.compileExpression(scope, context, value, param.type);
        return convertRepr(
          this.expectType(compiled, param.type, value.row),
          reprOf(this.core, param.type),
          reprOf(this.core, param.type)
        );
      });
      for (const [index, evaluate] of defaults.entries()) {
        if (evaluate) symbol.params[index].defaultValue = evaluate;
      }
      if (!decl.body) {
        symbol.defaultsInfo = context.info;
        entry.state = 'done';
        return;
      }
      let body: Eval;
      if (decl.body.kind === 'expression') {
        const compiled = this.compileExpression(scope, context, decl.body.expression, symbol.returnType);
        symbol.returnType ??= this.inferredResultType(compiled);
        context.returnType = symbol.returnType;
        body = convertRepr(
          this.expectType(compiled, symbol.returnType, decl.body.expression.row),
          reprOf(this.core, symbol.returnType),
          returnRepr(symbol)
        );
      } else {
        const returnType = symbol.returnType as KType;
        context.returnType = returnType;
        context.returnRepr = returnRepr(symbol);
        const compiled = this.compileStatementsValue(
          scope,
          context,
          decl.body.block.statements,
          undefined,
          true,
          false
        );
        const isUnit = this.isClass(returnType, this.core.unit);
        if (!isUnit && !this.flow.isDead && !(resolved(returnType).kind === 'nothing')) {
          this.error(decl.body.block.endRow, `関数 ${symbol.name} の最後に return を書いてください。`);
        }
        const evaluate = compiled.eval;
        body = isUnit
          ? (frame) => {
              evaluate(frame);
              return UNIT;
            }
          : (frame) => {
              evaluate(frame);
              return UNIT;
            };
      }
      this.finishFunction(symbol, context, defaults, body);
      entry.state = 'done';
    });
  }

  /** The type a `vararg` parameter has inside its function: an array of its elements. */
  protected abstract varargType(elementType: KType): KType;

  private inferredResultType(compiled: Compiled): KType {
    const type = resolved(compiled.type);
    if (compiled.integerLiteral) return this.primitiveType(this.primitiveOf(type) ?? 'Int');
    return type;
  }

  /** Adds the implicit receivers of a member or extension: the class's instance, and an extension's receiver. */
  private addReceivers(
    scope: Scope,
    context: FunctionContext,
    cls: ClassEntry | undefined,
    extension: KType | undefined,
    label?: string
  ): KType | undefined {
    let thisType: KType | undefined;
    if (cls) {
      thisType = this.thisTypeOf(cls.symbol);
      if (!extension) scope.receiver = new ReceiverSymbol(thisType, context, cls.symbol, cls.symbol.name);
      // An extension declared in an object, as `Int.minutes` in `Duration.Companion`, needs no instance of it.
      else if (!cls.symbol.isObject || !cls.file.isLibrary)
        this.unavailable(cls.symbol.row, 'クラスの中での拡張関数・拡張プロパティの宣言');
    }
    if (extension) {
      scope.receiver = new ReceiverSymbol(extension, context, undefined, label);
      thisType = extension;
    }
    return thisType;
  }

  private finishFunction(
    symbol: FunctionSymbol,
    context: FunctionContext,
    defaults: (Eval | undefined)[],
    body: Eval
  ): void {
    const { info } = context;
    const fillsDefaults = defaults.some((evaluate) => evaluate !== undefined);
    const run: Eval = fillsDefaults
      ? (frame) => {
          for (const [index, evaluate] of defaults.entries()) {
            if (evaluate && frame.locals[index] === MISSING) frame.locals[index] = evaluate(frame);
          }
          return body(frame);
        }
      : body;
    const none: unknown[] = [];
    symbol.invoke = (caller, receiver, args, callRow) =>
      caller.runtime.call(info, caller, none, receiver, args, callRow, run);
  }

  // code-gauge-allow functionCognitiveComplexity 24 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private ensurePropertyCompiled(entry: PropertyEntry): void {
    if (entry.state !== 'pending') return;
    entry.state = 'compiling';
    this.withSavedState(entry.file, () => {
      const { decl, symbol } = entry;
      // Initializers run in the class's initializer, whose scope sees the primary constructor's parameters.
      if (decl.initializer && !symbol.type) {
        const context = this.initializerContext(entry);
        const scope = this.initializerScope(entry, context);
        const compiled = this.compileExpression(scope, context, decl.initializer);
        const type = resolved(compiled.type);
        symbol.type = compiled.integerLiteral ? this.primitiveType(this.primitiveOf(type) ?? 'Int') : type;
      }
      if (decl.delegate) this.compileMemberDelegate(entry);
      else if (!symbol.type && decl.getter?.body) {
        symbol.type = this.compileAccessorType(entry);
      }
      const isPlainTopLevel = !entry.cls && !decl.delegate;
      // The global comes first, as the accessors' `field` is the global and the accessors replace its plain ones.
      if (isPlainTopLevel && this.hasBackingField(decl, symbol)) this.bindGlobal(entry);
      if (decl.getter?.body) this.compileGetter(entry);
      if (decl.setter?.body) this.compileSetter(entry);
      entry.state = 'done';
    });
  }

  private initializerContexts = new Map<ClassEntry | FileContext, FunctionContext>();

  /** The context of a class's initializer, or of the file's for top-level properties. */
  protected initializerContext(entry: { cls: ClassEntry | undefined; file: FileContext }): FunctionContext {
    const key = entry.cls ?? entry.file;
    let context = this.initializerContexts.get(key);
    if (!context) {
      const name = entry.cls ? entry.cls.symbol.name : '<init>';
      context = new FunctionContext(undefined, false, name, entry.file.isLibrary, undefined);
      context.info.showsThis = entry.cls !== undefined && !entry.cls.symbol.isObject && !entry.file.isLibrary;
      this.initializerContexts.set(key, context);
    }
    return context;
  }

  private initializerScopes = new Map<FunctionContext, Scope>();

  protected initializerScope(
    entry: { cls: ClassEntry | undefined; scope: Scope; file: FileContext },
    context: FunctionContext
  ): Scope {
    let scope = this.initializerScopes.get(context);
    if (scope) return scope;
    scope = new Scope(entry.cls ? entry.cls.scope : entry.scope, context);
    if (entry.cls) {
      scope.receiver = new ReceiverSymbol(
        this.thisTypeOf(entry.cls.symbol),
        context,
        entry.cls.symbol,
        entry.cls.symbol.name
      );
      const ctor = entry.cls.constructorSymbol;
      for (const [index, param] of (ctor?.params ?? []).entries()) {
        const row = entry.cls.decl.primaryConstructor?.params[index]?.row ?? entry.cls.decl.row;
        const variable = this.newParameter(scope, context, param.name, param.type, row);
        this.flow.assigned.add(variable);
        this.initializerVariables.add(variable);
      }
    }
    this.initializerScopes.set(context, scope);
    return scope;
  }

  /** The constructor parameters that class initializers see, which every initializer has assigned. */
  protected readonly initializerVariables = new Set<VariableSymbol>();

  private bindGlobal(entry: PropertyEntry): void {
    const { symbol } = entry;
    const slot = this.globalCount++;
    symbol.slot = slot;
    symbol.get = (frame) => frame.runtime.globals[slot];
    symbol.set = (frame, _receiver, value) => {
      frame.runtime.globals[slot] = value;
    };
  }

  /** The type of a property whose getter gives it, as `val isEmpty get() = size == 0` does. */
  private compileAccessorType(entry: PropertyEntry): KType {
    const body = entry.decl.getter?.body;
    if (body?.kind !== 'expression') this.error(entry.decl.row, `プロパティ ${entry.decl.name} の型を書いてください。`);
    const { context, scope } = this.accessorContext(entry, 'get');
    const compiled = this.compileExpression(scope, context, body.expression);
    return this.inferredResultType(compiled);
  }

  private accessorContext(entry: PropertyEntry, kind: 'get' | 'set'): { context: FunctionContext; scope: Scope } {
    const context = new FunctionContext(
      undefined,
      false,
      `${kind}-${entry.symbol.name}`,
      entry.file.isLibrary,
      undefined
    );
    Object.defineProperty(context, 'returnTarget', { value: context });
    context.info.showsThis = entry.cls !== undefined && !entry.cls.symbol.isObject && !entry.file.isLibrary;
    const scope = new Scope(entry.scope, context);
    this.addReceivers(scope, context, entry.cls, entry.symbol.extensionReceiver);
    const { slot } = entry.symbol;
    if (slot !== undefined) {
      const field = new VariableSymbol(
        'field',
        entry.symbol.type ?? anyType(true),
        entry.symbol.isVar,
        0,
        -1,
        entry.decl.row
      );
      field.owner = context;
      const storage = (frame: Frame): Value[] =>
        entry.cls ? (frame.thisValue as KObject).fields : frame.runtime.globals;
      field.delegateRead = (frame) => storage(frame)[slot];
      if (entry.symbol.isVar) {
        field.delegateWrite = (frame, value) => {
          storage(frame)[slot] = value;
        };
      }
      scope.variables.set('field', field);
      this.flow.assigned.add(field);
    }
    return { context, scope };
  }

  private compileGetter(entry: PropertyEntry): void {
    const { symbol, decl } = entry;
    const body = decl.getter?.body;
    if (!body) return;
    const { context, scope } = this.accessorContext(entry, 'get');
    const type = symbol.type as KType;
    context.returnType = type;
    context.returnRepr = propertyRepr(symbol);
    let run: Eval;
    if (body.kind === 'expression') {
      const compiled = this.compileExpression(scope, context, body.expression, type);
      run = convertRepr(
        this.expectType(compiled, type, body.expression.row),
        reprOf(this.core, type),
        propertyRepr(symbol)
      );
    } else {
      const compiled = this.compileStatementsValue(scope, context, body.block.statements, undefined, true, false);
      if (!this.flow.isDead) this.error(body.block.endRow, `get の最後に return を書いてください。`);
      const evaluate = compiled.eval;
      run = (frame) => {
        evaluate(frame);
        return UNIT;
      };
    }
    const { info } = context;
    const none: unknown[] = [];
    symbol.get = (frame, receiver) => frame.runtime.call(info, frame, none, receiver, [], undefined, run);
  }

  private compileSetter(entry: PropertyEntry): void {
    const { symbol, decl } = entry;
    const setter = decl.setter;
    if (!setter?.body) return;
    const { context, scope } = this.accessorContext(entry, 'set');
    const type = symbol.type as KType;
    context.returnType = this.core.unit.type;
    const value = this.newVariable(scope, context, setter.parameterName ?? 'value', type, false, setter.row);
    this.flow.assigned.add(value);
    const compiled =
      setter.body.kind === 'expression'
        ? this.compileForEffect(scope, context, setter.body.expression)
        : this.compileStatementsValue(scope, context, setter.body.block.statements, undefined, true, false);
    const evaluate = compiled.eval;
    const { info } = context;
    const none: unknown[] = [];
    const repr = propertyRepr(symbol);
    void repr;
    symbol.set = (frame, receiver, newValue) => {
      frame.runtime.call(info, frame, none, receiver, [newValue], undefined, (inner) => {
        evaluate(inner);
        return UNIT;
      });
    };
  }

  /** A property delegated with `by`, whose delegate's `getValue` and `setValue` read and write it. */
  // code-gauge-allow functionNcss 41 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private compileMemberDelegate(entry: PropertyEntry): void {
    const { symbol, decl } = entry;
    const context = this.initializerContext(entry);
    const scope = this.initializerScope(entry, context);
    const delegate = this.compileExpression(scope, context, decl.delegate as Expression);
    entry.initializer = delegate;
    const slot = entry.delegateSlot;
    const holderScope = new Scope(scope, context);
    const holder = new VariableSymbol('\0delegate', delegate.type, false, 0, -1, decl.row);
    holder.owner = context;
    const held = new Handoff<{ delegate: Value; value: Value }>();
    holder.delegateRead = () => held.get().delegate;
    holderScope.variables.set(holder.name, holder);
    this.flow.assigned.add(holder);
    const holderCompiled = this.compileName(holderScope, context, holder.name, decl.row);
    const thisArgument: ArgumentSyntax = entry.cls
      ? { row: decl.row, name: undefined, value: { kind: 'this', row: decl.row, label: undefined } }
      : { row: decl.row, name: undefined, value: { kind: 'null', row: decl.row } };
    const getter = this.compileDelegateCall(
      holderScope,
      context,
      holderCompiled,
      'getValue',
      [thisArgument, this.propertyReference(holderScope, decl.name, decl.row)],
      decl.row
    );
    if (!symbol.type) symbol.type = getter.type;
    else if (!isSubtype(getter.type, symbol.type)) this.error(decl.row, typeMismatchMessage(symbol.type, getter.type));
    const getEval = convertRepr(getter.eval, getter.repr, propertyRepr(symbol));
    // A top-level property's delegate lives in the globals, which the file's initializers fill when the run starts.
    const globalSlot = slot === undefined ? this.globalCount++ : undefined;
    if (globalSlot !== undefined) entry.delegateGlobal = globalSlot;
    const readDelegate = (frame: Frame, receiver: Value): Value =>
      globalSlot === undefined ? (receiver as KObject).fields[slot as number] : frame.runtime.globals[globalSlot];
    const { info } = context;
    const none: unknown[] = [];
    const runHeld = (frame: Frame, receiver: Value, run: Eval, value?: Value): Value =>
      frame.runtime.call(info, frame, none, receiver, [], undefined, (inner) =>
        held.run(inner, { delegate: readDelegate(frame, receiver), value }, () => run(inner))
      );
    symbol.get = (frame, receiver) => runHeld(frame, receiver, getEval);
    if (decl.isVar) {
      const valueVariable = new VariableSymbol('\0value', symbol.type, false, 0, -1, decl.row);
      valueVariable.owner = context;
      valueVariable.delegateRead = () => held.get().value;
      holderScope.variables.set(valueVariable.name, valueVariable);
      this.flow.assigned.add(valueVariable);
      const setter = this.compileDelegateCall(
        holderScope,
        context,
        holderCompiled,
        'setValue',
        [
          thisArgument,
          this.propertyReference(holderScope, decl.name, decl.row),
          { row: decl.row, name: undefined, value: { kind: 'name', row: decl.row, name: '\0value' } },
        ],
        decl.row
      );
      const setEval = setter.eval;
      symbol.set = (frame, receiver, value) => {
        runHeld(frame, receiver, setEval, value);
      };
    }
  }

  // Classes' initializers.

  private compileClassInitializer(entry: ClassEntry): void {
    const { symbol, decl } = entry;
    if (symbol.isInterface || symbol.isNative) return;
    const owner = { cls: entry, scope: entry.scope, file: entry.file };
    const context = this.initializerContext(owner);
    const scope = this.initializerScope(owner, context);
    this.flow = new Flow();
    for (const variable of this.initializerVariables) this.flow.assigned.add(variable);
    const ctor = entry.constructorSymbol;
    // Default values of the constructor's parameters.
    const defaults = (ctor?.params ?? []).map((param, index) => {
      const value = decl.primaryConstructor?.params[index]?.defaultValue;
      if (!value) return;
      const compiled = this.compileExpression(scope, context, value, param.type);
      return this.expectType(compiled, param.type, value.row);
    });
    for (const [index, evaluate] of defaults.entries())
      if (evaluate && ctor) ctor.params[index].defaultValue = evaluate;
    const superCall = this.compileSuperConstructorCall(entry, scope, context);
    const steps: ((frame: Frame) => void)[] = [];
    for (const field of entry.delegateFields) {
      const compiled = this.compileExpression(scope, context, field.spec.delegate, field.type);
      const evaluate = this.expectType(compiled, field.type, field.spec.row);
      const { slot } = field;
      steps.push((frame) => {
        (frame.thisValue as KObject).fields[slot] = evaluate(frame);
      });
    }
    for (const { symbol: property, index } of entry.parameterProperties) {
      const slot = property.slot as number;
      steps.push((frame) => {
        (frame.thisValue as KObject).fields[slot] = frame.locals[index] as Value;
      });
    }
    const uninitialized = new Set(
      decl.members.flatMap((member) =>
        member.kind === 'property' && member.initializer ? [this.findOwnProperty(symbol, member.name)] : []
      )
    );
    this.uninitializedProperties = { context, properties: uninitialized };
    for (const member of decl.members) {
      if (member.kind === 'property') {
        const property = this.findOwnProperty(symbol, member.name);
        uninitialized.delete(property);
        const propertyEntry = this.entryOfProperty.get(property) as PropertyEntry;
        if (member.delegate) {
          const delegate = propertyEntry.initializer as Compiled;
          const slot = propertyEntry.delegateSlot as number;
          const evaluate = delegate.eval;
          steps.push(
            this.withStep(
              member.row,
              (frame) => {
                (frame.thisValue as KObject).fields[slot] = evaluate(frame);
              },
              delegate.isCreation === true
            )
          );
          continue;
        }
        if (!member.initializer || property.slot === undefined) continue;
        const compiled = this.compileExpression(scope, context, member.initializer, property.type);
        const type = property.type as KType;
        const evaluate = convertRepr(
          this.expectType(compiled, type, member.initializer.row),
          reprOf(this.core, type),
          propertyRepr(property)
        );
        const slot = property.slot;
        const store = (frame: Frame): void => {
          (frame.thisValue as KObject).fields[slot] = evaluate(frame);
        };
        if (compiled.constant !== undefined) property.constantInitializer = compiled.constant;
        // An object's property initialized with a constant records no step, as a Java static field's does: the trace
        // shows the constant from the start.
        const isQuiet = symbol.isObject && compiled.constant !== undefined;
        steps.push(isQuiet ? store : this.withStep(member.row, store, compiled.isCreation === true));
      } else if (member.kind === 'init') {
        const compiled = this.compileBlockValue(scope, context, member.block, undefined, true);
        const evaluate = compiled.eval;
        steps.push((frame) => {
          evaluate(frame);
        });
      }
    }
    this.uninitializedProperties = undefined;
    this.checkValsInitialized(entry);
    if (symbol.kind === 'enum') this.compileEnumArguments(entry);
    const { info } = context;
    const run = (frame: Frame): Value => {
      for (const [index, evaluate] of defaults.entries()) {
        if (evaluate && frame.locals[index] === MISSING) frame.locals[index] = evaluate(frame);
      }
      superCall?.(frame);
      for (const step of steps) step(frame);
      return UNIT;
    };
    const none: unknown[] = [];
    const initialize = (caller: Frame, instance: Value, args: Value[], callRow: number | undefined): void => {
      caller.runtime.call(info, caller, none, instance, args, callRow, run);
    };
    symbol.initialize = (frame, instance) => initialize(frame, instance, [], undefined);
    if (symbol.isObject) {
      this.objectInitializers.set(symbol, initialize);
      return;
    }
    if (!ctor) return;
    ctor.initialize = initialize;
    const fieldCount = (): number => symbol.fieldCount;
    const companionInit = symbol.companion ? this.objectInstance(symbol.companion) : undefined;
    const isAbstract = symbol.isAbstract;
    ctor.invoke = (caller, _receiver, args, callRow) => {
      if (isAbstract) return caller.runtime.throwError(caller, 'java.lang.InstantiationError', symbol.qualifiedName);
      companionInit?.(caller);
      const instance = new KObject(symbol, fieldCount());
      caller.runtime.allocate(caller, instance.fields.length + 1);
      initialize(caller, instance, args, callRow);
      return instance;
    };
  }

  protected readonly objectInitializers = new Map<
    ClassSymbol,
    (caller: Frame, instance: Value, args: Value[], callRow: number | undefined) => void
  >();

  /** Rejects a `val` property that neither an initializer nor an `init` block gives a value. */
  private checkValsInitialized(entry: ClassEntry): void {
    for (const member of entry.decl.members) {
      // A property with accessors needs a value only when they use its backing field, which then has a slot.
      if (member.kind !== 'property' || member.initializer || member.delegate) continue;
      const property = this.findOwnProperty(entry.symbol, member.name);
      if (property.isAbstract || property.slot === undefined || property.isLateinit) continue;
      if (!this.assignedInInit(entry.decl, member.name)) {
        this.error(member.row, `プロパティ ${member.name} には初期値を書くか、init で値を入れてください。`);
      }
    }
  }

  /** Whether an `init` block assigns a property, as `name = ...` or `this.name = ...`. */
  private assignedInInit(decl: ClassDecl, name: string): boolean {
    const isTarget = (target: Expression): boolean =>
      (target.kind === 'name' && target.name === name) ||
      (target.kind === 'member' && target.name === name && target.receiver.kind === 'this');
    const visit = (statements: Statement[]): boolean =>
      statements.some((statement) => {
        if (statement.kind === 'assignment') return isTarget(statement.target);
        if (statement.kind === 'expressionStatement' && statement.expression.kind === 'if') {
          const { thenBranch, elseBranch } = statement.expression;
          return elseBranch !== undefined && visit(thenBranch.statements) && visit(elseBranch.statements);
        }
        return false;
      });
    return decl.members.some((member) => member.kind === 'init' && visit(member.block.statements));
  }

  protected mayInitializeVal(scope: Scope, symbol: PropertySymbol): boolean {
    if (!symbol.owner || symbol.slot === undefined) return false;
    const entry = this.entryOfProperty.get(symbol);
    if (!entry || entry.decl.initializer) return false;
    // Only the class's own initializer, which `init` blocks belong to, may give a val its value.
    const context = this.initializerContexts.get(this.entryOfClass.get(symbol.owner) as ClassEntry);
    return context !== undefined && this.receiversOf(scope).some((receiver) => receiver.context === context);
  }

  private compileSuperConstructorCall(
    entry: ClassEntry,
    scope: Scope,
    context: FunctionContext
  ): ((frame: Frame) => void) | undefined {
    const { symbol, decl } = entry;
    if (symbol.kind === 'enum') {
      const enumCtor = this.core.enum.constructors[0];
      return (frame) => {
        const instance = frame.thisValue as KObject;
        const native = instance.native as { name: string; ordinal: number };
        (enumCtor.initialize as NonNullable<FunctionSymbol['initialize']>)(
          frame,
          instance,
          [native.name, native.ordinal],
          undefined
        );
      };
    }
    const superclass = symbol.superclass;
    if (!superclass || superclass.cls === this.core.any) return undefined;
    if (superclass.cls.isNative && superclass.cls.constructors.length === 0) return undefined;
    const spec = decl.supers.find(
      (candidate) =>
        candidate.kind === 'constructorCall' &&
        this.resolveType(entry.scope, candidate.type).kind === 'class' &&
        (this.resolveType(entry.scope, candidate.type) as ClassType).cls === superclass.cls
    );
    const args: ArgumentSyntax[] =
      spec?.kind === 'constructorCall'
        ? spec.args.map((argument) => ({ row: argument.row, name: argument.name, value: argument.value }))
        : [];
    const candidates: Candidate[] = superclass.cls.constructors.map((ctor) => ({
      symbol: ctor,
      kind: 'constructor',
      substitution: substitutionOf(superclass),
      receiverType: undefined,
    }));
    if (candidates.length === 0) this.error(decl.row, `${superclass.cls.name} のコンストラクタを呼べません。`);
    const savedRecords = this.recordsSteps;
    const call = this.resolveCall(
      scope,
      context,
      [candidates],
      args,
      false,
      [],
      undefined,
      undefined,
      spec?.row ?? decl.row,
      superclass.cls.name
    );
    this.recordsSteps = savedRecords;
    // A superclass constructor called without arguments, as in `: MyTurtle()`, is part of the step of the
    // constructor that calls it, as Java's implicit `super()` is.
    const isExplicit = spec?.kind === 'constructorCall' && spec.args.length > 0;
    const initializer = this.superInitializer(
      call,
      isExplicit && this.recordsSteps && !entry.file.isLibrary ? spec.row : undefined
    );
    return (frame) => initializer(frame, frame.thisValue);
  }

  /** Runs the superclass's constructor on the instance being created, with the arguments the subclass passes. */
  protected abstract superInitializer(
    call: ResolvedCall,
    callRow: number | undefined
  ): (frame: Frame, instance: Value) => void;

  // Objects and enums.

  objectInstance(cls: ClassSymbol): (frame: Frame) => Value {
    return (frame) => {
      const existing = frame.runtime.objects.get(cls);
      if (existing) return existing;
      return this.createObject(frame, cls);
    };
  }

  /** Creates an object, a companion object, or an enum class's constants when the program first uses them. */
  private createObject(frame: Frame, cls: ClassSymbol): Value {
    const { runtime } = frame;
    if (cls.kind === 'enum') {
      const marker = new KObject(cls, 0);
      runtime.objects.set(cls, marker);
      this.createEnumEntries(frame, cls);
      if (cls.companion) this.objectInstance(cls.companion)(frame);
      return marker;
    }
    const instance = new KObject(cls);
    runtime.objects.set(cls, instance);
    const initialize = this.objectInitializers.get(cls);
    if (initialize) initialize(frame, instance, [], undefined);
    else cls.initialize?.(frame, instance);
    return instance;
  }

  private createEnumEntries(frame: Frame, cls: ClassSymbol): void {
    const entry = this.entryOfClass.get(cls);
    if (!entry) return;
    const ctor = entry.constructorSymbol as FunctionSymbol;
    const instances: KObject[] = [];
    frame.runtime.enumEntries.set(cls, instances);
    for (const [ordinal, enumEntry] of entry.decl.enumEntries.entries()) {
      const instance = new KObject(cls);
      instance.native = { name: enumEntry.name, ordinal };
      instances.push(instance);
      const args = this.enumArguments.get(cls)?.[ordinal];
      (ctor.initialize as NonNullable<FunctionSymbol['initialize']>)(
        frame,
        instance,
        args ? args(frame) : [],
        undefined
      );
    }
  }

  /** Compiles the arguments each enum constant passes to its class's constructor, as `RED(0xFF0000)` does. */
  private compileEnumArguments(entry: ClassEntry): void {
    const ctor = entry.constructorSymbol as FunctionSymbol;
    const context = new FunctionContext(
      undefined,
      false,
      `${entry.symbol.name}-entries`,
      entry.file.isLibrary,
      undefined
    );
    const scope = new Scope(entry.scope, context);
    const candidates: Candidate[] = [
      { symbol: ctor, kind: 'constructor', substitution: new Map(), receiverType: undefined },
    ];
    const savedRecords = this.recordsSteps;
    this.recordsSteps = false;
    try {
      const evaluators = entry.decl.enumEntries.map((enumEntry) => {
        const args: ArgumentSyntax[] = enumEntry.args.map((argument) => ({
          row: argument.row,
          name: argument.name,
          value: argument.value,
        }));
        return this.resolveCall(
          scope,
          context,
          [candidates],
          args,
          false,
          [],
          undefined,
          undefined,
          enumEntry.row,
          enumEntry.name
        ).evaluateArgs;
      });
      this.enumArguments.set(entry.symbol, evaluators);
    } finally {
      this.recordsSteps = savedRecords;
    }
  }

  /** The arguments of each enum constant's constructor, compiled with the class. */
  protected readonly enumArguments = new Map<ClassSymbol, ((frame: Frame) => Value[])[]>();

  protected compileEnumEntries(cls: ClassSymbol): Compiled {
    const instance = this.objectInstance(cls);
    const entries = this.enumEntriesValue(cls);
    return {
      type: {
        kind: 'class',
        cls: this.enumEntriesClass(),
        args: [{ variance: 'inv', type: cls.type }],
        nullable: false,
      },
      repr: 'ref',
      eval: (frame) => {
        instance(frame);
        return entries(frame, frame.runtime.enumEntries.get(cls) ?? []);
      },
    };
  }

  /** The class of `entries`, a read-only list of an enum class's constants. */
  protected abstract enumEntriesClass(): ClassSymbol;

  protected abstract enumEntriesValue(cls: ClassSymbol): (frame: Frame, entries: KObject[]) => Value;

  // Helpers for subclasses.

  protected declaredFunctionEntry(symbol: FunctionSymbol): FunctionEntry | undefined {
    return this.entryOfFunction.get(symbol);
  }

  protected classEntryOf(symbol: ClassSymbol): ClassEntry | undefined {
    return this.entryOfClass.get(symbol);
  }

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

  protected receiverReprOf(symbol: FunctionSymbol): Repr {
    return receiverRepr(symbol);
  }

  protected parameterReprsOf(symbol: FunctionSymbol): Repr[] {
    return parameterReprs(symbol);
  }

  protected defaultToStringOf(value: Value): string {
    return defaultToString(value);
  }

  protected identityHashOf(value: Value): number {
    return identityHash(value);
  }

  protected unboxed(value: Value): Value {
    return value instanceof Boxed ? value.value : value;
  }

  protected nullableOf(type: KType): KType {
    return nullable(type);
  }

  protected nothing(): KType {
    return NOTHING;
  }

  protected asSuperType(type: ClassType, cls: ClassSymbol): ClassType | undefined {
    return asSuper(type, cls);
  }

  protected describe(type: KType): string {
    return typeToString(type);
  }

  protected defaultImports(): string[] {
    return DEFAULT_IMPORTS;
  }

  protected newPackageScope(): PackageScope {
    return new PackageScope();
  }

  protected unassigned(): unknown {
    return UNASSIGNED;
  }

  protected declarationKinds(declaration: Declaration): string {
    return declaration.kind;
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
