import type { Value } from './arith';
import type {
  Compound,
  Declaration,
  Declarator,
  Expression,
  ExternalDeclaration,
  FunctionDefinition,
  InitDeclarator,
  Initializer,
  StorageClass,
  TranslationUnit,
} from './ast';
import type { CompileOptions, Entity, FunctionContext, Operand } from './compilerBase';
import { declaredName, findFunctionDeclarator } from './convert';
import { isNullConstant, type SpecialCall } from './expressionCompiler';
import { decodeStringLiteral } from './literals';
import { TURTLE_HEADER_NAME } from './parse';
import {
  Completion,
  type Exec,
  Frame,
  type FunctionInfo,
  type GlobalInfo,
  type LocalInfo,
  type Runtime,
  storeValue,
} from './runtime';
import { type Compiled, StatementCompiler } from './statementCompiler';
import {
  compatible,
  composite,
  type CType,
  type FunctionType,
  INT,
  isCharArray,
  isComplete,
  isScalar,
  sizeOf,
  typeName,
  unqualified,
} from './types';
import { unsupported } from './unsupported';

/** A library function: its implementation, or the reason the interpreter leaves it out. */
export type LibraryEntry =
  | { kind: 'native'; run: NonNullable<FunctionInfo['native']>; special?: SpecialCall }
  | { kind: 'unsupported'; feature: string };

export interface CompiledProgram {
  globals: GlobalInfo[];
  functions: FunctionInfo[];
  strings: Uint8Array[];
  main: FunctionInfo;
}

/** Writes an initializer's values into an object at an address. */
type Writer = (frame: Frame, address: number) => void;

interface LocalPart {
  run: (frame: Frame) => void;
  initializes: boolean;
}

export class Compiler extends StatementCompiler {
  constructor(
    options: CompileOptions,
    private readonly library: (name: string) => LibraryEntry | undefined
  ) {
    super(options);
  }

  compile(unit: TranslationUnit): CompiledProgram {
    for (const item of unit.items) this.externalDeclaration(item);
    const main = this.scope.ordinary.get('main');
    if (main?.kind !== 'function' || !main.fn.isDefined)
      this.error(0, 'main 関数がありません（int main(void) { ... } を書いてください）。');
    for (const fn of this.functions) {
      if (fn.referencedAt !== undefined && !fn.isDefined && !fn.native && fn.header === undefined) {
        this.error(fn.referencedAt, `関数「${fn.name}」は宣言されていますが、定義されていません。`);
      }
    }
    return { globals: this.globals, functions: this.functions, strings: this.strings, main: main.fn };
  }

  protected specialCall(name: string): SpecialCall | undefined {
    const entry = this.library(name);
    return entry?.kind === 'native' ? entry.special : undefined;
  }

  protected checkFunctionUse(fn: FunctionInfo, row: number): void {
    fn.referencedAt ??= row;
    if (fn.header === undefined) return;
    const entry = this.library(fn.name);
    if (entry?.kind === 'unsupported') unsupported(row, entry.feature);
  }

  private externalDeclaration(item: ExternalDeclaration): void {
    if (item.kind === 'function') {
      this.functionDefinition(item);
      return;
    }
    this.fileScopeDeclaration(item);
  }

  // File scope --------------------------------------------------------------------------------------------------------

  private fileScopeDeclaration(declaration: Declaration): void {
    const { specifiers } = declaration;
    if (specifiers.storage === 'auto' || specifiers.storage === 'register') {
      this.error(declaration.row, `関数の外の宣言には ${specifiers.storage} を付けられません。`);
    }
    const base = this.baseType(specifiers);
    for (const declarator of declaration.declarators) {
      const { type, name, row } = this.declaredType(base, declarator.declarator);
      if (name === undefined) this.error(row, '宣言する名前を書いてください。');
      if (specifiers.storage === 'typedef') {
        this.declareTypedef(name, type, row);
        continue;
      }
      if (type.kind === 'function') {
        if (declarator.init) this.error(row, `関数「${name}」には初期値を書けません。`);
        this.declareFunction(name, type, row, specifiers.storage === 'static', declaration.fromHeader);
        continue;
      }
      this.declareGlobal(name, type, row, specifiers.storage, declarator.init, declaration.fromHeader);
    }
  }

  private declareTypedef(name: string, type: CType, row: number): void {
    const existing = this.scope.ordinary.get(name);
    if (existing) {
      if (existing.kind === 'typedef' && compatible(existing.type, type)) return;
      this.error(row, `「${name}」が2回宣言されています。`);
    }
    this.scope.ordinary.set(name, { kind: 'typedef', type });
  }

  protected declareFunction(
    name: string,
    type: FunctionType,
    row: number,
    isStatic: boolean,
    header?: string
  ): FunctionInfo {
    const looked = this.scope.lookup(name);
    // The turtle's functions are visible without an #include, so a program may still declare its own of their names.
    const isTurtleBuiltin =
      looked?.kind === 'function' && looked.fn.header === TURTLE_HEADER_NAME && header !== TURTLE_HEADER_NAME;
    const existing = isTurtleBuiltin ? undefined : looked;
    if (existing && existing.kind === 'function') {
      if (!compatible(existing.type, type)) {
        this.error(row, `関数「${name}」の型が、前の宣言（${typeName(existing.type)}）と合いません。`);
      }
      existing.fn.type = composite(existing.fn.type, type) as FunctionType;
      existing.type = existing.fn.type;
      if (this.scope.ordinary.get(name) !== existing) this.scope.ordinary.set(name, existing);
      return existing.fn;
    }
    if (existing && this.scope.ordinary.get(name) === existing) this.error(row, `「${name}」が2回宣言されています。`);
    const global = isTurtleBuiltin ? undefined : this.findFileScope(name);
    if (global && global.kind === 'function') {
      if (!compatible(global.type, type))
        this.error(row, `関数「${name}」の型が、前の宣言（${typeName(global.type)}）と合いません。`);
      this.scope.ordinary.set(name, global);
      return global.fn;
    }
    const info: FunctionInfo = {
      name,
      type,
      row,
      isDefined: false,
      isStatic,
      locals: [],
      params: [],
      slotCount: 0,
      isAtomic: false,
      ...(header === undefined ? {} : { header }),
    };
    if (header !== undefined) {
      const entry = this.library(name);
      if (entry?.kind === 'native') info.native = entry.run;
    }
    this.functions.push(info);
    const entity = { kind: 'function' as const, fn: info, type };
    this.scope.ordinary.set(name, entity);
    this.fileScope.ordinary.set(name, entity);
    return info;
  }

  private get fileScope(): typeof this.scope {
    let scope = this.scope;
    while (scope.parent) scope = scope.parent;
    return scope;
  }

  private findFileScope(name: string): ReturnType<typeof this.scope.lookup> {
    return this.fileScope.ordinary.get(name);
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- C's rules for tentative definitions and redeclarations.
  private declareGlobal(
    name: string,
    declaredType: CType,
    row: number,
    storage: string | undefined,
    init: Initializer | undefined,
    header: string | undefined
  ): GlobalInfo {
    let type = declaredType;
    if (init && storage === 'extern' && this.fn) this.error(row, '関数の中の extern の変数には、初期値を書けません。');
    if (init && type.kind === 'array' && type.length === undefined)
      type = { ...type, length: this.initializerLength(type, init) };
    const existing = this.fileScope.ordinary.get(name);
    if (existing) {
      if (existing.kind !== 'global') this.error(row, `「${name}」が2回宣言されています。`);
      if (!compatible(existing.type, type)) {
        this.error(row, `変数「${name}」の型が、前の宣言（${typeName(existing.type)}）と合いません。`);
      }
      const global = existing.global;
      global.type = composite(global.type, type);
      existing.type = global.type;
      if (init) {
        if (global.initialize) this.error(row, `変数「${name}」が2回定義されています。`);
        global.initialize = this.staticInitializer(global.type, init, row);
      }
      if (storage !== 'extern') global.isDefined = true;
      this.scope.ordinary.set(name, existing);
      return global;
    }
    const global: GlobalInfo = {
      index: this.globals.length,
      name,
      type,
      row,
      isShown: header === undefined && !isConstGlobal(type),
      isReadOnly: false,
      isDefined: storage !== 'extern',
    };
    this.globals.push(global);
    const entity: Extract<Entity, { kind: 'global' }> = { kind: 'global', global, type };
    this.fileScope.ordinary.set(name, entity);
    this.scope.ordinary.set(name, entity);
    if (init) {
      global.initialize = this.staticInitializer(type, init, row);
      const constant = this.foldedConstant(type, init);
      if (constant !== undefined) entity.constant = constant;
    }
    return global;
  }

  /** An initializer of an object with static storage, whose values must be known before the program runs. */
  private staticInitializer(type: CType, init: Initializer, row: number): GlobalInfo['initialize'] {
    if (!isComplete(type)) this.error(row, `変数の型（${typeName(type)}）の中身が決まっていません。`);
    const writer = this.initializer(type, init, true);
    return (runtime, block) => {
      writer(globalFrame(runtime), block.base);
    };
  }

  // Functions ---------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 30 -- Declaring a function's parameters, checking main's form.
  private functionDefinition(definition: FunctionDefinition): void {
    const { specifiers, row } = definition;
    if (specifiers.storage === 'typedef' || specifiers.storage === 'auto' || specifiers.storage === 'register') {
      this.error(row, `関数の定義には ${specifiers.storage} を付けられません。`);
    }
    const base = this.baseType(specifiers);
    const { type, name } = this.declaredType(base, definition.declarator);
    if (type.kind !== 'function' || name === undefined) this.error(row, '関数の定義の書き方に誤りがあります。');
    if (!findFunctionDeclarator(definition.declarator)) this.error(row, '関数の定義の書き方に誤りがあります。');
    const ret = unqualified(type.ret);
    if (ret.kind !== 'void' && !isComplete(ret))
      this.error(row, `戻り値の型（${typeName(ret)}）の中身が定義されていません。`);
    if (name === 'main') this.checkMain(type, row);
    const info = this.declareFunction(name, type, row, specifiers.storage === 'static', undefined);
    if (info.isDefined) this.error(row, `関数「${name}」が2回定義されています。`);
    if (info.header !== undefined)
      this.error(row, `関数「${name}」は標準ライブラリにあるので、同じ名前の関数は定義できません。`);
    info.isDefined = true;
    info.row = row;
    const annotations = this.options.trace?.atomicAnnotations;
    info.isAtomic =
      annotations !== undefined &&
      [...annotations.keys()].some((annotation) => annotation >= row && annotation <= definition.bodyRow);
    const declarator = findFunctionDeclarator(definition.declarator) as Extract<Declarator, { kind: 'function' }>;
    const context: FunctionContext = {
      info,
      returnType: type.ret,
      labels: new Map(),
      nextLabel: 0,
      loopDepth: 0,
      switches: [],
      addressTaken: addressTakenNames(definition.body),
      registerLocals: new Set(),
    };
    const outer = this.fn;
    this.fn = context;
    try {
      this.withScope(() => {
        // `(void)` declares no parameters.
        const params = (type.params ?? []).length === 0 ? [] : (declarator.params ?? []);
        for (const param of params) {
          const { type: paramType, name: declaredParam } = this.parameterType(param);
          // clang accepts an unnamed parameter in a definition, as C23 does; the function cannot read it.
          const paramName = declaredParam ?? `\0${param.row}:${info.params.length}`;
          if (!isComplete(paramType))
            this.error(param.row, `引数「${paramName}」の型（${typeName(paramType)}）の中身が定義されていません。`);
          if (this.scope.ordinary.has(paramName)) this.error(param.row, `引数「${paramName}」が2つあります。`);
          const local = this.addLocal(paramName, paramType, param.row, true);
          if (param.specifiers.storage === 'register') context.registerLocals.add(local);
          info.params.push(local);
        }
        const body = this.compound(definition.body, true);
        for (const [labelName, label] of context.labels) {
          if (!label.defined) this.error(label.row, `ラベル「${labelName}」がありません。`);
        }
        info.body = functionBody(body.exec, name === 'main');
      });
    } finally {
      this.fn = outer;
    }
  }

  private checkMain(type: FunctionType, row: number): void {
    if (unqualified(type.ret).kind !== 'int' || (type.ret.kind === 'int' && type.ret.name !== 'int')) {
      this.error(row, 'main 関数の戻り値の型は int にしてください。');
    }
    const params = type.params ?? [];
    if (params.length === 0) return;
    if (params.length !== 2 || type.variadic) {
      this.error(row, 'main 関数の引数は、書かないか（void）、int argc と char *argv[] の2つにしてください。');
    }
    const [argc, argv] = params;
    if (unqualified(argc).kind !== 'int' || (argc.kind === 'int' && argc.name !== 'int')) {
      this.error(row, 'main 関数の1つ目の引数の型は int にしてください。');
    }
    const isCharPointerPointer =
      argv.kind === 'pointer' && argv.to.kind === 'pointer' && argv.to.to.kind === 'int' && argv.to.to.name === 'char';
    if (!isCharPointerPointer) this.error(row, 'main 関数の2つ目の引数の型は char *argv[]（char **）にしてください。');
  }

  private addLocal(name: string, type: CType, row: number, isParameter: boolean): LocalInfo {
    const context = this.context;
    const inMemory = type.kind === 'array' || type.kind === 'record' || context.addressTaken.has(name);
    const local: LocalInfo = {
      name,
      type,
      index: context.info.locals.length,
      row,
      inMemory,
      size: inMemory ? sizeOf(type) : 0,
      isParameter,
    };
    context.info.locals.push(local);
    context.info.slotCount = context.info.locals.length;
    this.scope.ordinary.set(name, { kind: 'local', local, type });
    return local;
  }

  // Block scope -------------------------------------------------------------------------------------------------------

  protected localDeclaration(declaration: Declaration): Compiled {
    const { specifiers, row } = declaration;
    const base = this.baseType(specifiers);
    const parts: LocalPart[] = [];
    for (const declarator of declaration.declarators) {
      const part = this.localDeclarator(specifiers.storage, base, declarator);
      if (part) parts.push(part);
    }
    const step = parts.some((part) => part.initializes) ? this.stepRow(row) : undefined;
    const run = (frame: Frame): void => {
      for (const part of parts) part.run(frame);
    };
    const exec: Exec =
      step === undefined
        ? (frame) => {
            run(frame);
            return Completion.Normal;
          }
        : (frame) => {
            frame.runtime.steps.runStatement(step, false, () => run(frame));
            return Completion.Normal;
          };
    return { exec, labels: new Set() };
  }

  private localDeclarator(
    storage: StorageClass | undefined,
    base: CType,
    declarator: InitDeclarator
  ): LocalPart | undefined {
    const declared = this.declaredType(base, declarator.declarator);
    const { name } = declared;
    let { type } = declared;
    if (name === undefined) this.error(declared.row, '宣言する名前を書いてください。');
    if (storage === 'typedef') {
      if (this.scope.ordinary.has(name)) this.error(declared.row, `「${name}」が2回宣言されています。`);
      this.scope.ordinary.set(name, { kind: 'typedef', type });
      return undefined;
    }
    if (type.kind === 'function') {
      if (storage === 'static') this.error(declared.row, '関数の中では、static の関数は宣言できません。');
      this.declareFunction(name, type, declared.row, false, undefined);
      return undefined;
    }
    if (this.scope.ordinary.has(name)) this.error(declared.row, `「${name}」が2回宣言されています。`);
    const { init } = declarator;
    if (storage === 'extern') {
      if (init) this.error(declared.row, '関数の中の extern の変数には、初期値を書けません。');
      this.externLocal(name, type, declared.row);
      return undefined;
    }
    if (init && type.kind === 'array' && type.length === undefined)
      type = { ...type, length: this.initializerLength(type, init) };
    if (type.kind === 'void') this.error(declared.row, `変数「${name}」の型に void は使えません。`);
    if (!isComplete(type))
      this.error(declared.row, `変数「${name}」の型（${typeName(type)}）の中身が決まっていません。`);
    if (storage === 'static') return { run: this.staticLocal(name, type, declared.row, init), initializes: false };
    return this.automaticLocal(name, type, declared.row, init, storage === 'register');
  }

  private externLocal(name: string, type: CType, row: number): void {
    const existing = this.fileScope.ordinary.get(name);
    const global =
      existing?.kind === 'global'
        ? existing.global
        : this.declareGlobal(name, type, row, 'extern', undefined, undefined);
    this.scope.ordinary.set(name, { kind: 'global', global, type: global.type });
  }

  private staticLocal(name: string, type: CType, row: number, init: Initializer | undefined): (frame: Frame) => void {
    const global: GlobalInfo = {
      index: this.globals.length,
      name,
      type,
      row,
      isShown: false,
      isReadOnly: false,
      isDefined: true,
    };
    this.globals.push(global);
    const local = this.addLocal(name, type, row, false);
    local.staticGlobal = global;
    local.inMemory = true;
    if (init) global.initialize = this.staticInitializer(type, init, row);
    this.foldInto(name, type, init);
    const index = local.index;
    return (frame) => {
      frame.live[index] = true;
    };
  }

  private automaticLocal(
    name: string,
    type: CType,
    row: number,
    init: Initializer | undefined,
    isRegister: boolean
  ): LocalPart {
    const local = this.addLocal(name, type, row, false);
    if (isRegister) this.context.registerLocals.add(local);
    this.foldInto(name, type, init);
    const index = local.index;
    if (!init) {
      return {
        run: local.inMemory
          ? (frame) => {
              frame.live[index] = true;
              const block = frame.runtime.memory.find(frame.bases[index]);
              block?.initialized.fill(0);
            }
          : (frame) => {
              frame.live[index] = true;
              frame.slots[index] = undefined;
            },
        initializes: false,
      };
    }
    if (!local.inMemory) {
      const value = this.scalarInitializer(type, init);
      return {
        run: (frame) => {
          frame.slots[index] = value(frame) as number;
          frame.live[index] = true;
        },
        initializes: true,
      };
    }
    const writer = this.initializer(type, init, false);
    return {
      run: (frame) => {
        writer(frame, frame.bases[index]);
        frame.live[index] = true;
      },
      initializes: true,
    };
  }

  private foldInto(name: string, type: CType, init: Initializer | undefined): void {
    const constant = this.foldedConstant(type, init);
    const entity = this.scope.ordinary.get(name);
    if (constant !== undefined && entity?.kind === 'local') entity.constant = constant;
  }

  // Initializers ------------------------------------------------------------------------------------------------------

  private scalarInitializer(type: CType, init: Initializer): (frame: Frame) => Value {
    const expression = this.singleExpression(type, init);
    return this.convertForAssignment(this.rvalue(expression), type, 'initialization', expression.row);
  }

  /** The expression initializing a scalar, which braces may enclose once. */
  private singleExpression(type: CType, init: Initializer): Expression {
    if (init.kind === 'expression') return init.expression;
    if (init.items.length === 0) unsupported(init.row, '空の { } による初期化');
    const [first] = init.items;
    if (first.kind === 'list') this.error(first.row, `${typeName(type)} の初期化に、{ } を重ねて書けません。`);
    return first.expression;
  }

  /** The length that an initializer gives an array declared without one. */
  private initializerLength(type: Extract<CType, { kind: 'array' }>, init: Initializer): number {
    if (isCharArray(type)) {
      const literal = stringLiteralOf(init);
      if (literal) return decodeStringLiteral(literal.parts, literal.row).length;
    }
    if (init.kind !== 'list') this.error(init.row, '配列の初期化には { } か文字列リテラルを書いてください。');
    const elementSize = elementCount(type.of);
    let count = 0;
    let position = 0;
    for (const item of init.items) {
      if (item.kind === 'list' || elementSize === 1) {
        position++;
      } else {
        position += 1 / elementSize;
      }
      count = Math.max(count, Math.ceil(position - 1e-9));
    }
    if (count === 0) unsupported(init.row, '空の { } による初期化');
    return count;
  }

  /** Compiles an initializer into a writer that zeroes the object and stores the given values in it. */
  protected initializer(type: CType, init: Initializer, isStatic: boolean): Writer {
    const writes: { offset: number; write: Writer }[] = [];
    if (isScalar(type) || init.kind === 'expression') {
      if (!isScalar(type) && init.kind === 'expression') {
        const writer = this.aggregateFromExpression(type, init.expression, isStatic);
        if (writer) return writer;
      }
      const expression = this.singleExpression(type, init);
      const operand = this.rvalue(expression);
      this.checkStatic(operand, expression, isStatic);
      const value = this.convertForAssignment(operand, unqualified(type), 'initialization', expression.row);
      return (frame, address) => storeValue(frame.runtime, address, unqualified(type), value(frame));
    }
    if (init.items.length === 0) unsupported(init.row, '空の { } による初期化');
    const cursor = { items: init.items, index: 0 };
    this.aggregate(type, cursor, 0, writes, isStatic, true);
    if (cursor.index < cursor.items.length) {
      // clang warns about excess initializers and ignores them, but still checks their types.
      for (const item of cursor.items.slice(cursor.index)) if (item.kind === 'expression') this.rvalue(item.expression);
    }
    const size = sizeOf(type);
    return (frame, address) => {
      const block = frame.runtime.memory.locate(address, size);
      const offset = address - block.base;
      block.bytes.fill(0, offset, offset + size);
      block.initialized.fill(1, offset, offset + size);
      for (const { offset: at, write } of writes) write(frame, address + at);
    };
  }

  /** `struct P q = p;` or `char s[] = "abc";`: an aggregate initialized from one expression. */
  private aggregateFromExpression(type: CType, expression: Expression, isStatic: boolean): Writer | undefined {
    if (type.kind === 'array') {
      if (isCharArray(type) && stringOf(expression)) {
        const writes: { offset: number; write: Writer }[] = [];
        this.stringInto(type, stringOf(expression) as Extract<Expression, { kind: 'string' }>, 0, writes);
        const size = sizeOf(type);
        return (frame, address) => {
          const block = frame.runtime.memory.locate(address, size);
          const offset = address - block.base;
          block.bytes.fill(0, offset, offset + size);
          block.initialized.fill(1, offset, offset + size);
          for (const { offset: at, write } of writes) write(frame, address + at);
        };
      }
      this.error(expression.row, '配列の初期化には { } か文字列リテラルを書いてください。');
    }
    if (type.kind === 'record') {
      const operand = this.rvalue(expression);
      this.checkStatic(operand, expression, isStatic);
      const value = this.convertForAssignment(operand, unqualified(type), 'initialization', expression.row);
      return (frame, address) => storeValue(frame.runtime, address, type, value(frame));
    }
    return undefined;
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- C's rules for braces and brace elision.
  private aggregate(
    type: CType,
    cursor: { items: Initializer[]; index: number },
    offset: number,
    writes: { offset: number; write: Writer }[],
    isStatic: boolean,
    braced: boolean
  ): void {
    if (type.kind === 'array') {
      const length = type.length ?? 0;
      const elementSize = sizeOf(type.of);
      if (isCharArray(type) && cursor.index < cursor.items.length) {
        const literal = stringLiteralOf(cursor.items[cursor.index]);
        if (literal) {
          cursor.index++;
          this.stringInto(type, literal, offset, writes);
          return;
        }
      }
      for (let index = 0; index < length && cursor.index < cursor.items.length; index++) {
        this.element(type.of, cursor, offset + index * elementSize, writes, isStatic);
      }
      return;
    }
    if (type.kind === 'record') {
      const fields = type.info.fields ?? [];
      const members =
        type.info.kind === 'union' ? fields.slice(0, 1) : fields.filter((field) => field.name !== undefined);
      for (const field of members) {
        if (cursor.index >= cursor.items.length) break;
        if (field.bitWidth !== undefined) {
          const item = cursor.items[cursor.index++];
          const expression = this.singleExpression(field.type, item);
          const operand = this.rvalue(expression);
          this.checkStatic(operand, expression, isStatic);
          const value = this.convertForAssignment(operand, field.type, 'initialization', expression.row);
          const store = this.bitFieldStore(field);
          writes.push({
            offset: offset + field.offset,
            write: (frame, address) => store(frame, address, value(frame)),
          });
          continue;
        }
        this.element(field.type, cursor, offset + field.offset, writes, isStatic);
      }
      return;
    }
    void braced;
  }

  /** One element or member: a braced list for it, an expression of its type, or the start of its elided braces. */
  private element(
    type: CType,
    cursor: { items: Initializer[]; index: number },
    offset: number,
    writes: { offset: number; write: Writer }[],
    isStatic: boolean
  ): void {
    const item = cursor.items[cursor.index];
    if (isScalar(type)) {
      cursor.index++;
      const expression = this.singleExpression(type, item);
      const operand = this.rvalue(expression);
      this.checkStatic(operand, expression, isStatic);
      const value = this.convertForAssignment(operand, unqualified(type), 'initialization', expression.row);
      const target = unqualified(type);
      writes.push({ offset, write: (frame, address) => storeValue(frame.runtime, address, target, value(frame)) });
      return;
    }
    if (item.kind === 'list') {
      cursor.index++;
      const inner = { items: item.items, index: 0 };
      this.aggregate(type, inner, offset, writes, isStatic, true);
      return;
    }
    if (type.kind === 'record') {
      // A struct may also be initialized from an expression of its own type, without braces.
      const operand = this.rvalue(item.expression);
      if (operand.type.kind === 'record' && operand.type.info === type.info) {
        cursor.index++;
        this.checkStatic(operand, item.expression, isStatic);
        const value = operand.value;
        writes.push({ offset, write: (frame, address) => storeValue(frame.runtime, address, type, value(frame)) });
        return;
      }
    }
    this.aggregate(type, cursor, offset, writes, isStatic, false);
  }

  private stringInto(
    type: Extract<CType, { kind: 'array' }>,
    literal: Extract<Expression, { kind: 'string' }>,
    offset: number,
    writes: { offset: number; write: Writer }[]
  ): void {
    const bytes = decodeStringLiteral(literal.parts, literal.row);
    // clang warns when the literal is longer than the array and copies only what fits.
    const copied = bytes.slice(0, type.length ?? bytes.length);
    writes.push({
      offset,
      write: (frame, address) => {
        const block = frame.runtime.memory.locate(address, copied.length);
        block.bytes.set(copied, address - block.base);
      },
    });
  }

  private bitFieldStore(field: {
    type: CType;
    offset: number;
    bitOffset?: number;
    bitWidth?: number;
  }): (frame: Frame, address: number, value: Value) => void {
    const operand = this.memoryOperand(INT, () => 0);
    void operand;
    const width = field.bitWidth as number;
    const bitOffset = field.bitOffset ?? 0;
    const size = sizeOf(field.type);
    return (frame, address, value) => {
      const block = frame.runtime.memory.locate(address, size);
      const at = address - block.base;
      const mask = ((1n << BigInt(width)) - 1n) << BigInt(bitOffset);
      let raw = 0n;
      for (let index = size - 1; index >= 0; index--) raw = (raw << 8n) | BigInt(block.bytes[at + index]);
      raw = (raw & ~mask) | ((BigInt(value as number | bigint) << BigInt(bitOffset)) & mask);
      for (let index = 0; index < size; index++) block.bytes[at + index] = Number((raw >> BigInt(index * 8)) & 0xffn);
    };
  }

  private checkStatic(operand: Operand, expression: Expression, isStatic: boolean): void {
    if (!isStatic) return;
    if (operand.constant !== undefined || operand.isAddressConstant || isNullConstant(operand)) return;
    this.error(expression.row, '関数の外の変数と static の変数の初期値には、定数を書いてください。');
  }
}

function isConstGlobal(type: CType): boolean {
  return 'isConst' in type && type.isConst === true;
}

function stringOf(expression: Expression): Extract<Expression, { kind: 'string' }> | undefined {
  if (expression.kind === 'string') return expression;
  if (expression.kind === 'paren') return stringOf(expression.expression);
  return undefined;
}

/** The string literal of an initializer, which braces may enclose once. */
function stringLiteralOf(init: Initializer): Extract<Expression, { kind: 'string' }> | undefined {
  if (init.kind === 'expression') return stringOf(init.expression);
  if (init.items.length === 1 && init.items[0].kind === 'expression') return stringOf(init.items[0].expression);
  return undefined;
}

/** The number of scalars in a type, for the length an elided initializer list gives an array. */
function elementCount(type: CType): number {
  if (type.kind === 'array') return (type.length ?? 0) * elementCount(type.of);
  if (type.kind === 'record') {
    const fields = type.info.fields ?? [];
    if (type.info.kind === 'union') return fields.length > 0 ? elementCount(fields[0].type) : 1;
    return fields.filter((field) => field.name !== undefined).reduce((sum, field) => sum + elementCount(field.type), 0);
  }
  return 1;
}

function functionBody(exec: Exec, isMain: boolean): Exec {
  return (frame) => {
    exec(frame);
    // Reaching the end of main returns 0.
    if (isMain && frame.returnValue === undefined) frame.returnValue = 0;
    return Completion.Return;
  };
}

/** The names whose addresses a function body takes with `&`, whose variables must live in memory. */
function addressTakenNames(body: Compound): Set<string> {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if ((node as { kind?: string }).kind === 'address') {
      const name = addressedName((node as Extract<Expression, { kind: 'address' }>).operand);
      if (name !== undefined) names.add(name);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) visit(item);
      else visit(value);
    }
  };
  visit(body);
  return names;
}

function addressedName(operand: Expression): string | undefined {
  let target = operand;
  while (target.kind === 'paren' || target.kind === 'member' || target.kind === 'subscript') {
    target = target.kind === 'paren' ? target.expression : target.kind === 'member' ? target.object : target.array;
  }
  return target.kind === 'identifier' ? target.name : undefined;
}

/** A frame for the code that initializes static variables, which runs before main. */
function globalFrame(runtime: Runtime): Frame {
  return new Frame(
    runtime,
    {
      name: '',
      type: { kind: 'function', ret: INT, variadic: false },
      row: 0,
      isDefined: true,
      isStatic: false,
      locals: [],
      params: [],
      slotCount: 0,
      isAtomic: false,
    },
    undefined
  );
}

export { declaredName };
