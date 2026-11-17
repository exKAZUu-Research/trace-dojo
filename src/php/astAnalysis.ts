import { CompileError } from '../interpreter/diagnostics';
import type { Arg, Expr, FunctionDecl, Stmt } from './ast';
import { lower } from './bytes';
import { nativeParameters } from './native';
import type { Param } from './values';

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
  new ReadValidator(body).visit(body, false);
}

class ReadValidator {
  private readonly functions: Map<string, Param[]>;
  constructor(private readonly body: Stmt[]) {
    this.functions = new Map(
      body.flatMap((statement) =>
        statement.k === 'func' ? [[lower(statement.decl.name), statement.decl.params] as const] : []
      )
    );
  }
  visit(value: unknown, writing: boolean): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) this.visit(item, writing);
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
        this.visit(node.base, writing);
        this.visit(node.index, false);
        return;
      }
      case 'assign':
      case 'assignOp': {
        this.visit(node.target, true);
        this.visit(node.value, false);
        return;
      }
      case 'assignRef': {
        this.visit(node.target, true);
        this.visit(node.source, true);
        return;
      }
      case 'incdec': {
        this.visit(node.target, true);
        return;
      }
      case 'foreach': {
        this.visit(node.subject, Boolean(node.byRef));
        this.visit(node.key, true);
        this.visit(node.value, true);
        this.visit(node.body, false);
        return;
      }
      case 'list': {
        for (const item of (node.items as ({ key?: unknown; target: unknown } | undefined)[]) ?? []) {
          if (!item) continue;
          this.visit(item.key, false);
          this.visit(item.target, true);
        }
        return;
      }
      case 'call':
      case 'mcall':
      case 'scall':
      case 'new': {
        for (const [key, child] of Object.entries(node)) {
          if (key === 'args') {
            this.arguments(node as unknown as Expr, child as Arg[]);
          } else if (key !== 'row') this.visit(child, false);
        }
        return;
      }
      case 'array': {
        for (const item of node.items as { key?: unknown; value: unknown; byRef: boolean }[]) {
          this.visit(item.key, false);
          this.visit(item.value, item.byRef);
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
          this.visit(target, true);
        }
        return;
      }
      default: {
        for (const [key, child] of Object.entries(node)) {
          if (key !== 'row') this.visit(child, false);
        }
      }
    }
  }
  private arguments(expression: Expr, args: Arg[]): void {
    const params = this.parametersOf(expression);
    let positional = 0;
    let unpacked = false;
    for (const arg of args) {
      const param = arg.name
        ? params?.find((param) => param.name === arg.name)
        : (params?.[positional] ?? (params?.at(-1)?.variadic ? params.at(-1) : undefined));
      const writing = !arg.spread && (params === undefined || unpacked || param?.byRef === true);
      this.visit(arg.e, writing);
      if (arg.spread) unpacked = true;
      else if (!arg.name) positional++;
    }
  }
  // code-gauge-allow functionCognitiveComplexity 19 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private parametersOf(expression: Expr): Param[] | undefined {
    if (expression.k === 'scall' && expression.cls.k === 'named' && typeof expression.name === 'string') {
      const methodName = lower(expression.name);
      let cls = this.body.find(
        (statement) =>
          statement.k === 'class' &&
          lower(statement.decl.name) === lower(expression.cls.k === 'named' ? expression.cls.name : '')
      );
      const seen = new Set<Stmt>();
      while (cls?.k === 'class' && !seen.has(cls)) {
        seen.add(cls);
        const method = cls.decl.methods.find((method) => lower(method.fn.name) === methodName);
        if (method) return method.fn.params;
        const parent = cls.decl.parent;
        cls = parent
          ? this.body.find((statement) => statement.k === 'class' && lower(statement.decl.name) === lower(parent))
          : undefined;
      }
      return;
    }
    if (expression.k !== 'call' || 'k' in expression.fn) return;
    return (
      this.functions.get(lower(expression.fn.name)) ??
      nativeParameters(expression.fn.name) ??
      (expression.fn.fallback ? nativeParameters(expression.fn.fallback) : undefined)
    );
  }
}

/** Whether a destructuring assigns any element by reference, at any depth. */
export function hasReferenceItem(list: Extract<Expr, { k: 'list' }>): boolean {
  return list.items.some(
    (item) => item !== undefined && (item.byRef || (item.target.k === 'list' && hasReferenceItem(item.target)))
  );
}
