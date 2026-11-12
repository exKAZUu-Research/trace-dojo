import type { TracedFrame } from '../interpreter/traceRecorder';
import type { Expression, ScopeInfo } from './ast';
import type { PyCell, PyFunction, PyValue } from './values';

/** An annotation of a class body: its name, how to evaluate it, and its expression when the program wrote one. */
export type AnnotationThunk = [name: string, evaluate: () => PyValue, expression?: Expression];

/** The variables of a running module, class body, or function call. */
export class Frame implements TracedFrame {
  readonly temporaries: PyValue[] = [];
  /** How many native calls were running when the frame last started or resumed running. */
  nativeCalls = 0;
  /** The names a class body annotates, in order, which `@dataclass` reads. */
  readonly annotations: AnnotationThunk[] = [];
  /** The frame an inlined (list, set, or dict) comprehension runs within, whose names CPython's frame shares. */
  inlinedIn?: Frame;
  /** What a bound method's call passed as the first argument, which a method of an instance shows like Java's `this`. */
  receiver?: PyValue;

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
  ) {}
}
