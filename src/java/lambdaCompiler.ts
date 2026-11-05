import { CompileError } from '../interpreter/diagnostics';
import type { Block, Expression, Lambda, MethodReference, Parameter, Span, TypeSyntax } from './ast';
import { functionalMethodOf, functionObject } from './builtinFunctions';
import { boxedTypeOf } from './builtinWrappers';
import type { CompiledValue, Exec, MethodContext } from './compilerBase';
import { infer, inferFromTarget, memberBindings, methodView, rawify } from './conversions';
import { checkDefiniteAssignment } from './definiteAssignment';
import { castOperation } from './operators';
import { PatternCompiler } from './patternCompiler';
import { canCompleteNormally } from './reachability';
import { type Frame, throwBuiltin } from './runtime';
import {
  type ClassInfo,
  type ClassType,
  erasure,
  isPrimitive,
  isReference,
  isWidening,
  type JavaType,
  type MethodInfo,
  sameType,
  substitute,
  typeName,
  type TypeVariable,
  upperBound,
  wildcardBound,
} from './types';
import type { Value } from './values';

/** The functional interface a lambda implements and the signature its body must have. */
interface FunctionType {
  iface: ClassInfo;
  parameterTypes: JavaType[];
  /** Whether each parameter's type is a `? super` wildcard's bound, which an explicit supertype may replace. */
  isLowerBounded: boolean[];
  returnType: JavaType;
  method: MethodInfo;
}

/** The lambdas that method references expand to. */
const referenceLambdas = new WeakSet<Lambda>();

/** Compiles lambdas and method references into objects of functional interfaces. */

export abstract class LambdaCompiler extends PatternCompiler {
  protected compileFunctional(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'lambda' | 'methodRef' }>,
    target: JavaType
  ): CompiledValue {
    const functionType = this.functionTypeOf(expression, target);
    if (expression.kind === 'methodRef' && this.isBoundReference(context, expression)) {
      return { ...this.compileBoundReference(context, expression, functionType), type: target };
    }
    const lambda =
      expression.kind === 'lambda' ? expression : this.expandMethodReference(context, expression, functionType);
    return { ...this.compileLambda(context, lambda, functionType), type: target };
  }

  /** Whether a method reference names a method of a value, as `list::add` does, rather than of a type. */
  protected isBoundReference(context: MethodContext, reference: MethodReference): boolean {
    return (
      reference.name !== 'new' &&
      'expression' in reference.target &&
      !this.namesType(context, reference.target.expression)
    );
  }

  /**
   * Compiles `expression::method`, which evaluates the expression once, when the reference is created, and fails
   * there for null (JLS 15.13.3); the function then calls the method on that value, which it captures from a local
   * of its own.
   */
  protected compileBoundReference(
    context: MethodContext,
    reference: MethodReference,
    functionType: FunctionType
  ): CompiledValue {
    const receiver = this.compileValue(context, (reference.target as { expression: Expression }).expression);
    const name = `\0receiver${context.locals.length}`;
    const slot = this.declareLocal(context, reference, name, receiver.type);
    const lambda = this.expandMethodReference(context, reference, functionType, name);
    const created = this.compileLambda(context, lambda, functionType);
    return {
      ...created,
      run: (frame) => {
        const value = receiver.run(frame);
        if (value === undefined) throwBuiltin(frame, 'NullPointerException');
        frame.locals[slot] = value;
        try {
          return created.run(frame);
        } finally {
          // The function holds the receiver from here on, so the local no longer keeps it alive.
          frame.locals[slot] = undefined;
        }
      },
    };
  }

  protected functionTypeOf(span: Span, target: JavaType): FunctionType {
    const bound = upperBound(target);
    const method = bound.kind === 'class' ? functionalMethodOf(bound.cls, this.builtins.objectClass) : undefined;
    if (bound.kind !== 'class' || !method) {
      return this.error(
        span,
        `${typeName(target)} 型は関数型インターフェースではないので、ラムダ式やメソッド参照は使えません。`
      );
    }
    const bindings = memberBindings(bound, method.owner);
    const view = methodView(method, bindings);
    return {
      iface: bound.cls,
      // A parameter of a wildcard type such as `? extends T` takes values of its bound.
      parameterTypes: view.parameterTypes.map((type) => wildcardBound(type)),
      isLowerBounded: method.parameterTypes.map((type) => {
        const substituted = substitute(type, bindings);
        return substituted.kind === 'wildcard' && substituted.isSuper;
      }),
      returnType: view.returnType,
      method,
    };
  }

  protected compileLambda(
    context: MethodContext,
    lambda: Lambda,
    functionType: FunctionType,
    returnedTypes?: JavaType[]
  ): CompiledValue {
    const { parameterTypes, returnType, iface } = functionType;
    if (lambda.parameters.length !== parameterTypes.length) {
      this.error(
        lambda,
        `このラムダ式には引数が ${parameterTypes.length} 個必要ですが、${lambda.parameters.length} 個書かれています。`
      );
    }
    const lambdaContext: MethodContext = {
      ...this.newContext(context.cls, context.isStatic, returnType, functionType.method.thrownTypes),
      enclosing: context,
      returnedTypes,
    };
    const types = lambda.parameters.map((parameter, index) => {
      if (!parameter.type) return parameterTypes[index];
      const declared = this.resolveType(parameter.type);
      // For `Consumer<? super String>`, `(Object o) -> ...` decides the target `Consumer<Object>` (JLS 18.5.3).
      const isSupertype =
        functionType.isLowerBounded[index] === true &&
        isWidening(parameterTypes[index] as JavaType, declared, this.builtins.objectClass);
      if (!sameType(declared, parameterTypes[index]) && !isSupertype) {
        this.error(
          parameter,
          `ラムダ式の引数 ${parameter.name} の型は ${typeName(parameterTypes[index])} である必要があります。`
        );
      }
      return declared;
    });
    for (const [index, parameter] of lambda.parameters.entries()) {
      this.declareLocal(lambdaContext, parameter, parameter.name, types[index]);
    }
    const body = this.compileLambdaBody(lambdaContext, lambda, returnType);
    const method: MethodInfo = {
      name: 'lambda',
      owner: context.cls,
      parameterTypes: types,
      returnType,
      isStatic: context.isStatic,
      isAbstract: false,
      isConstructor: false,
      access: 'private',
      thrownTypes: [],
      code: {
        locals: lambdaContext.locals,
        run: (frame) => {
          const completion = body(frame);
          return completion?.kind === 'return' ? completion.value : undefined;
        },
      },
    };
    const { captures } = lambdaContext;
    const castArgs = this.argumentCasts(functionType, types);
    return {
      kind: 'value',
      type: iface.type,
      run: (frame) => {
        const captured = captures.map((capture) => capture.read(frame));
        const outerThis = frame.thisObject;
        return functionObject(
          frame,
          iface,
          (callFrame, args) =>
            callFrame.runtime.invoke(callFrame, method, outerThis, castArgs(callFrame, args), undefined, captured),
          captured,
          outerThis,
          context.cls
        );
      },
    };
  }

  protected compileLambdaBody(context: MethodContext, lambda: Lambda, returnType: JavaType): Exec {
    const exec = this.compileLambdaCode(context, lambda, returnType);
    const { body } = lambda;
    const parameters: Parameter[] = lambda.parameters.map((parameter) => ({
      ...parameter,
      type: parameter.type ?? { kind: 'var', ...parameter },
      isVarargs: false,
    }));
    const span = { row: body.row, endRow: body.endRow, start: body.start, end: body.end };
    // An expression body is analyzed as the statement it stands for, so that nested lambdas' captures are checked.
    const block: Block =
      body.kind === 'block'
        ? body
        : { kind: 'block', statements: [{ kind: 'expression', expression: body, ...span }], ...span };
    this.checkCaptures(context, checkDefiniteAssignment(parameters, block));
    return exec;
  }

  private compileLambdaCode(context: MethodContext, lambda: Lambda, returnType: JavaType): Exec {
    const { body } = lambda;
    if (body.kind === 'block') {
      const exec = this.compileBlock(context, body, false);
      if (returnType.kind !== 'void' && canCompleteNormally(body)) {
        this.error(
          { ...body, row: body.endRow },
          'ラムダ式が値を返さずに終わる可能性があります。return 文を書いてください。'
        );
      }
      return exec;
    }
    if (returnType.kind === 'void') {
      if (!['assign', 'update', 'call', 'new'].includes(body.kind)) {
        this.error(
          body,
          '戻り値のないラムダ式の本体には、メソッド呼び出しや代入など、文として書ける式しか書けません。'
        );
      }
      const value = this.compileValue(context, body, true);
      return (frame) => {
        value.run(frame);
        return;
      };
    }
    const compiled = this.compileValueFor(context, body, returnType);
    // A method reference returns the method's erased result, which only its caller's use casts, as on the JVM.
    const returned = referenceLambdas.has(lambda) ? { ...compiled, erasedType: undefined } : compiled;
    context.returnedTypes?.push(returned.type);
    const value = this.convert(returned, returnType, 'assignment', body).run;
    return (frame) => ({ kind: 'return', value: value(frame) });
  }

  /**
   * Casts the arguments a function receives at its interface method's erased parameter types to the lambda's own
   * parameter types, as the JVM's lambda bridge does, so that a value heap pollution put there fails with
   * `ClassCastException` on entry.
   */
  protected argumentCasts(
    functionType: FunctionType,
    types: readonly JavaType[]
  ): (frame: Frame, args: Value[]) => Value[] {
    const casts = types.map((type, index) => {
      const erased = erasure(functionType.method.parameterTypes[index] as JavaType);
      if (!isReference(type) || !isReference(erased) || isWidening(erased, erasure(type), this.builtins.objectClass)) {
        return;
      }
      return castOperation(this.builtins.objectClass, erased, erasure(type));
    });
    if (casts.every((cast) => cast === undefined)) return (_, args) => args;
    return (frame, args) => args.map((arg, index) => casts[index]?.(frame, arg) ?? arg);
  }

  /**
   * Infers the type parameters of a generic method that its lambda arguments decide through the values they return,
   * as in `stream.map(s -> s.length())`, by compiling each lambda against what the other arguments decide.
   */
  protected inferFromLambdas(
    context: MethodContext,
    method: MethodInfo,
    args: readonly CompiledValue[],
    expressions: readonly Expression[],
    targetType?: JavaType
  ): Map<TypeVariable, JavaType> | undefined {
    const variables = method.typeParameters ?? [];
    if (variables.length === 0 || !args.some((arg) => arg.type.kind === 'pending')) return;
    if (method.parameterTypes.length !== args.length) return;
    const bindings = new Map<TypeVariable, JavaType>();
    for (const [index, arg] of args.entries()) {
      if (arg.type.kind !== 'pending')
        infer(this.builtins, method.parameterTypes[index], arg.type, variables, bindings);
    }
    // The target type decides what the other arguments leave open before the lambdas, whose parameters may need it.
    if (targetType && !isPrimitive(targetType)) inferFromTarget(this.builtins, method, targetType, bindings);
    this.inferFromPendingArguments(context, method, args, expressions, bindings);
    return bindings;
  }

  /**
   * Infers from the lambdas and postponed calls among `args`, in a second round too when the first decides something,
   * as `groupingBy(String::length, toList())` decides `T` from the method reference before `toList()` can use it.
   */
  protected inferFromPendingArguments(
    context: MethodContext,
    method: MethodInfo,
    args: readonly CompiledValue[],
    expressions: readonly Expression[],
    bindings: Map<TypeVariable, JavaType>
  ): void {
    for (let round = 0; round < 2; round++) {
      const decided = bindings.size;
      for (const [index, arg] of args.entries()) {
        if (arg.type.kind === 'pending') this.inferFromLambda(context, method, index, expressions[index], bindings);
      }
      if (bindings.size === decided) return;
    }
  }

  /** Infers the type parameters of `method` that the result of its lambda argument at `index` decides. */
  protected inferFromLambda(
    context: MethodContext,
    method: MethodInfo,
    index: number,
    expression: Expression,
    bindings: Map<TypeVariable, JavaType>
  ): void {
    const variables = method.typeParameters ?? [];
    const parameterType = substitute(method.parameterTypes[index], bindings);
    if (expression.kind !== 'lambda' && expression.kind !== 'methodRef') {
      this.inferFromPolyArgument(context, method, index, expression, bindings);
      return;
    }
    const bound = upperBound(parameterType);
    const functional = bound.kind === 'class' ? functionalMethodOf(bound.cls, this.builtins.objectClass) : undefined;
    if (!functional) return;
    const declared = method.parameterTypes[index] as ClassType;
    if (expression.kind === 'lambda')
      this.inferFromLambdaParameters(expression, functional, declared, variables, bindings);
    const unresolved = variables.filter((variable) => !bindings.has(variable));
    if (expression.kind === 'lambda' && waitsForParameterTypes(expression, functional, declared, unresolved)) return;
    // The functional interface's result in terms of the method's type parameters, as in `? extends R`.
    const samResult = substitute(functional.returnType, memberBindings(declared, functional.owner));
    const declaredResult =
      samResult.kind === 'wildcard' ? (samResult.isSuper ? undefined : samResult.bound) : samResult;
    if (!declaredResult || !mentionsAny(declaredResult, unresolved)) return;
    const returned = this.lambdaReturnType(context, expression, rawify(parameterType, unresolved, true, true));
    if (!returned) return;
    const boxedReturn = isPrimitive(returned) ? (boxedTypeOf(this.builtins.wrappers, returned) ?? returned) : returned;
    infer(this.builtins, declaredResult, boxedReturn, variables, bindings);
  }

  /** Infers what a lambda's declared parameter types decide, as `(String s) -> s.length()` decides `T` = `String`. */
  protected inferFromLambdaParameters(
    lambda: Lambda,
    functional: MethodInfo,
    declared: ClassType,
    variables: readonly TypeVariable[],
    bindings: Map<TypeVariable, JavaType>
  ): void {
    if (!lambda.parameters.every((parameter) => parameter.type)) return;
    const bindingsOfDeclared = memberBindings(declared, functional.owner);
    for (const [position, parameter] of lambda.parameters.entries()) {
      const type = functional.parameterTypes[position] as JavaType | undefined;
      if (!type) continue;
      const samParameter = substitute(type, bindingsOfDeclared);
      const target = samParameter.kind === 'wildcard' && samParameter.bound ? samParameter.bound : samParameter;
      infer(this.builtins, target, this.resolveType(parameter.type as TypeSyntax), variables, bindings);
    }
  }

  /**
   * Infers the type parameters of `method` that the type of its postponed call argument at `index` decides, compiling
   * the call against the parameter as far as the other arguments decide it.
   */
  protected inferFromPolyArgument(
    context: MethodContext,
    method: MethodInfo,
    index: number,
    expression: Expression,
    bindings: Map<TypeVariable, JavaType>
  ): void {
    const variables = method.typeParameters ?? [];
    const unresolved = variables.filter((variable) => !bindings.has(variable));
    // Each undecided type argument becomes a hole, which keeps what the other arguments decided, such as `String` in
    // `Collector<? super String, ?, ?>`.
    const holes = new Map(bindings);
    for (const variable of unresolved)
      holes.set(variable, { kind: 'wildcard', bound: undefined, isSuper: false, isHole: true });
    const target = substitute(method.parameterTypes[index], holes);
    try {
      const { type } = this.compileValueFor(context, expression, target);
      infer(this.builtins, method.parameterTypes[index], type, variables, bindings);
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
    }
  }

  /** The type a lambda argument returns when compiled against `target`, or `undefined` when that fails. */
  protected lambdaReturnType(context: MethodContext, expression: Expression, target: JavaType): JavaType | undefined {
    if (expression.kind !== 'lambda' && expression.kind !== 'methodRef') return;
    try {
      const functionType = this.functionTypeOf(expression, target);
      const lambda =
        expression.kind === 'lambda' ? expression : this.expandMethodReference(context, expression, functionType);
      const returnedTypes: JavaType[] = [];
      this.compileLambda(context, lambda, functionType, returnedTypes);
      return returnedTypes.find((type) => type.kind !== 'null');
    } catch (error) {
      if (error instanceof CompileError) return;
      throw error;
    }
  }

  /**
   * Expands a method reference into the lambda it stands for: `Type::method` calls a static method with the
   * arguments or, failing that, an instance method on the first argument; `expression::method` calls it on the value;
   * `Type::new` creates an object or an array.
   */
  // code-gauge-allow functionCognitiveComplexity 19 -- One case per form of method reference.
  protected expandMethodReference(
    context: MethodContext,
    reference: MethodReference,
    functionType: FunctionType,
    receiverLocal?: string
  ): Lambda {
    const span: Span = { row: reference.row, endRow: reference.endRow, start: reference.start, end: reference.end };
    const parameters = functionType.parameterTypes.map((_, index) => ({
      // A name no source can write cannot clash with the program's variables.
      name: `\0${index}`,
      type: undefined,
      isFinal: false,
      ...span,
    }));
    const args = parameters.map((parameter): Expression => ({ kind: 'name', name: parameter.name, ...span }));
    const lambdaOf = (body: Expression): Lambda => {
      const lambda: Lambda = { kind: 'lambda', parameters, body, ...span };
      referenceLambdas.add(lambda);
      return lambda;
    };
    const { target } = reference;
    const targetType = 'type' in target ? target.type : undefined;
    if (reference.name === 'new') {
      if (!targetType) {
        const named = 'expression' in target ? expressionAsType(target.expression) : undefined;
        if (!named) return this.error(reference, 'new のメソッド参照には型を書いてください。');
        return lambdaOf({ kind: 'new', type: named, args, ...span });
      }
      if (targetType.kind === 'array') {
        return lambdaOf({
          kind: 'newArray',
          elementType: targetType.element,
          dimensionLengths: args,
          extraDimensions: 0,
          initializer: undefined,
          ...span,
        });
      }
      return lambdaOf({ kind: 'new', type: targetType, args, ...span });
    }
    const receiver = referenceReceiver(reference, span, receiverLocal);
    const isTypeName = targetType !== undefined || this.namesType(context, receiver);
    const staticForm = lambdaOf({ kind: 'call', object: receiver, name: reference.name, args, ...span });
    if (!isTypeName) return staticForm;
    // A type names a static method that takes all the arguments, or an instance method of the first argument.
    try {
      this.compileLambda(context, staticForm, functionType);
      return staticForm;
    } catch (error) {
      if (!(error instanceof CompileError) || args.length === 0) throw error;
      return lambdaOf({ kind: 'call', object: args[0], name: reference.name, args: args.slice(1), ...span });
    }
  }

  protected override compileArgument(context: MethodContext, expression: Expression): CompiledValue {
    const compiled = super.compileArgument(context, expression);
    if (expression.kind !== 'methodRef' || compiled.type.kind !== 'pending') return compiled;
    const arities = this.referenceArities(context, expression);
    if (expression.name === 'new') return { ...compiled, type: { ...compiled.type, arities } };
    const { target } = expression;
    let hint: JavaType | undefined;
    if ('type' in target) hint = this.resolveType(target.type);
    else if (this.namesType(context, target.expression)) {
      const named = this.compileExpression(context, target.expression);
      if (named.kind === 'class') hint = named.cls.type;
    }
    return { ...compiled, type: { ...compiled.type, arities, receiverHint: hint } };
  }

  /**
   * The numbers of parameters a function type may have for a method reference to name a method (JLS 15.12.2.1):
   * those of a static method, one more than those of an instance method that `Type::method` calls on its first
   * argument, those of an instance method of a value, or those of a constructor; `undefined` allows any number, as a
   * variable arity method or a reference this cannot resolve does.
   */
  protected referenceArities(context: MethodContext, reference: MethodReference): number[] | undefined {
    const { target } = reference;
    const isType = 'type' in target || this.namesType(context, target.expression);
    const owner = this.referenceOwner(context, reference);
    if (!owner) return undefined;
    if (reference.name === 'new' && owner.kind === 'array') return [1];
    const bound = upperBound(owner);
    if (bound.kind !== 'class') return undefined;
    const candidates =
      reference.name === 'new' ? bound.cls.constructors : this.collectMethods(bound.cls, reference.name);
    if (candidates.length === 0 || candidates.some((method) => method.isVarargs)) return undefined;
    return candidates.flatMap((method) => {
      const count = method.parameterTypes.length;
      if (reference.name === 'new' || !isType) return [count];
      return method.isStatic ? [count] : [count + 1];
    });
  }

  /** The type whose methods a method reference names, or `undefined` when it does not compile. */
  protected referenceOwner(context: MethodContext, reference: MethodReference): JavaType | undefined {
    const { target } = reference;
    try {
      if ('type' in target) return this.resolveType(target.type);
      const named = this.compileExpression(context, target.expression);
      return named.kind === 'class' ? named.cls.type : named.type;
    } catch (error) {
      if (error instanceof CompileError) return undefined;
      throw error;
    }
  }

  /** Whether an expression before `::` names a class rather than a value. */
  protected namesType(context: MethodContext, expression: Expression): boolean {
    if (expression.kind !== 'name' && expression.kind !== 'fieldAccess') return false;
    try {
      return this.compileExpression(context, expression).kind === 'class';
    } catch (error) {
      if (error instanceof CompileError) return false;
      throw error;
    }
  }
}

/** What a method reference calls its method on: a type, the local holding a bound receiver, or the expression. */
function referenceReceiver(reference: MethodReference, span: Span, receiverLocal: string | undefined): Expression {
  const { target } = reference;
  if ('type' in target) return { kind: 'typeRef', type: target.type, ...span };
  return receiverLocal ? { kind: 'name', name: receiverLocal, ...span } : target.expression;
}

/** The type that a name or a qualified name before `::new` writes. */
function expressionAsType(expression: Expression): Extract<Lambda['parameters'][number]['type'], object> | undefined {
  const parts: string[] = [];
  let current: Expression | 'super' = expression;
  while (typeof current !== 'string' && current.kind === 'fieldAccess') {
    parts.unshift(current.name);
    current = current.object;
  }
  if (typeof current === 'string' || current.kind !== 'name') return;
  const names = [current.name, ...parts];
  const { row, endRow, start, end } = expression;
  return { kind: 'named', name: names.at(-1) as string, qualifier: names.slice(0, -1), row, endRow, start, end };
}

/** Whether `type` mentions any of `variables`. */
function mentionsAny(type: JavaType, variables: readonly TypeVariable[]): boolean {
  switch (type.kind) {
    case 'typeVar': {
      return variables.includes(type.variable);
    }
    case 'class': {
      return type.args?.some((arg) => mentionsAny(arg, variables)) ?? false;
    }
    case 'array': {
      return mentionsAny(type.element, variables);
    }
    case 'wildcard': {
      return type.bound !== undefined && mentionsAny(type.bound, variables);
    }
    default: {
      return false;
    }
  }
}

/**
 * Whether an implicitly typed lambda's body waits for parameter types that mention undecided type parameters, which a
 * target may decide later (JLS 18.5.2).
 */
function waitsForParameterTypes(
  lambda: Lambda,
  functional: MethodInfo,
  declared: ClassType,
  unresolved: readonly TypeVariable[]
): boolean {
  if (lambda.parameters.every((parameter) => parameter.type)) return false;
  const bindings = memberBindings(declared, functional.owner);
  return functional.parameterTypes.some((type) => mentionsAny(substitute(type, bindings), unresolved));
}
