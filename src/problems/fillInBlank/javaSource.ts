export function hasIncompleteJavaPlaceholders(source: string): boolean {
  return /【[1-9]\d*】/.test(maskJavaNonCode(source));
}

export function maskJavaNonCode(source: string): string {
  // Preserve offsets and line breaks so declarations can be edited in the original source.
  return source.replaceAll(
    /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"""(?:\\[\s\S]|(?!""")[^\\])*?(?:"""|$)|"(?:\\[\s\S]|[^"\\\r\n])*(?:"|$)|'(?:\\[\s\S]|[^'\\\r\n])*(?:'|$)/g,
    (literal) => literal.replaceAll(/[^\r\n]/g, ' ')
  );
}

export function prepareJavaEntry(source: string): { className: string; source: string } {
  const code = maskJavaNonCode(source);
  const tokens = [...code.matchAll(/[\p{L}_$][\p{L}\p{N}_$]*|[{};]/gu)];
  let depth = 0;
  let declarationStart = 0;
  let memberStart = 0;
  let candidate: { className: string; publicIndex?: number } | undefined;
  let firstClass: typeof candidate;
  let entry: typeof candidate;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (depth === 0 && token[0] === 'class') {
      const name = tokens[index + 1];
      if (!name || !/^[\p{L}_$]/u.test(name[0])) continue;
      const modifier = /\bpublic\b/.exec(code.slice(declarationStart, token.index));
      candidate = {
        className: name[0],
        publicIndex: modifier ? declarationStart + modifier.index : undefined,
      };
      firstClass ??= candidate;
    }
    const methodHeader = code.slice(memberStart, token.index);
    if (
      depth === 1 &&
      token[0] === 'main' &&
      /^(?:\s*(?:public|static|final|synchronized|strictfp))+\s+void\s+$/.test(methodHeader) &&
      /\bpublic\b/.test(methodHeader) &&
      /\bstatic\b/.test(methodHeader) &&
      /^\s*\(\s*(?:final\s+)?String\s*(?:\[\s*\]\s*[\p{L}_$][\p{L}\p{N}_$]*|[\p{L}_$][\p{L}\p{N}_$]*\s*\[\s*\]|\.\.\.\s*[\p{L}_$][\p{L}\p{N}_$]*)\s*\)/u.test(
        code.slice(token.index + 4)
      )
    ) {
      entry = candidate;
      break;
    }
    if (token[0] === '{') depth += 1;
    if (token[0] === '}') {
      depth -= 1;
      if (depth === 0) candidate = undefined;
    }
    if (depth === 0 && (token[0] === '}' || token[0] === ';')) declarationStart = token.index + 1;
    if (depth === 1 && /[{};]/.test(token[0])) memberStart = token.index + 1;
  }
  const selected = entry ?? firstClass;
  const publicIndex = selected?.publicIndex;
  return {
    className: selected?.className ?? 'Main',
    source:
      publicIndex === undefined
        ? source
        : `${source.slice(0, publicIndex)}      ${source.slice(publicIndex + 'public'.length)}`,
  };
}
