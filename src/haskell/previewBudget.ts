import { LIMITS } from '../interpreter/limits';
import { type Thunk, type Value } from './values';

type PreviewKind = 'scalar' | 'composite';

interface PreviewUsage {
  operations: number;
  milliseconds: number;
}

interface PreviewTransaction {
  kind: PreviewKind;
  deadline: number;
  forcing: boolean;
  frames: PreviewFrame[];
}

interface PreviewDebt {
  scalarOperations: number;
  compositeOperations: number;
  executionOperations: number;
  allocations: number;
  consumed: boolean;
  dependencies: PreviewDebt[];
}

interface PreviewFrame {
  thunk: Thunk;
  debt: PreviewDebt;
  scalarOperations: number;
  compositeOperations: number;
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
      this.usage[active.kind].operations += operations;
      const debt = active.frames.at(-1)?.debt;
      if (debt) {
        if (active.kind === 'scalar') debt.scalarOperations += operations;
        else debt.compositeOperations += operations;
        debt.executionOperations += executionOperations;
        debt.allocations += allocations;
      }
      if (this.remainingOperations(active.kind) < 0) throw new DisplayAbort();
    }
    if (performance.now() > active.deadline) throw new DisplayAbort();
  }

  force(work: () => Value): Value {
    return this.run(() => this.forceInTransaction(work), 'scalar');
  }

  private forceInTransaction(work: () => Value): Value {
    const active = this.active as PreviewTransaction;
    if (this.remainingOperations(active.kind) <= 0) throw new DisplayAbort();
    const savedForcing = active.forcing;
    active.forcing = true;
    try {
      return work();
    } finally {
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
      forcing: false,
      frames: [],
    };
    try {
      return work();
    } finally {
      this.usage[kind].milliseconds += performance.now() - started;
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
      scalarOperations: debt.scalarOperations,
      compositeOperations: debt.compositeOperations,
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
    debt.scalarOperations = frame.scalarOperations;
    debt.compositeOperations = frame.compositeOperations;
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
    const pending = [debt];
    let executionOperations = 0;
    let allocations = 0;
    while (pending.length > 0) {
      const current = pending.pop() as PreviewDebt;
      if (current.consumed) continue;
      current.consumed = true;
      this.usage.scalar.operations -= current.scalarOperations;
      this.usage.composite.operations -= current.compositeOperations;
      executionOperations += current.executionOperations;
      allocations += current.allocations;
      for (const dependency of current.dependencies) pending.push(dependency);
      current.dependencies = [];
    }
    return { operations: executionOperations, allocations };
  }

  private debtFor(slot: Thunk): PreviewDebt {
    let debt = this.debts.get(slot);
    if (!debt || debt.consumed) {
      debt = {
        scalarOperations: 0,
        compositeOperations: 0,
        executionOperations: 0,
        allocations: 0,
        consumed: false,
        dependencies: [],
      };
      this.debts.set(slot, debt);
    }
    return debt;
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
