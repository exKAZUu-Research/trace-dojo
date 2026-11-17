import { CompileError } from '../interpreter/diagnostics';
import type { Expr, FunctionDecl, Stmt } from './ast';

/** Whether an expression statement only calls functions or creates objects, whose own steps show what it did. */
export function onlyCalls(e: Expr): boolean {
  if (e.k === 'assign') return e.target.k !== 'list' && isObjectCreation(e.value);
  return e.k === 'call' || e.k === 'mcall' || e.k === 'scall' || isObjectCreation(e);
}

/** Whether an expression only creates objects (`new`, or an array literal of them), whose constructors' steps show it. */
export function isObjectCreation(e: Expr): boolean {
  if (e.k === 'array')
    return e.items.length > 0 && e.items.every((item) => !item.spread && !item.byRef && isObjectCreation(item.value));
  return e.k === 'new' || e.k === 'newAnon';
}

/** The variables an arrow function's body reads, which it captures by value from where it is defined. */
export function collectVariables(e: Expr, params: Set<string>, found = new Set<string>()): Set<string> {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as { k?: string; name?: unknown; fn?: FunctionDecl; uses?: { name: string }[] };
    if (node.k === 'var' && typeof node.name === 'string') {
      if (!params.has(node.name) && node.name !== 'this') found.add(node.name);
      return;
    }
    if (node.k === 'closure') {
      for (const use of node.uses ?? []) if (!params.has(use.name)) found.add(use.name);
      return;
    }
    if (node.k === 'arrow' && node.fn) {
      for (const name of node.fn.captures ?? []) if (!params.has(name)) found.add(name);
      return;
    }
    for (const [key, child] of Object.entries(node)) if (key !== 'row') visit(child);
  };
  visit(e);
  return found;
}

/** Whether a label sits inside a loop or switch of the statements, which `goto` may not jump into. */
export function labelInsideLoop(statements: Stmt[], label: string, inLoop: boolean): boolean {
  for (const statement of statements) {
    if (statement.k === 'label' && statement.name === label) return inLoop;
    for (const [nested, isLoop] of nestedBodies(statement)) {
      if (labelInsideLoop(nested, label, inLoop || isLoop)) return true;
    }
  }
  return false;
}

export function nestedBodies(statement: Stmt): [Stmt[], boolean][] {
  switch (statement.k) {
    case 'if': {
      return statement.alternate
        ? [
            [statement.consequent, false],
            [statement.alternate, false],
          ]
        : [[statement.consequent, false]];
    }
    case 'while':
    case 'do':
    case 'for':
    case 'foreach': {
      return [[statement.body, true]];
    }
    case 'switch': {
      return statement.cases.map((item) => [item.body, true]);
    }
    case 'block': {
      return [[statement.body, false]];
    }
    case 'try': {
      const bodies: [Stmt[], boolean][] = [
        [statement.body, false],
        ...statement.catches.map((item): [Stmt[], boolean] => [item.body, false]),
      ];
      if (statement.fin) bodies.push([statement.fin, false]);
      return bodies;
    }
    default: {
      return [];
    }
  }
}

/** The variables top-level code names, in order of first appearance, skipping function and class bodies. */
export function collectMainVars(body: Stmt[]): Set<string> {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as { k?: string; name?: unknown; uses?: { name: string }[]; fn?: FunctionDecl; decl?: unknown };
    if (node.k === 'func' || node.k === 'class' || node.k === 'newAnon') return;
    if (node.k === 'var' && typeof node.name === 'string') {
      if (node.name !== 'this') found.add(node.name);
      return;
    }
    if (node.k === 'closure') {
      for (const use of node.uses ?? []) found.add(use.name);
      return;
    }
    if (node.k === 'arrow') {
      for (const name of node.fn?.captures ?? []) found.add(name);
      return;
    }
    for (const [key, child] of Object.entries(node)) if (key !== 'row') visit(child);
  };
  visit(body);
  return found;
}

/**
 * Rejects `$a[]` where a value is read, which PHP reports before running: it only appends in writes such as
 * assignments, references, foreach targets, and arguments a function may take by reference.
 */
export function validateReads(body: Stmt[]): void {
  const visit = (value: unknown, writing: boolean): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, writing);
      return;
    }
    const node = value as Record<string, unknown> & { k?: string; row?: number };
    switch (node.k) {
      case 'idx': {
        if (node.index === undefined && !writing) {
          throw new CompileError([
            { row: node.row ?? 0, message: '[] で読み出すことはできません（Cannot use [] for reading）。' },
          ]);
        }
        visit(node.base, writing);
        visit(node.index, false);
        return;
      }
      case 'assign':
      case 'assignOp': {
        visit(node.target, true);
        visit(node.value, false);
        return;
      }
      case 'assignRef': {
        visit(node.target, true);
        visit(node.source, true);
        return;
      }
      case 'incdec': {
        visit(node.target, true);
        return;
      }
      case 'foreach': {
        visit(node.subject, Boolean(node.byRef));
        visit(node.key, true);
        visit(node.value, true);
        visit(node.body, false);
        return;
      }
      case 'list': {
        for (const item of (node.items as ({ key?: unknown; target: unknown } | undefined)[]) ?? []) {
          if (!item) continue;
          visit(item.key, false);
          visit(item.target, true);
        }
        return;
      }
      case 'call':
      case 'mcall':
      case 'scall':
      case 'new': {
        for (const [key, child] of Object.entries(node)) {
          if (key === 'args') for (const arg of child as { e: unknown }[]) visit(arg.e, true);
          else if (key !== 'row') visit(child, false);
        }
        return;
      }
      case 'array': {
        for (const item of node.items as { key?: unknown; value: unknown; byRef: boolean }[]) {
          visit(item.key, false);
          visit(item.value, item.byRef);
        }
        return;
      }
      case 'unset': {
        for (const target of node.targets as { k: string; index?: unknown; row: number }[]) {
          if (target.k === 'idx' && target.index === undefined) {
            throw new CompileError([
              { row: target.row, message: '[] で unset することはできません（Cannot use [] for unsetting）。' },
            ]);
          }
          visit(target, true);
        }
        return;
      }
      default: {
        for (const [key, child] of Object.entries(node)) {
          if (key !== 'row') visit(child, false);
        }
      }
    }
  };
  visit(body, false);
}

/** Whether a destructuring assigns any element by reference, at any depth. */
export function hasReferenceItem(list: Extract<Expr, { k: 'list' }>): boolean {
  return list.items.some(
    (item) => item !== undefined && (item.byRef || (item.target.k === 'list' && hasReferenceItem(item.target)))
  );
}
