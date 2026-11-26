import type { FeatureGates } from './features';
import type { Decl, Expr, Pat, SourceLiteral } from './syntax';
import { LoweringPass } from './syntaxChildren';

/**
 * Overloads the literals OverloadedStrings and OverloadedLists make overloaded: a string literal is `fromString` of
 * it, a list or sequence is `fromListN` or `fromList` of it, and the patterns match through `==` and `toList`.
 */
export function lowerOverloadedLiterals(features: FeatureGates<'convert'>, decls: Decl[]): Decl[] {
  const pass = new OverloadedLiterals(features.allows('overloadedStrings'), features.allows('overloadedLists'));
  return decls.map((decl) => pass.decl(decl));
}

class OverloadedLiterals extends LoweringPass {
  constructor(
    private readonly strings: boolean,
    private readonly lists: boolean
  ) {
    super();
  }

  override expr(expr: Expr): Expr {
    const mapped = super.expr(expr);
    if (mapped.kind === 'lit' && mapped.lit.kind === 'string' && this.strings && !mapped.generated) {
      return overloadedString(mapped);
    }
    if (mapped.kind === 'list' && this.lists) return overloadedList(mapped);
    if (mapped.kind === 'arith' && this.lists) return overloadedSequence(mapped);
    return mapped;
  }

  override pat(pat: Pat): Pat {
    const mapped = super.pat(pat);
    if (mapped.kind === 'plit' && mapped.lit.kind === 'string' && this.strings) {
      return overloadedStringPattern(mapped.lit, mapped.span);
    }
    if (mapped.kind === 'plist' && this.lists) return overloadedListPattern(mapped);
    return mapped;
  }
}

function overloadedList(list: Extract<Expr, { kind: 'list' }>): Expr {
  const { span } = list;
  const count: Expr = { kind: 'lit', lit: { kind: 'int', value: BigInt(list.elems.length) }, span };
  const fromListN: Expr = { kind: 'support', name: 'overloadedFromListN', span };
  return { kind: 'app', fn: { kind: 'app', fn: fromListN, arg: count, span }, arg: list, span };
}

function overloadedSequence(sequence: Extract<Expr, { kind: 'arith' }>): Expr {
  const { span } = sequence;
  return { kind: 'app', fn: { kind: 'support', name: 'overloadedFromList', span }, arg: sequence, span };
}

function overloadedListPattern(list: Extract<Pat, { kind: 'plist' }>): Pat {
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

function overloadedString(literal: Extract<Expr, { kind: 'lit' }>): Expr {
  const { span } = literal;
  return { kind: 'app', fn: { kind: 'support', name: 'overloadedFromString', span }, arg: literal, span };
}

/** A string literal pattern under OverloadedStrings, which GHC matches by `==` with the literal at the pattern's type. */
function overloadedStringPattern(lit: SourceLiteral, span: Extract<Pat, { kind: 'plit' }>['span']): Pat {
  return {
    kind: 'pview',
    expr: {
      kind: 'app',
      fn: { kind: 'support', name: 'overloadedStringEq', span },
      arg: { kind: 'lit', lit, span },
      span,
    },
    exprText: '==',
    pat: {
      kind: 'pcon',
      con: { name: 'True', span, global: { module: 'GHC.Internal.Types', namespace: 'con' } },
      args: [],
      span,
    },
    written: { kind: 'plit', lit, negative: false, span },
    span,
  };
}
