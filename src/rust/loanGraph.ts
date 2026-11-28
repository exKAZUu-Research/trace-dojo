import type { ExecutionBudget } from '../interpreter/limits';
import type { Span } from './ast';
import type { RVar } from './regions';

/** A variable of the program, or a temporary that holds a value while an expression is evaluated. */
export type Var = number;

/** A place rooted in a variable; its projections are field names and indexes, `*` for a deref, `[]` for an element. */
export interface Place {
  root: Var;
  proj: readonly string[];
}

/**
 * How a point uses a place: reads it (or borrows it shared), writes it shallowly (assigns it), writes it deeply
 * (borrows it mutably or modifies it), moves out of it, or ends its storage.
 */
export type AccessKind = 'read' | 'write' | 'deep' | 'move' | 'storageDead';

export interface Access {
  place: Place;
  kind: AccessKind;
  span: Span;
  /** A two-phase borrow that this access activates, which does not conflict with itself. */
  activates?: Loan;
}

export interface Loan {
  place: Place;
  mutable: boolean;
  region: RVar;
  span: Span;
  point: number;
  /** For a two-phase borrow, the point that activates it, before which it only reserves the place. */
  activation?: number;
}

export interface Point {
  succ: number[];
  uses: Var[];
  defs: Var[];
  /** Checked against the loans in scope before the point creates its own. */
  accesses: Access[];
  /** Places the point overwrites, which ends the loans of them. */
  kills: Place[];
  gens: Loan[];
}

export interface LoanError {
  span: Span;
  message: string;
}

/**
 * A function's control flow graph, annotated with what borrow checking needs: where variables are used and defined,
 * which places each point accesses, and which loans it creates.
 */
export class LoanGraph {
  readonly points: Point[] = [];
  readonly names: string[] = [];
  /** The regions of the references in each variable's type, which contain the points where the variable is live. */
  readonly varRegions: RVar[][] = [];
  readonly dropLive = new Map<Var, string[][]>();
  readonly dropStores: { point: number; place: Place; regions: RVar[] }[] = [];
  regionCount = 0;
  /** Regions that contain the whole function: those of parameters, captures, the return value, and `'static`. */
  readonly universal = new Set<RVar>();
  /** `[sup, sub]`: region `sup` contains region `sub`. */
  readonly outlives: [RVar, RVar][] = [];

  constructor(private readonly budget: ExecutionBudget) {}

  newVar(name: string): Var {
    this.budget.spend();
    this.names.push(name);
    this.varRegions.push([]);
    return this.names.length - 1;
  }

  newRegion(): RVar {
    this.budget.spend();
    return this.regionCount++;
  }

  newPoint(): number {
    this.budget.spend();
    this.points.push({ succ: [], uses: [], defs: [], accesses: [], kills: [], gens: [] });
    return this.points.length - 1;
  }

  /** Checks every access against the loans in scope where it happens, as rustc's NLL borrow checker does. */
  check(errors: LoanError[]): void {
    const loans = this.points.flatMap((point) => point.gens);
    if (loans.length === 0) return;
    const reachable = this.reachable();
    const inScope = this.loansInScope(loans, reachable);
    for (const [index, point] of this.points.entries()) {
      if (!reachable[index]) continue;
      for (const access of point.accesses) {
        this.budget.spend(loans.length);
        const loan = loans.find(
          (candidate, loanIdx) => inScope[index].has(loanIdx) && conflicts(candidate, access, index)
        );
        if (loan) errors.push(this.conflictError(loan, access));
      }
    }
  }

  /**
   * The loans in scope on entry to each point: those created on a path to it, along which their regions contain every
   * point and nothing overwrote the borrowed place.
   */
  // code-gauge-allow functionCognitiveComplexity -- The forward dataflow of rustc's `Borrows` analysis.
  // code-gauge-allow functionNcss -- The forward dataflow of rustc's `Borrows` analysis.
  private loansInScope(loans: Loan[], reachable: boolean[]): BitSet[] {
    this.budget.spend(2 * loans.length * this.points.length);
    const preds = this.points.map((): number[] => []);
    for (const [index, point] of this.points.entries()) for (const succ of point.succ) preds[succ].push(index);
    const regions = this.regions(preds, reachable);
    const loanIndex = new Map(loans.map((loan, index) => [loan, index]));
    const killed = this.points.map((point) => {
      const set = new BitSet(loans.length);
      for (const [index, loan] of loans.entries()) if (killsLoan(point, loan)) set.add(index);
      return set;
    });
    // The loans whose regions do not contain each point, which end there.
    const outOfRegion = this.points.map((_, index) => {
      const set = new BitSet(loans.length);
      for (const [loanIdx, loan] of loans.entries()) if (!regions[loan.region].has(index)) set.add(loanIdx);
      return set;
    });
    const inScope = this.points.map(() => new BitSet(loans.length));
    const outScope = this.points.map(() => new BitSet(loans.length));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [index, point] of this.points.entries()) {
        if (!reachable[index]) continue;
        this.budget.spend(Math.ceil(loans.length / 32) * (preds[index].length + 1));
        const state = new BitSet(loans.length);
        for (const pred of preds[index]) state.unionWith(outScope[pred]);
        state.subtract(outOfRegion[index]);
        inScope[index] = state;
        const out = state.clone();
        out.subtract(killed[index]);
        for (const loan of point.gens) out.add(loanIndex.get(loan) as number);
        if (!out.equals(outScope[index])) {
          outScope[index] = out;
          changed = true;
        }
      }
    }
    return inScope;
  }

  private reachable(): boolean[] {
    const seen = this.points.map(() => false);
    const stack = this.points.length > 0 ? [0] : [];
    while (stack.length > 0) {
      this.budget.spend();
      const index = stack.pop() as number;
      if (seen[index]) continue;
      seen[index] = true;
      stack.push(...this.points[index].succ);
    }
    return seen;
  }

  /** The points each region contains: where variables of types with it are live, and what it outlives. */
  // code-gauge-allow functionCognitiveComplexity -- Region liveness follows scope paths and the outlives relation.
  private regions(preds: number[][], reachable: boolean[]): BitSet[] {
    const liveIn = this.liveness();
    const words = Math.ceil(this.points.length / 32);
    this.budget.spend(this.regionCount * words + this.points.length * this.names.length);
    const regions = Array.from({ length: this.regionCount }, () => new BitSet(this.points.length));
    for (const [index, live] of liveIn.entries()) {
      for (const v of live.values()) for (const region of this.varRegions[v]) regions[region].add(index);
    }
    for (const store of this.dropStores) {
      if (!reachable[store.point]) continue;
      for (const index of this.dropLiveness(store.place, store.point, preds, reachable)) {
        for (const region of store.regions) regions[region].add(index);
      }
    }
    for (const region of this.universal) regions[region].fill();
    let changed = true;
    while (changed) {
      this.budget.spend(this.outlives.length * words);
      changed = false;
      for (const [sup, sub] of this.outlives) if (regions[sup].unionWith(regions[sub])) changed = true;
    }
    return regions;
  }

  // code-gauge-allow functionCognitiveComplexity -- The backwards transfer must preserve loans needed by later destructors.
  private dropLiveness(place: Place, definition: number, preds: number[][], reachable: boolean[]): Set<number> {
    const { definitions, deinitializes, drops } = this.dropEvents(place, reachable);
    const pending = [...this.points[definition].succ];
    const initialized = new Set<number>();
    while (pending.length > 0) {
      this.budget.spend();
      const index = pending.pop()!;
      if (initialized.has(index)) continue;
      initialized.add(index);
      if (!definitions.has(index) && !deinitializes.has(index)) pending.push(...this.points[index].succ);
    }
    for (const drop of drops) if (initialized.has(drop)) pending.push(drop);
    const live = new Set<number>();
    while (pending.length > 0) {
      this.budget.spend();
      const index = pending.pop()!;
      if (live.has(index)) continue;
      live.add(index);
      for (const pred of preds[index]) {
        if (initialized.has(pred) && !definitions.has(pred) && !deinitializes.has(pred)) pending.push(pred);
      }
    }
    return live;
  }

  // code-gauge-allow functionCognitiveComplexity -- Move, overwrite, and scope exit each change destruction liveness.
  private dropEvents(
    place: Place,
    reachable: boolean[]
  ): {
    definitions: Set<number>;
    deinitializes: Set<number>;
    drops: Set<number>;
  } {
    const definitions = new Set<number>();
    const deinitializes = new Set<number>();
    const drops = new Set<number>();
    this.budget.spend(this.points.length);
    for (const [index, point] of this.points.entries()) {
      if (!reachable[index]) continue;
      this.budget.spend(point.accesses.length);
      if (point.defs.includes(place.root)) definitions.add(index);
      for (const access of point.accesses) {
        if (access.place.root !== place.root || !isPrefix(access.place.proj, place.proj)) continue;
        if (access.kind === 'storageDead' || access.kind === 'write') drops.add(index);
        if (access.kind === 'storageDead' || access.kind === 'move') deinitializes.add(index);
        if (access.kind === 'write') definitions.add(index);
      }
    }
    return { definitions, deinitializes, drops };
  }

  private liveness(): BitSet[] {
    const words = Math.ceil(this.names.length / 32);
    this.budget.spend(this.points.length * words);
    const liveIn = this.points.map(() => new BitSet(this.names.length));
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = this.points.length - 1; index >= 0; index--) {
        const point = this.points[index];
        this.budget.spend(words * (point.succ.length + 1));
        const live = new BitSet(this.names.length);
        for (const succ of point.succ) live.unionWith(liveIn[succ]);
        for (const v of point.defs) live.delete(v);
        for (const v of point.uses) live.add(v);
        if (!live.equals(liveIn[index])) {
          liveIn[index] = live;
          changed = true;
        }
      }
    }
    return liveIn;
  }

  private conflictError(loan: Loan, access: Access): LoanError {
    const label = this.names[loan.place.root];
    const name = label === '{temp}' ? 'この値' : label;
    const row = loan.span.row + 1;
    switch (access.kind) {
      case 'storageDead': {
        return {
          span: loan.span,
          message:
            access.span.row === loan.span.row
              ? `${name} はこのあとすぐになくなるので、その参照を外へ持ち出せません。`
              : `${name} は ${access.span.row + 1} 行目でスコープの外に出てなくなりますが、${row} 行目で借りた参照がその後も使われます。`,
        };
      }
      case 'write': {
        return {
          span: access.span,
          message: `${name} は ${row} 行目で借りられていて、その参照がまだ使われるので、代入できません。`,
        };
      }
      case 'move': {
        return {
          span: access.span,
          message: `${name} は ${row} 行目で借りられていて、その参照がまだ使われるので、ムーブできません。`,
        };
      }
      default: {
        if (loan.mutable) {
          return {
            span: access.span,
            message: `${name} は ${row} 行目で &mut で借りられていて、その参照がまだ使われるので、${access.kind === 'deep' ? 'もう一度 &mut で借りられません' : '使えません'}。`,
          };
        }
        return {
          span: access.span,
          message: `${name} は ${row} 行目で & で借りられていて、その参照がまだ使われるので、書き換えられません。`,
        };
      }
    }
  }
}

function killsLoan(point: Point, loan: Loan): boolean {
  if (point.defs.includes(loan.place.root)) return true;
  for (const place of point.kills)
    if (place.root === loan.place.root && isPrefix(place.proj, loan.place.proj)) return true;
  for (const access of point.accesses) {
    if (access.kind === 'storageDead' && access.place.root === loan.place.root) return true;
  }
  return false;
}

function isPrefix(prefix: readonly string[], proj: readonly string[]): boolean {
  return prefix.length <= proj.length && prefix.every((elem, index) => elem === proj[index]);
}

/** Whether an access at a point conflicts with a loan in scope there, as rustc's `places_conflict` decides. */
function conflicts(loan: Loan, access: Access, at: number): boolean {
  if (loan.place.root !== access.place.root || access.activates === loan) return false;
  const borrowed = loan.place.proj;
  const accessed = access.place.proj;
  const common = Math.min(borrowed.length, accessed.length);
  for (let index = 0; index < common; index++) {
    const a = borrowed[index];
    const b = accessed[index];
    // A `Deref` impl's target (`&`) borrows its whole owner, and an element (`[]`) may be any of them.
    if (a === '&' || b === '&') break;
    if (a !== b && a !== '[]' && b !== '[]') return false;
  }
  // Assigning a place, or ending its storage, leaves alone what it refers to.
  const shallow = access.kind === 'write' || access.kind === 'storageDead';
  if (shallow && borrowed.length > accessed.length && borrowed.slice(accessed.length).includes('*')) return false;
  const reserved = loan.activation !== undefined && loan.point < at && at < loan.activation;
  if (access.kind === 'read') return loan.mutable && !reserved;
  return true;
}

class BitSet {
  private words: Uint32Array;

  constructor(readonly size: number) {
    this.words = new Uint32Array((size + 31) >>> 5);
  }

  has(index: number): boolean {
    return (this.words[index >>> 5] & (1 << (index & 31))) !== 0;
  }

  add(index: number): void {
    this.words[index >>> 5] |= 1 << (index & 31);
  }

  delete(index: number): void {
    this.words[index >>> 5] &= ~(1 << (index & 31));
  }

  fill(): void {
    this.words.fill(0xff_ff_ff_ff);
  }

  /** Adds the members of another set, telling whether any were new. */
  unionWith(other: BitSet): boolean {
    let changed = false;
    for (let index = 0; index < this.words.length; index++) {
      const merged = (this.words[index] | other.words[index]) >>> 0;
      if (merged !== this.words[index]) {
        this.words[index] = merged;
        changed = true;
      }
    }
    return changed;
  }

  subtract(other: BitSet): void {
    for (let index = 0; index < this.words.length; index++) this.words[index] &= ~other.words[index];
  }

  equals(other: BitSet): boolean {
    return this.words.every((word, index) => word === other.words[index]);
  }

  clone(): BitSet {
    const copy = new BitSet(this.size);
    copy.words = new Uint32Array(this.words);
    return copy;
  }

  *values(): Generator<number> {
    for (let index = 0; index < this.size; index++) if (this.has(index)) yield index;
  }
}
