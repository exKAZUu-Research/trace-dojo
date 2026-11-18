import { serialize } from 'superjson';

import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { TraceVariables } from '../interpreter/traceRecorder';
import type { TraceItem } from '../problems/trace';
import { TRUNCATED_DISPLAY } from './displayOutput';
import { DISPLAY_OPERATIONS, DisplayAbort } from './previewBudget';
import { MAX_DISPLAY_NODES, type Runtime } from './runtime';
import { mapGraph } from './typeGraph';

interface OutputSize {
  characters: number;
  transportNodes: number;
  transportPaths: number;
  transportWork: number;
}

interface OutputCost {
  characters: number;
  transportNodes: number;
  work: number;
}

const RECORDING_CHARACTERS = LIMITS.maxSlots * 32;
const STEP_CHARACTERS = 256;
const IDENTITY_ENTRY_CHARACTERS = 8;
const truncated = {
  node: TRUNCATED_DISPLAY,
  size: {
    characters: JSON.stringify(TRUNCATED_DISPLAY).length + IDENTITY_ENTRY_CHARACTERS,
    transportNodes: 1,
    transportPaths: 0,
    transportWork: 0,
  },
};
const negativeZero = Symbol();

export class RecordingOutput {
  private remaining = RECORDING_CHARACTERS;
  private stateRemaining = LIMITS.maxSlots * 8;
  private transportNodesRemaining = MAX_DISPLAY_NODES;
  private transportWorkRemaining = LIMITS.maxSlots;
  private recordedItems = 1;
  private readonly sizes = new WeakMap<object, OutputSize>();
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
    return this.runtime.withDisplayBudget(DISPLAY_OPERATIONS, () => ({
      vars: this.boundRoots(variables.vars, path ? `${path}.vars` : 'finalVars'),
      referenceVars: this.boundRoots(
        variables.referenceVars,
        path ? `${path}.referenceVars` : 'referenceVars',
        truncated
      ),
    }));
  }

  private boundRoots<T>(
    roots: Record<string, T>,
    path: string,
    fallback?: { node: T; size: OutputSize }
  ): Record<string, T> {
    const bounded: Record<string, T> = Object.create(null);
    let smallRemaining = STEP_CHARACTERS;
    for (const [name, node] of Object.entries(roots)) {
      const cost = this.outputCost(node, name, path);
      if (cost && cost.characters <= smallRemaining) {
        bounded[name] = node;
        smallRemaining -= cost.characters;
      } else if (cost && this.admit(cost)) {
        bounded[name] = node;
      } else if (fallback && this.admit(this.rootCost(fallback.size, name, path))) {
        bounded[name] = fallback.node;
      }
    }
    return bounded;
  }

  private outputCost(node: unknown, name: string, path: string): OutputCost | undefined {
    try {
      const size = this.size(node);
      return this.rootCost(size, name, path);
    } catch (error) {
      if (!(error instanceof DisplayAbort)) throw error;
      return;
    }
  }

  private rootCost(size: OutputSize, name: string, path: string): OutputCost {
    return {
      characters:
        size.characters +
        size.transportPaths +
        size.transportNodes * (path.length + this.pathSegmentSize(name)) +
        this.stringSize(name) +
        2,
      transportNodes: size.transportNodes,
      work: size.transportWork + size.transportNodes * (path.split('.').length + 1),
    };
  }

  private admit(cost: OutputCost): boolean {
    if (
      cost.characters > this.remaining ||
      cost.transportNodes > this.transportNodesRemaining ||
      cost.work > this.transportWorkRemaining
    )
      return false;
    this.remaining -= cost.characters;
    this.transportNodesRemaining -= cost.transportNodes;
    this.transportWorkRemaining -= cost.work;
    return true;
  }

  private size(value: unknown): OutputSize {
    if (typeof value !== 'object' || value === null) return this.scalarSize(value);
    const cached = this.sizes.get(value);
    if (cached !== undefined) return cached;
    return this.runtime.withDisplayBudget(DISPLAY_OPERATIONS, () =>
      this.runtime.withRenderBudget('reference', () =>
        mapGraph<object, OutputSize>(
          value,
          (node) => node,
          (node) => this.unknownChildren(node),
          (node) => this.rememberSize(node)
        )
      )
    );
  }

  private unknownChildren(node: object): object[] {
    if (this.sizes.has(node)) return [];
    return Object.values(node).filter(
      (child): child is object => typeof child === 'object' && child !== null && !this.sizes.has(child)
    );
  }

  private rememberSize(node: object): OutputSize {
    const size: OutputSize = {
      characters: 2 + IDENTITY_ENTRY_CHARACTERS,
      transportNodes: 1,
      transportPaths: 0,
      transportWork: 0,
    };
    const array = Array.isArray(node);
    for (const [key, child] of Object.entries(node)) {
      const weight = typeof child === 'object' && child !== null ? this.sizes.get(child)! : this.scalarSize(child);
      size.characters = boundedSize(size.characters + weight.characters + 1 + (array ? 0 : this.stringSize(key) + 1));
      size.transportNodes = boundedSize(size.transportNodes + weight.transportNodes);
      size.transportPaths = boundedSize(
        size.transportPaths + weight.transportPaths + weight.transportNodes * this.pathSegmentSize(key)
      );
      size.transportWork = boundedSize(size.transportWork + weight.transportWork + weight.transportNodes);
    }
    this.sizes.set(node, size);
    return size;
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
      };
      this.scalarSizes.set(key, size);
    }
    return size;
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

function boundedSize(size: number): number {
  return Math.min(RECORDING_CHARACTERS + 1, size);
}
