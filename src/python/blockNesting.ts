import type { Node } from '@willbooster/web-tree-sitter';

import type { SourceDiagnostic } from '../interpreter/diagnostics';
import { children, hasToken, namedChildren, rowOf } from './convertNodes';

/** CPython's CO_MAXBLOCKS: the loops, `try` and `with` blocks, and inlined comprehensions one code object may nest. */
const MAX_BLOCKS = 21;

/**
 * Finds the first place where CPython's compiler refuses "too many statically nested blocks", counting the blocks it
 * pushes per code object (a module, a class body, a function, a lambda, or a generator expression): one for a loop,
 * a `try` body, a `finally` body, a `with` item, or an inlined comprehension (plus one per `async for` clause), two for an
 * `except` handler, and one around the whole body of a generator or coroutine.
 */
export function findBlockNestingError(root: Node): SourceDiagnostic | undefined {
  try {
    visitChildren(root, 0);
    return undefined;
  } catch (error) {
    if (error instanceof BlockLimitError) return { row: error.row, message: error.message };
    throw error;
  }
}

class BlockLimitError extends Error {
  constructor(readonly row: number) {
    super(`for・while・try・with などのブロックの入れ子が深すぎます（1 つの関数の中で ${MAX_BLOCKS} 段まで）。`);
  }
}

/** The depth after pushing `count` blocks, refusing a depth over the limit at `row`. */
function push(depth: number, row: number, count = 1): number {
  if (depth + count > MAX_BLOCKS) throw new BlockLimitError(row);
  return depth + count;
}

function visitChildren(node: Node, depth: number): void {
  for (const child of namedChildren(node)) visit(child, depth);
}

// code-gauge-allow functionCognitiveComplexity 18 -- One case per construct that pushes blocks or starts a code object.
function visit(node: Node, depth: number): void {
  switch (node.type) {
    // Annotations and type parameters are compiled into their own lazily run scopes.
    case 'type':
    case 'type_parameter':
    case 'type_alias_statement': {
      return;
    }
    case 'for_statement':
    case 'while_statement': {
      visitLoop(node, depth);
      return;
    }
    case 'with_statement': {
      visitWith(node, depth);
      return;
    }
    case 'try_statement': {
      visitTry(node, depth);
      return;
    }
    case 'list_comprehension':
    case 'set_comprehension':
    case 'dictionary_comprehension':
    case 'generator_expression': {
      visitComprehension(node, depth);
      return;
    }
    case 'function_definition':
    case 'lambda': {
      visitFunction(node, depth);
      return;
    }
    case 'class_definition': {
      const body = node.childForFieldName('body') as Node;
      for (const child of namedChildren(node)) if (child.id !== body.id) visit(child, depth);
      visitChildren(body, 0);
      return;
    }
    default: {
      visitChildren(node, depth);
    }
  }
}

function visitLoop(node: Node, depth: number): void {
  const inner = push(depth, rowOf(node));
  const alternative = node.childForFieldName('alternative');
  for (const child of namedChildren(node)) visit(child, child.id === alternative?.id ? depth : inner);
}

function visitWith(node: Node, depth: number): void {
  let inner = depth;
  const clause = namedChildren(node).find((child) => child.type === 'with_clause');
  for (const item of clause ? namedChildren(clause) : []) {
    visit(item, inner);
    inner = push(inner, rowOf(item));
  }
  visit(node.childForFieldName('body') as Node, inner);
}

function visitTry(node: Node, depth: number): void {
  const row = rowOf(node);
  const parts = namedChildren(node);
  const hasFinally = parts.some((part) => part.type === 'finally_clause');
  const hasHandlers = parts.some((part) => part.type === 'except_clause');
  const outer = hasFinally ? push(depth, row) : depth;
  visit(node.childForFieldName('body') as Node, hasHandlers ? push(outer, row) : outer);
  for (const part of parts) {
    if (part.type === 'except_clause') {
      const handlerRow = rowOf(part);
      const handler = push(outer, handlerRow);
      const body = push(handler, handlerRow);
      for (const child of namedChildren(part)) visit(child, child.type === 'block' ? body : handler);
    } else if (part.type === 'else_clause') {
      visit(part, outer);
    } else if (part.type === 'finally_clause') {
      visit(part, push(depth, row));
    }
  }
}

/**
 * A comprehension evaluates its first iterable where it stands; the rest runs inlined in one more block, or, for a
 * generator expression, in a generator of its own.
 */
function visitComprehension(node: Node, depth: number): void {
  const clauses = namedChildren(node).filter((child) => child.type === 'for_in_clause' || child.type === 'if_clause');
  const [first] = clauses;
  const iterables = first.childrenForFieldName('right');
  const iterableIds = new Set(iterables.map((iterable) => iterable.id));
  const clauseIds = new Set(clauses.map((clause) => clause.id));
  for (const iterable of iterables) visit(iterable, depth);
  let inner = node.type === 'generator_expression' ? 1 : push(depth, rowOf(node));
  for (const clause of clauses) {
    if (clause.type === 'for_in_clause' && hasToken(clause, 'async')) inner = push(inner, rowOf(clause));
    for (const child of namedChildren(clause)) if (!iterableIds.has(child.id)) visit(child, inner);
  }
  for (const child of namedChildren(node)) if (!clauseIds.has(child.id)) visit(child, inner);
}

/** A function's defaults and decorators belong to the enclosing code; its body is a code object of its own. */
function visitFunction(node: Node, depth: number): void {
  const body = node.childForFieldName('body') as Node;
  for (const child of namedChildren(node)) if (child.id !== body.id) visit(child, depth);
  const isCoroutine = node.type === 'function_definition' && hasToken(node, 'async');
  visit(body, isCoroutine || yields(body) ? 1 : 0);
}

/** Whether a function body yields in its own scope, which makes the function a generator. */
function yields(node: Node): boolean {
  if (node.type === 'yield') return true;
  if (node.type === 'function_definition' || node.type === 'lambda' || node.type === 'class_definition') return false;
  return children(node).some((child) => yields(child));
}
