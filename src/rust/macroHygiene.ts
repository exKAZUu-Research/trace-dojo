import { isStringLiteral, type Token } from './macroRules';

let expansions = 0;

/**
 * Renames the variables that a rule's own `let`, `for`, `match` arms, and closure parameters introduce, where they are
 * in scope, so that they neither see nor hide the caller's variables of the same name, as rustc's hygiene keeps them
 * apart.
 */
export function hygienic(tokens: Token[]): Token[] {
  expansions++;
  return renamed(tokens, new Map(), `__${expansions}`);
}

/** A variable's name as the rule wrote it, before `hygienic` renamed it, as `stringify!` and `assert!` show it. */
export function writtenName(name: string): string {
  return name.replace(/__\d+$/, '');
}

/** How many of the rule's own bindings of each name are in scope at a point of its code. */
type Visible = Map<string, number>;

/** The names a pattern of the rule binds, in scope from token `from` up to (not including) token `to` of a list. */
interface Binding {
  names: string[];
  from: number;
  to: number;
}

/** Where the variables of the rule's own patterns are in scope in a list of tokens, and which `{ }` groups hold arms. */
function bindingsIn(tokens: Token[]): { bindings: Binding[]; matchBodies: Set<number> } {
  const bindings: Binding[] = [];
  const matchBodies = new Set<number>();
  const closers = new Set<number>();
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== 'leaf' || !token.fromRule || closers.has(index)) continue;
    if (token.text === 'let') bindings.push(...letBindings(tokens, index));
    else if (token.text === 'for') bindings.push(...forBindings(tokens, index));
    else if (token.text === 'match') {
      const body = nextBrace(tokens, index + 1);
      if (body !== undefined) matchBodies.add(body);
    } else if (token.text === '|' && opensClosure(tokens, 0, index)) {
      const close = patternEnd(tokens, index + 1, ['|']);
      closers.add(close);
      bindings.push(...closureBindings(tokens, index, close));
    }
  }
  return { bindings, matchBodies };
}

/**
 * A `let`'s names: in its pattern, then after its `;` for a statement; for a condition (`if let`, `while let`, a let
 * chain), from the end of its scrutinee through the body. Its own initializer does not see them
 * (`let double = double(x);` calls the function).
 */
function letBindings(tokens: Token[], index: number): Binding[] {
  const patternStop = patternEnd(tokens, index + 1, ['=', ':', 'else']);
  const names = patternNames(tokens.slice(index + 1, patternStop));
  const pattern = { names, from: index + 1, to: patternStop };
  if (!['if', 'while', '&&'].includes(leafText(tokens[index - 1]) ?? '')) {
    return [pattern, { names, from: patternEnd(tokens, index + 1, [';']), to: tokens.length }];
  }
  const scrutineeEnd = tokens.findIndex(
    (token, at) => at > patternStop && (leafText(token) === '&&' || isBrace(token))
  );
  if (scrutineeEnd === -1) return [pattern];
  const body = nextBrace(tokens, scrutineeEnd) ?? tokens.length - 1;
  return [pattern, { names, from: scrutineeEnd, to: body + 1 }];
}

/** A `for`'s names: in its pattern and its body, not in what it iterates. */
function forBindings(tokens: Token[], index: number): Binding[] {
  const inIndex = patternEnd(tokens, index + 1, ['in']);
  const names = patternNames(tokens.slice(index + 1, inIndex));
  const body = nextBrace(tokens, inIndex);
  const pattern = { names, from: index + 1, to: inIndex };
  return body === undefined ? [pattern] : [pattern, { names, from: body, to: body + 1 }];
}

/** A closure's parameters: in the parameter list and the body, a `{ }` block or an expression up to `,` or `;`. */
function closureBindings(tokens: Token[], open: number, close: number): Binding[] {
  const names = new Set<string>();
  addParamBinders(tokens.slice(open + 1, close), names);
  const end = isBrace(tokens[close + 1]) ? close + 2 : patternEnd(tokens, close + 1, [',', ';']);
  return [{ names: [...names], from: open + 1, to: end }];
}

/** The names each arm of a `match` body binds, in scope in its pattern, guard, and body. */
function armBindings(tokens: Token[]): Binding[] {
  const bindings: Binding[] = [];
  let start = 0;
  while (start < tokens.length) {
    const arrow = patternEnd(tokens, start, ['=>']);
    const names = patternNames(tokens.slice(start, patternEnd(tokens.slice(0, arrow), start, ['if'])));
    // An arm's body is a `{ ... }` block or an expression up to the next `,`.
    const end = isBrace(tokens[arrow + 1]) ? arrow + 2 : patternEnd(tokens, arrow + 1, [',']);
    bindings.push({ names, from: start, to: end });
    start = leafText(tokens[end]) === ',' ? end + 1 : end;
  }
  return bindings;
}

function patternNames(tokens: Token[]): string[] {
  const names = new Set<string>();
  addPatternBinders(tokens, names);
  return [...names];
}

function nextBrace(tokens: Token[], from: number): number | undefined {
  const index = tokens.findIndex((token, at) => at >= from && isBrace(token));
  return index === -1 ? undefined : index;
}

function isBrace(token: Token | undefined): boolean {
  return token?.kind === 'group' && token.open === '{';
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

/** The macros with a format string, by the argument it is: after `write!`'s target and `assert!`'s condition. */
const FORMAT_MACROS = new Map([
  ['format', 0],
  ['print', 0],
  ['println', 0],
  ['eprint', 0],
  ['eprintln', 0],
  ['panic', 0],
  ['format_args', 0],
  ['write', 1],
  ['writeln', 1],
  ['assert', 1],
  ['assert_eq', 2],
  ['assert_ne', 2],
]);

/**
 * Renames the rule's variables (`x` to `x__2`) where its code uses them in their scope: not as fields, paths, or
 * macros, not as a struct expression's field name (whose shorthand `S { x }` becomes `S { x: x__2 }`), and in a
 * string literal only where it is a format string, whose inline arguments (`{x}`) name variables.
 */
function renamed(tokens: Token[], outer: Visible, suffix: string, context?: GroupContext): Token[] {
  const visible = new Map(outer);
  const { bindings, matchBodies } = bindingsIn(tokens);
  if (context === 'match') bindings.push(...armBindings(tokens));
  const isFormatString = formatStringFinder(typeof context === 'number' ? context : -1);
  const out: Token[] = [];
  for (const [index, token] of tokens.entries()) {
    enterScopes(bindings, index, visible);
    const formatString = isFormatString(token);
    if (token.kind === 'group') {
      const inner = matchBodies.has(index) ? 'match' : groupContext(tokens, index);
      out.push({ ...token, tokens: renamed(token.tokens, visible, suffix, inner) });
    } else if (!token.fromRule) out.push(token);
    else if (formatString) out.push({ ...token, text: renamedFormat(token.text, visible, suffix) });
    else if (isStringLiteral(token.type)) out.push(token);
    else out.push(...renamedLeaf(tokens, index, visible, suffix, context === 'struct'));
  }
  return out;
}

/** Shows the names whose scopes begin at a token of a list, and hides those whose scopes end there. */
function enterScopes(bindings: Binding[], index: number, visible: Visible): void {
  for (const { names, from, to } of bindings) {
    if (from === index) for (const name of names) visible.set(name, (visible.get(name) ?? 0) + 1);
    if (to === index) for (const name of names) visible.set(name, (visible.get(name) ?? 0) - 1);
  }
}

/**
 * Tells, token by token, the format string of a format macro's arguments: the first string literal of the argument at
 * `position` (after `write!`'s target and `assert!`'s condition), or none for a position of -1.
 */
function formatStringFinder(position: number): (token: Token) => boolean {
  let argument = 0;
  let found = false;
  return (token) => {
    if (token.kind === 'leaf' && token.text === ',') argument++;
    const formatString = !found && argument === position && token.kind === 'leaf' && isStringLiteral(token.type);
    if (formatString) found = true;
    return formatString;
  };
}

/** What a group is: a struct's fields, a `match`'s arms, or a format macro's arguments, by its format string's place. */
type GroupContext = 'struct' | 'match' | number;

/** A format string with its inline arguments (`{t}`, `{t:>3}`) renamed where they name the rule's variables. */
function renamedFormat(text: string, visible: Visible, suffix: string): string {
  return text.replaceAll(/(?<!\{)\{([\p{L}_][\p{L}\p{N}_]*)(?=[}:])/gu, (whole, name: string) =>
    (visible.get(name) ?? 0) > 0 ? `{${name}${suffix}` : whole
  );
}

/** A leaf, renamed where it is one of the rule's variables; in a struct's fields, a field name stays as it is. */
function renamedLeaf(tokens: Token[], index: number, visible: Visible, suffix: string, inStruct: boolean): Token[] {
  const token = tokens[index] as Token & { kind: 'leaf' };
  const before = leafText(tokens[index - 1]);
  const after = leafText(tokens[index + 1]);
  const named = (visible.get(token.text) ?? 0) > 0;
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
function groupContext(tokens: Token[], index: number): GroupContext | undefined {
  const group = tokens[index] as Token & { kind: 'group' };
  const before = leafText(tokens[index - 1]);
  const name = leafText(tokens[before === '>' ? turbofishStart(tokens, index - 1) - 1 : index - 1]);
  if (group.open === '{' && name !== undefined && /^[\p{Lu}]/u.test(name)) return 'struct';
  if (before === '!') return FORMAT_MACROS.get(leafText(tokens[index - 2]) ?? '');
  return undefined;
}

/** Where the `::<` of the generic arguments that the `>` at `close` ends begins (`W::<i32>`), or `close` itself. */
function turbofishStart(tokens: Token[], close: number): number {
  let depth = 0;
  for (let index = close; index >= 0; index--) {
    const text = leafText(tokens[index]);
    depth += text === '>' ? 1 : text === '>>' ? 2 : text === '<' ? -1 : 0;
    if (depth === 0) return leafText(tokens[index - 1]) === '::' ? index - 1 : close;
  }
  return close;
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
