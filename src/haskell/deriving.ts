import type { ClassEntity, ConInfo, ValueEntity } from './entities';
import type { LocalVar, RBinding, RClause, RExpr, RPat } from './rast';
import { newLocal, type RDataDecl } from './rename';
import type { Span } from './syntax';

export const DERIVABLE_CLASSES = ['Eq', 'Ord', 'Show', 'Read', 'Enum', 'Bounded'] as const;

/** The precedence of function application, which derived `Show` and `Read` compare against. */
const APP_PREC = 10;

type Support = (name: string) => ValueEntity;

/** Builds the method bindings of a derived instance, as GHC's deriving mechanism defines them. */
export function deriveInstance(decl: RDataDecl, cls: ClassEntity, support: Support): RBinding[] {
  const builder = new Builder(decl.span, support, cls);
  const cons = decl.entity.cons;
  switch (cls.name) {
    case 'Eq': {
      return [builder.method('==', deriveEq(builder, cons))];
    }
    case 'Ord': {
      return [builder.method('compare', deriveCompare(builder, cons))];
    }
    case 'Show': {
      return [
        builder.method(
          'showsPrec',
          cons.map((con) => deriveShowClause(builder, con))
        ),
      ];
    }
    case 'Read': {
      return [builder.method('readsPrec', [deriveReadClause(builder, cons)])];
    }
    case 'Enum': {
      return deriveEnum(builder, decl);
    }
    case 'Bounded': {
      return deriveBounded(builder, cons);
    }
    default: {
      return [];
    }
  }
}

class Builder {
  constructor(
    readonly span: Span,
    private readonly support: Support,
    private readonly cls: ClassEntity
  ) {}

  method(name: string, clauses: RClause[]): RBinding {
    const entity = this.cls.methods.find((method) => method.name === name) as ValueEntity;
    return { k: 'fun', binder: { kind: 'global', entity }, clauses, span: this.span };
  }

  clause(pats: RPat[], expr: RExpr): RClause {
    return { pats, rhs: { body: { k: 'plain', expr }, where: { bindings: [] }, span: this.span }, span: this.span };
  }

  global(name: string): RExpr {
    return { k: 'var', ref: { kind: 'global', entity: this.support(name) }, name, span: this.span };
  }

  local(local: LocalVar): RExpr {
    return { k: 'var', ref: { kind: 'local', local }, name: local.name, span: this.span };
  }

  newVar(name: string): LocalVar {
    return newLocal(name, this.span);
  }

  pvar(local: LocalVar): RPat {
    return { k: 'var', local, span: this.span };
  }

  wild(): RPat {
    return { k: 'wild', span: this.span };
  }

  pcon(con: ConInfo, args: RPat[]): RPat {
    return { k: 'con', con, args, span: this.span };
  }

  con(con: ConInfo): RExpr {
    return { k: 'con', con, span: this.span };
  }

  /** A library constructor by name, such as `True`. */
  conNamed(name: string): RExpr {
    return this.con(this.support(name).con as ConInfo);
  }

  app(fn: RExpr, ...args: RExpr[]): RExpr {
    let result = fn;
    for (const arg of args) result = { k: 'app', fn: result, arg, span: this.span };
    return result;
  }

  call(name: string, ...args: RExpr[]): RExpr {
    return this.app(this.global(name), ...args);
  }

  str(value: string): RExpr {
    return { k: 'lit', lit: { kind: 'string', value }, span: this.span };
  }

  int(value: number): RExpr {
    return { k: 'lit', lit: { kind: 'int', value: BigInt(value) }, span: this.span };
  }

  list(elems: RExpr[]): RExpr {
    return { k: 'list', elems, span: this.span };
  }

  lambda(local: LocalVar, body: RExpr): RExpr {
    return { k: 'lambda', pats: [this.pvar(local)], body, span: this.span };
  }

  /** Composes functions left to right as `f . g . h`. */
  compose(parts: RExpr[]): RExpr {
    return this.foldRight(parts, (part, rest) => this.call('.', part, rest));
  }

  /** Combines items from the right: `f(a, f(b, c))` for `[a, b, c]`. */
  foldRight(items: RExpr[], combine: (item: RExpr, rest: RExpr) => RExpr): RExpr {
    let result = items.at(-1) as RExpr;
    for (let index = items.length - 2; index >= 0; index--) result = combine(items[index], result);
    return result;
  }

  constructorFixity(con: ConInfo): number {
    return con.entity.fixity?.prec ?? 9;
  }
}

function fieldVars(builder: Builder, con: ConInfo, prefix: string): LocalVar[] {
  return Array.from({ length: con.arity }, (_, index) => builder.newVar(`${prefix}${index + 1}`));
}

function deriveEq(builder: Builder, cons: ConInfo[]): RClause[] {
  const clauses = sameConClauses(builder, cons, '==', 'True', '&&');
  if (cons.length !== 1) clauses.push(builder.clause([builder.wild(), builder.wild()], builder.conNamed('False')));
  return clauses;
}

function deriveCompare(builder: Builder, cons: ConInfo[]): RClause[] {
  const clauses = sameConClauses(builder, cons, 'compare', 'EQ', 'thenCmp');
  if (cons.length > 1) {
    const a = builder.newVar('a');
    const b = builder.newVar('b');
    clauses.push(
      builder.clause(
        [builder.pvar(a), builder.pvar(b)],
        builder.call(
          'compare',
          builder.call('primConTag', builder.local(a)),
          builder.call('primConTag', builder.local(b))
        )
      )
    );
  }
  if (cons.length === 0) clauses.push(builder.clause([builder.wild(), builder.wild()], builder.conNamed('EQ')));
  return clauses;
}

/**
 * A clause for each constructor matching two values built by it, combining `method` applied to each pair of fields
 * by `combine` from the right, or `empty` for a constructor without fields.
 */
function sameConClauses(builder: Builder, cons: ConInfo[], method: string, empty: string, combine: string): RClause[] {
  return cons.map((con) => {
    const xs = fieldVars(builder, con, 'a');
    const ys = fieldVars(builder, con, 'b');
    const comparisons = xs.map((x, index) => builder.call(method, builder.local(x), builder.local(ys[index])));
    const body =
      comparisons.length === 0
        ? builder.conNamed(empty)
        : builder.foldRight(comparisons, (comparison, rest) => builder.call(combine, comparison, rest));
    const patterns = [xs, ys].map((vars) =>
      builder.pcon(
        con,
        vars.map((variable) => builder.pvar(variable))
      )
    );
    return builder.clause(patterns, body);
  });
}

function isOperator(name: string): boolean {
  return !/^[\p{L}_]/u.test(name);
}

/** A constructor's or field's name as it appears in prefix position: operators in parentheses. */
function prefixName(name: string): string {
  return isOperator(name) ? `(${name})` : name;
}

function deriveShowClause(builder: Builder, con: ConInfo): RClause {
  const d = builder.newVar('d');
  const xs = fieldVars(builder, con, 'a');
  const pattern = [
    builder.pvar(d),
    builder.pcon(
      con,
      xs.map((x) => builder.pvar(x))
    ),
  ];
  if (con.fieldNames && con.fieldNames.length > 0) {
    const parts: RExpr[] = [builder.call('showString', builder.str(`${prefixName(con.name)} {`))];
    for (const [index, x] of xs.entries()) {
      if (index > 0) parts.push(builder.call('showString', builder.str(', ')));
      parts.push(builder.call('showString', builder.str(`${prefixName(con.fieldNames[index])} = `)));
      parts.push(builder.call('showsPrec', builder.int(0), builder.local(x)));
    }
    parts.push(builder.call('showChar', { k: 'lit', lit: { kind: 'char', value: '}' }, span: builder.span }));
    const shown = builder.compose(parts);
    return builder.clause(
      pattern,
      builder.call('showParen', builder.call('>=', builder.local(d), builder.int(APP_PREC + 1)), shown)
    );
  }
  if (con.arity === 0)
    return builder.clause(
      [builder.wild(), builder.pcon(con, [])],
      builder.call('showString', builder.str(prefixName(con.name)))
    );
  if (con.isInfix && con.arity === 2) {
    const prec = builder.constructorFixity(con);
    const name = isOperator(con.name) ? ` ${con.name} ` : ` \`${con.name}\` `;
    const shown = builder.compose([
      builder.call('showsPrec', builder.int(prec + 1), builder.local(xs[0])),
      builder.call('showString', builder.str(name)),
      builder.call('showsPrec', builder.int(prec + 1), builder.local(xs[1])),
    ]);
    return builder.clause(
      pattern,
      builder.call('showParen', builder.call('>', builder.local(d), builder.int(prec)), shown)
    );
  }
  const parts: RExpr[] = [builder.call('showString', builder.str(`${prefixName(con.name)} `))];
  for (const [index, x] of xs.entries()) {
    if (index > 0)
      parts.push(builder.call('showChar', { k: 'lit', lit: { kind: 'char', value: ' ' }, span: builder.span }));
    parts.push(builder.call('showsPrec', builder.int(APP_PREC + 1), builder.local(x)));
  }
  const shown = builder.compose(parts);
  return builder.clause(
    pattern,
    builder.call('showParen', builder.call('>=', builder.local(d), builder.int(APP_PREC + 1)), shown)
  );
}

function deriveReadClause(builder: Builder, cons: ConInfo[]): RClause {
  const d = builder.newVar('d');
  const alternatives = cons.map((con) => deriveReadAlternative(builder, con, d));
  const body =
    alternatives.length === 0
      ? builder.call('readsFail')
      : builder.foldRight(alternatives, (alternative, rest) => builder.call('readsAlt', alternative, rest));
  return builder.clause([builder.pvar(d)], body);
}

/** One constructor's reader, which reads tokens and fields in sequence through `readsBind`. */
// code-gauge-allow functionCognitiveComplexity 28 -- The branches follow the Haskell report's rules for reading prefix, infix, and record constructors.
// code-gauge-allow functionNcss 39 -- The branches follow the Haskell report's rules for reading prefix, infix, and record constructors.
function deriveReadAlternative(builder: Builder, con: ConInfo, d: LocalVar): RExpr {
  const xs = fieldVars(builder, con, 'a');
  const steps: ({ kind: 'token'; text: string } | { kind: 'field'; prec: number; local: LocalVar })[] = [];
  let parenPrec: number | undefined;
  if (con.fieldNames && con.fieldNames.length > 0) {
    parenPrec = APP_PREC + 1;
    for (const part of tokensOfName(con.name)) steps.push({ kind: 'token', text: part });
    steps.push({ kind: 'token', text: '{' });
    for (const [index, x] of xs.entries()) {
      if (index > 0) steps.push({ kind: 'token', text: ',' });
      for (const part of tokensOfName(con.fieldNames[index])) steps.push({ kind: 'token', text: part });
      steps.push({ kind: 'token', text: '=' });
      steps.push({ kind: 'field', prec: 0, local: x });
    }
    steps.push({ kind: 'token', text: '}' });
  } else if (con.isInfix && con.arity === 2) {
    const prec = builder.constructorFixity(con);
    parenPrec = prec;
    steps.push({ kind: 'field', prec: prec + 1, local: xs[0] });
    if (isOperator(con.name)) steps.push({ kind: 'token', text: con.name });
    else steps.push({ kind: 'token', text: '`' }, { kind: 'token', text: con.name }, { kind: 'token', text: '`' });
    steps.push({ kind: 'field', prec: prec + 1, local: xs[1] });
  } else {
    if (con.arity > 0) parenPrec = APP_PREC;
    for (const part of tokensOfName(con.name)) steps.push({ kind: 'token', text: part });
    for (const x of xs) steps.push({ kind: 'field', prec: APP_PREC + 1, local: x });
  }
  let body: RExpr = builder.call('readsReturn', builder.app(builder.con(con), ...xs.map((x) => builder.local(x))));
  for (const step of steps.toReversed()) {
    body =
      step.kind === 'token'
        ? builder.call('readsThen', builder.call('readsToken', builder.str(step.text)), body)
        : builder.call(
            'readsBind',
            builder.call('readsPrec', builder.int(step.prec)),
            builder.lambda(step.local, body)
          );
  }
  const condition =
    parenPrec === undefined ? builder.conNamed('False') : builder.call('>', builder.local(d), builder.int(parenPrec));
  return builder.call('readParen', condition, body);
}

/** The tokens `lex` reads for a name: an operator constructor in prefix position is three. */
function tokensOfName(name: string): string[] {
  return isOperator(name) ? ['(', name, ')'] : [name];
}

function deriveEnum(builder: Builder, decl: RDataDecl): RBinding[] {
  const cons = decl.entity.cons;
  const all = builder.list(cons.map((con) => builder.con(con)));
  const typeName = builder.str(decl.entity.name);
  const x = builder.newVar('x');
  const y = builder.newVar('y');
  const n = builder.newVar('n');
  const tagOf = (local: LocalVar): RExpr => builder.call('primConTag', builder.local(local));
  return [
    builder.method('fromEnum', [builder.clause([builder.pvar(x)], tagOf(x))]),
    builder.method('toEnum', [
      builder.clause([builder.pvar(n)], builder.call('derivedToEnum', typeName, all, builder.local(n))),
    ]),
    builder.method('succ', [builder.clause([builder.pvar(x)], builder.call('derivedSucc', typeName, all, tagOf(x)))]),
    builder.method('pred', [builder.clause([builder.pvar(x)], builder.call('derivedPred', typeName, all, tagOf(x)))]),
    builder.method('enumFrom', [builder.clause([builder.pvar(x)], builder.call('derivedEnumFrom', all, tagOf(x)))]),
    builder.method('enumFromThen', [
      builder.clause([builder.pvar(x), builder.pvar(y)], builder.call('derivedEnumFromThen', all, tagOf(x), tagOf(y))),
    ]),
  ];
}

function deriveBounded(builder: Builder, cons: ConInfo[]): RBinding[] {
  const first = cons[0];
  const last = cons.at(-1) as ConInfo;
  const bound = (con: ConInfo, name: 'minBound' | 'maxBound'): RExpr =>
    builder.app(builder.con(con), ...Array.from({ length: con.arity }, () => builder.global(name)));
  return [
    builder.method('minBound', [builder.clause([], bound(first, 'minBound'))]),
    builder.method('maxBound', [builder.clause([], bound(last, 'maxBound'))]),
  ];
}
