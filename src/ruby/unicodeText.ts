// oxlint-disable-next-line no-control-regex -- ASCII includes control bytes and excludes every non-ASCII code unit.
const nonAscii = /[^\u0000-\u007F]/;

export function isAsciiText(text: string): boolean {
  return !nonAscii.test(text);
}

export function codePointCharacters(text: string): string[] {
  // oxlint-disable-next-line no-misused-spread -- Ruby string operations count Unicode code points, including separate combining characters.
  return [...text];
}

export function isEncodingPrintable(code: number): boolean {
  if (code < 256) return (code >= 32 && code <= 126) || code === 133 || code >= 160;
  return /[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Cf}\p{Co}\p{Zs}]/u.test(String.fromCodePoint(code));
}
