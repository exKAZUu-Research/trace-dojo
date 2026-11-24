import type { Pat } from './syntax';

export function surfacePatternText(pat: Pat): string {
  switch (pat.kind) {
    case 'pvar': {
      return pat.name.name;
    }
    case 'pwild': {
      return '_';
    }
    case 'plit': {
      return `${pat.negative ? '-' : ''}${pat.lit.text}`;
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
      const prefix = /^[\p{L}_([]/u.test(pat.con.name) ? name : `(${name})`;
      return [prefix, ...pat.args.map(patternArgument)].join(' ');
    }
    case 'precord': {
      const name = pat.con.qualifier ? `${pat.con.qualifier}.${pat.con.name}` : pat.con.name;
      const fields = pat.fields.map(({ field, pat: inner }) => {
        const fieldName = field.qualifier ? `${field.qualifier}.${field.name}` : field.name;
        return `${fieldName} = ${surfacePatternText(inner)}`;
      });
      return `${name} {${fields.join(', ')}}`;
    }
    case 'pchain': {
      return chainText(pat);
    }
    case 'pbang': {
      return `!${patternArgument(pat.pat)}`;
    }
    case 'plazy': {
      return `~${patternArgument(pat.pat)}`;
    }
    case 'pview': {
      return `(${pat.exprText} -> ${surfacePatternText(pat.pat)})`;
    }
    case 'por': {
      return `(${pat.alts.map(surfacePatternText).join('; ')})`;
    }
  }
}

function chainText(pat: Extract<Pat, { kind: 'pchain' }>): string {
  return pat.items
    .map((item): string => {
      if (item.kind === 'operand') {
        const inner = surfacePatternText(item.value);
        return item.value.kind === 'pchain' ? `(${inner})` : inner;
      }
      if (item.kind === 'negate') return '-';
      const op = item.op;
      const name = op.qualifier ? `${op.qualifier}.${op.name}` : op.name;
      return /^[\p{L}_]/u.test(op.name) ? `\`${name}\`` : name;
    })
    .join(' ');
}

function patternArgument(pat: Pat): string {
  const text = surfacePatternText(pat);
  return pat.kind === 'pchain' || (pat.kind === 'pcon' && pat.args.length > 0) ? `(${text})` : text;
}
