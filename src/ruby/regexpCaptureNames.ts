import { RegexpEncodingError } from './regexpEscapes';
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
    const numericEscapes = regexpNumericEscapes(source, extended);
    let depth = 0;
    for (const token of regexpSourceTokens(source, extended)) {
      if (token.type === 'CharacterClassOpen') depth++;
      else if (token.type === 'CharacterClassClose') depth--;
      else if (depth === 0 && token.type === 'Character') {
        if (numericEscapes.get(token.rawStart ?? -1)?.kind === 'reference') return true;
        if (/^\\k<\d+>/.test(token.raw)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// code-gauge-allow functionCognitiveComplexity -- One token traversal resolves decimal references against preceding captures while excluding character classes.
export function regexpNumericEscapes(
  source: string,
  extended = false
): Map<number, { kind: 'reference' | 'character'; value: number; length: number }> {
  const references = new Map<number, { kind: 'reference' | 'character'; value: number; length: number }>();
  let captures = 0;
  let depth = 0;
  for (const token of regexpSourceTokens(source, extended, true)) {
    if (token.type === 'GroupOpen' && token.kind === 'capturing') captures++;
    else if (token.type === 'CharacterClassOpen') depth++;
    else if (token.type === 'CharacterClassClose') depth--;
    else if (depth === 0 && token.type === 'Character' && token.rawStart !== undefined) {
      const match = /^\\([1-9][0-9]*)/.exec(source.slice(token.rawStart));
      if (!match) continue;
      const number = Number(match[1]);
      if (number <= 9 || number <= captures)
        references.set(token.rawStart, { kind: 'reference', value: number, length: match[0].length });
      else {
        const octal = /^[0-7]{1,3}/.exec(match[1])?.[0];
        const value = octal ? Number.parseInt(octal, 8) : match[1].codePointAt(0)!;
        if (value > 255) throw new RegexpEncodingError('invalid escape code');
        references.set(token.rawStart, { kind: 'character', value, length: 1 + (octal?.length ?? 1) });
      }
    }
  }
  return references;
}
