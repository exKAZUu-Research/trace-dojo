import type { TracedFrame } from '../interpreter/traceRecorder';
import type { ScopeInfo } from './ast';
import type { Annotation, PyCell, PyFunction, PyValue } from './values';

/** The variables of a running module, class body, or function call. */
export class Frame implements TracedFrame {
  readonly temporaries: PyValue[] = [];
  /** How many native calls were running when the frame last started or resumed running. */
  nativeCalls = 0;
  /** The annotations a module or class body ran, in the order of the source, which its `__annotate__` evaluates. */
  readonly annotations: Annotation[] = [];
  /** How many `try` and `with` statements a generator's frame is inside, where closing it runs code. */
  protectedDepth = 0;
  /** The frame an inlined (list, set, or dict) comprehension runs within, whose names CPython's frame shares. */
  inlinedIn?: Frame;
  /**
   * The row that last resumed a generator expression's frame, which tracebacks and warnings show for its caller. It is
   * not a `callRow`, since a trace counts no call for a generator expression.
   */
  resumeRow?: number;
  /** What a generator expression's frame holds as its first argument: the iterator of its first iterable. */
  firstArgument?: PyValue;
  /** The `__builtins__` binding captured when the frame or its function was created, or `undefined` when absent. */
  builtins: PyValue | undefined;

  // code-gauge-allow functionParameterCount 9 -- Each frame field is set once at creation and read on every name access.
  constructor(
    readonly kind: ScopeInfo['kind'],
    /** The function's variables, the class namespace, or the module's globals. */
    readonly locals: Map<string, PyValue>,
    /** The cells of the variables nested functions capture, and of those this frame captured. */
    readonly cells: Map<string, PyCell>,
    readonly globals: Map<string, PyValue>,
    public callRow: number | undefined,
    readonly isAtomic: boolean,
    readonly scope: ScopeInfo,
    readonly fn?: PyFunction,
    /** The class a method's `super()` refers to. */
    readonly classCell?: PyCell
  ) {
    this.builtins = fn ? fn.builtins : globals.has('__builtins__') ? globals.get('__builtins__') : undefined;
  }

  clearLocals(): (PyValue | undefined)[] {
    const dropped = this.localValues();
    this.locals.clear();
    this.cells.clear();
    this.temporaries.length = 0;
    return dropped;
  }

  localValues(): (PyValue | undefined)[] {
    const values: (PyValue | undefined)[] = [
      ...this.temporaries.toReversed(),
      ...[...this.cells.values()].map((cell) => cell.value),
    ];
    const listed = new Set(this.scope.locals);
    for (const [name, value] of this.locals) if (!listed.has(name)) values.push(value);
    for (let index = this.scope.locals.length - 1; index >= 0; index--) {
      const value = this.locals.get(this.scope.locals[index] as string);
      if (value !== undefined) values.push(value);
    }
    return values;
  }

  /** The name of the module whose code runs here: `__main__` for the program. */
  get moduleName(): string {
    const name = this.globals.get('__name__');
    return typeof name === 'string' ? name : '__main__';
  }
}
