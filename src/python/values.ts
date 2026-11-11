import type { TurtleState } from '../interpreter/turtleWorld';
import type { ClassDef, FunctionDef } from './ast';
import type { DictStore } from './dictStore';
import type { SetTable } from './setTable';

/**
 * A Python value. Integers are bigints, so that they have no size limit, and floats are numbers; `bool` stays a JS
 * boolean although Python's bool is a subclass of int.
 */
export type PyValue = bigint | number | string | boolean | PyObject;

/** What a native function receives: positional arguments and, if any were passed, keyword arguments in order. */
export type Kwargs = Map<string, PyValue> | undefined;

let nextIdentity = 1;

export class PyObject {
  /** A stable number standing for the object's address, which `id()` and default reprs show. */
  private identityValue = 0;
  // Assigned right after construction for the metatypes, whose own classes do not exist yet.
  cls!: PyClass;
  /** The attributes of an instance of a program's subclass of a builtin type such as list, which has no `dict`. */
  instanceDict?: Map<string, PyValue>;
  /** The values of the attributes `__slots__` declares, by name. */
  slotValues?: Map<string, PyValue>;

  constructor(cls: PyClass | undefined) {
    if (cls) this.cls = cls;
  }

  get identity(): number {
    if (this.identityValue === 0) this.identityValue = nextIdentity++;
    return this.identityValue;
  }
}

export type NativeFunction = (args: PyValue[], kwargs: Kwargs) => PyValue;

/** How a builtin in a class dictionary binds when read from an instance. */
export type NativeBinding = 'method' | 'static' | 'class';

export class PyBuiltinFunction extends PyObject {
  constructor(
    cls: PyClass,
    readonly name: string,
    readonly run: NativeFunction,
    /** The object a bound builtin method was read from, or the module a function belongs to. */
    readonly self?: PyValue,
    readonly binding: NativeBinding = 'method',
    readonly ownerName?: string
  ) {
    super(cls);
  }

  get qualifiedName(): string {
    return this.ownerName ? `${this.ownerName}.${this.name}` : this.name;
  }
}

export interface ClassLayout {
  /** The builtin base whose instances this class's instances extend, which decides how they are created. */
  base: 'object' | 'exception' | 'turtle' | 'native';
}

export class PyClass extends PyObject {
  mro: PyClass[] = [];
  readonly dict = new Map<string, PyValue>();
  module = 'builtins';
  qualifiedName: string;
  /** The name that messages of builtin code show for a type of a C extension module, such as `decimal.Decimal`. */
  typeName?: string;
  doc?: string;
  /** Creates an instance of a builtin class, as its `__new__` and `__init__` together would. */
  construct?: (cls: PyClass, args: PyValue[], kwargs: Kwargs) => PyValue;
  /** Creates an instance of `cls`, a subclass of this builtin class, as this class's `__new__` does. */
  newInstance?: (cls: PyClass, args: PyValue[], kwargs: Kwargs) => PyValue;
  layout: ClassLayout = { base: 'object' };
  isBuiltin = true;
  /** Whether a program may subclass this builtin class. */
  isBaseType = false;
  /** The ordered annotations of the class body, which `@dataclass` reads. */
  annotationNames: string[] = [];
  readonly flags: {
    isEnum?: boolean;
    isDataclass?: boolean;
    isAbstractEnum?: boolean;
    /** Whether the class or a base defined `__getattribute__` in its body. */
    definesGetattribute?: boolean;
  } = {};
  /** The members of an Enum class, in definition order. */
  enumMembers?: PyInstance[];
  /** What `isinstance()` answers for this class, when its metaclass decides it, as a protocol's does. */
  instanceCheck?: (value: PyValue) => boolean;
  /** Runs when a class deriving from this one is created, as `__init_subclass__` would. */
  subclassHook?: (cls: PyClass) => void;
  /**
   * Creates a class written with this one as its base, in place of an ordinary class, as the metaclasses of
   * `typing.NamedTuple` and `typing.TypedDict` do.
   */
  classFactory?: (
    def: ClassDef,
    namespace: Map<string, PyValue>,
    annotations: ClassAnnotations,
    keywords: Kwargs,
    bases: PyClass[]
  ) => PyClass;
  /** The names `__slots__` declares along the MRO, when instances have no `__dict__`. */
  slotNames?: Set<string>;
  /** The abstract base classes whose `register()` made this class their virtual subclass. */
  readonly registeredWith: PyClass[] = [];

  constructor(
    readonly name: string,
    public bases: PyClass[],
    metaclass?: PyClass
  ) {
    super(metaclass);
    this.qualifiedName = name;
  }

  /** Looks up an attribute along the method resolution order. */
  lookup(name: string): PyValue | undefined {
    for (const cls of this.mro) {
      const value = cls.dict.get(name);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  isSubclassOf(other: PyClass): boolean {
    if (this === other || this.mro.includes(other)) return true;
    return this.mro.some((cls) => cls.registeredWith.some((abstract) => abstract.isSubclassOf(other)));
  }
}

/** The names a class body annotates, in order, with how to evaluate each annotation. */
export type ClassAnnotations = [string, () => PyValue][];

/** The state of an exception that the `BaseException` layout adds to instances. */
export interface ExceptionState {
  args: PyTuple;
  notes?: PyList;
  cause?: PyValue;
  context?: PyValue;
  suppressContext: boolean;
  /** The name an AttributeError or NameError is about, which tracebacks use for suggestions. */
  name?: string;
  /** The object an AttributeError is about. */
  object?: PyValue;
  /** The names visible where a NameError was raised, for suggestions. */
  candidates?: string[];
  /** The instance whose attribute a NameError may have meant, as `self.name`. */
  selfValue?: PyValue;
  /** The sub-exceptions of an exception group. */
  exceptions?: PyTuple;
  message?: string;
}

/** An instance of a class written in the program, or of a builtin class with instance attributes. */
export class PyInstance extends PyObject {
  readonly dict = new Map<string, PyValue>();
  exception?: ExceptionState;
  turtle?: TurtleState;
  /** The value of an Enum member. */
  enumValue?: PyValue;
  /** The builtin value an instance of a program's subclass of int, float, or str stands for. */
  primitive?: bigint | number | string;
}

/** An instance of a number class of the standard library, such as `Fraction`, which traces show as its repr. */
export abstract class PyNumberInstance extends PyInstance {
  abstract reprText(): string;
}

export class PyList extends PyObject {
  constructor(
    cls: PyClass,
    public items: PyValue[]
  ) {
    super(cls);
  }
}

export class PyTuple extends PyObject {
  constructor(
    cls: PyClass,
    readonly items: readonly PyValue[]
  ) {
    super(cls);
  }
}

export class PyDict extends PyObject {
  constructor(
    cls: PyClass,
    readonly store: DictStore,
    /** The factory a defaultdict calls for a missing key. */
    public defaultFactory?: PyValue
  ) {
    super(cls);
  }
}

export class PySet extends PyObject {
  constructor(
    cls: PyClass,
    public table: SetTable
  ) {
    super(cls);
  }
}

export class PyRange extends PyObject {
  constructor(
    cls: PyClass,
    readonly start: bigint,
    readonly stop: bigint,
    readonly step: bigint
  ) {
    super(cls);
  }

  get length(): bigint {
    const { start, stop, step } = this;
    if (step > 0n) return stop > start ? (stop - start - 1n) / step + 1n : 0n;
    return start > stop ? (start - stop - 1n) / -step + 1n : 0n;
  }
}

export class PySlice extends PyObject {
  constructor(
    cls: PyClass,
    readonly start: PyValue,
    readonly stop: PyValue,
    readonly step: PyValue
  ) {
    super(cls);
  }
}

export class PyComplex extends PyObject {
  constructor(
    cls: PyClass,
    readonly real: number,
    readonly imag: number
  ) {
    super(cls);
  }
}

export class PyCell {
  constructor(public value?: PyValue) {}
}

export class PyFunction extends PyObject {
  readonly dict = new Map<string, PyValue>();
  name: string;
  qualifiedName: string;
  doc: PyValue;
  module: PyValue = '__main__';
  /** The type parameters written in brackets after the name, as `__type_params__` gives them. */
  typeParams: PyValue[] = [];
  /** The frame of those type parameters, where the annotations that mention them are evaluated. */
  annotationFrame?: unknown;

  // code-gauge-allow functionParameterCount 7 -- Each function field is set once at creation.
  constructor(
    cls: PyClass,
    readonly def: FunctionDef,
    readonly globals: Map<string, PyValue>,
    /** The cells of the variables this function captures, by name. */
    readonly closure: Map<string, PyCell>,
    public defaults: PyValue[],
    public keywordDefaults: Map<string, PyValue>,
    /** The class a method is defined in, which `super()` uses, filled once the class exists. */
    readonly classCell: PyCell | undefined
  ) {
    super(cls);
    this.name = def.name;
    this.qualifiedName = def.qualifiedName;
    this.doc = def.doc ?? '';
  }
}

export class PyBoundMethod extends PyObject {
  constructor(
    cls: PyClass,
    readonly self: PyValue,
    readonly fn: PyValue
  ) {
    super(cls);
  }
}

export class PyModule extends PyObject {
  /** Attributes this grader does not support, by name, with the feature to name in the error. */
  readonly unsupported = new Map<string, string>();

  constructor(
    cls: PyClass,
    readonly name: string,
    readonly dict: Map<string, PyValue>
  ) {
    super(cls);
  }
}

/** A wrapper whose class decides how it binds: staticmethod, classmethod, or property. */
export class PyDescriptor extends PyObject {
  constructor(
    cls: PyClass,
    readonly fn: PyValue,
    readonly setter?: PyValue,
    readonly deleter?: PyValue,
    readonly doc?: PyValue
  ) {
    super(cls);
  }
}

/** A `super()` object; one created with a class alone is unbound, without `self` and `selfClass`. */
export class PySuper extends PyObject {
  constructor(
    cls: PyClass,
    readonly thisClass: PyClass,
    readonly self?: PyValue,
    readonly selfClass?: PyClass
  ) {
    super(cls);
  }
}

export const DONE = Symbol('done');

/** An iterator implemented natively, such as a list iterator or the object `map()` returns. */
export class PyIterator extends PyObject {
  constructor(
    cls: PyClass,
    readonly next: () => PyValue | typeof DONE,
    /** The values this iterator keeps reachable, for garbage collection. */
    readonly holds: () => Iterable<unknown> = () => []
  ) {
    super(cls);
  }
}

/** What resumes a generator: the value its `yield` evaluates to, or the exception raised there. */
export type GeneratorInput = { value: PyValue; error?: undefined } | { error: PyError };

/** A generator object, whose frame runs until its next `yield`. */
export class PyGenerator extends PyObject {
  started = false;
  running = false;
  finished = false;

  constructor(
    cls: PyClass,
    readonly name: string,
    readonly qualifiedName: string,
    /** Runs the generator's frame until it yields or returns. */
    readonly resume: (input: GeneratorInput) => IteratorResult<PyValue, PyValue>,
    readonly holds: () => Iterable<unknown>
  ) {
    super(cls);
  }
}

/** A view of a dict's keys, values, or items. */
export class PyDictView extends PyObject {
  constructor(
    cls: PyClass,
    readonly dict: PyDict,
    readonly view: 'keys' | 'values' | 'items'
  ) {
    super(cls);
  }
}

/** An opaque value, such as a `typing` construct, that only supports being subscripted, combined, and shown. */
export class PyOpaque extends PyObject {
  constructor(
    cls: PyClass,
    readonly text: string,
    readonly data?: unknown
  ) {
    super(cls);
  }
}

/** A `collections.deque`. */
export class PyDeque extends PyObject {
  constructor(
    cls: PyClass,
    public items: PyValue[],
    public maxlen: number | undefined
  ) {
    super(cls);
  }
}

/** A JavaScript exception carrying a Python exception through the interpreter. */
export class PyError extends Error {
  constructor(readonly exception: PyInstance) {
    super('Python exception');
  }
}
