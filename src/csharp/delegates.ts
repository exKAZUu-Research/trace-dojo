import { CsDelegate, type DelegateEntry, type Value } from './values';

/** Combines two delegates into one that calls both, as `+` does. */
export function combineDelegates(a: Value, b: Value): Value {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const first = a as CsDelegate;
  const second = b as CsDelegate;
  return new CsDelegate(first.type, [...first.entries, ...second.entries]);
}

/** Removes the last occurrence of a delegate's invocation list from another's, as `-` does. */
export function removeDelegate(a: Value, b: Value): Value {
  if (a === undefined || b === undefined) return a;
  const source = (a as CsDelegate).entries;
  const removed = (b as CsDelegate).entries;
  for (let start = source.length - removed.length; start >= 0; start--) {
    if (removed.every((entry, index) => entriesEqual(source[start + index], entry))) {
      const remaining = [...source.slice(0, start), ...source.slice(start + removed.length)];
      return remaining.length === 0 ? undefined : new CsDelegate((a as CsDelegate).type, remaining);
    }
  }
  return a;
}

function entriesEqual(a: DelegateEntry, b: DelegateEntry): boolean {
  if (a.lambda || b.lambda) {
    // A delegate of a local function or a lambda equals another of the same function over the same captured variables.
    if (
      !a.lambda ||
      !b.lambda ||
      a.lambda.info.method !== b.lambda.info.method ||
      a.lambda.thisValue !== b.lambda.thisValue
    )
      return false;
    const other = b.lambda.cells;
    return [...a.lambda.cells].every(([local, cell]) => other.get(local) === cell);
  }
  return a.method === b.method && a.target === b.target;
}

export function delegatesEqual(a: Value, b: Value): boolean {
  if (a === undefined || b === undefined) return a === b;
  const first = (a as CsDelegate).entries;
  const second = (b as CsDelegate).entries;
  return first.length === second.length && first.every((entry, index) => entriesEqual(entry, second[index]));
}
