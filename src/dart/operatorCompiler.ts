// code-gauge-allow-file fileNcss -- The operators, conditionals and cascades share the operand and branch staging.
import type { Arguments as ArgumentsSyntax, CascadeSection, Expression, Span } from './ast';
import { at, type Compiled, type Eval, typeName } from './compilerBase';
import { branchesType, childContext } from './contextTypes';
import { ExpressionCompiler, SHORTED, singleArgument } from './expressionCompiler';
import {
  BITWISE_OPERATORS,
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
import { type ConditionFlow, Flow } from './scope';
import {
  coreTypes,
  type DartType,
  DYNAMIC,
  factorType,
  interfaceType,
  isNeverType,
  isNonNullable,
  isPotentiallyNullable,
  isSubtype,
  makeNullable,
  NEVER,
  nonNullable,
  numericClassOf,
  objectType,
  promotionTarget,
  resolveBound,
  sameType,
  upperBound,
  vmTypeString,
} from './types';
import { Cell, type Value } from './values';

/** Operators, conditionals, casts, throws, and cascades. */
export abstract class OperatorCompiler extends ExpressionCompiler {
  // code-gauge-allow functionCognitiveComplexity -- Each branch is one of the cases Dart distinguishes for this construct.
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
    const value = operand.kind === 'super' ? this.superReceiver(operand) : this.compileOperatorReceiver(operand);
    if (value.extensionOverride) return this.compileOperatorCall(value, methodName, [], expression);
    const numeric = numericClassOf(value.type);
    if (numeric) {
      const { run } = value;
      if (operator === '~' && numeric !== 'int')
        this.error(expression, `${typeName(value.type)} 型には ~ 演算子がありません。`);
      const constValue = value.constValue ? { value: negate(value.constValue.value, operator) } : undefined;
      return {
        type: interfaceType(
          numeric === 'int' ? coreTypes.int : numeric === 'double' ? coreTypes.double : coreTypes.num
        ),
        run: prefixEvaluation(run, operator, methodName, expression.row),
        isConst: value.isConst,
        constValue,
      };
    }
    if (value.type.kind === 'dynamic') {
      return { type: DYNAMIC, run: prefixEvaluation(value.run, operator, methodName, expression.row), isConst: false };
    }
    return this.compileOperatorCall(value, methodName, [], expression);
  }

  protected compileNullAssert(expression: Extract<Expression, { kind: 'nullAssert' }>): Compiled {
    const value = this.rejectExtensionApplication(this.compileReceiver(expression.operand), expression);
    const { run } = value;
    // After `x!` completes, x is known not to be null.
    if (value.variable && this.isPromotable(value.variable)) {
      const current = this.promotedType(value.variable);
      const nonNull = assertedNonNullable(current);
      if (!sameType(nonNull, current)) this.flow = this.flow.promote(value.variable, nonNull);
    }
    return {
      type: assertedNonNullable(value.type),
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
      expression.left.kind === 'super'
        ? this.superReceiver(expression.left)
        : this.compileOperatorReceiver(expression.left);
    return this.compileBinaryWithLeft(left, operator, expression.right, expression, context);
  }

  protected compileSuperEquality(expression: Extract<Expression, { kind: 'binary' }>): Compiled {
    const call = this.compileOperatorCall(this.superReceiver(expression.left), '==', [expression.right], expression);
    const { run } = call;
    const negated = expression.operator === '!=';
    return { ...call, run: (frame) => (run(frame) === true) !== negated };
  }

  /** Compiles `left op right` once the left operand is compiled, as compound assignments need. */
  // code-gauge-allow functionCognitiveComplexity -- The typing rules of numbers, strings, dynamic, and operator methods.
  // code-gauge-allow functionNcss -- The typing rules of numbers, strings, dynamic, and operator methods.
  protected compileBinaryWithLeft(
    left: Compiled,
    operator: string,
    rightSyntax: Expression,
    span: Span,
    context: DartType | undefined
  ): Compiled {
    const expression = { ...at(span), right: rightSyntax };
    if (left.type.kind === 'void') this.error(expression, 'void の値には演算子を使えません。');
    // An explicit extension application calls the extension's operator, never the receiver type's own.
    if (left.extensionOverride) return this.compileOperatorCall(left, operator, [rightSyntax], span);
    const leftNumeric = numericClassOf(left.type);
    if (leftNumeric) {
      const right = this.compileExpression(
        expression.right,
        childContext({ kind: 'numericOperand', operator, left: leftNumeric }, context)
      );
      return this.numericOperator(operator, left, right, leftNumeric, span);
    }
    if (left.type.kind === 'dynamic') {
      const right = this.compileExpression(expression.right);
      if (right.type.kind === 'void') this.error(rightSyntax, 'void の値には演算子を使えません。');
      const leftRun = left.run;
      const rightRun = right.run;
      return {
        type: DYNAMIC,
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
      const leftText = left.constValue?.value;
      const rightText = right.constValue?.value;
      const folded =
        typeof leftText === 'string' && typeof rightText === 'string'
          ? this.foldConstantString([leftText, rightText])
          : undefined;
      return {
        type: interfaceType(coreTypes.string),
        run: stringAddition(left.run, right.run, right.type.kind === 'dynamic', span.row),
        isConst: left.isConst && right.isConst,
        constValue: folded === undefined ? undefined : { value: folded },
      };
    }
    return this.compileOperatorCall(left, operator, [expression.right], span);
  }

  /** Calls an operator method of the left operand's class, checking the operand against its parameter. */
  protected compileOperatorCall(left: Compiled, operator: string, rightSyntax: Expression[], span: Span): Compiled {
    const args: ArgumentsSyntax = {
      positional: rightSyntax,
      named: [],
      order: rightSyntax.map((_, index) => ({ kind: 'positional' as const, index })),
      ...at(span),
    };
    if (isNeverType(left.type)) return this.compileMethodCall(left, operator, args, undefined, span, undefined, false);
    const resolved = this.memberFor(left, left.type, operator, span);
    if (
      isPotentiallyNullable(left.type) &&
      left.type.kind !== 'dynamic' &&
      (!resolved || !this.acceptsNull(resolved))
    ) {
      this.error(
        span,
        `${typeName(left.type)} 型の値は null かもしれないので、演算子 ${operator === 'unary-' ? '-' : operator} を直接は使えません。`
      );
    }
    if (!resolved || resolved.member.kind !== 'method') {
      return this.error(
        span,
        `${typeName(left.type)} 型には演算子 ${operator === 'unary-' ? '-' : operator} がありません。`
      );
    }
    return this.compileMethodCall(left, operator, args, undefined, span, undefined, false);
  }

  // code-gauge-allow functionCognitiveComplexity -- The typing rules of num's operators.
  // code-gauge-allow functionNcss -- The typing rules of num's operators.
  private numericOperator(
    operator: string,
    left: Compiled,
    right: Compiled,
    leftNumeric: 'int' | 'double' | 'num',
    span: Span
  ): Compiled {
    const rightNumeric = numericClassOf(right.type);
    const isComparison = ['<', '<=', '>', '>='].includes(operator);
    const isBitwise = BITWISE_OPERATORS.has(operator);
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
    else if (leftNumeric === 'double' || rightNumeric === 'double') resultType = interfaceType(coreTypes.double);
    else if (leftNumeric === 'int' && rightNumeric === 'int') resultType = interfaceType(coreTypes.int);
    else resultType = interfaceType(coreTypes.num);
    const leftValue = left.constValue?.value;
    const rightValue = right.constValue?.value;
    const constValue =
      isNumber(leftValue) && isNumber(rightValue)
        ? safeConstant(() => numericBinaryConstant(operator, leftValue, rightValue))
        : undefined;
    return {
      type: resultType,
      run: numericEvaluation(left.run, right.run, operator, span.row, [leftNumeric, rightNumeric]),
      isConst: left.isConst && right.isConst,
      constValue,
    };
  }

  /**
   * The non-null part of `??`'s left operand: NonNull of its type, except for a `T` a type test split off a `T?`
   * (`is! Null`), which the SDK keeps as `T`, potentially nullable through a nullable bound, instead of promoting it to
   * the bound's non-null part.
   */
  private ifNullLeftType(left: Compiled): DartType {
    const { type } = left;
    const isSplit = type.kind === 'typeParam' && type.splitFromNullable === true && type.promoted === undefined;
    return isSplit ? type : nonNullable(type);
  }

  private compileIfNull(expression: Extract<Expression, { kind: 'binary' }>, context: DartType | undefined): Compiled {
    const left = this.compileExpression(expression.left, context ? makeNullable(context) : undefined);
    const { whenNull, whenNonNull } = this.nullBranches(left);
    this.flow = whenNull;
    const leftRun = this.decidingValue(left, expression.right).run;
    const rightContext = context ?? nonNullable(left.type);
    // The right operand runs only when the left is null, so its awaits are guarded by it.
    const right = this.compileGuarded(
      (frame) => leftRun(frame) === undefined,
      expression.right,
      () => this.instantiateInContext(this.compileExpression(expression.right, rightContext), rightContext)
    );
    this.flow = Flow.join(whenNonNull, this.flow);
    const rightRun = right.run;
    const nonNullLeft = left.type.kind === 'dynamic' ? DYNAMIC : this.ifNullLeftType(left);
    const type = branchesType(upperBound(nonNullLeft, right.type), [nonNullLeft, right.type], context);
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
    const branches = [expression.consequent, expression.alternative];
    // Only one branch runs, so the awaits of each are guarded by the condition, which is evaluated once before them.
    const conditionRun = this.decidingValue(condition, branches).run;
    this.flow = flow.whenTrue;
    const then = this.compileGuarded(
      (frame) => conditionRun(frame) === true,
      expression.consequent,
      () => this.instantiateInContext(this.compileExpression(expression.consequent, context), context)
    );
    const afterThen = this.flow;
    this.flow = flow.whenFalse;
    const otherwise = this.compileGuarded(
      (frame) => conditionRun(frame) !== true,
      expression.alternative,
      () => this.instantiateInContext(this.compileExpression(expression.alternative, context), context)
    );
    this.flow = Flow.join(afterThen, this.flow);
    const bound =
      then.type.kind === 'never' && !then.type.nullable
        ? otherwise.type
        : otherwise.type.kind === 'never' && !otherwise.type.nullable
          ? then.type
          : upperBound(then.type, otherwise.type);
    const type = branchesType(bound, [then.type, otherwise.type], context);
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

  protected compileIs(expression: Extract<Expression, { kind: 'is' }>): { compiled: Compiled; flow: ConditionFlow } {
    const value = this.compileExpression(expression.value);
    if (value.type.kind === 'void') this.error(expression.value, 'void の値は、式の中では使えません。');
    const type = this.resolveType(expression.type);
    const resolve = this.runtimeType(type);
    const { run } = value;
    const { variable } = value;
    let tested = variable ? this.flow.rememberTypeTest(variable, type) : this.flow;
    let promoted = tested;
    if (variable && this.isPromotable(variable)) {
      const current = this.promotedType(variable);
      const narrowed = promotionTarget(current, type);
      if (narrowed) promoted = tested.promote(variable, narrowed);
      // A failed test removes the tested type from a union, as `FutureOr<T>` without `Future<T>` is `T`.
      const remaining = factorType(current, type);
      if (!sameType(remaining, current) && isSubtype(remaining, current) && !isNeverType(remaining)) {
        tested = tested.promote(variable, remaining);
      }
    }
    // A test the static type already decides leaves its other branch unreachable.
    if (isSubtype(value.type, type)) tested = tested.unreachable;
    else if (isNeverType(type) || (type.kind === 'null' && isNonNullable(value.type))) promoted = promoted.unreachable;
    const { negated } = expression;
    return {
      compiled: {
        type: interfaceType(coreTypes.bool),
        run: (frame) => {
          const result = this.valueIsAt(frame, run(frame), resolve(frame));
          return result !== negated;
        },
        isConst: value.isConst && !this.usesLexicalTypeVariables(type),
      },
      flow: negated ? { whenTrue: tested, whenFalse: promoted } : { whenTrue: promoted, whenFalse: tested },
    };
  }

  protected compileAs(expression: Extract<Expression, { kind: 'as' }>): Compiled {
    const value = this.compileExpression(expression.value);
    const type = this.resolveType(expression.type);
    let { flow } = this;
    const { variable } = value;
    if (variable && this.isPromotable(variable)) {
      flow = flow.rememberTypeTest(variable, type);
      const narrowed = promotionTarget(this.promotedType(variable), type);
      if (narrowed) flow = flow.promote(variable, narrowed);
    }
    this.flow = flow;
    return {
      type,
      run: this.runtimeCast(value.run, type, true),
      isConst: value.isConst && !this.usesLexicalTypeVariables(type),
    };
  }

  protected compileThrow(expression: Extract<Expression, { kind: 'throw' }>): Compiled {
    const value = this.compileExpression(expression.value);
    if (value.type.kind === 'void') this.error(expression, 'void の値は throw できません。');
    // Dart throws only dynamic values and Object's subtypes, which excludes extension types that implement no Object.
    if (!isSubtype(value.type, objectType()) && value.type.kind !== 'dynamic') {
      this.error(
        expression,
        `${typeName(value.type)} 型の値は、dynamic でも null にならない型でもないので throw できません。`
      );
    }
    const { run } = value;
    this.flow = this.flow.unreachable;
    return {
      type: NEVER,
      run: (frame) => {
        const thrown = run(frame);
        if (thrown === undefined) frame.runtime.throwTypeError("type 'Null' is not a subtype of type 'Object'");
        throw frame.runtime.newThrow(thrown);
      },
      isConst: false,
    };
  }

  protected compileCascade(
    expression: Extract<Expression, { kind: 'cascade' }>,
    context: DartType | undefined
  ): Compiled {
    const awaits = this.awaitsHere(expression.sections);
    const target = this.decidingValue(this.compileExpression(expression.target, context), expression.sections);
    const slot = this.fn.allocateSlot();
    this.fn.info.locals[slot] = { name: '\0', type: target.type };
    const nullAware = expression.sections[0]?.nullAware ?? false;
    this.skipOnNull(target, nullAware);
    const receiver: Compiled = {
      type: nullAware ? nonNullable(target.type) : target.type,
      run: (frame) => (frame.locals[slot] as Cell).v,
      isConst: false,
    };
    const targetRun = target.run;
    const isShorted = (frame: Frame): boolean => nullAware && targetRun(frame) === undefined;
    // When a section awaits, the receiver and every section are ordered parts, each section guarded by a null-aware
    // cascade's receiver, so that a section runs before the awaits of the sections after it.
    if (awaits) {
      this.addStep((frame) => {
        frame.locals[slot] = new Cell(targetRun(frame));
        return;
      });
    }
    const sections = expression.sections.map((section) =>
      this.compileGuarded(
        (frame) => !isShorted(frame),
        section,
        () => {
          const compiled = this.compileNullChain(() => this.compileCascadeSection(receiver, section)).result;
          return awaits ? this.stagePart(compiled) : compiled;
        }
      )
    );
    if (awaits) {
      return {
        type: target.type,
        run: (frame) => {
          frame.locals[slot] = undefined;
          return isShorted(frame) ? undefined : targetRun(frame);
        },
        isConst: false,
      };
    }
    return { type: target.type, run: cascadeRun(targetRun, slot, nullAware, sections), isConst: false };
  }

  // code-gauge-allow functionCognitiveComplexity -- Each branch is one of the cases Dart distinguishes for this construct.
  // code-gauge-allow functionNcss -- One case per form of the construct, which reads best together.
  private compileCascadeSection(receiver: Compiled, section: CascadeSection): Compiled {
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
            type: assertedNonNullable(current.type),
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
      // What a selector gives is lifted before an await later in the section, as the SDK evaluates it first.
      current = this.liftBeforeLaterAwait(current, selector);
    }
    if (assignment && last) {
      return this.compileAssignmentTo(current, last, assignment.operator, assignment.value, span);
    }
    return current;
  }
}

const INTEGER_OPERAND_METHODS = new Map([
  ['+', '_addFromInteger'],
  ['-', '_subFromInteger'],
  ['*', '_mulFromInteger'],
  ['~/', '_truncDivFromInteger'],
  ['%', '_moduloFromInteger'],
  ['>', '_greaterThanFromInteger'],
  ['>=', '_greaterThanFromInteger'],
  ['&', '_bitAndFromInteger'],
  ['|', '_bitOrFromInteger'],
  ['^', '_bitXorFromInteger'],
  ['<<', '_shlFromInteger'],
  ['>>', '_shrFromInteger'],
  ['>>>', '_ushrFromInteger'],
]);

/** A cascade that does not await: its receiver in its slot while each section runs on it in turn. */
function cascadeRun(targetRun: Eval, slot: number, nullAware: boolean, sections: readonly Compiled[]): Eval {
  return (frame) => {
    const value = targetRun(frame);
    if (nullAware && value === undefined) return;
    const previous = frame.locals[slot];
    frame.locals[slot] = new Cell(value);
    try {
      for (const section of sections) section.run(frame);
    } finally {
      frame.locals[slot] = previous;
    }
    return value;
  };
}

function assertedNonNullable(type: DartType): DartType {
  const bound = resolveBound(type);
  return bound.kind === 'null' || isNeverType(bound) ? NEVER : nonNullable(type);
}

function stringAddition(left: Eval, right: Eval, dynamicArgument: boolean, row: number): Eval {
  return (frame) => {
    const a = left(frame);
    const b = right(frame);
    if (dynamicArgument && typeof b !== 'string') return primitiveCastError(frame.runtime, b, 'String');
    if (typeof a === 'string' && b === undefined) return frame.runtime.throwError('ArgumentError', '', []);
    return dynamicBinary(frame.runtime, '+', a, b, row);
  };
}

// code-gauge-allow functionCognitiveComplexity -- Typed fast paths, implicit casts and SDK null dispatch have distinct semantics.
function numericEvaluation(
  left: Eval,
  right: Eval,
  operator: string,
  row: number,
  [leftClass, rightClass]: readonly [ReturnType<typeof numericClassOf>, ReturnType<typeof numericClassOf>]
): Eval {
  const ints = leftClass === 'int' && rightClass === 'int' ? intOperation(operator) : undefined;
  const doubles = leftClass === 'double' && rightClass === 'double' ? doubleOperation(operator) : undefined;
  const argumentType = rightClass === undefined ? (BITWISE_OPERATORS.has(operator) ? 'int' : 'num') : undefined;
  return (frame) => {
    const a = left(frame);
    const b = right(frame);
    if (ints && typeof a === 'bigint' && typeof b === 'bigint') return ints(frame, a, b);
    if (doubles && typeof a === 'number' && typeof b === 'number') return doubles(frame, a, b);
    if (argumentType && (argumentType === 'int' ? typeof b !== 'bigint' : !isNumber(b))) {
      return primitiveCastError(frame.runtime, b, argumentType);
    }
    if (b === undefined && isNumber(a)) return nullNumericArgument(frame.runtime, operator, a);
    return dynamicBinary(frame.runtime, operator, a, b, row);
  };
}

function nullNumericArgument(runtime: Runtime, operator: string, receiver: bigint | number): Value {
  const method =
    operator === '<' || operator === '<='
      ? '>'
      : ((typeof receiver === 'bigint' ? INTEGER_OPERAND_METHODS.get(operator) : undefined) ?? 'toDouble');
  const positional = method === 'toDouble' ? [] : [receiver];
  return runtime.noSuchMethod(undefined, method, 'method', { positional, named: undefined });
}

function primitiveCastError(runtime: Runtime, value: Value, type: string): never {
  return runtime.throwTypeError(
    `type '${vmTypeString(runtime.runtimeTypeOf(value))}' is not a subtype of type '${type}'`
  );
}

// code-gauge-allow duplicateLines -- Each function handles its own construct; the shared shape reads better than a helper with flags.
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

// code-gauge-allow duplicateLines -- Each function handles its own construct; the shared shape reads better than a helper with flags.
// code-gauge-allow functionNcss -- One case per form of the construct, which reads best together.
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

function prefixEvaluation(run: Eval, operator: '-' | '~', methodName: string, row: number): Eval {
  return (frame) => {
    const operand = run(frame);
    if (typeof operand === 'bigint' || (operator === '-' && typeof operand === 'number'))
      return negate(operand, operator);
    return frame.runtime.invoke(
      operand,
      methodName,
      { positional: [], named: undefined, invocation: 'dynamic' },
      [],
      row
    );
  };
}
