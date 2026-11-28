import { isPseudo, normalize, type Unifier } from './infer';
import type { Module, Program } from './items';
import { builtinImplements } from './traitBuiltins';
import {
  adt,
  allSupertraits,
  type ClosureType,
  F32,
  F64,
  freshVar,
  hasVars,
  type ImplDef,
  INT_NAMES,
  intType,
  sameType,
  shallow,
  type Subst,
  substitute,
  substituteTraitRef,
  type TraitDef,
  type TraitRef,
  type Type,
  type TypeParam,
  USIZE,
} from './types';

export { ERROR_TYPES, RANGE_TYPES } from './traitBuiltins';
export { iteratorCapability } from './traitIterators';

export type Answer = 'yes' | 'no' | 'unknown';

/** The operator traits std implements for numbers only with the same type on both sides (not shifts). */
const SAME_TYPE_OPERATORS = new Set([
  'Add',
  'Sub',
  'Mul',
  'Div',
  'Rem',
  'BitAnd',
  'BitOr',
  'BitXor',
  'AddAssign',
  'SubAssign',
  'MulAssign',
  'DivAssign',
  'RemAssign',
  'BitAndAssign',
  'BitOrAssign',
  'BitXorAssign',
]);

export class TraitSolver {
  private readonly implGoals: { trait: TraitDef; type: Type; args: Type[] }[] = [];
  private readonly sizedGoals: Type[] = [];
  /** The `where` bounds on types other than parameters that the body being checked may assume. */
  assumptions: readonly { type: Type; bound: TraitRef }[] = [];

  constructor(
    readonly program: Program,
    readonly unifier: Unifier
  ) {}

  /** Whether `type` implements the trait, binding variables of closure signatures as a side effect. */
  // code-gauge-allow functionCognitiveComplexity -- One rule per trait or conversion of the standard library.
  // code-gauge-allow functionNcss -- Routes Rust trait obligations by receiver type.
  implements(type: Type, ref: TraitRef): Answer {
    const t = normalize(shallow(type));
    if (ref.assoc && t.kind !== 'param' && t.kind !== 'opaque' && t.kind !== 'dyn')
      return this.implementsWithAssoc(t, ref);
    const { trait } = ref;
    if (t.kind === 'never') return 'yes';
    if (this.assumptions.some(({ type: assumed, bound }) => assumes(bound, ref) && sameType(assumed, t))) return 'yes';
    if (t.kind === 'var') return this.varImplements(t, ref);
    // Type parameters are `Sized` unless they opt out with `?Sized`.
    if (t.kind === 'param') {
      if (trait.builtin === 'Sized') return 'yes';
      const answer = this.boundAnswer(t.param.bounds, ref, t);
      if (answer !== 'no') return answer;
      const implementation = this.implAnswer(trait, t, ref.args);
      if (implementation !== 'no') return implementation;
      return trait.builtin && PARAMETER_BLANKET_TRAITS.has(trait.builtin) ? this.builtinOnly(t, ref) : 'no';
    }
    if (t.kind === 'adt' && isPseudo(t.def)) return this.pseudoImplements(t, ref);
    if (t.kind === 'opaque' || t.kind === 'dyn') {
      const bounds =
        t.kind === 'opaque'
          ? t.opaque.bounds
          : [t.trait, ...(t.autoTraits ?? []).map((trait): TraitRef => ({ trait, args: [] }))];
      const answer = this.boundAnswer(bounds, ref, t);
      return answer === 'no' ? this.builtinOnly(t, ref) : answer;
    }
    if (ref.fnSig) return this.closureImplements(t, ref);
    const implementation = this.implAnswer(trait, t, ref.args, ref.item);
    if (implementation !== 'no') return implementation;
    if (trait.builtin) return builtinImplements(this, t, ref);
    return 'no';
  }

  /** Whether a type implements a trait whose associated types the bound sets, which must then be those types. */
  private implementsWithAssoc(t: Type, ref: TraitRef): Answer {
    const { assoc, ...rest } = ref;
    const answer = this.implements(t, rest);
    if (answer === 'no' || !assoc) return answer;
    let result: Answer = answer;
    for (const [name, expected] of assoc) {
      // The associated type may be a supertrait's (`Sub<Out = u8>` where `trait Sub: Super` and `Super` has `Out`).
      const owner = allSupertraits([rest], t).find((candidate) => candidate.trait.assocTypes.has(name));
      const declared = owner?.trait.assocTypes.get(name)?.projection;
      if (!owner || !declared) continue;
      const actual = normalize(adt(declared, [t, ...owner.args]));
      if (actual.kind === 'adt' && actual.def === declared) {
        result = 'unknown';
        continue;
      }
      if (!this.unifier.unify(actual, expected)) return 'no';
    }
    return result;
  }

  private builtinOnly(t: Type, ref: TraitRef): Answer {
    return ref.trait.builtin ? builtinImplements(this, t, ref) : 'no';
  }

  sizedTail(owner: Type, tail: Type, all: (types: Type[]) => Answer): Answer {
    if (this.sizedGoals.length >= 64 || this.sizedGoals.some((type) => sameType(type, owner))) return 'no';
    this.sizedGoals.push(owner);
    try {
      return all([tail]);
    } finally {
      this.sizedGoals.pop();
    }
  }

  private pseudoImplements(type: Type & { kind: 'adt' }, ref: TraitRef): Answer {
    if (type.def.projection) return this.projectionImplements(type, ref);
    if (type.def.builtin === 'TryFromError') {
      if (ref.trait.builtin === 'Sized') return 'yes';
      return hasVars(type) ? 'unknown' : 'no';
    }
    if (type.def.builtin !== 'IntoShape') return 'unknown';
    if (!['Clone', 'DoubleEndedIterator', 'ExactSizeIterator'].includes(ref.trait.builtin as string)) return 'unknown';
    const iterator = type.args[0];
    if (this.implements(iterator, { trait: this.program.traitDef('Iterator'), args: [] }) !== 'yes') return 'unknown';
    return this.implements(iterator, ref);
  }

  /**
   * An associated type of a type parameter that no bound sets has the bounds its trait declares for it (and is
   * `Sized`); of a type not known yet, nothing is known.
   */
  private projectionImplements(type: Type & { kind: 'adt' }, ref: TraitRef): Answer {
    const { trait, name } = type.def.projection!;
    const self = normalize(shallow(type.args[0]));
    if (self.kind === 'var' || hasVars(self)) return 'unknown';
    if (ref.trait.builtin === 'Sized') return 'yes';
    const subst: Subst = new Map([
      [trait.self, self],
      ...trait.params.map((param, index): [TypeParam, Type] => [param, type.args[index + 1]]),
    ]);
    const bounds = (trait.assocTypes.get(name)?.bounds ?? []).map((bound) => substituteTraitRef(bound, subst));
    const answer = this.boundAnswer(bounds, ref, type);
    return answer === 'no' ? this.builtinOnly(type, ref) : answer;
  }

  private varImplements(t: Type & { kind: 'var' }, ref: TraitRef): Answer {
    // An untyped number indexing a slice is a `usize`, the only integer type slices take.
    if (t.v.literal === 'int' && ref.trait.builtin === 'SliceIndex')
      return this.unifier.tryUnify(t, USIZE) ? 'yes' : 'no';
    if (!t.v.literal) return 'unknown';
    if (ref.trait.builtin === 'ExtendInto' || ref.trait.builtin === 'MapExtendInto')
      return builtinImplements(this, t, ref);
    const byRhs = this.literalWithRhs(t, t.v.literal, ref);
    if (byRhs) return byRhs;
    // rustc takes a number's type from the one impl that fits it, among the impls for numbers of its kind.
    const only = this.onlyNumericImpl(t.v.literal, ref);
    if (only) return this.unifier.tryUnify(t, only) ? 'yes' : 'no';
    if (ref.trait.builtin) return this.literalImplements(t.v.literal, ref);
    return 'unknown';
  }

  /** What the type on the right of a comparison or an arithmetic trait settles of an untyped number on the left. */
  private literalWithRhs(t: Type & { kind: 'var' }, literal: 'int' | 'float', ref: TraitRef): Answer | undefined {
    const rhs = ref.args[0] && normalize(shallow(ref.args[0]));
    if (!rhs) return undefined;
    if (ref.trait.builtin === 'PartialEq' || ref.trait.builtin === 'PartialOrd') {
      return this.literalCompares(t, literal, ref, rhs);
    }
    // With a number of its kind on the right of an arithmetic trait (`Add::add(2, x)`, `Add::add(2, &x)`), it is of
    // that number's type, as std implements these traits only for two numbers of one type.
    const number = rhs.kind === 'ref' && !rhs.mutable ? normalize(shallow(rhs.target)) : rhs;
    if (number.kind !== literal || !SAME_TYPE_OPERATORS.has(ref.trait.builtin ?? '')) return undefined;
    return this.unifier.tryUnify(t, number) ? 'yes' : 'no';
  }

  /** Whether an untyped number compares with a value of another type, which settles the number's type. */
  private literalCompares(t: Type, literal: 'int' | 'float', ref: TraitRef, rhs: Type): Answer {
    // The item of an iterator not known yet (`IntoItem<_>`) is decided once that iterator's type is.
    if (rhs.kind === 'adt' && isPseudo(rhs.def)) return 'unknown';
    if (this.unifier.tryUnify(t, rhs)) return 'yes';
    const fitting = this.fittingNumbers(literal, ref);
    if (fitting.length === 0) return 'no';
    if (fitting.length > 1) return 'unknown';
    return this.unifier.tryUnify(t, fitting[0]) ? 'yes' : 'no';
  }

  /** The one number type of a literal's kind that implements a trait, if exactly one does. */
  private onlyNumericImpl(literal: 'int' | 'float', ref: TraitRef): Type | undefined {
    if (ref.trait.builtin === 'Into' || ref.trait.builtin === 'TryInto') {
      const target = normalize(shallow(ref.args[0]));
      if (target.kind === 'var') return undefined;
      const fitting = this.fittingNumbers(literal, ref);
      return fitting.length === 1 ? fitting[0] : undefined;
    }
    if (ref.trait.builtin) return undefined;
    const impls = this.program.impls.filter((impl) => impl.trait?.trait === ref.trait);
    if (impls.some((impl) => normalize(shallow(impl.selfType)).kind === 'param')) return undefined;
    const fitting = impls
      .map((impl) => normalize(shallow(impl.selfType)))
      .filter((self) => self.kind === (literal === 'int' ? 'int' : 'float'));
    return fitting.length === 1 ? fitting[0] : undefined;
  }

  private fittingNumbers(literal: 'int' | 'float', ref: TraitRef): Type[] {
    const numbers = literal === 'int' ? INT_NAMES.map((name) => intType(name)) : [F32, F64];
    const snapshot = this.unifier.snapshot();
    return numbers.filter((number) => {
      const answer = this.implements(number, ref);
      this.unifier.rollback(snapshot);
      return answer === 'yes';
    });
  }

  private literalImplements(literal: 'int' | 'float', ref: TraitRef): Answer {
    const name = ref.trait.builtin as string;
    if (literal === 'float' && ['Eq', 'Ord', 'Hash', 'Integer'].includes(name)) return 'no';
    if (literal === 'int' && name === 'Float') return 'no';
    if (
      [
        'Copy',
        'Clone',
        'Debug',
        'Display',
        'PartialEq',
        'PartialOrd',
        'Default',
        'ToString',
        'ToOwned',
        'Send',
        'Sync',
        'Sized',
        'Unpin',
      ].includes(name)
    ) {
      return 'yes';
    }
    if (literal === 'int' && ['Eq', 'Ord', 'Hash', 'Integer'].includes(name)) return 'yes';
    if (literal === 'float' && name === 'Float') return 'yes';
    return 'unknown';
  }

  /** Whether bounds imply a trait, through supertraits. */
  boundsImply(bounds: TraitRef[], ref: TraitRef, self?: Type): boolean {
    return this.boundAnswer(bounds, ref, self) === 'yes';
  }

  private boundAnswer(bounds: TraitRef[], ref: TraitRef, self?: Type): Answer {
    const blanket = BLANKET_IMPLS[ref.trait.builtin as string];
    if (
      blanket &&
      this.boundsImply(bounds, { trait: this.program.traitDef(blanket), args: [], item: ref.item }, self)
    ) {
      return 'yes';
    }
    const snapshot = this.unifier.snapshot();
    const inferArgs = ref.args.some(hasVars);
    let match: TraitRef | undefined;
    for (const bound of allSupertraits(bounds, self)) {
      const matches = this.matchBound(bound, ref);
      if (matches && !inferArgs) return 'yes';
      this.unifier.rollback(snapshot);
      if (!matches) continue;
      if (match) return 'unknown';
      match = bound;
    }
    if (!match) return 'no';
    this.matchBound(match, ref);
    return 'yes';
  }

  private matchBound(bound: TraitRef, ref: TraitRef): boolean {
    if (ref.fnSig && bound.fnSig && closureKindAtLeast(bound.trait.name, ref.trait.name)) {
      return this.unifier.unify({ kind: 'fn', ...bound.fnSig }, { kind: 'fn', ...ref.fnSig });
    }
    return (
      bound.trait === ref.trait &&
      bound.args.every((arg, i) => ref.args[i] === undefined || this.unifier.unify(arg, ref.args[i])) &&
      this.itemsMatch(bound, ref) &&
      [...(ref.assoc ?? [])].every(([name, type]) => {
        const set = bound.assoc?.get(name);
        return set !== undefined && this.unifier.unify(set, type);
      })
    );
  }

  /** Whether a bound gives the `Item` that a required `Iterator` or `IntoIterator` names, as its own or as `IntoItem`. */
  private itemsMatch(bound: TraitRef, ref: TraitRef): boolean {
    if (!ref.item) return true;
    return bound.item !== undefined && this.unifier.tryUnify(bound.item, ref.item);
  }

  // code-gauge-allow functionCognitiveComplexity -- One rule per trait or conversion of the standard library.
  private closureImplements(t: Type, ref: TraitRef): Answer {
    const sig = ref.fnSig!;
    if (t.kind === 'closure') {
      const { closure } = t;
      const kind = closureKindAnswer(closure, ref.trait.name);
      if (kind === 'no') return 'no';
      if (closure.params.length !== sig.params.length) return 'no';
      const ok =
        this.unifier.tryUnify({ kind: 'tuple', elems: closure.params }, { kind: 'tuple', elems: sig.params }) &&
        this.unifier.tryUnify(closure.ret, sig.ret);
      return ok ? kind : 'no';
    }
    if (t.kind === 'fn') {
      if (t.params.length !== sig.params.length) return 'no';
      const ok =
        this.unifier.tryUnify({ kind: 'tuple', elems: t.params }, { kind: 'tuple', elems: sig.params }) &&
        this.unifier.tryUnify(t.ret, sig.ret);
      return ok ? 'yes' : 'no';
    }
    if (t.kind === 'ref') {
      if (t.mutable && ref.trait.name === 'Fn') return 'no';
      const trait = this.program.traitDef(t.mutable ? 'FnMut' : 'Fn');
      return this.implements(t.target, { ...ref, trait });
    }
    if (t.kind === 'adt' && t.def.builtin === 'Box') return this.implements(t.args[0], ref);
    return 'no';
  }

  private implAnswer(trait: TraitDef, type: Type, args: Type[], item?: Type): Answer {
    if (this.implGoals.length >= 64 || this.implGoals.some((goal) => matchesImplGoal(goal, trait, type, args))) {
      return 'no';
    }
    this.implGoals.push({ trait, type, args });
    try {
      return this.findImplAnswer(trait, type, args, item);
    } finally {
      this.implGoals.pop();
    }
  }

  private findImplAnswer(trait: TraitDef, type: Type, args: Type[], item?: Type): Answer {
    let answer: Answer = 'no';
    for (const impl of this.program.impls) {
      if (impl.trait?.trait !== trait) continue;
      const snapshot = this.unifier.snapshot();
      const matched = this.matchImplAnswer(impl, type, args);
      // The `Item` a bound names is the impl's.
      const implItem = matched && item && impl.assocTypes.get('Item');
      if (implItem && !this.unifier.unify(substitute(implItem, matched.subst), item)) {
        this.unifier.rollback(snapshot);
        continue;
      }
      if (matched?.answer === 'yes') return 'yes';
      if (matched?.answer === 'unknown') answer = 'unknown';
      this.unifier.rollback(snapshot);
    }
    return answer;
  }

  /**
   * Matches an impl's self type (and trait arguments) against a type, binding the impl's parameters to fresh
   * variables; the bindings stay when it matches, so that the caller learns the arguments.
   */
  matchImpl(impl: ImplDef, type: Type, traitArgs: Type[] = []): Subst | undefined {
    return this.matchImplAnswer(impl, type, traitArgs)?.subst;
  }

  matchImplSelf(impl: ImplDef, type: Type): Subst | undefined {
    const subst: Subst = new Map(impl.params.map((param) => [param, freshVar()]));
    return this.unifier.tryUnify(substitute(impl.selfType, subst), type) ? subst : undefined;
  }

  private matchImplAnswer(impl: ImplDef, type: Type, traitArgs: Type[]): { subst: Subst; answer: Answer } | undefined {
    const snapshot = this.unifier.snapshot();
    const subst = this.matchImplSelf(impl, type);
    if (!subst) return undefined;
    if (impl.trait) {
      const implArgs = substituteTraitRef(impl.trait, subst).args;
      for (const [index, arg] of traitArgs.entries()) {
        if (implArgs[index] && !this.unifier.unify(implArgs[index], arg)) {
          this.unifier.rollback(snapshot);
          return undefined;
        }
      }
    }
    const answer = this.implBounds(impl, subst);
    if (answer === 'no') {
      this.unifier.rollback(snapshot);
      return undefined;
    }
    return { subst, answer };
  }

  private implBounds(impl: ImplDef, subst: Subst): Answer {
    let answer: Answer = 'yes';
    const sized = { trait: this.program.traitDef('Sized'), args: [] };
    for (const param of impl.params) {
      const type = subst.get(param) as Type;
      const bounds = param.bounds.map((ref) => substituteTraitRef(ref, subst));
      if (!(impl.module as Module).isStd && !param.maybeUnsized) bounds.push(sized);
      for (const bound of bounds) {
        const result = this.implements(type, bound);
        if (result === 'no') return 'no';
        if (result === 'unknown') answer = 'unknown';
      }
    }
    return answer;
  }

  isCopy(type: Type): boolean {
    return this.implements(type, { trait: this.program.traitDef('Copy'), args: [] }) === 'yes';
  }
}

function matchesImplGoal(
  goal: { trait: TraitDef; type: Type; args: Type[] },
  trait: TraitDef,
  type: Type,
  args: Type[]
): boolean {
  return (
    goal.trait === trait &&
    sameType(goal.type, type) &&
    goal.args.length === args.length &&
    goal.args.every((arg, index) => sameType(arg, args[index]))
  );
}

/** The std traits with a blanket impl for every type of another trait: `impl<T: Display> ToString for T`. */
const BLANKET_IMPLS: Record<string, string> = { ToString: 'Display', ToOwned: 'Clone', IntoIterator: 'Iterator' };
const PARAMETER_BLANKET_TRAITS = new Set([
  'Borrow',
  'From',
  'Into',
  'TryFrom',
  'TryInto',
  'ExtendInto',
  'MapExtendInto',
]);

/** Whether a closure implements a closure trait; while its captures are unsettled, its trait can still rise to `FnOnce`. */
function closureKindAnswer(closure: ClosureType, need: string): Answer {
  if (!closureKindAtLeast(closure.kind, need)) return 'no';
  return closure.unsettled && need !== 'FnOnce' ? 'unknown' : 'yes';
}

export function closureKindAtLeast(have: string, need: string): boolean {
  const order = ['Fn', 'FnMut', 'FnOnce'];
  return order.includes(have) && order.indexOf(have) <= order.indexOf(need);
}

function assumes(bound: TraitRef, ref: TraitRef): boolean {
  return (
    bound.trait === ref.trait &&
    bound.args.length === ref.args.length &&
    bound.args.every((arg, i) => sameType(arg, ref.args[i]))
  );
}
