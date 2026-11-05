import type { Expression, Statement } from './ast';

/** The locals definitely assigned (`undefined` when the point is unreachable) and those possibly assigned. */
export interface State {
  assigned: ReadonlySet<number> | undefined;
  possiblyAssigned: ReadonlySet<number>;
}

export interface Conditional {
  whenTrue: State;
  whenFalse: State;
}

/** A loop being analyzed, with the assignments in it to finals declared before it. */
export const UNREACHABLE: State = { assigned: undefined, possiblyAssigned: new Set() };

/** The simple names that `node` assigns or increments anywhere. */
export function assignedNames(node: Statement | Expression): string[] {
  const names: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object' || !value) return;
    const record = value as Record<string, unknown>;
    const target = record.kind === 'assign' || record.kind === 'update' ? (record.target as Expression) : undefined;
    if (target?.kind === 'name') names.push(target.name);
    for (const child of Object.values(record)) visit(child);
  };
  visit(node);
  return names;
}

/** Assigns a variable; an assignment that cannot run still makes it possibly assigned, as Java's rules say. */
export function assign(state: State, id: number): State {
  const possiblyAssigned = new Set([...state.possiblyAssigned, id]);
  return { assigned: state.assigned && new Set([...state.assigned, id]), possiblyAssigned };
}

/** The state after a finally block that `state` entered, which keeps the assignments made before it. */
export function throughFinally(state: State, afterFinally: State): State {
  const possiblyAssigned = new Set([...state.possiblyAssigned, ...afterFinally.possiblyAssigned]);
  if (!state.assigned || !afterFinally.assigned) return { assigned: undefined, possiblyAssigned };
  return { assigned: new Set([...state.assigned, ...afterFinally.assigned]), possiblyAssigned };
}

/** Merges paths: assigned on every reachable one, possibly assigned on any, including assignments that cannot run. */
export function join(...states: State[]): State {
  const possiblyAssigned = new Set(states.flatMap((state) => [...state.possiblyAssigned]));
  const reachable = states.filter((state) => state.assigned !== undefined);
  if (reachable.length === 0) return { assigned: undefined, possiblyAssigned };
  const [first, ...rest] = reachable;
  const assigned = [...(first.assigned as ReadonlySet<number>)].filter((id) =>
    rest.every((state) => state.assigned?.has(id))
  );
  return { assigned: new Set(assigned), possiblyAssigned };
}

/** Whether a label written before `statement` names `statement` itself as the target of `break` or `continue`. */
export function takesLabelItself(statement: Statement): boolean {
  return ['while', 'do', 'for', 'forEach', 'switch'].includes(statement.kind);
}
