import { CompileError } from '../interpreter/diagnostics';
// code-gauge-allow-file fileNcss 451 -- The statement compiler keeps one method per statement kind together.
import type {
  Block,
  CatchClause,
  Expression,
  ExpressionStatement,
  LocalVariableDeclaration,
  Span,
  Statement,
  SwitchGroup,
  VariableDeclarator,
} from './ast';
import {
  type BreakCompletion,
  type Compiled,
  type CompiledValue,
  type Completion,
  type ContinueCompletion,
  type EnclosingTry,
  type Eval,
  type Exec,
  type MethodContext,
  type ReturnCompletion,
  type Scope,
  type SwitchExpressionTarget,
} from './compilerBase';
import { assignedNames } from './definiteAssignment';
import { ExpressionCompiler } from './expressionCompiler';
import { bindingsWhen } from './patternBindings';
import { canCompleteNormally, containsJump } from './reachability';
import { type Frame, JavaThrow, throwBuiltin, UNASSIGNED } from './runtime';
import { isObjectCreation, onlyCalls } from './stepRules';
import {
  asSuper,
  type ClassInfo,
  isPrimitive,
  isReference,
  isSubclass,
  type JavaType,
  sameType,
  typeName,
  upperBound,
} from './types';
import { JavaArray, JavaObject, JavaString, type Value } from './values';

const BREAK: BreakCompletion = { kind: 'break', label: undefined };
const CONTINUE: ContinueCompletion = { kind: 'continue', label: undefined };

/** Compiles statements into closures that report how they complete. */
export abstract class StatementCompiler extends ExpressionCompiler {
  /** Set while compiling a `for` header, whose parts share the one step that the `for` records after them. */
  private compilesForHeader = false;

  /** Compiles statements inside a new scope whose locals go out of scope when it is left. */
  protected withScope(context: MethodContext, compile: () => Exec, clearsLocals = true): Exec {
    context.scopes.push({ names: new Map(), slots: [] });
    this.localTypeScopes.push(new Map());
    let exec: Exec;
    let slots: number[];
    try {
      exec = compile();
    } finally {
      slots = (context.scopes.pop() as Scope).slots;
      this.localTypeScopes.pop();
    }
    if (slots.length === 0 || !clearsLocals) return exec;
    return (frame) => {
      try {
        return exec(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = UNASSIGNED;
      }
    };
  }

  /** The row whose step a statement starting in `span` records, when the program is compiled for tracing. */
  protected stepRowOf(span: Span): number | undefined {
    if (!this.recordsSteps || this.compilesForHeader) return;
    return span.row;
  }

  /** Records the step of a statement after it runs, as `StepTracker.runStatement` says. */
  protected withStep(span: Span, exec: Exec, onlyCalls = false): Exec {
    const stepRow = this.stepRowOf(span);
    if (stepRow === undefined) return exec;
    return (frame) => frame.runtime.steps.runStatement(stepRow, onlyCalls, () => exec(frame));
  }

  /**
   * @param clearsLocals Method bodies keep their locals so that the entry point can report the final values of
   * `main`'s variables after it returns.
   */
  protected compileBlock(context: MethodContext, block: Block, clearsLocals = true): Exec {
    return this.withScope(context, () => this.compileStatements(context, block.statements), clearsLocals);
  }

  protected compileStatements(context: MethodContext, statements: Statement[]): Exec {
    const compiled: Exec[] = [];
    for (const [index, statement] of statements.entries()) {
      // Reachability reads the constants of the conditions compiled before it.
      if (index > 0 && !canCompleteNormally(statements[index - 1])) {
        this.error(statement, 'この文は実行されることがありません。');
      }
      compiled.push(this.compileStatement(context, statement));
    }
    return (frame) => {
      for (const exec of compiled) {
        const completion = exec(frame);
        if (completion) return completion;
      }
      return;
    };
  }

  protected compileStatement(context: MethodContext, statement: Statement): Exec {
    if (!['labeled', 'while', 'do', 'for', 'forEach'].includes(statement.kind)) context.loopLabels = [];
    const firstPattern = context.patternSlots.length;
    const exec = this.compileStatementBody(context, statement);
    // Pattern variables go out of scope with the statement, unless it introduced them into the enclosing block.
    const patternSlots = context.patternSlots
      .slice(firstPattern)
      .filter((slot) => !context.introducedPatternSlots.has(slot));
    if (patternSlots.length === 0) {
      return (frame) => {
        frame.runtime.spend();
        return exec(frame);
      };
    }
    return (frame) => {
      frame.runtime.spend();
      try {
        return exec(frame);
      } finally {
        for (const slot of patternSlots) frame.locals[slot] = UNASSIGNED;
      }
    };
  }

  // code-gauge-allow functionNcss 33 -- One case per statement kind, each delegating to its own compiler.
  protected compileStatementBody(context: MethodContext, statement: Statement): Exec {
    switch (statement.kind) {
      case 'block': {
        return this.compileBlock(context, statement);
      }
      case 'local': {
        return this.compileLocal(context, statement);
      }
      case 'expression': {
        return this.compileExpressionStatement(context, statement);
      }
      case 'if': {
        return this.compileIf(context, statement);
      }
      case 'while':
      case 'do': {
        return this.compileWhile(context, statement);
      }
      case 'for': {
        return this.withScope(context, () => this.compileFor(context, statement));
      }
      case 'forEach': {
        return this.withScope(context, () => this.compileForEach(context, statement));
      }
      case 'switch': {
        return this.compileSwitch(context, statement);
      }
      case 'break': {
        return this.compileBreak(context, statement);
      }
      case 'continue': {
        return this.compileContinue(context, statement);
      }
      case 'return': {
        return this.compileReturn(context, statement);
      }
      case 'throw': {
        return this.compileThrow(context, statement);
      }
      case 'try': {
        return this.compileTry(context, statement);
      }
      case 'labeled': {
        return this.compileLabeled(context, statement);
      }
      case 'yield': {
        return this.compileYield(context, statement);
      }
      case 'assert': {
        this.compileCondition(context, statement.condition);
        if (statement.message) this.compileValue(context, statement.message);
        // The JVM runs without -ea by default, which disables assertions.
        return () => {};
      }
      case 'synchronized': {
        const lock = this.compileValue(context, statement.lock);
        if (!isReference(lock.type)) {
          this.error(
            statement.lock,
            `synchronized には参照型の値が必要ですが、${typeName(lock.type)} 型の値が書かれています。`
          );
        }
        const body = this.compileBlock(context, statement.body);
        return (frame) => {
          if (lock.run(frame) === undefined) throwBuiltin(frame, 'NullPointerException');
          return body(frame);
        };
      }
      case 'localClass': {
        this.compileLocalClass(context, statement.declaration);
        // Declaring a class runs nothing.
        return () => {};
      }
      case 'empty': {
        return () => {};
      }
    }
  }

  protected compileIf(context: MethodContext, statement: Extract<Statement, { kind: 'if' }>): Exec {
    const condition = this.compileCondition(context, statement.condition);
    const whenTrue = bindingsWhen(statement.condition, true);
    const whenFalse = bindingsWhen(statement.condition, false);
    const consequence = this.withScope(context, () =>
      this.withBindings(context, whenTrue, () => this.compileStatement(context, statement.consequence))
    );
    const { alternative } = statement;
    const otherwise = alternative
      ? this.withScope(context, () =>
          this.withBindings(context, whenFalse, () => this.compileStatement(context, alternative))
        )
      : undefined;
    // A branch that cannot complete normally leaves the other branch's pattern variables in scope after the if.
    if (!canCompleteNormally(statement.consequence)) this.introduceBindings(context, whenFalse);
    if (alternative && !canCompleteNormally(alternative)) this.introduceBindings(context, whenTrue);
    return (frame) => (condition(frame) ? consequence(frame) : otherwise?.(frame));
  }

  /** A loop that no break leaves ends only when its condition is false, so that case's bindings stay in scope. */
  protected introduceLoopExitBindings(
    context: MethodContext,
    statement: Extract<Statement, { kind: 'while' | 'do' | 'for' }>,
    condition: Expression,
    labels: readonly string[]
  ): void {
    const breaks =
      containsJump(statement.body, 'break') || labels.some((label) => containsJump(statement.body, 'break', label));
    if (!breaks) this.introduceBindings(context, bindingsWhen(condition, false));
  }

  protected compileYield(context: MethodContext, statement: Extract<Statement, { kind: 'yield' }>): Exec {
    const target = context.switchExpressions.at(-1);
    if (!target) return this.error(statement, 'yield 文は switch 式の中にしか書けません。');
    const value = this.compileValue(context, statement.value);
    const index = target.values.push({ value, span: statement.value }) - 1;
    return (frame) => ({ kind: 'yield', value: target.converters[index](frame) });
  }

  protected compileSwitchExpression(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'switchExpression' }>
  ): Compiled {
    const selector = this.compileSwitchSelector(context, expression);
    const target: SwitchExpressionTarget = { values: [], converters: [] };
    // Jumps cannot leave a switch expression, which completes only with a value or an exception.
    const outer = { ...context };
    Object.assign(context, { labels: [], loopLabels: [], continueLabels: [], loopDepth: 0, switchDepth: 0 });
    context.isInSwitchExpression = true;
    context.switchExpressions.push(target);
    let groups: { groups: Exec[]; slots: number[] };
    try {
      groups = this.compileSwitchBody(context, expression);
    } finally {
      context.switchExpressions.pop();
      Object.assign(context, {
        labels: outer.labels,
        loopLabels: outer.loopLabels,
        continueLabels: outer.continueLabels,
        loopDepth: outer.loopDepth,
        switchDepth: outer.switchDepth,
        isInSwitchExpression: outer.isInSwitchExpression,
      });
    }
    this.checkSwitchExpressionBody(expression, selector.type);
    if (target.values.length === 0) this.error(expression, 'switch 式には値を返す case が必要です。');
    const type = this.switchExpressionType(expression, target.values);
    for (const { value, span } of target.values) {
      target.converters.push(isReference(type) ? value.run : this.convert(value, type, 'assignment', span).run);
    }
    const runFrom = this.compileSwitchRunner(expression, groups.groups, groups.slots);
    return {
      kind: 'value',
      type,
      run: (frame) => {
        const start = selector.run(frame);
        const completion = start === -1 ? undefined : runFrom(frame, start);
        if (completion?.kind !== 'yield') throw new Error('A switch expression completed without a value');
        return completion.value;
      },
    };
  }

  /** Rejects a switch expression that may complete without a value, as an incomplete set of cases would. */
  protected checkSwitchExpressionBody(
    expression: Extract<Expression, { kind: 'switchExpression' }>,
    selectorType: JavaType
  ): void {
    const hasDefault = expression.groups.some((group) => group.labels.includes(undefined));
    const enumClass = selectorType.kind === 'class' && selectorType.cls.kind === 'enum' ? selectorType.cls : undefined;
    const coversEnum =
      enumClass !== undefined &&
      enumClass.staticFields
        .filter((field) => field.enumConstant)
        .every((field) =>
          expression.groups.some((group) =>
            group.labels.some((label) =>
              label?.kind === 'name'
                ? label.name === field.name
                : label?.kind === 'fieldAccess' && label.name === field.name
            )
          )
        );
    if (!hasDefault && !coversEnum)
      this.error(expression, 'switch 式がすべての場合を網羅していません。default を書いてください。');
    const groupsEnding = expression.isArrowForm ? expression.groups : expression.groups.slice(-1);
    for (const group of groupsEnding) {
      if (group.statements.every((statement) => canCompleteNormally(statement))) {
        this.error(group, 'switch 式の case の処理が、値を返さずに終わっています。yield で値を返してください。');
      }
    }
  }

  /** The type of a switch expression, which joins the types of its results as a conditional joins two. */
  protected switchExpressionType(span: Span, values: readonly { value: CompiledValue }[]): JavaType {
    let result = values[0].value;
    for (const { value } of values.slice(1)) {
      const type = this.conditionalType(span, result, value);
      result = {
        kind: 'value',
        type,
        run: result.run,
        constant:
          result.constant !== undefined && value.constant !== undefined && sameType(type, result.type)
            ? result.constant
            : undefined,
      };
    }
    return result.type;
  }

  protected compileWhile(context: MethodContext, statement: Extract<Statement, { kind: 'while' | 'do' }>): Exec {
    const labels = this.takeLabels(context);
    const isDo = statement.kind === 'do';
    // A do statement's body runs before its condition, so only a while statement's body sees the condition's bindings.
    const body = isDo ? this.compileLoopBody(context, statement.body, labels) : undefined;
    const condition = this.compileCondition(context, statement.condition);
    const loopBody =
      body ??
      this.withBindings(context, bindingsWhen(statement.condition, true), () =>
        this.compileLoopBody(context, statement.body, labels)
      );
    this.introduceLoopExitBindings(context, statement, statement.condition, labels);
    return (frame) => {
      if (!isDo && !condition(frame)) return;
      for (;;) {
        const completion = loopBody(frame);
        if (completion) {
          const result = loopCompletion(completion, labels);
          if (result !== 'continue') return result;
        }
        if (!condition(frame)) return;
      }
    };
  }

  protected compileBreak(context: MethodContext, statement: Extract<Statement, { kind: 'break' }>): Exec {
    if (statement.label === undefined && context.loopDepth === 0 && context.switchDepth === 0) {
      this.error(statement, 'break 文はループや switch 文の中にしか書けません。');
    }
    if (statement.label !== undefined && !context.labels.includes(statement.label)) {
      this.error(statement, `ラベル ${statement.label} が見つかりません。`);
    }
    const completion: BreakCompletion = statement.label ? { kind: 'break', label: statement.label } : BREAK;
    return () => completion;
  }

  protected compileContinue(context: MethodContext, statement: Extract<Statement, { kind: 'continue' }>): Exec {
    if (context.loopDepth === 0) this.error(statement, 'continue 文はループの中にしか書けません。');
    const { label } = statement;
    if (label !== undefined && !context.continueLabels.includes(label)) {
      const message = context.labels.includes(label)
        ? `ラベル ${label} はループに付いていないので、continue 文では使えません。`
        : `ラベル ${label} が見つかりません。`;
      this.error(statement, message);
    }
    const completion: ContinueCompletion = statement.label ? { kind: 'continue', label: statement.label } : CONTINUE;
    return () => completion;
  }

  protected compileThrow(context: MethodContext, statement: Extract<Statement, { kind: 'throw' }>): Exec {
    const value = this.compileValue(context, statement.value);
    const isThrowable =
      value.type.kind === 'null' ||
      (value.type.kind === 'class' && isSubclass(value.type.cls, this.builtins.throwableClass));
    if (!isThrowable) this.error(statement.value, `${typeName(value.type)} は例外として投げられません。`);
    const local = statement.value.kind === 'name' ? this.findLocal(context, statement.value.name) : undefined;
    // Rethrowing a catch parameter throws only what its try block throws, as long as it is not reassigned.
    const rethrown = local === undefined ? undefined : context.rethrownTypes.get(local);
    if (value.type.kind === 'class') this.checkThrown(context, statement, rethrown ?? [value.type.cls]);
    return (frame) => {
      const exception = value.run(frame);
      if (!(exception instanceof JavaObject)) throwBuiltin(frame, 'NullPointerException');
      throw new JavaThrow(exception);
    };
  }

  protected compileLabeled(context: MethodContext, statement: Extract<Statement, { kind: 'labeled' }>): Exec {
    const { label } = statement;
    context.labels.push(label);
    // Only the label directly before a loop names that loop; an outer label names the labeled statement.
    context.loopLabels = [label];
    let body: Exec;
    try {
      body = this.compileStatement(context, statement.body);
    } finally {
      context.labels.pop();
      context.loopLabels = [];
    }
    return (frame) => {
      const completion = body(frame);
      return completion?.kind === 'break' && completion.label === label ? undefined : completion;
    };
  }

  /** Takes the labels written directly before the loop being compiled, which `continue label` may target. */
  protected takeLabels(context: MethodContext): string[] {
    const labels = context.loopLabels;
    context.loopLabels = [];
    return labels;
  }

  protected compileLoopBody(context: MethodContext, body: Statement, labels: readonly string[]): Exec {
    context.loopDepth++;
    context.continueLabels.push(...labels);
    try {
      return this.withScope(context, () => this.compileStatement(context, body));
    } finally {
      context.continueLabels.splice(context.continueLabels.length - labels.length);
      context.loopDepth--;
    }
  }

  protected compileLocal(context: MethodContext, statement: LocalVariableDeclaration): Exec {
    const parts = statement.declarators.map((declarator) => this.compileDeclarator(context, statement, declarator));
    const exec: Exec = (frame) => {
      for (const { slot, value } of parts) {
        if (value) frame.locals[slot] = value(frame);
      }
      return;
    };
    const initializers = statement.declarators.flatMap(({ initializer }) => (initializer ? [initializer] : []));
    // A declaration without an initializer assigns nothing that learners could answer, so it records no step.
    if (initializers.length === 0) return exec;
    return this.withStep(statement, exec, initializers.every(isObjectCreation));
  }

  protected compileDeclarator(
    context: MethodContext,
    statement: LocalVariableDeclaration,
    declarator: VariableDeclarator
  ): { slot: number; value: Eval | undefined } {
    const { initializer } = declarator;
    let slot: number;
    let compiled: CompiledValue | undefined;
    if (statement.type.kind === 'var') {
      if (!initializer || initializer.kind === 'arrayInitializer' || declarator.extraDimensions > 0) {
        return this.error(declarator, 'var で宣言する変数には初期値の式が必要です。');
      }
      compiled = this.compileValue(context, initializer);
      if (compiled.type.kind === 'null' || compiled.type.kind === 'void') {
        this.error(declarator, `変数 ${declarator.name} の型を決められません。`);
      }
      slot = this.declareLocal(context, declarator, declarator.name, compiled.type);
    } else {
      const type = this.withDimensions(this.resolveType(statement.type), declarator.extraDimensions);
      // The variable's scope includes its own initializer, where it shadows a field of the same name.
      slot = this.declareLocal(context, declarator, declarator.name, type, initializer !== undefined);
      if (initializer?.kind === 'arrayInitializer') {
        return { slot, value: this.compileArrayInitializer(context, initializer, type) };
      }
      if (initializer) {
        compiled = this.convert(this.compileValueFor(context, initializer, type), type, 'assignment', declarator);
      }
    }
    if (statement.isFinal && compiled?.constant !== undefined) context.constants.set(slot, compiled.constant);
    return { slot, value: compiled?.run };
  }

  protected compileExpressionStatement(context: MethodContext, statement: ExpressionStatement): Exec {
    const { expression } = statement;
    if (!['assign', 'update', 'call', 'new'].includes(expression.kind)) {
      this.error(statement, '式だけを文として書くことはできません。');
    }
    const value = this.compileValue(context, expression, true);
    if (statement.isGenerated) {
      return (frame) => {
        value.run(frame);
        return;
      };
    }
    return this.withStep(
      statement,
      (frame) => {
        value.run(frame);
        return;
      },
      onlyCalls(expression)
    );
  }

  protected compileReturn(context: MethodContext, statement: Extract<Statement, { kind: 'return' }>): Exec {
    if (context.isInSwitchExpression) this.error(statement, 'return 文は switch 式の中には書けません。');
    if (context.isInitializerBlock) this.error(statement, 'return 文は初期化ブロックの中には書けません。');
    if (!statement.value) {
      if (context.returnType.kind !== 'void') this.error(statement, 'return 文に値が必要です。');
      const completion: ReturnCompletion = { kind: 'return', value: undefined };
      return () => completion;
    }
    if (context.returnType.kind === 'void') this.error(statement, '戻り値の型が void のメソッドは値を返せません。');
    const value = this.convert(
      this.compileValueFor(context, statement.value, context.returnType),
      context.returnType,
      'assignment',
      statement.value
    ).run;
    return (frame) => ({ kind: 'return', value: value(frame) });
  }

  protected compileFor(context: MethodContext, statement: Extract<Statement, { kind: 'for' }>): Exec {
    const labels = this.takeLabels(context);
    const { init, update } = this.compileForHeader(context, statement);
    const { condition: conditionSyntax } = statement;
    const condition = conditionSyntax ? this.compileCondition(context, conditionSyntax) : () => true;
    const body = this.withBindings(context, conditionSyntax ? bindingsWhen(conditionSyntax, true) : [], () =>
      this.compileLoopBody(context, statement.body, labels)
    );
    if (conditionSyntax) this.introduceLoopExitBindings(context, statement, conditionSyntax, labels);
    return (frame) => {
      init(frame);
      while (condition(frame)) {
        const completion = body(frame);
        if (completion) {
          const result = loopCompletion(completion, labels);
          if (result !== 'continue') return result;
        }
        update(frame);
      }
      return;
    };
  }

  /** Compiles the init and the update so that each records one step after it runs as a whole. */
  protected compileForHeader(
    context: MethodContext,
    statement: Extract<Statement, { kind: 'for' }>
  ): { init: Exec; update: Exec } {
    const stepRow = this.stepRowOf(statement);
    this.compilesForHeader = true;
    try {
      const init = Array.isArray(statement.init)
        ? this.compileStatements(context, statement.init)
        : this.compileLocal(context, statement.init);
      const update = this.compileStatements(context, statement.update);
      if (stepRow === undefined) return { init, update };
      const recordStep =
        (exec: Exec): Exec =>
        (frame) => {
          exec(frame);
          frame.runtime.steps.step(stepRow);
          return;
        };
      const { init: initPart } = statement;
      const initRecordsStep = Array.isArray(initPart)
        ? initPart.length > 0
        : initPart.declarators.some((declarator) => declarator.initializer);
      return {
        init: initRecordsStep ? recordStep(init) : init,
        update: statement.update.length > 0 ? recordStep(update) : update,
      };
    } finally {
      this.compilesForHeader = false;
    }
  }

  protected compileForEach(context: MethodContext, statement: Extract<Statement, { kind: 'forEach' }>): Exec {
    const labels = this.takeLabels(context);
    const iterable = this.compileValue(context, statement.iterable);
    const iterableClass = this.builtins.collections.iterableClass;
    const bound = upperBound(iterable.type);
    const iterableType = bound.kind === 'class' ? asSuper(bound, iterableClass) : undefined;
    if (iterable.type.kind !== 'array' && !iterableType) {
      return this.error(statement.iterable, '拡張 for 文では配列か、List などの Iterable しか使えません。');
    }
    const elementArg = iterableType?.args?.[0];
    const elementType =
      iterable.type.kind === 'array'
        ? iterable.type.element
        : elementArg
          ? elementArg.kind === 'wildcard'
            ? upperBound(elementArg)
            : elementArg
          : this.builtins.objectClass.type;
    const declaredType = statement.type.kind === 'var' ? elementType : this.resolveType(statement.type);
    // The element waits in the temporaries, where the conversion reads it, until the variable holds it.
    const element: CompiledValue = { kind: 'value', type: elementType, run: (frame) => frame.temporaries.at(-1) };
    const convert = this.convert(element, declaredType, 'assignment', statement.variable).run;
    const slot = this.declareLocal(context, statement, statement.name, declaredType);
    const stepRow = this.stepRowOf(statement);
    // Learners write down only primitive and string values.
    const isAnswered = this.isAnswered(declaredType);
    const body = this.compileLoopBody(context, statement.body, labels);
    const bind = (frame: Frame, value: Value): void => {
      frame.temporaries.push(value);
      try {
        frame.locals[slot] = convert(frame);
      } finally {
        frame.temporaries.pop();
      }
      frame.runtime.steps.stepBinding(stepRow, isAnswered);
    };
    const runIteration = (frame: Frame, value: Value): Completion | undefined | 'continue' => {
      bind(frame, value);
      const completion = body(frame);
      return completion && loopCompletion(completion, labels);
    };
    if (iterable.type.kind !== 'array') {
      return (frame) => {
        const source = iterable.run(frame);
        if (source === undefined) return throwBuiltin(frame, 'NullPointerException');
        return iterateIterable(frame, source, (value) => runIteration(frame, value));
      };
    }
    return (frame) => {
      const array = iterable.run(frame);
      if (!(array instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
      return iterate(frame, array, (value) => runIteration(frame, value));
    };
  }

  protected isAnswered(type: JavaType): boolean {
    return isPrimitive(type) || (type.kind === 'class' && type.cls === this.builtins.stringClass);
  }

  protected compileSwitch(context: MethodContext, statement: Extract<Statement, { kind: 'switch' }>): Exec {
    const selector = this.compileSwitchSelector(context, statement);
    context.switchDepth++;
    let runFrom: (frame: Frame, start: number) => Completion | undefined;
    try {
      const { groups, slots } = this.compileSwitchBody(context, statement);
      runFrom = this.compileSwitchRunner(statement, groups, slots);
    } finally {
      context.switchDepth--;
    }
    return (frame) => {
      const start = selector.run(frame);
      if (start === -1) return;
      const completion = runFrom(frame, start);
      return completion?.kind === 'break' && completion.label === undefined ? undefined : completion;
    };
  }

  /** Compiles a switch's selector and labels into the index of the group where execution starts, or -1. */
  protected compileSwitchSelector(
    context: MethodContext,
    statement: { selector: Expression; groups: SwitchGroup[] }
  ): { type: JavaType; run: (frame: Frame) => number } {
    const selector = this.operand(this.compileValue(context, statement.selector));
    const isString = selector.type.kind === 'class' && selector.type.cls === this.builtins.stringClass;
    const isEnum = selector.type.kind === 'class' && selector.type.cls.kind === 'enum';
    if (!isString && !isEnum && !['byte', 'short', 'char', 'int'].includes(selector.type.kind)) {
      this.error(statement.selector, `switch では ${typeName(selector.type)} 型の値を使えません。`);
    }
    const { labelValues, defaultIndex } = this.compileSwitchLabels(context, statement, selector.type);
    const matches = (candidate: Value, value: Value): boolean =>
      isString ? (candidate as JavaString).value === (value as JavaString).value : candidate === value;
    return {
      type: selector.type,
      run: (frame) => {
        const selected = selector.run(frame);
        if (selected === undefined) throwBuiltin(frame, 'NullPointerException');
        // Enum labels hold the ordinals of their constants.
        const value = isEnum && selected instanceof JavaObject ? selected.enumConstant?.ordinal : selected;
        const matched = labelValues.findIndex((values) => values.some((candidate) => matches(candidate, value)));
        return matched === -1 ? defaultIndex : matched;
      },
    };
  }

  /** The constants of each group's case labels, and the index of the group holding `default` (or -1). */
  protected compileSwitchLabels(
    context: MethodContext,
    statement: { groups: SwitchGroup[] },
    selectorType: JavaType
  ): { labelValues: Value[][]; defaultIndex: number } {
    const seen = new Set<unknown>();
    let defaultIndex = -1;
    const labelValues = statement.groups.map((group, index) =>
      group.labels.flatMap((label) => {
        if (label) return [this.compileCaseConstant(context, label, selectorType, seen)];
        if (defaultIndex !== -1) this.error(group, 'default が複数あります。');
        defaultIndex = index;
        return [];
      })
    );
    return { labelValues, defaultIndex };
  }

  protected compileCaseConstant(
    context: MethodContext,
    label: Expression,
    selectorType: JavaType,
    seen: Set<unknown>
  ): Value {
    if (selectorType.kind === 'class' && selectorType.cls.kind === 'enum') {
      const ordinal = this.enumOrdinalOf(context, label, selectorType.cls);
      if (seen.has(ordinal)) this.error(label, 'case の値が重複しています。');
      seen.add(ordinal);
      return ordinal;
    }
    const { constant } = this.convert(this.compileValue(context, label), selectorType, 'assignment', label);
    if (constant === undefined) this.error(label, 'case には定数を書いてください。');
    const key = constant instanceof JavaString ? `s:${constant.value}` : constant;
    if (seen.has(key)) this.error(label, 'case の値が重複しています。');
    seen.add(key);
    return constant;
  }

  /** The ordinal of the constant of `enumClass` that a case label names, by its simple or qualified name. */
  protected enumOrdinalOf(context: MethodContext, label: Expression, enumClass: ClassInfo): number {
    let name: string | undefined;
    if (label.kind === 'name') name = label.name;
    else if (label.kind === 'fieldAccess' && label.object !== 'super') {
      const owner = this.compileExpression(context, label.object);
      if (owner.kind === 'class' && owner.cls === enumClass) name = label.name;
    }
    const constants = enumClass.staticFields.filter((field) => field.enumConstant);
    const ordinal = constants.findIndex((field) => field.name === name);
    if (ordinal === -1) this.error(label, `case には列挙型 ${enumClass.name} の定数を書いてください。`);
    return ordinal;
  }

  /** Compiles the groups of a switch, whose classic groups share one scope, returning that scope's slots. */
  protected compileSwitchBody(
    context: MethodContext,
    statement: { isArrowForm: boolean; groups: SwitchGroup[] }
  ): { groups: Exec[]; slots: number[] } {
    if (statement.isArrowForm) {
      const groups = statement.groups.map((group) =>
        this.withScope(context, () => this.compileStatements(context, group.statements))
      );
      return { groups, slots: [] };
    }
    const scope: Scope = { names: new Map(), slots: [] };
    context.scopes.push(scope);
    try {
      return {
        groups: statement.groups.map((group) => this.compileStatements(context, group.statements)),
        slots: scope.slots,
      };
    } finally {
      context.scopes.pop();
    }
  }

  /** A runner that starts at a group and falls through the classic groups in order. */
  protected compileSwitchRunner(
    statement: { isArrowForm: boolean },
    groups: Exec[],
    slots: number[]
  ): (frame: Frame, start: number) => Completion | undefined {
    const { isArrowForm } = statement;
    return (frame, start) => {
      try {
        for (let index = start; index < groups.length; index++) {
          const completion = groups[index](frame);
          if (completion || isArrowForm) return completion;
        }
        return;
      } finally {
        for (const slot of slots) frame.locals[slot] = UNASSIGNED;
      }
    };
  }

  protected compileTry(context: MethodContext, statement: Extract<Statement, { kind: 'try' }>): Exec {
    if (statement.catches.length === 0 && !statement.finallyBlock) {
      this.error(statement, 'try 文には catch か finally が必要です。');
    }
    // The finally block is compiled first: one that cannot complete normally discards every exception thrown
    // before it, so the try and catch blocks then throw nothing out of the statement. Its error waits until the
    // blocks before it compile, so that the first error in the source is the one reported.
    let finallyBlock: Exec | undefined;
    let finallyError: CompileError | undefined;
    try {
      finallyBlock = statement.finallyBlock ? this.compileBlock(context, statement.finallyBlock) : undefined;
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      finallyError = error;
    }
    // A finally block that failed to compile still has its structure, where unreached conditions count as variable.
    const discardsExceptions = statement.finallyBlock !== undefined && !canCompleteNormally(statement.finallyBlock);
    if (discardsExceptions) context.tries.push({ caughtTypes: [this.builtins.throwableClass], thrownTypes: [] });
    try {
      const enclosing: EnclosingTry = {
        caughtTypes: statement.catches.flatMap((clause) => clause.types.map((type) => this.resolveThrowable(type))),
        thrownTypes: [],
      };
      context.tries.push(enclosing);
      let body: Exec;
      try {
        body = this.compileBlock(context, statement.body);
      } finally {
        context.tries.pop();
      }
      const handle = this.compileCatchClauses(context, statement.catches, enclosing.thrownTypes);
      if (finallyError) throw finallyError;
      return runTry(body, handle, finallyBlock);
    } finally {
      if (discardsExceptions) context.tries.pop();
    }
  }

  /** Rejects catching what an earlier clause catches, or a checked exception the try block cannot throw. */
  protected checkCatchable(
    clause: CatchClause,
    classes: readonly ClassInfo[],
    thrownInTry: readonly ClassInfo[],
    earlierClasses: readonly ClassInfo[]
  ): void {
    const exceptionClass = this.builtins.classes.get('Exception') as ClassInfo;
    for (const [index, cls] of classes.entries()) {
      if (classes.some((other, otherIndex) => otherIndex !== index && isSubclass(cls, other))) {
        this.error(clause, `catch の例外 ${cls.name} は、同じ catch の他の例外と親子関係にあります。`);
      }
      if (earlierClasses.some((earlier) => isSubclass(cls, earlier))) {
        this.error(clause, `例外 ${cls.name} は、前の catch ですでに捕まえられています。`);
      }
      // Exception and Throwable also catch unchecked exceptions, which any code may throw.
      const mayBeThrown =
        !this.isChecked(cls) ||
        isSubclass(exceptionClass, cls) ||
        thrownInTry.some((thrown) => isSubclass(thrown, cls) || isSubclass(cls, thrown));
      if (!mayBeThrown) this.error(clause, `例外 ${cls.name} は、この try 文の中で投げられることがありません。`);
    }
  }

  /** Compiles catch clauses into a handler that rethrows an exception none of them catches. */
  protected compileCatchClauses(
    context: MethodContext,
    clauses: CatchClause[],
    thrownInTry: readonly ClassInfo[]
  ): CatchHandler {
    const earlierClasses: ClassInfo[] = [];
    const handlers = clauses.map((clause) => {
      const classes = clause.types.map((type) => this.resolveThrowable(type));
      this.checkCatchable(clause, classes, thrownInTry, earlierClasses);
      const rethrown = caughtByClause(thrownInTry, classes, earlierClasses);
      earlierClasses.push(...classes);
      const exec = this.withScope(context, () => {
        const type = classes.length === 1 ? classes[0].type : this.builtins.throwableClass.type;
        const slot = this.declareLocal(context, clause, clause.name, type);
        if (!assignedNames(clause.body).includes(clause.name)) context.rethrownTypes.set(slot, rethrown);
        const handler = this.compileBlock(context, clause.body);
        return (frame) => {
          frame.locals[slot] = frame.temporaries.pop();
          return handler(frame);
        };
      });
      return { classes, exec };
    });
    return (frame, thrown) => {
      const handler = handlers.find(({ classes }) => classes.some((cls) => isSubclass(thrown.value.cls, cls)));
      if (!handler) throw thrown;
      frame.temporaries.push(thrown.value);
      return handler.exec(frame);
    };
  }
}

type CatchHandler = (frame: Frame, thrown: JavaThrow) => Completion | undefined;

/** What a catch clause receives: what the try block throws narrowed to its classes, minus what earlier clauses catch. */
function caughtByClause(
  thrownInTry: readonly ClassInfo[],
  classes: readonly ClassInfo[],
  earlierClasses: readonly ClassInfo[]
): ClassInfo[] {
  const narrowed = thrownInTry.flatMap((thrown) =>
    classes.flatMap((cls) => {
      if (isSubclass(thrown, cls)) return [thrown];
      return isSubclass(cls, thrown) ? [cls] : [];
    })
  );
  return narrowed.filter((thrown) => !earlierClasses.some((earlier) => isSubclass(thrown, earlier)));
}

function runTry(body: Exec, handle: CatchHandler, finallyBlock: Exec | undefined): Exec {
  return (frame) => {
    const { completion, pending } = attemptTry(frame, body, handle);
    if (finallyBlock) {
      // A return value or an exception the finally block delays keeps its turtles alive while the block runs.
      frame.temporaries.push(completion?.kind === 'return' ? completion.value : pending?.value);
      try {
        const finallyCompletion = finallyBlock(frame);
        if (finallyCompletion) return finallyCompletion;
      } finally {
        frame.temporaries.pop();
      }
    }
    if (pending) throw pending;
    return completion;
  };
}

/** Runs a try block and its catch clauses, returning how they completed or the exception left for finally. */
function attemptTry(frame: Frame, body: Exec, handle: CatchHandler): { completion?: Completion; pending?: JavaThrow } {
  const temporaries = frame.temporaries.length;
  try {
    return { completion: body(frame) };
  } catch (error) {
    if (!(error instanceof JavaThrow)) throw error;
    // An exception thrown mid-expression leaves that expression's pending values behind.
    frame.temporaries.length = temporaries;
    try {
      return { completion: handle(frame, error) };
    } catch (error_) {
      if (!(error_ instanceof JavaThrow)) throw error_;
      frame.temporaries.length = temporaries;
      return { pending: error_ };
    }
  }
}

/** Runs a for-each loop over `array`, which keeps its turtles alive while the loop runs, even when no variable holds it. */
function iterate(
  frame: Frame,
  array: JavaArray,
  runIteration: (value: Value) => Completion | undefined | 'continue'
): Completion | undefined {
  frame.temporaries.push(array);
  try {
    for (const value of array.values) {
      const result = runIteration(value);
      if (result && result !== 'continue') return result;
    }
    return;
  } finally {
    frame.temporaries.pop();
  }
}

/** Runs a for-each loop over an `Iterable` through its iterator, as Java does, keeping the iterator alive meanwhile. */
function iterateIterable(
  frame: Frame,
  source: Value,
  runIteration: (value: Value) => Completion | undefined | 'continue'
): Completion | undefined {
  const { collections } = frame.runtime.builtins;
  const iterator = frame.runtime.invokeVirtual(frame, collections.iterableClass, 'iterator', source, []);
  frame.temporaries.push(iterator);
  try {
    while (frame.runtime.invokeVirtual(frame, collections.iteratorClass, 'hasNext', iterator, []) === true) {
      const value = frame.runtime.invokeVirtual(frame, collections.iteratorClass, 'next', iterator, []);
      const result = runIteration(value);
      if (result && result !== 'continue') return result;
    }
    return;
  } finally {
    frame.temporaries.pop();
  }
}

/** Decides what a loop does with its body's abrupt completion. */
function loopCompletion(completion: Completion, labels: string[]): Completion | undefined | 'continue' {
  if (completion.kind === 'continue' && (completion.label === undefined || labels.includes(completion.label))) {
    return 'continue';
  }
  if (completion.kind === 'break' && completion.label === undefined) return;
  return completion;
}
