/**
 * Marks a template literal as Kotlin source, with generated declarations interpolated. The literal is read as JavaScript
 * reads it, so Kotlin's `${` is written `\${` and its escapes such as `'\n'` are written with a doubled backslash, `'\\n'`.
 */
export function kotlin(strings: TemplateStringsArray, ...declarations: string[]): string {
  return strings.reduce((source, text, index) => source + (declarations[index - 1] ?? '') + text);
}

export function forwardingSelectorExtrema(
  receiver: string,
  element: string,
  iterable: string,
  typeParameters: string
): string[] {
  return ['minOf', 'maxOf', 'minOfOrNull', 'maxOfOrNull'].flatMap((name) =>
    ['R', 'Double', 'Float'].map((type) => {
      const generic = (typeParameters + (type === 'R' ? 'R : Comparable<R>' : '')).replace(/, $/, '');
      const params = generic ? `<${generic}> ` : '';
      const label = type === 'R' ? '' : `@JvmName("${name}${type}") `;
      const result = type + (name.endsWith('OrNull') ? '?' : '');
      return `${label}inline fun ${params}${receiver}.${name}(selector: (${element}) -> ${type}): ${result} = ${iterable}.${name}(selector)`;
    })
  );
}
