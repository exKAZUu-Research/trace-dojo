import { charactersOf } from './characters';

const COLLATOR = new Intl.Collator('en-US', { caseFirst: 'lower' });
const BASE_COLLATOR = new Intl.Collator('en-US', { sensitivity: 'base' });
// oxlint-disable-next-line eslint/no-control-regex -- ASCII control characters U+0001..U+001F carry primary collation weights in macOS strcoll.
const UNWEIGHTED = /[^\u0001-\u007F\p{Script=Latin}]/gu;
// oxlint-disable-next-line eslint/no-control-regex -- Checks whether a single code point lacks primary collation weight in macOS en_US.UTF-8.
const UNWEIGHTED_CHAR = /^[^\u0001-\u007F\p{Script=Latin}]$/u;

const COLLATING_SYMBOLS: Record<string, string> = {
  NUL: '\0',
  tab: '\t',
  newline: '\n',
  'vertical-tab': '\v',
  'form-feed': '\f',
  'carriage-return': '\r',
  space: ' ',
  hyphen: '-',
  period: '.',
  slash: '/',
  backslash: '\\',
  underscore: '_',
  'left-square-bracket': '[',
  'right-square-bracket': ']',
};

/** Compares two strings as `strcoll` does in macOS's `en_US.UTF-8` locale, where non-Latin scripts carry zero weight. */
export function compareCollated(a: string, b: string): number {
  if (a === '' || b === '') return Number(a !== '') - Number(b !== '');
  return COLLATOR.compare(a.replaceAll(UNWEIGHTED, ''), b.replaceAll(UNWEIGHTED, ''));
}

/** Resolves a `[.name.]` or `[=name=]` collating element name to its single character, or `undefined` when unknown. */
export function resolveCollatingElement(name: string): string | undefined {
  if (charactersOf(name).length === 1) return name;
  return Object.hasOwn(COLLATING_SYMBOLS, name) ? COLLATING_SYMBOLS[name] : undefined;
}

/** Whether `candidate` belongs to `target`'s primary collation equivalence class (`[=target=]`) in `en_US.UTF-8`. */
export function matchesEquivalenceClass(target: string, candidate: string): boolean {
  if (candidate === target) return true;
  if (UNWEIGHTED_CHAR.test(target) || UNWEIGHTED_CHAR.test(candidate)) return false;
  return charactersOf(candidate).length === 1 && BASE_COLLATOR.compare(candidate, target) === 0;
}
