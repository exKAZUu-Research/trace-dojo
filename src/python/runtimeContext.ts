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
 * Charges the running program for a step of a scan past colliding hashes. No program is running while the builtins
 * are defined, which fills tables too.
 */
export function chargeCollision(): void {
  current?.spend();
}

/**
 * Charges the running program for slots of storage it creates, wherever the storage comes from; see
 * {@link chargeCollision}.
 */
export function chargeSlots(count: number): void {
  current?.allocate(count);
}

/**
 * Builds a value at no charge: a constant, which CPython creates once when it compiles the program, or the MemoryError
 * that reports the limit, which charging would raise again without end.
 */
export function withoutCharge<T>(build: () => T): T {
  const running = current;
  current = undefined;
  try {
    return build();
  } finally {
    current = running;
  }
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
