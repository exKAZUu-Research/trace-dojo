import type { MethodRes, ReceiverAdjust } from './annotations';
import { normalize } from './infer';
import { type Layout, type RVar, typeAfter } from './regions';
import { shallow, type Type } from './types';

/** The builtin types that are iterators themselves: the adapters, and the ranges that iterate. */
const ITERATOR_TYPES = new Set(['Iter', 'Range', 'RangeInclusive', 'RangeFrom']);

/**
 * How a method taking `self` by value reborrows its receiver instead of moving it, as rustc does: a `&mut` receiver
 * itself (`a.into_iter()` with `a: &mut Vec<T>`), or a builtin iterator reached through `&mut` only, by std's
 * `impl Iterator for &mut I` (`it.take(2)` with `it: &mut Iter<T>`).
 */
export function receiverReborrow(
  method: MethodRes,
  receiverType: Type | undefined
): 'reference' | 'iterator' | undefined {
  if (method.fn.selfMode !== 'value' || method.receiver.autoref !== 'none') return undefined;
  const { derefs } = method.receiver;
  if (derefs.length === 0) return isMutableReference(receiverType) ? 'reference' : undefined;
  return reborrowsIterator(derefs, typeAfter(receiverType, derefs)) ? 'iterator' : undefined;
}

/** Whether derefs reach a builtin iterator through `&mut` only, which std's `impl Iterator for &mut I` reborrows. */
export function reborrowsIterator(derefs: ReceiverAdjust['derefs'], selfType: Type | undefined): boolean {
  if (derefs.length === 0 || !derefs.every((step) => step === 'mutRef')) return false;
  const t = selfType && normalize(shallow(selfType));
  return t?.kind === 'adt' && ITERATOR_TYPES.has(t.def.builtin as string);
}

/**
 * The layout of std's `&'b mut I` used as an iterator: an iterator whose own lifetime is the reborrow's `'b`, which
 * the adapter it makes keeps, while its items keep their own regions. Undefined for an iterator without a lifetime.
 */
export function reborrowedIteratorLayout(layout: Layout | undefined, region: RVar): Layout | undefined {
  if (layout?.kind !== 'adt' || layout.own.length === 0) return undefined;
  return { ...layout, own: layout.own.map(() => region) };
}

export function isMutableReference(type: Type | undefined): boolean {
  const t = type && normalize(shallow(type));
  return t?.kind === 'ref' && t.mutable;
}
