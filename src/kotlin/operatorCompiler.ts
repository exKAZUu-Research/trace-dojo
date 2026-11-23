// code-gauge-allow-file fileNcss -- the compiler of one area of Kotlin, whose parts call each other closely.
import { isNullLiteral } from './ast';
import type { CallExpression, Expression, TypeRef } from './ast';
import { type ArgumentSyntax } from './callCompiler';
import {
  checkedBoolean,
  commonNarrowing,
  type Compiled,
  convertRepr,
  type Eval,
  excludingCases,
  Flow,
  type FunctionContext,
  isBareCallExpression,
  nonNullFacts,
  reprOf,
  type Scope,
  typeMismatchMessage,
} from './compilerBase';
import { ExpressionCompiler, type Place } from './expressionCompiler';
import { caseOf, keyOf } from './flowKeys';
import { valueEquals } from './format';
import {
  arithmeticOperation,
  type ArithmeticOperator,
  arithmeticResult,
  compareNumbers,
  negate,
  NUMBER_OPERATOR_NAMES,
  step,
  unaryResult,
  widen,
} from './operators';
import { type Frame } from './runtime';
import { type ClassSymbol, type TypeParameterSymbol } from './symbols';
import { instanceTest, throwCastFailure } from './typeChecks';
import { branchHint, commonSupertype, isSubtype } from './typeRelations';
import { isNullable, type KType, nonNull, nullable, resolved, substitute, typeToString } from './types';
import { box, Boxed, type PrimitiveKind, type Value } from './values';

/** Compiles the operators, the conditions, and the `in`, `is`, and `as` tests. */
export abstract class OperatorCompiler extends ExpressionCompiler {
  // code-gauge-allow functionCognitiveComplexity -- One case per unary operator.
  protected compilePrefix(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'prefix' }>,
    expected: KType | undefined
  ): Compiled {
    const { operator, row } = expression;
    if (operator === '++' || operator === '--')
      return this.compileIncrement(scope, context, expression.operand, operator === '++' ? 1 : -1, true, row);
    if (
      operator === '-' &&
      expression.operand.kind === 'integer' &&
      expression.operand.suffix !== 'u' &&
      expression.operand.suffix !== 'uL'
    ) {
      const negated = {
        ...expression.operand,
        value: -expression.operand.value,
      };
      return this.compileInteger(negated, expected);
    }
    if (operator === '-' && expression.operand.kind === 'real') {
      const value = -expression.operand.value;
      const kind = expression.operand.isFloat ? 'Float' : 'Double';
      return {
        type: this.primitiveType(kind),
        repr: kind,
        eval: () => value,
        constant: value,
      };
    }
    if (this.isLongConstant(expression, expected)) {
      return this.toLongConstant(this.compilePrefix(scope, context, expression, undefined));
    }
    const operand = this.compileExpression(scope, context, expression.operand);
    if (operator === '!') {
      if (!isSubtype(operand.type, this.booleanType))
        this.error(row, typeMismatchMessage(this.booleanType, operand.type));
      const evaluate = checkedBoolean(operand, operand.eval);
      return {
        type: this.booleanType,
        repr: 'ref',
        eval: (frame) => !(evaluate(frame) as boolean),
        constant: operand.constant === undefined ? undefined : !operand.constant,
        narrowing: operand.narrowing
          ? {
              whenTrue: operand.narrowing.whenFalse,
              whenFalse: operand.narrowing.whenTrue,
            }
          : undefined,
      };
    }
    const kind = this.primitiveOf(operand.type);
    const result = kind ? unaryResult(kind) : undefined;
    if (!kind || !result) {
      return this.compileOperatorCall(
        scope,
        context,
        operand,
        operator === '-' ? 'unaryMinus' : 'unaryPlus',
        [],
        row,
        operator
      );
    }
    const evaluate = this.convertTo(operand, operand.type, row);
    if (operator === '+')
      return {
        type: this.primitiveType(result),
        repr: result,
        eval: (frame) => widen(evaluate(frame) as number, kind, result),
      };
    return {
      type: this.primitiveType(result),
      repr: result,
      eval: (frame) => negate(result, widen(evaluate(frame) as number | bigint, kind, result)),
    };
  }

  protected compilePostfix(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'postfix' }>
  ): Compiled {
    const { operator, row } = expression;
    if (operator === '++' || operator === '--')
      return this.compileIncrement(scope, context, expression.operand, operator === '++' ? 1 : -1, false, row);
    const operand = this.compileExpression(scope, context, expression.operand);
    const evaluate = operand.eval;
    this.flow.assumeNonNull(operand);
    return {
      type: nonNull(operand.type),
      repr: operand.repr,
      eval: (frame) => {
        const value = evaluate(frame);
        if (value === undefined) return frame.runtime.throwError(frame, 'java.lang.NullPointerException');
        return value;
      },
      isCall: operand.isCall,
    };
  }

  /** `++` and `--`, which store the incremented value and give the new value (prefix) or the old one (postfix). */
  protected compileIncrement(
    scope: Scope,
    context: FunctionContext,
    target: Expression,
    delta: 1 | -1,
    isPrefix: boolean,
    row: number
  ): Compiled {
    if (target.kind === 'member' && target.isSafe) this.unavailable(row, '?. を使った ++・--');
    const place = this.compilePlace(scope, context, target, row, true);
    const readType = place.readType ?? place.type;
    const kind = this.primitiveOf(readType);
    if (!kind) this.error(row, `${typeToString(resolved(readType))} には ${delta === 1 ? '++' : '--'} を使えません。`);
    const type = this.primitiveType(kind);
    place.recordAssignment?.(type);
    const toPlace = (value: number | bigint): Value => (place.repr === 'ref' ? box(kind, value) : value);
    return {
      type,
      repr: kind,
      eval: (frame) =>
        place.withBound(frame, (bound) => {
          const old = unboxNumber(bound.get());
          const next = step(kind, old, delta);
          bound.set(toPlace(next));
          return isPrefix ? next : old;
        }),
    };
  }

  /**
   * Evaluates an assignable place's receiver and indexes once and roots them through its reads and writes.
   */
  abstract compilePlace(
    scope: Scope,
    context: FunctionContext,
    target: Expression,
    row: number,
    isCompound: boolean
  ): Place;

  protected compileBinary(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'binary' }>,
    expected: KType | undefined
  ): Compiled {
    const { operator, row } = expression;
    switch (operator) {
      case '&&':
      case '||': {
        return this.compileLogical(scope, context, expression);
      }
      case '?:': {
        return this.compileElvis(scope, context, expression, expected);
      }
      case '==':
      case '!=':
      case '===':
      case '!==': {
        return this.compileEquality(scope, context, expression);
      }
      case '..':
      case '..<': {
        const left = this.compileExpression(scope, context, expression.left);
        const args: ArgumentSyntax[] = [
          {
            row: expression.right.row,
            name: undefined,
            value: expression.right,
          },
        ];
        return this.compileOperatorCall(
          scope,
          context,
          left,
          operator === '..' ? 'rangeTo' : 'rangeUntil',
          args,
          row,
          operator
        );
      }
      case '<':
      case '<=':
      case '>':
      case '>=': {
        return this.compileComparison(scope, context, expression);
      }
      default: {
        const left = this.compileExpression(scope, context, expression.left);
        const compiled = this.compileArithmeticWith(scope, context, operator, left, expression.right, row);
        return this.isLongConstant(expression, expected) ? this.toLongConstant(compiled) : compiled;
      }
    }
  }

  /**
   * A constant of integer literals where a Long is expected, as `val x: Long = 1 + 2`: Kotlin computes it as an Int, so
   * that `2147483647 + 1` overflows, and converts the result.
   */
  protected toLongConstant(compiled: Compiled): Compiled {
    if (compiled.repr !== 'Int') return compiled;
    const evaluate = compiled.eval;
    return {
      ...compiled,
      type: this.primitiveType('Long'),
      repr: 'Long',
      eval: (frame) => BigInt(evaluate(frame) as number),
      constant: compiled.constant === undefined ? undefined : BigInt(compiled.constant as number),
      integerLiteral: undefined,
    };
  }

  /** Whether an expression is made only of integer literals and arithmetic, where a `Long` is expected. */
  protected isLongConstant(expression: Expression, expected: KType | undefined): boolean {
    return expected !== undefined && this.primitiveOf(nonNull(expected)) === 'Long' && isIntegerConstant(expression);
  }

  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  protected compileArithmeticWith(
    scope: Scope,
    context: FunctionContext,
    operator: ArithmeticOperator,
    left: Compiled,
    rightExpression: Expression,
    row: number
  ): Compiled {
    const leftKind = this.primitiveOf(left.type);
    if (operator === '+' && this.isClass(left.type, this.core.string) && !isNullable(resolved(left.type))) {
      const right = this.compileExpression(scope, context, rightExpression);
      const leftText = left.eval;
      const rightText = this.stringConversion(right);
      const constant =
        typeof left.constant === 'string' &&
        right.constant !== undefined &&
        right.repr === 'ref' &&
        typeof right.constant === 'string'
          ? left.constant + right.constant
          : undefined;
      return {
        type: this.stringType,
        repr: 'ref',
        eval: (frame) => {
          const text = (leftText(frame) as string) + rightText(frame);
          frame.runtime.allocateString(frame, text.length);
          return text;
        },
        constant,
      };
    }
    if (leftKind) {
      const beforeRight = this.flow.copy();
      const right = this.compileExpression(scope, context, rightExpression);
      const rightKind = this.primitiveOf(right.type);
      const result = rightKind ? arithmeticResult(leftKind, rightKind, operator) : undefined;
      if (rightKind && result) {
        const operation = arithmeticOperation(result, operator);
        const leftEval = this.convertTo(left, left.type, row);
        const rightEval = this.convertTo(right, right.type, row);
        const leftTo: PrimitiveKind = result === 'Char' ? 'Char' : result;
        const rightTo: PrimitiveKind =
          result === 'Char' ? 'Int' : leftKind === 'Char' && rightKind === 'Char' ? 'Int' : result;
        const leftFinal: PrimitiveKind = leftKind === 'Char' && rightKind === 'Char' ? 'Int' : leftTo;
        return {
          type: this.primitiveType(result),
          repr: result,
          eval: (frame) =>
            operation(
              frame,
              widen(leftEval(frame) as number | bigint, leftKind, leftFinal),
              widen(rightEval(frame) as number | bigint, rightKind, rightTo)
            ),
        };
      }
      // Other operands go to the operator functions, as Char.plus(String) and Int.times(Duration).
      if (rightKind) {
        this.error(
          row,
          `演算子 ${operator} は ${typeToString(resolved(left.type))} と ${typeToString(resolved(right.type))} には使えません。`
        );
      }
      // The operator call compiles the right operand again, whose writes the flow must see once.
      this.flow = beforeRight;
    }
    const args: ArgumentSyntax[] = [{ row: rightExpression.row, name: undefined, value: rightExpression }];
    return this.compileOperatorCall(scope, context, left, NUMBER_OPERATOR_NAMES[operator], args, row, operator);
  }

  protected compileLogical(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'binary' }>
  ): Compiled {
    const isAnd = expression.operator === '&&';
    const condition = this.compileCondition(scope, context, expression.left);
    const before = this.flow.copy();
    this.applyNarrowing(isAnd ? condition.whenTrue : condition.whenFalse);
    const right = this.compileCondition(scope, context, expression.right);
    const afterRight = this.flow;
    this.flow = Flow_merge([afterRight, this.withNarrowing(before, isAnd ? condition.whenFalse : condition.whenTrue)]);
    const leftEval = condition.compiled.eval;
    const rightEval = right.compiled.eval;
    // The right operand runs after the left one, so its writes undo what the left one established.
    const leftTrue = this.withoutWritten(scope, condition.whenTrue, expression.right);
    const leftFalse = this.withoutWritten(scope, condition.whenFalse, expression.right);
    const whenTrue = isAnd ? new Map([...leftTrue, ...right.whenTrue]) : commonNarrowing(leftTrue, right.whenTrue);
    const whenFalse = isAnd ? commonNarrowing(leftFalse, right.whenFalse) : new Map([...leftFalse, ...right.whenFalse]);
    return {
      type: this.booleanType,
      repr: 'ref',
      eval: isAnd
        ? (frame) => (leftEval(frame) as boolean) && (rightEval(frame) as boolean)
        : (frame) => (leftEval(frame) as boolean) || (rightEval(frame) as boolean),
      narrowing: { whenTrue, whenFalse },
    };
  }

  private withoutWritten(scope: Scope, narrowing: Map<string, KType>, code: Expression): Map<string, KType> {
    const flow = new Flow(new Map(narrowing));
    const saved = this.flow;
    this.flow = flow;
    try {
      this.forgetAssignedIn(scope, code);
    } finally {
      this.flow = saved;
    }
    return flow.narrowed;
  }

  /** A flow that has the narrowing of a condition applied, without changing `flow`. */
  protected withNarrowing(flow: Flow, narrowing: Map<string, KType>): Flow {
    const copy = flow.copy();
    for (const [key, type] of narrowing) copy.narrowed.set(key, type);
    return copy;
  }

  protected applyNarrowing(narrowing: Map<string, KType>): void {
    for (const [key, type] of narrowing) this.flow.narrowed.set(key, type);
  }

  /** Compiles a condition, with the smart casts that hold when it is true and when it is false. */
  compileCondition(
    scope: Scope,
    context: FunctionContext,
    expression: Expression
  ): {
    compiled: Compiled;
    whenTrue: Map<string, KType>;
    whenFalse: Map<string, KType>;
  } {
    const compiled = this.compileExpression(scope, context, expression, this.booleanType);
    if (!isSubtype(compiled.type, this.booleanType))
      this.error(expression.row, typeMismatchMessage(this.booleanType, compiled.type));
    const { narrowing } = compiled;
    const evaluate = checkedBoolean(compiled, convertRepr(compiled.eval, compiled.repr, 'ref'));
    return {
      compiled: { ...compiled, eval: evaluate },
      whenTrue: narrowing?.whenTrue ?? new Map(),
      whenFalse: narrowing?.whenFalse ?? new Map(),
    };
  }

  protected compileElvis(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'binary' }>,
    expected: KType | undefined
  ): Compiled {
    const left = this.compileExpression(scope, context, expression.left, expected ? nullable(expected) : undefined);
    const before = this.flow.copy();
    const right = this.compileExpression(
      scope,
      context,
      expression.right,
      branchHint(nonNull(left.type), expected, isBareCallExpression(expression.right))
    );
    const rightIsNothing = resolved(right.type).kind === 'nothing' && !resolved(right.type).nullable;
    this.flow = rightIsNothing ? before : Flow_merge([before, this.flow]);
    if (rightIsNothing) this.flow.assumeNonNull(left);
    const type = rightIsNothing ? nonNull(left.type) : commonSupertype([nonNull(left.type), right.type]);
    const repr = reprOf(this.core, type);
    const leftEval = convertRepr(left.eval, left.repr, 'ref');
    const rightEval = convertRepr(
      this.convertTo(right, right.type, expression.row),
      reprOf(this.core, right.type),
      'ref'
    );
    const choose: Eval = (frame) => {
      const value = leftEval(frame);
      return value ?? rightEval(frame);
    };
    return {
      type,
      repr,
      eval: convertRepr(choose, 'ref', repr),
      narrowing: booleanElvisNarrowing(left, expression.right),
    };
  }

  // code-gauge-allow functionCognitiveComplexity -- Kotlin's rules of equality by the operands' types.
  // code-gauge-allow functionNcss -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  protected compileEquality(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'binary' }>
  ): Compiled {
    const { operator, row } = expression;
    const left = this.compileExpression(scope, context, expression.left);
    const right = this.compileExpression(scope, context, expression.right);
    const negated = operator === '!=' || operator === '!==';
    const isIdentity = operator === '===' || operator === '!==';
    const comparesNullLiteral = isNullLiteral(expression.left) || isNullLiteral(expression.right);
    this.checkEqualityApplicable(left, right, row, operator);
    if (isIdentity && (isValueClassType(left.type) || isValueClassType(right.type)))
      this.error(row, `値クラスの値には ${operator} を使えません。`);
    const leftKind = this.primitiveOf(nonNull(left.type));
    const rightKind = this.primitiveOf(nonNull(right.type));
    let test: (frame: Frame) => boolean;
    if (!isIdentity && leftKind && leftKind === rightKind) {
      // Values statically known as numbers or characters compare by value, IEEE 754's way for floating point.
      const leftEval = convertRepr(left.eval, left.repr, 'ref');
      const rightEval = convertRepr(right.eval, right.repr, 'ref');
      if (left.repr !== 'ref' && right.repr !== 'ref') {
        const a = left.eval;
        const b = right.eval;
        test = (frame) => a(frame) === b(frame);
      } else {
        test = (frame) => {
          const a = leftEval(frame);
          const b = rightEval(frame);
          if (a === undefined || b === undefined) return a === b;
          return (a as Boxed).value === (b as Boxed).value;
        };
      }
    } else {
      const leftEval = convertRepr(left.eval, left.repr, 'ref');
      const rightEval = convertRepr(this.convertTo(right, right.type, row), reprOf(this.core, right.type), 'ref');
      const isPrimitiveIdentity = isIdentity && left.repr !== 'ref' && right.repr !== 'ref';
      test = isPrimitiveIdentity
        ? (frame) => sameReference(frame, left.eval(frame), right.eval(frame))
        : referenceEquality(leftEval, rightEval, isIdentity || comparesNullLiteral ? sameReference : valueEquals);
    }
    // The right operand runs after the left one is read, so its writes undo what comparing the left one shows.
    const { whenTrue, whenFalse } = this.equalityNarrowing(left, right, negated, [expression.left, expression.right]);
    const narrowing = {
      whenTrue: this.withoutWritten(scope, whenTrue, expression.right),
      whenFalse: this.withoutWritten(scope, whenFalse, expression.right),
    };
    return {
      type: this.booleanType,
      repr: 'ref',
      eval: negated ? (frame) => !test(frame) : test,
      narrowing,
    };
  }

  /**
   * The smart casts of `x != null` and `x == null` for a stable `x`, and of a safe call's receivers, which are not null
   * when the call's value is not null, as in `s?.length != null` and `s?.length == 3`.
   */
  protected equalityNarrowing(
    left: Compiled,
    right: Compiled,
    negated: boolean,
    [leftSyntax, rightSyntax]: [Expression | undefined, Expression]
  ): NonNullable<Compiled['narrowing']> {
    const whenEqual = new Map<string, KType>();
    const whenUnequal = new Map<string, KType>();
    for (const [operand, other] of [
      [left, right],
      [right, left],
    ]) {
      const otherType = resolved(other.type);
      const isNull = otherType.kind === 'nothing';
      const nonNullWhen = isNull ? whenUnequal : isNullable(otherType) ? undefined : whenEqual;
      if (!nonNullWhen) continue;
      for (const [key, type] of nonNullFacts(operand)) nonNullWhen.set(key, type);
    }
    addCaseNarrowing(left, right, whenEqual, whenUnequal);
    addCaseNarrowing(right, left, whenEqual, whenUnequal);
    addBooleanComparisonNarrowing(left, rightSyntax, whenEqual, whenUnequal);
    if (leftSyntax) addBooleanComparisonNarrowing(right, leftSyntax, whenEqual, whenUnequal);
    return negated ? { whenTrue: whenUnequal, whenFalse: whenEqual } : { whenTrue: whenEqual, whenFalse: whenUnequal };
  }

  /** Rejects `==` between types that can never be equal, as Kotlin's compiler does. */
  protected checkEqualityApplicable(left: Compiled, right: Compiled, row: number, operator: string): void {
    const a = nonNull(resolved(left.type));
    const b = nonNull(resolved(right.type));
    if (a.kind === 'nothing' || b.kind === 'nothing') return;
    if (isSubtype(a, b) || isSubtype(b, a)) return;
    // Values of the standard library's final value types never equal values of unrelated types, which Kotlin rejects;
    // two unrelated classes of the program only draw a warning.
    const isValueType = (type: KType): boolean =>
      this.primitiveOf(type) !== undefined ||
      this.isClass(type, this.core.boolean) ||
      this.isClass(type, this.core.string) ||
      (type.kind === 'class' && type.cls.kind === 'enum');
    if (isValueType(a) || isValueType(b)) {
      this.error(row, `演算子 ${operator} は ${typeToString(a)} と ${typeToString(b)} には使えません。`);
    }
  }

  protected compileComparison(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'binary' }>
  ): Compiled {
    const { operator, row } = expression;
    const left = this.compileExpression(scope, context, expression.left);
    const beforeRight = this.flow.copy();
    const right = this.compileExpression(scope, context, expression.right);
    const leftKind = this.primitiveOf(left.type);
    const rightKind = this.primitiveOf(right.type);
    const test = COMPARISON_TESTS[operator as '<' | '<=' | '>' | '>='];
    if (leftKind && rightKind) {
      const isChar = leftKind === 'Char' || rightKind === 'Char';
      const isUnsigned = leftKind.startsWith('U') || rightKind.startsWith('U');
      if (
        (isChar && leftKind !== rightKind) ||
        (isUnsigned && !(leftKind.startsWith('U') && rightKind.startsWith('U')))
      ) {
        this.error(
          row,
          `演算子 ${operator} は ${typeToString(resolved(left.type))} と ${typeToString(resolved(right.type))} には使えません。`
        );
      }
      const leftEval = this.convertTo(left, left.type, row);
      const rightEval = this.convertTo(right, right.type, row);
      const kind = arithmeticResult(leftKind, rightKind, '+');
      if (kind === 'Float' || kind === 'Double') {
        // Comparison operators on floating-point numbers follow IEEE 754, where NaN compares false.
        const compare = COMPARISON_IEEE[operator as '<' | '<=' | '>' | '>='];
        return {
          type: this.booleanType,
          repr: 'ref',
          eval: (frame) =>
            compare(
              Number(widen(leftEval(frame) as number | bigint, leftKind, kind)),
              Number(widen(rightEval(frame) as number | bigint, rightKind, kind))
            ),
        };
      }
      return {
        type: this.booleanType,
        repr: 'ref',
        eval: (frame) => test(compareNumbers(leftEval(frame) as number | bigint, rightEval(frame) as number | bigint)),
      };
    }
    // The compareTo call compiles the right operand again, whose writes the flow must see once.
    this.flow = beforeRight;
    const args: ArgumentSyntax[] = [{ row: expression.right.row, name: undefined, value: expression.right }];
    const compared = this.compileOperatorCall(scope, context, left, 'compareTo', args, row, operator);
    const evaluate = convertRepr(compared.eval, compared.repr, 'Int');
    return {
      type: this.booleanType,
      repr: 'ref',
      eval: (frame) => test(evaluate(frame) as number),
    };
  }

  protected compileInfix(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'infix' }>,
    expected: KType | undefined
  ): Compiled {
    if (this.isLongConstant(expression, expected))
      return this.toLongConstant(this.compileInfix(scope, context, expression, undefined));
    const { name, row } = expression;
    const left = this.compileExpression(scope, context, expression.left);
    const levels = this.syntaxCandidateLevels(left, name, row, name, 'isInfix');
    const args: ArgumentSyntax[] = [{ row: expression.right.row, name: undefined, value: expression.right }];
    const call = this.resolveCall(scope, context, levels, args, false, [], expected, left, row, name);
    return { ...this.finishCall(call, left, row), isCall: false };
  }

  protected compileIn(
    scope: Scope,
    context: FunctionContext,
    element: Expression,
    container: Expression,
    negated: boolean,
    row: number
  ): Compiled {
    const containerCompiled = this.compileExpression(scope, context, container);
    const args: ArgumentSyntax[] = [{ row: element.row, name: undefined, value: element }];
    const { call, compiled: contains } = this.resolveOperator(
      scope,
      context,
      containerCompiled,
      'contains',
      args,
      row,
      'in'
    );
    const { floatRangeBounds } = containerCompiled;
    const compareDouble =
      floatRangeBounds &&
      call.symbol.isLibrary &&
      call.symbol.packageName === 'kotlin.ranges' &&
      this.primitiveOf(call.symbol.params[0].type) === 'Double';
    const evaluate: Eval = compareDouble
      ? (frame) => {
          // Kotlin/JVM lowers membership in an immediate Float range to widening comparisons.
          const [start, end] = floatRangeBounds(frame);
          const value = call.evaluateArgs(frame)[0] as number;
          return start <= value && value <= end;
        }
      : convertRepr(contains.eval, contains.repr, 'ref');
    return {
      type: this.booleanType,
      repr: 'ref',
      eval: negated ? (frame) => !(evaluate(frame) as boolean) : evaluate,
    };
  }

  // Types.

  /**
   * The type of an `is` check, which may name type arguments only where the subject's type implies them, as
   * `iterable is Collection<T>` does for an `Iterable<T>`, since type arguments are erased at run time.
   */
  protected checkableType(scope: Scope, ref: TypeRef, row: number, subjectType: KType): KType {
    const type = this.resolveType(scope, ref, true);
    const actual = resolved(type);
    const implied =
      actual.kind === 'class'
        ? resolved(
            this.narrowedType(subjectType, {
              ...actual,
              args: actual.args.map(() => ({ variance: 'star' as const })),
            })
          )
        : undefined;
    const isImplied = implied !== undefined && isSubtype(implied, actual) && isSubtype(actual, implied);
    if (actual.kind === 'class' && !isImplied && actual.args.some((argument) => argument.variance !== 'star')) {
      this.error(
        row,
        `型引数は実行時には消えるので、${typeToString(actual)} かどうかは調べられません。* を使ってください。`
      );
    }
    if (actual.kind === 'param' && !actual.param.isReified)
      this.error(row, `型引数 ${actual.param.name} かどうかは調べられません。`);
    if (actual.kind === 'function') this.error(row, `関数の型 ${typeToString(actual)} かどうかは調べられません。`);
    const subject = resolved(subjectType);
    if (subject.kind === 'class' && actual.kind === 'class' && !canShareInstances(subject.cls, actual.cls)) {
      this.error(row, `${typeToString(nonNull(subject))} の値が ${typeToString(actual)} であることはありません。`);
    }
    return type;
  }

  /** Whether a type is a generic class written without arguments, as in `x is List`. */
  protected isBare(type: KType): boolean {
    const actual = resolved(type);
    return (
      actual.kind === 'class' && actual.args.length > 0 && actual.args.every((argument) => argument.variance === 'star')
    );
  }

  /** The type `is` narrows to: the class type with the arguments the value's static type gives it. */
  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  protected narrowedType(staticType: KType, checked: KType): KType {
    const target = resolved(checked);
    const source = nonNull(resolved(staticType));
    const keepsNull = isNullable(staticType) && isNullable(target);
    if (target.kind === 'class' && target.cls.typeParameters.length > 0 && source.kind === 'class') {
      // A subtype's arguments come from the supertype's, as `List<Int>` checked against `ArrayList<*>` gives `ArrayList<Int>`.
      const substitution = new Map<TypeParameterSymbol, KType>();
      const up = this.supertypeAs(target.cls.selfType, source.cls);
      if (up) {
        for (const [index, argument] of up.args.entries()) {
          if (argument.variance !== 'star' && argument.type.kind === 'param') {
            const sourceArg = source.args[index];
            if (sourceArg && sourceArg.variance !== 'star') substitution.set(argument.type.param, sourceArg.type);
          }
        }
        const narrowed = substitute(target.cls.selfType, substitution);
        return keepsNull ? nullable(narrowed) : narrowed;
      }
    }
    const narrower = isSubtype(source, target) ? source : nonNull(target);
    return keepsNull ? nullable(narrower) : narrower;
  }

  protected compileIs(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'is' }>
  ): Compiled {
    const operand = this.compileExpression(scope, context, expression.operand);
    const type = this.checkableType(scope, expression.type, expression.row, operand.type);
    const test = instanceTest(this.core, type);
    const evaluate = convertRepr(operand.eval, operand.repr, 'ref');
    const narrowing = this.typeTestNarrowing(operand, type);
    const exclusion = isExclusion(operand.stableKey, type);
    return {
      type: this.booleanType,
      repr: 'ref',
      eval: expression.negated ? (frame) => !test(evaluate(frame)) : (frame) => test(evaluate(frame)),
      narrowing: expression.negated
        ? { whenTrue: exclusion, whenFalse: narrowing }
        : { whenTrue: narrowing, whenFalse: exclusion },
    };
  }

  /** What passing `is type` shows: the value's type, and for a non-null type, that its safe calls' receivers are not null. */
  protected typeTestNarrowing(operand: Compiled, type: KType): Map<string, KType> {
    const narrowing = isNullable(type) ? new Map<string, KType>() : nonNullFacts(operand);
    if (operand.stableKey) narrowing.set(operand.stableKey, this.narrowedType(operand.type, type));
    return narrowing;
  }

  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  protected compileAs(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'as' }>
  ): Compiled {
    const operand = this.compileExpression(scope, context, expression.operand);
    const written = this.resolveType(scope, expression.type, true);
    const narrowed = this.isBare(written) ? this.narrowedType(operand.type, written) : written;
    const type = isNullable(written) ? nullable(narrowed) : narrowed;
    const actual = resolved(type);
    const isErased =
      (actual.kind === 'class' && actual.args.some((argument) => argument.variance !== 'star')) ||
      actual.kind === 'param';
    const checkType =
      isErased && actual.kind === 'class'
        ? {
            ...actual,
            args: actual.args.map(() => ({ variance: 'star' as const })),
          }
        : type;
    const test = actual.kind === 'param' ? () => true : instanceTest(this.core, checkType);
    const evaluate = convertRepr(operand.eval, operand.repr, 'ref');
    const resultType = expression.isSafe ? nullable(type) : type;
    const repr = reprOf(this.core, resultType);
    if (!expression.isSafe && !isNullable(actual)) this.flow.assumeNonNull(operand);
    if (operand.stableKey && !expression.isSafe)
      this.flow.narrowed.set(operand.stableKey, typeAfterCast(operand.type, type));
    const cast: Eval = expression.isSafe
      ? (frame) => {
          const value = evaluate(frame);
          return test(value) ? value : undefined;
        }
      : (frame) => {
          const value = evaluate(frame);
          if (!test(value)) throwCastFailure(frame, value, type);
          return value;
        };
    if (!expression.isSafe) return { type: resultType, repr, eval: convertRepr(cast, 'ref', repr) };
    // A non-null result of `x as? T` shows that `x` is a `T`.
    const whenNonNull = nonNullFacts(operand);
    if (operand.stableKey) whenNonNull.set(operand.stableKey, typeAfterCast(operand.type, nonNull(type)));
    return {
      type: resultType,
      repr,
      eval: convertRepr(cast, 'ref', repr),
      whenNonNull,
    };
  }
}

/**
 * `c == true` holds where `c` does and `c == false` where it does not, so they show what `c`'s branches show, as
 * `(x != null) == true` shows that `x` is not null; a non-null `c` also fails the comparison only in its other branch.
 */
function addBooleanComparisonNarrowing(
  operand: Compiled,
  literal: Expression,
  whenEqual: Map<string, KType>,
  whenUnequal: Map<string, KType>
): void {
  if (literal.kind !== 'boolean' || !operand.narrowing) return;
  const { whenTrue, whenFalse } = operand.narrowing;
  const [onEqual, onUnequal] = literal.value ? [whenTrue, whenFalse] : [whenFalse, whenTrue];
  for (const [key, type] of onEqual) whenEqual.set(key, type);
  if (isNullable(resolved(operand.type))) return;
  for (const [key, type] of onUnequal) whenUnequal.set(key, type);
}

/**
 * `a ?: false` is true only where `a` is true, and `a ?: true` false only where `a` is false, so that outcome shows
 * that `a` was not null, as `x` of `x?.isNotEmpty() ?: false` is not.
 */
function booleanElvisNarrowing(left: Compiled, fallback: Expression): Compiled['narrowing'] {
  if (fallback.kind !== 'boolean') return undefined;
  const nonNullOutcome = nonNullFacts(left);
  const outcome = fallback.value ? left.narrowing?.whenFalse : left.narrowing?.whenTrue;
  for (const [key, type] of outcome ?? []) nonNullOutcome.set(key, type);
  return fallback.value
    ? { whenTrue: new Map(), whenFalse: nonNullOutcome }
    : { whenTrue: nonNullOutcome, whenFalse: new Map() };
}

/** Whether values of the type have no identity, as a value class's and the unsigned integers' do. */
function isValueClassType(type: KType): boolean {
  const actual = resolved(type);
  return actual.kind === 'class' && (actual.cls.isValue || UNSIGNED_CLASSES.has(actual.cls.qualifiedName));
}

const UNSIGNED_CLASSES = new Set(['kotlin.UByte', 'kotlin.UShort', 'kotlin.UInt', 'kotlin.ULong']);

function typeAfterCast(operand: KType, target: KType): KType {
  const nonNullOperand = nonNull(operand);
  const nonNullTarget = nonNull(target);
  const narrowest = isSubtype(nonNullOperand, nonNullTarget) ? nonNullOperand : nonNullTarget;
  return isNullable(operand) && isNullable(target) ? nullable(narrowest) : narrowest;
}

/**
 * Whether a value can be an instance of both classes, which kotlinc requires of an `is` check: one class extends the
 * other, or a class that may have subclasses meets an interface, since a class extends at most one class.
 */
function canShareInstances(a: ClassSymbol, b: ClassSymbol): boolean {
  if (a.isSubclassOf(b) || b.isSubclassOf(a)) return true;
  if (!a.isInterface && !b.isInterface) return false;
  if (a.isInterface && b.isInterface) return true;
  const cls = a.isInterface ? b : a;
  return cls.isInheritable;
}
const COMPARISON_IEEE: Record<'<' | '<=' | '>' | '>=', (a: number, b: number) => boolean> = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
};
const COMPARISON_TESTS: Record<'<' | '<=' | '>' | '>=', (order: number) => boolean> = {
  '<': (order) => order < 0,
  '<=': (order) => order <= 0,
  '>': (order) => order > 0,
  '>=': (order) => order >= 0,
};
function Flow_merge(flows: Flow[]): Flow {
  return Flow.merge(flows);
}
/** The cases a stable value is not, when it equals an enum entry or an object and when it does not. */
function addCaseNarrowing(
  operand: Compiled,
  other: Compiled,
  whenEqual: Map<string, KType>,
  whenUnequal: Map<string, KType>
): void {
  const otherCase = caseOf(other);
  if (!operand.stableKey || !otherCase) return;
  for (const [key, type] of excludingCases(operand.stableKey, otherCase.others)) whenEqual.set(key, type);
  for (const [key, type] of excludingCases(operand.stableKey, [otherCase.id])) whenUnequal.set(key, type);
}

/** That a stable value is not of a class, which `is` gives when it is false, for a `when` to skip that case. */
export function isExclusion(key: string | undefined, type: KType): Map<string, KType> {
  const actual = resolved(type);
  return key && actual.kind === 'class' ? excludingCases(key, [`class:${keyOf(actual.cls)}`]) : new Map();
}

/** The methods of the integer types that kotlinc evaluates on constants, as it does the operators. */
const CONSTANT_BINARY_METHODS = new Set([
  'plus',
  'minus',
  'times',
  'div',
  'rem',
  'and',
  'or',
  'xor',
  'shl',
  'shr',
  'ushr',
]);
const CONSTANT_UNARY_METHODS = new Set(['unaryMinus', 'unaryPlus', 'inv']);

function isConstantMethodCall(call: CallExpression): boolean {
  const { callee, args } = call;
  if (callee.kind !== 'member' || callee.isSafe || call.typeArgs.length > 0 || call.trailingLambda) return false;
  if (!isIntegerConstant(callee.receiver) || args.some((arg) => arg.name !== undefined || arg.isSpread)) return false;
  if (args.length === 0) return CONSTANT_UNARY_METHODS.has(callee.name);
  return args.length === 1 && CONSTANT_BINARY_METHODS.has(callee.name) && isIntegerConstant(args[0].value);
}

function isIntegerConstant(expression: Expression): boolean {
  switch (expression.kind) {
    case 'integer': {
      return expression.suffix === '' || expression.suffix === 'L';
    }
    case 'prefix': {
      return (expression.operator === '-' || expression.operator === '+') && isIntegerConstant(expression.operand);
    }
    case 'binary': {
      return (
        expression.operator in NUMBER_OPERATOR_NAMES &&
        isIntegerConstant(expression.left) &&
        isIntegerConstant(expression.right)
      );
    }
    case 'infix': {
      return (
        CONSTANT_BINARY_METHODS.has(expression.name) &&
        isIntegerConstant(expression.left) &&
        isIntegerConstant(expression.right)
      );
    }
    case 'call': {
      return isConstantMethodCall(expression);
    }
    default: {
      return false;
    }
  }
}
function referenceEquality(
  left: Eval,
  right: Eval,
  compare: (frame: Frame, a: Value, b: Value) => boolean
): (frame: Frame) => boolean {
  return (frame) => {
    const a = left(frame);
    const operands: Value[] = [a];
    return frame.runtime.withNativeRoots([operands], () => {
      const b = right(frame);
      operands.push(b);
      return compare(frame, a, b);
    });
  };
}

function sameReference(_frame: Frame, a: Value, b: Value): boolean {
  return a === b || isSameCachedBox(a, b);
}

/**
 * Whether two boxes are the same object on the JVM, whose `valueOf` caches the boxes of small integers and characters,
 * so that `===` of two `Int?` holding 127 is true and of two holding 1000 is false.
 */
function isSameCachedBox(a: Value, b: Value): boolean {
  if (!(a instanceof Boxed) || !(b instanceof Boxed) || a.kind !== b.kind || a.value !== b.value) return false;
  const value = Number(a.value);
  if (a.kind === 'Char') return value <= 127;
  return ['Int', 'Long', 'Short', 'Byte'].includes(a.kind) && value >= -128 && value <= 127;
}
function unboxNumber(value: Value): number | bigint {
  return value instanceof Boxed ? value.value : (value as number | bigint);
}
