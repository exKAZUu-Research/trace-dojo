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

export function declarationFollowers(
  tokens: SourceToken[],
  starts: readonly number[],
  scopes: readonly TypeScope[],
  fallback: ReadonlySet<string>,
  budget: ExecutionBudget
): SourceToken[] {
  budget.spend(starts.length);
  const offsets = new Set(starts);
  const closes = closingDelimiters(tokens, '{', '}', budget);
  const cursor = new TypeScopeCursor(scopes, budget);
  const result: SourceToken[] = [];
  for (const [index, current] of tokens.entries()) {
    budget.spend();
    if (!offsets.has(current.start)) continue;
    const names = cursor.at(current.start) ?? fallback;
    const start = afterDeclarationSpecifiers(tokens, index, names, closes, budget);
    if (start === index) continue;
    const following = declarationFollower(tokens, start, names, budget);
    if (following) result.push(following);
  }
  return result;
}

function afterDeclarationSpecifiers(
  tokens: SourceToken[],
  start: number,
  names: ReadonlySet<string>,
  closes: ReadonlyMap<number, number>,
  budget: ExecutionBudget
): number {
  let index = start;
  let hasType = false;
  while (index < tokens.length) {
    budget.spend();
    const text = tokens[index].token.text;
    if (['struct', 'union', 'enum'].includes(text)) {
      index++;
      if (tokens[index]?.token.kind === 'identifier') index++;
      const close = closes.get(index);
      if (close !== undefined) index = close + 1;
      return index;
    }
    if (TYPE_WORDS.has(text)) hasType = true;
    else if (!hasType && names.has(text)) hasType = true;
    else if (!DECLARATION_WORDS.has(text)) return index;
    index++;
  }
  return index;
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
  let hasDeclarator = false;
  for (let index = start; index < tokens.length; index++) {
    budget.spend();
    const current = tokens[index];
    const text = current.token.text;
    if (depth === 0) {
      if (text === ';' || text === '}') return;
      if (startsDeclaration(tokens, index, names, hasDeclarator)) return current;
      if (text === '{' && !initialized) return;
      if (text === '=') initialized = true;
    }
    const nextDepth = declaratorDepth(depth, current.token);
    if (nextDepth === undefined) return;
    depth = nextDepth;
    hasDeclarator ||= depth === 0 && completesDeclarator(current.token);
  }
  return undefined;
}

function declaratorDepth(depth: number, token: PPToken): number | undefined {
  if (token.kind !== 'punctuator') return depth;
  if (['(', '[', '{'].includes(token.text)) return depth + 1;
  if ([')', ']', '}'].includes(token.text)) return depth === 0 ? undefined : depth - 1;
  return depth;
}

function completesDeclarator(token: PPToken): boolean {
  return (
    (token.kind === 'identifier' && !DECLARATION_WORDS.has(token.text)) || token.text === ')' || token.text === ']'
  );
}

function startsDeclaration(
  tokens: SourceToken[],
  start: number,
  names: ReadonlySet<string>,
  hasDeclarator: boolean
): boolean {
  let index = start;
  while (DECLARATION_WORDS.has(tokens[index]?.token.text) && !TYPE_WORDS.has(tokens[index]?.token.text)) index++;
  const text = tokens[index]?.token.text;
  return (
    text !== undefined &&
    (TYPE_WORDS.has(text) || (names.has(text) && typedefDeclarationFollows(tokens, index, hasDeclarator)))
  );
}

function typedefDeclarationFollows(tokens: SourceToken[], index: number, hasDeclarator: boolean): boolean {
  const next = tokens[index + 1]?.token;
  return next?.kind === 'identifier' || next?.text === '*' || (hasDeclarator && next?.text === '(');
}
