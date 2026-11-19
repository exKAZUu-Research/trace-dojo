import type { KotlinFile } from './ast';
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
import { DeclarationCompiler } from './declarationCompiler';
import { callFunction, parameterReprs, receiverRepr } from './dispatch';
import { libraryClass } from './natives/registry';
import type { NativeFunction, NativeProperty } from './nativeTypes';
import { Frame, type FunctionInfo, MISSING } from './runtime';
import { ClassSymbol, FunctionSymbol, type MemberSymbol, VariableSymbol } from './symbols';
import { isSubtype } from './typeRelations';
import { type ClassType, type KType, resolved } from './types';
import { KObject, type Value } from './values';

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

/** What the standard library's prelude provides to every program. */
export interface LibraryPackages {
  packages: Map<string, PackageScope>;
  core: Core;
  globalCount: number;
  initializers: { row: number; run: (frame: Frame) => void }[];
}

/** A program ready to run. */
export interface CompiledProgram {
  main: FunctionSymbol;
  /** Whether `main` takes the command line's arguments. */
  mainTakesArgs: boolean;
  /** Initializes top-level properties, the library's first, in declaration order. */
  initializers: { row: number; isConstant: boolean; run: (frame: Frame) => void }[];
  globalCount: number;
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
};

export class Compiler extends DeclarationCompiler {
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
  compileFiles(
    files: { file: KotlinFile; isLibrary: boolean }[],
    afterClasses: () => void,
    afterHeaders: () => void,
    options: CompileOptions = {}
  ): { contexts: FileContext[]; initializers: CompiledProgram['initializers'] } {
    this.atomicRows = options.atomicRows ?? new Set();
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
    this.declareHeaders(prepared);
    for (const { file, context } of prepared) {
      this.file = context;
      this.resolveImports(file, context);
    }
    this.linkClasses();
    afterHeaders();
    this.compileBodies();
    const initializers: CompiledProgram['initializers'] = [];
    for (const entry of this.propertyEntries) {
      const { delegateGlobal } = entry;
      if (!entry.cls && delegateGlobal !== undefined && entry.initializer) {
        const evaluate = entry.initializer.eval;
        const { info } = this.initializerContext(entry);
        const run = (frame: Frame): void => {
          frame.runtime.call(info, frame, [], undefined, [], undefined, (inner) => {
            inner.runtime.globals[delegateGlobal] = evaluate(inner);
            return;
          });
        };
        const onlyCalls = entry.initializer.isCreation === true;
        initializers.push({
          row: entry.decl.row,
          isConstant: false,
          run:
            this.recordsSteps && !entry.file.isLibrary ? this.steppedInitializer(entry.decl.row, run, onlyCalls) : run,
        });
        continue;
      }
      if (entry.cls || !entry.decl.initializer || entry.symbol.slot === undefined) continue;
      this.file = entry.file;
      const context = this.initializerContext(entry);
      const scope = this.initializerScope(entry, context);
      const type = entry.symbol.type as KType;
      const compiled = this.compileExpression(scope, context, entry.decl.initializer, type);
      const evaluate = convertRepr(
        this.expectType(compiled, type, entry.decl.initializer.row),
        reprOf(this.core, type),
        reprOf(this.core, type)
      );
      const { slot } = entry.symbol;
      if (compiled.constant !== undefined) entry.symbol.constantInitializer = compiled.constant;
      const { info } = context;
      const run = (frame: Frame): void => {
        frame.runtime.call(info, frame, [], undefined, [], undefined, (inner) => {
          inner.runtime.globals[slot] = evaluate(inner);
          return;
        });
      };
      initializers.push({
        row: entry.decl.row,
        isConstant: compiled.constant !== undefined || entry.decl.initializer.kind === 'null',
        run:
          this.recordsSteps && !entry.file.isLibrary && compiled.constant === undefined
            ? this.steppedInitializer(entry.decl.row, run, compiled.isCreation === true)
            : run,
      });
    }
    return { contexts: prepared.map(({ context }) => context), initializers };
  }

  private steppedInitializer(row: number, run: (frame: Frame) => void, onlyCalls: boolean): (frame: Frame) => void {
    return (frame) => frame.runtime.steps.runStatement(row, onlyCalls, () => run(frame));
  }

  get globals(): number {
    return this.globalCount;
  }

  setGlobalStart(start: number): void {
    this.globalCount = start;
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
    return candidates.find(
      (symbol) =>
        !symbol.isLibrary && !symbol.extensionReceiver && (symbol.params.length === 0 || this.isArgsParameter(symbol))
    );
  }

  isArgsParameter(symbol: FunctionSymbol): boolean {
    if (symbol.params.length !== 1) return false;
    const type = resolved(symbol.params[0].type);
    return type.kind === 'class' && type.cls === this.core.array && !type.nullable;
  }

  // Implementations of the hooks the compiler's layers declare.

  protected importObjectMembers(context: FileContext, owner: ClassSymbol, name: string, members: MemberSymbol[]): void {
    void owner;
    for (const member of members) {
      if (member.kind === 'function') addOnce(context.importedFunctions, name, member);
      else addOnce(context.importedProperties, name, member);
    }
    this.importedObjectOwners.set(name, owner);
  }

  /** The objects whose members a file imported, which calls of those members use as their receiver. */
  private readonly importedObjectOwners = new Map<string, ClassSymbol>();

  protected nativeInvoker(symbol: FunctionSymbol, native: NativeFunction): NonNullable<FunctionSymbol['invoke']> {
    return (caller, receiver, args) => {
      if (!args.includes(MISSING)) return native(caller, receiver, args);
      // Default values may read the receiver and the earlier parameters, as `missingDelimiterValue: String = this` does.
      const info = symbol.defaultsInfo ?? ROOT_DEFAULTS_INFO;
      const frame = new Frame(caller.runtime, info, [], receiver, undefined);
      for (const [index, arg] of args.entries()) frame.locals[index] = arg;
      for (const [index, arg] of args.entries()) {
        if (arg === MISSING) frame.locals[index] = symbol.params[index].defaultValue?.(frame);
      }
      return native(caller, receiver, frame.locals as Value[]);
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
    if (name === 'values') {
      if (args.length > 0) this.error(row, 'values() には引数を書けません。');
      const arrayClass = this.core.array;
      return {
        type: { kind: 'class', cls: arrayClass, args: [{ variance: 'inv', type: cls.type }], nullable: false },
        repr: 'ref',
        eval: (frame) => {
          instance(frame);
          const array = new KObject(arrayClass, 0);
          array.items = [...(frame.runtime.enumEntries.get(cls) ?? [])];
          return array;
        },
      };
    }
    if (args.length !== 1) this.error(row, 'valueOf には引数を1つ書いてください。');
    const argument = this.compileExpression(scope, context, args[0].value, this.stringType);
    const evaluate = this.expectType(argument, this.stringType, args[0].row);
    return {
      type: cls.type,
      repr: 'ref',
      eval: (frame) => {
        instance(frame);
        const entryName = evaluate(frame) as string;
        const found = frame.runtime.enumEntries
          .get(cls)
          ?.find((entry) => (entry.native as { name: string }).name === entryName);
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

  protected enumEntriesValue(cls: ClassSymbol): (frame: Frame, entries: KObject[]) => Value {
    void cls;
    const listClass = this.packages.get('kotlin.collections')?.classes.get('EnumEntriesList') ?? this.core.list;
    return (_frame, entries) => {
      const list = new KObject(listClass, 0);
      list.items = [...entries];
      return list;
    };
  }

  protected reportUnknownFunction(name: string, row: number): never {
    const what = UNAVAILABLE_FUNCTIONS[name];
    if (what) this.error(row, unavailableMessage(what));
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
