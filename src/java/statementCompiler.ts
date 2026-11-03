import type {
  Block,
  CatchClause,
  Expression,
  ExpressionStatement,
  LocalVariableDeclaration,
  Span,
  Statement,
  VariableDeclarator,
} from './ast';
import {
  type BreakCompletion,
  type CompiledValue,
  type Completion,
  type ContinueCompletion,
  type Eval,
  type Exec,
  type MethodContext,
  type ReturnCompletion,
  type Scope,
} from './compilerBase';
import { ExpressionCompiler } from './expressionCompiler';
import { canCompleteNormally } from './reachability';
import { type Frame, JavaThrow, throwBuiltin, UNASSIGNED } from './runtime';
import { isSubclass, type JavaType, typeName } from './types';
import { JavaArray, JavaObject, JavaString, type Value } from './values';

const BREAK: BreakCompletion = { kind: 'break', label: undefined };
const CONTINUE: ContinueCompletion = { kind: 'continue', label: undefined };

/** Compiles statements into closures that report how they complete. */
export abstract class StatementCompiler extends ExpressionCompiler {
  /** Compiles statements inside a new scope whose locals go out of scope when it is left. */
  protected withScope(context: MethodContext, compile: () => Exec, clearsLocals = true): Exec {
    context.scopes.push({ names: new Map(), slots: [] });
    let exec: Exec;
    let slots: number[];
    try {
      exec = compile();
    } finally {
      slots = (context.scopes.pop() as Scope).slots;
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

  protected stepIdOf(span: Span): number | undefined {
    for (let row = span.row; row <= span.endRow; row++) {
      const stepId = this.stepIdByRow.get(row);
      if (stepId === undefined) continue;
      this.usedStepRows.add(row);
      return stepId;
    }
    return;
  }

  protected withStep(span: Span, exec: Exec): Exec {
    const stepId = this.stepIdOf(span);
    if (stepId === undefined) return exec;
    return (frame) => {
      const completion = exec(frame);
      frame.runtime.onStep?.(stepId);
      return completion;
    };
  }

  /**
   * @param clearsLocals Method bodies keep their locals so that the entry point can report the final values of
   * `main`'s variables after it returns.
   */
  protected compileBlock(context: MethodContext, block: Block, clearsLocals = true): Exec {
    return this.withScope(context, () => this.compileStatements(context, block.statements), clearsLocals);
  }

  protected compileStatements(context: MethodContext, statements: Statement[]): Exec {
    for (let index = 1; index < statements.length; index++) {
      if (!canCompleteNormally(statements[index - 1])) {
        this.error(statements[index], 'この文は実行されることがありません。');
      }
    }
    const compiled = statements.map((statement) => this.compileStatement(context, statement));
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
    const exec = this.compileStatementBody(context, statement);
    return (frame) => {
      frame.runtime.spend();
      return exec(frame);
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
      case 'empty': {
        return () => {};
      }
    }
  }

  protected compileIf(context: MethodContext, statement: Extract<Statement, { kind: 'if' }>): Exec {
    const condition = this.compileCondition(context, statement.condition);
    const consequence = this.withScope(context, () => this.compileStatement(context, statement.consequence));
    const { alternative } = statement;
    const otherwise = alternative
      ? this.withScope(context, () => this.compileStatement(context, alternative))
      : undefined;
    return (frame) => (condition(frame) ? consequence(frame) : otherwise?.(frame));
  }

  protected compileWhile(context: MethodContext, statement: Extract<Statement, { kind: 'while' | 'do' }>): Exec {
    const labels = this.takeLabels(context);
    const condition = this.compileCondition(context, statement.condition);
    const body = this.compileLoopBody(context, statement.body);
    const isDo = statement.kind === 'do';
    return (frame) => {
      if (!isDo && !condition(frame)) return;
      for (;;) {
        const completion = body(frame);
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
    if (statement.label !== undefined && !context.labels.includes(statement.label)) {
      this.error(statement, `ラベル ${statement.label} が見つかりません。`);
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
    return (frame) => {
      const exception = value.run(frame);
      if (!(exception instanceof JavaObject)) throwBuiltin(frame, 'NullPointerException');
      throw new JavaThrow(exception);
    };
  }

  protected compileLabeled(context: MethodContext, statement: Extract<Statement, { kind: 'labeled' }>): Exec {
    const { label } = statement;
    context.labels.push(label);
    context.loopLabels.push(label);
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

  protected compileLoopBody(context: MethodContext, body: Statement): Exec {
    context.loopDepth++;
    try {
      return this.withScope(context, () => this.compileStatement(context, body));
    } finally {
      context.loopDepth--;
    }
  }

  protected compileLocal(context: MethodContext, statement: LocalVariableDeclaration): Exec {
    const stepId = this.stepIdOf(statement);
    const parts = statement.declarators.map((declarator) => this.compileDeclarator(context, statement, declarator));
    return (frame) => {
      for (const { slot, value } of parts) {
        if (!value) continue;
        frame.locals[slot] = value(frame);
        if (stepId !== undefined) frame.runtime.onStep?.(stepId);
      }
      return;
    };
  }

  protected compileDeclarator(
    context: MethodContext,
    statement: LocalVariableDeclaration,
    declarator: VariableDeclarator
  ): { slot: number; value: Eval | undefined } {
    const { initializer } = declarator;
    let type: JavaType;
    let compiled: CompiledValue | undefined;
    if (statement.type.kind === 'var') {
      if (!initializer || initializer.kind === 'arrayInitializer' || declarator.extraDimensions > 0) {
        return this.error(declarator, 'var で宣言する変数には初期値の式が必要です。');
      }
      compiled = this.compileValue(context, initializer);
      if (compiled.type.kind === 'null' || compiled.type.kind === 'void') {
        this.error(declarator, `変数 ${declarator.name} の型を決められません。`);
      }
      type = compiled.type;
    } else {
      type = this.withDimensions(this.resolveType(statement.type), declarator.extraDimensions);
      if (initializer?.kind === 'arrayInitializer') {
        const slot = this.declareLocal(context, declarator, declarator.name, type);
        return { slot, value: this.compileArrayInitializer(context, initializer, type) };
      }
      if (initializer) {
        compiled = this.convert(this.compileValue(context, initializer), type, 'assignment', declarator);
      }
    }
    const slot = this.declareLocal(context, declarator, declarator.name, type);
    if (statement.isFinal && compiled?.constant !== undefined) context.constants.set(slot, compiled.constant);
    return { slot, value: compiled?.run };
  }

  protected compileExpressionStatement(context: MethodContext, statement: ExpressionStatement): Exec {
    const { expression } = statement;
    if (!['assign', 'update', 'call', 'new'].includes(expression.kind)) {
      this.error(statement, '式だけを文として書くことはできません。');
    }
    const value = this.compileValue(context, expression, true);
    return this.withStep(statement, (frame) => {
      value.run(frame);
      return;
    });
  }

  protected compileReturn(context: MethodContext, statement: Extract<Statement, { kind: 'return' }>): Exec {
    const stepId = this.stepIdOf(statement);
    if (!statement.value) {
      if (context.returnType.kind !== 'void') this.error(statement, 'return 文に値が必要です。');
      const completion: ReturnCompletion = { kind: 'return', value: undefined };
      return (frame) => {
        if (stepId !== undefined) frame.runtime.onStep?.(stepId);
        return completion;
      };
    }
    if (context.returnType.kind === 'void') this.error(statement, '戻り値の型が void のメソッドは値を返せません。');
    const value = this.convert(this.compileValue(context, statement.value), context.returnType, 'assignment').run;
    return (frame) => {
      const result = value(frame);
      if (stepId !== undefined) frame.runtime.onStep?.(stepId);
      return { kind: 'return', value: result };
    };
  }

  protected compileFor(context: MethodContext, statement: Extract<Statement, { kind: 'for' }>): Exec {
    const labels = this.takeLabels(context);
    const init: Exec = Array.isArray(statement.init)
      ? this.compileStatements(context, statement.init)
      : this.compileLocal(context, statement.init);
    const condition = statement.condition ? this.compileCondition(context, statement.condition) : () => true;
    const update = this.compileStatements(context, statement.update);
    const body = this.compileLoopBody(context, statement.body);
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

  protected compileForEach(context: MethodContext, statement: Extract<Statement, { kind: 'forEach' }>): Exec {
    const labels = this.takeLabels(context);
    const iterable = this.compileValue(context, statement.iterable);
    if (iterable.type.kind !== 'array') {
      return this.error(statement.iterable, '拡張 for 文では配列しか使えません。');
    }
    const elementType = iterable.type.element;
    const declaredType = statement.type.kind === 'var' ? elementType : this.resolveType(statement.type);
    // The element waits in the temporaries, where the conversion reads it, until the variable holds it.
    const element: CompiledValue = { kind: 'value', type: elementType, run: (frame) => frame.temporaries.at(-1) };
    const convert = this.convert(element, declaredType, 'assignment', statement.variable).run;
    const slot = this.declareLocal(context, statement, statement.name, declaredType);
    const stepId = this.stepIdOf(statement.variable);
    const body = this.compileLoopBody(context, statement.body);
    const bind = (frame: Frame, value: Value): void => {
      frame.temporaries.push(value);
      try {
        frame.locals[slot] = convert(frame);
      } finally {
        frame.temporaries.pop();
      }
      if (stepId !== undefined) frame.runtime.onStep?.(stepId);
    };
    return (frame) => {
      const array = iterable.run(frame);
      if (!(array instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
      for (const value of array.values) {
        bind(frame, value);
        const completion = body(frame);
        const result = completion && loopCompletion(completion, labels);
        if (result && result !== 'continue') return result;
      }
      return;
    };
  }

  protected compileSwitch(context: MethodContext, statement: Extract<Statement, { kind: 'switch' }>): Exec {
    const selector = this.compileValue(context, statement.selector);
    const isString = selector.type.kind === 'class' && selector.type.cls === this.builtins.stringClass;
    if (!isString && selector.type.kind !== 'int' && selector.type.kind !== 'char') {
      this.error(statement.selector, `switch 文では ${typeName(selector.type)} 型の値を使えません。`);
    }
    const { labelValues, defaultIndex } = this.compileSwitchLabels(context, statement, selector.type);
    const runFrom = this.compileSwitchGroups(context, statement);
    const matches = (candidate: Value, value: Value): boolean =>
      isString ? (candidate as JavaString).value === (value as JavaString).value : candidate === value;
    return (frame) => {
      const value = selector.run(frame);
      if (value === undefined) throwBuiltin(frame, 'NullPointerException');
      const matched = labelValues.findIndex((values) => values.some((candidate) => matches(candidate, value)));
      const start = matched === -1 ? defaultIndex : matched;
      if (start === -1) return;
      const completion = runFrom(frame, start);
      return completion?.kind === 'break' && completion.label === undefined ? undefined : completion;
    };
  }

  /** The constants of each group's case labels, and the index of the group holding `default` (or -1). */
  protected compileSwitchLabels(
    context: MethodContext,
    statement: Extract<Statement, { kind: 'switch' }>,
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
    const { constant } = this.convert(this.compileValue(context, label), selectorType, 'assignment', label);
    if (constant === undefined) this.error(label, 'case には定数を書いてください。');
    const key = constant instanceof JavaString ? `s:${constant.value}` : constant;
    if (seen.has(key)) this.error(label, 'case の値が重複しています。');
    seen.add(key);
    return constant;
  }

  /** Compiles the groups into a runner that starts at a group and falls through as the switch's form allows. */
  protected compileSwitchGroups(
    context: MethodContext,
    statement: Extract<Statement, { kind: 'switch' }>
  ): (frame: Frame, start: number) => Completion | undefined {
    context.switchDepth++;
    let groups: Exec[];
    let slots: number[] = [];
    try {
      if (statement.isArrowForm) {
        groups = statement.groups.map((group) =>
          this.withScope(context, () => this.compileStatements(context, group.statements))
        );
      } else {
        // The groups of a classic switch share one scope, and execution falls through them in order.
        context.scopes.push({ names: new Map(), slots: [] });
        try {
          groups = statement.groups.map((group) => this.compileStatements(context, group.statements));
        } finally {
          slots = (context.scopes.pop() as Scope).slots;
        }
      }
    } finally {
      context.switchDepth--;
    }
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
    const body = this.compileBlock(context, statement.body);
    const handle = this.compileCatchClauses(context, statement.catches);
    const finallyBlock = statement.finallyBlock ? this.compileBlock(context, statement.finallyBlock) : undefined;
    return (frame) => {
      const { completion, pending } = attemptTry(frame, body, handle);
      const finallyCompletion = finallyBlock?.(frame);
      if (finallyCompletion) return finallyCompletion;
      if (pending) throw pending;
      return completion;
    };
  }

  /** Compiles catch clauses into a handler that rethrows an exception none of them catches. */
  protected compileCatchClauses(context: MethodContext, clauses: CatchClause[]): CatchHandler {
    const handlers = clauses.map((clause) => {
      const classes = clause.types.map((type) => this.resolveThrowable(type));
      const exec = this.withScope(context, () => {
        const type = classes.length === 1 ? classes[0].type : this.builtins.throwableClass.type;
        const slot = this.declareLocal(context, clause, clause.name, type);
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

/** Decides what a loop does with its body's abrupt completion. */
function loopCompletion(completion: Completion, labels: string[]): Completion | undefined | 'continue' {
  if (completion.kind === 'continue' && (completion.label === undefined || labels.includes(completion.label))) {
    return 'continue';
  }
  if (completion.kind === 'break' && completion.label === undefined) return;
  return completion;
}
