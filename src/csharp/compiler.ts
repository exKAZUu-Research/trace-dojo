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
import type { Library, TypeContext } from './binderBase';
import type { BoundBlock, BoundExpression, BoundStatement } from './bound';
import type { BindContext } from './convertBinder';
import { type DeclaredType, displayMethodIn } from './declarations';
import { FlowAnalyzer } from './flow';
import { COLLECTIONS_SOURCE } from './library/collectionsSource';
import { SYSTEM_SOURCE } from './library/systemSource';
import { TURTLE_SOURCE } from './library/turtleSource';
import { NamespaceSymbol } from './namespaces';
import { parseCSharp } from './parse';
import { FunctionScope, LocalScope } from './scopes';
import { isObjectCreation, StatementBinder } from './statementBinder';
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
  type ParameterSymbol,
  substitute,
  substitutionOf,
  type Type,
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
}

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
  const unit = parseCSharp([SYSTEM_SOURCE, COLLECTIONS_SOURCE, TURTLE_SOURCE].join('\n'), true);
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
  return compiler.compile(unit);
}

export class Compiler extends StatementBinder {
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

  compile(unit: CompilationUnit): CompiledProgram {
    let entry: MethodSymbol | undefined;
    let isTopLevel = false;
    let declared: DeclaredType[] = [];
    this.runGuarded(() => {
      declared = this.declareUnit(unit, this.userRoot, false);
      const program = unit.statements.length > 0 ? this.declareTopLevel(unit) : undefined;
      // Roslyn binds no method bodies once the declarations have errors, so their errors would not appear.
      if (this.diagnostics.length > 0) return;
      for (const type of declared) this.bindTypeMembers(type);
      if (program) {
        this.bindTopLevel(program, unit);
        entry = program.entry;
        isTopLevel = true;
      } else {
        entry = this.findMain(declared);
      }
      this.checkAtomicAnnotations();
    });
    this.finishWithErrors();
    if (!entry)
      throw new CompileError([
        { row: 0, message: "CS5001: プログラムは、エントリ ポイントに適切な静的 'Main' メソッドを含んでいません" },
      ]);
    const types = declared.map((type) => type.symbol);
    if (isTopLevel) types.push(entry.owner);
    return { library: this.library, types, entry, isTopLevel };
  }

  /** Binds the constants and default parameter values of the library, whose methods have no bodies. */
  bindLibraryMembers(declared: DeclaredType[]): void {
    for (const type of declared) {
      for (const field of type.symbol.fields) if (field.isConst) this.constantValueOf(field);
      for (const method of [...type.symbol.methods, ...type.symbol.constructors]) {
        for (const parameter of method.parameters)
          if (parameter.defaultSyntax) this.bindParameterDefault(parameter, parameter.type);
      }
      type.symbol.staticInitializer = this.bindFieldInitializers(type.symbol, type.context, true);
    }
  }

  // ---- Top-level statements ----

  private declareTopLevel(unit: CompilationUnit): { entry: MethodSymbol; type: TypeSymbol } {
    const existing = this.userRoot.findType('Program', 0);
    if (existing) this.unsupported(existing.row, '`partial` クラス');
    const type = new TypeSymbol('Program', 'class', '', undefined);
    type.baseType = this.objectType;
    type.access = 'internal';
    this.userRoot.addType(type);
    const returnsValue = containsValueReturn(unit.statements);
    const entry = new MethodSymbol('<Main>$', type, 'method');
    entry.isStatic = true;
    entry.access = 'private';
    entry.returnType = returnsValue ? this.intType : VOID_TYPE;
    entry.parameters = [{ name: 'args', type: arrayType(this.stringType), refKind: undefined, isParams: false }];
    entry.row = unit.statements[0].row;
    type.methods.push(entry);
    return { entry, type };
  }

  private bindTopLevel(program: { entry: MethodSymbol; type: TypeSymbol }, unit: CompilationUnit): void {
    const typeContext: TypeContext = {
      namespace: [this.userRoot, this.library.root],
      usings: this.resolveUsings(unit.usings),
      type: program.type,
      methodTypeParameters: [],
    };
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
    const candidates = declared.flatMap((type) =>
      type.symbol.methods.filter(
        (method) =>
          method.name === 'Main' &&
          method.isStatic &&
          method.typeParameters.length === 0 &&
          this.isEntrySignature(method)
      )
    );
    if (candidates.length > 1) {
      for (const candidate of candidates)
        this.error(
          candidate.row,
          'CS0017',
          `プログラムで複数のエントリ ポイントが定義されています。エントリ ポイントを含む型を指定するには、/main でコンパイルしてください。`
        );
      return undefined;
    }
    return candidates[0];
  }

  private isEntrySignature(method: MethodSymbol): boolean {
    const returns =
      method.returnType.kind === 'void' ||
      (method.returnType.kind === 'named' && method.returnType.symbol.special === 'int');
    if (!returns) return false;
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
    for (const method of [...symbol.methods, ...symbol.constructors]) {
      for (const parameter of method.parameters)
        if (parameter.defaultSyntax) this.bindParameterDefault(parameter, parameter.type);
    }
    for (const property of symbol.properties) {
      for (const parameter of property.parameters)
        if (parameter.defaultSyntax) this.bindParameterDefault(parameter, parameter.type);
    }
    symbol.instanceInitializer = this.bindFieldInitializers(symbol, context, false);
    symbol.staticInitializer = this.bindFieldInitializers(symbol, context, true);
    for (const method of symbol.methods) {
      const declaration = method.declaration;
      if (method.native || !declaration || method.kind === 'delegateInvoke') continue;
      const body = (declaration as MethodDeclaration).body;
      if (body === undefined) continue;
      this.bindMethod(method, this.methodContexts.get(method) ?? context, body, declaration as MethodDeclaration);
    }
    for (const property of symbol.properties) {
      for (const accessor of [property.getter, property.setter]) {
        if (!accessor?.declaration) continue;
        const body = (accessor.declaration as unknown as { body: MethodDeclaration['body'] }).body;
        this.bindMethod(accessor, context, body, undefined);
      }
    }
    for (const constructor of symbol.constructors) this.bindConstructor(constructor, type);
    if (symbol.staticConstructor) this.bindConstructor(symbol.staticConstructor, type);
  }

  /** Binds the initializers of a type's fields, which run as one block before a constructor's body. */
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
    return this.bindChainedConstructor(baseType, args, position, context, false);
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
    } as BoundExpression;
  }

  /** Binds a method's body with its parameters in scope, then checks its flow. */
  private bindMethod(
    method: MethodSymbol,
    typeContext: TypeContext,
    body: MethodDeclaration['body'],
    declaration: MethodDeclaration | undefined
  ): void {
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
      if (!this.claimedAtomicRows.has(row)) this.error(row, 'atomic', misplacedAtomicMessage);
    }
  }

  protected finishFunction(method: MethodSymbol, fn: FunctionScope): void {
    if (method.kind === 'localFunction' && method.declaration) {
      const declaration = method.declaration as MethodDeclaration;
      this.claimAtomic(method, declaration.startRow, declaration.bodyRow);
    }
    const body = method.body;
    if (!body) return;
    markCapturedLocals(body);
    if (fn.kind === 'lambda') return;
    const analyzer = new FlowAnalyzer({
      unassigned: (local, row) => {
        if (local.isParameter && local.refKind === 'out')
          this.error(row, 'CS0269', `未割り当ての out パラメーター '${local.name}' が使用されました`);
        else this.error(row, 'CS0165', `未割り当てのローカル変数 '${local.name}' が使用されました`);
      },
      notAllPathsReturn: (row) =>
        this.error(row, 'CS0161', `'${this.methodDisplay(method)}': 値を返さないコード パスがあります`),
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
    });
    const parameters = method.locals.filter((local) => local.isParameter && local.owner === method);
    const returnsValue = method.returnType.kind !== 'void' && method.returnType.kind !== 'error';
    analyzer.analyzeFunction(method, body, parameters, returnsValue, body.row);
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
    if (!field.initializer) {
      this.error(field.row, 'CS0145', 'const フィールドに値を指定する必要があります');
      return 0;
    }
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
  private enumMemberValue(field: FieldSymbol, context: BindContext): unknown {
    const owner = field.owner;
    const underlying = owner.enumUnderlying as NamedType;
    const isBig = underlying.symbol.special === 'long' || underlying.symbol.special === 'ulong';
    if (field.initializer) {
      const value = this.bindAs(field.initializer as Expression, underlying, context);
      if (value.kind !== 'constant') {
        // The member's value may refer to other members of its enum, which convert to the underlying type.
        const asEnum = this.bindValue(field.initializer as Expression, context);
        if (asEnum.kind === 'constant' && asEnum.type.kind === 'named' && asEnum.type.symbol === owner)
          return asEnum.value;
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
      {
        namespace: [this.userRoot, this.library.root],
        usings: this.resolveUsings([]),
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
function containsValueReturn(statements: Statement[]): boolean {
  const visit = (statement: Statement): boolean => {
    switch (statement.kind) {
      case 'return': {
        return statement.value !== undefined;
      }
      case 'block': {
        return statement.statements.some(visit);
      }
      case 'if': {
        return visit(statement.consequence) || (statement.alternative !== undefined && visit(statement.alternative));
      }
      case 'while':
      case 'do':
      case 'for':
      case 'foreach': {
        return visit(statement.body);
      }
      case 'switch': {
        return statement.sections.some((section) => section.statements.some(visit));
      }
      case 'try': {
        return (
          visit(statement.body) ||
          statement.catches.some((clause) => visit(clause.body)) ||
          (statement.finally !== undefined && visit(statement.finally))
        );
      }
      default: {
        return false;
      }
    }
  };
  return statements.some(visit);
}

/** Lists in each scope the locals that lambdas or local functions capture, which then live in fresh cells. */
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
      case 'do': {
        visit(statement.body);
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
