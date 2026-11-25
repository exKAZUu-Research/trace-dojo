import { compileError, unsupportedError } from './errors';
import type {
  Alt,
  ChainItem,
  ConDecl,
  Decl,
  Expr,
  Guard,
  Literal,
  Name,
  Operator,
  Pat,
  QName,
  Rhs,
  SigType,
  Span,
  Stmt,
  TypeExpr,
  TyVarBinder,
} from './syntax';
import { chargeTypeWork } from './typeWorkBudget';

/**
 * Template Haskell's quotes, `[| e |]` and the like, as code that builds the syntax trees with the library's
 * functions in a monad of `Quote`, as GHC does: each variable the quote binds gets a new name from `newName`, a
 * variable of the program outside the quote becomes its value lifted with `lift`, and a global name becomes the name
 * GHC gives it. The renamer completes what needs the program's scope: `thVar`, `thName`, and `thChain`.
 */
export class QuoteBuilder {
  /** The variables the quote binds, by their names, with the variables of the generated code holding their names. */
  private env = new Map<string, string>();
  private count = 0;

  constructor(private readonly span: Span) {}

  expression(expr: Expr): Expr {
    return this.expr(expr);
  }

  pattern(pat: Pat): Expr {
    return this.bindAround(this.binders([pat]), () => this.pat(pat));
  }

  type(type: TypeExpr): Expr {
    return this.typ(type);
  }

  declarations(decls: Decl[]): Expr {
    return this.bindAround(this.declBinders(decls), () => this.call('sequenceA', this.list(this.decls(decls))));
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
    return { kind: 'lit', lit: { kind: 'string', value: [...text] }, span: this.span };
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

  private just(expr: Expr): Expr {
    return this.call('Just', expr);
  }

  private nothing(): Expr {
    return this.sup('Nothing');
  }

  private nameOf(name: string): Expr {
    const generated = this.env.get(name);
    return generated ? this.local(generated) : this.call('mkName', this.str(name));
  }

  /** Runs `newName` for each name the code binds, in order, then the code with the names in scope. */
  private bindAround(names: string[], build: () => Expr): Expr {
    if (names.length === 0) return build();
    const saved = this.env;
    this.env = new Map(saved);
    const stmts: Stmt[] = [];
    for (const name of names) {
      const generated = ` th${this.count++} ${name}`;
      this.env.set(name, generated);
      stmts.push({
        kind: 'bind',
        pat: { kind: 'pvar', name: { name: generated, span: this.span }, span: this.span },
        expr: this.call('newName', this.str(name)),
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

  private unsupportedIn(span: Span, what: string): Error {
    return unsupportedError(span, `Template Haskell のクォートの中の${what}`);
  }

  // Expressions

  private expr(expr: Expr): Expr {
    switch (expr.kind) {
      case 'var': {
        const generated = expr.name.qualifier ? undefined : this.env.get(expr.name.name);
        if (generated) return this.call('varE', this.local(generated));
        return { kind: 'thVar', name: expr.name, constructor: false, span: expr.span };
      }
      case 'con': {
        const generated = expr.name.qualifier ? undefined : this.env.get(expr.name.name);
        if (generated) return this.call('conE', this.local(generated));
        return { kind: 'thVar', name: expr.name, constructor: true, span: expr.span };
      }
      case 'lit': {
        return this.call('litE', this.literal(expr.lit));
      }
      case 'app': {
        return this.call('appE', this.expr(expr.fn), this.expr(expr.arg));
      }
      case 'paren': {
        return this.expr(expr.expr);
      }
      case 'chain': {
        return this.chain(expr.items, expr.span, false);
      }
      case 'binop': {
        return this.call(
          'infixE',
          this.just(this.expr(expr.left)),
          this.operator(expr.op),
          this.just(this.expr(expr.right))
        );
      }
      case 'neg': {
        return this.call('appE', this.negate(expr.span), this.expr(expr.expr));
      }
      case 'leftSection': {
        return this.call('infixE', this.just(this.expr(expr.left)), this.operator(expr.op), this.nothing());
      }
      case 'rightSection': {
        return this.call('infixE', this.nothing(), this.operator(expr.op), this.just(this.expr(expr.right)));
      }
      case 'lambda': {
        const special = this.lambdaSugar(expr);
        if (special) return special;
        return this.bindAround(this.binders(expr.pats), () =>
          this.call('lamE', this.list(expr.pats.map((pat) => this.pat(pat))), this.expr(expr.body))
        );
      }
      case 'let': {
        return this.bindAround(this.declBinders(expr.decls), () =>
          this.call('letE', this.list(this.decls(expr.decls)), this.expr(expr.body))
        );
      }
      case 'if': {
        return this.call('condE', this.expr(expr.cond), this.expr(expr.ifTrue), this.expr(expr.ifFalse));
      }
      case 'case': {
        return this.caseExpr(expr);
      }
      case 'do': {
        return this.stmts(expr.stmts, (stmts) => this.call('doE', stmts));
      }
      case 'tuple': {
        return this.call('tupE', this.list(expr.elems.map((elem) => this.expr(elem))));
      }
      case 'list': {
        if (expr.elems.length === 0)
          return { kind: 'thVar', name: { name: '[]', span: expr.span }, constructor: true, span: expr.span };
        return this.call('listE', this.list(expr.elems.map((elem) => this.expr(elem))));
      }
      default: {
        return this.otherExpr(expr);
      }
    }
  }

  /** Sequences, comprehensions, signatures, records, type applications, and splices in a quote. */
  private otherExpr(expr: Expr): Expr {
    switch (expr.kind) {
      case 'arith': {
        const from = this.expr(expr.from);
        if (expr.next && expr.to) return this.call('fromThenToE', from, this.expr(expr.next), this.expr(expr.to));
        if (expr.next) return this.call('fromThenE', from, this.expr(expr.next));
        if (expr.to) return this.call('fromToE', from, this.expr(expr.to));
        return this.call('fromE', from);
      }
      case 'comprehension': {
        if (expr.parallel) throw this.unsupportedIn(expr.span, '並列の内包表記');
        const final: Stmt = { kind: 'exp', expr: expr.expr, span: expr.span };
        return this.stmts([...expr.quals, final], (stmts) => this.call('compE', stmts));
      }
      case 'typed': {
        return this.call('sigE', this.expr(expr.expr), this.sigType(expr.sig));
      }
      case 'recordCon': {
        if (expr.wildcard) throw this.unsupportedIn(expr.span, 'レコードのワイルドカード');
        return this.call('recConE', this.globalName(expr.con, 'con'), this.fieldExps(expr.fields));
      }
      case 'recordUpdate': {
        return this.call('recUpdE', this.expr(expr.expr), this.fieldExps(expr.fields));
      }
      case 'tyapp': {
        if (!expr.type) throw this.unsupportedIn(expr.span, '型の適用 @_');
        return this.call('appTypeE', this.expr(expr.expr), this.typ(expr.type));
      }
      case 'thSplice': {
        return expr.expr;
      }
      default: {
        throw this.unsupportedIn(expr.span, 'この式');
      }
    }
  }

  /** `\case` and tuple sections, which the conversion writes as lambdas of generated variables. */
  private lambdaSugar(expr: Extract<Expr, { kind: 'lambda' }>): Expr | undefined {
    const generated = expr.pats.map((pat) =>
      pat.kind === 'pvar' && pat.name.name.includes(' ') ? pat.name.name : undefined
    );
    if (!generated.every(Boolean)) return undefined;
    const { body } = expr;
    if (body.kind === 'case' && body.what === String.raw`\case`) {
      return this.call('lamCaseE', this.list(body.alts.map((alt) => this.match(alt))));
    }
    if (body.kind === 'tuple') {
      const elems = body.elems.map((elem) =>
        elem.kind === 'var' && generated.includes(elem.name.name) ? this.nothing() : this.just(this.expr(elem))
      );
      return this.call('tupSectionE', this.list(elems));
    }
    return undefined;
  }

  private negate(span: Span): Expr {
    return { kind: 'thVar', name: { name: 'negate', span }, constructor: false, span, implicit: true };
  }

  private operator(op: Operator): Expr {
    const generated = op.qualifier ? undefined : this.env.get(op.name);
    if (generated) return this.call('varE', this.local(generated));
    return { kind: 'thVar', name: op, constructor: op.isConstructor, span: op.span };
  }

  private fieldExps(fields: { field: QName; value: Expr }[]): Expr {
    return this.list(
      fields.map((field) => this.call('fieldExp', this.globalName(field.field, 'var'), this.expr(field.value)))
    );
  }

  /** A name the quote refers to: one its own declarations bind, or a global one. */
  private globalName(name: QName, namespace: 'var' | 'con' | 'type'): Expr {
    const generated = name.qualifier ? undefined : this.env.get(name.name);
    if (generated) return this.local(generated);
    return { kind: 'thName', name, namespace, span: name.span };
  }

  private literal(lit: Literal): Expr {
    switch (lit.kind) {
      case 'int': {
        return this.call('integerL', this.int(lit.value));
      }
      case 'char': {
        return this.call('charL', { kind: 'lit', lit, span: this.span });
      }
      case 'string': {
        return this.call('stringL', { kind: 'lit', lit, span: this.span });
      }
      case 'frac': {
        const [numerator, denominator] = exactFraction(lit.text);
        return this.call('rationalL', this.app(this.sup('%'), this.int(numerator), this.int(denominator)));
      }
    }
  }

  /** An operator chain, whose fixities the renamer resolves before it builds `InfixE` or `InfixP`. */
  private chain(items: ChainItem<Expr>[] | ChainItem<Pat>[], span: Span, pattern: boolean): Expr {
    const operators = new Map<Operator, Expr>();
    const built: ChainItem<Expr>[] = items.map((item): ChainItem<Expr> => {
      if (item.kind === 'operand') {
        return { kind: 'operand', value: pattern ? this.pat(item.value as Pat) : this.expr(item.value as Expr) };
      }
      if (item.kind === 'operator') {
        operators.set(item.op, pattern ? this.globalName(item.op, 'con') : this.operator(item.op));
      }
      return item;
    });
    return { kind: 'thChain', items: built, operators, pattern, negate: this.negate(span), span };
  }

  private caseExpr(expr: Extract<Expr, { kind: 'case' }>): Expr {
    if (expr.what === 'multi-way if') {
      const rhs = expr.alts[0]?.rhs;
      if (rhs?.body.kind !== 'guarded') throw compileError(expr.span, '書き方に誤りがあります。');
      return this.call(
        'multiIfE',
        this.list(rhs.body.branches.map((branch) => this.guarded(branch.guards, branch.expr)))
      );
    }
    const matches = this.list(expr.alts.map((alt) => this.match(alt)));
    if (expr.what === String.raw`\case` && expr.scrutinee.kind === 'var') return this.call('lamCaseE', matches);
    return this.call('caseE', this.expr(expr.scrutinee), matches);
  }

  private match(alt: Alt): Expr {
    return this.bindAround(this.binders([alt.pat]), () =>
      this.bindAround(this.declBinders(alt.rhs.where), () =>
        this.call('match', this.pat(alt.pat), this.body(alt.rhs), this.list(this.decls(alt.rhs.where)))
      )
    );
  }

  private body(rhs: Rhs): Expr {
    if (rhs.body.kind === 'plain') return this.call('normalB', this.expr(rhs.body.expr));
    return this.call(
      'guardedB',
      this.list(rhs.body.branches.map((branch) => this.guarded(branch.guards, branch.expr)))
    );
  }

  private guarded(guards: Guard[], expr: Expr): Expr {
    const first = guards[0];
    if (guards.length === 1 && first.kind === 'bool')
      return this.call('normalGE', this.expr(first.expr), this.expr(expr));
    const stmts: Stmt[] = guards.map((guard): Stmt => {
      if (guard.kind === 'bool') return { kind: 'exp', expr: guard.expr, span: guard.span };
      if (guard.kind === 'let') return { kind: 'let', decls: guard.decls, span: guard.span };
      return { kind: 'bind', pat: guard.pat, expr: guard.expr, span: guard.span };
    });
    // The guarded expression sees every guard's variables.
    return this.stmts(stmts, (list) => this.call('patGE', list, this.expr(expr)));
  }

  /** Statements, each binding its variables for the statements after it, given to what builds from their list. */
  /**
   * Statements, each of which sees the variables the statements before it bind: a bind's expression is outside its
   * own pattern's scope, and a `let`'s declarations are inside their own.
   */
  private stmts(stmts: Stmt[], build: (list: Expr) => Expr, done: Expr[] = []): Expr {
    const [stmt, ...rest] = stmts;
    if (!stmt) return build(this.list(done));
    switch (stmt.kind) {
      case 'bind': {
        const expr = this.expr(stmt.expr);
        return this.bindAround(this.binders([stmt.pat]), () =>
          this.stmts(rest, build, [...done, this.call('bindS', this.pat(stmt.pat), expr)])
        );
      }
      case 'let': {
        return this.bindAround(this.declBinders(stmt.decls), () =>
          this.stmts(rest, build, [...done, this.call('letS', this.list(this.decls(stmt.decls)))])
        );
      }
      case 'exp': {
        return this.stmts(rest, build, [...done, this.call('noBindS', this.expr(stmt.expr))]);
      }
      default: {
        throw this.unsupportedIn(stmt.span, 'この文');
      }
    }
  }

  // Patterns

  /** The variables patterns bind, in order. */
  private binders(pats: Pat[]): string[] {
    const names: string[] = [];
    const visit = (pat: Pat): void => {
      switch (pat.kind) {
        case 'pvar': {
          names.push(pat.name.name);
          return;
        }
        case 'pas': {
          names.push(pat.name.name);
          visit(pat.pat);
          return;
        }
        case 'pcon':
        case 'ptuple':
        case 'plist': {
          for (const arg of pat.kind === 'pcon' ? pat.args : pat.elems) visit(arg);
          return;
        }
        case 'precord': {
          for (const field of pat.fields) visit(field.pat);
          return;
        }
        case 'pchain': {
          for (const item of pat.items) if (item.kind === 'operand') visit(item.value);
          return;
        }
        case 'pbang':
        case 'plazy':
        case 'pview':
        case 'psig': {
          visit(pat.pat);
          return;
        }
        default: {
          return;
        }
      }
    };
    for (const pat of pats) visit(pat);
    return names;
  }

  private pat(pat: Pat): Expr {
    switch (pat.kind) {
      case 'pvar': {
        return this.call('varP', this.nameOf(pat.name.name));
      }
      case 'pwild': {
        return this.sup('wildP');
      }
      case 'plit': {
        if (pat.negative && pat.lit.kind === 'int')
          return this.call('litP', this.call('integerL', this.int(-pat.lit.value)));
        if (pat.negative && pat.lit.kind === 'frac') {
          const [numerator, denominator] = exactFraction(pat.lit.text);
          return this.call(
            'litP',
            this.call('rationalL', this.app(this.sup('%'), this.int(-numerator), this.int(denominator)))
          );
        }
        return this.call('litP', this.literal(pat.lit));
      }
      case 'pcon': {
        if (pat.con.name === '()' && pat.args.length === 0) return this.call('tupP', this.list([]));
        return this.call('conP', this.globalName(pat.con, 'con'), this.list(pat.args.map((arg) => this.pat(arg))));
      }
      case 'ptuple': {
        return this.call('tupP', this.list(pat.elems.map((elem) => this.pat(elem))));
      }
      case 'plist': {
        return this.call('listP', this.list(pat.elems.map((elem) => this.pat(elem))));
      }
      case 'pas': {
        return this.call('asP', this.nameOf(pat.name.name), this.pat(pat.pat));
      }
      case 'precord': {
        if (pat.wildcard) throw this.unsupportedIn(pat.span, 'レコードのワイルドカード');
        const fields = pat.fields.map((field) =>
          this.call('fieldPat', this.globalName(field.field, 'var'), this.pat(field.pat))
        );
        return this.call('recP', this.globalName(pat.con, 'con'), this.list(fields));
      }
      case 'pchain': {
        return this.chain(pat.items, pat.span, true);
      }
      case 'pbang': {
        return this.call('bangP', this.pat(pat.pat));
      }
      case 'plazy': {
        return this.call('tildeP', this.pat(pat.pat));
      }
      case 'pview': {
        return this.call('viewP', this.expr(pat.expr), this.pat(pat.pat));
      }
      case 'psig': {
        return this.call('sigP', this.pat(pat.pat), this.typ(pat.type));
      }
      default: {
        throw this.unsupportedIn(pat.span, 'このパターン');
      }
    }
  }

  // Types

  // code-gauge-allow functionCognitiveComplexity -- One case per kind of type a quote may hold.
  private typ(type: TypeExpr): Expr {
    switch (type.kind) {
      case 'tsplice': {
        return type.expr;
      }
      case 'tvar': {
        return this.call('varT', this.nameOf(type.name));
      }
      case 'tcon': {
        const { name } = type.name;
        if (!type.name.qualifier && name === '[]') return this.sup('listT');
        if (!type.name.qualifier && name === '->') return this.sup('arrowT');
        const tuple = /^\((,*)\)$/.exec(name);
        if (!type.name.qualifier && tuple) return this.call('tupleT', this.int(tuple[1].length + (tuple[1] ? 1 : 0)));
        return this.call('conT', this.globalName(type.name, 'type'));
      }
      case 'tapp': {
        return this.call('appT', this.typ(type.fn), this.typ(type.arg));
      }
      case 'tfun': {
        if (type.multiplicity) throw this.unsupportedIn(type.span, '線形型の矢印');
        return this.call('appT', this.call('appT', this.sup('arrowT'), this.typ(type.from)), this.typ(type.to));
      }
      case 'tlist': {
        return this.call('appT', this.sup('listT'), this.typ(type.elem));
      }
      case 'ttuple': {
        let result = this.call('tupleT', this.int(type.elems.length));
        for (const elem of type.elems) result = this.call('appT', result, this.typ(elem));
        return result;
      }
      case 'tlit': {
        const literal =
          typeof type.value === 'bigint'
            ? this.call('numTyLit', this.int(type.value))
            : this.call('strTyLit', this.str(type.value));
        return this.call('litT', literal);
      }
      case 'tforall': {
        return this.forall(
          type.binders.map((binder) => binder.name.name),
          type.context,
          type.body,
          type.binders
        );
      }
      default: {
        throw this.unsupportedIn(type.span, 'この型');
      }
    }
  }

  /** A signature's type, quantified over the variables it names that nothing outside binds, as GHC gives it. */
  private sigType(sig: SigType): Expr {
    const explicit = sig.forall?.map((binder) => binder.name.name);
    const free = explicit ?? freeTypeVars([...sig.context, sig.type]).filter((name) => !this.env.has(name));
    if (free.length === 0 && sig.context.length === 0) return this.typ(sig.type);
    return this.forall(free, sig.context, sig.type, sig.forall);
  }

  private forall(names: string[], context: TypeExpr[], body: TypeExpr, binders?: TyVarBinder[]): Expr {
    return this.bindAround(names, () => {
      const tyVars = names.map((name, index) => {
        const binder = binders?.[index];
        const spec = this.sup(binder?.inferred ? 'InferredSpec' : 'SpecifiedSpec');
        return binder?.kind
          ? this.call('KindedTV', this.nameOf(name), spec, this.typeValue(binder.kind))
          : this.call('PlainTV', this.nameOf(name), spec);
      });
      return this.call(
        'forallT',
        this.list(tyVars),
        this.call('cxt', this.list(context.map((c) => this.typ(c)))),
        this.typ(body)
      );
    });
  }

  /** A kind in a binder, which the trees hold as a plain `Kind`, not in the monad. */
  private typeValue(type: TypeExpr): Expr {
    if (type.kind === 'tcon' && (type.name.name === 'Type' || type.name.name === '*')) return this.sup('StarT');
    throw this.unsupportedIn(type.span, 'この種類の注釈');
  }

  // Declarations

  /** The names declarations bind, in the order GHC gives them new names: by name. */
  private declBinders(decls: Decl[]): string[] {
    const names = new Set<string>();
    for (const decl of decls) {
      if (decl.kind === 'funClause') names.add(decl.name.name);
      else if (decl.kind === 'patBind') for (const name of this.binders([decl.pat])) names.add(name);
      else if (decl.kind === 'data') {
        names.add(decl.name.name);
        for (const con of decl.cons) {
          names.add(con.name.name);
          for (const field of con.fieldNames ?? []) names.add(field.name);
        }
      } else if (decl.kind === 'typeSyn' || decl.kind === 'class') names.add(decl.name.name);
    }
    return [...names].toSorted();
  }

  private decls(decls: Decl[]): Expr[] {
    const result: Expr[] = [];
    for (let index = 0; index < decls.length; index++) {
      const decl = decls[index];
      if (decl.kind === 'funClause') {
        const clauses = [decl];
        while (
          decls[index + 1]?.kind === 'funClause' &&
          (decls[index + 1] as typeof decl).name.name === decl.name.name
        ) {
          clauses.push(decls[++index] as typeof decl);
        }
        result.push(this.function(clauses));
        continue;
      }
      result.push(...this.decl(decl));
    }
    return result;
  }

  private function(clauses: Extract<Decl, { kind: 'funClause' }>[]): Expr {
    const [first] = clauses;
    if (clauses.length === 1 && first.args.length === 0) {
      return this.bindAround(this.declBinders(first.rhs.where), () =>
        this.call(
          'valD',
          this.call('varP', this.nameOf(first.name.name)),
          this.body(first.rhs),
          this.list(this.decls(first.rhs.where))
        )
      );
    }
    const built = clauses.map((clause) =>
      this.bindAround(this.binders(clause.args), () =>
        this.bindAround(this.declBinders(clause.rhs.where), () =>
          this.call(
            'clause',
            this.list(clause.args.map((arg) => this.pat(arg))),
            this.body(clause.rhs),
            this.list(this.decls(clause.rhs.where))
          )
        )
      )
    );
    return this.call('funD', this.nameOf(first.name.name), this.list(built));
  }

  private decl(decl: Decl): Expr[] {
    switch (decl.kind) {
      case 'sig': {
        return decl.names.map((name) => this.call('sigD', this.nameOf(name.name), this.sigType(decl.sig)));
      }
      case 'patBind': {
        return [
          this.bindAround(this.declBinders(decl.rhs.where), () =>
            this.call('valD', this.pat(decl.pat), this.body(decl.rhs), this.list(this.decls(decl.rhs.where)))
          ),
        ];
      }
      case 'data': {
        return [this.dataDecl(decl)];
      }
      case 'typeSyn': {
        return [
          this.bindAround(
            decl.params.map((param) => param.name),
            () => this.call('tySynD', this.nameOf(decl.name.name), this.tyVars(decl.params), this.typ(decl.type))
          ),
        ];
      }
      case 'fixity': {
        const fn = { infixl: 'infixLD', infixr: 'infixRD', infix: 'infixND' }[decl.assoc];
        return decl.ops.map((op) => this.call(fn, this.int(decl.prec), this.nameOf(op.name)));
      }
      case 'instance': {
        if (decl.overlap) throw this.unsupportedIn(decl.span, 'この instance 宣言');
        const free = freeTypeVars([...decl.context, ...decl.types]).filter((name) => !this.env.has(name));
        return [
          this.bindAround(free, () => {
            let head = this.call('conT', this.globalName(decl.cls, 'type'));
            for (const type of decl.types) head = this.call('appT', head, this.typ(type));
            const context = this.call('cxt', this.list(decl.context.map((c) => this.typ(c))));
            return this.call('instanceD', context, head, this.list(this.decls(decl.decls)));
          }),
        ];
      }
      case 'class': {
        if (decl.paramKinds?.some(Boolean)) throw this.unsupportedIn(decl.span, 'この class 宣言');
        return [
          this.bindAround(
            decl.params.map((param) => param.name),
            () => {
              const names = (list: Name[]): Expr => this.list(list.map((name) => this.nameOf(name.name)));
              const fundeps = decl.fundeps.map((fundep) => this.call('FunDep', names(fundep.from), names(fundep.to)));
              return this.call(
                'classD',
                this.call('cxt', this.list(decl.context.map((c) => this.typ(c)))),
                this.nameOf(decl.name.name),
                this.tyVars(decl.params),
                this.list(fundeps),
                this.list(this.decls(decl.decls))
              );
            }
          ),
        ];
      }
      default: {
        throw this.unsupportedIn(decl.span, 'この宣言');
      }
    }
  }

  private tyVars(params: Name[]): Expr {
    return this.list(params.map((param) => this.call('PlainTV', this.nameOf(param.name), this.sup('BndrReq'))));
  }

  private dataDecl(decl: Extract<Decl, { kind: 'data' }>): Expr {
    if (decl.instanceOf || decl.kindSig) throw this.unsupportedIn(decl.span, 'この data 宣言');
    return this.bindAround(
      decl.params.map((param) => param.name),
      () => {
        const cons = decl.cons.map((con) => this.con(con));
        const derivs = decl.deriving.map((clause) => {
          const classes = this.list([this.call('conT', this.globalName(clause.cls, 'type'))]);
          if (clause.strategy === 'via' && clause.via) return this.call('quoteDerivVia', this.typ(clause.via), classes);
          const strategy = clause.strategy
            ? this.just(this.sup(`${clause.strategy[0].toUpperCase()}${clause.strategy.slice(1)}Strategy`))
            : this.nothing();
          return this.call('derivClause', strategy, classes);
        });
        const name = this.nameOf(decl.name.name);
        const tyVars = this.tyVars(decl.params);
        if (decl.newtype) {
          return this.call(
            'newtypeD',
            this.call('cxt', this.list([])),
            name,
            tyVars,
            this.nothing(),
            cons[0],
            this.list(derivs)
          );
        }
        return this.call(
          'dataD',
          this.call('cxt', this.list([])),
          name,
          tyVars,
          this.nothing(),
          this.list(cons),
          this.list(derivs)
        );
      }
    );
  }

  private con(con: ConDecl): Expr {
    if (con.exVars || con.context || con.result) throw this.unsupportedIn(con.span, 'この構成子');
    const bangType = (type: TypeExpr, index: number): Expr =>
      this.call(
        'bangType',
        this.call(
          'bang',
          this.sup('noSourceUnpackedness'),
          this.sup(con.strictFields?.includes(index) ? 'sourceStrict' : 'noSourceStrictness')
        ),
        this.typ(type)
      );
    if (con.fieldNames) {
      const fields = con.fields.map((type, index) =>
        this.call('varBangType', this.nameOf((con.fieldNames as Name[])[index].name), bangType(type, index))
      );
      return this.call('recC', this.nameOf(con.name.name), this.list(fields));
    }
    if (con.isInfix && con.fields.length === 2) {
      return this.call('infixC', bangType(con.fields[0], 0), this.nameOf(con.name.name), bangType(con.fields[1], 1));
    }
    return this.call('normalC', this.nameOf(con.name.name), this.list(con.fields.map(bangType)));
  }
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
