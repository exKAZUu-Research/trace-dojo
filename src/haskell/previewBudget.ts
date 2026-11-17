import { LIMITS } from '../interpreter/limits';
import { chargeTypeWork } from './typeWorkBudget';
import { type Thunk, type Value } from './values';

type PreviewKind = 'scalar' | 'composite';

interface PreviewUsage {
  operations: number;
  milliseconds: number;
}

interface PreviewTransaction {
  kind: PreviewKind;
  deadline: number;
  operations: number;
  executionOperations: number;
  allocations: number;
  dependencies: Set<PreviewDebt>;
  forcing: boolean;
}

interface PreviewDebt {
  kind: PreviewKind;
  operations: number;
  executionOperations: number;
  allocations: number;
  consumed: boolean;
  dependencies: PreviewDebt[];
}

export class DisplayAbort extends Error {
  constructor() {
    super('Display evaluation exceeded its budget');
    this.name = 'DisplayAbort';
  }
}

export class PreviewBudget {
  private readonly usage: Record<PreviewKind, PreviewUsage> = {
    scalar: { operations: 0, milliseconds: 0 },
    composite: { operations: 0, milliseconds: 0 },
  };
  private readonly debts = new WeakMap<Thunk, PreviewDebt>();
  private active: PreviewTransaction | undefined;

  spend(operations: number, executionOperations: number, allocations: number): void {
    const active = this.active;
    if (!active) return;
    if (active.forcing) {
      active.operations += operations;
      active.executionOperations += executionOperations;
      active.allocations += allocations;
      this.usage[active.kind].operations += operations;
      if (this.remainingOperations(active.kind) < 0) throw new DisplayAbort();
    }
    if (performance.now() > active.deadline) throw new DisplayAbort();
  }

  force(slot: Thunk, work: () => Value): Value {
    return this.run(() => this.forceInTransaction(slot, work), 'scalar');
  }

  private forceInTransaction(slot: Thunk, work: () => Value): Value {
    const active = this.active as PreviewTransaction;
    if (this.remainingOperations(active.kind) <= 0) throw new DisplayAbort();
    const savedForcing = active.forcing;
    active.forcing = true;
    const before = {
      operations: active.operations,
      executionOperations: active.executionOperations,
      allocations: active.allocations,
    };
    const savedDependencies = active.dependencies;
    active.dependencies = new Set();
    try {
      const value = work();
      const debt: PreviewDebt = {
        kind: active.kind,
        operations: 0,
        executionOperations: active.executionOperations - before.executionOperations,
        allocations: active.allocations - before.allocations,
        consumed: false,
        dependencies: [...active.dependencies],
      };
      for (let current: Thunk | undefined = slot; current; current = current.target) {
        chargeTypeWork();
        this.debts.set(current, debt);
      }
      debt.operations = active.operations - before.operations;
      return value;
    } finally {
      active.dependencies = savedDependencies;
      active.forcing = savedForcing;
    }
  }

  run<T>(work: () => T, kind: PreviewKind = 'composite'): T {
    if (this.active) return work();
    const remainingTime = this.remainingMilliseconds(kind);
    if (remainingTime <= 0) throw new DisplayAbort();
    const started = performance.now();
    this.active = {
      kind,
      deadline: started + remainingTime,
      operations: 0,
      executionOperations: 0,
      allocations: 0,
      dependencies: new Set(),
      forcing: false,
    };
    try {
      return work();
    } finally {
      this.usage[kind].milliseconds += performance.now() - started;
      this.active = undefined;
    }
  }

  consume(slot: Thunk, demanded: boolean): { operations: number; allocations: number } | undefined {
    const debt = this.debts.get(slot);
    if (!debt || debt.consumed) return;
    if (!demanded) {
      this.active?.dependencies.add(debt);
      return;
    }
    const pending = [debt];
    let executionOperations = 0;
    let allocations = 0;
    while (pending.length > 0) {
      const current = pending.pop() as PreviewDebt;
      if (current.consumed) continue;
      current.consumed = true;
      this.usage[current.kind].operations -= current.operations;
      executionOperations += current.executionOperations;
      allocations += current.allocations;
      for (const dependency of current.dependencies) pending.push(dependency);
      current.dependencies = [];
    }
    return { operations: executionOperations, allocations };
  }

  private remainingOperations(kind: PreviewKind): number {
    const { scalar, composite } = this.usage;
    const total = LIMITS.maxOperations - scalar.operations - composite.operations;
    return kind === 'scalar' ? total : Math.min(total, LIMITS.maxOperations / 2 - composite.operations);
  }

  private remainingMilliseconds(kind: PreviewKind): number {
    const { scalar, composite } = this.usage;
    const total = LIMITS.maxMilliseconds - scalar.milliseconds - composite.milliseconds;
    return kind === 'scalar' ? total : Math.min(total, LIMITS.maxMilliseconds / 2 - composite.milliseconds);
  }
}
