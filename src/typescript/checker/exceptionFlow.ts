import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import type { Flow, FlowEntry, State } from './flow';
import type { Scope } from './scopes';
import type { Type } from './types';

interface ExceptionAssignments {
  owner?: TreeNode;
  scope: Scope;
  state: State;
}

export class ExceptionFlow {
  private readonly collectors: ExceptionAssignments[] = [];

  constructor(
    private readonly c: Checker,
    private readonly flow: Flow,
    private readonly joinTypes: (types: Type[]) => Type
  ) {}

  collect(body: TreeNode, run: () => void): State {
    const assignments: ExceptionAssignments = {
      owner: this.c.functions.contexts.at(-1)?.node,
      scope: this.c.scopeOf(body).functionScope,
      state: this.flow.current?.clone(),
    };
    this.collectors.push(assignments);
    try {
      run();
      return assignments.state;
    } finally {
      this.collectors.pop();
    }
  }

  include(state: State): void {
    const collector = this.collectors.at(-1);
    if (!state || state.dead || !collector || collector.owner !== this.c.functions.contexts.at(-1)?.node) return;
    this.c.budget.spend(state.entries.size);
    collector.state = this.flow.merge([collector.state, state]);
  }

  record(key: string, entry: FlowEntry, assignment?: TreeNode): void {
    const collector = this.collectors.at(-1);
    if (!collector?.state || collector.owner !== this.c.functions.contexts.at(-1)?.node) return;
    if (assignment && collector.scope !== this.c.scopeOf(assignment).functionScope) return;
    this.c.budget.spend();
    const previous = collector.state.entries.get(key);
    if (previous)
      collector.state.entries.set(key, {
        type: this.joinTypes([previous.type, entry.type]),
        assigned: previous.assigned && entry.assigned,
        evolving: previous.evolving || entry.evolving,
        constraint:
          previous.constraint && entry.constraint ? this.joinTypes([previous.constraint, entry.constraint]) : undefined,
      });
    for (const reference of collector.state.entries.keys()) {
      this.c.budget.spend();
      if (reference.startsWith(`${key}.`)) collector.state.entries.delete(reference);
    }
  }
}
