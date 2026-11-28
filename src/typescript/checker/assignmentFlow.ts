import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import {
  chainObject,
  isInlinedInvocation,
  isWithin,
  jumpLabel,
  labeledBody,
  loopStatementTypes,
  named,
  skipParentheses,
} from './syntax';
import { anyType, type Type, undefinedType } from './types';

/** What a tracked target may hold at a point: what its assignments gave it, or what a loop's iteration began with. */
type Value = object;
/** The values at a point, or undefined where no path reaches it. */
type Values = Value[] | undefined;

type AssignValue = (target: TreeNode, value: Type) => void;
type EvaluateValue = (expression: TreeNode, conditional: boolean) => void;

type Destructure = (pattern: TreeNode, right: TreeNode, assign: AssignValue, evaluate: EvaluateValue) => void;

interface ConstructorAssignments {
  assignedType: (value: TreeNode) => Type;
  keyName: (index: TreeNode) => string | undefined;
  skippedBy: (operator: string, type: Type) => Type | undefined;
  spend: () => void;
  destructure: Destructure;
  iteration: (node: TreeNode, assign: AssignValue, evaluate: EvaluateValue) => void;
}

interface LoopEntry {
  kind: 'loopEntry';
}

interface JumpTarget {
  isLoop: boolean;
  labels: string[];
  breaks: Values[];
  continues: Values[];
}

interface ProtectedPaths {
  normal: Values;
  exceptional: Values;
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
export function typesAtConstructorExit(body: TreeNode, name: string, assignments: ConstructorAssignments): Type[] {
  const flow = new AssignmentFlow(
    (left) => isThisField(left, name, assignments.keyName),
    assignments.assignedType,
    (operator, value) => assignments.skippedBy(operator, value as Type),
    assignments.spend,
    undefined,
    assignments
  );
  const end = flow.statement(body, [undefinedType]);
  const exits = merge([end, ...flow.returns]);
  return exits ? (exits.filter((value) => !isLoopEntry(value)) as Type[]) : [anyType];
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
  private readonly exceptionTargets: Values[][] = [];

  constructor(
    private readonly isTarget: (left: TreeNode) => boolean,
    private readonly assignedValue: (right: TreeNode) => Value,
    /** The part of a value for which a logical assignment's operator skips the assignment, or undefined for none. */
    private readonly skippedBy: (operator: string, value: Value) => Value | undefined,
    /** Charges the checker's budget for each statement followed, which bounds the paths through nested blocks. */
    private readonly spend: () => void,
    private readonly read?: TreeNode,
    private readonly bindings?: Pick<ConstructorAssignments, 'destructure' | 'iteration'>
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
      case 'labeled_statement': {
        return this.labeledStatement(node, values);
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
        const label = jumpLabel(node);
        this.targets
          .findLast((target) =>
            label === undefined ? target.isLoop || target.labels.length === 0 : target.labels.includes(label)
          )
          ?.breaks.push(values);
        break;
      }
      default: {
        const label = jumpLabel(node);
        this.targets
          .findLast((target) => target.isLoop && (label === undefined || target.labels.includes(label)))
          ?.continues.push(values);
      }
    }
  }

  /** A labeled loop takes its labels; any other labeled statement is a target that only `break` jumps out of. */
  private labeledStatement(node: TreeNode, values: Values): Values {
    const { labels, body } = labeledBody(node);
    if (!body) return values;
    if (loopStatementTypes.has(body.type)) return this.loop(body, values, labels);
    const target: JumpTarget = { isLoop: false, labels, breaks: [], continues: [] };
    this.targets.push(target);
    try {
      return merge([this.statement(body, values), ...target.breaks]);
    } finally {
      this.targets.pop();
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

  private branch(node: TreeNode, values: Values): [Values, Values] {
    if (!values) return [undefined, undefined];
    const condition = skipParentheses(node);
    const operator = condition.childForFieldName('operator')?.type;
    if (condition.type === 'unary_expression' && operator === '!') {
      const [whenTrue, whenFalse] = this.branch(condition.childForFieldName('argument') as TreeNode, values);
      return [whenFalse, whenTrue];
    }
    if (condition.type === 'binary_expression' && (operator === '&&' || operator === '||'))
      return this.logicalBranch(condition, operator, values);
    const stops: Values[] = [];
    const tested = this.expression(condition, values, stops);
    const constant = constantCondition(condition);
    return [constant === false ? undefined : tested, constant === true ? undefined : merge([...stops, tested])];
  }

  private logicalBranch(node: TreeNode, operator: '&&' | '||', values: Values): [Values, Values] {
    const [leftTrue, leftFalse] = this.branch(node.childForFieldName('left') as TreeNode, values);
    const [rightTrue, rightFalse] = this.branch(
      node.childForFieldName('right') as TreeNode,
      operator === '&&' ? leftTrue : leftFalse
    );
    return operator === '&&' ? [rightTrue, merge([leftFalse, rightFalse])] : [merge([leftTrue, rightTrue]), rightFalse];
  }

  /**
   * The values after a loop. Its body runs once from a marker for the iteration's start, which the values that reach
   * the next iteration then replace: an assignment replaces every value the field held, so this reaches the fixpoint.
   */
  private loop(node: TreeNode, values: Values, labels: string[] = []): Values {
    const header = node.childForFieldName('header') ?? node;
    const isForIn = node.type === 'for_in_statement';
    const initializer = header.childForFieldName(isForIn ? 'right' : 'initializer');
    const before = initializer ? this.statement(initializer, values) : values;
    const condition = isForIn ? undefined : loopCondition(header);
    const entry: LoopEntry = { kind: 'loopEntry' };
    const target: JumpTarget = { isLoop: true, labels, breaks: [], continues: [] };
    const returnCount = this.returns.length;
    const exceptions = this.exceptionTargets.at(-1);
    const exceptionCount = exceptions?.length ?? 0;
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
    if (exceptions)
      for (let index = exceptionCount; index < exceptions.length; index++)
        exceptions[index] = replaceEntry(exceptions[index]);
    this.atRead = replaceEntry(this.atRead);
    return merge([replaceEntry(tested), ...target.breaks.map(replaceEntry)]);
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
      const [next, tested] = condition ? this.branch(condition, end) : [end, end];
      return { tested, next };
    }
    const isForIn = node.type === 'for_in_statement';
    const [entered, tested] = condition ? this.branch(condition, start) : [start, isForIn ? start : undefined];
    const iteration =
      isForIn && this.bindings
        ? this.bindValues(entered, (assign, evaluate) => this.bindings!.iteration(node, assign, evaluate))
        : entered;
    const end = merge([this.statement(body, iteration), ...target.continues]);
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
    const target: JumpTarget = { isLoop: false, labels: [], breaks: [], continues: [] };
    this.targets.push(target);
    let fallthrough: Values;
    try {
      for (const caseNode of cases) {
        const test = caseNode.childForFieldName('value');
        if (test && this.read && isWithin(this.read, test)) this.expression(test, tested);
        const entry = merge([tested, fallthrough]);
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
    const { normal, exceptional } = this.tryAndCatch(node, values);
    if (!finalBody) return normal;
    const returning = merge(this.returns.splice(returnCount));
    // A finalizer's own jumps replace the incoming completion. When it finishes, resume that completion.
    const afterException = this.statement(finalBody, exceptional);
    this.exceptionTargets.at(-1)?.push(afterException);
    if (returning) this.returns.push(this.statement(finalBody, returning));
    return this.statement(finalBody, normal);
  }

  private tryAndCatch(node: TreeNode, values: Values): ProtectedPaths {
    const tried = this.withExceptionTarget(node.childForFieldName('body') as TreeNode, values);
    const handler = node.childForFieldName('handler')?.childForFieldName('body');
    if (!handler) return tried;
    const caught = this.withExceptionTarget(handler, tried.exceptional);
    return { normal: merge([tried.normal, caught.normal]), exceptional: caught.exceptional };
  }

  private withExceptionTarget(body: TreeNode, values: Values): ProtectedPaths {
    // The binder assumes an exception can leave the scope before or after any tracked mutation.
    const paths: Values[] = [values];
    this.exceptionTargets.push(paths);
    try {
      const normal = this.statement(body, values);
      return { normal, exceptional: merge(paths) };
    } finally {
      this.exceptionTargets.pop();
    }
  }

  private expressions(nodes: TreeNode[], values: Values): Values {
    let current = values;
    for (const node of nodes) current = this.expression(node, current);
    return current;
  }

  private expression(node: TreeNode, values: Values, chainStops?: Values[]): Values {
    if (!values) return values;
    const receiver = chainObject(node);
    if (receiver) return this.chainLink(node, receiver, values, chainStops);
    if (node.id === this.read?.id) this.atRead = merge([this.atRead, values]);
    if (nestedFunctionTypes.has(node.type)) return values;
    switch (node.type) {
      case 'assignment_expression': {
        return this.assignment(node, values);
      }
      case 'required_parameter':
      case 'optional_parameter': {
        return this.bindingDefault(node.childForFieldName('pattern'), node.childForFieldName('value'), values);
      }
      case 'assignment_pattern':
      case 'object_assignment_pattern': {
        return this.bindingDefault(node.childForFieldName('left'), node.childForFieldName('right'), values);
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
        return this.binaryExpression(node, values);
      }
      default: {
        return this.expressions(named(node), values);
      }
    }
  }

  private binaryExpression(node: TreeNode, values: Value[]): Values {
    const operator = node.childForFieldName('operator')?.text;
    if (operator === '&&' || operator === '||') return merge(this.logicalBranch(node, operator, values));
    const left = node.childForFieldName('left') as TreeNode;
    const right = node.childForFieldName('right') as TreeNode;
    if (operator !== '??') return this.expression(right, this.expression(left, values));
    const stops: Values[] = [];
    const tested = this.expression(skipParentheses(left), values, stops);
    return merge([tested, this.expression(right, merge([...stops, tested]))]);
  }

  private assignment(node: TreeNode, values: Value[]): Values {
    const right = node.childForFieldName('right');
    const left = node.childForFieldName('left');
    if (!right || !left) return values;
    const pattern = skipParentheses(left);
    const destructuring = ['object_pattern', 'array_pattern', 'object', 'array'].includes(pattern.type);
    const before = destructuring ? values : this.expression(left, values);
    const after = this.expression(right, before);
    if (!after) return after;
    if (this.bindings && destructuring)
      return this.bindValues(after, (assign, evaluate) => this.bindings!.destructure(pattern, right, assign, evaluate));
    return this.isTarget(left) ? this.trackValue(this.assignedValue(right)) : after;
  }

  private bindValues(values: Values, bind: (assign: AssignValue, evaluate: EvaluateValue) => void): Values {
    let current = values;
    if (!current) return current;
    bind(
      (target, value) => {
        if (current && this.isTarget(target)) current = this.trackValue(value);
      },
      (expression, conditional) => {
        const evaluated = this.expression(expression, current);
        current = conditional ? merge([current, evaluated]) : evaluated;
      }
    );
    return current;
  }

  private trackValue(value: Value): Values {
    const values = [value];
    this.exceptionTargets.at(-1)?.push(values);
    return values;
  }

  private logicalAssignment(node: TreeNode, values: Value[]): Values {
    const operator = node.childForFieldName('operator')?.text ?? '';
    const right = node.childForFieldName('right');
    const left = node.childForFieldName('left');
    if (!right || !left || !LOGICAL_ASSIGNMENTS.has(operator)) return this.expressions(named(node), values);

    const before = this.expression(left, values);
    const after = this.expression(right, before);
    if (!this.isTarget(left)) return merge([before, after]);
    const skipped = before?.flatMap((value) => this.skippedBy(operator, value) ?? []);
    const assigned = after ? this.trackValue(this.assignedValue(right)) : undefined;
    return merge([skipped?.length ? skipped : undefined, assigned]);
  }

  private chainLink(node: TreeNode, receiver: TreeNode, values: Values, outerStops?: Values[]): Values {
    const stops = outerStops ?? [];
    const before = this.expression(receiver, values, stops);
    const target = node.type === 'call_expression' ? skipParentheses(receiver) : undefined;
    const inlined = target && isInlinedInvocation(target) ? target : undefined;
    if (!inlined && node.childForFieldName('optional_chain')) stops.push(before);
    const operand = node.childForFieldName(node.type === 'call_expression' ? 'arguments' : 'index');
    const after = operand ? this.expression(operand, before) : before;
    if (node.id === this.read?.id) this.atRead = merge([this.atRead, after]);
    const completed = after && inlined ? this.invoked(inlined, after) : after;
    return outerStops || stops.length === 0 ? completed : merge([...stops, completed]);
  }

  private bindingDefault(pattern: TreeNode | null, initializer: TreeNode | null, values: Values): Values {
    const bound = initializer ? merge([values, this.expression(initializer, values)]) : values;
    return pattern ? this.expression(pattern, bound) : bound;
  }

  /** The values after a function called where it is written, which runs its body before the call completes. */
  private invoked(node: TreeNode, values: Value[]): Values {
    const { returns, targets } = this;
    this.returns = [];
    this.targets = [];
    try {
      const parameters = node.childForFieldName('parameters');
      const entry = parameters ? this.expression(parameters, values) : values;
      const end = this.statement(node.childForFieldName('body') as TreeNode, entry);
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
