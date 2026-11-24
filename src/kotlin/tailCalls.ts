import type { Block, Expression, FunctionBody } from './ast';
import type { Frame } from './runtime';
import type { Value } from './values';

/** A call of a `tailrec` function by itself in tail position, which starts the function over in the same frame. */
export class TailCallSignal {
  constructor(
    readonly frame: Frame,
    readonly args: Value[]
  ) {}
}

/** The code a tail call cannot leave from, whose calls are not the function's own result. */
const OPAQUE_KINDS = new Set(['lambda', 'anonymousFunction', 'object', 'try', 'class', 'function']);

/**
 * The calls in tail position of a function's body: whose result is the function's, as the value of `return` or of an
 * expression body, through `if`, `when`, and parentheses, and the last statement of a `Unit` function's block.
 */
export function tailCallsOf(body: FunctionBody, returnsUnit: boolean): Set<Expression> {
  const calls = new Set<Expression>();
  const inTail = (expression: Expression): void => {
    switch (expression.kind) {
      case 'call': {
        calls.add(expression);
        break;
      }
      case 'parenthesized': {
        inTail(expression.expression);
        break;
      }
      case 'if': {
        inTailBlock(expression.thenBranch);
        if (expression.elseBranch) inTailBlock(expression.elseBranch);
        break;
      }
      case 'when': {
        for (const entry of expression.entries) inTailBlock(entry.body);
        break;
      }
      default: {
        break;
      }
    }
  };
  const inTailBlock = (block: Block): void => {
    const last = block.statements.at(-1);
    if (last?.kind === 'expressionStatement') inTail(last.expression);
  };
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const { kind } = node as { kind?: string };
    if (kind !== undefined && OPAQUE_KINDS.has(kind)) return;
    if (kind === 'return') {
      const { value } = node as Extract<Expression, { kind: 'return' }>;
      if (value && (node as { label?: string }).label === undefined) inTail(value);
    }
    for (const child of Object.values(node)) visit(child);
  };
  if (body.kind === 'expression') {
    inTail(body.expression);
    visit(body.expression);
  } else {
    if (returnsUnit) inTailBlock(body.block);
    visit(body.block);
  }
  return calls;
}
