import type { Decl, Expr, Guard, ImplicitBind, Pat, QuoteBody, Rhs, Stmt } from './syntax';

/** Where statements are: in a `do` block, or among a comprehension's qualifiers, whose guards are expressions. */
export type StmtContext = 'do' | 'comprehension';

/**
 * What a pass does to each kind of node inside the one it rebuilds. Statements and guards go by list, so a pass may
 * replace one with several. Types are left as they are: the only expressions they hold are splices inside quotes.
 */
export interface SyntaxMapper {
  expr(expr: Expr): Expr;
  pat(pat: Pat): Pat;
  decl(decl: Decl): Decl;
  rhs(rhs: Rhs): Rhs;
  stmts(stmts: Stmt[], context: StmtContext): Stmt[];
  guards(guards: Guard[]): Guard[];
}

/** An expression with its children mapped, every other field kept; one without children is returned as it is. */
// code-gauge-allow functionNcss -- One short case per expression kind.
export function mapExprChildren(expr: Expr, mapper: Omit<SyntaxMapper, 'guards'>): Expr {
  switch (expr.kind) {
    case 'var':
    case 'con':
    case 'lit':
    case 'implicit':
    case 'support':
    case 'hole':
    case 'thName': {
      return expr;
    }
    case 'app': {
      return { ...expr, fn: mapper.expr(expr.fn), arg: mapper.expr(expr.arg) };
    }
    case 'chain': {
      return {
        ...expr,
        items: expr.items.map((item) => (item.kind === 'operand' ? { ...item, value: mapper.expr(item.value) } : item)),
      };
    }
    case 'binop': {
      return { ...expr, left: mapper.expr(expr.left), right: mapper.expr(expr.right) };
    }
    case 'neg':
    case 'paren':
    case 'quoteLevel':
    case 'typed':
    case 'tyapp':
    case 'projection':
    case 'thSplice': {
      return { ...expr, expr: mapper.expr(expr.expr) };
    }
    case 'lambda': {
      return { ...expr, pats: expr.pats.map((pat) => mapper.pat(pat)), body: mapper.expr(expr.body) };
    }
    case 'let': {
      return { ...expr, decls: expr.decls.map((decl) => mapper.decl(decl)), body: mapper.expr(expr.body) };
    }
    case 'if': {
      return {
        ...expr,
        cond: mapper.expr(expr.cond),
        ifTrue: mapper.expr(expr.ifTrue),
        ifFalse: mapper.expr(expr.ifFalse),
      };
    }
    case 'case': {
      return {
        ...expr,
        scrutinee: mapper.expr(expr.scrutinee),
        alts: expr.alts.map((alt) => ({ ...alt, pat: mapper.pat(alt.pat), rhs: mapper.rhs(alt.rhs) })),
      };
    }
    case 'do': {
      return { ...expr, stmts: mapper.stmts(expr.stmts, 'do') };
    }
    case 'tuple':
    case 'list': {
      return { ...expr, elems: expr.elems.map((elem) => mapper.expr(elem)) };
    }
    case 'arith': {
      return {
        ...expr,
        from: mapper.expr(expr.from),
        ...(expr.next ? { next: mapper.expr(expr.next) } : {}),
        ...(expr.to ? { to: mapper.expr(expr.to) } : {}),
      };
    }
    case 'comprehension': {
      return {
        ...expr,
        expr: mapper.expr(expr.expr),
        quals: mapper.stmts(expr.quals, 'comprehension'),
        ...(expr.parallel ? { parallel: expr.parallel.map((quals) => mapper.stmts(quals, 'comprehension')) } : {}),
      };
    }
    case 'leftSection': {
      return { ...expr, left: mapper.expr(expr.left) };
    }
    case 'rightSection': {
      return { ...expr, right: mapper.expr(expr.right) };
    }
    case 'recordCon': {
      return { ...expr, fields: expr.fields.map((field) => ({ ...field, value: mapper.expr(field.value) })) };
    }
    case 'recordUpdate': {
      return {
        ...expr,
        expr: mapper.expr(expr.expr),
        fields: expr.fields.map((field) => ({ ...field, value: mapper.expr(field.value) })),
      };
    }
    case 'implicitLet': {
      return { ...expr, binds: mapImplicitBinds(expr.binds, mapper), body: mapper.expr(expr.body) };
    }
    case 'quote': {
      return {
        ...expr,
        body: mapQuoteBody(expr.body, mapper),
        ...(expr.witness ? { witness: mapper.expr(expr.witness) } : {}),
      };
    }
    default: {
      return expr satisfies never;
    }
  }
}

function mapQuoteBody(body: QuoteBody, mapper: Pick<SyntaxMapper, 'expr' | 'pat' | 'decl'>): QuoteBody {
  if (body.kind === 'exp') return { ...body, expr: mapper.expr(body.expr) };
  if (body.kind === 'pat') return { ...body, pat: mapper.pat(body.pat) };
  if (body.kind === 'decs') return { ...body, decls: body.decls.map((decl) => mapper.decl(decl)) };
  if (body.kind === 'type') return body;
  return body satisfies never;
}

/** A pattern with its children mapped, every other field kept; one without children is returned as it is. */
export function mapPatChildren(pat: Pat, mapper: Pick<SyntaxMapper, 'expr' | 'pat'>): Pat {
  switch (pat.kind) {
    case 'pvar':
    case 'pwild':
    case 'plit':
    case 'ptybinder': {
      return pat;
    }
    case 'pcon': {
      return { ...pat, args: pat.args.map((arg) => mapper.pat(arg)) };
    }
    case 'ptuple':
    case 'plist': {
      return { ...pat, elems: pat.elems.map((elem) => mapper.pat(elem)) };
    }
    case 'pas':
    case 'pbang':
    case 'plazy':
    case 'psig': {
      return { ...pat, pat: mapper.pat(pat.pat) };
    }
    case 'precord': {
      return { ...pat, fields: pat.fields.map((field) => ({ ...field, pat: mapper.pat(field.pat) })) };
    }
    case 'pchain': {
      return {
        ...pat,
        items: pat.items.map((item) => (item.kind === 'operand' ? { ...item, value: mapper.pat(item.value) } : item)),
      };
    }
    case 'pview': {
      return { ...pat, expr: mapper.expr(pat.expr), pat: mapper.pat(pat.pat) };
    }
    case 'por': {
      return { ...pat, alts: pat.alts.map((alt) => mapper.pat(alt)) };
    }
    default: {
      return pat satisfies never;
    }
  }
}

/** A declaration with its children mapped, every other field kept; one without children is returned as it is. */
export function mapDeclChildren(decl: Decl, mapper: Pick<SyntaxMapper, 'pat' | 'decl' | 'rhs'>): Decl {
  switch (decl.kind) {
    case 'funClause': {
      return { ...decl, args: decl.args.map((arg) => mapper.pat(arg)), rhs: mapper.rhs(decl.rhs) };
    }
    case 'patBind': {
      return { ...decl, pat: mapper.pat(decl.pat), rhs: mapper.rhs(decl.rhs) };
    }
    case 'class':
    case 'instance': {
      return { ...decl, decls: decl.decls.map((inner) => mapper.decl(inner)) };
    }
    case 'patSyn': {
      return {
        ...decl,
        pattern: mapper.pat(decl.pattern),
        ...(decl.builder ? { builder: decl.builder.map((inner) => mapper.decl(inner)) } : {}),
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
      return decl satisfies never;
    }
  }
}

/** A right side with its children mapped, every other field kept. */
export function mapRhsChildren(rhs: Rhs, mapper: Pick<SyntaxMapper, 'expr' | 'decl' | 'guards'>): Rhs {
  const where = rhs.where.map((decl) => mapper.decl(decl));
  if (rhs.body.kind === 'plain') return { ...rhs, where, body: { kind: 'plain', expr: mapper.expr(rhs.body.expr) } };
  const branches = rhs.body.branches.map((branch) => ({
    ...branch,
    guards: mapper.guards(branch.guards),
    expr: mapper.expr(branch.expr),
  }));
  return { ...rhs, where, body: { kind: 'guarded', branches } };
}

/** A statement with its children mapped, a `let`'s implicit bindings' expressions too, its other fields kept. */
export function mapStmtChildren(stmt: Stmt, context: StmtContext, mapper: Omit<SyntaxMapper, 'rhs' | 'guards'>): Stmt {
  switch (stmt.kind) {
    case 'bind': {
      return { ...stmt, pat: mapper.pat(stmt.pat), expr: mapper.expr(stmt.expr) };
    }
    case 'exp': {
      return { ...stmt, expr: mapper.expr(stmt.expr) };
    }
    case 'let': {
      return {
        ...stmt,
        decls: stmt.decls.map((decl) => mapper.decl(decl)),
        ...(stmt.implicit ? { implicit: mapImplicitBinds(stmt.implicit, mapper) } : {}),
      };
    }
    case 'rec': {
      return { ...stmt, stmts: mapper.stmts(stmt.stmts, context) };
    }
    case 'transform': {
      return { ...stmt, fn: mapper.expr(stmt.fn), ...(stmt.by ? { by: mapper.expr(stmt.by) } : {}) };
    }
    default: {
      return stmt satisfies never;
    }
  }
}

/** A guard with its children mapped, a `let`'s implicit bindings' expressions too, its other fields kept. */
export function mapGuardChildren(guard: Guard, mapper: Pick<SyntaxMapper, 'expr' | 'pat' | 'decl'>): Guard {
  switch (guard.kind) {
    case 'bool': {
      return { ...guard, expr: mapper.expr(guard.expr) };
    }
    case 'pat': {
      return { ...guard, pat: mapper.pat(guard.pat), expr: mapper.expr(guard.expr) };
    }
    case 'let': {
      return {
        ...guard,
        decls: guard.decls.map((decl) => mapper.decl(decl)),
        ...(guard.implicit ? { implicit: mapImplicitBinds(guard.implicit, mapper) } : {}),
      };
    }
    default: {
      return guard satisfies never;
    }
  }
}

function mapImplicitBinds(binds: ImplicitBind[], mapper: Pick<SyntaxMapper, 'expr'>): ImplicitBind[] {
  return binds.map((bind) => ({ ...bind, expr: mapper.expr(bind.expr) }));
}
