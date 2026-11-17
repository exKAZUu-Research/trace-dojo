import type { Token } from 'oniguruma-parser/tokenizer';

import { regexpSourceTokens } from './regexpLexicalSource';

interface RegexpFlags {
  multiline: boolean;
  ignoreCase: boolean;
  extended: boolean;
}

export function regexpOuterOptions(source: string, flags: RegexpFlags): RegexpFlags & { source: string } {
  const tokens = regexpSourceTokens(source, flags.extended);
  let start = 0;
  let index = 0;
  for (const token of tokens) {
    if (token.type !== 'Directive' || token.kind !== 'flags' || !source.startsWith(token.raw, start)) break;
    flags = modifiedFlags(flags, token);
    start += token.raw.length;
    index++;
  }
  const first = tokens[index];
  const last = tokens.at(-1);
  if (
    first?.type !== 'GroupOpen' ||
    first.kind !== 'group' ||
    !source.startsWith(first.raw, start) ||
    last?.type !== 'GroupClose' ||
    last.rawStart !== source.length - 1
  )
    return { ...flags, source: source.slice(start) };
  let depth = 0;
  for (let cursor = index; cursor < tokens.length; cursor++) {
    const token = tokens[cursor];
    if (token.type === 'GroupOpen') depth++;
    else if (token.type === 'GroupClose') depth--;
    if (depth === 0 && cursor < tokens.length - 1) return { ...flags, source: source.slice(start) };
  }
  return { ...modifiedFlags(flags, first), source: source.slice(start + first.raw.length, -1) };
}

function modifiedFlags(flags: RegexpFlags, token: Token): RegexpFlags {
  const modifiers = 'flags' in token ? token.flags : undefined;
  const enabled = modifiers?.enable;
  const disabled = modifiers?.disable;
  return {
    multiline: !disabled?.dotAll && (enabled?.dotAll || flags.multiline),
    ignoreCase: !disabled?.ignoreCase && (enabled?.ignoreCase || flags.ignoreCase),
    extended: !disabled?.extended && (enabled?.extended || flags.extended),
  };
}
