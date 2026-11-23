import type { Runtime } from './runtime';
import { CsDelegate, type DelegateEntry, type Value } from './values';

/**
 * Combines two delegates into one that calls both, as `+` does. The new invocation list is charged as an allocation,
 * since `d += d` doubles it at each step.
 */
export function combineDelegates(runtime: Runtime, a: Value, b: Value): Value {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const first = a as CsDelegate;
  const second = b as CsDelegate;
  runtime.allocateSlots(first.entries.length + second.entries.length);
  return new CsDelegate(first.type, [...first.entries, ...second.entries]);
}

/** Removes the last occurrence of a delegate's invocation list from another's, as `-` does, charging its comparisons. */
export function removeDelegate(runtime: Runtime, a: Value, b: Value): Value {
  if (a === undefined || b === undefined) return a;
  const source = (a as CsDelegate).entries;
  const removed = (b as CsDelegate).entries;
  let compared = 0;
  const equalAt =
    (start: number) =>
    (entry: DelegateEntry, index: number): boolean => {
      if (++compared % 16 === 0) runtime.spend();
      return entriesEqual(source[start + index], entry);
    };
  for (let start = source.length - removed.length; start >= 0; start--) {
    if (removed.every(equalAt(start))) {
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
