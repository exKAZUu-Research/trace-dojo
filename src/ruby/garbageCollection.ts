import type { TurtleState } from '../interpreter/turtleWorld';
import { RArray, RBasic, RClass, RHash, RObject, RProc, RRange, type Value } from './objects';
import type { Frame, Runtime, Scope } from './runtime';

/** Removes the turtles that nothing the program can still reach refers to, as Java's garbage collection would. */
export function collectGarbage(runtime: Runtime): void {
  if (!runtime.world.hasTurtles) return;
  const reached = new Set<TurtleState>();
  const visited = new Set<object>();
  const pending: Value[] = [];
  for (const frame of runtime.frames) pushFrame(frame, pending);
  pending.push(...runtime.globals.values(), ...runtime.held, runtime.c.Object);
  while (pending.length > 0) {
    const value = pending.pop() as Value;
    if (!(value instanceof RBasic) || visited.has(value)) continue;
    visited.add(value);
    if (value instanceof RObject && value.turtle) reached.add(value.turtle);
    pushReferences(value, pending);
  }
  runtime.world.retain((turtle) => reached.has(turtle));
}

function pushFrame(frame: Frame, pending: Value[]): void {
  pending.push(frame.self, ...frame.temporaries, ...frame.handling);
  for (let scope: Scope | undefined = frame.scope; scope; scope = scope.parent) pending.push(...scope.vars.values());
  const { extra } = frame;
  if (extra.block) pending.push(extra.block);
  if (extra.args) pending.push(...extra.args);
  if (extra.keywords) pending.push(extra.keywords);
  if (extra.proc) pending.push(extra.proc);
}

/** Pushes the values an object refers to. */
// code-gauge-allow functionCognitiveComplexity 18 -- Each language wires its own parser and runtime into the shared modules alike.
// code-gauge-allow functionNcss 31 -- Each language wires its own parser and runtime into the shared modules alike.
function pushReferences(value: RBasic, pending: Value[]): void {
  if (value.ivars) pending.push(...value.ivars.values());
  if (value.singleton) pending.push(value.singleton);
  if (value instanceof RObject) {
    if (value.exception) pending.push(value.exception.message, value.exception.cause);
    pushData(value.data, pending);
  } else if (value instanceof RArray) {
    pending.push(...value.items);
  } else if (value instanceof RHash) {
    for (const entry of value.map.values()) pending.push(entry.key, entry.value);
    pending.push(value.defaultValue, ...(value.defaultProc ? [value.defaultProc] : []));
  } else if (value instanceof RRange) {
    pending.push(value.begin, value.end);
  } else if (value instanceof RProc) {
    pending.push(value.self);
    const outer = value.outer as unknown as Frame | undefined;
    if (outer) pushFrame(outer, pending);
  } else if (value instanceof RClass) {
    pending.push(...value.constants.values(), ...value.classVariables.values(), ...value.includes, ...value.prepends);
    if (value.superclass) pending.push(value.superclass);
  }
}

/** Visits the values that a library object's native state holds, such as an enumerator's receiver. */
function pushData(data: unknown, pending: Value[]): void {
  if (!data || typeof data !== 'object') return;
  const held = (data as { held?: () => Value[] }).held;
  if (typeof held === 'function') pending.push(...held.call(data));
}
