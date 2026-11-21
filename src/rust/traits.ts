import { isPseudo, normalize, type Unifier } from './infer';
import type { Module, Program } from './items';
import { builtinImplements } from './traitBuiltins';
import {
  allSupertraits,
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
  USIZE,
} from './types';

export { ERROR_TYPES, RANGE_TYPES } from './traitBuiltins';
export { iteratorCapability } from './traitIterators';

export type Answer = 'yes' | 'no' | 'unknown';

/** Decides which types implement which traits: from impls, derives, bounds, and the standard library's rules. */
export class TraitSolver {
  private readonly implGoals: { trait: TraitDef; type: Type; args: Type[] }[] = [];
  private readonly sizedGoals: Type[] = [];

  constructor(
    readonly program: Program,
    readonly unifier: Unifier
  ) {}

  /** Whether `type` implements the trait, binding variables of closure signatures as a side effect. */
  // code-gauge-allow functionCognitiveComplexity 23 -- One rule per trait or conversion of the standard library.
  // code-gauge-allow functionNcss 31 -- Routes Rust trait obligations by receiver type.
  implements(type: Type, ref: TraitRef): Answer {
    const t = normalize(shallow(type));
    const { trait } = ref;
    if (t.kind === 'never') return 'yes';
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
    const implementation = this.implAnswer(trait, t, ref.args);
    if (implementation !== 'no') return implementation;
    if (trait.builtin) return builtinImplements(this, t, ref);
    return 'no';
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

  // code-gauge-allow functionCognitiveComplexity 21 -- Literal defaults and conversions depend on the goal and numeric kind.
  private varImplements(t: Type & { kind: 'var' }, ref: TraitRef): Answer {
    // An untyped number indexing a slice is a `usize`, the only integer type slices take.
    if (t.v.literal === 'int' && ref.trait.builtin === 'SliceIndex')
      return this.unifier.tryUnify(t, USIZE) ? 'yes' : 'no';
    if (!t.v.literal) return 'unknown';
    if (ref.trait.builtin === 'ExtendInto') return builtinImplements(this, t, ref);
    const rhs = ref.args[0];
    if (rhs && (ref.trait.builtin === 'PartialEq' || ref.trait.builtin === 'PartialOrd')) {
      if (this.unifier.tryUnify(t, rhs)) return 'yes';
      const fitting = this.fittingNumbers(t.v.literal, ref);
      if (fitting.length === 0) return 'no';
      if (fitting.length > 1) return 'unknown';
      return this.unifier.tryUnify(t, fitting[0]) ? 'yes' : 'no';
    }
    // rustc takes a number's type from the one impl that fits it, among the impls for numbers of its kind.
    const only = this.onlyNumericImpl(t.v.literal, ref);
    if (only) return this.unifier.tryUnify(t, only) ? 'yes' : 'no';
    if (ref.trait.builtin) return this.literalImplements(t.v.literal, ref);
    return 'unknown';
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
      this.itemsMatch(bound, ref)
    );
  }

  /** Whether a bound gives the `Item` that a required `Iterator` or `IntoIterator` names, as its own or as `IntoItem`. */
  private itemsMatch(bound: TraitRef, ref: TraitRef): boolean {
    if (!ref.item) return true;
    return bound.item !== undefined && this.unifier.tryUnify(bound.item, ref.item);
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- One rule per trait or conversion of the standard library.
  private closureImplements(t: Type, ref: TraitRef): Answer {
    const sig = ref.fnSig!;
    if (t.kind === 'closure') {
      const { closure } = t;
      if (!closureKindAtLeast(closure.kind, ref.trait.name)) return 'no';
      if (closure.params.length !== sig.params.length) return 'no';
      const ok =
        this.unifier.tryUnify({ kind: 'tuple', elems: closure.params }, { kind: 'tuple', elems: sig.params }) &&
        this.unifier.tryUnify(closure.ret, sig.ret);
      return ok ? 'yes' : 'no';
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

  private implAnswer(trait: TraitDef, type: Type, args: Type[]): Answer {
    if (this.implGoals.length >= 64 || this.implGoals.some((goal) => matchesImplGoal(goal, trait, type, args))) {
      return 'no';
    }
    this.implGoals.push({ trait, type, args });
    try {
      return this.findImplAnswer(trait, type, args);
    } finally {
      this.implGoals.pop();
    }
  }

  private findImplAnswer(trait: TraitDef, type: Type, args: Type[]): Answer {
    let answer: Answer = 'no';
    for (const impl of this.program.impls) {
      if (impl.trait?.trait !== trait) continue;
      const snapshot = this.unifier.snapshot();
      const matched = this.matchImplAnswer(impl, type, args);
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

  private matchImplAnswer(impl: ImplDef, type: Type, traitArgs: Type[]): { subst: Subst; answer: Answer } | undefined {
    const subst: Subst = new Map(impl.params.map((param) => [param, freshVar()]));
    const snapshot = this.unifier.snapshot();
    const selfType = substitute(impl.selfType, subst);
    if (!this.unifier.unify(selfType, type)) {
      this.unifier.rollback(snapshot);
      return undefined;
    }
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
      if (!(impl.module as Module).isStd) bounds.push(sized);
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
const PARAMETER_BLANKET_TRAITS = new Set(['Borrow', 'From', 'Into', 'TryFrom', 'TryInto', 'ExtendInto']);

export function closureKindAtLeast(have: string, need: string): boolean {
  const order = ['Fn', 'FnMut', 'FnOnce'];
  return order.includes(have) && order.indexOf(have) <= order.indexOf(need);
}

export function moduleOf(def: { module?: unknown }): Module | undefined {
  return def.module as Module | undefined;
}
