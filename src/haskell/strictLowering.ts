import type { FeatureGates } from './features';
import type { Alt, Decl, Expr, Guard, Pat, Rhs, Span, Stmt } from './syntax';

/**
 * Makes the strict bindings of a module's `let`s, `where`s, guards, and statements evaluate before what follows
 * them, wherever they are: `!x = e` evaluates `x`, and `!(a, b) = e` matches the whole pattern, as do all of a
 * group's bindings under Strict. Source code and the code Template Haskell splices give both go through it once.
 */
export function lowerStrictBindings(features: FeatureGates<'convert'>, decls: Decl[]): Decl[] {
  return new StrictLowering(features).decls(decls);
}

/** Where a statement is: in a `do` block, or among a comprehension's qualifiers, whose guards are expressions. */
type StmtContext = 'do' | 'comprehension';

class StrictLowering {
  constructor(private readonly features: FeatureGates<'convert'>) {}

  decls(decls: Decl[]): Decl[] {
    return decls.map((decl) => this.decl(decl));
  }

  private decl(decl: Decl): Decl {
    switch (decl.kind) {
      case 'funClause': {
        return { ...decl, args: decl.args.map((arg) => this.pat(arg)), rhs: this.rhs(decl.rhs) };
      }
      case 'patBind': {
        return { ...decl, pat: this.pat(decl.pat), rhs: this.rhs(decl.rhs) };
      }
      case 'class':
      case 'instance': {
        return { ...decl, decls: this.decls(decl.decls) };
      }
      case 'patSyn': {
        return {
          ...decl,
          pattern: this.pat(decl.pattern),
          ...(decl.builder ? { builder: this.decls(decl.builder) } : {}),
        };
      }
      case 'sig':
      case 'fixity':
      case 'data':
      case 'typeSyn':
      case 'typeFamily':
      case 'typeInstance':
      case 'dataFamily':
      case 'patSynSig':
      case 'kindSig':
      case 'defaultTypes':
      case 'standaloneDeriving':
      case 'roleAnnotation': {
        return decl;
      }
      default: {
        return unreachable(decl);
      }
    }
  }

  /** A local binding group, with the variables whose values must be evaluated before what the group scopes over. */
  private group(decls: Decl[]): { decls: Decl[]; forced: string[] } {
    return strictBindings(this.features, this.decls(decls));
  }

  private rhs(rhs: Rhs): Rhs {
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

  private guards(guards: Guard[]): Guard[] {
    return guards.flatMap((guard): Guard[] => {
      switch (guard.kind) {
        case 'bool': {
          return [{ ...guard, expr: this.expr(guard.expr) }];
        }
        case 'pat': {
          return [{ ...guard, pat: this.pat(guard.pat), expr: this.expr(guard.expr) }];
        }
        case 'let': {
          const { decls, forced } = this.group(guard.decls);
          const lowered: Guard = { ...guard, decls };
          if (forced.length === 0) return [lowered];
          return [lowered, { kind: 'bool', expr: forcing(forced, trueOf(guard.span), guard.span), span: guard.span }];
        }
        default: {
          return unreachable(guard);
        }
      }
    });
  }

  private stmts(stmts: Stmt[], context: StmtContext): Stmt[] {
    return stmts.flatMap((stmt): Stmt[] => {
      switch (stmt.kind) {
        case 'bind': {
          return [{ ...stmt, pat: this.pat(stmt.pat), expr: this.expr(stmt.expr) }];
        }
        case 'exp': {
          return [{ ...stmt, expr: this.expr(stmt.expr) }];
        }
        case 'let': {
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
        }
        case 'rec': {
          return [{ ...stmt, stmts: this.stmts(stmt.stmts, context) }];
        }
        case 'transform': {
          return [{ ...stmt, fn: this.expr(stmt.fn), ...(stmt.by ? { by: this.expr(stmt.by) } : {}) }];
        }
        default: {
          return unreachable(stmt);
        }
      }
    });
  }

  private alt(alt: Alt): Alt {
    return { ...alt, pat: this.pat(alt.pat), rhs: this.rhs(alt.rhs) };
  }

  // code-gauge-allow functionCognitiveComplexity -- One short case per expression kind.
  private expr(expr: Expr): Expr {
    switch (expr.kind) {
      case 'var':
      case 'con':
      case 'lit':
      case 'implicit':
      case 'support':
      case 'hole':
      case 'thVar':
      case 'thName': {
        return expr;
      }
      case 'app': {
        return { ...expr, fn: this.expr(expr.fn), arg: this.expr(expr.arg) };
      }
      case 'chain':
      case 'thChain': {
        return {
          ...expr,
          items: expr.items.map((item) => (item.kind === 'operand' ? { ...item, value: this.expr(item.value) } : item)),
        };
      }
      case 'binop': {
        return { ...expr, left: this.expr(expr.left), right: this.expr(expr.right) };
      }
      case 'neg':
      case 'paren':
      case 'typed':
      case 'tyapp':
      case 'projection':
      case 'thSplice': {
        return { ...expr, expr: this.expr(expr.expr) };
      }
      case 'lambda': {
        return { ...expr, pats: expr.pats.map((pat) => this.pat(pat)), body: this.expr(expr.body) };
      }
      case 'let': {
        const { decls, forced } = this.group(expr.decls);
        return { ...expr, decls, body: forcing(forced, this.expr(expr.body), expr.span) };
      }
      case 'if': {
        return {
          ...expr,
          cond: this.expr(expr.cond),
          ifTrue: this.expr(expr.ifTrue),
          ifFalse: this.expr(expr.ifFalse),
        };
      }
      case 'case': {
        return { ...expr, scrutinee: this.expr(expr.scrutinee), alts: expr.alts.map((alt) => this.alt(alt)) };
      }
      case 'do': {
        return { ...expr, stmts: this.stmts(expr.stmts, 'do') };
      }
      case 'tuple':
      case 'list': {
        return { ...expr, elems: expr.elems.map((elem) => this.expr(elem)) };
      }
      case 'arith': {
        return {
          ...expr,
          from: this.expr(expr.from),
          ...(expr.next ? { next: this.expr(expr.next) } : {}),
          ...(expr.to ? { to: this.expr(expr.to) } : {}),
        };
      }
      case 'comprehension': {
        return {
          ...expr,
          expr: this.expr(expr.expr),
          quals: this.stmts(expr.quals, 'comprehension'),
          ...(expr.parallel ? { parallel: expr.parallel.map((quals) => this.stmts(quals, 'comprehension')) } : {}),
        };
      }
      case 'leftSection': {
        return { ...expr, left: this.expr(expr.left) };
      }
      case 'rightSection': {
        return { ...expr, right: this.expr(expr.right) };
      }
      case 'recordCon': {
        return { ...expr, fields: expr.fields.map((field) => ({ ...field, value: this.expr(field.value) })) };
      }
      case 'recordUpdate': {
        return {
          ...expr,
          expr: this.expr(expr.expr),
          fields: expr.fields.map((field) => ({ ...field, value: this.expr(field.value) })),
        };
      }
      case 'implicitLet': {
        return {
          ...expr,
          binds: expr.binds.map((bind) => ({ ...bind, expr: this.expr(bind.expr) })),
          body: this.expr(expr.body),
        };
      }
      default: {
        return unreachable(expr);
      }
    }
  }

  private pat(pat: Pat): Pat {
    switch (pat.kind) {
      case 'pvar':
      case 'pwild':
      case 'plit':
      case 'ptybinder': {
        return pat;
      }
      case 'pcon': {
        return { ...pat, args: pat.args.map((arg) => this.pat(arg)) };
      }
      case 'ptuple':
      case 'plist': {
        return { ...pat, elems: pat.elems.map((elem) => this.pat(elem)) };
      }
      case 'pas':
      case 'pbang':
      case 'plazy':
      case 'psig': {
        return { ...pat, pat: this.pat(pat.pat) };
      }
      case 'precord': {
        return { ...pat, fields: pat.fields.map((field) => ({ ...field, pat: this.pat(field.pat) })) };
      }
      case 'pchain': {
        return {
          ...pat,
          items: pat.items.map((item) => (item.kind === 'operand' ? { ...item, value: this.pat(item.value) } : item)),
        };
      }
      case 'pview': {
        return { ...pat, expr: this.expr(pat.expr), pat: this.pat(pat.pat) };
      }
      case 'por': {
        return { ...pat, alts: pat.alts.map((alt) => this.pat(alt)) };
      }
      default: {
        return unreachable(pat);
      }
    }
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

/** An expression that evaluates variables before it gives its value, `x `seq` e`. */
function forcing(names: string[], expr: Expr, span: Span): Expr {
  let result = expr;
  for (const name of names.toReversed()) {
    const seq: Expr = { kind: 'support', name: 'seq', span };
    const variable: Expr = { kind: 'var', name: { name, span }, span };
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

function unreachable(value: never): never {
  throw new Error(`Unknown syntax ${(value as { kind: string }).kind}`);
}
