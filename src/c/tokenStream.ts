import type { ExecutionBudget } from '../interpreter/limits';
import type { PPToken } from './lexer';

export class TokenStream {
  private readonly chunks: { tokens: PPToken[]; index: number }[] = [];

  constructor(
    tokens: PPToken[],
    private readonly budget: ExecutionBudget
  ) {
    this.prepend(tokens);
  }

  prepend(tokens: PPToken[]): void {
    if (tokens.length > 0) this.chunks.push({ tokens, index: 0 });
  }

  peek(): PPToken | undefined {
    while (this.chunks.length > 0) {
      const chunk = this.chunks.at(-1)!;
      if (chunk.index < chunk.tokens.length) return chunk.tokens[chunk.index];
      this.chunks.pop();
    }
    return undefined;
  }

  take(): PPToken | undefined {
    const token = this.peek();
    if (token) {
      this.budget.spend(1 + (token.hide?.size ?? 0));
      this.chunks.at(-1)!.index++;
    }
    return token;
  }
}
