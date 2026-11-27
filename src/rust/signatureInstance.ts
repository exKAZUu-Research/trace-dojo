import { normalize } from './infer';
import { boundsOf } from './methods';
import {
  instantiate,
  invariantParams,
  isNone,
  isReferenceObject,
  type Layout,
  layoutOf,
  NONE,
  type Outlives,
  regionsOf,
  relate,
  type RVar,
  type Subst,
} from './regions';
import { childTypes, type FnDef, shallow, type TraitRef, type Type, type TypeParam } from './types';

/** How a relation makes regions and relates them. */
interface Regions {
  readonly fresh: () => RVar;
  readonly outlives: Outlives;
  readonly staticRegion: () => RVar;
}

/** What a call relates its inputs and its result by: a function's signature, or that of a closure bound. */
type Signature = Pick<FnDef, 'params' | 'paramTypes' | 'ret' | 'selfMode' | 'trait' | 'impl' | 'ast' | 'extraBounds'>;

/** A callee's signature for one call: fresh regions for its lifetimes, and layouts for its type arguments. */
export class SignatureInstance {
  private readonly lifetimes = new Map<string, RVar>();
  private readonly params = new Map<TypeParam, Layout>();
  private readonly subst: Subst;
  private anonymous = 0;
  /** The lifetimes the inputs' types name, each anonymous one with a name of its own. */
  private readonly inputNames = new Set<string>();
  private readonly selfLifetime: string;

  constructor(
    private readonly fn: Signature,
    private readonly typeArgs: readonly Type[],
    readonly fresh: () => RVar,
    readonly outlives: Outlives,
    readonly staticRegion: () => RVar
  ) {
    for (const [index, param] of fn.params.entries())
      this.params.set(param, layoutOf(typeArgs[index], fresh, staticRegion));
    this.subst = {
      lifetime: (name) => (name && name !== "'_" ? this.lifetime(name) : fresh()),
      param: (param) => this.params.get(param),
    };
    this.selfLifetime = fn.ast?.selfParam?.lifetime ?? "'self";
  }

  private lifetime(name: string): RVar {
    if (name === "'static") return this.staticRegion();
    let region = this.lifetimes.get(name);
    if (region === undefined) {
      region = this.fresh();
      this.lifetimes.set(name, region);
    }
    return region;
  }

  private inputName(written: string | undefined): string {
    const name = written && written !== "'_" ? written : `'_${this.anonymous++}`;
    this.inputNames.add(name);
    return name;
  }

  private declaredRegions(type: Type): RVar[] {
    return regionsOf(instantiate(type, this.subst, this.fresh));
  }

  /** The inputs outlive the regions of the parameters they are passed as. */
  bindInputs(inputs: Layout[]): void {
    const { fn } = this;
    const selfType: Type | undefined = fn.trait ? { kind: 'param', param: fn.trait.self } : fn.impl?.selfType;
    const declared: Type[] = [];
    if (fn.selfMode && selfType) {
      declared.push(
        fn.selfMode === 'value'
          ? selfType
          : { kind: 'ref', mutable: fn.selfMode === 'mutRef', target: selfType, lifetime: this.selfLifetime }
      );
    }
    declared.push(...fn.paramTypes);
    for (const [index, type] of declared.entries()) this.bindInput(type, inputs[index] ?? NONE, false);
  }

  private bindInput(declared: Type, actual: Layout, invariant: boolean): void {
    if (isNone(actual)) return;
    const t = shallow(declared);
    const edge = (a: RVar, b: RVar): void => {
      this.outlives(a, b);
      if (invariant) this.outlives(b, a);
    };
    if (t.kind === 'param') {
      const layout = this.params.get(t.param);
      if (layout) relate(this.outlives, actual, layout, invariant);
      return;
    }
    for (const [written, region, fixed] of ownRegions(t, actual)) {
      const declaredRegion = this.lifetime(this.inputName(written));
      edge(region, declaredRegion);
      if (fixed) this.outlives(declaredRegion, region);
    }
    if (forEachPart(t, actual, invariant, (type, layout, inv) => this.bindInput(type, layout, inv))) return;
    if (this.bindBorrowedIterator(t, actual)) return;
    for (const a of regionsOf(actual)) for (const b of this.declaredRegions(t)) edge(a, b);
  }

  /**
   * A borrowed collection passed where an iterator of references is expected (`v.extend(&items)`): the items borrow
   * from the collection, and what they point to holds the collection's own borrows.
   */
  private bindBorrowedIterator(t: Type, actual: Layout): boolean {
    if (actual.kind !== 'ref' || t.kind !== 'adt' || t.def.builtin !== 'Iter' || t.args.length === 0) return false;
    const item = instantiate(t.args[0], this.subst, this.fresh);
    // A map's items are pairs of references into it.
    const references = item.kind === 'tuple' ? item.elems : [item];
    if (!references.every((part) => part.kind === 'ref')) return false;
    for (const part of references) relate(this.outlives, actual, part);
    const iterator = instantiate(t, this.subst, this.fresh);
    if (iterator.kind === 'adt') for (const own of iterator.own) this.outlives(actual.region, own);
    return true;
  }

  /** The result's borrows come from the regions its type names. */
  bindOutput(result: Layout, inputs: Layout[]): void {
    const { fn } = this;
    // Lifetime elision: an omitted lifetime of the result is `self`'s, or the only one of the inputs.
    const elided =
      fn.selfMode === 'ref' || fn.selfMode === 'mutRef'
        ? this.selfLifetime
        : this.inputNames.size === 1
          ? [...this.inputNames][0]
          : undefined;
    this.bindOutputPart(fn.ret, result, false, elided, inputs.flatMap(regionsOf));
  }

  // code-gauge-allow functionCognitiveComplexity -- Applies the lifetime elision rules.
  // code-gauge-allow functionNcss -- One case per kind of region layout.
  private bindOutputPart(
    declared: Type,
    actual: Layout,
    invariant: boolean,
    elided: string | undefined,
    inputRegions: RVar[]
  ): void {
    if (isNone(actual)) return;
    const t = this.indexedElement(shallow(declared));
    // An associated type borrows nothing from the inputs: what it holds comes with the type it stands for.
    if (t.kind === 'adt' && t.def.projection) return;
    const edge = (a: RVar, b: RVar, fixed = false): void => {
      this.outlives(a, b);
      if (invariant || fixed) this.outlives(b, a);
    };
    if (t.kind === 'dyn' && t.objectLifetime === 'static' && actual.kind === 'opaque') {
      edge(this.staticRegion(), actual.region);
      return;
    }
    if (t.kind === 'param' && this.params.has(t.param)) {
      relate(this.outlives, this.params.get(t.param) as Layout, actual, invariant);
      return;
    }
    for (const [written, region, fixed] of ownRegions(t, actual)) {
      // A lifetime that elision cannot pick may be that of any input.
      const name = written && written !== "'_" ? written : elided;
      if (name === undefined) for (const a of inputRegions) edge(a, region);
      else edge(this.lifetime(name), region, fixed);
    }
    if (this.bindReferenceObject(t, actual, invariant, elided, inputRegions)) return;
    const recurse = (type: Type, layout: Layout, inv: boolean): void =>
      this.bindOutputPart(type, layout, inv, elided, inputRegions);
    if ((t.kind === 'dyn' && t.lifetime) || forEachPart(t, actual, invariant, recurse)) return;
    // An `impl Trait` result: it may borrow from any input.
    for (const a of inputRegions) for (const b of regionsOf(actual)) edge(a, b);
  }

  /** What indexing a slice gives (`Indexed<I, T>`), as the type it stands for: `T`, or `[T]` for a range of indexes. */
  private indexedElement(t: Type): Type {
    if (t.kind !== 'adt' || t.def.builtin !== 'Indexed') return t;
    const index = shallow(t.args[0]);
    const known = index.kind === 'param' ? this.typeArgs[this.fn.params.indexOf(index.param)] : index;
    const range = known !== undefined && normalize(shallow(known)).kind === 'adt';
    return range ? { kind: 'slice', elem: t.args[1] } : shallow(t.args[1]);
  }

  /** `&'a dyn T` is `&'a (dyn T + 'a)`: the object's lifetime is the reference's. Returns whether `t` is one. */
  private bindReferenceObject(
    t: Type,
    actual: Layout,
    invariant: boolean,
    elided: string | undefined,
    inputRegions: RVar[]
  ): boolean {
    if (t.kind !== 'ref' || actual.kind !== 'ref' || !isReferenceObject(t.target) || actual.target.kind !== 'opaque') {
      return false;
    }
    const { region } = actual.target;
    const bind = (a: RVar): void => {
      this.outlives(a, region);
      if (invariant || t.mutable) this.outlives(region, a);
    };
    const name = t.lifetime && t.lifetime !== "'_" ? t.lifetime : elided;
    if (name === undefined) for (const a of inputRegions) bind(a);
    else bind(this.lifetime(name));
    return true;
  }

  /**
   * Relates a bound's type arguments to the bounded parameter: `B: FromIterator<T>` builds a `B` of `T`s, and
   * `A: ExtendInto<T>` the other way round makes `T`s of `A`s (or of what `A`s point to).
   */
  private relateBoundArgs(bound: TraitRef, layout: Layout): void {
    if (bound.trait.builtin === 'ExtendInto' || bound.trait.builtin === 'MapExtendInto') {
      const target = instantiate(bound.args[0], this.subst, this.fresh);
      relate(this.outlives, copiedOut(layout, target), target);
      return;
    }
    for (const arg of bound.args) {
      for (const a of this.declaredRegions(arg)) for (const b of regionsOf(layout)) this.outlives(a, b);
    }
  }

  /** Relates what a closure parameter is called with and returns: as its own bound says when it has one. */
  private relateClosureBound(
    sig: { params: Type[]; ret: Type },
    callee: Type | undefined,
    layout: Layout,
    applyClosure: (callee: Layout, args: Layout[], result: Layout, higherRanked: boolean[]) => void
  ): void {
    const args = sig.params.map((type) => instantiate(type, this.subst, this.fresh));
    const ret = instantiate(sig.ret, this.subst, this.fresh);
    const own = boundSignatureOf(callee);
    if (own) relateBoundCall(own, args, ret, this);
    else applyClosure(layout, args, ret, higherRankedInputs(sig));
  }

  /**
   * Relates the type parameters as their bounds say: `B: FromIterator<T>` builds a `B` of `T`s, and a closure
   * parameter `F: FnMut(T) -> B` makes `B`s of `T`s as its summary says.
   */
  relateBounds(applyClosure: (callee: Layout, args: Layout[], result: Layout, higherRanked: boolean[]) => void): void {
    const { fn } = this;
    for (const param of fn.params) {
      const layout = this.params.get(param) as Layout;
      const extra = (fn.extraBounds ?? []).filter((bound) => bound.param === param).map((bound) => bound.bound);
      for (const bound of [...param.bounds, ...extra]) {
        if (bound.trait.builtin === 'Static') {
          for (const region of regionsOf(layout)) this.outlives(region, this.staticRegion());
          continue;
        }
        if (bound.fnSig) {
          this.relateClosureBound(bound.fnSig, this.typeArgs[fn.params.indexOf(param)], layout, applyClosure);
          continue;
        }
        this.relateBoundArgs(bound, layout);
      }
    }
  }
}

/**
 * Which parameters of a closure bound (`Fn(&T) -> U`) are references taken for every lifetime: those without a
 * written lifetime, unless the result has a place for a lifetime, which elision then ties to them.
 */
function higherRankedInputs(sig: { params: Type[]; ret: Type }): boolean[] {
  return sig.params.map((type) => type.kind === 'ref' && type.lifetime === undefined && !namesLifetime(sig.ret));
}

/** Relates a call of a value of a type by the closure bound the type has, if it has one. */
export function relateCallThroughBound(
  callee: Type | undefined,
  args: Layout[],
  result: Layout,
  regions: Regions
): boolean {
  const sig = boundSignatureOf(callee);
  if (sig) relateBoundCall(sig, args, result, regions);
  return sig !== undefined;
}

/** The signature of a callee that is called through a closure bound or a trait object (`F: Fn(&T) -> U`). */
function boundSignatureOf(type: Type | undefined): { params: Type[]; ret: Type } | undefined {
  let t = type && normalize(shallow(type));
  while (t && (t.kind === 'ref' || (t.kind === 'adt' && t.def.builtin === 'Box'))) {
    t = normalize(shallow(t.kind === 'ref' ? t.target : t.args[0]));
  }
  return t && boundsOf(t)?.find((bound) => bound.fnSig)?.fnSig;
}

/**
 * Relates a call through a closure bound as the bound's own signature says, like a call of a function with that
 * signature: a result can borrow only through the type parameters and the lifetimes the signature names, so neither
 * from a reference the callee takes for every lifetime nor from the borrow of the callee that the call makes.
 */
function relateBoundCall(sig: { params: Type[]; ret: Type }, args: Layout[], result: Layout, regions: Regions): void {
  const params = [...typeParamsIn([...sig.params, sig.ret])];
  const signature = { params, paramTypes: sig.params, ret: sig.ret, selfMode: undefined, trait: undefined };
  const instance = new SignatureInstance(
    { ...signature, impl: undefined, ast: undefined },
    params.map((param): Type => ({ kind: 'param', param })),
    regions.fresh,
    regions.outlives,
    regions.staticRegion
  );
  instance.bindInputs(args);
  instance.bindOutput(result, args);
}

function typeParamsIn(types: Type[], found = new Set<TypeParam>()): Set<TypeParam> {
  for (const type of types) {
    const t = shallow(type);
    if (t.kind === 'param') found.add(t.param);
    else typeParamsIn(childTypes(t), found);
  }
  return found;
}

/**
 * Relates a call of a callee whose body is not known here: what it captures and its arguments may flow into the
 * result, except the lifetime of a reference it takes for every lifetime, which the result cannot name, and that of
 * a reference the callee is called through (`map(&f)`).
 */
export function relateOpaqueCall(
  outlives: Outlives,
  callee: Layout,
  args: Layout[],
  result: Layout,
  higherRanked: boolean[]
): void {
  const inputs = args.flatMap((arg, index) => regionsOf(arg).slice(higherRanked[index] ? 1 : 0));
  let called = callee;
  while (called.kind === 'ref') called = called.target;
  for (const a of [...regionsOf(called), ...inputs]) {
    for (const b of regionsOf(result)) outlives(a, b);
  }
}

/**
 * What flows into `target` when extending from `source`: extending from `&T` copies the `T` out, so only what the
 * reference points to flows in, not the borrow itself, and a map's pair `(&K, &V)` copies each part.
 */
function copiedOut(source: Layout, target: Layout): Layout {
  if (source.kind === 'tuple' && target.kind === 'tuple' && source.elems.length === target.elems.length) {
    return { kind: 'tuple', elems: source.elems.map((elem, index) => copiedOut(elem, target.elems[index])) };
  }
  return source.kind === 'ref' && refDepth(source) > refDepth(target) ? source.target : source;
}

function refDepth(layout: Layout): number {
  return layout.kind === 'ref' ? 1 + refDepth(layout.target) : 0;
}

/**
 * The lifetimes a declared type names at its top level (a reference's, an ADT's) with the matching regions, and
 * whether the type is invariant in each.
 */
function ownRegions(t: Type, actual: Layout): [string | undefined, RVar, boolean][] {
  if (t.kind === 'ref' && actual.kind === 'ref') return [[t.lifetime, actual.region, false]];
  if (t.kind === 'dyn' && t.lifetime && actual.kind === 'opaque') return [[t.lifetime, actual.region, false]];
  if (t.kind === 'adt' && actual.kind === 'adt' && actual.def === t.def) {
    const written = t.lifetimes ?? [];
    const fixed = invariantParams(t.def).lifetimes;
    return actual.own.map((region, index) => [written[index], region, fixed.has(index)]);
  }
  return [];
}

/**
 * Calls `visit` on the parts of a declared type with the matching parts of a layout, telling whether their shapes
 * match; the parts behind a `&mut` are invariant.
 */
function forEachPart(
  t: Type,
  actual: Layout,
  invariant: boolean,
  visit: (type: Type, layout: Layout, invariant: boolean) => void
): boolean {
  if (t.kind === 'ref' && actual.kind === 'ref') {
    visit(t.target, actual.target, invariant || t.mutable);
    return true;
  }
  if (t.kind === 'adt' && actual.kind === 'adt' && actual.def === t.def) {
    const fixed = invariantParams(t.def).params;
    for (const [index, arg] of t.args.entries()) visit(arg, actual.args[index] ?? NONE, invariant || fixed.has(index));
    return true;
  }
  if (t.kind === 'tuple' && actual.kind === 'tuple' && t.elems.length === actual.elems.length) {
    for (const [index, elem] of t.elems.entries()) visit(elem, actual.elems[index], invariant);
    return true;
  }
  if ((t.kind === 'array' || t.kind === 'slice') && actual.kind === 'seq') {
    visit(t.elem, actual.elem, invariant);
    return true;
  }
  return false;
}

/** Whether a declared type holds a reference or a type with lifetimes, which a closure's result may borrow through. */
function namesLifetime(type: Type): boolean {
  if (type.kind === 'ref') return true;
  if (type.kind === 'dyn') return type.lifetime !== undefined;
  if (type.kind === 'adt') return (type.lifetimes?.length ?? 0) > 0 || type.args.some(namesLifetime);
  if (type.kind === 'tuple') return type.elems.some(namesLifetime);
  if (type.kind === 'array' || type.kind === 'slice') return namesLifetime(type.elem);
  return false;
}
