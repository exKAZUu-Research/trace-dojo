import type { DisplayNode } from '../problems/trace';
import { DISPLAY_OPERATIONS, DisplayAbort } from './previewBudget';
import { MAX_DISPLAY_NODES, type Runtime } from './runtime';
import { mapGraph } from './typeGraph';

const expandedSizes = new WeakMap<DisplayNode, number>();
const truncated: DisplayNode = { kind: 'value', value: '…' };

export function boundDisplayOutput(
  runtime: Runtime,
  references: Record<string, DisplayNode>
): Record<string, DisplayNode> {
  const bounded: Record<string, DisplayNode> = Object.create(null);
  let remaining = MAX_DISPLAY_NODES;
  for (const [name, node] of Object.entries(references)) {
    if (remaining === 0) break;
    let size: number | undefined;
    try {
      size = expandedSize(runtime, node);
    } catch (error) {
      if (!(error instanceof DisplayAbort)) throw error;
    }
    const fits = size !== undefined && size <= remaining;
    bounded[name] = fits ? node : truncated;
    remaining -= fits ? size! : 1;
  }
  return bounded;
}

function expandedSize(runtime: Runtime, root: DisplayNode): number {
  if (root.kind === 'value') return 1;
  const cached = expandedSizes.get(root);
  if (cached !== undefined) return cached;
  return runtime.withDisplayBudget(DISPLAY_OPERATIONS, () =>
    runtime.withRenderBudget('reference', () =>
      mapGraph<DisplayNode, number>(root, (node) => node, unknownChildren, rememberExpandedSize)
    )
  );
}

function unknownChildren(node: DisplayNode): DisplayNode[] {
  if (node.kind === 'value' || expandedSizes.has(node)) return [];
  return Object.values(node.entries).filter((child) => child.kind !== 'value' && !expandedSizes.has(child));
}

function rememberExpandedSize(node: DisplayNode): number {
  let size = 1;
  if (node.kind !== 'value') {
    for (const child of Object.values(node.entries)) {
      const weight = child.kind === 'value' ? 1 : expandedSizes.get(child)!;
      size = Math.min(MAX_DISPLAY_NODES + 1, size + weight);
    }
  }
  expandedSizes.set(node, size);
  return size;
}
