import { normalize } from './infer';
import { boundsOf } from './methods';
import {
  instantiate,
  invariantParams,
  isNone,
  type Layout,
  layoutOf,
  NONE,
  type Outlives,
  regionsOf,
  relate,
  type RVar,
  type Subst,
} from './regions';
import { type FnDef, shallow, type Type, type TypeParam } from './types';

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
    private readonly fn: FnDef,
    typeArgs: readonly Type[],
    private readonly fresh: () => RVar,
    private readonly outlives: Outlives,
    private readonly staticRegion: () => RVar
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
    for (const a of regionsOf(actual)) for (const b of this.declaredRegions(t)) edge(a, b);
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

  // code-gauge-allow functionCognitiveComplexity 24 -- Applies the lifetime elision rules.
  private bindOutputPart(
    declared: Type,
    actual: Layout,
    invariant: boolean,
    elided: string | undefined,
    inputRegions: RVar[]
  ): void {
    if (isNone(actual)) return;
    const t = shallow(declared);
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
    const recurse = (type: Type, layout: Layout, inv: boolean): void =>
      this.bindOutputPart(type, layout, inv, elided, inputRegions);
    if ((t.kind === 'dyn' && t.lifetime) || forEachPart(t, actual, invariant, recurse)) return;
    // An `impl Trait` result: it may borrow from any input.
    for (const a of inputRegions) for (const b of regionsOf(actual)) edge(a, b);
  }

  /**
   * Relates the type parameters as their bounds say: `B: FromIterator<T>` builds a `B` of `T`s, and a closure
   * parameter `F: FnMut(T) -> B` makes `B`s of `T`s as its summary says.
   */
  // code-gauge-allow functionCognitiveComplexity 26 -- One case per kind of bound.
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
          const args = bound.fnSig.params.map((type) => instantiate(type, this.subst, this.fresh));
          const { ret } = bound.fnSig;
          const higherRanked = higherRankedInputs(bound.fnSig);
          applyClosure(layout, args, instantiate(ret, this.subst, this.fresh), higherRanked);
          continue;
        }
        for (const arg of bound.args) {
          for (const a of this.declaredRegions(arg)) for (const b of regionsOf(layout)) this.outlives(a, b);
        }
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

/** The higher-ranked reference parameters of a callee that is called through a closure bound or a trait object. */
export function higherRankedInputsOf(type: Type | undefined): boolean[] {
  let t = type && normalize(shallow(type));
  while (t && (t.kind === 'ref' || (t.kind === 'adt' && t.def.builtin === 'Box'))) {
    t = normalize(shallow(t.kind === 'ref' ? t.target : t.args[0]));
  }
  const sig = t && boundsOf(t)?.find((bound) => bound.fnSig)?.fnSig;
  return sig ? higherRankedInputs(sig) : [];
}

/**
 * Relates a call of a callee whose body is not known here: what it captures and its arguments may flow into the
 * result, except the lifetime of a reference it takes for every lifetime, which the result cannot name.
 */
export function relateOpaqueCall(
  outlives: Outlives,
  callee: Layout,
  args: Layout[],
  result: Layout,
  higherRanked: boolean[]
): void {
  const inputs = args.flatMap((arg, index) => regionsOf(arg).slice(higherRanked[index] ? 1 : 0));
  for (const a of [...regionsOf(callee), ...inputs]) {
    for (const b of regionsOf(result)) outlives(a, b);
  }
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
