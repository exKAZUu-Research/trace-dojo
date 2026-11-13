import type { TurtleState } from '../interpreter/turtleWorld';
import type { ClassDef, Expression, FunctionDef } from './ast';
import type { DictStore } from './dictStore';
import type { Frame } from './frame';
import { asPythonError, chargeScan, chargeSlots, chargeStep, refuseOversizedString } from './runtimeContext';
import type { SetTable } from './setTable';
import { recordSubclass } from './subclasses';

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
    // Every object a program makes costs a slot here, and what it holds is charged where the storage grows, so that
    // no kind of object can be retained outside the slot limit.
    chargeSlots(1);
  }

  get identity(): number {
    if (this.identityValue === 0) this.identityValue = nextIdentity++;
    return this.identityValue;
  }
}

/** A builtin's body; `boundTo` is the object a bound method was read from, which names it in its errors. */
export type NativeFunction = (args: PyValue[], kwargs: Kwargs, boundTo?: PyValue) => PyValue;

/** How a builtin in a class dictionary binds when read from an instance. */
export type NativeBinding = 'method' | 'static' | 'class';

const checkedRuns = new WeakSet<NativeFunction>();

export class PyBuiltinFunction extends PyObject {
  readonly run: NativeFunction;
  /** The `__module__` of a module's function: the name its module has in C, such as `_functools`. */
  module?: string;

  constructor(
    cls: PyClass,
    readonly name: string,
    run: NativeFunction,
    /** The object a bound builtin method was read from, or the module a function belongs to. */
    readonly self?: PyValue,
    readonly binding: NativeBinding = 'method',
    readonly ownerName?: string
  ) {
    super(cls);
    this.run = refusingOversizedStrings(run);
  }

  get qualifiedName(): string {
    return this.ownerName ? `${this.ownerName}.${this.name}` : this.name;
  }
}

/**
 * Makes a native function refuse to return a string beyond the length limit. A function already wrapped is kept, since
 * bound methods are equal when they share their function.
 */
function refusingOversizedStrings(run: NativeFunction): NativeFunction {
  if (checkedRuns.has(run)) return run;
  const checked: NativeFunction = (args, kwargs, boundTo) => {
    let result: PyValue;
    try {
      result = run(args, kwargs, boundTo);
    } catch (error) {
      throw asPythonError(error);
    }
    refuseOversizedString(result);
    return result;
  };
  checkedRuns.add(checked);
  return checked;
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
  /** Whether CPython's library writes this class in Python, so that its methods run their bodies with any receiver. */
  isWrittenInPython = false;
  /** The feature to name when a class statement derives from this builtin class, which this grader does not support. */
  unsupportedBase?: string;
  /** The ordered annotations of the class body, which `@dataclass` reads. */
  annotationNames: string[] = [];
  readonly flags: {
    isEnum?: boolean;
    isAbstractEnum?: boolean;
    isOrderedDict?: boolean;
    /** Whether the class or a base defined `__getattribute__` in its body. */
    definesGetattribute?: boolean;
    /** Whether the class or a base defines `__del__`, whose instances the finalizer tracks. */
    definesDel?: boolean;
  } = {};
  /** The members of an Enum class, in definition order. */
  enumMembers?: PyInstance[];
  /** What `isinstance()` answers for this class, when its metaclass decides it, as a protocol's does. */
  instanceCheck?: (value: PyValue) => boolean;
  /**
   * Computes an attribute of an instance that the ordinary lookup does not find, as the `tp_getattro` of a C type such
   * as `types.GenericAlias` does, or returns undefined.
   */
  missingAttribute?: (self: PyValue, name: string) => PyValue | undefined;
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
    recordSubclass(this);
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

/** An annotation the program wrote: the name it annotates, its expression, and the frame that evaluates it. */
export interface Annotation {
  name: string;
  expression: Expression;
  frame: Frame;
  /** The value of an annotation a function such as `NamedTuple()` was given, which needs no evaluation. */
  value?: PyValue;
}

/** The annotations a class body ran, in the order of the source. */
export type ClassAnnotations = Annotation[];

/** The state of an exception that the `BaseException` layout adds to instances. */
export interface ExceptionState {
  args: PyTuple;
  /** The frames of the functions the exception left, whose variables its traceback keeps alive. */
  tracebackFrames?: { readonly locals: Map<string, PyValue>; readonly cells: Map<string, PyCell> }[];
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
  /** Whether the exception has been raised, which gives it a traceback. */
  raised?: boolean;
  /** The sub-exceptions of an exception group. */
  exceptions?: PyTuple;
  /** The traceback object of the frames the exception passed through, or None. */
  traceback?: PyValue;
  /** The file names an OSError was created with, which its `args` then leave out. */
  filename?: PyValue;
  filename2?: PyValue;
  message?: string;
  /** The fields an exception sets from its keyword arguments, such as ImportError's `path`. */
  fields?: Map<string, PyValue>;
}

/** An instance of a class written in the program, or of a builtin class with instance attributes. */
export class PyInstance extends PyObject {
  /** The instance's attributes, which assigning `__dict__` replaces. */
  dict: Map<string, PyValue> = new AttributeMap();
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

/** The attributes of an instance or opaque object, which charge the slot each new name takes. */
export class AttributeMap extends Map<string, PyValue> {
  override set(name: string, value: PyValue): this {
    if (!this.has(name)) chargeSlots(1);
    return super.set(name, value);
  }
}

/**
 * Storage charges itself: a list, tuple, deque, set, dict, or instance costs one slot when it is created, and one more
 * for each item, entry, or attribute it holds from then or gains later. The classes that own the storage charge it, so
 * that code building or growing a container neither forgets the charge nor repeats it.
 */
abstract class PyGrowableSequence extends PyObject {
  protected storage: PyValue[];

  constructor(cls: PyClass, items: PyValue[]) {
    super(cls);
    chargeSlots(items.length);
    this.storage = items;
  }

  get items(): readonly PyValue[] {
    return this.storage;
  }

  /** The items for an edit in place that overwrites, reorders, or removes them: only the methods below add items. */
  get editableItems(): PyValue[] {
    return this.storage;
  }

  append(item: PyValue): void {
    chargeSlots(1);
    this.storage.push(item);
  }

  extend(items: readonly PyValue[]): void {
    chargeSlots(items.length);
    for (const item of items) this.storage.push(item);
  }

  /** Replaces `deleteCount` items from `start` with `items`, charging the new slots and the items moved past them. */
  splice(start: number, deleteCount: number, items: readonly PyValue[]): void {
    const storage = this.editableItems;
    chargeSlots(Math.max(items.length - deleteCount, 0));
    // The items after the replaced ones move only when the length changes; nothing before them is copied.
    const tailStart = start + deleteCount;
    const shift = items.length - deleteCount;
    chargeScan(items.length + (shift === 0 ? 0 : storage.length - tailStart));
    const oldLength = storage.length;
    if (shift > 0) {
      for (let index = 0; index < shift; index++) storage.push(undefined as unknown as PyValue);
      for (let index = oldLength - 1; index >= tailStart; index--) storage[index + shift] = storage[index];
    } else if (shift < 0) {
      for (let index = tailStart; index < oldLength; index++) storage[index + shift] = storage[index];
      storage.length = oldLength + shift;
    }
    for (const [index, item] of items.entries()) storage[start + index] = item;
  }

  /** Removes `count` items from `start`, charging the items moved into their place, and returns them. */
  removeRange(start: number, count: number): PyValue[] {
    if (count === 0) return [];
    const storage = this.editableItems;
    chargeScan(storage.length - start);
    return storage.splice(start, count);
  }

  /**
   * Puts another array in place of the items at no charge and returns the previous one, for a caller that drops items
   * or lends the array out and back, as a sort does.
   */
  replaceItems(items: PyValue[]): PyValue[] {
    const previous = this.storage;
    this.storage = items;
    return previous;
  }
}

export class PyList extends PyGrowableSequence {}

export class PyTuple extends PyObject {
  /** The hash of the items, which cannot change, once something hashed them, as CPython 3.14 keeps it. */
  hash?: bigint;

  constructor(
    cls: PyClass,
    readonly items: readonly PyValue[]
  ) {
    super(cls);
    chargeSlots(items.length);
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
  /** The hash of a frozenset, which cannot change, once something hashed it, as CPython keeps it. */
  hash?: bigint;

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
  readonly dict: Map<string, PyValue> = new AttributeMap();
  name: string;
  qualifiedName: string;
  doc: PyValue | undefined;
  module: PyValue = '__main__';
  /** The type parameters written in brackets after the name, as `__type_params__` gives them. */
  typeParams: PyValue[] = [];
  /** The frame of those type parameters, where the annotations that mention them are evaluated. */
  annotationFrame?: unknown;
  /** Whether staticmethod or classmethod wrapped this function, whose first parameter is then no instance it runs on. */
  isStaticOrClassMethod = false;

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
    this.doc = def.doc;
  }
}

export class PyBoundMethod extends PyObject {
  /** A native that gives what calling the method gives, which calls run instead, as random's functions have. */
  fastCall?: PyValue;

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
  /** The modules CPython's module imported under these names, which this grader imports when first read. */
  readonly imports = new Map<string, string>();
  /** The feature to name for every attribute the module lacks, when this grader has only some of CPython's module. */
  partialFeature?: string;

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
    /** A property's `__doc__`, which programs may assign, as namedtuple does for its fields. */
    public doc?: PyValue
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
  /** The frame the generator runs in, which `gi_frame` gives. */
  frame?: unknown;

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

/**
 * A `collections.deque`. Its items start `front` places into the storage, so that taking and adding items at either
 * end, and reading one by index, costs no move of the others; reading `items` packs them first, which an operation at
 * the ends pays for only once the free places are as many as the items.
 */
export class PyDeque extends PyGrowableSequence {
  private front = 0;

  constructor(
    cls: PyClass,
    items: PyValue[],
    public maxlen: number | undefined
  ) {
    super(cls, items);
  }

  override replaceItems(items: PyValue[]): PyValue[] {
    this.pack();
    return super.replaceItems(items);
  }

  override get items(): readonly PyValue[] {
    this.pack();
    return this.storage;
  }

  override get editableItems(): PyValue[] {
    this.pack();
    return this.storage;
  }

  get length(): number {
    return this.storage.length - this.front;
  }

  /** The item at an index already checked to be within the deque, read without packing. */
  at(index: number): PyValue {
    return this.storage[this.front + index] as PyValue;
  }

  popRight(): PyValue {
    const item = this.storage.pop() as PyValue;
    if (this.length === 0) this.pack();
    return item;
  }

  popLeft(): PyValue {
    const item = this.storage[this.front] as PyValue;
    this.storage[this.front] = undefined as unknown as PyValue;
    this.front++;
    if (this.front >= this.length) this.pack();
    return item;
  }

  appendLeft(item: PyValue): void {
    chargeSlots(1);
    if (this.front === 0) this.reserveFront();
    this.front--;
    this.storage[this.front] = item;
  }

  /**
   * Rotates the items `steps` places to the right (left when negative), moving the items of the shorter side across one
   * at a time, as CPython's deque does.
   */
  rotate(steps: number): void {
    const { length } = this;
    let shift = steps;
    if (shift > length / 2) shift -= length;
    else if (shift < -length / 2) shift += length;
    for (; shift > 0; shift--) {
      chargeStep();
      const item = this.storage.pop() as PyValue;
      if (this.front === 0) this.reserveFront();
      this.front--;
      this.storage[this.front] = item;
    }
    for (; shift < 0; shift++) {
      chargeStep();
      this.storage.push(this.storage[this.front] as PyValue);
      this.storage[this.front] = undefined as unknown as PyValue;
      this.front++;
    }
    if (this.front >= this.length) this.pack();
  }

  private reserveFront(): void {
    const room = Math.max(this.storage.length, 8);
    const storage: PyValue[] = Array.from({ length: room });
    for (const item of this.storage) storage.push(item);
    this.storage = storage;
    this.front = room;
  }

  private pack(): void {
    if (this.front === 0) return;
    this.storage = this.storage.slice(this.front);
    this.front = 0;
  }
}

/** A JavaScript exception carrying a Python exception through the interpreter. */
export class PyError extends Error {
  constructor(readonly exception: PyInstance) {
    super('Python exception');
    if (exception.exception) exception.exception.raised = true;
  }
}
