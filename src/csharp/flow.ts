import type {
  BoundArgument,
  BoundBlock,
  BoundDeconstructTarget,
  BoundExpression,
  BoundInitializerEntry,
  BoundLValue,
  BoundPattern,
  BoundStatement,
} from './bound';
import type { LocalSymbol, MethodSymbol } from './types';

/** The locals definitely assigned at a point, or every local when the point is unreachable. */
type State = Set<LocalSymbol> | 'unreachable';

interface ConditionalState {
  whenTrue: State;
  whenFalse: State;
}

export interface FlowDiagnostics {
  unassigned(local: LocalSymbol, row: number): void;
  notAllPathsReturn(row: number): void;
  fallsThrough(label: string, isLast: boolean, row: number): void;
  outNotAssigned(local: LocalSymbol, row: number): void;
}

function union(a: State, b: State): State {
  if (a === 'unreachable' || b === 'unreachable') return 'unreachable';
  return new Set([...a, ...b]);
}

function intersect(a: State, b: State): State {
  if (a === 'unreachable') return copy(b);
  if (b === 'unreachable') return copy(a);
  return new Set([...a].filter((local) => b.has(local)));
}

/** The state that every one of several paths into a point guarantees. */
function intersectAll(first: State, others: State[]): State {
  let result = first;
  for (const other of others) result = intersect(result, other);
  return result;
}

function copy(state: State): State {
  return state === 'unreachable' ? state : new Set(state);
}

function isAssigned(state: State, local: LocalSymbol): boolean {
  return state === 'unreachable' || state.has(local);
}

function assign(state: State, local: LocalSymbol): State {
  if (state === 'unreachable') return state;
  return new Set([...state, local]);
}

type SwitchSection = Extract<BoundStatement, { kind: 'switch' }>['sections'][number];
type LoopStatement = Extract<BoundStatement, { kind: 'while' | 'do' | 'for' | 'foreach' }>;
type AccessExpression = Extract<
  BoundExpression,
  {
    kind: 'field' | 'element' | 'call' | 'property' | 'invokeDelegate' | 'conditionalAccess';
  }
>;
type CreationExpression = Extract<BoundExpression, { kind: 'new' | 'newArray' | 'newDelegate' | 'lambda' | 'with' }>;
type OperatorExpression = Extract<
  BoundExpression,
  {
    kind: 'unary' | 'convert' | 'as' | 'throw' | 'binary' | 'logical' | 'is' | 'coalesce' | 'conditional' | 'switch';
  }
>;
type AssignmentExpression = Extract<
  BoundExpression,
  {
    kind: 'assign' | 'compoundAssign' | 'increment' | 'deconstructAssign' | 'eventAccessor';
  }
>;

/** A jump out of statements, with the state it carries to where it goes. */
interface Jumps {
  breaks: State[];
  continues: State[];
  returns: State[];
}

/**
 * Checks a function's body as C#'s definite assignment and reachability rules do (§9.4, §13.2): reading a local before
 * every path assigns it, a non-void method whose end is reachable, and a switch section whose end is reachable.
 */
export class FlowAnalyzer {
  private jumps: Jumps = { breaks: [], continues: [], returns: [] };
  /** The locals already reported, which Roslyn reports once and then treats as assigned. */
  private readonly reported = new Set<LocalSymbol>();
  private outParameters: LocalSymbol[] = [];

  constructor(private readonly diagnostics: FlowDiagnostics) {}

  /** Analyzes a method body that starts with its parameters, except `out` ones, assigned. */
  analyzeFunction(
    method: MethodSymbol,
    body: BoundBlock,
    initiallyAssigned: Iterable<LocalSymbol>,
    returnsValue: boolean,
    endRow: number
  ): void {
    this.outParameters = method.locals.filter((local) => local.isParameter && local.refKind === 'out');
    const start: State = new Set([...initiallyAssigned].filter((local) => local.refKind !== 'out'));
    const saved = this.jumps;
    this.jumps = { breaks: [], continues: [], returns: [] };
    const end = this.statement(body, start);
    if (end !== 'unreachable') {
      if (returnsValue) this.diagnostics.notAllPathsReturn(method.row);
      else this.checkOutParameters(end, endRow);
    }
    this.jumps = saved;
  }

  private checkOutParameters(state: State, row: number): void {
    for (const parameter of this.outParameters) {
      if (!isAssigned(state, parameter)) this.diagnostics.outNotAssigned(parameter, row);
    }
  }

  // code-gauge-allow functionNcss 40 -- One case per kind of statement.
  /** The state after a statement, given the state before it. */
  statement(statement: BoundStatement, state: State): State {
    switch (statement.kind) {
      case 'block': {
        return this.statements(statement.statements, state);
      }
      case 'empty': {
        return state;
      }
      case 'expression': {
        return this.expression(statement.expression, state);
      }
      case 'localDeclaration': {
        if (!statement.value) return state;
        return assign(this.expression(statement.value, state), statement.local);
      }
      case 'if': {
        return this.ifStatement(statement, state);
      }
      case 'while':
      case 'do':
      case 'for':
      case 'foreach': {
        return this.loopStatement(statement, state);
      }
      case 'switch': {
        return this.switchStatement(statement, state);
      }
      case 'break': {
        this.jumps.breaks.push(state);
        return 'unreachable';
      }
      case 'continue': {
        this.jumps.continues.push(state);
        return 'unreachable';
      }
      case 'return': {
        const after = statement.value ? this.expression(statement.value, state) : state;
        this.checkOutParameters(after, statement.row);
        this.jumps.returns.push(after);
        return 'unreachable';
      }
      case 'throw': {
        if (statement.value) this.expression(statement.value, state);
        return 'unreachable';
      }
      case 'try': {
        return this.tryStatement(statement, state);
      }
    }
  }

  private statements(statements: BoundStatement[], state: State): State {
    let current = state;
    for (const inner of statements) current = this.statement(inner, current);
    return current;
  }

  private ifStatement(statement: Extract<BoundStatement, { kind: 'if' }>, state: State): State {
    const condition = this.condition(statement.condition, state);
    const constant = constantBool(statement.condition);
    const thenEnd = this.statement(statement.consequence, constant === false ? 'unreachable' : condition.whenTrue);
    const elseStart = constant === true ? 'unreachable' : condition.whenFalse;
    const elseEnd = statement.alternative ? this.statement(statement.alternative, elseStart) : elseStart;
    return intersect(thenEnd, elseEnd);
  }

  private loopStatement(statement: LoopStatement, state: State): State {
    switch (statement.kind) {
      case 'while': {
        return this.loop(state, (start) => {
          const condition = this.condition(statement.condition, start);
          const constant = constantBool(statement.condition);
          const bodyEnd = this.statement(statement.body, constant === false ? 'unreachable' : condition.whenTrue);
          return {
            exit: constant === true ? 'unreachable' : condition.whenFalse,
            bodyEnd,
          };
        });
      }
      case 'do': {
        return this.loop(state, (start) => {
          const bodyEnd = this.statement(statement.body, start);
          const continueState = intersectAll(bodyEnd, this.jumps.continues);
          this.jumps.continues = [];
          const condition = this.condition(statement.condition, continueState);
          const constant = constantBool(statement.condition);
          return {
            exit: constant === true ? 'unreachable' : condition.whenFalse,
            bodyEnd: 'unreachable',
          };
        });
      }
      case 'for': {
        return this.forStatement(statement, state);
      }
      case 'foreach': {
        const afterCollection = this.expression(statement.collection, state);
        return this.loop(afterCollection, (start) => {
          let bodyStart = assign(start, statement.variable);
          if (statement.deconstruction) bodyStart = this.expression(statement.deconstruction, bodyStart);
          this.statement(statement.body, bodyStart);
          return { exit: start, bodyEnd: 'unreachable' };
        });
      }
    }
  }

  private forStatement(statement: Extract<BoundStatement, { kind: 'for' }>, state: State): State {
    return this.loop(this.statements(statement.initializers, state), (start) => {
      const condition = statement.condition
        ? this.condition(statement.condition, start)
        : { whenTrue: start, whenFalse: 'unreachable' as State };
      const constant = statement.condition ? constantBool(statement.condition) : true;
      const bodyEnd = this.statement(statement.body, constant === false ? 'unreachable' : condition.whenTrue);
      const continueState = intersectAll(bodyEnd, this.jumps.continues);
      this.jumps.continues = [];
      let afterUpdates = continueState;
      for (const update of statement.updates) afterUpdates = this.expression(update, afterUpdates);
      return {
        exit: constant === true ? 'unreachable' : condition.whenFalse,
        bodyEnd: 'unreachable',
      };
    });
  }

  /** Analyzes a loop, whose exits are its condition's false state and its breaks. */
  private loop(state: State, body: (start: State) => { exit: State; bodyEnd: State }): State {
    const saved = this.jumps;
    this.jumps = { breaks: [], continues: [], returns: saved.returns };
    const { exit } = body(state);
    const breaks = this.jumps.breaks;
    this.jumps = saved;
    return intersectAll(exit, breaks);
  }

  private switchStatement(statement: Extract<BoundStatement, { kind: 'switch' }>, state: State): State {
    const afterValue = this.expression(statement.value, state);
    const saved = this.jumps;
    this.jumps = {
      breaks: [],
      continues: saved.continues,
      returns: saved.returns,
    };
    let hasDefault = false;
    for (const [index, section] of statement.sections.entries()) {
      const { entry, coversAll } = this.sectionEntry(section, afterValue);
      if (coversAll) hasDefault = true;
      if (this.statements(section.statements, entry) !== 'unreachable') {
        const label = section.labels.at(-1);
        const labelText = label === 'default' || label === undefined ? 'default:' : `case ${caseText(label.pattern)}:`;
        this.diagnostics.fallsThrough(labelText, index === statement.sections.length - 1, section.row);
      }
    }
    const breaks = this.jumps.breaks;
    this.jumps = saved;
    const exit: State = hasDefault ? 'unreachable' : afterValue;
    return intersectAll(exit, breaks);
  }

  /** The state on entry to a switch section, and whether one of its labels matches every value. */
  private sectionEntry(section: SwitchSection, afterValue: State): { entry: State; coversAll: boolean } {
    let entry: State = 'unreachable';
    let coversAll = false;
    for (const label of section.labels) {
      if (label === 'default') {
        coversAll = true;
        entry = intersect(entry, afterValue);
        continue;
      }
      const matched = this.pattern(label.pattern, afterValue, true);
      entry = intersect(entry, label.guard ? this.condition(label.guard, matched).whenTrue : matched);
      if (!label.guard && isIrrefutable(label.pattern)) coversAll = true;
    }
    return { entry, coversAll };
  }

  private tryStatement(statement: Extract<BoundStatement, { kind: 'try' }>, state: State): State {
    const tryEnd = this.statement(statement.body, state);
    let end = tryEnd;
    for (const clause of statement.catches) {
      let entry: State = clause.local ? assign(state, clause.local) : state;
      if (clause.filter) entry = this.condition(clause.filter, entry).whenTrue;
      end = intersect(end, this.statement(clause.body, entry));
    }
    if (!statement.finally) return end;
    const finallyEnd = this.statement(statement.finally, state);
    if (finallyEnd === 'unreachable') return 'unreachable';
    if (end === 'unreachable') return 'unreachable';
    return union(end, finallyEnd);
  }

  /** The states when a boolean expression is true and when it is false. */
  condition(expression: BoundExpression, state: State): ConditionalState {
    switch (expression.kind) {
      case 'logical': {
        const left = this.condition(expression.left, state);
        if (expression.operator === '&&') {
          const right = this.condition(expression.right, left.whenTrue);
          return {
            whenTrue: right.whenTrue,
            whenFalse: intersect(left.whenFalse, right.whenFalse),
          };
        }
        const right = this.condition(expression.right, left.whenFalse);
        return {
          whenTrue: intersect(left.whenTrue, right.whenTrue),
          whenFalse: right.whenFalse,
        };
      }
      case 'unary': {
        if (expression.operator === '!' && !expression.isLifted) {
          const inner = this.condition(expression.operand, state);
          return { whenTrue: inner.whenFalse, whenFalse: inner.whenTrue };
        }
        break;
      }
      case 'is': {
        const after = this.expression(expression.operand, state);
        const whenTrue = this.pattern(expression.pattern, after, true);
        const whenFalse = this.pattern(expression.pattern, after, false);
        return { whenTrue, whenFalse };
      }
      case 'constant': {
        if (expression.value === true) return { whenTrue: state, whenFalse: 'unreachable' };
        if (expression.value === false) return { whenTrue: 'unreachable', whenFalse: state };
        break;
      }
      default: {
        break;
      }
    }
    const after = this.expression(expression, state);
    return { whenTrue: after, whenFalse: copy(after) };
  }

  /** The state after matching a pattern: when it matched, its variables are assigned. */
  private pattern(pattern: BoundPattern, state: State, matched: boolean): State {
    switch (pattern.kind) {
      case 'type':
      case 'any': {
        return matched && pattern.local ? assign(state, pattern.local) : state;
      }
      case 'not': {
        return this.pattern(pattern.pattern, state, !matched);
      }
      case 'and': {
        if (matched) return this.pattern(pattern.right, this.pattern(pattern.left, state, true), true);
        return state;
      }
      case 'or': {
        return state;
      }
      case 'recursive': {
        if (!matched) return state;
        let current = pattern.local ? assign(state, pattern.local) : state;
        for (const sub of pattern.positional) current = this.pattern(sub, current, true);
        for (const sub of pattern.properties) current = this.pattern(sub.pattern, current, true);
        return current;
      }
      case 'relational':
      case 'constant': {
        return pattern.kind === 'constant' ? this.expression(pattern.value, state) : state;
      }
    }
  }

  // code-gauge-allow functionNcss 55 -- One case per group of expression kinds, in evaluation order.
  /** The state after evaluating an expression, reporting reads of locals not definitely assigned. */
  expression(expression: BoundExpression, state: State): State {
    switch (expression.kind) {
      case 'local': {
        this.read(expression.local, state, expression.row);
        return state;
      }
      case 'field':
      case 'element':
      case 'call':
      case 'property':
      case 'invokeDelegate':
      case 'conditionalAccess': {
        return this.accessExpression(expression, state);
      }
      case 'new':
      case 'newArray':
      case 'newDelegate':
      case 'lambda':
      case 'with': {
        return this.creationExpression(expression, state);
      }
      case 'unary':
      case 'convert':
      case 'as':
      case 'throw':
      case 'binary':
      case 'logical':
      case 'is':
      case 'coalesce':
      case 'conditional':
      case 'switch': {
        return this.operatorExpression(expression, state);
      }
      case 'assign':
      case 'compoundAssign':
      case 'increment':
      case 'deconstructAssign':
      case 'eventAccessor': {
        return this.assignmentExpression(expression, state);
      }
      case 'concat':
      case 'tuple': {
        return this.expressions(expression.kind === 'concat' ? expression.parts : expression.elements, state);
      }
      case 'interpolated': {
        let current = state;
        for (const part of expression.parts)
          if (typeof part !== 'string') current = this.expression(part.value, current);
        return current;
      }
      case 'sequence': {
        let current = state;
        for (const local of expression.locals) current = assign(current, local);
        return this.expression(expression.value, this.expressions(expression.sideEffects, current));
      }
      default: {
        return state;
      }
    }
  }

  private expressions(expressions: BoundExpression[], state: State): State {
    let current = state;
    for (const expression of expressions) current = this.expression(expression, current);
    return current;
  }

  private accessExpression(expression: AccessExpression, state: State): State {
    switch (expression.kind) {
      case 'field': {
        return this.receiver(expression.receiver, state);
      }
      case 'element': {
        return this.expressions(expression.indices, this.expression(expression.array, state));
      }
      case 'call':
      case 'property': {
        const current = expression.receiver ? this.receiver(expression.receiver, state) : state;
        return this.arguments(expression.args, current);
      }
      case 'invokeDelegate': {
        return this.arguments(expression.args, this.expression(expression.target, state));
      }
      case 'conditionalAccess': {
        const after = this.expression(expression.receiver, state);
        const accessed = this.expression(expression.access, assign(after, expression.temporary));
        return intersect(after, accessed);
      }
    }
  }

  private creationExpression(expression: CreationExpression, state: State): State {
    switch (expression.kind) {
      case 'new': {
        const current = this.arguments(expression.args, state);
        return expression.initializer ? this.initializer(expression.initializer, current) : current;
      }
      case 'newArray': {
        return this.expressions(expression.elements ?? [], this.expressions(expression.sizes, state));
      }
      case 'newDelegate': {
        return expression.receiver ? this.expression(expression.receiver, state) : state;
      }
      case 'lambda': {
        this.lambda(expression.lambda.method, state);
        return state;
      }
      case 'with': {
        let current = this.expression(expression.value, state);
        for (const assignment of expression.assignments)
          if (assignment.value) current = this.expression(assignment.value, current);
        return current;
      }
    }
  }

  private operatorExpression(expression: OperatorExpression, state: State): State {
    switch (expression.kind) {
      case 'unary':
      case 'convert':
      case 'as': {
        return this.expression(expression.operand, state);
      }
      case 'throw': {
        this.expression(expression.value, state);
        return 'unreachable';
      }
      case 'binary': {
        return this.expression(expression.right, this.expression(expression.left, state));
      }
      case 'logical':
      case 'is': {
        const condition = this.condition(expression, state);
        return intersect(condition.whenTrue, condition.whenFalse);
      }
      case 'coalesce': {
        const left = this.expression(expression.left, state);
        const right = this.expression(expression.right, left);
        return intersect(left, right);
      }
      case 'conditional': {
        const condition = this.condition(expression.condition, state);
        const whenTrue = this.expression(expression.whenTrue, condition.whenTrue);
        const whenFalse = this.expression(expression.whenFalse, condition.whenFalse);
        return intersect(whenTrue, whenFalse);
      }
      case 'switch': {
        return this.switchExpression(expression, state);
      }
    }
  }

  private switchExpression(expression: Extract<BoundExpression, { kind: 'switch' }>, state: State): State {
    const afterValue = this.expression(expression.value, state);
    let end: State = 'unreachable';
    for (const arm of expression.arms) {
      let armState = this.pattern(arm.pattern, afterValue, true);
      if (arm.guard) armState = this.condition(arm.guard, armState).whenTrue;
      end = intersect(end, this.expression(arm.value, armState));
    }
    return end === 'unreachable' ? afterValue : end;
  }

  private assignmentExpression(expression: AssignmentExpression, state: State): State {
    switch (expression.kind) {
      case 'assign': {
        return this.assignTarget(
          expression.target,
          this.expression(expression.value, this.targetPrefix(expression.target, state))
        );
      }
      case 'compoundAssign':
      case 'increment': {
        const before = this.targetPrefix(expression.target, state);
        if (expression.target.kind === 'local') this.read(expression.target.local, before, expression.row);
        return this.expression(expression.operation, before);
      }
      case 'deconstructAssign': {
        return this.deconstructTargets(expression.targets, this.expression(expression.value, state));
      }
      case 'eventAccessor': {
        return this.expression(expression.value, this.targetPrefix(expression.target, state));
      }
    }
  }

  /** Reads the receiver of a member, where a struct local's member may be read once the local is assigned. */
  private receiver(receiver: BoundExpression, state: State): State {
    return this.expression(receiver, state);
  }

  private read(local: LocalSymbol, state: State, row: number): void {
    if (local.isHidden || isAssigned(state, local) || this.reported.has(local)) return;
    this.reported.add(local);
    this.diagnostics.unassigned(local, row);
  }

  /** Evaluates the parts of an assignment's target that come before its value: a receiver and indices. */
  private targetPrefix(target: BoundLValue, state: State): State {
    switch (target.kind) {
      case 'field': {
        // Assigning a field of a struct local assigns the struct, as far as this analysis tracks it.
        if (
          target.receiver.kind === 'local' &&
          target.receiver.type.kind === 'named' &&
          target.receiver.type.symbol.isValueType
        )
          return state;
        return this.expression(target.receiver, state);
      }
      case 'element': {
        let current = this.expression(target.array, state);
        for (const index of target.indices) current = this.expression(index, current);
        return current;
      }
      case 'property': {
        const current = target.receiver ? this.expression(target.receiver, state) : state;
        return this.arguments(target.args, current);
      }
      default: {
        return state;
      }
    }
  }

  private assignTarget(target: BoundLValue, state: State): State {
    if (target.kind === 'local') return assign(state, target.local);
    if (
      target.kind === 'field' &&
      target.receiver.kind === 'local' &&
      target.receiver.type.kind === 'named' &&
      target.receiver.type.symbol.isValueType
    ) {
      return assign(state, target.receiver.local);
    }
    return state;
  }

  private deconstructTargets(targets: BoundDeconstructTarget, state: State): State {
    if (targets.kind === 'single')
      return targets.target ? this.assignTarget(targets.target, this.targetPrefix(targets.target, state)) : state;
    let current = state;
    for (const element of targets.elements) current = this.deconstructTargets(element, current);
    return current;
  }

  private arguments(args: BoundArgument[], state: State): State {
    let current = state;
    for (const arg of args) {
      if (arg.kind === 'refArgument') {
        const target = arg.target;
        current = this.targetPrefix(target, current);
        continue;
      }
      current = this.expression(arg, current);
    }
    // `out` arguments are assigned once the call returns.
    for (const arg of args) {
      if (arg.kind === 'refArgument') {
        if (arg.target.kind === 'local' && !this.isOutArgument(arg)) this.read(arg.target.local, current, arg.row);
        current = this.assignTarget(arg.target, current);
      }
    }
    return current;
  }

  /** Whether a by-reference argument is `out`, which needs no value, rather than `ref`, which does. */
  private isOutArgument(arg: Extract<BoundArgument, { kind: 'refArgument' }>): boolean {
    return arg.refKind === 'out';
  }

  private initializer(entries: BoundInitializerEntry[], state: State): State {
    let current = state;
    for (const entry of entries) {
      if (entry.kind === 'collectionAdd') current = this.expression(entry.call, current);
      else if (entry.value) current = this.expression(entry.value, current);
      else if (entry.nested) current = this.initializer(entry.nested, current);
    }
    return current;
  }

  /** Analyzes a lambda's body, which may read the locals assigned where it is created. */
  private lambda(method: MethodSymbol, state: State): void {
    if (!method.body) return;
    const savedJumps = this.jumps;
    const savedOut = this.outParameters;
    this.jumps = { breaks: [], continues: [], returns: [] };
    this.outParameters = [];
    const parameters = method.locals.filter((local) => local.isParameter && local.owner === method);
    const start = state === 'unreachable' ? state : new Set([...state, ...parameters]);
    const end = this.statement(method.body, start);
    if (end !== 'unreachable' && method.returnType.kind !== 'void' && method.returnType.kind !== 'error') {
      this.diagnostics.notAllPathsReturn(method.row);
    }
    this.jumps = savedJumps;
    this.outParameters = savedOut;
  }
}

function constantBool(expression: BoundExpression): boolean | undefined {
  return expression.kind === 'constant' && typeof expression.value === 'boolean' ? expression.value : undefined;
}

function isIrrefutable(pattern: BoundPattern): boolean {
  return pattern.kind === 'any';
}

/** The text of a case label in CS0163, as `case 1:` shows its constant. */
function caseText(pattern: BoundPattern): string {
  if (pattern.kind === 'constant' && pattern.value.kind === 'constant') {
    const value = pattern.value.value;
    if (typeof value === 'string') return `"${value}"`;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (value === undefined) return 'null';
    return String(value);
  }
  return '...';
}
