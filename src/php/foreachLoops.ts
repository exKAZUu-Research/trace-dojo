// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { ArrayCursor } from './arrayOrder';
import { assignTo, bindRef, destructure } from './assignment';
import type { Stmt } from './ast';
import { consumeInvokedResult } from './callables';
import { propNameOf, propRef, readProp, visiblePropertyKeys } from './classes';
import { valueName } from './conversions';
import { warn, withPendingException } from './errors';
import { GeneratorState } from './generators';
import { acquireIterator, InnerIterator } from './iteratorAcquisition';
import { compiledOperandRow } from './opcodeRows';
import { ElementPlace, RefPlace, share, VarPlace, writableContainer } from './places';
import { type Frame, PhpThrow, rt } from './runtime';
import { deref, type Key, PhpArray, type PhpClass, PhpObject, type Ref, UNDEFINED_RESULT, type Value } from './values';

/**
 * One `foreach` loop over something other than an array by value, which runs on the block stack so that a generator
 * can suspend inside its body.
 */
export interface LoopDriver {
  readonly body: Stmt[];
  /** Moves to the next iteration and binds the loop's variables, telling whether there is one. */
  advance(first: boolean): boolean;
  /** Lets go of what the loop holds once it ends, normally or by `error`. */
  close(error?: unknown): void;
}

export class SubjectLoop implements LoopDriver {
  constructor(
    private readonly inner: LoopDriver,
    private readonly frame: Frame
  ) {}

  get body(): Stmt[] {
    return this.inner.body;
  }

  advance(first: boolean): boolean {
    return this.inner.advance(first);
  }

  close(error?: unknown): void {
    try {
      this.inner.close(error);
    } finally {
      this.frame.foreachSubjects.pop();
    }
  }
}

export function objectLoop(
  statement: Extract<Stmt, { k: 'foreach' }>,
  object: PhpObject,
  byRef: boolean,
  releaseSubject?: () => void
): LoopDriver {
  const runtime = rt();
  runtime.row = statement.subjectEndRow;
  const acquired = acquireIterator(object, byRef);
  if (!acquired) return new PropertyLoop(statement, object);
  const { iterator, handle } = acquired;
  try {
    const inner =
      byRef && iterator.internal instanceof GeneratorState
        ? new GeneratorReferenceLoop(statement, iterator.internal)
        : byRef
          ? new StorageReferenceLoop(statement, iterator.internal as NativeForeachStorage)
          : new IteratorLoop(statement, new InnerIterator(iterator, handle), releaseSubject);
    return new IteratorHandleLoop(inner, handle);
  } catch (error) {
    withPendingException(runtime, error instanceof PhpThrow ? error : undefined, () =>
      runtime.discardNativeResult(handle, Infinity, 0)
    );
    throw error;
  }
}

/** Frees the iterator PHP's engine made for a loop once the loop ends. */
class IteratorHandleLoop implements LoopDriver {
  constructor(
    private readonly inner: LoopDriver,
    private readonly handle: PhpObject
  ) {}

  get body(): Stmt[] {
    return this.inner.body;
  }

  advance(first: boolean): boolean {
    return this.inner.advance(first);
  }

  close(error?: unknown): void {
    const runtime = rt();
    withPendingException(runtime, error instanceof PhpThrow ? error : undefined, () =>
      runtime.discardNativeResult(this.handle, Infinity, 0)
    );
  }
}

class PropertyLoop implements LoopDriver {
  private readonly keys: Iterator<string>;
  private readonly scope: PhpClass | undefined;

  constructor(
    private readonly statement: Extract<Stmt, { k: 'foreach' }>,
    private readonly object: PhpObject
  ) {
    this.scope = rt().frame.scope;
    this.keys = visiblePropertyKeys(object, this.scope, true)[Symbol.iterator]();
  }

  get body(): Stmt[] {
    return this.statement.body;
  }

  advance(): boolean {
    const next = this.keys.next();
    if (next.done) return false;
    const name = propNameOf(next.value);
    bindForeachValue(this.statement, name, readProp(this.object, name, this.scope, 'quiet'));
    return true;
  }

  close(): void {}
}

class IteratorLoop implements LoopDriver {
  constructor(
    private readonly statement: Extract<Stmt, { k: 'foreach' }>,
    private readonly iterator: InnerIterator,
    private readonly releaseSubject: (() => void) | undefined
  ) {}

  get body(): Stmt[] {
    return this.statement.body;
  }

  advance(first: boolean): boolean {
    const runtime = rt();
    let valid: boolean;
    if (first) {
      this.iterator.rewind();
      valid = this.iterator.valid();
      this.releaseSubject?.();
    } else {
      runtime.row = this.statement.subjectEndRow;
      this.iterator.next();
      valid = this.iterator.valid();
    }
    if (!valid) return false;
    runtime.spend();
    const slot = this.iterator.currentSlot();
    if (this.statement.key) {
      consumeInvokedResult(
        () => this.iterator.key(),
        (key) => bindForeachValue(this.statement, key, deref(slot))
      );
    } else bindForeachValue(this.statement, null, deref(slot));
    return true;
  }

  close(): void {}
}

interface NativeForeachStorage {
  cursor(): ArrayCursor;
  writable(): PhpArray;
}

class StorageReferenceLoop implements LoopDriver {
  constructor(
    private readonly statement: Extract<Stmt, { k: 'foreach' }>,
    private readonly storage: NativeForeachStorage
  ) {}

  get body(): Stmt[] {
    return this.statement.body;
  }

  advance(first: boolean): boolean {
    const runtime = rt();
    if (first) this.storage.cursor().rewind();
    else this.storage.cursor().next();
    for (;;) {
      const key = this.storage.cursor().key;
      if (key === undefined) return false;
      runtime.spend();
      const array = this.storage.writable();
      if (array.map.get(key) !== UNDEFINED_RESULT) {
        bindForeachElement(this.statement, array, key);
        return true;
      }
      this.storage.cursor().next();
    }
  }

  close(): void {}
}

/** A by-reference loop over a generator that yields by reference, which binds what each `yield` refers to. */
class GeneratorReferenceLoop implements LoopDriver {
  constructor(
    private readonly statement: Extract<Stmt, { k: 'foreach' }>,
    private readonly generator: GeneratorState
  ) {}

  get body(): Stmt[] {
    return this.statement.body;
  }

  advance(first: boolean): boolean {
    const runtime = rt();
    if (first) this.generator.rewind();
    else {
      runtime.row = this.statement.subjectEndRow;
      this.generator.next();
    }
    if (!this.generator.valid()) return false;
    runtime.spend();
    bindForeachRef(this.statement, this.generator.currentRef());
    if (this.statement.key) assignTo(this.statement.key, this.generator.currentKey());
    runtime.steps.stepBinding(this.statement.row, true);
    return true;
  }

  close(): void {}
}

const FOREACH_REPLACED = Symbol();

/**
 * A by-reference loop, which goes on over whatever array or object the subject holds when its body replaces it, and
 * hands an initial Traversable over to its iterator.
 */
export class ReferenceLoop implements LoopDriver {
  private array?: { current: PhpArray; cursor: ArrayCursor };
  private properties?: { object: PhpObject; keys: Iterator<string>; started: boolean };
  private inner?: LoopDriver;
  private innerStarted = false;
  private readonly scope: PhpClass | undefined;

  constructor(
    private readonly statement: Extract<Stmt, { k: 'foreach' }>,
    private readonly initial: PhpArray | PhpObject,
    private readonly reference: Ref
  ) {
    this.scope = rt().frame.scope;
  }

  get body(): Stmt[] {
    return this.statement.body;
  }

  advance(): boolean {
    for (;;) {
      if (this.inner) {
        const first = !this.innerStarted;
        this.innerStarted = true;
        return this.inner.advance(first);
      }
      if (this.array) {
        const result = this.advanceArray(this.array);
        if (result !== FOREACH_REPLACED) return result;
        this.array.cursor.close();
        this.array = undefined;
      } else if (this.properties) {
        const result = this.advanceProperties(this.properties);
        if (result !== FOREACH_REPLACED) return result;
        this.properties = undefined;
      }
      if (!this.select()) return false;
    }
  }

  close(error?: unknown): void {
    this.array?.cursor.close();
    this.inner?.close(error);
  }

  private select(): boolean {
    const container = this.reference.v;
    if (container instanceof PhpArray) {
      const array = writableContainer(new RefPlace(this.reference), container) as PhpArray;
      this.array = { current: array, cursor: array.foreachCursor() };
      return true;
    }
    if (container instanceof PhpObject && !container.isResource) {
      if (container.cls.isSubclassOf(rt().classes.get('traversable') as PhpClass)) {
        if (container !== this.initial) return false;
        this.inner = objectLoop(this.statement, container, true);
        return true;
      }
      const keys = visiblePropertyKeys(container, this.scope, true)[Symbol.iterator]();
      this.properties = { object: container, keys, started: false };
      return true;
    }
    warnForeachSubject(this.statement, container);
    return false;
  }

  private advanceArray(state: { current: PhpArray; cursor: ArrayCursor }): boolean | typeof FOREACH_REPLACED {
    const runtime = rt();
    for (;;) {
      const next = this.reference.v;
      if (next !== state.current) {
        if (!(next instanceof PhpArray)) return FOREACH_REPLACED;
        state.current = writableContainer(new RefPlace(this.reference), next) as PhpArray;
        state.cursor = state.current.foreachCursor(state.cursor);
      }
      const key = state.cursor.key;
      if (key === undefined) return false;
      runtime.spend();
      state.cursor.next();
      if (state.current.map.get(key) === UNDEFINED_RESULT) continue;
      bindForeachElement(this.statement, state.current, key);
      return true;
    }
  }

  private advanceProperties(state: {
    object: PhpObject;
    keys: Iterator<string>;
    started: boolean;
  }): boolean | typeof FOREACH_REPLACED {
    if (state.started && this.reference.v !== state.object) return FOREACH_REPLACED;
    state.started = true;
    const next = state.keys.next();
    if (next.done) return false;
    const name = propNameOf(next.value);
    const ref = propRef(state.object, name, this.scope, 'foreach');
    bindForeachRef(this.statement, ref);
    if (this.statement.key) assignTo(this.statement.key, name);
    rt().steps.stepBinding(this.statement.row, true);
    return true;
  }
}

export function warnForeachSubject(statement: Extract<Stmt, { k: 'foreach' }>, value: Value | undefined): undefined {
  rt().row = statement.subject.row;
  warn(`foreach() argument must be of type array|object, ${valueName(value ?? null)} given`);
  return undefined;
}

export function bindForeachValue(statement: Extract<Stmt, { k: 'foreach' }>, key: Key | Value, value: Value): void {
  const runtime = rt();
  runtime.row = statement.row;
  if (statement.value.k === 'list')
    destructure(statement.value, value, undefined, compiledOperandRow(statement.subject));
  else assignTo(statement.value, share(value));
  if (statement.key) assignTo(statement.key, key as Value);
  runtime.steps.stepBinding(statement.row, statement.value.k === 'list' || storesAnswer(value));
}

/** Whether a foreach binding stores a value learners answer, as Java's primitives and strings are. */
function storesAnswer(value: Value): boolean {
  return value !== null && !(value instanceof PhpObject) && !(value instanceof PhpArray);
}

function bindForeachRef(statement: Extract<Stmt, { k: 'foreach' }>, ref: Ref): void {
  const target = statement.value;
  if (target.k === 'list') destructure(target, ref.v, new RefPlace(ref), compiledOperandRow(statement.subject));
  else if (target.k === 'var') new VarPlace(rt().frame, target.name).bind(ref);
  else bindRef(target, ref);
}

function bindForeachElement(statement: Extract<Stmt, { k: 'foreach' }>, array: PhpArray, key: Key): void {
  bindForeachRef(statement, new ElementPlace(array, key).ref());
  if (statement.key) assignTo(statement.key, key);
  rt().steps.stepBinding(statement.row, true);
}
