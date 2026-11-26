// code-gauge-allow-file fileNcss -- The callBinder module keeps one stage of the C# interpreter together.
import type { BoundArgument, BoundArguments, BoundExpression, BoundLValue } from './bound';
import { displayExtensionBlock, displayExtensionMember, displayMethodIn } from './declarations';
import { convertHandlerArguments, interpolationTargetOf, type PendingHandlerArgument } from './interpolatedConversions';
import type { MethodCandidate } from './lookup';
import { OperatorBinder } from './operatorBinder';
import { isBetterParamsCollection, type ParamsCollection, paramsCollectionOf } from './paramsCollections';
import type { LineMap } from './preprocessor';
import {
  allInterfacesOf,
  arrayType,
  baseTypeOf,
  displayMethod,
  displayType,
  displayTypeSymbol,
  ERROR_TYPE,
  isReferenceType,
  isRefLikeType,
  type MethodSymbol,
  type NamedType,
  nullableUnderlying,
  type ParameterSymbol,
  sameType,
  specialOf,
  substitute,
  substitutionOf,
  type Type,
  type TypeParameterSymbol,
  type TypeSymbol,
} from './types';
import { type DotnetOverload, dotnetOverloadsOf } from './unavailable';

/** An argument as written, bound to its natural type or left unbound until its parameter's type is known. */
/** The path that `[CallerFilePath]` gives, which stands for the program's file, whose real path no run has. */
const CALLER_FILE_PATH = '/Program.cs';

export interface ArgumentInfo {
  expression: BoundExpression;
  name: string | undefined;
  refKind: 'ref' | 'out' | 'in' | undefined;
  row: number;
  /** For `ref` and `out` arguments, the variable passed. */
  target: BoundLValue | undefined;
  /** For `out var x` and `out T x`, declares the variable once its type is known. */
  declareOut?: (type: Type) => BoundLValue;
  /** Whether an `out var` declaration needs its parameter's type. */
  isOutVar?: boolean;
  /** The argument's source text. */
  text?: string;
  /** Whether the argument is the receiver of an extension method call, which a `ref this` parameter takes by reference. */
  isReceiver?: boolean;
}

/** A candidate that the arguments fit, with how each argument maps to its parameters. */
interface Applicable {
  candidate: MethodCandidate;
  typeArgs: Type[];
  /** The type that each argument converts to. */
  argumentTypes: Type[];
  /** The parameter index of each argument. */
  parameterOf: number[];
  isExpanded: boolean;
  defaultsUsed: number;
}

export interface ResolvedCall {
  candidate: MethodCandidate;
  typeArgs: Type[];
  args: BoundArgument[];
}

/** How overload resolution names what it resolves in diagnostics. */
export interface CallDescription {
  name: string;
  kind: 'method' | 'constructor' | 'indexer' | 'delegate' | 'operator';
  /** For constructors, the type being created. */
  typeName?: string;
  /** Whether the candidates are extension methods, whose first argument is the receiver. */
  isExtension?: boolean;
  /** Whether the call is a collection initializer's `Add`, whose bad arguments Roslyn introduces with CS1950. */
  isCollectionInitializerAdd?: boolean;
}

interface Bounds {
  exact: Type[];
  lower: Type[];
  upper: Type[];
}

/** The state of inferring a generic method's type arguments. */
interface Inference {
  parameters: TypeParameterSymbol[];
  args: ArgumentInfo[];
  bounds: Map<TypeParameterSymbol, Bounds>;
  fixed: Map<TypeParameterSymbol, Type>;
  ownerSubstitution: Map<TypeParameterSymbol, Type>;
  /** The parameter type of each argument, with the owner's type arguments. */
  formals: Type[];
  /** The indices of the lambda arguments whose return types have not been inferred. */
  pending: Set<number>;
}

/** Resolves overloads as C# does, inferring type arguments and binding target-typed arguments to their parameters. */
export abstract class CallBinder extends OperatorBinder {
  /** Infers the return type of a lambda given its parameter types, or of a method group's chosen method. */
  protected abstract inferReturnType(
    expression: Extract<BoundExpression, { kind: 'unbound' }>,
    parameterTypes: Type[]
  ): Type | undefined;

  /** Whether a lambda argument binds without errors to a delegate type, which decides whether a candidate applies. */
  protected abstract lambdaParameterTypes(
    expression: Extract<BoundExpression, { kind: 'unbound' }>
  ): Type[] | undefined;

  /**
   * The params collection of a class or struct, or the `List<T>` of an interface, that the parameterless constructor
   * creates and an `Add` call for each element fills, whose accessibility the method's declaring type decides.
   */
  protected abstract createParamsCollection(
    collection: Extract<ParamsCollection, { kind: 'constructible' | 'list' }>,
    elements: BoundExpression[],
    declaringType: TypeSymbol,
    row: number
  ): BoundExpression;

  /** Resolves a call among candidates, reporting Roslyn's error when none applies or several tie. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  resolveCall(
    candidates: MethodCandidate[],
    args: ArgumentInfo[],
    explicitTypeArgs: Type[] | undefined,
    row: number,
    description: CallDescription
  ): ResolvedCall | undefined {
    const repeated = args.find(
      (arg, index) => arg.name !== undefined && args.slice(0, index).some((other) => other.name === arg.name)
    );
    if (repeated) {
      this.error(repeated.row, 'CS1740', `'${repeated.name}' という名前付き引数が複数指定されました`);
      return undefined;
    }
    const applicable: Applicable[] = [];
    for (const candidate of candidates) {
      const result = this.applicability(candidate, args, explicitTypeArgs);
      if (result) applicable.push(result);
    }
    if (applicable.length === 0) {
      this.reportInapplicable(candidates, args, explicitTypeArgs, row, description);
      return undefined;
    }
    const ranked = withHighestPriority(applicable);
    // A base type's candidates drop out once one declared in a more derived class or interface applies (C# spec
    // §12.6.4.1), whichever converts better.
    const mostDerived = ranked.filter(
      (candidate) =>
        !ranked.some(
          (other) =>
            other !== candidate && this.isMoreDerived(other.candidate.owner.symbol, candidate.candidate.owner.symbol)
        )
    );
    const best = this.bestOf(mostDerived, args) ?? this.libraryTieBreak(mostDerived, args);
    if (!best) {
      // An argument whose binding already failed fits every overload, which Roslyn does not report again; a
      // target-typed one (a lambda, a method group, `default`) has the error type only until its target is known.
      if (args.some((arg) => arg.expression.type.kind === 'error' && arg.expression.kind !== 'unbound'))
        return undefined;
      const [first, second] = this.tiedCandidates(mostDerived, args);
      // The runtime binder names them by their full type names and with `params`.
      const runtimeTie = this.isLateBinding ? this.runtimeBinderTie(mostDerived, args) : [first, second];
      this.lastAmbiguity = runtimeTie.map(({ candidate }) => {
        const parameters = candidate.method.parameters.map(
          (parameter) =>
            `${parameter.isParams ? 'params ' : ''}${displayType(substitute(parameter.type, substitutionOf(candidate.owner)))}`
        );
        return `${candidate.owner.symbol.fullName.replace(/`\d+$/, '')}.${candidate.method.name}(${parameters.join(', ')})`;
      });
      this.error(
        row,
        'CS0121',
        `次のメソッドまたはプロパティ間で呼び出しが不適切です: '${this.describe(first)}' と '${this.describe(second)}'`
      );
      return undefined;
    }
    if (!this.checkConstraints(best, row)) return undefined;
    return { candidate: best.candidate, typeArgs: best.typeArgs, args: this.finishArguments(best, args, row) };
  }

  private describe(applicable: Applicable): string {
    return displayMethodIn(applicable.candidate.method, applicable.candidate.owner, true);
  }

  /** The two candidates to name in an ambiguity error: the first two that no other candidate beats. */
  private tiedCandidates(applicable: Applicable[], args: ArgumentInfo[]): [Applicable, Applicable] {
    const undominated = applicable.filter(
      (candidate) => !applicable.some((other) => other !== candidate && this.isBetter(other, candidate, args))
    );
    const list = undominated.length >= 2 ? undominated : applicable;
    return [list[0], list[1]];
  }

  /**
   * The two candidates the runtime binder names in an ambiguity: it keeps the better of each candidate and the next,
   * skips past a pair that ties, and then checks the one it kept against those before it.
   */
  private runtimeBinderTie(applicable: Applicable[], args: ArgumentInfo[]): [Applicable, Applicable] {
    let tie: [Applicable, Applicable] | undefined;
    let kept = applicable[0];
    for (let index = 1; index < applicable.length; index++) {
      const contender = applicable[index];
      if (this.isBetter(kept, contender, args)) continue;
      if (this.isBetter(contender, kept, args)) {
        kept = contender;
        continue;
      }
      tie = [kept, contender];
      index++;
      if (index >= applicable.length) return tie;
      kept = applicable[index];
    }
    for (const earlier of applicable) {
      if (earlier === kept) break;
      if (!this.isBetter(kept, earlier, args)) return [kept, earlier];
    }
    return tie ?? [applicable[0], applicable[1]];
  }

  /** Maps arguments to a candidate's parameters, infers its type arguments, and checks the arguments convert. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private applicability(
    candidate: MethodCandidate,
    args: ArgumentInfo[],
    explicitTypeArgs: Type[] | undefined
  ): Applicable | undefined {
    const { method } = candidate;
    for (const form of [false, true]) {
      if (form && !this.hasExpandedForm(method)) break;
      const mapping = this.mapArguments(method, args, form);
      if (!mapping) continue;
      let typeArgs: Type[];
      if (method.typeParameters.length > 0) {
        if (explicitTypeArgs) {
          if (explicitTypeArgs.length !== method.typeParameters.length) return undefined;
          typeArgs = explicitTypeArgs;
        } else {
          const inferred = this.inferTypeArguments(candidate, args, mapping.parameterOf, form);
          // Inference fails in one form at a time: `Show<T>(params T[])` infers nothing from `Show(1)` until expanded.
          if (!inferred) continue;
          typeArgs = inferred;
        }
      } else {
        if (explicitTypeArgs && explicitTypeArgs.length > 0) return undefined;
        typeArgs = [];
      }
      const substitution = this.callSubstitution(candidate, typeArgs);
      if (!this.staticReceiverFits(candidate, substitution)) continue;
      const argumentTypes = args.map((_arg, index) =>
        this.parameterType(method, mapping.parameterOf[index], form, substitution)
      );
      if (
        args.every((arg, index) =>
          this.argumentFits(arg, argumentTypes[index], method.parameters[mapping.parameterOf[index]].refKind)
        )
      ) {
        return {
          candidate,
          typeArgs,
          argumentTypes,
          parameterOf: mapping.parameterOf,
          isExpanded: form,
          defaultsUsed: mapping.defaultsUsed,
        };
      }
    }
    return undefined;
  }

  /**
   * Whether the type that a static member of an extension block is accessed through converts to the block's receiver
   * type by identity, reference, or boxing, as an extension method's receiver does.
   */
  private staticReceiverFits(candidate: MethodCandidate, substitution: Map<TypeParameterSymbol, Type>): boolean {
    const { staticReceiver } = candidate;
    const extended = candidate.method.staticExtensionOf;
    if (!staticReceiver || !extended) return true;
    const kind = this.conversions.implicit(staticReceiver, substitute(extended, substitution));
    return kind === 'identity' || kind === 'reference' || kind === 'boxing' || kind === 'typeParameterBox';
  }

  protected callSubstitution(candidate: MethodCandidate, typeArgs: Type[]): Map<TypeParameterSymbol, Type> {
    const substitution = substitutionOf(candidate.owner);
    for (const [index, parameter] of candidate.method.typeParameters.entries())
      substitution.set(parameter, typeArgs[index] ?? ERROR_TYPE);
    return substitution;
  }

  /** The type an argument takes from its parameter, the element type for a `params` array in expanded form. */
  private parameterType(
    method: MethodSymbol,
    index: number,
    expanded: boolean,
    substitution: Map<TypeParameterSymbol, Type>
  ): Type {
    const parameter = method.parameters[index];
    const type = substitute(parameter.type, substitution);
    return expanded && parameter.isParams ? this.paramsElementType(type) : type;
  }

  /** The element type that a `params` parameter of the type takes in expanded form, or the type when it takes none. */
  private paramsElementType(type: Type): Type {
    return paramsCollectionOf(type, this.objectType)?.element ?? type;
  }

  /**
   * Whether a method has an expanded form: its last parameter is `params` of a collection type, or of a type parameter
   * of an anonymous delegate, which its type argument makes one.
   */
  private hasExpandedForm(method: MethodSymbol): boolean {
    const last = method.parameters.at(-1);
    if (!last?.isParams) return false;
    return last.type.kind === 'typeParameter' || paramsCollectionOf(last.type, this.objectType) !== undefined;
  }

  private mapArguments(
    method: MethodSymbol,
    args: ArgumentInfo[],
    expanded: boolean
  ): { parameterOf: number[]; defaultsUsed: number } | undefined {
    if (expanded && !this.hasExpandedForm(method)) return undefined;
    const parameters = method.parameters;
    const parameterOf: number[] = [];
    const filled = new Set<number>();
    const paramsIndex = expanded ? parameters.length - 1 : -1;
    for (const [index, arg] of args.entries()) {
      const target =
        arg.name === undefined
          ? this.positionalTarget(args, index, parameterOf, parameters.length, expanded)
          : this.namedTarget(arg.name, parameters, filled, paramsIndex);
      if (target === undefined) return undefined;
      parameterOf.push(target);
      filled.add(target);
    }
    const defaultsUsed = this.countDefaultsUsed(parameters, filled, expanded);
    if (defaultsUsed === undefined) return undefined;
    return { parameterOf, defaultsUsed };
  }

  private namedTarget(
    name: string,
    parameters: MethodSymbol['parameters'],
    filled: Set<number>,
    paramsIndex: number
  ): number | undefined {
    const target = parameters.findIndex((parameter) => parameter.name === name);
    if (target === -1 || (filled.has(target) && target !== paramsIndex)) return undefined;
    return target;
  }

  /** The parameter of a positional argument, which may not follow a named argument out of its position. */
  private positionalTarget(
    args: ArgumentInfo[],
    index: number,
    parameterOf: number[],
    parameterCount: number,
    expanded: boolean
  ): number | undefined {
    if (
      args
        .slice(0, index)
        .some((other) => other.name !== undefined && parameterOf[args.indexOf(other)] !== args.indexOf(other))
    )
      return undefined;
    const paramsIndex = expanded ? parameterCount - 1 : -1;
    const target = index < parameterCount ? index : paramsIndex;
    if (target < 0) return undefined;
    return expanded && index >= paramsIndex ? paramsIndex : target;
  }

  /** How many parameters without arguments take their default values, or undefined when one has none. */
  private countDefaultsUsed(
    parameters: MethodSymbol['parameters'],
    filled: Set<number>,
    expanded: boolean
  ): number | undefined {
    const paramsIndex = expanded ? parameters.length - 1 : -1;
    let defaultsUsed = 0;
    for (const [index, parameter] of parameters.entries()) {
      if (filled.has(index) || index === paramsIndex) continue;
      if (parameter.isParams && !expanded) return undefined;
      if (parameter.defaultSyntax === undefined && parameter.defaultValue === undefined) return undefined;
      defaultsUsed++;
    }
    return defaultsUsed;
  }

  private argumentFits(arg: ArgumentInfo, type: Type, refKind: 'ref' | 'out' | 'in' | undefined): boolean {
    // A receiver that is no variable still fits a `ref` receiver, which then reports it (CS1510).
    if (arg.isReceiver && refKind === 'ref')
      return sameType(arg.expression.type, type) || arg.expression.type.kind === 'error';
    // A `ref` argument may stand for an `in` or `ref readonly` parameter (C# 12), which Roslyn only warns of for `in`.
    if (refKind === 'in' && arg.refKind === 'ref')
      return sameType(arg.expression.type, type) || arg.expression.type.kind === 'error';
    if (refKind === 'ref' || refKind === 'out') {
      if (arg.refKind !== refKind) return false;
      if (arg.isOutVar) return true;
      return sameType(arg.expression.type, type) || arg.expression.type.kind === 'error';
    }
    if (arg.refKind === 'ref' || arg.refKind === 'out') return false;
    return this.implicitConversionOf(arg.expression, type) !== undefined;
  }

  /** Infers a generic method's type arguments from its arguments in C#'s two phases. */
  protected inferTypeArguments(
    candidate: MethodCandidate,
    args: ArgumentInfo[],
    parameterOf: number[],
    expanded: boolean
  ): Type[] | undefined {
    const { method } = candidate;
    const parameters = method.typeParameters;
    const ownerSubstitution = substitutionOf(candidate.owner);
    const inference: Inference = {
      parameters,
      args,
      bounds: new Map(parameters.map((parameter) => [parameter, { exact: [], lower: [], upper: [] }])),
      fixed: new Map(),
      ownerSubstitution,
      formals: args.map((_arg, index) => {
        const parameter = method.parameters[parameterOf[index]];
        const type = substitute(parameter.type, ownerSubstitution);
        return expanded && parameter.isParams ? this.paramsElementType(type) : type;
      }),
      pending: new Set(),
    };
    this.inferFromStaticReceiver(candidate, inference);
    this.inferFromArguments(inference, method, parameterOf);
    for (let round = 0; round <= parameters.length + args.length; round++) {
      this.inferLambdaReturnTypes(inference);
      const unfixed = parameters.filter((parameter) => !inference.fixed.has(parameter));
      if (unfixed.length === 0) break;
      const progress = this.fixBoundedParameters(inference, unfixed);
      if (progress === 'failed') return undefined;
      if (!progress && inference.pending.size === 0) break;
      if (!progress && this.lambdasAwaitUnfixed(inference)) break;
    }
    if (parameters.some((parameter) => !inference.fixed.has(parameter))) return undefined;
    return parameters.map((parameter) => inference.fixed.get(parameter) as Type);
  }

  /** The type that a static member of an extension block is accessed through infers the block's type arguments. */
  private inferFromStaticReceiver(candidate: MethodCandidate, inference: Inference): void {
    const extended = candidate.method.staticExtensionOf;
    if (candidate.staticReceiver && extended)
      this.lowerBoundInference(
        candidate.staticReceiver,
        substitute(extended, inference.ownerSubstitution),
        inference.bounds
      );
  }

  /** The first phase: bounds from the arguments with types, and from the explicit parameter types of lambdas. */
  private inferFromArguments(inference: Inference, method: MethodSymbol, parameterOf: number[]): void {
    const { bounds } = inference;
    for (const [index, arg] of inference.args.entries()) {
      const formal = inference.formals[index];
      if (arg.expression.kind === 'unbound') {
        inference.pending.add(index);
        this.inferFromLambdaParameters(arg.expression, formal, bounds);
        continue;
      }
      if (arg.isOutVar || arg.expression.type.kind === 'null') continue;
      const refKind = method.parameters[parameterOf[index]].refKind;
      if (refKind === 'ref' || refKind === 'out') this.exactInference(arg.expression.type, formal, bounds);
      else this.lowerBoundInference(arg.expression.type, formal, bounds);
    }
  }

  private inferFromLambdaParameters(
    expression: Extract<BoundExpression, { kind: 'unbound' }>,
    formal: Type,
    bounds: Map<TypeParameterSymbol, Bounds>
  ): void {
    const explicit = this.lambdaParameterTypes(expression);
    const invoke = this.delegateInvokeOf(formal);
    if (!explicit || !invoke) return;
    for (const [position, parameterType] of invoke.parameterTypes.entries()) {
      if (explicit[position]) this.exactInference(explicit[position], parameterType, bounds);
    }
  }

  /** Output type inference for lambdas whose parameter types are now known. */
  private inferLambdaReturnTypes(inference: Inference): void {
    const { pending } = inference;
    for (const index of pending) {
      const invoke = this.delegateInvokeOf(inference.formals[index]);
      if (!invoke) {
        pending.delete(index);
        continue;
      }
      const substitution = currentSubstitution(inference);
      const inputs = invoke.parameterTypes.map((type) => substitute(type, substitution));
      if (inputs.some((type) => this.mentionsUnfixed(type, inference.parameters, inference.fixed))) continue;
      pending.delete(index);
      const returnType = this.inferReturnType(
        inference.args[index].expression as Extract<BoundExpression, { kind: 'unbound' }>,
        inputs
      );
      if (returnType && returnType.kind !== 'void')
        this.lowerBoundInference(returnType, substitute(invoke.returnType, substitution), inference.bounds);
    }
  }

  /** Fixes the unfixed parameters that have bounds, telling whether any was fixed. */
  private fixBoundedParameters(inference: Inference, unfixed: TypeParameterSymbol[]): boolean | 'failed' {
    const { bounds, pending } = inference;
    const dependsOnPending = (parameter: TypeParameterSymbol): boolean =>
      [...pending].some((index) => {
        const invoke = this.delegateInvokeOf(inference.formals[index]);
        return invoke?.parameterTypes.some((type) => this.mentions(type, parameter)) === true;
      });
    let progress = false;
    for (const parameter of unfixed) {
      const parameterBounds = bounds.get(parameter) as Bounds;
      if (parameterBounds.exact.length + parameterBounds.lower.length + parameterBounds.upper.length === 0) continue;
      if (
        dependsOnPending(parameter) &&
        pending.size > 0 &&
        unfixed.some(
          (other) => other !== parameter && !dependsOnPending(other) && (bounds.get(other) as Bounds).lower.length > 0
        )
      )
        continue;
      const chosen = this.fix(parameterBounds);
      if (!chosen) return 'failed';
      inference.fixed.set(parameter, chosen);
      progress = true;
    }
    return progress;
  }

  /** Whether every pending lambda's inputs still mention unfixed parameters, so none can contribute. */
  private lambdasAwaitUnfixed(inference: Inference): boolean {
    return [...inference.pending].every((index) => {
      const invoke = this.delegateInvokeOf(inference.formals[index]);
      const substitution = currentSubstitution(inference);
      return (
        invoke?.parameterTypes.some((type) =>
          this.mentionsUnfixed(substitute(type, substitution), inference.parameters, inference.fixed)
        ) === true
      );
    });
  }

  private mentions(type: Type, parameter: TypeParameterSymbol): boolean {
    if (type.kind === 'typeParameter') return type.symbol === parameter;
    if (type.kind === 'array') return this.mentions(type.element, parameter);
    if (type.kind === 'named') return type.args.some((arg) => this.mentions(arg, parameter));
    return false;
  }

  private mentionsUnfixed(
    type: Type,
    parameters: TypeParameterSymbol[],
    fixed: Map<TypeParameterSymbol, Type>
  ): boolean {
    return parameters.some((parameter) => !fixed.has(parameter) && this.mentions(type, parameter));
  }

  /** The parameter and return types of a delegate type's `Invoke`, with the delegate's type arguments. */
  protected delegateInvokeOf(
    type: Type
  ): { parameterTypes: Type[]; returnType: Type; refKinds: ('ref' | 'out' | 'in' | undefined)[] } | undefined {
    if (type.kind !== 'named' || type.symbol.kind !== 'delegate' || !type.symbol.invoke) return undefined;
    const substitution = substitutionOf(type);
    const invoke = type.symbol.invoke;
    return {
      parameterTypes: invoke.parameters.map((parameter) => substitute(parameter.type, substitution)),
      returnType: substitute(invoke.returnType, substitution),
      refKinds: invoke.parameters.map((parameter) => parameter.refKind),
    };
  }

  private exactInference(from: Type, to: Type, bounds: Map<TypeParameterSymbol, Bounds>): void {
    if (to.kind === 'typeParameter' && bounds.has(to.symbol)) {
      (bounds.get(to.symbol) as Bounds).exact.push(from);
      return;
    }
    if (to.kind === 'array' && from.kind === 'array' && from.rank === to.rank) {
      this.exactInference(from.element, to.element, bounds);
      return;
    }
    if (to.kind === 'named' && from.kind === 'named' && from.symbol === to.symbol) {
      for (const [index, arg] of to.args.entries()) this.exactInference(from.args[index], arg, bounds);
    }
  }

  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private lowerBoundInference(from: Type, to: Type, bounds: Map<TypeParameterSymbol, Bounds>): void {
    if (to.kind === 'typeParameter' && bounds.has(to.symbol)) {
      const list = (bounds.get(to.symbol) as Bounds).lower;
      if (!list.some((existing) => sameType(existing, from))) list.push(from);
      return;
    }
    const toUnderlying = nullableUnderlying(to);
    if (toUnderlying) {
      this.exactInference(nullableUnderlying(from) ?? from, toUnderlying, bounds);
      return;
    }
    if (to.kind === 'array') {
      if (from.kind === 'array' && from.rank === to.rank) {
        if (isReferenceType(from.element)) this.lowerBoundInference(from.element, to.element, bounds);
        else this.exactInference(from.element, to.element, bounds);
      }
      return;
    }
    if (to.kind !== 'named' || to.args.length === 0) return;
    const match = this.matchingConstructed(from, to);
    if (!match) return;
    for (const [index, parameter] of to.symbol.allTypeParameters.entries()) {
      const fromArg = match.args[index];
      const toArg = to.args[index];
      if (parameter.variance === 'out' && isReferenceType(fromArg)) this.lowerBoundInference(fromArg, toArg, bounds);
      else if (parameter.variance === 'in' && isReferenceType(fromArg))
        this.upperBoundInference(fromArg, toArg, bounds);
      else this.exactInference(fromArg, toArg, bounds);
    }
  }

  private upperBoundInference(from: Type, to: Type, bounds: Map<TypeParameterSymbol, Bounds>): void {
    if (to.kind === 'typeParameter' && bounds.has(to.symbol)) {
      (bounds.get(to.symbol) as Bounds).upper.push(from);
      return;
    }
    this.exactInference(from, to, bounds);
  }

  /** The type among a type's bases and interfaces that is a construction of the same generic type as `to`. */
  private matchingConstructed(from: Type, to: NamedType): NamedType | undefined {
    if (from.kind === 'named' && from.symbol === to.symbol) return from;
    if (to.symbol.kind === 'interface') {
      const matches = allInterfacesOf(from, (element) => this.wellKnown.arrayInterfaces(element)).filter(
        (face) => face.symbol === to.symbol
      );
      return matches.length === 1 ? matches[0] : undefined;
    }
    for (let current = baseTypeOf(from); current; current = baseTypeOf(current))
      if (current.symbol === to.symbol) return current;
    return undefined;
  }

  /** Chooses a type argument from its bounds: the exact bound, or the one candidate all lower bounds convert to. */
  private fix(bounds: Bounds): Type | undefined {
    if (bounds.exact.length > 0) {
      const [first] = bounds.exact;
      const fits =
        bounds.exact.every((type) => sameType(type, first)) &&
        bounds.lower.every((lower) => this.conversions.implicit(lower, first) !== undefined) &&
        bounds.upper.every((upper) => this.conversions.implicit(first, upper) !== undefined);
      return fits ? first : undefined;
    }
    const candidates = [...bounds.lower, ...bounds.upper].filter(
      (type, index, list) => list.findIndex((other) => sameType(other, type)) === index
    );
    const viable = candidates.filter(
      (candidate) =>
        bounds.lower.every((lower) => this.conversions.implicit(lower, candidate) !== undefined) &&
        bounds.upper.every((upper) => this.conversions.implicit(candidate, upper) !== undefined)
    );
    if (viable.length === 1) return viable[0];
    const best = viable.filter((candidate) =>
      viable.every((other) => other === candidate || this.conversions.implicit(other, candidate) !== undefined)
    );
    return best.length === 1 ? best[0] : undefined;
  }

  private bestOf(applicable: Applicable[], args: ArgumentInfo[]): Applicable | undefined {
    const best = applicable.filter((candidate) =>
      applicable.every((other) => other === candidate || this.isBetter(candidate, other, args))
    );
    return best.length === 1 ? best[0] : undefined;
  }

  /** Whether a candidate is a better function member than another for the arguments. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private isBetter(a: Applicable, b: Applicable, args: ArgumentInfo[]): boolean {
    let isBetterSomewhere = false;
    for (const [index, arg] of args.entries()) {
      const comparison = this.compareConversions(arg, a.argumentTypes[index], b.argumentTypes[index]);
      if (comparison < 0) return false;
      if (comparison > 0) isBetterSomewhere = true;
    }
    if (isBetterSomewhere) return true;
    if (args.some((_arg, index) => !sameType(a.argumentTypes[index], b.argumentTypes[index]))) return false;
    const aGeneric = a.candidate.method.typeParameters.length > 0;
    const bGeneric = b.candidate.method.typeParameters.length > 0;
    if (!aGeneric && bGeneric) return true;
    if (aGeneric && !bGeneric) return false;
    if (a.isExpanded !== b.isExpanded) return b.isExpanded;
    const collectionOrder = a.isExpanded ? this.compareParamsCollections(a, b) : 0;
    if (collectionOrder !== 0) return collectionOrder > 0;
    if (a.defaultsUsed < b.defaultsUsed) return true;
    if (a.defaultsUsed > b.defaultsUsed) return false;
    const aSpecific = this.moreSpecific(a, b);
    return aSpecific === 1;
  }

  /** Compares the params collections of two candidates in expanded form (C# 13): 1 when the first is better. */
  private compareParamsCollections(a: Applicable, b: Applicable): number {
    const aCollection = this.expandedCollection(a);
    const bCollection = this.expandedCollection(b);
    if (!aCollection || !bCollection || sameType(aCollection.type, bCollection.type)) return 0;
    const converts = (from: Type, to: Type): boolean => this.conversions.implicit(from, to) !== undefined;
    if (isBetterParamsCollection(aCollection, bCollection, converts)) return 1;
    return isBetterParamsCollection(bCollection, aCollection, converts) ? -1 : 0;
  }

  /** The collection that a candidate in expanded form passes its `params` arguments in. */
  private expandedCollection(applicable: Applicable): ParamsCollection | undefined {
    const { method } = applicable.candidate;
    const type = method.parameters.at(-1)?.type ?? ERROR_TYPE;
    return paramsCollectionOf(
      substitute(type, this.callSubstitution(applicable.candidate, applicable.typeArgs)),
      this.objectType
    );
  }

  /** Compares declared parameter types, where a type parameter is less specific than any other type. */
  private moreSpecific(a: Applicable, b: Applicable): number {
    let result = 0;
    const declared = (applicable: Applicable, index: number): Type =>
      substitute(
        applicable.candidate.method.parameters[applicable.parameterOf[index]]?.type ?? ERROR_TYPE,
        substitutionOf(applicable.candidate.owner)
      );
    for (let index = 0; index < a.parameterOf.length; index++) {
      const order = this.specificity(declared(a, index), declared(b, index));
      if (order < 0) return -1;
      if (order > 0) result = 1;
    }
    return result;
  }

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private specificity(a: Type, b: Type): number {
    if (a.kind === 'typeParameter' && b.kind !== 'typeParameter') return -1;
    if (a.kind !== 'typeParameter' && b.kind === 'typeParameter') return 1;
    if (a.kind === 'named' && b.kind === 'named' && a.symbol === b.symbol) {
      let result = 0;
      for (const [index, arg] of a.args.entries()) {
        const order = this.specificity(arg, b.args[index]);
        if (order < 0) return -1;
        if (order > 0) result = 1;
      }
      return result;
    }
    if (a.kind === 'array' && b.kind === 'array') return this.specificity(a.element, b.element);
    return 0;
  }

  /** Compares the conversions of an argument to two parameter types: 1 when the first is better, -1 when the second is. */
  protected compareConversions(arg: ArgumentInfo, a: Type, b: Type): number {
    if (sameType(a, b)) return 0;
    const expression = arg.expression;
    if (expression.kind === 'unbound') {
      if (expression.node.kind === 'collection') return this.compareCollectionConversions(expression, a, b);
      return this.compareLambdaConversions(expression, a, b) ?? this.betterTarget(a, b);
    }
    return compareHandlerConversions(expression, a, b) ?? compareExactConversions(arg, a, b) ?? this.betterTarget(a, b);
  }

  /**
   * Compares a collection expression's conversions to two collection types (C# 13): by its elements' conversions to
   * the element types where those differ, and otherwise by the types themselves.
   */
  private compareCollectionConversions(
    expression: Extract<BoundExpression, { kind: 'unbound' }>,
    a: Type,
    b: Type
  ): number {
    const aElement = collectionExpressionElement(a) ?? this.collectionElementType(a);
    const bElement = collectionExpressionElement(b) ?? this.collectionElementType(b);
    if (!aElement || !bElement) return this.betterTarget(a, b);
    if (sameType(aElement, bElement)) {
      if (isBetterCollectionType(a, b, (from, to) => this.conversions.implicit(from, to) !== undefined)) return 1;
      return isBetterCollectionType(b, a, (from, to) => this.conversions.implicit(from, to) !== undefined) ? -1 : 0;
    }
    // Each element must convert to one element type at least as well as to the other, and one better.
    let result = 0;
    for (const element of this.collectionElementValues(expression)) {
      const order = this.compareConversions(
        { expression: element, name: undefined, refKind: undefined, row: element.row, target: undefined },
        aElement,
        bElement
      );
      if (order !== 0 && result !== 0 && order !== result) return 0;
      if (order !== 0) result = order;
    }
    return result;
  }

  /** Compares a lambda's conversions to delegate types of the same parameter types by its inferred return type. */
  private compareLambdaConversions(
    expression: Extract<BoundExpression, { kind: 'unbound' }>,
    a: Type,
    b: Type
  ): number | undefined {
    const aInvoke = this.delegateInvokeOf(a);
    const bInvoke = this.delegateInvokeOf(b);
    if (
      !aInvoke ||
      !bInvoke ||
      aInvoke.parameterTypes.length !== bInvoke.parameterTypes.length ||
      !aInvoke.parameterTypes.every((type, index) => sameType(type, bInvoke.parameterTypes[index]))
    )
      return undefined;
    // A delegate with a return type is better than a void one when the lambda converts to both (C# spec
    // §12.6.4.5), as `() => throw e` for `Func<Task>` over `Action`.
    const aReturns = aInvoke.returnType.kind !== 'void';
    const bReturns = bInvoke.returnType.kind !== 'void';
    if (aReturns !== bReturns) return aReturns ? 1 : -1;
    const inferred = this.inferReturnType(expression, aInvoke.parameterTypes);
    if (!inferred) return undefined;
    if (sameType(inferred, aInvoke.returnType) && !sameType(inferred, bInvoke.returnType)) return 1;
    if (sameType(inferred, bInvoke.returnType) && !sameType(inferred, aInvoke.returnType)) return -1;
    return this.betterTarget(aInvoke.returnType, bInvoke.returnType);
  }

  /** Whether one type is a better conversion target than another: 1 for the first, -1 for the second. */
  protected betterTarget(a: Type, b: Type): number {
    const aToB = this.convertsImplicitly(a, b);
    const bToA = this.convertsImplicitly(b, a);
    if (aToB && !bToA) return 1;
    if (bToA && !aToB) return -1;
    const signedOver: Record<string, string[]> = {
      sbyte: ['byte', 'ushort', 'uint', 'ulong'],
      short: ['ushort', 'uint', 'ulong'],
      int: ['uint', 'ulong'],
      long: ['ulong'],
    };
    const aSpecial = specialOf(a) ?? '';
    const bSpecial = specialOf(b) ?? '';
    if (signedOver[aSpecial]?.includes(bSpecial)) return 1;
    if (signedOver[bSpecial]?.includes(aSpecial)) return -1;
    return 0;
  }

  /** Whether a type converts implicitly to another, by a user-defined conversion too, as `long` does to BigInteger. */
  private convertsImplicitly(source: Type, target: Type): boolean {
    if (this.conversions.implicit(source, target) !== undefined) return true;
    if (source.kind !== 'named' || target.kind !== 'named') return false;
    const user = this.userConversion({ kind: 'default', type: source, row: 0 }, target, false);
    return user !== undefined && !('ambiguous' in user);
  }

  private checkConstraints(applicable: Applicable, row: number): boolean {
    const { method } = applicable.candidate;
    for (const [index, parameter] of method.typeParameters.entries()) {
      const arg = applicable.typeArgs[index];
      if (
        !this.satisfiesConstraints(
          arg,
          parameter,
          this.callSubstitution(applicable.candidate, applicable.typeArgs),
          row,
          constraintOwner(method, index)
        )
      )
        return false;
    }
    return true;
  }

  /** Checks a type argument against its parameter's constraints, reporting the first it breaks. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  satisfiesConstraints(
    arg: Type,
    parameter: TypeParameterSymbol,
    substitution: Map<TypeParameterSymbol, Type>,
    row: number,
    owner: string
  ): boolean {
    if (arg.kind === 'error') return true;
    if (!this.checkTypeArgumentKind(arg, parameter.name, owner, row, parameter.allowsRefStruct)) return false;
    if (
      parameter.hasReferenceConstraint &&
      !this.isReference(arg) &&
      !(arg.kind === 'typeParameter' && arg.symbol.hasReferenceConstraint)
    ) {
      this.error(
        row,
        'CS0452',
        `型 '${displayType(arg)}' は、ジェネリック型のパラメーター '${parameter.name}'、またはメソッド '${owner}' として使用するために、参照型でなければなりません`
      );
      return false;
    }
    if (parameter.hasUnmanagedConstraint && !isUnmanagedType(arg)) {
      this.error(
        row,
        'CS8377',
        `型 '${displayType(arg)}' と、入れ子になっているあらゆるレベルのすべてのフィールドは、ジェネリック型またはメソッド '${owner}' のパラメーター '${parameter.name}' として使用するために、Null 非許容の値型でなければなりません`
      );
      return false;
    }
    if (
      parameter.hasValueConstraint &&
      (!(arg.kind === 'named' && arg.symbol.isValueType) || nullableUnderlying(arg)) &&
      !(arg.kind === 'typeParameter' && arg.symbol.hasValueConstraint)
    ) {
      this.error(
        row,
        'CS0453',
        `型 '${displayType(arg)}' は、ジェネリック型のパラメーター '${parameter.name}'、またはメソッド '${owner}' として使用するために、Null 非許容の値型でなければなりません`
      );
      return false;
    }
    if (
      parameter.hasConstructorConstraint &&
      arg.kind === 'named' &&
      (arg.symbol.isAbstract ||
        (arg.symbol.kind === 'class' &&
          !arg.symbol.constructors.some(
            (constructor) => constructor.parameters.length === 0 && constructor.access === 'public'
          )))
    ) {
      this.error(
        row,
        'CS0310',
        `'${displayType(arg)}' は、ジェネリック型またはメソッド '${owner}' 内でパラメーター '${parameter.name}' として使用するために、パブリック パラメーターなしのコンストラクターを持つ非抽象型でなければなりません`
      );
      return false;
    }
    for (const constraint of parameter.constraintTypes) {
      const target = substitute(constraint, substitution);
      if (
        !this.conversions.implicit(arg, target) &&
        !this.refStructImplements(arg, target) &&
        !(
          arg.kind === 'named' &&
          target.kind === 'named' &&
          target.symbol.special === 'enum' &&
          arg.symbol.kind === 'enum'
        )
      ) {
        const code = arg.kind === 'named' && arg.symbol.isValueType ? 'CS0315' : 'CS0311';
        const how =
          code === 'CS0315'
            ? `'${displayType(arg, true)}' から '${displayType(target, true)}' へのボックス変換がありません。`
            : `'${displayType(arg, true)}' から '${displayType(target, true)}' への暗黙的な参照変換がありません。`;
        this.error(
          row,
          code,
          `型 '${displayType(arg)}' はジェネリック型またはメソッド '${owner}' 内で型パラメーター '${parameter.name}' として使用できません。${how}`
        );
        return false;
      }
    }
    return true;
  }

  /**
   * Whether a ref struct implements an interface, which satisfies an interface constraint of a parameter with `allows
   * ref struct` (C# 13) although it has no boxing conversion to it.
   */
  private refStructImplements(arg: Type, target: Type): boolean {
    return (
      arg.kind === 'named' &&
      isRefLikeType(arg) &&
      target.kind === 'named' &&
      this.allInterfaces(arg).some((face) => sameType(face, target))
    );
  }

  /** The variable of a `ref` or `out` argument, reporting a receiver that is none for a `ref` receiver (CS1510). */
  private refArgumentTarget(arg: ArgumentInfo, type: Type, row: number): BoundLValue {
    if (arg.declareOut) return arg.declareOut(type);
    if (arg.target) return arg.target;
    if (arg.isReceiver) this.error(row, 'CS1510', 'ref または out 値は、割り当て可能な変数でなければなりません');
    return { kind: 'discard', type: ERROR_TYPE, row: arg.row };
  }

  /** Converts the arguments to their parameters' types and orders them as the parameters, filling defaults and packing `params`. */
  private finishArguments(applicable: Applicable, args: ArgumentInfo[], row: number): BoundArguments {
    const { method } = applicable.candidate;
    const substitution = this.callSubstitution(applicable.candidate, applicable.typeArgs);
    const result: (BoundArgument | undefined)[] = Array.from({ length: method.parameters.length });
    const paramsElements: BoundExpression[] = [];
    const handlers: PendingHandlerArgument[] = [];
    for (const [index, arg] of args.entries()) {
      const parameterIndex = applicable.parameterOf[index];
      const parameter = method.parameters[parameterIndex];
      const type = applicable.argumentTypes[index];
      if (parameter.refKind === 'ref' || parameter.refKind === 'out') {
        const target = this.refArgumentTarget(arg, type, row);
        result[parameterIndex] = { kind: 'refArgument', target, refKind: parameter.refKind, type, row: arg.row };
        continue;
      }
      const handler = this.pendingHandlerArgument(arg, parameter, parameterIndex, type);
      if (handler) {
        handlers.push(handler);
        result[parameterIndex] = { kind: 'default', type, row: arg.row };
        continue;
      }
      const converted = this.convert(arg.expression, type, arg.row);
      if (applicable.isExpanded && parameterIndex === method.parameters.length - 1) paramsElements.push(converted);
      else result[parameterIndex] = converted;
    }
    const collection = applicable.isExpanded ? this.expandedCollection(applicable) : undefined;
    if (collection) result[method.parameters.length - 1] = this.packParams(collection, paramsElements, method, row);
    for (const [index, parameter] of method.parameters.entries()) {
      result[index] ??= this.omittedArgument(method, parameter, substitution, args, applicable.parameterOf, row);
    }
    return this.withHandlerArguments(handlers, applicable, result, row);
  }

  /** The `params` collection of the arguments of the expanded form, created as a collection expression of them is. */
  private packParams(
    collection: ParamsCollection,
    elements: BoundExpression[],
    method: MethodSymbol,
    row: number
  ): BoundExpression {
    if (collection.kind === 'constructible' || collection.kind === 'list')
      return this.createParamsCollection(collection, elements, method.owner, row);
    const array = arrayType(collection.element);
    const created: BoundExpression = {
      kind: 'newArray',
      arrayType: array,
      sizes: [this.constant(elements.length, this.intType, row)],
      elements,
      type: array,
      row,
    };
    return collection.kind === 'span' ? this.convert(created, collection.type, row) : created;
  }

  /**
   * Converts the deferred handler arguments once the others are, ordering the arguments as the source evaluates them,
   * with the local that a handler takes the receiver from, if any, which the call then keeps the receiver in.
   */
  private withHandlerArguments(
    handlers: PendingHandlerArgument[],
    applicable: Applicable,
    result: (BoundArgument | undefined)[],
    row: number
  ): BoundArguments {
    const handlerReceiver = convertHandlerArguments(
      handlers,
      applicable.candidate.method,
      applicable.candidate.owner,
      result,
      (source, target, values) => this.bindInterpolationConversion(source, target, values, row)
    );
    const finished = withSourceOrder(result as BoundArgument[], applicable.parameterOf);
    return handlerReceiver ? Object.assign(finished, { handlerReceiver }) : finished;
  }

  /** An interpolated string argument of a handler parameter whose constructor takes other arguments of the call. */
  private pendingHandlerArgument(
    arg: ArgumentInfo,
    parameter: ParameterSymbol,
    parameterIndex: number,
    type: Type
  ): PendingHandlerArgument | undefined {
    if (!parameter.handlerArguments || interpolationTargetOf(type) !== 'handler') return undefined;
    const source = this.interpolationConvertingTo(arg.expression, type);
    return source && { parameter, parameterIndex, source, type: type as NamedType };
  }

  /** The value of an omitted optional argument, or the source text of another argument that it names. */
  private omittedArgument(
    method: MethodSymbol,
    parameter: ParameterSymbol,
    substitution: Map<TypeParameterSymbol, Type>,
    args: ArgumentInfo[],
    parameterOf: number[],
    row: number
  ): BoundExpression {
    const type = substitute(parameter.type, substitution);
    const info = parameter.callerInfo;
    if (info && parameter.defaultSyntax) {
      switch (info.kind) {
        case 'MemberName': {
          return this.constant(this.callerMember, type, row);
        }
        case 'LineNumber': {
          const line = (this.lineMap?.map(row) ?? row) + 1;
          return this.convert(this.constant(line, this.intType, row), type, row);
        }
        case 'FilePath': {
          return this.constant(CALLER_FILE_PATH, type, row);
        }
        case 'ArgumentExpression': {
          const index = method.parameters.findIndex((other) => other.name === info.parameterName);
          const text = index === -1 ? undefined : args[parameterOf.indexOf(index)]?.text;
          if (text !== undefined) return this.constant(text, type, row);
          break;
        }
      }
    }
    const callerArgument = this.callerArgumentExpression(method, parameter, args, parameterOf);
    return callerArgument === undefined
      ? this.defaultArgument(parameter, type, row)
      : this.constant(callerArgument, type, row);
  }

  /**
   * The source text of the argument that an omitted `paramName` of .NET's `ThrowIf...` guards receives through its
   * `[CallerArgumentExpression]` attribute, which the library here does not declare.
   */
  private callerArgumentExpression(
    method: MethodSymbol,
    parameter: ParameterSymbol,
    args: ArgumentInfo[],
    parameterOf: number[]
  ): string | undefined {
    if (!method.owner.isLibrary || !method.name.startsWith('ThrowIf') || parameter.name !== 'paramName')
      return undefined;
    return args[parameterOf.indexOf(0)]?.text;
  }

  /** The name of the member whose body is being bound, which `[CallerMemberName]` gives. */
  protected callerMember = '';
  /** The rows that `#line` directives give `[CallerLineNumber]`. */
  protected lineMap: LineMap | undefined;

  /** The value of an omitted optional argument. */
  protected abstract defaultArgument(
    parameter: MethodSymbol['parameters'][number],
    type: Type,
    row: number
  ): BoundExpression;

  /** Reports a call whose type arguments no candidate takes as many of, as Roslyn does before matching arguments. */
  private reportTypeArgumentCount(candidates: MethodCandidate[], count: number, row: number): boolean {
    if (candidates.some((candidate) => candidate.method.typeParameters.length === count)) return false;
    const [{ method, owner }] = candidates;
    const name = displayMethodIn(method, owner);
    if (method.typeParameters.length === 0)
      this.error(row, 'CS0308', `非ジェネリック メソッド '${name}' は型引数と一緒には使用できません`);
    else
      this.error(
        row,
        'CS0305',
        `ジェネリック メソッド '${name}' を使用するには、${method.typeParameters.length} 型引数が必要です`
      );
    return true;
  }

  /** Whether a type derives from a base class or extends or implements an interface. */
  private isMoreDerived(type: TypeSymbol, base: TypeSymbol): boolean {
    if (this.derivesFrom(type, base)) return true;
    return allInterfacesOf(type.declaredType, (element) => this.wellKnown.arrayInterfaces(element)).some(
      (face) => face.symbol === base
    );
  }

  /**
   * Reports a call of a library method that no declared overload takes as unavailable, rather than as a wrong call,
   * when .NET has more overloads of that many arguments than the library declares and one of them could take the
   * arguments, as for `new HashSet<int>(100)`. The count keeps a generic parameter, which takes any argument here, from
   * covering a wrong argument to an overload the library does declare, as in `list.Add("x")`.
   */
  private rejectUnavailableOverload(
    candidates: MethodCandidate[],
    args: ArgumentInfo[],
    declaredCount: number,
    row: number
  ): void {
    const method = candidates[0]?.method;
    if (!method?.owner.isLibrary || method.kind === 'operator') return;
    const isConstructor = method.kind === 'constructor';
    const name = isConstructor ? '.ctor' : method.name;
    const overloads = dotnetOverloadsOf(method.owner.fullName, name).filter(
      ({ required, takesMore, types }) => args.length >= required && (takesMore || args.length <= types.length)
    );
    if (overloads.length <= declaredCount || !overloads.some((overload) => this.dotnetOverloadTakes(overload, args)))
      return;
    const owner = displayTypeSymbol(method.owner);
    this.unsupported(row, isConstructor ? `${owner} のこのコンストラクター` : `${owner}.${name} のこのオーバーロード`);
  }

  /**
   * Whether each argument converts to its parameter of a .NET overload that takes that many arguments, as far as the
   * library has the types.
   */
  private dotnetOverloadTakes({ takesMore, types }: DotnetOverload, args: ArgumentInfo[]): boolean {
    const fixedCount = takesMore ? types.length - 1 : types.length;
    return args.every((arg, index) => {
      if (index < fixedCount) return this.dotnetParameterTakes(types[index], arg);
      const array = types.at(-1) ?? '*';
      // A params array takes its elements, or the array itself as the only argument in its place.
      const element = array === '*' ? '*' : array.slice(0, -2);
      return (
        this.dotnetParameterTakes(element, arg) ||
        (args.length === types.length && this.dotnetParameterTakes(array, arg))
      );
    });
  }

  private dotnetParameterTakes(typeText: string, arg: ArgumentInfo): boolean {
    const { expression } = arg;
    if (typeText === '*' || expression.kind === 'unbound' || expression.type.kind === 'error') return true;
    const type = this.dotnetType(typeText);
    return type !== undefined && this.implicitConversionOf(expression, type) !== undefined;
  }

  /** The library's type of a .NET metadata name, such as `System.Int32[]`, or undefined when the library lacks it. */
  private dotnetType(typeText: string): Type | undefined {
    const array = /^(.*)\[(,*)\]$/.exec(typeText);
    if (array) {
      const element = this.dotnetType(array[1]);
      return element && arrayType(element, array[2].length + 1);
    }
    try {
      return this.library.typeNamed(typeText).declaredType;
    } catch {
      return undefined;
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Roslyn reports a different error for each way a call fails.
  // code-gauge-allow functionNcss -- Each branch handles one case of the C# rule that the function applies.
  private reportInapplicable(
    candidates: MethodCandidate[],
    args: ArgumentInfo[],
    explicitTypeArgs: Type[] | undefined,
    row: number,
    description: CallDescription
  ): void {
    if (explicitTypeArgs && this.reportTypeArgumentCount(candidates, explicitTypeArgs.length, row)) return;
    const byArity = candidates.filter(
      (candidate) =>
        this.mapArguments(candidate.method, args, false) !== undefined ||
        this.mapArguments(candidate.method, args, true) !== undefined
    );
    this.rejectUnavailableOverload(candidates, args, byArity.length, row);
    if (byArity.length === 0) {
      this.reportArityMismatch(candidates, args, row, description);
      return;
    }
    const candidate = byArity[0];
    const { method } = candidate;
    if (this.reportUninferable(candidate, args, explicitTypeArgs, row)) return;
    const expanded = this.reportedForm(candidate, args, explicitTypeArgs);
    const mapping = this.mapArguments(method, args, expanded);
    if (!mapping) return;
    const typeArgs =
      method.typeParameters.length === 0
        ? []
        : this.reportedTypeArguments(candidate, args, explicitTypeArgs, mapping.parameterOf, expanded);
    const substitution = this.callSubstitution(candidate, typeArgs);
    if (!this.staticReceiverFits(candidate, substitution)) {
      this.reportStaticReceiverMismatch(candidate, typeArgs, substitution, row);
      return;
    }
    // Roslyn reports each argument that does not fit, but only the receiver of an extension method that does not.
    let hasBadArgument = false;
    let isIntroduced = !description.isCollectionInitializerAdd;
    for (const [index, arg] of args.entries()) {
      const parameter = method.parameters[mapping.parameterOf[index]];
      const type = this.parameterType(method, mapping.parameterOf[index], expanded, substitution);
      const position = description.isExtension ? index : index + 1;
      if (this.reportRefKindMismatch(arg, parameter, position)) {
        hasBadArgument = true;
      } else if (!this.argumentFits(arg, type, parameter.refKind)) {
        if (description.isExtension && position === 0) {
          this.reportReceiverMismatch(candidate, arg, type, row, description, typeArgs);
          return;
        }
        // A lambda's own errors explain why it does not fit, which Roslyn does not introduce.
        if (!isIntroduced && (arg.expression.kind !== 'unbound' || arg.expression.methodGroup)) {
          this.error(
            row,
            'CS1950',
            `コレクション初期化子に最も適しているオーバーロード Add メソッド '${displayMethodIn(method, candidate.owner)}' には無効な引数がいくつか含まれています`
          );
          isIntroduced = true;
        }
        this.reportInconvertible(candidate, arg, position, type, row, description);
        hasBadArgument = true;
      }
    }
    if (hasBadArgument) return;
    for (const [index, typeArg] of typeArgs.entries()) {
      if (
        !this.satisfiesConstraints(
          typeArg,
          method.typeParameters[index],
          substitution,
          row,
          constraintOwner(method, index)
        )
      )
        return;
    }
  }

  /**
   * Whether Roslyn reports the arguments of a candidate against its expanded `params` form: when its normal form takes
   * no such arguments, or more of them do not fit it than the expanded one.
   */
  private reportedForm(
    candidate: MethodCandidate,
    args: ArgumentInfo[],
    explicitTypeArgs: Type[] | undefined
  ): boolean {
    const { method } = candidate;
    const normal = this.mapArguments(method, args, false);
    if (!normal) return true;
    const expanded = this.mapArguments(method, args, true);
    if (!expanded) return false;
    const badCount = (form: boolean, parameterOf: number[]): number => {
      const typeArgs =
        method.typeParameters.length === 0
          ? []
          : this.reportedTypeArguments(candidate, args, explicitTypeArgs, parameterOf, form);
      const substitution = this.callSubstitution(candidate, typeArgs);
      return args.filter((arg, index) => {
        const parameter = method.parameters[parameterOf[index]];
        const type = this.parameterType(method, parameterOf[index], form, substitution);
        return !this.argumentFits(arg, type, parameter.refKind);
      }).length;
    };
    return badCount(true, expanded.parameterOf) < badCount(false, normal.parameterOf);
  }

  /** The type arguments that an inapplicable generic candidate's arguments are checked against. */
  private reportedTypeArguments(
    candidate: MethodCandidate,
    args: ArgumentInfo[],
    explicitTypeArgs: Type[] | undefined,
    parameterOf: number[],
    expanded: boolean
  ): Type[] {
    return explicitTypeArgs ?? this.inferTypeArguments(candidate, args, parameterOf, expanded) ?? [];
  }

  /**
   * A tie between library methods that .NET's further overloads settle, such as `string.Join(",", objects)`: .NET picks
   * `Join(string, params object[])` over `Join<T>(string, IEnumerable<T>)` through its `ReadOnlySpan` overloads, which
   * this library does not declare. The single non-generic method among the tied ones stands in for that choice.
   */
  private libraryTieBreak(applicable: Applicable[], args: ArgumentInfo[]): Applicable | undefined {
    const tied = applicable.filter(
      (candidate) => !applicable.some((other) => other !== candidate && this.isBetter(other, candidate, args))
    );
    if (!tied.every((candidate) => candidate.candidate.method.owner.isLibrary)) return undefined;
    const nonGeneric = tied.filter((candidate) => candidate.candidate.method.typeParameters.length === 0);
    return nonGeneric.length === 1 ? nonGeneric[0] : undefined;
  }

  /** Reports a call that no candidate takes the number or the names of its arguments for. */
  private reportArityMismatch(
    candidates: MethodCandidate[],
    args: ArgumentInfo[],
    row: number,
    description: CallDescription
  ): void {
    const named = args.find(
      (arg) =>
        arg.name !== undefined &&
        candidates.length === 1 &&
        !candidates[0].method.parameters.some((parameter) => parameter.name === arg.name)
    );
    if (named && candidates.length === 1) {
      this.error(
        named.row,
        'CS1739',
        `'${description.name}' に最も適しているオーバーロードには '${named.name}' という名前のパラメーターがありません`
      );
      return;
    }
    if (candidates.length === 1 && args.length < candidates[0].method.parameters.length) {
      const method = candidates[0].method;
      const positional = args.filter((arg) => arg.name === undefined).length;
      const isGiven = (name: string, index: number): boolean =>
        index < positional || args.some((arg) => arg.name === name);
      const missing =
        method.parameters.find(
          (parameter, index) =>
            !isGiven(parameter.name, index) && parameter.defaultSyntax === undefined && !parameter.isParams
        ) ?? method.parameters[args.length];
      // Roslyn's Japanese message names the parameter first and the method second.
      this.error(
        row,
        'CS7036',
        `'${missing.name}' の必要なパラメーター '${displayMethodIn(method, candidates[0].owner)}' に対応する特定の引数がありません`
      );
      return;
    }
    const visibleCount = description.isExtension ? args.length - 1 : args.length;
    if (description.kind === 'constructor') {
      this.error(
        row,
        'CS1729',
        `'${description.typeName}' には、引数 ${visibleCount} を指定するコンストラクターは含まれていません`
      );
    } else if (description.kind === 'delegate') {
      this.error(row, 'CS1593', `デリゲート '${description.name}' には引数 ${visibleCount} を指定できません`);
    } else if (description.kind === 'indexer') {
      this.error(row, 'CS1501', `引数 ${visibleCount} を指定するメソッド 'this' のオーバーロードはありません`);
    } else {
      this.error(
        row,
        'CS1501',
        `引数 ${visibleCount} を指定するメソッド '${description.name}' のオーバーロードはありません`
      );
    }
  }

  private reportStaticReceiverMismatch(
    candidate: MethodCandidate,
    typeArgs: Type[],
    substitution: Map<TypeParameterSymbol, Type>,
    row: number
  ): void {
    const { method } = candidate;
    const receiver = displayType(candidate.staticReceiver as Type);
    const extended = displayType(substitute(method.staticExtensionOf as Type, substitution), true);
    this.error(
      row,
      'CS1929',
      `'${receiver}' に '${method.extensionProperty ?? method.name}' の定義が含まれておらず、最も適している拡張メソッド オーバーロード '${displayExtensionMember(method, typeArgs)}' には '${extended}' 型のレシーバーが必要です`
    );
  }

  /** Reports a generic candidate whose type arguments cannot be inferred, telling whether it did. */
  private reportUninferable(
    candidate: MethodCandidate,
    args: ArgumentInfo[],
    explicitTypeArgs: Type[] | undefined,
    row: number
  ): boolean {
    const { method } = candidate;
    if (method.typeParameters.length === 0 || explicitTypeArgs) return false;
    const mapping = this.mapArguments(method, args, false) ?? this.mapArguments(method, args, true);
    if (
      !mapping ||
      this.inferTypeArguments(candidate, args, mapping.parameterOf, !this.mapArguments(method, args, false))
    )
      return false;
    if (candidate.staticReceiver && method.extensionProperty) {
      // An extension property takes no type arguments, so Roslyn finds none that the type can access.
      const receiver = displayType(candidate.staticReceiver);
      this.error(
        row,
        'CS1061',
        `'${receiver}' に '${method.extensionProperty}' の定義が含まれておらず、型 '${receiver}' の最初の引数を受け付けるアクセス可能な拡張メソッド '${method.extensionProperty}' が見つかりませんでした。using ディレクティブまたはアセンブリ参照が不足していないことを確認してください`
      );
      return true;
    }
    const shown = method.isExtensionBlockMember
      ? displayExtensionMember(method)
      : displayMethodIn(method, candidate.owner);
    this.error(
      row,
      'CS0411',
      `メソッド '${shown}' の型引数を使い方から推論することはできません。型引数を明示的に指定してください。`
    );
    return true;
  }

  /** Reports an argument passed with `ref` or `out` unlike its parameter, telling whether it did. */
  private reportRefKindMismatch(
    arg: ArgumentInfo,
    parameter: MethodSymbol['parameters'][number],
    position: number
  ): boolean {
    if (
      arg.isReceiver ||
      parameter.refKind === arg.refKind ||
      (parameter.refKind === 'in' && arg.refKind === 'ref') ||
      (parameter.refKind !== 'ref' && parameter.refKind !== 'out' && arg.refKind !== 'ref' && arg.refKind !== 'out')
    )
      return false;
    if (parameter.refKind === undefined)
      this.error(arg.row, 'CS1615', `引数 ${position} はキーワード '${arg.refKind}' と共に渡すことはできません`);
    else this.error(arg.row, 'CS1620', `引数 ${position} はキーワード '${parameter.refKind}' と共に渡す必要があります`);
    return true;
  }

  /** The two methods of the last ambiguous call, as the runtime binder's message names them. */
  protected lastAmbiguity: string[] | undefined;

  /** The runtime binder's message for the last call whose argument did not convert, which names its method or delegate. */
  protected lastInconvertibleCall: string | undefined;

  protected abstract rejectUnknownLibraryMember(type: Type, name: string, position: number): void;

  /** The element type of a collection expression that creates a type, or undefined for a type it cannot create. */
  protected abstract collectionElementType(target: Type): Type | undefined;

  /**
   * The elements of a collection expression bound without a target type, a spread as a value of its elements' type,
   * leaving out those without a type of their own.
   */
  protected abstract collectionElementValues(
    expression: Extract<BoundExpression, { kind: 'unbound' }>
  ): BoundExpression[];

  /** Reports the receiver of an extension method that does not convert to the type that the method extends. */
  private reportReceiverMismatch(
    candidate: MethodCandidate,
    arg: ArgumentInfo,
    type: Type,
    row: number,
    description: CallDescription,
    typeArgs: Type[]
  ): void {
    // An extension method of .NET's that the library lacks, such as a span's, is unavailable rather than a mismatch.
    this.rejectUnknownLibraryMember(arg.expression.type, description.name, row);
    const { method } = candidate;
    const shown = method.isExtensionBlockMember
      ? displayExtensionMember(method, typeArgs)
      : displayMethodIn(method, candidate.owner);
    this.error(
      row,
      'CS1929',
      `'${displayType(arg.expression.type)}' に '${method.extensionProperty ?? description.name}' の定義が含まれておらず、最も適している拡張メソッド オーバーロード '${shown}' には '${displayType(type, method.isExtensionBlockMember)}' 型のレシーバーが必要です`
    );
  }

  /** Reports an argument that does not convert to its parameter's type. */
  private reportInconvertible(
    candidate: MethodCandidate,
    arg: ArgumentInfo,
    position: number,
    type: Type,
    row: number,
    description: CallDescription
  ): void {
    if (arg.expression.kind === 'unbound' && arg.expression.methodGroup) {
      // A method of the delegate's parameters but another return type is CS0407, as when assigning the group.
      const expression = arg.expression;
      const saved = this.diagnostics.length;
      const reported = this.quietly(() => {
        this.convert(expression, type, arg.row);
        return this.diagnostics.slice(saved);
      });
      if (reported?.length === 1 && reported[0].message.startsWith('CS0407:')) {
        this.diagnostics.push(reported[0]);
        return;
      }
      this.error(
        arg.row,
        'CS1503',
        `引数 ${position}: は 'メソッド グループ' から '${displayType(type, true, true)}' へ変換することはできません`
      );
    } else if (arg.expression.kind === 'unbound') {
      // Converting reports why the lambda does not fit, as Roslyn reports the body's errors.
      this.convert(arg.expression, type, arg.row);
    } else {
      this.lastInconvertibleCall =
        description.kind === 'delegate'
          ? `Delegate '${displayType(candidate.owner, true).replaceAll(', ', ',')}' has some invalid arguments`
          : `The best overloaded method match for '${displayMethodIn(candidate.method, candidate.owner)}' has some invalid arguments`;
      this.error(
        arg.row,
        'CS1503',
        `引数 ${position}: は '${displayType(arg.expression.type, true)}' から '${displayType(type, true, true)}' へ変換することはできません`
      );
    }
  }
}

function currentSubstitution(inference: Inference): Map<TypeParameterSymbol, Type> {
  return new Map([...inference.ownerSubstitution, ...inference.fixed]);
}

/** Arguments in parameter order, marked with the order the source writes them in when named arguments reorder them. */
function withSourceOrder(args: BoundArgument[], parameterOf: number[]): BoundArguments {
  const sourceOrder = [...new Set(parameterOf)];
  const isReordered = sourceOrder.some((parameterIndex, index) => index > 0 && parameterIndex < sourceOrder[index - 1]);
  return isReordered ? Object.assign(args, { sourceOrder }) : args;
}

/**
 * Whether a type is unmanaged (C# spec §8.8): a non-nullable value type whose fields, at every level, are value types,
 * as the `unmanaged` constraint requires.
 */
export function isUnmanagedType(type: Type, seen = new Set<TypeSymbol>()): boolean {
  if (type.kind === 'typeParameter') return type.symbol.hasUnmanagedConstraint;
  if (type.kind !== 'named' || !type.symbol.isValueType || nullableUnderlying(type)) return false;
  if (type.symbol.kind === 'enum' || type.symbol.special !== undefined) return type.symbol.special !== 'nullable';
  if (seen.has(type.symbol)) return true;
  seen.add(type.symbol);
  const substitution = substitutionOf(type);
  return type.symbol.fields
    .filter((field) => !field.isStatic && !field.isConst)
    .every((field) => isUnmanagedType(substitute(field.type, substitution), seen));
}

/** The name of the generic method or extension block whose type parameter a type argument breaks a constraint of. */
function constraintOwner(method: MethodSymbol, typeParameterIndex: number): string {
  return method.isExtensionBlockMember && typeParameterIndex < method.extensionBlockArity
    ? displayExtensionBlock(method)
    : displayMethod(method);
}

/**
 * The applicable candidates without those that another candidate of the same declaring type outranks by its
 * `[OverloadResolutionPriority]`, as Roslyn removes them before it compares conversions.
 */
function withHighestPriority(applicable: Applicable[]): Applicable[] {
  const highest = new Map<TypeSymbol, number>();
  for (const { candidate } of applicable) {
    const original = originalDefinition(candidate.method);
    highest.set(original.owner, Math.max(highest.get(original.owner) ?? -Infinity, overloadPriorityOf(original)));
  }
  return applicable.filter(({ candidate }) => {
    const original = originalDefinition(candidate.method);
    return overloadPriorityOf(original) === highest.get(original.owner);
  });
}

/** The method an override overrides at the root, whose declaration gives its priority and its declaring type. */
function originalDefinition(method: MethodSymbol): MethodSymbol {
  let original = method;
  while (original.overridden) original = original.overridden;
  return original;
}

function overloadPriorityOf(method: MethodSymbol): number {
  if (!method.property) return method.overloadPriority;
  let property = method.property;
  while (property.overridden) property = property.overridden;
  return property.overloadPriority;
}

/** The element type of a span, which a collection expression creates over an array of its elements. */
function collectionExpressionElement(type: Type): Type | undefined {
  if (type.kind !== 'named') return undefined;
  const name = type.symbol.fullName;
  return name === 'System.ReadOnlySpan`1' || name === 'System.Span`1' ? type.args[0] : undefined;
}

const ARRAY_INTERFACES = new Set([
  'System.Collections.Generic.IEnumerable`1',
  'System.Collections.Generic.IReadOnlyCollection`1',
  'System.Collections.Generic.IReadOnlyList`1',
  'System.Collections.Generic.ICollection`1',
  'System.Collections.Generic.IList`1',
]);

function spanName(type: Type): string | undefined {
  return collectionExpressionElement(type) && type.kind === 'named' ? type.symbol.fullName : undefined;
}

/**
 * Whether a collection expression converts better to the first of two collection types of the same element type:
 * a `ReadOnlySpan<T>` over a `Span<T>`, a span over an array or an interface that one implements, and otherwise a
 * type that converts implicitly to the other.
 */
function isBetterCollectionType(a: Type, b: Type, converts: (from: Type, to: Type) => boolean): boolean {
  const aSpan = spanName(a);
  const bSpan = spanName(b);
  if (aSpan === 'System.ReadOnlySpan`1' && bSpan === 'System.Span`1') return true;
  if (aSpan) return b.kind === 'array' || (b.kind === 'named' && !bSpan && ARRAY_INTERFACES.has(b.symbol.fullName));
  return !bSpan && converts(a, b);
}

/** A handler conversion is better than any other for an interpolated string that is not constant (C# 10). */
function compareHandlerConversions(expression: BoundExpression, a: Type, b: Type): number | undefined {
  if (expression.kind !== 'interpolated') return undefined;
  const aIsHandler = interpolationTargetOf(a) === 'handler';
  if (aIsHandler === (interpolationTargetOf(b) === 'handler')) return undefined;
  return aIsHandler ? 1 : -1;
}

/** A conversion to the argument's own type is better than one to another type. */
function compareExactConversions(arg: ArgumentInfo, a: Type, b: Type): number | undefined {
  if (arg.isOutVar) return undefined;
  const aExact = sameType(arg.expression.type, a);
  const bExact = sameType(arg.expression.type, b);
  if (aExact === bExact) return undefined;
  return aExact ? 1 : -1;
}
