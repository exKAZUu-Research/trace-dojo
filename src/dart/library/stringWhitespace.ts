const DART_SPACE = /[\t-\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/;

export function trimDartWhitespace(text: string): string {
  return trimDartEnd(trimDartStart(text));
}

export function trimDartStart(text: string): string {
  let start = 0;
  while (start < text.length && DART_SPACE.test(text[start])) start++;
  return text.slice(start);
}

export function trimDartEnd(text: string): string {
  let end = text.length;
  while (end > 0 && DART_SPACE.test(text[end - 1])) end--;
  return text.slice(0, end);
}
