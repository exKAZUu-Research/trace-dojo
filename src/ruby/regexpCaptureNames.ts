export function regexpCaptureNames(source: string, extended = false): string[] {
  const names: string[] = [];
  let inClass = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (!inClass && source.startsWith('(?#', index)) {
      index = source.indexOf(')', index + 3);
      if (index < 0) break;
      continue;
    }
    if (extended && !inClass && char === '#') {
      index = source.indexOf('\n', index);
      if (index < 0) break;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (!inClass && source.startsWith('(?<', index)) {
      const match = /^([\p{ID_Start}_][\p{ID_Continue}_]*)>/u.exec(source.slice(index + 3));
      if (match) names.push(match[1]);
    }
  }
  return names;
}

export function regexpHasNumberedBackref(source: string): boolean {
  let inClass = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') {
      if (!inClass && /[1-9]/.test(source[index + 1] ?? '')) return true;
      index++;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
  }
  return false;
}
