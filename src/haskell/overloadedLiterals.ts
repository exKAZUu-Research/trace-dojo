import type { Expr, Pat, SourceLiteral } from './syntax';

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

/** A string literal under OverloadedStrings, `fromString "..."`, whatever string type its context wants. */
export function overloadedString(literal: Extract<Expr, { kind: 'lit' }>): Expr {
  const { span } = literal;
  return { kind: 'app', fn: { kind: 'support', name: 'overloadedFromString', span }, arg: literal, span };
}

/** A string literal pattern under OverloadedStrings, which GHC matches by `==` with the literal at the pattern's type. */
export function overloadedStringPattern(lit: SourceLiteral, span: Extract<Pat, { kind: 'plit' }>['span']): Pat {
  return {
    kind: 'pview',
    expr: {
      kind: 'app',
      fn: { kind: 'support', name: 'overloadedStringEq', span },
      arg: { kind: 'lit', lit, span },
      span,
    },
    exprText: '==',
    pat: { kind: 'pcon', con: { name: 'True', span }, args: [], span },
    written: { kind: 'plit', lit, negative: false, span },
    span,
  };
}
