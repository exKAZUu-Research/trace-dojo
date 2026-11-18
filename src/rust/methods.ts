import type { ReceiverAdjust } from './annotations';
import { normalize } from './infer';
import type { Program } from './items';
import { intoIterItem, intoIterShape, iterationBound } from './iterTypes';
import type { TraitSolver } from './traits';
import {
  type FnDef,
  freshVar,
  type ImplDef,
  isBuiltin,
  ref,
  shallow,
  substitute,
  type TraitDef,
  type TraitRef,
  type Type,
} from './types';

export interface DerefStep {
  type: Type;
  derefs: ('ref' | 'mutRef' | 'own')[];
}

/** The types a value derefs to, as method calls and field accesses look through them. */
export function autoderefSteps(program: Program, type: Type): DerefStep[] {
  const steps: DerefStep[] = [];
  let current = normalize(shallow(type));
  let derefs: DerefStep['derefs'] = [];
  for (let depth = 0; depth < 16; depth++) {
    steps.push({ type: current, derefs });
    const next = derefOnce(program, current);
    if (!next) break;
    derefs = [...derefs, next.kind];
    current = normalize(shallow(next.type));
  }
  // An array unsizes to a slice after its derefs.
  const last = steps.at(-1) as DerefStep;
  if (last.type.kind === 'array')
    steps.push({ type: { kind: 'slice', elem: last.type.elem }, derefs: [...last.derefs, 'own'] });
  return steps;
}

/** One deref: through a reference, or from an owner to what it owns (`Box<T>` → `T`, `String` → `str`, `Vec<T>` → `[T]`). */
export function derefOnce(program: Program, type: Type): { type: Type; kind: 'ref' | 'mutRef' | 'own' } | undefined {
  const t = shallow(type);
  if (t.kind === 'ref') return { type: t.target, kind: t.mutable ? 'mutRef' : 'ref' };
  if (t.kind !== 'adt') return undefined;
  switch (t.def.builtin) {
    case 'Box': {
      return { type: t.args[0], kind: 'own' };
    }
    case 'String': {
      return { type: { kind: 'str' }, kind: 'own' };
    }
    case 'Vec': {
      return { type: { kind: 'slice', elem: t.args[0] }, kind: 'own' };
    }
    default: {
      void program;
      return undefined;
    }
  }
}

export interface MethodMatch {
  fn: FnDef;
  typeArgs: Type[];
  adjust: ReceiverAdjust;
  /** The type of `self` in the method's signature, after the impl's parameters are bound. */
  selfType: Type;
  /** Another trait whose method of the name also applies, which makes the call ambiguous (E0034). */
  ambiguousWith?: TraitDef;
}

const RANGE_ITERATORS = new Set(['Range', 'RangeInclusive', 'RangeFrom']);

/**
 * Finds a method as rustc's method probe does: for each type the receiver derefs to, a method that takes it by value,
 * then by shared reference, then by mutable reference; inherent methods before trait methods, of the standard
 * library's traits those that `inScope` accepts.
 */
// code-gauge-allow functionCognitiveComplexity 18 -- Follows rustc's method probe step by step.
export function lookupMethod(
  program: Program,
  solver: TraitSolver,
  receiver: Type,
  name: string,
  inScope: (trait: TraitDef) => boolean = () => true
): MethodMatch | 'ambiguous' | undefined {
  const steps = autoderefSteps(program, receiver);
  for (const step of steps) {
    const stepType = normalize(shallow(step.type));
    if (stepType.kind === 'var' && !stepType.v.literal) return 'ambiguous';
    for (const autoref of ['none', 'ref', 'mut'] as const) {
      const found = probe(program, solver, stepType, autoref, name, inScope);
      if (found) {
        return {
          ...found,
          adjust: { derefs: step.derefs, autoref, asIter: false },
        };
      }
    }
    if (stepType.kind === 'var') return 'ambiguous';
  }
  // A type parameter or an opaque type bounded by `Iterator` has the methods of `Iter`, and by `IntoIterator`,
  // `into_iter`.
  const bounded = steps.find((step) => iterationBound(normalize(shallow(step.type))));
  if (bounded) {
    const bound = iterationBound(normalize(shallow(bounded.type))) as TraitRef;
    if (bound.trait.builtin === 'Iterator' || name === 'into_iter') {
      return probeAsIter(program, solver, bounded, name, true);
    }
  }
  // A range is an iterator: its methods are those of `Iter`.
  const range = steps.find((step) => {
    const t = shallow(step.type);
    return t.kind === 'adt' && RANGE_ITERATORS.has(t.def.builtin as string);
  });
  if (range) return probeAsIter(program, solver, range, name, true);
  // `char::to_uppercase`'s iterator is an iterator of `char`s that also displays as its text.
  const caseIter = steps.find((step) => isBuiltin(shallow(step.type), 'CaseIter'));
  return caseIter && probeAsIter(program, solver, caseIter, name, false);
}

/** Finds a method of iterators for a receiver that is an iterator of another type (a range). */
function probeAsIter(
  program: Program,
  solver: TraitSolver,
  step: DerefStep,
  name: string,
  asIter: boolean
): MethodMatch | undefined {
  const item = intoIterItem(step.type);
  const shape = intoIterShape(program, step.type);
  if (!item || !shape) return undefined;
  const iter = program.iterType(item, shape);
  for (const autoref of ['none', 'ref', 'mut'] as const) {
    const found = probe(program, solver, iter, autoref, name);
    if (found) return { ...found, adjust: { derefs: step.derefs, autoref, asIter } };
  }
  return undefined;
}

// code-gauge-allow functionCognitiveComplexity 24 -- Follows rustc's method probe step by step.
function probe(
  program: Program,
  solver: TraitSolver,
  stepType: Type,
  autoref: 'none' | 'ref' | 'mut',
  name: string,
  inScope: (trait: TraitDef) => boolean = () => true
): Omit<MethodMatch, 'adjust'> | undefined {
  const receiverType = autoref === 'none' ? stepType : ref(stepType, autoref === 'mut');
  // Inherent methods first.
  for (const impl of program.impls) {
    if (impl.trait) continue;
    const fn = impl.methods.get(name);
    if (!fn?.selfMode) continue;
    const found = matchSelf(solver, impl, fn, receiverType);
    if (found) return found;
  }
  // Methods of the bounds of type parameters, trait objects, and opaque types.
  const t = shallow(receiverType);
  const target = t.kind === 'ref' ? shallow(t.target) : t;
  const bounds = boundsOf(target);
  if (bounds) {
    for (const bound of allSupertraits(bounds)) {
      const fn = bound.trait.methods.get(name);
      if (!fn?.selfMode) continue;
      const found = matchTraitSelf(solver, bound, fn, target, receiverType);
      if (found) return found;
    }
  }
  const candidates = traitCandidates(program, solver, receiverType, name, inScope);
  for (const [index, candidate] of candidates.entries()) {
    const found = candidate.attempt();
    if (!found) continue;
    const other = candidates.slice(index + 1).find((c) => c.trait !== candidate.trait && applies(solver, c.attempt));
    return other ? { ...found, ambiguousWith: other.trait } : found;
  }
  return undefined;
}

interface TraitCandidate {
  trait: TraitDef;
  /** Matches the method, binding what it learns, or gives undefined and binds nothing. */
  attempt: () => Omit<MethodMatch, 'adjust'> | undefined;
}

/** The trait methods of a name that may take the receiver: of trait impls, then of the std traits builtin types have. */
// code-gauge-allow functionCognitiveComplexity 23 -- Follows rustc's method probe step by step.
function traitCandidates(
  program: Program,
  solver: TraitSolver,
  receiverType: Type,
  name: string,
  inScope: (trait: TraitDef) => boolean
): TraitCandidate[] {
  const candidates: TraitCandidate[] = [];
  for (const impl of program.impls) {
    if (!impl.trait) continue;
    const { trait } = impl.trait;
    const declared = trait.methods.get(name);
    if (!declared?.selfMode || (trait.builtin && !inScope(trait))) continue;
    const fn = impl.methods.get(name) ?? declared;
    candidates.push({
      trait,
      attempt: () =>
        fn === declared
          ? matchDefault(solver, impl, declared, receiverType)
          : matchSelf(solver, impl, fn, receiverType),
    });
  }
  for (const trait of program.traits) {
    if (!trait.builtin || !inScope(trait)) continue;
    const fn = trait.methods.get(name);
    if (!fn?.selfMode) continue;
    const selfType = selfForMode(fn.selfMode, receiverType);
    if (!selfType) continue;
    candidates.push({
      trait,
      attempt: () => {
        const snapshot = solver.unifier.snapshot();
        const args = trait.params.map(() => freshVar());
        const answer = solver.implements(selfType, { trait, args });
        if (answer === 'yes' || (answer === 'unknown' && args.length > 0)) {
          return { fn, typeArgs: [selfType, ...args, ...ownParams(fn)], selfType };
        }
        solver.unifier.rollback(snapshot);
        return;
      },
    });
  }
  return candidates;
}

function applies(solver: TraitSolver, attempt: TraitCandidate['attempt']): boolean {
  const snapshot = solver.unifier.snapshot();
  const found = attempt();
  solver.unifier.rollback(snapshot);
  return found !== undefined;
}

/** The type `Self` must be for a method with this receiver mode to take `receiverType`. */
function selfForMode(mode: 'value' | 'ref' | 'mutRef', receiverType: Type): Type | undefined {
  if (mode === 'value') return receiverType;
  const t = shallow(receiverType);
  if (t.kind !== 'ref') return undefined;
  if (mode === 'mutRef' && !t.mutable) return undefined;
  if (mode === 'ref' && t.mutable) return undefined;
  return t.target;
}

function ownParams(fn: FnDef): Type[] {
  return fn.params.slice(fn.parentParamCount).map(() => freshVar());
}

function matchSelf(
  solver: TraitSolver,
  impl: ImplDef,
  fn: FnDef,
  receiverType: Type
): Omit<MethodMatch, 'adjust'> | undefined {
  const selfType = selfForMode(fn.selfMode!, receiverType);
  if (!selfType) return undefined;
  const subst = solver.matchImpl(impl, selfType);
  if (!subst) return undefined;
  const implArgs = impl.params.map((param) => subst.get(param) as Type);
  return { fn, typeArgs: [...implArgs, ...ownParams(fn)], selfType: substitute(impl.selfType, subst) };
}

/** A trait's default method, called on a type with an impl of the trait that does not override it. */
function matchDefault(
  solver: TraitSolver,
  impl: ImplDef,
  fn: FnDef,
  receiverType: Type
): Omit<MethodMatch, 'adjust'> | undefined {
  const selfType = selfForMode(fn.selfMode!, receiverType);
  if (!selfType) return undefined;
  const subst = solver.matchImpl(impl, selfType);
  if (!subst) return undefined;
  const traitArgs = impl.trait!.args.map((arg) => substitute(arg, subst));
  return { fn, typeArgs: [selfType, ...traitArgs, ...ownParams(fn)], selfType };
}

function matchTraitSelf(
  solver: TraitSolver,
  bound: TraitRef,
  fn: FnDef,
  target: Type,
  receiverType: Type
): Omit<MethodMatch, 'adjust'> | undefined {
  const selfType = selfForMode(fn.selfMode!, receiverType);
  if (!selfType || !solver.unifier.tryUnify(selfType, target)) return undefined;
  return { fn, typeArgs: [target, ...bound.args, ...ownParams(fn)], selfType: target };
}

export function boundsOf(type: Type): TraitRef[] | undefined {
  const t = shallow(type);
  if (t.kind === 'param') return t.param.bounds;
  if (t.kind === 'dyn') return [t.trait];
  if (t.kind === 'opaque') return t.opaque.bounds;
  return undefined;
}

export function allSupertraits(bounds: TraitRef[]): TraitRef[] {
  const result: TraitRef[] = [];
  const seen = new Set<TraitDef>();
  const stack = [...bounds];
  while (stack.length > 0) {
    const bound = stack.shift() as TraitRef;
    if (seen.has(bound.trait)) continue;
    seen.add(bound.trait);
    result.push(bound);
    stack.push(...bound.trait.supertraits);
  }
  return result;
}

/** Finds an associated function or method by a path such as `Type::name`, for calls like `String::from` or `Point::new`. */
export function lookupAssociated(
  program: Program,
  solver: TraitSolver,
  selfType: Type,
  name: string
): { fn: FnDef; typeArgs: Type[] } | undefined {
  const t = normalize(shallow(selfType));
  for (const impl of program.impls) {
    if (impl.trait) continue;
    const fn = impl.methods.get(name);
    if (!fn) continue;
    const subst = solver.matchImpl(impl, t);
    if (subst) return { fn, typeArgs: [...impl.params.map((param) => subst.get(param) as Type), ...ownParams(fn)] };
  }
  const bounds = boundsOf(t);
  if (bounds) {
    for (const bound of allSupertraits(bounds)) {
      const fn = bound.trait.methods.get(name);
      if (fn) return { fn, typeArgs: [t, ...bound.args, ...ownParams(fn)] };
    }
  }
  for (const impl of program.impls) {
    if (!impl.trait) continue;
    const declared = impl.trait.trait.methods.get(name);
    if (!declared) continue;
    const subst = solver.matchImpl(impl, t);
    if (!subst) continue;
    const fn = impl.methods.get(name);
    if (fn) return { fn, typeArgs: [...impl.params.map((param) => subst.get(param) as Type), ...ownParams(fn)] };
    return {
      fn: declared,
      typeArgs: [t, ...impl.trait.args.map((arg) => substitute(arg, subst)), ...ownParams(declared)],
    };
  }
  for (const trait of program.traits) {
    if (!trait.builtin) continue;
    const fn = trait.methods.get(name);
    if (!fn) continue;
    const args = trait.params.map(() => freshVar());
    const snapshot = solver.unifier.snapshot();
    const answer = solver.implements(t, { trait, args });
    // A derive implements the trait for every type argument that meets it, which may not be known yet (`W::default()`).
    const derived = t.kind === 'adt' && t.def.derives.has(trait.builtin);
    if (answer === 'yes' || (answer === 'unknown' && (args.length > 0 || derived)))
      return { fn, typeArgs: [t, ...args, ...ownParams(fn)] };
    solver.unifier.rollback(snapshot);
  }
  return undefined;
}
