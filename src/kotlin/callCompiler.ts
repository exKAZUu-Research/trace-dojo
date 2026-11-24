// code-gauge-allow-file fileNcss -- the compiler of one area of Kotlin, whose parts call each other closely.
import { CompileError } from '../interpreter/diagnostics';
import {
  type ArgumentEvaluation,
  argumentEvaluator,
  argumentTypeHints,
  expectedArgumentType,
  firstAttempts,
  siblingArguments,
} from './argumentTypes';
import type { Expression, LambdaExpression } from './ast';
import {
  type Compiled,
  convertRepr,
  type Eval,
  FunctionContext,
  isBareCallExpression,
  nullableReceiverMessage,
  type ReceiverSymbol,
  reprOf,
  type Scope,
  typeMismatchMessage,
} from './compilerBase';
import { CompilerCore } from './compilerCore';
import {
  callFunction,
  getPropertyValue,
  isVirtual,
  parameterReprs,
  receiverRepr,
  returnRepr,
  runtimeClassOf,
} from './dispatch';
import { mostSpecificReceivers, type ReceiverSpecificity } from './extensionResolution';
import { literalFits } from './literals';
import { runtimeType } from './reified';
import { siblingResultType } from './resultInference';
import { type Frame, SuspendCall } from './runtime';
import type { ClassSymbol, FunctionSymbol, ParameterSymbol, PropertySymbol, TypeParameterSymbol } from './symbols';
import {
  approximatedReadType,
  asSuper,
  checkVariableBounds,
  commonGenericHint,
  commonSupertype,
  constrainThroughBounds,
  determinedType,
  fillOpenTypeArguments,
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
  isNonNullClass,
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
import { KObject, NULL, type Value } from './values';

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
  /** The type arguments supplied by a receiver or an explicitly declared superclass. */
  substitution: Substitution;
  /** The receiver's static type, for a member or an extension. */
  receiverType: KType | undefined;
  /** For an extension declared in a class, the implicit receiver that is the class's instance the call passes. */
  dispatch?: ReceiverSymbol;
}

interface DeclaredCallLevel {
  candidates: Candidate[];
  receiver: Compiled | undefined;
}

export interface FunctionValueCandidate {
  functionValue: (context: FunctionContext) => Compiled;
  explicitReceiver?: Compiled;
  specificity?: ReceiverSpecificity | undefined;
}

export type CallLevel = DeclaredCallLevel | { functionValues: FunctionValueCandidate[] };

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
  /** The compiled arguments in the order they are written. */
  compiledArgs: (Compiled | undefined)[];
  /** The argument of the first parameter, whose smart casts the library's contracts, as `require`'s, carry on. */
  firstParameterArg: Compiled | undefined;
}

interface Attempt {
  candidate: Candidate;
  variables: InferenceVariable[];
  substitution: Map<TypeParameterSymbol, KType>;
  /** The arguments of each parameter, by their indexes among the call's arguments. */
  mapping: number[][];
  /** Whether a lambda argument declares a parameter type that the candidate's function type cannot pass. */
  hasMismatchedLambda?: boolean;
}

/** The indexes of the arguments assigned to each parameter. */
// code-gauge-allow functionCognitiveComplexity -- mapping keeps the positional cursor, named assignments, and trailing lambda in source order.
function mapArguments(
  params: ParameterSymbol[],
  args: ArgumentSyntax[],
  hasTrailingLambda: boolean
): number[][] | undefined {
  const mapping: number[][] = params.map(() => []);
  let position = 0;
  const positionalCount = hasTrailingLambda ? args.length - 1 : args.length;
  for (let index = 0; index < positionalCount; index++) {
    const { name } = args[index];
    const target = name === undefined ? position : params.findIndex((param) => param.name === name);
    if (target < 0 || target >= params.length) return undefined;
    if (name !== undefined && mapping[target].length > 0) return undefined;
    mapping[target].push(index);
    if (target !== position) position = -1;
    else if (name !== undefined || !params[target].isVararg) position++;
  }
  if (hasTrailingLambda) {
    const last = params.at(-1);
    const tail = mapping.at(-1);
    if (!last || last.isVararg || !tail || tail.length > 0) return undefined;
    tail.push(args.length - 1);
  }
  return params.every((param, index) => mapping[index].length > 0 || param.hasDefault || param.isVararg)
    ? mapping
    : undefined;
}

/**
 * A lambda's probed result that is still a variable, as `if (c) 1 else 2` leaves one with an Int lower bound, is the
 * type inference would fix it to, so it matches the overload a lone literal does.
 */
function settledResult(result: KType | undefined): KType | undefined {
  const actual = result && resolved(result);
  if (actual?.kind !== 'variable' || actual.variable.fixed) return result;
  const lower = actual.variable.lower.map(resolved).filter((type) => !hasOpenVariables(type));
  return lower.length > 0 ? commonSupertype(lower) : result;
}

/** The suspend context a context's suspend calls run in: its own, or the one around the inline lambdas it is in. */
function suspendContextOf(context: FunctionContext): FunctionContext | undefined {
  for (let current: FunctionContext | undefined = context; current; current = current.parent) {
    if (current.isSuspend) return current;
    if (!current.isLambda || !current.inlineLambda) return undefined;
  }
  return undefined;
}

/** Whether a context may call suspend functions: a suspend function's or lambda's, or an inline lambda inside one. */
export function allowsSuspendCalls(context: FunctionContext): boolean {
  for (let current: FunctionContext | undefined = context; current; current = current.parent) {
    if (current.isSuspend) return true;
    if (!current.isLambda || !current.inlineLambda) return false;
  }
  return false;
}

/** A call of a suspend function, which the coroutine running the caller performs, dispatching on the receiver. */
function suspendCall(symbol: FunctionSymbol, receiver: Value, args: Value[], callRow: number | undefined): Value {
  return new SuspendCall((caller) => {
    const target = isVirtual(symbol) ? runtimeClassOf(receiver).dispatch(symbol) : symbol;
    const invoke = target.invokeSuspend;
    if (!invoke) throw new Error(`The suspend function ${symbol.name} has no implementation`);
    return invoke(caller, receiver, args, callRow);
  }) as unknown as Value;
}

/** Whether an argument passes a vararg parameter's array, spread as `*array` or named. */
function passesArray(argument: ArgumentSyntax, param: ParameterSymbol): boolean {
  return argument.isSpread === true || (argument.name !== undefined && param.isVararg);
}

function isLambdaArgument(expression: Expression): expression is LambdaExpression {
  return expression.kind === 'lambda';
}

/**
 * Whether an argument waits until the call's other arguments give its function type, as a lambda does and a callable
 * reference, whose overloads that type selects, does too.
 */
function isPostponedArgument(expression: Expression): boolean {
  return isLambdaArgument(expression) || (expression.kind === 'reference' && expression.name !== 'class');
}

function hasTypedParameters(expression: Expression | undefined): boolean {
  return (
    expression !== undefined &&
    isLambdaArgument(expression) &&
    expression.params !== undefined &&
    expression.params.some((param) => param.type !== undefined)
  );
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
    isInline: boolean,
    invokesExactlyOnce?: boolean
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

  protected abstract objectInstance(cls: ClassSymbol): Eval;

  /**
   * Reads a property by its simple name; one imported from an object, such as `Duration.Companion.ZERO`, reads that
   * object as its receiver.
   */
  protected topLevelPropertyRead(symbol: PropertySymbol): Eval {
    const holder = symbol.owner?.isObject ? this.objectInstance(symbol.owner) : undefined;
    return (frame) => getPropertyValue(symbol, frame, holder ? (holder(frame) as Value) : NULL);
  }

  protected abstract finishCall(call: ResolvedCall, receiver: Compiled | undefined, row: number): Compiled;

  protected abstract compileInvoke(
    scope: Scope,
    context: FunctionContext,
    functionValue: Compiled,
    args: ArgumentSyntax[],
    hasTrailingLambda: boolean,
    row: number,
    explicitReceiver?: Compiled
  ): Compiled;

  // code-gauge-allow functionParameterCount -- the call and its local fallback diagnostic are supplied by the source form.
  protected resolveInLevels(
    scope: Scope,
    context: FunctionContext,
    levels: CallLevel[],
    args: ArgumentSyntax[],
    hasTrailingLambda: boolean,
    explicitTypeArgs: KType[],
    expected: KType | undefined,
    row: number,
    name: string,
    fallbackError?: CompileError
  ): Compiled {
    const call: CallSyntax = {
      args,
      hasTrailingLambda,
      explicitTypeArgs,
      row,
      name,
    };
    const declared: DeclaredCallLevel[] = [];
    for (const level of levels) {
      if ('candidates' in level) {
        declared.push(level);
        continue;
      }
      if (explicitTypeArgs.length > 0) continue;
      const values = level.functionValues.filter((candidate) => {
        const error = this.probeApplicability(context, (probe) => {
          this.invokeValueCandidate(scope, probe, candidate, call);
        });
        fallbackError ??= error;
        return error === undefined;
      });
      if (values.length === 0) continue;
      if (this.hasApplicableLevel(scope, context, declared, call, expected)) break;
      const best = mostSpecificReceivers(values, (candidate) => candidate.specificity);
      if (best.length > 1) this.error(row, `${name} の呼び出しが、どの関数のことか決められません。`);
      return this.invokeValueCandidate(scope, context, best[0], call);
    }
    if (declared.length === 0 && fallbackError) throw fallbackError;
    const receiverOf = this.levelReceivers(declared);
    const chosen = this.resolveCall(
      scope,
      context,
      declared.map((level) => level.candidates),
      args,
      hasTrailingLambda,
      explicitTypeArgs,
      expected,
      receiverOf,
      row,
      name,
      fallbackError
    );
    return this.finishCall(chosen, receiverOf(chosen.candidate), row);
  }

  private invokeValueCandidate(
    scope: Scope,
    context: FunctionContext,
    candidate: FunctionValueCandidate,
    call: CallSyntax
  ): Compiled {
    const value = candidate.functionValue(context);
    const type = resolved(value.type);
    if (candidate.explicitReceiver && (type.kind !== 'function' || !type.receiver))
      this.error(call.row, 'この関数型にはレシーバーがありません。');
    return this.compileInvoke(
      scope,
      context,
      value,
      call.args,
      call.hasTrailingLambda,
      call.row,
      candidate.explicitReceiver
    );
  }

  private hasApplicableLevel(
    scope: Scope,
    context: FunctionContext,
    levels: DeclaredCallLevel[],
    syntax: CallSyntax,
    expected: KType | undefined
  ): boolean {
    if (levels.length === 0) return false;
    const receiverOf = this.levelReceivers(levels);
    const call = { ...syntax, checkingApplicability: true };
    let hasCandidate = false;
    this.probeApplicability(context, (probe) => {
      const candidates = levels.map((level) => level.candidates);
      hasCandidate = this.selectCall(scope, probe, candidates, call, receiverOf, expected).chosen !== undefined;
    });
    return hasCandidate;
  }

  private levelReceivers(levels: DeclaredCallLevel[]): (candidate: Candidate) => Compiled | undefined {
    const receivers = new Map<Candidate, Compiled | undefined>();
    for (const level of levels)
      for (const candidate of level.candidates) {
        const owner = candidate.symbol.owner;
        const receiver =
          !level.receiver && owner?.isObject && candidate.kind !== 'constructor'
            ? {
                type: owner.type,
                repr: 'ref' as const,
                eval: this.objectInstance(owner),
              }
            : level.receiver;
        receivers.set(candidate, receiver);
      }
    return (candidate) => receivers.get(candidate);
  }

  /**
   * Resolves a call among candidate levels, the nearest first: the first level with an applicable candidate decides,
   * as Kotlin's resolution goes from inner scopes to outer ones.
   */
  // code-gauge-allow functionParameterCount -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
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
    name: string,
    fallbackError?: CompileError
  ): ResolvedCall {
    const receiverOf = (candidate: Candidate): Compiled | undefined =>
      typeof receiver === 'function' ? receiver(candidate) : receiver;
    const call: CallSyntax = {
      args,
      hasTrailingLambda,
      explicitTypeArgs,
      row,
      name,
    };
    const { all, compiledArgs, chosen } = this.selectCall(scope, context, levels, call, receiverOf, expected);
    if (!chosen) {
      if (fallbackError) throw fallbackError;
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
    }
    this.checkAccessible(scope, chosen.candidate.symbol, row, chosen.candidate.receiverType);
    if (!this.file.isLibrary && chosen.candidate.symbol.isDeprecatedError)
      this.error(
        row,
        chosen.candidate.symbol.isLibrary
          ? `${chosen.candidate.symbol.name} は Kotlin で非推奨になり、使用できません。`
          : `${chosen.candidate.symbol.name} は @Deprecated で使えなくされています。`
      );
    return this.completeCall(scope, context, chosen, args, compiledArgs, expected, row);
  }

  private selectCall(
    scope: Scope,
    context: FunctionContext,
    levels: Candidate[][],
    call: CallSyntax,
    receiverOf: (candidate: Candidate) => Compiled | undefined,
    expected: KType | undefined
  ): {
    all: Candidate[];
    compiledArgs: (Compiled | undefined)[];
    chosen: Attempt | undefined;
  } {
    const all = levels.flat();
    const { args, hasTrailingLambda, explicitTypeArgs, row, name } = call;
    if (all.length === 0) this.error(row, `${name} が見つかりません。`);
    // A lone candidate gives its parameter types to the arguments, which literals and nested generic calls need.
    const lone = all.length === 1 ? all[0] : undefined;
    const loneAttempt = lone ? this.startLoneAttempt(lone, call, receiverOf(lone), expected) : undefined;
    // The candidates of the first level that take the arguments, or the lone one, give an argument the type they agree
    // on, as members come before extensions.
    const attempts = loneAttempt
      ? [loneAttempt]
      : firstAttempts(levels, (candidate) => this.startAttempt(candidate, args, hasTrailingLambda, explicitTypeArgs));
    if (!loneAttempt) this.constrainInitialHints(attempts, receiverOf, expected, row);
    const compiledArgs = this.compileArguments(scope, context, args, attempts, !lone);
    const chosen = this.chooseAttempt(scope, context, levels, call, compiledArgs, loneAttempt, receiverOf);
    return { all, compiledArgs, chosen };
  }

  private constrainInitialHints(
    attempts: Attempt[],
    receiverOf: (candidate: Candidate) => Compiled | undefined,
    expected: KType | undefined,
    row: number
  ): void {
    for (const attempt of attempts) {
      this.constrainByKnownExpected(attempt, expected, row);
      const { candidate, substitution } = attempt;
      const receiver = receiverOf(candidate);
      const extension = candidate.symbol.extensionReceiver;
      if (receiver && extension && !hasOpenVariables(receiver.type))
        isSubtype(receiver.type, substitute(extension, substitution));
    }
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

  /**
   * An argument of an overloaded call takes its candidates' agreed type only as a hint: one that the argument cannot
   * meet, such as `Char.plus(Int)` for `listOf("b").first()`, leaves the argument to infer its own type for the
   * candidates of later levels.
   */
  private compileArgument(
    scope: Scope,
    context: FunctionContext,
    value: Expression,
    expected: KType | undefined,
    isOverloaded: boolean
  ): Compiled {
    if (
      isOverloaded &&
      expected &&
      this.probeApplicability(context, (probe) => this.compileExpression(scope, probe, value, expected))
    ) {
      return this.compileExpression(scope, context, value, undefined);
    }
    return this.compileExpression(scope, context, value, expected);
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
    let viable = attempts;
    for (const attempt of attempts) this.constrainFromLambdaParameters(scope, attempt, args);
    for (const [index, argument] of args.entries()) {
      if (isPostponedArgument(argument.value)) {
        compiledArgs.push(undefined);
        continue;
      }
      const siblings = siblingArguments(viable, index);
      const expectedType = expectedArgumentType(
        viable,
        compiledArgs,
        index,
        argument.value,
        isOverloaded && viable.length > 1,
        siblings.length === 0 || isBareCallExpression(argument.value)
      );
      const sibling = this.siblingArgumentHint(scope, context, argument, expectedType, args, compiledArgs, siblings);
      const expected =
        sibling ??
        expectedType ??
        (containsBareCall(argument.value)
          ? this.checkBareArgumentHints(scope, context, argument.value, argumentTypeHints(viable, index))
          : undefined);
      const compiled = this.compileArgument(scope, context, argument.value, expected, isOverloaded);
      compiledArgs.push(compiled);
      if (!argument.isSpread && !compiled.integerLiteral)
        viable = viable.filter((attempt) => this.constrainArgumentHint(attempt, index, compiled));
    }
    return compiledArgs;
  }

  // code-gauge-allow functionParameterCount -- argument evidence depends on the original scope, flow, and sibling positions.
  private siblingArgumentHint(
    scope: Scope,
    context: FunctionContext,
    argument: ArgumentSyntax,
    expected: KType | undefined,
    args: ArgumentSyntax[],
    compiledArgs: (Compiled | undefined)[],
    siblings: number[]
  ): KType | undefined {
    if (context.allowOpenCallTypes || siblings.length === 0 || (expected && !hasOpenVariables(expected)))
      return undefined;
    if (!containsBareCall(argument.value)) return undefined;
    const types = siblings.flatMap((index) => {
      const other = args[index];
      if (other.isSpread || isLambdaArgument(other.value)) return [];
      const type =
        compiledArgs[index]?.type ??
        this.probeResultType(context, (probe) => this.compileExpression(scope, probe, other.value));
      return type ? [type] : [];
    });
    const witness = siblingResultType(types, undefined);
    if (!witness || isBareCallExpression(argument.value)) return witness;
    const shape = this.probeResultType(context, (probe) => {
      probe.allowOpenCallTypes = true;
      return this.compileExpression(scope, probe, argument.value);
    });
    return shape && hasOpenVariables(shape) ? fillOpenTypeArguments(shape, witness) : undefined;
  }

  private constrainFromLambdaParameters(scope: Scope, attempt: Attempt, args: ArgumentSyntax[]): void {
    for (const [index, { value }] of args.entries()) {
      if (!isLambdaArgument(value) || !value.params?.some((param) => param.type)) continue;
      const declared = parameterTypeOf(attempt, index);
      if (!declared) continue;
      const type = resolved(substitute(declared, attempt.substitution));
      const callable = this.samOf(type)?.functionType ?? type;
      if (callable.kind !== 'function') continue;
      for (const [position, param] of value.params.entries()) {
        const input = callable.params[position];
        if (input && param.type && !isSubtype(input, this.resolveType(scope, param.type)))
          attempt.hasMismatchedLambda = true;
      }
    }
  }

  private constrainArgumentHint(attempt: Attempt, index: number, argument: Compiled): boolean {
    const paramIndex = attempt.mapping.findIndex((indexes) => indexes.includes(index));
    const param = attempt.candidate.symbol.params[paramIndex];
    if (!param) return false;
    const type = substitute(param.type, attempt.substitution);
    if (!this.acceptsArgument(argument, param.isVararg ? this.varargElementType(type) : type)) return false;
    return attempt.variables.every((variable) => nominalBoundsFit(variable, attempt.substitution));
  }

  private probingArgumentHint = false;

  // code-gauge-allow functionCognitiveComplexity -- the hint loop restores its compiler state even when it rejects an ambiguous result.
  private checkBareArgumentHints(
    scope: Scope,
    context: FunctionContext,
    expression: Expression,
    hints: (KType | undefined)[]
  ): KType | undefined {
    if (this.probingArgumentHint) return undefined;
    let applicable: { hint: KType; result: KType } | undefined;
    const saved = this.flow;
    for (const hint of hints) {
      if (!hint || hasOpenVariables(hint) || (applicable && isSameType(applicable.hint, hint))) continue;
      this.flow = saved.copy();
      this.probingArgumentHint = true;
      try {
        const probe = this.compileExpression(scope, this.probeContext(context), expression, hint);
        if (!isSubtype(probe.type, hint)) continue;
        if (applicable && !isSameType(applicable.result, probe.type)) return undefined;
        applicable ??= { hint, result: probe.type };
      } catch (error) {
        if (!(error instanceof CompileError)) throw error;
      } finally {
        this.flow = saved;
        this.probingArgumentHint = false;
      }
    }
    return applicable?.hint;
  }

  /** The most specific applicable candidate of the nearest level that has one. */
  // code-gauge-allow functionParameterCount -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  private chooseAttempt(
    scope: Scope,
    context: FunctionContext,
    levels: Candidate[][],
    call: CallSyntax,
    compiledArgs: (Compiled | undefined)[],
    loneAttempt: Attempt | undefined,
    receiverOf: (candidate: Candidate) => Compiled | undefined
  ): Attempt | undefined {
    const { args, row, name, checkingApplicability } = call;
    for (const level of levels) {
      const applicable = level.flatMap((candidate) => {
        const attempt =
          loneAttempt?.candidate === candidate ? loneAttempt : this.startChoiceAttempt(scope, candidate, call);
        return attempt && this.isApplicable(attempt, args, compiledArgs, receiverOf(candidate)) ? [attempt] : [];
      });
      if (applicable.length === 0) continue;
      return checkingApplicability || applicable.length === 1
        ? applicable[0]
        : this.mostSpecific(applicable, compiledArgs, args, scope, context, row, name);
    }
    return undefined;
  }

  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
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
        const variable: InferenceVariable = {
          param,
          lower: [],
          upper: [],
          fixed: undefined,
        };
        variables.push(variable);
        substitution.set(param, {
          kind: 'variable',
          variable,
          nullable: false,
        });
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
      this.constrainReturnType(result, { ...projection, args: projectedArgs });
      return;
    }
  }

  /** The type parameters a call infers: the function's, and for a constructor its class's. */
  private inferredTypeParameters(candidate: Candidate): TypeParameterSymbol[] {
    const { symbol } = candidate;
    if (candidate.kind === 'constructor' && symbol.owner)
      return [
        ...symbol.owner.typeParameters.filter((parameter) => !candidate.substitution.has(parameter)),
        ...symbol.typeParameters,
      ];
    return symbol.typeParameters;
  }

  /** A candidate's attempt, which a lambda declaring a parameter type it cannot pass rules out. */
  private startChoiceAttempt(
    scope: Scope,
    candidate: Candidate,
    { args, hasTrailingLambda, explicitTypeArgs }: CallSyntax
  ): Attempt | undefined {
    const attempt = this.startAttempt(candidate, args, hasTrailingLambda, explicitTypeArgs);
    if (attempt) this.constrainFromLambdaParameters(scope, attempt, args);
    return attempt;
  }

  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private isApplicable(
    attempt: Attempt,
    args: ArgumentSyntax[],
    compiledArgs: (Compiled | undefined)[],
    receiver: Compiled | undefined
  ): boolean {
    const { symbol } = attempt.candidate;
    if (attempt.hasMismatchedLambda) return false;
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
        const { value } = args[index];
        if (value.kind === 'lambda' ? !this.lambdaFits(value, paramType) : !this.referenceFits(paramType)) return false;
        continue;
      }
      if (passesArray(args[index], param)) {
        if (!this.acceptsArgument(compiled, this.varargArrayOf(param, paramType))) return false;
        continue;
      }
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

  /**
   * The value a call passes a context parameter of a type: the nearest implicit receiver or context parameter around
   * the call that is of the type.
   */
  protected contextArgument(scope: Scope, context: FunctionContext, type: KType, row: number): Compiled {
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      const { receiver } = current;
      if (receiver && isSubtype(this.receiverTypeOf(receiver), type))
        return {
          type: receiver.type,
          repr: reprOf(this.core, receiver.type),
          eval: this.receiverAccess(context, receiver),
        };
      for (const variable of current.variables.values()) {
        if (variable.isContextParameter && isSubtype(variable.type, type))
          return {
            type: variable.type,
            repr: reprOf(this.core, variable.type),
            eval: this.variableAccess(context, variable).read,
          };
      }
    }
    return this.error(row, `${typeToString(resolved(type))} のコンテキストがありません。with などで用意してください。`);
  }

  protected abstract receiverTypeOf(receiver: ReceiverSymbol): KType;

  /** Rejects a suspend call that a sequence builder's scope does not allow, as `@RestrictsSuspension` makes kotlinc. */
  private checkRestrictedSuspension(context: FunctionContext, symbol: FunctionSymbol, row: number): void {
    const scopeClass = suspendContextOf(context)?.restrictedScope;
    if (!scopeClass) return;
    const receiver = symbol.extensionReceiver && resolved(symbol.extensionReceiver);
    const onScope =
      symbol.owner?.isSubclassOf(scopeClass) === true ||
      (receiver?.kind === 'class' && receiver.cls.isSubclassOf(scopeClass));
    if (!onScope)
      this.error(
        row,
        `sequence や iterator の中では、${scopeClass.name} のメンバーか拡張の suspend 関数だけを呼べます。`
      );
  }

  /** The array a `vararg` parameter of the element type holds. */
  protected abstract varargArrayType(elementType: KType): KType;

  /**
   * The array a vararg parameter holds, whose class its declared type decides: `IntArray` for `vararg xs: Int`, and
   * `Array<out T>` for `vararg xs: T` whatever `T` is.
   */
  private varargArrayOf(param: ParameterSymbol, paramType: KType): KType {
    if (resolved(param.type).kind === 'class') return this.varargArrayType(paramType);
    return { kind: 'class', cls: this.core.array, args: [{ variance: 'out', type: paramType }], nullable: false };
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

  /** Whether a callable reference may stand for a value of the type, which its expected function type then selects. */
  private referenceFits(type: KType): boolean {
    if (this.samOf(type)) return true;
    const actual = resolved(type);
    if (actual.kind === 'class')
      return (
        actual.cls === this.core.function ||
        actual.cls === this.core.any ||
        this.core.functionInterfaces.includes(actual.cls)
      );
    return actual.kind !== 'nothing';
  }

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

  // code-gauge-allow functionParameterCount -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
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
      attempts.every((other) => other === attempt || this.isAsSpecific(attempt, other, compiledArgs, args))
    );
    if (best.length > 1) {
      // Without a vararg or default parameter left unused, a candidate is more specific.
      const fewest = Math.min(...best.map(unusedParameters));
      best = best.filter((attempt) => unusedParameters(attempt) === fewest);
    }
    if (best.length === 1) return best[0];
    const byLambda = this.chooseByLambdaResult(best.length > 0 ? best : attempts, args, scope, context);
    if (byLambda) return byLambda;
    if (
      best.length > 1 &&
      best.every(({ candidate }) => candidate.symbol.isLibrary && !candidate.symbol.resolvesByLambdaResult)
    )
      return best[0];
    return this.error(row, `${name} の呼び出しが、どの関数のことか決められません。`);
  }

  /**
   * Whether `a` is as specific as `b` for the arguments. As Kotlin compares overloads, `a`'s type parameters stay as
   * they are and `b`'s become fresh variables, which keeps the comparison from constraining the variables the call
   * infers.
   */
  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private isAsSpecific(
    a: Attempt,
    b: Attempt,
    compiledArgs: (Compiled | undefined)[],
    args: ArgumentSyntax[]
  ): boolean {
    const aSubstitution = a.candidate.substitution;
    const bSubstitution = this.freshSubstitution(b);
    for (const [index, compiled] of compiledArgs.entries()) {
      const aType = parameterTypeOf(a, index);
      const bType = parameterTypeOf(b, index);
      // A lambda that declares a parameter's type compares as a value of either function type would, as
      // `(Number) -> Unit` is more specific than `(Int) -> Unit`; an untyped one is ranked by its result later.
      if (!aType || !bType || (!compiled && !hasTypedParameters(args[index]?.value))) continue;
      // An integer literal is an Int unless only another integer type fits, as `1..4` calls `rangeTo(Int)`; a type
      // parameter fits any, so `maxOf(Long, Long)` is as specific as `maxOf(T, T)` for `maxOf(1, 2L)`.
      if (compiled?.integerLiteral && aType.kind !== 'param' && bType.kind !== 'param') {
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
      const variable: InferenceVariable = {
        param,
        lower: [],
        upper: [],
        fixed: undefined,
      };
      substitution.set(param, { kind: 'variable', variable, nullable: false });
    }
    return substitution;
  }

  /** Overloads that differ only in a lambda's result, such as `sumOf`, are chosen by the type the lambda returns. */
  // code-gauge-allow functionCognitiveComplexity -- candidates use inferred results and expected results in resolution order.
  // code-gauge-allow functionNcss -- parameter compatibility and the resulting overload decision are one inference step.
  private chooseByLambdaResult(
    attempts: Attempt[],
    args: ArgumentSyntax[],
    scope: Scope,
    context: FunctionContext
  ): Attempt | undefined {
    if (!attempts.some(({ candidate }) => candidate.symbol.resolvesByLambdaResult)) return undefined;
    const lambdaArgs = args.filter((argument) => isLambdaArgument(argument.value));
    if (lambdaArgs.length !== 1) return undefined;
    const lambdaIndex = args.indexOf(lambdaArgs[0]);
    // The lambda's parameter types are fixed before it is compiled to probe its result, which would otherwise add bounds.
    const lambdaTypes = attempts.map((attempt) => {
      const paramIndex = attempt.mapping.findIndex((indexes) => indexes.includes(lambdaIndex));
      const type = substitute(attempt.candidate.symbol.params[paramIndex].type, attempt.substitution);
      return this.lambdaTypeFor(type, attempt) ?? resolved(type);
    });
    const first = lambdaTypes[0];
    if (first.kind !== 'function' || !lambdaTypes.every((type) => hasSameLambdaParameters(first, type)))
      return undefined;
    const lambda = args[lambdaIndex].value as LambdaExpression;
    // An inline function's lambda may return from the enclosing function, as `sumOf { if (it < 0) return 0L; ... }` does.
    const isInline = attempts.every(({ candidate, mapping }) => {
      const param = candidate.symbol.params[mapping.findIndex((indexes) => indexes.includes(lambdaIndex))];
      return candidate.symbol.isInline && param?.blocksNonlocalControl !== true;
    });
    const probe = settledResult(this.compileLambdaProbe(scope, context, lambda, first, { isInline }));
    const matching =
      probe === undefined || hasOpenVariables(probe)
        ? []
        : attempts.filter((_, index) => {
            const type = lambdaTypes[index];
            return (
              type.kind === 'function' && !hasOpenVariables(type.returnType) && isExactlyType(probe, type.returnType)
            );
          });
    const fitting =
      matching.length > 0
        ? matching
        : attempts.filter((_, index) => {
            const type = lambdaTypes[index];
            if (type.kind !== 'function' || hasOpenVariables(type.returnType)) return false;
            const result = this.compileLambdaProbe(scope, context, lambda, type, { isInline, useExpectedResult: true });
            return result !== undefined && isSubtype(result, type.returnType);
          });
    if (fitting.length === 1) return fitting[0];
    if (fitting.length === 0 && probe && !hasOpenVariables(probe) && resolved(probe).kind !== 'nothing') {
      const inferred = attempts.filter((_, index) => {
        const type = lambdaTypes[index];
        return type.kind === 'function' && hasOpenVariables(type.returnType);
      });
      if (inferred.length === 1) return inferred[0];
    }
    const unannotated = fitting.filter(({ candidate }) => !candidate.symbol.resolvesByLambdaResult);
    return unannotated.length === 1 ? unannotated[0] : undefined;
  }

  /** The result type a lambda would have with the parameter types of `type`, computed without keeping its code. */
  protected abstract compileLambdaProbe(
    scope: Scope,
    context: FunctionContext,
    lambda: LambdaExpression,
    type: FunctionType,
    options: { isInline: boolean; useExpectedResult?: boolean }
  ): KType | undefined;

  /**
   * Rejects a use of a `private` or `protected` member outside the code that may see it, as kotlinc does. A subclass
   * uses a protected member only through a receiver of the subclass, or through `super`, whose receiver is undefined.
   */
  /** Rejects a use of a member whose opt-in markers, or its class's, the code is not opted in to. */
  protected requireMemberOptIn(symbol: FunctionSymbol | PropertySymbol, row: number): void {
    const owner = symbol.owner;
    this.requireOptIn(
      [
        ...symbol.optInMarkers,
        ...(symbol.kind === 'function' && symbol.isConstructor ? (owner?.optInMarkers ?? []) : []),
      ],
      symbol.name,
      row
    );
  }

  protected checkAccessible(
    scope: Scope,
    member: FunctionSymbol | PropertySymbol,
    row: number,
    receiverType: KType | undefined
  ): void {
    this.requireMemberOptIn(member, row);
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
    if (!expected) return;
    const result = substitute(declaredReturn, substitution);
    if (variables.every((variable) => variable.lower.length === 0 && variable.upper.length === 0)) {
      const lower = soleLowerBound(resolved(expected));
      const hint = commonGenericHint(result, lower ?? resolved(expected)) ?? lower;
      if (hint) this.constrainReturnType(result, hint);
    }
    this.constrainReturnType(result, expected);
  }

  private constrainReturnType(result: KType, expected: KType): void {
    if (!hasOpenVariables(result)) return;
    const saved = new Map<InferenceVariable, { lower: KType[]; upper: KType[] }>();
    for (const type of [result, expected]) {
      mentionsVariable(type, (variable) => {
        if (!saved.has(variable))
          saved.set(variable, {
            lower: [...variable.lower],
            upper: [...variable.upper],
          });
        return false;
      });
    }
    if (isSubtype(result, expected)) return;
    for (const [variable, { lower, upper }] of saved) {
      variable.lower = lower;
      variable.upper = upper;
    }
  }

  // code-gauge-allow functionParameterCount -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
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
    this.fixVariables(attempt, row, context.allowOpenCallTypes);
    const evaluateArgs = argumentEvaluator(
      symbol,
      this.argumentEvaluations(attempt, args, compiledArgs as Compiled[]),
      (type) => this.varargArrayFactory(type)
    );
    const callRow = this.recordsSteps && !this.file.isLibrary ? row : undefined;
    const contextEvals = symbol.contextParameters.map((param) => {
      const type = substitute(param.type, substitution);
      const argument = this.contextArgument(scope, context, type, row);
      return convertRepr(argument.eval, argument.repr, reprOf(this.core, type));
    });
    const dispatchEval = candidate.dispatch && this.receiverAccess(context, candidate.dispatch);
    const reifiedTypes = symbol.typeParameters
      .filter((param) => param.isReified)
      .map((param) => substitute({ kind: 'param', param, nullable: false }, substitution));
    if (symbol.isSuspend && !this.file.isLibrary && !allowsSuspendCalls(context))
      this.error(row, `suspend 関数 ${symbol.name} は、suspend 関数かコルーチンの中でだけ呼べます。`);
    if (symbol.isSuspend && !this.file.isLibrary) this.checkRestrictedSuspension(context, symbol, row);
    const call = (frame: Frame, receiver: Value): Value => {
      const { temporaries } = frame;
      const mark = temporaries.length;
      temporaries.push(receiver);
      try {
        if (candidate.kind === 'constructor' && symbol.owner) this.ensureClassInitialized(frame, symbol.owner);
        const values = evaluateArgs(frame);
        for (const evaluate of contextEvals) values.push(evaluate(frame));
        if (dispatchEval) {
          const dispatch = dispatchEval(frame);
          values.push(dispatch);
          if (symbol.passesTypeArguments)
            values.push(reifiedTypes.map((type) => runtimeType(resolved(type), frame)) as unknown as Value);
          for (const value of values) temporaries.push(value);
          const target = isVirtual(symbol) ? runtimeClassOf(dispatch).dispatch(symbol) : symbol;
          return callFunction(target, frame, receiver, values, callRow);
        }
        if (symbol.passesTypeArguments)
          values.push(reifiedTypes.map((type) => runtimeType(resolved(type), frame)) as unknown as Value);
        for (const value of values) temporaries.push(value);
        if (symbol.isSuspend) return suspendCall(symbol, receiver, values, callRow);
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
      firstParameterArg: compiledArgs[attempt.mapping[0]?.[0] ?? -1],
      receiverRepr: receiverRepr(symbol),
      typeArguments,
    };
  }

  protected abstract ensureClassInitialized(frame: Frame, cls: ClassSymbol): void;

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
    if (argument.value.kind === 'reference') {
      const reference = this.compileExpression(scope, context, argument.value, lambdaType ?? elementType);
      if (sam) return this.samWrap(reference, sam, resolved(elementType));
      isSubtype(reference.type, elementType);
      return reference;
    }
    const compiled = this.compileLambda(
      scope,
      context,
      argument.value as LambdaExpression,
      lambdaType,
      symbol.isInline && !param.blocksNonlocalControl && !sam,
      param.invokesExactlyOnce
    );
    if (lambdaType) {
      const bodyType = (resolved(compiled.type) as FunctionType).returnType;
      if (!isNonNullClass(lambdaType.returnType, this.core.unit) && !isSubtype(bodyType, lambdaType.returnType)) {
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
  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private fixVariables({ candidate, substitution, variables }: Attempt, row: number, allowOpen: boolean): void {
    const { symbol } = candidate;
    let pending = variables;
    while (pending.length > 0) {
      let waiting = pending.filter((variable) => !fixVariable(variable));
      if (waiting.length === pending.length)
        waiting = waiting.filter((variable) => !forwardTypeVariable(variable, variables));
      for (const variable of pending) {
        if (!variable.fixed) continue;
        this.checkFixedVariable(symbol.name, variable, row);
        if (waiting.length > 0)
          for (const bound of variable.param.bounds) isSubtype(variable.fixed, substitute(bound, substitution));
      }
      if (waiting.length === pending.length) {
        if (allowOpen) break;
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
  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
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
        // A named argument of a vararg parameter is the whole array, as `*array` spreads one.
        const isSpread = passesArray(args[index], param);
        if (isSpread) {
          const arrayType = this.varargArrayOf(param, paramType);
          if (!this.acceptsArgument(compiled, arrayType))
            this.error(args[index].row, typeMismatchMessage(arrayType, compiled.type));
          return { index, paramIndex, eval: compiled.eval, isSpread };
        }
        if (!this.acceptsArgument(compiled, elementType)) {
          this.error(args[index].row, typeMismatchMessage(elementType, compiled.type));
        }
        const converted = this.convertTo(compiled, elementType, args[index].row);
        const declaredRepr = param.isVararg ? reprOf(this.core, param.type) : reprs[paramIndex];
        const fromRepr = reprOf(this.core, elementType);
        return {
          index,
          paramIndex,
          eval: this.reprConvert(converted, fromRepr, declaredRepr),
          isSpread,
        };
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
      return approximatedReadType(substitute(this.declaredReturnOf(candidate, row), substitution));
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
    for (const variable of variables) {
      if (variable.fixed) continue;
      const refersTo = (candidate: InferenceVariable): boolean => candidate === variable;
      const isInput = inputs.some((input) => mentionsVariable(input, refersTo));
      if (isInput || mentionsVariable(actual.returnType, refersTo))
        constrainThroughBounds(variable, variables, substitution);
      if (isInput) fixVariable(variable);
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

  // code-gauge-allow functionParameterCount -- the scope, the function context, and the parts of the call are each needed, and bundling them would only rename them.
  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
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

  protected probeResultType(
    context: FunctionContext,
    compile: (probe: FunctionContext) => Compiled
  ): KType | undefined {
    let inferred: KType | undefined;
    this.probeApplicability(context, (probe) => {
      inferred = compile(probe).type;
    });
    return inferred;
  }

  protected probeApplicability(
    context: FunctionContext,
    check: (probe: FunctionContext) => void,
    inline = false
  ): CompileError | undefined {
    const savedFlow = this.flow;
    const probe = this.probeContext(context);
    probe.inlineLambda = inline;
    this.flow = savedFlow.copy();
    try {
      check(probe);
      return undefined;
    } catch (error) {
      if (error instanceof CompileError) return error;
      throw error;
    } finally {
      this.flow = savedFlow;
    }
  }

  /**
   * A context for compiling code only to learn its types, whose code is thrown away. It keeps the function an inline
   * lambda's `return` leaves and the loops its `break` and `continue` may leave, with their jumps not recorded.
   */
  protected probeContext(context: FunctionContext): FunctionContext {
    const returnTarget = context.isLambda ? context.returnTarget : context;
    const probe = new FunctionContext(context, true, '<probe>', context.info.isLibrary, returnTarget, true);
    probe.loops = context.loops.map((loop) => ({ ...loop, breaks: [], continues: [], valWrites: new Map() }));
    return probe;
  }
}

function hasSameLambdaParameters(first: FunctionType, second: KType): boolean {
  if (second.kind !== 'function' || first.params.length !== second.params.length) return false;
  const { receiver } = first;
  const sameReceiver =
    receiver && second.receiver ? isSameType(receiver, second.receiver) : receiver === second.receiver;
  return sameReceiver && first.params.every((param, index) => isSameType(param, second.params[index]));
}

function forwardTypeVariable(variable: InferenceVariable, owned: readonly InferenceVariable[]): boolean {
  if (variable.param.isReified) return false;
  const upper = variable.upper.map(resolved);
  const target = upper.find((type) => type.kind === 'variable' && !owned.includes(type.variable));
  if (!target || target.kind !== 'variable') return false;
  if (upper.some((type) => type.kind !== 'variable' || type.variable !== target.variable)) return false;
  variable.fixed = target;
  return true;
}

function containsBareCall(expression: Expression): boolean {
  switch (expression.kind) {
    case 'call': {
      return isBareCallExpression(expression) || expression.args.some(({ value }) => containsBareCall(value));
    }
    case 'infix':
    case 'binary': {
      return containsBareCall(expression.left) || containsBareCall(expression.right);
    }
    default: {
      return false;
    }
  }
}

function nominalBoundsFit(variable: InferenceVariable, substitution: Substitution): boolean {
  const hint = variable.fixed ?? soleLowerBound({ kind: 'variable', nullable: false, variable });
  if (!hint || hint.kind !== 'class') return true;
  return variable.param.bounds.every((declared) => {
    const bound = resolved(substitute(declared, substitution));
    return bound.kind !== 'class' || asSuper(hint, bound.cls) !== undefined;
  });
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
  checkingApplicability?: boolean;
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
