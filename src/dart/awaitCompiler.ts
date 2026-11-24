import type { Expression, Span } from './ast';
import {
  AwaitedError,
  type AwaitRoot,
  AwaitSuspension,
  containsAwait,
  iterationKey,
  readMemo,
  rootCovers,
  writeMemo,
} from './awaitReplay';
import { type Compiled, CompilerBase } from './compilerBase';
import type { Frame } from './runtime';
import { coreTypes, type DartType, DYNAMIC, flatten, interfaceType, isTop } from './types';
import { Cell, type Value } from './values';

/**
 * Compiles `await` and what a statement that awaits must remember. Such a statement runs again from its start after
 * each `await` suspends it, so a part evaluated before a later `await` keeps its value in a slot, which evaluating the
 * statement again reuses instead of evaluating the part twice.
 */
export abstract class AwaitCompiler extends CompilerBase {
  /** The statement or loop condition being compiled whose `await`s may suspend it, if any. */
  protected awaitRoot: AwaitRoot | undefined;

  abstract compileExpression(expression: Expression, context?: DartType): Compiled;

  /** Compiles a part of an expression, remembering its value when an `await` after it may suspend the statement. */
  protected rememberedBeforeAwait(expression: Expression, compile: () => Compiled): Compiled {
    const root = this.awaitRoot;
    if (
      root?.fn !== this.fn ||
      root.memoDepth > 0 ||
      expression.kind === 'await' ||
      containsAwait(expression) ||
      !this.precedesAwait(expression)
    ) {
      return compile();
    }
    root.memoDepth++;
    let compiled: Compiled;
    try {
      compiled = compile();
    } finally {
      root.memoDepth--;
    }
    if (compiled.isConst) return compiled;
    const remember = this.remembering(root, expression);
    const { run } = compiled;
    return { ...compiled, run: (frame) => remember(frame, () => run(frame)) };
  }

  /**
   * A value an expression computes before `later` awaits, such as the current value of a compound assignment's
   * target, which evaluating the statement again after the `await` must reuse; undefined when `later` does not await.
   */
  protected rememberBeforeAwait(
    key: object,
    later: Span,
    laterParts: unknown = later
  ): ((frame: Frame, compute: () => Value) => Value) | undefined {
    const root = this.awaitRoot;
    if (root?.fn !== this.fn || !rootCovers(root, later) || !containsAwait(laterParts)) return undefined;
    return this.remembering(root, key);
  }

  /** Whether an `await` of the statement being compiled comes after `span`, which then runs before it suspends. */
  protected precedesAwait(span: Span): boolean {
    const root = this.awaitRoot;
    return root?.fn === this.fn && rootCovers(root, span) && root.awaitStarts.some((start) => start >= span.end);
  }

  /** Whether `span` is part of the statement being compiled whose `await`s suspend it and contains one of them. */
  protected awaitsWithin(span: Span): boolean {
    const root = this.awaitRoot;
    return root?.fn === this.fn && rootCovers(root, span) && containsAwait(span);
  }

  protected compileAwait(expression: Extract<Expression, { kind: 'await' }>, context: DartType | undefined): Compiled {
    if (!this.fn.kind.isAsync) return this.error(expression, 'await は async の関数の中にしか書けません。');
    const root = this.awaitRoot;
    // A late variable's initializer runs when it is first read, outside the statement that can suspend.
    if (root?.fn !== this.fn || !rootCovers(root, expression))
      return this.error(expression, 'ここでは await を使えません。');
    const operandContext =
      context && context.kind !== 'dynamic' && !isTop(context)
        ? interfaceType(coreTypes.futureOr, [context])
        : undefined;
    const operand = this.compileExpression(expression.value, operandContext);
    if (operand.type.kind === 'void') this.error(expression.value, 'void の値は、式の中では使えません。');
    const awaited = this.awaiting(root, expression);
    const { run } = operand;
    return { type: flatten(operand.type), run: (frame) => awaited(frame, () => run(frame)), isConst: false };
  }

  /**
   * Waits for a value inside a statement that awaits: suspends the statement with the future `compute` gives, and
   * once the statement runs again gives what the future completed with, or throws its error.
   */
  protected awaiting(root: AwaitRoot, key: object): (frame: Frame, compute: () => Value) => Value {
    const slot = this.awaitSlot(root, key);
    const iterated = root.iterated.has(slot);
    return (frame, compute) => {
      const cell = readMemo(frame, slot, iterated);
      if (cell instanceof AwaitedError) throw cell.error;
      if (cell) return cell.v;
      throw new AwaitSuspension(slot, compute(), iterated ? iterationKey(frame) : undefined);
    };
  }

  /**
   * Compiles code that runs after the code written after it, as a loop's updates run after its body, which therefore
   * remembers nothing before the body's `await`s.
   */
  protected withoutRemembering<T>(compile: () => T): T {
    const root = this.awaitRoot;
    if (root) root.memoDepth++;
    try {
      return compile();
    } finally {
      if (root) root.memoDepth--;
    }
  }

  /** A value remembered for each iteration of the collection `for` elements being compiled. */
  protected rememberEachIteration(key: object): (frame: Frame, compute: () => Value) => Value {
    const root = this.awaitRoot;
    return root ? this.remembering(root, key) : (_frame, compute) => compute();
  }

  /** Compiles a collection `for` element's parts, whose remembered values are kept apart for each iteration. */
  protected inCollectionLoop<T>(compile: () => T): T {
    const root = this.awaitRoot;
    if (root) root.loopDepth++;
    try {
      return compile();
    } finally {
      if (root) root.loopDepth--;
    }
  }

  private remembering(root: AwaitRoot, key: object): (frame: Frame, compute: () => Value) => Value {
    const slot = this.awaitSlot(root, key);
    const iterated = root.iterated.has(slot);
    return (frame, compute) => {
      const cell = readMemo(frame, slot, iterated);
      if (cell) return cell.v;
      const value = compute();
      writeMemo(frame, slot, iterated ? iterationKey(frame) : undefined, new Cell(value));
      return value;
    };
  }

  private awaitSlot(root: AwaitRoot, node: object): number {
    let slot = root.slotOf.get(node);
    if (slot === undefined) {
      slot = this.fn.allocateSlot();
      this.fn.info.locals[slot] = { name: '\0', type: DYNAMIC };
      root.slots.push(slot);
      root.slotOf.set(node, slot);
      if (root.loopDepth > 0) root.iterated.add(slot);
    }
    return slot;
  }
}
