import type { Annotations } from './annotations';
import type { Expr, Pattern } from './ast';
import { normalize } from './infer';
import type { Place } from './loanGraph';
import { type Layout, NONE } from './regions';
import { shallow, type Type } from './types';

/** How a pattern binds variables: by value, or by a shared or a mutable reference (match ergonomics). */
export type BindingMode = 'shared' | 'mut' | undefined;

/**
 * A pattern that is no binding matches through the references in its type, which make its bindings bind by reference.
 * The type checker gives the parts of a value matched by reference reference types, which no place has.
 */
export function matchDeref(p: Pattern, place: Place, byRef: BindingMode): [Place, BindingMode] {
  let sub = place;
  let mode = byRef;
  let wrapped = byRef !== undefined;
  let t = p.ty && normalize(shallow(p.ty));
  while (t?.kind === 'ref') {
    if (wrapped) wrapped = false;
    else {
      sub = project(sub, '*');
      mode = t.mutable && mode !== 'shared' ? 'mut' : 'shared';
    }
    t = normalize(shallow(t.target));
  }
  return [sub, mode];
}

export function project(place: Place, elem: string): Place {
  return { root: place.root, proj: [...place.proj, elem] };
}

/**
 * For a reference coerced by derefs through shared references (`&&'a str` to `&str`), the place of the inner
 * reference it copies: what it points to lives as long as that reference says, not the outer one.
 */
export function derefCoercedPlace(
  annotations: Annotations,
  expr: Expr,
  placeOf: (expr: Expr) => Place | undefined
): { place: Place; type: Type } | undefined {
  const coercion = annotations.coercions.get(expr);
  if (coercion?.kind !== 'deref' || coercion.fromMut || coercion.derefs.length === 0) return undefined;
  if (!coercion.derefs.every((step) => step === 'ref')) return undefined;
  let place = placeOf(expr);
  let type = expr.ty && normalize(shallow(expr.ty));
  for (let step = 0; step < coercion.derefs.length; step++) {
    if (!place || type?.kind !== 'ref') return undefined;
    place = project(place, '*');
    type = normalize(shallow(type.target));
  }
  return place && type?.kind === 'ref' ? { place, type } : undefined;
}

export function tupleElem(layout: Layout, index: number): Layout {
  return layout.kind === 'tuple' ? (layout.elems[index] ?? NONE) : NONE;
}

export function refTarget(type: Type | undefined): Type | undefined {
  const t = type && normalize(shallow(type));
  return t?.kind === 'ref' ? t.target : undefined;
}

/** Whether `*` of a value of the type goes through a pointer: a reference, a raw pointer, or a `Deref` impl. */
export function isReference(type: Type | undefined): boolean {
  const t = type && normalize(shallow(type));
  return t?.kind === 'ref' || (t?.kind === 'adt' && t.def.builtin !== 'Box');
}
