import { utf8Decode } from './literals';
import { unquoteLiteral } from './packages/strconv';

// code-gauge-allow functionCognitiveComplexity 20 -- Follows Go StructTag.Lookup scanning so malformed prefixes and quoted values share its stop rules.
export function lookupStructTag(tag: string | undefined, key: string): string | undefined {
  let rest = tag ?? '';
  while (rest.length > 0) {
    rest = rest.replace(/^ +/, '');
    let colon = 0;
    while (colon < rest.length && rest[colon] > ' ' && ![':', '"', '\u007F'].includes(rest[colon])) colon++;
    if (colon === 0 || rest[colon] !== ':' || rest[colon + 1] !== '"') return undefined;
    const name = rest.slice(0, colon);
    rest = rest.slice(colon + 1);
    let end = 1;
    while (end < rest.length && rest[end] !== '"') {
      if (rest[end] === '\\') end++;
      end++;
    }
    if (end >= rest.length) return undefined;
    const quoted = rest.slice(0, end + 1);
    rest = rest.slice(end + 1);
    if (name === key) {
      const [value, error] = unquoteLiteral(quoted);
      return error === undefined ? utf8Decode(value) : undefined;
    }
  }
  return undefined;
}
