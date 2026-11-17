import type { RPat } from './rast';
import { walkGraph } from './typeGraph';

export function walkPattern(pat: RPat): Generator<RPat> {
  return walkGraph(pat, (node) => node, patternChildren);
}

function patternChildren(pat: RPat): RPat[] {
  if (pat.k === 'as') return [pat.pat];
  return pat.k === 'con' ? pat.args : [];
}
