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
import type { ClassSymbol, FunctionSymbol } from './symbols';
import { type FunctionType, isNonNullClass, type KType, resolved } from './types';
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

let hiddenNames = 0;

function hiddenName(what: string): string {
  return `\0${what}${hiddenNames++}`;
}

/**
 * Compiles suspend functions and suspend lambdas as coroutines' steps: generators that yield where a suspend call
 * suspends, as `yield` of a sequence builder does. A statement that makes no suspend call compiles as any other; the
 * rest compile here, where a suspend call may be a statement, a variable's initializer, an assignment's value, or a
 * returned value, inside `if`, `when`, `try`, loops, and the lambdas of `repeat` and `forEach`.
 */
export abstract class SuspendCompiler extends LocalCompiler {
  // code-gauge-allow functionNcss -- the parts of the construct this function compiles follow one another, and splitting them would only rename them.
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
  protected compileSuspendLambda(
    scope: Scope,
    context: FunctionContext,
    lambda: LambdaExpression,
    expected: FunctionType
  ): Compiled {
    const lambdaContext = new FunctionContext(context, true, 'lambda', context.info.isLibrary, undefined);
    lambdaContext.isSuspend = true;
    lambdaContext.label = lambda.label;
    lambdaContext.lambdaResult = { expected: undefined, returnsUnit: true, returned: [] };
    const lambdaScope = new Scope(scope, lambdaContext);
    const params = this.lambdaParameters(scope, lambda, expected.params);
    const receiverType = expected.receiver;
    if (receiverType) lambdaScope.receiver = new ReceiverSymbol(receiverType, lambdaContext, undefined, lambda.label);
    lambdaContext.restrictedScope = this.restrictedScopeOf(receiverType);
    const outerFlow = this.flow;
    this.flow = outerFlow.copy();
    this.forgetAssignedIn(scope, lambda.statements);
    this.contextVariables(lambdaScope, lambdaContext, expected.contextTypes ?? [], lambda.row);
    for (const param of params) {
      const variable = this.newParameter(lambdaScope, lambdaContext, param.name, param.type, param.row);
      this.flow.assigned.add(variable);
    }
    const returnsUnit = isNonNullClass(resolved(expected.returnType), this.core.unit);
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
        resultType = value.type;
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
          const values = hasReceiver ? args.slice(1) : args;
          return caller.runtime.callSuspend(info, caller, env, receiver, values, undefined, body, frame);
        });
      },
    };
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
        return this.compileSuspendValue(scope, context, statement.expression, undefined).gen;
      }
      case 'property': {
        if (!statement.initializer || statement.delegate || statement.getter || statement.setter)
          return this.unsupportedSuspension(statement.row);
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
        if (statement.operator !== '=' || !variable) return this.unsupportedSuspension(statement.row);
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
    let condition = isDoWhile ? undefined : this.compileCondition(scope, context, statement.condition).compiled.eval;
    context.loops.push(loop);
    let body: Gen;
    try {
      body = this.compileSuspendBlock(bodyScope, context, statement.body);
    } finally {
      context.loops.pop();
    }
    if (isDoWhile) condition = this.compileCondition(bodyScope, context, statement.condition).compiled.eval;
    this.flow = Flow.merge([before, this.flow, ...loop.breaks]);
    const test = condition as (frame: Frame) => Value;
    const { identity } = loop;
    return function* (frame) {
      for (let first = true; ; first = false) {
        if ((!isDoWhile || !first) && !(test(frame) as boolean)) return UNIT;
        frame.runtime.spend();
        try {
          yield* body(frame);
        } catch (error) {
          if (!(error instanceof LoopSignal) || error.loop !== identity) throw error;
          if (error.isBreak) return UNIT;
        }
        if (isDoWhile && !(test(frame) as boolean)) return UNIT;
        first = false;
      }
    };
  }

  // Expressions.

  /** An expression's value, which a suspend call that is the expression, or the result of its branches, may give. */
  private compileSuspendValue(
    scope: Scope,
    context: FunctionContext,
    expression: Expression,
    expected: KType | undefined
  ): { gen: Gen; type: KType; repr: Compiled['repr'] } {
    switch (expression.kind) {
      case 'parenthesized': {
        return this.compileSuspendValue(scope, context, expression.expression, expected);
      }
      case 'call': {
        const looping = this.loopingCall(scope, expression);
        if (looping)
          return { gen: this.compileSuspendStatements(scope, context, looping), type: this.unitType, repr: 'ref' };
        return this.compileHoisted(scope, context, expression, expected);
      }
      case 'if': {
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
        return this.compileSuspendValue(scope, context, whenAsIf(expression), expected);
      }
      case 'try': {
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
   * An expression whose parts make suspend calls, which run first, each into a variable that the expression then
   * reads, so that only the expression itself, when it is a suspend call, suspends as it ends.
   */
  private compileHoisted(
    scope: Scope,
    context: FunctionContext,
    expression: Expression,
    expected: KType | undefined
  ): { gen: Gen; type: KType; repr: Compiled['repr'] } {
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

  /** An expression with the suspend calls in its parts replaced by variables that `before` assigns, in order. */
  // code-gauge-allow functionCognitiveComplexity -- one case per kind of expression whose parts may suspend.
  // code-gauge-allow functionNcss -- the parts of the construct this function compiles follow one another, and splitting them would only rename them.
  private hoistParts(scope: Scope, expression: Expression, before: Statement[]): Expression {
    const hoist = (part: Expression): Expression => {
      if (!this.mayYield(scope, part)) return part;
      const inner = this.hoistParts(scope, part, before);
      if (part.kind !== 'call' || !this.isSuspendCallee(scope, part.callee)) return inner;
      const name = hiddenName('suspended');
      before.push(propertyStatement(part.row, name, inner));
      return { kind: 'name', row: part.row, name };
    };
    switch (expression.kind) {
      case 'call': {
        const callee =
          expression.callee.kind === 'member'
            ? { ...expression.callee, receiver: hoist(expression.callee.receiver) }
            : expression.callee;
        if (this.mayYield(scope, expression.trailingLambda)) return this.unsupportedSuspension(expression.row);
        return {
          ...expression,
          callee,
          args: expression.args.map((argument) => ({ ...argument, value: hoist(argument.value) })),
        };
      }
      case 'member': {
        return { ...expression, receiver: hoist(expression.receiver) };
      }
      case 'binary': {
        if (['&&', '||', '?:'].includes(expression.operator) && this.mayYield(scope, expression.right))
          return this.unsupportedSuspension(expression.row);
        return { ...expression, left: hoist(expression.left), right: hoist(expression.right) };
      }
      case 'infix':
      case 'in': {
        return { ...expression, left: hoist(expression.left), right: hoist(expression.right) };
      }
      case 'prefix': {
        return { ...expression, operand: hoist(expression.operand) };
      }
      case 'postfix':
      case 'is':
      case 'as': {
        return { ...expression, operand: hoist(expression.operand) } as Expression;
      }
      case 'index': {
        return { ...expression, receiver: hoist(expression.receiver), indices: expression.indices.map(hoist) };
      }
      case 'string': {
        return {
          ...expression,
          parts: expression.parts.map((part) => (typeof part === 'string' ? part : hoist(part))),
        };
      }
      case 'parenthesized': {
        return { ...expression, expression: hoist(expression.expression) };
      }
      default: {
        return this.unsupportedSuspension(expression.row);
      }
    }
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
  ): { gen: Gen; type: KType; repr: 'ref' } {
    const target = context.isLambda ? context.returnTarget : context;
    if (!target || !expression.value || expression.label !== undefined)
      return this.unsupportedSuspension(expression.row);
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
      type: this.unitType,
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
      if (this.isSuspendCallee(scope, call.callee)) return true;
      if (call.trailingLambda && isLoopingCall(call) && this.mayYield(scope, call.trailingLambda.statements))
        return true;
    }
    if (kind !== undefined && OPAQUE_KINDS.has(kind)) return false;
    return Object.values(node).some((child) => this.mayYield(scope, child));
  }

  private isSuspendCallee(scope: Scope, callee: Expression): boolean {
    const name = callee.kind === 'name' || callee.kind === 'member' ? callee.name : undefined;
    if (name === undefined) return false;
    const variable = callee.kind === 'name' ? this.findVariable(scope, name) : undefined;
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

function propertyStatement(row: number, name: string, initializer: Expression): Statement {
  return {
    kind: 'property',
    row,
    modifiers: { keywords: new Set(), annotations: [] },
    isVar: false,
    name,
    type: undefined,
    receiver: undefined,
    typeParameters: [],
    initializer,
    delegate: undefined,
    getter: undefined,
    setter: undefined,
  };
}

/** `for (x in xs) body` as `val it = xs.iterator(); while (it.hasNext()) { val x = it.next(); body }`. */
function forAsWhile(statement: Extract<Statement, { kind: 'for' }>): Statement[] {
  const { row } = statement;
  const iterator = hiddenName('iterator');
  const read: Expression = { kind: 'name', row, name: iterator };
  const call = (receiver: Expression, name: string): Expression => ({
    kind: 'call',
    row,
    callee: { kind: 'member', row, receiver, name, isSafe: false },
    typeArgs: [],
    args: [],
    trailingLambda: undefined,
  });
  const { variable } = statement;
  const element: Statement =
    'names' in variable
      ? {
          kind: 'destructuring',
          row,
          modifiers: { keywords: new Set(), annotations: [] },
          isVar: false,
          names: variable.names,
          initializer: call(read, 'next'),
        }
      : ({ ...propertyStatement(row, variable.name, call(read, 'next')), type: variable.type } as Statement);
  return [
    propertyStatement(row, iterator, call(statement.iterable, 'iterator')),
    {
      kind: 'while',
      row,
      label: statement.label,
      condition: call(read, 'hasNext'),
      body: { ...statement.body, statements: [element, ...statement.body.statements] },
    },
  ];
}

/** `when` as the `if` chain it stands for, testing a subject held in a variable. */
function whenAsIf(expression: Extract<Expression, { kind: 'when' }>): Expression {
  const { row } = expression;
  const subjectName = hiddenName('subject');
  const subject: Expression = { kind: 'name', row, name: subjectName };
  const test = (
    condition: Extract<Expression, { kind: 'when' }>['entries'][number]['conditions'][number]
  ): Expression => {
    if (!expression.subject) return (condition as { expression: Expression }).expression;
    switch (condition.kind) {
      case 'is': {
        return { kind: 'is', row: condition.row, negated: condition.negated, operand: subject, type: condition.type };
      }
      case 'in': {
        return {
          kind: 'in',
          row: condition.row,
          negated: condition.negated,
          left: subject,
          right: condition.expression,
        };
      }
      default: {
        return { kind: 'binary', row: condition.row, operator: '==', left: subject, right: condition.expression };
      }
    }
  };
  let chain: Block | undefined;
  for (const entry of expression.entries.toReversed()) {
    if (entry.conditions.length === 0 && !entry.guard) {
      chain = entry.body;
      continue;
    }
    const [first, ...rest] = entry.conditions.map(test);
    let condition: Expression = first;
    for (const right of rest) condition = { kind: 'binary', row: entry.row, operator: '||', left: condition, right };
    if (entry.guard)
      condition = { kind: 'binary', row: entry.row, operator: '&&', left: condition, right: entry.guard };
    chain = {
      row: entry.row,
      endRow: entry.body.endRow,
      isBraced: true,
      statements: [
        {
          kind: 'expressionStatement',
          row: entry.row,
          expression: { kind: 'if', row: entry.row, condition, thenBranch: entry.body, elseBranch: chain },
        },
      ],
    };
  }
  const statements: Statement[] = [
    ...(expression.subject ? [propertyStatement(row, subjectName, expression.subject)] : []),
    ...(chain?.statements ?? []),
  ];
  return {
    kind: 'if',
    row,
    condition: { kind: 'boolean', row, value: true },
    thenBranch: { row, endRow: row, isBraced: true, statements },
    elseBranch: undefined,
  };
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
