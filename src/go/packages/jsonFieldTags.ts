interface TagOption {
  text: string;
  length: number;
  valid: boolean;
}

// code-gauge-allow functionCognitiveComplexity 20 -- Follows Go field tag name and option scanning with shared progress and delimiter rules.
export function parseJsonFieldTag(tag = ''): { name?: string; options: string[] } {
  let rest = tag;
  let name: string | undefined;
  if (rest.length > 0 && rest[0] !== ',') {
    const reserved = /[,\\'"`]/u.exec(rest)?.index ?? rest.length;
    if (reserved === rest.length || rest[reserved] === ',') {
      name = rest.slice(0, reserved);
      rest = rest.slice(reserved);
    } else {
      const option = consumeOption(rest);
      if (option.valid) name = option.text;
      rest = rest.slice(option.length);
    }
  }
  const options: string[] = [];
  while (rest.length > 0) {
    if (rest[0] === ',') rest = rest.slice(1);
    if (rest.length === 0) break;
    const option = consumeOption(rest);
    rest = rest.slice(option.length);
    if (option.valid) options.push(option.text);
    if ((option.text === 'case' || option.text === 'format') && rest[0] === ':') {
      rest = rest.slice(1);
      rest = rest.slice(consumeOption(rest, option.text === 'format').length);
    }
  }
  return { name, options };
}

function consumeOption(text: string, quoted = false): TagOption {
  const identifier = /^[_\p{L}][_\p{L}\p{N}]*/u.exec(text)?.[0];
  if (identifier) return { text: identifier, length: identifier.length, valid: true };
  if (quoted && text[0] === "'") {
    let escaped = false;
    for (let index = 1; index < text.length; index++) {
      const char = text[index];
      if (!escaped && char === "'") return { text: text.slice(1, index), length: index + 1, valid: true };
      escaped = !escaped && char === '\\';
    }
  }
  const comma = text.indexOf(',');
  const length = comma === -1 ? text.length : comma;
  return { text: text.slice(0, length), length, valid: false };
}
