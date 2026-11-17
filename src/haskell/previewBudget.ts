import { LIMITS } from '../interpreter/limits';
import { type Thunk, type Value } from './values';

export const DISPLAY_OPERATIONS = 20_000;

interface PreviewFamily {
  activeScopes: number;
  activeFrames: number;
  activeWorkScopes: number;
  operations: number;
  milliseconds: number;
  timeLimit: number;
  views: Map<string, PreviewUsage>;
}

interface PreviewUsage {
  epoch: number;
  retiredMilliseconds: number;
  family: PreviewFamily;
  operations: number;
  share: number;
  milliseconds: number;
  timeLimit: number;
}

export interface PreviewView {
  owner: object;
  frame: object;
  scope: object;
  key: string;
  share: number;
}

interface PreviewScope {
  families: Set<PreviewFamily>;
  workFamilies: Set<PreviewFamily>;
}

interface PreviewCost {
  epoch: number;
  usage: PreviewUsage;
  operations: number;
}

interface PreviewTransaction {
  scope: PreviewScope;
  usage: PreviewUsage;
  deadline: number;
  remainingMilliseconds: number;
  milliseconds: number;
  operations: number;
  allowance: number;
  forcing: boolean;
  frames: PreviewFrame[];
  debts: Set<PreviewDebt>;
  recycle: boolean;
  incomplete: boolean;
}

interface PreviewDebt {
  costs: PreviewCost[];
  executionOperations: number;
  allocations: number;
  consumed: boolean;
  quotaReleased: boolean;
  dependencies: PreviewDebt[];
}

interface PreviewFrame {
  thunk: Thunk;
  debt: PreviewDebt;
  costs: PreviewCost[] | undefined;
  executionOperations: number;
  allocations: number;
  dependenciesLength: number;
  quotaReleased: boolean;
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
  private activeOperations = 0;
  private readonly scopes = new Map<object, Map<object, PreviewScope>>();
  private readonly frameFamilies = new Map<object, Set<PreviewFamily>>();
  private activeFamilies = 0;
  private readonly familyTimeLimit = LIMITS.maxMilliseconds / 2;

  endFrame(frame: object): void {
    const scopes = this.scopes.get(frame);
    if (scopes) for (const owner of scopes.keys()) this.endScope(frame, owner);
    const families = this.frameFamilies.get(frame);
    this.frameFamilies.delete(frame);
    if (families)
      for (const family of families) {
        if (--family.activeFrames === 0) for (const usage of family.views.values()) usage.retiredMilliseconds = 0;
      }
  }

  endScope(frame: object, scopeKey: object): void {
    const scopes = this.scopes.get(frame);
    if (!scopes) return;
    const scope = scopes.get(scopeKey);
    if (!scope) return;
    scopes.delete(scopeKey);
    if (scopes.size === 0) this.scopes.delete(frame);
    for (const family of scope.workFamilies) {
      family.activeWorkScopes--;
      if (family.activeWorkScopes === 0) this.activeFamilies--;
    }
    for (const family of scope.families) {
      family.activeScopes--;
      if (family.activeScopes === 0) this.retire(family);
    }
  }

  private retire(family: PreviewFamily): void {
    this.activeOperations -= family.operations;
    family.operations = 0;
    family.milliseconds = 0;
    for (const usage of family.views.values()) {
      usage.epoch++;
      usage.retiredMilliseconds += usage.milliseconds;
      usage.operations = 0;
      usage.milliseconds = 0;
      usage.share = 1;
      usage.timeLimit = family.timeLimit;
    }
  }

  spend(operations: number, executionOperations: number, allocations: number): void {
    const active = this.active;
    if (!active) return;
    if (active.forcing) {
      const { usage } = active;
      usage.operations += operations;
      usage.family.operations += operations;
      this.activeOperations += operations;
      const debt = active.frames.at(-1)?.debt;
      if (debt) {
        debt.quotaReleased = false;
        const previous = debt.costs.at(-1);
        if (previous?.usage === usage && previous.epoch === usage.epoch) previous.operations += operations;
        else debt.costs.push({ epoch: usage.epoch, usage, operations });
        debt.executionOperations += executionOperations;
        debt.allocations += allocations;
      }
      active.operations += operations;
      if (active.operations > active.allowance || this.remainingOperations(usage) < 0) throw new DisplayAbort();
    }
    if (active.forcing && performance.now() >= active.deadline) throw new DisplayAbort();
  }

  force(slot: Thunk, work: () => Value): Value {
    const active = this.active;
    if (!active) throw new Error('Preview evaluation requires a display view');
    if (this.aborted.get(slot)?.has(active.usage)) throw new DisplayAbort();
    this.activateWork(active);
    const savedForcing = active.forcing;
    const started = savedForcing ? undefined : performance.now();
    if (started !== undefined) active.deadline = started + Math.max(0, active.remainingMilliseconds);
    if (this.remainingOperations(active.usage) <= 0 || performance.now() >= active.deadline) throw new DisplayAbort();
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
      if (started !== undefined) {
        const elapsed = performance.now() - started;
        active.milliseconds += elapsed;
        active.remainingMilliseconds -= elapsed;
      }
    }
  }

  private activateWork(active: PreviewTransaction): void {
    const family = active.usage.family;
    if (active.scope.workFamilies.has(family)) return;
    active.scope.workFamilies.add(family);
    if (family.activeWorkScopes++ === 0) this.activeFamilies++;
  }

  run<T>(view: PreviewView, work: () => T): T {
    if (this.active) return work();
    const usage = this.usageFor(view.owner, view.key, view.share);
    this.registerFrame(view.frame, usage.family);
    const scope = this.scopeFor(view.frame, view.scope);
    if (!scope.families.has(usage.family)) {
      scope.families.add(usage.family);
      if (usage.family.activeScopes++ === 0) {
        usage.family.timeLimit = (LIMITS.maxMilliseconds - this.milliseconds) / 2;
      }
    }
    const remainingTime = Math.min(
      LIMITS.maxMilliseconds - this.milliseconds,
      Math.min(usage.timeLimit, usage.family.timeLimit * usage.share) - usage.milliseconds - usage.retiredMilliseconds,
      usage.family.timeLimit - usage.family.milliseconds
    );
    const started = performance.now();
    const active: PreviewTransaction = {
      scope,
      usage,
      deadline: started + Math.max(0, remainingTime),
      remainingMilliseconds: remainingTime,
      milliseconds: 0,
      operations: 0,
      allowance: DISPLAY_OPERATIONS * Math.max(0, 1 - this.milliseconds / LIMITS.maxMilliseconds),
      forcing: false,
      frames: [],
      debts: new Set(),
      recycle: false,
      incomplete: false,
    };
    this.active = active;
    try {
      return work();
    } finally {
      const finished = performance.now();
      const elapsed = active.milliseconds;
      this.milliseconds += elapsed;
      usage.milliseconds += elapsed;
      usage.family.milliseconds += elapsed;
      if (active.recycle && !active.incomplete) {
        for (const debt of active.debts) this.releaseQuota(debt);
        this.milliseconds += performance.now() - finished;
      }
      this.active = undefined;
    }
  }

  enter(thunk: Thunk): void {
    const active = this.active;
    if (!active?.forcing) return;
    const debt = this.debtFor(thunk);
    active.debts.add(debt);
    active.frames.push({
      thunk,
      debt,
      costs: debt.costs.length > 0 ? debt.costs.map((cost) => ({ ...cost })) : undefined,
      executionOperations: debt.executionOperations,
      allocations: debt.allocations,
      dependenciesLength: debt.dependencies.length,
      quotaReleased: debt.quotaReleased,
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
    debt.quotaReleased = frame.quotaReleased;
  }

  consume(slot: Thunk, demanded: boolean): { operations: number; allocations: number } | undefined {
    const active = this.active;
    if (!demanded) {
      if (!active?.forcing) return;
      const debt = slot.state === 'pending' ? this.debtFor(slot) : this.debts.get(slot);
      const parent = active.frames.at(-1)?.debt;
      if (debt && !debt.consumed) {
        active.debts.add(debt);
        if (parent && parent !== debt) {
          parent.dependencies.push(debt);
          parent.quotaReleased = false;
        }
      }
      return;
    }
    const debt = this.debts.get(slot);
    if (!debt || debt.consumed) return;
    return this.settleDebt(debt);
  }

  track(slot: Thunk): void {
    const debt = this.debts.get(slot);
    if (debt && !debt.consumed) this.active?.debts.add(debt);
  }

  completeView(): void {
    if (!this.active) throw new Error('Preview evaluation requires a display view');
    this.active.recycle = true;
  }

  incompleteView(): void {
    if (this.active) this.active.incomplete = true;
  }

  private releaseQuota(debt: PreviewDebt): void {
    const pending = [debt];
    while (pending.length > 0) {
      const current = pending.pop() as PreviewDebt;
      if (current.consumed || current.quotaReleased) continue;
      current.quotaReleased = true;
      for (const cost of current.costs) this.refund(cost);
      current.costs = [];
      for (const dependency of current.dependencies) pending.push(dependency);
    }
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

  private refund({ epoch, usage, operations }: PreviewCost): void {
    if (epoch !== usage.epoch) return;
    if (operations > 0) {
      const milliseconds = (usage.milliseconds * operations) / usage.operations;
      usage.milliseconds -= milliseconds;
      usage.family.milliseconds = Math.max(0, usage.family.milliseconds - milliseconds);
    }
    usage.operations -= operations;
    usage.family.operations -= operations;
    this.activeOperations -= operations;
  }

  private registerFrame(frame: object, family: PreviewFamily): void {
    let families = this.frameFamilies.get(frame);
    if (!families) {
      families = new Set();
      this.frameFamilies.set(frame, families);
    }
    if (!families.has(family)) {
      families.add(family);
      family.activeFrames++;
    }
  }

  private scopeFor(frame: object, scopeKey: object): PreviewScope {
    let scopes = this.scopes.get(frame);
    if (!scopes) {
      scopes = new Map();
      this.scopes.set(frame, scopes);
    }
    let scope = scopes.get(scopeKey);
    if (!scope) {
      scope = { families: new Set(), workFamilies: new Set() };
      scopes.set(scopeKey, scope);
    }
    return scope;
  }

  private usageFor(owner: object, view: string, share: number): PreviewUsage {
    let family = this.families.get(owner);
    if (!family) {
      family = {
        activeScopes: 0,
        activeFrames: 0,
        activeWorkScopes: 0,
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
      usage = { epoch: 0, retiredMilliseconds: 0, family, operations: 0, share, milliseconds: 0, timeLimit };
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
        quotaReleased: false,
        dependencies: [],
      };
      this.debts.set(slot, debt);
    }
    return debt;
  }

  private remainingOperations(usage: PreviewUsage): number {
    const limit = LIMITS.maxOperations / Math.max(2, this.activeFamilies);
    return Math.min(
      LIMITS.maxOperations - this.activeOperations,
      limit * usage.share - usage.operations,
      limit - usage.family.operations
    );
  }
}
