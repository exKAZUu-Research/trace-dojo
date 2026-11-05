// code-gauge-allow-file fileNcss 415 -- One checker for the definite assignment rules of JLS chapter 16, which share its scopes and states.
import { CompileError } from '../interpreter/diagnostics';
import {
  assign,
  type Conditional,
  join,
  type State,
  takesLabelItself,
  throughFinally,
  UNREACHABLE,
} from './assignmentStates';
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
  SwitchExpression,
  SwitchStatement,
  TryStatement,
  WhileStatement,
} from './ast';
import { booleanConstants, exhaustiveSwitches } from './reachability';

/**
 * What definite assignment analysis leaves for the compiler to check against the locals that lambdas and local
 * classes read, which it records as it compiles them. Locals are identified by {@link declarationKey}.
 */
export interface AssignmentFacts {
  /** The locals that are not effectively final (JLS 4.12.4), which no lambda or local class may read. */
  notEffectivelyFinal: ReadonlySet<string>;
  /**
   * The lambdas and local or anonymous classes, with the locals not definitely assigned where they appear, which
   * their bodies may not read (JLS 16.1.10, 8.1.3).
   */
  unassignedAtCreations: readonly { span: Span; keys: ReadonlySet<string> }[];
}

/**
 * Applies Java's definite assignment rules to the locals of one method body: a local is read only after every
 * path assigns it, and a final local is assigned only while no path has assigned it.
 */
export function checkDefiniteAssignment(parameters: readonly Parameter[], body: Block): AssignmentFacts {
  const checker = new DefiniteAssignmentChecker();
  checker.statement(body, checker.declareParameters(checker.initialState(), parameters));
  return checker;
}

/** Identifies a local by its name and where it is declared, as the compiler and this analysis both see it. */
export function declarationKey(name: string, declaration: Span): string {
  return `${name}@${declaration.row}:${declaration.start}`;
}

interface Variable {
  id: number;
  name: string;
  isFinal: boolean;
  /** Whether the variable gets its value where it is declared, which makes a final one never assignable. */
  isInitialized: boolean;
  /** Where a local is declared, which identifies it to the compiler, or `undefined` for a field. */
  declaration?: Span;
}

/**
 * A loop being analyzed, with the assignments in it to blank locals declared before it, which a later iteration
 * must not find already assigned, for a final one, or which make one not effectively final.
 */
interface EnclosingLoop {
  /** Variables with smaller ids were declared before the loop. */
  firstId: number;
  blankWrites: { variable: Variable; span: Span }[];
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

export class DefiniteAssignmentChecker {
  private readonly scopes: Map<string, Variable>[] = [new Map()];
  /** Blank final fields, which `this.name` names even where a local hides the simple name. */
  private readonly fields = new Map<string, Variable>();
  /** The states at `return` statements, where a constructor ends too. */
  readonly returns: State[] = [];
  private readonly targets: JumpTarget[] = [];
  /** The states at the yields of the switch expressions being analyzed, innermost last. */
  private readonly yields: State[][] = [];
  private readonly loops: EnclosingLoop[] = [];
  /** The sets collecting assignments for the statements being analyzed, innermost last. */
  private readonly writeLogs: Set<number>[] = [];
  /** The labels written directly before loops and switch statements. */
  private readonly labelsByStatement = new Map<Span, string>();
  private nextId = 0;
  /**
   * The keys of the locals that are not effectively final: assigned after being initialized, assigned where they may
   * already be assigned, or incremented, as if they were final (JLS 4.12.4).
   */
  readonly notEffectivelyFinal = new Set<string>();
  readonly unassignedAtCreations: { span: Span; keys: ReadonlySet<string> }[] = [];

  initialState(): State {
    return { assigned: new Set(), possiblyAssigned: new Set() };
  }

  declareParameters(state: State, parameters: readonly Parameter[]): State {
    this.scopes.push(new Map());
    let current = state;
    for (const parameter of parameters) {
      current = this.declare(current, parameter.name, parameter.isFinal, true, true, parameter);
    }
    return current;
  }

  declareField(state: State, name: string): State {
    const declared = this.declare(state, name, true, false);
    this.fields.set(name, this.lookup(name) as Variable);
    return declared;
  }

  assignField(state: State, name: string): State {
    return assign(state, (this.fields.get(name) as Variable).id);
  }

  isFieldAssigned(state: State, name: string): boolean {
    return state.assigned?.has((this.fields.get(name) as Variable).id) ?? true;
  }

  /**
   * @param isInitialized Whether the variable gets its value where it is declared, as parameters do; a for-each
   *   variable is assigned on entry to each iteration but stays subject to the flow rules, as javac treats it.
   */
  declare(
    state: State,
    name: string,
    isFinal: boolean,
    isAssigned: boolean,
    isInitialized = isAssigned,
    declaration?: Span
  ): State {
    const variable: Variable = { id: this.nextId++, name, isFinal, isInitialized, declaration };
    (this.scopes.at(-1) as Map<string, Variable>).set(name, variable);
    return isAssigned ? assign(state, variable.id) : state;
  }

  // code-gauge-allow functionNcss 48 -- One case per statement kind, each delegating to its own rule.
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
      case 'return': {
        this.returns.push(statement.value ? this.expression(statement.value, state) : state);
        return UNREACHABLE;
      }
      case 'throw': {
        this.expression(statement.value, state);
        return UNREACHABLE;
      }
      case 'try': {
        return statement.resources.length === 0
          ? this.tryStatement(statement, state)
          : this.tryWithResources(statement, state);
      }
      case 'labeled': {
        return this.labeledStatement(statement, state);
      }
      case 'yield': {
        this.yields.at(-1)?.push(this.expression(statement.value, state));
        return UNREACHABLE;
      }
      case 'synchronized': {
        return this.statement(statement.body, this.expression(statement.lock, state));
      }
      // An assertion may not run, so what it assigns stays unassigned after it.
      case 'assert': {
        const { whenFalse } = this.condition(statement.condition, state);
        if (statement.message) this.expression(statement.message, whenFalse);
        return state;
      }
      // A local class's methods run later, and their own analysis covers them.
      case 'localClass': {
        return this.recordCreation(statement.declaration, state);
      }
      case 'empty': {
        return state;
      }
    }
  }

  /** A switch expression's value comes from its yields, which its groups reach as a switch statement's would. */
  private switchExpression(expression: SwitchExpression, state: State): State {
    const afterSelector = this.expression(expression.selector, state);
    const yields: State[] = [];
    this.yields.push(yields);
    try {
      this.scoped(() => {
        let fallthrough = UNREACHABLE;
        for (const group of expression.groups) {
          const entry = expression.isArrowForm ? afterSelector : join(afterSelector, fallthrough);
          fallthrough = this.statements(group.statements, entry);
        }
      });
    } finally {
      this.yields.pop();
    }
    return join(...yields);
  }

  private localDeclaration(statement: LocalVariableDeclaration, state: State): State {
    let current = state;
    for (const declarator of statement.declarators) {
      // The variable's scope includes its own initializer, which therefore cannot read it.
      current = this.declare(current, declarator.name, statement.isFinal, false, false, declarator);
      if (!declarator.initializer) continue;
      const variable = this.lookup(declarator.name) as Variable;
      variable.isInitialized = true;
      current = assign(this.initializer(declarator.initializer, current), variable.id);
    }
    return current;
  }

  private simpleLoop(statement: WhileStatement | DoStatement | ForEachStatement, state: State): State {
    switch (statement.kind) {
      case 'while': {
        return this.loop(statement, state, (target, entry) => {
          const { whenTrue, whenFalse } = this.condition(statement.condition, entry);
          const afterBody = this.statement(statement.body, whenTrue);
          return { exit: whenFalse, back: [afterBody, ...target.continues] };
        });
      }
      case 'do': {
        return this.loop(statement, state, (target, entry) => {
          const afterBody = this.statement(statement.body, entry);
          const { whenTrue, whenFalse } = this.condition(statement.condition, join(afterBody, ...target.continues));
          return { exit: whenFalse, back: [whenTrue] };
        });
      }
      case 'forEach': {
        const afterIterable = this.expression(statement.iterable, state);
        return this.scoped(() =>
          this.loop(statement, afterIterable, (target, entry) => {
            const bound = this.declare(entry, statement.name, statement.isFinal, true, false, statement);
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
    return this.loop(statement, afterInit, (target, entry) => {
      const { whenTrue, whenFalse } = statement.condition
        ? this.condition(statement.condition, entry)
        : { whenTrue: entry, whenFalse: UNREACHABLE };
      const afterBody = this.statement(statement.body, whenTrue);
      const afterUpdate = this.statements(statement.update, join(afterBody, ...target.continues));
      return { exit: whenFalse, back: [afterUpdate] };
    });
  }

  /**
   * Analyzes a loop whose head is entered from `state` and, through `back`, from the end of each iteration.
   *
   * A final assigned in the loop must not be possibly assigned at the head, where a later iteration starts, so each
   * such assignment is checked against the back edges once they are known.
   */
  private loop(
    statement: Span,
    state: State,
    analyze: (target: JumpTarget, entry: State) => { exit: State; back: State[] }
  ): State {
    const target = this.pushTarget(this.takeLabel(statement), true, true);
    const enclosing: EnclosingLoop = { firstId: this.nextId, blankWrites: [] };
    this.loops.push(enclosing);
    try {
      const { exit, back } = analyze(target, state);
      const assignedOnBackEdges = new Set(back.flatMap((edge) => [...edge.possiblyAssigned]));
      for (const { variable, span } of enclosing.blankWrites) {
        if (!assignedOnBackEdges.has(variable.id)) continue;
        if (variable.isFinal) this.finalAssignmentError(span, variable);
        this.markNotEffectivelyFinal(variable);
      }
      // The exit leaves from the head, which later iterations reach too.
      const exitFromHead = {
        ...exit,
        possiblyAssigned: new Set([...exit.possiblyAssigned, ...assignedOnBackEdges]),
      };
      return join(exitFromHead, ...target.breaks);
    } finally {
      this.loops.pop();
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
        const hasDefault =
          statement.groups.some((group) => group.labels.includes(undefined)) || exhaustiveSwitches.has(statement);
        return join(fallthrough, ...ends, ...(hasDefault ? [] : [afterSelector]), ...target.breaks);
      });
    } finally {
      this.targets.pop();
    }
  }

  /** A try-with-resources statement, whose resources are declared before its try block runs. */
  private tryWithResources(statement: TryStatement, state: State): State {
    return this.scoped(() => {
      let current = state;
      for (const resource of statement.resources) {
        current =
          'local' in resource
            ? this.localDeclaration(resource.local, current)
            : this.expression(resource.expression, current);
      }
      return this.tryStatement({ ...statement, resources: [] }, current);
    });
  }

  private tryStatement(statement: TryStatement, state: State): State {
    // Jumps out of the try statement also run its finally block on the way.
    const jumpCounts = this.targets.map((target) => [target.breaks.length, target.continues.length] as const);
    const returnCount = this.returns.length;
    const { result: afterBody, written: writtenInBody } = this.recordingWrites(() =>
      this.statement(statement.body, state)
    );
    // A catch block may start after any assignment in the try block.
    const possiblyAssigned = new Set([...state.possiblyAssigned, ...writtenInBody]);
    const catchEntry: State = { assigned: state.assigned, possiblyAssigned };
    const { result: afterCatches, written: writtenInCatches } = this.recordingWrites(() =>
      statement.catches.map((clause) =>
        this.scoped(() =>
          this.statement(
            clause.body,
            this.declare(catchEntry, clause.name, clause.isFinal || clause.types.length > 1, true, true, clause)
          )
        )
      )
    );
    const afterTryAndCatches = join(afterBody, ...afterCatches);
    if (!statement.finallyBlock) return afterTryAndCatches;
    // The finally block may start after any assignment in the try or catch blocks, including abrupt paths.
    const finallyEntry: State = {
      assigned: state.assigned,
      possiblyAssigned: new Set([...possiblyAssigned, ...writtenInCatches]),
    };
    // Jumps taken inside the finally block itself leave from where they are, unchanged.
    const jumpsBeforeFinally = this.targets.map((target) => [target.breaks.length, target.continues.length] as const);
    const returnsBeforeFinally = this.returns.length;
    const afterFinally = this.statement(statement.finallyBlock, finallyEntry);
    for (const [index, [breakCount, continueCount]] of jumpCounts.entries()) {
      const target = this.targets[index];
      const [breaksBeforeFinally, continuesBeforeFinally] = jumpsBeforeFinally[index];
      for (const [jumps, from, to] of [
        [target.breaks, breakCount, breaksBeforeFinally],
        [target.continues, continueCount, continuesBeforeFinally],
      ] as const) {
        for (let jump = from; jump < to; jump++) jumps[jump] = throughFinally(jumps[jump], afterFinally);
      }
    }
    for (let index = returnCount; index < returnsBeforeFinally; index++) {
      this.returns[index] = throughFinally(this.returns[index], afterFinally);
    }
    return throughFinally(afterTryAndCatches, afterFinally);
  }

  private condition(expression: Expression, state: State): Conditional {
    const constant = booleanConstants.get(expression);
    // A constant expression neither assigns nor reads a variable that may be unassigned.
    if (constant !== undefined) {
      return constant ? { whenTrue: state, whenFalse: UNREACHABLE } : { whenTrue: UNREACHABLE, whenFalse: state };
    }
    // A boolean cast passes its operand's value through, so it decides like the operand.
    if (expression.kind === 'cast') return this.condition(expression.value, state);
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

  // code-gauge-allow functionCognitiveComplexity 17 -- One case per expression kind, most only visiting their operands.
  // code-gauge-allow functionNcss 50 -- One case per expression kind, most only visiting their operands in order.
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
      case 'switchExpression': {
        return this.switchExpression(expression, state);
      }
      // A lambda's body runs later, and its own analysis covers it; it cannot assign the enclosing locals.
      case 'lambda': {
        return this.recordCreation(expression, state);
      }
      case 'classLiteral':
      case 'typeRef': {
        return state;
      }
      case 'methodRef': {
        return 'expression' in expression.target ? this.expression(expression.target.expression, state) : state;
      }
      case 'fieldAccess': {
        const field = this.thisField(expression);
        if (field) this.readVariable(expression, field, state);
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
        const afterArgs = this.expressions(expression.args, state);
        return expression.body ? this.recordCreation(expression, afterArgs) : afterArgs;
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

  expressions(expressions: readonly Expression[], state: State): State {
    let current = state;
    for (const expression of expressions) current = this.expression(expression, current);
    return current;
  }

  initializer(initializer: Expression | ArrayInitializer, state: State): State {
    if (initializer.kind !== 'arrayInitializer') return this.expression(initializer, state);
    let current = state;
    for (const element of initializer.elements) current = this.initializer(element, current);
    return current;
  }

  private assignment(expression: Extract<Expression, { kind: 'assign' }>, state: State): State {
    const { target } = expression;
    const variable = target.kind === 'name' ? this.lookup(target.name) : this.thisField(target);
    if (!variable) {
      const afterTarget = target.kind === 'name' ? state : this.expression(target, state);
      return this.expression(expression.value, afterTarget);
    }
    if (expression.operator !== '=') this.readVariable(target, variable, state);
    return this.store(target, this.expression(expression.value, state), false);
  }

  /** Assigns `target`, which an increment or decrement also reads first. */
  private store(target: Expression, state: State, reads: boolean): State {
    const variable = target.kind === 'name' ? this.lookup(target.name) : this.thisField(target);
    if (!variable) return target.kind === 'name' ? state : this.expression(target, state);
    if (reads) this.readVariable(target, variable, state);
    for (const log of this.writeLogs) log.add(variable.id);
    if (variable.isFinal) this.checkFinalWrite(target, variable, state);
    else if (variable.declaration) this.checkEffectivelyFinalWrite(target, variable, state, reads);
    return assign(state, variable.id);
  }

  /** Records a local that a write makes not effectively final, as a final one would be rejected for it. */
  private checkEffectivelyFinalWrite(span: Span, variable: Variable, state: State, reads: boolean): void {
    // An initialized local is never assigned, nor any local incremented, even where the code cannot run (JLS 4.12.4).
    if (reads || variable.isInitialized) {
      this.markNotEffectivelyFinal(variable);
      return;
    }
    if (!state.assigned) return;
    if (state.possiblyAssigned.has(variable.id)) {
      this.markNotEffectivelyFinal(variable);
      return;
    }
    for (const loop of this.loops) {
      if (variable.id < loop.firstId) loop.blankWrites.push({ variable, span });
    }
  }

  /** Records the locals not definitely assigned where a lambda or a local or anonymous class appears. */
  private recordCreation(span: Span, state: State): State {
    const { assigned } = state;
    const unassigned = this.scopes
      .flatMap((scope) => [...scope.values()])
      .filter((variable) => variable.declaration && assigned && !assigned.has(variable.id));
    const keys = new Set(unassigned.map((variable) => declarationKey(variable.name, variable.declaration as Span)));
    if (keys.size > 0) this.unassignedAtCreations.push({ span, keys });
    return state;
  }

  private markNotEffectivelyFinal(variable: Variable): void {
    if (variable.declaration) this.notEffectivelyFinal.add(declarationKey(variable.name, variable.declaration));
  }

  private checkFinalWrite(span: Span, variable: Variable, state: State): void {
    // An initialized final is never assignable, even where the assignment cannot run.
    if (variable.isInitialized) this.finalAssignmentError(span, variable);
    if (!state.assigned) return;
    if (state.possiblyAssigned.has(variable.id)) this.finalAssignmentError(span, variable);
    for (const loop of this.loops) {
      if (variable.id < loop.firstId) loop.blankWrites.push({ variable, span });
    }
  }

  private finalAssignmentError(span: Span, variable: Variable): never {
    throw new CompileError([{ row: span.row, message: `${variable.name} は final なので代入できません。` }]);
  }

  private read(span: Span, name: string, state: State): void {
    const variable = this.lookup(name);
    if (variable) this.readVariable(span, variable, state);
  }

  private readVariable(span: Span, variable: Variable, state: State): void {
    if (!state.assigned || state.assigned.has(variable.id)) return;
    throw new CompileError([
      { row: span.row, message: `変数 ${variable.name} に値が代入されていない可能性があります。` },
    ]);
  }

  /** The blank final field that `this.name` names. */
  private thisField(expression: Expression): Variable | undefined {
    if (expression.kind !== 'fieldAccess' || expression.object === 'super' || expression.object.kind !== 'this') return;
    return this.fields.get(expression.name);
  }

  /** Runs `analyze`, collecting the variables it assigns on any path, resolved where each assignment is. */
  private recordingWrites<T>(analyze: () => T): { result: T; written: Set<number> } {
    const written = new Set<number>();
    this.writeLogs.push(written);
    try {
      return { result: analyze(), written };
    } finally {
      this.writeLogs.pop();
    }
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

export { assignedNames } from './assignmentStates';
