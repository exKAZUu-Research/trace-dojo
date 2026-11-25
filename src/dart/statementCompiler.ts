// code-gauge-allow-file fileNcss -- Keep statement cases together so their flow and compilation state are visible.
import type {
  Block,
  Expression,
  ForInBinding,
  ForInitializer,
  FormalParameter,
  FormalParameters,
  MethodDeclaration,
  PatternDeclaration,
  Span,
  Statement,
  TypeSyntax,
  VariableDeclaration,
} from './ast';
import { assignmentTargets, localNamesIn } from './astWalk';
import { type AwaitRequest, containsAwait, type YieldEachRequest } from './awaitSteps';
import type { CompiledFunction, FunctionSpec } from './callCompiler';
import type { ClassInfo } from './classes';
import { at, type Compiled, type Eval, typeName } from './compilerBase';
import { type CompiledPattern, isRefutableSyntax, PatternCompiler } from './patternCompiler';
import type { Frame } from './runtime';
import { bodyKind, Flow, FunctionContext, type JumpTarget, type LocalVar } from './scope';
import { closeInferenceHoles } from './typeInference';
import {
  coreTypes,
  type DartType,
  DYNAMIC,
  flatten,
  type FunctionType,
  functionType,
  futureValueType,
  interfaceType,
  isNullable,
  isObject,
  isPotentiallyNullable,
  isSubtype,
  isTop,
  iterableElementOf,
  makeNullable,
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
/**
 * A statement of a generator or `async` body, which yields the elements of a `sync*` or `async*` function and the
 * values it awaits as it runs.
 */
export type GenExec = (
  frame: Frame
) => Generator<Value | AwaitRequest | YieldEachRequest, Completion | undefined | void, Value>;

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
  protected abstract compileAsyncBody(spec: FunctionSpec): (frame: Frame) => Value;

  // Functions

  // code-gauge-allow functionCognitiveComplexity -- Parameters, the body, and return-type inference share the closure's flow.
  // code-gauge-allow functionNcss -- Parameters, the body, and return-type inference share the function context.
  compileFunction(spec: FunctionSpec & { isClosure?: boolean }): CompiledFunction {
    const isClosure = spec.isClosure ?? spec.name === '<anonymous closure>';
    const savedFn = this.fn;
    const savedFlow = this.flow;
    const savedRecords = this.recordsSteps;
    const savedAwaitRoot = this.awaitRoot;
    const savedStaging = this.staging;
    this.awaitRoot = undefined;
    this.staging = undefined;
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
    this.flow = isClosure ? savedFlow.forClosure() : Flow.start();
    this.recordsSteps = this.isTracing;
    try {
      this.checkParameterAnnotations(spec.parameters);
      const binders = this.compileParameters(spec);
      const expectedReturn = spec.returnType ?? spec.contextReturnType;
      let run: (frame: Frame) => Value;
      if (spec.kind.isGenerator) {
        run = this.compileGeneratorBody(spec, expectedReturn);
      } else if (spec.kind.isAsync) {
        run = this.compileAsyncBody(spec);
      } else if (spec.body.kind === 'expression') {
        const body = spec.body.expression;
        const compiled = this.compileReturnValue(body, expectedReturn, true);
        const valueRun = compiled.run;
        run = (frame) => valueRun(frame);
      } else {
        const block = this.compileBlock(spec.body.block, false);
        if (this.flow.reachable) {
          fn.returnTypes?.push(NULL);
          if (spec.returnType && this.mustReturnValue(spec.returnType, false)) {
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
      if (fn.returnsValue) {
        for (const bare of fn.contextBareReturns)
          this.error(bare, 'この関数は値を return するので、return にも値が必要です。');
      }
      const returnType = spec.returnType ?? this.inferredReturnType(fn, spec);
      return { fn, returnType, run, bind: binders, usesTypeEnv: true };
    } finally {
      this.fn = savedFn;
      this.flow = isClosure ? savedFlow.forget([], this.localsNamed(assignments.free)) : savedFlow;
      this.recordsSteps = savedRecords;
      this.awaitRoot = savedAwaitRoot;
      this.staging = savedStaging;
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

  /**
   * Whether a function declared to return `declared` must end with a `return` of a value, because `null` is not a
   * value it may complete with: for an `async` one, decided on the value its future completes with (the argument of
   * Future or FutureOr), except that a nullable declaration, as Future<int>?, never requires one.
   */
  protected mustReturnValue(declared: DartType, isAsync: boolean): boolean {
    if (isAsync && isNullable(declared)) return false;
    const type = isAsync && !isObject(declared) ? futureValueType(declared) : declared;
    if (isTop(type) || type.kind === 'null' || isNullable(type)) return false;
    if (type.kind === 'never') return true;
    return !isPotentiallyNullable(type) || type.kind === 'typeParam';
  }

  private inferredReturnType(fn: FunctionContext, spec: FunctionSpec): DartType {
    if (spec.kind.isGenerator) {
      return interfaceType(spec.kind.isAsync ? coreTypes.stream : coreTypes.iterable, [fn.yieldElement ?? DYNAMIC]);
    }
    if (spec.kind.isAsync) return interfaceType(coreTypes.future, [this.inferredFutureValue(fn, spec)]);
    if (spec.contextReturnType?.kind === 'void') return VOID;
    return returnedType(fn, spec.contextReturnType && closeInferenceHoles(spec.contextReturnType));
  }

  /** The type an `async` closure without a declared return type completes its future with. */
  protected inferredFutureValue(fn: FunctionContext, spec: FunctionSpec): DartType {
    const context = spec.contextReturnType && futureValueType(closeInferenceHoles(spec.contextReturnType));
    if (context?.kind === 'void') return VOID;
    return returnedType(fn, context);
  }

  protected inferYieldElement(fn: FunctionContext): DartType {
    let element: DartType | undefined;
    for (const type of fn.yieldTypes ?? []) element = element ? upperBound(element, type) : type;
    return element ?? DYNAMIC;
  }

  /**
   * The type a `return` gives the function's result: the declared return type, or for an `async` function the type
   * its future completes with; undefined for a closure whose return type is inferred.
   */
  protected returnValueType(): DartType | undefined {
    const { returnType, isAsync } = this.fn.kind;
    if (!isAsync) return returnType ?? (this.fn.returnTypes ? undefined : VOID);
    const declared = returnType ?? this.fn.contextReturn;
    return declared ? futureValueType(declared) : undefined;
  }

  /** The value an `async` function returns, which may be a future of the value its own future completes with. */
  protected compileAsyncReturnValue(
    expression: Expression,
    expected: DartType | undefined,
    isArrow: boolean
  ): Compiled {
    const valueType = expected && !isTop(expected) ? expected : undefined;
    const compiled = this.compileExpression(
      expression,
      valueType ? interfaceType(coreTypes.futureOr, [valueType]) : undefined
    );
    const kind = compiled.type.kind;
    if (expected?.kind === 'void' && !isArrow && kind !== 'void' && kind !== 'dynamic' && kind !== 'null') {
      this.error(expression, '戻り値の型が void の関数は、値を返せません。');
    }
    const value = flatten(compiled.type);
    if (valueType && value.kind !== 'dynamic' && !isSubtype(value, valueType)) {
      this.error(expression, `${typeName(compiled.type)} 型の値は、戻り値の型 ${typeName(valueType)} に合いません。`);
    }
    this.fn.returnTypes?.push(value);
    return compiled;
  }

  private compileReturnValue(expression: Expression, expected: DartType | undefined, isArrow: boolean): Compiled {
    const context = expected?.kind === 'void' ? undefined : expected;
    const compiled = this.compileExpression(expression, context);
    const kind = compiled.type.kind;
    if (expected?.kind === 'void' && !isArrow && kind !== 'void' && kind !== 'dynamic' && kind !== 'null') {
      this.error(expression, '戻り値の型が void の関数は、値を返せません。');
    }
    const allowsVoid =
      kind === 'void' && context && (context.kind === 'dynamic' || (this.fn.returnTypes && isTop(context)));
    const returned =
      context && !allowsVoid
        ? this.coerce(compiled, context, expression, (from, to) => `${from} 型の値は、戻り値の型 ${to} に合いません。`)
        : compiled;
    this.fn.returnTypes?.push(returned.type);
    return returned;
  }

  // code-gauge-allow functionCognitiveComplexity -- Positional and named parameters bind alike, each with its covariance check.
  // code-gauge-allow duplicateLines -- Positional and named arguments differ in how presence is checked.
  private compileParameters(spec: FunctionSpec): (frame: Frame, args: Arguments) => void {
    const { parameters } = spec;
    const binders: ((frame: Frame, args: Arguments) => void)[] = [];
    // A covariant parameter, or one typed by its class's type parameter, may receive what a reference of a
    // supertype lets through (`A c = Cat(); c.chase(Animal())`), so it is checked on every call.
    const member = spec.parameterMember;
    for (const [index, parameter] of parameters.positional.entries()) {
      const type = spec.positionalTypes[index] ?? DYNAMIC;
      const { variable, defaultValue } = this.declareParameter(
        parameter,
        type,
        !spec.bodyless && index >= parameters.requiredCount,
        spec.defaults
      );
      binders.push(
        parameterBinder(
          variable.slot,
          defaultValue,
          this.parameterCheck(type, parameter.name),
          parameter.isCovariant ||
            (member?.kind === 'setter' ? member.isCovariant : member?.covariantPositional?.has(index)) === true,
          (args) => (index < args.positional.length ? { value: args.positional[index] } : undefined)
        )
      );
    }
    for (const parameter of parameters.named) {
      const type = spec.namedTypes.get(parameter.argumentName) ?? DYNAMIC;
      const { variable, defaultValue } = this.declareParameter(parameter, type, !spec.bodyless, spec.defaults);
      const { argumentName: name } = parameter;
      binders.push(
        parameterBinder(
          variable.slot,
          defaultValue,
          this.parameterCheck(type, name),
          parameter.isCovariant || (member?.kind === 'method' && member.covariantNamed?.has(name) === true),
          (args) => (args.named?.has(name) ? { value: args.named.get(name) } : undefined)
        )
      );
    }
    const checkArity = this.arityCheck(spec);
    return (frame, args) => {
      if (args.invocation) checkArity(frame, args);
      for (const bind of binders) bind(frame, args);
    };
  }

  /** Declares a parameter as a local, compiling its default value, which must be a constant. */
  private declareParameter(
    parameter: FormalParameter,
    type: DartType,
    requiresDefault: boolean,
    defaults: Map<FormalParameter, Compiled> | undefined
  ): { variable: LocalVar; defaultValue: Eval | undefined } {
    let defaultValue: Eval | undefined;
    const compiled = parameter.defaultValue
      ? this.compileDefaultExpression(parameter.defaultValue, type)
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
      requiresDefault &&
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

  private compileDefaultExpression(expression: Expression, type: DartType): Compiled {
    const savedConstContext = this.inConstContext;
    const savedParameterDefault = this.inParameterDefault;
    this.inConstContext = false;
    this.inParameterDefault = true;
    try {
      return this.compileExpression(expression, type);
    } finally {
      this.inConstContext = savedConstContext;
      this.inParameterDefault = savedParameterDefault;
    }
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
    const namedNames = new Set(parameters.named.map((parameter) => parameter.argumentName));
    const requiredNamed = parameters.named
      .filter((parameter) => parameter.isRequired)
      .map((parameter) => parameter.argumentName);
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
    const capture = this.stepCapture;
    if (capture?.statement === statement) {
      capture.step = { row, onlyCalls };
      return exec;
    }
    return (frame) => frame.runtime.steps.runStatement(row, onlyCalls, () => exec(frame));
  }

  /**
   * The statement whose step its generator records once it completes, since evaluating it again after an `await`
   * must not record it each time.
   */
  protected stepCapture:
    | { statement: object; step: { row: number; onlyCalls: boolean | (() => boolean) } | undefined }
    | undefined;

  // code-gauge-allow duplicateLines -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  // code-gauge-allow functionNcss -- One case per kind of statement.
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
    if (expression.kind === 'throw') return exec;
    return this.withStep(statement, exec, this.onlyCalls(expression, compiled));
  }

  // code-gauge-allow functionCognitiveComplexity -- Bind a declaration, retain its constant or promotion, and emit its step.
  // code-gauge-allow functionNcss -- Keep declarator evaluation order, flow, and trace steps together.
  protected compileLocalDeclaration(declaration: VariableDeclaration, recordStep = true): Exec {
    this.checkAnnotations(declaration.annotations);
    const declaredType = declaration.type ? this.resolveType(declaration.type) : undefined;
    const parts: { slot: number; run: Eval | undefined; isLate: boolean }[] = [];
    const initialized: Compiled[] = [];
    // A later initializer may read an earlier variable after its own parts wait, so each variable is set in a step.
    const setsInSteps = declaration.variables.length > 1 && this.awaitsHere(declaration);
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
      this.flow = this.flow.rememberCondition(variable);
      this.pendingCondition = undefined;
      const part = { slot: variable.slot, run: compiled?.run, isLate: declaration.isLate };
      if (setsInSteps) {
        this.addStep((frame) => {
          frame.locals[part.slot] = new Cell(initialLocalValue(frame, part.run, part.isLate));
          return;
        });
      } else {
        parts.push(part);
      }
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
    if (declaration.isLate)
      return this.compileLateInitializer(declarator.name, initializer, declaredType, declaration.isFinal);
    const savedFlow = this.flow;
    this.pendingCondition = undefined;
    const isCondition =
      !declaration.isConst && (!declaredType || isBoolType(declaredType)) && isConditionShaped(initializer);
    let compiled: Compiled;
    if (isCondition) {
      const result = this.compileConditionInner(initializer);
      compiled = result.compiled;
      this.pendingCondition = {
        whenTrue: result.flow.whenTrue.captureConditionBranch(savedFlow),
        whenFalse: result.flow.whenFalse.captureConditionBranch(savedFlow),
      };
    } else {
      compiled = this.withConstContext(declaration.isConst, () => this.compileExpression(initializer, declaredType));
    }
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

  private compileLateInitializer(
    name: string,
    expression: Expression,
    declaredType: DartType | undefined,
    isFinal: boolean
  ): Compiled {
    // The SDK rejects it too: the initializer runs when the variable is first read, outside any await.
    if (containsAwait(expression))
      return this.error(expression, 'late のローカル変数の初期値には await を書けません。');
    const span = at(expression);
    const compiled = this.compileFunction({
      name,
      span,
      headerEndRow: span.row,
      parameters: { ...span, positional: [], requiredCount: 0, named: [] },
      positionalTypes: [],
      namedTypes: new Map(),
      returnType: undefined,
      contextReturnType: declaredType,
      body: { ...span, kind: 'expression', expression, modifier: 'sync' },
      typeParams: [],
      kind: { ...this.fn.kind, returnType: undefined, isGenerator: false, isAsync: false, isConstructor: false },
      showsThis: this.fn.info.showsThis,
      isClosure: true,
    });
    if (declaredType && declaredType.kind !== 'void' && compiled.returnType.kind === 'void')
      this.error(expression, 'void の値は、ここでは使えません。');
    compiled.fn.info.isAtomic = false;
    const create = this.closureCreator(compiled, functionType([], compiled.returnType));
    return {
      type: declaredType ?? compiled.returnType,
      isConst: false,
      run: (frame) => new LateInitializer(create(frame), isFinal) as unknown as Value,
    };
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

  private compilePatternDeclaration(statement: PatternDeclaration, recordStep = true): Exec {
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
      if (!pattern.match(frame, result)) this.throwPatternMismatch(frame);
      return;
    };
    return recordStep ? this.withStep(statement, exec, false) : exec;
  }

  protected checkParameterAnnotations(parameters: FormalParameters): void {
    for (const parameter of [...parameters.positional, ...parameters.named])
      this.checkAnnotations(parameter.annotations);
  }

  // code-gauge-allow duplicateLines -- Local and top-level functions build the same function spec from different sources.
  private compileLocalFunction(statement: Extract<Statement, { kind: 'localFunction' }>): Exec {
    const { declaration } = statement;
    this.checkAnnotations(declaration.annotations);
    this.checkTypeParameterAnnotations(declaration.typeParameters);
    const typeParams = this.declareTypeParams(declaration.typeParameters);
    const { type, positionalTypes, namedTypes } = this.withTypeParams(typeParams, () =>
      this.signatureOf(declaration.parameters, declaration.returnType, typeParams, { local: true })
    );
    const variable = this.declareLocal(declaration, declaration.name, type, {
      isFinal: true,
      isLate: false,
      isConst: false,
      isParameter: false,
      hasInitializer: true,
    });
    if (!declaration.body) return this.error(declaration, `関数 ${declaration.name} に本体がありません。`);
    const returnType = declaration.returnType ? type.returnType : undefined;
    const compiled = this.withTypeParams(typeParams, () =>
      this.compileFunction({
        name: declaration.name,
        span: declaration,
        headerEndRow: declaration.headerEndRow,
        parameters: declaration.parameters,
        positionalTypes,
        namedTypes,
        returnType,
        contextReturnType: undefined,
        body: declaration.body as NonNullable<typeof declaration.body>,
        typeParams,
        kind: {
          ...this.fn.kind,
          returnType,
          ...bodyKind(declaration.body?.modifier),
          isConstructor: false,
        },
        showsThis: false,
        isClosure: true,
      })
    );
    type.returnType = compiled.returnType;
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
    typeParams: TypeParam[],
    options: { local: true }
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
    let whenFalse = before;
    const { result: consequence, slots } = this.withScope(() => {
      ({ pattern, guard, whenFalse } = this.compileCasePattern(casePattern.pattern, subject, casePattern.guard));
      return compileBody(statement.consequence);
    });
    const afterThen = this.flow;
    this.flow = whenFalse;
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

  protected switchSubject(subject: Compiled, cases: readonly { guard: Expression | undefined }[]): Compiled {
    const roots = new Set<LocalVar>();
    for (let variable = subject.variable; variable; variable = variable.fieldReceiver) roots.add(variable);
    if (roots.size === 0) return subject;
    return cases.some(({ guard }) => guard && this.writtenLocals(guard).some((variable) => roots.has(variable)))
      ? { ...subject, variable: undefined }
      : subject;
  }

  /** Forgets what a loop's body may change before compiling it, as flow analysis does at a loop's start. */
  protected enterLoop(statement: object): void {
    this.flow = this.forgetWrites(this.flow, statement);
  }

  protected writtenLocals(statement: object): LocalVar[] {
    return this.localWrites(assignmentTargets(statement));
  }

  protected forgetWrites(flow: Flow, statement: object): Flow {
    const targets = assignmentTargets(statement);
    return flow.forget(this.localWrites(targets), this.localsNamed(targets.freeCaptured));
  }

  private localsNamed(names: ReadonlySet<string>): LocalVar[] {
    const variables: LocalVar[] = [];
    for (const name of names) {
      const variable = this.findLocal(name);
      if (variable) variables.push(variable);
    }
    return variables;
  }

  private localWrites({ locals, free }: ReturnType<typeof assignmentTargets>): LocalVar[] {
    const variables = this.localsNamed(free);
    for (const [syntax, names] of locals) {
      for (const name of names) {
        const variable = this.findLocal(name);
        if (variable?.syntax === syntax) variables.push(variable);
      }
    }
    return variables;
  }

  // code-gauge-allow duplicateLines -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  private compileWhile(statement: Extract<Statement, { kind: 'while' }>): Exec {
    const labels = this.takeLoopLabels();
    this.enterLoop(statement);
    const { compiled: condition, flow } = this.compileCondition(statement.condition);
    this.flow = flow.whenTrue;
    const body = this.compileLoopBody(statement.body, labels);
    this.finishLoop(flow.whenFalse, this.fn.jumpTargets.pop());
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

  private compileDo(statement: Extract<Statement, { kind: 'do' }>): Exec {
    const { labels, body, test } = this.compileDoPlan(statement, (body, labels) => this.compileLoopBody(body, labels));
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

  protected compileDoPlan<T>(
    statement: Extract<Statement, { kind: 'do' }>,
    compileBody: (body: Statement, labels: string[]) => T
  ): { labels: string[]; body: T; test: Eval } {
    const labels = this.takeLoopLabels();
    this.enterLoop(statement);
    const body = compileBody(statement.body, labels);
    const target = this.fn.jumpTargets.pop();
    const breakFlow = target?.breakFlow;
    if (target?.continueFlow) this.flow = Flow.join(this.flow, target.continueFlow);
    const { compiled: condition, flow } = this.compileCondition(statement.condition);
    this.flow = breakFlow ? Flow.join(flow.whenFalse, breakFlow) : flow.whenFalse;
    return { labels, body, test: condition.run };
  }

  protected enterJumpTarget(kind: JumpTarget['kind'], labels: string[]): void {
    this.fn.jumpTargets.push({ kind, labels });
  }

  protected finishLoop(exit: Flow, target?: JumpTarget): void {
    const after = target?.breakFlow ? Flow.join(exit, target.breakFlow) : exit;
    const bodyTests = target?.continueFlow ? this.flow.inheritTypeTests(target.continueFlow) : this.flow;
    this.flow = after.inheritTypeTests(bodyTests);
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

  private compileFor(statement: Extract<Statement, { kind: 'for' }>): Exec {
    const labels = this.takeLoopLabels();
    const { result, slots } = this.withScope(() => {
      const { initExec, loopSlots, initRow } = this.compileForInit(statement);
      this.enterLoop(statement);
      const { compiled: condition, flow } = statement.condition
        ? this.compileCondition(statement.condition)
        : { compiled: undefined, flow: { whenTrue: this.flow, whenFalse: this.flow.unreachable } };
      this.flow = flow.whenTrue;
      const body = this.compileLoopBody(statement.body, labels);
      const target = this.fn.jumpTargets.pop();
      if (target?.continueFlow) this.flow = Flow.join(this.flow, target.continueFlow);
      const updates = statement.updates.map((update) => this.compileExpression(update).run);
      const updateRow = updates.length > 0 ? this.stepRowOf(statement) : undefined;
      this.finishLoop(flow.whenFalse, target);
      return forLoop({
        initExec,
        initRow,
        test: condition?.run,
        body,
        labels,
        loopSlots,
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

  protected compileForInit(loop: { init: ForInitializer; row: number }): {
    initExec: Exec | undefined;
    loopSlots: number[];
    initRow: number | undefined;
  } {
    const { init } = loop;
    if (!init) return { initExec: undefined, loopSlots: [], initRow: undefined };
    if (Array.isArray(init)) {
      const runs = init.map((expression) => this.compileExpression(expression).run);
      return {
        initExec: (frame) => {
          for (const run of runs) run(frame);
          return;
        },
        loopSlots: [],
        initRow: runs.length > 0 ? this.stepRowOf(loop) : undefined,
      };
    }
    const slots = this.fn.scopes.at(-1)?.slots;
    const start = slots?.length ?? 0;
    const initExec =
      init.kind === 'patternDeclaration'
        ? this.compilePatternDeclaration(init, false)
        : this.compileLocalDeclaration(init, false);
    const recordsStep = init.kind === 'patternDeclaration' || init.variables.some((variable) => variable.initializer);
    return { initExec, loopSlots: slots?.slice(start) ?? [], initRow: recordsStep ? this.stepRowOf(loop) : undefined };
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
      this.finishLoop(before, this.fn.jumpTargets.pop());
      return this.forInLoop(this.iterableSource(iterable), bind, body, labels);
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

  protected iterableSource(iterable: Compiled, nullAware = false): Eval {
    if (iterable.type.kind !== 'dynamic') return iterable.run;
    const target = interfaceType(coreTypes.iterable, [DYNAMIC]);
    return this.runtimeCast(iterable.run, nullAware ? makeNullable(target) : target, false);
  }

  /** Compiles a for-in loop's binding, which records a step for values learners write down. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch is one of the cases Dart distinguishes for this construct.
  // code-gauge-allow functionNcss -- One case per form of the construct, which reads best together.
  protected compileForInBinding(
    binding: ForInBinding,
    elementType: DartType,
    statement: { row: number }
  ): (frame: Frame, value: Value) => void {
    const row = this.stepRowOf(statement);
    if (binding.kind !== 'identifier') this.checkAnnotations(binding.annotations);
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
          if (!pattern.match(frame, value)) this.throwPatternMismatch(frame);
          frame.runtime.steps.stepBinding(row, true);
        };
      }
    }
  }

  /** Runs a for-in loop over an iterable through its iterator, as Dart does. */
  // code-gauge-allow duplicateLines -- A for-in statement and a sync* yield* iterate an Iterable alike; one runs a body, the other yields.
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
    // The Dart VM attaches labeled continues to the label wrapper instead of the loop's flow context.
    if (target && (kind === 'break' || label === undefined)) {
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
      if (statement.value) {
        const modifier = this.fn.kind.isAsync ? 'async*' : 'sync*';
        this.error(statement, `${modifier} の関数では、値を return できません。yield を使ってください。`);
      }
      this.flow = this.flow.unreachable;
      const done: Completion = { kind: 'return', value: undefined };
      return () => done;
    }
    const expected = this.returnValueType();
    if (!statement.value) {
      this.fn.returnTypes?.push(NULL);
      if (expected) this.checkBareReturn(statement, expected);
      this.flow = this.flow.unreachable;
      const completion: Completion = { kind: 'return', value: undefined };
      return () => completion;
    }
    if (this.fn.kind.isConstructor) this.error(statement, 'コンストラクタからは値を返せません。');
    this.fn.returnsValue = true;
    const compiled = this.fn.kind.isAsync
      ? this.compileAsyncReturnValue(statement.value, expected, false)
      : this.compileReturnValue(statement.value, expected ?? this.fn.contextReturn, false);
    this.flow = this.flow.unreachable;
    const { run } = compiled;
    return (frame) => ({ kind: 'return', value: run(frame) });
  }

  /** Rejects `return;` where the function's value type requires a value. */
  private checkBareReturn(statement: Span, expected: DartType): void {
    if (expected.kind === 'void' || expected.kind === 'dynamic' || expected.kind === 'null') return;
    if (this.fn.kind.isConstructor) return;
    // A function literal's return type comes from its context, which `return;` fits when it allows null.
    if (this.fn.kind.returnType === undefined && isNullable(expected)) this.fn.contextBareReturns.push(statement);
    else this.error(statement, `戻り値の型が ${typeName(expected)} なので、return に値が必要です。`);
  }

  /** The slots holding the exceptions of the catch clauses being compiled, innermost last. */
  protected readonly rethrowSlots: number[] = [];

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
    // `dart run` runs without --enable-asserts, which skips assertions, so the steps of their awaits never run.
    const {
      result: { flow },
    } = this.compileWithSteps(statement, () => this.compileCondition(statement.condition));
    this.flow = flow.whenFalse;
    if (statement.message)
      this.compileWithSteps(statement, () => this.compileExpression(statement.message as Expression));
    this.flow = before.inheritTypeTests(flow.whenTrue).inheritTypeTests(flow.whenFalse);
    return () => {};
  }

  // Generators

  /** Creates the iterable a `sync*` function returns, which runs a new copy of the body for each iterator. */
  protected abstract makeSyncStarIterable(frame: Frame, elementType: DartType, body: GenExec): Value;
}

/** Whether a method overrides one whose parameter at the position or of the name is `covariant`, making it so. */
// code-gauge-allow functionCognitiveComplexity -- Check visibility and variance together during inheritance traversal.
export function inheritsCovariance(
  cls: ClassInfo,
  methodName: string,
  parameterName: string,
  index: number | undefined,
  setter = false,
  library = (cls.mixinOf ?? cls).library
): boolean {
  for (const { cls: supertype } of cls.directSupertypes) {
    const source = supertype.mixinOf ?? supertype;
    const visible = !methodName.startsWith('_') || source.library === library;
    const field = visible && setter ? supertype.setters.get(methodName) : undefined;
    if (field?.kind === 'field' && field.isCovariant) return true;
    const method = (visible ? source.declaration : undefined)?.members.find(
      (member): member is MethodDeclaration =>
        member.kind === 'method' && member.name === methodName && (member.methodKind === 'setter') === setter
    );
    const parameter =
      index === undefined
        ? method?.parameters.named.find((named) => named.name === parameterName)
        : method?.parameters.positional[index];
    if (parameter?.isCovariant || inheritsCovariance(supertype, methodName, parameterName, index, setter, library))
      return true;
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
      if ((args.invocation || alwaysChecks) && check) check(frame, value);
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
  copyLoopVariables(loop, frame);
  runLoopUpdates(loop, frame);
}

/** Gives the next iteration its own loop variables, before the updates run, so that closures keep this one's. */
export function copyLoopVariables(loop: CountedLoop<unknown>, frame: Frame): void {
  for (const slot of loop.loopSlots) frame.locals[slot] = new Cell((frame.locals[slot] as Cell).v);
}

export function runLoopUpdates(loop: CountedLoop<unknown>, frame: Frame): void {
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

/**
 * The return type a closure infers from what it returns, which is the context's when the returned types do not fit
 * it, as the SDK infers function literals.
 */
function returnedType(fn: FunctionContext, context: DartType | undefined): DartType {
  let result: DartType | undefined;
  for (const type of fn.returnTypes ?? []) result = result ? upperBound(result, type) : type;
  const returned = result ?? NEVER;
  return context && !isSubtype(returned, context) ? context : returned;
}

/** A local declared with `var` keeps the type of its initializer, except that `Null` widens to `dynamic`. */
function widenInferred(type: DartType): DartType {
  if (type.kind === 'null') return DYNAMIC;
  if (type.kind === 'typeParam' && type.promoted) return { ...type, promoted: undefined };
  return type;
}

function initialLocalValue(frame: Frame, run: Eval | undefined, isLate: boolean): Value {
  return run ? run(frame) : isLate ? UNINITIALIZED : UNASSIGNED;
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

function isConditionShaped(expression: Expression): boolean {
  switch (expression.kind) {
    case 'binary': {
      return ['==', '!=', '&&', '||'].includes(expression.operator);
    }
    case 'is':
    case 'identifier':
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
