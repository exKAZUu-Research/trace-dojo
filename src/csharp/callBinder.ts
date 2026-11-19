import type { BoundArgument, BoundExpression, BoundLValue } from './bound';
import type { ConversionKind } from './conversions';
import { displayMethodIn } from './declarations';
import type { MethodCandidate } from './lookup';
import { OperatorBinder } from './operatorBinder';
import {
  allInterfacesOf,
  baseTypeOf,
  displayMethod,
  displayType,
  ERROR_TYPE,
  isReferenceType,
  type MethodSymbol,
  type NamedType,
  nullableUnderlying,
  sameType,
  specialOf,
  substitute,
  substitutionOf,
  type Type,
  type TypeParameterSymbol,
} from './types';

/** An argument as written, bound to its natural type or left unbound until its parameter's type is known. */
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
}

interface Bounds {
  exact: Type[];
  lower: Type[];
  upper: Type[];
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

  /** Resolves a call among candidates, reporting Roslyn's error when none applies or several tie. */
  resolveCall(
    candidates: MethodCandidate[],
    args: ArgumentInfo[],
    explicitTypeArgs: Type[] | undefined,
    row: number,
    description: CallDescription
  ): ResolvedCall | undefined {
    const applicable: Applicable[] = [];
    for (const candidate of candidates) {
      const result = this.applicability(candidate, args, explicitTypeArgs);
      if (result) applicable.push(result);
    }
    if (applicable.length === 0) {
      this.reportInapplicable(candidates, args, explicitTypeArgs, row, description);
      return undefined;
    }
    const best = this.bestOf(applicable, args);
    if (!best) {
      // An argument whose binding already failed fits every overload, which Roslyn does not report again.
      if (args.some((arg) => arg.expression.type.kind === 'error')) return undefined;
      const [first, second] = this.tiedCandidates(applicable, args);
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
    return displayMethodIn(applicable.candidate.method, applicable.candidate.owner);
  }

  /** The two candidates to name in an ambiguity error: the first two that no other candidate beats. */
  private tiedCandidates(applicable: Applicable[], args: ArgumentInfo[]): [Applicable, Applicable] {
    const undominated = applicable.filter(
      (candidate) => !applicable.some((other) => other !== candidate && this.isBetter(other, candidate, args))
    );
    const list = undominated.length >= 2 ? undominated : applicable;
    return [list[0], list[1]];
  }

  /** Maps arguments to a candidate's parameters, infers its type arguments, and checks the arguments convert. */
  private applicability(
    candidate: MethodCandidate,
    args: ArgumentInfo[],
    explicitTypeArgs: Type[] | undefined
  ): Applicable | undefined {
    const { method } = candidate;
    for (const form of [false, true]) {
      if (form && !method.parameters.at(-1)?.isParams) break;
      const mapping = this.mapArguments(method, args, form);
      if (!mapping) continue;
      let typeArgs: Type[];
      if (method.typeParameters.length > 0) {
        if (explicitTypeArgs) {
          if (explicitTypeArgs.length !== method.typeParameters.length) return undefined;
          typeArgs = explicitTypeArgs;
        } else {
          const inferred = this.inferTypeArguments(candidate, args, mapping.parameterOf, form);
          if (!inferred) return undefined;
          typeArgs = inferred;
        }
      } else {
        if (explicitTypeArgs && explicitTypeArgs.length > 0) return undefined;
        typeArgs = [];
      }
      const substitution = this.callSubstitution(candidate, typeArgs);
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
    if (expanded && parameter.isParams && type.kind === 'array') return type.element;
    return type;
  }

  private mapArguments(
    method: MethodSymbol,
    args: ArgumentInfo[],
    expanded: boolean
  ): { parameterOf: number[]; defaultsUsed: number } | undefined {
    const parameters = method.parameters;
    const parameterOf: number[] = [];
    const filled = new Set<number>();
    const paramsIndex = expanded ? parameters.length - 1 : -1;
    for (const [index, arg] of args.entries()) {
      if (arg.name !== undefined) {
        const target = parameters.findIndex((parameter) => parameter.name === arg.name);
        if (target === -1 || (filled.has(target) && target !== paramsIndex)) return undefined;
        parameterOf.push(target);
        filled.add(target);
        continue;
      }
      if (
        args
          .slice(0, index)
          .some((other) => other.name !== undefined && parameterOf[args.indexOf(other)] !== args.indexOf(other))
      )
        return undefined;
      const target = index < parameters.length ? index : paramsIndex;
      if (target < 0 || target >= parameters.length) return undefined;
      if (expanded && target > paramsIndex) return undefined;
      if (!expanded && index >= parameters.length) return undefined;
      parameterOf.push(expanded && index >= paramsIndex ? paramsIndex : target);
      filled.add(expanded && index >= paramsIndex ? paramsIndex : target);
    }
    let defaultsUsed = 0;
    for (const [index, parameter] of parameters.entries()) {
      if (filled.has(index) || index === paramsIndex) continue;
      if (parameter.isParams && !expanded) return undefined;
      if (parameter.defaultSyntax === undefined && parameter.defaultValue === undefined) return undefined;
      defaultsUsed++;
    }
    if (expanded && !filled.has(paramsIndex) && args.length < parameters.length - 1) return undefined;
    return { parameterOf, defaultsUsed };
  }

  private argumentFits(arg: ArgumentInfo, type: Type, refKind: 'ref' | 'out' | 'in' | undefined): boolean {
    if (refKind === 'ref' || refKind === 'out') {
      if (arg.refKind !== refKind) return false;
      if (arg.isOutVar) return true;
      return sameType(arg.expression.type, type) || arg.expression.type.kind === 'error';
    }
    if (arg.refKind === 'ref' || arg.refKind === 'out') return false;
    return this.implicitConversionOf(arg.expression, type) !== undefined;
  }

  // code-gauge-allow functionNcss 60 -- Each step of C#'s two-phase type inference.
  /** Infers a generic method's type arguments from its arguments in C#'s two phases. */
  protected inferTypeArguments(
    candidate: MethodCandidate,
    args: ArgumentInfo[],
    parameterOf: number[],
    expanded: boolean
  ): Type[] | undefined {
    const { method } = candidate;
    const parameters = method.typeParameters;
    const bounds = new Map<TypeParameterSymbol, Bounds>(
      parameters.map((parameter) => [parameter, { exact: [], lower: [], upper: [] }])
    );
    const fixed = new Map<TypeParameterSymbol, Type>();
    const ownerSubstitution = substitutionOf(candidate.owner);
    const formals = args.map((_arg, index) => {
      const parameter = method.parameters[parameterOf[index]];
      const type = substitute(parameter.type, ownerSubstitution);
      return expanded && parameter.isParams && type.kind === 'array' ? type.element : type;
    });
    const pending = new Set<number>();
    for (const [index, arg] of args.entries()) {
      const formal = formals[index];
      if (arg.expression.kind === 'unbound') {
        pending.add(index);
        const explicit = this.lambdaParameterTypes(arg.expression);
        const invoke = this.delegateInvokeOf(formal);
        if (explicit && invoke) {
          for (const [position, parameterType] of invoke.parameterTypes.entries()) {
            if (explicit[position]) this.exactInference(explicit[position], parameterType, bounds);
          }
        }
        continue;
      }
      if (arg.isOutVar || arg.expression.type.kind === 'null') continue;
      const refKind = method.parameters[parameterOf[index]].refKind;
      if (refKind === 'ref' || refKind === 'out') this.exactInference(arg.expression.type, formal, bounds);
      else this.lowerBoundInference(arg.expression.type, formal, bounds);
    }
    const currentSubstitution = (): Map<TypeParameterSymbol, Type> => new Map([...ownerSubstitution, ...fixed]);
    for (let round = 0; round <= parameters.length + args.length; round++) {
      // Output type inference for lambdas whose parameter types are now known.
      for (const index of pending) {
        const invoke = this.delegateInvokeOf(formals[index]);
        if (!invoke) {
          pending.delete(index);
          continue;
        }
        const substitution = currentSubstitution();
        const inputs = invoke.parameterTypes.map((type) => substitute(type, substitution));
        if (inputs.some((type) => this.mentionsUnfixed(type, parameters, fixed))) continue;
        pending.delete(index);
        const returnType = this.inferReturnType(
          args[index].expression as Extract<BoundExpression, { kind: 'unbound' }>,
          inputs
        );
        if (returnType && returnType.kind !== 'void')
          this.lowerBoundInference(returnType, substitute(invoke.returnType, substitution), bounds);
      }
      const unfixed = parameters.filter((parameter) => !fixed.has(parameter));
      if (unfixed.length === 0) break;
      const dependsOnPending = (parameter: TypeParameterSymbol): boolean =>
        [...pending].some((index) => {
          const invoke = this.delegateInvokeOf(formals[index]);
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
        if (!chosen) return undefined;
        fixed.set(parameter, chosen);
        progress = true;
      }
      if (!progress && pending.size === 0) break;
      // Lambdas whose inputs still mention unfixed parameters cannot contribute; inference fails.
      if (
        !progress &&
        [...pending].every((index) => {
          const invoke = this.delegateInvokeOf(formals[index]);
          const substitution = currentSubstitution();
          return (
            invoke?.parameterTypes.some((type) =>
              this.mentionsUnfixed(substitute(type, substitution), parameters, fixed)
            ) === true
          );
        })
      )
        break;
    }
    if (parameters.some((parameter) => !fixed.has(parameter))) return undefined;
    return parameters.map((parameter) => fixed.get(parameter) as Type);
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
      return bounds.exact.every((type) => sameType(type, first)) ? first : undefined;
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

  // code-gauge-allow functionNcss 40 -- The tie-breaking rules of C#'s better function member.
  /** Whether a candidate is a better function member than another for the arguments. */
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
    if (!a.isExpanded && b.isExpanded) return true;
    if (a.isExpanded && !b.isExpanded) return false;
    if (a.defaultsUsed < b.defaultsUsed) return true;
    if (a.defaultsUsed > b.defaultsUsed) return false;
    const aSpecific = this.moreSpecific(a, b);
    return aSpecific === 1;
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
    if (expression.kind !== 'unbound' && !arg.isOutVar) {
      const aExact = sameType(expression.type, a);
      const bExact = sameType(expression.type, b);
      if (aExact && !bExact) return 1;
      if (bExact && !aExact) return -1;
    }
    if (expression.kind === 'unbound') {
      const aInvoke = this.delegateInvokeOf(a);
      const bInvoke = this.delegateInvokeOf(b);
      if (
        aInvoke &&
        bInvoke &&
        aInvoke.parameterTypes.length === bInvoke.parameterTypes.length &&
        aInvoke.parameterTypes.every((type, index) => sameType(type, bInvoke.parameterTypes[index]))
      ) {
        const inferred = this.inferReturnType(expression, aInvoke.parameterTypes);
        if (
          aInvoke.returnType.kind !== 'void' &&
          bInvoke.returnType.kind === 'void' &&
          inferred &&
          inferred.kind !== 'void'
        )
          return 1;
        if (
          bInvoke.returnType.kind !== 'void' &&
          aInvoke.returnType.kind === 'void' &&
          inferred &&
          inferred.kind !== 'void'
        )
          return -1;
        if (inferred) {
          if (sameType(inferred, aInvoke.returnType) && !sameType(inferred, bInvoke.returnType)) return 1;
          if (sameType(inferred, bInvoke.returnType) && !sameType(inferred, aInvoke.returnType)) return -1;
          return this.betterTarget(aInvoke.returnType, bInvoke.returnType);
        }
      }
    }
    return this.betterTarget(a, b);
  }

  /** Whether one type is a better conversion target than another: 1 for the first, -1 for the second. */
  protected betterTarget(a: Type, b: Type): number {
    const aToB = this.conversions.implicit(a, b) !== undefined;
    const bToA = this.conversions.implicit(b, a) !== undefined;
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
          displayMethod(method)
        )
      )
        return false;
    }
    return true;
  }

  /** Checks a type argument against its parameter's constraints, reporting the first it breaks. */
  satisfiesConstraints(
    arg: Type,
    parameter: TypeParameterSymbol,
    substitution: Map<TypeParameterSymbol, Type>,
    row: number,
    owner: string
  ): boolean {
    if (arg.kind === 'error') return true;
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
            ? `'${displayType(arg)}' から '${displayType(target)}' へのボックス変換がありません。`
            : `'${displayType(arg)}' から '${displayType(target)}' への暗黙的な参照変換がありません。`;
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

  /** Converts the arguments to their parameters' types and orders them as the parameters, filling defaults and packing `params`. */
  private finishArguments(applicable: Applicable, args: ArgumentInfo[], row: number): BoundArgument[] {
    const { method } = applicable.candidate;
    const substitution = this.callSubstitution(applicable.candidate, applicable.typeArgs);
    const result: (BoundArgument | undefined)[] = Array.from({ length: method.parameters.length });
    const paramsElements: BoundExpression[] = [];
    for (const [index, arg] of args.entries()) {
      const parameterIndex = applicable.parameterOf[index];
      const parameter = method.parameters[parameterIndex];
      const type = applicable.argumentTypes[index];
      if (parameter.refKind === 'ref' || parameter.refKind === 'out') {
        const target =
          arg.isOutVar && arg.declareOut
            ? arg.declareOut(type)
            : arg.declareOut
              ? arg.declareOut(type)
              : (arg.target as BoundLValue);
        result[parameterIndex] = { kind: 'refArgument', target, refKind: parameter.refKind, type, row: arg.row };
        continue;
      }
      const converted = this.convert(arg.expression, type, arg.row);
      if (applicable.isExpanded && parameterIndex === method.parameters.length - 1) paramsElements.push(converted);
      else result[parameterIndex] = converted;
    }
    if (applicable.isExpanded) {
      const arrayType = substitute(method.parameters.at(-1)?.type ?? ERROR_TYPE, substitution);
      if (arrayType.kind === 'array') {
        result[method.parameters.length - 1] = {
          kind: 'newArray',
          arrayType,
          sizes: [this.constant(paramsElements.length, this.intType, row)],
          elements: paramsElements,
          type: arrayType,
          row,
        };
      }
    }
    for (const [index, parameter] of method.parameters.entries()) {
      if (result[index] !== undefined) continue;
      const type = substitute(parameter.type, substitution);
      result[index] = this.defaultArgument(parameter, type, row);
    }
    return result as BoundArgument[];
  }

  /** The value of an omitted optional argument. */
  protected abstract defaultArgument(
    parameter: MethodSymbol['parameters'][number],
    type: Type,
    row: number
  ): BoundExpression;

  // code-gauge-allow functionNcss 50 -- Roslyn reports a different error for each way a call fails.
  private reportInapplicable(
    candidates: MethodCandidate[],
    args: ArgumentInfo[],
    explicitTypeArgs: Type[] | undefined,
    row: number,
    description: CallDescription
  ): void {
    const visibleCount = description.isExtension ? args.length - 1 : args.length;
    const byArity = candidates.filter(
      (candidate) =>
        this.mapArguments(candidate.method, args, false) !== undefined ||
        (candidate.method.parameters.at(-1)?.isParams && this.mapArguments(candidate.method, args, true))
    );
    if (byArity.length === 0) {
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
        const missing =
          method.parameters.find(
            (parameter, index) => index >= args.length && parameter.defaultSyntax === undefined && !parameter.isParams
          ) ?? method.parameters[args.length];
        this.error(
          row,
          'CS7036',
          `'${displayMethodIn(method, candidates[0].owner)}' の必要なパラメーター '${missing.name}' に対応する特定の引数がありません`
        );
        return;
      }
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
      return;
    }
    const candidate = byArity[0];
    const { method } = candidate;
    if (method.typeParameters.length > 0 && !explicitTypeArgs) {
      const mapping = this.mapArguments(method, args, false) ?? this.mapArguments(method, args, true);
      if (
        mapping &&
        !this.inferTypeArguments(candidate, args, mapping.parameterOf, !this.mapArguments(method, args, false))
      ) {
        this.error(
          row,
          'CS0411',
          `メソッド '${displayMethodIn(method, candidate.owner)}' の型引数を使い方から推論することはできません。型引数を明示的に指定してください。`
        );
        return;
      }
    }
    const expanded = !this.mapArguments(method, args, false);
    const mapping = this.mapArguments(method, args, expanded);
    if (!mapping) return;
    const typeArgs =
      method.typeParameters.length > 0
        ? (explicitTypeArgs ?? this.inferTypeArguments(candidate, args, mapping.parameterOf, expanded) ?? [])
        : [];
    const substitution = this.callSubstitution(candidate, typeArgs);
    for (const [index, arg] of args.entries()) {
      const parameter = method.parameters[mapping.parameterOf[index]];
      const type = this.parameterType(method, mapping.parameterOf[index], expanded, substitution);
      const position = description.isExtension ? index : index + 1;
      if (
        parameter.refKind !== arg.refKind &&
        (parameter.refKind === 'ref' || parameter.refKind === 'out' || arg.refKind === 'ref' || arg.refKind === 'out')
      ) {
        if (arg.refKind === undefined)
          this.error(
            arg.row,
            'CS1620',
            `引数 ${position} はキーワード '${parameter.refKind}' と共に渡す必要があります`
          );
        else if (parameter.refKind === undefined)
          this.error(arg.row, 'CS1615', `引数 ${position} はキーワード '${arg.refKind}' と共に渡すことはできません`);
        else
          this.error(
            arg.row,
            'CS1620',
            `引数 ${position} はキーワード '${parameter.refKind}' と共に渡す必要があります`
          );
        return;
      }
      if (!this.argumentFits(arg, type, parameter.refKind)) {
        if (arg.expression.kind === 'unbound') {
          // Converting reports why the lambda or method group does not fit, as Roslyn reports the body's errors.
          this.convert(arg.expression, type, arg.row);
          return;
        }
        if (description.isExtension && index === 0) {
          this.error(
            row,
            'CS1929',
            `'${displayType(arg.expression.type)}' に '${description.name}' の定義が含まれておらず、最も適している拡張メソッド オーバーロード '${displayMethodIn(method, candidate.owner)}' には '${displayType(type)}' 型のレシーバーが必要です`
          );
          return;
        }
        const conversion: ConversionKind | undefined = this.conversions.explicit(arg.expression.type, type);
        void conversion;
        this.error(
          arg.row,
          'CS1503',
          `引数 ${position}: は '${displayType(arg.expression.type)}' から '${displayType(type)}' へ変換することはできません`
        );
        return;
      }
    }
    for (const [index, typeArg] of typeArgs.entries()) {
      if (!this.satisfiesConstraints(typeArg, method.typeParameters[index], substitution, row, displayMethod(method)))
        return;
    }
  }
}
