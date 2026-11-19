import type {
  Block,
  CatchClause,
  Expression,
  ForInBinding,
  FormalParameter,
  FormalParameters,
  Pattern,
  Statement,
  SwitchCase,
  TypeSyntax,
  VariableDeclaration,
} from './ast';
import { assignedNames, namesAssignedIn } from './astWalk';
import type { CompiledFunction, FunctionSpec } from './callCompiler';
import { type Compiled, type Eval, typeName } from './compilerBase';
import { checkExhaustive } from './exhaustiveness';
import { SHORTED } from './expressionCompiler';
import { type CompiledPattern, PatternCompiler } from './patternCompiler';
import { DartThrow, type Frame } from './runtime';
import { type ConditionFlow, Flow, FunctionContext, type LocalVar } from './scope';
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
  NEVER,
  nonNullable,
  NULL,
  resolveBound,
  type TypeParam,
  typeToString as typeToStringImpl,
  upperBound,
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

const BREAK: Completion = { kind: 'break', label: undefined };
const CONTINUE: Completion = { kind: 'continue', label: undefined };

/** Types whose values learners write down in a trace, whose for-in bindings always record a step. */
function isAnsweredType(type: DartType): boolean {
  const base = nonNullable(type);
  if (base.kind !== 'interface') return false;
  return [coreTypes.int, coreTypes.double, coreTypes.num, coreTypes.bool, coreTypes.string].includes(base.cls);
}

export abstract class StatementCompiler extends PatternCompiler {
  /** Whether `expression` only calls functions or creates objects, whose own steps show what it did. */
  protected abstract onlyCalls(expression: Expression, compiled: Compiled): boolean;

  // Functions

  // code-gauge-allow functionCognitiveComplexity 40 -- Parameters, the body, and return-type inference.
  compileFunction(spec: FunctionSpec & { isClosure?: boolean }): CompiledFunction {
    const isClosure = spec.isClosure ?? spec.name === '<anonymous closure>';
    const savedFn = this.fn;
    const savedFlow = this.flow;
    const savedRecords = this.recordsSteps;
    const isAtomic = this.atomicRows !== undefined && this.isAtomicHeader(spec.span.row, spec.headerEndRow);
    const info = this.newFunctionInfo(spec.name, undefined, spec.showsThis);
    info.isAtomic = isAtomic;
    const fn = new FunctionContext(isClosure ? savedFn : undefined, info, spec.kind);
    const names = assignedNames(spec.body);
    fn.assignedNames = names.all;
    fn.closureAssignedNames = names.inClosures;
    if (spec.returnType === undefined) fn.returnTypes = [];
    if (spec.kind.isGenerator) fn.yieldTypes = [];
    fn.contextReturn = spec.contextReturnType;
    this.fn = fn;
    this.flow = Flow.start();
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
    this.fn.returnTypes?.push(compiled.type);
    if (!expected) return compiled;
    if (expected.kind === 'void') {
      if (!isArrow && !isTop(compiled.type) && compiled.type.kind !== 'null' && !(compiled.type.kind === 'never')) {
        this.error(expression, `戻り値の型が void の関数 ${displayName(spec.name)} は、値を返せません。`);
      }
      return compiled;
    }
    if (compiled.type.kind === 'void' && !isTop(expected)) {
      this.error(expression, 'void の値は返せません。');
    }
    return this.coerce(
      compiled,
      expected,
      expression,
      (from, to) => `${from} 型の値は、戻り値の型 ${to} に合いません。`
    );
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Positional, optional, and named parameters with defaults.
  private compileParameters(spec: FunctionSpec): (frame: Frame, args: Arguments) => void {
    const { parameters } = spec;
    const binders: ((frame: Frame, args: Arguments) => void)[] = [];
    const declare = (
      parameter: FormalParameter,
      type: DartType,
      isOptional: boolean
    ): { variable: LocalVar; defaultValue: Eval | undefined } => {
      let defaultValue: Eval | undefined;
      if (parameter.defaultValue) {
        const compiled = this.withConstContext(true, () =>
          this.compileExpression(parameter.defaultValue as Expression, type)
        );
        if (!compiled.isConst) this.error(parameter.defaultValue, '引数の既定値には、定数を書いてください。');
        defaultValue = this.coerce(
          compiled,
          type,
          parameter.defaultValue,
          (from, to) => `${from} 型の既定値は、${to} 型の引数 ${parameter.name} に合いません。`
        ).run;
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
    };
    const checkFor = (type: DartType, name: string): ((frame: Frame, value: Value) => void) | undefined => {
      if (isTop(type)) return undefined;
      const resolve = this.runtimeType(type);
      return (frame, value) => {
        const expected = resolve(frame);
        if (!this.valueIsAt(frame, value, expected)) {
          frame.runtime.throwTypeError(
            `type '${typeToStringOf(frame.runtime.runtimeTypeOf(value))}' is not a subtype of type '${typeToStringOf(expected)}' of '${name}'`
          );
        }
      };
    };
    for (const [index, parameter] of parameters.positional.entries()) {
      const type = spec.positionalTypes[index] ?? DYNAMIC;
      const isOptional = index >= parameters.requiredCount;
      const { variable, defaultValue } = declare(parameter, type, isOptional);
      const { slot } = variable;
      const check = checkFor(type, parameter.name);
      binders.push((frame, args) => {
        let value: Value;
        if (index < args.positional.length) {
          value = args.positional[index];
          if (args.isDynamic && check) check(frame, value);
        } else {
          value = defaultValue ? defaultValue(frame) : undefined;
        }
        frame.locals[slot] = new Cell(value);
      });
    }
    for (const parameter of parameters.named) {
      const type = spec.namedTypes.get(parameter.name) ?? DYNAMIC;
      const { variable, defaultValue } = declare(parameter, type, true);
      const { slot } = variable;
      const { name } = parameter;
      const check = checkFor(type, name);
      binders.push((frame, args) => {
        let value: Value;
        if (args.named?.has(name)) {
          value = args.named.get(name);
          if (args.isDynamic && check) check(frame, value);
        } else {
          value = defaultValue ? defaultValue(frame) : undefined;
        }
        frame.locals[slot] = new Cell(value);
      });
    }
    const count = parameters.positional.length;
    const required = parameters.requiredCount;
    const namedNames = new Set(parameters.named.map((parameter) => parameter.name));
    const requiredNamed = parameters.named
      .filter((parameter) => parameter.isRequired)
      .map((parameter) => parameter.name);
    return (frame, args) => {
      if (args.isDynamic) {
        const positional = args.positional.length;
        const unknown = [...(args.named?.keys() ?? [])].some((name) => !namedNames.has(name));
        const missing = requiredNamed.some((name) => !args.named?.has(name));
        if (positional < required || positional > count || unknown || missing) {
          frame.runtime.noSuchMethod(frame.receiver, spec.name, 'method', args);
        }
      }
      for (const bind of binders) bind(frame, args);
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

  // code-gauge-allow functionNcss 80 -- One case per kind of statement.
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
      case 'empty': {
        return () => {};
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

  // code-gauge-allow functionCognitiveComplexity 30 -- Each kind of local declaration differs in what it checks.
  protected compileLocalDeclaration(declaration: VariableDeclaration, recordStep = true): Exec {
    const declaredType = declaration.type ? this.resolveType(declaration.type) : undefined;
    const parts: { slot: number; run: Eval | undefined; isLate: boolean }[] = [];
    const initialized: { compiled: Compiled; expression: Expression }[] = [];
    for (const declarator of declaration.variables) {
      const { initializer } = declarator;
      if (declaration.isConst && !initializer)
        this.error(declarator, `const の変数 ${declarator.name} には、初期値が必要です。`);
      if (declaration.isFinal && !initializer && !declaration.isLate && !declaredType && !this.isLibraryCode) {
        // `final x;` is allowed and assigned later, with the type inferred as dynamic.
      }
      let compiled: Compiled | undefined;
      if (initializer) {
        const isLateInitializer = declaration.isLate;
        const savedFlow = this.flow;
        compiled = this.withConstContext(declaration.isConst, () => this.compileExpression(initializer, declaredType));
        if (isLateInitializer) this.flow = savedFlow;
        if (declaration.isConst && !compiled.isConst)
          this.error(initializer, `const の変数 ${declarator.name} の初期値は、定数でなければなりません。`);
        if (declaredType) {
          compiled = this.coerce(
            compiled,
            declaredType,
            initializer,
            (from, to) => `${from} 型の値は、${to} 型の変数 ${declarator.name} に代入できません。`
          );
        } else if (compiled.type.kind === 'void') {
          this.error(initializer, 'void の値は変数に代入できません。');
        }
        initialized.push({ compiled, expression: initializer });
      }
      let type = declaredType ?? (compiled ? widenInferred(compiled.type) : DYNAMIC);
      if (!declaredType && compiled?.type.kind === 'null') type = DYNAMIC;
      const variable = this.declareLocal(declarator, declarator.name, type, {
        isFinal: declaration.isFinal || declaration.isConst,
        isLate: declaration.isLate,
        isConst: declaration.isConst,
        isParameter: false,
        hasInitializer: initializer !== undefined,
      });
      if (declaration.isConst && compiled?.constValue) {
        variable.constant = compiled.constValue.value;
        variable.hasConstant = true;
      }
      if (compiled && !declaration.isLate) {
        this.flow = this.flow.assign(variable);
        if (
          declaredType &&
          compiled.type.kind !== 'dynamic' &&
          !isSubtypeOfSame(compiled.type, declaredType) &&
          this.isPromotable(variable)
        ) {
          const promoted = nonNullable(declaredType);
          if (isNullable(declaredType) && isSubtype(compiled.type, promoted))
            this.flow = this.flow.promote(variable, promoted);
        }
      }
      parts.push({ slot: variable.slot, run: compiled?.run, isLate: declaration.isLate });
    }
    const exec: Exec = (frame) => {
      for (const { slot, run, isLate } of parts) {
        let value: Value;
        if (isLate) value = run ? (new LateInitializer(() => run(frame)) as unknown as Value) : UNINITIALIZED;
        else value = run ? run(frame) : UNASSIGNED;
        frame.locals[slot] = new Cell(value);
      }
      return;
    };
    if (initialized.length === 0 || !recordStep || declaration.isLate) return exec;
    return this.withStep(
      declaration,
      exec,
      initialized.every(({ compiled }) => isCreation(compiled))
    );
  }

  private compilePatternDeclaration(statement: Extract<Statement, { kind: 'patternDeclaration' }>): Exec {
    const value = this.compileExpression(statement.value, this.patternContextType(statement.pattern));
    const pattern = this.compilePattern(statement.pattern, value.type, { mode: 'declare', isFinal: statement.isFinal });
    if (!pattern.irrefutable)
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
    const subject = this.compileExpression(statement.condition);
    const casePattern = statement.casePattern as NonNullable<typeof statement.casePattern>;
    const before = this.flow;
    let pattern!: CompiledPattern;
    let guard: Eval | undefined;
    let guardFlow: ConditionFlow | undefined;
    const { result: consequence, slots } = this.withScope(() => {
      pattern = this.compilePattern(casePattern.pattern, subject.type, { mode: 'match', isFinal: false });
      for (const variable of pattern.variables.values()) this.flow = this.flow.assign(variable);
      if (casePattern.guard) {
        const compiledGuard = this.compileCondition(casePattern.guard);
        guard = compiledGuard.compiled.run;
        guardFlow = compiledGuard.flow;
        this.flow = guardFlow.whenTrue;
      }
      return this.compileScoped(statement.consequence);
    });
    const afterThen = this.flow;
    this.flow = before;
    const otherwise = statement.alternative ? this.compileScoped(statement.alternative) : undefined;
    this.flow = Flow.join(afterThen, this.flow);
    const test = subject.run;
    return (frame) => {
      const value = test(frame);
      let matched: boolean;
      try {
        matched = pattern.match(frame, value) && (!guard || guard(frame) === true);
        if (matched) return consequence(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
      return otherwise?.(frame);
    };
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
    const names = namesAssignedIn(statement);
    const variables: LocalVar[] = [];
    for (const name of names) {
      const variable = this.findLocal(name);
      if (variable) variables.push(variable);
    }
    this.flow = this.flow.forget(variables);
  }

  private compileWhile(statement: Extract<Statement, { kind: 'while' }>): Exec {
    const labels = this.takeLoopLabels();
    this.enterLoop(statement);
    const { compiled: condition, flow } = this.compileCondition(statement.condition);
    this.flow = flow.whenTrue;
    const body = this.compileLoopBody(statement.body, labels);
    this.flow = Flow.join(flow.whenFalse, this.breakFlows.pop() ?? flow.whenFalse.unreachable);
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
    const labels = this.takeLoopLabels();
    this.enterLoop(statement);
    const body = this.compileLoopBody(statement.body, labels);
    const breakFlow = this.breakFlows.pop();
    this.flow = Flow.join(this.flow, this.continueFlow ?? this.flow.unreachable);
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

  /** The flow at the `break`s of the loops being compiled, which joins the flow after each loop. */
  protected readonly breakFlows: (Flow | undefined)[] = [];
  protected continueFlow: Flow | undefined;
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
    this.breakFlows.push(undefined);
    const savedContinue = this.continueFlow;
    this.continueFlow = undefined;
    try {
      const exec = this.compileScoped(body);
      this.continueFlow = this.continueFlow ? Flow.join(this.continueFlow, this.flow) : this.flow;
      return exec;
    } finally {
      this.fn.loopDepth--;
      this.fn.labels.splice(this.fn.labels.length - labels.length, labels.length);
      void savedContinue;
    }
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- The parts of a for loop each record steps differently.
  private compileFor(statement: Extract<Statement, { kind: 'for' }>): Exec {
    const labels = this.takeLoopLabels();
    const { result, slots } = this.withScope(() => {
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
      const initRow = initRecords ? this.stepRowOf(statement) : undefined;
      this.enterLoop(statement);
      const { compiled: condition, flow } = statement.condition
        ? this.compileCondition(statement.condition)
        : { compiled: undefined, flow: { whenTrue: this.flow, whenFalse: this.flow.unreachable } };
      this.flow = flow.whenTrue;
      const body = this.compileLoopBody(statement.body, labels);
      const breakFlow = this.breakFlows.pop();
      this.flow = this.continueFlow ? Flow.join(this.flow, this.continueFlow) : this.flow;
      const updates = statement.updates.map((update) => this.compileExpression(update).run);
      const updateRow = updates.length > 0 ? this.stepRowOf(statement) : undefined;
      this.flow = breakFlow ? Flow.join(flow.whenFalse, breakFlow) : flow.whenFalse;
      const test = condition?.run;
      const capturedLoopVariables = loopVariables.map((variable) => variable.slot);
      return (frame: Frame): Completion | undefined => {
        if (initExec) initExec(frame);
        if (initRow !== undefined) frame.runtime.steps.step(initRow);
        for (;;) {
          if (test && !test(frame)) return undefined;
          const completion = body(frame);
          if (completion) {
            const outcome = loopCompletion(completion, labels);
            if (outcome !== 'continue') return outcome;
          }
          // Each iteration has its own loop variables, which closures created in the body keep.
          for (const slot of capturedLoopVariables) frame.locals[slot] = new Cell((frame.locals[slot] as Cell).v);
          for (const update of updates) update(frame);
          if (updateRow !== undefined) frame.runtime.steps.step(updateRow);
          frame.runtime.spend();
        }
      };
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

  private compileForIn(statement: Extract<Statement, { kind: 'forIn' }>): Exec {
    const labels = this.takeLoopLabels();
    const iterable = this.compileExpression(statement.iterable);
    const elementType = this.elementTypeOfIterable(iterable, statement.iterable);
    const { result, slots } = this.withScope(() => {
      this.enterLoop(statement);
      const bind = this.compileForInBinding(statement.binding, elementType, statement);
      const before = this.flow;
      const body = this.compileLoopBody(statement.body, labels);
      const breakFlow = this.breakFlows.pop();
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
        const variable = this.findLocal(binding.name);
        if (!variable) {
          return this.error(binding, `${binding.name} という変数はありません。`);
        }
        if (variable.options.isFinal) this.error(binding, `final の変数 ${binding.name} には代入できません。`);
        const cell = this.cellAccess(variable);
        const answered = isAnsweredType(variable.type);
        return (frame, value) => {
          cell(frame).v = value;
          frame.runtime.steps.stepBinding(row, answered);
        };
      }
      case 'pattern': {
        const pattern = this.compilePattern(binding.pattern, elementType, {
          mode: 'declare',
          isFinal: binding.isFinal,
        });
        if (!pattern.irrefutable)
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

  // code-gauge-allow functionCognitiveComplexity 40 -- Cases with patterns, guards, labels, and exhaustiveness.
  private compileSwitch(statement: Extract<Statement, { kind: 'switch' }>): Exec {
    const labels = this.takeLoopLabels();
    const subject = this.compileExpression(statement.subject);
    const before = this.flow;
    this.fn.switchDepth++;
    for (const label of labels) this.fn.labels.push({ name: label, isLoop: false, isSwitchCase: false });
    const caseLabels = statement.cases.flatMap((switchCase) => switchCase.labels);
    for (const label of caseLabels) this.fn.labels.push({ name: label, isLoop: false, isSwitchCase: true });
    this.breakFlows.push(undefined);
    const groups = groupCases(statement.cases);
    let after: Flow | undefined;
    const compiledGroups: {
      matchers: { pattern: CompiledPattern | undefined; guard: Eval | undefined }[];
      body: Exec;
      slots: number[];
      labels: string[];
    }[] = [];
    try {
      for (const group of groups) {
        this.flow = before;
        const { result, slots } = this.withScope(() => {
          const matchers = group.cases.map((switchCase) => this.compileCaseHead(switchCase, subject.type, before));
          let joined = matchers[0].flow;
          for (const matcher of matchers.slice(1)) joined = Flow.join(joined, matcher.flow);
          this.flow = joined;
          if (group.cases.length > 1)
            this.checkSharedCaseVariables(
              group.cases,
              matchers.map((matcher) => matcher.pattern)
            );
          const body = this.compileStatements(group.statements);
          if (this.flow.reachable && group !== groups.at(-1) && group.statements.length > 0) {
            // A case body may end without `break`; Dart then leaves the switch.
          }
          return { matchers: matchers.map(({ pattern, guard }) => ({ pattern, guard })), body };
        });
        after = after ? Flow.join(after, this.flow) : this.flow;
        compiledGroups.push({ ...result, slots, labels: group.labels });
      }
    } finally {
      this.fn.switchDepth--;
      this.fn.labels.splice(
        this.fn.labels.length - labels.length - caseLabels.length,
        labels.length + caseLabels.length
      );
    }
    const breakFlow = this.breakFlows.pop();
    const hasDefault = statement.cases.some((switchCase) => switchCase.pattern === undefined);
    const exhaustive =
      hasDefault ||
      checkExhaustive(
        this,
        subject.type,
        statement.cases
          .filter((switchCase) => switchCase.guard === undefined)
          .map((switchCase) => switchCase.pattern as Pattern),
        statement,
        true
      );
    if (!exhaustive) after = after ? Flow.join(after, before) : before;
    if (statement.cases.length === 0) after = before;
    this.flow = breakFlow ? Flow.join(after ?? before.unreachable, breakFlow) : (after ?? before);
    const test = subject.run;
    return (frame) => {
      const value = test(frame);
      frame.temporaries.push(value);
      let index = -1;
      try {
        for (const [groupIndex, group] of compiledGroups.entries()) {
          for (const matcher of group.matchers) {
            if (!matcher.pattern) {
              index = groupIndex;
              break;
            }
            if (matcher.pattern.match(frame, value) && (!matcher.guard || matcher.guard(frame) === true)) {
              index = groupIndex;
              break;
            }
          }
          if (index >= 0) break;
          for (const slot of group.slots) frame.locals[slot] = undefined;
        }
      } finally {
        frame.temporaries.pop();
      }
      while (index >= 0) {
        const group = compiledGroups[index];
        let completion: Completion | undefined;
        try {
          completion = group.body(frame);
        } finally {
          for (const slot of group.slots) frame.locals[slot] = undefined;
        }
        if (!completion) return;
        if (completion.kind === 'break' && (completion.label === undefined || labels.includes(completion.label)))
          return;
        if (completion.kind === 'continue' && completion.label !== undefined) {
          const target = compiledGroups.findIndex((other) => other.labels.includes(completion.label as string));
          if (target !== -1) {
            index = target;
            continue;
          }
        }
        return completion;
      }
      return;
    };
  }

  private compileCaseHead(
    switchCase: SwitchCase,
    subjectType: DartType,
    before: Flow
  ): { pattern: CompiledPattern | undefined; guard: Eval | undefined; flow: Flow } {
    this.flow = before;
    if (!switchCase.pattern) return { pattern: undefined, guard: undefined, flow: before };
    const pattern = this.compilePattern(switchCase.pattern, subjectType, { mode: 'match', isFinal: false });
    for (const variable of pattern.variables.values()) this.flow = this.flow.assign(variable);
    let guard: Eval | undefined;
    if (switchCase.guard) {
      const compiled = this.compileCondition(switchCase.guard);
      guard = compiled.compiled.run;
      this.flow = compiled.flow.whenTrue;
    }
    return { pattern, guard, flow: this.flow };
  }

  /** Cases that share a body must declare the same variables, which the body may then use. */
  private checkSharedCaseVariables(cases: SwitchCase[], patterns: (CompiledPattern | undefined)[]): void {
    const first = patterns[0]?.variables;
    for (const [index, pattern] of patterns.entries()) {
      const names = [...(pattern?.variables.keys() ?? [])].toSorted().join(',');
      if (names !== [...(first?.keys() ?? [])].toSorted().join(',')) {
        // Variables not declared by every case are not in scope in the shared body; Dart reports uses of them.
        void cases[index];
      }
    }
  }

  private compileJump(statement: Extract<Statement, { kind: 'break' | 'continue' }>): Exec {
    const { label } = statement;
    if (statement.kind === 'break') {
      if (label === undefined && this.fn.loopDepth === 0 && this.fn.switchDepth === 0) {
        this.error(statement, 'break はループや switch の中にしか書けません。');
      }
      if (label !== undefined && !this.fn.labels.some((entry) => entry.name === label && !entry.isSwitchCase)) {
        this.error(statement, `ラベル ${label} が見つかりません。`);
      }
      const index = this.breakFlows.length - 1;
      if (index >= 0)
        this.breakFlows[index] = this.breakFlows[index]
          ? Flow.join(this.breakFlows[index] as Flow, this.flow)
          : this.flow;
      this.flow = this.flow.unreachable;
      const completion: Completion = label === undefined ? BREAK : { kind: 'break', label };
      return () => completion;
    }
    if (label === undefined && this.fn.loopDepth === 0)
      this.error(statement, 'continue はループの中にしか書けません。');
    if (label !== undefined) {
      const entry = this.fn.labels.findLast((candidate) => candidate.name === label);
      if (!entry) this.error(statement, `ラベル ${label} が見つかりません。`);
      if (!entry.isLoop && !entry.isSwitchCase)
        this.error(statement, `ラベル ${label} はループに付いていないので、continue では使えません。`);
    }
    this.continueFlow = this.continueFlow ? Flow.join(this.continueFlow, this.flow) : this.flow;
    this.flow = this.flow.unreachable;
    const completion: Completion = label === undefined ? CONTINUE : { kind: 'continue', label };
    return () => completion;
  }

  private compileReturn(statement: Extract<Statement, { kind: 'return' }>): Exec {
    if (this.fn.kind.isGenerator)
      this.error(statement, 'sync* の関数では、値を return できません。yield を使ってください。');
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
    const context = expected && expected.kind !== 'void' ? expected : undefined;
    const compiled = this.compileExpression(value, context ?? this.closureContextReturn());
    this.fn.returnTypes?.push(compiled.type);
    if (!expected) {
      const contextReturn = this.closureContextReturn();
      if (contextReturn && contextReturn.kind !== 'void') {
        return this.coerce(
          compiled,
          contextReturn,
          value,
          (from, to) => `${from} 型の値は、戻り値の型 ${to} に合いません。`
        );
      }
      return compiled;
    }
    if (expected.kind === 'void') {
      if (!isTop(compiled.type) && compiled.type.kind !== 'null')
        this.error(value, '戻り値の型が void の関数は、値を返せません。');
      return compiled;
    }
    if (compiled.type.kind === 'void') this.error(value, 'void の値は返せません。');
    return this.coerce(compiled, expected, value, (from, to) => `${from} 型の値は、戻り値の型 ${to} に合いません。`);
  }

  /** The return type a closure's context expects, which its returns are checked against. */
  protected closureContextReturn(): DartType | undefined {
    return this.fn.contextReturn;
  }

  // code-gauge-allow functionCognitiveComplexity 40 -- on/catch clauses, rethrow, and finally.
  private compileTry(statement: Extract<Statement, { kind: 'try' }>): Exec {
    const before = this.flow;
    const body = this.compileBlock(statement.body);
    let after = this.flow;
    const catches = statement.catches.map((clause) => {
      this.flow = Flow.join(before, after).forget([]);
      const compiled = this.compileCatch(clause);
      after = Flow.join(after, this.flow);
      return compiled;
    });
    let finallyExec: Exec | undefined;
    if (statement.finally) {
      const flowAfterTry = after;
      this.flow = Flow.join(before, after);
      finallyExec = this.compileBlock(statement.finally);
      this.flow = this.flow.reachable ? flowAfterTry : this.flow;
    } else {
      this.flow = after;
    }
    const tryCatch: Exec =
      catches.length === 0
        ? body
        : (frame) => {
            const mark = frame.temporaries.length;
            try {
              return body(frame);
            } catch (error) {
              if (!(error instanceof DartThrow)) throw error;
              frame.temporaries.length = mark;
              for (const handler of catches) {
                if (handler.matches(frame, error.value)) return handler.run(frame, error);
              }
              throw error;
            }
          };
    if (!finallyExec) return tryCatch;
    const runFinally = finallyExec;
    return (frame) => {
      let completion: Completion | undefined;
      try {
        completion = tryCatch(frame);
      } catch (error) {
        if (!(error instanceof DartThrow)) throw error;
        const finallyCompletion = runFinally(frame);
        if (finallyCompletion) return finallyCompletion;
        throw error;
      }
      const finallyCompletion = runFinally(frame);
      return finallyCompletion ?? completion;
    };
  }

  private compileCatch(clause: CatchClause): {
    matches: (frame: Frame, value: Value) => boolean;
    run: (frame: Frame, error: DartThrow) => Completion | undefined;
  } {
    const type = clause.type ? this.resolveType(clause.type) : undefined;
    const resolve = type ? this.runtimeType(type) : undefined;
    const { result, slots } = this.withScope(() => {
      const exceptionType = type ?? interfaceType(coreTypes.object);
      const exception = clause.exception
        ? this.declareLocal(clause, clause.exception, exceptionType, {
            isFinal: true,
            isLate: false,
            isConst: false,
            isParameter: false,
            hasInitializer: true,
          })
        : undefined;
      const stackTrace = clause.stackTrace
        ? this.declareLocal(clause, clause.stackTrace, interfaceType(coreTypes.stackTrace), {
            isFinal: true,
            isLate: false,
            isConst: false,
            isParameter: false,
            hasInitializer: true,
          })
        : undefined;
      const thrownSlot = this.fn.allocateSlot();
      this.fn.info.locals[thrownSlot] = { name: '\0', type: DYNAMIC };
      this.rethrowSlots.push(thrownSlot);
      this.fn.catchDepth++;
      try {
        const body = this.compileBlock(clause.body);
        return { body, exception, stackTrace, thrownSlot };
      } finally {
        this.fn.catchDepth--;
        this.rethrowSlots.pop();
      }
    });
    const { body, exception, stackTrace, thrownSlot } = result;
    return {
      matches: (frame, value) => !resolve || this.valueIsAt(frame, value, resolve(frame)),
      run: (frame, error) => {
        frame.locals[thrownSlot] = new Cell(error as unknown as Value);
        if (exception) frame.locals[exception.slot] = new Cell(error.value);
        if (stackTrace) frame.locals[stackTrace.slot] = new Cell(this.stackTraceValue(frame, error));
        try {
          return body(frame);
        } finally {
          for (const slot of [...slots, thrownSlot]) frame.locals[slot] = undefined;
        }
      },
    };
  }

  /** The slots holding the exceptions of the catch clauses being compiled, innermost last. */
  protected readonly rethrowSlots: number[] = [];

  protected abstract stackTraceValue(frame: Frame, error: DartThrow): Value;

  private compileRethrow(statement: Extract<Statement, { kind: 'rethrow' }>): Exec {
    const slot = this.rethrowSlots.at(-1);
    if (slot === undefined || this.fn.catchDepth === 0)
      return this.error(statement, 'rethrow は catch の中にしか書けません。');
    this.flow = this.flow.unreachable;
    return (frame) => {
      throw (frame.locals[slot] as Cell).v as unknown as DartThrow;
    };
  }

  private compileLabeled(statement: Extract<Statement, { kind: 'labeled' }>): Exec {
    const { labels, body } = statement;
    const isLoop = ['for', 'forIn', 'while', 'do', 'switch'].includes(body.kind);
    if (isLoop) this.pendingLabels = labels;
    for (const label of labels) if (!isLoop) this.fn.labels.push({ name: label, isLoop: false, isSwitchCase: false });
    this.breakFlows.push(undefined);
    let exec: Exec;
    try {
      exec = this.compileStatement(body);
    } finally {
      if (!isLoop) this.fn.labels.splice(this.fn.labels.length - labels.length, labels.length);
      this.pendingLabels = [];
    }
    const breakFlow = this.breakFlows.pop();
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

  private compileGeneratorBody(spec: FunctionSpec, expectedReturn: DartType | undefined): (frame: Frame) => Value {
    if (spec.body.kind === 'expression') return this.error(spec.body, 'sync* の関数には、=> の本体は書けません。');
    const elementType = expectedReturn ? iterableElementOf(expectedReturn) : undefined;
    if (expectedReturn && !elementType && expectedReturn.kind !== 'dynamic') {
      this.error(spec.span, 'sync* の関数の戻り値の型は、Iterable でなければなりません。');
    }
    this.fn.yieldElement = elementType;
    const body = this.compileGenBlock(spec.body.block);
    const resolveElement = this.runtimeType(elementType ?? DYNAMIC);
    return (frame) => this.makeSyncStarIterable(frame, resolveElement(frame), body);
  }

  /** Creates the iterable a `sync*` function returns, which runs a new copy of the body for each iterator. */
  protected abstract makeSyncStarIterable(frame: Frame, elementType: DartType, body: GenExec): Value;

  private compileGenBlock(block: Block): GenExec {
    const { result, slots } = this.withScope(() => {
      const compiled = block.statements.map((statement) => this.compileGenStatement(statement));
      return function* (frame: Frame): Generator<Value, Completion | undefined, undefined> {
        for (const exec of compiled) {
          const completion = yield* exec(frame);
          if (completion) return completion;
        }
        return undefined;
      };
    });
    if (slots.length === 0) return result;
    return function* (frame) {
      try {
        return yield* result(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
    };
  }

  // code-gauge-allow functionCognitiveComplexity 40 -- The statements that may contain yield, each as a generator.
  private compileGenStatement(statement: Statement): GenExec {
    switch (statement.kind) {
      case 'yield': {
        return this.compileYield(statement);
      }
      case 'block': {
        return this.compileGenBlock(statement);
      }
      case 'if': {
        if (statement.casePattern || !containsYield(statement)) break;
        const { compiled: condition, flow } = this.compileCondition(statement.condition);
        this.flow = flow.whenTrue;
        const consequence = this.compileGenScoped(statement.consequence);
        const afterThen = this.flow;
        this.flow = flow.whenFalse;
        const { alternative } = statement;
        const otherwise = alternative ? this.compileGenScoped(alternative) : undefined;
        this.flow = Flow.join(afterThen, this.flow);
        const test = condition.run;
        return function* (frame) {
          if (test(frame)) return yield* consequence(frame);
          if (otherwise) return yield* otherwise(frame);
          return;
        };
      }
      case 'while': {
        if (!containsYield(statement)) break;
        const labels = this.takeLoopLabels();
        this.enterLoop(statement);
        const { compiled: condition, flow } = this.compileCondition(statement.condition);
        this.flow = flow.whenTrue;
        this.fn.loopDepth++;
        this.breakFlows.push(undefined);
        const body = this.compileGenScoped(statement.body);
        this.fn.loopDepth--;
        this.breakFlows.pop();
        this.flow = flow.whenFalse;
        const test = condition.run;
        return function* (frame) {
          while (test(frame)) {
            const completion = yield* body(frame);
            if (completion) {
              const outcome = loopCompletion(completion, labels);
              if (outcome !== 'continue') return outcome;
            }
            frame.runtime.spend();
          }
          return;
        };
      }
      case 'for': {
        if (!containsYield(statement)) break;
        return this.compileGenFor(statement);
      }
      case 'forIn': {
        if (!containsYield(statement)) break;
        return this.compileGenForIn(statement);
      }
      case 'try':
      case 'switch':
      case 'do':
      case 'labeled': {
        if (containsYield(statement)) return this.unsupported(statement, 'sync* の中の、yield を含むこの文');
        break;
      }
      default: {
        break;
      }
    }
    const exec = this.compileStatement(statement);
    // oxlint-disable-next-line require-yield -- A statement without yield runs as one step of the generator.
    return function* (frame) {
      return exec(frame);
    };
  }

  private compileGenScoped(statement: Statement): GenExec {
    if (statement.kind === 'block') return this.compileGenBlock(statement);
    const { result, slots } = this.withScope(() => this.compileGenStatement(statement));
    if (slots.length === 0) return result;
    return function* (frame) {
      try {
        return yield* result(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
    };
  }

  private compileGenFor(statement: Extract<Statement, { kind: 'for' }>): GenExec {
    const labels = this.takeLoopLabels();
    const { result, slots } = this.withScope(() => {
      const { init } = statement;
      let initExec: Exec | undefined;
      if (init && !Array.isArray(init)) initExec = this.compileLocalDeclaration(init, false);
      else if (init) {
        const runs = init.map((expression) => this.compileExpression(expression).run);
        initExec = (frame) => {
          for (const run of runs) run(frame);
          return;
        };
      }
      this.enterLoop(statement);
      const condition = statement.condition ? this.compileCondition(statement.condition) : undefined;
      if (condition) this.flow = condition.flow.whenTrue;
      this.fn.loopDepth++;
      this.breakFlows.push(undefined);
      const body = this.compileGenScoped(statement.body);
      this.fn.loopDepth--;
      this.breakFlows.pop();
      const updates = statement.updates.map((update) => this.compileExpression(update).run);
      if (condition) this.flow = condition.flow.whenFalse;
      const test = condition?.compiled.run;
      return function* (frame: Frame): Generator<Value, Completion | undefined, undefined> {
        initExec?.(frame);
        for (;;) {
          if (test && !test(frame)) return undefined;
          const completion = yield* body(frame);
          if (completion) {
            const outcome = loopCompletion(completion, labels);
            if (outcome !== 'continue') return outcome;
          }
          for (const update of updates) update(frame);
          frame.runtime.spend();
        }
      };
    });
    if (slots.length === 0) return result;
    return function* (frame) {
      try {
        return yield* result(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
    };
  }

  private compileGenForIn(statement: Extract<Statement, { kind: 'forIn' }>): GenExec {
    const labels = this.takeLoopLabels();
    const iterable = this.compileExpression(statement.iterable);
    const elementType = this.elementTypeOfIterable(iterable, statement.iterable);
    const { result, slots } = this.withScope(() => {
      this.enterLoop(statement);
      const bind = this.compileForInBinding(statement.binding, elementType, statement);
      this.fn.loopDepth++;
      this.breakFlows.push(undefined);
      const body = this.compileGenScoped(statement.body);
      this.fn.loopDepth--;
      this.breakFlows.pop();
      const source = iterable.run;
      return function* (frame: Frame): Generator<Value, Completion | undefined, undefined> {
        const { runtime } = frame;
        const values = source(frame);
        const iterator = runtime.getProperty(values, 'iterator', undefined);
        frame.temporaries.push(iterator);
        try {
          for (;;) {
            if (runtime.invoke(iterator, 'moveNext', { positional: [], named: undefined }, [], undefined) !== true)
              return undefined;
            bind(frame, runtime.getProperty(iterator, 'current', undefined));
            const completion = yield* body(frame);
            if (completion) {
              const outcome = loopCompletion(completion, labels);
              if (outcome !== 'continue') return outcome;
            }
          }
        } finally {
          const index = frame.temporaries.lastIndexOf(iterator);
          if (index !== -1) frame.temporaries.splice(index, 1);
        }
      };
    });
    if (slots.length === 0) return result;
    return function* (frame) {
      try {
        return yield* result(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = undefined;
      }
    };
  }

  private compileYield(statement: Extract<Statement, { kind: 'yield' }>): GenExec {
    if (!this.fn.kind.isGenerator) return this.error(statement, 'yield は sync* の関数の中にしか書けません。');
    const elementType = this.fn.yieldElement;
    const context = statement.isEach
      ? elementType
        ? interfaceType(coreTypes.iterable, [elementType])
        : undefined
      : elementType;
    let compiled = this.compileExpression(statement.value, context);
    if (statement.isEach) {
      const element = this.elementTypeOfIterable(compiled, statement.value);
      this.fn.yieldTypes?.push(element);
      if (elementType && !isSubtype(element, elementType) && element.kind !== 'dynamic') {
        this.error(
          statement.value,
          `${typeName(element)} 型の要素は、${typeName(elementType)} 型の Iterable に入れられません。`
        );
      }
      const { run } = compiled;
      const row = this.stepRowOf(statement);
      return function* (frame) {
        const { runtime } = frame;
        const values = run(frame);
        const iterator = runtime.getProperty(values, 'iterator', undefined);
        while (runtime.invoke(iterator, 'moveNext', { positional: [], named: undefined }, [], undefined) === true) {
          if (row !== undefined) runtime.steps.step(row);
          yield runtime.getProperty(iterator, 'current', undefined);
        }
        return;
      };
    }
    this.fn.yieldTypes?.push(compiled.type);
    if (elementType) {
      compiled = this.coerce(
        compiled,
        elementType,
        statement.value,
        (from, to) => `${from} 型の値は、${to} 型の Iterable に yield できません。`
      );
    }
    const { run } = compiled;
    const row = this.stepRowOf(statement);
    return function* (frame) {
      const value = run(frame);
      if (row !== undefined) frame.runtime.steps.step(row);
      yield value;
      return;
    };
  }

  static readonly SHORTED = SHORTED;
}

function loopCompletion(completion: Completion, labels: readonly string[]): Completion | undefined | 'continue' {
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

/** Groups the cases of a switch statement: empty cases share the body of the next case. */
function groupCases(cases: SwitchCase[]): { cases: SwitchCase[]; statements: Statement[]; labels: string[] }[] {
  const groups: { cases: SwitchCase[]; statements: Statement[]; labels: string[] }[] = [];
  let pending: SwitchCase[] = [];
  for (const switchCase of cases) {
    pending.push(switchCase);
    if (switchCase.statements.length > 0 || switchCase === cases.at(-1)) {
      groups.push({
        cases: pending,
        statements: switchCase.statements,
        labels: pending.flatMap((entry) => entry.labels),
      });
      pending = [];
    }
  }
  return groups;
}

function containsYield(node: unknown): boolean {
  if (Array.isArray(node)) return node.some((item) => containsYield(item));
  if (typeof node !== 'object' || node === null) return false;
  const record = node as { kind?: string };
  if (record.kind === 'yield') return true;
  if (record.kind === 'function' || record.kind === 'localFunction') return false;
  return Object.values(record).some((value) => typeof value === 'object' && containsYield(value));
}

/** A local declared with `var` keeps the type of its initializer, except that `Null` widens to `dynamic`. */
function widenInferred(type: DartType): DartType {
  if (type.kind === 'null') return DYNAMIC;
  if (type.kind === 'typeParam' && type.promoted) return { ...type, promoted: undefined };
  return type;
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

function typeToStringOf(type: DartType): string {
  return typeToStringImpl(type);
}

export { makeNullable, resolveBound };
