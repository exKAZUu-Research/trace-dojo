import { isPseudo, normalize, type Unifier } from './infer';
import type { Module, Program } from './items';
import { builtinImplements } from './traitBuiltins';
import { infallibleConversion } from './traitConversions';
import {
  F32,
  F64,
  freshVar,
  type ImplDef,
  INT_NAMES,
  intType,
  shallow,
  type Subst,
  substitute,
  substituteTraitRef,
  supertraitsOf,
  type TraitDef,
  type TraitRef,
  type Type,
  USIZE,
} from './types';

export { ERROR_TYPES, RANGE_TYPES } from './traitBuiltins';
export { infallibleConversion } from './traitConversions';
export { iteratorCapability } from './traitIterators';

export type Answer = 'yes' | 'no' | 'unknown';

/** Decides which types implement which traits: from impls, derives, bounds, and the standard library's rules. */
export class TraitSolver {
  constructor(
    readonly program: Program,
    readonly unifier: Unifier
  ) {}

  /** Whether `type` implements the trait, binding variables of closure signatures as a side effect. */
  // code-gauge-allow functionCognitiveComplexity 20 -- One rule per trait or conversion of the standard library.
  implements(type: Type, ref: TraitRef): Answer {
    const t = normalize(shallow(type));
    const { trait } = ref;
    if (t.kind === 'never') return 'yes';
    if (t.kind === 'var') return this.varImplements(t, ref);
    // Type parameters are `Sized` unless they opt out with `?Sized`.
    if (t.kind === 'param') return trait.builtin === 'Sized' || this.boundsImply(t.param.bounds, ref, t) ? 'yes' : 'no';
    // A pseudo-type that stays is one whose arguments are not known yet.
    if (t.kind === 'adt' && isPseudo(t.def)) return 'unknown';
    if (t.kind === 'opaque') return this.boundsImply(t.opaque.bounds, ref, t) ? 'yes' : this.builtinOnly(t, ref);
    if (t.kind === 'dyn') {
      if (this.boundsImply([t.trait], ref, t)) return 'yes';
      return this.builtinOnly(t, ref);
    }
    if (ref.fnSig) return this.closureImplements(t, ref);
    const user = this.userImpl(trait, t, ref.args);
    if (user) return 'yes';
    if (trait.builtin) return builtinImplements(this, t, ref);
    return 'no';
  }

  private builtinOnly(t: Type, ref: TraitRef): Answer {
    return ref.trait.builtin ? builtinImplements(this, t, ref) : 'no';
  }

  private varImplements(t: Type & { kind: 'var' }, ref: TraitRef): Answer {
    // An untyped number indexing a slice is a `usize`, the only integer type slices take.
    if (t.v.literal === 'int' && ref.trait.builtin === 'SliceIndex')
      return this.unifier.tryUnify(t, USIZE) ? 'yes' : 'no';
    if (!t.v.literal) return 'unknown';
    const rhs = ref.args[0];
    if (rhs && (ref.trait.builtin === 'PartialEq' || ref.trait.builtin === 'PartialOrd')) {
      return this.unifier.tryUnify(t, rhs) ? 'yes' : 'no';
    }
    // rustc takes a number's type from the one impl that fits it, among the impls for numbers of its kind.
    const only = this.onlyNumericImpl(t.v.literal, ref);
    if (only) return this.unifier.tryUnify(t, only) ? 'yes' : 'no';
    if (ref.trait.builtin) return this.literalImplements(t.v.literal, ref);
    return 'unknown';
  }

  /** The one number type of a literal's kind that implements a trait, if exactly one does. */
  private onlyNumericImpl(literal: 'int' | 'float', ref: TraitRef): Type | undefined {
    const numbers: Type[] = literal === 'int' ? INT_NAMES.map((name) => intType(name)) : [F32, F64];
    if (ref.trait.builtin === 'Into') {
      const target = normalize(shallow(ref.args[0]));
      if (target.kind !== 'int') return undefined;
      const fitting = numbers.filter((number) => infallibleConversion(number, target));
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
  // code-gauge-allow functionCognitiveComplexity 21 -- One rule per trait or conversion of the standard library.
  boundsImply(bounds: TraitRef[], ref: TraitRef, self?: Type): boolean {
    const blanket = BLANKET_IMPLS[ref.trait.builtin as string];
    if (
      blanket &&
      this.boundsImply(bounds, { trait: this.program.traitDef(blanket), args: [], item: ref.item }, self)
    ) {
      return true;
    }
    const seen = new Set<TraitDef>();
    const stack = [...bounds];
    while (stack.length > 0) {
      const bound = stack.pop() as TraitRef;
      if (bound.trait === ref.trait) {
        if (ref.fnSig && bound.fnSig) {
          return (
            bound.fnSig.params.length === ref.fnSig.params.length &&
            this.unifier.tryUnify(
              { kind: 'tuple', elems: bound.fnSig.params },
              { kind: 'tuple', elems: ref.fnSig.params }
            ) &&
            this.unifier.tryUnify(bound.fnSig.ret, ref.fnSig.ret)
          );
        }
        const argsMatch = bound.args.every(
          (arg, i) => ref.args[i] === undefined || this.unifier.tryUnify(arg, ref.args[i])
        );
        if (argsMatch && this.itemsMatch(bound, ref)) return true;
      }
      if (ref.fnSig && bound.fnSig && closureKindAtLeast(bound.trait.name, ref.trait.name)) {
        return (
          bound.fnSig.params.length === ref.fnSig.params.length &&
          this.unifier.tryUnify(
            { kind: 'tuple', elems: bound.fnSig.params },
            { kind: 'tuple', elems: ref.fnSig.params }
          ) &&
          this.unifier.tryUnify(bound.fnSig.ret, ref.fnSig.ret)
        );
      }
      if (seen.has(bound.trait)) continue;
      seen.add(bound.trait);
      stack.push(...supertraitsOf(bound, self));
    }
    return false;
  }

  /** Whether a bound gives the `Item` that a required `Iterator` or `IntoIterator` names, as its own or as `IntoItem`. */
  private itemsMatch(bound: TraitRef, ref: TraitRef): boolean {
    if (!ref.item) return true;
    return bound.item !== undefined && this.unifier.tryUnify(bound.item, ref.item);
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- One rule per trait or conversion of the standard library.
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
    // `&F` calls `F` through a shared reference, which needs `F: Fn`; `&mut F` calls it as `F` does.
    if (t.kind === 'ref') {
      if (!t.mutable && ref.trait.name !== 'Fn') {
        return this.closureImplements(normalize(shallow(t.target)), { ...ref, trait: this.program.traitDef('Fn') });
      }
      return this.closureImplements(normalize(shallow(t.target)), ref);
    }
    if (t.kind === 'adt' && t.def.builtin === 'Box') return this.closureImplements(normalize(shallow(t.args[0])), ref);
    return 'no';
  }

  /** The user's impl of a trait for a type, with the impl's type parameters bound. */
  userImpl(trait: TraitDef, type: Type, args: Type[] = []): { impl: ImplDef; subst: Subst } | undefined {
    for (const impl of this.program.impls) {
      if (impl.trait?.trait !== trait) continue;
      const subst = this.matchImpl(impl, type, args);
      if (subst) return { impl, subst };
    }
    return undefined;
  }

  /**
   * Matches an impl's self type (and trait arguments) against a type, binding the impl's parameters to fresh
   * variables; the bindings stay when it matches, so that the caller learns the arguments.
   */
  matchImpl(impl: ImplDef, type: Type, traitArgs: Type[] = []): Subst | undefined {
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
    for (const param of impl.params) {
      const bound = subst.get(param) as Type;
      for (const ref of param.bounds) {
        const answer = this.implements(bound, substituteTraitRef(ref, subst));
        if (answer === 'no') {
          this.unifier.rollback(snapshot);
          return undefined;
        }
      }
    }
    return subst;
  }

  isCopy(type: Type): boolean {
    return this.implements(type, { trait: this.program.traitDef('Copy'), args: [] }) === 'yes';
  }
}

/** The std traits with a blanket impl for every type of another trait: `impl<T: Display> ToString for T`. */
const BLANKET_IMPLS: Record<string, string> = { ToString: 'Display', ToOwned: 'Clone', IntoIterator: 'Iterator' };

export function closureKindAtLeast(have: string, need: string): boolean {
  const order = ['Fn', 'FnMut', 'FnOnce'];
  return order.includes(have) && order.indexOf(have) <= order.indexOf(need);
}

export function moduleOf(def: { module?: unknown }): Module | undefined {
  return def.module as Module | undefined;
}
