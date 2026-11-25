import { CompileError } from '../interpreter/diagnostics';
import { misplacedAtomicMessage, type TraceOptions } from '../interpreter/traceAnnotations';
import type {
  Argument,
  CompilationUnit,
  ConstructorDeclaration,
  Expression,
  MethodDeclaration,
  Position,
  Statement,
} from './ast';
import { AttributeBinder } from './attributeBinder';
import type { Library, TypeContext } from './binderBase';
import type { BoundBlock, BoundExpression, BoundStatement } from './bound';
import { type BindContext, lateOperandName } from './convertBinder';
import { type DeclaredType, displayMethodIn } from './declarations';
import { FlowAnalyzer } from './flow';
import { COLLECTIONS_SOURCE } from './library/collectionsSource';
import { IO_SOURCE } from './library/ioSource';
import { SYSTEM_SOURCE } from './library/systemSource';
import { TASKS_SOURCE } from './library/tasksSource';
import { TURTLE_SOURCE } from './library/turtleSource';
import { NamespaceSymbol } from './namespaces';
import { parseCSharp } from './parse';
import { FunctionScope, LocalScope } from './scopes';
import { isObjectCreation } from './statementBinder';
// code-gauge-allow-file fileNcss -- The compiler module keeps one stage of the C# interpreter together.
import { anyStatement } from './statementSearch';
import {
  arrayType,
  displayMethod,
  displayType,
  displayTypeSymbol,
  ERROR_TYPE,
  type FieldSymbol,
  type LocalSymbol,
  MethodSymbol,
  type NamedType,
  namedType,
  type ParameterSymbol,
  substitute,
  substitutionOf,
  type Type,
  typeKey,
  TypeParameterSymbol,
  TypeSymbol,
  VOID_TYPE,
} from './types';
import './library/natives';

export interface CompileOptions {
  trace?: TraceOptions;
}

export interface CompiledProgram {
  library: Library;
  /** The program's own types, including the one that holds the top-level statements. */
  types: TypeSymbol[];
  /** The method that runs first: `Main`, or the method of the top-level statements. */
  entry: MethodSymbol;
  /** Whether the entry is the method of the top-level statements, whose locals the trace shows as `Main`'s. */
  isTopLevel: boolean;
  /** Whether integral overflow throws outside `checked` and `unchecked`, as `CheckForOverflowUnderflow` makes it. */
  checkOverflow: boolean;
  /** Binds an operation on `dynamic` values to its operands' types when it runs, as the runtime binder does. */
  bindLate?: (node: LateNode, types: Type[]) => LateBinding;
}

type LateNode = Extract<BoundExpression, { kind: 'late' }>;

/** A late-bound operation bound to its operands' types: the expression to evaluate, or the runtime binder's error. */
export type LateBinding = { bound: BoundExpression; method: MethodSymbol } | { message: string };

let libraryCache: Library | undefined;

/** The library's declarations, which every compilation shares. */
export function getLibrary(): Library {
  libraryCache ??= buildLibrary();
  return libraryCache;
}

function buildLibrary(): Library {
  const root = new NamespaceSymbol('', undefined);
  const library: Library = {
    root,
    specials: new Map(),
    valueTuples: new Map(),
    typeNamed(fullName: string, arity = 0): TypeSymbol {
      // A nested type's name follows its containing type's after `+`, with the arities after backticks.
      const [outerName, ...nestedNames] = fullName.split('+');
      const parts = outerName.split('.');
      const namespace = root.resolve(parts.slice(0, -1), false);
      const [simpleName, outerArity] = parts.at(-1)?.split('`') ?? [];
      let found = namespace?.findType(simpleName, nestedNames.length > 0 ? Number(outerArity ?? 0) : arity);
      for (const nestedName of nestedNames) {
        const [name, nestedArity] = nestedName.split('`');
        found = found?.nestedTypes.find(
          (nested) => nested.name === name && nested.typeParameters.length === Number(nestedArity ?? 0)
        );
      }
      if (!found) throw new Error(`The library lacks ${fullName}\`${arity}`);
      return found;
    },
  };
  const compiler = new Compiler(library, {});
  // One unit, since the library's namespaces refer to each other's types.
  const unit = parseCSharp(
    [SYSTEM_SOURCE, COLLECTIONS_SOURCE, TASKS_SOURCE, IO_SOURCE, TURTLE_SOURCE].join('\n'),
    true
  );
  const declared = compiler.declareUnit(unit, root, true);
  compiler.bindLibraryMembers(declared);
  if (compiler.diagnostics.length > 0)
    throw new Error(
      `The library does not compile: ${compiler.diagnostics.map((diagnostic) => `${diagnostic.row + 1}: ${diagnostic.message}`).join('\n')}`
    );
  return library;
}

/** Compiles a program: parses nothing itself, but declares, binds, and checks it. */
export function compileProgram(unit: CompilationUnit, options: CompileOptions = {}): CompiledProgram {
  const compiler = new Compiler(getLibrary(), options);
  try {
    return compiler.compile(unit);
  } catch (error) {
    throw error instanceof CompileError && unit.lineMap ? unit.lineMap.remap(error) : error;
  }
}

export class Compiler extends AttributeBinder {
  /** The rows whose `// atomic` annotations a declaration claimed. */
  private readonly claimedAtomicRows = new Set<number>();
  private readonly constantsInProgress = new Set<FieldSymbol>();
  private readonly constantValues = new Map<FieldSymbol, unknown>();

  constructor(
    library: Library,
    private readonly options: CompileOptions
  ) {
    super(library);
  }

  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  compile(unit: CompilationUnit): CompiledProgram {
    let entry: MethodSymbol | undefined;
    let isTopLevel = false;
    let declared: DeclaredType[] = [];
    this.lineMap = unit.lineMap;
    this.runGuarded(() => {
      declared = this.declareUnit(unit, this.userRoot, false);
      this.checkStructLayouts(declared);
      const program = unit.statements.length > 0 ? this.declareTopLevel(unit) : undefined;
      this.collectAttributes(unit.attributes, 'assembly', undefined, this.rootContext(unit), {
        assembly: undefined,
        module: undefined,
      });
      this.definedSymbols = new Set(unit.options?.symbols);
      this.bindPendingAttributes();
      this.removeConditionalCalls(declared);
      // Roslyn binds no method bodies once the declarations have errors, so their errors would not appear.
      if (this.diagnostics.length > 0) return;
      // Roslyn reports a missing or misdeclared entry point before the errors of method bodies.
      entry = program ? program.entry : this.findMain(declared);
      for (const type of declared) this.bindTypeMembers(type);
      if (program) {
        this.bindTopLevel(program, unit);
        isTopLevel = true;
      }
      this.checkTypeArguments();
      this.checkAtomicAnnotations();
      // Binding the members adds the fields that capture primary constructors' parameters, which shift the slots of
      // the fields of derived types.
      for (const type of declared) this.assignSlots(type.symbol);
    });
    this.finishWithErrors();
    if (!entry) throw new Error('A program without an entry point compiled without errors.');
    const types = declared.map((type) => type.symbol);
    if (isTopLevel && !types.includes(entry.owner)) types.push(entry.owner);
    return {
      library: this.library,
      types,
      entry,
      isTopLevel,
      checkOverflow: unit.options?.checkOverflow ?? false,
      bindLate: (node, operandTypes) => this.bindLate(node, operandTypes),
    };
  }

  /** Reports each instance field of a struct whose type holds that struct by value (CS0523), as Roslyn does. */
  private checkStructLayouts(declared: DeclaredType[]): void {
    const budget = { remaining: MAX_LAYOUT_WORK };
    for (const { symbol } of declared) {
      if (symbol.kind !== 'struct') continue;
      for (const field of symbol.fields) {
        if (field.isStatic || field.isConst || !holdsByValue(field.type, symbol, [], budget)) continue;
        this.error(
          field.row,
          'CS0523',
          `型 '${displayType(field.type)}' の構造体メンバー '${displayTypeSymbol(symbol)}.${field.property?.name ?? field.name}' により、構造体レイアウトで循環参照が発生します`
        );
      }
    }
  }

  /** Checks the type arguments of the generic types the program names against their parameters' constraints. */
  private checkTypeArguments(): void {
    for (const { symbol, args, row } of this.constraintChecks) {
      const parameters = symbol.allTypeParameters;
      const substitution = new Map(parameters.map((parameter, index) => [parameter, args[index]]));
      for (const [index, parameter] of parameters.entries()) {
        if (!this.satisfiesConstraints(args[index], parameter, substitution, row, displayTypeSymbol(symbol))) break;
      }
    }
  }

  /** Binds the constants and default parameter values of the library, whose methods have no bodies. */
  bindLibraryMembers(declared: DeclaredType[]): void {
    this.bindPendingAttributes();
    for (const type of declared) {
      for (const field of type.symbol.fields) if (field.isConst) this.constantValueOf(field);
      for (const method of [...type.symbol.methods, ...type.symbol.constructors]) {
        for (const parameter of method.parameters)
          if (parameter.defaultSyntax) this.bindParameterDefault(parameter, parameter.type);
      }
      type.symbol.staticInitializer = this.bindFieldInitializers(type.symbol, type.context, true);
    }
  }

  /** The context of the attributes of the whole program, `[assembly: ...]`, which see its global names. */
  private readonly lateBindings = new WeakMap<LateNode, Map<string, LateBinding>>();

  /**
   * Binds a late-bound operation with its operands as hidden locals of the given types, in the context of the code
   * that wrote it, once per site and types. Its compile errors become the runtime binder's messages.
   */
  private bindLate(node: LateNode, types: Type[]): LateBinding {
    let bySite = this.lateBindings.get(node);
    if (!bySite) {
      bySite = new Map();
      this.lateBindings.set(node, bySite);
    }
    const key = types.map((type) => displayType(type, true)).join('|');
    let binding = bySite.get(key);
    if (!binding) {
      binding = this.bindLateOnce(node, types);
      bySite.set(key, binding);
    }
    return binding;
  }

  private bindLateOnce(node: LateNode, types: Type[]): LateBinding {
    const typeContext = node.typeContext ?? {
      namespace: [this.userRoot, this.library.root],
      usings: [],
      type: undefined,
      methodTypeParameters: [],
    };
    const method = new MethodSymbol('<dynamic>', typeContext.type ?? this.objectType.symbol, 'method');
    method.isStatic = true;
    const fn = new FunctionScope(method, undefined, typeContext, VOID_TYPE, true, undefined, 'initializer');
    const context: BindContext = { scope: new LocalScope(undefined, fn), fn };
    const saved = this.diagnostics.length;
    this.lastInconvertibleMethod = undefined;
    // The runtime binder does not look for extension methods.
    this.isLateBinding = true;
    try {
      for (const [index, type] of types.entries())
        this.declareLocal(lateOperandName(index), type, node.syntax, context).isHidden = true;
      let bound = this.bindValue(node.syntax, context);
      if (node.target)
        bound = this.convert(bound, node.target.type, node.syntax, node.target.isExplicit ? 'explicit' : 'implicit');
      else if (bound.type.kind !== 'void' && bound.type.kind !== 'error')
        bound = this.convert(bound, this.dynamicType, node.syntax);
      const diagnostic = this.diagnostics[saved];
      if (diagnostic) return { message: this.runtimeBinderMessage(diagnostic.message) };
      return { bound, method };
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      return { message: this.runtimeBinderMessage(error.diagnostics.at(-1)?.message ?? '') };
    } finally {
      this.diagnostics.length = saved;
      this.isLateBinding = false;
    }
  }

  /** The runtime binder's message for the compile error that binding an operation to its runtime types gave. */
  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  private runtimeBinderMessage(text: string): string {
    const code = /^(CS\d+): /.exec(text)?.[1];
    const quoted = [...text.matchAll(/'([^']*)'/g)].map((match) => match[1]);
    switch (code) {
      case 'CS1061':
      case 'CS0117': {
        return `'${quoted[0]}' does not contain a definition for '${quoted[1]}'`;
      }
      case 'CS0122': {
        return `'${quoted[0]}' is inaccessible due to its protection level`;
      }
      case 'CS1501': {
        const count = /引数 (\d+) /.exec(text)?.[1];
        return `No overload for method '${quoted[0]}' takes ${count} arguments`;
      }
      case 'CS0121': {
        const [first, second] = this.lastAmbiguity ?? [];
        return `The call is ambiguous between the following methods or properties: '${first}' and '${second}'`;
      }
      case 'CS1503': {
        return `The best overloaded method match for '${this.lastInconvertibleMethod ?? ''}' has some invalid arguments`;
      }
      case 'CS0019': {
        return `Operator '${quoted[0]}' cannot be applied to operands of type '${quoted[1]}' and '${quoted[2]}'`;
      }
      case 'CS0023': {
        return `Operator '${quoted[0]}' cannot be applied to operand of type '${quoted[1]}'`;
      }
      case 'CS0029': {
        return `Cannot implicitly convert type '${quoted[0]}' to '${quoted[1]}'`;
      }
      case 'CS0266': {
        return `Cannot implicitly convert type '${quoted[0]}' to '${quoted[1]}'. An explicit conversion exists (are you missing a cast?)`;
      }
      case 'CS0030': {
        return `Cannot convert type '${quoted[0]}' to '${quoted[1]}'`;
      }
      case 'CS0021': {
        return `Cannot apply indexing with [] to an expression of type '${quoted[0]}'`;
      }
      case 'CS0200': {
        return `Property or indexer '${quoted[0]}' cannot be assigned to -- it is read only`;
      }
      default: {
        return text.replace(/^CS\d+: /, '');
      }
    }
  }

  private rootContext(unit: CompilationUnit): TypeContext {
    const context: TypeContext = {
      namespace: [this.userRoot, this.library.root],
      usings: [],
      type: undefined,
      methodTypeParameters: [],
    };
    this.importInto(context, [], unit.usings);
    return context;
  }

  /** Removes the calls of `[Conditional]` methods none of whose symbols the program defines (C# spec §23.5.3). */
  private removeConditionalCalls(declared: DeclaredType[]): void {
    for (const { symbol } of declared)
      for (const method of symbol.methods)
        if (method.conditionalSymbols && method.returnType.kind === 'void')
          method.callsAreRemoved = !method.conditionalSymbols.some((name) => this.definedSymbols.has(name));
  }

  // ---- Top-level statements ----

  private declareTopLevel(unit: CompilationUnit): { entry: MethodSymbol; type: TypeSymbol } {
    // The top-level statements join a partial class Program that the program declares, as Roslyn's generated one does.
    const existing = this.userRoot.findType('Program', 0);
    if (existing && !existing.declaration?.modifiers.set.has('partial'))
      this.error(existing.row, 'CS0260', "partial 修飾子が型 'Program' にありません。この型の別の部分宣言が存在します");
    const type = existing ?? new TypeSymbol('Program', 'class', '', undefined);
    if (!existing) {
      type.baseType = this.objectType;
      type.access = 'internal';
      this.userRoot.addType(type);
    }
    const returnsValue = containsValueReturn(unit.statements);
    const entry = new MethodSymbol('<Main>$', type, 'method');
    entry.isStatic = true;
    entry.access = 'private';
    entry.returnType = returnsValue ? this.intType : VOID_TYPE;
    // Top-level statements with `await` make an async entry point, returning Task or Task<int>.
    if (unit.statements.some(containsAwait)) {
      entry.isAsync = true;
      const task = this.library.typeNamed('System.Threading.Tasks.Task', returnsValue ? 1 : 0);
      entry.returnType = returnsValue ? namedType(task, [this.intType]) : namedType(task);
    }
    entry.parameters = [{ name: 'args', type: arrayType(this.stringType), refKind: undefined, isParams: false }];
    entry.row = unit.statements[0].row;
    type.methods.push(entry);
    return { entry, type };
  }

  private bindTopLevel(program: { entry: MethodSymbol; type: TypeSymbol }, unit: CompilationUnit): void {
    const typeContext: TypeContext = {
      namespace: [this.userRoot, this.library.root],
      usings: [],
      type: program.type,
      methodTypeParameters: [],
    };
    this.importInto(typeContext, [], unit.usings);
    const block = {
      kind: 'block' as const,
      statements: unit.statements,
      endRow: unit.statements.at(-1)?.row ?? 0,
      row: unit.statements[0].row,
      column: 0,
    };
    this.bindMethod(program.entry, typeContext, block, undefined);
  }

  /** Finds the static `Main` method that the program starts from. */
  private findMain(declared: DeclaredType[]): MethodSymbol | undefined {
    // A method of a generic type, or of a type nested in one, is no entry point.
    const mains = declared.flatMap((type) =>
      type.symbol.allTypeParameters.length > 0
        ? []
        : type.symbol.methods.filter(
            (method) =>
              method.name === 'Main' &&
              method.isStatic &&
              method.typeParameters.length === 0 &&
              this.hasEntryParameters(method)
          )
    );
    const shaped = mains.map((method) => ({ method, returns: this.entryReturnKind(method) }));
    for (const { method, returns } of shaped)
      if (method.isAsync && returns === 'plain')
        this.error(method.row, 'CS4009', 'エントリ ポイントを返す void または int を async にすることはできません');
    // Roslyn prefers a `Main` returning void or int to one returning a task, warning about the latter (CS8892).
    const plain = shaped.filter(({ method, returns }) => returns === 'plain' && !method.isAsync);
    const candidates = (plain.length > 0 ? plain : shaped.filter(({ returns }) => returns === 'task')).map(
      ({ method }) => method
    );
    if (candidates.length > 1) {
      this.error(
        candidates[0].row,
        'CS0017',
        `プログラムで複数のエントリ ポイントが定義されています。エントリ ポイントを含む型を指定するには、/main でコンパイルしてください。`
      );
      return undefined;
    }
    // Roslyn reports this error without a location, which the first row stands for.
    if (candidates.length === 0)
      this.error(0, 'CS5001', "プログラムは、エントリ ポイントに適切な静的 'Main' メソッドを含んでいません");
    return candidates[0];
  }

  /** Whether an entry point returns void or int (`plain`), `Task` or `Task<int>` (`task`), or anything else. */
  private entryReturnKind(method: MethodSymbol): 'plain' | 'task' | undefined {
    const { returnType } = method;
    if (returnType.kind === 'void') return 'plain';
    if (returnType.kind !== 'named') return undefined;
    if (returnType.symbol.special === 'int') return 'plain';
    if (returnType.symbol === this.library.typeNamed('System.Threading.Tasks.Task', 0)) return 'task';
    const [result] = returnType.args;
    return returnType.symbol === this.library.typeNamed('System.Threading.Tasks.Task', 1) &&
      result.kind === 'named' &&
      result.symbol.special === 'int'
      ? 'task'
      : undefined;
  }

  private hasEntryParameters(method: MethodSymbol): boolean {
    if (method.parameters.length === 0) return true;
    const [parameter] = method.parameters;
    return (
      method.parameters.length === 1 &&
      parameter.type.kind === 'array' &&
      parameter.type.element.kind === 'named' &&
      parameter.type.element.symbol.special === 'string' &&
      !parameter.refKind
    );
  }

  // ---- Members ----

  private bindTypeMembers(type: DeclaredType): void {
    const { symbol, context } = type;
    if (symbol.kind === 'enum') {
      for (const field of symbol.fields) this.constantValueOf(field);
      return;
    }
    for (const field of symbol.fields) if (field.isConst) this.constantValueOf(field);
    const parameters = [...symbol.methods, ...symbol.constructors, ...symbol.properties].flatMap(
      (owner) => owner.parameters
    );
    for (const parameter of parameters)
      if (parameter.defaultSyntax) this.bindParameterDefault(parameter, parameter.type);
    symbol.instanceInitializer = this.bindFieldInitializers(symbol, context, false);
    symbol.staticInitializer = this.bindFieldInitializers(symbol, context, true);
    this.bindMethodsAndAccessors(symbol, context);
    for (const constructor of symbol.constructors) this.bindConstructor(constructor, type);
    if (symbol.staticConstructor) this.bindConstructor(symbol.staticConstructor, type);
  }

  /** Binds the methods and property accessors of a type in the order the program declares them, as Roslyn does. */
  private bindMethodsAndAccessors(symbol: TypeSymbol, context: TypeContext): void {
    const accessors = symbol.properties
      .flatMap((property) => [property.getter, property.setter])
      .filter((accessor) => accessor?.declaration !== undefined) as MethodSymbol[];
    for (const method of [...symbol.methods, ...accessors].toSorted((a, b) => a.row - b.row)) {
      if (method.kind === 'getter' || method.kind === 'setter') {
        const body = (method.declaration as unknown as { body: MethodDeclaration['body'] }).body;
        this.bindMethod(method, context, body, undefined);
      } else {
        this.bindDeclaredMethod(method, context);
      }
    }
  }

  private bindDeclaredMethod(method: MethodSymbol, context: TypeContext): void {
    const declaration = method.declaration;
    if (method.native || !declaration || method.kind === 'delegateInvoke') return;
    const body = (declaration as MethodDeclaration).body;
    if (body === undefined) return;
    this.bindMethod(method, this.methodContexts.get(method) ?? context, body, declaration as MethodDeclaration);
  }

  /** Binds the initializers of a type's fields, which run as one block before a constructor's body. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  private bindFieldInitializers(symbol: TypeSymbol, context: TypeContext, isStatic: boolean): BoundBlock | undefined {
    const fields = symbol.fields.filter(
      (field) => field.isStatic === isStatic && !field.isConst && field.initializer !== undefined
    );
    if (fields.length === 0) return undefined;
    const method = new MethodSymbol(isStatic ? '<static initializer>' : '<initializer>', symbol, 'method');
    method.isStatic = isStatic;
    const fn = new FunctionScope(
      method,
      undefined,
      context,
      VOID_TYPE,
      isStatic,
      isStatic ? undefined : symbol.declaredType,
      'initializer'
    );
    const scope = new LocalScope(undefined, fn);
    const bindContext: BindContext = { scope, fn };
    if (!isStatic && symbol.primaryParameters) {
      for (const parameter of symbol.primaryParameters) this.declareParameter(parameter, bindContext);
    }
    const statements: BoundStatement[] = [];
    for (const field of fields) {
      this.callerMember = field.property?.name ?? field.name;
      const initializer = field.initializer as NonNullable<FieldSymbol['initializer']>;
      const value =
        initializer.kind === 'arrayInitializer'
          ? this.bindArrayInitializer(initializer, field.type, bindContext)
          : this.bindAs(initializer as Expression, field.type, bindContext);
      const target: BoundExpression = isStatic
        ? { kind: 'staticField', field, owner: symbol.declaredType, type: field.type, row: field.row }
        : {
            kind: 'field',
            receiver: { kind: 'this', type: symbol.declaredType, row: field.row },
            field,
            type: field.type,
            row: field.row,
          };
      const isConstantStatic = isStatic && value.kind === 'constant';
      if (isConstantStatic) (field as { initialConstant?: unknown }).initialConstant = value.value;
      const step = isConstantStatic || symbol.isLibrary ? 'none' : isObjectCreation(value) ? 'callsOnly' : 'step';
      statements.push({
        kind: 'expression',
        expression: { kind: 'assign', target: target as never, value, type: field.type, row: field.row },
        row: field.row,
        step,
      });
    }
    const block: BoundBlock = {
      kind: 'block',
      statements,
      capturedLocals: [],
      locals: scope.locals,
      row: symbol.row,
      step: 'none',
    };
    method.body = block;
    this.finishFunction(method, fn);
    if (isStatic) symbol.staticInitializerLocals = method.locals;
    else symbol.initializerLocals = method.locals;
    return block;
  }

  private bindConstructor(constructor: MethodSymbol, type: DeclaredType): void {
    const { symbol, context } = type;
    const declaration = constructor.declaration as ConstructorDeclaration | undefined;
    if (constructor.native) return;
    this.callerMember = constructor.name;
    const fn = new FunctionScope(
      constructor,
      undefined,
      context,
      VOID_TYPE,
      constructor.isStatic,
      constructor.isStatic ? undefined : symbol.declaredType,
      'member'
    );
    const scope = new LocalScope(undefined, fn);
    const bindContext: BindContext = { scope, fn };
    for (const parameter of constructor.parameters) this.declareParameter(parameter, bindContext);
    if (!constructor.isStatic)
      constructor.constructorInitializer = this.bindConstructorInitializer(constructor, declaration, type, bindContext);
    constructor.body = declaration?.body
      ? this.bindMethodBody(declaration.body, bindContext, VOID_TYPE)
      : {
          kind: 'block',
          statements: this.primaryCaptures(constructor, symbol, bindContext),
          capturedLocals: [],
          locals: [],
          row: symbol.row,
          step: 'none',
        };
    this.claimAtomic(constructor, declaration?.startRow ?? declaration?.row, declaration?.bodyRow);
    this.finishFunction(constructor, fn);
  }

  /** A primary constructor stores the parameters that members read in the fields that capture them. */
  private primaryCaptures(constructor: MethodSymbol, symbol: TypeSymbol, context: BindContext): BoundStatement[] {
    if (constructor.parameters !== symbol.primaryParameters) return [];
    const statements: BoundStatement[] = [];
    for (const field of symbol.fields) {
      if (!field.isPrimaryParameter || field.property) continue;
      const name = field.name.slice(1, -2);
      const local = context.scope.variables.get(name);
      if (!local) continue;
      const target: BoundExpression = {
        kind: 'field',
        receiver: { kind: 'this', type: symbol.declaredType, row: symbol.row },
        field,
        type: field.type,
        row: symbol.row,
      };
      statements.push({
        kind: 'expression',
        expression: {
          kind: 'assign',
          target: target as never,
          value: { kind: 'local', local, type: local.type, row: symbol.row },
          type: field.type,
          row: symbol.row,
        },
        row: symbol.row,
        step: 'none',
      });
    }
    return statements;
  }

  /** Binds `: base(...)` or `: this(...)`, or the implicit call of the base class's parameterless constructor. */
  private bindConstructorInitializer(
    constructor: MethodSymbol,
    declaration: ConstructorDeclaration | undefined,
    type: DeclaredType,
    context: BindContext
  ): BoundExpression | undefined {
    const { symbol } = type;
    if (symbol.kind === 'struct') {
      if (declaration?.initializer?.kind === 'this')
        return this.bindChainedConstructor(
          symbol.declaredType,
          declaration.initializer.args,
          declaration.initializer,
          context,
          true
        );
      if (declaration?.initializer?.kind === 'base')
        this.error(
          declaration.initializer,
          'CS0522',
          `'${displayTypeSymbol(symbol)}': 構造体は、基底クラスのコンストラクターを呼び出すことができません`
        );
      return undefined;
    }
    const baseType = symbol.baseType;
    if (declaration?.initializer?.kind === 'this')
      return this.bindChainedConstructor(
        symbol.declaredType,
        declaration.initializer.args,
        declaration.initializer,
        context,
        true
      );
    if (!baseType) return undefined;
    const isPrimary =
      !declaration && symbol.primaryParameters !== undefined && constructor.parameters === symbol.primaryParameters;
    const args = declaration?.initializer?.args ?? (isPrimary ? (symbol.declaration?.baseArguments ?? []) : []);
    const position = declaration?.initializer ?? declaration ?? { row: symbol.row, column: 0 };
    const call = this.bindChainedConstructor(baseType, args, position, context, false);
    if (call?.kind === 'call' && !declaration?.initializer && !isPrimary) call.isImplicit = true;
    return call;
  }

  private bindChainedConstructor(
    type: NamedType,
    args: Argument[],
    position: Position,
    context: BindContext,
    isThis: boolean
  ): BoundExpression | undefined {
    const bound = this.bindArguments(args, context);
    const candidates = type.symbol.constructors
      .filter((candidate) => this.isAccessible(candidate.access, type.symbol, context.fn.typeContext))
      .map((method) => ({ method, owner: type }));
    if (candidates.length === 0 && type.symbol.constructors.length > 0) {
      this.error(
        position,
        'CS0122',
        `'${displayMethod(type.symbol.constructors[0])}' はアクセスできない保護レベルになっています`
      );
      return undefined;
    }
    const resolved = this.resolveCall(candidates, bound, undefined, position.row, {
      name: type.symbol.name,
      kind: 'constructor',
      typeName: displayType(type),
    });
    if (!resolved) return undefined;
    if (isThis && resolved.candidate.method === context.fn.method) {
      this.error(
        position,
        'CS0516',
        `コンストラクター '${displayMethod(context.fn.method)}' で、それ自体を呼び出すことはできません:`
      );
    }
    return {
      kind: 'call',
      method: resolved.candidate.method,
      receiver: { kind: 'this', type, row: position.row },
      args: resolved.args,
      typeArgs: [],
      owner: type,
      isVirtual: false,
      type: VOID_TYPE,
      row: position.row,
      isThisInitializer: isThis,
    };
  }

  /** Binds a method's body with its parameters in scope, then checks its flow. */
  private bindMethod(
    method: MethodSymbol,
    typeContext: TypeContext,
    body: MethodDeclaration['body'],
    declaration: MethodDeclaration | undefined
  ): void {
    this.callerMember =
      method.property?.name ?? (method.isEventAccessor ? method.name.replace(/^(add|remove)_/, '') : method.name);
    const thisType = method.isStatic ? undefined : method.owner.declaredType;
    const fn = new FunctionScope(
      method,
      undefined,
      typeContext,
      method.returnType,
      method.isStatic,
      thisType,
      'member'
    );
    const scope = new LocalScope(undefined, fn);
    const context: BindContext = { scope, fn };
    for (const parameter of method.parameters) this.declareParameter(parameter, context);
    method.body = this.bindMethodBody(body, context, method.returnType);
    if (declaration) this.claimAtomic(method, declaration.startRow, declaration.bodyRow);
    this.finishFunction(method, fn);
  }

  /** Marks a method atomic when a model program's `// atomic` annotation is on one of its header's rows. */
  private claimAtomic(method: MethodSymbol, startRow: number | undefined, bodyRow: number | undefined): void {
    const annotations = this.options.trace?.atomicAnnotations;
    if (!annotations || startRow === undefined || bodyRow === undefined) return;
    for (let row = startRow; row <= bodyRow; row++) {
      if (annotations.has(row)) {
        method.isAtomic = true;
        this.claimedAtomicRows.add(row);
      }
    }
  }

  private checkAtomicAnnotations(): void {
    const annotations = this.options.trace?.atomicAnnotations;
    if (!annotations) return;
    for (const row of annotations.keys()) {
      if (!this.claimedAtomicRows.has(row)) this.diagnostics.push({ row, message: misplacedAtomicMessage });
    }
  }

  protected finishFunction(method: MethodSymbol, fn: FunctionScope): void {
    if (method.kind === 'localFunction' && method.declaration) {
      const declaration = method.declaration as MethodDeclaration;
      this.claimAtomic(method, declaration.startRow, declaration.bodyRow);
    }
    const body = method.body;
    if (!body) return;
    if (fn.kind === 'localFunction') {
      // A local function's flow is analyzed once its member's functions are all bound, as its calls need their
      // callees' captures and what those assign.
      this.pendingLocalFunctions.push({ method, isTrial: this.trialLambdaDepth > 0 });
      return;
    }
    if (fn.kind === 'lambda') {
      markCapturedLocals(body);
      return;
    }
    this.flushRefSafetyDiagnostics();
    this.summarizeLocalFunctions();
    this.analyzeFlow(method, body);
  }

  /**
   * The one computation of what each local function of the member tells its callers, once all are bound: the locals it
   * captures, followed through the local functions it calls, and those it definitely assigns when it returns (or that
   * it cannot return). Callees come before callers, and recursive ones are analyzed again until nothing changes, after
   * which each is analyzed once more to report its own diagnostics.
   */
  private summarizeLocalFunctions(): void {
    const callees = this.propagateLocalFunctionCaptures();
    const trials = new Set(this.pendingLocalFunctions.filter((entry) => entry.isTrial).map((entry) => entry.method));
    const order = calleesFirst(
      this.pendingLocalFunctions.map((entry) => entry.method),
      callees
    );
    this.pendingLocalFunctions.length = 0;
    // The passes start from the optimistic 'assigns all' and can only take assignments away, so they end within one
    // per function.
    for (let pass = 0; pass <= order.length; pass++) {
      let isChanged = false;
      for (const local of order) {
        const before = summaryOf(local);
        const saved = this.diagnostics.length;
        this.analyzeFlow(local, local.body as BoundBlock);
        this.diagnostics.length = saved;
        if (summaryOf(local) !== before) isChanged = true;
      }
      if (!isChanged) break;
    }
    // A local function of a lambda binding that only tried a delegate type keeps its summary but reports nothing,
    // as that binding's own diagnostics were thrown away.
    for (const local of order) {
      const saved = this.diagnostics.length;
      this.analyzeFlow(local, local.body as BoundBlock);
      if (trials.has(local)) this.diagnostics.length = saved;
    }
  }

  private readonly pendingLocalFunctions: { method: MethodSymbol; isTrial: boolean }[] = [];

  /** Checks a function's definite assignment and reachability, recording for a local function what it assigns. */
  // code-gauge-allow functionCognitiveComplexity -- One callback per kind of flow diagnostic, each reporting its own message.
  private analyzeFlow(method: MethodSymbol, body: BoundBlock): void {
    markCapturedLocals(body);
    const readsBeforeAssigned: LocalSymbol[] = [];
    const analyzer = new FlowAnalyzer({
      unassigned: (local, row) => {
        // A local function's read of a captured local is checked where it is called instead, as Roslyn does.
        if (method.kind === 'localFunction' && local.owner !== method) {
          if (!readsBeforeAssigned.includes(local)) readsBeforeAssigned.push(local);
          return;
        }
        if (local.isParameter && local.refKind === 'out')
          this.error(row, 'CS0269', `未割り当ての out パラメーター '${local.name}' が使用されました`);
        else this.error(row, 'CS0165', `未割り当てのローカル変数 '${local.name}' が使用されました`);
      },
      unassignedField: (field, row) =>
        this.error(
          row,
          'CS0170',
          `フィールド '${field.property?.name ?? field.name}' は、割り当てられていない可能性があります`
        ),
      notAllPathsReturn: (row) =>
        this.error(row, 'CS0161', `'${this.methodDisplay(method)}': 値を返さないコード パスがあります`),
      lambdaNotAllPathsReturn: (delegateType, row) =>
        this.error(row, 'CS1643', `型 '${displayType(delegateType)}' の ラムダ式 に値を返さないコード パスがあります`),
      fallsThrough: (label, isLast, row) => {
        if (isLast)
          this.error(row, 'CS8070', `コントロールは switch の最後の case ラベル ('${label}') から出ることができません`);
        else
          this.error(
            row,
            'CS0163',
            `コントロールはひとつの case ラベル ('${label}') から別のラベルへ流れ落ちることはできません`
          );
      },
      outNotAssigned: (local, row) =>
        this.error(
          row,
          'CS0177',
          `out パラメーター '${local.name}' はコントロールが現在のメソッドを抜ける前に割り当てられる必要があります`
        ),
      heldAcrossSuspension: (local, row) =>
        this.error(
          row,
          'CS4007',
          `'${displayType(local.type, true)}' 型のインスタンスは、'await' または 'yield' 境界を越えて保持することはできません。`
        ),
    });
    const parameters = method.locals.filter((local) => local.isParameter && local.owner === method);
    // An iterator ends by falling off its body, which returns no value, and an async function returns what its task
    // type wraps.
    const returnType = method.async ? method.async.resultType : method.returnType;
    const returnsValue = returnType.kind !== 'void' && returnType.kind !== 'error' && !method.iterator;
    const assignedAtExit = analyzer.analyzeFunction(method, body, parameters, returnsValue, body.row);
    if (method.kind === 'localFunction') {
      method.assignedAtExit = assignedAtExit;
      method.readsBeforeAssigned = readsBeforeAssigned;
    }
  }

  protected methodDisplay(method: MethodSymbol): string {
    if (method.name === '<Main>$') return 'Program.<Main>$(string[])';
    if (method.kind === 'localFunction') return displayMethod(method);
    return displayMethodIn(method, method.owner.declaredType);
  }

  protected typeParameterClass(): typeof TypeParameterSymbol {
    return TypeParameterSymbol;
  }

  // ---- Constants ----

  protected constantValueOf(field: FieldSymbol): unknown {
    if (this.constantValues.has(field)) return this.constantValues.get(field);
    if (this.constantsInProgress.has(field)) {
      this.error(
        field.row,
        'CS0110',
        `'${displayTypeSymbol(field.owner)}.${field.name}' の定数値の評価により、循環定義が発生します`
      );
      return 0;
    }
    this.constantsInProgress.add(field);
    try {
      const value = this.evaluateConstant(field);
      this.constantValues.set(field, value);
      field.constantValue = value;
      return value;
    } finally {
      this.constantsInProgress.delete(field);
    }
  }

  private evaluateConstant(field: FieldSymbol): unknown {
    const owner = field.owner;
    const declared = this.declaredTypes.find((type) => type.symbol === owner);
    const context = declared?.context ?? {
      namespace: [this.library.root],
      usings: [],
      type: owner,
      methodTypeParameters: [],
    };
    const method = new MethodSymbol('<constant>', owner, 'method');
    method.isStatic = true;
    const fn = new FunctionScope(method, undefined, context, VOID_TYPE, true, undefined, 'initializer');
    const bindContext: BindContext = { scope: new LocalScope(undefined, fn), fn };
    if (owner.kind === 'enum') return this.enumMemberValue(field, bindContext);
    // The parser rejects a constant without a value.
    if (!field.initializer) return 0;
    const value = this.bindAs(field.initializer as Expression, field.type, bindContext);
    if (value.kind !== 'constant') {
      if (value.type.kind !== 'error')
        this.error(
          field.row,
          'CS0133',
          `'${displayTypeSymbol(owner)}.${field.name}' に割り当てられた式は定数でなければなりません`
        );
      return 0;
    }
    return value.value;
  }

  /** An enum member's value: its constant expression, or one more than the member before it. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private enumMemberValue(field: FieldSymbol, context: BindContext): unknown {
    const owner = field.owner;
    const underlying = owner.enumUnderlying as NamedType;
    const isBig = underlying.symbol.special === 'long' || underlying.symbol.special === 'ulong';
    if (field.initializer) {
      // The member's value may combine other members of its enum, as `All = Read | Write`, which is a constant of it.
      const asEnum = this.quietly(() => this.bindValue(field.initializer as Expression, context));
      if (asEnum?.kind === 'constant' && asEnum.type.kind === 'named' && asEnum.type.symbol === owner)
        return asEnum.value;
      const value = this.bindAs(field.initializer as Expression, underlying, context);
      if (value.kind !== 'constant') {
        if (value.type.kind !== 'error')
          this.error(
            field.row,
            'CS0133',
            `'${displayTypeSymbol(owner)}.${field.name}' に割り当てられた式は定数でなければなりません`
          );
        return isBig ? 0n : 0;
      }
      return value.value;
    }
    const index = owner.fields.indexOf(field);
    if (index === 0) return isBig ? 0n : 0;
    const previous = this.constantValueOf(owner.fields[index - 1]);
    return typeof previous === 'bigint' ? previous + 1n : (previous as number) + 1;
  }

  protected bindParameterDefault(parameter: ParameterSymbol, type: Type): BoundExpression {
    if (parameter.defaultValue)
      return { kind: 'constant', value: parameter.defaultValue.value, type, row: parameter.position?.row ?? 0 };
    const syntax = parameter.defaultSyntax as Expression;
    const method = new MethodSymbol('<default>', this.objectType.symbol, 'method');
    method.isStatic = true;
    const fn = new FunctionScope(
      method,
      undefined,
      parameter.defaultContext ?? {
        namespace: [this.userRoot, this.library.root],
        usings: this.globalImports([]).usings,
        type: undefined,
        methodTypeParameters: [],
      },
      VOID_TYPE,
      true,
      undefined,
      'initializer'
    );
    const context: BindContext = { scope: new LocalScope(undefined, fn), fn };
    const bound = this.bindAs(syntax, type, context);
    if (bound.kind === 'constant') {
      parameter.defaultValue = { value: bound.value };
      return bound;
    }
    if (
      bound.kind === 'default' ||
      (bound.kind === 'new' && bound.args.length === 0 && type.kind === 'named' && type.symbol.isValueType)
    ) {
      parameter.defaultValue = { value: undefined };
      return bound;
    }
    if (bound.type.kind !== 'error')
      this.error(
        syntax,
        'CS1736',
        `'${parameter.name}' の既定のパラメーター値は、コンパイル時の定数である必要があります`
      );
    parameter.defaultValue = { value: undefined };
    return { kind: 'default', type: ERROR_TYPE, row: syntax.row };
  }
}

/** Whether top-level statements return a value, which makes the entry point return `int`. */
/** Whether syntax holds an `await` of its own function, outside the lambdas and local functions in it. */
function containsAwait(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  if (Array.isArray(node)) return node.some(containsAwait);
  const record = node as { kind?: string; isAwait?: boolean; using?: string };
  if (record.kind === 'lambda' || record.kind === 'localFunction') return false;
  if (record.kind === 'await' || record.isAwait === true || record.using === 'await using') return true;
  return Object.values(record).some(containsAwait);
}

function containsValueReturn(statements: Statement[]): boolean {
  return statements.some((statement) =>
    anyStatement(statement, (inner) => inner.kind === 'return' && inner.value !== undefined)
  );
}

/** Lists in each scope the locals that lambdas or local functions capture, which then live in fresh cells. */
// code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
function markCapturedLocals(block: BoundBlock): void {
  const visit = (statement: BoundStatement): void => {
    switch (statement.kind) {
      case 'block': {
        statement.capturedLocals = statement.locals.filter((local) => local.isCaptured);
        for (const inner of statement.statements) visit(inner);
        break;
      }
      case 'if': {
        visit(statement.consequence);
        if (statement.alternative) visit(statement.alternative);
        break;
      }
      case 'while':
      case 'do':
      case 'lock':
      case 'using': {
        visit(statement.body);
        break;
      }
      case 'labeled': {
        visit(statement.statement);
        break;
      }
      case 'for': {
        statement.capturedLocals = statement.locals.filter((local) => local.isCaptured);
        for (const initializer of statement.initializers) visit(initializer);
        visit(statement.body);
        break;
      }
      case 'foreach': {
        visit(statement.body);
        break;
      }
      case 'switch': {
        for (const section of statement.sections) for (const inner of section.statements) visit(inner);
        break;
      }
      case 'try': {
        visit(statement.body);
        for (const clause of statement.catches) visit(clause.body);
        if (statement.finally) visit(statement.finally);
        break;
      }
      default: {
        break;
      }
    }
  };
  visit(block);
}

export type { LocalSymbol };
export { substitute, substitutionOf };

/** What a local function's summary says it assigns, as a string that changes exactly when the summary does. */
function summaryOf(local: MethodSymbol): string {
  const assigned = local.assignedAtExit;
  if (assigned === undefined || assigned === 'never') return String(assigned);
  return local.captures.map((captured) => (assigned(captured) ? '1' : '0')).join('');
}

/** The local functions, each after the ones it calls except where they call each other recursively. */
function calleesFirst(locals: MethodSymbol[], callees: Map<MethodSymbol, MethodSymbol[]>): MethodSymbol[] {
  const pending = new Set(locals);
  const order: MethodSymbol[] = [];
  const visit = (local: MethodSymbol): void => {
    if (!pending.delete(local)) return;
    for (const callee of callees.get(local) ?? []) visit(callee);
    order.push(local);
  };
  for (const local of pending) visit(local);
  return order;
}

/**
 * Whether a value of the type holds a struct by value, through its instance fields and theirs. The path holds the
 * constructed types being expanded, so a construction repeated on it ends that path, and a generic struct constructed
 * again and again on one path counts as the cycle that a layout growing without end is, as Roslyn reports it; the
 * results of finished constructions are kept, so shared layouts are expanded once.
 */
function holdsByValue(
  type: Type,
  target: TypeSymbol,
  path: { key: string; symbol: TypeSymbol }[],
  budget: { remaining: number },
  finished = new Map<string, boolean>()
): boolean {
  if (type.kind !== 'named' || type.symbol.kind !== 'struct') return false;
  if (type.symbol === target) return true;
  const key = typeKey(type);
  const known = finished.get(key);
  if (known !== undefined) return known;
  // Constructions that wrap type arguments differently on every path share no results, so the whole compilation's
  // check stops after bounded work, which grows with the constructions' sizes, taking the remaining layouts as free of
  // cycles; one it misses ends at run time as a stack overflow.
  budget.remaining -= key.length;
  if (budget.remaining < 0) return false;
  if (path.some((entry) => entry.key === key)) return false;
  if (path.filter((entry) => entry.symbol === type.symbol).length >= MAX_GENERIC_NESTING) return true;
  const substitution = substitutionOf(type);
  const inner = [...path, { key, symbol: type.symbol }];
  const holds = type.symbol.fields.some(
    (field) =>
      !field.isStatic &&
      !field.isConst &&
      holdsByValue(substitute(field.type, substitution), target, inner, budget, finished)
  );
  finished.set(key, holds);
  return holds;
}

const MAX_GENERIC_NESTING = 16;
const MAX_LAYOUT_WORK = 1_000_000;
