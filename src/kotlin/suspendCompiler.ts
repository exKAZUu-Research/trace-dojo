// code-gauge-allow-file fileNcss -- the file holds one layer of the compiler, whose parts share its state.
import type { Block, Expression, FunctionDecl, LambdaExpression, Statement, TypeRef } from './ast';
import {
  type Compiled,
  convertRepr,
  Flow,
  FunctionContext,
  type LoopContext,
  ReceiverSymbol,
  reprOf,
  Scope,
} from './compilerBase';
import { type FunctionEntry } from './declarationCompiler';
import { returnRepr } from './dispatch';
import { LocalCompiler } from './localCompiler';
import { framedInstanceTest } from './reified';
import { type Frame, KotlinThrow, LoopSignal, MISSING, ReturnSignal, SuspendCall, type Suspension } from './runtime';
import {
  assignedForm,
  forAsWhile,
  hiddenName,
  isShortCircuit,
  propertyStatement,
  safeCallAsIf,
  whenAsIf,
} from './suspendRewrites';
import type { ClassSymbol, FunctionSymbol } from './symbols';
import { commonSupertype } from './typeRelations';
import { type FunctionType, hasOpenVariables, isNonNullClass, isNothing, type KType, NOTHING, resolved } from './types';
import { KObject, UNIT, type Value } from './values';

/** A step of a coroutine: what a statement or an expression does, suspending where a suspend call it makes suspends. */
type Gen = (frame: Frame) => Suspension;

/** The code a suspension cannot reach through, as kotlinc allows suspend calls only outside it. */
const OPAQUE_KINDS = new Set(['lambda', 'anonymousFunction', 'object', 'class', 'function']);

/** The library functions whose lambda an inline call runs in place, which a coroutine may suspend inside. */
const LOOPING_CALLS = new Set(['repeat', 'forEach']);

/** Runs a value that may be a suspend call, which the coroutine performs, giving the call's result. */
function* settle(frame: Frame, value: Value): Suspension {
  if ((value as unknown) instanceof SuspendCall) return yield* (value as unknown as SuspendCall).run(frame);
  return value;
}

function synchronous(evaluate: (frame: Frame) => Value): Gen {
  // oxlint-disable-next-line require-yield -- a step that never suspends is still a coroutine's step.
  return function* (frame) {
    return evaluate(frame);
  };
}

/**
 * Compiles suspend functions and suspend lambdas as coroutines' steps: generators that yield where a suspend call
 * suspends, as `yield` of a sequence builder does. A statement that makes no suspend call compiles as any other; the
 * rest compile here, where a suspend call may be a statement, a variable's initializer, an assignment's value, or a
 * returned value, inside `if`, `when`, `try`, loops, and the lambdas of `repeat` and `forEach`.
 */
export abstract class SuspendCompiler extends LocalCompiler {
  protected compileSuspendFunction(
    entry: FunctionEntry,
    scope: Scope,
    context: FunctionContext,
    defaults: (Eval | undefined)[]
  ): void {
    const { decl, symbol } = entry;
    const run = withDefaults(defaults, this.compileSuspendBody(scope, context, decl, symbol));
    const { info } = context;
    const local = this.localCapture(symbol.owner, context);
    const none: unknown[] = [];
    symbol.invokeSuspend = (caller, receiver, args, callRow) => {
      const { captured, enclosing } = local?.(caller, receiver) ?? { captured: none, enclosing: undefined };
      return caller.runtime.callSuspend(info, caller, captured, receiver, args, callRow, run, enclosing);
    };
    symbol.invoke = suspendOnly(symbol.name);
  }

  /** A local suspend function's body with its parameters' defaults, which its declaration's frame runs as a coroutine's step. */
  protected compileLocalSuspendBody(
    scope: Scope,
    context: FunctionContext,
    decl: FunctionDecl,
    symbol: FunctionSymbol
  ): (frame: Frame) => Suspension {
    context.isSuspend = true;
    this.suspendFunctionNames.add(symbol.name);
    const variables = symbol.params.map((param, index) => {
      const type = param.isVararg ? this.varargType(param.type) : param.type;
      const variable = this.newParameter(scope, context, param.name, type, decl.params[index].row);
      this.flow.assigned.add(variable);
      return variable;
    });
    const defaults = this.compileParameterDefaults(decl.params, symbol.params, variables, scope, context);
    symbol.invoke = suspendOnly(symbol.name);
    return withDefaults(defaults, this.compileSuspendBody(scope, context, decl, symbol));
  }

  /** A suspend function's body, which returns its value as the function's result representation. */
  private compileSuspendBody(scope: Scope, context: FunctionContext, decl: FunctionDecl, symbol: FunctionSymbol): Gen {
    const body = decl.body as NonNullable<FunctionDecl['body']>;
    context.restrictedScope = this.restrictedScopeOf(symbol.extensionReceiver);
    let gen: Gen;
    if (body.kind === 'expression') {
      if (symbol.returnType) {
        context.returnType = symbol.returnType;
        context.returnRepr = returnRepr(symbol);
      }
      const value = this.compileSuspendValue(scope, context, body.expression, symbol.returnType);
      symbol.returnType ??= resolved(value.type);
      const convert = this.reprConverter(value.repr, returnRepr(symbol));
      gen = function* (frame) {
        return convert(frame, yield* value.gen(frame));
      };
    } else {
      context.returnType = symbol.returnType as KType;
      context.returnRepr = returnRepr(symbol);
      gen = this.compileSuspendStatements(scope, context, body.block.statements);
      if (!isNonNullClass(symbol.returnType, this.core.unit) && !this.flow.isDead)
        this.error(body.block.endRow, `関数 ${symbol.name} の最後に return を書いてください。`);
      const statements = gen;
      gen = function* (frame) {
        yield* statements(frame);
        return UNIT;
      };
    }
    return gen;
  }

  // code-gauge-allow functionNcss -- the parts of the construct this function compiles follow one another, and splitting them would only rename them.
  // code-gauge-allow functionCognitiveComplexity -- an inline lambda and a suspend lambda differ only in a few of the parts a lambda has.
  protected compileSuspendLambda(
    scope: Scope,
    context: FunctionContext,
    lambda: LambdaExpression,
    expected: FunctionType,
    inline = false
  ): Compiled {
    // An inline lambda's `return` leaves the function around it, and its `break` the loops around it.
    const returnTarget = inline ? (context.returnTarget ?? (context.isLambda ? undefined : context)) : undefined;
    const lambdaContext = new FunctionContext(context, true, 'lambda', context.info.isLibrary, returnTarget);
    lambdaContext.isSuspend = true;
    lambdaContext.inlineLambda = inline;
    if (inline) lambdaContext.loops = [...context.loops];
    lambdaContext.label = lambda.label;
    const lambdaScope = new Scope(scope, lambdaContext);
    const params = this.lambdaParameters(scope, lambda, expected.params);
    const receiverType = expected.receiver;
    if (receiverType) lambdaScope.receiver = new ReceiverSymbol(receiverType, lambdaContext, undefined, lambda.label);
    lambdaContext.restrictedScope = inline ? suspendScopeOf(context) : this.restrictedScopeOf(receiverType);
    const outerFlow = this.flow;
    this.flow = outerFlow.copy();
    this.forgetAssignedIn(scope, lambda.statements);
    this.contextVariables(lambdaScope, lambdaContext, expected.contextTypes ?? [], lambda.row);
    const paramReprs = params.map((param) => {
      const variable = this.newParameter(lambdaScope, lambdaContext, param.name, param.type, param.row);
      this.flow.assigned.add(variable);
      return reprOf(this.core, variable.type);
    });
    const expectedReturn = resolved(expected.returnType);
    const returnsUnit = isNonNullClass(expectedReturn, this.core.unit);
    // `return@label value` ends the lambda with the value, as its last expression would.
    lambdaContext.lambdaResult = {
      expected: hasOpenVariables(expectedReturn) ? undefined : expectedReturn,
      returnsUnit,
      returned: [],
    };
    let body: Gen;
    let resultType: KType = this.unitType;
    try {
      const statements = lambda.statements;
      const last = statements.at(-1);
      if (!returnsUnit && last?.kind === 'expressionStatement') {
        const before = this.compileSuspendStatements(lambdaScope, lambdaContext, statements.slice(0, -1));
        const value = this.compileSuspendValue(
          lambdaScope,
          lambdaContext,
          last.expression,
          resolved(expected.returnType)
        );
        const { returned } = lambdaContext.lambdaResult;
        resultType =
          returned.length === 0 ? value.type : commonSupertype([value.type, ...returned.map(({ type }) => type)]);
        const convert = this.reprConverter(value.repr, 'ref');
        body = function* (frame) {
          yield* before(frame);
          return convert(frame, yield* value.gen(frame));
        };
      } else {
        const statements_ = this.compileSuspendStatements(lambdaScope, lambdaContext, statements);
        body = function* (frame) {
          yield* statements_(frame);
          return UNIT;
        };
      }
    } finally {
      this.flow = outerFlow;
    }
    const build = this.captureBuilder(context, lambdaContext);
    const { info } = lambdaContext;
    const hasReceiver = receiverType !== undefined;
    const unboxers = paramReprs.map((repr) => this.reprConverter('ref', repr));
    const type: FunctionType = {
      kind: 'function',
      receiver: receiverType,
      params: params.map((param) => param.type),
      returnType: resultType,
      nullable: false,
      isSuspend: true,
      contextTypes: expected.contextTypes,
    };
    const functionClass = this.core.function;
    return {
      type,
      repr: 'ref',
      eval: (frame) => {
        const env = build(frame);
        return suspendLambdaValue(functionClass, env, (caller, args) => {
          const receiver = hasReceiver ? args[0] : undefined;
          // Calls pass boxed values, which parameters of primitive types hold unboxed, after the context arguments.
          const contexts = expected.contextTypes?.length ?? 0;
          const values = (hasReceiver ? args.slice(1) : args).map((value, index) =>
            index < contexts ? value : unboxers[index - contexts](caller, value)
          );
          return caller.runtime.callSuspend(info, caller, env, receiver, values, undefined, body, frame);
        });
      },
    };
  }

  protected compileSuspendingInlineLambda(
    scope: Scope,
    context: FunctionContext,
    lambda: LambdaExpression,
    expected: FunctionType
  ): Compiled | undefined {
    if (!this.mayYield(scope, lambda.statements)) return undefined;
    const compiled = this.compileSuspendLambda(scope, context, lambda, { ...expected, isSuspend: true }, true);
    // Its type is the inline function's parameter type, which calls resolve against.
    return { ...compiled, type: { ...(compiled.type as FunctionType), isSuspend: undefined }, suspending: true };
  }

  /** The class of a sequence builder's scope that a suspend context's receiver is, which restricts its suspend calls. */
  private restrictedScopeOf(receiverType: KType | undefined): ClassSymbol | undefined {
    const type = receiverType && resolved(receiverType);
    const scopeClass = this.findQualifiedClass(['kotlin', 'sequences', 'SequenceScope']);
    return type?.kind === 'class' && scopeClass && type.cls.isSubclassOf(scopeClass) ? scopeClass : undefined;
  }

  // Statements.

  private compileSuspendStatements(
    scope: Scope,
    context: FunctionContext,
    statements: Statement[],
    inScope = false
  ): Gen {
    const blockScope = inScope ? scope : new Scope(scope, context);
    const steps = statements.map((statement) => this.compileSuspendStatement(blockScope, context, statement));
    return function* (frame) {
      for (const step of steps) yield* step(frame);
      return UNIT;
    };
  }

  private compileSuspendBlock(scope: Scope, context: FunctionContext, block: Block): Gen {
    return this.compileSuspendStatements(scope, context, block.statements);
  }

  // code-gauge-allow functionNcss -- the parts of the construct this function compiles follow one another, and splitting them would only rename them.
  // code-gauge-allow functionCognitiveComplexity -- one case per kind of statement that suspends in its own way.
  private compileSuspendStatement(scope: Scope, context: FunctionContext, statement: Statement): Gen {
    if (!this.mayYield(scope, statement)) {
      const exec = this.compileStatement(scope, context, statement);
      return synchronous((frame) => {
        exec(frame);
        return UNIT;
      });
    }
    switch (statement.kind) {
      case 'expressionStatement': {
        const value = this.compileSuspendValue(scope, context, statement.expression, undefined, false);
        // A statement whose value never comes, as a call of an inline function whose lambda returns, ends the code.
        if (isNothing(resolved(value.type))) this.flow.isDead = true;
        return value.gen;
      }
      case 'property': {
        if (statement.delegate) {
          // `val x by f()` makes its delegate first, as kotlinc does, which then gives the variable its values.
          const held = hiddenName('delegate');
          return this.compileSuspendStatements(
            scope,
            context,
            [
              propertyStatement(statement.row, held, statement.delegate),
              { ...statement, delegate: { kind: 'name', row: statement.row, name: held } },
            ],
            true
          );
        }
        if (!statement.initializer) return this.unsupportedSuspension(statement.row);
        const declared = statement.type ? this.resolveType(scope, statement.type) : undefined;
        const value = this.compileSuspendValue(scope, context, statement.initializer, declared);
        const type = declared ?? resolved(value.type);
        const variable = this.newVariable(scope, context, statement.name, type, statement.isVar, statement.row);
        this.flow.assigned.add(variable);
        this.flow.maybeAssigned.add(variable);
        const { write } = this.variableAccess(context, variable);
        const convert = this.reprConverter(value.repr, reprOf(this.core, type));
        return function* (frame) {
          write(frame, convert(frame, yield* value.gen(frame)));
          return UNIT;
        };
      }
      case 'assignment': {
        const variable = statement.target.kind === 'name' ? this.findVariable(scope, statement.target.name) : undefined;
        if (statement.operator !== '=' || !variable) return this.compileSuspendAssignment(scope, context, statement);
        if (!variable.isVar && this.flow.maybeAssigned.has(variable))
          this.error(statement.row, `val で宣言した ${variable.name} には、再び代入できません。`);
        const value = this.compileSuspendValue(scope, context, statement.value, variable.type);
        this.flow.assigned.add(variable);
        this.flow.maybeAssigned.add(variable);
        const { write } = this.variableAccess(context, variable);
        const convert = this.reprConverter(value.repr, reprOf(this.core, variable.type));
        return function* (frame) {
          write(frame, convert(frame, yield* value.gen(frame)));
          return UNIT;
        };
      }
      case 'while':
      case 'doWhile': {
        return this.compileSuspendLoop(scope, context, statement);
      }
      case 'for': {
        return this.compileSuspendStatements(scope, context, forAsWhile(statement));
      }
      case 'destructuring': {
        const holder = hiddenName('destructured');
        return this.compileSuspendStatements(scope, context, [
          propertyStatement(statement.row, holder, statement.initializer),
          { ...statement, initializer: { kind: 'name', row: statement.row, name: holder } },
        ]);
      }
      default: {
        return this.unsupportedSuspension(statement.row);
      }
    }
  }

  // code-gauge-allow functionNcss -- the parts of the construct this function compiles follow one another, and splitting them would only rename them.
  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private compileSuspendLoop(
    scope: Scope,
    context: FunctionContext,
    statement: Extract<Statement, { kind: 'while' | 'doWhile' }>
  ): Gen {
    this.forgetAssignedIn(scope, [...statement.body.statements]);
    this.forgetAssignedIn(scope, statement.condition);
    const before = this.flow.copy();
    const loop: LoopContext = {
      identity: {},
      label: statement.label,
      breaks: [],
      continues: [],
      valWrites: new Map(),
      outerVals: new Set(),
    };
    const isDoWhile = statement.kind === 'doWhile';
    const bodyScope = new Scope(scope, context);
    const conditionYields = this.mayYield(scope, statement.condition);
    const compileTest = (testScope: Scope): Gen =>
      conditionYields
        ? this.compileSuspendValue(testScope, context, statement.condition, this.core.boolean.type).gen
        : synchronous(this.compileCondition(testScope, context, statement.condition).compiled.eval);
    let condition = isDoWhile ? undefined : compileTest(scope);
    context.loops.push(loop);
    let body: Gen;
    try {
      body = this.compileSuspendBlock(bodyScope, context, statement.body);
    } finally {
      context.loops.pop();
    }
    if (isDoWhile) condition = compileTest(bodyScope);
    this.flow = Flow.merge([before, this.flow, ...loop.breaks]);
    const test = condition as Gen;
    const { identity } = loop;
    return function* (frame) {
      // `do { } while (c)` tests only after each run of its body, `while (c) { }` only before.
      for (;;) {
        if (!isDoWhile && !((yield* test(frame)) as boolean)) return UNIT;
        frame.runtime.spend();
        try {
          yield* body(frame);
        } catch (error) {
          if (!(error instanceof LoopSignal) || error.loop !== identity) throw error;
          if (error.isBreak) return UNIT;
        }
        if (isDoWhile && !((yield* test(frame)) as boolean)) return UNIT;
      }
    };
  }

  // Expressions.

  /**
   * An expression's value, which a suspend call that is the expression, or the result of its branches, may give. An
   * expression whose value is not used (`asValue` false) runs its branches as statements.
   */
  // code-gauge-allow functionCognitiveComplexity -- one case per kind of expression that suspends in its own way.
  // code-gauge-allow functionNcss -- one case per kind of expression that suspends in its own way.
  private compileSuspendValue(
    scope: Scope,
    context: FunctionContext,
    expression: Expression,
    expected: KType | undefined,
    asValue = true
  ): SuspendValue {
    switch (expression.kind) {
      case 'parenthesized': {
        return this.compileSuspendValue(scope, context, expression.expression, expected, asValue);
      }
      case 'call': {
        const looping = asValue ? undefined : this.loopingCall(scope, expression);
        if (looping)
          return { gen: this.compileSuspendStatements(scope, context, looping), type: this.unitType, repr: 'ref' };
        if (this.isYieldingSafeCall(scope, expression))
          return this.compileSuspendValue(scope, context, safeCallAsIf(expression), expected, asValue);
        return this.compileHoisted(scope, context, expression, expected);
      }
      case 'binary': {
        if (isShortCircuit(expression) && this.mayYield(scope, expression.right))
          return this.compileBranchValue(scope, context, expression, expected);
        return this.compileHoisted(scope, context, expression, expected);
      }
      case 'if': {
        if (asValue && expression.elseBranch) return this.compileBranchValue(scope, context, expression, expected);
        if (this.mayYield(scope, expression.condition)) {
          // A condition that suspends gives its value first, without the smart casts a plain condition gives.
          const held = hiddenName('condition');
          const statements = [
            propertyStatement(expression.row, held, expression.condition),
            {
              kind: 'expressionStatement' as const,
              row: expression.row,
              expression: { ...expression, condition: { kind: 'name' as const, row: expression.row, name: held } },
            },
          ];
          return { gen: this.compileSuspendStatements(scope, context, statements), type: this.unitType, repr: 'ref' };
        }
        const condition = this.compileCondition(scope, context, expression.condition);
        const before = this.flow;
        this.flow = this.withNarrowing(before, condition.whenTrue);
        const thenBranch = this.compileSuspendBlock(scope, context, expression.thenBranch);
        const afterThen = this.flow;
        this.flow = this.withNarrowing(before, condition.whenFalse);
        const elseBranch = expression.elseBranch
          ? this.compileSuspendBlock(scope, context, expression.elseBranch)
          : synchronous(() => UNIT);
        this.flow = Flow.merge([afterThen, this.flow]);
        const test = condition.compiled.eval;
        return {
          *gen(frame) {
            return yield* ((test(frame) as boolean) ? thenBranch : elseBranch)(frame);
          },
          type: this.unitType,
          repr: 'ref',
        };
      }
      case 'when': {
        if (asValue) return this.compileBranchValue(scope, context, expression, expected);
        return {
          gen: this.compileSuspendStatements(scope, context, whenAsIf(expression)),
          type: this.unitType,
          repr: 'ref',
        };
      }
      case 'try': {
        if (asValue) return this.compileBranchValue(scope, context, expression, expected);
        return this.compileSuspendTry(scope, context, expression);
      }
      case 'return': {
        return this.compileSuspendReturn(scope, context, expression);
      }
      default: {
        return this.compileHoisted(scope, context, expression, expected);
      }
    }
  }

  /**
   * The value of an `if`, `when`, `try`, or short-circuit expression whose branches suspend: its type is the one the
   * expression has, and its branches run as statements that end by assigning their values to a variable it reads.
   */
  private compileBranchValue(
    scope: Scope,
    context: FunctionContext,
    expression: Expression,
    expected: KType | undefined
  ): SuspendValue {
    let type: KType = this.unitType;
    // The expression's type, and the errors kotlinc reports for it, such as a `when` that covers too little.
    const error = this.probeApplicability(
      context,
      (probe) => {
        type = this.compileExpression(scope, probe, expression, expected).type;
      },
      true
    );
    if (error) throw error;
    const holderScope = new Scope(scope, context);
    const name = hiddenName('value');
    const variable = this.newVariable(holderScope, context, name, type, true, expression.row);
    const target: Expression = { kind: 'name', row: expression.row, name };
    const statements = assignedForm(expression, (value) => ({
      kind: 'assignment',
      row: value.row,
      operator: '=',
      target,
      value,
    }));
    const run = this.compileSuspendStatements(holderScope, context, statements, true);
    this.flow.assigned.add(variable);
    const { read } = this.variableAccess(context, variable);
    return {
      *gen(frame) {
        yield* run(frame);
        return read(frame);
      },
      type,
      repr: reprOf(this.core, type),
    };
  }

  /**
   * An assignment whose value or target suspends, as the statements that give its target's receiver and indices,
   * then its value, to variables, in kotlinc's order, before the assignment itself.
   */
  private compileSuspendAssignment(
    scope: Scope,
    context: FunctionContext,
    statement: Extract<Statement, { kind: 'assignment' }>
  ): Gen {
    const { row } = statement;
    const before: Statement[] = [];
    const held = (expression: Expression): Expression => {
      if (expression.kind === 'this' || expression.kind === 'super') return expression;
      const name = hiddenName('part');
      before.push(propertyStatement(expression.row, name, expression));
      return { kind: 'name', row: expression.row, name };
    };
    let { target } = statement;
    if (target.kind === 'member') {
      if (target.isSafe) {
        // `a?.p = f()` runs `f()` only when `a` is not null.
        const receiver = hiddenName('receiver');
        const assignment: Statement = {
          ...statement,
          target: { ...target, receiver: { kind: 'name', row, name: receiver }, isSafe: false },
        };
        return this.compileSuspendStatements(scope, context, [
          propertyStatement(row, receiver, target.receiver),
          {
            kind: 'expressionStatement',
            row,
            expression: {
              kind: 'if',
              row,
              condition: {
                kind: 'binary',
                row,
                operator: '!=',
                left: { kind: 'name', row, name: receiver },
                right: { kind: 'null', row },
              },
              thenBranch: { row, endRow: row, isBraced: true, statements: [assignment] },
              elseBranch: undefined,
            },
          },
        ]);
      }
      target = { ...target, receiver: held(target.receiver) };
    } else if (target.kind === 'index') {
      target = { ...target, receiver: held(target.receiver), indices: target.indices.map(held) };
    }
    const value = held(statement.value);
    return this.compileSuspendStatements(scope, context, [...before, { ...statement, target, value }]);
  }

  /** Whether a call is `a?.f(x)` whose arguments suspend, which run only when `a` is not null. */
  private isYieldingSafeCall(scope: Scope, call: Extract<Expression, { kind: 'call' }>): boolean {
    return (
      call.callee.kind === 'member' &&
      call.callee.isSafe &&
      (this.mayYield(scope, call.args) || this.mayYield(scope, call.trailingLambda))
    );
  }

  /**
   * An expression whose parts make suspend calls, which run first, each into a variable that the expression then
   * reads, so that only the expression itself, when it is a suspend call, suspends as it ends.
   */
  private compileHoisted(
    scope: Scope,
    context: FunctionContext,
    expression: Expression,
    expected: KType | undefined
  ): SuspendValue {
    const before: Statement[] = [];
    const rewritten = this.hasNestedSuspension(scope, expression)
      ? this.hoistParts(scope, expression, before)
      : expression;
    const hoistScope = new Scope(scope, context);
    const prior = this.compileSuspendStatements(hoistScope, context, before, true);
    const compiled = this.compileExpression(hoistScope, context, rewritten, expected);
    const evaluate = compiled.eval;
    return {
      *gen(frame) {
        yield* prior(frame);
        return yield* settle(frame, evaluate(frame));
      },
      type: compiled.type,
      repr: compiled.repr,
    };
  }

  /**
   * An expression with the suspend calls in its parts replaced by variables that `before` assigns. Parts run in
   * kotlinc's order: a part before one that suspends, which may have effects or read what the suspend call changes,
   * runs into a variable first as well.
   */
  // code-gauge-allow functionCognitiveComplexity -- one case per kind of expression whose parts may suspend.
  // code-gauge-allow functionNcss -- one case per kind of expression whose parts may suspend.
  private hoistParts(scope: Scope, expression: Expression, before: Statement[]): Expression {
    const hold = (part: Expression): Expression => {
      const name = hiddenName('suspended');
      before.push(propertyStatement(part.row, name, part));
      return { kind: 'name', row: part.row, name };
    };
    const hoist = (part: Expression): Expression => {
      if (!this.mayYield(scope, part)) return part;
      // A branch that suspends gives its value through its own statements.
      if (this.isBranchValue(scope, part)) return hold(part);
      const inner = this.hoistParts(scope, part, before);
      return this.isSuspendingCall(scope, part) ? hold(inner) : inner;
    };
    const inOrder = (parts: Expression[]): Expression[] => {
      const last = parts.findLastIndex((part) => this.mayYield(scope, part));
      return parts.map((part, index) => {
        if (index > last) return part;
        if (index < last && !this.mayYield(scope, part) && hasEffects(part)) return hold(part);
        return hoist(part);
      });
    };
    switch (expression.kind) {
      case 'call': {
        return withCallParts(expression, inOrder);
      }
      case 'member': {
        return { ...expression, receiver: hoist(expression.receiver) };
      }
      case 'binary':
      case 'infix':
      case 'in': {
        // A right side that suspends runs only when the left side asks; a left side alone runs first anyway.
        if (isShortCircuit(expression) && this.mayYield(scope, expression.right)) return hold(expression);
        const [left, right] = inOrder([expression.left, expression.right]);
        return { ...expression, left, right } as Expression;
      }
      case 'prefix':
      case 'postfix':
      case 'is':
      case 'as': {
        return { ...expression, operand: hoist(expression.operand) } as Expression;
      }
      case 'throw': {
        return { ...expression, value: hoist(expression.value) };
      }
      case 'index': {
        const [receiver, ...indices] = inOrder([expression.receiver, ...expression.indices]);
        return { ...expression, receiver: receiver as Expression, indices };
      }
      case 'string': {
        return withTemplateParts(expression, inOrder);
      }
      case 'collectionLiteral': {
        return { ...expression, elements: inOrder(expression.elements) };
      }
      case 'parenthesized': {
        return { ...expression, expression: hoist(expression.expression) };
      }
      case 'if':
      case 'when':
      case 'try': {
        return hold(expression);
      }
      default: {
        return this.unsupportedSuspension(expression.row);
      }
    }
  }

  /** Whether an expression is a call that suspends: of a suspend function, or of a suspend function value. */
  private isSuspendingCall(scope: Scope, expression: Expression): boolean {
    return (
      expression.kind === 'call' &&
      (this.isSuspendCallee(scope, expression.callee) || this.passesSuspendingFunction(scope, expression))
    );
  }

  /** Whether an expression gives its value through branches, some of which suspend. */
  private isBranchValue(scope: Scope, expression: Expression): boolean {
    if (expression.kind === 'if' || expression.kind === 'when' || expression.kind === 'try') return true;
    if (isShortCircuit(expression)) return this.mayYield(scope, expression.right);
    return expression.kind === 'call' && this.isYieldingSafeCall(scope, expression);
  }

  private compileSuspendTry(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'try' }>
  ): { gen: Gen; type: KType; repr: 'ref' } {
    const body = this.compileSuspendBlock(scope, context, expression.body);
    const catches = expression.catches.map((clause) => {
      const catchScope = new Scope(scope, context);
      const type = this.resolveType(catchScope, clause.type);
      const variable = this.newVariable(catchScope, context, clause.name, type, false, clause.row);
      this.flow.assigned.add(variable);
      const { write } = this.variableAccess(context, variable);
      return {
        test: framedInstanceTest(this.core, type),
        write,
        body: this.compileSuspendBlock(catchScope, context, clause.body),
      };
    });
    const final = expression.finally && this.compileSuspendBlock(scope, context, expression.finally);
    return {
      *gen(frame) {
        try {
          return yield* body(frame);
        } catch (error) {
          if (!(error instanceof KotlinThrow)) throw error;
          const clause = catches.find(({ test }) => test(frame, error.value));
          if (!clause) throw error;
          clause.write(frame, error.value);
          return yield* clause.body(frame);
        } finally {
          if (final) yield* final(frame);
        }
      },
      type: this.unitType,
      repr: 'ref',
    };
  }

  private compileSuspendReturn(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'return' }>
  ): SuspendValue {
    if (expression.label !== undefined && expression.value) {
      // `return@label f()` gives its value first, and then returns as any `return@label` does.
      const { row } = expression;
      const held = hiddenName('returned');
      const gen = this.compileSuspendStatements(scope, context, [
        propertyStatement(row, held, expression.value),
        { kind: 'expressionStatement', row, expression: { ...expression, value: { kind: 'name', row, name: held } } },
      ]);
      this.flow.isDead = true;
      return { gen, type: NOTHING, repr: 'ref' };
    }
    const target = context.isLambda ? context.returnTarget : context;
    if (!target || !expression.value) return this.unsupportedSuspension(expression.row);
    const returnType = target.returnType;
    const value = this.compileSuspendValue(scope, context, expression.value, returnType);
    const to = target.returnRepr ?? reprOf(this.core, returnType ?? value.type);
    const convert = this.reprConverter(value.repr, to);
    const frameOf = this.frameAccess(context, target);
    this.flow.isDead = true;
    return {
      *gen(frame) {
        throw new ReturnSignal(frameOf(frame), convert(frame, yield* value.gen(frame)));
      },
      type: NOTHING,
      repr: 'ref',
    };
  }

  private reprConverter(from: Compiled['repr'], to: Compiled['repr']): (frame: Frame, value: Value) => Value {
    if (from === to) return (_frame, value) => value;
    return (frame, value) => convertRepr(() => value, from, to)(frame);
  }

  private unsupportedSuspension(row: number): never {
    return this.unavailable(row, '式の途中や関数の値の中での suspend 関数の呼び出し');
  }

  // What may suspend.

  /** Whether code makes a suspend call outside lambdas and local declarations, which then suspends the coroutine. */
  private mayYield(scope: Scope, node: unknown): boolean {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some((child) => this.mayYield(scope, child));
    const { kind } = node as { kind?: string };
    if (kind === 'call') {
      const call = node as Extract<Expression, { kind: 'call' }>;
      if (this.isSuspendCallee(scope, call.callee) || this.passesSuspendingFunction(scope, call)) return true;
    }
    if (kind !== undefined && OPAQUE_KINDS.has(kind)) return false;
    return Object.values(node).some((child) => this.mayYield(scope, child));
  }

  /**
   * Whether a call passes a function that suspends: a lambda that makes suspend calls, or a function parameter of an
   * inline function's suspend version. An inline function then runs as its suspend version.
   */
  private passesSuspendingFunction(scope: Scope, call: Extract<Expression, { kind: 'call' }>): boolean {
    const values = [
      ...call.args.map((argument) => argument.value),
      ...(call.trailingLambda ? [call.trailingLambda] : []),
    ];
    return values.some((value) => {
      if (value.kind === 'lambda') return this.mayYield(scope, value.statements);
      return value.kind === 'name' && this.findVariable(scope, value.name)?.suspendInvocable === true;
    });
  }

  private isSuspendCallee(scope: Scope, callee: Expression): boolean {
    const name = callee.kind === 'name' || callee.kind === 'member' ? callee.name : undefined;
    if (name === undefined) return false;
    const variable = callee.kind === 'name' ? this.findVariable(scope, name) : undefined;
    if (variable?.suspendInvocable) return true;
    if (variable) {
      const type = resolved(variable.type);
      return type.kind === 'function' && type.isSuspend === true;
    }
    return this.suspendFunctionNames.has(name);
  }

  /** Whether a call's parts other than the call itself make suspend calls, which only its own call may make. */
  private hasNestedSuspension(scope: Scope, expression: Expression): boolean {
    if (expression.kind !== 'call') return this.mayYield(scope, expression);
    return (
      this.mayYield(scope, expression.args) ||
      this.mayYield(scope, expression.trailingLambda) ||
      (expression.callee.kind === 'member' && this.mayYield(scope, expression.callee.receiver))
    );
  }

  /** `repeat(n) { ... }` or `xs.forEach { ... }` whose lambda suspends, as the loop it inlines to. */
  private loopingCall(scope: Scope, call: Extract<Expression, { kind: 'call' }>): Statement[] | undefined {
    const lambda = call.trailingLambda;
    if (!lambda || !isLoopingCall(call) || !this.mayYield(scope, lambda.statements)) return undefined;
    const variable = {
      row: lambda.row,
      name: lambda.params?.[0]?.name ?? 'it',
      type: lambda.params?.[0]?.type as TypeRef | undefined,
    };
    const body: Block = { row: lambda.row, endRow: lambda.endRow, statements: lambda.statements, isBraced: true };
    const { row } = call;
    if (call.callee.kind === 'name') {
      const [count] = call.args;
      if (!count) return undefined;
      const range: Expression = {
        kind: 'infix',
        row,
        name: 'until',
        left: { kind: 'integer', row, text: '0', value: 0n, suffix: '' },
        right: count.value,
      };
      return [{ kind: 'for', row, label: lambda.label, variable, iterable: range, body }];
    }
    if (call.callee.kind !== 'member') return undefined;
    return [{ kind: 'for', row, label: lambda.label, variable, iterable: call.callee.receiver, body }];
  }
}

type Eval = (frame: Frame) => Value;

/** A call with its receiver and arguments, which run in that order, replaced by what `inOrder` gives for them. */
function withCallParts(
  call: Extract<Expression, { kind: 'call' }>,
  inOrder: (parts: Expression[]) => Expression[]
): Expression {
  const { callee } = call;
  const lambda = call.trailingLambda ? [call.trailingLambda] : [];
  const receiver = callee.kind === 'member' ? [callee.receiver] : [];
  const parts = inOrder([...receiver, ...call.args.map((argument) => argument.value), ...lambda]);
  const args = call.args.map((argument, index) => ({
    ...argument,
    value: parts[receiver.length + index] as Expression,
  }));
  return {
    ...call,
    callee: callee.kind === 'member' ? { ...callee, receiver: parts[0] as Expression } : callee,
    args,
  };
}

/** A string template with the expressions it shows replaced by what `inOrder` gives for them. */
function withTemplateParts(
  template: Extract<Expression, { kind: 'string' }>,
  inOrder: (parts: Expression[]) => Expression[]
): Expression {
  const held = inOrder(template.parts.filter((part) => typeof part !== 'string'));
  let next = 0;
  return {
    ...template,
    parts: template.parts.map((part) => (typeof part === 'string' ? part : (held[next++] as Expression))),
  };
}

/** What a step gives: the value of an expression that may suspend, with its type and representation. */
interface SuspendValue {
  gen: Gen;
  type: KType;
  repr: Compiled['repr'];
}

/**
 * Whether running an expression may have effects or read what a later suspend call changes, so that it has to run
 * before that call: a call, an assignment, or an increment, outside the lambdas it passes.
 */
function hasEffects(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(hasEffects);
  const { kind } = node as { kind?: string };
  if (kind === 'call' || kind === 'postfix' || kind === 'index') return true;
  if (kind === 'prefix' && ['++', '--'].includes((node as { operator?: string }).operator ?? '')) return true;
  if (kind !== undefined && OPAQUE_KINDS.has(kind)) return false;
  return Object.values(node).some(hasEffects);
}

/** The scope class that restricts the suspend calls of the coroutine an inline lambda runs in. */
function suspendScopeOf(context: FunctionContext): ClassSymbol | undefined {
  for (let current: FunctionContext | undefined = context; current; current = current.parent) {
    if (current.isSuspend) return current.restrictedScope;
    if (!current.isLambda || !current.inlineLambda) return undefined;
  }
  return undefined;
}

/** Fills the defaults of the arguments a call leaves out before a function's body runs. */
function withDefaults(defaults: (Eval | undefined)[], gen: Gen): Gen {
  return function* (frame) {
    for (const [index, evaluate] of defaults.entries()) {
      if (evaluate && frame.locals[index] === MISSING) frame.locals[index] = evaluate(frame);
    }
    return yield* gen(frame);
  };
}

/** The ordinary call of a suspend function, which only a coroutine's suspend call reaches, as kotlinc rules out others. */
function suspendOnly(name: string): NonNullable<FunctionSymbol['invoke']> {
  return (caller) =>
    caller.runtime.throwError(caller, 'java.lang.IllegalStateException', `${name} is a suspend function`);
}

function isLoopingCall(call: Extract<Expression, { kind: 'call' }>): boolean {
  const name = call.callee.kind === 'name' || call.callee.kind === 'member' ? call.callee.name : undefined;
  return name !== undefined && LOOPING_CALLS.has(name) && call.args.length <= 1;
}

/** A suspend lambda's value, which a coroutine calls through `suspendFunction`. */
function suspendLambdaValue(
  functionClass: ClassSymbol,
  env: unknown[],
  run: (caller: Frame, args: Value[]) => Suspension
): Value {
  const value = new KObject(functionClass, 0);
  value.env = env;
  value.suspendFunction = run as KObject['suspendFunction'];
  return value;
}
