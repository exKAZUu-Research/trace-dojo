import { compileError, unsupportedError } from './errors';
import type { Decl, Expr, Guard, GuardedExpr, ImplicitBind, Pat, Rhs, Span, Stmt } from './syntax';
import { LoweringPass } from './syntaxChildren';

export function implicitStmt(binds: ImplicitBind[], span: Span): Stmt {
  return { kind: 'let', decls: [], span, implicit: binds };
}

export function implicitGuard(binds: ImplicitBind[], span: Span): Guard {
  return { kind: 'let', decls: [], span, implicit: binds };
}

/** Rejects the implicit-parameter bindings of statements whose block (`mdo`, `rec`, a qualified do) cannot scope them. */
export function rejectImplicitStmts(stmts: Stmt[], place: string): void {
  const stmt = stmts.find((candidate) => isImplicit(candidate));
  if (stmt) throw unsupportedError(stmt.span, `${place} の中の暗黙のパラメータの束縛`);
}

/**
 * Lowers the bindings of implicit parameters in `where`s, guards, do blocks, and comprehensions into `let ?x = e in`
 * expressions around what each scopes over.
 */
export function lowerImplicitParams(decls: Decl[]): Decl[] {
  const pass = new ImplicitParamLowering();
  return decls.map((decl) => pass.decl(decl));
}

class ImplicitParamLowering extends LoweringPass {
  override expr(expr: Expr): Expr {
    const mapped = super.expr(expr);
    if (mapped.kind === 'do') return { ...mapped, stmts: lowerImplicitStmts(mapped.stmts) };
    if (mapped.kind === 'comprehension') return lowerImplicitComprehension(mapped);
    return mapped;
  }

  override rhs(rhs: Rhs): Rhs {
    const { implicit, ...mapped } = super.rhs(rhs);
    const lowered: Rhs =
      mapped.body.kind === 'plain'
        ? mapped
        : { ...mapped, body: { kind: 'guarded', branches: mapped.body.branches.map(lowerImplicitGuards) } };
    return implicit ? withImplicitWhere(lowered, implicit) : lowered;
  }
}

function lowerImplicitStmts(stmts: Stmt[]): Stmt[] {
  const index = stmts.findIndex((stmt) => isImplicit(stmt));
  if (index === -1) return stmts;
  const stmt = stmts[index];
  const rest = stmts.slice(index + 1);
  if (rest.length === 0) throw compileError(stmt.span, 'do の最後の文は、式にしてください。');
  const body: Expr = { kind: 'do', stmts: lowerImplicitStmts(rest), span: stmt.span };
  return [...stmts.slice(0, index), { kind: 'exp', expr: implicitLet(stmt, body), span: stmt.span }];
}

/**
 * A comprehension whose qualifiers bind implicit parameters: `[e | qs, let ?x = v, rs]` is
 * `[r | qs, r <- let ?x = v in [e | rs]]`, the same in a list or any monad.
 */
function lowerImplicitComprehension(expr: Extract<Expr, { kind: 'comprehension' }>): Expr {
  const branches = [expr.quals, ...(expr.parallel ?? [])];
  const marked = branches.flat().find((stmt) => isImplicit(stmt));
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
function withImplicitWhere(rhs: Rhs, binds: ImplicitBind[]): Rhs {
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
function lowerImplicitGuards(branch: GuardedExpr): GuardedExpr {
  const index = branch.guards.findIndex((guard) => isImplicit(guard));
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
      return isImplicit(guard)
        ? implicitLet(guard, next)
        : { kind: 'let', decls: guard.decls, body: next, span: guard.span };
    }
    default: {
      return guard satisfies never;
    }
  }
}

function implicitLet(marked: Stmt | Guard, body: Expr): Expr {
  return {
    kind: 'implicitLet',
    binds: (marked as Extract<Stmt, { kind: 'let' }>).implicit as ImplicitBind[],
    body,
    span: marked.span,
  };
}

function isImplicit(item: Stmt | Guard): boolean {
  return item.kind === 'let' && item.implicit !== undefined;
}
