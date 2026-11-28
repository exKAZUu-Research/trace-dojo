import type { Program } from './items';
import { arrayAsSlice, autoderefSteps } from './methods';
import type { TraitSolver } from './traits';
import { type ImplDef, resolve, substituteTraitRef, type TraitRef, type Type } from './types';

/**
 * The bound that an inherent impl declaring a method fails for a receiver (`Vec<T>::sort` of a `T` without `Ord`), to
 * report it, or `otherNumber` when only std impls for another kind of number declare the method.
 */
export function failedInherentBound(
  program: Program,
  solver: TraitSolver,
  receiver: Type,
  name: string
): { type: Type; ref: TraitRef } | 'otherNumber' | undefined {
  let otherNumber = false;
  for (const { type } of autoderefSteps(program, receiver)) {
    for (const impl of program.impls) {
      const fn = impl.methods.get(name);
      if (impl.trait || !fn?.selfMode) continue;
      const missing = failedImplBound(solver, impl, arrayAsSlice(fn, type));
      if (missing === 'otherNumber') otherNumber = true;
      else if (missing) return missing;
    }
  }
  return otherNumber ? 'otherNumber' : undefined;
}

/** The pseudo traits by which std declares the methods of one kind of number. */
const NUMBER_KINDS = new Set(['Integer', 'SignedInteger', 'UnsignedInteger', 'Float']);

function failedImplBound(
  solver: TraitSolver,
  impl: ImplDef,
  receiver: Type
): { type: Type; ref: TraitRef } | 'otherNumber' | undefined {
  const snapshot = solver.unifier.snapshot();
  try {
    const subst = solver.matchImplSelf(impl, receiver);
    if (!subst) return undefined;
    for (const param of impl.params) {
      const type = subst.get(param)!;
      for (const bound of param.bounds) {
        const ref = substituteTraitRef(bound, subst);
        if (solver.implements(type, ref) !== 'no') continue;
        // A std impl for one kind of number (`impl<N: Integer> N`) is not a method of another kind (`2.0f64.pow(2)`).
        if (NUMBER_KINDS.has(bound.trait.name) && (impl.module as { isStd?: boolean }).isStd) return 'otherNumber';
        return { type: resolve(type), ref: { ...ref, args: ref.args.map((arg) => resolve(arg)) } };
      }
    }
    return undefined;
  } finally {
    solver.unifier.rollback(snapshot);
  }
}
