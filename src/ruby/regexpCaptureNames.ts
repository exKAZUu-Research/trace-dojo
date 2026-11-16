import { regexpSourceTokens } from './regexpLexicalSource';

export function regexpCaptureNames(source: string, extended = false): string[] {
  try {
    return regexpSourceTokens(source, extended).flatMap((token) =>
      token.type === 'GroupOpen' && token.kind === 'capturing' && token.name !== undefined ? [token.name] : []
    );
  } catch {
    return [];
  }
}

export function hostRegexpCaptureNames(source: string): string[] {
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
  try {
    let depth = 0;
    for (const token of regexpSourceTokens(source, extended)) {
      if (token.type === 'CharacterClassOpen') depth++;
      else if (token.type === 'CharacterClassClose') depth--;
      else if (depth === 0 && token.type === 'Character') {
        if (/^\\[1-9]/.test(token.raw) && !/^\\[1-7][0-7]/.test(token.raw)) return true;
        if (/^\\k<\d+>/.test(token.raw)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
