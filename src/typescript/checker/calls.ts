import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker, Mapper } from './checker';
import { type InferenceRun, newInferenceRun } from './inference';
import { named, skipParentheses } from './syntax';
import {
  anyType,
  errorType,
  isAnyLike,
  isIntrinsic,
  type Signature,
  type Type,
  undefinedType,
  unionOf,
  unknownType,
} from './types';

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

  // code-gauge-allow functionNcss 35 -- Follows TypeScript's checks of a call's callee in order, each with its own error.
  // code-gauge-allow functionCognitiveComplexity 19 -- Follows TypeScript's checks of a call's callee in order, each with its own error.
  call(node: TreeNode, contextual?: Type): Type {
    const callee = node.childForFieldName('function') as TreeNode;
    const argumentsNode = node.childForFieldName('arguments');
    const args = argumentsNode ? named(argumentsNode) : [];
    if (callee.type === 'super') return this.c.classes.superCall(node, args);
    if (callee.type === 'import') return this.checkArgumentsOnly(args, anyType);
    const optional = node.childForFieldName('optional_chain') !== null;
    if (this.isEvolvingPush(callee)) {
      const object = callee.childForFieldName('object') as TreeNode;
      for (const arg of args) this.c.assignments.evolve(object, this.c.expressions.check(arg));
      return this.c.globalType('Number').resolve() && anyType;
    }
    const chained = this.c.members.chainedCalleeType(callee);
    const checkedCallee = chained ?? this.c.expressions.check(callee);
    if (checkedCallee === errorType) return this.checkArgumentsOnly(args, errorType);
    const calleeType = this.nonNullableCallee(callee, checkedCallee, optional);
    if (isAnyLike(calleeType)) return this.checkArgumentsOnly(args, anyType);
    if (isIntrinsic(calleeType, 'unknown')) {
      this.c.error(
        callee,
        this.isName(callee) ? `'${callee.text}' の型は 'unknown' です。` : "オブジェクトの型は 'unknown' です。"
      );
      return this.checkArgumentsOnly(args, errorType);
    }
    const signatures = this.callSignatures(calleeType);
    if (signatures.length === 0) {
      for (const arg of args) this.c.expressions.check(arg);
      return this.uncallableType(callee, calleeType);
    }
    const resolution = this.resolve(
      node,
      callee,
      signatures,
      args,
      this.explicitTypeArguments(node),
      contextual,
      this.receiverType(callee)
    );
    if (!resolution) return errorType;
    this.resolved.set(node.id, resolution.signature);
    const result = resolution.returnType;
    return chained || (optional && this.c.relations.isNullable(this.c.silently(() => this.c.expressions.check(callee))))
      ? unionOf([result, undefinedType])
      : result;
  }

  private checkArgumentsOnly(args: TreeNode[], result: Type): Type {
    for (const arg of args) this.c.expressions.check(arg);
    return result;
  }

  /** The callee's type without `null` and `undefined`, reporting them unless the call is optional. */
  private nonNullableCallee(callee: TreeNode, type: Type, optional: boolean): Type {
    if (optional) return this.c.relations.removeNullish(type);
    if (isAnyLike(type) || !this.c.relations.isNullable(type)) return type;
    const withoutUndefined = this.c.relations.removeUndefined(type);
    const what = isIntrinsic(withoutUndefined, 'never')
      ? 'undefined'
      : this.c.relations.isNullable(withoutUndefined)
        ? 'null'
        : 'undefined';
    this.c.error(callee, `${what} の可能性があるオブジェクトは呼び出せません。`);
    return this.c.relations.removeNullish(type);
  }

  /** The result of calling a type without call signatures, reporting the call unless the type is `Function`. */
  private uncallableType(callee: TreeNode, calleeType: Type): Type {
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

  /** The object a method is called on, which its `this` parameter infers from. */
  private receiverType(callee: TreeNode): Type | undefined {
    if (callee.type !== 'member_expression' || callee.childForFieldName('object')?.type === 'super') return undefined;
    return this.c.silently(() =>
      this.c.relations.removeNullish(this.c.expressions.check(callee.childForFieldName('object') as TreeNode))
    );
  }

  private isName(node: TreeNode): boolean {
    return node.type === 'identifier';
  }

  private isEvolvingPush(callee: TreeNode): boolean {
    if (callee.type !== 'member_expression') return false;
    const property = callee.childForFieldName('property')?.text;
    if (property !== 'push' && property !== 'unshift') return false;
    return this.c.assignments.isEvolvingArray(callee.childForFieldName('object') as TreeNode);
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
    return argumentsNode ? named(argumentsNode).map((argument) => this.c.typeNodes.typeFromNode(argument)) : undefined;
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
  // code-gauge-allow functionParameterCount 7 -- Tries each overload as TypeScript does, then reports the failure as it does.
  // code-gauge-allow functionNcss 41 -- Tries each overload as TypeScript does, then reports the failure as it does.
  private resolve(
    node: TreeNode,
    callee: TreeNode,
    signatures: Signature[],
    args: TreeNode[],
    typeArguments: Type[] | undefined,
    contextual: Type | undefined,
    receiver?: Type
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
    for (const candidate of candidates) {
      if (!this.arityMatches(candidate, args)) continue;
      const instantiated = this.c.silently(() =>
        this.instantiateFor(candidate, args, typeArguments, contextual, receiver)
      );
      if (this.c.silently(() => this.argumentsMatch(instantiated, args))) {
        const final = this.instantiateFor(candidate, args, typeArguments, contextual, receiver);
        this.checkArguments(final, args, true);
        if (typeArguments)
          this.c.typeNodes.checkTypeArgumentConstraints(
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
            .silently(() => this.instantiateFor(candidate, args, typeArguments, contextual, receiver))
            .returnType(),
        };
      }
      const instantiated = this.instantiateFor(candidate, args, typeArguments, contextual, receiver);
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
        .silently(() => this.instantiateFor(last, args, typeArguments, contextual, receiver))
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
      if (parameter.rest) return this.c.restElementType(parameter.type);
      // An optional parameter also takes `undefined`.
      return parameter.optional ? unionOf([parameter.type, undefinedType]) : parameter.type;
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
        const { count, fits } = this.checkSpreadArgument(signature, arg, index, report);
        ok = ok && fits;
        index += count;
        continue;
      }
      const parameterType = this.parameterTypeAt(signature, index);
      const argType = this.c.expressions.check(arg, parameterType);
      if (parameterType && !this.c.relations.isAssignable(argType, parameterType)) {
        // TypeScript reports the first argument that does not fit.
        if (report && ok) this.reportArgument(arg, argType, parameterType);
        ok = false;
      } else if (parameterType && report) {
        this.c.expressions.checkExcessProperties(arg, argType, parameterType);
      }
      index++;
    }
    return ok;
  }

  /** Checks what a spread argument passes, returning how many parameters it takes and whether it fits them. */
  private checkSpreadArgument(
    signature: Signature,
    arg: TreeNode,
    index: number,
    report: boolean
  ): { count: number; fits: boolean } {
    const spreadType = this.c.expressions.check(named(arg)[0]);
    if (spreadType.kind === 'object' && spreadType.objectKind === 'tuple') {
      const elements = spreadType.tuple?.elements ?? [];
      let fits = true;
      for (const [offset, element] of elements.entries()) {
        const parameterType = this.parameterTypeAt(signature, index + offset);
        if (parameterType && !this.c.relations.isAssignable(element.type, parameterType)) {
          if (report) this.c.expressions.reportNotAssignable(arg, element.type, parameterType);
          fits = false;
        }
      }
      return { count: elements.length, fits };
    }
    const element = this.c.patterns.iteratedType(arg, spreadType);
    const parameterType = this.parameterTypeAt(signature, index);
    if (!parameterType || this.c.relations.isAssignable(element, parameterType)) return { count: 1, fits: true };
    if (report) this.reportArgument(arg, element, parameterType);
    return { count: 1, fits: false };
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
    receiver: Type | undefined
  ): Signature {
    if (signature.typeParameters.length === 0) return signature;
    if (typeArguments) {
      const filled = this.fillTypeArguments(signature, typeArguments);
      const mapper: Mapper = new Map(signature.typeParameters.map((parameter, index) => [parameter.id, filled[index]]));
      return { ...this.c.instantiateSignature(signature, mapper), typeParameters: [] };
    }
    const parameters = signature.typeParameters;
    const run = newInferenceRun(parameters);
    // A `this` parameter infers from the object the method is called on.
    if (receiver && signature.thisType) this.c.inference.inferTypes(run, receiver, signature.thisType, true);
    // Context-insensitive arguments infer first; functions without parameter annotations then see what they inferred.
    const sensitive = args.map((arg) => this.isContextSensitive(arg));
    for (const [index, arg] of args.entries()) {
      if (arg.type === 'spread_element') this.inferFromSpread(run, signature, arg, index);
      else if (!sensitive[index])
        this.inferFromArgument(run, signature, arg, index, this.c.inference.partialMapper(parameters, run.inferences));
    }
    if (contextual)
      this.c.inference.inferTypes({ ...run, lowPriority: true }, contextual, signature.returnType(), false);
    for (const [index, arg] of args.entries()) {
      if (sensitive[index])
        this.inferFromArgument(
          run,
          signature,
          arg,
          index,
          this.c.inference.partialMapper(parameters, run.inferences, true)
        );
    }
    const mapper = this.c.inference.finalMapper(signature, parameters, run.inferences);
    return { ...this.c.instantiateSignature(signature, mapper), typeParameters: [] };
  }

  private inferFromSpread(run: InferenceRun, signature: Signature, arg: TreeNode, index: number): void {
    const spreadType = this.c.silently(() => this.c.expressions.check(named(arg)[0]));
    const element = this.c.silently(() => this.c.patterns.iteratedType(undefined, spreadType));
    const parameterType = this.parameterTypeAt(signature, index);
    if (parameterType) this.c.inference.inferTypes(run, element, parameterType, true);
  }

  private inferFromArgument(
    run: InferenceRun,
    signature: Signature,
    arg: TreeNode,
    index: number,
    mapper: Mapper | undefined
  ): void {
    const parameterType = this.parameterTypeAt(signature, index);
    if (!parameterType) return;
    const context = mapper ? this.c.instantiate(parameterType, mapper) : parameterType;
    const argType = this.c.silently(() => this.c.expressions.check(arg, context));
    this.c.inference.inferTypes(run, argType, parameterType, true);
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
}
