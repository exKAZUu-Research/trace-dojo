// oxlint-disable-next-line no-control-regex -- ASCII includes control bytes and excludes every non-ASCII code unit.
const nonAscii = /[^\u0000-\u007F]/;

export function isAsciiText(text: string): boolean {
  return !nonAscii.test(text);
}

export function codePointCharacters(text: string): string[] {
  // oxlint-disable-next-line no-misused-spread -- Ruby string operations count Unicode code points, including separate combining characters.
  return [...text];
}
