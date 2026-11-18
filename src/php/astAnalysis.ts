import { CompileError } from '../interpreter/diagnostics';
import type { Arg, ClassDecl, Expr, FunctionDecl, Stmt } from './ast';
import { lower } from './bytes';
import { nativeMethodParameters, nativeParameters } from './native';
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

export function collectVariables(e: Expr, params: Set<string>, found = new Set<string>()): Set<string> {
  collectScopeNames(e, (name) => {
    if (!params.has(name)) found.add(name);
  });
  return found;
}

export function collectScopeVars(body: Stmt[]): Set<string> {
  const found = new Set<string>();
  collectScopeNames(body, (name) => found.add(name));
  return found;
}

// code-gauge-allow functionCognitiveComplexity 24 -- One traversal selects variable names while respecting scope boundaries.
// code-gauge-allow functionNcss 54 -- Traversal and scope dispatch share the same visitor.
function collectScopeNames(value: unknown, add: (name: string) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectScopeNames(item, add);
    return;
  }
  const node = value as {
    k?: string;
    name?: unknown;
    uses?: { name: string }[];
    fn?: FunctionDecl;
    vars?: { name: string; init?: Expr }[];
    varName?: string;
    args?: Arg[];
  };
  switch (node.k) {
    case 'func':
    case 'class': {
      return;
    }
    case 'var': {
      if (typeof node.name === 'string' && node.name !== 'this') add(node.name);
      return;
    }
    case 'closure': {
      for (const use of node.uses ?? []) add(use.name);
      return;
    }
    case 'arrow': {
      for (const name of node.fn?.captures ?? []) add(name);
      return;
    }
    case 'newAnon': {
      collectScopeNames(node.args, add);
      return;
    }
    case 'static': {
      for (const variable of node.vars ?? []) {
        add(variable.name);
        collectScopeNames(variable.init, add);
      }
      return;
    }
    case 'foreach': {
      const { subject, value: binding, key, body } = value as Extract<Stmt, { k: 'foreach' }>;
      collectScopeNames([subject, binding, key, body], add);
      return;
    }
    case 'while': {
      const { body, cond } = value as Extract<Stmt, { k: 'while' }>;
      collectScopeNames([body, cond], add);
      return;
    }
    case 'for': {
      const { init, body, update, cond } = value as Extract<Stmt, { k: 'for' }>;
      collectScopeNames([init, body, update, cond], add);
      return;
    }
    case 'assign': {
      const { target, value: source } = value as Extract<Expr, { k: 'assign' }>;
      collectScopeNames(target.k === 'list' ? [source, target] : [target, source], add);
      return;
    }
    default: {
      if (node.varName) add(node.varName);
      for (const [key, child] of Object.entries(node)) if (key !== 'row') collectScopeNames(child, add);
    }
  }
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

/**
 * Rejects `$a[]` where a value is read, which PHP reports before running: it only appends in writes such as
 * assignments, references, foreach targets, and arguments a function may take by reference.
 */
export function invalidRead(body: Stmt[]): { index: number; error: CompileError } | undefined {
  const validator = new ReadValidator(body);
  for (const [index, statement] of body.entries()) {
    try {
      validator.visit(statement, false);
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      return { index, error };
    }
  }
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
  // code-gauge-allow functionCognitiveComplexity 30 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  visit(value: unknown, writing: boolean): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) this.visit(item, writing);
      return;
    }
    const node = value as Record<string, unknown> & { k?: string; row?: number };
    switch (node.k) {
      case 'prop': {
        this.visit(node.obj, writing);
        this.visit(node.name, false);
        return;
      }
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
        this.visit(node.target, node.op !== '??');
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
        const subject = node.subject as Expr;
        this.visit(
          subject,
          foreachReferences(node.value as Expr, Boolean(node.byRef)) && foreachSubjectWritable(subject)
        );
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
      case 'new':
      case 'newAnon': {
        for (const [key, child] of Object.entries(node)) {
          if (key === 'args') {
            this.arguments(node as unknown as Expr, child as Arg[]);
          } else if (key !== 'row') this.visit(child, false);
        }
        return;
      }
      case 'array': {
        for (const item of node.items as { key?: unknown; value: unknown }[]) {
          this.visit(item.key, false);
          this.visit(item.value, false);
        }
        return;
      }
      case 'unset': {
        for (const target of node.targets as Expr[]) {
          checkUnsetOffsets(target);
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
  // code-gauge-allow functionCognitiveComplexity 16 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private arguments(expression: Expr, args: Arg[]): void {
    const params = this.parametersOf(expression);
    let positional = 0;
    let unpacked = false;
    for (const arg of args) {
      const param = arg.name
        ? (params?.find((param) => param.name === arg.name) ?? (params?.at(-1)?.variadic ? params.at(-1) : undefined))
        : (params?.[positional] ?? (params?.at(-1)?.variadic ? params.at(-1) : undefined));
      const writing =
        !arg.spread &&
        (params === undefined ||
          unpacked ||
          param?.byRef === true ||
          (arg.name !== undefined && (!param || param.variadic)));
      this.visit(arg.e, writing);
      if (arg.spread) unpacked = true;
      else if (!arg.name) positional++;
    }
  }
  private parametersOf(expression: Expr): Param[] | undefined {
    if (expression.k === 'scall' && expression.cls.k === 'named' && typeof expression.name === 'string') {
      const methodName = lower(expression.name);
      let className: string | undefined = expression.cls.name;
      const seen = new Set<string>();
      while (className && !seen.has(lower(className))) {
        seen.add(lower(className));
        const cls = this.body.find(
          (statement) => statement.k === 'class' && lower(statement.decl.name) === lower(className as string)
        );
        if (cls?.k !== 'class') return nativeMethodParameters(className, methodName);
        const method = cls.decl.methods.find((method) => lower(method.fn.name) === methodName);
        if (method) return method.fn.params;
        className = cls.decl.parent;
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

function checkUnsetOffsets(target: Expr): void {
  while (target.k === 'idx' || target.k === 'prop') {
    if (target.k === 'prop') target = target.obj;
    else {
      if (target.index === undefined) {
        throw new CompileError([
          { row: target.row, message: '[] で unset することはできません（Cannot use [] for unsetting）。' },
        ]);
      }
      target = target.base;
    }
  }
}

export function hasNullsafeReceiver(expression: Expr): boolean {
  let current = expression;
  for (;;) {
    if (current.k === 'idx') current = current.base;
    else if (current.k === 'prop' || current.k === 'mcall') {
      if (current.nullsafe) return true;
      current = current.obj;
    } else if ((current.k === 'sprop' || current.k === 'scall') && current.cls.k === 'expr') {
      current = current.cls.e;
    } else return false;
  }
}

export function foreachSubjectWritable(expression: Expr): boolean {
  if (hasNullsafeReceiver(expression)) return false;
  let base = expression;
  while (base.k === 'idx' || base.k === 'prop') base = base.k === 'idx' ? base.base : base.obj;
  if (base === expression && (base.k === 'call' || base.k === 'mcall' || base.k === 'scall')) return false;
  return ['var', 'varvar', 'sprop', 'call', 'mcall', 'scall'].includes(base.k);
}

export function foreachReferences(target: Expr, byRef: boolean): boolean {
  return byRef || (target.k === 'list' && hasReferenceItem(target));
}

export function canBindClass(decl: ClassDecl, parentIsBound: (name: string) => boolean): boolean {
  if (decl.interfaces.length > 0 || decl.traits.length > 0 || declaresStringConversion(decl)) return false;
  return !decl.parent || parentIsBound(lower(decl.parent));
}

export function declaresStringConversion(decl: ClassDecl): boolean {
  return decl.methods.some((method) => lower(method.fn.name) === '__tostring');
}

/** Whether a destructuring assigns any element by reference, at any depth. */
export function hasReferenceItem(list: Extract<Expr, { k: 'list' }>): boolean {
  return list.items.some(
    (item) => item !== undefined && (item.byRef || (item.target.k === 'list' && hasReferenceItem(item.target)))
  );
}
