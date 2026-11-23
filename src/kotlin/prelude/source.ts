/**
 * Marks a template literal as Kotlin source, with generated declarations interpolated. The literal is read as JavaScript
 * reads it, so Kotlin's `${` is written `\${` and its escapes such as `'\n'` are written with a doubled backslash, `'\\n'`.
 */
export function kotlin(strings: TemplateStringsArray, ...declarations: string[]): string {
  return strings.reduce((source, text, index) => source + (declarations[index - 1] ?? '') + text);
}

export function mixedIntegralOverloads(
  render: (receiver: string, argument: string, promoted: 'Int' | 'Long') => string[]
): string {
  const types = ['Byte', 'Short', 'Int', 'Long'];
  return types
    .flatMap((receiver) =>
      types.flatMap((argument) => {
        const promoted = receiver === 'Long' || argument === 'Long' ? 'Long' : 'Int';
        return receiver === promoted && argument === promoted ? [] : render(receiver, argument, promoted);
      })
    )
    .join('\n');
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
      return `${label}@OverloadResolutionByLambdaReturnType inline fun ${params}${receiver}.${name}(selector: (${element}) -> ${type}): ${result} = ${iterable}.${name}(selector)`;
    })
  );
}

export const NUMERIC_AGGREGATE_TYPES = [
  { element: 'Int', sum: 'Int', zero: '0' },
  { element: 'Long', sum: 'Long', zero: '0L' },
  { element: 'Double', sum: 'Double', zero: '0.0' },
  { element: 'Float', sum: 'Float', zero: '0.0f' },
  { element: 'Short', sum: 'Int', zero: '0' },
  { element: 'Byte', sum: 'Int', zero: '0' },
] as const;

export const UNSIGNED_NUMERIC_AGGREGATE_TYPES = [
  { element: 'UInt', sum: 'UInt', zero: '0u' },
  { element: 'ULong', sum: 'ULong', zero: '0uL' },
  { element: 'UByte', sum: 'UInt', zero: '0u' },
  { element: 'UShort', sum: 'UInt', zero: '0u' },
] as const;

export function numericAggregates(
  receiver: string,
  kind: { element: string; sum: string; zero: string },
  boxed: boolean
): string[] {
  const jvmName = (method: string): string => (boxed ? `@JvmName("${method}Of${kind.element}") ` : '');
  const sum = `${jvmName('sum')}fun ${receiver}.sum(): ${kind.sum} {
    var result: ${kind.sum} = ${kind.zero}
    for (element in this) result += element
    return result
}`;
  const average = `${jvmName('average')}fun ${receiver}.average(): Double {
    var result = 0.0
    var count = 0
    for (element in this) {
        result += element.toDouble()
        count++
    }
    return if (count == 0) Double.NaN else result / count
}`;
  return kind.element.startsWith('U') ? [sum] : [sum, average];
}
