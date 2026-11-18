import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { TraceVariables } from '../interpreter/traceRecorder';
import type { TraceItem } from '../problems/trace';
import { TRUNCATED_DISPLAY } from './displayOutput';
import { DISPLAY_OPERATIONS, DisplayAbort } from './previewBudget';
import type { Runtime } from './runtime';
import { mapGraph } from './typeGraph';

const RECORDING_CHARACTERS = LIMITS.maxSlots * 32;
const STEP_CHARACTERS = 256;
const truncated = { node: TRUNCATED_DISPLAY, size: JSON.stringify(TRUNCATED_DISPLAY).length };

export class RecordingOutput {
  private remaining = RECORDING_CHARACTERS;
  private stateRemaining = LIMITS.maxSlots * 8;
  private readonly sizes = new WeakMap<object, number>();
  private readonly stringSizes = new Map<string, number>();
  private readonly bigintSizes = new Map<bigint, number>();

  constructor(private readonly runtime: Runtime) {}

  record(item: TraceItem): TraceItem {
    const { vars, referenceVars, ...state } = item;
    this.stateRemaining -= this.runtime.budget.excludingTime(() => JSON.stringify(state).length);
    if (this.stateRemaining < 0) throw new ExecutionLimitError('trace');
    return { ...state, ...this.bound({ vars, referenceVars }) };
  }

  bound(variables: TraceVariables): TraceVariables {
    return this.runtime.withDisplayBudget(DISPLAY_OPERATIONS, () => ({
      vars: this.boundRoots(variables.vars),
      referenceVars: this.boundRoots(variables.referenceVars, truncated),
    }));
  }

  private boundRoots<T>(roots: Record<string, T>, fallback?: { node: T; size: number }): Record<string, T> {
    const bounded: Record<string, T> = Object.create(null);
    let smallRemaining = STEP_CHARACTERS;
    for (const [name, node] of Object.entries(roots)) {
      const keySize = this.stringSize(name) + 2;
      let size: number | undefined;
      try {
        size = this.size(node) + keySize;
      } catch (error) {
        if (!(error instanceof DisplayAbort)) throw error;
      }
      if (size !== undefined && size <= smallRemaining) {
        bounded[name] = node;
        smallRemaining -= size;
      } else if (size !== undefined && size <= this.remaining) {
        bounded[name] = node;
        this.remaining -= size;
      } else if (fallback !== undefined) {
        const cost = fallback.size + keySize;
        if (cost <= this.remaining) {
          bounded[name] = fallback.node;
          this.remaining -= cost;
        }
      }
    }
    return bounded;
  }

  private size(value: unknown): number {
    if (typeof value !== 'object' || value === null) return this.scalarSize(value);
    const cached = this.sizes.get(value);
    if (cached !== undefined) return cached;
    return this.runtime.withDisplayBudget(DISPLAY_OPERATIONS, () =>
      this.runtime.withRenderBudget('reference', () =>
        mapGraph<object, number>(
          value,
          (node) => node,
          (node) => this.unknownChildren(node),
          (node) => this.rememberSize(node)
        )
      )
    );
  }

  private scalarSize(value: unknown): number {
    if (typeof value === 'string') return this.stringSize(value);
    if (typeof value === 'bigint') {
      let size = this.bigintSizes.get(value);
      if (size === undefined) {
        size = value.toString().length + 64;
        this.bigintSizes.set(value, size);
      }
      return size;
    }
    return JSON.stringify(value)?.length ?? 4;
  }

  private stringSize(value: string): number {
    let size = this.stringSizes.get(value);
    if (size === undefined) {
      size = JSON.stringify(value).length;
      this.stringSizes.set(value, size);
    }
    return size;
  }

  private unknownChildren(node: object): object[] {
    if (this.sizes.has(node)) return [];
    return Object.values(node).filter(
      (child): child is object => typeof child === 'object' && child !== null && !this.sizes.has(child)
    );
  }

  private rememberSize(node: object): number {
    let size = 2;
    const array = Array.isArray(node);
    for (const [key, child] of Object.entries(node)) {
      const weight = typeof child === 'object' && child !== null ? this.sizes.get(child)! : this.scalarSize(child);
      size = Math.min(RECORDING_CHARACTERS + 1, size + weight + 1 + (array ? 0 : this.stringSize(key) + 1));
    }
    this.sizes.set(node, size);
    return size;
  }
}
