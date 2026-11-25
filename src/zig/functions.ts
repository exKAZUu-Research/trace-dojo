import type { CompileError } from '../interpreter/diagnostics';
import type { Span } from './ast';
import type { Frame } from './runtime';
import type { SemaApi } from './semaBase';
import type { Type } from './types';
import type { Value } from './values';

/** A local variable or parameter, as the trace shows it. */
export interface LocalInfo {
  name: string;
  slot: number;
  type: Type;
  /** Whether the local is a method's receiver, whose fields also show as `self.x`, as Java shows `this.x`. */
  isReceiver: boolean;
}

/** A function compiled for one set of argument types (a generic function has one instance per set). */
export class FunctionInstance {
  identity?: object;
  slotCount = 0;
  readonly locals: LocalInfo[] = [];
  /** The slots that receive the arguments, in order. */
  paramSlots: number[] = [];
  /** Runs the body in a frame whose parameters are bound, returning the function's value. */
  body: ((frame: Frame) => Value) | undefined;
  /** Whether `// atomic` marks the function, so that its calls count as part of the caller's step. */
  isAtomic = false;
  /** Whether the function records steps, which only a traced program's functions do. */
  recordsSteps = false;
  internal = false;
  state: 'pending' | 'compiling' | 'compiled' = 'pending';
  /** Whether the program, not only the compiler, runs the function, which Zig analyzes on every branch then. */
  runsAtRuntime = false;
  /** A `@compileError` on a branch that only the analysis for the program's calls reaches, which such a call reports. */
  pendingCompileError?: CompileError;
  /** The functions that the body calls outside compile-time code, which the program runs when it runs this one. */
  readonly runtimeCallees = new Set<FunctionInstance>();
  /** Whether the function's name marks it as one that creates an object, as Java's constructors do. */
  readonly createsObject: boolean;

  constructor(
    readonly name: string,
    readonly params: readonly Type[],
    public returnType: Type,
    /** A function the grader implements natively. */
    readonly native?: (args: Value[], frame: Frame) => Value,
    readonly analyze?: (sema: SemaApi, span: Span) => void
  ) {
    this.createsObject = name === 'init' || name.startsWith('init');
    if (native) this.state = 'compiled';
  }
}
