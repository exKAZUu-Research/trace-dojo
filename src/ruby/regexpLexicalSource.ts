interface LexicalState {
  extended: boolean;
  scopes: boolean[];
  classes: number[];
}

export function regexpLexicalSource(source: string, extended: boolean): string {
  if (!extended && !/\(\?[imx-]*x/.test(source) && !source.includes('(?#')) return source;
  const parts: string[] = [];
  const state: LexicalState = { extended, scopes: [], classes: [] };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') {
      const atom = /^\\(?:[pPu]\{[^}]*\}|[gk](?:<[^>]*>|'[^']*')|[\s\S])/.exec(source.slice(index))?.[0] ?? char;
      parts.push(atom);
      index += atom.length - 1;
      continue;
    }
    if (classCharacter(source, index, state)) {
      parts.push(char);
      continue;
    }
    if (source.startsWith('(?#', index) || (state.extended && char === '#')) {
      const end = char === '#' ? regexpLineCommentEnd(source, index) : regexpCommentEnd(source, index + 3);
      if (end < 0) return parts.join('') + source.slice(index);
      index = end;
      continue;
    }
    const group = groupOptions(source, index, state);
    if (group) {
      parts.push(group.text);
      index += group.length - 1;
    } else if (/[ \t\n\r\f]/.test(char)) {
      if (!state.extended) parts.push(`\\u{${char.codePointAt(0)!.toString(16)}}`);
    } else parts.push(char === '#' ? String.raw`\#` : char);
  }
  return parts.join('');
}

function classCharacter(source: string, index: number, state: LexicalState): boolean {
  if (source[index] === '[') {
    state.classes.push(index + (source[index + 1] === '^' ? 2 : 1));
    return true;
  }
  if (state.classes.length === 0) return false;
  if (source[index] === ']' && index !== state.classes.at(-1)) state.classes.pop();
  return true;
}

function groupOptions(
  source: string,
  index: number,
  state: LexicalState
): { text: string; length: number } | undefined {
  if (source[index] === ')') state.extended = state.scopes.pop() ?? state.extended;
  if (source[index] !== '(') return undefined;
  const options = /^\(\?([imx]*)(?:-([imx]*))?([:)])/.exec(source.slice(index));
  if (!options) {
    state.scopes.push(state.extended);
    return undefined;
  }
  if (options[3] === ':') state.scopes.push(state.extended);
  if (options[1].includes('x')) state.extended = true;
  if (options[2]?.includes('x')) state.extended = false;
  const on = options[1].replaceAll('x', '');
  const off = (options[2] ?? '').replaceAll('x', '');
  const text = on || off || options[3] === ':' ? `(?${on}${off ? `-${off}` : ''}${options[3]}` : '';
  return { text, length: options[0].length };
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
    if (source[index] === '\\' && source[index + 1] === '\\') {
      index++;
      continue;
    }
    if (source[index] === '\\' && source[index + 1] === '\n') {
      index++;
      continue;
    }
    if (source[index] === '\n') return index;
  }
  return source.length;
}
