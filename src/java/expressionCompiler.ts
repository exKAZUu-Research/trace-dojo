import type { ArrayInitializer, BinaryOperator, Expression, PatternBinding, Span } from './ast';
import { classObjectOf } from './builtins';
import { box, boxedTypeOf, unbox } from './builtinWrappers';
import {
  type Compiled,
  type CompiledValue,
  constantValue,
  type Eval,
  type MethodContext,
  type Reference,
  type Scope,
} from './compilerBase';
import { unboxedTypeOf } from './conversions';
import { binaryOperation, castOperation, conditionalType, unaryOperation } from './operators';
import { bindingsWhen } from './patternBindings';
import { booleanConstants } from './reachability';
import { ReferenceCompiler, thisValue } from './referenceCompiler';
import { type Frame } from './runtime';
import {
  BOOLEAN,
  CHAR,
  type ClassInfo,
  DOUBLE,
  FLOAT,
  INT,
  isCastable,
  isNumeric,
  isPrimitive,
  isReference,
  isWidening,
  type JavaType,
  LONG,
  NULL,
  sameType,
  typeName,
  VOID,
} from './types';
import {
  charToString,
  defaultValue,
  formatDouble,
  formatFloat,
  JavaArray,
  JavaString,
  toInt32,
  type Value,
} from './values';

/** Type-checks expressions and compiles them into closures. */
export abstract class ExpressionCompiler extends ReferenceCompiler {
  protected abstract compileNew(context: MethodContext, expression: Extract<Expression, { kind: 'new' }>): Compiled;

  protected abstract compileCall(context: MethodContext, expression: Extract<Expression, { kind: 'call' }>): Compiled;

  protected compileCondition(context: MethodContext, expression: Expression): (frame: Frame) => boolean {
    const value = this.operand(this.compileValue(context, expression));
    if (value.type.kind !== 'boolean') {
      this.error(expression, `条件には boolean 型の式が必要ですが、${typeName(value.type)} 型の式が書かれています。`);
    }
    return value.run as (frame: Frame) => boolean;
  }

  protected compileValue(context: MethodContext, expression: Expression, allowsVoid = false): CompiledValue {
    const compiled = this.compileExpression(context, expression);
    if (compiled.kind === 'class') {
      this.error(expression, `${compiled.cls.name} は値として使えません。`);
    }
    if (compiled.type.kind === 'void' && !allowsVoid) {
      this.error(expression, '戻り値のないメソッドの呼び出しは値として使えません。');
    }
    return compiled;
  }

  protected compileInitializer(
    context: MethodContext,
    initializer: Expression | ArrayInitializer,
    type: JavaType
  ): Eval {
    if (initializer.kind === 'arrayInitializer') return this.compileArrayInitializer(context, initializer, type);
    return this.convert(this.compileValueFor(context, initializer, type), type, 'assignment', initializer).run;
  }

  protected compileArrayInitializer(context: MethodContext, initializer: ArrayInitializer, type: JavaType): Eval {
    if (type.kind !== 'array') this.error(initializer, '配列ではない変数を { } で初期化することはできません。');
    const elementType = type.element;
    const elements = initializer.elements.map((element) => this.compileInitializer(context, element, elementType));
    return (frame) => {
      frame.runtime.allocateArray(frame, elements.length);
      const values: Value[] = [];
      try {
        for (const element of elements) {
          const value = element(frame);
          values.push(value);
          frame.temporaries.push(value);
        }
      } finally {
        frame.temporaries.length -= values.length;
      }
      return new JavaArray(elementType, values);
    };
  }

  protected compileExpression(context: MethodContext, expression: Expression): Compiled {
    const compiled = this.compileExpressionBody(context, expression);
    if (compiled.kind === 'value' && typeof compiled.constant === 'boolean') {
      booleanConstants.set(expression, compiled.constant);
    }
    return compiled;
  }

  // code-gauge-allow functionNcss 46 -- One case per expression kind, each delegating to its own compiler.
  protected compileExpressionBody(context: MethodContext, expression: Expression): Compiled {
    switch (expression.kind) {
      case 'literal': {
        return this.compileLiteral(expression);
      }
      case 'name': {
        return this.compileName(context, expression);
      }
      case 'this': {
        return this.compileThis(context, expression);
      }
      case 'fieldAccess': {
        return readOf(this.compileFieldReference(context, expression));
      }
      case 'arrayAccess': {
        return readOf(this.compileReference(context, expression));
      }
      case 'call': {
        return this.compileCall(context, expression);
      }
      case 'new': {
        return this.compileNew(context, expression);
      }
      case 'newArray': {
        return this.compileNewArray(context, expression);
      }
      case 'assign': {
        return this.compileAssignment(context, expression);
      }
      case 'update': {
        return this.compileUpdate(context, expression);
      }
      case 'binary': {
        return this.compileBinary(context, expression);
      }
      case 'unary': {
        return this.compileUnary(context, expression);
      }
      case 'conditional': {
        return this.compileConditional(context, expression);
      }
      case 'cast': {
        return this.compileCast(context, expression);
      }
      case 'instanceOf': {
        return this.compileInstanceOf(context, expression);
      }
      case 'switchExpression': {
        return this.compileSwitchExpression(context, expression);
      }
      case 'lambda':
      case 'methodRef': {
        return this.compileFunctionalExpression(context, expression);
      }
      case 'classLiteral':
      case 'typeRef': {
        return this.compileTypeExpression(expression);
      }
    }
  }

  protected compileThis(context: MethodContext, expression: Extract<Expression, { kind: 'this' }>): Compiled {
    if (context.isStatic) this.error(expression, 'static メソッドの中では this を使えません。');
    if (!expression.qualifier) return thisValue(context);
    const qualifier = this.resolveType(expression.qualifier);
    const outer = qualifier.kind === 'class' ? this.outerInstanceValue(context, qualifier.cls, true) : undefined;
    if (!outer) return this.error(expression, `ここでは ${typeName(qualifier)}.this を使えません。`);
    return outer;
  }

  /** A lambda or a method reference, which only the type it is assigned to can give a functional interface. */
  protected compileFunctionalExpression(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'lambda' | 'methodRef' }>
  ): Compiled {
    const target = this.takeTargetType();
    if (!target) {
      const what = expression.kind === 'lambda' ? 'ラムダ式' : 'メソッド参照';
      return this.error(expression, `${what}は、変数への代入やメソッドの引数など、型が決まる場所にしか書けません。`);
    }
    return this.compileFunctional(context, expression, target);
  }

  /** `Type.class`, or a class named for a method reference's expansion. */
  protected compileTypeExpression(expression: Extract<Expression, { kind: 'classLiteral' | 'typeRef' }>): Compiled {
    const type = this.resolveType(expression.type);
    if (type.kind !== 'class') {
      return this.error(
        expression,
        expression.kind === 'classLiteral'
          ? 'この採点環境では、クラスと列挙型とインターフェースにしか .class を使えません。'
          : `${typeName(type)} は値として使えません。`
      );
    }
    if (expression.kind === 'typeRef') return { kind: 'class', cls: type.cls };
    const classClass = this.builtins.classes.get('Class') as ClassInfo;
    const object = classObjectOf(type.cls, classClass);
    return { kind: 'value', type: classClass.type, run: () => object };
  }

  /** Compiles a lambda or a method reference into an object of the functional interface `target`. */
  protected abstract compileFunctional(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'lambda' | 'methodRef' }>,
    target: JavaType
  ): CompiledValue;

  protected abstract compileSwitchExpression(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'switchExpression' }>
  ): Compiled;

  protected compileInstanceOf(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'instanceOf' }>
  ): Compiled {
    const value = this.compileValue(context, expression.value);
    const type = this.resolveType(expression.type);
    if (type.kind !== 'class' && type.kind !== 'array') {
      this.error(expression.type, 'instanceof ではクラス型か配列型しか使えません。');
    }
    if (!isReference(value.type) || !isCastable(value.type, type, this.builtins.objectClass)) {
      this.error(expression, `${typeName(value.type)} 型の値は ${typeName(type)} 型になりえません。`);
    }
    const test = (frame: Frame, tested: Value): boolean =>
      type.kind === 'class'
        ? frame.runtime.isInstance(tested, type.cls)
        : tested instanceof JavaArray &&
          isWidening({ kind: 'array', element: tested.elementType }, type, this.builtins.objectClass);
    const { binding } = expression;
    if (!binding) return { kind: 'value', type: BOOLEAN, run: (frame) => test(frame, value.run(frame)) };
    const slot = context.locals.length;
    context.locals.push({ name: binding.name, type });
    context.patternSlots.push(slot);
    this.bindingSlots.set(binding, slot);
    return {
      kind: 'value',
      type: BOOLEAN,
      run: (frame) => {
        const tested = value.run(frame);
        if (!test(frame, tested)) return false;
        frame.locals[slot] = tested;
        return true;
      },
    };
  }

  /** Compiles code in a scope where the pattern variables `bindings` are in scope. */
  protected withBindings<T>(context: MethodContext, bindings: readonly PatternBinding[], compile: () => T): T {
    if (bindings.length === 0) return compile();
    context.scopes.push({ names: new Map(), slots: [] });
    try {
      this.introduceBindings(context, bindings, false);
      return compile();
    } finally {
      context.scopes.pop();
    }
  }

  /**
   * Brings pattern variables into the innermost scope, where they stay until it ends.
   *
   * @param outlivesStatement Whether the variables stay in scope after the statement that declares them, as those of
   *   an `if` whose branch cannot complete normally do, so that the statement leaves their slots assigned.
   */
  protected introduceBindings(
    context: MethodContext,
    bindings: readonly PatternBinding[],
    outlivesStatement = true
  ): void {
    const scope = context.scopes.at(-1) as Scope;
    for (const binding of bindings) {
      if (this.findLocal(context, binding.name) !== undefined) {
        this.error(binding, `変数 ${binding.name} はすでに定義されています。`);
      }
      const slot = this.bindingSlots.get(binding) as number;
      scope.names.set(binding.name, slot);
      scope.slots.push(slot);
      if (outlivesStatement) context.introducedPatternSlots.add(slot);
    }
  }

  protected compileLiteral(expression: Extract<Expression, { kind: 'literal' }>): Compiled {
    const { literal } = expression;
    switch (literal.type) {
      case 'int': {
        if (literal.value > 2_147_483_647)
          this.error(expression, `整数 ${literal.value} が int 型の範囲を超えています。`);
        return constantValue(INT, literal.value);
      }
      case 'long': {
        if (literal.value > 9_223_372_036_854_775_807n)
          this.error(expression, `整数 ${literal.value} が long 型の範囲を超えています。`);
        return constantValue(LONG, literal.value);
      }
      case 'float': {
        return constantValue(FLOAT, literal.value);
      }
      case 'double': {
        return constantValue(DOUBLE, literal.value);
      }
      case 'char': {
        return constantValue(CHAR, literal.value);
      }
      case 'boolean': {
        return constantValue(BOOLEAN, literal.value);
      }
      case 'string': {
        return constantValue(this.builtins.stringClass.type, this.internedString(literal.value));
      }
      case 'null': {
        return { kind: 'value', type: NULL, run: () => {} };
      }
    }
  }

  protected compileAssignment(context: MethodContext, expression: Extract<Expression, { kind: 'assign' }>): Compiled {
    const reference = this.compileReference(context, expression.target);
    this.checkAssignable(context, expression.target, reference);
    const { bind, type } = reference;
    const value =
      expression.operator === '='
        ? this.compileValueFor(context, expression.value, type)
        : this.compileValue(context, expression.value);
    if (expression.operator === '=') {
      const converted = this.convert(value, type, 'assignment', expression.value).run;
      return {
        kind: 'value',
        type,
        run: (frame) => {
          const target = bind(frame);
          const result = converted(frame);
          target.set(result);
          return result;
        },
      };
    }
    const operator = expression.operator.slice(0, -1) as BinaryOperator;
    // A wrapper variable is unboxed for the operation and its result boxed again, except for string concatenation.
    const isStringTarget = type.kind === 'class' && type.cls === this.builtins.stringClass;
    const { unbox: unboxTarget, rebox, primitiveType } = this.wrapperAccess(isStringTarget ? undefined : type);
    const right = isStringTarget ? value : this.operand(value);
    const operation = this.binaryOperation(expression, operator, primitiveType, right.type);
    const narrow = this.castOperation(operation.type, primitiveType, expression);
    return {
      kind: 'value',
      type,
      run: (frame) => {
        const target = bind(frame);
        const left = unboxTarget(frame, target.get());
        frame.temporaries.push(left);
        let rightValue: Value;
        try {
          rightValue = right.run(frame);
        } finally {
          frame.temporaries.pop();
        }
        const result = rebox(frame, narrow(frame, operation.apply(frame, left, rightValue)));
        target.set(result);
        return result;
      },
    };
  }

  protected compileUpdate(context: MethodContext, expression: Extract<Expression, { kind: 'update' }>): Compiled {
    const reference = this.compileReference(context, expression.target);
    this.checkAssignable(context, expression.target, reference);
    const { type, bind } = reference;
    const { unbox: unboxTarget, rebox, primitiveType } = this.wrapperAccess(type);
    if (!isNumeric(primitiveType)) {
      this.error(expression, `${typeName(type)} 型の変数には ${expression.operator} を使えません。`);
    }
    const { kind } = primitiveType;
    const delta = expression.operator === '++' ? 1 : -1;
    const operation = this.binaryOperation(expression, expression.operator === '++' ? '+' : '-', primitiveType, INT);
    const narrow = this.castOperation(operation.type, primitiveType, expression);
    const isPrefix = expression.isPrefix;
    return {
      kind: 'value',
      type,
      run: (frame) => {
        const target = bind(frame);
        const stored = target.get();
        const before = unboxTarget(frame, stored);
        const after = rebox(
          frame,
          kind === 'int' ? toInt32((before as number) + delta) : narrow(frame, operation.apply(frame, before, 1))
        );
        target.set(after);
        return isPrefix ? after : stored;
      },
    };
  }

  /** How an operator reads and writes a variable of `type`: through unboxing and boxing when it is a wrapper. */
  protected wrapperAccess(type: JavaType | undefined): {
    unbox: (frame: Frame, value: Value) => Value;
    rebox: (frame: Frame, value: Value) => Value;
    primitiveType: JavaType;
  } {
    const unboxedType = type && unboxedTypeOf(type);
    const boxType = unboxedType && boxedTypeOf(this.builtins.wrappers, unboxedType);
    if (!type || !unboxedType || !boxType) {
      return { unbox: (_, value) => value, rebox: (_, value) => value, primitiveType: type ?? VOID };
    }
    return {
      unbox: (frame, value) => unbox(frame, value),
      rebox: (frame, value) => box(frame, boxType.cls, value),
      primitiveType: unboxedType,
    };
  }

  protected binaryOperation(
    span: Span,
    operator: BinaryOperator,
    leftType: JavaType,
    rightType: JavaType
  ): NonNullable<ReturnType<typeof binaryOperation>> {
    const operation = binaryOperation(this.builtins, operator, leftType, rightType);
    if (!operation) {
      this.error(
        span,
        `演算子 ${operator} は ${typeName(leftType)} 型と ${typeName(rightType)} 型の組み合わせには使えません。`
      );
    }
    return operation;
  }

  protected compileBinary(context: MethodContext, expression: Extract<Expression, { kind: 'binary' }>): Compiled {
    const leftValue = this.compileValue(context, expression.left);
    const { operator: binaryOperator } = expression;
    // The right operand of && sees the pattern variables of a true left operand, and that of || of a false one.
    const rightBindings =
      binaryOperator === '&&' || binaryOperator === '||' ? bindingsWhen(expression.left, binaryOperator === '&&') : [];
    const rightValue = this.withBindings(context, rightBindings, () => this.compileValue(context, expression.right));
    // Operators unbox wrapper objects, except string concatenation and == between two references.
    const isString = (type: JavaType): boolean => type.kind === 'class' && type.cls === this.builtins.stringClass;
    const keepsReferences =
      (binaryOperator === '+' && (isString(leftValue.type) || isString(rightValue.type))) ||
      ((binaryOperator === '==' || binaryOperator === '!=') &&
        isReference(leftValue.type) &&
        isReference(rightValue.type));
    const left = keepsReferences ? leftValue : this.operand(leftValue);
    const right = keepsReferences ? rightValue : this.operand(rightValue);
    const operation = this.binaryOperation(expression, expression.operator, left.type, right.type);
    if (expression.operator === '&&' || expression.operator === '||') {
      return shortCircuit(expression.operator, left, right);
    }
    let constant: Value;
    if (left.constant !== undefined && right.constant !== undefined && isPrimitive(operation.type)) {
      try {
        constant = operation.apply(undefined as unknown as Frame, left.constant, right.constant);
      } catch {
        constant = undefined;
      }
    } else if (
      left.constant !== undefined &&
      right.constant !== undefined &&
      keepsReferences &&
      binaryOperator === '+'
    ) {
      // Concatenating constants gives a constant, which Java interns like a literal.
      const text = `${constantText(left.constant, left.type)}${constantText(right.constant, right.type)}`;
      constant = this.internedString(text);
      const interned = constant;
      return { kind: 'value', type: operation.type, constant, run: () => interned };
    }
    return {
      kind: 'value',
      type: operation.type,
      constant,
      run: (frame) => {
        const leftValue = left.run(frame);
        frame.temporaries.push(leftValue);
        let rightValue: Value;
        try {
          rightValue = right.run(frame);
        } finally {
          frame.temporaries.pop();
        }
        return operation.apply(frame, leftValue, rightValue);
      },
    };
  }

  protected compileUnary(context: MethodContext, expression: Extract<Expression, { kind: 'unary' }>): Compiled {
    const { operand, operator } = expression;
    // 2147483648 and 9223372036854775808L are valid literals only as the operand of unary minus.
    if (operator === '-' && operand.kind === 'literal') {
      const { literal } = operand;
      if (literal.type === 'int' && literal.value === 2_147_483_648) return constantValue(INT, -2_147_483_648);
      if (literal.type === 'long' && literal.value === 2n ** 63n) return constantValue(LONG, -(2n ** 63n));
    }
    const value = this.operand(this.compileValue(context, operand));
    const operation = unaryOperation(operator, value.type);
    if (!operation) this.error(expression, `演算子 ${operator} は ${typeName(value.type)} 型には使えません。`);
    return {
      kind: 'value',
      type: operation.type,
      run: (frame) => operation.apply(frame, value.run(frame)),
      constant:
        value.constant === undefined ? undefined : operation.apply(undefined as unknown as Frame, value.constant),
    };
  }

  protected compileConditional(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'conditional' }>
  ): Compiled {
    const condition = this.compileCondition(context, expression.condition);
    const consequenceValue = this.withBindings(context, bindingsWhen(expression.condition, true), () =>
      this.compileValue(context, expression.consequence)
    );
    const alternativeValue = this.withBindings(context, bindingsWhen(expression.condition, false), () =>
      this.compileValue(context, expression.alternative)
    );
    const [consequence, alternative] = this.conditionalOperands(consequenceValue, alternativeValue);
    const type = this.conditionalType(expression, consequence, alternative);
    // A constant branch may narrow to the other branch's type, as an assignment would; a reference type is a common
    // supertype of both branches.
    const toType = (branch: CompiledValue, span: Expression): CompiledValue =>
      isReference(type) ? { ...branch, type } : this.convert(branch, type, 'assignment', span);
    const whenTrue = toType(consequence, expression.consequence);
    const whenFalse = toType(alternative, expression.alternative);
    const constantCondition = booleanConstants.get(expression.condition);
    const isConstant =
      constantCondition !== undefined && whenTrue.constant !== undefined && whenFalse.constant !== undefined;
    return {
      kind: 'value',
      type,
      constant: isConstant ? (constantCondition ? whenTrue.constant : whenFalse.constant) : undefined,
      run: (frame) => (condition(frame) ? whenTrue.run(frame) : whenFalse.run(frame)),
    };
  }

  /**
   * Boxes or unboxes the branches of a conditional as Java types it: a primitive branch unboxes a wrapper on the
   * other side, two numeric wrappers of different kinds unbox, and a primitive branch next to a reference boxes.
   */
  protected conditionalOperands(a: CompiledValue, b: CompiledValue): [CompiledValue, CompiledValue] {
    const unboxedA = unboxedTypeOf(a.type);
    const unboxedB = unboxedTypeOf(b.type);
    if (isPrimitive(a.type) && unboxedB) return [a, this.operand(b)];
    if (isPrimitive(b.type) && unboxedA) return [this.operand(a), b];
    if (unboxedA && unboxedB && !sameType(a.type, b.type) && isNumeric(unboxedA) && isNumeric(unboxedB)) {
      return [this.operand(a), this.operand(b)];
    }
    if (isPrimitive(a.type) && isReference(b.type)) return [this.boxedValue(a), b];
    if (isPrimitive(b.type) && isReference(a.type)) return [a, this.boxedValue(b)];
    return [a, b];
  }

  protected conditionalType(span: Span, a: CompiledValue, b: CompiledValue): JavaType {
    const type = conditionalType(this.builtins.objectClass, a.type, b.type, [a.constant, b.constant]);
    if (!type) {
      this.error(span, `条件演算子の 2 つの値の型 ${typeName(a.type)} と ${typeName(b.type)} が合いません。`);
    }
    return type;
  }

  protected compileCast(context: MethodContext, expression: Extract<Expression, { kind: 'cast' }>): Compiled {
    const value = this.compileValue(context, expression.value);
    const type = this.resolveType(expression.type);
    if (!isCastable(value.type, type, this.builtins.objectClass)) {
      this.error(expression, `${typeName(value.type)} 型の値を ${typeName(type)} 型にキャストできません。`);
    }
    const cast = this.castOperation(value.type, type, expression);
    return {
      kind: 'value',
      type,
      run: (frame) => cast(frame, value.run(frame)),
      constant:
        value.constant !== undefined && isPrimitive(type)
          ? cast(undefined as unknown as Frame, value.constant)
          : undefined,
    };
  }

  protected castOperation(from: JavaType, to: JavaType, span: Span): (frame: Frame, value: Value) => Value {
    const cast = castOperation(this.builtins.objectClass, from, to);
    if (!cast) this.error(span, `${typeName(from)} 型の値を ${typeName(to)} 型に変換できません。`);
    return cast;
  }

  protected compileNewArray(context: MethodContext, expression: Extract<Expression, { kind: 'newArray' }>): Compiled {
    let type = this.resolveType(expression.elementType);
    for (let index = 0; index < expression.dimensionLengths.length + expression.extraDimensions; index++) {
      type = { kind: 'array', element: type };
    }
    if (expression.initializer) {
      return {
        kind: 'value',
        type,
        run: this.compileArrayInitializer(context, expression.initializer, type),
      };
    }
    const lengths = expression.dimensionLengths.map(
      (length) => this.convert(this.compileValue(context, length), INT, 'invocation', length).run
    );
    const create = (frame: Frame, arrayType: JavaType, sizes: number[]): JavaArray => {
      const elementType = (arrayType as Extract<JavaType, { kind: 'array' }>).element;
      const [size, ...rest] = sizes;
      frame.runtime.allocateArray(frame, size);
      const values: Value[] =
        rest.length > 0
          ? Array.from({ length: size }, () => create(frame, elementType, rest))
          : Array.from({ length: size }, () => defaultValue(elementType));
      return new JavaArray(elementType, values);
    };
    return {
      kind: 'value',
      type,
      run: (frame) =>
        create(
          frame,
          type,
          lengths.map((length) => length(frame) as number)
        ),
    };
  }
}

/** The value a reference reads, or the class a name turned out to name. */
function readOf(reference: (Reference & { constant?: Value }) | Compiled): Compiled {
  if ('kind' in reference) return reference;
  const { bind } = reference;
  return { kind: 'value', type: reference.type, run: (frame) => bind(frame).get(), constant: reference.constant };
}

/** The text a constant contributes to a string concatenation. */
function constantText(value: Value, type: JavaType): string {
  if (value instanceof JavaString) return value.value;
  switch (type.kind) {
    case 'char': {
      return charToString(value as number);
    }
    case 'double': {
      return formatDouble(value as number);
    }
    case 'float': {
      return formatFloat(value as number);
    }
    default: {
      return String(value as number | bigint | boolean);
    }
  }
}

/** `&&` or `||`, which evaluates its right operand only when the left one does not decide the result. */
function shortCircuit(operator: '&&' | '||', left: CompiledValue, right: CompiledValue): CompiledValue {
  const isAnd = operator === '&&';
  const bothConstant = typeof left.constant === 'boolean' && typeof right.constant === 'boolean';
  return {
    kind: 'value',
    type: BOOLEAN,
    constant: bothConstant ? (isAnd ? left.constant && right.constant : left.constant || right.constant) : undefined,
    run: (frame) =>
      isAnd
        ? (left.run(frame) as boolean) && (right.run(frame) as boolean)
        : (left.run(frame) as boolean) || (right.run(frame) as boolean),
  };
}
