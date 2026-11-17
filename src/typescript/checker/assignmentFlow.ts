import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { isImmediatelyInvoked, named, skipParentheses } from './syntax';
import { type Type, undefinedType } from './types';

/** What a tracked target may hold at a point: what its assignments gave it, or what a loop's iteration began with. */
type Value = object;
/** The values at a point, or undefined where no path reaches it. */
type Values = Value[] | undefined;

interface LoopEntry {
  kind: 'loopEntry';
}

interface JumpTarget {
  isLoop: boolean;
  breaks: Values[];
  continues: Values[];
}

const nestedFunctionTypes = new Set([
  'function_declaration',
  'function_expression',
  'generator_function',
  'generator_function_declaration',
  'arrow_function',
  'class',
  'class_declaration',
  'method_definition',
]);

/**
 * The types `this.<name>` may hold when a constructor finishes, from which a field without a type annotation or an
 * initializer takes its type: TypeScript follows the constructor's control flow from `undefined` to each of its exits.
 */
export function typesAtConstructorExit(
  body: TreeNode,
  name: string,
  assignedType: (value: TreeNode) => Type,
  keyName: (index: TreeNode) => string | undefined,
  skippedBy: (operator: string, type: Type) => Type | undefined,
  spend: () => void
): Type[] {
  const flow = new AssignmentFlow(
    (left) => isThisField(left, name, keyName),
    assignedType,
    (operator, value) => skippedBy(operator, value as Type),
    spend
  );
  const end = flow.statement(body, [undefinedType]);
  return (merge([end, ...flow.returns]) ?? []).filter((value) => !isLoopEntry(value)) as Type[];
}

const LOGICAL_ASSIGNMENTS = new Set(['&&=', '||=', '??=']);

const UNASSIGNED = { kind: 'unassigned' };
const ASSIGNED = { kind: 'assigned' };

/**
 * Whether an assignment of the targets may not have run on some path from the start of `body` to `read`, as
 * TypeScript reports a property a program adds to a function before one of its assignments runs.
 */
export function mayBeUnassignedAt(body: TreeNode, targets: Set<number>, read: TreeNode, spend: () => void): boolean {
  // A property not assigned yet is `undefined`, which every logical assignment but `&&=` assigns.
  const flow = new AssignmentFlow(
    (left) => targets.has(left.id),
    () => ASSIGNED,
    (operator, value) => (value === UNASSIGNED && operator !== '&&=' ? undefined : value),
    spend,
    read
  );
  flow.statement(body, [UNASSIGNED]);
  return flow.atRead?.includes(UNASSIGNED) ?? false;
}

/** Follows the assignments to a target through a body's statements and expressions, as TypeScript's flow does. */
class AssignmentFlow {
  returns: Values[] = [];
  /** The values that reach the read being asked about. */
  atRead: Values;
  private targets: JumpTarget[] = [];
  /** The values assigned inside each enclosing `try` block, any of which its `catch` clause may start with. */
  private readonly tryAssignments: Value[][] = [];

  constructor(
    private readonly isTarget: (left: TreeNode) => boolean,
    private readonly assignedValue: (right: TreeNode) => Value,
    /** The part of a value for which a logical assignment's operator skips the assignment, or undefined for none. */
    private readonly skippedBy: (operator: string, value: Value) => Value | undefined,
    /** Charges the checker's budget for each statement followed, which bounds the paths through nested blocks. */
    private readonly spend: () => void,
    private readonly read?: TreeNode
  ) {}

  statement(node: TreeNode, values: Values): Values {
    if (!values) return undefined;
    this.spend();
    switch (node.type) {
      case 'program':
      case 'statement_block': {
        return this.statements(named(node), values);
      }
      case 'if_statement': {
        return this.ifStatement(node, values);
      }
      case 'return_statement':
      case 'throw_statement':
      case 'break_statement':
      case 'continue_statement': {
        this.jump(node, values);
        return undefined;
      }
      case 'while_statement':
      case 'do_statement':
      case 'for_statement':
      case 'for_in_statement': {
        return this.loop(node, values);
      }
      case 'switch_statement': {
        return this.switchStatement(node, values);
      }
      case 'try_statement': {
        return this.tryStatement(node, values);
      }
      default: {
        return this.expression(node, values);
      }
    }
  }

  /** Records the values where a statement leaves the code that follows it. */
  private jump(node: TreeNode, values: Value[]): void {
    switch (node.type) {
      case 'return_statement': {
        this.returns.push(this.expressions(named(node), values));
        break;
      }
      case 'throw_statement': {
        this.expressions(named(node), values);
        break;
      }
      case 'break_statement': {
        this.targets.at(-1)?.breaks.push(values);
        break;
      }
      default: {
        this.targets.findLast((target) => target.isLoop)?.continues.push(values);
      }
    }
  }

  private statements(nodes: TreeNode[], values: Values): Values {
    let current = values;
    for (const node of nodes) current = this.statement(node, current);
    return current;
  }

  private ifStatement(node: TreeNode, values: Values): Values {
    const [whenTrue, whenFalse] = this.branch(node.childForFieldName('condition') as TreeNode, values);
    const consequence = this.statement(node.childForFieldName('consequence') as TreeNode, whenTrue);
    const alternative = node.childForFieldName('alternative');
    return merge([consequence, alternative ? this.statements(named(alternative), whenFalse) : whenFalse]);
  }

  /** The values where a condition is true and where it is false, which no path reaches for `false` and `true`. */
  private branch(condition: TreeNode, values: Values): [Values, Values] {
    const tested = this.expression(condition, values);
    const constant = constantCondition(condition);
    return [constant === false ? undefined : tested, constant === true ? undefined : tested];
  }

  /**
   * The values after a loop. Its body runs once from a marker for the iteration's start, which the values that reach
   * the next iteration then replace: an assignment replaces every value the field held, so this reaches the fixpoint.
   */
  private loop(node: TreeNode, values: Values): Values {
    const header = node.childForFieldName('header') ?? node;
    const isForIn = node.type === 'for_in_statement';
    const initializer = header.childForFieldName(isForIn ? 'right' : 'initializer');
    const before = initializer ? this.statement(initializer, values) : values;
    const condition = isForIn ? undefined : loopCondition(header);
    const entry: LoopEntry = { kind: 'loopEntry' };
    const target: JumpTarget = { isLoop: true, breaks: [], continues: [] };
    const returnCount = this.returns.length;
    this.targets.push(target);
    let iteration: { tested: Values; next: Values };
    try {
      iteration = this.iteration(node, condition, [entry], target);
    } finally {
      this.targets.pop();
    }
    const { tested, next } = iteration;
    const iterationStart = merge([before, next?.filter((value) => value !== entry)]);
    const replaceEntry = (current: Values): Values =>
      current && merge(current.map((value) => (value === entry ? iterationStart : [value])));
    for (let index = returnCount; index < this.returns.length; index++)
      this.returns[index] = replaceEntry(this.returns[index]);
    this.atRead = replaceEntry(this.atRead);
    const endless = condition ? constantCondition(condition) === true : !isForIn;
    return merge([endless ? undefined : replaceEntry(tested), ...target.breaks.map(replaceEntry)]);
  }

  /** The values where one iteration decides whether to iterate again, and those the next iteration starts with. */
  private iteration(
    node: TreeNode,
    condition: TreeNode | undefined,
    start: Value[],
    target: JumpTarget
  ): { tested: Values; next: Values } {
    const body = node.childForFieldName('body') as TreeNode;
    if (node.type === 'do_statement') {
      const end = merge([this.statement(body, start), ...target.continues]);
      const tested = condition ? this.expression(condition, end) : end;
      return { tested, next: tested };
    }
    const tested = condition ? this.expression(condition, start) : start;
    const end = merge([this.statement(body, tested), ...target.continues]);
    const increment = (node.childForFieldName('header') ?? node)
      .childrenForFieldName('increment')
      .find((child) => child.isNamed);
    return { tested, next: increment ? this.expression(increment, end) : end };
  }

  private switchStatement(node: TreeNode, values: Values): Values {
    const tested = this.expression(node.childForFieldName('value') as TreeNode, values);
    const cases = named(node.childForFieldName('body') as TreeNode).filter(
      (child) => child.type === 'switch_case' || child.type === 'switch_default'
    );
    const target: JumpTarget = { isLoop: false, breaks: [], continues: [] };
    this.targets.push(target);
    let fallthrough: Values;
    try {
      for (const caseNode of cases) {
        const test = caseNode.childForFieldName('value');
        const entry = merge([test ? this.expression(test, tested) : tested, fallthrough]);
        const statements = caseNode.childrenForFieldName('body').filter((child) => child.isNamed);
        fallthrough = this.statements(statements, entry);
      }
    } finally {
      this.targets.pop();
    }
    const hasDefault = cases.some((caseNode) => caseNode.type === 'switch_default');
    return merge([fallthrough, ...target.breaks, hasDefault ? undefined : tested]);
  }

  private tryStatement(node: TreeNode, values: Values): Values {
    const finalizer = node.childForFieldName('finalizer');
    const finalBody = finalizer && (finalizer.childForFieldName('body') ?? named(finalizer)[0]);
    const returnCount = this.returns.length;
    const completed = this.tryAndCatch(node, values);
    if (!finalBody) return completed;
    // A return leaving the `try` or `catch` runs the `finally` block on its way out; TypeScript's flow lets a `break`
    // or `continue` skip it. The returns run it together, which gives what running it from each would.
    const returning = merge(this.returns.splice(returnCount));
    if (returning) this.returns.push(this.statement(finalBody, returning));
    return this.statement(finalBody, completed);
  }

  private tryAndCatch(node: TreeNode, values: Values): Values {
    const assigned: Value[] = [];
    this.tryAssignments.push(assigned);
    let afterTry: Values;
    try {
      afterTry = this.statement(node.childForFieldName('body') as TreeNode, values);
    } finally {
      this.tryAssignments.pop();
    }
    const handler = node.childForFieldName('handler');
    const handlerBody = handler?.childForFieldName('body');
    const afterHandler = handlerBody
      ? this.statement(handlerBody, merge([values, afterTry, assigned.length > 0 ? assigned : undefined]))
      : undefined;
    return merge([afterTry, afterHandler]);
  }

  private expressions(nodes: TreeNode[], values: Values): Values {
    let current = values;
    for (const node of nodes) current = this.expression(node, current);
    return current;
  }

  private expression(node: TreeNode, values: Values): Values {
    if (!values) return values;
    if (node.id === this.read?.id) this.atRead = merge([this.atRead, values]);
    if (nestedFunctionTypes.has(node.type)) return isImmediatelyInvoked(node) ? this.invoked(node, values) : values;
    switch (node.type) {
      case 'assignment_expression': {
        return this.assignment(node, values);
      }
      case 'augmented_assignment_expression': {
        return this.logicalAssignment(node, values);
      }
      case 'ternary_expression': {
        const [whenTrue, whenFalse] = this.branch(node.childForFieldName('condition') as TreeNode, values);
        return merge([
          this.expression(node.childForFieldName('consequence') as TreeNode, whenTrue),
          this.expression(node.childForFieldName('alternative') as TreeNode, whenFalse),
        ]);
      }
      case 'binary_expression': {
        const operator = node.childForFieldName('operator')?.text;
        const left = this.expression(node.childForFieldName('left') as TreeNode, values);
        const right = this.expression(node.childForFieldName('right') as TreeNode, left);
        return operator === '&&' || operator === '||' || operator === '??' ? merge([left, right]) : right;
      }
      default: {
        return this.expressions(named(node), values);
      }
    }
  }

  private assignment(node: TreeNode, values: Value[]): Values {
    const right = node.childForFieldName('right');
    const after = right ? this.expression(right, values) : values;
    const left = node.childForFieldName('left');
    if (!right || !after || !left || !this.isTarget(left)) return after;
    const value = this.assignedValue(right);
    for (const assigned of this.tryAssignments) assigned.push(value);
    return [value];
  }

  /**
   * The values after `&&=`, `||=`, or `??=` to a target: those the operator skips the assignment for, and the assigned
   * one where it runs. Other compound assignments read the target first, so they leave it as it was.
   */
  private logicalAssignment(node: TreeNode, values: Value[]): Values {
    const operator = node.childForFieldName('operator')?.text ?? '';
    const right = node.childForFieldName('right');
    const left = node.childForFieldName('left');
    if (!right || !left || !LOGICAL_ASSIGNMENTS.has(operator) || !this.isTarget(left))
      return this.expressions(named(node), values);
    const skipped = values.flatMap((value) => this.skippedBy(operator, value) ?? []);
    const assigned = this.assignment(node, values);
    return merge([skipped.length > 0 ? skipped : undefined, assigned]);
  }

  /** The values after a function called where it is written, which runs its body before the call completes. */
  private invoked(node: TreeNode, values: Value[]): Values {
    const { returns, targets } = this;
    this.returns = [];
    this.targets = [];
    try {
      const end = this.statement(node.childForFieldName('body') as TreeNode, values);
      return merge([end, ...this.returns]);
    } finally {
      this.returns = returns;
      this.targets = targets;
    }
  }
}

/** Whether an assignment target is `this.<name>`, or `this[key]` with a key of that constant name. */
function isThisField(left: TreeNode, name: string, keyName: (index: TreeNode) => string | undefined): boolean {
  const target = skipParentheses(left);
  if (target.childForFieldName('object')?.type !== 'this') return false;
  if (target.type === 'member_expression') return target.childForFieldName('property')?.text === name;
  const index = target.type === 'subscript_expression' ? target.childForFieldName('index') : undefined;
  return !!index && keyName(index) === name;
}

/** The values any of the paths may hold, where at least one of them is reachable. */
function merge(paths: Values[]): Values {
  const reachable = paths.filter((path): path is Value[] => path !== undefined);
  return reachable.length > 0 ? [...new Set(reachable.flat())] : undefined;
}

/** The condition of a `while`, `do`, or `for` loop, which a `for` loop may omit. */
function loopCondition(header: TreeNode): TreeNode | undefined {
  const condition = header
    .childrenForFieldName('condition')
    .find((child) => child.isNamed && child.type !== 'empty_statement');
  return condition?.type === 'expression_statement' ? named(condition)[0] : condition;
}

/** The value a condition always has, which TypeScript only knows of `true` and `false` themselves. */
function constantCondition(condition: TreeNode): boolean | undefined {
  const type = skipParentheses(condition).type;
  return type === 'true' ? true : type === 'false' ? false : undefined;
}

function isLoopEntry(value: Value): value is LoopEntry {
  return 'kind' in value && (value as { kind: unknown }).kind === 'loopEntry';
}
