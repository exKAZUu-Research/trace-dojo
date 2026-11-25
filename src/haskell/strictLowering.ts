import type { FeatureGates } from './features';
import type { Decl, Expr, Guard, Pat, Rhs, Span, Stmt } from './syntax';
import {
  mapDeclChildren,
  mapExprChildren,
  mapGuardChildren,
  mapPatChildren,
  mapStmtChildren,
  type StmtContext,
  type SyntaxMapper,
} from './syntaxChildren';

/**
 * Makes the strict bindings of a module's `let`s, `where`s, guards, and statements evaluate before what follows
 * them, wherever they are: `!x = e` evaluates `x`, and `!(a, b) = e` matches the whole pattern, as do all of a
 * group's bindings under Strict. Source code and the code Template Haskell splices give both go through it once.
 */
export function lowerStrictBindings(features: FeatureGates<'convert'>, decls: Decl[]): Decl[] {
  const lowering = new StrictLowering(features);
  return decls.map((decl) => lowering.decl(decl));
}

class StrictLowering implements SyntaxMapper {
  constructor(private readonly features: FeatureGates<'convert'>) {}

  expr(expr: Expr): Expr {
    switch (expr.kind) {
      // A quote's tree keeps the syntax it quotes.
      case 'quote': {
        return expr;
      }
      case 'let': {
        const { decls, forced } = this.group(expr.decls);
        return { ...expr, decls, body: forcing(forced, this.expr(expr.body), expr.span) };
      }
      default: {
        return mapExprChildren(expr, this);
      }
    }
  }

  pat(pat: Pat): Pat {
    return mapPatChildren(pat, this);
  }

  decl(decl: Decl): Decl {
    return mapDeclChildren(decl, this);
  }

  rhs(rhs: Rhs): Rhs {
    const { decls: where, forced } = this.group(rhs.where);
    const { span } = rhs;
    if (rhs.body.kind === 'plain') {
      return { ...rhs, where, body: { kind: 'plain', expr: forcing(forced, this.expr(rhs.body.expr), span) } };
    }
    // The banged bindings of a where are evaluated before the guards are.
    const first: Guard[] = forced.length > 0 ? [{ kind: 'bool', expr: forcing(forced, trueOf(span), span), span }] : [];
    return {
      ...rhs,
      where,
      body: {
        kind: 'guarded',
        branches: rhs.body.branches.map((branch) => ({
          ...branch,
          guards: [...first, ...this.guards(branch.guards)],
          expr: this.expr(branch.expr),
        })),
      },
    };
  }

  stmts(stmts: Stmt[], context: StmtContext): Stmt[] {
    return stmts.flatMap((stmt): Stmt[] => {
      if (stmt.kind !== 'let') return [mapStmtChildren(stmt, context, this)];
      const { decls, forced } = this.group(stmt.decls);
      const lowered: Stmt = { ...stmt, decls };
      if (forced.length === 0) return [lowered];
      // A statement after the bindings evaluates them: an action in a do block, a guard among qualifiers.
      const { span } = stmt;
      const done: Expr =
        context === 'do'
          ? { kind: 'app', fn: { kind: 'support', name: 'return', span }, arg: unitOf(span), span }
          : trueOf(span);
      return [lowered, { kind: 'exp', expr: forcing(forced, done, span), span }];
    });
  }

  guards(guards: Guard[]): Guard[] {
    return guards.flatMap((guard): Guard[] => {
      if (guard.kind !== 'let') return [mapGuardChildren(guard, this)];
      const { decls, forced } = this.group(guard.decls);
      const lowered: Guard = { ...guard, decls };
      if (forced.length === 0) return [lowered];
      return [lowered, { kind: 'bool', expr: forcing(forced, trueOf(guard.span), guard.span), span: guard.span }];
    });
  }

  private group(decls: Decl[]): { decls: Decl[]; forced: string[] } {
    return strictBindings(
      this.features,
      decls.map((decl) => this.decl(decl))
    );
  }
}

/**
 * The bindings of a group, with the ones a `!` makes strict (all of the variable bindings under Strict) and the
 * variables whose values must be evaluated before what the group scopes over: `!x = e` evaluates `x`, and
 * `!(a, b) = e` binds the whole pattern to a new variable to evaluate, which matches all of it.
 */
function strictBindings(features: FeatureGates<'convert'>, decls: Decl[]): { decls: Decl[]; forced: string[] } {
  const forced: string[] = [];
  const result: Decl[] = [];
  for (const decl of decls) {
    // Under Strict, every pattern binding but a lazy one, `~p`, is strict as if it had a `!`.
    const banged =
      decl.kind === 'patBind' && decl.pat.kind === 'pbang'
        ? decl.pat.pat
        : decl.kind === 'patBind' && features.allows('strict') && decl.pat.kind !== 'plazy'
          ? decl.pat
          : decl.kind === 'funClause' && decl.args.length === 0 && features.allows('strict')
            ? ({ kind: 'pvar', name: decl.name, span: decl.span } as Pat)
            : undefined;
    if (!banged || (decl.kind !== 'patBind' && decl.kind !== 'funClause')) {
      result.push(decl);
      continue;
    }
    if (banged.kind === 'pvar') {
      forced.push(banged.name.name);
      result.push({ kind: 'funClause', name: banged.name, args: [], rhs: decl.rhs, span: decl.span });
      continue;
    }
    // A name no program can spell, since it holds a space.
    const name = ` strict${forced.length}`;
    forced.push(name);
    result.push({
      kind: 'patBind',
      pat: { kind: 'pas', name: { name, span: decl.span }, pat: banged, span: decl.span },
      rhs: decl.rhs,
      span: decl.span,
    });
  }
  return { decls: result, forced };
}

function forcing(names: string[], expr: Expr, span: Span): Expr {
  let result = expr;
  for (const name of names.toReversed()) {
    const seq: Expr = { kind: 'support', name: 'seq', span };
    const variable: Expr = { kind: 'var', name: { name, span }, span, forcing: true };
    result = { kind: 'app', fn: { kind: 'app', fn: seq, arg: variable, span }, arg: result, span };
  }
  return result;
}

function trueOf(span: Span): Expr {
  return { kind: 'support', name: 'True', span };
}

function unitOf(span: Span): Expr {
  return { kind: 'con', name: { name: '()', span }, span };
}
