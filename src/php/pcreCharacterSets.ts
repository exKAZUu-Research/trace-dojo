import propertyAliases from 'unicode-property-value-aliases-ecmascript';

/** Characters that a class matches: JavaScript class contents, which `negated` complements. */
export interface CharacterSet {
  content: string;
  negated: boolean;
  excluded?: string;
  /** Whether caseless matching leaves the class as it is, as it does PCRE's `[:upper:]` and `[:lower:]` under UCP. */
  exact?: boolean;
}

export const ANY = String.raw`[\s\S]`;
export const BYTE_SETS = new Map([
  ['d', '0-9'],
  ['w', 'A-Za-z0-9_'],
  ['s', String.raw`\t-\r `],
  ['h', String.raw`\t \xa0`],
  ['v', String.raw`\n-\r\x85`],
]);
export const UCP_SETS = new Map([
  ['d', String.raw`\p{Nd}`],
  ['w', String.raw`\p{L}\p{N}\p{Mn}\p{Pc}`],
  ['s', String.raw`\t-\r \x85\xa0 ᠎ - \u2028\u2029  　`],
  ['h', String.raw`\t \xa0 ᠎ -   　`],
  ['v', String.raw`\n-\r\x85\u2028\u2029`],
]);
export const BYTE_POSIX_CLASSES = new Map([
  ['alpha', 'A-Za-z'],
  ['digit', '0-9'],
  ['alnum', 'A-Za-z0-9'],
  ['upper', 'A-Z'],
  ['lower', 'a-z'],
  ['space', String.raw`\t-\r `],
  ['blank', String.raw` \t`],
  ['punct', '!-\\/:-@\\[-`{-~'],
  ['xdigit', '0-9A-Fa-f'],
  ['word', 'A-Za-z0-9_'],
  ['cntrl', String.raw`\x00-\x1f\x7f`],
  ['print', ' -~'],
  ['graph', '!-~'],
]);
const UCP_GRAPH = String.raw`\p{L}\p{M}\p{N}\p{P}\p{S}\p{Cf}`;
export const UCP_NONPRINTING_FORMATS = String.raw`\u061C\u2066-\u2069`;
export const UCP_POSIX_CLASSES = new Map([
  ['alpha', String.raw`\p{L}`],
  ['digit', String.raw`\p{Nd}`],
  ['alnum', String.raw`\p{L}\p{N}`],
  ['upper', String.raw`\p{Lu}`],
  ['lower', String.raw`\p{Ll}`],
  ['space', UCP_SETS.get('s') as string],
  ['blank', UCP_SETS.get('h') as string],
  ['punct', String.raw`\p{P}$+<=>^` + '`|~'],
  ['xdigit', String.raw`0-9A-Fa-f０-９Ａ-Ｆａ-ｆ`],
  ['word', UCP_SETS.get('w') as string],
  ['cntrl', String.raw`\p{Cc}`],
  ['print', String.raw`${UCP_GRAPH}\p{Zs}`],
  ['graph', UCP_GRAPH],
]);
/** `\b` or `\B` by PCRE's UCP word characters, which JavaScript's ASCII-only `\b` does not know. */
export function unicodeBoundary(negated: boolean): string {
  const word = `[${UCP_SETS.get('w') as string}]`;
  const [wordAfterWord, wordAfterOther] = negated ? ['=', '!'] : ['!', '='];
  return `(?:(?<=${word})(?${wordAfterWord}${word})|(?<!${word})(?${wordAfterOther}${word}))`;
}

const SCRIPT_ALIASES = looseAliases('Script');
const CATEGORY_ALIASES = new Map(
  'C Cc Cf Cn Co Cs L Ll Lm Lo Lt Lu M Mc Me Mn N Nd Nl No P Pc Pd Pe Pf Pi Po Ps S Sc Sk Sm So Z Zl Zp Zs'
    .split(' ')
    .map((name) => [name.toLowerCase(), name])
);

function looseAliases(property: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const [alias, canonical] of propertyAliases.get(property) ?? []) {
    result.set(propertyKey(alias), canonical);
    result.set(propertyKey(canonical), canonical);
  }
  return result;
}

function propertyKey(name: string): string {
  return name.replaceAll(/[-_ \t-\r]/g, '').toLowerCase();
}

export function unicodeProperty(name: string, negated: boolean): CharacterSet | undefined {
  name = propertyKey(name);
  const special = new Map([
    ['any', String.raw`\s\S`],
    ['l&', String.raw`\p{LC}`],
    ['xan', String.raw`\p{L}\p{N}`],
    ['xwd', UCP_SETS.get('w') as string],
    ['xsp', UCP_SETS.get('s') as string],
    ['xps', UCP_SETS.get('s') as string],
  ]).get(name);
  if (special !== undefined) return { content: special, negated };
  const explicit = /^(sc|script|scx|scriptextensions)[:=](.+)$/.exec(name);
  const script = explicit?.[1];
  const value = explicit?.[2] ?? name;
  const category = !explicit ? CATEGORY_ALIASES.get(value) : undefined;
  const canonical = category ?? SCRIPT_ALIASES.get(value);
  if (!canonical) return;
  const property = script === 'sc' || script === 'script' ? 'Script' : 'Script_Extensions';
  const content = category ? `\\p{${canonical}}` : `\\p{${property}=${canonical}}`;
  try {
    new RegExp(`[${content}]`, 'u');
    return { content, negated };
  } catch {
    return undefined;
  }
}
