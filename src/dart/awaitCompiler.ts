import type { Expression, Span } from './ast';
import {
  AwaitRequest,
  type AwaitRoot,
  containsAwait,
  type GenEval,
  newStaging,
  rootCovers,
  runSteps,
  type Staging,
  type Step,
  suspensionStarts,
} from './awaitSteps';
import { type Compiled, CompilerBase, type Eval } from './compilerBase';
import type { Frame } from './runtime';
import { coreTypes, type DartType, DYNAMIC, flatten, interfaceType, isSubtype } from './types';
import type { Cell } from './values';

/** Whether a null-aware selector shorts the chain, reading its receiver, which a step already evaluated. */
export type ShortingTest = (frame: Frame) => boolean;

/** A compiled expression that awaits, which runs only through its generator. */
export type AwaitingCompiled = Compiled & { gen: GenEval };

/**
 * Compiles `await` and the expressions around it. A statement that awaits runs as a generator: each part of it that
 * contains an `await`, or comes before one, is lifted into a step that evaluates it into a hidden slot, waiting at its
 * `await`s, and the code that uses the part reads the slot. Nothing is evaluated twice, and the code around the parts
 * is the same as without `await`.
 */
export abstract class AwaitCompiler extends CompilerBase {
  /** The statement or loop condition being compiled whose `await`s suspend its generator, if any. */
  protected awaitRoot: AwaitRoot | undefined;
  /** Where the parts of the expression or statement being compiled are lifted, while it awaits. */
  protected staging: (Staging & { shortingTests?: () => readonly ShortingTest[] }) | undefined;

  abstract compileExpression(expression: Expression, context?: DartType): Compiled;

  /** The tests of the null-aware selectors the selector chain being compiled has passed, each true when it shorts. */
  protected abstract shortingProbe(): () => readonly ShortingTest[];

  /**
   * Compiles a part of an expression, through which every expression is compiled. In a statement that awaits, a part
   * that contains an `await` gets a generator, and a part that the expression being staged evaluates before one of
   * its `await`s, or that contains one, is lifted into a step.
   */
  protected compileStagedPart(expression: Expression, compile: () => Compiled): Compiled {
    const root = this.awaitRoot;
    const parent = this.staging;
    // The statements of a loop or switch whose header awaits are compiled inside the header's root, as their own.
    if (root?.fn !== this.fn || !rootCovers(root, expression)) return this.withoutStaging(compile);
    const awaits = containsAwait(expression);
    if (!parent) {
      return awaits ? this.error(expression, 'この位置の await は、この採点環境では使えません。') : compile();
    }
    // Only a null-aware selector before this part shorts it, so the chain is read before the part adds its own.
    const shorting = parent.shortingTests?.() ?? [];
    const own = awaits && !handlesAwaitItself(expression) ? newStaging(suspensionStarts(expression, false)) : undefined;
    if (own) Object.assign(own, { shortingTests: this.shortingProbe() });
    this.staging = own;
    let compiled: Compiled;
    try {
      compiled = compile();
    } finally {
      this.staging = parent;
    }
    if (own) compiled = withSteps(compiled, own.steps);
    if (awaits && !compiled.gen) return this.error(expression, 'この位置の await は、この採点環境では使えません。');
    const precedes = parent.awaitStarts.some((start) => start >= expression.end);
    if (!compiled.gen && !(precedes && isLiftable(compiled))) return compiled;
    // A null-aware selector earlier in the chain shorts what follows it, so its step evaluates nothing then.
    return this.lift(root, parent, compiled, shorting);
  }

  /**
   * Compiles a part of an expression that decides itself when its parts run, as a branch of `?:` does, with its own
   * steps, which the expression runs right before the part's code.
   */
  protected compileWithSteps<T>(part: unknown, compile: () => T): { result: T; steps: Step[] } {
    const staging = newStaging(suspensionStarts(part, false));
    const saved = this.staging;
    this.staging = staging;
    try {
      return { result: compile(), steps: staging.steps };
    } finally {
      this.staging = saved;
    }
  }

  /**
   * Lifts an expression that awaits into the steps of what is being staged, when it is compiled outside a part, as a
   * condition's operands are; inside a part, the part lifts it.
   */
  protected liftAwaiting(compiled: AwaitingCompiled): Compiled {
    const root = this.awaitRoot;
    const staging = this.staging;
    if (root?.fn !== this.fn || !staging) return compiled;
    return this.lift(root, staging, compiled);
  }

  /** Whether an expression awaits inside the statement being compiled, so that it must be compiled with steps. */
  protected awaitsHere(node: unknown): boolean {
    return this.awaitRoot?.fn === this.fn && containsAwait(node);
  }

  /**
   * Adds a step that computes a value of the expression being staged, such as the current value of a compound
   * assignment's target before its value awaits, to the steps lifted so far, giving what reads the step's value.
   */
  protected addStep(run: Eval): Eval | undefined {
    const root = this.awaitRoot;
    const staging = this.staging;
    if (root?.fn !== this.fn || !staging) return undefined;
    return this.lift(root, staging, { type: DYNAMIC, run, isConst: false }).run;
  }

  protected compileAwait(expression: Extract<Expression, { kind: 'await' }>, context: DartType | undefined): Compiled {
    this.requireAsyncBody(expression, 'await');
    const root = this.awaitRoot;
    // A late variable's initializer runs when it is first read, outside the statement that can suspend.
    if (root?.fn !== this.fn || !rootCovers(root, expression))
      return this.error(expression, 'ここでは await を使えません。');
    const operandContext =
      context && context.kind !== 'dynamic' ? interfaceType(coreTypes.futureOr, [context]) : undefined;
    const { result: operand, steps } = this.compileWithSteps(expression.value, () =>
      this.compileExpression(expression.value, operandContext)
    );
    if (operand.type.kind === 'void') this.error(expression.value, 'void の値は、式の中では使えません。');
    const type = flatten(operand.type);
    // The VM awaits a future whose static type is not a Future only when it is a Future<flatten(T)>, as its
    // `_awaitWithTypeCheck` checks, so that `await t` with `T t` keeps a Future that T stands for.
    const awaitedType = isSubtype(operand.type, interfaceType(coreTypes.future, [DYNAMIC]))
      ? undefined
      : this.runtimeType(interfaceType(coreTypes.future, [type]));
    const { run } = operand;
    return awaitingCompiled(type, function* (frame) {
      yield* runSteps(frame, steps);
      const value = run(frame);
      const { runtime } = frame;
      const isNotFuture = awaitedType !== undefined && !runtime.links.isValueOf(runtime, value, awaitedType(frame));
      return yield new AwaitRequest(value, isNotFuture);
    });
  }

  /**
   * Checks a deferred prefix before the steps of an expression that reads it and awaits, which run before the
   * expression's own code: the SDK reads the prefix before it evaluates the arguments.
   */
  protected checkLoadedFirst(prefix: string, node: unknown): void {
    if (!this.library.deferredPrefixes.has(prefix) || !this.awaitsHere(node)) return;
    this.addStep((frame) => {
      if (!frame.runtime.loadedPrefixes.has(prefix)) frame.runtime.throwError('_DeferredNotLoadedError', '', [prefix]);
      return;
    });
  }

  protected loadedOnlyIfPrefixed(prefix: string | undefined, compile: () => Compiled): Compiled {
    const compiled = compile();
    return prefix ? this.loadedOnly(prefix, compiled) : compiled;
  }

  /** What a prefix of a `deferred as` import reaches, which fails until its library is loaded. */
  protected loadedOnly(prefix: string, compiled: Compiled): Compiled {
    if (!this.library.deferredPrefixes.has(prefix)) return compiled;
    const { run } = compiled;
    return {
      ...compiled,
      isConst: false,
      constValue: undefined,
      run: (frame) => {
        if (!frame.runtime.loadedPrefixes.has(prefix))
          frame.runtime.throwError('_DeferredNotLoadedError', '', [prefix]);
        return run(frame);
      },
    };
  }

  /** The value, lifted into a step when an await that starts within or after `span` waits after it. */
  protected liftBeforeLaterAwait(compiled: Compiled, span: Span): Compiled {
    const staging = this.staging;
    if (compiled.gen || !isLiftable(compiled) || !staging?.awaitStarts.some((start) => start >= span.start)) {
      return compiled;
    }
    const read = this.addStep(compiled.run);
    return read ? { ...compiled, run: read } : compiled;
  }

  private withoutStaging<T>(compile: () => T): T {
    const saved = this.staging;
    this.staging = undefined;
    try {
      return compile();
    } finally {
      this.staging = saved;
    }
  }

  private lift(
    root: AwaitRoot,
    staging: Staging,
    compiled: Compiled,
    shorting: readonly ShortingTest[] = []
  ): Compiled {
    const slot = this.fn.allocateSlot();
    this.fn.info.locals[slot] = { name: '\0', type: DYNAMIC };
    root.slots.push(slot);
    const skipIf = shorting.length > 0 ? (frame: Frame) => shorting.some((test) => test(frame)) : undefined;
    staging.steps.push({ slot, run: compiled.gen ? undefined : compiled.run, gen: compiled.gen, skipIf });
    return { ...compiled, gen: undefined, run: (frame) => (frame.locals[slot] as Cell).v };
  }
}

/** A compiled expression that awaits, with the generator that evaluates it. */
export function awaitingCompiled(type: DartType, gen: GenEval, extra?: Partial<Compiled>): AwaitingCompiled {
  return { ...extra, type, isConst: false, gen, run: runsThroughGenerator };
}

function runsThroughGenerator(): never {
  throw new Error('An expression that awaits runs only through its generator.');
}

function withSteps(compiled: Compiled, steps: readonly Step[]): Compiled {
  if (steps.length === 0) return compiled;
  const { run } = compiled;
  return {
    ...compiled,
    *gen(frame: Frame) {
      yield* runSteps(frame, steps);
      return run(frame);
    },
  };
}

/**
 * Whether an expression decides itself when its parts that await run, because it evaluates some of them only on a
 * condition or in a loop, instead of having each part lifted in order.
 */
function handlesAwaitItself(expression: Expression): boolean {
  switch (expression.kind) {
    case 'await':
    case 'conditional':
    case 'list':
    case 'setOrMap':
    case 'switch':
    case 'cascade': {
      return true;
    }
    case 'binary': {
      return expression.operator === '&&' || expression.operator === '||' || expression.operator === '??';
    }
    case 'assign': {
      return expression.operator === '??=';
    }
    default: {
      return false;
    }
  }
}

/** Whether a part's value can change between its evaluation and an `await` after it, so that it must be lifted. */
function isLiftable(compiled: Compiled): boolean {
  return !compiled.isConst && !compiled.isSuper && !compiled.thisReference && !compiled.extensionOverride;
}
