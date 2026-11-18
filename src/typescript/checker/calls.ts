// code-gauge-allow-file fileNcss 564 -- Resolves calls as TypeScript does: callees, overloads, inference, and the effects of calls on the flow.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { unsupportedMessage } from '../unsupported';
import { CallArity, minimumArguments, tupleArgumentContexts, tupleTypeAt } from './callArity';
import type { Checker, Mapper } from './checker';
import { InferencePriority, type InferenceRun, newInferenceRun } from './inference';
import { named, skipParentheses, stringValue, withoutAssertions } from './syntax';
import {
  anyType,
  errorType,
  functionType,
  isAnyLike,
  isIntrinsic,
  newTypeId,
  numberType,
  type Parameter,
  type Signature,
  type TupleElement,
  type Type,
  type TypeParameter,
  undefinedType,
  unionOf,
  unknownType,
  voidType,
} from './types';
import { UnionSignatures } from './unionSignatures';

interface Resolution {
  signature: Signature;
  returnType: Type;
}

interface InferenceArgument {
  node: TreeNode;
  spread?: TupleElement;
}

interface CallableShape {
  signatures: Signature[];
  untyped: boolean;
  blocked: boolean;
}

const functionExpressionTypes = new Set(['arrow_function', 'function_expression']);

/** Resolves calls and `new` expressions: overloads, type argument inference, and argument checks. */
export class Calls {
  /** The signature each call resolved to, for the type predicates that narrow its arguments. */
  private readonly resolved = new Map<number, Signature>();

  private readonly arity: CallArity;
  private readonly unionSignatures: UnionSignatures;

  constructor(private readonly c: Checker) {
    this.arity = new CallArity(c);
    this.unionSignatures = new UnionSignatures(c);
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- Follows TypeScript's checks of a call's callee in order, each with its own error.
  // code-gauge-allow functionNcss 43 -- Follows TypeScript's checks of a call's callee in order, each with its own error.
  call(node: TreeNode, contextual?: Type): Type {
    const callee = node.childForFieldName('function') as TreeNode;
    const argumentsNode = node.childForFieldName('arguments');
    if (argumentsNode?.type === 'template_string') return this.taggedTemplate(callee, argumentsNode);
    const args = argumentsNode ? named(argumentsNode) : [];
    const typeArguments = this.explicitTypeArguments(node);
    if (callee.type === 'super') return this.c.classes.superCall(node, args);
    if (callee.type === 'import') return this.checkArgumentsOnly(args, anyType);
    const optional = node.childForFieldName('optional_chain') !== null;
    if (this.isEvolvingPush(callee)) {
      if (typeArguments) this.c.error(node, '型引数は 0 個にしてください。');
      return this.evolvingPush(callee, args);
    }
    const chained = this.c.members.chainedCalleeType(callee);
    const checkedCallee = chained ?? this.c.expressions.check(callee, this.immediateCallContext(callee, args));
    if (optional) this.c.members.continueChain(callee);
    if (checkedCallee === errorType) return this.checkArgumentsOnly(args, errorType);
    const shortCircuits = chained !== undefined || (optional && this.c.relations.isNullable(checkedCallee));
    const calleeType = this.nonNullableCallee(callee, checkedCallee, optional);
    if (isAnyLike(calleeType)) return this.untypedCall(node, args, typeArguments);
    if (isIntrinsic(calleeType, 'unknown')) {
      this.c.error(
        callee,
        this.isName(callee) ? `'${callee.text}' の型は 'unknown' です。` : "オブジェクトの型は 'unknown' です。"
      );
      return this.checkArgumentsOnly(args, errorType);
    }
    const callable = this.callShape(calleeType);
    const signatures = this.withImmediateCallOptionals(callee, args, callable.signatures);
    if (signatures.length === 0) {
      for (const arg of args) this.c.expressions.check(arg);
      return callable.untyped ? this.untypedCall(node, [], typeArguments) : this.uncallableType(callee, calleeType);
    }
    const resolution = this.resolve(
      node,
      callee,
      signatures,
      args,
      typeArguments,
      contextual,
      this.receiverType(callee)
    );
    if (!resolution) return errorType;
    this.resolved.set(node.id, resolution.signature);
    this.checkThisContext(callee, resolution.signature);
    this.checkTextConversions(callee, args);
    const result = resolution.returnType;
    return shortCircuits ? this.c.members.chainResult(node, result) : result;
  }

  /** For a function called where it is written, as `((x) => x * 2)(3)`, a context giving its parameters the arguments' types. */
  private immediateCallContext(callee: TreeNode, args: TreeNode[]): Type | undefined {
    const expression = skipParentheses(callee);
    if (expression.type !== 'arrow_function' && expression.type !== 'function_expression') return undefined;
    if (args.some((arg) => arg.type === 'spread_element')) return undefined;
    const parametersNode = expression.childForFieldName('parameters');
    const count = Math.max(args.length, parametersNode ? named(parametersNode).length : 1);
    // A parameter without an argument is optional, holding `undefined`.
    const parameters = Array.from({ length: count }, (_, index) => ({
      name: `arg${index}`,
      type:
        index < args.length
          ? this.c.widenLiteral(this.c.silently(() => this.c.expressions.check(args[index])))
          : undefinedType,
      optional: index >= args.length,
      rest: false,
    }));
    return functionType({ typeParameters: [], parameters, returnType: () => unknownType });
  }

  /** For a function called where it is written, its parameters without arguments or annotations are optional. */
  private withImmediateCallOptionals(callee: TreeNode, args: TreeNode[], signatures: Signature[]): Signature[] {
    const expression = skipParentheses(callee);
    if (expression.type !== 'arrow_function' && expression.type !== 'function_expression') return signatures;
    const parametersNode = expression.childForFieldName('parameters');
    const parameterNodes = parametersNode ? named(parametersNode) : [];
    return signatures.map((signature) => ({
      ...signature,
      parameters: signature.parameters.map((parameter, index) =>
        index >= args.length && !parameterNodes[index]?.childForFieldName('type') && !parameter.rest
          ? { ...parameter, optional: true }
          : parameter
      ),
    }));
  }

  private checkArgumentsOnly(args: TreeNode[], result: Type): Type {
    for (const arg of args) this.c.expressions.check(arg);
    return result;
  }

  private untypedCall(node: TreeNode, args: TreeNode[], typeArguments: Type[] | undefined): Type {
    if (typeArguments) this.c.error(node, '型が付いていない関数の呼び出しに型引数は指定できません。');
    return this.checkArgumentsOnly(args, anyType);
  }

  /** The callee's type without `null` and `undefined`, reporting them unless the call is optional. */
  private nonNullableCallee(callee: TreeNode, type: Type, optional: boolean): Type {
    if (optional) return this.c.relations.removeNullish(type);
    // A `void` callee is reported as not callable, as TypeScript does, rather than as possibly undefined.
    const members = type.kind === 'union' ? type.types : [type];
    if (isAnyLike(type) || !members.some((member) => isIntrinsic(member, 'null') || isIntrinsic(member, 'undefined')))
      return type;
    const withoutUndefined = this.c.relations.removeUndefined(type);
    const what = isIntrinsic(withoutUndefined, 'never')
      ? 'undefined'
      : this.c.relations.isNullable(withoutUndefined)
        ? 'null'
        : 'undefined';
    this.c.error(callee, `${what} の可能性があるオブジェクトは呼び出せません。`);
    return this.c.relations.removeNullish(type);
  }

  /** Reports a call that neither a signature nor an untyped function type permits. */
  private uncallableType(callee: TreeNode, calleeType: Type): Type {
    const constructible = this.constructSignatures(calleeType).length > 0;
    if (constructible) {
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
    const object = receiverObject(callee);
    if (!object || object.type === 'super') return undefined;
    return this.c.silently(() => this.c.relations.removeNullish(this.c.expressions.check(object)));
  }

  private isName(node: TreeNode): boolean {
    return node.type === 'identifier';
  }

  /** `push` or `unshift` on an evolving array, which adds what it passes to the array's element type. */
  private evolvingPush(callee: TreeNode, args: TreeNode[]): Type {
    const object = callee.childForFieldName('object') as TreeNode;
    for (const arg of args) {
      // A spread adds the elements of what it spreads.
      const element =
        arg.type === 'spread_element'
          ? this.c.patterns.iteratedType(arg, this.c.expressions.check(named(arg)[0]))
          : this.c.expressions.check(arg);
      this.c.assignments.evolve(object, element);
    }
    // `push` and `unshift` return the new length.
    return numberType;
  }

  private isEvolvingPush(callee: TreeNode): boolean {
    if (callee.type !== 'member_expression') return false;
    const property = callee.childForFieldName('property')?.text;
    if (property !== 'push' && property !== 'unshift') return false;
    return this.c.assignments.isEvolvingArray(callee.childForFieldName('object') as TreeNode);
  }

  private callShape(type: Type, seen = new Set<number>()): CallableShape {
    if (seen.has(type.id)) return { signatures: [], untyped: false, blocked: true };
    this.c.budget.spend();
    seen.add(type.id);
    try {
      const apparent = this.c.apparentType(type);
      if (apparent.kind === 'union') return this.unionCallShape(apparent.types, seen);
      if (apparent.kind === 'intersection') {
        const shapes = apparent.types.map((member) => this.callShape(member, seen));
        const signatures = shapes.flatMap((shape) => shape.signatures);
        if (signatures.length > 0) return { signatures, untyped: false, blocked: false };
        const blocked = shapes.some((shape) => shape.blocked);
        return { signatures, untyped: !blocked && this.isUntypedFunction(type), blocked };
      }
      const signatures = this.c.signaturesOf(type, 'call');
      const blocked = this.c.signaturesOf(type, 'construct').length > 0;
      return { signatures, untyped: signatures.length === 0 && this.isUntypedFunction(type), blocked };
    } finally {
      seen.delete(type.id);
    }
  }

  private unionCallShape(members: Type[], seen: Set<number>): CallableShape {
    const shapes = members.map((member) => this.callShape(member, seen));
    if (shapes.some((shape) => shape.signatures.length === 0 && !shape.untyped))
      return { signatures: [], untyped: false, blocked: true };
    const concrete = members.filter((_, index) => shapes[index].signatures.length > 0);
    if (concrete.length === 0) return { signatures: [], untyped: true, blocked: false };
    const lists = shapes.flatMap((shape) => (shape.signatures.length > 0 ? [shape.signatures] : []));
    let signatures = this.unionSignatures.of(lists);
    if (signatures.length === 0) signatures = this.unionSignatures.arrayMethodSignatures(concrete);
    if (shapes.some((shape) => shape.untyped))
      signatures = signatures.map((signature) => ({ ...signature, returnType: () => anyType, predicate: undefined }));
    return { signatures, untyped: false, blocked: signatures.length === 0 };
  }

  private isUntypedFunction(type: Type): boolean {
    return (
      !isIntrinsic(this.c.baseConstraint(type), 'never') &&
      this.c.signaturesOf(type, 'construct').length === 0 &&
      this.c.relations.isAssignable(type, this.c.globalType('Function'))
    );
  }

  /** The construct signatures of `type`, which for a union combine its members' as its call signatures do. */
  private constructSignatures(type: Type): Signature[] {
    const members = this.apparentUnionMembers(type);
    if (!members) return this.c.signaturesOf(type, 'construct');
    return this.unionSignatures.of(members.map((member) => this.c.signaturesOf(member, 'construct')));
  }

  /** The members of a union, or of the union a generic type's apparent type is, as `T extends A | B` has. */
  private apparentUnionMembers(type: Type): Type[] | undefined {
    const apparent = type.kind === 'union' ? type : this.c.apparentType(type);
    return apparent.kind === 'union' ? apparent.types : undefined;
  }

  /** Whether `type` constructs an abstract class: all its construct signatures are abstract, or it is the class itself. */
  private isAbstractClass(type: Type): boolean {
    const signatures = this.c.signaturesOf(type, 'construct');
    if (signatures.length > 0 && signatures.every((signature) => signature.isAbstract)) return true;
    return type.kind === 'object' && type.classInfo?.isAbstract === true && type.isClassStatic === true;
  }

  private explicitTypeArguments(node: TreeNode): Type[] | undefined {
    const argumentsNode = node.childForFieldName('type_arguments');
    return argumentsNode ? named(argumentsNode).map((argument) => this.c.typeNodes.typeFromNode(argument)) : undefined;
  }

  newExpression(node: TreeNode, contextual?: Type): Type {
    const callee = node.childForFieldName('constructor') as TreeNode;
    const argumentsNode = node.childForFieldName('arguments');
    const args = argumentsNode ? named(argumentsNode) : [];
    const typeArguments = this.explicitTypeArguments(node);
    const calleeType = this.c.expressions.check(callee);
    if (calleeType === errorType || isAnyLike(calleeType)) {
      for (const arg of args) this.c.expressions.check(arg);
      return calleeType === errorType ? errorType : this.untypedCall(node, [], typeArguments);
    }
    const signatures = this.constructSignatures(calleeType);
    if (signatures.length === 0) {
      for (const arg of args) this.c.expressions.check(arg);
      this.c.error(
        callee,
        `この式は new で呼び出せません。型 '${this.c.print(calleeType)}' には new のシグネチャがありません。`
      );
      return errorType;
    }
    // A union's constructors combine its members', of which any being abstract makes all abstract.
    if ((calleeType.kind === 'union' ? calleeType.types : [calleeType]).some((member) => this.isAbstractClass(member)))
      this.c.error(node, '抽象クラスのインスタンスは作れません。');
    this.c.classes.checkConstructorAccessibility(node, signatures[0]);
    const resolution = this.resolve(node, callee, signatures, args, typeArguments, contextual);
    return resolution?.returnType ?? errorType;
  }

  /** Reports a call whose `this`, the object it is called on (or `void`), does not fit the `this` parameter. */
  private checkThisContext(callee: TreeNode, signature: Signature): void {
    const { thisType } = signature;
    if (!thisType || isAnyLike(thisType)) return;
    const object = receiverObject(callee);
    const checked = object ? this.c.silently(() => this.chainedReceiverType(object)) : voidType;
    // An optional call runs only when its object is not nullish.
    const context = skipParentheses(callee).childForFieldName('optional_chain')
      ? this.c.relations.removeNullish(checked)
      : checked;
    if (this.c.relations.isAssignable(context, thisType)) return;
    this.c.error(
      callee,
      `'this' の型 '${this.c.print(context)}' は、このメソッドの 'this' の型 '${this.c.print(thisType)}' に代入できません。`
    );
  }

  /** The type of a call's object where the call runs, which is past any earlier short circuit of its optional chain. */
  private chainedReceiverType(object: TreeNode): Type {
    const checked = this.c.expressions.check(object);
    return this.c.members.continuedObjectType(object, checked) ?? checked;
  }

  /** A tagged template, `String.raw\`...\``, which calls the tag with the template's strings and substitutions. */
  private taggedTemplate(callee: TreeNode, template: TreeNode): Type {
    if (!this.isStringRawTag(callee)) {
      this.c.error(callee, unsupportedMessage('タグ付きテンプレート'));
      return errorType;
    }
    const calleeType = this.c.expressions.check(callee);
    for (const part of named(template)) {
      if (part.type === 'template_substitution') this.c.expressions.check(named(part)[0]);
    }
    return this.c.signaturesOf(calleeType, 'call')[0]?.returnType() ?? anyType;
  }

  private isStringRawTag(callee: TreeNode): boolean {
    const expression = withoutAssertions(callee);
    const receiver = expression.childForFieldName('object');
    const object = receiver && withoutAssertions(receiver);
    if (object?.type !== 'identifier') return false;
    const symbol = this.c.scopeOf(object).lookupValue(object.text);
    if (symbol !== this.c.libraryBinder.moduleScope.lookupValue('String')) return false;
    if (expression.type === 'member_expression') return expression.childForFieldName('property')?.text === 'raw';
    const index = expression.type === 'subscript_expression' ? expression.childForFieldName('index') : undefined;
    return index !== undefined && index !== null && this.c.flow.constantIndexName(index) === 'raw';
  }

  /** Resolves a call to one of `signatures`, as `super(...)` does with its base class's constructors. */
  resolveWith(node: TreeNode, callee: TreeNode, signatures: Signature[], args: TreeNode[]): Type {
    return this.resolve(node, callee, signatures, args, undefined, undefined)?.returnType ?? errorType;
  }

  /** Reports the functions `String(...)` and a `%s` of `console` turn into text. */
  private checkTextConversions(callee: TreeNode, args: TreeNode[]): void {
    const typeOf = (arg: TreeNode): Type => this.c.silently(() => this.c.expressions.check(arg));
    const symbol = callee.type === 'identifier' ? this.c.scopeOf(callee).lookupValue(callee.text) : undefined;
    const declaration = symbol?.valueDeclaration;
    if (callee.text === 'String' && declaration && this.c.isLibrary(declaration) && args[0]) {
      this.c.expressions.checkFunctionText(args[0], typeOf(args[0]));
      return;
    }
    const formatted = this.consoleFormatArguments(callee, args);
    const format = formatted[0];
    if (format?.type !== 'string') return;
    let index = 1;
    for (const placeholder of stringValue(format).matchAll(/%([%sdifjoOc])/g)) {
      const kind = placeholder[1];
      if (kind === '%') continue;
      const arg = formatted[index++];
      if (kind === 's' && arg) this.c.expressions.checkFunctionText(arg, typeOf(arg));
    }
  }

  private consoleFormatArguments(callee: TreeNode, args: TreeNode[]): TreeNode[] {
    const object = callee.type === 'member_expression' ? callee.childForFieldName('object') : undefined;
    const method = callee.childForFieldName('property')?.text;
    const methods = ['log', 'info', 'debug', 'warn', 'error', 'dirxml', 'group', 'groupCollapsed', 'trace', 'assert'];
    const offset = method === 'assert' ? 1 : 0;
    const consoleSymbol = object ? this.c.scopeOf(object).lookupValue(object.text) : undefined;
    if (
      object?.text !== 'console' ||
      !consoleSymbol?.valueDeclaration ||
      !this.c.isLibrary(consoleSymbol.valueDeclaration) ||
      !method ||
      !methods.includes(method)
    )
      return [];
    return args.slice(offset);
  }

  /** Whether a call ends the flow, calling through a name a function declared to return `never`. */
  endsFlow(node: TreeNode): boolean {
    const signature = this.resolved.get(node.id);
    const callee = node.childForFieldName('function');
    if (!signature?.declaration?.childForFieldName('return_type') || !callee || !isDottedName(callee)) return false;
    // A function held by a variable or a field counts only when that declaration has a type annotation.
    const declaration =
      callee.type === 'identifier' ? this.c.scopeOf(callee).lookupValue(callee.text)?.valueDeclaration : undefined;
    if (declaration?.type === 'variable_declarator' && !declaration.childForFieldName('type')) return false;
    const field = signature.declaration.parent;
    if (field?.type === 'field_definition' && !field.childForFieldName('type')) return false;
    return isIntrinsic(signature.returnType(), 'never');
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

  // code-gauge-allow functionParameterCount 7 -- Tries each overload as TypeScript does, then reports the failure as it does.
  // code-gauge-allow functionCognitiveComplexity 19 -- Tries overloads before demanding the selected generic call context.
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
    const instantiate = (candidate: Signature): Signature =>
      this.instantiateFor(candidate, args, typeArguments, contextual, receiver);
    for (const candidate of candidates) {
      if (!this.arity.arityMatches(candidate, args)) continue;
      const instantiated = this.c.silently(() => instantiate(candidate));
      if (
        this.arity.instanceArityMatches(instantiated, candidate, args) &&
        this.c.silently(() => this.argumentsMatch(instantiated, args))
      ) {
        const deferred =
          candidate.typeParameters.length > 0 && !typeArguments
            ? this.c.expressions.deferredContexts.typeOf(node)
            : undefined;
        const final = this.instantiateFor(candidate, args, typeArguments, deferred ?? contextual, receiver);
        this.checkArguments(final, args, true, node);
        if (typeArguments)
          this.c.typeNodes.checkTypeArgumentConstraints(
            node,
            candidate.typeParameters,
            this.fillTypeArguments(candidate, typeArguments)
          );
        return { signature: final, returnType: final.returnType() };
      }
    }
    return this.reportUnresolved(node, callee, candidates, args, instantiate);
  }

  /** Reports that no overload accepts the arguments as TypeScript does, for the only fitting signature or the call. */
  private reportUnresolved(
    node: TreeNode,
    callee: TreeNode,
    candidates: Signature[],
    args: TreeNode[],
    instantiate: (candidate: Signature) => Signature
  ): Resolution {
    const byArity = candidates.filter((candidate) => this.arity.arityMatches(candidate, args));
    if (candidates.length === 1 || byArity.length === 1)
      return this.reportSignature(
        node,
        callee,
        candidates.length === 1 ? candidates[0] : byArity[0],
        args,
        instantiate
      );
    for (const arg of args) this.c.expressions.check(arg);
    if (byArity.length === 0) {
      const minimum = Math.min(...candidates.map((candidate) => minimumArguments(candidate)));
      const maximum = Math.max(...candidates.map((candidate) => this.arity.maximumArguments(candidate)));
      this.c.error(
        args.length > maximum ? args[maximum] : node,
        maximum === Number.POSITIVE_INFINITY || minimum === maximum
          ? `引数は ${minimum} 個必要ですが、${args.length} 個渡されています。`
          : `引数は ${minimum} 個から ${maximum} 個必要ですが、${args.length} 個渡されています。`
      );
      return { signature: candidates[0], returnType: candidates[0].returnType() };
    }
    const at = this.overloadErrorLocation(node, callee, byArity, args, instantiate);
    const message = 'この呼び出しに合うオーバーロードがありません。';
    if (at) this.c.diagnostics.push({ ...at, message });
    else
      this.c.error(
        callee.type === 'member_expression' ? (callee.childForFieldName('property') ?? node) : node,
        message
      );
    const last = byArity.at(-1) as Signature;
    return { signature: last, returnType: this.c.silently(() => instantiate(last)).returnType() };
  }

  /** Where TypeScript 7 reports that no overload fits: at the first error of the last overload that could fit. */
  private overloadErrorLocation(
    node: TreeNode,
    callee: TreeNode,
    candidates: Signature[],
    args: TreeNode[],
    instantiate: (candidate: Signature) => Signature
  ): { row: number; index: number } | undefined {
    if (this.c.silent > 0) return undefined;
    const start = this.c.diagnostics.length;
    this.reportSignature(node, callee, candidates.at(-1) as Signature, args, instantiate);
    const [first] = this.c.diagnostics.splice(start);
    return first && { row: first.row, index: first.index };
  }

  /** Reports why the only signature that could fit does not accept the arguments. */
  private reportSignature(
    node: TreeNode,
    callee: TreeNode,
    candidate: Signature,
    args: TreeNode[],
    instantiate: (candidate: Signature) => Signature
  ): Resolution {
    const instantiated = this.arity.arityMatches(candidate, args) ? instantiate(candidate) : undefined;
    if (instantiated && this.arity.instanceArityMatches(instantiated, candidate, args)) {
      this.checkArguments(instantiated, args, true, node);
      return { signature: instantiated, returnType: instantiated.returnType() };
    }
    this.arity.reportArity(node, callee, instantiated ?? candidate, args);
    for (const arg of args) this.c.expressions.check(arg);
    return {
      signature: instantiated ?? candidate,
      returnType: (instantiated ?? this.c.silently(() => instantiate(candidate))).returnType(),
    };
  }

  private fillTypeArguments(signature: Signature, typeArguments: Type[]): Type[] {
    return this.c.fillTypeArguments(signature.typeParameters, typeArguments);
  }

  /** The parameter type an argument at `index` is passed to. */
  parameterTypeAt(signature: Signature, index: number): Type | undefined {
    const { parameters } = signature;
    const final = parameters.at(-1);
    // A rest of a tuple type takes each argument at its position in the tuple.
    if (final?.rest && final.type.kind === 'object' && final.type.tuple && index >= parameters.length - 1)
      return tupleTypeAt(this.c, final.type.tuple.elements, index - (parameters.length - 1));
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
  private checkArguments(signature: Signature, args: TreeNode[], report: boolean, call?: TreeNode): boolean {
    const restIndex = signature.parameters.length - 1;
    const restType = signature.parameters[restIndex]?.rest ? signature.parameters[restIndex].type : undefined;
    const genericRest = this.c.relations.isGenericRestType(restType);
    if (genericRest && args.slice(0, restIndex).some((arg) => arg.type === 'spread_element'))
      return this.checkRestTupleArguments(
        this.c.tupleType(
          signature.parameters.map((parameter) => ({
            type: parameter.type,
            optional: parameter.optional,
            rest: parameter.rest,
          }))
        ),
        args,
        report,
        args[0] ?? call
      );
    if (
      (isTrailingRestTuple(signature) || genericRest) &&
      !args.slice(0, restIndex).some((arg) => arg.type === 'spread_element')
    )
      return (
        this.checkArguments(
          { ...signature, parameters: signature.parameters.slice(0, -1) },
          args.slice(0, restIndex),
          report
        ) &&
        this.checkRestTupleArguments(
          signature.parameters[restIndex].type,
          args.slice(restIndex),
          report,
          args[restIndex] ?? call
        )
      );
    let ok = true;
    let index = 0;
    for (const arg of args) {
      if (arg.type === 'spread_element') {
        const { count, fits } = this.checkSpreadArgument(signature, arg, index, report);
        ok = ok && fits;
        index += count;
        continue;
      }
      // TypeScript reports the first argument that does not fit.
      ok = this.checkArgument(arg, this.parameterTypeAt(signature, index), report, report && ok) && ok;
      index++;
    }
    return ok;
  }

  private checkArgument(
    arg: TreeNode,
    parameterType: Type | undefined,
    report: boolean,
    reportMismatch: boolean
  ): boolean {
    const argType = this.c.expressions.check(arg, parameterType);
    if (!parameterType) return true;
    if (!this.c.relations.isAssignable(argType, parameterType)) {
      if (reportMismatch) this.reportArgument(arg, argType, parameterType);
      return false;
    }
    if (report) this.c.expressions.checkExcessProperties(arg, argType, parameterType);
    return true;
  }

  /**
   * Checks a generic rest parameter or a tuple with trailing elements against the whole argument list,
   * preserving the type of a forwarded spread.
   */
  private checkRestTupleArguments(
    restType: Type,
    args: TreeNode[],
    report: boolean,
    at: TreeNode | undefined
  ): boolean {
    const contexts = restTupleContexts(this.c, restType, args, (arg) => this.arity.spreadLength(arg));
    // The tuple is built silently, so the arguments' own errors are reported here.
    if (report)
      for (const [index, arg] of args.entries())
        this.c.expressions.check(arg.type === 'spread_element' ? named(arg)[0] : arg, contexts[index]);
    const tuple =
      args.length === 1 && args[0].type === 'spread_element'
        ? this.c.silently(() => this.c.expressions.check(named(args[0])[0]))
        : this.argumentTuple(args, contexts);
    if (this.c.relations.isAssignable(tuple, restType)) return true;
    if (report && at)
      this.c.error(
        at,
        `型 '${this.c.print(tuple)}' の引数を型 '${this.c.print(restType)}' のパラメーターに渡すことはできません。`
      );
    return false;
  }

  /** Checks what a spread argument passes, returning how many parameters it takes and whether it fits them. */
  private checkSpreadArgument(
    signature: Signature,
    arg: TreeNode,
    index: number,
    report: boolean
  ): { count: number; fits: boolean } {
    const spreadType = this.c.expressions.check(named(arg)[0]);
    const elements = this.spreadElements(arg, spreadType).map((element) => this.spreadValueType(element));
    const misfit = elements.findIndex((element, offset) => {
      const parameterType = this.parameterTypeAt(signature, index + offset);
      return parameterType && !this.c.relations.isAssignable(element, parameterType);
    });
    if (report && misfit !== -1)
      this.reportArgument(arg, elements[misfit], this.parameterTypeAt(signature, index + misfit) as Type);
    return { count: elements.length, fits: misfit === -1 };
  }

  private reportArgument(arg: TreeNode, argType: Type, parameterType: Type): void {
    // TypeScript reports an object literal's excess property before any other mismatch.
    const before = this.c.diagnostics.length;
    this.c.expressions.checkExcessProperties(arg, argType, parameterType);
    if (this.c.diagnostics.length > before) return;
    if (this.c.expressions.elaboration.report(arg, argType, parameterType)) return;
    const types = this.c.typesForMessage(argType, parameterType);
    this.c.error(
      arg,
      `型 '${this.c.print(types.source)}' の引数を型 '${this.c.print(types.target)}' のパラメーターに渡すことはできません。`
    );
  }

  // Inference ----------------------------------------------------------------------------------------------------

  /** A signature with its type parameters replaced by the given or inferred type arguments. */
  // code-gauge-allow functionNcss 36 -- Follows TypeScript's inference passes: context-insensitive arguments, the contextual return, then callbacks.
  // code-gauge-allow functionCognitiveComplexity 20 -- Follows TypeScript's inference passes: context-insensitive arguments, the contextual return, then callbacks.
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
    const run = newInferenceRun(parameters, true);
    const restIndex = this.genericRestIndex(signature);
    const arguments_ = this.inferenceArguments(args);
    const parameterTypes = this.inferenceParameterTypes(signature, arguments_);
    this.recordImpliedArity(run, signature, arguments_);
    // A `this` parameter infers from the object the method is called on.
    if (receiver && signature.thisType) this.c.inference.inferTypes(run, receiver, signature.thisType, true);
    // Context-insensitive arguments infer first; functions without parameter annotations then see what they inferred.
    const sensitive = arguments_.map((arg) => !arg.spread && this.isContextSensitive(arg.node));
    for (const [index, arg] of arguments_.entries()) {
      if (restIndex !== undefined && index >= restIndex) continue;
      if (!sensitive[index])
        this.inferFromArgument(
          run,
          arg,
          parameterTypes[index],
          this.c.inference.partialMapper(parameters, run.inferences)
        );
    }
    // `...args: T` infers `T` as the tuple of the arguments it takes.
    if (restIndex !== undefined)
      this.c.inference.inferTypes(
        run,
        this.inferenceTuple(
          arguments_.slice(restIndex),
          parameterTypes.slice(restIndex),
          this.c.inference.partialMapper(parameters, run.inferences),
          signature.parameters.at(-1)?.type
        ),
        (signature.parameters.at(-1) as Parameter).type,
        true
      );
    if (contextual)
      this.c.inference.inferTypes(
        { ...run, priority: InferencePriority.ReturnType },
        contextual,
        signature.returnType(),
        true
      );
    for (const [index, arg] of arguments_.entries()) {
      if (!sensitive[index]) continue;
      // A callback's parameters fix what they mention, while its return type keeps the rest to infer from it.
      const parameterType = parameterTypes[index];
      const callbacks = parameterType ? this.c.signaturesOf(parameterType, 'call') : [];
      const typesCallbackParameter = (parameter: TypeParameter): boolean =>
        callbacks.some((callback) => callback.parameters.some((p) => this.c.inference.mentions(p.type, parameter)));
      const fixes = (parameter: TypeParameter): boolean => callbacks.length === 0 || typesCallbackParameter(parameter);
      this.inferFromArgument(
        run,
        arg,
        parameterType,
        this.c.inference.partialMapper(parameters, run.inferences, fixes, typesCallbackParameter)
      );
    }
    const mapper = this.c.inference.finalMapper(signature, parameters, run.inferences);
    return { ...this.c.instantiateSignature(signature, mapper), typeParameters: [] };
  }

  /** Records how many arguments `...args: A` takes, which splits what `A` infers from `[...A, ...B]`. */
  private recordImpliedArity(run: InferenceRun, signature: Signature, args: InferenceArgument[]): void {
    const restIndex = this.genericRestIndex(signature);
    if (restIndex === undefined) return;
    const rest = args.slice(restIndex);
    if (rest.some((arg) => arg.spread?.rest)) return;
    const restType = (signature.parameters.at(-1) as Parameter).type;
    const inference = run.inferences.get(restType.id);
    if (inference) inference.impliedArity = rest.length;
  }

  private inferenceArguments(args: TreeNode[]): InferenceArgument[] {
    return args.flatMap((node): InferenceArgument[] => {
      if (node.type !== 'spread_element') return [{ node }];
      const type = this.c.silently(() => this.c.expressions.check(named(node)[0]));
      return this.c.silently(() => this.spreadElements(node, type)).map((spread) => ({ node, spread }));
    });
  }

  private inferenceParameterTypes(signature: Signature, args: InferenceArgument[]): (Type | undefined)[] {
    const types = args.map((_, index) => this.parameterTypeAt(signature, index));
    if (!isTrailingRestTuple(signature)) return types;
    const restIndex = signature.parameters.length - 1;
    const tail = tupleArgumentContexts(
      this.c,
      signature.parameters[restIndex].type,
      args.slice(restIndex).map((arg) => (arg.spread?.rest ? undefined : 1))
    );
    return [...types.slice(0, restIndex), ...tail];
  }

  private inferenceTuple(
    args: InferenceArgument[],
    contexts: (Type | undefined)[],
    mapper: Mapper | undefined,
    restType?: Type
  ): Type {
    const constContext =
      restType?.kind === 'typeParameter' && restType.isConst
        ? { ...restType, id: newTypeId(), constraint: undefined }
        : undefined;
    const lastRequired = args.findLastIndex((arg) => !arg.spread || (!arg.spread.optional && !arg.spread.rest));
    return this.c.tupleType(
      args.map((arg, index) => {
        if (arg.spread)
          return arg.spread.optional && index < lastRequired
            ? { ...arg.spread, type: this.spreadValueType(arg.spread), optional: false }
            : arg.spread;
        const parameterType = contexts[index];
        const context = parameterType && mapper ? this.c.instantiate(parameterType, mapper) : parameterType;
        return {
          type: constContext
            ? this.c.silently(() => this.c.expressions.check(arg.node, constContext))
            : this.c.widenLiteral(this.c.silently(() => this.c.expressions.check(arg.node, context))),
          optional: false,
          rest: false,
        };
      })
    );
  }

  /** The tuple of what arguments pass, a spread one passing its tuple's elements or, for an array, a rest element. */
  private argumentTuple(args: TreeNode[], contexts: (Type | undefined)[] = []): Type {
    const check = (node: TreeNode, context?: Type): Type =>
      this.c.silently(() => this.c.expressions.check(node, context));
    const elements = args.flatMap((arg, index): TupleElement[] => {
      if (arg.type !== 'spread_element') {
        const type = check(arg, contexts[index]);
        return [{ type, optional: false, rest: false }];
      }
      const spreadType = check(named(arg)[0]);
      if (this.c.relations.isGenericRestType(spreadType)) return [{ type: spreadType, optional: false, rest: true }];
      return this.c.silently(() => this.spreadElements(arg, spreadType));
    });
    return this.c.tupleType(elements);
  }

  /** Where a rest parameter typed by one of the signature's own type parameters starts, as in `...args: T`. */
  private genericRestIndex(signature: Signature): number | undefined {
    const last = signature.parameters.at(-1);
    if (!last?.rest) return undefined;
    // `...args: T`, or a tuple with a variadic element of one, as `...args: [...T, number]`.
    const generic =
      last.type.kind === 'typeParameter'
        ? signature.typeParameters.some((parameter) => parameter.id === last.type.id)
        : last.type.kind === 'object' &&
          last.type.objectKind === 'tuple' &&
          signature.typeParameters.some((parameter) => this.c.inference.mentions(last.type, parameter));
    return generic ? signature.parameters.length - 1 : undefined;
  }

  private inferFromArgument(
    run: InferenceRun,
    arg: InferenceArgument,
    parameterType: Type | undefined,
    mapper: Mapper | undefined
  ): void {
    if (!parameterType) return;
    const context = mapper ? this.c.instantiate(parameterType, mapper) : parameterType;
    const argType = arg.spread
      ? this.spreadValueType(arg.spread)
      : this.c.silently(() => this.c.expressions.check(arg.node, context));
    this.c.inference.inferTypes(run, argType, parameterType, true);
  }

  private spreadElements(arg: TreeNode, type: Type): TupleElement[] {
    if (type.kind === 'object' && type.objectKind === 'tuple') return type.tuple?.elements ?? [];
    const element = this.c.patterns.iteratedType(arg, type);
    return [{ type: this.c.arrayType(element), rest: true, optional: false }];
  }

  private spreadValueType(element: TupleElement): Type {
    if (element.rest) return this.c.restElementType(element.type);
    return element.optional ? unionOf([element.type, undefinedType]) : element.type;
  }

  private isGenericCallback(arg: TreeNode): boolean {
    const expression = skipParentheses(arg);
    if (expression.type === 'arrow_function' || expression.type === 'function_expression')
      return expression.childForFieldName('type_parameters') !== null;
    if (!['identifier', 'member_expression', 'subscript_expression'].includes(expression.type)) return false;
    const type = this.c.silently(() => this.c.expressions.check(expression));
    return this.c.signaturesOf(type, 'call').some((signature) => signature.typeParameters.length > 0);
  }

  private isContextSensitive(arg: TreeNode): boolean {
    const expression = skipParentheses(arg);
    if (this.isGenericCallback(expression)) return true;
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

/** Whether an expression names something by identifiers and properties only, as `a`, `this.b`, or `a.b.c`. */
function isDottedName(node: TreeNode): boolean {
  if (node.type === 'identifier' || node.type === 'this') return true;
  if (node.type !== 'member_expression' || node.childForFieldName('optional_chain')) return false;
  return isDottedName(node.childForFieldName('object') as TreeNode);
}

/** The object a call through a property or an element, as `o.f()` or `o["f"]()`, passes as `this`. */
function receiverObject(callee: TreeNode): TreeNode | undefined {
  const expression = skipParentheses(callee);
  if (expression.type !== 'member_expression' && expression.type !== 'subscript_expression') return undefined;
  return expression.childForFieldName('object') ?? undefined;
}

/** Whether a signature's rest parameter is a tuple with elements after its rest element, as `[...string[], number]`. */
function isTrailingRestTuple(signature: Signature): boolean {
  const last = signature.parameters.at(-1);
  const elements = last?.rest && last.type.kind === 'object' ? last.type.tuple?.elements : undefined;
  return elements !== undefined && elements.slice(0, -1).some((element) => element.rest);
}

/**
 * The contextual type of each argument a rest of a tuple type takes, as `...a: [...F[], G]`: its leading elements by
 * position, its trailing ones from the last argument back, and the rest's elements between. A spread of known length,
 * as a tuple's, keeps the positions after it; one of unknown length keeps only those counted from the other end.
 */
function restTupleContexts(
  c: Checker,
  restType: Type,
  args: TreeNode[],
  lengthOf: (arg: TreeNode) => number | undefined
): (Type | undefined)[] {
  const contexts = tupleArgumentContexts(c, restType, args.map(lengthOf));
  return contexts.map((context, index) => (args[index].type === 'spread_element' ? undefined : context));
}
