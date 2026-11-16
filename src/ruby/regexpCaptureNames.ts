import { regexpLexicalSource } from './regexpLexicalSource';

export function regexpCaptureNames(source: string, extended = false): string[] {
  source = regexpLexicalSource(source, extended);
  const names: string[] = [];
  let inClass = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') {
      index++;
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
  source = regexpLexicalSource(source, extended);
  let inClass = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
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
