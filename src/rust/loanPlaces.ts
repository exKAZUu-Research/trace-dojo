import type { Pattern } from './ast';
import { normalize } from './infer';
import type { Place } from './loanGraph';
import { shallow } from './types';

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
