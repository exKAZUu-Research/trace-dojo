import type { TurtleState } from '../interpreter/turtleWorld';
import type { CollectionState } from './realmCollections';
import { isAccessor, JsArray, JsFunction, JsObject, type Property, Scope, UNINITIALIZED } from './values';

/** Finds the turtles that `roots` reach, with the number of items scanned to find them. */
export function findReachableTurtles(roots: unknown[]): { reached: Set<TurtleState>; scanned: number } {
  const reached = new Set<TurtleState>();
  const visited = new Set<JsObject | Scope>();
  const pending = [...roots];
  // A WeakMap's value is reachable only once its key is, which may happen after the map itself is scanned.
  const ephemerons: [unknown, unknown][] = [];
  let scanned = 0;
  for (;;) {
    while (pending.length > 0) {
      const item = pending.pop();
      if (!(item instanceof JsObject || item instanceof Scope) || visited.has(item)) continue;
      visited.add(item);
      scanned++;
      if (item instanceof Scope) {
        pushScopeReferences(pending, item);
        continue;
      }
      if (item.turtle) reached.add(item.turtle);
      scanned += pushObjectReferences(pending, ephemerons, item);
    }
    const ready = ephemerons.filter(([key]) => !(key instanceof JsObject) || visited.has(key));
    if (ready.length === 0) return { reached, scanned };
    for (const entry of ready) {
      ephemerons.splice(ephemerons.indexOf(entry), 1);
      pending.push(entry[1]);
    }
  }
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
function pushObjectReferences(pending: unknown[], ephemerons: [unknown, unknown][], object: JsObject): number {
  pending.push(object.proto);
  for (const property of object.properties.values()) pushProperty(pending, property);
  for (const property of object.privateMembers?.values() ?? []) pushProperty(pending, property);
  // An async generator's queued calls keep what they resume it with until it answers them.
  for (const { resume, promise } of object.asyncGenerator?.queue ?? []) pending.push(resume.value, promise);
  const suspended = object.generator ?? object.asyncGenerator;
  if (suspended) {
    const { frame } = suspended;
    pending.push(frame.scope);
    for (const value of frame.temporaries) pending.push(value);
  }
  if (object.promise) {
    pending.push(object.promise.result);
    for (const reaction of object.promise.reactions) for (const root of reaction.roots) pending.push(root);
  }
  pending.push(object.hostIterator?.source);
  if (object.collection) pushCollectionReferences(pending, ephemerons, object.collection);
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
  ephemerons: [unknown, unknown][],
  collection: CollectionState
): void {
  for (const entry of collection.entries) {
    if (!entry) continue;
    if (collection.isWeak) ephemerons.push([entry.key, entry.value]);
    else pending.push(entry.key, entry.value);
  }
}

function pushProperty(pending: unknown[], property: Property): void {
  if (isAccessor(property)) pending.push(property.get, property.set);
  else pending.push(property.value);
}
