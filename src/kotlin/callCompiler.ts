import type { Expression, LambdaExpression } from './ast';
import { type Compiled, type Eval, FunctionContext, reprOf, type Scope, typeMismatchMessage } from './compilerBase';
import { CompilerCore } from './compilerCore';
import { callFunction, parameterReprs, receiverRepr, returnRepr } from './dispatch';
import { type Frame, MISSING } from './runtime';
import type { ClassSymbol, FunctionSymbol, ParameterSymbol, TypeParameterSymbol } from './symbols';
import { checkVariableBounds, fixVariable, isSubtype } from './typeRelations';
import {
  type FunctionType,
  hasOpenVariables,
  type InferenceVariable,
  isNullable,
  type KType,
  nullable,
  resolved,
  substitute,
  type Substitution,
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
}

interface Attempt {
  candidate: Candidate;
  variables: InferenceVariable[];
  substitution: Map<TypeParameterSymbol, KType>;
  /** The arguments of each parameter, by their indexes among the call's arguments. */
  mapping: number[][];
}

/** The parameters each argument goes to, or `undefined` when the arguments do not fit the parameters. */
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
      const target = resolved(type);
      if (target.kind === 'class' && this.literalFits(compiled.integerLiteral, target.cls.name)) return true;
    }
    return isSubtype(compiled.type, type);
  }

  /** Whether an integer literal's value fits the integer class `className`, to which it may convert. */
  protected literalFits(literal: NonNullable<Compiled['integerLiteral']>, className: string): boolean {
    const { value, isUnsigned, isLong } = literal;
    const ranges: Record<string, [bigint, bigint, boolean]> = {
      Byte: [-128n, 127n, false],
      Short: [-32_768n, 32_767n, false],
      Int: [-(2n ** 31n), 2n ** 31n - 1n, false],
      Long: [-(2n ** 63n), 2n ** 63n - 1n, false],
      UByte: [0n, 255n, true],
      UShort: [0n, 65_535n, true],
      UInt: [0n, 2n ** 32n - 1n, true],
      ULong: [0n, 2n ** 64n - 1n, true],
    };
    const range = ranges[className];
    if (!range || range[2] !== isUnsigned) return false;
    if (isLong && className !== 'Long' && className !== 'ULong') return false;
    return value >= range[0] && value <= range[1];
  }

  /**
   * Resolves a call among candidate levels, the nearest first: the first level with an applicable candidate decides,
   * as Kotlin's resolution goes from inner scopes to outer ones.
   */
  // code-gauge-allow functionCognitiveComplexity 30 -- The steps of Kotlin's overload resolution.
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
    // A lone candidate gives its parameter types to the arguments, which literals and nested generic calls need.
    const lone = all.length === 1 ? all[0] : undefined;
    let loneAttempt: Attempt | undefined;
    if (lone) {
      loneAttempt = this.startAttempt(lone, args, hasTrailingLambda, explicitTypeArgs, row);
      if (!loneAttempt) this.reportUnmappable(lone, args, hasTrailingLambda, row, name);
      // The receiver constrains the variables first, so that the arguments see the types it gives them.
      const loneReceiver = receiverOf(lone);
      if (lone.symbol.extensionReceiver && loneReceiver) {
        isSubtype(loneReceiver.type, substitute(lone.symbol.extensionReceiver, loneAttempt.substitution));
      }
    }
    const compiledArgs = args.map((argument, index): Compiled | undefined => {
      if (isLambdaArgument(argument.value)) return undefined;
      let expectedType: KType | undefined;
      if (loneAttempt) {
        const paramIndex = loneAttempt.mapping.findIndex((indexes) => indexes.includes(index));
        const param = loneAttempt.candidate.symbol.params[paramIndex];
        if (param) expectedType = substitute(param.type, loneAttempt.substitution);
      }
      return this.compileExpression(scope, context, argument.value, expectedType);
    });
    let chosen: Attempt | undefined;
    for (const level of levels) {
      const applicable = level.flatMap((candidate) => {
        const attempt =
          candidate === lone
            ? loneAttempt
            : this.startAttempt(candidate, args, hasTrailingLambda, explicitTypeArgs, row);
        if (!attempt) return [];
        return this.isApplicable(attempt, args, compiledArgs, receiverOf(candidate)) ? [attempt] : [];
      });
      if (applicable.length === 0) continue;
      chosen =
        applicable.length === 1
          ? applicable[0]
          : this.mostSpecific(applicable, compiledArgs, args, scope, context, row, name);
      break;
    }
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
    return this.completeCall(scope, context, chosen, args, compiledArgs, expected, row);
  }

  private startAttempt(
    candidate: Candidate,
    args: ArgumentSyntax[],
    hasTrailingLambda: boolean,
    explicitTypeArgs: KType[],
    row: number
  ): Attempt | undefined {
    const { symbol } = candidate;
    const mapping = mapArguments(symbol.params, args, hasTrailingLambda);
    if (!mapping) return undefined;
    const substitution = new Map(candidate.substitution);
    const typeParameters = this.inferredTypeParameters(candidate);
    const variables: InferenceVariable[] = [];
    if (explicitTypeArgs.length > 0) {
      if (explicitTypeArgs.length !== typeParameters.length) {
        this.error(row, `${symbol.name} の型引数の数が違います。`);
      }
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
    return { candidate, variables, substitution, mapping };
  }

  /** The type parameters a call infers: the function's, and for a constructor its class's. */
  private inferredTypeParameters(candidate: Candidate): TypeParameterSymbol[] {
    const { symbol } = candidate;
    if (candidate.kind === 'constructor' && symbol.owner)
      return [...symbol.owner.typeParameters, ...symbol.typeParameters];
    return symbol.typeParameters;
  }

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
    for (const [paramIndex, indexes] of attempt.mapping.entries()) {
      const param = symbol.params[paramIndex];
      const paramType = substitute(param.type, attempt.substitution);
      for (const index of indexes) {
        const compiled = compiledArgs[index];
        if (!compiled) {
          if (!this.lambdaFits(args[index].value as LambdaExpression, paramType)) return false;
          continue;
        }
        if (args[index].isSpread) continue;
        if (!this.acceptsArgument(compiled, param.isVararg ? this.varargElementType(paramType) : paramType))
          return false;
      }
    }
    for (const variable of attempt.variables) {
      const copy: InferenceVariable = {
        ...variable,
        lower: [...variable.lower],
        upper: [...variable.upper],
        fixed: undefined,
      };
      fixVariable(copy);
      if (!checkVariableBounds(copy)) return false;
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

  // code-gauge-allow functionNcss 40 -- Kotlin's choice of the most specific overload, then by lambda result.
  private mostSpecific(
    attempts: Attempt[],
    compiledArgs: (Compiled | undefined)[],
    args: ArgumentSyntax[],
    scope: Scope,
    context: FunctionContext,
    row: number,
    name: string
  ): Attempt {
    const paramTypeOf = (attempt: Attempt, argIndex: number): KType | undefined => {
      const paramIndex = attempt.mapping.findIndex((indexes) => indexes.includes(argIndex));
      const param = attempt.candidate.symbol.params[paramIndex];
      return param ? param.type : undefined;
    };
    const isAsSpecific = (a: Attempt, b: Attempt): boolean => {
      for (const [index] of args.entries()) {
        const aType = paramTypeOf(a, index);
        const bType = paramTypeOf(b, index);
        const compiled = compiledArgs[index];
        if (!aType || !bType || !compiled) continue;
        // An integer literal is an Int unless only another integer type fits, as `1..4` calls `rangeTo(Int)`.
        if (compiled.integerLiteral) {
          const literalType = compiled.type;
          const aIsLiteral = isSubtype(literalType, substitute(aType, a.substitution));
          const bIsLiteral = isSubtype(literalType, substitute(bType, b.substitution));
          if (aIsLiteral !== bIsLiteral) {
            if (!aIsLiteral) return false;
            continue;
          }
        }
        if (!isSubtype(substitute(aType, a.substitution), substitute(bType, b.substitution))) return false;
      }
      const aReceiver = a.candidate.symbol.extensionReceiver;
      const bReceiver = b.candidate.symbol.extensionReceiver;
      return (
        !aReceiver ||
        !bReceiver ||
        isSubtype(substitute(aReceiver, a.substitution), substitute(bReceiver, b.substitution))
      );
    };
    let best = attempts.filter((attempt) =>
      attempts.every((other) => other === attempt || isAsSpecific(attempt, other))
    );
    if (best.length > 1) {
      // Without a vararg or default parameter left unused, a candidate is more specific.
      const unused = (attempt: Attempt): number =>
        attempt.mapping.filter(
          (indexes, index) => indexes.length === 0 && attempt.candidate.symbol.params[index].hasDefault
        ).length + (attempt.candidate.symbol.params.some((param) => param.isVararg) ? 1 : 0);
      const fewest = Math.min(...best.map(unused));
      best = best.filter((attempt) => unused(attempt) === fewest);
    }
    if (best.length === 1) return best[0];
    const byLambda = this.chooseByLambdaResult(best.length > 0 ? best : attempts, args, scope, context);
    if (byLambda) return byLambda;
    if (best.length > 1 && best.every((attempt) => attempt.candidate.symbol.isLibrary)) return best[0];
    return this.error(row, `${name} の呼び出しが、どの関数のことか決められません。`);
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
      return this.lambdaTypeFor(type, attempt.variables) ?? resolved(type);
    });
    const first = lambdaTypes[0];
    if (first.kind !== 'function') return undefined;
    const probe = this.compileLambdaProbe(scope, context, args[lambdaIndex].value as LambdaExpression, first);
    if (!probe) return undefined;
    const fitting = attempts.filter((_, index) => {
      const type = lambdaTypes[index];
      return type.kind === 'function' && isExactlyType(probe, resolved(type.returnType));
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

  // code-gauge-allow functionNcss 80 -- Finishes inference and builds the evaluation of the arguments.
  // code-gauge-allow functionCognitiveComplexity 30 -- Finishes inference and builds the evaluation of the arguments.
  private completeCall(
    scope: Scope,
    context: FunctionContext,
    attempt: Attempt,
    args: ArgumentSyntax[],
    compiledArgs: (Compiled | undefined)[],
    expected: KType | undefined,
    row: number
  ): ResolvedCall {
    const { candidate, substitution, variables, mapping } = attempt;
    const { symbol } = candidate;
    // A constructor's result is its class with the class's type parameters, which the expected type may infer.
    const declaredReturn =
      candidate.kind === 'constructor' && symbol.owner
        ? symbol.owner.selfType
        : (symbol.returnType ?? this.core.unit.type);
    // The expected type constrains the variables only where the result's type mentions them.
    if (expected && hasOpenVariables(substitute(declaredReturn, substitution))) {
      const saved = variables.map((variable) => ({ lower: [...variable.lower], upper: [...variable.upper] }));
      if (!isSubtype(substitute(declaredReturn, substitution), expected)) {
        for (const [index, variable] of variables.entries()) {
          variable.lower = saved[index].lower;
          variable.upper = saved[index].upper;
        }
      }
    }
    const argumentEvals: { index: number; paramIndex: number; eval: Eval }[] = [];
    for (const [paramIndex, indexes] of mapping.entries()) {
      const param = symbol.params[paramIndex];
      for (const index of indexes) {
        const paramType = substitute(param.type, substitution);
        const elementType = param.isVararg ? this.varargElementType(paramType) : paramType;
        let compiled = compiledArgs[index];
        if (!compiled) {
          const sam = this.samOf(elementType);
          const lambdaType = this.lambdaTypeFor(sam ? sam.functionType : elementType, variables);
          compiled = this.compileLambda(
            scope,
            context,
            args[index].value as LambdaExpression,
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
              this.error(args[index].row, typeMismatchMessage(lambdaType.returnType, bodyType));
            }
          }
          if (sam) compiled = this.samWrap(compiled, sam, resolved(elementType));
          compiledArgs[index] = compiled;
        }
        argumentEvals.push({ index, paramIndex, eval: (frame) => compiled.eval(frame) });
      }
    }
    for (const variable of variables) {
      const fixed = fixVariable(variable);
      if (!fixed) this.error(row, `型引数 ${variable.param.name} を推論できません。型を書いてください。`);
      if (!checkVariableBounds(variable))
        this.error(row, `${symbol.name} の型引数 ${variable.param.name} に合う型がありません。`);
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
    // Arguments convert to the parameters' declared representations, now that the types are known.
    const reprs = parameterReprs(symbol);
    const finalEvals = argumentEvals.map(({ index, paramIndex, eval: _eval }) => {
      const param = symbol.params[paramIndex];
      const compiled = compiledArgs[index] as Compiled;
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
    });
    finalEvals.sort((a, b) => a.index - b.index);
    const paramCount = symbol.params.length;
    const varargIndex = symbol.params.findIndex((param) => param.isVararg);
    const varargArray = varargIndex === -1 ? undefined : this.varargArrayFactory(symbol.params[varargIndex].type);
    const callRow = this.recordsSteps && !this.file.isLibrary ? row : undefined;
    const evaluateArgs = (frame: Frame): Value[] => {
      const values: Value[] = Array.from({ length: paramCount }, () => MISSING);
      const varargs: Value[] = [];
      const { temporaries } = frame;
      const mark = temporaries.length;
      try {
        for (const { paramIndex, eval: evaluate, isSpread } of finalEvals) {
          const value = evaluate(frame);
          temporaries.push(value);
          if (isSpread) varargs.push(...((value as KObject).items as Value[]));
          else if (paramIndex === varargIndex) varargs.push(value);
          else values[paramIndex] = value;
        }
        if (varargArray) values[varargIndex] = varargArray(frame, varargs);
        return values;
      } finally {
        temporaries.length = mark;
      }
    };
    const call = (frame: Frame, receiver: Value): Value => {
      const { temporaries } = frame;
      const mark = temporaries.length;
      temporaries.push(receiver);
      try {
        const values = evaluateArgs(frame);
        temporaries.push(...values);
        return callFunction(symbol, frame, receiver, values, callRow);
      } finally {
        temporaries.length = mark;
      }
    };
    const type = resolved(substitute(declaredReturn, substitution));
    const typeArguments = new Map<TypeParameterSymbol, KType>();
    for (const param of this.inferredTypeParameters(candidate))
      typeArguments.set(param, resolved(substitution.get(param) as KType));
    return {
      symbol,
      candidate,
      type:
        candidate.kind === 'constructor' && symbol.owner
          ? {
              kind: 'class',
              cls: symbol.owner,
              args: symbol.owner.typeParameters.map((param) => ({
                variance: 'inv' as const,
                type: typeArguments.get(param) as KType,
              })),
              nullable: false,
            }
          : type,
      repr: candidate.kind === 'constructor' ? 'ref' : returnRepr(symbol),
      call,
      evaluateArgs,
      callRow,
      receiverRepr: receiverRepr(symbol),
      typeArguments,
    };
  }

  protected abstract reprConvert(eval_: Eval, from: ReturnType<typeof reprOf>, to: ReturnType<typeof reprOf>): Eval;

  /** Creates the array a `vararg` parameter receives from the arguments it collects. */
  protected abstract varargArrayFactory(elementType: KType): (frame: Frame, values: Value[]) => KObject;

  /** The function type a lambda argument is checked against, fixing the variables its parameters need. */
  private lambdaTypeFor(type: KType, variables: InferenceVariable[]): FunctionType | undefined {
    const actual = resolved(type);
    if (actual.kind !== 'function') return undefined;
    const inputs = actual.receiver ? [actual.receiver, ...actual.params] : actual.params;
    for (const input of inputs) {
      for (const variable of variables) {
        if (!variable.fixed && mentions(input, variable)) fixVariable(variable);
      }
    }
    return resolved(actual) as FunctionType;
  }

  private reportUnmappable(
    candidate: Candidate,
    args: ArgumentSyntax[],
    hasTrailingLambda: boolean,
    row: number,
    name: string
  ): never {
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
      const attempt = this.startAttempt(all[0], args, hasTrailingLambda, explicitTypeArgs, row);
      if (!attempt) return this.reportUnmappable(all[0], args, hasTrailingLambda, row, name);
      const { symbol } = all[0];
      if (symbol.extensionReceiver && receiver) {
        const receiverType = substitute(symbol.extensionReceiver, attempt.substitution);
        if (!isSubtype(receiver.type, receiverType)) {
          if (isNullable(resolved(receiver.type)) && isSubtype(receiver.type, nullable(receiverType))) {
            this.error(
              row,
              `null かもしれない ${typeToString(resolved(receiver.type))} の値には、?. か !! を使ってください。`
            );
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

function mentions(type: KType, variable: InferenceVariable): boolean {
  switch (type.kind) {
    case 'variable': {
      return (
        type.variable === variable || (type.variable.fixed !== undefined && mentions(type.variable.fixed, variable))
      );
    }
    case 'class': {
      return type.args.some((argument) => argument.variance !== 'star' && mentions(argument.type, variable));
    }
    case 'function': {
      return (
        (type.receiver !== undefined && mentions(type.receiver, variable)) ||
        type.params.some((param) => mentions(param, variable)) ||
        mentions(type.returnType, variable)
      );
    }
    default: {
      return false;
    }
  }
}

function isExactlyType(a: KType, b: KType): boolean {
  const left = resolved(a);
  const right = resolved(b);
  if (left.kind === 'class' && right.kind === 'class')
    return left.cls === right.cls && left.nullable === right.nullable;
  return isSubtype(left, right) && isSubtype(right, left);
}

export { KObject };
