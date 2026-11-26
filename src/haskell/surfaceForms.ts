import type { Alt, Expr, GuardedExpr, Pat, Span } from './syntax';

/** The `what` of the `case` that `\case` is a lambda of. */
export const LAMBDA_CASE = String.raw`\case`;
/** The `what` of the `case` that `\cases` is a lambda of, whose scrutinee is a tuple when it has several parameters. */
export const LAMBDA_CASES = String.raw`\cases`;
/** The `what` of the `case` of `()` that a multi-way `if` is, whose only alternative has the guards. */
export const MULTI_WAY_IF = 'multi-way if';
/** The `what` of the case of a qualified do block's bind, whose failing alternative the renamer may drop. */
export const QUALIFIED_DO_BIND = 'qualified do bind';

/**
 * A name for a variable the conversion introduces, which no program can spell, since it holds a space; traces do not
 * show such variables.
 */
export function generatedName(purpose: string, index: number): string {
  return ` ${purpose}${index}`;
}

/** A lambda of variables that stand for syntax the source wrote without binding them. */
export function generatedLambda(names: string[], body: Expr, span: Span): Expr {
  return {
    kind: 'lambda',
    pats: names.map((name): Pat => ({ kind: 'pvar', name: { name, span }, span })),
    body,
    span,
    generated: true,
  };
}

export function variable(name: string, span: Span): Expr {
  return { kind: 'var', name: { name, span }, span };
}

export function lambdaCase(alts: Alt[], span: Span): Expr {
  const name = generatedName('case', 0);
  return generatedLambda(
    [name],
    { kind: 'case', scrutinee: variable(name, span), alts, span, what: LAMBDA_CASE },
    span
  );
}

/** A tuple with sections, `(, x)`, as a lambda of the missing elements. */
export function tupleSection(slots: (Expr | undefined)[], span: Span): Expr {
  const names: string[] = [];
  const elems = slots.map((slot) => {
    if (slot) return slot;
    const name = generatedName('section', names.length);
    names.push(name);
    return variable(name, span);
  });
  return generatedLambda(names, { kind: 'tuple', elems, span }, span);
}

export function multiWayIf(branches: GuardedExpr[], span: Span): Expr {
  return {
    kind: 'case',
    scrutinee: { kind: 'con', name: { name: '()', span }, span },
    alts: [{ pat: { kind: 'pwild', span }, rhs: { body: { kind: 'guarded', branches }, where: [], span }, span }],
    span,
    what: MULTI_WAY_IF,
  };
}

/** `(.a.b)`, a lambda of the record it projects. */
export function projectionSelector(fields: string[], span: Span): Expr {
  const name = generatedName('record', 0);
  let body = variable(name, span);
  for (const field of fields) body = { kind: 'projection', expr: body, field, span };
  return generatedLambda([name], body, span);
}
