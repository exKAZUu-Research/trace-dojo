import type { FormalParameters, FunctionBody, MethodDeclaration, TypeSyntax } from './ast';
import type { CompiledFunction } from './callCompiler';
import { ClassInfo, type ForwardedArgumentBinder, type Member } from './classes';
import { at } from './compilerBase';
import { EMPTY_ENV } from './constructorCompiler';
import type { ExtensionInfo } from './environment';
import { MetadataCompiler } from './metadataCompiler';
import { Frame, type Runtime, type TypeEnv } from './runtime';
import { asInstanceOf, type DartType, DYNAMIC, type FunctionType, functionType, type TypeParam, VOID } from './types';
import type { Callable, Value } from './values';

export abstract class MemberCompiler extends MetadataCompiler {
  protected declaredMember(
    cls: ClassInfo,
    declaration: MethodDeclaration,
    type: FunctionType,
    firstParameter: DartType | undefined,
    impl: Callable | undefined,
    isAbstract: boolean
  ): Member {
    const { name, methodKind, isStatic, row } = declaration;
    const base = { name, owner: cls, isStatic, isAbstract, row, impl };
    if (methodKind === 'getter') return { ...base, kind: 'getter', type: type.returnType };
    if (methodKind === 'setter') {
      if (declaration.parameters.positional.length !== 1 || declaration.parameters.named.length > 0) {
        this.error(declaration, 'setter の引数は 1 つにしてください。');
      }
      return { ...base, kind: 'setter', type: firstParameter ?? DYNAMIC };
    }
    return {
      ...base,
      kind: 'method',
      type,
      isOperator: methodKind === 'operator',
      nativeParameterNames: declaration.isExternal
        ? declaration.parameters.positional.map((parameter) => parameter.name)
        : undefined,
    };
  }

  /** The function type of a signature, inferring omitted types from the member it overrides. */
  signatureOf(
    parameters: FormalParameters,
    returnTypeSyntax: TypeSyntax | undefined,
    typeParams: TypeParam[],
    options: { cls?: ClassInfo; declaration?: MethodDeclaration; local?: boolean } = {}
  ): { type: FunctionType; positionalTypes: DartType[]; namedTypes: Map<string, DartType> } {
    const { cls, declaration, local } = options;
    const overridden =
      cls && declaration && !declaration.isStatic ? this.overriddenSignature(cls, declaration) : undefined;
    const positionalTypes = parameters.positional.map((parameter, index) => {
      if (parameter.type) return this.resolveType(parameter.type);
      if (overridden?.kind === 'function') return overridden.positional[index] ?? DYNAMIC;
      if (overridden && declaration?.methodKind === 'setter') return overridden;
      return DYNAMIC;
    });
    const namedTypes = new Map(
      parameters.named.map((parameter) => {
        if (parameter.type) return [parameter.name, this.resolveType(parameter.type)];
        const inherited =
          overridden?.kind === 'function'
            ? overridden.named.find((named) => named.name === parameter.name)?.type
            : undefined;
        return [parameter.name, inherited ?? DYNAMIC];
      })
    );
    const returnType = this.signatureReturnType(returnTypeSyntax, local, declaration, overridden);
    const type = functionType(positionalTypes, returnType, {
      requiredCount: parameters.requiredCount,
      named: parameters.named.map((parameter) => ({
        name: parameter.name,
        type: namedTypes.get(parameter.name) ?? DYNAMIC,
        isRequired: parameter.isRequired,
      })),
      typeParams,
    });
    if (parameters.named.length > 1) type.namedOrder = parameters.named.map((parameter) => parameter.name);
    return { type, positionalTypes, namedTypes };
  }

  private signatureReturnType(
    syntax: TypeSyntax | undefined,
    local: boolean | undefined,
    declaration: MethodDeclaration | undefined,
    overridden: DartType | undefined
  ): DartType {
    if (syntax) return local ? this.resolveType(syntax) : this.resolveTypeWithoutAnnotations(syntax);
    if (declaration?.methodKind === 'setter') return VOID;
    if (overridden?.kind === 'function') return overridden.returnType;
    if (overridden && declaration?.methodKind === 'getter') return overridden;
    if (declaration?.methodKind === 'operator' && declaration.name === '[]=') return VOID;
    return DYNAMIC;
  }

  private overriddenSignature(cls: ClassInfo, declaration: MethodDeclaration): DartType | undefined {
    for (const supertype of cls.directSupertypes) {
      const resolved = this.interfaceMember(supertype, declaration.name, declaration.methodKind === 'setter');
      if (resolved) return resolved.type;
    }
    return undefined;
  }

  // code-gauge-allow duplicateLines 20 -- Method binding shares the function specification but has its own receiver and type environment.
  // code-gauge-allow functionCognitiveComplexity 18 -- Each branch is one of the cases Dart distinguishes for this construct.
  // code-gauge-allow functionParameterCount 9 -- The parameters are the parts a caller already holds; grouping them would only rename them.
  protected compileMethodBody(
    cls: ClassInfo,
    owner: ClassInfo | ExtensionInfo,
    declaration: MethodDeclaration,
    member: Member,
    typeParams: TypeParam[],
    positionalTypes: DartType[],
    namedTypes: Map<string, DartType>,
    type: FunctionType
  ): void {
    const { body } = declaration;
    const returnType = body ? type.returnType : VOID;
    const span = at(declaration);
    const compiledBody: FunctionBody = body ?? {
      ...span,
      kind: 'block',
      block: { ...span, kind: 'block', statements: [] },
      modifier: 'sync',
    };
    const extension = owner instanceof ClassInfo ? undefined : owner;
    const declaredClass = extension ? undefined : cls;
    const extensionOn = extension?.onType ?? (cls.kind === 'extensionType' ? cls.thisType : undefined);
    const ownerParams = extension?.typeParams ?? cls.typeParams;
    this.inDeclarationScope(declaredClass, extension, () => {
      const compiled = this.withTypeParams(
        ownerParams,
        () =>
          this.withTypeParams(typeParams, () =>
            this.compileFunction({
              name: declaration.name,
              span: declaration,
              headerEndRow: declaration.headerEndRow,
              parameters: declaration.parameters,
              positionalTypes,
              namedTypes,
              isSetter: declaration.methodKind === 'setter',
              returnType,
              contextReturnType: undefined,
              body: compiledBody,
              typeParams,
              kind: {
                returnType,
                isGenerator: body?.modifier === 'sync*',
                thisClass: declaredClass,
                thisType: declaredClass?.thisType,
                hasThis: !declaration.isStatic,
                extensionOn,
                isInitializer: false,
                isConstructor: false,
              },
              showsThis: !declaration.isStatic && !this.isLibraryCode,
              isClosure: false,
            })
          ),
        declaration.isStatic
      );
      const typeEnvFor = this.methodTypeEnv(declaredClass, ownerParams, typeParams, declaration.isStatic);
      if (member.forwarding)
        member.forwarding.bind = bindForwardedArguments(compiled, declaration.parameters, typeEnvFor);
      if (body && member.kind !== 'field') {
        member.impl = (runtime, receiver, args, typeArgs, callRow) =>
          this.runFunction(compiled, runtime, receiver, [], typeEnvFor(runtime, receiver, typeArgs), args, callRow);
      }
    });
  }

  /**
   * The type environment a method runs in: an extension's type arguments come first among the call's, and a class's
   * come from the receiver.
   */
  private methodTypeEnv(
    ownerClass: ClassInfo | undefined,
    ownerParams: readonly TypeParam[],
    ownTypeParams: readonly TypeParam[],
    isStatic: boolean
  ): (runtime: Runtime, receiver: Value, typeArgs: readonly DartType[]) => TypeEnv {
    if (!ownerClass) {
      return (_runtime, _receiver, typeArgs) => {
        const env = new Map<TypeParam, DartType>();
        for (const [index, param] of ownerParams.entries()) env.set(param, typeArgs[index] ?? DYNAMIC);
        for (const [index, param] of ownTypeParams.entries())
          env.set(param, typeArgs[ownerParams.length + index] ?? DYNAMIC);
        return env;
      };
    }
    return (runtime, receiver, typeArgs) => {
      const typeEnv = isStatic ? new Map() : this.typeEnvOf(runtime, receiver, ownerClass);
      if (ownTypeParams.length === 0) return typeEnv;
      const env = new Map(typeEnv);
      for (const [index, param] of ownTypeParams.entries()) env.set(param, typeArgs[index] ?? DYNAMIC);
      return env;
    };
  }

  /** The class type parameters of a receiver, as an instance of the class whose method runs. */
  typeEnvOf(runtime: Runtime, receiver: Value, cls: ClassInfo): TypeEnv {
    if (cls.typeParams.length === 0) return EMPTY_ENV;
    if (cls.kind === 'extensionType') return EMPTY_ENV;
    const runtimeType = runtime.runtimeTypeOf(receiver);
    const instance = runtimeType.kind === 'interface' ? asInstanceOf(runtimeType, cls) : undefined;
    return new Map(cls.typeParams.map((param, index) => [param, instance?.args[index] ?? DYNAMIC]));
  }
}

function bindForwardedArguments(
  compiled: CompiledFunction,
  params: FormalParameters,
  typeEnvFor: (runtime: Runtime, receiver: Value, typeArgs: readonly DartType[]) => TypeEnv
): ForwardedArgumentBinder {
  const { fn } = compiled;
  return (runtime, receiver, args, typeArgs) => {
    const frame = new Frame(
      runtime,
      fn.info,
      fn.slotCount,
      receiver,
      [],
      typeEnvFor(runtime, receiver, typeArgs),
      undefined
    );
    compiled.bind(frame, { ...args, isDynamic: true });
    const positional = params.positional.map((_, slot) => frame.locals[slot]?.v);
    const named = new Map(
      params.named.map((parameter, index) => [parameter.name, frame.locals[positional.length + index]?.v])
    );
    return { positional, named, isDynamic: false };
  };
}
