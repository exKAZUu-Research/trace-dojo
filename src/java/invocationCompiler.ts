import { CompileError } from '../interpreter/diagnostics';
import type { ClassDeclaration, Expression, Span, TypeSyntax } from './ast';
import { getBuiltins } from './builtins';
import { anonymousDeclaration, type Compiled, type CompiledValue, type Eval, type MethodContext } from './compilerBase';
import { infer, isInvocationConvertible, memberBindings, methodView } from './conversions';
import { ExpressionCompiler } from './expressionCompiler';
import { methodDescription, nullMessage } from './nullMessages';
import { superValue, thisValue } from './referenceCompiler';
import { type Frame, throwBuiltin } from './runtime';
import {
  asSuper,
  type ClassInfo,
  erasure,
  isReference,
  isWidening,
  type JavaType,
  type MethodInfo,
  sameType,
  substitute,
  thisTypeOf,
  typeName,
  type TypeVariable,
  upperBound,
} from './types';
import { JavaArray, type JavaObject, type Value } from './values';

/** The methods a call may select and the receiver it evaluates, which is absent for a class name. */
interface CallTarget {
  candidates: MethodInfo[];
  owner: ClassInfo;
  receiver: CompiledValue | undefined;
}

/** Compiles method calls and object creations, including those of inner, local, and anonymous classes. */
export abstract class InvocationCompiler extends ExpressionCompiler {
  /**
   * Declares and compiles a class written inside a method body: a local class, or an anonymous class that extends
   * `anonymousSuperclass` and passes its arguments to `superConstructor`.
   */
  protected abstract compileLocalClass(
    context: MethodContext,
    declaration: ClassDeclaration,
    anonymous?: { superConstructor: MethodInfo | undefined; base: Extract<JavaType, { kind: 'class' }> }
  ): ClassInfo;

  /** Infers what a generic method's lambda arguments decide through the values they return. */
  protected abstract inferFromLambdas(
    context: MethodContext,
    method: MethodInfo,
    args: readonly CompiledValue[],
    expressions: readonly Expression[],
    targetType?: JavaType
  ): Map<TypeVariable, JavaType> | undefined;

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
    const declaration = anonymousDeclaration(expression, expression.body ?? []);
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
        this.noInstanceError(
          context,
          expression,
          'this',
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
  // code-gauge-allow functionCognitiveComplexity 18 -- The target type and the constructor arguments each infer type arguments in turn.
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
    const candidates = this.applicableConstructors(cls, argTypes);
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
      targetType,
      (candidate) => this.inferFromLambdas(context, candidate, args, expression.args, targetType)
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
        erasedType: erasedResultType(declared, method),
        source: { returnOf: methodDescription(this.builtins, method.owner.type, method) },
        run: (frame) => {
          ignored?.run(frame);
          frame.runtime.initializeClass(frame, method.owner);
          return this.invokeWithArguments(frame, declared, undefined, convertedArgs, callRow);
        },
      };
    }
    return this.instanceInvocation(
      target.receiver as CompiledValue,
      method,
      expression.object !== 'super' && method.access !== 'private',
      convertedArgs,
      callRow
    );
  }

  /** Calls an instance method on `receiver`, which `dispatches` to the receiver's override unless the call is exact. */
  protected instanceInvocation(
    receiver: CompiledValue,
    method: MethodInfo,
    dispatches: boolean,
    convertedArgs: Eval[],
    callRow: number
  ): CompiledValue {
    const declared = method.declared ?? method;
    const description = methodDescription(this.builtins, receiver.type, method);
    const message = nullMessage(`Cannot invoke "${description}"`, receiver.source);
    const { run: receive } = this.checkErased(receiver, method.owner.type);
    return {
      kind: 'value',
      type: method.returnType,
      erasedType: erasedResultType(declared, method),
      source: { returnOf: description },
      run: (frame) => {
        const object = receive(frame);
        if (object === undefined) throwBuiltin(frame, 'NullPointerException', message);
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
  /** The constructors that arguments fit once type arguments are erased, of which a diamond needs one to infer from. */
  protected applicableConstructors(cls: ClassInfo, argTypes: readonly JavaType[]): MethodInfo[] {
    return cls.constructors.filter(
      (constructor) =>
        constructor.parameterTypes.length === argTypes.length &&
        constructor.parameterTypes.every((type, index) =>
          isInvocationConvertible(this.builtins, argTypes[index], erasure(type), true)
        )
    );
  }

  protected polyErasureOf(context: MethodContext, expression: Expression): JavaType | undefined {
    try {
      if (expression.kind === 'new') return erasure(this.resolveCreatedType(context, expression));
      if (expression.kind !== 'call') return undefined;
      const candidates = this.resolveCallTarget(context, expression).candidates.filter(
        (method) => method.isVarargs || method.parameterTypes.length === expression.args.length
      );
      const [first, ...others] = candidates.map((method) => erasure(method.returnType));
      return first && others.every((other) => sameType(other, first)) ? first : undefined;
    } catch (error) {
      if (error instanceof CompileError) return undefined;
      throw error;
    }
  }

  protected resolveCallTarget(context: MethodContext, expression: Extract<Expression, { kind: 'call' }>): CallTarget {
    const { object } = expression;
    if (object === 'super') return this.resolveSuperCallTarget(context, expression);
    if (object === undefined) return this.resolveUnqualifiedCallTarget(context, expression);
    const compiled = this.compileExpression(context, object);
    if (compiled.kind === 'class') {
      return {
        candidates: this.collectMethods(compiled.cls, expression.name),
        owner: compiled.cls,
        receiver: undefined,
      };
    }
    const bound = upperBound(compiled.type);
    if (bound.kind === 'array') {
      // An array's clone() returns an array of its own type.
      const { objectClass } = this.builtins;
      const candidates =
        expression.name === 'clone' ? [arrayClone(bound)] : this.collectMethods(objectClass, expression.name);
      return { candidates, owner: objectClass, receiver: compiled };
    }
    if (bound.kind !== 'class')
      return this.error(expression, `${typeName(compiled.type)} 型の値にはメソッドがありません。`);
    // A type variable has the methods of all its bounds.
    const bounds = compiled.type.kind === 'typeVar' ? compiled.type.variable.bounds : [bound];
    const candidates = bounds.flatMap((type) => {
      const upper = upperBound(type);
      return upper.kind === 'class' ? this.viewMethods(this.collectMethods(upper.cls, expression.name), upper) : [];
    });
    return { candidates, owner: bound.cls, receiver: compiled };
  }

  /** `super.m()` or `Interface.super.m()`, which call the superclass's or the interface's method. */
  protected resolveSuperCallTarget(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'call' }>
  ): CallTarget {
    if (context.isStatic)
      this.noInstanceError(context, expression, 'super', 'static メソッドの中では super を使えません。');
    if (expression.superInterface)
      return this.resolveInterfaceSuperCall(context, expression, expression.superInterface);
    if (context.cls.kind === 'interface') this.error(expression, 'インターフェースの中では super を使えません。');
    const owner = context.cls.superclass as ClassInfo;
    const receiver = superValue(context);
    return {
      candidates: this.viewMethods(this.collectMethods(owner, expression.name), receiver.type),
      owner,
      receiver,
    };
  }

  /**
   * `m()`, which calls a method of the class, else of the innermost enclosing class that has one of the name, else
   * one that a static import brings in.
   */
  protected resolveUnqualifiedCallTarget(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'call' }>
  ): CallTarget {
    const receiver = thisValue(context);
    const candidates = this.viewMethods(this.collectMethods(context.cls, expression.name), receiver.type);
    if (candidates.length > 0) return { candidates, owner: context.cls, receiver };
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
    const imported = this.staticallyImported(expression.name, (cls) => {
      const methods = this.collectMethods(cls, expression.name).filter((method) => method.isStatic);
      return methods.length > 0 ? { methods, cls } : undefined;
    });
    if (imported) return { candidates: imported.methods, owner: imported.cls, receiver: undefined };
    return { candidates, owner: context.cls, receiver };
  }

  /** The generic methods instantiated with explicit type arguments, as `obj.<String>m()` calls them. */
  protected withTypeArguments(methods: MethodInfo[], typeArgs: JavaType[]): MethodInfo[] {
    return methods.flatMap((method) => {
      const variables = method.typeParameters ?? [];
      // Java ignores type arguments that a method without type parameters is given.
      if (variables.length === 0) return [method];
      if (variables.length !== typeArgs.length) return [];
      const bindings = new Map(variables.map((variable, index) => [variable, typeArgs[index]]));
      // A type argument outside its variable's bounds makes the method inapplicable, as javac rejects it.
      const isWithinBounds = variables.every((variable, index) =>
        variable.bounds.every((bound) =>
          isWidening(typeArgs[index] as JavaType, substitute(bound, bindings), this.builtins.objectClass)
        )
      );
      if (!isWithinBounds) return [];
      return [{ ...methodView(method, bindings), typeParameters: [], declared: method.declared ?? method }];
    });
  }

  /** `Interface.super.m()`, which calls the default method of a direct superinterface. */
  protected resolveInterfaceSuperCall(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'call' }>,
    syntax: TypeSyntax
  ): CallTarget {
    const type = this.resolveType(syntax);
    if (type.kind !== 'class' || type.cls.kind !== 'interface' || !context.cls.interfaces.includes(type.cls)) {
      return this.error(expression, `${typeName(type)}.super は、直接実装しているインターフェースにしか使えません。`);
    }
    const receiver: CompiledValue = {
      kind: 'value',
      type: asSuper(thisTypeOf(context.cls), type.cls) ?? type,
      run: (frame) => frame.thisObject,
    };
    const candidates = this.collectMethods(type.cls, expression.name).filter((method) => !method.isStatic);
    return { candidates: this.viewMethods(candidates, receiver.type), owner: type.cls, receiver };
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
      this.noInstanceError(
        context,
        expression,
        name,
        `static ではないメソッド ${name} は static メソッドの中から呼び出せません。`
      );
    }
    if (expression.object === 'super' && method.isAbstract) {
      this.error(expression, `抽象メソッド ${name} は super から呼び出せません。`);
    }
  }
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

/** The erasure of a generic method's declared result, when it is less than the type the call instantiates. */
function erasedResultType(declared: MethodInfo, method: MethodInfo): JavaType | undefined {
  const erased = erasure(declared.returnType);
  return isReference(erased) && !sameType(erased, erasure(method.returnType)) ? erased : undefined;
}
