const COLLATOR = new Intl.Collator('en-US', { caseFirst: 'lower' });
// oxlint-disable-next-line eslint/no-control-regex -- ASCII control characters U+0001..U+001F carry primary collation weights in macOS strcoll.
const UNWEIGHTED = /[^\u0001-\u007F\p{Script=Latin}]/gu;

/** Compares two strings as `strcoll` does in macOS's `en_US.UTF-8` locale, where non-Latin scripts carry zero weight. */
export function compareCollated(a: string, b: string): number {
  if (a === '' || b === '') return Number(a !== '') - Number(b !== '');
  return COLLATOR.compare(a.replaceAll(UNWEIGHTED, ''), b.replaceAll(UNWEIGHTED, ''));
}
