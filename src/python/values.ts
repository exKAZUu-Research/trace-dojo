import type { TurtleState } from '../interpreter/turtleWorld';
import type { ClassDef, FunctionDef } from './ast';
import type { DictStore } from './dictStore';
import type { Frame } from './frame';
import { asPythonError, chargeSlots, refuseOversizedString } from './runtimeContext';
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

export type NativeFunction = (args: PyValue[], kwargs: Kwargs) => PyValue;

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
  const checked: NativeFunction = (args, kwargs) => {
    let result: PyValue;
    try {
      result = run(args, kwargs);
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
  /** The name error messages give the type, which C types of standard library modules prefix with the module. */
  tpName?: string;
  doc?: string;
  /** Creates an instance of a builtin class, as its `__new__` and `__init__` together would. */
  construct?: (cls: PyClass, args: PyValue[], kwargs: Kwargs) => PyValue;
  layout: ClassLayout = { base: 'object' };
  isBuiltin = true;
  /** Whether a program may subclass this builtin class. */
  isBaseType = false;
  /** Whether CPython's library writes this class in Python, so that its methods run their bodies with any receiver. */
  isWrittenInPython = false;
  /** The ordered annotations of the class body, which `@dataclass` reads. */
  annotationNames: string[] = [];
  /** The `__annotations__` a program read or assigned, which later reads return as it is. */
  annotations?: PyValue;
  readonly flags: { isEnum?: boolean; isAbstractEnum?: boolean } = {};
  /** The members of an Enum class, in definition order. */
  enumMembers?: PyInstance[];
  /** The names `dir()` lists for an instance of this class, when its `__dir__` differs from object's. */
  dirNames?: (self: PyValue) => Iterable<string>;
  /** Binds an instance of this builtin class read from a class, as its `__get__` would, such as a partial's. */
  nativeGet?: (self: PyObject, instance: PyValue, owner: PyClass) => PyValue;
  /** Reads the attributes this builtin class's opaque instances have of their own, such as an alias's `__origin__`. */
  opaqueAttribute?: (self: PyOpaque, name: string) => PyValue | undefined;
  /**
   * Decides `issubclass(cls, self)` for an instance of this class given to isinstance() or issubclass() as the class,
   * as a metaclass's `__subclasscheck__` does.
   */
  subclassCheck?: (self: PyValue, cls: PyClass, caller: 'isinstance' | 'issubclass') => boolean;
  /** The state `abc.ABCMeta` keeps for an abstract base class: the classes registered as its virtual subclasses. */
  abc?: { registry: PyClass[] };
  definition?: ClassDef;

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
    return this === other || this.mro.includes(other);
  }
}

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
  /** Whether the exception has been raised, which gives it a traceback. */
  raised?: boolean;
  /** The values of the fields some exception types keep, such as StopIteration's value, once assigned. */
  fields?: Map<string, PyValue>;
  message?: string;
}

/** An instance of a class written in the program, or of a builtin class with instance attributes. */
export class PyInstance extends PyObject {
  readonly dict: Map<string, PyValue> = new AttributeMap();
  exception?: ExceptionState;
  turtle?: TurtleState;
  /** The value of an Enum member. */
  enumValue?: PyValue;

  constructor(cls: PyClass | undefined) {
    super(cls);
  }
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

  /** Puts `items` in place of the `deleteCount` items from `start`, charging the items the sequence gains. */
  splice(start: number, deleteCount: number, items: readonly PyValue[]): void {
    chargeSlots(Math.max(items.length - deleteCount, 0));
    if (items.length === 1) this.storage.splice(start, deleteCount, items[0]);
    else this.storage = [...this.storage.slice(0, start), ...items, ...this.storage.slice(start + deleteCount)];
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
  /** The docstring, undefined when the function has none. */
  doc: PyValue | undefined;
  module = '__main__';
  /** The frame of the `def`, whose variables the annotations are evaluated with when a program reads them. */
  definingFrame?: Frame;
  /** The `__annotations__` a program read or assigned, which later reads return as it is. */
  annotations?: PyDict;
  /** The `__annotate__` and `__type_params__` a program assigned. */
  annotate?: PyValue;
  typeParams?: PyValue;

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
  /** Attributes created when first read, such as those standard library code written in Python defines. */
  readonly lazy = new Map<string, () => PyValue>();
  /** Attributes `dir()` does not list, such as those CPython's module `__getattr__` gives. */
  readonly hidden = new Set<string>();

  constructor(
    cls: PyClass,
    readonly name: string,
    readonly dict: Map<string, PyValue>
  ) {
    super(cls);
  }

  /** Reads an attribute, creating it first if it is lazy. */
  attribute(name: string): PyValue | undefined {
    const value = this.dict.get(name);
    if (value !== undefined) return value;
    const create = this.lazy.get(name);
    if (create === undefined) return undefined;
    this.lazy.delete(name);
    const created = create();
    this.dict.set(name, created);
    return created;
  }

  /** The names of the module's attributes, including lazy ones not read yet. */
  names(): string[] {
    return [...this.dict.keys(), ...this.lazy.keys(), ...this.unsupported.keys()].filter(
      (name) => !this.hidden.has(name)
    );
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

export class PySuper extends PyObject {
  constructor(
    cls: PyClass,
    readonly thisClass: PyClass,
    readonly self: PyValue,
    readonly selfClass: PyClass
  ) {
    super(cls);
  }
}

export const DONE = Symbol('done');

/** An iterator implemented natively, such as a list iterator or the object `map()` returns. */
export class PyIterator extends PyObject {
  /** How many items are left, which `__length_hint__` gives for the iterators of sized containers. */
  lengthHint?: () => number;

  constructor(
    cls: PyClass,
    readonly next: () => PyValue | typeof DONE,
    /** The values this iterator keeps reachable, for garbage collection. */
    readonly holds: () => Iterable<unknown> = () => []
  ) {
    super(cls);
  }
}

/** A generator object, whose frame runs until its next `yield`. */
export class PyGenerator extends PyObject {
  started = false;
  running = false;
  finished = false;

  constructor(
    cls: PyClass,
    readonly name: string,
    readonly qualifiedName: string,
    readonly resume: () => IteratorResult<PyValue, PyValue>,
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
  /** The attributes of an opaque object that has a `__dict__`, such as an lru_cache wrapper. */
  attributes?: AttributeMap;

  constructor(
    cls: PyClass,
    readonly text: string,
    readonly data?: unknown
  ) {
    super(cls);
  }
}

/** A `collections.deque`. */
/**
 * A `collections.deque`. Its items start `front` places into the storage, so that taking and adding items at the left
 * end costs no move of the others; reading `items` packs them first, which a left-end operation pays for only once
 * the free places are as many as the items.
 */
export class PyDeque extends PyGrowableSequence {
  private front = 0;

  constructor(
    cls: PyClass,
    items: PyValue[],
    readonly maxlen: number | undefined
  ) {
    super(cls, items);
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
