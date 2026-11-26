const SKIPPED_KEYS = new Set(['type', 'from', 'syntax', 'node', 'context', 'arrayType', 'objectType', 'disposable']);

/**
 * Marks the statements and expressions of an iterator's or an async function's body that a `yield return` or an
 * `await` inside may suspend, which then run as generators; a lambda inside is a function of its own.
 */
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
export function markSuspends(node: unknown, seen = new Set<object>()): boolean {
  if (typeof node !== 'object' || node === null || seen.has(node)) return false;
  seen.add(node);
  if (Array.isArray(node)) {
    let any = false;
    for (const item of node) if (markSuspends(item, seen)) any = true;
    return any;
  }
  if (Object.getPrototypeOf(node) !== Object.prototype) return false;
  const record = node as Record<string, unknown> & { kind?: string; suspends?: true };
  if (record.kind === 'lambda' || record.kind === 'unbound') return false;
  let suspends =
    record.kind === 'await' || record.kind === 'yieldReturn' || (record.kind === 'using' && record.isAwait === true);
  for (const [key, value] of Object.entries(record)) {
    // Types, the syntax a node keeps, and a jump's target hold no part of the code that runs here.
    if (SKIPPED_KEYS.has(key) || (key === 'target' && record.kind === 'goto')) continue;
    if (markSuspends(value, seen)) suspends = true;
  }
  if (suspends) record.suspends = true;
  return suspends;
}
