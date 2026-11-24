import { COERCIBLE_CLASS, FUNCTION_TYPE, IO_TYPE } from './builtinTypes';
import type { CoercionSpec, ConInfo, Evidence } from './entities';
import { compileError } from './errors';
import { TypePrinter } from './prettyType';
import { rolesOf } from './roles';
import type { Span } from './syntax';
import { instantiateType, type Pred, prune, splitApp, type Type, typesEqual, typeVarsOf, zonk } from './types';

/** What solving `Coercible` needs of the type checker: reducing type families and unifying types. */
export interface CoercionChecker {
  reduceFamilies(type: Type): Type;
  unify(a: Type, b: Type, span: Span, context: string): void;
}

interface Applied {
  head: Type;
  args: Type[];
}

/**
 * Solves `Coercible a b` by how values of the two types are represented: the same types, a given constraint, a
 * newtype and its field, or applications of the same type whose arguments convert as the type's roles allow. Types
 * not yet known leave the constraint for later, which `undefined` stands for; `defaulting`, once nothing else can
 * decide them, makes an unknown type the other side's when that is no newtype, as GHC's defaulting does.
 */
export function solveCoercible(
  checker: CoercionChecker,
  pred: Pred,
  givens: readonly { pred: Pred; evidence: Evidence }[],
  span: Span,
  defaulting = false
): Evidence | undefined {
  const [from, to] = splitApp(pred.type).args;
  const solver = new CoercionSolver(
    checker,
    givens.filter((given) => given.pred.cls === COERCIBLE_CLASS),
    span,
    defaulting
  );
  const spec = solver.solve(from, to, 0);
  return spec === 'stuck' ? undefined : { kind: 'coercion', spec, leaves: solver.leaves };
}

class CoercionSolver {
  readonly leaves: Evidence[] = [];

  constructor(
    private readonly checker: CoercionChecker,
    private readonly givens: readonly { pred: Pred; evidence: Evidence }[],
    private readonly span: Span,
    private readonly defaulting: boolean
  ) {}

  solve(a: Type, b: Type, depth: number): CoercionSpec | 'stuck' {
    if (depth > 200) throw compileError(this.span, '型の表現の計算が上限を超えました。');
    const left = prune(this.checker.reduceFamilies(a));
    const right = prune(this.checker.reduceFamilies(b));
    if (typesEqual(left, right)) return { k: 'refl' };
    const given = this.fromGiven(left, right);
    if (given) return given;
    const l = splitApp(left);
    const r = splitApp(right);
    if (this.defaulting && ((flexible(left) && isPlainData(r)) || (flexible(right) && isPlainData(l)))) {
      this.checker.unify(left, right, this.span, '型の表現（coerce）');
      return { k: 'refl' };
    }
    if (flexible(l.head) || flexible(r.head))
      return this.defaulting ? this.unwrapToDefault(left, right, l, r, depth) : 'stuck';
    const decomposed = this.decompose(l, r, depth);
    if (decomposed) return decomposed;
    const fromNewtype = unwrappable(l.head);
    if (fromNewtype) return this.nested('unwrap', fromNewtype, this.solve(field(fromNewtype, l), right, depth + 1));
    const toNewtype = unwrappable(r.head);
    if (toNewtype) return this.nested('wrap', toNewtype, this.solve(left, field(toNewtype, r), depth + 1));
    if ([...typeVarsOf(left), ...typeVarsOf(right)].some((variable) => !variable.skolem)) return 'stuck';
    const printer = new TypePrinter();
    throw compileError(
      this.span,
      `型 ${printer.show(left)} と型 ${printer.show(right)} は表現が同じではないので、coerce できません。`
    );
  }

  /** In defaulting, a newtype facing an unknown type gives way to its field, which the unknown type may then be. */
  private unwrapToDefault(left: Type, right: Type, l: Applied, r: Applied, depth: number): CoercionSpec | 'stuck' {
    const fromNewtype = flexible(r.head) ? unwrappable(l.head) : undefined;
    if (fromNewtype) return this.nested('unwrap', fromNewtype, this.solve(field(fromNewtype, l), right, depth + 1));
    const toNewtype = flexible(l.head) ? unwrappable(r.head) : undefined;
    if (toNewtype) return this.nested('wrap', toNewtype, this.solve(left, field(toNewtype, r), depth + 1));
    return 'stuck';
  }

  /** The conversion a given `Coercible` constraint gives, either way round. */
  private fromGiven(left: Type, right: Type): CoercionSpec | undefined {
    for (const given of this.givens) {
      const [givenFrom, givenTo] = splitApp(zonk(given.pred.type)).args;
      const forward = typesEqual(givenFrom, left) && typesEqual(givenTo, right);
      if (forward || (typesEqual(givenFrom, right) && typesEqual(givenTo, left))) {
        let index = this.leaves.indexOf(given.evidence);
        if (index < 0) index = this.leaves.push(given.evidence) - 1;
        return { k: 'leaf', index, flipped: !forward };
      }
    }
    return undefined;
  }

  /**
   * Applications of the same type convert argument by argument as its roles allow: a nominal argument must be the
   * same, a phantom one may differ, and a representational one converts. A newtype whose nominal arguments differ is
   * left to unwrap instead.
   */
  private decompose(l: Applied, r: Applied, depth: number): CoercionSpec | 'stuck' | undefined {
    const sameHead =
      l.args.length === r.args.length &&
      (l.head.tag === 'tcon' && r.head.tag === 'tcon' ? l.head.entity === r.head.entity : typesEqual(l.head, r.head));
    if (!sameHead) return undefined;
    const roles = l.head.tag === 'tcon' ? rolesOf(l.head.entity) : l.args.map(() => 'nominal' as const);
    const nominalEqual = l.args.every(
      (arg, index) => (roles[index] ?? 'nominal') !== 'nominal' || typesEqual(arg, r.args[index])
    );
    if (unwrappable(l.head) && !nominalEqual) return undefined;
    const params: CoercionSpec[] = [];
    for (const [index, arg] of l.args.entries()) {
      const role = roles[index] ?? 'nominal';
      if (role === 'nominal') this.checker.unify(arg, r.args[index], this.span, '型の表現（coerce）');
      const inner: CoercionSpec | 'stuck' =
        role === 'representational' ? this.solve(arg, r.args[index], depth + 1) : { k: 'refl' };
      if (inner === 'stuck') return 'stuck';
      params.push(inner);
    }
    if (params.every((param) => param.k === 'refl')) return { k: 'refl' };
    if (l.head.tag === 'tcon' && l.head.entity === FUNCTION_TYPE) return { k: 'fun', arg: params[0], res: params[1] };
    if (l.head.tag === 'tcon' && l.head.entity === IO_TYPE) return { k: 'io', res: params[0] };
    return { k: 'data', params };
  }

  private nested(k: 'unwrap' | 'wrap', con: ConInfo, inner: CoercionSpec | 'stuck'): CoercionSpec | 'stuck' {
    return inner === 'stuck' ? 'stuck' : { k, con, inner };
  }
}

function flexible(type: Type): boolean {
  return type.tag === 'tvar' && !type.skolem;
}

/** The constructor of a newtype at the head of a type, whose field `Coercible` may take the value as. */
function unwrappable(head: Type): ConInfo | undefined {
  if (head.tag !== 'tcon') return undefined;
  const con = head.entity.cons.length === 1 ? head.entity.cons[0] : undefined;
  return con?.isNewtype && !con.instanceArgs ? con : undefined;
}

function isPlainData(applied: Applied): boolean {
  return applied.head.tag === 'tcon' && !unwrappable(applied.head);
}

function field(con: ConInfo, applied: Applied): Type {
  return instantiateType(con.fieldTypes[0], applied.args);
}
