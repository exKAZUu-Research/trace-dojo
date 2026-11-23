import type { KotlinFile } from './ast';
import { BodyCompiler } from './bodyCompiler';
import type { ArgumentSyntax, Candidate, ResolvedCall } from './callCompiler';
import {
  type Compiled,
  convertRepr,
  type Core,
  type Eval,
  type FunctionContext,
  type PackageScope,
  reprOf,
  type Scope,
} from './compilerBase';
import { type FileContext, TURTLE_PACKAGE } from './compilerCore';
import { unavailableMessage } from './convertSupport';
import { callFunction, parameterReprs, receiverRepr } from './dispatch';
import { jvmParameterDescriptor } from './jvmSignatures';
import { libraryClass } from './natives/registry';
import type { NativeFunction, NativeProperty } from './nativeTypes';
import { Frame, type FunctionInfo, MISSING } from './runtime';
import { ClassSymbol, FunctionSymbol, type MemberSymbol, VariableSymbol } from './symbols';
import { isSubtype } from './typeRelations';
import { type ClassType, isNonNullClass, type KType, resolved } from './types';
import { KObject, NULL, type Value } from './values';

/** Adds a symbol to the imports of a name, once, since a file's imports are resolved before and after its headers. */
function addOnce<T>(imports: Map<string, T[]>, name: string, symbol: T): void {
  const existing = imports.get(name) ?? [];
  if (!existing.includes(symbol)) imports.set(name, [...existing, symbol]);
}

const ROOT_DEFAULTS_INFO: FunctionInfo = {
  name: '<defaults>',
  locals: [],
  captures: [],
  slotCount: 8,
  isAtomic: false,
  isLibrary: true,
  isLambda: false,
  showsThis: false,
};

const samImplementations = new WeakMap<FunctionSymbol, ClassSymbol>();

/** The class of the objects a lambda converts to for a `fun interface`, whose abstract method calls the lambda. */
function samImplementation(core: Core, cls: ClassSymbol, method: FunctionSymbol): ClassSymbol {
  const existing = samImplementations.get(method);
  if (existing) return existing;
  const implementation = new ClassSymbol('class', `${cls.name}$Lambda`, `${cls.qualifiedName}$$Lambda`, undefined);
  implementation.interfaces = [cls.type];
  implementation.isLibrary = true;
  for (const [root, member] of cls.vtable) implementation.vtable.set(root, member);
  const reprs = method.params.map((param) => reprOf(core, param.type));
  const resultRepr = reprOf(core, method.returnType ?? core.unit.type);
  const call = new FunctionSymbol(method.name);
  Object.assign(call, {
    owner: implementation,
    params: method.params,
    returnType: method.returnType,
    root: method.root,
    isOverride: true,
    isLibrary: true,
  });
  call.invoke = (caller, receiver, args) => {
    const boxedArgs = args.map((arg, index) => convertRepr(() => arg, reprs[index], 'ref')(caller));
    const result = ((receiver as KObject).function as NonNullable<KObject['function']>).call(caller, boxedArgs);
    return convertRepr(() => result, 'ref', resultRepr)(caller);
  };
  implementation.vtable.set(method.root, call);
  samImplementations.set(method, implementation);
  return implementation;
}

/** A program ready to run. */
export interface CompiledProgram {
  main: FunctionSymbol;
  /** Whether `main` takes the command line's arguments. */
  mainTakesArgs: boolean;
  /** Initializes top-level properties, the library's first, in declaration order. */
  initializers: { row: number; isConstant: boolean; run: (frame: Frame) => void }[];
  globalDefaults: readonly Value[];
  /** The top-level properties of the program, which traces show by their names. */
  globals: { name: string; slot: number; type: KType; isConstant: boolean }[];
  /** The objects and companion objects of the program, whose properties traces show as `Name.property`. */
  objects: ClassSymbol[];
}

export interface CompileOptions {
  /** The rows of `// atomic` annotations. */
  atomicRows?: ReadonlySet<number>;
  /** Whether the program records the steps of its statements, for a trace. */
  recordsSteps?: boolean;
}

/** The names of functions of the standard library that read input, files, or the network, by what they need. */
const UNAVAILABLE_FUNCTIONS: Record<string, string> = {
  readln: '標準入力（readln）',
  readLine: '標準入力（readLine）',
  readlnOrNull: '標準入力（readlnOrNull）',
  thread: 'スレッド（thread）',
  runBlocking: 'コルーチン（runBlocking）',
  launch: 'コルーチン（launch）',
  async: 'コルーチン（async）',
  delay: 'コルーチン（delay）',
  sequence: 'シーケンスを作る sequence { }',
  iterator: 'イテレータを作る iterator { }',
  sequenceOf: 'シーケンス（sequenceOf）',
  generateSequence: 'シーケンス（generateSequence）',
  runCatching: '失敗を値として受け取る runCatching（Result）',
  Regex: '正規表現（Regex）',
  exitProcess: 'プログラムの終了（exitProcess）',
};

export class Compiler extends BodyCompiler {
  constructor(
    packages: Map<string, PackageScope>,
    core: Core | undefined,
    natives?: { functions: ReadonlyMap<string, NativeFunction>; properties: ReadonlyMap<string, NativeProperty> }
  ) {
    super(packages);
    if (core) this.core = core;
    if (natives) {
      this.natives = natives.functions;
      this.nativeProperties = natives.properties;
    }
  }

  setCore(core: Core): void {
    this.core = core;
  }

  /** Compiles files together: their classes first, then their signatures, then their bodies. */
  // code-gauge-allow functionNcss -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  compileFiles(
    files: { file: KotlinFile; isLibrary: boolean }[],
    afterClasses: () => void,
    afterHeaders: () => void,
    options: CompileOptions = {}
  ): { contexts: FileContext[]; initializers: CompiledProgram['initializers'] } {
    this.atomicRows = options.atomicRows ?? new Set();
    this.claimedAtomicRows.clear();
    this.recordsSteps = options.recordsSteps ?? false;
    const prepared = files.map(({ file, isLibrary }) => ({
      file,
      context: this.newFileContext(file.packageName ?? '', isLibrary),
    }));
    for (const { file, context } of prepared) {
      this.file = context;
      this.declareClasses(file, context);
    }
    afterClasses();
    for (const { file, context } of prepared) {
      this.file = context;
      this.resolveImports(file, context);
    }
    const classOrder = this.declareHeaders(prepared);
    this.checkAtomicRows();
    for (const { file, context } of prepared) {
      this.file = context;
      this.resolveImports(file, context);
    }
    this.linkClasses(classOrder);
    afterHeaders();
    this.compileBodies();
    const initializers: CompiledProgram['initializers'] = [];
    for (const entry of this.propertyEntries) {
      const { delegateGlobal } = entry;
      if (!entry.cls && delegateGlobal !== undefined && entry.initializer) {
        const evaluate = entry.initializer.eval;
        const { info } = this.initializerContext(entry);
        const isStepped = this.recordsSteps && !entry.file.isLibrary;
        const store = (inner: Frame): void => {
          inner.runtime.globals[delegateGlobal] = evaluate(inner);
        };
        initializers.push({
          row: entry.decl.row,
          isConstant: false,
          run: this.initializerRun(info, entry.decl.row, store, isStepped, entry.initializer.isCreation === true),
        });
        continue;
      }
      const { initializer } = entry.decl;
      if (entry.cls || !initializer || entry.symbol.slot === undefined) continue;
      this.file = entry.file;
      const context = this.initializerContext(entry);
      const scope = this.initializerScope(entry, context);
      const type = entry.symbol.type as KType;
      const compiled = this.inPropertyInitializer(entry, context, () =>
        this.compileExpression(scope, context, initializer, type)
      );
      const evaluate = convertRepr(
        this.expectType(compiled, type, initializer.row),
        reprOf(this.core, type),
        reprOf(this.core, type)
      );
      const { slot } = entry.symbol;
      if (compiled.constant !== undefined) entry.symbol.constantInitializer = compiled.constant;
      const isStepped = this.recordsSteps && !entry.file.isLibrary && compiled.constant === undefined;
      const store = (inner: Frame): void => {
        inner.runtime.globals[slot] = evaluate(inner);
      };
      initializers.push({
        row: entry.decl.row,
        isConstant: compiled.constant !== undefined || initializer.kind === 'null',
        run: this.initializerRun(context.info, entry.decl.row, store, isStepped, compiled.isCreation === true),
      });
    }
    return { contexts: prepared.map(({ context }) => context), initializers };
  }

  /**
   * Runs a top-level property's initializer in a frame of its own, recording its step there, as a Java static field's
   * initializer records one in its class's initializer: the step shows the property's new value.
   */
  private initializerRun(
    info: FunctionInfo,
    row: number,
    store: (frame: Frame) => void,
    isStepped: boolean,
    onlyCalls: boolean
  ): (frame: Frame) => void {
    return (frame) => {
      frame.runtime.call(info, frame, [], undefined, [], undefined, (inner) => {
        if (isStepped) inner.runtime.steps.runStatement(row, onlyCalls, () => store(inner));
        else store(inner);
        return;
      });
    };
  }

  get globals(): readonly Value[] {
    return this.globalDefaults;
  }

  setGlobalDefaults(defaults: readonly Value[]): void {
    this.globalDefaults = [...defaults];
  }

  /** The top-level properties and objects a file declares, which traces show. */
  shownDeclarations(context: FileContext): Pick<CompiledProgram, 'globals' | 'objects'> {
    const globals = this.propertyEntries
      .filter((entry) => entry.file === context && !entry.cls && entry.symbol.slot !== undefined)
      .map((entry) => ({
        name: entry.symbol.name,
        slot: entry.symbol.slot as number,
        type: entry.symbol.type as KType,
        isConstant: !entry.symbol.isVar && entry.symbol.constantInitializer !== undefined,
      }));
    const objects = this.classEntries
      .filter((entry) => entry.file === context && entry.symbol.isObject)
      .map((entry) => entry.symbol);
    return { globals, objects };
  }

  findMain(context: FileContext): FunctionSymbol | undefined {
    const candidates = this.packages.get(context.packageName)?.functions.get('main') ?? [];
    const entryPoints = candidates.filter(
      (symbol) => !symbol.isLibrary && !symbol.extensionReceiver && isNonNullClass(symbol.returnType, this.core.unit)
    );
    return (
      entryPoints.find((symbol) => symbol.visibility !== 'private' && this.isArgsParameter(symbol)) ??
      entryPoints.find((symbol) => symbol.params.length === 0)
    );
  }

  private isArgsParameter(symbol: FunctionSymbol): boolean {
    return symbol.params.length === 1 && jvmParameterDescriptor(this.core, symbol.params[0]) === '[Ljava/lang/String;';
  }

  // Implementations of the hooks the compiler's layers declare.

  protected importObjectMembers(context: FileContext, name: string, members: MemberSymbol[]): void {
    for (const member of members) {
      if (member.kind === 'function') addOnce(context.importedFunctions, name, member);
      else addOnce(context.importedProperties, name, member);
    }
  }

  protected nativeInvoker(symbol: FunctionSymbol, native: NativeFunction): NonNullable<FunctionSymbol['invoke']> {
    let nonNullParams: number[] | undefined;
    return (caller, receiver, args) => {
      nonNullParams ??= nonNullParameterIndexes(symbol);
      rejectNullArguments(caller, nonNullParams, args);
      if (!args.includes(MISSING)) return caller.runtime.checkBuiltString(caller, native(caller, receiver, args));
      // Default values may read the receiver and the earlier parameters, as `missingDelimiterValue: String = this` does.
      const info = symbol.defaultsInfo ?? ROOT_DEFAULTS_INFO;
      const frame = new Frame(caller.runtime, info, [], receiver, undefined);
      for (const [index, arg] of args.entries()) frame.locals[index] = arg;
      for (const [index, arg] of args.entries()) {
        if (arg === MISSING) frame.locals[index] = symbol.params[index].defaultValue?.(frame);
      }
      return caller.runtime.checkBuiltString(caller, native(caller, receiver, frame.locals as Value[]));
    };
  }

  protected samWrap(lambda: Compiled, sam: NonNullable<ReturnType<Compiler['samOf']>>, type: KType): Compiled {
    const implementation = samImplementation(this.core, sam.cls, sam.method);
    const evaluate = lambda.eval;
    return {
      type,
      repr: 'ref',
      eval: (frame) => {
        const fn = evaluate(frame) as KObject;
        const object = new KObject(implementation, 0);
        object.function = fn.function;
        object.env = fn.env;
        return object;
      },
    };
  }

  protected varargType(elementType: KType): KType {
    const kind = this.primitiveOf(elementType);
    if (kind) {
      const arrayClass = this.packages.get('kotlin')?.classes.get(`${kind}Array`);
      if (arrayClass) return arrayClass.type;
    }
    return { kind: 'class', cls: this.core.array, args: [{ variance: 'out', type: elementType }], nullable: false };
  }

  protected varargArrayFactory(elementType: KType): (frame: Frame, values: Value[]) => KObject {
    const arrayType = resolved(this.varargType(elementType)) as ClassType;
    const { cls } = arrayType;
    return (frame, values) => {
      frame.runtime.allocate(frame, values.length + 1);
      const array = new KObject(cls, 0);
      array.items = values;
      return array;
    };
  }

  protected superInitializer(call: ResolvedCall, callRow: number | undefined): (frame: Frame, instance: Value) => void {
    const { symbol, evaluateArgs } = call;
    return (frame, instance) => {
      const values = evaluateArgs(frame);
      (symbol.initialize as NonNullable<FunctionSymbol['initialize']>)(frame, instance, values, callRow);
    };
  }

  protected nonVirtualCall(call: ResolvedCall): (frame: Frame, receiver: Value) => Value {
    const { symbol, evaluateArgs, callRow } = call;
    return (frame, receiver) =>
      (symbol.invoke as NonNullable<FunctionSymbol['invoke']>)(frame, receiver, evaluateArgs(frame), callRow);
  }

  protected constructorCandidates(cls: ClassSymbol, row: number): Candidate[] {
    if (cls.isInterface) this.error(row, `インターフェース ${cls.name} のインスタンスは作れません。`);
    if (cls.isObject) return [];
    if (cls.kind === 'enum') this.error(row, `列挙型 ${cls.name} のインスタンスは作れません。`);
    if (cls.isAbstract) this.error(row, `abstract なクラス ${cls.name} のインスタンスは作れません。`);
    return cls.constructors.map((symbol) => ({
      symbol,
      kind: 'constructor',
      substitution: new Map(),
      receiverType: undefined,
    }));
  }

  protected compileEnumFunction(
    scope: Scope,
    context: FunctionContext,
    cls: ClassSymbol,
    name: string,
    args: ArgumentSyntax[],
    row: number
  ): Compiled {
    const instance = this.objectInstance(cls);
    if (name === 'values' || name === 'enumValues') {
      if (args.length > 0) this.error(row, 'values() には引数を書けません。');
      const arrayClass = this.core.array;
      return {
        type: { kind: 'class', cls: arrayClass, args: [{ variance: 'inv', type: cls.type }], nullable: false },
        repr: 'ref',
        eval: (frame) => {
          instance(frame);
          const values = frame.runtime.enumEntries.get(cls)?.values ?? [];
          frame.runtime.allocate(frame, values.length + 1);
          const array = new KObject(arrayClass, 0);
          array.items = [...values];
          return array;
        },
        isCall: true,
      };
    }
    if (args.length !== 1) this.error(row, 'valueOf には引数を1つ書いてください。');
    const argumentName = args[0].name;
    const parameterName = name === 'enumValueOf' ? 'name' : 'value';
    if (argumentName !== undefined && argumentName !== parameterName)
      this.error(row, `${name} に ${argumentName} という名前の引数はありません。`);
    const argument = this.compileExpression(scope, context, args[0].value, this.stringType);
    const evaluate = this.expectType(argument, this.stringType, args[0].row);
    return {
      type: cls.type,
      repr: 'ref',
      eval: (frame) => {
        // The JVM evaluates the argument of the static valueOf before it initializes the enum class.
        const entryName = evaluate(frame) as string | undefined;
        if (entryName === undefined) frame.runtime.throwError(frame, 'java.lang.NullPointerException');
        instance(frame);
        const found = frame.runtime.enumEntries
          .get(cls)
          ?.values.find((entry) => (entry.native as { name: string }).name === entryName);
        if (!found)
          return frame.runtime.throwError(
            frame,
            'java.lang.IllegalArgumentException',
            `No enum constant ${cls.kotlinName}.${entryName}`
          );
        return found;
      },
      isCall: true,
    };
  }

  protected enumEntriesClass(): ClassSymbol {
    return this.core.list;
  }

  protected enumEntriesValue(): (entries: KObject[]) => KObject {
    const listClass = this.packages.get('kotlin.collections')?.classes.get('EnumEntriesList') ?? this.core.list;
    return (entries) => {
      const list = new KObject(listClass, 0);
      list.items = entries;
      list.readOnlyCollection = true;
      return list;
    };
  }

  protected reportUnknownFunction(name: string, row: number): never {
    // An own property only, as a name such as `valueOf` would otherwise find Object.prototype's.
    if (Object.hasOwn(UNAVAILABLE_FUNCTIONS, name)) this.error(row, unavailableMessage(UNAVAILABLE_FUNCTIONS[name]));
    this.rejectUnavailableLibraryReference(name, row);
    return this.error(row, `${name} が見つかりません。`);
  }

  /** The `KProperty` a delegate's `getValue` and `setValue` receive, which tells the property's name. */
  protected propertyReference(scope: Scope, name: string, row: number): ArgumentSyntax {
    const variableName = `\0property:${name}`;
    const type: KType = { kind: 'class', cls: this.core.kProperty, args: [{ variance: 'star' }], nullable: false };
    const variable = new VariableSymbol(variableName, type, false, 0, -1, row);
    let reference: KObject | undefined;
    variable.delegateRead = () => {
      reference ??= Object.assign(new KObject(libraryClass('kotlin.reflect.PropertyReference'), 0), {
        native: { name },
      });
      return reference;
    };
    scope.variables.set(variableName, variable);
    this.flow.assigned.add(variable);
    return { row, name: undefined, value: { kind: 'name', row, name: variableName } };
  }

  protected progressionOf(type: KType): 'Int' | 'Long' | 'Char' | undefined {
    const progressions: [string, 'Int' | 'Long' | 'Char'][] = [
      ['IntProgression', 'Int'],
      ['LongProgression', 'Long'],
      ['CharProgression', 'Char'],
    ];
    for (const [name, kind] of progressions) {
      const cls = this.packages.get('kotlin.ranges')?.classes.get(name);
      if (cls && isSubtype(type, cls.type) && !resolved(type).nullable) return kind;
    }
    return undefined;
  }
}

export { TURTLE_PACKAGE, callFunction, parameterReprs, receiverRepr };
export type { Eval };

function nonNullParameterIndexes(symbol: FunctionSymbol): number[] {
  return symbol.params.flatMap(({ type }, index) => {
    const actual = resolved(type);
    return actual.kind === 'class' && !actual.nullable ? [index] : [];
  });
}

/**
 * Erased generic code, such as a Comparable's compareTo, can pass null where the library declares a non-null
 * parameter, which the JVM's library methods reject.
 */
function rejectNullArguments(caller: Frame, nonNullParams: number[], args: Value[]): void {
  for (const index of nonNullParams) {
    if (args[index] === NULL) caller.runtime.throwError(caller, 'java.lang.NullPointerException');
  }
}
