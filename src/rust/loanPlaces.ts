import type { Annotations } from './annotations';
import type { Expr, Pattern } from './ast';
import { normalize } from './infer';
import type { Place } from './loanGraph';
import { type Layout, NONE, type Outlives, relate } from './regions';
import { arrayTryFrom } from './traitConversions';
import { type FnDef, shallow, type Type } from './types';

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
  const derefs = copiedReferenceDerefs(annotations, expr);
  if (derefs === undefined) return undefined;
  let place = placeOf(expr);
  let type = expr.ty && normalize(shallow(expr.ty));
  for (let step = 0; step < derefs; step++) {
    if (!place || type?.kind !== 'ref') return undefined;
    place = project(place, '*');
    type = normalize(shallow(type.target));
  }
  return place && type?.kind === 'ref' && !type.mutable ? { place, type } : undefined;
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

export function variantOf(annotations: Annotations, pattern: Pattern): number {
  const res = annotations.paths.get(pattern);
  return res?.kind === 'ctor' ? res.variant : 0;
}

/** The argument a collection's method stores in it (`push`, `insert`), whose drop goes with the collection. */
export function storedElement<V>(fn: FnDef, args: V[]): V | undefined {
  const key = fn.nativeKey;
  if (!key || !/^(Vec|VecDeque|BinaryHeap)<_>::(push|push_back|push_front|insert|extend)$/.test(key)) return undefined;
  return args[key.endsWith('::insert') ? 1 : 0];
}

/** For a value of a reference coerced through shared references (`&&'a str` to `&str`), the inner reference's layout. */
export function derefCoercedLayout(annotations: Annotations, expr: Expr, layout: Layout): Layout | undefined {
  const derefs = copiedReferenceDerefs(annotations, expr);
  if (derefs === undefined) return undefined;
  let inner = layout;
  for (let step = 0; step < derefs; step++) {
    if (inner.kind !== 'ref' || inner.target.kind !== 'ref') return undefined;
    inner = inner.target;
  }
  return inner.kind === 'ref' && !inner.mutable ? inner : undefined;
}

/**
 * How many references a deref coercion goes through to reach a shared reference it copies (`&&'a str` or
 * `&mut &'a str` to `&'a str`), or undefined for one that goes through an owner or a `Deref` impl.
 */
function copiedReferenceDerefs(annotations: Annotations, expr: Expr): number | undefined {
  const coercion = annotations.coercions.get(expr);
  if (coercion?.kind !== 'deref' || coercion.derefs.length === 0) return undefined;
  return coercion.derefs.every((step) => step === 'ref' || step === 'mutRef') ? coercion.derefs.length : undefined;
}

/** `TryFrom<&[T]>` for `&[T; N]` borrows the array from the slice: the input outlives what the result holds. */
export function relateArrayBorrow(
  outlives: Outlives,
  fn: FnDef,
  typeArgs: readonly Type[],
  input: Layout,
  held: Layout
): void {
  const name = fn.trait?.builtin;
  if (name !== 'TryInto' && name !== 'TryFrom') return;
  const [from, to] = name === 'TryInto' ? typeArgs : [typeArgs[1], typeArgs[0]];
  if (arrayTryFrom(from, to)?.mode === 'borrow') relate(outlives, input, held);
}
