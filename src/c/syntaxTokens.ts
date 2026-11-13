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

export function sizeofTypeFollowers(
  tokens: SourceToken[],
  scopes: readonly TypeScope[],
  fallback: ReadonlySet<string>,
  budget: ExecutionBudget
): SourceToken[] {
  const closes = closingParentheses(tokens, budget);
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

function closingParentheses(tokens: SourceToken[], budget: ExecutionBudget): Map<number, number> {
  const closes = new Map<number, number>();
  const stack: number[] = [];
  for (const [index, { token }] of tokens.entries()) {
    budget.spend();
    if (token.kind !== 'punctuator') continue;
    if (token.text === '(') stack.push(index);
    else if (token.text === ')') {
      const open = stack.pop();
      if (open !== undefined) closes.set(open, index);
    }
  }
  return closes;
}
