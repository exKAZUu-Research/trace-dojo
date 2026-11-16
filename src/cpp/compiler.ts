import { misplacedAtomicMessage, type TraceOptions } from '../interpreter/traceAnnotations';
import { byteAt } from './bytes';
import { isAuto } from './compilerBase';
import { CppException, CppRuntimeError } from './errors';
import type { Expr } from './expr';
import { isCopyConstructor } from './expressionCompiler';
import type { Library } from './library/registry';
import { invoke, newObject, virtualKey, zeroOf } from './objectCompiler';
import { type CompiledFunction, type Eval, type Exec, type Frame, holdAll, RETURN } from './runtime';
import { type Entity, FunctionContext, type Scope } from './scopes';
import { endScope, StatementCompiler } from './statementCompiler';
import { fieldOf, fieldsOf, hasToken, type Syntax } from './syntax';
import {
  type Access,
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
  isInteger,
  type ParamInfo,
  sameType,
  type Type,
  typeName,
  unqualified,
  VOID,
} from './types';
import { ArrayStore, Box, CObject, Liveness, Ptr, UNINIT, type Value } from './values';

export interface CompileOptions {
  trace?: TraceOptions;
}

/** A program ready to run: its static storage and its entry point. */
export interface CompiledProgram {
  main: FunctionInfo;
  globals: GlobalInfo[];
  /** Creates each variable with static storage duration, zero-initialized, by its index. */
  createGlobals: () => Box[];
  /** Initializes the variables with static storage duration before `main` runs, in declaration order. */
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
  private readonly globalInitializers: { index: number; init: Exec }[] = [];
  private readonly globalTypes: Type[] = [];
  /** The functions the program calls, which it must define, with the row of a call. */
  private readonly usedFunctions = new Map<FunctionInfo, number>();

  constructor(library: Library, options: CompileOptions = {}) {
    super(library);
    library.compiler = this;
    this.recordsSteps = options.trace !== undefined;
    this.atomicRows = options.trace?.atomicAnnotations ?? new Map();
  }

  compile(root: Syntax): CompiledProgram {
    for (const item of root.children) this.topLevel(item);
    const main = this.globalScope.names.get('main');
    if (main?.kind !== 'functions')
      return this.error(0, 'main 関数がありません。int main() { ... } を書いてください。');
    const mainFunction = main.functions.find((fn) => fn.isDefined);
    if (!mainFunction) return this.error(0, 'main 関数の本体がありません。');
    if (main.functions.length > 1) return this.error(mainFunction.row, 'main 関数はオーバーロードできません。');
    for (const [fn, row] of this.usedFunctions) {
      if (!fn.isDefined && !fn.native && !fn.isPure) {
        this.error(row, `関数 ${fn.displayName} は宣言だけで、定義（本体）がありません。`);
      }
    }
    for (const row of this.atomicRows.keys()) {
      if (!this.usedAtomicRows.has(row)) this.error(row, misplacedAtomicMessage);
    }
    const types = this.globalTypes;
    return {
      main: mainFunction,
      globals: this.globals,
      createGlobals: () => types.map((type) => new Box(staticZero(type))),
      initializeGlobals: (frame) => {
        for (const { init } of this.globalInitializers) init(frame);
      },
      shownGlobals: this.globals.filter((global) => global.isShown),
      mainTakesArguments: mainFunction.params.length === 2,
    };
  }

  // code-gauge-allow functionNcss 40 -- One case per kind of declaration at file scope.
  private topLevel(node: Syntax): void {
    switch (node.type) {
      case 'comment': {
        return;
      }
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
      if (this.context.fn) {
        this.context.scope.names.set('\0std', { kind: 'namespace', name: 'std' });
        this.usesStdLocally.add(this.context.scope);
      }
      this.usesStd = true;
      return;
    }
    if (target.type !== 'qualified_identifier') return this.unsupported(node.row, `using ${target.text}`);
    const scope = fieldOf(target, 'scope');
    if (scope?.text !== 'std') return this.unsupported(node.row, '名前空間以外の using 宣言（using Base::f; など）');
    const entity = this.lookupQualified(target);
    const name = (fieldOf(target, 'name') as Syntax).text;
    (this.context.fn ? this.context.scope : this.globalScope).names.set(name, entity);
  }

  private readonly usesStdLocally = new Set<Scope>();

  // Classes ----------------------------------------------------------------------------------------------------------

  protected classSpecifierType(node: Syntax): Type {
    const nameNode = fieldOf(node, 'name');
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
      cls = new ClassInfo(name, node.type === 'struct_specifier' ? 'struct' : 'class');
      cls.row = node.row;
      this.globalScope.names.set(name, { kind: 'class', cls });
    }
    if (body) this.defineClass(cls, node, body);
    return classType(cls);
  }

  private defineClass(cls: ClassInfo, node: Syntax, body: Syntax): void {
    const isFinalClass = node.children.some((child) => child.type === 'virtual_specifier' && child.text === 'final');
    this.baseClause(cls, node);
    const savedClass = this.memberClass;
    this.memberClass = cls;
    const definitions: { fn: FunctionInfo; node: Syntax }[] = [];
    try {
      let access: Access = cls.key === 'struct' ? 'public' : 'private';
      for (const member of body.children) {
        switch (member.type) {
          case 'access_specifier': {
            access = member.text as Access;
            break;
          }
          case 'comment': {
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
      for (const { fn, node: definition } of definitions) this.compileFunction(fn, definition);
      for (const fn of [...cls.constructors, ...(cls.destructor ? [cls.destructor] : [])]) {
        if (fn.isDefined && !fn.compiled && fn.definition) this.compileFunction(fn, fn.definition);
      }
    } finally {
      this.memberClass = savedClass;
    }
  }

  private baseClause(cls: ClassInfo, node: Syntax): void {
    const clause = node.children.find((child) => child.type === 'base_class_clause');
    if (!clause) return;
    const bases = clause.children.filter((child) => child.type !== 'access_specifier');
    if (bases.length > 1) return this.unsupported(clause.row, '多重継承');
    if (hasToken(clause, 'virtual')) return this.unsupported(clause.row, '仮想継承（virtual で継承すること）');
    const baseType = this.resolveTypeSpecifier(bases[0]);
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
    cls.baseAccess = (accessNode?.text as Access | undefined) ?? (cls.key === 'struct' ? 'public' : 'private');
    cls.fields = [...base.fields];
  }

  private memberDeclaration(cls: ClassInfo, node: Syntax, access: Access): void {
    const declarators = fieldsOf(node, 'declarator');
    if (declarators.length === 0) return this.error(node.row, 'メンバの名前を書いてください。');
    const firstDeclared = declarators[0];
    if (this.isFunctionDeclarator(firstDeclared)) {
      this.memberFunction(cls, node, access, false);
      return;
    }
    if (hasToken(node, 'virtual')) this.error(node.row, 'virtual はメンバ関数にしか付けられません。');
    const isStatic = this.hasSpecifier(node, 'static');
    const isInline = this.hasSpecifier(node, 'inline');
    const base = this.specifiedType(node);
    const defaults = fieldsOf(node, 'default_value');
    for (const [position, declarator] of declarators.entries()) {
      const declared = this.applyDeclarator(base, declarator);
      const name = declared.name as string;
      if (this.memberEntity(cls, name)) this.error(declarator.row, `メンバ ${name} はすでに宣言されています。`);
      const initializer = this.defaultValueOf(node, declarator, defaults, position);
      if (isStatic) {
        this.staticMember(cls, name, declared.type, access, declarator.row, initializer, isInline);
        continue;
      }
      if (isAuto(declared.type)) this.error(declarator.row, 'メンバ変数には auto を使えません。');
      if (declared.type.kind === 'class' && !declared.type.cls.isComplete) {
        this.error(declarator.row, `クラス ${declared.type.cls.name} はまだ定義されていないので、メンバにできません。`);
      }
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
      };
      cls.fields.push(field);
    }
  }

  /** The default member initializer of the `position`th declarator of a member declaration. */
  private defaultValueOf(node: Syntax, declarator: Syntax, defaults: Syntax[], position: number): Syntax | undefined {
    void position;
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
    isInline: boolean
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
    if (initializer && !isInline && !isConstIntegral && !this.hasConstexpr(type)) {
      this.error(
        row,
        `static のメンバ変数 ${name} の初期値は、クラスの外の定義に書いてください（または inline static にしてください）。`
      );
    }
    const global = this.declareStaticStorage(
      `${cls.name}::${name}`,
      type,
      row,
      initializer,
      undefined,
      !isConstType(type)
    );
    info.global = global;
    if (initializer || isInline) {
      global.isDefined = true;
      if (initializer) this.initializeGlobal(global, type, initializer, row, true);
      if (isConstType(type) && initializer && initializer.type !== 'initializer_list') {
        info.constant = this.constantOf(this.compileExpression(initializer), type);
      }
    }
  }

  private hasConstexpr(type: Type): boolean {
    return isConstType(type);
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
  private memberFunction(cls: ClassInfo, node: Syntax, access: Access, isDefinition: boolean): FunctionInfo {
    const declarator = fieldOf(node, 'declarator') as Syntax;
    const typeNode = fieldOf(node, 'type');
    const declared = this.applyDeclarator(typeNode ? this.specifiedType(node) : VOID, declarator);
    const functionDeclarator = declared.function as Syntax;
    const rawName = declared.name ?? '';
    const isDestructor = rawName.startsWith('~');
    const isConstructor = !typeNode && !isDestructor;
    if (isConstructor && rawName !== cls.name) return this.error(node.row, `${rawName} の戻り値の型を書いてください。`);
    if (isDestructor && rawName !== `~${cls.name}`)
      return this.error(node.row, `デストラクタの名前は ~${cls.name} です。`);
    if ((isConstructor || isDestructor) && typeNode)
      return this.error(node.row, 'コンストラクタとデストラクタには戻り値の型を書けません。');
    const fn = this.functionInfo(rawName, declared.type, functionDeclarator, node, cls);
    fn.access = access;
    fn.isConstructor = isConstructor;
    fn.isDestructor = isDestructor;
    fn.isStatic = this.hasSpecifier(node, 'static');
    fn.isVirtual = hasToken(node, 'virtual');
    if ((isConstructor || isDestructor) && fn.isStatic)
      this.error(node.row, 'コンストラクタとデストラクタは static にできません。');
    if (fn.isStatic && fn.isConst) this.error(node.row, 'static のメンバ関数は const にできません。');
    if (fn.isStatic && fn.isVirtual) this.error(node.row, 'static のメンバ関数は virtual にできません。');
    if (isConstructor && fn.isVirtual) this.error(node.row, 'コンストラクタは virtual にできません。');
    const defaultValue = fieldOf(node, 'default_value');
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
    const same = overloads.find((other) => sameParameters(other, fn));
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
    if (isAuto(ret)) this.unsupported(node.row, '戻り値の型の auto');
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
      isConst: qualifiers.has('const'),
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
    let seenDefault = false;
    for (const param of list.children) {
      if (param.type === 'comment') continue;
      if (param.type === 'variadic_parameter') return this.unsupported(param.row, '可変長引数（...）');
      const base = this.specifiedType(param);
      const declarator = fieldOf(param, 'declarator');
      const declared = declarator ? this.applyDeclarator(base, declarator) : { name: undefined, type: base };
      let type = declared.type;
      if (type.kind === 'void' && !declarator) {
        if (list.children.length === 1) return [];
        this.error(param.row, '引数の型に void は書けません。');
      }
      if (isAuto(type) || (type.kind === 'reference' && isAuto(type.to)))
        this.unsupported(param.row, '引数の型の auto（省略形の関数テンプレート）');
      // An array parameter is a pointer (C++20 [dcl.fct]).
      if (type.kind === 'array') type = { kind: 'pointer', to: type.of };
      const defaultValue =
        param.type === 'optional_parameter_declaration' ? fieldOf(param, 'default_value') : undefined;
      if (defaultValue) seenDefault = true;
      else if (seenDefault) this.error(param.row, '引数の既定値は、後ろの引数から順に付けてください。');
      params.push({ name: declared.name, type, defaultValue, row: param.row });
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
    for (const [name, overloads] of cls.methods) {
      for (const fn of overloads) {
        const key = virtualKey(fn);
        const overridden = cls.base ? this.findVirtual(cls.base, key) : undefined;
        if (overridden) {
          if (!sameType(unqualified(overridden.ret), unqualified(fn.ret)) && !covariant(overridden.ret, fn.ret)) {
            this.error(fn.row, `${fn.displayName} の戻り値の型が、上書きする ${overridden.displayName} と違います。`);
          }
          if (overridden.isFinal) this.error(fn.row, `${overridden.displayName} は final なので上書きできません。`);
          fn.isVirtual = true;
        } else if (fn.isOverride) {
          this.error(fn.row, `override を付けた ${name} は、親クラスの仮想関数を上書きしていません。`);
        } else if (fn.isFinal && !fn.isVirtual) {
          this.error(fn.row, `final は仮想関数にしか付けられません。`);
        }
        if (fn.isVirtual) cls.virtuals.set(key, fn);
      }
    }
    const baseDestructor = cls.base?.destructor;
    if (cls.destructor && (cls.destructor.isVirtual || baseDestructor?.isVirtual)) cls.destructor.isVirtual = true;
    if (!cls.destructor && baseDestructor?.isVirtual) cls.destructor = this.implicitDestructor(cls);
    if (cls.destructor?.isVirtual) cls.virtuals.set('~', cls.destructor);
    const userCopy = cls.constructors.find((ctor) => isCopyConstructor(ctor, cls));
    cls.isNoncopyable =
      !userCopy &&
      (cls.base?.isNoncopyable === true || cls.ownFields.some((field) => this.isNoncopyableType(field.type)));
    cls.isComplete = true;
    if (cls.constructors.length === 0) cls.implicitDefault = this.implicitDefaultConstructor(cls);
    cls.operations = this.classOperations(cls, userCopy);
  }

  private findVirtual(cls: ClassInfo, key: string): FunctionInfo | undefined {
    return cls.virtuals.get(key);
  }

  private isNoncopyableType(type: Type): boolean {
    if (type.kind === 'class') return type.cls.isNoncopyable;
    if (type.kind === 'array') return this.isNoncopyableType(type.of);
    return false;
  }

  private implicitDestructor(cls: ClassInfo): FunctionInfo {
    return {
      ...this.syntheticFunction(cls, `~${cls.name}`),
      isDestructor: true,
      isVirtual: true,
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

  /** The constructor a class without any gets, which initializes its base and members as their defaults say. */
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
      const name = nameNode.type === 'qualified_identifier' ? nameNode.text : nameNode.text;
      if (name === cls.name) {
        delegate = initializer;
        continue;
      }
      if (cls.base && this.namesClass(nameNode, cls.base)) {
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
      return this.delegation(cls, delegate);
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
    const destroyers = cls.ownFields.map((field) => ({ field, destroy: this.destroyerOf(field.type) }));
    const baseDestroy = base?.operations?.destroy;
    return (frame) => {
      try {
        for (const part of parts) part(frame);
      } catch (error) {
        // An exception from a member's initialization destroys the members and the base already initialized.
        if (error instanceof CppException) {
          const object = frame.self?.read() as CObject;
          for (let index = destroyers.length - 1; index >= 0; index--) {
            const { field, destroy } = destroyers[index];
            if (destroy && object.values[field.index] !== UNINIT) destroy(frame, object.values[field.index]);
          }
          if (baseDestroy && base) {
            object.cls = base;
            baseDestroy(frame, object);
          }
        }
        throw error;
      }
      return;
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

  private delegation(cls: ClassInfo, initializer: Syntax): Exec {
    const args = this.initializerArguments(initializer);
    const resolved = this.resolve(`${cls.name} のコンストラクタ`, cls.constructors, args, undefined, initializer.row);
    const runs = this.callArguments(resolved, args, initializer.row);
    const { row } = initializer;
    return (frame) => {
      const values = runs.map((run) => run(frame));
      invoke(frame, resolved.fn, values, frame.self, row);
      return;
    };
  }

  private initializerArguments(initializer: Syntax): Expr[] {
    const argumentsNode = initializer.children[1];
    if (!argumentsNode) return [];
    if (argumentsNode.type === 'initializer_list') return argumentsNode.children.map((arg) => this.argument(arg));
    return argumentsNode.children.map((arg) => this.argument(arg));
  }

  private baseInitialization(cls: ClassInfo, base: ClassInfo, initializer: Syntax | undefined): Exec {
    const row = initializer?.row ?? cls.row;
    const args = initializer ? this.initializerArguments(initializer) : [];
    if (base.constructors.length === 0) {
      if (args.length > 0) this.error(row, `${base.name} には引数をとるコンストラクタがありません。`);
      const implicit = base.implicitDefault;
      return (frame) => {
        (frame.self?.read() as CObject).cls = base;
        if (implicit) invoke(frame, implicit, [], frame.self, row);
        return;
      };
    }
    const resolved = this.resolve(`${base.name} のコンストラクタ`, base.constructors, args, undefined, row);
    if (!resolved.fn.native && resolved.fn.access === 'private')
      this.error(row, `${base.name} のコンストラクタは private です。`);
    const runs = this.callArguments(resolved, args, row);
    return this.fullExpression<undefined>((frame) => {
      const values = runs.map((run) => run(frame));
      (frame.self?.read() as CObject).cls = base;
      invoke(frame, resolved.fn, values, frame.self, row);
      return;
    });
  }

  /** Initializes one member as a constructor does, recording the step of an initializer that learners see. */
  private fieldInitialization(field: FieldInfo, explicit: Syntax | undefined): Exec | undefined {
    const { index, type } = field;
    let value: Eval<Value | Ptr> | undefined;
    let row = field.row;
    let isCreation = false;
    if (explicit) {
      row = explicit.row;
      const argumentsNode = explicit.children[1];
      if (type.kind === 'reference') {
        const args = this.initializerArguments(explicit);
        if (args.length !== 1) this.error(row, `参照のメンバ ${field.name} には値を1つ書いてください。`);
        value = this.convert(args[0], type, row).run;
      } else if (argumentsNode?.type === 'initializer_list') {
        value = this.listInitializer(type, argumentsNode, row);
        isCreation = type.kind === 'class' && !type.cls.library;
      } else {
        const args = this.initializerArguments(explicit);
        if (type.kind === 'class') {
          value = this.constructObject(type.cls, args, row, false).run;
          isCreation = !type.cls.library;
        } else if (args.length === 0) {
          value = this.valueInitialized(type, row).run;
        } else if (args.length === 1 && type.kind !== 'array') {
          value = this.copyInitializer(type, args[0], row, false);
        } else {
          this.error(row, `メンバ ${field.name} の初期値には値を1つだけ書いてください。`);
        }
      }
    } else if (field.initializer) {
      const node = field.initializer;
      if (type.kind === 'reference') value = this.convert(this.compileExpression(node), type, row).run;
      else if (node.type === 'initializer_list') {
        value = this.listInitializer(type, node, row);
        isCreation = type.kind === 'class' && !type.cls.library;
      } else {
        const expr = this.compileExpression(node);
        value = this.copyInitializer(type, expr, row, false);
        isCreation = node.type === 'new_expression';
      }
    } else if (type.kind === 'reference') {
      return this.error(field.row, `参照のメンバ ${field.name} は、コンストラクタで初期化してください。`);
    } else if (this.isClassType(type)) {
      value = this.defaultInitializer(type, row);
      isCreation = true;
    } else if (type.kind === 'array') {
      const init = this.defaultInitializer(type, row);
      return (frame) => {
        (frame.self?.read() as CObject).values[index] = init(frame);
        return;
      };
    } else {
      return undefined;
    }
    const compute = value as Eval<Value | Ptr>;
    const exec = this.fullExpression<undefined>((frame) => {
      (frame.self?.read() as CObject).values[index] = compute(frame) as Value;
      return;
    });
    return this.withStep(row, exec, isCreation);
  }

  private isClassType(type: Type): boolean {
    return type.kind === 'class' || (type.kind === 'array' && this.isClassType(type.of));
  }

  /** How objects of a class are copied, assigned, and destroyed. */
  private classOperations(cls: ClassInfo, userCopy: FunctionInfo | undefined): ClassInfo['operations'] {
    const base = cls.base;
    const ownFields = cls.ownFields;
    const copyInto = (frame: Frame, target: CObject, source: CObject): void => {
      if (userCopy) {
        invoke(frame, userCopy, [new Ptr(new Box(source), 0)], new Ptr(new Box(target), 0), cls.row);
        return;
      }
      if (base) {
        const baseCopy = base.operations?.copy(frame, source) as CObject;
        for (let index = 0; index < base.fields.length; index++) target.values[index] = baseCopy.values[index];
      }
      for (const field of ownFields)
        target.values[field.index] = copyValue(frame, field.type, source.values[field.index]);
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
      copy: (frame, source) => {
        const target = newObject(cls);
        copyInto(frame, target, source as CObject);
        return target;
      },
      assign: (frame, target, source) => {
        if (target !== source) assignInto(frame, target as CObject, source as CObject);
      },
      destroy,
    };
  }

  /** Destroys an object of a class: its destructor's body, then its members, the last first, then its base. */
  private destructionOf(cls: ClassInfo): ((frame: Frame, value: Value) => void) | undefined {
    const members = cls.ownFields
      .map((field) => ({ index: field.index, destroy: this.destroyerOf(field.type) }))
      .filter((member) => member.destroy !== undefined)
      .toReversed();
    const baseDestroy = cls.base?.operations?.destroy;
    const destructor = cls.destructor?.compiled || cls.destructor?.definition ? cls.destructor : undefined;
    if (!destructor && members.length === 0 && !baseDestroy) return undefined;
    return (frame, value) => {
      const object = value as CObject;
      if (object.liveness !== Liveness.Alive) return;
      object.cls = cls;
      if (destructor?.compiled)
        invoke(frame, destructor, [], new Ptr(new Box(object), 0), undefined as unknown as number);
      for (const { index, destroy } of members) {
        const member = object.values[index];
        if (member !== UNINIT) destroy?.(frame, member);
      }
      if (baseDestroy) baseDestroy(frame, object);
    };
  }

  // Functions -------------------------------------------------------------------------------------------------------

  private functionDefinition(node: Syntax): void {
    // A function returning a pointer or a reference wraps its function declarator (`int& f()`).
    const declarator = innermostFunctionDeclarator(fieldOf(node, 'declarator') as Syntax);
    if (!declarator) return this.error(node.row, '関数の定義には (...) で引数を書いてください。');
    const inner = fieldOf(declarator, 'declarator') as Syntax;
    if (inner.type === 'qualified_identifier') {
      this.outOfClassDefinition(node, inner);
      return;
    }
    const fn = this.declareFunction(node, declarator, true);
    this.compileFunction(fn, node);
  }

  private declareFunction(node: Syntax, declarator: Syntax, isDefinition: boolean): FunctionInfo {
    const typeNode = fieldOf(node, 'type');
    if (!typeNode) return this.error(node.row, '関数の戻り値の型を書いてください。');
    if (this.hasSpecifier(node, 'virtual') || hasToken(node, 'virtual'))
      this.error(node.row, 'virtual はメンバ関数にしか付けられません。');
    const declared = this.applyDeclarator(this.specifiedType(node), fieldOf(node, 'declarator') as Syntax);
    const name = declared.name as string;
    const fn = this.functionInfo(name, declared.type, declarator, node, undefined);
    if (name === 'main') {
      if (!sameType(unqualified(fn.ret), INT)) this.error(node.row, 'main 関数の戻り値の型は int にしてください。');
      this.checkMainParameters(fn);
    }
    const existing = this.globalScope.names.get(name);
    if (existing && existing.kind !== 'functions')
      return this.error(node.row, `${name} はすでに別のものとして宣言されています。`);
    const overloads = existing?.kind === 'functions' ? existing.functions : [];
    const same = overloads.find((other) => sameParameters(other, fn));
    if (same) {
      if (!sameType(same.ret, fn.ret))
        this.error(node.row, `関数 ${name} は、戻り値の型だけが違う宣言をすでにされています。`);
      if (isDefinition && same.isDefined) this.error(node.row, `関数 ${name} はすでに定義されています。`);
      if (isDefinition) {
        same.isDefined = true;
        same.definition = node;
        same.params = mergeDefaults(same.params, fn.params, node.row, (row, message) => this.error(row, message));
        this.claimAtomic(same, node);
      }
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
    const savedClass = this.memberClass;
    this.memberClass = cls;
    try {
      const declarator = fieldOf(node, 'declarator') as Syntax;
      const nameNode = fieldOf(qualified, 'name') as Syntax;
      const typeNode = fieldOf(node, 'type');
      const ret = typeNode ? this.specifiedType(node) : VOID;
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
      if (typeNode && !sameType(fn.ret, probe.ret))
        return this.error(node.row, `${fn.displayName} の戻り値の型が宣言と違います。`);
      if (probe.params.some((param) => param.defaultValue)) {
        this.error(node.row, '引数の既定値は、クラスの中の宣言に書いてください。');
      }
      fn.isDefined = true;
      fn.definition = node;
      fn.params = fn.params.map((param, index) => ({ ...param, name: probe.params[index].name }));
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

  /** Compiles a function's body, binding its parameters to the first slots of its frame. */
  private compileFunction(fn: FunctionInfo, node: Syntax): void {
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
        const local = context.declareLocal(param.name ?? `\0param${param.row}`, type, true);
        if (param.name) {
          if (scope.names.has(param.name)) this.error(param.row, `引数 ${param.name} の名前が重複しています。`);
          scope.names.set(param.name, { kind: 'local', local, isReference: type.kind === 'reference' });
        }
        const destroy = type.kind === 'reference' ? undefined : this.destroyerOf(type);
        if (destroy) scope.destructibles.push({ slot: local.slot, destroy });
      }
      const body = fieldOf(node, 'body');
      if (!body) {
        if (node.children.some((child) => child.type === 'default_method_clause'))
          this.unsupported(node.row, '= default');
        return this.error(node.row, `${fn.displayName} の本体を書いてください。`);
      }
      if (body.type === 'try_statement') return this.unsupported(node.row, '関数の try ブロック');
      context.namedReturn = this.namedReturnCandidate(body, fn);
      const memberInit =
        fn.isConstructor && cls
          ? this.memberInitialization(
              cls,
              fn,
              node.children.find((child) => child.type === 'field_initializer_list')
            )
          : undefined;
      if (!fn.isConstructor && node.children.some((child) => child.type === 'field_initializer_list')) {
        this.error(node.row, 'メンバの初期化子の並び（: x(...)）は、コンストラクタにしか書けません。');
      }
      const statements = this.compileStatements(body.children);
      fn.compiled = this.functionBody(fn, context, memberInit, statements, body.endRow);
    } finally {
      this.context = saved;
    }
  }

  /** The local a function returns by name in all its `return` statements, which the result shares (NRVO). */
  private namedReturnCandidate(body: Syntax, fn: FunctionInfo): FunctionContext['namedReturn'] {
    if (fn.ret.kind !== 'class') return undefined;
    const names = new Set<string>();
    let others = false;
    const visit = (node: Syntax): void => {
      if (node.type === 'return_statement') {
        const value = node.children[0];
        if (value?.type === 'identifier') names.add(value.text);
        else others = true;
      }
      for (const child of node.children) visit(child);
    };
    visit(body);
    if (others || names.size !== 1) return undefined;
    const [name] = names;
    return { name, slot: -1, type: fn.ret, isParameter: false };
  }

  private functionBody(
    fn: FunctionInfo,
    context: FunctionContext,
    memberInit: Exec | undefined,
    statements: Exec,
    endRow: number
  ): CompiledFunction {
    const scope = context.scope;
    const { slots, destructibles } = scope;
    const isMain = fn.name === 'main' && !fn.owner;
    const isVoid = fn.ret.kind === 'void' || fn.isConstructor || fn.isDestructor;
    void endRow;
    const body = (frame: Frame): void => {
      let completion;
      try {
        if (memberInit) memberInit(frame);
        completion = statements(frame);
        if (isMain) frame.runtime.onMainEnd?.(frame);
      } catch (error) {
        if (error instanceof CppException) endScope(frame, slots, destructibles);
        throw error;
      }
      endScope(frame, slots, destructibles);
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
    if (
      typeNode &&
      (typeNode.type === 'class_specifier' || typeNode.type === 'struct_specifier') &&
      fieldOf(typeNode, 'body')
    ) {
      this.classSpecifierType(typeNode);
    }
    const declarators = fieldsOf(node, 'declarator');
    if (declarators.length === 0) {
      if (typeNode?.type === 'class_specifier' || typeNode?.type === 'struct_specifier') {
        if (!fieldOf(typeNode, 'body')) this.classSpecifierType(typeNode);
        return;
      }
      return this.error(node.row, '宣言する名前を書いてください。');
    }
    const base = this.specifiedType(node);
    for (const declarator of declarators) {
      const declared = this.applyDeclarator(base, declarator);
      if (declared.function && declarator.type !== 'init_declarator') {
        this.functionDeclaration(node, declarator, declared);
        continue;
      }
      if (declared.nameNode?.type === 'qualified_identifier') {
        this.staticMemberDefinition(declared.nameNode, declared.type, declarator);
        continue;
      }
      this.globalVariable(node, declarator, declared.name as string, declared.type);
    }
  }

  private functionDeclaration(node: Syntax, declarator: Syntax, declared: { nameNode?: Syntax }): void {
    if (declared.nameNode?.type === 'qualified_identifier') {
      this.error(node.row, `${declared.nameNode.text} の宣言はクラスの中に書いてください。`);
    }
    const functionDeclarator = innermostFunctionDeclarator(declarator);
    if (this.hasSpecifier(node, 'static')) this.unsupported(node.row, 'static の関数（内部結合）');
    this.declareFunction(
      {
        ...node,
        all: node.all.map((child) => (child === declarator ? { ...child, field: 'declarator' } : child)),
      } as Syntax,
      functionDeclarator as Syntax,
      false
    );
  }

  private staticMemberDefinition(nameNode: Syntax, type: Type, declarator: Syntax): void {
    const scope = this.resolveScope(fieldOf(nameNode, 'scope') as Syntax);
    if (scope.kind !== 'class') return this.unsupported(declarator.row, '名前空間のメンバの定義');
    const name = (fieldOf(nameNode, 'name') as Syntax).text;
    const info = scope.cls.staticFields.get(name);
    if (!info)
      return this.error(declarator.row, `${scope.cls.name} に static のメンバ変数 ${name} は宣言されていません。`);
    if (!sameType(unqualified(info.type), unqualified(type), false)) {
      return this.error(declarator.row, `${scope.cls.name}::${name} の型が宣言と違います。`);
    }
    const global = info.global as GlobalInfo;
    if (global.isDefined) return this.error(declarator.row, `${scope.cls.name}::${name} はすでに定義されています。`);
    global.isDefined = true;
    const value = declarator.type === 'init_declarator' ? fieldOf(declarator, 'value') : undefined;
    const savedClass = this.memberClass;
    this.memberClass = scope.cls;
    try {
      if (value) this.initializeGlobal(global, info.type, value, declarator.row, true);
      else if (this.isClassType(info.type)) this.initializeGlobal(global, info.type, undefined, declarator.row, true);
      if (isConstType(info.type) && value && value.type !== 'initializer_list' && value.type !== 'argument_list') {
        info.constant = this.constantOf(this.compileExpression(value), info.type);
      }
    } finally {
      this.memberClass = savedClass;
    }
  }

  private globalVariable(node: Syntax, declarator: Syntax, name: string, declaredType: Type): void {
    if (this.globalScope.names.has(name)) return this.error(declarator.row, `${name} はすでに宣言されています。`);
    const value = declarator.type === 'init_declarator' ? fieldOf(declarator, 'value') : undefined;
    let type = declaredType;
    if (type.kind === 'reference') return this.unsupported(declarator.row, '関数の外の参照の変数');
    if (isAuto(type)) {
      if (!value || value.type === 'initializer_list' || value.type === 'argument_list') {
        return this.error(declarator.row, `auto の変数 ${name} には、= のあとに初期値を書いてください。`);
      }
      type = this.deduceAuto(type, this.compileExpression(value), declarator.row);
    }
    if (type.kind === 'array' && type.length === undefined && value) type = this.completeArrayType(type, value);
    if (type.kind === 'void') return this.error(declarator.row, `void 型の変数 ${name} は作れません。`);
    const isConstant = isConstType(type) && isArithmetic(type);
    const global = this.declareStaticStorage(name, type, declarator.row, value, declarator, !isConstant);
    global.isDefined = true;
    let constant: number | bigint | undefined;
    if (isConstant && value && value.type !== 'initializer_list' && value.type !== 'argument_list') {
      constant = this.constantOf(this.compileExpression(value), type);
    }
    this.globalScope.names.set(name, { kind: 'global', global, isReference: false, constant });
    this.initializeGlobal(global, type, value, declarator.row, true);
    void node;
  }

  declareStaticStorage(
    name: string,
    type: Type,
    row: number,
    value: Syntax | undefined,
    declarator: Syntax | undefined,
    isShown: boolean
  ): GlobalInfo {
    void value;
    void declarator;
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
    recordsStep: boolean
  ): void {
    const saved = this.context;
    this.context = new FunctionContext(undefined, this.memberClass, VOID);
    try {
      const init = this.staticInitialization(type, value, row);
      if (!init) return;
      const { index } = global;
      const store = this.staticStore(type);
      const exec = this.fullExpression<undefined>((frame) => {
        store(frame, frame.runtime.globals[index] as Box, init.run(frame));
        return;
      });
      this.globalInitializers.push({
        index,
        init: recordsStep && !init.isConstant ? this.withStep(row, exec, init.isCreation) : exec,
      });
    } finally {
      this.context = saved;
    }
  }

  /** The initialization of a variable with static storage duration, or undefined when zero-initialization suffices. */
  private staticInitialization(
    type: Type,
    value: Syntax | undefined,
    row: number
  ): { run: Eval<Value>; isConstant: boolean; isCreation: boolean } | undefined {
    if (!value) {
      if (!this.isClassType(type)) return undefined;
      return { run: this.defaultInitializer(type, row), isConstant: false, isCreation: true };
    }
    if (value.type === 'initializer_list') {
      const run = this.listInitializer(type, value, row);
      return { run, isConstant: !this.isClassType(type), isCreation: type.kind === 'class' && !type.cls.library };
    }
    if (value.type === 'argument_list') {
      const args = value.children.map((arg) => this.argument(arg));
      if (type.kind === 'class')
        return {
          run: this.constructObject(type.cls, args, row, false).run as Eval<Value>,
          isConstant: false,
          isCreation: !type.cls.library,
        };
      if (args.length !== 1) return this.error(row, '初期値には値を1つだけ書いてください。');
      const run = this.copyInitializer(type, args[0], row, false);
      return { run, isConstant: this.rvalue(args[0]).constant !== undefined, isCreation: false };
    }
    const expr = this.compileExpression(value);
    const run = this.copyInitializer(type, expr, row, false);
    const isConstant =
      (isArithmetic(type) && this.rvalue(expr).constant !== undefined) || expr.literalBytes !== undefined;
    return { run, isConstant, isCreation: value.type === 'new_expression' };
  }

  staticInitializer(
    global: GlobalInfo,
    type: Type,
    value: Syntax | undefined,
    declarator: Syntax,
    name: string
  ): (frame: Frame) => void {
    void name;
    const init = this.staticInitialization(type, value, declarator.row);
    const { index } = global;
    if (!init) return () => {};
    if (init.isConstant) {
      this.globalInitializers.push({
        index,
        init: (frame) => {
          (frame.runtime.globals[index] as Box).value = init.run(frame);
          return;
        },
      });
      return () => {};
    }
    let isDone = false;
    const run = this.fullExpression(init.run);
    const store = this.staticStore(type);
    return (frame) => {
      if (isDone) return;
      isDone = true;
      store(frame, frame.runtime.globals[index] as Box, run(frame));
    };
  }

  /**
   * Stores the initialized value of a variable with static storage duration. Its storage was zero-initialized
   * first, so the members its constructor leaves alone are zero; and an object with a destructor is destroyed when
   * the program exits, the last constructed first (C++20 [basic.start.term]).
   */
  private staticStore(type: Type): (frame: Frame, box: Box, value: Value) => void {
    const destroy = this.destroyerOf(type);
    return (frame, box, value) => {
      box.value = zeroFilled(value, type);
      if (destroy) frame.runtime.staticObjects.push({ box, destroy });
    };
  }

  // Initialization ---------------------------------------------------------------------------------------------------

  copyInitializer(type: Type, expr: Expr, row: number, isList: boolean): Eval<Value> {
    if (type.kind === 'array') {
      if (
        expr.literalBytes !== undefined &&
        type.of.kind === 'int' &&
        (type.of.name === 'char' || type.of.name === 'schar' || type.of.name === 'uchar')
      ) {
        return this.charArrayFromLiteral(type, expr.literalBytes, row);
      }
      return this.error(row, `配列は ${typeName(expr.type)} 型の値では初期化できません。{...} を使ってください。`);
    }
    if (isList) this.checkNarrowing(expr, type, row);
    if (
      type.kind === 'class' &&
      expr.type.kind === 'class' &&
      expr.type.cls === type.cls &&
      expr.isTemporaryObject &&
      !expr.isLvalue
    ) {
      return expr.run as Eval<Value>;
    }
    return this.convert(expr, unqualified(type), row).run as Eval<Value>;
  }

  private charArrayFromLiteral(type: Extract<Type, { kind: 'array' }>, bytes: string, row: number): Eval<Value> {
    const length = type.length ?? bytes.length + 1;
    // Unlike C, C++ needs room for the terminating null character (C++20 [dcl.init.string]).
    if (bytes.length + 1 > length)
      this.error(row, `文字列リテラル（${bytes.length + 1} バイト）が、配列（${length} 要素）に収まりません。`);
    const codes = [...bytes].map((byte) => {
      const code = byteAt(byte);
      return code >= 128 ? code - 256 : code;
    });
    return () => new ArrayStore(Array.from({ length }, (_, index) => codes[index] ?? 0));
  }

  /** Stops at a narrowing conversion in list-initialization (C++20 [dcl.init.list]). */
  private checkNarrowing(expr: Expr, type: Type, row: number): void {
    const value = this.rvalue(expr);
    const from = value.type;
    if (!isArithmetic(from) || !isArithmetic(type)) return;
    const to = unqualified(type);
    const narrowing = isNarrowing(from, to, value.constant);
    if (narrowing) {
      this.error(
        row,
        `{...} の中では、${typeName(from)} 型の値を ${typeName(to)} 型に縮めて変換できません（縮小変換）。`
      );
    }
  }

  defaultInitializer(type: Type, row: number): Eval<Value> {
    if (type.kind === 'class') return this.defaultConstructed(type.cls, row, false).run as Eval<Value>;
    if (type.kind === 'array') {
      const length = type.length ?? 0;
      const element = this.defaultInitializer(type.of, row);
      return (frame) => {
        frame.runtime.reserve(length);
        return new ArrayStore(Array.from({ length }, () => element(frame)));
      };
    }
    return () => UNINIT;
  }

  defaultConstructed(cls: ClassInfo, row: number, isValueInitialized: boolean): Expr {
    if (!cls.isComplete) return this.error(row, `クラス ${cls.name} はまだ定義されていません。`);
    if (cls.isAbstract)
      return this.error(row, `${cls.name} は抽象クラス（純粋仮想関数があるクラス）なので、オブジェクトを作れません。`);
    if (cls.constructors.length > 0) {
      const resolved = this.resolve(`${cls.name} のコンストラクタ`, cls.constructors, [], undefined, row);
      if (!resolved.fn.native) this.checkAccess(resolved.fn.access, cls, cls, row, `${cls.name} のコンストラクタ`);
      return this.constructWith(cls, resolved, [], row);
    }
    const implicit = cls.implicitDefault;
    const zeroed = isValueInitialized;
    const zeroFields = cls.fields.map((field) =>
      field.type.kind === 'class' || field.type.kind === 'array' ? UNINIT : zeroOf(field.type)
    );
    return {
      type: classType(cls),
      isLvalue: false,
      row,
      isTemporaryObject: true,
      onlyCalls: true,
      run: (frame) => {
        const object = newObject(cls);
        if (zeroed) for (const [index, zero] of zeroFields.entries()) object.values[index] = zero;
        if (implicit) invoke(frame, implicit, [], new Ptr(new Box(object), 0), row);
        else object.cls = cls;
        return object;
      },
    };
  }

  listInitializer(type: Type, list: Syntax, row: number): Eval<Value> {
    const elements = list.children.filter((child) => child.type !== 'comment');
    if (type.kind === 'reference') return this.error(row, '参照は {...} で初期化できません。');
    if (type.kind === 'array') return this.arrayInitializer(type, elements, row);
    if (type.kind === 'class') {
      const library = type.cls.library;
      if (library?.listInitializer) {
        const run = library.listInitializer(this, elements, row);
        if (run) return run;
      }
      if (this.isAggregate(type.cls)) return this.aggregateInitializer(type.cls, elements, row);
      if (elements.length === 0) return this.defaultConstructed(type.cls, row, true).run as Eval<Value>;
      const args = elements.map((element) => this.argument(element));
      const resolved = this.resolve(`${type.cls.name} のコンストラクタ`, type.cls.constructors, args, undefined, row);
      for (const [index, arg] of args.entries()) {
        const param = resolved.fn.params[index];
        if (param && !arg.braced)
          this.checkNarrowing(arg, param.type.kind === 'reference' ? param.type.to : param.type, row);
      }
      if (type.cls.constructors.length === 0)
        return this.error(row, `${type.cls.name} は {...} では初期化できません。`);
      return this.constructWith(type.cls, resolved, args, row).run as Eval<Value>;
    }
    if (elements.length === 0) {
      const zero = zeroOf(type);
      return () => zero;
    }
    if (elements.length > 1)
      return this.error(row, `${typeName(type)} 型の値を初期化する {...} には、値を1つだけ書いてください。`);
    if (elements[0].type === 'initializer_list')
      return this.error(row, `${typeName(type)} 型の値は、入れ子の {...} では初期化できません。`);
    return this.copyInitializer(type, this.compileExpression(elements[0]), row, true);
  }

  /** Whether a class is an aggregate, which braces initialize member by member (C++20 [dcl.init.aggr]). */
  private isAggregate(cls: ClassInfo): boolean {
    if (cls.library || cls.constructors.length > 0 || cls.isPolymorphic) return false;
    if (cls.base && (cls.baseAccess !== 'public' || !this.isAggregate(cls.base))) return false;
    if (cls.base) return this.unsupported(cls.row, '親クラスのある集成体の {...} による初期化');
    return cls.ownFields.every((field) => field.access === 'public');
  }

  private aggregateInitializer(cls: ClassInfo, elements: Syntax[], row: number): Eval<Value> {
    const fields = cls.ownFields;
    if (elements.length > fields.length)
      return this.error(row, `${cls.name} のメンバは ${fields.length} 個なので、初期値が多すぎます。`);
    const inits = fields.map((field, index) => {
      const element = elements[index];
      if (element) return this.elementInitializer(field.type, element);
      if (field.initializer) {
        const node = field.initializer;
        return node.type === 'initializer_list'
          ? this.listInitializer(field.type, node, row)
          : this.copyInitializer(field.type, this.compileExpression(node), row, false);
      }
      if (field.type.kind === 'reference') return this.error(row, `参照のメンバ ${field.name} に初期値がありません。`);
      return this.valueInitialized(field.type, row).run as Eval<Value>;
    });
    return (frame) => {
      const object = newObject(cls);
      return holdAll(frame, inits, (values) => {
        for (const [index, value] of values.entries()) object.values[fields[index].index] = value as Value;
        return object;
      });
    };
  }

  private arrayInitializer(type: Extract<Type, { kind: 'array' }>, elements: Syntax[], row: number): Eval<Value> {
    const length = type.length ?? elements.length;
    if (elements.length > length) return this.error(row, `配列の要素は ${length} 個なので、初期値が多すぎます。`);
    const elementType = type.of;
    // Braces may be left out around the elements of a nested array (brace elision), which take values in order.
    if (elementType.kind === 'array' && elements.length > 0 && elements[0].type !== 'initializer_list') {
      const inner = elementType.length ?? 0;
      const groups: Syntax[][] = [];
      for (let index = 0; index < elements.length; index += inner) groups.push(elements.slice(index, index + inner));
      if (groups.length > length) return this.error(row, `配列の要素は ${length} 個なので、初期値が多すぎます。`);
      const groupInits = groups.map((group) => this.arrayInitializer(elementType, group, row));
      const zero = this.valueInitialized(elementType, row);
      return (frame) =>
        new ArrayStore(
          Array.from({ length }, (_, index) =>
            groupInits[index] ? groupInits[index](frame) : (zero.run(frame) as Value)
          )
        );
    }
    const inits = elements.map((element) => this.elementInitializer(elementType, element));
    const rest =
      elementType.kind === 'array'
        ? this.arrayInitializer(elementType, [], row)
        : (this.valueInitialized(elementType, row).run as Eval<Value>);
    return (frame) => {
      frame.runtime.reserve(length);
      const values: Value[] = [];
      return holdAll(frame, inits, (initial) => {
        for (let index = 0; index < length; index++)
          values.push(index < initial.length ? (initial[index] as Value) : rest(frame));
        return new ArrayStore(values);
      });
    };
  }

  // Names -------------------------------------------------------------------------------------------------------------

  protected withArgumentDependentLookup(name: string, functions: FunctionInfo[], args: Expr[]): FunctionInfo[] {
    if (!args.some((arg) => this.library.isStdType(arg.type))) return functions;
    const found = this.library.std(name);
    if (found?.kind !== 'functions') return functions;
    return [...new Set([...functions, ...found.functions])];
  }

  protected checkDefined(fn: FunctionInfo, row: number): void {
    if (!fn.native && !this.usedFunctions.has(fn)) this.usedFunctions.set(fn, row);
  }

  protected constantArgument(node: Syntax): number {
    const expr = this.compileExpression(node);
    const value = this.rvalue(expr).constant;
    if (value === undefined) return this.error(node.row, 'テンプレート引数には定数を書いてください。');
    return Number(value);
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
    if (length === 0) return this.error(size.row, '大きさが 0 の配列は作れません。');
    return length;
  }

  findName(name: string): Entity | undefined {
    const found = super.findName(name);
    if (found) return found;
    if (this.usesStdLocally.size > 0 && this.context.scopes.some((scope) => this.usesStdLocally.has(scope))) {
      return this.library.std(name);
    }
    return undefined;
  }
}

/** Whether two functions take the same parameter types, as redeclarations and overloads compare them. */
function sameParameters(a: FunctionInfo, b: FunctionInfo): boolean {
  return (
    a.params.length === b.params.length &&
    a.params.every((param, index) => sameType(adjustParameter(param.type), adjustParameter(b.params[index].type))) &&
    (!a.owner || a.isConst === b.isConst)
  );
}

/** A parameter's type as overloading compares it: without top-level `const`. */
function adjustParameter(type: Type): Type {
  return type.kind === 'reference' ? type : unqualified(type);
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
    return { ...param, name: other.name, defaultValue: param.defaultValue ?? other.defaultValue };
  });
}

/** Whether an overriding function's return type is covariant with the overridden one's (a pointer to a derived class). */
function covariant(base: Type, derived: Type): boolean {
  const a = target(base);
  const b = target(derived);
  return a?.kind === 'class' && b?.kind === 'class' && b.cls.isDerivedFrom(a.cls) && base.kind === derived.kind;
}

const target = (type: Type): Type | undefined =>
  type.kind === 'pointer' || type.kind === 'reference' ? type.to : undefined;

/** The value static storage starts with: zero for scalars, before dynamic initialization. */
/** Gives the scalars an object never wrote the zero that static storage starts with. */
function zeroFilled(value: Value, type: Type): Value {
  if (value === UNINIT) return type.kind === 'class' || type.kind === 'array' ? value : zeroOf(type);
  if (type.kind === 'array' && value instanceof ArrayStore) {
    for (const [index, item] of value.values.entries()) value.values[index] = zeroFilled(item, type.of);
  } else if (type.kind === 'class' && value instanceof CObject && !type.cls.library) {
    for (const field of value.cls.fields) {
      if (field.type.kind !== 'reference')
        value.values[field.index] = zeroFilled(value.values[field.index], field.type);
    }
  }
  return value;
}

function staticZero(type: Type): Value {
  if (type.kind === 'array') return new ArrayStore(Array.from({ length: type.length ?? 0 }, () => staticZero(type.of)));
  if (type.kind === 'class') return UNINIT;
  return zeroOf(type);
}

/** Copies a member's value as the implicit copy constructor does. */
function copyValue(frame: Frame, type: Type, value: Value): Value {
  if (value === UNINIT) return UNINIT;
  if (type.kind === 'class') return type.cls.operations?.copy(frame, value) ?? value;
  if (type.kind === 'array')
    return new ArrayStore((value as ArrayStore).values.map((item) => copyValue(frame, type.of, item)));
  return value;
}

/** Assigns a member's value as the implicit copy assignment operator does, giving the member's new value. */
function assignValue(frame: Frame, type: Type, target: Value, source: Value): Value {
  if (type.kind === 'class') {
    if (target === UNINIT || source === UNINIT) return copyValue(frame, type, source);
    type.cls.operations?.assign(frame, target, source);
    return target;
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
    if (to.name === 'double') return false;
    return (
      constant === undefined ||
      (Number.isFinite(Number(constant)) && Math.abs(Number(constant)) > 3.4028234663852886e38)
    );
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
