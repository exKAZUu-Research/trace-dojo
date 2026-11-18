import { ExecutionLimitError, LIMITS, MAX_TRACE_ITEMS } from '../interpreter/limits';
import type { ProgramRun } from '../interpreter/program';
import type { TraceVariables } from '../interpreter/traceRecorder';
import { requiresTraceKeyEncoding } from '../interpreter/traceTransport';
import type { TraceItem } from '../problems/trace';
import { TRUNCATED_DISPLAY } from './displayOutput';
import { EMPTY_COST, OUTPUT_CAPACITY, type OutputCost, OutputSizes } from './outputSize';
import { DISPLAY_OPERATIONS, DisplayAbort } from './previewBudget';
import type { Runtime } from './runtime';

interface Location {
  roots: Record<string, unknown>;
  name: string;
  reference: boolean;
}

interface OutputGroup {
  value: unknown;
  cost: OutputCost;
  locations: Location[];
  bucket: number;
  shared: boolean;
}

interface RootLocation extends Location {
  value: unknown;
  path: string;
  minimum: OutputCost;
}

interface Candidate extends RootLocation {
  full: OutputCost;
}

export class RecordingOutput {
  private readonly remaining = { ...OUTPUT_CAPACITY };
  private readonly sizes = new OutputSizes();
  private readonly objects = new WeakMap<object, OutputGroup>();
  private readonly scalars = new Map<unknown, OutputGroup>();
  private readonly requiredBigints = new Set<bigint>();
  private readonly buckets: Set<OutputGroup>[] = [];
  private stateRemaining = LIMITS.maxSlots * 8;
  private recordedItems = 1;

  constructor(private readonly runtime: Runtime) {
    this.take(this.sizes.cost(TRUNCATED_DISPLAY, `traceItems.${MAX_TRACE_ITEMS}.referenceVars`));
    this.take(
      this.sizes.cost(
        {
          traceItems: [
            { line: 0, callLines: [], vars: {}, referenceVars: {}, turtles: [], board: runtime.world.boardText() },
          ],
        },
        ''
      )
    );
  }

  record(item: TraceItem): TraceItem {
    const { vars, referenceVars, ...state } = item;
    const path = `traceItems.${this.recordedItems++}`;
    this.runtime.budget.excludingTime(() => {
      this.stateRemaining -= JSON.stringify(state).length;
      if (this.stateRemaining < 0) throw new ExecutionLimitError('trace');
      this.reserve(this.sizes.cost(state, path));
    });
    return { ...state, ...this.bound({ vars, referenceVars }, path) };
  }

  finish(run: ProgramRun): ProgramRun {
    this.runtime.budget.excludingTime(() => this.reserve(this.sizes.cost(run, '')));
    return run;
  }

  bound(variables: TraceVariables, path?: string): TraceVariables {
    return this.runtime.budget.excludingTime(() => {
      const candidates: Candidate[] = [];
      const vars = this.prepare(variables.vars, path ? `${path}.vars` : 'finalVars', false, candidates);
      const referenceVars = path
        ? this.prepare(variables.referenceVars, `${path}.referenceVars`, true, candidates)
        : variables.referenceVars;
      for (const candidate of candidates.toSorted((a, b) => priority(a.full) - priority(b.full)))
        this.upgrade(candidate);
      for (const name of Object.keys(vars)) if (vars[name] === undefined) delete vars[name];
      return { vars, referenceVars };
    });
  }

  private prepare<T>(
    roots: Record<string, T>,
    path: string,
    reference: boolean,
    candidates: Candidate[]
  ): Record<string, T> {
    const bounded: Record<string, T> = Object.create(null);
    const encoded = requiresTraceKeyEncoding(roots);
    this.reserve(this.sizes.cost(encoded ? { constructor: 0 } : {}, path));
    const entries = Object.entries(roots);
    const rootPaths = entries.map(([name], index) =>
      encoded ? `${path}.${index}.1` : `${path}.${name.replaceAll(/[.\\]/g, String.raw`\$&`)}`
    );
    let costPath = path;
    for (const next of rootPaths) if (this.sizes.key(next) > this.sizes.key(costPath)) costPath = next;
    for (const [index, [name, value]] of entries.entries()) {
      const location: Location = { roots: bounded, name, reference };
      const rootPath = rootPaths[index]!;
      const header: OutputCost = encoded
        ? { characters: this.sizes.key(name) + 4, nodes: 1, work: rootPath.split('.').length }
        : { characters: this.sizes.key(name), nodes: 0, work: 0 };
      const minimum = reference ? this.sizes.cost(TRUNCATED_DISPLAY, rootPath, true) : EMPTY_COST;
      const candidate: RootLocation = { ...location, value, path: costPath, minimum };
      if (!this.reserveRoot(candidate, rootPath, header)) continue;
      const full = this.optionalCost(value, costPath);
      if (full) candidates.push({ ...candidate, full });
    }
    return bounded;
  }

  private reserveRoot(candidate: RootLocation, path: string, header: OutputCost): boolean {
    const { roots, name, value, reference, minimum } = candidate;
    if (reference) {
      this.reserve(addCost(header, minimum));
      roots[name] = TRUNCATED_DISPLAY;
      return value !== TRUNCATED_DISPLAY;
    }
    if (!Array.isArray(value) && this.sizes.cost(value, path).characters <= 1024) {
      this.reserve(
        addCost(header, this.sizes.cost(value, path, typeof value === 'bigint' && this.requiredBigints.has(value)))
      );
      roots[name] = value;
      if (typeof value === 'bigint') this.requiredBigints.add(value);
      return false;
    }
    this.reserve(header);
    roots[name] = undefined;
    return true;
  }

  private optionalCost(value: unknown, path: string): OutputCost | undefined {
    try {
      return this.sizes.cost(value, path, false, (read) =>
        this.runtime.withDisplayBudget(DISPLAY_OPERATIONS, () => this.runtime.withRenderBudget('reference', read))
      );
    } catch (error) {
      if (!(error instanceof DisplayAbort)) throw error;
      return;
    }
  }

  private upgrade(candidate: Candidate): void {
    const { value, path, minimum, roots, name } = candidate;
    let group = this.group(value);
    const repeated = group !== undefined && (typeof value === 'object' || typeof value === 'bigint');
    const cost = difference(this.sizes.cost(value, path, repeated), minimum);
    if (repeated && !group?.shared) cost.nodes++;
    if (!this.fits(cost)) return;
    this.take(cost);
    if (group === undefined) {
      group = { value, cost: { ...EMPTY_COST }, locations: [], bucket: 0, shared: false };
      this.setGroup(value, group);
    } else this.buckets[group.bucket]?.delete(group);
    group.shared ||= repeated;
    group.cost = addCost(group.cost, cost);
    group.locations.push(candidate);
    roots[name] = value;
    group.bucket = Math.ceil(Math.log2(Math.max(1, priority(group.cost))));
    (this.buckets[group.bucket] ??= new Set()).add(group);
  }

  private group(value: unknown): OutputGroup | undefined {
    return typeof value === 'object' && value !== null ? this.objects.get(value) : this.scalars.get(value);
  }

  private setGroup(value: unknown, group: OutputGroup): void {
    if (typeof value === 'object' && value !== null) this.objects.set(value, group);
    else this.scalars.set(value, group);
  }

  private reserve(cost: OutputCost): void {
    while (!this.fits(cost)) {
      const bucket = this.buckets.findLast((groups) => groups?.size > 0);
      const group = bucket?.values().next().value;
      if (!group) throw new ExecutionLimitError('trace');
      bucket!.delete(group);
      this.remaining.characters += group.cost.characters;
      this.remaining.nodes += group.cost.nodes;
      this.remaining.work += group.cost.work;
      for (const { roots, name, reference } of group.locations) {
        if (reference) roots[name] = TRUNCATED_DISPLAY;
        else delete roots[name];
      }
      if (typeof group.value === 'object' && group.value !== null) this.objects.delete(group.value);
      else this.scalars.delete(group.value);
    }
    this.take(cost);
  }

  private fits(cost: OutputCost): boolean {
    return (
      cost.characters <= this.remaining.characters &&
      cost.nodes <= this.remaining.nodes &&
      cost.work <= this.remaining.work
    );
  }

  private take(cost: OutputCost): void {
    this.remaining.characters -= cost.characters;
    this.remaining.nodes -= cost.nodes;
    this.remaining.work -= cost.work;
  }
}

function priority(cost: OutputCost): number {
  return Math.max(
    cost.characters,
    (cost.nodes * OUTPUT_CAPACITY.characters) / OUTPUT_CAPACITY.nodes,
    (cost.work * OUTPUT_CAPACITY.characters) / OUTPUT_CAPACITY.work
  );
}

function addCost(a: OutputCost, b: OutputCost): OutputCost {
  return { characters: a.characters + b.characters, nodes: a.nodes + b.nodes, work: a.work + b.work };
}

function difference(a: OutputCost, b: OutputCost): OutputCost {
  return {
    characters: Math.max(0, a.characters - b.characters),
    nodes: Math.max(0, a.nodes - b.nodes),
    work: Math.max(0, a.work - b.work),
  };
}
