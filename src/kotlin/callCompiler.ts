// code-gauge-allow-file fileNcss 508 -- the compiler of one area of Kotlin, whose parts call each other closely.
import { type ArgumentEvaluation, argumentEvaluator, expectedArgumentType, firstAttempts } from './argumentTypes';
import type { Expression, LambdaExpression } from './ast';
import {
  type Compiled,
  type Eval,
  FunctionContext,
  nullableReceiverMessage,
  reprOf,
  type Scope,
  typeMismatchMessage,
} from './compilerBase';
import { CompilerCore } from './compilerCore';
import { callFunction, parameterReprs, receiverRepr, returnRepr } from './dispatch';
import { literalFits } from './literals';
import type { Frame } from './runtime';
import type { ClassSymbol, FunctionSymbol, ParameterSymbol, PropertySymbol, TypeParameterSymbol } from './symbols';
import {
  asSuper,
  checkVariableBounds,
  constrainThroughBounds,
  determinedType,
  fixVariable,
  hasIntersectionSupertype,
  isSameType,
  isSubtype,
  soleLowerBound,
} from './typeRelations';
import {
  type FunctionType,
  hasOpenVariables,
  type InferenceVariable,
  isNullable,
  type KType,
  mentionsVariable,
  nonNull,
  nullable,
  resolved,
  substitute,
  type Substitution,
  type TypeArgument,
  typeToString,
} from './types';
import { KObject, type Value } from './values';

/** An argument as written at a call: positional or named, possibly the trailing lambda. */
export interface ArgumentSyntax {
  row: number;
  name: string | undefined;
  value: Expression;
  /** Whether the argument is `*array`, which passes the array's elements to a `vararg` parameter. */
  isSpread?: boolean;
}

export interface DelegateContext {
  type: KType;
  isVar: boolean;
}

/** A function a call may mean, with the receiver it would be called on. */
export interface Candidate {
  symbol: FunctionSymbol;
  kind: 'member' | 'extension' | 'function' | 'constructor';
  /** The type arguments that the receiver's type gives the member's class. */
  substitution: Substitution;
  /** The receiver's static type, for a member or an extension. */
  receiverType: KType | undefined;
}

/** A call whose function and type arguments are decided. */
export interface ResolvedCall {
  symbol: FunctionSymbol;
  candidate: Candidate;
  type: KType;
  repr: ReturnType<typeof reprOf>;
  /** Evaluates the arguments in the order they are written and calls the function on the receiver. */
  call: (frame: Frame, receiver: Value) => Value;
  /** Evaluates the arguments in the order they are written, as the function's parameters receive them. */
  evaluateArgs: (frame: Frame) => Value[];
  callRow: number | undefined;
  receiverRepr: ReturnType<typeof reprOf>;
  /** The substitution of the function's type parameters, for reified ones. */
  typeArguments: Map<TypeParameterSymbol, KType>;
  /** Whether every argument creates an object, which makes `arrayOf(A(), B())` a creation, as Java's `{ new A(), new B() }` is. */
  argumentsCreateObjects: boolean;
  usesDefaultArguments: boolean;
  /** The compiled arguments in the order they are written, whose smart casts the library's contracts carry on. */
  compiledArgs: (Compiled | undefined)[];
}

interface Attempt {
  candidate: Candidate;
  variables: InferenceVariable[];
  substitution: Map<TypeParameterSymbol, KType>;
  /** The arguments of each parameter, by their indexes among the call's arguments. */
  mapping: number[][];
}

/** The parameters each argument goes to, or `undefined` when the arguments do not fit the parameters. */
// code-gauge-allow functionNcss 34 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
// code-gauge-allow functionCognitiveComplexity 22 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
function mapArguments(
  params: ParameterSymbol[],
  args: ArgumentSyntax[],
  hasTrailingLambda: boolean
): number[][] | undefined {
  const mapping: number[][] = params.map(() => []);
  const assigned = new Set<number>();
  let position = 0;
  let sawNamed = false;
  const positionalCount = hasTrailingLambda ? args.length - 1 : args.length;
  for (let index = 0; index < positionalCount; index++) {
    const argument = args[index];
    if (argument.name !== undefined) {
      const target = params.findIndex((param) => param.name === argument.name);
      if (target === -1 || assigned.has(target)) return undefined;
      assigned.add(target);
      mapping[target].push(index);
      sawNamed = true;
      continue;
    }
    if (sawNamed) return undefined;
    if (position >= params.length) return undefined;
    mapping[position].push(index);
    assigned.add(position);
    if (!params[position].isVararg) position++;
  }
  if (hasTrailingLambda) {
    const last = params.length - 1;
    if (last < 0 || assigned.has(last) || params[last].isVararg) return undefined;
    mapping[last].push(args.length - 1);
    assigned.add(last);
  }
  for (const [index, param] of params.entries()) {
    if (!assigned.has(index) && !param.hasDefault && !param.isVararg) return undefined;
  }
  return mapping;
}

function isLambdaArgument(expression: Expression): expression is LambdaExpression {
  return expression.kind === 'lambda';
}

/** Resolves calls: picks among overloads, infers type arguments, and evaluates arguments. */
export abstract class CallCompiler extends CompilerCore {
  protected readonly delegateCalls = new WeakMap<ArgumentSyntax[], DelegateContext>();

  abstract compileExpression(
    scope: Scope,
    context: FunctionContext,
    expression: Expression,
    expected?: KType
  ): Compiled;

  abstract compileLambda(
    scope: Scope,
    context: FunctionContext,
    lambda: LambdaExpression,
    expected: FunctionType | undefined,
    isInline: boolean
  ): Compiled;

  /** Converts a value to a type the checker accepted it for, including integer literals of other widths. */
  abstract convertTo(compiled: Compiled, type: KType, row: number): Eval;

  /** Whether an argument's value may be passed where `type` is expected, counting integer literals' other types. */
  protected acceptsArgument(compiled: Compiled, type: KType): boolean {
    if (compiled.integerLiteral) {
      // A variable that the receiver already determines, as `T` of `plusAssign` on a `MutableList<Long>`, takes the
      // literal as the type it requires; one that other arguments give a type, as `T` of `listOf(1, 2L)`, takes it as
      // that type.
      const target = determinedType(resolved(type)) ?? soleLowerBound(resolved(type)) ?? resolved(type);
      if (target.kind === 'class' && literalFits(compiled.integerLiteral, target.cls.name))
        return isSubtype(target, type);
    }
    return isSubtype(compiled.type, type);
  }

  /**
   * Resolves a call among candidate levels, the nearest first: the first level with an applicable candidate decides,
   * as Kotlin's resolution goes from inner scopes to outer ones.
   */
  // code-gauge-allow functionParameterCount 10 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  protected resolveCall(
    scope: Scope,
    context: FunctionContext,
    levels: Candidate[][],
    args: ArgumentSyntax[],
    hasTrailingLambda: boolean,
    explicitTypeArgs: KType[],
    expected: KType | undefined,
    receiver: Compiled | ((candidate: Candidate) => Compiled | undefined) | undefined,
    row: number,
    name: string
  ): ResolvedCall {
    const receiverOf = (candidate: Candidate): Compiled | undefined =>
      typeof receiver === 'function' ? receiver(candidate) : receiver;
    const all = levels.flat();
    if (all.length === 0) this.error(row, `${name} が見つかりません。`);
    const call: CallSyntax = { args, hasTrailingLambda, explicitTypeArgs, row, name };
    // A lone candidate gives its parameter types to the arguments, which literals and nested generic calls need.
    const lone = all.length === 1 ? all[0] : undefined;
    const loneAttempt = lone ? this.startLoneAttempt(lone, call, receiverOf(lone), expected) : undefined;
    // The candidates of the first level that take the arguments, or the lone one, give an argument the type they agree
    // on, as members come before extensions.
    const attempts = loneAttempt
      ? [loneAttempt]
      : firstAttempts(levels, (candidate) => this.startAttempt(candidate, args, hasTrailingLambda, explicitTypeArgs));
    if (!loneAttempt) for (const attempt of attempts) this.constrainByKnownExpected(attempt, expected, row);
    const compiledArgs = this.compileArguments(scope, context, args, attempts, !lone);
    const chosen = this.chooseAttempt(scope, context, levels, call, compiledArgs, loneAttempt, receiverOf);
    if (!chosen)
      return this.reportInapplicable(
        all,
        args,
        compiledArgs,
        hasTrailingLambda,
        explicitTypeArgs,
        all.length === 1 ? receiverOf(all[0]) : undefined,
        row,
        name
      );
    this.checkAccessible(scope, chosen.candidate.symbol, row, chosen.candidate.receiverType);
    return this.completeCall(scope, context, chosen, args, compiledArgs, expected, row);
  }

  /**
   * The attempt of a lone candidate, whose receiver and expected type constrain its variables before the arguments
   * compile, so that the arguments see the types they give them, as `List<Long>` does to the literals of `listOf(1, 2)`.
   */
  private startLoneAttempt(
    lone: Candidate,
    { args, hasTrailingLambda, explicitTypeArgs, row, name }: CallSyntax,
    receiver: Compiled | undefined,
    expected: KType | undefined
  ): Attempt {
    const attempt = this.startAttempt(lone, args, hasTrailingLambda, explicitTypeArgs);
    if (!attempt) return this.reportUnmappable(lone, args, hasTrailingLambda, explicitTypeArgs, row, name);
    if (lone.symbol.extensionReceiver && receiver) {
      isSubtype(receiver.type, substitute(lone.symbol.extensionReceiver, attempt.substitution));
    }
    this.constrainByKnownExpected(attempt, expected, row);
    return attempt;
  }

  /** The arguments other than lambdas, which compile against the parameter types the attempts agree on. */
  private compileArguments(
    scope: Scope,
    context: FunctionContext,
    args: ArgumentSyntax[],
    attempts: Attempt[],
    isOverloaded: boolean
  ): (Compiled | undefined)[] {
    const compiledArgs: (Compiled | undefined)[] = [];
    for (const [index, argument] of args.entries()) {
      if (isLambdaArgument(argument.value)) {
        compiledArgs.push(undefined);
        continue;
      }
      const expectedType = expectedArgumentType(attempts, compiledArgs, index, argument.value, isOverloaded);
      compiledArgs.push(this.compileExpression(scope, context, argument.value, expectedType));
    }
    return compiledArgs;
  }

  /** The most specific applicable candidate of the nearest level that has one. */
  // code-gauge-allow functionParameterCount 7 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  private chooseAttempt(
    scope: Scope,
    context: FunctionContext,
    levels: Candidate[][],
    { args, hasTrailingLambda, explicitTypeArgs, row, name }: CallSyntax,
    compiledArgs: (Compiled | undefined)[],
    loneAttempt: Attempt | undefined,
    receiverOf: (candidate: Candidate) => Compiled | undefined
  ): Attempt | undefined {
    for (const level of levels) {
      const applicable = level.flatMap((candidate) => {
        const attempt =
          loneAttempt?.candidate === candidate
            ? loneAttempt
            : this.startAttempt(candidate, args, hasTrailingLambda, explicitTypeArgs);
        if (!attempt) return [];
        return this.isApplicable(attempt, args, compiledArgs, receiverOf(candidate)) ? [attempt] : [];
      });
      if (applicable.length === 0) continue;
      return applicable.length === 1
        ? applicable[0]
        : this.mostSpecific(applicable, compiledArgs, args, scope, context, row, name);
    }
    return undefined;
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private startAttempt(
    candidate: Candidate,
    args: ArgumentSyntax[],
    hasTrailingLambda: boolean,
    explicitTypeArgs: KType[]
  ): Attempt | undefined {
    const { symbol } = candidate;
    const mapping = mapArguments(symbol.params, args, hasTrailingLambda);
    if (!mapping) return undefined;
    const substitution = new Map(candidate.substitution);
    const typeParameters = this.inferredTypeParameters(candidate);
    const variables: InferenceVariable[] = [];
    if (explicitTypeArgs.length > 0) {
      // A candidate with another number of type parameters does not apply, as maxOf(Int, Int) to maxOf<Int>(...).
      if (explicitTypeArgs.length !== typeParameters.length) return undefined;
      for (const [index, param] of typeParameters.entries()) substitution.set(param, explicitTypeArgs[index]);
    } else {
      for (const param of typeParameters) {
        const variable: InferenceVariable = { param, lower: [], upper: [], fixed: undefined };
        variables.push(variable);
        substitution.set(param, { kind: 'variable', variable, nullable: false });
      }
      // A bound that names another type parameter, as `T : S` in `reduce`, relates the two variables.
      for (const variable of variables) {
        for (const bound of variable.param.bounds) {
          const substituted = substitute(bound, substitution);
          if (resolved(substituted).kind === 'variable')
            isSubtype({ kind: 'variable', variable, nullable: false }, substituted);
        }
      }
    }
    const attempt = { candidate, variables, substitution, mapping };
    this.constrainDelegateResult(attempt, args);
    return attempt;
  }

  private constrainDelegateResult({ candidate, variables, substitution }: Attempt, args: ArgumentSyntax[]): void {
    const delegate = this.delegateCalls.get(args);
    if (!delegate || variables.length === 0) return;
    const { type, isVar } = delegate;
    const { symbol } = candidate;
    const returnType = candidate.kind === 'constructor' ? symbol.owner?.selfType : symbol.returnType;
    if (!returnType) return;
    const result = substitute(returnType, substitution);
    if (result.kind !== 'class') return;
    const properties = this.packages.get('kotlin.properties')?.classes;
    const contracts = [
      properties?.get(isVar ? 'ReadWriteProperty' : 'ReadOnlyProperty'),
      this.packages.get('kotlin')?.classes.get('Lazy'),
    ];
    for (const contract of contracts) {
      const projection = contract && asSuper(result, contract);
      if (!projection) continue;
      const projectedArgs = projection.args.map<TypeArgument>((_, index) =>
        index === projection.args.length - 1 ? { variance: 'inv', type } : { variance: 'star' }
      );
      this.constrainReturnType(variables, result, { ...projection, args: projectedArgs });
      return;
    }
  }

  /** The type parameters a call infers: the function's, and for a constructor its class's. */
  private inferredTypeParameters(candidate: Candidate): TypeParameterSymbol[] {
    const { symbol } = candidate;
    if (candidate.kind === 'constructor' && symbol.owner)
      return [...symbol.owner.typeParameters, ...symbol.typeParameters];
    return symbol.typeParameters;
  }

  // code-gauge-allow functionCognitiveComplexity 27 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private isApplicable(
    attempt: Attempt,
    args: ArgumentSyntax[],
    compiledArgs: (Compiled | undefined)[],
    receiver: Compiled | undefined
  ): boolean {
    const { symbol } = attempt.candidate;
    if (symbol.extensionReceiver && receiver) {
      const receiverType = substitute(symbol.extensionReceiver, attempt.substitution);
      if (!isSubtype(receiver.type, receiverType)) return false;
    }
    // Integer literals come last, so that they take the type the other arguments give a type parameter.
    const checks = [...attempt.mapping.entries()]
      .flatMap(([paramIndex, indexes]) => indexes.map((index) => ({ param: symbol.params[paramIndex], index })))
      .toSorted((a, b) => Number(isLiteralAt(compiledArgs, a.index)) - Number(isLiteralAt(compiledArgs, b.index)));
    for (const { param, index } of checks) {
      const paramType = substitute(param.type, attempt.substitution);
      const compiled = compiledArgs[index];
      if (!compiled) {
        if (!this.lambdaFits(args[index].value as LambdaExpression, paramType)) return false;
        continue;
      }
      if (args[index].isSpread) continue;
      if (!this.acceptsArgument(compiled, param.isVararg ? this.varargElementType(paramType) : paramType)) return false;
    }
    for (const variable of attempt.variables) {
      const copy: InferenceVariable = {
        ...variable,
        lower: [...variable.lower],
        upper: [...variable.upper],
        fixed: undefined,
      };
      fixVariable(copy);
      if (!fitsInferenceBounds(copy)) return false;
    }
    return true;
  }

  /** The type of each element a `vararg` parameter collects; its declared type is that of one element. */
  protected varargElementType(type: KType): KType {
    return type;
  }

  /**
   * The function type of a `fun interface`, which a lambda converts to, with its single abstract method: for
   * `Comparator<T>`, `(T, T) -> Int`.
   */
  protected samOf(type: KType): { functionType: FunctionType; method: FunctionSymbol; cls: ClassSymbol } | undefined {
    const actual = resolved(type);
    if (actual.kind !== 'class' || !actual.cls.isFunInterface) return undefined;
    for (const members of actual.cls.members.values()) {
      for (const member of members) {
        if (member.kind !== 'function' || !member.isAbstract) continue;
        const found = this.membersOf<FunctionSymbol>(actual, member.name, 'function').find(
          (candidate) => candidate.symbol === member
        );
        const substitution = found?.substitution ?? new Map();
        return {
          functionType: {
            kind: 'function',
            receiver: undefined,
            params: member.params.map((param) => substitute(param.type, substitution)),
            returnType: substitute(member.returnType ?? this.core.unit.type, substitution),
            nullable: false,
          },
          method: member,
          cls: actual.cls,
        };
      }
    }
    return undefined;
  }

  /** Wraps a lambda in an object of a `fun interface`, whose abstract method calls it. */
  protected abstract samWrap(
    lambda: Compiled,
    sam: NonNullable<ReturnType<CallCompiler['samOf']>>,
    type: KType
  ): Compiled;

  /** Whether a lambda's parameters fit a function type, which only its number of parameters can tell before inference. */
  private lambdaFits(lambda: LambdaExpression, type: KType): boolean {
    const sam = this.samOf(type);
    if (sam) return this.lambdaFits(lambda, sam.functionType);
    const actual = resolved(type);
    if (actual.kind === 'variable' || actual.kind === 'param') return true;
    if (actual.kind === 'class') return actual.cls === this.core.function || actual.cls === this.core.any;
    if (actual.kind !== 'function') return false;
    if (lambda.params === undefined) return actual.params.length <= 1;
    return lambda.params.length === actual.params.length;
  }

  // code-gauge-allow functionParameterCount 7 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  private mostSpecific(
    attempts: Attempt[],
    compiledArgs: (Compiled | undefined)[],
    args: ArgumentSyntax[],
    scope: Scope,
    context: FunctionContext,
    row: number,
    name: string
  ): Attempt {
    let best = attempts.filter((attempt) =>
      attempts.every((other) => other === attempt || this.isAsSpecific(attempt, other, compiledArgs))
    );
    if (best.length > 1) {
      // Without a vararg or default parameter left unused, a candidate is more specific.
      const fewest = Math.min(...best.map(unusedParameters));
      best = best.filter((attempt) => unusedParameters(attempt) === fewest);
    }
    if (best.length === 1) return best[0];
    const byLambda = this.chooseByLambdaResult(best.length > 0 ? best : attempts, args, scope, context);
    if (byLambda) return byLambda;
    if (best.length > 1 && best.every((attempt) => attempt.candidate.symbol.isLibrary)) return best[0];
    return this.error(row, `${name} の呼び出しが、どの関数のことか決められません。`);
  }

  /**
   * Whether `a` is as specific as `b` for the arguments. As Kotlin compares overloads, `a`'s type parameters stay as
   * they are and `b`'s become fresh variables, which keeps the comparison from constraining the variables the call
   * infers.
   */
  // code-gauge-allow functionCognitiveComplexity 17 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private isAsSpecific(a: Attempt, b: Attempt, compiledArgs: (Compiled | undefined)[]): boolean {
    const aSubstitution = a.candidate.substitution;
    const bSubstitution = this.freshSubstitution(b);
    for (const [index, compiled] of compiledArgs.entries()) {
      const aType = parameterTypeOf(a, index);
      const bType = parameterTypeOf(b, index);
      if (!aType || !bType || !compiled) continue;
      // An integer literal is an Int unless only another integer type fits, as `1..4` calls `rangeTo(Int)`; a type
      // parameter fits any, so `maxOf(Long, Long)` is as specific as `maxOf(T, T)` for `maxOf(1, 2L)`.
      if (compiled.integerLiteral && aType.kind !== 'param' && bType.kind !== 'param') {
        const aIsLiteral = isSubtype(compiled.type, substitute(aType, a.substitution));
        const bIsLiteral = isSubtype(compiled.type, substitute(bType, b.substitution));
        if (aIsLiteral !== bIsLiteral) {
          if (!aIsLiteral) return false;
          continue;
        }
      }
      if (!isSubtype(substitute(aType, aSubstitution), substitute(bType, bSubstitution))) return false;
    }
    const aReceiver = a.candidate.symbol.extensionReceiver;
    const bReceiver = b.candidate.symbol.extensionReceiver;
    return (
      !aReceiver || !bReceiver || isSubtype(substitute(aReceiver, aSubstitution), substitute(bReceiver, bSubstitution))
    );
  }

  private freshSubstitution(attempt: Attempt): Substitution {
    const substitution = new Map(attempt.candidate.substitution);
    for (const param of this.inferredTypeParameters(attempt.candidate)) {
      const variable: InferenceVariable = { param, lower: [], upper: [], fixed: undefined };
      substitution.set(param, { kind: 'variable', variable, nullable: false });
    }
    return substitution;
  }

  /** Overloads that differ only in a lambda's result, such as `sumOf`, are chosen by the type the lambda returns. */
  private chooseByLambdaResult(
    attempts: Attempt[],
    args: ArgumentSyntax[],
    scope: Scope,
    context: FunctionContext
  ): Attempt | undefined {
    const lambdaIndex = args.findIndex((argument) => isLambdaArgument(argument.value));
    if (lambdaIndex === -1) return undefined;
    // The lambda's parameter types are fixed before it is compiled to probe its result, which would otherwise add bounds.
    const lambdaTypes = attempts.map((attempt) => {
      const paramIndex = attempt.mapping.findIndex((indexes) => indexes.includes(lambdaIndex));
      const type = substitute(attempt.candidate.symbol.params[paramIndex].type, attempt.substitution);
      return this.lambdaTypeFor(type, attempt) ?? resolved(type);
    });
    const first = lambdaTypes[0];
    if (first.kind !== 'function') return undefined;
    const probe = this.compileLambdaProbe(scope, context, args[lambdaIndex].value as LambdaExpression, first);
    if (!probe) return undefined;
    const fitting = attempts.filter((_, index) => {
      const type = lambdaTypes[index];
      return type.kind === 'function' && !hasOpenVariables(type.returnType) && isExactlyType(probe, type.returnType);
    });
    return fitting.length > 0 ? fitting[0] : undefined;
  }

  /** The result type a lambda would have with the parameter types of `type`, computed without keeping its code. */
  protected abstract compileLambdaProbe(
    scope: Scope,
    context: FunctionContext,
    lambda: LambdaExpression,
    type: FunctionType
  ): KType | undefined;

  /**
   * Rejects a use of a `private` or `protected` member outside the code that may see it, as kotlinc does. A subclass
   * uses a protected member only through a receiver of the subclass, or through `super`, whose receiver is undefined.
   */
  protected checkAccessible(
    scope: Scope,
    member: FunctionSymbol | PropertySymbol,
    row: number,
    receiverType: KType | undefined
  ): void {
    const { owner, visibility } = member;
    if (!owner || visibility === 'public' || visibility === 'internal') return;
    const classes = this.enclosingClasses(scope);
    if (visibility === 'private') {
      // A class sees the private members of its companion object.
      if (classes.includes(owner) || (owner.outer?.companion === owner && classes.includes(owner.outer))) return;
      this.error(row, `${member.name} は private なので、${owner.name} の外からは使えません。`);
    }
    if (
      !classes.some(
        (cls) => cls.isSubclassOf(owner) && (!receiverType || isSubtype(nonNull(receiverType), cls.selfType))
      )
    )
      this.error(row, `${member.name} は protected なので、${owner.name} とそのサブクラスの外からは使えません。`);
  }

  /** The classes whose declarations hold the code of a scope, nested classes' outer classes included. */
  private enclosingClasses(scope: Scope): ClassSymbol[] {
    const classes: ClassSymbol[] = [];
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      for (let cls = current.receiver?.cls ?? current.staticClass; cls; cls = cls.outer) {
        if (!classes.includes(cls)) classes.push(cls);
      }
    }
    return classes;
  }

  /** A call's result type: for a constructor its class with the type parameters, which the expected type may infer. */
  private declaredReturnOf(candidate: Candidate, row: number): KType {
    const { symbol } = candidate;
    return candidate.kind === 'constructor' && symbol.owner
      ? symbol.owner.selfType
      : this.ensureReturnType(symbol, row);
  }

  /**
   * Constrains the variables by an expected type before the arguments compile, unless the expected type is itself still
   * being inferred, as `B` of `"a" to listOf(...)` is, whose bounds would then name variables of a discarded attempt.
   */
  private constrainByKnownExpected(attempt: Attempt, expected: KType | undefined, row: number): void {
    if (expected && !hasOpenVariables(expected)) this.constrainByExpected(attempt, expected, row);
  }

  /** The expected type constrains the variables, where the result's type mentions them and it can hold. */
  private constrainByExpected(attempt: Attempt, expected: KType | undefined, row: number): void {
    const { candidate, substitution, variables } = attempt;
    const declaredReturn = this.declaredReturnOf(candidate, row);
    if (expected) this.constrainReturnType(variables, substitute(declaredReturn, substitution), expected);
  }

  private constrainReturnType(variables: InferenceVariable[], result: KType, expected: KType): void {
    if (!hasOpenVariables(result)) return;
    const saved = variables.map((variable) => ({ lower: [...variable.lower], upper: [...variable.upper] }));
    if (isSubtype(result, expected)) return;
    for (const [index, variable] of variables.entries()) {
      variable.lower = saved[index].lower;
      variable.upper = saved[index].upper;
    }
  }

  // code-gauge-allow functionParameterCount 7 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  private completeCall(
    scope: Scope,
    context: FunctionContext,
    attempt: Attempt,
    args: ArgumentSyntax[],
    compiledArgs: (Compiled | undefined)[],
    expected: KType | undefined,
    row: number
  ): ResolvedCall {
    const { candidate, substitution } = attempt;
    const { symbol } = candidate;
    this.constrainByExpected(attempt, expected, row);
    for (const [paramIndex, indexes] of attempt.mapping.entries()) {
      for (const index of indexes) {
        compiledArgs[index] ??= this.compileLambdaArgument(scope, context, attempt, paramIndex, args[index]);
      }
    }
    this.fixVariables(attempt, row);
    const evaluateArgs = argumentEvaluator(
      symbol,
      this.argumentEvaluations(attempt, args, compiledArgs as Compiled[]),
      (type) => this.varargArrayFactory(type)
    );
    const callRow = this.recordsSteps && !this.file.isLibrary ? row : undefined;
    const call = (frame: Frame, receiver: Value): Value => {
      const { temporaries } = frame;
      const mark = temporaries.length;
      temporaries.push(receiver);
      try {
        const values = evaluateArgs(frame);
        for (const value of values) temporaries.push(value);
        return callFunction(symbol, frame, receiver, values, callRow);
      } finally {
        temporaries.length = mark;
      }
    };
    const typeArguments = new Map<TypeParameterSymbol, KType>();
    for (const param of this.inferredTypeParameters(candidate))
      typeArguments.set(param, resolved(substitution.get(param) as KType));
    return {
      symbol,
      candidate,
      type: this.callResultType(attempt, typeArguments, row),
      repr: candidate.kind === 'constructor' ? 'ref' : returnRepr(symbol),
      call,
      evaluateArgs,
      callRow,
      argumentsCreateObjects: args.length > 0 && compiledArgs.every((compiled) => compiled?.isCreation === true),
      usesDefaultArguments: symbol.params.some(
        (param, index) => param.hasDefault && attempt.mapping[index].length === 0
      ),
      compiledArgs,
      receiverRepr: receiverRepr(symbol),
      typeArguments,
    };
  }

  /** A lambda argument, compiled now that the other arguments constrain the types of its parameters. */
  private compileLambdaArgument(
    scope: Scope,
    context: FunctionContext,
    attempt: Attempt,
    paramIndex: number,
    argument: ArgumentSyntax
  ): Compiled {
    const { symbol } = attempt.candidate;
    const param = symbol.params[paramIndex];
    const paramType = substitute(param.type, attempt.substitution);
    const elementType = param.isVararg ? this.varargElementType(paramType) : paramType;
    const sam = this.samOf(elementType);
    const lambdaType = this.lambdaTypeFor(sam ? sam.functionType : elementType, attempt);
    const compiled = this.compileLambda(
      scope,
      context,
      argument.value as LambdaExpression,
      lambdaType,
      symbol.isInline && !sam
    );
    if (lambdaType) {
      const bodyType = (resolved(compiled.type) as FunctionType).returnType;
      const expectedReturn = resolved(lambdaType.returnType);
      if (
        !(expectedReturn.kind === 'class' && expectedReturn.cls === this.core.unit) &&
        !isSubtype(bodyType, lambdaType.returnType)
      ) {
        this.error(argument.row, typeMismatchMessage(lambdaType.returnType, bodyType));
      }
    }
    if (sam) return this.samWrap(compiled, sam, resolved(elementType));
    // A lambda for a type variable, as each of `listOf({ 1 }, { 2 })`, gives the variable its type.
    if (!lambdaType) isSubtype(compiled.type, elementType);
    return compiled;
  }

  /**
   * Fixes the call's type variables and checks their bounds. Checking a fixed variable's bounds constrains the variables
   * they mention, as `C : Iterable<T>` in `onEach` gives `T` its type from `C`, so a variable nothing constrains yet
   * waits for the others.
   */
  // code-gauge-allow functionCognitiveComplexity 24 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private fixVariables({ candidate, substitution, variables }: Attempt, row: number): void {
    const { symbol } = candidate;
    let pending = variables;
    while (pending.length > 0) {
      const waiting = pending.filter((variable) => !fixVariable(variable));
      for (const variable of pending) {
        if (!variable.fixed) continue;
        this.checkFixedVariable(symbol.name, variable, row);
        if (waiting.length > 0)
          for (const bound of variable.param.bounds) isSubtype(variable.fixed, substitute(bound, substitution));
      }
      if (waiting.length === pending.length) {
        this.error(row, `型引数 ${waiting[0].param.name} を推論できません。型を書いてください。`);
      }
      pending = waiting;
    }
    for (const param of this.inferredTypeParameters(candidate)) {
      const type = resolved(substitution.get(param) as KType);
      for (const bound of param.bounds) {
        if (!isSubtype(type, substitute(bound, substitution))) {
          this.error(
            row,
            `型引数 ${typeToString(type)} は ${typeToString(resolved(substitute(bound, substitution)))} を満たしません。`
          );
        }
      }
    }
  }

  /**
   * Rejects a fixed variable that misses its bounds, or that is reified and fixed to an intersection of types, which
   * kotlinc rejects as `arrayOf(1, "a")` makes `Comparable<*> & Serializable`.
   */
  private checkFixedVariable(name: string, variable: InferenceVariable, row: number): void {
    if (!fitsInferenceBounds(variable))
      this.error(row, `${name} の型引数 ${variable.param.name} に合う型がありません。`);
    if (variable.param.isReified && hasIntersectionSupertype(variable.lower))
      this.error(
        row,
        `${name} の型引数 ${variable.param.name} が、複数の型の組み合わせになります。${name}<Any> のように型を書いてください。`
      );
  }

  /** The arguments, in the order they are written, converted to the parameters' declared representations. */
  private argumentEvaluations(
    { candidate, substitution, mapping }: Attempt,
    args: ArgumentSyntax[],
    compiledArgs: Compiled[]
  ): ArgumentEvaluation[] {
    const { symbol } = candidate;
    const reprs = parameterReprs(symbol);
    const evaluations = mapping.flatMap((indexes, paramIndex) =>
      indexes.map((index): ArgumentEvaluation => {
        const param = symbol.params[paramIndex];
        const compiled = compiledArgs[index];
        const paramType = substitute(param.type, substitution);
        const elementType = param.isVararg ? this.varargElementType(paramType) : paramType;
        const isSpread = args[index].isSpread === true;
        if (isSpread) return { index, paramIndex, eval: compiled.eval, isSpread };
        if (!this.acceptsArgument(compiled, elementType)) {
          this.error(args[index].row, typeMismatchMessage(elementType, compiled.type));
        }
        const converted = this.convertTo(compiled, elementType, args[index].row);
        const declaredRepr = param.isVararg ? reprOf(this.core, param.type) : reprs[paramIndex];
        const fromRepr = reprOf(this.core, elementType);
        return { index, paramIndex, eval: this.reprConvert(converted, fromRepr, declaredRepr), isSpread };
      })
    );
    return evaluations.toSorted((a, b) => a.index - b.index);
  }

  /** The type of a call's result, which for a constructor is its class with the inferred type arguments. */
  private callResultType(
    { candidate, substitution }: Attempt,
    typeArguments: Map<TypeParameterSymbol, KType>,
    row: number
  ): KType {
    const { symbol } = candidate;
    if (candidate.kind !== 'constructor' || !symbol.owner) {
      return resolved(substitute(this.declaredReturnOf(candidate, row), substitution));
    }
    return {
      kind: 'class',
      cls: symbol.owner,
      args: symbol.owner.typeParameters.map((param) => ({
        variance: 'inv' as const,
        type: typeArguments.get(param) as KType,
      })),
      nullable: false,
    };
  }

  /** Makes sure a function without a declared result type has its result inferred from its body. */
  protected abstract ensureReturnType(func: FunctionSymbol, row: number): KType;

  protected abstract reprConvert(eval_: Eval, from: ReturnType<typeof reprOf>, to: ReturnType<typeof reprOf>): Eval;

  /** Creates the array a `vararg` parameter receives from the arguments it collects. */
  protected abstract varargArrayFactory(elementType: KType): (frame: Frame, values: Value[]) => KObject;

  /** The function type a lambda argument is checked against, fixing the variables its parameters need. */
  private lambdaTypeFor(type: KType, { variables, substitution }: Attempt): FunctionType | undefined {
    const actual = determinedType(resolved(type));
    if (actual?.kind !== 'function') return undefined;
    const inputs = actual.receiver ? [actual.receiver, ...actual.params] : actual.params;
    for (const input of inputs) {
      for (const variable of variables) {
        if (variable.fixed || !mentionsVariable(input, (candidate) => candidate === variable)) continue;
        constrainThroughBounds(variable, variables, substitution);
        fixVariable(variable);
      }
    }
    return resolved(actual) as FunctionType;
  }

  private reportUnmappable(
    candidate: Candidate,
    args: ArgumentSyntax[],
    hasTrailingLambda: boolean,
    explicitTypeArgs: KType[],
    row: number,
    name: string
  ): never {
    if (explicitTypeArgs.length > 0 && explicitTypeArgs.length !== this.inferredTypeParameters(candidate).length)
      this.error(row, `${name} の型引数の数が違います。`);
    const { params } = candidate.symbol;
    const positional = args.filter((argument) => argument.name === undefined).length;
    const named = args.find(
      (argument) => argument.name !== undefined && !params.some((param) => param.name === argument.name)
    );
    if (named) this.error(named.row, `${name} には ${named.name} という引数がありません。`);
    if (positional > params.length && !params.some((param) => param.isVararg)) {
      this.error(row, `${name} に渡す引数が多すぎます。`);
    }
    const missing = params.find(
      (param, index) =>
        !param.hasDefault &&
        !param.isVararg &&
        index >= positional &&
        !args.some((argument) => argument.name === param.name)
    );
    if (missing) this.error(row, `${name} の引数 ${missing.name} が足りません。`);
    if (hasTrailingLambda) this.error(row, `${name} には、ここでラムダ式を渡せません。`);
    return this.error(row, `${name} の引数の書き方に誤りがあります。`);
  }

  // code-gauge-allow functionParameterCount 8 -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  // code-gauge-allow functionCognitiveComplexity 27 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private reportInapplicable(
    all: Candidate[],
    args: ArgumentSyntax[],
    compiledArgs: (Compiled | undefined)[],
    hasTrailingLambda: boolean,
    explicitTypeArgs: KType[],
    receiver: Compiled | undefined,
    row: number,
    name: string
  ): never {
    if (all.length === 1) {
      const attempt = this.startAttempt(all[0], args, hasTrailingLambda, explicitTypeArgs);
      if (!attempt) return this.reportUnmappable(all[0], args, hasTrailingLambda, explicitTypeArgs, row, name);
      const { symbol } = all[0];
      if (symbol.extensionReceiver && receiver) {
        const receiverType = substitute(symbol.extensionReceiver, attempt.substitution);
        if (!isSubtype(receiver.type, receiverType)) {
          if (isNullable(resolved(receiver.type)) && isSubtype(receiver.type, nullable(receiverType))) {
            this.error(row, nullableReceiverMessage(receiver.type));
          }
          this.error(row, `${typeToString(resolved(receiver.type))} には ${name} がありません。`);
        }
      }
      for (const [paramIndex, indexes] of attempt.mapping.entries()) {
        const param = symbol.params[paramIndex];
        for (const index of indexes) {
          const compiled = compiledArgs[index];
          if (!compiled) continue;
          const paramType = substitute(param.type, attempt.substitution);
          if (!this.acceptsArgument(compiled, paramType)) {
            this.error(args[index].row, typeMismatchMessage(paramType, compiled.type));
          }
        }
      }
    }
    return this.error(row, `${name} に、この引数で呼び出せるものがありません。`);
  }

  /** A context for compiling a lambda only to learn its result type, whose code is thrown away. */
  protected probeContext(context: FunctionContext): FunctionContext {
    return new FunctionContext(context, true, '<probe>', context.info.isLibrary, undefined);
  }
}

function fitsInferenceBounds(variable: InferenceVariable): boolean {
  if (!checkVariableBounds(variable)) return false;
  const { fixed } = variable;
  return (
    !variable.param.onlyInputTypes ||
    !fixed ||
    variable.lower.some((input) => isSameType(nonNull(fixed), nonNull(input)))
  );
}

function isExactlyType(a: KType, b: KType): boolean {
  const left = resolved(a);
  const right = resolved(b);
  if (left.kind === 'class' && right.kind === 'class')
    return left.cls === right.cls && left.nullable === right.nullable;
  return isSubtype(left, right) && isSubtype(right, left);
}

export { KObject };

/** The parts of a call that resolving it reads. */
interface CallSyntax {
  args: ArgumentSyntax[];
  hasTrailingLambda: boolean;
  explicitTypeArgs: KType[];
  row: number;
  name: string;
}

/** The declared type of the parameter that takes an argument, or `undefined` for none. */
function parameterTypeOf(attempt: Attempt, argIndex: number): KType | undefined {
  const paramIndex = attempt.mapping.findIndex((indexes) => indexes.includes(argIndex));
  return attempt.candidate.symbol.params[paramIndex]?.type;
}

/** The default and vararg parameters an attempt leaves unused, which make a candidate less specific. */
function unusedParameters(attempt: Attempt): number {
  const { params } = attempt.candidate.symbol;
  const defaults = attempt.mapping.filter((indexes, index) => indexes.length === 0 && params[index].hasDefault).length;
  return defaults + (params.some((param) => param.isVararg) ? 1 : 0);
}

function isLiteralAt(compiledArgs: (Compiled | undefined)[], index: number): boolean {
  return compiledArgs[index]?.integerLiteral !== undefined;
}
