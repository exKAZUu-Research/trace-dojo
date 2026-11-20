// code-gauge-allow-file fileNcss 797 -- One compiler phase per file; splitting it further would scatter the cases of one construct.
import type {
  Block,
  Expression,
  ForInBinding,
  FormalParameter,
  FormalParameters,
  MethodDeclaration,
  Span,
  Statement,
  TypeSyntax,
  VariableDeclaration,
} from './ast';
import { assignmentTargets, localNamesIn } from './astWalk';
import type { CompiledFunction, FunctionSpec } from './callCompiler';
import type { ClassInfo } from './classes';
import { type Compiled, type Eval, typeName } from './compilerBase';
import { type CompiledPattern, isRefutableSyntax, PatternCompiler } from './patternCompiler';
import { type DartThrow, type Frame } from './runtime';
import { Flow, FunctionContext, type JumpTarget, type LocalVar, type StoredFlow } from './scope';
import {
  coreTypes,
  type DartType,
  DYNAMIC,
  type FunctionType,
  interfaceType,
  isNullable,
  isPotentiallyNullable,
  isSubtype,
  isTop,
  iterableElementOf,
  makeNullable,
  mentionsTypeParams,
  NEVER,
  nonNullable,
  NULL,
  resolveBound,
  type TypeParam,
  upperBound,
  vmTypeString,
  VOID,
} from './types';
import { type Arguments, Cell, LateInitializer, UNASSIGNED, UNINITIALIZED, type Value } from './values';

export type Completion =
  | { kind: 'break'; label: string | undefined }
  | { kind: 'continue'; label: string | undefined }
  | { kind: 'return'; value: Value };

export type Exec = (frame: Frame) => Completion | undefined;
/** A statement of a `sync*` body, which yields elements as it runs. */
export type GenExec = (frame: Frame) => Generator<Value, Completion | undefined | void, undefined>;

export const BREAK: Completion = { kind: 'break', label: undefined };
export const CONTINUE: Completion = { kind: 'continue', label: undefined };

/** Types whose values learners write down in a trace, whose for-in bindings always record a step. */
export function isAnsweredType(type: DartType): boolean {
  const base = nonNullable(type);
  if (base.kind !== 'interface') return false;
  return [coreTypes.int, coreTypes.double, coreTypes.num, coreTypes.bool, coreTypes.string].includes(base.cls);
}

export abstract class StatementCompiler extends PatternCompiler {
  /** Whether `expression` only calls functions or creates objects, whose own steps show what it did. */
  protected abstract onlyCalls(expression: Expression, compiled: Compiled): boolean;
  protected abstract compileSwitch(statement: Extract<Statement, { kind: 'switch' }>): Exec;
  protected abstract compileTry(statement: Extract<Statement, { kind: 'try' }>): Exec;
  protected abstract compileRethrow(statement: Extract<Statement, { kind: 'rethrow' }>): Exec;
  protected abstract compileExistingForInBinding(
    binding: Extract<ForInBinding, { kind: 'identifier' }>,
    elementType: DartType,
    row: number | undefined
  ): (frame: Frame, value: Value) => void;
  protected abstract compileGeneratorBody(
    spec: FunctionSpec,
    expectedReturn: DartType | undefined
  ): (frame: Frame) => Value;

  // Functions

  // code-gauge-allow functionCognitiveComplexity 18 -- Parameters, the body, and return-type inference.
  // code-gauge-allow functionNcss 46 -- Parameters, the body, and return-type inference.
  compileFunction(spec: FunctionSpec & { isClosure?: boolean }): CompiledFunction {
    const isClosure = spec.isClosure ?? spec.name === '<anonymous closure>';
    const savedFn = this.fn;
    const savedFlow = this.flow;
    const savedRecords = this.recordsSteps;
    const isAtomic = this.atomicRows !== undefined && this.isAtomicHeader(spec.span.row, spec.headerEndRow);
    const info = this.newFunctionInfo(spec.name, undefined, spec.showsThis);
    info.isAtomic = isAtomic;
    const fn = new FunctionContext(isClosure ? savedFn : undefined, info, spec.kind);
    const assignments = assignmentTargets(spec.body, spec.parameters);
    fn.assignments = assignments.locals;
    fn.capturedAssignments = assignments.captured;
    if (spec.returnType === undefined) fn.returnTypes = [];
    if (spec.kind.isGenerator) fn.yieldTypes = [];
    fn.contextReturn = spec.contextReturnType;
    this.fn = fn;
    // A closure sees what is known of the enclosing function's variables where it is created, except promotions of
    // variables assigned anywhere after their declarations, which may change before the closure runs.
    this.flow = isClosure
      ? new Flow(
          true,
          new Map(
            [...savedFlow.promotions].filter(([variable]) => !variable.hasAssignment && !variable.isWriteCaptured)
          ),
          savedFlow.assigned,
          savedFlow.maybeAssigned
        )
      : Flow.start();
    this.recordsSteps = this.isTracing;
    try {
      const binders = this.compileParameters(spec);
      const expectedReturn = spec.returnType ?? spec.contextReturnType;
      let run: (frame: Frame) => Value;
      if (spec.kind.isGenerator) {
        run = this.compileGeneratorBody(spec, expectedReturn);
      } else if (spec.body.kind === 'expression') {
        const body = spec.body.expression;
        const compiled = this.compileReturnValue(body, expectedReturn, spec, true);
        const valueRun = compiled.run;
        run = (frame) => valueRun(frame);
      } else {
        const block = this.compileBlock(spec.body.block, false);
        if (this.flow.reachable) {
          fn.returnTypes?.push(NULL);
          if (spec.returnType && this.requiresReturn(spec.returnType)) {
            this.error(
              { row: spec.body.block.row },
              `戻り値の型が ${typeName(spec.returnType)} の関数 ${displayName(spec.name)} は、最後に値を return しなければなりません。`
            );
          }
        }
        run = (frame) => {
          const completion = block(frame);
          return completion?.kind === 'return' ? completion.value : undefined;
        };
      }
      const returnType = spec.returnType ?? this.inferredReturnType(fn, spec);
      return { fn, returnType, run, bind: binders, usesTypeEnv: true };
    } finally {
      this.fn = savedFn;
      this.flow = savedFlow;
      this.recordsSteps = savedRecords;
    }
  }

  /** The `// atomic` annotation marks a function when it ends a line of its header, up to the line of its body. */
  protected isAtomicHeader(startRow: number, headerEndRow: number): boolean {
    if (!this.atomicRows || this.isLibraryCode) return false;
    for (let row = startRow; row <= headerEndRow; row++) {
      if (this.atomicRows.has(row)) {
        this.usedAtomicRows.add(row);
        return true;
      }
    }
    return false;
  }

  /** The annotation rows that mark a function, so that any other one is reported as misplaced. */
  protected readonly usedAtomicRows = new Set<number>();

  /** Whether a function returning `type` must end with a `return`, because `null` is not a value of the type. */
  protected requiresReturn(type: DartType): boolean {
    if (isTop(type) || type.kind === 'null' || isNullable(type)) return false;
    if (type.kind === 'never') return true;
    return !isPotentiallyNullable(type) || type.kind === 'typeParam';
  }

  private inferredReturnType(fn: FunctionContext, spec: FunctionSpec): DartType {
    if (spec.kind.isGenerator) {
      let element: DartType | undefined;
      for (const type of fn.yieldTypes ?? []) element = element ? upperBound(element, type) : type;
      return interfaceType(coreTypes.iterable, [element ?? DYNAMIC]);
    }
    const types = fn.returnTypes ?? [];
    if (spec.contextReturnType?.kind === 'void') return VOID;
    let result: DartType | undefined;
    for (const type of types) result = result ? upperBound(result, type) : type;
    return result ?? NEVER;
  }

  /** Compiles a returned value: checks it against the declared return type, or collects its type to infer one. */
  private compileReturnValue(
    expression: Expression,
    expected: DartType | undefined,
    spec: FunctionSpec,
    isArrow: boolean
  ): Compiled {
    const context = expected && expected.kind !== 'void' ? expected : undefined;
    const compiled = this.compileExpression(expression, context);
    if (!expected || expected.kind === 'void' || (compiled.type.kind === 'void' && !spec.returnType)) {
      this.fn.returnTypes?.push(compiled.type);
    }
    if (!expected) return compiled;
    if (expected.kind === 'void') {
      if (!isArrow && !isTop(compiled.type) && compiled.type.kind !== 'null' && !(compiled.type.kind === 'never')) {
        this.error(expression, `戻り値の型が void の関数 ${displayName(spec.name)} は、値を返せません。`);
      }
      return compiled;
    }
    // A closure's return type is inferred, so a void body makes it return void whatever its context.
    if (compiled.type.kind === 'void' && !spec.returnType) return compiled;
    if (compiled.type.kind === 'void' && !isTop(expected)) {
      this.error(expression, 'void の値は返せません。');
    }
    const coerced = this.coerce(
      compiled,
      expected,
      expression,
      (from, to) => `${from} 型の値は、戻り値の型 ${to} に合いません。`
    );
    this.fn.returnTypes?.push(coerced.type);
    return coerced;
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- Positional and named parameters bind alike, each with its covariance check.
  // code-gauge-allow duplicateLines 16 -- Positional and named arguments differ in how presence is checked.
  private compileParameters(spec: FunctionSpec): (frame: Frame, args: Arguments) => void {
    const { parameters } = spec;
    const binders: ((frame: Frame, args: Arguments) => void)[] = [];
    // A covariant parameter, or one typed by its class's type parameter, may receive what a reference of a
    // supertype lets through (`A c = Cat(); c.chase(Animal())`), so it is checked on every call.
    const classParams =
      spec.kind.hasThis && !spec.kind.isConstructor ? new Set(spec.kind.thisClass?.typeParams) : undefined;
    const thisClass = spec.kind.hasThis && !spec.kind.isConstructor ? spec.kind.thisClass : undefined;
    const isCovariant = (parameter: FormalParameter, type: DartType, index?: number): boolean =>
      parameter.isCovariant ||
      (classParams !== undefined && classParams.size > 0 && mentionsTypeParams(type, classParams)) ||
      (thisClass !== undefined && inheritsCovariance(thisClass, spec.name, parameter.name, index, spec.isSetter));
    for (const [index, parameter] of parameters.positional.entries()) {
      const type = spec.positionalTypes[index] ?? DYNAMIC;
      const { variable, defaultValue } = this.declareParameter(
        parameter,
        type,
        index >= parameters.requiredCount,
        spec.defaults
      );
      binders.push(
        parameterBinder(
          variable.slot,
          defaultValue,
          this.parameterCheck(type, parameter.name),
          isCovariant(parameter, type, index),
          (args) => (index < args.positional.length ? { value: args.positional[index] } : undefined)
        )
      );
    }
    for (const parameter of parameters.named) {
      const type = spec.namedTypes.get(parameter.name) ?? DYNAMIC;
      const { variable, defaultValue } = this.declareParameter(parameter, type, true, spec.defaults);
      const { name } = parameter;
      binders.push(
        parameterBinder(
          variable.slot,
          defaultValue,
          this.parameterCheck(type, name),
          isCovariant(parameter, type),
          (args) => (args.named?.has(name) ? { value: args.named.get(name) } : undefined)
        )
      );
    }
    const checkArity = this.arityCheck(spec);
    return (frame, args) => {
      if (args.isDynamic) checkArity(frame, args);
      for (const bind of binders) bind(frame, args);
    };
  }

  /** Declares a parameter as a local, compiling its default value, which must be a constant. */
  private declareParameter(
    parameter: FormalParameter,
    type: DartType,
    isOptional: boolean,
    defaults: Map<FormalParameter, Compiled> | undefined
  ): { variable: LocalVar; defaultValue: Eval | undefined } {
    let defaultValue: Eval | undefined;
    const compiled = parameter.defaultValue
      ? this.withConstContext(true, () => this.compileExpression(parameter.defaultValue as Expression, type))
      : defaults?.get(parameter);
    if (compiled) {
      const span = parameter.defaultValue ?? parameter;
      if (!compiled.isConst) this.error(span, '引数の既定値には、定数を書いてください。');
      const coerced = this.coerce(
        compiled,
        type,
        span,
        (from, to) => `${from} 型の既定値は、${to} 型の引数 ${parameter.name} に合いません。`
      );
      if (parameter.defaultValue) this.checkConstant(span, coerced);
      defaults?.set(parameter, coerced);
      defaultValue = coerced.run;
    } else if (
      isOptional &&
      !parameter.isRequired &&
      !isNullable(type) &&
      type.kind !== 'dynamic' &&
      !this.isLibraryCode
    ) {
      this.error(
        parameter,
        `引数 ${parameter.name} の型 ${typeName(type)} は null にならないので、既定値を書くか、required を付けてください。`
      );
    }
    const variable = this.declareLocal(parameter, parameter.name, type, {
      isFinal: parameter.isFinal,
      isLate: false,
      isConst: false,
      isParameter: true,
      hasInitializer: true,
    });
    return { variable, defaultValue };
  }

  /** The check of an argument a dynamic call passes, which the call site could not check statically. */
  private parameterCheck(type: DartType, name: string): ((frame: Frame, value: Value) => void) | undefined {
    if (isTop(type)) return undefined;
    const resolve = this.runtimeType(type);
    return (frame, value) => {
      const expected = resolve(frame);
      if (!this.valueIsAt(frame, value, expected)) {
        frame.runtime.throwTypeError(
          `type '${vmTypeString(frame.runtime.runtimeTypeOf(value))}' is not a subtype of type '${vmTypeString(expected)}' of '${name}'`
        );
      }
    };
  }

  /** A dynamic call with arguments the function does not take fails as `noSuchMethod`. */
  private arityCheck(spec: FunctionSpec): (frame: Frame, args: Arguments) => void {
    const { parameters } = spec;
    const count = parameters.positional.length;
    const required = parameters.requiredCount;
    const namedNames = new Set(parameters.named.map((parameter) => parameter.name));
    const requiredNamed = parameters.named
      .filter((parameter) => parameter.isRequired)
      .map((parameter) => parameter.name);
    return (frame, args) => {
      const positional = args.positional.length;
      const unknown = [...(args.named?.keys() ?? [])].some((name) => !namedNames.has(name));
      const missing = requiredNamed.some((name) => !args.named?.has(name));
      if (positional < required || positional > count || unknown || missing) {
        frame.runtime.noSuchMethod(frame.receiver, spec.name, 'method', args);
      }
    };
  }

  // Statements

  protected compileBlock(block: Block, clear = true): Exec {
    const { result, slots } = this.withScope(() => this.compileStatements(block.statements), clear);
    if (slots.length === 0) return result;
    return (frame) => {
      try {
        return result(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
    };
  }

  protected compileStatements(statements: Statement[]): Exec {
    this.reserveLocals(localNamesIn(statements));
    const compiled = statements.map((statement) => this.compileStatement(statement));
    if (compiled.length === 1) return compiled[0];
    return (frame) => {
      for (const exec of compiled) {
        const completion = exec(frame);
        if (completion) return completion;
      }
      return;
    };
  }

  protected compileStatement(statement: Statement): Exec {
    const exec = this.compileStatementBody(statement);
    return (frame) => {
      frame.runtime.spend();
      return exec(frame);
    };
  }

  /** The row whose step a statement records when the program is traced, or undefined when it records none. */
  protected stepRowOf(statement: { row: number }): number | undefined {
    return this.recordsSteps ? statement.row : undefined;
  }

  protected withStep(statement: { row: number }, exec: Exec, onlyCalls: boolean | (() => boolean)): Exec {
    const row = this.stepRowOf(statement);
    if (row === undefined) return exec;
    return (frame) => frame.runtime.steps.runStatement(row, onlyCalls, () => exec(frame));
  }

  // code-gauge-allow duplicateLines 38 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  // code-gauge-allow functionNcss 41 -- One case per kind of statement.
  protected compileStatementBody(statement: Statement): Exec {
    switch (statement.kind) {
      case 'block': {
        return this.compileBlock(statement);
      }
      case 'expression': {
        return this.compileExpressionStatement(statement);
      }
      case 'local': {
        return this.compileLocalDeclaration(statement.declaration);
      }
      case 'patternDeclaration': {
        return this.compilePatternDeclaration(statement);
      }
      case 'localFunction': {
        return this.compileLocalFunction(statement);
      }
      case 'if': {
        return this.compileIf(statement);
      }
      case 'while': {
        return this.compileWhile(statement);
      }
      case 'do': {
        return this.compileDo(statement);
      }
      case 'for': {
        return this.compileFor(statement);
      }
      case 'forIn': {
        return this.compileForIn(statement);
      }
      case 'switch': {
        return this.compileSwitch(statement);
      }
      case 'break':
      case 'continue': {
        return this.compileJump(statement);
      }
      case 'return': {
        return this.compileReturn(statement);
      }
      case 'try': {
        return this.compileTry(statement);
      }
      case 'rethrow': {
        return this.compileRethrow(statement);
      }
      case 'labeled': {
        return this.compileLabeled(statement);
      }
      case 'assert': {
        return this.compileAssert(statement);
      }
      case 'yield': {
        return this.error(statement, 'yield は sync* の関数の中にしか書けません。');
      }
    }
  }

  private compileExpressionStatement(statement: Extract<Statement, { kind: 'expression' }>): Exec {
    const { expression } = statement;
    const compiled = this.compileExpression(expression);
    const { run } = compiled;
    const exec: Exec = (frame) => {
      run(frame);
      return;
    };
    if (compiled.completes === false || expression.kind === 'throw') {
      this.flow = this.flow.unreachable;
      // A `throw` records no step, as Java's throw statement does.
      if (expression.kind === 'throw') return exec;
    }
    return this.withStep(statement, exec, this.onlyCalls(expression, compiled));
  }

  // code-gauge-allow functionCognitiveComplexity 24 -- Bind a declaration, retain its constant or promotion, and emit its step.
  protected compileLocalDeclaration(declaration: VariableDeclaration, recordStep = true): Exec {
    const declaredType = declaration.type ? this.resolveType(declaration.type) : undefined;
    const parts: { slot: number; run: Eval | undefined; isLate: boolean }[] = [];
    const initialized: Compiled[] = [];
    for (const declarator of declaration.variables) {
      const compiled = this.compileLocalInitializer(declaration, declarator, declaredType);
      if (compiled) initialized.push(compiled);
      let type = declaredType ?? (compiled ? widenInferred(compiled.type) : DYNAMIC);
      if (!declaredType && compiled?.type.kind === 'null') type = DYNAMIC;
      const variable = this.declareLocal(declarator, declarator.name, type, {
        isFinal: declaration.isFinal || declaration.isConst,
        isLate: declaration.isLate,
        isConst: declaration.isConst,
        isParameter: false,
        hasInitializer: declarator.initializer !== undefined,
      });
      if (declaration.isConst && compiled) {
        if (compiled.constValue) {
          variable.constant = compiled.constValue.value;
          variable.hasConstant = true;
        } else {
          variable.constantInitializer = compiled.run;
        }
      }
      if (compiled && !declaration.isLate) this.flowAfterInitializer(variable, compiled, declaredType);
      variable.condition = this.pendingCondition;
      this.pendingCondition = undefined;
      parts.push({ slot: variable.slot, run: compiled?.run, isLate: declaration.isLate });
    }
    const exec: Exec = (frame) => {
      for (const { slot, run, isLate } of parts) frame.locals[slot] = new Cell(initialLocalValue(frame, run, isLate));
      return;
    };
    if (initialized.length === 0 || !recordStep || declaration.isLate) return exec;
    return this.withStep(
      declaration,
      exec,
      initialized.every((compiled) => isCreation(compiled))
    );
  }

  /** The condition the initializer being compiled gave, for the local it initializes. */
  private pendingCondition: LocalVar['condition'];

  private compileLocalInitializer(
    declaration: VariableDeclaration,
    declarator: VariableDeclaration['variables'][number],
    declaredType: DartType | undefined
  ): Compiled | undefined {
    const { initializer } = declarator;
    if (declaration.isConst && !initializer)
      this.error(declarator, `const の変数 ${declarator.name} には、初期値が必要です。`);
    if (!initializer) return undefined;
    const savedFlow = this.flow;
    this.pendingCondition = undefined;
    const isCondition =
      !declaration.isLate &&
      !declaration.isConst &&
      (!declaredType || isBoolType(declaredType)) &&
      isConditionShaped(initializer);
    let compiled: Compiled;
    if (isCondition) {
      const result = this.compileConditionInner(initializer);
      compiled = result.compiled;
      this.flow = Flow.join(result.flow.whenTrue, result.flow.whenFalse);
      this.pendingCondition = {
        whenTrue: storeFlow(result.flow.whenTrue, savedFlow),
        whenFalse: storeFlow(result.flow.whenFalse, savedFlow),
      };
    } else {
      compiled = this.withConstContext(declaration.isConst, () => this.compileExpression(initializer, declaredType));
    }
    if (declaration.isLate) this.flow = savedFlow;
    if (declaration.isConst && !compiled.isConst)
      this.error(initializer, `const の変数 ${declarator.name} の初期値は、定数でなければなりません。`);
    if (declaredType) {
      compiled = this.coerce(
        compiled,
        declaredType,
        initializer,
        (from, to) => `${from} 型の値は、${to} 型の変数 ${declarator.name} に代入できません。`
      );
    }
    if (declaration.isConst) this.checkConstant(initializer, compiled);
    // `var x = f();` with a void `f` declares a void variable, which Dart rejects only where it is used.
    return compiled;
  }

  /** An initialized local is assigned, and a nullable one initialized with a non-null value is promoted. */
  private flowAfterInitializer(variable: LocalVar, compiled: Compiled, declaredType: DartType | undefined): void {
    this.flow = this.flow.assign(variable);
    if (
      !declaredType ||
      compiled.type.kind === 'dynamic' ||
      isSubtypeOfSame(compiled.type, declaredType) ||
      !this.isPromotable(variable)
    )
      return;
    const promoted = nonNullable(declaredType);
    if (isNullable(declaredType) && isSubtype(compiled.type, promoted))
      this.flow = this.flow.promote(variable, promoted);
  }

  private compilePatternDeclaration(statement: Extract<Statement, { kind: 'patternDeclaration' }>): Exec {
    const value = this.compileExpression(statement.value, this.patternContextType(statement.pattern));
    const pattern = this.compilePattern(statement.pattern, value.type, { mode: 'declare', isFinal: statement.isFinal });
    if (isRefutableSyntax(statement.pattern))
      this.error(
        statement,
        'このパターンには合わない値があるので、変数の宣言には使えません。if-case か switch を使ってください。'
      );
    for (const variable of pattern.variables.values()) this.flow = this.flow.assign(variable);
    const { run } = value;
    const exec: Exec = (frame) => {
      const result = run(frame);
      if (!pattern.match(frame, result)) this.throwPatternMismatch(frame, result);
      return;
    };
    return this.withStep(statement, exec, false);
  }

  // code-gauge-allow duplicateLines 18 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  private compileLocalFunction(statement: Extract<Statement, { kind: 'localFunction' }>): Exec {
    const { declaration } = statement;
    const typeParams = this.declareTypeParams(declaration.typeParameters);
    const { type, positionalTypes, namedTypes } = this.withTypeParams(typeParams, () =>
      this.signatureOf(declaration.parameters, declaration.returnType, typeParams)
    );
    const variable = this.declareLocal(declaration, declaration.name, type, {
      isFinal: true,
      isLate: false,
      isConst: false,
      isParameter: false,
      hasInitializer: true,
    });
    if (!declaration.body) return this.error(declaration, `関数 ${declaration.name} に本体がありません。`);
    const compiled = this.withTypeParams(typeParams, () =>
      this.compileFunction({
        name: declaration.name,
        span: declaration,
        headerEndRow: declaration.headerEndRow,
        parameters: declaration.parameters,
        positionalTypes,
        namedTypes,
        returnType: type.returnType,
        contextReturnType: undefined,
        body: declaration.body as NonNullable<typeof declaration.body>,
        typeParams,
        kind: {
          ...this.fn.kind,
          returnType: type.returnType,
          isGenerator: declaration.body?.modifier === 'sync*',
          isConstructor: false,
        },
        showsThis: false,
        isClosure: true,
      })
    );
    const create = this.closureCreator(compiled, type);
    const { slot } = variable;
    return (frame) => {
      const cell = new Cell(undefined);
      frame.locals[slot] = cell;
      cell.v = create(frame);
      return;
    };
  }

  /** The function type of a signature, with its parameters' types. */
  protected abstract signatureOf(
    parameters: FormalParameters,
    returnType: TypeSyntax | undefined,
    typeParams: TypeParam[]
  ): { type: FunctionType; positionalTypes: DartType[]; namedTypes: Map<string, DartType> };

  // Control flow

  private compileIf(statement: Extract<Statement, { kind: 'if' }>): Exec {
    if (statement.casePattern) return this.compileIfCase(statement);
    const { compiled: condition, flow } = this.compileCondition(statement.condition);
    this.flow = flow.whenTrue;
    const consequence = this.compileScoped(statement.consequence);
    const afterThen = this.flow;
    this.flow = flow.whenFalse;
    const { alternative } = statement;
    const otherwise = alternative ? this.compileScoped(alternative) : undefined;
    this.flow = Flow.join(afterThen, this.flow);
    const test = condition.run;
    if (otherwise) return (frame) => (test(frame) ? consequence(frame) : otherwise(frame));
    return (frame) => (test(frame) ? consequence(frame) : undefined);
  }

  private compileIfCase(statement: Extract<Statement, { kind: 'if' }>): Exec {
    const { match, consequence, otherwise, slots } = this.compileIfCaseParts(statement, (body) =>
      this.compileScoped(body)
    );
    return (frame) => {
      try {
        if (match(frame)) return consequence(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
      return otherwise?.(frame);
    };
  }

  protected compileIfCaseParts<T>(
    statement: Extract<Statement, { kind: 'if' }>,
    compileBody: (body: Statement) => T
  ): {
    match: (frame: Frame) => boolean;
    consequence: T;
    otherwise: T | undefined;
    slots: number[];
  } {
    const subject = this.compileExpression(statement.condition);
    const casePattern = statement.casePattern as NonNullable<typeof statement.casePattern>;
    const before = this.flow;
    let pattern!: CompiledPattern;
    let guard: Eval | undefined;
    const { result: consequence, slots } = this.withScope(() => {
      pattern = this.compilePattern(casePattern.pattern, subject.type, { mode: 'match', isFinal: false });
      for (const variable of pattern.variables.values()) this.flow = this.flow.assign(variable);
      if (casePattern.guard) {
        const compiledGuard = this.compileCondition(casePattern.guard);
        guard = compiledGuard.compiled.run;
        this.flow = compiledGuard.flow.whenTrue;
      }
      return compileBody(statement.consequence);
    });
    const afterThen = this.flow;
    this.flow = before;
    const otherwise = statement.alternative ? compileBody(statement.alternative) : undefined;
    this.flow = Flow.join(afterThen, this.flow);
    const match = (frame: Frame): boolean => {
      const value = subject.run(frame);
      frame.temporaries.push(value);
      try {
        return pattern.match(frame, value) && (!guard || guard(frame) === true);
      } finally {
        frame.temporaries.pop();
      }
    };
    return { match, consequence, otherwise, slots };
  }

  /** Compiles a statement in a scope of its own, as the branches and bodies of control statements are. */
  protected compileScoped(statement: Statement): Exec {
    if (statement.kind === 'block') return this.compileStatement(statement);
    const { result, slots } = this.withScope(() => this.compileStatement(statement));
    if (slots.length === 0) return result;
    return (frame) => {
      try {
        return result(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
    };
  }

  /** Forgets what a loop's body may change before compiling it, as flow analysis does at a loop's start. */
  protected enterLoop(statement: object): void {
    this.flow = this.flow.forget(this.writtenLocals(statement));
  }

  protected writtenLocals(statement: object): LocalVar[] {
    const { locals, free } = assignmentTargets(statement);
    const variables: LocalVar[] = [];
    for (const name of free) {
      const variable = this.findLocal(name);
      if (variable) variables.push(variable);
    }
    for (const [syntax, names] of locals) {
      for (const name of names) {
        const variable = this.findLocal(name);
        if (variable?.syntax === syntax) variables.push(variable);
      }
    }
    return variables;
  }

  // code-gauge-allow duplicateLines 19 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  private compileWhile(statement: Extract<Statement, { kind: 'while' }>): Exec {
    const labels = this.takeLoopLabels();
    this.enterLoop(statement);
    const { compiled: condition, flow } = this.compileCondition(statement.condition);
    this.flow = flow.whenTrue;
    const body = this.compileLoopBody(statement.body, labels);
    this.flow = Flow.join(flow.whenFalse, this.fn.jumpTargets.pop()?.breakFlow ?? flow.whenFalse.unreachable);
    const test = condition.run;
    return (frame) => {
      while (test(frame)) {
        const completion = body(frame);
        if (completion) {
          const result = loopCompletion(completion, labels);
          if (result !== 'continue') return result;
        }
      }
      return;
    };
  }

  // code-gauge-allow duplicateLines 18 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  private compileDo(statement: Extract<Statement, { kind: 'do' }>): Exec {
    const labels = this.takeLoopLabels();
    this.enterLoop(statement);
    const body = this.compileLoopBody(statement.body, labels);
    const target = this.fn.jumpTargets.pop();
    const breakFlow = target?.breakFlow;
    if (target?.continueFlow) this.flow = Flow.join(this.flow, target.continueFlow);
    const { compiled: condition, flow } = this.compileCondition(statement.condition);
    this.flow = breakFlow ? Flow.join(flow.whenFalse, breakFlow) : flow.whenFalse;
    const test = condition.run;
    return (frame) => {
      do {
        const completion = body(frame);
        if (completion) {
          const result = loopCompletion(completion, labels);
          if (result !== 'continue') return result;
        }
      } while (test(frame));
      return;
    };
  }

  protected enterJumpTarget(kind: JumpTarget['kind'], labels: string[]): void {
    this.fn.jumpTargets.push({ kind, labels });
  }

  /** The labels written directly before the loop being compiled. */
  protected pendingLabels: string[] = [];

  protected takeLoopLabels(): string[] {
    const labels = this.pendingLabels;
    this.pendingLabels = [];
    return labels;
  }

  protected compileLoopBody(body: Statement, labels: string[]): Exec {
    this.fn.loopDepth++;
    for (const label of labels) this.fn.labels.push({ name: label, isLoop: true, isSwitchCase: false });
    this.enterJumpTarget('loop', labels);
    try {
      return this.compileScoped(body);
    } finally {
      this.fn.loopDepth--;
      this.fn.labels.splice(this.fn.labels.length - labels.length, labels.length);
    }
  }

  // code-gauge-allow duplicateLines 20 -- The counted loop shares its header operations with the generator form.
  private compileFor(statement: Extract<Statement, { kind: 'for' }>): Exec {
    const labels = this.takeLoopLabels();
    const { result, slots } = this.withScope(() => {
      const { initExec, loopVariables, initRow } = this.compileForInit(statement);
      this.enterLoop(statement);
      const { compiled: condition, flow } = statement.condition
        ? this.compileCondition(statement.condition)
        : { compiled: undefined, flow: { whenTrue: this.flow, whenFalse: this.flow.unreachable } };
      this.flow = flow.whenTrue;
      const body = this.compileLoopBody(statement.body, labels);
      const target = this.fn.jumpTargets.pop();
      const breakFlow = target?.breakFlow;
      if (target?.continueFlow) this.flow = Flow.join(this.flow, target.continueFlow);
      const updates = statement.updates.map((update) => this.compileExpression(update).run);
      const updateRow = updates.length > 0 ? this.stepRowOf(statement) : undefined;
      this.flow = breakFlow ? Flow.join(flow.whenFalse, breakFlow) : flow.whenFalse;
      return forLoop({
        initExec,
        initRow,
        test: condition?.run,
        body,
        labels,
        loopSlots: loopVariables.map((variable) => variable.slot),
        updates,
        updateRow,
      });
    });
    if (slots.length === 0) return result;
    return (frame) => {
      try {
        return result(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
    };
  }

  /** The initializer of a for loop: its variables, which each iteration copies, and the row of its step. */
  protected compileForInit(statement: Extract<Statement, { kind: 'for' }>): {
    initExec: Exec | undefined;
    loopVariables: LocalVar[];
    initRow: number | undefined;
  } {
    const { init } = statement;
    let initExec: Exec | undefined;
    const loopVariables: LocalVar[] = [];
    if (init && !Array.isArray(init)) {
      const before = new Set(this.fn.scopes.at(-1)?.values());
      initExec = this.compileLocalDeclaration(init, false);
      for (const variable of this.fn.scopes.at(-1)?.values() ?? [])
        if (!before.has(variable)) loopVariables.push(variable);
    } else if (init) {
      const runs = init.map((expression) => this.compileExpression(expression).run);
      initExec = (frame) => {
        for (const run of runs) run(frame);
        return;
      };
    }
    const initRecords =
      init !== undefined &&
      (Array.isArray(init) ? init.length > 0 : init.variables.some((variable) => variable.initializer));
    return { initExec, loopVariables, initRow: initRecords ? this.stepRowOf(statement) : undefined };
  }

  private compileForIn(statement: Extract<Statement, { kind: 'forIn' }>): Exec {
    const labels = this.takeLoopLabels();
    const iterable = this.compileExpression(statement.iterable);
    const elementType = this.elementTypeOfIterable(iterable, statement.iterable);
    const { result, slots } = this.withScope(() => {
      this.enterLoop(statement);
      const before = this.flow;
      const bind = this.compileForInBinding(statement.binding, elementType, statement);
      const body = this.compileLoopBody(statement.body, labels);
      const breakFlow = this.fn.jumpTargets.pop()?.breakFlow;
      this.flow = breakFlow ? Flow.join(before, breakFlow) : before;
      return this.forInLoop(iterable.run, bind, body, labels);
    });
    if (slots.length === 0) return result;
    return (frame) => {
      try {
        return result(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
    };
  }

  protected elementTypeOfIterable(iterable: Compiled, span: { row: number }): DartType {
    if (iterable.type.kind === 'dynamic') return DYNAMIC;
    if (isNullable(iterable.type))
      this.error(span, `${typeName(iterable.type)} 型の値は null かもしれないので、for-in では使えません。`);
    const element = iterableElementOf(iterable.type);
    if (!element)
      return this.error(span, `${typeName(iterable.type)} 型の値は Iterable ではないので、for-in では使えません。`);
    return element;
  }

  /** Compiles a for-in loop's binding, which records a step for values learners write down. */
  // code-gauge-allow functionCognitiveComplexity 23 -- Each branch is one of the cases Dart distinguishes for this construct.
  // code-gauge-allow functionNcss 40 -- One case per form of the construct, which reads best together.
  protected compileForInBinding(
    binding: ForInBinding,
    elementType: DartType,
    statement: { row: number }
  ): (frame: Frame, value: Value) => void {
    const row = this.stepRowOf(statement);
    switch (binding.kind) {
      case 'declaration': {
        const type = binding.type ? this.resolveType(binding.type) : elementType;
        if (!isSubtype(elementType, type) && elementType.kind !== 'dynamic') {
          this.error(
            binding,
            `${typeName(elementType)} 型の要素は、${typeName(type)} 型の変数 ${binding.name} に代入できません。`
          );
        }
        const variable = this.declareLocal(binding, binding.name, type, {
          isFinal: binding.isFinal,
          isLate: false,
          isConst: false,
          isParameter: false,
          hasInitializer: true,
        });
        const { slot } = variable;
        const check =
          elementType.kind === 'dynamic' && !isTop(type)
            ? this.runtimeCast((frame) => frame.temporaries.at(-1), type, false)
            : undefined;
        const answered = isAnsweredType(type);
        return (frame, value) => {
          if (check) {
            frame.temporaries.push(value);
            try {
              check(frame);
            } finally {
              frame.temporaries.pop();
            }
          }
          frame.locals[slot] = new Cell(value);
          frame.runtime.steps.stepBinding(row, answered);
        };
      }
      case 'identifier': {
        return this.compileExistingForInBinding(binding, elementType, row);
      }
      case 'pattern': {
        const pattern = this.compilePattern(binding.pattern, elementType, {
          mode: 'declare',
          isFinal: binding.isFinal,
        });
        if (isRefutableSyntax(binding.pattern))
          this.error(binding, 'このパターンには合わない要素があるので、for-in の変数には使えません。');
        for (const variable of pattern.variables.values()) this.flow = this.flow.assign(variable);
        return (frame, value) => {
          if (!pattern.match(frame, value)) this.throwPatternMismatch(frame, value);
          frame.runtime.steps.stepBinding(row, true);
        };
      }
    }
  }

  /** Runs a for-in loop over an iterable through its iterator, as Dart does. */
  // code-gauge-allow duplicateLines 16 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  protected forInLoop(iterable: Eval, bind: (frame: Frame, value: Value) => void, body: Exec, labels: string[]): Exec {
    return (frame) => {
      const { runtime } = frame;
      const source = iterable(frame);
      frame.temporaries.push(source);
      const iterator = runtime.getProperty(source, 'iterator', undefined);
      frame.temporaries.push(iterator);
      try {
        for (;;) {
          const hasNext = runtime.invoke(iterator, 'moveNext', { positional: [], named: undefined }, [], undefined);
          if (hasNext !== true) return;
          const value = runtime.getProperty(iterator, 'current', undefined);
          bind(frame, value);
          const completion = body(frame);
          if (completion) {
            const outcome = loopCompletion(completion, labels);
            if (outcome !== 'continue') return outcome;
          }
          runtime.spend();
        }
      } finally {
        frame.temporaries.pop();
        frame.temporaries.pop();
      }
    };
  }

  private compileJump(statement: Extract<Statement, { kind: 'break' | 'continue' }>): Exec {
    const { kind, label } = statement;
    const target = kind === 'break' ? this.breakTarget(statement) : this.continueTarget(statement);
    if (target) {
      const flow = kind === 'break' ? 'breakFlow' : 'continueFlow';
      target[flow] = target[flow] ? Flow.join(target[flow], this.flow) : this.flow;
    }
    this.flow = this.flow.unreachable;
    const completion: Completion = label === undefined ? (kind === 'break' ? BREAK : CONTINUE) : { kind, label };
    return () => completion;
  }

  private breakTarget(statement: Span & { label: string | undefined }): JumpTarget | undefined {
    const { label } = statement;
    if (label === undefined && this.fn.loopDepth === 0 && this.fn.switchDepth === 0) {
      this.error(statement, 'break はループや switch の中にしか書けません。');
    }
    if (label !== undefined && !this.fn.labels.some((entry) => entry.name === label && !entry.isSwitchCase)) {
      this.error(statement, `ラベル ${label} が見つかりません。`);
    }
    return this.fn.jumpTargets.findLast((entry) =>
      label === undefined ? entry.kind !== 'label' : entry.labels.includes(label)
    );
  }

  private continueTarget(statement: Span & { label: string | undefined }): JumpTarget | undefined {
    const { label } = statement;
    if (label === undefined && this.fn.loopDepth === 0)
      this.error(statement, 'continue はループの中にしか書けません。');
    if (label !== undefined) {
      const entry = this.fn.labels.findLast((candidate) => candidate.name === label);
      if (!entry) this.error(statement, `ラベル ${label} が見つかりません。`);
      if (entry.isSwitchCase) return undefined;
      if (!entry.isLoop) this.error(statement, `ラベル ${label} はループに付いていないので、continue では使えません。`);
    }
    return this.fn.jumpTargets.findLast(
      (entry) => entry.kind === 'loop' && (label === undefined || entry.labels.includes(label))
    );
  }

  private compileReturn(statement: Extract<Statement, { kind: 'return' }>): Exec {
    if (this.fn.kind.isGenerator) {
      if (statement.value) this.error(statement, 'sync* の関数では、値を return できません。yield を使ってください。');
      this.flow = this.flow.unreachable;
      const done: Completion = { kind: 'return', value: undefined };
      return () => done;
    }
    const expected = this.fn.kind.returnType ?? (this.fn.returnTypes ? undefined : VOID);
    if (!statement.value) {
      this.fn.returnTypes?.push(NULL);
      if (
        expected &&
        expected.kind !== 'void' &&
        !isTop(expected) &&
        expected.kind !== 'null' &&
        !this.fn.kind.isConstructor
      ) {
        this.error(statement, `戻り値の型が ${typeName(expected)} なので、return に値が必要です。`);
      }
      this.flow = this.flow.unreachable;
      const completion: Completion = { kind: 'return', value: undefined };
      return () => completion;
    }
    if (this.fn.kind.isConstructor) this.error(statement, 'コンストラクタからは値を返せません。');
    const compiled = this.compileReturnValueOf(statement.value, expected);
    this.flow = this.flow.unreachable;
    const { run } = compiled;
    return (frame) => ({ kind: 'return', value: run(frame) });
  }

  private compileReturnValueOf(value: Expression, expected: DartType | undefined): Compiled {
    const context = expected ?? this.closureContextReturn();
    const compiled = this.compileExpression(value, context?.kind === 'void' ? undefined : context);
    if (expected?.kind === 'void' && !isTop(compiled.type) && compiled.type.kind !== 'null')
      this.error(value, '戻り値の型が void の関数は、値を返せません。');
    const returned =
      context && context.kind !== 'void'
        ? this.coerce(compiled, context, value, (from, to) => `${from} 型の値は、戻り値の型 ${to} に合いません。`)
        : compiled;
    this.fn.returnTypes?.push(returned.type);
    return returned;
  }

  /** The return type a closure's context expects, which its returns are checked against. */
  protected closureContextReturn(): DartType | undefined {
    return this.fn.contextReturn;
  }

  /** The slots holding the exceptions of the catch clauses being compiled, innermost last. */
  protected readonly rethrowSlots: number[] = [];

  protected abstract stackTraceValue(frame: Frame, error: DartThrow): Value;

  private compileLabeled(statement: Extract<Statement, { kind: 'labeled' }>): Exec {
    const { labels, body } = statement;
    const isLoop = ['for', 'forIn', 'while', 'do', 'switch'].includes(body.kind);
    if (isLoop) this.pendingLabels = labels;
    for (const label of labels) if (!isLoop) this.fn.labels.push({ name: label, isLoop: false, isSwitchCase: false });
    this.enterJumpTarget('label', labels);
    let exec: Exec;
    try {
      exec = this.compileStatement(body);
    } finally {
      if (!isLoop) this.fn.labels.splice(this.fn.labels.length - labels.length, labels.length);
      this.pendingLabels = [];
    }
    const breakFlow = this.fn.jumpTargets.pop()?.breakFlow;
    if (breakFlow) this.flow = Flow.join(this.flow, breakFlow);
    return (frame) => {
      const completion = exec(frame);
      if (completion?.kind === 'break' && completion.label !== undefined && labels.includes(completion.label)) return;
      return completion;
    };
  }

  private compileAssert(statement: Extract<Statement, { kind: 'assert' }>): Exec {
    const before = this.flow;
    this.compileCondition(statement.condition);
    if (statement.message) this.compileExpression(statement.message);
    this.flow = before;
    // `dart run` runs without --enable-asserts, which skips assertions.
    return () => {};
  }

  // Generators

  /** Creates the iterable a `sync*` function returns, which runs a new copy of the body for each iterator. */
  protected abstract makeSyncStarIterable(frame: Frame, elementType: DartType, body: GenExec): Value;
}

/** Whether a method overrides one whose parameter at the position or of the name is `covariant`, making it so. */
export function inheritsCovariance(
  cls: ClassInfo,
  methodName: string,
  parameterName: string,
  index: number | undefined,
  setter = false
): boolean {
  for (const { cls: supertype } of cls.directSupertypes) {
    const field = setter ? supertype.setters.get(methodName) : undefined;
    if (field?.kind === 'field' && field.isCovariant) return true;
    const method = supertype.declaration?.members.find(
      (member): member is MethodDeclaration =>
        member.kind === 'method' && member.name === methodName && (member.methodKind === 'setter') === setter
    );
    const parameter =
      index === undefined
        ? method?.parameters.named.find((named) => named.name === parameterName)
        : method?.parameters.positional[index];
    if (parameter?.isCovariant || inheritsCovariance(supertype, methodName, parameterName, index, setter)) return true;
  }
  return false;
}

/** Stores an argument, or the default value when the call passes none, in a parameter's slot. */
function parameterBinder(
  slot: number,
  defaultValue: Eval | undefined,
  check: ((frame: Frame, value: Value) => void) | undefined,
  alwaysChecks: boolean,
  passed: (args: Arguments) => { value: Value } | undefined
): (frame: Frame, args: Arguments) => void {
  return (frame, args) => {
    const argument = passed(args);
    let value: Value;
    if (argument) {
      value = argument.value;
      if ((args.isDynamic || alwaysChecks) && check) check(frame, value);
    } else {
      value = defaultValue ? defaultValue(frame) : undefined;
    }
    frame.locals[slot] = new Cell(value);
  };
}

export interface CountedLoop<Body> {
  initExec: Exec | undefined;
  initRow: number | undefined;
  test: Eval | undefined;
  body: Body;
  labels: string[];
  loopSlots: number[];
  updates: Eval[];
  updateRow: number | undefined;
}

// code-gauge-allow duplicateLines 15 -- The generator loop shares the header operations and suspends around its body.
function forLoop(loop: CountedLoop<Exec>): Exec {
  const { test, body, labels } = loop;
  return (frame) => {
    startCountedLoop(loop, frame);
    for (;;) {
      if (test && !test(frame)) return;
      const completion = body(frame);
      if (completion) {
        const outcome = loopCompletion(completion, labels);
        if (outcome !== 'continue') return outcome;
      }
      advanceCountedLoop(loop, frame);
    }
  };
}

export function startCountedLoop(loop: CountedLoop<unknown>, frame: Frame): void {
  loop.initExec?.(frame);
  if (loop.initRow !== undefined) frame.runtime.steps.step(loop.initRow);
}

export function advanceCountedLoop(loop: CountedLoop<unknown>, frame: Frame): void {
  for (const slot of loop.loopSlots) frame.locals[slot] = new Cell((frame.locals[slot] as Cell).v);
  for (const update of loop.updates) update(frame);
  if (loop.updateRow !== undefined) frame.runtime.steps.step(loop.updateRow);
  frame.runtime.spend();
}

export function loopCompletion(completion: Completion, labels: readonly string[]): Completion | undefined | 'continue' {
  if (completion.kind === 'break') {
    if (completion.label === undefined || labels.includes(completion.label)) return undefined;
    return completion;
  }
  if (completion.kind === 'continue') {
    if (completion.label === undefined || labels.includes(completion.label)) return 'continue';
    return completion;
  }
  return completion;
}

/** A local declared with `var` keeps the type of its initializer, except that `Null` widens to `dynamic`. */
function widenInferred(type: DartType): DartType {
  if (type.kind === 'null') return DYNAMIC;
  if (type.kind === 'typeParam' && type.promoted) return { ...type, promoted: undefined };
  return type;
}

function initialLocalValue(frame: Frame, run: Eval | undefined, isLate: boolean): Value {
  if (isLate) return run ? (new LateInitializer(() => run(frame)) as unknown as Value) : UNINITIALIZED;
  return run ? run(frame) : UNASSIGNED;
}

function isSubtypeOfSame(a: DartType, b: DartType): boolean {
  return isSubtype(b, a) && isSubtype(a, b);
}

function isCreation(compiled: Compiled): boolean {
  return compiled.creates === true;
}

function displayName(name: string): string {
  return name === '<anonymous closure>' ? '' : name;
}

export { makeNullable, resolveBound };

function isBoolType(type: DartType): boolean {
  return type.kind === 'interface' && type.cls === coreTypes.bool && !type.nullable;
}

/** Expressions whose truth tells flow analysis something: comparisons, type tests, negations, and literals. */
function isConditionShaped(expression: Expression): boolean {
  switch (expression.kind) {
    case 'binary': {
      return ['==', '!=', '&&', '||'].includes(expression.operator);
    }
    case 'is':
    case 'bool': {
      return true;
    }
    case 'prefix': {
      return expression.operator === '!';
    }
    case 'parenthesized': {
      return isConditionShaped(expression.expression);
    }
    default: {
      return false;
    }
  }
}

/** What a branch's flow adds to the flow before the condition. */
function storeFlow(flow: Flow, before: Flow): StoredFlow {
  const promotions = [...flow.promotions].filter(([variable, type]) => before.promotions.get(variable) !== type);
  return { reachable: flow.reachable, promotions };
}
