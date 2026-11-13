/** Pushes values one by one: spreading a large array into push() exceeds the engine's argument limit. */
export function pushAll<T>(target: T[], values: Iterable<T>): void {
  for (const value of values) target.push(value);
}
