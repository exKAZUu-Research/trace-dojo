import { type Flow, isKeyOf } from './compilerBase';
import { PropertySymbol } from './symbols';
import { isSameType, isSubtype } from './typeRelations';
import type { KType } from './types';

/**
 * What running a finally block does to the facts of any path through it: the values it writes, whose smart casts it
 * replaces (with those of their properties and cases), and the smart casts it establishes about other values.
 */
interface FinallyEffect {
  writes: string[];
  written: Map<string, KType>;
  established: Map<string, KType>;
  afterFinally: Flow;
}

export function finallyEffect(afterFinally: Flow, atEntry: Map<string, KType>, writes: string[]): FinallyEffect {
  const written = new Map<string, KType>();
  const established = new Map<string, KType>();
  for (const [key, type] of afterFinally.narrowed) {
    const entered = atEntry.get(key);
    if (writes.some((write) => isKeyOf(key, write))) written.set(key, type);
    else if (!entered || !isSameType(entered, type)) established.set(key, type);
  }
  return { writes, written, established, afterFinally };
}

/** A path that ran finally keeps what it knew, except what finally replaced, and the sharper of what both establish. */
export function throughFinally(flow: Flow, { writes, written, established, afterFinally }: FinallyEffect): Flow {
  const completed = flow.copy();
  completed.isDead ||= afterFinally.isDead;
  for (const key of writes) completed.forget(key);
  for (const [key, type] of written) completed.narrowed.set(key, type);
  for (const [key, type] of established) {
    const known = completed.narrowed.get(key);
    if (!known || !isSubtype(known, type)) completed.narrowed.set(key, type);
  }
  for (const variable of afterFinally.assigned) completed.assigned.add(variable);
  for (const variable of afterFinally.maybeAssigned) completed.maybeAssigned.add(variable);
  return completed;
}

export function applyFinallyJumpFields(jumps: Flow[], beforeTry: Flow, afterTry: Flow): void {
  // Kotlin checks finally's field reads before try, but uses normal try/catch flow for its own jumps.
  if (afterTry.isDead) {
    for (const jump of jumps) restrictFieldReads(jump, beforeTry);
    return;
  }
  const fields = [...afterTry.assigned].filter((target) => target instanceof PropertySymbol);
  for (const jump of jumps) for (const field of fields) jump.assigned.add(field);
}

/** Any statement of a try body may throw before it assigns anything, so `finally` counts only what was assigned before. */
export function keepAssignedBefore(flow: Flow, beforeTry: Flow): void {
  for (const variable of flow.assigned) {
    if (!beforeTry.assigned.has(variable)) flow.assigned.delete(variable);
  }
}

function restrictFieldReads(flow: Flow, beforeTry: Flow): void {
  for (const target of flow.assigned)
    if (target instanceof PropertySymbol && !beforeTry.assigned.has(target)) flow.assigned.delete(target);
}
