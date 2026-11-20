import type {
  Expression,
  FormalParameters,
  Pattern,
  Span,
  Statement,
  SwitchCase,
  SwitchExpressionCase,
  VariableDeclaration,
} from './ast';

interface Binding {
  syntax: Span;
  functionDepth: number;
}
type Writes = Map<Span, Set<string>>;
type Node = { kind?: string } & Record<string, unknown>;

interface AssignmentTargets {
  locals: Writes;
  captured: Writes;
  free: Set<string>;
}

export function assignmentTargets(root: object, parameters?: FormalParameters): AssignmentTargets {
  const walker = new AssignmentWalker();
  walker.bindParameters(parameters);
  walker.visit(root);
  return walker.targets;
}

export function localNamesIn(statements: readonly Statement[]): Set<string> {
  const names = new Set<string>();
  for (let statement of statements) {
    while (statement.kind === 'labeled') statement = statement.body;
    if (statement.kind === 'local') {
      for (const variable of statement.declaration.variables) names.add(variable.name);
    } else if (statement.kind === 'localFunction') {
      names.add(statement.declaration.name);
    } else if (statement.kind === 'patternDeclaration') {
      visitPattern(statement.pattern, (variable) => names.add(variable.name));
    }
  }
  names.delete('_');
  return names;
}

class AssignmentWalker {
  readonly targets: AssignmentTargets = { locals: new Map(), captured: new Map(), free: new Set() };
  private readonly scopes: Map<string, Binding>[] = [new Map()];
  private depth = 0;

  bindParameters(parameters: FormalParameters | undefined): void {
    if (!parameters) return;
    for (const parameter of [...parameters.positional, ...parameters.named]) this.bind(parameter.name, parameter);
  }

  visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) this.visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as Node;
    if (this.visitScopedNode(node)) return;
    const assigned = assignedName(node);
    if (assigned) this.write(assigned);
    if (node.kind === 'assignedVariable') this.write(node.name as string);
    for (const child of Object.values(node)) this.visit(child);
  }

  // code-gauge-allow functionNcss 52 -- One case per scope introduced by the syntax.
  private visitScopedNode(node: Node): boolean {
    switch (node.kind) {
      case 'block': {
        this.inScope(() => this.visit(node.statements ?? node.block));
        return true;
      }
      case 'variables': {
        for (const syntax of (node as unknown as VariableDeclaration).variables) {
          this.visit(syntax.initializer);
          this.bind(syntax.name, syntax);
        }
        return true;
      }
      case 'patternDeclaration': {
        this.visit(node.value);
        this.bindPattern(node.pattern as Pattern);
        return true;
      }
      case 'function':
      case 'localFunction': {
        const declaration = node.kind === 'localFunction' ? (node.declaration as Node) : node;
        if (!declaration.body) return false;
        if (node.kind === 'localFunction') this.bind(declaration.name as string, declaration as unknown as Span);
        this.visitFunction(declaration);
        return true;
      }
      case 'if':
      case 'ifElement': {
        this.visitIf(node);
        return true;
      }
      case 'while':
      case 'do': {
        this.visit(node.condition);
        this.inScope(() => this.visit(node.body));
        return true;
      }
      case 'for':
      case 'forElement': {
        this.inScope(() => {
          this.visit(node.init);
          this.visit(node.condition);
          this.visit(node.updates);
          this.inScope(() => this.visit(node.body));
        });
        return true;
      }
      case 'forIn':
      case 'forInElement': {
        this.visitForIn(node);
        return true;
      }
      case 'switch': {
        this.visitSwitch(node);
        return true;
      }
      case 'try': {
        this.visitTry(node as unknown as Extract<Statement, { kind: 'try' }>);
        return true;
      }
      default: {
        return false;
      }
    }
  }

  private visitFunction(declaration: Node): void {
    this.depth++;
    try {
      this.inScope(() => {
        this.bindParameters(declaration.parameters as FormalParameters);
        this.visit(declaration.body);
      });
    } finally {
      this.depth--;
    }
  }

  private visitIf(node: Node): void {
    this.visit(node.condition);
    const casePattern = node.casePattern as { pattern: Pattern; guard: Expression | undefined } | undefined;
    this.inScope(() => {
      this.bindPattern(casePattern?.pattern);
      this.visit(casePattern?.guard);
      this.visit(node.consequence ?? node.consequent);
    });
    this.inScope(() => this.visit(node.alternative));
  }

  private visitForIn(node: Node): void {
    this.visit(node.iterable);
    const binding = node.binding as Extract<Statement, { kind: 'forIn' }>['binding'];
    if (binding.kind === 'identifier') this.write(binding.name);
    this.inScope(() => {
      if (binding.kind === 'declaration') this.bind(binding.name, binding);
      if (binding.kind === 'pattern') this.bindPattern(binding.pattern);
      this.visit(node.body);
    });
  }

  private visitTry(node: Extract<Statement, { kind: 'try' }>): void {
    this.visit(node.body);
    for (const clause of node.catches) {
      this.inScope(() => {
        if (clause.exception) this.bind(clause.exception, clause);
        if (clause.stackTrace) this.bind(clause.stackTrace, clause);
        this.visit(clause.body);
      });
    }
    this.visit(node.finally);
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Guards see case bindings, and bodies see bindings shared by adjacent heads.
  private visitSwitch(node: Node): void {
    this.visit(node.subject);
    const cases = node.cases as (SwitchCase | SwitchExpressionCase)[];
    let pending: SwitchCase[] = [];
    for (const branch of cases) {
      this.inScope(() => {
        this.bindPattern(branch.pattern);
        this.visit(branch.guard);
        if ('body' in branch) this.visit(branch.body);
      });
      if (!('statements' in branch)) continue;
      pending.push(branch);
      if (branch.statements.length === 0) continue;
      this.inScope(() => {
        for (const head of pending)
          this.bindPattern(head.pattern, pending.length > 1 || head.labels.length > 0 ? pending[0] : undefined);
        this.visit(branch.statements);
      });
      pending = [];
    }
  }

  private bindPattern(pattern: Pattern | undefined, shared?: Span): void {
    if (!pattern) return;
    const seen = new Set<string>();
    visitPattern(pattern, (variable) => {
      if (seen.has(variable.name)) return;
      seen.add(variable.name);
      this.bind(variable.name, shared ?? variable);
    });
  }

  private bind(name: string, syntax: Span): void {
    if (name !== '_') this.scopes.at(-1)?.set(name, { syntax, functionDepth: this.depth });
  }

  private write(name: string): void {
    for (let index = this.scopes.length - 1; index >= 0; index--) {
      const binding = this.scopes[index].get(name);
      if (!binding) continue;
      addWrite(this.targets.locals, binding.syntax, name);
      if (binding.functionDepth < this.depth) addWrite(this.targets.captured, binding.syntax, name);
      return;
    }
    this.targets.free.add(name);
  }

  private inScope(visit: () => void): void {
    this.scopes.push(new Map());
    try {
      visit();
    } finally {
      this.scopes.pop();
    }
  }
}

function assignedName(node: Node): string | undefined {
  if (node.kind === 'assign') {
    const target = node.target as Expression;
    return target.kind === 'identifier' ? target.name : undefined;
  }
  if (node.kind === 'postfix' || (node.kind === 'prefix' && (node.operator === '++' || node.operator === '--'))) {
    const operand = node.operand as Expression;
    return operand.kind === 'identifier' ? operand.name : undefined;
  }
  return undefined;
}

function addWrite(writes: Writes, syntax: Span, name: string): void {
  const names = writes.get(syntax);
  if (names) names.add(name);
  else writes.set(syntax, new Set([name]));
}

function visitPattern(value: unknown, bind: (variable: Extract<Pattern, { kind: 'variable' }>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitPattern(item, bind);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const node = value as Node;
  if (node.kind === 'variable') {
    bind(value as Extract<Pattern, { kind: 'variable' }>);
    return;
  }
  for (const item of Object.values(node)) visitPattern(item, bind);
}
