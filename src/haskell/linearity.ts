import { compileError } from './errors';
import { type LocalVar, type RBindGroup, type RBinding, type RExpr, type RPat, rpatChildren, type RRhs } from './rast';
import { functionParts, zonk } from './types';

/** How many times an expression uses a variable: not at all, exactly once, or any other number of times. */
type Usage = 0 | 1 | 'many';

function add(a: Usage, b: Usage): Usage {
  if (a === 0) return b;
  if (b === 0) return a;
  return 'many';
}

/** The usage several expressions give together. */
function total<T>(items: readonly T[], usage: (item: T) => Usage): Usage {
  let result: Usage = 0;
  for (const item of items) result = add(result, usage(item));
  return result;
}

function multiply(a: Usage, b: Usage): Usage {
  if (a === 0 || b === 0) return 0;
  return a === 1 && b === 1 ? 1 : 'many';
}

function scale(usage: Usage, linear: boolean): Usage {
  return usage === 0 || linear ? usage : 'many';
}

/** The usage the branches of a `case` or an `if` give: the same in every branch, or no fixed one. */
function branches(usages: Usage[]): Usage {
  if (usages.length === 0) return 0;
  return usages.every((usage) => usage === usages[0]) ? usages[0] : 'many';
}

interface Pending {
  locals: LocalVar[];
  rhs: RRhs;
}

/**
 * Checks that a function of LinearTypes uses each variable its linear argument binds exactly once on every path:
 * each use passes it to a linear argument, and matching it with `case` binds variables that must be used likewise.
 */
export function checkLinearUses(locals: readonly LocalVar[], rhs: RRhs): void {
  const pending: Pending[] = [{ locals: [...locals], rhs }];
  while (pending.length > 0) {
    const item = pending.pop() as Pending;
    for (const local of item.locals) {
      if (local.name.includes(' ')) continue;
      if (new UsageCounter(local, pending).rhs(item.rhs) !== 1) {
        throw compileError(local.span, `線形の引数 ${local.name} は、どの場合もちょうど 1 回使わなければなりません。`);
      }
    }
  }
}

/**
 * The variables a pattern matching a linear value binds, each of which must then be used once. A wildcard there
 * discards part of the value, which a linear value may not have, so it is an error as in GHC.
 */
export function linearLocals(pat: RPat): LocalVar[] {
  const result: LocalVar[] = [];
  const pending = [pat];
  while (pending.length > 0) {
    const current = pending.pop() as RPat;
    if (current.k === 'wild') {
      throw compileError(
        current.span,
        '線形の値を _ で捨てることはできません。どの場合もちょうど 1 回使ってください。'
      );
    }
    if (current.k === 'var' || current.k === 'as') result.push(current.local);
    pending.push(...rpatChildren(current).toReversed());
  }
  return result;
}

class UsageCounter {
  constructor(
    private readonly local: LocalVar,
    private readonly pending: Pending[]
  ) {}

  rhs(rhs: RRhs): Usage {
    const where = scale(this.group(rhs.where), false);
    if (rhs.body.k === 'plain') return add(where, this.expr(rhs.body.expr));
    const usages = rhs.body.branches.map((branch) => {
      let usage: Usage = 0;
      for (const guard of branch.guards) {
        usage = add(usage, scale(guard.k === 'let' ? this.group(guard.binds) : this.expr(guard.expr), false));
      }
      return add(usage, this.expr(branch.expr));
    });
    return add(where, branches(usages));
  }

  private group(group: RBindGroup): Usage {
    return total(group.bindings, (binding) => this.binding(binding));
  }

  private binding(binding: RBinding): Usage {
    if (binding.k === 'pat') return this.rhs(binding.rhs);
    return total(binding.clauses, (clause) => this.rhs(clause.rhs));
  }

  // code-gauge-allow functionCognitiveComplexity -- One short case per expression kind.
  private expr(expr: RExpr): Usage {
    switch (expr.k) {
      case 'var': {
        return expr.ref.kind === 'local' && expr.ref.local === this.local ? 1 : 0;
      }
      case 'app': {
        // A data constructor's fields are linear, as LinearTypes makes them.
        let head: RExpr = expr.fn;
        while (head.k === 'app') head = head.fn;
        const parts = expr.fn.type ? functionParts(zonk(expr.fn.type)) : undefined;
        const linear = head.k === 'con' || parts?.multiplicity !== undefined;
        return add(this.expr(expr.fn), scale(this.expr(expr.arg), linear));
      }
      case 'lambda': {
        return scale(this.expr(expr.body), false);
      }
      case 'let': {
        // A variable a `let` binds uses what its right side does as many times as the body uses the variable.
        let usage = this.expr(expr.body);
        for (const binding of expr.binds.bindings) {
          const bound = binding.k === 'fun' ? binding.binder : undefined;
          const simple =
            bound?.kind === 'local' && binding.k === 'fun' && binding.clauses.every((c) => c.pats.length === 0);
          const times = simple ? new UsageCounter(bound.local, []).expr(expr.body) : 'many';
          usage = add(usage, multiply(this.binding(binding), times));
        }
        return usage;
      }
      case 'if': {
        return add(this.expr(expr.cond), branches([this.expr(expr.ifTrue), this.expr(expr.ifFalse)]));
      }
      case 'case': {
        const scrutinee = this.expr(expr.scrutinee);
        if (
          scrutinee === 1 &&
          expr.scrutinee.k === 'var' &&
          expr.scrutinee.ref.kind === 'local' &&
          expr.scrutinee.ref.local === this.local
        ) {
          for (const alt of expr.alts) this.pending.push({ locals: linearLocals(alt.pat), rhs: alt.rhs });
        }
        return add(scrutinee, branches(expr.alts.map((alt) => this.rhs(alt.rhs))));
      }
      case 'tuple':
      case 'list': {
        return total(expr.elems, (elem) => this.expr(elem));
      }
      case 'recordCon': {
        return total(expr.fields, (field) => this.expr(field.value));
      }
      case 'typed':
      case 'tyapp':
      case 'poly': {
        return this.expr(expr.expr);
      }
      case 'do': {
        return total(expr.stmts, (stmt) =>
          scale(stmt.k === 'let' ? this.group(stmt.binds) : this.expr(stmt.expr), false)
        );
      }
      case 'arith': {
        return scale(add(add(this.expr(expr.from), this.optional(expr.next)), this.optional(expr.to)), false);
      }
      case 'comp': {
        return scale(this.expr(expr.expr), false) === 0 && !this.mentions(expr) ? 0 : 'many';
      }
      case 'rsection': {
        return scale(add(this.expr(expr.op), this.expr(expr.right)), false);
      }
      case 'recordUpdate': {
        // The new values go to the constructor's linear fields, as building a record does.
        const values = total(expr.fields, (field) => this.expr(field.value));
        return add(scale(this.expr(expr.expr), false), values);
      }
      case 'projection': {
        return scale(this.expr(expr.expr), false);
      }
      case 'implicitLet': {
        const binds = total(expr.binds, (bind) => this.expr(bind.expr));
        return add(scale(binds, false), this.expr(expr.body));
      }
      default: {
        return 0;
      }
    }
  }

  private optional(expr: RExpr | undefined): Usage {
    return expr ? this.expr(expr) : 0;
  }

  /** Whether a comprehension's qualifiers use the variable. */
  private mentions(expr: Extract<RExpr, { k: 'comp' }>): boolean {
    return expr.quals.some((stmt) => (stmt.k === 'let' ? this.group(stmt.binds) : this.expr(stmt.expr)) !== 0);
  }
}
