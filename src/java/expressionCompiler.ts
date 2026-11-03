// code-gauge-allow-file fileNcss 440 -- The expression compiler keeps one method per expression kind together.
import type { ArrayInitializer, BinaryOperator, Expression, Span } from './ast';
import {
  type Compiled,
  type CompiledValue,
  CompilerBase,
  constantValue,
  type Eval,
  type MethodContext,
  type Reference,
} from './compilerBase';
import { CompileError } from './diagnostics';
import { binaryOperation, castOperation, conditionalType, unaryOperation } from './operators';
import { booleanConstants } from './reachability';
import { type Frame, throwBuiltin, UNASSIGNED } from './runtime';
import {
  BOOLEAN,
  CHAR,
  type ClassInfo,
  DOUBLE,
  type FieldInfo,
  INT,
  isCastable,
  isNumeric,
  isPrimitive,
  isReference,
  type JavaType,
  type MethodInfo,
  NULL,
  typeName,
} from './types';
import { defaultValue, JavaArray, JavaObject, JavaString, toInt32, type Value } from './values';

/** Type-checks expressions and compiles them into closures. */
export abstract class ExpressionCompiler extends CompilerBase {
  protected compileCondition(context: MethodContext, expression: Expression): (frame: Frame) => boolean {
    const value = this.compileValue(context, expression);
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
    return this.convert(this.compileValue(context, initializer), type, 'assignment').run;
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
    try {
      const compiled = this.compileExpressionBody(context, expression);
      if (compiled.kind === 'value' && typeof compiled.constant === 'boolean') {
        booleanConstants.set(expression, compiled.constant);
      }
      return compiled;
    } catch (error) {
      // Conversions report no location of their own, so they take the expression's.
      if (error instanceof CompileError && error.diagnostics[0]?.row === -1) {
        throw new CompileError([{ row: expression.row, message: error.diagnostics[0].message }]);
      }
      throw error;
    }
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
        if (context.isStatic) this.error(expression, 'static メソッドの中では this を使えません。');
        return thisValue(context);
      }
      case 'fieldAccess': {
        const reference = this.compileFieldReference(context, expression);
        if ('kind' in reference) return reference;
        const bound = reference.bind;
        return {
          kind: 'value',
          type: reference.type,
          run: (frame) => bound(frame).get(),
          constant: reference.constant,
        };
      }
      case 'arrayAccess': {
        const reference = this.compileReference(context, expression);
        const bound = reference.bind;
        return { kind: 'value', type: reference.type, run: (frame) => bound(frame).get() };
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
        const value = this.compileValue(context, expression.value);
        const type = this.resolveType(expression.type);
        if (type.kind !== 'class') this.error(expression.type, 'instanceof ではクラス型しか使えません。');
        if (!isReference(value.type) || !isCastable(value.type, type, this.builtins.objectClass)) {
          this.error(expression, `${typeName(value.type)} 型の値は ${typeName(type)} 型になりえません。`);
        }
        return {
          kind: 'value',
          type: BOOLEAN,
          run: (frame) => frame.runtime.isInstance(value.run(frame), type.cls),
        };
      }
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
        let interned = this.internedStrings.get(literal.value);
        if (!interned) {
          interned = new JavaString(literal.value);
          this.internedStrings.set(literal.value, interned);
        }
        return constantValue(this.builtins.stringClass.type, interned);
      }
      case 'null': {
        return { kind: 'value', type: NULL, run: () => {} };
      }
    }
  }

  protected compileName(context: MethodContext, expression: Extract<Expression, { kind: 'name' }>): Compiled {
    const slot = this.findLocal(context, expression.name);
    if (slot !== undefined) {
      const type = context.locals[slot].type;
      const constant = context.constants.get(slot);
      if (constant !== undefined) {
        return {
          kind: 'value',
          type,
          constant,
          run: (frame) => {
            if (frame.locals[slot] === UNASSIGNED)
              throw new Error(`Local ${expression.name} is read before assignment`);
            return constant;
          },
        };
      }
      return {
        kind: 'value',
        type,
        run: (frame) => {
          const value = frame.locals[slot];
          if (value === UNASSIGNED) throw new Error(`Local ${expression.name} is read before assignment`);
          return value;
        },
      };
    }
    const reference = this.compileSimpleNameReference(context, expression);
    if ('kind' in reference) return reference;
    const bound = reference.bind;
    return {
      kind: 'value',
      type: reference.type,
      run: (frame) => bound(frame).get(),
      constant: reference.constant,
    };
  }

  /** Resolves `object.name`, or a simple name when `object` is `undefined`. */
  /** Resolves a simple name that is not a local: a field of the current class or a class name. */
  protected compileSimpleNameReference(
    context: MethodContext,
    name: Extract<Expression, { kind: 'name' }>
  ): (Reference & { constant?: Value }) | Compiled {
    const field = this.findField(context.cls, name.name);
    if (field) {
      if (!field.isStatic && context.isStatic) {
        this.error(name, `static ではないフィールド ${name.name} は static メソッドの中から使えません。`);
      }
      return this.fieldReference(field, field.isStatic ? undefined : thisValue(context));
    }
    const cls = this.classes.get(name.name) ?? this.builtins.classes.get(name.name);
    if (cls) return { kind: 'class', cls };
    return this.error(name, `変数 ${name.name} が見つかりません。`);
  }

  /** Resolves `object.name`. */
  protected compileFieldReference(
    context: MethodContext,
    access: Extract<Expression, { kind: 'fieldAccess' }>
  ): (Reference & { constant?: Value }) | Compiled {
    const { name } = access;
    if (access.object === 'super') {
      if (context.isStatic) this.error(access, 'static メソッドの中では super を使えません。');
      const field = this.findField(context.cls.superclass as ClassInfo, name);
      if (!field) return this.error(access, `フィールド ${name} が見つかりません。`);
      return this.fieldReference(field, field.isStatic ? undefined : thisValue(context));
    }
    const object = this.compileExpression(context, access.object);
    if (object.kind === 'class') {
      const field = this.findField(object.cls, name);
      if (!field) return this.error(access, `${object.cls.name} にフィールド ${name} がありません。`);
      if (!field.isStatic) this.error(access, `static ではないフィールド ${name} はクラス名から使えません。`);
      this.checkAccess(context, field.owner, field.access, access, `フィールド ${name}`);
      return this.fieldReference(field, undefined);
    }
    return this.compileMemberOfValue(context, access, object);
  }

  /** Resolves `object.name` where `object` is a value, including an array's `length`. */
  protected compileMemberOfValue(
    context: MethodContext,
    access: Extract<Expression, { kind: 'fieldAccess' }>,
    object: CompiledValue
  ): Reference & { constant?: Value } {
    const { name } = access;
    if (object.type.kind === 'array') {
      if (name !== 'length') this.error(access, `配列にフィールド ${name} はありません。`);
      return arrayLengthReference(object);
    }
    if (object.type.kind !== 'class') {
      return this.error(access, `${typeName(object.type)} 型の値にはフィールドがありません。`);
    }
    const field = this.findField(object.type.cls, name);
    if (!field) return this.error(access, `${object.type.cls.name} にフィールド ${name} がありません。`);
    this.checkAccess(context, field.owner, field.access, access, `フィールド ${name}`);
    return this.fieldReference(field, field.isStatic ? undefined : object, field.isStatic ? object : undefined);
  }

  protected fieldReference(
    field: FieldInfo,
    receiver: CompiledValue | undefined,
    ignoredReceiver?: CompiledValue
  ): Reference & { constant?: Value } {
    const { slot, owner } = field;
    const constant = this.constantOf(field);
    if (constant !== undefined) {
      return {
        type: field.type,
        field,
        constant,
        bind: () => ({
          get: () => constant,
          set: () => {
            throw new Error('A constant variable was assigned');
          },
        }),
      };
    }
    if (field.isStatic) {
      const builtinConstant = field.constant;
      return {
        type: field.type,
        field,
        constant:
          builtinConstant !== undefined && !(builtinConstant instanceof JavaObject) ? builtinConstant : undefined,
        bind: (frame) => {
          ignoredReceiver?.run(frame);
          const values = frame.runtime.staticsOf(frame, owner);
          return {
            get: () => values[slot],
            set: (value) => {
              values[slot] = value;
            },
          };
        },
      };
    }
    const object = receiver as CompiledValue;
    return {
      type: field.type,
      field,
      bind: (frame) => {
        const target = object.run(frame);
        if (!(target instanceof JavaObject)) return throwBuiltin(frame, 'NullPointerException');
        return {
          get: () => target.fields[slot],
          set: (value) => {
            target.fields[slot] = value;
          },
        };
      },
    };
  }

  protected compileReference(context: MethodContext, target: Expression): Reference {
    if (target.kind === 'arrayAccess') return this.compileArrayElementReference(context, target);
    if (target.kind !== 'name' && target.kind !== 'fieldAccess') return this.error(target, '代入できない式です。');
    const slot = target.kind === 'name' ? this.findLocal(context, target.name) : undefined;
    if (slot !== undefined) return localReference(context, slot);
    const reference =
      target.kind === 'name'
        ? this.compileSimpleNameReference(context, target)
        : this.compileFieldReference(context, target);
    if ('kind' in reference) return this.error(target, `${target.name} には代入できません。`);
    return reference;
  }

  protected compileArrayElementReference(
    context: MethodContext,
    target: Extract<Expression, { kind: 'arrayAccess' }>
  ): Reference {
    const array = this.compileValue(context, target.array);
    if (array.type.kind !== 'array') {
      return this.error(target, `${typeName(array.type)} 型の値は配列ではありません。`);
    }
    const index = this.convert(this.compileValue(context, target.index), INT, 'invocation', target.index).run;
    return {
      type: array.type.element,
      bind: (frame) => {
        const values = array.run(frame);
        if (!(values instanceof JavaArray)) throwBuiltin(frame, 'NullPointerException');
        frame.temporaries.push(values);
        let position: number;
        try {
          position = index(frame) as number;
        } finally {
          frame.temporaries.pop();
        }
        if (position < 0 || position >= values.values.length) {
          throwBuiltin(
            frame,
            'ArrayIndexOutOfBoundsException',
            `Index ${position} out of bounds for length ${values.values.length}`
          );
        }
        return {
          get: () => values.values[position],
          set: (value) => {
            values.values[position] = value;
          },
        };
      },
    };
  }

  protected compileAssignment(context: MethodContext, expression: Extract<Expression, { kind: 'assign' }>): Compiled {
    const reference = this.compileReference(context, expression.target);
    this.checkAssignable(context, expression.target, reference);
    const value = this.compileValue(context, expression.value);
    const { bind, type } = reference;
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
    const operation = this.binaryOperation(expression, operator, type, value.type);
    const narrow = this.castOperation(operation.type, type, expression);
    return {
      kind: 'value',
      type,
      run: (frame) => {
        const target = bind(frame);
        const left = target.get();
        frame.temporaries.push(left);
        let right: Value;
        try {
          right = value.run(frame);
        } finally {
          frame.temporaries.pop();
        }
        const result = narrow(frame, operation.apply(frame, left, right));
        target.set(result);
        return result;
      },
    };
  }

  /**
   * Rejects assigning an array's length or a final field, except a blank final field that a constructor or an
   * initializer of its class assigns by its simple name or through `this`.
   */
  protected checkAssignable(context: MethodContext, target: Expression, reference: Reference): void {
    const { field } = reference;
    if (reference.isArrayLength) this.error(target, 'length は final なので代入できません。');
    if (!field?.isFinal) return;
    const isBlank =
      field.constant === undefined &&
      !field.declaration?.declarators.find((declarator) => declarator.name === field.name)?.initializer;
    const namesOwnField =
      target.kind === 'name' ||
      (target.kind === 'fieldAccess' && target.object !== 'super' && target.object.kind === 'this');
    const initializesField =
      context.cls === field.owner && context.initializes === (field.isStatic ? 'static' : 'instance');
    if (!(isBlank && namesOwnField && initializesField))
      this.error(target, `${field.name} は final なので代入できません。`);
  }

  protected compileUpdate(context: MethodContext, expression: Extract<Expression, { kind: 'update' }>): Compiled {
    const reference = this.compileReference(context, expression.target);
    this.checkAssignable(context, expression.target, reference);
    const { type, bind } = reference;
    if (!isNumeric(type))
      this.error(expression, `${typeName(type)} 型の変数には ${expression.operator} を使えません。`);
    const delta = expression.operator === '++' ? 1 : -1;
    const step =
      type.kind === 'int'
        ? (value: number) => toInt32(value + delta)
        : type.kind === 'char'
          ? (value: number) => (value + delta) & 0xff_ff
          : (value: number) => value + delta;
    const isPrefix = expression.isPrefix;
    return {
      kind: 'value',
      type,
      run: (frame) => {
        const target = bind(frame);
        const before = target.get() as number;
        const after = step(before);
        target.set(after);
        return isPrefix ? after : before;
      },
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
    const left = this.compileValue(context, expression.left);
    const right = this.compileValue(context, expression.right);
    const operation = this.binaryOperation(expression, expression.operator, left.type, right.type);
    if (expression.operator === '&&' || expression.operator === '||') {
      const isAnd = expression.operator === '&&';
      return {
        kind: 'value',
        type: BOOLEAN,
        run: (frame) =>
          isAnd
            ? (left.run(frame) as boolean) && (right.run(frame) as boolean)
            : (left.run(frame) as boolean) || (right.run(frame) as boolean),
      };
    }
    let constant: Value;
    if (left.constant !== undefined && right.constant !== undefined && isPrimitive(operation.type)) {
      try {
        constant = operation.apply(undefined as unknown as Frame, left.constant, right.constant);
      } catch {
        constant = undefined;
      }
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
    // 2147483648 is a valid int literal only as the operand of unary minus.
    if (
      operator === '-' &&
      operand.kind === 'literal' &&
      operand.literal.type === 'int' &&
      operand.literal.value === 2_147_483_648
    ) {
      return constantValue(INT, -2_147_483_648);
    }
    const value = this.compileValue(context, operand);
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
    const consequence = this.compileValue(context, expression.consequence);
    const alternative = this.compileValue(context, expression.alternative);
    const type = this.conditionalType(expression, consequence.type, alternative.type);
    const whenTrue = this.convert(consequence, type).run;
    const whenFalse = this.convert(alternative, type).run;
    return {
      kind: 'value',
      type,
      run: (frame) => (condition(frame) ? whenTrue(frame) : whenFalse(frame)),
    };
  }

  protected conditionalType(span: Span, a: JavaType, b: JavaType): JavaType {
    const type = conditionalType(this.builtins.objectClass, a, b);
    if (!type) this.error(span, `条件演算子の 2 つの値の型 ${typeName(a)} と ${typeName(b)} が合いません。`);
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

  protected compileNew(context: MethodContext, expression: Extract<Expression, { kind: 'new' }>): Compiled {
    const type = this.resolveType(expression.type);
    if (type.kind !== 'class') return this.error(expression, `${typeName(type)} 型のオブジェクトは new で作れません。`);
    const cls = type.cls;
    if (cls.isAbstract) this.error(expression, `抽象クラス ${cls.name} のオブジェクトは作れません。`);
    if (cls.isBuiltin && cls.constructors.length === 0)
      this.error(expression, `${cls.name} のオブジェクトは new で作れません。`);
    if (cls === this.builtins.stringClass) this.error(expression, 'String のオブジェクトは new で作れません。');
    const args = expression.args.map((arg) => this.compileValue(context, arg));
    const constructor = this.selectMethod(
      expression,
      cls.constructors,
      args.map((arg) => arg.type),
      `コンストラクタ ${cls.name}`
    );
    this.checkAccess(context, cls, constructor.access, expression, `コンストラクタ ${cls.name}`);
    this.checkThrown(context, expression, constructor.thrownTypes);
    const convertedArgs = args.map((arg, index) => this.convert(arg, constructor.parameterTypes[index]).run);
    const callRow = expression.row;
    return {
      kind: 'value',
      type,
      run: (frame) => {
        frame.runtime.initializeClass(frame, cls);
        const object = frame.runtime.allocateObject(frame, cls);
        frame.temporaries.push(object);
        try {
          this.invokeWithArguments(frame, constructor, object, convertedArgs, callRow);
        } finally {
          frame.temporaries.pop();
        }
        return object;
      },
    };
  }

  protected compileCall(context: MethodContext, expression: Extract<Expression, { kind: 'call' }>): Compiled {
    const args = expression.args.map((arg) => this.compileValue(context, arg));
    const target = this.resolveCallTarget(context, expression);
    if (target.candidates.length === 0) {
      this.error(expression, `${target.ownerName} にメソッド ${expression.name} がありません。`);
    }
    const method = this.selectMethod(
      expression,
      target.candidates,
      args.map((arg) => arg.type),
      `メソッド ${expression.name}`
    );
    this.checkCall(context, expression, method, target.receiver === undefined);
    this.checkThrown(context, expression, method.thrownTypes);
    const convertedArgs = args.map((arg, index) => this.convert(arg, method.parameterTypes[index]).run);
    const callRow = expression.row;
    if (method.isStatic) {
      // A static method called through an expression still evaluates that expression.
      const ignored = expression.object === undefined ? undefined : target.receiver;
      return {
        kind: 'value',
        type: method.returnType,
        run: (frame) => {
          ignored?.run(frame);
          frame.runtime.initializeClass(frame, method.owner);
          return this.invokeWithArguments(frame, method, undefined, convertedArgs, callRow);
        },
      };
    }
    const receiver = target.receiver as CompiledValue;
    const dispatches = expression.object !== 'super' && method.access !== 'private';
    return {
      kind: 'value',
      type: method.returnType,
      run: (frame) => {
        const object = receiver.run(frame);
        if (object === undefined) throwBuiltin(frame, 'NullPointerException');
        const resolved = dispatches ? frame.runtime.dispatch(object, method) : method;
        frame.temporaries.push(object);
        try {
          return this.invokeWithArguments(frame, resolved, object, convertedArgs, callRow);
        } finally {
          frame.temporaries.pop();
        }
      },
    };
  }

  /** The methods a call may select and the receiver it evaluates, which is absent for a class name. */
  protected resolveCallTarget(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'call' }>
  ): { candidates: MethodInfo[]; ownerName: string; receiver: CompiledValue | undefined } {
    if (expression.object === undefined || expression.object === 'super') {
      const isSuper = expression.object === 'super';
      if (isSuper && context.isStatic) this.error(expression, 'static メソッドの中では super を使えません。');
      const owner = isSuper ? (context.cls.superclass as ClassInfo) : context.cls;
      return {
        candidates: this.collectMethods(owner, expression.name),
        ownerName: owner.name,
        receiver: thisValue(context),
      };
    }
    const object = this.compileExpression(context, expression.object);
    if (object.kind === 'class') {
      return {
        candidates: this.collectMethods(object.cls, expression.name),
        ownerName: object.cls.name,
        receiver: undefined,
      };
    }
    if (object.type.kind !== 'class' && object.type.kind !== 'array') {
      this.error(expression, `${typeName(object.type)} 型の値にはメソッドがありません。`);
    }
    const owner = object.type.kind === 'class' ? object.type.cls : this.builtins.objectClass;
    return { candidates: this.collectMethods(owner, expression.name), ownerName: owner.name, receiver: object };
  }

  protected checkCall(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'call' }>,
    method: MethodInfo,
    isThroughClassName: boolean
  ): void {
    const { name } = expression;
    this.checkAccess(context, method.owner, method.access, expression, `メソッド ${name}`);
    if (isThroughClassName && !method.isStatic) {
      this.error(expression, `static ではないメソッド ${name} はクラス名から呼び出せません。`);
    }
    if (expression.object === undefined && !method.isStatic && context.isStatic) {
      this.error(expression, `static ではないメソッド ${name} は static メソッドの中から呼び出せません。`);
    }
    if (expression.object === 'super' && method.isAbstract) {
      this.error(expression, `抽象メソッド ${name} は super から呼び出せません。`);
    }
  }
}

function thisValue(context: MethodContext): CompiledValue {
  return { kind: 'value', type: context.cls.type, run: (frame) => frame.thisObject };
}

function arrayLengthReference(array: CompiledValue): Reference {
  return {
    type: INT,
    isArrayLength: true,
    bind: (frame) => {
      const value = array.run(frame);
      if (!(value instanceof JavaArray)) throwBuiltin(frame, 'NullPointerException');
      return {
        get: () => value.values.length,
        set: () => {
          throw new Error('Array length is final');
        },
      };
    },
  };
}

function localReference(context: MethodContext, slot: number): Reference {
  return {
    type: context.locals[slot].type,
    bind: (frame) => ({
      get: () => frame.locals[slot] as Value,
      set: (value) => {
        frame.locals[slot] = value;
      },
    }),
  };
}
