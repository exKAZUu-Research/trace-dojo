/**
 * Marks a template literal as Kotlin source. The literal is read as JavaScript reads it, so Kotlin's `${` is written
 * `\${` and its escapes such as `'\n'` are written with a doubled backslash, `'\\n'`.
 */
export function kotlin(strings: TemplateStringsArray): string {
  return strings.join('');
}
