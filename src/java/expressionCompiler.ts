// code-gauge-allow-file fileNcss 453 -- The expression compiler keeps one method per expression kind together.
import type { ArrayInitializer, BinaryOperator, ClassDeclaration, Expression, PatternBinding, Span } from './ast';
import { classObjectOf, getBuiltins } from './builtins';
import { box, boxedTypeOf, unbox } from './builtinWrappers';
import {
  type Capture,
  type Compiled,
  type CompiledValue,
  CompilerBase,
  constantValue,
  type Eval,
  type MethodContext,
  type Reference,
  type Scope,
} from './compilerBase';
import { infer, memberBindings, memberType, methodView, unboxedTypeOf } from './conversions';
import { binaryOperation, castOperation, conditionalType, unaryOperation } from './operators';
import { bindingsWhen } from './patternBindings';
import { booleanConstants } from './reachability';
import { type Frame, throwBuiltin, UNASSIGNED } from './runtime';
import {
  asSuper,
  BOOLEAN,
  CHAR,
  type ClassInfo,
  DOUBLE,
  type FieldInfo,
  FLOAT,
  INT,
  isCastable,
  isNumeric,
  isPrimitive,
  isReference,
  isSubclass,
  isWidening,
  type JavaType,
  LONG,
  type MethodInfo,
  NULL,
  sameType,
  thisTypeOf,
  typeName,
  type TypeVariable,
  upperBound,
  VOID,
} from './types';
import { defaultValue, JavaArray, JavaObject, toInt32, type Value } from './values';

/** Type-checks expressions and compiles them into closures. */
export abstract class ExpressionCompiler extends CompilerBase {
  /** The local and anonymous classes, with the method context that declares each and the locals it reads. */
  protected readonly localClasses = new WeakMap<ClassInfo, { definingContext: MethodContext; captures: Capture[] }>();
  /** The local slots that pattern variables use. */
  protected readonly bindingSlots = new WeakMap<PatternBinding, number>();

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
        if (context.isStatic) this.error(expression, 'static メソッドの中では this を使えません。');
        if (!expression.qualifier) return thisValue(context);
        const qualifier = this.resolveType(expression.qualifier);
        const outer = qualifier.kind === 'class' ? this.outerInstanceValue(context, qualifier.cls, true) : undefined;
        if (!outer) return this.error(expression, `ここでは ${typeName(qualifier)}.this を使えません。`);
        return outer;
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
        return this.compileInstanceOf(context, expression);
      }
      case 'switchExpression': {
        return this.compileSwitchExpression(context, expression);
      }
      case 'lambda':
      case 'methodRef': {
        const target = this.takeTargetType();
        if (!target) {
          return this.error(
            expression,
            `${expression.kind === 'lambda' ? 'ラムダ式' : 'メソッド参照'}は、変数への代入やメソッドの引数など、型が決まる場所にしか書けません。`
          );
        }
        return this.compileFunctional(context, expression, target);
      }
      case 'classLiteral': {
        const type = this.resolveType(expression.type);
        if (type.kind !== 'class')
          return this.error(
            expression,
            'この採点環境では、クラスと列挙型とインターフェースにしか .class を使えません。'
          );
        const classClass = this.builtins.classes.get('Class') as ClassInfo;
        const object = classObjectOf(type.cls, classClass);
        return { kind: 'value', type: classClass.type, run: () => object };
      }
      case 'typeRef': {
        const type = this.resolveType(expression.type);
        if (type.kind !== 'class') return this.error(expression, `${typeName(type)} は値として使えません。`);
        return { kind: 'class', cls: type.cls };
      }
    }
  }

  /**
   * Declares and compiles a class written inside a method body: a local class, or an anonymous class that extends
   * `anonymousSuperclass` and passes its arguments to `superConstructor`.
   */
  protected abstract compileLocalClass(
    context: MethodContext,
    declaration: ClassDeclaration,
    anonymous?: { superConstructor: MethodInfo | undefined; base: Extract<JavaType, { kind: 'class' }> }
  ): ClassInfo;

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
      this.introduceBindings(context, bindings);
      return compile();
    } finally {
      context.scopes.pop();
    }
  }

  /** Brings pattern variables into the innermost scope, where they stay until it ends. */
  protected introduceBindings(context: MethodContext, bindings: readonly PatternBinding[]): void {
    const scope = context.scopes.at(-1) as Scope;
    for (const binding of bindings) {
      if (this.findLocal(context, binding.name) !== undefined) {
        this.error(binding, `変数 ${binding.name} はすでに定義されています。`);
      }
      const slot = this.bindingSlots.get(binding) as number;
      scope.names.set(binding.name, slot);
      scope.slots.push(slot);
      context.introducedPatternSlots.add(slot);
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
    const captured = this.findCapture(context, expression, expression.name);
    if (captured) {
      const { index, capture } = captured;
      return { kind: 'value', type: capture.type, constant: capture.constant, run: (frame) => frame.captured[index] };
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
    for (let current: ClassInfo | undefined = context.cls; current; current = current.enclosing) {
      if (current !== context.cls) {
        const outerField = this.findField(current, name.name);
        if (outerField?.isStatic) return this.fieldReference(outerField, undefined);
        if (outerField) {
          const receiver = this.outerInstanceValue(context, current);
          if (!receiver) {
            this.error(name, `static ではないフィールド ${name.name} は、ここからは使えません。`);
          }
          return this.fieldReference(outerField, receiver);
        }
      }
      // A local or anonymous class reads the locals of the method that declares it.
      const captured = this.findClassCapture(context, current, name);
      if (captured) return captured;
    }
    const imported = this.staticallyImported(name.name, (cls) => {
      const field = this.findField(cls, name.name);
      return field?.isStatic ? field : undefined;
    });
    if (imported) return this.fieldReference(imported, undefined);
    const cls = this.lookupType(name.name, context.cls);
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
      if (!field) return this.error(access, missingFieldMessage(context.cls.superclass as ClassInfo, name));
      return notConstant(this.fieldReference(field, field.isStatic ? undefined : superValue(context)));
    }
    const object = this.compileExpression(context, access.object);
    if (object.kind === 'class') {
      const field = this.findField(object.cls, name);
      if (!field) {
        const member = this.findMemberType(object.cls, name);
        if (member) return { kind: 'class', cls: member };
        return this.error(access, missingFieldMessage(object.cls, name));
      }
      if (!field.isStatic) this.error(access, `static ではないフィールド ${name} はクラス名から使えません。`);
      this.checkAccess(context, field.owner, field.access, access, `フィールド ${name}`);
      return this.fieldReference(field, undefined);
    }
    // Java folds a constant field only when it is named by its simple name or as TypeName.name.
    return notConstant(this.compileMemberOfValue(context, access, object));
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
    const bound = upperBound(object.type);
    if (bound.kind !== 'class') {
      return this.error(access, `${typeName(object.type)} 型の値にはフィールドがありません。`);
    }
    const field = this.findField(bound.cls, name);
    if (!field) return this.error(access, missingFieldMessage(bound.cls, name));
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
        bind: (frame) => {
          // A receiver written before the field still runs, and an instance field still needs an object.
          ignoredReceiver?.run(frame);
          if (!field.isStatic && !((receiver as CompiledValue).run(frame) instanceof JavaObject)) {
            throwBuiltin(frame, 'NullPointerException');
          }
          return {
            get: () => constant,
            set: () => {
              throw new Error('A constant variable was assigned');
            },
          };
        },
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
      type: memberType(field.type, memberBindings(object.type, field.owner)),
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
    if (slot !== undefined) {
      this.recordAssignment(context, target, slot);
      return localReference(context, slot);
    }
    if (target.kind === 'name' && this.findCapture(context, target, target.name)) {
      this.error(target, `ラムダ式の中からは、外側のローカル変数 ${target.name} に代入できません。`);
    }
    const reference =
      target.kind === 'name'
        ? this.compileSimpleNameReference(context, target)
        : this.compileFieldReference(context, target);
    if ('kind' in reference) return this.error(target, `${target.name} には代入できません。`);
    if (reference.isCapture) {
      this.error(target, `クラスの中からは、外側のメソッドのローカル変数 ${target.name} に代入できません。`);
    }
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

  protected compileNew(context: MethodContext, expression: Extract<Expression, { kind: 'new' }>): Compiled {
    const targetType = this.takeTargetType();
    const resolved = this.resolveCreatedType(context, expression);
    if (resolved.kind !== 'class') {
      return this.error(expression, `${typeName(resolved)} 型のオブジェクトは new で作れません。`);
    }
    if (expression.body) return this.compileAnonymousCreation(context, expression, resolved, targetType);
    const cls = resolved.cls;
    if (cls.kind === 'interface')
      this.error(expression, `インターフェース ${cls.name} のオブジェクトは new で作れません。`);
    if (cls.kind === 'enum' || cls === this.builtins.enumClass) {
      this.error(expression, `列挙型 ${cls.name} のオブジェクトは new で作れません。`);
    }
    if (cls.isAbstract) this.error(expression, `抽象クラス ${cls.name} のオブジェクトは作れません。`);
    if (cls.isBuiltin && cls.constructors.length === 0)
      this.error(expression, `${cls.name} のオブジェクトは new で作れません。`);

    if (resolved.args?.some((arg) => arg.kind === 'wildcard')) {
      this.error(expression, 'new で作るオブジェクトの型引数に ? は使えません。');
    }
    const args = expression.args.map((arg) => this.compileArgument(context, arg));
    const argTypes = args.map((arg) => arg.type);
    const type = resolved.args?.length === 0 ? this.inferDiamond(cls, argTypes, targetType) : resolved;
    const bindings = memberBindings(type, cls);
    const constructor = this.selectMethod(
      expression,
      cls.constructors.map((candidate) => methodView(candidate, bindings)),
      argTypes,
      `コンストラクタ ${cls.name}`
    );
    this.checkAccess(context, cls, constructor.access, expression, `コンストラクタ ${cls.name}`);
    this.checkThrown(context, expression, constructor.thrownTypes);
    const convertedArgs = this.convertArguments(context, constructor, args, expression.args);
    if (cls === this.builtins.stringClass) {
      // A String's constructor builds the string itself, which is a new object distinct from equal strings.
      return {
        kind: 'value',
        type,
        run: (frame) => this.invokeWithArguments(frame, constructor, undefined, convertedArgs, undefined),
      };
    }
    return this.compileCreation(context, expression, cls, type, constructor, convertedArgs);
  }

  /** The type `new` creates, which `outer.new Inner()` names as a member of the outer value's class. */
  protected resolveCreatedType(context: MethodContext, expression: Extract<Expression, { kind: 'new' }>): JavaType {
    const { type, outer } = expression;
    if (!outer || type.kind !== 'named' || type.qualifier.length > 0) return this.resolveType(type);
    const outerType = upperBound(this.compileValue(context, outer).type);
    const member = outerType.kind === 'class' ? this.findMemberType(outerType.cls, type.name) : undefined;
    if (!member) return this.error(type, `${typeName(outerType)} には、クラス ${type.name} がありません。`);
    return this.withTypeScope(outerType.kind === 'class' ? outerType.cls : undefined, () => this.resolveType(type));
  }

  /** Creates an object of an anonymous class, whose body compiles here, where it may read the enclosing locals. */
  protected compileAnonymousCreation(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'new' }>,
    written: Extract<JavaType, { kind: 'class' }>,
    targetType: JavaType | undefined
  ): Compiled {
    const { cls: baseClass } = written;
    const isInterface = baseClass.kind === 'interface';
    if (baseClass.isFinal || baseClass.kind === 'enum' || baseClass === this.builtins.enumClass) {
      this.error(expression, `クラス ${baseClass.name} は継承できません。`);
    }
    const args = expression.args.map((arg) => this.compileArgument(context, arg));
    if (isInterface && args.length > 0) {
      this.error(expression, 'インターフェースを実装する匿名クラスには、引数を渡せません。');
    }
    const inferred =
      written.args?.length === 0
        ? this.inferDiamond(
            baseClass,
            args.map((arg) => arg.type),
            targetType
          )
        : written;
    const base = inferred.kind === 'class' ? inferred : written;
    let superConstructor: MethodInfo | undefined;
    if (!isInterface) {
      const bindings = memberBindings(base, baseClass);
      superConstructor = this.selectMethod(
        expression,
        baseClass.constructors.map((candidate) => methodView(candidate, bindings)),
        args.map((arg) => arg.type),
        `コンストラクタ ${baseClass.name}`
      );
      this.checkAccess(context, baseClass, superConstructor.access, expression, `コンストラクタ ${baseClass.name}`);
    }
    const { row, endRow, start, end } = expression;
    const declaration: ClassDeclaration = {
      kind: 'class',
      name: '',
      typeParameters: [],
      modifiers: { isStatic: false, isFinal: false, isAbstract: false, isDefault: false, access: 'package' },
      superclass: isInterface ? undefined : expression.type,
      interfaces: isInterface ? [expression.type] : [],
      enumConstants: [],
      members: expression.body ?? [],
      row,
      endRow,
      start,
      end,
    };
    const cls = this.compileLocalClass(context, declaration, { superConstructor, base });
    const constructor = cls.constructors[0];
    this.checkThrown(context, expression, constructor.thrownTypes);
    const convertedArgs = this.convertArguments(context, constructor, args, expression.args);
    return this.compileCreation(context, expression, cls, cls.type, constructor, convertedArgs);
  }

  /**
   * Allocates an object and runs its constructor, first giving an inner class's object its enclosing instance and a
   * local class's object the enclosing locals it reads.
   */
  protected compileCreation(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'new' }>,
    cls: ClassInfo,
    type: JavaType,
    constructor: MethodInfo,
    convertedArgs: Eval[]
  ): CompiledValue {
    const outer = this.compileOuterInstance(context, expression, cls);
    const captured = this.compileCapturedLocals(context, expression, cls);
    const callRow = expression.row;
    const declaredConstructor = constructor.declared ?? constructor;
    return {
      kind: 'value',
      type,
      run: (frame) => {
        frame.runtime.initializeClass(frame, cls);
        const outerObject = outer?.(frame);
        const object = frame.runtime.allocateObject(frame, cls);
        if (outer) object.outer = outerObject as JavaObject;
        if (captured) object.capturedLocals = captured(frame);
        frame.temporaries.push(object);
        try {
          this.invokeWithArguments(frame, declaredConstructor, object, convertedArgs, callRow);
        } finally {
          frame.temporaries.pop();
        }
        return object;
      },
    };
  }

  /** The enclosing instance that an object of an inner, local, or anonymous class belongs to. */
  protected compileOuterInstance(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'new' }>,
    cls: ClassInfo
  ): Eval | undefined {
    if (!cls.hasOuterInstance) {
      if (expression.outer)
        this.error(expression, `static なクラス ${cls.name} のオブジェクトは、外側のオブジェクトから new できません。`);
      return;
    }
    const enclosing = cls.enclosing as ClassInfo;
    if (!expression.outer) {
      const outer = this.outerInstanceValue(context, enclosing);
      if (!outer) {
        this.error(
          expression,
          `static でないクラス ${cls.name} のオブジェクトは、${enclosing.name} のオブジェクトがない static メソッドの中からは作れません。`
        );
      }
      return outer.run;
    }
    const outer = this.compileValue(context, expression.outer);
    if (!isWidening(outer.type, enclosing.type, this.builtins.objectClass)) {
      this.error(expression.outer, `${typeName(outer.type)} 型の値からは ${cls.name} のオブジェクトを作れません。`);
    }
    const { run } = outer;
    return (frame) => {
      const value = run(frame);
      if (value === undefined) throwBuiltin(frame, 'NullPointerException');
      return value;
    };
  }

  /** Reads the enclosing locals that a local class's object copies: from the creating method, or from its own copy. */
  protected compileCapturedLocals(
    context: MethodContext,
    span: Span,
    cls: ClassInfo
  ): ((frame: Frame) => Value[]) | undefined {
    const local = this.localClasses.get(cls);
    if (!local) return;
    let isInside = false;
    for (let current: ClassInfo | undefined = context.cls; current; current = current.enclosing) {
      if (current === cls) isInside = true;
    }
    if (isInside) {
      // Code inside the class creates another object with the same locals as the object it runs in.
      const holder = cls === context.cls ? thisValue(context) : this.outerInstanceValue(context, cls, true);
      if (!holder) return () => [];
      return (frame) => [...((holder.run(frame) as JavaObject | undefined)?.capturedLocals ?? [])];
    }
    const { row, endRow, start, end } = span;
    const readers = local.captures.map(
      (capture) => this.compileValue(context, { kind: 'name', name: capture.name, row, endRow, start, end }).run
    );
    return (frame) => readers.map((read) => read(frame));
  }

  /**
   * The type arguments the diamond `<>` stands for: those the constructor's arguments decide, then those the type the
   * value is assigned to decides. Any left undecided make the type raw, which converts to any parameterization.
   */
  protected inferDiamond(cls: ClassInfo, argTypes: JavaType[], targetType: JavaType | undefined): JavaType {
    const variables = cls.typeParameters;
    const bindings = new Map<TypeVariable, JavaType>();
    const self = thisTypeOf(cls);
    const target = targetType && upperBound(targetType);
    if (target?.kind === 'class' && target.args) {
      const supertype = asSuper(self, target.cls);
      for (const [index, arg] of (supertype?.args ?? []).entries()) {
        const targetArg = target.args[index];
        if (targetArg.kind !== 'wildcard') infer(this.builtins, arg, targetArg, variables, bindings);
        else if (targetArg.bound) infer(this.builtins, arg, targetArg.bound, variables, bindings);
      }
    }
    // The constructor's arguments decide only what the target type leaves open.
    const candidates = cls.constructors.filter((constructor) => constructor.parameterTypes.length === argTypes.length);
    if (candidates.length === 1) {
      const fromArgs = new Map<TypeVariable, JavaType>();
      for (const [index, parameterType] of candidates[0].parameterTypes.entries()) {
        infer(this.builtins, parameterType, argTypes[index], variables, fromArgs);
      }
      for (const [variable, type] of fromArgs) if (!bindings.has(variable)) bindings.set(variable, type);
    }
    if (variables.some((variable) => !bindings.has(variable))) return cls.type;
    return { kind: 'class', cls, args: variables.map((variable) => bindings.get(variable) as JavaType) };
  }

  protected compileCall(context: MethodContext, expression: Extract<Expression, { kind: 'call' }>): Compiled {
    const targetType = this.takeTargetType();
    const args = expression.args.map((arg) => this.compileArgument(context, arg));
    const target = this.resolveCallTarget(context, expression);
    if (target.candidates.length === 0) {
      this.error(expression, `この採点環境の ${target.owner.name} には、メソッド ${expression.name} がありません。`);
    }
    const explicitTypeArgs = expression.typeArgs?.map((type) => this.resolveTypeArgument(type));
    const method = this.selectMethod(
      expression,
      explicitTypeArgs ? this.withTypeArguments(target.candidates, explicitTypeArgs) : target.candidates,
      args.map((arg) => arg.type),
      `メソッド ${expression.name}`,
      targetType
    );
    const declared = method.declared ?? method;
    if (target.receiver === undefined && expression.object === undefined && !method.isStatic) {
      this.error(
        expression,
        `static ではないメソッド ${expression.name} は、static な入れ子のクラスの中から呼び出せません。`
      );
    }
    this.checkCall(context, expression, method, target.receiver === undefined && expression.object !== undefined);
    this.checkThrown(context, expression, method.thrownTypes);
    const convertedArgs = this.convertArguments(context, method, args, expression.args);
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
          return this.invokeWithArguments(frame, declared, undefined, convertedArgs, callRow);
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
        const resolved = dispatches ? frame.runtime.dispatch(object, declared) : declared;
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
  ): { candidates: MethodInfo[]; owner: ClassInfo; receiver: CompiledValue | undefined } {
    if (expression.object === undefined || expression.object === 'super') {
      const isSuper = expression.object === 'super';
      if (isSuper && context.isStatic) this.error(expression, 'static メソッドの中では super を使えません。');
      if (isSuper && context.cls.kind === 'interface')
        this.error(expression, 'インターフェースの中では super を使えません。');
      const owner = isSuper ? (context.cls.superclass as ClassInfo) : context.cls;
      const receiver = isSuper ? superValue(context) : thisValue(context);
      const candidates = this.viewMethods(this.collectMethods(owner, expression.name), receiver.type);
      if (candidates.length === 0 && !isSuper) {
        // A nested class calls the methods of the innermost enclosing class that has one of the name.
        for (let outer = context.cls.enclosing; outer; outer = outer.enclosing) {
          const outerCandidates = this.collectMethods(outer, expression.name);
          if (outerCandidates.length === 0) continue;
          const outerReceiver = this.outerInstanceValue(context, outer);
          return {
            candidates: outerReceiver ? this.viewMethods(outerCandidates, outerReceiver.type) : outerCandidates,
            owner: outer,
            receiver: outerReceiver,
          };
        }
      }
      if (candidates.length === 0 && !isSuper) {
        const imported = this.staticallyImported(expression.name, (cls) => {
          const methods = this.collectMethods(cls, expression.name).filter((method) => method.isStatic);
          return methods.length > 0 ? { methods, cls } : undefined;
        });
        if (imported) return { candidates: imported.methods, owner: imported.cls, receiver: undefined };
      }
      return { candidates, owner, receiver };
    }
    const object = this.compileExpression(context, expression.object);
    if (object.kind === 'class') {
      return {
        candidates: this.collectMethods(object.cls, expression.name),
        owner: object.cls,
        receiver: undefined,
      };
    }
    const bound = upperBound(object.type);
    if (bound.kind !== 'class' && bound.kind !== 'array') {
      this.error(expression, `${typeName(object.type)} 型の値にはメソッドがありません。`);
    }
    const owner = bound.kind === 'class' ? bound.cls : this.builtins.objectClass;
    const bounds = object.type.kind === 'typeVar' ? object.type.variable.bounds : [bound];
    // A type variable has the methods of all its bounds.
    const methods = bounds.flatMap((type) => {
      const upper = upperBound(type);
      return upper.kind === 'class' ? this.viewMethods(this.collectMethods(upper.cls, expression.name), upper) : [];
    });
    if (bound.kind === 'array') {
      // An array's clone() returns an array of its own type.
      const candidates =
        expression.name === 'clone' ? [arrayClone(bound)] : this.collectMethods(owner, expression.name);
      return { candidates, owner, receiver: object };
    }
    return { candidates: methods, owner, receiver: object };
  }

  /**
   * The instance of `target` (or a subclass) that code in `context` reaches through the enclosing instances of inner,
   * local, and anonymous classes, or `undefined` when a static context or a static class lies on the way.
   *
   * @param isExact Whether the instance must be of `target` itself, as `Target.this` requires.
   */
  protected outerInstanceValue(context: MethodContext, target: ClassInfo, isExact = false): CompiledValue | undefined {
    if (context.isStatic) return;
    let cls = context.cls;
    let hops = 0;
    while (isExact ? cls !== target : !isSubclass(cls, target)) {
      if (!cls.hasOuterInstance || !cls.enclosing) return;
      cls = cls.enclosing;
      hops++;
    }
    return {
      kind: 'value',
      type: thisTypeOf(cls),
      run: (frame) => {
        let object = frame.thisObject;
        for (let hop = 0; hop < hops; hop++) object = object?.outer;
        return object;
      },
    };
  }

  /**
   * Resolves a name in a local or anonymous class `cls` as a local of the method that declares it, which the class's
   * instances copy when they are created.
   */
  protected findClassCapture(
    context: MethodContext,
    cls: ClassInfo,
    name: Extract<Expression, { kind: 'name' }>
  ): (Reference & { constant?: Value }) | undefined {
    const local = this.localClasses.get(cls);
    if (!local) return;
    let index = local.captures.findIndex((capture) => capture.name === name.name);
    if (index === -1) {
      const defining = local.definingContext;
      const slot = this.findLocal(defining, name.name);
      let type: JavaType;
      let constant: Value;
      if (slot === undefined) {
        const lambdaCapture = this.findCapture(defining, name, name.name);
        if (!lambdaCapture) return;
        ({ type, constant } = lambdaCapture.capture);
      } else {
        const allowed = defining.uninitializedSlots.has(slot) ? 1 : 0;
        if ((defining.assignmentCounts.get(slot) ?? 0) > allowed) {
          this.error(
            name,
            `クラスの中から使うローカル変数 ${name.name} は、final か実質的に final (一度しか代入しない) である必要があります。`
          );
        }
        defining.capturedSlots.add(slot);
        type = defining.locals[slot].type;
        constant = defining.constants.get(slot);
      }
      index = local.captures.push({ name: name.name, type, constant, read: () => {} }) - 1;
    }
    const capture = local.captures[index];
    const holder = cls === context.cls ? thisValue(context) : this.outerInstanceValue(context, cls, true);
    if (!holder && context.isStatic) this.error(name, `変数 ${name.name} は static メソッドの中からは使えません。`);
    const read = holder?.run;
    return {
      type: capture.type,
      constant: capture.constant,
      isCapture: true,
      bind: (frame) => ({
        get: () => (read?.(frame) as JavaObject | undefined)?.capturedLocals?.[index],
        set: () => {
          throw new Error('A captured local was assigned');
        },
      }),
    };
  }

  /** The generic methods instantiated with explicit type arguments, as `obj.<String>m()` calls them. */
  protected withTypeArguments(methods: MethodInfo[], typeArgs: JavaType[]): MethodInfo[] {
    return methods.flatMap((method) => {
      const variables = method.typeParameters ?? [];
      // Java ignores type arguments that a method without type parameters is given.
      if (variables.length === 0) return [method];
      if (variables.length !== typeArgs.length) return [];
      const bindings = new Map(variables.map((variable, index) => [variable, typeArgs[index]]));
      return [{ ...methodView(method, bindings), typeParameters: [], declared: method.declared ?? method }];
    });
  }

  /** The methods as a receiver of `receiverType` sees them, with its type arguments substituted. */
  protected viewMethods(methods: MethodInfo[], receiverType: JavaType): MethodInfo[] {
    return methods.map((method) =>
      method.isStatic ? method : methodView(method, memberBindings(receiverType, method.owner))
    );
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

/** This environment implements only part of the standard library, so the message states only what it has. */
function missingFieldMessage(cls: ClassInfo, name: string): string {
  return `この採点環境の ${cls.name} には、フィールド ${name} がありません。`;
}

function notConstant(reference: Reference & { constant?: Value }): Reference & { constant?: Value } {
  return { ...reference, constant: undefined };
}

function thisValue(context: MethodContext): CompiledValue {
  return { kind: 'value', type: thisTypeOf(context.cls), run: (frame) => frame.thisObject };
}

function arrayClone(type: Extract<JavaType, { kind: 'array' }>): MethodInfo {
  return {
    name: 'clone',
    owner: getBuiltins().objectClass,
    parameterTypes: [],
    returnType: type,
    isStatic: false,
    isAbstract: false,
    isConstructor: false,
    access: 'public',
    thrownTypes: [],
    native: (frame, receiver) => {
      const array = receiver as JavaArray;
      frame.runtime.allocateArray(frame, array.values.length);
      return new JavaArray(array.elementType, [...array.values]);
    },
  };
}

/** `this` viewed as its superclass, with the type arguments the class gives it. */
function superValue(context: MethodContext): CompiledValue {
  const superclass = context.cls.superclass as ClassInfo;
  return {
    kind: 'value',
    type: asSuper(thisTypeOf(context.cls), superclass) ?? superclass.type,
    run: (frame) => frame.thisObject,
  };
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
