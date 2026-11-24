import { Coroutine, type Resumable, type Resumption, type Suspension } from './coroutines';
import { CppException } from './errors';
import type { Expr } from './expr';
import { hasMemberNamed } from './expressionCompiler';
import { destroyTemporaries, initializeAt } from './objectCompiler';
import { overloadedOperator } from './operatorOverloads';
import { parseStatementAt } from './parse';
import { BREAK, type CompiledFunction, type Eval, type Exec, type Frame, GOTO, RETURN } from './runtime';
import { Scope } from './scopes';
import { endScope, runHandler, StatementCompiler, type StatementMode } from './statementCompiler';
import { fieldOf, type Syntax } from './syntax';
import { type ClassInfo, type FunctionInfo, nonReference, referenceTo, type Type, unqualified } from './types';
import { Box, endLifetime, Ptr, type Store, UNINIT, type Value } from './values';

/** The row of the statements the interpreter writes for a coroutine, which record no steps. */
const HIDDEN_ROW = -1;

/** The identifiers of the statements the interpreter writes, which name hidden variables (`\0coro ...`). */
const HIDDEN_PREFIX = '__coro_';

/** The nodes that make a function a coroutine (C++20 [dcl.fct.def.coroutine]p1). */
const COROUTINE_NODES = new Set(['co_await_expression', 'co_yield_statement', 'co_return_statement']);

/** The nodes whose code belongs to another function, or is not evaluated. */
const OTHER_BODIES = new Set([
  'lambda_expression',
  'class_specifier',
  'struct_specifier',
  'union_specifier',
  'function_definition',
  'sizeof_expression',
  'decltype',
  'requires_expression',
]);

/** The expressions whose operands are evaluated in the order they are written, before the expression itself. */
const OPERAND_EXPRESSIONS = new Set([
  'parenthesized_expression',
  'unary_expression',
  'pointer_expression',
  'cast_expression',
  'field_expression',
  'subscript_expression',
  'subscript_argument_list',
  'binary_expression',
  'call_expression',
  'argument_list',
  'initializer_list',
  'compound_literal_expression',
]);

const SHORT_CIRCUIT_OPERATORS = new Set(['&&', '||', 'and', 'or']);

/** The expressions that have no side effects, which a `co_await` written after them need not evaluate first. */
const PURE_EXPRESSIONS = new Set([
  'identifier',
  'qualified_identifier',
  'number_literal',
  'string_literal',
  'char_literal',
  'raw_string_literal',
  'concatenated_string',
  'true',
  'false',
  'nullptr',
  'this',
  'parenthesized_expression',
  'field_expression',
  'pointer_expression',
  'unary_expression',
]);

/** Whether a statement or an expression is part of a coroutine: it awaits, yields, or returns from one. */
export function isCoroutineCode(node: Syntax): boolean {
  return firstCoroutineNode(node) !== undefined;
}

function firstCoroutineNode(node: Syntax): Syntax | undefined {
  if (COROUTINE_NODES.has(node.type)) return node;
  if (OTHER_BODIES.has(node.type)) return undefined;
  for (const child of node.children) {
    const found = firstCoroutineNode(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * Compiles coroutines: their statements run as generators, which suspend where the coroutine does. A statement whose
 * expressions await is compiled as statements the interpreter writes: one that evaluates the operand into a hidden
 * variable, the suspension, and one that evaluates the rest with the result of `await_resume`.
 */
export abstract class CoroutineCompiler extends StatementCompiler {
  private hiddenCount = 0;
  private promiseClass: ClassInfo | undefined;

  private readonly resumableMode: StatementMode<Resumable> = {
    statement: (node) => this.resumableStatement(node),
    statements: (nodes) => this.resumableStatements(nodes),
    scopeExit: (run, scope) => resumableScopeExit(run, scope),
  };

  /**
   * Compiles the body of a coroutine in the context of the function, whose parameters are declared, as the
   * coroutine's frame runs it (C++20 [dcl.fct.def.coroutine]p5).
   */
  protected coroutineFunction(fn: FunctionInfo, body: Syntax): CompiledFunction {
    this.checkCoroutine(fn, body);
    const { row } = body;
    const context = this.context;
    const outerScope = context.scope;
    const savedPromise = this.promiseClass;
    const savedCount = this.hiddenCount;
    this.hiddenCount = 0;
    try {
      const parameterCopies = this.parameterCopies(fn, row);
      const { setup, promiseLocation } = this.promiseSetup(fn, row);
      const statements = this.inScopeWith(this.resumableMode, () => this.resumableStatements(body.children));
      const run = coroutineRun({
        initial: this.suspendPoint(`${HIDDEN_PREFIX}promise.initial_suspend()`, row, false),
        statements,
        fallsOff: this.hasPromiseMember('return_void')
          ? this.compileStatement(this.hiddenStatement(`${HIDDEN_PREFIX}promise.return_void();`, {}))
          : undefined,
        unhandled: this.compileStatement(this.hiddenStatement(`${HIDDEN_PREFIX}promise.unhandled_exception();`, {})),
        final: this.suspendPoint(`${HIDDEN_PREFIX}promise.final_suspend()`, row, true),
      });
      context.endBody();
      const teardown = (frame: Frame): void => {
        // The promise is destroyed before the parameter copies, which the end of its scope leaves alone.
        const destroyCopies = parameterCopies.map((copy) => copy.destroyer(frame));
        endScope(frame, outerScope);
        for (const destroyCopy of destroyCopies.toReversed()) destroyCopy();
      };
      return {
        slotCount: context.slotCount,
        locals: context.locals,
        body: (frame) => {
          try {
            for (const copy of parameterCopies) copy.make(frame);
            setup(frame);
          } catch (error) {
            if (error instanceof CppException) teardown(frame);
            throw error;
          }
          // A handle's address, the promise's, designates the promise's storage.
          new Coroutine(frame, promiseLocation(frame).store as Store, run(teardown), teardown).start();
        },
      };
    } finally {
      this.promiseClass = savedPromise;
      this.hiddenCount = savedCount;
    }
  }

  private checkCoroutine(fn: FunctionInfo, body: Syntax): void {
    const { row } = body;
    if (fn.isConstructor || fn.isDestructor || (fn.name === 'main' && !fn.owner))
      this.error((firstCoroutineNode(body) as Syntax).row, `${fn.displayName} はコルーチンにできません。`);
    if (fn.isVariadic) this.error(row, '可変長引数（...）の関数はコルーチンにできません。');
    if (this.context.returnType.kind !== 'class')
      this.error(row, 'コルーチンの戻り値の型には、promise_type を持つクラスを書いてください。');
    const returnStatement = findReturnStatement(body);
    if (returnStatement) this.error(returnStatement.row, 'コルーチンでは return ではなく co_return を使ってください。');
  }

  /**
   * The promise of a coroutine and its handle, as hidden variables, and the setup that makes them and the object the
   * call returns from `get_return_object`.
   */
  private promiseSetup(fn: FunctionInfo, row: number): { setup: (frame: Frame) => void; promiseLocation: Eval<Ptr> } {
    const traits = this.coroutineTraitsArguments(fn);
    const statements = [
      `std::coroutine_traits<${traits}>::promise_type ${HIDDEN_PREFIX}promise;`,
      `auto ${HIDDEN_PREFIX}handle = std::coroutine_handle<decltype(${HIDDEN_PREFIX}promise)>::from_promise(${HIDDEN_PREFIX}promise);`,
    ].map((text) => this.compileStatement(this.hiddenStatement(text, {})));
    const promise = this.hiddenExpression(`${HIDDEN_PREFIX}promise`, row);
    const promiseType = unqualified(promise.type);
    if (promiseType.kind !== 'class') return this.error(row, 'promise_type にはクラスを書いてください。');
    this.promiseClass = promiseType.cls;
    const returnObject = this.copyInitializer(
      this.context.returnType,
      this.hiddenExpression(`${HIDDEN_PREFIX}promise.get_return_object()`, row),
      row,
      false
    );
    return {
      setup: (frame) => {
        for (const statement of statements) statement(frame);
        frame.returnValue = returnObject(frame, undefined, false, 'full-expression');
      },
      promiseLocation: promise.run as Eval<Ptr>,
    };
  }

  /**
   * The copies of the parameters a coroutine's frame keeps, which it moves the arguments of class types into, since
   * the coroutine outlives the call (C++20 [dcl.fct.def.coroutine]p13).
   */
  private parameterCopies(
    fn: FunctionInfo,
    row: number
  ): { make: (frame: Frame) => void; destroyer: (frame: Frame) => () => void }[] {
    return fn.params.flatMap((param, slot) => {
      const { type } = param;
      if (type.kind !== 'class') return [];
      let source: Store | undefined;
      const argument: Expr = { type, isLvalue: true, row, run: () => new Ptr(source as Store, 0) };
      const initialize = this.copyInitializer(type, this.implicitMoveSource(argument, type), row, false);
      const destroy = this.destroyerOf(type, row);
      return [
        {
          make: (frame: Frame) => {
            source = frame.slots[slot] as Store;
            const storage = new Box();
            initializeAt(frame, type, storage.location(0), UNINIT, (target) =>
              initialize(frame, target, false, 'full-expression')
            );
            frame.slots[slot] = storage;
          },
          destroyer: (frame: Frame) => {
            const storage = frame.slots[slot] as Box;
            frame.slots[slot] = undefined;
            return () => {
              destroy?.(frame, storage.value);
              endLifetime(storage);
            };
          },
        },
      ];
    });
  }

  /**
   * The types `std::coroutine_traits` takes for a function, as hidden type names: the return type, the type of the
   * object of a member function, and the parameter types.
   */
  private coroutineTraitsArguments(fn: FunctionInfo): string {
    const types: Type[] = [this.context.returnType];
    const cls = this.context.cls;
    if (cls && !fn.isStatic && !cls.isLambda) {
      const object: Type = { kind: 'class', cls };
      types.push(referenceTo(fn.isConst ? { ...object, isConst: true } : object));
    }
    types.push(...fn.params.map((param) => param.type));
    return types
      .map((type, index) => {
        const name = `traits${index}`;
        this.context.scope.names.set(`\0coro ${name}`, { kind: 'type', type });
        return `${HIDDEN_PREFIX}${name}`;
      })
      .join(', ');
  }

  // Statements -----------------------------------------------------------------------------------------------------

  private resumableStatements(nodes: readonly Syntax[]): Resumable {
    if (!nodes.some((node) => isCoroutineCode(node))) return synchronous(this.compileStatements(nodes));
    for (const node of nodes) {
      if (node.type === 'labeled_statement') this.unsupported(node.row, 'co_await や co_yield があるブロックのラベル');
    }
    const statements = nodes.map((node) => this.resumableStatement(node));
    return function* (frame): Resumption {
      for (const statement of statements) {
        const completion = yield* statement(frame);
        if (completion !== undefined) return completion;
      }
      return;
    };
  }

  private resumableStatement(node: Syntax): Resumable {
    if (!isCoroutineCode(node)) return synchronous(this.compileStatement(node));
    if (node.row >= 0) this.userRow = node.row;
    switch (node.type) {
      case 'compound_statement': {
        return this.inScopeWith(this.resumableMode, () => this.resumableStatements(node.children));
      }
      case 'expression_statement':
      case 'declaration':
      case 'co_yield_statement':
      case 'co_return_statement': {
        return this.loweredStatement(node);
      }
      case 'if_statement': {
        return this.resumableIf(node);
      }
      case 'while_statement': {
        return this.resumableWhile(node);
      }
      case 'do_statement': {
        return this.resumableDo(node);
      }
      case 'for_statement': {
        return this.resumableFor(node);
      }
      case 'for_range_loop': {
        return this.resumableRangeFor(node);
      }
      case 'try_statement': {
        return this.resumableTry(node);
      }
      default: {
        return this.unsupported(node.row, 'この位置の co_await・co_yield・co_return');
      }
    }
  }

  private resumableWhile(node: Syntax): Resumable {
    if (isCoroutineCode(fieldOf(node, 'condition') as Syntax)) return this.awaitingWhile(node);
    const mode = this.resumableMode;
    return this.inScopeWith(mode, () => {
      const { condition, body } = this.whileParts(node, mode);
      return function* (frame): Resumption {
        while (condition(frame)) {
          frame.runtime.spend();
          const completion = yield* body(frame);
          if (completion === BREAK) break;
          if (completion === RETURN || completion === GOTO) return completion;
        }
        return;
      };
    });
  }

  private resumableDo(node: Syntax): Resumable {
    this.rejectAwaitIn(fieldOf(node, 'condition'), 'ループの条件');
    const { body, condition } = this.doParts(node, this.resumableMode);
    return function* (frame): Resumption {
      do {
        frame.runtime.spend();
        const completion = yield* body(frame);
        if (completion === BREAK) break;
        if (completion === RETURN || completion === GOTO) return completion;
      } while (condition(frame));
      return;
    };
  }

  private resumableFor(node: Syntax): Resumable {
    for (const field of ['initializer', 'condition', 'update'])
      this.rejectAwaitIn(fieldOf(node, field), 'for 文の初期化・条件・更新');
    const mode = this.resumableMode;
    const scope = new Scope();
    return this.inScopeWith(
      mode,
      () => {
        const { init, condition, update, body } = this.forParts(node, mode, scope);
        return function* (frame): Resumption {
          init(frame);
          while (condition(frame)) {
            frame.runtime.spend();
            const completion = yield* body(frame);
            if (completion === BREAK) break;
            if (completion === RETURN || completion === GOTO) return completion;
            update(frame);
          }
          return;
        };
      },
      scope
    );
  }

  private resumableRangeFor(node: Syntax): Resumable {
    for (const field of ['initializer', 'right']) this.rejectAwaitIn(fieldOf(node, field), '範囲 for 文の範囲');
    const mode = this.resumableMode;
    return this.inScopeWith(mode, () => {
      const { init, start, notDone, advance, enter, body, bodyScope } = this.rangeForParts(node, mode);
      const iteration = resumableScopeExit(function* (frame): Resumption {
        enter(frame);
        return yield* body(frame);
      }, bodyScope);
      return function* (frame): Resumption {
        const completion = init?.(frame);
        if (completion !== undefined) return completion;
        start(frame);
        while (notDone(frame)) {
          frame.runtime.spend();
          const completion = yield* iteration(frame);
          if (completion === BREAK) break;
          if (completion === RETURN || completion === GOTO) return completion;
          advance(frame);
        }
        return;
      };
    });
  }

  private resumableTry(node: Syntax): Resumable {
    for (const clause of node.children.filter((child) => child.type === 'catch_clause')) {
      const awaiting = firstCoroutineNode(clause);
      if (awaiting) return this.error(awaiting.row, 'catch の中では co_await や co_yield を使えません。');
    }
    const { body, matches, handle } = this.tryParts(node, this.resumableMode);
    return function* (frame): Resumption {
      const { tryBlocks } = frame.runtime;
      tryBlocks.push(matches);
      let isActive = true;
      try {
        return yield* body(frame);
      } catch (error) {
        if (!(error instanceof CppException)) throw error;
        tryBlocks.pop();
        isActive = false;
        return handle(frame, error);
      } finally {
        if (isActive) tryBlocks.pop();
      }
    };
  }

  /**
   * A `while` loop whose condition awaits, which awaits again before each test: every iteration runs in a scope of its
   * own, which holds what the condition declares.
   */
  private awaitingWhile(node: Syntax): Resumable {
    const clause = fieldOf(node, 'condition') as Syntax;
    const scope = new Scope();
    const iteration = this.inScopeWith(
      this.resumableMode,
      () => {
        const pieces: Resumable[] = [];
        const lowered = this.lowerCondition(pieces, clause);
        const { condition, body } = this.whileParts(replaceChild(node, clause, lowered), this.resumableMode);
        const test = fullStatement([
          ...pieces,
          function* (frame): Resumption {
            return condition(frame) ? undefined : BREAK;
          },
        ]);
        return function* (frame): Resumption {
          return (yield* test(frame)) ?? (yield* body(frame));
        };
      },
      scope
    );
    return function* (frame): Resumption {
      for (;;) {
        frame.runtime.spend();
        const completion = yield* iteration(frame);
        if (completion === BREAK) break;
        if (completion === RETURN || completion === GOTO) return completion;
      }
      return;
    };
  }

  private resumableIf(node: Syntax): Resumable {
    const mode = this.resumableMode;
    if (node.all.some((child) => child.type === 'consteval'))
      return this.unsupported(node.row, 'if consteval の中の co_await');
    if (node.all.some((child) => child.type === 'constexpr')) {
      return this.inScopeWith(mode, () => {
        const { init, branch } = this.constexprIfParts(node, mode);
        return function* (frame): Resumption {
          init?.(frame);
          return branch ? yield* branch(frame) : undefined;
        };
      });
    }
    const clause = fieldOf(node, 'condition') as Syntax;
    if (isCoroutineCode(clause)) {
      // The condition awaits before the statement, whose condition uses the result.
      const pieces: Resumable[] = [];
      const lowered = this.lowerCondition(pieces, clause);
      const statement = this.resumableIf(replaceChild(node, clause, lowered));
      pieces.push(statement);
      return fullStatement(pieces);
    }
    return this.inScopeWith(mode, () => {
      const { init, condition, consequence, alternative } = this.ifParts(node, mode);
      return function* (frame): Resumption {
        init?.(frame);
        if (condition(frame)) return yield* consequence(frame);
        return alternative ? yield* alternative(frame) : undefined;
      };
    });
  }

  private lowerCondition(pieces: Resumable[], clause: Syntax): Syntax {
    if (fieldOf(clause, 'initializer')) return this.unsupported(clause.row, '初期化文がある if 文の条件の co_await');
    const value = fieldOf(clause, 'value') as Syntax;
    if (value.type !== 'declaration') return replaceChild(clause, value, this.lowerExpression(pieces, value));
    const initializer = fieldOf(value, 'value') as Syntax;
    return replaceChild(clause, value, replaceChild(value, initializer, this.lowerExpression(pieces, initializer)));
  }

  private rejectAwaitIn(node: Syntax | undefined, place: string): void {
    if (node && isCoroutineCode(node)) this.unsupported(node.row, `${place}の中の co_await`);
  }

  /** A statement whose expressions await, as the statements that await and then evaluate the rest. */
  private loweredStatement(node: Syntax): Resumable {
    const pieces: Resumable[] = [];
    switch (node.type) {
      case 'expression_statement': {
        const expression = node.children[0] as Syntax;
        const awaited = unparenthesized(expression);
        if (awaited.type === 'co_await_expression') {
          const operand = this.lowerExpression(pieces, awaited.children[0] as Syntax);
          this.awaitPieces(pieces, operand, { transforms: true, row: node.row, keepsResult: false });
        } else {
          const lowered = this.lowerExpression(pieces, expression);
          pieces.push(synchronous(this.compileStatement(replaceChild(node, expression, lowered))));
        }
        break;
      }
      case 'declaration': {
        const declarators = node.children.filter((child) => child.type === 'init_declarator');
        const awaiting = declarators.filter((declarator) => isCoroutineCode(declarator));
        if (awaiting.length > 1 || (awaiting[0] && awaiting[0] !== declarators[0]))
          this.unsupported(node.row, '2つ目以降の変数の初期化子の co_await');
        const declarator = awaiting[0] as Syntax;
        const value = fieldOf(declarator, 'value') as Syntax;
        const lowered = replaceChild(declarator, value, this.lowerExpression(pieces, value));
        pieces.push(synchronous(this.compileStatement(replaceChild(node, declarator, lowered))));
        break;
      }
      case 'co_yield_statement': {
        const operand = this.lowerExpression(pieces, node.children[0] as Syntax);
        const yielded = this.hiddenExpressionSyntax(`${HIDDEN_PREFIX}promise.yield_value(${HIDDEN_PREFIX}operand)`, {
          operand,
        });
        this.awaitPieces(pieces, yielded, { transforms: false, row: node.row, keepsResult: false });
        break;
      }
      case 'co_return_statement': {
        const valueNode = node.children[0];
        const lowered = valueNode && this.lowerExpression(pieces, valueNode);
        const compiled = lowered && lowered.type !== 'initializer_list' ? this.compileExpression(lowered) : undefined;
        const value = compiled ? this.compiledSyntax(compiled) : lowered;
        // A `co_return` of a void expression evaluates it and returns nothing (C++20 [stmt.return.coroutine]p2).
        const returnsValue = value !== undefined && compiled?.type.kind !== 'void';
        if (value && !returnsValue) pieces.push(this.hiddenPiece(`${HIDDEN_PREFIX}value;`, { value }, node.row));
        const text = returnsValue
          ? `${HIDDEN_PREFIX}promise.return_value(${HIDDEN_PREFIX}value);`
          : `${HIDDEN_PREFIX}promise.return_void();`;
        const statement = this.compileStatement(this.hiddenStatement(text, returnsValue ? { value } : {}, node.row));
        pieces.push(function* (frame): Resumption {
          statement(frame);
          return RETURN;
        });
        break;
      }
      default: {
        return this.unsupported(node.row, 'この位置の co_await');
      }
    }
    return fullStatement(pieces);
  }

  private hasPromiseMember(name: string): boolean {
    return this.promiseClass !== undefined && hasMemberNamed(this.promiseClass, name);
  }

  // Expressions ----------------------------------------------------------------------------------------------------

  /**
   * An expression with its `co_await`s replaced by the results of the statements that await them, which `pieces`
   * receives in the order the expression evaluates its operands: an operand evaluated before one that awaits is
   * evaluated into a hidden variable first, unless evaluating it has no side effects.
   */
  private lowerExpression(pieces: Resumable[], node: Syntax): Syntax {
    if (!isCoroutineCode(node)) return node;
    if (node.type === 'co_await_expression') {
      const operand = this.lowerExpression(pieces, node.children[0] as Syntax);
      return this.awaitPieces(pieces, operand, { transforms: true, row: node.row, keepsResult: true }) as Syntax;
    }
    if (node.type === 'assignment_expression') {
      const left = fieldOf(node, 'left') as Syntax;
      const right = fieldOf(node, 'right') as Syntax;
      // The right operand of an assignment is evaluated before the left one (C++20 [expr.ass]p1).
      const loweredRight = this.lowerExpression(pieces, right);
      if (!isCoroutineCode(left)) return replaceChild(node, right, loweredRight);
      const first = this.evaluatedFirst(pieces, loweredRight, node);
      return replaceChildren(
        node,
        new Map([
          [right, first],
          [left, this.lowerExpression(pieces, left)],
        ])
      );
    }
    if (evaluatesFirstOperandFirst(node)) {
      // The other operands are evaluated after the first one completes, if at all.
      const [first, ...rest] = node.children as [Syntax, ...Syntax[]];
      if (rest.some((child) => isCoroutineCode(child)))
        return this.unsupported(node.row, '&&・||・?:・カンマ演算子の右側の co_await');
      return replaceChild(node, first, this.lowerExpression(pieces, first));
    }
    if (!OPERAND_EXPRESSIONS.has(node.type)) return this.unsupported(node.row, 'この位置の co_await');
    const operands = node.children;
    const last = operands.findLastIndex((child) => isCoroutineCode(child));
    const replacements = new Map<Syntax, Syntax>();
    for (const [index, operand] of operands.entries()) {
      if (index > last) break;
      const lowered = this.lowerExpression(pieces, operand);
      replacements.set(operand, index < last ? this.evaluatedFirst(pieces, lowered, node) : lowered);
    }
    return replaceChildren(node, replacements);
  }

  /** An operand that is evaluated before an operand that awaits, evaluated into a hidden variable unless pure. */
  private evaluatedFirst(pieces: Resumable[], operand: Syntax, parent: Syntax): Syntax {
    if (isPure(operand)) return operand;
    if (parent.type === 'call_expression') {
      // The function a call calls: an object whose member it calls is evaluated first.
      if (operand.type === 'field_expression') {
        const object = fieldOf(operand, 'argument') as Syntax;
        return replaceChild(operand, object, this.evaluatedFirst(pieces, object, operand));
      }
      return this.unsupported(operand.row, 'co_await を引数に書いた、この形の関数呼び出し');
    }
    if (operand.type === 'initializer_list') return this.unsupported(operand.row, 'co_await の前の {...}');
    const name = this.hiddenName('operand');
    pieces.push(this.retainingPiece(`auto&& ${name} = ${HIDDEN_PREFIX}value;`, { value: operand }));
    return this.forwarded(name, operand.row);
  }

  /**
   * The statements of `co_await operand` (C++20 [expr.await]p3): the awaitable, which `await_transform` of the
   * promise makes when it has one, the awaiter, which `operator co_await` makes from it when there is one, the
   * suspension unless the awaiter is ready, and the call of `await_resume`, whose result the returned expression
   * designates when `keepsResult`.
   */
  private awaitPieces(
    pieces: Resumable[],
    operand: Syntax,
    { transforms, row, keepsResult }: { transforms: boolean; row: number; keepsResult: boolean }
  ): Syntax | undefined {
    const awaitable =
      transforms && this.hasPromiseMember('await_transform')
        ? this.hiddenExpressionSyntax(`${HIDDEN_PREFIX}promise.await_transform(${HIDDEN_PREFIX}value)`, {
            value: operand,
          })
        : operand;
    const awaitableName = this.hiddenName('awaitable');
    pieces.push(this.retainingPiece(`auto&& ${awaitableName} = ${HIDDEN_PREFIX}value;`, { value: awaitable }));
    const awaiterName = this.awaiterOf(pieces, awaitableName, row);
    pieces.push(this.suspension(awaiterName, row, false));
    if (!keepsResult) {
      pieces.push(this.hiddenPiece(`${awaiterName}.await_resume();`, {}, row));
      return undefined;
    }
    const resultName = this.hiddenName('result');
    pieces.push(this.retainingPiece(`auto&& ${resultName} = ${awaiterName}.await_resume();`, {}));
    return this.forwarded(resultName, row);
  }

  /** The awaiter of an awaitable: what its `operator co_await` returns when it has one. */
  private awaiterOf(pieces: Resumable[], awaitableName: string, row: number): string {
    const awaitable = this.compileExpression(this.forwarded(awaitableName, row));
    const overloaded = overloadedOperator(this, ' co_await', [awaitable], row);
    if (!overloaded) return awaitableName;
    const call = this.compiledSyntax(overloaded.expr);
    const name = this.hiddenName('awaiter');
    pieces.push(this.retainingPiece(`auto&& ${name} = ${HIDDEN_PREFIX}value;`, { value: call }));
    return name;
  }

  /** The suspension of `co_await` with an awaiter: `await_ready`, then `await_suspend` once suspended. */
  private suspension(awaiterName: string, row: number, isFinal: boolean): Resumable {
    const ready = this.fullExpression(this.condition(this.hiddenExpression(`${awaiterName}.await_ready()`, row), row));
    const suspendExpr = this.hiddenExpression(`${awaiterName}.await_suspend(${HIDDEN_PREFIX}handle)`, row);
    const suspendType = unqualified(nonReference(suspendExpr.type));
    let result: Suspension['result'];
    if (suspendType.kind === 'void') result = 'void';
    else if (suspendType.kind === 'int' && suspendType.name === 'bool') result = 'bool';
    else if (suspendType.kind === 'class' && this.isLibraryInstance(suspendType.cls, 'coroutine_handle'))
      result = 'handle';
    else return this.error(row, 'await_suspend は void・bool・std::coroutine_handle のどれかを返してください。');
    const awaitSuspend = this.fullExpression(suspendExpr.run as Eval<Value | Ptr>);
    const suspension: Suspension = { awaitSuspend, result, isFinal };
    return function* (frame): Resumption {
      if (!ready(frame)) yield suspension;
      return;
    };
  }

  /** The initial or the final suspend point, which awaits what a member function of the promise returns. */
  private suspendPoint(text: string, row: number, isFinal: boolean): Resumable {
    const pieces: Resumable[] = [];
    const awaitableName = this.hiddenName('awaitable');
    pieces.push(this.retainingPiece(`auto&& ${awaitableName} = ${text};`, {}));
    const awaiterName = this.awaiterOf(pieces, awaitableName, row);
    pieces.push(this.suspension(awaiterName, row, isFinal));
    pieces.push(this.hiddenPiece(`${awaiterName}.await_resume();`, {}));
    return fullStatement(pieces);
  }

  // Hidden code ----------------------------------------------------------------------------------------------------

  /** A statement the interpreter writes, which runs at once. */
  private hiddenPiece(text: string, holes: Record<string, Syntax | undefined>, row = HIDDEN_ROW): Resumable {
    return synchronous(this.compileStatement(this.hiddenStatement(text, holes, row)));
  }

  /**
   * A declaration the interpreter writes for part of an expression that awaits, whose temporaries live until the end
   * of the statement that awaits, as they would until the end of its full-expression.
   */
  private retainingPiece(text: string, holes: Record<string, Syntax | undefined>): Resumable {
    const declaration = this.compileStatement(this.hiddenStatement(text, holes));
    return synchronous((frame) => {
      const retains = frame.retainsTemporaries;
      frame.retainsTemporaries = true;
      try {
        return declaration(frame);
      } finally {
        frame.retainsTemporaries = retains;
      }
    });
  }

  private hiddenName(kind: string): string {
    return `${HIDDEN_PREFIX}${kind}${this.hiddenCount++}`;
  }

  /** The expression that designates a hidden reference variable as its initializer did: an lvalue or an xvalue. */
  private forwarded(name: string, row: number): Syntax {
    return this.hiddenExpressionSyntax(this.forwardedText(name), {}, row);
  }

  private forwardedText(name: string): string {
    return `static_cast<decltype(${name})&&>(${name})`;
  }

  private hiddenExpression(text: string, row: number): Expr {
    return this.compileExpression(this.hiddenExpressionSyntax(text, {}, row));
  }

  private hiddenExpressionSyntax(text: string, holes: Record<string, Syntax>, row = HIDDEN_ROW): Syntax {
    const statement = this.hiddenStatement(`${text};`, holes, row);
    return statement.children[0] as Syntax;
  }

  /**
   * A statement the interpreter writes, whose identifiers `__coro_name` name the hidden entities `\0coro name`, except
   * those that name a hole, which the given node replaces.
   */
  private hiddenStatement(text: string, holes: Record<string, Syntax | undefined>, row = HIDDEN_ROW): Syntax {
    const fill = (node: Syntax): Syntax => {
      if ((node.type === 'identifier' || node.type === 'type_identifier') && node.text.startsWith(HIDDEN_PREFIX)) {
        const name = node.text.slice(HIDDEN_PREFIX.length);
        const hole = holes[name];
        if (hole) return { ...hole, field: node.field };
        return { ...node, text: `\0coro ${name}` };
      }
      if (node.all.length === 0) return node;
      const all = node.all.map(fill);
      return { ...node, all, children: all.filter((child) => child.isNamed) };
    };
    return fill(parseStatementAt(text, row));
  }
  protected abstract isLibraryInstance(cls: ClassInfo, name: string): boolean;
}

/**
 * The run of a coroutine's body after the setup: the initial suspend point, the body in a handler that gives every
 * exception to the promise (C++20 [dcl.fct.def.coroutine]p5), the final suspend point, and then the end of the frame.
 */
function coroutineRun(parts: {
  initial: Resumable;
  statements: Resumable;
  fallsOff: Exec | undefined;
  unhandled: Exec;
  final: Resumable;
}): (teardown: (frame: Frame) => void) => Resumable {
  const { initial, statements, fallsOff, unhandled, final } = parts;
  return (teardown) =>
    function* (frame): Resumption {
      yield* initial(frame);
      const { tryBlocks } = frame.runtime;
      tryBlocks.push(() => true);
      let isActive = true;
      try {
        const completion = yield* statements(frame);
        if (completion !== RETURN) fallsOff?.(frame);
      } catch (error) {
        if (!(error instanceof CppException)) throw error;
        tryBlocks.pop();
        isActive = false;
        runHandler(frame, unhandled, error);
      } finally {
        if (isActive) tryBlocks.pop();
      }
      yield* final(frame);
      teardown(frame);
      return;
    };
}

function synchronous(exec: Exec): Resumable {
  return function* (frame): Resumption {
    return exec(frame);
  };
}

/** The statements of a statement that awaits, which destroy the temporaries they retain when they complete. */
function fullStatement(pieces: readonly Resumable[]): Resumable {
  const run = sequence(pieces);
  return function* (frame): Resumption {
    const mark = frame.temporaries.length;
    let endsProgram = false;
    try {
      return yield* run(frame);
    } catch (error) {
      if (!(error instanceof CppException)) endsProgram = true;
      throw error;
    } finally {
      if (!endsProgram) destroyTemporaries(frame, mark);
    }
  };
}

function sequence(pieces: readonly Resumable[]): Resumable {
  if (pieces.length === 1) return pieces[0] as Resumable;
  return function* (frame): Resumption {
    for (const piece of pieces) {
      const completion = yield* piece(frame);
      if (completion !== undefined) return completion;
    }
    return;
  };
}

/**
 * Ends the lifetime of a scope's variables when its statements complete, or when the coroutine is destroyed while
 * suspended in them.
 */
function resumableScopeExit(run: Resumable, scope: Scope): Resumable {
  if (scope.slots.length === 0 && scope.statics.length === 0) return run;
  return function* (frame): Resumption {
    let endsProgram = false;
    try {
      return yield* run(frame);
    } catch (error) {
      // Only a caught exception unwinds the stack; other errors end the program where they occur.
      if (!(error instanceof CppException)) endsProgram = true;
      throw error;
    } finally {
      if (!endsProgram) endScope(frame, scope);
    }
  };
}

function evaluatesFirstOperandFirst(node: Syntax): boolean {
  if (node.type === 'conditional_expression' || node.type === 'comma_expression') return true;
  const operator = node.type === 'binary_expression' && node.all.find((child) => child.field === 'operator')?.type;
  return operator !== undefined && operator !== false && SHORT_CIRCUIT_OPERATORS.has(operator);
}

function findReturnStatement(node: Syntax): Syntax | undefined {
  if (node.type === 'return_statement') return node;
  if (OTHER_BODIES.has(node.type)) return undefined;
  for (const child of node.children) {
    const found = findReturnStatement(child);
    if (found) return found;
  }
  return undefined;
}

function unparenthesized(node: Syntax): Syntax {
  let current = node;
  while (current.type === 'parenthesized_expression' && current.children.length === 1)
    current = current.children[0] as Syntax;
  return current;
}

function isPure(node: Syntax): boolean {
  if (!PURE_EXPRESSIONS.has(node.type)) return false;
  if (node.type === 'unary_expression' || node.type === 'pointer_expression') {
    const operator = node.all.find((child) => child.field === 'operator')?.type;
    if (operator === '++' || operator === '--') return false;
  }
  return node.children.every((child) => child.type === 'field_identifier' || isPure(child));
}

function replaceChild(node: Syntax, child: Syntax, replacement: Syntax): Syntax {
  return replaceChildren(node, new Map([[child, replacement]]));
}

function replaceChildren(node: Syntax, replacements: ReadonlyMap<Syntax, Syntax>): Syntax {
  const all = node.all.map((child) => {
    const replacement = replacements.get(child);
    return replacement ? { ...replacement, field: child.field } : child;
  });
  return { ...node, all, children: all.filter((child) => child.isNamed) };
}
