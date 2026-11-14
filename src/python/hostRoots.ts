import type { Runtime } from './runtime';

type RootSource = (runtime: Runtime) => Iterable<unknown>;

const sources: RootSource[] = [];

/**
 * Registers where native code keeps a run's Python values outside any Python object (threads, registered callbacks),
 * so that the collector and the finalizer count those values as referenced.
 */
export function registerRootSource(source: RootSource): void {
  sources.push(source);
}

/** The values native code keeps for `runtime` outside any Python object. */
export function* hostRoots(runtime: Runtime): Iterable<unknown> {
  for (const source of sources) yield* source(runtime);
}
