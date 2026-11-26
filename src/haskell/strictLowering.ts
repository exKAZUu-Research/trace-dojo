import type { FeatureGates } from './features';
import { LAMBDA_CASES, MULTI_WAY_IF, QUALIFIED_DO_BIND } from './surfaceForms';
import type { Alt, Decl, Expr, Guard, Pat, Rhs, Span, Stmt } from './syntax';
import { LoweringPass, mapGuardChildren, mapStmtChildren, type StmtContext } from './syntaxChildren';

/**
 * Under Strict, matches the patterns the source binds with strictly, as if each had a `!`, unless it is lazy, `~p`:
 * a function's and a lambda's parameters, case alternatives, and the patterns of binds and pattern guards.
 */
export function bangStrictPatterns(decls: Decl[]): Decl[] {
  const pass = new StrictPatterns();
  return decls.map((decl) => pass.decl(decl));
}

class StrictPatterns extends LoweringPass {
  override expr(expr: Expr): Expr {
    const mapped = super.expr(expr);
    if (mapped.kind === 'lambda' && !mapped.generated) return { ...mapped, pats: mapped.pats.map(banged) };
    if (mapped.kind === 'case') return { ...mapped, alts: strictAlternatives(mapped) };
    return mapped;
  }

  override decl(decl: Decl): Decl {
    const mapped = super.decl(decl);
    return mapped.kind === 'funClause' ? { ...mapped, args: mapped.args.map(banged) } : mapped;
  }

  override stmts(stmts: Stmt[], context: StmtContext): Stmt[] {
    return super
      .stmts(stmts, context)
      .map((stmt) => (stmt.kind === 'bind' ? { ...stmt, pat: banged(stmt.pat) } : stmt));
  }

  override guards(guards: Guard[]): Guard[] {
    return super.guards(guards).map((guard) => (guard.kind === 'pat' ? { ...guard, pat: banged(guard.pat) } : guard));
  }
}

/** The alternatives of a case, whose patterns are the source's except where the case stands for other syntax. */
function strictAlternatives(expr: Extract<Expr, { kind: 'case' }>): Alt[] {
  switch (expr.what) {
    case MULTI_WAY_IF: {
      return expr.alts;
    }
    // The bind's own pattern, and the alternative that fails.
    case QUALIFIED_DO_BIND: {
      return [bangedAlternative(expr.alts[0]), ...expr.alts.slice(1)];
    }
    // The parameters' patterns, a tuple's elements when there are several.
    case LAMBDA_CASES: {
      if (expr.scrutinee.kind !== 'tuple') return expr.alts.map(bangedAlternative);
      return expr.alts.map((alt) =>
        alt.pat.kind === 'ptuple' ? { ...alt, pat: { ...alt.pat, elems: alt.pat.elems.map(banged) } } : alt
      );
    }
    default: {
      return expr.alts.map(bangedAlternative);
    }
  }
}

function bangedAlternative(alt: Alt): Alt {
  return { ...alt, pat: banged(alt.pat) };
}

function banged(pat: Pat): Pat {
  // A type binder, `@a`, binds no value to evaluate.
  if (pat.kind === 'plazy' || pat.kind === 'pbang' || pat.kind === 'ptybinder') return pat;
  return { kind: 'pbang', pat, span: pat.span };
}

/**
 * Makes the strict bindings of a module's `let`s, `where`s, guards, and statements evaluate before what follows
 * them, wherever they are: `!x = e` evaluates `x`, and `!(a, b) = e` matches the whole pattern, as do all of a
 * group's bindings under Strict.
 */
export function lowerStrictBindings(features: FeatureGates<'convert'>, decls: Decl[]): Decl[] {
  const lowering = new StrictLowering(features);
  return decls.map((decl) => lowering.decl(decl));
}

class StrictLowering extends LoweringPass {
  constructor(private readonly features: FeatureGates<'convert'>) {
    super();
  }

  override expr(expr: Expr): Expr {
    if (expr.kind !== 'let') return super.expr(expr);
    const { decls, forced } = this.group(expr.decls);
    return { ...expr, decls, body: forcing(forced, this.expr(expr.body), expr.span) };
  }

  override rhs(rhs: Rhs): Rhs {
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

  override stmts(stmts: Stmt[], context: StmtContext): Stmt[] {
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

  override guards(guards: Guard[]): Guard[] {
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
