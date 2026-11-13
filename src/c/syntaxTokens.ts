import type { ExecutionBudget } from '../interpreter/limits';
import { type PPToken, tokenize } from './lexer';

export interface TypeScope {
  start: number;
  end: number;
  names: ReadonlySet<string>;
}

export interface SourceToken {
  token: PPToken;
  start: number;
  end: number;
}

export function sourceTokens(source: string, budget: ExecutionBudget): SourceToken[] {
  const result: SourceToken[] = [];
  tokenize(source, budget, (token, start, end) => result.push({ token, start, end }));
  return result;
}

const TYPE_WORDS = new Set([
  'void',
  'char',
  'short',
  'int',
  'long',
  'float',
  'double',
  'signed',
  'unsigned',
  '_Bool',
  'struct',
  'union',
  'enum',
]);
const QUALIFIERS = new Set(['const', 'volatile', 'restrict', '_Atomic']);
const CONTINUATIONS = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '<<',
  '>>',
  '<',
  '<=',
  '>',
  '>=',
  '==',
  '!=',
  '&',
  '^',
  '|',
  '&&',
  '||',
  '?',
  ':',
  ',',
  ';',
  ')',
  ']',
  '}',
  '{',
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '<<=',
  '>>=',
  '&=',
  '^=',
  '|=',
]);

const DECLARATION_WORDS = new Set([
  ...TYPE_WORDS,
  ...QUALIFIERS,
  'typedef',
  'extern',
  'static',
  'auto',
  'register',
  'inline',
  '_Noreturn',
  '_Alignas',
]);

export function sizeofTypeFollowers(
  tokens: SourceToken[],
  scopes: readonly TypeScope[],
  fallback: ReadonlySet<string>,
  budget: ExecutionBudget
): SourceToken[] {
  const closes = closingDelimiters(tokens, '(', ')', budget);
  const cursor = new TypeScopeCursor(scopes, budget);
  const result: SourceToken[] = [];
  for (const [index, current] of tokens.entries()) {
    budget.spend();
    if (current.token.text !== 'sizeof' || tokens[index + 1]?.token.text !== '(') continue;
    if (!startsType(tokens, index + 2, cursor.at(current.start) ?? fallback, budget)) continue;
    const close = closes.get(index + 1);
    const following = close === undefined ? undefined : tokens[close + 1];
    if (following && !CONTINUATIONS.has(following.token.text)) result.push(following);
  }
  return result;
}

export function aggregateDeclarationFollowers(
  tokens: SourceToken[],
  scopes: readonly TypeScope[],
  fallback: ReadonlySet<string>,
  budget: ExecutionBudget
): SourceToken[] {
  const closes = closingDelimiters(tokens, '{', '}', budget);
  const cursor = new TypeScopeCursor(scopes, budget);
  const result: SourceToken[] = [];
  for (const [index, current] of tokens.entries()) {
    budget.spend();
    if (!['struct', 'union', 'enum'].includes(current.token.text)) continue;
    let open = index + 1;
    if (tokens[open]?.token.kind === 'identifier') open++;
    if (tokens[open]?.token.text !== '{') continue;
    const close = closes.get(open);
    if (close === undefined) continue;
    const following = declarationFollower(tokens, close + 1, cursor.at(current.start) ?? fallback, budget);
    if (following) result.push(following);
  }
  return result;
}

export function declaratorFollowers(
  tokens: SourceToken[],
  starts: readonly number[],
  scopes: readonly TypeScope[],
  fallback: ReadonlySet<string>,
  budget: ExecutionBudget
): SourceToken[] {
  budget.spend(starts.length);
  const offsets = new Set(starts);
  const cursor = new TypeScopeCursor(scopes, budget);
  const result: SourceToken[] = [];
  for (const [index, current] of tokens.entries()) {
    budget.spend();
    if (!offsets.has(current.start)) continue;
    let name = index;
    while (tokens[name]?.token.text === '*' || QUALIFIERS.has(tokens[name]?.token.text)) {
      budget.spend();
      name++;
    }
    if (tokens[name]?.token.kind !== 'identifier' || DECLARATION_WORDS.has(tokens[name].token.text)) continue;
    const following = declarationFollower(tokens, name + 1, cursor.at(current.start) ?? fallback, budget);
    if (following) result.push(following);
  }
  return result;
}

class TypeScopeCursor {
  private readonly sorted: TypeScope[];
  private readonly active: TypeScope[] = [];
  private index = 0;

  constructor(
    scopes: readonly TypeScope[],
    private readonly budget: ExecutionBudget
  ) {
    budget.spend(scopes.length * Math.max(1, Math.ceil(Math.log2(scopes.length))));
    this.sorted = scopes.toSorted((a, b) => a.start - b.start || b.end - a.end);
  }

  at(offset: number): ReadonlySet<string> | undefined {
    while (this.index < this.sorted.length && this.sorted[this.index].start <= offset) {
      this.budget.spend();
      const scope = this.sorted[this.index++];
      if (scope.end >= offset) this.active.push(scope);
    }
    while (this.active.length > 0 && this.active.at(-1)!.end < offset) this.active.pop();
    return this.active.at(-1)?.names;
  }
}

function startsType(
  tokens: SourceToken[],
  start: number,
  names: ReadonlySet<string>,
  budget: ExecutionBudget
): boolean {
  let index = start;
  while (QUALIFIERS.has(tokens[index]?.token.text)) {
    budget.spend();
    index++;
  }
  const name = tokens[index]?.token.text;
  return name !== undefined && (TYPE_WORDS.has(name) || names.has(name));
}

function closingDelimiters(
  tokens: SourceToken[],
  openToken: string,
  closeToken: string,
  budget: ExecutionBudget
): Map<number, number> {
  const closes = new Map<number, number>();
  const stack: number[] = [];
  for (const [index, { token }] of tokens.entries()) {
    budget.spend();
    if (token.kind !== 'punctuator') continue;
    if (token.text === openToken) stack.push(index);
    else if (token.text === closeToken) {
      const open = stack.pop();
      if (open !== undefined) closes.set(open, index);
    }
  }
  return closes;
}

// code-gauge-allow functionCognitiveComplexity 25 -- Delimiter depth and initialization state must advance on the same declarator token stream.
function declarationFollower(
  tokens: SourceToken[],
  start: number,
  names: ReadonlySet<string>,
  budget: ExecutionBudget
): SourceToken | undefined {
  let depth = 0;
  let initialized = false;
  for (let index = start; index < tokens.length; index++) {
    budget.spend();
    const current = tokens[index];
    const text = current.token.text;
    if (depth === 0) {
      if (text === ';' || text === '}') return;
      if (startsDeclaration(tokens, index, names)) return current;
      if (text === '{' && !initialized) return;
      if (text === '=') initialized = true;
    }
    if (current.token.kind !== 'punctuator') continue;
    if (['(', '[', '{'].includes(text)) depth++;
    else if ([')', ']', '}'].includes(text)) {
      if (depth === 0) return;
      depth--;
    }
  }
  return undefined;
}

function startsDeclaration(tokens: SourceToken[], start: number, names: ReadonlySet<string>): boolean {
  let index = start;
  while (DECLARATION_WORDS.has(tokens[index]?.token.text) && !TYPE_WORDS.has(tokens[index]?.token.text)) index++;
  const text = tokens[index]?.token.text;
  return text !== undefined && (TYPE_WORDS.has(text) || (names.has(text) && typedefDeclarationFollows(tokens, index)));
}

function typedefDeclarationFollows(tokens: SourceToken[], index: number): boolean {
  const next = tokens[index + 1]?.token;
  return next?.kind === 'identifier' || next?.text === '*';
}
