import { unsupportedError } from './errors';
import type {
  LocalVar,
  QBody,
  QCon,
  QDecl,
  QDecls,
  QDeriving,
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
import type { Expr, Literal, Span, Stmt } from './syntax';
import { chargeTypeWork } from './typeWorkBudget';

/**
 * Builds the code of a renamed Template Haskell quote: code that builds the quote's tree with the library's functions
 * in a monad of `Quote`, as GHC does. Each variable the quote binds hygienically gets a new name from `newName` where
 * its scope starts; a binder it does not (one of a pattern quote) keeps its spelling, `mkName`.
 */
export class QuoteBuilder {
  private env = new Map<LocalVar, string>();
  private count = 0;

  constructor(private readonly span: Span) {}

  build(quote: QQuote): Expr {
    switch (quote.k) {
      case 'exp': {
        return this.expr(quote.expr);
      }
      case 'pat': {
        return this.pat(quote.pat);
      }
      case 'type': {
        return this.type(quote.type);
      }
      case 'decs': {
        return this.bindAround(quote.decls.binders, () => this.call('sequenceA', this.decls(quote.decls)));
      }
    }
  }

  // Building blocks

  private sup(name: string): Expr {
    return { kind: 'support', name, span: this.span };
  }

  private app(fn: Expr, ...args: Expr[]): Expr {
    let result = fn;
    for (const arg of args) result = { kind: 'app', fn: result, arg, span: this.span };
    return result;
  }

  private call(name: string, ...args: Expr[]): Expr {
    return this.app(this.sup(name), ...args);
  }

  private str(text: string): Expr {
    return thString(this.span, text);
  }

  private int(value: bigint | number): Expr {
    return { kind: 'lit', lit: { kind: 'int', value: BigInt(value) }, span: this.span };
  }

  private list(elems: Expr[]): Expr {
    return { kind: 'list', elems, span: this.span };
  }

  private local(name: string): Expr {
    return { kind: 'var', name: { name, span: this.span }, span: this.span };
  }

  private maybe(expr?: Expr): Expr {
    return expr ? this.call('Just', expr) : this.sup('Nothing');
  }

  /** A splice's code, which quotes inside it may name the binders in scope here in by their new names. */
  private spliceCode(code: Expr): Expr {
    if (this.env.size === 0) return code;
    const binders = [...this.env].map(([local, nameVariable]) => ({
      name: local.name,
      namespace: local.namespace ?? 'value',
      nameVariable,
    }));
    return { kind: 'quoteLevel', expr: code, binders, span: code.span };
  }

  /** Runs `newName` for each binder, in order, then the code with the new names in scope. */
  private bindAround(binders: readonly LocalVar[], build: () => Expr): Expr {
    if (binders.length === 0) return build();
    const saved = this.env;
    this.env = new Map(saved);
    const stmts: Stmt[] = [];
    for (const binder of binders) {
      const generated = ` th${this.count++} ${binder.name}`;
      this.env.set(binder, generated);
      stmts.push({
        kind: 'bind',
        pat: { kind: 'pvar', name: { name: generated, span: this.span }, span: this.span },
        expr: this.call('newName', this.str(binder.name)),
        span: this.span,
      });
    }
    try {
      stmts.push({ kind: 'exp', expr: build(), span: this.span });
      return { kind: 'do', stmts, span: this.span };
    } finally {
      this.env = saved;
    }
  }

  /** A name as a `Name`: a binder's new name or spelling, a global name, or an unbound name's spelling. */
  private nameOf(ref: QRef): Expr {
    switch (ref.k) {
      case 'bound': {
        const generated = this.env.get(ref.local) ?? ref.local.quoteLevelName;
        return generated ? this.local(generated) : this.call('mkName', this.str(ref.local.name));
      }
      case 'global': {
        return globalNameCode(this.span, ref.space, ref.package, ref.module, ref.name);
      }
      case 'outer': {
        return this.call('mkNameS', this.str(ref.name));
      }
      case 'unbound': {
        return this.call('mkName', this.str(ref.name));
      }
    }
  }

  // Expressions

  // code-gauge-allow functionNcss -- One short case per expression kind.
  private expr(expr: QExpr): Expr {
    switch (expr.k) {
      case 'var':
      case 'con': {
        return this.reference(expr.ref, expr.k === 'con');
      }
      case 'lit': {
        return this.call('litE', this.literal(expr.lit));
      }
      case 'app': {
        return this.call('appE', this.expr(expr.fn), this.expr(expr.arg));
      }
      case 'infix': {
        const operand = (side: QExpr | undefined): Expr => this.maybe(side && this.expr(side));
        return this.call('infixE', operand(expr.left), this.expr(expr.op), operand(expr.right));
      }
      case 'lambda': {
        return this.bindAround(qpatLocals(expr.pats), () =>
          this.call('lamE', this.list(expr.pats.map((pat) => this.pat(pat))), this.expr(expr.body))
        );
      }
      case 'lamCase': {
        return this.call('lamCaseE', this.list(expr.alts.map((alt) => this.match(alt))));
      }
      case 'tupleSection': {
        return this.call('tupSectionE', this.list(expr.elems.map((elem) => this.maybe(elem && this.expr(elem)))));
      }
      case 'let': {
        return this.bindAround(expr.decls.binders, () =>
          this.call('letE', this.decls(expr.decls), this.expr(expr.body))
        );
      }
      case 'if': {
        return this.call('condE', this.expr(expr.cond), this.expr(expr.ifTrue), this.expr(expr.ifFalse));
      }
      case 'multiIf': {
        return this.call('multiIfE', this.list(expr.branches.map((branch) => this.guarded(branch))));
      }
      case 'case': {
        return this.call('caseE', this.expr(expr.scrutinee), this.list(expr.alts.map((alt) => this.match(alt))));
      }
      case 'do':
      case 'comp': {
        return this.stmts(expr.stmts, (stmts) => this.call(expr.k === 'do' ? 'doE' : 'compE', stmts));
      }
      case 'tuple':
      case 'list': {
        return this.call(expr.k === 'tuple' ? 'tupE' : 'listE', this.list(expr.elems.map((elem) => this.expr(elem))));
      }
      default: {
        return this.otherExpr(expr);
      }
    }
  }

  private otherExpr(expr: QExpr): Expr {
    switch (expr.k) {
      case 'arith': {
        const from = this.expr(expr.from);
        if (expr.next && expr.to) return this.call('fromThenToE', from, this.expr(expr.next), this.expr(expr.to));
        if (expr.next) return this.call('fromThenE', from, this.expr(expr.next));
        if (expr.to) return this.call('fromToE', from, this.expr(expr.to));
        return this.call('fromE', from);
      }
      case 'sig': {
        return this.call('sigE', this.expr(expr.expr), this.type(expr.type));
      }
      case 'recordCon': {
        return this.call('recConE', this.nameOf(expr.con), this.fieldExps(expr.fields));
      }
      case 'recordUpdate': {
        return this.call('recUpdE', this.expr(expr.expr), this.fieldExps(expr.fields));
      }
      case 'tyapp': {
        return this.call('appTypeE', this.expr(expr.expr), this.type(expr.type));
      }
      case 'splice': {
        return this.spliceCode(expr.code);
      }
      default: {
        throw new Error(`Unexpected quoted expression: ${expr.k}`);
      }
    }
  }

  /**
   * A variable or constructor: a binder's tree, a global one's, a variable around the quote as its value lifted, or
   * an unbound name, which the code the tree is spliced into binds.
   */
  private reference(ref: QRef, constructor: boolean): Expr {
    switch (ref.k) {
      case 'bound': {
        return this.call(constructor ? 'conE' : 'varE', this.nameOf(ref));
      }
      case 'global': {
        return this.call(
          ref.space === 'd' ? 'quoteGlobalCon' : 'quoteGlobalVar',
          this.str(ref.package),
          this.str(ref.module),
          this.str(ref.name)
        );
      }
      case 'outer': {
        return this.call('lift', this.local(ref.name));
      }
      case 'unbound': {
        return this.call(constructor ? 'conE' : 'unboundVarE', this.nameOf(ref));
      }
    }
  }

  private fieldExps(fields: { field: QRef; value: QExpr }[]): Expr {
    return this.list(fields.map((field) => this.call('fieldExp', this.nameOf(field.field), this.expr(field.value))));
  }

  private literal(lit: Literal, negative = false): Expr {
    switch (lit.kind) {
      case 'int': {
        return this.call('integerL', this.int(negative ? -lit.value : lit.value));
      }
      case 'char': {
        return this.call('charL', { kind: 'lit', lit, span: this.span });
      }
      case 'string': {
        return this.call('stringL', { kind: 'lit', lit, span: this.span });
      }
      case 'frac': {
        const [numerator, denominator] = exactFraction(lit.text);
        const ratio = this.app(this.sup('%'), this.int(negative ? -numerator : numerator), this.int(denominator));
        return this.call('rationalL', ratio);
      }
    }
  }

  private match(alt: QMatch): Expr {
    return this.bindAround(qpatLocals([alt.pat]), () =>
      this.bindAround(alt.where.binders, () =>
        this.call('match', this.pat(alt.pat), this.body(alt.body), this.decls(alt.where))
      )
    );
  }

  private body(body: QBody): Expr {
    if (body.k === 'plain') return this.call('normalB', this.expr(body.expr));
    return this.call('guardedB', this.list(body.branches.map((branch) => this.guarded(branch))));
  }

  private guarded(branch: QGuarded): Expr {
    const [first] = branch.guards;
    if (branch.guards.length === 1 && first.k === 'exp') {
      return this.call('normalGE', this.expr(first.expr), this.expr(branch.expr));
    }
    // The guarded expression sees every guard's variables.
    return this.stmts(branch.guards, (list) => this.call('patGE', list, this.expr(branch.expr)));
  }

  /** Statements, each inside the new names of the variables the statements before it bind. */
  private stmts(stmts: QStmt[], build: (list: Expr) => Expr, done: Expr[] = []): Expr {
    const [stmt, ...rest] = stmts;
    if (!stmt) return build(this.list(done));
    switch (stmt.k) {
      case 'bind': {
        const expr = this.expr(stmt.expr);
        return this.bindAround(qpatLocals([stmt.pat]), () =>
          this.stmts(rest, build, [...done, this.call('bindS', this.pat(stmt.pat), expr)])
        );
      }
      case 'let': {
        return this.bindAround(stmt.decls.binders, () =>
          this.stmts(rest, build, [...done, this.call('letS', this.decls(stmt.decls))])
        );
      }
      case 'exp': {
        return this.stmts(rest, build, [...done, this.call('noBindS', this.expr(stmt.expr))]);
      }
    }
  }

  // Patterns

  private pat(pat: QPat): Expr {
    switch (pat.k) {
      case 'var': {
        return this.call('varP', this.nameOf({ k: 'bound', local: pat.local }));
      }
      case 'wild': {
        return this.sup('wildP');
      }
      case 'lit': {
        return this.call('litP', this.literal(pat.lit, pat.negative));
      }
      case 'con': {
        return this.call('conP', this.nameOf(pat.con), this.list(pat.args.map((arg) => this.pat(arg))));
      }
      case 'infix': {
        return this.call('infixP', this.pat(pat.left), this.nameOf(pat.con), this.pat(pat.right));
      }
      case 'tuple':
      case 'list': {
        return this.call(pat.k === 'tuple' ? 'tupP' : 'listP', this.list(pat.elems.map((elem) => this.pat(elem))));
      }
      case 'as': {
        return this.call('asP', this.nameOf({ k: 'bound', local: pat.local }), this.pat(pat.pat));
      }
      case 'record': {
        const fields = pat.fields.map((field) => this.call('fieldPat', this.nameOf(field.field), this.pat(field.pat)));
        return this.call('recP', this.nameOf(pat.con), this.list(fields));
      }
      case 'bang':
      case 'lazy': {
        return this.call(pat.k === 'bang' ? 'bangP' : 'tildeP', this.pat(pat.pat));
      }
      case 'view': {
        return this.call('viewP', this.expr(pat.expr), this.pat(pat.pat));
      }
      case 'sig': {
        return this.call('sigP', this.pat(pat.pat), this.type(pat.type));
      }
    }
  }

  // Types

  private type(type: QType): Expr {
    switch (type.k) {
      case 'var':
      case 'con': {
        return this.call(type.k === 'var' ? 'varT' : 'conT', this.nameOf(type.ref));
      }
      case 'list': {
        return this.sup('listT');
      }
      case 'arrow': {
        return this.sup('arrowT');
      }
      case 'star':
      case 'constraint': {
        return this.call('pure', this.kindTree(type));
      }
      case 'tupleCon': {
        return this.call('tupleT', this.int(type.arity));
      }
      case 'app': {
        return this.call('appT', this.type(type.fn), this.type(type.arg));
      }
      case 'lit': {
        const literal =
          typeof type.value === 'bigint'
            ? this.call('numTyLit', this.int(type.value))
            : this.call('strTyLit', this.str(type.value));
        return this.call('litT', literal);
      }
      case 'forall': {
        return this.bindAround(
          type.binders.map((binder) => binder.local),
          () => this.call('forallT', this.tyVars(type.binders), this.context(type.context), this.type(type.body))
        );
      }
      case 'splice': {
        return this.spliceCode(type.code);
      }
    }
  }

  private tyVars(binders: QTyVar[]): Expr {
    return this.list(
      binders.map((binder) => {
        const name = this.nameOf({ k: 'bound', local: binder.local });
        const flag = this.sup(
          { required: 'BndrReq', inferred: 'InferredSpec', specified: 'SpecifiedSpec' }[binder.flag]
        );
        return binder.kind
          ? this.call('KindedTV', name, flag, this.kindTree(binder.kind))
          : this.call('PlainTV', name, flag);
      })
    );
  }

  /** A kind as the tree itself, which a binder holds outside the monad the code builds trees in. */
  private kindTree(kind: QType): Expr {
    switch (kind.k) {
      case 'star': {
        return this.sup('StarT');
      }
      case 'constraint': {
        return this.sup('ConstraintT');
      }
      case 'arrow': {
        return this.sup('ArrowT');
      }
      case 'list': {
        return this.sup('ListT');
      }
      case 'tupleCon': {
        return this.call('TupleT', this.int(kind.arity));
      }
      case 'var':
      case 'con': {
        return this.call(kind.k === 'var' ? 'VarT' : 'ConT', this.nameOf(kind.ref));
      }
      case 'app': {
        return this.call('AppT', this.kindTree(kind.fn), this.kindTree(kind.arg));
      }
      default: {
        throw unsupportedError(this.span, 'Template Haskell のクォートの中のこの種類の注釈');
      }
    }
  }

  private context(constraints: QType[]): Expr {
    return this.call('cxt', this.list(constraints.map((constraint) => this.type(constraint))));
  }

  // Declarations

  private decls(group: QDecls): Expr {
    return this.list(group.decls.map((decl) => this.decl(decl)));
  }

  private decl(decl: QDecl): Expr {
    switch (decl.k) {
      case 'fun': {
        const [first] = decl.clauses;
        if (decl.clauses.length === 1 && first.pats.length === 0) {
          return this.bindAround(first.where.binders, () =>
            this.call('valD', this.call('varP', this.nameOf(decl.name)), this.body(first.body), this.decls(first.where))
          );
        }
        const clauses = decl.clauses.map((clause) =>
          this.bindAround(qpatLocals(clause.pats), () =>
            this.bindAround(clause.where.binders, () =>
              this.call(
                'clause',
                this.list(clause.pats.map((pat) => this.pat(pat))),
                this.body(clause.body),
                this.decls(clause.where)
              )
            )
          )
        );
        return this.call('funD', this.nameOf(decl.name), this.list(clauses));
      }
      case 'val': {
        return this.bindAround(decl.where.binders, () =>
          this.call('valD', this.pat(decl.pat), this.body(decl.body), this.decls(decl.where))
        );
      }
      case 'sig': {
        return this.call(decl.isDefault ? 'defaultSigD' : 'sigD', this.nameOf(decl.name), this.type(decl.type));
      }
      case 'fixity': {
        const fn = { infixl: 'infixLD', infixr: 'infixRD', infix: 'infixND' }[decl.assoc];
        return this.call(fn, this.int(decl.prec), this.nameOf(decl.name));
      }
      default: {
        return this.headedDecl(decl);
      }
    }
  }

  /** The declarations of types, classes, and instances, inside the new names of the type variables they bind. */
  private headedDecl(decl: QDecl): Expr {
    switch (decl.k) {
      case 'data': {
        return this.bindAround(
          decl.params.map((param) => param.local),
          () => {
            const name = this.nameOf(decl.name);
            const tyVars = this.tyVars(decl.params);
            const cons = decl.cons.map((con) => this.con(con));
            if (decl.flavour === 'typeData') return this.call('typeDataD', name, tyVars, this.maybe(), this.list(cons));
            const derivs = this.list(decl.deriving.map((clause) => this.deriving(clause)));
            const context = this.context(decl.context);
            if (decl.flavour === 'newtype') {
              return this.call('newtypeD', context, name, tyVars, this.maybe(), cons[0], derivs);
            }
            return this.call('dataD', context, name, tyVars, this.maybe(), this.list(cons), derivs);
          }
        );
      }
      case 'tySyn': {
        return this.bindAround(
          decl.params.map((param) => param.local),
          () => this.call('tySynD', this.nameOf(decl.name), this.tyVars(decl.params), this.type(decl.type))
        );
      }
      case 'class': {
        return this.bindAround(
          decl.params.map((param) => param.local),
          () => {
            const names = (refs: QRef[]): Expr => this.list(refs.map((ref) => this.nameOf(ref)));
            const fundeps = decl.fundeps.map((fundep) => this.call('FunDep', names(fundep.from), names(fundep.to)));
            return this.call(
              'classD',
              this.context(decl.context),
              this.nameOf(decl.name),
              this.tyVars(decl.params),
              this.list(fundeps),
              this.list(decl.decls.map((member) => this.decl(member)))
            );
          }
        );
      }
      case 'instance': {
        return this.bindAround(decl.binders, () =>
          this.call(
            'instanceD',
            this.context(decl.context),
            this.type(decl.head),
            this.list(decl.decls.map((member) => this.decl(member)))
          )
        );
      }
      default: {
        throw new Error(`Unexpected quoted declaration: ${decl.k}`);
      }
    }
  }

  private deriving(clause: QDeriving): Expr {
    const classes = this.list([this.type(clause.cls)]);
    if (clause.strategy === 'via' && clause.via) return this.call('quoteDerivVia', this.type(clause.via), classes);
    const strategy =
      clause.strategy && this.sup(`${clause.strategy[0].toUpperCase()}${clause.strategy.slice(1)}Strategy`);
    return this.call('derivClause', this.maybe(strategy), classes);
  }

  private con(con: QCon): Expr {
    const bangType = (field: QCon['fields'][number]): Expr =>
      this.call(
        'bangType',
        this.call(
          'bang',
          this.sup('noSourceUnpackedness'),
          this.sup({ strict: 'sourceStrict', lazy: 'sourceLazy', none: 'noSourceStrictness' }[field.bang ?? 'none'])
        ),
        this.type(field.type)
      );
    if (con.fields.some((field) => field.name)) {
      const fields = con.fields.map((field) =>
        this.call('varBangType', this.nameOf(field.name as QRef), bangType(field))
      );
      return this.call('recC', this.nameOf(con.name), this.list(fields));
    }
    if (con.infix && con.fields.length === 2) {
      return this.call('infixC', bangType(con.fields[0]), this.nameOf(con.name), bangType(con.fields[1]));
    }
    return this.call('normalC', this.nameOf(con.name), this.list(con.fields.map(bangType)));
  }
}

/** The variables patterns bind, in order. */
// code-gauge-allow functionNcss -- One short case per pattern kind.
function qpatLocals(pats: QPat[]): LocalVar[] {
  const locals: LocalVar[] = [];
  const visit = (pat: QPat): void => {
    switch (pat.k) {
      case 'var': {
        locals.push(pat.local);
        return;
      }
      case 'as': {
        locals.push(pat.local);
        visit(pat.pat);
        return;
      }
      case 'con':
      case 'tuple':
      case 'list': {
        for (const arg of pat.k === 'con' ? pat.args : pat.elems) visit(arg);
        return;
      }
      case 'infix': {
        visit(pat.left);
        visit(pat.right);
        return;
      }
      case 'record': {
        for (const field of pat.fields) visit(field.pat);
        return;
      }
      case 'bang':
      case 'lazy':
      case 'view':
      case 'sig': {
        visit(pat.pat);
        return;
      }
      default: {
        return;
      }
    }
  };
  for (const pat of pats) visit(pat);
  return locals;
}

/** A global name as code building its `Name`, `mkNameG_v`, `mkNameG_d`, or `mkNameG_tc`. */
export function globalNameCode(
  span: Span,
  space: 'v' | 'd' | 'tc',
  package_: string,
  module: string,
  name: string
): Expr {
  let result: Expr = { kind: 'support', name: `mkNameG_${space}`, span };
  for (const arg of [package_, module, name]) result = { kind: 'app', fn: result, arg: thString(span, arg), span };
  return result;
}

export function thString(span: Span, text: string): Expr {
  return { kind: 'lit', lit: { kind: 'string', value: [...text] }, span };
}

/** The fraction a decimal literal's text stands for, exactly: `2.5` is 5/2. */
function exactFraction(text: string): [bigint, bigint] {
  const cleaned = text.replaceAll('_', '');
  const match = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(cleaned);
  if (!match) return [BigInt(Math.round(Number(cleaned) * 1e9)), 1_000_000_000n];
  const digits = BigInt(`${match[1] || '0'}${match[2] ?? ''}`);
  const exponent = BigInt(match[3] ?? 0) - BigInt(match[2]?.length ?? 0);
  // The power of ten has as many digits as the exponent says, which the compilation pays for before it is built.
  chargeTypeWork(Number(exponent < 0n ? -exponent : exponent));
  const numerator = exponent > 0n ? digits * 10n ** exponent : digits;
  const denominator = exponent < 0n ? 10n ** -exponent : 1n;
  const divisor = gcd(numerator, denominator);
  return [numerator / divisor, denominator / divisor];
}

function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [a < 0n ? -a : a, b];
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}
