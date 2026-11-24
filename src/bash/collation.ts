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

/** Resolves a `[.name.]` or `[=name=]` collating element name in glob bracket expressions. */
export function resolveCollatingElement(name: string): string | undefined {
  if (charactersOf(name).length === 1) return name;
  return Object.hasOwn(COLLATING_SYMBOLS, name) ? COLLATING_SYMBOLS[name] : undefined;
}

/** Resolves a `[.name.]` or `[=name=]` collating element in macOS `regcomp`, which rejects unweighted characters. */
export function resolveRegexCollatingElement(name: string): string | undefined {
  const element = resolveCollatingElement(name);
  return element !== undefined && (element === '\0' || !UNWEIGHTED_CHAR.test(element)) ? element : undefined;
}

/** Whether `candidate` matches glob `[=target=]` in macOS `en_US.UTF-8`, where unweighted characters compare equal. */
export function matchesGlobEquivalenceClass(target: string, candidate: string): boolean {
  if (candidate === target) return true;
  if (target === '\0' || candidate === '\0' || charactersOf(candidate).length !== 1) return false;
  const targetUnweighted = UNWEIGHTED_CHAR.test(target);
  const candidateUnweighted = UNWEIGHTED_CHAR.test(candidate);
  if (targetUnweighted || candidateUnweighted) return targetUnweighted && candidateUnweighted;
  return BASE_COLLATOR.compare(candidate, target) === 0;
}

/** Whether `candidate` matches ERE `[=target=]` in macOS `en_US.UTF-8`, where unweighted characters have no weight. */
export function matchesRegexEquivalenceClass(target: string, candidate: string): boolean {
  if (candidate === target) return true;
  if (target === '\0' || candidate === '\0' || UNWEIGHTED_CHAR.test(target) || UNWEIGHTED_CHAR.test(candidate)) {
    return false;
  }
  return charactersOf(candidate).length === 1 && BASE_COLLATOR.compare(candidate, target) === 0;
}
