import { normalize, type Unifier } from './infer';
import { shallow, type Type } from './types';

/**
 * How a value of type `a` coerces to the raw pointer type `t`: `'fromRef'` when a reference becomes the pointer
 * (`&T` → `*const T`, `&mut [T; N]` → `*mut [T]`), `'pointer'` when a raw pointer stays one (`*mut T` → `*const T`,
 * `*const [T; N]` → `*const [T]`), or undefined when none applies.
 */
export function pointerCoercion(unifier: Unifier, a: Type, t: Type): 'fromRef' | 'pointer' | undefined {
  if (t.kind !== 'adt' || (t.def.builtin !== 'ConstPtr' && t.def.builtin !== 'MutPtr')) return undefined;
  const toMutable = t.def.builtin === 'MutPtr';
  if (a.kind === 'ref')
    return (!toMutable || a.mutable) && pointsTo(unifier, a.target, t.args[0]) ? 'fromRef' : undefined;
  return isRawPointer(a) && keepsPointer(unifier, a, t) ? 'pointer' : undefined;
}

function isRawPointer(type: Type): type is Type & { kind: 'adt' } {
  return type.kind === 'adt' && (type.def.builtin === 'MutPtr' || type.def.builtin === 'ConstPtr');
}

/** Whether a raw pointer coerces to another: `*mut` to `*const`, or to a slice of the array it points to. */
function keepsPointer(unifier: Unifier, a: Type & { kind: 'adt' }, t: Type & { kind: 'adt' }): boolean {
  if (a.def.builtin === 'ConstPtr' && t.def.builtin === 'MutPtr') return false;
  const pointee = normalize(shallow(a.args[0]));
  if (pointee.kind === 'array' && normalize(shallow(t.args[0])).kind === 'slice') {
    return pointsTo(unifier, pointee, t.args[0]);
  }
  return a.def.builtin !== t.def.builtin && unifier.tryUnify(a.args[0], t.args[0]);
}

/** Whether a pointer to `from` may point to `to`: the same type, or an array's elements as a slice. */
function pointsTo(unifier: Unifier, from: Type, to: Type): boolean {
  if (unifier.tryUnify(from, to)) return true;
  const array = normalize(shallow(from));
  const slice = normalize(shallow(to));
  return array.kind === 'array' && slice.kind === 'slice' && unifier.tryUnify(array.elem, slice.elem);
}

/** The cells a `Box`, `Rc` or reference may unsize through (`Rc<RefCell<dyn Trait>>`, `&RefCell<[T]>`). */
export const CELLS = new Set(['RefCell', 'Mutex', 'RwLock']);

/** Whether a `RefCell` or `Mutex` of an array unsizes to one of a slice (`&RefCell<[T; N]>` to `&RefCell<[T]>`). */
export function unsizesCellArray(unifier: Unifier, from: Type, to: Type): boolean {
  const [a, t] = [normalize(shallow(from)), normalize(shallow(to))];
  if (a.kind !== 'adt' || t.kind !== 'adt' || a.def !== t.def || !CELLS.has(t.def.builtin ?? '')) return false;
  const [array, slice] = [normalize(shallow(a.args[0])), normalize(shallow(t.args[0]))];
  return array.kind === 'array' && slice.kind === 'slice' && unifier.tryUnify(array.elem, slice.elem);
}
