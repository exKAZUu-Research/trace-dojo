import type { Pat } from './syntax';

interface QuotedLiteral {
  kind: 'char' | 'string';
  value: string;
}
export type PatternText = string | QuotedLiteral | PatternText[];

export function surfacePatternText(pat: Pat): PatternText {
  switch (pat.kind) {
    case 'pvar': {
      return pat.name.name;
    }
    case 'pwild': {
      return '_';
    }
    case 'plit': {
      const literal = pat.lit;
      if (literal.kind === 'string' || literal.kind === 'char') return literal;
      return `${pat.negative ? '-' : ''}${literal.value}`;
    }
    case 'ptuple': {
      return ['(', separated(pat.elems.map(surfacePatternText)), ')'];
    }
    case 'plist': {
      return ['[', separated(pat.elems.map(surfacePatternText)), ']'];
    }
    case 'pas': {
      return [pat.name.name, '@', patternArgument(pat.pat)];
    }
    case 'pcon': {
      const name = pat.con.qualifier ? `${pat.con.qualifier}.${pat.con.name}` : pat.con.name;
      const prefix = /^[\p{L}_]/u.test(pat.con.name) ? name : `(${name})`;
      return [prefix, ...pat.args.map((arg): PatternText => [' ', patternArgument(arg)])];
    }
    case 'precord': {
      return [
        pat.con.name,
        ' {',
        separated(pat.fields.map((field): PatternText => [field.field.name, ' = ', surfacePatternText(field.pat)])),
        '}',
      ];
    }
    case 'pchain': {
      return chainText(pat);
    }
  }
}

function chainText(pat: Extract<Pat, { kind: 'pchain' }>): PatternText {
  return separated(
    pat.items.map((item): PatternText => {
      if (item.kind === 'operand') {
        const inner = surfacePatternText(item.value);
        return item.value.kind === 'pchain' ? ['(', inner, ')'] : inner;
      }
      if (item.kind === 'negate') return '-';
      const op = item.op;
      const name = op.qualifier ? `${op.qualifier}.${op.name}` : op.name;
      return /^[\p{L}_]/u.test(op.name) ? `\`${name}\`` : name;
    }),
    ' '
  );
}

function separated(parts: PatternText[], delimiter = ', '): PatternText[] {
  return parts.flatMap((part, index) => (index === 0 ? [part] : [delimiter, part]));
}

function patternArgument(pat: Pat): PatternText {
  const text = surfacePatternText(pat);
  return pat.kind === 'pchain' || (pat.kind === 'pcon' && pat.args.length > 0) ? ['(', text, ')'] : text;
}
