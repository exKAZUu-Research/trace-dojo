import type { TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceArray, TraceScalar } from '../problems/trace';
import { DISPLAY_OPERATIONS, DisplayAbort } from './previewBudget';
import { MAX_DISPLAY_NODES, type Runtime } from './runtime';
import { mapGraph } from './typeGraph';

type OutputNode = DisplayNode | TraceScalar | TraceArray;
type OutputBranch = Extract<DisplayNode, { kind: 'object' | 'array' }> | TraceArray;
const expandedSizes = new WeakMap<OutputBranch, number>();
export const TRUNCATED_DISPLAY: DisplayNode = { kind: 'value', value: '…' };

export function boundDisplayOutput(runtime: Runtime, variables: TraceVariables): TraceVariables {
  return {
    vars: boundRoots(runtime, variables.vars, 'answer'),
    referenceVars: boundRoots(runtime, variables.referenceVars, 'reference', TRUNCATED_DISPLAY),
  };
}

function boundRoots<T extends OutputNode>(
  runtime: Runtime,
  roots: Record<string, T>,
  kind: 'answer' | 'reference',
  fallback?: T
): Record<string, T> {
  const bounded: Record<string, T> = Object.create(null);
  let remaining = MAX_DISPLAY_NODES;
  for (const [name, node] of Object.entries(roots)) {
    if (remaining === 0) break;
    let size: number | undefined;
    try {
      size = expandedSize(runtime, node, kind);
    } catch (error) {
      if (!(error instanceof DisplayAbort)) throw error;
    }
    if (size !== undefined && size <= remaining) {
      bounded[name] = node;
      remaining -= size;
    } else if (fallback !== undefined) {
      bounded[name] = fallback;
      remaining--;
    }
  }
  return bounded;
}

function expandedSize(runtime: Runtime, root: OutputNode, kind: 'answer' | 'reference'): number {
  if (!isBranch(root)) return 1;
  const cached = expandedSizes.get(root);
  if (cached !== undefined) return cached;
  return runtime.withDisplayBudget(DISPLAY_OPERATIONS, () =>
    runtime.withRenderBudget(kind, () =>
      mapGraph<OutputBranch, number>(root, (node) => node, unknownChildren, rememberExpandedSize)
    )
  );
}

function isBranch(node: OutputNode): node is OutputBranch {
  return Array.isArray(node) || (typeof node === 'object' && node !== null && node.kind !== 'value');
}

function children(node: OutputBranch): OutputNode[] {
  return Array.isArray(node) ? node : Object.values(node.entries);
}

function unknownChildren(node: OutputBranch): OutputBranch[] {
  if (expandedSizes.has(node)) return [];
  return children(node).filter((child): child is OutputBranch => isBranch(child) && !expandedSizes.has(child));
}

function rememberExpandedSize(node: OutputBranch): number {
  let size = 1;
  for (const child of children(node)) {
    const weight = isBranch(child) ? expandedSizes.get(child)! : 1;
    size = Math.min(MAX_DISPLAY_NODES + 1, size + weight);
  }
  expandedSizes.set(node, size);
  return size;
}
