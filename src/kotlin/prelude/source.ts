/**
 * Marks a template literal as Kotlin source, with generated declarations interpolated. The literal is read as JavaScript
 * reads it, so Kotlin's `${` is written `\${` and its escapes such as `'\n'` are written with a doubled backslash, `'\\n'`.
 */
export function kotlin(strings: TemplateStringsArray, ...declarations: string[]): string {
  return strings.reduce((source, text, index) => source + (declarations[index - 1] ?? '') + text);
}
