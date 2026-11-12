import type { TracedFrame } from '../interpreter/traceRecorder';
import type { ScopeInfo } from './ast';
import type { PyCell, PyFunction, PyValue } from './values';

/** The variables of a running module, class body, or function call. */
export class Frame implements TracedFrame {
  readonly temporaries: PyValue[] = [];
  /** The names a class body annotates, in order, which `@dataclass` reads. */
  readonly annotations: [string, () => PyValue][] = [];
  /** The frame an inlined (list, set, or dict) comprehension runs within, whose names CPython's frame shares. */
  inlinedIn?: Frame;

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
