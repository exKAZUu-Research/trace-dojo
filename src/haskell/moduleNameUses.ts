import type { Decl, Expr, Guard, Pat, QName, Rhs, Stmt } from './syntax';
import {
  mapDeclChildren,
  mapExprChildren,
  mapGuardChildren,
  mapPatChildren,
  mapRhsChildren,
  mapStmtChildren,
  type SyntaxMapper,
} from './syntaxChildren';
import type { SpliceModuleNames } from './thSplice';

/** Whether code names a value or constructor of the module a splice program runs for, which the program lacks. */
export function namesSpliceModule(expr: Expr, outer: SpliceModuleNames): boolean {
  const collector = new ModuleNameUses(outer);
  collector.expr(expr);
  return collector.found;
}

class ModuleNameUses implements SyntaxMapper {
  found = false;

  constructor(private readonly outer: SpliceModuleNames) {}

  expr(expr: Expr): Expr {
    if (expr.kind === 'var' || expr.kind === 'con') this.note(expr.name);
    if (expr.kind === 'leftSection' || expr.kind === 'rightSection') this.note(expr.op);
    if (expr.kind === 'chain') for (const item of expr.items) if (item.kind === 'operator') this.note(item.op);
    return mapExprChildren(expr, this);
  }

  pat(pat: Pat): Pat {
    return mapPatChildren(pat, this);
  }

  decl(decl: Decl): Decl {
    return mapDeclChildren(decl, this);
  }

  rhs(rhs: Rhs): Rhs {
    return mapRhsChildren(rhs, this);
  }

  stmts(stmts: Stmt[], context: Parameters<SyntaxMapper['stmts']>[1]): Stmt[] {
    return stmts.map((stmt) => mapStmtChildren(stmt, context, this));
  }

  guards(guards: Guard[]): Guard[] {
    return guards.map((guard) => mapGuardChildren(guard, this));
  }

  private note(name: QName): void {
    if (name.qualifier && name.qualifier !== this.outer.module) return;
    if (this.outer.values.has(name.name) || this.outer.constructors.has(name.name)) this.found = true;
  }
}
