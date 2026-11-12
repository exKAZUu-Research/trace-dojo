import type { Runtime } from './runtime';

/**
 * The runtime of the program running now. Builtin classes are shared by every run, so their methods find the run's
 * budget, frames, and turtles here; runs are synchronous and never interleave.
 */
let current: Runtime | undefined;

export function currentRuntime(): Runtime {
  if (!current) throw new Error('No Python program is running');
  return current;
}

/**
 * Charges the running program for a step of native work that visits one element: a scan past colliding hashes, or one
 * element of a recursive hash, comparison, or split. No program is running while the builtins are defined, which
 * fills tables too.
 */
export function chargeStep(): void {
  current?.spend();
}

/** Charges the running program for native work that scans `length` elements; see {@link chargeStep}. */
export function chargeScan(length: number): void {
  current?.scan(length);
}

/**
 * Charges the running program for slots of storage it creates, wherever the storage comes from, refusing storage
 * beyond the limit; see {@link chargeStep}.
 */
export function chargeSlots(count: number): void {
  current?.allocate(count);
}

/**
 * Refuses a string beyond the length limit that a native function returns, so that none can hand one to the program
 * even when it built the string without consulting the limit.
 */
export function refuseOversizedString(value: unknown): void {
  if (typeof value === 'string') current?.ensureStringFits(value.length);
}

/** Turns a slip of the interpreter that escaped a native function into a Python exception; see Runtime.internalError. */
export function asPythonError(error: unknown): unknown {
  if (current && (error instanceof TypeError || error instanceof ReferenceError)) return current.internalError(error);
  return error;
}

/**
 * Builds a value at no charge: a constant, which CPython creates once when it compiles the program, or the MemoryError
 * that reports the limit, which charging would raise again without end.
 */
export function withoutCharge<T>(build: () => T): T {
  return current ? current.withoutCharge(build) : build();
}

export function withRuntime<T>(runtime: Runtime, run: () => T): T {
  const outer = current;
  current = runtime;
  try {
    return run();
  } finally {
    current = outer;
  }
}
