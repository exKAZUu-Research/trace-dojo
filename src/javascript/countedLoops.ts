import type { Expression, Program, ScopeDeclarations, Statement } from './ast';

type Loop = Extract<Statement, { kind: 'for' | 'while' | 'doWhile' }>;
type AnyLoop = Extract<Statement, { kind: Loop['kind'] | 'forOf' | 'forIn' }>;

/** A function or the program, or a `for` loop's own scope, with the names it declares, which bind the names used in it. */
interface Frame {
  owner: object;
  declared: Set<string>;
  isFunction: boolean;
}

/** Where an assignment or a loop sits: the function it runs in, and the frame that declares each name it may use. */
interface Place {
  fn: object;
  frames: Frame[];
}

interface Assignment {
  node: object;
  name: string;
  place: Place;
}

/**
 * Marks the loops of a program whose end cannot depend on the clock, which then never poll it however many of their
 * iterations read it: a `for...of` or `for...in` loop that neither breaks nor returns, or a `for`, `while`, or
 * `do...while` loop that neither breaks nor returns and whose test and update only combine literals, the `length` of a
 * variable, and variables nothing can assign while it runs except its init, update, and plain statements directly in
 * its body. Assignments to another binding of the name, and those in the loop's own function outside the loop, run
 * before or after it. Any busy wait ends through something else, which a clock read can change.
 */
export function markCountedLoops(program: Program): void {
  const assignments: Assignment[] = [];
  const loops: { loop: AnyLoop; place: Place }[] = [];
  const programFrame: Frame = { owner: program, declared: declaredIn(program.scope), isFunction: true };
  visit(program, [programFrame], assignments, loops);
  for (const { loop, place } of loops) {
    if (loop.kind === 'forOf' || loop.kind === 'forIn') {
      if (!leaves(loop.body)) loop.counted = true;
    } else if (
      (loop.kind === 'for' || loop.kind === 'while' || loop.kind === 'doWhile') &&
      isCounted(loop, place, assignments)
    ) {
      loop.counted = true;
    }
  }
}

function isCounted(loop: Loop, place: Place, assignments: Assignment[]): boolean {
  const update = loop.kind === 'for' ? loop.update : undefined;
  const init = loop.kind === 'for' ? loop.init : undefined;
  if (!loop.test || !isPlain(loop.test) || (update !== undefined && !isPlain(update)) || leaves(loop.body))
    return false;
  // The assignments that run before the loop or once an iteration, which only advance it as a counter does.
  const own = new Set<object>();
  collectAssignmentNodes(init, own);
  collectAssignmentNodes(update, own);
  const bodyStatements = loop.body.kind === 'block' ? loop.body.body : [loop.body];
  for (const statement of bodyStatements) {
    // Such an assignment advances the loop only when no code computes its value, as `n++` and `n += 2` do.
    if (statement.kind === 'expression' && isPlain(statement.expression)) {
      collectAssignmentNodes(statement.expression, own, false);
    }
  }
  const inLoop = new Set<object>();
  collectAssignmentNodes([loop.test, update, loop.body], inLoop);
  const ownNames = new Set(init?.kind === 'declaration' ? namesIn(init.declarators.map(({ target }) => target)) : []);
  return namesIn(loop.test).every((name) => {
    const binding = ownNames.has(name) ? loop : bindingOf(place, name);
    return assignments.every(
      (assignment) =>
        assignment.name !== name ||
        own.has(assignment.node) ||
        bindingOf(assignment.place, name, loop) !== binding ||
        (assignment.place.fn === place.fn && !inLoop.has(assignment.node))
    );
  });
}

/** The frame that declares a name used at a place, or undefined for a global; `loop` stands for a loop's own scope. */
function bindingOf(place: Place, name: string, loop?: object): object | undefined {
  for (let index = place.frames.length - 1; index >= 0; index--) {
    const frame = place.frames[index];
    if (frame.declared.has(name)) return frame.owner === loop ? loop : frame.owner;
  }
  return undefined;
}

/** Walks the program, noting each assignment and loop with the place it sits in. */
function visit(
  node: unknown,
  frames: Frame[],
  assignments: Assignment[],
  loops: { loop: AnyLoop; place: Place }[]
): void {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) visit(item, frames, assignments, loops);
    return;
  }
  const record = node as { kind?: unknown; target?: unknown };
  if (isLoopKind(record.kind)) loops.push({ loop: node as AnyLoop, place: placeOf(frames) });
  const inner = framesIn(node, frames);
  if (record.kind === 'assign' || record.kind === 'update') {
    const place = placeOf(inner);
    for (const name of namesIn(record.target)) assignments.push({ node, name, place });
  }
  for (const value of Object.values(node)) visit(value, inner, assignments, loops);
}

/** The frames the children of a node sit in: a function's or a `for` loop's own, or its parent's with a block's names. */
function framesIn(node: object, frames: Frame[]): Frame[] {
  if (isFunctionNode(node)) {
    const declared = declaredIn(node.scope);
    for (const name of namesIn([node.params, node.rest])) declared.add(name);
    return [...frames, { owner: node, declared, isFunction: true }];
  }
  const { kind, scope } = node as { kind?: unknown; scope?: ScopeDeclarations };
  if (!scope || !('lexical' in scope)) return frames;
  if (isLoopKind(kind)) return [...frames, { owner: node, declared: declaredIn(scope), isFunction: false }];
  // A block's names are taken as its frame's, which can only make a binding look shared with more code.
  const frame = frames.at(-1) as Frame;
  for (const name of declaredIn(scope)) frame.declared.add(name);
  return frames;
}

function placeOf(frames: Frame[]): Place {
  const fn = frames.findLast((frame) => frame.isFunction) as Frame;
  return { fn: fn.owner, frames };
}

function isFunctionNode(node: object): node is { params: unknown; rest?: unknown; scope: ScopeDeclarations } {
  return 'params' in node && 'scope' in node && 'isGenerator' in node;
}

function isLoopKind(kind: unknown): boolean {
  return kind === 'for' || kind === 'while' || kind === 'doWhile' || kind === 'forOf' || kind === 'forIn';
}

function declaredIn(scope: ScopeDeclarations): Set<string> {
  return new Set([...scope.lexical.map(({ name }) => name), ...scope.vars, ...scope.functions.map(({ name }) => name)]);
}

/** Whether an expression only combines literals, `X.length` reads, and variables with operators, running no code. */
function isPlain(expression: Expression): boolean {
  switch (expression.kind) {
    case 'identifier':
    case 'literal': {
      return true;
    }
    case 'member': {
      // An array's or a string's length, which no getter of the program computes.
      const { object, property } = expression;
      return object.kind === 'identifier' && property.kind === 'key' && property.key === 'length';
    }
    case 'parenthesized': {
      return isPlain(expression.expression);
    }
    case 'unary': {
      return expression.operator !== 'delete' && isPlain(expression.argument);
    }
    case 'binary':
    case 'logical': {
      return isPlain(expression.left) && isPlain(expression.right);
    }
    case 'update': {
      return expression.target.kind === 'identifier';
    }
    case 'assign': {
      return expression.target.kind === 'identifier' && isPlain(expression.value);
    }
    case 'sequence': {
      return expression.expressions.every(isPlain);
    }
    default: {
      return false;
    }
  }
}

/** Adds the assignment nodes in a node; `nested` false takes only the node itself when it is one. */
function collectAssignmentNodes(node: unknown, nodes: Set<object>, nested = true): void {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectAssignmentNodes(item, nodes, nested);
    return;
  }
  const { kind } = node as { kind?: unknown };
  if (kind === 'assign' || kind === 'update') nodes.add(node);
  if (!nested) return;
  for (const value of Object.values(node)) collectAssignmentNodes(value, nodes);
}

/** Whether a statement contains a `break` or `return`, outside any function it defines. */
function leaves(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  if (Array.isArray(node)) return node.some(leaves);
  const { kind } = node as { kind?: unknown };
  if (kind === 'functionExpression' || kind === 'classExpression' || kind === 'function' || kind === 'class')
    return false;
  if (kind === 'break' || kind === 'return') return true;
  return Object.values(node).some(leaves);
}

/** The names of the identifier nodes in a node, which for a pattern are the variables it assigns. */
function namesIn(node: unknown): string[] {
  const names = new Set<string>();
  collectNames(node, names);
  return [...names];
}

function collectNames(node: unknown, names: Set<string>): void {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectNames(item, names);
    return;
  }
  const record = node as { kind?: unknown; name?: unknown };
  if (record.kind === 'identifier' && typeof record.name === 'string') names.add(record.name);
  for (const value of Object.values(node)) collectNames(value, names);
}
