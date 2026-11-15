import type { Block, Statement } from './ast';

interface Node {
  next: Node[];
  statement?: Statement;
}

interface Targets {
  breaks: Map<string, Node>;
  continues: Map<string, Node>;
  fallthrough?: Node;
}

export class StatementFlow {
  private readonly points = new Map<Statement, { before: Node; entry: Node }>();
  private readonly labels = new Map<string, Node>();
  private readonly jumps: { node: Node; label: string }[] = [];
  private readonly root: Node;
  private reached: Set<Node> | undefined;

  constructor(
    body: Block,
    private readonly terminates: (statement: Statement) => boolean
  ) {
    this.root = this.list(body.statements, { next: [] }, { breaks: new Map(), continues: new Map() });
    for (const { node, label } of this.jumps) {
      const target = this.labels.get(label);
      if (target) node.next.push(target);
    }
  }

  reaches(statement: Statement, before = false): boolean {
    const point = this.points.get(statement);
    return point ? (this.reached ?? this.walk()).has(before ? point.before : point.entry) : true;
  }

  seal(): void {
    this.reached = this.walk();
  }

  private walk(): Set<Node> {
    const reached = new Set<Node>();
    const pending = [this.root];
    while (pending.length > 0) {
      const node = pending.pop() as Node;
      if (reached.has(node)) continue;
      reached.add(node);
      if (!node.statement || !this.terminates(node.statement)) pending.push(...node.next);
    }
    return reached;
  }

  private list(statements: Statement[], next: Node, targets: Targets): Node {
    let entry = next;
    for (let index = statements.length - 1; index >= 0; index--)
      entry = this.statement(statements[index], entry, targets);
    return entry;
  }

  // code-gauge-allow functionNcss 43 -- Links structured statements, labels and their normal or abrupt successors in one control-flow graph.
  private statement(statement: Statement, next: Node, targets: Targets, label = ''): Node {
    const after: Node = { next: [next] };
    const entry: Node = { next: [], statement };
    const before: Node = { next: [entry] };
    this.points.set(statement, { before, entry });
    switch (statement.kind) {
      case 'goto': {
        this.jumps.push({ node: entry, label: statement.label });
        break;
      }
      case 'return': {
        break;
      }
      case 'break':
      case 'continue': {
        const target = (statement.kind === 'break' ? targets.breaks : targets.continues).get(statement.label ?? '');
        if (target) entry.next.push(target);
        break;
      }
      case 'fallthrough': {
        if (targets.fallthrough) entry.next.push(targets.fallthrough);
        break;
      }
      case 'labeled': {
        this.labels.set(statement.label, entry);
        entry.next.push(this.statement(statement.statement, after, targets, statement.label));
        break;
      }
      case 'block': {
        entry.next.push(this.list(statement.block.statements, after, targets));
        break;
      }
      case 'if': {
        this.conditional(statement, entry, after, targets);
        break;
      }
      case 'for':
      case 'range': {
        this.loop(statement, entry, after, targets, label);
        break;
      }
      case 'switch':
      case 'typeSwitch':
      case 'select': {
        this.branches(statement, entry, after, targets, label);
        break;
      }
      default: {
        entry.next.push(after);
      }
    }
    return before;
  }
  private conditional(statement: Extract<Statement, { kind: 'if' }>, entry: Node, after: Node, targets: Targets): void {
    const branch: Node = { next: [this.list(statement.consequence.statements, after, targets)] };
    const alternative = statement.alternative;
    branch.next.push(
      !alternative
        ? after
        : 'kind' in alternative
          ? this.statement(alternative, after, targets)
          : this.list(alternative.statements, after, targets)
    );
    entry.next.push(statement.init ? this.statement(statement.init, branch, targets) : branch);
  }

  private loop(
    statement: Extract<Statement, { kind: 'for' | 'range' }>,
    entry: Node,
    after: Node,
    targets: Targets,
    label: string
  ): void {
    const condition: Node = { next: [] };
    const post =
      statement.kind === 'for' && statement.post ? this.statement(statement.post, condition, targets) : condition;
    const loop = {
      ...targets,
      breaks: new Map(targets.breaks).set('', after).set(label, after),
      continues: new Map(targets.continues).set('', post).set(label, post),
    };
    condition.next.push(this.list(statement.body.statements, post, loop));
    if (statement.kind === 'range' || statement.condition) condition.next.push(after);
    entry.next.push(
      statement.kind === 'for' && statement.init ? this.statement(statement.init, condition, targets) : condition
    );
  }

  private branches(
    statement: Extract<Statement, { kind: 'switch' | 'typeSwitch' | 'select' }>,
    entry: Node,
    after: Node,
    targets: Targets,
    label: string
  ): void {
    const cases: Node[] = [];
    const branchTargets = { ...targets, breaks: new Map(targets.breaks).set('', after).set(label, after) };
    let fallthrough = after;
    for (let index = statement.cases.length - 1; index >= 0; index--) {
      const branch = this.list(statement.cases[index].body, after, { ...branchTargets, fallthrough });
      cases.push(branch);
      fallthrough = branch;
    }
    if (
      statement.kind !== 'select' &&
      !statement.cases.some((branch) => ('values' in branch ? !branch.values : 'types' in branch && !branch.types))
    )
      cases.push(after);
    const dispatch: Node = { next: cases };
    entry.next.push(
      statement.kind !== 'select' && statement.init ? this.statement(statement.init, dispatch, targets) : dispatch
    );
  }
}
