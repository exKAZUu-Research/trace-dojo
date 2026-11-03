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

/** Matches the annotations a line comment ends with, which may follow an ordinary remark. */
const traceAnnotationPattern =
  /\/\/[ \t]*(?:step(?:[ \t]*:[ \t]*\d+)?|caller)(?:[ \t]*\/\/[ \t]*(?:step(?:[ \t]*:[ \t]*\d+)?|caller))*[ \t]*$/;

export function stripJavaTraceAnnotations(source: string): string {
  return source.replaceAll(javaNonCodePattern, (token) => {
    const annotation = token.startsWith('//') ? traceAnnotationPattern.exec(token) : undefined;
    if (!annotation) return token;
    return annotation.index === 0 ? '' : token.slice(0, annotation.index).trimEnd();
  });
}

/** The `// step` and `// caller` annotations of a program, skipping look-alikes in literals and other comments. */
export function findJavaTraceAnnotations(source: string): { index: number; text: string }[] {
  return [...source.matchAll(javaNonCodePattern)].flatMap((match) => {
    const annotation = match[0].startsWith('//') ? traceAnnotationPattern.exec(match[0]) : undefined;
    return annotation ? [{ index: match.index + annotation.index, text: annotation[0] }] : [];
  });
}
