const COLLATOR = new Intl.Collator('en-US', { caseFirst: 'lower' });

/** Compares two strings as `strcoll` does in macOS's `en_US.UTF-8` locale. */
export function compareCollated(a: string, b: string): number {
  return COLLATOR.compare(a, b);
}
