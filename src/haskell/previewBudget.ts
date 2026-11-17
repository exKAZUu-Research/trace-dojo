import { LIMITS } from '../interpreter/limits';
import { type Thunk, type Value } from './values';

interface PreviewFamily {
  operations: number;
  operationLimit: number;
  milliseconds: number;
  timeLimit: number;
  views: Map<string, PreviewUsage>;
}

interface PreviewUsage {
  family: PreviewFamily;
  operations: number;
  operationLimit: number;
  milliseconds: number;
  timeLimit: number;
}

interface PreviewCost {
  usage: PreviewUsage;
  operations: number;
}

interface PreviewTransaction {
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
  private readonly familyLimit: number;
  private readonly familyTimeLimit: number;

  constructor(bindings: number) {
    const count = Math.max(1, bindings);
    this.familyLimit = LIMITS.maxOperations / count;
    this.familyTimeLimit = LIMITS.maxMilliseconds / 2;
  }

  spend(operations: number, executionOperations: number, allocations: number): void {
    const active = this.active;
    if (!active) return;
    if (active.forcing) {
      const { usage } = active;
      usage.operations += operations;
      usage.family.operations += operations;
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

  run<T>(owner: object, view: string, share: number, work: () => T): T {
    if (this.active) return work();
    const usage = this.usageFor(owner, view, share);
    const remainingTime = Math.min(
      LIMITS.maxMilliseconds - this.milliseconds,
      usage.timeLimit - usage.milliseconds,
      usage.family.timeLimit - usage.family.milliseconds
    );
    if (remainingTime <= 0) throw new DisplayAbort();
    const started = performance.now();
    this.active = {
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
      for (const { usage, operations } of current.costs) {
        usage.operations -= operations;
        usage.family.operations -= operations;
      }
      executionOperations += current.executionOperations;
      allocations += current.allocations;
      for (const dependency of current.dependencies) pending.push(dependency);
      current.costs = [];
      current.dependencies = [];
    }
    return { operations: executionOperations, allocations };
  }

  private usageFor(owner: object, view: string, share: number): PreviewUsage {
    let family = this.families.get(owner);
    if (!family) {
      family = {
        operations: 0,
        operationLimit: this.familyLimit,
        milliseconds: 0,
        timeLimit: this.familyTimeLimit,
        views: new Map(),
      };
      this.families.set(owner, family);
    }
    let usage = family.views.get(view);
    const operationLimit = family.operationLimit * share;
    const timeLimit = family.timeLimit * share;
    if (!usage) {
      usage = { family, operations: 0, operationLimit, milliseconds: 0, timeLimit };
      family.views.set(view, usage);
    } else {
      usage.operationLimit = Math.min(usage.operationLimit, operationLimit);
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
    return Math.min(usage.operationLimit - usage.operations, usage.family.operationLimit - usage.family.operations);
  }
}
