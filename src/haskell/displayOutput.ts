import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceArray, TraceScalar } from '../problems/trace';
import { DISPLAY_OPERATIONS, DisplayAbort } from './previewBudget';
import { MAX_DISPLAY_NODES, type Runtime } from './runtime';
import { mapGraph } from './typeGraph';

type OutputNode = DisplayNode | TraceScalar | TraceArray;
type OutputLeaf = TraceScalar | Extract<DisplayNode, { kind: 'value' }>;
type OutputBranch = Extract<DisplayNode, { kind: 'object' | 'array' }> | TraceArray;
interface OutputContext {
  runtime: Runtime;
  scalarSizes: Map<TraceScalar, number>;
}

interface ExpandedSize {
  nodes: number;
  characters: number;
}
const MAX_DISPLAY_CHARACTERS = LIMITS.maxSlots * 32;
const expandedSizes = new WeakMap<object, ExpandedSize>();
export const TRUNCATED_DISPLAY: DisplayNode = { kind: 'value', value: '…' };

export function boundDisplayOutput(runtime: Runtime, variables: TraceVariables): TraceVariables {
  const context: OutputContext = { runtime, scalarSizes: new Map() };
  return {
    vars: boundRoots(context, variables.vars, 'answer'),
    referenceVars: boundRoots(context, variables.referenceVars, 'reference', TRUNCATED_DISPLAY),
  };
}

function boundRoots<T extends OutputNode>(
  context: OutputContext,
  roots: Record<string, T>,
  kind: 'answer' | 'reference',
  fallback?: T
): Record<string, T> {
  const bounded: Record<string, T> = Object.create(null);
  const entries = Object.entries(roots);
  const reserved = fallback === undefined ? { nodes: 0, characters: 0 } : expandedSize(context, fallback, kind);
  let nodes = MAX_DISPLAY_NODES - entries.length * reserved.nodes;
  let characters = MAX_DISPLAY_CHARACTERS;
  for (const [name] of entries) characters -= reserved.characters + JSON.stringify(name).length + 2;
  if (nodes < 0 || characters < 0) throw new ExecutionLimitError('trace');
  const selected = new Set<string>();
  for (const { name, size } of measureRoots(context, entries, kind).toSorted(
    (left, right) => priority(left.size) - priority(right.size)
  )) {
    const nodeCost = size.nodes - reserved.nodes;
    const characterCost = size.characters - reserved.characters;
    if (nodeCost <= nodes && characterCost <= characters) {
      selected.add(name);
      nodes -= nodeCost;
      characters -= characterCost;
    }
  }
  for (const [name, node] of entries) {
    if (selected.has(name)) bounded[name] = node;
    else if (fallback !== undefined) bounded[name] = fallback;
  }
  return bounded;
}

function measureRoots<T extends OutputNode>(
  context: OutputContext,
  entries: [string, T][],
  kind: 'answer' | 'reference'
): { name: string; size: ExpandedSize }[] {
  const measured = [];
  for (const [name, node] of entries) {
    try {
      measured.push({ name, size: expandedSize(context, node, kind) });
    } catch (error) {
      if (!(error instanceof DisplayAbort)) throw error;
    }
  }
  return measured;
}

function expandedSize(context: OutputContext, root: OutputNode, kind: 'answer' | 'reference'): ExpandedSize {
  if (!isBranch(root)) return leafSize(root, context.scalarSizes);
  const cached = expandedSizes.get(root);
  if (cached !== undefined) return cached;
  return context.runtime.withDisplayBudget(DISPLAY_OPERATIONS, () =>
    context.runtime.withRenderBudget(kind, () =>
      mapGraph<OutputBranch, ExpandedSize>(
        root,
        (node) => node,
        unknownChildren,
        (node) => rememberExpandedSize(node, context.scalarSizes)
      )
    )
  );
}

function leafSize(node: OutputLeaf, scalarSizes: Map<TraceScalar, number>): ExpandedSize {
  const value = typeof node === 'object' && node !== null ? node.value : node;
  let characters = scalarSizes.get(value);
  if (characters === undefined) {
    characters = typeof value === 'bigint' ? String(value).length : (JSON.stringify(value)?.length ?? 4);
    scalarSizes.set(value, characters);
  }
  return { nodes: 1, characters: characters + 40 };
}

function isBranch(node: OutputNode): node is OutputBranch {
  return Array.isArray(node) || (typeof node === 'object' && node !== null && node.kind !== 'value');
}

function children(node: OutputBranch): [string, OutputNode][] {
  return Array.isArray(node) ? Object.entries(node) : Object.entries(node.entries);
}

function unknownChildren(node: OutputBranch): OutputBranch[] {
  if (expandedSizes.has(node)) return [];
  return children(node)
    .map(([, child]) => child)
    .filter((child): child is OutputBranch => isBranch(child) && !expandedSizes.has(child));
}

function rememberExpandedSize(node: OutputBranch, scalarSizes: Map<TraceScalar, number>): ExpandedSize {
  const size = { nodes: 1, characters: 40 };
  for (const [key, child] of children(node)) {
    const weight = isBranch(child) ? expandedSizes.get(child)! : leafSize(child, scalarSizes);
    size.nodes = Math.min(MAX_DISPLAY_NODES + 1, size.nodes + weight.nodes);
    size.characters = Math.min(
      MAX_DISPLAY_CHARACTERS + 1,
      size.characters + weight.characters + JSON.stringify(key).length + 2
    );
  }
  expandedSizes.set(node, size);
  return size;
}

function priority(size: ExpandedSize): number {
  return Math.max(size.nodes / MAX_DISPLAY_NODES, size.characters / MAX_DISPLAY_CHARACTERS);
}
