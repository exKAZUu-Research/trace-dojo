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

export function withRuntime<T>(runtime: Runtime, run: () => T): T {
  const outer = current;
  current = runtime;
  try {
    return run();
  } finally {
    current = outer;
  }
}
