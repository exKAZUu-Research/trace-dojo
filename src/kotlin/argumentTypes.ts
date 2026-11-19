import type { Expression } from './ast';
import { type Compiled, type Eval, isBareCallExpression } from './compilerBase';
import { type Frame, MISSING } from './runtime';
import type { FunctionSymbol } from './symbols';
import { branchHint, isSameType, withDeterminedVariables } from './typeRelations';
import { hasOpenVariables, type KType, substitute, type Substitution } from './types';
import type { KObject, Value } from './values';

/** What the expected type of an argument needs of an attempt to call a candidate. */
interface ArgumentAttempt {
  candidate: { symbol: { params: { type: KType }[] } };
  substitution: Substitution;
  /** The arguments of each parameter, by their indexes among the call's arguments. */
  mapping: number[][];
}

/** The attempts of the first level of candidates where any takes the arguments, as members come before extensions. */
export function firstAttempts<C, A>(levels: C[][], start: (candidate: C) => A | undefined): A[] {
  for (const level of levels) {
    const attempts = level.flatMap((candidate) => start(candidate) ?? []);
    if (attempts.length > 0) return attempts;
  }
  return [];
}

/**
 * The type an argument is compiled against: that of the parameter which takes it in every attempt, when they agree on
 * it. A call without arguments, such as `emptyList()`, takes instead the type of an earlier argument of the same
 * vararg, as `listOf(listOf(1), emptyList())` gives it.
 */
export function expectedArgumentType(
  attempts: ArgumentAttempt[],
  compiledArgs: (Compiled | undefined)[],
  index: number,
  argument: Expression,
  isOverloaded: boolean
): KType | undefined {
  const agreed = agreedParameterType(attempts, index, isOverloaded);
  if (!isBareCallExpression(argument) || (agreed && !hasOpenVariables(agreed))) return agreed;
  const sibling = attempts
    .flatMap(
      (attempt) => attempt.mapping.find((indexes) => indexes.includes(index))?.filter((other) => other < index) ?? []
    )
    .map((other) => compiledArgs[other])
    .findLast((compiled) => compiled !== undefined);
  return (sibling && branchHint(sibling.type, undefined, true)) ?? agreed;
}

/**
 * The type of the parameter that takes an argument in every attempt, when they agree on it, with the variables the
 * receiver and the expected type determine. Several candidates agree only on a type without inference variables, as
 * `add(E)` and `add(Int, E)` of a `MutableList<List<Int>>` do, and `listOf(T)` and `listOf(vararg T)` for `List<Long>`.
 */
function agreedParameterType(
  attempts: ArgumentAttempt[],
  argumentIndex: number,
  isOverloaded: boolean
): KType | undefined {
  let agreed: KType | undefined;
  for (const attempt of attempts) {
    const paramIndex = attempt.mapping.findIndex((indexes) => indexes.includes(argumentIndex));
    const param = attempt.candidate.symbol.params[paramIndex];
    if (!param) return undefined;
    const type = withDeterminedVariables(substitute(param.type, attempt.substitution));
    if (isOverloaded && (hasOpenVariables(type) || (agreed && !isSameType(agreed, type)))) return undefined;
    agreed = type;
  }
  return agreed;
}

/** An argument's evaluation, by its index among the written arguments and the index of the parameter that takes it. */
export interface ArgumentEvaluation {
  index: number;
  paramIndex: number;
  eval: Eval;
  isSpread: boolean;
}

/**
 * Evaluates the arguments in the order they are written into the values the parameters receive, collecting a vararg's
 * values into its array, while the values are held as temporaries for the garbage collector.
 */
export function argumentEvaluator(
  symbol: FunctionSymbol,
  evaluations: ArgumentEvaluation[],
  varargArrayFactory: (type: KType) => (frame: Frame, values: Value[]) => KObject
): (frame: Frame) => Value[] {
  const paramCount = symbol.params.length;
  const varargIndex = symbol.params.findIndex((param) => param.isVararg);
  const varargArray = varargIndex === -1 ? undefined : varargArrayFactory(symbol.params[varargIndex].type);
  return (frame) => {
    const values: Value[] = Array.from({ length: paramCount }, () => MISSING);
    const varargs: Value[] = [];
    const { temporaries } = frame;
    const mark = temporaries.length;
    try {
      for (const { paramIndex, eval: evaluate, isSpread } of evaluations) {
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
}
