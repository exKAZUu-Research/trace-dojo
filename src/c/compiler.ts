// code-gauge-allow-file fileNcss 788 -- Declaration and initializer compilation share symbol and type state.
import { misplacedAtomicMessage } from '../interpreter/traceAnnotations';
import type { Value } from './arith';
import type {
  Compound,
  Declaration,
  Declarator,
  Designator,
  Expression,
  ExternalDeclaration,
  FunctionDefinition,
  InitDeclarator,
  Initializer,
  Parameter,
  Specifiers,
  StorageClass,
  TranslationUnit,
} from './ast';
import type { CompileOptions, Entity, FunctionContext, LValue, Operand } from './compilerBase';
import { declaredName, findFunctionDeclarator } from './convert';
import { isNullConstant, readBits, type SpecialCall, writeBits } from './expressionCompiler';
import { decodeStringLiteral } from './literals';
import { TURTLE_HEADER_NAME } from './parse';
import { evaluate, type Evaluator, replacePointerBytes } from './pointerBounds';
import {
  Completion,
  type Exec,
  Frame,
  type FunctionInfo,
  type GlobalInfo,
  loadRecord,
  type LocalInfo,
  type Runtime,
  storeRecord,
  storeValue,
} from './runtime';
import { type Compiled, StatementCompiler } from './statementCompiler';
import {
  alignOf,
  compatible,
  composite,
  type CType,
  evaluatedArrayType,
  type Field,
  type FunctionType,
  hasVla,
  INT,
  isCharArray,
  isComplete,
  isConstQualified,
  isScalar,
  sizeIn,
  sizeOf,
  typeName,
  unqualified,
} from './types';
import { unsupported } from './unsupported';

/** A library function: its implementation, or the reason the interpreter leaves it out. */
export type LibraryEntry = (
  | { kind: 'native'; run: NonNullable<FunctionInfo['native']>; special?: SpecialCall }
  | { kind: 'unsupported'; feature: string }
) & { canDefine?: boolean; hasDefinition?: boolean };

export interface CompiledProgram {
  globals: GlobalInfo[];
  functions: FunctionInfo[];
  strings: Uint8Array[];
  main: FunctionInfo;
}

/** Writes an initializer's values into an object at an address. */
type Writer = (frame: Frame, address: number) => void;

/** A value an initializer writes at an offset in the object. */
interface Write {
  offset: number;
  size: number;
  write: Writer;
}

/** The subobject of an aggregate that an initializer list fills next. */
interface Cursor {
  type: CType;
  index: number;
  offset: number;
}

interface Member {
  type: CType;
  offset: number;
  field?: Field;
}

/** The named members of a struct or union, which an initializer list fills. */
function namedFields(type: Extract<CType, { kind: 'record' }>): Field[] {
  return (type.info.fields ?? []).filter((field) => field.name !== undefined || field.isAnonymous);
}

/** The subobject a cursor is at, or undefined past the end of its aggregate. */
function memberAt(cursor: Cursor): Member | undefined {
  const { type, index } = cursor;
  if (type.kind === 'array') {
    if (type.length !== undefined && index >= type.length) return undefined;
    return { type: type.of, offset: cursor.offset + index * sizeOf(type.of) };
  }
  if (type.kind !== 'record') return undefined;
  const field = namedFields(type)[index];
  return field ? { type: field.type, offset: cursor.offset + field.offset, field } : undefined;
}

/** Moves past the subobject just filled: to the next element or member, or past a union's one member. */
function advance(cursor: Cursor): void {
  cursor.index =
    cursor.type.kind === 'record' && cursor.type.info.kind === 'union' ? Number.POSITIVE_INFINITY : cursor.index + 1;
}

/** The number of elements of the outermost aggregate that the items so far reached, for an array of unknown length. */
function filledLength(stack: Cursor[]): number {
  // While a nested subobject is open, the outer element holding it counts; otherwise the cursor is already past it.
  return stack.length > 1 ? stack[0].index + 1 : stack[0].index;
}

function zeroedWriter(size: number, writes: Write[]): Writer {
  return (frame, address) => {
    const block = frame.runtime.memory.locate(address, size);
    const offset = address - block.base;
    replacePointerBytes(block.pointerBytes, offset, size);
    block.bytes.fill(0, offset, offset + size);
    block.initialized.fill(255, offset, offset + size);
    for (const { offset: at, write } of writes) write(frame, address + at);
  };
}

function replaceWrites(writes: Write[], offset: number, size: number): void {
  for (let index = writes.length - 1; index >= 0; index--)
    if (writes[index].offset >= offset && writes[index].offset + writes[index].size <= offset + size)
      writes.splice(index, 1);
}

interface LocalPart {
  run: (frame: Frame) => void;
  initializes: boolean;
}

export class Compiler extends StatementCompiler {
  private readonly linkage = new Map<string, Entity>();
  private readonly usedAtomicRows = new Set<number>();
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
    for (const fn of this.functions) this.checkFunctionDefinition(fn);
    for (const global of this.globals) this.completeGlobal(global);
    for (const row of this.options.trace?.atomicAnnotations.keys() ?? []) {
      if (!this.usedAtomicRows.has(row)) this.error(row, misplacedAtomicMessage);
    }
    return { globals: this.globals, functions: this.functions, strings: this.strings, main: main.fn };
  }

  private completeGlobal(global: GlobalInfo): void {
    if (!global.isDefined && global.header === undefined) global.isShown = false;
    if (!global.isDefined && global.header === undefined && global.referencedAt !== undefined)
      this.error(global.referencedAt, `変数「${global.name}」は宣言されていますが、定義されていません。`);
    if (global.isDefined && global.type.kind === 'array' && global.type.length === undefined)
      global.type = { ...global.type, length: 1 };
    if (global.type.kind === 'void' || (global.isDefined && !isComplete(global.type)))
      this.error(global.row, `変数「${global.name}」の型（${typeName(global.type)}）の中身が定義されていません。`);
  }

  private checkFunctionDefinition(fn: FunctionInfo): void {
    if (
      fn.referencedAt === undefined ||
      (fn.isDefined && !(fn.isInlineDefinition && !fn.hasExternalDeclaration)) ||
      fn.native
    )
      return;
    const entry = fn.header === undefined ? undefined : this.library(fn.name);
    if (entry?.kind === 'unsupported') unsupported(fn.referencedAt, entry.feature);
    this.error(fn.referencedAt, `関数「${fn.name}」は宣言されていますが、定義されていません。`);
  }

  protected specialCall(name: string): SpecialCall | undefined {
    const entry = this.library(name);
    return entry?.kind === 'native' ? entry.special : undefined;
  }

  protected checkFunctionUse(fn: FunctionInfo, row: number): void {
    if (!this.isUnevaluated) fn.referencedAt ??= row;
    if (fn.header === undefined) return;
    const entry = this.library(fn.name);
    if (entry?.kind === 'unsupported' && !entry.canDefine) unsupported(row, entry.feature);
  }

  private externalDeclaration(item: ExternalDeclaration): void {
    if (item.kind === 'function') {
      this.functionDefinition(item);
      return;
    }
    if (item.kind === 'staticAssert') {
      this.staticAssert(item);
      return;
    }
    this.fileScopeDeclaration(item);
  }

  // File scope --------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 17 -- File declarations share type, linkage and initializer checks.
  private fileScopeDeclaration(declaration: Declaration): void {
    const { specifiers } = declaration;
    if (specifiers.storage === 'auto' || specifiers.storage === 'register') {
      this.error(declaration.row, `関数の外の宣言には ${specifiers.storage} を付けられません。`);
    }
    const base = this.baseType(specifiers);
    for (const declarator of declaration.declarators) {
      const { type, name, row } = this.declaredType(base, declarator.declarator);
      if (name === undefined) this.error(row, '宣言する名前を書いてください。');
      this.validateInline(specifiers, type, name);
      const alignment = this.objectAlignment(specifiers, type);
      if (specifiers.storage === 'typedef') {
        this.declareTypedef(name, type, row);
        continue;
      }
      if (type.kind === 'function') {
        if (declarator.init) this.error(row, `関数「${name}」には初期値を書けません。`);
        const fn = this.declareFunction(name, type, row, specifiers.storage === 'static', declaration.fromHeader);
        if (!specifiers.isInline || specifiers.storage === 'extern') fn.hasExternalDeclaration = true;
        continue;
      }
      const global = this.declareGlobal(name, type, row, specifiers.storage, declarator.init, declaration.fromHeader);
      global.alignment = Math.max(global.alignment ?? 0, alignment ?? 0);
    }
  }

  private objectAlignment(specifiers: Specifiers, type: CType): number | undefined {
    if (!specifiers.alignas) return undefined;
    if (specifiers.storage === 'typedef' || specifiers.storage === 'register' || type.kind === 'function')
      this.error(specifiers.row, '_Alignas は、typedef・register・関数には指定できません。');
    const alignment = this.requestedAlignment(specifiers.alignas);
    if (alignment !== 0 && alignment < alignOf(type))
      this.error(specifiers.row, '_Alignas の大きさは、型のアラインメントより小さくできません。');
    return alignment;
  }

  private declareTypedef(name: string, type: CType, row: number): void {
    const existing = this.scope.ordinary.get(name);
    if (existing) {
      if (existing.kind === 'typedef' && compatible(existing.type, type)) return;
      this.error(row, `「${name}」が2回宣言されています。`);
    }
    this.scope.ordinary.set(name, { kind: 'typedef', type });
  }

  // code-gauge-allow functionCognitiveComplexity 24 -- Keep the compatible-declaration and builtin-replacement rules together; extracting branches would obscure their shared symbol state.
  // code-gauge-allow functionNcss 37 -- All declarations must reuse one function identity and its composite type.
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
    const local = this.scope.ordinary.get(name);
    if (local && local.kind !== 'function') this.error(row, `「${name}」が2回宣言されています。`);
    const existing = isTurtleBuiltin ? undefined : looked?.kind === 'function' ? looked : this.linkage.get(name);
    const entry = header === undefined ? undefined : this.library(name);
    if (existing?.kind === 'function' && isStatic && !existing.fn.isStatic && header === undefined)
      this.error(row, `関数「${name}」は外部リンケージで宣言されているので static にできません。`);
    if (existing && existing.kind === 'function') {
      if (existing.fn.isDefined && entry?.hasDefinition) this.error(row, `関数「${name}」が2回定義されています。`);
      if (!compatible(existing.type, type)) {
        this.error(row, `関数「${name}」の型が、前の宣言（${typeName(existing.type)}）と合いません。`);
      }
      existing.fn.type = composite(existing.fn.type, type) as FunctionType;
      existing.type = existing.fn.type;
      if (this.scope.ordinary.get(name) !== existing) this.scope.ordinary.set(name, existing);
      return existing.fn;
    }
    if (existing) this.error(row, `「${name}」が2回宣言されています。`);
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
    if (header !== undefined && entry?.kind === 'native') info.native = entry.run;
    this.functions.push(info);
    const entity = { kind: 'function' as const, fn: info, type };
    this.scope.ordinary.set(name, entity);
    this.linkage.set(name, entity);
    if (this.scope === this.fileScope) this.fileScope.ordinary.set(name, entity);
    return info;
  }

  private get fileScope(): typeof this.scope {
    let scope = this.scope;
    while (scope.parent) scope = scope.parent;
    return scope;
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- C's rules for tentative definitions and redeclarations.
  // code-gauge-allow functionNcss 37 -- Tentative definitions, composite types, and initializers update one symbol; separating branches would split that invariant.
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
    const existing =
      (this.scope === this.fileScope ? this.scope.ordinary.get(name) : undefined) ?? this.linkage.get(name);
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
      if (storage !== 'extern' || init !== undefined) global.isDefined = true;
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
      isDefined: storage !== 'extern' || init !== undefined,
      header,
    };
    this.globals.push(global);
    const entity: Extract<Entity, { kind: 'global' }> = { kind: 'global', global, type };
    this.linkage.set(name, entity);
    if (this.scope === this.fileScope) this.fileScope.ordinary.set(name, entity);
    this.scope.ordinary.set(name, entity);
    if (init) {
      entity.constantBytes = this.constantString(type, init);
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
  // code-gauge-allow functionNcss 50 -- Function setup shares linkage, parameter lengths, trace annotations and body state.
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
    this.validateInline(specifiers, type, name);
    if (name === 'main') this.checkMain(type, row);
    const info = this.declareFunction(name, type, row, specifiers.storage === 'static', undefined);
    if (specifiers.isInline && !info.isStatic && specifiers.storage === undefined) info.isInlineDefinition = true;
    else info.hasExternalDeclaration = true;
    if (info.isDefined) this.error(row, `関数「${name}」が2回定義されています。`);
    if (info.header !== undefined && !this.library(name)?.canDefine)
      this.error(row, `関数「${name}」は標準ライブラリにあるので、同じ名前の関数は定義できません。`);
    info.header = undefined;
    info.native = undefined;
    info.isDefined = true;
    info.row = row;
    const annotations = this.options.trace?.atomicAnnotations;
    const atomicRows = [...(annotations?.keys() ?? [])].filter(
      (annotation) => annotation >= row && annotation <= definition.bodyRow
    );
    info.isAtomic = atomicRows.length > 0;
    for (const annotation of atomicRows) this.usedAtomicRows.add(annotation);
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
      vlaCount: 0,
    };
    const outer = this.fn;
    this.fn = context;
    try {
      this.withScope(() => {
        // `(void)` declares no parameters.
        const params = (type.params ?? []).length === 0 ? [] : (declarator.params ?? []);
        for (const param of params) this.declareParameter(param, context);
        // Parameters of variably modified types, such as `int a[rows][cols]`, get their lengths on entry.
        const parameterLengths = this.takePendingVla();
        const body = this.compound(definition.body, true);
        for (const [labelName, label] of context.labels) {
          if (!label.defined) this.error(label.row, `ラベル「${labelName}」がありません。`);
        }
        info.body = functionBody(body.exec, name === 'main', parameterLengths);
      });
    } finally {
      this.fn = outer;
    }
  }

  private declareParameter(param: Parameter, context: FunctionContext): void {
    const { info } = context;
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
    this.declareStandaloneTag(declaration);
    const base = this.baseType(specifiers);
    const parts: LocalPart[] = [];
    for (const declarator of declaration.declarators) {
      const part = this.localDeclarator(specifiers.storage, base, declarator, declaration.fromHeader);
      this.alignLocal(specifiers, declarator);
      if (part) parts.push(part);
    }
    const step = parts.some((part) => part.initializes) ? this.stepRow(row) : undefined;
    const run = (frame: Frame): void => {
      for (const part of parts) frame.runtime.fullExpression(() => part.run(frame));
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
    return this.withVisibility({ exec, labels: new Set() });
  }

  private alignLocal(specifiers: Specifiers, declarator: InitDeclarator): void {
    const name = declaredName(declarator.declarator);
    const entity = name === undefined ? undefined : this.scope.ordinary.get(name);
    if (entity) {
      this.validateInline(specifiers, entity.type, name);
      const alignment = this.objectAlignment(specifiers, entity.type);
      if (entity.kind === 'local') {
        entity.local.alignment = alignment;
        if (entity.local.staticGlobal) entity.local.staticGlobal.alignment = alignment;
      } else if (entity.kind === 'global')
        entity.global.alignment = Math.max(entity.global.alignment ?? 0, alignment ?? 0);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 23 -- Storage class and variably modified types determine one local declaration.
  // code-gauge-allow functionNcss 43 -- Local declaration alternatives share storage and initializer state.
  private localDeclarator(
    storage: StorageClass | undefined,
    base: CType,
    declarator: InitDeclarator,
    header?: string
  ): LocalPart | undefined {
    const declared = this.declaredType(base, declarator.declarator);
    const lengths = this.takePendingVla();
    const { name } = declared;
    let { type } = declared;
    if (name === undefined) this.error(declared.row, '宣言する名前を書いてください。');
    if (storage === 'typedef') {
      this.declareTypedef(name, type, declared.row);
      return lengths ? { run: lengths, initializes: false } : undefined;
    }
    if (lengths && (storage === 'static' || storage === 'extern')) {
      this.error(declared.row, `${storage} の変数「${name}」の型には、可変長配列は使えません。`);
    }
    if (type.kind === 'function') {
      if (storage === 'static') this.error(declared.row, '関数の中では、static の関数は宣言できません。');
      this.declareFunction(name, type, declared.row, false, header);
      return undefined;
    }
    const { init } = declarator;
    if (storage === 'extern') {
      if (init) this.error(declared.row, '関数の中の extern の変数には、初期値を書けません。');
      this.externLocal(name, type, declared.row, header);
      return undefined;
    }
    if (this.scope.ordinary.has(name)) this.error(declared.row, `「${name}」が2回宣言されています。`);
    if (init && type.kind === 'array' && type.length === undefined)
      type = { ...type, length: this.initializerLength(type, init) };
    if (type.kind === 'void') this.error(declared.row, `変数「${name}」の型に void は使えません。`);
    if (!isComplete(type))
      this.error(declared.row, `変数「${name}」の型（${typeName(type)}）の中身が決まっていません。`);
    if (storage === 'static') return { run: this.staticLocal(name, type, declared.row, init), initializes: false };
    if (hasVla(type)) {
      if (init) this.error(declared.row, `可変長配列「${name}」には初期値を書けません。`);
      return this.variableLengthLocal(name, type, declared.row, lengths);
    }
    const part = this.automaticLocal(name, type, declared.row, init, storage === 'register');
    if (!lengths) return part;
    // A pointer to a variable-length array (`int (*p)[n]`) computes its lengths before its initializer.
    return {
      run: (frame) => {
        lengths(frame);
        part.run(frame);
      },
      initializes: part.initializes,
    };
  }

  private externLocal(name: string, type: CType, row: number, header?: string): void {
    const existing = this.scope.ordinary.get(name);
    if (existing && existing.kind !== 'global') this.error(row, `「${name}」が2回宣言されています。`);
    const global = this.declareGlobal(name, type, row, 'extern', undefined, header);
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

  /** A variable-length array, whose block its declaration creates once its lengths are known. */
  private variableLengthLocal(
    name: string,
    type: CType,
    row: number,
    lengths: ((frame: Frame) => void) | undefined
  ): LocalPart {
    const local = this.addLocal(name, type, row, false);
    local.inMemory = true;
    local.isVla = true;
    const index = local.index;
    return {
      run: (frame) => {
        lengths?.(frame);
        const block = frame.runtime.allocate(
          sizeIn(type, frame.vla),
          'stack',
          Math.max(alignOf(type), local.alignment ?? 0)
        );
        block.type = evaluatedArrayType(type, frame.vla);
        block.name = name;
        frame.bases[index] = block.base;
        frame.blocks.set(local.index, block);
        frame.live[index] = true;
      },
      initializes: false,
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
              block?.pointerBytes.clear();
            }
          : (frame) => {
              frame.live[index] = true;
              frame.assign(index, undefined);
            },
        initializes: false,
      };
    }
    if (!local.inMemory) {
      const value = this.scalarInitializer(type, init);
      return {
        run: (frame) => {
          const result = evaluate(value, frame);
          frame.assign(index, result);
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
    if (entity?.kind === 'local') {
      if (constant !== undefined) entity.constant = constant;
      if (init) entity.constantBytes = this.constantString(type, init);
    }
  }

  private constantString(type: CType, init: Initializer): Uint8Array | undefined {
    if (!isCharArray(type) || !isConstQualified(type.of)) return undefined;
    const literal = stringLiteralOf(init);
    return literal ? decodeStringLiteral(literal.parts, literal.row).slice(0, type.length) : undefined;
  }

  protected compoundLiteral(expression: Extract<Expression, { kind: 'compoundLiteral' }>): Operand {
    const { row, init } = expression;
    let type = this.typeOfName(expression.typeName);
    const lengths = this.takePendingVla();
    if (hasVla(type)) this.error(row, '複合リテラルの型には、可変長配列は指定できません。');
    if (type.kind === 'array' && type.length === undefined)
      type = { ...type, length: this.initializerLength(type, init) };
    if (type.kind === 'function' || type.kind === 'void' || !isComplete(type)) {
      this.error(row, `複合リテラルの型（${typeName(type)}）の中身が決まっていません。`);
    }
    const name = `\0literal${row}:${this.fn ? this.fn.info.locals.length : this.globals.length}`;
    if (!this.fn) {
      // At file scope, the object is static, so its address is a constant.
      const global = this.declareGlobal(name, type, row, 'static', init, undefined);
      global.isShown = false;
      const index = global.index;
      const operand = this.memoryOperand(type, (frame) => frame.runtime.globals[index].base);
      return { ...operand, isAddressConstant: true, lvalue: { ...(operand.lvalue as LValue), isStatic: true } };
    }
    const local = this.addLocal(name, type, row, false);
    local.inMemory = true;
    local.size = sizeOf(type);
    const writer = this.initializer(type, init, false);
    const index = local.index;
    return this.memoryOperand(type, (frame) => {
      lengths?.(frame);
      const address = frame.bases[index];
      writer(frame, address);
      return address;
    });
  }

  // Initializers ------------------------------------------------------------------------------------------------------

  private scalarInitializer(type: CType, init: Initializer): Evaluator {
    const expression = this.singleExpression(type, init);
    return this.convertForAssignment(this.rvalue(expression), type, 'initialization', expression.row);
  }

  /** The expression initializing a scalar, which braces may enclose once. */
  private singleExpression(type: CType, init: Initializer): Expression {
    if (init.kind === 'expression') return init.expression;
    if (init.kind === 'designated')
      return this.error(init.row, `${typeName(type)} の初期化に、要素の指定は書けません。`);
    // An empty initializer (C23, which clang accepts in C17) initializes a scalar to 0.
    if (init.items.length === 0) return { kind: 'number', text: '0', row: init.row };
    const [first, ...excess] = init.items;
    for (const item of excess) this.validateInitializer(item);
    if (first.kind !== 'expression')
      return this.error(first.row, `${typeName(type)} の初期化に、{ } や要素の指定は書けません。`);
    return first.expression;
  }

  private validateInitializer(init: Initializer): void {
    if (init.kind === 'expression') this.unevaluated(() => this.rvalue(init.expression));
    else if (init.kind === 'designated') this.validateInitializer(init.value);
    else for (const item of init.items) this.validateInitializer(item);
  }

  /** The length that an initializer gives an array declared without one. */
  private initializerLength(type: Extract<CType, { kind: 'array' }>, init: Initializer): number {
    if (isCharArray(type)) {
      const literal = stringLiteralOf(init);
      if (literal) return decodeStringLiteral(literal.parts, literal.row).length;
    }
    if (init.kind !== 'list') this.error(init.row, '配列の初期化には { } か文字列リテラルを書いてください。');
    return this.braced(type, init.items, 0, [], false);
  }

  /** Compiles an initializer into a writer that zeroes the object and stores the given values in it. */
  protected initializer(type: CType, init: Initializer, isStatic: boolean): Writer {
    const writes: Write[] = [];
    if (init.kind === 'designated') this.error(init.row, '初期化の指定（.x = や [n] =）は、{ } の中にしか書けません。');
    if (isScalar(type) || init.kind === 'expression') {
      if (!isScalar(type) && init.kind === 'expression') {
        const writer = this.aggregateFromExpression(type, init.expression, isStatic);
        if (writer) return writer;
      }
      const expression = this.singleExpression(type, init);
      const operand = this.rvalue(expression);
      this.checkStatic(operand, expression, isStatic);
      const value = this.convertForAssignment(operand, unqualified(type), 'initialization', expression.row);
      return (frame, address) => {
        const result = evaluate(value, frame);
        storeValue(frame.runtime, address, unqualified(type), result.value, result.range, result.bytes);
      };
    }
    this.braced(type, init.items, 0, writes, isStatic);
    return zeroedWriter(sizeOf(type), writes);
  }

  /** `struct P q = p;` or `char s[] = "abc";`: an aggregate initialized from one expression. */
  private aggregateFromExpression(type: CType, expression: Expression, isStatic: boolean): Writer | undefined {
    if (type.kind === 'array') {
      const literal = stringOf(expression);
      if (isCharArray(type) && literal) {
        const writes: Write[] = [];
        this.stringInto(type, literal, 0, writes);
        return zeroedWriter(sizeOf(type), writes);
      }
      this.unevaluated(() => this.rvalue(expression));
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

  /**
   * Compiles a braced list for an aggregate, as C17 6.7.9 walks it: items fill the current subobject in order, braces
   * may be left out for nested aggregates, and a designator moves to the subobject it names.
   *
   * @returns The number of elements the list gives an array of unknown length.
   */
  private braced(type: CType, items: Initializer[], offset: number, writes: Write[], isStatic: boolean): number {
    // `char s[] = {"abc"}`: a string literal may initialize a character array in braces of its own.
    const literal = items.length === 1 && items[0].kind === 'expression' ? stringOf(items[0].expression) : undefined;
    if (isCharArray(type) && literal) {
      this.stringInto(type, literal, offset, writes);
      return decodeStringLiteral(literal.parts, literal.row).length;
    }
    let stack: Cursor[] = [{ type, index: 0, offset }];
    let length = 0;
    for (const item of items) {
      if (item.kind === 'designated') {
        const targets = this.designate(stack[0], item);
        if (targets.length === 1) this.place(targets[0], item.value, writes, isStatic);
        else this.placeRange(targets, item.value, writes, isStatic);
        stack = targets.at(-1) as Cursor[];
      } else this.place(stack, item, writes, isStatic);
      length = Math.max(length, filledLength(stack));
    }
    return length;
  }

  private designate(root: Cursor, item: Extract<Initializer, { kind: 'designated' }>): Cursor[][] {
    let targets: Cursor[][] = [[{ ...root, index: 0 }]];
    for (const [position, designator] of item.designators.entries()) {
      targets = targets.flatMap((stack) =>
        this.designateStep(stack, designator, position < item.designators.length - 1)
      );
    }
    return targets;
  }

  private designateStep(stack: Cursor[], designator: Designator, descend: boolean): Cursor[][] {
    let cursor = stack.at(-1) as Cursor;
    for (const index of this.anonymousPath(cursor.type, designator)) {
      cursor.index = index;
      const member = memberAt(cursor) as Member;
      stack.push({ type: member.type, index: 0, offset: member.offset });
      cursor = stack.at(-1) as Cursor;
    }
    const { index, end = index } = this.designatorIndex(cursor.type, designator);
    const targets: Cursor[][] = [];
    for (let at = index; at <= end; at++) {
      const target = stack.map((entry) => ({ ...entry }));
      (target.at(-1) as Cursor).index = at;
      if (descend) {
        const member = memberAt(target.at(-1) as Cursor);
        if (!member || (member.type.kind !== 'array' && member.type.kind !== 'record'))
          this.error(designator.row, '初期化の指定で、配列でも構造体でもないものの中を指定しています。');
        target.push({ type: member.type, index: 0, offset: member.offset });
      }
      targets.push(target);
    }
    return targets;
  }

  private placeRange(targets: Cursor[][], item: Initializer, writes: Write[], isStatic: boolean): void {
    const members = targets.map((target) => memberAt(target.at(-1) as Cursor) as Member);
    const first = members[0];
    const size = sizeOf(first.type);
    const initial: Write[] = [];
    this.place(targets[0], item, initial, isStatic);
    for (const member of members) replaceWrites(writes, member.offset, size);
    const final = targets.at(-1) as Cursor[];
    if (targets.length > 1) advance(final.at(-1) as Cursor);
    writes.push({
      offset: first.offset,
      size: members.at(-1)!.offset - first.offset + size,
      write: (frame, address) => {
        const runtime = frame.runtime;
        const temporary = runtime.allocate(size, 'stack', alignOf(first.type));
        try {
          temporary.initialized.fill(255);
          for (const part of initial) part.write(frame, temporary.base + part.offset - first.offset);
          const value = loadRecord(runtime, temporary.base, size);
          for (const member of members) {
            const destination = address + member.offset - first.offset;
            if (member.field?.bitWidth !== undefined) {
              const field = member.field;
              const bits = readBits(
                temporary,
                0,
                field.bitOffset ?? 0,
                field.bitWidth as number,
                field.type as Extract<CType, { kind: 'int' }>
              );
              const block = runtime.memory.locate(destination, size);
              writeBits(block, destination - block.base, field.bitOffset ?? 0, field.bitWidth as number, bits);
            } else storeRecord(runtime, destination, value);
          }
        } finally {
          runtime.memory.release(temporary);
        }
      },
    });
  }

  /** The indexes of the unnamed members leading to a member that a `.name` designator names, outermost first. */
  private anonymousPath(type: CType, designator: Designator): number[] {
    if (designator.kind !== 'field' || type.kind !== 'record') return [];
    const fields = namedFields(type);
    if (fields.some((field) => field.name === designator.name)) return [];
    for (const [index, field] of fields.entries()) {
      if (field.isAnonymous && field.type.kind === 'record' && field.type.info.field(designator.name)) {
        return [index, ...this.anonymousPath(field.type, designator)];
      }
    }
    return [];
  }

  private designatorIndex(type: CType, designator: Designator): { index: number; end?: number } {
    if (designator.kind === 'field') {
      if (type.kind !== 'record')
        this.error(
          designator.row,
          `構造体・共用体ではないもの（${typeName(type)}）に .${designator.name} は指定できません。`
        );
      const index = namedFields(type).findIndex((field) => field.name === designator.name);
      if (index === -1)
        this.error(designator.row, `「${typeName(type)}」にはメンバ「${designator.name}」がありません。`);
      return { index };
    }
    if (type.kind !== 'array')
      this.error(designator.row, `配列ではないもの（${typeName(type)}）に [ ] は指定できません。`);
    const index = this.integerConstant(designator.index, '配列の初期化の添字');
    const end = designator.end === undefined ? undefined : this.integerConstant(designator.end, '配列の初期化の添字');
    const last = end ?? index;
    if (index < 0 || (type.length !== undefined && last >= type.length)) {
      this.error(designator.row, `配列の初期化の添字「${last}」が、配列の大きさを超えています。`);
    }
    if (end !== undefined && end < index) this.error(designator.row, '初期化の範囲（[a ... b]）が空です。');
    return { index, ...(end === undefined ? {} : { end }) };
  }

  /** Initializes the current subobject with one item, entering nested aggregates whose braces the list leaves out. */
  // code-gauge-allow functionCognitiveComplexity 25 -- The cases of C's brace elision.
  private place(stack: Cursor[], item: Initializer, writes: Write[], isStatic: boolean): void {
    for (;;) {
      const cursor = stack.at(-1) as Cursor;
      const member = memberAt(cursor);
      if (!member) {
        if (stack.length === 1) {
          // clang warns about excess initializers and ignores them, but still checks their types.
          this.validateInitializer(item);
          return;
        }
        stack.pop();
        advance(stack.at(-1) as Cursor);
        continue;
      }
      if (item.kind === 'list') {
        if (isScalar(member.type)) this.scalarInto(member, this.singleExpression(member.type, item), writes, isStatic);
        else {
          const size = sizeOf(member.type);
          replaceWrites(writes, member.offset, size);
          writes.push({ offset: member.offset, size, write: zeroedWriter(size, []) });
          this.braced(member.type, item.items, member.offset, writes, isStatic);
        }
        advance(cursor);
        return;
      }
      if (item.kind === 'designated') this.error(item.row, '初期化の指定の書き方に誤りがあります。');
      if (this.placeWhole(member, item.expression, writes, isStatic)) {
        advance(cursor);
        return;
      }
      stack.push({ type: member.type, index: 0, offset: member.offset });
    }
  }

  /** Initializes a member from one expression when it can take one: a scalar, a struct of its type, or a string. */
  private placeWhole(member: Member, expression: Expression, writes: Write[], isStatic: boolean): boolean {
    const { type } = member;
    if (isScalar(type)) {
      this.scalarInto(member, expression, writes, isStatic);
      return true;
    }
    const literal = stringOf(expression);
    if (isCharArray(type) && literal) {
      this.stringInto(type, literal, member.offset, writes);
      return true;
    }
    if (type.kind !== 'record') return false;
    const operand = this.rvalue(expression);
    if (operand.type.kind !== 'record' || operand.type.info !== type.info) return false;
    this.checkStatic(operand, expression, isStatic);
    const value = operand.value;
    replaceWrites(writes, member.offset, sizeOf(type));
    writes.push({
      offset: member.offset,
      size: sizeOf(type),
      write: (frame, address) => storeValue(frame.runtime, address, type, value(frame)),
    });
    return true;
  }

  private scalarInto(member: Member, expression: Expression, writes: Write[], isStatic: boolean): void {
    const operand = this.rvalue(expression);
    this.checkStatic(operand, expression, isStatic);
    const target = unqualified(member.type);
    const value = this.convertForAssignment(operand, target, 'initialization', expression.row);
    if (member.field?.bitWidth !== undefined) {
      const store = this.bitFieldStore(member.field);
      writes.push({
        offset: member.offset,
        size: sizeOf(target),
        write: (frame, address) => store(frame, address, value(frame)),
      });
      return;
    }
    replaceWrites(writes, member.offset, sizeOf(target));
    writes.push({
      offset: member.offset,
      size: sizeOf(target),
      write: (frame, address) => {
        const result = evaluate(value, frame);
        storeValue(frame.runtime, address, target, result.value, result.range, result.bytes);
      },
    });
  }

  private stringInto(
    type: Extract<CType, { kind: 'array' }>,
    literal: Extract<Expression, { kind: 'string' }>,
    offset: number,
    writes: Write[]
  ): void {
    const bytes = decodeStringLiteral(literal.parts, literal.row);
    // clang warns when the literal is longer than the array and copies only what fits.
    const copied = bytes.slice(0, type.length ?? bytes.length);
    const size = type.length ?? bytes.length;
    replaceWrites(writes, offset, size);
    const clear = zeroedWriter(size, []);
    writes.push({
      offset,
      size,
      write: (frame, address) => {
        clear(frame, address);
        const block = frame.runtime.memory.locate(address, copied.length);
        replacePointerBytes(block.pointerBytes, address - block.base, copied.length);
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
    const width = field.bitWidth as number;
    const bitOffset = field.bitOffset ?? 0;
    const size = sizeOf(field.type);
    return (frame, address, value) => {
      const block = frame.runtime.memory.locate(address, size);
      const at = address - block.base;
      writeBits(block, at, bitOffset, width, value as number | bigint);
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
  if (init.kind === 'list' && init.items.length === 1 && init.items[0].kind === 'expression') {
    return stringOf(init.items[0].expression);
  }
  return undefined;
}

function functionBody(exec: Exec, isMain: boolean, prepare: ((frame: Frame) => void) | undefined): Exec {
  return (frame) => {
    prepare?.(frame);
    exec(frame);
    // Reaching the end of main returns 0.
    if (isMain && frame.returnValue === undefined) frame.returnValue = 0;
    return Completion.Return;
  };
}

/** The names whose addresses a function body takes with `&`, whose variables must live in memory. */
// code-gauge-allow functionCognitiveComplexity 18 -- The recursive AST walk must visit every expression shape; splitting the visitor would only relocate its cases.
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
