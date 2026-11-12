import type { TurtleState } from '../interpreter/turtleWorld';
import type { CollectionState } from './realmCollections';
import { isAccessor, JsArray, JsFunction, JsObject, type Property, Scope, UNINITIALIZED } from './values';

/** Finds the turtles that `roots` reach, with the number of items scanned to find them. */
export function findReachableTurtles(roots: unknown[]): { reached: Set<TurtleState>; scanned: number } {
  const reached = new Set<TurtleState>();
  const visited = new Set<JsObject | Scope>();
  const pending = [...roots];
  // A WeakMap's value is reachable only once its key is, which may be found after the map: values wait by key.
  const waiting = new Map<unknown, unknown[]>();
  const ephemeron = (key: unknown, value: unknown): void => {
    if (!(key instanceof JsObject) || visited.has(key)) {
      pending.push(value);
      return;
    }
    const values = waiting.get(key);
    if (values) values.push(value);
    else waiting.set(key, [value]);
  };
  let scanned = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    // A suspended frame's roots are read now, as the frame stands.
    if (typeof item === 'function') {
      for (const value of (item as () => unknown[])()) pending.push(value);
      continue;
    }
    if (!(item instanceof JsObject || item instanceof Scope) || visited.has(item)) continue;
    visited.add(item);
    scanned++;
    if (item instanceof Scope) {
      pushScopeReferences(pending, item);
      continue;
    }
    const released = waiting.get(item);
    if (released) {
      waiting.delete(item);
      for (const value of released) pending.push(value);
    }
    if (item.turtle) reached.add(item.turtle);
    scanned += pushObjectReferences(pending, ephemeron, item);
  }
  return { reached, scanned };
}

function pushScopeReferences(pending: unknown[], scope: Scope): void {
  for (const binding of scope.bindings.values()) if (binding.value !== UNINITIALIZED) pending.push(binding.value);
  pending.push(scope.parent);
  // A `using` declaration's value and disposal method stay reachable until its scope ends.
  for (const { value, method } of scope.disposables ?? []) pending.push(value, method);
  const frame = scope.functionFrame;
  if (frame) pending.push(frame.thisValue, frame.homeObject, frame.constructing, frame.newTarget);
}

/** Pushes what an object refers to, returning the number of array elements among them. */
// code-gauge-allow functionCognitiveComplexity 19 -- Lists what each kind of builtin state refers to, one branch per kind.
function pushObjectReferences(
  pending: unknown[],
  ephemeron: (key: unknown, value: unknown) => void,
  object: JsObject
): number {
  pending.push(object.proto);
  for (const property of object.properties.values()) pushProperty(pending, property);
  for (const property of object.privateMembers?.values() ?? []) pushProperty(pending, property);
  // An async generator's queued calls keep what they resume it with until it answers them.
  for (const { resume, promise } of object.asyncGenerator?.queue ?? []) pending.push(resume.value, promise);
  const suspended = object.generator ?? object.asyncGenerator;
  // A completed generator, or one answering a return after completing, never resumes its frame.
  if (suspended && suspended.status !== 'completed' && suspended.status !== 'awaitingReturn') {
    for (const value of suspended.frame.reachableValues()) pending.push(value);
  }
  if (object.promise) {
    pending.push(object.promise.result);
    for (const reaction of object.promise.reactions) for (const root of reaction.roots) pending.push(root);
  }
  pending.push(object.hostIterator?.source);
  if (object.collection) pushCollectionReferences(pending, ephemeron, object.collection);
  if (object instanceof JsFunction) {
    if (object.behavior.kind !== 'native') pending.push(object.behavior.scope, object.behavior.homeObject);
    for (const value of object.captured) pending.push(value);
  }
  if (!(object instanceof JsArray)) return 0;
  // Pushed one by one: spreading a large array into push() exceeds the engine's argument limit.
  for (const element of object.elements) pending.push(element);
  return object.elements.length;
}

/** Pushes the keys and values of a Map or Set, leaving out the keys of a WeakMap or WeakSet, which hold them weakly. */
function pushCollectionReferences(
  pending: unknown[],
  ephemeron: (key: unknown, value: unknown) => void,
  collection: CollectionState
): void {
  for (const entry of collection.entries) {
    if (!entry) continue;
    if (collection.isWeak) ephemeron(entry.key, entry.value);
    else pending.push(entry.key, entry.value);
  }
}

function pushProperty(pending: unknown[], property: Property): void {
  if (isAccessor(property)) pending.push(property.get, property.set);
  else pending.push(property.value);
}
