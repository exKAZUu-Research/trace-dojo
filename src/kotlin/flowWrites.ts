import type { Block, Expression, ForStatement, Statement } from './ast';
import type { FunctionContext, Scope } from './compilerBase';
import type { VariableSymbol } from './symbols';
import { isSubtype } from './typeRelations';
import { nonNull, resolved } from './types';

export function stableLocal(scope: Scope, context: FunctionContext, variable: VariableSymbol): boolean {
  if (!variable.isVar) return true;
  if (variable.isCapturedAndModified && !context.assignedCaptures.has(variable) && !preservesNullCheck(variable))
    return false;
  if (!escapesOwner(context, variable.owner)) return true;
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    if (current.pendingWrites?.has(variable.name)) return false;
    if (current.variables.has(variable.name)) return true;
  }
  return true;
}

function preservesNullCheck(variable: VariableSymbol): boolean {
  const type = resolved(variable.type);
  if (!type.nullable || type.kind !== 'class' || type.cls.isInheritable || variable.capturedWriteTypes.size === 0) {
    return false;
  }
  const nonNullType = nonNull(type);
  return [...variable.capturedWriteTypes].every((written) => isSubtype(written, nonNullType));
}

function escapesOwner(context: FunctionContext, owner: FunctionContext | undefined): boolean {
  for (let current: FunctionContext | undefined = context; current && current !== owner; current = current.parent) {
    if (current.isLambda && !current.inlineLambda) return true;
  }
  return false;
}

export function remainingWrites(statements: Statement[]): {
  pending: Map<string, number>;
  advance: (index: number) => void;
} {
  const pending = new Map<string, number>();
  const writes = statements.map((statement) => assignedNames(statement));
  for (const names of writes) {
    for (const name of names) pending.set(name, (pending.get(name) ?? 0) + 1);
  }
  const advance = (index: number): void => {
    for (const name of writes[index]) {
      const count = pending.get(name) ?? 0;
      if (count === 1) pending.delete(name);
      else pending.set(name, count - 1);
    }
  };
  return { pending, advance };
}

/** Finds assignments to names introduced outside the subtree, respecting local declarations that shadow them. */
export function assignedNames(node: Statement | Statement[] | Expression): Set<string> {
  const names = new Set<string>();
  if (Array.isArray(node)) visitStatements(node, new Set(), names);
  else visit(node, new Set(), names);
  return names;
}

// code-gauge-allow functionNcss 45 -- each assignment and lexical scope has one traversal case.
// code-gauge-allow functionCognitiveComplexity 20 -- the visitor keeps assignment targets and lexical boundaries in one dispatch.
function visit(node: unknown, shadowed: Set<string>, names: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, shadowed, names);
    return;
  }
  const record = node as Partial<Statement | Expression> & Partial<Block>;
  switch (record.kind) {
    case 'assignment': {
      const target = record.target;
      addWrite(target, shadowed, names);
      visit(target, shadowed, names);
      visit(record.value, shadowed, names);
      return;
    }
    case 'prefix':
    case 'postfix': {
      if (record.operator === '++' || record.operator === '--') addWrite(record.operand, shadowed, names);
      visit(record.operand, shadowed, names);
      return;
    }
    case 'lambda': {
      const within = new Set(shadowed);
      for (const param of record.params ?? []) if (param.name !== undefined) within.add(param.name);
      visitStatements(record.statements ?? [], within, names);
      return;
    }
    case 'for': {
      visitFor(record, shadowed, names);
      return;
    }
    case 'doWhile': {
      const within = new Set(shadowed);
      visitStatements(record.body?.statements ?? [], within, names);
      visit(record.condition, within, names);
      return;
    }
    case 'try': {
      visitTry(record, shadowed, names);
      return;
    }
    default: {
      if (record.statements) visitStatements(record.statements, new Set(shadowed), names);
      else for (const child of Object.values(record)) visit(child, shadowed, names);
    }
  }
}

function visitFor(loop: Partial<ForStatement>, shadowed: Set<string>, names: Set<string>): void {
  visit(loop.iterable, shadowed, names);
  const within = new Set(shadowed);
  const variable = loop.variable;
  if (variable && 'name' in variable) within.add(variable.name);
  else for (const item of variable?.names ?? []) if (item?.name) within.add(item.name);
  visit(loop.body, within, names);
}

function visitTry(
  tried: Partial<Extract<Expression, { kind: 'try' }>>,
  shadowed: Set<string>,
  names: Set<string>
): void {
  visit(tried.body, shadowed, names);
  for (const caught of tried.catches ?? []) visit(caught.body, new Set([...shadowed, caught.name]), names);
  visit(tried.finally, shadowed, names);
}

function visitStatements(statements: Statement[], shadowed: Set<string>, names: Set<string>): void {
  for (const statement of statements) {
    visit(statement, shadowed, names);
    if (statement.kind === 'property') shadowed.add(statement.name);
    if (statement.kind === 'destructuring') {
      for (const item of statement.names) if (item?.name) shadowed.add(item.name);
    }
  }
}

function addWrite(target: Expression | undefined, shadowed: Set<string>, names: Set<string>): void {
  if (target?.kind === 'name' && !shadowed.has(target.name)) names.add(target.name);
}
