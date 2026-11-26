import type { ValueEntity } from './entities';
import type { LocalVar, RBinding, RExpr, RPat, RRhs, RStmt } from './rast';
import { type RChildren, rexprChildren, rpatChildren, rstmtChildren } from './rastChildren';

type Key = LocalVar | ValueEntity;

type VarNode = Extract<RExpr, { k: 'var' }>;

export function dependencyOrder(bindings: RBinding[]): RBinding[][] {
  const owner = new Map<Key, number>();
  for (const [index, binding] of bindings.entries()) {
    const keys: Key[] =
      binding.k === 'fun'
        ? [binding.binder.kind === 'local' ? binding.binder.local : binding.binder.entity]
        : [...binding.binders, ...(binding.globals ?? [])];
    for (const key of keys) owner.set(key, index);
  }
  const edges = bindings.map((binding) => {
    const targets = new Set<number>();
    collectBindingRefs(binding, (node) => {
      const target = owner.get(node.ref.kind === 'local' ? node.ref.local : node.ref.entity);
      if (target !== undefined) targets.add(target);
    });
    return [...targets];
  });
  return stronglyConnected(edges).map((component) =>
    component.toSorted((a, b) => a - b).map((index) => bindings[index])
  );
}

// code-gauge-allow functionCognitiveComplexity -- Explicit DFS enter, edge and exit phases share Tarjan's low-link state.
// code-gauge-allow functionNcss -- The traversal and component completion keep one set of graph state.
export function stronglyConnected(edges: readonly number[][]): number[][] {
  const indexOf = Array.from({ length: edges.length }, () => -1);
  const lowLink = Array.from({ length: edges.length }, () => 0);
  const onStack = Array.from({ length: edges.length }, () => false);
  const stack: number[] = [];
  const frames: { node: number; next: number }[] = [];
  const result: number[][] = [];
  let counter = 0;
  const enter = (node: number): void => {
    indexOf[node] = counter;
    lowLink[node] = counter;
    counter++;
    stack.push(node);
    onStack[node] = true;
    frames.push({ node, next: 0 });
  };
  for (let root = 0; root < edges.length; root++) {
    if (indexOf[root] >= 0) continue;
    enter(root);
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const { node } = frame;
      const next = edges[node][frame.next++];
      if (next !== undefined) {
        if (indexOf[next] < 0) enter(next);
        else if (onStack[next]) lowLink[node] = Math.min(lowLink[node], indexOf[next]);
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent) lowLink[parent.node] = Math.min(lowLink[parent.node], lowLink[node]);
      if (lowLink[node] !== indexOf[node]) continue;
      const component: number[] = [];
      for (;;) {
        const member = stack.pop() as number;
        onStack[member] = false;
        component.push(member);
        if (member === node) break;
      }
      result.push(component);
    }
  }
  return result;
}

function collectBindingRefs(binding: RBinding, visit: (node: VarNode) => void): void {
  if (binding.k === 'pat') {
    collectPatRefs(binding.pat, visit);
    collectRhsRefs(binding.rhs, visit);
    return;
  }
  for (const clause of binding.clauses) {
    for (const pat of clause.pats) collectPatRefs(pat, visit);
    collectRhsRefs(clause.rhs, visit);
  }
}

function collectPatRefs(pat: RPat, visit: (node: VarNode) => void): void {
  const pending = [pat];
  while (pending.length > 0) {
    const { exprs, pats } = rpatChildren(pending.pop() as RPat);
    for (const expr of exprs) collectExprRefs(expr, visit);
    pending.push(...pats);
  }
}

// code-gauge-allow functionCognitiveComplexity -- A right side's where bindings, guards, and bodies each hold references.
function collectRhsRefs(rhs: RRhs, visit: (node: VarNode) => void): void {
  for (const binding of rhs.where.bindings) collectBindingRefs(binding, visit);
  if (rhs.body.k === 'plain') {
    collectExprRefs(rhs.body.expr, visit);
    return;
  }
  for (const branch of rhs.body.branches) {
    for (const guard of branch.guards) {
      if (guard.k === 'pat') collectPatRefs(guard.pat, visit);
      if (guard.k !== 'let') collectExprRefs(guard.expr, visit);
      else for (const binding of guard.binds.bindings) collectBindingRefs(binding, visit);
    }
    collectExprRefs(branch.expr, visit);
  }
}

export function forEachVar(stmts: RStmt[], visit: (node: VarNode) => void): void {
  for (const stmt of stmts) collectChildRefs(rstmtChildren(stmt), visit);
}

function collectExprRefs(expr: RExpr, visit: (node: VarNode) => void): void {
  if (expr.k === 'var') visit(expr);
  collectChildRefs(rexprChildren(expr), visit);
}

function collectChildRefs(children: RChildren, visit: (node: VarNode) => void): void {
  for (const pat of children.pats) collectPatRefs(pat, visit);
  for (const expr of children.exprs) collectExprRefs(expr, visit);
  for (const binding of children.bindings) collectBindingRefs(binding, visit);
  for (const rhs of children.rhss) collectRhsRefs(rhs, visit);
}
