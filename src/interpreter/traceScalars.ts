import type { TraceItemVariable } from '../problems/trace';

/** A value a trace shows inline: a primitive, or a list of such values. */
export type Scalar = TraceItemVariable[string];

/** What a value a trace cannot show inline maps to, which it shows as a reference instead. */
export const NOT_SCALAR = Symbol('notScalar');

/**
 * The inline values of a list's items, or {@link NOT_SCALAR} when an item has none or the list contains itself, as
 * `seen` holds the lists being converted.
 */
export function scalarItems<List extends object, Item>(
  list: List,
  items: Iterable<Item>,
  seen: Set<List>,
  scalarOf: (item: Item) => Scalar | typeof NOT_SCALAR
): Scalar | typeof NOT_SCALAR {
  if (seen.has(list)) return NOT_SCALAR;
  seen.add(list);
  const scalars: Scalar[] = [];
  for (const item of items) {
    const scalar = scalarOf(item);
    if (scalar === NOT_SCALAR) return NOT_SCALAR;
    scalars.push(scalar);
  }
  seen.delete(list);
  return scalars as Scalar;
}
