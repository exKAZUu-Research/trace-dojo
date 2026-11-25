// code-gauge-allow-file fileNcss -- The quote renamer covers every construct a quote may hold against one scope structure.
import type { Fixity } from './entities';
import { compileError, unsupportedError } from './errors';
import { DEFAULT_FIXITY, resolveExprChain, resolvePatChain } from './fixity';
import { LocalScope } from './localScope';
import type {
  LocalVar,
  QBody,
  QClause,
  QCon,
  QDecl,
  QDecls,
  QExpr,
  QGuarded,
  QMatch,
  QPat,
  QQuote,
  QRef,
  QStmt,
  QType,
  QTyVar,
} from './rast';
import type {
  Alt,
  ConDecl,
  Decl,
  Expr,
  Guard,
  Name,
  Operator,
  Pat,
  QName,
  QuoteBody,
  Rhs,
  SigType,
  Span,
  Stmt,
  TypeExpr,
  TyVarBinder,
} from './syntax';

/** The namespaces of global names a quote refers to; `value` has constructors besides variables and fields. */
export type QuoteNamespace = 'var' | 'value' | 'con' | 'type';

/** What renaming a quote asks of the module's renaming: its global names and their fixities. */
export interface QuoteGlobals {
  /**
   * The global name a name refers to, or an unbound name when nothing defines it; nothing defining a `required` name
   * is an error, unless the program runs a splice of a module whose names it lacks.
   */
  lookup(namespace: QuoteNamespace, name: QName, required: boolean): QRef;
  fixity(op: Operator): Fixity;
  /** The global name of a library value the quote's syntax stands for, such as `negate` for `-x`. */
  support(name: string, span: Span): QRef;
  newLocal(name: string, span: Span): LocalVar;
}

/** The names in scope at a point of a quote: values (with the variables around the quote), and what the quote binds. */
interface QuoteScope {
  values: LocalScope;
  cons: ReadonlyMap<string, LocalVar>;
  types: ReadonlyMap<string, LocalVar>;
  tyVars: ReadonlyMap<string, LocalVar>;
}

/**
 * Renames a Template Haskell quote in the scope it is written in, extended by the variables, constructors, types, and
 * type variables the quote binds, as GHC's renamer does: each name becomes a binder of the quote, a variable around
 * it, a global name, or an unbound one, and operator chains nest by the fixities in scope, the quote's own fixity
 * declarations among them.
 */
export class QuoteRenamer {
  /** The variables the quote binds, which the values of its scope have besides those around the quote. */
  private readonly own = new Set<LocalVar>();

  constructor(private readonly globals: QuoteGlobals) {}

  quote(body: QuoteBody, around: LocalScope): QQuote {
    const scope: QuoteScope = { values: around, cons: new Map(), types: new Map(), tyVars: new Map() };
    switch (body.kind) {
      case 'exp': {
        return { k: 'exp', expr: this.expr(body.expr, scope) };
      }
      case 'pat': {
        return { k: 'pat', pat: this.pat(body.pat, new Map(), scope) };
      }
      case 'type': {
        return { k: 'type', type: this.type(body.type, scope) };
      }
      case 'decs': {
        return { k: 'decs', decls: this.declGroup(body.decls, scope).decls };
      }
    }
  }

  // Names

  private bindValue(name: Name): LocalVar {
    const local = this.globals.newLocal(name.name, name.span);
    this.own.add(local);
    return local;
  }

  private withValues(scope: QuoteScope, locals: Iterable<LocalVar>): QuoteScope {
    const values = new LocalScope(scope.values);
    for (const local of locals) values.define(local.name, local);
    return { ...scope, values };
  }

  private withTyVars(scope: QuoteScope, locals: LocalVar[]): QuoteScope {
    const tyVars = new Map(scope.tyVars);
    for (const local of locals) tyVars.set(local.name, local);
    return { ...scope, tyVars };
  }

  private valueRef(name: QName, scope: QuoteScope, namespace: 'var' | 'value', required = false): QRef {
    const local = name.qualifier ? undefined : scope.values.lookup(name.name);
    if (local) return this.own.has(local) ? { k: 'bound', local } : { k: 'outer', name: name.name };
    return this.globals.lookup(namespace, name, required);
  }

  private conRef(name: QName, scope: QuoteScope, required: boolean): QRef {
    const local = name.qualifier ? undefined : scope.cons.get(name.name);
    return local ? { k: 'bound', local } : this.globals.lookup('con', name, required);
  }

  private typeRef(name: QName, scope: QuoteScope): QRef {
    const local = name.qualifier ? undefined : scope.types.get(name.name);
    return local ? { k: 'bound', local } : this.globals.lookup('type', name, true);
  }

  private tyVarRef(name: string, scope: QuoteScope): QRef {
    const local = scope.tyVars.get(name);
    return local ? { k: 'bound', local } : { k: 'unbound', name };
  }

  private fixity(op: Operator, scope: QuoteScope): Fixity {
    if (!op.qualifier) {
      const local = op.isConstructor ? scope.cons.get(op.name) : scope.values.lookup(op.name);
      if (local) return local.fixity ?? DEFAULT_FIXITY;
    }
    return this.globals.fixity(op);
  }

  private unsupportedIn(span: Span, what: string): Error {
    return unsupportedError(span, `Template Haskell のクォートの中の${what}`);
  }

  // Expressions

  // code-gauge-allow functionNcss -- One short case per expression kind a quote may hold.
  private expr(expr: Expr, scope: QuoteScope): QExpr {
    switch (expr.kind) {
      case 'var': {
        return { k: 'var', ref: this.valueRef(expr.name, scope, 'var') };
      }
      case 'con': {
        return { k: 'con', ref: this.conRef(expr.name, scope, false) };
      }
      case 'lit': {
        return { k: 'lit', lit: expr.lit };
      }
      case 'app': {
        return { k: 'app', fn: this.expr(expr.fn, scope), arg: this.expr(expr.arg, scope) };
      }
      case 'paren': {
        return this.expr(expr.expr, scope);
      }
      case 'chain': {
        return this.expr(
          resolveExprChain(expr.items, expr.span, (op) => this.fixity(op, scope)),
          scope
        );
      }
      case 'binop': {
        const op = this.operator(expr.op, scope);
        return { k: 'infix', left: this.expr(expr.left, scope), op, right: this.expr(expr.right, scope) };
      }
      case 'neg': {
        const negate: QExpr = { k: 'var', ref: this.globals.support('negate', expr.span) };
        return { k: 'app', fn: negate, arg: this.expr(expr.expr, scope) };
      }
      case 'leftSection': {
        return { k: 'infix', left: this.expr(expr.left, scope), op: this.operator(expr.op, scope) };
      }
      case 'rightSection': {
        return { k: 'infix', op: this.operator(expr.op, scope), right: this.expr(expr.right, scope) };
      }
      case 'lambda': {
        const sugar = this.lambdaSugar(expr, scope);
        if (sugar) return sugar;
        const binders = new Map<string, LocalVar>();
        const pats = expr.pats.map((pat) => this.pat(pat, binders, scope));
        return { k: 'lambda', pats, body: this.expr(expr.body, this.withValues(scope, binders.values())) };
      }
      case 'let': {
        const group = this.declGroup(expr.decls, scope);
        return { k: 'let', decls: group.decls, body: this.expr(expr.body, group.scope) };
      }
      case 'if': {
        return {
          k: 'if',
          cond: this.expr(expr.cond, scope),
          ifTrue: this.expr(expr.ifTrue, scope),
          ifFalse: this.expr(expr.ifFalse, scope),
        };
      }
      case 'case': {
        return this.caseExpr(expr, scope);
      }
      case 'do': {
        return { k: 'do', stmts: this.stmts(expr.stmts, scope).stmts };
      }
      case 'tuple':
      case 'list': {
        if (expr.kind === 'list' && expr.elems.length === 0) {
          return { k: 'con', ref: this.conRef({ name: '[]', span: expr.span }, scope, true) };
        }
        return { k: expr.kind, elems: expr.elems.map((elem) => this.expr(elem, scope)) };
      }
      default: {
        return this.otherExpr(expr, scope);
      }
    }
  }

  /** Sequences, comprehensions, signatures, records, type applications, and splices in a quote. */
  private otherExpr(expr: Expr, scope: QuoteScope): QExpr {
    switch (expr.kind) {
      case 'arith': {
        return {
          k: 'arith',
          from: this.expr(expr.from, scope),
          next: expr.next && this.expr(expr.next, scope),
          to: expr.to && this.expr(expr.to, scope),
        };
      }
      case 'comprehension': {
        if (expr.parallel) throw this.unsupportedIn(expr.span, '並列の内包表記');
        const final: Stmt = { kind: 'exp', expr: expr.expr, span: expr.span };
        return { k: 'comp', stmts: this.stmts([...expr.quals, final], scope).stmts };
      }
      case 'typed': {
        return { k: 'sig', expr: this.expr(expr.expr, scope), type: this.sigType(expr.sig, scope) };
      }
      case 'recordCon': {
        if (expr.wildcard) throw this.unsupportedIn(expr.span, 'レコードのワイルドカード');
        return { k: 'recordCon', con: this.conRef(expr.con, scope, true), fields: this.fieldExps(expr.fields, scope) };
      }
      case 'recordUpdate': {
        return { k: 'recordUpdate', expr: this.expr(expr.expr, scope), fields: this.fieldExps(expr.fields, scope) };
      }
      case 'tyapp': {
        if (!expr.type) throw this.unsupportedIn(expr.span, '型の適用 @_');
        return { k: 'tyapp', expr: this.expr(expr.expr, scope), type: this.type(expr.type, scope) };
      }
      case 'thSplice': {
        return { k: 'splice', code: expr.expr };
      }
      default: {
        throw this.unsupportedIn(expr.span, 'この式');
      }
    }
  }

  private operator(op: Operator, scope: QuoteScope): QExpr {
    return op.isConstructor
      ? { k: 'con', ref: this.conRef(op, scope, false) }
      : { k: 'var', ref: this.valueRef(op, scope, 'var') };
  }

  private fieldExps(fields: { field: QName; value: Expr }[], scope: QuoteScope): { field: QRef; value: QExpr }[] {
    return fields.map((field) => ({
      field: this.valueRef(field.field, scope, 'value', true),
      value: this.expr(field.value, scope),
    }));
  }

  /** `\case` and tuple sections, which the conversion writes as lambdas of generated variables. */
  private lambdaSugar(expr: Extract<Expr, { kind: 'lambda' }>, scope: QuoteScope): QExpr | undefined {
    const generated = expr.pats.map((pat) =>
      pat.kind === 'pvar' && pat.name.name.includes(' ') ? pat.name.name : undefined
    );
    if (!generated.every(Boolean)) return undefined;
    const { body } = expr;
    if (body.kind === 'case' && body.what === String.raw`\case`) {
      return { k: 'lamCase', alts: body.alts.map((alt) => this.match(alt, scope)) };
    }
    if (body.kind === 'tuple') {
      const elems = body.elems.map((elem) =>
        elem.kind === 'var' && generated.includes(elem.name.name) ? undefined : this.expr(elem, scope)
      );
      return { k: 'tupleSection', elems };
    }
    return undefined;
  }

  private caseExpr(expr: Extract<Expr, { kind: 'case' }>, scope: QuoteScope): QExpr {
    if (expr.what === 'multi-way if') {
      const rhs = expr.alts[0]?.rhs;
      if (rhs?.body.kind !== 'guarded') throw compileError(expr.span, '書き方に誤りがあります。');
      return {
        k: 'multiIf',
        branches: rhs.body.branches.map((branch) => this.guarded(branch.guards, branch.expr, scope)),
      };
    }
    const alts = expr.alts.map((alt) => this.match(alt, scope));
    if (expr.what === String.raw`\case` && expr.scrutinee.kind === 'var') return { k: 'lamCase', alts };
    return { k: 'case', scrutinee: this.expr(expr.scrutinee, scope), alts };
  }

  private match(alt: Alt, scope: QuoteScope): QMatch {
    const binders = new Map<string, LocalVar>();
    const pat = this.pat(alt.pat, binders, scope);
    return { pat, ...this.rhs(alt.rhs, this.withValues(scope, binders.values())) };
  }

  /** A right side, whose guards and bodies see its `where` bindings. */
  private rhs(rhs: Rhs, scope: QuoteScope): { body: QBody; where: QDecls } {
    const where = this.declGroup(rhs.where, scope);
    if (rhs.body.kind === 'plain') {
      return { body: { k: 'plain', expr: this.expr(rhs.body.expr, where.scope) }, where: where.decls };
    }
    const branches = rhs.body.branches.map((branch) => this.guarded(branch.guards, branch.expr, where.scope));
    return { body: { k: 'guarded', branches }, where: where.decls };
  }

  /** Guards, each of which sees the variables the guards before it bind, as the guarded expression does. */
  private guarded(guards: Guard[], expr: Expr, scope: QuoteScope): QGuarded {
    const stmts = guards.map((guard): Stmt => {
      if (guard.kind === 'bool') return { kind: 'exp', expr: guard.expr, span: guard.span };
      if (guard.kind === 'let') return { kind: 'let', decls: guard.decls, span: guard.span };
      return { kind: 'bind', pat: guard.pat, expr: guard.expr, span: guard.span };
    });
    const renamed = this.stmts(stmts, scope);
    return { guards: renamed.stmts, expr: this.expr(expr, renamed.scope) };
  }

  /**
   * Statements, each of which sees the variables the statements before it bind: a bind's expression is outside its
   * own pattern's scope, and a `let`'s declarations are inside their own.
   */
  private stmts(source: Stmt[], parent: QuoteScope): { stmts: QStmt[]; scope: QuoteScope } {
    let scope = parent;
    const stmts: QStmt[] = [];
    for (const stmt of source) {
      switch (stmt.kind) {
        case 'bind': {
          const expr = this.expr(stmt.expr, scope);
          const binders = new Map<string, LocalVar>();
          const pat = this.pat(stmt.pat, binders, scope);
          scope = this.withValues(scope, binders.values());
          stmts.push({ k: 'bind', pat, expr });
          break;
        }
        case 'let': {
          const group = this.declGroup(stmt.decls, scope);
          scope = group.scope;
          stmts.push({ k: 'let', decls: group.decls });
          break;
        }
        case 'exp': {
          stmts.push({ k: 'exp', expr: this.expr(stmt.expr, scope) });
          break;
        }
        default: {
          throw this.unsupportedIn(stmt.span, 'この文');
        }
      }
    }
    return { stmts, scope };
  }

  // Patterns

  /**
   * A pattern, whose variables go into `binders`, or are the ones `bound` has when a declaration group bound them. A
   * view pattern's expression sees the variables bound to its left, not those of its own pattern or after it.
   */
  // code-gauge-allow functionCognitiveComplexity -- One short case per pattern kind a quote may hold.
  // code-gauge-allow functionNcss -- One short case per pattern kind a quote may hold.
  private pat(
    pat: Pat,
    binders: Map<string, LocalVar>,
    scope: QuoteScope,
    bound?: ReadonlyMap<string, LocalVar>
  ): QPat {
    const sub = (inner: Pat): QPat => this.pat(inner, binders, scope, bound);
    switch (pat.kind) {
      case 'pvar': {
        return { k: 'var', local: this.patBinder(pat.name, binders, bound) };
      }
      case 'pwild': {
        return { k: 'wild' };
      }
      case 'plit': {
        return { k: 'lit', lit: pat.lit, negative: pat.negative };
      }
      case 'pcon': {
        if (!pat.con.qualifier && pat.con.name === '()' && pat.args.length === 0) return { k: 'tuple', elems: [] };
        return { k: 'con', con: this.conRef(pat.con, scope, true), args: pat.args.map(sub) };
      }
      case 'ptuple':
      case 'plist': {
        return { k: pat.kind === 'ptuple' ? 'tuple' : 'list', elems: pat.elems.map(sub) };
      }
      case 'pas': {
        const local = this.patBinder(pat.name, binders, bound);
        return { k: 'as', local, pat: sub(pat.pat) };
      }
      case 'precord': {
        if (pat.wildcard) throw this.unsupportedIn(pat.span, 'レコードのワイルドカード');
        const fields = pat.fields.map((field) => ({
          field: this.valueRef(field.field, scope, 'value', true),
          pat: sub(field.pat),
        }));
        return { k: 'record', con: this.conRef(pat.con, scope, true), fields };
      }
      case 'pchain': {
        const operators = new Set(pat.items.flatMap((item) => (item.kind === 'operator' ? [item.op] : [])));
        const infix = (node: Pat): QPat => {
          if (node.kind !== 'pcon' || !operators.has(node.con as Operator)) return sub(node);
          const left = infix(node.args[0]);
          return { k: 'infix', left, con: this.conRef(node.con, scope, true), right: infix(node.args[1]) };
        };
        return infix(resolvePatChain(pat.items, pat.span, (op) => this.fixity(op, scope)));
      }
      case 'pbang':
      case 'plazy': {
        return { k: pat.kind === 'pbang' ? 'bang' : 'lazy', pat: sub(pat.pat) };
      }
      case 'pview': {
        const expr = this.expr(pat.expr, this.withValues(scope, binders.values()));
        return { k: 'view', expr, pat: sub(pat.pat) };
      }
      case 'psig': {
        return { k: 'sig', pat: sub(pat.pat), type: this.type(pat.type, scope) };
      }
      default: {
        throw this.unsupportedIn(pat.span, 'このパターン');
      }
    }
  }

  private patBinder(name: Name, binders: Map<string, LocalVar>, bound?: ReadonlyMap<string, LocalVar>): LocalVar {
    const local = bound?.get(name.name);
    if (local) return local;
    if (binders.has(name.name)) throw compileError(name.span, `パターンの中で ${name.name} が重複しています。`);
    const created = this.bindValue(name);
    binders.set(name.name, created);
    return created;
  }

  // Types

  // code-gauge-allow functionCognitiveComplexity -- One case per kind of type a quote may hold.
  // code-gauge-allow functionNcss -- One case per kind of type a quote may hold.
  private type(type: TypeExpr, scope: QuoteScope): QType {
    switch (type.kind) {
      case 'tsplice': {
        return { k: 'splice', code: type.expr };
      }
      case 'tvar': {
        return { k: 'var', ref: this.tyVarRef(type.name, scope) };
      }
      case 'tcon': {
        const { name } = type.name;
        if (!type.name.qualifier && name === '[]') return { k: 'list' };
        if (!type.name.qualifier && name === '->') return { k: 'arrow' };
        const tuple = /^\((,*)\)$/.exec(name);
        if (!type.name.qualifier && tuple) return { k: 'tupleCon', arity: tuple[1].length + (tuple[1] ? 1 : 0) };
        return { k: 'con', ref: this.typeRef(type.name, scope) };
      }
      case 'tapp': {
        return { k: 'app', fn: this.type(type.fn, scope), arg: this.type(type.arg, scope) };
      }
      case 'tfun': {
        if (type.multiplicity) throw this.unsupportedIn(type.span, '線形型の矢印');
        const from: QType = { k: 'app', fn: { k: 'arrow' }, arg: this.type(type.from, scope) };
        return { k: 'app', fn: from, arg: this.type(type.to, scope) };
      }
      case 'tlist': {
        return { k: 'app', fn: { k: 'list' }, arg: this.type(type.elem, scope) };
      }
      case 'ttuple': {
        let result: QType = { k: 'tupleCon', arity: type.elems.length };
        for (const elem of type.elems) result = { k: 'app', fn: result, arg: this.type(elem, scope) };
        return result;
      }
      case 'tlit': {
        return { k: 'lit', value: type.value };
      }
      case 'tforall': {
        return this.forall(type.binders, type.context, type.body, scope);
      }
      default: {
        throw this.unsupportedIn(type.span, 'この型');
      }
    }
  }

  /** A signature's type, quantified over the variables it names that nothing outside binds, as GHC gives it. */
  private sigType(sig: SigType, scope: QuoteScope): QType {
    const binders =
      sig.forall ??
      freeTypeVars([...sig.context, sig.type])
        .filter((name) => !scope.tyVars.has(name))
        .map((name): TyVarBinder => ({ name: { name, span: sig.span } }));
    if (binders.length === 0 && sig.context.length === 0) return this.type(sig.type, scope);
    return this.forall(binders, sig.context, sig.type, scope);
  }

  private forall(binders: TyVarBinder[], context: TypeExpr[], body: TypeExpr, scope: QuoteScope): QType {
    const tyVars = binders.map((binder): QTyVar => {
      const local = this.globals.newLocal(binder.name.name, binder.name.span);
      return { local, flag: binder.inferred ? 'inferred' : 'specified', star: binder.kind && this.star(binder.kind) };
    });
    const inner = this.withTyVars(
      scope,
      tyVars.map((tyVar) => tyVar.local)
    );
    return {
      k: 'forall',
      binders: tyVars,
      context: context.map((constraint) => this.type(constraint, inner)),
      body: this.type(body, inner),
    };
  }

  /** Whether a binder's kind is `Type`, the one kind the trees of quotes hold. */
  private star(kind: TypeExpr): true {
    if (kind.kind === 'tcon' && (kind.name.name === 'Type' || kind.name.name === '*')) return true;
    throw this.unsupportedIn(kind.span, 'この種類の注釈');
  }

  /** The type variables a declaration's head binds, each of which it requires. */
  private headTyVars(params: Name[]): QTyVar[] {
    return params.map((param) => ({ local: this.globals.newLocal(param.name, param.span), flag: 'required' }));
  }

  // Declarations

  /**
   * A group of declarations, which see what each other binds, as the code after the group does: with the fixities the
   * group declares, which its operators otherwise lack.
   */
  private declGroup(decls: Decl[], parent: QuoteScope): { decls: QDecls; scope: QuoteScope } {
    const names = new GroupNames(parent, (name) => this.bindValue(name), this.globals.newLocal);
    for (const [index, decl] of decls.entries()) names.declare(decl, decls[index - 1]);
    for (const decl of decls) if (decl.kind === 'fixity') names.applyFixity(decl);
    const scope = { ...this.withValues(parent, names.values.values()), cons: names.cons, types: names.types };
    const renamed = this.bindings(decls, scope, (name) => this.valueRef(name, scope, 'var'), names.values);
    const binders = names.binders.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { decls: { binders, decls: renamed }, scope };
  }

  /**
   * Declarations: equations (consecutive ones of a function together), signatures, fixities, and the declarations of
   * types, classes, and instances. `nameOf` gives what an equation or signature defines.
   */
  private bindings(
    decls: Decl[],
    scope: QuoteScope,
    nameOf: (name: Name) => QRef,
    bound?: ReadonlyMap<string, LocalVar>
  ): QDecl[] {
    const result: QDecl[] = [];
    for (let index = 0; index < decls.length; index++) {
      const decl = decls[index];
      if (decl.kind !== 'funClause') {
        result.push(...this.decl(decl, scope, nameOf, bound));
        continue;
      }
      const clauses = [decl];
      while (decls[index + 1]?.kind === 'funClause' && (decls[index + 1] as typeof decl).name.name === decl.name.name) {
        clauses.push(decls[++index] as typeof decl);
      }
      result.push({ k: 'fun', name: nameOf(decl.name), clauses: clauses.map((clause) => this.clause(clause, scope)) });
    }
    return result;
  }

  private clause(clause: Extract<Decl, { kind: 'funClause' }>, scope: QuoteScope): QClause {
    const binders = new Map<string, LocalVar>();
    const pats = clause.args.map((arg) => this.pat(arg, binders, scope));
    return { pats, ...this.rhs(clause.rhs, this.withValues(scope, binders.values())) };
  }

  private decl(
    decl: Decl,
    scope: QuoteScope,
    nameOf: (name: Name) => QRef,
    bound?: ReadonlyMap<string, LocalVar>
  ): QDecl[] {
    switch (decl.kind) {
      case 'sig': {
        const type = this.sigType(decl.sig, scope);
        return decl.names.map((name): QDecl => ({ k: 'sig', name: nameOf(name), type }));
      }
      case 'patBind': {
        const pat = this.pat(decl.pat, new Map(), scope, bound);
        return [{ k: 'val', pat, ...this.rhs(decl.rhs, scope) }];
      }
      case 'fixity': {
        return decl.ops.map((op): QDecl => {
          const local = scope.values.lookup(op.name) ?? scope.cons.get(op.name);
          const name: QRef = local ? { k: 'bound', local } : { k: 'unbound', name: op.name };
          return { k: 'fixity', assoc: decl.assoc, prec: decl.prec, name };
        });
      }
      case 'data': {
        return [this.dataDecl(decl, scope)];
      }
      case 'typeSyn': {
        const params = this.headTyVars(decl.params);
        const inner = this.withTyVars(
          scope,
          params.map((param) => param.local)
        );
        return [{ k: 'tySyn', name: this.typeRef(decl.name, scope), params, type: this.type(decl.type, inner) }];
      }
      case 'class': {
        return [this.classDecl(decl, scope)];
      }
      case 'instance': {
        return [this.instanceDecl(decl, scope)];
      }
      default: {
        throw this.unsupportedIn(decl.span, 'この宣言');
      }
    }
  }

  private dataDecl(decl: Extract<Decl, { kind: 'data' }>, scope: QuoteScope): QDecl {
    if (decl.instanceOf || decl.kindSig) throw this.unsupportedIn(decl.span, 'この data 宣言');
    const params = this.headTyVars(decl.params);
    const inner = this.withTyVars(
      scope,
      params.map((param) => param.local)
    );
    return {
      k: 'data',
      flavour: decl.typeData ? 'typeData' : decl.newtype ? 'newtype' : 'data',
      context: (decl.datatypeContext ?? []).map((constraint) => this.type(constraint, inner)),
      name: this.typeRef(decl.name, scope),
      params,
      cons: decl.cons.map((con) => this.con(con, inner)),
      deriving: decl.deriving.map((clause) => ({
        strategy: clause.strategy,
        via: clause.via && this.type(clause.via, inner),
        cls: { k: 'con', ref: this.typeRef(clause.cls, scope) },
      })),
    };
  }

  private con(con: ConDecl, scope: QuoteScope): QCon {
    if (con.exVars || con.context || con.result) throw this.unsupportedIn(con.span, 'この構成子');
    const fields = con.fields.map((type, index) => {
      const fieldName = con.fieldNames?.[index];
      return {
        name: fieldName && this.valueRef(fieldName, scope, 'value', true),
        strict: con.strictFields?.includes(index) ?? false,
        type: this.type(type, scope),
      };
    });
    return { name: this.conRef(con.name, scope, true), fields, infix: con.isInfix && !con.fieldNames };
  }

  private classDecl(decl: Extract<Decl, { kind: 'class' }>, scope: QuoteScope): QDecl {
    if (decl.paramKinds?.some(Boolean)) throw this.unsupportedIn(decl.span, 'この class 宣言');
    const params = this.headTyVars(decl.params);
    const inner = this.withTyVars(
      scope,
      params.map((param) => param.local)
    );
    const tyVar = (name: Name): QRef => this.tyVarRef(name.name, inner);
    return {
      k: 'class',
      context: decl.context.map((constraint) => this.type(constraint, inner)),
      name: this.typeRef(decl.name, scope),
      params,
      fundeps: decl.fundeps.map((fundep) => ({ from: fundep.from.map(tyVar), to: fundep.to.map(tyVar) })),
      decls: this.bindings(decl.decls, inner, (name) => this.valueRef(name, inner, 'var')),
    };
  }

  private instanceDecl(decl: Extract<Decl, { kind: 'instance' }>, scope: QuoteScope): QDecl {
    if (decl.overlap) throw this.unsupportedIn(decl.span, 'この instance 宣言');
    const binders = freeTypeVars([...decl.context, ...decl.types])
      .filter((name) => !scope.tyVars.has(name))
      .map((name) => this.globals.newLocal(name, decl.span));
    const inner = this.withTyVars(scope, binders);
    let head: QType = { k: 'con', ref: this.typeRef(decl.cls, scope) };
    for (const type of decl.types) head = { k: 'app', fn: head, arg: this.type(type, inner) };
    return {
      k: 'instance',
      binders,
      context: decl.context.map((constraint) => this.type(constraint, inner)),
      head,
      // An instance defines its class's methods by their names.
      decls: this.bindings(decl.decls, inner, (name) => ({ k: 'unbound', name: name.name })),
    };
  }
}

/** The names a declaration group binds, by namespace, with those it gives new names. */
class GroupNames {
  readonly values = new Map<string, LocalVar>();
  readonly cons: Map<string, LocalVar>;
  readonly types: Map<string, LocalVar>;
  readonly binders: LocalVar[] = [];

  constructor(
    parent: QuoteScope,
    private readonly bindValue: (name: Name) => LocalVar,
    private readonly newLocal: (name: string, span: Span) => LocalVar
  ) {
    this.cons = new Map(parent.cons);
    this.types = new Map(parent.types);
  }

  /** Declares what a declaration binds; an equation after one of the same function binds nothing more. */
  // code-gauge-allow functionCognitiveComplexity -- One short case per kind of declaration that binds names.
  declare(decl: Decl, previous: Decl | undefined): void {
    switch (decl.kind) {
      case 'funClause': {
        if (previous?.kind !== 'funClause' || previous.name.name !== decl.name.name) this.value(decl.name);
        break;
      }
      case 'patBind': {
        for (const name of patternNames(decl.pat)) this.value(name);
        break;
      }
      case 'data': {
        this.other(this.types, decl.name);
        for (const con of decl.cons) this.other(this.cons, con.name);
        const fields = decl.cons.flatMap((con) => con.fieldNames ?? []);
        for (const field of fields) if (!this.values.has(field.name)) this.value(field);
        break;
      }
      case 'typeSyn': {
        this.other(this.types, decl.name);
        break;
      }
      case 'class': {
        this.other(this.types, decl.name);
        // A class's methods keep their names, which the instances define them by.
        const methods = decl.decls.flatMap((member) => (member.kind === 'sig' ? member.names : []));
        for (const name of methods) this.value(name, false);
        break;
      }
      default: {
        break;
      }
    }
  }

  applyFixity(decl: Extract<Decl, { kind: 'fixity' }>): void {
    for (const op of decl.ops) {
      const local = this.values.get(op.name) ?? this.cons.get(op.name);
      if (!local) throw compileError(op.span, `結合性を宣言した ${op.name} の定義がありません。`);
      if (local.fixity) throw compileError(op.span, `${op.name} の結合性が重複して宣言されています。`);
      local.fixity = { assoc: decl.assoc, prec: decl.prec };
    }
  }

  private value(name: Name, binds = true): void {
    if (this.values.has(name.name)) throw compileError(name.span, `${name.name} が重複して定義されています。`);
    const local = this.bindValue(name);
    this.values.set(name.name, local);
    if (binds) this.binders.push(local);
  }

  private other(into: Map<string, LocalVar>, name: Name): void {
    const local = this.newLocal(name.name, name.span);
    into.set(name.name, local);
    this.binders.push(local);
  }
}

/** The variables a pattern binds, in order. */
export function patternNames(pat: Pat): Name[] {
  switch (pat.kind) {
    case 'pvar': {
      return [pat.name];
    }
    case 'pas': {
      return [pat.name, ...patternNames(pat.pat)];
    }
    case 'pcon': {
      return pat.args.flatMap(patternNames);
    }
    case 'ptuple':
    case 'plist': {
      return pat.elems.flatMap(patternNames);
    }
    case 'precord': {
      return pat.fields.flatMap((field) => patternNames(field.pat));
    }
    case 'pchain': {
      return pat.items.flatMap((item) => (item.kind === 'operand' ? patternNames(item.value) : []));
    }
    case 'pbang':
    case 'plazy':
    case 'pview':
    case 'psig': {
      return patternNames(pat.pat);
    }
    default: {
      return [];
    }
  }
}

/** The type variables types name, in order. */
function freeTypeVars(types: TypeExpr[]): string[] {
  const names: string[] = [];
  const visit = (type: TypeExpr): void => {
    switch (type.kind) {
      case 'tvar': {
        if (!names.includes(type.name)) names.push(type.name);
        return;
      }
      case 'tapp': {
        visit(type.fn);
        visit(type.arg);
        return;
      }
      case 'tfun': {
        visit(type.from);
        visit(type.to);
        return;
      }
      case 'tlist': {
        visit(type.elem);
        return;
      }
      case 'ttuple': {
        for (const elem of type.elems) visit(elem);
        return;
      }
      default: {
        return;
      }
    }
  };
  for (const type of types) visit(type);
  return names;
}
