import type { Compiled } from './compilerBase';
import { resolved } from './types';

const identities = new WeakMap<object, number>();
let nextKey = 1;

/** A key that names a variable or property in the narrowed types of a flow. */
export function keyOf(item: object): string {
  let id = identities.get(item);
  if (id === undefined) {
    id = nextKey++;
    identities.set(item, id);
  }
  return `#${id}`;
}

/**
 * The case of an enum or sealed type that a value always is, an enum entry or an object, named as a `when` covers it,
 * with the other entries of its enum.
 */
export function caseOf(value: Compiled): { id: string; others: string[] } | undefined {
  const type = resolved(value.type);
  if (type.kind !== 'class' || !value.stableKey) return undefined;
  const { cls } = type;
  if (cls.isObject && value.stableKey === keyOf(cls)) return { id: `class:${keyOf(cls)}`, others: [] };
  if (cls.kind !== 'enum') return undefined;
  const ids = cls.enumEntries.map((entry) => `entry:${keyOf(cls)}.${entry.name}`);
  const id = `entry:${value.stableKey}`;
  return ids.includes(id) ? { id, others: ids.filter((item) => item !== id) } : undefined;
}
