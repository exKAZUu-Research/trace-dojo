import { CompileError } from '../interpreter/diagnostics';
import type { Expression, Lambda, MethodReference, Parameter, Span } from './ast';
import { functionalMethodOf, functionObject } from './builtinFunctions';
import { boxedTypeOf } from './builtinWrappers';
import type { CompiledValue, Exec, MethodContext } from './compilerBase';
import { infer, memberBindings, methodView, rawify } from './conversions';
import { checkDefiniteAssignment } from './definiteAssignment';
import { PatternCompiler } from './patternCompiler';
import { canCompleteNormally } from './reachability';
import {
  type ClassInfo,
  type ClassType,
  isPrimitive,
  type JavaType,
  type MethodInfo,
  sameType,
  substitute,
  typeName,
  type TypeVariable,
  upperBound,
} from './types';

/** The functional interface a lambda implements and the signature its body must have. */
interface FunctionType {
  iface: ClassInfo;
  parameterTypes: JavaType[];
  returnType: JavaType;
  method: MethodInfo;
}

/** Compiles lambdas and method references into objects of functional interfaces. */
export abstract class LambdaCompiler extends PatternCompiler {
  protected compileFunctional(
    context: MethodContext,
    expression: Extract<Expression, { kind: 'lambda' | 'methodRef' }>,
    target: JavaType
  ): CompiledValue {
    const functionType = this.functionTypeOf(expression, target);
    const lambda =
      expression.kind === 'lambda' ? expression : this.expandMethodReference(context, expression, functionType);
    return { ...this.compileLambda(context, lambda, functionType), type: target };
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
    const view = methodView(method, memberBindings(bound, method.owner));
    return {
      iface: bound.cls,
      // A parameter of a wildcard type such as `? extends T` takes values of its bound.
      parameterTypes: view.parameterTypes.map((type) => (type.kind === 'wildcard' ? upperBound(type) : type)),
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
      if (!sameType(declared, parameterTypes[index])) {
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
    return {
      kind: 'value',
      type: iface.type,
      run: (frame) => {
        const captured = captures.map((capture) => capture.read(frame));
        const outerThis = frame.thisObject;
        return functionObject(
          frame,
          iface,
          (callFrame, args) => callFrame.runtime.invoke(callFrame, method, outerThis, args, undefined, captured),
          captured,
          outerThis
        );
      },
    };
  }

  protected compileLambdaBody(context: MethodContext, lambda: Lambda, returnType: JavaType): Exec {
    const { body } = lambda;
    if (body.kind === 'block') {
      const exec = this.compileBlock(context, body, false);
      const parameters: Parameter[] = lambda.parameters.map((parameter) => ({
        ...parameter,
        type: parameter.type ?? { kind: 'var', ...parameter },
        isVarargs: false,
      }));
      checkDefiniteAssignment(parameters, body);
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
    const returned = this.compileValueFor(context, body, returnType);
    context.returnedTypes?.push(returned.type);
    const value = this.convert(returned, returnType, 'assignment', body).run;
    return (frame) => ({ kind: 'return', value: value(frame) });
  }

  /**
   * Infers the type parameters of a generic method that its lambda arguments decide through the values they return,
   * as in `stream.map(s -> s.length())`, by compiling each lambda against what the other arguments decide.
   */
  protected inferFromLambdas(
    context: MethodContext,
    method: MethodInfo,
    args: readonly CompiledValue[],
    expressions: readonly Expression[]
  ): Map<TypeVariable, JavaType> | undefined {
    const variables = method.typeParameters ?? [];
    if (variables.length === 0 || !args.some((arg) => arg.type.kind === 'pending')) return;
    if (method.parameterTypes.length !== args.length) return;
    const bindings = new Map<TypeVariable, JavaType>();
    for (const [index, arg] of args.entries()) {
      if (arg.type.kind !== 'pending')
        infer(this.builtins, method.parameterTypes[index], arg.type, variables, bindings);
    }
    for (const [index, arg] of args.entries()) {
      if (arg.type.kind === 'pending') this.inferFromLambda(context, method, index, expressions[index], bindings);
    }
    return bindings;
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
    const bound = upperBound(parameterType);
    const functional = bound.kind === 'class' ? functionalMethodOf(bound.cls, this.builtins.objectClass) : undefined;
    if (!functional) return;
    const unresolved = variables.filter((variable) => !bindings.has(variable));
    // The functional interface's result in terms of the method's type parameters, as in `? extends R`.
    const declared = method.parameterTypes[index] as ClassType;
    const samResult = substitute(functional.returnType, memberBindings(declared, functional.owner));
    const declaredResult =
      samResult.kind === 'wildcard' ? (samResult.isSuper ? undefined : samResult.bound) : samResult;
    if (!declaredResult || !mentionsAny(declaredResult, unresolved)) return;
    const returned = this.lambdaReturnType(context, expression, rawify(parameterType, unresolved, true));
    if (!returned) return;
    const boxedReturn = isPrimitive(returned) ? (boxedTypeOf(this.builtins.wrappers, returned) ?? returned) : returned;
    infer(this.builtins, declaredResult, boxedReturn, variables, bindings);
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
  protected expandMethodReference(
    context: MethodContext,
    reference: MethodReference,
    functionType: FunctionType
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
    const lambdaOf = (body: Expression): Lambda => ({ kind: 'lambda', parameters, body, ...span });
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
    const receiver: Expression = targetType
      ? { kind: 'typeRef', type: targetType, ...span }
      : (target as { expression: Expression }).expression;
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
    if (expression.kind !== 'methodRef' || compiled.type.kind !== 'pending' || expression.name === 'new')
      return compiled;
    const { target } = expression;
    let hint: JavaType | undefined;
    if ('type' in target) hint = this.resolveType(target.type);
    else if (this.namesType(context, target.expression)) {
      const named = this.compileExpression(context, target.expression);
      if (named.kind === 'class') hint = named.cls.type;
    }
    return hint ? { ...compiled, type: { ...compiled.type, receiverHint: hint } } : compiled;
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
