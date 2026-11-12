import type { TurtleState } from '../interpreter/turtleWorld';
import { isAccessor, JsArray, JsFunction, JsObject, type Property, Scope, UNINITIALIZED } from './values';

/** Finds the turtles that `roots` reach, with the number of items scanned to find them. */
export function findReachableTurtles(roots: unknown[]): { reached: Set<TurtleState>; scanned: number } {
  const reached = new Set<TurtleState>();
  const visited = new Set<JsObject | Scope>();
  const pending = [...roots];
  let scanned = 0;
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
    scanned += pushObjectReferences(pending, item);
  }
  return { reached, scanned };
}

function pushScopeReferences(pending: unknown[], scope: Scope): void {
  for (const binding of scope.bindings.values()) if (binding.value !== UNINITIALIZED) pending.push(binding.value);
  pending.push(scope.parent);
  const frame = scope.functionFrame;
  if (frame) pending.push(frame.thisValue, frame.homeObject, frame.constructing, frame.newTarget);
}

/** Pushes what an object refers to, returning the number of array elements among them. */
function pushObjectReferences(pending: unknown[], object: JsObject): number {
  pending.push(object.proto);
  for (const property of object.properties.values()) pushProperty(pending, property);
  for (const property of object.privateMembers?.values() ?? []) pushProperty(pending, property);
  if (object.generator) {
    const { frame } = object.generator;
    pending.push(frame.scope);
    for (const value of frame.temporaries) pending.push(value);
  }
  if (object instanceof JsFunction) {
    if (object.behavior.kind !== 'native') pending.push(object.behavior.scope, object.behavior.homeObject);
    for (const value of object.captured) pending.push(value);
  }
  if (!(object instanceof JsArray)) return 0;
  // Pushed one by one: spreading a large array into push() exceeds the engine's argument limit.
  for (const element of object.elements) pending.push(element);
  return object.elements.length;
}

function pushProperty(pending: unknown[], property: Property): void {
  if (isAccessor(property)) pending.push(property.get, property.set);
  else pending.push(property.value);
}
