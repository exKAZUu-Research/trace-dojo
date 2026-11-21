import type { Span } from './ast';
import type { Checker } from './checker';
import { normalize } from './infer';
import { compileError } from './items';
import { shallow, type TraitRef, type Type, type TypeParam } from './types';

/**
 * Requires the type a new trait object is made from to be sized, as rustc does: not a `str`, a slice, a struct that
 * ends in one, or a trait's `Self` that nothing says is `Sized`. A trait object is only reinterpreted as another.
 */
export function requireSizedSource(c: Checker, type: Type, span: Span): void {
  const source = normalize(shallow(type));
  if (source.kind !== 'dyn') c.requireTrait(source, 'Sized', span);
  if (source.kind === 'param' && source.param.isSelf && !selfIsSized(c, source.param)) {
    compileError(span, 'Self の大きさが決まらないので、dyn にできません（where Self: Sized を付けてください）。');
  }
}

/** Whether the trait or the function being checked says `Self: Sized`. */
function selfIsSized(c: Checker, self: TypeParam): boolean {
  let context = c.body.fn;
  while (context.parent) context = context.parent;
  const fn = [...c.fnContexts].find(([, checked]) => checked === context)?.[0];
  const own = fn && 'extraBounds' in fn ? (fn.extraBounds ?? []) : [];
  return self.bounds.some(isSized) || own.some(({ param, bound }) => param === self && isSized(bound));
}

function isSized(bound: TraitRef): boolean {
  return bound.trait.builtin === 'Sized';
}
