import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker, Mapper } from './checker';
import { named, skipParentheses } from './syntax';
import {
  anyType,
  errorType,
  isAnyLike,
  isIntrinsic,
  type ObjectType,
  regularOf,
  type Signature,
  type Type,
  type TypeParameter,
  undefinedType,
  unionOf,
  unknownType,
  voidType,
} from './types';

interface Inference {
  candidates: Type[];
  contravariant: Type[];
  /** Whether a candidate came from a position where the parameter is the whole type, not part of one. */
  topLevel: boolean;
}

interface Resolution {
  signature: Signature;
  returnType: Type;
}

const functionExpressionTypes = new Set(['arrow_function', 'function_expression']);

/** Resolves calls and `new` expressions: overloads, type argument inference, and argument checks. */
export class Calls {
  /** The signature each call resolved to, for the type predicates that narrow its arguments. */
  private readonly resolved = new Map<number, Signature>();

  constructor(private readonly c: Checker) {}

  // code-gauge-allow functionCognitiveComplexity 30 -- Follows TypeScript's checks of a call's callee.
  call(node: TreeNode, contextual?: Type): Type {
    const callee = node.childForFieldName('function') as TreeNode;
    const argumentsNode = node.childForFieldName('arguments');
    const args = argumentsNode ? named(argumentsNode) : [];
    if (callee.type === 'super') return this.c.classes.superCall(node, args);
    if (callee.type === 'import') {
      for (const arg of args) this.c.expressions.check(arg);
      return anyType;
    }
    const optional = node.childForFieldName('optional_chain') !== null;
    if (this.isEvolvingPush(callee)) {
      const object = callee.childForFieldName('object') as TreeNode;
      for (const arg of args) this.c.expressions.evolve(object, this.c.expressions.check(arg));
      return this.c.globalType('Number').resolve() && anyType;
    }
    const chained = this.c.expressions.chainedCalleeType(callee);
    let calleeType = chained ?? this.c.expressions.check(callee);
    if (calleeType === errorType) {
      for (const arg of args) this.c.expressions.check(arg);
      return errorType;
    }
    if (optional) calleeType = this.c.relations.removeNullish(calleeType);
    else if (!isAnyLike(calleeType) && this.c.relations.isNullable(calleeType)) {
      const what = isIntrinsic(this.c.relations.removeUndefined(calleeType), 'never')
        ? 'undefined'
        : this.c.relations.isNullable(this.c.relations.removeUndefined(calleeType))
          ? 'null'
          : 'undefined';
      this.c.error(callee, `${what} の可能性があるオブジェクトは呼び出せません。`);
      calleeType = this.c.relations.removeNullish(calleeType);
    }
    if (isAnyLike(calleeType)) {
      for (const arg of args) this.c.expressions.check(arg);
      return anyType;
    }
    if (isIntrinsic(calleeType, 'unknown')) {
      this.c.error(
        callee,
        this.isName(callee) ? `'${callee.text}' の型は 'unknown' です。` : "オブジェクトの型は 'unknown' です。"
      );
      for (const arg of args) this.c.expressions.check(arg);
      return errorType;
    }
    const signatures = this.callSignatures(calleeType);
    if (signatures.length === 0) {
      for (const arg of args) this.c.expressions.check(arg);
      // A value of type `Function` may be called with anything, returning `any`.
      if (calleeType.kind === 'object' && this.c.relations.isAssignable(calleeType, this.c.globalType('Function')))
        return anyType;
      if (this.c.signaturesOf(calleeType, 'construct').length > 0) {
        this.c.error(callee, `型 '${this.c.print(calleeType)}' の値は呼び出せません。new を付けるつもりでしたか？`);
      } else {
        this.c.error(
          callee,
          `この式は呼び出せません。型 '${this.c.print(calleeType)}' には呼び出しのシグネチャがありません。`
        );
      }
      return errorType;
    }
    const typeArguments = this.explicitTypeArguments(node);
    const resolution = this.resolve(node, callee, signatures, args, typeArguments, contextual);
    if (!resolution) return errorType;
    this.resolved.set(node.id, resolution.signature);
    const result = resolution.returnType;
    if (chained) return unionOf([result, undefinedType]);
    return optional && this.c.relations.isNullable(this.c.silently(() => this.c.expressions.check(callee)))
      ? unionOf([result, undefinedType])
      : result;
  }

  private isName(node: TreeNode): boolean {
    return node.type === 'identifier';
  }

  private isEvolvingPush(callee: TreeNode): boolean {
    if (callee.type !== 'member_expression') return false;
    const property = callee.childForFieldName('property')?.text;
    if (property !== 'push' && property !== 'unshift') return false;
    return this.c.expressions.isEvolvingArray(callee.childForFieldName('object') as TreeNode);
  }

  /** The call signatures of a type; for a union, those every member has alike. */
  private callSignatures(type: Type): Signature[] {
    if (type.kind !== 'union') return this.c.signaturesOf(type, 'call');
    const perMember = type.types.map((member) => this.c.signaturesOf(member, 'call'));
    if (perMember.some((signatures) => signatures.length === 0)) return [];
    if (perMember.every((signatures) => signatures.length === 1)) {
      const [first, ...rest] = perMember.map((signatures) => signatures[0]);
      if (
        rest.every(
          (signature) =>
            signature.parameters.length === first.parameters.length &&
            signature.typeParameters.length === 0 &&
            first.typeParameters.length === 0
        )
      ) {
        return [
          {
            typeParameters: [],
            parameters: first.parameters.map((parameter, index) => ({
              ...parameter,
              type: this.intersectParameters([first, ...rest].map((signature) => signature.parameters[index].type)),
            })),
            returnType: () => unionOf([first, ...rest].map((signature) => signature.returnType())),
          },
        ];
      }
    }
    return perMember[0];
  }

  private intersectParameters(types: Type[]): Type {
    let result = types[0];
    for (const type of types.slice(1)) {
      if (this.c.relations.isAssignable(type, result)) result = type;
    }
    return result;
  }

  private explicitTypeArguments(node: TreeNode): Type[] | undefined {
    const argumentsNode = node.childForFieldName('type_arguments');
    return argumentsNode ? named(argumentsNode).map((argument) => this.c.typeFromNode(argument)) : undefined;
  }

  newExpression(node: TreeNode, contextual?: Type): Type {
    const callee = node.childForFieldName('constructor') as TreeNode;
    const argumentsNode = node.childForFieldName('arguments');
    const args = argumentsNode ? named(argumentsNode) : [];
    const calleeType = this.c.expressions.check(callee);
    if (calleeType === errorType || isAnyLike(calleeType)) {
      for (const arg of args) this.c.expressions.check(arg);
      return calleeType === errorType ? errorType : anyType;
    }
    const signatures = this.c.signaturesOf(calleeType, 'construct');
    if (signatures.length === 0) {
      for (const arg of args) this.c.expressions.check(arg);
      this.c.error(
        callee,
        `この式は new で呼び出せません。型 '${this.c.print(calleeType)}' には new のシグネチャがありません。`
      );
      return errorType;
    }
    if (
      signatures.every((signature) => signature.isAbstract) ||
      (calleeType.kind === 'object' && calleeType.classInfo?.isAbstract && calleeType.isClassStatic)
    ) {
      this.c.error(node, '抽象クラスのインスタンスは作れません。');
    }
    this.c.classes.checkConstructorAccessibility(node, calleeType);
    const resolution = this.resolve(node, callee, signatures, args, this.explicitTypeArguments(node), contextual);
    return resolution?.returnType ?? errorType;
  }

  /** Resolves a call to one of `signatures`, as `super(...)` does with its base class's constructors. */
  resolveWith(node: TreeNode, callee: TreeNode, signatures: Signature[], args: TreeNode[]): Type {
    return this.resolve(node, callee, signatures, args, undefined, undefined)?.returnType ?? errorType;
  }

  /** The type predicate a call's resolved signature has, with the expression it narrows. */
  predicateOf(node: TreeNode): { target: TreeNode; type: Type } | undefined {
    const signature = this.resolved.get(node.id);
    const predicate = signature?.predicate;
    if (!predicate) return undefined;
    if (predicate.index === -1) {
      const callee = skipParentheses(node.childForFieldName('function') as TreeNode);
      const object = callee.type === 'member_expression' ? callee.childForFieldName('object') : undefined;
      return object ? { target: object, type: predicate.type } : undefined;
    }
    const argumentsNode = node.childForFieldName('arguments');
    const target = argumentsNode ? named(argumentsNode)[predicate.index] : undefined;
    return target ? { target, type: predicate.type } : undefined;
  }

  // Resolution ---------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 30 -- Tries each overload as TypeScript does.
  private resolve(
    node: TreeNode,
    callee: TreeNode,
    signatures: Signature[],
    args: TreeNode[],
    typeArguments: Type[] | undefined,
    contextual: Type | undefined
  ): Resolution | undefined {
    const candidates = typeArguments
      ? signatures.filter(
          (signature) =>
            signature.typeParameters.length >= typeArguments.length &&
            signature.typeParameters.filter((parameter) => !parameter.default).length <= typeArguments.length
        )
      : signatures;
    if (typeArguments && candidates.length === 0) {
      for (const arg of args) this.c.expressions.check(arg);
      const counts = [...new Set(signatures.map((signature) => signature.typeParameters.length))];
      this.c.error(node, `型引数は ${counts.join(' か ')} 個必要ですが、${typeArguments.length} 個渡されています。`);
      return undefined;
    }
    const argumentTypes = new Map<number, Type>();
    for (const candidate of candidates) {
      if (!this.arityMatches(candidate, args)) continue;
      const instantiated = this.c.silently(() =>
        this.instantiateFor(candidate, args, typeArguments, contextual, argumentTypes)
      );
      if (this.c.silently(() => this.argumentsMatch(instantiated, args))) {
        const final = this.instantiateFor(candidate, args, typeArguments, contextual, argumentTypes);
        this.checkArguments(final, args, true);
        if (typeArguments)
          this.c.checkTypeArgumentConstraints(
            node,
            candidate.typeParameters,
            this.fillTypeArguments(candidate, typeArguments)
          );
        return { signature: final, returnType: final.returnType() };
      }
    }
    // No overload accepts the arguments: report as TypeScript does, for the only signature or for the call.
    if (candidates.length === 1) {
      const candidate = candidates[0];
      if (!this.arityMatches(candidate, args)) {
        this.reportArity(node, callee, candidate, args);
        for (const arg of args) this.c.expressions.check(arg);
        return {
          signature: candidate,
          returnType: this.c
            .silently(() => this.instantiateFor(candidate, args, typeArguments, contextual, argumentTypes))
            .returnType(),
        };
      }
      const instantiated = this.instantiateFor(candidate, args, typeArguments, contextual, argumentTypes);
      this.checkArguments(instantiated, args, true);
      return { signature: instantiated, returnType: instantiated.returnType() };
    }
    const byArity = candidates.filter((candidate) => this.arityMatches(candidate, args));
    if (byArity.length === 0) {
      const minimum = Math.min(...candidates.map((candidate) => this.minimumArguments(candidate)));
      const maximum = Math.max(...candidates.map((candidate) => this.maximumArguments(candidate)));
      for (const arg of args) this.c.expressions.check(arg);
      this.c.error(
        args.length > maximum ? args[maximum] : node,
        maximum === Number.POSITIVE_INFINITY || minimum === maximum
          ? `引数は ${minimum} 個必要ですが、${args.length} 個渡されています。`
          : `引数は ${minimum} 個から ${maximum} 個必要ですが、${args.length} 個渡されています。`
      );
      return { signature: candidates[0], returnType: candidates[0].returnType() };
    }
    for (const arg of args) this.c.expressions.check(arg);
    this.c.error(
      callee.type === 'member_expression' ? (callee.childForFieldName('property') ?? node) : node,
      'この呼び出しに合うオーバーロードがありません。'
    );
    const last = byArity.at(-1) as Signature;
    return {
      signature: last,
      returnType: this.c
        .silently(() => this.instantiateFor(last, args, typeArguments, contextual, argumentTypes))
        .returnType(),
    };
  }

  private fillTypeArguments(signature: Signature, typeArguments: Type[]): Type[] {
    return signature.typeParameters.map(
      (parameter, index) => typeArguments[index] ?? parameter.default?.() ?? unknownType
    );
  }

  private minimumArguments(signature: Signature): number {
    let minimum = 0;
    for (const [index, parameter] of signature.parameters.entries()) {
      if (!parameter.optional && !parameter.rest && !this.acceptsUndefinedOnly(parameter.type)) minimum = index + 1;
    }
    return minimum;
  }

  /** Whether a trailing parameter's type is `void`, which lets callers omit it. */
  private acceptsUndefinedOnly(type: Type): boolean {
    return isIntrinsic(type, 'void');
  }

  private maximumArguments(signature: Signature): number {
    return signature.parameters.some((parameter) => parameter.rest)
      ? Number.POSITIVE_INFINITY
      : signature.parameters.length;
  }

  private spreadLength(arg: TreeNode): number | undefined {
    if (arg.type !== 'spread_element') return 1;
    const type = this.c.silently(() => this.c.expressions.check(named(arg)[0]));
    if (
      type.kind === 'object' &&
      type.objectKind === 'tuple' &&
      !(type.tuple?.elements ?? []).some((element) => element.rest || element.optional)
    )
      return type.tuple?.elements.length;
    return undefined;
  }

  private arityMatches(signature: Signature, args: TreeNode[]): boolean {
    let count = 0;
    let open = false;
    for (const arg of args) {
      const length = this.spreadLength(arg);
      if (length === undefined) open = true;
      else count += length;
    }
    if (open)
      return this.maximumArguments(signature) === Number.POSITIVE_INFINITY && count <= this.maximumArguments(signature);
    return count >= this.minimumArguments(signature) && count <= this.maximumArguments(signature);
  }

  private reportArity(node: TreeNode, callee: TreeNode, signature: Signature, args: TreeNode[]): void {
    const minimum = this.minimumArguments(signature);
    const maximum = this.maximumArguments(signature);
    const spread = args.find((arg) => arg.type === 'spread_element' && this.spreadLength(arg) === undefined);
    if (spread && maximum !== Number.POSITIVE_INFINITY) {
      this.c.error(spread, 'スプレッド構文の引数は、タプル型であるか、残余引数に渡されなければいけません。');
      return;
    }
    const message =
      maximum === Number.POSITIVE_INFINITY
        ? `引数は少なくとも ${minimum} 個必要ですが、${args.length} 個渡されています。`
        : minimum === maximum
          ? `引数は ${minimum} 個必要ですが、${args.length} 個渡されています。`
          : `引数は ${minimum} 個から ${maximum} 個必要ですが、${args.length} 個渡されています。`;
    const at =
      args.length > maximum
        ? args[maximum]
        : callee.type === 'member_expression'
          ? (callee.childForFieldName('property') ?? node)
          : node;
    this.c.error(at, message);
  }

  /** The parameter type an argument at `index` is passed to. */
  parameterTypeAt(signature: Signature, index: number): Type | undefined {
    const { parameters } = signature;
    if (index < parameters.length) {
      const parameter = parameters[index];
      return parameter.rest ? this.c.restElementType(parameter.type) : parameter.type;
    }
    const last = parameters.at(-1);
    return last?.rest ? this.c.restElementType(last.type) : undefined;
  }

  private argumentsMatch(signature: Signature, args: TreeNode[]): boolean {
    return this.checkArguments(signature, args, false);
  }

  /** Checks each argument against its parameter, reporting mismatches when `report`. */
  private checkArguments(signature: Signature, args: TreeNode[], report: boolean): boolean {
    let ok = true;
    let index = 0;
    for (const arg of args) {
      if (arg.type === 'spread_element') {
        const spreadType = this.c.expressions.check(named(arg)[0]);
        if (spreadType.kind === 'object' && spreadType.objectKind === 'tuple') {
          for (const element of spreadType.tuple?.elements ?? []) {
            const parameterType = this.parameterTypeAt(signature, index);
            if (parameterType && !this.c.relations.isAssignable(element.type, parameterType)) {
              if (report) this.c.expressions.reportNotAssignable(arg, element.type, parameterType);
              ok = false;
            }
            index++;
          }
          continue;
        }
        const element = this.c.expressions.iteratedType(arg, spreadType);
        const parameterType = this.parameterTypeAt(signature, index);
        if (parameterType && !this.c.relations.isAssignable(element, parameterType)) {
          if (report) this.reportArgument(arg, element, parameterType);
          ok = false;
        }
        index++;
        continue;
      }
      const parameterType = this.parameterTypeAt(signature, index);
      const argType = this.c.expressions.check(arg, parameterType);
      if (parameterType) {
        if (!this.c.relations.isAssignable(argType, parameterType)) {
          // TypeScript reports the first argument that does not fit.
          if (report && ok) this.reportArgument(arg, argType, parameterType);
          ok = false;
        } else if (report) {
          this.c.expressions.checkExcessProperties(arg, argType, parameterType);
        }
      }
      index++;
    }
    return ok;
  }

  private reportArgument(arg: TreeNode, argType: Type, parameterType: Type): void {
    this.c.error(
      arg,
      `型 '${this.c.print(this.c.widenLiteralForMessage(argType, parameterType))}' の引数を型 '${this.c.print(parameterType)}' のパラメーターに渡すことはできません。`
    );
  }

  // Inference ----------------------------------------------------------------------------------------------------

  /** A signature with its type parameters replaced by the given or inferred type arguments. */
  private instantiateFor(
    signature: Signature,
    args: TreeNode[],
    typeArguments: Type[] | undefined,
    contextual: Type | undefined,
    cache: Map<number, Type>
  ): Signature {
    void cache;
    if (signature.typeParameters.length === 0) return signature;
    if (typeArguments) {
      const filled = this.fillTypeArguments(signature, typeArguments);
      const mapper: Mapper = new Map(signature.typeParameters.map((parameter, index) => [parameter.id, filled[index]]));
      return { ...this.c.instantiateSignature(signature, mapper), typeParameters: [] };
    }
    const parameters = signature.typeParameters;
    const inferences = new Map<number, Inference>(
      parameters.map((parameter) => [parameter.id, { candidates: [], contravariant: [], topLevel: false }])
    );
    // Context-insensitive arguments infer first; functions without parameter annotations then see what they inferred.
    const sensitive = args.map((arg) => this.isContextSensitive(arg));
    const inferFromArgument = (arg: TreeNode, index: number, mapper: Mapper | undefined): void => {
      const parameterType = this.parameterTypeAt(signature, index);
      if (!parameterType) return;
      const context = mapper ? this.c.instantiate(parameterType, mapper) : parameterType;
      const argType = this.c.silently(() => this.c.expressions.check(arg, context));
      this.inferTypes(inferences, parameters, argType, parameterType, true);
    };
    let index = 0;
    for (const [argIndex, arg] of args.entries()) {
      if (arg.type === 'spread_element') {
        const spreadType = this.c.silently(() => this.c.expressions.check(named(arg)[0]));
        const element = this.c.silently(() => this.c.expressions.iteratedType(undefined, spreadType));
        const parameterType = this.parameterTypeAt(signature, index);
        if (parameterType) this.inferTypes(inferences, parameters, element, parameterType, true);
        index++;
        continue;
      }
      if (!sensitive[argIndex]) inferFromArgument(arg, index, this.partialMapper(parameters, inferences));
      index++;
    }
    if (contextual) {
      const returnType = signature.returnType();
      this.inferTypes(inferences, parameters, contextual, returnType, false, true);
    }
    index = 0;
    for (const [argIndex, arg] of args.entries()) {
      if (sensitive[argIndex]) inferFromArgument(arg, index, this.partialMapper(parameters, inferences, true));
      index++;
    }
    const mapper = this.finalMapper(signature, parameters, inferences);
    return { ...this.c.instantiateSignature(signature, mapper), typeParameters: [] };
  }

  private isContextSensitive(arg: TreeNode): boolean {
    const expression = skipParentheses(arg);
    if (functionExpressionTypes.has(expression.type)) {
      const parametersNode = expression.childForFieldName('parameters');
      if (expression.childForFieldName('parameter')) return true;
      return parametersNode ? named(parametersNode).some((parameter) => !parameter.childForFieldName('type')) : false;
    }
    if (expression.type === 'object')
      return named(expression).some(
        (member) =>
          member.type === 'method_definition' ||
          (member.type === 'pair' && this.isContextSensitive(member.childForFieldName('value') as TreeNode))
      );
    if (expression.type === 'array') return named(expression).some((element) => this.isContextSensitive(element));
    return false;
  }

  /** The inferences so far as a mapper; with `fixing`, a parameter without one becomes its constraint or `unknown`. */
  private partialMapper(
    parameters: TypeParameter[],
    inferences: Map<number, Inference>,
    fixing = false
  ): Mapper | undefined {
    const mapper: Mapper = new Map();
    for (const parameter of parameters) {
      const inference = inferences.get(parameter.id);
      if (inference && (inference.candidates.length > 0 || inference.contravariant.length > 0)) {
        mapper.set(parameter.id, this.inferredType(parameter, inference, false));
      } else if (fixing) {
        mapper.set(parameter.id, parameter.constraint?.() ?? unknownType);
      }
    }
    return mapper.size > 0 ? mapper : undefined;
  }

  private finalMapper(signature: Signature, parameters: TypeParameter[], inferences: Map<number, Inference>): Mapper {
    const mapper: Mapper = new Map();
    for (const parameter of parameters) {
      const inference = inferences.get(parameter.id) as Inference;
      let type: Type =
        inference.candidates.length > 0 || inference.contravariant.length > 0
          ? this.inferredType(parameter, inference, !this.isTopLevelInReturn(signature, parameter))
          : (parameter.default?.() ?? parameter.constraint?.() ?? unknownType);
      const constraint = parameter.constraint?.();
      if (constraint && !this.c.relations.isAssignable(type, this.c.instantiate(constraint, mapper))) {
        type = this.c.instantiate(constraint, mapper);
      }
      mapper.set(parameter.id, type);
    }
    return mapper;
  }

  private isTopLevelInReturn(signature: Signature, parameter: TypeParameter): boolean {
    const returnType = signature.returnType();
    return (returnType.kind === 'union' ? returnType.types : [returnType]).some(
      (member) => member.kind === 'typeParameter' && member.id === parameter.id
    );
  }

  private inferredType(parameter: TypeParameter, inference: Inference, widen: boolean): Type {
    if (inference.candidates.length === 0) {
      return inference.contravariant[0];
    }
    const constraint = parameter.constraint?.();
    const primitiveConstraint =
      constraint !== undefined &&
      (constraint.kind === 'union' ? constraint.types : [constraint]).some(
        (member) =>
          (member.kind === 'intrinsic' && ['string', 'number', 'bigint', 'boolean'].includes(member.name)) ||
          member.kind === 'literal'
      );
    const shouldWiden = widen && inference.topLevel && !primitiveConstraint;
    const candidates = inference.candidates.map((candidate) =>
      shouldWiden ? this.c.widenLiteral(candidate) : regularOf(candidate)
    );
    const supertype = candidates.find((candidate) =>
      candidates.every((other) => this.c.relations.isAssignable(other, candidate))
    );
    if (supertype) return this.widenObjectLiterals(supertype);
    // Literals of one primitive unite, as `1` and `2` give `1 | 2` (or `number` when widened).
    if (
      candidates.every(
        (candidate) =>
          candidate.kind === 'literal' || isIntrinsic(candidate, 'undefined') || isIntrinsic(candidate, 'null')
      )
    ) {
      const kinds = new Set(
        candidates
          .filter((candidate) => candidate.kind === 'literal')
          .map((candidate) => typeof (candidate as { value: unknown }).value)
      );
      if (kinds.size <= 1) return unionOf(candidates);
    }
    return this.widenObjectLiterals(candidates[0]);
  }

  private widenObjectLiterals(type: Type): Type {
    return this.c.expressions.widenDeclared(type, true);
  }

  /** Collects the types `source` gives the type parameters that `target` mentions. */
  // code-gauge-allow functionCognitiveComplexity 40 -- One case per kind of type that inference descends into.
  private inferTypes(
    inferences: Map<number, Inference>,
    parameters: TypeParameter[],
    source: Type,
    target: Type,
    covariant: boolean,
    lowPriority = false,
    depth = 0
  ): void {
    if (depth > 8) return;
    const recurse = (s: Type, t: Type, isCovariant = covariant): void =>
      this.inferTypes(inferences, parameters, s, t, isCovariant, lowPriority, depth + 1);
    if (target.kind === 'typeParameter') {
      const inference = inferences.get(target.id);
      if (!inference) return;
      if (source === errorType || isIntrinsic(source, 'never')) return;
      if (lowPriority && inference.candidates.length > 0) return;
      if (covariant) {
        if (!inference.candidates.some((candidate) => candidate.id === source.id)) inference.candidates.push(source);
        if (depth === 0) inference.topLevel = true;
      } else {
        inference.contravariant.push(source);
      }
      return;
    }
    if (isAnyLike(source) && depth > 0) {
      // `any` infers `any` for every parameter the target mentions.
      for (const parameter of parameters) {
        if (this.mentions(target, parameter)) recurse(source, parameter);
      }
      return;
    }
    if (target.kind === 'union') {
      const naked = target.types.filter((member) => member.kind === 'typeParameter' && inferences.has(member.id));
      const others = target.types.filter((member) => !naked.includes(member));
      const sourceMembers = source.kind === 'union' ? source.types : [source];
      const remaining = sourceMembers.filter(
        (member) =>
          !others.some((other) => !this.c.relations.isGeneric(other) && this.c.relations.isAssignable(member, other))
      );
      for (const other of others) {
        if (this.c.relations.isGeneric(other)) for (const member of sourceMembers) recurse(member, other);
      }
      if (naked.length === 1 && remaining.length > 0) recurse(unionOf(remaining, true), naked[0]);
      return;
    }
    if (target.kind === 'intersection') {
      for (const member of target.types) recurse(source, member);
      return;
    }
    if (source.kind === 'union') {
      for (const member of source.types) recurse(member, target);
      return;
    }
    if (target.kind === 'indexedAccess' || target.kind === 'conditional' || target.kind === 'keyof') return;
    if (target.kind === 'templateLiteral') return;
    if (target.kind !== 'object') return;
    if (source.kind !== 'object' && source.kind !== 'intersection') {
      if (source.kind === 'literal' || source.kind === 'intrinsic') {
        const apparent = this.c.apparentType(source);
        if (apparent.kind === 'object' && target.objectKind !== 'reference') recurse(apparent, target);
      }
      return;
    }
    if (target.objectKind === 'mapped' && target.mapped) {
      const { constraint, template } = target.mapped;
      if (constraint.kind === 'keyof' && template.kind === 'indexedAccess') {
        recurse(source, constraint.type);
      }
      return;
    }
    if (
      source.kind === 'object' &&
      source.objectKind === 'reference' &&
      target.objectKind === 'reference' &&
      source.target === target.target
    ) {
      const sourceArguments = source.typeArguments ?? [];
      for (const [index, argument] of (target.typeArguments ?? []).entries()) {
        if (sourceArguments[index]) recurse(sourceArguments[index], argument);
      }
      return;
    }
    if (
      source.kind === 'object' &&
      this.c.isArrayOrTuple(source) &&
      target.objectKind === 'reference' &&
      this.isArrayLike(target)
    ) {
      recurse(this.c.elementTypeOf(source), (target.typeArguments ?? [])[0] ?? anyType);
      return;
    }
    if (source.kind === 'object' && source.objectKind === 'tuple' && target.objectKind === 'tuple') {
      const sourceElements = source.tuple?.elements ?? [];
      for (const [index, element] of (target.tuple?.elements ?? []).entries()) {
        if (element.rest) {
          recurse(this.c.tupleType(sourceElements.slice(index)), element.type);
          break;
        }
        if (sourceElements[index]) recurse(sourceElements[index].type, element.type);
      }
      return;
    }
    const targetStructure = target.resolve();
    const sourceStructure = this.c.structureOf(source);
    for (const [name, property] of targetStructure.properties) {
      const sourceProperty = sourceStructure.properties.get(name) ?? this.c.propertyOf(source, name);
      if (sourceProperty) recurse(sourceProperty.type(), property.type());
    }
    const targetSignatures = targetStructure.callSignatures;
    const sourceSignatures = sourceStructure.callSignatures;
    if (targetSignatures.length > 0 && sourceSignatures.length > 0) {
      const sourceSignature = sourceSignatures.at(-1) as Signature;
      const targetSignature = targetSignatures.at(-1) as Signature;
      this.inferFromSignatures(sourceSignature, targetSignature, recurse);
    }
    const sourceConstruct = sourceStructure.constructSignatures;
    const targetConstruct = targetStructure.constructSignatures;
    if (sourceConstruct.length > 0 && targetConstruct.length > 0) {
      this.inferFromSignatures(sourceConstruct.at(-1) as Signature, targetConstruct.at(-1) as Signature, recurse);
    }
    if (targetStructure.stringIndex) {
      const sourceIndex =
        sourceStructure.stringIndex?.type ??
        (source.kind === 'object' && source.isLiteral
          ? unionOf([...sourceStructure.properties.values()].map((property) => property.type()))
          : undefined);
      if (sourceIndex) recurse(sourceIndex, targetStructure.stringIndex.type);
    }
    if (targetStructure.numberIndex) {
      const sourceIndex = sourceStructure.numberIndex?.type ?? sourceStructure.stringIndex?.type;
      if (sourceIndex) recurse(sourceIndex, targetStructure.numberIndex.type);
    }
  }

  private inferFromSignatures(
    source: Signature,
    target: Signature,
    recurse: (s: Type, t: Type, covariant?: boolean) => void
  ): void {
    const count = Math.min(source.parameters.length, target.parameters.length);
    for (let index = 0; index < count; index++) {
      recurse(source.parameters[index].type, target.parameters[index].type, false);
    }
    const targetReturn = target.returnType();
    if (!isIntrinsic(targetReturn, 'void')) recurse(source.returnType(), targetReturn, true);
    else if (isIntrinsic(source.returnType(), 'void')) recurse(voidType, targetReturn, true);
    if (source.predicate && target.predicate) recurse(source.predicate.type, target.predicate.type, true);
  }

  private isArrayLike(type: ObjectType): boolean {
    return ['Array', 'ReadonlyArray', 'Iterable', 'ArrayLike', 'IterableIterator', 'Iterator'].includes(
      type.target?.name ?? ''
    );
  }

  private mentions(type: Type, parameter: TypeParameter): boolean {
    if (type.kind === 'typeParameter') return type.id === parameter.id;
    if (type.kind === 'union' || type.kind === 'intersection')
      return type.types.some((member) => this.mentions(member, parameter));
    if (type.kind === 'object' && type.objectKind === 'reference')
      return (type.typeArguments ?? []).some((argument) => this.mentions(argument, parameter));
    return false;
  }

  /** Infers the type parameters of `types` from `source` matched against `target`, as `infer U` does. */
  inferFromTypes(parameters: TypeParameter[], source: Type, target: Type): Map<number, Type> {
    const inferences = new Map<number, Inference>(
      parameters.map((parameter) => [parameter.id, { candidates: [], contravariant: [], topLevel: false }])
    );
    this.inferTypes(inferences, parameters, source, target, true);
    const result = new Map<number, Type>();
    for (const parameter of parameters) {
      const inference = inferences.get(parameter.id) as Inference;
      if (inference.candidates.length > 0)
        result.set(parameter.id, unionOf(inference.candidates.map((candidate) => regularOf(candidate))));
      else if (inference.contravariant.length > 0) result.set(parameter.id, inference.contravariant[0]);
    }
    return result;
  }

  /** A generic signature instantiated to compare with `target`, inferring from the target's parameters. */
  instantiateToFit(source: Signature, target: Signature): Signature {
    const inferences = new Map<number, Inference>(
      source.typeParameters.map((parameter) => [parameter.id, { candidates: [], contravariant: [], topLevel: false }])
    );
    const count = Math.min(source.parameters.length, target.parameters.length);
    for (let index = 0; index < count; index++) {
      this.inferTypes(
        inferences,
        source.typeParameters,
        target.parameters[index].type,
        source.parameters[index].type,
        true
      );
    }
    const mapper: Mapper = new Map();
    for (const parameter of source.typeParameters) {
      const inference = inferences.get(parameter.id) as Inference;
      mapper.set(
        parameter.id,
        inference.candidates.length > 0 ? unionOf(inference.candidates) : (parameter.constraint?.() ?? unknownType)
      );
    }
    return { ...this.c.instantiateSignature(source, mapper), typeParameters: [] };
  }
}
