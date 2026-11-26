import type { LocalVar, RBinding, RExpr, RPat, RRhs, RStmt } from './rast';

/**
 * The nodes directly inside a node, by kind, each kind in source order. The statements of a `do` or a comprehension
 * are not nodes of their own: their children are the block's.
 */
export interface RChildren {
  exprs: readonly RExpr[];
  pats: readonly RPat[];
  bindings: readonly RBinding[];
  rhss: readonly RRhs[];
}

const NONE: RChildren = { exprs: [], pats: [], bindings: [], rhss: [] };

// code-gauge-allow functionNcss -- One short case per expression kind.
export function rexprChildren(expr: RExpr): RChildren {
  switch (expr.k) {
    case 'var':
    case 'con':
    case 'lit':
    case 'hole':
    case 'implicit': {
      return NONE;
    }
    case 'app': {
      return { ...NONE, exprs: [expr.fn, expr.arg] };
    }
    case 'lambda': {
      return { ...NONE, exprs: [expr.body], pats: expr.pats };
    }
    case 'let': {
      return { ...NONE, exprs: [expr.body], bindings: expr.binds.bindings };
    }
    case 'if': {
      return { ...NONE, exprs: [expr.cond, expr.ifTrue, expr.ifFalse] };
    }
    case 'case': {
      return {
        ...NONE,
        exprs: [expr.scrutinee],
        pats: expr.alts.map((alt) => alt.pat),
        rhss: expr.alts.map((alt) => alt.rhs),
      };
    }
    case 'do': {
      return stmtsChildren(expr.stmts, []);
    }
    case 'comp': {
      return stmtsChildren(expr.quals, [expr.expr]);
    }
    case 'tuple':
    case 'list': {
      return { ...NONE, exprs: expr.elems };
    }
    case 'arith': {
      return { ...NONE, exprs: [expr.from, expr.next, expr.to].filter((part): part is RExpr => part !== undefined) };
    }
    case 'rsection': {
      return { ...NONE, exprs: [expr.op, expr.right] };
    }
    case 'typed':
    case 'tyapp':
    case 'projection':
    case 'poly': {
      return { ...NONE, exprs: [expr.expr] };
    }
    case 'implicitLet': {
      return { ...NONE, exprs: [...expr.binds.map((bind) => bind.expr), expr.body] };
    }
    case 'recordCon': {
      return { ...NONE, exprs: expr.fields.map((field) => field.value) };
    }
    case 'recordUpdate': {
      return { ...NONE, exprs: [expr.expr, ...expr.fields.map((field) => field.value)] };
    }
    default: {
      return expr satisfies never;
    }
  }
}

function stmtsChildren(stmts: readonly RStmt[], after: RExpr[]): RChildren {
  const children = stmts.map((stmt) => rstmtChildren(stmt));
  return {
    exprs: [...children.flatMap((child) => child.exprs), ...after],
    pats: children.flatMap((child) => child.pats),
    bindings: children.flatMap((child) => child.bindings),
    rhss: [],
  };
}

export function rstmtChildren(stmt: RStmt): RChildren {
  switch (stmt.k) {
    case 'bind': {
      return { ...NONE, exprs: [stmt.expr], pats: [stmt.pat] };
    }
    case 'let': {
      return { ...NONE, bindings: stmt.binds.bindings };
    }
    case 'exp': {
      return { ...NONE, exprs: [stmt.expr] };
    }
    default: {
      return stmt satisfies never;
    }
  }
}

export function rpatChildren(pat: RPat): RChildren {
  switch (pat.k) {
    case 'var':
    case 'wild':
    case 'lit': {
      return NONE;
    }
    case 'con': {
      return { ...NONE, pats: pat.args };
    }
    case 'as':
    case 'bang':
    case 'lazy':
    case 'sig': {
      return { ...NONE, pats: [pat.pat] };
    }
    case 'view': {
      return { ...NONE, exprs: [pat.expr], pats: [pat.pat] };
    }
    case 'or': {
      return { ...NONE, pats: pat.alts };
    }
    default: {
      return pat satisfies never;
    }
  }
}

/** The variables a pattern binds, in order. */
export function rpatLocals(pat: RPat): LocalVar[] {
  const result: LocalVar[] = [];
  const pending = [pat];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.k === 'var' || current.k === 'as') result.push(current.local);
    pending.push(...rpatChildren(current).pats.toReversed());
  }
  return result;
}
