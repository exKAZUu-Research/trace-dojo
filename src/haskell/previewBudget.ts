import { LIMITS } from '../interpreter/limits';
import { type Thunk, type Value } from './values';

interface PreviewFamily {
  activeScopes: number;
  operations: number;
  milliseconds: number;
  timeLimit: number;
  views: Map<string, PreviewUsage>;
}

interface PreviewUsage {
  family: PreviewFamily;
  operations: number;
  share: number;
  milliseconds: number;
  timeLimit: number;
}

export interface PreviewView {
  owner: object;
  frame: object;
  key: string;
  share: number;
}

interface PreviewScope {
  statement: object | undefined;
  families: Set<PreviewFamily>;
}

interface PreviewCost {
  usage: PreviewUsage;
  operations: number;
}

interface PreviewTransaction {
  scope: PreviewScope;
  usage: PreviewUsage;
  deadline: number;
  forcing: boolean;
  frames: PreviewFrame[];
}

interface PreviewDebt {
  costs: PreviewCost[];
  executionOperations: number;
  allocations: number;
  consumed: boolean;
  dependencies: PreviewDebt[];
}

interface PreviewFrame {
  thunk: Thunk;
  debt: PreviewDebt;
  costs: PreviewCost[] | undefined;
  executionOperations: number;
  allocations: number;
  dependenciesLength: number;
}

export class DisplayAbort extends Error {
  constructor() {
    super('Display evaluation exceeded its budget');
    this.name = 'DisplayAbort';
  }
}

export class PreviewBudget {
  private readonly families = new WeakMap<object, PreviewFamily>();
  private readonly debts = new WeakMap<Thunk, PreviewDebt>();
  private readonly aborted = new WeakMap<Thunk, WeakSet<PreviewUsage>>();
  private milliseconds = 0;
  private active: PreviewTransaction | undefined;
  private operations = 0;
  private readonly scopes = new Map<object, PreviewScope>();
  private activeFamilies = 0;
  private readonly familyTimeLimit = LIMITS.maxMilliseconds / 2;

  beginStatement(statement: object, frame: object): void {
    const scope = this.scopeFor(frame);
    scope.statement ??= statement;
  }

  endStatement(statement: object, frame: object): void {
    if (this.scopes.get(frame)?.statement === statement) this.endFrame(frame);
  }

  endFrame(frame: object): void {
    const scope = this.scopes.get(frame);
    if (!scope) return;
    this.scopes.delete(frame);
    for (const family of scope.families) {
      family.activeScopes--;
      if (family.activeScopes === 0) this.activeFamilies--;
    }
  }

  spend(operations: number, executionOperations: number, allocations: number): void {
    const active = this.active;
    if (!active) return;
    if (active.forcing) {
      const { usage } = active;
      usage.operations += operations;
      usage.family.operations += operations;
      this.operations += operations;
      const debt = active.frames.at(-1)?.debt;
      if (debt) {
        const previous = debt.costs.at(-1);
        if (previous?.usage === usage) previous.operations += operations;
        else debt.costs.push({ usage, operations });
        debt.executionOperations += executionOperations;
        debt.allocations += allocations;
      }
      if (this.remainingOperations(usage) < 0) throw new DisplayAbort();
    }
    if (performance.now() > active.deadline) throw new DisplayAbort();
  }

  force(slot: Thunk, work: () => Value): Value {
    const active = this.active;
    if (!active) throw new Error('Preview evaluation requires a display view');
    if (this.aborted.get(slot)?.has(active.usage)) throw new DisplayAbort();
    const family = active.usage.family;
    if (!active.scope.families.has(family)) {
      active.scope.families.add(family);
      if (family.activeScopes++ === 0) this.activeFamilies++;
    }
    if (this.remainingOperations(active.usage) <= 0) throw new DisplayAbort();
    const savedForcing = active.forcing;
    active.forcing = true;
    try {
      return work();
    } catch (error) {
      if (error instanceof DisplayAbort) {
        let failed = this.aborted.get(slot);
        if (!failed) {
          failed = new WeakSet();
          this.aborted.set(slot, failed);
        }
        failed.add(active.usage);
      }
      throw error;
    } finally {
      active.forcing = savedForcing;
    }
  }

  run<T>(view: PreviewView, work: () => T): T {
    if (this.active) return work();
    const usage = this.usageFor(view.owner, view.key, view.share);
    const remainingTime = Math.min(
      LIMITS.maxMilliseconds - this.milliseconds,
      usage.timeLimit - usage.milliseconds,
      usage.family.timeLimit - usage.family.milliseconds
    );
    if (remainingTime <= 0) throw new DisplayAbort();
    const started = performance.now();
    this.active = {
      scope: this.scopeFor(view.frame),
      usage,
      deadline: started + remainingTime,
      forcing: false,
      frames: [],
    };
    try {
      return work();
    } finally {
      const elapsed = performance.now() - started;
      this.milliseconds += elapsed;
      usage.milliseconds += elapsed;
      usage.family.milliseconds += elapsed;
      this.active = undefined;
    }
  }

  enter(thunk: Thunk): void {
    const active = this.active;
    if (!active?.forcing) return;
    const debt = this.debtFor(thunk);
    active.frames.push({
      thunk,
      debt,
      costs: debt.costs.length > 0 ? debt.costs.map((cost) => ({ ...cost })) : undefined,
      executionOperations: debt.executionOperations,
      allocations: debt.allocations,
      dependenciesLength: debt.dependencies.length,
    });
  }

  leave(thunk: Thunk, aborted: boolean): void {
    const active = this.active;
    if (!active?.forcing) return;
    const frame = active.frames.pop();
    if (frame?.thunk !== thunk) throw new Error('Unbalanced preview thunk frames');
    if (!aborted) return;
    const { debt } = frame;
    if (frame.costs) debt.costs = frame.costs;
    else debt.costs.length = 0;
    debt.executionOperations = frame.executionOperations;
    debt.allocations = frame.allocations;
    debt.dependencies.length = frame.dependenciesLength;
  }

  consume(slot: Thunk, demanded: boolean): { operations: number; allocations: number } | undefined {
    const active = this.active;
    if (!demanded) {
      if (!active?.forcing) return;
      const debt = slot.state === 'pending' ? this.debtFor(slot) : this.debts.get(slot);
      const parent = active.frames.at(-1)?.debt;
      if (debt && !debt.consumed && parent && parent !== debt) parent.dependencies.push(debt);
      return;
    }
    const debt = this.debts.get(slot);
    if (!debt || debt.consumed) return;
    return this.settleDebt(debt);
  }

  private settleDebt(debt: PreviewDebt): { operations: number; allocations: number } {
    const pending = [debt];
    let executionOperations = 0;
    let allocations = 0;
    while (pending.length > 0) {
      const current = pending.pop() as PreviewDebt;
      if (current.consumed) continue;
      current.consumed = true;
      for (const cost of current.costs) this.refund(cost);
      executionOperations += current.executionOperations;
      allocations += current.allocations;
      for (const dependency of current.dependencies) pending.push(dependency);
      current.costs = [];
      current.dependencies = [];
    }
    return { operations: executionOperations, allocations };
  }

  private refund({ usage, operations }: PreviewCost): void {
    if (operations > 0) {
      const milliseconds = (usage.milliseconds * operations) / usage.operations;
      usage.milliseconds -= milliseconds;
      usage.family.milliseconds = Math.max(0, usage.family.milliseconds - milliseconds);
    }
    usage.operations -= operations;
    usage.family.operations -= operations;
    this.operations -= operations;
  }

  private scopeFor(frame: object): PreviewScope {
    let scope = this.scopes.get(frame);
    if (!scope) {
      scope = { statement: undefined, families: new Set() };
      this.scopes.set(frame, scope);
    }
    return scope;
  }

  private usageFor(owner: object, view: string, share: number): PreviewUsage {
    let family = this.families.get(owner);
    if (!family) {
      family = {
        activeScopes: 0,
        operations: 0,
        milliseconds: 0,
        timeLimit: this.familyTimeLimit,
        views: new Map(),
      };
      this.families.set(owner, family);
    }
    let usage = family.views.get(view);
    const timeLimit = family.timeLimit * share;
    if (!usage) {
      usage = { family, operations: 0, share, milliseconds: 0, timeLimit };
      family.views.set(view, usage);
    } else {
      usage.share = Math.min(usage.share, share);
      usage.timeLimit = Math.min(usage.timeLimit, timeLimit);
    }
    return usage;
  }

  private debtFor(slot: Thunk): PreviewDebt {
    let debt = this.debts.get(slot);
    if (!debt || debt.consumed) {
      debt = {
        costs: [],
        executionOperations: 0,
        allocations: 0,
        consumed: false,
        dependencies: [],
      };
      this.debts.set(slot, debt);
    }
    return debt;
  }

  private remainingOperations(usage: PreviewUsage): number {
    const limit = LIMITS.maxOperations / Math.max(2, this.activeFamilies);
    return Math.min(
      LIMITS.maxOperations - this.operations,
      limit * usage.share - usage.operations,
      limit - usage.family.operations
    );
  }
}
