import type { Pat } from './syntax';

// code-gauge-allow functionCognitiveComplexity 21 -- Each surface pattern form retains its own Haskell notation.
// code-gauge-allow functionNcss 33 -- One rendering case per surface pattern form.
export function surfacePatternText(pat: Pat): string {
  switch (pat.kind) {
    case 'pvar': {
      return pat.name.name;
    }
    case 'pwild': {
      return '_';
    }
    case 'plit': {
      const literal = pat.lit;
      if (literal.kind === 'string') return JSON.stringify(literal.value);
      if (literal.kind === 'char')
        return `'${JSON.stringify(literal.value)
          .slice(1, -1)
          .replaceAll("'", String.raw`\'`)}'`;
      return `${pat.negative ? '-' : ''}${literal.value}`;
    }
    case 'ptuple': {
      return `(${pat.elems.map(surfacePatternText).join(', ')})`;
    }
    case 'plist': {
      return `[${pat.elems.map(surfacePatternText).join(', ')}]`;
    }
    case 'pas': {
      return `${pat.name.name}@${patternArgument(pat.pat)}`;
    }
    case 'pcon': {
      const name = pat.con.qualifier ? `${pat.con.qualifier}.${pat.con.name}` : pat.con.name;
      return [name, ...pat.args.map(patternArgument)].join(' ');
    }
    case 'precord': {
      return `${pat.con.name} {${pat.fields.map((field) => `${field.field.name} = ${surfacePatternText(field.pat)}`).join(', ')}}`;
    }
    case 'pchain': {
      return pat.items
        .map((item) => {
          if (item.kind === 'operand') return surfacePatternText(item.value);
          if (item.kind === 'negate') return '-';
          const op = item.op;
          const name = op.qualifier ? `${op.qualifier}.${op.name}` : op.name;
          return /^[\p{L}_]/u.test(op.name) ? `\`${name}\`` : name;
        })
        .join(' ');
    }
  }
}

function patternArgument(pat: Pat): string {
  const text = surfacePatternText(pat);
  return pat.kind === 'pchain' || (pat.kind === 'pcon' && pat.args.length > 0) ? `(${text})` : text;
}
