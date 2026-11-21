import type { FormalParameters, FunctionBody, MethodDeclaration, Span, TypeSyntax } from './ast';
import type { CompiledFunction } from './callCompiler';
import {
  ClassInfo,
  covariantSetter,
  type ForwardedArgumentBinder,
  type Member,
  type MethodMember,
  scopedMemberName,
  type SetterMember,
} from './classes';
import { at } from './compilerBase';
import { EMPTY_ENV } from './constructorCompiler';
import type { ExtensionInfo } from './environment';
import { MetadataCompiler } from './metadataCompiler';
import { Frame, type Runtime, type TypeEnv } from './runtime';
import {
  asInstanceOf,
  type DartType,
  DYNAMIC,
  type FunctionType,
  functionType,
  instantiateFunction,
  mentionsCovariantly,
  type TypeParam,
  typeParamType,
  VOID,
} from './types';
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
      this.checkSetterSignature(declaration.parameters, type.returnType, declaration);
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

  protected checkSetterSignature(parameters: FormalParameters, result: DartType, span: Span): void {
    if (parameters.requiredCount !== 1 || parameters.positional.length !== 1 || parameters.named.length > 0)
      this.error(span, 'setter の引数は必須の位置引数 1 つにしてください。');
    if (result.kind !== 'void') this.error(span, 'setter の戻り値の型には void を書くか、省略してください。');
  }

  protected checkCovariantFormals(parameters: FormalParameters): void {
    const covariant = [...parameters.positional, ...parameters.named].find((parameter) => parameter.isCovariant);
    if (covariant) this.error(covariant, 'この引数には covariant を付けられません。');
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
      cls && declaration && !declaration.isStatic ? this.overriddenSignature(cls, declaration, typeParams) : undefined;
    const positionalTypes = parameters.positional.map((parameter, index) => {
      if (parameter.type) return this.resolveType(parameter.type);
      if (overridden && declaration?.methodKind === 'setter') return overridden;
      if (overridden?.kind === 'function') return overridden.positional[index] ?? DYNAMIC;
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
    if (overridden && declaration?.methodKind === 'getter') return overridden;
    if (overridden?.kind === 'function') return overridden.returnType;
    if (declaration?.methodKind === 'operator' && declaration.name === '[]=') return VOID;
    return DYNAMIC;
  }

  private overriddenSignature(
    cls: ClassInfo,
    declaration: MethodDeclaration,
    typeParams: readonly TypeParam[]
  ): DartType | undefined {
    for (const supertype of cls.directSupertypes) {
      const resolved = this.interfaceMember(supertype, declaration.name, declaration.methodKind === 'setter');
      if (!resolved) continue;
      const { member, type } = resolved;
      if (member.kind === 'method' && type.kind === 'function' && type.typeParams.length === typeParams.length)
        return instantiateFunction(
          type,
          typeParams.map((parameter) => typeParamType(parameter))
        );
      return type;
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
              parameterMember: member.kind === 'method' || member.kind === 'setter' ? member : undefined,
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
   * An extension or extension type takes owner arguments from the call. Ordinary classes take them from the receiver.
   */
  private methodTypeEnv(
    ownerClass: ClassInfo | undefined,
    ownerParams: readonly TypeParam[],
    ownTypeParams: readonly TypeParam[],
    isStatic: boolean
  ): (runtime: Runtime, receiver: Value, typeArgs: readonly DartType[]) => TypeEnv {
    if (!ownerClass || (!isStatic && ownerClass.kind === 'extensionType')) {
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

export function markCovariantParameters(
  cls: ClassInfo,
  member: MethodMember | SetterMember,
  params: FormalParameters
): void {
  if (member.kind === 'setter') {
    member.isCovariant = covariantSetter(cls, member.name, member.type, params.positional[0]?.isCovariant === true);
    return;
  }
  const key = scopedMemberName(member.name, (cls.mixinOf ?? cls).library);
  const ownerParams = new Set(cls.typeParams);
  const supers = cls.directSupertypes
    .map(({ cls }) => cls.interfaceMember(key))
    .filter((inherited) => inherited?.kind === 'method');
  const positional = new Set<number>();
  for (const [index, parameter] of params.positional.entries()) {
    if (
      parameter.isCovariant ||
      mentionsCovariantly(member.type.positional[index], ownerParams) ||
      supers.some((inherited) => inherited.covariantPositional?.has(index))
    )
      positional.add(index);
  }
  const named = new Set<string>();
  for (const { name, isCovariant } of params.named) {
    const type = member.type.named.find((parameter) => parameter.name === name)?.type ?? DYNAMIC;
    if (
      isCovariant ||
      mentionsCovariantly(type, ownerParams) ||
      supers.some((inherited) => inherited.covariantNamed?.has(name))
    )
      named.add(name);
  }
  if (positional.size > 0) member.covariantPositional = positional;
  if (named.size > 0) member.covariantNamed = named;
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
    compiled.bind(frame, { ...args, invocation: 'dynamic' });
    const positional = params.positional.map((_, slot) => frame.locals[slot]?.v);
    const named = new Map(
      params.named.map((parameter, index) => [parameter.name, frame.locals[positional.length + index]?.v])
    );
    return { positional, named };
  };
}
