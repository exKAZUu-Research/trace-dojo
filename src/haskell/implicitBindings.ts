import { compileError, unsupportedError } from './errors';
import type { Decl, Expr, Guard, GuardedExpr, Pat, Rhs, Span, Stmt } from './syntax';

export interface ImplicitBind {
  name: string;
  expr: Expr;
  span: Span;
}

/**
 * The implicit-parameter groups of `let` statements and guards, which scope over what follows them; the converter
 * marks them here and lowers them, before anything else sees them, into `let ?x = e in ...` around what follows.
 */
const implicitGroups = new WeakMap<Stmt | Guard, ImplicitBind[]>();

export function implicitStmt(binds: ImplicitBind[], span: Span): Stmt {
  const stmt: Stmt = { kind: 'let', decls: [], span };
  implicitGroups.set(stmt, binds);
  return stmt;
}

export function implicitGuard(binds: ImplicitBind[], span: Span): Guard {
  const guard: Guard = { kind: 'let', decls: [], span };
  implicitGroups.set(guard, binds);
  return guard;
}

export function lowerImplicitStmts(stmts: Stmt[], what: 'do' | 'mdo' | 'rec' | 'qualifiedDo'): Stmt[] {
  const index = stmts.findIndex((stmt) => implicitGroups.has(stmt));
  if (index === -1) return stmts;
  const stmt = stmts[index];
  if (what !== 'do') {
    const place = { mdo: 'mdo', rec: 'rec', qualifiedDo: '修飾つきの do' }[what];
    throw unsupportedError(stmt.span, `${place} の中の暗黙のパラメータの束縛`);
  }
  const rest = stmts.slice(index + 1);
  if (rest.length === 0) throw compileError(stmt.span, 'do の最後の文は、式にしてください。');
  const body: Expr = { kind: 'do', stmts: lowerImplicitStmts(rest, what), span: stmt.span };
  return [...stmts.slice(0, index), { kind: 'exp', expr: implicitLet(stmt, body), span: stmt.span }];
}

/**
 * A comprehension whose qualifiers bind implicit parameters: `[e | qs, let ?x = v, rs]` is
 * `[r | qs, r <- let ?x = v in [e | rs]]`, the same in a list or any monad.
 */
export function lowerImplicitComprehension(expr: Extract<Expr, { kind: 'comprehension' }>): Expr {
  const branches = [expr.quals, ...(expr.parallel ?? [])];
  const marked = branches.flat().find((stmt) => implicitGroups.has(stmt));
  if (!marked) return expr;
  if (expr.parallel || expr.quals.some((stmt) => stmt.kind === 'transform')) {
    throw unsupportedError(marked.span, '並列の内包表記や then と一緒の、暗黙のパラメータの束縛');
  }
  const index = expr.quals.indexOf(marked);
  const result = ` implicit${index}`;
  const inner = lowerImplicitComprehension({ ...expr, quals: expr.quals.slice(index + 1) });
  const bind: Stmt = {
    kind: 'bind',
    pat: { kind: 'pvar', name: { name: result, span: marked.span }, span: marked.span },
    expr: implicitLet(marked, inner),
    span: marked.span,
  };
  return {
    ...expr,
    expr: { kind: 'var', name: { name: result, span: expr.span }, span: expr.span },
    quals: [...expr.quals.slice(0, index), bind],
  };
}

/**
 * A right-hand side whose `where` binds implicit parameters, which scope over its guards and bodies: each value is a
 * `where` binding, shared by every guard that reads it, which the implicit bindings name.
 */
export function withImplicitWhere(rhs: Rhs, binds: ImplicitBind[]): Rhs {
  // A lazy pattern, which Strict leaves lazy, as GHC leaves the implicit binding it stands for.
  const values: Decl[] = binds.map((bind) => ({
    kind: 'patBind',
    pat: {
      kind: 'plazy',
      pat: { kind: 'pvar', name: { name: ` implicit ${bind.name}`, span: bind.span }, span: bind.span },
      span: bind.span,
    },
    rhs: { body: { kind: 'plain', expr: bind.expr }, where: [], span: bind.span },
    span: bind.span,
  }));
  const named = binds.map((bind): ImplicitBind => ({
    ...bind,
    expr: { kind: 'var', name: { name: ` implicit ${bind.name}`, span: bind.span }, span: bind.span },
  }));
  if (rhs.body.kind === 'plain') {
    const expr: Expr = { kind: 'implicitLet', binds: named, body: rhs.body.expr, span: rhs.span };
    return { ...rhs, where: values, body: { kind: 'plain', expr } };
  }
  const branches = rhs.body.branches.map((branch) =>
    lowerImplicitGuards({ ...branch, guards: [implicitGuard(named, rhs.span), ...branch.guards] })
  );
  return { ...rhs, where: values, body: { kind: 'guarded', branches } };
}

/**
 * A guarded branch whose guards bind implicit parameters: the guards from the first such binding on become an
 * expression giving the branch's value as a one-element list, or the empty list when a guard fails, which a pattern
 * guard matches, so that the branch still falls through to the next as GHC's does.
 */
export function lowerImplicitGuards(branch: GuardedExpr): GuardedExpr {
  const index = branch.guards.findIndex((guard) => implicitGroups.has(guard));
  if (index === -1) return branch;
  const { span } = branch.guards[index];
  const result = ` implicit${index}`;
  const pattern: Pat = {
    kind: 'plist',
    elems: [{ kind: 'pvar', name: { name: result, span }, span }],
    span,
  };
  return {
    ...branch,
    guards: [
      ...branch.guards.slice(0, index),
      { kind: 'pat', pat: pattern, expr: guardsAsList(branch.guards.slice(index), branch.expr), span },
    ],
    expr: { kind: 'var', name: { name: result, span }, span },
  };
}

function guardsAsList(guards: Guard[], expr: Expr): Expr {
  const { span } = expr;
  if (guards.length === 0) return { kind: 'list', elems: [expr], span };
  const [guard, ...rest] = guards;
  const next = guardsAsList(rest, expr);
  const none: Expr = { kind: 'list', elems: [], span: guard.span };
  switch (guard.kind) {
    case 'bool': {
      return { kind: 'if', cond: guard.expr, ifTrue: next, ifFalse: none, span: guard.span };
    }
    case 'pat': {
      const plain = (body: Expr): Rhs => ({ body: { kind: 'plain', expr: body }, where: [], span: guard.span });
      return {
        kind: 'case',
        scrutinee: guard.expr,
        alts: [
          { pat: guard.pat, rhs: plain(next), span: guard.span },
          { pat: { kind: 'pwild', span: guard.span }, rhs: plain(none), span: guard.span },
        ],
        span: guard.span,
      };
    }
    case 'let': {
      return implicitGroups.has(guard)
        ? implicitLet(guard, next)
        : { kind: 'let', decls: guard.decls, body: next, span: guard.span };
    }
    default: {
      return guard satisfies never;
    }
  }
}

function implicitLet(marked: Stmt | Guard, body: Expr): Expr {
  return { kind: 'implicitLet', binds: implicitGroups.get(marked) as ImplicitBind[], body, span: marked.span };
}
