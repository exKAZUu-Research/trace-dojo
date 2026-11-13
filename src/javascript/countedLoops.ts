import type { Expression, Program, ScopeDeclarations, Statement } from './ast';

type Loop = Extract<Statement, { kind: 'for' | 'while' | 'doWhile' }>;
type AnyLoop = Extract<Statement, { kind: Loop['kind'] | 'forOf' | 'forIn' }>;

/** A function or the program, or a `for` loop's own scope, with the names it declares, which bind the names used in it. */
interface Frame {
  owner: object;
  declared: Set<string>;
  /** The function's parameters, whose values its callers choose. */
  parameters: Set<string>;
  isFunction: boolean;
}

/** Where a node sits: the function it runs in, and the frames that declare the names it may use. */
interface Place {
  fn: object;
  frames: Frame[];
}

/** What the walk over a program finds: its writes, its loops, and how its variables are used. */
interface Collected {
  writes: { node: object; name: string; place: Place }[];
  loops: { loop: AnyLoop; place: Place }[];
  /** Uses of variables other than writing them; `readsOnly` is a read of an element or of the `length`. */
  uses: { name: string; place: Place; readsOnly: boolean }[];
  /** Identifier nodes already noted, as members' objects or as written variables. */
  handled: Set<object>;
  /** Members a write's target is, through which their object is changed. */
  writtenThrough: Set<object>;
}

/**
 * Marks the loops of a program whose end cannot depend on the clock, which then never poll it however many of their
 * iterations read it: a `for...in` loop that neither breaks, returns, nor throws, or a `for`, `while`, or `do...while`
 * loop that neither breaks, returns, nor throws and whose test and update only combine literals, variables, and the
 * `length` of arrays and strings no code changes, where nothing can write those variables while it runs except its
 * `let` or `const` init, its update, and plain statements directly in its body that read only such variables. Writes
 * to another binding of a name, and those the loop's own function makes outside the loop, run before or after it. A
 * `for...of` loop may grow the array it walks or walk a generator until a deadline. Any busy wait ends through
 * something else, which a clock read can change.
 */
export function markCountedLoops(program: Program): void {
  const collected: Collected = { writes: [], loops: [], uses: [], handled: new Set(), writtenThrough: new Set() };
  const programFrame: Frame = {
    owner: program,
    declared: declaredIn(program.scope),
    parameters: new Set(),
    isFunction: true,
  };
  visit(program, [programFrame], collected);
  for (const { loop, place } of collected.loops) {
    if (loop.kind === 'forIn') {
      if (!leaves(loop.body)) loop.counted = true;
    } else if (
      (loop.kind === 'for' || loop.kind === 'while' || loop.kind === 'doWhile') &&
      new CountedProof(loop, place, collected).holds()
    ) {
      loop.counted = true;
    }
  }
}

/** The proof that a `for`, `while`, or `do...while` loop's end cannot depend on the clock. */
class CountedProof {
  /** The writes that run before the loop or once an iteration from plain values, as a counter's do. */
  private readonly own = new Set<object>();
  private readonly inLoop = new Set<object>();
  private readonly ownNames: Set<string>;
  private readonly update: Expression | undefined;

  constructor(
    private readonly loop: Loop,
    private readonly place: Place,
    private readonly collected: Collected
  ) {
    this.update = loop.kind === 'for' ? loop.update : undefined;
    const init = loop.kind === 'for' ? loop.init : undefined;
    collectWriteNodes(init, this.own);
    collectWriteNodes(this.update, this.own);
    const bodyStatements = loop.body.kind === 'block' ? loop.body.body : [loop.body];
    for (const statement of bodyStatements) {
      if (statement.kind === 'expression' && isPlain(statement.expression)) {
        collectWriteNodes(statement.expression, this.own, false);
      }
    }
    collectWriteNodes([loop.test, this.update, loop.body], this.inLoop);
    // A `var` in the init binds in the enclosing function, where other code can write it.
    const declaresOwn = init?.kind === 'declaration' && init.declarationKind !== 'var';
    this.ownNames = new Set(declaresOwn ? namesIn(init.declarators.map(({ target }) => target)) : []);
  }

  holds(): boolean {
    const { loop, update } = this;
    if (!loop.test || !isPlain(loop.test) || (update !== undefined && !isPlain(update)) || leaves(loop.body))
      return false;
    const lengthObjects = new Set(lengthObjectsIn([loop.test, update]));
    // The variables whose values decide the test, which the loop's own writes extend with the variables they read.
    const pending = namesIn([loop.test, update]);
    const checked = new Set<string>();
    for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
      if (checked.has(name)) continue;
      checked.add(name);
      if (lengthObjects.has(name) && !this.isUnchangedSequence(name)) return false;
      const read = this.valuesReadByWrites(name);
      if (read === undefined) return false;
      pending.push(...read);
    }
    return true;
  }

  /** The variables the loop's own writes of a name read, or undefined when other code may write it while it runs. */
  private valuesReadByWrites(name: string): string[] | undefined {
    const read: string[] = [];
    for (const { node, place } of this.writesOf(name)) {
      if (this.own.has(node)) read.push(...namesIn(valueOf(node)));
      // A write outside the loop in its own function runs before or after it.
      else if (place.fn !== this.place.fn || this.inLoop.has(node)) return undefined;
    }
    return read;
  }

  /**
   * Whether a variable's `length` is a data property that stays as it is: the variable only ever holds arrays or
   * strings, and no code anywhere does more with it than read its elements or length.
   */
  private isUnchangedSequence(name: string): boolean {
    if (isParameter(this.place, name) || !this.writesOf(name).every(({ node }) => storesSequence(node))) return false;
    const binding = this.bindingAt(this.place, name);
    const { uses } = this.collected;
    return uses.every((use) => use.name !== name || this.bindingAt(use.place, name) !== binding || use.readsOnly);
  }

  private writesOf(name: string): Collected['writes'] {
    const binding = this.bindingAt(this.place, name);
    return this.collected.writes.filter(
      (write) => write.name === name && this.bindingAt(write.place, name) === binding
    );
  }

  /** The frame that declares a name at a place, the loop itself for a variable its init declares. */
  private bindingAt(at: Place, name: string): object | undefined {
    if (at === this.place && this.ownNames.has(name)) return this.loop;
    return bindingOf(at, name);
  }
}

/** The frame that declares a name used at a place, or undefined for a global. */
function bindingOf(place: Place, name: string): object | undefined {
  return place.frames.findLast((frame) => frame.declared.has(name))?.owner;
}

function isParameter(place: Place, name: string): boolean {
  const frame = place.frames.findLast((candidate) => candidate.declared.has(name));
  return frame === undefined || frame.parameters.has(name);
}

/** Walks the program, noting each write, loop, and use of a variable with the place it sits in. */
function visit(node: unknown, frames: Frame[], collected: Collected): void {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) visit(item, frames, collected);
    return;
  }
  const record = node as { kind?: unknown; target?: unknown };
  if (isLoopKind(record.kind)) collected.loops.push({ loop: node as AnyLoop, place: placeOf(frames) });
  const inner = framesIn(node, frames);
  const place = placeOf(inner);
  const written = writtenNames(node);
  for (const name of written) collected.writes.push({ node, name, place });
  if (written.length > 0) markHandled(record.target, collected.handled);
  if (record.target && (record.target as { kind?: unknown }).kind === 'member')
    collected.writtenThrough.add(record.target);
  noteUse(node, place, collected);
  for (const value of Object.values(node)) visit(value, inner, collected);
}

/** Notes how a node uses a variable, which tells whether code may change the array or string a `length` belongs to. */
function noteUse(node: object, place: Place, collected: Collected): void {
  const record = node as { kind?: unknown; name?: unknown; object?: Expression; property?: Record<string, unknown> };
  const { object, property } = record;
  if (record.kind === 'member' && object?.kind === 'identifier' && !collected.handled.has(object)) {
    const readsElementOrLength =
      property?.kind === 'computed' || (property?.kind === 'key' && property.key === 'length');
    const readsOnly = readsElementOrLength && !collected.writtenThrough.has(node);
    collected.uses.push({ name: object.name, place, readsOnly });
    collected.handled.add(object);
  } else if (record.kind === 'identifier' && typeof record.name === 'string' && !collected.handled.has(node)) {
    collected.uses.push({ name: record.name, place, readsOnly: false });
  }
}

/** Marks the identifiers a write's target assigns, which are written rather than used; a member's object is used. */
function markHandled(node: unknown, handled: Set<object>): void {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) markHandled(item, handled);
    return;
  }
  const { kind } = node as { kind?: unknown };
  if (kind === 'identifier') handled.add(node);
  else if (kind !== 'member') for (const value of Object.values(node)) markHandled(value, handled);
}

/** The frames the children of a node sit in: a function's or a `for` loop's own, or its parent's with a block's names. */
function framesIn(node: object, frames: Frame[]): Frame[] {
  if (isFunctionNode(node)) {
    const parameters = new Set(namesIn([node.params, node.rest]));
    const declared = declaredIn(node.scope);
    for (const name of parameters) declared.add(name);
    return [...frames, { owner: node, declared, parameters, isFunction: true }];
  }
  const { kind, scope } = node as { kind?: unknown; scope?: ScopeDeclarations };
  if (!scope || !('lexical' in scope)) return frames;
  if (isLoopKind(kind)) {
    return [...frames, { owner: node, declared: declaredIn(scope), parameters: new Set(), isFunction: false }];
  }
  // A block's names are taken as its frame's, which can only make a binding look shared with more code.
  const frame = frames.at(-1) as Frame;
  for (const name of declaredIn(scope)) frame.declared.add(name);
  return frames;
}

/** The variables a node writes: an assignment's or increment's target, a declarator with a value, or a loop's target. */
function writtenNames(node: object): string[] {
  const record = node as { kind?: unknown; target?: unknown; init?: unknown };
  if (record.kind === 'assign' || record.kind === 'update') return namesIn(record.target);
  if (record.kind === 'forOf' || record.kind === 'forIn') return namesIn(record.target);
  // A declarator, which a declaration lists without a kind of its own.
  if (record.kind === undefined && 'target' in record && 'init' in record && record.init !== undefined) {
    return namesIn(record.target);
  }
  return [];
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

/** The value a write stores: an assignment's or a declarator's, or none for an increment. */
function valueOf(node: object): unknown {
  const record = node as { value?: unknown; init?: unknown };
  return record.value ?? record.init;
}

/** Whether a write stores an array literal or a string, whose `length` no code of the program computes. */
function storesSequence(node: object): boolean {
  const value = valueOf(node) as Expression | undefined;
  if (!value) return false;
  return (
    value.kind === 'array' || value.kind === 'template' || (value.kind === 'literal' && typeof value.value === 'string')
  );
}

/** The variables whose `length` an expression reads. */
function lengthObjectsIn(node: unknown): string[] {
  if (typeof node !== 'object' || node === null) return [];
  if (Array.isArray(node)) return node.flatMap(lengthObjectsIn);
  const record = node as { kind?: unknown; object?: { kind?: unknown; name?: unknown } };
  const own = record.kind === 'member' && record.object?.kind === 'identifier' ? [String(record.object.name)] : [];
  return [...own, ...Object.values(node).flatMap(lengthObjectsIn)];
}

/** Adds the nodes in a node that write variables; `nested` false takes only the node itself when it is one. */
function collectWriteNodes(node: unknown, nodes: Set<object>, nested = true): void {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectWriteNodes(item, nodes, nested);
    return;
  }
  if (writtenNames(node).length > 0) nodes.add(node);
  if (!nested) return;
  for (const value of Object.values(node)) collectWriteNodes(value, nodes);
}

/** Whether a statement contains a `break`, `return`, or `throw`, outside any function it defines. */
function leaves(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  if (Array.isArray(node)) return node.some(leaves);
  const { kind } = node as { kind?: unknown };
  if (kind === 'functionExpression' || kind === 'classExpression' || kind === 'function' || kind === 'class')
    return false;
  if (kind === 'break' || kind === 'return' || kind === 'throw') return true;
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
