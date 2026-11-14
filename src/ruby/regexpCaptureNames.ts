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
      index = regexpCommentEnd(source, index + 3);
      if (index < 0) break;
      continue;
    }
    if (extended && !inClass && char === '#') {
      index = regexpLineCommentEnd(source, index);
      if (index >= source.length) break;
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

export function regexpHasNumberedBackref(source: string, extended = false): boolean {
  let inClass = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (!inClass && source.startsWith('(?#', index)) {
      index = regexpCommentEnd(source, index + 3);
      if (index < 0) break;
      continue;
    }
    if (extended && !inClass && char === '#') {
      index = regexpLineCommentEnd(source, index);
      if (index >= source.length) break;
      continue;
    }
    if (char === '\\') {
      const next = source[index + 1] ?? '';
      if (!inClass && /[1-9]/.test(next) && !(/[1-7]/.test(next) && /[0-7]/.test(source[index + 2] ?? ''))) return true;
      if (!inClass && next === 'k' && /^<\d+>/.test(source.slice(index + 2))) return true;
      index++;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
  }
  return false;
}

export function regexpCommentEnd(source: string, start: number): number {
  for (let index = start; index < source.length; index++) {
    if (source[index] === '\\') index++;
    else if (source[index] === ')') return index;
  }
  return -1;
}

export function regexpLineCommentEnd(source: string, start: number): number {
  for (let index = start; index < source.length; index++) {
    if (source[index] === '\\' && source[index + 1] === '\n') {
      index++;
      continue;
    }
    if (source[index] === '\n') return index;
  }
  return source.length;
}
