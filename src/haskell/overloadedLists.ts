import type { Expr, Pat } from './syntax';

/** A list literal under OverloadedLists, `fromListN n [..]`, whatever list type its context wants. */
export function overloadedList(list: Extract<Expr, { kind: 'list' }>): Expr {
  const { span } = list;
  const count: Expr = { kind: 'lit', lit: { kind: 'int', value: BigInt(list.elems.length) }, span };
  const fromListN: Expr = { kind: 'support', name: 'overloadedFromListN', span };
  return { kind: 'app', fn: { kind: 'app', fn: fromListN, arg: count, span }, arg: list, span };
}

/** An arithmetic sequence under OverloadedLists, `fromList [a..b]`. */
export function overloadedSequence(sequence: Extract<Expr, { kind: 'arith' }>): Expr {
  const { span } = sequence;
  return { kind: 'app', fn: { kind: 'support', name: 'overloadedFromList', span }, arg: sequence, span };
}

/** A list pattern under OverloadedLists, which matches `toList` of the value. */
export function overloadedListPattern(list: Extract<Pat, { kind: 'plist' }>): Pat {
  const { span } = list;
  return {
    kind: 'pview',
    expr: { kind: 'support', name: 'overloadedToList', span },
    exprText: 'toList',
    pat: list,
    written: list,
    span,
  };
}
