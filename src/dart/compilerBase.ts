import { CompileError } from '../interpreter/diagnostics';
import type { Span, TypeParameter, TypeSyntax } from './ast';
import type { ClassInfo, Member } from './classes';
import type { ExtensionInfo, GlobalVariable, LibraryEnv } from './environment';
import type { Frame, FunctionInfo, Runtime, TypeEnv } from './runtime';
import { Flow, type FunctionContext, LocalVar } from './scope';
import {
  asInstanceOf,
  boundOf,
  coreTypes,
  type DartType,
  DYNAMIC,
  type FunctionType,
  functionType,
  instantiateFunction,
  type InterfaceType,
  interfaceType,
  isNullable,
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
  VOID,
} from './types';
import { type Cell, DartClosure as DartClosureValue, type DartRecord, type Value } from './values';

export type Eval = (frame: Frame) => Value;

/** A compiled expression: its static type and how to evaluate it. */
export interface Compiled {
  type: DartType;
  run: Eval;
  /** Whether the expression is a constant expression. */
  isConst: boolean;
  /** The value of a constant of a primitive type, known while compiling. */
  constValue?: { value: Value };
  /** The variable a bare identifier names, for promotion and definite assignment. */
  variable?: LocalVar;
  /** Whether evaluating the expression can complete normally (false for `throw` and calls returning `Never`). */
  completes?: boolean;
  /** Whether the expression creates an object, whose constructor's steps show what it did. */
  creates?: boolean;
}

/** A member found through a static type, with its type in terms of the receiver's type arguments. */
export interface ResolvedMember {
  member: Member;
  /** The type of a field or getter, the parameter of a setter, or the signature of a method. */
  type: DartType;
  extension?: { ext: ExtensionInfo; typeArgs: DartType[] };
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
  File: 'File（ファイルの読み書き）',
  Directory: 'Directory（ファイルの読み書き）',
  FileSystemEntity: 'FileSystemEntity（ファイルの読み書き）',
  Platform: 'Platform（実行環境の情報）',
  Process: 'Process（外部のプロセス）',
  HttpClient: 'HttpClient（ネットワーク）',
  HttpServer: 'HttpServer（ネットワーク）',
  Socket: 'Socket（ネットワーク）',
  Uri: 'Uri',
  Expando: 'Expando',
  WeakReference: 'WeakReference',
  Finalizer: 'Finalizer',
  Uint8List: 'Uint8List（dart:typed_data）',
  Int32List: 'Int32List（dart:typed_data）',
  Float64List: 'Float64List（dart:typed_data）',
  ByteData: 'ByteData（dart:typed_data）',
};

export function typeName(type: DartType): string {
  return `'${typeToString(type)}'`;
}

/** Holds what every part of the compiler shares: the library being compiled, the function, and flow analysis. */
export abstract class CompilerBase {
  /** The function being compiled. */
  fn!: FunctionContext;
  flow: Flow = Flow.start();
  /** The type parameters in scope, innermost last. */
  protected typeScopes: Map<string, TypeParam>[] = [];
  /** The class whose body is being compiled. */
  protected currentClass: ClassInfo | undefined;
  protected currentExtension: ExtensionInfo | undefined;
  /** Whether the function being compiled records steps when the program is traced. */
  protected recordsSteps = false;

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

  /** Rejects a name the program does not define: as unavailable when the SDK has it outside what the interpreter runs. */
  undefinedName(span: Span | { row: number }, name: string): never {
    const unavailable = UNAVAILABLE_NAMES[name];
    if (unavailable) return this.unsupported(span, unavailable);
    return this.error(span, `${name} という名前は定義されていません。`);
  }

  get isTracing(): boolean {
    return this.atomicRows !== undefined && !this.isLibraryCode;
  }

  // Types

  protected withTypeParams<T>(params: TypeParam[], run: () => T): T {
    this.typeScopes.push(new Map(params.map((param) => [param.name, param])));
    try {
      return run();
    } finally {
      this.typeScopes.pop();
    }
  }

  /** Creates the type parameters of a declaration and resolves their bounds, which may refer to each other. */
  protected declareTypeParams(syntax: TypeParameter[]): TypeParam[] {
    const params = syntax.map((parameter) => new TypeParam(parameter.name));
    const names = new Set<string>();
    for (const parameter of syntax) {
      if (names.has(parameter.name)) this.error(parameter, `型引数 ${parameter.name} が重複しています。`);
      names.add(parameter.name);
    }
    this.withTypeParams(params, () => {
      for (const [index, parameter] of syntax.entries()) {
        if (parameter.bound) params[index].bound = this.resolveType(parameter.bound);
      }
    });
    return params;
  }

  findTypeParam(name: string): TypeParam | undefined {
    for (let index = this.typeScopes.length - 1; index >= 0; index--) {
      const found = this.typeScopes[index].get(name);
      if (found) return found;
    }
    return undefined;
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- One case per kind of type syntax.
  resolveType(syntax: TypeSyntax, options: { allowRaw?: boolean } = {}): DartType {
    switch (syntax.kind) {
      case 'void': {
        return VOID;
      }
      case 'function': {
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
      case 'record': {
        const names = new Set<string>();
        for (const field of syntax.named) {
          if (names.has(field.name)) this.error(syntax, `レコードのフィールド ${field.name} が重複しています。`);
          names.add(field.name);
        }
        const type: DartType = {
          kind: 'record',
          positional: syntax.positional.map((field) => this.resolveType(field)),
          named: syntax.named
            .map((field) => ({ name: field.name, type: this.resolveType(field.type) }))
            .toSorted((a, b) => (a.name < b.name ? -1 : 1)),
          nullable: false,
        };
        return syntax.nullable ? makeNullable(type) : type;
      }
      case 'named': {
        const type = this.resolveNamedType(syntax, options);
        return syntax.nullable ? makeNullable(type) : type;
      }
    }
  }

  private resolveNamedType(syntax: Extract<TypeSyntax, { kind: 'named' }>, options: { allowRaw?: boolean }): DartType {
    const { name, prefix } = syntax;
    if (prefix === undefined) {
      const param = this.findTypeParam(name);
      if (param) {
        if (syntax.args.length > 0) this.error(syntax, `型引数 ${name} には、型引数を付けられません。`);
        return typeParamType(param);
      }
      switch (name) {
        case 'dynamic': {
          return DYNAMIC;
        }
        case 'Never': {
          return NEVER;
        }
        case 'Null': {
          return NULL;
        }
        default: {
          break;
        }
      }
    }
    if (prefix !== undefined && !this.library.hasPrefix(prefix)) {
      this.error(syntax, `${prefix}.${name} という型はありません。`);
    }
    const declaration = prefix === undefined ? this.library.lookup(name) : this.library.lookupPrefixed(prefix, name);
    if (declaration?.kind === 'class') return this.instantiateClass(declaration.cls, syntax, options);
    if (declaration?.kind === 'alias') {
      const { alias } = declaration;
      if (!alias.aliased) this.error(syntax, `型の別名 ${name} が、自分自身を使って定義されています。`);
      const args = this.typeArgumentsFor(alias.typeParams, syntax, name);
      return substitute(alias.aliased, new Map(alias.typeParams.map((param, index) => [param, args[index]])));
    }
    if (declaration) return this.error(syntax, `${name} は型ではありません。`);
    if (UNAVAILABLE_NAMES[name]) return this.unsupported(syntax, UNAVAILABLE_NAMES[name]);
    return this.error(syntax, `型 ${name} が見つかりません。`);
  }

  private instantiateClass(
    cls: ClassInfo,
    syntax: Extract<TypeSyntax, { kind: 'named' }>,
    options: { allowRaw?: boolean }
  ): DartType {
    if (cls === coreTypes.nullClass) return NULL;
    if (syntax.args.length === 0 && options.allowRaw && cls.typeParams.length > 0) return interfaceType(cls, []);
    return interfaceType(cls, this.typeArgumentsFor(cls.typeParams, syntax, cls.name));
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

  protected checkBounds(params: readonly TypeParam[], args: readonly DartType[], span: Span): void {
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

  // Members

  /** Finds a member through a static type, including Object's members on nullable types and extension members. */
  lookupMember(receiverType: DartType, name: string, setter: boolean): ResolvedMember | undefined {
    const base = resolveBound(receiverType);
    const nonNull = base.kind === 'interface' && base.nullable ? { ...base, nullable: false } : base;
    const direct = this.lookupDirect(nonNull, name, setter);
    if (direct) return direct;
    return this.lookupExtension(receiverType, name, setter);
  }

  private lookupDirect(base: DartType, name: string, setter: boolean): ResolvedMember | undefined {
    if (base.kind === 'interface') return this.interfaceMember(base, name, setter);
    if (base.kind === 'function' && name === 'call' && !setter) {
      return { member: callMember(base), type: { ...base, nullable: false } };
    }
    if (base.kind === 'record' && !setter) {
      const index = /^\$([1-9]\d*)$/.exec(name);
      if (index && Number(index[1]) <= base.positional.length) {
        return { member: recordFieldMember(name), type: base.positional[Number(index[1]) - 1] };
      }
      const named = base.named.find((field) => field.name === name);
      if (named) return { member: recordFieldMember(name), type: named.type };
    }
    const objectClass =
      base.kind === 'function' ? coreTypes.function : base.kind === 'record' ? coreTypes.record : coreTypes.object;
    return this.interfaceMember(interfaceType(objectClass), name, setter);
  }

  interfaceMember(type: InterfaceType, name: string, setter: boolean): ResolvedMember | undefined {
    const member = type.cls.interfaceMember(name, setter);
    if (!member) {
      if (type.cls !== coreTypes.object) return this.interfaceMember(objectType(), name, setter);
      return undefined;
    }
    const owner = asInstanceOf(type, member.owner);
    const map = new Map(member.owner.typeParams.map((param, index) => [param, owner?.args[index] ?? DYNAMIC]));
    return { member, type: substitute(member.type, map) };
  }

  /** The extension member that applies to a receiver of a type, choosing the most specific extension. */
  private lookupExtension(receiverType: DartType, name: string, setter: boolean): ResolvedMember | undefined {
    const candidates: { ext: ExtensionInfo; member: Member; typeArgs: DartType[]; onType: DartType }[] = [];
    for (const ext of this.library.extensionsInScope()) {
      const member = (setter ? ext.setters : ext.members).get(name);
      if (!member) continue;
      const typeArgs = this.matchExtension(ext, receiverType);
      if (!typeArgs) continue;
      const map = new Map(ext.typeParams.map((param, index) => [param, typeArgs[index]]));
      candidates.push({ ext, member, typeArgs, onType: substitute(ext.onType, map) });
    }
    if (candidates.length === 0) return undefined;
    const best = candidates.find((candidate) => candidates.every((other) => isSubtype(candidate.onType, other.onType)));
    const chosen = best ?? candidates[0];
    const map = new Map(chosen.ext.typeParams.map((param, index) => [param, chosen.typeArgs[index]]));
    return {
      member: chosen.member,
      type: substitute(chosen.member.type, map),
      extension: { ext: chosen.ext, typeArgs: chosen.typeArgs },
    };
  }

  /** The type arguments that make an extension's `on` type a supertype of the receiver's type, if any. */
  matchExtension(ext: ExtensionInfo, receiverType: DartType): DartType[] | undefined {
    if (receiverType.kind === 'dynamic') return undefined;
    if (ext.typeParams.length === 0) return isSubtype(receiverType, ext.onType) ? [] : undefined;
    const solution = new Map<TypeParam, DartType>();
    inferFromSubtype(receiverType, ext.onType, new Set(ext.typeParams), solution);
    const args = ext.typeParams.map((param) => solution.get(param) ?? boundOf(param));
    const map = new Map(ext.typeParams.map((param, index) => [param, args[index]]));
    return isSubtype(receiverType, substitute(ext.onType, map)) ? args : undefined;
  }

  // Locals

  protected declareLocal(
    span: Span,
    name: string,
    type: DartType,
    options: { isFinal: boolean; isLate: boolean; isConst: boolean; isParameter: boolean; hasInitializer: boolean }
  ): LocalVar {
    const scope = this.fn.scopes.at(-1) as Map<string, LocalVar>;
    if (name !== '_' && scope.has(name)) this.error(span, `変数 ${name} は、同じスコープで既に宣言されています。`);
    const variable = new LocalVar(name, type, this.fn.allocateSlot(), this.fn, options);
    if (name !== '_') scope.set(name, variable);
    this.fn.info.locals[variable.slot] = { name, type };
    if (name === '_' || name.startsWith('\0')) this.fn.info.locals[variable.slot] = { name: '\0', type };
    return variable;
  }

  /** Finds a local in the function being compiled or an enclosing one. */
  findLocal(name: string): LocalVar | undefined {
    for (let context: FunctionContext | undefined = this.fn; context; context = context.parent) {
      for (let index = context.scopes.length - 1; index >= 0; index--) {
        const found = context.scopes[index].get(name);
        if (found) return found;
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
    this.fn.scopes.push(new Map());
    try {
      const result = run();
      const scope = this.fn.scopes.at(-1) as Map<string, LocalVar>;
      const slots = clear ? [...scope.values()].map((variable) => variable.slot) : [];
      return { result, slots };
    } finally {
      this.fn.scopes.pop();
    }
  }

  /** The type flow analysis gives a local where it is read. */
  promotedType(variable: LocalVar): DartType {
    return this.flow.promotions.get(variable) ?? variable.type;
  }

  /** Whether a local can be promoted: not write-captured and not a late variable read in a closure. */
  isPromotable(variable: LocalVar): boolean {
    if (variable.isWriteCaptured || variable.owner.closureAssignedNames.has(variable.name)) return false;
    if (variable.owner !== this.fn && variable.owner.assignedNames.has(variable.name)) return false;
    return true;
  }

  // Assignability

  /**
   * Checks that a value can be assigned where `target` is expected and converts it as Dart does: a `dynamic` value
   * is cast at runtime.
   */
  coerce(compiled: Compiled, target: DartType, span: Span, describe: (from: string, to: string) => string): Compiled {
    if (isSubtype(compiled.type, target)) return compiled;
    const instantiated = this.instantiateGeneric(compiled, target);
    if (instantiated) return instantiated;
    if (compiled.type.kind === 'dynamic') {
      if (isTop(target)) return compiled;
      return { ...compiled, type: target, run: this.runtimeCast(compiled.run, target, false), isConst: false };
    }
    if (
      compiled.type.kind === 'interface' &&
      compiled.type.cls.interfaceMember('call') &&
      resolveBound(target).kind === 'function'
    ) {
      // An object with a `call` method is torn off where a function is expected.
      const call = this.lookupMember(compiled.type, 'call', false);
      if (call && call.member.kind === 'method' && isSubtype(call.type, target)) {
        const { run } = compiled;
        return {
          ...compiled,
          type: call.type,
          run: (frame) => frame.runtime.getProperty(run(frame), 'call', undefined),
          isConst: false,
        };
      }
    }
    return this.error(span, describe(typeName(compiled.type), typeName(target)));
  }

  /**
   * A generic function where a non-generic function type is expected, instantiated with the type arguments that make
   * it fit, as `[1, 2].reduce(max)` instantiates `max<int>`.
   */
  private instantiateGeneric(compiled: Compiled, target: DartType): Compiled | undefined {
    const source = resolveBound(compiled.type);
    const expected = resolveBound(target);
    if (source.kind !== 'function' || source.typeParams.length === 0) return undefined;
    if (expected.kind !== 'function' || expected.typeParams.length > 0) return undefined;
    const params = new Set(source.typeParams);
    const solution = new Map<TypeParam, DartType>();
    for (const [index, parameter] of source.positional.entries()) {
      const given = expected.positional[index];
      if (given) inferFromSubtype(given, parameter, params, solution, (a) => a);
    }
    for (const named of source.named) {
      const given = expected.named.find((other) => other.name === named.name);
      if (given) inferFromSubtype(given.type, named.type, params, solution, (a) => a);
    }
    const defaults = instantiateToBounds(source.typeParams);
    const typeArgs = source.typeParams.map((param, index) => solution.get(param) ?? defaults[index]);
    const type = instantiateFunction(source, typeArgs);
    if (!isSubtype(type, target)) return undefined;
    const { run } = compiled;
    const resolveArgs = typeArgs.map((arg) => this.runtimeType(arg));
    return {
      ...compiled,
      type,
      isConst: compiled.isConst,
      run: (frame) => {
        const original = run(frame);
        const fixed = resolveArgs.map((resolve) => resolve(frame));
        return new DartClosureValue(
          coreTypes.function,
          substitute(type, frame.typeEnv) as FunctionType,
          (runtime, _receiver, args, _typeArgs, callRow) => runtime.callValue(original, args, fixed, callRow),
          undefined,
          [],
          { name: undefined, origin: undefined },
          undefined
        );
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
        const actual = typeToString(frame.runtime.runtimeTypeOf(value));
        frame.runtime.throwTypeError(
          `type '${actual}' is not a subtype of type '${typeToString(type)}'${explicit ? ' in type cast' : ''}`
        );
      }
      return value;
    };
  }

  /** Evaluates a type at runtime, replacing the type parameters in scope with the frame's type arguments. */
  runtimeType(type: DartType): (frame: Frame) => DartType {
    if (!mentionsTypeParams(type)) return () => type;
    return (frame) => substitute(type, frame.typeEnv);
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

export function instantiateToBounds(params: readonly TypeParam[]): DartType[] {
  const args: DartType[] = params.map(() => DYNAMIC);
  for (const [index, param] of params.entries()) {
    if (!param.bound) continue;
    const map = new Map(params.map((other, at) => [other, args[at]]));
    args[index] = substitute(param.bound, map);
  }
  return args;
}

/** Whether a value is of a type that holds no type parameters, checked against the value's runtime type. */
export function valueIs(runtime: Runtime, value: Value, type: DartType): boolean {
  if (isTop(type)) return true;
  if (value === undefined) return isNullable(type);
  return isSubtype(runtime.runtimeTypeOf(value), type);
}

/**
 * Collects the constraints a context puts on a function's result type: where the result is a subclass of the context's
 * class (`R<int> r = E()`), its type arguments are matched through the subclass's supertype.
 */
export function inferFromContext(
  context: DartType,
  formal: DartType,
  params: ReadonlySet<TypeParam>,
  solution: Map<TypeParam, DartType>
): void {
  const base = resolveBound(context);
  if (
    formal.kind === 'interface' &&
    base.kind === 'interface' &&
    formal.cls !== base.cls &&
    formal.cls.isSubclassOf(base.cls)
  ) {
    const path = asInstanceOf(formal, base.cls);
    if (path) {
      for (const [index, arg] of path.args.entries()) {
        const given = base.args[index];
        if (given) inferFromSubtype(given, arg, params, solution, (a) => a);
      }
      return;
    }
  }
  inferFromSubtype(context, formal, params, solution, (a) => a);
}

/**
 * Collects the constraints that make `actual` a subtype of `formal` on the type parameters in `params`, keeping in
 * `solution` the least upper bound of what each must be a supertype of.
 */
// code-gauge-allow functionCognitiveComplexity 30 -- One case per kind of type.
export function inferFromSubtype(
  actual: DartType,
  formal: DartType,
  params: ReadonlySet<TypeParam>,
  solution: Map<TypeParam, DartType>,
  join: (a: DartType, b: DartType) => DartType = (a) => a
): void {
  if (formal.kind === 'typeParam' && params.has(formal.param)) {
    const target = formal.nullable && actual.kind !== 'dynamic' ? nonNullOf(actual) : actual;
    if (target.kind === 'never' && !target.nullable) return;
    const previous = solution.get(formal.param);
    solution.set(formal.param, previous ? join(previous, target) : target);
    return;
  }
  if (actual.kind === 'dynamic' && !mentionsTypeParams(formal, params)) return;
  if (formal.kind === 'interface') {
    const base = actual.kind === 'typeParam' ? resolveBound(actual) : actual;
    if (base.kind === 'dynamic') {
      for (const arg of formal.args) inferFromSubtype(DYNAMIC, arg, params, solution, join);
      return;
    }
    if (base.kind === 'function' && formal.cls === coreTypes.function) return;
    if (base.kind !== 'interface') return;
    const instance = asInstanceOf({ ...base, nullable: false }, formal.cls);
    if (!instance) return;
    for (const [index, arg] of formal.args.entries()) {
      const actualArg = instance.args[index];
      if (actualArg) inferFromSubtype(actualArg, arg, params, solution, join);
    }
    return;
  }
  if (formal.kind === 'function' && actual.kind === 'function') {
    inferFromSubtype(actual.returnType, formal.returnType, params, solution, join);
    return;
  }
  if (formal.kind === 'record' && actual.kind === 'record') {
    for (const [index, field] of formal.positional.entries()) {
      const actualField = actual.positional[index];
      if (actualField) inferFromSubtype(actualField, field, params, solution, join);
    }
    for (const field of formal.named) {
      const actualField = actual.named.find((other) => other.name === field.name);
      if (actualField) inferFromSubtype(actualField.type, field.type, params, solution, join);
    }
  }
}

function nonNullOf(type: DartType): DartType {
  if (type.kind === 'null') return NEVER;
  if (type.kind === 'interface' || type.kind === 'function' || type.kind === 'record') {
    return type.nullable ? { ...type, nullable: false } : type;
  }
  if (type.kind === 'typeParam' && type.nullable) return { ...type, nullable: false };
  return type;
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

const recordFields = new Map<string, Member>();

/** The getter of a record's field, which reads it by name or position. */
function recordFieldMember(name: string): Member {
  let member = recordFields.get(name);
  if (!member) {
    const position = /^\$([1-9]\d*)$/.exec(name);
    member = {
      kind: 'getter',
      name,
      owner: coreTypes.record,
      isStatic: false,
      isAbstract: false,
      row: undefined,
      type: DYNAMIC,
      impl: (_runtime, receiver) => {
        const record = receiver as DartRecord;
        if (position) {
          const index = Number(position[1]) - 1;
          if (index < record.positional.length) return record.positional[index];
        }
        return record.named.find(([field]) => field === name)?.[1];
      },
    };
    recordFields.set(name, member);
  }
  return member;
}

export { recordFieldMember };

export type { TypeEnv };
