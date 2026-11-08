import { removeAnnotations, type TraceAnnotation, traceAnnotationsIn } from '../../interpreter/traceAnnotations';

const javaNonCodePattern =
  /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"""(?:\\[\s\S]|(?!""")[^\\])*?(?:"""|$)|"(?:\\[\s\S]|[^"\\\r\n])*(?:"|$)|'(?:\\[\s\S]|[^'\\\r\n])*(?:'|$)/g;

export function hasIncompleteJavaPlaceholders(source: string): boolean {
  return javaPlaceholderRanges(source).length > 0;
}

export function javaPlaceholderRanges(source: string): { from: number; to: number }[] {
  return [...maskJavaNonCode(source).matchAll(/【[1-9]\d*】/g)].map((match) => ({
    from: match.index,
    to: match.index + match[0].length,
  }));
}

export function maskJavaNonCode(source: string): string {
  // Preserve offsets and line breaks so declarations can be edited in the original source.
  return source.replaceAll(javaNonCodePattern, (literal) => literal.replaceAll(/[^\r\n]/g, ' '));
}

/** The program without its `// atomic` annotations and the blanks before them, keeping every row in place. */
export function stripJavaTraceAnnotations(source: string): string {
  return removeAnnotations(source, findJavaTraceAnnotations(source));
}

/** The `// atomic` annotations of a program, skipping look-alikes in literals and other comments. */
export function findJavaTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(
    [...source.matchAll(javaNonCodePattern)]
      .filter((match) => match[0].startsWith('//'))
      .map((match) => ({ index: match.index, text: match[0] }))
  );
}
