import type { Node } from '@willbooster/web-tree-sitter';

import { hygienic, leafText, opensClosure } from './macroHygiene';

/**
 * A token of a macro's input or rules: a single token, or a group in delimiters with the tokens inside. `spaced` tells
 * whether the source has a space before it (before the closing delimiter, for `closeSpaced`), which `stringify!` keeps.
 */
export type Token =
  | { kind: 'leaf'; text: string; type: string; spaced?: boolean; fromRule?: true }
  | {
      kind: 'group';
      open: string;
      close: string;
      tokens: Token[];
      spaced?: boolean;
      closeSpaced?: boolean;
      /** An `expr` variable's tokens, which keep one operand as parentheses would but which `stringify!` shows bare. */
      invisible?: true;
    };

/** A part of a rule's matcher or transcriber. */
type Part =
  | { kind: 'token'; token: Token & { kind: 'leaf' } }
  | { kind: 'group'; open: string; close: string; parts: Part[]; spaced?: boolean; closeSpaced?: boolean }
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

/** Whether a token's grammar type is a string literal, cooked (`"..."`) or raw (`r"..."`). */
export function isStringLiteral(type: string): boolean {
  return type === 'string_literal' || type === 'raw_string_literal';
}
const CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** The tokens of a token tree, inside its outer delimiters, grouped by the delimiters within. */
// code-gauge-allow functionCognitiveComplexity -- Recovers lifetimes and repetition separators that tree-sitter splits or leaves out.
export function tokensOf(tree: Node): Token[] {
  const leaves: (Token & { kind: 'leaf' })[] = [];
  let lastEnd: number | undefined;
  const push = (text: string, type: string, start: number, end: number): void => {
    leaves.push({ kind: 'leaf', text, type, spaced: lastEnd !== undefined && start > lastEnd });
    lastEnd = end;
  };
  const visit = (node: Node): void => {
    if (node.type === 'line_comment' || node.type === 'block_comment') {
      // Comments are not tokens, except the mark of an `expr` variable's parentheses.
      if (node.text === EXPR_MARK) leaves.push({ kind: 'leaf', text: EXPR_MARK, type: 'block_comment' });
      return;
    }
    if (node.childCount === 0 || LEAF_TYPES.has(node.type) || node.type.endsWith('_literal')) {
      if (!mergedLifetime(leaves, node)) push(node.text, node.type, node.startIndex, node.endIndex);
      else lastEnd = node.endIndex;
      return;
    }
    let end = node.startIndex;
    for (const child of node.children) {
      // tree-sitter leaves a repetition's separator (`$(...),*`) out of its tree, so it comes from the text.
      if (node.type.startsWith('token_repetition')) {
        const raw = node.text.slice(end - node.startIndex, child.startIndex - node.startIndex);
        const start = end + raw.indexOf(raw.trim());
        if (raw.trim()) push(raw.trim(), raw.trim(), start, start + raw.trim().length);
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

/** In a token tree, tree-sitter splits a lifetime (`'a`) into a quote and a name, which this joins again. */
function mergedLifetime(leaves: (Token & { kind: 'leaf' })[], node: Node): boolean {
  const previous = leaves.at(-1);
  if (previous?.type !== "'" || !/^\w+$/.test(node.text)) return false;
  leaves[leaves.length - 1] = { ...previous, text: `'${node.text}`, type: 'lifetime' };
  return true;
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
      const closeSpaced = leaves[next - 1]?.spaced;
      const marked = (inner[0] as { text?: string } | undefined)?.text === EXPR_MARK;
      tokens.push({
        kind: 'group',
        open: leaf.text,
        close: closer,
        tokens: marked ? inner.slice(1) : inner,
        spaced: leaf.spaced,
        closeSpaced,
        ...(marked ? { invisible: true as const } : {}),
      });
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
      const { open, close, spaced, closeSpaced } = token;
      read = [{ kind: 'group', open, close, parts: parseParts(token.tokens, matcher), spaced, closeSpaced }, index];
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
    if (matchParts(rule.matcher, input, 0, bindings) === input.length) {
      return hygienic(transcribe(rule.transcriber, bindings));
    }
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
/** The fragments of one token, by what that token must be. */
const SINGLE_TOKEN_FRAGMENTS: Record<string, (token: Token) => boolean> = {
  tt: () => true,
  ident: (token) => token.kind === 'leaf' && /^(?:r#)?[\p{L}_][\p{L}\p{N}_]*$/u.test(token.text) && token.text !== '_',
  lifetime: (token) => token.kind === 'leaf' && token.type === 'lifetime',
  block: (token) => token.kind === 'group' && token.open === '{',
};

function matchFragment(fragment: string, tokens: Token[], start: number, following: Part | undefined): number {
  const token = tokens[start];
  if (fragment === 'literal') return matchLiteral(tokens, start);
  const single = SINGLE_TOKEN_FRAGMENTS[fragment] as ((token: Token) => boolean) | undefined;
  if (single) return token && single(token) ? start + 1 : -1;
  // rustc tells from the first token whether an item or a meta can begin, and tries the next rule when neither can.
  if (fragment === 'item') return beginsItem(tokens, start) ? itemEnd(tokens, start) : -1;
  const begins = fragment !== 'meta' || isPathStart(leafText(token));
  return begins ? matchUntilStop(fragment, tokens, start, following) : -1;
}

/** The keywords of items whose `{ ... }` body ends them; the others end at their `;`. */
const BODY_ITEMS = new Set(['fn', 'impl', 'trait', 'mod', 'enum', 'macro_rules']);

/**
 * Where one item from `start` ends: after its body (`fn f() {}`, `impl X {}`, a braced struct or union, a macro
 * called with braces) or after its `;` (`const C: i32 = 3;`, `struct S(i32);`, `use a::{b, c};`), or -1.
 */
function itemEnd(tokens: Token[], start: number): number {
  let keyword: string | undefined;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index];
    const text = leafText(token);
    if (text === ';') return index + 1;
    if (keyword === undefined && text !== undefined && /^[a-z_]+$/.test(text) && text !== 'pub') keyword = text;
    const isBody = token.kind === 'group' && token.open === '{';
    if (!isBody) continue;
    const braced = keyword !== undefined && (BODY_ITEMS.has(keyword) || keyword === 'struct' || keyword === 'union');
    if (braced || leafText(tokens[index - 1]) === '!') return index + 1;
  }
  return -1;
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

const ITEM_KEYWORDS = new Set([
  'fn',
  'struct',
  'enum',
  'union',
  'impl',
  'trait',
  'mod',
  'use',
  'const',
  'static',
  'type',
  'unsafe',
  'extern',
  'async',
  'pub',
  'macro_rules',
]);

/** Whether an item can begin at `start`, as rustc tells before it picks a rule: an attribute, a keyword, or a macro. */
function beginsItem(tokens: Token[], start: number): boolean {
  const first = leafText(tokens[start]);
  if (first === '#' || (first !== undefined && ITEM_KEYWORDS.has(first))) return true;
  return isPathStart(first) && leafText(tokens[start + 1]) === '!';
}

function isPathStart(text: string | undefined): boolean {
  return text !== undefined && (text === '::' || /^(?:r#)?[\p{L}_][\p{L}\p{N}_]*$/u.test(text));
}

/**
 * A fragment of several tokens (`expr`, `ty`, `pat`, ...), which runs up to a token that may follow it. A stop counts
 * only outside generic arguments (`Vec<i32>`, `HashMap<K, V>`, `f::<T>`) and a closure's parameters (`|a, b|`).
 */
function matchUntilStop(fragment: string, tokens: Token[], start: number, following: Part | undefined): number {
  const stops = new Set<string>(STOPS[fragment]);
  if (following?.kind === 'token') stops.add(following.token.text);
  if (following?.kind === 'rep' && following.separator) stops.add(following.separator);
  const types = fragment === 'ty' || fragment === 'path';
  let depth = 0;
  let end = start;
  while (end < tokens.length && !(depth === 0 && stops.has(stopText(tokens[end], end > start) ?? ''))) {
    if (EXPRESSIONS.has(fragment) && opensClosure(tokens, start, end)) {
      end = closureParamsEnd(tokens, end);
      continue;
    }
    depth = Math.max(0, depth + angleChange(leafText(tokens[end]), types || leafText(tokens[end - 1]) === '::', depth));
    end++;
  }
  if (fragment === 'vis') return end;
  return end > start ? end : -1;
}

const EXPRESSIONS = new Set(['expr', 'expr_2021', 'stmt']);

/** The text a stop is told by: a leaf's, or a group's opening bracket after the fragment's first token (`i32 { .. }`). */
function stopText(token: Token, afterFirst: boolean): string | undefined {
  if (token.kind === 'group') return afterFirst ? token.open : undefined;
  return token.text;
}

/** How a token changes the depth of generic arguments: `<` opens them where it can, `>` and `>>` close them. */
function angleChange(text: string | undefined, opens: boolean, depth: number): number {
  if (text === '<' && opens) return 1;
  if (depth === 0) return 0;
  return text === '>' ? -1 : text === '>>' ? -2 : 0;
}

/** The index after the `|` that closes the closure parameters opened at `index`. */
function closureParamsEnd(tokens: Token[], index: number): number {
  for (let end = index + 1; end < tokens.length; end++) if (leafText(tokens[end]) === '|') return end + 1;
  return tokens.length;
}

function transcribe(parts: Part[], bindings: Map<string, Binding>): Token[] {
  const out: Token[] = [];
  for (const part of parts) {
    switch (part.kind) {
      case 'token': {
        out.push({ ...part.token, fromRule: true });
        break;
      }
      case 'group': {
        const { open, close, spaced, closeSpaced } = part;
        out.push({ kind: 'group', open, close, tokens: transcribe(part.parts, bindings), spaced, closeSpaced });
        break;
      }
      case 'var': {
        out.push(...transcribeVar(part.name, bindings));
        break;
      }
      case 'rep': {
        out.push(...transcribeRepetition(part, bindings));
        break;
      }
    }
  }
  return stringified(out);
}

function transcribeRepetition(part: Part & { kind: 'rep' }, bindings: Map<string, Binding>): Token[] {
  const names = variablesIn(part.parts).filter((name) => bindings.get(name)?.kind === 'rep');
  if (names.length === 0) throw new MacroError('マクロの繰り返しの中に、繰り返す変数がありません。');
  const counts = names.map((name) => (bindings.get(name) as Binding & { kind: 'rep' }).rounds.length);
  if (counts.some((count) => count !== counts[0])) {
    throw new MacroError('マクロの繰り返しの中の変数の、繰り返す回数がそろっていません。');
  }
  const out: Token[] = [];
  for (let round = 0; round < counts[0]; round++) {
    if (round > 0 && part.separator !== undefined)
      out.push({ kind: 'leaf', text: part.separator, type: part.separator });
    const scope = new Map(bindings);
    for (const name of names) {
      for (const [inner, binding] of (bindings.get(name) as Binding & { kind: 'rep' }).rounds[round]) {
        scope.set(inner, binding);
      }
    }
    out.push(...transcribe(part.parts, scope));
  }
  return out;
}

/**
 * Replaces each `stringify!(...)` in a transcription with the string literal of its tokens as written, so that an
 * `expr` variable shows without the parentheses its expansion keeps it in.
 */
function stringified(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const bang = tokens[index + 1];
    const args = tokens[index + 2];
    if (
      token.kind !== 'leaf' ||
      token.text !== 'stringify' ||
      bang?.kind !== 'leaf' ||
      bang.text !== '!' ||
      args?.kind !== 'group'
    ) {
      out.push(token);
      continue;
    }
    // A `std::` or `core::` before the macro's name goes with it.
    const path =
      out.at(-1)?.kind === 'leaf' &&
      (out.at(-1) as Token & { kind: 'leaf' }).text === '::' &&
      ['std', 'core'].includes((out.at(-2) as { text?: string } | undefined)?.text ?? '');
    const first = path ? (out.splice(-2)[0] as Token) : token;
    const text = writtenText(args.tokens)
      .replaceAll('\\', String.raw`\\`)
      .replaceAll('"', String.raw`\"`);
    out.push({ kind: 'leaf', text: `"${text}"`, type: 'string_literal', spaced: first.spaced });
    index += 2;
  }
  return out;
}

/**
 * The text of tokens as `stringify!` gives it: with the spaces the source has between them, but none before `,`,
 * `;`, or a call's or an index's brackets, and none inside `( )` and `[ ]`, as rustc prints tokens.
 */
function writtenText(tokens: Token[], top = true, tight = false): string {
  return tokens
    .map((token, index) => {
      const glued = (index === 0 && tight) || !spacedAfter(tokens[index - 1], token);
      const space = (index > 0 || !top) && token.spaced && !glued ? ' ' : '';
      return `${space}${token.kind === 'leaf' ? token.text : groupText(token, top && index === 0, tight && index === 0)}`;
    })
    .join('');
}

/** A group's text: its brackets and what is in them, which an `expr` variable's invisible group shows bare. */
function groupText(group: Token & { kind: 'group' }, first: boolean, tight: boolean): string {
  const bracket = group.open === '(' || group.open === '[';
  const inner = writtenText(group.tokens, group.invisible ? first : false, bracket || tight);
  if (group.invisible) return inner;
  return `${group.open}${inner}${group.closeSpaced && inner && !bracket ? ' ' : ''}${group.close}`;
}

/** Whether rustc's token printing keeps a space between two tokens: not before `,` and `;`, nor before a call's `(`. */
export function spacedAfter(previous: Token | undefined, token: Token): boolean {
  if (token.kind === 'leaf') return token.text !== ',' && token.text !== ';';
  if (token.open !== '(' && token.open !== '[') return true;
  if (previous === undefined) return true;
  return previous.kind === 'leaf' ? !/^[\p{L}\p{N}_]/u.test(previous.text) : previous.open === '{';
}

function transcribeVar(name: string, bindings: Map<string, Binding>): Token[] {
  if (name === 'crate') return [{ kind: 'leaf', text: 'crate', type: 'crate' }];
  const binding = bindings.get(name);
  if (!binding) return [{ kind: 'leaf', text: `$${name}`, type: 'metavariable' }];
  if (binding.kind === 'rep') throw new MacroError(`マクロの変数 $${name} は、$( ... ) の中で使ってください。`);
  // An expression is one operand where it lands, as rustc keeps it one node: `$x * 2` of `1 + 1` is 4.
  if (binding.fragment === 'expr' || binding.fragment === 'expr_2021') {
    return [{ kind: 'group', open: '(', close: ')', tokens: binding.tokens, invisible: true }];
  }
  return binding.tokens;
}

/**
 * The source text of tokens, on one line. An `expr` variable's parentheses carry a mark, which keeps them invisible
 * to `stringify!` when the text reaches another macro.
 */
export function tokenText(tokens: Token[], inGroup = false): string {
  let text = '';
  for (const token of tokens) {
    const part =
      token.kind === 'leaf'
        ? token.text
        : `${token.open}${token.invisible ? EXPR_MARK : ''}${tokenText(token.tokens, true)}${token.closeSpaced ? ' ' : ''}${token.close}`;
    // The spaces the source had stay, which `stringify!` shows (after a group's opening too), and two words never run
    // together.
    const apart = token.spaced || (/[\w'"]$/.test(text) && /^[\w'"]/.test(part));
    text += (text || inGroup) && apart ? ` ${part}` : part;
  }
  return text;
}

/** The comment that marks the parentheses an `expr` variable keeps its operand in. */
const EXPR_MARK = '/*expr*/';
