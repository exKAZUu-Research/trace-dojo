import { normalize } from './infer';
import { type AdtDef, childTypes, type ClosureType, shallow, type Type, type TypeParam } from './types';

/** A region: the points where the borrows of a reference (or of a lifetime parameter) must stay valid. */
export type RVar = number;

/**
 * Where the regions of a value of a type are: one for each reference and each lifetime parameter it contains, as rustc
 * gives each a region variable.
 */
export type Layout =
  | { kind: 'ref'; region: RVar; mutable: boolean; target: Layout }
  | { kind: 'adt'; def: AdtDef; own: RVar[]; args: Layout[] }
  | { kind: 'tuple'; elems: Layout[] }
  | { kind: 'seq'; elem: Layout }
  /** A closure, a trait object, or a type parameter: borrows whose structure the type does not show. */
  | { kind: 'opaque'; region: RVar; closure?: ClosureType }
  | { kind: 'none' };

export const NONE: Layout = { kind: 'none' };

export function layoutOf(type: Type | undefined, fresh: () => RVar, staticRegion = fresh): Layout {
  if (!type) return NONE;
  const t = normalize(shallow(type));
  switch (t.kind) {
    case 'ref': {
      const region = t.lifetime === "'static" ? staticRegion() : fresh();
      const target = referencedObject(t.target, region) ?? layoutOf(t.target, fresh, staticRegion);
      return { kind: 'ref', region, mutable: t.mutable, target };
    }
    case 'adt': {
      const own = (t.def.lifetimeParams ?? []).map(() => fresh());
      const args = t.args.map((arg) => layoutOf(arg, fresh, staticRegion));
      return adtLayout(t.def, own, args);
    }
    case 'tuple': {
      const elems = t.elems.map((elem) => layoutOf(elem, fresh, staticRegion));
      return elems.every(isNone) ? NONE : { kind: 'tuple', elems };
    }
    case 'array':
    case 'slice': {
      const elem = layoutOf(t.elem, fresh, staticRegion);
      return isNone(elem) ? NONE : { kind: 'seq', elem };
    }
    case 'closure': {
      return { kind: 'opaque', region: fresh(), closure: t.closure };
    }
    case 'dyn': {
      return { kind: 'opaque', region: t.objectLifetime === 'static' ? staticRegion() : fresh() };
    }
    case 'param':
    case 'opaque': {
      return { kind: 'opaque', region: fresh() };
    }
    default: {
      return NONE;
    }
  }
}

function referencedObject(type: Type, region: RVar): Layout | undefined {
  const target = shallow(type);
  return target.kind === 'dyn' && target.objectLifetime === 'reference' ? { kind: 'opaque', region } : undefined;
}

function adtLayout(def: AdtDef, own: RVar[], args: Layout[]): Layout {
  const declared = def.variants.some((variant) => variant.fields.some((field) => staticObject(field.type)));
  return own.length === 0 && args.every(isNone) && !declared ? NONE : { kind: 'adt', def, own, args };
}

function staticObject(type: Type): boolean {
  const t = shallow(type);
  return (t.kind === 'dyn' && t.objectLifetime === 'static') || childTypes(t).some(staticObject);
}

export function isNone(layout: Layout): boolean {
  return layout.kind === 'none';
}

export function regionsOf(layout: Layout): RVar[] {
  switch (layout.kind) {
    case 'ref': {
      return [layout.region, ...regionsOf(layout.target)];
    }
    case 'adt': {
      return [...layout.own, ...layout.args.flatMap(regionsOf)];
    }
    case 'tuple': {
      return layout.elems.flatMap(regionsOf);
    }
    case 'seq': {
      return regionsOf(layout.elem);
    }
    case 'opaque': {
      return [layout.region];
    }
    case 'none': {
      return [];
    }
  }
}

/** Records that `sup` outlives `sub`: the borrows of region `sup` stay valid wherever those of `sub` must. */
export type Outlives = (sup: RVar, sub: RVar) => void;

/**
 * Relates the regions of a value flowing from a place of layout `sup` to one of layout `sub`: each region of `sup`
 * outlives the matching one of `sub`, and they are equal where the type is invariant (behind `&mut`).
 */
// code-gauge-allow functionCognitiveComplexity 24 -- One case per kind of layout.
export function relate(outlives: Outlives, sup: Layout, sub: Layout, invariant = false): void {
  if (sup.kind === 'none' || sub.kind === 'none') return;
  const both = (a: RVar, b: RVar): void => {
    outlives(a, b);
    if (invariant) outlives(b, a);
  };
  if (sup.kind === 'ref' && sub.kind === 'ref') {
    both(sup.region, sub.region);
    relate(outlives, sup.target, sub.target, invariant || sub.mutable);
    return;
  }
  if (
    sup.kind === 'adt' &&
    sub.kind === 'adt' &&
    sup.def === sub.def &&
    sup.own.length === sub.own.length &&
    sup.args.length === sub.args.length
  ) {
    for (const [index, region] of sup.own.entries()) both(region, sub.own[index]);
    for (const [index, arg] of sup.args.entries()) relate(outlives, arg, sub.args[index], invariant);
    return;
  }
  if (sup.kind === 'tuple' && sub.kind === 'tuple' && sup.elems.length === sub.elems.length) {
    for (const [index, elem] of sup.elems.entries()) relate(outlives, elem, sub.elems[index], invariant);
    return;
  }
  if (sup.kind === 'seq' && sub.kind === 'seq') {
    relate(outlives, sup.elem, sub.elem, invariant);
    return;
  }
  if (sup.kind === 'opaque' && sub.kind === 'opaque') {
    both(sup.region, sub.region);
    return;
  }
  // The shapes differ (a coercion, or a type the layouts do not follow): any borrow may flow anywhere.
  for (const a of regionsOf(sup)) for (const b of regionsOf(sub)) both(a, b);
}

/** Every region of a layout outlives `region`, as a reference to a value of the layout requires. */
export function outlivesAll(outlives: Outlives, layout: Layout, region: RVar): void {
  for (const r of regionsOf(layout)) outlives(r, region);
}

/** What the lifetime and type parameters of a declared type stand for in a value's layout. */
export interface Subst {
  lifetime(name: string | undefined): RVar;
  param(param: TypeParam): Layout | undefined;
}

/** The layout of a declared type (a field's, a signature's) with its parameters substituted. */
export function instantiate(declared: Type, subst: Subst, fresh: () => RVar): Layout {
  const t = shallow(declared);
  switch (t.kind) {
    case 'ref': {
      const region = subst.lifetime(t.lifetime);
      const target = referencedObject(t.target, region) ?? instantiate(t.target, subst, fresh);
      return { kind: 'ref', region, mutable: t.mutable, target };
    }
    case 'dyn': {
      return { kind: 'opaque', region: t.objectLifetime === 'static' ? subst.lifetime("'static") : fresh() };
    }
    case 'param': {
      return subst.param(t.param) ?? NONE;
    }
    case 'adt': {
      const written = t.lifetimes ?? [];
      const own = (t.def.lifetimeParams ?? []).map((_, index) => subst.lifetime(written[index]));
      const args = t.args.map((arg) => instantiate(arg, subst, fresh));
      return adtLayout(t.def, own, args);
    }
    case 'tuple': {
      const elems = t.elems.map((elem) => instantiate(elem, subst, fresh));
      return elems.every(isNone) ? NONE : { kind: 'tuple', elems };
    }
    case 'array':
    case 'slice': {
      const elem = instantiate(t.elem, subst, fresh);
      return isNone(elem) ? NONE : { kind: 'seq', elem };
    }
    default: {
      return layoutOf(t, fresh);
    }
  }
}

/** The layout of a field of a value of a struct or an enum variant. */
export function fieldLayout(layout: Layout, variant: number, field: number, fresh: () => RVar): Layout {
  if (layout.kind === 'opaque') return layout;
  if (layout.kind !== 'adt') return NONE;
  const declared = layout.def.variants[variant]?.fields[field]?.type;
  if (!declared) return NONE;
  const lifetimes = layout.def.lifetimeParams ?? [];
  return instantiate(
    declared,
    {
      lifetime: (name) => {
        const index = name === undefined ? -1 : lifetimes.indexOf(name);
        return index >= 0 ? layout.own[index] : fresh();
      },
      param: (param) => {
        const index = layout.def.params.indexOf(param);
        return index !== -1 ? layout.args[index] : undefined;
      },
    },
    fresh
  );
}

/** The layout of an element at an index: of a `Vec`, a slice, an array, or a value of a map. */
export function elementLayout(layout: Layout): Layout {
  if (layout.kind === 'seq') return layout.elem;
  if (layout.kind === 'opaque') return layout;
  if (layout.kind !== 'adt') return NONE;
  const builtin = layout.def.builtin;
  if (builtin === 'HashMap' || builtin === 'BTreeMap') return layout.args[1] ?? NONE;
  return layout.args[0] ?? NONE;
}

/** The layout after a deref that an owner does: a `Box`'s content, or a collection's slice. */
export function ownedDerefLayout(layout: Layout): Layout {
  if (layout.kind !== 'adt') return layout;
  if (layout.def.builtin === 'Box') return layout.args[0] ?? NONE;
  if (layout.def.builtin === 'Vec' || layout.def.builtin === 'VecDeque') {
    const elem = layout.args[0] ?? NONE;
    return isNone(elem) ? NONE : { kind: 'seq', elem };
  }
  return NONE;
}
