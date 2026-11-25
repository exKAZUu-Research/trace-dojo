import type { ValueEntity } from './entities';
import { type LocalVar, type RBinding, type RExpr, type RPat, rpatChildren, type RRhs, type RStmt } from './rast';

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

/** Collects the references of the expressions of a pattern's view patterns. */
function collectPatRefs(pat: RPat, visit: (node: VarNode) => void): void {
  const pending = [pat];
  while (pending.length > 0) {
    const current = pending.pop() as RPat;
    if (current.k === 'view') collectExprRefs(current.expr, visit);
    pending.push(...rpatChildren(current));
  }
}

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

/** Visits the variable occurrences of statements, wherever they are nested. */
export function forEachVar(stmts: RStmt[], visit: (node: VarNode) => void): void {
  for (const stmt of stmts) {
    if (stmt.k === 'let') for (const binding of stmt.binds.bindings) collectBindingRefs(binding, visit);
    else {
      if (stmt.k === 'bind') collectPatRefs(stmt.pat, visit);
      collectExprRefs(stmt.expr, visit);
    }
  }
}

function collectExprRefs(expr: RExpr, visit: (node: VarNode) => void): void {
  if (expr.k === 'var') visit(expr);
  for (const pat of exprPatterns(expr)) collectPatRefs(pat, visit);
  const { exprs, bindings, rhss } = childrenOf(expr);
  for (const child of exprs) collectExprRefs(child, visit);
  for (const binding of bindings) collectBindingRefs(binding, visit);
  for (const rhs of rhss) collectRhsRefs(rhs, visit);
}

/** The patterns an expression binds directly, whose view patterns may refer to other bindings. */
function exprPatterns(expr: RExpr): RPat[] {
  switch (expr.k) {
    case 'lambda': {
      return expr.pats;
    }
    case 'case': {
      return expr.alts.map((alt) => alt.pat);
    }
    case 'do':
    case 'comp': {
      return (expr.k === 'do' ? expr.stmts : expr.quals).flatMap((stmt) => (stmt.k === 'bind' ? [stmt.pat] : []));
    }
    default: {
      return [];
    }
  }
}

// code-gauge-allow functionNcss -- One case per expression kind that nests others.
function childrenOf(expr: RExpr): { exprs: RExpr[]; bindings: RBinding[]; rhss: RRhs[] } {
  const none = { exprs: [] as RExpr[], bindings: [] as RBinding[], rhss: [] as RRhs[] };
  switch (expr.k) {
    case 'app': {
      return { ...none, exprs: [expr.fn, expr.arg] };
    }
    case 'lambda': {
      return { ...none, exprs: [expr.body] };
    }
    case 'let': {
      return { ...none, exprs: [expr.body], bindings: expr.binds.bindings };
    }
    case 'if': {
      return { ...none, exprs: [expr.cond, expr.ifTrue, expr.ifFalse] };
    }
    case 'case': {
      return { ...none, exprs: [expr.scrutinee], rhss: expr.alts.map((alt) => alt.rhs) };
    }
    case 'do':
    case 'comp': {
      const stmts = expr.k === 'do' ? expr.stmts : expr.quals;
      return {
        ...none,
        exprs: [
          ...stmts.flatMap((stmt) => (stmt.k === 'let' ? [] : [stmt.expr])),
          ...(expr.k === 'comp' ? [expr.expr] : []),
        ],
        bindings: stmts.flatMap((stmt) => (stmt.k === 'let' ? stmt.binds.bindings : [])),
      };
    }
    case 'tuple':
    case 'list': {
      return { ...none, exprs: expr.elems };
    }
    case 'arith': {
      return { ...none, exprs: [expr.from, expr.next, expr.to].filter((part): part is RExpr => part !== undefined) };
    }
    case 'rsection': {
      return { ...none, exprs: [expr.op, expr.right] };
    }
    case 'typed':
    case 'tyapp':
    case 'projection':
    case 'poly': {
      return { ...none, exprs: [expr.expr] };
    }
    case 'implicitLet': {
      return { ...none, exprs: [...expr.binds.map((bind) => bind.expr), expr.body] };
    }
    case 'recordCon': {
      return { ...none, exprs: expr.fields.map((field) => field.value) };
    }
    case 'recordUpdate': {
      return { ...none, exprs: [expr.expr, ...expr.fields.map((field) => field.value)] };
    }
    case 'var':
    case 'con':
    case 'lit':
    case 'hole':
    case 'implicit': {
      return none;
    }
    default: {
      return expr satisfies never;
    }
  }
}
