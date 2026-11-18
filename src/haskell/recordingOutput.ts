import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { TraceVariables } from '../interpreter/traceRecorder';
import {
  encodeTraceNameRecord,
  requiresTraceKeyEncoding,
  serialize,
  traceRecordAnnotationCharacters,
} from '../interpreter/traceTransport';
import type { TraceItem } from '../problems/trace';
import { TRUNCATED_DISPLAY } from './displayOutput';
import { DISPLAY_OPERATIONS, DisplayAbort } from './previewBudget';
import { MAX_DISPLAY_NODES, type Runtime } from './runtime';
import { mapGraph, walkGraph } from './typeGraph';

interface OutputSize {
  characters: number;
  transportNodes: number;
  transportPaths: number;
  transportWork: number;
  maxTransportPath: number;
  maxTransportDepth: number;
}

interface OutputCost {
  characters: number;
  transportNodes: number;
  work: number;
}

const RECORDING_CHARACTERS = LIMITS.maxSlots * 32;
const STEP_CAPACITY: OutputCost = { characters: 1024, transportNodes: 12, work: 64 };

interface OutputCandidate {
  cost: OutputCost;
  minimum: OutputCost;
  admitted: boolean;
  scalar: boolean;
  reserveEligible: boolean;
  accept: () => void;
}
const emptyCost: OutputCost = { characters: 0, transportNodes: 0, work: 0 };
const IDENTITY_ENTRY_CHARACTERS = 8;
const truncated = {
  node: TRUNCATED_DISPLAY,
  size: {
    characters: JSON.stringify(TRUNCATED_DISPLAY).length + IDENTITY_ENTRY_CHARACTERS,
    transportNodes: 1,
    transportPaths: 0,
    transportWork: 0,
    maxTransportPath: 0,
    maxTransportDepth: 0,
  },
};
const negativeZero = Symbol();

export class RecordingOutput {
  private remaining = RECORDING_CHARACTERS / 2;
  private readonly essential: OutputCost = {
    characters: RECORDING_CHARACTERS / 2,
    transportNodes: MAX_DISPLAY_NODES / 2,
    work: LIMITS.maxSlots / 2,
  };
  private stateRemaining = LIMITS.maxSlots * 8;
  private transportNodesRemaining = MAX_DISPLAY_NODES / 2;
  private transportWorkRemaining = LIMITS.maxSlots / 2;
  private recordedItems = 1;
  private readonly transportValues = new WeakMap<object, object>();
  private readonly encodedRecords = new WeakSet<object>();
  private readonly sizes = new WeakMap<object, OutputSize>();
  private readonly uniqueSizes = new WeakMap<object, OutputSize>();
  private readonly emittedRoots = new WeakSet<object>();
  private readonly stringSizes = new Map<string, number>();
  private readonly scalarSizes = new Map<unknown, OutputSize>();

  constructor(private readonly runtime: Runtime) {}

  record(item: TraceItem): TraceItem {
    const { vars, referenceVars, ...state } = item;
    this.stateRemaining -= this.runtime.budget.excludingTime(() => JSON.stringify(state).length);
    if (this.stateRemaining < 0) throw new ExecutionLimitError('trace');
    return { ...state, ...this.bound({ vars, referenceVars }, `traceItems.${this.recordedItems++}`) };
  }

  bound(variables: TraceVariables, path?: string): TraceVariables {
    return this.runtime.withDisplayBudget(DISPLAY_OPERATIONS, () => {
      const capacity = { ...STEP_CAPACITY };
      const candidates: OutputCandidate[] = [];
      const vars = this.prepareRoots(variables.vars, path ? `${path}.vars` : 'finalVars', capacity, candidates);
      const referenceVars = this.prepareRoots(
        variables.referenceVars,
        path ? `${path}.referenceVars` : 'referenceVars',
        capacity,
        candidates,
        truncated
      );
      this.fundEssential(candidates, capacity);
      this.upgradeCandidates(candidates, capacity);
      this.rememberRoots(vars);
      this.rememberRoots(referenceVars);
      return { vars, referenceVars };
    });
  }

  private fundEssential(candidates: OutputCandidate[], capacity: OutputCost): void {
    for (const candidate of candidates) {
      if (!isEssential(candidate)) continue;
      this.reserveMinimum(candidate.cost, capacity);
      candidate.admitted = true;
    }
  }

  private upgradeCandidates(candidates: OutputCandidate[], capacity: OutputCost): void {
    capacity.characters = Math.min(capacity.characters, this.essential.characters);
    capacity.transportNodes = Math.min(capacity.transportNodes, this.essential.transportNodes);
    capacity.work = Math.min(capacity.work, this.essential.work);
    const initial = { ...capacity };
    const bulkCapacity = { ...emptyCost };
    for (const candidate of candidates
      .filter((item) => !item.admitted)
      .toSorted(
        (left, right) =>
          Number(isSmall(right)) - Number(isSmall(left)) || outputPriority(left.cost) - outputPriority(right.cost)
      )) {
      candidate.admitted = this.admit(candidate.cost, isSmall(candidate) ? capacity : bulkCapacity, candidate.minimum);
    }
    for (const candidate of candidates) if (candidate.admitted) candidate.accept();
    this.essential.characters -= initial.characters - capacity.characters;
    this.essential.transportNodes -= initial.transportNodes - capacity.transportNodes;
    this.essential.work -= initial.work - capacity.work;
    this.remaining += bulkCapacity.characters;
    this.transportNodesRemaining += bulkCapacity.transportNodes;
    this.transportWorkRemaining += bulkCapacity.work;
  }

  private prepareRoots<T>(
    roots: Record<string, T>,
    path: string,
    capacity: OutputCost,
    candidates: OutputCandidate[],
    fallback?: { node: T; size: OutputSize }
  ): Record<string, T> {
    const bounded: Record<string, T> = Object.create(null);
    const encoded = this.reserveEncoding(roots, path, capacity);
    for (const [index, [name, node]] of Object.entries(roots).entries()) {
      const encodedIndex = encoded ? index : undefined;
      const minimum = fallback
        ? this.rootCost(encoded ? this.pairSize(fallback.size, name) : fallback.size, name, path, encodedIndex)
        : emptyCost;
      if (fallback) {
        this.reserveMinimum(minimum, capacity);
        bounded[name] = fallback.node;
      }
      const cost = this.outputCost(node, name, path, encodedIndex);
      if (cost)
        candidates.push({
          cost,
          minimum,
          admitted: false,
          scalar: fallback === undefined,
          reserveEligible: !Array.isArray(node),
          accept: () => {
            bounded[name] = node;
          },
        });
    }
    return bounded;
  }

  private reserveEncoding(roots: object, path: string, capacity: OutputCost): boolean {
    const encoded = requiresTraceKeyEncoding(roots);
    if (encoded)
      this.reserveMinimum(
        {
          characters: 2 + IDENTITY_ENTRY_CHARACTERS + traceRecordAnnotationCharacters + path.length * 2,
          transportNodes: 2,
          work: path.split('.').length * 2,
        },
        capacity
      );
    return encoded;
  }

  private reserveMinimum(cost: OutputCost, capacity: OutputCost): void {
    if (!this.admit(cost, this.essential)) throw new ExecutionLimitError('trace');
    capacity.characters = Math.max(0, capacity.characters - cost.characters);
    capacity.transportNodes = Math.max(0, capacity.transportNodes - cost.transportNodes);
    capacity.work = Math.max(0, capacity.work - cost.work);
  }

  private outputCost(node: unknown, name: string, path: string, encodedIndex?: number): OutputCost | undefined {
    try {
      const size = this.size(node);
      return this.rootCost(encodedIndex === undefined ? size : this.pairSize(size, name), name, path, encodedIndex);
    } catch (error) {
      if (!(error instanceof DisplayAbort)) throw error;
      return;
    }
  }

  private rootCost(size: OutputSize, name: string, path: string, encodedIndex?: number): OutputCost {
    const prefix = Math.max(
      path.length + this.pathSegmentSize(name),
      encodedIndex === undefined ? 0 : `${path}.${encodedIndex}`.length
    );
    return {
      characters:
        size.characters +
        size.transportPaths +
        size.transportNodes * prefix +
        (encodedIndex === undefined ? this.stringSize(name) + 2 : 1),
      transportNodes: size.transportNodes,
      work: size.transportWork + size.transportNodes * (path.split('.').length + 1),
    };
  }

  private admit(cost: OutputCost, capacity: OutputCost, minimum = emptyCost): boolean {
    const characters = cost.characters - minimum.characters;
    const nodes = cost.transportNodes - minimum.transportNodes;
    const work = cost.work - minimum.work;
    const bulkCharacters = Math.max(0, characters - capacity.characters);
    const bulkNodes = Math.max(0, nodes - capacity.transportNodes);
    const bulkWork = Math.max(0, work - capacity.work);
    if (
      bulkCharacters > this.remaining ||
      bulkNodes > this.transportNodesRemaining ||
      bulkWork > this.transportWorkRemaining
    )
      return false;
    this.remaining -= bulkCharacters;
    this.transportNodesRemaining -= bulkNodes;
    this.transportWorkRemaining -= bulkWork;
    capacity.characters -= characters - bulkCharacters;
    capacity.transportNodes -= nodes - bulkNodes;
    capacity.work -= work - bulkWork;
    return true;
  }

  private size(value: unknown): OutputSize {
    if (typeof value !== 'object' || value === null) return this.scalarSize(value);
    const transported = this.transportValue(value);
    let size = this.sizes.get(transported);
    size ??= this.runtime.withDisplayBudget(DISPLAY_OPERATIONS, () =>
      this.runtime.withRenderBudget('reference', () =>
        mapGraph<object, OutputSize>(
          transported,
          (node) => this.transportValue(node),
          (node) => this.unknownChildren(node),
          (node) => this.rememberSize(node)
        )
      )
    );
    if (this.emittedRoots.has(value)) return { ...size, transportNodes: 1, transportPaths: 0, transportWork: 0 };
    return this.uniqueSize(transported, size);
  }

  private uniqueSize(root: object, size: OutputSize): OutputSize {
    let unique = this.uniqueSizes.get(root);
    if (unique === undefined) {
      let nodes = 1;
      for (const node of walkGraph(
        root,
        (value) => this.transportValue(value),
        (value) => Object.values(value).filter((child): child is object => typeof child === 'object' && child !== null)
      )) {
        if (this.encodedRecords.has(node)) nodes++;
        for (const child of Object.values(node)) {
          nodes += typeof child === 'object' && child !== null ? 1 : this.scalarSize(child).transportNodes;
        }
      }
      unique = {
        ...size,
        transportNodes: nodes,
        transportPaths: nodes * size.maxTransportPath,
        transportWork: nodes * size.maxTransportDepth,
      };
      this.uniqueSizes.set(root, unique);
    }
    return unique;
  }

  private rememberRoots(roots: Record<string, unknown>): void {
    for (const value of Object.values(roots)) {
      if (typeof value === 'object' && value !== null) this.emittedRoots.add(value);
    }
  }

  private unknownChildren(node: object): object[] {
    if (this.sizes.has(node)) return [];
    return Object.values(node)
      .filter((child): child is object => typeof child === 'object' && child !== null)
      .map((child) => this.transportValue(child))
      .filter((child) => !this.sizes.has(child));
  }

  private rememberSize(node: object): OutputSize {
    const size: OutputSize = {
      characters: 2 + IDENTITY_ENTRY_CHARACTERS + (this.encodedRecords.has(node) ? traceRecordAnnotationCharacters : 0),
      transportNodes: this.encodedRecords.has(node) ? 2 : 1,
      transportPaths: 0,
      transportWork: 0,
      maxTransportPath: 0,
      maxTransportDepth: 0,
    };
    const array = Array.isArray(node);
    for (const [key, child] of Object.entries(node)) {
      const weight =
        typeof child === 'object' && child !== null
          ? this.sizes.get(this.transportValue(child))!
          : this.scalarSize(child);
      this.addEntry(size, key, weight, array);
    }
    this.sizes.set(node, size);
    return size;
  }

  private pairSize(value: OutputSize, name: string): OutputSize {
    const size: OutputSize = {
      characters: 2 + IDENTITY_ENTRY_CHARACTERS,
      transportNodes: 1,
      transportPaths: 0,
      transportWork: 0,
      maxTransportPath: 0,
      maxTransportDepth: 0,
    };
    this.addEntry(size, '0', this.scalarSize(name), true);
    this.addEntry(size, '1', value, true);
    return size;
  }

  private addEntry(size: OutputSize, key: string, weight: OutputSize, array: boolean): void {
    size.characters = boundedSize(size.characters + weight.characters + 1 + (array ? 0 : this.stringSize(key) + 1));
    size.transportNodes = boundedSize(size.transportNodes + weight.transportNodes);
    size.transportPaths = boundedSize(
      size.transportPaths + weight.transportPaths + weight.transportNodes * this.pathSegmentSize(key)
    );
    size.transportWork = boundedSize(size.transportWork + weight.transportWork + weight.transportNodes);
    if (weight.transportNodes > 0) {
      size.maxTransportPath = Math.max(size.maxTransportPath, weight.maxTransportPath + this.pathSegmentSize(key));
      size.maxTransportDepth = Math.max(size.maxTransportDepth, weight.maxTransportDepth + 1);
    }
  }

  private scalarSize(value: unknown): OutputSize {
    const key = Object.is(value, -0) ? negativeZero : value;
    let size = this.scalarSizes.get(key);
    if (!size) {
      const encoded = serialize(value);
      const annotation = encoded.meta?.values;
      size = {
        characters:
          (JSON.stringify(encoded.json)?.length ?? 4) + (annotation ? JSON.stringify(annotation).length + 4 : 0),
        transportNodes: annotation ? 1 : 0,
        transportPaths: 0,
        transportWork: 0,
        maxTransportPath: 0,
        maxTransportDepth: 0,
      };
      this.scalarSizes.set(key, size);
    }
    return size;
  }

  private transportValue(node: object): object {
    let value = this.transportValues.get(node);
    if (value === undefined) {
      value = requiresTraceKeyEncoding(node) ? encodeTraceNameRecord(node) : node;
      this.transportValues.set(node, value);
      if (value !== node) this.encodedRecords.add(value);
    }
    return value;
  }

  private pathSegmentSize(key: string): number {
    // A dot becomes a backslash plus dot, then JSON escapes that backslash.
    return this.stringSize(key) * 3 + 1;
  }

  private stringSize(value: string): number {
    let size = this.stringSizes.get(value);
    if (size === undefined) {
      size = JSON.stringify(value).length;
      this.stringSizes.set(value, size);
    }
    return size;
  }
}

function isEssential(candidate: OutputCandidate): boolean {
  return candidate.scalar && isSmall(candidate);
}

function isSmall(candidate: OutputCandidate): boolean {
  return candidate.reserveEligible && outputPriority(candidate.cost) <= 1;
}

function outputPriority(cost: OutputCost): number {
  return Math.max(
    cost.characters / STEP_CAPACITY.characters,
    cost.transportNodes / STEP_CAPACITY.transportNodes,
    cost.work / STEP_CAPACITY.work
  );
}

function boundedSize(size: number): number {
  return Math.min(RECORDING_CHARACTERS + 1, size);
}
