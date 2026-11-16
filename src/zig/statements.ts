// code-gauge-allow-file duplicateLines 20 -- Library types repeat the same shape of method on purpose, each over its own state.
import { PANIC, panic } from './arith';
import { isDiscardName } from './ast';
import type { Capture, Expression, ExpressionOf, Label, Span, Statement, SwitchCase } from './ast';
import { CallCompiler, type FunctionCompilation } from './calls';
import type { FunctionInstance } from './functions';
import { type Frame, Jump, withHeldValues } from './runtime';
import {
  copyForFrame,
  errorSetIncludes,
  evaluateHeld,
  known,
  knownLengthOf,
  type LocalBinding,
  mergeErrorSets,
  runtime,
  type Scope,
  type TExpr,
  UNASSIGNED,
  undefinedValue,
} from './semaBase';
import {
  BOOL,
  COMPTIME_INT,
  type EnumType,
  type ErrorSetType,
  errorUnionOf,
  fitsInt,
  type IntType,
  isComptimeOnly,
  maxInt,
  minInt,
  NORETURN,
  pointerTo,
  type Type,
  typeName,
  U8,
  USIZE,
  VOID,
} from './types';
import {
  ErrorValue,
  NULL,
  Pointer,
  type Slice,
  type Slots,
  Some,
  storeInto,
  type Value,
  ZArray,
  type ZStruct,
  type ZUnion,
} from './values';

/** Runs a statement, returning the jump that leaves it, if any. */
export type Exec = (frame: Frame) => Jump | undefined;

/** A compiled statement, and whether it never completes normally. */
interface Stmt {
  exec: Exec;
  noreturn: boolean;
}

interface FnContext {
  instance: FunctionInstance;
  returnType: Type;
  inferredErrors?: ErrorSetType;
  /** What a `return` jumps to. */
  readonly target: object;
  recordsSteps: boolean;
  targets: JumpTarget[];
}

/** A block, loop, or switch that `break` and `continue` may leave. */
interface JumpTarget {
  readonly id: object;
  readonly label?: string;
  readonly kind: 'loop' | 'block' | 'switch';
  readonly resultType?: Type;
  /** The values that `break`s give, for the type of a labeled block or loop without a result type. */
  readonly breaks: BreakSite[];
  /** The type a labeled switch's `continue` gives a new operand of. */
  readonly operandType?: Type;
  broken: boolean;
}

interface BreakSite {
  value: TExpr;
  final?: TExpr;
}

const STATEMENT_DONE: Stmt = { exec: () => {}, noreturn: false };

export abstract class StatementCompiler extends CallCompiler {
  protected fn: FnContext | undefined;
  private slotCounter = 0;

  /** The atomic annotations' rows, when the program is traced. */
  protected abstract readonly tracing: boolean;

  protected localSlot(): number {
    const fn = this.fn;
    if (!fn) return this.error({ row: 0, col: 0, endRow: 0 }, '関数の外では変数を宣言できません。');
    const slot = fn.instance.slotCount++;
    this.slotCounter++;
    return slot;
  }

  // Functions -------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionNcss 37 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  // code-gauge-allow functionCognitiveComplexity 22 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  protected compileFunctionBody(compilation: FunctionCompilation): void {
    const { instance, syntax, namespace } = compilation;
    instance.state = 'compiling';
    instance.recordsSteps = this.tracing && !namespace.internal;
    const outerFn = this.fn;
    const fn: FnContext = {
      instance,
      returnType: compilation.returnType,
      inferredErrors: compilation.inferredErrors,
      target: {},
      recordsSteps: instance.recordsSteps,
      targets: [],
    };
    this.fn = fn;
    const locals = new Map<string, LocalBinding>();
    const scope: Scope = {
      locals,
      parent: { namespace, parent: namespace.scope as Scope | undefined },
    };
    try {
      this.withScope(scope, () => {
        instance.paramSlots = syntax.params.map((param, index) => {
          const slot = this.localSlot();
          const type = compilation.paramTypes[index];
          if (!isDiscardName(param)) {
            const binding: LocalBinding = {
              kind: 'local',
              name: param.name,
              slot,
              type,
              isConst: true,
              known: compilation.comptimeArgs[index]?.known ?? false,
              value: compilation.comptimeArgs[index]?.value,
            };
            locals.set(param.name, binding);
            const isReceiver = compilation.isMethod && index === 0 && isSelfType(type, namespace);
            instance.locals.push({ name: param.name, slot, type, isReceiver });
          }
          return slot;
        });
        const body = this.blockStatements(syntax.body.statements, syntax.body, true);
        const payload =
          compilation.returnType.kind === 'error_union' ? compilation.returnType.payload : compilation.returnType;
        if (!body.noreturn && payload.kind !== 'void' && payload.kind !== 'noreturn') {
          this.error(
            syntax.body,
            `関数「${syntax.name}」の最後に return がありません（${typeName(compilation.returnType)} 型の値を返してください）。`
          );
        }
        const { target } = fn;
        const exec = body.exec;
        instance.body = (frame) => {
          try {
            const completion = exec(frame);
            return completion?.kind === 'return' ? completion.value : undefined;
          } catch (error) {
            if (error instanceof Jump && error.target === target) return error.value;
            throw error;
          }
        };
      });
    } finally {
      this.fn = outerFn;
    }
    instance.state = 'compiled';
    if (compilation.inferredErrors) compilation.inferredErrors.resolved = true;
  }

  private currentFn(span: Span): FnContext {
    if (!this.fn) return this.error(span, 'この式は、関数の中でだけ書けます。');
    return this.fn;
  }

  /** The row whose step a statement records, when the program is traced. */
  private stepRow(span: Span): number | undefined {
    return this.fn?.recordsSteps ? span.row : undefined;
  }

  // Blocks ----------------------------------------------------------------------------------------------------------

  protected blockStatements(statements: readonly Statement[], span: Span, keepLocals = false): Stmt {
    const locals = new Map<string, LocalBinding>();
    const scope: Scope = { locals, parent: this.scope };
    return this.withScope(scope, () => {
      const compiled: Stmt[] = [];
      let hasDefers = false;
      let noreturn = false;
      for (const statement of statements) {
        const stmt = this.statement(statement);
        if (statement.kind === 'defer') hasDefers = true;
        compiled.push(stmt);
        if (stmt.noreturn) {
          noreturn = true;
          break;
        }
      }
      void span;
      const slots = keepLocals ? [] : [...locals.values()].map((binding) => binding.slot);
      const execs = compiled.map((stmt) => stmt.exec);
      const run = (frame: Frame): Jump | undefined => {
        for (const exec of execs) {
          const completion = exec(frame);
          if (completion) return completion;
        }
        return undefined;
      };
      const clear = (frame: Frame): void => {
        for (const slot of slots) frame.slots[slot] = UNASSIGNED;
      };
      if (!hasDefers) {
        if (slots.length === 0) return { exec: run, noreturn };
        return {
          exec: (frame) => {
            try {
              return run(frame);
            } finally {
              clear(frame);
            }
          },
          noreturn,
        };
      }
      const fnTarget = this.fn?.target;
      return {
        exec: (frame) => {
          const mark = frame.defers.length;
          try {
            let completion: Jump | undefined;
            try {
              completion = run(frame);
            } catch (error) {
              if (error instanceof Jump) runDefers(frame, mark, error, fnTarget);
              throw error;
            }
            runDefers(frame, mark, completion, fnTarget);
            return completion;
          } finally {
            clear(frame);
          }
        },
        noreturn,
      };
    });
  }

  private declareLocal(name: string, type: Type, isConst: boolean, value?: TExpr, quotedName = false): LocalBinding {
    const fn = this.currentFn({ row: 0, col: 0, endRow: 0 });
    const slot = this.localSlot();
    const binding: LocalBinding = {
      kind: 'local',
      name,
      slot,
      type,
      isConst,
      knownLength: isConst ? value?.knownLength : undefined,
      known: Boolean(isConst && (value?.known || value?.staticResult)),
      value: isConst ? (value?.known ? value.value : value?.staticResult?.value) : undefined,
    };
    if (!isDiscardName({ name, quotedName })) {
      this.scope.locals?.set(name, binding);
      fn.instance.locals.push({ name, slot, type, isReceiver: false });
    }
    return binding;
  }

  // Statements ------------------------------------------------------------------------------------------------------

  private statement(statement: Statement): Stmt {
    switch (statement.kind) {
      case 'var': {
        return this.variableDeclaration(statement);
      }
      case 'destructure': {
        return this.destructure(statement);
      }
      case 'expression': {
        return this.statementExpression(statement.expression, statement);
      }
      case 'defer': {
        return this.deferStatement(statement);
      }
    }
  }

  private variableDeclaration(statement: Extract<Statement, { kind: 'var' }>): Stmt {
    const declared = statement.type ? this.compileType(statement.type) : undefined;
    const valueSyntax = statement.value as Expression;
    const isUndefined = valueSyntax.kind === 'undefined';
    let value = this.compile(valueSyntax, declared);
    if (declared) value = this.coerce(value, declared, valueSyntax);
    const type = value.type;
    if (!statement.isConst && isComptimeOnly(type)) {
      this.error(
        statement,
        `変数「${statement.name}」の型 ${typeName(type)} は、コンパイルのときだけの型なので、const で宣言してください。`
      );
    }
    if (type.kind === 'noreturn') return { exec: this.valueExec(value), noreturn: true };
    const binding = this.declareLocal(statement.name, type, statement.isConst, value, statement.quotedName);
    const { slot } = binding;
    const evaluate = value.eval;
    const row = isUndefined ? undefined : this.stepRow(statement);
    const run = (frame: Frame): void => {
      frame.slots[slot] = copyForFrame(frame, evaluate(frame), type);
    };
    return { exec: this.simple(row, isObjectCreation(valueSyntax), run), noreturn: false };
  }

  // code-gauge-allow functionNcss 49 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  // code-gauge-allow functionCognitiveComplexity 29 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  private destructure(statement: Extract<Statement, { kind: 'destructure' }>): Stmt {
    const sequential = this.sequentialDestructure(statement);
    if (sequential) return sequential;
    const value = this.compile(statement.value);
    const type = value.type;
    const count = statement.targets.length;
    let elementTypes: Type[];
    if (type.kind === 'struct' && type.isTuple) elementTypes = (type.fields ?? []).map((field) => field.type);
    else if (type.kind === 'array') {
      if (type.length !== count)
        this.error(statement, `分割代入の数が合いません（${count} 個ですが、値は ${type.length} 個です）。`);
      elementTypes = Array.from({ length: count }, () => type.child);
    } else return this.error(statement, `${typeName(type)} 型の値は、分割して代入できません。`);
    if (elementTypes.length !== count) {
      this.error(statement, `分割代入の数が合いません（${count} 個ですが、値は ${elementTypes.length} 個です）。`);
    }
    const isArray = type.kind === 'array';
    const aggregateSlot = this.localSlot();
    const held = value.known ? value : runtime(type, (frame) => frame.slots[aggregateSlot], statement);
    const stores = statement.targets.map((target, index) => {
      const elementExpression = this.elementOf(held, index, elementTypes[index], isArray, statement);
      if (target.declaration) {
        const declared = target.declaration.type ? this.compileType(target.declaration.type) : undefined;
        const coerced = declared ? this.coerce(elementExpression, declared, target) : elementExpression;
        if (!target.declaration.isConst && isComptimeOnly(coerced.type)) {
          this.error(
            target,
            `変数「${target.declaration.name}」の型 ${typeName(coerced.type)} は、コンパイルのときだけの型です。`
          );
        }
        const binding = this.declareLocal(
          target.declaration.name,
          coerced.type,
          target.declaration.isConst,
          coerced,
          target.declaration.quotedName
        );
        const convert = coerced;
        return (frame: Frame): void => {
          frame.slots[binding.slot] = copyForFrame(frame, convert.eval(frame), convert.type);
        };
      }
      const destination = target.target as Expression;
      if (destination.kind === 'identifier' && isDiscardName(destination)) return () => {};
      const place = this.assignablePlace(destination);
      const convert = this.coerce(elementExpression, place.type, target);
      return (frame: Frame): void => {
        const pointer = place.place.locate(frame);
        storeInto(pointer.target, pointer.index, convert.eval(frame));
      };
    });
    const evaluate = value.eval;
    const row = this.stepRow(statement);
    return {
      exec: this.simple(row, false, (frame) => {
        frame.slots[aggregateSlot] = copyForFrame(frame, evaluate(frame), type);
        try {
          for (const store of stores) store(frame);
        } finally {
          frame.slots[aggregateSlot] = UNASSIGNED;
        }
      }),
      noreturn: false,
    };
  }

  /**
   * `a, b = .{ b, a };` stores each element as soon as it computes it, as Zig's result locations do, so that a later
   * element sees an earlier one's new value.
   */
  private sequentialDestructure(statement: Extract<Statement, { kind: 'destructure' }>): Stmt | undefined {
    const { value } = statement;
    if (value.kind !== 'arrayInit' || value.type || statement.targets.some((target) => target.declaration))
      return undefined;
    if (value.elements.length !== statement.targets.length) {
      this.error(
        statement,
        `分割代入の数が合いません（${statement.targets.length} 個ですが、値は ${value.elements.length} 個です）。`
      );
    }
    const stores = statement.targets.map((target, index) => {
      const destination = target.target as Expression;
      const element = value.elements[index];
      if (destination.kind === 'identifier' && isDiscardName(destination)) {
        const discarded = this.compile(element).eval;
        return (frame: Frame): void => void discarded(frame);
      }
      const place = this.assignablePlace(destination);
      const evaluate = this.coerce(this.compile(element, place.type), place.type, element).eval;
      const locate = place.place.locate;
      return (frame: Frame): void => {
        const pointer = locate(frame);
        withHeldValues(frame, [pointer], () => storeInto(pointer.target, pointer.index, evaluate(frame)));
      };
    });
    return {
      exec: this.simple(this.stepRow(statement), false, (frame) => {
        for (const store of stores) store(frame);
      }),
      noreturn: false,
    };
  }

  private elementOf(value: TExpr, index: number, type: Type, isArray: boolean, span: Span): TExpr {
    if (value.known) {
      return known(type, isArray ? (value.value as ZArray).get(index) : (value.value as ZStruct).slots[index], span);
    }
    const evaluate = value.eval;
    return runtime(
      type,
      (frame) => {
        const aggregate = evaluate(frame);
        return isArray ? (aggregate as ZArray).get(index) : (aggregate as ZStruct).slots[index];
      },
      span
    );
  }

  private assignablePlace(target: Expression): {
    place: NonNullable<TExpr['place']>;
    type: Type;
    expression: TExpr;
  } {
    const expression = this.compile(target);
    const place = expression.place;
    if (!place) return this.error(target, 'この式には代入できません。');
    if (place.isConst) {
      return this.error(
        target,
        expression.local ? `定数「${expression.local.name}」には代入できません。` : '定数には代入できません。'
      );
    }
    return { place, type: expression.type, expression };
  }

  private deferStatement(statement: Extract<Statement, { kind: 'defer' }>): Stmt {
    this.currentFn(statement);
    const body = this.withScope({ locals: new Map(), parent: this.scope }, () =>
      this.statementExpression(statement.body, statement.body)
    );
    const exec = body.exec;
    const isErrdefer = statement.isErrdefer;
    return {
      exec: (frame) => {
        frame.defers.push({ isErrdefer, run: (deferFrame) => void exec(deferFrame) });
        return;
      },
      noreturn: false,
    };
  }

  /** Runs a simple statement and records its step, as `StepTracker.runStatement` decides. */
  private simple(row: number | undefined, onlyCalls: boolean | (() => boolean), run: (frame: Frame) => void): Exec {
    if (row === undefined) {
      return (frame) => {
        run(frame);
        return;
      };
    }
    return (frame) => {
      frame.runtime.steps.runStatement(row, onlyCalls, () => run(frame));
      return;
    };
  }

  private valueStmt(value: TExpr): Stmt {
    return { exec: this.valueExec(value), noreturn: value.type.kind === 'noreturn' };
  }

  private valueExec(value: TExpr): Exec {
    const evaluate = value.eval;
    return (frame) => {
      evaluate(frame);
      return;
    };
  }

  private statementExpression(expression: Expression, span: Span): Stmt {
    switch (expression.kind) {
      case 'if': {
        return this.ifStatement(expression);
      }
      case 'while': {
        return this.whileLoop(expression, undefined, true).stmt;
      }
      case 'for': {
        return this.forLoop(expression, undefined, true).stmt;
      }
      case 'switch': {
        return this.switchStatement(expression, undefined, true).stmt;
      }
      case 'block': {
        return this.blockStatement(expression, undefined, true).stmt;
      }
      case 'break':
      case 'continue':
      case 'return': {
        return this.jumpStatement(expression);
      }
      case 'assign': {
        return this.assignment(expression, span);
      }
      case 'paren': {
        return this.statementExpression(expression.operand, span);
      }
      default: {
        return this.expressionStatement(expression, span);
      }
    }
  }

  private expressionStatement(expression: Expression, span: Span): Stmt {
    const value = this.compile(expression);
    const type = value.type;
    this.rejectDiscardedError(type, expression);
    if (type.kind !== 'void' && type.kind !== 'noreturn') {
      this.error(expression, `${typeName(type)} 型の値を使っていません（捨てるときは _ = ... と書きます）。`);
    }
    const evaluate = value.eval;
    const row = this.stepRow(span);
    const onlyCalls = isCallOnly(expression);
    return {
      exec: this.simple(row, onlyCalls, (frame) => void evaluate(frame)),
      noreturn: type.kind === 'noreturn',
    };
  }

  // code-gauge-allow functionNcss 36 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  private assignment(expression: ExpressionOf<'assign'>, span: Span): Stmt {
    const row = this.stepRow(span);
    if (expression.targets.length !== 1) return this.error(expression, '書き方に誤りがあります。');
    const [target] = expression.targets;
    if (target.kind === 'identifier' && isDiscardName(target)) {
      const discarded = unwrapParens(expression.value);
      const value =
        discarded.kind === 'catch' ? this.compileCatch(discarded, undefined, true) : this.compile(expression.value);
      this.rejectDiscardedError(value.type, expression.value);
      const evaluate = value.eval;
      return {
        exec: this.simple(row, isCallOnly(expression.value), (frame) => void evaluate(frame)),
        noreturn: value.type.kind === 'noreturn',
      };
    }
    const { place, type, expression: targetExpression } = this.assignablePlace(target);
    if (expression.operator === '=') {
      const anonymous = this.anonymousInitAssignment(expression.value, type, place);
      if (anonymous) return { exec: this.simple(row, false, anonymous), noreturn: false };
      const value = this.coerce(this.compile(expression.value, type), type, expression.value);
      const evaluate = value.eval;
      const onlyCalls = isObjectCreation(expression.value);
      return {
        exec: this.simple(row, onlyCalls, (frame) => {
          const pointer = place.locate(frame);
          withHeldValues(frame, [pointer], () => storeInto(pointer.target, pointer.index, evaluate(frame)));
        }),
        noreturn: value.type.kind === 'noreturn',
      };
    }
    const operator = expression.operator.slice(0, -1);
    const locationSlot = this.localSlot();
    const current = runtime(type, (frame) => (frame.slots[locationSlot] as Pointer).load(), target);
    void targetExpression;
    const combined = this.compoundValue(current, operator, expression.value, expression);
    const evaluate = combined.eval;
    return {
      exec: this.simple(row, false, (frame) => {
        const pointer = place.locate(frame);
        frame.slots[locationSlot] = pointer;
        try {
          storeInto(pointer.target, pointer.index, evaluate(frame));
        } finally {
          frame.slots[locationSlot] = UNASSIGNED;
        }
      }),
      noreturn: false,
    };
  }

  private rejectDiscardedError(type: Type, span: Span): void {
    if (type.kind === 'error_union' || type.kind === 'error_set')
      this.error(span, 'エラーを無視しています。try・catch・if で受け取ってください。');
  }

  /**
   * The new value of `target op= value`. Zig coerces the right operand to the target's type, except for shifts, whose
   * amount has its own type.
   */
  private compoundValue(current: TExpr, operator: string, value: Expression, span: Span): TExpr {
    const holder = '\u0000compound';
    const binding = this.declareTemporary(holder, current);
    const position = { row: span.row, col: span.col, endRow: span.endRow };
    const isShift = operator.startsWith('<<') || operator.startsWith('>>');
    const right = isShift ? undefined : this.coerce(this.compile(value, current.type), current.type, value);
    const rightHolder = '\u0000compoundValue';
    const rightBinding = right ? this.declareTemporary(rightHolder, right) : undefined;
    const synthetic: Expression = {
      kind: 'binary',
      ...position,
      operator: operator as ExpressionOf<'binary'>['operator'],
      left: { kind: 'identifier', ...position, name: holder },
      right: rightBinding ? { kind: 'identifier', ...position, name: rightHolder } : value,
    };
    const locals = new Map([[holder, binding.binding]]);
    if (rightBinding) locals.set(rightHolder, rightBinding.binding);
    const result = this.withScope({ locals, parent: this.scope }, () =>
      this.coerce(this.compile(synthetic, current.type), current.type, span)
    );
    const read = current.eval;
    const readRight = right?.eval;
    const slot = binding.binding.slot;
    const rightSlot = rightBinding?.binding.slot;
    const evaluate = result.eval;
    return runtime(
      current.type,
      (frame) => {
        frame.slots[slot] = read(frame);
        if (readRight && rightSlot !== undefined) frame.slots[rightSlot] = readRight(frame);
        const computed = evaluate(frame);
        frame.slots[slot] = UNASSIGNED;
        if (rightSlot !== undefined) frame.slots[rightSlot] = UNASSIGNED;
        return computed;
      },
      span
    );
  }

  private declareTemporary(name: string, value: TExpr): { binding: LocalBinding } {
    const slot = this.localSlot();
    return {
      binding: { kind: 'local', name, slot, type: value.type, isConst: true, known: false },
    };
  }

  /**
   * `x = .{ ... }` writes each field or element into `x` in turn, as Zig's result locations do, so that later fields see
   * the earlier ones' new values; nested anonymous literals write into the nested fields the same way.
   */
  private anonymousInitAssignment(
    value: Expression,
    type: Type,
    place: NonNullable<TExpr['place']>
  ): ((frame: Frame) => void) | undefined {
    const store = this.resultLocationStore(value, type);
    if (!store) return undefined;
    const locate = place.locate;
    return (frame) => {
      const pointer = locate(frame);
      withHeldValues(frame, [pointer], () => store(frame, pointer.target, pointer.index));
    };
  }

  /** The code that writes an anonymous literal into the value at `holder.slots[index]`, or undefined for other values. */
  // code-gauge-allow functionCognitiveComplexity 28 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  private resultLocationStore(value: Expression, type: Type): ResultStore | undefined {
    if (
      value.kind === 'structInit' &&
      !value.type &&
      type.kind === 'struct' &&
      !type.isTuple &&
      value.fields.length > 0
    ) {
      return this.fieldStores(value, type);
    }
    const tupleTypes =
      type.kind === 'struct' && type.isTuple ? this.structFields(type, value).map((field) => field.type) : undefined;
    if (value.kind === 'arrayInit' && !value.type && (type.kind === 'array' || tupleTypes)) {
      const length = type.kind === 'array' ? type.length : (tupleTypes as Type[]).length;
      if (value.elements.length !== length) {
        this.error(value, `配列の長さが合いません（${length} 個が必要ですが、${value.elements.length} 個です）。`);
      }
      const stores = value.elements.map((element, index) =>
        this.slotStore(element, type.kind === 'array' ? type.child : (tupleTypes as Type[])[index])
      );
      return (frame, holder, index) => {
        const aggregate = holder.slots[index] as ZArray | ZStruct;
        const offset = aggregate instanceof ZArray ? aggregate.offset : 0;
        for (const [position, store] of stores.entries()) store(frame, aggregate, offset + position);
        if (type.kind === 'array' && type.sentinel !== undefined) storeInto(aggregate, offset + length, type.sentinel);
      };
    }
    if (value.kind === 'structInit' && !value.type && type.kind === 'union' && value.fields.length === 1) {
      return this.unionStore(value, type);
    }
    if (type.kind === 'optional' && isAggregateType(type.child)) return this.optionalStore(value, type);
    return undefined;
  }

  /** `x = .{ ... }` for an optional `x`: a non-null value is written in place, and a null one takes the whole value. */
  private optionalStore(value: Expression, type: Extract<Type, { kind: 'optional' }>): ResultStore | undefined {
    const inner = this.resultLocationStore(value, type.child);
    if (!inner) return undefined;
    const whole = this.coerce(this.compile(value, type), type, value).eval;
    return (frame, holder, index) => {
      const current = holder.slots[index];
      if (current === NULL) storeInto(holder, index, whole(frame));
      else if (current instanceof Some) inner(frame, { slots: [current.value] }, 0);
      else inner(frame, holder, index);
    };
  }

  private fieldStores(value: ExpressionOf<'structInit'>, type: Extract<Type, { kind: 'struct' }>): ResultStore {
    const fields = this.structFields(type, value);
    for (const init of value.fields) {
      if (!fields.some((field) => field.name === init.name))
        this.error(init, `${typeName(type)} 型には、フィールド「${init.name}」がありません。`);
    }
    const seen = new Set<string>();
    const stores = value.fields.map((init) => {
      if (seen.has(init.name)) this.error(init, `フィールド「${init.name}」を2回初期化しています。`);
      seen.add(init.name);
      const position = fields.findIndex((field) => field.name === init.name);
      return { position, store: this.slotStore(init.value, fields[position].type) };
    });
    for (const [position, field] of fields.entries()) {
      if (seen.has(field.name)) continue;
      if (!field.hasDefault) this.error(value, `フィールド「${field.name}」の値がありません。`);
      stores.push({ position, store: (_frame, holder, index) => storeInto(holder, index, field.defaultValue) });
    }
    return (frame, holder, index) => {
      const struct = holder.slots[index] as ZStruct;
      for (const { position, store } of stores) store(frame, struct, position);
    };
  }

  /** `u = .{ .a = ... }` makes `a` the active field first, so the value sees the new tag, as Zig's result location does. */
  private unionStore(value: ExpressionOf<'structInit'>, type: Extract<Type, { kind: 'union' }>): ResultStore {
    const [init] = value.fields;
    const fields = this.unionFields(type);
    const tag = fields.findIndex((field) => field.name === init.name);
    if (tag === -1) return this.error(init, `${typeName(type)} 型には、フィールド「${init.name}」がありません。`);
    const fieldType = fields[tag].type;
    const store = this.slotStore(init.value, fieldType);
    return (frame, holder, index) => {
      const union = holder.slots[index] as ZUnion;
      const changed = union.tag !== tag;
      union.tag = tag;
      if (changed) union.slots[0] = undefinedValue(fieldType);
      store(frame, union, 0);
    };
  }

  /** The code that writes a field's or element's value: in place for a nested anonymous literal, else as a whole. */
  private slotStore(value: Expression, type: Type): ResultStore {
    const nested = this.resultLocationStore(value, type);
    if (nested) return nested;
    const evaluate = this.coerce(this.compile(value, type), type, value).eval;
    return (frame, holder, index) => storeInto(holder, index, evaluate(frame));
  }

  // Jumps -------------------------------------------------------------------------------------------------------------

  private findTarget(label: Label | undefined, kind: 'break' | 'continue', span: Span): JumpTarget {
    const fn = this.currentFn(span);
    for (let index = fn.targets.length - 1; index >= 0; index--) {
      const target = fn.targets[index];
      if (label) {
        if (target.label === label.name) return target;
      } else if (target.kind === 'loop') {
        return target;
      }
    }
    return this.error(span, kind === 'break' ? 'break の行き先がありません。' : 'continue の行き先がありません。');
  }

  private jumpStatement(expression: ExpressionOf<'break' | 'continue' | 'return'>): Stmt {
    const make = this.jumpMaker(expression);
    return { exec: (frame) => make(frame), noreturn: true };
  }

  /** The code of a jump: it computes the jump's value and gives the Jump that leaves its target. */
  private jumpMaker(expression: ExpressionOf<'break' | 'continue' | 'return'>): (frame: Frame) => Jump {
    if (expression.kind === 'return') return this.returnMaker(expression);
    const target = this.findTarget(expression.label, expression.kind, expression);
    const { id } = target;
    if (expression.kind === 'continue') {
      if (target.kind === 'switch') {
        const operand = this.coerce(
          this.compile(expression.value as Expression, target.operandType),
          target.operandType as Type,
          expression
        );
        const evaluate = copyJumpValue(operand);
        return (frame) => new Jump('continue', id, evaluate(frame));
      }
      return () => new Jump('continue', id, undefined);
    }
    target.broken = true;
    if (!expression.value) {
      const site: BreakSite = { value: known(VOID, undefined, expression) };
      target.breaks.push(site);
      if (target.resultType && target.resultType.kind !== 'void' && target.kind !== 'loop') {
        this.coerce(site.value, target.resultType, expression);
      }
      return () => new Jump('break', id, undefined);
    }
    const value = this.compile(expression.value, target.resultType);
    const site: BreakSite = {
      value: target.resultType ? this.coerce(value, target.resultType, expression.value) : value,
    };
    target.breaks.push(site);
    if (target.resultType) site.final = site.value;
    return (frame) => new Jump('break', id, copyJumpValue(site.final ?? site.value)(frame));
  }

  private returnMaker(expression: ExpressionOf<'return'>): (frame: Frame) => Jump {
    const fn = this.currentFn(expression);
    const { target, returnType } = fn;
    if (!expression.value) {
      const payload = returnType.kind === 'error_union' ? returnType.payload : returnType;
      if (payload.kind !== 'void') this.error(expression, `${typeName(returnType)} 型の値を返してください。`);
      return () => new Jump('return', target, undefined);
    }
    let value = this.compile(expression.value, returnType);
    this.recordErrors(value.type, value);
    value = this.coerce(value, returnType, expression.value);
    const evaluate = copyJumpValue(value);
    return (frame) => new Jump('return', target, evaluate(frame));
  }

  protected growsErrorSet(set: ErrorSetType): boolean {
    return this.fn?.inferredErrors === set;
  }

  /** Adds the errors a returned value may hold to the function's inferred error set. */
  private recordErrors(type: Type, value: TExpr | undefined): void {
    const inferred = this.fn?.inferredErrors;
    if (!inferred?.names) return;
    const set = type.kind === 'error_union' ? type.errorSet : type.kind === 'error_set' ? type : undefined;
    if (!set) return;
    if (set.names === undefined) {
      inferred.names = undefined;
      return;
    }
    if (value?.known && value.value instanceof ErrorValue) {
      inferred.names.add(value.value.name);
      return;
    }
    for (const name of set.names) inferred.names.add(name);
  }

  // Control flow as expressions ---------------------------------------------------------------------------------------

  protected compileControl(expression: Expression, resultType: Type | undefined): TExpr {
    switch (expression.kind) {
      case 'if': {
        return this.ifExpression(expression, resultType);
      }
      case 'while': {
        return this.whileLoop(expression, resultType, false).value;
      }
      case 'for': {
        return this.forLoop(expression, resultType, false).value;
      }
      case 'switch': {
        return this.switchStatement(expression, resultType, false).value;
      }
      case 'block': {
        return this.blockStatement(expression, resultType, false).value;
      }
      case 'break':
      case 'continue':
      case 'return': {
        const make = this.jumpMaker(expression);
        return runtime(
          NORETURN,
          (frame) => {
            throw make(frame);
          },
          expression
        );
      }
      default: {
        return this.error(expression, '書き方に誤りがあります。');
      }
    }
  }

  /** A block as a statement or an expression; a labeled block's value is what `break :label value` gives. */
  // code-gauge-allow functionNcss 42 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  // code-gauge-allow functionCognitiveComplexity 27 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  private blockStatement(
    expression: ExpressionOf<'block'>,
    resultType: Type | undefined,
    asStatement: boolean
  ): { stmt: Stmt; value: TExpr } {
    const fn = this.currentFn(expression);
    if (!expression.label) {
      const stmt = this.blockStatements(expression.statements, expression);
      const exec = stmt.exec;
      const type = stmt.noreturn ? NORETURN : VOID;
      return {
        stmt,
        value: runtime(
          type,
          (frame) => {
            const completion = exec(frame);
            if (completion) throw completion;
            return;
          },
          expression
        ),
      };
    }
    const target: JumpTarget = {
      id: {},
      label: expression.label.name,
      kind: 'block',
      resultType: asStatement ? undefined : resultType,
      breaks: [],
      broken: false,
    };
    fn.targets.push(target);
    let body: Stmt;
    try {
      body = this.blockStatements(expression.statements, expression);
    } finally {
      fn.targets.pop();
    }
    const type = this.resolveBreaks(target, body.noreturn, expression);
    const exec = body.exec;
    const { id } = target;
    const run = (frame: Frame): Value => {
      let completion: Jump | undefined;
      try {
        completion = exec(frame);
      } catch (error) {
        if (error instanceof Jump && error.target === id) return error.value;
        throw error;
      }
      if (completion) {
        if (completion.target === id) return completion.value;
        throw completion;
      }
      return undefined;
    };
    const stmt: Stmt = {
      exec: (frame) => {
        try {
          run(frame);
        } catch (error) {
          if (error instanceof Jump) return error;
          throw error;
        }
        return;
      },
      noreturn: body.noreturn && !target.broken,
    };
    if (asStatement && type.kind !== 'void' && type.kind !== 'noreturn') {
      this.error(expression, `${typeName(type)} 型の値を使っていません。`);
    }
    return { stmt, value: runtime(stmt.noreturn ? NORETURN : type, run, expression) };
  }

  /** The type of what the `break`s of a target give, coercing each to it. */
  private resolveBreaks(target: JumpTarget, bodyNoreturn: boolean, span: Span): Type {
    if (target.resultType) {
      // A labeled block whose end is reachable gives `void` there.
      if (!bodyNoreturn && target.kind === 'block' && target.resultType.kind !== 'void') {
        this.coerce(known(VOID, undefined, span), target.resultType, span);
      }
      return target.resultType;
    }
    const values = target.breaks.map((site) => site.value);
    if (!bodyNoreturn && target.kind === 'block') values.push(known(VOID, undefined, span));
    if (values.length === 0) return bodyNoreturn ? NORETURN : VOID;
    const type = this.peerType(values, span);
    for (const site of target.breaks) site.final = this.coerce(site.value, type, site.value.span);
    return type;
  }

  // If ----------------------------------------------------------------------------------------------------------------

  private ifStatement(expression: ExpressionOf<'if'>): Stmt {
    return this.ifCompiled(expression, undefined, true).stmt;
  }

  private ifExpression(expression: ExpressionOf<'if'>, resultType: Type | undefined): TExpr {
    return this.ifCompiled(expression, resultType, false).value;
  }

  private ifCompiled(
    expression: ExpressionOf<'if'>,
    resultType: Type | undefined,
    asStatement: boolean
  ): { stmt: Stmt; value: TExpr } {
    const condition = this.compile(expression.condition);
    const kind = conditionKind(condition.type, expression.capture !== undefined);
    if (kind === 'bool') {
      const test = this.coerce(condition, BOOL, expression.condition);
      if (expression.capture) this.error(expression.capture, 'bool の条件からは値を受け取れません。');
      if (expression.elseCapture) this.error(expression.elseCapture, 'bool の条件の else では値を受け取れません。');
      if (test.known) {
        // Zig analyzes only the branch that a condition known at compile time selects.
        const branch = (test.value as boolean) ? expression.consequent : expression.otherwise;
        if (!branch) return { stmt: STATEMENT_DONE, value: known(VOID, undefined, expression) };
        const chosen = this.branch(branch, undefined, resultType, asStatement);
        return {
          stmt: chosen.stmt ?? this.valueStmt(chosen.value as TExpr),
          value: chosen.value ?? known(VOID, undefined, expression),
        };
      }
      const then = this.branch(expression.consequent, undefined, resultType, asStatement);
      const otherwise = expression.otherwise
        ? this.branch(expression.otherwise, undefined, resultType, asStatement)
        : undefined;
      const evaluateTest = test.eval;
      return this.combineBranches(expression, then, otherwise, resultType, asStatement, (frame) =>
        evaluateTest(frame) ? 0 : 1
      );
    }
    if (kind === 'optional') {
      if (condition.type.kind !== 'optional') return this.error(expression.condition, 'optional の値が必要です。');
      const child = condition.type.child;
      if (expression.elseCapture) this.error(expression.elseCapture, 'optional の条件の else では値を受け取れません。');
      if (condition.known) {
        const present = condition.value !== NULL;
        return this.selectedBranch(
          present ? expression.consequent : expression.otherwise,
          present ? this.captureBinding(expression.capture, child, condition) : undefined,
          condition,
          (value) => (value instanceof Some ? value.value : value),
          resultType,
          asStatement
        );
      }
      const capture = expression.capture;
      const binding = this.captureBinding(capture, child, condition);
      const then = this.withCapture(binding, () =>
        this.branch(expression.consequent, undefined, resultType, asStatement)
      );
      const otherwise = expression.otherwise
        ? this.branch(expression.otherwise, undefined, resultType, asStatement)
        : undefined;
      const evaluate = condition.eval;
      const bind = binding?.bind;
      return this.combineBranches(
        expression,
        then,
        otherwise,
        resultType,
        asStatement,
        (frame) => {
          const pointer = binding?.locate?.(frame);
          const value = pointer ? pointer.load() : evaluate(frame);
          if (value === NULL) return 1;
          bind?.(frame, value instanceof Some ? value.value : value, pointer);
          return 0;
        },
        [binding?.binding]
      );
    }
    // An error union: `if (eu) |value| ... else |err| ...`.
    if (condition.type.kind !== 'error_union') return this.error(expression.condition, 'エラー共用体の値が必要です。');
    const union = condition.type;
    if (!expression.otherwise) return this.error(expression, 'エラー共用体の if には else が要ります。');
    if (condition.known || (union.errorSet.resolved !== false && union.errorSet.names?.size === 0)) {
      const failed = condition.known && condition.value instanceof ErrorValue;
      const capture = failed
        ? this.captureBinding(expression.elseCapture, union.errorSet, undefined)
        : this.captureBinding(expression.capture, union.payload, condition);
      return this.selectedBranch(
        failed ? expression.otherwise : expression.consequent,
        capture,
        condition,
        (value) => value,
        resultType,
        asStatement
      );
    }
    const binding = this.captureBinding(expression.capture, union.payload, condition);
    const errorBinding = this.captureBinding(expression.elseCapture, union.errorSet, undefined);
    const then = this.withCapture(binding, () =>
      this.branch(expression.consequent, undefined, resultType, asStatement)
    );
    if (!expression.otherwise) return this.error(expression, 'エラー共用体の if には else が要ります。');
    const otherwise = this.withCapture(errorBinding, () =>
      this.branch(expression.otherwise as Expression, undefined, resultType, asStatement)
    );
    const evaluate = condition.eval;
    const bind = binding?.bind;
    const bindError = errorBinding?.bind;
    return this.combineBranches(
      expression,
      then,
      otherwise,
      resultType,
      asStatement,
      (frame) => {
        const pointer = binding?.locate?.(frame);
        const value = pointer ? pointer.load() : evaluate(frame);
        if (value instanceof ErrorValue) {
          bindError?.(frame, value);
          return 1;
        }
        bind?.(frame, value, pointer);
        return 0;
      },
      [binding?.binding, errorBinding?.binding]
    );
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- Keeps known capture facts and their lexical runtime initialization together.
  private selectedBranch(
    expression: Expression | undefined,
    capture: ReturnType<StatementCompiler['captureBinding']>,
    condition: TExpr,
    payload: (value: Value) => Value,
    resultType: Type | undefined,
    asStatement: boolean
  ): { stmt: Stmt; value: TExpr } {
    if (!expression) {
      const value = this.derived(condition, VOID, () => {});
      return { stmt: this.valueStmt(value), value };
    }
    if (capture && condition.known) {
      const address = capture.locate ? this.addressOf(condition) : undefined;
      if (!address || address.known) {
        capture.binding = {
          ...capture.binding,
          known: true,
          value: address
            ? condition.type.kind === 'optional'
              ? this.optionalPayloadPointer(address.value as Pointer)
              : address.value
            : payload(condition.value),
        };
      }
    }
    const chosen = this.withCapture(capture, () => this.branch(expression, undefined, resultType, asStatement));
    const run = <T>(frame: Frame, evaluate: (frame: Frame) => T): T => {
      try {
        const pointer = capture?.locate?.(frame);
        const value = pointer ? pointer.load() : condition.eval(frame);
        capture?.bind(frame, payload(value), pointer);
        return evaluate(frame);
      } finally {
        if (capture) frame.slots[capture.binding.slot] = UNASSIGNED;
      }
    };
    const chosenValue = chosen.value;
    const value = chosenValue
      ? { ...chosenValue, place: undefined, eval: (frame: Frame) => run(frame, chosenValue.eval) }
      : known(VOID, undefined, condition.span);
    const chosenStmt = chosen.stmt;
    const stmt = chosenStmt
      ? { ...chosenStmt, exec: (frame: Frame) => run(frame, chosenStmt.exec) }
      : this.valueStmt(value);
    return { stmt, value };
  }

  /** A value whose type exists only at compile time, such as `comptime_int`, cannot depend on a runtime condition. */
  private rejectRuntimeComptime(type: Type, span: Span): void {
    if (type.kind === 'comptime_int' || type.kind === 'comptime_float') {
      this.error(
        span,
        `${typeName(type)} 型の値が、実行時の条件で変わります（@as(i32, ...) のように型を決めてください）。`
      );
    }
  }

  private branch(
    expression: Expression,
    _capture: undefined,
    resultType: Type | undefined,
    asStatement: boolean
  ): { stmt?: Stmt; value?: TExpr } {
    if (asStatement) return { stmt: this.statementExpression(expression, expression) };
    return { value: this.compile(expression, resultType) };
  }

  // code-gauge-allow functionParameterCount 7 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  // code-gauge-allow functionCognitiveComplexity 18 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  private combineBranches(
    span: Span,
    then: { stmt?: Stmt; value?: TExpr },
    otherwise: { stmt?: Stmt; value?: TExpr } | undefined,
    resultType: Type | undefined,
    asStatement: boolean,
    select: (frame: Frame) => number,
    captures: readonly (LocalBinding | undefined)[] = []
  ): { stmt: Stmt; value: TExpr } {
    const slots = captures.flatMap((binding) => (binding ? [binding.slot] : []));
    const clear = (frame: Frame): void => {
      for (const slot of slots) frame.slots[slot] = UNASSIGNED;
    };
    if (asStatement) {
      const thenExec = (then.stmt as Stmt).exec;
      const otherwiseExec = otherwise?.stmt?.exec;
      const branch = (frame: Frame): Jump | undefined =>
        select(frame) === 0 ? thenExec(frame) : otherwiseExec?.(frame);
      const stmt: Stmt = {
        exec:
          slots.length === 0
            ? branch
            : (frame) => {
                try {
                  return branch(frame);
                } finally {
                  clear(frame);
                }
              },
        noreturn: Boolean((then.stmt as Stmt).noreturn && otherwise?.stmt?.noreturn),
      };
      return { stmt, value: known(VOID, undefined, span) };
    }
    const thenValue = then.value as TExpr;
    const otherwiseValue = otherwise?.value ?? known(VOID, undefined, span);
    const type =
      resultType && !isComptimeOnly(resultType) ? resultType : this.peerType([thenValue, otherwiseValue], span);
    this.rejectRuntimeComptime(type, span);
    const a = this.coerce(thenValue, type, thenValue.span);
    const b = this.coerce(otherwiseValue, type, otherwiseValue.span);
    const evaluateA = a.eval;
    const evaluateB = b.eval;
    const noreturn = thenValue.type.kind === 'noreturn' && otherwiseValue.type.kind === 'noreturn';
    const choose = (frame: Frame): Value => (select(frame) === 0 ? evaluateA(frame) : evaluateB(frame));
    const value = runtime(
      noreturn ? NORETURN : type,
      slots.length === 0
        ? choose
        : (frame) => {
            try {
              return choose(frame);
            } finally {
              clear(frame);
            }
          },
      span
    );
    return {
      stmt: { exec: (frame) => void value.eval(frame), noreturn },
      value,
    };
  }

  /** A local for a capture such as `|v|` or `|*p|`, with the code that binds it. */
  private captureBinding(
    capture: Capture | undefined,
    type: Type,
    operand: TExpr | undefined
  ):
    | {
        binding: LocalBinding;
        locate?: (frame: Frame) => Pointer;
        bind: (frame: Frame, value: Value, pointer?: Pointer) => void;
      }
    | undefined {
    if (!capture || isDiscardName(capture)) return undefined;
    if (capture.byPointer) {
      const place = operand?.place;
      if (!place) return this.error(capture, '|*x| で受け取るには、変数などの場所が要ります。');
      const pointerType = pointerTo(type, place.isConst);
      const binding = this.newLocal(capture.name, pointerType, true);
      const locate = place.locate;
      return {
        binding,
        locate,
        bind: (frame, _value, pointer) => {
          const target = pointer as Pointer;
          frame.slots[binding.slot] = operand?.type.kind === 'optional' ? this.optionalPayloadPointer(target) : target;
        },
      };
    }
    const binding = this.newLocal(capture.name, type, true);
    return {
      binding,
      bind: (frame, value) => {
        frame.slots[binding.slot] = copyForFrame(frame, value, binding.type);
      },
    };
  }

  private newLocal(name: string, type: Type, isConst: boolean): LocalBinding {
    const fn = this.currentFn({ row: 0, col: 0, endRow: 0 });
    const slot = this.localSlot();
    const binding: LocalBinding = { kind: 'local', name, slot, type, isConst, known: false };
    fn.instance.locals.push({ name, slot, type, isReceiver: false });
    return binding;
  }

  private withCapture<T>(capture: { binding: LocalBinding } | undefined, run: () => T): T {
    if (!capture) return run();
    const locals = new Map([[capture.binding.name, capture.binding]]);
    const slot = capture.binding.slot;
    const result = this.withScope({ locals, parent: this.scope }, run);
    void slot;
    return result;
  }

  // While -------------------------------------------------------------------------------------------------------------

  private whileLoop(
    expression: ExpressionOf<'while'>,
    resultType: Type | undefined,
    asStatement: boolean
  ): { stmt: Stmt; value: TExpr } {
    const fn = this.currentFn(expression);
    if (expression.isInline) this.error(expression, 'inline while は、この採点環境では使えません。');
    const target: JumpTarget = {
      id: {},
      label: expression.label?.name,
      kind: 'loop',
      resultType: asStatement ? undefined : resultType,
      breaks: [],
      broken: false,
    };
    const condition = this.compile(expression.condition);
    const kind = conditionKind(condition.type, expression.capture !== undefined);
    const row = this.stepRow(expression);
    let binding: ReturnType<StatementCompiler['captureBinding']>;
    let errorBinding: ReturnType<StatementCompiler['captureBinding']>;
    let test: (frame: Frame) => boolean;
    let failure: ((frame: Frame) => void) | undefined;
    let infinite = false;
    if (kind === 'bool') {
      const bool = this.coerce(condition, BOOL, expression.condition);
      if (expression.capture) this.error(expression.capture, 'bool の条件からは値を受け取れません。');
      infinite = bool.known && bool.value === true;
      const evaluate = bool.eval;
      test = (frame) => evaluate(frame) as boolean;
    } else if (kind === 'optional' && condition.type.kind === 'optional') {
      binding = this.captureBinding(expression.capture, condition.type.child, condition);
      const evaluate = condition.eval;
      const bind = binding?.bind;
      test = (frame) => {
        const pointer = binding?.locate?.(frame);
        const value = pointer ? pointer.load() : evaluate(frame);
        if (value === NULL) return false;
        bind?.(frame, value instanceof Some ? value.value : value, pointer);
        return true;
      };
    } else if (condition.type.kind === 'error_union') {
      const union = condition.type;
      binding = this.captureBinding(expression.capture, union.payload, condition);
      errorBinding = this.captureBinding(expression.elseCapture, union.errorSet, undefined);
      const evaluate = condition.eval;
      const bind = binding?.bind;
      const bindError = errorBinding?.bind;
      let lastError: Value;
      test = (frame) => {
        const pointer = binding?.locate?.(frame);
        const value = pointer ? pointer.load() : evaluate(frame);
        if (value instanceof ErrorValue) {
          lastError = value;
          return false;
        }
        bind?.(frame, value, pointer);
        return true;
      };
      failure = (frame) => bindError?.(frame, lastError);
    } else {
      return this.error(
        expression.condition,
        `while の条件には bool・optional・エラー共用体を書いてください（${typeName(condition.type)} 型です）。`
      );
    }
    fn.targets.push(target);
    let body: Stmt;
    let continueExec: Exec | undefined;
    try {
      ({ body, continueExec } = this.withCapture(binding, () => {
        const continuation = expression.continueExpression
          ? this.withoutSteps(() => this.statementExpression(expression.continueExpression as Expression, expression))
              .exec
          : undefined;
        // Zig does not analyze the body of a loop whose condition is known to be false.
        const neverRuns = kind === 'bool' && condition.known && condition.value === false;
        const body: Stmt = neverRuns ? { exec: () => {}, noreturn: false } : this.loopBody(expression.body);
        return { body, continueExec: continuation };
      }));
    } finally {
      fn.targets.pop();
    }
    const otherwise = expression.otherwise
      ? this.withCapture(errorBinding, () =>
          this.branch(expression.otherwise as Expression, undefined, target.resultType, asStatement)
        )
      : undefined;
    const storesAnswer = binding ? storesAnswerValue(binding.binding.type) : false;
    const { id } = target;
    const bodyExec = body.exec;
    const otherwiseExec = otherwise?.stmt?.exec;
    const valueType = asStatement ? VOID : this.loopType(target, otherwise?.value, infinite, expression);
    const otherwiseValue = otherwise?.value ? this.coerce(otherwise.value, valueType, expression).eval : undefined;
    const hasBinding = binding !== undefined;
    const captureSlots = [binding?.binding.slot, errorBinding?.binding.slot].filter((slot) => slot !== undefined);
    const loop = clearingLocals(captureSlots, (frame: Frame): Jump | { value: Value } | undefined => {
      for (;;) {
        if (binding) frame.slots[binding.binding.slot] = UNASSIGNED;
        frame.runtime.spend();
        if (!test(frame)) break;
        if (hasBinding) frame.runtime.steps.stepBinding(row, storesAnswer);
        const completion = loopExit(runBody(bodyExec, frame, id), id);
        if (completion) return completion;
        if (continueExec) {
          const completion = loopExit(runBody(continueExec, frame, id), id);
          if (completion) return completion;
          frame.runtime.steps.step(row);
        }
      }
      failure?.(frame);
      if (binding) frame.slots[binding.binding.slot] = UNASSIGNED;
      if (otherwiseExec) {
        const completion = otherwiseExec(frame);
        if (completion) return completion;
      }
      if (otherwiseValue) return { value: otherwiseValue(frame) };
      return undefined;
    });
    const stmt: Stmt = {
      exec: (frame) => {
        const result = loop(frame);
        return result instanceof Jump ? result : undefined;
      },
      noreturn: infinite && !target.broken,
    };
    return {
      stmt,
      value: runtime(
        stmt.noreturn ? NORETURN : valueType,
        (frame) => {
          const result = loop(frame);
          if (result instanceof Jump) throw result;
          return result?.value;
        },
        expression
      ),
    };
  }

  private loopType(target: JumpTarget, otherwise: TExpr | undefined, infinite: boolean, span: Span): Type {
    const values = target.breaks.map((site) => site.value);
    if (otherwise) values.push(otherwise);
    else if (!infinite) values.push(known(VOID, undefined, span));
    if (target.resultType) {
      for (const site of target.breaks) site.final = this.coerce(site.value, target.resultType, site.value.span);
      return target.resultType;
    }
    if (values.length === 0) return NORETURN;
    const type = this.peerType(values, span);
    for (const site of target.breaks) site.final = this.coerce(site.value, type, site.value.span);
    return type;
  }

  private loopBody(body: Expression): Stmt {
    return this.statementExpression(body, body);
  }

  private withoutSteps<T>(run: () => T): T {
    const fn = this.fn;
    if (!fn) return run();
    const records = fn.recordsSteps;
    fn.recordsSteps = false;
    try {
      return run();
    } finally {
      fn.recordsSteps = records;
    }
  }

  // For ---------------------------------------------------------------------------------------------------------------

  private forLoop(
    expression: ExpressionOf<'for'>,
    resultType: Type | undefined,
    asStatement: boolean
  ): { stmt: Stmt; value: TExpr } {
    const fn = this.currentFn(expression);
    if (expression.isInline) return this.inlineFor(expression, asStatement);
    const target: JumpTarget = {
      id: {},
      label: expression.label?.name,
      kind: 'loop',
      resultType: asStatement ? undefined : resultType,
      breaks: [],
      broken: false,
    };
    interface Operand {
      lengthOf?: (frame: Frame, value: Value) => number;
      element: (value: Value, index: number, frame: Frame) => Value;
      evaluate: (frame: Frame) => Value;
      type: Type;
      staticLength?: number;
    }
    const operands: Operand[] = expression.operands.map((operand, index) => {
      const capture = expression.captures[index];
      if (operand.isRange) {
        const start = this.coerce(this.compile(operand.value, USIZE), USIZE, operand.value);
        const end = operand.rangeEnd
          ? this.coerce(this.compile(operand.rangeEnd, USIZE), USIZE, operand.rangeEnd)
          : undefined;
        const evaluateStart = start.eval;
        const evaluateEnd = end?.eval;
        return {
          type: USIZE,
          evaluate: (frame) => [evaluateStart(frame), evaluateEnd?.(frame)] as unknown as Value,
          lengthOf: evaluateEnd
            ? (_frame, value) => {
                const [from, to] = value as unknown as [bigint, bigint];
                // Zig computes the length as `end - start` in usize.
                if (to < from) panic(PANIC.overflow);
                return Number(to - from);
              }
            : undefined,
          element: (value, position) => (value as unknown as [bigint, bigint])[0] + BigInt(position),
          staticLength: start.known && end?.known ? Number((end.value as bigint) - (start.value as bigint)) : undefined,
        };
      }
      const compiled = this.compile(operand.value);
      return this.forOperand(compiled, capture?.byPointer ?? false, operand.value);
    });
    const lengths = operands.flatMap((operand) => (operand.staticLength === undefined ? [] : [operand.staticLength]));
    if (lengths.some((length) => length !== lengths[0])) this.error(expression, 'for の対象の長さが違います。');
    const locals = new Map<string, LocalBinding>();
    const bindings = expression.captures.map((capture, index) => {
      if (isDiscardName(capture)) return;
      const operand = operands[index];
      const type = capture.byPointer ? operand.type : operand.type;
      const binding = this.newLocal(capture.name, type, true);
      locals.set(capture.name, binding);
      return binding;
    });
    fn.targets.push(target);
    let body: Stmt;
    try {
      body = this.withScope({ locals, parent: this.scope }, () => this.loopBody(expression.body));
    } finally {
      fn.targets.pop();
    }
    const otherwise = expression.otherwise
      ? this.branch(expression.otherwise, undefined, target.resultType, asStatement)
      : undefined;
    const row = this.stepRow(expression);
    const storesAnswer = bindings.every((binding) => !binding || storesAnswerValue(binding.type));
    const { id } = target;
    const bodyExec = body.exec;
    const otherwiseExec = otherwise?.stmt?.exec;
    const valueType = asStatement ? VOID : this.loopType(target, otherwise?.value, false, expression);
    const otherwiseValue = otherwise?.value ? this.coerce(otherwise.value, valueType, expression).eval : undefined;
    const slots = bindings.map((binding) => binding?.slot);
    const loop = (frame: Frame): Jump | { value: Value } | undefined => {
      const values = evaluateHeld(
        frame,
        operands.map((operand) => operand.evaluate)
      );
      for (const value of values) frame.temporaries.push(value);
      try {
        let count: number | undefined;
        for (const [index, operand] of operands.entries()) {
          if (!operand.lengthOf) continue;
          const length = operand.lengthOf(frame, values[index]);
          if (count !== undefined && length !== count) panic(PANIC.forLengths);
          count = length;
        }
        for (let position = 0; position < (count as number); position++) {
          frame.runtime.spend();
          for (const [index, slot] of slots.entries()) {
            if (slot !== undefined) frame.slots[slot] = operands[index].element(values[index], position, frame);
          }
          frame.runtime.steps.stepBinding(row, storesAnswer);
          const completion = runBody(bodyExec, frame, id);
          if (completion) {
            if (completion.target !== id) return completion;
            if (completion.kind === 'break') return { value: completion.value };
          }
        }
      } finally {
        frame.temporaries.splice(frame.temporaries.length - values.length, values.length);
        // The captures go out of scope, so that what they held no longer keeps turtles alive.
        for (const slot of slots) if (slot !== undefined) frame.slots[slot] = UNASSIGNED;
      }
      if (otherwiseExec) {
        const completion = otherwiseExec(frame);
        if (completion) return completion;
      }
      if (otherwiseValue) return { value: otherwiseValue(frame) };
      return undefined;
    };
    const stmt: Stmt = {
      exec: (frame) => {
        const result = loop(frame);
        return result instanceof Jump ? result : undefined;
      },
      noreturn: false,
    };
    return {
      stmt,
      value: runtime(
        valueType,
        (frame) => {
          const result = loop(frame);
          if (result instanceof Jump) throw result;
          return result?.value;
        },
        expression
      ),
    };
  }

  /** How a `for` reads an array, a pointer to one, or a slice, by value or by pointer. */
  // code-gauge-allow functionNcss 51 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  private forOperand(
    compiled: TExpr,
    byPointer: boolean,
    span: Span
  ): {
    lengthOf?: (frame: Frame, value: Value) => number;
    element: (value: Value, index: number, frame: Frame) => Value;
    evaluate: (frame: Frame) => Value;
    type: Type;
    staticLength?: number;
  } {
    const type = compiled.type;
    let child: Type;
    let isConst: boolean;
    let viewOf: (value: Value) => { slots: { slots: Value[] }; start: number; length: number };
    let evaluate = compiled.eval;
    let staticLength: number | undefined;
    if (type.kind === 'array') {
      child = type.child;
      staticLength = type.length;
      if (byPointer) this.error(span, '配列を |*x| で受け取るには、for (&arr) |*x| と書いてください。');
      isConst = true;
      viewOf = (value) => {
        const array = value as ZArray;
        return { slots: array, start: array.offset, length: array.length };
      };
    } else if (type.kind === 'pointer' && type.size === 'one' && type.child.kind === 'array') {
      child = type.child.child;
      isConst = type.isConst;
      staticLength = type.child.length;
      viewOf = (value) => {
        const array = (value as Pointer).load() as ZArray;
        return { slots: array, start: array.offset, length: array.length };
      };
    } else if (type.kind === 'pointer' && type.size === 'slice') {
      child = type.child;
      isConst = type.isConst;
      staticLength = knownLengthOf(compiled);
      viewOf = (value) => {
        const slice = value as Slice;
        return { slots: slice.target, start: slice.start, length: slice.length };
      };
    } else if (type.kind === 'struct' && type.isTuple) {
      return this.error(span, 'タプルは inline for で回してください。');
    } else {
      return this.error(span, `${typeName(type)} 型は、for で回せません。`);
    }
    if (compiled.known && type.kind === 'array') {
      const value = compiled.value;
      evaluate = () => value;
    } else if (type.kind === 'array') {
      const read = evaluate;
      evaluate = (frame) => copyForFrame(frame, read(frame), type);
    }
    return {
      type: byPointer ? pointerTo(child, isConst) : child,
      evaluate,
      staticLength,
      lengthOf: (_frame, value) => viewOf(value).length,
      element: byPointer
        ? (value, index) => {
            const view = viewOf(value);
            return new Pointer(view.slots, view.start + index);
          }
        : (value, index, frame) => {
            const view = viewOf(value);
            return copyForFrame(frame, view.slots.slots[view.start + index], child);
          },
    };
  }

  /** `inline for`, which the compiler unrolls, binding each capture to a value it may know. */
  private inlineFor(expression: ExpressionOf<'for'>, asStatement: boolean): { stmt: Stmt; value: TExpr } {
    if (!asStatement) this.error(expression, 'inline for の値は、この採点環境では使えません。');
    if (expression.operands.length !== 1 || expression.otherwise) {
      this.error(expression, 'inline for は、対象1つで else のない形だけが、この採点環境で使えます。');
    }
    const [operand] = expression.operands;
    const [capture] = expression.captures;
    const fn = this.currentFn(expression);
    const elements: TExpr[] = [];
    const operandSlot = this.localSlot();
    let evaluateOperand: TExpr['eval'] | undefined;
    if (operand.isRange) {
      const start = this.knownValue(
        this.coerce(this.compile(operand.value, USIZE), USIZE, operand.value),
        '範囲'
      ) as bigint;
      if (!operand.rangeEnd) return this.error(expression, '終わりのない範囲は、inline for では回せません。');
      const end = this.knownValue(
        this.coerce(this.compile(operand.rangeEnd, USIZE), USIZE, operand.rangeEnd),
        '範囲'
      ) as bigint;
      this.compilationBudget.spend(Number(end - start));
      for (let value = start; value < end; value++) elements.push(known(USIZE, value, operand));
    } else {
      const source = this.compile(operand.value);
      const type = source.type;
      if (!source.known) evaluateOperand = (frame) => copyForFrame(frame, source.eval(frame), type);
      const compiled = source.known ? source : runtime(type, (frame) => frame.slots[operandSlot], operand);
      this.compilationBudget.spend(
        type.kind === 'array' ? type.length : type.kind === 'struct' ? (type.fields?.length ?? 0) : 0
      );
      if (type.kind === 'struct' && type.isTuple) {
        for (const [index, field] of (type.fields ?? []).entries())
          elements.push(this.tupleElement(compiled, index, field, operand));
      } else if (type.kind === 'array') {
        for (let index = 0; index < type.length; index++) {
          const position = index;
          const evaluate = compiled.eval;
          elements.push(
            compiled.known
              ? known(type.child, (compiled.value as ZArray).get(index), operand)
              : runtime(type.child, (frame) => (evaluate(frame) as ZArray).get(position), operand)
          );
        }
      } else {
        return this.error(operand, 'inline for は、配列・タプル・範囲にだけ使えます。');
      }
    }
    const target: JumpTarget = {
      id: {},
      label: expression.label?.name,
      kind: 'loop',
      breaks: [],
      broken: false,
    };
    const row = this.stepRow(expression);
    const iterations = elements.map((element) => {
      this.compilationBudget.spend();
      const locals = new Map<string, LocalBinding>();
      let binding: LocalBinding | undefined;
      if (capture && !isDiscardName(capture)) {
        binding = this.newLocal(capture.name, element.type, true);
        binding = { ...binding, known: element.known, value: element.value };
        locals.set(capture.name, binding);
      }
      fn.targets.push(target);
      try {
        const body = this.withScope({ locals, parent: this.scope }, () => this.loopBody(expression.body));
        return {
          body: clearingLocals(binding ? [binding.slot] : [], body.exec),
          slot: binding?.slot,
          evaluate: element.eval,
          storesAnswer: storesAnswerValue(element.type),
        };
      } finally {
        fn.targets.pop();
      }
    });
    const { id } = target;
    return {
      stmt: {
        exec: clearingLocals([operandSlot], (frame) => {
          if (evaluateOperand) frame.slots[operandSlot] = evaluateOperand(frame);
          for (const iteration of iterations) {
            frame.runtime.spend();
            if (iteration.slot !== undefined) frame.slots[iteration.slot] = iteration.evaluate(frame);
            frame.runtime.steps.stepBinding(row, iteration.storesAnswer);
            const completion = runBody(iteration.body, frame, id);
            if (completion) {
              if (completion.target !== id) return completion;
              if (completion.kind === 'break') return;
            }
          }
          return;
        }),
        noreturn: false,
      },
      value: known(VOID, undefined, expression),
    };
  }

  // Switch ------------------------------------------------------------------------------------------------------------

  private switchStatement(
    expression: ExpressionOf<'switch'>,
    resultType: Type | undefined,
    asStatement: boolean
  ): { stmt: Stmt; value: TExpr } {
    const fn = this.currentFn(expression);
    const operand = this.compile(expression.operand);
    let operandType = operand.type;
    if (operandType.kind === 'comptime_int' && !operand.known)
      this.error(expression.operand, 'switch の値が決まりません。');
    const union = operandType.kind === 'union' ? operandType : undefined;
    const unionFields = union ? this.unionFields(union) : undefined;
    if (union && !union.tagType) this.error(expression.operand, 'タグのない union は、switch で分けられません。');
    const tagType: Type = union ? (union.tagType as EnumType) : operandType;
    if (
      operandType.kind === 'pointer' ||
      operandType.kind === 'optional' ||
      operandType.kind === 'struct' ||
      operandType.kind === 'float'
    ) {
      // Zig points at the first string a prong lists.
      const text = expression.cases.flatMap((each) => each.items).find((item) => item.value.kind === 'string');
      if (text) this.error(text, '文字列では switch できません（std.mem.eql で比べてください）。');
      this.error(expression.operand, `${typeName(operandType)} 型の値は、switch で分けられません。`);
    }
    const target: JumpTarget = {
      id: {},
      label: expression.label?.name,
      kind: 'switch',
      resultType: asStatement ? undefined : resultType,
      breaks: [],
      broken: false,
      operandType,
    };
    // The values each prong matches, as keys: bigints for integers and enums, names for errors, and booleans.
    const keyOf = (value: Value): unknown => {
      if (union) {
        const field = unionFields?.[(value as ZUnion).tag];
        return (tagType as EnumType).fields?.find((tag) => tag.name === field?.name)?.value;
      }
      if (value instanceof ErrorValue) return value.name;
      return value;
    };
    interface Prong {
      values: unknown[];
      ranges: [bigint, bigint][];
      body: Stmt | undefined;
      value: TExpr | undefined;
      bind?: (frame: Frame, operand: Value, pointer: Pointer | undefined) => void;
      isElse: boolean;
      /** Whether the prong is `_ =>`, which a non-exhaustive enum's unnamed values take. */
      isUnnamed?: boolean;
      inline?: Map<unknown, { body: Stmt | undefined; value: TExpr | undefined; bind?: Prong['bind'] }>;
    }
    const seen = new Map<unknown, Span>();
    const prongs: Prong[] = [];
    let elseProng: Prong | undefined;
    // A labeled switch may `continue` into any prong, so only an unlabeled one skips the prongs it never reaches.
    const reached =
      operand.known && !union && !expression.label
        ? this.reachedCase(expression, keyOf(operand.value), tagType)
        : undefined;
    fn.targets.push(target);
    try {
      for (const each of expression.cases) {
        const prong = this.switchProng(each, {
          skipped: reached !== undefined && each !== reached,
          operand,
          operandType,
          tagType,
          union,
          unionFields,
          resultType: target.resultType,
          asStatement,
          keyOf,
          seen,
        });
        if (each.isElse) {
          if (elseProng) this.error(each, 'else の枝が2つあります。');
          elseProng = prong as Prong;
        } else {
          prongs.push(prong as Prong);
        }
      }
    } finally {
      fn.targets.pop();
    }
    const unnamedProng = prongs.find((prong) => prong.isUnnamed);
    if (unnamedProng && (tagType.kind !== 'enum' || tagType.exhaustive)) {
      this.error(expression, '「_」の枝は、「_」で終わる enum の switch にだけ書けます。');
    }
    const namedValues = new Set(tagType.kind === 'enum' ? this.enumFields(tagType).map((field) => field.value) : []);
    this.checkExhaustive(expression, tagType, seen, elseProng !== undefined || unnamedProng !== undefined, union);
    // Dispatch: a map from keys to prongs, then the ranges, then else.
    const table = new Map<unknown, Prong>();
    for (const prong of prongs) for (const value of prong.values) table.set(value, prong);
    const ranged = prongs.filter((prong) => prong.ranges.length > 0);
    const find = (key: unknown): Prong | undefined => {
      const direct = table.get(key);
      if (direct) return direct;
      if (typeof key === 'bigint') {
        for (const prong of ranged) {
          if (prong.ranges.some(([low, high]) => key >= low && key <= high)) return prong;
        }
        if (unnamedProng && !namedValues.has(key)) return unnamedProng;
      }
      return elseProng;
    };
    const values = [...prongs, ...(elseProng ? [elseProng] : [])]
      .map((prong) => prong.value)
      .filter((value): value is TExpr => value !== undefined);
    let type: Type = VOID;
    if (!asStatement) {
      const all = [...values, ...target.breaks.map((site) => site.value)];
      for (const prong of [...prongs, ...(elseProng ? [elseProng] : [])]) {
        for (const each of prong.inline?.values() ?? []) if (each.value) all.push(each.value);
      }
      type =
        target.resultType && !isComptimeOnly(target.resultType)
          ? target.resultType
          : all.length > 0
            ? this.peerType(all, expression)
            : VOID;
      if (!operand.known) this.rejectRuntimeComptime(type, expression);
      for (const site of target.breaks) site.final = this.coerce(site.value, type, site.value.span);
    }
    const coerced = new Map<TExpr, TExpr>();
    const valueOf = (value: TExpr | undefined): TExpr | undefined => {
      if (!value || asStatement) return value;
      let result = coerced.get(value);
      if (!result) {
        result = this.coerce(value, type, value.span);
        coerced.set(value, result);
      }
      return result;
    };
    const evaluators = new Map<object, ((frame: Frame) => Value) | undefined>();
    for (const prong of [...prongs, ...(elseProng ? [elseProng] : [])]) {
      evaluators.set(prong, valueOf(prong.value)?.eval);
      for (const each of prong.inline?.values() ?? []) evaluators.set(each, valueOf(each.value)?.eval);
    }
    const evaluateOperand = operand.eval;
    const place = operand.place;
    const needsPointer = expression.cases.some((each) => each.capture?.byPointer);
    const { id } = target;
    const run = (frame: Frame): Jump | { value: Value } | undefined => {
      let pointer = needsPointer && place ? place.locate(frame) : undefined;
      let value = pointer ? pointer.load() : evaluateOperand(frame);
      for (;;) {
        frame.runtime.spend();
        const key = keyOf(value);
        const prong = find(key);
        if (!prong) return panic(PANIC.unreachable);
        const chosen = prong.inline?.get(key) ?? prong;
        chosen.bind?.(frame, value, pointer);
        let completion: Jump | undefined;
        let result: Value;
        try {
          if (chosen.body) {
            completion = chosen.body.exec(frame);
          } else {
            const evaluate = evaluators.get(chosen);
            result = evaluate?.(frame);
          }
        } catch (error) {
          if (error instanceof Jump && error.target === id) completion = error;
          else throw error;
        }
        if (!completion) return { value: result };
        if (completion.target !== id) return completion;
        if (completion.kind === 'break') return { value: completion.value };
        value = completion.value;
        pointer = undefined;
      }
    };
    const allNoreturn =
      [...prongs, ...(elseProng ? [elseProng] : [])].every((prong) =>
        prong.body ? prong.body.noreturn : prong.value?.type.kind === 'noreturn'
      ) && !target.broken;
    return {
      stmt: {
        exec: (frame) => {
          const result = run(frame);
          return result instanceof Jump ? result : undefined;
        },
        noreturn: allNoreturn,
      },
      value: runtime(
        allNoreturn ? NORETURN : type,
        (frame) => {
          const result = run(frame);
          if (result instanceof Jump) throw result;
          return result?.value;
        },
        expression
      ),
    };
  }

  private switchProng(
    each: SwitchCase,
    context: {
      operand: TExpr;
      operandType: Type;
      tagType: Type;
      union: Extract<Type, { kind: 'union' }> | undefined;
      unionFields: { name: string; type: Type }[] | undefined;
      resultType: Type | undefined;
      asStatement: boolean;
      keyOf: (value: Value) => unknown;
      seen: Map<unknown, Span>;
      skipped: boolean;
    }
  ): unknown {
    const { operand, operandType, tagType, union, unionFields, resultType, asStatement, keyOf, seen } = context;
    const fieldForTag = (key: unknown): { name: string; type: Type } | undefined =>
      unionFields?.find((field) =>
        (tagType as EnumType).fields?.some((tag) => tag.value === key && tag.name === field.name)
      );
    const values: unknown[] = [];
    const ranges: [bigint, bigint][] = [];
    const isUnnamed = each.items.some((item) => item.value.kind === 'identifier' && isDiscardName(item.value));
    if (isUnnamed && each.items.length > 1) this.error(each, '「_」の枝には、ほかの値を書けません。');
    for (const item of isUnnamed ? [] : each.items) {
      const first = this.knownValue(
        this.coerce(this.compile(item.value, tagType), tagType, item.value),
        'switch の枝の値'
      );
      if (item.last) {
        if (tagType.kind !== 'int' && tagType.kind !== 'comptime_int')
          this.error(item, '範囲（...）は、整数の switch にだけ書けます。');
        const last = this.knownValue(
          this.coerce(this.compile(item.last, tagType), tagType, item.last),
          'switch の枝の値'
        ) as bigint;
        if (last < (first as bigint)) this.error(item, '範囲の始まりが終わりより大きくなっています。');
        // Ranges are kept in `seen` under a key of their own, with their bounds, to compare with later items.
        for (const [key] of seen) {
          const overlaps = Array.isArray(key)
            ? !(last < (key[0] as bigint) || (first as bigint) > (key[1] as bigint))
            : typeof key === 'bigint' && key >= (first as bigint) && key <= last;
          if (overlaps) this.error(item, '同じ値の枝が2つあります。');
        }
        ranges.push([first as bigint, last]);
        seen.set([first as bigint, last], item);
        continue;
      }
      const key = union ? (first as bigint) : keyOf(first);
      // Zig checks single values before ranges, so it reports a value inside an earlier range at the range.
      const range = [...seen.entries()].find(
        ([seenKey]) =>
          typeof key === 'bigint' &&
          Array.isArray(seenKey) &&
          key >= (seenKey[0] as bigint) &&
          key <= (seenKey[1] as bigint)
      );
      if (range) this.error(range[1], '同じ値の枝が2つあります。');
      if (seen.has(key)) this.error(item, '同じ値の枝が2つあります。');
      seen.set(key, item);
      values.push(key);
    }
    // The capture's type: a union's payload, or the operand's value.
    const captureFor = (keys: unknown[]): Type => {
      if (!union || !unionFields) return operandType;
      const types = keys.map((key) => fieldForTag(key)?.type ?? VOID);
      if (types.some((type) => type !== types[0])) {
        this.error(each, 'この枝の値の型がそろわないので受け取れません（inline else を使ってください）。');
      }
      return types[0] ?? VOID;
    };
    const compileBody = (
      captureType: Type,
      tagValue: TExpr | undefined
    ): {
      body: Stmt | undefined;
      value: TExpr | undefined;
      bind?: (frame: Frame, operand: Value, pointer: Pointer | undefined) => void;
    } => {
      const locals = new Map<string, LocalBinding>();
      let bind: ((frame: Frame, value: Value, pointer: Pointer | undefined) => void) | undefined;
      const capture = each.capture;
      if (capture && !isDiscardName(capture)) {
        if (capture.byPointer) {
          if (!union && !operand.place) this.error(capture, '|*x| で受け取るには、値の場所が要ります。');
          const binding = this.newLocal(capture.name, pointerTo(captureType, operand.place?.isConst ?? true), true);
          locals.set(capture.name, binding);
          bind = (frame, value, pointer) => {
            frame.slots[binding.slot] = union ? new Pointer(value as ZUnion, 0) : pointer;
          };
        } else {
          const binding = this.newLocal(capture.name, captureType, true);
          locals.set(capture.name, binding);
          bind = (frame, value) => {
            frame.slots[binding.slot] = copyForFrame(frame, union ? (value as ZUnion).slots[0] : value, binding.type);
          };
        }
      }
      if (each.tagCapture && !isDiscardName(each.tagCapture)) {
        if (!each.isInline) this.error(each.tagCapture, 'タグを受け取れるのは inline の枝だけです。');
        const binding = {
          ...this.newLocal(each.tagCapture.name, tagType, true),
          known: Boolean(tagValue?.known),
          value: tagValue?.value,
        };
        locals.set(each.tagCapture.name, binding);
        const bindPayload = bind;
        bind = (frame, value, pointer) => {
          bindPayload?.(frame, value, pointer);
          frame.slots[binding.slot] = tagValue?.value;
        };
      }
      // Zig does not analyze a prong that a known operand never reaches.
      if (context.skipped) {
        const never: Stmt = { exec: () => panic(PANIC.unreachable), noreturn: true };
        return asStatement
          ? { body: never, value: undefined, bind }
          : { body: undefined, value: known(NORETURN, undefined, each.body), bind };
      }
      return this.withScope({ locals, parent: this.scope }, () => {
        const slots = [...locals.values()].map((binding) => binding.slot);
        if (asStatement) {
          const body = this.statementExpression(each.body, each.body);
          return { body: { ...body, exec: clearingLocals(slots, body.exec) }, value: undefined, bind };
        }
        const value = this.compile(each.body, resultType);
        return { body: undefined, value: { ...value, eval: clearingLocals(slots, value.eval) }, bind };
      });
    };
    if (each.isInline) {
      // One copy of the body per value the prong matches, each knowing the value.
      const keys = each.isElse ? this.remainingKeys(tagType, seen, each) : [...values];
      if (!each.isElse)
        for (const [first, last] of ranges) {
          this.compilationBudget.spend(Number(last - first + 1n));
          for (let key = first; key <= last; key++) keys.push(key);
        }
      const inline = new Map<
        unknown,
        {
          body: Stmt | undefined;
          value: TExpr | undefined;
          bind?: (frame: Frame, operand: Value, pointer: Pointer | undefined) => void;
        }
      >();
      for (const key of keys) {
        const tagValue = known(tagType, key as Value, each);
        inline.set(key, compileBody(captureFor([key]), tagValue));
      }
      const first = inline.values().next().value;
      return {
        values,
        ranges,
        body: first?.body,
        value: first?.value,
        bind: first?.bind,
        isElse: each.isElse,
        inline,
      };
    }
    const keys = each.isElse ? this.remainingKeys(tagType, seen, each, true) : values;
    if (each.isElse && union && each.capture) {
      const types = keys.map((key) => fieldForTag(key)?.type ?? VOID);
      if (types.some((type) => type !== types[0]))
        this.error(each, 'else の枝の値の型がそろわないので受け取れません（inline else を使ってください）。');
    }
    // Only a prong that captures needs its values' payloads to share a type.
    const captureType =
      !each.capture || (each.isElse && !union) ? operandType : captureFor(keys.length > 0 ? keys : values);
    const compiled = compileBody(captureType, undefined);
    return { values, ranges, ...compiled, isElse: each.isElse, isUnnamed };
  }

  /** The prong a known operand takes: the one listing its value, else the `else` or `_` prong. */
  // code-gauge-allow functionCognitiveComplexity 19 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  private reachedCase(expression: ExpressionOf<'switch'>, key: unknown, tagType: Type): SwitchCase | undefined {
    const valueOf = (item: Expression): Value =>
      this.knownValue(this.coerce(this.compile(item, tagType), tagType, item), 'switch の枝の値');
    for (const each of expression.cases) {
      for (const item of each.items) {
        if (item.value.kind === 'identifier' && isDiscardName(item.value)) continue;
        const first = prongKey(valueOf(item.value));
        if (!item.last && first === key) return each;
        if (item.last && typeof key === 'bigint' && key >= (first as bigint) && key <= (valueOf(item.last) as bigint))
          return each;
      }
    }
    return expression.cases.find(
      (each) => each.isElse || each.items.some((item) => item.value.kind === 'identifier' && isDiscardName(item.value))
    );
  }

  /** The values of an enum, union, bool, or error set that no prong lists, which `else` matches. */
  private remainingKeys(tagType: Type, seen: Map<unknown, Span>, span: Span, lenient = false): unknown[] {
    let all: unknown[];
    if (tagType.kind === 'enum') all = this.enumFields(tagType).map((field) => field.value);
    else if (tagType.kind === 'bool') all = [true, false];
    else if (tagType.kind === 'error_set' && tagType.names) all = [...tagType.names];
    else if (lenient) return [];
    else return this.error(span, 'inline else は、enum・union・bool・エラー集合の switch にだけ書けます。');
    return all.filter((key) => !seen.has(key));
  }

  // code-gauge-allow functionNcss 36 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  // code-gauge-allow functionCognitiveComplexity 24 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  private checkExhaustive(
    expression: ExpressionOf<'switch'>,
    tagType: Type,
    seen: Map<unknown, Span>,
    hasElse: boolean,
    union: Extract<Type, { kind: 'union' }> | undefined
  ): void {
    let missing: string[] = [];
    let complete = false;
    if (tagType.kind === 'enum') {
      const fields = this.enumFields(tagType);
      missing = fields.filter((field) => !seen.has(field.value)).map((field) => field.name);
      complete = tagType.exhaustive;
    } else if (tagType.kind === 'bool') {
      missing = [true, false].filter((value) => !seen.has(value)).map(String);
      complete = true;
    } else if (tagType.kind === 'error_set' && tagType.names) {
      missing = [...tagType.names].filter((name) => !seen.has(name));
      complete = true;
    } else if (tagType.kind === 'int') {
      complete = coversRange(seen, tagType);
      if (!complete && !hasElse) this.error(expression, 'switch には、すべての値を扱うための else の枝が要ります。');
      if (complete && hasElse) this.unreachableElse(expression);
      return;
    } else if (!hasElse) {
      this.error(expression, 'switch には else の枝が要ります。');
      return;
    }
    if (!complete) {
      if (!hasElse) this.error(expression, 'switch には、すべての値を扱うための else の枝が要ります。');
      return;
    }
    if (missing.length > 0 && !hasElse) {
      const what = union ? 'union' : tagType.kind === 'enum' ? 'enum' : '値';
      this.error(expression, `switch で扱っていない${what}の値があります: ${missing.join(', ')}`);
    }
    if (missing.length === 0 && hasElse) this.unreachableElse(expression);
  }

  private unreachableElse(expression: ExpressionOf<'switch'>): never {
    const prong = expression.cases.find((each) => each.isElse) ?? expression;
    return this.error(prong, 'すべての値を扱っているので、else の枝には決して来ません。');
  }

  // Try and catch -----------------------------------------------------------------------------------------------------

  protected compileTry(expression: ExpressionOf<'try'>, resultType: Type | undefined): TExpr {
    const fn = this.currentFn(expression);
    const operand = this.compile(
      expression.operand,
      resultType ? errorUnionOf({ kind: 'error_set', names: undefined }, resultType) : undefined
    );
    const type = operand.type;
    if (type.kind !== 'error_union') {
      return this.error(expression, `try はエラー共用体の値にだけ使えます（${typeName(type)} 型です）。`);
    }
    const errorSet = type.kind === 'error_union' ? type.errorSet : type;
    const returnType = fn.returnType;
    // An error set known to be empty, such as a function's that never fails, gives `try` nothing to return.
    const neverFails = errorSet.names !== undefined && errorSet.names.size === 0;
    if (returnType.kind !== 'error_union' && !neverFails) {
      return this.error(expression, `エラーを返さない関数（${typeName(returnType)} 型）では、try は使えません。`);
    }
    this.recordErrors(type, undefined);
    if (
      returnType.kind === 'error_union' &&
      fn.inferredErrors !== returnType.errorSet &&
      !errorSetIncludes(returnType.errorSet, errorSet)
    ) {
      this.error(
        expression,
        `try で返すエラー ${typeName(errorSet)} は、戻り値の型 ${typeName(returnType)} に含まれません。`
      );
    }
    const payload = type.kind === 'error_union' ? type.payload : NORETURN;
    const { target } = fn;
    const evaluate = operand.eval;
    return runtime(
      payload,
      (frame) => {
        const value = evaluate(frame);
        if (value instanceof ErrorValue) throw new Jump('return', target, value);
        return value;
      },
      expression
    );
  }

  /** `x catch handler`; with `discarded`, as in `_ = x catch handler`, the payload and handler need no common type. */
  // code-gauge-allow functionNcss 53 -- Keeps the success and error result conversions together.
  protected compileCatch(expression: ExpressionOf<'catch'>, resultType: Type | undefined, discarded = false): TExpr {
    const operand = this.compile(expression.operand);
    const type = operand.type;
    if (type.kind === 'error_set' && !expression.capture) {
      const handler = this.compile(expression.handler, resultType);
      return handler.known
        ? this.fixedResult(operand, handler.type, handler.value, expression)
        : runtime(
            handler.type,
            (frame) => {
              operand.eval(frame);
              return handler.eval(frame);
            },
            expression
          );
    }
    if (type.kind !== 'error_union') {
      return this.error(expression, `catch はエラー共用体の値にだけ使えます（${typeName(type)} 型です）。`);
    }
    if (
      (operand.known && !(operand.value instanceof ErrorValue)) ||
      (type.errorSet.resolved !== false && type.errorSet.names?.size === 0)
    ) {
      if (discarded) this.rejectDiscardedError(type.payload, expression.operand);
      const payload = this.derived(operand, type.payload, (value) => value);
      return discarded
        ? this.derived(payload, VOID, () => {})
        : resultType
          ? this.coerce(payload, resultType, expression)
          : payload;
    }
    // `x catch unreachable` reports the error it did not expect.
    if (!expression.capture && unwrapParens(expression.handler).kind === 'unreachable') {
      // A library call the compiler folds still runs when the program does, as in Zig.
      const isCall = ['call', 'builtinCall'].includes(unwrapParens(expression.operand).kind);
      if (operand.known && operand.value instanceof ErrorValue && !isCall) {
        this.error(
          expression,
          `エラー error.${operand.value.name} が返っているので、catch unreachable にはできません。`
        );
      }
      const evaluateOperand = operand.eval;
      return runtime(
        type.payload,
        (frame) => {
          const value = evaluateOperand(frame);
          if (value instanceof ErrorValue) panic(`attempt to unwrap error: ${value.name}`);
          return value;
        },
        expression
      );
    }
    if (operand.known && operand.value instanceof ErrorValue) {
      const handler = this.selectedBranch(
        expression.handler,
        this.captureBinding(expression.capture, type.errorSet, undefined),
        operand,
        (value) => value,
        discarded ? undefined : resultType,
        false
      ).value;
      if (discarded) {
        this.rejectDiscardedError(handler.type, expression.handler);
        return this.derived(handler, VOID, () => {});
      }
      return handler;
    }
    const capture = this.captureBinding(expression.capture, type.errorSet, undefined);
    const handler = this.withCapture(capture, () =>
      this.compile(expression.handler, discarded ? undefined : (resultType ?? type.payload))
    );
    if (discarded) {
      this.rejectDiscardedError(type.payload, expression.operand);
      this.rejectDiscardedError(handler.type, expression.handler);
    }
    const payloadSlot = this.localSlot();
    const payloadValue = runtime(type.payload, (frame) => frame.slots[payloadSlot], expression);
    const resultTypeOf = discarded
      ? VOID
      : handler.type.kind === 'noreturn'
        ? type.payload
        : this.peerType([payloadValue, handler], expression);
    const otherwise = discarded ? handler : this.coerce(handler, resultTypeOf, expression.handler);
    const evaluate = operand.eval;
    const evaluateHandler = clearingLocals(capture ? [capture.binding.slot] : [], otherwise.eval);
    const success = discarded ? payloadValue : this.coerce(payloadValue, resultTypeOf, expression);
    const bind = capture?.bind;
    return runtime(
      resultTypeOf,
      (frame) => {
        const value = evaluate(frame);
        if (value instanceof ErrorValue) {
          bind?.(frame, value);
          return evaluateHandler(frame);
        }
        frame.slots[payloadSlot] = value;
        try {
          return success.eval(frame);
        } finally {
          frame.slots[payloadSlot] = UNASSIGNED;
        }
      },
      expression
    );
  }

  protected mergedErrors(a: ErrorSetType, b: ErrorSetType): ErrorSetType {
    return mergeErrorSets(a, b);
  }

  protected intRange(type: IntType): [bigint, bigint] {
    return [minInt(type), maxInt(type)];
  }

  protected fitsIn(value: bigint, type: IntType): boolean {
    return fitsInt(value, type);
  }

  protected comptimeInt(): Type {
    return COMPTIME_INT;
  }
}

function unwrapParens(expression: Expression): Expression {
  return expression.kind === 'paren' ? unwrapParens(expression.operand) : expression;
}

function runDefers(frame: Frame, mark: number, completion: Jump | undefined, fnTarget: object | undefined): void {
  const error = completion && isErrorReturn(completion, fnTarget) ? completion.value : undefined;
  withHeldValues(frame, completion ? [completion.value] : [], () => {
    while (frame.defers.length > mark) {
      const deferred = frame.defers.pop();
      if (!deferred) break;
      if (deferred.isErrdefer && error === undefined) continue;
      deferred.run(frame);
    }
  });
}

function isErrorReturn(jump: Jump, fnTarget: object | undefined): boolean {
  return jump.kind === 'return' && jump.target === fnTarget && jump.value instanceof ErrorValue;
}

/** Runs a loop's body, turning a jump that an expression in it throws into a completion. */
function runBody(body: Exec, frame: Frame, id: object): Jump | undefined {
  try {
    return body(frame);
  } catch (error) {
    if (error instanceof Jump && error.target === id) return error;
    throw error;
  }
}

function loopExit(completion: Jump | undefined, id: object): Jump | { value: Value } | undefined {
  if (!completion) return undefined;
  if (completion.target !== id) return completion;
  return completion.kind === 'break' ? { value: completion.value } : undefined;
}

function conditionKind(type: Type, hasCapture: boolean): 'bool' | 'optional' | 'error_union' {
  if (type.kind === 'optional') return 'optional';
  if (type.kind === 'error_union') return 'error_union';
  void hasCapture;
  return 'bool';
}

/** Whether a loop variable of a type holds what learners answer, as Java's primitives and strings do. */
function storesAnswerValue(type: Type): boolean {
  switch (type.kind) {
    case 'int':
    case 'comptime_int':
    case 'float':
    case 'comptime_float':
    case 'bool':
    case 'enum': {
      return true;
    }
    case 'optional': {
      return storesAnswerValue(type.child);
    }
    case 'pointer': {
      return type.child === U8 || (type.child.kind === 'array' && type.child.child === U8);
    }
    default: {
      return false;
    }
  }
}

/** Whether an expression statement only calls functions, whose own steps show what it did. */
function isCallOnly(expression: Expression): boolean {
  switch (expression.kind) {
    case 'call':
    case 'builtinCall': {
      return true;
    }
    case 'try': {
      return isCallOnly(expression.operand);
    }
    case 'catch': {
      return isCallOnly(expression.operand);
    }
    case 'paren': {
      return isCallOnly(expression.operand);
    }
    default: {
      return false;
    }
  }
}

/** Whether an expression creates an object, as a call to an `init` function or a struct literal does. */
function isObjectCreation(expression: Expression): boolean {
  if (expression.kind === 'call') {
    const callee = expression.callee;
    const name =
      callee.kind === 'field' || callee.kind === 'identifier' || callee.kind === 'enumLiteral' ? callee.name : '';
    return name.startsWith('init');
  }
  if (expression.kind === 'structInit') return true;
  if (expression.kind === 'arrayInit')
    return expression.elements.length > 0 && expression.elements.every((element) => isObjectCreation(element));
  if (expression.kind === 'try' || expression.kind === 'paren') return isObjectCreation(expression.operand);
  return false;
}

function coversRange(seen: Map<unknown, Span>, type: IntType): boolean {
  const low = minInt(type);
  const high = maxInt(type);
  const count = high - low + 1n;
  let covered = 0n;
  for (const key of seen.keys()) {
    if (typeof key === 'bigint') covered++;
    else if (Array.isArray(key)) covered += (key[1] as bigint) - (key[0] as bigint) + 1n;
  }
  return covered >= count;
}

function isSelfType(type: Type, namespace: { name: string }): boolean {
  const target = type.kind === 'pointer' && type.size === 'one' ? type.child : type;
  return (
    (target.kind === 'struct' || target.kind === 'enum' || target.kind === 'union') && target.namespace === namespace
  );
}

export { isObjectCreation };

function copyJumpValue(value: TExpr): (frame: Frame) => Value {
  const evaluate = value.eval;
  return (frame) => copyForFrame(frame, evaluate(frame), value.type);
}

/** Writes a value into `holder.slots[index]`. */
type ResultStore = (frame: Frame, holder: Slots, index: number) => void;

function isAggregateType(type: Type): boolean {
  return type.kind === 'struct' || type.kind === 'array' || type.kind === 'union';
}

/** The key a prong's value has in a switch: an error's name, or the value itself. */
function prongKey(value: Value): unknown {
  return value instanceof ErrorValue ? value.name : value;
}

function clearingLocals<T>(slots: readonly number[], run: (frame: Frame) => T): (frame: Frame) => T {
  if (slots.length === 0) return run;
  return (frame) => {
    try {
      return run(frame);
    } finally {
      for (const slot of slots) frame.slots[slot] = UNASSIGNED;
    }
  };
}
