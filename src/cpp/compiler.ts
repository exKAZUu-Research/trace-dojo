import { CRuntimeError } from '../c/errors';
import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import { misplacedAtomicMessage, type TraceOptions } from '../interpreter/traceAnnotations';
import { isBaseAccessible, isMemberAccessible } from './access';
import { byteAt } from './bytes';
import { deduceProgramClass } from './classTemplateDeduction';
import { asTemplate, type Declared, hasAuto } from './compilerBase';
import {
  type ConceptInfo,
  conceptNamed,
  evaluateConstraint,
  satisfiesConcept,
  satisfiesTypeConstraint,
} from './concepts';
import { implicitConversion } from './conversions';
import { enumeratorEntity } from './enums';
import { CppException, CppRuntimeError, NarrowingConversionError } from './errors';
import {
  constantExpr,
  type Expr,
  type Initializer,
  type InitializerTarget,
  initializerWithConstancy,
  memberConstantOf,
  NO_CONSTANT_MEMBERS,
  zeroLiteral,
} from './expr';
import { thisLocation } from './expressionCompiler';
import { compileLambda } from './lambdas';
import { type OrderingName, orderingNumber, ORDERINGS } from './library/compare';
import { provideProgramOperators, type ValueComparison } from './library/elements';
import { type LibrarySource, librarySourceDeclaring } from './library/librarySources';
import type { Library, LibraryTemplate } from './library/registry';
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
import { expandPacks, packElements, withPackElement } from './packs';
import { parseLibrarySource } from './parse';
import {
  argumentsKey,
  argumentsText,
  type ClassTemplateInfo,
  Deduction,
  type ProgramTemplate,
  type TemplateArgument,
  TemplateBindings,
  type TemplateParameter,
  templateValue,
} from './programTemplates';
import { type CompiledFunction, type Eval, type Exec, type Frame, holdAll, RETURN, type Runtime } from './runtime';
import { type CaptureLookup, type Entity, FunctionContext, NamespaceInfo, type Scope } from './scopes';
import {
  type AutoDeduction,
  deducedType,
  endScope,
  type LocalDeclaration,
  type ReferenceBinding,
  StatementCompiler,
} from './statementCompiler';
import { isObjectCreation } from './stepRules';
import { fieldOf, fieldsOf, hasToken, type Syntax } from './syntax';
import {
  completeBindings,
  declareAbbreviatedTemplate,
  declareDeductionGuide,
  declareFunctionTemplate,
  declareTemplate,
  functionDeclarator,
  type FunctionTemplateInfo,
  inventParameters,
} from './templateCompiler';
import {
  type Access,
  alignOf,
  allowsMemberAssignment,
  BOOL,
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
  isWide,
  nonReference,
  type ParamInfo,
  sameParameters,
  sameType,
  sizeOf,
  type Type,
  typeName,
  unqualified,
  VOID,
  withConst,
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
  private readonly programComparisons = new Map<string, ValueComparison<boolean> | undefined>();
  private readonly lambdaCaptures = new WeakMap<ClassInfo, CaptureLookup>();
  /** The defaulted comparison operators that are friends of a class, which compare its objects. */
  private readonly defaultedFriends = new Map<FunctionInfo, ClassInfo>();
  /** The variables an `extern` declaration declares, which a later declaration may define. */
  private readonly externGlobals = new Set<GlobalInfo>();
  /** Whether member function bodies wait for their first use, as a class template instance's do. */
  private defersBodies = false;
  /** The namespace `std` of the library's C++ source. */
  private readonly libraryNamespace = new NamespaceInfo('std', undefined);
  private readonly compiledSources = new Set<LibrarySource>();
  private defaultDependencies?: {
    functions: Map<FunctionInfo, number>;
    staticMembers: Map<GlobalInfo, number>;
    checks: (() => void)[];
  };

  constructor(library: Library, options: CompileOptions = {}) {
    super(library);
    library.compiler = this;
    provideProgramOperators((cls, operator) => this.programComparison(cls, operator));
    this.recordsSteps = options.trace !== undefined;
    this.atomicRows = options.trace?.atomicAnnotations ?? new Map();
  }

  compile(root: Syntax): CompiledProgram {
    try {
      return this.compileProgram(root);
    } catch (error) {
      // An error in the library's code that a program's use of it causes is reported where the program uses it.
      if (error instanceof CompileError && error.diagnostics.some((diagnostic) => diagnostic.row < 0))
        throw new CompileError(
          error.diagnostics.map((diagnostic) =>
            diagnostic.row < 0 ? { ...diagnostic, row: this.userRow } : diagnostic
          )
        );
      throw error;
    }
  }

  protected override librarySourceEntity(name: string): Entity | undefined {
    const source = librarySourceDeclaring(name);
    if (!source) return undefined;
    this.compileLibrarySource(source);
    return this.libraryNamespace.member(name);
  }

  private compileLibrarySource(source: LibrarySource): void {
    if (this.compiledSources.has(source)) return;
    this.compiledSources.add(source);
    for (const used of source.uses ?? []) this.compileLibrarySource(used);
    const saved = {
      context: this.context,
      memberClass: this.memberClass,
      namespace: this.namespace,
      templateScopes: this.templateScopes,
      usesStd: this.usesStd,
      defersBodies: this.defersBodies,
      userRow: this.userRow,
    };
    this.context = new FunctionContext(undefined, undefined, VOID);
    this.memberClass = undefined;
    this.namespace = this.libraryNamespace;
    this.templateScopes = [];
    this.usesStd = false;
    this.defersBodies = false;
    try {
      for (const item of parsedLibrarySource(source).children) this.topLevel(item);
    } finally {
      Object.assign(this, saved);
    }
  }

  protected override deduceClassTemplate(template: LibraryTemplate, args: Expr[], row: number): Type {
    const info = template.program;
    // `std::function f = callable;` takes the signature of the callable's `operator()`, which libc++'s guide reads
    // through a pointer to the member function.
    const signature = info?.namespace === this.libraryNamespace && info.name === 'function' && callSignature(args);
    if (signature && info?.kind === 'class') return this.instantiateClassTemplate(info, [signature], row);
    if (info?.kind === 'class') return deduceProgramClass(this, info, args, row);
    const deduced = info ? undefined : this.library.deduceTemplateArguments(template.name, args);
    if (deduced && template.takesArrayBound)
      return template.instantiate(deduced[0], Number(templateValue(deduced[1] as TemplateArgument)));
    if (deduced && !template.takesArrayBound) return template.instantiate(deduced, row);
    return this.error(
      row,
      `${template.name} のテンプレート引数を、初期値から推論できません（<...> で書いてください）。`
    );
  }

  protected override tupleLikeSize(type: Type): number | undefined {
    const tupleSize = this.libraryNamespace.member('tuple_size');
    const info = tupleSize?.kind === 'template' ? tupleSize.template.program : undefined;
    if (info?.kind !== 'class') return undefined;
    const size = this.instantiateClassTemplate(info, [unqualified(type)], 0);
    if (size.kind !== 'class' || !size.cls.isComplete) return undefined;
    const value = this.lookupInClass(size.cls, { type: 'identifier', text: 'value' } as Syntax, 0);
    if (value.kind !== 'value' && value.kind !== 'staticField') return undefined;
    const constant = this.constantValueOf(
      this.entityExpr(value, { type: 'identifier', text: 'value' } as Syntax, true)
    );
    return constant === undefined ? undefined : Number(constant);
  }

  protected override tupleLikeElement(source: Expr, index: number, row: number): Expr {
    const get = this.libraryNamespace.member('get');
    if (get?.kind !== 'functions') return this.error(row, 'get が宣言されていません。');
    const callee: Expr = {
      type: VOID,
      isLvalue: false,
      row,
      run: () => {},
      functions: {
        name: 'get',
        candidates: get.functions,
        templateArgs: [{ kind: 'int', name: 'ulong', templateValue: BigInt(index) }],
      },
    };
    return this.callWith(callee, [source], row);
  }

  completeTemplateBindings(info: ProgramTemplate, deduction: Deduction): TemplateBindings | undefined {
    return completeBindings(this, info, deduction);
  }

  /** A type a template's declaration writes, in one of its instances. */
  typeInTemplate(template: ProgramTemplate, bindings: TemplateBindings, node: Syntax): Type {
    return this.inTemplate(template, bindings, () => this.typeDescriptor(node));
  }

  private compileProgram(root: Syntax): CompiledProgram {
    for (const item of root.children) this.topLevel(item);
    const objectUses = this.pendingObjectUses;
    this.pendingObjectUses = undefined;
    for (const check of objectUses ?? []) check();
    this.checkLibraryGlobalDeclarations();
    const main = this.rootScope.names.get('main');
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
      if (!member.isDefined) this.error(row, `変数 ${member.name} は宣言だけで、定義がありません。`);
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
          box.elementSize = sizeOf(type);
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

  /**
   * Compares two objects of a class the program wrote with the `<` or `==` it declares for them, for the library's
   * containers and algorithms; undefined when it declares none.
   */
  private programComparison(cls: ClassInfo, operator: '<' | '=='): ValueComparison<boolean> | undefined {
    const key = `${cls.id}${operator}`;
    if (this.programComparisons.has(key)) return this.programComparisons.get(key);
    const operands: Ptr[][] = [];
    const operand = (index: number): Expr => ({
      type: classType(cls, true),
      isLvalue: true,
      row: cls.row,
      run: () => (operands.at(-1) as Ptr[])[index],
    });
    let comparison: ValueComparison<boolean> | undefined;
    try {
      const overloaded = this.binary(operator, operand(0), operand(1), cls.row);
      if (overloaded) {
        const test = this.condition(overloaded, cls.row);
        comparison = (a, b, frame) => {
          operands.push([new Ptr(new Box(a), 0), new Ptr(new Box(b), 0)]);
          try {
            return withTemporaries(frame, () => test(frame));
          } finally {
            operands.pop();
          }
        };
      }
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
    }
    this.programComparisons.set(key, comparison);
    return comparison;
  }

  private libcOverrides(): ReadonlyMap<string, FunctionInfo> {
    const overrides = new Map<string, FunctionInfo>();
    for (const entity of this.rootScope.names.values()) {
      if (entity.kind !== 'functions') continue;
      for (const fn of entity.functions) {
        if (this.library.isLibcDefinition(fn)) overrides.set(fn.name, fn);
      }
    }
    return overrides;
  }

  private checkLibraryGlobalDeclarations(): void {
    for (const [name, entity] of this.rootScope.names) {
      if (entity.kind === 'global' && this.library.conflictsWithGlobal(name, entity.global.type))
        this.error(entity.global.row, `${name} はヘッダーにある名前の宣言と重複しています。`);
      if (entity.kind === 'functions') {
        const conflict = entity.functions.find((fn) => !fn.native && this.library.conflictsWithGlobal(name, fn));
        if (conflict) this.error(conflict.row, `${name} はヘッダーにある宣言と重複しています。`);
      }
    }
  }

  private topLevel(node: Syntax): void {
    if (node.row >= 0) this.userRow = node.row;
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
      case 'struct_specifier':
      case 'union_specifier':
      case 'enum_specifier': {
        this.resolveTypeSpecifier(node);
        return;
      }
      case 'function_definition': {
        if (declareAbbreviatedTemplate(this, node)) return;
        this.functionDefinition(node);
        return;
      }
      case 'declaration': {
        if (declareAbbreviatedTemplate(this, node)) return;
        this.globalDeclaration(node);
        return;
      }
      case 'type_definition':
      case 'alias_declaration':
      case 'static_assert_declaration': {
        this.declarationOnly(node);
        return;
      }
      case 'namespace_definition': {
        this.namespaceDefinition(node);
        return;
      }
      case 'template_declaration': {
        declareTemplate(this, node);
        return;
      }
      case 'template_instantiation': {
        this.explicitInstantiation(node);
        return;
      }
      case 'namespace_alias_definition': {
        const name = (fieldOf(node, 'name') as Syntax).text;
        const target = node.children.find((child) => child.field !== 'name') as Syntax;
        const scope = this.resolveScope(target);
        if (scope.kind !== 'namespace') return this.error(node.row, `${target.text} は名前空間ではありません。`);
        if (!scope.ns) return this.unsupported(node.row, `名前空間 ${target.text} の別名`);
        this.declareHere(name, { kind: 'namespace', name, ns: scope.ns }, node.row);
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

  /**
   * Compiles a namespace's declarations (`namespace geo { ... }`), which reopen it when it exists; a nested name
   * (`namespace a::b`) opens each namespace, and an unnamed namespace's members are visible in the enclosing one.
   */
  private namespaceDefinition(node: Syntax): void {
    const nameNode = fieldOf(node, 'name');
    const names =
      nameNode?.type === 'nested_namespace_specifier' ? nameNode.children.map((part) => part.text) : [nameNode?.text];
    const saved = this.namespace;
    try {
      for (const name of names) this.namespace = this.openNamespace(name, hasToken(node, 'inline'), node.row);
      const body = fieldOf(node, 'body');
      for (const item of body?.children ?? []) this.topLevel(item);
    } finally {
      this.namespace = saved;
    }
  }

  private openNamespace(name: string | undefined, isInline: boolean, row: number): NamespaceInfo {
    const parent = this.namespace;
    const scope = this.globalScope;
    const key = name ?? '\0unnamed';
    const existing = scope.names.get(key);
    if (existing?.kind === 'namespace' && existing.ns) return existing.ns;
    if (existing) return this.error(row, `${name ?? ''} はすでに名前空間以外として宣言されています。`);
    const ns = new NamespaceInfo(name ?? '(anonymous namespace)', parent);
    scope.names.set(key, { kind: 'namespace', name: ns.name, ns });
    if (isInline) parent?.inlineNamespaces.push(ns);
    if (isInline && !parent) this.rootScope.usings.push(ns);
    if (!name) scope.usings.push(ns);
    return ns;
  }

  usingDeclaration(node: Syntax): void {
    const isNamespace = hasToken(node, 'namespace');
    const target = node.children[0];
    if (!target) return;
    if (hasToken(node, 'enum')) {
      const type = this.resolveTypeSpecifier(target);
      const info = type.kind === 'int' ? type.enumeration : undefined;
      if (!info) return this.error(node.row, `${target.text} は列挙ではありません。`);
      for (const name of info.enumerators.keys())
        this.declareHere(name, enumeratorEntity(info, name) as Entity, node.row);
      return;
    }
    if (isNamespace) {
      // The library's literal suffixes need no directive here: the interpreter knows `"..."s` wherever it appears.
      if (/^std::(?:literals(?:::string_literals)?|string_literals)$/.test(target.text.replaceAll(/\s+/g, ''))) return;
      if (/^std::(?:literals::)?(?:chrono_literals|chrono)$/.test(target.text.replaceAll(/\s+/g, '')))
        return this.unsupported(node.row, '<chrono>');
      const scope = this.resolveScope(target);
      if (scope.kind !== 'namespace') return this.error(node.row, `${target.text} は名前空間ではありません。`);
      const directives = this.context.fn ? this.context.scope : this.globalScope;
      if (scope.ns) directives.usings.push(scope.ns);
      else if (this.context.fn) this.context.scope.usesStd = true;
      else this.usesStd = true;
      return;
    }
    if (target.type !== 'qualified_identifier') return this.unsupported(node.row, `using ${target.text}`);
    const scope = fieldOf(target, 'scope') as Syntax;
    if (scope.text !== 'std' && this.resolveScope(scope).kind === 'class')
      return this.unsupported(node.row, 'クラスのメンバの using 宣言（using Base::f; など）');
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
    const key = classKey(node);
    if (!nameNode) {
      if (!body) return this.error(node.row, 'クラスの名前を書いてください。');
      const unnamed = new ClassInfo(`(unnamed ${key})`, key);
      unnamed.isUnnamed = true;
      unnamed.row = node.row;
      this.placeClass(unnamed);
      this.defineClass(unnamed, node, body);
      return classType(unnamed);
    }
    if (nameNode.type === 'qualified_identifier') return this.qualifiedClassDefinition(node, nameNode, body);
    if (nameNode.type !== 'type_identifier') return this.unsupported(node.row, `クラス ${nameNode.text} の定義`);
    const name = nameNode.text;
    let cls: ClassInfo;
    // `struct time t;` names a class declared in an enclosing scope, which a library name of the same name hides.
    const existing =
      this.findDeclaredHere(name) ??
      (body
        ? undefined
        : (this.context.lookupLocal(name, (entity) => classOfEntity(entity) !== undefined) ??
          this.globalScope.names.get(name)));
    const existingClass = existing && classOfEntity(existing);
    if (existingClass) {
      cls = existingClass;
      if (body && cls.isComplete) return this.error(node.row, `クラス ${name} はすでに定義されています。`);
    } else {
      if (existing) return this.error(node.row, `${name} はすでに別のものとして宣言されています。`);
      if (!this.context.fn && !this.memberClass && this.library.global(name)?.kind === 'type')
        return this.error(node.row, `${name} はヘッダーで型として宣言されています。`);
      cls = new ClassInfo(name, key);
      cls.row = node.row;
      this.placeClass(cls);
      this.declareHere(name, { kind: 'class', cls }, node.row);
    }
    if (body) this.defineClass(cls, node, body);
    return classType(cls);
  }

  /** Records where a new class is declared: in a class (a nested class) or in a function (a local class). */
  private placeClass(cls: ClassInfo): void {
    cls.namespace = this.namespace;
    if (this.memberClass && !this.context.fn) cls.outer = this.memberClass;
    else if (this.context.fn) cls.localScopes = [...this.context.scopes, ...this.context.outerScopes];
  }

  /** Defines a nested class outside its enclosing class (`class Outer::Inner { ... };`). */
  private qualifiedClassDefinition(node: Syntax, nameNode: Syntax, body: Syntax | undefined): Type {
    const scope = this.resolveScope(fieldOf(nameNode, 'scope') as Syntax);
    const name = (fieldOf(nameNode, 'name') as Syntax).text;
    if (scope.kind !== 'class') return this.unsupported(node.row, `クラス ${nameNode.text} の定義`);
    const member = scope.cls.memberTypes.get(name);
    if (member?.kind !== 'class')
      return this.error(node.row, `${scope.cls.name} に ${name} というクラスは宣言されていません。`);
    if (!body) return member;
    if (member.cls.isComplete) return this.error(node.row, `クラス ${nameNode.text} はすでに定義されています。`);
    const saved = this.memberClass;
    this.memberClass = scope.cls;
    try {
      this.defineClass(member.cls, node, body);
    } finally {
      this.memberClass = saved;
    }
    return member;
  }

  private defineClass(cls: ClassInfo, node: Syntax, body: Syntax): void {
    // The members of a local class are declared in the class, which sees the names of the enclosing blocks.
    const savedContext = this.context;
    if (savedContext.fn) this.context = FunctionContext.classBody(savedContext);
    try {
      this.defineClassMembers(cls, node, body);
    } finally {
      this.context = savedContext;
    }
  }

  private defineClassMembers(cls: ClassInfo, node: Syntax, body: Syntax): void {
    const alignment = node.children.find((child) => child.type === 'alignas_qualifier');
    if (alignment) cls.alignment = this.alignmentOf(alignment);
    const isFinalClass = node.children.some((child) => child.type === 'virtual_specifier' && child.text === 'final');
    const defaultAccess: Access = classKey(node) === 'class' ? 'private' : 'public';
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
            if (declareAbbreviatedTemplate(this, member, cls, access)) break;
            this.memberDeclaration(cls, member, access);
            break;
          }
          case 'declaration': {
            if (declareAbbreviatedTemplate(this, member, cls, access)) break;
            this.memberDeclaration(cls, member, access);
            break;
          }
          case 'function_definition': {
            if (declareAbbreviatedTemplate(this, member, cls, access)) break;
            const fn = this.memberFunction(cls, member, access, true);
            definitions.push({ fn, node: member });
            break;
          }
          case 'using_declaration': {
            this.memberUsing(cls, member, access, definitions);
            break;
          }
          case 'enum_specifier': {
            this.resolveTypeSpecifier(member);
            break;
          }
          case 'friend_declaration': {
            this.friendDeclaration(cls, member, definitions);
            break;
          }
          case 'template_declaration': {
            declareTemplate(this, member, cls, access);
            break;
          }
          case 'type_definition':
          case 'alias_declaration':
          case 'static_assert_declaration': {
            this.declarationOnly(member);
            break;
          }
          case 'class_specifier':
          case 'struct_specifier':
          case 'union_specifier': {
            this.resolveTypeSpecifier(member);
            break;
          }
          default: {
            this.error(member.row, `${member.text.split('\n')[0]} はクラスの中には書けません。`);
          }
        }
      }
      this.completeClass(cls, isFinalClass);
      this.defineDefaultedComparisons(cls);
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
      // The bodies that wait for their first use are set up first, so that the others may call them.
      const ordered = this.defersBodies
        ? definitions.toSorted((a, b) => Number(!this.defersBody(a.fn)) - Number(!this.defersBody(b.fn)))
        : definitions;
      for (const { fn, node: definition } of ordered) {
        if (!fn.isDefaulted && !fn.isDeleted) this.compileFunction(fn, definition);
      }
      for (const fn of [...cls.constructors, ...(cls.destructor ? [cls.destructor] : [])]) {
        if (fn.isDefined && !fn.compiled && fn.definition) this.compileFunction(fn, fn.definition);
      }
    } finally {
      this.memberClass = savedClass;
    }
  }

  /**
   * Declares a friend of a class: a class (`friend class B;`), a function (`friend void f(A&);`), or a function the
   * declaration defines (`friend std::ostream& operator<<(...) { ... }`), whose body compiles with the members'.
   */
  private friendDeclaration(cls: ClassInfo, node: Syntax, definitions: { fn: FunctionInfo; node: Syntax }[]): void {
    const inner = node.children[0];
    if (!inner) return this.error(node.row, 'friend の後に、クラスか関数を書いてください。');
    if (inner.type === 'declaration' || inner.type === 'function_definition') {
      const isDefinition = inner.type === 'function_definition';
      const base = this.specifiedType(inner, true);
      const declarators = isDefinition ? [fieldOf(inner, 'declarator') as Syntax] : fieldsOf(inner, 'declarator');
      if (declarators.length === 0) {
        // `friend class B;` with an elaborated type specifier.
        if (base.kind !== 'class') return this.error(node.row, 'friend にはクラスか関数を書いてください。');
        cls.friendClasses.add(base.cls);
        return;
      }
      for (const declarator of declarators) {
        const declared = this.applyDeclarator(base, declarator);
        if (!declared.function) return this.error(declarator.row, 'friend にはクラスか関数を書いてください。');
        if (declared.nameNode?.type === 'qualified_identifier') {
          const scope = this.resolveScope(fieldOf(declared.nameNode, 'scope') as Syntax);
          if (scope.kind !== 'class')
            return this.error(declarator.row, `${declared.nameNode.text} はクラスのメンバではありません。`);
          const methods = scope.cls.methods.get(declared.name ?? '') ?? [];
          if (methods.length === 0)
            return this.error(
              declarator.row,
              `${scope.cls.name} に ${declared.name ?? ''} というメンバ関数はありません。`
            );
          for (const method of methods) cls.friendFunctions.add(method);
          continue;
        }
        const isDefaulted = isDefinition && specialDefinition(inner) === 'default';
        const fn = this.declareFunction(inner, declared, isDefinition && !isDefaulted);
        cls.friendFunctions.add(fn);
        if (isDefaulted) {
          // A defaulted comparison of a class may be its friend (`friend bool operator==(const P&, const P&) = default;`).
          if (!isDefaultableComparison(fn))
            this.error(inner.row, `${fn.displayName} には = default を付けられません。`);
          fn.isDefaulted = true;
          fn.isDefined = true;
          this.defaultedFriends.set(fn, cls);
        } else if (isDefinition) definitions.push({ fn, node: inner });
      }
      return;
    }
    const type = this.friendClass(inner);
    if (type.kind !== 'class') return this.error(node.row, `${inner.text} はクラスではありません。`);
    cls.friendClasses.add(type.cls);
  }

  /** The class `friend class B;` names, which the declaration declares when no class of that name exists yet. */
  private friendClass(node: Syntax): Type {
    if (node.type === 'type_identifier' && !this.findName(node.text, true)) {
      const friend = new ClassInfo(node.text, 'class');
      friend.row = node.row;
      friend.namespace = this.namespace;
      this.globalScope.names.set(node.text, { kind: 'class', cls: friend });
      return classType(friend);
    }
    return this.resolveTypeSpecifier(node, false, true);
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
      declarators.length === 0 &&
      (type?.type === 'class_specifier' || type?.type === 'struct_specifier' || type?.type === 'union_specifier')
    ) {
      const declared = this.resolveTypeSpecifier(type);
      if (!fieldOf(type, 'name') && declared.kind === 'class')
        this.anonymousMember(cls, declared.cls, access, node.row);
      return;
    }
    if (declarators.length === 0 && type?.type === 'enum_specifier') {
      this.resolveTypeSpecifier(type);
      return;
    }
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
      const clause = node.all[node.all.indexOf(declarator) + 1];
      const bitWidth = clause?.type === 'bitfield_clause' ? this.bitFieldWidth(declared.type, clause, name) : undefined;
      if (!name && bitWidth !== undefined) {
        cls.unnamedBitFields.push({ before: cls.ownFields.length, type: declared.type, width: bitWidth });
        continue;
      }
      if (bitWidth === 0) this.error(declarator.row, `名前のあるビットフィールド ${name} の幅を 0 にはできません。`);
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
      const isMutable = this.hasSpecifier(node, 'mutable');
      const alignas = node.children
        .flatMap((child) => child.children)
        .find((child) => child.type === 'alignas_qualifier');
      if (isMutable && (declared.type.kind === 'reference' || isConstType(declared.type)))
        this.error(declarator.row, `mutable は const のメンバや参照のメンバには付けられません（${name}）。`);
      const field: FieldInfo = {
        name,
        type: declared.type,
        index: cls.fields.length,
        access,
        owner: cls,
        row: declarator.row,
        initializer,
        directInitializer,
        isMutable,
        alignment: alignas && this.alignmentOf(alignas),
        bitWidth,
      };
      cls.fields.push(field);
    }
  }

  /** The width of a bit-field of a type, which its clause (`: 3`) gives as an integral constant. */
  private bitFieldWidth(type: Type, clause: Syntax, name: string): number {
    const expr = this.rvalue(this.compileExpression(clause.children[0]));
    const width = this.constantValueOf(expr);
    if (!isInteger(type))
      return this.error(clause.row, `ビットフィールド ${name} の型は整数型か列挙型にしてください。`);
    if (!isInteger(expr.type) || width === undefined || width < 0)
      return this.error(clause.row, `ビットフィールド ${name} の幅には、0 以上の整数の定数式を書いてください。`);
    if (width > sizeOf(type) * 8) this.unsupported(clause.row, '型の幅より広いビットフィールド');
    return Number(width);
  }

  /**
   * Adds an anonymous union (or struct) as a member whose own members the enclosing class names directly
   * (`union { int i; float f; };`).
   */
  private anonymousMember(cls: ClassInfo, member: ClassInfo, access: Access, row: number): void {
    const field: FieldInfo = {
      name: `\0anonymous#${cls.fields.length}`,
      type: classType(member),
      index: cls.fields.length,
      access,
      owner: cls,
      row,
    };
    cls.fields.push(field);
    for (const inner of [...member.ownFields, ...member.anonymousFields]) {
      if (this.memberEntity(cls, inner.name)) this.error(row, `メンバ ${inner.name} はすでに宣言されています。`);
      cls.anonymousFields.push({ ...inner, owner: cls, access, path: [field, ...(inner.path ?? [])] });
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
      if (current.type === 'function_declarator' || current.type === 'operator_cast') return true;
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
    const isConversion = declared.nameNode?.type === 'operator_cast';
    const isConstructor = !typeNode && !isDestructor && !isConversion;
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
    const clause = isDefinition ? specialDefinition(node) : undefined;
    if (clause === 'delete') {
      fn.isDeleted = true;
      fn.isDefined = true;
    } else if (clause === 'default') {
      fn.isDefaulted = true;
      fn.isDefined = true;
      this.checkDefaultable(cls, fn, node.row);
      // A defaulted copy constructor or copy assignment behaves as the implicit one, which the class keeps.
      if ((isConstructor && fn.params.length > 0) || rawName === 'operator=') {
        cls.declaresConstructor ||= isConstructor;
        return fn;
      }
    } else if (isDefinition) {
      fn.isDefined = true;
      fn.definition = node;
      this.claimAtomic(fn, node);
    }
    if (isConstructor) {
      this.addOverload(cls.constructors, fn, node.row);
    } else if (isDestructor) {
      if (fn.isDefaulted) this.defineDefaulted(cls, fn);
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

  /**
   * Gives the defaulted comparison operators of a class their bodies (C++20 [class.compare]): `==` compares the
   * members in order, `<=>` gives the first unequal member's ordering, and a defaulted `<=>` declares `==` too.
   */
  private defineDefaultedComparisons(cls: ClassInfo): void {
    const friends = [...this.defaultedFriends].filter(([, owner]) => owner === cls).map(([fn]) => fn);
    const defaulted = [...[...cls.methods.values()].flat(), ...friends].filter(
      (fn) => fn.isDefaulted && isDefaultableComparison(fn) && !fn.compiled
    );
    const spaceship = defaulted.find((fn) => fn.name === 'operator<=>');
    if (spaceship && !cls.methods.has('operator==')) {
      const equal: FunctionInfo = {
        ...spaceship,
        name: 'operator==',
        displayName: `${cls.name}::operator==`,
        ret: BOOL,
      };
      cls.methods.set('operator==', [equal]);
      defaulted.push(equal);
    }
    for (const fn of defaulted) this.defineDefaultedComparison(cls, fn);
  }

  private defineDefaultedComparison(cls: ClassInfo, fn: FunctionInfo): void {
    const context = new FunctionContext(fn, fn.owner, fn.ret);
    const saved = this.context;
    this.context = context;
    try {
      const operands = fn.params.map((param): Expr => {
        const local = context.declareLocal(param.name ?? `\0operand${param.row}`, param.type, true);
        const isReference = param.type.kind === 'reference';
        return {
          type: withConst(nonReference(param.type)),
          isLvalue: true,
          row: fn.row,
          run: (frame) => (isReference ? (frame.slots[local.slot] as Ptr) : new Ptr(frame.slots[local.slot] as Box, 0)),
        };
      });
      const self: Expr = {
        type: classType(cls, true),
        isLvalue: true,
        isThis: true,
        row: fn.row,
        run: (frame) => thisLocation(frame),
      };
      const [left, right] = fn.owner ? [self, operands[0]] : [operands[0], operands[1]];
      if (!left || !right) return this.error(fn.row, `${fn.displayName} の引数が足りません。`);
      fn.compiled = {
        slotCount: context.slotCount,
        locals: context.locals,
        body: this.comparisonBody(cls, fn, left, right),
      };
    } finally {
      this.context = saved;
    }
  }

  private comparisonBody(cls: ClassInfo, fn: FunctionInfo, left: Expr, right: Expr): (frame: Frame) => void {
    const row = fn.row;
    const members = cls.fields;
    if (fn.name === 'operator==') {
      const tests = members.map((field) =>
        this.condition(
          this.binary('==', this.fieldAccess(left, field, row), this.fieldAccess(right, field, row), row),
          row
        )
      );
      return (frame) => {
        frame.returnValue = Number(tests.every((test) => test(frame)));
      };
    }
    if (fn.name === 'operator<=>') {
      const orders = members.map((field) =>
        this.threeWay(this.fieldAccess(left, field, row), this.fieldAccess(right, field, row), row)
      );
      // The result is the weakest category of the members' comparisons.
      let weakest: OrderingName = 'strong_ordering';
      for (const order of orders) {
        const name = (order.type as Extract<Type, { kind: 'class' }>).cls.library?.kind as OrderingName;
        if (ORDERINGS.indexOf(name) > ORDERINGS.indexOf(weakest)) weakest = name;
      }
      const result = this.library.ordering(weakest);
      if (hasAuto(fn.ret)) fn.ret = classType(result);
      const runs = orders.map((order) => this.rvalue(order).run);
      return (frame) => {
        for (const run of runs) {
          const value = orderingNumber(run(frame) as Value);
          if (value !== 0) {
            frame.returnValue = new CObject(result, [value]);
            return;
          }
        }
        frame.returnValue = new CObject(result, [0]);
      };
    }
    // A defaulted relational operator compares `<=>` with 0.
    const test = this.condition(
      this.binary(fn.name.slice('operator'.length), this.threeWay(left, right, row), zeroLiteral(row), row),
      row
    );
    return (frame) => {
      frame.returnValue = Number(test(frame));
    };
  }

  /** Rejects `= default` on a function that is no special member function (C++20 [dcl.fct.def.default]). */
  private checkDefaultable(cls: ClassInfo, fn: FunctionInfo, row: number): void {
    const isCopy = fn.params.length === 1 && isCopyParameter(fn.params[0].type, cls);
    const isSpecial =
      (fn.isConstructor && (fn.params.length === 0 || isCopy)) ||
      fn.isDestructor ||
      (fn.name === 'operator=' && isCopy) ||
      isDefaultableComparison(fn);
    if (!isSpecial)
      this.error(row, `${fn.displayName} には = default を付けられません（特別なメンバ関数ではありません）。`);
  }

  /**
   * A using-declaration in a class (C++20 [namespace.udecl]): `using Base::Base;` inherits the base's constructors,
   * and `using Base::f;` makes the base's member functions of that name overloads of the class's.
   */
  private memberUsing(
    cls: ClassInfo,
    node: Syntax,
    access: Access,
    definitions: { fn: FunctionInfo; node: Syntax }[]
  ): void {
    const target = node.children[0];
    if (target?.type !== 'qualified_identifier')
      return this.error(node.row, `using ${target?.text ?? ''} は書けません。`);
    const { scope: scopeNode, name: nameNode } = splitQualified(target);
    const scope = this.resolveScope(scopeNode);
    if (scope.kind !== 'class' || !cls.isDerivedFrom(scope.cls) || scope.cls === cls)
      return this.error(node.row, `${scopeNode.text} は ${cls.name} の親クラスではありません。`);
    const base = scope.cls;
    const name = this.plainName(nameNode);
    if (name === base.name || name === base.name.replace(/^std::/, '')) {
      for (const constructor of base.constructors) {
        if (isCopyConstructor(constructor, base) || constructor.templatePattern) continue;
        const inherited = this.inheritedConstructor(cls, base, constructor, access);
        definitions.push(inherited);
      }
      return;
    }
    const entity = this.lookupQualified(target);
    if (entity.kind === 'functions') {
      cls.methods.set(name, [...(cls.methods.get(name) ?? []), ...entity.functions]);
      return;
    }
    if (entity.kind !== 'field' && entity.kind !== 'staticField' && entity.kind !== 'type')
      this.error(node.row, `${target.text} はメンバではありません。`);
  }

  /** A constructor of a class that a base's constructor gives it, which constructs the base with its arguments. */
  private inheritedConstructor(
    cls: ClassInfo,
    base: ClassInfo,
    constructor: FunctionInfo,
    access: Access
  ): { fn: FunctionInfo; node: Syntax } {
    const row = cls.row;
    const synthetic = (type: string, text: string, children: Syntax[] = [], field?: string): Syntax => ({
      type,
      text,
      row,
      endRow: row,
      start: 0,
      end: 0,
      isNamed: true,
      field,
      all: children,
      children,
    });
    const names = constructor.params.map((_, index) => `\0inherited${index}`);
    const args = synthetic(
      'argument_list',
      '',
      names.map((name) => synthetic('identifier', name))
    );
    const baseName = synthetic('type_identifier', base.name);
    const initializer = synthetic('field_initializer', base.name, [baseName, args]);
    const list = synthetic('field_initializer_list', '', [initializer]);
    const body = synthetic('compound_statement', '{}', [], 'body');
    const node = synthetic('function_definition', '', [list, body]);
    const fn: FunctionInfo = {
      ...constructor,
      name: cls.name,
      displayName: `${cls.name}::${cls.name}`,
      owner: cls,
      params: constructor.params.map((param, index) => ({ ...param, name: names[index] })),
      native: undefined,
      instantiate: undefined,
      compiled: undefined,
      access,
      isConstructor: true,
      isDefined: true,
      definition: node,
      isInline: true,
    };
    if (!cls.constructors.some((other) => sameDeclaredSignature(other, fn))) cls.constructors.push(fn);
    return { fn, node };
  }

  /** Adds a function to an overload set, rejecting a second declaration with the same parameters. */
  private addOverload(overloads: FunctionInfo[], fn: FunctionInfo, row: number): void {
    const same = overloads.find((other) => !other.templatePattern && sameDeclaredSignature(other, fn));
    // A member function hides a base's of the same signature that a using-declaration brought in.
    if (same && fn.owner && same.owner && same.owner !== fn.owner) {
      overloads.splice(overloads.indexOf(same), 1);
    } else if (same) this.error(row, `${fn.displayName} は、同じ引数の型ですでに宣言されています。`);
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
    if (ret.kind === 'array') this.error(node.row, '関数は配列を返せません。');
    const params = this.parameters(fieldOf(declarator, 'parameters') as Syntax);
    const displayName = owner
      ? `${owner.name}::${name}`
      : this.namespace
        ? `${this.namespace.qualifiedName}::${name}`
        : name;
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
      namespace: owner ? undefined : this.namespace,
      templateScopes: this.templateScopes.length > 0 ? [...this.templateScopes] : undefined,
      isExplicit: this.isExplicitSpecified(node),
      isConversion: declarator.type === 'abstract_function_declarator' && name.startsWith('operator '),
      isStatic: false,
      isVirtual: false,
      isInline: this.hasSpecifier(node, 'inline'),
      isConst: qualifiers.has('const'),
      isNoexcept: this.exceptionSpecification(declarator),
      isConstexpr: this.hasSpecifier(node, 'constexpr') || this.hasSpecifier(node, 'consteval'),
      isConsteval: this.hasSpecifier(node, 'consteval'),
      refQualifier: declarator.children.find((child) => child.type === 'ref_qualifier')?.text as '&' | '&&' | undefined,
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

  protected declareParameterNames(list: Syntax, declare: (name: string, entity: Entity) => void): void {
    const packs = new Map<string, Entity[]>();
    // A parameter pack with no elements is still a pack.
    for (const param of list.children) {
      const packDeclarator = param.type === 'variadic_parameter_declaration' ? fieldOf(param, 'declarator') : undefined;
      const inner = packDeclarator && withoutEllipsis(packDeclarator);
      const name = inner && this.applyDeclarator(INT, inner).name;
      if (name) packs.set(name, []);
    }
    for (const param of this.parameters(list)) {
      if (!param.name) continue;
      const local = { name: param.name, slot: -1, type: param.type, isParameter: true };
      const entity: Entity = { kind: 'local', local, isReference: param.type.kind === 'reference' };
      if (param.pack) packs.get(param.pack)?.push(entity);
      else declare(param.name, entity);
    }
    for (const [name, items] of packs) declare(name, { kind: 'pack', items });
  }

  protected parameterTypes(list: Syntax): Type[] {
    return this.parameters(list).map((param) => param.type);
  }

  /**
   * Whether a function declarator's exception specification says it throws nothing: `noexcept`, `noexcept(true)`,
   * or `throw()` (C++20 [except.spec]).
   */
  private exceptionSpecification(declarator: Syntax): boolean {
    const throwSpecifier = declarator.children.find((child) => child.type === 'throw_specifier');
    if (throwSpecifier) {
      if (throwSpecifier.children.length > 0)
        this.error(throwSpecifier.row, 'C++17 からは throw(型) の例外の指定は使えません。noexcept を使ってください。');
      return true;
    }
    const specifier = declarator.children.find((child) => child.type === 'noexcept');
    if (!specifier) return false;
    const condition = specifier.children[0];
    if (!condition) return true;
    const value = this.constantValueOf(this.compileExpression(condition));
    if (value === undefined) this.error(condition.row, 'noexcept(...) の条件は定数式でなければなりません。');
    return Number(value) !== 0;
  }

  /** The alignment an `alignas` qualifier gives: a power of two, or the alignment of a type. */
  private alignmentOf(node: Syntax): number {
    const operand = node.children[0];
    if (operand.type === 'type_descriptor') return alignOf(this.typeDescriptor(operand));
    const value = this.constantValueOf(this.compileExpression(operand));
    const alignment = Number(value);
    if (value === undefined || alignment <= 0 || (alignment & (alignment - 1)) !== 0)
      return this.error(node.row, 'alignas には 2 のべき乗の定数を書いてください。');
    return alignment;
  }

  /** Whether a declaration says `explicit`, or `explicit(true)` with a constant condition. */
  private isExplicitSpecified(node: Syntax): boolean {
    const specifier = node.children.find((child) => child.type === 'explicit_function_specifier');
    if (!specifier) return false;
    const condition = specifier.children[0];
    if (!condition) return true;
    const value = this.constantValueOf(this.compileExpression(condition));
    if (value === undefined) this.error(condition.row, 'explicit(...) の条件は定数式でなければなりません。');
    return Number(value) !== 0;
  }

  parameters(list: Syntax): ParamInfo[] {
    const params: ParamInfo[] = [];
    const declarations = list.children;
    for (const param of declarations) {
      if (param.type === 'variadic_parameter') return this.unsupported(param.row, '可変長引数（...）');
      if (param.type === 'variadic_parameter_declaration') {
        params.push(...this.packParameters(param));
        continue;
      }
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
      if (type.kind === 'function') type = { kind: 'pointer', to: type };
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

  /** The parameters a function parameter pack (`Ts... xs`) declares, one per element of the packs its type names. */
  private packParameters(param: Syntax): ParamInfo[] {
    const written = fieldOf(param, 'declarator');
    // `const Ts&... xs` declares `xs` with the declarator around the `...`.
    const inner = written && withoutEllipsis(written);
    const declarator = written;
    const pattern: Syntax = {
      ...param,
      type: 'parameter_declaration',
      all: param.all.filter((child) => child !== declarator),
    };
    const elements = packElements(this, pattern, param.row);
    const name = inner ? this.applyDeclarator(INT, inner).name : undefined;
    return elements.map((element, index) =>
      withPackElement(this, element, (declaration) => {
        let type = this.specifiedType(declaration, true);
        if (inner) type = this.applyDeclarator(type, inner).type;
        if (type.kind === 'array') type = { kind: 'pointer', to: type.of };
        return { name: name && `\0${name}#${index}`, type, row: param.row, pack: name };
      })
    );
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
  completeClass(cls: ClassInfo, isFinalClass: boolean): void {
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
    const userAssignment = (cls.methods.get('operator=') ?? []).find(
      (fn) => fn.params.length === 1 && isCopyParameter(fn.params[0].type, cls)
    );
    cls.isAssignmentDeleted = userAssignment
      ? userAssignment.isDeleted === true
      : cls.base?.isAssignmentDeleted === true || cls.ownFields.some((field) => !allowsMemberAssignment(field.type));
    cls.isComplete = true;
    for (const constructor of cls.constructors) {
      if (constructor.isDefaulted) this.defineDefaulted(cls, constructor);
    }
    if (cls.constructors.length === 0 && cls.declaresConstructor) cls.isDefaultConstructorDeleted = true;
    else if (cls.constructors.length === 0) {
      cls.isDefaultConstructorDeleted =
        (cls.base !== undefined && !this.isDefaultInitializable(classType(cls.base), cls, true)) ||
        cls.ownFields.some((field) => !field.initializer && !this.isDefaultInitializable(field.type, cls)) ||
        (cls.isUnion &&
          cls.ownFields.every((field) => !field.initializer) &&
          cls.ownFields.some((field) => !isTrivialUnionMember(field.type)));
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
      cls.ownFields.some(
        (field) => !this.isCopyInitializable(field.type, cls) || (cls.isUnion && !isTrivialUnionMember(field.type))
      );
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

  /** Gives a defaulted default constructor or destructor the body the implicit one would have. */
  private defineDefaulted(cls: ClassInfo, fn: FunctionInfo): void {
    if (fn.isDestructor) {
      fn.compiled = { slotCount: 0, locals: [], body: () => {} };
      return;
    }
    const isDeleted =
      (cls.base !== undefined && !this.isDefaultInitializable(classType(cls.base), cls, true)) ||
      cls.ownFields.some((field) => !field.initializer && !this.isDefaultInitializable(field.type, cls));
    if (isDeleted) {
      fn.isDeleted = true;
      return;
    }
    const implicit = this.implicitDefaultConstructor(cls);
    fn.compiled = implicit?.compiled ?? { slotCount: 0, locals: [], body: () => {} };
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
  // code-gauge-allow functionCognitiveComplexity -- A constructor initializes its base, then each member, from three possible sources.
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
      // A union makes a member with a constructor only when told to, since its other members share the room.
      if (cls.isUnion && !explicit && !field.initializer && !isTrivialUnionMember(field.type)) continue;
      const part = this.fieldInitialization(field, explicit);
      if (part) {
        parts.push(part);
        hasWork = true;
      }
    }
    if (!hasWork && !list && fn.params.length === 0) return undefined;
    if (cls.isUnion) {
      // The members of a union that hold objects are made alike, but only an initialized member is in use.
      const active = cls.ownFields.find((field) => initializers.has(field.name) || field.initializer)?.index;
      parts.push((frame) => {
        (frame.self?.read() as CObject).activeMember = active;
        return;
      });
    }
    return initializeInOrder(parts, base !== undefined, this.undoConstruction(cls));
  }

  /**
   * Destroys the members and the base a constructor has initialized, the last first, when an exception leaves the
   * constructor before the object is complete (C++20 [except.ctor]).
   */
  private undoConstruction(cls: ClassInfo): (frame: Frame, isBaseComplete: boolean, target?: CObject) => void {
    const destroyers = (cls.isUnion ? [] : cls.ownFields).map((field) => ({
      field,
      destroy: this.destroyerOf(field.type),
    }));
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
      if (node.type === 'template_type' || node.type === 'template_function' || node.type === 'template_method') {
        // `: Base<int>(...)` names the base with its template arguments.
        const name = fieldOf(node, 'name') as Syntax;
        const type = this.resolveTypeSpecifier({
          ...node,
          type: 'template_type',
          all: node.all.map((child) => (child === name ? { ...name, type: 'type_identifier' } : child)),
        });
        return type.kind === 'class' && type.cls === cls;
      }
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
    return expandPacks(this, argumentsNode?.children ?? []).map((arg) => this.argument(arg));
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
    // `: Base(other)` copies the base of an object of a derived class with the implicit copy constructor.
    const [source] = args;
    if (
      args.length === 1 &&
      source.type.kind === 'class' &&
      source.type.cls.isDerivedFrom(base) &&
      base.constructors.every((ctor) => ctor.native !== undefined || !isCopyConstructor(ctor, base))
    )
      return this.initializeBaseInPlace(base, this.objectInitializer(this.copyObject(source, base)));
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
        target.activeMember = source.activeMember;
      } catch (error) {
        if (error instanceof CppException) undo(frame, isBaseComplete, target);
        throw error;
      } finally {
        frame.pending.length = mark;
      }
    };
    const userAssignment = (cls.methods.get('operator=') ?? []).find(
      (fn) => fn.params.length === 1 && isCopyParameter(fn.params[0].type, cls)
    );
    const assignInto = (frame: Frame, target: CObject, source: CObject): void => {
      if (userAssignment) {
        if (userAssignment.isDeleted)
          throw new CppRuntimeError('custom', `${cls.name} のオブジェクトには代入できません（= delete）。`);
        const parameter = userAssignment.params[0].type;
        const argument = parameter.kind === 'reference' ? source.receiver(cls) : this.copyArgument(frame, cls, source);
        withTemporaries(frame, () =>
          invoke(frame, userAssignment, [argument], target.receiver(cls), userAssignment.row)
        );
        return;
      }
      if (base) base.operations?.assign(frame, target, source);
      for (const field of ownFields) {
        target.values[field.index] = assignValue(
          frame,
          field.type,
          target.values[field.index],
          source.values[field.index]
        );
      }
      target.activeMember = source.activeMember;
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

  /** A copy of an object for a parameter that takes it by value. */
  private copyArgument(frame: Frame, cls: ClassInfo, source: CObject): Value {
    return cls.operations?.copy(frame, source) ?? source;
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
    // A union leaves destroying its member in use to the code that knows which one it is.
    const members = (cls.isUnion ? [] : cls.ownFields)
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
    if (written.type === 'qualified_identifier' && fieldOf(written, 'name')?.type === 'operator_cast') {
      this.outOfClassDefinition(node, written);
      return;
    }
    const declarator = innermostFunctionDeclarator(written);
    if (!declarator) return this.error(node.row, '関数の定義には (...) で引数を書いてください。');
    const inner = fieldOf(declarator, 'declarator') as Syntax;
    if (inner.type === 'qualified_identifier') {
      this.outOfClassDefinition(node, inner);
      return;
    }
    if (!fieldOf(node, 'type')) return this.error(node.row, '関数の戻り値の型を書いてください。');
    const declared = this.applyDeclarator(this.specifiedType(node, true), written);
    const clause = specialDefinition(node);
    if (clause === 'default')
      this.error(
        node.row,
        `${declared.name ?? ''} には = default を付けられません（特別なメンバ関数ではありません）。`
      );
    const fn = this.declareFunction(node, declared, clause === undefined);
    if (clause === 'delete') {
      fn.isDeleted = true;
      fn.isDefined = true;
      return;
    }
    this.compileFunction(fn, node);
  }

  private declareFunction(node: Syntax, declared: Declared, isDefinition: boolean): FunctionInfo {
    if (this.hasSpecifier(node, 'virtual') || hasToken(node, 'virtual'))
      this.error(node.row, 'virtual はメンバ関数にしか付けられません。');
    const name = declared.name as string;
    if (name === 'main') this.checkMainSpecifiers(node);
    const fn = this.functionInfo(name, declared.type, declared.function as Syntax, node, undefined);
    if (name === 'main') {
      if (!sameType(fn.ret, INT)) this.error(node.row, 'main 関数の戻り値の型は int にしてください。');
      this.checkMainParameters(fn);
    }
    const existing = this.globalScope.names.get(name);
    if (existing && existing.kind !== 'functions')
      return this.error(node.row, `${name} はすでに別のものとして宣言されています。`);
    const overloads = existing?.kind === 'functions' ? existing.functions : [];
    let same = overloads.find((other) => !other.templatePattern && sameDeclaredSignature(other, fn));
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

  protected localFunctionDeclaration(declaration: Syntax, declared: Declared): LocalDeclaration {
    const fn = this.declareFunction(declaration, declared, false);
    this.context.scope.names.set(fn.name, { kind: 'functions', functions: [fn] });
    return { exec: () => {}, hasInitializer: false, createsObject: false };
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
    if (scope.kind === 'namespace' && scope.ns) {
      // `void geo::f() { ... }` defines a function its namespace declares.
      const saved = this.namespace;
      this.namespace = scope.ns;
      try {
        const declared = this.applyDeclarator(this.specifiedType(node, true), fieldOf(node, 'declarator') as Syntax);
        const existing = scope.ns.scope.names.get(declared.name ?? '');
        if (existing?.kind !== 'functions')
          return this.error(node.row, `${qualified.text} は名前空間 ${scope.ns.qualifiedName} で宣言されていません。`);
        this.compileFunction(this.declareFunction(node, declared, true), node);
      } finally {
        this.namespace = saved;
      }
      return;
    }
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
      const declared = this.applyDeclarator(ret, nameNode.type === 'operator_cast' ? nameNode : declarator);
      const probe = this.functionInfo(declared.name ?? '', declared.type, declared.function as Syntax, node, cls);
      let candidates: FunctionInfo[];
      if (nameNode.type === 'destructor_name') candidates = cls.destructor ? [cls.destructor] : [];
      else if (nameNode.text === cls.name && !typeNode) candidates = cls.constructors;
      else candidates = cls.methods.get(this.plainName(nameNode)) ?? [];
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

  /** Whether a class template's member function compiles when the program uses it (C++20 [temp.inst]). */
  private defersBody(fn: FunctionInfo): boolean {
    return !fn.isConstructor && !fn.isDestructor && !fn.isVirtual && fn.name !== 'operator=';
  }

  /** Compiles a function's body, binding its parameters to the first slots of its frame. */
  private compileFunction(fn: FunctionInfo, node: Syntax): void {
    if (this.defersBodies && this.defersBody(fn)) {
      const memberClass = this.memberClass;
      fn.lazyCompile = () => {
        const saved = this.memberClass;
        this.memberClass = memberClass;
        try {
          this.compileFunctionBody(fn, node);
        } finally {
          this.memberClass = saved;
        }
      };
      return;
    }
    if (fn.isInline && fn.name !== 'main') {
      this.inlineDependencies.set(
        fn,
        this.bindDependencies(() => this.compileFunctionBody(fn, node))
      );
      return;
    }
    this.compileFunctionBody(fn, node);
  }

  // Templates -------------------------------------------------------------------------------------------------------

  /** The entity a class template or an alias template's name denotes. */
  templateEntity(info: ClassTemplateInfo): Entity {
    return {
      kind: 'template',
      template: {
        name: info.name,
        program: info,
        instantiate: (args, row) => this.instantiateClassTemplate(info, args, row),
      },
    };
  }

  /** The class template a name (`Box`, `geo::Box`) denotes, which the program must have declared. */
  classTemplateNamed(name: Syntax): ClassTemplateInfo {
    const entity =
      name.type === 'qualified_identifier'
        ? this.lookupQualified(name, true)
        : this.lookupName(name.text, name.row, true);
    if (entity.kind !== 'template' || !entity.template.program || entity.template.program.kind !== 'class')
      return this.error(name.row, `${name.text} はクラステンプレートではありません。`);
    return entity.template.program;
  }

  /** The template a template type's name denotes, for deduction against an argument's class. */
  templateOfName(name: Syntax): object | string | undefined {
    const found =
      name.type === 'qualified_identifier' ? this.lookupQualified(name, true) : this.findName(name.text, true);
    // A class template's name in its own scope names the class, and with arguments the template.
    const entity = found && asTemplate(found);
    if (entity?.kind !== 'template') return undefined;
    return entity.template.program ?? entity.template.name;
  }

  /** The template arguments of a class that is an instance of a template, or undefined when it is not one. */
  instanceArguments(cls: ClassInfo, template: object | string | undefined): readonly Type[] | undefined {
    if (template === undefined) return undefined;
    if (typeof template === 'string') return cls.library?.kind === template ? cls.library.args : undefined;
    return cls.templateOrigin === template ? cls.templateArgs : undefined;
  }

  /** Runs `run` where a template instance's declarations are compiled: its namespace, its class, and its bindings. */
  inTemplate<T>(template: ProgramTemplate, bindings: TemplateBindings | undefined, run: () => T): T {
    const saved = {
      context: this.context,
      memberClass: this.memberClass,
      namespace: this.namespace,
      templateScopes: this.templateScopes,
    };
    this.context = new FunctionContext(undefined, undefined, VOID);
    this.memberClass = template.owner;
    this.namespace = template.namespace;
    this.templateScopes = bindings ? [...template.enclosing, bindings.scope] : [...template.enclosing];
    try {
      return run();
    } finally {
      this.context = saved.context;
      this.memberClass = saved.memberClass;
      this.namespace = saved.namespace;
      this.templateScopes = saved.templateScopes;
    }
  }

  /** Declares a function template's pattern among the functions of its name. */
  declareFunctionTemplate(pattern: FunctionInfo): void {
    const owner = pattern.owner;
    if (owner) {
      if (pattern.isConstructor) owner.constructors.push(pattern);
      else owner.methods.set(pattern.name, [...(owner.methods.get(pattern.name) ?? []), pattern]);
      return;
    }
    const existing = this.globalScope.names.get(pattern.name);
    if (existing && existing.kind !== 'functions')
      return this.error(pattern.row, `${pattern.name} はすでに別のものとして宣言されています。`);
    if (existing) existing.functions.push(pattern);
    else this.globalScope.names.set(pattern.name, { kind: 'functions', functions: [pattern] });
  }

  private functionTemplates(name: string, owner: ClassInfo | undefined): FunctionInfo[] {
    const functions = owner
      ? name === owner.name
        ? owner.constructors
        : (owner.methods.get(name) ?? [])
      : (() => {
          const entity = this.globalScope.names.get(name);
          return entity?.kind === 'functions' ? entity.functions : [];
        })();
    return functions.filter((fn) => fn.templatePattern);
  }

  /**
   * The function template of a name that a declaration with these template parameters and this function
   * declaration redeclares: the same number of template parameters and the same parameter types as written.
   */
  functionTemplateIfAny(
    name: string,
    owner: ClassInfo | undefined,
    count: number,
    declaration?: Syntax,
    overloadText?: string
  ): FunctionTemplateInfo | undefined {
    const patterns = this.functionTemplates(name, owner).map((fn) => fn.templatePattern as FunctionTemplateInfo);
    const signature = declaration && parameterSignature(declaration);
    return patterns.find(
      (pattern) =>
        pattern.parameters.length === count &&
        (overloadText === undefined || pattern.overloadText === overloadText) &&
        (signature === undefined || (pattern.node && parameterSignature(pattern.node) === signature))
    );
  }

  functionTemplateNamed(name: string, owner: ClassInfo | undefined, row: number): FunctionTemplateInfo {
    const [pattern] = this.functionTemplates(name, owner);
    if (!pattern) return this.error(row, `${name} は関数テンプレートではありません。`);
    return pattern.templatePattern as FunctionTemplateInfo;
  }

  /** Declares a function template's instance for its bindings, compiling its body when the program uses it. */
  declareTemplateFunction(info: FunctionTemplateInfo, bindings: TemplateBindings, node: Syntax): FunctionInfo {
    return this.inTemplate(info, bindings, () => {
      const written = fieldOf(node, 'declarator') as Syntax;
      const declared = this.applyDeclarator(fieldOf(node, 'type') ? this.specifiedType(node, true) : VOID, written);
      const fn = this.functionInfo(info.name, declared.type, declared.function as Syntax, node, info.owner);
      fn.isStatic = this.hasSpecifier(node, 'static');
      fn.isConstructor = info.owner !== undefined && info.name === info.owner.name;
      fn.access = info.access;
      fn.isTemplate = true;
      fn.isInline = true;
      fn.templateSpecificity = parameterSpecificity(node);
      this.checkTrailingDefaults(fn.params);
      this.bindDefaultArguments(fn);
      if (node.type === 'function_definition') {
        fn.isDefined = true;
        fn.definition = node;
        fn.lazyCompile = () => this.compileFunctionBody(fn, node);
      }
      return fn;
    });
  }

  /** The parameter types an explicit specialization of a function template declares. */
  declaredParameterTypes(node: Syntax): Type[] | undefined {
    const declarator = functionDeclarator(fieldOf(node, 'declarator') as Syntax);
    const parameters = declarator && fieldOf(declarator, 'parameters');
    return parameters ? this.parameterTypes(parameters) : undefined;
  }

  templateArgumentsOf(list: Syntax): Type[] {
    return this.templateArguments(list);
  }

  /** A value template argument converted to its parameter's type, which may name the parameters before it. */
  valueTemplateArgument(
    info: ProgramTemplate,
    bindings: TemplateBindings,
    parameter: TemplateParameter,
    value: number | bigint
  ): Type {
    const type = this.inTemplate(info, bindings, () =>
      this.typeDescriptor({
        ...(parameter.valueDeclaration as Syntax),
        all: (parameter.valueDeclaration as Syntax).all.filter(
          (child) => child.field !== 'declarator' && child.field !== 'default_value'
        ),
      })
    );
    if (type.kind !== 'int' || type.enumeration)
      return this.unsupported(info.node?.row ?? 0, `${typeName(type)} 型のテンプレート引数`);
    const { isConst: _, ...plain } = type;
    return {
      ...plain,
      templateValue: type.name === 'bool' ? Number(Number(value) !== 0) : convertTemplateValue(value, type),
    };
  }

  /** A parameter's default template argument, which may name the parameters before it. */
  defaultTemplateArgument(info: ProgramTemplate, bindings: TemplateBindings, parameter: TemplateParameter): Type {
    const node = parameter.defaultValue as Syntax;
    return this.inTemplate(info, bindings, () => {
      if (parameter.kind === 'type')
        return this.typeDescriptor(
          node.type === 'type_descriptor'
            ? node
            : {
                ...node,
                type: 'type_descriptor',
                all: [{ ...node, field: 'type' }],
                children: [{ ...node, field: 'type' }],
              }
        );
      const [argument] = this.templateArguments({ ...node, all: [node], children: [node] });
      return this.valueTemplateArgument(info, bindings, parameter, templateValue(argument) ?? 0);
    });
  }

  /** The instance of a class template or an alias template for template arguments. */
  instantiateClassTemplate(info: ClassTemplateInfo, written: Type[], row: number): Type {
    if (info.kind === 'variable') return this.error(row, `${info.name} は変数テンプレートなので、型ではありません。`);
    const bindings = this.bindTemplateArguments(info, written, row);
    const key = argumentsKey(bindings.args);
    const cached = info.instances.get(key);
    if (cached) return cached;
    if (!this.satisfies(info, bindings))
      return this.error(row, `${info.name}${argumentsText(bindings.args)} は、テンプレートの制約を満たしません。`);
    if (info.kind === 'alias') {
      const node = info.node as Syntax;
      const type = this.inTemplate(info, bindings, () => this.typeDescriptor(fieldOf(node, 'type') as Syntax));
      info.instances.set(key, type);
      return type;
    }
    return this.defineClassInstance(info, bindings, key, row);
  }

  /** The variable of a variable template's instance, which its first use defines with static storage. */
  protected override instantiateVariableTemplate(info: ClassTemplateInfo, written: Type[], row: number): Entity {
    const bindings = this.bindTemplateArguments(info, written, row);
    const key = argumentsKey(bindings.args);
    const cached = info.variables.get(key);
    if (cached) return cached;
    if (!this.satisfies(info, bindings))
      return this.error(row, `${info.name}${argumentsText(bindings.args)} は、テンプレートの制約を満たしません。`);
    const chosen = this.chooseSpecialization(info, bindings.args, row);
    const template: ProgramTemplate = { ...info, enclosing: chosen?.enclosing ?? info.enclosing };
    const entity = this.inTemplate(template, chosen?.bindings ?? bindings, () => {
      // Each instance is declared in a namespace of its own, so that instances of one template do not collide.
      const instanceNamespace = new NamespaceInfo(`${info.name}${argumentsText(bindings.args)}`, info.namespace);
      this.namespace = instanceNamespace;
      this.globalDeclaration(chosen?.node ?? (info.node as Syntax));
      return instanceNamespace.member(info.name) as Entity;
    });
    info.variables.set(key, entity);
    return entity;
  }

  private bindTemplateArguments(info: ClassTemplateInfo, written: Type[], row: number): TemplateBindings {
    const bindings = new TemplateBindings();
    for (const [index, parameter] of info.parameters.entries()) {
      if (parameter.isPack) {
        bindings.bind(parameter, written.slice(index));
        break;
      }
      let argument: Type | undefined = written[index];
      if (!argument && parameter.defaultValue) argument = this.defaultTemplateArgument(info, bindings, parameter);
      if (!argument) return this.error(row, `${info.name} のテンプレート引数が足りません。`);
      const value = templateValue(argument);
      if ((parameter.kind === 'value') !== (value !== undefined))
        return this.error(
          row,
          `${info.name} の ${index + 1} 番目のテンプレート引数には、${parameter.kind === 'value' ? '値' : '型'}を書いてください。`
        );
      if (parameter.kind === 'value')
        argument = this.valueTemplateArgument(info, bindings, parameter, value as number | bigint);
      bindings.bind(parameter, argument);
    }
    if (!info.parameters.some((parameter) => parameter.isPack) && written.length > info.parameters.length)
      return this.error(row, `${info.name} のテンプレート引数が多すぎます。`);
    return bindings;
  }

  private defineClassInstance(info: ClassTemplateInfo, bindings: TemplateBindings, key: string, row: number): Type {
    const chosen = this.chooseSpecialization(info, bindings.args, row);
    const node = chosen?.node ?? info.node;
    const cls = new ClassInfo(info.name, node ? classKey(node) : 'class');
    cls.row = node?.row ?? row;
    cls.templateOrigin = info;
    cls.templateArgs = bindings.args;
    cls.templateEntity = this.templateEntity(info);
    cls.namespace = info.namespace;
    cls.outer = info.owner;
    const type = classType(cls);
    info.instances.set(key, type);
    const instanceBindings = chosen?.bindings ?? bindings;
    const body = node && fieldOf(node, 'body');
    if (!node || !body) return type;
    const template: ProgramTemplate = { ...info, enclosing: chosen?.enclosing ?? info.enclosing };
    this.inTemplate(template, instanceBindings, () => {
      cls.templateScopes = [...this.templateScopes];
      const savedDefers = this.defersBodies;
      this.defersBodies = true;
      try {
        this.defineClass(cls, node, body);
        for (const member of info.outOfClassMembers) this.defineTemplateMember(cls, member);
      } finally {
        this.defersBodies = savedDefers;
      }
    });
    return type;
  }

  /** The specialization of a class template whose arguments match best, with its parameters' bindings. */
  private chooseSpecialization(
    info: ClassTemplateInfo,
    args: readonly Type[],
    row: number
  ): { node: Syntax; bindings: TemplateBindings; enclosing: Scope[] } | undefined {
    const key = argumentsKey(args);
    let best: { node: Syntax; bindings: TemplateBindings; enclosing: Scope[]; score: number } | undefined;
    for (const spec of info.specializations) {
      const list = fieldOf(fieldOf(spec.node, 'name') as Syntax, 'arguments') as Syntax;
      if (spec.parameters.length === 0) {
        const specArgs = this.inTemplate({ ...info, enclosing: spec.enclosing }, undefined, () =>
          this.templateArguments(list)
        );
        if (argumentsKey(specArgs) === key)
          return { node: spec.node, bindings: new TemplateBindings(), enclosing: spec.enclosing };
        continue;
      }
      const deduction = new Deduction(this, spec.parameters);
      // A pack expansion last (`template <class H, class... R> struct S<H, R...>`) takes the arguments left over.
      const last = list.children.at(-1);
      const packPattern = last?.type === 'parameter_pack_expansion' ? fieldOf(last, 'pattern') : undefined;
      const packName = packPattern?.type === 'type_descriptor' ? fieldOf(packPattern, 'type')?.text : packPattern?.text;
      const pack = spec.parameters.find((parameter) => parameter.isPack && parameter.name === packName);
      const fixed = pack ? list.children.slice(0, -1) : list.children;
      if (pack ? args.length < fixed.length : args.length !== fixed.length) continue;
      if (pack) deduction.bindPack(pack.name as string, args.slice(fixed.length));
      // The names in the specialization's arguments are those its declaration sees.
      const matches = this.inTemplate({ ...info, enclosing: spec.enclosing }, undefined, () =>
        fixed.every((argument, index) => {
          const actual = args[index];
          if (!actual) return false;
          const value = templateValue(actual);
          if (argument.type === 'type_descriptor') {
            const named = fieldOf(argument, 'type') as Syntax;
            const parameter = spec.parameters.find((candidate) => candidate.name === named.text);
            if (parameter?.kind === 'value' && !fieldOf(argument, 'declarator'))
              return value !== undefined && deduction.bindValue(named.text, value);
            return (
              value === undefined &&
              deduction.matchSpecializationArgument(
                deduction.pattern(argument, fieldOf(argument, 'declarator')),
                actual
              )
            );
          }
          if (value === undefined) return false;
          if (argument.type === 'identifier' && spec.parameters.some((parameter) => parameter.name === argument.text))
            return deduction.bindValue(argument.text, value);
          // A specialization for a value (`template <class T> struct S<true, T>`) matches that value.
          const fixed = this.inTemplate({ ...info, enclosing: spec.enclosing }, undefined, () =>
            templateValue(this.templateArguments({ ...list, children: [argument], all: [argument] })[0])
          );
          return fixed !== undefined && BigInt(fixed) === BigInt(value);
        })
      );
      if (!matches) continue;
      const bindings = new TemplateBindings();
      let complete = true;
      for (const parameter of spec.parameters) {
        const name = parameter.name ?? '';
        if (parameter.isPack) bindings.bind(parameter, deduction.packs.get(name) ?? []);
        else if (parameter.kind === 'value' && deduction.values.has(name))
          bindings.bind(
            parameter,
            this.valueTemplateArgument(
              { ...info, enclosing: spec.enclosing },
              bindings,
              parameter,
              deduction.values.get(name) as number | bigint
            )
          );
        else if (deduction.types.has(name)) bindings.bind(parameter, deduction.types.get(name) as Type);
        else complete = false;
      }
      if (!complete) continue;
      const score = specificity(list);
      if (best && best.score === score)
        return this.error(
          row,
          `${info.name}${argumentsText(args)} に合う部分特殊化が複数あり、どれを使うのか決まりません。`
        );
      if (!best || score > best.score) best = { node: spec.node, bindings, enclosing: spec.enclosing, score };
    }
    return best;
  }

  /** Defines a class template's member that the program defines outside the class, for one instance. */
  defineTemplateMember(
    cls: ClassInfo,
    member: { parameters: TemplateParameter[]; memberParameters: TemplateParameter[]; node: Syntax; qualified: Syntax }
  ): void {
    const scope = fieldOf(member.qualified, 'scope') as Syntax;
    const list = fieldOf(scope, 'arguments') as Syntax;
    const classParameters = member.parameters.slice(0, member.parameters.length - member.memberParameters.length);
    const deduction = new Deduction(this, classParameters);
    const args = cls.templateArgs ?? [];
    for (const [index, argument] of list.children.entries()) {
      const actual = args[index];
      const value = actual && templateValue(actual);
      const named = argument.type === 'type_descriptor' ? fieldOf(argument, 'type') : argument;
      if (value !== undefined && named) deduction.bindValue(named.text, value);
      else if (actual && argument.type === 'type_descriptor')
        deduction.match(deduction.pattern(argument, fieldOf(argument, 'declarator')), actual);
    }
    const bindings = new TemplateBindings();
    for (const parameter of classParameters) {
      const name = parameter.name ?? '';
      const value = deduction.values.get(name);
      bindings.bind(
        parameter,
        value === undefined
          ? (deduction.types.get(name) as Type)
          : this.valueTemplateArgument(
              {
                name: cls.name,
                parameters: classParameters,
                node: member.node,
                namespace: cls.namespace,
                owner: undefined,
                enclosing: [],
              },
              bindings,
              parameter,
              value
            )
      );
    }
    const template: ProgramTemplate = {
      name: cls.name,
      parameters: classParameters,
      node: member.node,
      namespace: cls.namespace,
      owner: undefined,
      enclosing: (cls.templateOrigin as ClassTemplateInfo).enclosing,
    };
    if (member.memberParameters.length > 0) {
      // A member template's definition, which its pattern in the instance uses.
      const name = this.plainName(fieldOf(member.qualified, 'name') as Syntax);
      const pattern = this.functionTemplateIfAny(name, cls, member.memberParameters.length);
      if (pattern) pattern.node = member.node;
      return;
    }
    this.inTemplate(template, bindings, () => {
      const savedDefers = this.defersBodies;
      this.defersBodies = true;
      try {
        this.outOfClassDefinition(member.node, member.qualified);
      } finally {
        this.defersBodies = savedDefers;
      }
    });
  }

  /** `template class Box<int>;`, which instantiates a class template's members. */
  private explicitInstantiation(node: Syntax): void {
    const typeNode = fieldOf(node, 'type');
    if (!typeNode) return this.unsupported(node.row, '関数テンプレートの明示的な実体化');
    const nameNode = fieldOf(typeNode, 'name') ?? typeNode;
    const type = this.resolveTypeSpecifier(nameNode, false, true);
    if (type.kind !== 'class') return this.error(node.row, `${typeNode.text} はクラスではありません。`);
    for (const methods of type.cls.methods.values()) {
      for (const fn of methods) if (!fn.templatePattern && fn.isDefined) this.checkDefined(fn, node.row);
    }
  }

  /**
   * Whether a template's arguments satisfy its constraints: its parameters' type constraints and its `requires`
   * clauses (C++20 [temp.constr.decl]).
   */
  satisfies(info: ProgramTemplate, bindings: TemplateBindings): boolean {
    return this.inTemplate(info, bindings, () => {
      for (const parameter of info.parameters) {
        if (!parameter.constraint || !parameter.name) continue;
        const entity = bindings.scope.names.get(parameter.name);
        const types = entity?.kind === 'pack' ? entity.items : entity ? [entity] : [];
        for (const item of types) {
          if (item.kind === 'type' && !satisfiesTypeConstraint(this, parameter.constraint, item.type)) return false;
        }
      }
      return (info.constraints ?? []).every((constraint) => evaluateConstraint(this, constraint));
    });
  }

  protected conceptId(node: Syntax): Expr | undefined {
    const named = node.type === 'qualified_identifier' ? fieldOf(node, 'name') : node;
    if (named?.type !== 'template_function') return undefined;
    const nameNode =
      node.type === 'qualified_identifier'
        ? { ...node, all: node.all.map((child) => (child === named ? (fieldOf(named, 'name') as Syntax) : child)) }
        : (fieldOf(named, 'name') as Syntax);
    const concept = conceptNamed(this, nameNode);
    if (!concept) return undefined;
    const args = this.templateArguments(fieldOf(named, 'arguments') as Syntax);
    return constantExpr(BOOL, satisfiesConcept(this, concept, args, node.row) ? 1 : 0, node.row);
  }

  /** Runs `run` where a template's parameters are bound, as checking a constraint does. */
  inTemplateOf<T>(template: ProgramTemplate, bindings: TemplateBindings, run: () => T): T {
    return this.inTemplate(template, bindings, run);
  }

  /** Runs `run` where a requires expression's parameters are declared. */
  withRequiresParameters<T>(list: Syntax | undefined, run: () => T): T {
    let result: T | undefined;
    this.withNames((declare) => {
      if (list) this.declareParameterNames(list, declare);
      result = run();
    });
    return result as T;
  }

  declareConcept(parameters: TemplateParameter[], node: Syntax): void {
    const name = (fieldOf(node, 'name') as Syntax).text;
    const expression = node.children.find((child) => child.field !== 'name') as Syntax;
    const info: ConceptInfo = {
      kind: 'concept',
      name,
      parameters,
      node: expression,
      namespace: this.namespace,
      owner: undefined,
      enclosing: [...this.templateScopes],
    };
    this.declareHere(
      name,
      {
        kind: 'template',
        template: {
          name,
          program: info,
          instantiate: (_args, row) => this.error(row, `コンセプト ${name} は型ではありません。`),
        },
      },
      node.row
    );
  }

  lambdaExpression(node: Syntax): Expr {
    return compileLambda(this, node);
  }

  /** Compiles a lambda's body as its closure type's function call operator, which sees the lambda's captures. */
  compileLambdaBody(fn: FunctionInfo, node: Syntax, captures: CaptureLookup): void {
    this.lambdaCaptures.set(captures.closure, captures);
    this.compileFunctionBody(fn, node);
  }

  /** Declares a generic lambda's function call operator, a member template whose instances see its captures. */
  declareGenericLambda(
    closure: ClassInfo,
    node: Syntax,
    parameters: TemplateParameter[],
    captures: CaptureLookup
  ): void {
    this.lambdaCaptures.set(closure, captures);
    const declarator = functionDeclarator(fieldOf(node, 'declarator') as Syntax);
    const list = declarator && fieldOf(declarator, 'parameters');
    const { node: rewritten, parameters: all } = list ? inventParameters(node, list, parameters) : { node, parameters };
    declareFunctionTemplate(this, all, [], rewritten, closure, 'public', undefined);
  }

  /** The enclosing object a lambda's body uses: what the captured `this` points to, or the captured copy. */
  capturedThisObject(capture: { field: FieldInfo; byCopy: boolean }, row: number): Expr {
    const closure = classType(capture.field.owner, this.context.isConstMember);
    const self: Expr = { type: closure, isLvalue: true, isThis: true, row, run: (frame) => thisLocation(frame) };
    const member = this.fieldAccess(self, capture.field, row);
    return capture.byCopy ? member : this.dereference(this.rvalue(member), row);
  }

  referenceInitializer(type: Extract<Type, { kind: 'reference' }>, expr: Expr, row: number): Initializer {
    return this.constructorReference(type, expr, row, true) as Initializer;
  }

  private compileFunctionBody(fn: FunctionInfo, node: Syntax): void {
    // A function's body sees the names of the namespace it is a member of and of its template's parameters.
    const savedNamespace = this.namespace;
    const savedTemplates = this.templateScopes;
    const savedDefers = this.defersBodies;
    this.namespace = fn.namespace ?? namespaceOf(fn.owner);
    this.templateScopes = fn.templateScopes ?? fn.owner?.templateScopes ?? [];
    this.defersBodies = false;
    try {
      this.compileFunctionBodyIn(fn, node);
    } finally {
      this.namespace = savedNamespace;
      this.templateScopes = savedTemplates;
      this.defersBodies = savedDefers;
    }
  }

  private compileFunctionBodyIn(fn: FunctionInfo, node: Syntax): void {
    const cls = fn.owner;
    const context = new FunctionContext(fn, cls, fn.isConstructor || fn.isDestructor ? VOID : fn.ret);
    context.captures = fn.owner?.isLambda ? this.lambdaCaptures.get(fn.owner) : undefined;
    // A member function of a local class sees the names of the blocks around the class.
    for (let outer = cls; outer; outer = outer.outer) {
      if (outer.localScopes) {
        context.outerScopes.push(...outer.localScopes);
        break;
      }
    }
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
        const entity: Entity = { kind: 'local', local, isReference: type.kind === 'reference' };
        if (param.pack) {
          // The elements of a function parameter pack make the pack its name denotes.
          const pack = scope.names.get(param.pack);
          if (pack?.kind === 'pack') pack.items.push(entity);
          else scope.names.set(param.pack, { kind: 'pack', items: [entity] });
        } else if (param.name) {
          if (scope.names.has(param.name)) this.error(param.row, `引数 ${param.name} の名前が重複しています。`);
          scope.names.set(param.name, entity);
        }
      }
      // A function parameter pack with no elements is still a pack.
      const declarator = fieldOf(node, 'declarator');
      const written = declarator && functionDeclarator(declarator);
      for (const param of (written && fieldOf(written, 'parameters')?.children) ?? []) {
        const packDeclarator =
          param.type === 'variadic_parameter_declaration' ? fieldOf(param, 'declarator') : undefined;
        const inner = packDeclarator && withoutEllipsis(packDeclarator);
        const name = inner && this.applyDeclarator(INT, inner).name;
        if (name && !scope.names.has(name)) scope.names.set(name, { kind: 'pack', items: [] });
      }
      // A function-try-block (`A() try : x(f()) { } catch (...) { }`) catches what the member initializers and the
      // body throw; the grammar gives a constructor's no `body` field.
      const body = fieldOf(node, 'body') ?? node.children.find((child) => child.type === 'try_statement');
      if (!body) return this.error(node.row, `${fn.displayName} の本体を書いてください。`);
      const isTryBlock = body.type === 'try_statement';
      const initializerList = (isTryBlock ? body : node).children.find(
        (child) => child.type === 'field_initializer_list'
      );
      const initialization = fn.isConstructor && cls ? this.memberInitialization(cls, fn, initializerList) : undefined;
      if (!fn.isConstructor && initializerList) {
        this.error(node.row, 'メンバの初期化子の並び（: x(...)）は、コンストラクタにしか書けません。');
      }
      const memberInit = isTryBlock ? undefined : initialization;
      const statements = isTryBlock
        ? this.functionTryBlock(body, initialization, fn.isConstructor || fn.isDestructor)
        : this.compileStatements(body.children);
      context.endBody();
      // A function whose `auto` return type no `return` statement decided returns nothing.
      if (hasAuto(context.returnType)) {
        context.returnType = VOID;
        fn.ret = VOID;
      }
      for (const { label, row, isReachable } of context.gotos) {
        if (!context.labels.has(label)) this.error(row, `ラベル ${label} はありません。`);
        if (!isReachable) this.unsupported(row, 'ループや if・switch の中のラベルへ、その外から goto で移ること');
      }
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
    if (declareDeductionGuide(this, [], node)) return;
    const typeNode = fieldOf(node, 'type');
    const declarators = fieldsOf(node, 'declarator');
    if (declarators.length === 0) {
      if (
        typeNode?.type === 'class_specifier' ||
        typeNode?.type === 'struct_specifier' ||
        typeNode?.type === 'union_specifier' ||
        typeNode?.type === 'enum_specifier'
      ) {
        this.resolveTypeSpecifier(typeNode);
        return;
      }
      return this.error(node.row, '宣言する名前を書いてください。');
    }
    // The specified type defines the class of `struct P { ... } origin;`.
    const base = this.declarationType(node);
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
      const type = this.globalVariable(
        declarator,
        name,
        declared.type,
        this.isConstexpr(node),
        this.hasSpecifier(node, 'extern')
      );
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

  private globalVariable(
    declarator: Syntax,
    name: string,
    declaredType: Type,
    isConstexpr: boolean,
    isExtern = false
  ): Type {
    const value = declarator.type === 'init_declarator' ? fieldOf(declarator, 'value') : undefined;
    const existing = this.globalScope.names.get(name);
    // `extern int g;` declares a variable that a later declaration defines (C++20 [basic.def]).
    if (existing?.kind === 'global' && this.externGlobals.has(existing.global)) {
      if (!sameType(existing.global.type, declaredType))
        return this.error(declarator.row, `変数 ${name} の型が、前の extern の宣言と違います。`);
      if (isExtern && !value) return declaredType;
      if (existing.global.isDefined) return this.error(declarator.row, `変数 ${name} はすでに定義されています。`);
      existing.global.isDefined = true;
      existing.constant = this.initializeGlobal(
        existing.global,
        declaredType,
        value,
        declarator.row,
        !hasToken(declarator, '=')
      );
      return declaredType;
    }
    if (existing) return this.error(declarator.row, `${name} はすでに宣言されています。`);
    if (isExtern && !value) {
      const global = this.declareStaticStorage(this.namespacedName(name), declaredType, declarator.row, true);
      this.externGlobals.add(global);
      this.globalScope.names.set(name, { kind: 'global', global, isReference: false });
      return declaredType;
    }
    let type = declaredType;
    if (type.kind === 'reference') return this.globalReference(name, type, declarator, isConstexpr);
    if (hasAuto(type))
      type = this.deduceAuto(
        type,
        this.withInitializingName(
          name,
          type,
          () => this.compileExpression(this.autoInitializer(declarator, value, name)),
          this.globalScope.names
        ),
        declarator.row
      );
    if (type.kind === 'array' && type.length === undefined && value) type = this.completeArrayType(type, value);
    if (type.kind === 'array' && type.length === undefined)
      return this.error(declarator.row, `配列 ${name} の大きさを書いてください。`);
    if (type.kind === 'void') return this.error(declarator.row, `void 型の変数 ${name} は作れません。`);
    const isConstant = isConstType(type) && isArithmetic(type);
    const global = this.declareStaticStorage(this.namespacedName(name), type, declarator.row, !isConstant);
    global.isDefined = true;
    global.isConstexpr = isConstexpr;
    global.isConstexprPointer = isConstexpr && type.kind === 'pointer';
    const direct = !hasToken(declarator, '=');
    const entity: Extract<Entity, { kind: 'global' }> = { kind: 'global', global, isReference: false };
    this.globalScope.names.set(name, entity);
    if (isConstexpr) entity.constant = this.requireConstantInitializer(type, value, declarator.row, direct);
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
    const binding = this.bindReference(name, declared, declarator, this.globalScope.names);
    const global = this.declareStaticStorage(this.namespacedName(name), binding.type, row, true);
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

  /** A name with the namespace whose declarations are compiled now, such as `cfg::level`, as the trace shows it. */
  private namespacedName(name: string): string {
    return this.namespace ? `${this.namespace.qualifiedName}::${name}` : name;
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
      if (isConstType(type) && isArithmetic(type)) global.isShown = !init.isConstant;
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
      const args = expandPacks(this, value.children).map((arg) => this.argument(arg));
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
      if (this.deducesArrays && sameType(unqualified(expr.type), unqualified(type), false))
        return this.arrayCopy(type, expr, row);
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

  /** A copy of an array, element by element, which only a structured binding's hidden variable makes. */
  private arrayCopy(type: Extract<Type, { kind: 'array' }>, source: Expr, row: number): Initializer {
    const sources: Ptr[] = [];
    const element: Expr = {
      type: source.type.kind === 'array' ? source.type.of : type.of,
      isLvalue: true,
      row,
      run: () => sources.at(-1) as Ptr,
    };
    const copy = this.copyInitializer(type.of, element, row, false);
    const destroy = this.destroyerOf(type.of);
    const locate = this.rvalue(source).run;
    return (frame, target) => {
      const array = locate(frame) as Ptr;
      return constructArray(
        frame,
        type.length ?? 0,
        type.of,
        (f, storage, index) => {
          sources.push(array.offset(index));
          try {
            return copy(f, storage);
          } finally {
            sources.pop();
          }
        },
        destroy,
        target instanceof ArrayStore ? target : undefined
      );
    };
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
      const constructed = this.constructWith(cls, resolved, [], row);
      // A default constructor that is not user-provided zero-initializes the object first (C++20 [dcl.init]p8).
      if (!isValueInitialized || !resolved.fn.isDefaulted) return constructed;
      const { run } = constructed;
      return { ...constructed, run: (frame, _zero, destination, lifetime) => run(frame, true, destination, lifetime) };
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
    return this.initializeList(type, expandPacks(this, list.children), row, direct);
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
      elements.length === 1 && elements[0].type !== 'initializer_list' && elements[0].type !== 'initializer_pair'
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
  isAggregateClass(cls: ClassInfo): boolean {
    return this.isAggregate(cls);
  }

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
    // Braces without designators initialize the first member of a union.
    const members = cls.ownFields.slice(0, cls.isUnion ? 1 : undefined).map((field) => field.type);
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
    const elements = expandPacks(this, list.children);
    const literal = this.bracedStringLiteral(type, elements);
    if (literal) return (literal.literalBytes as string).length + 1;
    const clauses: Clauses = { nodes: elements, next: 0, compiled: new Map() };
    return this.takeArrayElements(type.of, Infinity, clauses, list.row).length;
  }

  protected bracedArrayInitializers(element: Type, list: Syntax): Initializer[] {
    const elements = expandPacks(this, list.children);
    const literal = this.bracedStringLiteral({ kind: 'array', of: element }, elements);
    const bytes = literal?.literalBytes;
    if (bytes !== undefined) {
      const signed = element.kind === 'int' && element.name !== 'uchar';
      return Array.from({ length: bytes.length + 1 }, (_, index) => {
        const value = characterValue(bytes, index, signed);
        return () => value;
      });
    }
    const clauses: Clauses = { nodes: elements, next: 0, compiled: new Map() };
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
    if (isDesignated(clauses)) return this.designatedElements(element, limit, clauses, row);
    const taken: (() => Initializer)[] = [];
    while (taken.length < limit && clauses.next < clauses.nodes.length)
      taken.push(this.takeClauses(element, clauses, row));
    return taken;
  }

  /**
   * The elements of an array that a designated initializer list (`{[1] = 5, [3 ... 4] = 7}`, a C99 and GNU extension
   * clang++ accepts) initializes, by index, with the next clause after each designated one.
   */
  private designatedElements(element: Type, limit: number, clauses: Clauses, row: number): (() => Initializer)[] {
    const slots: (() => Initializer)[] = [];
    let position = 0;
    for (const node of clauses.nodes.slice(clauses.next)) {
      let [first, last] = [position, position];
      let value = node;
      const designators = node.type === 'initializer_pair' ? fieldsOf(node, 'designator') : [];
      if (designators.length > 0) {
        const designator = designators[0];
        if (designator.type === 'field_designator') return this.error(node.row, '配列の初期値に .名前 は書けません。');
        const bound = (field: string): number => {
          const expr = this.rvalue(this.compileExpression(fieldOf(designator, field) ?? designator.children[0]));
          if (expr.constant === undefined || !isInteger(expr.type))
            return this.error(node.row, '配列の添字の指定には整数の定数式を書いてください。');
          return Number(expr.constant);
        };
        first = designator.type === 'subscript_range_designator' ? bound('start') : bound('');
        last = designator.type === 'subscript_range_designator' ? bound('end') : first;
        value = this.nestedDesignation(node, designators.slice(1));
      }
      if (first < 0 || last >= limit || first > last)
        return this.error(node.row, `配列の添字の指定 ${node.text.split('=')[0].trim()} が範囲を超えています。`);
      for (let index = first; index <= last; index++) {
        slots[index] = this.takeClauses(element, { nodes: [value], next: 0, compiled: clauses.compiled }, row);
      }
      position = last + 1;
    }
    clauses.next = clauses.nodes.length;
    const zero = (): Initializer => this.initializeList(element, [], row);
    return Array.from({ length: slots.length }, (_, index) => slots[index] ?? zero);
  }

  /** The value a designator list's later designators initialize (`.p.x = 3` makes `.p = {.x = 3}`). */
  private nestedDesignation(node: Syntax, rest: Syntax[]): Syntax {
    const value = fieldOf(node, 'value') as Syntax;
    if (rest.length === 0) return value;
    const pair: Syntax = { ...node, all: [...rest, value], children: [...rest, value] };
    return { ...node, type: 'initializer_list', all: [pair], children: [pair] };
  }

  /**
   * The members a designated initializer list (`{.x = 1, .y = 2}`) initializes, by name, with the next member after
   * each designated one; the ones it leaves out take their default member initializers.
   */
  private designatedMembers(cls: ClassInfo, clauses: Clauses, row: number): () => Initializer {
    if (cls.base) return this.error(row, '親クラスのある集成体には、指示付きの初期化子を書けません。');
    const fields = cls.ownFields;
    const grouped: Syntax[][] = fields.map(() => []);
    const direct = new Map<number, Syntax>();
    let position = 0;
    for (const node of clauses.nodes.slice(clauses.next)) {
      const designators = node.type === 'initializer_pair' ? fieldsOf(node, 'designator') : [];
      let index = position;
      if (designators.length > 0) {
        const designator = designators[0];
        if (designator.type !== 'field_designator')
          return this.error(node.row, 'クラスの初期値に [添字] は書けません。');
        const name = designator.children[0].text;
        index = fields.findIndex((field) => field.name === name);
        if (index < 0) return this.error(node.row, `${cls.name} に ${name} というメンバはありません。`);
      }
      if (index >= fields.length) return this.error(node.row, `${cls.name} を初期化する {...} の値が多すぎます。`);
      if (designators.length > 1) {
        const nested: Syntax = {
          ...node,
          all: [...designators.slice(1), fieldOf(node, 'value') as Syntax],
          children: [...designators.slice(1), fieldOf(node, 'value') as Syntax],
        };
        grouped[index].push(nested);
        direct.delete(index);
      } else {
        direct.set(index, designators.length > 0 ? (fieldOf(node, 'value') as Syntax) : node);
        grouped[index] = [];
      }
      position = index + 1;
    }
    clauses.next = clauses.nodes.length;
    const taken = fields.map((field, index) => {
      const value = direct.get(index);
      const nested = grouped[index];
      if (!value && nested.length === 0) return;
      const node = value ?? { ...nested[0], type: 'initializer_list', all: nested, children: nested };
      return this.takeClauses(field.type, { nodes: [node], next: 0, compiled: clauses.compiled }, row);
    });
    return () =>
      this.initializeAggregate(
        cls,
        taken.map((take) => take?.()),
        row
      );
  }

  private takeMemberClauses(cls: ClassInfo, clauses: Clauses, row: number): () => Initializer {
    if (isDesignated(clauses)) return this.designatedMembers(cls, clauses, row);
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
    const made = cls.isUnion
      ? fields.length > 0
        ? [unionMemberToInitialize(fields, supplied)]
        : []
      : fields.map((_, index) => index);
    const defaults = fields.map((field, index) =>
      supplied[index] || !made.includes(index)
        ? undefined
        : (this.aggregateDefaults.get(field)?.() ?? this.bindAggregateDefault(field, row))
    );
    const destroyers = fields.map((field) => this.destroyerOf(field.type));
    const isConstant =
      (!initializeBase || initializeBase.isConstant === true) &&
      this.constantAggregate(
        made.map((index) => fields[index]),
        made.map((index) => supplied[index]),
        made.map((index) => defaults[index])
      );
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
          made.length,
          (position) => {
            const index = made[position];
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
          (position) => destroyers[made[position]]
        );
        if (cls.isUnion) {
          for (const field of fields) {
            if (
              object.values[field.index] === UNINIT &&
              (field.type.kind === 'class' || field.type.kind === 'array') &&
              isTrivialUnionMember(field.type)
            )
              object.values[field.index] = staticZero(frame.runtime, field.type, object.location(field.index));
          }
          object.activeMember = fields[made[0]]?.index;
        }
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
    const found = new Set(functions);
    if (args.some((arg) => this.library.isStdType(arg.type))) {
      const std = this.findStdName(name);
      if (std?.kind === 'functions') for (const fn of std.functions) found.add(fn);
    }
    // The namespaces of the arguments' classes add their functions of that name (C++20 [basic.lookup.argdep]).
    for (const arg of args) {
      const ns = namespaceOf(argumentClass(arg.type));
      const member = ns?.member(name);
      if (member?.kind === 'functions') for (const fn of member.functions) found.add(fn);
    }
    return [...found];
  }

  checkDefined(fn: FunctionInfo, row: number): void {
    if (fn.isDeleted) this.error(row, `削除された関数 ${fn.displayName} は使えません（= delete）。`);
    const compile = fn.lazyCompile;
    if (compile) {
      fn.lazyCompile = undefined;
      compile();
    }
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
    const constant = this.constantValueOf(expr);
    if (constant === undefined) {
      return this.unsupported(size.row, '大きさが定数でない配列（可変長配列）');
    }
    const length = Number(constant);
    if (length < 0) return this.error(size.row, '配列の大きさは負にできません。');
    if (!Number.isSafeInteger(length)) return this.error(size.row, '配列の大きさが大きすぎます。');
    return length;
  }
}

class TemporaryConstructorReferenceError extends CompileError {}

function sameDeclaredSignature(a: FunctionInfo, b: FunctionInfo): boolean {
  return !a.instantiate && !b.instantiate && a.refQualifier === b.refQualifier && sameParameters(a, b);
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
/** Whether a braced list's clauses designate what they initialize (`{.x = 1}`, `{[2] = 3}`). */
function isDesignated(clauses: Clauses): boolean {
  return clauses.next === 0 && clauses.nodes.some((node) => node.type === 'initializer_pair');
}

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
    for (const [index, item] of sourceArray.values.entries()) {
      frame.runtime.spend();
      targetArray.values[index] = assignValue(frame, type.of, targetArray.values[index], item);
    }
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
/** A declarator without its `...`, which a function parameter pack's declarator has (`Ts&... xs`). */
function withoutEllipsis(node: Syntax): Syntax | undefined {
  if (node.type === 'variadic_declarator') return node.children[0] && { ...node.children[0], field: node.field };
  const all = node.all.flatMap((child) => {
    if (!child.isNamed) return child.type === '...' ? [] : [child];
    const inner = withoutEllipsis(child);
    return inner ? [inner] : [];
  });
  return { ...node, all, children: all.filter((child) => child.isNamed) };
}

/** A qualified name's last name and the scope before it (`std::runtime_error` of `std::runtime_error::what`). */
function splitQualified(node: Syntax): { scope: Syntax; name: Syntax } {
  const scope = fieldOf(node, 'scope') as Syntax;
  const name = fieldOf(node, 'name') as Syntax;
  if (name.type !== 'qualified_identifier') return { scope, name };
  const inner = splitQualified(name);
  const all = node.all.map((child) => (child === name ? { ...inner.scope, field: 'name' } : child));
  return { scope: { ...node, all, children: all.filter((child) => child.isNamed) }, name: inner.name };
}

/** The class whose namespace argument-dependent lookup searches for an argument of a type. */
function argumentClass(type: Type): ClassInfo | undefined {
  const target = type.kind === 'pointer' || type.kind === 'reference' ? type.to : type;
  return target.kind === 'class' && !target.cls.library ? target.cls : undefined;
}

/** A function declaration's parameter types as written, without the parameters' names, to match redeclarations. */
function parameterSignature(node: Syntax): string {
  const declarator = functionDeclarator(fieldOf(node, 'declarator') as Syntax);
  const parameters = declarator ? fieldOf(declarator, 'parameters') : undefined;
  return (parameters?.children ?? [])
    .map((parameter) => {
      const type = fieldOf(parameter, 'type')?.text ?? '';
      const written = fieldOf(parameter, 'declarator');
      const shape = written ? written.text.replaceAll(/[\p{L}_][\p{L}\p{N}_]*/gu, '') : '';
      const isConst = parameter.children.some((child) => child.type === 'type_qualifier') ? 'const ' : '';
      return `${isConst}${type}${shape}`.replaceAll(/\s+/g, '');
    })
    .join(',');
}

/** How much a function template's parameter types constrain their arguments: pointers, arrays, and instances. */
function parameterSpecificity(node: Syntax): number {
  const declarator = functionDeclarator(fieldOf(node, 'declarator') as Syntax);
  const count = (syntax: Syntax): number =>
    ([
      'pointer_declarator',
      'abstract_pointer_declarator',
      'array_declarator',
      'abstract_array_declarator',
      'template_type',
    ].includes(syntax.type)
      ? 1
      : 0) + syntax.children.reduce((sum, child) => sum + count(child), 0);
  return (declarator ? (fieldOf(declarator, 'parameters')?.children ?? []) : []).reduce(
    (sum, parameter) => sum + count(parameter),
    0
  );
}

/** How much a partial specialization's argument list constrains its arguments, for choosing the most specialized. */
function specificity(node: Syntax): number {
  if (node.type === 'type_identifier' || node.type === 'identifier') return 0;
  // A pack expansion matches any number of arguments, which is less specialized than a fixed number.
  if (node.type === 'parameter_pack_expansion') return -1;
  // A parameter's name alone, which the grammar reads as a type, is as general as an argument gets.
  if (node.type === 'type_descriptor' && node.children.length === 1 && node.children[0].type === 'type_identifier')
    return 0;
  return 1 + node.children.reduce((sum, child) => sum + specificity(child), 0);
}

/** A non-type template argument's value in its parameter's type. */
function convertTemplateValue(value: number | bigint, type: Extract<Type, { kind: 'int' }>): number | bigint {
  return isWide(type) ? BigInt(value) : Number(value);
}

/** The namespace a class is a member of, through the classes it is nested in. */
function namespaceOf(cls: ClassInfo | undefined): NamespaceInfo | undefined {
  let current = cls;
  while (current?.outer) current = current.outer;
  return current?.namespace;
}

/** The class a name denotes, as a class or as a type. */
function classOfEntity(entity: Entity): ClassInfo | undefined {
  if (entity.kind === 'class') return entity.cls;
  if (entity.kind === 'type' && entity.type.kind === 'class' && !entity.type.cls.library) return entity.type.cls;
  return undefined;
}

/** Whether a function is a comparison operator that `= default` may define. */
function isDefaultableComparison(fn: FunctionInfo): boolean {
  return ['operator==', 'operator!=', 'operator<=>', 'operator<', 'operator>', 'operator<=', 'operator>='].includes(
    fn.name
  );
}

/** Whether a function's definition is `= default` or `= delete`. */
function specialDefinition(node: Syntax): 'default' | 'delete' | undefined {
  if (node.children.some((child) => child.type === 'default_method_clause')) return 'default';
  if (node.children.some((child) => child.type === 'delete_method_clause')) return 'delete';
  return undefined;
}

/** Whether a parameter's type makes a constructor or an assignment a copy one: `C`, `C&`, or `const C&`. */
function isCopyParameter(type: Type, cls: ClassInfo): boolean {
  const target = type.kind === 'reference' ? type.to : type;
  return target.kind === 'class' && target.cls === cls;
}

function innermostFunctionDeclarator(declarator: Syntax): Syntax | undefined {
  let current: Syntax | undefined = declarator;
  while (current && current.type !== 'function_declarator') {
    if (current.type === 'parenthesized_declarator') return undefined;
    current = fieldOf(current, 'declarator') ?? current.children.find((child) => child.type.endsWith('declarator'));
  }
  return current;
}

/** The class key a class specifier is written with. */
function classKey(node: Syntax): ClassInfo['key'] {
  if (node.type === 'struct_specifier') return 'struct';
  return node.type === 'union_specifier' ? 'union' : 'class';
}

/** The member of a union an aggregate initialization initializes: the one given a value, or else the first. */
function unionMemberToInitialize(fields: readonly FieldInfo[], supplied: readonly unknown[]): number {
  const given = fields.findIndex((_, index) => supplied[index] !== undefined);
  return given === -1 ? 0 : given;
}

/** Whether a type may be a member of a union without the union declaring how to make and destroy it. */
function isTrivialUnionMember(type: Type): boolean {
  if (type.kind === 'array') return isTrivialUnionMember(type.of);
  if (type.kind !== 'class') return true;
  const { cls } = type;
  return (
    !cls.library &&
    cls.constructors.length === 0 &&
    !cls.destructor &&
    !cls.isPolymorphic &&
    cls.fields.every((field) => !field.initializer && isTrivialUnionMember(field.type))
  );
}

const parsedSources = new WeakMap<LibrarySource, Syntax>();

function parsedLibrarySource(source: LibrarySource): Syntax {
  let parsed = parsedSources.get(source);
  if (!parsed) {
    parsed = parseLibrarySource(source.source);
    parsedSources.set(source, parsed);
  }
  return parsed;
}

/** The signature of the only argument's `operator()`, when the argument is an object of a class with one. */
function callSignature(args: readonly Expr[]): Type | undefined {
  const [only] = args;
  const type = args.length === 1 ? nonReference(only.type) : undefined;
  if (type?.kind !== 'class') return undefined;
  const [call, ...others] = type.cls.methods.get('operator()') ?? [];
  if (!call || others.length > 0 || call.templatePattern) return undefined;
  return { kind: 'function', ret: call.ret, params: call.params.map((param) => param.type) };
}
