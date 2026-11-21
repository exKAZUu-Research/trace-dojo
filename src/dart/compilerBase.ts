// code-gauge-allow-file fileNcss 576 -- Declaration scopes, types, and record shapes share the compiler environment.
import { CompileError } from '../interpreter/diagnostics';
import type {
  ClassDeclaration,
  ExtensionDeclaration,
  Span,
  TypeAliasDeclaration,
  TypeParameter,
  TypeSyntax,
} from './ast';
import { declaredMemberNames } from './astWalk';
import { type ClassInfo, type Member, memberTypeIn, scopedMemberName } from './classes';
import type { ExtensionInfo, GlobalVariable, LibraryEnv, TypeAlias } from './environment';
import { eraseExtensionTypes } from './eraseExtensionTypes';
import type { Frame, FunctionInfo, Runtime, TypeEnv } from './runtime';
import { Flow, type FunctionContext, LocalScope, LocalVar } from './scope';
import { inferExtensionReceiver, inferTearOffTypes } from './typeInference';
import {
  asInstanceOf,
  boundOf,
  coreTypes,
  type DartType,
  DYNAMIC,
  type FunctionType,
  functionType,
  instantiateFunction,
  instantiateToBounds,
  type InterfaceType,
  interfaceType,
  isFunctionLike,
  isNeverType,
  isNullable,
  isPotentiallyNullable,
  isSubtype,
  isTop,
  makeNullable,
  mentionsTypeParams,
  NEVER,
  NULL,
  objectType,
  resolveBound,
  substitute,
  TypeParam,
  typeParamType,
  typeToString,
  vmTypeString,
  VOID,
} from './types';
import { type Cell, DartClosure, type DartRecord, recordPositionalIndex, type Value } from './values';

export type Eval = (frame: Frame) => Value;

/** A compiled expression: its static type and how to evaluate it. */
interface TypeResolutionOptions {
  allowRaw?: boolean;
  inferOmitted?: (template: DartType, parameters: readonly TypeParam[]) => DartType;
}

export interface Compiled {
  type: DartType;
  run: Eval;
  /** Whether the expression is a constant expression. */
  isConst: boolean;
  /** The value of a constant of a primitive type, known while compiling. */
  constValue?: { value: Value };
  /** The local or promoted field path an expression reads. */
  variable?: LocalVar;
  thisReference?: true;
  isSuper?: true;
  /** Whether the expression creates an object, whose constructor's steps show what it did. */
  creates?: boolean;
  /** An explicit extension application `E(x)`, whose members are the extension's. */
  extensionOverride?: { ext: ExtensionInfo; typeArgs: DartType[] };
}

/** A member found through a static type, with its type in terms of the receiver's type arguments. */
export interface ResolvedMember {
  member: Member;
  /** The type of a field or getter, the parameter of a setter, or the signature of a method. */
  type: DartType;
  /** An extension member, or a member of an extension type, which runs on the receiver without dispatch. */
  extension?: { ext: ExtensionInfo | undefined; typeArgs: readonly DartType[]; onType?: DartType };
}

/** Only the position of a span, without the fields of the node it belongs to. */
export function at(span: Span): Span {
  return { row: span.row, column: span.column, start: span.start, end: span.end };
}

/** Names of the SDK the interpreter does not provide, with what they are, for the message that they are unavailable. */
const UNAVAILABLE_NAMES: Record<string, string> = {
  DateTime: 'DateTime（日付と時刻）',
  Stopwatch: 'Stopwatch（時間の計測）',
  Future: 'Future（非同期処理）',
  FutureOr: 'FutureOr（非同期処理）',
  Stream: 'Stream（非同期処理）',
  StreamController: 'StreamController（非同期処理）',
  Timer: 'Timer（非同期処理）',
  Completer: 'Completer（非同期処理）',
  Zone: 'Zone（非同期処理）',
  scheduleMicrotask: 'scheduleMicrotask（非同期処理）',
  Isolate: 'Isolate',
  stdin: 'stdin（標準入力）',
  exitCode: 'exitCode（プロセスの終了状態）',
  File: 'File（ファイルの読み書き）',
  Directory: 'Directory（ファイルの読み書き）',
  FileSystemEntity: 'FileSystemEntity（ファイルの読み書き）',
  Platform: 'Platform（実行環境の情報）',
  Process: 'Process（外部のプロセス）',
  HttpClient: 'HttpClient（ネットワーク）',
  HttpServer: 'HttpServer（ネットワーク）',
  Socket: 'Socket（ネットワーク）',
  Uri: 'Uri',
  sleep: 'sleep（実行を止める）',
  Expando: 'Expando',
  WeakReference: 'WeakReference',
  Finalizer: 'Finalizer',
  Uint8List: 'Uint8List（dart:typed_data）',
  Int32List: 'Int32List（dart:typed_data）',
  Float64List: 'Float64List（dart:typed_data）',
  ByteData: 'ByteData（dart:typed_data）',
};

const UNAVAILABLE_SINK_MEMBERS = new Set([
  'add',
  'addError',
  'addStream',
  'close',
  'done',
  'encoding',
  'flush',
  'hasTerminal',
  'nonBlocking',
  'terminalColumns',
  'terminalLines',
  'supportsAnsiEscapes',
]);
const UNAVAILABLE_STATIC_MEMBERS = new Set(['dart:math.Random.secure', 'dart:core.StackTrace.current']);
const SPECIAL_TYPES = new Map<string, DartType>([
  ['dynamic', DYNAMIC],
  ['Never', NEVER],
  ['Null', NULL],
]);

export function typeName(type: DartType): string {
  return `'${typeToString(type)}'`;
}

/** Holds what every part of the compiler shares: the library being compiled, the function, and flow analysis. */
export abstract class CompilerBase {
  /** The function being compiled. */
  fn!: FunctionContext;
  flow: Flow = Flow.start();
  /** The type parameters in scope, innermost last. */
  protected typeScopes: { names: Map<string, TypeParam>; staticOwner: boolean; enclosingFunction?: FunctionContext }[] =
    [];
  private typeLookupBoundary: FunctionContext | undefined;
  private readonly memberBindings = new WeakMap<ClassDeclaration | ExtensionDeclaration, ReadonlySet<string>>();
  /** The class whose body is being compiled. */
  protected currentClass: ClassInfo | undefined;
  protected currentExtension: ExtensionInfo | undefined;
  /** Whether the function being compiled records steps when the program is traced. */
  protected recordsSteps = false;
  protected readonly aliasWork = new Map<TypeAlias, TypeAliasDeclaration>();
  protected readonly pendingClassBounds = new Map<ClassInfo, ClassDeclaration>();
  protected pendingBoundChecks: (() => void)[] | undefined;
  readonly recordFieldNames = new Set<string>();

  constructor(
    readonly library: LibraryEnv,
    readonly isLibraryCode: boolean,
    /** The rows of `// atomic` annotations, when compiling a model program for a trace. */
    readonly atomicRows: ReadonlySet<number> | undefined,
    readonly globals: GlobalVariable[]
  ) {}

  error(span: Span | { row: number }, message: string): never {
    throw new CompileError([{ row: span.row, message }]);
  }

  unsupported(span: Span | { row: number }, what: string): never {
    return this.error(span, `${what}は、この採点環境では使えません。`);
  }

  protected checkUnavailableIoMember(receiver: DartType, name: string, span: Span): void {
    const type = resolveBound(receiver);
    if (type.kind !== 'interface' || type.cls.library !== 'dart:io') return;
    if ((type.cls.name === 'Stdout' || type.cls.name === 'IOSink') && UNAVAILABLE_SINK_MEMBERS.has(name))
      this.unsupported(span, type.cls.name + '.' + name);
  }

  protected checkUnavailableStaticMember(cls: ClassInfo, name: string, span: Span): void {
    if (name.startsWith('_') && cls.library !== this.library.name) {
      this.error(span, `${cls.name} の ${name} は、宣言されているライブラリの中だけで使えます。`);
    }
    if (UNAVAILABLE_STATIC_MEMBERS.has(`${cls.library}.${cls.name}.${name}`)) {
      this.unsupported(span, `${cls.name}.${name}`);
    }
  }

  protected checkMixinConstraints(base: InterfaceType, mixin: InterfaceType, span: Span): void {
    const types = new Map(mixin.cls.typeParams.map((parameter, index) => [parameter, mixin.args[index]]));
    for (const onType of mixin.cls.onTypes) {
      const required = substitute(onType, types);
      if (!isSubtype(base, required)) {
        this.error(
          span,
          `${typeName(base)} は ${typeName(required)} のサブタイプではないので、mixin ${mixin.cls.name} は使えません。`
        );
      }
    }
  }

  /** Rejects a name the program does not define: as unavailable when the SDK has it outside what the interpreter runs. */
  undefinedName(span: Span | { row: number }, name: string, prefix?: string): never {
    this.checkUnavailableName(span, name, prefix);
    const qualified = prefix ? `${prefix}.${name}` : name;
    return this.error(span, `${qualified} という名前は定義されていません。`);
  }

  protected checkUnavailableName(span: Span | { row: number }, name: string, prefix?: string): void {
    const description = Object.hasOwn(UNAVAILABLE_NAMES, name) ? UNAVAILABLE_NAMES[name] : undefined;
    if (this.library.hasVisibleSdkExport(name, prefix) || (description && prefix === undefined))
      this.unsupported(span, description ?? (prefix ? `${prefix}.${name}` : name));
  }

  get isTracing(): boolean {
    return this.atomicRows !== undefined && !this.isLibraryCode;
  }

  // Types

  private includeFunctionTypeAnnotations = true;

  protected resolveTypeWithoutAnnotations(syntax: TypeSyntax): DartType {
    return this.withoutFunctionTypeAnnotations(() => this.resolveType(syntax));
  }

  protected withoutFunctionTypeAnnotations<T>(run: () => T): T {
    const saved = this.includeFunctionTypeAnnotations;
    this.includeFunctionTypeAnnotations = false;
    try {
      return run();
    } finally {
      this.includeFunctionTypeAnnotations = saved;
    }
  }

  protected abstract checkFunctionTypeAnnotations(parameters: readonly TypeParameter[]): void;

  protected withTypeParams<T>(params: TypeParam[], run: () => T, staticOwner = false): T {
    this.typeScopes.push({
      names: new Map(params.filter((param) => param.name !== '_').map((param) => [param.name, param])),
      staticOwner,
      enclosingFunction: this.fn,
    });
    try {
      return run();
    } finally {
      this.typeScopes.pop();
    }
  }

  /** Creates the type parameters of a declaration and resolves their bounds, which may refer to each other. */
  protected declareTypeParams(syntax: TypeParameter[]): TypeParam[] {
    const params = this.declareTypeParamNames(syntax);
    this.resolveTypeParamBounds(params, syntax);
    return params;
  }

  protected declareTypeParamNames(syntax: TypeParameter[]): TypeParam[] {
    const params = syntax.map((parameter) => new TypeParam(parameter.name));
    const names = new Set<string>();
    for (const parameter of syntax) {
      if (parameter.name === '_') continue;
      if (names.has(parameter.name)) this.error(parameter, `型引数 ${parameter.name} が重複しています。`);
      names.add(parameter.name);
    }
    return params;
  }

  protected resolveTypeParamBounds(params: TypeParam[], syntax: TypeParameter[]): void {
    // A bound such as `T extends Shape<T>` is checked once every bound of the list is known, whatever declares it.
    const deferred: (() => void)[] | undefined = this.pendingBoundChecks ? undefined : [];
    if (deferred) this.pendingBoundChecks = deferred;
    try {
      this.withTypeParams(params, () => {
        for (const [index, parameter] of syntax.entries()) {
          if (parameter.bound) params[index].bound = this.resolveType(parameter.bound);
        }
      });
    } finally {
      if (deferred) this.pendingBoundChecks = undefined;
    }
    for (const check of deferred ?? []) check();
    const pending = this.pendingBoundChecks;
    this.checkBoundCycles(params, syntax, pending === undefined);
    if (pending && params.length > 0) pending.push(() => this.checkBoundCycles(params, syntax, true));
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Detect type-parameter cycles before and after resolving representations.
  private checkBoundCycles(params: TypeParam[], syntax: TypeParameter[], eraseRepresentations: boolean): void {
    const checked = new Set<TypeParam>();
    for (const [index, param] of params.entries()) {
      const chain = new Set<TypeParam>();
      let current: TypeParam | undefined = param;
      while (current && !checked.has(current)) {
        if (chain.has(current)) this.error(syntax[index], `型引数 ${param.name} の境界が循環しています。`);
        chain.add(current);
        let bound: DartType | undefined = current.bound;
        if (eraseRepresentations && bound?.kind === 'interface' && bound.cls.kind === 'extensionType') {
          bound = eraseExtensionTypes(bound);
        }
        current = bound?.kind === 'typeParam' ? bound.param : undefined;
      }
      for (const member of chain) checked.add(member);
    }
  }

  findTypeParam(name: string, span: Span): TypeParam | undefined {
    const scope = this.typeScopeFor(name);
    if (scope?.staticOwner) this.error(span, `static なメンバーは持ち主の型引数 ${name} を使えません。`);
    return scope?.names.get(name);
  }

  private typeScopeFor(name: string): (typeof this.typeScopes)[number] | undefined {
    return this.typeScopes.findLast(({ names }) => names.has(name));
  }

  resolveType(syntax: TypeSyntax, options: TypeResolutionOptions = {}): DartType {
    switch (syntax.kind) {
      case 'void': {
        return VOID;
      }
      case 'function': {
        return this.resolveFunctionType(syntax);
      }
      case 'record': {
        const names = new Set<string>();
        for (const field of syntax.named)
          this.checkRecordFieldName(field.name, field.type, names, syntax.positional.length);
        const type: DartType = {
          kind: 'record',
          positional: syntax.positional.map((field) => this.resolveType(field)),
          named: syntax.named
            .map((field) => ({ name: field.name, type: this.resolveType(field.type) }))
            .toSorted((a, b) => (a.name < b.name ? -1 : 1)),
          nullable: false,
        };
        this.registerRecordFieldNames(type.named);
        return syntax.nullable ? makeNullable(type) : type;
      }
      case 'named': {
        const type = this.resolveNamedType(syntax, options);
        return syntax.nullable ? makeNullable(type) : type;
      }
    }
  }

  protected checkRecordFieldName(name: string, span: Span, names: Set<string>, positionalCount: number): void {
    if (names.has(name)) this.error(span, `レコードのフィールド ${name} が重複しています。`);
    const position = recordPositionalIndex(name);
    if (
      name.startsWith('_') ||
      (position !== undefined && position < positionalCount) ||
      ['hashCode', 'runtimeType', 'toString', 'noSuchMethod'].includes(name)
    )
      this.error(span, `レコードのフィールドに ${name} という名前は付けられません。`);
    names.add(name);
  }

  protected registerRecordFieldNames(fields: readonly { name: string }[]): string | undefined {
    if (fields.length === 0) return undefined;
    const key = JSON.stringify(fields.map(({ name }) => name));
    const names = this.fn ? (this.fn.info.recordFieldNames ??= new Set()) : this.recordFieldNames;
    names.add(key);
    return key;
  }

  private resolveFunctionType(syntax: Extract<TypeSyntax, { kind: 'function' }>): DartType {
    if (this.includeFunctionTypeAnnotations) this.checkFunctionTypeAnnotations(syntax.typeParameters);
    const params = this.declareTypeParams(syntax.typeParameters);
    const type = this.withTypeParams(params, () =>
      functionType(
        syntax.parameters.positional.map((parameter) => this.resolveType(parameter.type)),
        syntax.returnType ? this.resolveType(syntax.returnType) : DYNAMIC,
        {
          requiredCount: syntax.parameters.requiredCount,
          named: syntax.parameters.named.map((named) => ({
            name: named.name,
            type: this.resolveType(named.type),
            isRequired: named.isRequired,
          })),
          typeParams: params,
        }
      )
    );
    return syntax.nullable ? makeNullable(type) : type;
  }

  // code-gauge-allow functionNcss 33 -- One case per form of the construct, which reads best together.
  private resolveNamedType(syntax: Extract<TypeSyntax, { kind: 'named' }>, options: TypeResolutionOptions): DartType {
    const { name, prefix } = syntax;
    this.checkTypeNameBinding(name, prefix, syntax);
    if (prefix === undefined) {
      const param = this.findTypeParam(name, syntax);
      if (param) {
        if (syntax.args.length > 0) this.error(syntax, `型引数 ${name} には、型引数を付けられません。`);
        return typeParamType(param);
      }
      const special = SPECIAL_TYPES.get(name);
      if (special) {
        this.typeArgumentsFor([], syntax, name);
        return special;
      }
    }
    if (prefix !== undefined && !this.library.hasPrefix(prefix)) {
      this.error(syntax, `${prefix}.${name} という型はありません。`);
    }
    const declaration = prefix === undefined ? this.library.lookup(name) : this.library.lookupPrefixed(prefix, name);
    if (declaration?.kind === 'class') return this.instantiateClass(declaration.cls, syntax, options);
    if (declaration?.kind === 'alias') return this.instantiateAlias(declaration.alias, syntax, options);
    if (declaration) return this.error(syntax, `${name} は型ではありません。`);
    this.checkUnavailableName(syntax, name, prefix);
    return this.error(syntax, `型 ${name} が見つかりません。`);
  }

  protected checkTypeNameBinding(name: string, prefix: string | undefined, span: Span): void {
    const head = prefix ?? name;
    const scope = this.typeScopeFor(head);
    const stopBefore = scope?.enclosingFunction ?? this.typeLookupBoundary;
    const binding = this.findLocal(head, span, stopBefore) ?? (!scope && this.hasMemberBinding(head));
    if (prefix !== undefined && (binding || scope)) this.error(span, `${head} は import の接頭辞ではありません。`);
    if (binding) this.error(span, `${head} は型ではありません。`);
  }

  private hasMemberBinding(name: string): boolean {
    const declaration = this.currentClass?.declaration ?? this.currentExtension?.declaration;
    if (!declaration) return false;
    let names = this.memberBindings.get(declaration);
    if (!names) {
      names = declaredMemberNames(declaration);
      this.memberBindings.set(declaration, names);
    }
    return names.has(name);
  }

  private instantiateAlias(
    alias: TypeAlias,
    syntax: Extract<TypeSyntax, { kind: 'named' }>,
    options: TypeResolutionOptions
  ): DartType {
    const type = this.resolveAlias(alias, syntax);
    if (syntax.args.length === 0 && alias.typeParams.length > 0 && options.inferOmitted)
      return options.inferOmitted(type, alias.typeParams);
    const args = this.typeArgumentsFor(alias.typeParams, syntax, syntax.name);
    return substitute(type, new Map(alias.typeParams.map((param, index) => [param, args[index]])));
  }

  protected resolveAlias(alias: TypeAlias, span: Span): DartType {
    if (alias.aliased) return alias.aliased;
    const declaration = this.aliasWork.get(alias);
    if (!declaration) this.error(span, `型の別名 ${alias.name} が、自分自身を使って定義されています。`);
    this.aliasWork.delete(alias);
    alias.aliased = this.inDeclarationScope(undefined, undefined, () =>
      this.withIsolatedTypes(() =>
        this.withoutFunctionTypeAnnotations(() => {
          alias.typeParams.push(...this.declareTypeParams(declaration.typeParameters));
          return this.withTypeParams(alias.typeParams, () => this.resolveType(declaration.aliased));
        })
      )
    );
    return alias.aliased;
  }

  protected resolveClassBounds(cls: ClassInfo): void {
    const declaration = this.pendingClassBounds.get(cls);
    if (!declaration) return;
    this.pendingClassBounds.delete(cls);
    this.inDeclarationScope(undefined, undefined, () =>
      this.withIsolatedTypes(() =>
        this.withoutFunctionTypeAnnotations(() =>
          this.resolveTypeParamBounds(cls.typeParams, declaration.typeParameters)
        )
      )
    );
  }

  protected inDeclarationScope<T>(cls: ClassInfo | undefined, ext: ExtensionInfo | undefined, run: () => T): T {
    const savedClass = this.currentClass;
    const savedExtension = this.currentExtension;
    this.currentClass = cls;
    this.currentExtension = ext;
    try {
      return run();
    } finally {
      this.currentClass = savedClass;
      this.currentExtension = savedExtension;
    }
  }

  protected withIsolatedTypes<T>(run: () => T): T {
    const outer = this.typeScopes;
    const boundary = this.typeLookupBoundary;
    this.typeScopes = [];
    this.typeLookupBoundary = this.fn;
    try {
      return run();
    } finally {
      this.typeScopes = outer;
      this.typeLookupBoundary = boundary;
    }
  }

  private instantiateClass(
    cls: ClassInfo,
    syntax: Extract<TypeSyntax, { kind: 'named' }>,
    options: TypeResolutionOptions
  ): DartType {
    if (syntax.args.length === 0 && options.allowRaw && cls.typeParams.length > 0) return interfaceType(cls, []);
    this.resolveClassBounds(cls);
    if (syntax.args.length === 0 && cls.typeParams.length > 0 && options.inferOmitted)
      return options.inferOmitted(cls.thisType, cls.typeParams);
    const args = this.typeArgumentsFor(cls.typeParams, syntax, cls.name);
    return cls === coreTypes.nullClass ? NULL : interfaceType(cls, args);
  }

  /** The type arguments of a generic type, or the instantiation to bounds when they are omitted. */
  protected typeArgumentsFor(
    params: TypeParam[],
    syntax: Extract<TypeSyntax, { kind: 'named' }>,
    name: string
  ): DartType[] {
    if (syntax.args.length === 0) return instantiateToBounds(params);
    if (syntax.args.length !== params.length) {
      this.error(syntax, `型 ${name} の型引数は ${params.length} 個ですが、${syntax.args.length} 個書かれています。`);
    }
    const args = syntax.args.map((arg) => this.resolveType(arg));
    this.checkBounds(params, args, syntax);
    return args;
  }

  protected explicitTypeArguments(params: readonly TypeParam[], typeArguments: TypeSyntax[], span: Span): DartType[] {
    if (typeArguments.length !== params.length)
      this.error(span, `型引数は ${params.length} 個ですが、${typeArguments.length} 個書かれています。`);
    const typeArgs = typeArguments.map((argument) => this.resolveType(argument));
    this.checkBounds(params, typeArgs, span);
    return typeArgs;
  }

  protected checkBounds(params: readonly TypeParam[], args: readonly DartType[], span: Span): void {
    // A bound may refer to a subclass whose supertypes are declared later.
    if (this.pendingBoundChecks) {
      this.pendingBoundChecks.push(() => this.checkBounds(params, args, span));
      return;
    }
    const map = new Map(params.map((param, index) => [param, args[index]]));
    for (const [index, param] of params.entries()) {
      if (!param.bound) continue;
      const bound = substitute(param.bound, map);
      if (!isSubtype(args[index], bound)) {
        this.error(
          span,
          `型引数 ${typeName(args[index])} は、${param.name} の制約 ${typeName(bound)} を満たしません。`
        );
      }
    }
  }

  protected checkRepresentationInterfaces(cls: ClassInfo, representation: DartType, interfaces: TypeSyntax[]): void {
    for (const [index, type] of cls.interfaces.entries()) {
      if (type.cls === cls) this.error(interfaces[index], `拡張型 ${cls.name} は自分自身を実装できません。`);
      const target = type.cls.representationType;
      if (isSubtype(representation, type)) continue;
      const args = new Map(type.cls.typeParams.map((param, position) => [param, type.args[position] ?? DYNAMIC]));
      if (target && isSubtype(representation, substitute(target, args))) continue;
      this.error(interfaces[index], `${typeToString(type)} は、拡張型 ${cls.name} が表す型と互換性がありません。`);
    }
  }

  // Members

  /** Finds a member through a static type, including Object's members on nullable types and extension members. */
  lookupMember(receiverType: DartType, name: string, setter: boolean, span?: Span): ResolvedMember | undefined {
    const base = resolveBound(receiverType);
    if (isNullable(base)) {
      const objectMember = this.interfaceMember(objectType(), name, setter);
      if (objectMember) return objectMember;
      const extension = this.lookupExtension(receiverType, name, setter, span);
      if (extension) return extension;
      const nonNull = base.kind === 'interface' ? { ...base, nullable: false } : base;
      return this.lookupDirect(nonNull, name, setter);
    }
    const direct = this.lookupDirect(base, name, setter);
    if (direct) return direct;
    return this.lookupExtension(receiverType, name, setter, span);
  }

  private lookupDirect(base: DartType, name: string, setter: boolean): ResolvedMember | undefined {
    if (base.kind === 'interface') return this.interfaceMember(base, name, setter);
    if (base.kind === 'function' && name === 'call' && !setter) {
      return { member: callMember(base), type: { ...base, nullable: false } };
    }
    if (base.kind === 'record' && !setter) {
      const index = recordPositionalIndex(name);
      if (index !== undefined && index < base.positional.length) {
        return { member: recordFieldMember(name), type: base.positional[index] };
      }
      const named = base.named.find((field) => field.name === name);
      if (named) return { member: recordFieldMember(name), type: named.type };
    }
    const objectClass =
      base.kind === 'function' ? coreTypes.function : base.kind === 'record' ? coreTypes.record : coreTypes.object;
    return this.interfaceMember(interfaceType(objectClass), name, setter);
  }

  interfaceMember(
    type: InterfaceType,
    name: string,
    setter: boolean,
    library = this.library.name
  ): ResolvedMember | undefined {
    if (type.cls === coreTypes.function && name === 'call' && !setter) {
      return functionCallProperty({ ...type, nullable: false });
    }
    let member = type.cls.interfaceMember(scopedMemberName(name, library), setter);
    if (!member) {
      if (type.cls !== coreTypes.object) return this.interfaceMember(objectType(), name, setter, library);
      return undefined;
    }
    if (member.kind === 'method') member = type.cls.covarianceFor(member)?.obligation ?? member;
    // An extension type's members run on its representation, which has no class to dispatch on.
    const extension =
      member.owner.kind === 'extensionType'
        ? { ext: undefined, typeArgs: asInstanceOf(type, member.owner)?.args ?? [] }
        : undefined;
    return { member, type: memberTypeIn(type, member), extension };
  }

  protected runtimeMemberName(name: string): string {
    return scopedMemberName(name, this.library.name);
  }

  protected lookupSuperMember(type: DartType, name: string, setter = false): ResolvedMember | undefined {
    if (type.kind === 'interface') {
      const { cls } = type;
      const key = this.runtimeMemberName(name);
      const implementation = setter ? cls.setterImplementation(key) : cls.implementation(key);
      const member =
        implementation?.kind === 'method'
          ? (cls.covarianceFor(implementation)?.obligation ?? implementation)
          : (implementation ?? cls.forwardingDeclaration(key, setter));
      if (member) return { member, type: memberTypeIn(type, member) };
    }
    return this.lookupMember(type, name, setter);
  }

  /** Finds a member for a receiver, honoring an explicit extension application (`E(x).m`). */
  memberFor(
    receiver: Compiled,
    lookupType: DartType,
    name: string,
    span: Span | undefined,
    setter = false
  ): ResolvedMember | undefined {
    if (receiver.isSuper) return this.lookupSuperMember(lookupType, name, setter);
    const override = receiver.extensionOverride;
    if (!override) return this.lookupMember(lookupType, name, setter, span);
    return extensionMember(override.ext, override.typeArgs, name, setter);
  }

  protected usesLexicalTypeVariables(type: DartType): boolean {
    const params = new Set(
      this.typeScopes.flatMap(({ names, staticOwner }) => (staticOwner ? [] : [...names.values()]))
    );
    return mentionsTypeParams(type, params);
  }

  protected dynamicDispatchType(receiver: Compiled): DartType | undefined {
    if (receiver.extensionOverride) return;
    if (receiver.type.kind === 'dynamic') return DYNAMIC;
    return isNeverType(receiver.type) ? NEVER : undefined;
  }

  /** Whether a member may be used on a receiver that may be null: Object's members and extensions on nullable types. */
  acceptsNull(resolved: ResolvedMember): boolean {
    if (resolved.member.owner === coreTypes.object) return true;
    const onType = resolved.extension?.onType;
    return onType !== undefined && isPotentiallyNullable(onType);
  }

  /** The extension member that applies to a receiver of a type, choosing the most specific extension. */
  private lookupExtension(
    receiverType: DartType,
    name: string,
    setter: boolean,
    span?: Span
  ): ResolvedMember | undefined {
    const candidates: { ext: ExtensionInfo; member: Member; typeArgs: DartType[]; onType: DartType }[] = [];
    for (const ext of new Set(this.library.extensionsInScope())) {
      const member = (setter ? ext.setters : ext.members).get(name);
      if (!member) continue;
      const typeArgs = this.matchExtension(ext, receiverType);
      if (!typeArgs) continue;
      const map = new Map(ext.typeParams.map((param, index) => [param, typeArgs[index]]));
      candidates.push({ ext, member, typeArgs, onType: substitute(ext.onType, map) });
    }
    if (candidates.length === 0) return undefined;
    const chosen = candidates.find((candidate) =>
      candidates.every((other) => candidate === other || extensionMoreSpecific(candidate, other))
    );
    if (!chosen) {
      if (span) this.error(span, `${typeName(receiverType)} 型に使える拡張に ${name} が複数あり、1 つに決まりません。`);
      return undefined;
    }
    const map = new Map(chosen.ext.typeParams.map((param, index) => [param, chosen.typeArgs[index]]));
    return {
      member: chosen.member,
      type: substitute(chosen.member.type, map),
      extension: { ext: chosen.ext, typeArgs: chosen.typeArgs, onType: chosen.onType },
    };
  }

  /** The type arguments that make an extension's `on` type a supertype of the receiver's type, if any. */
  matchExtension(ext: ExtensionInfo, receiverType: DartType): DartType[] | undefined {
    if (receiverType.kind === 'dynamic') return undefined;
    if (ext.typeParams.length === 0) return isSubtype(receiverType, ext.onType) ? [] : undefined;
    const args = inferExtensionReceiver(receiverType, ext.onType, ext.typeParams);
    const map = new Map(ext.typeParams.map((param, index) => [param, args[index]]));
    if (ext.typeParams.some((param, index) => !isSubtype(args[index], substitute(boundOf(param), map)))) return;
    return isSubtype(receiverType, substitute(ext.onType, map)) ? args : undefined;
  }

  // Locals

  protected reserveLocals(names: ReadonlySet<string>): void {
    const scope = this.fn.scopes.at(-1);
    if (scope && names.size > 0) scope.pending = names;
  }

  protected declareLocal(
    span: Span,
    name: string,
    type: DartType,
    options: { isFinal: boolean; isLate: boolean; isConst: boolean; isParameter: boolean; hasInitializer: boolean }
  ): LocalVar {
    const scope = this.fn.scopes.at(-1) as LocalScope;
    if (name !== '_' && scope.names.has(name))
      this.error(span, `変数 ${name} は、同じスコープで既に宣言されています。`);
    const variable = new LocalVar(span, name, type, this.fn.allocateSlot(), this.fn, options);
    variable.hasAssignment = this.fn.assignments.get(span)?.has(name) ?? false;
    variable.isWriteCaptured = this.fn.capturedAssignments.get(span)?.has(name) ?? false;
    if (name !== '_') scope.names.set(name, variable);
    scope.slots.push(variable.slot);
    this.fn.info.locals[variable.slot] = { name: name === '_' || name.startsWith('\0') ? '\0' : name, type };
    return variable;
  }

  /** Finds a local in the function being compiled or an enclosing one. */
  findLocal(name: string, span?: Span, stopBefore?: FunctionContext): LocalVar | undefined {
    for (
      let context: FunctionContext | undefined = this.fn;
      context && context !== stopBefore;
      context = context.parent
    ) {
      for (let index = context.scopes.length - 1; index >= 0; index--) {
        const scope = context.scopes[index];
        const found = scope.names.get(name);
        if (found) return found;
        if (scope.pending?.has(name)) {
          if (span) this.error(span, `変数 ${name} は、宣言より前には使えません。`);
          return undefined;
        }
      }
    }
    return undefined;
  }

  /**
   * Evaluates to the cell of a local: from the frame's slots for the function's own locals, or from its captured cells
   * for an enclosing function's, capturing it through every function in between.
   */
  protected cellAccess(variable: LocalVar): (frame: Frame) => Cell {
    if (variable.owner === this.fn) {
      const { slot } = variable;
      return (frame) => frame.locals[slot] as Cell;
    }
    variable.isCaptured = true;
    const index = captureIndex(this.fn, variable);
    return (frame) => frame.captured[index];
  }

  protected withScope<T>(run: () => T, clear = true): { result: T; slots: number[] } {
    const scope = new LocalScope();
    this.fn.scopes.push(scope);
    try {
      return { result: run(), slots: clear ? scope.slots : [] };
    } finally {
      this.fn.scopes.pop();
    }
  }

  /** The type flow analysis gives a local where it is read. */
  promotedType(variable: LocalVar): DartType {
    return this.flow.promotions.get(variable)?.at(-1) ?? variable.type;
  }

  isPromotable(variable: LocalVar): boolean {
    if (this.flow.writeCaptured.has(variable)) return false;
    if (variable.owner !== this.fn && variable.hasAssignment) return false;
    return true;
  }

  // Assignability

  /**
   * Checks that a value can be assigned where `target` is expected and converts it as Dart does: a `dynamic` value
   * is cast at runtime.
   */
  coerce(compiled: Compiled, target: DartType, span: Span, describe: (from: string, to: string) => string): Compiled {
    if (compiled.type.kind === 'void' && target.kind !== 'void') this.error(span, 'void の値は、ここでは使えません。');
    if (isSubtype(compiled.type, target)) return compiled;
    const instantiated = this.instantiateGeneric(compiled, target);
    if (instantiated) return instantiated;
    if (compiled.type.kind === 'dynamic') {
      if (isTop(target)) return compiled;
      return { ...compiled, type: target, run: this.runtimeCast(compiled.run, target, false), isConst: false };
    }
    const tearOff = this.implicitCallTearOff(compiled, target, span);
    if (tearOff) return tearOff;
    return this.error(span, describe(typeName(compiled.type), typeName(target)));
  }

  private implicitCallTearOff(compiled: Compiled, target: DartType, span: Span): Compiled | undefined {
    if (!isFunctionLike(target)) return undefined;
    const source = resolveBound(compiled.type);
    if (source.kind !== 'interface' || source.nullable) return undefined;
    const call = this.lookupDirect(source, 'call', false);
    if (call?.member.kind !== 'method') return undefined;
    const tearOff = this.readMember(compiled, call, 'call', span, false);
    return isSubtype(call.type, target) ? tearOff : this.instantiateGeneric(tearOff, target);
  }

  protected abstract readMember(
    receiver: Compiled,
    resolved: ResolvedMember,
    name: string,
    span: Span,
    nullAware: boolean
  ): Compiled;

  /**
   * A generic function where a non-generic function type is expected, instantiated with the type arguments that make
   * it fit, as `[1, 2].reduce(max)` instantiates `max<int>`.
   */
  protected instantiateGeneric(compiled: Compiled, target: DartType, forInference = false): Compiled | undefined {
    const source = resolveBound(compiled.type);
    const expected = resolveBound(target);
    if (source.kind !== 'function' || source.typeParams.length === 0) return undefined;
    if (expected.kind !== 'function' || expected.typeParams.length > 0) return undefined;
    const typeArgs = inferTearOffTypes(source, expected, instantiateToBounds(source.typeParams));
    if (!typeArgs) return undefined;
    const type = instantiateFunction(source, typeArgs);
    if (!forInference && !isSubtype(type, target)) return undefined;
    return this.instantiateFunctionValue(compiled, type, typeArgs);
  }

  protected instantiateFunctionValue(compiled: Compiled, type: FunctionType, typeArgs: readonly DartType[]): Compiled {
    const { run } = compiled;
    const resolveArgs = this.runtimeTypes(typeArgs);
    return {
      ...compiled,
      type,
      isConst: compiled.isConst && !typeArgs.some((argument) => mentionsTypeParams(argument)),
      variable: undefined,
      run: (frame) => {
        const original = run(frame);
        return original instanceof DartClosure
          ? frame.runtime.instantiateTearOff(original, resolveArgs(frame))
          : original;
      },
    };
  }

  /** Casts a value at runtime, throwing the VM's `TypeError` when it is not of the type. */
  protected runtimeCast(run: Eval, target: DartType, explicit: boolean): Eval {
    const resolve = this.runtimeType(target);
    return (frame) => {
      const value = run(frame);
      const type = resolve(frame);
      if (!valueIs(frame.runtime, value, type)) {
        const actual = vmTypeString(frame.runtime.runtimeTypeOf(value));
        frame.runtime.throwTypeError(
          `type '${actual}' is not a subtype of type '${vmTypeString(type)}'${explicit ? ' in type cast' : ''}`
        );
      }
      return value;
    };
  }

  /** A type as the running program sees it: type parameters bound by the frame, and extension types erased. */
  runtimeType(type: DartType): (frame: Frame) => DartType {
    const erased = eraseExtensionTypes(type);
    if (!mentionsTypeParams(erased)) return () => erased;
    return (frame) => eraseExtensionTypes(substitute(erased, frame.typeEnv));
  }

  /** Evaluates a list of types at runtime, replacing type parameters in scope. */
  protected runtimeTypes(types: readonly DartType[]): (frame: Frame) => DartType[] {
    if (types.length === 0) return () => [];
    const erased = types.map(eraseExtensionTypes);
    if (!erased.some((type) => mentionsTypeParams(type))) return () => erased;
    const resolvers = erased.map((type) => this.runtimeType(type));
    return (frame) => resolvers.map((resolve) => resolve(frame));
  }

  protected newFunctionInfo(name: string, row: number | undefined, showsThis: boolean): FunctionInfo {
    return {
      name,
      isAtomic: row !== undefined && this.atomicRows?.has(row) === true,
      isLibrary: this.isLibraryCode,
      locals: [],
      captures: [],
      showsThis,
    };
  }
}

/** The index of an outer local among the captured cells of `fn`, capturing it through each enclosing function. */
export function captureIndex(fn: FunctionContext, variable: LocalVar): number {
  const existing = fn.captures.indexOf(variable);
  if (existing !== -1) return existing;
  if (fn.parent && variable.owner !== fn.parent) captureIndex(fn.parent, variable);
  fn.captures.push(variable);
  fn.info.captures.push({ name: variable.name, type: variable.type });
  return fn.captures.length - 1;
}

function extensionMoreSpecific(
  candidate: { ext: ExtensionInfo; onType: DartType },
  other: { ext: ExtensionInfo; onType: DartType }
): boolean {
  const platform = candidate.ext.library.startsWith('dart:');
  const otherPlatform = other.ext.library.startsWith('dart:');
  if (platform !== otherPlatform) return otherPlatform;
  if (!isSubtype(candidate.onType, other.onType)) return false;
  if (!isSubtype(other.onType, candidate.onType)) return true;
  const left = extensionTypeAtBounds(candidate.ext);
  const right = extensionTypeAtBounds(other.ext);
  return isSubtype(left, right) && !isSubtype(right, left);
}

function extensionTypeAtBounds(extension: ExtensionInfo): DartType {
  const args = instantiateToBounds(extension.typeParams);
  return substitute(extension.onType, new Map(extension.typeParams.map((param, index) => [param, args[index]])));
}

/** Whether a value is of a type that holds no type parameters, checked against the value's runtime type. */
export function valueIs(runtime: Runtime, value: Value, type: DartType): boolean {
  const erased = eraseExtensionTypes(type);
  if (isTop(erased)) return true;
  if (value === undefined) return isNullable(erased);
  return isSubtype(runtime.runtimeTypeOf(value), erased);
}

const callMembers = new WeakMap<FunctionType, Member>();

/** The `call` method every function type has. */
function callMember(type: FunctionType): Member {
  let member = callMembers.get(type);
  if (!member) {
    member = {
      kind: 'method',
      name: 'call',
      owner: coreTypes.function,
      isStatic: false,
      isAbstract: false,
      row: undefined,
      type,
      impl: (runtime, receiver, args, typeArgs, callRow) => runtime.callValue(receiver, args, typeArgs, callRow),
      isOperator: false,
    };
    callMembers.set(type, member);
  }
  return member;
}

function functionCallProperty(type: InterfaceType): ResolvedMember {
  return {
    member: {
      kind: 'getter',
      name: 'call',
      owner: type.cls,
      isStatic: false,
      isAbstract: false,
      row: undefined,
      type,
      impl: undefined,
    },
    type,
  };
}

function recordFieldMember(name: string): Member {
  return {
    kind: 'getter',
    name,
    owner: coreTypes.record,
    isStatic: false,
    isAbstract: false,
    row: undefined,
    type: DYNAMIC,
    impl: (_runtime, receiver) => (receiver as DartRecord).field(name)?.[1],
  };
}

export type { TypeEnv };

/** A member of one extension applied with the given type arguments. */
export function extensionMember(
  ext: ExtensionInfo,
  typeArgs: DartType[],
  name: string,
  setter: boolean
): ResolvedMember | undefined {
  const member = (setter ? ext.setters : ext.members).get(name);
  if (!member) return undefined;
  const map = new Map(ext.typeParams.map((param, index) => [param, typeArgs[index]]));
  return {
    member,
    type: substitute(member.type, map),
    extension: { ext, typeArgs, onType: substitute(ext.onType, map) },
  };
}
