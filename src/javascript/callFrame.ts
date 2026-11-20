import { hasLegacyFunctionProperties } from './argumentsObject';
import type { ValueIterator } from './iteration';
import { appendAll, type JsFunction, type Scope, type Value } from './values';

export class Frame {
  /** Values a pending call or allocation holds outside any variable, which must keep their turtles alive. */
  readonly temporaries: Value[] = [];
  /** The unfinished iterations the frame runs, which stay reachable as long as the frame can still resume them. */
  readonly iterations = new Set<ValueIterator>();
  /** How many builtins run in the frame now, which keep what the program's code returns to them in its temporaries. */
  builtinsRunning = 0;
  nativeCallerDepth = 0;
  readonly legacyArguments: Value[] | undefined;

  constructor(
    public scope: Scope,
    /** The row of the call that created this frame, or undefined for the program and implicit calls. */
    readonly callRow: number | undefined,
    /** Whether this frame runs a function marked `// atomic`. */
    readonly isAtomic: boolean,
    readonly callee?: JsFunction,
    args?: Value[]
  ) {
    this.legacyArguments = hasLegacyFunctionProperties(callee) ? args : undefined;
  }

  enterBuiltin(forwardsCaller = false): void {
    this.builtinsRunning++;
    if (!forwardsCaller) this.nativeCallerDepth++;
  }

  leaveBuiltin(forwardsCaller = false): void {
    this.builtinsRunning--;
    if (!forwardsCaller) this.nativeCallerDepth--;
  }

  /** What the frame keeps reachable: its scope, its temporaries, and its unfinished iterations' roots. */
  reachableValues(): unknown[] {
    const values: unknown[] = [this.scope, ...this.temporaries];
    if (this.callee) values.push(this.callee);
    if (this.legacyArguments) appendAll(values, this.legacyArguments);
    for (const iteration of this.iterations) appendAll(values, iteration.roots);
    return values;
  }
}
