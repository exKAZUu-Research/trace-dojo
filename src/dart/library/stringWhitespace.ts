const DART_SPACE = '[\t-\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]';
const LEADING_SPACE = new RegExp('^' + DART_SPACE + '+');
const TRAILING_SPACE = new RegExp(DART_SPACE + '+$');

export function trimDartWhitespace(text: string): string {
  return trimDartEnd(trimDartStart(text));
}

export function trimDartStart(text: string): string {
  return text.replace(LEADING_SPACE, '');
}

export function trimDartEnd(text: string): string {
  return text.replace(TRAILING_SPACE, '');
}
