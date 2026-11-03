import type {
  ArrayInitializer,
  Block,
  BreakStatement,
  ContinueStatement,
  DoStatement,
  Expression,
  ForEachStatement,
  ForStatement,
  LabeledStatement,
  LocalVariableDeclaration,
  Parameter,
  Span,
  Statement,
  SwitchStatement,
  TryStatement,
  WhileStatement,
} from './ast';
import { CompileError } from './diagnostics';
import { booleanConstants } from './reachability';

/**
 * Applies Java's definite assignment rules to the locals of one body: a local is read only after every path
 * assigns it, and a final local is assigned only while no path has assigned it.
 *
 * A final local assigned anywhere in a loop counts as possibly assigned throughout that loop, even where Java
 * proves otherwise (e.g., an assignment followed by `break`), which beginners' programs do not rely on.
 */
export function checkDefiniteAssignment(parameters: readonly Parameter[], body: Block): void {
  const checker = new DefiniteAssignmentChecker();
  let state = checker.initialState();
  for (const parameter of parameters) {
    state = checker.declare(state, parameter.name, parameter.isFinal, true);
  }
  checker.statement(body, state);
}

interface Variable {
  id: number;
  name: string;
  isFinal: boolean;
}

/** The locals definitely assigned (`undefined` when the point is unreachable) and those possibly assigned. */
interface State {
  assigned: ReadonlySet<number> | undefined;
  possiblyAssigned: ReadonlySet<number>;
}

interface Conditional {
  whenTrue: State;
  whenFalse: State;
}

interface JumpTarget {
  label: string | undefined;
  /** Whether an unlabeled `break` exits this statement. */
  isBreakable: boolean;
  /** Whether `continue` targets this statement. */
  isLoop: boolean;
  breaks: State[];
  continues: State[];
}

const UNREACHABLE: State = { assigned: undefined, possiblyAssigned: new Set() };

class DefiniteAssignmentChecker {
  private readonly scopes: Map<string, Variable>[] = [new Map()];
  private readonly targets: JumpTarget[] = [];
  /** The labels written directly before loops and switch statements. */
  private readonly labelsByStatement = new Map<Span, string>();
  private nextId = 0;

  initialState(): State {
    return { assigned: new Set(), possiblyAssigned: new Set() };
  }

  declare(state: State, name: string, isFinal: boolean, isAssigned: boolean): State {
    const variable: Variable = { id: this.nextId++, name, isFinal };
    (this.scopes.at(-1) as Map<string, Variable>).set(name, variable);
    return isAssigned ? assign(state, variable.id) : state;
  }

  // code-gauge-allow functionNcss 35 -- One case per statement kind, each delegating to its own rule.
  statement(statement: Statement, state: State): State {
    switch (statement.kind) {
      case 'block': {
        return this.scoped(() => this.statements(statement.statements, state));
      }
      case 'local': {
        return this.localDeclaration(statement, state);
      }
      case 'expression': {
        return this.expression(statement.expression, state);
      }
      case 'if': {
        const { whenTrue, whenFalse } = this.condition(statement.condition, state);
        const afterThen = this.statement(statement.consequence, whenTrue);
        return join(afterThen, statement.alternative ? this.statement(statement.alternative, whenFalse) : whenFalse);
      }
      case 'while':
      case 'do':
      case 'forEach': {
        return this.simpleLoop(statement, state);
      }
      case 'for': {
        return this.scoped(() => this.forLoop(statement, state));
      }
      case 'switch': {
        return this.switchStatement(statement, state);
      }
      case 'break':
      case 'continue': {
        this.jumpTarget(statement)?.[statement.kind === 'break' ? 'breaks' : 'continues'].push(state);
        return UNREACHABLE;
      }
      case 'return':
      case 'throw': {
        if (statement.value) this.expression(statement.value, state);
        return UNREACHABLE;
      }
      case 'try': {
        return this.tryStatement(statement, state);
      }
      case 'labeled': {
        return this.labeledStatement(statement, state);
      }
      case 'empty': {
        return state;
      }
    }
  }

  private localDeclaration(statement: LocalVariableDeclaration, state: State): State {
    let current = state;
    for (const declarator of statement.declarators) {
      // The variable's scope includes its own initializer, which therefore cannot read it.
      current = this.declare(current, declarator.name, statement.isFinal, false);
      if (!declarator.initializer) continue;
      current = this.initializer(declarator.initializer, current);
      current = assign(current, (this.lookup(declarator.name) as Variable).id);
    }
    return current;
  }

  private simpleLoop(statement: WhileStatement | DoStatement | ForEachStatement, state: State): State {
    switch (statement.kind) {
      case 'while': {
        return this.loop(statement, [statement.condition, statement.body], state, (target, entry) => {
          const { whenTrue, whenFalse } = this.condition(statement.condition, entry);
          const afterBody = this.statement(statement.body, whenTrue);
          return { exit: whenFalse, back: [afterBody, ...target.continues] };
        });
      }
      case 'do': {
        return this.loop(statement, [statement.body, statement.condition], state, (target, entry) => {
          const afterBody = this.statement(statement.body, entry);
          const { whenFalse } = this.condition(statement.condition, join(afterBody, ...target.continues));
          return { exit: whenFalse, back: [] };
        });
      }
      case 'forEach': {
        const afterIterable = this.expression(statement.iterable, state);
        return this.scoped(() =>
          this.loop(statement, [statement.body], afterIterable, (target, entry) => {
            const bound = this.declare(entry, statement.name, statement.isFinal, true);
            const afterBody = this.statement(statement.body, bound);
            return { exit: entry, back: [afterBody, ...target.continues] };
          })
        );
      }
    }
  }

  private jumpTarget(statement: BreakStatement | ContinueStatement): JumpTarget | undefined {
    const { label } = statement;
    if (statement.kind === 'break') {
      return this.targets.findLast((target) => (label === undefined ? target.isBreakable : target.label === label));
    }
    return this.targets.findLast((target) => target.isLoop && (label === undefined || target.label === label));
  }

  private labeledStatement(statement: LabeledStatement, state: State): State {
    if (takesLabelItself(statement.body)) {
      this.labelsByStatement.set(statement.body, statement.label);
      return this.statement(statement.body, state);
    }
    const target = this.pushTarget(statement.label, false, false);
    try {
      return join(this.statement(statement.body, state), ...target.breaks);
    } finally {
      this.targets.pop();
    }
  }

  private statements(statements: readonly Statement[], state: State): State {
    let current = state;
    for (const statement of statements) current = this.statement(statement, current);
    return current;
  }

  private forLoop(statement: ForStatement, state: State): State {
    const init = Array.isArray(statement.init) ? statement.init : [statement.init];
    const afterInit = this.statements(init, state);
    const parts = [...(statement.condition ? [statement.condition] : []), statement.body, ...statement.update];
    return this.loop(statement, parts, afterInit, (target, entry) => {
      const { whenTrue, whenFalse } = statement.condition
        ? this.condition(statement.condition, entry)
        : { whenTrue: entry, whenFalse: UNREACHABLE };
      const afterBody = this.statement(statement.body, whenTrue);
      const afterUpdate = this.statements(statement.update, join(afterBody, ...target.continues));
      return { exit: whenFalse, back: [afterUpdate] };
    });
  }

  /**
   * Analyzes a loop whose head is entered from `state` and from the end of each iteration.
   *
   * @param parts The parts that run on every iteration, whose assignments are possible at the head.
   */
  private loop(
    statement: Span,
    parts: readonly (Statement | Expression)[],
    state: State,
    analyze: (target: JumpTarget, entry: State) => { exit: State; back: State[] }
  ): State {
    const label = this.takeLabel(statement);
    const target = this.pushTarget(label, true, true);
    try {
      const assignedInLoop = parts.flatMap((part) => this.assignedVariables(part));
      const entry = { ...state, possiblyAssigned: new Set([...state.possiblyAssigned, ...assignedInLoop]) };
      const { exit } = analyze(target, entry);
      return join(exit, ...target.breaks);
    } finally {
      this.targets.pop();
    }
  }

  private switchStatement(statement: SwitchStatement, state: State): State {
    const afterSelector = this.expression(statement.selector, state);
    const target = this.pushTarget(this.takeLabel(statement), true, false);
    try {
      return this.scoped(() => {
        let fallthrough = UNREACHABLE;
        const ends: State[] = [];
        for (const group of statement.groups) {
          const entry = statement.isArrowForm ? afterSelector : join(afterSelector, fallthrough);
          const end = this.statements(group.statements, entry);
          if (statement.isArrowForm) ends.push(end);
          else fallthrough = end;
        }
        const hasDefault = statement.groups.some((group) => group.labels.includes(undefined));
        return join(fallthrough, ...ends, ...(hasDefault ? [] : [afterSelector]), ...target.breaks);
      });
    } finally {
      this.targets.pop();
    }
  }

  private tryStatement(statement: TryStatement, state: State): State {
    const afterBody = this.statement(statement.body, state);
    // A catch block may start after any assignment in the try block.
    const possiblyAssigned = new Set([...state.possiblyAssigned, ...this.assignedVariables(statement.body)]);
    const catchEntry: State = { assigned: state.assigned, possiblyAssigned };
    const afterCatches = statement.catches.map((clause) =>
      this.scoped(() =>
        this.statement(clause.body, this.declare(catchEntry, clause.name, clause.types.length > 1, true))
      )
    );
    const afterTryAndCatches = join(afterBody, ...afterCatches);
    if (!statement.finallyBlock) return afterTryAndCatches;
    const finallyEntry: State = {
      assigned: state.assigned,
      possiblyAssigned: new Set([...possiblyAssigned, ...afterCatches.flatMap((after) => [...after.possiblyAssigned])]),
    };
    const afterFinally = this.statement(statement.finallyBlock, finallyEntry);
    if (!afterTryAndCatches.assigned || !afterFinally.assigned) return UNREACHABLE;
    return {
      assigned: new Set([...afterTryAndCatches.assigned, ...afterFinally.assigned]),
      possiblyAssigned: new Set([...afterTryAndCatches.possiblyAssigned, ...afterFinally.possiblyAssigned]),
    };
  }

  private condition(expression: Expression, state: State): Conditional {
    const constant = booleanConstants.get(expression);
    if (constant !== undefined) {
      const after = this.expression(expression, state);
      return constant ? { whenTrue: after, whenFalse: UNREACHABLE } : { whenTrue: UNREACHABLE, whenFalse: after };
    }
    if (expression.kind === 'unary' && expression.operator === '!') {
      const { whenTrue, whenFalse } = this.condition(expression.operand, state);
      return { whenTrue: whenFalse, whenFalse: whenTrue };
    }
    if (expression.kind === 'binary' && (expression.operator === '&&' || expression.operator === '||')) {
      const left = this.condition(expression.left, state);
      if (expression.operator === '&&') {
        const right = this.condition(expression.right, left.whenTrue);
        return { whenTrue: right.whenTrue, whenFalse: join(left.whenFalse, right.whenFalse) };
      }
      const right = this.condition(expression.right, left.whenFalse);
      return { whenTrue: join(left.whenTrue, right.whenTrue), whenFalse: right.whenFalse };
    }
    if (expression.kind === 'conditional') {
      const { whenTrue, whenFalse } = this.condition(expression.condition, state);
      const consequence = this.condition(expression.consequence, whenTrue);
      const alternative = this.condition(expression.alternative, whenFalse);
      return {
        whenTrue: join(consequence.whenTrue, alternative.whenTrue),
        whenFalse: join(consequence.whenFalse, alternative.whenFalse),
      };
    }
    const after = this.expression(expression, state);
    return { whenTrue: after, whenFalse: after };
  }

  // code-gauge-allow functionNcss 37 -- One case per expression kind, most only visiting their operands in order.
  private expression(expression: Expression, state: State): State {
    switch (expression.kind) {
      case 'name': {
        this.read(expression, expression.name, state);
        return state;
      }
      case 'assign': {
        return this.assignment(expression, state);
      }
      case 'update': {
        return this.store(expression.target, state, true);
      }
      case 'binary': {
        if (expression.operator === '&&' || expression.operator === '||') {
          const { whenTrue, whenFalse } = this.condition(expression, state);
          return join(whenTrue, whenFalse);
        }
        return this.expression(expression.right, this.expression(expression.left, state));
      }
      case 'conditional': {
        const { whenTrue, whenFalse } = this.condition(expression.condition, state);
        return join(
          this.expression(expression.consequence, whenTrue),
          this.expression(expression.alternative, whenFalse)
        );
      }
      case 'unary': {
        return this.expression(expression.operand, state);
      }
      case 'cast':
      case 'instanceOf': {
        return this.expression(expression.value, state);
      }
      case 'fieldAccess': {
        return expression.object === 'super' ? state : this.expression(expression.object, state);
      }
      case 'arrayAccess': {
        return this.expression(expression.index, this.expression(expression.array, state));
      }
      case 'call': {
        const receiver =
          expression.object === undefined || expression.object === 'super'
            ? state
            : this.expression(expression.object, state);
        return this.expressions(expression.args, receiver);
      }
      case 'new': {
        return this.expressions(expression.args, state);
      }
      case 'newArray': {
        const afterLengths = this.expressions(expression.dimensionLengths, state);
        return expression.initializer ? this.initializer(expression.initializer, afterLengths) : afterLengths;
      }
      case 'literal':
      case 'this': {
        return state;
      }
    }
  }

  private expressions(expressions: readonly Expression[], state: State): State {
    let current = state;
    for (const expression of expressions) current = this.expression(expression, current);
    return current;
  }

  private initializer(initializer: Expression | ArrayInitializer, state: State): State {
    if (initializer.kind !== 'arrayInitializer') return this.expression(initializer, state);
    let current = state;
    for (const element of initializer.elements) current = this.initializer(element, current);
    return current;
  }

  private assignment(expression: Extract<Expression, { kind: 'assign' }>, state: State): State {
    if (expression.target.kind !== 'name') {
      const afterTarget = this.expression(expression.target, state);
      return this.expression(expression.value, afterTarget);
    }
    if (expression.operator !== '=') this.read(expression.target, expression.target.name, state);
    return this.store(expression.target, this.expression(expression.value, state), false);
  }

  /** Assigns `target`, which an increment or decrement also reads first. */
  private store(target: Expression, state: State, reads: boolean): State {
    if (target.kind !== 'name') return this.expression(target, state);
    const variable = this.lookup(target.name);
    if (!variable) return state;
    if (reads) this.read(target, target.name, state);
    if (variable.isFinal && state.assigned && state.possiblyAssigned.has(variable.id)) {
      throw new CompileError([{ row: target.row, message: `${variable.name} は final なので代入できません。` }]);
    }
    return assign(state, variable.id);
  }

  private read(span: Span, name: string, state: State): void {
    const variable = this.lookup(name);
    if (!variable || !state.assigned || state.assigned.has(variable.id)) return;
    throw new CompileError([{ row: span.row, message: `変数 ${name} に値が代入されていない可能性があります。` }]);
  }

  /** The variables in scope here that `node` assigns anywhere. */
  private assignedVariables(node: Statement | Expression): number[] {
    return assignedNames(node).flatMap((name) => this.lookup(name)?.id ?? []);
  }

  private lookup(name: string): Variable | undefined {
    for (let index = this.scopes.length - 1; index >= 0; index--) {
      const variable = this.scopes[index].get(name);
      if (variable) return variable;
    }
    return;
  }

  private scoped<T>(analyze: () => T): T {
    this.scopes.push(new Map());
    try {
      return analyze();
    } finally {
      this.scopes.pop();
    }
  }

  private pushTarget(label: string | undefined, isBreakable: boolean, isLoop: boolean): JumpTarget {
    const target: JumpTarget = { label, isBreakable, isLoop, breaks: [], continues: [] };
    this.targets.push(target);
    return target;
  }

  private takeLabel(statement: Span): string | undefined {
    return this.labelsByStatement.get(statement);
  }
}

/** Whether a label written before `statement` names `statement` itself as the target of `break` or `continue`. */
function takesLabelItself(statement: Statement): boolean {
  return ['while', 'do', 'for', 'forEach', 'switch'].includes(statement.kind);
}

/** The simple names that `node` assigns or increments anywhere. */
export function assignedNames(node: Statement | Expression): string[] {
  const names: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object' || !value) return;
    const record = value as Record<string, unknown>;
    const target = record.kind === 'assign' || record.kind === 'update' ? (record.target as Expression) : undefined;
    if (target?.kind === 'name') names.push(target.name);
    for (const child of Object.values(record)) visit(child);
  };
  visit(node);
  return names;
}

function assign(state: State, id: number): State {
  if (!state.assigned) return state;
  return { assigned: new Set([...state.assigned, id]), possiblyAssigned: new Set([...state.possiblyAssigned, id]) };
}

function join(...states: State[]): State {
  const reachable = states.filter((state) => state.assigned !== undefined);
  if (reachable.length === 0) return UNREACHABLE;
  const [first, ...rest] = reachable;
  const assigned = [...(first.assigned as ReadonlySet<number>)].filter((id) =>
    rest.every((state) => state.assigned?.has(id))
  );
  return {
    assigned: new Set(assigned),
    possiblyAssigned: new Set(reachable.flatMap((state) => [...state.possiblyAssigned])),
  };
}
