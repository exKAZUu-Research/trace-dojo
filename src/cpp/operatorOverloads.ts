import { CompileError } from '../interpreter/diagnostics';
import { compareSequences, type ConversionSequence, Rank } from './conversions';
import { constantExpr, type Expr } from './expr';
import type { ExpressionCompiler } from './expressionCompiler';
import type { MatchingOverload } from './objectCompiler';
import { type ClassInfo, type FunctionInfo, INT, type Type } from './types';

/** The operators C++ requires to be member functions (C++20 [over.oper]). */
const MEMBER_ONLY = new Set(['=', '()', '[]', '->']);

/** A candidate of an overloaded operator, with the conversions of every operand, the object's first for a member. */
interface Candidate {
  match: MatchingOverload;
  isMember: boolean;
  sequences: (ConversionSequence | undefined)[];
}

/**
 * Calls the operator function the program declares for `operands` (C++20 [over.match.oper]): a member of the first
 * operand's class or a non-member function. Undefined when no operand has a class or enumeration type, or when no
 * declared operator function takes the operands; `isExact` tells whether the call needs no user-defined conversion.
 */
export function overloadedOperator(
  compiler: ExpressionCompiler,
  symbol: string,
  operands: Expr[],
  row: number,
  isPostfix = false
): { expr: Expr; isExact: boolean } | undefined {
  if (!operands.some((operand) => hasUserType(operand.type))) return undefined;
  const name = `operator${symbol}`;
  const [first, ...rest] = operands;
  const extra: Expr[] = isPostfix ? [constantExpr(INT, 0, row)] : [];
  const candidates: Candidate[] = [];
  const memberClass = first.type.kind === 'class' && !first.type.cls.library ? first.type.cls : undefined;
  if (memberClass) {
    const members = memberOperators(memberClass, name);
    for (const match of compiler.matchingOverloads(members, [...rest, ...extra], first)) {
      candidates.push({ match, isMember: true, sequences: [match.objectConversion, ...match.conversions] });
    }
  }
  if (!MEMBER_ONLY.has(symbol)) {
    const nonMembers = compiler.nonMemberOperators(name, operands);
    for (const match of compiler.matchingOverloads(nonMembers, [...operands, ...extra])) {
      candidates.push({ match, isMember: false, sequences: match.conversions });
    }
  }
  if (candidates.length === 0) return undefined;
  const best = bestCandidate(candidates);
  if (!best)
    return compiler.error(row, `演算子 ${symbol} の呼び出しに合うものが複数あり、どれを呼ぶのか決まりません。`);
  const { fn } = best.match;
  const isExact = best.sequences.every((sequence) => !sequence || sequence.rank < Rank.UserDefined);
  if (fn.isDeleted) compiler.error(row, `削除された関数 ${fn.displayName} は呼び出せません。`);
  compiler.checkDefined(fn, row);
  if (best.isMember) {
    if (fn.owner && !fn.native)
      compiler.checkAccess(fn.access, fn.owner, memberClass as ClassInfo, row, fn.name, memberClass);
    return { expr: compiler.callExpr(best.match, [...rest, ...extra], first, row), isExact };
  }
  return { expr: compiler.callExpr(best.match, [...operands, ...extra], undefined, row), isExact };
}

/** The member operator functions named `name` that a class declares or inherits, as name lookup finds them. */
export function memberOperators(cls: ClassInfo, name: string): FunctionInfo[] {
  for (let current: ClassInfo | undefined = cls; current; current = current.base) {
    const methods = current.methods.get(name);
    if (methods) return methods;
  }
  return [];
}

/** Whether a value of a type may pick an operator function the program declares: a class or an enumeration. */
export function hasUserType(type: Type): boolean {
  return type.kind === 'class' || (type.kind === 'int' && type.enumeration !== undefined);
}

function bestCandidate(candidates: Candidate[]): Candidate | undefined {
  const compare = (a: Candidate, b: Candidate): number => {
    let aBetter = false;
    let bBetter = false;
    for (const [index, left] of a.sequences.entries()) {
      const right = b.sequences[index];
      if (!left || !right) continue;
      const order = compareSequences(left, right);
      if (order > 0) aBetter = true;
      if (order < 0) bBetter = true;
    }
    if (aBetter !== bBetter) return aBetter ? 1 : -1;
    if (aBetter) return 0;
    if (a.match.fn.isTemplate !== b.match.fn.isTemplate) return a.match.fn.isTemplate ? -1 : 1;
    return Math.sign((a.match.fn.templateSpecificity ?? 0) - (b.match.fn.templateSpecificity ?? 0));
  };
  let best: Candidate | undefined;
  for (const candidate of candidates) if (!best || compare(candidate, best) > 0) best = candidate;
  if (!best) return undefined;
  const found = best;
  return candidates.every((other) => other === found || compare(found, other) > 0) ? found : undefined;
}

/**
 * Applies an operator with the operator functions the program declares and the library's or the built-in one,
 * preferring a declared function that takes the operands without a user-defined conversion.
 */
export function withOverloads(
  compiler: ExpressionCompiler,
  symbol: string,
  operands: Expr[],
  row: number,
  builtin: () => Expr,
  isPostfix = false
): Expr {
  const overloaded = overloadedOperator(compiler, symbol, operands, row, isPostfix);
  if (!overloaded) return builtin();
  if (overloaded.isExact) return overloaded.expr;
  try {
    return builtin();
  } catch (error) {
    if (error instanceof CompileError) return overloaded.expr;
    throw error;
  }
}
