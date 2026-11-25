// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { Stmt } from './ast';
import { nestedBodies } from './astAnalysis';
import { type CallRecord, implicitCallRow, releaseGeneratorFrame, runInFrame } from './calls';
import { throwError } from './errors';
import type { YieldRequest } from './generatorSteps';
import { type Frame, PhpThrow, rt } from './runtime';
import { type ExecState, newExecState, type Resumption, runBlocks, SUSPENDED } from './statements';
import { deref, nativeOwnershipChanged, type PhpObject, Ref, type Value } from './values';

// Generator objects ------------------------------------------------------------------------------------------------

type GeneratorStatus = 'created' | 'suspended' | 'running' | 'finished';

/** The state of a Generator object: the frame of its function's call and where the body stopped. */
export class GeneratorState {
  status: GeneratorStatus = 'created';
  key: Value = null;
  value: Value | Ref = null;
  /** The value the body returned, once it returned rather than threw. */
  returned?: { v: Value };
  private readonly exec: ExecState;
  private largestKey = -1n;
  /** Whether the generator was destroyed before finishing, leaving its frame for the release of its object. */
  private destroyed = false;
  private readonly hasFinally: boolean;
  /** Whether the generator has stopped at its first `yield` and not moved on, so that it can still rewind. */
  private atFirstYield = false;
  /** Whether the generator has a current value, which it gets at its first `yield` and loses when it finishes. */
  private hasYielded = false;

  constructor(
    private readonly object: PhpObject,
    private readonly frame: Frame,
    private readonly record: CallRecord
  ) {
    const decl = frame.decl;
    if (!decl) throw new Error('A generator needs a user function');
    const body: Stmt[] = decl.arrowBody
      ? [{ k: 'return', e: decl.arrowBody, row: decl.arrowBody.row, suspends: true }]
      : decl.body;
    this.exec = newExecState(body);
    // A generator that may stop inside `finally` has cleanup to run when PHP destroys it, as a destructor does.
    this.hasFinally = body.some(containsFinally);
    if (this.hasFinally) rt().destructibles++;
  }

  isFinished(): boolean {
    return this.status === 'finished';
  }

  get byReference(): boolean {
    return this.frame.decl?.byRefReturn === true;
  }

  ensureInitialized(): void {
    if (this.hasYielded || this.status === 'finished') return;
    this.resume();
    this.atFirstYield = true;
  }

  engineIteration(method: 'rewind' | 'valid' | 'current' | 'key' | 'next'): Value {
    switch (method) {
      case 'rewind': {
        this.rewind();
        return null;
      }
      case 'valid': {
        return this.valid();
      }
      case 'current': {
        return this.current();
      }
      case 'key': {
        return this.currentKey();
      }
      case 'next': {
        this.next();
        return null;
      }
    }
  }

  /** Checks what PHP's engine checks before a `foreach` iterates the generator. */
  beforeEngineIteration(byRef: boolean): void {
    if (this.status === 'finished') throwError('Exception', 'Cannot traverse an already closed generator');
    if (byRef && !this.byReference)
      throwError(
        'Exception',
        'You can only iterate a generator by-reference if it declared that it yields by-reference'
      );
  }

  /** The value of the current `yield` as a reference, which a by-reference `foreach` binds. */
  currentRef(): Ref {
    this.ensureInitialized();
    if (this.value instanceof Ref) return this.value;
    const ref = Ref.temporary(this.value);
    this.value = ref;
    return ref;
  }

  rewind(): void {
    this.ensureInitialized();
    if (!this.atFirstYield) throwError('Exception', 'Cannot rewind a generator that was already run');
  }

  valid(): boolean {
    this.ensureInitialized();
    return this.status !== 'finished';
  }

  current(): Value {
    this.ensureInitialized();
    return this.status === 'finished' ? null : deref(this.value);
  }

  currentKey(): Value {
    this.ensureInitialized();
    return this.status === 'finished' ? null : this.key;
  }

  next(): void {
    this.ensureInitialized();
    this.resume();
  }

  send(value: Value): Value {
    this.ensureInitialized();
    if (this.status === 'finished') return null;
    this.resume({ k: 'send', v: value });
    return this.isFinished() ? null : deref(this.value);
  }

  throwInto(exception: PhpObject): Value {
    this.ensureInitialized();
    const error = new PhpThrow(exception);
    if (this.status === 'finished') throw error;
    this.resume({ k: 'throw', error });
    return this.isFinished() ? null : deref(this.value);
  }

  getReturn(): Value {
    this.ensureInitialized();
    if (!this.returned) throwError('Exception', "Cannot get return value of a generator that hasn't returned");
    return this.returned.v;
  }

  /** Runs the body until its next `yield` or its end. */
  resume(resumption?: Resumption): void {
    if (this.status === 'running') throwError('Error', 'Cannot resume an already running generator');
    if (this.status === 'finished') return;
    this.atFirstYield = false;
    this.status = 'running';
    nativeOwnershipChanged(this.object);
    this.record.row = implicitCallRow();
    let result: ReturnType<typeof runBlocks>;
    try {
      result = runInFrame(this.frame, this.record, () => runBlocks(this.exec, resumption));
    } catch (error) {
      this.finish(undefined, error);
      throw error;
    }
    if (result === SUSPENDED) {
      this.status = 'suspended';
      this.accept(this.exec.suspendedAt as YieldRequest);
      nativeOwnershipChanged(this.object);
      return;
    }
    if (result?.t === 'goto') throw new Error(`Unresolved goto ${result.label}`);
    this.finish({ v: result?.t === 'return' ? deref(result.slot) : null });
  }

  /** What `var_dump` and `print_r` show: the function the generator runs. */
  debugEntries(): [string, Value][] {
    const { className, name } = this.record;
    return [['function', className === undefined ? name : `${className}::${name}`]];
  }

  /** The values the generator holds, which garbage collection reaches through the Generator object. */
  held(): unknown[] {
    const values: unknown[] = [this.key, this.value];
    if (this.returned) values.push(this.returned.v);
    // A running generator's frame is among the running frames, which hold its values themselves.
    if (this.status === 'running' || (this.status === 'finished' && !this.destroyed)) return values;
    const frame = this.frame;
    values.push(...frame.vars.values(), ...frame.temporaries, ...frame.argumentHolders, frame.returning);
    if (frame.thisObj) values.push(frame.thisObj);
    if (frame.closure) values.push(frame.closure);
    return values;
  }

  /**
   * Destroys a generator nothing refers to any more, running the `finally` blocks it is suspended in. Its frame's
   * values stay among what {@link held} lists, so that releasing the Generator object releases them.
   */
  beforeRelease(): boolean {
    if (this.status === 'finished' || this.status === 'running') return false;
    const runsFinally = this.status === 'suspended' && this.insideFinally();
    this.markFinished();
    this.destroyed = true;
    nativeOwnershipChanged(this.object);
    if (!runsFinally) return false;
    const result = runInFrame(this.frame, this.record, () => runBlocks(this.exec, { k: 'close' }));
    if (result === SUSPENDED) throwError('Error', 'Cannot yield from finally in a force-closed generator');
    return true;
  }

  private insideFinally(): boolean {
    return this.exec.stack.some(
      (block) => block.k === 'try' && block.stmt.fin !== undefined && block.phase !== 'finally'
    );
  }

  private accept(request: YieldRequest): void {
    const previous = [this.key, this.value];
    if (request.key === undefined) {
      this.largestKey++;
      this.key = this.largestKey;
    } else {
      this.key = request.key;
      if (!request.delegated && typeof request.key === 'bigint' && request.key > this.largestKey)
        this.largestKey = request.key;
    }
    this.value = request.value;
    this.hasYielded = true;
    rt().release(previous);
  }

  /** Destroys the generator as PHP's shutdown destroys the objects that remain. */
  destructAtShutdown(): void {
    this.beforeRelease();
  }

  private markFinished(): void {
    this.status = 'finished';
    this.hasYielded = false;
    if (this.hasFinally) rt().destructibles--;
  }

  private finish(returned?: { v: Value }, failure?: unknown): void {
    const previous = [this.key, this.value];
    this.markFinished();
    this.returned = returned;
    this.key = null;
    this.value = null;
    nativeOwnershipChanged(this.object);
    releaseGeneratorFrame(this.frame, failure);
    rt().release(previous);
  }
}

function containsFinally(statement: Stmt): boolean {
  if (statement.k === 'try' && statement.fin) return true;
  return nestedBodies(statement).some(([body]) => body.some(containsFinally));
}
