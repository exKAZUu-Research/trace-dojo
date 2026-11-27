import type { Token } from './macroRules';

let expansions = 0;

/**
 * Renames the variables that a rule's own `let`, `for`, and closure parameters introduce, so that they neither see nor
 * hide the caller's variables of the same name, as rustc's hygiene keeps them apart.
 */
export function hygienic(tokens: Token[]): Token[] {
  const binders = new Set<string>();
  collectBinders(tokens, binders);
  if (binders.size === 0) return tokens;
  expansions++;
  return renamed(tokens, binders, `__${expansions}`);
}

/** Collects the variables a rule's own code binds: in `let`, `for`, closure parameters, and `match` arms. */
function collectBinders(tokens: Token[], binders: Set<string>): void {
  for (const [index, token] of tokens.entries()) {
    if (token.kind === 'group') {
      collectBinders(token.tokens, binders);
      continue;
    }
    if (!token.fromRule) continue;
    if (token.text === 'let')
      addPatternBinders(tokens.slice(index + 1, patternEnd(tokens, index + 1, ['=', ':', 'else'])), binders);
    else if (token.text === 'for')
      addPatternBinders(tokens.slice(index + 1, patternEnd(tokens, index + 1, ['in'])), binders);
    else if (token.text === '|' && opensClosure(tokens, 0, index)) {
      addPatternBinders(tokens.slice(index + 1, patternEnd(tokens, index + 1, ['|'])), binders);
    } else if (token.text === 'match')
      addArmBinders(
        tokens.slice(index + 1).find((next) => next.kind === 'group' && next.open === '{'),
        binders
      );
  }
}

/** Where a pattern starting at `start` ends: at the first of `stops` outside its groups, or at the end. */
function patternEnd(tokens: Token[], start: number, stops: string[]): number {
  const end = tokens.findIndex((token, index) => index >= start && stops.includes(leafText(token) ?? ''));
  return end === -1 ? tokens.length : end;
}

/** The variables the patterns of a `match`'s arms bind: what comes before each `=>`. */
function addArmBinders(body: Token | undefined, binders: Set<string>): void {
  if (body?.kind !== 'group') return;
  let start = 0;
  while (start < body.tokens.length) {
    const arrow = patternEnd(body.tokens, start, ['=>']);
    addPatternBinders(body.tokens.slice(start, arrow), binders);
    // An arm's body is a `{ ... }` block or an expression up to the next `,`.
    const first = body.tokens[arrow + 1];
    const end = first?.kind === 'group' && first.open === '{' ? arrow + 2 : patternEnd(body.tokens, arrow + 1, [',']);
    start = leafText(body.tokens[end]) === ',' ? end + 1 : end;
  }
}

/**
 * The variables a pattern of a rule's own code binds: its lowercase names, but not the paths, functions, and
 * constructors they are parts of (`Some(x)`, `S::A`), nor the field names of a struct pattern (`S { a: x }`).
 */
function addPatternBinders(tokens: Token[], binders: Set<string>): void {
  for (const [index, token] of tokens.entries()) {
    if (token.kind === 'group') {
      addPatternBinders(token.tokens, binders);
      continue;
    }
    const after = leafText(tokens[index + 1]);
    const before = leafText(tokens[index - 1]);
    if (after === '(' || after === '::' || after === '{' || after === '!' || after === ':' || before === '::') continue;
    if (tokens[index + 1]?.kind === 'group' && (tokens[index + 1] as { open: string }).open !== '[') continue;
    const isName = /^[\p{Ll}_][\p{L}\p{N}_]*$/u.test(token.text);
    if (isName && token.fromRule && !['_', 'mut', 'ref', 'in', 'if'].includes(token.text)) binders.add(token.text);
  }
}

/** The macros whose first string literal (after the target, for `write!`) is a format string. */
const FORMAT_MACROS = new Set([
  'format',
  'print',
  'println',
  'eprint',
  'eprintln',
  'write',
  'writeln',
  'panic',
  'assert',
  'assert_eq',
  'assert_ne',
  'format_args',
]);

/**
 * Renames the variables a rule's code binds (`x` to `x__2`) where the rule's code uses them: not as fields, paths,
 * or macros, not as a struct expression's field name (whose shorthand `S { x }` becomes `S { x: x__2 }`), and in a
 * string literal only where it is a format string, whose inline arguments (`{x}`) name variables.
 */
function renamed(
  tokens: Token[],
  binders: Set<string>,
  suffix: string,
  context: 'struct' | 'format' | undefined = undefined
): Token[] {
  // Only a format macro's first string literal is its format string.
  let formatString = context === 'format';
  return tokens.flatMap((token, index): Token[] => {
    if (token.kind === 'group') {
      return [{ ...token, tokens: renamed(token.tokens, binders, suffix, groupContext(tokens, index)) }];
    }
    if (!token.fromRule) return [token];
    if (token.type === 'string_literal') {
      const renaming = formatString;
      formatString = false;
      return [renaming ? { ...token, text: renamedFormat(token.text, binders, suffix) } : token];
    }
    return renamedLeaf(tokens, index, binders, suffix, context === 'struct');
  });
}

/** A format string with its inline arguments (`{t}`, `{t:>3}`) renamed where they name the rule's variables. */
function renamedFormat(text: string, binders: Set<string>, suffix: string): string {
  return text.replaceAll(/(?<!\{)\{([\p{L}_][\p{L}\p{N}_]*)(?=[}:])/gu, (whole, name: string) =>
    binders.has(name) ? `{${name}${suffix}` : whole
  );
}

/** A leaf, renamed where it is one of the rule's variables; in a struct's fields, a field name stays as it is. */
function renamedLeaf(tokens: Token[], index: number, binders: Set<string>, suffix: string, inStruct: boolean): Token[] {
  const token = tokens[index] as Token & { kind: 'leaf' };
  const before = leafText(tokens[index - 1]);
  const after = leafText(tokens[index + 1]);
  const isVariable = binders.has(token.text) && before !== '.' && before !== '::' && after !== '!' && after !== '::';
  if (!isVariable) return [token];
  const fieldPlace = inStruct && (index === 0 || before === ',');
  if (fieldPlace && after === ':') return [token];
  const variable = { ...token, text: `${token.text}${suffix}` };
  if (fieldPlace && (after === ',' || after === undefined)) {
    return [token, { kind: 'leaf', text: ':', type: ':', fromRule: true }, variable];
  }
  return [variable];
}

/** What a group is: the fields of a struct expression or pattern (`S { .. }`), a format macro's arguments, or neither. */
function groupContext(tokens: Token[], index: number): 'struct' | 'format' | undefined {
  const group = tokens[index] as Token & { kind: 'group' };
  const before = leafText(tokens[index - 1]);
  if (group.open === '{' && before !== undefined && /^[\p{Lu}]/u.test(before)) return 'struct';
  if (before === '!' && FORMAT_MACROS.has(leafText(tokens[index - 2]) ?? '')) return 'format';
  return undefined;
}

/** Whether the token at `index` is a `|` that opens a closure's parameters: one where an operand begins. */
export function opensClosure(tokens: Token[], start: number, index: number): boolean {
  if (leafText(tokens[index]) !== '|') return false;
  if (index === start) return true;
  const previous = tokens[index - 1];
  if (previous.kind !== 'leaf') return false;
  return previous.text === 'move' || (/^[^\p{L}\p{N}_'"]/u.test(previous.text) && previous.text !== '?');
}

export function leafText(token: Token | undefined): string | undefined {
  return token?.kind === 'leaf' ? token.text : undefined;
}
