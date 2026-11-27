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
  return renamed(tokens, binders, `__${expansions}`, { bound: new Set(), hidden: new Set() });
}

/** A variable's name as the rule wrote it, before `hygienic` renamed it, as `stringify!` and `assert!` show it. */
export function writtenName(name: string): string {
  return name.replace(/__\d+$/, '');
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
      addParamBinders(tokens.slice(index + 1, patternEnd(tokens, index + 1, ['|'])), binders);
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

/** The variables a closure's parameters bind: each one's pattern, up to its type (`x: i32`, `m: HashMap<K, V>`). */
function addParamBinders(params: Token[], binders: Set<string>): void {
  let pattern: Token[] = [];
  let inType = false;
  let depth = 0;
  for (const token of [...params, undefined]) {
    const text = leafText(token);
    if (token === undefined || (text === ',' && depth === 0)) {
      addPatternBinders(pattern, binders);
      [pattern, inType] = [[], false];
    } else if (inType) depth += text === '<' ? 1 : text === '>' ? -1 : 0;
    else if (text === ':') inType = true;
    else pattern.push(token);
  }
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
 * string literal only where it is a format string, whose inline arguments (`{x}`) name variables. A `let`'s own
 * initializer does not see the names it binds (`let double = double(x);` calls the function).
 */
// code-gauge-allow functionCognitiveComplexity -- One walk renames groups, leaves, and format strings in source order.
function renamed(
  tokens: Token[],
  binders: Set<string>,
  suffix: string,
  scope: Scope,
  context?: 'struct' | 'format'
): Token[] {
  // Only a format macro's first string literal is its format string.
  let formatString = context === 'format';
  const out: Token[] = [];
  let initializer: Initializer | undefined;
  for (const [index, token] of tokens.entries()) {
    if (initializer) hideInInitializer(initializer, index, scope);
    if (token.kind === 'group') {
      out.push({ ...token, tokens: renamed(token.tokens, binders, suffix, scope, groupContext(tokens, index)) });
      continue;
    }
    if (!token.fromRule) {
      out.push(token);
      continue;
    }
    if (token.text === 'let') initializer = letInitializer(tokens, index, scope);
    if (token.type === 'string_literal') {
      out.push(formatString ? { ...token, text: renamedFormat(token.text, binders, suffix) } : token);
      formatString = false;
    } else out.push(...renamedLeaf(tokens, index, binders, scope.hidden, suffix, context === 'struct'));
  }
  if (initializer) hideInInitializer(initializer, initializer.end, scope);
  return out;
}

/** A `let`'s initializer, from its `=` to its `;`, and the names its pattern newly binds. */
interface Initializer {
  start: number;
  end: number;
  names: string[];
  hidden: string[];
}

function letInitializer(tokens: Token[], index: number, scope: Scope): Initializer {
  const pattern = new Set<string>();
  addPatternBinders(tokens.slice(index + 1, patternEnd(tokens, index + 1, ['=', ':', 'else'])), pattern);
  const names = [...pattern].filter((name) => !scope.bound.has(name));
  for (const name of pattern) scope.bound.add(name);
  const end = patternEnd(tokens, index + 1, [';']);
  return { start: Math.min(patternEnd(tokens, index + 1, ['=']), end), end, names, hidden: [] };
}

/** Hides a `let`'s new names where its initializer begins, and shows them again where it ends. */
function hideInInitializer(initializer: Initializer, index: number, scope: Scope): void {
  if (index === initializer.start) {
    initializer.hidden = initializer.names.filter((name) => !scope.hidden.has(name));
    for (const name of initializer.hidden) scope.hidden.add(name);
  }
  if (index === initializer.end) {
    for (const name of initializer.hidden) scope.hidden.delete(name);
    initializer.hidden = [];
  }
}

interface Scope {
  /** The rule's variables that a `let` has bound so far. */
  bound: Set<string>;
  /** The variables of the `let` whose initializer this is, which mean what they meant before it. */
  hidden: Set<string>;
}

/** A format string with its inline arguments (`{t}`, `{t:>3}`) renamed where they name the rule's variables. */
function renamedFormat(text: string, binders: Set<string>, suffix: string): string {
  return text.replaceAll(/(?<!\{)\{([\p{L}_][\p{L}\p{N}_]*)(?=[}:])/gu, (whole, name: string) =>
    binders.has(name) ? `{${name}${suffix}` : whole
  );
}

/** A leaf, renamed where it is one of the rule's variables; in a struct's fields, a field name stays as it is. */
function renamedLeaf(
  tokens: Token[],
  index: number,
  binders: Set<string>,
  hidden: Set<string>,
  suffix: string,
  inStruct: boolean
): Token[] {
  const token = tokens[index] as Token & { kind: 'leaf' };
  const before = leafText(tokens[index - 1]);
  const after = leafText(tokens[index + 1]);
  const named = binders.has(token.text) && !hidden.has(token.text);
  const isVariable = named && before !== '.' && before !== '::' && after !== '!' && after !== '::';
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
