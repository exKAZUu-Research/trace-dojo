import { FUNCTION_TYPE, tupleCon } from './builtinTypes';
import type { ClassEntity, ConInfo, ValueEntity } from './entities';
import { compileError } from './errors';
import type { LocalVar, RBinding, RClause, RExpr, RPat } from './rast';
import { newLocal, type RDataDecl } from './rename';
import { rolesOf } from './roles';
import type { Span } from './syntax';
import { splitApp, type Type } from './types';
import { chargeTypeWork } from './typeWorkBudget';

export const DERIVABLE_CLASSES = [
  'Eq',
  'Ord',
  'Show',
  'Read',
  'Enum',
  'Bounded',
  'Functor',
  'Foldable',
  'Traversable',
  'Lift',
] as const;

/** The classes of type constructors, which GHC derives from how each field's type uses the last type parameter. */
export const FUNCTOR_LIKE_CLASSES: ReadonlySet<string> = new Set(['Functor', 'Foldable', 'Traversable']);

const APP_PREC = 10;

type Support = (name: string) => ValueEntity;

interface FieldComparison {
  method: string;
  lastMethod?: string;
  empty: string;
  combine: string;
}

export function deriveInstance(decl: RDataDecl, cls: ClassEntity, support: Support): RBinding[] {
  const builder = new Builder(decl.span, support, cls);
  const cons = decl.cons.map((conDecl) => conDecl.con);
  switch (cls.name) {
    case 'Eq': {
      return [builder.method('==', deriveEq(builder, cons))];
    }
    case 'Ord': {
      const methods = [builder.method('compare', deriveCompare(builder, cons))];
      if (cons.length > 0 && (cons.length <= 3 || cons.every((con) => con.arity === 0)))
        methods.push(builder.method('<', deriveLess(builder, cons)), ...deriveComparisons(builder));
      return methods;
    }
    case 'Show': {
      return [builder.method('showsPrec', deriveShow(builder, cons))];
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
    case 'Functor':
    case 'Foldable':
    case 'Traversable': {
      if (rolesOf(decl.entity).at(-1) === 'phantom') return derivePhantomFunctorLike(builder, cls.name);
      return deriveFunctorLike(new FieldShapes(builder, decl.entity.arity - 1), cls.name, cons);
    }
    case 'Lift': {
      return [
        builder.method(
          'lift',
          cons.map((con) => deriveLiftClause(builder, con))
        ),
      ];
    }
    default: {
      return [];
    }
  }
}

/**
 * The functions that map, fold, or traverse a field by its type's use of the last type parameter, as GHC's
 * `DeriveFunctor`, `DeriveFoldable`, and `DeriveTraversable` build them; each returns `undefined` for a field that
 * does not use the parameter.
 */
class FieldShapes {
  constructor(
    readonly builder: Builder,
    private readonly last: number
  ) {}

  mentions(type: Type): boolean {
    chargeTypeWork();
    if (type.tag === 'tgen') return type.index === this.last;
    return type.tag === 'tap' && (this.mentions(type.fn) || this.mentions(type.arg));
  }

  shape(
    type: Type,
    className: string
  ): { kind: 'param' } | { kind: 'function' | 'tuple'; args: Type[] } | { kind: 'app'; arg: Type } {
    if (type.tag === 'tgen') return { kind: 'param' };
    const { head, args } = splitApp(type);
    if (head.tag === 'tcon' && head.entity === FUNCTION_TYPE && args.length === 2) {
      if (className !== 'Functor' || this.mentions(args[0])) this.fail(className, '関数の型の中');
      return { kind: 'function', args };
    }
    if (head.tag === 'tcon' && head.entity.special === 'tuple' && args.length === head.entity.arity) {
      return { kind: 'tuple', args };
    }
    if (this.mentions(head) || args.slice(0, -1).some((arg) => this.mentions(arg))) {
      this.fail(className, '最後の引数以外');
    }
    return { kind: 'app', arg: args.at(-1) as Type };
  }

  private fail(className: string, where: string): never {
    throw compileError(
      this.builder.span,
      `型の最後の型変数を${where}で使っているので、${className} を deriving できません。`
    );
  }

  fmap(type: Type, f: RExpr): RExpr | undefined {
    if (!this.mentions(type)) return undefined;
    const b = this.builder;
    const shape = this.shape(type, 'Functor');
    switch (shape.kind) {
      case 'param': {
        return f;
      }
      case 'function': {
        const g = b.newVar('g');
        return b.lambda(g, b.call('.', this.fmap(shape.args[1], f) as RExpr, b.local(g)));
      }
      case 'tuple': {
        return this.tupleFunction(shape.args, (vars) => ({
          k: 'tuple',
          elems: shape.args.map((arg, index) => {
            const fn = this.fmap(arg, f);
            return fn ? b.app(fn, b.local(vars[index])) : b.local(vars[index]);
          }),
          span: b.span,
        }));
      }
      case 'app': {
        return b.call('fmap', this.fmap(shape.arg, f) as RExpr);
      }
    }
  }

  /** A function of a field and an accumulator, which `foldr` folds the field's elements into from the right. */
  foldr(type: Type, f: RExpr): RExpr | undefined {
    if (!this.mentions(type)) return undefined;
    const b = this.builder;
    const shape = this.shape(type, 'Foldable');
    switch (shape.kind) {
      case 'param': {
        return f;
      }
      case 'function': {
        throw new Error('A function field reached foldr');
      }
      case 'tuple': {
        const acc = b.newVar('z');
        const fn = this.tupleFunction(shape.args, (vars) => {
          let result = b.local(acc);
          for (const [index, arg] of shape.args.entries().toArray().toReversed()) {
            const inner = this.foldr(arg, f);
            if (inner) result = b.app(inner, b.local(vars[index]), result);
          }
          return result;
        });
        const x = b.newVar('x');
        return lambdaOf(b, [b.pvar(x), b.pvar(acc)], b.app(fn, b.local(x)));
      }
      case 'app': {
        const x = b.newVar('x');
        const acc = b.newVar('z');
        return lambdaOf(
          b,
          [b.pvar(x), b.pvar(acc)],
          b.call('foldr', this.foldr(shape.arg, f) as RExpr, b.local(acc), b.local(x))
        );
      }
    }
  }

  foldMap(type: Type, f: RExpr): RExpr | undefined {
    if (!this.mentions(type)) return undefined;
    const b = this.builder;
    const shape = this.shape(type, 'Foldable');
    switch (shape.kind) {
      case 'param': {
        return f;
      }
      case 'function': {
        throw new Error('A function field reached foldMap');
      }
      case 'tuple': {
        return this.tupleFunction(shape.args, (vars) =>
          mappendAll(
            b,
            shape.args.flatMap((arg, index) => {
              const inner = this.foldMap(arg, f);
              return inner ? [b.app(inner, b.local(vars[index]))] : [];
            })
          )
        );
      }
      case 'app': {
        return b.call('foldMap', this.foldMap(shape.arg, f) as RExpr);
      }
    }
  }

  traverse(type: Type, f: RExpr): RExpr | undefined {
    if (!this.mentions(type)) return undefined;
    const b = this.builder;
    const shape = this.shape(type, 'Traversable');
    switch (shape.kind) {
      case 'param': {
        return f;
      }
      case 'function': {
        throw new Error('A function field reached traverse');
      }
      case 'tuple': {
        return this.tupleFunction(shape.args, (vars) =>
          rebuild(
            b,
            vars.map((variable, index) => ({ value: variable, effect: this.traverse(shape.args[index], f) })),
            (values) => ({ k: 'tuple', elems: values, span: b.span })
          )
        );
      }
      case 'app': {
        return b.call('traverse', this.traverse(shape.arg, f) as RExpr);
      }
    }
  }

  private tupleFunction(args: Type[], body: (vars: LocalVar[]) => RExpr): RExpr {
    const b = this.builder;
    const vars = args.map((_, index) => b.newVar(`y${index + 1}`));
    return lambdaOf(
      b,
      [
        b.pcon(
          tupleCon(args.length),
          vars.map((variable) => b.pvar(variable))
        ),
      ],
      body(vars)
    );
  }
}

function lambdaOf(builder: Builder, pats: RPat[], body: RExpr): RExpr {
  return { k: 'lambda', pats, body, span: builder.span };
}

function mappendAll(builder: Builder, parts: RExpr[]): RExpr {
  if (parts.length === 0) return builder.global('mempty');
  return builder.foldRight(parts, (part, rest) => builder.call('mappend', part, rest));
}

/**
 * Rebuilds a value from parts some of which run an effect: `fmap (\b1 b2 -> build) e1 <*> e2`, or `pure build` when no
 * part does.
 */
function rebuild(
  builder: Builder,
  parts: { value: LocalVar; effect: RExpr | undefined }[],
  build: (values: RExpr[]) => RExpr
): RExpr {
  const effectful = parts.filter((part) => part.effect);
  const results = new Map(effectful.map((part, index) => [part, builder.newVar(`b${index + 1}`)]));
  const built = build(parts.map((part) => builder.local(results.get(part) ?? part.value)));
  if (effectful.length === 0) return builder.call('pure', built);
  const fn = lambdaOf(
    builder,
    [...results.values()].map((variable) => builder.pvar(variable)),
    built
  );
  let result = builder.call('fmap', fn, builder.app(effectful[0].effect as RExpr, builder.local(effectful[0].value)));
  for (const part of effectful.slice(1)) {
    result = builder.call('<*>', result, builder.app(part.effect as RExpr, builder.local(part.value)));
  }
  return result;
}

/**
 * GHC's instances for a type whose last parameter is phantom, which never look at the value: `fmap _ = coerce`,
 * `foldMap _ _ = mempty`, and `traverse _ z = pure (coerce z)`.
 */
function derivePhantomFunctorLike(b: Builder, className: string): RBinding[] {
  switch (className) {
    case 'Functor': {
      return [b.method('fmap', [b.clause([b.wild()], b.global('coerce'))])];
    }
    case 'Foldable': {
      return [b.method('foldMap', [b.clause([b.wild(), b.wild()], b.global('mempty'))])];
    }
    default: {
      const z = b.newVar('z');
      return [b.method('traverse', [b.clause([b.wild(), b.pvar(z)], b.call('pure', b.call('coerce', b.local(z))))])];
    }
  }
}

function deriveFunctorLike(shapes: FieldShapes, className: string, cons: ConInfo[]): RBinding[] {
  const b = shapes.builder;
  const f = b.newVar('f');
  const emptyCase = (local: LocalVar): RExpr => ({ k: 'case', scrutinee: b.local(local), alts: [], span: b.span });
  switch (className) {
    case 'Functor': {
      if (cons.length === 0) {
        const z = b.newVar('z');
        return [b.method('fmap', [b.clause([b.wild(), b.pvar(z)], emptyCase(z))])];
      }
      return [
        b.method(
          'fmap',
          cons.map((con) => {
            const xs = fieldVars(b, con, 'a');
            const args = xs.map((x, index) => {
              const fn = shapes.fmap(con.fieldTypes[index], b.local(f));
              return fn ? b.app(fn, b.local(x)) : b.local(x);
            });
            return b.clause(
              [
                b.pvar(f),
                b.pcon(
                  con,
                  xs.map((x) => b.pvar(x))
                ),
              ],
              b.app(b.con(con), ...args)
            );
          })
        ),
      ];
    }
    case 'Foldable': {
      const z = b.newVar('z');
      if (cons.length === 0) {
        return [
          b.method('foldr', [b.clause([b.wild(), b.pvar(z), b.wild()], b.local(z))]),
          b.method('foldMap', [b.clause([b.wild(), b.wild()], b.global('mempty'))]),
        ];
      }
      const foldr = cons.map((con) => {
        const xs = fieldVars(b, con, 'a');
        let result = b.local(z);
        for (const [index, x] of xs.entries().toArray().toReversed()) {
          const fn = shapes.foldr(con.fieldTypes[index], b.local(f));
          if (fn) result = b.app(fn, b.local(x), result);
        }
        return b.clause(
          [
            b.pvar(f),
            b.pvar(z),
            b.pcon(
              con,
              xs.map((x) => b.pvar(x))
            ),
          ],
          result
        );
      });
      const foldMap = cons.map((con) => {
        const xs = fieldVars(b, con, 'a');
        const parts = xs.flatMap((x, index) => {
          const fn = shapes.foldMap(con.fieldTypes[index], b.local(f));
          return fn ? [b.app(fn, b.local(x))] : [];
        });
        return b.clause(
          [
            b.pvar(f),
            b.pcon(
              con,
              xs.map((x) => b.pvar(x))
            ),
          ],
          mappendAll(b, parts)
        );
      });
      return [b.method('foldr', foldr), b.method('foldMap', foldMap)];
    }
    default: {
      if (cons.length === 0) {
        const z = b.newVar('z');
        return [b.method('traverse', [b.clause([b.wild(), b.pvar(z)], b.call('pure', emptyCase(z)))])];
      }
      return [
        b.method(
          'traverse',
          cons.map((con) => {
            const xs = fieldVars(b, con, 'a');
            const body = rebuild(
              b,
              xs.map((x, index) => ({ value: x, effect: shapes.traverse(con.fieldTypes[index], b.local(f)) })),
              (values) => b.app(b.con(con), ...values)
            );
            return b.clause(
              [
                b.pvar(f),
                b.pcon(
                  con,
                  xs.map((x) => b.pvar(x))
                ),
              ],
              body
            );
          })
        ),
      ];
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
    // oxlint-disable-next-line typescript/no-misused-spread -- Haskell Char values require code-point iteration.
    return { k: 'lit', lit: { kind: 'string', value: [...value] }, span: this.span };
  }

  int(value: number): RExpr {
    return { k: 'lit', lit: { kind: 'int', value: BigInt(value) }, span: this.span };
  }

  lambda(local: LocalVar, body: RExpr): RExpr {
    return { k: 'lambda', pats: [this.pvar(local)], body, span: this.span };
  }

  compose(parts: RExpr[]): RExpr {
    return this.foldRight(parts, (part, rest) => this.call('.', part, rest));
  }

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
  if (cons.length === 0) return [builder.clause([builder.wild(), builder.wild()], builder.conNamed('True'))];
  const clauses = sameConClauses(builder, cons, { method: '==', empty: 'True', combine: '&&' });
  if (cons.length > 1) clauses.push(builder.clause([builder.wild(), builder.wild()], builder.conNamed('False')));
  return clauses;
}

function deriveCompare(builder: Builder, cons: ConInfo[]): RClause[] {
  const clauses = sameConClauses(builder, cons, { method: 'compare', empty: 'EQ', combine: 'thenCmp' });
  if (cons.length > 1) clauses.push(constructorTagClause(builder, 'compare'));
  if (cons.length === 0) clauses.push(builder.clause([builder.wild(), builder.wild()], builder.conNamed('EQ')));
  return clauses;
}

function deriveLess(builder: Builder, cons: ConInfo[]): RClause[] {
  const clauses = sameConClauses(builder, cons, {
    method: 'compare',
    lastMethod: '<',
    empty: 'False',
    combine: 'thenLess',
  });
  if (cons.length > 1) clauses.push(constructorTagClause(builder, '<'));
  return clauses;
}

function constructorTagClause(builder: Builder, method: string): RClause {
  const a = builder.newVar('a');
  const b = builder.newVar('b');
  return builder.clause(
    [builder.pvar(a), builder.pvar(b)],
    builder.call(method, builder.call('primConTag', builder.local(a)), builder.call('primConTag', builder.local(b)))
  );
}

/** GHC specializes `<=`, `>`, and `>=` through `<`, so they evaluate their arguments in its order: `x <= y = not (y < x)`. */
function deriveComparisons(builder: Builder): RBinding[] {
  const comparison = (name: string, negate: boolean, swap: boolean): RBinding => {
    const x = builder.newVar('x');
    const y = builder.newVar('y');
    const less = swap
      ? builder.call('<', builder.local(y), builder.local(x))
      : builder.call('<', builder.local(x), builder.local(y));
    return builder.method(name, [
      builder.clause([builder.pvar(x), builder.pvar(y)], negate ? builder.call('not', less) : less),
    ]);
  };
  return [comparison('<=', true, true), comparison('>', false, true), comparison('>=', true, false)];
}

function sameConClauses(builder: Builder, cons: ConInfo[], comparison: FieldComparison): RClause[] {
  const { method, empty, combine, lastMethod = method } = comparison;
  return cons.map((con) => {
    const xs = fieldVars(builder, con, 'a');
    const ys = fieldVars(builder, con, 'b');
    const comparisons = xs.map((x, index) =>
      builder.call(index === xs.length - 1 ? lastMethod : method, builder.local(x), builder.local(ys[index]))
    );
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

function prefixName(name: string): string {
  return isOperator(name) ? `(${name})` : name;
}

function deriveShow(builder: Builder, cons: ConInfo[]): RClause[] {
  if (cons.length > 0) return cons.map((con) => deriveShowClause(builder, con));
  const value = builder.newVar('value');
  return [
    builder.clause([builder.wild(), builder.pvar(value)], {
      k: 'case',
      scrutinee: builder.local(value),
      alts: [],
      span: builder.span,
    }),
  ];
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

// code-gauge-allow functionCognitiveComplexity -- The branches follow the Haskell report's rules for reading prefix, infix, and record constructors.
// code-gauge-allow functionNcss -- The branches follow the Haskell report's rules for reading prefix, infix, and record constructors.
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
  const witness = builder.con(decl.cons[0].con);
  const typeName = builder.str(decl.entity.name);
  const first = builder.int(decl.cons[0].con.tag);
  const count = builder.int(decl.cons.length);
  const x = builder.newVar('x');
  const y = builder.newVar('y');
  const n = builder.newVar('n');
  const tagOf = (local: LocalVar): RExpr => builder.call('-', builder.call('primConTag', builder.local(local)), first);
  return [
    builder.method('fromEnum', [builder.clause([builder.pvar(x)], tagOf(x))]),
    builder.method('toEnum', [
      builder.clause(
        [builder.pvar(n)],
        builder.call('derivedToEnum', typeName, witness, first, count, builder.local(n))
      ),
    ]),
    builder.method('succ', [
      builder.clause([builder.pvar(x)], builder.call('derivedSucc', typeName, witness, first, count, tagOf(x))),
    ]),
    builder.method('pred', [
      builder.clause([builder.pvar(x)], builder.call('derivedPred', typeName, witness, first, count, tagOf(x))),
    ]),
    builder.method('enumFrom', [
      builder.clause([builder.pvar(x)], builder.call('derivedEnumFrom', witness, first, count, tagOf(x))),
    ]),
    builder.method('enumFromThen', [
      builder.clause(
        [builder.pvar(x), builder.pvar(y)],
        builder.call('derivedEnumFromThen', witness, first, count, tagOf(x), tagOf(y))
      ),
    ]),
  ];
}

/** `lift (C a b) = appE (appE (conE 'C) (lift a)) (lift b)`, the tree of a value of the type, as DeriveLift gives. */
function deriveLiftClause(builder: Builder, con: ConInfo): RClause {
  const vars = Array.from({ length: con.arity }, (_, index) => builder.newVar(`a${index + 1}`));
  // Only a program derives Lift, so its constructors are the main package's.
  let expr = builder.call('quoteGlobalCon', builder.str('main'), builder.str(con.entity.module), builder.str(con.name));
  for (const variable of vars) expr = builder.call('appE', expr, builder.call('lift', builder.local(variable)));
  return builder.clause(
    [
      builder.pcon(
        con,
        vars.map((variable) => builder.pvar(variable))
      ),
    ],
    expr
  );
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
