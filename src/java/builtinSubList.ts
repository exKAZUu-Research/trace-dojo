import { elementsOf, subListChecks } from './builtinCollectionSupport';
import { type Frame, throwBuiltin } from './runtime';
import type { ClassInfo } from './types';
import type { JavaObject, Value } from './values';

/** Where a sublist lies in its list, and the list's `modCount` that the sublist last saw or made. */
interface SubListState {
  list: JavaObject;
  start: number;
  size: number;
  expectedModCount: number;
}

/**
 * A view of the elements of `list` from `start` to `end`, which reads and writes through to the list, and whose
 * changes the list counts as its own, so that the iterators of each fail fast on changes made through the other, and
 * the view fails once the list changed in size other than through it.
 */
export function createSubList(frame: Frame, cls: ClassInfo, list: JavaObject, start: number, end: number): JavaObject {
  const view = frame.runtime.allocateObject(frame, cls);
  const state: SubListState = { list, start, size: end - start, expectedModCount: list.modCount ?? 0 };
  // Array methods are generic, so they work on the view through these traps as on an array of its own.
  const elements = new Proxy<Value[]>([], {
    get: (target, property) => readElement(state, target, property),
    set: (_, property, value: Value) => writeElement(state, property, value),
    deleteProperty: (_, property) => {
      const index = arrayIndexOf(property);
      if (index !== undefined && index < state.size) elementsOf(state.list)[state.start + index] = undefined;
      return true;
    },
    has: (target, property) => {
      const index = arrayIndexOf(property);
      return index === undefined ? Reflect.has(target, property) : index < state.size;
    },
  });
  Object.defineProperty(view, 'elements', { get: () => elements, set: () => {} });
  Object.defineProperty(view, 'modCount', {
    get: () => list.modCount,
    set: (count: number) => {
      list.modCount = count;
      state.expectedModCount = count;
    },
  });
  subListChecks.set(view, () => {
    if (list.modCount !== state.expectedModCount) throwBuiltin(frame, 'ConcurrentModificationException');
  });
  // The view keeps its list alive, whose elements it holds.
  view.retained = [list];
  return view;
}

function readElement(state: SubListState, target: Value[], property: string | symbol): unknown {
  if (property === 'length') return state.size;
  const index = arrayIndexOf(property);
  return index === undefined ? Reflect.get(target, property) : elementsOf(state.list)[state.start + index];
}

/** Writes an element, or the length, which removes or inserts elements of the list at the view's end. */
function writeElement(state: SubListState, property: string | symbol, value: Value): boolean {
  if (property === 'length') {
    resize(state, value as unknown as number);
    return true;
  }
  const index = arrayIndexOf(property);
  if (index === undefined) return false;
  if (index >= state.size) resize(state, index + 1);
  elementsOf(state.list)[state.start + index] = value;
  return true;
}

function resize(state: SubListState, length: number): void {
  const elements = elementsOf(state.list);
  if (length < state.size) elements.splice(state.start + length, state.size - length);
  else
    elements.splice(
      state.start + state.size,
      0,
      ...Array.from({ length: length - state.size }, (): Value => undefined)
    );
  state.size = length;
}

/** The index an array property names, or `undefined` for another property such as `length`. */
function arrayIndexOf(property: string | symbol): number | undefined {
  return typeof property === 'string' && /^(?:0|[1-9]\d*)$/.test(property) ? Number(property) : undefined;
}
