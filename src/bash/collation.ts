const COLLATOR = new Intl.Collator('en-US', { caseFirst: 'lower' });

/** Compares two strings under the fixed UTF-8 locale collation policy (`en_US.UTF-8` via `Intl.Collator`). */
export function compareCollated(a: string, b: string): number {
  if (a === '' || b === '') return Number(a !== '') - Number(b !== '');
  return COLLATOR.compare(a, b);
}
