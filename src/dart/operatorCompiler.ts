import type { Arguments as ArgumentsSyntax, CascadeSection, Expression, Span } from './ast';
import { at, type Compiled, type Eval, typeName } from './compilerBase';
import { ExpressionCompiler, isDoubleContext, promotionTarget, SHORTED, singleArgument } from './expressionCompiler';
import {
  concatenate,
  doubleModulo,
  doubleTruncatingDivide,
  dynamicBinary,
  intModulo,
  intTruncatingDivide,
  numericBinary,
  shiftLeft,
  shiftRight,
  shiftRightUnsigned,
  wrap,
} from './operators';
import type { Frame, Runtime } from './runtime';
import { Flow } from './scope';
import {
  coreTypes,
  type DartType,
  DYNAMIC,
  interfaceType,
  isNullable,
  isSubtype,
  makeNullable,
  NEVER,
  nonNullable,
  numericClassOf,
  sameType,
  upperBound,
  vmTypeString,
} from './types';
import { Cell, type Value } from './values';

/** Operators, conditionals, casts, throws, and cascades. */
export abstract class OperatorCompiler extends ExpressionCompiler {
  // code-gauge-allow functionCognitiveComplexity 25 -- Each branch is one of the cases Dart distinguishes for this construct.
  protected compilePrefix(
    expression: Extract<Expression, { kind: 'prefix' }>,
    context: DartType | undefined
  ): Compiled {
    const { operator, operand } = expression;
    if (operator === '++' || operator === '--')
      return this.compileIncrement(operand, operator === '++' ? '+' : '-', true, expression);
    if (operator === '!') return this.compileConditionInner(expression).compiled;
    if (operator === '-' && operand.kind === 'int') return this.compileInt(operand, context, true);
    const methodName = operator === '-' ? 'unary-' : '~';
    const value = operand.kind === 'super' ? this.superReceiver(operand) : this.compileExpression(operand);
    const numeric = numericClassOf(value.type);
    if (numeric) {
      const { run } = value;
      if (operator === '~' && numeric !== 'int')
        this.error(expression, `${typeName(value.type)} 型には ~ 演算子がありません。`);
      const constValue = value.constValue ? { value: negate(value.constValue.value, operator) } : undefined;
      return {
        type:
          value.type.kind === 'typeParam'
            ? value.type
            : interfaceType(
                numeric === 'int' ? coreTypes.int : numeric === 'double' ? coreTypes.double : coreTypes.num
              ),
        run: (frame) => negate(run(frame), operator),
        isConst: value.isConst,
        constValue,
      };
    }
    if (value.type.kind === 'dynamic') return dynamicPrefix(value.run, operator, methodName, expression.row);
    return this.compileOperatorCall(value, methodName, [], expression);
  }

  protected compileNullAssert(expression: Extract<Expression, { kind: 'nullAssert' }>): Compiled {
    const value = this.compileChainPart(expression.operand, undefined);
    const { run } = value;
    // After `x!` completes, x is known not to be null.
    if (value.variable && this.isPromotable(value.variable)) {
      const current = this.promotedType(value.variable);
      const nonNull = nonNullable(current);
      if (!sameType(nonNull, current)) this.flow = this.flow.promote(value.variable, nonNull);
    }
    return {
      type: value.type.kind === 'dynamic' ? DYNAMIC : nonNullable(value.type),
      run: (frame) => {
        const result = run(frame);
        if (result === SHORTED) return SHORTED;
        if (result === undefined) frame.runtime.throwTypeError('Null check operator used on a null value');
        return result;
      },
      isConst: false,
    };
  }

  protected compileBinary(
    expression: Extract<Expression, { kind: 'binary' }>,
    context: DartType | undefined
  ): Compiled {
    const { operator } = expression;
    if (operator === '&&' || operator === '||') {
      const result = this.compileLogical(expression);
      return result.compiled;
    }
    if (operator === '==' || operator === '!=') {
      const result = this.compileEquality(expression);
      this.flow = Flow.join(result.flow.whenTrue, result.flow.whenFalse);
      return result.compiled;
    }
    if (operator === '??') return this.compileIfNull(expression, context);
    const left =
      expression.left.kind === 'super' ? this.superReceiver(expression.left) : this.compileExpression(expression.left);
    return this.compileBinaryWithLeft(left, operator, expression.right, expression, context);
  }

  protected compileSuperEquality(expression: Extract<Expression, { kind: 'binary' }>): Compiled {
    const call = this.compileOperatorCall(this.superReceiver(expression.left), '==', [expression.right], expression);
    const { run } = call;
    const negated = expression.operator === '!=';
    return { ...call, run: (frame) => (run(frame) === true) !== negated };
  }

  /** Compiles `left op right` once the left operand is compiled, as compound assignments need. */
  // code-gauge-allow functionCognitiveComplexity 22 -- The typing rules of numbers, strings, dynamic, and operator methods.
  // code-gauge-allow functionNcss 33 -- The typing rules of numbers, strings, dynamic, and operator methods.
  protected compileBinaryWithLeft(
    left: Compiled,
    operator: string,
    rightSyntax: Expression,
    span: Span,
    context: DartType | undefined
  ): Compiled {
    const expression = { ...at(span), right: rightSyntax };
    if (left.type.kind === 'void') this.error(expression, 'void の値には演算子を使えません。');
    const leftNumeric = numericClassOf(left.type);
    if (leftNumeric) {
      const parameterContext = leftNumeric === 'double' ? interfaceType(coreTypes.num) : undefined;
      const right = this.compileExpression(
        expression.right,
        context && leftNumeric === 'int' && isDoubleContext(context) ? undefined : parameterContext
      );
      return this.numericOperator(operator, left, right, leftNumeric, span);
    }
    if (left.type.kind === 'dynamic') {
      const right = this.compileExpression(expression.right);
      const leftRun = left.run;
      const rightRun = right.run;
      return {
        type: ['<', '<=', '>', '>='].includes(operator) ? DYNAMIC : DYNAMIC,
        run: (frame) => {
          const a = leftRun(frame);
          frame.temporaries.push(a);
          try {
            return dynamicBinary(frame.runtime, operator, a, rightRun(frame), expression.row);
          } finally {
            frame.temporaries.pop();
          }
        },
        isConst: false,
      };
    }
    if (
      left.type.kind === 'interface' &&
      left.type.cls === coreTypes.string &&
      !left.type.nullable &&
      operator === '+'
    ) {
      const right = this.compileExpression(expression.right, interfaceType(coreTypes.string));
      if (!isSubtype(right.type, interfaceType(coreTypes.string)) && right.type.kind !== 'dynamic') {
        this.error(expression.right, `${typeName(right.type)} 型の値は、String の + に渡せません。`);
      }
      const leftRun = left.run;
      const rightRun = right.run;
      const constValue =
        left.constValue && right.constValue
          ? { value: (left.constValue.value as string) + (right.constValue.value as string) }
          : undefined;
      return {
        type: interfaceType(coreTypes.string),
        run: (frame) => {
          const a = leftRun(frame) as string;
          const b = rightRun(frame);
          if (typeof b !== 'string')
            return frame.runtime.throwTypeError(
              `type '${vmTypeString(frame.runtime.runtimeTypeOf(b))}' is not a subtype of type 'String' of 'other'`
            );
          return concatenate(frame.runtime, a, b);
        },
        isConst: left.isConst && right.isConst,
        constValue,
      };
    }
    return this.compileOperatorCall(left, operator, [expression.right], span);
  }

  /** Calls an operator method of the left operand's class, checking the operand against its parameter. */
  protected compileOperatorCall(left: Compiled, operator: string, rightSyntax: Expression[], span: Span): Compiled {
    if (isNullable(left.type) && left.type.kind !== 'dynamic') {
      this.error(
        span,
        `${typeName(left.type)} 型の値は null かもしれないので、演算子 ${operator === 'unary-' ? '-' : operator} を直接は使えません。`
      );
    }
    const resolved = this.lookupMember(left.type, operator, false);
    if (!resolved || resolved.member.kind !== 'method') {
      return this.error(
        span,
        `${typeName(left.type)} 型には演算子 ${operator === 'unary-' ? '-' : operator} がありません。`
      );
    }
    const args: ArgumentsSyntax = {
      positional: rightSyntax,
      named: [],
      order: rightSyntax.map((_, index) => ({ kind: 'positional' as const, index })),
      ...at(span),
    };
    return this.compileMethodCall(
      left,
      { ...at(span), kind: 'this' },
      operator,
      args,
      undefined,
      span,
      undefined,
      false
    );
  }

  // code-gauge-allow functionCognitiveComplexity 28 -- The typing rules of num's operators.
  // code-gauge-allow functionNcss 53 -- The typing rules of num's operators.
  private numericOperator(
    operator: string,
    left: Compiled,
    right: Compiled,
    leftNumeric: 'int' | 'double' | 'num',
    span: Span
  ): Compiled {
    const rightNumeric = numericClassOf(right.type);
    const isComparison = ['<', '<=', '>', '>='].includes(operator);
    const isBitwise = ['&', '|', '^', '<<', '>>', '>>>'].includes(operator);
    if (!['+', '-', '*', '/', '~/', '%', '<', '<=', '>', '>=', '&', '|', '^', '<<', '>>', '>>>'].includes(operator)) {
      return this.error(span, `${typeName(left.type)} 型には演算子 ${operator} がありません。`);
    }
    if (isBitwise && leftNumeric !== 'int')
      return this.error(span, `${typeName(left.type)} 型には演算子 ${operator} がありません。`);
    const parameterType = isBitwise ? interfaceType(coreTypes.int) : interfaceType(coreTypes.num);
    if (right.type.kind !== 'dynamic' && !isSubtype(right.type, parameterType)) {
      this.error(
        span,
        `${typeName(right.type)} 型の値は、演算子 ${operator} の右辺 ${typeName(parameterType)} に合いません。`
      );
    }
    let resultType: DartType;
    if (isComparison) resultType = interfaceType(coreTypes.bool);
    else if (operator === '/') resultType = interfaceType(coreTypes.double);
    else if (operator === '~/' || isBitwise) resultType = interfaceType(coreTypes.int);
    else if (leftNumeric === 'double') resultType = interfaceType(coreTypes.double);
    else if (leftNumeric === 'int' && rightNumeric === 'int') resultType = interfaceType(coreTypes.int);
    else if (leftNumeric === 'int' && rightNumeric === 'double') resultType = interfaceType(coreTypes.double);
    else resultType = interfaceType(coreTypes.num);
    if (
      ARITHMETIC.has(operator) &&
      left.type.kind === 'typeParam' &&
      sameType(left.type, right.type) &&
      leftNumeric !== 'num'
    ) {
      resultType = left.type;
    }
    const leftRun = left.run;
    const rightRun = right.run;
    const constValue =
      left.constValue && right.constValue && isNumber(left.constValue.value) && isNumber(right.constValue.value)
        ? safeConstant(() =>
            numericBinaryConstant(
              operator,
              left.constValue?.value as bigint | number,
              right.constValue?.value as bigint | number
            )
          )
        : undefined;
    const isConst = left.isConst && right.isConst;
    if (leftNumeric === 'int' && rightNumeric === 'int') {
      const op = intOperation(operator);
      return {
        type: resultType,
        run: (frame) => {
          const a = leftRun(frame) as bigint;
          return op(frame, a, rightRun(frame) as bigint);
        },
        isConst,
        constValue,
      };
    }
    if (leftNumeric === 'double' && rightNumeric === 'double') {
      const op = doubleOperation(operator);
      return {
        type: resultType,
        run: (frame) => {
          const a = leftRun(frame) as number;
          return op(frame, a, rightRun(frame) as number);
        },
        isConst,
        constValue,
      };
    }
    return {
      type: resultType,
      run: (frame) => {
        const a = leftRun(frame) as bigint | number;
        const b = rightRun(frame);
        if (typeof b !== 'bigint' && typeof b !== 'number') {
          return dynamicBinary(frame.runtime, operator, a, b, span.row);
        }
        return numericBinary(frame.runtime, operator, a, b);
      },
      isConst,
      constValue,
    };
  }

  private compileIfNull(expression: Extract<Expression, { kind: 'binary' }>, context: DartType | undefined): Compiled {
    const left = this.compileExpression(expression.left, context ? makeNullable(context) : undefined);
    const before = this.flow;
    const right = this.compileExpression(expression.right, context ?? nonNullable(left.type));
    this.flow = Flow.join(before, this.flow);
    const leftRun = left.run;
    const rightRun = right.run;
    const type = upperBound(left.type.kind === 'dynamic' ? DYNAMIC : nonNullable(left.type), right.type);
    return {
      type,
      run: (frame) => {
        return leftRun(frame) ?? rightRun(frame);
      },
      isConst: left.isConst && right.isConst,
      constValue:
        left.constValue && right.constValue
          ? left.constValue.value === undefined
            ? right.constValue
            : left.constValue
          : undefined,
    };
  }

  protected compileConditional(
    expression: Extract<Expression, { kind: 'conditional' }>,
    context: DartType | undefined
  ): Compiled {
    const { compiled: condition, flow } = this.compileCondition(expression.condition);
    this.flow = flow.whenTrue;
    const then = this.compileExpression(expression.consequent, context);
    const afterThen = this.flow;
    this.flow = flow.whenFalse;
    const otherwise = this.compileExpression(expression.alternative, context);
    this.flow = Flow.join(afterThen, this.flow);
    const type =
      then.type.kind === 'never' && !then.type.nullable
        ? otherwise.type
        : otherwise.type.kind === 'never' && !otherwise.type.nullable
          ? then.type
          : upperBound(then.type, otherwise.type);
    const conditionRun = condition.run;
    const thenRun = then.run;
    const otherwiseRun = otherwise.run;
    const constValue =
      condition.constValue && then.constValue && otherwise.constValue
        ? condition.constValue.value
          ? then.constValue
          : otherwise.constValue
        : undefined;
    return {
      type,
      run: (frame) => (conditionRun(frame) ? thenRun(frame) : otherwiseRun(frame)),
      isConst: condition.isConst && then.isConst && otherwise.isConst,
      constValue,
    };
  }

  protected compileAs(expression: Extract<Expression, { kind: 'as' }>): Compiled {
    const value = this.compileExpression(expression.value);
    const type = this.resolveType(expression.type);
    let { flow } = this;
    const { variable } = value;
    if (variable && this.isPromotable(variable)) {
      const narrowed = promotionTarget(this.promotedType(variable), type);
      if (narrowed) flow = flow.promote(variable, narrowed);
    }
    this.flow = flow;
    return { type, run: this.runtimeCast(value.run, type, true), isConst: false };
  }

  protected compileThrow(expression: Extract<Expression, { kind: 'throw' }>): Compiled {
    const value = this.compileExpression(expression.value);
    if (isNullable(value.type) && value.type.kind !== 'dynamic') {
      this.error(expression, `null かもしれない ${typeName(value.type)} 型の値は throw できません。`);
    }
    if (value.type.kind === 'void') this.error(expression, 'void の値は throw できません。');
    const { run } = value;
    this.flow = this.flow.unreachable;
    return {
      type: NEVER,
      run: (frame) => {
        const thrown = run(frame);
        if (thrown === undefined) frame.runtime.throwTypeError("type 'Null' is not a subtype of type 'Object'");
        throw this.newThrow(frame, thrown);
      },
      isConst: false,
      completes: false,
    };
  }

  protected compileCascade(
    expression: Extract<Expression, { kind: 'cascade' }>,
    context: DartType | undefined
  ): Compiled {
    const target = this.compileExpression(expression.target, context);
    const slot = this.fn.allocateSlot();
    this.fn.info.locals[slot] = { name: '\0', type: target.type };
    const temporary = new Cell(undefined);
    void temporary;
    const variableType = target.type;
    const sections = expression.sections.map((section) => {
      const receiver: Compiled = {
        // A null-aware cascade skips every section when the target is null, so each sees a value that is not.
        type: expression.sections[0]?.nullAware ? nonNullable(variableType) : variableType,
        run: (frame) => (frame.locals[slot] as Cell).v,
        isConst: false,
      };
      return this.compileCascadeSection(receiver, section);
    });
    const targetRun = target.run;
    const nullAware = expression.sections[0]?.nullAware ?? false;
    return {
      type: target.type,
      run: (frame) => {
        const value = targetRun(frame);
        if (nullAware && value === undefined) return;
        const previous = frame.locals[slot];
        frame.locals[slot] = new Cell(value);
        try {
          for (const section of sections) section(frame);
        } finally {
          frame.locals[slot] = previous;
        }
        return value;
      },
      isConst: false,
    };
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- Each branch is one of the cases Dart distinguishes for this construct.
  // code-gauge-allow functionNcss 34 -- One case per form of the construct, which reads best together.
  private compileCascadeSection(receiver: Compiled, section: CascadeSection): Eval {
    const span = section;
    let current: Compiled = receiver;
    const { selectors, assignment } = section;
    const last = assignment ? selectors.at(-1) : undefined;
    const reading = assignment ? selectors.slice(0, -1) : selectors;
    for (const [index, selector] of reading.entries()) {
      switch (selector.kind) {
        case 'member': {
          const next = reading[index + 1];
          if (next?.kind === 'call') continue;
          current = this.readMemberOf(current, selector.name, selector, selector.nullAware);
          break;
        }
        case 'call': {
          const previous = reading[index - 1];
          const isMethod = previous?.kind === 'member';
          current = this.compileMethodCall(
            current,
            { ...at(span), kind: 'this' },
            isMethod ? previous.name : 'call',
            selector.arguments,
            selector.typeArguments,
            selector,
            undefined,
            isMethod ? previous.nullAware : false
          );
          break;
        }
        case 'index': {
          current = this.compileMethodCall(
            current,
            { ...at(span), kind: 'this' },
            '[]',
            singleArgument(selector.index),
            undefined,
            selector,
            undefined,
            selector.nullAware
          );
          break;
        }
        case 'nullAssert': {
          const { run } = current;
          current = {
            type: nonNullable(current.type),
            run: (frame) => {
              const value = run(frame);
              if (value === undefined) frame.runtime.throwTypeError('Null check operator used on a null value');
              return value;
            },
            isConst: false,
          };
          break;
        }
      }
    }
    if (assignment && last) {
      const compiled = this.compileAssignmentTo(current, last, assignment.operator, assignment.value, span);
      return compiled.run;
    }
    return current.run;
  }
}

const ARITHMETIC = new Set(['+', '-', '*', '%', 'remainder']);

// code-gauge-allow duplicateLines 32 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
function doubleOperation(operator: string): (frame: Frame, a: number, b: number) => Value {
  switch (operator) {
    case '+': {
      return (_frame, a, b) => a + b;
    }
    case '-': {
      return (_frame, a, b) => a - b;
    }
    case '*': {
      return (_frame, a, b) => a * b;
    }
    case '/': {
      return (_frame, a, b) => a / b;
    }
    case '~/': {
      return (frame, a, b) => doubleTruncatingDivide(frame.runtime, a, b);
    }
    case '%': {
      return (_frame, a, b) => doubleModulo(a, b);
    }
    case '<': {
      return (_frame, a, b) => a < b;
    }
    case '<=': {
      return (_frame, a, b) => a <= b;
    }
    case '>': {
      return (_frame, a, b) => a > b;
    }
    default: {
      return (_frame, a, b) => a >= b;
    }
  }
}

// code-gauge-allow duplicateLines 31 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
// code-gauge-allow functionNcss 34 -- One case per form of the construct, which reads best together.
function intOperation(operator: string): (frame: Frame, a: bigint, b: bigint) => Value {
  switch (operator) {
    case '+': {
      return (_frame, a, b) => wrap(a + b);
    }
    case '-': {
      return (_frame, a, b) => wrap(a - b);
    }
    case '*': {
      return (_frame, a, b) => wrap(a * b);
    }
    case '/': {
      return (_frame, a, b) => Number(a) / Number(b);
    }
    case '~/': {
      return (frame, a, b) => intTruncatingDivide(frame.runtime, a, b);
    }
    case '%': {
      return (frame, a, b) => intModulo(frame.runtime, a, b);
    }
    case '<': {
      return (_frame, a, b) => a < b;
    }
    case '<=': {
      return (_frame, a, b) => a <= b;
    }
    case '>': {
      return (_frame, a, b) => a > b;
    }
    case '>=': {
      return (_frame, a, b) => a >= b;
    }
    case '&': {
      return (_frame, a, b) => a & b;
    }
    case '|': {
      return (_frame, a, b) => a | b;
    }
    case '^': {
      return (_frame, a, b) => a ^ b;
    }
    case '<<': {
      return (frame, a, b) => shiftLeft(frame.runtime, a, b);
    }
    case '>>': {
      return (frame, a, b) => shiftRight(frame.runtime, a, b);
    }
    default: {
      return (frame, a, b) => shiftRightUnsigned(frame.runtime, a, b);
    }
  }
}

function negate(value: Value, operator: '-' | '~'): Value {
  if (operator === '~') return ~(value as bigint);
  return typeof value === 'bigint' ? wrap(-value) : -(value as number);
}

/** Folds an operator on numeric constants, which a constant expression needs while compiling. */
function numericBinaryConstant(operator: string, a: bigint | number, b: bigint | number): { value: Value } | undefined {
  if (typeof a === 'bigint' && typeof b === 'bigint' && (operator === '~/' || operator === '%') && b === 0n)
    return undefined;
  const fakeRuntime = {
    throwError: () => {
      throw new Error('constant');
    },
    throwTypeError: () => {
      throw new Error('constant');
    },
  } as unknown as Runtime;
  return { value: numericBinary(fakeRuntime, operator, a, b) };
}

function safeConstant(compute: () => { value: Value } | undefined): { value: Value } | undefined {
  try {
    return compute();
  } catch {
    return undefined;
  }
}

function isNumber(value: Value): value is bigint | number {
  return typeof value === 'bigint' || typeof value === 'number';
}

/** `-d` or `~d` of a dynamic value: arithmetic for numbers, and otherwise a dynamic call of the operator method. */
function dynamicPrefix(run: Eval, operator: '-' | '~', methodName: string, row: number): Compiled {
  return {
    type: DYNAMIC,
    run: (frame) => {
      const operand = run(frame);
      if (typeof operand === 'bigint' || typeof operand === 'number') return negate(operand, operator);
      return frame.runtime.invoke(operand, methodName, { positional: [], named: undefined, isDynamic: true }, [], row);
    },
    isConst: false,
  };
}
