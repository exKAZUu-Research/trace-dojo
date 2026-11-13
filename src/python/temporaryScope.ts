import { nativeReferences } from './garbageCollection';
import { currentRuntime } from './runtimeContext';
import { PyError, type PyInstance, type PyValue } from './values';

export class TemporaryScope {
  readonly length: number;
  private result: unknown;
  private exception?: PyInstance;
  private failed = false;
  private aborted = false;

  constructor(
    private readonly values: PyValue[],
    private readonly transferred?: (result: unknown) => unknown[]
  ) {
    this.length = values.length;
  }

  keep<T>(value: T): T {
    this.result = value;
    this.exception = undefined;
    this.failed = false;
    this.aborted = false;
    return value;
  }

  capture(error: unknown): unknown {
    this.result = undefined;
    this.exception = error instanceof PyError ? error.exception : undefined;
    this.failed = true;
    this.aborted = !(error instanceof PyError);
    return error;
  }

  release(): void {
    const { finalizer } = currentRuntime();
    if (this.aborted || finalizer.pending.size === 0) {
      this.values.length = this.length;
      return;
    }
    const dropped = this.values.splice(this.length).toReversed();
    const transferred = this.failed ? [] : (this.transferred?.(this.result) ?? []);
    finalizer.release(dropped, nativeReferences([this.result, this.exception, ...transferred]));
  }
}
