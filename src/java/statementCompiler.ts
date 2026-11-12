import type {
  Block,
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
import { InvocationCompiler } from './invocationCompiler';
import { nullMessage, typeDescription } from './nullMessages';
import { bindingsAfter, bindingsWhen } from './patternBindings';
import { booleanConstants, canCompleteNormally } from './reachability';
import { type Frame, JavaThrow, throwBuiltin, UNASSIGNED } from './runtime';
import { isObjectCreation, onlyCalls } from './stepRules';
import {
  asSuper,
  erasure,
  isPrimitive,
  isReference,
  isSubclass,
  type JavaType,
  sameType,
  typeName,
  upperBound,
  wildcardBound,
} from './types';
import { JavaArray, JavaObject, type Value } from './values';

const BREAK: BreakCompletion = { kind: 'break', label: undefined };
const CONTINUE: ContinueCompletion = { kind: 'continue', label: undefined };

/** Compiles statements into closures that report how they complete. */
export abstract class StatementCompiler extends InvocationCompiler {
  protected abstract compileSwitch(context: MethodContext, statement: Extract<Statement, { kind: 'switch' }>): Exec;

  protected abstract compileYield(context: MethodContext, statement: Extract<Statement, { kind: 'yield' }>): Exec;

  protected abstract compileTry(context: MethodContext, statement: Extract<Statement, { kind: 'try' }>): Exec;

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

  // code-gauge-allow functionNcss 52 -- One case per statement kind, each delegating to its own compiler.
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
        return this.compileFor(context, statement);
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
        return this.compileSynchronized(context, statement);
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
    this.introduceBindings(context, bindingsAfter(statement));
    return (frame) => (condition(frame) ? consequence(frame) : otherwise?.(frame));
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- While and do statements share one loop, which differs only in where the condition runs.
  protected compileWhile(context: MethodContext, statement: Extract<Statement, { kind: 'while' | 'do' }>): Exec {
    const labels = this.takeLabels(context);
    const isDo = statement.kind === 'do';
    // A do statement's body runs before its condition, so only a while statement's body sees the condition's bindings.
    const body = isDo ? this.compileLoopBody(context, statement.body, labels) : undefined;
    const condition = this.compileCondition(context, statement.condition);
    if (!isDo) this.checkLoopBodyReachable(statement.condition, statement.body);
    const loopBody =
      body ??
      this.withBindings(context, bindingsWhen(statement.condition, true), () =>
        this.compileLoopBody(context, statement.body, labels)
      );
    this.introduceBindings(context, bindingsAfter(statement));
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
    const message = nullMessage('Cannot throw exception', value.source);
    return (frame) => {
      const exception = value.run(frame);
      if (!(exception instanceof JavaObject)) throwBuiltin(frame, 'NullPointerException', message);
      throw new JavaThrow(exception);
    };
  }

  protected compileSynchronized(context: MethodContext, statement: Extract<Statement, { kind: 'synchronized' }>): Exec {
    const lock = this.compileValue(context, statement.lock);
    if (!isReference(lock.type)) {
      this.error(
        statement.lock,
        `synchronized には参照型の値が必要ですが、${typeName(lock.type)} 型の値が書かれています。`
      );
    }
    const body = this.compileBlock(context, statement.body);
    const message = nullMessage('Cannot enter synchronized block', lock.source);
    return (frame) => {
      if (lock.run(frame) === undefined) throwBuiltin(frame, 'NullPointerException', message);
      return body(frame);
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
      slot = this.declareLocal(context, declarator, declarator.name, type);
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
    const returned = this.compileValueFor(context, statement.value, context.returnType);
    context.returnedTypes?.push(returned.type);
    const value = this.convert(returned, context.returnType, 'assignment', statement.value).run;
    return (frame) => ({ kind: 'return', value: value(frame) });
  }

  /** Rejects the body of a `while` or `for` loop whose condition is the constant `false`, which never runs (JLS 14.22). */
  protected checkLoopBodyReachable(condition: Expression, body: Statement): void {
    if (booleanConstants.get(condition) === false) this.error(body, 'この文は実行されることがありません。');
  }

  protected compileFor(context: MethodContext, statement: Extract<Statement, { kind: 'for' }>): Exec {
    const labels = this.takeLabels(context);
    const loop = this.withScope(context, () => this.compileForLoop(context, statement, labels));
    // The condition's bindings outlive the loop, whose header variables go out of scope with it.
    this.introduceBindings(context, bindingsAfter(statement));
    return loop;
  }

  protected compileForLoop(
    context: MethodContext,
    statement: Extract<Statement, { kind: 'for' }>,
    labels: string[]
  ): Exec {
    const { init: initSyntax } = statement;
    const init = Array.isArray(initSyntax)
      ? this.compileForHeaderPart(statement, initSyntax.length === 0, () => this.compileStatements(context, initSyntax))
      : this.compileForHeaderPart(
          statement,
          initSyntax.declarators.every((declarator) => !declarator.initializer),
          () => this.compileLocal(context, initSyntax)
        );
    const { condition: conditionSyntax } = statement;
    const condition = conditionSyntax ? this.compileCondition(context, conditionSyntax) : () => true;
    if (conditionSyntax) this.checkLoopBodyReachable(conditionSyntax, statement.body);
    // The condition's bindings are in scope in the update as well as in the body (JLS 6.3.2.5).
    const { update, body } = this.withBindings(
      context,
      conditionSyntax ? bindingsWhen(conditionSyntax, true) : [],
      () => ({
        update: this.compileForHeaderPart(statement, statement.update.length === 0, () =>
          this.compileStatements(context, statement.update)
        ),
        body: this.compileLoopBody(context, statement.body, labels),
      })
    );
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

  /** Compiles the init or the update so that, unless it is empty, it records one step after it runs as a whole. */
  protected compileForHeaderPart(
    statement: Extract<Statement, { kind: 'for' }>,
    isEmpty: boolean,
    compile: () => Exec
  ): Exec {
    const stepRow = this.stepRowOf(statement);
    this.compilesForHeader = true;
    try {
      const exec = compile();
      if (stepRow === undefined || isEmpty) return exec;
      return (frame) => {
        exec(frame);
        frame.runtime.steps.step(stepRow);
        return;
      };
    } finally {
      this.compilesForHeader = false;
    }
  }

  protected compileForEach(context: MethodContext, statement: Extract<Statement, { kind: 'forEach' }>): Exec {
    const labels = this.takeLabels(context);
    const iterable = this.compileValue(context, statement.iterable);
    const elementType = this.elementTypeOf(statement.iterable, iterable.type);
    const declaredType = statement.type.kind === 'var' ? elementType : this.resolveType(statement.type);
    // The element waits in the temporaries, where the conversion reads it, until the variable holds it. An
    // iterable's element comes from Iterator.next(), whose erased result the conversion casts, as javac does.
    const erasedElement = iterable.type.kind === 'array' ? undefined : this.builtins.objectClass.type;
    const element: CompiledValue = {
      kind: 'value',
      type: elementType,
      erasedType:
        isReference(elementType) && !sameType(erasure(elementType), this.builtins.objectClass.type)
          ? erasedElement
          : undefined,
      run: (frame) => frame.temporaries.at(-1),
    };
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
    return this.forEachLoop(iterable, runIteration);
  }

  /** Runs `runIteration` on each element of an array or `Iterable`, which must not be null. */
  protected forEachLoop(
    iterable: CompiledValue,
    runIteration: (frame: Frame, value: Value) => Completion | undefined | 'continue'
  ): Exec {
    if (iterable.type.kind !== 'array') {
      const iteratorMessage = nullMessage(
        `Cannot invoke "${typeDescription(this.builtins, iterable.type)}.iterator()"`,
        iterable.source
      );
      return (frame) => {
        const source = iterable.run(frame);
        if (source === undefined) return throwBuiltin(frame, 'NullPointerException', iteratorMessage);
        return iterateIterable(frame, source, (value) => runIteration(frame, value));
      };
    }
    const lengthMessage = nullMessage('Cannot read the array length', iterable.source);
    return (frame) => {
      const array = iterable.run(frame);
      if (!(array instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException', lengthMessage);
      return iterate(frame, array, (value) => runIteration(frame, value));
    };
  }

  /** The type of the elements a for-each loop walks: an array's, or the type argument of an `Iterable`. */
  protected elementTypeOf(span: Span, type: JavaType): JavaType {
    if (type.kind === 'array') return type.element;
    const bound = upperBound(type);
    const iterableType = bound.kind === 'class' ? asSuper(bound, this.builtins.collections.iterableClass) : undefined;
    if (!iterableType) return this.error(span, '拡張 for 文では配列か、List などの Iterable しか使えません。');
    const elementArg = iterableType.args?.[0];
    if (!elementArg) return this.builtins.objectClass.type;
    return wildcardBound(elementArg);
  }

  protected isAnswered(type: JavaType): boolean {
    return isPrimitive(type) || (type.kind === 'class' && type.cls === this.builtins.stringClass);
  }
}

/** Runs a for-each loop over `array`, which keeps its turtles alive while the loop runs, even when no variable holds it. */
export function iterate(
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
export function loopCompletion(completion: Completion, labels: string[]): Completion | undefined | 'continue' {
  if (completion.kind === 'continue' && (completion.label === undefined || labels.includes(completion.label))) {
    return 'continue';
  }
  if (completion.kind === 'break' && completion.label === undefined) return;
  return completion;
}
