import type { Node } from '@willbooster/web-tree-sitter';

/** A token of a macro's input or rules: a single token, or a group in delimiters with the tokens inside. */
export type Token =
  | { kind: 'leaf'; text: string; type: string }
  | { kind: 'group'; open: string; close: string; tokens: Token[] };

/** A part of a rule's matcher or transcriber. */
type Part =
  | { kind: 'token'; token: Token & { kind: 'leaf' } }
  | { kind: 'group'; open: string; close: string; parts: Part[] }
  | { kind: 'var'; name: string; fragment: string | undefined }
  | { kind: 'rep'; parts: Part[]; separator: string | undefined; op: '*' | '+' | '?' };

export interface MacroRule {
  matcher: Part[];
  transcriber: Part[];
}

/** What a rule's variables matched: tokens, or for a variable in a repetition, the matches of each round. */
type Binding = { kind: 'one'; tokens: Token[]; fragment: string } | { kind: 'rep'; rounds: Map<string, Binding>[] };

export class MacroError extends Error {}

const LEAF_TYPES = new Set(['string_literal', 'raw_string_literal', 'char_literal', 'lifetime', 'metavariable']);
const CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** The tokens of a token tree, inside its outer delimiters, grouped by the delimiters within. */
// code-gauge-allow functionCognitiveComplexity -- Recovers lifetimes and repetition separators that tree-sitter splits or leaves out.
export function tokensOf(tree: Node): Token[] {
  const leaves: (Token & { kind: 'leaf' })[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'line_comment' || node.type === 'block_comment') return;
    if (node.childCount === 0 || LEAF_TYPES.has(node.type) || node.type.endsWith('_literal')) {
      // In a token tree, tree-sitter splits a lifetime (`'a`) into a quote and a name.
      const previous = leaves.at(-1);
      if (previous?.type === "'" && /^\w+$/.test(node.text)) {
        leaves[leaves.length - 1] = { kind: 'leaf', text: `'${node.text}`, type: 'lifetime' };
        return;
      }
      leaves.push({ kind: 'leaf', text: node.text, type: node.type });
      return;
    }
    let end = node.startIndex;
    for (const child of node.children) {
      // tree-sitter leaves a repetition's separator (`$(...),*`) out of its tree, so it comes from the text.
      if (node.type.startsWith('token_repetition')) {
        const gap = node.text.slice(end - node.startIndex, child.startIndex - node.startIndex).trim();
        if (gap) leaves.push({ kind: 'leaf', text: gap, type: gap });
      }
      visit(child);
      end = child.endIndex;
    }
  };
  visit(tree);
  const [grouped] = group(leaves, 0);
  const outer = grouped[0];
  return outer?.kind === 'group' ? outer.tokens : grouped;
}

function group(leaves: (Token & { kind: 'leaf' })[], start: number, close?: string): [Token[], number] {
  const tokens: Token[] = [];
  let index = start;
  while (index < leaves.length) {
    const leaf = leaves[index];
    if (close !== undefined && leaf.text === close) return [tokens, index + 1];
    const closer = CLOSERS[leaf.text];
    if (closer && leaf.type === leaf.text) {
      const [inner, next] = group(leaves, index + 1, closer);
      tokens.push({ kind: 'group', open: leaf.text, close: closer, tokens: inner });
      index = next;
      continue;
    }
    tokens.push(leaf);
    index++;
  }
  if (close !== undefined) throw new MacroError(`閉じ括弧 ${close} が足りません。`);
  return [tokens, index];
}

/** Reads a rule's matcher (`$x:expr`, `$( ... ),*`) or transcriber (`$x`, `$( ... )*`) from its tokens. */
export function parseParts(tokens: Token[], matcher: boolean): Part[] {
  const parts: Part[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const next = tokens[index + 1];
    let read: [Part, number];
    if (token.kind === 'group') {
      read = [{ kind: 'group', open: token.open, close: token.close, parts: parseParts(token.tokens, matcher) }, index];
    } else if (token.type === 'metavariable') {
      read = parseVar(tokens, index, matcher);
    } else if (token.text === '$' && next?.kind === 'group' && next.open === '(') {
      read = parseRepetition(tokens, index, matcher);
    } else {
      read = [{ kind: 'token', token }, index];
    }
    parts.push(read[0]);
    index = read[1];
  }
  return parts;
}

/** `$x:expr` in a matcher, or `$x` in a transcriber, and the index of its last token. */
function parseVar(tokens: Token[], index: number, matcher: boolean): [Part, number] {
  const name = (tokens[index] as Token & { kind: 'leaf' }).text.slice(1);
  if (!matcher || name === 'crate') return [{ kind: 'var', name, fragment: undefined }, index];
  const colon = tokens[index + 1];
  const fragment = tokens[index + 2];
  if (colon?.kind !== 'leaf' || colon.text !== ':' || fragment?.kind !== 'leaf') {
    throw new MacroError(`マクロの規則の $${name} には、:expr のように種類を書いてください。`);
  }
  if (!FRAGMENTS.has(fragment.text)) throw new MacroError(`マクロの変数の種類 ${fragment.text} はありません。`);
  return [{ kind: 'var', name, fragment: fragment.text }, index + 2];
}

/** A repetition with its separator and operator, and the index of its last token. */
function parseRepetition(tokens: Token[], index: number, matcher: boolean): [Part, number] {
  const inner = parseParts((tokens[index + 1] as Token & { kind: 'group' }).tokens, matcher);
  let cursor = index + 2;
  let separator: string | undefined;
  const after = tokens[cursor];
  if (after?.kind === 'leaf' && !(isRepetitionOp(after) && !isRepetitionOp(tokens[cursor + 1]))) {
    separator = after.text;
    cursor++;
  }
  const op = tokens[cursor];
  if (!isRepetitionOp(op))
    throw new MacroError('マクロの繰り返し $( ... ) の後には、*、+、? のどれかを書いてください。');
  return [{ kind: 'rep', parts: inner, separator, op: op.text as '*' | '+' | '?' }, cursor];
}

function isRepetitionOp(token: Token | undefined): token is Token & { kind: 'leaf' } {
  return token?.kind === 'leaf' && (token.text === '*' || token.text === '+' || token.text === '?');
}

const FRAGMENTS = new Set([
  'expr',
  'expr_2021',
  'ident',
  'ty',
  'tt',
  'literal',
  'pat',
  'pat_param',
  'stmt',
  'block',
  'item',
  'path',
  'lifetime',
  'vis',
  'meta',
]);

/** What may follow each kind of fragment, where rustc ends the fragment. */
const STOPS: Record<string, ReadonlySet<string>> = {
  expr: new Set([',', ';', '=>']),
  expr_2021: new Set([',', ';', '=>']),
  stmt: new Set([',', ';', '=>']),
  ty: new Set([',', ';', '=>', '=', '|', '{', '[', ':', '>', 'as', 'where']),
  path: new Set([',', ';', '=>', '=', '|', '{', '[', ':', '>', 'as', 'where']),
  pat: new Set([',', '=>', '=', 'if', 'in']),
  pat_param: new Set([',', '=>', '=', '|', 'if', 'in']),
  item: new Set<string>(),
  vis: new Set([',']),
  meta: new Set([',', ';']),
};

/** Expands an invocation with the first rule whose matcher matches its tokens, giving the tokens of the result. */
export function expand(rules: MacroRule[], input: Token[], name: string): Token[] {
  for (const rule of rules) {
    const bindings = new Map<string, Binding>();
    if (matchParts(rule.matcher, input, 0, bindings) === input.length) return transcribe(rule.transcriber, bindings);
  }
  throw new MacroError(`マクロ ${name}! の規則に、この書き方に合うものがありません。`);
}

/** Matches parts against tokens from `start`, binding variables, and gives the position after them, or -1. */
function matchParts(parts: Part[], tokens: Token[], start: number, bindings: Map<string, Binding>): number {
  let position = start;
  for (const [index, part] of parts.entries()) {
    position = matchPart(part, parts[index + 1], tokens, position, bindings);
    if (position < 0) return -1;
  }
  return position;
}

function matchPart(
  part: Part,
  following: Part | undefined,
  tokens: Token[],
  position: number,
  bindings: Map<string, Binding>
): number {
  const token = tokens[position];
  switch (part.kind) {
    case 'token': {
      return token?.kind === 'leaf' && token.text === part.token.text ? position + 1 : -1;
    }
    case 'group': {
      if (token?.kind !== 'group' || token.open !== part.open) return -1;
      return matchParts(part.parts, token.tokens, 0, bindings) === token.tokens.length ? position + 1 : -1;
    }
    case 'var': {
      const end = matchFragment(part.fragment ?? 'tt', tokens, position, following);
      if (end >= 0)
        bindings.set(part.name, { kind: 'one', tokens: tokens.slice(position, end), fragment: part.fragment ?? 'tt' });
      return end;
    }
    case 'rep': {
      return matchRepetition(part, tokens, position, bindings);
    }
  }
}

/** Matches as many rounds of a repetition as the tokens hold, binding each variable to its rounds. */
// code-gauge-allow functionCognitiveComplexity -- Follows the macro_rules repetition matcher of rustc.
function matchRepetition(
  part: Part & { kind: 'rep' },
  tokens: Token[],
  start: number,
  bindings: Map<string, Binding>
): number {
  const rounds: Map<string, Binding>[] = [];
  let position = start;
  for (;;) {
    let cursor = position;
    if (rounds.length > 0 && part.separator !== undefined) {
      const separator = tokens[cursor];
      if (separator?.kind !== 'leaf' || separator.text !== part.separator) break;
      cursor++;
    }
    const round = new Map<string, Binding>();
    const end = matchParts(part.parts, tokens, cursor, round);
    if (end < 0 || (end === cursor && part.parts.length > 0)) break;
    rounds.push(round);
    position = end;
    if (part.op === '?') break;
  }
  if (part.op === '+' && rounds.length === 0) return -1;
  for (const name of variablesIn(part.parts)) bindings.set(name, { kind: 'rep', rounds });
  return position;
}

function variablesIn(parts: Part[]): string[] {
  return parts.flatMap((part) => {
    if (part.kind === 'var') return [part.name];
    if (part.kind === 'group' || part.kind === 'rep') return variablesIn(part.parts);
    return [];
  });
}

/** Where a fragment that starts at `start` ends, or -1 if none does. */
function matchFragment(fragment: string, tokens: Token[], start: number, following: Part | undefined): number {
  const token = tokens[start];
  switch (fragment) {
    case 'tt': {
      return token ? start + 1 : -1;
    }
    case 'ident': {
      const isIdent =
        token?.kind === 'leaf' && /^(?:r#)?[\p{L}_][\p{L}\p{N}_]*$/u.test(token.text) && token.text !== '_';
      return isIdent ? start + 1 : -1;
    }
    case 'lifetime': {
      return token?.kind === 'leaf' && token.type === 'lifetime' ? start + 1 : -1;
    }
    case 'literal': {
      return matchLiteral(tokens, start);
    }
    case 'block': {
      return token?.kind === 'group' && token.open === '{' ? start + 1 : -1;
    }
    default: {
      return matchUntilStop(fragment, tokens, start, following);
    }
  }
}

/** A literal, with a `-` before a number. */
function matchLiteral(tokens: Token[], start: number): number {
  const token = tokens[start];
  if (token?.kind !== 'leaf') return -1;
  if (token.text === '-') {
    const next = tokens[start + 1];
    return next?.kind === 'leaf' && next.type.endsWith('_literal') ? start + 2 : -1;
  }
  return token.type.endsWith('_literal') || token.text === 'true' || token.text === 'false' ? start + 1 : -1;
}

/** A fragment of several tokens (`expr`, `ty`, `pat`, ...), which runs up to a token that may follow it. */
function matchUntilStop(fragment: string, tokens: Token[], start: number, following: Part | undefined): number {
  const stops = new Set<string>(STOPS[fragment]);
  if (following?.kind === 'token') stops.add(following.token.text);
  if (following?.kind === 'rep' && following.separator) stops.add(following.separator);
  let end = start;
  while (end < tokens.length) {
    const current = tokens[end];
    if (current.kind === 'leaf' && stops.has(current.text)) break;
    end++;
  }
  if (fragment === 'vis') return end;
  return end > start ? end : -1;
}

// code-gauge-allow functionCognitiveComplexity -- One case per kind of transcriber part.
function transcribe(parts: Part[], bindings: Map<string, Binding>): Token[] {
  const out: Token[] = [];
  for (const part of parts) {
    switch (part.kind) {
      case 'token': {
        out.push(part.token);
        break;
      }
      case 'group': {
        out.push({ kind: 'group', open: part.open, close: part.close, tokens: transcribe(part.parts, bindings) });
        break;
      }
      case 'var': {
        out.push(...transcribeVar(part.name, bindings));
        break;
      }
      case 'rep': {
        const names = variablesIn(part.parts).filter((name) => bindings.get(name)?.kind === 'rep');
        if (names.length === 0) throw new MacroError('マクロの繰り返しの中に、繰り返す変数がありません。');
        const counts = names.map((name) => (bindings.get(name) as Binding & { kind: 'rep' }).rounds.length);
        if (counts.some((count) => count !== counts[0])) {
          throw new MacroError('マクロの繰り返しの中の変数の、繰り返す回数がそろっていません。');
        }
        for (let round = 0; round < counts[0]; round++) {
          if (round > 0 && part.separator !== undefined) {
            out.push({ kind: 'leaf', text: part.separator, type: part.separator });
          }
          const scope = new Map(bindings);
          for (const name of names) {
            for (const [inner, binding] of (bindings.get(name) as Binding & { kind: 'rep' }).rounds[round]) {
              scope.set(inner, binding);
            }
          }
          out.push(...transcribe(part.parts, scope));
        }
        break;
      }
    }
  }
  return out;
}

function transcribeVar(name: string, bindings: Map<string, Binding>): Token[] {
  if (name === 'crate') return [{ kind: 'leaf', text: 'crate', type: 'crate' }];
  const binding = bindings.get(name);
  if (!binding) return [{ kind: 'leaf', text: `$${name}`, type: 'metavariable' }];
  if (binding.kind === 'rep') throw new MacroError(`マクロの変数 $${name} は、$( ... ) の中で使ってください。`);
  // An expression is one operand where it lands, as rustc keeps it one node: `$x * 2` of `1 + 1` is 4.
  if (binding.fragment === 'expr' || binding.fragment === 'expr_2021') {
    return [{ kind: 'group', open: '(', close: ')', tokens: binding.tokens }];
  }
  return binding.tokens;
}

/** The source text of tokens, on one line. */
export function tokenText(tokens: Token[]): string {
  return tokens
    .map((token) => (token.kind === 'leaf' ? token.text : `${token.open} ${tokenText(token.tokens)} ${token.close}`))
    .join(' ');
}
