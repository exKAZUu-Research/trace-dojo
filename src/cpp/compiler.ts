import { CRuntimeError } from '../c/errors';
import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import { misplacedAtomicMessage, type TraceOptions } from '../interpreter/traceAnnotations';
import { isBaseAccessible, isMemberAccessible } from './access';
import { byteAt } from './bytes';
import { type Declared, hasAuto } from './compilerBase';
import { implicitConversion } from './conversions';
import { CppException, CppRuntimeError, NarrowingConversionError } from './errors';
import {
  type Expr,
  type Initializer,
  type InitializerTarget,
  initializerWithConstancy,
  memberConstantOf,
  NO_CONSTANT_MEMBERS,
} from './expr';
import type { Library } from './library/registry';
import {
  bindRetainedTemporary,
  constructArray,
  initializeAt,
  installBaseValue,
  invoke,
  makeEach,
  newObject,
  type Resolved,
  staticZero,
  virtualKey,
  withTemporaries,
  zeroMembers,
  zeroOf,
} from './objectCompiler';
import { type CompiledFunction, type Eval, type Exec, type Frame, holdAll, RETURN, type Runtime } from './runtime';
import { type Entity, FunctionContext } from './scopes';
import {
  type AutoDeduction,
  deducedType,
  endScope,
  type ReferenceBinding,
  StatementCompiler,
} from './statementCompiler';
import { isObjectCreation } from './stepRules';
import { fieldOf, fieldsOf, hasToken, type Syntax } from './syntax';
import {
  type Access,
  allowsMemberAssignment,
  ClassInfo,
  classType,
  type FieldInfo,
  type FunctionInfo,
  type GlobalInfo,
  INT,
  intMax,
  intMin,
  isArithmetic,
  isConstType,
  isCopyConstructor,
  isInteger,
  isReferenceRelated,
  nonReference,
  type ParamInfo,
  sameParameters,
  sameType,
  type Type,
  typeName,
  unqualified,
  VOID,
} from './types';
import {
  ArrayStore,
  Box,
  CObject,
  destroyRetainedTemporary,
  endLifetime,
  Liveness,
  Ptr,
  RetainedTemporary,
  UNINIT,
  type Value,
} from './values';

export interface CompileOptions {
  trace?: TraceOptions;
}

/** A program ready to run: its static storage and its entry point. */
export interface CompiledProgram {
  main: FunctionInfo;
  globals: GlobalInfo[];
  /** Creates each variable with static storage duration, zero-initialized, by its index. */
  createGlobals: (runtime: Runtime) => Box[];
  /** Runs constant initialization before declaration-ordered dynamic initialization. */
  initializeGlobals: (frame: Frame) => void;
  /** The static members and global variables learners see, by global index. */
  shownGlobals: GlobalInfo[];
  /** Whether `main` takes `argc` and `argv`. */
  mainTakesArguments: boolean;
}

/** Compiles a translation unit of C++20 that uses the interpreter's subset of the language and its library. */
export class Compiler extends StatementCompiler {
  readonly recordsSteps: boolean;
  private readonly atomicRows: ReadonlyMap<number, number>;
  private readonly usedAtomicRows = new Set<number>();
  private readonly constantInitializers: Exec[] = [];
  private readonly dynamicInitializers: Exec[] = [];
  private readonly globalTypes: Type[] = [];
  /** The functions the program calls, which it must define, with the row of a call. */
  private readonly usedFunctions = new Map<FunctionInfo, number>();
  private readonly inlineDependencies = new WeakMap<FunctionInfo, () => void>();
  private readonly usedStaticMembers = new Map<GlobalInfo, number>();
  private readonly aggregateDefaults = new WeakMap<FieldInfo, () => Initializer>();
  private readonly implicitDefaults = new WeakMap<ClassInfo, () => FunctionInfo | undefined>();
  private readonly delegatedConstructors = new WeakMap<FunctionInfo, FunctionInfo>();
  private pendingObjectUses: (() => void)[] | undefined = [];
  private defaultDependencies?: {
    functions: Map<FunctionInfo, number>;
    staticMembers: Map<GlobalInfo, number>;
    checks: (() => void)[];
  };

  constructor(library: Library, options: CompileOptions = {}) {
    super(library);
    library.compiler = this;
    this.recordsSteps = options.trace !== undefined;
    this.atomicRows = options.trace?.atomicAnnotations ?? new Map();
  }

  compile(root: Syntax): CompiledProgram {
    for (const item of root.children) this.topLevel(item);
    const objectUses = this.pendingObjectUses;
    this.pendingObjectUses = undefined;
    for (const check of objectUses ?? []) check();
    this.checkLibraryGlobalDeclarations();
    const main = this.globalScope.names.get('main');
    if (main?.kind !== 'functions')
      return this.error(0, 'main 関数がありません。int main() { ... } を書いてください。');
    const mainFunction = main.functions.find((fn) => fn.isDefined);
    if (!mainFunction) return this.error(0, 'main 関数の本体がありません。');
    if (main.functions.length > 1) return this.error(mainFunction.row, 'main 関数はオーバーロードできません。');
    for (const [fn, row] of this.usedFunctions) {
      if (!fn.isDefined && !fn.native) {
        this.error(row, `関数 ${fn.displayName} は宣言だけで、定義（本体）がありません。`);
      }
      this.inlineDependencies.get(fn)?.();
    }
    for (const [member, row] of this.usedStaticMembers) {
      if (!member.isDefined) this.error(row, `static のメンバ変数 ${member.name} は宣言だけで、定義がありません。`);
    }
    for (const row of this.atomicRows.keys()) {
      if (!this.usedAtomicRows.has(row)) this.error(row, misplacedAtomicMessage);
    }
    const types = this.globalTypes;
    const libcOverrides = this.libcOverrides();
    return {
      main: mainFunction,
      globals: this.globals,
      createGlobals: (runtime) =>
        types.map((type) => {
          const box = new Box();
          box.value = staticZero(runtime, type, box.location(0));
          return box;
        }),
      initializeGlobals: (frame) => {
        frame.runtime.libcOverrides = libcOverrides;
        for (const init of this.constantInitializers) init(frame);
        for (const init of this.dynamicInitializers) init(frame);
      },
      shownGlobals: this.globals.filter((global) => global.isShown),
      mainTakesArguments: mainFunction.params.length === 2,
    };
  }

  private libcOverrides(): ReadonlyMap<string, FunctionInfo> {
    const overrides = new Map<string, FunctionInfo>();
    for (const entity of this.globalScope.names.values()) {
      if (entity.kind !== 'functions') continue;
      for (const fn of entity.functions) {
        if (this.library.isLibcDefinition(fn)) overrides.set(fn.name, fn);
      }
    }
    return overrides;
  }

  private checkLibraryGlobalDeclarations(): void {
    for (const [name, entity] of this.globalScope.names) {
      if (entity.kind === 'global' && this.library.conflictsWithGlobal(name, entity.global.type))
        this.error(entity.global.row, `${name} はヘッダーにある名前の宣言と重複しています。`);
      if (entity.kind === 'functions') {
        const conflict = entity.functions.find((fn) => !fn.native && this.library.conflictsWithGlobal(name, fn));
        if (conflict) this.error(conflict.row, `${name} はヘッダーにある宣言と重複しています。`);
      }
    }
  }

  // code-gauge-allow functionNcss 40 -- One case per kind of declaration at file scope.
  private topLevel(node: Syntax): void {
    switch (node.type) {
      case 'preproc_include': {
        this.library.include(fieldOf(node, 'path')?.text.slice(1, -1).trim() ?? '');
        return;
      }
      case 'using_declaration': {
        this.usingDeclaration(node);
        return;
      }
      case 'class_specifier':
      case 'struct_specifier': {
        this.classSpecifierType(node);
        return;
      }
      case 'function_definition': {
        this.functionDefinition(node);
        return;
      }
      case 'declaration': {
        this.globalDeclaration(node);
        return;
      }
      case 'expression_statement': {
        if (node.children.length === 0) return;
        this.error(node.row, '関数の外には、文を書けません（変数・関数・クラスの宣言だけを書けます）。');
        return;
      }
      default: {
        this.error(node.row, `${node.text.split('\n')[0]} は、関数の外には書けません。`);
      }
    }
  }

  usingDeclaration(node: Syntax): void {
    const isNamespace = hasToken(node, 'namespace');
    const target = node.children[0];
    if (!target) return;
    if (isNamespace) {
      if (target.text !== 'std') return this.unsupported(node.row, `名前空間 ${target.text}`);
      if (this.context.fn) this.context.scope.usesStd = true;
      else this.usesStd = true;
      return;
    }
    if (target.type !== 'qualified_identifier') return this.unsupported(node.row, `using ${target.text}`);
    const scope = fieldOf(target, 'scope');
    if (scope?.text !== 'std') return this.unsupported(node.row, '名前空間以外の using 宣言（using Base::f; など）');
    const entity = this.lookupQualified(target);
    const name = (fieldOf(target, 'name') as Syntax).text;
    const names = (this.context.fn ? this.context.scope : this.globalScope).names;
    const previous = names.get(name);
    if (!previous) {
      names.set(name, entity.kind === 'functions' ? { kind: 'functions', functions: [...entity.functions] } : entity);
      return;
    }
    if (
      previous === entity ||
      (previous.kind === 'type' && entity.kind === 'type' && sameType(previous.type, entity.type))
    )
      return;
    if (previous.kind !== 'functions' || entity.kind !== 'functions')
      this.error(node.row, `${name} は、このスコープですでに別のものとして宣言されています。`);
    const functions = [...previous.functions];
    for (const fn of entity.functions) {
      if (functions.includes(fn)) continue;
      const declared = functions.find((candidate) => sameDeclaredSignature(candidate, fn));
      if (declared && this.library.sameCFunction(declared, fn)) continue;
      this.addOverload(functions, fn, node.row);
    }
    names.set(name, { kind: 'functions', functions });
  }

  // Classes ----------------------------------------------------------------------------------------------------------

  protected classSpecifierType(node: Syntax): Type {
    const nameNode = fieldOf(node, 'name');
    if (nameNode) this.checkHeaderMacro(nameNode.text, nameNode.row);
    const body = fieldOf(node, 'body');
    if (!nameNode) return this.unsupported(node.row, '名前のないクラス');
    if (nameNode.type !== 'type_identifier') return this.unsupported(node.row, `クラス ${nameNode.text} の定義`);
    const name = nameNode.text;
    let cls: ClassInfo;
    const existing = this.globalScope.names.get(name);
    if (existing?.kind === 'class') {
      cls = existing.cls;
      if (body && cls.isComplete) return this.error(node.row, `クラス ${name} はすでに定義されています。`);
    } else {
      if (existing) return this.error(node.row, `${name} はすでに別のものとして宣言されています。`);
      if (this.context.fn) return this.unsupported(node.row, '関数の中のクラスの定義');
      if (this.library.global(name)?.kind === 'type')
        return this.error(node.row, `${name} はヘッダーで型として宣言されています。`);
      cls = new ClassInfo(name, node.type === 'struct_specifier' ? 'struct' : 'class');
      cls.row = node.row;
      this.globalScope.names.set(name, { kind: 'class', cls });
    }
    if (body) this.defineClass(cls, node, body);
    return classType(cls);
  }

  private defineClass(cls: ClassInfo, node: Syntax, body: Syntax): void {
    const isFinalClass = node.children.some((child) => child.type === 'virtual_specifier' && child.text === 'final');
    const defaultAccess: Access = node.type === 'struct_specifier' ? 'public' : 'private';
    this.baseClause(cls, node, defaultAccess);
    const savedClass = this.memberClass;
    this.memberClass = cls;
    const definitions: { fn: FunctionInfo; node: Syntax }[] = [];
    try {
      let access: Access = defaultAccess;
      for (const member of body.children) {
        switch (member.type) {
          case 'access_specifier': {
            access = member.text as Access;
            break;
          }
          case 'field_declaration': {
            this.memberDeclaration(cls, member, access);
            break;
          }
          case 'declaration': {
            this.memberDeclaration(cls, member, access);
            break;
          }
          case 'function_definition': {
            const fn = this.memberFunction(cls, member, access, true);
            definitions.push({ fn, node: member });
            break;
          }
          case 'using_declaration': {
            this.unsupported(member.row, 'クラスの中の using 宣言（using Base::Base; など）');
            break;
          }
          case 'class_specifier':
          case 'struct_specifier': {
            this.unsupported(member.row, '入れ子のクラス');
            break;
          }
          default: {
            this.error(member.row, `${member.text.split('\n')[0]} はクラスの中には書けません。`);
          }
        }
      }
      this.completeClass(cls, isFinalClass);
      for (const fn of cls.constructors) this.bindDefaultArguments(fn);
      for (const methods of cls.methods.values()) {
        for (const fn of methods) this.bindDefaultArguments(fn);
      }
      if (this.isAggregate(cls)) {
        for (const field of cls.ownFields) {
          if (field.initializer) {
            const bound = this.bindDependencies(() => this.bindAggregateDefault(field, field.row));
            this.aggregateDefaults.set(field, bound);
          }
        }
      }
      for (const { fn, node: definition } of definitions) this.compileFunction(fn, definition);
      for (const fn of [...cls.constructors, ...(cls.destructor ? [cls.destructor] : [])]) {
        if (fn.isDefined && !fn.compiled && fn.definition) this.compileFunction(fn, fn.definition);
      }
    } finally {
      this.memberClass = savedClass;
    }
  }

  private baseClause(cls: ClassInfo, node: Syntax, defaultAccess: Access): void {
    const clause = node.children.find((child) => child.type === 'base_class_clause');
    if (!clause) return;
    const bases = clause.children.filter((child) => child.type !== 'access_specifier');
    if (bases.length > 1) return this.unsupported(clause.row, '多重継承');
    if (hasToken(clause, 'virtual')) return this.unsupported(clause.row, '仮想継承（virtual で継承すること）');
    const baseName = bases[0];
    const baseType = this.resolveTypeSpecifier(baseName, false, true);
    if (baseType.kind !== 'class')
      return this.error(clause.row, `${bases[0].text} はクラスではないので継承できません。`);
    const base = baseType.cls;
    if (!base.isComplete)
      return this.error(clause.row, `クラス ${base.name} はまだ定義されていないので継承できません。`);
    if (base.isFinal) return this.error(clause.row, `クラス ${base.name} は final なので継承できません。`);
    if (base.library && !base.library.isInheritable) {
      return this.unsupported(clause.row, `標準ライブラリのクラス ${base.name} の継承`);
    }
    cls.base = base;
    const accessNode = clause.children.find((child) => child.type === 'access_specifier');
    cls.baseAccess = (accessNode?.text as Access | undefined) ?? defaultAccess;
    cls.fields = [...base.fields];
  }

  private memberDeclaration(cls: ClassInfo, node: Syntax, access: Access): void {
    const declarators = fieldsOf(node, 'declarator');
    const type = fieldOf(node, 'type');
    if (
      type &&
      (type.type === 'class_specifier' || type.type === 'struct_specifier') &&
      (fieldOf(type, 'body') || declarators.length === 0)
    )
      return this.unsupported(type.row, 'クラスの中のクラスの宣言');
    if (declarators.length === 0) return this.error(node.row, 'メンバの名前を書いてください。');
    const isStatic = this.hasSpecifier(node, 'static');
    const isConstexpr = this.isConstexpr(node);
    const isInline = this.hasSpecifier(node, 'inline') || isConstexpr;
    let base: Type | undefined;
    for (const declarator of declarators) {
      if (this.isFunctionDeclarator(declarator)) {
        this.memberFunction(cls, node, access, false, declarator);
        continue;
      }
      if (hasToken(node, 'virtual')) this.error(declarator.row, 'virtual はメンバ関数にしか付けられません。');
      base ??= this.specifiedType(node);
      const declared = this.applyDeclarator(base, declarator);
      const name = declared.name as string;
      if (this.memberEntity(cls, name)) this.error(declarator.row, `メンバ ${name} はすでに宣言されています。`);
      const initializer = this.defaultValueOf(node, declarator);
      const directInitializer =
        initializer?.type === 'initializer_list' && node.all[node.all.indexOf(initializer) - 1]?.type !== '=';
      if (isStatic) {
        if (isConstexpr) this.requireConstantInitializer(declared.type, initializer, declarator.row, directInitializer);
        this.staticMember(cls, name, declared.type, access, declarator.row, initializer, {
          isInline,
          isConstexpr,
          directInitializer,
        });
        continue;
      }
      if (declared.type.kind === 'class' && !declared.type.cls.isComplete) {
        this.error(declarator.row, `クラス ${declared.type.cls.name} はまだ定義されていないので、メンバにできません。`);
      }
      this.checkLibraryLayout(declared.type, declarator.row);
      if (declared.type.kind === 'void') this.error(declarator.row, `void 型のメンバ ${name} は作れません。`);
      if (declared.type.kind === 'array' && declared.type.length === undefined) {
        this.unsupported(declarator.row, '大きさのない配列のメンバ（柔軟な配列メンバ）');
      }
      const field: FieldInfo = {
        name,
        type: declared.type,
        index: cls.fields.length,
        access,
        owner: cls,
        row: declarator.row,
        initializer,
        directInitializer,
      };
      cls.fields.push(field);
    }
  }

  private defaultValueOf(node: Syntax, declarator: Syntax): Syntax | undefined {
    const index = node.all.indexOf(declarator);
    const next = node.all
      .slice(index + 1)
      .find((child) => child.field === 'declarator' || child.field === 'default_value');
    return next?.field === 'default_value' ? next : undefined;
  }

  private staticMember(
    cls: ClassInfo,
    name: string,
    type: Type,
    access: Access,
    row: number,
    initializer: Syntax | undefined,
    {
      isInline,
      isConstexpr,
      directInitializer,
    }: { isInline: boolean; isConstexpr: boolean; directInitializer: boolean }
  ): void {
    const info = {
      name,
      type,
      access,
      owner: cls,
      row,
      constant: undefined as number | bigint | undefined,
      global: undefined as GlobalInfo | undefined,
    };
    cls.staticFields.set(name, info);
    const isConstIntegral = isConstType(type) && isInteger(type);
    if (initializer && !isInline && !isConstIntegral) {
      this.error(
        row,
        `static のメンバ変数 ${name} の初期値は、クラスの外の定義に書いてください（または inline static にしてください）。`
      );
    }
    const global = this.declareStaticStorage(`${cls.name}::${name}`, type, row, !isConstType(type));
    info.global = global;
    global.isDefined = isInline;
    global.isConstexpr = isConstexpr;
    if (initializer || (isInline && (type.kind === 'reference' || this.isClassType(type))))
      info.constant = this.initializeGlobal(global, type, initializer, row, directInitializer, isConstexpr);
    if (!isInline && initializer && info.constant === undefined)
      this.error(row, 'クラスの中で初期化する static const の整数には定数を書いてください。');
  }

  private isFunctionDeclarator(declarator: Syntax): boolean {
    let current: Syntax | undefined = declarator;
    while (current) {
      if (current.type === 'function_declarator') return true;
      if (current.type === 'parenthesized_declarator') return false;
      current = fieldOf(current, 'declarator') ?? current.children.find((child) => child.type.endsWith('declarator'));
    }
    return false;
  }

  /** Declares a member function, constructor, or destructor of a class from its declaration or in-class definition. */
  private memberFunction(
    cls: ClassInfo,
    node: Syntax,
    access: Access,
    isDefinition: boolean,
    declarator = fieldOf(node, 'declarator') as Syntax
  ): FunctionInfo {
    const typeNode = fieldOf(node, 'type');
    const declared = this.applyDeclarator(typeNode ? this.specifiedType(node, true) : VOID, declarator);
    const functionDeclarator = declared.function as Syntax;
    const rawName = declared.name ?? '';
    const isDestructor = rawName.startsWith('~');
    const isConstructor = !typeNode && !isDestructor;
    if (isConstructor && rawName !== cls.name) return this.error(node.row, `${rawName} の戻り値の型を書いてください。`);
    if (isDestructor && rawName !== `~${cls.name}`)
      return this.error(node.row, `デストラクタの名前は ~${cls.name} です。`);
    this.checkSpecialMemberReturnType(cls, rawName, node);
    const fn = this.functionInfo(rawName, declared.type, functionDeclarator, node, cls);
    this.checkTrailingDefaults(fn.params);
    fn.access = access;
    fn.isConstructor = isConstructor;
    fn.isDestructor = isDestructor;
    if (isDestructor) fn.isNoexcept = true;
    fn.isStatic = this.hasSpecifier(node, 'static');
    const inheritedVirtual = !isConstructor && cls.base?.virtuals.has(isDestructor ? '~' : virtualKey(fn));
    fn.isVirtual = hasToken(node, 'virtual') || inheritedVirtual === true;
    fn.isInline = isDefinition || this.hasSpecifier(node, 'inline');
    if ((isConstructor || isDestructor) && fn.isStatic)
      this.error(node.row, 'コンストラクタとデストラクタは static にできません。');
    if (fn.isStatic && fn.isConst) this.error(node.row, 'static のメンバ関数は const にできません。');
    if (fn.isStatic && fn.isVirtual) this.error(node.row, 'static のメンバ関数は virtual にできません。');
    if (isConstructor && fn.isVirtual) this.error(node.row, 'コンストラクタは virtual にできません。');
    if ((isConstructor || isDestructor) && fn.isConst)
      this.error(node.row, 'コンストラクタとデストラクタは const にできません。');
    const [first, ...rest] = fn.params;
    if (
      isConstructor &&
      first?.type.kind === 'class' &&
      first.type.cls === cls &&
      rest.every((param) => param.defaultValue !== undefined)
    )
      this.error(node.row, 'コピーコンストラクタの引数には参照を使ってください。');
    const defaultValue = this.defaultValueOf(node, declarator);
    if (defaultValue) {
      if (defaultValue.text !== '0' || !fn.isVirtual)
        this.error(node.row, '= 0 は virtual のメンバ関数にしか付けられません。');
      fn.isPure = true;
    }
    if (isDefinition) {
      fn.isDefined = true;
      fn.definition = node;
      this.claimAtomic(fn, node);
    }
    if (isConstructor) {
      this.addOverload(cls.constructors, fn, node.row);
    } else if (isDestructor) {
      if (cls.destructor) this.error(node.row, `デストラクタ ~${cls.name} はすでに宣言されています。`);
      if (fn.params.length > 0) this.error(node.row, 'デストラクタは引数をとれません。');
      cls.destructor = fn;
    } else {
      if (cls.ownFields.some((field) => field.name === rawName) || cls.staticFields.has(rawName)) {
        this.error(node.row, `${rawName} はすでにメンバ変数として宣言されています。`);
      }
      const overloads = cls.methods.get(rawName) ?? [];
      this.addOverload(overloads, fn, node.row);
      cls.methods.set(rawName, overloads);
    }
    return fn;
  }

  /** Adds a function to an overload set, rejecting a second declaration with the same parameters. */
  private addOverload(overloads: FunctionInfo[], fn: FunctionInfo, row: number): void {
    const same = overloads.find((other) => sameDeclaredSignature(other, fn));
    if (same) this.error(row, `${fn.displayName} は、同じ引数の型ですでに宣言されています。`);
    overloads.push(fn);
  }

  /** A function's declaration from its declarator, with the names and types of its parameters. */
  private functionInfo(
    name: string,
    ret: Type,
    declarator: Syntax,
    node: Syntax,
    owner: ClassInfo | undefined
  ): FunctionInfo {
    const qualifiers = new Set(
      declarator.children.filter((child) => child.type === 'type_qualifier').map((child) => child.text)
    );
    const specifiers = declarator.children
      .filter((child) => child.type === 'virtual_specifier')
      .map((child) => child.text);
    if (qualifiers.has('volatile')) this.unsupported(node.row, 'volatile');
    if (this.hasSpecifier(node, 'constexpr') && !this.context.fn) this.unsupported(node.row, 'constexpr の関数');
    if (hasAuto(ret)) this.unsupported(node.row, '戻り値の型の auto');
    if (ret.kind === 'array') this.error(node.row, '関数は配列を返せません。');
    const params = this.parameters(fieldOf(declarator, 'parameters') as Syntax);
    const displayName = owner ? `${owner.name}::${name}` : name;
    if ((specifiers.length > 0 || qualifiers.has('const')) && !owner) {
      this.error(
        node.row,
        `${specifiers.includes('override') ? 'override' : 'const'} はメンバ関数にしか付けられません。`
      );
    }
    return {
      name,
      displayName,
      params,
      ret,
      owner,
      isStatic: false,
      isVirtual: false,
      isInline: this.hasSpecifier(node, 'inline'),
      isConst: qualifiers.has('const'),
      isNoexcept: declarator.children.some((child) => child.type === 'noexcept'),
      isPure: false,
      isConstructor: false,
      isDestructor: false,
      isOverride: specifiers.includes('override'),
      isFinal: specifiers.includes('final'),
      access: 'public',
      row: node.row,
      isAtomic: false,
      isDefined: false,
    };
  }

  private parameters(list: Syntax): ParamInfo[] {
    const params: ParamInfo[] = [];
    const declarations = list.children;
    for (const param of declarations) {
      if (param.type === 'variadic_parameter') return this.unsupported(param.row, '可変長引数（...）');
      const base = this.specifiedType(param, true);
      const declarator = fieldOf(param, 'declarator');
      const declared = declarator ? this.applyDeclarator(base, declarator) : { name: undefined, type: base };
      let type = declared.type;
      if (type.kind === 'void') {
        if (!declarator && !isConstType(type) && declarations.length === 1) return [];
        this.error(param.row, '引数の型に void は書けません。');
      }
      if (hasAuto(type)) this.unsupported(param.row, '引数の型の auto（省略形の関数テンプレート）');
      // An array parameter is a pointer (C++20 [dcl.fct]).
      if (type.kind === 'array') type = { kind: 'pointer', to: type.of };
      const defaultValue =
        param.type === 'optional_parameter_declaration' ? fieldOf(param, 'default_value') : undefined;
      params.push({
        name: declared.name,
        type,
        defaultValue: defaultValue ? { node: defaultValue } : undefined,
        row: param.row,
      });
    }
    return params;
  }

  /** Marks a function atomic when an `// atomic` annotation is on its header, from its start through its body's `{`. */
  private claimAtomic(fn: FunctionInfo, node: Syntax): void {
    const body = fieldOf(node, 'body');
    const lastRow = body ? body.row : node.endRow;
    for (let row = node.row; row <= lastRow; row++) {
      if (this.atomicRows.has(row)) {
        fn.isAtomic = true;
        this.usedAtomicRows.add(row);
      }
    }
  }

  /** Completes a class once its members are declared: virtual functions, special members, and object operations. */
  private completeClass(cls: ClassInfo, isFinalClass: boolean): void {
    cls.isFinal = isFinalClass;
    if (cls.base) for (const [key, fn] of cls.base.virtuals) cls.virtuals.set(key, fn);
    for (const overloads of cls.methods.values()) {
      for (const fn of overloads) this.completeVirtual(cls, fn, virtualKey(fn));
    }
    const baseDestructor = cls.base?.destructor;
    cls.hasUserDestructor = cls.destructor !== undefined;
    if (!cls.destructor && baseDestructor?.isVirtual) cls.destructor = this.implicitDestructor(cls);
    if (cls.destructor) this.completeVirtual(cls, cls.destructor, '~');
    const copies = this.writtenCopyConstructors(cls);
    if (copies.length === 0) this.completeImplicitCopy(cls);
    cls.isAssignmentDeleted =
      cls.base?.isAssignmentDeleted === true || cls.ownFields.some((field) => !allowsMemberAssignment(field.type));
    cls.isComplete = true;
    if (cls.constructors.length === 0) {
      cls.isDefaultConstructorDeleted =
        (cls.base !== undefined && !this.isDefaultInitializable(classType(cls.base), cls, true)) ||
        cls.ownFields.some((field) => !field.initializer && !this.isDefaultInitializable(field.type, cls));
      if (!cls.isDefaultConstructorDeleted) {
        this.implicitDefaults.set(cls, this.bindImplicitDefault(cls));
      }
    }
    cls.operations = this.classOperations(cls, copies.length > 0);
  }

  private completeImplicitCopy(cls: ClassInfo): void {
    const base = cls.base && classType(cls.base);
    cls.implicitCopyFromConst =
      (!base || this.hasConstCopyParameter(base)) &&
      cls.ownFields.every((field) => this.hasConstCopyParameter(field.type));
    cls.isNoncopyable =
      (base !== undefined && !this.isCopyInitializable(base, cls, true)) ||
      cls.ownFields.some((field) => !this.isCopyInitializable(field.type, cls));
  }

  private isCopyInitializable(type: Type, owner: ClassInfo, isBase = false): boolean {
    if (type.kind === 'array') return type.length === 0 || this.isCopyInitializable(type.of, owner);
    if (type.kind !== 'class') return true;
    const { cls } = type;
    if (cls.isNoncopyable) return false;
    const object = isBase ? owner : cls;
    if (cls.destructor && !isMemberAccessible(cls.destructor.access, cls, cls, owner, object)) return false;
    const sourceIsConst = owner.implicitCopyFromConst || isConstType(type);
    if (this.writtenCopyConstructors(cls).length === 0) return !sourceIsConst || cls.implicitCopyFromConst;
    const copy = this.usableCopyConstructor(cls, sourceIsConst);
    return copy !== undefined && isMemberAccessible(copy.access, cls, cls, owner, object);
  }

  private usableCopyConstructor(cls: ClassInfo, sourceIsConst: boolean): FunctionInfo | undefined {
    try {
      return this.selectCopyConstructor(cls, sourceIsConst, cls.row);
    } catch (error) {
      if (error instanceof CompileError) return;
      throw error;
    }
  }

  private isDefaultInitializable(type: Type, owner: ClassInfo, isBase = false): boolean {
    if (type.kind === 'reference') return false;
    if (type.kind === 'array') return type.length === 0 || this.isDefaultInitializable(type.of, owner);
    if (type.kind !== 'class') return !isConstType(type);
    const { cls } = type;
    if (cls.isDefaultConstructorDeleted || (isConstType(type) && !isConstDefaultConstructible(type))) return false;
    const fixed = cls.library?.aggregateArray;
    if (fixed) return this.isDefaultInitializable(fixed.type, cls);
    const objectClass = isBase ? owner : cls;
    if (cls.destructor && !isMemberAccessible(cls.destructor.access, cls, cls, owner, objectClass)) return false;
    const members = cls.library?.valueInitializedMembers;
    if (members?.some((member) => !this.isDefaultInitializable(unqualified(member), cls))) return false;
    if (cls.constructors.length === 0) return true;
    try {
      const viable = this.matchingOverloads(cls.constructors, []);
      const selected = this.chooseOverload(cls.name, viable, owner.row)?.fn;
      return selected !== undefined && isMemberAccessible(selected.access, cls, cls, owner, objectClass);
    } catch (error) {
      if (error instanceof CompileError) return false;
      throw error;
    }
  }

  private bindImplicitDefault(cls: ClassInfo): () => FunctionInfo | undefined {
    try {
      return this.bindDependencies(() => this.implicitDefaultConstructor(cls));
    } catch (error) {
      if (!(error instanceof TemporaryConstructorReferenceError)) throw error;
      return () => {
        throw error;
      };
    }
  }

  private completeVirtual(cls: ClassInfo, fn: FunctionInfo, key: string): void {
    const overridden = cls.base?.virtuals.get(key);
    if (overridden) {
      this.checkOverrider(fn, overridden);
      fn.isVirtual = true;
    } else if (fn.isOverride) {
      this.error(fn.row, `override を付けた ${fn.name} は、親クラスの仮想関数を上書きしていません。`);
    } else if (fn.isFinal && !fn.isVirtual) {
      this.error(fn.row, 'final は仮想関数にしか付けられません。');
    }
    if (fn.isVirtual) cls.virtuals.set(key, fn);
  }

  private checkOverrider(fn: FunctionInfo, overridden: FunctionInfo): void {
    if (!sameType(unqualified(overridden.ret), unqualified(fn.ret)) && !covariant(overridden.ret, fn.ret, fn.owner)) {
      this.error(fn.row, `${fn.displayName} の戻り値の型が、上書きする ${overridden.displayName} と違います。`);
    }
    if (overridden.isFinal) this.error(fn.row, `${overridden.displayName} は final なので上書きできません。`);
    if (overridden.isNoexcept && !fn.isNoexcept) {
      this.error(
        fn.row,
        `${overridden.displayName} は noexcept なので、上書きする ${fn.displayName} にも noexcept が要ります。`
      );
    }
  }

  private implicitDestructor(cls: ClassInfo): FunctionInfo {
    return {
      ...this.syntheticFunction(cls, `~${cls.name}`),
      isDestructor: true,
      isVirtual: true,
      isNoexcept: true,
      isDefined: true,
    };
  }

  private syntheticFunction(cls: ClassInfo, name: string): FunctionInfo {
    return {
      name,
      displayName: `${cls.name}::${name}`,
      params: [],
      ret: VOID,
      owner: cls,
      isStatic: false,
      isVirtual: false,
      isConst: false,
      isPure: false,
      isConstructor: false,
      isDestructor: false,
      isOverride: false,
      isFinal: false,
      access: 'public',
      row: cls.row,
      isAtomic: false,
      isDefined: true,
    };
  }

  /**
   * The constructor a class without any gets, which initializes its base and members as their defaults say; none when
   * it has nothing to do.
   */
  private implicitDefaultConstructor(cls: ClassInfo): FunctionInfo | undefined {
    const fn: FunctionInfo = { ...this.syntheticFunction(cls, cls.name), isConstructor: true };
    const context = new FunctionContext(fn, cls, VOID);
    const saved = this.context;
    this.context = context;
    try {
      const init = this.memberInitialization(cls, fn, undefined);
      if (!init) return undefined;
      fn.compiled = {
        slotCount: 0,
        locals: [],
        body: (frame) => void init(frame),
      };
      fn.compiled.slotCount = context.slotCount;
      fn.compiled.locals = context.locals;
    } finally {
      this.context = saved;
    }
    return fn;
  }

  /**
   * Compiles how a constructor initializes the base and the members, from its member initializer list (or none),
   * in declaration order; undefined when it has nothing to do.
   */
  // code-gauge-allow functionCognitiveComplexity 30 -- A constructor initializes its base, then each member, from three possible sources.
  private memberInitialization(cls: ClassInfo, fn: FunctionInfo, list: Syntax | undefined): Exec | undefined {
    const initializers = new Map<string, Syntax>();
    let baseInitializer: Syntax | undefined;
    let delegate: Syntax | undefined;
    for (const initializer of list?.children ?? []) {
      if (initializer.type !== 'field_initializer') continue;
      const nameNode = initializer.children[0];
      const { text: name } = nameNode;
      if (name === cls.name) {
        delegate = initializer;
        continue;
      }
      if (cls.base && this.namesClass(nameNode, cls.base)) {
        if (baseInitializer) this.error(initializer.row, `親クラス ${name} の初期化が重複しています。`);
        baseInitializer = initializer;
        continue;
      }
      if (!cls.ownFields.some((field) => field.name === name)) {
        this.error(initializer.row, `${name} は ${cls.name} のメンバでも親クラスでもありません。`);
      }
      if (initializers.has(name)) this.error(initializer.row, `メンバ ${name} の初期化が重複しています。`);
      initializers.set(name, initializer);
    }
    if (delegate) {
      if (list && list.children.filter((child) => child.type === 'field_initializer').length > 1) {
        this.error(delegate.row, '他のコンストラクタに任せるときは、ほかのメンバの初期化を書けません。');
      }
      return this.delegation(cls, fn, delegate);
    }
    const parts: Exec[] = [];
    const base = cls.base;
    if (base) parts.push(this.baseInitialization(cls, base, baseInitializer));
    else if (baseInitializer) this.error(baseInitializer.row, `${cls.name} には親クラスがありません。`);
    parts.push((frame) => {
      (frame.self?.read() as CObject).cls = cls;
      return;
    });
    let hasWork = base !== undefined;
    for (const field of cls.ownFields) {
      const explicit = initializers.get(field.name);
      const part = this.fieldInitialization(field, explicit);
      if (part) {
        parts.push(part);
        hasWork = true;
      }
    }
    if (!hasWork && !list && fn.params.length === 0) return undefined;
    return initializeInOrder(parts, base !== undefined, this.undoConstruction(cls));
  }

  /**
   * Destroys the members and the base a constructor has initialized, the last first, when an exception leaves the
   * constructor before the object is complete (C++20 [except.ctor]).
   */
  private undoConstruction(cls: ClassInfo): (frame: Frame, isBaseComplete: boolean, target?: CObject) => void {
    const destroyers = cls.ownFields.map((field) => ({ field, destroy: this.destroyerOf(field.type) }));
    const base = cls.base;
    return (frame, isBaseComplete, target) => {
      const object = target ?? (frame.self?.read() as CObject);
      for (let index = destroyers.length - 1; index >= 0; index--) {
        const { field, destroy } = destroyers[index];
        const member = object.values[field.index];
        if (member !== UNINIT) destroy?.(frame, member);
        endLifetime(member);
      }
      const baseDestroy = base?.operations?.destroy;
      if (baseDestroy && base && isBaseComplete) {
        object.cls = base;
        baseDestroy(frame, object);
      }
    };
  }

  /** Whether a member initializer's name names a class, as the base's name in `: Base(...)` does. */
  private namesClass(node: Syntax, cls: ClassInfo): boolean {
    let entity: Entity | undefined;
    try {
      entity = node.type === 'qualified_identifier' ? this.lookupQualified(node) : this.findName(node.text);
    } catch {
      return false;
    }
    if (entity?.kind === 'class') return entity.cls === cls;
    return entity?.kind === 'type' && entity.type.kind === 'class' && entity.type.cls === cls;
  }

  private delegation(cls: ClassInfo, from: FunctionInfo, initializer: Syntax): Exec {
    const args = this.initializerArguments(initializer);
    const resolved = this.resolveConstructor(
      cls,
      args,
      initializer.row,
      initializer.children[1]?.type === 'initializer_list'
    );
    for (let target: FunctionInfo | undefined = resolved.fn; target; target = this.delegatedConstructors.get(target)) {
      if (target === from) this.error(initializer.row, `${cls.name} のコンストラクタの委譲が循環しています。`);
    }
    this.delegatedConstructors.set(from, resolved.fn);
    this.checkDefined(resolved.fn, initializer.row);
    const runs = this.callArguments(resolved.fn, this.convertArguments(resolved, args), initializer.row);
    const { row } = initializer;
    return this.fullExpression<undefined>((frame) =>
      holdAll<undefined>(frame, runs, (values) => {
        invoke(frame, resolved.fn, values, frame.self, row, true);
        return;
      })
    );
  }

  private initializerArguments(initializer: Syntax): Expr[] {
    const argumentsNode = initializer.children[1];
    return (argumentsNode?.children ?? []).map((arg) => this.argument(arg));
  }

  private baseInitialization(cls: ClassInfo, base: ClassInfo, initializer: Syntax | undefined): Exec {
    const row = initializer?.row ?? cls.row;
    this.requireVirtualDefinitions(base, row);
    const braces = initializer?.children[1];
    if (braces?.type === 'initializer_list' && this.isAggregate(base)) {
      return this.initializeBaseInPlace(base, this.listInitializer(classType(base), braces, row));
    }
    const args = initializer ? this.initializerArguments(initializer) : [];
    if (base.constructors.length === 0) {
      if (args.length > 0) {
        const [source] = args;
        const object =
          args.length === 1 && source.type.kind === 'class' && source.type.cls.isDerivedFrom(base)
            ? this.copyObject(source, base)
            : this.parenthesizedAggregate(base, args, row);
        if (!object) return this.error(row, `${base.name} には引数をとるコンストラクタがありません。`);
        return this.initializeBaseInPlace(base, this.objectInitializer(object));
      }
      if (base.isDefaultConstructorDeleted) this.error(row, deletedDefaultMessage(base));
      const implicit = this.implicitDefaults.get(base)?.();
      return (frame) => {
        const object = frame.self?.read() as CObject;
        object.cls = base;
        const zeroInitialized = object.zeroInitialized;
        if (initializer && !zeroInitialized) {
          zeroMembers(frame.runtime, base, object);
          object.zeroInitialized = true;
        }
        try {
          if (implicit) invoke(frame, implicit, [], frame.self, row);
        } finally {
          object.zeroInitialized = zeroInitialized;
        }
        return;
      };
    }
    const resolved = this.resolveConstructor(base, args, row, initializer?.children[1]?.type === 'initializer_list');
    this.checkDefined(resolved.fn, row);
    if (!resolved.fn.native && resolved.fn.access === 'private')
      this.error(row, `${base.name} のコンストラクタは private です。`);
    const runs = this.callArguments(resolved.fn, this.convertArguments(resolved, args), row);
    return this.fullExpression<undefined>((frame) =>
      holdAll<undefined>(frame, runs, (values) => {
        (frame.self?.read() as CObject).cls = base;
        invoke(frame, resolved.fn, values, frame.self, row, true);
        return;
      })
    );
  }

  private initializeBaseInPlace(base: ClassInfo, initialize: Initializer): Exec {
    return this.fullExpression<undefined>((frame) => {
      const target = frame.self?.read() as CObject;
      target.cls = base;
      installBaseValue(base, target, initialize(frame, target) as CObject);
      return;
    });
  }

  /** Initializes one member as a constructor does, recording the step of an initializer that learners see. */
  private fieldInitialization(field: FieldInfo, explicit: Syntax | undefined): Exec | undefined {
    const { index, type } = field;
    let value: Initializer | undefined;
    let row = field.row;
    let isCreation = false;
    if (explicit) {
      row = explicit.row;
      const argumentsNode = explicit.children[1];
      if (type.kind === 'reference') {
        const args =
          argumentsNode?.type === 'initializer_list'
            ? [this.argument(argumentsNode)]
            : this.initializerArguments(explicit);
        if (args.length !== 1) this.error(row, `参照のメンバ ${field.name} には値を1つ書いてください。`);
        value = this.constructorReference(type, args[0], row, true) as Initializer;
      } else if (argumentsNode?.type === 'initializer_list') {
        value = this.listInitializer(type, argumentsNode, row, true);
        isCreation = type.kind === 'class' && !type.cls.library;
      } else {
        const args = this.initializerArguments(explicit);
        if (type.kind === 'class') {
          const run = this.constructObject(type.cls, args, row, false).run;
          value = (frame, target, zeroInitialize) => run(frame, zeroInitialize, asObject(target));
          isCreation = !type.cls.library;
        } else if (args.length === 0) {
          value = this.valueInitialized(type, row).run as Eval<Value>;
        } else if (args.length === 1 && type.kind !== 'array') {
          value = this.copyInitializer(type, this.directInitializerArgument(type, args[0]), row, false);
        } else {
          this.error(row, `メンバ ${field.name} の初期値には値を1つだけ書いてください。`);
        }
      }
    } else if (field.initializer) {
      const node = field.initializer;
      if (type.kind === 'reference')
        value = this.constructorReference(type, this.argument(node), row, field.directInitializer) as Initializer;
      else if (node.type === 'initializer_list') {
        value = this.listInitializer(type, node, row, field.directInitializer);
        isCreation = type.kind === 'class' && !type.cls.library;
      } else {
        const expr = this.compileExpression(node);
        value = this.copyInitializer(type, expr, row, false);
        isCreation = node.type === 'new_expression';
      }
    } else if (type.kind === 'reference') {
      return this.error(field.row, `参照のメンバ ${field.name} は、コンストラクタで初期化してください。`);
    } else if (isConstType(type) && !this.isClassType(type)) {
      return this.error(field.row, `const のメンバ ${field.name} は、コンストラクタで初期化してください。`);
    } else if (this.isClassType(type)) {
      value = this.defaultInitializer(type, row);
      isCreation = true;
    } else if (type.kind === 'array') {
      const init = this.defaultInitializer(type, row);
      return (frame) => {
        const object = frame.self?.read() as CObject;
        initializeAt(frame, type, object.location(index), object.values[index], (target) =>
          init(frame, target, object.zeroInitialized)
        );
        return;
      };
    } else {
      return undefined;
    }
    const exec = this.fullExpression<undefined>((frame) => {
      const object = frame.self?.read() as CObject;
      initializeAt(frame, type, object.location(index), object.values[index], (target) =>
        value(frame, target, object.zeroInitialized)
      );
      return;
    });
    return this.withStep(row, exec, isCreation);
  }

  private constructorReference(
    type: Extract<Type, { kind: 'reference' }>,
    expr: Expr,
    row: number,
    direct = false
  ): Eval<Value | Ptr> {
    const target = this.referenceMemberTarget(type, expr, row, direct);
    if (!target.isLvalue || target.isXvalue || target.temporaryBinding || !isReferenceRelated(target.type, type.to))
      throw new TemporaryConstructorReferenceError([
        { row, message: 'コンストラクタで参照メンバを一時的な値に束縛できません。' },
      ]);
    return this.convert(target, type, row).run;
  }

  private isClassType(type: Type): boolean {
    return type.kind === 'class' || (type.kind === 'array' && this.isClassType(type.of));
  }

  /** How objects of a class are copied, assigned, and destroyed. */
  private classOperations(cls: ClassInfo, hasUserCopy: boolean): ClassInfo['operations'] {
    const base = cls.base;
    const ownFields = cls.ownFields;
    const undo = this.undoConstruction(cls);
    const constCopy = hasUserCopy ? this.usableCopyConstructor(cls, true) : undefined;
    const mutableCopy = hasUserCopy ? this.usableCopyConstructor(cls, false) : undefined;
    const copyInto = (frame: Frame, target: CObject, source: CObject, sourceIsConst: boolean): void => {
      target.cls = cls;
      if (hasUserCopy) {
        const copy = sourceIsConst ? constCopy : mutableCopy;
        if (!copy) throw new CppRuntimeError('custom', `${cls.name} のオブジェクトはコピーできません。`);
        this.invokeStoredCopy(frame, copy, source.receiver(cls), target.receiver(cls));
        return;
      }
      const mark = frame.pending.length;
      frame.pending.push(target);
      let isBaseComplete = false;
      try {
        if (base) {
          const baseCopy = base.operations?.copy(frame, source, target, cls.implicitCopyFromConst) as CObject;
          installBaseValue(base, target, baseCopy);
          isBaseComplete = true;
        }
        target.cls = cls;
        for (const field of ownFields) {
          const member = source.values[field.index];
          initializeAt(frame, field.type, target.location(field.index), target.values[field.index], (destination) =>
            this.copyMember(frame, field.type, member, destination, cls.implicitCopyFromConst)
          );
        }
      } catch (error) {
        if (error instanceof CppException) undo(frame, isBaseComplete, target);
        throw error;
      } finally {
        frame.pending.length = mark;
      }
    };
    const assignInto = (frame: Frame, target: CObject, source: CObject): void => {
      if (base) base.operations?.assign(frame, target, source);
      for (const field of ownFields) {
        target.values[field.index] = assignValue(
          frame,
          field.type,
          target.values[field.index],
          source.values[field.index]
        );
      }
    };
    const destroy = this.destructionOf(cls);
    return {
      copyIsNoexcept: constCopy?.isNoexcept === true,
      copy: (frame, source, destination, sourceIsConst = true) => {
        const target = newObject(frame, cls, false, destination);
        copyInto(frame, target, source as CObject, sourceIsConst);
        target.needsConstruction = false;
        return target;
      },
      assign: (frame, target, source) => {
        if (target !== source) assignInto(frame, target as CObject, source as CObject);
      },
      destroy,
    };
  }

  private copyMember(
    frame: Frame,
    type: Type,
    value: Value,
    destination: InitializerTarget | undefined,
    sourceIsConst: boolean
  ): Value {
    if (value === UNINIT) return value;
    if (type.kind === 'class' && type.cls.operations)
      return type.cls.operations.copy(frame, value, asObject(destination), sourceIsConst || isConstType(type));
    if (type.kind !== 'array') return value;
    const fields = (value as ArrayStore).values;
    const destroy = this.destroyerOf(type.of);
    return constructArray(
      frame,
      fields.length,
      type.of,
      (f, target, index) => this.copyMember(f, type.of, fields[index], target, sourceIsConst),
      destroy,
      arrayStorage(destination)
    );
  }

  /** Destroys an object of a class: its destructor's body, then its members, the last first, then its base. */
  private destructionOf(cls: ClassInfo): ((frame: Frame, value: Value) => void) | undefined {
    const members = cls.ownFields
      .map((field) => ({ index: field.index, destroy: this.destroyerOf(field.type) }))
      .toReversed();
    const baseDestroy = cls.base?.operations?.destroy;
    const destructor = cls.destructor;
    const mayOwnReferenceTemporaries = cls.ownFields.some((field) => field.type.kind === 'reference');
    if (!destructor && !members.some((member) => member.destroy) && !baseDestroy && !mayOwnReferenceTemporaries)
      return undefined;
    return (frame, value) => {
      const object = value as CObject;
      if (object.liveness !== Liveness.Alive || object.needsConstruction) return;
      object.cls = cls;
      if (destructor?.compiled) invoke(frame, destructor, [], object.receiver(), undefined as unknown as number);
      for (const { index, destroy } of members) {
        const member = object.values[index];
        if (member !== UNINIT) destroy?.(frame, member);
        endLifetime(member);
      }
      if (baseDestroy) baseDestroy(frame, object);
      object.destroyReferenceTemporaries(frame);
    };
  }

  // Functions -------------------------------------------------------------------------------------------------------

  private functionDefinition(node: Syntax): void {
    // A function returning a pointer or a reference wraps its function declarator (`int& f()`).
    const written = fieldOf(node, 'declarator') as Syntax;
    const declarator = innermostFunctionDeclarator(written);
    if (!declarator) return this.error(node.row, '関数の定義には (...) で引数を書いてください。');
    const inner = fieldOf(declarator, 'declarator') as Syntax;
    if (inner.type === 'qualified_identifier') {
      this.outOfClassDefinition(node, inner);
      return;
    }
    if (!fieldOf(node, 'type')) return this.error(node.row, '関数の戻り値の型を書いてください。');
    const declared = this.applyDeclarator(this.specifiedType(node, true), written);
    const fn = this.declareFunction(node, declared, true);
    this.compileFunction(fn, node);
  }

  private declareFunction(node: Syntax, declared: Declared, isDefinition: boolean): FunctionInfo {
    if (this.hasSpecifier(node, 'virtual') || hasToken(node, 'virtual'))
      this.error(node.row, 'virtual はメンバ関数にしか付けられません。');
    const name = declared.name as string;
    if (name === 'main') this.checkMainSpecifiers(node);
    else if (!isDefinition && this.hasSpecifier(node, 'static'))
      this.unsupported(node.row, 'static の関数（内部結合）');
    const fn = this.functionInfo(name, declared.type, declared.function as Syntax, node, undefined);
    if (name === 'main') {
      if (!sameType(fn.ret, INT)) this.error(node.row, 'main 関数の戻り値の型は int にしてください。');
      this.checkMainParameters(fn);
    }
    const existing = this.globalScope.names.get(name);
    if (existing && existing.kind !== 'functions')
      return this.error(node.row, `${name} はすでに別のものとして宣言されています。`);
    const overloads = existing?.kind === 'functions' ? existing.functions : [];
    let same = overloads.find((other) => sameDeclaredSignature(other, fn));
    if (same?.native) {
      if (!this.library.sameCFunction(fn, same))
        this.error(node.row, `関数 ${name} は、同じ型の引数を取る using 宣言と重複しています。`);
      overloads.splice(overloads.indexOf(same), 1);
      same = undefined;
    }
    if (same) fn.params = mergeDefaults(same.params, fn.params, node.row, (row, message) => this.error(row, message));
    this.checkTrailingDefaults(fn.params);
    this.bindDefaultArguments(fn);
    if (same) {
      this.checkExceptionSpecifier(same, fn, node.row);
      if (!sameType(same.ret, fn.ret))
        this.error(node.row, `関数 ${name} は、戻り値の型だけが違う宣言をすでにされています。`);
      if (isDefinition && same.isDefined) this.error(node.row, `関数 ${name} はすでに定義されています。`);
      if (fn.isInline) same.isInline = true;
      if (isDefinition) {
        same.isDefined = true;
        same.definition = node;
        this.claimAtomic(same, node);
      }
      same.params = fn.params;
      return same;
    }
    if (name === 'main' && overloads.length > 0) this.error(node.row, 'main 関数はオーバーロードできません。');
    if (isDefinition) {
      fn.isDefined = true;
      fn.definition = node;
      this.claimAtomic(fn, node);
    }
    overloads.push(fn);
    if (!existing) this.globalScope.names.set(name, { kind: 'functions', functions: overloads });
    return fn;
  }

  private checkMainSpecifiers(node: Syntax): void {
    const specifier = ['static', 'inline', 'constexpr'].find((word) => this.hasSpecifier(node, word));
    if (specifier) this.error(node.row, `main 関数に ${specifier} は付けられません。`);
  }

  private checkMainParameters(fn: FunctionInfo): void {
    if (fn.params.length === 0) return;
    const [argc, argv] = fn.params;
    const isArgv =
      argv?.type.kind === 'pointer' &&
      argv.type.to.kind === 'pointer' &&
      argv.type.to.to.kind === 'int' &&
      argv.type.to.to.name === 'char';
    if (fn.params.length !== 2 || !sameType(unqualified(argc.type), INT) || !isArgv) {
      this.error(fn.row, 'main 関数の引数は、なしか (int argc, char* argv[]) にしてください。');
    }
  }

  private outOfClassDefinition(node: Syntax, qualified: Syntax): void {
    const scopeNode = fieldOf(qualified, 'scope') as Syntax;
    const scope = this.resolveScope(scopeNode);
    if (scope.kind !== 'class') return this.unsupported(node.row, '名前空間のメンバの定義');
    const cls = scope.cls;
    if (cls.library) return this.error(node.row, `標準ライブラリのクラス ${cls.name} のメンバは定義できません。`);
    const typeNode = fieldOf(node, 'type');
    const ret = typeNode ? this.specifiedType(node, true) : VOID;
    const savedClass = this.memberClass;
    this.memberClass = cls;
    try {
      const declarator = fieldOf(node, 'declarator') as Syntax;
      const nameNode = fieldOf(qualified, 'name') as Syntax;
      this.checkSpecialMemberReturnType(cls, nameNode.text, node);
      const declared = this.applyDeclarator(ret, declarator);
      const probe = this.functionInfo(declared.name ?? '', declared.type, declared.function as Syntax, node, cls);
      let candidates: FunctionInfo[];
      if (nameNode.type === 'destructor_name') candidates = cls.destructor ? [cls.destructor] : [];
      else if (nameNode.text === cls.name && !typeNode) candidates = cls.constructors;
      else candidates = cls.methods.get(nameNode.text) ?? [];
      const fn = candidates.find(
        (candidate) => sameParameters(candidate, probe) && candidate.isConst === probe.isConst
      );
      if (!fn)
        return this.error(
          node.row,
          `${cls.name} に ${qualified.text} という（この引数の）メンバ関数は宣言されていません。`
        );
      if (fn.isDefined) return this.error(node.row, `${fn.displayName} はすでに定義されています。`);
      this.checkExceptionSpecifier(fn, probe, node.row);
      if (typeNode && !sameType(fn.ret, probe.ret))
        return this.error(node.row, `${fn.displayName} の戻り値の型が宣言と違います。`);
      probe.params = mergeDefaults(fn.params, probe.params, node.row, (row, message) => this.error(row, message));
      this.checkTrailingDefaults(probe.params);
      if (fn.isConstructor) {
        if (fn.params.some((param) => !param.defaultValue) && probe.params.every((param) => param.defaultValue))
          this.error(node.row, 'クラスの外で既定値を追加して、既定コンストラクタにすることはできません。');
        if (!isCopyConstructor(fn, cls) && isCopyConstructor(probe, cls))
          this.error(node.row, 'クラスの外で既定値を追加して、コピーコンストラクタにすることはできません。');
      }
      this.bindDefaultArguments(probe);
      fn.isDefined = true;
      fn.definition = node;
      fn.params = probe.params;
      if (probe.isInline) fn.isInline = true;
      this.claimAtomic(fn, node);
      if (cls === fn.owner && fn.isDestructor) {
        cls.operations = {
          ...(cls.operations as NonNullable<ClassInfo['operations']>),
          destroy: this.destructionOf(cls),
        };
      }
      this.compileFunction(fn, node);
    } finally {
      this.memberClass = savedClass;
    }
  }

  private checkExceptionSpecifier(previous: FunctionInfo, declared: FunctionInfo, row: number): void {
    if (!previous.isDestructor && Boolean(previous.isNoexcept) !== Boolean(declared.isNoexcept))
      this.error(row, `${declared.displayName} の noexcept 指定が前の宣言と違います。`);
  }

  private checkSpecialMemberReturnType(cls: ClassInfo, name: string, node: Syntax): void {
    if (name !== cls.name && name !== `~${cls.name}`) return;
    if (
      fieldOf(node, 'type') ||
      node.children.some((child) => child.type === 'type_qualifier' && ['const', 'volatile'].includes(child.text))
    ) {
      this.error(node.row, 'コンストラクタとデストラクタには戻り値の型を書けません。');
    }
  }

  /** Compiles a function's body, binding its parameters to the first slots of its frame. */
  private compileFunction(fn: FunctionInfo, node: Syntax): void {
    if (fn.isInline && fn.name !== 'main') {
      this.inlineDependencies.set(
        fn,
        this.bindDependencies(() => this.compileFunctionBody(fn, node))
      );
      return;
    }
    this.compileFunctionBody(fn, node);
  }

  private compileFunctionBody(fn: FunctionInfo, node: Syntax): void {
    const cls = fn.owner;
    const context = new FunctionContext(fn, cls, fn.isConstructor || fn.isDestructor ? VOID : fn.ret);
    const saved = this.context;
    this.context = context;
    try {
      const scope = context.scope;
      for (const param of fn.params) {
        const type = param.type;
        if (type.kind === 'class' && !type.cls.isComplete)
          this.error(param.row, `クラス ${type.cls.name} はまだ定義されていません。`);
        if (type.kind === 'class' && type.cls.isAbstract) {
          this.error(
            param.row,
            `${type.cls.name} は抽象クラス（純粋仮想関数があるクラス）なので、引数の型にできません。`
          );
        }
        const local = context.declareLocal(param.name ?? `\0param${param.row}`, type, true);
        if (param.name) {
          if (scope.names.has(param.name)) this.error(param.row, `引数 ${param.name} の名前が重複しています。`);
          scope.names.set(param.name, { kind: 'local', local, isReference: type.kind === 'reference' });
        }
      }
      // The grammar gives a constructor's function-try-block no `body` field.
      if (node.children.some((child) => child.type === 'try_statement'))
        return this.unsupported(node.row, '関数の try ブロック');
      const body = fieldOf(node, 'body');
      if (!body) {
        if (node.children.some((child) => child.type === 'default_method_clause'))
          this.unsupported(node.row, '= default');
        return this.error(node.row, `${fn.displayName} の本体を書いてください。`);
      }
      const initializerList = node.children.find((child) => child.type === 'field_initializer_list');
      const memberInit = fn.isConstructor && cls ? this.memberInitialization(cls, fn, initializerList) : undefined;
      if (!fn.isConstructor && initializerList) {
        this.error(node.row, 'メンバの初期化子の並び（: x(...)）は、コンストラクタにしか書けません。');
      }
      const statements = this.compileStatements(body.children);
      context.endBody();
      const undo = fn.isConstructor && cls ? this.constructorBodyFailure(cls, initializerList) : undefined;
      fn.compiled = this.functionBody(fn, context, memberInit, statements, undo);
    } finally {
      this.context = saved;
    }
  }

  /**
   * What an exception from a constructor's body destroys: the object a delegated constructor completed, or else the
   * members and the base.
   */
  private constructorBodyFailure(cls: ClassInfo, initializerList: Syntax | undefined): (frame: Frame) => void {
    const isDelegating = initializerList?.children.some(
      (initializer) => initializer.type === 'field_initializer' && initializer.children[0].text === cls.name
    );
    if (isDelegating) return (frame) => cls.operations?.destroy?.(frame, frame.self?.read() as Value);
    const undo = this.undoConstruction(cls);
    return (frame) => undo(frame, true);
  }

  private functionBody(
    fn: FunctionInfo,
    context: FunctionContext,
    memberInit: Exec | undefined,
    statements: Exec,
    undoConstruction: ((frame: Frame) => void) | undefined
  ): CompiledFunction {
    const scope = context.scope;
    const isMain = fn.name === 'main' && !fn.owner;
    const isVoid = fn.ret.kind === 'void' || fn.isConstructor || fn.isDestructor;
    const body = (frame: Frame): void => {
      let completion;
      let isInitialized = false;
      try {
        if (memberInit) memberInit(frame);
        isInitialized = true;
        completion = statements(frame);
      } catch (error) {
        if (isMain && !(error instanceof ExecutionLimitError)) frame.runtime.onMainEnd?.(frame);
        if (error instanceof CppException) {
          endScope(frame, scope);
          if (isInitialized) undoConstruction?.(frame);
        }
        throw error;
      }
      if (isMain) frame.runtime.onMainEnd?.(frame);
      endScope(frame, scope);
      if (completion !== RETURN) {
        if (isMain) frame.returnValue = 0;
        else if (!isVoid) throw new CppRuntimeError('missingReturn');
      }
    };
    return { slotCount: context.slotCount, locals: context.locals, body };
  }

  // Global variables ------------------------------------------------------------------------------------------------

  private globalDeclaration(node: Syntax): void {
    const typeNode = fieldOf(node, 'type');
    const declarators = fieldsOf(node, 'declarator');
    if (declarators.length === 0) {
      if (typeNode?.type === 'class_specifier' || typeNode?.type === 'struct_specifier') {
        this.classSpecifierType(typeNode);
        return;
      }
      return this.error(node.row, '宣言する名前を書いてください。');
    }
    // The specified type defines the class of `struct P { ... } origin;`.
    const base = this.specifiedType(node, true);
    let firstDeduced: AutoDeduction | undefined;
    for (const written of declarators) {
      const declarator = this.variableOrFunctionDeclarator(base, written);
      const declared = this.applyDeclarator(base, declarator);
      if (declared.function && declarator.type !== 'init_declarator') {
        if (declared.nameNode?.type === 'qualified_identifier')
          this.error(declarator.row, `${declared.nameNode.text} の宣言はクラスの中に書いてください。`);
        this.declareFunction(node, declared, false);
        continue;
      }
      if (declared.nameNode?.type === 'qualified_identifier') {
        this.staticMemberDefinition(declared.nameNode, declared.type, declarator);
        continue;
      }
      const name = declared.name as string;
      const type = this.globalVariable(declarator, name, declared.type, this.isConstexpr(node));
      firstDeduced = this.checkAutoDeduction(
        firstDeduced,
        hasAuto(declared.type) ? { name, type: deducedType(declared.type, type) } : undefined,
        declarator.row
      );
    }
  }

  private staticMemberDefinition(nameNode: Syntax, type: Type, declarator: Syntax): void {
    const scope = this.resolveScope(fieldOf(nameNode, 'scope') as Syntax);
    if (scope.kind !== 'class') return this.unsupported(declarator.row, '名前空間のメンバの定義');
    const name = (fieldOf(nameNode, 'name') as Syntax).text;
    const info = scope.cls.staticFields.get(name);
    if (!info)
      return this.error(declarator.row, `${scope.cls.name} に static のメンバ変数 ${name} は宣言されていません。`);
    if (!sameType(info.type, type)) {
      return this.error(declarator.row, `${scope.cls.name}::${name} の型が宣言と違います。`);
    }
    const global = info.global as GlobalInfo;
    if (global.isDefined) return this.error(declarator.row, `${scope.cls.name}::${name} はすでに定義されています。`);
    global.isDefined = true;
    const value = declarator.type === 'init_declarator' ? fieldOf(declarator, 'value') : undefined;
    const savedClass = this.memberClass;
    this.memberClass = scope.cls;
    try {
      if (value) {
        if (info.constant !== undefined)
          this.error(declarator.row, `${scope.cls.name}::${name} の初期値はクラスの中ですでに指定されています。`);
        info.constant = this.initializeGlobal(global, info.type, value, declarator.row, !hasToken(declarator, '='));
      } else if (info.type.kind === 'reference' || this.isClassType(info.type)) {
        this.initializeGlobal(global, info.type, undefined, declarator.row);
      }
    } finally {
      this.memberClass = savedClass;
    }
  }

  private globalVariable(declarator: Syntax, name: string, declaredType: Type, isConstexpr: boolean): Type {
    if (this.globalScope.names.has(name)) return this.error(declarator.row, `${name} はすでに宣言されています。`);
    const value = declarator.type === 'init_declarator' ? fieldOf(declarator, 'value') : undefined;
    let type = declaredType;
    if (type.kind === 'reference') return this.globalReference(name, type, declarator, isConstexpr);
    if (hasAuto(type))
      type = this.deduceAuto(
        type,
        this.compileExpression(this.autoInitializer(declarator, value, name)),
        declarator.row
      );
    if (type.kind === 'array' && type.length === undefined && value) type = this.completeArrayType(type, value);
    if (type.kind === 'array' && type.length === undefined)
      return this.error(declarator.row, `配列 ${name} の大きさを書いてください。`);
    if (type.kind === 'void') return this.error(declarator.row, `void 型の変数 ${name} は作れません。`);
    const isConstant = isConstType(type) && isArithmetic(type);
    const global = this.declareStaticStorage(name, type, declarator.row, !isConstant);
    global.isDefined = true;
    global.isConstexpr = isConstexpr;
    global.isConstexprPointer = isConstexpr && type.kind === 'pointer';
    const direct = !hasToken(declarator, '=');
    const constant = isConstexpr ? this.requireConstantInitializer(type, value, declarator.row, direct) : undefined;
    const entity: Extract<Entity, { kind: 'global' }> = { kind: 'global', global, isReference: false, constant };
    this.globalScope.names.set(name, entity);
    const initializedConstant = this.initializeGlobal(global, type, value, declarator.row, direct);
    entity.constant ??= initializedConstant;
    return type;
  }

  private globalReference(
    name: string,
    declared: Extract<Type, { kind: 'reference' }>,
    declarator: Syntax,
    isConstexpr: boolean
  ): Type {
    const { row } = declarator;
    const binding = this.bindReference(name, declared, declarator);
    const global = this.declareStaticStorage(name, binding.type, row, true);
    global.isDefined = true;
    this.globalScope.names.set(name, { kind: 'global', global, isReference: true });
    this.initializeFileReference(global, binding, row, isConstexpr);
    return binding.type;
  }

  private initializeFileReference(
    global: GlobalInfo,
    binding: ReferenceBinding,
    row: number,
    isConstexpr: boolean
  ): void {
    if (isConstexpr && !binding.isConstant) this.error(row, 'constexpr の変数の初期値には定数式を書いてください。');
    global.hasStaticReferenceBinding = binding.isConstant;
    global.constantLocation = binding.isConstant ? binding.constantLocation : undefined;
    const reference = this.constantReference(binding, true);
    global.referentConstant = reference?.value;
    global.foldedValue = reference?.foldedValue;
    const initializers = binding.isConstant ? this.constantInitializers : this.dynamicInitializers;
    initializers.push(this.staticReferenceInitializer(global, binding, row, true));
  }

  staticReferenceInitializer(
    global: GlobalInfo,
    binding: ReferenceBinding,
    row: number,
    fileScope = false
  ): Eval<undefined> {
    let locate: Eval<Ptr>;
    if ('lifetime' in binding) {
      const holder = this.declareStaticStorage(`\0${global.name}`, VOID, row, false);
      const registerDuringStartup = fileScope && binding.isConstant;
      if (registerDuringStartup) {
        this.dynamicInitializers.push((frame) => {
          registerStaticTemporary(frame, frame.runtime.globals[holder.index] as Box);
          return;
        });
      }
      locate = (frame) => {
        const box = frame.runtime.globals[holder.index] as Box;
        return bindRetainedTemporary(
          frame,
          binding.lifetime,
          (temporary) => {
            box.value = new RetainedTemporary(temporary);
            if (!registerDuringStartup) registerStaticTemporary(frame, box);
          },
          true
        );
      };
    } else {
      locate = binding.loc;
    }
    const run = this.fullExpression(locate);
    return (frame) => {
      const box = frame.runtime.globals[global.index] as Box;
      if (!(box.value instanceof Ptr)) box.value = run(frame);
      return;
    };
  }

  declareStaticStorage(name: string, type: Type, row: number, isShown: boolean): GlobalInfo {
    const global: GlobalInfo = { name, type, index: this.globals.length, row, isDefined: false, isShown };
    this.globals.push(global);
    this.globalTypes.push(type);
    return global;
  }

  /**
   * Initializes a variable with static storage duration before `main`. A constant initializer records no step, as
   * learners see the value from the start; any other records one.
   */
  private initializeGlobal(
    global: GlobalInfo,
    type: Type,
    value: Syntax | undefined,
    row: number,
    direct = false,
    isConstexpr = false
  ): number | bigint | undefined {
    const saved = this.context;
    this.context = new FunctionContext(undefined, this.memberClass, VOID);
    try {
      if (type.kind === 'reference') {
        const binding = this.bindReferenceValue(global.name, type, value, row, direct);
        this.initializeFileReference(global, binding, row, isConstexpr);
        return;
      }
      const init = this.staticInitialization(type, value, row, direct);
      if (!init) return;
      global.foldedValue = this.initializerFoldedValue(type, init.run);
      if ((type.kind === 'class' || type.kind === 'array') && isConstType(type))
        global.hasConstantObjectValue = init.isConstant;
      if (global.isConstexprPointer && init.isConstant) global.constantPointee = init.run.constantPointee;
      if (global.isConstexprPointer && !init.isConstant)
        this.error(row, 'constexpr の変数の初期値には定数式を書いてください。');
      const { index } = global;
      const register = this.staticRegistration(type, row);
      const execute = this.fullExpression<undefined>((frame) => {
        const box = frame.runtime.globals[index] as Box;
        initializeAt(frame, type, box.location(0), box.value, (target) => init.run(frame, target, true));
        if (!init.isConstant) register?.(frame, box);
        return;
      });
      if (init.isConstant) {
        this.constantInitializers.push(execute);
        if (register) {
          this.dynamicInitializers.push((frame) => {
            register(frame, frame.runtime.globals[index] as Box);
            return;
          });
        }
      } else this.dynamicInitializers.push(this.withStep(row, execute, init.isCreation));
      return init.constant;
    } finally {
      this.context = saved;
    }
  }

  /** The initialization of a variable with static storage duration, or undefined when zero-initialization suffices. */
  private staticInitialization(
    type: Type,
    value: Syntax | undefined,
    row: number,
    direct: boolean
  ): { run: Initializer; isConstant: boolean; isCreation: boolean; constant?: number | bigint } | undefined {
    let run: Initializer;
    const createsClass = type.kind === 'class' && !type.cls.library;
    let isCreation = false;
    if (!value) {
      if (!this.isClassType(type)) {
        this.checkConstDefault(type, row);
        return undefined;
      }
      run = this.defaultInitializer(type, row);
      isCreation = true;
    } else if (value.type === 'initializer_list') {
      run = this.listInitializer(type, value, row, direct);
      isCreation = createsClass || isObjectCreation(value);
    } else if (value.type === 'argument_list') {
      const args = value.children.map((arg) => this.argument(arg));
      if (type.kind === 'class') {
        run = this.objectInitializer(this.constructObject(type.cls, args, row, false));
        isCreation = createsClass;
      } else {
        if (args.length !== 1) return this.error(row, '初期値には値を1つだけ書いてください。');
        run = this.copyInitializer(type, this.directInitializerArgument(type, args[0]), row, false);
      }
    } else {
      const expr = this.compileExpression(value);
      run = this.copyInitializer(type, expr, row, false);
      isCreation =
        (createsClass && expr.isTemporaryObject === true && value.type !== 'call_expression') ||
        isObjectCreation(value);
    }
    return { run, isConstant: run.isConstant === true, isCreation, constant: this.initializerConstant(type, run) };
  }

  staticInitializer(
    global: GlobalInfo,
    type: Type,
    value: Syntax | undefined,
    row: number,
    direct = false
  ): { run: Eval<void>; isCreation: boolean; constant?: number | bigint } {
    const init = this.staticInitialization(type, value, row, direct);
    const { index } = global;
    if (!init) return { run: () => {}, isCreation: false };
    global.foldedValue = this.initializerFoldedValue(type, init.run);
    if ((type.kind === 'class' || type.kind === 'array') && isConstType(type))
      global.hasConstantObjectValue = init.isConstant;
    const register = this.staticRegistration(type, row);
    const initialize = this.fullExpression<undefined>((frame) => {
      const box = frame.runtime.globals[index] as Box;
      initializeAt(frame, type, box.location(0), box.value, (target) => init.run(frame, target, true));
      return;
    });
    if (init.isConstant) {
      this.constantInitializers.push(initialize);
      if (!register) return { run: () => {}, isCreation: init.isCreation, constant: init.constant };
    }
    const initialized = new WeakSet<Box>();
    return {
      isCreation: init.isCreation,
      constant: init.constant,
      run: (frame) => {
        const box = frame.runtime.globals[index] as Box;
        if (initialized.has(box)) return;
        if (!init.isConstant) initialize(frame);
        register?.(frame, box);
        initialized.add(box);
      },
    };
  }

  private staticRegistration(type: Type, row: number): ((frame: Frame, box: Box) => void) | undefined {
    const destroy = this.destroyerOf(type, row);
    if (!destroy) return;
    return (frame, box) => {
      frame.runtime.staticObjects.push({ box, destroy });
    };
  }

  // Initialization ---------------------------------------------------------------------------------------------------

  copyInitializer(type: Type, expr: Expr, row: number, isList: boolean): Initializer {
    if (type.kind === 'array') {
      if (expr.literalBytes !== undefined && isCharacterArray(type))
        return initializerWithConstancy(this.charArrayFromLiteral(type, expr.literalBytes, row), true);
      return this.error(row, `配列は ${typeName(expr.type)} 型の値では初期化できません。{...} を使ってください。`);
    }
    if (isList) this.checkNarrowing(expr, type, row);
    if (
      type.kind === 'class' &&
      expr.type.kind === 'class' &&
      expr.type.cls === type.cls &&
      expr.isTemporaryObject &&
      !expr.isLvalue
    )
      return this.objectInitializer(expr);
    const converted = this.convert(expr, unqualified(type), row);
    return type.kind === 'class'
      ? this.objectInitializer(converted)
      : initializerWithConstancy(converted.run as Eval<Value>, this.isConstantInitializer(converted), {
          memberConstant: memberConstantOf(converted),
          foldedValue: converted.foldedValue,
          constantPointee: converted.constantPointee,
        });
  }

  private objectInitializer(expr: Expr): Initializer {
    return initializerWithConstancy(
      (frame, target, zeroInitialize, referenceLifetime) =>
        expr.run(frame, zeroInitialize, asObject(target), referenceLifetime),
      expr.constantInitialization === true,
      expr
    );
  }

  private charArrayFromLiteral(type: Extract<Type, { kind: 'array' }>, bytes: string, row: number): Initializer {
    const length = type.length ?? bytes.length + 1;
    // Unlike C, C++ needs room for the terminating null character (C++20 [dcl.init.string]).
    if (bytes.length + 1 > length)
      this.error(row, `文字列リテラル（${bytes.length + 1} バイト）が、配列（${length} 要素）に収まりません。`);
    const signed = type.of.kind === 'int' && type.of.name !== 'uchar';
    return (frame, target) => {
      if (!target) frame.runtime.reserve(length);
      const storage = arrayStorage(target) ?? new ArrayStore([], type.of);
      for (let index = 0; index < length; index++) storage.values[index] = characterValue(bytes, index, signed);
      return storage;
    };
  }

  /** Stops at a narrowing conversion in list-initialization (C++20 [dcl.init.list]). */
  private checkNarrowing(expr: Expr, type: Type, row: number): void {
    const value = this.rvalue(expr);
    const from = value.type;
    const to = unqualified(type);
    const narrowing =
      from.kind === 'pointer'
        ? to.kind === 'int' && to.name === 'bool'
        : isArithmetic(from) && isArithmetic(to) && isNarrowing(from, to, value.constant);
    if (narrowing) {
      throw new NarrowingConversionError([
        {
          row,
          message: `{...} の中では、${typeName(from)} 型の値を ${typeName(type)} 型に縮めて変換できません（縮小変換）。`,
        },
      ]);
    }
  }

  defaultInitializer(type: Type, row: number): Initializer {
    this.checkConstDefault(type, row);
    if (type.kind === 'class') return this.objectInitializer(this.defaultConstructed(type.cls, row, false));
    if (type.kind === 'array') {
      const length = type.length ?? 0;
      const element = this.defaultInitializer(type.of, row);
      const destroy = this.destroyerOf(type.of);
      if (type.of.kind !== 'array' && type.of.kind !== 'class')
        return (frame, target, zeroInitialize) =>
          arrayStorage(target) ??
          constructArray(frame, length, type.of, (f) => element(f, undefined, zeroInitialize), destroy);
      return (frame, target, zeroInitialize, referenceLifetime) =>
        constructArray(
          frame,
          length,
          type.of,
          (f, storage) => element(f, storage, zeroInitialize, referenceLifetime),
          destroy,
          arrayStorage(target)
        );
    }
    return (_frame, _target, zeroInitialize) => (zeroInitialize ? zeroOf(type) : UNINIT);
  }

  /** Stops at the default-initialization of a const object that nothing would give a value (C++20 [dcl.init]p7). */
  private checkConstDefault(type: Type, row: number): void {
    if (isConstType(type) && !isConstDefaultConstructible(type))
      this.error(row, `${typeName(type)} 型の値には初期値を書いてください（const の値は、あとから変えられません）。`);
  }

  defaultConstructed(cls: ClassInfo, row: number, isValueInitialized: boolean, allowsExplicit = true): Expr {
    if (!cls.isComplete) return this.error(row, `クラス ${cls.name} はまだ定義されていません。`);
    this.checkLibraryLayout(classType(cls), row);
    if (cls.isAbstract)
      return this.error(row, `${cls.name} は抽象クラス（純粋仮想関数があるクラス）なので、オブジェクトを作れません。`);
    const libraryDefault = cls.library?.defaultInitializer;
    if (libraryDefault) {
      return {
        type: classType(cls),
        isLvalue: false,
        isTemporaryObject: true,
        row,
        run: libraryDefault(this, row, isValueInitialized),
      };
    }
    if (cls.constructors.length > 0) {
      const resolved = this.resolve(`${cls.name} のコンストラクタ`, cls.constructors, [], undefined, row);
      this.checkListConstructor(resolved.fn, allowsExplicit, row);
      return this.constructWith(cls, resolved, [], row);
    }
    this.requireVirtualDefinitions(cls, row);
    if (cls.isDefaultConstructorDeleted) return this.error(row, deletedDefaultMessage(cls));
    const implicit = this.implicitDefaults.get(cls)?.();
    return {
      type: classType(cls),
      isLvalue: false,
      row,
      isTemporaryObject: true,
      onlyCalls: true,
      run: (frame, zeroInitialize, destination) => {
        const object = newObject(frame, cls, isValueInitialized || zeroInitialize, destination);
        if (implicit) invoke(frame, implicit, [], object.receiver(), row);
        else object.cls = cls;
        object.needsConstruction = false;
        return object;
      },
    };
  }

  listInitializer(type: Type, list: Syntax, row: number, direct = false): Initializer {
    return this.initializeList(type, list.children, row, direct);
  }

  protected initializeList(type: Type, elements: readonly Syntax[], row: number, direct = false): Initializer {
    if (type.kind === 'reference') return this.error(row, '参照は {...} で初期化できません。');
    if (type.kind === 'array') return this.arrayInitializer(type, elements, row);
    if (type.kind === 'class') return this.initializeClassList(type, elements, row, direct);
    if (elements.length === 0) {
      const zero = zeroOf(type);
      return initializerWithConstancy(() => zero, true, {
        memberConstant: typeof zero === 'number' || typeof zero === 'bigint' ? () => zero : undefined,
      });
    }
    if (elements.length > 1)
      return this.error(row, `${typeName(type)} 型の値を初期化する {...} には、値を1つだけ書いてください。`);
    if (elements[0].type === 'initializer_list')
      return this.error(row, `${typeName(type)} 型の値は、入れ子の {...} では初期化できません。`);
    const expr = this.compileExpression(elements[0]);
    return this.copyInitializer(type, direct ? this.directInitializerArgument(type, expr) : expr, row, true);
  }

  private initializeClassList(
    type: Extract<Type, { kind: 'class' }>,
    elements: readonly Syntax[],
    row: number,
    direct: boolean
  ): Initializer {
    if (!type.cls.isComplete && type.cls.library)
      return this.error(row, `クラス ${type.cls.name} はまだ定義されていません。`);
    const library = type.cls.library;
    this.checkLibraryLayout(type, row);
    if (!this.isUnevaluated) this.checkLibraryStorage(type.cls, row);
    const isAggregate = this.isAggregate(type.cls);
    const single =
      elements.length === 1 && elements[0].type !== 'initializer_list'
        ? this.compileExpression(elements[0])
        : undefined;
    const copy = single?.type.kind === 'class' && single.type.cls.isDerivedFrom(type.cls) ? single : undefined;
    if (copy && (isAggregate || library?.aggregateArray)) return this.copyInitializer(type, copy, row, false);
    if (library?.aggregateArray) {
      const clauses: Clauses = { nodes: elements, next: 0, compiled: new Map() };
      const run = this.takeLibraryArrayClauses(library.aggregateArray, clauses, row)();
      if (clauses.next < elements.length)
        return this.error(row, `${type.cls.name} を初期化する {...} の値が多すぎます。`);
      return run;
    }
    if (
      library?.listInitializer &&
      (!copy || (library.listElementType && implicitConversion(this, copy, library.listElementType)))
    ) {
      const run = library.listInitializer(this, elements, row);
      if (run) return run;
    }
    if (copy && library) return this.copyInitializer(type, copy, row, false);
    if (isAggregate) return this.aggregateInitializer(type.cls, elements, row);
    if (elements.length === 0) return this.objectInitializer(this.defaultConstructed(type.cls, row, true, direct));
    const args = single ? [single] : elements.map((element) => this.argument(element));
    const resolved = this.resolveConstructor(type.cls, args, row, true);
    this.checkListConstructor(resolved.fn, direct, row);
    return this.objectInitializer(this.constructWith(type.cls, resolved, args, row));
  }

  private checkListConstructor(constructor: FunctionInfo, allowsExplicit: boolean, row: number): void {
    if (!allowsExplicit && constructor.isExplicit)
      this.error(row, `${constructor.displayName} は explicit なので、変換には使えません。`);
  }

  private resolveConstructor(cls: ClassInfo, args: Expr[], row: number, isList: boolean): Resolved {
    const resolved = this.resolve(`${cls.name} のコンストラクタ`, cls.constructors, args, undefined, row);
    if (isList) {
      for (const [index, arg] of args.entries()) {
        const param = resolved.fn.params[index];
        if (param && !arg.braced)
          this.checkNarrowing(arg, param.type.kind === 'reference' ? param.type.to : param.type, arg.row);
      }
    }
    return resolved;
  }

  /** Whether a class is an aggregate, which braces initialize member by member (C++20 [dcl.init.aggr]). */
  private isAggregate(cls: ClassInfo): boolean {
    if (cls.library || cls.constructors.length > 0 || cls.isPolymorphic) return false;
    if (cls.base && cls.baseAccess !== 'public') return false;
    return cls.ownFields.every((field) => field.access === 'public');
  }

  private aggregateInitializer(cls: ClassInfo, elements: readonly Syntax[], row: number): Initializer {
    const clauses: Clauses = { nodes: elements, next: 0, compiled: new Map() };
    const run = this.takeMemberClauses(cls, clauses, row)();
    if (clauses.next < elements.length) return this.error(row, `${cls.name} を初期化する {...} の値が多すぎます。`);
    return run;
  }

  protected parenthesizedAggregate(cls: ClassInfo, args: Expr[], row: number): Expr | undefined {
    if (!this.isAggregate(cls)) return;
    const types = this.aggregateElementTypes(cls);
    if (args.length > types.length) return this.error(row, `${cls.name} を初期化する値が多すぎます。`);
    const initializers = args.map((arg, index) => {
      const type = types[index];
      if (arg.braced && type.kind === 'array') return this.listInitializer(type, arg.braced, arg.row);
      return this.copyInitializer(type, arg, row, false);
    });
    const initialize = this.initializeAggregate(cls, initializers, row);
    return {
      type: classType(cls),
      isLvalue: false,
      isTemporaryObject: true,
      row,
      run: (frame, zeroInitialize, destination) => initialize(frame, destination, zeroInitialize, 'full-expression'),
    };
  }

  private aggregateElementTypes(cls: ClassInfo): Type[] {
    const members = cls.ownFields.map((field) => field.type);
    return cls.base ? [classType(cls.base), ...members] : members;
  }

  private arrayInitializer(
    type: Extract<Type, { kind: 'array' }>,
    elements: readonly Syntax[],
    row: number
  ): Initializer {
    const literal = this.bracedStringLiteral(type, elements);
    if (literal) return this.copyInitializer(type, literal, row, false);
    const clauses: Clauses = { nodes: elements, next: 0, compiled: new Map() };
    const run = this.takeArrayClauses(type, clauses, row)();
    if (clauses.next < elements.length)
      return this.error(row, `配列の要素は ${type.length} 個なので、初期値が多すぎます。`);
    return run;
  }

  bracedArrayLength(type: Extract<Type, { kind: 'array' }>, list: Syntax): number {
    const elements = list.children;
    const literal = this.bracedStringLiteral(type, elements);
    if (literal) return (literal.literalBytes as string).length + 1;
    const clauses: Clauses = { nodes: elements, next: 0, compiled: new Map() };
    return this.takeArrayElements(type.of, Infinity, clauses, list.row).length;
  }

  protected bracedArrayInitializers(element: Type, list: Syntax): Initializer[] {
    const literal = this.bracedStringLiteral({ kind: 'array', of: element }, list.children);
    const bytes = literal?.literalBytes;
    if (bytes !== undefined) {
      const signed = element.kind === 'int' && element.name !== 'uchar';
      return Array.from({ length: bytes.length + 1 }, (_, index) => {
        const value = characterValue(bytes, index, signed);
        return () => value;
      });
    }
    const clauses: Clauses = { nodes: list.children, next: 0, compiled: new Map() };
    return this.takeArrayElements(element, Infinity, clauses, list.row).map((take) => take());
  }

  /** The string literal that initializes a character array in braces (`char s[4] = {"abc"}`, C++20 [dcl.init.string]). */
  private bracedStringLiteral(type: Extract<Type, { kind: 'array' }>, elements: readonly Syntax[]): Expr | undefined {
    if (elements.length !== 1 || (elements[0].type !== 'string_literal' && elements[0].type !== 'concatenated_string'))
      return undefined;
    const literal = this.compileExpression(elements[0]);
    return literal.literalBytes !== undefined && isCharacterArray(type) ? literal : undefined;
  }

  /**
   * Takes the clauses of a braced list that initialize an object: the next one, or, when that one is no braced list
   * and cannot initialize the object, which is an array or an aggregate, as many as its elements take, as if braces
   * enclosed them (brace elision, C++20 [dcl.init.aggr]). Compiling the initializer waits for the returned function,
   * so that counting the clauses compiles none.
   */
  private takeClauses(type: Type, clauses: Clauses, row: number): () => Initializer {
    const start = clauses.next;
    const initialize = this.consumeClause(type, clauses, row);
    if (clauses.next === start)
      this.error(clauses.nodes[start].row, `${typeName(type)} の空の集成体の初期値には {} を書いてください。`);
    return initialize;
  }

  private consumeClause(type: Type, clauses: Clauses, row: number): () => Initializer {
    const node = clauses.nodes[clauses.next];
    if (node.type !== 'initializer_list' && (type.kind === 'array' || type.kind === 'class')) {
      const expr = this.clauseExpression(node, clauses);
      if (type.kind === 'array' && !(expr.literalBytes !== undefined && isCharacterArray(type)))
        return this.takeArrayClauses(type, clauses, row);
      const isOwnClass = expr.type.kind === 'class' && type.kind === 'class' && expr.type.cls.isDerivedFrom(type.cls);
      if (type.kind === 'class' && !isOwnClass) {
        if (type.cls.library?.aggregateArray)
          return this.takeLibraryArrayClauses(type.cls.library.aggregateArray, clauses, row);
        if (this.isAggregate(type.cls)) return this.takeMemberClauses(type.cls, clauses, row);
      }
    }
    clauses.next++;
    if (type.kind === 'reference') return () => this.memberReference(type, this.argument(node), node.row);
    if (node.type === 'initializer_list') return () => this.listInitializer(type, node, node.row);
    const expr = this.clauseExpression(node, clauses);
    return () => this.copyInitializer(type, expr, node.row, true);
  }

  /** Binds a reference member of an aggregate, whose lifetime a temporary it binds to takes (C++20 [class.temporary]). */
  private memberReference(
    type: Extract<Type, { kind: 'reference' }>,
    expr: Expr,
    row: number,
    { hasDefault = false, direct = false } = {}
  ): Initializer {
    const binding = this.referenceBinding(type, this.referenceMemberTarget(type, expr, row, direct), row);
    if (!('lifetime' in binding))
      return initializerWithConstancy(
        hasDefault ? this.fullExpression(binding.loc) : binding.loc,
        binding.isConstant === true,
        binding
      );
    return initializerWithConstancy(
      (frame, _target, _zeroInitialize, owner) =>
        bindRetainedTemporary(
          frame,
          binding.lifetime,
          (temporary) => {
            if (owner instanceof CObject) (owner.referenceTemporaries ??= []).push(temporary);
            else frame.temporaries.push(temporary);
          },
          hasDefault
        ),
      binding.isConstant === true,
      binding
    );
  }

  private referenceMemberTarget(
    type: Extract<Type, { kind: 'reference' }>,
    expr: Expr,
    row: number,
    direct: boolean
  ): Expr {
    if (!expr.braced) return expr;
    return (
      this.listReferenceValue(expr.braced, type.to, direct) ??
      this.error(row, '参照メンバを {...} の値に束縛できません。')
    );
  }

  private clauseExpression(node: Syntax, clauses: Clauses): Expr {
    let expr = clauses.compiled.get(node);
    if (!expr) {
      expr = this.compileExpression(node);
      clauses.compiled.set(node, expr);
    }
    return expr;
  }

  private takeLibraryArrayClauses(
    array: NonNullable<NonNullable<ClassInfo['library']>['aggregateArray']>,
    clauses: Clauses,
    row: number
  ): () => Initializer {
    const take = this.takeClausesForArrayMember(array.type, clauses, row);
    return () => {
      const initialize = take();
      return initializerWithConstancy(
        (frame, _target, zeroInitialize, referenceLifetime) =>
          array.make(initialize(frame, undefined, zeroInitialize, referenceLifetime) as ArrayStore),
        initialize.isConstant === true
      );
    };
  }

  private takeClausesForArrayMember(
    type: Extract<Type, { kind: 'array' }>,
    clauses: Clauses,
    row: number
  ): () => Initializer {
    if (clauses.next === clauses.nodes.length) return this.takeArrayClauses(type, clauses, row);
    if (type.length === 0 && clauses.nodes[clauses.next].type !== 'initializer_list')
      return this.error(row, '要素がない std::array に値は書けません。');
    return this.takeClauses(type, clauses, row);
  }

  private takeArrayClauses(type: Extract<Type, { kind: 'array' }>, clauses: Clauses, row: number): () => Initializer {
    const taken = this.takeArrayElements(type.of, type.length ?? Infinity, clauses, row);
    return () => {
      const length = type.length ?? taken.length;
      const inits = taken.map((take) => take());
      const elementType = type.of;
      const rest = inits.length === length ? undefined : this.initializeList(elementType, [], row);
      const destroy = this.destroyerOf(elementType);
      return initializerWithConstancy(
        (frame, target, zeroInitialize, referenceLifetime) =>
          constructArray(
            frame,
            length,
            elementType,
            (f, storage, index) => {
              const init = inits[index];
              return init
                ? init(f, storage, zeroInitialize, referenceLifetime)
                : withTemporaries(f, (elementFrame) =>
                    (rest as Initializer)(elementFrame, storage, zeroInitialize, 'full-expression')
                  );
            },
            destroy,
            arrayStorage(target)
          ),
        inits.every((init) => init.isConstant) && (!rest || rest.isConstant === true)
      );
    };
  }

  private takeArrayElements(element: Type, limit: number, clauses: Clauses, row: number): (() => Initializer)[] {
    const taken: (() => Initializer)[] = [];
    while (taken.length < limit && clauses.next < clauses.nodes.length)
      taken.push(this.takeClauses(element, clauses, row));
    return taken;
  }

  private takeMemberClauses(cls: ClassInfo, clauses: Clauses, row: number): () => Initializer {
    const taken = this.aggregateElementTypes(cls).map((type) =>
      clauses.next < clauses.nodes.length ? this.takeClauses(type, clauses, row) : undefined
    );
    return () =>
      this.initializeAggregate(
        cls,
        taken.map((take) => take?.()),
        row
      );
  }

  private initializeAggregate(cls: ClassInfo, elements: (Initializer | undefined)[], row: number): Initializer {
    const fields = cls.ownFields;
    const base = cls.base;
    const initializeBase = base && (elements[0] ?? this.initializeList(classType(base), [], row));
    const destroyBase = base && this.destroyerOf(classType(base), row);
    const supplied = base ? elements.slice(1) : elements;
    const defaults = fields.map((field, index) =>
      supplied[index] ? undefined : (this.aggregateDefaults.get(field)?.() ?? this.bindAggregateDefault(field, row))
    );
    const destroyers = fields.map((field) => this.destroyerOf(field.type));
    const isConstant =
      (!initializeBase || initializeBase.isConstant === true) && this.constantAggregate(fields, supplied, defaults);
    return initializerWithConstancy((frame, target, zeroInitialize, referenceLifetime) => {
      const object = newObject(frame, cls, zeroInitialize, asObject(target));
      const owner = referenceLifetime === 'full-expression' ? referenceLifetime : object;
      const receiver = object.receiver();
      const mark = frame.pending.length;
      frame.pending.push(object);
      let baseComplete = false;
      try {
        if (base && initializeBase) {
          object.cls = base;
          const initialized = initializeBase(frame, object, zeroInitialize, owner) as CObject;
          installBaseValue(base, object, initialized);
          baseComplete = true;
        }
        object.cls = cls;
        makeEach(
          frame,
          fields.length,
          (index) => {
            const init = supplied[index];
            const field = fields[index];
            return initializeAt(
              frame,
              field.type,
              object.location(field.index),
              object.values[field.index],
              (target) =>
                init
                  ? init(frame, target, zeroInitialize, owner)
                  : frame.runtime.withReceiver(frame, receiver, (f) =>
                      (defaults[index] as Initializer)(f, target, zeroInitialize, owner)
                    )
            );
          },
          (index) => destroyers[index]
        );
        object.needsConstruction = false;
        return object;
      } catch (error) {
        if (error instanceof CppException) {
          if (base && baseComplete) {
            object.cls = base;
            destroyBase?.(frame, object);
          }
          object.destroyReferenceTemporaries(frame);
        }
        endLifetime(object);
        throw error;
      } finally {
        frame.pending.length = mark;
      }
    }, isConstant);
  }

  private constantAggregate(
    fields: FieldInfo[],
    supplied: (Initializer | undefined)[],
    defaults: (Initializer | undefined)[]
  ): boolean {
    const known = new Map<FieldInfo, number | bigint>();
    try {
      return fields.every((field, index) => {
        const init = (supplied[index] ?? defaults[index]) as Initializer;
        const value = init.memberConstant?.(supplied[index] ? NO_CONSTANT_MEMBERS : known);
        if (value !== undefined) known.set(field, value);
        return init.isConstant === true || value !== undefined;
      });
    } catch (error) {
      if (error instanceof CRuntimeError || error instanceof CppRuntimeError) return false;
      throw error;
    }
  }

  private bindAggregateDefault(field: FieldInfo, row: number): Initializer {
    const node = field.initializer;
    if (!node) {
      if (field.type.kind === 'reference') return this.error(row, `参照のメンバ ${field.name} に初期値がありません。`);
      return this.initializeList(field.type, [], row);
    }
    const previous = this.context;
    this.context = new FunctionContext(undefined, field.owner, VOID);
    try {
      if (field.type.kind === 'reference')
        return this.memberReference(field.type, this.argument(node), node.row, {
          hasDefault: true,
          direct: field.directInitializer,
        });
      const initialize =
        node.type === 'initializer_list'
          ? this.listInitializer(field.type, node, node.row, field.directInitializer)
          : this.copyInitializer(field.type, this.compileExpression(node), node.row, false);
      return initializerWithConstancy(
        (frame, target, zeroInitialize, referenceLifetime) =>
          withTemporaries(frame, (f) => initialize(f, target, zeroInitialize, referenceLifetime)),
        initialize.isConstant === true,
        initialize
      );
    } finally {
      this.context = previous;
    }
  }

  // Names -------------------------------------------------------------------------------------------------------------

  protected withArgumentDependentLookup(name: string, functions: FunctionInfo[], args: Expr[]): FunctionInfo[] {
    if (!args.some((arg) => this.library.isStdType(arg.type))) return functions;
    const found = this.findStdName(name);
    if (found?.kind !== 'functions') return functions;
    return [...new Set([...functions, ...found.functions])];
  }

  checkDefined(fn: FunctionInfo, row: number): void {
    if (this.isUnevaluated) return;
    if (fn.native) {
      if (fn.isConstructor && fn.owner) this.checkLibraryStorage(fn.owner, row);
      fn.nativeUses?.(row);
      return;
    }
    const functions = this.defaultDependencies?.functions ?? this.usedFunctions;
    if (!functions.has(fn)) functions.set(fn, row);
  }

  protected checkWhenUsed(check: () => void): void {
    const checks = this.defaultDependencies?.checks ?? this.pendingObjectUses;
    if (checks) checks.push(check);
    else check();
  }

  protected requireStaticDefinition(global: GlobalInfo, row: number): void {
    if (this.isUnevaluated) return;
    const members = this.defaultDependencies?.staticMembers ?? this.usedStaticMembers;
    if (!members.has(global)) members.set(global, row);
  }

  private bindDefaultArguments(fn: FunctionInfo): void {
    const previous = this.context;
    this.context = new FunctionContext(undefined, undefined, VOID);
    const { names } = this.context.scope;
    try {
      for (const param of fn.params) {
        if (param.name) {
          if (names.has(param.name)) this.error(param.row, `引数 ${param.name} の名前が重複しています。`);
          names.set(param.name, {
            kind: 'value',
            make: (row) => {
              if (!this.isUnevaluated) return this.error(row, `引数の既定値は、引数 ${param.name} の値を使えません。`);
              return { type: nonReference(param.type), isLvalue: true, row, run: () => UNINIT };
            },
          });
        }
        const value = param.defaultValue;
        if (!value || value.use) continue;
        value.use = this.bindDependencies(() => {
          const expr = this.argument(value.node);
          return this.convert(expr, param.type, value.node.row, '引数の既定値').run;
        });
      }
    } finally {
      this.context = previous;
    }
  }

  private checkTrailingDefaults(params: ParamInfo[]): void {
    let seenDefault = false;
    for (const param of params) {
      if (param.defaultValue) seenDefault = true;
      else if (seenDefault) this.error(param.row, '引数の既定値は、後ろの引数から順に付けてください。');
    }
  }

  private bindDependencies<T>(compile: () => T): () => T {
    const dependencies = {
      functions: new Map<FunctionInfo, number>(),
      staticMembers: new Map<GlobalInfo, number>(),
      checks: [] as (() => void)[],
    };
    const previous = this.defaultDependencies;
    this.defaultDependencies = dependencies;
    try {
      const bound = compile();
      return () => {
        for (const [fn, row] of dependencies.functions) this.checkDefined(fn, row);
        for (const [member, row] of dependencies.staticMembers) this.requireStaticDefinition(member, row);
        for (const check of dependencies.checks) this.checkWhenUsed(check);
        return bound;
      };
    } finally {
      this.defaultDependencies = previous;
    }
  }

  protected arrayLength(size: Syntax): number {
    const expr = this.rvalue(this.compileExpression(size));
    if (!isInteger(expr.type))
      return this.error(size.row, `配列の大きさには整数を書いてください（${typeName(expr.type)}）。`);
    if (expr.constant === undefined) {
      return this.unsupported(size.row, '大きさが定数でない配列（可変長配列）');
    }
    const length = Number(expr.constant);
    if (length < 0) return this.error(size.row, '配列の大きさは負にできません。');
    if (!Number.isSafeInteger(length)) return this.error(size.row, '配列の大きさが大きすぎます。');
    return length;
  }
}

class TemporaryConstructorReferenceError extends CompileError {}

function sameDeclaredSignature(a: FunctionInfo, b: FunctionInfo): boolean {
  return !a.instantiate && !b.instantiate && sameParameters(a, b);
}

function registerStaticTemporary(frame: Frame, box: Box): void {
  frame.runtime.staticObjects.push({ box, destroy: destroyRetainedTemporary });
}

function asObject(value: InitializerTarget | undefined): CObject | undefined {
  return value instanceof CObject ? value : undefined;
}

function arrayStorage(value: Value): ArrayStore | undefined {
  return value instanceof ArrayStore ? value : undefined;
}

/** The initializer-clauses of a braced list, which the elements of an aggregate take in order. */
interface Clauses {
  readonly nodes: readonly Syntax[];
  next: number;
  /** The clauses compiled to see whether they initialize an element whose braces may be left out. */
  readonly compiled: Map<Syntax, Expr>;
}

/** Whether an array's elements are characters, which a string literal can initialize. */
function isCharacterArray(type: Extract<Type, { kind: 'array' }>): boolean {
  const element = type.of;
  return element.kind === 'int' && (element.name === 'char' || element.name === 'schar' || element.name === 'uchar');
}

function characterValue(bytes: string, index: number, signed: boolean): number {
  const byte = index < bytes.length ? byteAt(bytes, index) : 0;
  return signed && byte >= 128 ? byte - 256 : byte;
}

function mergeDefaults(
  declared: ParamInfo[],
  defined: ParamInfo[],
  row: number,
  error: (row: number, message: string) => never
): ParamInfo[] {
  return declared.map((param, index) => {
    const other = defined[index];
    if (param.defaultValue && other.defaultValue)
      error(row, '引数の既定値は、宣言と定義のどちらか一方にだけ書いてください。');
    return { ...other, defaultValue: param.defaultValue ?? other.defaultValue };
  });
}

/** Whether an overriding function's return type is covariant with the overridden one's (a pointer to a derived class). */
function covariant(base: Type, derived: Type, owner: ClassInfo | undefined): boolean {
  const a = target(base);
  const b = target(derived);
  return (
    a?.kind === 'class' &&
    b?.kind === 'class' &&
    base.kind === derived.kind &&
    (!isConstType(b) || isConstType(a)) &&
    b.cls.isDerivedFrom(a.cls) &&
    isBaseAccessible(b.cls, a.cls, owner)
  );
}

const target = (type: Type): Type | undefined =>
  type.kind === 'pointer' || type.kind === 'reference' ? type.to : undefined;

/** Whether default-initializing a const object of a type gives every scalar in it a value. */
function isConstDefaultConstructible(type: Type): boolean {
  if (type.kind === 'array') return type.length === 0 || isConstDefaultConstructible(type.of);
  if (type.kind !== 'class') return false;
  const { cls } = type;
  const fixed = cls.library?.aggregateArray;
  if (fixed) return isConstDefaultConstructible(fixed.type);
  if (cls.library || cls.constructors.length > 0) return true;
  return (
    (!cls.base || isConstDefaultConstructible(classType(cls.base))) &&
    cls.ownFields.every((field) => field.initializer !== undefined || isConstDefaultConstructible(field.type))
  );
}

function deletedDefaultMessage(cls: ClassInfo): string {
  return `${cls.name} のオブジェクトは初期値なしでは作れません（デフォルトコンストラクタが削除されています）。`;
}

/** Assigns a member's value as the implicit copy assignment operator does, giving the member's new value. */
function assignValue(frame: Frame, type: Type, target: Value, source: Value): Value {
  if (type.kind === 'class') {
    if (source === UNINIT) return UNINIT;
    if (target === UNINIT) return type.cls.operations?.copy(frame, source) ?? source;
    return type.cls.operations?.assign(frame, target, source) ?? target;
  }
  if (type.kind === 'array') {
    const targetArray = target as ArrayStore;
    const sourceArray = source as ArrayStore;
    for (const [index, item] of sourceArray.values.entries())
      targetArray.values[index] = assignValue(frame, type.of, targetArray.values[index], item);
    return targetArray;
  }
  return source;
}

/** Whether converting an arithmetic value to another type narrows it (C++20 [dcl.init.list]). */
function isNarrowing(
  from: Extract<Type, { kind: 'int' | 'float' }>,
  to: Extract<Type, { kind: 'int' | 'float' }>,
  constant: number | bigint | undefined
): boolean {
  if (from.kind === 'float' && to.kind === 'int') return true;
  if (from.kind === 'float' && to.kind === 'float') {
    const order = { float: 0, double: 1, ldouble: 2 };
    if (order[to.name] >= order[from.name]) return false;
    if (constant === undefined) return true;
    const value = Number(constant);
    return to.name === 'float' && Number.isFinite(value) && !Number.isFinite(Math.fround(value));
  }
  if (from.kind === 'int' && to.kind === 'float') {
    if (constant === undefined) return true;
    const value = Number(constant);
    return to.name === 'float' ? Math.fround(value) !== value : BigInt(Math.round(value)) !== BigInt(constant);
  }
  if (from.kind === 'int' && to.kind === 'int') {
    if (constant !== undefined) {
      const value = BigInt(constant);
      return value < intMinOf(to) || value > intMaxOf(to);
    }
    return !(intMinOf(to) <= intMinOf(from) && intMaxOf(to) >= intMaxOf(from));
  }
  return false;
}

/**
 * Runs the parts of a constructor's initialization of the base (the first part, when `hasBase`) and the members. An
 * exception from one undoes the parts done before it.
 */
function initializeInOrder(
  parts: readonly Exec[],
  hasBase: boolean,
  undo: (frame: Frame, isBaseComplete: boolean) => void
): Exec {
  return (frame) => {
    let done = 0;
    try {
      for (const part of parts) {
        part(frame);
        done++;
      }
    } catch (error) {
      if (error instanceof CppException) undo(frame, hasBase && done > 0);
      throw error;
    }
    return;
  };
}

function intMinOf(type: Extract<Type, { kind: 'int' }>): bigint {
  return intMin(type.name);
}

function intMaxOf(type: Extract<Type, { kind: 'int' }>): bigint {
  return intMax(type.name);
}

/** The function declarator of a declarator, which pointer and reference declarators may wrap (`int* f()`). */
function innermostFunctionDeclarator(declarator: Syntax): Syntax | undefined {
  let current: Syntax | undefined = declarator;
  while (current && current.type !== 'function_declarator') {
    if (current.type === 'parenthesized_declarator') return undefined;
    current = fieldOf(current, 'declarator') ?? current.children.find((child) => child.type.endsWith('declarator'));
  }
  return current;
}
