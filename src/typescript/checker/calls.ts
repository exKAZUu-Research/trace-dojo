// code-gauge-allow-file fileNcss -- Resolves calls as TypeScript does: callees, overloads, inference, and the effects of calls on the flow.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { CallArity, ExpressionListFlow, minimumArguments, tupleArgumentContexts, tupleTypeAt } from './callArity';
import { CallTypeArguments } from './callTypeArguments';
import type { Checker, Mapper } from './checker';
import { contextualSignatureOf } from './contextualSignatures';
import type { State } from './flow';
import { InferencePriority, type InferenceRun, newInferenceRun } from './inference';
import { nonNullableType, nullishConstraint } from './nullishConstraints';
import { prioritizeLiteralOverloads } from './overloadCandidates';
import { isContextSensitiveFunction, parameterNodes } from './signatures';
import { argumentParameters, isThisParameter, named, skipParentheses, stringValue, withoutAssertions } from './syntax';
import type { TypeArgumentMismatch } from './typeNodes';
import {
  anonymousObject,
  anyType,
  errorType,
  functionType,
  isAnyLike,
  isIntrinsic,
  mapType,
  newTypeId,
  numberType,
  type Parameter,
  type Signature,
  type TupleElement,
  type Type,
  typeMembers,
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

interface CallAttempt {
  instantiate: (candidate: Signature) => Signature;
  checkThis: (signature: Signature, report?: boolean) => boolean;
  previewCallbacks: (signature: Signature) => void;
}

interface CallOptions {
  typeArguments?: Type[];
  contextual?: Type;
  receiver?: Type;
}

interface ExpandedArgument {
  node: TreeNode;
  before: State;
  spread?: TupleElement;
}

interface CallableShape {
  signatures: Signature[];
  untyped: boolean;
  blocked: boolean;
}

const functionExpressionTypes = new Set(['arrow_function', 'function_expression', 'generator_function']);

/** Resolves calls and `new` expressions: overloads, type argument inference, and argument checks. */
export class Calls {
  /** The signature each call resolved to, for the type predicates that narrow its arguments. */
  private readonly resolved = new Map<number, Signature>();

  private readonly arity: CallArity;
  private readonly typeArguments: CallTypeArguments;
  private readonly unionSignatures: UnionSignatures;

  constructor(private readonly c: Checker) {
    this.arity = new CallArity(c);
    this.typeArguments = new CallTypeArguments(c);
    this.unionSignatures = new UnionSignatures(c);
  }

  /**
   * `f<T>` without a call: the signatures of `f` that take that many type arguments, instantiated with them, as
   * TypeScript's `getInstantiatedTypePart` makes them.
   */
  instantiationExpression(node: TreeNode): Type {
    const expression = node.childForFieldName('function') ?? named(node)[0];
    const type = this.c.expressions.check(expression);
    const typeArguments = this.typeArguments.written(node) ?? [];
    if (isAnyLike(type) || type === errorType) return type;
    const structure = this.c.structureOf(type);
    const applicable = (signatures: Signature[]): Signature[] =>
      signatures
        .filter(
          ({ typeParameters }) =>
            typeParameters.length >= typeArguments.length &&
            typeParameters.filter((parameter) => !parameter.default).length <= typeArguments.length
        )
        .map((signature) => {
          const mismatch = this.typeArguments.firstMismatch(signature, typeArguments);
          if (mismatch) this.typeArguments.reportMismatch(node, mismatch);
          return this.typeArguments.instantiate(signature, typeArguments);
        });
    const callSignatures = applicable(structure.callSignatures);
    const constructSignatures = applicable(structure.constructSignatures);
    if (callSignatures.length === 0 && constructSignatures.length === 0) {
      this.c.error(
        named(node).at(-1) ?? node,
        `型 '${this.c.print(type)}' には、この型引数の並びを使えるシグネチャがありません。`
      );
      return errorType;
    }
    return anonymousObject(() => ({ ...structure, callSignatures, constructSignatures }));
  }

  // code-gauge-allow functionCognitiveComplexity -- Follows TypeScript's checks of a call's callee in order, each with its own error.
  // code-gauge-allow functionNcss -- Follows TypeScript's checks of a call's callee in order, each with its own error.
  call(node: TreeNode, contextual?: Type): Type {
    const callee = node.childForFieldName('function') as TreeNode;
    const argumentsNode = node.childForFieldName('arguments');
    if (argumentsNode?.type === 'template_string') return this.taggedTemplate(node, callee, argumentsNode);
    const args = argumentsNode ? named(argumentsNode) : [];
    const typeArguments = this.typeArguments.written(node);
    if (callee.type === 'super') return this.c.classes.superCall(node, args);
    if (callee.type === 'import') return this.checkArgumentsOnly(args, anyType);
    const optional = node.childForFieldName('optional_chain') !== null;
    if (this.isEvolvingPush(callee)) {
      if (typeArguments) this.c.error(node, '型引数は 0 個にしてください。');
      return this.evolvingPush(callee, args);
    }
    const reference = withoutAssertions(callee);
    const access =
      reference.type === 'member_expression' || reference.type === 'subscript_expression'
        ? this.c.expressions.checkMemberCallee(callee, reference)
        : undefined;
    const checked = access?.type ?? this.checkCallCallee(callee, args);
    const chained = this.c.members.continuedObjectType(callee, checked);
    const checkedCallee = chained ?? checked;
    if (optional) this.c.members.continueChain(callee);
    if (checkedCallee === errorType) return this.checkArgumentsOnly(args, errorType);
    const calleeType = this.nonNullableCallee(callee, checkedCallee, optional);
    const shortCircuits = chained !== undefined || (optional && calleeType !== checkedCallee);
    if (isAnyLike(calleeType)) return this.untypedCall(node, args, typeArguments);
    if (isIntrinsic(calleeType, 'unknown')) {
      this.c.error(
        callee,
        this.isName(callee) ? `'${callee.text}' の型は 'unknown' です。` : "オブジェクトの型は 'unknown' です。"
      );
      return this.checkArgumentsOnly(args, errorType);
    }
    const callable = this.callShape(calleeType);
    const { signatures } = callable;
    if (signatures.length === 0) {
      for (const arg of args) this.c.expressions.check(arg);
      return callable.untyped ? this.untypedCall(node, [], typeArguments) : this.uncallableType(callee, calleeType);
    }
    const receiver = access?.receiver;
    const resolution = this.resolveWithTextConversions(node, callee, signatures, args, {
      typeArguments,
      contextual,
      receiver,
    });
    if (!resolution) return errorType;
    this.resolved.set(node.id, resolution.signature);
    const result = resolution.returnType;
    return shortCircuits ? this.c.members.chainResult(node, result) : result;
  }

  private resolveWithTextConversions(
    node: TreeNode,
    callee: TreeNode,
    signatures: Signature[],
    args: TreeNode[],
    { typeArguments, contextual, receiver }: CallOptions
  ): Resolution | undefined {
    const conversions = this.textConversionArguments(callee, args);
    if (conversions.length === 0)
      return this.resolve(node, callee, signatures, args, typeArguments, contextual, receiver);
    const types = new Map<number, Type | undefined>(conversions.map((arg) => [arg.id, undefined]));
    const result = this.c.expressions.observeTypes(types, () =>
      this.resolve(node, callee, signatures, args, typeArguments, contextual, receiver)
    );
    for (const arg of conversions) {
      const type = types.get(arg.id);
      if (type) this.c.expressions.checkFunctionText(arg, type);
    }
    return result;
  }

  private checkCallCallee(callee: TreeNode, args: TreeNode[]): Type {
    const expression = skipParentheses(callee);
    if (!functionExpressionTypes.has(expression.type) || !isContextSensitiveFunction(expression))
      return this.c.expressions.check(callee);
    const { effective, afterArguments } = this.c.flow.probe(() =>
      this.c.silently(() => ({ effective: this.argumentElements(args), afterArguments: this.c.flow.current }))
    );
    const first = parameterNodes(expression)[0];
    const offset = first && isThisParameter(first) ? 1 : 0;
    const parameters = effective.slice(offset).map(({ type, optional, rest }, index) => ({
      name: `arg${index}`,
      type: this.c.widenLiteral(type),
      optional,
      rest,
    }));
    const context = functionType({
      typeParameters: [],
      parameters,
      immediateArgumentCount: args.length,
      returnType: () => unknownType,
    });
    return this.c.flow.withState(afterArguments, () => this.c.expressions.check(callee, context));
  }

  private checkArgumentsOnly(args: TreeNode[], result: Type = anyType): Type {
    for (const arg of args) this.c.expressions.check(arg);
    return result;
  }

  private untypedCall(node: TreeNode, args: TreeNode[], typeArguments: Type[] | undefined): Type {
    if (typeArguments) this.c.error(node, '型が付いていない関数の呼び出しに型引数は指定できません。');
    return this.checkArgumentsOnly(args, anyType);
  }

  /** The callee's type without `null` and `undefined`, reporting them unless the call is optional. */
  private nonNullableCallee(callee: TreeNode, type: Type, optional: boolean): Type {
    if (optional) return nonNullableType(this.c, type);
    if (isAnyLike(type)) return type;
    const bound = nullishConstraint(this.c, type);
    // A `void` callee is reported as not callable, as TypeScript does, rather than as possibly undefined.
    if (!typeMembers(bound).some((member) => isIntrinsic(member, 'null') || isIntrinsic(member, 'undefined')))
      return type;
    const withoutUndefined = this.c.relations.removeUndefined(bound);
    const what = isIntrinsic(withoutUndefined, 'never')
      ? 'undefined'
      : this.c.relations.isNullable(withoutUndefined)
        ? 'null'
        : 'undefined';
    this.c.error(callee, `${what} の可能性があるオブジェクトは呼び出せません。`);
    return nonNullableType(this.c, type, true);
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
      if (isAnyLike(apparent)) return { signatures: [], untyped: true, blocked: false };
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

  hasCallableSignatures(type: Type): boolean {
    return this.callShape(type).signatures.length > 0;
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

  newExpression(node: TreeNode, contextual?: Type): Type {
    const callee = node.childForFieldName('constructor') as TreeNode;
    const argumentsNode = node.childForFieldName('arguments');
    const args = argumentsNode ? named(argumentsNode) : [];
    const typeArguments = this.typeArguments.written(node);
    const calleeType = this.c.expressions.check(callee);
    const apparent = this.c.apparentType(calleeType);
    if (apparent === errorType) return this.checkArgumentsOnly(args, errorType);
    if (isAnyLike(apparent)) return this.untypedCall(node, args, typeArguments);
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
    if ((apparent.kind === 'union' ? apparent.types : [apparent]).some((member) => this.isAbstractClass(member)))
      this.c.error(node, '抽象クラスのインスタンスは作れません。');
    this.c.classes.checkConstructorAccessibility(node, signatures[0]);
    const resolution = this.resolve(node, callee, signatures, args, typeArguments, contextual);
    return resolution?.returnType ?? errorType;
  }

  private checkThisContext(
    callee: TreeNode,
    signature: Signature,
    context: Type | undefined,
    report: boolean
  ): boolean {
    const { thisType } = signature;
    if (!context || !thisType || isAnyLike(thisType) || isIntrinsic(thisType, 'void')) return true;
    if (this.c.relations.isAssignable(context, thisType)) return true;
    if (report)
      this.c.error(
        callee,
        `'this' の型 '${this.c.print(context)}' は、このメソッドの 'this' の型 '${this.c.print(thisType)}' に代入できません。`
      );
    return false;
  }

  private thisContext(node: TreeNode, callee: TreeNode, receiver: Type | undefined): Type | undefined {
    if (
      node.type === 'new_expression' ||
      callee.type === 'super' ||
      callee.childForFieldName('object')?.type === 'super'
    )
      return undefined;
    return receiver ?? voidType;
  }

  /** A tagged template, `String.raw\`...\``, which calls the tag with the template's strings and substitutions. */
  /**
   * `` tag`a${x}b` ``, a call of `tag` with a `TemplateStringsArray` of the strings and then the substitutions, which
   * `String.raw` turns into text.
   */
  private taggedTemplate(node: TreeNode, callee: TreeNode, template: TreeNode): Type {
    const substitutions = named(template)
      .filter((part) => part.type === 'template_substitution')
      .map((part) => named(part)[0]);
    const isStringRaw = this.isStringRawTag(callee);
    const calleeType = this.c.expressions.check(callee);
    const typeArguments = this.typeArguments.written(node);
    if (calleeType === errorType) return this.checkArgumentsOnly(substitutions, errorType);
    if (isAnyLike(calleeType)) return this.untypedCall(node, substitutions, typeArguments);
    const signatures = this.c.signaturesOf(calleeType, 'call');
    if (signatures.length === 0) {
      this.checkArgumentsOnly(substitutions, errorType);
      return this.uncallableType(callee, calleeType);
    }
    const strings = this.c.globalType('TemplateStringsArray');
    const fitting = signatures.filter((signature) => this.takesStrings(signature, strings));
    if (fitting.length === 0) {
      const parameter = signatures[0].parameters[0];
      this.c.error(
        template,
        `型 'TemplateStringsArray' の引数を型 '${this.c.print(parameter?.type ?? anyType)}' のパラメーターに渡すことはできません。`
      );
      return this.checkArgumentsOnly(substitutions, errorType);
    }
    const rest = fitting.map((signature) =>
      signature.parameters[0]?.rest ? signature : { ...signature, parameters: signature.parameters.slice(1) }
    );
    const resolution = isStringRaw
      ? this.resolveWithTextConversions(node, callee, rest, substitutions, { typeArguments })
      : this.resolve(node, callee, rest, substitutions, typeArguments, undefined);
    if (isStringRaw)
      for (const substitution of substitutions)
        this.c.expressions.checkFunctionText(
          substitution,
          this.c.silently(() => this.c.expressions.check(substitution))
        );
    return resolution?.returnType ?? errorType;
  }

  /** Whether a signature's first parameter takes the strings of a tagged template. */
  private takesStrings(signature: Signature, strings: Type): boolean {
    const parameter = signature.parameters[0];
    if (!parameter) return true;
    const type = parameter.rest ? this.c.restElementType(parameter.type) : parameter.type;
    return this.c.relations.isAssignable(strings, type);
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

  // code-gauge-allow functionCognitiveComplexity -- Matches the direct String argument and literal console placeholders in order.
  private textConversionArguments(callee: TreeNode, args: TreeNode[]): TreeNode[] {
    if (this.c.silent > 0 || args.length === 0) return [];
    const symbol = callee.type === 'identifier' ? this.c.scopeOf(callee).lookupValue(callee.text) : undefined;
    const declaration = symbol?.valueDeclaration;
    if (callee.text === 'String' && declaration && this.c.isLibrary(declaration))
      return args[0].type === 'spread_element' ? [] : [args[0]];
    const formatted = this.consoleFormatArguments(callee, args);
    const format = formatted[0];
    if (format?.type !== 'string') return [];
    const conversions: TreeNode[] = [];
    let index = 1;
    for (const placeholder of stringValue(format).matchAll(/%([%sdifjoOc])/g)) {
      const kind = placeholder[1];
      if (kind === '%') continue;
      const arg = formatted[index++];
      if (!arg || arg.type === 'spread_element') break;
      if (kind === 's') conversions.push(arg);
    }
    return conversions;
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
  endsFlow(node: TreeNode, result: Type): boolean {
    if (!isIntrinsic(result, 'never')) return false;
    const declaration = this.resolved.get(node.id)?.declaration;
    const callee = node.childForFieldName('function');
    if (!declaration || !callee) return false;
    return this.c.flow.probe(() =>
      this.c.silently(
        () =>
          isIntrinsic(this.c.functions.declaredReturnType(declaration) ?? unknownType, 'never') &&
          this.explicitPathType(callee) !== undefined
      )
    );
  }

  private explicitPathType(node: TreeNode): Type | undefined {
    const expression = skipParentheses(node);
    switch (expression.type) {
      case 'identifier': {
        const symbol = this.c.scopeOf(expression).lookupValue(expression.text);
        if (!symbol) return undefined;
        const declaration = symbol.valueDeclaration;
        if (symbol.valueKind === 'class' || symbol.valueKind === 'function' || declaration?.childForFieldName('type'))
          return this.c.expressions.valueTypeOf(symbol);
        return undefined;
      }
      case 'this': {
        return this.c.classes.explicitThisType(expression);
      }
      case 'super': {
        return this.c.classes.superType(expression);
      }
      case 'member_expression': {
        const object = expression.childForFieldName('object') as TreeNode;
        const property = expression.childForFieldName('property') as TreeNode;
        const receiver = this.explicitPathType(object);
        if (!receiver) return undefined;
        const member = this.c.propertyOf(
          this.c.relations.removeNullish(receiver),
          this.c.classes.propertyKey(expression, property)
        );
        return member?.isMethod || member?.declaration?.childForFieldName('type') ? member.type() : undefined;
      }
      default: {
        return undefined;
      }
    }
  }

  /** The type predicate a call's resolved signature has, with the expression it narrows. */
  predicateOf(
    node: TreeNode
  ): { target: TreeNode; type: Type; asserts?: NonNullable<Signature['predicate']>['asserts'] } | undefined {
    const signature = this.resolved.get(node.id);
    const predicate = signature?.predicate;
    if (!predicate) return undefined;
    const { type, asserts } = predicate;
    if (predicate.index === -1) {
      const callee = skipParentheses(node.childForFieldName('function') as TreeNode);
      const object = callee.type === 'member_expression' ? callee.childForFieldName('object') : undefined;
      return object ? { target: object, type, asserts } : undefined;
    }
    const argumentsNode = node.childForFieldName('arguments');
    const target = argumentsNode ? named(argumentsNode)[predicate.index] : undefined;
    return target ? { target, type, asserts } : undefined;
  }

  /** Whether every name of a callee has a declared type, which a call to an assertion function needs. */
  hasExplicitCalleeType(node: TreeNode): boolean {
    const callee = node.childForFieldName('function');
    return callee !== null && this.c.silently(() => this.explicitPathType(callee)) !== undefined;
  }

  // Resolution ---------------------------------------------------------------------------------------------------

  // code-gauge-allow functionParameterCount -- Tries each overload as TypeScript does, then reports the failure as it does.
  private resolve(
    node: TreeNode,
    callee: TreeNode,
    signatures: Signature[],
    args: TreeNode[],
    typeArguments: Type[] | undefined,
    contextual: Type | undefined,
    receiver?: Type
  ): Resolution | undefined {
    const eligible = this.typeArguments.candidates(node, signatures, typeArguments);
    const candidates = prioritizeLiteralOverloads(this.c, eligible);
    if (candidates.length === 0) {
      this.checkArgumentsOnly(args);
      return undefined;
    }
    const argumentFlow = new ExpressionListFlow(this.c, args);
    const context = this.thisContext(node, callee, receiver);
    const callbacks = candidates.length > 1 ? this.c.overloadContexts.callbacksOf(args) : undefined;
    const attempt: CallAttempt = {
      instantiate: (candidate) =>
        this.c.flow.probe(() => this.instantiateFor(candidate, argumentFlow, typeArguments, contextual, receiver)),
      checkThis: (signature, report = false) => this.checkThisContext(callee, signature, context, report),
      previewCallbacks: (signature) => {
        if (callbacks?.nodes.size)
          this.c.overloadContexts.capture(callbacks, () => this.previewArguments(signature, argumentFlow));
      },
    };
    const choose = (): Resolution =>
      this.chooseOverload(node, callee, candidates, argumentFlow, attempt, { typeArguments, contextual, receiver });
    return callbacks?.nodes.size ? this.c.overloadContexts.withCall(choose) : choose();
  }

  private chooseOverload(
    node: TreeNode,
    callee: TreeNode,
    candidates: Signature[],
    args: ExpressionListFlow,
    attempt: CallAttempt,
    options: CallOptions
  ): Resolution {
    const viable: Signature[] = [];
    let failed: { candidate: Signature; mismatch: TypeArgumentMismatch } | undefined;
    for (const candidate of candidates) {
      if (!this.arity.arityMatches(candidate, args)) continue;
      const mismatch = this.typeArguments.firstMismatch(candidate, options.typeArguments);
      if (mismatch) {
        failed = { candidate, mismatch };
        continue;
      }
      viable.push(candidate);
      const instantiated = this.c.silently(() => attempt.instantiate(candidate));
      if (!this.arity.instanceArityMatches(instantiated, candidate, args) || !attempt.checkThis(instantiated)) continue;
      attempt.previewCallbacks(instantiated);
      if (this.c.flow.probe(() => this.c.silently(() => this.checkArguments(instantiated, args.nodes, false))))
        return this.finishOverload(node, candidate, args, options, attempt);
    }
    if (viable.length === 0 && failed) {
      this.typeArguments.reportMismatch(node, failed.mismatch);
      const signature = attempt.instantiate(failed.candidate);
      this.checkArguments(signature, args.nodes, false);
      return { signature, returnType: signature.returnType() };
    }
    return this.reportUnresolved(node, callee, viable.length > 0 ? viable : candidates, args, attempt);
  }

  private finishOverload(
    node: TreeNode,
    candidate: Signature,
    args: ExpressionListFlow,
    { typeArguments, contextual, receiver }: CallOptions,
    attempt: CallAttempt
  ): Resolution {
    const deferred =
      candidate.typeParameters.length > 0 && !typeArguments
        ? this.c.expressions.deferredContexts.typeOf(node)
        : undefined;
    const final = this.c.flow.probe(() =>
      this.instantiateFor(candidate, args, typeArguments, deferred ?? contextual, receiver)
    );
    this.checkArguments(final, args.nodes, attempt.checkThis(final, true), node);
    this.checkImmediateBody(node, final);
    return { signature: final, returnType: final.returnType() };
  }

  private checkImmediateBody(node: TreeNode, signature: Signature): void {
    if (!signature.checkImmediateBody) return;
    const callee = node.childForFieldName('function');
    if (callee && skipParentheses(callee).id === signature.declaration?.id) signature.checkImmediateBody();
  }

  private previewArguments(signature: Signature, args: ExpressionListFlow): boolean {
    return this.c.flow.probe(() => this.c.silently(() => this.checkExpandedArguments(signature, args)));
  }

  private checkExpandedArguments(signature: Signature, args: ExpressionListFlow): boolean {
    const expanded = this.expandedArguments(args);
    const parameterTypes = this.argumentParameterTypes(signature, expanded);
    return expanded.every(({ node, before, spread }, index) => {
      const target = parameterTypes[index];
      if (spread) return !target || this.c.relations.isAssignable(this.spreadValueType(spread), target);
      return this.c.flow.probe(() => this.checkArgument(node, target, false, false), before);
    });
  }

  /** Reports that no overload accepts the arguments as TypeScript does, for the only fitting signature or the call. */
  private reportUnresolved(
    node: TreeNode,
    callee: TreeNode,
    candidates: Signature[],
    args: ExpressionListFlow,
    attempt: CallAttempt
  ): Resolution {
    const byArity = candidates.filter((candidate) => this.arity.arityMatches(candidate, args));
    if (candidates.length === 1 || byArity.length === 1)
      return this.reportSignature(node, callee, candidates.length === 1 ? candidates[0] : byArity[0], args, attempt);
    if (byArity.length === 0) {
      this.checkArgumentsOnly(args.nodes);
      const minimum = Math.min(...candidates.map((candidate) => minimumArguments(candidate)));
      const maximum = Math.max(...candidates.map((candidate) => this.arity.maximumArguments(candidate)));
      this.c.error(
        args.nodes.length > maximum ? args.nodes[maximum] : node,
        maximum === Number.POSITIVE_INFINITY || minimum === maximum
          ? `引数は ${minimum} 個必要ですが、${args.nodes.length} 個渡されています。`
          : `引数は ${minimum} 個から ${maximum} 個必要ですが、${args.nodes.length} 個渡されています。`
      );
      return { signature: candidates[0], returnType: candidates[0].returnType() };
    }
    const at = this.overloadErrorLocation(node, callee, byArity, args, attempt);
    const last = byArity.at(-1) as Signature;
    const returnType = this.c.silently(() => attempt.instantiate(last)).returnType();
    this.checkArgumentsOnly(args.nodes);
    const message = 'この呼び出しに合うオーバーロードがありません。';
    if (at) this.c.diagnostics.push({ ...at, message });
    else
      this.c.error(
        callee.type === 'member_expression' ? (callee.childForFieldName('property') ?? node) : node,
        message
      );
    return { signature: last, returnType };
  }

  /** Where TypeScript 7 reports that no overload fits: at the first error of the last overload that could fit. */
  private overloadErrorLocation(
    node: TreeNode,
    callee: TreeNode,
    candidates: Signature[],
    args: ExpressionListFlow,
    attempt: CallAttempt
  ): { row: number; index: number } | undefined {
    if (this.c.silent > 0) return undefined;
    const start = this.c.diagnostics.length;
    this.c.flow.probe(() => this.reportSignature(node, callee, candidates.at(-1) as Signature, args, attempt));
    const [first] = this.c.diagnostics.splice(start);
    return first && { row: first.row, index: first.index };
  }

  /** Reports why the only signature that could fit does not accept the arguments. */
  private reportSignature(
    node: TreeNode,
    callee: TreeNode,
    candidate: Signature,
    args: ExpressionListFlow,
    attempt: CallAttempt
  ): Resolution {
    const instantiated = this.arity.arityMatches(candidate, args) ? attempt.instantiate(candidate) : undefined;
    if (instantiated && this.arity.instanceArityMatches(instantiated, candidate, args)) {
      this.checkArguments(instantiated, args.nodes, attempt.checkThis(instantiated, true), node);
      this.checkImmediateBody(node, instantiated);
      return { signature: instantiated, returnType: instantiated.returnType() };
    }
    this.arity.reportArity(node, callee, instantiated ?? candidate, args);
    const returnType = (instantiated ?? this.c.silently(() => attempt.instantiate(candidate))).returnType();
    for (const arg of args.nodes) this.c.expressions.check(arg);
    this.checkImmediateBody(node, instantiated ?? candidate);
    return { signature: instantiated ?? candidate, returnType };
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

  /** Checks each argument against its parameter, reporting mismatches when `report`. */
  private checkArguments(signature: Signature, args: TreeNode[], report: boolean, call?: TreeNode): boolean {
    const restIndex = signature.parameters.length - 1;
    const restType = signature.parameters[restIndex]?.rest ? signature.parameters[restIndex].type : undefined;
    const structuredRest = restType?.kind === 'union' || this.c.relations.isGenericRestType(restType);
    const leadingSpread = args.slice(0, restIndex).some((arg) => arg.type === 'spread_element');
    if (structuredRest && leadingSpread)
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
    if ((isTrailingRestTuple(signature) || structuredRest) && !leadingSpread) {
      const fixedFit = this.checkArguments(
        { ...signature, parameters: signature.parameters.slice(0, -1) },
        args.slice(0, restIndex),
        report
      );
      const restFits = this.checkRestTupleArguments(
        signature.parameters[restIndex].type,
        args.slice(restIndex),
        report,
        fixedFit ? (args[restIndex] ?? call) : undefined
      );
      return fixedFit && restFits;
    }
    return this.checkAlignedArguments(signature, args, report);
  }

  private checkAlignedArguments(signature: Signature, args: TreeNode[], report: boolean): boolean {
    let ok = true;
    let index = 0;
    for (const arg of args) {
      if (arg.type === 'spread_element') {
        const { count, fits } = this.checkSpreadArgument(signature, arg, index, report && ok);
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
    return this.checkPassedArgument(arg, argType, parameterType, report, reportMismatch);
  }

  private checkPassedArgument(
    arg: TreeNode,
    argType: Type,
    parameterType: Type | undefined,
    report: boolean,
    reportMismatch: boolean
  ): boolean {
    if (!parameterType) return true;
    const writtenWithin = arg.type === 'spread_element' ? arg : undefined;
    if (this.c.relations.isAssignable(argType, parameterType))
      return this.c.expressions.checkExcessProperties(arg, argType, parameterType, { report, writtenWithin });
    if (
      reportMismatch &&
      this.c.expressions.checkExcessProperties(arg, argType, parameterType, { report, writtenWithin }) &&
      !this.c.expressions.elaboration.report(arg, argType, parameterType)
    ) {
      this.c.error(arg, this.c.expressions.elaboration.typeRelationMessage(argType, parameterType, 'argument'));
    }
    return false;
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
    const argumentFlow = new ExpressionListFlow(this.c, args);
    const contexts = restTupleContexts(this.c, restType, argumentFlow);
    const tuple =
      args.length === 1 && args[0].type === 'spread_element'
        ? mapType(this.c.expressions.check(named(args[0])[0]), (type) => this.spreadArgumentType(type, restType))
        : this.argumentTuple(args, contexts);
    if (this.c.relations.isAssignable(tuple, restType)) return !at || this.restExcessFits(at, tuple, restType, report);
    if (report && at) this.c.error(at, this.c.expressions.elaboration.typeRelationMessage(tuple, restType, 'argument'));
    return false;
  }

  private restExcessFits(node: TreeNode, source: Type, target: Type, report: boolean): boolean {
    if (source.kind === 'union')
      return source.types.every((member) => this.restExcessFits(node, member, target, report));
    if (source.kind !== 'object' || !source.tuple) return true;
    const elements = source.tuple.elements;
    const lengths = elements.map((element) => (element.rest ? undefined : 1));
    const candidates = typeMembers(target).filter((member) => this.c.relations.isAssignable(source, member));
    const writtenWithin = node.parent?.type === 'arguments' ? node.parent : node;
    const fits = (candidate: Type, emit: boolean): boolean => {
      this.c.budget.spend(elements.length);
      const contexts = tupleArgumentContexts(this.c, candidate, lengths);
      const arrayElement =
        candidate.kind === 'object' && !candidate.tuple && this.c.isArrayOrTuple(candidate)
          ? this.c.elementTypeOf(candidate)
          : undefined;
      return elements.every((element, index) => {
        const context = contexts[index] ?? arrayElement;
        return (
          !context ||
          this.c.expressions.checkExcessProperties(node, this.c.relations.tupleElementTargetType(element), context, {
            report: emit,
            writtenWithin,
          })
        );
      });
    };
    if (candidates.length === 0 || candidates.some((candidate) => fits(candidate, false))) return true;
    if (report) fits(candidates[0], true);
    return false;
  }

  private spreadArgumentType(type: Type, restType: Type): Type {
    const preserveGenerics = this.c.relations.isGenericRestType(restType);
    const source = preserveGenerics ? type : this.c.baseConstraint(type);
    if (source.kind !== 'object') return type;
    if (this.c.isReadonlyArrayType(source)) return this.c.arrayType(this.c.elementTypeOf(source));
    if (!source.tuple) return type;
    const { elements, readonly } = source.tuple;
    const spread = preserveGenerics
      ? elements
      : elements.map((element) => {
          const constraint = element.rest ? this.c.baseConstraint(element.type) : element.type;
          return constraint === element.type ? element : { ...element, type: constraint };
        });
    return readonly || spread.some((element, index) => element !== elements[index]) ? this.c.tupleType(spread) : type;
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
    const fits = elements.every((element, offset) =>
      this.checkPassedArgument(arg, element, this.parameterTypeAt(signature, index + offset), report, report)
    );
    return { count: elements.length, fits };
  }

  // Inference ----------------------------------------------------------------------------------------------------

  /** A signature with its type parameters replaced by the given or inferred type arguments. */
  // code-gauge-allow functionNcss -- Keeps the contextual return, receiver, ordinary arguments, and callbacks in inference order.
  // code-gauge-allow functionCognitiveComplexity -- Follows TypeScript's inference passes: the contextual return, context-insensitive arguments, then callbacks.
  private instantiateFor(
    signature: Signature,
    args: ExpressionListFlow,
    typeArguments: Type[] | undefined,
    contextual: Type | undefined,
    receiver: Type | undefined
  ): Signature {
    if (signature.typeParameters.length === 0) return signature;
    if (typeArguments) return this.typeArguments.instantiate(signature, typeArguments);
    const parameters = signature.typeParameters;
    const run = newInferenceRun(parameters, true);
    run.higherOrder = { outer: signature, parameters: [] };
    const restIndex = this.genericRestIndex(signature);
    const arguments_ = this.expandedArguments(args);
    const parameterTypes = this.argumentParameterTypes(signature, arguments_);
    this.recordImpliedArity(run, signature, arguments_);
    if (contextual)
      this.c.inference.inferTypes(
        { ...run, priority: InferencePriority.ReturnType },
        contextual,
        signature.returnType(),
        true
      );
    const returnContext = this.c.inference.partialMapper(parameters, run.inferences);
    // A `this` parameter infers from the object the method is called on.
    if (receiver && signature.thisType)
      this.c.inference.inferTypes({ ...run, contextualSignatures: false }, receiver, signature.thisType, true);
    // Context-insensitive arguments infer first; functions without parameter annotations then see what they inferred.
    const sensitive = arguments_.map(
      (arg) => !arg.spread && this.c.flow.probe(() => this.isContextSensitive(arg.node), arg.before)
    );
    for (const [index, arg] of arguments_.entries()) {
      if (restIndex !== undefined && index >= restIndex) continue;
      if (!sensitive[index]) this.inferFromArgument(run, arg, parameterTypes[index], returnContext);
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
    for (const [index, arg] of arguments_.entries()) {
      if (!sensitive[index]) continue;
      // A callback's parameters fix what they mention, while its return type keeps the rest to infer from it.
      const parameterType = parameterTypes[index];
      this.inferAnnotatedCallback(run, arg.node, parameterType);
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
    const instantiated = { ...this.c.instantiateSignature(signature, mapper), typeParameters: [] };
    return this.c.inference.withInferredCallbackParameters(run, instantiated);
  }

  private inferAnnotatedCallback(run: InferenceRun, node: TreeNode, context: Type | undefined): void {
    const expression = skipParentheses(node);
    if (!functionExpressionTypes.has(expression.type) || !isContextSensitiveFunction(expression)) return;
    const signature = contextualSignatureOf(this.c, context, expression);
    if (!signature) return;
    for (const [index, parameter] of argumentParameters(parameterNodes(expression)).entries()) {
      if (parameter.childForFieldName('pattern')?.type === 'rest_pattern') continue;
      const annotation = this.c.typeNodes.annotationType(parameter.childForFieldName('type'));
      const target = this.parameterTypeAt(signature, index);
      if (annotation && target) {
        const source = parameter.type === 'optional_parameter' ? unionOf([annotation, undefinedType]) : annotation;
        this.c.inference.inferTypes(run, source, target, false);
      }
    }
    const returned = this.c.functions.declaredReturnType(expression);
    if (returned) this.c.inference.inferTypes(run, returned, signature.returnType(), true);
  }

  /** Records how many arguments `...args: A` takes, which splits what `A` infers from `[...A, ...B]`. */
  private recordImpliedArity(run: InferenceRun, signature: Signature, args: ExpandedArgument[]): void {
    const restIndex = this.genericRestIndex(signature);
    if (restIndex === undefined) return;
    const rest = args.slice(restIndex);
    if (rest.some((arg) => arg.spread?.rest)) return;
    const restType = (signature.parameters.at(-1) as Parameter).type;
    const inference = run.inferences.get(restType.id);
    if (inference) inference.impliedArity = rest.length;
  }

  private expandedArguments(args: ExpressionListFlow): ExpandedArgument[] {
    return args.nodes.flatMap((node): ExpandedArgument[] => {
      const before = args.before(node);
      const type = args.spreadType(node);
      if (!type) return [{ node, before }];
      return this.c.silently(() => this.spreadElements(node, type)).map((spread) => ({ node, before, spread }));
    });
  }

  private argumentParameterTypes(signature: Signature, args: ExpandedArgument[]): (Type | undefined)[] {
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
    args: ExpandedArgument[],
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
        return {
          type: constContext
            ? this.probeArgumentType(arg, constContext)
            : this.c.widenLiteral(this.probeArgumentType(arg, contexts[index], mapper)),
          optional: false,
          rest: false,
        };
      })
    );
  }

  /** The tuple of what arguments pass, a spread one passing its tuple's elements or, for an array, a rest element. */
  private argumentTuple(args: TreeNode[], contexts: (Type | undefined)[] = []): Type {
    return this.c.tupleType(this.argumentElements(args, contexts));
  }

  private argumentElements(args: TreeNode[], contexts: (Type | undefined)[] = []): TupleElement[] {
    return args.flatMap((arg, index): TupleElement[] => {
      if (arg.type !== 'spread_element') {
        const type = this.c.expressions.check(arg, contexts[index]);
        return [{ type, optional: false, rest: false }];
      }
      const spreadType = this.c.expressions.check(named(arg)[0]);
      if (this.c.relations.isGenericRestType(spreadType)) return [{ type: spreadType, optional: false, rest: true }];
      return this.c.silently(() => this.spreadElements(arg, spreadType));
    });
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
    arg: ExpandedArgument,
    parameterType: Type | undefined,
    mapper: Mapper | undefined
  ): void {
    if (!parameterType) return;
    const argType = arg.spread ? this.spreadValueType(arg.spread) : this.probeArgumentType(arg, parameterType, mapper);
    if (arg.spread) this.c.inference.inferTypes(run, argType, parameterType, true);
    else this.c.inference.inferArgument(run, argType, parameterType);
  }

  private probeArgumentType(arg: ExpandedArgument, contextual: Type | undefined, mapper?: Mapper): Type {
    const context = contextual && mapper ? this.c.instantiateContextual(contextual, mapper) : contextual;
    return this.c.flow.probe(() => this.c.silently(() => this.c.expressions.check(arg.node, context)), arg.before);
  }

  private spreadElements(arg: TreeNode, type: Type): TupleElement[] {
    if (type.kind === 'object' && type.objectKind === 'tuple') return type.tuple?.elements ?? [];
    if (type.kind === 'union' && type.types.every((member) => this.c.isArrayOrTuple(member)))
      return [{ type, rest: true, optional: false }];
    const element = this.c.patterns.iteratedType(arg, type);
    return [{ type: this.c.arrayType(element), rest: true, optional: false }];
  }

  private spreadValueType(element: TupleElement): Type {
    if (element.rest) return this.c.restElementType(element.type);
    return element.optional ? unionOf([element.type, undefinedType]) : element.type;
  }

  private isGenericCallback(arg: TreeNode): boolean {
    const expression = skipParentheses(arg);
    if (functionExpressionTypes.has(expression.type)) return expression.childForFieldName('type_parameters') !== null;
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
function restTupleContexts(c: Checker, restType: Type, args: ExpressionListFlow): (Type | undefined)[] {
  const contexts = tupleArgumentContexts(
    c,
    restType,
    args.nodes.map((node) => args.length(node))
  );
  return contexts.map((context, index) => (args.nodes[index].type === 'spread_element' ? undefined : context));
}
