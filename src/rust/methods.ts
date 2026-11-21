import type { ReceiverAdjust } from './annotations';
import { normalize } from './infer';
import type { Program } from './items';
import { dynIteratorTarget, intoIterItem, intoIterShape, iterationBound } from './iterTypes';
import type { TraitSolver } from './traits';
import {
  allSupertraits,
  type FnDef,
  freshVar,
  type ImplDef,
  isBuiltin,
  ref,
  resolve,
  shallow,
  substitute,
  substituteTraitRef,
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
// code-gauge-allow functionCognitiveComplexity 28 -- Follows rustc's method probe step by step.
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
    // A range is its own iterator: its `Iterator` methods come at each autoref with its other trait methods.
    const asIter = isRangeIterator(stepType) ? rangeAsIter(program, stepType) : undefined;
    for (const autoref of ['none', 'ref', 'mut'] as const) {
      const found = probe(program, solver, stepType, autoref, name, inScope);
      if (found) return { ...found, adjust: { derefs: step.derefs, autoref, asIter: false } };
      const dynamic = probeDynamicIterator(program, solver, step, name, autoref);
      if (dynamic) return dynamic;
      const iterFound = asIter && probe(program, solver, asIter, autoref, name);
      if (iterFound) return { ...iterFound, adjust: { derefs: step.derefs, autoref, asIter: true } };
    }
    if (stepType.kind === 'var') return 'ambiguous';
  }
  // A type parameter or an opaque type bounded by `Iterator` has the methods of `Iter`, and by `IntoIterator`,
  // `into_iter`.
  const bounded = steps.find((step) => {
    const type = normalize(shallow(step.type));
    return (type.kind === 'param' || type.kind === 'opaque') && iterationBound(type);
  });
  if (bounded) {
    const bound = iterationBound(normalize(shallow(bounded.type))) as TraitRef;
    if (bound.trait.builtin === 'Iterator' || name === 'into_iter') {
      return probeAsIter(program, solver, bounded, name, true);
    }
  }
  const characterIter = steps.find((step) => {
    const type = shallow(step.type);
    return isBuiltin(type, 'CaseIter') || isBuiltin(type, 'EscapeDefault') || isBuiltin(type, 'EscapeUnicode');
  });
  return characterIter && probeAsIter(program, solver, characterIter, name, false);
}

const DYN_ITERATOR_METHODS = new Set(['next', 'next_back', 'nth', 'nth_back', 'len']);

function probeDynamicIterator(
  program: Program,
  solver: TraitSolver,
  step: DerefStep,
  name: string,
  autoref: ReceiverAdjust['autoref']
): MethodMatch | undefined {
  const type = normalize(shallow(step.type));
  const target = dynIteratorTarget(type);
  const item = target && intoIterItem(target);
  if (!target || !item) return;
  if (type.kind === 'dyn' && !DYN_ITERATOR_METHODS.has(name)) return;
  if (type.kind === 'ref' && type.target.kind === 'dyn' && autoref !== 'none') return;
  const shape = program.shapeType('DynIteratorShape', [target]);
  const found = probe(program, solver, program.iterType(item, shape), autoref, name);
  if (!found) return;
  const adjust: ReceiverAdjust = { derefs: step.derefs, autoref, asIter: true };
  if (type.kind === 'ref' && found.fn.selfMode === 'value') {
    adjust.autoref = 'mut';
    adjust.derefs = [...step.derefs, 'mutRef'];
  }
  return { ...found, adjust };
}

function isRangeIterator(type: Type): boolean {
  return type.kind === 'adt' && RANGE_ITERATORS.has(type.def.builtin as string);
}

/** The `Iter` type a range is as an iterator, when its elements step. */
function rangeAsIter(program: Program, range: Type): Type | undefined {
  const item = intoIterItem(range);
  const shape = intoIterShape(program, range);
  return item && shape && program.iterType(item, shape);
}

/** Finds a method of iterators for a receiver that is an iterator of another type. */
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
  const boundCandidates = boundMethods(target, name).flatMap(({ bound, fn }) =>
    fn.selfMode
      ? [
          {
            trait: bound.trait,
            attempt: () => matchTraitSelf(solver, bound, fn, target, receiverType),
          },
        ]
      : []
  );
  const match = resolveTraitCandidate(solver, receiverType, name, boundCandidates);
  if (match) return match;
  return resolveTraitCandidate(
    solver,
    receiverType,
    name,
    traitCandidates(program, solver, receiverType, name, inScope)
  );
}

function resolveTraitCandidate(
  solver: TraitSolver,
  receiver: Type,
  name: string,
  candidates: TraitCandidate[]
): Omit<MethodMatch, 'adjust'> | undefined {
  for (const [index, candidate] of candidates.entries()) {
    const found = candidate.attempt();
    if (!found) continue;
    const others = candidates.slice(index + 1);
    const other = others.find((item) => item.trait !== candidate.trait && applies(solver, item.attempt));
    if (other) return { ...found, ambiguousWith: other.trait };
    const { trait } = candidate;
    if (
      trait.params.length > 0 &&
      ((candidate.concrete && trait.builtin) ||
        others.some((item) => item.trait === trait && applies(solver, item.attempt)))
    ) {
      const fn = trait.methods.get(name)!;
      const selfType = selfForMode(fn.selfMode!, receiver)!;
      return { ...independentTraitMethod(trait, fn, selfType), selfType };
    }
    return found;
  }
  return undefined;
}

interface TraitCandidate {
  trait: TraitDef;
  concrete?: boolean;
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
    if (!declared?.selfMode || !inScope(trait)) continue;
    const fn = impl.methods.get(name) ?? declared;
    candidates.push({
      trait,
      concrete: true,
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

function applies(solver: TraitSolver, attempt: () => unknown): boolean {
  const snapshot = solver.unifier.snapshot();
  const found = attempt();
  solver.unifier.rollback(snapshot);
  return found !== undefined;
}

/** The type `Self` must be for a method with this receiver mode to take `receiverType`. */
function selfForMode(mode: 'value' | 'ref' | 'mutRef', receiverType: Type): Type | undefined {
  if (mode === 'value') {
    const t = normalize(shallow(receiverType));
    return t.kind === 'str' || t.kind === 'slice' || t.kind === 'dyn' ? undefined : receiverType;
  }
  const t = shallow(receiverType);
  if (t.kind !== 'ref') return undefined;
  if (mode === 'mutRef' && !t.mutable) return undefined;
  if (mode === 'ref' && t.mutable) return undefined;
  return t.target;
}

function ownParams(fn: FnDef): Type[] {
  return fn.params.slice(fn.parentParamCount).map(() => freshVar());
}

export function failedInherentBound(
  program: Program,
  solver: TraitSolver,
  receiver: Type,
  name: string
): { type: Type; ref: TraitRef } | undefined {
  for (const { type } of autoderefSteps(program, receiver)) {
    for (const impl of program.impls) {
      const fn = impl.methods.get(name);
      if (impl.trait || !fn?.selfMode) continue;
      const missing = failedImplBound(solver, impl, arrayAsSlice(fn, type));
      if (missing) return missing;
    }
  }
  return undefined;
}

function failedImplBound(
  solver: TraitSolver,
  impl: ImplDef,
  receiver: Type
): { type: Type; ref: TraitRef } | undefined {
  const snapshot = solver.unifier.snapshot();
  try {
    const subst = solver.matchImplSelf(impl, receiver);
    if (!subst) return undefined;
    for (const param of impl.params) {
      const type = subst.get(param)!;
      for (const bound of param.bounds) {
        const ref = substituteTraitRef(bound, subst);
        if (solver.implements(type, ref) === 'no')
          return { type: resolve(type), ref: { ...ref, args: ref.args.map((arg) => resolve(arg)) } };
      }
    }
    return undefined;
  } finally {
    solver.unifier.rollback(snapshot);
  }
}

function matchSelf(
  solver: TraitSolver,
  impl: ImplDef,
  fn: FnDef,
  receiverType: Type
): Omit<MethodMatch, 'adjust'> | undefined {
  const selfType = selfForMode(fn.selfMode!, receiverType);
  if (!selfType) return undefined;
  const subst = solver.matchImpl(impl, arrayAsSlice(fn, selfType));
  if (!subst) return undefined;
  const implArgs = impl.params.map((param) => subst.get(param) as Type);
  return { fn, typeArgs: [...implArgs, ...ownParams(fn)], selfType: substitute(impl.selfType, subst) };
}

/** Standard declarations use slice stand-ins for arrays without const length parameters. */
function arrayAsSlice(fn: FnDef, selfType: Type): Type {
  if (fn.selfMode !== 'value' || !(fn.module as { isStd?: boolean }).isStd) return selfType;
  const t = normalize(shallow(selfType));
  const declared = fn.impl && normalize(shallow(fn.impl.selfType));
  if (t.kind === 'array' && declared?.kind === 'slice') return { kind: 'slice', elem: t.elem };
  if (t.kind === 'ref' && declared?.kind === 'ref' && t.mutable === declared.mutable) {
    const target = normalize(shallow(t.target));
    if (target.kind === 'array' && shallow(declared.target).kind === 'slice')
      return { ...t, target: { kind: 'slice', elem: target.elem } };
  }
  return selfType;
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

interface Associated {
  fn: FnDef;
  typeArgs: Type[];
  ambiguousWith?: TraitDef;
}

/** Finds an associated function or method by a path such as `Type::name`, for calls like `String::from` or `Point::new`. */
export function lookupAssociated(
  program: Program,
  solver: TraitSolver,
  selfType: Type,
  name: string,
  inScope: (trait: TraitDef) => boolean
): Associated | undefined {
  const t = normalize(shallow(selfType));
  const direct = inherentAssociated(program, solver, t, name) ?? boundAssociated(t, name);
  if (direct) return direct;
  const candidates = associatedCandidates(program, solver, t, name);
  const matching = candidates.filter((candidate) => applies(solver, candidate.attempt));
  const visible = matching.filter(({ trait }) => inScope(trait));
  const first = visible[0] ?? matching[0];
  if (!first) return;
  const second = visible.find(({ trait }) => trait !== first.trait);
  const found = first.attempt()!;
  return second ? { ...found, ambiguousWith: second.trait } : found;
}

function inherentAssociated(program: Program, solver: TraitSolver, t: Type, name: string): Associated | undefined {
  for (const impl of program.impls) {
    if (impl.trait) continue;
    const fn = impl.methods.get(name);
    if (!fn) continue;
    const subst = solver.matchImpl(impl, t);
    if (subst) return { fn, typeArgs: [...impl.params.map((param) => subst.get(param) as Type), ...ownParams(fn)] };
  }
  return undefined;
}

function boundAssociated(t: Type, name: string): Associated | undefined {
  const [first, ...others] = boundMethods(t, name);
  if (!first) return undefined;
  const { bound, fn } = first;
  const other = others.find((entry) => entry.bound.trait !== bound.trait);
  if (other) return { fn, typeArgs: [t, ...bound.args, ...ownParams(fn)], ambiguousWith: other.bound.trait };
  if (bound.trait.params.length > 0 && others.length > 0) return independentTraitMethod(bound.trait, fn, t);
  return { fn, typeArgs: [t, ...bound.args, ...ownParams(fn)] };
}

function boundMethods(t: Type, name: string): { bound: TraitRef; fn: FnDef }[] {
  const bounds = boundsOf(t);
  if (!bounds) return [];
  return allSupertraits(bounds, t).flatMap((bound) => {
    const fn = bound.trait.methods.get(name);
    return fn ? [{ bound, fn }] : [];
  });
}

interface AssociatedCandidate {
  trait: TraitDef;
  attempt: () => Associated | undefined;
}

function associatedCandidates(program: Program, solver: TraitSolver, t: Type, name: string): AssociatedCandidate[] {
  const candidates: AssociatedCandidate[] = [];
  for (const impl of program.impls) {
    if (!impl.trait) continue;
    const { trait } = impl.trait;
    const declared = trait.methods.get(name);
    if (declared) candidates.push({ trait, attempt: () => matchImplAssociated(solver, impl, declared, t) });
  }
  for (const trait of program.traits) {
    if (!trait.builtin) continue;
    const fn = trait.methods.get(name);
    if (fn) candidates.push({ trait, attempt: () => matchBuiltinAssociated(solver, trait, fn, t) });
  }
  return candidates;
}

function matchImplAssociated(solver: TraitSolver, impl: ImplDef, declared: FnDef, t: Type): Associated | undefined {
  const { trait, args } = impl.trait!;
  if (trait.params.length > 0) {
    return applies(solver, () => solver.matchImpl(impl, t)) ? independentTraitMethod(trait, declared, t) : undefined;
  }
  const subst = solver.matchImpl(impl, t);
  if (!subst) return;
  const fn = impl.methods.get(declared.name);
  if (fn) return { fn, typeArgs: [...impl.params.map((param) => subst.get(param) as Type), ...ownParams(fn)] };
  return { fn: declared, typeArgs: [t, ...args.map((arg) => substitute(arg, subst)), ...ownParams(declared)] };
}

function independentTraitMethod(trait: TraitDef, fn: FnDef, self: Type): Associated {
  return { fn, typeArgs: [self, ...trait.params.map(() => freshVar()), ...ownParams(fn)] };
}

function matchBuiltinAssociated(solver: TraitSolver, trait: TraitDef, fn: FnDef, t: Type): Associated | undefined {
  const args = trait.params.map(() => freshVar());
  const answer = solver.implements(t, { trait, args });
  const derived = t.kind === 'adt' && t.def.derives.has(trait.builtin!);
  const boxDefault = trait.builtin === 'Default' && t.kind === 'adt' && t.def.builtin === 'Box';
  if (answer === 'yes' || (answer === 'unknown' && (args.length > 0 || derived || boxDefault))) {
    return { fn, typeArgs: [t, ...args, ...ownParams(fn)] };
  }
  return undefined;
}
